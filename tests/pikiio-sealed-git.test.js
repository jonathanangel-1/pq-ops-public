"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync, spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const {
  SealedGitError,
  SEALED_ENVIRONMENT,
  createSealedGit,
  resolveTrustedGitExecutable,
} = require("../lib/pikiio-sealed-git");

const SYSTEM_GIT = "/usr/bin/git";
const SYSTEM_BROKER = "/usr/bin/perl";
const TEMP_ROOTS = [];
let REPOSITORY_TEMPLATE = null;
const FIXED_GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Pikiio Sealed Git Test",
  GIT_AUTHOR_EMAIL: "sealed-git@example.invalid",
  GIT_COMMITTER_NAME: "Pikiio Sealed Git Test",
  GIT_COMMITTER_EMAIL: "sealed-git@example.invalid",
  GIT_AUTHOR_DATE: "2026-07-24T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-07-24T12:00:00Z",
});

function tempRoot(prefix = "pikiio-sealed-git-") {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  TEMP_ROOTS.push(root);
  return root;
}

function git(repoRoot, args, options = {}) {
  return execFileSync(SYSTEM_GIT, args, {
    cwd: repoRoot,
    env: { ...FIXED_GIT_ENVIRONMENT },
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function repositoryTemplate() {
  if (REPOSITORY_TEMPLATE) return REPOSITORY_TEMPLATE;
  const root = tempRoot();
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "first state\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "--quiet", "-m", "first"]);
  const first = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "second state\n");
  fs.writeFileSync(
    path.join(root, "large.txt"),
    "x".repeat(8192),
  );
  git(root, ["add", "tracked.txt", "large.txt"]);
  git(root, ["commit", "--quiet", "-m", "second"]);
  const second = git(root, ["rev-parse", "HEAD"]);
  const secondTree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const trackedBlob = git(root, ["rev-parse", "HEAD:tracked.txt"]);
  REPOSITORY_TEMPLATE = {
    root,
    first,
    second,
    secondTree,
    trackedBlob,
  };
  return REPOSITORY_TEMPLATE;
}

function initializeRepository() {
  const template = repositoryTemplate();
  const parent = tempRoot("pikiio-sealed-git-fixture-");
  const root = path.join(parent, "repo");
  fs.cpSync(template.root, root, { recursive: true });
  return {
    root: fs.realpathSync.native(root),
    first: template.first,
    second: template.second,
    secondTree: template.secondTree,
    trackedBlob: template.trackedBlob,
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.name, "SealedGitError");
    assert.equal(error.code, code);
    return true;
  };
}

function assertCompletedChildReceipt(
  receipt,
  {
    expectedStatus,
    label,
    targetedTestName = null,
    assertionSignature = null,
  },
) {
  assert.equal(receipt.error, undefined, `${label} spawn error`);
  assert.equal(receipt.signal, null, `${label} termination signal`);
  assert.equal(
    Number.isInteger(receipt.status),
    true,
    `${label} concrete exit status`,
  );
  assert.equal(
    receipt.status,
    expectedStatus,
    `${label} exit status\n${receipt.stdout}\n${receipt.stderr}`,
  );
  if (targetedTestName !== null) {
    assert.match(
      receipt.stdout,
      new RegExp(
        `✖ ${targetedTestName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        "u",
      ),
      `${label} exact targeted test`,
    );
  }
  if (assertionSignature !== null) {
    assert.equal(
      `${receipt.stdout}\n${receipt.stderr}`.includes(assertionSignature),
      true,
      `${label} targeted assertion signature`,
    );
  }
}

function gitIndexBytes(payload) {
  const body = Buffer.from(payload);
  return Buffer.concat([
    body,
    require("node:crypto").createHash("sha1").update(body).digest(),
  ]);
}

function withPoisonedEnvironment(poison, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(poison)) {
    previous.set(
      key,
      Object.hasOwn(process.env, key) ? process.env[key] : undefined,
    );
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withFreshSpawnStub(stub, callback) {
  const childProcess = require("node:child_process");
  const modulePath = require.resolve("../lib/pikiio-sealed-git");
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = stub;
  delete require.cache[modulePath];
  try {
    return callback(require(modulePath));
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[modulePath];
  }
}

after(() => {
  for (const root of TEMP_ROOTS.reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sealed runner exposes only bounded named read operations", () => {
  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });

  assert.equal(runner.gitPath, SYSTEM_GIT);
  assert.equal(runner.repoRoot, fixture.root);
  assert.match(runner.repositoryIdentitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    createSealedGit({ repoRoot: fixture.root }).repositoryIdentitySha256,
    runner.repositoryIdentitySha256,
  );
  assert.equal(runner.head(), fixture.second);
  assert.equal(runner.branch(), "main");
  assert.equal(runner.commit({ commit: fixture.second }), fixture.second);
  assert.equal(runner.tree({ commit: fixture.second }), fixture.secondTree);
  assert.equal(runner.parent({ commit: fixture.second }), fixture.first);
  assert.deepEqual(
    runner.history({
      fromExclusive: fixture.first,
      toInclusive: fixture.second,
      path: "tracked.txt",
      maximum: 2,
    }),
    [fixture.second],
  );
  assert.equal(
    runner.commitCount({
      fromExclusive: fixture.first,
      toInclusive: fixture.second,
    }),
    1,
  );
  assert.equal(
    runner.isAncestor({
      ancestor: fixture.first,
      descendant: fixture.second,
    }),
    true,
  );
  assert.equal(
    runner.isAncestor({
      ancestor: fixture.second,
      descendant: fixture.first,
    }),
    false,
  );
  assert.equal(
    runner.show({ commit: fixture.first, path: "tracked.txt" }).toString(),
    "first state\n",
  );
  assert.deepEqual(
    runner.objectAtPath({
      commit: fixture.second,
      path: "tracked.txt",
    }),
    {
      mode: "100644",
      type: "blob",
      objectId: fixture.trackedBlob,
      path: "tracked.txt",
    },
  );
  assert.deepEqual(
    runner
      .objectsAtPaths({
        commit: fixture.second,
        paths: ["large.txt", "tracked.txt"],
      })
      .map((entry) => entry.path),
    ["large.txt", "tracked.txt"],
  );
  const blobs = runner.blobsAtPaths({
    commit: fixture.second,
    paths: ["large.txt", "tracked.txt"],
    maximumTotalBytes: 9_000,
  });
  assert.deepEqual(
    blobs.map((entry) => entry.path),
    ["large.txt", "tracked.txt"],
  );
  assert.equal(blobs[1].bytes.toString("utf8"), "second state\n");
  const batchBlobs = runner.batchBlobsAtPaths({
    commit: fixture.second,
    paths: ["large.txt", "tracked.txt"],
    maximumTotalBytes: 9_000,
  });
  assert.deepEqual(
    batchBlobs.map((entry) => entry.path),
    ["large.txt", "tracked.txt"],
  );
  assert.equal(batchBlobs[1].bytes.toString("utf8"), "second state\n");

  const names = runner.diff({
    from: fixture.first,
    to: fixture.second,
    format: "name-status-z",
  });
  assert.deepEqual(
    names.toString("utf8").split("\0").filter(Boolean),
    ["A", "large.txt", "M", "tracked.txt"],
  );
  const binary = runner.diff({
    from: fixture.first,
    to: fixture.second,
    format: "binary",
  });
  assert.match(binary.toString("utf8"), /diff --git a\/tracked\.txt b\/tracked\.txt/u);
  assert.ok(
    runner.diff({
      from: fixture.first,
      to: fixture.second,
      format: "name-status-z-renames",
    }).length > 0,
  );

  fs.writeFileSync(path.join(fixture.root, "untracked.txt"), "untracked\n");
  assert.deepEqual(
    runner.status().toString("utf8").split("\0").filter(Boolean),
    ["?? untracked.txt"],
  );
  fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "working state\n");
  assert.match(
    runner.workingDiff({ base: fixture.second }).toString("utf8"),
    /working state/u,
  );
  fs.writeFileSync(path.join(fixture.root, "large.txt"), "index state\n");
  git(fixture.root, ["add", "large.txt"]);
  assert.match(
    runner.indexDiff({ base: fixture.second }).toString("utf8"),
    /index state/u,
  );
  git(fixture.root, [
    "update-ref",
    "refs/remotes/origin/main",
    fixture.second,
  ]);
  assert.equal(
    runner.localTrackingRef({ ref: "refs/remotes/origin/main" }),
    fixture.second,
  );
  assert.ok(
    runner.worktrees().some((entry) => entry.path === fixture.root),
  );

  assert.deepEqual(
    Object.keys(runner).sort(),
    [
      "batchBlobsAtPaths",
      "blobsAtPaths",
      "branch",
      "commit",
      "commitCount",
      "diff",
      "gitPath",
      "head",
      "history",
      "indexDiff",
      "isAncestor",
      "localTrackingRef",
      "objectAtPath",
      "objectsAtPaths",
      "parent",
      "remoteReadback",
      "repoRoot",
      "repositoryIdentitySha256",
      "show",
      "status",
      "tree",
      "workingDiff",
      "worktrees",
    ],
  );
  assert.equal(Object.isFrozen(runner), true);
});

test("trusted Git resolution never consults PATH", () => {
  const fakeBin = tempRoot("pikiio-fake-git-");
  const marker = path.join(fakeBin, "executed");
  const fakeGit = path.join(fakeBin, "git");
  fs.writeFileSync(
    fakeGit,
    `#!/bin/sh\nprintf fake > ${JSON.stringify(marker)}\nexit 91\n`,
    { mode: 0o755 },
  );
  const fixture = initializeRepository();

  withPoisonedEnvironment({ PATH: fakeBin }, () => {
    assert.equal(resolveTrustedGitExecutable(), SYSTEM_GIT);
    const runner = createSealedGit({ repoRoot: fixture.root });
    assert.equal(runner.head(), fixture.second);
  });
  assert.equal(fs.existsSync(marker), false);
});

test("inherited Git authority variables cannot redirect repository or objects", () => {
  const fixture = initializeRepository();
  const other = initializeRepository();
  fs.writeFileSync(path.join(other.root, "tracked.txt"), "foreign state\n");
  git(other.root, ["add", "tracked.txt"]);
  git(other.root, ["commit", "--quiet", "-m", "foreign"]);

  const fakeBin = tempRoot("pikiio-poisoned-path-");
  const marker = path.join(fakeBin, "fake-git-ran");
  fs.writeFileSync(
    path.join(fakeBin, "git"),
    `#!/bin/sh\nprintf poison > ${JSON.stringify(marker)}\nexit 92\n`,
    { mode: 0o755 },
  );
  const poisonedConfig = path.join(tempRoot("pikiio-poisoned-config-"), "gitconfig");
  fs.writeFileSync(poisonedConfig, "[this is not valid git config\n");
  const missingObjects = path.join(tempRoot("pikiio-poisoned-objects-"), "missing");

  git(fixture.root, [
    "update-ref",
    `refs/poison/${fixture.first}`,
    fixture.second,
  ]);
  git(fixture.root, [
    "update-ref",
    "refs/remotes/origin/main",
    fixture.second,
  ]);

  withPoisonedEnvironment(
    {
      PATH: fakeBin,
      GIT_DIR: path.join(other.root, ".git"),
      GIT_REPLACE_REF_BASE: "refs/poison/",
      GIT_WORK_TREE: other.root,
      GIT_INDEX_FILE: path.join(other.root, ".git", "index"),
    },
    () => {
      const runner = createSealedGit({ repoRoot: fixture.root });
      assert.equal(runner.head(), fixture.second);
      assert.equal(runner.branch(), "main");
      assert.equal(runner.commit({ commit: fixture.second }), fixture.second);
      assert.deepEqual(
        runner.history({
          fromExclusive: fixture.first,
          toInclusive: fixture.second,
          path: "tracked.txt",
          maximum: 2,
        }),
        [fixture.second],
      );
      assert.equal(
        runner.commitCount({
          fromExclusive: fixture.first,
          toInclusive: fixture.second,
        }),
        1,
      );
      assert.equal(
        runner.show({ commit: fixture.first, path: "tracked.txt" }).toString(),
        "first state\n",
      );
      assert.equal(
        runner.tree({ commit: fixture.second }),
        fixture.secondTree,
      );
      assert.equal(
        runner.objectAtPath({
          commit: fixture.second,
          path: "tracked.txt",
        }).objectId,
        fixture.trackedBlob,
      );
      assert.equal(
        runner.objectsAtPaths({
          commit: fixture.second,
          paths: ["large.txt", "tracked.txt"],
        }).length,
        2,
      );
      assert.equal(
        runner.blobsAtPaths({
          commit: fixture.second,
          paths: ["large.txt", "tracked.txt"],
          maximumTotalBytes: 9_000,
        }).length,
        2,
      );
      assert.equal(
        runner.batchBlobsAtPaths({
          commit: fixture.second,
          paths: ["large.txt", "tracked.txt"],
          maximumTotalBytes: 9_000,
        }).length,
        2,
      );
      assert.equal(
        runner.diff({
          from: fixture.first,
          to: fixture.second,
          format: "name-status-z-renames",
        }).length > 0,
        true,
      );
      assert.equal(runner.workingDiff({ base: fixture.second }).length, 0);
      assert.equal(runner.indexDiff({ base: fixture.second }).length, 0);
      assert.equal(
        runner.localTrackingRef({ ref: "refs/remotes/origin/main" }),
        fixture.second,
      );
      assert.ok(runner.worktrees().length >= 1);
    },
  );

  assert.equal(fs.existsSync(marker), false);
  assert.equal(SEALED_ENVIRONMENT.GIT_NO_LAZY_FETCH, "1");
  assert.equal(SEALED_ENVIRONMENT.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(SEALED_ENVIRONMENT.GIT_CONFIG_GLOBAL, "/dev/null");
  for (const inheritedName of [
    "GIT_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
  ]) {
    assert.equal(Object.hasOwn(SEALED_ENVIRONMENT, inheritedName), false);
  }

  for (const [name, value] of [
    ["GIT_OBJECT_DIRECTORY", missingObjects],
    ["GIT_ALTERNATE_OBJECT_DIRECTORIES", other.root],
    ["GIT_CONFIG", poisonedConfig],
    ["GIT_CONFIG_GLOBAL", poisonedConfig],
  ]) {
    withPoisonedEnvironment({ [name]: value }, () => {
      assert.throws(
        () => createSealedGit({ repoRoot: fixture.root }),
        assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
      );
    });
  }
});

test("unexpected options, operation arguments, paths, and remote transports refuse", () => {
  const fixture = initializeRepository();

  assert.throws(
    () => createSealedGit({ repoRoot: fixture.root, env: {} }),
    assertCode("SEALED_GIT_UNEXPECTED_OPTION"),
  );
  assert.throws(
    () => resolveTrustedGitExecutable({ path: "git" }),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );

  const runner = createSealedGit({ repoRoot: fixture.root });
  assert.throws(
    () => runner.head({ env: {} }),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () => runner.tree({ commit: fixture.second, env: {} }),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () =>
      runner.show({
        commit: fixture.first,
        path: "../outside",
      }),
    assertCode("SEALED_GIT_PATH_INVALID"),
  );
  assert.throws(
    () =>
      runner.diff({
        from: fixture.first,
        to: fixture.second,
        format: "--output=/tmp/escape",
      }),
    assertCode("SEALED_GIT_DIFF_FORMAT_INVALID"),
  );
  assert.throws(
    () =>
      runner.remoteReadback({
        url: `file://${fixture.root}`,
        ref: "refs/heads/main",
      }),
    assertCode("SEALED_GIT_REMOTE_URL_INVALID"),
  );
  assert.throws(
    () =>
      runner.remoteReadback({
        url: "https://github.com/git/git.git",
        ref: "--upload-pack=attacker",
      }),
    assertCode("SEALED_GIT_REMOTE_REF_INVALID"),
  );
});

test("all caller-controlled schemas reject malformed and oversized values", () => {
  const fixture = initializeRepository();
  for (const options of [
    null,
    [],
    {},
    { repoRoot: fixture.root, timeoutMs: 0 },
    { repoRoot: fixture.root, timeoutMs: 30_001 },
    { repoRoot: fixture.root, timeoutMs: 1.5 },
    { repoRoot: fixture.root, maxStdoutBytes: 0 },
    { repoRoot: fixture.root, maxStderrBytes: 64 * 1024 * 1024 + 1 },
  ]) {
    assert.throws(() => createSealedGit(options), SealedGitError);
  }
  for (const repoRoot of [
    "",
    "relative/repository",
    `${fixture.root}/`,
    `${fixture.root}\0poison`,
    path.join(fixture.root, "missing"),
  ]) {
    assert.throws(() => createSealedGit({ repoRoot }), SealedGitError);
  }

  const runner = createSealedGit({ repoRoot: fixture.root });
  assert.throws(
    () => runner.tree(null),
    assertCode("SEALED_GIT_REQUEST_INVALID"),
  );
  for (const commit of [null, "", "A".repeat(40), "f".repeat(39)]) {
    assert.throws(
      () => runner.tree({ commit }),
      assertCode("SEALED_GIT_COMMIT_INVALID"),
    );
  }
  assert.throws(
    () => runner.status("unexpected"),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () => runner.branch("unexpected"),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () => runner.commit({ commit: fixture.second, env: {} }),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () =>
      runner.history({
        fromExclusive: fixture.first,
        toInclusive: fixture.second,
        path: "tracked.txt",
        maximum: 0,
      }),
    assertCode("SEALED_GIT_LIMIT_INVALID"),
  );
  assert.throws(
    () =>
      runner.commitCount({
        fromExclusive: fixture.first,
        toInclusive: fixture.second,
        env: {},
      }),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () =>
      runner.objectAtPath({
        commit: fixture.second,
        path: "../tracked.txt",
      }),
    assertCode("SEALED_GIT_PATH_INVALID"),
  );
  assert.throws(
    () =>
      runner.objectsAtPaths({
        commit: fixture.second,
        paths: ["tracked.txt", "tracked.txt"],
      }),
    assertCode("SEALED_GIT_PATHS_INVALID"),
  );
  assert.throws(
    () =>
      runner.blobsAtPaths({
        commit: fixture.second,
        paths: ["tracked.txt"],
        maximumTotalBytes: 0,
      }),
    assertCode("SEALED_GIT_LIMIT_INVALID"),
  );
  assert.throws(
    () =>
      runner.blobsAtPaths({
        commit: fixture.second,
        paths: ["large.txt"],
        maximumTotalBytes: 10,
      }),
    assertCode("SEALED_GIT_OUTPUT_LIMIT"),
  );
  assert.throws(
    () =>
      runner.batchBlobsAtPaths({
        commit: fixture.second,
        paths: ["tracked.txt", "tracked.txt"],
        maximumTotalBytes: 100,
      }),
    assertCode("SEALED_GIT_PATHS_INVALID"),
  );
  assert.throws(
    () =>
      runner.batchBlobsAtPaths({
        commit: fixture.second,
        paths: ["large.txt"],
        maximumTotalBytes: 10,
      }),
    assertCode("SEALED_GIT_OUTPUT_LIMIT"),
  );
  for (const paths of [null, [], Array.from({ length: 513 }, () => "x")]) {
    assert.throws(
      () => runner.objectsAtPaths({ commit: fixture.second, paths }),
      assertCode("SEALED_GIT_PATHS_INVALID"),
    );
  }
  assert.throws(
    () => runner.workingDiff({ base: "bad" }),
    assertCode("SEALED_GIT_COMMIT_INVALID"),
  );
  assert.throws(
    () => runner.indexDiff({ base: fixture.second, env: {} }),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );
  assert.throws(
    () => runner.localTrackingRef({ ref: "origin/main" }),
    assertCode("SEALED_GIT_TRACKING_REF_INVALID"),
  );
  assert.throws(
    () => runner.worktrees("unexpected"),
    assertCode("SEALED_GIT_UNEXPECTED_ARGUMENT"),
  );

  for (const invalidPath of [
    "",
    "/absolute",
    "back\\slash",
    "colon:path",
    "trailing/",
    "line\nbreak",
    "x".repeat(4097),
    "empty//component",
    "dot/./component",
    "parent/../component",
  ]) {
    assert.throws(
      () => runner.show({ commit: fixture.first, path: invalidPath }),
      assertCode("SEALED_GIT_PATH_INVALID"),
    );
  }

  const validRef = "refs/heads/main";
  for (const invalidUrl of [
    null,
    "short",
    `https://example.com/${"x".repeat(2050)}`,
    "https://example.com/owner/repo.git\0",
    "not a url at all",
    "http://github.com/git/git.git",
    "https://contact-04f8996d@company-3aeb0024.example/git/git.git",
    "https://user:contact-2bb80d53@company-3aeb0024.example/git/git.git",
    "https://github.com:443/git/git.git",
    "https://github.com/git/git.git?query=1",
    "https://github.com/git/git.git#fragment",
    "https://bad_host.example/git/git.git",
    "https://github.com/one.git",
    "https://github.com/git/git",
    "https://github.com/git/../git.git",
    "https://GITHUB.com/git/git.git",
  ]) {
    assert.throws(
      () => runner.remoteReadback({ url: invalidUrl, ref: validRef }),
      assertCode("SEALED_GIT_REMOTE_URL_INVALID"),
    );
  }

  const validUrl = "https://github.com/git/git.git";
  for (const invalidRef of [
    null,
    "refs/heads/",
    `refs/heads/${"x".repeat(245)}`,
    "main",
    "refs/heads/a..b",
    "refs/heads/a@{b",
    "refs/heads/a\\b",
    "refs/heads/a//b",
    "refs/heads/a/",
    "refs/heads/a.",
    "refs/heads/a.lock",
    "refs/heads/a b",
    "refs/heads/a~b",
  ]) {
    assert.throws(
      () => runner.remoteReadback({ url: validUrl, ref: invalidRef }),
      assertCode("SEALED_GIT_REMOTE_REF_INVALID"),
    );
  }
});

test("every options and request object is exact descriptor-safe plain data", () => {
  const fixture = initializeRepository();
  let getterCalls = 0;
  const hostileOptions = [
    Object.assign(Object.create(null), { repoRoot: fixture.root }),
    Object.assign(Object.create({ inherited: true }), {
      repoRoot: fixture.root,
    }),
    new Proxy({ repoRoot: fixture.root }, {}),
    (() => {
      const value = { repoRoot: fixture.root };
      value[Symbol("hidden")] = true;
      return value;
    })(),
    (() => {
      const value = { repoRoot: fixture.root };
      Object.defineProperty(value, "hidden", {
        value: true,
        enumerable: false,
      });
      return value;
    })(),
    (() => {
      const value = {};
      Object.defineProperty(value, "repoRoot", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return fixture.root;
        },
      });
      return value;
    })(),
  ];
  for (const options of hostileOptions) {
    assert.throws(
      () => createSealedGit(options),
      assertCode("SEALED_GIT_OPTIONS_INVALID"),
    );
  }
  assert.equal(getterCalls, 0);

  const runner = createSealedGit({ repoRoot: fixture.root });
  const requests = [
    ["tree", { commit: fixture.second }, (value) => runner.tree(value)],
    ["commit", { commit: fixture.second }, (value) => runner.commit(value)],
    ["parent", { commit: fixture.second }, (value) => runner.parent(value)],
    [
      "history",
      {
        fromExclusive: fixture.first,
        maximum: 2,
        path: "tracked.txt",
        toInclusive: fixture.second,
      },
      (value) => runner.history(value),
    ],
    [
      "commitCount",
      { fromExclusive: fixture.first, toInclusive: fixture.second },
      (value) => runner.commitCount(value),
    ],
    [
      "isAncestor",
      { ancestor: fixture.first, descendant: fixture.second },
      (value) => runner.isAncestor(value),
    ],
    [
      "show",
      { commit: fixture.second, path: "tracked.txt" },
      (value) => runner.show(value),
    ],
    [
      "objectsAtPaths",
      { commit: fixture.second, paths: ["tracked.txt"] },
      (value) => runner.objectsAtPaths(value),
    ],
    [
      "objectAtPath",
      { commit: fixture.second, path: "tracked.txt" },
      (value) => runner.objectAtPath(value),
    ],
    [
      "blobsAtPaths",
      {
        commit: fixture.second,
        maximumTotalBytes: 100,
        paths: ["tracked.txt"],
      },
      (value) => runner.blobsAtPaths(value),
    ],
    [
      "batchBlobsAtPaths",
      {
        commit: fixture.second,
        maximumTotalBytes: 100,
        paths: ["tracked.txt"],
      },
      (value) => runner.batchBlobsAtPaths(value),
    ],
    [
      "diff",
      {
        format: "name-status-z",
        from: fixture.first,
        to: fixture.second,
      },
      (value) => runner.diff(value),
    ],
    [
      "workingDiff",
      { base: fixture.second },
      (value) => runner.workingDiff(value),
    ],
    [
      "indexDiff",
      { base: fixture.second },
      (value) => runner.indexDiff(value),
    ],
    [
      "localTrackingRef",
      { ref: "refs/remotes/origin/main" },
      (value) => runner.localTrackingRef(value),
    ],
    [
      "remoteReadback",
      {
        ref: "refs/heads/main",
        url: "https://github.com/git/git.git",
      },
      (value) => runner.remoteReadback(value),
    ],
  ];

  for (const [name, base, invoke] of requests) {
    const firstKey = Object.keys(base)[0];
    const symbolBearing = { ...base };
    symbolBearing[Symbol(name)] = true;
    const nonEnumerable = { ...base };
    Object.defineProperty(nonEnumerable, "hidden", {
      value: true,
      enumerable: false,
    });
    const accessor = { ...base };
    delete accessor[firstKey];
    Object.defineProperty(accessor, firstKey, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return base[firstKey];
      },
    });
    const inherited = Object.assign(Object.create({ poison: true }), base);
    for (const hostile of [
      symbolBearing,
      nonEnumerable,
      accessor,
      inherited,
      new Proxy({ ...base }, {}),
    ]) {
      assert.throws(
        () => invoke(hostile),
        assertCode("SEALED_GIT_REQUEST_INVALID"),
        name,
      );
    }
  }
  assert.equal(getterCalls, 0);
});

