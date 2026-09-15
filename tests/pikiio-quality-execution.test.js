"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  DEPENDENCY_AUDIT_ARGS,
  LOCKED_INSTALL_ARGS,
  REQUIRED_AUXILIARY_RELATIVE_PATHS,
  REQUIRED_AUTOMATION_IDS,
  assertOperationalCheckoutUnchanged,
  captureAutomationInputs,
  captureOperationalCheckout,
  computeAutomationSnapshotDigest,
  materializeAutomationInputs,
  verifyDependencyAudit,
} = require("../lib/pikiio-quality-execution");
const {
  assertOperationalGitConfigSafe,
  assertIndependentJudge,
  isolatedCommand,
  parseTap,
  requirePerFileCoverage,
  runLayer,
  scrubQualityEnvironment,
} = require("../scripts/run-pikiio-quality-gauntlet");

test("coverage parser preserves every file and refuses aggregate dilution", () => {
  const parsed = parseTap([
    "# tests 2",
    "# suites 0",
    "# pass 2",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# lib                          |        |          |         |",
    "#  strong.js                   | 100.00 |   100.00 |  100.00 |",
    "#  weak.js                     |  20.00 |    10.00 |   50.00 |",
    "# all                          |  95.00 |    90.00 |   95.00 |",
  ].join("\n"));
  assert.deepEqual(parsed.coverage, {
    lines: 95,
    branches: 90,
    functions: 95,
  });
  assert.deepEqual(parsed.coverageFiles["lib/strong.js"], {
    lines: 100,
    branches: 100,
    functions: 100,
  });
  assert.deepEqual(parsed.coverageFiles["lib/weak.js"], {
    lines: 20,
    branches: 10,
    functions: 50,
  });
  const receipt = { parsed };
  const profile = {
    minimumLineCoveragePercent: 95,
    minimumBranchCoveragePercent: 90,
    minimumFunctionCoveragePercent: 95,
  };
  assert.equal(
    requirePerFileCoverage(
      [receipt],
      ["lib/strong.js"],
      profile,
    )[0][0].metrics.lines,
    100,
  );
  assert.throws(
    () =>
      requirePerFileCoverage(
        [receipt],
        ["lib/strong.js", "lib/weak.js"],
        profile,
      ),
    (error) =>
      error.code === "QUALITY_PER_FILE_COVERAGE_FAILED" &&
      error.details.invalidFileCoverage[0].relativePath === "lib/weak.js",
  );
  assert.throws(
    () =>
      requirePerFileCoverage(
        [receipt],
        ["lib/missing.js"],
        profile,
      ),
    (error) =>
      error.code === "QUALITY_PER_FILE_COVERAGE_FAILED" &&
      error.details.invalidFileCoverage[0].metrics === null,
  );
});

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeAutomationFixture(root) {
  for (const id of REQUIRED_AUTOMATION_IDS) {
    writeFile(
      path.join(root, "automations", id, "automation.toml"),
      `id = "${id}"\nstatus = "PAUSED"\n`,
    );
  }
  writeFile(
    path.join(
      root,
      "automations",
      "pikiio-governed-builder-heartbeat",
      "memory.md",
    ),
    "pikiio-agent-heartbeat-memory-v1\n",
  );
}

