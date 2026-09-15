"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  HOST_SERVICE_BACKUP_DIRECTORY,
  HOST_SERVICE_ARGUMENTS,
  HOST_SERVICE_LABEL,
  HOST_SERVICE_PLIST,
  HOST_SERVICE_PLIST_BYTE_LENGTH,
  HOST_SERVICE_PLIST_NAME,
  HOST_SERVICE_PLIST_SHA256,
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
  fixedCommand,
  installHostDurabilityService,
  parseBatterySummary,
  parseClamshellState,
  parseLaunchctlPrint,
  parsePmsetCustom,
  parsePowerAssertions,
  readCanonicalServicePlist,
  readExactServicePlistEvidence,
  readSafeBackup,
  resolveSafeServicePaths,
  restorePriorService,
  rollbackHostDurabilityService,
  runHostDurabilityCommandCli,
  runHostDurabilityCli,
  safeLstat,
  sha256,
  validateHostDurabilityMutationReceipt,
  validateHostDurabilityReceipt,
  verifyLiveService,
} = require("../lib/pikiio-host-durability");

const NOW = Date.parse("2026-07-24T08:00:00.000Z");

function launchctlFixture(overrides = {}) {
  const args = overrides.arguments || HOST_SERVICE_ARGUMENTS;
  return [
    `gui/501/${HOST_SERVICE_LABEL} = {`,
    `\tpath = ${overrides.path || `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`}`,
    `\tstate = ${overrides.state || "running"}`,
    `\tprogram = ${overrides.program || "/usr/bin/caffeinate"}`,
    "\targuments = {",
    ...args.map((argument) => `\t\t${argument}`),
    "\t}",
    ...(overrides.pid === null
      ? []
      : [`\tpid = ${overrides.pid === undefined ? 4242 : overrides.pid}`]),
    `\tlast exit code = ${overrides.lastExitCode || 0}`,
    "}",
    "",
  ].join("\n");
}

function readyReceipt(overrides = {}) {
  const expectedPlistPath =
    overrides.expectedPlistPath ||
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  const servicePlistEvidence =
    overrides.servicePlistEvidence || {
      expectedPath: expectedPlistPath,
      resolvedPath: expectedPlistPath,
      readable: true,
      regular: true,
      symlink: false,
      byteLength: HOST_SERVICE_PLIST_BYTE_LENGTH,
      sha256: HOST_SERVICE_PLIST_SHA256,
      maximumBytes: MAXIMUM_HOST_SERVICE_PLIST_BYTES,
      errorCode: null,
    };
  return buildHostDurabilityReceipt({
    observedAt: new Date(NOW).toISOString(),
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    batteryOutput:
      overrides.batteryOutput ||
      "Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged;",
    pmsetOutput:
      overrides.pmsetOutput ||
      "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n womp 1\n",
    assertionsOutput:
      overrides.assertionsOutput ||
      [
        "Assertion status system-wide:",
        "   PreventSystemSleep             1",
        "   PreventUserIdleSystemSleep     1",
        "Listed by owning process:",
        "   pid 4242(caffeinate): [0x1] PreventSystemSleep named: \"caffeinate command-line tool\"",
        "   pid 4242(caffeinate): [0x2] PreventUserIdleSystemSleep named: \"caffeinate command-line tool\"",
      ].join("\n"),
    clamshellOutput:
      overrides.clamshellOutput ||
      '  |   "AppleClamshellState" = No\n',
    launchctlOutput:
      overrides.launchctlOutput || launchctlFixture(overrides.launchctl || {}),
    expectedPlistPath,
    servicePlistEvidence,
    ...overrides.receipt,
  });
}

