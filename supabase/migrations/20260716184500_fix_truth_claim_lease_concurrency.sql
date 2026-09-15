-- Queue claims already select runnable rows with FOR UPDATE SKIP LOCKED, but
-- source-cut artifact triggers then took one exclusive workspace advisory lock
-- for every mutation. Concurrent claim/completion transactions therefore held
-- disjoint job rows and still blocked one another on that exclusive lock. The
-- parse-checkpoint migration also replaced the public claim wrapper without
-- preserving advisory-before-row-lock ordering, while expired-lease reaping and
-- lazy lineage bootstrap could wait on rows before reaching the SKIP LOCKED
-- candidate query.
--
-- Use PostgreSQL reader/writer advisory semantics on the same key: ordinary
-- cut-scoped mutations take a shared transaction lock, while source-cut sealing
-- retains the existing exclusive lock. This allows concurrent workers and still
-- makes a source cut an atomic barrier against every in-flight mutation.

do $migration$
declare
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_public_claim regprocedure := to_regprocedure(
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_guard regprocedure := to_regprocedure(
    'private.guard_truth_source_cut_artifact_mutation()'
  );
  v_complete regprocedure := to_regprocedure(
    'public.complete_source_processing_job(uuid,text,bigint,text,jsonb,jsonb,jsonb,text)'
  );
  v_fail regprocedure := to_regprocedure(
    'public.fail_source_processing_job(uuid,text,bigint,text,text,text,integer,text)'
  );
  v_plan_seal regprocedure := to_regprocedure(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  );
  v_definition text;
begin
  if v_claim is null or v_public_claim is null or v_guard is null
    or v_complete is null or v_fail is null or v_plan_seal is null then
    raise exception 'claim-concurrency repair prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_claim)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0 then
    if position('job.job_kind<>''gmail_resolve_entity_links''' in v_definition) = 0
      or position(
        'job.job_kind<>all(array[''gmail_extract_message_claims'',''gmail_extract_attachment_claims''])'
        in v_definition
      ) = 0
      or position('for update of job skip locked limit p_limit' in v_definition) = 0 then
      raise exception 'private claim authority differs from the reviewed Gmail link-epoch contract'
        using errcode = '23514';
    end if;
  elsif position('expired_jobs as materialized' in v_definition) = 0
    or position('lineage_job_candidates as materialized' in v_definition) = 0 then
    raise exception 'claim-concurrency repair is only partially installed'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_public_claim)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    and (
      position('select private.claim_source_processing_jobs(' in v_definition) = 0
      or position('truth_source_cut_serialization_lock' in v_definition) > 0
    ) then
    raise exception 'public claim wrapper differs from the reviewed direct wrapper'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_guard)) into v_definition;
  if position('truth_source_cut_mutation_lock(v_workspace_key)' in v_definition) = 0
    and position('truth_source_cut_serialization_lock(v_workspace_key)' in v_definition) = 0 then
    raise exception 'source-cut artifact guard differs from the reviewed exclusive writer contract'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_complete)) into v_definition;
  if position('truth_source_cut_mutation_lock_for_job(p_job_id)' in v_definition) = 0
    and position('truth_source_cut_serialization_lock_for_job(p_job_id)' in v_definition) = 0 then
    raise exception 'completion wrapper differs from the reviewed source-cut lock contract'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_fail)) into v_definition;
  if position('truth_source_cut_mutation_lock_for_job(p_job_id)' in v_definition) = 0
    and position('truth_source_cut_serialization_lock_for_job(p_job_id)' in v_definition) = 0 then
    raise exception 'failure wrapper differs from the reviewed source-cut lock contract'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_plan_seal)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    and position('truth_source_cut_serialization_lock(p_workspace_key)' in v_definition) = 0 then
    raise exception 'Gmail plan sealer differs from the reviewed source-cut lock contract'
      using errcode = '23514';
  end if;
end;
$migration$;

create or replace function private.truth_source_cut_mutation_lock(
  p_workspace_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null then
    raise exception 'source-cut mutation workspace is invalid'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'truth-source-cut-serialization-v1:' || p_workspace_key,
    0
  ));
end;
$function$;

