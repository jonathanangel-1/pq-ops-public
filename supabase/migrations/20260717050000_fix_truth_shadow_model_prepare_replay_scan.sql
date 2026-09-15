-- Bound the remaining replay and attachment-replacement work in shadow Gmail
-- model commissioning.
--
-- 20260717040000 made attachment activation limit-first, but the parent prepare
-- function still evaluated the complete message-obligation join before LIMIT
-- and revalidated every immutable replay at the end of every call.  On a real
-- mailbox those integrity predicates repeatedly canonicalize JSON and can make
-- an otherwise terminal prepare call CPU-bound.  This forward repair selects
-- an exact-root obligation head before the expensive integrity projection,
-- prevents replacement detection from driving off the observation journal, and
-- retains exact validation for each newly inserted replay.  The final
-- scope-wide integrity read-back remains authoritative, but its validator is
-- decomposed into bounded PK/unique probes instead of one giant join.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_prepare regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_replay_validator regprocedure := to_regprocedure(
    'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)'
  );
  v_definition text;
begin
  if v_prepare is null
    or v_replay_validator is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.select_truth_shadow_gmail_attachment_commissioning_v1(text,text,uuid,bigint,text,integer)'
    ) is null
    or to_regprocedure(
      'private.has_newer_deterministic_gmail_attachment_replacement_v1(text,text,bigint,text,text,text)'
    ) is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass(
      'public.source_observations_gmail_attachment_replacement_idx'
    ) is null then
    raise exception 'bounded shadow Gmail replay-prepare prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_prepare)) into v_definition;
  if position('pg_try_advisory_xact_lock' in v_definition) = 0
    or position(
      'select_truth_shadow_gmail_attachment_commissioning_v1(' in v_definition
    ) = 0
    or position('productionpublicationattempted'', false' in v_definition) = 0
    or (
      position(
        'select_truth_shadow_gmail_model_commissioning_obligation_heads_v1('
        in v_definition
      ) = 0
      and (
        position('for v_candidate in' in v_definition) = 0
        or position(
          'stored commissioning replay failed final integrity read-back'
          in v_definition
        ) = 0
      )
    ) then
    raise exception 'shadow Gmail prepare authority differs from its reviewed predecessor'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_replay_validator)) into v_definition;
  if position(
      'truth_shadow_gmail_model_commissioning_replays replay' in v_definition
    ) = 0
    or position('truth_required_sources required_source' in v_definition) = 0
    or position('gmail_model_extraction_review_resolutions resolution' in v_definition) = 0 then
    raise exception 'shadow Gmail replay validator differs from its reviewed predecessor'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- The head query enters through unresolved runtime-disabled review jobs and
-- immutable root lineage.  Its partial predicate matches the exact parked-job
-- state and contains every column needed before the PK joins.
create index if not exists source_processing_jobs_shadow_model_review_prepare_idx
  on public.source_processing_jobs (
    workspace_key, connection_key, created_at, job_id
  )
  include (observation_id, source_object_id, max_attempts)
  where source_system = 'gmail'
    and job_kind = 'gmail_review_model_extraction'
    and state = 'waiting_runtime'
    and attempt_count = 0
    and lease_owner is null
    and lease_expires_at is null
    and completed_at is null
    and last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
    and result = '{}'::jsonb;

create index if not exists source_processing_job_lineage_shadow_cursor_root_idx
  on public.source_processing_job_lineage (
    workspace_key, source_system, connection_key, root_batch_id,
    source_cursor_version, source_cursor_value, job_id
  )
  include (parent_job_id, root_job_id);

