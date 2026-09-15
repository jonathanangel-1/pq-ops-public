-- Read-only production plan pack for the shadow Gmail model commissioning wall.
-- Run each numbered transaction separately and retain the complete plan text.
-- Every locking probe rolls back.  This file never calls the mutating prepare RPC.

-- 0. Installed authority, live state, scope cardinalities, and legacy coordinate proof.
select current_setting('server_version') as server_version,
       current_setting('jit') as jit,
       current_setting('plan_cache_mode') as plan_cache_mode;

select
  p.oid::regprocedure as signature,
  p.proconfig,
  position(
    'unresolved_gmail_attachment_extractions(p_workspace_key)'
    in pg_get_functiondef(p.oid)
  ) > 0 as calls_workspace_attachment_reader,
  position(
    'select_truth_shadow_gmail_attachment_commissioning_v1('
    in pg_get_functiondef(p.oid)
  ) > 0 as calls_exact_attachment_selector,
  position(
    'select_truth_shadow_gmail_model_commissioning_obligation_heads_v1('
    in pg_get_functiondef(p.oid)
  ) > 0 as calls_root_message_head,
  position(
    'stored commissioning replay failed final integrity read-back'
    in pg_get_functiondef(p.oid)
  ) > 0 as revalidates_all_prior_replays
from pg_proc p
where p.oid =
  'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'::regprocedure;

select job_kind, state, count(*)::bigint as job_count
from public.source_processing_jobs job
join public.source_processing_job_lineage lineage
  on lineage.workspace_key = job.workspace_key
 and lineage.source_system = job.source_system
 and lineage.connection_key = job.connection_key
 and lineage.job_id = job.job_id
where job.workspace_key = 'primary'
  and job.source_system = 'gmail'
  and job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and lineage.root_batch_id =
    'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
group by job_kind, state
order by job_kind, state;

select
  count(*)::bigint as replay_count,
  coalesce(sum(octet_length(replay.canonical_replay::text)), 0)::bigint
    as canonical_replay_bytes,
  coalesce(sum(octet_length(replay.canonical_receipt::text)), 0)::bigint
    as canonical_receipt_bytes
from public.truth_shadow_gmail_model_commissioning_replays replay
where replay.workspace_key = 'primary'
  and replay.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and replay.root_batch_id =
    'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;

with attachment_targets as materialized (
  select
    review_job.job_id as review_job_id,
    parent_job.job_id as parent_job_id,
    parent_job.observation_id as parent_observation_id,
    parent_job.source_object_id as parent_attachment_id,
    parent_job.payload #>> '{rawObject,hash}' as parent_raw_sha256,
    observation.normalized_payload->>'parentObservationId'
      as expected_parent_observation_id,
    observation.normalized_payload->>'attachmentId'
      as expected_attachment_id,
    observation.normalized_payload->>'rawSha256'
      as expected_raw_sha256
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  join public.source_processing_jobs parent_job
    on parent_job.workspace_key = review_job.workspace_key
   and parent_job.job_id = review_lineage.parent_job_id
  join public.source_observations observation
    on observation.workspace_key = review_job.workspace_key
   and observation.observation_id = review_job.observation_id
  where review_job.workspace_key = 'primary'
    and review_job.source_system = 'gmail'
    and review_job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_lineage.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
)
select
  count(*)::bigint as target_count,
  count(*) filter (
    where parent_observation_id = expected_parent_observation_id
      and parent_attachment_id = expected_attachment_id
      and parent_raw_sha256 = expected_raw_sha256
  )::bigint as production_coordinate_match_count,
  count(*) filter (
    where parent_observation_id is distinct from expected_parent_observation_id
       or parent_attachment_id is distinct from expected_attachment_id
       or parent_raw_sha256 is distinct from expected_raw_sha256
  )::bigint as legacy_coordinate_mismatch_count
from attachment_targets;

