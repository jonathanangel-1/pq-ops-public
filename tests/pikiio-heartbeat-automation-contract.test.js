"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");

const {
  PIKIIO_HEARTBEAT_LEASE_COMMANDS,
  PIKIIO_HEARTBEAT_PROMPT_PATH,
  comparePikiioHeartbeatPrompt,
  extractPikiioHeartbeatLeaseCommands,
  readCanonicalPikiioHeartbeatPrompt,
  validatePikiioHeartbeatLedgerContract,
  validatePikiioHeartbeatPrompt,
} = require("../scripts/verify-automation-contracts");
const governance = require("../lib/pikiio-agent-governance");

const PINNED_FILE_SHA256 =
  "cf377315bb6d0b08444d9e17c0ad32e0ca7555ef8fde1148a1fe6c3607b1eec2";
const PINNED_PROMPT_SHA256 =
  "3511d46536d00136915ca3ef6bf1ee3de6458f322e1c888eddf194a07b258432";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("canonical heartbeat prompt is byte-pinned and satisfies the fail-closed contract", () => {
  const file = fs.readFileSync(PIKIIO_HEARTBEAT_PROMPT_PATH);
  const prompt = readCanonicalPikiioHeartbeatPrompt();
  const validation = validatePikiioHeartbeatPrompt(prompt);

  assert.equal(sha256(file), PINNED_FILE_SHA256);
  assert.equal(sha256(prompt), PINNED_PROMPT_SHA256);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.sha256, PINNED_PROMPT_SHA256);
});

test("lease lifecycle uses the exact acquire, assert, renew, assert, release sequence", () => {
  const prompt = readCanonicalPikiioHeartbeatPrompt();
  const commands = extractPikiioHeartbeatLeaseCommands(prompt);

  assert.deepEqual(commands, PIKIIO_HEARTBEAT_LEASE_COMMANDS);

  const acquireArgs = commands[0].split(/\s+/);
  assert.deepEqual(acquireArgs, [
    "npm",
    "run",
    "pikiio:writer-lease",
    "--",
    "acquire",
    "--run-id=<unique-run-id>",
    "--automation-id=pikiio-governed-builder-heartbeat",
    "--lease-ms=900000",
  ]);

  for (const [index, operation] of [
    [1, "assert"],
    [2, "renew"],
    [3, "assert"],
    [4, "release"],
  ]) {
    assert.deepEqual(commands[index].split(/\s+/), [
      "npm",
      "run",
      "pikiio:writer-lease",
      "--",
      operation,
      "--handle=<private-handle-path-from-acquire>",
    ]);
  }
});

test("configured automation must match the canonical prompt exactly", () => {
  const canonical = readCanonicalPikiioHeartbeatPrompt();
  assert.equal(
    comparePikiioHeartbeatPrompt(canonical, canonical).valid,
    true,
  );

  const changed = `${canonical}\n`;
  const comparison = comparePikiioHeartbeatPrompt(changed, canonical);
  assert.equal(comparison.valid, false);
  assert.match(
    comparison.errors.join("\n"),
    /configured heartbeat prompt differs/,
  );
  assert.notEqual(
    comparison.configuredSha256,
    comparison.canonicalSha256,
  );
});

test("phase ledger binds the exact prompt identity and automation configuration", () => {
  const ledger = governance.loadPhaseLedger();
  const canonical = readCanonicalPikiioHeartbeatPrompt();
  const valid = validatePikiioHeartbeatLedgerContract(ledger, canonical);
  assert.equal(valid.valid, true, valid.errors.join("\n"));

  for (const mutate of [
    (changed) => {
      changed.automationContract.promptSha256 = "0".repeat(64);
    },
    (changed) => {
      changed.automationContract.rrule = "FREQ=MINUTELY;INTERVAL=1";
    },
    (changed) => {
      changed.automationContract.targetThreadId = "wrong-task";
    },
  ]) {
    const changed = JSON.parse(JSON.stringify(ledger));
    mutate(changed);
    assert.equal(
      validatePikiioHeartbeatLedgerContract(changed, canonical).valid,
      false,
    );
  }
  assert.equal(
    validatePikiioHeartbeatLedgerContract(
      ledger,
      canonical.replace("Continue the active Pikiio agent goal", "Altered"),
    ).valid,
    false,
  );
});

test("ledger scope overrides and run-id control commands fail validation", () => {
  const canonical = readCanonicalPikiioHeartbeatPrompt();
  const scopeOverride = canonical.replace(
    PIKIIO_HEARTBEAT_LEASE_COMMANDS[0],
    `${PIKIIO_HEARTBEAT_LEASE_COMMANDS[0]} --phase=TRUTH-01 --lane=truth`,
  );
  const runIdRenewal = canonical.replace(
    PIKIIO_HEARTBEAT_LEASE_COMMANDS[2],
    "npm run pikiio:writer-lease -- renew --run-id=<unique-run-id>",
  );

  for (const prompt of [scopeOverride, runIdRenewal]) {
    const result = validatePikiioHeartbeatPrompt(prompt);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /lease commands|control commands/);
  }
});

test("missing activation, capability secrecy, or production denial language fails validation", () => {
  const canonical = readCanonicalPikiioHeartbeatPrompt();
  for (const text of [
    "valid, unexpired, transition-bound activation receipt for the current active phase",
    "Never read, copy, print, log, persist, summarize, commit, upload, or include in a run receipt the handle file contents, capability bytes",
    "Production is categorically disabled for this heartbeat.",
  ]) {
    const result = validatePikiioHeartbeatPrompt(canonical.replace(text, ""));
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /missing pinned text/);
  }
});

test("an executable production command is refused even if denial text remains", () => {
  const canonical = readCanonicalPikiioHeartbeatPrompt();
  const unsafe = `${canonical}\n\n\`npm run pikiio:production -- --action=deploy\``;
  const result = validatePikiioHeartbeatPrompt(unsafe);

  assert.equal(result.valid, false);
  assert.match(
    result.errors.join("\n"),
    /leading\/trailing whitespace|executable production command/,
  );
});
