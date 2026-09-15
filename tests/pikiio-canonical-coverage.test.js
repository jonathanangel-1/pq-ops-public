"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const coverage = require("../lib/pikiio-canonical-coverage");
const coverageCli = require("../scripts/pikiio-canonical-coverage");

let deterministicFixtureIndex = 0;

function canonicalTemporaryRoot(t) {
  if (process.env.PIKIIO_CANONICAL_COVERAGE_FIXTURE_ROOT) {
    const base = fs.realpathSync.native(
      process.env.PIKIIO_CANONICAL_COVERAGE_FIXTURE_ROOT,
    );
    const root = path.join(
      base,
      `fixture-${String(deterministicFixtureIndex++).padStart(4, "0")}`,
    );
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    return fs.realpathSync.native(root);
  }
  const canonicalTmp = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(
    path.join(canonicalTmp, "pikiio-canonical-coverage-"),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return fs.realpathSync.native(root);
}

function makeFixture(t, sourceText = "abcdefghijkl") {
  const root = canonicalTemporaryRoot(t);
  const sourcePath = path.join(root, "target.js");
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  const url = pathToFileURL(sourcePath).href;
  const rawDirectory = path.join(root, "raw");
  fs.mkdirSync(rawDirectory, { mode: 0o700 });
  fs.chmodSync(rawDirectory, 0o700);
  return {
    root,
    sourcePath,
    sourceText,
    url,
    rawDirectory,
    target: { id: "target", sourcePath },
  };
}

function blockFunction(
  functionName,
  sourceLength,
  ranges = [],
  rootCount = 1,
) {
  return {
    functionName,
    ranges: [
      { startOffset: 0, endOffset: sourceLength, count: rootCount },
      ...ranges,
    ],
    isBlockCoverage: true,
  };
}

function targetScript(fixture, {
  scriptId = "1",
  ranges = [],
  rootCount = 1,
  extraFunctions = [],
} = {}) {
  return {
    scriptId,
    url: fixture.url,
    functions: [
      blockFunction("", fixture.sourceText.length, [], rootCount),
      blockFunction(
        "validatePhaseLedger",
        fixture.sourceText.length,
        ranges,
        rootCount,
      ),
      ...extraFunctions,
    ],
  };
}

function rawPayload(scripts, timestamp = 1234.5) {
  return { result: scripts, timestamp };
}

function rawName(index) {
  return `coverage-${1000 + index}-${1700000000000 + index}-${index}.json`;
}

function writeRaw(directory, index, payload) {
  const file = path.join(directory, rawName(index));
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function writeRawText(directory, index, text) {
  const file = path.join(directory, rawName(index));
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function reduceFixture(fixture) {
  return coverage.reduceCanonicalCoverage({
    rawDirectory: fixture.rawDirectory,
    targets: [fixture.target],
  });
}

function errorCode(callback) {
  assert.throws(callback, (error) => {
    assert.equal(error.name, "CanonicalCoverageError");
    assert.equal(typeof error.code, "string");
    errorCode.observed = error.code;
    return true;
  });
  return errorCode.observed;
}

function withPatched(object, key, replacement, callback) {
  const original = object[key];
  object[key] = replacement;
  try {
    return callback();
  } finally {
    object[key] = original;
  }
}

function alteredStat(stat, changes = {}) {
  return {
    ...stat,
    ...changes,
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink(),
  };
}

function stableTestJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableTestValue));
  return JSON.stringify(stableTestValue(value));
}

function stableTestValue(value) {
  if (Array.isArray(value)) return value.map(stableTestValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableTestValue(value[key])]),
  );
}

function testSha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function rehashReport(report) {
  const projection = {
    schema: report.schema,
    reducer: report.reducer,
    bounds: report.bounds,
    percentagePolicy: report.percentagePolicy,
    semanticInputManifest: report.semanticInputManifest,
    targets: report.targets.map((target) => {
      const { sourcePath, url, ...semanticTarget } = target;
      return semanticTarget;
    }),
    totals: report.totals,
  };
  report.semanticCoverageSha256 = testSha256(stableTestJson(projection));
  const withoutEvidence = { ...report };
  delete withoutEvidence.evidenceReportSha256;
  report.evidenceReportSha256 = testSha256(stableTestJson(withoutEvidence));
  return report;
}

function naiveNodeRangeMerge(observations, order) {
  function merge(oldRanges, newRanges) {
    const merged = new Set();
    for (const oldRange of oldRanges) {
      if (oldRange.count > 0) merged.add(oldRange);
    }
    for (const newRange of newRanges) {
      let exactMatch = false;
      for (const oldRange of oldRanges) {
        if (
          newRange.startOffset === oldRange.startOffset &&
          newRange.endOffset === oldRange.endOffset
        ) {
          oldRange.count += newRange.count;
          merged.add(oldRange);
          exactMatch = true;
          break;
        }
        if (oldRange.count === 0 && newRange.count === 0) {
          if (
            oldRange.startOffset <= newRange.startOffset &&
            oldRange.endOffset >= newRange.endOffset
          ) {
            merged.add(newRange);
          } else if (
            newRange.startOffset <= oldRange.startOffset &&
            newRange.endOffset >= oldRange.endOffset
          ) {
            merged.add(oldRange);
          }
        }
      }
      if (newRange.count > 0 && !exactMatch) merged.add(newRange);
    }
    return [...merged];
  }

  let merged = observations[order[0]].map((range) => ({ ...range }));
  for (const index of order.slice(1)) {
    merged = merge(
      merged,
      observations[index].map((range) => ({ ...range })),
    );
  }
  return merged;
}

