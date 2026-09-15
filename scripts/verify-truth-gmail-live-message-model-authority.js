#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717750000_truth_gmail_live_message_model_authority.sql"), "utf8");
const drainAuthority = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717760000_truth_gmail_primary_message_model_drain_authority.sql"), "utf8");
const childReservation = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717770000_truth_gmail_primary_model_child_worker_reservation.sql"), "utf8");
const workerHandoff = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717780000_truth_gmail_primary_parent_worker_handoff.sql"), "utf8");
const dedicatedParentSealer = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717790000_truth_gmail_primary_dedicated_parent_sealer.sql"), "utf8");
const customPlanRuntime = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717800000_truth_gmail_parent_custom_plan_runtime.sql"), "utf8");
const oneRunParentSealer = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717810000_truth_gmail_primary_one_run_parent_sealer.sql"), "utf8");
const contextHashRecovery = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717820000_truth_gmail_primary_context_hash_recovery.sql"), "utf8");
const modelSchemaRecovery = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717830000_truth_gmail_model_schema_v2_recovery.sql"), "utf8");
const schemaRetrySuccessor = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717840000_truth_gmail_schema_retry_successor_parent.sql"), "utf8");
const schemaRetryTokenNormalization = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717850000_truth_gmail_schema_retry_token_normalization.sql"), "utf8");
const temperatureRecovery = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717860000_truth_gmail_model_temperature_recovery.sql"), "utf8");
const podPromptRecovery = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717870000_truth_gmail_pod_promise_prompt_recovery.sql"), "utf8");
const modalityRecovery = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717880000_truth_gmail_model_modality_recovery.sql"), "utf8");
const modalityIdentityRetry = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717890000_truth_gmail_model_modality_identity_retry.sql"), "utf8");
const modalityLeaseRetry = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717900000_truth_gmail_model_modality_lease_retry.sql"), "utf8");
const resultHashParity = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717910000_truth_gmail_model_result_hash_parity.sql"), "utf8");
const forwardParentAuthority = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717940000_truth_gmail_primary_forward_parent_authority.sql"), "utf8");
const forwardModelChildClaim = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717960000_truth_gmail_primary_forward_model_child_claim.sql"), "utf8");
const forwardReviewRead = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717970000_truth_gmail_primary_forward_review_read.sql"), "utf8");
const minimalReasoningWire = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260717980000_truth_gmail_minimal_reasoning_wire.sql"), "utf8");
const driver = fs.readFileSync(path.join(ROOT, "scripts/run-primary-message-model-drain.js"), "utf8");
const { _test: driverTest } = require("./run-primary-message-model-drain");

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label} missing ${value}`);
}

includesAll(migration, [
  "truth_gmail_live_message_model_root_allowed_v1",
  "truth_gmail_live_message_model_job_allowed_v1",
  "p_workspace_key is distinct from 'primary'",
  "p_connection_key is distinct from 'primary'",
  "batch.status='committed'",
  "truth_gmail_claims_readiness_boundary_epoch_valid_v1",
  "gmail_extract_message_model_claims",
  "gmail_review_model_extraction",
  "valid_truth_review_token",
  "valid_truth_sync_token",
  "'''shadowOnly'', v_shadow_only",
  "The confirmed refusal occurs before a job attempt is claimed",
], "migration authority");

assert.match(migration, /connection_key like ''shadow-%%'' and shadow_only=true/);
assert.match(migration, /connection_key=''primary'' and shadow_only=false/);
assert.ok(!/insert\s+into\s+[^;]*(accepted_claim|truth_publication|truth_model_workspace_account)/i.test(migration), "migration must not write claims, publications, or budgets");
assert.ok(!/schema_migrations|migration_versions|version-row/i.test(migration), "migration must not record its own version row");

for (const untouched of [
  "auto_bind_truth_shadow_late_model_source_cut_v1",
  "bind_truth_shadow_late_model_source_cut_v1",
  "truth_shadow_late_gmail_model_review_allowed_v1",
  "truth_shadow_late_model_review_adoption_v1",
  "truth_shadow_review_decision_adoption_v1",
]) assert.ok(!migration.includes(`create or replace function private.${untouched}`), `${untouched} must remain shadow/late-lane owned`);

includesAll(drainAuthority, [
  "truth_gmail_live_commissioned_parent_v1",
  "truth_gmail_live_commissioned_parent_worker_allowed_v1",
  "primary-message-model-drain:parents:",
  "primary-message-model-drain-v1:parents-v1",
  "truth_shadow_gmail_model_commissioning_replay_valid_v1",
  "truth_shadow_gmail_model_commissioning_child_input_allowed_v1",
  "plan.root_ingest_mode in ('history','cutover_delta_reconciliation')",
  "truth_gmail_live_plan_collision_id_v1",
  "truth_gmail_live_plan_collision_retry_authorizations",
  "CONTENT_ADDRESSED_PLAN_CROSS_PARENT_COLLISION",
  "truth_gmail_live_model_child_activations",
  "LIVE_COMMISSIONING_CHILD_INPUT_AUTHORITY_ALIGNED",
  "production_publication_attempted=false",
], "drain authority");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(drainAuthority),
  "drain authority must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(drainAuthority),
  "drain authority must not change model budgets");
assert.ok(!drainAuthority.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "collision repair must be class-scoped, not Virginia-batch hard-coded");

includesAll(childReservation, [
  "truth_gmail_live_model_child_worker_allowed_v1",
  "primary-message-model-drain:claims:",
  "primary-message-model-drain-v1:claims-v2",
  "admitted_message_model_claim_jobs as materialized",
  "truth_gmail_live_message_model_job_allowed_v1",
  "truth_gmail_live_model_child_worker_race_recoveries",
  "HOSTED_MODEL_OFF_WORKER_CLAIMED_LIVE_CHILD",
  "hosted-truth-shadow-runtime-v2:gmail-model-claim-v1",
  "GMAIL_LIVE_MODEL_CHILD_WORKER_RACE_RECOVERED",
  "production_publication_attempted=false",
], "model-child worker reservation");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(childReservation),
  "model-child reservation must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(childReservation),
  "model-child reservation must not change model budgets");
assert.ok(!childReservation.includes("66f60f15-a218-4b2d-a8d4-c98c0247576d"),
  "model-child recovery must be class-scoped, not Virginia hard-coded");

includesAll(workerHandoff, [
  "truth_gmail_live_parent_worker_handoffs",
  "primary-message-model-drain-v1:parents-v1",
  "primary-message-model-drain-v1:parents-v2",
  "truth_gmail_live_commissioned_parent_worker_allowed_v1",
  "public.seal_gmail_model_extraction_plan",
  "retired primary commissioned parent worker refused",
  "FABLE_BACKGROUND_WORKER_RETIRED",
  "production_publication_attempted=false",
], "primary parent-worker handoff");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(workerHandoff),
  "parent-worker handoff must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(workerHandoff),
  "parent-worker handoff must not change model budgets");

includesAll(dedicatedParentSealer, [
  "seal_gmail_primary_commissioned_model_extraction_plan_v1",
  "primary-message-model-drain-v1:parents-v3",
  "primary commissioned parent requires dedicated sealer",
  "truth_gmail_live_parent_route_timeout_v1",
  "truth_gmail_live_parent_seal_route_recoveries",
  "LEGACY_SEAL_ROUTE_STARVATION",
  "production_publication_attempted=false",
], "dedicated primary parent sealer");
assert.ok(!dedicatedParentSealer.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "parent route recovery must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(dedicatedParentSealer),
  "dedicated parent sealer migration must not accept claims, build, cut, or publish truth");

includesAll(customPlanRuntime, [
  "plan_cache_mode='force_custom_plan'",
  "set jit='off'",
  "primary-message-model-drain-v1:parents-v4",
  "truth_gmail_live_parent_dedicated_timeout_v1",
  "truth_gmail_live_parent_custom_plan_recoveries",
  "GENERIC_PLAN_SEAL_TIMEOUT",
  "statementTimeoutUnchanged",
  "production_publication_attempted=false",
], "primary parent custom-plan runtime");
assert.ok(!customPlanRuntime.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "custom-plan recovery must be class-scoped, not sibling hard-coded");
assert.ok(!/set statement_timeout\s*=\s*'(?!60s)/i.test(customPlanRuntime),
  "custom-plan recovery must not increase the hosted statement timeout");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(customPlanRuntime),
  "custom-plan runtime must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(customPlanRuntime),
  "custom-plan runtime must not change model budgets");

includesAll(oneRunParentSealer, [
  "primary commissioned parent sealer v1 retired",
  "seal_gmail_primary_commissioned_model_extraction_plan_v2",
  "primary-message-model-drain-v1:parents-v5-f4a81077",
  "truth_gmail_live_parent_one_run_authorizations",
  "one-run primary commissioned parent token refused",
  "COPYABLE_WORKER_IDENTITY_RETIRED",
  "production_publication_attempted=false",
], "one-run primary parent sealer");
assert.ok(!oneRunParentSealer.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "one-run parent authorization must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(oneRunParentSealer),
  "one-run parent sealer must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(oneRunParentSealer),
  "one-run parent sealer must not change model budgets");

includesAll(contextHashRecovery, [
  "primary commissioned parent sealer v2 retired",
  "seal_gmail_primary_commissioned_model_extraction_plan_v3",
  "primary-message-model-drain-v1:parents-v6-ba915833",
  "truth_gmail_live_parent_context_hash_recoveries",
  "ACCEPTED_CLAIM_MICROSECOND_HASH_MISMATCH",
  "context-hash primary commissioned parent token refused",
  "production_publication_attempted=false",
], "accepted-claim context-hash recovery");
assert.ok(!contextHashRecovery.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "context-hash recovery must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(contextHashRecovery),
  "context-hash recovery must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(contextHashRecovery),
  "context-hash recovery must not change model budgets");

includesAll(modelSchemaRecovery, [
  "gmail-model-candidate-claims-v2",
  "PROVIDER_SCHEMA_UNIQUEITEMS_REFUSED",
  "invalid_json_schema",
  "authorize_truth_gmail_model_schema_retry_parents",
  "truth_gmail_model_schema_retry_parent_authorizations",
  "primary commissioned parent sealer v3 retired",
  "seal_gmail_primary_commissioned_model_extraction_plan_v4",
  "primary-message-model-drain-v1:parents-v7-28d0ac5a",
  "schema-retry primary commissioned parent token refused",
  "production_publication_attempted=false",
], "Gmail model schema v2 recovery");
assert.ok(!modelSchemaRecovery.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "model schema recovery must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(modelSchemaRecovery),
  "model schema recovery must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(modelSchemaRecovery),
  "model schema recovery must not change model budgets");

includesAll(schemaRetrySuccessor, [
  "truth-gmail-model-schema-retry-successor-v2",
  "primary-message-model-drain-v1:parents-v8-d0e09b75",
  "seal_gmail_primary_commissioned_model_extraction_plan_v5",
  "schema-retry primary commissioned parent sealer v4 retired",
  "superseded_by_schema_v2_retry_parent",
  "priorCommissionedSuccessorParentJobId",
  "provider_error_code='invalid_json_schema'",
  "actual_microusd=0",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
], "schema-v2 retry successor parent");
assert.ok(!schemaRetrySuccessor.includes("0c5f37d8-3ecb-424f-85ad-1c89ed096214"),
  "schema-v2 retry successor must be class-scoped, not Virginia hard-coded");
assert.ok(!schemaRetrySuccessor.includes("44034062-de9e-4508-8fc4-804c34f175b6"),
  "schema-v2 retry successor must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(schemaRetrySuccessor),
  "schema-v2 retry successor must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(schemaRetrySuccessor),
  "schema-v2 retry successor must not change model budgets");

includesAll(schemaRetryTokenNormalization, [
  "truth_gmail_model_schema_retry_token_recoveries",
  "hex64-plus-LF-v1",
  "SEALED_TOKEN_ARTIFACT_TRAILING_LF",
  "primary-message-model-drain-v1:parents-v9-d0e09b75lf",
  "seal_gmail_primary_commissioned_model_extraction_plan_v6",
  "sealer v5 retired after token normalization refusal",
  "job.attempt_count=2",
  "p_run_token||chr(10)",
  "modelCallsPerformed',false",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
], "schema-retry token normalization");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(schemaRetryTokenNormalization),
  "schema-retry token normalization must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(schemaRetryTokenNormalization),
  "schema-retry token normalization must not change model budgets");

includesAll(temperatureRecovery, [
  "gmail-model-candidate-claims-v3",
  "gmail_model_candidate_claims_v3",
  "GPT5_TEMPERATURE_UNSUPPORTED",
  "truth_gmail_model_temperature_retry_authorizations",
  "primary-message-model-drain-v1:parents-v10-fe957026",
  "seal_gmail_primary_commissioned_model_extraction_plan_v7",
  "sealer v6 retired after provider wire refusal",
  "provider_error_code='invalid_request_error'",
  "request.request_payload->'temperature'='0'::jsonb",
  "actual_microusd=0",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
], "message-model temperature recovery");
assert.ok(!temperatureRecovery.includes("8f1cda6a-f86e-4ef3-bb88-7ca49135df66"),
  "temperature recovery must be class-scoped, not Virginia hard-coded");
assert.ok(!temperatureRecovery.includes("1738b9c5-fa7d-4ff0-984b-edd118b47afa"),
  "temperature recovery must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(temperatureRecovery),
  "temperature recovery must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(temperatureRecovery),
  "temperature recovery must not change model budgets");

includesAll(podPromptRecovery, [
  "gmail-claim-extraction-prompt-v4",
  "gmail-model-candidate-claims-v4",
  "gmail_model_candidate_claims_v4",
  "POD promise or future such as will send POD",
  "POD_PROMISE_NOT_RECEIPT",
  "truth_gmail_model_pod_prompt_retry_authorizations",
  "primary-message-model-drain-v1:parents-v11-1a2edda3",
  "seal_gmail_primary_commissioned_model_extraction_plan_v8",
  "sealer v7 retired after semantic refusal",
  "provider_error_code='model_output_validation_failed'",
  "outcome.classification='malformed_output'",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
], "message-model POD-promise prompt recovery");
assert.ok(!podPromptRecovery.includes("c6788716-60c3-4167-84ee-139180810356"),
  "POD-prompt recovery must be class-scoped, not Virginia hard-coded");
assert.ok(!podPromptRecovery.includes("b0eee790-71fa-43c1-82c6-1adbc4f1110e"),
  "POD-prompt recovery must be class-scoped, not sibling hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(podPromptRecovery),
  "POD-prompt recovery must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(podPromptRecovery),
  "POD-prompt recovery must not change model budgets");

includesAll(modalityRecovery, [
  "MODEL_MODALITY_SIGNAL_ANCHOR",
  "truth_gmail_model_modality_retry_authorizations",
  "primary-message-model-drain-v1:parents-v12-39d43130",
  "seal_gmail_primary_commissioned_model_extraction_plan_v9",
  "sealer v8 retired after modality-anchor refusal",
  "request.response_schema_version='gmail-model-candidate-claims-v4'",
  "request.prompt_version='gmail-claim-extraction-prompt-v4'",
  "outcome.classification='malformed_output'",
  "provider_error_code='model_output_validation_failed'",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
], "message-model modality-anchor recovery");
assert.ok(!modalityRecovery.includes("1c1bda6f-575a-46d5-9b8d-9caad81b8099"),
  "modality recovery must be class-scoped, not Virginia-child hard-coded");
assert.ok(!modalityRecovery.includes("bd594f2f-e5a1-4d19-808e-b7a2573276ec"),
  "modality recovery must be class-scoped, not sibling-child hard-coded");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(modalityRecovery),
  "modality recovery must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(modalityRecovery),
  "modality recovery must not change model budgets");

includesAll(modalityIdentityRetry, [
  "gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:",
  "truth_gmail_model_modality_collision_retries",
  "EXTRACTOR_IDENTITY_NOT_ROTATED",
  "job.attempt_count in (1,2)",
  "postgresCode'='23505'",
  "prior_plan.extraction_plan_id",
  "primary-message-model-drain-v1:parents-v12-39d43130",
  "productionPublicationAttempted',false",
], "message-model modality identity retry");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(modalityIdentityRetry),
  "modality identity retry must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(modalityIdentityRetry),
  "modality identity retry must not change model budgets");

includesAll(modalityLeaseRetry, [
  "truth_gmail_model_modality_lease_retries",
  "LEASE_CLEARED_PRIOR_FAILURE_DETAIL",
  "job.state='retry_wait' and job.attempt_count=2",
  "postgresCode'='42501'",
  "model-modality retry parent token refused",
  "job.attempt_count in (1,2,3)",
  "job.attempt_count=3",
  "productionPublicationAttempted',false",
], "message-model modality lease retry");
assert.ok(!/job\.attempt_count\s*=\s*4/.test(modalityLeaseRetry),
  "modality lease retry must refuse attempt four");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(modalityLeaseRetry),
  "modality lease retry must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(modalityLeaseRetry),
  "modality lease retry must not change model budgets");

includesAll(resultHashParity, [
  "record_gmail_model_extraction_result",
  "v_old text := 'private.truth_canonical_json_text(v_outcome.normalized_result)'",
  "v_installed_parenthesized_matches",
  "v_matches=1",
  "v_matches=0",
  "v_outcome.normalized_result::text",
  "truth request ledger PostgreSQL jsonb-text hash contract",
  "performs no provider call, job transition, candidate write",
], "Gmail model result hash parity");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(resultHashParity),
  "result hash parity must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(resultHashParity),
  "result hash parity must not change model budgets");

includesAll(forwardParentAuthority, [
  "truth_gmail_primary_forward_parent_authorizations",
  "route_truth_gmail_primary_forward_parent_authorization_v1",
  "ORDINARY_PRIMARY_FORWARD_COMMISSIONING",
  "primary-message-model-drain-v1:parents-v13-36b25f2b",
  "seal_gmail_primary_commissioned_model_extraction_plan_v10",
  "job.attempt_count=1",
  "primary forward parent token refused",
  "truth_gmail_child_input_pre_forward_v1",
  "gmail-claim-extraction-prompt-v4",
  "gmail-model-candidate-claims-v4",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
], "ordinary primary forward-parent authority");
assert.ok(!forwardParentAuthority.includes("bc641100-9cd9-4f77-aa13-2fa139b7044f"),
  "ordinary forward authority must not hard-code Virginia's batch");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(forwardParentAuthority),
  "ordinary forward authority must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(forwardParentAuthority),
  "ordinary forward authority must not change model budgets");

includesAll(forwardModelChildClaim, [
  "claim_truth_gmail_primary_forward_model_children",
  "truth_gmail_primary_forward_parent_authorizations",
  "lineage.root_batch_id=p_root_batch_id",
  "primary-message-model-drain:claims:",
  "primary-message-model-drain-v1:claims-v2",
  "truth_gmail_live_message_model_job_allowed_v1",
  "truth_gmail_live_model_child_worker_allowed_v1",
  "for update of job skip locked",
  "candidateClaimsAutoAccepted",
  "productionPublicationAttempted",
], "ordinary primary forward model-child claim route");
assert.ok(!/\b(accept|insert)\s+into\s+public\.(accepted_claim|truth_publication|truth_build|truth_shadow_root_source_cut)/i.test(forwardModelChildClaim),
  "ordinary forward model-child claim route must not accept claims, build, cut, or publish truth");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(forwardModelChildClaim),
  "ordinary forward model-child claim route must not change model budgets");

includesAll(forwardReviewRead, [
  "read_truth_gmail_primary_forward_candidate_reviews",
  "from public.source_processing_job_lineage job_lineage",
  "truth_gmail_primary_forward_parent_authorizations",
  "job_lineage.root_batch_id=p_root_batch_id",
  "candidate_claim_job_manifests",
  "targetItemHash",
  "previousDecisionVersionId",
  "valid_truth_review_token",
  "valid_truth_sync_token",
  "productionPublicationAttempted",
], "ordinary primary forward candidate-review read");
assert.ok(!/\b(insert|update|delete)\s+(into|public\.)/i.test(forwardReviewRead),
  "ordinary forward candidate-review read migration must not mutate public data");
assert.ok(!/truth_model_workspace_accounts|update\s+public\.truth_model_workspace/i.test(forwardReviewRead),
  "ordinary forward candidate-review read must not change model budgets");

includesAll(minimalReasoningWire, [
  "private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)",
  '"reasoning":{"effort":"minimal"}',
  '"max_output_tokens":8192',
  "gmail-claim-extraction-prompt-v4",
  "gmail-model-candidate-claims-v4",
  "minimal-reasoning Gmail model wire rewrite is incomplete",
], "minimal-reasoning Gmail model wire");
assert.ok(!/\b(insert|update|delete)\s+(into|public\.)/i.test(minimalReasoningWire),
  "minimal-reasoning wire migration must not mutate production data");
assert.ok(!/accepted_claim|truth_publication|truth_build|source_processing_jobs|truth_model_workspace_accounts/i.test(minimalReasoningWire),
  "minimal-reasoning wire migration must not retry, accept, build, publish, or change budgets");

includesAll(driver, [
  'const CONNECTION = "primary"',
  '"prepare"', '"schema-retry-authorize"', '"parents"', '"review-export"', '"review-apply"', '"claims"',
  "PQ_TRUTH_REVIEW_TOKEN", "PQ_TRUTH_MODEL_RUNTIME_ENABLED",
  "createTruthGmailParentPlanningWorker", "createTruthClaimWorker",
  "primary-message-model-drain:parents:", "parents-v13-36b25f2b", "modelCallsPerformed: false",
  "seal_gmail_primary_commissioned_model_extraction_plan_v10",
  "authorize_truth_gmail_model_schema_retry_parents",
  "PQ_PRIMARY_PARENT_RUN_TOKEN", "p_run_token: parentRunToken",
  "createTruthModelExtractionWorker", "gmail_extract_message_model_claims",
  "candidateClaimsAutoAccepted: false", "productionPublicationAttempted: false",
  "--batch=", "discoverBatches", "createDrainRpc",
  "createClaimsRpc", "claim_truth_gmail_primary_forward_model_children", "p_root_batch_id",
  "createReviewReadRpc", "read_truth_gmail_primary_forward_candidate_reviews",
  "A transport timeout is outcome-unknown", "retryDelaysMs: []",
  "primary-message-model-drain:claims:", "claims-v2",
  "--batch is required for the claims phase",
], "bounded driver");
assert.ok(!/bind_candidate_claim_acceptance|append_accepted_claim|run_truth_shadow_claim_acceptance_epoch/.test(driver), "driver must not accept candidate claims");
assert.ok(!/truth_model_workspace_accounts|budget/i.test(driver), "driver must not change model budgets");

async function verifyTransportRetryContract() {
  const calls = [];
  const rpc = driverTest.createDrainRpc({
    callRpc: async (name, body, options) => {
      calls.push({ name, body, options });
      throw Object.assign(new Error("gateway timeout"), { status: 504 });
    },
  });
  const body = { p_job_id: "00000000-0000-4000-8000-000000000001" };
  await assert.rejects(
    rpc("seal_gmail_model_extraction_plan", body),
    (error) => error.status === 504,
  );
  assert.equal(calls.length, 1, "outcome-unknown plan seal must never be repeated");
  assert.deepEqual(calls[0].body, body, "plan seal must preserve the exact fenced body");
  assert.deepEqual(calls[0].options.retryDelaysMs, [], "generic nested retries must stay disabled");
  assert.equal(calls[0].options.timeoutMs, 300_000);

  let claimCalls = 0;
  const nonIdempotentRpc = driverTest.createDrainRpc({
    callRpc: async () => {
      claimCalls += 1;
      throw Object.assign(new Error("gateway timeout"), { status: 504 });
    },
  });
  await assert.rejects(
    nonIdempotentRpc("claim_source_processing_jobs", {}),
    (error) => error.status === 504,
  );
  assert.equal(claimCalls, 1, "outcome-unknown claim RPC must never be repeated");

  const scopedCalls = [];
  const rootBatchId = "00000000-0000-4000-8000-000000000002";
  const scopedRpc = driverTest.createClaimsRpc(rootBatchId, {
    callRpc: async (name, rpcBody, options) => {
      scopedCalls.push({ name, body: rpcBody, options });
      return { ok: true };
    },
  });
  await scopedRpc("claim_source_processing_jobs", body);
  await scopedRpc("renew_source_processing_job_lease", body);
  assert.equal(scopedCalls[0].name, driverTest.PRIMARY_FORWARD_CHILD_CLAIM_RPC);
  assert.deepEqual(scopedCalls[0].body, { ...body, p_root_batch_id: rootBatchId });
  assert.equal(scopedCalls[1].name, "renew_source_processing_job_lease");
  assert.deepEqual(scopedCalls[1].body, body, "downstream fenced writes must remain canonical");
  assert.deepEqual(scopedCalls[0].options.retryDelaysMs, [], "dedicated claims must remain single-attempt");

  const reviewCalls = [];
  const reviewRpc = driverTest.createReviewReadRpc({
    callRpc: async (name, rpcBody, options) => {
      reviewCalls.push({ name, body: rpcBody, options });
      return { ok: true };
    },
  });
  await reviewRpc("read_truth_shadow_model_commissioning_reviews", body);
  assert.equal(reviewCalls[0].name, driverTest.PRIMARY_FORWARD_REVIEW_READ_RPC);
  assert.deepEqual(reviewCalls[0].body, body);
  assert.deepEqual(reviewCalls[0].options.retryDelaysMs, [], "review read must remain single-attempt");

  let deterministicCalls = 0;
  const deterministicFailureRpc = driverTest.createDrainRpc({
    callRpc: async () => {
      deterministicCalls += 1;
      throw Object.assign(new Error("duplicate plan"), { status: 409, code: "23505" });
    },
  });
  await assert.rejects(
    deterministicFailureRpc("seal_gmail_model_extraction_plan", {}),
    (error) => error.code === "23505",
  );
  assert.equal(deterministicCalls, 1, "deterministic plan conflict must not be retried");
}

async function main() {
  await verifyTransportRetryContract();
  console.log(JSON.stringify({
    ok: true,
    checks: 120,
    authority: "primary receipt-certified forward Gmail message model",
    shadowBehaviorUnchanged: true,
    tokenChecksPreserved: true,
    acceptedClaimWrites: 0,
    publicationWrites: 0,
    budgetWrites: 0,
    fixtureMode: "offline-static-reviewed-migration",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