function temporaryHome(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const homeDir = fs.mkdtempSync(
    path.join(temporaryRoot, "pikiio-host-durability-"),
  );
  t.after(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  return homeDir;
}

function servicePaths(homeDir) {
  const launchAgents = path.join(homeDir, "Library", "LaunchAgents");
  return {
    launchAgents,
    backupDirectory: path.join(
      launchAgents,
      HOST_SERVICE_BACKUP_DIRECTORY,
    ),
    targetPath: path.join(launchAgents, HOST_SERVICE_PLIST_NAME),
  };
}

function prepareTarget(homeDir, content = null) {
  const paths = servicePaths(homeDir);
  fs.mkdirSync(paths.backupDirectory, { recursive: true, mode: 0o700 });
  if (content !== null) {
    fs.writeFileSync(paths.targetPath, content, { mode: 0o600 });
  }
  return paths;
}

function fakeHostCommands({
  targetPath,
  initiallyLoaded = false,
  failOnce = {},
  printedPath = targetPath,
  assertionsPid = 4242,
} = {}) {
  let loaded = initiallyLoaded;
  const calls = [];
  const remainingFailures = new Map(Object.entries(failOnce));
  const fail = (key) => {
    const remaining = Number(remainingFailures.get(key) || 0);
    if (remaining < 1) return false;
    remainingFailures.set(key, remaining - 1);
    return true;
  };
  const run = (command, args, options) => {
    const key = [command, ...args].join(" ");
    calls.push({ command, args: [...args], options });
    if (fail(key)) {
      return {
        status: 70,
        signal: null,
        stdout: "",
        stderr: "injected failure",
      };
    }
    if (command === "/bin/launchctl") {
      if (args[0] === "print") {
        if (!loaded) {
          return {
            status: 113,
            signal: null,
            stdout: "",
            stderr: "Could not find service",
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: launchctlFixture({ path: printedPath }),
          stderr: "",
        };
      }
      if (args[0] === "bootout") {
        loaded = false;
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap") {
        loaded = true;
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "kickstart") {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
    }
    const output = new Map([
      [
        "/usr/bin/pmset -g batt",
        "Now drawing from 'AC Power'\n100%; charged;",
      ],
      [
        "/usr/bin/pmset -g custom",
        "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n womp 1\n",
      ],
      [
        "/usr/bin/pmset -g assertions",
        [
          "PreventSystemSleep 1",
          "PreventUserIdleSystemSleep 1",
          `pid ${assertionsPid}(caffeinate): PreventSystemSleep`,
          `pid ${assertionsPid}(caffeinate): PreventUserIdleSystemSleep`,
        ].join("\n"),
      ],
      [
        "/usr/sbin/ioreg -r -k AppleClamshellState -d 1",
        '"AppleClamshellState" = No',
      ],
    ]).get(key);
    return {
      status: output === undefined ? 64 : 0,
      signal: null,
      stdout: output || "",
      stderr: output === undefined ? "unexpected command" : "",
    };
  };
  return {
    run,
    calls,
    isLoaded: () => loaded,
  };
}

function installAuthorization() {
  return buildLocalHostAuthorizationToken({
    action: "install",
    hostname: "operator-mac",
    uid: 501,
  });
}

function fixedNow() {
  return new Date(NOW);
}

test("ready host receipt is content-addressed and validates", () => {
  const receipt = readyReceipt();
  assert.equal(receipt.ready, true);
  assert.deepEqual(receipt.blockers, []);
  assert.equal(
    validateHostDurabilityReceipt(receipt, {
      nowMs: NOW,
      localHost: "operator-mac",
    }).valid,
    true,
  );
});

test("battery and pmset parsers preserve exact source hashes", () => {
  assert.deepEqual(parseBatterySummary("Now drawing from 'Battery Power'\n50%"), {
    source: "battery",
    batteryPercent: 50,
    charged: false,
    summarySha256:
      "4f706bfb6cb0073e1101e9ba40f1cd3366fd737c0caacc797acc1d1880fe0bf6",
  });
  assert.deepEqual(parseBatterySummary("unavailable").source, "unknown");
  assert.deepEqual(parsePmsetCustom("AC Power:\n sleep 0\n powernap 1\n womp 0\n"), {
    acSleepMinutes: 0,
    acPowerNap: 1,
    acWakeOnLan: 0,
    settingsSha256:
      "2e09d3c6fc2567837cf5aa4e6e95cfb7c40bfac89a8933a44958d433cdfd63b5",
  });
  assert.equal(parsePmsetCustom("unavailable").acSleepMinutes, null);
});

test("readiness requires a parseable AC sleep policy in addition to live assertions", () => {
  const receipt = readyReceipt({
    pmsetOutput: "Battery Power:\n sleep 1\n",
  });
  assert.equal(receipt.ready, false);
  assert.deepEqual(receipt.blockers, ["HOST_SLEEP_POLICY_UNREADABLE"]);
  const validation = validateHostDurabilityReceipt(receipt, {
    nowMs: NOW,
    localHost: "operator-mac",
  });
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.includes(
      "host durability is not ready for unattended activation",
    ),
  );
});

test("clamshell parser distinguishes open closed and unknown", () => {
  assert.equal(parseClamshellState('"AppleClamshellState" = No').open, true);
  assert.equal(parseClamshellState('"AppleClamshellState" = Yes').open, false);
  assert.equal(parseClamshellState('"AppleClamshellState" = false').open, true);
  assert.equal(parseClamshellState("unavailable").open, null);
});

test("power assertion parser binds the system assertion to caffeinate", () => {
  const parsed = parsePowerAssertions([
    "Assertion status system-wide:",
    "   PreventSystemSleep             1",
    "   PreventUserIdleSystemSleep     1",
    "Listed by owning process:",
    "   pid 4242(caffeinate): [0x1] PreventSystemSleep named: \"caffeinate command-line tool\"",
    "   pid 4242(caffeinate): [0x2] PreventUserIdleSystemSleep named: \"caffeinate command-line tool\"",
  ].join("\n"));
  assert.equal(parsed.preventSystemSleep, true);
  assert.equal(parsed.preventIdleSystemSleep, true);
  assert.equal(parsed.caffeinateOwnerPid, 4242);
  assert.equal(parsed.caffeinatePreventSystemSleepPid, 4242);
  assert.equal(parsed.caffeinatePreventIdleSystemSleepPid, 4242);
  assert.match(parsed.assertionsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsePowerAssertions("unavailable"), {
    preventSystemSleep: false,
    preventIdleSystemSleep: false,
    caffeinateOwnerPid: null,
    caffeinatePreventSystemSleepPid: null,
    caffeinatePreventIdleSystemSleepPid: null,
    assertionsSha256:
      "ba691ba042bcedd9a61a36f5969026bc95859dccdc7e47f24e6bce35673baf2f",
  });
});

test("launchctl parser extracts only explicit service evidence", () => {
  const parsed = parseLaunchctlPrint(launchctlFixture());
  assert.equal(parsed.state, "running");
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.program, "/usr/bin/caffeinate");
  assert.deepEqual(parsed.arguments, HOST_SERVICE_ARGUMENTS);
  assert.match(parsed.path, /Library\/LaunchAgents/);
  assert.equal(parsed.lastExitCode, 0);
  assert.match(parsed.launchctlSha256, /^[a-f0-9]{64}$/);
  const missing = parseLaunchctlPrint("service not found");
  assert.equal(missing.state, "unknown");
  assert.equal(missing.pid, null);
  assert.deepEqual(missing.arguments, []);
});

for (const [name, overrides, blocker] of [
  [
    "battery power",
    { batteryOutput: "Now drawing from 'Battery Power'\n100%" },
    "HOST_NOT_ON_AC_POWER",
  ],
  [
    "stopped service",
    { launchctl: { state: "not running", pid: null } },
    "HOST_KEEP_AWAKE_SERVICE_NOT_RUNNING",
  ],
  [
    "missing PID",
    { launchctl: { pid: null } },
    "HOST_KEEP_AWAKE_PID_INVALID",
  ],
  [
    "wrong executable",
    { launchctl: { program: "/tmp/caffeinate" } },
    "HOST_KEEP_AWAKE_PROGRAM_MISMATCH",
  ],
  [
    "wrong arguments",
    { launchctl: { arguments: ["/usr/bin/caffeinate", "-d"] } },
    "HOST_KEEP_AWAKE_ARGUMENTS_MISMATCH",
  ],
  [
    "wrong plist",
    { launchctl: { path: "/tmp/not-pikiio.plist" } },
    "HOST_KEEP_AWAKE_PLIST_MISMATCH",
  ],
  [
    "missing sleep assertion",
    { assertionsOutput: "PreventSystemSleep 0\nPreventUserIdleSystemSleep 1" },
    "HOST_KEEP_AWAKE_ASSERTION_MISSING",
  ],
  [
    "wrong assertion owner",
    {
      assertionsOutput:
        "PreventSystemSleep 1\nPreventUserIdleSystemSleep 1\npid 999(caffeinate): PreventSystemSleep\npid 999(caffeinate): PreventUserIdleSystemSleep",
    },
    "HOST_KEEP_AWAKE_ASSERTION_OWNER_MISMATCH",
  ],
]) {
  test(`${name} refuses unattended readiness`, () => {
    const receipt = readyReceipt(overrides);
    assert.equal(receipt.ready, false);
    assert.ok(receipt.blockers.includes(blocker));
    const validation = validateHostDurabilityReceipt(receipt, {
      nowMs: NOW,
      localHost: "operator-mac",
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.blockers.includes(blocker));
  });
}

test("unsupported platform cannot claim unattended readiness", () => {
  const receipt = readyReceipt({
    receipt: { platform: "linux" },
  });
  assert.ok(receipt.blockers.includes("HOST_PLATFORM_UNSUPPORTED"));
});

test("receipt hash, readiness, source digests, and hostname fail closed", () => {
  const cases = [
    (receipt) => {
      receipt.receiptHash = "0".repeat(64);
    },
    (receipt) => {
      receipt.ready = false;
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.power.summarySha256 = "no";
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.schema = "wrong";
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.service = null;
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.servicePlist = null;
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.servicePlist.readable = false;
      receipt.servicePlist.errorCode = "injected";
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.servicePlist.sha256 = "invalid";
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
    (receipt) => {
      receipt.servicePlist.maximumBytes = 1;
      receipt.receiptHash = require("../lib/pikiio-host-durability")
        .hashWithoutField(receipt);
    },
  ];
  for (const mutate of cases) {
    const receipt = readyReceipt();
    mutate(receipt);
    assert.equal(
      validateHostDurabilityReceipt(receipt, {
        nowMs: NOW,
        localHost: "operator-mac",
      }).valid,
      false,
    );
  }
  assert.equal(
    validateHostDurabilityReceipt(readyReceipt(), {
      nowMs: NOW,
      localHost: "different-host",
    }).valid,
    false,
  );
  assert.equal(
    validateHostDurabilityReceipt(null, {
      nowMs: NOW,
      localHost: "operator-mac",
    }).valid,
    false,
  );
});

test("future and stale receipts are refused", () => {
  const future = readyReceipt({
    receipt: { observedAt: new Date(NOW + 1).toISOString() },
  });
  const stale = readyReceipt({
    receipt: {
      observedAt: new Date(NOW - MAXIMUM_RECEIPT_AGE_MS - 1).toISOString(),
    },
  });
  for (const receipt of [future, stale]) {
    assert.equal(
      validateHostDurabilityReceipt(receipt, {
        nowMs: NOW,
        localHost: "operator-mac",
      }).valid,
      false,
    );
  }
});

test("fixed commands use a finite scrubbed environment", () => {
  let observed = null;
  const result = fixedCommand("/bin/example", ["status"], (command, args, options) => {
    observed = { command, args, options };
    return { status: 0, signal: null, stdout: "ok", stderr: "" };
  });
  assert.equal(result.status, 0);
  assert.deepEqual(Object.keys(observed.options.env).sort(), [
    "LANG",
    "LC_ALL",
    "PATH",
  ]);
  assert.equal(observed.options.timeout, 5_000);
  assert.equal(observed.command, "/bin/example");
  assert.deepEqual(observed.args, ["status"]);
});

test("collector invokes only fixed host evidence commands", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  const calls = [];
  const outputs = new Map([
    ["/usr/bin/pmset -g batt", "Now drawing from 'AC Power'\n100%; charged;"],
    [
      "/usr/bin/pmset -g custom",
      "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n womp 1\n",
    ],
    [
      "/usr/bin/pmset -g assertions",
      "PreventSystemSleep 1\nPreventUserIdleSystemSleep 1\npid 4242(caffeinate): PreventSystemSleep\npid 4242(caffeinate): PreventUserIdleSystemSleep",
    ],
    [
      "/usr/sbin/ioreg -r -k AppleClamshellState -d 1",
      '"AppleClamshellState" = No',
    ],
    [
      `/bin/launchctl print gui/501/${HOST_SERVICE_LABEL}`,
      launchctlFixture({ path: paths.targetPath }),
    ],
  ]);
  const run = (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    return {
      status: 0,
      signal: null,
      stdout: outputs.get(key) || "",
      stderr: "",
    };
  };
  const receipt = collectHostDurabilityReceipt({
    run,
    now: () => new Date(NOW),
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    homeDir,
  });
  assert.deepEqual(calls, [...outputs.keys()]);
  assert.equal(receipt.ready, true);
});

test("collector records command failures as blockers without inventing state", () => {
  const receipt = collectHostDurabilityReceipt({
    run: () => ({
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "refused",
      error: { code: "ETIMEDOUT" },
    }),
    now: () => new Date(NOW),
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
  });
  assert.equal(receipt.ready, false);
  assert.ok(receipt.blockers.length >= 4);
});

test("non-darwin collection performs no commands and remains blocked", () => {
  let calls = 0;
  const receipt = collectHostDurabilityReceipt({
    run: () => {
      calls += 1;
      return {};
    },
    now: () => new Date(NOW),
    hostname: "host",
    platform: "linux",
    architecture: "x64",
    uid: 501,
  });
  assert.equal(calls, 0);
  assert.equal(receipt.ready, false);
  assert.ok(receipt.blockers.includes("HOST_PLATFORM_UNSUPPORTED"));
});

test("decision-free CLI adapter emits one receipt and preserves refusal status", () => {
  const receipt = readyReceipt();
  let output = "";
  assert.equal(
    runHostDurabilityCli({
      collect: () => receipt,
      validate: () => ({ valid: true, errors: [], blockers: [] }),
      write: (value) => {
        output += value;
      },
    }),
    0,
  );
  assert.equal(JSON.parse(output).receipt.receiptHash, receipt.receiptHash);
  output = "";
  assert.equal(
    runHostDurabilityCli({
      collect: () => receipt,
      validate: () => ({ valid: false, errors: ["blocked"], blockers: ["x"] }),
      write: (value) => {
        output += value;
      },
    }),
    2,
  );
  assert.deepEqual(JSON.parse(output).validation.errors, ["blocked"]);
});

test("canonical launch agent is exact, minimal, and content-addressed", () => {
  const content = readCanonicalServicePlist();
  assert.equal(content.toString(), HOST_SERVICE_PLIST);
  assert.equal(sha256(content), HOST_SERVICE_PLIST_SHA256);
  assert.match(HOST_SERVICE_PLIST, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(HOST_SERVICE_PLIST, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.doesNotMatch(
    HOST_SERVICE_PLIST,
    /Standard(?:Out|Error)Path|EnvironmentVariables|http|socket|token|secret/i,
  );
});

test("status evidence securely binds the canonical on-disk plist", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  let observedFlags = null;
  const observingFs = Object.create(fs);
  observingFs.openSync = (targetPath, flags, ...rest) => {
    observedFlags = flags;
    return fs.openSync(targetPath, flags, ...rest);
  };
  const evidence = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
    fsImpl: observingFs,
  });
  assert.deepEqual(evidence, {
    expectedPath: paths.targetPath,
    resolvedPath: paths.targetPath,
    readable: true,
    regular: true,
    symlink: false,
    byteLength: HOST_SERVICE_PLIST_BYTE_LENGTH,
    sha256: HOST_SERVICE_PLIST_SHA256,
    maximumBytes: MAXIMUM_HOST_SERVICE_PLIST_BYTES,
    errorCode: null,
  });
  assert.notEqual(observedFlags & fs.constants.O_NOFOLLOW, 0);
  assert.notEqual(observedFlags & fs.constants.O_NONBLOCK, 0);
  const receipt = readyReceipt({
    expectedPlistPath: paths.targetPath,
    launchctl: { path: paths.targetPath },
    servicePlistEvidence: evidence,
  });
  assert.equal(receipt.ready, true);
  assert.deepEqual(receipt.blockers, []);
  assert.equal(
    validateHostDurabilityReceipt(receipt, {
      nowMs: NOW,
      localHost: "operator-mac",
    }).valid,
    true,
  );
});

test("status evidence rejects symlinks and non-regular paths", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir);
  const canonicalCopy = path.join(homeDir, "canonical-copy.plist");
  fs.writeFileSync(canonicalCopy, HOST_SERVICE_PLIST);
  fs.symlinkSync(canonicalCopy, paths.targetPath);
  const symlink = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
  });
  assert.equal(symlink.readable, false);
  assert.equal(symlink.symlink, true);
  assert.equal(
    symlink.errorCode,
    "HOST_KEEP_AWAKE_PLIST_SYMLINK_REFUSED",
  );
  fs.unlinkSync(paths.targetPath);
  fs.mkdirSync(paths.targetPath);
  const directory = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
  });
  assert.equal(directory.readable, false);
  assert.equal(
    directory.errorCode,
    "HOST_KEEP_AWAKE_PLIST_NOT_REGULAR",
  );
});