test("repository path arrays must be dense canonical data arrays", () => {
  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });
  const invoke = (paths) =>
    runner.objectsAtPaths({ commit: fixture.second, paths });

  const sparse = [];
  sparse.length = 1;
  const accessor = ["tracked.txt"];
  let getterCalls = 0;
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "tracked.txt";
    },
  });
  const nonEnumerable = ["tracked.txt"];
  Object.defineProperty(nonEnumerable, "0", {
    value: "tracked.txt",
    enumerable: false,
  });
  const symbolBearing = ["tracked.txt"];
  symbolBearing[Symbol("hidden")] = true;
  const extraProperty = ["tracked.txt"];
  extraProperty.hidden = true;
  const wrongPrototype = ["tracked.txt"];
  Object.setPrototypeOf(wrongPrototype, null);

  for (const paths of [
    sparse,
    accessor,
    nonEnumerable,
    symbolBearing,
    extraProperty,
    wrongPrototype,
    new Proxy(["tracked.txt"], {}),
    ["tracked.txt", "large.txt"],
    ["tracked.txt", "tracked.txt"],
  ]) {
    assert.throws(
      () => invoke(paths),
      assertCode("SEALED_GIT_PATHS_INVALID"),
    );
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(
    invoke(["large.txt", "tracked.txt"]).map((entry) => entry.path),
    ["large.txt", "tracked.txt"],
  );
});

