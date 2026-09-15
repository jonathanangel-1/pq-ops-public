-- Bound shadow Gmail model commissioning by its requested batch size.
--
-- The predecessor called the workspace-wide unresolved-attachment inventory
-- from prepare, per-job context loading, and finalization.  Its newer-
-- replacement anti-join had no attachment-coordinate index, so one exact
-- shadow root could repeatedly scan the complete mailbox observation journal.
-- This forward repair keeps the broad inventory intact for source-cut
-- completeness, adds an exact review-target witness for execution, and moves
-- attachment activation behind the bounded message-replay selection.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_prepare regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_load regprocedure := to_regprocedure(
    'private.load_truth_gmail_attachment_model_context(text,uuid,text,bigint,text,text)'
  );
  v_complete regprocedure := to_regprocedure(
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'
  );
  v_definition text;
begin
  if v_prepare is null or v_load is null or v_complete is null
    or to_regprocedure('private.unresolved_gmail_attachment_extractions(text)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_processing_job_observations') is null
    or to_regclass('public.source_processing_job_children') is null
    or to_regclass('public.source_observations') is null
    or to_regclass('public.gmail_attachment_extraction_resolutions') is null
    or to_regclass('public.gmail_attachment_model_attempt_dispatches') is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null then
    raise exception 'shadow Gmail model prepare-plan prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(v_prepare) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('truth-shadow-gmail-model-commissioning-v1:' in v_definition) = 0
    or position('productionPublicationAttempted' in v_definition) = 0
    or (
      position('for update of review_job skip locked' in lower(v_definition)) = 0
      and position(
        'select_truth_shadow_gmail_attachment_commissioning_v1(' in lower(v_definition)
      ) = 0
    ) then
    raise exception 'shadow Gmail model prepare authority differs from its reviewed predecessor'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(v_load) into v_definition;
  if position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) = 0
    and position('unresolved_gmail_attachment_extraction_v1(' in v_definition) = 0 then
    raise exception 'attachment model context authority differs from its reviewed predecessor'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(v_complete) into v_definition;
  if position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) = 0
    and position('unresolved_gmail_attachment_extraction_v1(' in v_definition) = 0 then
    raise exception 'attachment model completion authority differs from its reviewed predecessor'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- Ordered waiting-runtime acquisition stops at the caller budget instead of
-- discovering every attachment review row before LIMIT can apply.
create index if not exists source_processing_jobs_shadow_attachment_prepare_idx
  on public.source_processing_jobs (
    workspace_key, connection_key, created_at, job_id
  )
  include (observation_id, attempt_count, max_attempts)
  where source_system = 'gmail'
    and job_kind = 'gmail_review_attachment_extraction'
    and state = 'waiting_runtime'
    and lease_owner is null
    and lease_expires_at is null
    and completed_at is null;

create index if not exists source_processing_job_lineage_shadow_root_idx
  on public.source_processing_job_lineage (
    workspace_key, source_system, connection_key, root_batch_id, job_id
  )
  include (parent_job_id, source_cursor_version, source_cursor_value);

-- Replacement provenance enters this membership table from observation_id;
-- its inherited primary key starts with job_id and cannot serve that lookup.
create index if not exists source_processing_job_observations_observation_job_idx
  on public.source_processing_job_observations (observation_id, job_id);

-- The exact identity used by the completeness contract for a later successful
-- deterministic replacement.  The execution witness first requires all three
-- identity fields, then uses equality so PostgreSQL can parameterize this
-- index.  Malformed/null identities remain visible to the broad completeness
-- reader but cannot enter model execution.
create index if not exists source_observations_gmail_attachment_replacement_idx
  on public.source_observations (
    workspace_key,
    (normalized_payload->>'attachmentId'),
    (normalized_payload->>'parentObservationId'),
    (normalized_payload->>'rawSha256'),
    journal_seq,
    observation_id
  )
  where source_system = 'gmail'
    and source_object_type = 'gmail_attachment_extracted'
    and normalized_payload->>'schemaVersion' = 'gmail-attachment-extracted-v1'
    and normalized_payload->'extraction'->>'status' = 'extracted'
    and normalized_payload->'extraction'->>'provenance' = 'deterministic'
    and coalesce(
      normalized_payload #>> '{extraction,reviewRequired}',
      'true'
    ) = 'false';