test("status evidence refuses unreadable and missing plists", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  const unreadableFs = Object.create(fs);
  unreadableFs.openSync = () => {
    const error = new Error("injected access refusal");
    error.code = "EACCES";
    throw error;
  };
  const unreadable = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
    fsImpl: unreadableFs,
  });
  assert.equal(unreadable.readable, false);
  assert.equal(
    unreadable.errorCode,
    "HOST_KEEP_AWAKE_PLIST_UNREADABLE",
  );
  fs.unlinkSync(paths.targetPath);
  const missing = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
  });
  assert.equal(missing.readable, false);
  assert.equal(
    missing.errorCode,
    "HOST_KEEP_AWAKE_PLIST_UNREADABLE",
  );
});

test("status evidence enforces its hard byte bound before opening", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(
    homeDir,
    Buffer.alloc(MAXIMUM_HOST_SERVICE_PLIST_BYTES + 1, 0x61),
  );
  let opens = 0;
  const boundedFs = Object.create(fs);
  boundedFs.openSync = (...args) => {
    opens += 1;
    return fs.openSync(...args);
  };
  const oversized = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
    fsImpl: boundedFs,
  });
  assert.equal(opens, 0);
  assert.equal(oversized.readable, false);
  assert.equal(oversized.regular, true);
  assert.equal(
    oversized.byteLength,
    MAXIMUM_HOST_SERVICE_PLIST_BYTES + 1,
  );
  assert.equal(
    oversized.errorCode,
    "HOST_KEEP_AWAKE_PLIST_OVERSIZED",
  );
});

