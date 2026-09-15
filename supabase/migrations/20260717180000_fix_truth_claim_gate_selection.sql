-- Keep the hot source-processing claim path on stock PostgreSQL planning while
-- bounding the two expensive shadow-model admission authorities.
--
-- The predecessor materialized every scoped runnable job before applying the
-- message-model and attachment-commissioning gates.  On production skew the
-- planner nested that materialization under lineage and re-evaluated an
-- expensive gate hundreds of times.  This forward rewrite preserves every
-- non-gate readiness predicate, ordering rule, SKIP LOCKED fence, claimed-row
-- mutation, and receipt byte shape.  It changes only candidate acquisition:
-- each mutually exclusive job class first locks at most p_limit cheap eligible
-- rows; model gates then evaluate only those bounded materialized rows; one
-- final ordering/limit produces the receipt.  The routing authorities keep
-- inadmissible gated jobs out of runnable states.  If that invariant drifts,
-- this bounded selector fails closed at its per-kind frontier instead of doing
-- an unbounded skip-ahead scan.

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
  if v_private is null or v_public is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'
    ) is null then
    raise exception 'bounded claim-gate selection prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_private)) into v_definition;
  if position('cheap_ordinary_claim_jobs as materialized' in v_definition) = 0
    and (
      position('scoped_claim_jobs as materialized' in v_definition) = 0
      or position('admitted_claim_jobs as materialized' in v_definition) = 0
      or position('truth_shadow_gmail_model_job_allowed_v3' in v_definition) = 0
      or position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0
      or position('for update of job skip locked' in v_definition) = 0
      or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
      or position('''claimedcount'', jsonb_array_length(v_jobs)' in v_definition) = 0
    ) then
    raise exception 'source-processing claim authority differs from reviewed predecessor'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_public)) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('return private.claim_source_processing_jobs(' in v_definition) = 0 then
    raise exception 'public source-processing claim wrapper differs from reviewed predecessor'
      using errcode = '23514';
  end if;
end;
$preflight$;

do $rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_updated text;
  v_start integer;
  v_finish integer;
  v_tail text;
  v_block text := $replacement$  with cheap_ordinary_claim_jobs as materialized (
    select job.job_id,
      case when job.job_kind = 'gmail_materialize_message_revision'
        then lineage.source_cursor_version else 0 end as sort_cursor_version,
      job.available_at, job.created_at
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
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_fetch_raw_message')
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_review_model_extraction')
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_extract_message_model_claims')
      and not (job.source_system = 'gmail'
        and job.connection_key like 'shadow-%'
        and job.job_kind = 'gmail_review_attachment_extraction')
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
  ), cheap_message_model_claim_jobs as materialized (
    select job.job_id, 0::bigint as sort_cursor_version,
      job.available_at, job.created_at
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
      and job.source_system = 'gmail'
      and job.job_kind = 'gmail_extract_message_model_claims'
      and lineage.source_cursor_value ~ '^[0-9]+$'
    order by job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit p_limit
  ), admitted_message_model_claim_jobs as materialized (
    select candidate.*
    from cheap_message_model_claim_jobs candidate
    where private.truth_shadow_gmail_model_job_allowed_v3(
      p_workspace_key, candidate.job_id
    )
  ), cheap_attachment_model_claim_jobs as materialized (
    select job.job_id, 0::bigint as sort_cursor_version,
      job.available_at, job.created_at
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
      and job.source_system = 'gmail'
      and job.connection_key like 'shadow-%'
      and job.job_kind = 'gmail_review_attachment_extraction'
      and lineage.source_cursor_value ~ '^[0-9]+$'
    order by job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit p_limit
  ), admitted_attachment_model_claim_jobs as materialized (
    select candidate.*
    from cheap_attachment_model_claim_jobs candidate
    where private.truth_shadow_model_commissioning_job_allowed(
      p_workspace_key, candidate.job_id
    )
  ), candidates as materialized (
    select admitted.job_id
    from (
      select * from cheap_ordinary_claim_jobs
      union all
      select * from admitted_message_model_claim_jobs
      union all
      select * from admitted_attachment_model_claim_jobs
    ) admitted
    order by admitted.sort_cursor_version,
      admitted.available_at, admitted.created_at, admitted.job_id
    limit p_limit
$replacement$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('cheap_ordinary_claim_jobs as materialized' in lower(v_definition)) = 0 then
    v_start := position('  with scoped_claim_jobs as materialized (' in v_definition);
    v_finish := position('  ), claimed as (' in v_definition);
    if v_start = 0 or v_finish <= v_start then
      raise exception 'source-processing predecessor candidate boundary is unavailable'
        using errcode = '23514';
    end if;
    v_tail := substring(v_definition from v_finish);
    v_updated := substring(v_definition from 1 for v_start - 1)
      || v_block || v_tail;
    if position('cheap_ordinary_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('cheap_message_model_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('admitted_message_model_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('cheap_attachment_model_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('admitted_attachment_model_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('scoped_claim_jobs as materialized' in lower(v_updated)) > 0
      or position('admitted_claim_jobs as materialized' in lower(v_updated)) > 0
      or substring(v_updated from position('  ), claimed as (' in v_updated))
        is distinct from v_tail then
      raise exception 'bounded post-limit claim-gate rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position('scoped_claim_jobs as materialized' in lower(v_definition)) > 0
    or position('admitted_claim_jobs as materialized' in lower(v_definition)) > 0 then
    raise exception 'bounded post-limit claim-gate selection is partially installed'
      using errcode = '23514';
  end if;
end;
$rewrite$;

-- Remove every inherited function-local planner, timeout, and cost setting.
-- The only retained proconfig is the security-definer search_path fence.
alter function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) reset all;
alter function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) set search_path = '';
alter function public.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) reset all;
alter function public.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) set search_path = '';

-- Restore stock function costs as well as stock planner/time-out settings.
-- These five functions are all on the hosted claim path; none may retain an
-- incident-era cost hint.
alter function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) cost 100;
alter function public.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) cost 100;
alter function private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)
  cost 100;
alter function private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)
  cost 100;
alter function private.truth_shadow_model_commissioning_job_allowed(text,uuid)
  cost 100;

revoke all on function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public, anon, authenticated, service_role;
revoke all on function public.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public, anon, authenticated;
grant execute on function public.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) to service_role;

do $verify$
declare
  v_private regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_public regprocedure := to_regprocedure(
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_public_definition text;
  v_private_config text[];
  v_public_config text[];
  v_nonstock_cost_count integer;
  v_message_limit integer;
  v_message_gate integer;
  v_attachment_limit integer;
  v_attachment_gate integer;
begin
  select lower(pg_get_functiondef(v_private)), proconfig
  into v_definition, v_private_config
  from pg_proc where oid = v_private;
  select lower(pg_get_functiondef(v_public)), proconfig
  into v_public_definition, v_public_config
  from pg_proc where oid = v_public;

  v_message_limit := position('limit p_limit' in substring(v_definition from
    position('cheap_message_model_claim_jobs as materialized' in v_definition)));
  v_message_gate := position('truth_shadow_gmail_model_job_allowed_v3' in
    substring(v_definition from
      position('cheap_message_model_claim_jobs as materialized' in v_definition)));
  v_attachment_limit := position('limit p_limit' in substring(v_definition from
    position('cheap_attachment_model_claim_jobs as materialized' in v_definition)));
  v_attachment_gate := position('truth_shadow_model_commissioning_job_allowed' in
    substring(v_definition from
      position('cheap_attachment_model_claim_jobs as materialized' in v_definition)));

  if position('cheap_ordinary_claim_jobs as materialized' in v_definition) = 0
    or position('cheap_message_model_claim_jobs as materialized' in v_definition) = 0
    or position('admitted_message_model_claim_jobs as materialized' in v_definition) = 0
    or position('cheap_attachment_model_claim_jobs as materialized' in v_definition) = 0
    or position('admitted_attachment_model_claim_jobs as materialized' in v_definition) = 0
    or position('scoped_claim_jobs as materialized' in v_definition) > 0
    or position('admitted_claim_jobs as materialized' in v_definition) > 0
    or v_message_limit = 0 or v_message_gate <= v_message_limit
    or v_attachment_limit = 0 or v_attachment_gate <= v_attachment_limit
    or (length(v_definition) - length(replace(
      v_definition, 'for update of job skip locked', ''
    ))) / length('for update of job skip locked') < 5
    or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('''claimedcount'', jsonb_array_length(v_jobs)' in v_definition) = 0 then
    raise exception 'bounded post-limit claim-gate authority failed read-back verification'
      using errcode = '23514';
  end if;

  if position('batch.status = ''committed''' in v_definition) = 0
    or position('batch.committed_cursor_version = lineage.source_cursor_version' in v_definition) = 0
    or position('batch.committed_cursor_value = lineage.source_cursor_value' in v_definition) = 0
    or position('lineage.source_cursor_value ~ ''^[0-9]+$''' in v_definition) = 0
    or position('gmail_fetch_raw_message' in v_definition) = 0
    or position('gmail_review_model_extraction' in v_definition) = 0
    or position('truth_gmail_link_epoch_members' in v_definition) = 0
    or position('truth_gmail_link_epoch_seals' in v_definition) = 0
    or position('gmail_message_materialization_groups' in v_definition) = 0
    or position('prior_job.state not in (''succeeded'', ''dead_letter'', ''superseded'')' in v_definition) = 0 then
    raise exception 'bounded claim selector lost a predecessor readiness fence'
      using errcode = '23514';
  end if;

  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_public_definition) = 0
    or position('return private.claim_source_processing_jobs(' in v_public_definition) = 0 then
    raise exception 'public claim wrapper behavior changed during gate restructure'
      using errcode = '23514';
  end if;

  if coalesce(cardinality(v_private_config), 0) <> 1
    or v_private_config[1] !~ '^search_path='
    or coalesce(cardinality(v_public_config), 0) <> 1
    or v_public_config[1] !~ '^search_path=' then
    raise exception 'cron-path claim functions retain a planner/timeout/cost override'
      using errcode = '23514';
  end if;

  select count(*)::integer
  into v_nonstock_cost_count
  from pg_proc
  where oid = any(array[
    v_private::oid,
    v_public::oid,
    'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)'::regprocedure::oid,
    'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)'::regprocedure::oid,
    'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'::regprocedure::oid
  ])
    and procost <> 100;
  if v_nonstock_cost_count <> 0 then
    raise exception 'cron-path claim authorities retain a non-stock cost hint'
      using errcode = '23514';
  end if;

  if has_function_privilege('anon', v_public, 'EXECUTE')
    or has_function_privilege('authenticated', v_public, 'EXECUTE')
    or not has_function_privilege('service_role', v_public, 'EXECUTE')
    or has_function_privilege('service_role', v_private, 'EXECUTE') then
    raise exception 'claim authority execute privileges are unsafe'
      using errcode = '42501';
  end if;

  if v_definition like '%' || 'shipment-' || 'truth-packets' || '%'
    or v_public_definition like '%' || 'shipment-' || 'truth-packets' || '%' then
    raise exception 'claim-gate restructure references the live board'
      using errcode = '23514';
  end if;
end;
$verify$;