-- A later deterministic attachment replacement is produced by one succeeded
-- gmail_extract_attachment parent.  Enter through the immutable attachment
-- coordinate carried by that job before fetching its output observation by
-- primary key.  The observation journal remains a semantics-preserving
-- fallback for legacy parents whose payload predates this coordinate shape.
create index if not exists source_processing_jobs_succeeded_attachment_coordinate_idx
  on public.source_processing_jobs (
    workspace_key,
    observation_id,
    source_object_id,
    ((payload #>> '{rawObject,hash}')),
    job_id
  )
  include (connection_key)
  where source_system = 'gmail'
    and job_kind = 'gmail_extract_attachment'
    and state = 'succeeded';

-- The predecessor ordered all runtime-disabled obligations workspace-wide and
-- discovered the exact root only after several joins and JSON hash checks.
-- review_job_id is the immutable bridge from the bounded root-job head.
create index if not exists gmail_model_review_obligations_review_job_commissioning_idx
  on public.gmail_model_extraction_review_obligations (
    workspace_key, review_job_id
  )
  include (
    created_at, obligation_id, extraction_plan_id, obligation_hash
  )
  where reason_code = 'MODEL_RUNTIME_DISABLED'
    and model_plan_id is null
    and model_child_job_id is null;

-- The source-observation expression index added in 20260717040000 is exact,
-- but a SQL anti-join can still be reordered so the 219K-row journal becomes
-- the driving relation.  PL/pgSQL creates a hard executor boundary: first
-- probe production-shaped succeeded parent coordinates, then fetch outputs by
-- observation PK and re-prove every old predicate.  The second loop preserves
-- the predecessor's complete semantics for legacy jobs while function-local
-- enable_seqscan=off forces the reviewed expression index for that fallback.
create or replace function private.has_newer_deterministic_gmail_attachment_replacement_v1(
  p_workspace_key text,
  p_attachment_observation_id text,
  p_journal_seq bigint,
  p_attachment_id text,
  p_parent_observation_id text,
  p_raw_sha256 text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
set jit = 'off'
set enable_seqscan = 'off'
as $function$
declare
  v_candidate record;
begin
  if p_workspace_key is null
    or p_attachment_observation_id is null
    or p_journal_seq is null
    or p_attachment_id is null
    or p_parent_observation_id is null
    or p_raw_sha256 is null then
    return false;
  end if;

  for v_candidate in
    select
      replacement_output.observation_id,
      replacement_job.job_id
    from public.source_processing_jobs replacement_job
    join public.source_processing_job_observations replacement_output
      on replacement_output.job_id = replacement_job.job_id
    where replacement_job.workspace_key = p_workspace_key
      and replacement_job.source_system = 'gmail'
      and replacement_job.job_kind = 'gmail_extract_attachment'
      and replacement_job.state = 'succeeded'
      and replacement_job.observation_id = p_parent_observation_id
      and replacement_job.source_object_id = p_attachment_id
      and replacement_job.payload #>> '{rawObject,hash}' = p_raw_sha256
    order by replacement_job.job_id, replacement_output.ordinal
  loop
    if exists (
      select 1
      from public.source_observations replacement
      where replacement.workspace_key = p_workspace_key
        and replacement.observation_id = v_candidate.observation_id
        and replacement.source_system = 'gmail'
        and replacement.source_object_type = 'gmail_attachment_extracted'
        and replacement.observation_id <> p_attachment_observation_id
        and replacement.journal_seq > p_journal_seq
        and replacement.normalized_payload->>'schemaVersion' =
          'gmail-attachment-extracted-v1'
        and replacement.normalized_payload->>'attachmentId' = p_attachment_id
        and replacement.normalized_payload->>'parentObservationId' =
          p_parent_observation_id
        and replacement.normalized_payload->>'rawSha256' = p_raw_sha256
        and replacement.normalized_payload->'extraction'->>'status' = 'extracted'
        and replacement.normalized_payload->'extraction'->>'provenance' =
          'deterministic'
        and coalesce(
          replacement.normalized_payload #>> '{extraction,reviewRequired}',
          'true'
        ) = 'false'
        and exists (
          select 1
          from public.source_processing_job_children replacement_child_link
          join public.source_processing_jobs replacement_child
            on replacement_child.job_id = replacement_child_link.child_job_id
           and replacement_child.job_kind = 'gmail_extract_attachment_claims'
           and replacement_child.observation_id = replacement.observation_id
          where replacement_child_link.parent_job_id = v_candidate.job_id
        )
    ) then
      return true;
    end if;
  end loop;

  -- Legacy-preserving fallback.  This is not allowed to drive from the full
  -- journal: the exact expression index is present and seq scans are disabled
  -- only for this private helper.
  for v_candidate in
    select
      replacement.observation_id,
      replacement.workspace_key,
      replacement.source_system,
      replacement.connection_key
    from public.source_observations replacement
    where replacement.workspace_key = p_workspace_key
      and replacement.source_system = 'gmail'
      and replacement.source_object_type = 'gmail_attachment_extracted'
      and replacement.observation_id <> p_attachment_observation_id
      and replacement.journal_seq > p_journal_seq
      and replacement.normalized_payload->>'schemaVersion' =
        'gmail-attachment-extracted-v1'
      and replacement.normalized_payload->>'attachmentId' = p_attachment_id
      and replacement.normalized_payload->>'parentObservationId' =
        p_parent_observation_id
      and replacement.normalized_payload->>'rawSha256' = p_raw_sha256
      and replacement.normalized_payload->'extraction'->>'status' = 'extracted'
      and replacement.normalized_payload->'extraction'->>'provenance' =
        'deterministic'
      and coalesce(
        replacement.normalized_payload #>> '{extraction,reviewRequired}',
        'true'
      ) = 'false'
    order by replacement.journal_seq, replacement.observation_id
  loop
    if exists (
      select 1
      from public.source_processing_job_observations replacement_output
      join public.source_processing_jobs replacement_job
        on replacement_job.job_id = replacement_output.job_id
       and replacement_job.workspace_key = v_candidate.workspace_key
       and replacement_job.source_system = v_candidate.source_system
       and replacement_job.connection_key = v_candidate.connection_key
       and replacement_job.job_kind = 'gmail_extract_attachment'
       and replacement_job.state = 'succeeded'
      where replacement_output.observation_id = v_candidate.observation_id
        and exists (
          select 1
          from public.source_processing_job_children replacement_child_link
          join public.source_processing_jobs replacement_child
            on replacement_child.job_id = replacement_child_link.child_job_id
           and replacement_child.job_kind = 'gmail_extract_attachment_claims'
           and replacement_child.observation_id = v_candidate.observation_id
          where replacement_child_link.parent_job_id = replacement_job.job_id
        )
    ) then
      return true;
    end if;
  end loop;

  return false;
end;
$function$;

revoke all on function private.has_newer_deterministic_gmail_attachment_replacement_v1(
  text, text, bigint, text, text, text
) from public, anon, authenticated, service_role;

-- The predecessor replay proof was one large SQL expression containing every
-- join and canonical hash.  Its logical keys are exact, but PostgreSQL 17 can
-- still spend pathological CPU planning/JIT-compiling that expression once
-- per prepared replay.  Preserve every predicate while splitting the proof
-- into PK/unique-key statements behind a PL/pgSQL executor boundary.
create or replace function private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
  p_workspace_key text,
  p_obligation_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
set jit = 'off'
as $function$
declare
  v_replay public.truth_shadow_gmail_model_commissioning_replays%rowtype;
  v_scope public.truth_shadow_gmail_model_commissioning_scopes%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_obligation public.gmail_model_extraction_review_obligations%rowtype;
  v_plan public.gmail_model_extraction_plans%rowtype;
  v_prior_parent public.source_processing_jobs%rowtype;
  v_prior_lineage public.source_processing_job_lineage%rowtype;
  v_review_job public.source_processing_jobs%rowtype;
  v_review_lineage public.source_processing_job_lineage%rowtype;
  v_successor public.source_processing_jobs%rowtype;
  v_successor_lineage public.source_processing_job_lineage%rowtype;
  v_observation public.source_observations%rowtype;
begin
  select replay.* into v_replay
  from public.truth_shadow_gmail_model_commissioning_replays replay
  where replay.workspace_key = p_workspace_key
    and replay.obligation_id = p_obligation_id;
  if not found
    or not v_replay.shadow_only
    or v_replay.production_eligible
    or v_replay.production_publication_attempted
    or v_replay.replay_id is distinct from
      'truth-shadow-gmail-model-replay:v1:' || v_replay.replay_hash
    or v_replay.replay_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_replay.canonical_replay), 'UTF8'
    ), 'sha256'), 'hex')
    or v_replay.successor_payload_hash is distinct from encode(
      extensions.digest(convert_to(
        private.truth_canonical_json_text(v_replay.successor_payload), 'UTF8'
      ), 'sha256'), 'hex'
    )
    or v_replay.supersession_hash is distinct from encode(
      extensions.digest(convert_to(
        private.truth_canonical_json_text(v_replay.canonical_supersession), 'UTF8'
      ), 'sha256'), 'hex'
    )
    or v_replay.receipt_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_replay.canonical_receipt), 'UTF8'
    ), 'sha256'), 'hex') then
    return false;
  end if;

  select scope_row.* into v_scope
  from public.truth_shadow_gmail_model_commissioning_scopes scope_row
  where scope_row.workspace_key = v_replay.workspace_key
    and scope_row.commissioning_scope_id = v_replay.commissioning_scope_id;
  if not found
    or not v_scope.shadow_only
    or v_scope.production_eligible
    or v_scope.production_publication_attempted
    or v_scope.source_system <> 'gmail'
    or v_scope.connection_key is distinct from v_replay.connection_key
    or v_scope.root_batch_id is distinct from v_replay.root_batch_id
    or v_scope.execution_mode <> 'sync'
    or v_scope.commissioning_scope_id is distinct from
      'truth-shadow-gmail-model-scope:v1:' || v_scope.scope_hash
    or v_scope.scope_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_scope.canonical_scope), 'UTF8'
    ), 'sha256'), 'hex') then
    return false;
  end if;

  select batch.* into v_batch
  from public.source_ingest_batches batch
  where batch.workspace_key = v_replay.workspace_key
    and batch.batch_id = v_replay.root_batch_id;
  if not found
    or v_batch.source_system <> 'gmail'
    or v_batch.connection_key is distinct from v_replay.connection_key
    or v_batch.mode is distinct from v_scope.root_ingest_mode
    or v_batch.mode <> all(array['backfill', 'reconciliation'])
    or v_batch.status <> 'committed'
    or v_batch.committed_cursor_version is distinct from
      v_replay.source_cursor_version
    or v_batch.committed_cursor_value is distinct from
      v_replay.source_cursor_value then
    return false;
  end if;

  select obligation.* into v_obligation
  from public.gmail_model_extraction_review_obligations obligation
  where obligation.workspace_key = v_replay.workspace_key
    and obligation.obligation_id = v_replay.obligation_id;
  if not found
    or v_obligation.extraction_plan_id is distinct from
      v_replay.prior_extraction_plan_id
    or v_obligation.review_job_id is distinct from v_replay.prior_review_job_id
    or v_obligation.reason_code <> 'MODEL_RUNTIME_DISABLED'
    or v_obligation.model_plan_id is not null
    or v_obligation.model_child_job_id is not null
    or v_obligation.obligation_hash is distinct from encode(
      extensions.digest(convert_to(
        v_obligation.canonical_obligation::text, 'UTF8'
      ), 'sha256'), 'hex'
    ) then
    return false;
  end if;
  if exists (
    select 1
    from public.gmail_model_extraction_review_resolutions resolution
    where resolution.workspace_key = v_replay.workspace_key
      and resolution.obligation_id = v_replay.obligation_id
  ) then
    return false;
  end if;

  select prior_plan.* into v_plan
  from public.gmail_model_extraction_plans prior_plan
  where prior_plan.workspace_key = v_replay.workspace_key
    and prior_plan.extraction_plan_id = v_replay.prior_extraction_plan_id;
  if not found
    or v_plan.parent_job_id is distinct from v_replay.prior_parent_job_id
    or v_plan.extraction_plan_hash is distinct from
      v_replay.prior_extraction_plan_hash
    or v_plan.plan_seal_hash is distinct from v_replay.prior_plan_seal_hash
    or v_plan.plan_seal_hash is distinct from encode(extensions.digest(convert_to(
      v_plan.canonical_plan_seal::text, 'UTF8'
    ), 'sha256'), 'hex')
    or v_plan.planning_status <> 'review_required'
    or v_plan.planning_failure_code <> 'MODEL_RUNTIME_DISABLED'
    or v_plan.model_plan_id is not null
    or v_plan.model_plan_hash is not null
    or v_plan.model_plan is not null
    or v_plan.execution_mode <> 'none'
    or v_plan.deterministic_candidate_count <> 0 then
    return false;
  end if;

  select prior_parent.* into v_prior_parent
  from public.source_processing_jobs prior_parent
  where prior_parent.workspace_key = v_replay.workspace_key
    and prior_parent.job_id = v_replay.prior_parent_job_id;
  if not found
    or v_prior_parent.source_system <> 'gmail'
    or v_prior_parent.connection_key is distinct from v_replay.connection_key
    or v_prior_parent.job_kind <> 'gmail_extract_message_claims'
    or v_prior_parent.observation_id is distinct from
      v_replay.source_observation_id
    or v_prior_parent.state <> 'succeeded'
    or v_prior_parent.result #>> '{truthPlan,extractionPlanId}' is distinct from
      v_replay.prior_extraction_plan_id
    or v_prior_parent.result #>> '{truthPlan,planningStatus}' is distinct from
      'review_required'
    or v_prior_parent.result #>> '{truthPlan,planningFailureCode}' is distinct from
      'MODEL_RUNTIME_DISABLED' then
    return false;
  end if;

  select prior_lineage.* into v_prior_lineage
  from public.source_processing_job_lineage prior_lineage
  where prior_lineage.workspace_key = v_replay.workspace_key
    and prior_lineage.job_id = v_replay.prior_parent_job_id;
  if not found
    or v_prior_lineage.root_batch_id is distinct from v_replay.root_batch_id
    or v_prior_lineage.parent_job_id is distinct from
      v_replay.original_parent_job_id
    or v_prior_lineage.root_job_id is distinct from v_replay.root_job_id
    or v_prior_lineage.source_cursor_version is distinct from
      v_replay.source_cursor_version
    or v_prior_lineage.source_cursor_value is distinct from
      v_replay.source_cursor_value then
    return false;
  end if;

  select review_job.* into v_review_job
  from public.source_processing_jobs review_job
  where review_job.workspace_key = v_replay.workspace_key
    and review_job.job_id = v_replay.prior_review_job_id;
  if not found
    or v_review_job.job_kind <> 'gmail_review_model_extraction'
    or v_review_job.observation_id is distinct from
      v_replay.source_observation_id
    or v_review_job.state <> 'superseded'
    or v_review_job.lease_owner is not null
    or v_review_job.lease_expires_at is not null
    or v_review_job.last_error_code <> 'GMAIL_MODEL_RUNTIME_COMMISSIONED'
    or v_review_job.result is distinct from v_replay.canonical_supersession
    or v_review_job.completed_at is null then
    return false;
  end if;

  select review_lineage.* into v_review_lineage
  from public.source_processing_job_lineage review_lineage
  where review_lineage.workspace_key = v_replay.workspace_key
    and review_lineage.job_id = v_replay.prior_review_job_id;
  if not found
    or v_review_lineage.root_batch_id is distinct from v_replay.root_batch_id
    or v_review_lineage.parent_job_id is distinct from
      v_replay.prior_parent_job_id
    or v_review_lineage.root_job_id is distinct from v_replay.root_job_id
    or v_review_lineage.source_cursor_version is distinct from
      v_replay.source_cursor_version
    or v_review_lineage.source_cursor_value is distinct from
      v_replay.source_cursor_value then
    return false;
  end if;
  if not exists (
    select 1
    from public.source_processing_job_children review_child
    where review_child.parent_job_id = v_replay.prior_parent_job_id
      and review_child.child_job_id = v_replay.prior_review_job_id
  ) then
    return false;
  end if;

  select successor.* into v_successor
  from public.source_processing_jobs successor
  where successor.workspace_key = v_replay.workspace_key
    and successor.job_id = v_replay.successor_parent_job_id;
  if not found
    or v_successor.dedupe_key is distinct from v_replay.successor_dedupe_key
    or v_successor.source_system <> 'gmail'
    or v_successor.connection_key is distinct from v_replay.connection_key
    or v_successor.job_kind <> 'gmail_extract_message_claims'
    or v_successor.observation_id is distinct from
      v_replay.source_observation_id
    or v_successor.source_object_id is distinct from
      v_prior_parent.source_object_id
    or v_successor.payload is distinct from v_replay.successor_payload
    or v_successor.state = 'superseded' then
    return false;
  end if;

  select successor_lineage.* into v_successor_lineage
  from public.source_processing_job_lineage successor_lineage
  where successor_lineage.workspace_key = v_replay.workspace_key
    and successor_lineage.job_id = v_replay.successor_parent_job_id;
  if not found
    or v_successor_lineage.root_batch_id is distinct from v_replay.root_batch_id
    or v_successor_lineage.parent_job_id is distinct from
      v_replay.original_parent_job_id
    or v_successor_lineage.root_job_id is distinct from v_replay.root_job_id
    or v_successor_lineage.source_cursor_version is distinct from
      v_replay.source_cursor_version
    or v_successor_lineage.source_cursor_value is distinct from
      v_replay.source_cursor_value then
    return false;
  end if;

  select observation.* into v_observation
  from public.source_observations observation
  where observation.workspace_key = v_replay.workspace_key
    and observation.observation_id = v_replay.source_observation_id;
  if not found
    or v_observation.content_hash is distinct from
      v_replay.source_observation_content_hash
    or v_observation.source_system <> 'gmail'
    or v_observation.connection_key is distinct from v_replay.connection_key
    or v_observation.source_object_type <> 'gmail_message_parsed'
    or v_observation.normalized_payload->>'schemaVersion' is distinct from
      'gmail-parsed-message-v2' then
    return false;
  end if;

  if exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key = v_replay.workspace_key
      and required_source.source_system = 'gmail'
      and required_source.connection_key = v_replay.connection_key
  ) then
    return false;
  end if;

  return true;