create or replace function private.truth_source_cut_mutation_lock_for_job(
  p_job_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workspace_key text;
begin
  select job.workspace_key into v_workspace_key
  from public.source_processing_jobs job
  where job.job_id = p_job_id;
  if found then
    perform private.truth_source_cut_mutation_lock(v_workspace_key);
  end if;
end;
$function$;

revoke all on function private.truth_source_cut_mutation_lock(text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_source_cut_mutation_lock_for_job(uuid)
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.truth_source_cut_mutation_lock(text)
  to service_role;
grant execute on function private.truth_source_cut_mutation_lock_for_job(uuid)
  to service_role;

-- Replace only the reviewed lock call inside the exhaustive storage guard.
-- Keeping this as a guarded body rewrite preserves the complete table-routing
-- switch from the installed function instead of copying a stale table list.
do $rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.guard_truth_source_cut_artifact_mutation()'
  );
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
    'truth_source_cut_mutation_lock(v_workspace_key)'
    in lower(v_definition)
  ) = 0 then
    v_rewritten := regexp_replace(
      v_definition,
      'perform[[:space:]]+private\.truth_source_cut_serialization_lock\(v_workspace_key\);',
      'perform private.truth_source_cut_mutation_lock(v_workspace_key);',
      'i'
    );
    if v_rewritten = v_definition
      or position(
        'truth_source_cut_serialization_lock(v_workspace_key)'
        in lower(v_rewritten)
      ) > 0 then
      raise exception 'source-cut artifact guard lock rewrite did not match exactly'
        using errcode = '23514';
    end if;
    execute v_rewritten;
  end if;
end;
$rewrite$;

create index if not exists source_processing_jobs_expired_lease_scope_idx
  on public.source_processing_jobs(
    workspace_key, source_system, connection_key, lease_expires_at, job_id
  )
  where state = 'leased';

create index if not exists source_processing_jobs_claim_scope_kind_idx
  on public.source_processing_jobs(
    workspace_key, source_system, connection_key, job_kind,
    available_at, created_at, job_id
  )
  where state in ('queued', 'retry_wait');