create index if not exists gmail_model_review_obligations_commissioning_idx
  on public.gmail_model_extraction_review_obligations (
    workspace_key, created_at, obligation_id
  )
  include (extraction_plan_id, review_job_id, obligation_hash)
  where reason_code = 'MODEL_RUNTIME_DISABLED'
    and model_plan_id is null
    and model_child_job_id is null;

create index if not exists truth_shadow_gmail_model_replay_scope_receipt_idx
  on public.truth_shadow_gmail_model_commissioning_replays (
    workspace_key, commissioning_scope_id, replay_id
  )
  include (obligation_id);

-- Attachment attempt receipt/begin paths address dispatches by request_id
-- alone.  The predecessor unique key begins with workspace_key.
create index if not exists gmail_attachment_model_dispatch_request_idx
  on public.gmail_attachment_model_attempt_dispatches (
    request_id, attempt_number desc, dispatch_id
  );

-- The deferred candidate guard enters a message plan from parent_job_id.
create index if not exists gmail_model_extraction_plans_parent_job_idx
  on public.gmail_model_extraction_plans (parent_job_id);

-- Keep the replacement coordinate behind its own materialization boundary.
-- Without this boundary PostgreSQL can flatten the correlated anti-join and
-- prefer one workspace-wide hash input even though an exact expression index
-- exists.  The candidate CTE is now necessarily populated from that index
-- before the small processing-provenance joins run.
create or replace function private.has_newer_deterministic_gmail_attachment_replacement_v1(
  p_workspace_key text,
  p_attachment_observation_id text,
  p_journal_seq bigint,
  p_attachment_id text,
  p_parent_observation_id text,
  p_raw_sha256 text
)
returns boolean
language sql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
  with replacement_candidates as materialized (
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
  )
  select exists (
    select 1
    from replacement_candidates replacement
    join public.source_processing_job_observations replacement_output
      on replacement_output.observation_id = replacement.observation_id
    join public.source_processing_jobs replacement_job
      on replacement_job.job_id = replacement_output.job_id
     and replacement_job.workspace_key = replacement.workspace_key
     and replacement_job.source_system = replacement.source_system
     and replacement_job.connection_key = replacement.connection_key
     and replacement_job.job_kind = 'gmail_extract_attachment'
     and replacement_job.state = 'succeeded'
    where exists (
      select 1
      from public.source_processing_job_children replacement_child_link
      join public.source_processing_jobs replacement_child
        on replacement_child.job_id = replacement_child_link.child_job_id
       and replacement_child.job_kind = 'gmail_extract_attachment_claims'
       and replacement_child.observation_id = replacement.observation_id
      where replacement_child_link.parent_job_id = replacement_job.job_id
    )
  );
$function$;

revoke all on function private.has_newer_deterministic_gmail_attachment_replacement_v1(
  text, text, bigint, text, text, text
) from public, anon, authenticated, service_role;

