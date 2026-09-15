#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  DEFAULT_FENCE_PATH,
  DEFAULT_ACTIVATION_RECEIPT_PATH,
  DEFAULT_LEASE_PATH,
  DEFAULT_MORNING_RECEIPT_DIR,
  createCapability,
  currentBranch,
  currentHead,
  evaluateGoalGuard,
  evaluateDirtyGuard,
  loadPhaseLedger,
  readLease,
  selectActivePhase,
  validateHeartbeatActivationReceipt,
} = require("../lib/pikiio-agent-governance");
const {
  collectHostDurabilityReceipt,
  validateHostDurabilityReceipt,
} = require("../lib/pikiio-host-durability");

const ROOT = path.resolve(__dirname, "..");
const HOLDER_PATH = path.join(__dirname, "pikiio-agent-lease-holder.js");
const RUNTIME_DIR = path.dirname(DEFAULT_LEASE_PATH);
const OWNER_LOCK_PATH = path.join(RUNTIME_DIR, "writer-owner.lock");
const CONTROL_SOCKET_PATH = path.join(
  os.tmpdir(),
  `pikiio-writer-${crypto
    .createHash("sha256")
    .update(RUNTIME_DIR)
    .digest("hex")
    .slice(0, 16)}.sock`,
);
const CONTROL_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 10000;