test("every commit-scoped operation rejects tree, blob, and tag object IDs", () => {
  const fixture = initializeRepository();
  git(fixture.root, [
    "tag",
    "-a",
    "sealed-type-probe",
    "-m",
    "sealed type probe",
    fixture.second,
  ]);
  const tagObject = git(fixture.root, [
    "rev-parse",
    "refs/tags/sealed-type-probe",
  ]);
  const runner = createSealedGit({ repoRoot: fixture.root });
  const cases = [
    () => runner.commit({ commit: tagObject }),
    () => runner.tree({ commit: fixture.secondTree }),
    () =>
      runner.objectsAtPaths({
        commit: fixture.secondTree,
        paths: ["tracked.txt"],
      }),
    () =>
      runner.objectAtPath({
        commit: fixture.secondTree,
        path: "tracked.txt",
      }),
    () =>
      runner.show({
        commit: fixture.trackedBlob,
        path: "tracked.txt",
      }),
    () =>
      runner.blobsAtPaths({
        commit: fixture.trackedBlob,
        maximumTotalBytes: 100,
        paths: ["tracked.txt"],
      }),
    () =>
      runner.batchBlobsAtPaths({
        commit: fixture.secondTree,
        maximumTotalBytes: 100,
        paths: ["tracked.txt"],
      }),
    () =>
      runner.diff({
        format: "name-status-z",
        from: fixture.secondTree,
        to: fixture.second,
      }),
    () => runner.workingDiff({ base: fixture.secondTree }),
    () => runner.indexDiff({ base: fixture.trackedBlob }),
  ];
  for (const invoke of cases) {
    assert.throws(
      invoke,
      assertCode("SEALED_GIT_COMMIT_OBJECT_INVALID"),
    );
  }
});

test("root commits and missing blobs fail closed instead of inventing evidence", () => {
  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });
  assert.throws(
    () => runner.parent({ commit: fixture.first }),
    assertCode("SEALED_GIT_PARENT_CARDINALITY"),
  );
  assert.throws(
    () => runner.show({ commit: fixture.first, path: "missing.txt" }),
    assertCode("SEALED_GIT_PATH_MISSING"),
  );
});

test("synthetic subprocess edge receipts are rejected and remote output is exact", () => {
  const fixture = initializeRepository();
  let mode = "normal";
  const branchRef = "refs/heads/main";
  const remoteUrl = "https://github.com/git/git.git";
  const trackedContent = Buffer.from("second state\n");
  const validTrackedTree = Buffer.from(
    `100644 blob ${fixture.trackedBlob}\ttracked.txt\0`,
  );
  const validTrackedBatch = Buffer.concat([
    Buffer.from(
      `${fixture.trackedBlob} blob ${trackedContent.length}\n`,
      "ascii",
    ),
    trackedContent,
    Buffer.from("\n", "ascii"),
  ]);
  const response = ({
    stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    status = 0,
    signal = null,
    error = undefined,
  } = {}) => ({ stdout, stderr, status, signal, error });

  withFreshSpawnStub((command, args, options) => {
    assert.equal(
      command,
      args.includes("ls-remote") ? SYSTEM_GIT : SYSTEM_BROKER,
    );
    assert.equal(options.cwd, "/var/empty");
    assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(Object.hasOwn(options.env, "GIT_DIR"), false);
    assert.equal(Object.hasOwn(options.env, "PERL5OPT"), false);
    assert.equal(Object.hasOwn(options.env, "PERL5LIB"), false);
    if (command === SYSTEM_BROKER) {
      assert.equal(options.stdio.length, 4);
      assert.equal(Number.isInteger(options.stdio[3]), true);
      assert.equal(args[0], "-e");
      assert.equal(args[2], SYSTEM_GIT);
    } else {
      assert.equal(options.stdio.length, 3);
    }
    if (mode === "head-invalid-utf8") {
      return response({ stdout: Buffer.from([0xff, 0x0a]) });
    }
    if (mode === "head-stdout-overflow") {
      return response({ stdout: Buffer.alloc(129, 0x61) });
    }
    if (mode === "head-stderr-overflow") {
      const receipt = response({ stderr: Buffer.alloc(9, 0x65) });
      assert.equal(receipt.stdout.length, 0);
      assert.equal(receipt.stderr.length, 9);
      assert.equal(receipt.status, 0);
      assert.equal(receipt.signal, null);
      assert.equal(receipt.error, undefined);
      return receipt;
    }
    if (args.includes("cat-file") && args.includes("-t")) {
      if (mode === "commit-type-tree") {
        return response({ stdout: Buffer.from("tree\n") });
      }
      return response({ stdout: Buffer.from("commit\n") });
    }
    if (mode === "command-error") {
      return response({
        stderr: Buffer.from("synthetic Git failure\n"),
        status: 128,
      });
    }
    if (mode === "signal-error") {
      return response({ status: null, signal: "SIGKILL" });
    }
    if (mode === "ancestry-output") {
      return response({ stdout: Buffer.from("x"), status: 0 });
    }
    if (args.includes("branch") && args.includes("--show-current")) {
      if (mode === "branch-detached") return response();
      if (mode === "branch-invalid") {
        return response({ stdout: Buffer.from("../invalid\n") });
      }
    }
    if (args.includes("log")) {
      if (mode === "history-overflow") {
        return response({
          stdout: Buffer.from(
            `${fixture.first}\n${fixture.second}\n${"a".repeat(40)}\n`,
          ),
        });
      }
      if (mode === "history-malformed") {
        return response({ stdout: Buffer.from("not-a-commit\n") });
      }
    }
    if (args.includes("rev-list") && args.includes("--count")) {
      if (mode === "count-invalid") {
        return response({ stdout: Buffer.from("not-a-count\n") });
      }
      if (mode === "count-unsafe") {
        return response({ stdout: Buffer.from("9999999999999999\n") });
      }
    }
    if (mode === "show-size-invalid" && args.includes("-s")) {
      return response({ stdout: Buffer.from("not-a-size\n") });
    }
    if (mode === "show-bytes-changed" && args.includes("cat-file")) {
      if (args.includes("-s")) {
        return response({ stdout: Buffer.from("3\n") });
      }
      return response({ stdout: Buffer.from("xx") });
    }
    if (args.includes("ls-tree")) {
      if (mode.startsWith("batch-")) {
        if (mode === "batch-tree-path-substitution") {
          return response({
            stdout: Buffer.from(
              `100644 blob ${fixture.trackedBlob}\tother.txt\0`,
            ),
          });
        }
        if (mode === "batch-tree-type-substitution") {
          return response({
            stdout: Buffer.from(
              `040000 tree ${fixture.trackedBlob}\ttracked.txt\0`,
            ),
          });
        }
        return response({ stdout: validTrackedTree });
      }
      if (mode === "tree-mode-type-invalid") {
        return response({
          stdout: Buffer.from(
            `100600 blob ${fixture.trackedBlob}\ttracked.txt\0`,
          ),
        });
      }
      if (mode === "tree-show-nonblob") {
        return response({
          stdout: Buffer.from(
            `040000 tree ${fixture.trackedBlob}\ttracked.txt\0`,
          ),
        });
      }
      if (mode === "tree-output-invalid-utf8") {
        return response({ stdout: Buffer.from([0xff, 0x00]) });
      }
      if (mode === "tree-output-malformed") {
        return response({ stdout: Buffer.from("malformed\0") });
      }
      if (mode === "tree-output-duplicate") {
        const line =
          `100644 blob ${fixture.trackedBlob}\ttracked.txt\0`;
        return response({ stdout: Buffer.from(`${line}${line}`) });
      }
      if (mode === "tree-output-missing") return response();
      return response({ stdout: validTrackedTree });
    }
    if (
      (mode === "show-same-length-substitution" ||
        mode === "blobs-same-length-substitution") &&
      args.includes("cat-file")
    ) {
      if (args.includes("-s")) {
        return response({
          stdout: Buffer.from(`${trackedContent.length}\n`),
        });
      }
      const changed = Buffer.from(trackedContent);
      changed[0] = 0x58;
      return response({ stdout: changed });
    }
    if (args.includes("cat-file") && args.includes("--batch")) {
      assert.equal(
        options.input.toString("ascii"),
        `${fixture.trackedBlob}\n`,
      );
      assert.equal(options.stdio[0], "pipe");
      if (mode === "batch-valid") {
        return response({ stdout: validTrackedBatch });
      }
      if (mode === "batch-header-malformed") {
        return response({ stdout: Buffer.from("malformed\n") });
      }
      if (mode === "batch-header-missing-newline") {
        return response({ stdout: Buffer.from("malformed") });
      }
      if (mode === "batch-header-non-ascii") {
        return response({
          stdout: Buffer.from([0xff, 0x0a]),
        });
      }
      if (mode === "batch-object-substitution") {
        return response({
          stdout: Buffer.concat([
            Buffer.from(`${fixture.first} blob ${trackedContent.length}\n`),
            trackedContent,
            Buffer.from("\n"),
          ]),
        });
      }
      if (mode === "batch-type-substitution") {
        return response({
          stdout: Buffer.from(`${fixture.trackedBlob} tree 0\n\n`),
        });
      }
      if (mode === "batch-size-invalid") {
        return response({
          stdout: Buffer.from(
            `${fixture.trackedBlob} blob 9999999999999999\n`,
          ),
        });
      }
      if (mode === "batch-framing-truncated") {
        return response({
          stdout: validTrackedBatch.subarray(
            0,
            validTrackedBatch.length - 1,
          ),
        });
      }
      if (mode === "batch-readback-changed") {
        const changed = Buffer.from("changed state\n");
        return response({
          stdout: Buffer.concat([
            Buffer.from(`${fixture.trackedBlob} blob ${changed.length}\n`),
            changed,
            Buffer.from("\n"),
          ]),
        });
      }
      if (mode === "batch-trailing") {
        return response({
          stdout: Buffer.concat([validTrackedBatch, Buffer.from("extra")]),
        });
      }
    }
    if (args.includes("worktree") && args.includes("list")) {
      if (mode === "worktree-invalid-utf8") {
        return response({ stdout: Buffer.from([0xff, 0x00, 0x00]) });
      }
      if (mode === "worktree-no-header") {
        return response({ stdout: Buffer.from("bogus\0\0") });
      }
      if (mode === "worktree-bad-path") {
        return response({
          stdout: Buffer.from(
            `worktree relative\0HEAD ${fixture.second}\0branch refs/heads/main\0\0`,
          ),
        });
      }
      if (mode === "worktree-unknown-field") {
        return response({
          stdout: Buffer.from(
            `worktree ${fixture.root}\0HEAD ${fixture.second}\0mystery\0\0`,
          ),
        });
      }
      if (mode === "worktree-missing-identity") {
        return response({
          stdout: Buffer.from(`worktree ${fixture.root}\0HEAD ${fixture.second}\0\0`),
        });
      }
      if (mode === "worktree-detached-metadata") {
        return response({
          stdout: Buffer.from(
            `worktree ${fixture.root}\0HEAD ${fixture.second}\0detached\0bare\0locked owner\0prunable stale\0\0`,
          ),
        });
      }
    }
    if (mode === "remote-valid" && args.includes("ls-remote")) {
      assert.ok(args.includes("--git-dir=/dev/null"));
      return response({
        stdout: Buffer.from(`${fixture.second}\t${branchRef}\n`),
      });
    }
    if (mode === "remote-invalid" && args.includes("ls-remote")) {
      return response({
        stdout: Buffer.from(`${fixture.second}\trefs/heads/other\n`),
      });
    }
    return response({ stdout: Buffer.from(`${fixture.second}\n`) });
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: fixture.root });

    mode = "head-stdout-overflow";
    assert.throws(
      () => runner.head(),
      assertCode("SEALED_GIT_OUTPUT_LIMIT"),
    );

    mode = "head-invalid-utf8";
    assert.throws(
      () => runner.head(),
      assertCode("SEALED_GIT_OUTPUT_INVALID"),
    );

    const stderrBoundedRunner = fresh.createSealedGit({
      repoRoot: fixture.root,
      maxStderrBytes: 8,
    });
    mode = "head-stderr-overflow";
    assert.throws(
      () => stderrBoundedRunner.head(),
      assertCode("SEALED_GIT_OUTPUT_LIMIT"),
    );

    mode = "commit-type-tree";
    assert.throws(
      () => runner.commit({ commit: fixture.second }),
      assertCode("SEALED_GIT_COMMIT_OBJECT_INVALID"),
    );

    mode = "command-error";
    assert.throws(
      () => runner.tree({ commit: fixture.second }),
      assertCode("SEALED_GIT_COMMAND_FAILED"),
    );

    mode = "signal-error";
    assert.throws(
      () => runner.tree({ commit: fixture.second }),
      assertCode("SEALED_GIT_COMMAND_FAILED"),
    );

    mode = "ancestry-output";
    assert.throws(
      () =>
        runner.isAncestor({
          ancestor: fixture.first,
          descendant: fixture.second,
        }),
      assertCode("SEALED_GIT_OUTPUT_INVALID"),
    );

    mode = "branch-detached";
    assert.equal(runner.branch(), null);

    mode = "branch-invalid";
    assert.throws(
      () => runner.branch(),
      assertCode("SEALED_GIT_BRANCH_INVALID"),
    );

    const historyRequest = {
      fromExclusive: fixture.first,
      toInclusive: fixture.second,
      path: "tracked.txt",
      maximum: 2,
    };
    mode = "history-overflow";
    assert.throws(
      () => runner.history(historyRequest),
      assertCode("SEALED_GIT_HISTORY_BOUND_EXCEEDED"),
    );

    mode = "history-malformed";
    assert.throws(
      () => runner.history(historyRequest),
      assertCode("SEALED_GIT_HISTORY_BOUND_EXCEEDED"),
    );

    const countRequest = {
      fromExclusive: fixture.first,
      toInclusive: fixture.second,
    };
    mode = "count-invalid";
    assert.throws(
      () => runner.commitCount(countRequest),
      assertCode("SEALED_GIT_COMMIT_COUNT_INVALID"),
    );

    mode = "count-unsafe";
    assert.throws(
      () => runner.commitCount(countRequest),
      assertCode("SEALED_GIT_COMMIT_COUNT_INVALID"),
    );

    mode = "show-size-invalid";
    assert.throws(
      () => runner.show({ commit: fixture.first, path: "tracked.txt" }),
      assertCode("SEALED_GIT_OBJECT_SIZE_INVALID"),
    );

    mode = "show-bytes-changed";
    assert.throws(
      () => runner.show({ commit: fixture.first, path: "tracked.txt" }),
      assertCode("SEALED_GIT_OBJECT_CHANGED"),
    );

    mode = "show-same-length-substitution";
    assert.throws(
      () => runner.show({ commit: fixture.second, path: "tracked.txt" }),
      assertCode("SEALED_GIT_OBJECT_CHANGED"),
    );

    mode = "tree-show-nonblob";
    assert.throws(
      () => runner.show({ commit: fixture.second, path: "tracked.txt" }),
      assertCode("SEALED_GIT_SHOW_OBJECT_INVALID"),
    );

    mode = "blobs-same-length-substitution";
    assert.throws(
      () =>
        runner.blobsAtPaths({
          commit: fixture.second,
          paths: ["tracked.txt"],
          maximumTotalBytes: 100,
        }),
      assertCode("SEALED_GIT_OBJECT_CHANGED"),
    );

    const objectsRequest = {
      commit: fixture.second,
      paths: ["tracked.txt"],
    };
    for (const invalidMode of [
      "tree-output-invalid-utf8",
      "tree-output-malformed",
      "tree-output-duplicate",
      "tree-mode-type-invalid",
    ]) {
      mode = invalidMode;
      assert.throws(
        () => runner.objectsAtPaths(objectsRequest),
        assertCode("SEALED_GIT_TREE_OUTPUT_INVALID"),
      );
    }

    mode = "tree-output-missing";
    assert.throws(
      () =>
        runner.objectAtPath({
          commit: fixture.second,
          path: "tracked.txt",
        }),
      assertCode("SEALED_GIT_PATH_MISSING"),
    );
    assert.throws(
      () =>
        runner.blobsAtPaths({
          commit: fixture.second,
          paths: ["tracked.txt"],
          maximumTotalBytes: 100,
        }),
      assertCode("SEALED_GIT_BLOBS_AT_PATHS_INVALID"),
    );
    assert.throws(
      () =>
        runner.batchBlobsAtPaths({
          commit: fixture.second,
          paths: ["tracked.txt"],
          maximumTotalBytes: 100,
        }),
      assertCode("SEALED_GIT_BATCH_BLOBS_AT_PATHS_INVALID"),
    );

    const batchRequest = {
      commit: fixture.second,
      paths: ["tracked.txt"],
      maximumTotalBytes: 1024,
    };
    mode = "batch-valid";
    assert.equal(
      runner.batchBlobsAtPaths(batchRequest)[0].bytes.toString("utf8"),
      "second state\n",
    );
    for (const invalidMode of [
      "batch-tree-path-substitution",
      "batch-tree-type-substitution",
    ]) {
      mode = invalidMode;
      assert.throws(
        () => runner.batchBlobsAtPaths(batchRequest),
        assertCode("SEALED_GIT_BATCH_BLOBS_AT_PATHS_INVALID"),
      );
    }
    for (const invalidMode of [
      "batch-header-malformed",
      "batch-header-missing-newline",
      "batch-header-non-ascii",
      "batch-object-substitution",
      "batch-type-substitution",
      "batch-framing-truncated",
      "batch-trailing",
    ]) {
      mode = invalidMode;
      assert.throws(
        () => runner.batchBlobsAtPaths(batchRequest),
        assertCode("SEALED_GIT_BATCH_OUTPUT_INVALID"),
      );
    }
    mode = "batch-size-invalid";
    assert.throws(
      () => runner.batchBlobsAtPaths(batchRequest),
      assertCode("SEALED_GIT_OUTPUT_LIMIT"),
    );
    mode = "batch-readback-changed";
    assert.throws(
      () => runner.batchBlobsAtPaths(batchRequest),
      assertCode("SEALED_GIT_BATCH_OBJECT_CHANGED"),
    );

    for (const [invalidMode, code] of [
      ["worktree-invalid-utf8", "SEALED_GIT_WORKTREE_OUTPUT_INVALID"],
      ["worktree-no-header", "SEALED_GIT_WORKTREE_OUTPUT_INVALID"],
      ["worktree-bad-path", "SEALED_GIT_WORKTREE_OUTPUT_INVALID"],
      ["worktree-unknown-field", "SEALED_GIT_WORKTREE_OUTPUT_INVALID"],
      ["worktree-missing-identity", "SEALED_GIT_WORKTREE_OUTPUT_INVALID"],
    ]) {
      mode = invalidMode;
      assert.throws(() => runner.worktrees(), assertCode(code));
    }

    mode = "worktree-detached-metadata";
    assert.deepEqual(runner.worktrees(), [
      {
        path: fixture.root,
        head: fixture.second,
        branch: null,
        detached: true,
        bare: true,
        locked: "owner",
        prunable: "stale",
      },
    ]);

    mode = "remote-valid";
    assert.equal(
      runner.remoteReadback({ url: remoteUrl, ref: branchRef }),
      fixture.second,
    );
    assert.throws(
      () =>
        runner.remoteReadback({
          url: "http://github.com/git/git.git",
          ref: branchRef,
        }),
      assertCode("SEALED_GIT_REMOTE_URL_INVALID"),
    );

    mode = "remote-invalid";
    assert.throws(
      () => runner.remoteReadback({ url: remoteUrl, ref: branchRef }),
      assertCode("SEALED_GIT_REMOTE_OUTPUT_INVALID"),
    );

  });
});

