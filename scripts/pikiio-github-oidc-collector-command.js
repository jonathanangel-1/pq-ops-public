#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const {
  stableJson,
  validateAttestationBody,
} = require("../lib/pikiio-phase-attestation");
const {
  buildGithubOidcCollectorReceipt,
  expectedAudience,
  reconstructAttestationBodyFromProofInputs,
} = require("../lib/pikiio-github-oidc-collector");

const MAX_INPUT_BASE64_BYTES = 48 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 1000;

function requiredEnvironment(name, maximum = 4096) {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new Error(`${name} is missing or exceeds its bound`);
  }
  return value;
}

function parseCanonicalProofInputs(encoded) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new Error("PIKIIO_PROOF_INPUTS_BASE64 is not canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    encoded.length > MAX_INPUT_BASE64_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    throw new Error("PIKIIO_PROOF_INPUTS_BASE64 exceeds its bound");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw = JSON.parse(text);
  if (text !== stableJson(raw)) {
    throw new Error("proof input JSON bytes are not canonical");
  }
  return reconstructAttestationBodyFromProofInputs(raw);
}

function abortRequest(controller) {
  controller.abort();
}

async function requestOidcToken({
  audience,
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable");
  }
  const requestUrl = new URL(requiredEnvironment("ACTIONS_ID_TOKEN_REQUEST_URL"));
  if (
    requestUrl.protocol !== "https:" ||
    !requestUrl.hostname.endsWith(".actions.githubusercontent.com")
  ) {
    throw new Error("GitHub OIDC request URL is not an Actions HTTPS endpoint");
  }
  requestUrl.searchParams.set("audience", audience);
  const bearer = requiredEnvironment(
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    16 * 1024,
  );
  const controller = new AbortController();
  const timeout = setTimeoutImpl(
    abortRequest.bind(null, controller),
    REQUEST_TIMEOUT_MS,
  );
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `bearer ${bearer}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeoutImpl(timeout);
  }
  if (!response.ok) {
    throw new Error(`GitHub OIDC request failed with status ${response.status}`);
  }
  const result = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    typeof result.value !== "string"
  ) {
    throw new Error("GitHub OIDC response has an unexpected shape");
  }
  return result.value;
}

async function collect({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const body = parseCanonicalProofInputs(
    requiredEnvironment(
      "PIKIIO_PROOF_INPUTS_BASE64",
      MAX_INPUT_BASE64_BYTES,
    ),
  );
  const candidateCommit = requiredEnvironment("PIKIIO_CANDIDATE_SHA", 40);
  const checkedOutCandidate = requiredEnvironment(
    "PIKIIO_CHECKED_OUT_CANDIDATE_SHA",
    40,
  );
  const githubSha = requiredEnvironment("GITHUB_SHA", 40);
  if (
    body.candidateCommit !== candidateCommit ||
    candidateCommit !== checkedOutCandidate ||
    candidateCommit !== githubSha
  ) {
    throw new Error("candidate SHA does not match body, checkout, and GitHub run");
  }
  const scopeBaseCommit = requiredEnvironment("PIKIIO_SCOPE_BASE_SHA", 40);
  const jwksRegistrySha256 = requiredEnvironment(
    "PIKIIO_JWKS_REGISTRY_SHA256",
    64,
  );
  const requestedAt = new Date(now()).toISOString();
  const oidcToken = await requestOidcToken({
    audience: expectedAudience(validateAttestationBody(body).bodySha256),
    fetchImpl,
  });
  const receivedAt = new Date(now()).toISOString();
  return buildGithubOidcCollectorReceipt({
    body,
    scopeBaseCommit,
    jwksRegistrySha256,
    oidcToken,
    requestedAt,
    receivedAt,
  });
}

async function main({
  argv = process.argv,
  cwd = process.cwd(),
  collectImpl = collect,
  fsImpl = fs,
} = {}) {
  if (argv.length !== 3 || argv[2] !== "collect") {
    throw new Error("usage: pikiio-github-oidc-collector-command.js collect");
  }
  const outputPath = requiredEnvironment("PIKIIO_RECEIPT_OUTPUT_PATH", 4096);
  if (!outputPath.startsWith(`${cwd}/`)) {
    throw new Error("PIKIIO_RECEIPT_OUTPUT_PATH must be inside the job workspace");
  }
  const receipt = await collectImpl();
  fsImpl.writeFileSync(outputPath, `${stableJson(receipt)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function reportCliFailure(error, stderr = process.stderr) {
  stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function runCli({
  mainImpl = main,
  reportFailure = reportCliFailure,
} = {}) {
  try {
    await mainImpl();
  } catch (error) {
    reportFailure(error);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  MAX_INPUT_BASE64_BYTES,
  REQUEST_TIMEOUT_MS,
  collect,
  main,
  parseCanonicalProofInputs,
  reportCliFailure,
  requestOidcToken,
  runCli,
};
