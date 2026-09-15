"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const harness = require("../../scripts/verify-pikiio-action-phase-gherkin");
const mutation = require("../../scripts/mutate-pikiio-action-phase");
const mutantProbe = require("../pikiio-action-phase-mutant-probe");

const PROFILE = "ACTION-02";
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

for (const caseRow of cases) {
  test(`${PROFILE} domain ${caseRow.id}`, async () => {
    await harness.executeAcceptanceCase(PROFILE, caseRow, adapter);
  });
}

if (!productAcceptance) {
  test(`${PROFILE} harness exposes 27 corpus receipts and 38 shadow invariants`, () => {
    assert.equal(cases.length, 65);
    assert.equal(cases.filter((row) => row.domain === "shadow-corpus-receipt").length, 27);
    assert.equal(cases.filter((row) => row.domain === "action-shadow-invariant").length, 38);
  });

  test(`${PROFILE} validator kills action-queue drift`, () => {
    const caseRow = cases[0];
    const output = harness.oracleAction02(caseRow.input);
    output.afterHashes.actionQueue = "0".repeat(64);
    assert.throws(
      () => harness.validateAction02(caseRow.input, output, output, caseRow.expected),
      /afterHashes|frozen-action-queue|deep-equal/i,
    );
  });

  test(`${PROFILE} validator kills missing corpus receipts`, () => {
    const caseRow = cases[0];
    const output = harness.oracleAction02(caseRow.input);
    output.comparisons.pop();
    assert.throws(
      () => harness.validateAction02(caseRow.input, output, output, caseRow.expected),
      /population|exactly one shadow receipt/i,
    );
  });

  test(`${PROFILE} validator kills ignored unsafe recipient findings`, () => {
    const caseRow = cases.find((row) => row.id.includes("unsafe-recipient-fails"));
    const output = harness.oracleAction02(caseRow.input);
    output.status = "passed";
    output.findings = [];
    assert.throws(
      () => harness.validateAction02(caseRow.input, output, output, caseRow.expected),
      /Expected values to be strictly equal|UNSAFE_RECIPIENT/,
    );
  });

  test(`${PROFILE} content-addressed receipt cannot be forged`, () => {
    const caseRow = cases[0];
    const output = harness.oracleAction02(caseRow.input);
    output.receiptHash = "f".repeat(64);
    assert.throws(
      () => harness.validateAction02(caseRow.input, output, output, caseRow.expected),
      /Expected values to be strictly equal/,
    );
  });

  test(`${PROFILE} duplicate corpus receipts are generated then rejected`, () => {
    const caseRow = cases[0];
    const input = {
      ...caseRow.input,
      duplicateCaseId: caseRow.input.comparisons[0].caseId,
    };
    const output = harness.oracleAction02(input);
    assert.equal(output.comparisons.length, 28);
    assert.throws(
      () => harness.validateAction02(input, output, output, caseRow.expected),
      /population|exactly one shadow receipt/i,
    );
  });

  test(`${PROFILE} all phase mutant operators are executable and unambiguous`, async () => {
    for (const profile of harness.PROFILE_IDS) {
      const mutants = mutation.validateMutationDefinitions(profile);
      const profileCases = harness.acceptanceCases(profile);
      const profileOracle = harness.createOracleAdapter(profile);
      assert.equal(mutants.length, 20);
      for (let index = 0; index < mutants.length; index += 1) {
        const mutant = mutants[index];
        const options =
          index === 0
            ? {}
            : {
                validateMutationDefinitionsFn: () => mutants,
                acceptanceCasesFn: () => profileCases,
                adapter: profileOracle,
              };
        const result = await mutantProbe.main(
          ["--profile", profile, "--mutant", mutant.id],
          options,
        );
        assert.equal(result.exitCode, 0, `${profile}/${mutant.id}`);
        assert.equal(result.receipt.classification, "killed");
        assert.equal(result.receipt.fingerprint, mutant.fingerprint);
      }
      const control = await mutantProbe.main(
        ["--profile", profile, "--control-survivor"],
        {
          validateMutationDefinitionsFn: () => mutants,
          acceptanceCasesFn: () => profileCases,
          adapter: profileOracle,
        },
      );
      assert.equal(control.exitCode, 1);
      assert.equal(control.receipt.classification, "survived");
    }
    await assert.rejects(
      () => mutantProbe.main([]),
      { code: "PIKIIO_ACTION_MUTANT_ARGUMENT_INVALID" },
    );
    await assert.rejects(
      () =>
        mutantProbe.main([
          "--profile",
          PROFILE,
          "--mutant",
          "unknown-mutant",
        ]),
      { code: "PIKIIO_ACTION_MUTANT_UNKNOWN" },
    );
    const known = mutation.MUTANTS[PROFILE][0];
    await assert.rejects(
      () =>
        mutantProbe.main(
          ["--profile", PROFILE, "--mutant", known.id],
          { acceptanceCasesFn: () => [] },
        ),
      { code: "PIKIIO_ACTION_MUTANT_TARGET_MISSING" },
    );
    await assert.rejects(
      () =>
        mutantProbe.main(
          ["--profile", PROFILE, "--mutant", known.id, "--product"],
          {
            loadProductAdapterFn() {
              throw new Error("product gap");
            },
          },
        ),
      /product gap/,
    );
  });

  test(`${PROFILE} mutant classifier rejects crashes timeouts and forged receipts`, () => {
    const expected = {
      profile: PROFILE,
      id: "m1",
      fingerprint: "fingerprint-1",
    };
    const receipt = {
      schema: "pikiio-action-mutant-classification-v1",
      profile: PROFILE,
      mutantId: expected.id,
      fingerprint: expected.fingerprint,
      classification: "killed",
      error: "caught",
    };
    assert.equal(
      mutation.classifyProbe(
        { status: 0, stdout: JSON.stringify(receipt), stderr: "" },
        expected,
      ).classification,
      "killed",
    );
    const survived = { ...receipt, classification: "survived", error: null };
    assert.equal(
      mutation.classifyProbe(
        { status: 1, stdout: JSON.stringify(survived), stderr: "" },
        expected,
      ).classification,
      "survived",
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          { status: null, error: { code: "ETIMEDOUT" }, stdout: "" },
          expected,
        ),
      { code: "PIKIIO_ACTION_MUTANT_PROBE_TIMEOUT" },
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          { status: null, signal: "SIGKILL", stdout: "" },
          expected,
        ),
      { code: "PIKIIO_ACTION_MUTANT_PROBE_CRASHED" },
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          { status: null, error: new Error("spawn failed"), stdout: "" },
          expected,
        ),
      { code: "PIKIIO_ACTION_MUTANT_PROBE_CRASHED" },
    );
    assert.throws(
      () => mutation.classifyProbe({ status: 2, stdout: "" }, expected),
      /one JSON receipt/,
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          {
            status: 0,
            stdout: `${JSON.stringify(receipt)}\n${JSON.stringify(receipt)}`,
          },
          expected,
        ),
      /one JSON receipt/,
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          {
            status: 0,
            stdout: JSON.stringify({
              ...receipt,
              fingerprint: "wrong-fingerprint",
            }),
          },
          expected,
        ),
      /Expected values to be strictly equal/,
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          {
            status: 1,
            stdout: JSON.stringify(receipt),
          },
          expected,
        ),
      /exit status and classifier disagree/,
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          { status: 0, stdout: "{not-json", stderr: "" },
          expected,
        ),
      SyntaxError,
    );
    assert.throws(
      () =>
        mutation.classifyProbe(
          {
            status: 0,
            stdout: JSON.stringify({
              ...receipt,
              classification: "ambiguous",
            }),
          },
          expected,
        ),
      /ambiguous classifier output/,
    );
  });

  test(`${PROFILE} mutation runner and CLI cover success red and classifier meta paths`, async () => {
    const killedResult = (profile, mutant) => ({
      status: 0,
      stdout: JSON.stringify({
        schema: "pikiio-action-mutant-classification-v1",
        profile,
        mutantId: mutant.id,
        fingerprint: mutant.fingerprint,
        classification: "killed",
        error: "killed",
      }),
      stderr: "",
    });
    const metaSpawn = (_node, args) => {
      if (args.includes("--control-survivor")) {
        const profile = args[args.indexOf("--profile") + 1];
        return {
          status: 1,
          stdout: JSON.stringify({
            schema: "pikiio-action-mutant-classification-v1",
            profile,
            mutantId: "classifier-control",
            fingerprint: "no-mutation",
            classification: "survived",
            error: null,
          }),
          stderr: "",
        };
      }
      return {
        status: 2,
        stdout: "",
        stderr: JSON.stringify({
          error: "unknown",
          code: "PIKIIO_ACTION_MUTANT_UNKNOWN",
        }),
      };
    };
    const summary = mutation.runMutationProfile(PROFILE, {
      product: false,
      spawnSyncFn: metaSpawn,
      runProbeFn: (profile, mutant) => killedResult(profile, mutant),
    });
    assert.equal(summary.killed, 20);
    assert.equal(summary.classifierMeta.ambiguityCount, 0);
    assert.throws(
      () =>
        mutation.runMutationProfile(PROFILE, {
          product: false,
          spawnSyncFn: metaSpawn,
          runProbeFn: (profile, mutant) => ({
            status: 1,
            stdout: JSON.stringify({
              ...JSON.parse(killedResult(profile, mutant).stdout),
              classification: "survived",
              error: null,
            }),
          }),
        }),
      { code: "PIKIIO_ACTION_MUTANTS_SURVIVED" },
    );
    assert.throws(
      () => mutation.runMutationProfile(PROFILE, { product: true }),
      { code: "PIKIIO_ACTION_MUTATION_SURFACE_MISSING" },
    );
    assert.throws(
      () => mutation.main(["--profile", PROFILE]),
      { code: "PIKIIO_ACTION_MUTATION_SURFACE_MISSING" },
    );
    assert.throws(() => mutation.main([]), /Use --self-test/);
    assert.throws(
      () => mutation.main(["--self-test", "--profile", PROFILE]),
      /mutually exclusive/,
    );
    const fakeSummary = {
      schema: "fake-mutation-summary",
      total: 20,
      killed: 20,
    };
    const mainSelf = mutation.main(["--self-test"], {
      runMutationProfileFn: () => fakeSummary,
    });
    assert.equal(mainSelf.profiles.length, 3);
    const mainProduct = mutation.main(["--profile", PROFILE], {
      runMutationProfileFn: (_profile, options) => ({
        ...fakeSummary,
        product: options.product,
      }),
    });
    assert.equal(mainProduct.product, true);

    const fakeProductRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-action-mutation-product-"),
    );
    const fakeProductPath = path.join(
      fakeProductRoot,
      harness.PROFILE_SPECS[PROFILE].modulePath,
    );
    fs.mkdirSync(path.dirname(fakeProductPath), { recursive: true });
    fs.writeFileSync(
      fakeProductPath,
      "module.exports.evaluateActionShadowBatch = () => ({ preflight: true });\n",
    );
    const productSpawnArgs = [];
    const productSummary = mutation.runMutationProfile(PROFILE, {
      product: true,
      root: fakeProductRoot,
      timeoutMs: 1234,
      spawnSyncFn: (_node, args, options) => {
        productSpawnArgs.push({ args, options });
        return metaSpawn(_node, args);
      },
      runProbeFn: (profile, mutant) => killedResult(profile, mutant),
    });
    assert.equal(productSummary.mode, "product-acceptance");
    assert.ok(
      productSpawnArgs.some((row) => row.args.includes("--product")),
      "classifier survivor control must retain product mode",
    );
    assert.ok(
      productSpawnArgs.every(
        (row) =>
          row.options.cwd === fakeProductRoot &&
          row.options.timeout === 1234,
      ),
    );
    const productProbe = mutation.runProbe(PROFILE, mutation.MUTANTS[PROFILE][0], {
      product: true,
      root: fakeProductRoot,
      timeoutMs: 4321,
      spawnSyncFn: (_node, args, options) => ({ args, options }),
    });
    assert.ok(productProbe.args.includes("--product"));
    assert.equal(productProbe.options.cwd, fakeProductRoot);
    assert.equal(productProbe.options.timeout, 4321);

    const stdout = [];
    const stderr = [];
    const exits = [];
    const cliSuccess = mutation.runCli(["--self-test"], {
      runMutationProfileFn: () => fakeSummary,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(cliSuccess.exitCode, 0);
    assert.equal(exits.at(-1), 0);
    const cliFailure = mutation.runCli([], {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(cliFailure.exitCode, 1);
    assert.equal(exits.at(-1), 1);
    assert.ok(stderr.length);
    const cliProductGap = mutation.runCli(["--profile", PROFILE], {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(cliProductGap.exitCode, 1);
    assert.equal(cliProductGap.summary.executed, 0);
    const cliStringFailure = mutation.runCli(["--profile", PROFILE], {
      runMutationProfileFn() {
        throw "string mutation failure";
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.deepEqual(cliStringFailure.summary, {
      error: "string mutation failure",
      code: null,
    });
    const real = mutation.runProbe("ACTION-01", mutation.MUTANTS["ACTION-01"][0]);
    assert.equal(
      mutation.classifyProbe(real, {
        ...mutation.MUTANTS["ACTION-01"][0],
        profile: "ACTION-01",
      }).classification,
      "killed",
    );
    const cliOutput = [];
    const probeCli = await mutantProbe.runCli(
      ["--profile", PROFILE, "--control-survivor"],
      {
        writeStdout: (value) => cliOutput.push(value),
        writeStderr: (value) => cliOutput.push(value),
        setExitCode: (value) => exits.push(value),
      },
    );
    assert.equal(probeCli.exitCode, 1);
    const probeFailure = await mutantProbe.runCli([], {
      writeStdout: (value) => cliOutput.push(value),
      writeStderr: (value) => cliOutput.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(probeFailure.exitCode, 2);

    const known = mutation.MUTANTS[PROFILE][0];
    const oracle = harness.createOracleAdapter(PROFILE);
    const dependencyResult = await mutantProbe.main(
      ["--profile", PROFILE, "--mutant", known.id],
      {
        validateMutationDefinitionsFn: () => mutation.MUTANTS[PROFILE],
        acceptanceCasesFn: () => cases,
        adapter: oracle,
      },
    );
    assert.equal(dependencyResult.receipt.classification, "killed");
    const factoryResult = await mutantProbe.main(
      ["--profile", PROFILE, "--mutant", known.id],
      {
        createOracleAdapterFn: () => oracle,
      },
    );
    assert.equal(factoryResult.receipt.classification, "killed");
    const productLoaderResult = await mutantProbe.main(
      ["--profile", PROFILE, "--mutant", known.id, "--product"],
      {
        loadProductAdapterFn: () => oracle,
      },
    );
    assert.equal(productLoaderResult.receipt.classification, "killed");
    const throwingProxy = new Proxy({}, {
      get(_target, property) {
        if (property === "then") return undefined;
        throw "non-error validator failure";
      },
    });
    const nonErrorResult = await mutantProbe.main(
      ["--profile", PROFILE, "--control-survivor"],
      {
        adapter: {
          async evaluate() {
            return throwingProxy;
          },
        },
      },
    );
    assert.equal(nonErrorResult.receipt.classification, "killed");
    assert.equal(nonErrorResult.receipt.error, "non-error validator failure");

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
      const defaultProbeSuccess = await mutantProbe.runCli([
        "--profile",
        PROFILE,
        "--control-survivor",
      ]);
      assert.equal(defaultProbeSuccess.exitCode, 1);
      assert.equal(JSON.parse(defaultIo.stdout).classification, "survived");
      const defaultProbeFailure = await mutantProbe.runCli([]);
      assert.equal(defaultProbeFailure.exitCode, 2);
      assert.equal(
        JSON.parse(defaultIo.stderr).code,
        "PIKIIO_ACTION_MUTANT_ARGUMENT_INVALID",
      );

      defaultIo.stdout = "";
      defaultIo.stderr = "";
      const defaultMutationSuccess = mutation.runCli(["--self-test"], {
        runMutationProfileFn: () => fakeSummary,
      });
      assert.equal(defaultMutationSuccess.exitCode, 0);
      assert.equal(
        JSON.parse(defaultIo.stdout).populationPerProfile,
        mutation.CRITICAL_MUTATION_POPULATION,
      );
      const defaultMutationFailure = mutation.runCli([]);
      assert.equal(defaultMutationFailure.exitCode, 1);
      assert.match(JSON.parse(defaultIo.stderr).error, /Use --self-test/);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
    }
  });
}
