#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PROBE_PATH = path.join(ROOT, "tests", "pikiio-truth-phase-mutant-probe.js");
const PROBE_TIMEOUT_MS = 15_000;

const MUTATION_PROFILES = Object.freeze({
  "truth-liveness-mutation-v1": Object.freeze([
    {
      id: "frontier-publication-boundary",
      checkId: "liveness-frontier-publication-boundary",
      fingerprint: "frontier-publication-attempt-accepted",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "|| value.productionPublicationAttempted !== false) {",
      to: "|| false) {",
    },
    {
      id: "frontier-connection-registry",
      checkId: "liveness-frontier-connection-registry",
      fingerprint: "foreign-source-connection-accepted",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "|| batch.connectionKey !== CONNECTIONS[sourceSystem]",
      to: "|| false",
    },
    {
      id: "already-accepted-skip",
      checkId: "liveness-already-accepted-skip",
      fingerprint: "already-accepted-frontier-reran",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "if (batch.acceptanceComplete) {",
      to: "if (false) {",
    },
    {
      id: "not-ready-skip",
      checkId: "liveness-not-ready-skip",
      fingerprint: "not-ready-frontier-ran",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "if (!batch.readyToRun) {",
      to: "if (false) {",
    },
    {
      id: "acceptance-receipt-no-publication",
      checkId: "liveness-acceptance-receipt-no-publication",
      fingerprint: "publishing-acceptance-counted-success",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "&& receipt.productionPublicationAttempted === false) {",
      to: "&& true) {",
    },
    {
      id: "coordinator-no-operational-state",
      checkId: "liveness-coordinator-no-operational-state",
      fingerprint: "coordinator-operational-mutation-enabled",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "mutatesOperationalState: false,\n      publishesTruth: false,",
      to: "mutatesOperationalState: true,\n      publishesTruth: false,",
    },
    {
      id: "coordinator-no-truth-publication",
      checkId: "liveness-coordinator-no-truth-publication",
      fingerprint: "coordinator-publication-enabled",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "publishesTruth: false,\n      productionPublicationAttempted: false,",
      to: "publishesTruth: true,\n      productionPublicationAttempted: false,",
    },
    {
      id: "coordinator-no-publication-attempt",
      checkId: "liveness-coordinator-no-publication-attempt",
      fingerprint: "coordinator-publication-attempt-hidden",
      source: "lib/truth-generic-acceptance-readiness.js",
      from: "productionPublicationAttempted: false,\n    });",
      to: "productionPublicationAttempted: true,\n    });",
    },
    {
      id: "not-ready-null-identity",
      checkId: "liveness-not-ready-null-identity",
      fingerprint: "not-ready-source-cut-carried-identity",
      source: "lib/truth-source-cut-ledger.js",
      from: "if (value.sourceCutId !== null || value.manifestHash !== null || value.manifest !== null",
      to: "if (false || false || false",
    },
    {
      id: "not-ready-gap-required",
      checkId: "liveness-not-ready-gap-required",
      fingerprint: "not-ready-source-cut-without-gap-accepted",
      source: "lib/truth-source-cut-ledger.js",
      from: "|| value.completeness !== \"degraded\" || value.gaps.length === 0) {",
      to: "|| value.completeness !== \"degraded\" || false) {",
    },
    {
      id: "sealed-content-address-binding",
      checkId: "liveness-sealed-content-address-binding",
      fingerprint: "non-content-addressed-source-cut-accepted",
      source: "lib/truth-source-cut-ledger.js",
      from: "|| value.sourceCutId !== `cut:v1:${value.manifestHash}`",
      to: "|| false",
    },
    {
      id: "sealed-manifest-no-observations",
      checkId: "liveness-sealed-manifest-no-observations",
      fingerprint: "source-cut-inline-observations-accepted",
      source: "lib/truth-source-cut-ledger.js",
      from: "|| Object.prototype.hasOwnProperty.call(value.manifest, \"observations\")) {",
      to: "|| false) {",
    },
    {
      id: "source-cut-completeness-gap-parity",
      checkId: "liveness-source-cut-completeness-gap-parity",
      fingerprint: "complete-source-cut-with-gap-accepted",
      source: "lib/truth-source-cut-ledger.js",
      from: "if ((value.completeness === \"complete\") !== (value.gaps.length === 0)) {",
      to: "if (false) {",
    },
    {
      id: "accepted-cut-shadow-channel",
      checkId: "liveness-accepted-cut-shadow-channel",
      fingerprint: "accepted-gmail-cut-production-channel-accepted",
      source: "lib/truth-production-source-cut-coordinator.js",
      from: "|| value.publicationChannel !== \"shadow\"",
      to: "|| false",
    },
    {
      id: "accepted-cut-shadow-only",
      checkId: "liveness-accepted-cut-shadow-only",
      fingerprint: "accepted-gmail-cut-nonshadow-accepted",
      source: "lib/truth-production-source-cut-coordinator.js",
      from: "|| value.shadowOnly !== true",
      to: "|| false",
    },
    {
      id: "accepted-cut-not-production-eligible",
      checkId: "liveness-accepted-cut-not-production-eligible",
      fingerprint: "accepted-gmail-cut-production-eligible",
      source: "lib/truth-production-source-cut-coordinator.js",
      from: "|| value.productionEligible !== false",
      to: "|| false",
    },
    {
      id: "production-bridge-distinct-cut",
      checkId: "liveness-production-bridge-distinct-cut",
      fingerprint: "production-bridge-reused-shadow-cut",
      source: "lib/truth-production-source-cut-coordinator.js",
      from: "|| productionSourceCutId === shadowSourceCutId",
      to: "|| false",
    },
    {
      id: "production-bridge-eligibility",
      checkId: "liveness-production-bridge-eligibility",
      fingerprint: "ineligible-production-bridge-accepted",
      source: "lib/truth-production-source-cut-coordinator.js",
      from: "|| value.productionEligible !== true",
      to: "|| false",
    },
    {
      id: "accepted-cut-validation-before-bridge",
      checkId: "liveness-accepted-cut-validation-before-bridge",
      fingerprint: "invalid-accepted-cut-reached-production-bridge",
      source: "lib/truth-production-source-cut-coordinator.js",
      from: "validateAcceptedGmailCut(shadowCut);",
      to: "void shadowCut;",
    },
    {
      id: "canonical-watermark-before-write",
      checkId: "liveness-canonical-watermark-before-write",
      fingerprint: "incomplete-canonical-watermark-was-written",
      source: "lib/canonical-truth-publisher.js",
      from: "assertSourceWatermarkComplete(packet);",
      to: "void packet;",
    },
  ].map((mutant) => Object.freeze({ ...mutant, critical: true }))),
  "truth-soak-mutation-v1": Object.freeze([
    {
      id: "minimum-duration",
      checkId: "soak-minimum-duration",
      fingerprint: "short-soak-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "end - start < 24 * 60 * 60_000",
      to: "end - start < 1",
    },
    {
      id: "natural-morning",
      checkId: "soak-natural-morning",
      fingerprint: "manufactured-morning-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "receipt.status === \"succeeded\" && receipt.natural === true",
      to: "receipt.status === \"succeeded\"",
    },
    {
      id: "morning-required",
      checkId: "soak-morning-required",
      fingerprint: "missing-morning-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "if (!successfulNatural.length) {",
      to: "if (false) {",
    },
    {
      id: "morning-start-bound",
      checkId: "soak-morning-start-bound",
      fingerprint: "pre-soak-morning-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "time(receipt.startedAt) < start ||",
      to: "false ||",
    },
    {
      id: "morning-end-bound",
      checkId: "soak-morning-end-bound",
      fingerprint: "post-soak-morning-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "time(receipt.completedAt) > end ||",
      to: "false ||",
    },
    {
      id: "morning-chronology",
      checkId: "soak-morning-chronology",
      fingerprint: "backward-morning-time-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "time(receipt.completedAt) < time(receipt.startedAt)",
      to: "false",
    },
    {
      id: "live-backlog-monotonic",
      checkId: "soak-live-backlog-monotonic",
      fingerprint: "growing-live-backlog-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "} else if (queues.liveBacklogEnd > queues.liveBacklogStart) {",
      to: "} else if (false) {",
    },
    {
      id: "dead-letter-zero",
      checkId: "soak-dead-letter-zero",
      fingerprint: "dead-letter-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "if (queues.deadLetterCount !== 0) {",
      to: "if (false) {",
    },
    {
      id: "replay-live-recovery-exclusion",
      checkId: "soak-replay-live-recovery-exclusion",
      fingerprint: "replay-recovery-collision-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "if (queues.historicalReplayActive === true && queues.liveRecoveryActive === true) {",
      to: "if (false) {",
    },
    {
      id: "health-live",
      checkId: "soak-health-live",
      fingerprint: "degraded-health-accepted",
      source: "scripts/verify-pikiio-truth-phase-gherkin.js",
      from: "if (health.status !== \"live\") {",
      to: "if (false) {",
    },
    {
      id: "invalid-time-stale",
      checkId: "soak-invalid-time-stale",
      fingerprint: "invalid-time-treated-fresh",
      source: "lib/truth-health.js",
      from: "return age === null ? true : age > maxAgeMinutes;",
      to: "return age === null ? false : age > maxAgeMinutes;",
    },
    {
      id: "completed-row-excluded",
      checkId: "soak-completed-row-excluded",
      fingerprint: "completed-row-treated-active",
      source: "lib/truth-health.js",
      from: "if (role === \"completed\" || row?.completed) return false;",
      to: "if (false) return false;",
    },
    {
      id: "active-index-binding",
      checkId: "soak-active-index-binding",
      fingerprint: "active-index-ignored",
      source: "lib/truth-health.js",
      from: "return activeAwbs.size ? activeAwbs.has(awb) : role === \"active\";",
      to: "return role === \"active\";",
    },
    {
      id: "coverage-stamp-required",
      checkId: "soak-coverage-stamp-required",
      fingerprint: "missing-coverage-certified",
      source: "lib/truth-health.js",
      from: "if (!coverage.hasCoverageStamp) {",
      to: "if (false) {",
    },
    {
      id: "coverage-problem-blocks",
      checkId: "soak-coverage-problem-blocks",
      fingerprint: "coverage-problem-certified",
      source: "lib/truth-health.js",
      from: "if (coverage.problem) {",
      to: "if (false) {",
    },
    {
      id: "email-phase-requires-source-fact",
      checkId: "soak-email-phase-requires-source-fact",
      fingerprint: "email-phase-without-email-certified",
      source: "lib/truth-health.js",
      from: "if (phaseDependsOnEmailTruth(phase) && !coverage.hasGmailEvidence) {",
      to: "if (false) {",
    },
    {
      id: "coherence-contradiction-blocks",
      checkId: "soak-coherence-contradiction-blocks",
      fingerprint: "contradiction-certified",
      source: "lib/truth-health.js",
      from: "if (coherenceContradictions.length) {",
      to: "if (false) {",
    },
    {
      id: "stale-embedded-tms-blocks",
      checkId: "soak-stale-embedded-tms-blocks",
      fingerprint: "stale-embedded-tms-certified",
      source: "lib/truth-health.js",
      from: "const embeddedOk = Boolean(embedded && !embedded.stale);",
      to: "const embeddedOk = Boolean(embedded);",
    },
    {
      id: "refresh-success-marker-required",
      checkId: "soak-refresh-success-marker-required",
      fingerprint: "failed-refresh-certified-fresh",
      source: "lib/truth-health.js",
      from: "writerVersion.includes(\"+status-success\")",
      to: "true",
    },
    {
      id: "false-gate-remains-unknown",
      checkId: "soak-false-gate-remains-unknown",
      fingerprint: "false-gate-promoted",
      source: "lib/truth-production-semantics.js",
      from: "if (value === false || value === null || value === undefined) return \"unknown\";",
      to: "if (value === false || value === null || value === undefined) return \"done\";",
    },
  ].map((mutant) => Object.freeze({ ...mutant, critical: true }))),
});

function replaceExactlyOnce(source, from, to, id) {
  const first = source.indexOf(from);
  if (first === -1) {
    const error = new Error(`${id}: mutation anchor missing`);
    error.code = "MUTATION_ANCHOR_MISSING";
    throw error;
  }
  if (source.indexOf(from, first + from.length) !== -1) {
    const error = new Error(`${id}: mutation anchor is ambiguous`);
    error.code = "MUTATION_ANCHOR_AMBIGUOUS";
    throw error;
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

function parseLastJson(value) {
  const lines = String(value || "").trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // The probe writes one compact JSON record as its last line.
    }
  }
  return null;
}

function runProbe(sourcePath, mutant, {
  metaMode = "",
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  return spawnSync(
    process.execPath,
    [PROBE_PATH, sourcePath, mutant.source, ROOT, mutant.checkId],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        PIKIIO_TRUTH_MUTANT_META_MODE: metaMode,
      },
      maxBuffer: 5 * 1024 * 1024,
    },
  );
}

function classifyKill(result, mutant) {
  const payload = parseLastJson(result.stdout);
  return Boolean(
    result.status === 1 &&
    !result.signal &&
    !result.error &&
    payload?.ok === false &&
    payload?.reason === "assertion_failed" &&
    payload?.checkId === mutant.checkId &&
    payload?.fingerprint === mutant.fingerprint
  );
}

function validateProfile(profile, mutants) {
  if (!Array.isArray(mutants) || mutants.length !== 20) {
    throw new Error(`${profile}: requires exactly 20 honest critical mutants`);
  }
  for (const field of ["id", "checkId", "fingerprint"]) {
    const values = mutants.map((mutant) => mutant[field]);
    if (new Set(values).size !== values.length) {
      throw new Error(`${profile}: duplicate ${field} would pad the population`);
    }
  }
  if (mutants.some((mutant) => mutant.critical !== true)) {
    throw new Error(`${profile}: every explicit truth mutant must be critical`);
  }
}

function classifierMetaTests(mutant) {
  const sourcePath = path.join(ROOT, mutant.source);
  const wrongFingerprint = runProbe(sourcePath, mutant, {
    metaMode: "wrong-fingerprint",
  });
  const crash = runProbe(sourcePath, mutant, { metaMode: "crash" });
  const timeout = runProbe(sourcePath, mutant, {
    metaMode: "timeout",
    timeoutMs: 250,
  });
  const results = {
    wrongFingerprintRejected: !classifyKill(wrongFingerprint, mutant),
    crashRejected: !classifyKill(crash, mutant),
    timeoutRejected: !classifyKill(timeout, mutant),
  };
  return {
    ...results,
    passed: Object.values(results).every(Boolean),
  };
}

function parseProfileArg(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) {
    throw Object.assign(
      new Error("Exactly one immutable --profile=<truth-mutation-profile> argument is required"),
      { code: "TRUTH_MUTATION_PROFILE_REQUIRED" },
    );
  }
  const match = /^--profile=([a-z0-9-]+)$/.exec(argv[0]);
  if (!match || !Object.hasOwn(MUTATION_PROFILES, match[1])) {
    throw Object.assign(new Error("Unknown immutable truth mutation profile"), {
      code: "TRUTH_MUTATION_PROFILE_UNKNOWN",
    });
  }
  return match[1];
}

function executeProfile(profile) {
  const mutants = MUTATION_PROFILES[profile];
  validateProfile(profile, mutants);
  const metaTests = classifierMetaTests(mutants[0]);
  if (!metaTests.passed) {
    throw Object.assign(new Error("Mutation classifier meta-tests failed"), {
      code: "TRUTH_MUTATION_CLASSIFIER_META_FAILED",
    });
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-truth-mutants-"));
  const results = [];
  try {
    for (const mutant of mutants) {
      const sourcePath = path.join(ROOT, mutant.source);
      const source = fs.readFileSync(sourcePath, "utf8");
      const baseline = runProbe(sourcePath, mutant);
      const baselinePayload = parseLastJson(baseline.stdout);
      if (
        baseline.status !== 0 ||
        baseline.signal ||
        baseline.error ||
        baselinePayload?.ok !== true ||
        baselinePayload?.checkId !== mutant.checkId
      ) {
        throw Object.assign(new Error(`${mutant.id}: baseline probe is not green`), {
          code: "TRUTH_MUTATION_BASELINE_FAILED",
          details: {
            status: baseline.status,
            signal: baseline.signal,
            stdout: baseline.stdout,
            stderr: baseline.stderr,
          },
        });
      }
      const mutated = replaceExactlyOnce(
        source,
        mutant.from,
        mutant.to,
        mutant.id,
      );
      const mutantPath = path.join(temp, `${mutant.id}.js`);
      fs.writeFileSync(mutantPath, mutated, { mode: 0o600 });
      const probe = runProbe(mutantPath, mutant);
      const killed = classifyKill(probe, mutant);
      const payload = parseLastJson(probe.stdout);
      results.push({
        id: mutant.id,
        checkId: mutant.checkId,
        fingerprint: mutant.fingerprint,
        source: mutant.source,
        critical: true,
        status: killed ? "killed" : "survived",
        observed: {
          exitStatus: probe.status,
          signal: probe.signal || null,
          timedOut: probe.error?.code === "ETIMEDOUT",
          reason: payload?.reason || null,
          checkId: payload?.checkId || null,
          fingerprint: payload?.fingerprint || null,
        },
      });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const killed = results.filter((result) => result.status === "killed").length;
  const survived = results.length - killed;
  return Object.freeze({
    ok: survived === 0,
    schema: "pikiio-truth-mutation-result-v1",
    profile,
    population: results.length,
    criticalPopulation: results.length,
    killed,
    criticalKilled: killed,
    survived,
    survivedCritical: survived,
    scorePercent: results.length ? (killed / results.length) * 100 : 0,
    criticalKillPercent: results.length ? (killed / results.length) * 100 : 0,
    classifierMetaTests: metaTests,
    metaTestsPassed: metaTests.passed,
    mutants: results,
  });
}

function main() {
  try {
    const profile = parseProfileArg(process.argv.slice(2));
    const result = executeProfile(profile);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "pikiio-truth-mutation-result-v1",
      code: String(error?.code || "TRUTH_MUTATION_FAILED"),
      error: error instanceof Error ? error.message : String(error),
      details: error?.details || null,
    })}\n`);
    process.exitCode = error?.code?.includes("PROFILE") ? 64 : 2;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  MUTATION_PROFILES,
  classifyKill,
  executeProfile,
  parseLastJson,
  parseProfileArg,
  replaceExactlyOnce,
  validateProfile,
});
