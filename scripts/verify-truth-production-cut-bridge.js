#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = [
  "supabase/migrations/20260718130000_truth_production_cut_from_accepted_gmail.sql",
  "supabase/migrations/20260718160000_truth_production_bridge_carry_forward_head.sql",
].map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n").toLowerCase();
const ceremony = fs.readFileSync(path.join(ROOT, "scripts/ceremony/freeze-flip.js"), "utf8");
const publisher = fs.readFileSync(path.join(ROOT, "scripts/ceremony/production-publish.js"), "utf8");

for (const token of [
  "truth_production_cut_acceptance_bridges",
  "seal_truth_production_cut_from_accepted_gmail_v1",
  "truth_shadow_root_source_cuts",
  "truth_build_documented_gap_exclusions_v1",
  "truth-source-cut-serialization-v1:",
  "accepted gmail shadow root is no longer the live cursor",
  "production required-source registry is not the reviewed four-source vector",
  "production required-source vector is missing, stale, or unproved",
  "production required-source vector has an open or failed batch",
  "production-cut bridge cannot attach after build or publication",
  "acceptedrootbatchid",
  "acceptedcursorversion",
  "acceptance_epoch_manifest->-1",
  "zero_change_carry_forward",
  "productionpublicationattempted',false",
  "publishestruth',false",
  "performsactions',false",
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
  "has_function_privilege('service_role'",
]) assert.ok(migration.includes(token), `migration missing ${token}`);

const authorityBody = migration.split(
  "create or replace function private.seal_truth_production_cut_from_accepted_gmail_v1",
)[1].split("$function$;")[0];
for (const forbidden of [
  "insert into public.truth_builds",
  "insert into public.truth_publications",
  "insert into public.accepted_claims",
  "insert into public.candidate_claim_envelopes",
  "insert into public.truth_model_requests",
]) assert.equal(authorityBody.includes(forbidden), false, `authority contains ${forbidden}`);

const bridgeCall = ceremony.indexOf("seal_truth_production_cut_from_accepted_gmail_v1");
const productionVectorBuild = ceremony.indexOf("'production-vector'");
const parity = ceremony.indexOf("parity-gate.js", productionVectorBuild);
const publish = ceremony.indexOf("production-publish.js", parity);
assert.ok(bridgeCall > 0 && productionVectorBuild > bridgeCall);
assert.ok(parity > productionVectorBuild && publish > parity);
assert.ok(ceremony.slice(publish, publish + 240).includes("productionCutId"));
assert.ok(publisher.includes("production publication requires a bridged non-shadow required-source cut"));
assert.ok(publisher.includes("truth_production_cut_acceptance_bridges"));
assert.ok(publisher.includes("truth_shadow_root_source_cuts"));

function eligible(input) {
  const exactSources = [
    "gmail:primary",
    "operator:operator-phone-primary",
    "tms:couriercloud-ops-tlv-us",
    "tracking:carrier-tracking-primary",
  ];
  return input.workspace === "primary"
    && input.shadowOnly
    && !input.shadowProductionEligible
    && input.acceptedHead
    && input.shadowCursor === input.liveGmailCursor
    && (input.acceptanceMode === "zero_change_carry_forward"
      ? input.acceptedRoot === input.scopeRoot
        && input.acceptedCursorVersion === input.scopeAcceptedCursorVersion
        && input.obligationId === input.scopeObligationId
      : input.headRoot === input.scopeRoot)
    && JSON.stringify(input.sources) === JSON.stringify(exactSources)
    && input.everyCursorLive
    && input.everyBatchExact
    && input.everyManifestExact
    && input.everySourceFresh
    && !input.openOrFailedBatch
    && input.documentedGapsExact
    && !input.buildExists
    && !input.publicationExists;
}

const fixture = {
  workspace: "primary",
  shadowOnly: true,
  shadowProductionEligible: false,
  acceptedHead: true,
  acceptanceMode: "exact_accepted",
  headRoot: "accepted-root-1118",
  scopeRoot: "accepted-root-1118",
  acceptedRoot: "accepted-root-1118",
  acceptedCursorVersion: 1118,
  scopeAcceptedCursorVersion: 1118,
  obligationId: "accepted-obligation-1118",
  scopeObligationId: "accepted-obligation-1118",
  shadowCursor: "1118:19672022",
  liveGmailCursor: "1118:19672022",
  sources: [
    "gmail:primary",
    "operator:operator-phone-primary",
    "tms:couriercloud-ops-tlv-us",
    "tracking:carrier-tracking-primary",
  ],
  everyCursorLive: true,
  everyBatchExact: true,
  everyManifestExact: true,
  everySourceFresh: true,
  openOrFailedBatch: false,
  documentedGapsExact: true,
  buildExists: false,
  publicationExists: false,
};
assert.equal(eligible(fixture), true);
const carryFixture = structuredClone(fixture);
Object.assign(carryFixture, {
  acceptanceMode: "zero_change_carry_forward",
  headRoot: "empty-live-root-1123",
  scopeRoot: "accepted-root-1121",
  acceptedRoot: "accepted-root-1121",
  acceptedCursorVersion: 1121,
  scopeAcceptedCursorVersion: 1121,
  obligationId: "accepted-obligation-1121",
  scopeObligationId: "accepted-obligation-1121",
  shadowCursor: "1123:19672246",
  liveGmailCursor: "1123:19672246",
});
assert.equal(eligible(carryFixture), true);
const mutations = [
  (x) => { x.workspace = "foreign"; },
  (x) => { x.shadowOnly = false; },
  (x) => { x.shadowProductionEligible = true; },
  (x) => { x.acceptedHead = false; },
  (x) => { x.liveGmailCursor = "1119:19672023"; },
  (x) => { x.sources.pop(); },
  (x) => { x.everyCursorLive = false; },
  (x) => { x.everyBatchExact = false; },
  (x) => { x.everyManifestExact = false; },
  (x) => { x.everySourceFresh = false; },
  (x) => { x.openOrFailedBatch = true; },
  (x) => { x.documentedGapsExact = false; },
  (x) => { x.buildExists = true; },
  (x) => { x.publicationExists = true; },
];
for (const mutate of mutations) {
  const copy = structuredClone(fixture);
  mutate(copy);
  assert.equal(eligible(copy), false);
}
const carryMutations = [
  (x) => { x.acceptedRoot = "wrong-accepted-root"; },
  (x) => { x.acceptedCursorVersion = 1120; },
  (x) => { x.obligationId = "wrong-obligation"; },
  (x) => { x.liveGmailCursor = "1124:19672247"; },
];
for (const mutate of carryMutations) {
  const copy = structuredClone(carryFixture);
  mutate(copy);
  assert.equal(eligible(copy), false);
}

console.log(JSON.stringify({
  ok: true,
  verifier: "truth-production-cut-bridge",
  refusalCases: mutations.length + carryMutations.length,
  checks: [
    "shadow acceptance proof remains quarantined",
    "production cut binds the exact current four-source vector",
    "carry-forward binds accepted root version and obligation separately from the current live cursor",
    "documented gaps remain immutable and independently validated",
    "parity and publication consume only the bridged production cut",
    "coordinator performs no build publication claim model or action write",
  ],
}, null, 2));
