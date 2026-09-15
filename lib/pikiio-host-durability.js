"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOST_SERVICE_LABEL = "com.codex.pikiio.caffeinate";
const HOST_SERVICE_PROGRAM = "/usr/bin/caffeinate";
const HOST_SERVICE_ARGUMENTS = Object.freeze([
  HOST_SERVICE_PROGRAM,
  "-is",
]);
const HOST_SERVICE_PLIST_SUFFIX = path.join(
  "Library",
  "LaunchAgents",
  `${HOST_SERVICE_LABEL}.plist`,
);
const MAXIMUM_RECEIPT_AGE_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HOST_SERVICE_PLIST_NAME = `${HOST_SERVICE_LABEL}.plist`;
const HOST_SERVICE_BACKUP_DIRECTORY = ".pikiio-host-durability-backups";
const HOST_SERVICE_SOURCE_PATH = path.resolve(
  __dirname,
  "..",
  "ops",
  "launchd",
  HOST_SERVICE_PLIST_NAME,
);
const HOST_SERVICE_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  "<dict>",
  "  <key>Label</key>",
  `  <string>${HOST_SERVICE_LABEL}</string>`,
  "  <key>ProgramArguments</key>",
  "  <array>",
  `    <string>${HOST_SERVICE_PROGRAM}</string>`,
  "    <string>-is</string>",
  "  </array>",
  "  <key>RunAtLoad</key>",
  "  <true/>",
  "  <key>KeepAlive</key>",
  "  <true/>",
  "  <key>ProcessType</key>",
  "  <string>Background</string>",
  "</dict>",
  "</plist>",
  "",
].join("\n");
const HOST_SERVICE_PLIST_SHA256 = crypto
  .createHash("sha256")
  .update(HOST_SERVICE_PLIST)
  .digest("hex");
const AUTHORIZATION_PREFIX = "pikiio-host-durability-local-v1";
const SAFE_DIRECTORY_MODE = 0o700;
const SAFE_FILE_MODE = 0o600;
const MAXIMUM_HOST_SERVICE_PLIST_BYTES = 64 * 1024;
const HOST_SERVICE_PLIST_BYTE_LENGTH = Buffer.byteLength(HOST_SERVICE_PLIST);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultNow() {
  return new Date();
}

function defaultNonce() {
  return crypto.randomBytes(12).toString("hex");
}

function writeStdout(value) {
  return process.stdout.write(value);
}

function unavailableServicePlistEvidence(
  expectedPath,
  errorCode = "HOST_KEEP_AWAKE_PLIST_EVIDENCE_UNAVAILABLE",
) {
  return {
    expectedPath,
    resolvedPath: null,
    readable: false,
    regular: false,
    symlink: false,
    byteLength: null,
    sha256: null,
    maximumBytes: MAXIMUM_HOST_SERVICE_PLIST_BYTES,
    errorCode,
  };
}

function sameFileIdentity(left, right) {
  return (
    left &&
    right &&
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino)
  );
}

function sameFileSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    Number(left.size) === Number(right.size) &&
    Number(left.mtimeMs) === Number(right.mtimeMs) &&
    Number(left.ctimeMs) === Number(right.ctimeMs)
  );
}