-- 1. Installed attachment selector.  With all 175 jobs already queued this
-- must return zero quickly; a slow result here identifies definition drift.
begin;
set local statement_timeout = '10min';
set local lock_timeout = '5s';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
select candidate.job_id
from public.source_ingest_batches batch
cross join lateral private.select_truth_shadow_gmail_attachment_commissioning_v1(
  'primary',
  'shadow-current-awbs-20260710-c475a8ca',
  'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid,
  batch.committed_cursor_version,
  batch.committed_cursor_value,
  20
) candidate
where batch.workspace_key = 'primary'
  and batch.source_system = 'gmail'
  and batch.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and batch.batch_id = 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  and batch.status = 'committed';

rollback;

-- 2. Twenty exact attachment witnesses using queued or waiting targets.  This
-- is the load/create/complete shared hot path and should be sub-second total.
begin;
set local statement_timeout = '10min';
set local lock_timeout = '5s';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
with candidates as materialized (
  select review_job.job_id, review_job.observation_id
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  where review_job.workspace_key = 'primary'
    and review_job.source_system = 'gmail'
    and review_job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.state in ('waiting_runtime', 'queued', 'retry_wait')
    and review_job.attempt_count < review_job.max_attempts
    and review_lineage.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  order by review_job.created_at, review_job.job_id
  limit 20
)
select
  count(*) as candidate_count,
  count(exact_target.review_job_id) as exact_target_count
from candidates candidate
left join lateral private.unresolved_gmail_attachment_extraction_v1(
  'primary', candidate.job_id, candidate.observation_id
) exact_target
  on exact_target.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
 and exact_target.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;

rollback;

-- 3. SAFE-BOUNDED: isolate the replacement helper over one real target.
begin;
set transaction read only;
set local statement_timeout = '20s';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
with targets as materialized (
  select
    review_job.observation_id,
    observation.workspace_key,
    observation.journal_seq,
    observation.normalized_payload->>'attachmentId' as attachment_id,
    observation.normalized_payload->>'parentObservationId'
      as parent_observation_id,
    observation.normalized_payload->>'rawSha256' as raw_sha256
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  join public.source_observations observation
    on observation.workspace_key = review_job.workspace_key
   and observation.observation_id = review_job.observation_id
  where review_job.workspace_key = 'primary'
    and review_job.source_system = 'gmail'
    and review_job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_lineage.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  order by review_job.created_at, review_job.job_id
  limit 1
)
select count(*) filter (
  where private.has_newer_deterministic_gmail_attachment_replacement_v1(
    workspace_key,
    observation_id,
    journal_seq,
    attachment_id,
    parent_observation_id,
    raw_sha256
  )
) as newer_replacement_count
from targets;

rollback;

-- 4. SAFE-BOUNDED: inlined replacement access path for one real target. Before
-- 170500 it must use source_observations_gmail_attachment_replacement_idx;
-- after 170500 the private helper first uses the succeeded job-coordinate
-- index and retains this as an indexed legacy fallback.
begin;
set transaction read only;
set local statement_timeout = '20s';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
with target as materialized (
  select
    observation.workspace_key,
    observation.observation_id,
    observation.journal_seq,
    observation.normalized_payload->>'attachmentId' as attachment_id,
    observation.normalized_payload->>'parentObservationId'
      as parent_observation_id,
    observation.normalized_payload->>'rawSha256' as raw_sha256
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  join public.source_observations observation
    on observation.workspace_key = review_job.workspace_key
   and observation.observation_id = review_job.observation_id
  where review_job.workspace_key = 'primary'
    and review_job.source_system = 'gmail'
    and review_job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_lineage.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  order by review_job.created_at, review_job.job_id
  limit 1
)
select replacement.observation_id
from target
join public.source_observations replacement
  on replacement.workspace_key = target.workspace_key
 and replacement.normalized_payload->>'attachmentId' = target.attachment_id
 and replacement.normalized_payload->>'parentObservationId' =
     target.parent_observation_id
 and replacement.normalized_payload->>'rawSha256' = target.raw_sha256
 and replacement.journal_seq > target.journal_seq
 and replacement.observation_id <> target.observation_id
where replacement.source_system = 'gmail'
  and replacement.source_object_type = 'gmail_attachment_extracted'
  and replacement.normalized_payload->>'schemaVersion' =
      'gmail-attachment-extracted-v1'
  and replacement.normalized_payload->'extraction'->>'status' = 'extracted'
  and replacement.normalized_payload->'extraction'->>'provenance' =
      'deterministic'
  and coalesce(
    replacement.normalized_payload #>> '{extraction,reviewRequired}',
    'true'
  ) = 'false'
