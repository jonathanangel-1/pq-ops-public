-- Hosted Gmail canonical-acceptance readiness spine.
--
-- Candidate manifests already mint one content-addressed pending acceptance
-- obligation and one waiting-runtime sequencing job per committed root batch.
-- The acceptance coordinator was originally fenced to an unregistered
-- shadow-* connection whose batch was also the current cursor head.  Hosted
-- Gmail advances the cursor every tick, so older complete forward batches can
-- never satisfy that second condition.  This migration admits only the exact
-- receipt-certified primary/primary forward world created by the claims-
-- readiness spine, exposes its oldest-first read-only frontier, and leaves the
-- existing acceptance policy and atomic sequencing-job completion unchanged.
-- It never publishes and does not weaken any candidate/review/frontier check.

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.truth_pending_acceptance_epochs') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.gmail_parse_processing_epochs') is null
    or to_regprocedure(
      'private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(public.gmail_parse_processing_epochs)'
    ) is null
    or to_regprocedure(
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
    ) is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.gmail_history_id_at_least(text,text)') is null then
    raise exception 'Gmail acceptance-readiness prerequisites are missing'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('truth-shadow-claim-acceptance-epoch-v2' in v_definition) = 0
    or position('truth_shadow_review_decision_adoption_v1' in v_definition) = 0
    or position('truth-source-cut-serialization-v1:' in v_definition) = 0
    or position('ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED' in v_definition) = 0 then
    raise exception 'Gmail acceptance coordinator is not the reviewed mixed-authority runtime'
      using errcode = '23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_live_acceptance_scope_valid_v1(
  p_pending public.truth_pending_acceptance_epochs
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_boundary public.gmail_parse_processing_epochs%rowtype;
  v_floor bigint;
begin
  if p_pending.workspace_key is distinct from 'primary'
    or p_pending.source_system is distinct from 'gmail'
    or p_pending.connection_key is distinct from 'primary'
    or p_pending.schema_version is distinct from
      'pending-acceptance-epoch-obligation-v1'
    or p_pending.obligation_id is distinct from
      'pending-acceptance-epoch:v1:' || p_pending.obligation_hash
    or p_pending.obligation_hash is distinct from encode(extensions.digest(
      convert_to(private.truth_canonical_json_text(
        p_pending.canonical_obligation
      ), 'UTF8'), 'sha256'
    ), 'hex')
    or p_pending.canonical_obligation is distinct from jsonb_build_object(
      'schemaVersion', 'pending-acceptance-epoch-obligation-v1',
      'workspaceKey', p_pending.workspace_key,
      'sourceSystem', p_pending.source_system,
      'connectionKey', p_pending.connection_key,
      'rootBatchId', p_pending.root_batch_id,
      'sourceCursorVersion', p_pending.source_cursor_version,
      'sourceCursorValue', p_pending.source_cursor_value,
      'blockerCode', 'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
    ) then
    return false;
  end if;

  select * into v_boundary
  from public.gmail_parse_processing_epochs epoch
  where epoch.workspace_key = p_pending.workspace_key
    and epoch.connection_key = p_pending.connection_key;
  if not found
    or not private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
      v_boundary
    ) then
    return false;
  end if;
  v_floor := (v_boundary.canonical_epoch#>>
    '{parkedCompletenessBoundary,resumedCursorVersion}')::bigint;

  return p_pending.source_cursor_version > v_floor
    and private.gmail_history_id_at_least(
      p_pending.source_cursor_value,
      v_boundary.canonical_epoch#>>
        '{parkedCompletenessBoundary,cutoverHistoryId}'
    )
    and exists (
      select 1
      from public.source_ingest_batches batch
      where batch.workspace_key = p_pending.workspace_key
        and batch.batch_id = p_pending.root_batch_id
        and batch.source_system = p_pending.source_system
        and batch.connection_key = p_pending.connection_key
        and batch.status = 'committed'
        and batch.committed_cursor_version = p_pending.source_cursor_version
        and batch.committed_cursor_value = p_pending.source_cursor_value
        and batch.batch_hash ~ '^[0-9a-f]{64}$'
    )
    and exists (
      select 1
      from public.source_cursors cursor_row
      where cursor_row.workspace_key = p_pending.workspace_key
        and cursor_row.source_system = p_pending.source_system
        and cursor_row.connection_key = p_pending.connection_key
        and cursor_row.status = 'live'
        and cursor_row.cursor_version >= p_pending.source_cursor_version
        and private.gmail_history_id_at_least(
          cursor_row.cursor_value, p_pending.source_cursor_value
        )
    );
