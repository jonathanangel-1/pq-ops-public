"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const harness = require("../../scripts/verify-pikiio-action-phase-gherkin");

const PROFILE = "ACTION-01";
const ROOT = path.resolve(__dirname, "../..");
const requestedProfile = String(
  process.env.PIKIIO_ACTION_PHASE_ACCEPTANCE || "",
).trim();
if (requestedProfile && requestedProfile !== PROFILE) {
  throw new Error(
    `${__filename} only certifies ${PROFILE}; requested ${requestedProfile}`,
  );
}
const productAcceptance = requestedProfile === PROFILE;
const cases = harness.acceptanceCases(PROFILE);
assert.equal(cases.length, harness.DOMAIN_ACCEPTANCE_POPULATION);
assert.equal(new Set(cases.map((row) => row.id)).size, cases.length);

let productAdapter = null;
let productGap = null;
if (productAcceptance) {
  try {
    productAdapter = harness.loadProductAdapter(PROFILE);
  } catch (error) {
    productGap = error;
  }
}
const adapter = productAcceptance
  ? {
      evaluate(input) {
        if (productGap) throw productGap;
        return productAdapter.evaluate(input);
      },
    }
  : harness.createOracleAdapter(PROFILE);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function frozenRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-action-manifest-"));
  const { manifest } = harness.assertFrozenFixtureManifest();
  const manifestPath = path.join(
    root,
    "YLYI/07_Backtest_Cases/pikiio-action-proof-fixture-manifest.json",
  );
  for (const entry of [manifest.corpus, ...manifest.fixtures]) {
    const target = path.join(root, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, entry.path), target);
  }
  writeJson(manifestPath, manifest);
  return { root, manifestPath };
}