test("nested-zero backtest reproduces native order defect and canonicalizes every permutation", (t) => {
  const fixture = makeFixture(t);
  const zeros = [
    { startOffset: 1, endOffset: 4, count: 0 },
    { startOffset: 2, endOffset: 5, count: 0 },
    { startOffset: 3, endOffset: 4, count: 0 },
  ];
  const observations = zeros.map((zero) => [
    { startOffset: 0, endOffset: fixture.sourceText.length, count: 1 },
    zero,
  ]);
  assert.equal(
    naiveNodeRangeMerge(observations, [0, 1, 2]).length,
    1,
  );
  assert.equal(
    naiveNodeRangeMerge(observations, [2, 1, 0]).length,
    2,
  );

  const directories = [fixture.rawDirectory];
  for (let index = 1; index < 4; index++) {
    const directory = path.join(fixture.root, `raw-${index}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    directories.push(directory);
  }
  const permutations = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
    [2, 0, 1],
  ];
  const reports = permutations.map((permutation, permutationIndex) => {
    for (const [fileIndex, observationIndex] of permutation.entries()) {
      const nonTarget = {
        scriptId: String(8000 + permutationIndex * 10 + fileIndex),
        url: "node:diagnostic",
        functions: [],
      };
      writeRaw(
        directories[permutationIndex],
        fileIndex,
        rawPayload(
          [
            targetScript(fixture, {
              scriptId: String(9000 + permutationIndex * 10 + fileIndex),
              ranges: [zeros[observationIndex]],
            }),
            nonTarget,
          ],
          1000 + permutationIndex * 100 + fileIndex,
        ),
      );
    }
    return coverage.reduceCanonicalCoverage({
      rawDirectory: directories[permutationIndex],
      targets: [fixture.target],
    });
  });

  for (const report of reports) {
    assert.equal(
      report.semanticCoverageSha256,
      reports[0].semanticCoverageSha256,
    );
    assert.deepEqual(report.targets, reports[0].targets);
    assert.deepEqual(
      report.semanticInputManifest,
      reports[0].semanticInputManifest,
    );
    assert.equal(report.rawInventory.nonTargetScriptObservationCount, 3);
    assert.equal(report.targets[0].metrics.branches.covered, 4);
    assert.equal(report.targets[0].metrics.branches.total, 5);
    assert.equal(
      report.targets[0].metrics.branches.percentageDisplay,
      "80.00",
    );
    const named = report.targets[0].functions.find(
      (fn) => fn.functionName === "validatePhaseLedger",
    );
    assert.deepEqual(named.ranges, [
      { startOffset: 0, endOffset: 12, count: 3 },
      { startOffset: 1, endOffset: 4, count: 2 },
      { startOffset: 2, endOffset: 5, count: 2 },
      { startOffset: 3, endOffset: 4, count: 0 },
    ]);
    assert.deepEqual(named.uncoveredIntervals, [
      { startOffset: 3, endOffset: 4 },
    ]);
    coverage.validateCanonicalCoverageReport(report);
  }
});

test("manifest excludes filename, timestamp, and scriptId but preserves payload multiplicity", (t) => {
  const fixture = makeFixture(t);
  const script = targetScript(fixture, { scriptId: "10" });
  writeRaw(fixture.rawDirectory, 0, rawPayload([script], 1));
  writeRaw(
    fixture.rawDirectory,
    1,
    rawPayload([{ ...script, scriptId: "999" }], 999999),
  );
  const report = reduceFixture(fixture);
  assert.equal(report.rawEvidenceManifest.fileCount, 2);
  assert.equal(report.rawEvidenceManifest.uniqueRawFileCount, 2);
  assert.equal(report.semanticInputManifest.targetPayloadCount, 2);
  assert.equal(report.semanticInputManifest.uniquePayloadCount, 1);
  assert.equal(report.semanticInputManifest.entries[0].multiplicity, 2);
  assert.equal(report.targets[0].functions[0].ranges[0].count, 2);
  assert.equal(report.targets[0].functions[1].ranges[0].count, 2);
});

test("semantic identity is detached-worktree stable while exact raw/path evidence remains distinct", (t) => {
  const left = makeFixture(t);
  const right = makeFixture(t);
  const leftNonTarget = {
    scriptId: "700",
    url: "file:///left-only/non-target.js",
    functions: [],
  };
  const rightNonTarget = {
    scriptId: "800",
    url: "file:///right-only/non-target.js",
    functions: [],
  };
  writeRaw(
    left.rawDirectory,
    0,
    rawPayload(
      [targetScript(left, { scriptId: "1" }), leftNonTarget],
      111,
    ),
  );
  writeRaw(
    right.rawDirectory,
    0,
    rawPayload(
      [targetScript(right, { scriptId: "999" }), rightNonTarget],
      999,
    ),
  );
  const leftReport = reduceFixture(left);
  const rightReport = reduceFixture(right);
  assert.equal(
    leftReport.semanticCoverageSha256,
    rightReport.semanticCoverageSha256,
  );
  assert.deepEqual(
    leftReport.semanticInputManifest,
    rightReport.semanticInputManifest,
  );
  assert.notDeepEqual(
    leftReport.rawEvidenceManifest,
    rightReport.rawEvidenceManifest,
  );
  assert.notEqual(
    leftReport.evidenceReportSha256,
    rightReport.evidenceReportSha256,
  );
  assert.notEqual(leftReport.targets[0].url, rightReport.targets[0].url);
});

test("block coverage commutatively supersedes non-block detail and global stays first", (t) => {
  const fixture = makeFixture(t);
  const nonBlock = {
    functionName: "worker",
    ranges: [{ startOffset: 2, endOffset: 8, count: 50 }],
    isBlockCoverage: false,
  };
  const block = {
    functionName: "worker",
    ranges: [
      { startOffset: 2, endOffset: 8, count: 1 },
      { startOffset: 3, endOffset: 4, count: 0 },
    ],
    isBlockCoverage: true,
  };
  for (const [index, fn] of [nonBlock, block].entries()) {
    writeRaw(
      fixture.rawDirectory,
      index,
      rawPayload([
        {
          scriptId: String(index + 1),
          url: fixture.url,
          functions: [
            blockFunction("", fixture.sourceText.length),
            fn,
          ],
        },
      ]),
    );
  }
  const report = reduceFixture(fixture);
  assert.equal(report.targets[0].functions[0].isScriptGlobal, true);
  const worker = report.targets[0].functions.find(
    (fn) => fn.functionName === "worker",
  );
  assert.equal(worker.isBlockCoverage, true);
  assert.deepEqual(worker.ranges, [
    { startOffset: 2, endOffset: 8, count: 1 },
    { startOffset: 3, endOffset: 4, count: 0 },
  ]);
});

test("block-superseded function graph keeps zero-root body lines uncovered", (t) => {
  const sourceText =
    "const before = 1;\n" +
    "function worker() {\n" +
    "  return 1;\n" +
    "}\n";
  const fixture = makeFixture(t, sourceText);
  const functionStart = sourceText.indexOf("function worker");
  const bodyStart = sourceText.indexOf("  return");
  const bodyEnd = bodyStart + "  return 1;".length;
  const nonBlock = {
    functionName: "worker",
    ranges: [
      {
        startOffset: functionStart,
        endOffset: sourceText.length,
        count: 50,
      },
    ],
    isBlockCoverage: false,
  };
  const block = {
    functionName: "worker",
    ranges: [
      {
        startOffset: functionStart,
        endOffset: sourceText.length,
        count: 0,
      },
      { startOffset: bodyStart, endOffset: bodyEnd, count: 0 },
    ],
    isBlockCoverage: true,
  };
  for (const [index, fn] of [nonBlock, block].entries()) {
    writeRaw(
      fixture.rawDirectory,
      index,
      rawPayload([
        {
          scriptId: String(index + 1),
          url: fixture.url,
          functions: [
            blockFunction("", sourceText.length),
            fn,
          ],
        },
      ]),
    );
  }

  const target = reduceFixture(fixture).targets[0];
  const worker = target.functions.find((fn) => fn.functionName === "worker");
  assert.equal(worker.isBlockCoverage, true);
  assert.equal(worker.ranges[0].count, 0);
  assert.deepEqual(target.uncoveredLineNumbers, [2, 3, 4]);
  assert.deepEqual(target.metrics.lines, {
    covered: 1,
    total: 4,
    percentageDisplay: "25.00",
  });
});

test("partial zero intersection overlays positive merged identities for whole source lines", (t) => {
  const fixture = makeFixture(t, "aaaaa\nbbbbb\nccccc\nddddd\n");
  const ranges = [
    [{ startOffset: 6, endOffset: 17, count: 0 }],
    [{ startOffset: 12, endOffset: 23, count: 0 }],
  ];
  ranges.forEach((observation, index) => {
    writeRaw(
      fixture.rawDirectory,
      index,
      rawPayload([
        targetScript(fixture, {
          scriptId: String(index + 1),
          ranges: observation,
        }),
      ]),
    );
  });

  const target = reduceFixture(fixture).targets[0];
  const named = target.functions.find(
    (fn) => fn.functionName === "validatePhaseLedger",
  );
  assert.deepEqual(
    named.ranges.slice(1).map((range) => range.count),
    [1, 1],
  );
  assert.deepEqual(named.uncoveredIntervals, [
    { startOffset: 12, endOffset: 17 },
  ]);
  assert.deepEqual(target.uncoveredLineNumbers, [3]);
  assert.equal(target.metrics.lines.covered, 3);
  assert.equal(target.metrics.lines.total, 4);
});

test("effective inheritance covers absent finer ranges and intersects partial zero regions", (t) => {
  const fixture = makeFixture(t);
  const observations = [
    [
      { startOffset: 1, endOffset: 4, count: 0 },
      { startOffset: 7, endOffset: 8, count: 0 },
    ],
    [
      { startOffset: 2, endOffset: 5, count: 0 },
      { startOffset: 7, endOffset: 8, count: 2 },
    ],
  ];
  observations.forEach((ranges, index) =>
    writeRaw(
      fixture.rawDirectory,
      index,
      rawPayload([targetScript(fixture, { ranges })]),
    ),
  );
  const named = reduceFixture(fixture).targets[0].functions[1];
  assert.deepEqual(named.ranges, [
    { startOffset: 0, endOffset: 12, count: 2 },
    { startOffset: 1, endOffset: 4, count: 1 },
    { startOffset: 2, endOffset: 5, count: 1 },
    { startOffset: 7, endOffset: 8, count: 2 },
  ]);
  assert.deepEqual(named.uncoveredIntervals, [
    { startOffset: 2, endOffset: 4 },
  ]);
});

test("zero intersection semantics cover omitted and disjoint ranges and retain only partial overlap", (t) => {
  const scenarios = [
    {
      name: "omitted",
      ranges: [
        [{ startOffset: 10, endOffset: 20, count: 0 }],
        [],
      ],
      expectedIntervals: [],
      expectedCounts: [1],
    },
    {
      name: "partial",
      ranges: [
        [{ startOffset: 10, endOffset: 20, count: 0 }],
        [{ startOffset: 15, endOffset: 25, count: 0 }],
      ],
      expectedIntervals: [{ startOffset: 15, endOffset: 20 }],
      expectedCounts: [1, 1],
    },
    {
      name: "disjoint",
      ranges: [
        [{ startOffset: 1, endOffset: 5, count: 0 }],
        [{ startOffset: 7, endOffset: 10, count: 0 }],
      ],
      expectedIntervals: [],
      expectedCounts: [1, 1],
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture(t, "x".repeat(30));
    scenario.ranges.forEach((ranges, index) =>
      writeRaw(
        fixture.rawDirectory,
        index,
        rawPayload([targetScript(fixture, { ranges })]),
      ),
    );
    const named = reduceFixture(fixture).targets[0].functions.find(
      (fn) => fn.functionName === "validatePhaseLedger",
    );
    assert.deepEqual(named.uncoveredIntervals, scenario.expectedIntervals);
    assert.deepEqual(
      named.ranges.slice(1).map((range) => range.count),
      scenario.expectedCounts,
      scenario.name,
    );
  }
});

test("merged inheritance covers an earlier zero when a later observation inherits positive parent count", (t) => {
  const fixture = makeFixture(t, "aaaa\nbbbb\n");
  const zeroSecondLine = { startOffset: 5, endOffset: 9, count: 0 };
  writeRaw(
    fixture.rawDirectory,
    0,
    rawPayload([targetScript(fixture, { ranges: [zeroSecondLine] })]),
  );
  writeRaw(
    fixture.rawDirectory,
    1,
    rawPayload([targetScript(fixture)]),
  );
  const report = reduceFixture(fixture);
  assert.deepEqual(report.targets[0].uncoveredLineNumbers, []);
  assert.deepEqual(report.targets[0].metrics.lines, {
    covered: 2,
    total: 2,
    percentageDisplay: "100.00",
  });
});

test("Node-compatible metric populations use UTF-16 lines, roots, and zero denominator policy", (t) => {
  const fixture = makeFixture(t, "a\nb\n");
  const globalOnly = {
    scriptId: "1",
    url: fixture.url,
    functions: [
      blockFunction("", fixture.sourceText.length, [
        { startOffset: 2, endOffset: 3, count: 0 },
      ]),
    ],
  };
  writeRaw(fixture.rawDirectory, 0, rawPayload([globalOnly]));
  const report = reduceFixture(fixture);
  assert.deepEqual(report.targets[0].uncoveredLineNumbers, [2]);
  assert.deepEqual(report.targets[0].metrics.lines, {
    covered: 1,
    total: 2,
    percentageDisplay: "50.00",
  });
  assert.deepEqual(report.targets[0].metrics.branches, {
    covered: 1,
    total: 2,
    percentageDisplay: "50.00",
  });
  assert.deepEqual(report.targets[0].metrics.functions, {
    covered: 0,
    total: 0,
    percentageDisplay: "100.00",
  });
});

test("all-non-block target coverage refuses false branch completeness", (t) => {
  const fixture = makeFixture(t);
  writeRaw(
    fixture.rawDirectory,
    0,
    rawPayload([
      {
        scriptId: "1",
        url: fixture.url,
        functions: [
          {
            functionName: "",
            ranges: [
              {
                startOffset: 0,
                endOffset: fixture.sourceText.length,
                count: 1,
              },
            ],
            isBlockCoverage: false,
          },
        ],
      },
    ]),
  );
  assert.equal(
    errorCode(() => reduceFixture(fixture)),
    "TARGET_PRECISE_COVERAGE_REQUIRED",
  );
});

test("semantic digest changes on count, range, source, algorithm, or manifest changes", (t) => {
  const first = makeFixture(t);
  writeRaw(first.rawDirectory, 0, rawPayload([targetScript(first)]));
  const firstReport = reduceFixture(first);

  const secondDirectory = path.join(first.root, "raw-second");
  fs.mkdirSync(secondDirectory, { mode: 0o700 });
  fs.chmodSync(secondDirectory, 0o700);
  writeRaw(
    secondDirectory,
    0,
    rawPayload([targetScript(first, { rootCount: 2 })]),
  );
  const secondReport = coverage.reduceCanonicalCoverage({
    rawDirectory: secondDirectory,
    targets: [first.target],
  });
  assert.notEqual(
    firstReport.semanticCoverageSha256,
    secondReport.semanticCoverageSha256,
  );

  const forged = structuredClone(firstReport);
  forged.reducer.algorithm = "weakened";
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(forged)),
    "REPORT_ALGORITHM_INCONSISTENT",
  );
});

test("evidence verifier rereads raw and source bytes and refuses same-length source drift", (t) => {
  const fixture = makeFixture(t);
  writeRaw(fixture.rawDirectory, 0, rawPayload([targetScript(fixture)]));
  const report = reduceFixture(fixture);
  assert.equal(
    coverage.verifyCanonicalCoverageEvidence({
      report,
      rawDirectory: fixture.rawDirectory,
      targets: [fixture.target],
    }),
    report,
  );
  fs.writeFileSync(fixture.sourcePath, "ABCDEFGHIJKL", { mode: 0o600 });
  assert.equal(
    errorCode(() =>
      coverage.verifyCanonicalCoverageEvidence({
        report,
        rawDirectory: fixture.rawDirectory,
        targets: [fixture.target],
      }),
    ),
    "REPORT_SOURCE_BINDING_INVALID",
  );
});

test("standalone report validation authoritatively rereads canonical stable source bytes", (t) => {
  const fixture = makeFixture(t, "alpha\nbeta\n");
  writeRaw(fixture.rawDirectory, 0, rawPayload([targetScript(fixture)]));
  const report = reduceFixture(fixture);

  const scalarForgeries = [
    ["sourceByteLength", report.targets[0].sourceByteLength + 1],
    ["sourceUtf16Length", report.targets[0].sourceUtf16Length + 1],
    ["sourceLineCount", report.targets[0].sourceLineCount + 1],
    ["sourceSha256", "0".repeat(64)],
    ["url", "file:///invented-source.js"],
  ];
  for (const [field, value] of scalarForgeries) {
    const forged = structuredClone(report);
    forged.targets[0][field] = value;
    rehashReport(forged);
    assert.equal(
      errorCode(() => coverage.validateCanonicalCoverageReport(forged)),
      "REPORT_SOURCE_BINDING_INVALID",
      field,
    );
  }

  const relative = structuredClone(report);
  relative.targets[0].sourcePath = path.relative(
    process.cwd(),
    fixture.sourcePath,
  );
  relative.targets[0].url = pathToFileURL(relative.targets[0].sourcePath).href;
  rehashReport(relative);
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(relative)),
    "REPORT_SOURCE_PATH_INVALID",
  );

  const aliasPath = path.join(fixture.root, "source-alias.js");
  fs.symlinkSync(fixture.sourcePath, aliasPath);
  const aliased = structuredClone(report);
  aliased.targets[0].sourcePath = aliasPath;
  aliased.targets[0].url = pathToFileURL(aliasPath).href;
  rehashReport(aliased);
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(aliased)),
    "REPORT_SOURCE_PATH_INVALID",
  );

  const missing = structuredClone(report);
  missing.targets[0].sourcePath = path.join(fixture.root, "missing.js");
  missing.targets[0].url = pathToFileURL(missing.targets[0].sourcePath).href;
  rehashReport(missing);
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(missing)),
    "REPORT_SOURCE_PATH_INVALID",
  );

  fs.chmodSync(fixture.sourcePath, 0o666);
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(report)),
    "REPORT_SOURCE_PERMISSIONS_INVALID",
  );
  fs.chmodSync(fixture.sourcePath, 0o600);

  fs.writeFileSync(fixture.sourcePath, "ALPHA\nBETA\n", { mode: 0o600 });
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(report)),
    "REPORT_SOURCE_BINDING_INVALID",
  );
  fs.writeFileSync(fixture.sourcePath, fixture.sourceText, { mode: 0o600 });

  fs.writeFileSync(fixture.sourcePath, "/* c8 ignore next */\n", {
    mode: 0o600,
  });
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(report)),
    "REPORT_SOURCE_IGNORE_DIRECTIVE_UNSUPPORTED",
  );
  fs.writeFileSync(fixture.sourcePath, "//# sourceMappingURL=x.map\n", {
    mode: 0o600,
  });
  assert.equal(
    errorCode(() => coverage.validateCanonicalCoverageReport(report)),
    "REPORT_SOURCE_MAP_UNSUPPORTED",
  );
  fs.writeFileSync(fixture.sourcePath, fixture.sourceText, { mode: 0o600 });

  const realFstat = fs.fstatSync;
  let fstatCalls = 0;
  assert.equal(
    withPatched(
      fs,
      "fstatSync",
      (descriptor, options) => {
        const stat = realFstat(descriptor, options);
        fstatCalls++;
        return fstatCalls === 2
          ? alteredStat(stat, { mtimeNs: stat.mtimeNs + 1n })
          : stat;
      },
      () =>
        errorCode(() => coverage.validateCanonicalCoverageReport(report)),
    ),
    "REPORT_SOURCE_MUTATED_DURING_READ",
  );
});

test("report validator rejects hash, metric, range, inventory, and line inconsistencies", (t) => {
  const fixture = makeFixture(t);
  writeRaw(
    fixture.rawDirectory,
    0,
    rawPayload([
      targetScript(fixture, {
        ranges: [{ startOffset: 3, endOffset: 4, count: 0 }],
      }),
    ]),
  );
  const report = reduceFixture(fixture);
  const mutations = [
    [
      "REPORT_SEMANTIC_HASH_INVALID",
      (copy) => {
        copy.semanticCoverageSha256 = "0".repeat(64);
      },
    ],
    [
      "REPORT_METRIC_INCONSISTENT",
      (copy) => {
        copy.targets[0].metrics.branches.total++;
      },
    ],
    [
      "REPORT_UNCOVERED_RANGES_INCONSISTENT",
      (copy) => {
        copy.targets[0].uncoveredRanges = [];
      },
    ],
    [
      "REPORT_INVENTORY_INCONSISTENT",
      (copy) => {
        copy.rawInventory.fileCount++;
      },
    ],
    [
      "REPORT_UNCOVERED_LINES_INVALID",
      (copy) => {
        copy.targets[0].uncoveredLineNumbers = [2, 1];
      },
    ],
  ];
  for (const [expectedCode, mutate] of mutations) {
    const copy = structuredClone(report);
    mutate(copy);
    assert.equal(
      errorCode(() => coverage.validateCanonicalCoverageReport(copy)),
      expectedCode,
    );
  }
});

test("strict parser rejects duplicate root and nested keys plus prototype-polluting keys", (t) => {
  const validFixture = makeFixture(t);
  const text = JSON.stringify(
    rawPayload([targetScript(validFixture)]),
  );
  const variants = [
    [
      "RAW_JSON_DUPLICATE_KEY",
      text.replace('"result":', '"result":[],"result":'),
    ],
    [
      "RAW_JSON_DUPLICATE_KEY",
      text.replace('"functionName":""', '"functionName":"","functionName":""'),
    ],
    [
      "RAW_JSON_PROTOTYPE_KEY",
      text.replace('{"result"', '{"__proto__":{},"result"'),
    ],
  ];
  variants.forEach(([expected, rawText], index) => {
    const fixture = makeFixture(t);
    writeRawText(fixture.rawDirectory, index, rawText.replaceAll(validFixture.url, fixture.url));
    assert.equal(errorCode(() => reduceFixture(fixture)), expected);
  });
});

test("schema parser rejects extra roots, non-canonical JSON, invalid numbers, and sparse arrays", (t) => {
  const base = makeFixture(t);
  const valid = JSON.stringify(rawPayload([targetScript(base)]));
  const variants = [
    [
      "RAW_ROOT_SCHEMA_INVALID",
      valid.replace(',"timestamp"', ',"extra":true,"timestamp"'),
    ],
    ["RAW_JSON_NON_CANONICAL", `${valid}\n`],
    [
      "RAW_RANGE_COUNT_INVALID",
      valid.replace('"count":1', '"count":-1'),
    ],
    ["RAW_JSON_INVALID", valid.replace('"result":[', '"result":[,')],
    ["RAW_JSON_INVALID", valid.replace('"timestamp":1234.5', '"timestamp":NaN')],
  ];
  variants.forEach(([expected, text], index) => {
    const fixture = makeFixture(t);
    writeRawText(
      fixture.rawDirectory,
      index,
      text.replaceAll(base.url, fixture.url),
    );
    assert.equal(errorCode(() => reduceFixture(fixture)), expected);
  });
});

test("schema parser rejects source maps, ignore directives, malformed globals, and non-block nested ranges", (t) => {
  const sourceMap = makeFixture(t, "x\n//# sourceMappingURL=x.map");
  assert.equal(
    errorCode(() => reduceFixture(sourceMap)),
    "SOURCE_MAP_UNSUPPORTED",
  );

  const ignored = makeFixture(t, "/* node:coverage ignore next */\nx");
  assert.equal(
    errorCode(() => reduceFixture(ignored)),
    "SOURCE_IGNORE_DIRECTIVE_UNSUPPORTED",
  );

  const badGlobal = makeFixture(t);
  const script = targetScript(badGlobal);
  script.functions.reverse();
  writeRaw(badGlobal.rawDirectory, 0, rawPayload([script]));
  assert.equal(
    errorCode(() => reduceFixture(badGlobal)),
    "SCRIPT_GLOBAL_FUNCTION_INVALID",
  );

  const nonBlock = makeFixture(t);
  const badFunction = {
    functionName: "bad",
    ranges: [
      { startOffset: 1, endOffset: 5, count: 1 },
      { startOffset: 2, endOffset: 3, count: 0 },
    ],
    isBlockCoverage: false,
  };
  writeRaw(
    nonBlock.rawDirectory,
    0,
    rawPayload([
      {
        scriptId: "1",
        url: nonBlock.url,
        functions: [
          blockFunction("", nonBlock.sourceText.length),
          badFunction,
        ],
      },
    ]),
  );
  assert.equal(
    errorCode(() => reduceFixture(nonBlock)),
    "RAW_NON_BLOCK_RANGES_INVALID",
  );
});

test("fatal UTF-8 applies to source and raw artifacts", (t) => {
  const sourceFixture = makeFixture(t);
  fs.writeFileSync(sourceFixture.sourcePath, Buffer.from([0x61, 0xff]), {
    mode: 0o600,
  });
  assert.equal(
    errorCode(() => reduceFixture(sourceFixture)),
    "SOURCE_UTF8_INVALID",
  );

  const rawFixture = makeFixture(t);
  const rawFile = path.join(rawFixture.rawDirectory, rawName(0));
  fs.writeFileSync(rawFile, Buffer.from([0x7b, 0xff]), { mode: 0o600 });
  fs.chmodSync(rawFile, 0o600);
  assert.equal(
    errorCode(() => reduceFixture(rawFixture)),
    "RAW_UTF8_INVALID",
  );
});

test("mutation guard: duplicate targets and unobserved targets are refused", (t) => {
  const fixture = makeFixture(t);
  writeRaw(fixture.rawDirectory, 0, rawPayload([targetScript(fixture)]));
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: fixture.rawDirectory,
        targets: [fixture.target, { ...fixture.target }],
      }),
    ),
    "TARGET_ID_DUPLICATE",
  );

  const otherSource = path.join(fixture.root, "other.js");
  fs.writeFileSync(otherSource, "x", { mode: 0o600 });
  const other = {
    id: "other",
    sourcePath: otherSource,
  };
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: fixture.rawDirectory,
        targets: [fixture.target, other],
      }),
    ),
    "TARGET_NOT_OBSERVED",
  );
});

test("mutation guard: target and raw traversal aliases, symlinks, hard links, and non-files are refused", (t) => {
  const sourceAlias = makeFixture(t);
  const sourceLink = path.join(sourceAlias.root, "source-link.js");
  fs.symlinkSync(sourceAlias.sourcePath, sourceLink);
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: sourceAlias.rawDirectory,
        targets: [
          {
            id: "source-link",
            sourcePath: sourceLink,
          },
        ],
      }),
    ),
    "SOURCE_PATH_NON_CANONICAL",
  );

  const rawLink = makeFixture(t);
  writeRaw(rawLink.rawDirectory, 0, rawPayload([targetScript(rawLink)]));
  const linkName = path.join(rawLink.rawDirectory, rawName(1));
  fs.symlinkSync(path.join(rawLink.rawDirectory, rawName(0)), linkName);
  assert.equal(errorCode(() => reduceFixture(rawLink)), "RAW_ENTRY_NOT_REGULAR");

  const hardLink = makeFixture(t);
  const original = writeRaw(
    hardLink.rawDirectory,
    0,
    rawPayload([targetScript(hardLink)]),
  );
  fs.linkSync(original, path.join(hardLink.rawDirectory, rawName(1)));
  assert.equal(
    errorCode(() => reduceFixture(hardLink)),
    "RAW_FILE_LINK_COUNT_INVALID",
  );

  const directoryEntry = makeFixture(t);
  fs.mkdirSync(path.join(directoryEntry.rawDirectory, rawName(0)), {
    mode: 0o700,
  });
  assert.equal(
    errorCode(() => reduceFixture(directoryEntry)),
    "RAW_ENTRY_NOT_REGULAR",
  );
});

test("mutation guard: owner-only raw permissions are mandatory", (t) => {
  const fixture = makeFixture(t);
  const file = writeRaw(
    fixture.rawDirectory,
    0,
    rawPayload([targetScript(fixture)]),
  );
  fs.chmodSync(file, 0o644);
  assert.equal(
    errorCode(() => reduceFixture(fixture)),
    "RAW_FILE_NOT_OWNER_ONLY",
  );
  fs.chmodSync(file, 0o600);
  fs.chmodSync(fixture.rawDirectory, 0o755);
  assert.equal(
    errorCode(() => reduceFixture(fixture)),
    "RAW_DIRECTORY_NOT_OWNER_ONLY",
  );

  const writableSource = makeFixture(t);
  fs.chmodSync(writableSource.sourcePath, 0o666);
  assert.equal(
    errorCode(() => reduceFixture(writableSource)),
    "SOURCE_PERMISSIONS_INVALID",
  );
});

test("mutation guard: raw count and per-file bounds fail before parsing", (t) => {
  const countFixture = makeFixture(t);
  for (let index = 0; index <= coverage.BOUNDS.maxRawFiles; index++) {
    writeRawText(countFixture.rawDirectory, index, "{}");
  }
  assert.equal(
    errorCode(() => reduceFixture(countFixture)),
    "RAW_FILE_COUNT_BOUND_EXCEEDED",
  );

  const sizeFixture = makeFixture(t);
  const oversized = path.join(sizeFixture.rawDirectory, rawName(0));
  fs.writeFileSync(oversized, "", { mode: 0o600 });
  fs.truncateSync(oversized, coverage.BOUNDS.maxRawFileBytes + 1);
  fs.chmodSync(oversized, 0o600);
  assert.equal(
    errorCode(() => reduceFixture(sizeFixture)),
    "RAW_FILE_SIZE_BOUND_EXCEEDED",
  );
});

test("mutation guard: raw total-byte bound fails before malformed sparse payload parsing", (t) => {
  const fixture = makeFixture(t);
  const fileCount =
    Math.floor(
      coverage.BOUNDS.maxRawTotalBytes / coverage.BOUNDS.maxRawFileBytes,
    ) + 1;
  for (let index = 0; index < fileCount; index++) {
    const file = path.join(fixture.rawDirectory, rawName(index));
    fs.writeFileSync(file, "", { mode: 0o600 });
    fs.truncateSync(file, coverage.BOUNDS.maxRawFileBytes);
    fs.chmodSync(file, 0o600);
  }
  assert.equal(
    errorCode(() => reduceFixture(fixture)),
    "RAW_TOTAL_SIZE_BOUND_EXCEEDED",
  );
});

test("cross-file target function identity union refuses before an oversized report is built", (t) => {
  const fixture = makeFixture(t, "x");
  const extraCount = coverage.BOUNDS.maxFunctionsPerTarget - 1;
  const chunkSize = Math.ceil(extraCount / 3);
  for (let chunk = 0; chunk < 3; chunk++) {
    const start = chunk * chunkSize;
    const end = Math.min(extraCount, start + chunkSize);
    const extraFunctions = [];
    for (let index = start; index < end; index++) {
      extraFunctions.push({
        functionName: `f${String(index).padStart(5, "0")}`,
        ranges: [{ startOffset: 0, endOffset: 1, count: 1 }],
        isBlockCoverage: true,
      });
    }
    writeRaw(
      fixture.rawDirectory,
      chunk,
      rawPayload([
        targetScript(fixture, {
          scriptId: String(chunk + 1),
          extraFunctions,
        }),
      ]),
    );
  }
  assert.equal(
    errorCode(() => reduceFixture(fixture)),
    "TARGET_FUNCTION_IDENTITY_BOUND_EXCEEDED",
  );
});

test("cross-file per-function merged range identity union refuses before insertion", (t) => {
  const childCount = coverage.BOUNDS.maxMergedRangesPerFunction;
  const fixture = makeFixture(t, "x".repeat(childCount + 2));
  const split = Math.ceil(childCount / 2);
  for (let chunk = 0; chunk < 2; chunk++) {
    const start = chunk * split;
    const end = Math.min(childCount, start + split);
    const ranges = [];
    for (let index = start; index < end; index++) {
      ranges.push({
        startOffset: index + 1,
        endOffset: index + 2,
        count: 1,
      });
    }
    writeRaw(
      fixture.rawDirectory,
      chunk,
      rawPayload([
        targetScript(fixture, {
          scriptId: String(chunk + 1),
          ranges,
        }),
      ]),
    );
  }
  assert.equal(
    errorCode(() => reduceFixture(fixture)),
    "TARGET_MERGED_RANGE_IDENTITY_BOUND_EXCEEDED",
  );
});

test("cross-file script, function, and range observation resources have independent bounds", (t) => {
  const scripts = makeFixture(t, "x");
  const scriptPayloads = [];
  for (
    let index = 0;
    index <= coverage.BOUNDS.maxScriptObservationsPerTarget;
    index++
  ) {
    scriptPayloads.push(
      targetScript(scripts, { scriptId: String(index + 1) }),
    );
  }
  writeRaw(scripts.rawDirectory, 0, rawPayload(scriptPayloads));
  assert.equal(
    errorCode(() => reduceFixture(scripts)),
    "TARGET_SCRIPT_OBSERVATION_BOUND_EXCEEDED",
  );

  const functions = makeFixture(t, "x");
  const functionsPerScript = 400;
  const functionFileCount =
    Math.floor(
      coverage.BOUNDS.maxFunctionObservationsPerTarget /
        functionsPerScript,
    ) + 1;
  const repeatedFunctions = Array.from(
    { length: functionsPerScript - 2 },
    (_, index) => ({
      functionName: `repeated${String(index).padStart(3, "0")}`,
      ranges: [{ startOffset: 0, endOffset: 1, count: 1 }],
      isBlockCoverage: true,
    }),
  );
  for (let index = 0; index < functionFileCount; index++) {
    writeRaw(
      functions.rawDirectory,
      index,
      rawPayload([
        targetScript(functions, {
          scriptId: String(index + 1),
          extraFunctions: repeatedFunctions,
        }),
      ]),
    );
  }
  assert.equal(
    errorCode(() => reduceFixture(functions)),
    "TARGET_FUNCTION_OBSERVATION_BOUND_EXCEEDED",
  );

  const ranges = makeFixture(t, "x".repeat(1_002));
  const repeatedRanges = Array.from({ length: 999 }, (_, index) => ({
    startOffset: index + 1,
    endOffset: index + 2,
    count: 1,
  }));
  const rangesPerScript = repeatedRanges.length + 2;
  const rangeFileCount =
    Math.floor(
      coverage.BOUNDS.maxRangeObservationsPerTarget / rangesPerScript,
    ) + 1;
  for (let index = 0; index < rangeFileCount; index++) {
    writeRaw(
      ranges.rawDirectory,
      index,
      rawPayload([
        targetScript(ranges, {
          scriptId: String(index + 1),
          ranges: repeatedRanges,
        }),
      ]),
    );
  }
  assert.equal(
    errorCode(() => reduceFixture(ranges)),
    "TARGET_RANGE_OBSERVATION_BOUND_EXCEEDED",
  );
});

test("mutation guard: exact sorting, containment, deduplication, schema, UTF-8, and bounds constants are frozen", () => {
  assert.equal(Object.isFrozen(coverage.BOUNDS), true);
  assert.equal(Object.isFrozen(coverage.PERCENTAGE_POLICY), true);
  assert.equal(
    coverage.ALGORITHM,
    "utf16-merged-function-lines-zero-overlay-block-supersession-v3",
  );
  assert.equal(coverage.REPORT_SCHEMA, "pikiio-canonical-coverage-report-v2");
  assert.equal(
    coverage.RAW_EVIDENCE_MANIFEST_SCHEMA,
    "pikiio-canonical-coverage-raw-evidence-manifest-v1",
  );
  assert.equal(
    coverage.SEMANTIC_MANIFEST_SCHEMA,
    "pikiio-canonical-coverage-semantic-input-manifest-v1",
  );
});

test("mutation gauntlet kills canonical ordering, semantics, resource, source, self-validation, and CLI mutants", (t) => {
  const librarySource = fs.readFileSync(
    require.resolve("../lib/pikiio-canonical-coverage"),
    "utf8",
  );
  const cliSource = fs.readFileSync(
    require.resolve("../scripts/pikiio-canonical-coverage"),
    "utf8",
  );
  const mutantRoot = canonicalTemporaryRoot(t);
  let mutantIndex = 0;

  function loadMutant(label, search, replacement) {
    const occurrences = librarySource.split(search).length - 1;
    assert.equal(occurrences, 1, `${label} mutation anchor must be unique`);
    const mutantPath = path.join(
      mutantRoot,
      `pikiio-canonical-coverage-mutant-${mutantIndex++}.js`,
    );
    fs.writeFileSync(
      mutantPath,
      librarySource.replace(search, replacement),
      { mode: 0o600 },
    );
    return require(mutantPath);
  }

  function loadCliMutant(label, search, replacement) {
    const occurrences = cliSource.split(search).length - 1;
    assert.equal(occurrences, 1, `${label} mutation anchor must be unique`);
    const mutantPath = path.join(
      mutantRoot,
      `pikiio-canonical-coverage-cli-mutant-${mutantIndex++}.js`,
    );
    const runnableSource = cliSource
      .replace(search, replacement)
      .replace(
        'require("../lib/pikiio-canonical-coverage")',
        `require(${JSON.stringify(
          require.resolve("../lib/pikiio-canonical-coverage"),
        )})`,
      );
    fs.writeFileSync(mutantPath, runnableSource, { mode: 0o600 });
    return require(mutantPath);
  }

  function killed(label, mutant, probe, baseline = coverage) {
    probe(baseline);
    let failure;
    try {
      probe(mutant);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${label} mutant survived its focused probe`);
  }

  const sortingFixture = makeFixture(t);
  writeRaw(
    sortingFixture.rawDirectory,
    0,
    rawPayload([
      targetScript(sortingFixture, {
        extraFunctions: [
          {
            functionName: "zeta",
            ranges: [{ startOffset: 6, endOffset: 10, count: 1 }],
            isBlockCoverage: true,
          },
          {
            functionName: "alpha",
            ranges: [{ startOffset: 1, endOffset: 5, count: 1 }],
            isBlockCoverage: true,
          },
        ],
      }),
    ]),
  );
  const sortingMutant = loadMutant(
    "sorting",
    `const functions = [...target.functionGroups.values()]
    .map(mergeFunctionGroup)
    .sort(compareFunctions);`,
    `const functions = [...target.functionGroups.values()]
    .map(mergeFunctionGroup);`,
  );
  killed("sorting", sortingMutant, (implementation) => {
    const report = implementation.reduceCanonicalCoverage({
      rawDirectory: sortingFixture.rawDirectory,
      targets: [sortingFixture.target],
    });
    assert.deepEqual(
      report.targets[0].functions.map((fn) => fn.functionName),
      ["", "validatePhaseLedger", "alpha", "zeta"],
    );
  });

  const intersectionFixture = makeFixture(t, "x".repeat(30));
  writeRaw(
    intersectionFixture.rawDirectory,
    0,
    rawPayload([
      targetScript(intersectionFixture, {
        ranges: [{ startOffset: 10, endOffset: 20, count: 0 }],
      }),
    ]),
  );
  writeRaw(
    intersectionFixture.rawDirectory,
    1,
    rawPayload([
      targetScript(intersectionFixture, {
        ranges: [{ startOffset: 15, endOffset: 25, count: 0 }],
      }),
    ]),
  );
  const intersectionMutant = loadMutant(
    "intersection",
    `const startOffset = Math.max(
      left[leftIndex].startOffset,
      right[rightIndex].startOffset,
    );`,
    `const startOffset = Math.min(
      left[leftIndex].startOffset,
      right[rightIndex].startOffset,
    );`,
  );
  killed("intersection", intersectionMutant, (implementation) => {
    const report = implementation.reduceCanonicalCoverage({
      rawDirectory: intersectionFixture.rawDirectory,
      targets: [intersectionFixture.target],
    });
    assert.deepEqual(
      report.targets[0].functions[1].uncoveredIntervals,
      [{ startOffset: 15, endOffset: 20 }],
    );
  });

  const inheritanceMutant = loadMutant(
    "inheritance",
    "effectiveCountForInterval(observation, identity),",
    `(observation.find((range) =>
          range.startOffset === identity.startOffset &&
          range.endOffset === identity.endOffset
        ) || { count: 0 }).count,`,
  );
  const inheritanceFixture = makeFixture(t, "x".repeat(30));
  writeRaw(
    inheritanceFixture.rawDirectory,
    0,
    rawPayload([
      targetScript(inheritanceFixture, {
        ranges: [{ startOffset: 10, endOffset: 20, count: 0 }],
      }),
    ]),
  );
  writeRaw(
    inheritanceFixture.rawDirectory,
    1,
    rawPayload([targetScript(inheritanceFixture)]),
  );
  killed("inheritance", inheritanceMutant, (implementation) => {
    const report = implementation.reduceCanonicalCoverage({
      rawDirectory: inheritanceFixture.rawDirectory,
      targets: [inheritanceFixture.target],
    });
    assert.equal(report.targets[0].functions[1].ranges[1].count, 1);
  });

  const duplicateFixture = makeFixture(t);
  const duplicatePayload = rawPayload([targetScript(duplicateFixture)], 77);
  writeRaw(duplicateFixture.rawDirectory, 0, duplicatePayload);
  writeRaw(duplicateFixture.rawDirectory, 1, duplicatePayload);
  const dedupMutant = loadMutant(
    "dedup",
    "const existing = byHash.get(rawSha256);",
    "const existing = undefined;",
  );
  killed("dedup", dedupMutant, (implementation) => {
    const report = implementation.reduceCanonicalCoverage({
      rawDirectory: duplicateFixture.rawDirectory,
      targets: [duplicateFixture.target],
    });
    assert.equal(report.rawEvidenceManifest.uniqueRawFileCount, 1);
    assert.equal(report.rawEvidenceManifest.entries[0].multiplicity, 2);
  });

  const schemaFixture = makeFixture(t);
  const schemaRaw = {
    ...rawPayload([targetScript(schemaFixture)]),
    extra: true,
  };
  writeRaw(schemaFixture.rawDirectory, 0, schemaRaw);
  const schemaMutant = loadMutant(
    "schema",
    `if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {`,
    "if (false) {",
  );
  killed("schema", schemaMutant, (implementation) => {
    assert.throws(
      () =>
        implementation.reduceCanonicalCoverage({
          rawDirectory: schemaFixture.rawDirectory,
          targets: [schemaFixture.target],
        }),
      (error) => error.code === "RAW_ROOT_SCHEMA_INVALID",
    );
  });

  const utf8Fixture = makeFixture(t);
  fs.writeFileSync(utf8Fixture.sourcePath, Buffer.from([0x61, 0xff]), {
    mode: 0o600,
  });
  writeRaw(
    utf8Fixture.rawDirectory,
    0,
    rawPayload([
      {
        scriptId: "1",
        url: utf8Fixture.url,
        functions: [blockFunction("", 2)],
      },
    ]),
  );
  const utf8Mutant = loadMutant(
    "UTF-8",
    "fatal: true,",
    "fatal: false,",
  );
  killed("UTF-8", utf8Mutant, (implementation) => {
    assert.throws(
      () =>
        implementation.reduceCanonicalCoverage({
          rawDirectory: utf8Fixture.rawDirectory,
          targets: [utf8Fixture.target],
        }),
      (error) => error.code === "SOURCE_UTF8_INVALID",
    );
  });

  const boundsFixture = makeFixture(t);
  for (let index = 0; index <= coverage.BOUNDS.maxRawFiles; index++) {
    writeRaw(
      boundsFixture.rawDirectory,
      index,
      rawPayload([targetScript(boundsFixture)]),
    );
  }
  const boundsMutant = loadMutant(
    "bounds",
    "if (entries.length > BOUNDS.maxRawFiles) {",
    "if (false) {",
  );
  killed("bounds", boundsMutant, (implementation) => {
    assert.throws(
      () =>
        implementation.reduceCanonicalCoverage({
          rawDirectory: boundsFixture.rawDirectory,
          targets: [boundsFixture.target],
        }),
      (error) => error.code === "RAW_FILE_COUNT_BOUND_EXCEEDED",
    );
  });

  const lineFixture = makeFixture(
    t,
    "const before = 1;\nfunction worker() {\n  return 1;\n}\n",
  );
  const lineFunctionStart = lineFixture.sourceText.indexOf("function worker");
  const lineBodyStart = lineFixture.sourceText.indexOf("  return");
  const lineBodyEnd = lineBodyStart + "  return 1;".length;
  writeRaw(
    lineFixture.rawDirectory,
    0,
    rawPayload([
      {
        scriptId: "1",
        url: lineFixture.url,
        functions: [
          blockFunction("", lineFixture.sourceText.length),
          {
            functionName: "worker",
            ranges: [
              {
                startOffset: lineFunctionStart,
                endOffset: lineFixture.sourceText.length,
                count: 50,
              },
            ],
            isBlockCoverage: false,
          },
        ],
      },
    ]),
  );
  writeRaw(
    lineFixture.rawDirectory,
    1,
    rawPayload([
      {
        scriptId: "2",
        url: lineFixture.url,
        functions: [
          blockFunction("", lineFixture.sourceText.length),
          {
            functionName: "worker",
            ranges: [
              {
                startOffset: lineFunctionStart,
                endOffset: lineFixture.sourceText.length,
                count: 0,
              },
              {
                startOffset: lineBodyStart,
                endOffset: lineBodyEnd,
                count: 0,
              },
            ],
            isBlockCoverage: true,
          },
        ],
      },
    ]),
  );
  const supersessionMutant = loadMutant(
    "block line supersession",
    "const isBlockCoverage = group.blockObservations.length > 0;",
    "const isBlockCoverage = false;",
  );
  killed("block line supersession", supersessionMutant, (implementation) => {
    const report = implementation.reduceCanonicalCoverage({
      rawDirectory: lineFixture.rawDirectory,
      targets: [lineFixture.target],
    });
    assert.deepEqual(report.targets[0].uncoveredLineNumbers, [2, 3, 4]);
  });

  const overlayFixture = makeFixture(
    t,
    "aaaaa\nbbbbb\nccccc\nddddd\n",
  );
  [
    { startOffset: 6, endOffset: 17, count: 0 },
    { startOffset: 12, endOffset: 23, count: 0 },
  ].forEach((range, index) => {
    writeRaw(
      overlayFixture.rawDirectory,
      index,
      rawPayload([
        targetScript(overlayFixture, {
          scriptId: String(index + 1),
          ranges: [range],
        }),
      ]),
    );
  });
  const overlayMutant = loadMutant(
    "line zero overlay",
    `    for (const interval of fn.uncoveredIntervals) {
      for (const line of lines) {
        if (rangeMapsWholeLine(interval, line)) {
          line.count = 0;
        }
      }
    }`,
    "",
  );
  killed("line zero overlay", overlayMutant, (implementation) => {
    const report = implementation.reduceCanonicalCoverage({
      rawDirectory: overlayFixture.rawDirectory,
      targets: [overlayFixture.target],
    });
    assert.deepEqual(report.targets[0].uncoveredLineNumbers, [3]);
  });

  const unionFixture = makeFixture(t, "x");
  const unionExtras = coverage.BOUNDS.maxFunctionsPerTarget - 1;
  const unionChunkSize = Math.ceil(unionExtras / 3);
  for (let chunk = 0; chunk < 3; chunk++) {
    const extraFunctions = [];
    for (
      let index = chunk * unionChunkSize;
      index < Math.min(unionExtras, (chunk + 1) * unionChunkSize);
      index++
    ) {
      extraFunctions.push({
        functionName: `union${String(index).padStart(5, "0")}`,
        ranges: [{ startOffset: 0, endOffset: 1, count: 1 }],
        isBlockCoverage: true,
      });
    }
    writeRaw(
      unionFixture.rawDirectory,
      chunk,
      rawPayload([
        targetScript(unionFixture, {
          scriptId: String(chunk + 1),
          extraFunctions,
        }),
      ]),
    );
  }
  const unionMutant = loadMutant(
    "cross-file union bound",
    "if (observed > maximum) {",
    "if (false) {",
  );
  killed("cross-file union bound", unionMutant, (implementation) => {
    assert.throws(
      () =>
        implementation.reduceCanonicalCoverage({
          rawDirectory: unionFixture.rawDirectory,
          targets: [unionFixture.target],
        }),
      (error) => error.code === "TARGET_FUNCTION_IDENTITY_BOUND_EXCEEDED",
    );
  });

  const sourceFixture = makeFixture(t, "source\n");
  writeRaw(
    sourceFixture.rawDirectory,
    0,
    rawPayload([targetScript(sourceFixture)]),
  );
  const sourceReport = reduceFixture(sourceFixture);
  const forgedSourceReport = structuredClone(sourceReport);
  forgedSourceReport.targets[0].sourceByteLength++;
  rehashReport(forgedSourceReport);
  const sourceBindingMutant = loadMutant(
    "standalone source binding",
    "const sourceText = validateReportSourceBinding(target, targetLabel);",
    `const sourceText = fs.readFileSync(target.sourcePath, "utf8");`,
  );
  killed("standalone source binding", sourceBindingMutant, (implementation) => {
    assert.throws(
      () =>
        implementation.validateCanonicalCoverageReport(forgedSourceReport),
      (error) => error.code === "REPORT_SOURCE_BINDING_INVALID",
    );
  });

  const selfValidationFixture = makeFixture(t, "self\n");
  writeRaw(
    selfValidationFixture.rawDirectory,
    0,
    rawPayload([targetScript(selfValidationFixture)]),
  );
  const selfValidationMutant = loadMutant(
    "reducer self validation",
    "  validateCanonicalCoverageReportUnsafe(finalReport);\n",
    "",
  );
  killed("reducer self validation", selfValidationMutant, (implementation) => {
    const realOpen = fs.openSync;
    let sourceOpenCount = 0;
    assert.throws(
      () =>
        withPatched(
          fs,
          "openSync",
          (candidate, ...args) => {
            if (candidate === selfValidationFixture.sourcePath) {
              sourceOpenCount++;
              if (sourceOpenCount === 2) {
                const error = new Error("second source read refused");
                error.code = "EACCES";
                throw error;
              }
            }
            return realOpen(candidate, ...args);
          },
          () =>
            implementation.reduceCanonicalCoverage({
              rawDirectory: selfValidationFixture.rawDirectory,
              targets: [selfValidationFixture.target],
            }),
        ),
      (error) => error.code === "REPORT_SOURCE_PATH_INVALID",
    );
  });

  const duplicateArgumentMutant = loadCliMutant(
    "CLI duplicate raw directory",
    "if (rawDirectory !== undefined || index + 1 >= argv.length) {",
    "if (index + 1 >= argv.length) {",
  );
  killed(
    "CLI duplicate raw directory",
    duplicateArgumentMutant,
    (implementation) => {
      assert.throws(
        () =>
          implementation.parseArguments([
            "--raw-dir",
            "/first",
            "--raw-dir",
            "/second",
            "--target",
            "target=/source",
          ]),
        (error) => error.code === "CLI_ARGUMENT_INVALID",
      );
    },
    coverageCli,
  );
  assert.equal(mutantIndex, 13, "critical source mutant population");
});

