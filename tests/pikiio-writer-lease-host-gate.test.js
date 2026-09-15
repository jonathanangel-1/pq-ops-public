"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  HOST_SERVICE_ARGUMENTS,
  HOST_SERVICE_LABEL,
  HOST_SERVICE_PLIST_BYTE_LENGTH,
  HOST_SERVICE_PLIST_SHA256,
  MAXIMUM_HOST_SERVICE_PLIST_BYTES,
  MAXIMUM_RECEIPT_AGE_MS,
  buildHostDurabilityReceipt,
  validateHostDurabilityReceipt,
} = require("../lib/pikiio-host-durability");
const {
  acquireCommand,
  freshHostDurability,
  hostGateRequired,
  loadHandle,
  persistedHandleLease,
  redactLease,
  sendControlRequest,
  sendRequestOverSocket,
} = require("../scripts/pikiio-agent-writer-lease");

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const HOSTNAME = "pikiio-test-host";
const WRITER_MODULE_PATH = require.resolve(
  "../scripts/pikiio-agent-writer-lease",
);
const GOVERNANCE_MODULE_PATH = require.resolve(
  "../lib/pikiio-agent-governance",
);
const CAPABILITY = "a".repeat(64);
const CAPABILITY_SHA256 = crypto
  .createHash("sha256")
  .update(CAPABILITY)
  .digest("hex");

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for isolated writer state"));
        return;
      }
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