end;
$function$;

revoke all on function private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
  text, text
) from public, anon, authenticated, service_role;

-- Materialize the exact-root waiting review jobs before touching obligations,
-- large canonical JSON, observations, or manifests.  All predecessor
-- integrity predicates are repeated here, so LIMIT applies to valid rows and
-- cannot permanently starve a later valid obligation behind a malformed head.
-- The caller repeats the same predicates and takes the row lock before any
-- mutation; this helper only fixes access order.
create or replace function private.select_truth_shadow_gmail_model_commissioning_obligation_heads_v1(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_source_cursor_version bigint,
  p_source_cursor_value text,
  p_limit integer
)
returns table (obligation_id text)
language sql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
set jit = 'off'
as $function$
  with review_heads as materialized (
    select
      review_job.job_id as review_job_id,
      review_job.observation_id as review_observation_id,
      review_job.payload as review_payload,
      review_lineage.parent_job_id,
      review_lineage.root_job_id,
      review_lineage.source_cursor_version,
      review_lineage.source_cursor_value
    from public.source_processing_job_lineage review_lineage
    join public.source_processing_jobs review_job
      on review_job.workspace_key = review_lineage.workspace_key
     and review_job.source_system = review_lineage.source_system
     and review_job.connection_key = review_lineage.connection_key
     and review_job.job_id = review_lineage.job_id
    where review_lineage.workspace_key = p_workspace_key
      and review_lineage.source_system = 'gmail'
      and review_lineage.connection_key = p_connection_key
      and review_lineage.root_batch_id = p_root_batch_id
      and review_lineage.source_cursor_version = p_source_cursor_version
      and review_lineage.source_cursor_value = p_source_cursor_value
      and review_lineage.parent_job_id is not null
      and review_job.job_kind = 'gmail_review_model_extraction'
      and review_job.state = 'waiting_runtime'
      and review_job.attempt_count = 0
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
      and review_job.result = '{}'::jsonb
      and review_job.completed_at is null
  )
  select obligation.obligation_id
  from review_heads review_head
  join public.gmail_model_extraction_review_obligations obligation
    on obligation.workspace_key = p_workspace_key
   and obligation.review_job_id = review_head.review_job_id
  join public.gmail_model_extraction_plans plan
    on plan.workspace_key = obligation.workspace_key
   and plan.extraction_plan_id = obligation.extraction_plan_id
  join public.source_processing_jobs parent_job
    on parent_job.workspace_key = obligation.workspace_key
   and parent_job.job_id = plan.parent_job_id
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key = obligation.workspace_key
   and lineage.job_id = parent_job.job_id
  join public.source_processing_job_children review_child
    on review_child.parent_job_id = parent_job.job_id
   and review_child.child_job_id = review_head.review_job_id
  join public.source_observations observation
    on observation.workspace_key = obligation.workspace_key
   and observation.observation_id = plan.source_observation_id
  join public.candidate_claim_job_manifests manifest
    on manifest.workspace_key = obligation.workspace_key
   and manifest.job_id = parent_job.job_id
  where obligation.workspace_key = p_workspace_key
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
    and parent_job.connection_key = p_connection_key
    and parent_job.job_kind = 'gmail_extract_message_claims'
    and parent_job.observation_id = plan.source_observation_id
    and parent_job.state = 'succeeded'
    and parent_job.completed_at is not null
    and parent_job.result #>> '{truthPlan,extractionPlanId}' =
      plan.extraction_plan_id
    and parent_job.result #>> '{truthPlan,planningStatus}' = 'review_required'
    and parent_job.result #>> '{truthPlan,planningFailureCode}' =
      'MODEL_RUNTIME_DISABLED'
    and lineage.root_batch_id = p_root_batch_id
    and lineage.parent_job_id is not null
    and lineage.source_cursor_version = p_source_cursor_version
    and lineage.source_cursor_value = p_source_cursor_value
    and review_head.parent_job_id = parent_job.job_id
    and review_head.root_job_id = lineage.root_job_id
    and review_head.source_cursor_version = lineage.source_cursor_version
    and review_head.source_cursor_value = lineage.source_cursor_value
    and review_head.review_observation_id = plan.source_observation_id
    and review_head.review_payload->>'extractionPlanId' = plan.extraction_plan_id
    and observation.content_hash = plan.source_observation_content_hash
    and observation.source_system = 'gmail'
    and observation.connection_key = p_connection_key
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
      where membership.workspace_key = p_workspace_key
        and membership.source_job_id = parent_job.job_id
        and membership.candidate_count = 0
        and membership.candidate_manifest_hash = manifest.manifest_hash
        and pending.root_batch_id = p_root_batch_id
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
    and coalesce(p_limit, 0) between 1 and 50
  order by obligation.created_at, obligation.obligation_id
  limit p_limit;