test("status evidence catches a path swap after O_NOFOLLOW open", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  const replacementPath = path.join(homeDir, "replacement.plist");
  const originalPath = path.join(homeDir, "opened-original.plist");
  fs.writeFileSync(replacementPath, HOST_SERVICE_PLIST);
  let targetLstats = 0;
  const swappingFs = Object.create(fs);
  swappingFs.lstatSync = (targetPath) => {
    if (targetPath === paths.targetPath) {
      targetLstats += 1;
      if (targetLstats === 2) {
        fs.renameSync(paths.targetPath, originalPath);
        fs.renameSync(replacementPath, paths.targetPath);
      }
    }
    return fs.lstatSync(targetPath);
  };
  const evidence = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
    fsImpl: swappingFs,
  });
  assert.equal(evidence.readable, false);
  assert.equal(
    evidence.errorCode,
    "HOST_KEEP_AWAKE_PLIST_TOCTOU_DETECTED",
  );
  assert.equal(targetLstats, 2);
});

test("status evidence rejects invalid bounds and pre-open identity drift", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  for (const [expectedPath, maximumBytes, errorCode] of [
    [
      "relative.plist",
      MAXIMUM_HOST_SERVICE_PLIST_BYTES,
      "HOST_KEEP_AWAKE_PLIST_PATH_INVALID",
    ],
    [
      paths.targetPath,
      HOST_SERVICE_PLIST_BYTE_LENGTH - 1,
      "HOST_KEEP_AWAKE_PLIST_BOUND_INVALID",
    ],
    [
      paths.targetPath,
      MAXIMUM_HOST_SERVICE_PLIST_BYTES + 1,
      "HOST_KEEP_AWAKE_PLIST_BOUND_INVALID",
    ],
  ]) {
    assert.equal(
      readExactServicePlistEvidence({
        expectedPath,
        maximumBytes,
      }).errorCode,
      errorCode,
    );
  }

  const resolvingFs = Object.create(fs);
  resolvingFs.realpathSync = () => "/tmp/different.plist";
  assert.equal(
    readExactServicePlistEvidence({
      expectedPath: paths.targetPath,
      fsImpl: resolvingFs,
    }).errorCode,
    "HOST_KEEP_AWAKE_PLIST_RESOLUTION_MISMATCH",
  );

  const driftingFs = Object.create(fs);
  let fstats = 0;
  driftingFs.fstatSync = (fileDescriptor) => {
    const stat = fs.fstatSync(fileDescriptor);
    fstats += 1;
    return fstats === 1
      ? new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return Number(target.ino) + 1;
            return Reflect.get(target, property);
          },
        })
      : stat;
  };
  assert.equal(
    readExactServicePlistEvidence({
      expectedPath: paths.targetPath,
      fsImpl: driftingFs,
    }).errorCode,
    "HOST_KEEP_AWAKE_PLIST_TOCTOU_DETECTED",
  );
});

test("status evidence rejects descriptor type changes and read-time growth", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  const nonRegularFs = Object.create(fs);
  nonRegularFs.fstatSync = (fileDescriptor) => {
    const stat = fs.fstatSync(fileDescriptor);
    return new Proxy(stat, {
      get(target, property) {
        if (property === "isFile") return () => false;
        return Reflect.get(target, property);
      },
    });
  };
  assert.equal(
    readExactServicePlistEvidence({
      expectedPath: paths.targetPath,
      fsImpl: nonRegularFs,
    }).errorCode,
    "HOST_KEEP_AWAKE_PLIST_NOT_REGULAR",
  );

  const growingFs = Object.create(fs);
  growingFs.readSync = (
    _fileDescriptor,
    buffer,
    offset,
    length,
  ) => {
    buffer.fill(0x61, offset, offset + length);
    return length;
  };
  assert.equal(
    readExactServicePlistEvidence({
      expectedPath: paths.targetPath,
      fsImpl: growingFs,
    }).errorCode,
    "HOST_KEEP_AWAKE_PLIST_OVERSIZED",
  );
});

test("wrong on-disk bytes and forged plist metadata cannot become ready", (t) => {
  const homeDir = temporaryHome(t);
  const wrongBytes = Buffer.from(HOST_SERVICE_PLIST);
  wrongBytes[wrongBytes.length - 2] ^= 1;
  const paths = prepareTarget(homeDir, wrongBytes);
  const wrongEvidence = readExactServicePlistEvidence({
    expectedPath: paths.targetPath,
  });
  assert.equal(wrongEvidence.readable, true);
  assert.equal(wrongEvidence.byteLength, HOST_SERVICE_PLIST_BYTE_LENGTH);
  assert.notEqual(wrongEvidence.sha256, HOST_SERVICE_PLIST_SHA256);
  for (const servicePlistEvidence of [
    wrongEvidence,
    {
      ...wrongEvidence,
      sha256: HOST_SERVICE_PLIST_SHA256,
      byteLength: HOST_SERVICE_PLIST_BYTE_LENGTH + 1,
    },
    {
      ...wrongEvidence,
      sha256: HOST_SERVICE_PLIST_SHA256,
      resolvedPath: "/tmp/foreign.plist",
    },
  ]) {
    const receipt = readyReceipt({
      expectedPlistPath: paths.targetPath,
      launchctl: { path: paths.targetPath },
      servicePlistEvidence,
    });
    assert.equal(receipt.ready, false);
    assert.ok(
      receipt.blockers.includes(
        "HOST_KEEP_AWAKE_PLIST_CONTENT_MISMATCH",
      ),
    );
    assert.equal(
      validateHostDurabilityReceipt(receipt, {
        nowMs: NOW,
        localHost: "operator-mac",
      }).valid,
      false,
    );
  }
});

test("unavailable plist evidence remains structurally bound and blocked", () => {
  const expectedPlistPath =
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  const receipt = buildHostDurabilityReceipt({
    observedAt: new Date(NOW).toISOString(),
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    batteryOutput: "Now drawing from 'AC Power'",
    assertionsOutput:
      "PreventSystemSleep 1\nPreventUserIdleSystemSleep 1",
    launchctlOutput: launchctlFixture({ path: expectedPlistPath }),
    expectedPlistPath,
  });
  assert.equal(receipt.servicePlist.byteLength, null);
  assert.equal(receipt.servicePlist.sha256, null);
  assert.equal(receipt.ready, false);
  assert.ok(
    receipt.blockers.includes(
      "HOST_KEEP_AWAKE_PLIST_EVIDENCE_UNAVAILABLE",
    ),
  );
});

