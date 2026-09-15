-- A bounded oldest-first readiness frontier can be permanently starved by
-- honest historical checkpoint gaps. Rank executable phases before applying
-- the bound, while preserving source chronology inside every phase. This is a
-- read-only selection repair: it does not resolve gaps or mutate any producer,
-- claim, cut, build, publication, Gmail, or operational state.

do $preflight$
declare
  v_definition text;
begin
  if to_regprocedure(
      'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'
    ) is null
    or to_regclass('public.truth_gmail_parse_checkpoint_late_parse_reconciliations') is null
    or to_regclass('public.truth_gmail_parse_absence_resolutions') is null
    or to_regclass('public.truth_gmail_link_epoch_dead_member_resolutions') is null
    or to_regclass('public.truth_gmail_live_dead_letter_authorizations') is null then
    raise exception 'Gmail readiness-liveness prerequisites are missing'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'::regprocedure
  ) into v_definition;
  if position('truth-gmail-claims-readiness-frontier-liveness-v1' in v_definition)=0
    and (
      position('checkpoint.terminal_gap_count = 0' in v_definition)=0
      or position('order by batch.committed_cursor_version, batch.batch_id' in v_definition)=0
      or position('limit p_limit' in v_definition)=0
    ) then
    raise exception 'unknown Gmail claims-readiness frontier predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.read_gmail_claims_readiness_frontier_v1(
  p_workspace_key text,
  p_connection_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  -- truth-gmail-claims-readiness-frontier-liveness-v1
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_floor bigint;
  v_batches jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or nullif(trim(coalesce(p_connection_key,'')),'') is null
    or p_limit is null or p_limit<1 or p_limit>25 then
    raise exception 'invalid Gmail claims-readiness frontier request'
      using errcode='22023';
  end if;

  if p_workspace_key='primary' and p_connection_key='primary' then
    select * into v_receipt
    from public.truth_gmail_backfill_parking_receipts receipt
    where receipt.parked_batch_id=
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
    if found then
      if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
        v_receipt
      ) then
        raise exception 'exact Gmail parking receipt failed frontier read-back'
          using errcode='23514';
      end if;
      v_floor:=v_receipt.resumed_cursor_version;
    end if;
  end if;

  with candidates as materialized (
    select
      batch.batch_id,
      batch.committed_cursor_version,
      checkpoint.checkpoint_id,
      checkpoint.checkpoint_hash,
      checkpoint.member_count as checkpoint_member_count,
      epoch.epoch_id,
      seal.epoch_id is not null as epoch_sealed,
      coalesce(
        checkpoint.checkpoint_id is not null
        and processing_epoch.epoch_id=checkpoint.processing_epoch_id
        and processing_epoch.epoch_hash=checkpoint.processing_epoch_hash
        and not exists(
          select 1
          from public.gmail_parse_checkpoint_members gap
          where gap.workspace_key=checkpoint.workspace_key
            and gap.root_batch_id=checkpoint.root_batch_id
            and gap.terminal_disposition not in(
              'parsed_exact_revision','deleted_at_cut'
            )
            and not exists(
              select 1
              from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
              where reconciliation.workspace_key=gap.workspace_key
                and reconciliation.gap_member_id=gap.member_id
                and reconciliation.checkpoint_id=checkpoint.checkpoint_id
                and reconciliation.checkpoint_hash=checkpoint.checkpoint_hash
            )
            and not exists(
              select 1
              from public.truth_gmail_parse_absence_resolutions absence
              where absence.workspace_key=gap.workspace_key
                and absence.gap_member_id=gap.member_id
                and absence.checkpoint_id=checkpoint.checkpoint_id
                and absence.checkpoint_hash=checkpoint.checkpoint_hash
            )
        ),
        false
      ) as checkpoint_ready
    from public.source_ingest_batches batch
    left join public.gmail_parse_checkpoints checkpoint
      on checkpoint.workspace_key=p_workspace_key
     and checkpoint.root_batch_id=batch.batch_id
     and checkpoint.connection_key=p_connection_key
     and checkpoint.source_cursor_version=batch.committed_cursor_version
     and checkpoint.source_cursor_value=batch.committed_cursor_value
    left join public.gmail_parse_processing_epochs processing_epoch
      on processing_epoch.workspace_key=checkpoint.workspace_key
     and processing_epoch.connection_key=checkpoint.connection_key
    left join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key=p_workspace_key
     and epoch.root_batch_id=batch.batch_id
     and epoch.connection_key=p_connection_key
    left join public.truth_gmail_link_epoch_seals seal
      on seal.workspace_key=epoch.workspace_key
     and seal.epoch_id=epoch.epoch_id
    where batch.workspace_key=p_workspace_key
      and batch.source_system='gmail'
      and batch.connection_key=p_connection_key
      and batch.status='committed'
      and batch.batch_hash~'^[0-9a-f]{64}$'
      and batch.committed_cursor_version is not null
      and batch.committed_cursor_value~'^[0-9]+$'
      and (v_floor is null or batch.committed_cursor_version>v_floor)
      and seal.epoch_id is null
  ), shaped as materialized (
    select
      candidate.*,
      coalesce(member.member_count,0) as link_member_count,
      coalesce(member.resolved_count,0) as resolved_link_member_count,
      coalesce(
        candidate.epoch_id is not null
        and not candidate.epoch_sealed
        and member.member_count=member.resolved_count,
        false
      ) as ready_to_seal
    from candidates candidate
    left join lateral (
      select
        count(*)::bigint as member_count,
        count(*) filter(where
          job.state='succeeded'
          or resolution.resolution_id is not null
          or (
            job.state='superseded'
            and legacy_ack.authorization_id is not null
          )
        )::bigint as resolved_count
      from public.truth_gmail_link_epoch_members epoch_member
      join public.source_processing_jobs job
        on job.workspace_key=epoch_member.workspace_key
       and job.job_id=epoch_member.link_job_id
      left join public.truth_gmail_link_epoch_dead_member_resolutions resolution
        on resolution.workspace_key=epoch_member.workspace_key
       and resolution.source_job_id=epoch_member.link_job_id
       and resolution.action_kind='exclude_missing_anchor_context_defect'
      left join public.truth_gmail_live_dead_letter_authorizations legacy_ack
        on legacy_ack.workspace_key=epoch_member.workspace_key
       and legacy_ack.source_job_id=epoch_member.link_job_id
       and legacy_ack.action_kind='terminal_ack_own_durable_resolution'
       and legacy_ack.proof_id<>''
       and legacy_ack.proof_hash~'^[0-9a-f]{64}$'
      where candidate.epoch_id is not null
        and epoch_member.workspace_key=p_workspace_key
        and epoch_member.epoch_id=candidate.epoch_id
    ) member on true
  ), ranked as (
    select shaped.*,
      case
        when shaped.ready_to_seal then 0
        when shaped.checkpoint_ready and shaped.epoch_id is null then 1
        when shaped.checkpoint_id is null then 2
        when shaped.epoch_id is not null then 3
        else 4
      end as readiness_phase
    from shaped
  ), bounded as materialized (
    select *
    from ranked
    order by readiness_phase,committed_cursor_version,batch_id
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rootBatchId',bounded.batch_id,
    'checkpointReady',bounded.checkpoint_ready,
    'epochId',bounded.epoch_id,
    'epochSealed',bounded.epoch_sealed,
    'readyToSeal',bounded.ready_to_seal
  ) order by bounded.readiness_phase,bounded.committed_cursor_version,
      bounded.batch_id),'[]'::jsonb)
  into v_batches
  from bounded;

  return jsonb_build_object(
    'ok',true,
    'batches',v_batches,
    'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function private.read_gmail_claims_readiness_frontier_v1(
  text,text,integer,text
) from public,anon,authenticated,service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'::regprocedure
  ) into v_definition;
  if position('truth-gmail-claims-readiness-frontier-liveness-v1' in v_definition)=0
    or position('readiness_phase' in v_definition)=0
    or position('truth_gmail_parse_absence_resolutions' in v_definition)=0
    or position('truth_gmail_link_epoch_dead_member_resolutions' in v_definition)=0
    or position('limit p_limit' in v_definition)=0 then
    raise exception 'Gmail readiness-liveness function verification failed'
      using errcode='23514';
  end if;
  select proconfig into v_config
  from pg_catalog.pg_proc
  where oid=
    'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'::regprocedure;
  if v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege(
      'anon',
      'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)',
      'EXECUTE'
    ) then
    raise exception 'Gmail readiness-liveness ACL/config is invalid'
      using errcode='55000';
  end if;
end;
$verify$;
