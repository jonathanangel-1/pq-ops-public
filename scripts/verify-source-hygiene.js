#!/usr/bin/env node
"use strict";

// Source hygiene: no C0 control bytes (other than \n, \t, \r) in shipped
// source. Incident 2026-07-05: a scripted edit wrote regex "\b" through a
// non-raw string, embedding literal backspace (0x08) bytes into two committed
// app.js regexes — both matched nothing, silently killing companion broad-list
// routing and part of the Change Center class filter. node -c cannot catch
// this; the file stays syntactically valid.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TARGETS = ["app.js", "styles.css", "index.html", "server.js", "ops-sync.js"];
for (const dir of ["lib", "scripts", "api", "api/brain", "api/truth", "api/actions", "api/cron", "api/operator", "api/operator/events", "api/operator/push", "api/gmail", "api/gmail/oauth", "api/outbox", "api/email-refresh"]) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (/\.(js|css|html)$/.test(name) && fs.statSync(path.join(full, name)).isFile()) {
      TARGETS.push(path.join(dir, name));
    }
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
let bad = 0;
for (const rel of [...new Set(TARGETS)]) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  const match = text.match(CONTROL);
  if (match) {
    const line = text.slice(0, match.index).split("\n").length;
    console.error(`FAIL - ${rel}:${line} contains control byte 0x${match[0].charCodeAt(0).toString(16).padStart(2, "0")}`);
    bad += 1;
  }
}
if (bad) process.exit(1);
console.log(JSON.stringify({ ok: true, files: TARGETS.length }));
