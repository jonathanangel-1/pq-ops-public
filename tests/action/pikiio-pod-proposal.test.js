"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const harness = require("../../scripts/verify-pikiio-action-phase-gherkin");

const PROFILE = "ACTION-03";
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

function productRoot(profile, moduleSource, appSource = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-action-product-"));
  const spec = harness.PROFILE_SPECS[profile];
  const modulePath = path.join(root, spec.modulePath);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, moduleSource);
  fs.writeFileSync(path.join(root, "app.js"), appSource);
  return root;
}

for (const caseRow of cases) {
  test(`${PROFILE} domain ${caseRow.id}`, async () => {
    await harness.executeAcceptanceCase(PROFILE, caseRow, adapter);
  });
}

if (!productAcceptance) {
  test(`${PROFILE} harness exposes 27 corpus projections and 38 proposal invariants`, () => {
    assert.equal(cases.length, 65);
    assert.equal(
      cases.filter((row) => row.domain === "pod-proposal-corpus-projection").length,
      27,
    );
    assert.equal(cases.filter((row) => row.domain === "pod-proposal-invariant").length, 38);
  });

  test(`${PROFILE} validator kills flag-off surface drift`, () => {
    const caseRow = cases.find((row) => row.id.includes("flag-off-parity"));
    const output = harness.oracleAction03(caseRow.input);
    output.operatorSurface.proposals.push({ id: "leaked" });
    assert.throws(
      () => harness.validateAction03(caseRow.input, output, output, caseRow.expected),
      /flag-off surface changed/,
    );
  });

  test(`${PROFILE} validator kills API and view-model disagreement`, () => {
    const caseRow = cases.find((row) => row.id.includes("api-view-id-parity"));
    const output = harness.oracleAction03(caseRow.input);
    output.viewModel.proposal.id = "wrong";
    assert.throws(
      () => harness.validateAction03(caseRow.input, output, output, caseRow.expected),
      /API\/view-model proposal parity failed/,
    );
  });

  test(`${PROFILE} validator kills POD-received wording minted from a promise`, () => {
    const caseRow = cases.find((row) => row.id.includes("promise-renders-pending"));
    const output = harness.oracleAction03(caseRow.input);
    output.api.proposal.status = "POD received";
    output.viewModel.proposal.status = "POD received";
    assert.throws(
      () => harness.validateAction03(caseRow.input, output, output, caseRow.expected),
      /POD pending|POD received/i,
    );
  });

  test(`${PROFILE} validator kills truth mutation during local dismissal`, () => {
    const caseRow = cases.find((row) =>
      row.id.includes("dismiss-does-not-rewrite-truth"),
    );
    const output = harness.oracleAction03(caseRow.input);
    output.truthPacketHashAfter = "0".repeat(64);
    assert.throws(
      () => harness.validateAction03(caseRow.input, output, output, caseRow.expected),
      /Expected values to be strictly equal/,
    );
  });

  test(`${PROFILE} product adapters execute only across the bounded child boundary`, async () => {
    const actionRoot = productRoot(
      "ACTION-01",
      `"use strict";
module.exports.buildClaimNativeActionPlan = (input) => ({
  schema: "child-ok",
  shipmentId: input.shipmentId
});
`,
    );
    const actionAdapter = harness.loadProductAdapter("ACTION-01", actionRoot);
    assert.deepEqual(actionAdapter.evaluate({ shipmentId: "s-1" }), {
      schema: "child-ok",
      shipmentId: "s-1",
    });
    const noExportRoot = productRoot("ACTION-01", "module.exports = {};\n");
    assert.throws(
      () =>
        harness
          .loadProductAdapter("ACTION-01", noExportRoot)
          .evaluate({ shipmentId: "s-1" }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_FAILED" },
    );
    assert.throws(
      () => harness.loadProductAdapter("ACTION-02", actionRoot),
      { code: "PIKIIO_ACTION_PRODUCT_INTERFACE_MISSING" },
    );
    const partialUiRoot = productRoot(
      PROFILE,
      "module.exports.buildPodProposalProjection = (input) => input;\n",
      "const PIKIIO_POD_PROPOSAL_ENABLED = false;\n",
    );
    assert.throws(
      () => harness.loadProductAdapter(PROFILE, partialUiRoot),
      { code: "PIKIIO_ACTION_UI_BINDING_MISSING" },
    );
    const uiRoot = productRoot(
      PROFILE,
      "module.exports.buildPodProposalProjection = (input) => input;\n",
      "const PIKIIO_POD_PROPOSAL_ENABLED = false;\nvoid buildPodProposalProjection;\n",
    );
    const uiAdapter = harness.loadProductAdapter(PROFILE, uiRoot);
    assert.deepEqual(uiAdapter.evaluate({ safe: true }), { safe: true });
    assert.throws(
      () => uiAdapter.evaluate({ payload: "x".repeat(300_000) }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_INPUT_OVERSIZE" },
    );
    const envelope = await harness.runProductAdapterChild(
      "ACTION-01",
      actionRoot,
      JSON.stringify({
        schema: "pikiio-product-adapter-child-request-v1",
        profile: "ACTION-01",
        input: { shipmentId: "direct" },
      }),
      {
        requireFn: () => ({
          buildClaimNativeActionPlan: (input) => ({
            schema: "child-ok",
            shipmentId: input.shipmentId,
          }),
        }),
      },
    );
    assert.equal(envelope.output.shipmentId, "direct");
    await assert.rejects(
      () => harness.runProductAdapterChild("ACTION-01", actionRoot, ""),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_REQUEST_INVALID" },
    );
    await assert.rejects(
      () =>
        harness.runProductAdapterChild(
          "ACTION-01",
          actionRoot,
          JSON.stringify({
            schema: "wrong",
            profile: "ACTION-01",
            input: {},
          }),
        ),
      /Expected values to be strictly equal/,
    );
    await assert.rejects(
      () =>
        harness.runProductAdapterChild(
          "ACTION-01",
          noExportRoot,
          JSON.stringify({
            schema: "pikiio-product-adapter-child-request-v1",
            profile: "ACTION-01",
            input: {},
          }),
          { requireFn: () => ({}) },
        ),
      { code: "PIKIIO_ACTION_PRODUCT_INTERFACE_MISSING" },
    );
  });

  test(`${PROFILE} malicious product monkeypatches cannot alter parent assertions`, () => {
    const originalReadFile = fs.readFileSync;
    const maliciousRoot = productRoot(
      "ACTION-01",
      `"use strict";
module.exports.buildClaimNativeActionPlan = () => {
  require("node:assert/strict").deepEqual = () => true;
  require("node:fs").readFileSync = () => Buffer.from("{}");
  JSON.stringify = () => "{\\"forged\\":true}";
  Buffer.byteLength = () => 0;
  process.exitCode = 0;
  process.stdout.write = () => true;
  return { schema: "forged-self-certification", productionEnabled: true };
};
`,
    );
    const output = harness
      .loadProductAdapter("ACTION-01", maliciousRoot)
      .evaluate({ shipmentId: "attack" });
    assert.equal(output.schema, "forged-self-certification");
    assert.equal(fs.readFileSync, originalReadFile);
    assert.throws(() => assert.deepEqual({ safe: true }, { safe: false }));
    const caseRow = harness
      .acceptanceCases("ACTION-01")
      .find((row) => row.id.includes("default-off-zero-writes"));
    assert.throws(() =>
      harness.validateAction01(caseRow.input, output, output, caseRow.expected),
    );
    const noisyRoot = productRoot(
      "ACTION-01",
      `module.exports.buildClaimNativeActionPlan = () => {
  process.stdout.write("attacker-noise");
  return { schema: "forged" };
};\n`,
    );
    assert.throws(
      () =>
        harness
          .loadProductAdapter("ACTION-01", noisyRoot)
          .evaluate({ shipmentId: "noise" }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_MALFORMED" },
    );
    const exitingRoot = productRoot(
      "ACTION-01",
      `module.exports.buildClaimNativeActionPlan = () => process.exit(0);\n`,
    );
    assert.throws(
      () =>
        harness
          .loadProductAdapter("ACTION-01", exitingRoot)
          .evaluate({ shipmentId: "exit" }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_MALFORMED" },
    );
  });

  test(`${PROFILE} parent parser rejects child timeout crash stderr overflow and forged envelopes`, () => {
    const good = {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        schema: "pikiio-product-adapter-child-result-v1",
        profile: PROFILE,
        ok: true,
        output: { safe: true },
      }),
      stderr: "",
    };
    assert.deepEqual(
      harness.parseProductAdapterChildResult(PROFILE, good),
      { safe: true },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          error: { code: "ETIMEDOUT" },
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_TIMEOUT" },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          signal: "SIGKILL",
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_CRASHED" },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          error: new Error("spawn"),
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_CRASHED" },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          status: 0,
          stdout: "x".repeat(1_048_577),
          stderr: "",
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_OUTPUT_OVERSIZE" },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          status: 0,
          stdout: good.stdout,
          stderr: "product warning",
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_FAILED" },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          status: 2,
          stdout: "",
          stderr: "",
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_FAILED" },
    );
    assert.throws(
      () =>
        harness.parseProductAdapterChildResult(PROFILE, {
          status: 0,
          stdout: "not-json",
          stderr: "",
        }),
      { code: "PIKIIO_ACTION_PRODUCT_CHILD_MALFORMED" },
    );
    for (const badEnvelope of [
      { ...JSON.parse(good.stdout), extra: true },
      { ...JSON.parse(good.stdout), schema: "wrong" },
      { ...JSON.parse(good.stdout), profile: "ACTION-01" },
      { ...JSON.parse(good.stdout), ok: false },
    ]) {
      assert.throws(() =>
        harness.parseProductAdapterChildResult(PROFILE, {
          ...good,
          stdout: JSON.stringify(badEnvelope),
        }),
      );
    }
  });

  test(`${PROFILE} product child CLI has exact success and failure receipts`, async () => {
    const root = productRoot(
      "ACTION-01",
      "module.exports.buildClaimNativeActionPlan = (input) => input;\n",
    );
    const request = JSON.stringify({
      schema: "pikiio-product-adapter-child-request-v1",
      profile: "ACTION-01",
      input: { child: true },
    });
    const stdout = [];
    const stderr = [];
    const exits = [];
    const success = await harness.runProductAdapterChildCli(
      [
        "--product-adapter-child",
        "--profile",
        "ACTION-01",
        "--root",
        root,
      ],
      {
        readStdin: () => request,
        requireFn: () => ({
          buildClaimNativeActionPlan: (input) => input,
        }),
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
        setExitCode: (value) => exits.push(value),
      },
    );
    assert.equal(success.exitCode, 0);
    assert.equal(exits.at(-1), 0);
    assert.equal(JSON.parse(stdout.at(-1)).output.child, true);
    const failure = await harness.runProductAdapterChildCli([], {
      readStdin: () => request,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exits.push(value),
    });
    assert.equal(failure.exitCode, 2);
    assert.equal(exits.at(-1), 2);
    assert.equal(
      JSON.parse(stderr.at(-1)).code,
      "PIKIIO_ACTION_PRODUCT_CHILD_ARGUMENT_INVALID",
    );
    const oversizeRoot = productRoot(
      "ACTION-01",
      `module.exports.buildClaimNativeActionPlan = () => ({
  payload: "x".repeat(1100000)
});\n`,
    );
    const oversize = await harness.runProductAdapterChildCli(
      [
        "--product-adapter-child",
        "--profile",
        "ACTION-01",
        "--root",
        oversizeRoot,
      ],
      {
        readStdin: () => request,
        requireFn: () => ({
          buildClaimNativeActionPlan: () => ({
            payload: "x".repeat(1_100_000),
          }),
        }),
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
        setExitCode: (value) => exits.push(value),
      },
    );
    assert.equal(oversize.exitCode, 2);
    assert.equal(
      JSON.parse(stderr.at(-1)).code,
      "PIKIIO_ACTION_PRODUCT_CHILD_OUTPUT_OVERSIZE",
    );

    const originalReadFileSync = fs.readFileSync;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalExitCode = process.exitCode;
    const defaultIo = { stdout: "", stderr: "" };
    fs.readFileSync = (target, ...args) =>
      target === 0 ? request : originalReadFileSync(target, ...args);
    process.stdout.write = (value) => {
      defaultIo.stdout += String(value);
      return true;
    };
    process.stderr.write = (value) => {
      defaultIo.stderr += String(value);
      return true;
    };
    try {
      const defaultSuccess = await harness.runProductAdapterChildCli(
        [
          "--product-adapter-child",
          "--profile",
          "ACTION-01",
          "--root",
          root,
        ],
        {
          requireFn: () => ({
            buildClaimNativeActionPlan: (input) => input,
          }),
        },
      );
      assert.equal(defaultSuccess.exitCode, 0);
      assert.equal(JSON.parse(defaultIo.stdout).output.child, true);
      const defaultFailure = await harness.runProductAdapterChildCli([]);
      assert.equal(defaultFailure.exitCode, 2);
      assert.equal(
        JSON.parse(defaultIo.stderr).code,
        "PIKIIO_ACTION_PRODUCT_CHILD_ARGUMENT_INVALID",
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
    }
  });
}
