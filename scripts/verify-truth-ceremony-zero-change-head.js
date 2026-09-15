#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = [
  "supabase/migrations/20260718110000_truth_ceremony_zero_change_head_carry_forward.sql",
  "supabase/migrations/20260718150000_truth_ceremony_empty_history_cursor_advance.sql",
  "supabase/migrations/20260718200000_admit_empty_filtered_gmail_history_cursor_advance.sql",
].map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n").toLowerCase();
const ceremony = fs.readFileSync(path.join(ROOT, "scripts/ceremony/freeze-flip.js"), "utf8");

for (const token of [
  "truth_gmail_zero_change_successor_span_valid_v1",
  "read_truth_ceremony_gmail_head",
  "zero_change_carry_forward",
  "batch.mode<>'history'",
  "batch.trigger_name<>'truth-shadow-orchestrator-v1:incremental'",
  "batch.observation_count<>0",
  "batch.job_count<>0",
  "page.event_count=0",
  "page.job_count=0",
  "page.provider_event_manifest='[]'::jsonb",
  "gmail_ingest_page_observations",
  "gmail_ingest_page_jobs",
  "source_processing_job_lineage",
  "truth_pending_acceptance_epochs",
  "batch.expected_cursor_value<>batch.previous_cursor_value",
  "batch.committed_cursor_version<>batch.expected_cursor_version+1",
  "page.response_mailbox_history_id=batch.committed_cursor_value",
  "sourcecursormutated',false",
  "candidateclaimscreated',false",
  "productionpublicationattempted',false",
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
  "to service_role",
]) assert.ok(migration.includes(token), `migration missing ${token}`);

assert.match(ceremony, /public\.read_truth_ceremony_gmail_head\(\$1,\$2\)/);
assert.match(ceremony, /ZERO-CHANGE-CARRY/);
assert.match(ceremony, /c\.query\(HEAD_SQL, \[WORKSPACE, syncToken\]\)/);
assert.doesNotMatch(ceremony, /update\s+public\.source_cursors/i);

function validSpan(input) {
  const {
    workspaceKey,
    connectionKey,
    acceptedRootBatchId,
    acceptedVersion,
    acceptedValue,
    liveVersion,
    liveValue,
    liveRootBatchId,
    acceptedEpochs,
    batches,
    pendingVersions,
  } = input;
  const suffix = batches.filter((batch) => (
    batch.version > acceptedVersion && batch.version <= liveVersion
  ));
  return workspaceKey === "primary"
    && connectionKey === "primary"
    && liveVersion > acceptedVersion
    && /^\d+$/.test(acceptedValue)
    && /^\d+$/.test(liveValue)
    && BigInt(liveValue) >= BigInt(acceptedValue)
    && acceptedEpochs.some((epoch) => (
      epoch.rootBatchId === acceptedRootBatchId
      && epoch.version === acceptedVersion
      && epoch.value === acceptedValue
    ))
    && suffix.some((batch) => (
      batch.rootBatchId === liveRootBatchId
      && batch.version === liveVersion
      && batch.value === liveValue
      && batch.status === "committed"
    ))
    && suffix.length === liveVersion - acceptedVersion
    && suffix.sort((a, b) => a.version - b.version).every((batch, index, ordered) => (
      batch.mode === "history"
      && batch.triggerName === "truth-shadow-orchestrator-v1:incremental"
      && batch.status === "committed"
      && batch.expectedVersion === (index === 0 ? acceptedVersion : ordered[index - 1].version)
      && batch.expectedValue === (index === 0 ? acceptedValue : ordered[index - 1].value)
      && batch.version === batch.expectedVersion + 1
      && /^\d+$/.test(batch.expectedValue)
      && /^\d+$/.test(batch.value)
      && BigInt(batch.value) >= BigInt(batch.expectedValue)
      && batch.pageCursor === batch.value
      && batch.pageCount === 1
      && batch.observationCount === 0
      && batch.jobCount === 0
      && batch.batchHash === true
      && batch.pageEventCount === 0
      && batch.providerEventManifestEmpty === true
      && batch.pageJobCount === 0
      && batch.pageMembershipCount === 0
      && batch.observationMembershipCount === 0
      && batch.jobMembershipCount === 0
      && batch.lineageCount === 0
    ))
    && pendingVersions.every((version) => version <= acceptedVersion || version > liveVersion)
    && acceptedEpochs.every((epoch) => epoch.version <= acceptedVersion || epoch.version > liveVersion);
}

