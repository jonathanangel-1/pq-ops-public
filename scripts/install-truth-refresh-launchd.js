#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const LABEL = "com.pikiio.truth-refresh";
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(ROOT_DIR, "logs");
const NODE_BIN = process.execPath;
const RUNNER_PATH = path.join(ROOT_DIR, "scripts/run-local-truth-refresh.js");
// Refresh every 10 min, comfortably under the 15-min health staleness threshold so
// production never oscillates into "stale" between runs.
const START_INTERVAL_SECONDS = 10 * 60;

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout.trim();
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT_DIR)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE_BIN)}</string>
    <string>${xml(RUNNER_PATH)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${START_INTERVAL_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(LOG_DIR, "truth-refresh.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(LOG_DIR, "truth-refresh.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

function install() {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist());
  spawnSync("launchctl", ["bootout", domain(), PLIST_PATH], { encoding: "utf8" });
  run("launchctl", ["bootstrap", domain(), PLIST_PATH]);
  run("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`]);
  console.log(JSON.stringify({ ok: true, installed: true, label: LABEL, plist: PLIST_PATH }, null, 2));
}

function uninstall() {
  spawnSync("launchctl", ["bootout", domain(), PLIST_PATH], { encoding: "utf8" });
  fs.rmSync(PLIST_PATH, { force: true });
  console.log(JSON.stringify({ ok: true, uninstalled: true, label: LABEL, plist: PLIST_PATH }, null, 2));
}

function status() {
  const result = spawnSync("launchctl", ["print", `${domain()}/${LABEL}`], { encoding: "utf8" });
  console.log(JSON.stringify({
    ok: result.status === 0,
    label: LABEL,
    plist: PLIST_PATH,
    intervalSeconds: START_INTERVAL_SECONDS,
    output: (result.stdout || result.stderr || "").slice(0, 4000),
  }, null, 2));
  process.exit(result.status === 0 ? 0 : 1);
}

const command = process.argv[2] || "status";
try {
  if (command === "install") install();
  else if (command === "uninstall") uninstall();
  else if (command === "status") status();
  else throw new Error("Usage: node scripts/install-truth-refresh-launchd.js install|uninstall|status");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