test("a symlinked repository root and symlinked Git metadata are refused", () => {
  const fixture = initializeRepository();
  const aliasParent = tempRoot("pikiio-repo-alias-");
  const alias = path.join(aliasParent, "repo");
  fs.symlinkSync(fixture.root, alias, "dir");
  assert.throws(
    () => createSealedGit({ repoRoot: alias }),
    assertCode("SEALED_GIT_REPOSITORY_ALIAS"),
  );

  const metadataAliasRoot = tempRoot("pikiio-metadata-alias-");
  fs.symlinkSync(path.join(fixture.root, ".git"), path.join(metadataAliasRoot, ".git"));
  assert.throws(
    () => createSealedGit({ repoRoot: metadataAliasRoot }),
    assertCode("SEALED_GIT_METADATA_ALIAS"),
  );
});

test("main and linked worktrees refuse alternate and lazy external object sources", () => {
  const constructors = [
    {
      name: "alternates",
      prepare(fixture) {
        fs.writeFileSync(
          path.join(fixture.root, ".git", "objects", "info", "alternates"),
          `${path.join(initializeRepository().root, ".git", "objects")}\n`,
        );
      },
    },
    {
      name: "http-alternates",
      prepare(fixture) {
        fs.writeFileSync(
          path.join(
            fixture.root,
            ".git",
            "objects",
            "info",
            "http-alternates",
          ),
          "https://example.invalid/objects\n",
        );
      },
    },
    {
      name: "promisor-pack",
      prepare(fixture) {
        const packDirectory = path.join(
          fixture.root,
          ".git",
          "objects",
          "pack",
        );
        fs.mkdirSync(packDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(
            packDirectory,
            `${"a".repeat(40)}.promisor`,
          ),
          "",
        );
      },
    },
    {
      name: "partial-clone-config",
      prepare(fixture) {
        fs.appendFileSync(
          path.join(fixture.root, ".git", "config"),
          "\n[extensions]\n\tpartialClone = origin\n",
        );
      },
    },
    {
      name: "promisor-remote-config",
      prepare(fixture) {
        fs.appendFileSync(
          path.join(fixture.root, ".git", "config"),
          "\n[remote \"lazy\"]\n\tpromisor = true\n\tpartialCloneFilter = blob:none\n",
        );
      },
    },
    ...["lazy.dot", "lazy/name", "lazy_name", "lazy-name"].map(
      (remoteName) => ({
        name: `promisor-remote-config-${remoteName}`,
        prepare(fixture) {
          fs.appendFileSync(
            path.join(fixture.root, ".git", "config"),
            `\n[remote "${remoteName}"]\n\tpromisor = true\n\tpartialCloneFilter = blob:none\n`,
          );
        },
      }),
    ),
    {
      name: "external-config-include",
      prepare(fixture) {
        fs.appendFileSync(
          path.join(fixture.root, ".git", "config"),
          "\n[include]\n\tpath = /tmp/foreign-git-config\n",
        );
      },
    },
  ];
  for (const specimen of constructors) {
    const fixture = initializeRepository();
    specimen.prepare(fixture);
    assert.throws(
      () => createSealedGit({ repoRoot: fixture.root }),
      assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
      specimen.name,
    );
  }

  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });
  fs.writeFileSync(
    path.join(fixture.root, ".git", "objects", "info", "alternates"),
    `${path.join(initializeRepository().root, ".git", "objects")}\n`,
  );
  assert.throws(
    () => runner.head(),
    assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
  );

  const linkedFixture = initializeRepository();
  const worktreeParent = tempRoot("pikiio-sealed-alternate-worktree-");
  const worktree = path.join(worktreeParent, "checkout");
  git(linkedFixture.root, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
    linkedFixture.first,
  ]);
  fs.writeFileSync(
    path.join(
      linkedFixture.root,
      ".git",
      "objects",
      "info",
      "alternates",
    ),
    `${path.join(initializeRepository().root, ".git", "objects")}\n`,
  );
  assert.throws(
    () =>
      createSealedGit({
        repoRoot: fs.realpathSync.native(worktree),
      }),
    assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
  );
});