test("canonical source rejects aliases, mismatches, and relative paths", (t) => {
  const homeDir = temporaryHome(t);
  const copy = path.join(homeDir, "copy.plist");
  const alias = path.join(homeDir, "alias.plist");
  fs.writeFileSync(copy, `${HOST_SERVICE_PLIST}<!-- changed -->`);
  fs.symlinkSync(HOST_SERVICE_SOURCE_PATH, alias);
  assert.throws(
    () => readCanonicalServicePlist({ sourcePath: copy }),
    (error) => error.code === "HOST_DURABILITY_SOURCE_CONTENT_MISMATCH",
  );
  assert.throws(
    () => readCanonicalServicePlist({ sourcePath: alias }),
    (error) => error.code === "HOST_DURABILITY_FILE_UNSAFE",
  );
  assert.throws(
    () => readCanonicalServicePlist({ sourcePath: "relative.plist" }),
    (error) => error.code === "HOST_DURABILITY_SOURCE_PATH_INVALID",
  );
  assert.throws(
    () =>
      readCanonicalServicePlist({
        sourcePath: path.join(homeDir, "missing.plist"),
      }),
    (error) => error.code === "HOST_DURABILITY_FILE_MISSING",
  );
});

test("local-host authorization is exact and binds action, host, uid, and bytes", () => {
  const installToken = installAuthorization();
  assert.match(
    installToken,
    new RegExp(`${HOST_SERVICE_PLIST_SHA256}$`),
  );
  assert.equal(
    assertLocalHostAuthorization({
      action: "install",
      authorization: installToken,
      hostname: "operator-mac",
      uid: 501,
    }),
    installToken,
  );
  const backupSha256 = "a".repeat(64);
  const rollbackToken = buildLocalHostAuthorizationToken({
    action: "rollback",
    hostname: "operator-mac",
    uid: 501,
    backupSha256,
  });
  assert.match(rollbackToken, new RegExp(`${backupSha256}$`));
  for (const authorization of [
    "",
    `${installToken}x`,
    installToken.replace("operator-mac", "other-mac"),
    `é${installToken.slice(1)}`,
  ]) {
    assert.throws(
      () =>
        assertLocalHostAuthorization({
          action: "install",
          authorization,
          hostname: "operator-mac",
          uid: 501,
        }),
      (error) =>
        error.code === "HOST_DURABILITY_LOCAL_AUTHORIZATION_REQUIRED",
    );
  }
  for (const values of [
    { action: "erase", hostname: "host", uid: 1 },
    { action: "install", hostname: "bad host", uid: 1 },
    { action: "install", hostname: "host", uid: -1 },
    {
      action: "rollback",
      hostname: "host",
      uid: 1,
      backupSha256: "bad",
    },
    {
      action: "install",
      hostname: "host",
      uid: 1,
      backupSha256,
    },
  ]) {
    assert.throws(
      () => buildLocalHostAuthorizationToken(values),
      HostDurabilityError,
    );
  }
});

test("safe service paths create only fixed local directories", (t) => {
  const homeDir = temporaryHome(t);
  const resolved = resolveSafeServicePaths({ homeDir });
  assert.deepEqual(resolved, {
    realHome: homeDir,
    ...servicePaths(homeDir),
  });
  assert.equal(safeLstat(resolved.targetPath), null);
  assert.equal(fs.lstatSync(resolved.launchAgents).isDirectory(), true);
  assert.equal(
    ensureSafeDirectory(
      path.join(homeDir, "Library"),
      "LaunchAgents",
    ),
    resolved.launchAgents,
  );
  assert.throws(
    () => assertPathWithin(homeDir, homeDir),
    (error) => error.code === "HOST_DURABILITY_PATH_ESCAPE",
  );
  assert.throws(
    () => assertPathWithin(homeDir, path.dirname(homeDir)),
    (error) => error.code === "HOST_DURABILITY_PATH_ESCAPE",
  );
  assert.throws(
    () => ensureSafeDirectory(homeDir, "../escape"),
    (error) => error.code === "HOST_DURABILITY_DIRECTORY_INVALID",
  );
});

test("safe service paths reject symlinked homes, directories, and targets", (t) => {
  const homeDir = temporaryHome(t);
  const realDirectory = path.join(homeDir, "real");
  const linkedHome = path.join(homeDir, "linked-home");
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, linkedHome);
  assert.throws(
    () => resolveSafeServicePaths({ homeDir: linkedHome }),
    (error) => error.code === "HOST_DURABILITY_HOME_UNSAFE",
  );

  const secondHome = temporaryHome(t);
  fs.mkdirSync(path.join(secondHome, "elsewhere"));
  fs.symlinkSync(
    path.join(secondHome, "elsewhere"),
    path.join(secondHome, "Library"),
  );
  assert.throws(
    () => resolveSafeServicePaths({ homeDir: secondHome }),
    (error) => error.code === "HOST_DURABILITY_DIRECTORY_UNSAFE",
  );

  const thirdHome = temporaryHome(t);
  const paths = prepareTarget(thirdHome);
  const outside = path.join(thirdHome, "outside");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, paths.targetPath);
  assert.throws(
    () => resolveSafeServicePaths({ homeDir: thirdHome }),
    (error) => error.code === "HOST_DURABILITY_TARGET_UNSAFE",
  );

  const fourthHome = temporaryHome(t);
  const fourthLaunchAgents = path.join(
    fourthHome,
    "Library",
    "LaunchAgents",
  );
  fs.mkdirSync(fourthLaunchAgents, { recursive: true });
  fs.mkdirSync(path.join(fourthHome, "outside-backups"));
  fs.symlinkSync(
    path.join(fourthHome, "outside-backups"),
    path.join(fourthLaunchAgents, HOST_SERVICE_BACKUP_DIRECTORY),
  );
  assert.throws(
    () => resolveSafeServicePaths({ homeDir: fourthHome }),
    (error) => error.code === "HOST_DURABILITY_DIRECTORY_UNSAFE",
  );
  assert.throws(
    () => resolveSafeServicePaths({ homeDir: "relative" }),
    (error) => error.code === "HOST_DURABILITY_HOME_INVALID",
  );
});

test("content-addressed backup is immutable and collision-safe", (t) => {
  const homeDir = temporaryHome(t);
  const paths = resolveSafeServicePaths({ homeDir });
  assert.equal(
    backupExistingPlist({
      content: null,
      backupDirectory: paths.backupDirectory,
    }),
    null,
  );
  const content = Buffer.from("prior plist");
  const backup = backupExistingPlist({
    content,
    backupDirectory: paths.backupDirectory,
  });
  assert.equal(backup.sha256, sha256(content));
  assert.equal(fs.readFileSync(backup.path).toString(), "prior plist");
  assert.deepEqual(
    backupExistingPlist({
      content,
      backupDirectory: paths.backupDirectory,
    }),
    backup,
  );
  fs.writeFileSync(backup.path, "collision");
  assert.throws(
    () =>
      backupExistingPlist({
        content,
        backupDirectory: paths.backupDirectory,
      }),
    (error) => error.code === "HOST_DURABILITY_BACKUP_COLLISION",
  );
});

test("atomic writer replaces regular files and removes failed temporaries", (t) => {
  const homeDir = temporaryHome(t);
  const paths = resolveSafeServicePaths({ homeDir });
  fs.writeFileSync(paths.targetPath, "old");
  atomicWriteRegularFile({
    targetPath: paths.targetPath,
    launchAgents: paths.launchAgents,
    content: Buffer.from("new"),
  });
  assert.equal(fs.readFileSync(paths.targetPath, "utf8"), "new");
  assert.equal(
    fs.statSync(paths.targetPath).mode & 0o777,
    0o600,
  );
  const temporaryPath = path.join(
    paths.launchAgents,
    `.${HOST_SERVICE_PLIST_NAME}.collision.tmp`,
  );
  fs.writeFileSync(temporaryPath, "occupied");
  assert.throws(
    () =>
      atomicWriteRegularFile({
        targetPath: paths.targetPath,
        launchAgents: paths.launchAgents,
        content: Buffer.from("not-written"),
        nonce: () => "collision",
      }),
    /EEXIST/,
  );
  assert.equal(fs.readFileSync(paths.targetPath, "utf8"), "new");
  assert.equal(fs.readFileSync(temporaryPath, "utf8"), "occupied");
});