create or replace function private.claim_source_processing_jobs(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_worker_id text,
  p_processor_version text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_kinds text[],
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '60s'
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_jobs jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_source_system, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or p_limit is null or p_limit < 1 or p_limit > 50
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900
    or exists (
      select 1 from unnest(coalesce(p_job_kinds, array[]::text[])) job_kind
      where nullif(trim(job_kind), '') is null
    ) then
    raise exception 'invalid source-processing claim request' using errcode = '22023';
  end if;

  -- Advisory-before-row-lock ordering is now enforced in the private authority
  -- as well as the public wrapper. The shared key permits worker concurrency;
  -- an exclusive source-cut transaction still blocks every new mutation.
  perform private.truth_source_cut_mutation_lock(p_workspace_key);

  -- Lease cleanup must not wait on a worker that is currently acknowledging a
  -- different job. Locked expired rows remain visible for the next claim call.
  with expired_jobs as materialized (
    select job.job_id
    from public.source_processing_jobs job
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and job.state = 'leased'
      and (job.lease_expires_at is null or job.lease_expires_at <= v_now)
    order by job.lease_expires_at nulls first, job.job_id
    for update of job skip locked
  )
  update public.source_processing_jobs job
  set state = case when job.attempt_count >= job.max_attempts
        then 'dead_letter' else 'retry_wait' end,
      available_at = case when job.attempt_count >= job.max_attempts
        then job.available_at else v_now end,
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = 'LEASE_EXPIRED',
      safe_error_detail = 'The prior processing lease expired before acknowledgement.',
      updated_at = v_now,
      completed_at = case when job.attempt_count >= job.max_attempts then v_now else null end
  from expired_jobs
  where job.job_id = expired_jobs.job_id;

  -- Legacy jobs can still need deterministic lineage bootstrap. Claim each
  -- source job row before its unique lineage insert so overlapping claimers do
  -- not wait on speculative inserts for the same job identity.
  with lineage_job_candidates as materialized (
    select job.job_id
    from public.source_processing_jobs job
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and not exists (
        select 1 from public.source_processing_job_lineage lineage
        where lineage.job_id = job.job_id
      )
    order by job.job_id
    for update of job skip locked
    limit greatest(p_limit * 4, 100)
  )
  insert into public.source_processing_job_lineage (
    job_id, workspace_key, source_system, connection_key, root_batch_id,
    parent_job_id, root_job_id, source_cursor_version, source_cursor_value
  )
  select distinct
    job.job_id, job.workspace_key, job.source_system, job.connection_key,
    batch.batch_id, null::uuid, job.job_id,
    batch.committed_cursor_version, batch.committed_cursor_value
  from lineage_job_candidates candidate_job
  join public.source_processing_jobs job
    on job.job_id = candidate_job.job_id
  join public.source_ingest_batches batch
    on batch.batch_id::text = job.payload->>'batchId'
   and batch.workspace_key = job.workspace_key
   and batch.source_system = job.source_system
   and batch.connection_key = job.connection_key
   and batch.status = 'committed'
   and batch.committed_cursor_version is not null
   and nullif(batch.committed_cursor_value, '') is not null
  left join public.gmail_ingest_page_jobs page_job
    on page_job.job_id = job.job_id and page_job.batch_id = batch.batch_id
  left join public.source_observations anchor
    on anchor.observation_id = job.observation_id
   and anchor.workspace_key = job.workspace_key
   and anchor.source_system = job.source_system
   and anchor.connection_key = job.connection_key
   and anchor.batch_id = batch.batch_id
  where ((job.source_system = 'gmail' and page_job.job_id is not null)
      or (job.source_system <> 'gmail' and anchor.observation_id is not null))
    and (job.source_system <> 'gmail' or batch.committed_cursor_value ~ '^[0-9]+$')
  on conflict (job_id) do nothing;

  with candidates as (
    select job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.job_id = job.job_id
     and lineage.workspace_key = job.workspace_key
     and lineage.source_system = job.source_system
     and lineage.connection_key = job.connection_key
    join public.source_ingest_batches batch
      on batch.batch_id = lineage.root_batch_id
     and batch.workspace_key = lineage.workspace_key
     and batch.source_system = lineage.source_system
     and batch.connection_key = lineage.connection_key
     and batch.status = 'committed'
     and batch.committed_cursor_version = lineage.source_cursor_version
     and batch.committed_cursor_value = lineage.source_cursor_value
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and job.state in ('queued', 'retry_wait')
      and job.available_at <= v_now
      and job.attempt_count < job.max_attempts
      and (coalesce(cardinality(p_job_kinds), 0) = 0
        or job.job_kind = any(p_job_kinds))
      and (job.source_system <> 'gmail' or lineage.source_cursor_value ~ '^[0-9]+$')
      and not (job.source_system = 'gmail' and job.job_kind = 'gmail_fetch_raw_message')
      and not (job.source_system = 'gmail' and job.job_kind = any(array[
        'gmail_extract_message_model_claims', 'gmail_review_model_extraction'
      ]))
      and (job.job_kind <> 'gmail_resolve_entity_links' or exists (
        select 1 from public.truth_gmail_link_epoch_members member
        where member.workspace_key = job.workspace_key
          and member.link_job_id = job.job_id
      ))
      and (job.job_kind <> all(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
        ]) or exists (
          select 1 from public.truth_gmail_link_epochs epoch
          join public.truth_gmail_link_epoch_seals seal
            on seal.workspace_key = epoch.workspace_key
           and seal.epoch_id = epoch.epoch_id
          where epoch.workspace_key = job.workspace_key
            and epoch.root_batch_id = lineage.root_batch_id
        ))
      and (job.job_kind <> 'gmail_materialize_message_revision' or (
        exists (
          select 1 from public.gmail_message_materialization_groups group_row
          where group_row.workspace_key = job.workspace_key
            and group_row.materialization_job_id = job.job_id
        )
        and not exists (
          select 1
          from public.gmail_message_materialization_groups current_group
          join public.gmail_message_materialization_groups prior_group
            on prior_group.workspace_key = current_group.workspace_key
           and prior_group.connection_key = current_group.connection_key
           and prior_group.message_id = current_group.message_id
           and prior_group.route_disposition = 'materialize_revision'
           and (prior_group.source_cursor_version < current_group.source_cursor_version
             or (prior_group.source_cursor_version = current_group.source_cursor_version
               and prior_group.group_id < current_group.group_id))
          join public.source_processing_jobs prior_job
            on prior_job.workspace_key = prior_group.workspace_key
           and prior_job.job_id = prior_group.materialization_job_id
          where current_group.workspace_key = job.workspace_key
            and current_group.materialization_job_id = job.job_id
            and prior_job.state not in ('succeeded', 'dead_letter', 'superseded')
        )
      ))
    order by
      case when job.job_kind = 'gmail_materialize_message_revision'
        then lineage.source_cursor_version else 0 end,
      job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.source_processing_jobs job
    set state = 'leased',
        attempt_count = job.attempt_count + 1,
        lease_owner = p_worker_id,
        lease_fence = job.lease_fence + 1,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_error_code = '',
        safe_error_detail = '',
        processor_version = p_processor_version,
        updated_at = v_now,
        completed_at = null
    from candidates
    where job.job_id = candidates.job_id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', claimed.job_id,
    'dedupeKey', claimed.dedupe_key,
    'jobKind', claimed.job_kind,
    'observationId', claimed.observation_id,
    'sourceObjectId', claimed.source_object_id,
    'attemptCount', claimed.attempt_count,
    'maxAttempts', claimed.max_attempts,
    'leaseFence', claimed.lease_fence,
    'leaseExpiresAt', claimed.lease_expires_at,
    'processorVersion', claimed.processor_version,
    'payload', claimed.payload,
    'rootBatchId', lineage.root_batch_id,
    'rootJobId', lineage.root_job_id,
    'parentJobId', lineage.parent_job_id,
    'sourceCursorVersion', lineage.source_cursor_version,
    'sourceCursorValue', lineage.source_cursor_value
  ) || case when claimed.job_kind = 'gmail_materialize_message_revision'
    then jsonb_build_object(
      'materializationAuthority', private.load_gmail_materialization_authority_v1(
        claimed.workspace_key, claimed.job_id
      )
    ) else '{}'::jsonb end
  order by claimed.available_at, claimed.created_at, claimed.job_id), '[]'::jsonb)
  into v_jobs
  from claimed
  join public.source_processing_job_lineage lineage
    on lineage.job_id = claimed.job_id;

  return jsonb_build_object(
    'ok', true,
    'workerId', p_worker_id,
    'processorVersion', p_processor_version,
    'leaseSeconds', p_lease_seconds,
    'claimedCount', jsonb_array_length(v_jobs),
    'jobs', v_jobs
  );