function valueArg(name, argv = process.argv) {
  const prefix = `--${name}=`;
  const arg = argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function numericArg(name, fallback, argv = process.argv) {
  const value = valueArg(name, argv);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be numeric`);
  return parsed;
}

function redactLease(lease) {
  if (!lease) return null;
  const copy = JSON.parse(JSON.stringify(lease));
  delete copy.capabilitySha256;
  return copy;
}

function loadHandle(handlePath) {
  if (!handlePath) {
    const error = new Error("A writer handle path is required");
    error.code = "WRITER_HANDLE_REQUIRED";
    throw error;
  }
  const stat = fs.statSync(handlePath);
  if ((stat.mode & 0o077) !== 0) {
    const error = new Error("Writer handle permissions are not private");
    error.code = "WRITER_HANDLE_PERMISSIONS_INVALID";
    throw error;
  }
  const handle = JSON.parse(fs.readFileSync(handlePath, "utf8"));
  if (
    handle.schema !== "pikiio-writer-handle-v1" ||
    !handle.runId ||
    !Number.isSafeInteger(handle.fence) ||
    !/^[a-f0-9]{64}$/.test(String(handle.capability || "")) ||
    !handle.controlSocketPath ||
    !handle.leasePath
  ) {
    const error = new Error("Writer handle is invalid");
    error.code = "WRITER_HANDLE_INVALID";
    throw error;
  }
  return handle;
}

function hostGateRequired(phaseId) {
  return phaseId !== "GOV-00";
}

function freshHostDurability({
  collectHostDurability = collectHostDurabilityReceipt,
  validateHostDurability = validateHostDurabilityReceipt,
  nowMs = null,
  now = Date.now,
  localHost = os.hostname(),
} = {}) {
  const receipt = collectHostDurability();
  const validationNowMs =
    Number.isFinite(nowMs) ? nowMs : Number(now());
  const validation = validateHostDurability(receipt, {
    nowMs: validationNowMs,
    localHost,
  });
  const sleepPolicyReadable =
    receipt &&
    typeof receipt === "object" &&
    receipt.sleep &&
    typeof receipt.sleep === "object" &&
    Number.isSafeInteger(receipt.sleep.acSleepMinutes) &&
    receipt.sleep.acSleepMinutes >= 0;
  if (!validation.valid || !sleepPolicyReadable) {
    const error = new Error(
      "A fresh live host-durability receipt is required before write authority",
    );
    error.code = "HEARTBEAT_HOST_DURABILITY_INVALID";
    error.details = {
      errors: [
        ...(Array.isArray(validation.errors) ? validation.errors : []),
        ...(!sleepPolicyReadable
          ? ["host durability AC sleep policy is unreadable"]
          : []),
      ],
      blockers: [
        ...new Set([
          ...(Array.isArray(receipt?.blockers) ? receipt.blockers : []),
          ...(!sleepPolicyReadable ? ["HOST_SLEEP_POLICY_UNREADABLE"] : []),
        ]),
      ],
    };
    throw error;
  }
  return receipt;
}

function persistedHandleLease(handle, readLeaseImpl = readLease) {
  const current = readLeaseImpl(handle.leasePath);
  const capabilitySha256 = crypto
    .createHash("sha256")
    .update(handle.capability)
    .digest("hex");
  if (
    !current ||
    current.runId !== handle.runId ||
    current.fence !== handle.fence ||
    current.capabilitySha256 !== capabilitySha256 ||
    typeof current.phaseId !== "string" ||
    current.phaseId.length === 0
  ) {
    const error = new Error("Writer handle does not match the live lease");
    error.code = "WRITER_LEASE_LOST";
    throw error;
  }
  return current;
}

function sendRequestOverSocket(handle, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(handle.controlSocketPath);
    let source = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      const error = new Error("Writer control request timed out");
      error.code = "WRITER_CONTROL_TIMEOUT";
      reject(error);
    }, CONTROL_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      source += chunk;
      const newline = source.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(source.slice(0, newline));
        if (!response.ok) {
          const error = new Error(response.error || "Writer control failed");
          error.code = response.code || "WRITER_CONTROL_FAILED";
          reject(error);
          return;
        }
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function sendControlRequest(
  handlePath,
  operation,
  extra = {},
  {
    readLeaseImpl = readLease,
    collectHostDurability = collectHostDurabilityReceipt,
    validateHostDurability = validateHostDurabilityReceipt,
    nowMs = null,
    now = Date.now,
    localHost = os.hostname(),
    requestTransport = sendRequestOverSocket,
  } = {},
) {
  const handle = loadHandle(handlePath);
  if (operation === "assert" || operation === "renew") {
    const lease = persistedHandleLease(handle, readLeaseImpl);
    if (hostGateRequired(lease.phaseId)) {
      freshHostDurability({
        collectHostDurability,
        validateHostDurability,
        nowMs,
        now,
        localHost,
      });
    }
  }
  const request = {
    schema: "pikiio-writer-control-v1",
    requestId: crypto.randomUUID(),
    operation,
    runId: handle.runId,
    fence: handle.fence,
    capability: handle.capability,
    ...extra,
  };
  return requestTransport(handle, request);
}

function startLeaseHolder(bootstrapPath) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const lockCommand =
    process.platform === "darwin"
      ? {
          command: "/usr/bin/lockf",
          args: [
            "-k",
            "-s",
            "-t",
            "0",
            OWNER_LOCK_PATH,
            process.execPath,
            HOLDER_PATH,
            `--bootstrap=${bootstrapPath}`,
          ],
        }
      : fs.existsSync("/usr/bin/flock")
        ? {
            command: "/usr/bin/flock",
            args: [
              "--exclusive",
              "--nonblock",
              OWNER_LOCK_PATH,
              process.execPath,
              HOLDER_PATH,
              `--bootstrap=${bootstrapPath}`,
            ],
          }
        : null;
  if (!lockCommand) {
    const error = new Error("No supported OS advisory-lock command is available");
    error.code = "WRITER_OS_LOCK_UNAVAILABLE";
    throw error;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(lockCommand.command, lockCommand.args, {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanupBootstrap = () => {
      try {
        fs.unlinkSync(bootstrapPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) cleanupBootstrap();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      else resolve(response);
    };
    const inspectLine = () => {
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(stdout.slice(0, newline));
        if (!response.ok) {
          const error = new Error(response.error || "Lease holder failed");
          error.code = response.code || "WRITER_LEASE_HOLDER_FAILED";
          finish(error);
          return;
        }
        finish(null, response);
      } catch (error) {
        finish(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      inspectLine();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      const error = new Error(
        code === 75
          ? "Another Pikiio writer owns the OS advisory lock"
          : `Lease holder exited before startup (code ${code}): ${stderr.trim()}`,
      );
      error.code =
        code === 75 ? "WRITER_LEASE_BUSY" : "WRITER_LEASE_HOLDER_FAILED";
      finish(error);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error("Lease holder startup timed out");
      error.code = "WRITER_LEASE_STARTUP_TIMEOUT";
      finish(error);
    }, STARTUP_TIMEOUT_MS);
  });
}

async function acquireCommand({
  collectHostDurability = collectHostDurabilityReceipt,
  validateHostDurability = validateHostDurabilityReceipt,
  nowMs = null,
  now = Date.now,
  localHost = os.hostname(),
  argv = process.argv,
  loadPhaseLedgerImpl = loadPhaseLedger,
  selectActivePhaseImpl = selectActivePhase,
  evaluateGoalGuardImpl = evaluateGoalGuard,
  validateHeartbeatActivationReceiptImpl =
    validateHeartbeatActivationReceipt,
  evaluateDirtyGuardImpl = evaluateDirtyGuard,
  currentHeadImpl = currentHead,
  currentBranchImpl = currentBranch,
  readActivationReceipt = () =>
    JSON.parse(fs.readFileSync(DEFAULT_ACTIVATION_RECEIPT_PATH, "utf8")),
  runtimeDir = RUNTIME_DIR,
  fsImpl = fs,
  startLeaseHolderImpl = startLeaseHolder,
} = {}) {
  const leaseClass = valueArg("lease-class", argv) || "builder";
  if (!["builder", "morning"].includes(leaseClass)) {
    throw new Error("--lease-class must be builder or morning");
  }
  const ledger = loadPhaseLedgerImpl();
  const activePhase = selectActivePhaseImpl(ledger);
  let phaseId = activePhase.id;
  let lane = activePhase.lane;
  let requestedLeaseMs = numericArg(
    "lease-ms",
    15 * 60 * 1000,
    argv,
  );
  let supervisedPid = null;
  if (leaseClass === "builder") {
    if (valueArg("phase", argv) || valueArg("lane", argv)) {
      const error = new Error("Builder phase and lane are selected only by the ledger");
      error.code = "WRITER_SCOPE_OVERRIDE_REFUSED";
      throw error;
    }
    const goal = evaluateGoalGuardImpl({
      ledger,
      repoRoot: ROOT,
      goalObjective:
        valueArg("goal-objective", argv) ||
        process.env.PIKIIO_CODEX_GOAL_OBJECTIVE ||
        "",
      goalThreadId:
        valueArg("goal-thread-id", argv) ||
        process.env.PIKIIO_CODEX_GOAL_THREAD_ID ||
        "",
    });
    if (!goal.ok) {
      const error = new Error(goal.error);
      error.code = goal.code;
      error.details = goal.details;
      throw error;
    }
    if (activePhase.id !== "GOV-00") {
      let activationReceipt;
      try {
        activationReceipt = readActivationReceipt();
      } catch {
        const error = new Error(
          "A valid heartbeat activation receipt is required before write authority",
        );
        error.code = "HEARTBEAT_ACTIVATION_RECEIPT_REQUIRED";
        throw error;
      }
      const activation = validateHeartbeatActivationReceiptImpl(activationReceipt, {
        ledger,
        phase: activePhase,
        head: currentHeadImpl(ROOT),
        repoRoot: ROOT,
      });
      if (!activation.valid) {
        const error = new Error(
          "Heartbeat activation evidence is stale, mismatched, or invalid",
        );
        error.code = "HEARTBEAT_ACTIVATION_INVALID";
        error.details = { errors: activation.errors };
        throw error;
      }
      const dirty = evaluateDirtyGuardImpl({
        ledger,
        phase: activePhase,
        repoRoot: ROOT,
      });
      if (
        !dirty.ok ||
        dirty.working.allowed.length !== 0 ||
        dirty.working.blocked.length !== 0
      ) {
        const error = new Error(
          "A heartbeat may acquire write authority only from a clean checkpoint",
        );
        error.code = "HEARTBEAT_CHECKPOINT_NOT_CLEAN";
        error.details = { dirty };
        throw error;
      }
    }
  } else {
    phaseId = "MORNING-REFRESH";
    lane = "morning-refresh";
    requestedLeaseMs = numericArg(
      "lease-ms",
      3 * 60 * 60 * 1000,
      argv,
    );
    supervisedPid = Number(valueArg("supervised-pid", argv));
    if (!Number.isSafeInteger(supervisedPid) || supervisedPid < 1) {
      const error = new Error("Morning leases require --supervised-pid");
      error.code = "MORNING_SUPERVISED_PID_REQUIRED";
      throw error;
    }
  }

  if (hostGateRequired(phaseId)) {
    freshHostDurability({
      collectHostDurability,
      validateHostDurability,
      nowMs,
      now,
      localHost,
    });
  }

  fsImpl.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const capability = createCapability();
  const nonce = crypto.randomUUID();
  const handlePath = path.join(runtimeDir, `writer-handle-${nonce}.json`);
  const bootstrapPath = path.join(
    runtimeDir,
    `writer-bootstrap-${nonce}.json`,
  );
  const bootstrap = {
    schema: "pikiio-writer-bootstrap-v1",
    capability,
    handlePath,
    socketPath: CONTROL_SOCKET_PATH,
    leasePath: DEFAULT_LEASE_PATH,
    fencePath: DEFAULT_FENCE_PATH,
    config: {
      runId: valueArg("run-id", argv) || crypto.randomUUID(),
      automationId:
        valueArg("automation-id", argv) ||
        (leaseClass === "morning"
          ? "pq-morning-shipment-refresh"
          : "interactive-codex"),
      goalId: ledger.codexGoal.objectiveSha256,
      phaseId,
      lane,
      branch: currentBranchImpl(ROOT),
      startHead: currentHeadImpl(ROOT),
      allowedPaths: leaseClass === "builder" ? activePhase.allowedPaths : [],
      leaseMs: requestedLeaseMs,
      supervisedPid,
      morningReceiptDir: DEFAULT_MORNING_RECEIPT_DIR,
      host: localHost,
    },
  };
  fsImpl.writeFileSync(bootstrapPath, `${JSON.stringify(bootstrap)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return startLeaseHolderImpl(bootstrapPath);
}

async function main() {
  const command = process.argv[2] || "status";
  try {
    let result;
    if (command === "status") {
      result = { ok: true, lease: redactLease(readLease()) };
    } else if (command === "acquire") {
      result = await acquireCommand();
    } else {
      const handlePath =
        valueArg("handle") || process.env.PIKIIO_WRITER_HANDLE || "";
      if (command === "assert") {
        result = await sendControlRequest(handlePath, "assert");
      } else if (command === "renew") {
        result = await sendControlRequest(handlePath, "renew", {
          requestedLeaseMs: numericArg("lease-ms", 15 * 60 * 1000),
        });
      } else if (command === "release") {
        result = await sendControlRequest(handlePath, "release");
      } else if (command === "morning-terminal") {
        const source = fs.readFileSync(0, "utf8").trim();
        if (!source) throw new Error("Morning terminal JSON is required on stdin");
        result = await sendControlRequest(handlePath, "morning-terminal", {
          terminal: JSON.parse(source),
        });
      } else {
        throw new Error(`Unknown lease command: ${command}`);
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      code: error.code || "WRITER_LEASE_COMMAND_FAILED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  acquireCommand,
  freshHostDurability,
  hostGateRequired,
  loadHandle,
  persistedHandleLease,
  redactLease,
  sendControlRequest,
  sendRequestOverSocket,
  startLeaseHolder,
};