test("install atomically bootstraps and verifies both sleep assertions", (t) => {
  const homeDir = temporaryHome(t);
  const paths = servicePaths(homeDir);
  const fake = fakeHostCommands({ targetPath: paths.targetPath });
  const receipt = installHostDurabilityService({
    authorization: installAuthorization(),
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
    nonce: () => "install-success",
  });
  assert.equal(receipt.success, true);
  assert.equal(receipt.errorCode, null);
  assert.equal(receipt.mutationStarted, true);
  assert.equal(receipt.verification.valid, true);
  assert.equal(receipt.verification.hostReceipt.service.pid, 4242);
  assert.equal(
    receipt.verification.hostReceipt.assertions.preventSystemSleep,
    true,
  );
  assert.equal(
    receipt.verification.hostReceipt.assertions.preventIdleSystemSleep,
    true,
  );
  assert.equal(fs.readFileSync(paths.targetPath, "utf8"), HOST_SERVICE_PLIST);
  assert.equal(fake.isLoaded(), true);
  assert.equal(validateHostDurabilityMutationReceipt(receipt).valid, true);
  for (const call of fake.calls) {
    assert.deepEqual(Object.keys(call.options.env).sort(), [
      "LANG",
      "LC_ALL",
      "PATH",
    ]);
    assert.equal(call.options.timeout, 5_000);
  }
});

test("install backs up an existing plist before replacement", (t) => {
  const homeDir = temporaryHome(t);
  const prior = Buffer.from("prior launch agent");
  const paths = prepareTarget(homeDir, prior);
  const fake = fakeHostCommands({
    targetPath: paths.targetPath,
    initiallyLoaded: true,
  });
  const receipt = installHostDurabilityService({
    authorization: installAuthorization(),
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
    nonce: () => "replace-success",
  });
  assert.equal(receipt.success, true);
  assert.equal(receipt.priorPlistSha256, sha256(prior));
  assert.equal(receipt.backup.sha256, sha256(prior));
  assert.deepEqual(fs.readFileSync(receipt.backup.path), prior);
  assert.deepEqual(fs.readFileSync(paths.targetPath), Buffer.from(HOST_SERVICE_PLIST));
  assert.ok(
    fake.calls.some(
      ({ args }) =>
        args[0] === "bootout" &&
        args[2] === paths.targetPath,
    ),
  );
});

test("install refuses before mutation without exact authority or supported host", (t) => {
  const homeDir = temporaryHome(t);
  for (const options of [
    { authorization: "wrong", platform: "darwin" },
    { authorization: installAuthorization(), platform: "linux" },
  ]) {
    const receipt = installHostDurabilityService({
      ...options,
      homeDir,
      hostname: "operator-mac",
      architecture: "arm64",
      uid: 501,
      run: () => {
        throw new Error("must not execute");
      },
      now: fixedNow,
    });
    assert.equal(receipt.success, false);
    assert.equal(receipt.mutationStarted, false);
    assert.equal(receipt.rollback.attempted, false);
    assert.equal(validateHostDurabilityMutationReceipt(receipt).valid, true);
  }
  assert.equal(fs.existsSync(path.join(homeDir, "Library")), false);
});

test("unknown launchctl presence refuses without replacing a prior plist", (t) => {
  const homeDir = temporaryHome(t);
  const prior = Buffer.from("prior");
  const paths = prepareTarget(homeDir, prior);
  const receipt = installHostDurabilityService({
    authorization: installAuthorization(),
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: () => ({
      status: 5,
      signal: null,
      stdout: "",
      stderr: "permission denied",
    }),
    now: fixedNow,
  });
  assert.equal(receipt.errorCode, "HOST_DURABILITY_SERVICE_PRESENCE_UNKNOWN");
  assert.equal(receipt.mutationStarted, false);
  assert.deepEqual(fs.readFileSync(paths.targetPath), prior);
});

test("loaded service without a recoverable prior plist is refused", (t) => {
  const homeDir = temporaryHome(t);
  const paths = servicePaths(homeDir);
  const fake = fakeHostCommands({
    targetPath: paths.targetPath,
    initiallyLoaded: true,
  });
  const receipt = installHostDurabilityService({
    authorization: installAuthorization(),
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
  });
  assert.equal(
    receipt.errorCode,
    "HOST_DURABILITY_EXISTING_SERVICE_UNRECOVERABLE",
  );
  assert.equal(receipt.mutationStarted, false);
});

test("bootstrap failure restores and reboots the exact prior plist", (t) => {
  const homeDir = temporaryHome(t);
  const prior = Buffer.from("prior exact bytes");
  const paths = prepareTarget(homeDir, prior);
  const bootstrapKey = [
    "/bin/launchctl",
    "bootstrap",
    "gui/501",
    paths.targetPath,
  ].join(" ");
  const fake = fakeHostCommands({
    targetPath: paths.targetPath,
    initiallyLoaded: true,
    failOnce: { [bootstrapKey]: 1 },
  });
  const receipt = installHostDurabilityService({
    authorization: installAuthorization(),
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
    nonce: (() => {
      let value = 0;
      return () => `restore-${value++}`;
    })(),
  });
  assert.equal(receipt.success, false);
  assert.equal(receipt.errorCode, "HOST_DURABILITY_BOOTSTRAP_FAILED");
  assert.equal(receipt.rollback.attempted, true);
  assert.equal(receipt.rollback.complete, true);
  assert.equal(receipt.rollback.restoredPriorPlist, true);
  assert.equal(receipt.rollback.rebootstrapAttempted, true);
  assert.deepEqual(fs.readFileSync(paths.targetPath), prior);
  assert.equal(fake.isLoaded(), true);
});

for (const [operation, expectedError] of [
  ["bootout", "HOST_DURABILITY_BOOTOUT_FAILED"],
  ["kickstart", "HOST_DURABILITY_KICKSTART_FAILED"],
]) {
  test(`${operation} failure restores and reboots the exact prior plist`, (t) => {
    const homeDir = temporaryHome(t);
    const prior = Buffer.from(`prior-${operation}`);
    const paths = prepareTarget(homeDir, prior);
    const failedKey =
      operation === "bootout"
        ? [
            "/bin/launchctl",
            "bootout",
            "gui/501",
            paths.targetPath,
          ].join(" ")
        : [
            "/bin/launchctl",
            "kickstart",
            "-k",
            `gui/501/${HOST_SERVICE_LABEL}`,
          ].join(" ");
    const fake = fakeHostCommands({
      targetPath: paths.targetPath,
      initiallyLoaded: true,
      failOnce: { [failedKey]: 1 },
    });
    const receipt = installHostDurabilityService({
      authorization: installAuthorization(),
      homeDir,
      hostname: "operator-mac",
      platform: "darwin",
      architecture: "arm64",
      uid: 501,
      run: fake.run,
      now: fixedNow,
      nonce: (() => {
        let value = 0;
        return () => `${operation}-restore-${value++}`;
      })(),
    });
    assert.equal(receipt.errorCode, expectedError);
    assert.equal(receipt.rollback.complete, true);
    assert.equal(receipt.rollback.restoredPriorPlist, true);
    assert.deepEqual(fs.readFileSync(paths.targetPath), prior);
    assert.equal(fake.isLoaded(), true);
  });
}