end;
$function$;

revoke all on function private.truth_gmail_live_acceptance_scope_valid_v1(
  public.truth_pending_acceptance_epochs
) from public, anon, authenticated, service_role;

do $rewrite_live_scope$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  if v_pending.source_system <> 'gmail'
    or v_pending.connection_key not like 'shadow-%'
    or exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = v_pending.workspace_key
        and required_source.source_system = v_pending.source_system
        and required_source.connection_key = v_pending.connection_key
    ) then$old$;
  v_new text := $new$  if v_pending.source_system <> 'gmail'
    or not (
      (
        v_pending.connection_key like 'shadow-%'
        and not exists (
          select 1
          from public.truth_required_sources required_source
          where required_source.workspace_key = v_pending.workspace_key
            and required_source.source_system = v_pending.source_system
            and required_source.connection_key = v_pending.connection_key
        )
      )
      or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)
    ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
      'or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)'
      in v_definition
    ) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'Gmail acceptance live-scope rewrite did not match reviewed runtime'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_live_scope$;

do $rewrite_forward_cursor$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    or not exists (
      select 1
      from public.source_cursors cursor_row
      where cursor_row.workspace_key = p_workspace_key
        and cursor_row.source_system = v_pending.source_system
        and cursor_row.connection_key = v_pending.connection_key
        and cursor_row.cursor_version = v_pending.source_cursor_version
        and cursor_row.cursor_value = v_pending.source_cursor_value
        and cursor_row.last_batch_id = v_pending.root_batch_id
        and cursor_row.status = 'live'
    ) then$old$;
  v_new text := $new$    or not (
      exists (
        select 1
        from public.source_cursors cursor_row
        where cursor_row.workspace_key = p_workspace_key
          and cursor_row.source_system = v_pending.source_system
          and cursor_row.connection_key = v_pending.connection_key
          and cursor_row.cursor_version = v_pending.source_cursor_version
          and cursor_row.cursor_value = v_pending.source_cursor_value
          and cursor_row.last_batch_id = v_pending.root_batch_id
          and cursor_row.status = 'live'
      )
      or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)
    ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if (length(v_definition) - length(replace(
      v_definition,
      'private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)', ''
    ))) / length('private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)') < 2 then
    if position(v_old in v_definition) = 0 then
      raise exception 'Gmail acceptance forward-cursor rewrite did not match reviewed runtime'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_forward_cursor$;