function isolatedWriterHome(t) {
  const home = temporaryDirectory(t, "pikiio-writer-isolated-home-");
  const priorHome = process.env.HOME;
  const priorGovernance = require.cache[GOVERNANCE_MODULE_PATH];
  const priorWriter = require.cache[WRITER_MODULE_PATH];
  process.env.HOME = home;
  delete require.cache[GOVERNANCE_MODULE_PATH];
  delete require.cache[WRITER_MODULE_PATH];
  const isolated = require(WRITER_MODULE_PATH);
  t.after(() => {
    delete require.cache[GOVERNANCE_MODULE_PATH];
    delete require.cache[WRITER_MODULE_PATH];
    if (priorGovernance) {
      require.cache[GOVERNANCE_MODULE_PATH] = priorGovernance;
    }
    if (priorWriter) {
      require.cache[WRITER_MODULE_PATH] = priorWriter;
    }
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  return { home, isolated };
}

function loadWriterMutant(find, replacement) {
  let source = fs.readFileSync(WRITER_MODULE_PATH, "utf8");
  const occurrences = source.split(find).length - 1;
  assert.equal(occurrences, 1, `writer mutation target must be unique: ${find}`);
  source = source.replace(find, replacement);
  const sourceHash = crypto
    .createHash("sha256")
    .update(source)
    .digest("hex")
    .slice(0, 16);
  const mutantFilename =
    `${WRITER_MODULE_PATH}?mutant=${sourceHash}`;
  const mutant = new Module(mutantFilename, module);
  mutant.filename = mutantFilename;
  mutant.paths = Module._nodeModulePaths(
    path.dirname(WRITER_MODULE_PATH),
  );
  mutant._compile(source, mutantFilename);
  return mutant.exports;
}

async function runWriterMain(argv, output) {
  const priorArgv = process.argv;
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const priorMainModule = process.mainModule;
  delete require.cache[WRITER_MODULE_PATH];
  process.argv = [process.execPath, WRITER_MODULE_PATH, ...argv];
  process.exitCode = undefined;
  console.log = (value) => output.push(String(value));
  try {
    Module._load(WRITER_MODULE_PATH, null, true);
    await waitFor(() => output.length > 0);
    return process.exitCode;
  } finally {
    console.log = priorLog;
    process.argv = priorArgv;
    process.exitCode = priorExitCode;
    process.mainModule = priorMainModule;
    delete require.cache[WRITER_MODULE_PATH];
  }
}

async function socketServer(t, respond) {
  const root = temporaryDirectory(t, "pikiio-writer-control-socket-");
  const socketPath = path.join(root, "control.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", () => respond(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );
  return socketPath;
}

function launchctlOutput({
  state = "running",
  pid = 4242,
  program = "/usr/bin/caffeinate",
  arguments: serviceArguments = HOST_SERVICE_ARGUMENTS,
  servicePath =
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`,
} = {}) {
  return [
    `gui/501/${HOST_SERVICE_LABEL} = {`,
    `  path = ${servicePath}`,
    `  state = ${state}`,
    `  program = ${program}`,
    "  arguments = {",
    ...serviceArguments.map((argument) => `    ${argument}`),
    "  }",
    `  pid = ${pid}`,
    "  last exit code = 0",
    "}",
    "",
  ].join("\n");
}

function readyReceipt({
  observedAt = new Date(NOW).toISOString(),
  hostname = HOSTNAME,
  launchctl = {},
  assertionsOutput = [
    "Assertion status system-wide:",
    "  PreventSystemSleep 1",
    "  PreventUserIdleSystemSleep 1",
    "Listed by owning process:",
    '  pid 4242(caffeinate): [0x1] PreventSystemSleep named: "caffeinate"',
    '  pid 4242(caffeinate): [0x2] PreventUserIdleSystemSleep named: "caffeinate"',
  ].join("\n"),
  pmsetOutput =
    "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n womp 1\n",
  servicePlistEvidence = null,
} = {}) {
  const expectedPath =
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  return buildHostDurabilityReceipt({
    observedAt,
    hostname,
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    batteryOutput:
      "Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged;",
    pmsetOutput,
    assertionsOutput,
    clamshellOutput: '"AppleClamshellState" = No\n',
    launchctlOutput: launchctlOutput({
      servicePath: expectedPath,
      ...launchctl,
    }),
    expectedPlistPath: expectedPath,
    servicePlistEvidence:
      servicePlistEvidence || {
        expectedPath,
        resolvedPath: expectedPath,
        readable: true,
        regular: true,
        symlink: false,
        byteLength: HOST_SERVICE_PLIST_BYTE_LENGTH,
        sha256: HOST_SERVICE_PLIST_SHA256,
        maximumBytes: MAXIMUM_HOST_SERVICE_PLIST_BYTES,
        errorCode: null,
      },
  });
}

function invalidHostCases() {
  const wrongPlistPath =
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  return [
    {
      name: "stale",
      receipt: readyReceipt({
        observedAt: new Date(NOW - MAXIMUM_RECEIPT_AGE_MS - 1).toISOString(),
      }),
      expected: /stale or future-dated/,
    },
    {
      name: "future",
      receipt: readyReceipt({
        observedAt: new Date(NOW + 1).toISOString(),
      }),
      expected: /stale or future-dated/,
    },
    {
      name: "wrong-host",
      receipt: readyReceipt({ hostname: "foreign-host" }),
      expected: /hostname mismatch/,
    },
    {
      name: "stopped",
      receipt: readyReceipt({ launchctl: { state: "stopped" } }),
      expected: /not ready/,
    },
    {
      name: "wrong-plist",
      receipt: readyReceipt({
        servicePlistEvidence: {
          expectedPath: wrongPlistPath,
          resolvedPath: wrongPlistPath,
          readable: true,
          regular: true,
          symlink: false,
          byteLength: HOST_SERVICE_PLIST_BYTE_LENGTH,
          sha256: "0".repeat(64),
          maximumBytes: MAXIMUM_HOST_SERVICE_PLIST_BYTES,
          errorCode: null,
        },
      }),
      expected: /not ready/,
    },
    {
      name: "missing-assertions",
      receipt: readyReceipt({ assertionsOutput: "" }),
      expected: /not ready/,
    },
    {
      name: "unreadable-sleep-policy",
      receipt: readyReceipt({ pmsetOutput: "" }),
      expected: /AC sleep policy is unreadable/,
    },
  ];
}

function handleFixture(t, { phaseId = "TRUTH-01" } = {}) {
  const root = temporaryDirectory(t, "pikiio-writer-host-handle-");
  const handlePath = path.join(root, "writer-handle.json");
  const leasePath = path.join(root, "writer-lease.json");
  const handle = {
    schema: "pikiio-writer-handle-v1",
    runId: "host-gate-run",
    fence: 7,
    capability: CAPABILITY,
    controlSocketPath: path.join(root, "control.sock"),
    leasePath,
  };
  const lease = {
    schema: "pikiio-writer-lease-v2",
    runId: handle.runId,
    fence: handle.fence,
    phaseId,
    capabilitySha256: CAPABILITY_SHA256,
    expiresAt: "2026-07-24T12:30:00.000Z",
    lastRenewedAt: "2026-07-24T12:00:00.000Z",
  };
  fs.writeFileSync(handlePath, `${JSON.stringify(handle)}\n`, { mode: 0o600 });
  fs.writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  return { root, handlePath, leasePath, handle, lease };
}

function acquisitionOptions(t, {
  receipt,
  phaseId = "TRUTH-01",
  leaseClass = "builder",
} = {}) {
  const root = temporaryDirectory(t, "pikiio-writer-host-acquire-");
  const runtimeDir = path.join(root, "runtime");
  const phase = {
    id: phaseId,
    lane: phaseId === "GOV-00" ? "autonomy-governance" : "truth-liveness",
    allowedPaths: [],
  };
  const ledger = {
    codexGoal: {
      objectiveSha256: "b".repeat(64),
    },
  };
  const holderCalls = [];
  const argv = [
    "node",
    "pikiio-agent-writer-lease.js",
    "acquire",
    `--lease-class=${leaseClass}`,
    "--run-id=host-gate-acquire",
    "--lease-ms=120000",
    ...(leaseClass === "morning" ? ["--supervised-pid=999"] : []),
  ];
  return {
    root,
    runtimeDir,
    holderCalls,
    options: {
      argv,
      runtimeDir,
      localHost: HOSTNAME,
      nowMs: NOW,
      loadPhaseLedgerImpl: () => ledger,
      selectActivePhaseImpl: () => phase,
      evaluateGoalGuardImpl: () => ({ ok: true }),
      validateHeartbeatActivationReceiptImpl: () => ({ valid: true, errors: [] }),
      evaluateDirtyGuardImpl: () => ({
        ok: true,
        working: { allowed: [], blocked: [] },
      }),
      currentHeadImpl: () => "c".repeat(40),
      currentBranchImpl: () => "codex/truth-foundation-single-authority",
      readActivationReceipt: () => ({ valid: true }),
      collectHostDurability: () => receipt,
      validateHostDurability: validateHostDurabilityReceipt,
      startLeaseHolderImpl: async (bootstrapPath) => {
        holderCalls.push(bootstrapPath);
        const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
        fs.unlinkSync(bootstrapPath);
        return {
          ok: true,
          handlePath: bootstrap.handlePath,
          lease: {
            phaseId: bootstrap.config.phaseId,
            lane: bootstrap.config.lane,
          },
        };
      },
    },
  };
}

test("only GOV-00 is exempt from the fresh host gate", () => {
  assert.equal(hostGateRequired("GOV-00"), false);
  for (const phaseId of ["TRUTH-01", "ACTION-01", "MORNING-REFRESH", "", null]) {
    assert.equal(hostGateRequired(phaseId), true);
  }
});

test("fresh host validation uses a post-collection clock and returns exact evidence", () => {
  const receipt = readyReceipt({
    observedAt: new Date(NOW + 10).toISOString(),
  });
  let nowCalls = 0;
  const result = freshHostDurability({
    collectHostDurability: () => receipt,
    validateHostDurability: validateHostDurabilityReceipt,
    now: () => {
      nowCalls += 1;
      return NOW + 10;
    },
    localHost: HOSTNAME,
  });
  assert.equal(result, receipt);
  assert.equal(nowCalls, 1);
});

test("every stale, forged, stopped, or unreadable host receipt fails closed", () => {
  for (const fixture of invalidHostCases()) {
    assert.throws(
      () =>
        freshHostDurability({
          collectHostDurability: () => fixture.receipt,
          validateHostDurability: validateHostDurabilityReceipt,
          nowMs: NOW,
          localHost: HOSTNAME,
        }),
      (error) => {
        assert.equal(error.code, "HEARTBEAT_HOST_DURABILITY_INVALID");
        assert.match(error.details.errors.join("\n"), fixture.expected);
        if (fixture.name === "unreadable-sleep-policy") {
          assert.deepEqual(
            error.details.blockers.filter(
              (blocker) => blocker === "HOST_SLEEP_POLICY_UNREADABLE",
            ),
            ["HOST_SLEEP_POLICY_UNREADABLE"],
          );
        }
        return true;
      },
      fixture.name,
    );
  }
});

test("malformed validator diagnostics still fail closed without trusting optional arrays", () => {
  const receipt = readyReceipt();
  delete receipt.blockers;
  assert.throws(
    () =>
      freshHostDurability({
        collectHostDurability: () => receipt,
        validateHostDurability: () => ({ valid: false }),
        nowMs: NOW,
        localHost: HOSTNAME,
      }),
    (error) => {
      assert.equal(error.code, "HEARTBEAT_HOST_DURABILITY_INVALID");
      assert.deepEqual(error.details, { errors: [], blockers: [] });
      return true;
    },
  );
});

test("host receipt shape is independently required even when a validator claims success", () => {
  for (const [name, receipt] of [
    ["missing receipt", null],
    ["scalar receipt", "ready"],
    ["missing sleep object", { blockers: [] }],
    ["scalar sleep object", { sleep: "never", blockers: [] }],
    ["fractional sleep value", {
      sleep: { acSleepMinutes: 0.5 },
      blockers: [],
    }],
    ["negative sleep value", {
      sleep: { acSleepMinutes: -1 },
      blockers: [],
    }],
  ]) {
    assert.throws(
      () =>
        freshHostDurability({
          collectHostDurability: () => receipt,
          validateHostDurability: () => ({ valid: true, errors: [] }),
          nowMs: NOW,
          localHost: HOSTNAME,
        }),
      (error) => {
        assert.equal(error.code, "HEARTBEAT_HOST_DURABILITY_INVALID");
        assert.match(error.details.errors.join("\n"), /sleep policy/);
        assert.deepEqual(error.details.blockers, [
          "HOST_SLEEP_POLICY_UNREADABLE",
        ]);
        return true;
      },
      name,
    );
  }
});

test("lease redaction is null-safe and never mutates the persisted lease", () => {
  assert.equal(redactLease(null), null);
  const lease = {
    runId: "redaction-run",
    capabilitySha256: "secret-digest",
    nested: { kept: true },
  };
  assert.deepEqual(redactLease(lease), {
    runId: "redaction-run",
    nested: { kept: true },
  });
  assert.equal(lease.capabilitySha256, "secret-digest");
});

test("private writer handles reject missing, broad, malformed, and ambiguous identity", (t) => {
  assert.throws(
    () => loadHandle(""),
    (error) => error.code === "WRITER_HANDLE_REQUIRED",
  );
  const context = handleFixture(t);
  fs.chmodSync(context.handlePath, 0o644);
  assert.throws(
    () => loadHandle(context.handlePath),
    (error) => error.code === "WRITER_HANDLE_PERMISSIONS_INVALID",
  );
  fs.chmodSync(context.handlePath, 0o600);

  for (const [name, mutate] of [
    ["schema", (handle) => { handle.schema = "other"; }],
    ["run", (handle) => { handle.runId = ""; }],
    ["fence", (handle) => { handle.fence = 1.5; }],
    ["capability", (handle) => { handle.capability = "A".repeat(64); }],
    ["socket", (handle) => { handle.controlSocketPath = ""; }],
    ["lease", (handle) => { handle.leasePath = ""; }],
  ]) {
    const changed = structuredClone(context.handle);
    mutate(changed);
    fs.writeFileSync(context.handlePath, `${JSON.stringify(changed)}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => loadHandle(context.handlePath),
      (error) => error.code === "WRITER_HANDLE_INVALID",
      name,
    );
  }
});

test("every refused non-GOV builder acquire leaves no runtime authority artifact", async (t) => {
  for (const fixture of invalidHostCases()) {
    await t.test(fixture.name, async (t) => {
      const context = acquisitionOptions(t, { receipt: fixture.receipt });
      await assert.rejects(
        acquireCommand(context.options),
        (error) => error.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
      );
      assert.equal(context.holderCalls.length, 0);
      assert.equal(fs.existsSync(context.runtimeDir), false);
      assert.deepEqual(
        fs.readdirSync(context.root).filter((name) =>
          /(?:writer-(?:handle|bootstrap|lease)|control\\.sock)/.test(name),
        ),
        [],
      );
    });
  }
});

test("morning acquisition is also host-gated before any authority artifact", async (t) => {
  const context = acquisitionOptions(t, {
    receipt: readyReceipt({ launchctl: { state: "stopped" } }),
    leaseClass: "morning",
  });
  await assert.rejects(
    acquireCommand(context.options),
    (error) => error.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
  );
  assert.equal(context.holderCalls.length, 0);
  assert.equal(fs.existsSync(context.runtimeDir), false);
});

test("ready non-GOV acquisition gates exactly once before holder startup", async (t) => {
  const context = acquisitionOptions(t, { receipt: readyReceipt() });
  let collections = 0;
  context.options.collectHostDurability = () => {
    collections += 1;
    return readyReceipt();
  };
  const result = await acquireCommand(context.options);
  assert.equal(result.ok, true);
  assert.equal(result.lease.phaseId, "TRUTH-01");
  assert.equal(collections, 1);
  assert.equal(context.holderCalls.length, 1);
  assert.deepEqual(fs.readdirSync(context.runtimeDir), []);
});

test("GOV-00 bootstrap remains exempt while still using the normal holder path", async (t) => {
  const context = acquisitionOptions(t, {
    receipt: null,
    phaseId: "GOV-00",
  });
  context.options.collectHostDurability = () => {
    throw new Error("GOV bootstrap must not collect host evidence");
  };
  const result = await acquireCommand(context.options);
  assert.equal(result.ok, true);
  assert.equal(result.lease.phaseId, "GOV-00");
  assert.equal(context.holderCalls.length, 1);
});

test("acquisition arguments refuse unknown classes, nonnumeric leases, and scope overrides", async (t) => {
  const unknown = acquisitionOptions(t, {
    receipt: readyReceipt(),
    phaseId: "GOV-00",
  });
  unknown.options.argv = [
    "node",
    "writer",
    "acquire",
    "--lease-class=operator",
  ];
  await assert.rejects(
    acquireCommand(unknown.options),
    /--lease-class must be builder or morning/,
  );

  const nonnumeric = acquisitionOptions(t, {
    receipt: readyReceipt(),
    phaseId: "GOV-00",
  });
  nonnumeric.options.argv = [
    "node",
    "writer",
    "acquire",
    "--lease-class=builder",
    "--lease-ms=forever",
  ];
  await assert.rejects(
    acquireCommand(nonnumeric.options),
    /--lease-ms must be numeric/,
  );

  for (const flag of ["phase", "lane"]) {
    const overridden = acquisitionOptions(t, {
      receipt: readyReceipt(),
      phaseId: "GOV-00",
    });
    overridden.options.argv.push(`--${flag}=attacker-selected`);
    await assert.rejects(
      acquireCommand(overridden.options),
      (error) => error.code === "WRITER_SCOPE_OVERRIDE_REFUSED",
      flag,
    );
  }
});

test("builder authority refuses every goal, activation, and dirty-checkpoint failure before startup", async (t) => {
  const cases = [
    {
      name: "goal refusal",
      configure(options) {
        options.evaluateGoalGuardImpl = () => ({
          ok: false,
          code: "GOAL_REFUSED",
          error: "goal does not bind",
          details: { objective: "wrong" },
        });
      },
      code: "GOAL_REFUSED",
    },
    {
      name: "activation receipt unreadable",
      configure(options) {
        options.readActivationReceipt = () => {
          throw new Error("missing");
        };
      },
      code: "HEARTBEAT_ACTIVATION_RECEIPT_REQUIRED",
    },
    {
      name: "activation invalid",
      configure(options) {
        options.validateHeartbeatActivationReceiptImpl = () => ({
          valid: false,
          errors: ["expired"],
        });
      },
      code: "HEARTBEAT_ACTIVATION_INVALID",
    },
    {
      name: "dirty guard red",
      configure(options) {
        options.evaluateDirtyGuardImpl = () => ({
          ok: false,
          working: { allowed: [], blocked: [] },
        });
      },
      code: "HEARTBEAT_CHECKPOINT_NOT_CLEAN",
    },
    {
      name: "allowed changes remain",
      configure(options) {
        options.evaluateDirtyGuardImpl = () => ({
          ok: true,
          working: { allowed: ["tests/changed.js"], blocked: [] },
        });
      },
      code: "HEARTBEAT_CHECKPOINT_NOT_CLEAN",
    },
    {
      name: "blocked changes remain",
      configure(options) {
        options.evaluateDirtyGuardImpl = () => ({
          ok: true,
          working: { allowed: [], blocked: ["lib/changed.js"] },
        });
      },
      code: "HEARTBEAT_CHECKPOINT_NOT_CLEAN",
    },
  ];
  for (const refusal of cases) {
    await t.test(refusal.name, async (t) => {
      const context = acquisitionOptions(t, {
        receipt: readyReceipt(),
        phaseId: "TRUTH-01",
      });
      refusal.configure(context.options);
      await assert.rejects(
        acquireCommand(context.options),
        (error) => {
          assert.equal(error.code, refusal.code);
          return true;
        },
      );
      assert.equal(context.holderCalls.length, 0);
      assert.equal(fs.existsSync(context.runtimeDir), false);
    });
  }
});

test("morning acquisition requires a positive safe supervised PID", async (t) => {
  for (const value of ["", "0", "-1", "1.5", "not-a-pid"]) {
    await t.test(value || "missing", async (t) => {
      const context = acquisitionOptions(t, {
        receipt: readyReceipt(),
        leaseClass: "morning",
      });
      context.options.argv = context.options.argv.filter(
        (entry) => !entry.startsWith("--supervised-pid="),
      );
      if (value) context.options.argv.push(`--supervised-pid=${value}`);
      await assert.rejects(
        acquireCommand(context.options),
        (error) => error.code === "MORNING_SUPERVISED_PID_REQUIRED",
      );
      assert.equal(context.holderCalls.length, 0);
      assert.equal(fs.existsSync(context.runtimeDir), false);
    });
  }
});

test("default builder arguments remain ledger-selected and preserve default metadata", async (t) => {
  const context = acquisitionOptions(t, {
    receipt: null,
    phaseId: "GOV-00",
  });
  context.options.argv = ["node", "writer", "acquire"];
  let bootstrap;
  context.options.startLeaseHolderImpl = async (bootstrapPath) => {
    bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
    fs.unlinkSync(bootstrapPath);
    return { ok: true, handlePath: bootstrap.handlePath };
  };
  const priorObjective = process.env.PIKIIO_CODEX_GOAL_OBJECTIVE;
  const priorThread = process.env.PIKIIO_CODEX_GOAL_THREAD_ID;
  process.env.PIKIIO_CODEX_GOAL_OBJECTIVE = "environment objective";
  process.env.PIKIIO_CODEX_GOAL_THREAD_ID = "environment-thread";
  try {
    const result = await acquireCommand(context.options);
    assert.equal(result.ok, true);
  } finally {
    if (priorObjective === undefined) {
      delete process.env.PIKIIO_CODEX_GOAL_OBJECTIVE;
    } else {
      process.env.PIKIIO_CODEX_GOAL_OBJECTIVE = priorObjective;
    }
    if (priorThread === undefined) {
      delete process.env.PIKIIO_CODEX_GOAL_THREAD_ID;
    } else {
      process.env.PIKIIO_CODEX_GOAL_THREAD_ID = priorThread;
    }
  }
  assert.equal(bootstrap.config.phaseId, "GOV-00");
  assert.equal(bootstrap.config.automationId, "interactive-codex");
  assert.equal(bootstrap.config.leaseMs, 15 * 60 * 1000);
  assert.equal(bootstrap.config.supervisedPid, null);
  assert.match(bootstrap.config.runId, /^[a-f0-9-]{36}$/);
});

test("explicit goal and automation metadata bind the bootstrap without environment fallback", async (t) => {
  const context = acquisitionOptions(t, {
    receipt: null,
    phaseId: "GOV-00",
  });
  context.options.argv.push(
    "--goal-objective=cli-objective",
    "--goal-thread-id=cli-thread",
    "--automation-id=cli-automation",
  );
  let goalInput;
  let bootstrap;
  context.options.evaluateGoalGuardImpl = (input) => {
    goalInput = input;
    return { ok: true };
  };
  context.options.startLeaseHolderImpl = async (bootstrapPath) => {
    bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
    fs.unlinkSync(bootstrapPath);
    return { ok: true };
  };
  await acquireCommand(context.options);
  assert.equal(goalInput.goalObjective, "cli-objective");
  assert.equal(goalInput.goalThreadId, "cli-thread");
  assert.equal(bootstrap.config.automationId, "cli-automation");
});

test("non-GOV assert and renew each require a fresh host receipt", async (t) => {
  const context = handleFixture(t);
  const operations = [];
  let collections = 0;
  const options = {
    readLeaseImpl: () => context.lease,
    collectHostDurability: () => {
      collections += 1;
      return readyReceipt();
    },
    validateHostDurability: validateHostDurabilityReceipt,
    nowMs: NOW,
    localHost: HOSTNAME,
    requestTransport: async (_handle, request) => {
      operations.push(request.operation);
      return { ok: true, lease: context.lease };
    },
  };
  await sendControlRequest(context.handlePath, "assert", {}, options);
  await sendControlRequest(
    context.handlePath,
    "renew",
    { requestedLeaseMs: 60_000 },
    options,
  );
  assert.deepEqual(operations, ["assert", "renew"]);
  assert.equal(collections, 2);
});

test("host degradation after acquire blocks the first checkpoint and renewal", async (t) => {
  const context = acquisitionOptions(t, { receipt: readyReceipt() });
  let currentReceipt = readyReceipt();
  let acquired;
  context.options.collectHostDurability = () => currentReceipt;
  context.options.startLeaseHolderImpl = async (bootstrapPath) => {
    const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
    fs.unlinkSync(bootstrapPath);
    const leasePath = path.join(context.runtimeDir, "writer-lease.json");
    const handlePath = path.join(context.runtimeDir, "writer-handle.json");
    const handle = {
      schema: "pikiio-writer-handle-v1",
      runId: bootstrap.config.runId,
      fence: 11,
      capability: bootstrap.capability,
      controlSocketPath: bootstrap.socketPath,
      leasePath,
    };
    const lease = {
      schema: "pikiio-writer-lease-v2",
      runId: handle.runId,
      fence: handle.fence,
      phaseId: bootstrap.config.phaseId,
      capabilitySha256: crypto
        .createHash("sha256")
        .update(handle.capability)
        .digest("hex"),
      expiresAt: "2026-07-24T12:30:00.000Z",
      lastRenewedAt: "2026-07-24T12:00:00.000Z",
    };
    fs.writeFileSync(handlePath, `${JSON.stringify(handle)}\n`, { mode: 0o600 });
    fs.writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    acquired = { handlePath, leasePath, lease };
    return { ok: true, handlePath, lease };
  };

  const result = await acquireCommand(context.options);
  assert.equal(result.ok, true);
  currentReceipt = readyReceipt({ launchctl: { state: "stopped" } });
  const persistedAfterAcquire = fs.readFileSync(acquired.leasePath);
  let transportCalls = 0;
  const controlOptions = {
    readLeaseImpl: () => acquired.lease,
    collectHostDurability: () => currentReceipt,
    validateHostDurability: validateHostDurabilityReceipt,
    nowMs: NOW,
    localHost: HOSTNAME,
    requestTransport: async () => {
      transportCalls += 1;
      acquired.lease.expiresAt = "2099-01-01T00:00:00.000Z";
      fs.writeFileSync(
        acquired.leasePath,
        `${JSON.stringify(acquired.lease)}\n`,
      );
      return { ok: true };
    },
  };
  for (const operation of ["assert", "renew"]) {
    assert.throws(
      () =>
        sendControlRequest(
          acquired.handlePath,
          operation,
          operation === "renew" ? { requestedLeaseMs: 60_000 } : {},
          controlOptions,
        ),
      (error) => error.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
    );
  }
  assert.equal(transportCalls, 0);
  assert.deepEqual(
    fs.readFileSync(acquired.leasePath),
    persistedAfterAcquire,
  );
});

test("every degraded host blocks assert and renew before control transport", async (t) => {
  const context = handleFixture(t);
  for (const fixture of invalidHostCases()) {
    for (const operation of ["assert", "renew"]) {
      await t.test(`${fixture.name}-${operation}`, async () => {
        const before = JSON.stringify(context.lease);
        const persistedBefore = fs.readFileSync(context.leasePath);
        let transportCalls = 0;
        assert.throws(
          () =>
            sendControlRequest(
              context.handlePath,
              operation,
              operation === "renew" ? { requestedLeaseMs: 60_000 } : {},
              {
                readLeaseImpl: () => context.lease,
                collectHostDurability: () => fixture.receipt,
                validateHostDurability: validateHostDurabilityReceipt,
                nowMs: NOW,
                localHost: HOSTNAME,
                requestTransport: async () => {
                  transportCalls += 1;
                  context.lease.expiresAt = "2099-01-01T00:00:00.000Z";
                  fs.writeFileSync(
                    context.leasePath,
                    `${JSON.stringify(context.lease)}\n`,
                  );
                  return { ok: true };
                },
              },
            ),
          (error) => error.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
        );
        assert.equal(transportCalls, 0);
        assert.equal(JSON.stringify(context.lease), before);
        assert.deepEqual(fs.readFileSync(context.leasePath), persistedBefore);
      });
    }
  }
});

test("degradation after a successful renewal cannot mutate a later checkpoint", async (t) => {
  const context = handleFixture(t);
  let currentReceipt = readyReceipt();
  let renewals = 0;
  const options = {
    readLeaseImpl: () => context.lease,
    collectHostDurability: () => currentReceipt,
    validateHostDurability: validateHostDurabilityReceipt,
    nowMs: NOW,
    localHost: HOSTNAME,
    requestTransport: async (_handle, request) => {
      if (request.operation === "renew") {
        renewals += 1;
        context.lease.lastRenewedAt = "2026-07-24T12:01:00.000Z";
        context.lease.expiresAt = "2026-07-24T12:31:00.000Z";
        fs.writeFileSync(
          context.leasePath,
          `${JSON.stringify(context.lease)}\n`,
        );
      }
      return { ok: true, lease: context.lease };
    },
  };
  await sendControlRequest(
    context.handlePath,
    "renew",
    { requestedLeaseMs: 60_000 },
    options,
  );
  assert.equal(renewals, 1);

  currentReceipt = readyReceipt({ assertionsOutput: "" });
  const afterFirstRenewal = JSON.stringify(context.lease);
  const persistedAfterFirstRenewal = fs.readFileSync(context.leasePath);
  assert.throws(
    () => sendControlRequest(context.handlePath, "assert", {}, options),
    (error) => error.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
  );
  assert.throws(
    () =>
      sendControlRequest(
        context.handlePath,
        "renew",
        { requestedLeaseMs: 60_000 },
        options,
      ),
    (error) => error.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
  );
  assert.equal(renewals, 1);
  assert.equal(JSON.stringify(context.lease), afterFirstRenewal);
  assert.deepEqual(
    fs.readFileSync(context.leasePath),
    persistedAfterFirstRenewal,
  );
});

test("GOV assert and renew remain exempt, while release remains possible when degraded", async (t) => {
  const context = handleFixture(t, { phaseId: "GOV-00" });
  const operations = [];
  const options = {
    readLeaseImpl: () => context.lease,
    collectHostDurability: () => {
      throw new Error("exempt operation unexpectedly collected host evidence");
    },
    requestTransport: async (_handle, request) => {
      operations.push(request.operation);
      return { ok: true };
    },
  };
  await sendControlRequest(context.handlePath, "assert", {}, options);
  await sendControlRequest(
    context.handlePath,
    "renew",
    { requestedLeaseMs: 60_000 },
    options,
  );

  context.lease.phaseId = "TRUTH-01";
  await sendControlRequest(context.handlePath, "release", {}, options);
  assert.deepEqual(operations, ["assert", "renew", "release"]);
});

test("control host preflight binds the private handle to the persisted lease", (t) => {
  const context = handleFixture(t);
  assert.equal(
    persistedHandleLease(context.handle, () => context.lease),
    context.lease,
  );
  for (const mutate of [
    (lease) => {
      lease.runId = "other";
    },
    (lease) => {
      lease.fence += 1;
    },
    (lease) => {
      lease.capabilitySha256 = "0".repeat(64);
    },
    (lease) => {
      lease.phaseId = "";
    },
  ]) {
    const changed = structuredClone(context.lease);
    mutate(changed);
    assert.throws(
      () => persistedHandleLease(context.handle, () => changed),
      (error) => error.code === "WRITER_LEASE_LOST",
    );
  }
  assert.throws(
    () => persistedHandleLease(context.handle, () => null),
    (error) => error.code === "WRITER_LEASE_LOST",
  );
});

test("handle transport contract requires a private lease path binding", (t) => {
  const context = handleFixture(t);
  assert.equal(loadHandle(context.handlePath).leasePath, context.leasePath);
  const widened = { ...context.handle };
  delete widened.leasePath;
  fs.writeFileSync(context.handlePath, `${JSON.stringify(widened)}\n`, {
    mode: 0o600,
  });
  assert.throws(
    () => loadHandle(context.handlePath),
    (error) => error.code === "WRITER_HANDLE_INVALID",
  );
});

test("real socket transport handles split success, bounded refusal, malformed JSON, and connection errors", async (t) => {
  const request = {
    schema: "pikiio-writer-control-v1",
    requestId: "socket-contract",
    operation: "assert",
  };

  const splitPath = await socketServer(t, (socket) => {
    socket.write('{"ok":');
    setImmediate(() => socket.end('true,"action":"asserted"}\n'));
  });
  assert.deepEqual(
    await sendRequestOverSocket({ controlSocketPath: splitPath }, request),
    { ok: true, action: "asserted" },
  );

  const refusalPath = await socketServer(t, (socket) => {
    socket.end('{"ok":false}\n');
  });
  await assert.rejects(
    sendRequestOverSocket({ controlSocketPath: refusalPath }, request),
    (error) => {
      assert.equal(error.code, "WRITER_CONTROL_FAILED");
      assert.equal(error.message, "Writer control failed");
      return true;
    },
  );

  const malformedPath = await socketServer(t, (socket) => {
    socket.end("not-json\n");
  });
  await assert.rejects(
    sendRequestOverSocket({ controlSocketPath: malformedPath }, request),
    SyntaxError,
  );

  const missingPath = path.join(
    temporaryDirectory(t, "pikiio-writer-missing-socket-"),
    "missing.sock",
  );
  await assert.rejects(
    sendRequestOverSocket({ controlSocketPath: missingPath }, request),
    (error) => error.code === "ENOENT",
  );
});

test("silent control sockets reach the immutable production timeout", async (t) => {
  const silentPath = await socketServer(t, () => {});
  await assert.rejects(
    sendRequestOverSocket(
      { controlSocketPath: silentPath },
      {
        schema: "pikiio-writer-control-v1",
        requestId: "timeout-contract",
        operation: "assert",
      },
    ),
    (error) => error.code === "WRITER_CONTROL_TIMEOUT",
  );
});

test("real isolated writer lifecycle enforces acquire, renew, fence, identity, and release", async (t) => {
  const { home, isolated } = isolatedWriterHome(t);
  const runtimeDir = path.join(home, ".codex", "runtime", "pikiio-agent");
  const ledger = {
    codexGoal: { objectiveSha256: "b".repeat(64) },
  };
  const phase = {
    id: "GOV-00",
    lane: "autonomy-governance",
    allowedPaths: ["tests/**"],
  };
  const hostOptions = {
    collectHostDurability: () => ({
      sleep: { acSleepMinutes: 0 },
      blockers: [],
    }),
    validateHostDurability: () => ({ valid: true, errors: [] }),
    nowMs: Date.now(),
    localHost: os.hostname(),
  };
  const acquire = () =>
    isolated.acquireCommand({
      argv: [
        "node",
        "writer",
        "acquire",
        "--lease-class=morning",
        "--run-id=isolated-lifecycle",
        "--lease-ms=120000",
        `--supervised-pid=${process.pid}`,
      ],
      runtimeDir,
      loadPhaseLedgerImpl: () => ledger,
      selectActivePhaseImpl: () => phase,
      evaluateGoalGuardImpl: () => ({ ok: true }),
      currentBranchImpl: () => "codex/isolated-writer-test",
      currentHeadImpl: () => "c".repeat(40),
      ...hostOptions,
    });

  const acquired = await acquire();
  const ownerPid = acquired.lease.ownerPid;
  t.after(() => {
    try {
      process.kill(ownerPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.lease.runId, "isolated-lifecycle");
  assert.equal(acquired.lease.phaseId, "MORNING-REFRESH");
  assert.equal(fs.existsSync(acquired.handlePath), true);

  const asserted = await isolated.sendControlRequest(
    acquired.handlePath,
    "assert",
    {},
    hostOptions,
  );
  assert.equal(asserted.ok, true);
  const renewed = await isolated.sendControlRequest(
    acquired.handlePath,
    "renew",
    { requestedLeaseMs: 60_000 },
    hostOptions,
  );
  assert.equal(renewed.ok, true);

  const originalHandle = isolated.loadHandle(acquired.handlePath);
  for (const [name, mutate] of [
    ["run identity", (handle) => { handle.runId = "forged-run"; }],
    ["fence", (handle) => { handle.fence += 1; }],
    ["capability", (handle) => { handle.capability = "f".repeat(64); }],
  ]) {
    const forgedPath = path.join(runtimeDir, `forged-${name.replace(" ", "-")}.json`);
    const forged = structuredClone(originalHandle);
    mutate(forged);
    fs.writeFileSync(forgedPath, `${JSON.stringify(forged)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      isolated.sendControlRequest(forgedPath, "release"),
      (error) => error.code === "WRITER_CONTROL_NOT_OWNER",
      name,
    );
  }

  const busyBootstrap = path.join(runtimeDir, "busy-bootstrap.json");
  fs.writeFileSync(busyBootstrap, "{}\n", { mode: 0o600 });
  await assert.rejects(
    isolated.startLeaseHolder(busyBootstrap),
    (error) => error.code === "WRITER_LEASE_BUSY",
  );
  assert.equal(fs.existsSync(busyBootstrap), false);

  const terminal = await isolated.sendControlRequest(
    acquired.handlePath,
    "morning-terminal",
    {
      terminal: {
        result: "failed",
        truthPublished: false,
        finishedAt: new Date().toISOString(),
        detail: "isolated lifecycle test",
      },
    },
  );
  assert.equal(terminal.ok, true);
  const released = await isolated.sendControlRequest(
    acquired.handlePath,
    "release",
  );
  assert.equal(released.ok, true);
  await waitFor(() => !fs.existsSync(acquired.handlePath));
});

test("isolated holder reports malformed bootstrap failure and removes the one-time input", async (t) => {
  const { home, isolated } = isolatedWriterHome(t);
  const runtimeDir = path.join(home, ".codex", "runtime", "pikiio-agent");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const bootstrapPath = path.join(runtimeDir, "malformed-bootstrap.json");
  fs.writeFileSync(bootstrapPath, '{"schema":"wrong"}\n', { mode: 0o600 });
  await assert.rejects(
    isolated.startLeaseHolder(bootstrapPath),
    (error) => {
      assert.equal(error.code, "WRITER_LEASE_HOLDER_FAILED");
      assert.match(error.message, /LEASE_BOOTSTRAP_INVALID/);
      return true;
    },
  );
  assert.equal(fs.existsSync(bootstrapPath), false);
});

test("isolated default activation reader fails closed when no receipt exists", async (t) => {
  const { isolated } = isolatedWriterHome(t);
  await assert.rejects(
    isolated.acquireCommand({
      argv: [
        "node",
        "writer",
        "acquire",
        "--lease-class=builder",
      ],
      loadPhaseLedgerImpl: () => ({
        codexGoal: { objectiveSha256: "b".repeat(64) },
      }),
      selectActivePhaseImpl: () => ({
        id: "TRUTH-01",
        lane: "truth-liveness",
        allowedPaths: ["tests/**"],
      }),
      evaluateGoalGuardImpl: () => ({ ok: true }),
    }),
    (error) => error.code === "HEARTBEAT_ACTIVATION_RECEIPT_REQUIRED",
  );
});

test("isolated holder reaches the immutable startup timeout without leaving its bootstrap", async (t) => {
  const { home, isolated } = isolatedWriterHome(t);
  const runtimeDir = path.join(home, ".codex", "runtime", "pikiio-agent");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const bootstrapPath = path.join(runtimeDir, "blocked-bootstrap.pipe");
  execFileSync("/usr/bin/mkfifo", [bootstrapPath]);
  fs.chmodSync(bootstrapPath, 0o600);
  const startup = isolated.startLeaseHolder(bootstrapPath);
  let writerDescriptor = null;
  await waitFor(() => {
    try {
      writerDescriptor = fs.openSync(
        bootstrapPath,
        fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
      );
      return true;
    } catch (error) {
      if (error.code === "ENXIO") return false;
      throw error;
    }
  });
  try {
    await assert.rejects(
      startup,
      (error) => error.code === "WRITER_LEASE_STARTUP_TIMEOUT",
    );
  } finally {
    fs.closeSync(writerDescriptor);
  }
  assert.equal(fs.existsSync(bootstrapPath), false);
});

test("writer CLI entrypoint emits bounded status and unknown-command receipts under an isolated home", async (t) => {
  const { home } = isolatedWriterHome(t);
  const statusOutput = [];
  assert.equal(await runWriterMain(["status"], statusOutput), undefined);
  assert.deepEqual(JSON.parse(statusOutput[0]), {
    ok: true,
    lease: null,
  });
  const defaultStatusOutput = [];
  assert.equal(await runWriterMain([], defaultStatusOutput), undefined);
  assert.deepEqual(JSON.parse(defaultStatusOutput[0]), {
    ok: true,
    lease: null,
  });

  const refusalOutput = [];
  assert.equal(
    await runWriterMain(["unknown-command"], refusalOutput),
    1,
  );
  assert.deepEqual(JSON.parse(refusalOutput[0]), {
    ok: false,
    code: "WRITER_LEASE_COMMAND_FAILED",
    error: "Unknown lease command: unknown-command",
    details: {},
  });

  const missingHandle = path.join(home, "missing-handle.json");
  for (const command of ["assert", "renew", "release"]) {
    const output = [];
    assert.equal(
      await runWriterMain(
        [command, `--handle=${missingHandle}`],
        output,
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ENOENT");
  }

  const acquireOutput = [];
  assert.equal(
    await runWriterMain(
      ["acquire", "--lease-class=invalid"],
      acquireOutput,
    ),
    1,
  );
  assert.match(
    JSON.parse(acquireOutput[0]).error,
    /--lease-class must be builder or morning/,
  );
});

test("writer mutation sabotage detects removed host, identity, scope, and supervision guards", async (t) => {
  const hostBypass = loadWriterMutant(
    'return phaseId !== "GOV-00";',
    "return false;",
  );
  assert.equal(hostGateRequired("TRUTH-01"), true);
  assert.equal(hostBypass.hostGateRequired("TRUTH-01"), false);

  const context = handleFixture(t);
  const fenceBypass = loadWriterMutant(
    "current.fence !== handle.fence ||",
    "false ||",
  );
  const wrongFence = { ...context.lease, fence: context.lease.fence + 1 };
  assert.doesNotThrow(() =>
    fenceBypass.persistedHandleLease(context.handle, () => wrongFence),
  );

  const capabilityBypass = loadWriterMutant(
    "current.capabilitySha256 !== capabilitySha256 ||",
    "false ||",
  );
  const wrongCapability = {
    ...context.lease,
    capabilitySha256: "0".repeat(64),
  };
  assert.doesNotThrow(() =>
    capabilityBypass.persistedHandleLease(
      context.handle,
      () => wrongCapability,
    ),
  );

  fs.chmodSync(context.handlePath, 0o644);
  const permissionBypass = loadWriterMutant(
    "if ((stat.mode & 0o077) !== 0) {",
    "if (false) {",
  );
  assert.equal(
    permissionBypass.loadHandle(context.handlePath).runId,
    context.handle.runId,
  );
  fs.chmodSync(context.handlePath, 0o600);

  const preflightBypass = loadWriterMutant(
    'if (operation === "assert" || operation === "renew") {',
    "if (false) {",
  );
  let transportCalls = 0;
  const bypassed = await preflightBypass.sendControlRequest(
    context.handlePath,
    "renew",
    { requestedLeaseMs: 60_000 },
    {
      collectHostDurability: () => {
        throw new Error("host preflight should have run");
      },
      requestTransport: async () => {
        transportCalls += 1;
        return { ok: true };
      },
    },
  );
  assert.equal(bypassed.ok, true);
  assert.equal(transportCalls, 1);

  const scopeBypass = loadWriterMutant(
    'if (valueArg("phase", argv) || valueArg("lane", argv)) {',
    "if (false) {",
  );
  const scopeContext = acquisitionOptions(t, {
    receipt: null,
    phaseId: "GOV-00",
  });
  scopeContext.options.argv.push("--phase=attacker-selected");
  assert.equal(
    (await scopeBypass.acquireCommand(scopeContext.options)).ok,
    true,
  );

  const supervisionBypass = loadWriterMutant(
    "if (!Number.isSafeInteger(supervisedPid) || supervisedPid < 1) {",
    "if (false) {",
  );
  const morningContext = acquisitionOptions(t, {
    receipt: readyReceipt(),
    leaseClass: "morning",
  });
  morningContext.options.argv = morningContext.options.argv.filter(
    (entry) => !entry.startsWith("--supervised-pid="),
  );
  assert.equal(
    (await supervisionBypass.acquireCommand(morningContext.options)).ok,
    true,
  );
});