function rewriteFrozenEntry(root, relativePath, mutate) {
  const filePath = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(value);
  writeJson(filePath, value);
  const manifestPath = path.join(
    root,
    "YLYI/07_Backtest_Cases/pikiio-action-proof-fixture-manifest.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry =
    manifest.corpus.path === relativePath
      ? manifest.corpus
      : manifest.fixtures.find((row) => row.path === relativePath);
  const bytes = fs.readFileSync(filePath);
  entry.byteLength = bytes.length;
  entry.sha256 = harness.sha256(bytes);
  writeJson(manifestPath, manifest);
}

for (const caseRow of cases) {
  test(`${PROFILE} domain ${caseRow.id}`, async () => {
    await harness.executeAcceptanceCase(PROFILE, caseRow, adapter);
  });
}

if (!productAcceptance) {
  test(`${PROFILE} harness freezes the 27-case corpus and AB-026/027 bytes`, () => {
    const result = harness.assertFrozenFixtureManifest();
    assert.equal(result.corpus.cases.length, 27);
    assert.deepEqual(
      result.manifest.fixtures.map((row) => row.caseId),
      ["AB-026", "AB-027"],
    );
  });

  test(`${PROFILE} harness exposes exactly 65 non-duplicate domain cases`, () => {
    assert.equal(cases.length, 65);
    assert.equal(new Set(cases.map((row) => row.id)).size, 65);
    assert.equal(cases.filter((row) => row.domain === "frozen-action-corpus").length, 27);
    assert.equal(cases.filter((row) => row.domain === "claim-native-invariant").length, 38);
  });

  test(`${PROFILE} validator kills scheduled-as-completed behavior`, () => {
    const caseRow = cases.find((row) => row.id.includes("scheduled-never-delivered"));
    const output = harness.oracleAction01(caseRow.input);
    output.decision = "act";
    assert.throws(
      () => harness.validateAction01(caseRow.input, output, output, caseRow.expected),
      /Expected values to be strictly equal|scheduled delivery armed/i,
    );
  });

  test(`${PROFILE} validator kills unaccepted recipient provenance`, () => {
    const caseRow = cases.find((row) => row.id.includes("owner-resolves-recipient"));
    const output = harness.oracleAction01(caseRow.input);
    output.counterpartyResolution.claimVersionId = "fabricated:owner";
    assert.throws(
      () => harness.validateAction01(caseRow.input, output, output, caseRow.expected),
      /Expected values to be strictly equal|accepted destination leg owner/i,
    );
  });

  test(`${PROFILE} unknown feature step fails closed`, () => {
    const featurePath = path.join(
      ROOT,
      harness.PROFILE_SPECS[PROFILE].featurePath,
    );
    const source = fs.readFileSync(featurePath, "utf8");
    assert.throws(
      () =>
        harness.assertFeatureContract(
          PROFILE,
          source.replace(
            "Then the POD family does not act on a scheduled event",
            "Then an unregistered outcome silently passes",
          ),
        ),
      /feature bytes changed/,
    );
  });

  test(`${PROFILE} feature parser and CLI reject every unsupported boundary`, async () => {
    assert.equal(harness.assertFeatureContract(PROFILE).length, 15);
    assert.throws(
      () => harness.assertProfileId("ACTION-99"),
      { code: "PIKIIO_ACTION_PROOF_PROFILE_UNKNOWN" },
    );
    assert.throws(
      () => harness.parseFeature("Given orphan step"),
      /before Scenario/,
    );
    assert.throws(
      () => harness.parseFeature("Feature: x\nScenario:\nGiven x"),
      /name must be non-empty/,
    );
    assert.throws(
      () => harness.parseFeature("Feature: x\nScenario: y\nUnsupported x"),
      /Unknown or unsupported/,
    );
    assert.throws(
      () => harness.parseFeature("Scenario: y\nGiven x"),
      /exactly one Feature/,
    );
    assert.throws(
      () => harness.parseFeature("Feature: x\nFeature: z\nScenario: y\nGiven x"),
      /exactly one Feature/,
    );
    const parsed = harness.parseFeature(
      "# comment\nFeature: x\nScenario: y\nGiven x\nAnd y\nBut z\n",
    );
    assert.deepEqual(parsed[0].steps, ["Given x", "And y", "But z"]);
    await assert.rejects(
      () => harness.main(["--self-test", "--profile", PROFILE]),
      /mutually exclusive/,
    );
    await assert.rejects(() => harness.main([]), /Use --self-test/);
    const summary = await harness.main(["--self-test"]);
    assert.equal(summary.profiles.length, 3);
    const output = [];
    const exits = [];
    const success = await harness.runCli(["--self-test"], {
      mainFn: async () => summary,
      writeStdout: (value) => output.push(value),
      writeStderr: (value) => output.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(success.exitCode, 0);
    assert.equal(exits.at(-1), 0);
    assert.equal(JSON.parse(output.at(-1)).populationPerProfile, 15);
    const failure = await harness.runCli([], {
      writeStdout: (value) => output.push(value),
      writeStderr: (value) => output.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(failure.exitCode, 1);
    assert.equal(exits.at(-1), 1);
    assert.match(failure.summary.error, /Use --self-test/);
    await assert.rejects(
      () =>
        harness.runGherkinProfile(PROFILE, {
          adapter: {
            evaluate() {
              throw "fixture failure";
            },
          },
        }),
      (error) =>
        error.code === "PIKIIO_ACTION_GHERKIN_FAILED" &&
        error.summary.failed === 15 &&
        error.summary.results.every((row) => row.error === "fixture failure"),
    );
    await assert.rejects(
      () => harness.main(["--profile", PROFILE]),
      (error) =>
        error.code === "PIKIIO_ACTION_GHERKIN_FAILED" &&
        error.summary.profile === PROFILE &&
        error.summary.mode === "product-acceptance" &&
        error.summary.failed === 15,
    );

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalExitCode = process.exitCode;
    const defaultIo = { stdout: "", stderr: "" };
    process.stdout.write = (value) => {
      defaultIo.stdout += String(value);
      return true;
    };
    process.stderr.write = (value) => {
      defaultIo.stderr += String(value);
      return true;
    };
    try {
      const defaultSuccess = await harness.runCli(["--self-test"], {
        mainFn: async () => summary,
      });
      assert.equal(defaultSuccess.exitCode, 0);
      assert.equal(JSON.parse(defaultIo.stdout).populationPerProfile, 15);
      defaultIo.stdout = "";
      const defaultFailure = await harness.runCli([]);
      assert.equal(defaultFailure.exitCode, 1);
      assert.match(JSON.parse(defaultIo.stderr).error, /Use --self-test/);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
    }
  });

  test(`${PROFILE} frozen manifest rejects schema hash corpus and fixture drift`, () => {
    {
      const fixture = frozenRoot();
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.schema = "weakened";
      writeJson(fixture.manifestPath, manifest);
      assert.throws(
        () => harness.assertFrozenFixtureManifest(fixture.root),
        /schema drifted/,
      );
    }
    {
      const fixture = frozenRoot();
      const corpusPath = path.join(
        fixture.root,
        "YLYI/07_Backtest_Cases/action-brain-cases.json",
      );
      const source = fs.readFileSync(corpusPath, "utf8");
      fs.writeFileSync(corpusPath, source.replace("AB-001", "XB-001"));
      assert.throws(
        () => harness.assertFrozenFixtureManifest(fixture.root),
        /sha256 drift/,
      );
    }
    {
      const fixture = frozenRoot();
      rewriteFrozenEntry(
        fixture.root,
        "YLYI/07_Backtest_Cases/action-brain-cases.json",
        (corpus) => corpus.cases.pop(),
      );
      assert.throws(
        () => harness.assertFrozenFixtureManifest(fixture.root),
        /count drift/,
      );
    }
    {
      const fixture = frozenRoot();
      rewriteFrozenEntry(
        fixture.root,
        "YLYI/07_Backtest_Cases/action-brain-cases.json",
        (corpus) => {
          corpus.cases[1].caseId = corpus.cases[0].caseId;
        },
      );
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.corpus.orderedCaseIds[1] = manifest.corpus.orderedCaseIds[0];
      writeJson(fixture.manifestPath, manifest);
      assert.throws(
        () => harness.assertFrozenFixtureManifest(fixture.root),
        /duplicate IDs/,
      );
    }
    {
      const fixture = frozenRoot();
      rewriteFrozenEntry(
        fixture.root,
        "YLYI/07_Backtest_Cases/action-brain-cases.json",
        (corpus) => {
          corpus.cases.find((row) => row.caseId === "AB-026").fixtureFile =
            "wrong.json";
        },
      );
      assert.throws(
        () => harness.assertFrozenFixtureManifest(fixture.root),
        /fixture binding drift/,
      );
    }
    {
      const fixture = frozenRoot();
      rewriteFrozenEntry(
        fixture.root,
        "YLYI/07_Backtest_Cases/action-brain-cases.json",
        (corpus) => {
          corpus.cases.find((row) => row.caseId === "AB-026").frozenAt =
            "2026-07-22T13:30:00.000Z";
        },
      );
      assert.throws(
        () => harness.assertFrozenFixtureManifest(fixture.root),
        /frozen clock drift/,
      );
    }
    for (const mutation of [
      (packet) => {
        packet.__fixture.evidencePoint = "unrelated";
      },
      (packet) => {
        const gates = packet.truthPacket?.gates || packet.gates;
        const index = gates.findIndex((gate) => gate.gate === "pod");
        gates.splice(index, 1);
      },
      (packet) => {
        const gates = packet.truthPacket?.gates || packet.gates;
        gates.find((gate) => gate.gate === "pod").status = "received";
      },
      (packet) => {
        packet.currentState = "POD received";
      },
      (packet) => {
        packet.__fixture.evidencePoint =
          "delivered per Virginia Ng 20:59:49Z; POD state unknown";
      },
    ]) {
      const fixture = frozenRoot();
      rewriteFrozenEntry(
        fixture.root,
        "YLYI/07_Backtest_Cases/fixtures/01480000010-at-2026-07-21T2059Z.json",
        mutation,
      );
      assert.throws(() => harness.assertFrozenFixtureManifest(fixture.root));
    }
  });
}