function writeDependencyFixture(root, dependencies = { alpha: "1.2.3" }) {
  writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", dependencies })}\n`,
  );
  writeFile(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies },
        ...Object.fromEntries(
          Object.entries(dependencies).map(([name, version]) => [
            `node_modules/${name}`,
            { version },
          ]),
        ),
      },
    })}\n`,
  );
  writeFile(
    path.join(root, "node_modules", ".package-lock.json"),
    `${JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(dependencies).map(([name, version]) => [
          `node_modules/${name}`,
          { version },
        ]),
      ),
    })}\n`,
  );
}

test("automation snapshot contains only allowlisted regular inputs", () => {
  const root = temporaryDirectory("pikiio-quality-automation-");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  try {
    for (const id of REQUIRED_AUTOMATION_IDS) {
      writeFile(
        path.join(source, "automations", id, "automation.toml"),
        `id = "${id}"\nstatus = "PAUSED"\n`,
      );
      writeFile(
        path.join(source, "automations", id, "memory.md"),
        id === "pikiio-governed-builder-heartbeat"
          ? "heartbeat-memory\n"
          : "must-not-be-copied\n",
      );
    }
    writeFile(
      path.join(source, "automations", "unrelated", "automation.toml"),
      "secret = true\n",
    );
    const snapshot = captureAutomationInputs(source);
    const materialized = materializeAutomationInputs(snapshot, target);
    assert.equal(
      materialized.files.length,
      REQUIRED_AUTOMATION_IDS.length +
        REQUIRED_AUXILIARY_RELATIVE_PATHS.length,
    );
    assert.deepEqual(
      materialized.files
        .filter((entry) => !entry.id.startsWith("auxiliary:"))
        .map((entry) => entry.id)
        .sort(),
      [...REQUIRED_AUTOMATION_IDS].sort(),
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          target,
          "automations",
          "pikiio-governed-builder-heartbeat",
          "memory.md",
        ),
        "utf8",
      ),
      "heartbeat-memory\n",
    );
    assert.equal(
      fs.existsSync(
        path.join(
          target,
          "automations",
          "pq-gmail-job-processor",
          "memory.md",
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(target, "automations", "unrelated", "automation.toml"),
      ),
      false,
    );
    assert.match(fs.readFileSync(materialized.npmUserConfigPath, "utf8"), /offline=true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automation capture fails closed on invalid, missing, and oversized inputs", () => {
  const root = temporaryDirectory("pikiio-quality-capture-negative-");
  try {
    writeAutomationFixture(root);
    assert.throws(
      () => captureAutomationInputs(root, { requiredIds: ["BAD ID"] }),
      (error) => error.code === "AUTOMATION_SNAPSHOT_ID_INVALID",
    );

    fs.rmSync(
      path.join(
        root,
        "automations",
        "pq-morning-shipment-refresh",
        "automation.toml",
      ),
    );
    assert.throws(
      () => captureAutomationInputs(root),
      (error) =>
        error.code === "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING",
    );

    writeAutomationFixture(root);
    fs.writeFileSync(
      path.join(
        root,
        "automations",
        "pq-morning-shipment-refresh",
        "automation.toml",
      ),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    assert.throws(
      () => captureAutomationInputs(root),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INPUT_TOO_LARGE",
    );

    writeAutomationFixture(root);
    assert.throws(
      () =>
        captureAutomationInputs(root, {
          requiredAuxiliaryPaths: ["../escape.md"],
        }),
      (error) => error.code === "AUTOMATION_SNAPSHOT_PATH_INVALID",
    );
    assert.throws(
      () =>
        captureAutomationInputs(root, {
          requiredAuxiliaryPaths: ["automations/missing/memory.md"],
        }),
      (error) =>
        error.code === "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING",
    );
    fs.writeFileSync(
      path.join(
        root,
        "automations",
        "pikiio-governed-builder-heartbeat",
        "memory.md",
      ),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    assert.throws(
      () => captureAutomationInputs(root),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INPUT_TOO_LARGE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime evidence capture is bounded, canonical, and symlink-free", () => {
  const root = temporaryDirectory("pikiio-quality-runtime-input-");
  const activationPath = path.join(
    root,
    "runtime",
    "pikiio-agent",
    "heartbeat-activation-receipt.json",
  );
  const qualityPath = path.join(
    root,
    "runtime",
    "pikiio-agent",
    "quality-receipt.json",
  );
  try {
    writeAutomationFixture(root);
    assert.throws(
      () =>
        captureAutomationInputs(root, {
          optionalRuntimePaths: ["../escape.json"],
        }),
      (error) => error.code === "AUTOMATION_SNAPSHOT_PATH_INVALID",
    );

    writeFile(path.join(root, "runtime", "target.json"), "{}\n");
    fs.mkdirSync(path.dirname(activationPath), { recursive: true });
    fs.symlinkSync(
      path.join(root, "runtime", "target.json"),
      activationPath,
    );
    assert.throws(
      () => captureAutomationInputs(root),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INPUT_INVALID",
    );

    fs.rmSync(activationPath);
    fs.writeFileSync(activationPath, Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.throws(
      () => captureAutomationInputs(root),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INPUT_TOO_LARGE",
    );

    fs.writeFileSync(activationPath, "{\"activation\":true}\n");
    writeFile(qualityPath, "{\"quality\":true}\n");
    const snapshot = captureAutomationInputs(root);
    assert.equal(
      snapshot.entries.filter((entry) => entry.id.startsWith("runtime:"))
        .length,
      2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automation materialization verifies manifest, digest, content, and paths", () => {
  const root = temporaryDirectory("pikiio-quality-materialize-negative-");
  const source = path.join(root, "source");
  try {
    writeAutomationFixture(source);
    const snapshot = captureAutomationInputs(source);
    assert.throws(
      () => materializeAutomationInputs(null, path.join(root, "null")),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INVALID",
    );

    const missingLists = { ...snapshot, requiredIds: null };
    assert.throws(
      () => materializeAutomationInputs(missingLists, path.join(root, "lists")),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INVALID",
    );

    const tamperedContent = {
      ...snapshot,
      entries: snapshot.entries.map((entry, index) => ({
        ...entry,
        content: index === 0 ? Buffer.from("tampered") : entry.content,
      })),
    };
    assert.throws(
      () =>
        materializeAutomationInputs(
          tamperedContent,
          path.join(root, "tampered-content"),
        ),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INVALID",
    );

    const digestMismatch = {
      ...snapshot,
      digest: "0".repeat(64),
    };
    assert.throws(
      () =>
        materializeAutomationInputs(
          digestMismatch,
          path.join(root, "digest"),
        ),
      (error) => error.code === "AUTOMATION_SNAPSHOT_DIGEST_MISMATCH",
    );

    const escapedEntry = {
      ...snapshot.entries[0],
      relativePath: "../escape.toml",
    };
    const escaped = {
      ...snapshot,
      entries: [escapedEntry, ...snapshot.entries.slice(1)],
    };
    assert.throws(
      () => materializeAutomationInputs(escaped, path.join(root, "escape")),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INVALID",
    );

    const duplicate = {
      ...snapshot,
      entries: [snapshot.entries[0], snapshot.entries[0]],
    };
    assert.throws(
      () =>
        materializeAutomationInputs(duplicate, path.join(root, "duplicate")),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INVALID",
    );

    const omittedRequired = {
      ...snapshot,
      entries: snapshot.entries.filter(
        (entry) =>
          entry.relativePath !==
          path.join(
            "automations",
            "pq-morning-shipment-refresh",
            "automation.toml",
          ),
      ),
    };
    omittedRequired.digest =
      computeAutomationSnapshotDigest(omittedRequired);
    assert.throws(
      () =>
        materializeAutomationInputs(
          omittedRequired,
          path.join(root, "omitted-required"),
        ),
      (error) =>
        error.code === "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING",
    );

    const invalidId = {
      ...snapshot,
      entries: snapshot.entries.map((entry, index) => ({
        ...entry,
        id: index === 0 ? "" : entry.id,
      })),
    };
    assert.throws(
      () =>
        materializeAutomationInputs(
          invalidId,
          path.join(root, "invalid-id"),
        ),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INVALID",
    );

    const nonBuffer = {
      ...snapshot,
      entries: snapshot.entries.map((entry, index) => ({
        ...entry,
        content: index === 0 ? "not-a-buffer" : entry.content,
        size: index === 0 ? "not-a-buffer".length : entry.size,
      })),
    };
    nonBuffer.digest = computeAutomationSnapshotDigest(nonBuffer);
    assert.throws(
      () =>
        materializeAutomationInputs(
          nonBuffer,
          path.join(root, "non-buffer"),
        ),
      (error) => error.code === "AUTOMATION_SNAPSHOT_CONTENT_CHANGED",
    );

    const contentHashMismatch = {
      ...snapshot,
      entries: snapshot.entries.map((entry, index) => ({
        ...entry,
        contentSha256:
          index === 0 ? "f".repeat(64) : entry.contentSha256,
      })),
    };
    contentHashMismatch.digest = require("../lib/pikiio-agent-governance").sha256(
      require("../lib/pikiio-agent-governance").stableJson({
        entries: contentHashMismatch.entries
          .map(({ content, ...entry }) => entry)
          .sort((left, right) =>
            left.relativePath.localeCompare(right.relativePath),
          ),
        requiredIds: contentHashMismatch.requiredIds,
        optionalIds: contentHashMismatch.optionalIds,
        requiredAuxiliaryPaths:
          contentHashMismatch.requiredAuxiliaryPaths,
        optionalRuntimePaths: contentHashMismatch.optionalRuntimePaths,
      }),
    );
    assert.throws(
      () =>
        materializeAutomationInputs(
          contentHashMismatch,
          path.join(root, "content-hash"),
        ),
      (error) => error.code === "AUTOMATION_SNAPSHOT_CONTENT_CHANGED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automation snapshot refuses symlinked configuration", () => {
  const root = temporaryDirectory("pikiio-quality-symlink-");
  try {
    for (const id of REQUIRED_AUTOMATION_IDS) {
      const automationPath = path.join(
        root,
        "automations",
        id,
        "automation.toml",
      );
      fs.mkdirSync(path.dirname(automationPath), { recursive: true });
      if (id === REQUIRED_AUTOMATION_IDS[0]) {
        const target = path.join(root, "outside.toml");
        fs.writeFileSync(target, "status = \"PAUSED\"\n");
        fs.symlinkSync(target, automationPath);
      } else {
        fs.writeFileSync(automationPath, "status = \"PAUSED\"\n");
      }
    }
    writeFile(
      path.join(
        root,
        "automations",
        "pikiio-governed-builder-heartbeat",
        "memory.md",
      ),
      "pikiio-agent-heartbeat-memory-v1\n",
    );
    assert.throws(
      () => captureAutomationInputs(root),
      (error) => error.code === "AUTOMATION_SNAPSHOT_INPUT_INVALID",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operational checkout proof detects a byte change", () => {
  const repo = temporaryDirectory("pikiio-quality-repo-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "quality@example.invalid"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "Quality Judge"], {
      cwd: repo,
    });
    writeFile(path.join(repo, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    const before = captureOperationalCheckout(repo);
    const unchanged = captureOperationalCheckout(repo);
    assert.equal(assertOperationalCheckoutUnchanged(before, unchanged), true);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");
    const after = captureOperationalCheckout(repo);
    assert.throws(
      () => assertOperationalCheckoutUnchanged(before, after),
      (error) => error.code === "OPERATIONAL_CHECKOUT_CHANGED",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("dependency audit binds both lockfiles and rejects extraneous packages", () => {
  const root = temporaryDirectory("pikiio-quality-deps-");
  try {
    writeDependencyFixture(root);
    const tree = {
      name: "fixture",
      version: "1.0.0",
      dependencies: {
        alpha: { version: "1.2.3", resolved: "file:alpha" },
      },
    };
    const receipt = verifyDependencyAudit({
      repoRoot: root,
      stdout: JSON.stringify(tree),
    });
    assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.dependencies.length, 1);
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify({
            ...tree,
            dependencies: {
              alpha: {
                version: "1.2.3",
                dependencies: {
                  stray: { version: "9.9.9", extraneous: true },
                },
              },
            },
          }),
        }),
      (error) => error.code === "DEPENDENCY_AUDIT_FAILED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dependency audit rejects command, JSON, problem, marker, and lock failures", () => {
  const root = temporaryDirectory("pikiio-quality-deps-negative-");
  const cleanTree = {
    name: "fixture",
    version: "1.0.0",
    dependencies: {
      alpha: {
        version: null,
        resolved: null,
        overridden: true,
      },
    },
  };
  try {
    writeDependencyFixture(root);
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: "{}",
          status: 1,
          stderr: "failed",
        }),
      (error) => error.code === "DEPENDENCY_AUDIT_COMMAND_FAILED",
    );
    assert.throws(
      () => verifyDependencyAudit({ repoRoot: root, stdout: "not-json" }),
      (error) => error.code === "DEPENDENCY_AUDIT_JSON_INVALID",
    );
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify({ name: "fixture", dependencies: {} }),
        }),
      (error) => error.code === "DEPENDENCY_AUDIT_ROOT_MISMATCH",
    );
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify({
            ...cleanTree,
            problems: ["invalid: alpha"],
          }),
        }),
      (error) => error.code === "DEPENDENCY_AUDIT_FAILED",
    );
    for (const marker of ["invalid", "missing"]) {
      assert.throws(
        () =>
          verifyDependencyAudit({
            repoRoot: root,
            stdout: JSON.stringify({
              ...cleanTree,
              dependencies: {
                alpha: { version: "1.0.0", [marker]: true },
              },
            }),
          }),
        (error) => error.code === "DEPENDENCY_AUDIT_FAILED",
      );
    }
    const clean = verifyDependencyAudit({
      repoRoot: root,
      stdout: JSON.stringify(cleanTree),
    });
    assert.equal(clean.dependencies[0].overridden, true);
    assert.equal(clean.dependencies[0].version, null);

    fs.rmSync(path.join(root, "node_modules", ".package-lock.json"));
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify(cleanTree),
        }),
      (error) => error.code === "DEPENDENCY_LOCK_EVIDENCE_MISSING",
    );
    fs.mkdirSync(path.join(root, "node_modules", ".package-lock.json"));
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify(cleanTree),
        }),
      (error) => error.code === "DEPENDENCY_LOCK_EVIDENCE_MISSING",
    );
    fs.rmSync(path.join(root, "node_modules", ".package-lock.json"), {
      recursive: true,
    });
    writeFile(
      path.join(root, "node_modules", ".package-lock.json"),
      "not-json\n",
    );
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify(cleanTree),
        }),
      (error) => error.code === "DEPENDENCY_LOCK_EVIDENCE_INVALID",
    );
    writeDependencyFixture(root);
    fs.writeFileSync(path.join(root, "package.json"), "null\n");
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify(cleanTree),
        }),
      (error) => error.code === "DEPENDENCY_LOCK_EVIDENCE_INVALID",
    );
    writeDependencyFixture(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: [] }),
    );
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify(cleanTree),
        }),
      (error) => error.code === "DEPENDENCY_LOCK_EVIDENCE_INVALID",
    );
    writeDependencyFixture(root);
    const invalidInstalledLock = JSON.parse(
      fs.readFileSync(
        path.join(root, "node_modules", ".package-lock.json"),
        "utf8",
      ),
    );
    invalidInstalledLock.lockfileVersion = 2;
    fs.writeFileSync(
      path.join(root, "node_modules", ".package-lock.json"),
      JSON.stringify(invalidInstalledLock),
    );
    assert.throws(
      () =>
        verifyDependencyAudit({
          repoRoot: root,
          stdout: JSON.stringify(cleanTree),
        }),
      (error) => error.code === "DEPENDENCY_LOCK_EVIDENCE_INVALID",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tracked symlinks are bound by the operational manifest", () => {
  const repo = temporaryDirectory("pikiio-quality-symlink-repo-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "quality@example.invalid"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "Quality Judge"], {
      cwd: repo,
    });
    writeFile(path.join(repo, "target.txt"), "target\n");
    fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
    execFileSync("git", ["add", "target.txt", "link.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    const evidence = captureOperationalCheckout(repo);
    assert.match(evidence.receiptHash, /^[a-f0-9]{64}$/);
    fs.rmSync(path.join(repo, "link.txt"));
    fs.symlinkSync("other.txt", path.join(repo, "link.txt"));
    const changed = captureOperationalCheckout(repo);
    assert.notEqual(evidence.receiptHash, changed.receiptHash);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("dependency installation contract is lockfile-only, offline, and scriptless", () => {
  assert.deepEqual(LOCKED_INSTALL_ARGS, [
    "ci",
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--include=dev",
    "--include=optional",
    "--include=peer",
    "--workspaces=false",
  ]);
  assert.deepEqual(DEPENDENCY_AUDIT_ARGS, [
    "ls",
    "--all",
    "--json",
    "--long",
  ]);
  const runner = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "run-pikiio-quality-gauntlet.js"),
    "utf8",
  );
  assert.doesNotMatch(runner, /symlinkSync\s*\([^)]*node_modules/);
  assert.doesNotMatch(runner, /executePlan\s*\(\s*\{\s*root:\s*ROOT/);
  assert.doesNotMatch(runner, /PIKIIO_CLEAN_JUDGE/);
});

test("toolchain resolution ignores a poisoned npm_execpath", () => {
  const root = temporaryDirectory("pikiio-quality-poisoned-npm-");
  try {
    const poison = path.join(root, "poison.js");
    fs.writeFileSync(poison, "throw new Error('poison executed');\n");
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const runner=require('./scripts/run-pikiio-quality-gauntlet');",
          "console.log(JSON.stringify(runner.qualityToolchainEvidence()));",
        ].join(""),
      ],
      {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          npm_execpath: poison,
        },
      },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const toolchain = JSON.parse(probe.stdout);
    assert.notEqual(toolchain.npmCliPath, poison);
    assert.equal(toolchain.platform, process.platform);
    assert.equal(toolchain.arch, process.arch);
    assert.match(toolchain.npmCliSha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality environment drops inherited npm, Node, shell, and test injection", () => {
  const clean = scrubQualityEnvironment({
    PATH: "/tmp/poison",
    NODE_PATH: "/tmp/injected-modules",
    BASH_ENV: "/tmp/injected-shell",
    ENV: "/tmp/injected-env",
    ZDOTDIR: "/tmp/injected-zdotdir",
    npm_config_omit: "dev",
    npm_config_workspaces: "true",
    TEST_RETRIES: "99",
    PIKIIO_ACTION_PHASE_ACCEPTANCE: "ACTION-99",
    PIKIIO_CODEX_GOAL_OBJECTIVE: "goal",
    PIKIIO_CODEX_GOAL_THREAD_ID: "thread",
  });
  for (const key of [
    "NODE_PATH",
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "npm_config_omit",
    "npm_config_workspaces",
    "TEST_RETRIES",
    "PIKIIO_ACTION_PHASE_ACCEPTANCE",
  ]) {
    assert.equal(Object.hasOwn(clean, key), false, key);
  }
  assert.notEqual(clean.PATH, "/tmp/poison");
  assert.equal(clean.PIKIIO_CODEX_GOAL_OBJECTIVE, "goal");
  assert.equal(clean.PIKIIO_CODEX_GOAL_THREAD_ID, "thread");
  const profiled = scrubQualityEnvironment({}, {
    PIKIIO_PHASE_PROOF_PROFILE: "ACTION-01",
    PIKIIO_ACTION_PHASE_ACCEPTANCE: "ACTION-01",
  });
  assert.equal(profiled.PIKIIO_PHASE_PROOF_PROFILE, "ACTION-01");
  assert.equal(profiled.PIKIIO_ACTION_PHASE_ACCEPTANCE, "ACTION-01");
  assert.throws(
    () => scrubQualityEnvironment({}, { NODE_PATH: "/tmp/poison" }),
    (error) => error.code === "QUALITY_ENVIRONMENT_OVERRIDE_INVALID",
  );
});

test("Git metadata access rejects credential-bearing or executable config", () => {
  const root = temporaryDirectory("pikiio-quality-git-config-");
  try {
    const safePath = path.join(root, "safe.config");
    fs.writeFileSync(
      safePath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[remote "origin"]',
        "\turl = https://github.com/example/repo.git",
        "",
      ].join("\n"),
    );
    assert.match(assertOperationalGitConfigSafe(safePath), /^[a-f0-9]{64}$/);
    const unsafePath = path.join(root, "unsafe.config");
    fs.writeFileSync(
      unsafePath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "[credential]",
        "\thelper = !print-secret",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => assertOperationalGitConfigSafe(unsafePath),
      (error) => error.code === "QUALITY_GIT_CONFIG_UNSAFE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic receipts preserve domain timestamps and shipment identifiers", () => {
  const root = temporaryDirectory("pikiio-quality-semantic-");
  try {
    const receipt = (output) =>
      runLayer({
        name: "domain-evidence",
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        cwd: root,
        env: {
          PATH: process.env.PATH,
          TMPDIR: root,
        },
        checkId: "domain-evidence",
        definitionSha256: "a".repeat(64),
        displayCommand: "node domain-evidence-probe",
      });
    const first = receipt(
      "shipment=11111111-1111-4111-8111-111111111111 evidence=2026-07-24T01:00:00Z\n",
    );
    const second = receipt(
      "shipment=22222222-2222-4222-8222-222222222222 evidence=2026-07-24T02:00:00Z\n",
    );
    assert.notEqual(first.semanticSha256, second.semanticSha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("raw judge artifacts are content-addressed and read back", () => {
  const codexHome = temporaryDirectory("pikiio-quality-raw-artifact-");
  try {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const runner=require('./scripts/run-pikiio-quality-gauntlet');",
          "const judge={",
          "label:'primary',candidateCommit:'a'.repeat(40),candidateTree:'b'.repeat(40),",
          "automationSnapshotSha256:'c'.repeat(64),",
          "dependencies:{manifest:{manifestSha256:'d'.repeat(64)},toolchain:{toolchainSha256:'e'.repeat(64)}},",
          "receipts:[{name:'layer',checkId:'check',definitionSha256:'f'.repeat(64),command:'node check',isolation:'macos-sandbox-deny-network',startedAt:'2026-07-24T01:00:00Z',finishedAt:'2026-07-24T01:00:01Z',status:0,signal:null,timedOut:false,stdout:'raw shipment evidence',stderr:'',parsed:null,semanticSha256:'1'.repeat(64)}]",
          "};",
          "console.log(JSON.stringify(runner.persistJudgeArtifacts(judge)));",
        ].join(""),
      ],
      {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const artifact = JSON.parse(probe.stdout);
    assert.equal(artifact.layerCount, 1);
    assert.match(artifact.artifactSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      require("../lib/pikiio-agent-governance").sha256(
        fs.readFileSync(artifact.artifactPath),
      ),
      artifact.artifactSha256,
    );
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("independent judge comparison binds candidate, dependencies, and layers", () => {
  const judge = {
    candidateCommit: "a".repeat(40),
    candidateTree: "b".repeat(40),
    automationSnapshotSha256: "c".repeat(64),
    dependencies: {
      manifest: { manifestSha256: "d".repeat(64) },
      toolchain: { toolchainSha256: "e".repeat(64) },
    },
    summary: {
      metrics: { cleanCheckoutReproduced: false, failedTests: 0 },
      populations: { unit: [], mutation: [], gherkin: [] },
      layerDigests: [
        { name: "layer", semanticSha256: "f".repeat(64) },
      ],
    },
    worktreeHead: "a".repeat(40),
    worktreeTree: "b".repeat(40),
    workspaceUnchanged: true,
    rawArtifact: {
      schema: "pikiio-quality-judge-raw-artifact-v1",
      artifactPath: "/tmp/artifact.json",
      artifactSha256: "1".repeat(64),
      byteLength: 100,
      layerCount: 1,
    },
  };
  const reproduced = assertIndependentJudge(
    structuredClone(judge),
    structuredClone(judge),
  );
  assert.equal(reproduced.reproduced, true);
  assert.equal(
    reproduced.dependencyManifest.manifestSha256,
    "d".repeat(64),
  );
  const divergent = structuredClone(judge);
  divergent.summary.layerDigests[0].semanticSha256 = "0".repeat(64);
  assert.throws(
    () => assertIndependentJudge(judge, divergent),
    (error) => error.code === "CLEAN_CHECKOUT_REPRODUCTION_MISMATCH",
  );
});

test(
  "macOS sandbox preserves Unix IPC while denying network and checkout access",
  { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") },
  async () => {
    const socketRoot = fs.mkdtempSync("/private/tmp/pikiio-quality-ipc-");
    const socketPath = path.join(socketRoot, "judge.sock");
    const protectedRoot = temporaryDirectory("pikiio-quality-protected-");
    const protectedPath = path.join(protectedRoot, "operator-state.txt");
    fs.writeFileSync(protectedPath, "unchanged\n");
    const serverSource = [
      'const net=require("node:net");',
      'const unix=net.createServer((socket)=>socket.end("ok"));',
      'const tcp=net.createServer((socket)=>socket.end("unexpected"));',
      "unix.listen(process.env.SOCKET,()=>{",
      'tcp.listen(0,"127.0.0.1",()=>{',
      "process.stdout.write(JSON.stringify({port:tcp.address().port})+'\\n');",
      "});",
      "});",
      "setInterval(()=>{},1000);",
    ].join("");
    const server = spawn(process.execPath, ["-e", serverSource], {
      env: { ...process.env, SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(
          () => reject(new Error("fixture server startup timed out")),
          5000,
        );
        server.once("error", reject);
        server.stdout.on("data", (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          resolve(JSON.parse(buffer.slice(0, newline)).port);
        });
      });
      const probeSource = [
        'const net=require("node:net");',
        'const fs=require("node:fs");',
        "function connect(options){return new Promise((resolve)=>{",
        "const socket=net.connect(options,()=>{socket.end();resolve({ok:true});});",
        'socket.once("error",(error)=>resolve({ok:false,code:error.code}));',
        "});}",
        "(async()=>{",
        "const unix=await connect({path:process.env.SOCKET});",
        'const tcp=await connect({host:"127.0.0.1",port:Number(process.env.PORT)});',
        "let write;",
        'try{fs.writeFileSync(process.env.PROTECTED,"changed\\n");write={ok:true};}',
        "catch(error){write={ok:false,code:error.code};}",
        "let read;",
        "try{fs.readFileSync(process.env.OPERATIONAL_SECRET);read={ok:true};}",
        "catch(error){read={ok:false,code:error.code};}",
        "let codexRead;",
        "try{fs.readFileSync(process.env.REAL_CODEX_INPUT);codexRead={ok:true};}",
        "catch(error){codexRead={ok:false,code:error.code};}",
        "console.log(JSON.stringify({unix,tcp,write,read,codexRead}));",
        "})();",
      ].join("");
      const isolated = isolatedCommand(process.execPath, ["-e", probeSource], {
        socketRoot,
      });
      const probe = spawnSync(isolated.command, isolated.args, {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          SOCKET: socketPath,
          PORT: String(port),
          PROTECTED: protectedPath,
          OPERATIONAL_SECRET: path.join(__dirname, "..", ".env.local"),
          REAL_CODEX_INPUT: path.join(
            os.homedir(),
            ".codex",
            "automations",
            "pikiio-governed-builder-heartbeat",
            "automation.toml",
          ),
        },
      });
      assert.equal(probe.status, 0, probe.stderr);
      const result = JSON.parse(probe.stdout);
      assert.deepEqual(result.unix, { ok: true });
      assert.equal(result.tcp.ok, false);
      assert.match(result.tcp.code || "", /^(?:EPERM|EACCES)$/);
      assert.equal(result.write.ok, false);
      assert.match(result.write.code || "", /^(?:EPERM|EACCES)$/);
      assert.equal(fs.readFileSync(protectedPath, "utf8"), "unchanged\n");
      assert.equal(result.read.ok, false);
      assert.match(result.read.code || "", /^(?:EPERM|EACCES)$/);
      assert.equal(result.codexRead.ok, false);
      assert.match(result.codexRead.code || "", /^(?:EPERM|EACCES)$/);
    } finally {
      server.kill("SIGTERM");
      fs.rmSync(socketRoot, { recursive: true, force: true });
      fs.rmSync(protectedRoot, { recursive: true, force: true });
    }
  },
);