test("failed first install removes its new plist", (t) => {
  const homeDir = temporaryHome(t);
  const paths = servicePaths(homeDir);
  const bootstrapKey = [
    "/bin/launchctl",
    "bootstrap",
    "gui/501",
    paths.targetPath,
  ].join(" ");
  const fake = fakeHostCommands({
    targetPath: paths.targetPath,
    failOnce: { [bootstrapKey]: 1 },
  });
  const receipt = installHostDurabilityService({
    authorization: installAuthorization(),
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
    nonce: () => "failed-first-install",
  });
  assert.equal(receipt.success, false);
  assert.equal(receipt.rollback.removedNewPlist, true);
  assert.equal(receipt.rollback.complete, true);
  assert.equal(fs.existsSync(paths.targetPath), false);
});

test("assertion or exact-path verification failure restores prior state", (t) => {
  for (const variation of ["assertion", "path"]) {
    const homeDir = temporaryHome(t);
    const prior = Buffer.from(`prior-${variation}`);
    const paths = prepareTarget(homeDir, prior);
    const fake = fakeHostCommands({
      targetPath: paths.targetPath,
      initiallyLoaded: true,
      assertionsPid: variation === "assertion" ? 999 : 4242,
      printedPath:
        variation === "path" ? "/tmp/wrong.plist" : paths.targetPath,
    });
    const receipt = installHostDurabilityService({
      authorization: installAuthorization(),
      homeDir,
      hostname: "operator-mac",
      platform: "darwin",
      architecture: "arm64",
      uid: 501,
      run: fake.run,
      now: fixedNow,
      nonce: (() => {
        let value = 0;
        return () => `${variation}-${value++}`;
      })(),
    });
    assert.equal(
      receipt.errorCode,
      "HOST_DURABILITY_POST_INSTALL_VERIFICATION_FAILED",
    );
    assert.equal(receipt.rollback.complete, true);
    assert.deepEqual(fs.readFileSync(paths.targetPath), prior);
  }
});

test("rollback restores only a hash-bound backup and verifies live PID", (t) => {
  const homeDir = temporaryHome(t);
  const current = Buffer.from(HOST_SERVICE_PLIST);
  const desired = Buffer.from("prior rollback target");
  const paths = prepareTarget(homeDir, current);
  const backup = backupExistingPlist({
    content: desired,
    backupDirectory: paths.backupDirectory,
  });
  const authorization = buildLocalHostAuthorizationToken({
    action: "rollback",
    hostname: "operator-mac",
    uid: 501,
    backupSha256: backup.sha256,
  });
  const fake = fakeHostCommands({
    targetPath: paths.targetPath,
    initiallyLoaded: true,
  });
  const receipt = rollbackHostDurabilityService({
    authorization,
    backupSha256: backup.sha256,
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
    nonce: () => "rollback-success",
  });
  assert.equal(receipt.success, true);
  assert.equal(receipt.action, "rollback");
  assert.equal(receipt.verification.valid, true);
  assert.equal(receipt.backup.sha256, sha256(current));
  assert.equal(receipt.sourceBackup.sha256, backup.sha256);
  assert.deepEqual(fs.readFileSync(paths.targetPath), desired);
  assert.equal(validateHostDurabilityMutationReceipt(receipt).valid, true);
});

test("rollback rejects missing, aliased, or hash-mismatched backups", (t) => {
  const homeDir = temporaryHome(t);
  const paths = prepareTarget(homeDir, HOST_SERVICE_PLIST);
  const missingHash = "b".repeat(64);
  assert.throws(
    () =>
      readSafeBackup({
        backupSha256: "bad",
        backupDirectory: paths.backupDirectory,
      }),
    (error) => error.code === "HOST_DURABILITY_BACKUP_HASH_INVALID",
  );
  assert.throws(
    () =>
      readSafeBackup({
        backupSha256: missingHash,
        backupDirectory: paths.backupDirectory,
      }),
    (error) => error.code === "HOST_DURABILITY_FILE_MISSING",
  );
  const content = Buffer.from("backup");
  const digest = sha256(content);
  const backupPath = path.join(
    paths.backupDirectory,
    `${HOST_SERVICE_LABEL}.${digest}.plist`,
  );
  const outside = path.join(homeDir, "outside-backup");
  fs.writeFileSync(outside, content);
  fs.symlinkSync(outside, backupPath);
  assert.throws(
    () =>
      readSafeBackup({
        backupSha256: digest,
        backupDirectory: paths.backupDirectory,
      }),
    (error) => error.code === "HOST_DURABILITY_FILE_UNSAFE",
  );
  fs.unlinkSync(backupPath);
  fs.writeFileSync(backupPath, "wrong");
  assert.throws(
    () =>
      readSafeBackup({
        backupSha256: digest,
        backupDirectory: paths.backupDirectory,
      }),
    (error) => error.code === "HOST_DURABILITY_BACKUP_CONTENT_MISMATCH",
  );
});

test("failed explicit rollback restores and reboots the current plist", (t) => {
  const homeDir = temporaryHome(t);
  const current = Buffer.from(HOST_SERVICE_PLIST);
  const desired = Buffer.from("desired prior");
  const paths = prepareTarget(homeDir, current);
  const backup = backupExistingPlist({
    content: desired,
    backupDirectory: paths.backupDirectory,
  });
  const bootstrapKey = [
    "/bin/launchctl",
    "bootstrap",
    "gui/501",
    paths.targetPath,
  ].join(" ");
  const fake = fakeHostCommands({
    targetPath: paths.targetPath,
    initiallyLoaded: true,
    failOnce: { [bootstrapKey]: 1 },
  });
  const receipt = rollbackHostDurabilityService({
    authorization: buildLocalHostAuthorizationToken({
      action: "rollback",
      hostname: "operator-mac",
      uid: 501,
      backupSha256: backup.sha256,
    }),
    backupSha256: backup.sha256,
    homeDir,
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    run: fake.run,
    now: fixedNow,
    nonce: (() => {
      let value = 0;
      return () => `rollback-restore-${value++}`;
    })(),
  });
  assert.equal(receipt.success, false);
  assert.equal(receipt.rollback.restoredPriorPlist, true);
  assert.equal(receipt.rollback.complete, true);
  assert.deepEqual(fs.readFileSync(paths.targetPath), current);
});

test("restore receipt records an incomplete fail-closed recovery", (t) => {
  const homeDir = temporaryHome(t);
  const prior = Buffer.from("prior");
  const paths = prepareTarget(homeDir, Buffer.from("new"));
  const result = restorePriorService({
    priorContent: prior,
    targetPath: paths.targetPath,
    launchAgents: paths.launchAgents,
    serviceDomainRoot: "gui/501",
    serviceDomain: `gui/501/${HOST_SERVICE_LABEL}`,
    run: () => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "all launchctl operations fail",
    }),
    fsImpl: fs,
    nonce: () => "incomplete-restore",
    commandReceipts: [],
  });
  assert.equal(result.rebootstrapAttempted, true);
  assert.equal(result.complete, false);
  assert.ok(result.errors.includes("HOST_DURABILITY_BOOTOUT_FAILED"));
  assert.deepEqual(fs.readFileSync(paths.targetPath), prior);
});