test("packed info and loose object descendants cannot redirect through aliases", () => {
  for (const family of ["pack", "info", "loose"]) {
    const fixture = initializeRepository();
    const objects = path.join(fixture.root, ".git", "objects");
    let source;
    if (family === "loose") {
      source = fs
        .readdirSync(objects)
        .filter((name) => /^[a-f0-9]{2}$/u.test(name))
        .map((name) => path.join(objects, name))
        .find((candidate) => fs.statSync(candidate).isDirectory());
      assert.ok(source, "fixture must expose one loose-object fanout");
    } else {
      source = path.join(objects, family);
      fs.mkdirSync(source, { recursive: true });
    }
    const external = path.join(
      tempRoot(`pikiio-sealed-${family}-alias-`),
      path.basename(source),
    );
    fs.renameSync(source, external);
    fs.symlinkSync(external, source, "dir");
    assert.throws(
      () => createSealedGit({ repoRoot: fixture.root }),
      assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
      family,
    );
  }

  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });
  const pack = path.join(fixture.root, ".git", "objects", "pack");
  const external = path.join(
    tempRoot("pikiio-sealed-pack-operation-alias-"),
    "pack",
  );
  fs.renameSync(pack, external);
  fs.symlinkSync(external, pack, "dir");
  assert.throws(
    () => runner.head(),
    assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
  );

  for (const shape of ["hardlink", "nested-directory"]) {
    const shaped = initializeRepository();
    const objects = path.join(shaped.root, ".git", "objects");
    const fanout = fs
      .readdirSync(objects)
      .filter((name) => /^[a-f0-9]{2}$/u.test(name))
      .map((name) => path.join(objects, name))
      .find((candidate) => fs.readdirSync(candidate).length > 0);
    assert.ok(fanout);
    if (shape === "hardlink") {
      const objectFile = path.join(fanout, fs.readdirSync(fanout)[0]);
      fs.linkSync(
        objectFile,
        path.join(tempRoot("pikiio-object-hardlink-"), "alias"),
      );
    } else {
      fs.mkdirSync(path.join(fanout, "nested"));
    }
    assert.throws(
      () => createSealedGit({ repoRoot: shaped.root }),
      assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
      shape,
    );
  }
});

test("malformed and unreadable object-source metadata refuses before use", () => {
  const configCases = [
    {
      name: "non-canonical-config-bytes",
      bytes: Buffer.from(
        "[core]\n\trepositoryformatversion = 0\r\n",
        "utf8",
      ),
    },
    {
      name: "continued-config-value",
      bytes: Buffer.from(
        "[core]\n\trepositoryformatversion = 0\\\n",
        "utf8",
      ),
    },
    {
      name: "malformed-config-entry",
      bytes: Buffer.from(
        "[core]\n\trepositoryformatversion = 0\n?bad\n",
        "utf8",
      ),
    },
  ];
  for (const configCase of configCases) {
    const fixture = initializeRepository();
    fs.writeFileSync(
      path.join(fixture.root, ".git", "config"),
      configCase.bytes,
    );
    withFreshSpawnStub((command, args) => {
      assert.equal(command, SYSTEM_BROKER);
      return {
        stdout: Buffer.from(`${fixture.root}\n`),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      };
    }, (fresh) => {
      assert.throws(
        () => fresh.createSealedGit({ repoRoot: fixture.root }),
        assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
        configCase.name,
      );
    });
  }

  for (const inaccessibleSource of ["alternate-file", "pack-directory"]) {
    const fixture = initializeRepository();
    const alternatePath = path.join(
      fixture.root,
      ".git",
      "objects",
      "info",
      "alternates",
    );
    const packDirectory = path.join(
      fixture.root,
      ".git",
      "objects",
      "pack",
    );
    const originalLstatSync = fs.lstatSync;
    const originalReaddirSync = fs.readdirSync;
    if (inaccessibleSource === "alternate-file") {
      fs.lstatSync = function patchedLstatSync(target, options) {
        if (target === alternatePath) {
          throw Object.assign(new Error("synthetic access refusal"), {
            code: "EACCES",
          });
        }
        return originalLstatSync.call(this, target, options);
      };
    } else {
      fs.readdirSync = function patchedReaddirSync(target, options) {
        if (target === packDirectory) {
          throw Object.assign(new Error("synthetic access refusal"), {
            code: "EACCES",
          });
        }
        return originalReaddirSync.call(this, target, options);
      };
    }
    try {
      assert.throws(
        () => createSealedGit({ repoRoot: fixture.root }),
        assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
        inaccessibleSource,
      );
    } finally {
      fs.lstatSync = originalLstatSync;
      fs.readdirSync = originalReaddirSync;
    }
  }
});

test("object-source environment is revalidated before every operation", () => {
  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });
  withPoisonedEnvironment(
    {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(
        initializeRepository().root,
        ".git",
        "objects",
      ),
    },
    () => {
      assert.throws(
        () => runner.head(),
        assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
      );
    },
  );
  assert.equal(runner.head(), fixture.second);
});

test("repository identity replacement after construction fails closed", () => {
  const fixture = initializeRepository();
  const runner = createSealedGit({ repoRoot: fixture.root });
  const originalMetadata = path.join(fixture.root, ".git");
  const movedMetadata = path.join(fixture.root, ".git-original");
  fs.renameSync(originalMetadata, movedMetadata);
  fs.cpSync(movedMetadata, originalMetadata, { recursive: true });
  assert.throws(
    () => runner.head(),
    assertCode("SEALED_GIT_REPOSITORY_CHANGED"),
  );
});

test("canonical worktree gitfiles are bound by content and target identity", () => {
  const fixture = initializeRepository();
  const worktreeParent = tempRoot("pikiio-sealed-worktree-");
  const worktree = path.join(worktreeParent, "checkout");
  git(fixture.root, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
    fixture.first,
  ]);
  const canonicalWorktree = fs.realpathSync.native(worktree);
  const runner = createSealedGit({ repoRoot: canonicalWorktree });
  assert.equal(runner.head(), fixture.first);

  const gitfile = path.join(canonicalWorktree, ".git");
  const original = fs.readFileSync(gitfile, "utf8");
  fs.writeFileSync(gitfile, original.replace(/\n$/u, "\n\n"));
  assert.throws(
    () => runner.head(),
    assertCode("SEALED_GIT_REPOSITORY_CHANGED"),
  );
});

test("linked symbolic HEAD is captured exactly and invalid refs refuse", () => {
  const fixture = initializeRepository();
  const parent = tempRoot("pikiio-sealed-symbolic-worktree-");
  const worktree = path.join(parent, "checkout");
  git(fixture.root, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "sealed-linked-branch",
    worktree,
    fixture.first,
  ]);
  const canonical = fs.realpathSync.native(worktree);
  const runner = createSealedGit({ repoRoot: canonical });
  assert.equal(runner.branch(), "sealed-linked-branch");
  assert.equal(runner.head(), fixture.first);

  const gitDirectory = fs
    .readFileSync(path.join(canonical, ".git"), "utf8")
    .match(/^gitdir: (.+)\n$/u)[1];
  for (const invalid of [
    "ref: refs/heads/bad..name\n",
    "ref: refs/heads/bad@{name\n",
    "ref: refs/heads/bad//name\n",
    "ref: refs/heads/bad/\n",
    "ref: refs/heads/bad.\n",
    "ref: refs/heads/bad.lock\n",
    "not-a-head\n",
  ]) {
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), invalid);
    const invalidRunner = createSealedGit({ repoRoot: canonical });
    assert.throws(
      () => invalidRunner.branch(),
      assertCode("SEALED_GIT_HEAD_INVALID"),
    );
  }
});

test("worktree metadata pointers and common-directory identity are exact", () => {
  const hardlinkFixture = initializeRepository();
  const hardlinkParent = tempRoot("pikiio-sealed-hardlink-worktree-");
  const hardlinkWorktree = path.join(hardlinkParent, "checkout");
  git(hardlinkFixture.root, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    hardlinkWorktree,
    hardlinkFixture.first,
  ]);
  const canonicalHardlinkWorktree =
    fs.realpathSync.native(hardlinkWorktree);
  const hardlinkGitfile = path.join(canonicalHardlinkWorktree, ".git");
  fs.linkSync(
    hardlinkGitfile,
    path.join(hardlinkParent, "gitfile-alias"),
  );
  assert.throws(
    () => createSealedGit({ repoRoot: canonicalHardlinkWorktree }),
    assertCode("SEALED_GIT_METADATA_ALIAS"),
  );

  const fixture = initializeRepository();
  const worktreeParent = tempRoot("pikiio-sealed-common-worktree-");
  const worktree = path.join(worktreeParent, "checkout");
  git(fixture.root, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
    fixture.first,
  ]);
  const canonicalWorktree = fs.realpathSync.native(worktree);
  const gitfile = path.join(canonicalWorktree, ".git");
  const gitDirectory = fs
    .readFileSync(gitfile, "utf8")
    .match(/^gitdir: (.+)\n$/u)[1];
  const commonPointer = path.join(gitDirectory, "commondir");
  const runner = createSealedGit({ repoRoot: canonicalWorktree });
  fs.chmodSync(gitfile, 0o600);
  assert.throws(
    () => runner.head(),
    assertCode("SEALED_GIT_REPOSITORY_CHANGED"),
  );

  const pointerFixture = initializeRepository();
  const pointerParent = tempRoot("pikiio-sealed-pointer-worktree-");
  const pointerWorktree = path.join(pointerParent, "checkout");
  git(pointerFixture.root, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    pointerWorktree,
    pointerFixture.first,
  ]);
  const canonicalPointerWorktree =
    fs.realpathSync.native(pointerWorktree);
  const pointerGitDirectory = fs
    .readFileSync(path.join(canonicalPointerWorktree, ".git"), "utf8")
    .match(/^gitdir: (.+)\n$/u)[1];
  const pointerPath = path.join(pointerGitDirectory, "commondir");
  const pointerRunner = createSealedGit({
    repoRoot: canonicalPointerWorktree,
  });
  fs.writeFileSync(pointerPath, ".\n");
  assert.throws(
    () => pointerRunner.head(),
    assertCode("SEALED_GIT_REPOSITORY_CHANGED"),
  );

  assert.ok(commonPointer.endsWith(`${path.sep}commondir`));
});

test("common-directory pointers reject aliases absolute and malformed bytes", () => {
  for (const [name, mutate] of [
    [
      "symlink",
      (pointer, gitDirectory) => {
        fs.unlinkSync(pointer);
        fs.symlinkSync(gitDirectory, pointer, "dir");
      },
    ],
    ["missing-newline", (pointer) => fs.writeFileSync(pointer, "../..")],
    ["absolute", (pointer) => fs.writeFileSync(pointer, "/tmp\n")],
    [
      "invalid-utf8",
      (pointer) => fs.writeFileSync(pointer, Buffer.from([0xff, 0x0a])),
    ],
  ]) {
    const fixture = initializeRepository();
    const parent = tempRoot(`pikiio-common-pointer-${name}-`);
    const worktree = path.join(parent, "checkout");
    git(fixture.root, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
      fixture.first,
    ]);
    const canonical = fs.realpathSync.native(worktree);
    const gitDirectory = fs
      .readFileSync(path.join(canonical, ".git"), "utf8")
      .match(/^gitdir: (.+)\n$/u)[1];
    const pointer = path.join(gitDirectory, "commondir");
    mutate(pointer, gitDirectory);
    assert.throws(
      () => createSealedGit({ repoRoot: canonical }),
      assertCode("SEALED_GIT_METADATA_ALIAS"),
      name,
    );
  }

  const fixture = initializeRepository();
  const objects = path.join(fixture.root, ".git", "objects");
  const moved = path.join(path.dirname(fixture.root), "objects-authority");
  fs.renameSync(objects, moved);
  fs.symlinkSync(moved, objects, "dir");
  assert.throws(
    () => createSealedGit({ repoRoot: fixture.root }),
    assertCode("SEALED_GIT_METADATA_ALIAS"),
  );
});

test("opened authority defeats same-identity foreign-git ABA for head show and status", () => {
  const fixture = initializeRepository();
  const foreign = initializeRepository();
  git(foreign.root, ["checkout", "--quiet", "--detach", foreign.first]);
  fs.writeFileSync(
    path.join(fixture.root, "tracked.txt"),
    "authority-bound working state\n",
  );
  const expectedStatus = execFileSync(
    SYSTEM_GIT,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
    ],
    {
      cwd: fixture.root,
      env: { ...FIXED_GIT_ENVIRONMENT },
      encoding: null,
    },
  );
  const childProcess = require("node:child_process");
  const realSpawnSync = childProcess.spawnSync;
  let armedPredicate = null;
  const originalMetadata = path.join(fixture.root, ".git");
  const movedMetadata = path.join(
    path.dirname(fixture.root),
    "git-authority",
  );

  withFreshSpawnStub((command, args, options) => {
    if (
      armedPredicate &&
      command === SYSTEM_BROKER &&
      args.includes(SYSTEM_GIT) &&
      armedPredicate(args)
    ) {
      armedPredicate = null;
      fs.renameSync(originalMetadata, movedMetadata);
      fs.cpSync(
        path.join(foreign.root, ".git"),
        originalMetadata,
        { recursive: true },
      );
      try {
        return realSpawnSync(command, args, options);
      } finally {
        fs.rmSync(originalMetadata, { recursive: true, force: true });
        fs.renameSync(movedMetadata, originalMetadata);
      }
    }
    return realSpawnSync(command, args, options);
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: fixture.root });

    armedPredicate = (args) =>
      args.includes("rev-parse") && args.includes("HEAD^{commit}");
    assert.equal(runner.head(), fixture.second);
    assert.equal(armedPredicate, null, "HEAD probe must execute under ABA");

    armedPredicate = (args) =>
      args.includes("cat-file") && args.includes("blob");
    assert.equal(
      runner.show({
        commit: fixture.second,
        path: "tracked.txt",
      }).toString("utf8"),
      "second state\n",
    );
    assert.equal(armedPredicate, null, "show probe must execute under ABA");

    armedPredicate = (args) => args.includes("status");
    assert.deepEqual(runner.status(), expectedStatus);
    assert.equal(armedPredicate, null, "status probe must execute under ABA");
  });
});