-- Exact execution witness.  The workspace-wide overload intentionally remains
-- unchanged because source-cut completeness must still report a missing review
-- child; prepare/load/complete already possess one exact review job.
create or replace function private.unresolved_gmail_attachment_extraction_v1(
  p_workspace_key text,
  p_review_job_id uuid,
  p_attachment_observation_id text
)
returns table (
  attachment_observation_id text,
  attachment_content_hash text,
  connection_key text,
  root_batch_id uuid,
  review_job_id uuid
)
language sql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
  select
    observation.observation_id,
    observation.content_hash,
    observation.connection_key,
    parent_lineage.root_batch_id,
    review_job.job_id
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.job_id = review_job.job_id
   and review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
  join public.source_processing_jobs parent_job
    on parent_job.job_id = review_lineage.parent_job_id
   and parent_job.workspace_key = review_job.workspace_key
   and parent_job.source_system = review_job.source_system
   and parent_job.connection_key = review_job.connection_key
  join public.source_processing_job_lineage parent_lineage
    on parent_lineage.job_id = parent_job.job_id
   and parent_lineage.workspace_key = parent_job.workspace_key
   and parent_lineage.source_system = parent_job.source_system
   and parent_lineage.connection_key = parent_job.connection_key
   and parent_lineage.root_batch_id = review_lineage.root_batch_id
   and parent_lineage.source_cursor_version = review_lineage.source_cursor_version
   and parent_lineage.source_cursor_value = review_lineage.source_cursor_value
  join public.source_processing_job_children child_link
    on child_link.parent_job_id = parent_job.job_id
   and child_link.child_job_id = review_job.job_id
  join public.source_processing_job_observations output
    on output.job_id = parent_job.job_id
   and output.observation_id = review_job.observation_id
  join public.source_observations observation
    on observation.workspace_key = review_job.workspace_key
   and observation.observation_id = review_job.observation_id
   and observation.source_system = review_job.source_system
   and observation.connection_key = review_job.connection_key
  join public.source_ingest_batches batch
    on batch.batch_id = parent_lineage.root_batch_id
   and batch.workspace_key = parent_lineage.workspace_key
   and batch.source_system = parent_lineage.source_system
   and batch.connection_key = parent_lineage.connection_key
   and batch.status = 'committed'
  where review_job.workspace_key = p_workspace_key
    and review_job.job_id = p_review_job_id
    and review_job.observation_id = p_attachment_observation_id
    and review_job.source_system = 'gmail'
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and parent_job.job_kind = 'gmail_extract_attachment'
    and parent_job.state = 'succeeded'
    and observation.source_object_type = 'gmail_attachment_extracted'
    and observation.normalized_payload->>'schemaVersion' =
      'gmail-attachment-extracted-v1'
    and nullif(observation.normalized_payload->>'attachmentId', '') is not null
    and observation.normalized_payload->>'parentObservationId'
      ~ '^obs:v1:[0-9a-f]{64}$'
    and observation.normalized_payload->>'rawSha256' ~ '^[0-9a-f]{64}$'
    and (
      observation.normalized_payload->'extraction'->>'status' <> 'extracted'
      or coalesce(
        (observation.normalized_payload->'extraction'->>'reviewRequired')::boolean,
        true
      )
    )
    and not exists (
      select 1
      from public.gmail_attachment_extraction_resolutions resolution
      where resolution.workspace_key = observation.workspace_key
        and resolution.attachment_observation_id = observation.observation_id
        and resolution.attachment_content_hash = observation.content_hash
    )
    and not private.has_newer_deterministic_gmail_attachment_replacement_v1(
      observation.workspace_key,
      observation.observation_id,
      observation.journal_seq,
      observation.normalized_payload->>'attachmentId',
      observation.normalized_payload->>'parentObservationId',
      observation.normalized_payload->>'rawSha256'
    )
  limit 1;
$function$;

revoke all on function private.unresolved_gmail_attachment_extraction_v1(
  text, uuid, text
) from public, anon, authenticated, service_role;