function readExactServicePlistEvidence({
  expectedPath,
  fsImpl = fs,
  maximumBytes = MAXIMUM_HOST_SERVICE_PLIST_BYTES,
} = {}) {
  const failure = (errorCode, overrides = {}) => ({
    ...unavailableServicePlistEvidence(expectedPath, errorCode),
    ...overrides,
  });
  if (
    typeof expectedPath !== "string" ||
    !path.isAbsolute(expectedPath) ||
    path.resolve(expectedPath) !== expectedPath
  ) {
    return failure("HOST_KEEP_AWAKE_PLIST_PATH_INVALID");
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < HOST_SERVICE_PLIST_BYTE_LENGTH ||
    maximumBytes > MAXIMUM_HOST_SERVICE_PLIST_BYTES
  ) {
    return failure("HOST_KEEP_AWAKE_PLIST_BOUND_INVALID");
  }
  let fileDescriptor = null;
  try {
    const beforePath = fsImpl.lstatSync(expectedPath);
    if (beforePath.isSymbolicLink()) {
      return failure("HOST_KEEP_AWAKE_PLIST_SYMLINK_REFUSED", {
        symlink: true,
      });
    }
    if (!beforePath.isFile()) {
      return failure("HOST_KEEP_AWAKE_PLIST_NOT_REGULAR");
    }
    if (
      !Number.isSafeInteger(Number(beforePath.size)) ||
      Number(beforePath.size) < 0 ||
      Number(beforePath.size) > maximumBytes
    ) {
      return failure("HOST_KEEP_AWAKE_PLIST_OVERSIZED", {
        regular: true,
        byteLength: Number(beforePath.size),
      });
    }
    const resolvedBefore = fsImpl.realpathSync(expectedPath);
    if (resolvedBefore !== expectedPath) {
      return failure("HOST_KEEP_AWAKE_PLIST_RESOLUTION_MISMATCH", {
        resolvedPath: resolvedBefore,
        regular: true,
      });
    }
    fileDescriptor = fsImpl.openSync(
      expectedPath,
      fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    const beforeDescriptor = fsImpl.fstatSync(fileDescriptor);
    if (!beforeDescriptor.isFile()) {
      throw new HostDurabilityError(
        "HOST_KEEP_AWAKE_PLIST_NOT_REGULAR",
      );
    }
    if (!sameFileSnapshot(beforePath, beforeDescriptor)) {
      throw new HostDurabilityError(
        "HOST_KEEP_AWAKE_PLIST_TOCTOU_DETECTED",
      );
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.length) {
      const bytesRead = fsImpl.readSync(
        fileDescriptor,
        buffer,
        byteLength,
        buffer.length - byteLength,
        null,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
    }
    if (byteLength > maximumBytes) {
      throw new HostDurabilityError(
        "HOST_KEEP_AWAKE_PLIST_OVERSIZED",
      );
    }
    const afterDescriptor = fsImpl.fstatSync(fileDescriptor);
    const afterPath = fsImpl.lstatSync(expectedPath);
    const resolvedAfter = fsImpl.realpathSync(expectedPath);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      resolvedAfter !== expectedPath ||
      !sameFileSnapshot(beforeDescriptor, afterDescriptor) ||
      !sameFileSnapshot(afterDescriptor, afterPath) ||
      Number(afterDescriptor.size) !== byteLength
    ) {
      throw new HostDurabilityError(
        "HOST_KEEP_AWAKE_PLIST_TOCTOU_DETECTED",
      );
    }
    const content = buffer.subarray(0, byteLength);
    fsImpl.closeSync(fileDescriptor);
    fileDescriptor = null;
    return {
      expectedPath,
      resolvedPath: resolvedAfter,
      readable: true,
      regular: true,
      symlink: false,
      byteLength,
      sha256: sha256(content),
      maximumBytes,
      errorCode: null,
    };
  } catch (error) {
    return failure(
      error instanceof HostDurabilityError
        ? error.code
        : "HOST_KEEP_AWAKE_PLIST_UNREADABLE",
    );
  } finally {
    if (fileDescriptor !== null) {
      try {
        fsImpl.closeSync(fileDescriptor);
      } catch {
        // The evidence remains fail-closed.
      }
    }
  }
}

function hashWithoutField(value, field = "receiptHash") {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function parseBatterySummary(value) {
  const text = String(value || "");
  const power = /Now drawing from 'AC Power'/i.test(text)
    ? "ac"
    : /Now drawing from 'Battery Power'/i.test(text)
      ? "battery"
      : "unknown";
  const percent = text.match(/(\d+)%/);
  return {
    source: power,
    batteryPercent: percent ? Number(percent[1]) : null,
    charged: /\bcharged\b/i.test(text),
    summarySha256: sha256(text),
  };
}

function parsePmsetCustom(value) {
  const text = String(value || "");
  const acBlock = text.match(
    /AC Power:\s*([\s\S]*?)(?=\n\S[^:\n]* Power:|\s*$)/,
  )?.[1] || "";
  const sleep = acBlock.match(/^\s*sleep\s+(\d+)\s*$/m);
  const powerNap = acBlock.match(/^\s*powernap\s+(\d+)\s*$/m);
  const wakeOnLan = acBlock.match(/^\s*womp\s+(\d+)\s*$/m);
  return {
    acSleepMinutes: sleep ? Number(sleep[1]) : null,
    acPowerNap: powerNap ? Number(powerNap[1]) : null,
    acWakeOnLan: wakeOnLan ? Number(wakeOnLan[1]) : null,
    settingsSha256: sha256(text),
  };
}

function parseClamshellState(value) {
  const text = String(value || "");
  const match = text.match(
    /"?AppleClamshellState"?\s*=\s*(Yes|No|true|false|1|0)/i,
  );
  const normalized = String(match?.[1] || "").toLowerCase();
  const open =
    normalized === "no" || normalized === "false" || normalized === "0"
      ? true
      : normalized === "yes" ||
          normalized === "true" ||
          normalized === "1"
        ? false
        : null;
  return {
    open,
    stateSha256: sha256(text),
  };
}

function parsePowerAssertions(value) {
  const text = String(value || "");
  const status = (name) => {
    const match = text.match(
      new RegExp(`^\\s*${name}\\s+(\\d+)\\s*$`, "m"),
    );
    return match ? Number(match[1]) : null;
  };
  const ownerPid = (assertionName) => {
    const owner = text.match(
      new RegExp(
        `^\\s*pid\\s+(\\d+)\\(caffeinate\\):[^\\n]*${assertionName}\\b`,
        "m",
      ),
    );
    return owner ? Number(owner[1]) : null;
  };
  const systemOwnerPid = ownerPid("PreventSystemSleep");
  const idleOwnerPid = ownerPid("PreventUserIdleSystemSleep");
  return {
    preventSystemSleep: status("PreventSystemSleep") === 1,
    preventIdleSystemSleep: status("PreventUserIdleSystemSleep") === 1,
    caffeinateOwnerPid:
      systemOwnerPid !== null && systemOwnerPid === idleOwnerPid
        ? systemOwnerPid
        : null,
    caffeinatePreventSystemSleepPid: systemOwnerPid,
    caffeinatePreventIdleSystemSleepPid: idleOwnerPid,
    assertionsSha256: sha256(text),
  };
}

function parseLaunchctlPrint(value) {
  const text = String(value || "");
  const argumentsBlock =
    text.match(/\n\s*arguments = \{\s*([\s\S]*?)\n\s*\}/)?.[1] || "";
  const argumentsList = argumentsBlock
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const number = (name) => {
    const match = text.match(new RegExp(`^\\s*${name} = (\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
  return {
    state: text.match(/^\s*state = ([^\n]+)\s*$/m)?.[1]?.trim() || "unknown",
    pid: number("pid"),
    lastExitCode: number("last exit code"),
    path: text.match(/^\s*path = ([^\n]+)\s*$/m)?.[1]?.trim() || "",
    program:
      text.match(/^\s*program = ([^\n]+)\s*$/m)?.[1]?.trim() || "",
    arguments: argumentsList,
    launchctlSha256: sha256(text),
  };
}

function exactHostBlockers(receipt) {
  const blockers = [];
  if (receipt.platform !== "darwin") blockers.push("HOST_PLATFORM_UNSUPPORTED");
  if (receipt.power.source !== "ac") blockers.push("HOST_NOT_ON_AC_POWER");
  if (
    !Number.isSafeInteger(receipt.sleep.acSleepMinutes) ||
    receipt.sleep.acSleepMinutes < 0
  ) {
    blockers.push("HOST_SLEEP_POLICY_UNREADABLE");
  }
  if (receipt.service.state !== "running") {
    blockers.push("HOST_KEEP_AWAKE_SERVICE_NOT_RUNNING");
  }
  if (!Number.isSafeInteger(receipt.service.pid) || receipt.service.pid < 1) {
    blockers.push("HOST_KEEP_AWAKE_PID_INVALID");
  }
  if (receipt.service.program !== HOST_SERVICE_PROGRAM) {
    blockers.push("HOST_KEEP_AWAKE_PROGRAM_MISMATCH");
  }
  if (
    stableJson(receipt.service.arguments) !==
    stableJson(HOST_SERVICE_ARGUMENTS)
  ) {
    blockers.push("HOST_KEEP_AWAKE_ARGUMENTS_MISMATCH");
  }
  if (receipt.service.path !== receipt.servicePlist.expectedPath) {
    blockers.push("HOST_KEEP_AWAKE_PLIST_MISMATCH");
  }
  if (
    receipt.servicePlist.readable !== true ||
    receipt.servicePlist.regular !== true ||
    receipt.servicePlist.symlink !== false ||
    receipt.servicePlist.errorCode !== null
  ) {
    blockers.push("HOST_KEEP_AWAKE_PLIST_EVIDENCE_UNAVAILABLE");
  } else if (
    receipt.servicePlist.byteLength !== HOST_SERVICE_PLIST_BYTE_LENGTH ||
    receipt.servicePlist.sha256 !== HOST_SERVICE_PLIST_SHA256 ||
    receipt.servicePlist.resolvedPath !== receipt.servicePlist.expectedPath
  ) {
    blockers.push("HOST_KEEP_AWAKE_PLIST_CONTENT_MISMATCH");
  }
  if (
    receipt.assertions.preventSystemSleep !== true ||
    receipt.assertions.preventIdleSystemSleep !== true
  ) {
    blockers.push("HOST_KEEP_AWAKE_ASSERTION_MISSING");
  }
  if (
    receipt.assertions.caffeinateOwnerPid !== receipt.service.pid ||
    receipt.assertions.caffeinatePreventSystemSleepPid !==
      receipt.service.pid ||
    receipt.assertions.caffeinatePreventIdleSystemSleepPid !==
      receipt.service.pid
  ) {
    blockers.push("HOST_KEEP_AWAKE_ASSERTION_OWNER_MISMATCH");
  }
  return blockers;
}

function buildHostDurabilityReceipt({
  observedAt = new Date().toISOString(),
  hostname = os.hostname(),
  platform = process.platform,
  architecture = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  batteryOutput = "",
  pmsetOutput = "",
  assertionsOutput = "",
  clamshellOutput = "",
  launchctlOutput = "",
  expectedPlistPath = path.join(os.homedir(), HOST_SERVICE_PLIST_SUFFIX),
  servicePlistEvidence = unavailableServicePlistEvidence(
    expectedPlistPath,
  ),
} = {}) {
  const unsigned = {
    schema: "pikiio-host-durability-receipt-v1",
    observedAt,
    hostname,
    platform,
    architecture,
    serviceDomain:
      Number.isSafeInteger(uid) && uid >= 0
        ? `gui/${uid}/${HOST_SERVICE_LABEL}`
        : "",
    power: parseBatterySummary(batteryOutput),
    sleep: parsePmsetCustom(pmsetOutput),
    assertions: parsePowerAssertions(assertionsOutput),
    clamshell: parseClamshellState(clamshellOutput),
    service: {
      label: HOST_SERVICE_LABEL,
      ...parseLaunchctlPrint(launchctlOutput),
    },
    servicePlist: {
      ...servicePlistEvidence,
      expectedPath: expectedPlistPath,
    },
  };
  const blockers = exactHostBlockers(unsigned);
  const body = {
    ...unsigned,
    ready: blockers.length === 0,
    blockers,
  };
  return {
    ...body,
    receiptHash: hashWithoutField(body),
  };
}

function validateHostDurabilityReceipt(
  receipt,
  {
    nowMs = Date.now(),
    localHost = os.hostname(),
  } = {},
) {
  const errors = [];
  if (!isObject(receipt)) {
    return { valid: false, errors: ["host durability receipt must be an object"] };
  }
  if (receipt.schema !== "pikiio-host-durability-receipt-v1") {
    errors.push("host durability receipt schema is invalid");
  }
  if (
    !SHA256_PATTERN.test(String(receipt.receiptHash || "")) ||
    hashWithoutField(receipt) !== receipt.receiptHash
  ) {
    errors.push("host durability receipt hash is invalid");
  }
  const observedAt = Date.parse(receipt.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > nowMs ||
    nowMs - observedAt > MAXIMUM_RECEIPT_AGE_MS
  ) {
    errors.push("host durability receipt is stale or future-dated");
  }
  if (receipt.hostname !== localHost) {
    errors.push("host durability receipt hostname mismatch");
  }
  const requiredObjects = [
    "power",
    "sleep",
    "assertions",
    "clamshell",
    "service",
    "servicePlist",
  ];
  if (requiredObjects.some((key) => !isObject(receipt[key]))) {
    errors.push("host durability receipt structure is invalid");
  } else {
    const expectedBlockers = exactHostBlockers(receipt);
    if (
      !Array.isArray(receipt.blockers) ||
      stableJson(receipt.blockers) !== stableJson(expectedBlockers) ||
      receipt.ready !== (expectedBlockers.length === 0)
    ) {
      errors.push("host durability readiness is not reproducible");
    }
    for (const digest of [
      receipt.power.summarySha256,
      receipt.sleep.settingsSha256,
      receipt.assertions.assertionsSha256,
      receipt.clamshell.stateSha256,
      receipt.service.launchctlSha256,
    ]) {
      if (!SHA256_PATTERN.test(String(digest || ""))) {
        errors.push("host durability source digest is invalid");
      }
    }
    const plistEvidence = receipt.servicePlist;
    const readableEvidence =
      plistEvidence.readable === true &&
      plistEvidence.regular === true &&
      plistEvidence.symlink === false &&
      plistEvidence.errorCode === null;
    if (
      typeof plistEvidence.expectedPath !== "string" ||
      !path.isAbsolute(plistEvidence.expectedPath) ||
      plistEvidence.maximumBytes !== MAXIMUM_HOST_SERVICE_PLIST_BYTES ||
      (readableEvidence &&
        (plistEvidence.resolvedPath !== plistEvidence.expectedPath ||
          !Number.isSafeInteger(plistEvidence.byteLength) ||
          plistEvidence.byteLength < 0 ||
          plistEvidence.byteLength > plistEvidence.maximumBytes ||
          !SHA256_PATTERN.test(String(plistEvidence.sha256 || "")))) ||
      (!readableEvidence &&
        (plistEvidence.byteLength !== null ||
          plistEvidence.sha256 !== null ||
          typeof plistEvidence.errorCode !== "string"))
    ) {
      errors.push("host durability plist evidence is invalid");
    }
  }
  if (receipt.ready !== true) {
    errors.push("host durability is not ready for unattended activation");
  }
  return {
    valid: errors.length === 0,
    errors,
    blockers: Array.isArray(receipt.blockers) ? receipt.blockers : [],
  };
}

function fixedCommand(command, args, run = spawnSync) {
  const result = run(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

class HostDurabilityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HostDurabilityError";
    this.code = code;
  }
}

function requireCondition(condition, code, message = code) {
  if (!condition) throw new HostDurabilityError(code, message);
}

function safeLstat(targetPath, fsImpl = fs) {
  try {
    return fsImpl.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularFile(targetPath, fsImpl = fs) {
  const stat = safeLstat(targetPath, fsImpl);
  requireCondition(stat, "HOST_DURABILITY_FILE_MISSING");
  requireCondition(
    !stat.isSymbolicLink() && stat.isFile(),
    "HOST_DURABILITY_FILE_UNSAFE",
  );
  return stat;
}

function readSafeRegularFile(targetPath, fsImpl = fs) {
  assertRegularFile(targetPath, fsImpl);
  const fileDescriptor = fsImpl.openSync(
    targetPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fsImpl.fstatSync(fileDescriptor);
    requireCondition(stat.isFile(), "HOST_DURABILITY_FILE_UNSAFE");
    return fsImpl.readFileSync(fileDescriptor);
  } finally {
    fsImpl.closeSync(fileDescriptor);
  }
}

function assertPathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  requireCondition(
    relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "HOST_DURABILITY_PATH_ESCAPE",
  );
}

function assertSafeHome(homeDir, fsImpl = fs) {
  requireCondition(
    typeof homeDir === "string" &&
      path.isAbsolute(homeDir) &&
      path.resolve(homeDir) === homeDir,
    "HOST_DURABILITY_HOME_INVALID",
  );
  const stat = safeLstat(homeDir, fsImpl);
  requireCondition(
    stat && !stat.isSymbolicLink() && stat.isDirectory(),
    "HOST_DURABILITY_HOME_UNSAFE",
  );
  const realHome = fsImpl.realpathSync(homeDir);
  requireCondition(realHome === homeDir, "HOST_DURABILITY_HOME_UNSAFE");
  return realHome;
}

function ensureSafeDirectory(parentPath, name, fsImpl = fs) {
  requireCondition(
    typeof name === "string" &&
      name.length > 0 &&
      name !== "." &&
      name !== ".." &&
      !name.includes(path.sep),
    "HOST_DURABILITY_DIRECTORY_INVALID",
  );
  const directory = path.join(parentPath, name);
  assertPathWithin(parentPath, directory);
  const before = safeLstat(directory, fsImpl);
  if (!before) fsImpl.mkdirSync(directory, { mode: SAFE_DIRECTORY_MODE });
  const stat = safeLstat(directory, fsImpl);
  requireCondition(
    stat && !stat.isSymbolicLink() && stat.isDirectory(),
    "HOST_DURABILITY_DIRECTORY_UNSAFE",
  );
  requireCondition(
    fsImpl.realpathSync(directory) === directory,
    "HOST_DURABILITY_DIRECTORY_UNSAFE",
  );
  return directory;
}

function resolveSafeServicePaths({ homeDir, fsImpl = fs }) {
  const realHome = assertSafeHome(homeDir, fsImpl);
  const library = ensureSafeDirectory(realHome, "Library", fsImpl);
  const launchAgents = ensureSafeDirectory(library, "LaunchAgents", fsImpl);
  const backupDirectory = ensureSafeDirectory(
    launchAgents,
    HOST_SERVICE_BACKUP_DIRECTORY,
    fsImpl,
  );
  const targetPath = path.join(launchAgents, HOST_SERVICE_PLIST_NAME);
  assertPathWithin(realHome, targetPath);
  const existing = safeLstat(targetPath, fsImpl);
  requireCondition(
    !existing || (!existing.isSymbolicLink() && existing.isFile()),
    "HOST_DURABILITY_TARGET_UNSAFE",
  );
  return { realHome, launchAgents, backupDirectory, targetPath };
}

function readCanonicalServicePlist({
  sourcePath = HOST_SERVICE_SOURCE_PATH,
  fsImpl = fs,
} = {}) {
  requireCondition(
    typeof sourcePath === "string" &&
      path.isAbsolute(sourcePath) &&
      path.resolve(sourcePath) === sourcePath,
    "HOST_DURABILITY_SOURCE_PATH_INVALID",
  );
  assertRegularFile(sourcePath, fsImpl);
  requireCondition(
    fsImpl.realpathSync(sourcePath) === sourcePath,
    "HOST_DURABILITY_SOURCE_UNSAFE",
  );
  const content = readSafeRegularFile(sourcePath, fsImpl);
  requireCondition(
    content.equals(Buffer.from(HOST_SERVICE_PLIST)),
    "HOST_DURABILITY_SOURCE_CONTENT_MISMATCH",
  );
  requireCondition(
    sha256(content) === HOST_SERVICE_PLIST_SHA256,
    "HOST_DURABILITY_SOURCE_HASH_MISMATCH",
  );
  return content;
}

function buildLocalHostAuthorizationToken({
  action,
  hostname,
  uid,
  backupSha256 = "",
}) {
  requireCondition(
    action === "install" || action === "rollback",
    "HOST_DURABILITY_ACTION_INVALID",
  );
  requireCondition(
    typeof hostname === "string" &&
      hostname.length > 0 &&
      !/[\s:]/.test(hostname),
    "HOST_DURABILITY_HOSTNAME_INVALID",
  );
  requireCondition(
    Number.isSafeInteger(uid) && uid >= 0,
    "HOST_DURABILITY_UID_INVALID",
  );
  if (action === "rollback") {
    requireCondition(
      SHA256_PATTERN.test(backupSha256),
      "HOST_DURABILITY_BACKUP_HASH_INVALID",
    );
  } else {
    requireCondition(
      backupSha256 === "",
      "HOST_DURABILITY_BACKUP_HASH_FORBIDDEN",
    );
  }
  return [
    AUTHORIZATION_PREFIX,
    action,
    hostname,
    String(uid),
    action === "install" ? HOST_SERVICE_PLIST_SHA256 : backupSha256,
  ].join(":");
}

function assertLocalHostAuthorization({
  action,
  authorization,
  hostname,
  uid,
  backupSha256 = "",
}) {
  const expected = buildLocalHostAuthorizationToken({
    action,
    hostname,
    uid,
    backupSha256,
  });
  const expectedBytes = Buffer.from(expected);
  const authorizationBytes =
    typeof authorization === "string" ? Buffer.from(authorization) : null;
  requireCondition(
    authorizationBytes !== null &&
      authorizationBytes.length === expectedBytes.length &&
      crypto.timingSafeEqual(authorizationBytes, expectedBytes),
    "HOST_DURABILITY_LOCAL_AUTHORIZATION_REQUIRED",
  );
  return expected;
}

function assertSafeTarget(targetPath, launchAgents, fsImpl = fs) {
  assertPathWithin(launchAgents, targetPath);
  requireCondition(
    fsImpl.realpathSync(launchAgents) === launchAgents,
    "HOST_DURABILITY_DIRECTORY_UNSAFE",
  );
  const stat = safeLstat(targetPath, fsImpl);
  requireCondition(
    !stat || (!stat.isSymbolicLink() && stat.isFile()),
    "HOST_DURABILITY_TARGET_UNSAFE",
  );
  return stat;
}

function atomicWriteRegularFile({
  targetPath,
  launchAgents,
  content,
  fsImpl = fs,
  nonce = defaultNonce,
}) {
  assertSafeTarget(targetPath, launchAgents, fsImpl);
  const temporaryPath = path.join(
    launchAgents,
    `.${HOST_SERVICE_PLIST_NAME}.${nonce()}.tmp`,
  );
  assertPathWithin(launchAgents, temporaryPath);
  let fileDescriptor = null;
  let createdTemporary = false;
  try {
    fileDescriptor = fsImpl.openSync(
      temporaryPath,
      "wx",
      SAFE_FILE_MODE,
    );
    createdTemporary = true;
    fsImpl.writeFileSync(fileDescriptor, content);
    fsImpl.fsyncSync(fileDescriptor);
    fsImpl.closeSync(fileDescriptor);
    fileDescriptor = null;
    const temporaryStat = safeLstat(temporaryPath, fsImpl);
    requireCondition(
      temporaryStat &&
        !temporaryStat.isSymbolicLink() &&
        temporaryStat.isFile(),
      "HOST_DURABILITY_TEMPORARY_FILE_UNSAFE",
    );
    assertSafeTarget(targetPath, launchAgents, fsImpl);
    fsImpl.renameSync(temporaryPath, targetPath);
    fsImpl.chmodSync(targetPath, SAFE_FILE_MODE);
    const installed = readSafeRegularFile(targetPath, fsImpl);
    requireCondition(
      Buffer.from(content).equals(installed),
      "HOST_DURABILITY_ATOMIC_WRITE_MISMATCH",
    );
  } finally {
    if (fileDescriptor !== null) {
      try {
        fsImpl.closeSync(fileDescriptor);
      } catch {
        // The original failure remains authoritative.
      }
    }
    if (createdTemporary) {
      const temporaryStat = safeLstat(temporaryPath, fsImpl);
      if (temporaryStat && !temporaryStat.isSymbolicLink()) {
        fsImpl.unlinkSync(temporaryPath);
      }
    }
  }
}

function backupExistingPlist({
  content,
  backupDirectory,
  fsImpl = fs,
}) {
  if (content === null) return null;
  requireCondition(
    fsImpl.realpathSync(backupDirectory) === backupDirectory,
    "HOST_DURABILITY_BACKUP_DIRECTORY_UNSAFE",
  );
  const digest = sha256(content);
  const backupPath = path.join(
    backupDirectory,
    `${HOST_SERVICE_LABEL}.${digest}.plist`,
  );
  assertPathWithin(backupDirectory, backupPath);
  const existing = safeLstat(backupPath, fsImpl);
  if (existing) {
    requireCondition(
      !existing.isSymbolicLink() && existing.isFile(),
      "HOST_DURABILITY_BACKUP_UNSAFE",
    );
    requireCondition(
      readSafeRegularFile(backupPath, fsImpl).equals(content),
      "HOST_DURABILITY_BACKUP_COLLISION",
    );
  } else {
    fsImpl.writeFileSync(backupPath, content, {
      encoding: null,
      flag: "wx",
      mode: SAFE_FILE_MODE,
    });
    fsImpl.chmodSync(backupPath, SAFE_FILE_MODE);
  }
  return {
    path: backupPath,
    sha256: digest,
    bytes: Buffer.byteLength(content),
  };
}

function commandReceipt(command, args, result) {
  return {
    command,
    args: [...args],
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
}

function runFixedLaunchctl(args, run, commandReceipts) {
  const result = fixedCommand("/bin/launchctl", args, run);
  commandReceipts.push(commandReceipt("/bin/launchctl", args, result));
  return result;
}

function requireCommandSuccess(result, code) {
  requireCondition(
    result.status === 0 && result.signal === null && result.timedOut === false,
    code,
  );
}

function servicePresence(serviceDomain, run, commandReceipts) {
  const result = runFixedLaunchctl(
    ["print", serviceDomain],
    run,
    commandReceipts,
  );
  if (
    result.status === 0 &&
    result.signal === null &&
    result.timedOut === false
  ) {
    return true;
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  requireCondition(
    result.signal === null &&
      result.timedOut === false &&
      /(?:could not find service|service not found)/i.test(combined),
    "HOST_DURABILITY_SERVICE_PRESENCE_UNKNOWN",
  );
  return false;
}

function bootoutService({
  serviceDomainRoot,
  targetPath,
  run,
  commandReceipts,
  required,
}) {
  const result = runFixedLaunchctl(
    ["bootout", serviceDomainRoot, targetPath],
    run,
    commandReceipts,
  );
  const succeeded =
    result.status === 0 &&
    result.signal === null &&
    result.timedOut === false;
  const absent =
    !required &&
    result.signal === null &&
    result.timedOut === false &&
    /(?:could not find service|service not found)/i.test(
      `${result.stdout}\n${result.stderr}`,
    );
  if (!succeeded && !absent) {
    throw new HostDurabilityError("HOST_DURABILITY_BOOTOUT_FAILED");
  }
  return result;
}

function bootstrapService({
  serviceDomainRoot,
  serviceDomain,
  targetPath,
  run,
  commandReceipts,
}) {
  const bootstrap = runFixedLaunchctl(
    ["bootstrap", serviceDomainRoot, targetPath],
    run,
    commandReceipts,
  );
  requireCommandSuccess(bootstrap, "HOST_DURABILITY_BOOTSTRAP_FAILED");
  const kickstart = runFixedLaunchctl(
    ["kickstart", "-k", serviceDomain],
    run,
    commandReceipts,
  );
  requireCommandSuccess(kickstart, "HOST_DURABILITY_KICKSTART_FAILED");
}

function removeSafeTarget(targetPath, launchAgents, fsImpl = fs) {
  const stat = assertSafeTarget(targetPath, launchAgents, fsImpl);
  if (stat) fsImpl.unlinkSync(targetPath);
}

function restorePriorService({
  priorContent,
  targetPath,
  launchAgents,
  serviceDomainRoot,
  serviceDomain,
  run,
  fsImpl,
  nonce,
  commandReceipts,
}) {
  const errors = [];
  const attempt = (callback) => {
    try {
      callback();
    } catch (error) {
      errors.push(error?.code || "HOST_DURABILITY_ROLLBACK_FAILED");
    }
  };
  attempt(() =>
    bootoutService({
      serviceDomainRoot,
      targetPath,
      run,
      commandReceipts,
      required: false,
    }),
  );
  if (priorContent === null) {
    attempt(() => removeSafeTarget(targetPath, launchAgents, fsImpl));
  } else {
    attempt(() =>
      atomicWriteRegularFile({
        targetPath,
        launchAgents,
        content: priorContent,
        fsImpl,
        nonce,
      }),
    );
    if (errors.length === 0) {
      attempt(() =>
        bootstrapService({
          serviceDomainRoot,
          serviceDomain,
          targetPath,
          run,
          commandReceipts,
        }),
      );
    }
  }
  return {
    attempted: true,
    restoredPriorPlist: priorContent !== null && errors.length === 0,
    removedNewPlist: priorContent === null && errors.length === 0,
    rebootstrapAttempted: priorContent !== null,
    complete: errors.length === 0,
    errors,
  };
}

function verifyLiveService({
  receipt,
  targetPath,
  hostname,
  nowMs,
  requireDurability,
}) {
  const errors = [];
  if (receipt.service?.path !== targetPath) {
    errors.push("HOST_DURABILITY_INSTALLED_PATH_MISMATCH");
  }
  if (receipt.service?.state !== "running") {
    errors.push("HOST_DURABILITY_INSTALLED_SERVICE_NOT_RUNNING");
  }
  if (!Number.isSafeInteger(receipt.service?.pid) || receipt.service.pid < 1) {
    errors.push("HOST_DURABILITY_INSTALLED_PID_INVALID");
  }
  if (requireDurability) {
    const validation = validateHostDurabilityReceipt(receipt, {
      nowMs,
      localHost: hostname,
    });
    errors.push(...validation.errors);
  }
  return { valid: errors.length === 0, errors };
}

function buildMutationReceipt({
  action,
  startedAt,
  completedAt,
  hostname,
  uid,
  targetPath,
  backup,
  sourceBackup = null,
  priorPlistSha256,
  commandReceipts,
  verification,
  rollback,
  mutationStarted,
  success,
  errorCode,
}) {
  const body = {
    schema: "pikiio-host-durability-mutation-receipt-v1",
    action,
    startedAt,
    completedAt,
    hostname,
    uid,
    targetPath,
    canonicalPlistSha256: HOST_SERVICE_PLIST_SHA256,
    priorPlistSha256,
    backup,
    sourceBackup,
    commandReceipts,
    verification,
    rollback,
    mutationStarted,
    success,
    errorCode,
  };
  return { ...body, receiptHash: hashWithoutField(body) };
}

function validateHostDurabilityMutationReceipt(receipt) {
  const errors = [];
  if (!isObject(receipt)) {
    return {
      valid: false,
      errors: ["host durability mutation receipt must be an object"],
    };
  }
  if (receipt.schema !== "pikiio-host-durability-mutation-receipt-v1") {
    errors.push("host durability mutation receipt schema is invalid");
  }
  if (
    !SHA256_PATTERN.test(String(receipt.receiptHash || "")) ||
    hashWithoutField(receipt) !== receipt.receiptHash
  ) {
    errors.push("host durability mutation receipt hash is invalid");
  }
  if (!["install", "rollback"].includes(receipt.action)) {
    errors.push("host durability mutation receipt action is invalid");
  }
  const startedAt = Date.parse(receipt.startedAt);
  const completedAt = Date.parse(receipt.completedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt
  ) {
    errors.push("host durability mutation receipt timestamps are invalid");
  }
  const validBackup = (value) =>
    value === null ||
    (isObject(value) &&
      path.isAbsolute(String(value.path || "")) &&
      SHA256_PATTERN.test(String(value.sha256 || "")) &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      path.basename(value.path) ===
        `${HOST_SERVICE_LABEL}.${value.sha256}.plist` &&
      path.basename(path.dirname(value.path)) ===
        HOST_SERVICE_BACKUP_DIRECTORY);
  if (
    receipt.canonicalPlistSha256 !== HOST_SERVICE_PLIST_SHA256 ||
    !Array.isArray(receipt.commandReceipts) ||
    !isObject(receipt.verification) ||
    !isObject(receipt.rollback) ||
    typeof receipt.mutationStarted !== "boolean" ||
    !validBackup(receipt.backup) ||
    !validBackup(receipt.sourceBackup)
  ) {
    errors.push("host durability mutation receipt structure is invalid");
  }
  if (
    !Number.isSafeInteger(receipt.uid) ||
    receipt.uid < 0 ||
    typeof receipt.hostname !== "string" ||
    receipt.hostname.length === 0
  ) {
    errors.push("host durability mutation receipt host identity is invalid");
  }
  if (
    receipt.success === true &&
    (!path.isAbsolute(String(receipt.targetPath || "")) ||
      !receipt.targetPath.endsWith(HOST_SERVICE_PLIST_SUFFIX))
  ) {
    errors.push("host durability mutation receipt target is invalid");
  }
  if (
    receipt.priorPlistSha256 !== null &&
    !SHA256_PATTERN.test(String(receipt.priorPlistSha256 || ""))
  ) {
    errors.push("host durability prior plist hash is invalid");
  }
  if (
    receipt.priorPlistSha256 !== null &&
    receipt.backup?.sha256 !== receipt.priorPlistSha256
  ) {
    errors.push("host durability prior plist backup is not bound");
  }
  if (
    receipt.action === "install" &&
    receipt.sourceBackup !== null
  ) {
    errors.push("host durability install receipt has a foreign source backup");
  }
  if (
    receipt.action === "rollback" &&
    receipt.success === true &&
    !isObject(receipt.sourceBackup)
  ) {
    errors.push("host durability rollback source backup is missing");
  }
  const serviceDomainRoot = `gui/${receipt.uid}`;
  const serviceDomain = `${serviceDomainRoot}/${HOST_SERVICE_LABEL}`;
  const allowedArguments = new Set([
    stableJson(["print", serviceDomain]),
    stableJson(["bootout", serviceDomainRoot, receipt.targetPath]),
    stableJson(["bootstrap", serviceDomainRoot, receipt.targetPath]),
    stableJson(["kickstart", "-k", serviceDomain]),
  ]);
  for (const command of Array.isArray(receipt.commandReceipts)
    ? receipt.commandReceipts
    : []) {
    if (
      !isObject(command) ||
      command.command !== "/bin/launchctl" ||
      !Array.isArray(command.args) ||
      command.args.some((argument) => typeof argument !== "string") ||
      !allowedArguments.has(stableJson(command.args)) ||
      !SHA256_PATTERN.test(String(command.stdoutSha256 || "")) ||
      !SHA256_PATTERN.test(String(command.stderrSha256 || "")) ||
      typeof command.timedOut !== "boolean"
    ) {
      errors.push("host durability command receipt is invalid");
      break;
    }
  }
  if (
    receipt.success !== true &&
    (!receipt.errorCode ||
      (receipt.mutationStarted === true &&
        receipt.rollback?.attempted !== true))
  ) {
    errors.push("host durability failed mutation is missing rollback evidence");
  }
  if (receipt.success === true && receipt.verification?.valid !== true) {
    errors.push("host durability successful mutation lacks verification");
  }
  if (
    receipt.success === true &&
    (receipt.errorCode !== null ||
      receipt.mutationStarted !== true ||
      receipt.rollback?.attempted !== false)
  ) {
    errors.push("host durability successful mutation state is inconsistent");
  }
  return { valid: errors.length === 0, errors };
}

function installHostDurabilityService({
  authorization,
  homeDir = os.homedir(),
  hostname = os.hostname(),
  platform = process.platform,
  architecture = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  sourcePath = HOST_SERVICE_SOURCE_PATH,
  run = spawnSync,
  fsImpl = fs,
  now = defaultNow,
  nonce,
} = {}) {
  const startedAt = now().toISOString();
  let paths = null;
  let priorContent = null;
  let backup = null;
  let mutationStarted = false;
  const commandReceipts = [];
  let verification = { valid: false, errors: ["HOST_DURABILITY_NOT_VERIFIED"] };
  let rollback = {
    attempted: false,
    restoredPriorPlist: false,
    removedNewPlist: false,
    rebootstrapAttempted: false,
    complete: true,
    errors: [],
  };
  let errorCode = null;
  try {
    requireCondition(platform === "darwin", "HOST_PLATFORM_UNSUPPORTED");
    assertLocalHostAuthorization({
      action: "install",
      authorization,
      hostname,
      uid,
    });
    const canonicalPlist = readCanonicalServicePlist({
      sourcePath,
      fsImpl,
    });
    paths = resolveSafeServicePaths({ homeDir, fsImpl });
    const existing = safeLstat(paths.targetPath, fsImpl);
    priorContent = existing
      ? readSafeRegularFile(paths.targetPath, fsImpl)
      : null;
    backup = backupExistingPlist({
      content: priorContent,
      backupDirectory: paths.backupDirectory,
      fsImpl,
    });
    const serviceDomainRoot = `gui/${uid}`;
    const serviceDomain = `${serviceDomainRoot}/${HOST_SERVICE_LABEL}`;
    const present = servicePresence(serviceDomain, run, commandReceipts);
    requireCondition(
      !present || priorContent !== null,
      "HOST_DURABILITY_EXISTING_SERVICE_UNRECOVERABLE",
    );
    if (present) {
      mutationStarted = true;
      bootoutService({
        serviceDomainRoot,
        targetPath: paths.targetPath,
        run,
        commandReceipts,
        required: true,
      });
    }
    mutationStarted = true;
    atomicWriteRegularFile({
      targetPath: paths.targetPath,
      launchAgents: paths.launchAgents,
      content: canonicalPlist,
      fsImpl,
      nonce,
    });
    bootstrapService({
      serviceDomainRoot,
      serviceDomain,
      targetPath: paths.targetPath,
      run,
      commandReceipts,
    });
    const hostReceipt = collectHostDurabilityReceipt({
      run,
      now,
      hostname,
      platform,
      architecture,
      uid,
      homeDir,
      fsImpl,
    });
    verification = {
      ...verifyLiveService({
        receipt: hostReceipt,
        targetPath: paths.targetPath,
        hostname,
        nowMs: now().getTime(),
        requireDurability: true,
      }),
      hostReceipt,
    };
    requireCondition(
      verification.valid,
      "HOST_DURABILITY_POST_INSTALL_VERIFICATION_FAILED",
    );
  } catch (error) {
    errorCode = error?.code || "HOST_DURABILITY_INSTALL_FAILED";
    if (mutationStarted && paths) {
      const serviceDomainRoot = `gui/${uid}`;
      rollback = restorePriorService({
        priorContent,
        targetPath: paths.targetPath,
        launchAgents: paths.launchAgents,
        serviceDomainRoot,
        serviceDomain: `${serviceDomainRoot}/${HOST_SERVICE_LABEL}`,
        run,
        fsImpl,
        nonce,
        commandReceipts,
      });
    }
  }
  const success = errorCode === null;
  return buildMutationReceipt({
    action: "install",
    startedAt,
    completedAt: now().toISOString(),
    hostname,
    uid,
    targetPath: paths?.targetPath || "",
    backup,
    sourceBackup: null,
    priorPlistSha256: priorContent === null ? null : sha256(priorContent),
    commandReceipts,
    verification,
    rollback,
    mutationStarted,
    success,
    errorCode,
  });
}

function readSafeBackup({
  backupSha256,
  backupDirectory,
  fsImpl = fs,
}) {
  requireCondition(
    SHA256_PATTERN.test(String(backupSha256 || "")),
    "HOST_DURABILITY_BACKUP_HASH_INVALID",
  );
  const backupPath = path.join(
    backupDirectory,
    `${HOST_SERVICE_LABEL}.${backupSha256}.plist`,
  );
  assertPathWithin(backupDirectory, backupPath);
  requireCondition(
    fsImpl.realpathSync(backupDirectory) === backupDirectory,
    "HOST_DURABILITY_BACKUP_DIRECTORY_UNSAFE",
  );
  assertRegularFile(backupPath, fsImpl);
  requireCondition(
    fsImpl.realpathSync(backupPath) === backupPath,
    "HOST_DURABILITY_BACKUP_UNSAFE",
  );
  const content = readSafeRegularFile(backupPath, fsImpl);
  requireCondition(
    sha256(content) === backupSha256,
    "HOST_DURABILITY_BACKUP_CONTENT_MISMATCH",
  );
  return { backupPath, content };
}

function rollbackHostDurabilityService({
  authorization,
  backupSha256,
  homeDir = os.homedir(),
  hostname = os.hostname(),
  platform = process.platform,
  architecture = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  run = spawnSync,
  fsImpl = fs,
  now = defaultNow,
  nonce,
} = {}) {
  const startedAt = now().toISOString();
  let paths = null;
  let currentContent = null;
  let backup = null;
  let sourceBackup = null;
  let mutationStarted = false;
  const commandReceipts = [];
  let verification = { valid: false, errors: ["HOST_DURABILITY_NOT_VERIFIED"] };
  let rollback = {
    attempted: false,
    restoredPriorPlist: false,
    removedNewPlist: false,
    rebootstrapAttempted: false,
    complete: true,
    errors: [],
  };
  let errorCode = null;
  try {
    requireCondition(platform === "darwin", "HOST_PLATFORM_UNSUPPORTED");
    assertLocalHostAuthorization({
      action: "rollback",
      authorization,
      hostname,
      uid,
      backupSha256,
    });
    paths = resolveSafeServicePaths({ homeDir, fsImpl });
    const desired = readSafeBackup({
      backupSha256,
      backupDirectory: paths.backupDirectory,
      fsImpl,
    });
    const current = safeLstat(paths.targetPath, fsImpl);
    currentContent = current
      ? readSafeRegularFile(paths.targetPath, fsImpl)
      : null;
    sourceBackup = {
      path: desired.backupPath,
      sha256: backupSha256,
      bytes: desired.content.length,
    };
    backup = backupExistingPlist({
      content: currentContent,
      backupDirectory: paths.backupDirectory,
      fsImpl,
    });
    const serviceDomainRoot = `gui/${uid}`;
    const serviceDomain = `${serviceDomainRoot}/${HOST_SERVICE_LABEL}`;
    const present = servicePresence(serviceDomain, run, commandReceipts);
    requireCondition(
      !present || currentContent !== null,
      "HOST_DURABILITY_EXISTING_SERVICE_UNRECOVERABLE",
    );
    if (present) {
      mutationStarted = true;
      bootoutService({
        serviceDomainRoot,
        targetPath: paths.targetPath,
        run,
        commandReceipts,
        required: true,
      });
    }
    mutationStarted = true;
    atomicWriteRegularFile({
      targetPath: paths.targetPath,
      launchAgents: paths.launchAgents,
      content: desired.content,
      fsImpl,
      nonce,
    });
    bootstrapService({
      serviceDomainRoot,
      serviceDomain,
      targetPath: paths.targetPath,
      run,
      commandReceipts,
    });
    const hostReceipt = collectHostDurabilityReceipt({
      run,
      now,
      hostname,
      platform,
      architecture,
      uid,
      homeDir,
      fsImpl,
    });
    verification = {
      ...verifyLiveService({
        receipt: hostReceipt,
        targetPath: paths.targetPath,
        hostname,
        nowMs: now().getTime(),
        requireDurability: false,
      }),
      hostReceipt,
    };
    requireCondition(
      verification.valid,
      "HOST_DURABILITY_POST_ROLLBACK_VERIFICATION_FAILED",
    );
  } catch (error) {
    errorCode = error?.code || "HOST_DURABILITY_ROLLBACK_FAILED";
    if (mutationStarted && paths) {
      const serviceDomainRoot = `gui/${uid}`;
      rollback = restorePriorService({
        priorContent: currentContent,
        targetPath: paths.targetPath,
        launchAgents: paths.launchAgents,
        serviceDomainRoot,
        serviceDomain: `${serviceDomainRoot}/${HOST_SERVICE_LABEL}`,
        run,
        fsImpl,
        nonce,
        commandReceipts,
      });
    }
  }
  return buildMutationReceipt({
    action: "rollback",
    startedAt,
    completedAt: now().toISOString(),
    hostname,
    uid,
    targetPath: paths?.targetPath || "",
    backup,
    sourceBackup,
    priorPlistSha256:
      currentContent === null ? null : sha256(currentContent),
    commandReceipts,
    verification,
    rollback,
    mutationStarted,
    success: errorCode === null,
    errorCode,
  });
}

function collectHostDurabilityReceipt({
  run = spawnSync,
  now = defaultNow,
  hostname = os.hostname(),
  platform = process.platform,
  architecture = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  homeDir = os.homedir(),
  fsImpl = fs,
} = {}) {
  const expectedPlistPath = path.join(
    homeDir,
    HOST_SERVICE_PLIST_SUFFIX,
  );
  const servicePlistEvidence = readExactServicePlistEvidence({
    expectedPath: expectedPlistPath,
    fsImpl,
  });
  if (platform !== "darwin") {
    return buildHostDurabilityReceipt({
      observedAt: now().toISOString(),
      hostname,
      platform,
      architecture,
      uid,
      expectedPlistPath,
      servicePlistEvidence,
    });
  }
  const battery = fixedCommand("/usr/bin/pmset", ["-g", "batt"], run);
  const settings = fixedCommand("/usr/bin/pmset", ["-g", "custom"], run);
  const assertions = fixedCommand("/usr/bin/pmset", ["-g", "assertions"], run);
  const clamshell = fixedCommand(
    "/usr/sbin/ioreg",
    ["-r", "-k", "AppleClamshellState", "-d", "1"],
    run,
  );
  const serviceDomain = `gui/${uid}/${HOST_SERVICE_LABEL}`;
  const service = fixedCommand(
    "/bin/launchctl",
    ["print", serviceDomain],
    run,
  );
  const outputOrFailure = (result) =>
    result.status === 0 && !result.signal && !result.timedOut
      ? result.stdout
      : `${result.stdout}\n${result.stderr}\nstatus=${result.status};signal=${result.signal};timedOut=${result.timedOut}`;
  return buildHostDurabilityReceipt({
    observedAt: now().toISOString(),
    hostname,
    platform,
    architecture,
    uid,
    batteryOutput: outputOrFailure(battery),
    pmsetOutput: outputOrFailure(settings),
    assertionsOutput: outputOrFailure(assertions),
    clamshellOutput: outputOrFailure(clamshell),
    launchctlOutput: outputOrFailure(service),
    expectedPlistPath,
    servicePlistEvidence,
  });
}

function runHostDurabilityCli({
  collect = collectHostDurabilityReceipt,
  validate = validateHostDurabilityReceipt,
  write = writeStdout,
} = {}) {
  const receipt = collect();
  const validation = validate(receipt);
  write(`${JSON.stringify({ receipt, validation }, null, 2)}\n`);
  return validation.valid ? 0 : 2;
}

function runHostDurabilityCommandCli({
  argv = process.argv.slice(2),
  status = runHostDurabilityCli,
  install = installHostDurabilityService,
  rollback = rollbackHostDurabilityService,
  context = {},
  write = writeStdout,
} = {}) {
  const command = argv[0] || "status";
  if (
    command === "status" &&
    (argv.length === 0 || argv.length === 1)
  ) {
    return status({
      write,
      ...(isObject(context.status) ? context.status : {}),
    });
  }
  let receipt = null;
  if (
    command === "install" &&
    argv.length === 3 &&
    argv[1] === "--authorize-local-host"
  ) {
    receipt = install({
      ...(isObject(context.install) ? context.install : {}),
      authorization: argv[2],
    });
  } else if (
    command === "rollback" &&
    argv.length === 5 &&
    argv[1] === "--backup-sha256" &&
    argv[3] === "--authorize-local-host"
  ) {
    receipt = rollback({
      ...(isObject(context.rollback) ? context.rollback : {}),
      backupSha256: argv[2],
      authorization: argv[4],
    });
  } else {
    write(
      `${JSON.stringify({
        schema: "pikiio-host-durability-cli-refusal-v1",
        success: false,
        errorCode: "HOST_DURABILITY_CLI_USAGE_INVALID",
      }, null, 2)}\n`,
    );
    return 64;
  }
  const validation = validateHostDurabilityMutationReceipt(receipt);
  write(`${JSON.stringify({ receipt, validation }, null, 2)}\n`);
  return receipt.success === true && validation.valid ? 0 : 2;
}

module.exports = {
  AUTHORIZATION_PREFIX,
  COMMAND_TIMEOUT_MS,
  HOST_SERVICE_BACKUP_DIRECTORY,
  HOST_SERVICE_ARGUMENTS,
  HOST_SERVICE_LABEL,
  HOST_SERVICE_PLIST,
  HOST_SERVICE_PLIST_BYTE_LENGTH,
  HOST_SERVICE_PLIST_NAME,
  HOST_SERVICE_PLIST_SHA256,
  HOST_SERVICE_PLIST_SUFFIX,
  HOST_SERVICE_PROGRAM,
  HOST_SERVICE_SOURCE_PATH,
  MAXIMUM_RECEIPT_AGE_MS,
  MAXIMUM_HOST_SERVICE_PLIST_BYTES,
  HostDurabilityError,
  assertLocalHostAuthorization,
  assertPathWithin,
  atomicWriteRegularFile,
  backupExistingPlist,
  buildHostDurabilityReceipt,
  buildLocalHostAuthorizationToken,
  buildMutationReceipt,
  collectHostDurabilityReceipt,
  commandReceipt,
  ensureSafeDirectory,
  exactHostBlockers,
  fixedCommand,
  hashWithoutField,
  installHostDurabilityService,
  parseBatterySummary,
  parseClamshellState,
  parseLaunchctlPrint,
  parsePmsetCustom,
  parsePowerAssertions,
  readCanonicalServicePlist,
  readExactServicePlistEvidence,
  readSafeBackup,
  readSafeRegularFile,
  resolveSafeServicePaths,
  restorePriorService,
  rollbackHostDurabilityService,
  runHostDurabilityCommandCli,
  runHostDurabilityCli,
  safeLstat,
  sha256,
  stableJson,
  validateHostDurabilityMutationReceipt,
  validateHostDurabilityReceipt,
  verifyLiveService,
};