test("private object authority defeats restored objects pack and loose ABA", () => {
  for (const family of ["objects", "loose", "pack"]) {
    const fixture = initializeRepository();
    fs.writeFileSync(
      path.join(fixture.root, "third.txt"),
      `third-${family}\n`,
    );
    git(fixture.root, ["add", "third.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", `third-${family}`]);
    const foreignParent = git(fixture.root, ["rev-parse", "HEAD"]);
    const originalCommitBody = execFileSync(
      SYSTEM_GIT,
      ["cat-file", "commit", fixture.second],
      {
        cwd: fixture.root,
        env: { ...FIXED_GIT_ENVIRONMENT },
        encoding: "utf8",
      },
    );
    const forgedCommitBody = originalCommitBody.replace(
      new RegExp(`^parent ${fixture.first}$`, "mu"),
      `parent ${foreignParent}`,
    );
    assert.notEqual(forgedCommitBody, originalCommitBody);
    const forgedLooseBytes = zlib.deflateSync(
      Buffer.concat([
        Buffer.from(
          `commit ${Buffer.byteLength(forgedCommitBody)}\0`,
          "ascii",
        ),
        Buffer.from(forgedCommitBody, "utf8"),
      ]),
    );
    const objects = path.join(fixture.root, ".git", "objects");
    if (family === "pack") {
      git(fixture.root, ["gc", "--quiet", "--prune=now"]);
      assert.equal(
        fs.existsSync(
          path.join(
            objects,
            fixture.second.slice(0, 2),
            fixture.second.slice(2),
          ),
        ),
        false,
      );
    }

    const target =
      family === "objects"
        ? objects
        : family === "pack"
          ? path.join(objects, "pack")
          : path.join(objects, fixture.second.slice(0, 2));
    const moved = path.join(
      path.dirname(fixture.root),
      `${family}-object-authority`,
    );
    const replacement = path.join(
      path.dirname(fixture.root),
      `${family}-object-replacement`,
    );
    if (family === "pack") {
      fs.mkdirSync(replacement);
    } else {
      fs.cpSync(target, replacement, { recursive: true });
      const forgedPath =
        family === "objects"
          ? path.join(
              replacement,
              fixture.second.slice(0, 2),
              fixture.second.slice(2),
            )
          : path.join(replacement, fixture.second.slice(2));
      fs.writeFileSync(forgedPath, forgedLooseBytes);
    }
    const childProcess = require("node:child_process");
    const realSpawnSync = childProcess.spawnSync;
    let armed = true;
    const identityReceipt = () =>
      [fixture.root, path.join(fixture.root, ".git"), objects]
        .map((entryPath) => {
          const stat = fs.lstatSync(entryPath, { bigint: true });
          return [
            entryPath,
            String(stat.dev),
            String(stat.ino),
            String(stat.mode),
            String(stat.nlink),
            String(stat.size),
          ].join(":");
        })
        .join("|");
    const identityBefore = identityReceipt();

    withFreshSpawnStub((command, args, options) => {
      if (
        armed &&
        command === SYSTEM_BROKER &&
        args.includes(SYSTEM_GIT) &&
        args.includes("rev-list") &&
        args.includes("--parents")
      ) {
        armed = false;
        fs.renameSync(target, moved);
        fs.renameSync(replacement, target);
        try {
          return realSpawnSync(command, args, options);
        } finally {
          fs.renameSync(target, replacement);
          fs.renameSync(moved, target);
        }
      }
      return realSpawnSync(command, args, options);
    }, (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      let observed;
      try {
        observed = runner.parent({ commit: fixture.second });
      } catch (error) {
        const currentIdentity = fresh.createSealedGit({
          repoRoot: fixture.root,
        }).repositoryIdentitySha256;
        error.message =
          `${family}: ${error.message}; ` +
          `initial=${runner.repositoryIdentitySha256}; current=${currentIdentity}; ` +
          `stats-before=${identityBefore}; stats-current=${identityReceipt()}`;
        throw error;
      }
      assert.equal(observed, fixture.first, `${family} ABA must return original parent`);
      assert.equal(armed, false, `${family} ABA must execute`);
    });
    fs.rmSync(replacement, { recursive: true, force: true });
  }
});

test("linked worktree uses bound common metadata and private worktree snapshots", () => {
  const fixture = initializeRepository();
  const linkedParent = tempRoot("pikiio-sealed-linked-aba-");
  const linked = path.join(linkedParent, "checkout");
  git(fixture.root, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    linked,
    fixture.second,
  ]);
  const canonicalLinked = fs.realpathSync.native(linked);
  fs.writeFileSync(
    path.join(canonicalLinked, "tracked.txt"),
    "linked authority-bound working state\n",
  );
  const expectedStatus = execFileSync(
    SYSTEM_GIT,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
    ],
    {
      cwd: canonicalLinked,
      env: { ...FIXED_GIT_ENVIRONMENT },
      encoding: null,
    },
  );
  const expectedWorkingDiff = execFileSync(
    SYSTEM_GIT,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--ignore-submodules=none",
      "--no-renames",
      "--binary",
      "--full-index",
      fixture.second,
      "--",
    ],
    {
      cwd: canonicalLinked,
      env: { ...FIXED_GIT_ENVIRONMENT },
      encoding: null,
    },
  );
  const foreign = initializeRepository();
  const childProcess = require("node:child_process");
  const realSpawnSync = childProcess.spawnSync;
  let armed = null;
  const commonMetadata = path.join(fixture.root, ".git");
  const movedCommon = path.join(path.dirname(fixture.root), "common-authority");
  const movedLinked = `${canonicalLinked}-authority`;

  withFreshSpawnStub((command, args, options) => {
    if (
      armed &&
      command === SYSTEM_BROKER &&
      args.includes(SYSTEM_GIT) &&
      armed.predicate(args)
    ) {
      const attack = armed;
      armed = null;
      if (attack.kind === "common") {
        fs.renameSync(commonMetadata, movedCommon);
        fs.cpSync(
          path.join(foreign.root, ".git"),
          commonMetadata,
          { recursive: true },
        );
      } else {
        fs.renameSync(canonicalLinked, movedLinked);
        fs.cpSync(foreign.root, canonicalLinked, { recursive: true });
      }
      try {
        return realSpawnSync(command, args, options);
      } finally {
        if (attack.kind === "common") {
          fs.rmSync(commonMetadata, { recursive: true, force: true });
          fs.renameSync(movedCommon, commonMetadata);
        } else {
          fs.rmSync(canonicalLinked, { recursive: true, force: true });
          fs.renameSync(movedLinked, canonicalLinked);
        }
      }
    }
    return realSpawnSync(command, args, options);
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: canonicalLinked });

    armed = {
      kind: "root",
      predicate: (args) =>
        args.includes("cat-file") && args.includes("-t"),
    };
    assert.equal(runner.head(), fixture.second);
    assert.equal(armed, null, "linked HEAD must use bound common authority");

    armed = {
      kind: "root",
      predicate: (args) =>
        args.includes("cat-file") && args.includes("blob"),
    };
    assert.equal(
      runner.show({
        commit: fixture.second,
        path: "tracked.txt",
      }).toString("utf8"),
      "second state\n",
    );
    assert.equal(armed, null, "linked show must use bound common authority");

    armed = {
      kind: "root",
      predicate: (args) => args.includes("status"),
    };
    assert.deepEqual(runner.status(), expectedStatus);
    assert.equal(armed, null, "linked status must use opened worktree");

    armed = {
      kind: "root",
      predicate: (args) =>
        args.includes("diff") && !args.includes("--cached"),
    };
    assert.deepEqual(
      runner.workingDiff({ base: fixture.second }),
      expectedWorkingDiff,
    );
    assert.equal(armed, null, "linked diff must use opened worktree");
  });
});

test("private snapshots clean up after success failure timeout and signal", () => {
  const snapshotNames = () =>
    fs
      .readdirSync(os.tmpdir())
      .filter((name) =>
        name.startsWith("pikiio-sealed-git-snapshot-"))
      .sort();

  {
    const fixture = initializeRepository();
    const before = snapshotNames();
    createSealedGit({ repoRoot: fixture.root }).status();
    assert.deepEqual(snapshotNames(), before, "success cleanup");
  }

  for (const specimen of [
    {
      name: "failure",
      code: "SEALED_GIT_COMMAND_FAILED",
      receipt: {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("synthetic failure\n"),
        status: 128,
        signal: null,
      },
    },
    {
      name: "timeout",
      code: "SEALED_GIT_TIMEOUT",
      receipt: {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error("timed out"), {
          code: "ETIMEDOUT",
        }),
      },
    },
    {
      name: "signal",
      code: "SEALED_GIT_COMMAND_FAILED",
      receipt: {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: "SIGKILL",
      },
    },
  ]) {
    const fixture = initializeRepository();
    const childProcess = require("node:child_process");
    const realSpawnSync = childProcess.spawnSync;
    const before = snapshotNames();
    withFreshSpawnStub((command, args, options) => {
      if (
        command === SYSTEM_BROKER &&
        args.includes(SYSTEM_GIT) &&
        args.includes("status")
      ) {
        return specimen.receipt;
      }
      return realSpawnSync(command, args, options);
    }, (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      assert.throws(() => runner.status(), assertCode(specimen.code));
    });
    assert.deepEqual(snapshotNames(), before, `${specimen.name} cleanup`);
  }
});

test("private snapshots refuse malformed split sparse and ambiguous indexes", () => {
  const validFixture = initializeRepository();
  const validIndex = fs.readFileSync(
    path.join(validFixture.root, ".git", "index"),
  );
  const withoutChecksum = validIndex.subarray(0, validIndex.length - 20);
  const versionFour = Buffer.from(withoutChecksum);
  versionFour.writeUInt32BE(4, 4);
  const hugeCount = Buffer.from(withoutChecksum);
  hugeCount.writeUInt32BE(1_000_001, 8);
  const badChecksum = Buffer.from(validIndex);
  badChecksum[badChecksum.length - 1] ^= 0xff;
  const truncatedEntry = Buffer.alloc(12);
  truncatedEntry.write("DIRC", 0, "ascii");
  truncatedEntry.writeUInt32BE(2, 4);
  truncatedEntry.writeUInt32BE(1, 8);
  const extendedV2 = Buffer.from(withoutChecksum);
  extendedV2.writeUInt16BE(
    extendedV2.readUInt16BE(72) | 0x4000,
    72,
  );
  const wrongDeclaredPath = Buffer.from(withoutChecksum);
  wrongDeclaredPath.writeUInt16BE(
    (wrongDeclaredPath.readUInt16BE(72) & 0xf000) | 1,
    72,
  );
  const missingPathTerminator = Buffer.alloc(75);
  missingPathTerminator.write("DIRC", 0, "ascii");
  missingPathTerminator.writeUInt32BE(2, 4);
  missingPathTerminator.writeUInt32BE(1, 8);
  missingPathTerminator.writeUInt16BE(1, 72);
  missingPathTerminator[74] = 0xff;
  const missingEntryPadding = Buffer.alloc(77);
  missingEntryPadding.write("DIRC", 0, "ascii");
  missingEntryPadding.writeUInt32BE(2, 4);
  missingEntryPadding.writeUInt32BE(1, 8);
  missingEntryPadding.writeUInt16BE(2, 72);
  missingEntryPadding.write("ab", 74, "ascii");
  const emptyHeader = Buffer.alloc(12);
  emptyHeader.write("DIRC", 0, "ascii");
  emptyHeader.writeUInt32BE(2, 4);
  emptyHeader.writeUInt32BE(0, 8);
  const extensionFragment = Buffer.concat([
    emptyHeader,
    Buffer.from("TREE", "ascii"),
  ]);
  const truncatedExtension = Buffer.concat([
    emptyHeader,
    Buffer.from("TREE", "ascii"),
    Buffer.from([0, 0, 0, 8]),
  ]);
  const linkExtension = Buffer.concat([
    emptyHeader,
    Buffer.from("link", "ascii"),
    Buffer.alloc(4),
  ]);
  const sparseExtension = Buffer.concat([
    emptyHeader,
    Buffer.from("sdir", "ascii"),
    Buffer.alloc(4),
  ]);

  for (const [name, bytes] of [
    ["short", Buffer.from("DIRC")],
    ["version-four", gitIndexBytes(versionFour)],
    ["huge-count", gitIndexBytes(hugeCount)],
    ["bad-checksum", badChecksum],
    ["truncated-entry", gitIndexBytes(truncatedEntry)],
    ["extended-v2", gitIndexBytes(extendedV2)],
    ["wrong-declared-path", gitIndexBytes(wrongDeclaredPath)],
    ["missing-path-terminator", gitIndexBytes(missingPathTerminator)],
    ["missing-entry-padding", gitIndexBytes(missingEntryPadding)],
    ["extension-fragment", gitIndexBytes(extensionFragment)],
    ["truncated-extension", gitIndexBytes(truncatedExtension)],
    ["split-index", gitIndexBytes(linkExtension)],
    ["sparse-index", gitIndexBytes(sparseExtension)],
  ]) {
    const fixture = initializeRepository();
    fs.writeFileSync(path.join(fixture.root, ".git", "index"), bytes);
    const runner = createSealedGit({ repoRoot: fixture.root });
    assert.throws(
      () => runner.status(),
      assertCode("SEALED_GIT_INDEX_UNSUPPORTED"),
      name,
    );
  }
});