create or replace function private.read_gmail_acceptance_readiness_frontier_v1(
  p_workspace_key text,
  p_connection_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_batches jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'invalid Gmail acceptance-readiness frontier request'
      using errcode = '22023';
  end if;

  with pending as materialized (
    select epoch.*
    from public.truth_pending_acceptance_epochs epoch
    join public.source_processing_jobs sequence_job
      on sequence_job.workspace_key = epoch.workspace_key
     and sequence_job.job_id = epoch.pending_job_id
    where epoch.workspace_key = p_workspace_key
      and epoch.source_system = 'gmail'
      and epoch.connection_key = p_connection_key
      and (
        sequence_job.state <> 'succeeded'
        or not exists (
          select 1
          from public.truth_shadow_claim_acceptance_epochs completed
          where completed.workspace_key = epoch.workspace_key
            and completed.obligation_id = epoch.obligation_id
            and completed.obligation_hash = epoch.obligation_hash
        )
      )
    order by epoch.source_cursor_version, epoch.root_batch_id
    limit p_limit
  ), shaped as (
    select pending.root_batch_id,
           pending.source_cursor_version,
           pending.obligation_id,
           coalesce(completed.obligation_id is not null
             and sequence_job.state = 'succeeded'
             and sequence_job.result->>'epochId' = completed.epoch_id
             and sequence_job.result->>'epochReceiptHash' = completed.receipt_hash,
             false) as acceptance_complete,
           coalesce(
             private.truth_gmail_live_acceptance_scope_valid_v1(pending)
             and sequence_job.job_kind = 'truth_sequence_claim_acceptance_epoch'
             and sequence_job.source_object_id = pending.root_batch_id::text
             and sequence_job.state = 'waiting_runtime'
             and sequence_job.attempt_count = 0
             and sequence_job.lease_owner is null
             and sequence_job.lease_expires_at is null
             and sequence_job.last_error_code =
               'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
             and sequence_job.payload->>'obligationId' = pending.obligation_id
             and exists (
               select 1 from public.gmail_parse_checkpoints checkpoint
               where checkpoint.workspace_key = pending.workspace_key
                 and checkpoint.root_batch_id = pending.root_batch_id
                 and checkpoint.connection_key = pending.connection_key
                 and checkpoint.source_cursor_version =
                   pending.source_cursor_version
                 and checkpoint.source_cursor_value = pending.source_cursor_value
                 and checkpoint.terminal_gap_count = 0
             )
             and exists (
               select 1
               from public.truth_gmail_link_epochs link_epoch
               join public.truth_gmail_link_epoch_seals link_seal
                 on link_seal.workspace_key = link_epoch.workspace_key
                and link_seal.epoch_id = link_epoch.epoch_id
               where link_epoch.workspace_key = pending.workspace_key
                 and link_epoch.root_batch_id = pending.root_batch_id
                 and link_epoch.connection_key = pending.connection_key
             )
             and not exists (
               select 1
               from public.source_processing_jobs producer
               join public.source_processing_job_lineage producer_lineage
                 on producer_lineage.job_id = producer.job_id
                and producer_lineage.workspace_key = producer.workspace_key
               where producer.workspace_key = pending.workspace_key
                 and producer_lineage.root_batch_id = pending.root_batch_id
                 and producer.job_kind = any(array[
                   'gmail_materialize_message_revision',
                   'gmail_parse_rfc822','gmail_parse_message',
                   'gmail_extract_attachment',
                   'gmail_review_attachment_extraction'
                 ])
                 and producer.state not in ('succeeded','superseded')
             )
             and not exists (
               select 1 from public.truth_pending_acceptance_epochs prior
               where prior.workspace_key = pending.workspace_key
                 and prior.source_system = pending.source_system
                 and prior.connection_key = pending.connection_key
                 and prior.source_cursor_version < pending.source_cursor_version
                 and not exists (
                   select 1
                   from public.truth_shadow_claim_acceptance_epochs prior_done
                   where prior_done.workspace_key = prior.workspace_key
                     and prior_done.obligation_id = prior.obligation_id
                     and prior_done.obligation_hash = prior.obligation_hash
                 )
             )
             and claims.job_count > 0
             and claims.job_count = manifests.member_count
             and claims.job_count = claims.complete_count,
             false
           ) as frontier_sealed
    from pending
    join public.source_processing_jobs sequence_job
      on sequence_job.workspace_key = pending.workspace_key
     and sequence_job.job_id = pending.pending_job_id
    left join public.truth_shadow_claim_acceptance_epochs completed
      on completed.workspace_key = pending.workspace_key
     and completed.obligation_id = pending.obligation_id
     and completed.obligation_hash = pending.obligation_hash
    left join lateral (
      select count(*)::bigint as job_count,
             count(*) filter (where claim_job.state = 'succeeded'
               and manifest.job_id is not null
               and member.source_job_id is not null
               and manifest.source_observation_id = claim_job.observation_id
               and member.source_observation_id = claim_job.observation_id
               and member.candidate_count = manifest.candidate_count
               and member.candidate_manifest_hash = manifest.manifest_hash
             )::bigint as complete_count
      from public.source_processing_jobs claim_job
      join public.source_processing_job_lineage claim_lineage
        on claim_lineage.job_id = claim_job.job_id
       and claim_lineage.workspace_key = claim_job.workspace_key
      left join public.candidate_claim_job_manifests manifest
        on manifest.workspace_key = claim_job.workspace_key
       and manifest.job_id = claim_job.job_id
      left join public.truth_pending_acceptance_epoch_manifests member
        on member.workspace_key = claim_job.workspace_key
       and member.obligation_id = pending.obligation_id
       and member.source_job_id = claim_job.job_id
      where claim_job.workspace_key = pending.workspace_key
        and claim_job.source_system = pending.source_system
        and claim_job.connection_key = pending.connection_key
        and claim_lineage.root_batch_id = pending.root_batch_id
        and claim_job.job_kind = any(array[
          'gmail_extract_message_claims','gmail_extract_attachment_claims'
        ])
    ) claims on true
    left join lateral (
      select count(*)::bigint as member_count
      from public.truth_pending_acceptance_epoch_manifests member
      where member.workspace_key = pending.workspace_key
        and member.obligation_id = pending.obligation_id
    ) manifests on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rootBatchId', shaped.root_batch_id,
    'obligationId', shaped.obligation_id,
    'frontierSealed', shaped.frontier_sealed,
    'acceptanceComplete', shaped.acceptance_complete,
    'readyToRun', shaped.frontier_sealed and not shaped.acceptance_complete
  ) order by shaped.source_cursor_version, shaped.root_batch_id), '[]'::jsonb)
  into v_batches
  from shaped;

  return jsonb_build_object(
    'ok', true,
    'batches', v_batches,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_gmail_acceptance_readiness_frontier(
  p_workspace_key text,
  p_connection_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_gmail_acceptance_readiness_frontier_v1(
    p_workspace_key, p_connection_key, p_limit, p_sync_token
  );
$function$;

revoke all on function private.read_gmail_acceptance_readiness_frontier_v1(
  text,text,integer,text
) from public, anon, authenticated, service_role;
revoke all on function public.read_gmail_acceptance_readiness_frontier(
  text,text,integer,text
) from public, anon, authenticated;
grant execute on function public.read_gmail_acceptance_readiness_frontier(
  text,text,integer,text
) to service_role;

do $verify$
declare
  v_definition text;
  v_frontier text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  select pg_get_functiondef(
    'private.read_gmail_acceptance_readiness_frontier_v1(text,text,integer,text)'::regprocedure
  ) into v_frontier;
  if (length(v_definition) - length(replace(
      v_definition,
      'private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)', ''
    ))) / length('private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)') <> 2
    or position('truth_shadow_review_decision_adoption_v1' in v_definition) = 0
    or position('SHADOW_CANDIDATE_V1_POLICY_REVIEW' in v_definition) = 0
    or position('truth-source-cut-serialization-v1:' in v_definition) = 0 then
    raise exception 'Gmail acceptance live adapter is incomplete or weakened'
      using errcode = '55000';
  end if;
  if position('update public.source_processing_jobs job' in v_definition) = 0
    or position('truth-claim-acceptance-epoch-result-v2' in v_definition) = 0
    or position('job.state = ''waiting_runtime''' in v_definition) = 0
    or position('job.attempt_count = 0' in v_definition) = 0 then
    raise exception 'acceptance sequencing-job terminal adapter is missing'
      using errcode = '55000';
  end if;
  if position('private.valid_truth_sync_token(p_sync_token)' in v_frontier) = 0
    or position('limit p_limit' in v_frontier) = 0
    or position('EARLIER_ACCEPTANCE_EPOCH_INCOMPLETE' in v_definition) = 0
    or position('truth_pending_acceptance_epoch_manifests' in v_frontier) = 0
    or position('productionPublicationAttempted'', false' in v_frontier) = 0 then
    raise exception 'Gmail acceptance-readiness frontier is incomplete'
      using errcode = '55000';
  end if;
  select proconfig into v_config from pg_catalog.pg_proc
  where oid = 'public.read_gmail_acceptance_readiness_frontier(text,text,integer,text)'::regprocedure;
  if v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon',
      'public.read_gmail_acceptance_readiness_frontier(text,text,integer,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.read_gmail_acceptance_readiness_frontier(text,text,integer,text)',
      'execute')
    or not has_function_privilege('service_role',
      'public.read_gmail_acceptance_readiness_frontier(text,text,integer,text)',
      'execute') then
    raise exception 'Gmail acceptance frontier ACL/config is unsafe'
      using errcode = '55000';
  end if;
  if position('shipment-truth-packets' in v_definition || v_frontier) > 0
    or position('truth_publications' in v_definition || v_frontier) > 0 then
    raise exception 'Gmail acceptance readiness references publication state'
      using errcode = '55000';
  end if;
end;
$verify$;