$function$;

revoke all on function private.select_truth_shadow_gmail_model_commissioning_obligation_heads_v1(
  text, text, uuid, bigint, text, integer
) from public, anon, authenticated, service_role;

-- Insert the bounded head ahead of the reviewed full integrity query.  The
-- outer query keeps every original hash, manifest, observation, and lineage
-- predicate and retains its final LIMIT p_limit.
do $candidate_head_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$    from public.gmail_model_extraction_review_obligations obligation
    join public.gmail_model_extraction_plans plan$old$;
  v_new text := $new$    from private.select_truth_shadow_gmail_model_commissioning_obligation_heads_v1(
      p_workspace_key,
      p_connection_key,
      p_root_batch_id,
      v_batch.committed_cursor_version,
      v_batch.committed_cursor_value,
      p_limit
    ) obligation_head
    join public.gmail_model_extraction_review_obligations obligation
      on obligation.workspace_key = p_workspace_key
     and obligation.obligation_id = obligation_head.obligation_id
    join public.gmail_model_extraction_plans plan$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
      'select_truth_shadow_gmail_model_commissioning_obligation_heads_v1('
      in v_definition
    ) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'message commissioning head rewrite did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition
      or position(v_old in v_updated) > 0
      or position(
        'select_truth_shadow_gmail_model_commissioning_obligation_heads_v1('
        in v_updated
      ) = 0 then
      raise exception 'message commissioning head rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  end if;