test("live-service verifier distinguishes durability and rollback proof", () => {
  const expectedPath =
    `/expected/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  const receipt = readyReceipt({
    launchctl: { path: expectedPath },
    expectedPlistPath: expectedPath,
  });
  assert.equal(
    verifyLiveService({
      receipt,
      targetPath: expectedPath,
      hostname: "operator-mac",
      nowMs: NOW,
      requireDurability: true,
    }).valid,
    true,
  );
  const weak = structuredClone(receipt);
  weak.assertions.preventSystemSleep = false;
  assert.equal(
    verifyLiveService({
      receipt: weak,
      targetPath: expectedPath,
      hostname: "operator-mac",
      nowMs: NOW,
      requireDurability: false,
    }).valid,
    true,
  );
  weak.service.state = "stopped";
  weak.service.pid = null;
  const invalid = verifyLiveService({
    receipt: weak,
    targetPath: "/wrong/service.plist",
    hostname: "operator-mac",
    nowMs: NOW,
    requireDurability: false,
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 3);
});

test("mutation receipt validation rejects structural and semantic forgery", () => {
  const receiptTarget =
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  const receipt = buildMutationReceipt({
    action: "install",
    startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW).toISOString(),
    hostname: "operator-mac",
    uid: 501,
    targetPath: receiptTarget,
    backup: null,
    priorPlistSha256: null,
    commandReceipts: [
      commandReceipt(
        "/bin/launchctl",
        ["print", `gui/501/${HOST_SERVICE_LABEL}`],
        {
        status: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        },
      ),
    ],
    verification: { valid: true, errors: [] },
    rollback: { attempted: false, complete: true, errors: [] },
    mutationStarted: true,
    success: true,
    errorCode: null,
  });
  assert.equal(validateHostDurabilityMutationReceipt(receipt).valid, true);
  for (const mutate of [
    (value) => {
      value.receiptHash = "0".repeat(64);
    },
    (value) => {
      value.schema = "wrong";
    },
    (value) => {
      value.action = "erase";
    },
    (value) => {
      value.commandReceipts = null;
    },
    (value) => {
      value.completedAt = "not-a-timestamp";
    },
    (value) => {
      value.priorPlistSha256 = "bad";
    },
    (value) => {
      value.priorPlistSha256 = "a".repeat(64);
    },
    (value) => {
      value.sourceBackup = {
        path:
          `/workspace/demo/Library/LaunchAgents/` +
          `${HOST_SERVICE_BACKUP_DIRECTORY}/` +
          `${HOST_SERVICE_LABEL}.${"a".repeat(64)}.plist`,
        sha256: "a".repeat(64),
        bytes: 1,
      };
    },
    (value) => {
      value.action = "rollback";
      value.sourceBackup = null;
    },
    (value) => {
      value.commandReceipts = [{ command: "/tmp/not-launchctl" }];
    },
    (value) => {
      value.success = true;
      value.verification = { valid: false };
    },
    (value) => {
      value.errorCode = "impossible-success-error";
    },
    (value) => {
      value.success = false;
      value.errorCode = null;
    },
    (value) => {
      value.success = false;
      value.errorCode = "failed";
      value.mutationStarted = true;
      value.rollback = { attempted: false };
    },
  ]) {
    const forged = structuredClone(receipt);
    mutate(forged);
    if (forged.receiptHash === receipt.receiptHash) {
      forged.receiptHash =
        require("../lib/pikiio-host-durability").hashWithoutField(forged);
    }
    assert.equal(validateHostDurabilityMutationReceipt(forged).valid, false);
  }
  assert.equal(validateHostDurabilityMutationReceipt(null).valid, false);
});

test("decision-free command CLI accepts only exact status/install/rollback forms", () => {
  const validReceipt = (action) =>
    buildMutationReceipt({
      action,
      startedAt: new Date(NOW).toISOString(),
      completedAt: new Date(NOW).toISOString(),
      hostname: "host",
      uid: 1,
      targetPath:
        `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`,
      backup: null,
      sourceBackup:
        action === "rollback"
          ? {
              path:
                `/workspace/demo/Library/LaunchAgents/` +
                `${HOST_SERVICE_BACKUP_DIRECTORY}/` +
                `${HOST_SERVICE_LABEL}.${"a".repeat(64)}.plist`,
              sha256: "a".repeat(64),
              bytes: 1,
            }
          : null,
      priorPlistSha256: null,
      commandReceipts: [],
      verification: { valid: true, errors: [] },
      rollback: { attempted: false, complete: true, errors: [] },
      mutationStarted: true,
      success: true,
      errorCode: null,
    });
  let output = "";
  let statusCalls = 0;
  assert.equal(
    runHostDurabilityCommandCli({
      argv: [],
      status: () => {
        statusCalls += 1;
        return 0;
      },
      write: (value) => {
        output += value;
      },
    }),
    0,
  );
  assert.equal(statusCalls, 1);
  let observed = null;
  output = "";
  assert.equal(
    runHostDurabilityCommandCli({
      argv: ["install", "--authorize-local-host", "exact-token"],
      install: (options) => {
        observed = options;
        return validReceipt("install");
      },
      context: { install: { homeDir: "/fixed-home" } },
      write: (value) => {
        output += value;
      },
    }),
    0,
  );
  assert.deepEqual(observed, {
    homeDir: "/fixed-home",
    authorization: "exact-token",
  });
  assert.equal(JSON.parse(output).receipt.action, "install");
  output = "";
  assert.equal(
    runHostDurabilityCommandCli({
      argv: [
        "rollback",
        "--backup-sha256",
        "a".repeat(64),
        "--authorize-local-host",
        "rollback-token",
      ],
      rollback: (options) => {
        observed = options;
        return validReceipt("rollback");
      },
      write: (value) => {
        output += value;
      },
    }),
    0,
  );
  assert.equal(observed.backupSha256, "a".repeat(64));
  for (const argv of [
    ["status", "extra"],
    ["install", "exact-token"],
    ["rollback", "--authorize-local-host", "token"],
    ["unknown"],
  ]) {
    output = "";
    assert.equal(
      runHostDurabilityCommandCli({
        argv,
        write: (value) => {
          output += value;
        },
      }),
      64,
    );
    assert.equal(
      JSON.parse(output).errorCode,
      "HOST_DURABILITY_CLI_USAGE_INVALID",
    );
  }
});

test("command CLI preserves a valid fail-closed mutation refusal", () => {
  const refused = buildMutationReceipt({
    action: "install",
    startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW).toISOString(),
    hostname: "host",
    uid: 1,
    targetPath: "",
    backup: null,
    priorPlistSha256: null,
    commandReceipts: [],
    verification: { valid: false, errors: ["not run"] },
    rollback: { attempted: false, complete: true, errors: [] },
    mutationStarted: false,
    success: false,
    errorCode: "HOST_DURABILITY_LOCAL_AUTHORIZATION_REQUIRED",
  });
  let output = "";
  assert.equal(
    runHostDurabilityCommandCli({
      argv: ["install", "--authorize-local-host", "wrong"],
      install: () => refused,
      write: (value) => {
        output += value;
      },
    }),
    2,
  );
  assert.equal(JSON.parse(output).validation.valid, true);
});

test("command CLI default writer is a transparent adapter", () => {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (value) => {
    output += value;
    return true;
  };
  try {
    assert.equal(
      runHostDurabilityCommandCli({
        argv: [],
        status: ({ write }) => {
          write("status-output");
          return 0;
        },
      }),
      0,
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(output, "status-output");
});

test("live host probe is read-only and cannot silently certify a stopped service", {
  skip: process.platform !== "darwin",
}, () => {
  const receipt = collectHostDurabilityReceipt();
  assert.equal(receipt.hostname, os.hostname());
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
  const validation = validateHostDurabilityReceipt(receipt);
  assert.equal(validation.valid, receipt.ready);
});