test("hostile API values always produce typed refusals", () => {
  for (const value of [
    null,
    [],
    "x",
    { rawDirectory: 1, targets: [] },
    { rawDirectory: "/", targets: [], extra: true },
  ]) {
    assert.throws(
      () => coverage.reduceCanonicalCoverage(value),
      (error) =>
        error instanceof coverage.CanonicalCoverageError &&
        typeof error.code === "string",
    );
  }
  for (const value of [null, [], "x", { schema: coverage.REPORT_SCHEMA }]) {
    assert.throws(
      () => coverage.validateCanonicalCoverageReport(value),
      (error) =>
        error instanceof coverage.CanonicalCoverageError &&
        typeof error.code === "string",
    );
  }
});

test("CLI requires explicit inputs, emits a validated report, and rejects unknown arguments", (t) => {
  const fixture = makeFixture(t);
  writeRaw(fixture.rawDirectory, 0, rawPayload([targetScript(fixture)]));
  let stdout = "";
  let stderr = "";
  const code = coverageCli.main({
    argv: [
      "--raw-dir",
      fixture.rawDirectory,
      "--target",
      `${fixture.target.id}=${fixture.sourcePath}`,
    ],
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  coverage.validateCanonicalCoverageReport(JSON.parse(stdout));

  stdout = "";
  stderr = "";
  assert.equal(
    coverageCli.main({
      argv: ["--ambient-checkout"],
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    1,
  );
  assert.equal(JSON.parse(stderr).code, "CLI_ARGUMENT_INVALID");

  for (const hostile of [
    null,
    "not-an-array",
    ["--help", "--pretty"],
    ["--raw-dir", "bad\npath"],
    ["--target", "file:///x=/x\0suffix"],
  ]) {
    assert.throws(
      () => coverageCli.parseArguments(hostile),
      (error) =>
        error instanceof coverage.CanonicalCoverageError &&
        error.code === "CLI_ARGUMENT_INVALID",
    );
  }
  assert.deepEqual(coverageCli.parseArguments(["--help"]), { help: true });

  stdout = "";
  stderr = "";
  assert.equal(
    coverageCli.main({
      argv: "not-an-array",
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    1,
  );
  assert.equal(JSON.parse(stderr).code, "CLI_ARGUMENT_INVALID");
});

test("CLI parser covers missing, duplicate, malformed, help, and multi-target boundaries", () => {
  const invalid = [
    [],
    ["--raw-dir"],
    ["--raw-dir", ""],
    ["--raw-dir", "/one", "--raw-dir", "/two", "--target", "a=/a"],
    ["--target"],
    ["--target", "=missing-id"],
    ["--target", "missing-path="],
    ["--pretty", "--pretty"],
    ["--help", "--pretty"],
    ["--pretty", "--unknown"],
    [42],
    ["line\nbreak"],
    ["carriage\rreturn"],
    ["nul\0byte"],
  ];
  for (const argv of invalid) {
    assert.throws(
      () => coverageCli.parseArguments(argv),
      (error) =>
        error instanceof coverage.CanonicalCoverageError &&
        error.code === "CLI_ARGUMENT_INVALID",
      JSON.stringify(argv),
    );
  }
  assert.deepEqual(coverageCli.parseArguments(["--help"]), { help: true });
  assert.deepEqual(
    coverageCli.parseArguments([
      "--pretty",
      "--target",
      "alpha=/source=with=equals.js",
      "--raw-dir",
      "/raw",
      "--target",
      "beta=/beta.js",
    ]),
    {
      help: false,
      pretty: true,
      rawDirectory: "/raw",
      targets: [
        { id: "alpha", sourcePath: "/source=with=equals.js" },
        { id: "beta", sourcePath: "/beta.js" },
      ],
    },
  );
});

test("CLI main emits exact help and pretty JSON and preserves typed reducer failures", (t) => {
  let stdout = "";
  let stderr = "";
  assert.equal(
    coverageCli.main({
      argv: ["--help"],
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    0,
  );
  assert.equal(stdout, `${coverageCli.USAGE}\n`);
  assert.equal(stderr, "");

  const fixture = makeFixture(t, "x\n");
  writeRaw(fixture.rawDirectory, 0, rawPayload([targetScript(fixture)]));
  stdout = "";
  stderr = "";
  assert.equal(
    coverageCli.main({
      argv: [
        "--pretty",
        "--raw-dir",
        fixture.rawDirectory,
        "--target",
        `${fixture.target.id}=${fixture.sourcePath}`,
      ],
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    0,
  );
  assert.equal(stderr, "");
  assert.match(stdout, /^\{\n  "schema":/u);
  assert.equal(stdout.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(stdout), reduceFixture(fixture));

  stdout = "";
  stderr = "";
  assert.equal(
    coverageCli.main({
      argv: [
        "--raw-dir",
        path.join(fixture.root, "missing-raw"),
        "--target",
        `${fixture.target.id}=${fixture.sourcePath}`,
      ],
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    }),
    1,
  );
  assert.equal(stdout, "");
  assert.deepEqual(JSON.parse(stderr), {
    status: "refused",
    code: "RAW_DIRECTORY_NON_CANONICAL",
    message: "rawDirectory cannot be resolved",
  });
});

test("CLI stream and hostile main-input failures never escape the process boundary", () => {
  const inputCases = [
    null,
    [],
    "record",
    Object.create({ inherited: true }),
    { extra: true },
    { [Symbol("hostile")]: true },
  ];
  for (const input of inputCases) {
    const result = withPatched(
      process.stderr,
      "write",
      () => true,
      () => coverageCli.main(input),
    );
    assert.equal(result, 1);
  }

  let stderr = "";
  assert.equal(
    coverageCli.main({
      argv: ["--help"],
      stdout: {
        write() {
          const error = new Error("closed");
          error.code = "EPIPE";
          throw error;
        },
      },
      stderr: { write: (value) => (stderr += value) },
    }),
    1,
  );
  assert.deepEqual(JSON.parse(stderr), {
    status: "refused",
    code: "CLI_STDOUT_WRITE_FAILED",
    message: "stdout refused canonical coverage output",
  });

  assert.doesNotThrow(() => {
    assert.equal(
      coverageCli.main({
        argv: ["--unknown"],
        stdout: { write() {} },
        stderr: {
          write() {
            throw new Error("closed");
          },
        },
      }),
      1,
    );
  });
  assert.equal(
    coverageCli.main({
      argv: ["--help"],
      stdout: {},
      stderr: {},
    }),
    1,
  );

  const hostileStdout = {};
  Object.defineProperty(hostileStdout, "write", {
    get() {
      const hostileError = {};
      Object.defineProperty(hostileError, "message", {
        get() {
          throw new Error("hostile getter");
        },
      });
      throw hostileError;
    },
  });
  stderr = "";
  assert.equal(
    coverageCli.main({
      argv: ["--help"],
      stdout: hostileStdout,
      stderr: { write: (value) => (stderr += value) },
    }),
    1,
  );
  assert.deepEqual(JSON.parse(stderr), {
    status: "refused",
    code: "CANONICAL_COVERAGE_INTERNAL_ERROR",
    message: "unprintable internal error",
  });
});

test("CLI direct require.main path returns exact stdout, stderr, and process exit status", (t) => {
  const cliPath = require.resolve("../scripts/pikiio-canonical-coverage");
  const help = childProcess.spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.equal(help.signal, null);
  assert.equal(help.stdout, `${coverageCli.USAGE}\n`);
  assert.equal(help.stderr, "");

  const refused = childProcess.spawnSync(
    process.execPath,
    [cliPath, "--unknown"],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.signal, null);
  assert.equal(refused.stdout, "");
  assert.equal(
    refused.stderr,
    `${JSON.stringify({
      status: "refused",
      code: "CLI_ARGUMENT_INVALID",
      message: "unsupported argument: --unknown",
    })}\n`,
  );

  const fixture = makeFixture(t, "x");
  writeRaw(fixture.rawDirectory, 0, rawPayload([targetScript(fixture)]));
  const success = childProcess.spawnSync(
    process.execPath,
    [
      cliPath,
      "--raw-dir",
      fixture.rawDirectory,
      "--target",
      `${fixture.target.id}=${fixture.sourcePath}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.equal(success.stderr, "");
  const expectedReport = reduceFixture(fixture);
  assert.equal(success.stdout, `${JSON.stringify(expectedReport)}\n`);
  coverage.validateCanonicalCoverageReport(JSON.parse(success.stdout));
});

test("raw source-map cache and unpaired-surrogate strings fail closed", (t) => {
  const sourceMapFixture = makeFixture(t);
  const raw = rawPayload([targetScript(sourceMapFixture)]);
  const withMap = JSON.stringify({
    ...raw,
    "source-map-cache": {},
  });
  writeRawText(sourceMapFixture.rawDirectory, 0, withMap);
  assert.equal(
    errorCode(() => reduceFixture(sourceMapFixture)),
    "SOURCE_MAP_UNSUPPORTED",
  );

  const surrogateFixture = makeFixture(t);
  const surrogateRaw = JSON.stringify({
    result: [
      {
        scriptId: "1",
        url: "\ud800",
        functions: [],
      },
    ],
    timestamp: 1,
  });
  writeRawText(surrogateFixture.rawDirectory, 0, surrogateRaw);
  assert.equal(
    errorCode(() => reduceFixture(surrogateFixture)),
    "RAW_SCRIPT_URL_INVALID",
  );
});

test("path, logical-ID, target-count, empty-directory, BOM, and regular-file guards are executable", (t) => {
  const missingSource = makeFixture(t);
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: missingSource.rawDirectory,
        targets: [
          {
            id: "missing",
            sourcePath: path.join(missingSource.root, "missing.js"),
          },
        ],
      }),
    ),
    "SOURCE_PATH_NON_CANONICAL",
  );

  const sourceDirectory = makeFixture(t);
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: sourceDirectory.rawDirectory,
        targets: [
          {
            id: "source-directory",
            sourcePath: sourceDirectory.root,
          },
        ],
      }),
    ),
    "SOURCE_FILE_INVALID",
  );

  const rawFileAsDirectory = makeFixture(t);
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: rawFileAsDirectory.sourcePath,
        targets: [rawFileAsDirectory.target],
      }),
    ),
    "RAW_DIRECTORY_INVALID",
  );

  const empty = makeFixture(t);
  assert.equal(
    errorCode(() => reduceFixture(empty)),
    "RAW_DIRECTORY_EMPTY",
  );

  const bomSource = makeFixture(t);
  fs.writeFileSync(
    bomSource.sourcePath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]),
    { mode: 0o600 },
  );
  assert.equal(
    errorCode(() => reduceFixture(bomSource)),
    "SOURCE_UTF8_INVALID",
  );

  const bomRaw = makeFixture(t);
  const rawFile = path.join(bomRaw.rawDirectory, rawName(0));
  fs.writeFileSync(
    rawFile,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(rawPayload([targetScript(bomRaw)]))),
    ]),
    { mode: 0o600 },
  );
  assert.equal(errorCode(() => reduceFixture(bomRaw)), "RAW_UTF8_INVALID");

  const tooManyTargets = makeFixture(t);
  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: tooManyTargets.rawDirectory,
        targets: Array.from(
          { length: coverage.BOUNDS.maxTargets + 1 },
          () => tooManyTargets.target,
        ),
      }),
    ),
    "TARGET_COUNT_BOUND_EXCEEDED",
  );

  const invalidIds = [".", "..", "/absolute", "Upper", "a/b", "\udc00", ""];
  for (const id of invalidIds) {
    assert.equal(
      errorCode(() =>
        coverage.reduceCanonicalCoverage({
          rawDirectory: tooManyTargets.rawDirectory,
          targets: [
            {
              id,
              sourcePath: tooManyTargets.sourcePath,
            },
          ],
        }),
      ),
      "TARGET_ID_INVALID",
    );
  }

  assert.equal(
    errorCode(() =>
      coverage.reduceCanonicalCoverage({
        rawDirectory: tooManyTargets.rawDirectory,
        targets: [
          tooManyTargets.target,
          { id: "same-source", sourcePath: tooManyTargets.sourcePath },
        ],
      }),
    ),
    "TARGET_SOURCE_DUPLICATE",
  );
});

test("raw typed schema refuses every malformed function, range, script, and timestamp class", (t) => {
  const cases = [
    [
      "RAW_RANGE_OFFSET_INVALID",
      (raw) => {
        raw.result[0].functions[1].ranges[0].endOffset = 0;
      },
    ],
    [
      "RAW_RANGE_COUNT_INVALID",
      (raw) => {
        raw.result[0].functions[1].ranges[0].count =
          Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "RAW_FUNCTION_NAME_INVALID",
      (raw) => {
        raw.result[0].functions[1].functionName = "\ud800";
      },
    ],
    [
      "RAW_BLOCK_COVERAGE_INVALID",
      (raw) => {
        raw.result[0].functions[1].isBlockCoverage = "yes";
      },
    ],
    [
      "RAW_RANGE_COUNT_INVALID",
      (raw) => {
        raw.result[0].functions[1].ranges = [];
      },
    ],
    [
      "RAW_RANGE_DUPLICATE",
      (raw) => {
        raw.result[0].functions[1].ranges.push({
          ...raw.result[0].functions[1].ranges[0],
        });
      },
    ],
    [
      "RAW_FUNCTION_ROOT_INVALID",
      (raw) => {
        raw.result[0].functions[1].ranges.push({
          startOffset: 0,
          endOffset: 1,
          count: 0,
        });
        raw.result[0].functions[1].ranges[0] = {
          startOffset: 1,
          endOffset: 12,
          count: 1,
        };
      },
    ],
    [
      "RAW_SCRIPT_ID_INVALID",
      (raw) => {
        raw.result[0].scriptId = "not-decimal";
      },
    ],
    [
      "RAW_SCRIPT_URL_INVALID",
      (raw) => {
        raw.result[0].url = "\udc00";
      },
    ],
    [
      "RAW_FUNCTION_COUNT_INVALID",
      (raw) => {
        raw.result[0].functions = {};
      },
    ],
    [
      "RAW_RANGE_SOURCE_MISMATCH",
      (raw) => {
        raw.result[0].functions[1].ranges[0].endOffset = 13;
      },
    ],
    [
      "RAW_TIMESTAMP_INVALID",
      (raw) => {
        raw.timestamp = -1;
      },
    ],
    [
      "RAW_RESULT_INVALID",
      (raw) => {
        raw.result = {};
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const fixture = makeFixture(t);
    const raw = rawPayload([targetScript(fixture)]);
    mutate(raw);
    writeRaw(fixture.rawDirectory, 0, raw);
    assert.equal(errorCode(() => reduceFixture(fixture)), expected);
  }
});

test("duplicate function identities and checked count/report aggregation overflow fail closed", (t) => {
  const duplicate = makeFixture(t);
  const duplicateScript = targetScript(duplicate);
  duplicateScript.functions.push(
    structuredClone(duplicateScript.functions[1]),
  );
  writeRaw(
    duplicate.rawDirectory,
    0,
    rawPayload([duplicateScript]),
  );
  assert.equal(
    errorCode(() => reduceFixture(duplicate)),
    "RAW_FUNCTION_DUPLICATE",
  );

  const countOverflow = makeFixture(t);
  writeRaw(
    countOverflow.rawDirectory,
    0,
    rawPayload([
      targetScript(countOverflow, {
        rootCount: Number.MAX_SAFE_INTEGER,
      }),
    ]),
  );
  writeRaw(
    countOverflow.rawDirectory,
    1,
    rawPayload([
      targetScript(countOverflow, {
        rootCount: Number.MAX_SAFE_INTEGER,
      }),
    ]),
  );
  assert.equal(
    errorCode(() => reduceFixture(countOverflow)),
    "MERGED_COUNT_OVERFLOW",
  );

  const reportFixture = makeFixture(t);
  writeRaw(
    reportFixture.rawDirectory,
    0,
    rawPayload([targetScript(reportFixture)]),
  );
  const report = reduceFixture(reportFixture);
  const inventoryOverflow = structuredClone(report);
  inventoryOverflow.rawInventory.targetScriptObservationCount =
    Number.MAX_SAFE_INTEGER;
  inventoryOverflow.rawInventory.nonTargetScriptObservationCount = 1;
  inventoryOverflow.rawInventory.scriptObservationCount =
    Number.MAX_SAFE_INTEGER;
  assert.equal(
    errorCode(() =>
      coverage.validateCanonicalCoverageReport(inventoryOverflow),
    ),
    "REPORT_INVENTORY_INCONSISTENT",
  );

  const manifestOverflow = structuredClone(report);
  const first = manifestOverflow.semanticInputManifest.entries[0];
  manifestOverflow.semanticInputManifest.entries = [
    {
      ...first,
      normalizedPayloadSha256: "0".repeat(64),
      multiplicity: Number.MAX_SAFE_INTEGER,
    },
    {
      ...first,
      normalizedPayloadSha256: "f".repeat(64),
      multiplicity: 1,
    },
  ];
  manifestOverflow.semanticInputManifest.uniquePayloadCount = 2;
  manifestOverflow.semanticInputManifest.targetPayloadCount =
    Number.MAX_SAFE_INTEGER;
  assert.equal(
    errorCode(() =>
      coverage.validateCanonicalCoverageReport(manifestOverflow),
    ),
    "REPORT_MANIFEST_SCHEMA_INVALID",
  );
});

test("strict JSON token walk rejects malformed escapes, numbers, separators, depth, and token excess", (t) => {
  const cases = [
    ['{"result":"\\x","timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":"\\uZZZZ","timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":"a\nb","timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":"unterminated,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":01,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":-,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":1.,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":1e,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":1e999,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result" 1,"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":[] "timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":[],}', "RAW_JSON_INVALID"],
    ['{"result":[null,],"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":[,null],"timestamp":1}', "RAW_JSON_INVALID"],
    ['{"result":[],"timestamp":truth}', "RAW_JSON_INVALID"],
    ['{"r\\u0065sult":[],"result":[],"timestamp":1}', "RAW_JSON_DUPLICATE_KEY"],
  ];
  for (const [text, expected] of cases) {
    const fixture = makeFixture(t);
    writeRawText(fixture.rawDirectory, 0, text);
    assert.equal(errorCode(() => reduceFixture(fixture)), expected);
  }

  const depthFixture = makeFixture(t);
  const depth =
    "[".repeat(coverage.BOUNDS.maxJsonDepth + 2) +
    "null" +
    "]".repeat(coverage.BOUNDS.maxJsonDepth + 2);
  writeRawText(depthFixture.rawDirectory, 0, depth);
  assert.equal(
    errorCode(() => reduceFixture(depthFixture)),
    "RAW_JSON_DEPTH_BOUND_EXCEEDED",
  );

  const tokenFixture = makeFixture(t);
  const tokenPayload = `[${Array.from(
    { length: coverage.BOUNDS.maxJsonTokens + 1 },
    () => "null",
  ).join(",")}]`;
  writeRawText(tokenFixture.rawDirectory, 0, tokenPayload);
  assert.equal(
    errorCode(() => reduceFixture(tokenFixture)),
    "RAW_JSON_TOKEN_BOUND_EXCEEDED",
  );
});

test("secure reader refuses owner drift, open failure, and pre/post identity mutation with typed errors", (t) => {
  const owner = makeFixture(t);
  const realGetuid = process.getuid;
  assert.equal(
    withPatched(
      process,
      "getuid",
      () => realGetuid() + 1,
      () => errorCode(() => reduceFixture(owner)),
    ),
    "SOURCE_OWNER_MISMATCH",
  );

  const noOwnerApi = makeFixture(t);
  assert.equal(
    withPatched(
      process,
      "getuid",
      undefined,
      () => errorCode(() => reduceFixture(noOwnerApi)),
    ),
    "OWNER_IDENTITY_UNAVAILABLE",
  );

  const openFailure = makeFixture(t);
  const realOpen = fs.openSync;
  assert.equal(
    withPatched(
      fs,
      "openSync",
      () => {
        const error = new Error("refused");
        error.code = "EACCES";
        throw error;
      },
      () => errorCode(() => reduceFixture(openFailure)),
    ),
    "SOURCE_PATH_NON_CANONICAL",
  );
  assert.equal(fs.openSync, realOpen);

  const beforeDrift = makeFixture(t);
  const realFstatBefore = fs.fstatSync;
  let beforeCalls = 0;
  assert.equal(
    withPatched(
      fs,
      "fstatSync",
      (descriptor, options) => {
        const stat = realFstatBefore(descriptor, options);
        beforeCalls++;
        return beforeCalls === 1
          ? alteredStat(stat, { mtimeNs: stat.mtimeNs + 1n })
          : stat;
      },
      () => errorCode(() => reduceFixture(beforeDrift)),
    ),
    "SOURCE_MUTATED_DURING_READ",
  );

  const afterDrift = makeFixture(t);
  const realFstatAfter = fs.fstatSync;
  let afterCalls = 0;
  assert.equal(
    withPatched(
      fs,
      "fstatSync",
      (descriptor, options) => {
        const stat = realFstatAfter(descriptor, options);
        afterCalls++;
        return afterCalls === 2
          ? alteredStat(stat, { ctimeNs: stat.ctimeNs + 1n })
          : stat;
      },
      () => errorCode(() => reduceFixture(afterDrift)),
    ),
    "SOURCE_MUTATED_DURING_READ",
  );

  const readGrowth = makeFixture(t);
  const realRead = fs.readFileSync;
  assert.equal(
    withPatched(
      fs,
      "readFileSync",
      (input, ...args) =>
        typeof input === "number"
          ? Buffer.alloc(coverage.BOUNDS.maxSourceBytes + 1)
          : realRead(input, ...args),
      () => errorCode(() => reduceFixture(readGrowth)),
    ),
    "SOURCE_SIZE_BOUND_EXCEEDED",
  );

  const genericFailure = makeFixture(t);
  assert.equal(
    withPatched(
      fs,
      "lstatSync",
      () => {
        throw new TypeError("hostile");
      },
      () => errorCode(() => reduceFixture(genericFailure)),
    ),
    "CANONICAL_COVERAGE_REDUCTION_REFUSED",
  );
});

test("standalone report validator executes all exact-schema and canonical-order refusals", (t) => {
  const fixture = makeFixture(t);
  const extraFunctions = [
    {
      functionName: "zeta",
      ranges: [
        { startOffset: 6, endOffset: 10, count: 1 },
        { startOffset: 7, endOffset: 8, count: 0 },
        { startOffset: 8, endOffset: 9, count: 0 },
      ],
      isBlockCoverage: true,
    },
  ];
  writeRaw(
    fixture.rawDirectory,
    0,
    rawPayload([
      targetScript(fixture, {
        ranges: [
          { startOffset: 1, endOffset: 4, count: 0 },
          { startOffset: 4, endOffset: 5, count: 0 },
        ],
        extraFunctions,
      }),
    ]),
  );
  const report = reduceFixture(fixture);
  const cases = [
    [
      "REPORT_VERSION_UNSUPPORTED",
      (copy) => {
        copy.schema = "other";
      },
    ],
    [
      "REPORT_MANIFEST_SCHEMA_INVALID",
      (copy) => {
        copy.rawEvidenceManifest.entries = {};
      },
    ],
    [
      "REPORT_MANIFEST_SCHEMA_INVALID",
      (copy) => {
        copy.semanticInputManifest.entries[0].normalizedPayloadSha256 = "bad";
      },
    ],
    [
      "REPORT_MANIFEST_INCONSISTENT",
      (copy) => {
        copy.rawEvidenceManifest.fileCount = 2;
      },
    ],
    [
      "REPORT_MANIFEST_HASH_INVALID",
      (copy) => {
        copy.rawEvidenceManifest.rawEvidenceManifestSha256 = "0".repeat(64);
      },
    ],
    [
      "REPORT_TARGETS_INVALID",
      (copy) => {
        copy.targets = [];
      },
    ],
    [
      "REPORT_SOURCE_BINDING_INVALID",
      (copy) => {
        copy.targets[0].url = "file:///wrong";
      },
    ],
    [
      "REPORT_FUNCTION_SCHEMA_INVALID",
      (copy) => {
        copy.targets[0].functions = [];
      },
    ],
    [
      "REPORT_FUNCTION_SCHEMA_INVALID",
      (copy) => {
        copy.targets[0].functions[0].isScriptGlobal = false;
      },
    ],
    [
      "REPORT_FUNCTION_SCHEMA_INVALID",
      (copy) => {
        copy.targets[0].functions[1].isBlockCoverage = "true";
      },
    ],
    [
      "REPORT_FUNCTION_ROOT_INVALID",
      (copy) => {
        copy.targets[0].functions[1].root.startOffset++;
      },
    ],
    [
      "REPORT_FUNCTION_ORDER_INVALID",
      (copy) => {
        const tail = copy.targets[0].functions.slice(1).reverse();
        copy.targets[0].functions.splice(1, tail.length, ...tail);
      },
    ],
    [
      "REPORT_RANGE_ORDER_INVALID",
      (copy) => {
        const fn = copy.targets[0].functions[1];
        [fn.ranges[1], fn.ranges[2]] = [fn.ranges[2], fn.ranges[1]];
      },
    ],
    [
      "REPORT_UNCOVERED_RANGES_INCONSISTENT",
      (copy) => {
        const fn = copy.targets[0].functions[1];
        fn.uncoveredIntervals.push({ ...fn.uncoveredIntervals[0] });
      },
    ],
    [
      "REPORT_UNCOVERED_LINES_INVALID",
      (copy) => {
        copy.targets[0].uncoveredLineNumbers = {};
      },
    ],
    [
      "REPORT_METRIC_INCONSISTENT",
      (copy) => {
        copy.totals.lines.covered--;
      },
    ],
    [
      "REPORT_SEMANTIC_HASH_INVALID",
      (copy) => {
        copy.semanticCoverageSha256 = "malformed";
      },
    ],
    [
      "REPORT_EVIDENCE_HASH_INVALID",
      (copy) => {
        copy.evidenceReportSha256 = "malformed";
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const copy = structuredClone(report);
    mutate(copy);
    assert.equal(
      errorCode(() => coverage.validateCanonicalCoverageReport(copy)),
      expected,
    );
  }
});