end;
$candidate_head_rewrite$;

alter function private.prepare_truth_shadow_gmail_model_commissioning(
  text, text, uuid, integer, text, text
) set plan_cache_mode = 'force_custom_plan';
alter function private.prepare_truth_shadow_gmail_model_commissioning(
  text, text, uuid, integer, text, text
) set jit = 'off';
alter function public.prepare_truth_shadow_gmail_model_commissioning(
  text, text, uuid, integer, text, text
) set plan_cache_mode = 'force_custom_plan';
alter function public.prepare_truth_shadow_gmail_model_commissioning(
  text, text, uuid, integer, text, text
) set jit = 'off';
alter function private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
  text, text
) set plan_cache_mode = 'force_custom_plan';
alter function private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
  text, text
) set jit = 'off';
alter function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  text, uuid
) set plan_cache_mode = 'force_custom_plan';
alter function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  text, uuid
) set jit = 'off';
alter function private.unresolved_gmail_attachment_extraction_v1(
  text, uuid, text
) set plan_cache_mode = 'force_custom_plan';
alter function private.unresolved_gmail_attachment_extraction_v1(
  text, uuid, text
) set jit = 'off';
alter function private.select_truth_shadow_gmail_attachment_commissioning_v1(
  text, text, uuid, bigint, text, integer
) set plan_cache_mode = 'force_custom_plan';
alter function private.select_truth_shadow_gmail_attachment_commissioning_v1(
  text, text, uuid, bigint, text, integer
) set jit = 'off';
alter function private.load_truth_gmail_attachment_model_context(
  text, uuid, text, bigint, text, text
) set jit = 'off';
alter function private.complete_truth_gmail_attachment_model_extraction(
  text, uuid, text, bigint, text, text, text, text, text, text
) set jit = 'off';