order by replacement.journal_seq, replacement.observation_id;

rollback;

-- 5. SAFE-BOUNDED: exact current message-replay candidate branch from prepare.
-- A timeout while seeking only one row proves candidate discovery is the wall.
begin;
set local statement_timeout = '20s';
set local lock_timeout = '5s';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
with batch as materialized (
  select committed_cursor_version, committed_cursor_value
  from public.source_ingest_batches
  where workspace_key = 'primary'
    and source_system = 'gmail'
    and connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and batch_id = 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
    and status = 'committed'
)
select
  obligation.obligation_id,
  obligation.obligation_hash,
  obligation.review_job_id,
  plan.extraction_plan_id,
  plan.extraction_plan_hash,
  plan.plan_seal_hash,
  plan.source_observation_id,
  plan.source_observation_content_hash,
  parent_job.job_id as parent_job_id,
  parent_job.source_object_id,
  parent_job.max_attempts,
  parent_job.payload as parent_payload,
  lineage.parent_job_id as original_parent_job_id,
  lineage.root_job_id,
  lineage.source_cursor_version,
  lineage.source_cursor_value
from public.gmail_model_extraction_review_obligations obligation
join public.gmail_model_extraction_plans plan
  on plan.workspace_key = obligation.workspace_key
 and plan.extraction_plan_id = obligation.extraction_plan_id
join public.source_processing_jobs parent_job
  on parent_job.workspace_key = obligation.workspace_key
 and parent_job.job_id = plan.parent_job_id
join public.source_processing_job_lineage lineage
  on lineage.workspace_key = obligation.workspace_key
 and lineage.job_id = parent_job.job_id
join public.source_processing_jobs review_job
  on review_job.workspace_key = obligation.workspace_key
 and review_job.job_id = obligation.review_job_id
join public.source_processing_job_lineage review_lineage
  on review_lineage.workspace_key = obligation.workspace_key
 and review_lineage.job_id = review_job.job_id
join public.source_processing_job_children review_child
  on review_child.parent_job_id = parent_job.job_id
 and review_child.child_job_id = review_job.job_id
join public.source_observations observation
  on observation.workspace_key = obligation.workspace_key
 and observation.observation_id = plan.source_observation_id
join public.candidate_claim_job_manifests manifest
  on manifest.workspace_key = obligation.workspace_key
 and manifest.job_id = parent_job.job_id