-- PL/pgSQL is intentional here: a single flattened SQL candidate query can
-- evaluate the exact-target predicate for every root job before applying
-- LIMIT.  This loop locks in deterministic order and stops immediately after
-- returning p_limit valid targets.  Invalid/stale rows are skipped without
-- starving later valid rows.
create or replace function private.select_truth_shadow_gmail_attachment_commissioning_v1(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_source_cursor_version bigint,
  p_source_cursor_value text,
  p_limit integer
)
returns table (job_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  v_candidate record;
  v_selected integer := 0;
begin
  if p_limit is null or p_limit <= 0 then
    return;
  end if;
  if p_limit > 50 then
    raise exception 'shadow attachment commissioning selector limit is invalid'
      using errcode = '22023';
  end if;

  for v_candidate in
    select review_job.job_id, review_job.observation_id
    from public.source_processing_jobs review_job
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = review_job.workspace_key
     and review_lineage.source_system = review_job.source_system
     and review_lineage.connection_key = review_job.connection_key
     and review_lineage.job_id = review_job.job_id
    where review_job.workspace_key = p_workspace_key
      and review_job.source_system = 'gmail'
      and review_job.connection_key = p_connection_key
      and review_job.job_kind = 'gmail_review_attachment_extraction'
      and review_job.state = 'waiting_runtime'
      and review_job.attempt_count < review_job.max_attempts
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.completed_at is null
      and review_job.result = '{}'::jsonb
      and review_lineage.root_batch_id = p_root_batch_id
      and review_lineage.source_cursor_version = p_source_cursor_version
      and review_lineage.source_cursor_value = p_source_cursor_value
    order by review_job.created_at, review_job.job_id
    for update of review_job skip locked
  loop
    if exists (
      select 1
      from private.unresolved_gmail_attachment_extraction_v1(
        p_workspace_key, v_candidate.job_id, v_candidate.observation_id
      ) exact_target
      where exact_target.connection_key = p_connection_key
        and exact_target.root_batch_id = p_root_batch_id
    ) then
      job_id := v_candidate.job_id;
      return next;
      v_selected := v_selected + 1;
      exit when v_selected >= p_limit;
    end if;
  end loop;
end;
$function$;

revoke all on function private.select_truth_shadow_gmail_attachment_commissioning_v1(
  text, text, uuid, bigint, text, integer
) from public, anon, authenticated, service_role;

-- Abandoned HTTP requests must not make later prepare calls wait behind the
-- scope lock.  The workspace cut lock remains shared and the scope mutation is
-- still serialized; contention now returns one bounded retry receipt.
do $prepare_try_lock_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  perform pg_advisory_xact_lock(hashtextextended(
    'truth-shadow-gmail-model-commissioning-v1:' || p_workspace_key || ':' ||
      p_connection_key || ':' || p_root_batch_id::text,
    0
  ));$old$;
  v_new text := $new$  if not pg_try_advisory_xact_lock(hashtextextended(
    'truth-shadow-gmail-model-commissioning-v1:' || p_workspace_key || ':' ||
      p_connection_key || ':' || p_root_batch_id::text,
    0
  )) then
    return jsonb_build_object(
      'ok', true,
      'status', 'busy',
      'retryable', true,
      'schemaVersion', 'truth-shadow-gmail-model-commissioning-batch-receipt-v1',
      'workspaceKey', p_workspace_key,
      'connectionKey', p_connection_key,
      'rootBatchId', p_root_batch_id,
      'preparedCount', 0,
      'attachmentActivatedCount', 0,
      'shadowOnly', true,
      'mutatesOperationalState', false,
      'productionPublicationAttempted', false
    );
  end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'prepare scope-lock rewrite did not match the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition or position(v_old in v_updated) > 0
      or position(v_new in v_updated) = 0 then
      raise exception 'prepare scope-lock rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'prepare scope-lock rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$prepare_try_lock_rewrite$;

-- Remove the predecessor's pre-loop, unbounded attachment work.  Message
-- replays keep first priority; the exact attachment candidates then consume
-- only the remainder of the same p_limit budget.
do $prepare_attachment_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  -- Attachment extraction review jobs predate the model commissioning scope
  -- and may have been deliberately parked in waiting_runtime.  Activate only
  -- unresolved jobs in this exact immutable root.  Queued/retry jobs are left
  -- untouched, and no attempt history is reset.
  update public.source_processing_jobs review_job
  set state = 'queued',
      available_at = clock_timestamp(),
      last_error_code = '',
      safe_error_detail = '',
      updated_at = clock_timestamp()
  from public.source_processing_job_lineage review_lineage
  where review_job.workspace_key = p_workspace_key
    and review_job.source_system = 'gmail'
    and review_job.connection_key = p_connection_key
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.state = 'waiting_runtime'
    and review_job.attempt_count < review_job.max_attempts
    and review_job.lease_owner is null
    and review_job.lease_expires_at is null
    and review_job.completed_at is null
    and review_job.result = '{}'::jsonb
    and review_lineage.workspace_key = review_job.workspace_key
    and review_lineage.source_system = review_job.source_system
    and review_lineage.connection_key = review_job.connection_key
    and review_lineage.job_id = review_job.job_id
    and review_lineage.root_batch_id = p_root_batch_id
    and review_lineage.source_cursor_version = v_batch.committed_cursor_version
    and review_lineage.source_cursor_value = v_batch.committed_cursor_value
    and exists (
      select 1
      from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
      where unresolved.review_job_id = review_job.job_id
        and unresolved.attachment_observation_id = review_job.observation_id
        and unresolved.connection_key = p_connection_key
        and unresolved.root_batch_id = p_root_batch_id
    );
  get diagnostics v_attachment_activated_count = row_count;

  select count(*)::integer into v_attachment_runnable_count
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  where review_job.workspace_key = p_workspace_key
    and review_job.source_system = 'gmail'
    and review_job.connection_key = p_connection_key
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.state in ('queued', 'retry_wait')
    and review_job.attempt_count < review_job.max_attempts
    and review_lineage.root_batch_id = p_root_batch_id
    and private.truth_shadow_model_commissioning_job_allowed(
      review_job.workspace_key, review_job.job_id
    )
    and exists (
      select 1
      from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
      where unresolved.review_job_id = review_job.job_id
        and unresolved.attachment_observation_id = review_job.observation_id
        and unresolved.connection_key = p_connection_key
        and unresolved.root_batch_id = p_root_batch_id
    );

$old$;
  v_anchor text := $anchor$  end loop;

  select count(*)::integer,$anchor$;
  v_new text := $new$  end loop;

  -- Attachment extraction review jobs predate the model commissioning scope.
  -- Activate only exact unresolved jobs in this immutable root and only from
  -- the portion of p_limit not already consumed by message replays.
  with attachment_candidates as materialized (
    select candidate.job_id
    from private.select_truth_shadow_gmail_attachment_commissioning_v1(
      p_workspace_key,
      p_connection_key,
      p_root_batch_id,
      v_batch.committed_cursor_version,
      v_batch.committed_cursor_value,
      greatest(p_limit - v_prepared_count, 0)
    ) candidate
  ), activated as (
    update public.source_processing_jobs review_job
    set state = 'queued',
        available_at = clock_timestamp(),
        last_error_code = '',
        safe_error_detail = '',
        updated_at = clock_timestamp()
    from attachment_candidates candidate
    where review_job.job_id = candidate.job_id
      and review_job.state = 'waiting_runtime'
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
    returning review_job.job_id
  )
  select count(*)::integer into v_attachment_activated_count
  from activated;

  select count(*)::integer into v_attachment_runnable_count
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  where review_job.workspace_key = p_workspace_key
    and review_job.source_system = 'gmail'
    and review_job.connection_key = p_connection_key
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.state in ('queued', 'retry_wait')
    and review_job.attempt_count < review_job.max_attempts
    and review_lineage.root_batch_id = p_root_batch_id
    and review_lineage.source_cursor_version = v_batch.committed_cursor_version
    and review_lineage.source_cursor_value = v_batch.committed_cursor_value;

  select count(*)::integer,$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('attachment_candidates as materialized' in lower(v_definition)) = 0 then
    if position(v_old in v_definition) = 0
      or position(v_anchor in v_definition) = 0 then
      raise exception 'bounded attachment prepare rewrite did not match the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, '');
    v_updated := replace(v_updated, v_anchor, v_new);
    if v_updated = v_definition
      or position(v_old in v_updated) > 0
      or position(v_anchor in v_updated) > 0
      or position('attachment_candidates as materialized' in lower(v_updated)) = 0
      or position(
        'greatest(p_limit - v_prepared_count, 0)' in lower(v_updated)
      ) = 0 then
      raise exception 'bounded attachment prepare rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'bounded attachment prepare rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$prepare_attachment_rewrite$;

-- Per-job RPCs must never enumerate the workspace unresolved set.
do $attachment_context_rewrite$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated text;
  v_old text;
  v_new text;
begin
  v_signature := to_regprocedure(
    'private.load_truth_gmail_attachment_model_context(text,uuid,text,bigint,text,text)'
  );
  v_old := $old$  select * into v_target
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where unresolved.review_job_id = v_job.job_id
    and unresolved.attachment_observation_id = v_job.observation_id;$old$;
  v_new := $new$  select * into v_target
  from private.unresolved_gmail_attachment_extraction_v1(
    p_workspace_key, v_job.job_id, v_job.observation_id
  ) unresolved
  where unresolved.review_job_id = v_job.job_id
    and unresolved.attachment_observation_id = v_job.observation_id;$new$;
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'attachment context exact-target rewrite did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'attachment context exact-target rewrite is partially installed'
      using errcode = '23514';
  end if;

  v_signature := to_regprocedure(
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'
  );
  v_old := $old$  select * into v_target
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where unresolved.review_job_id = p_job_id
    and unresolved.attachment_observation_id = v_request.source_observation_id
    and unresolved.attachment_content_hash = v_request.source_observation_content_hash;$old$;
  v_new := $new$  select * into v_target
  from private.unresolved_gmail_attachment_extraction_v1(
    p_workspace_key, p_job_id, v_request.source_observation_id
  ) unresolved
  where unresolved.review_job_id = p_job_id
    and unresolved.attachment_observation_id = v_request.source_observation_id
    and unresolved.attachment_content_hash = v_request.source_observation_content_hash;$new$;
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'attachment completion exact-target rewrite did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'attachment completion exact-target rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$attachment_context_rewrite$;

alter function private.prepare_truth_shadow_gmail_model_commissioning(
  text, text, uuid, integer, text, text
) set plan_cache_mode = 'force_custom_plan';
alter function public.prepare_truth_shadow_gmail_model_commissioning(
  text, text, uuid, integer, text, text
) set plan_cache_mode = 'force_custom_plan';
alter function private.load_truth_gmail_attachment_model_context(
  text, uuid, text, bigint, text, text
) set plan_cache_mode = 'force_custom_plan';
alter function private.complete_truth_gmail_attachment_model_extraction(
  text, uuid, text, bigint, text, text, text, text, text, text
) set plan_cache_mode = 'force_custom_plan';

-- Refresh only the relations whose access paths changed.  This does not touch
-- source or canonical truth rows.
analyze public.source_processing_jobs;
analyze public.source_processing_job_lineage;
analyze public.source_processing_job_observations;
analyze public.source_observations;
analyze public.gmail_model_extraction_review_obligations;
analyze public.truth_shadow_gmail_model_commissioning_replays;
analyze public.gmail_attachment_model_attempt_dispatches;
analyze public.gmail_model_extraction_plans;

do $verify$
declare
  v_prepare regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_public_prepare regprocedure := to_regprocedure(
    'public.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_load regprocedure := to_regprocedure(
    'private.load_truth_gmail_attachment_model_context(text,uuid,text,bigint,text,text)'
  );
  v_complete regprocedure := to_regprocedure(
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'
  );
  v_definition text;
  v_config text[];
begin
  if to_regprocedure(
      'private.unresolved_gmail_attachment_extraction_v1(text,uuid,text)'
    ) is null
    or to_regprocedure(
      'private.has_newer_deterministic_gmail_attachment_replacement_v1(text,text,bigint,text,text,text)'
    ) is null
    or to_regprocedure(
      'private.select_truth_shadow_gmail_attachment_commissioning_v1(text,text,uuid,bigint,text,integer)'
    ) is null then
    raise exception 'exact attachment execution witness is unavailable'
      using errcode = '23514';
  end if;

  if not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_jobs_shadow_attachment_prepare_idx'
        and lower(indexdef) like '%where ((source_system = ''gmail''::text)%'
    )
    or not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_job_observations_observation_job_idx'
        and lower(indexdef) like '%(observation_id, job_id)%'
    )
    or not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_observations_gmail_attachment_replacement_idx'
        and lower(indexdef) like '%normalized_payload%attachmentid%'
        and lower(indexdef) like '%journal_seq%'
    )
    or not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'gmail_attachment_model_dispatch_request_idx'
        and lower(indexdef) like '%(request_id, attempt_number desc, dispatch_id)%'
    ) then
    raise exception 'shadow Gmail model prepare access paths are missing or malformed'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_prepare)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_prepare;
  if position('pg_try_advisory_xact_lock' in v_definition) = 0
    or position('attachment_candidates as materialized' in v_definition) = 0
    or position('greatest(p_limit - v_prepared_count, 0)' in v_definition) = 0
    or position(
      'select_truth_shadow_gmail_attachment_commissioning_v1(' in v_definition
    ) = 0
    or position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) > 0
    or position('productionpublicationattempted'', false' in v_definition) = 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    )) then
    raise exception 'private prepare authority is not bounded or shadow-only'
      using errcode = '23514';
  end if;

  select proconfig into v_config from pg_proc where oid = v_public_prepare;
  if not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    )) then
    raise exception 'public prepare authority did not adopt coordinate-specific planning'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_load)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_load;
  if position('unresolved_gmail_attachment_extraction_v1(' in v_definition) = 0
    or position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) > 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    )) then
    raise exception 'attachment context remains workspace-wide'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_complete)), proconfig
    into v_definition, v_config
  from pg_proc where oid = v_complete;
  if position('unresolved_gmail_attachment_extraction_v1(' in v_definition) = 0
    or position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) > 0
    or position('productionpublicationattempted'', false' in v_definition) = 0
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_config, array[]::text[])
    )) then
    raise exception 'attachment completion remains workspace-wide or escaped shadow'
      using errcode = '23514';
  end if;
end;
$verify$;