analyze public.source_processing_jobs;
analyze public.source_processing_job_lineage;
analyze public.gmail_model_extraction_review_obligations;
analyze public.gmail_model_extraction_plans;
analyze public.truth_shadow_gmail_model_commissioning_replays;

do $verify$
declare
  v_prepare regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_head regprocedure := to_regprocedure(
    'private.select_truth_shadow_gmail_model_commissioning_obligation_heads_v1(text,text,uuid,bigint,text,integer)'
  );
  v_replacement regprocedure := to_regprocedure(
    'private.has_newer_deterministic_gmail_attachment_replacement_v1(text,text,bigint,text,text,text)'
  );
  v_replay_validator regprocedure := to_regprocedure(
    'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)'
  );
  v_definition text;
  v_config text[];
begin
  if v_prepare is null or v_head is null or v_replacement is null
    or v_replay_validator is null then
    raise exception 'bounded shadow Gmail replay prepare functions are unavailable'
      using errcode = '23514';
  end if;

  if not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_jobs_shadow_model_review_prepare_idx'
        and lower(indexdef) like '%gmail_review_model_extraction%'
        and lower(indexdef) like '%gmail_model_runtime_disabled%'
    )
    or not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_job_lineage_shadow_cursor_root_idx'
        and lower(indexdef) like '%root_batch_id%source_cursor_version%source_cursor_value%'
    )
    or not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_jobs_succeeded_attachment_coordinate_idx'
        and lower(indexdef) like '%rawobject%hash%'
        and lower(indexdef) like '%gmail_extract_attachment%'
        and lower(indexdef) like '%state = ''succeeded''%'
    )
    or not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'gmail_model_review_obligations_review_job_commissioning_idx'
        and lower(indexdef) like '%review_job_id%'
        and lower(indexdef) like '%model_runtime_disabled%'
    ) then
    raise exception 'bounded message commissioning access paths are missing'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_prepare)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_prepare;
  if position(
      'select_truth_shadow_gmail_model_commissioning_obligation_heads_v1('
      in v_definition
    ) = 0
    or position(
      'stored commissioning replay failed final integrity read-back'
      in v_definition
    ) = 0
    or position(
      'truth_shadow_gmail_model_commissioning_parent_allowed_v1('
      in v_definition
    ) = 0
    or position(
      'select_truth_shadow_gmail_attachment_commissioning_v1('
      in v_definition
    ) = 0
    or position('productionpublicationattempted'', false' in v_definition) = 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    ))
    or not ('jit=off' = any(coalesce(v_config, array[]::text[]))) then
    raise exception 'shadow Gmail prepare remains unbounded or escaped shadow authority'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_head)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_head;
  if position('review_heads as materialized' in v_definition) = 0
    or position(
      'review_lineage.root_batch_id = p_root_batch_id'
      in v_definition
    ) = 0
    or position('obligation.canonical_obligation::text' in v_definition) = 0
    or position('manifest.canonical_manifest::text' in v_definition) = 0
    or position('limit p_limit' in v_definition) = 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    ))
    or not ('jit=off' = any(coalesce(v_config, array[]::text[]))) then
    raise exception 'message commissioning head is not bounded before observation work'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_replacement)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_replacement;
  if position('language plpgsql' in v_definition) = 0
    or position(
      'source_processing_jobs replacement_job' in v_definition
    ) = 0
    or position(
      'replacement_job.payload #>> ''{rawobject,hash}'' = p_raw_sha256'
      in v_definition
    ) = 0
    or position('legacy-preserving fallback' in v_definition) = 0
    or position(
      'replacement.normalized_payload->>''attachmentid'' = p_attachment_id'
      in v_definition
    ) = 0
    or position(
      'replacement_child.job_kind = ''gmail_extract_attachment_claims'''
      in v_definition
    ) = 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    ))
    or not ('jit=off' = any(coalesce(v_config, array[]::text[])))
    or not ('enable_seqscan=off' = any(coalesce(v_config, array[]::text[]))) then
    raise exception 'attachment replacement witness remains mailbox-driven'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_replay_validator)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_replay_validator;
  if position('language plpgsql' in v_definition) = 0
    or position('select replay.* into v_replay' in v_definition) = 0
    or position('select observation.* into v_observation' in v_definition) = 0
    or position('observation.observation_id = v_replay.source_observation_id'
      in v_definition) = 0
    or position('truth_required_sources required_source' in v_definition) = 0
    or position('gmail_model_extraction_review_resolutions resolution'
      in v_definition) = 0
    or position('return true' in v_definition) = 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    ))
    or not ('jit=off' = any(coalesce(v_config, array[]::text[]))) then
    raise exception 'shadow Gmail replay validator is not point-decomposed'
      using errcode = '23514';
  end if;
end;
$verify$;
