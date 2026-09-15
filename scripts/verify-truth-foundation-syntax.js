#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const EXACT_FILES = Object.freeze([
  "scripts/check-truth-production-protection.js",
  "scripts/read-truth-audit-status.js",
  "scripts/run-hosted-canonical-refresh.js",
  "scripts/verify-truth-full-migration-stack.js",
  "scripts/verify-truth-foundation.js",
]);
const DIRECTORY_RULES = Object.freeze([
  ["api/truth", /^.+\.js$/],
  ["api/cron", /^truth-.+\.js$/],
  ["lib", /^(?:gmail-(?:api|attachment|claim|cross-thread|evidence|incremental|mailbox|rfc822)|hosted-truth|openai-(?:gmail|truth)|operator-(?:claim|source)|postgres-jsonb|relational-truth|server-protected|source-processing|source-snapshot|tms-(?:claim|source)|tracking-(?:claim|source)|truth-).+\.js$/],
]);

function selectedFiles() {
  const files = new Set(EXACT_FILES);
  for (const [relativeDirectory, pattern] of DIRECTORY_RULES) {
    const directory = path.join(ROOT, relativeDirectory);
    assert.ok(fs.existsSync(directory), `Missing syntax directory ${relativeDirectory}`);
    for (const name of fs.readdirSync(directory)) {
      if (pattern.test(name)) files.add(path.posix.join(relativeDirectory, name));
    }
  }
  return [...files].sort();
}

function main() {
  const files = selectedFiles();
  assert.ok(files.length >= 45, `Truth-foundation syntax scope unexpectedly shrank to ${files.length} files`);
  for (const relativePath of files) {
    const absolutePath = path.join(ROOT, relativePath);
    assert.ok(fs.existsSync(absolutePath), `Missing truth-foundation runtime ${relativePath}`);
    const source = fs.readFileSync(absolutePath, "utf8").replace(/^#![^\n]*\n/, "");
    new vm.Script(source, { filename: absolutePath, displayErrors: true });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "truth-foundation-syntax",
    parsedFileCount: files.length,
    files,
  }, null, 2)}\n`);
}

main();