test("snapshot copier failures are typed and leave no private directory", () => {
  const fixture = initializeRepository();
  const childProcess = require("node:child_process");
  const realSpawnSync = childProcess.spawnSync;
  const snapshotNames = () =>
    fs
      .readdirSync(os.tmpdir())
      .filter((name) =>
        name.startsWith("pikiio-sealed-git-snapshot-"))
      .sort();
  const before = snapshotNames();
  withFreshSpawnStub((command, args, options) => {
    if (command === SYSTEM_BROKER && args.includes("/bin/cp")) {
      return {
        stdout: Buffer.from("unexpected copier stdout"),
        stderr: Buffer.from("synthetic copier refusal"),
        status: 73,
        signal: null,
      };
    }
    return realSpawnSync(command, args, options);
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: fixture.root });
    assert.throws(
      () => runner.status(),
      assertCode("SEALED_GIT_SNAPSHOT_FAILED"),
    );
  });
  assert.deepEqual(snapshotNames(), before);
});

test("opened authority mismatch and open failures are typed before Git", () => {
  for (const mode of ["identity-mismatch", "open-failure"]) {
    const fixture = initializeRepository();
    const originalFstatSync = fs.fstatSync;
    const originalOpenSync = fs.openSync;
    let armed = false;
    try {
      fs.fstatSync = function patchedFstatSync(descriptor, options) {
        const stat = originalFstatSync.call(this, descriptor, options);
        if (armed && mode === "identity-mismatch" && stat.isDirectory()) {
          armed = false;
          return new Proxy(stat, {
            get(object, key) {
              if (key === "ino") return object.ino + 1n;
              return Reflect.get(object, key);
            },
          });
        }
        return stat;
      };
      fs.openSync = function patchedOpenSync(target, flags, fileMode) {
        if (
          armed &&
          mode === "open-failure" &&
          target === path.join(fixture.root, ".git")
        ) {
          armed = false;
          throw Object.assign(new Error("synthetic open refusal"), {
            code: "EACCES",
          });
        }
        return originalOpenSync.call(this, target, flags, fileMode);
      };
      const runner = createSealedGit({ repoRoot: fixture.root });
      armed = true;
      assert.throws(
        () => runner.branch(),
        assertCode("SEALED_GIT_AUTHORITY_BINDING_FAILED"),
        mode,
      );
      assert.equal(armed, false, `${mode} sabotage must execute`);
    } finally {
      fs.fstatSync = originalFstatSync;
      fs.openSync = originalOpenSync;
    }
  }
});

test("private snapshots reject lock files and non-object symlinks", () => {
  for (const [name, prepare] of [
    [
      "lock",
      (fixture) =>
        fs.writeFileSync(
          path.join(fixture.root, ".git", "synthetic.lock"),
          "locked\n",
        ),
    ],
    [
      "symlink",
      (fixture) =>
        fs.symlinkSync(
          path.join(fixture.root, "tracked.txt"),
          path.join(fixture.root, ".git", "synthetic-alias"),
        ),
    ],
  ]) {
    const fixture = initializeRepository();
    prepare(fixture);
    const runner = createSealedGit({ repoRoot: fixture.root });
    assert.throws(
      () => runner.status(),
      assertCode("SEALED_GIT_SNAPSHOT_INVALID"),
      name,
    );
  }
});

test("post-operation fences dominate valid output and command failures", () => {
  for (const commandFailure of [false, true]) {
    const fixture = initializeRepository();
    const originalMetadata = path.join(fixture.root, ".git");
    const movedMetadata = path.join(fixture.root, ".git-original");
    let mutateOnNextCommand = false;
    withFreshSpawnStub((command, args) => {
      assert.equal(command, SYSTEM_BROKER);
      if (mutateOnNextCommand) {
        mutateOnNextCommand = false;
        fs.renameSync(originalMetadata, movedMetadata);
        fs.cpSync(movedMetadata, originalMetadata, { recursive: true });
        return {
          stdout: commandFailure
            ? Buffer.alloc(0)
            : Buffer.from(`${fixture.second}\n`),
          stderr: commandFailure
            ? Buffer.from("synthetic failure\n")
            : Buffer.alloc(0),
          status: commandFailure ? 128 : 0,
          signal: null,
        };
      }
      if (args.includes("cat-file") && args.includes("-t")) {
        return {
          stdout: Buffer.from("commit\n"),
          stderr: Buffer.alloc(0),
          status: 0,
          signal: null,
        };
      }
      return {
        stdout: Buffer.from(`${fixture.second}\n`),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      };
    }, (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      mutateOnNextCommand = true;
      assert.throws(
        () => runner.head(),
        assertCode("SEALED_GIT_REPOSITORY_CHANGED"),
      );
    });
  }
});

test("post-operation trusted-executable fence is unconditional", () => {
  const fixture = initializeRepository();
  const originalStatSync = fs.statSync;
  let changeExecutableIdentity = false;
  let changedExecutableChecks = 0;
  fs.statSync = function patchedStatSync(target, options) {
    const stat = originalStatSync.call(this, target, options);
    if (
      changeExecutableIdentity &&
      target === SYSTEM_GIT &&
      options?.bigint === true
    ) {
      changedExecutableChecks += 1;
      return new Proxy(stat, {
        get(object, key) {
          if (key === "ino") return object.ino + 1n;
          return Reflect.get(object, key);
        },
      });
    }
    return stat;
  };
  try {
    withFreshSpawnStub((command, args) => {
      assert.equal(command, SYSTEM_BROKER);
      changeExecutableIdentity = true;
      return {
        stdout: Buffer.from(`${fixture.second}\n`),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      };
    }, (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      assert.throws(
        () => runner.branch(),
        assertCode("SEALED_GIT_EXECUTABLE_CHANGED"),
      );
      assert.equal(
        changedExecutableChecks,
        2,
        "post fence must revalidate executable path and bytes after spawn",
      );
    });
  } finally {
    fs.statSync = originalStatSync;
  }
});

test("pre-operation trusted-executable fence refuses before spawn", () => {
  const fixture = initializeRepository();
  const originalStatSync = fs.statSync;
  let changeExecutableIdentity = false;
  let spawnCount = 0;
  fs.statSync = function patchedStatSync(target, options) {
    const stat = originalStatSync.call(this, target, options);
    if (
      changeExecutableIdentity &&
      target === SYSTEM_GIT &&
      options?.bigint === true
    ) {
      return new Proxy(stat, {
        get(object, key) {
          if (key === "ino") return object.ino + 1n;
          return Reflect.get(object, key);
        },
      });
    }
    return stat;
  };
  try {
    withFreshSpawnStub((command, args) => {
      spawnCount += 1;
      assert.equal(command, SYSTEM_BROKER);
      return {
        stdout: Buffer.from(`${fixture.root}\n`),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      };
    }, (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      assert.equal(spawnCount, 0);
      changeExecutableIdentity = true;
      assert.throws(
        () => runner.head(),
        assertCode("SEALED_GIT_EXECUTABLE_CHANGED"),
      );
      assert.equal(spawnCount, 0);
    });
  } finally {
    fs.statSync = originalStatSync;
  }
});

test("pre-operation repository fence refuses before spawn", () => {
  const fixture = initializeRepository();
  let spawnCount = 0;
  withFreshSpawnStub((command, args) => {
    spawnCount += 1;
    assert.equal(command, SYSTEM_BROKER);
    return {
      stdout: Buffer.from(`${fixture.second}\n`),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: fixture.root });
    assert.equal(spawnCount, 0);
    const currentMode = fs.statSync(fixture.root).mode & 0o777;
    fs.chmodSync(fixture.root, currentMode === 0o700 ? 0o755 : 0o700);
    assert.throws(
      () => runner.head(),
      assertCode("SEALED_GIT_REPOSITORY_CHANGED"),
    );
    assert.equal(spawnCount, 0);
  });
});

test("pre-operation object-source fence refuses before spawn", () => {
  const fixture = initializeRepository();
  let spawnCount = 0;
  withFreshSpawnStub((command, args) => {
    spawnCount += 1;
    assert.equal(command, SYSTEM_BROKER);
    return {
      stdout: Buffer.from(`${fixture.root}\n`),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: fixture.root });
    assert.equal(spawnCount, 0);
    withPoisonedEnvironment(
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/external-objects" },
      () => {
        assert.throws(
          () => runner.head(),
          assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
        );
        assert.equal(spawnCount, 0);
      },
    );
  });
});

test("post-operation object-source fence cannot be hidden by valid output", () => {
  const fixture = initializeRepository();
  let introduceAlternate = false;
  let spawnCount = 0;
  withFreshSpawnStub((command, args) => {
    spawnCount += 1;
    assert.equal(command, SYSTEM_BROKER);
    if (introduceAlternate) {
      introduceAlternate = false;
      fs.writeFileSync(
        path.join(
          fixture.root,
          ".git",
          "objects",
          "info",
          "alternates",
        ),
        `${path.join(initializeRepository().root, ".git", "objects")}\n`,
      );
    }
    return {
      stdout: Buffer.from(`${fixture.second}\n`),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }, (fresh) => {
    const runner = fresh.createSealedGit({ repoRoot: fixture.root });
    assert.equal(spawnCount, 0);
    introduceAlternate = true;
    assert.throws(
      () => runner.branch(),
      assertCode("SEALED_GIT_OBJECT_SOURCE_INVALID"),
    );
    assert.equal(
      spawnCount,
      1,
      "post fence must refuse after exactly one operation spawn",
    );
  });
});

test("object descendant changes during a child and broker refusals are typed", () => {
  {
    const fixture = initializeRepository();
    const childProcess = require("node:child_process");
    const realSpawnSync = childProcess.spawnSync;
    let mutate = false;
    withFreshSpawnStub((command, args, options) => {
      if (mutate && command === SYSTEM_BROKER && args.includes(SYSTEM_GIT)) {
        mutate = false;
        execFileSync(
          SYSTEM_GIT,
          ["hash-object", "-w", "--stdin"],
          {
            cwd: fixture.root,
            env: { ...FIXED_GIT_ENVIRONMENT },
            input: "new object during sealed child\n",
            encoding: "utf8",
          },
        );
      }
      return realSpawnSync(command, args, options);
    }, (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      mutate = true;
      assert.throws(
        () => runner.branch(),
        assertCode("SEALED_GIT_OBJECT_SOURCE_CHANGED"),
      );
    });
  }

  {
    const fixture = initializeRepository();
    withFreshSpawnStub(() => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("authority-chdir:synthetic\n"),
      status: 77,
      signal: null,
    }), (fresh) => {
      const runner = fresh.createSealedGit({ repoRoot: fixture.root });
      assert.throws(
        () => runner.branch(),
        assertCode("SEALED_GIT_AUTHORITY_BINDING_FAILED"),
      );
    });
  }
});

test("stdout and stderr overflow fail closed at independent bounds", () => {
  const fixture = initializeRepository();
  const stdoutBounded = createSealedGit({
    repoRoot: fixture.root,
    maxStdoutBytes: 256,
  });
  assert.throws(
    () =>
      stdoutBounded.show({
        commit: fixture.second,
        path: "large.txt",
      }),
    assertCode("SEALED_GIT_OUTPUT_LIMIT"),
  );

  const stderrBounded = createSealedGit({
    repoRoot: fixture.root,
    maxStderrBytes: 8,
  });
  assert.throws(
    () => stderrBounded.tree({ commit: "0".repeat(40) }),
    assertCode("SEALED_GIT_OUTPUT_LIMIT"),
  );

  const batchFramingBounded = createSealedGit({
    repoRoot: fixture.root,
    maxStdoutBytes: 128,
  });
  assert.throws(
    () =>
      batchFramingBounded.batchBlobsAtPaths({
        commit: fixture.second,
        paths: ["tracked.txt"],
        maximumTotalBytes: 64,
      }),
    assertCode("SEALED_GIT_OUTPUT_LIMIT"),
  );
});

test("a bounded Git subprocess timeout is returned as a typed refusal", () => {
  const fixture = initializeRepository();
  let initialized = false;
  withFreshSpawnStub((command, args) => {
    assert.equal(command, SYSTEM_BROKER);
    initialized = true;
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("timed out"), {
        code: "ETIMEDOUT",
      }),
    };
  }, (fresh) => {
    const runner = fresh.createSealedGit({
      repoRoot: fixture.root,
      timeoutMs: 2_000,
    });
    assert.throws(
      () => runner.head(),
      assertCode("SEALED_GIT_TIMEOUT"),
    );
  });
});