end;
$function$;

revoke all on function private.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) from public, anon, authenticated, service_role;

create or replace function public.claim_source_processing_jobs(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_worker_id text,
  p_processor_version text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_kinds text[],
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '60s'
as $function$
begin
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  return private.claim_source_processing_jobs(
    p_workspace_key, p_source_system, p_connection_key, p_worker_id,
    p_processor_version, p_limit, p_lease_seconds, p_job_kinds, p_sync_token
  );
end;
$function$;

create or replace function public.complete_source_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_result jsonb,
  p_observations jsonb,
  p_child_jobs jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_mutation_lock_for_job(p_job_id);
  return private.complete_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    p_result, p_observations, p_child_jobs, p_sync_token
  );
end;
$function$;

create or replace function public.fail_source_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_error_code text,
  p_safe_error_detail text,
  p_retry_after_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_mutation_lock_for_job(p_job_id);
  return private.fail_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    p_error_code, p_safe_error_detail, p_retry_after_seconds, p_sync_token
  );
end;
$function$;

-- The deterministic Gmail planner is a cut-scoped mutation, not a cut seal.
-- Replace only its explicit workspace lock and keep the remainder of the
-- installed server-derived planning authority byte-for-byte.
do $rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  );
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
    'truth_source_cut_mutation_lock(p_workspace_key)'
    in lower(v_definition)
  ) = 0 then
    v_rewritten := regexp_replace(
      v_definition,
      'perform[[:space:]]+private\.truth_source_cut_serialization_lock\(p_workspace_key\);',
      'perform private.truth_source_cut_mutation_lock(p_workspace_key);',
      'i'
    );
    if v_rewritten = v_definition
      or position(
        'truth_source_cut_serialization_lock(p_workspace_key)'
        in lower(v_rewritten)
      ) > 0 then
      raise exception 'Gmail plan-seal mutation lock rewrite did not match exactly'
        using errcode = '23514';
    end if;
    execute v_rewritten;
  end if;