cross join batch
where obligation.workspace_key = 'primary'
  and parent_job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and lineage.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  and obligation.reason_code = 'MODEL_RUNTIME_DISABLED'
  and obligation.model_plan_id is null
  and obligation.model_child_job_id is null
  and obligation.obligation_hash = encode(extensions.digest(convert_to(
    obligation.canonical_obligation::text, 'UTF8'
  ), 'sha256'), 'hex')
  and plan.planning_status = 'review_required'
  and plan.planning_failure_code = 'MODEL_RUNTIME_DISABLED'
  and plan.model_plan_id is null
  and plan.model_plan_hash is null
  and plan.model_plan is null
  and plan.execution_mode = 'none'
  and plan.deterministic_candidate_count = 0
  and plan.plan_seal_hash = encode(extensions.digest(convert_to(
    plan.canonical_plan_seal::text, 'UTF8'
  ), 'sha256'), 'hex')
  and parent_job.source_system = 'gmail'
  and parent_job.job_kind = 'gmail_extract_message_claims'
  and parent_job.observation_id = plan.source_observation_id
  and parent_job.state = 'succeeded'
  and parent_job.completed_at is not null
  and parent_job.result #>> '{truthPlan,extractionPlanId}' =
      plan.extraction_plan_id
  and parent_job.result #>> '{truthPlan,planningStatus}' = 'review_required'
  and parent_job.result #>> '{truthPlan,planningFailureCode}' =
      'MODEL_RUNTIME_DISABLED'
  and lineage.parent_job_id is not null
  and lineage.source_cursor_version = batch.committed_cursor_version
  and lineage.source_cursor_value = batch.committed_cursor_value
  and review_job.job_kind = 'gmail_review_model_extraction'
  and review_job.observation_id = plan.source_observation_id
  and review_job.state = 'waiting_runtime'
  and review_job.attempt_count = 0
  and review_job.lease_owner is null
  and review_job.lease_expires_at is null
  and review_job.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
  and review_job.result = '{}'::jsonb
  and review_job.completed_at is null
  and review_job.payload->>'extractionPlanId' = plan.extraction_plan_id
  and review_lineage.root_batch_id = lineage.root_batch_id
  and review_lineage.parent_job_id = parent_job.job_id
  and review_lineage.root_job_id = lineage.root_job_id
  and review_lineage.source_cursor_version = lineage.source_cursor_version
  and review_lineage.source_cursor_value = lineage.source_cursor_value
  and observation.content_hash = plan.source_observation_content_hash
  and observation.source_system = 'gmail'
  and observation.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and observation.source_object_type = 'gmail_message_parsed'
  and observation.normalized_payload->>'schemaVersion' =
      'gmail-parsed-message-v2'
  and manifest.candidate_count = 0
  and manifest.manifest_hash = plan.deterministic_manifest_hash
  and manifest.manifest_hash = encode(extensions.digest(convert_to(
    manifest.canonical_manifest::text, 'UTF8'
  ), 'sha256'), 'hex')
  and exists (
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key = membership.workspace_key
     and pending.obligation_id = membership.obligation_id
    where membership.workspace_key = 'primary'
      and membership.source_job_id = parent_job.job_id
      and membership.candidate_count = 0
      and membership.candidate_manifest_hash = manifest.manifest_hash
      and pending.root_batch_id =
          'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  )
  and not exists (
    select 1
    from public.gmail_model_extraction_review_resolutions resolution
    where resolution.workspace_key = obligation.workspace_key
      and resolution.obligation_id = obligation.obligation_id
  )
  and not exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    where replay.workspace_key = obligation.workspace_key
      and replay.obligation_id = obligation.obligation_id
  )
order by obligation.created_at, obligation.obligation_id
limit 1
for update of review_job skip locked;

rollback;

-- 6. SAFE-BOUNDED: exact-root head added by 170500. Run after the migration. It
-- must materialize only this root's message review jobs before JSON work.
begin;
set transaction read only;
set local statement_timeout = '20s';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
select candidate.obligation_id
from public.source_ingest_batches batch
cross join lateral private.select_truth_shadow_gmail_model_commissioning_obligation_heads_v1(
  'primary',
  'shadow-current-awbs-20260710-c475a8ca',
  'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid,
  batch.committed_cursor_version,
  batch.committed_cursor_value,
  20
) candidate
where batch.workspace_key = 'primary'
  and batch.source_system = 'gmail'
  and batch.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and batch.batch_id = 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  and batch.status = 'committed';

rollback;

-- 7. SAFE-BOUNDED: one historical replay validation.  The final scope-wide
-- integrity read-back remains in prepare; 170500 decomposes each validator call
-- into PK/unique probes.  If the rolled-back run left no replay, this returns no
-- rows and cannot diagnose the old validator.
begin;
set transaction read only;
set local statement_timeout = '20s';
set local plan_cache_mode = 'force_custom_plan';
set local jit = off;

explain (analyze, buffers, verbose, settings, summary)
with target as materialized (
  select replay.workspace_key, replay.obligation_id
  from public.truth_shadow_gmail_model_commissioning_replays replay
  where replay.workspace_key = 'primary'
    and replay.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and replay.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  order by replay.replay_id
  limit 1
)
select
  target.obligation_id,
  private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
    target.workspace_key, target.obligation_id
  ) as replay_valid
from target;

rollback;

-- 8. Intentionally broad legacy reader.  Run last and only if probe 0 says
-- the installed prepare still calls it; otherwise its cost is irrelevant.
begin;
set local statement_timeout = '10min';
set local plan_cache_mode = 'force_custom_plan';

explain (analyze, buffers, verbose, settings, summary)
select count(*)
from private.unresolved_gmail_attachment_extractions('primary') unresolved
where unresolved.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
  and unresolved.root_batch_id =
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;

rollback;
