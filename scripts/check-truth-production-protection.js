#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function fail(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  throw error;
}

function linkedProject() {
  const file = path.join(ROOT, ".vercel", "project.json");
  if (!fs.existsSync(file)) fail("TRUTH_PROTECTION_PROJECT_NOT_LINKED", "The repository is not linked to a Vercel project");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value.projectName || !value.projectId || !value.orgId) {
    fail("TRUTH_PROTECTION_PROJECT_INVALID", "The linked Vercel project metadata is incomplete");
  }
  return value;
}

function protectionSettings(project) {
  let raw;
  try {
    raw = execFileSync("vercel", [
      "project", "protection", project.projectName,
      "--format", "json",
      "--scope", project.orgId,
    ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  } catch (cause) {
    fail("TRUTH_PROTECTION_READ_FAILED", "Unable to read Vercel deployment-protection settings", {
      exitCode: cause?.status ?? null,
    });
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail("TRUTH_PROTECTION_RESPONSE_INVALID", "Vercel returned an invalid deployment-protection response");
  }
}

function assertProtection(settings) {
  if (settings?.ssoProtection?.deploymentType !== "all") {
    fail(
      "TRUTH_PROTECTION_NOT_ALL",
      "Vercel Authentication must cover every production alias before truth writes or witnesses are enabled",
      { deploymentType: settings?.ssoProtection?.deploymentType || "none" },
    );
  }
  const bypasses = Object.values(settings?.protectionBypass || {});
  if (!bypasses.some((entry) => entry?.scope === "automation-bypass" && entry?.isEnvVar === true)) {
    fail(
      "TRUTH_PROTECTION_BYPASS_MISSING",
      "A Vercel automation-protection bypass exposed as an environment variable is required",
    );
  }
}

function productionOrigin() {
  const raw = String(process.env.PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN || "").trim();
  let url;
  try { url = new URL(raw); } catch { fail("TRUTH_PROTECTION_ORIGIN_INVALID", "PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("TRUTH_PROTECTION_ORIGIN_INVALID", "PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN must be a credential-free HTTPS origin");
  }
  return url.origin;
}

async function assertUnauthenticatedRequestBlocked(origin) {
  const response = await fetch(`${origin}/api/truth/production-witness`, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  const location = response.headers.get("location") || "";
  const blocked = [401, 403].includes(response.status) ||
    ([302, 303, 307, 308].includes(response.status) && /^https:\/\//i.test(location));
  if (!blocked) {
    fail(
      "TRUTH_PROTECTION_PUBLICLY_REACHABLE",
      "The production truth witness reached application code without Vercel Authentication",
      { status: response.status },
    );
  }
  return response.status;
}

async function main() {
  const project = linkedProject();
  const settings = protectionSettings(project);
  assertProtection(settings);
  const origin = productionOrigin();
  const unauthenticatedStatus = await assertUnauthenticatedRequestBlocked(origin);
  console.log(JSON.stringify({
    ok: true,
    check: "truth-production-protection",
    projectId: project.projectId,
    deploymentType: "all",
    automationBypassConfigured: true,
    unauthenticatedStatus,
    productionOrigin: origin,
    mutatesState: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error?.code || "TRUTH_PROTECTION_CHECK_FAILED",
    error: error instanceof Error ? error.message : String(error),
    detail: error?.detail || {},
    mutatesState: false,
  }, null, 2));
  process.exitCode = 1;
});