test("mutation child kill receipts require a clean concrete targeted failure", () => {
  const valid = {
    error: undefined,
    signal: null,
    status: 1,
    stdout: "✖ exact targeted test\nAssertionError [ERR_ASSERTION]\n",
    stderr: "",
  };
  assert.doesNotThrow(() =>
    assertCompletedChildReceipt(valid, {
      expectedStatus: 1,
      label: "valid",
      targetedTestName: "exact targeted test",
      assertionSignature: "AssertionError [ERR_ASSERTION]",
    }));
  for (const [name, sabotage] of [
    ["spawn-error", { error: Object.assign(new Error("spawn"), { code: "EIO" }) }],
    ["timeout", { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }],
    ["signal", { signal: "SIGTERM" }],
    ["missing-status", { status: null }],
    ["zero-status", { status: 0 }],
    ["wrong-test", { stdout: "✖ another test\nAssertionError [ERR_ASSERTION]\n" }],
    ["wrong-assertion", { stdout: "✖ exact targeted test\nTypeError\n" }],
  ]) {
    assert.throws(
      () =>
        assertCompletedChildReceipt(
          { ...valid, ...sabotage },
          {
            expectedStatus: 1,
            label: name,
            targetedTestName: "exact targeted test",
            assertionSignature: "AssertionError [ERR_ASSERTION]",
          },
        ),
      assert.AssertionError,
      name,
    );
  }
});

if (process.env.PIKIIO_SEALED_GIT_MUTANT_CHILD !== "1") {
  test("critical source mutations are killed with unique anchored guards", () => {
    const sourcePath = path.join(
      __dirname,
      "..",
      "lib",
      "pikiio-sealed-git.js",
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    const testSource = fs.readFileSync(__filename, "utf8");
    const mutants = [
      {
        id: "no-lazy-fetch",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_NO_LAZY_FETCH",
        from: 'GIT_NO_LAZY_FETCH: "1"',
        to: 'GIT_NO_LAZY_FETCH: "0"',
        testPattern: "inherited Git authority variables",
      },
      {
        id: "no-replace",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_NO_REPLACE",
        from: 'GIT_NO_REPLACE_OBJECTS: "1"',
        to: 'GIT_NO_REPLACE_OBJECTS: "0"',
        testPattern: "inherited Git authority variables",
      },
      {
        id: "input-proxy",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_INPUT_PROXY",
        from: "utilTypes.isProxy(value) ||",
        to: "false ||",
        testPattern: "every options and request object",
      },
      {
        id: "input-prototype",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_INPUT_PROTOTYPE",
        from: "Object.getPrototypeOf(value) !== Object.prototype",
        to: "false",
        testPattern: "every options and request object",
      },
      {
        id: "input-symbol",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_INPUT_SYMBOL",
        from: "if (ownKeys.some((key) => typeof key !== \"string\"))",
        to: "if (false)",
        testPattern: "every options and request object",
      },
      {
        id: "input-accessor",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_INPUT_ACCESSOR",
        from: "!Object.hasOwn(descriptor, \"value\") ||",
        to: "false ||",
        testPattern: "every options and request object",
      },
      {
        id: "metadata-link-count",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_METADATA_NLINK",
        from: "(requireSingleLink && statBefore.nlink !== 1n) ||",
        to: "false ||",
        testPattern: "worktree metadata pointers",
      },
      {
        id: "object-environment",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_OBJECT_ENV",
        from: "if (Object.hasOwn(process.env, name))",
        to: "if (false)",
        testPattern: "object-source environment",
      },
      {
        id: "alternate-file",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_ALTERNATE_FILE",
        from: "if (fileExistsWithoutFollowing(sourcePath))",
        to: "if (false)",
        testPattern: "main and linked worktrees refuse",
      },
      {
        id: "promisor-pack",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_PROMISOR_PACK",
        from: "if (packNames.some((name) => name.endsWith(\".promisor\")))",
        to: "if (false)",
        testPattern: "main and linked worktrees refuse",
      },
      {
        id: "object-descendant-alias",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_OBJECT_DESCENDANT_ALIAS",
        from: "return captureObjectDescendantAuthority(identity);",
        to: "return digest(Buffer.alloc(0));",
        testPattern: "packed info and loose object descendants",
      },
      {
        id: "lazy-config",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_LAZY_CONFIG",
        from: "return (",
        to: "return false && (",
        testPattern: "main and linked worktrees refuse",
      },
      {
        id: "array-prototype",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_ARRAY_PROTOTYPE",
        from: "Object.getPrototypeOf(value) !== Array.prototype ||",
        to: "false ||",
        testPattern: "repository path arrays",
      },
      {
        id: "dense-array",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_DENSE_ARRAY",
        from: ") {",
        to: "&& false) {",
        testPattern: "repository path arrays",
      },
      {
        id: "array-accessor",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_ARRAY_ACCESSOR",
        from: "!Object.hasOwn(descriptor, \"value\") ||",
        to: "false ||",
        testPattern: "repository path arrays",
      },
      {
        id: "canonical-array",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_CANONICAL_ARRAY",
        from: ") {",
        to: "&& false) {",
        testPattern: "repository path arrays",
      },
      {
        id: "pre-executable",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_PRE_EXECUTABLE_FENCE",
        from: "requireTrustedExecutableUnchanged();",
        to: "void 0;",
        testPattern: "pre-operation trusted-executable",
      },
      {
        id: "pre-repository",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_PRE_REPOSITORY_FENCE",
        from: "requireRepositoryIdentity(repository);",
        to: "void 0;",
        testPattern: "pre-operation repository fence",
      },
      {
        id: "pre-object-source",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_PRE_OBJECT_SOURCE_FENCE",
        from: "requireNoExternalObjectSources(repository);",
        to: "void 0;",
        testPattern: "pre-operation object-source fence",
      },
      {
        id: "post-executable",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_POST_EXECUTABLE_FENCE",
        from: "requireTrustedExecutableUnchanged();",
        to: "void 0;",
        testPattern: "post-operation trusted-executable",
      },
      {
        id: "post-repository",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_POST_REPOSITORY_FENCE",
        from: "requireRepositoryIdentity(repository);",
        to: "void 0;",
        testPattern: "post-operation fences",
      },
      {
        id: "post-object-source",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_POST_OBJECT_SOURCE_FENCE",
        from: "requireNoExternalObjectSources(repository);",
        to: "void 0;",
        testPattern: "post-operation object-source",
      },
      {
        id: "timeout",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_TIMEOUT",
        from: "if (result.error?.code === \"ETIMEDOUT\")",
        to: "if (false)",
        testPattern: "bounded Git subprocess timeout",
      },
      {
        id: "stdout-limit",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_STDOUT_LIMIT",
        from: "stdout.length > effectiveStdoutBytes",
        to: "false",
        testPattern: "synthetic subprocess edge receipts",
      },
      {
        id: "stderr-limit",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_STDERR_LIMIT",
        from: "if (stderr.length > maxStderrBytes)",
        to: "if (false)",
        testPattern: "synthetic subprocess edge receipts",
      },
      {
        id: "command-status",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_COMMAND_STATUS",
        from: "!acceptedStatuses.includes(result.status)",
        to: "false",
        testPattern: "synthetic subprocess edge receipts",
      },
      {
        id: "output-utf8",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_OUTPUT_UTF8",
        from: "if (!Buffer.from(value, \"utf8\").equals(stdout))",
        to: "if (false)",
        testPattern: "synthetic subprocess edge receipts",
      },
      {
        id: "commit-type",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_COMMIT_TYPE",
        from: ") {",
        to: "&& false) {",
        testPattern: "every commit-scoped operation",
      },
      {
        id: "blob-identity",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_BLOB_IDENTITY",
        from: "if (readBackObjectId !== entry.objectId)",
        to: "if (false)",
        testPattern: "synthetic subprocess edge receipts",
      },
      {
        id: "batch-identity",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_BATCH_IDENTITY",
        from: "if (readBackObjectId !== entry.objectId)",
        to: "if (false)",
        testPattern: "synthetic subprocess edge receipts",
      },
      {
        id: "https-only",
        anchor: "SEALED_GIT_CRITICAL_ANCHOR_HTTPS_ONLY",
        from: "parsed.protocol !== \"https:\" ||",
        to: "false ||",
        testPattern: "synthetic subprocess edge receipts",
      },
    ];

    const anchorNames = [
      ...source.matchAll(/SEALED_GIT_CRITICAL_ANCHOR_[A-Z0-9_]+/gu),
    ].map((match) => match[0]);
    assert.equal(
      new Set(anchorNames).size,
      anchorNames.length,
      "critical source anchors must be unique",
    );
    assert.equal(
      anchorNames.length,
      mutants.length,
      "every critical source anchor must have one mutant",
    );
    const requestedMutants = String(
      process.env.PIKIIO_SEALED_GIT_MUTANT_FILTER || "",
    )
      .split(",")
      .filter(Boolean);
    const selectedMutants =
      requestedMutants.length === 0
        ? mutants
        : mutants.filter((mutant) =>
            requestedMutants.includes(mutant.id),
          );
    assert.equal(
      selectedMutants.length,
      requestedMutants.length === 0
        ? mutants.length
        : requestedMutants.length,
      "mutation filter must name exact known mutants",
    );
    const preparedMutants = selectedMutants.map((mutant) => {
      const lines = source.split("\n");
      const matchingLines = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes(mutant.anchor));
      assert.equal(
        matchingLines.length,
        1,
        `${mutant.id} must resolve one source anchor`,
      );
      const target = matchingLines[0];
      assert.equal(
        target.line.includes(mutant.from),
        true,
        `${mutant.id} source mutation no longer matches its anchor`,
      );
      assert.equal(
        target.line.split(mutant.from).length - 1,
        1,
        `${mutant.id} mutation expression must occur once on its anchor line`,
      );
      assert.notEqual(
        mutant.to,
        mutant.from,
        `${mutant.id} replacement must differ from source`,
      );
      lines[target.index] = target.line.replace(mutant.from, mutant.to);
      assert.notEqual(lines[target.index], target.line, mutant.id);
      assert.equal(
        lines.filter(
          (line, index) => line !== source.split("\n")[index],
        ).length,
        1,
        `${mutant.id} must change exactly one source line`,
      );
      return Object.freeze({
        mutant,
        candidateSource: lines.join("\n"),
      });
    });

    const runSource = (candidateSource, testPattern, label) => {
      const root = tempRoot(`pikiio-sealed-mutant-${label}-`);
      const libDirectory = path.join(root, "lib");
      const testDirectory = path.join(root, "tests");
      fs.mkdirSync(libDirectory);
      fs.mkdirSync(testDirectory);
      fs.writeFileSync(
        path.join(libDirectory, "pikiio-sealed-git.js"),
        candidateSource,
      );
      const targetTest = path.join(
        testDirectory,
        "pikiio-sealed-git.test.js",
      );
      fs.writeFileSync(targetTest, testSource);
      const childEnvironment = {
        ...process.env,
        PIKIIO_SEALED_GIT_MUTANT_CHILD: "1",
      };
      delete childEnvironment.NODE_TEST_CONTEXT;
      return spawnSync(
        process.execPath,
        [
          "--test",
          "--test-reporter=spec",
          `--test-name-pattern=${testPattern}`,
          targetTest,
        ],
        {
          cwd: root,
          env: childEnvironment,
          encoding: "utf8",
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    };

    const baselinePatterns = [
      ...new Set(selectedMutants.map((mutant) => mutant.testPattern)),
    ];
    const declaredTestNames = [
      ...testSource.matchAll(/test\(\s*"([^"]+)"/gu),
    ].map((match) => match[1]);
    const exactTargetName = (testPattern) => {
      const matches = declaredTestNames.filter((name) =>
        name.includes(testPattern),
      );
      assert.equal(
        matches.length,
        1,
        `mutation pattern must resolve one exact test: ${testPattern}`,
      );
      return matches[0];
    };
    assert.equal(
      preparedMutants.length,
      selectedMutants.length,
      "every selected mutant must have one prepared source candidate",
    );
    assert.equal(
      new Set(selectedMutants.map((mutant) => mutant.id)).size,
      selectedMutants.length,
      "selected mutant IDs must be unique",
    );
    assert.equal(
      selectedMutants.every((mutant) =>
        baselinePatterns.includes(mutant.testPattern),
      ),
      true,
      "every selected mutant must map to one baseline shard",
    );
    assert.deepEqual(
      baselinePatterns,
      [
        ...new Set(
          selectedMutants.map((mutant) => mutant.testPattern),
        ),
      ],
      "mutation baseline groups must exactly cover selected mutants",
    );
    for (const [index, testPattern] of baselinePatterns.entries()) {
      const baseline = runSource(
        source,
        testPattern,
        `baseline-${index}`,
      );
      assertCompletedChildReceipt(baseline, {
        expectedStatus: 0,
        label: `mutation baseline group: ${testPattern}`,
      });
    }

    const killed = [];
    for (const { mutant, candidateSource } of preparedMutants) {
      const result = runSource(
        candidateSource,
        mutant.testPattern,
        mutant.id,
      );
      assertCompletedChildReceipt(result, {
        expectedStatus: 1,
        label: mutant.id,
        targetedTestName: exactTargetName(mutant.testPattern),
        assertionSignature: "AssertionError [ERR_ASSERTION]",
      });
      killed.push(mutant.id);
    }
    assert.equal(killed.length, selectedMutants.length);
    assert.equal(
      Number(
        ((killed.length / selectedMutants.length) * 100).toFixed(2),
      ),
      100,
    );
  });
}