const batch = (rootBatchId, version, value, expectedVersion, expectedValue) => ({
  rootBatchId,
  version,
  value,
  expectedVersion,
  expectedValue,
  pageCursor: value,
  mode: "history",
  triggerName: "truth-shadow-orchestrator-v1:incremental",
  status: "committed",
  pageCount: 1,
  observationCount: 0,
  jobCount: 0,
  batchHash: true,
  pageEventCount: 0,
  providerEventManifestEmpty: true,
  pageJobCount: 0,
  pageMembershipCount: 0,
  observationMembershipCount: 0,
  jobMembershipCount: 0,
  lineageCount: 0,
});
const fixture = {
  workspaceKey: "primary",
  connectionKey: "primary",
  acceptedRootBatchId: "accepted-root",
  acceptedVersion: 1115,
  acceptedValue: "19671932",
  liveVersion: 1117,
  liveValue: "19671934",
  liveRootBatchId: "empty-1117",
  acceptedEpochs: [{ rootBatchId: "accepted-root", version: 1115, value: "19671932" }],
  batches: [
    batch("empty-1116", 1116, "19671934", 1115, "19671932"),
    batch("empty-1117", 1117, "19671934", 1116, "19671934"),
  ],
  pendingVersions: [],
};
assert.equal(validSpan(fixture), true);

const mutations = [
  (copy) => { copy.workspaceKey = "other"; },
  (copy) => { copy.connectionKey = "shadow-other"; },
  (copy) => { copy.liveValue = "19671933"; },
  (copy) => { copy.liveRootBatchId = "wrong-root"; },
  (copy) => { copy.batches.pop(); },
  (copy) => { copy.batches[0].value = "19671931"; copy.batches[0].pageCursor = "19671931"; },
  (copy) => { copy.batches[0].expectedValue = "19671930"; },
  (copy) => { copy.batches[0].pageCursor = "19671935"; },
  (copy) => { copy.batches[0].value = "not-decimal"; copy.batches[0].pageCursor = "not-decimal"; },
  (copy) => { copy.batches[0].mode = "snapshot"; },
  (copy) => { copy.batches[0].triggerName = "manual"; },
  (copy) => { copy.batches[0].status = "running"; },
  (copy) => { copy.batches[0].observationCount = 1; },
  (copy) => { copy.batches[0].jobCount = 1; },
  (copy) => { copy.batches[0].pageEventCount = 1; },
  (copy) => { copy.batches[0].providerEventManifestEmpty = false; },
  (copy) => { copy.batches[0].pageJobCount = 1; },
  (copy) => { copy.batches[0].pageMembershipCount = 1; },
  (copy) => { copy.batches[0].observationMembershipCount = 1; },
  (copy) => { copy.batches[0].jobMembershipCount = 1; },
  (copy) => { copy.batches[0].lineageCount = 1; },
  (copy) => { copy.pendingVersions.push(1116); },
  (copy) => { copy.acceptedEpochs.push({ rootBatchId: "later", version: 1116, value: "19671932" }); },
];
for (const mutate of mutations) {
  const copy = structuredClone(fixture);
  mutate(copy);
  assert.equal(validSpan(copy), false);
}

console.log(JSON.stringify({
  ok: true,
  verifier: "truth-ceremony-zero-change-head",
  refusalCases: mutations.length,
  checks: [
    "two exact empty successors may carry the latest accepted evidence frontier across a monotonic cursor advance",
    "the live root and cursor remain the cut vector",
    "cursor rewinds, broken cursor chains, page mismatches, changed source evidence, jobs, lineage, pending epochs, or version gaps refuse carry-forward",
    "the ceremony reader is token-bound and publishes or mutates nothing",
  ],
}, null, 2));
