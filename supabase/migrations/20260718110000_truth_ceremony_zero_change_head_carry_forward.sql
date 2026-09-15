-- A committed Gmail history poll with no provider events advances the journal
-- version but does not advance the evidence frontier. During the one-time
-- production ceremony, permit the latest completed acceptance epoch to cover
-- only an exact contiguous suffix of such zero-change batches. The source cut
-- still binds the current live cursor; no cursor, claim, or publication state
-- is mutated by this authority.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_register text;
  v_seal text;
begin
  if to_regclass('public.source_cursors') is null
    or to_regclass('public.source_ingest_batches') is null
    or to_regclass('public.gmail_ingest_pages') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.register_truth_shadow_root_source_cut(text)') is null
    or to_regprocedure(
      'private.seal_truth_shadow_root_source_cut(text,text,text,text)'
    ) is null then
    raise exception 'truth ceremony zero-change head prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.register_truth_shadow_root_source_cut(text)'::regprocedure
  ) into v_register;
  select pg_get_functiondef(
    'private.seal_truth_shadow_root_source_cut(text,text,text,text)'::regprocedure
  ) into v_seal;
  if position(
      'shadow source cut cursor is not covered by an exact epoch head'
      in v_register
    )=0
    or position('private.register_truth_shadow_root_source_cut' in v_seal)=0
    or position('truth-source-cut-serialization-v1:' in v_seal)=0 then
    raise exception 'truth ceremony root-cut functions differ from reviewed contracts'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_zero_change_successor_span_valid_v1(
  p_workspace_key text,
  p_connection_key text,
  p_accepted_root_batch_id uuid,
  p_accepted_cursor_version bigint,
  p_accepted_cursor_value text,
  p_live_cursor_version bigint,
  p_live_cursor_value text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $function$
  with suffix as materialized (
    select batch.*
    from public.source_ingest_batches batch
    where batch.workspace_key=p_workspace_key
      and batch.source_system='gmail'
      and batch.connection_key=p_connection_key
      and batch.committed_cursor_version>p_accepted_cursor_version
      and batch.committed_cursor_version<=p_live_cursor_version
  )
  select p_workspace_key='primary'
    and p_connection_key='primary'
    and p_live_cursor_version>p_accepted_cursor_version
    and p_live_cursor_value=p_accepted_cursor_value
    and exists (
      select 1
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=p_workspace_key
        and epoch.source_system='gmail'
        and epoch.connection_key=p_connection_key
        and epoch.root_batch_id=p_accepted_root_batch_id
        and epoch.source_cursor_version=p_accepted_cursor_version
        and epoch.source_cursor_value=p_accepted_cursor_value
    )
    and exists (
      select 1
      from public.source_cursors cursor_row
      join public.source_ingest_batches live_batch
        on live_batch.workspace_key=cursor_row.workspace_key
       and live_batch.batch_id=cursor_row.last_batch_id
      where cursor_row.workspace_key=p_workspace_key
        and cursor_row.source_system='gmail'
        and cursor_row.connection_key=p_connection_key
        and cursor_row.status='live'
        and cursor_row.cursor_version=p_live_cursor_version
        and cursor_row.cursor_value=p_live_cursor_value
        and live_batch.source_system='gmail'
        and live_batch.connection_key=p_connection_key
        and live_batch.status='committed'
        and live_batch.committed_cursor_version=p_live_cursor_version
        and live_batch.committed_cursor_value=p_live_cursor_value
    )
    and (select count(*) from suffix)=
      (p_live_cursor_version-p_accepted_cursor_version)
    and not exists (
      select 1 from suffix batch
      where batch.mode<>'history'
        or batch.trigger_name<>'truth-shadow-orchestrator-v1:incremental'
        or batch.status<>'committed'
        or batch.committed_cursor_value<>p_accepted_cursor_value
        or batch.page_count<>1
        or batch.observation_count<>0
        or batch.job_count<>0
        or batch.batch_hash is null
    )
    and not exists (
      select 1 from suffix batch
      where not exists (
        select 1
        from public.gmail_ingest_pages page
        where page.batch_id=batch.batch_id
          and page.page_ordinal=0
          and page.request_page_token=''
          and page.response_next_page_token=''
          and page.response_mailbox_history_id=p_accepted_cursor_value
          and page.first_history_id=''
          and page.last_history_id=''
          and page.event_count=0
          and page.job_count=0
          and page.provider_event_manifest='[]'::jsonb
          and page.is_final=true
      )
      or (select count(*) from public.gmail_ingest_pages page
          where page.batch_id=batch.batch_id)<>1
    )
    and not exists (
      select 1
      from public.source_observations observation
      join suffix batch on batch.batch_id=observation.batch_id
    )
    and not exists (
      select 1
      from public.gmail_ingest_page_observations membership
      join suffix batch on batch.batch_id=membership.batch_id
    )
    and not exists (
      select 1
      from public.gmail_ingest_page_jobs membership
      join suffix batch on batch.batch_id=membership.batch_id
    )
    and not exists (
      select 1
      from public.source_processing_job_lineage lineage
      join suffix batch on batch.batch_id=lineage.root_batch_id
    )
    and not exists (
      select 1
      from public.truth_pending_acceptance_epochs pending
      where pending.workspace_key=p_workspace_key
        and pending.source_system='gmail'
        and pending.connection_key=p_connection_key
        and pending.source_cursor_version>p_accepted_cursor_version
        and pending.source_cursor_version<=p_live_cursor_version
    )
    and not exists (
      select 1
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=p_workspace_key
        and epoch.source_system='gmail'
        and epoch.connection_key=p_connection_key
        and epoch.source_cursor_version>p_accepted_cursor_version
        and epoch.source_cursor_version<=p_live_cursor_version
    );
$function$;

revoke all on function private.truth_gmail_zero_change_successor_span_valid_v1(
  text,text,uuid,bigint,text,bigint,text
) from public,anon,authenticated,service_role;

create or replace function private.read_truth_ceremony_gmail_head_v1(
  p_workspace_key text,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_pending public.truth_pending_acceptance_epochs%rowtype;
  v_epoch public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_mode text:='none';
  v_accepted boolean:=false;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key<>'primary' then
    raise exception 'truth ceremony Gmail head is restricted to primary'
      using errcode='42501';
  end if;
  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key=p_workspace_key
    and cursor_row.source_system='gmail'
    and cursor_row.connection_key='primary'
    and cursor_row.status='live';

  select * into v_pending
  from public.truth_pending_acceptance_epochs pending
  where pending.workspace_key=p_workspace_key
    and pending.source_system='gmail'
    and pending.connection_key='primary'
    and pending.root_batch_id=v_cursor.last_batch_id
    and pending.source_cursor_version=v_cursor.cursor_version
    and pending.source_cursor_value=v_cursor.cursor_value;
  if found then
    select * into v_epoch
    from public.truth_shadow_claim_acceptance_epochs epoch
    where epoch.workspace_key=p_workspace_key
      and epoch.obligation_id=v_pending.obligation_id
      and epoch.obligation_hash=v_pending.obligation_hash
      and epoch.root_batch_id=v_pending.root_batch_id
      and epoch.source_cursor_version=v_pending.source_cursor_version
      and epoch.source_cursor_value=v_pending.source_cursor_value;
    v_accepted:=found;
    v_mode:=case when v_accepted then 'exact_accepted' else 'exact_pending' end;
  else
    select * into v_epoch
    from public.truth_shadow_claim_acceptance_epochs epoch
    where epoch.workspace_key=p_workspace_key
      and epoch.source_system='gmail'
      and epoch.connection_key='primary'
      and epoch.source_cursor_version<v_cursor.cursor_version
    order by epoch.source_cursor_version desc,epoch.epoch_id desc
    limit 1;
    if found and private.truth_gmail_zero_change_successor_span_valid_v1(
      p_workspace_key,'primary',v_epoch.root_batch_id,
      v_epoch.source_cursor_version,v_epoch.source_cursor_value,
      v_cursor.cursor_version,v_cursor.cursor_value
    ) then
      v_accepted:=true;
      v_mode:='zero_change_carry_forward';
    else
      v_epoch:=null;
    end if;
  end if;

  return jsonb_build_object(
    'ok',true,
    'rootBatchId',v_cursor.last_batch_id,
    'sourceCursorVersion',v_cursor.cursor_version,
    'sourceCursorValue',v_cursor.cursor_value,
    'obligationId',coalesce(v_epoch.obligation_id,v_pending.obligation_id,''),
    'accepted',v_accepted,
    'acceptanceMode',v_mode,
    'acceptedRootBatchId',coalesce(v_epoch.root_batch_id::text,''),
    'acceptedCursorVersion',coalesce(v_epoch.source_cursor_version,0),
    'zeroChangeSuccessorCount',case when v_mode='zero_change_carry_forward'
      then v_cursor.cursor_version-v_epoch.source_cursor_version else 0 end,
    'sourceCursorMutated',false,
    'candidateClaimsCreated',false,
    'productionPublicationAttempted',false,
    'mutatesOperationalState',false
  );
end;
$function$;

create or replace function public.read_truth_ceremony_gmail_head(
  p_workspace_key text,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $function$
  select private.read_truth_ceremony_gmail_head_v1(
    p_workspace_key,p_sync_token
  );
$function$;

revoke all on function private.read_truth_ceremony_gmail_head_v1(text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.read_truth_ceremony_gmail_head(text,text)
  from public,anon,authenticated;
grant execute on function public.read_truth_ceremony_gmail_head(text,text)
  to service_role;

do $rewrite_register$
declare
  v_signature regprocedure:=
    'private.register_truth_shadow_root_source_cut(text)'::regprocedure;
  v_definition text;
  v_old text:=$old$  if v_latest_epoch.source_cursor_version is distinct from
      v_cursor.through_cursor_version
    or v_latest_epoch.source_cursor_value is distinct from
      v_cursor.through_cursor_value then
    raise exception 'shadow source cut cursor is not covered by an exact epoch head'
      using errcode = '23514';
  end if;$old$;
  v_new text:=$new$  if (
    v_latest_epoch.source_cursor_version is distinct from
      v_cursor.through_cursor_version
    or v_latest_epoch.source_cursor_value is distinct from
      v_cursor.through_cursor_value
  ) and not private.truth_gmail_zero_change_successor_span_valid_v1(
    v_cut.workspace_key,v_cursor.connection_key,v_latest_epoch.root_batch_id,
    v_latest_epoch.source_cursor_version,v_latest_epoch.source_cursor_value,
    v_cursor.through_cursor_version,v_cursor.through_cursor_value
  ) then
    raise exception 'shadow source cut cursor is not covered by an exact epoch head'
      using errcode = '23514';
  end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_zero_change_successor_span_valid_v1' in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'truth ceremony register rewrite did not match installed function'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite_register$;

do $rewrite_seal$
declare
  v_signature regprocedure:=
    'private.seal_truth_shadow_root_source_cut(text,text,text,text)'::regprocedure;
  v_definition text;
  v_old text:=$old$  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = p_workspace_key
    and cursor_row.source_system = v_epoch.source_system
    and cursor_row.connection_key = v_epoch.connection_key
    and cursor_row.cursor_version = v_epoch.source_cursor_version
    and cursor_row.cursor_value = v_epoch.source_cursor_value
    and cursor_row.last_batch_id = v_epoch.root_batch_id
    and cursor_row.status = 'live';$old$;
  v_new text:=$new$  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = p_workspace_key
    and cursor_row.source_system = v_epoch.source_system
    and cursor_row.connection_key = v_epoch.connection_key
    and cursor_row.status = 'live';
  if not (
    (
      v_cursor.cursor_version = v_epoch.source_cursor_version
      and v_cursor.cursor_value = v_epoch.source_cursor_value
      and v_cursor.last_batch_id = v_epoch.root_batch_id
    )
    or private.truth_gmail_zero_change_successor_span_valid_v1(
      p_workspace_key,v_epoch.connection_key,v_epoch.root_batch_id,
      v_epoch.source_cursor_version,v_epoch.source_cursor_value,
      v_cursor.cursor_version,v_cursor.cursor_value
    )
  ) then
    raise exception 'completed shadow acceptance epoch does not cover live Gmail head'
      using errcode='23514';
  end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('completed shadow acceptance epoch does not cover live Gmail head'
      in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'truth ceremony seal rewrite did not match installed function'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite_seal$;

do $verify$
declare
  v_register text;
  v_seal text;
  v_reader text;
  v_helper text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.register_truth_shadow_root_source_cut(text)'::regprocedure
  ) into v_register;
  select pg_get_functiondef(
    'private.seal_truth_shadow_root_source_cut(text,text,text,text)'::regprocedure
  ) into v_seal;
  select pg_get_functiondef(
    'private.read_truth_ceremony_gmail_head_v1(text,text)'::regprocedure
  ) into v_reader;
  select pg_get_functiondef(
    'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)'::regprocedure
  ) into v_helper;
  if position('truth_gmail_zero_change_successor_span_valid_v1' in v_register)=0
    or position('completed shadow acceptance epoch does not cover live Gmail head'
      in v_seal)=0
    or position('zero_change_carry_forward' in v_reader)=0
    or position('gmail_ingest_page_observations' in v_helper)=0
    or position('gmail_ingest_page_jobs' in v_helper)=0
    or position('source_processing_job_lineage' in v_helper)=0
    or position('truth_pending_acceptance_epochs' in v_helper)=0
    or position('productionPublicationAttempted'',false' in v_reader)=0 then
    raise exception 'truth ceremony zero-change authority is incomplete'
      using errcode='55000';
  end if;
  select proconfig into v_config from pg_catalog.pg_proc
  where oid='public.read_truth_ceremony_gmail_head(text,text)'::regprocedure;
  if v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege('anon',
      'public.read_truth_ceremony_gmail_head(text,text)','execute')
    or has_function_privilege('authenticated',
      'public.read_truth_ceremony_gmail_head(text,text)','execute')
    or not has_function_privilege('service_role',
      'public.read_truth_ceremony_gmail_head(text,text)','execute') then
    raise exception 'truth ceremony Gmail head ACL/config is unsafe'
      using errcode='55000';
  end if;
  if position('update public.source_cursors' in v_helper||v_reader||v_register||v_seal)>0
    or position('insert into public.accepted_claims' in v_helper||v_reader)>0
    or position('truth_publications' in v_helper||v_reader)>0 then
    raise exception 'truth ceremony zero-change authority can mutate forbidden state'
      using errcode='55000';
  end if;
end;
$verify$;
