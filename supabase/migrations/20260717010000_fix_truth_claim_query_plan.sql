-- A bounded source-processing claim must remain coordinate-selective after
-- PL/pgSQL switches from custom to generic cached plans.  The installed queue
-- already uses SKIP LOCKED at every job-row acquisition point; this migration
-- does not weaken that lease/cut contract.  It adds the two missing scope
-- indexes and forces the private authority to plan against each exact
-- workspace/source/connection/job-kind request.

create schema if not exists private;

do $preflight$
declare
  v_private regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_public regprocedure := to_regprocedure(
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
begin
  if v_private is null or v_public is null then
    raise exception 'source-processing claim authorities are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_private)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('expired_jobs as materialized' in v_definition) = 0
    or position('lineage_job_candidates as materialized' in v_definition) = 0
    or position('for update of job skip locked' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0 then
    raise exception 'private claim authority differs from the reviewed concurrency contract'
      using errcode = '23514';
  end if;
end;
$preflight$;

create index if not exists source_processing_jobs_lineage_bootstrap_scope_idx
  on public.source_processing_jobs (
    workspace_key,
    source_system,
    connection_key,
    job_id
  );

create index if not exists source_processing_job_lineage_claim_scope_idx
  on public.source_processing_job_lineage (
    workspace_key,
    source_system,
    connection_key,
    job_id
  )
  include (
    root_batch_id,
    source_cursor_version,
    source_cursor_value
  );

alter function private.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) set plan_cache_mode = 'force_custom_plan';

alter function public.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) set plan_cache_mode = 'force_custom_plan';

-- The production table already contains a large mailbox frontier.  Refreshing
-- column statistics here ensures the first post-migration claim sees the new
-- access paths instead of waiting for autovacuum's next analyze cycle.
analyze public.source_processing_jobs;
analyze public.source_processing_job_lineage;

do $verify$
declare
  v_private regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_public regprocedure := to_regprocedure(
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_private_config text[];
  v_public_config text[];
  v_definition text;
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'source_processing_jobs_lineage_bootstrap_scope_idx'
      and lower(indexdef) like
        '%(workspace_key, source_system, connection_key, job_id)%'
  ) then
    raise exception 'job lineage-bootstrap scope index is missing or malformed'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'source_processing_job_lineage_claim_scope_idx'
      and lower(indexdef) like
        '%(workspace_key, source_system, connection_key, job_id)%'
      and lower(indexdef) like
        '%include (root_batch_id, source_cursor_version, source_cursor_value)%'
  ) then
    raise exception 'lineage claim-scope index is missing or malformed'
      using errcode = '23514';
  end if;

  select proconfig into v_private_config from pg_proc where oid = v_private;
  select proconfig into v_public_config from pg_proc where oid = v_public;
  if not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_private_config, array[]::text[])
    ))
    or not ('plan_cache_mode=force_custom_plan' = any(
      coalesce(v_public_config, array[]::text[])
    )) then
    raise exception 'claim authorities did not adopt coordinate-specific planning'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_private)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or (length(v_definition) - length(replace(v_definition, 'skip locked', '')))
      / length('skip locked') < 3 then
    raise exception 'claim plan repair weakened the cut lock or SKIP LOCKED coverage'
      using errcode = '23514';
  end if;
end;
$verify$;