end;
$rewrite$;

revoke all on function public.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) from public, anon, authenticated, service_role;
revoke all on function public.complete_source_processing_job(
  uuid, text, bigint, text, jsonb, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.fail_source_processing_job(
  uuid, text, bigint, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) to service_role;
grant execute on function public.complete_source_processing_job(
  uuid, text, bigint, text, jsonb, jsonb, jsonb, text
) to service_role;
grant execute on function public.fail_source_processing_job(
  uuid, text, bigint, text, text, text, integer, text
) to service_role;

do $verify$
declare
  v_definition text;
  v_public_claim regprocedure := to_regprocedure(
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
begin
  select lower(pg_get_functiondef(
    'private.truth_source_cut_mutation_lock(text)'::regprocedure
  )) into v_definition;
  if position('pg_advisory_xact_lock_shared' in v_definition) = 0
    or position('truth-source-cut-serialization-v1:' in v_definition) = 0 then
    raise exception 'shared source-cut mutation lock did not install'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.truth_source_cut_serialization_lock(text)'::regprocedure
  )) into v_definition;
  if position('pg_advisory_xact_lock(' in v_definition) = 0
    or position('pg_advisory_xact_lock_shared' in v_definition) > 0 then
    raise exception 'exclusive source-cut seal lock was weakened'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.guard_truth_source_cut_artifact_mutation()'::regprocedure
  )) into v_definition;
  if position('truth_source_cut_mutation_lock(v_workspace_key)' in v_definition) = 0
    or position('truth_source_cut_serialization_lock(v_workspace_key)' in v_definition) > 0 then
    raise exception 'source-cut artifact guard did not adopt the shared writer lock'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  )) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('expired_jobs as materialized' in v_definition) = 0
    or position('lineage_job_candidates as materialized' in v_definition) = 0
    or (length(v_definition) - length(replace(v_definition, 'for update of job skip locked', '')))
       / length('for update of job skip locked') < 3
    or position('gmail_resolve_entity_links' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0 then
    raise exception 'private claim authority is missing a concurrency or Gmail epoch guard'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_public_claim)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('private.claim_source_processing_jobs(' in v_definition) = 0 then
    raise exception 'public claim wrapper did not restore advisory-before-row ordering'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'public.complete_source_processing_job(uuid,text,bigint,text,jsonb,jsonb,jsonb,text)'::regprocedure
  )) into v_definition;
  if position('truth_source_cut_mutation_lock_for_job(p_job_id)' in v_definition) = 0 then
    raise exception 'completion wrapper did not adopt the shared writer lock'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'public.fail_source_processing_job(uuid,text,bigint,text,text,text,integer,text)'::regprocedure
  )) into v_definition;
  if position('truth_source_cut_mutation_lock_for_job(p_job_id)' in v_definition) = 0 then
    raise exception 'failure wrapper did not adopt the shared writer lock'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  )) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('truth_source_cut_serialization_lock(p_workspace_key)' in v_definition) > 0 then
    raise exception 'Gmail plan sealer did not adopt the shared writer lock'
      using errcode = '23514';
  end if;

  if not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_jobs_expired_lease_scope_idx'
    ) or not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'source_processing_jobs_claim_scope_kind_idx'
    ) then
    raise exception 'claim-concurrency partial indexes are missing'
      using errcode = '23514';
  end if;

  if has_function_privilege('anon', v_public_claim, 'EXECUTE')
    or has_function_privilege('authenticated', v_public_claim, 'EXECUTE')
    or not has_function_privilege('service_role', v_public_claim, 'EXECUTE') then
    raise exception 'public claim RPC privileges are invalid'
      using errcode = '42501';
  end if;
end;
$verify$;
