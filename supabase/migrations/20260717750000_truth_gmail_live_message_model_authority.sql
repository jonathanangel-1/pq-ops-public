-- Extend the reviewed Gmail MESSAGE-model commissioning lane to the exact
-- receipt-certified primary forward world. Shadow admission is unchanged.
-- This migration writes authority/retry receipts only; it never accepts a
-- candidate claim, publishes truth, or changes a model budget.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_signature text;
begin
  foreach v_signature in array array[
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)',
    'private.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)',
    'private.resolve_truth_shadow_gmail_model_review_job(text,text,uuid,uuid,text,jsonb,text,text,text,text,text)',
    'private.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
    'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)',
    'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)',
    'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)',
    'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'live Gmail message-model prerequisite is unavailable: %', v_signature
        using errcode='55000';
    end if;
  end loop;
  if to_regclass('public.truth_shadow_gmail_model_commissioning_scopes') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regclass('public.gmail_parse_processing_epochs') is null
    or to_regprocedure('private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(public.gmail_parse_processing_epochs)') is null then
    raise exception 'live Gmail message-model authority tables are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_live_message_model_root_allowed_v1(
  p_workspace_key text, p_connection_key text, p_root_batch_id uuid
)
returns boolean
language plpgsql stable security definer set search_path=''
as $function$
declare v_boundary public.gmail_parse_processing_epochs%rowtype; v_floor bigint;
begin
  if p_workspace_key is distinct from 'primary'
    or p_connection_key is distinct from 'primary'
    or p_root_batch_id is null then return false; end if;
  select * into v_boundary from public.gmail_parse_processing_epochs epoch
   where epoch.workspace_key='primary' and epoch.connection_key='primary';
  if not found or not private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(v_boundary)
    then return false; end if;
  v_floor := (v_boundary.canonical_epoch#>>'{parkedCompletenessBoundary,resumedCursorVersion}')::bigint;
  return exists (
    select 1 from public.source_ingest_batches batch
    where batch.workspace_key='primary' and batch.batch_id=p_root_batch_id
      and batch.source_system='gmail' and batch.connection_key='primary'
      and batch.status='committed' and batch.committed_cursor_version > v_floor
      and private.gmail_history_id_at_least(batch.committed_cursor_value,
        v_boundary.canonical_epoch#>>'{parkedCompletenessBoundary,cutoverHistoryId}')
  );
end;
$function$;

create or replace function private.truth_gmail_live_message_model_job_allowed_v1(
  p_workspace_key text, p_job_id uuid
)
returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists (
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
     and lineage.source_system=job.source_system and lineage.connection_key=job.connection_key
    where job.workspace_key=p_workspace_key and job.job_id=p_job_id
      and job.source_system='gmail' and job.connection_key='primary'
      and job.job_kind in ('gmail_extract_message_claims','gmail_extract_message_model_claims','gmail_review_model_extraction')
      and private.truth_gmail_live_message_model_root_allowed_v1(
        job.workspace_key,job.connection_key,lineage.root_batch_id)
  );
$function$;

revoke all on function private.truth_gmail_live_message_model_root_allowed_v1(text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function private.truth_gmail_live_message_model_job_allowed_v1(text,uuid) from public,anon,authenticated,service_role;

-- These two ledgers genuinely describe both shadow and live evidence-only
-- commissioning after this migration. Keep the historical column name, but
-- require its value and every canonical receipt to tell the truth.
do $scope_constraints$
declare v_table regclass; v_constraint text; v_name text;
begin
  foreach v_table in array array[
    'public.truth_shadow_gmail_model_commissioning_scopes'::regclass,
    'public.truth_shadow_gmail_model_commissioning_replays'::regclass
  ] loop
    for v_constraint in select conname from pg_constraint
      where conrelid=v_table and contype='c' and (
        pg_get_constraintdef(oid) like '%shadow_only = true%'
        or pg_get_constraintdef(oid) like '%shadowOnly%true%'
        or pg_get_constraintdef(oid) like '%connection_key%shadow-%')
    loop execute format('alter table %s drop constraint %I',v_table,v_constraint); end loop;
    v_name := case when v_table='public.truth_shadow_gmail_model_commissioning_scopes'::regclass
      then 'truth_gmail_model_commissioning_scope_authority_v2_check'
      else 'truth_gmail_model_commissioning_replay_authority_v2_check' end;
    if not exists(select 1 from pg_constraint where conrelid=v_table and conname=v_name) then
      execute format('alter table %s add constraint %I check ((connection_key like ''shadow-%%'' and shadow_only=true and canonical_%s->>''shadowOnly''=''true'') or (connection_key=''primary'' and shadow_only=false and canonical_%s->>''shadowOnly''=''false''))',
        v_table,v_name,case when v_table::text like '%scopes' then 'scope' else 'replay' end,
        case when v_table::text like '%scopes' then 'scope' else 'replay' end);
    end if;
  end loop;
  -- The scope ledger's root-ingest-mode check predates the live world: primary
  -- forward batches commit as 'history' and 'cutover_delta_reconciliation'.
  for v_constraint in select conname from pg_constraint
    where conrelid='public.truth_shadow_gmail_model_commissioning_scopes'::regclass
      and contype='c' and pg_get_constraintdef(oid) like '%root_ingest_mode%'
  loop execute format('alter table public.truth_shadow_gmail_model_commissioning_scopes drop constraint %I',v_constraint); end loop;
  if not exists(select 1 from pg_constraint
    where conrelid='public.truth_shadow_gmail_model_commissioning_scopes'::regclass
      and conname='truth_gmail_model_commissioning_scope_ingest_mode_v2_check') then
    alter table public.truth_shadow_gmail_model_commissioning_scopes
      add constraint truth_gmail_model_commissioning_scope_ingest_mode_v2_check check (
        (connection_key like 'shadow-%' and root_ingest_mode in ('backfill','reconciliation'))
        or (connection_key = 'primary' and root_ingest_mode in ('history','cutover_delta_reconciliation'))
      );
  end if;
end;
$scope_constraints$;

-- Central stored-job admission is the narrow composition point traversed by
-- message claiming, sealed-parent resume, review resolution, and replay.
do $rewrite_job_gate$
declare v_sig regprocedure := 'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'::regprocedure;
  v_def text; v_body text; v_new text; v_tag text;
begin
  select pg_get_functiondef(v_sig) into v_def;
  if position('truth_gmail_live_message_model_job_allowed_v1' in v_def)=0 then
    v_tag := '$funct' || 'ion$';
    v_def := rtrim(v_def, E'\n ');
    if right(v_def, length(v_tag)) is distinct from v_tag then
      raise exception 'message-model job gate rewrite did not match (tail)' using errcode='23514';
    end if;
    v_body := left(v_def, length(v_def) - length(v_tag));
    v_new := regexp_replace(v_body, '\);\s*$',
      ')' || E'\n    or private.truth_gmail_live_message_model_job_allowed_v1(\n      p_workspace_key, p_job_id\n    );\n');
    if v_new = v_body then
      raise exception 'message-model job gate rewrite did not match (body)' using errcode='23514';
    end if;
    execute v_new || v_tag;
  end if;
end;
$rewrite_job_gate$;

do $rewrite_message_claim_gate$
declare v_sig regprocedure := 'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)'::regprocedure;
  v_def text; v_new text;
begin
  select pg_get_functiondef(v_sig) into v_def;
  if position('truth_gmail_live_message_model_job_allowed_v1' in v_def)=0 then
    v_new:=replace(v_def,$old$  return private.truth_shadow_gmail_model_job_allowed_v2(
    p_workspace_key, p_job_id
  );$old$,$new$  return private.truth_shadow_gmail_model_job_allowed_v2(
    p_workspace_key, p_job_id
  ) or private.truth_gmail_live_message_model_job_allowed_v1(
    p_workspace_key, p_job_id
  );$new$);
    if v_new=v_def then raise exception 'message claim gate rewrite did not match' using errcode='23514'; end if;
    execute v_new;
  end if;
end;
$rewrite_message_claim_gate$;

do $rewrite_sealed_parent_resume$
declare v_sig regprocedure := 'private.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)'::regprocedure;
  v_def text; v_new text;
begin
  select pg_get_functiondef(v_sig) into v_def;
  if position('truth_gmail_live_message_model_job_allowed_v1' in v_def)=0 then
    v_new:=replace(v_def,$old$  if v_job.connection_key not like 'shadow-%'
    or exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = v_job.workspace_key
        and required_source.source_system = v_job.source_system
        and required_source.connection_key = v_job.connection_key
    ) then$old$,$new$  if not (
      (v_job.connection_key like 'shadow-%' and not exists (
        select 1 from public.truth_required_sources required_source
        where required_source.workspace_key=v_job.workspace_key
          and required_source.source_system=v_job.source_system
          and required_source.connection_key=v_job.connection_key
      ))
      or private.truth_gmail_live_message_model_job_allowed_v1(
        v_job.workspace_key,v_job.job_id
      )
    ) then$new$);
    if v_new=v_def then raise exception 'sealed message parent resume rewrite did not match' using errcode='23514'; end if;
    execute v_new;
  end if;
end;
$rewrite_sealed_parent_resume$;

-- Widen only the commissioning/read/resolve roots. All token checks remain
-- byte-for-byte intact; primary must additionally replay the live root proof.
do $rewrite_scoped_functions$
declare v_sig regprocedure; v_def text; v_new text;
begin
  foreach v_sig in array array[
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'::regprocedure,
    'private.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)'::regprocedure,
    'private.resolve_truth_shadow_gmail_model_review_job(text,text,uuid,uuid,text,jsonb,text,text,text,text,text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_sig) into v_def; v_new:=v_def;
    v_new:=replace(v_new,'p_connection_key not like ''shadow-%''','not (p_connection_key like ''shadow-%'' or (p_connection_key = ''primary'' and private.truth_gmail_live_message_model_root_allowed_v1(p_workspace_key,p_connection_key,p_root_batch_id)))');
    v_new:=replace(v_new,'v_job.connection_key not like ''shadow-%''','not (v_job.connection_key like ''shadow-%'' or private.truth_gmail_live_message_model_job_allowed_v1(v_job.workspace_key,v_job.job_id))');
    v_new:=replace(v_new,$old$    or p_connection_key <>
      'shadow-current-awbs-20260710-c475a8ca'
    or p_root_batch_id is distinct from
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid$old$,
      $new$    or not (
      (p_connection_key = 'shadow-current-awbs-20260710-c475a8ca'
        and p_root_batch_id = 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid)
      or private.truth_gmail_live_message_model_root_allowed_v1(
        p_workspace_key,p_connection_key,p_root_batch_id
      )
    )$new$);
    v_new:=replace(v_new,$old$    or v_batch.mode not in ('backfill', 'reconciliation')
    or exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = p_workspace_key
        and required_source.source_system = 'gmail'
        and required_source.connection_key = p_connection_key
    ) then$old$,
      $new$    or not (
      (v_batch.mode in ('backfill', 'reconciliation') and not exists (
        select 1 from public.truth_required_sources required_source
        where required_source.workspace_key=p_workspace_key
          and required_source.source_system='gmail'
          and required_source.connection_key=p_connection_key
      ))
      or private.truth_gmail_live_message_model_root_allowed_v1(
        p_workspace_key,p_connection_key,p_root_batch_id
      )
    ) then$new$);
    if v_sig='private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'::regprocedure then
      v_new:=replace(v_new,'  v_attachment_runnable_count integer := 0;',E'  v_attachment_runnable_count integer := 0;\n  v_shadow_only boolean;');
      v_new:=replace(v_new,'  perform private.truth_source_cut_mutation_lock(p_workspace_key);',E'  v_shadow_only := p_connection_key like ''shadow-%'';\n  perform private.truth_source_cut_mutation_lock(p_workspace_key);');
      v_new:=replace(v_new,'or v_batch.mode not in (''backfill'', ''reconciliation'')','or (v_shadow_only and v_batch.mode not in (''backfill'', ''reconciliation''))');
      v_new:=replace(v_new,E'  if exists (\n      select 1\n      from public.truth_required_sources required_source',E'  if v_shadow_only and exists (\n      select 1\n      from public.truth_required_sources required_source');
      v_new:=replace(v_new,'''shadowOnly'', true','''shadowOnly'', v_shadow_only');
      v_new:=replace(v_new,'''truth-shadow-gmail-model-commissioning-scope-v1'', true, false, false','''truth-shadow-gmail-model-commissioning-scope-v1'', v_shadow_only, false, false');
      v_new:=replace(v_new,'    or not v_scope.shadow_only','    or v_scope.shadow_only is distinct from v_shadow_only');
      v_new:=replace(v_new,'''truth-shadow-gmail-model-commissioning-replay-v1'', true, false, false','''truth-shadow-gmail-model-commissioning-replay-v1'', v_shadow_only, false, false');
    end if;
    if v_new is distinct from v_def then execute v_new;
    elsif position('truth_gmail_live_message_model_root_allowed_v1' in v_def)=0
      and position('truth_gmail_live_message_model_job_allowed_v1' in v_def)=0 then
      raise exception 'message-model scoped rewrite did not match %',v_sig using errcode='23514';
    end if;
  end loop;
end;
$rewrite_scoped_functions$;

-- Replay validation formerly asserted shadow_only=true at both scope and
-- replay rows. Replace those assertions with connection/value coherence.
do $rewrite_replay$
declare v_sig regprocedure := 'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)'::regprocedure;
  v_def text; v_new text;
begin
  select pg_get_functiondef(v_sig) into v_def; v_new:=v_def;
  v_new:=replace(v_new,'or not v_replay.shadow_only','or v_replay.shadow_only is distinct from (v_replay.connection_key like ''shadow-%'')');
  v_new:=replace(v_new,'or not v_scope.shadow_only','or v_scope.shadow_only is distinct from (v_scope.connection_key like ''shadow-%'')');
  v_new:=replace(v_new,
'  if exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key = v_replay.workspace_key
      and required_source.source_system = ''gmail''
      and required_source.connection_key = v_replay.connection_key
  ) then',
'  if v_replay.connection_key like ''shadow-%'' and exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key = v_replay.workspace_key
      and required_source.source_system = ''gmail''
      and required_source.connection_key = v_replay.connection_key
  ) then');
  v_new:=replace(v_new,'or v_batch.mode <> all(array[''backfill'', ''reconciliation''])',
    'or not ((v_replay.connection_key like ''shadow-%'' and v_batch.mode = any(array[''backfill'',''reconciliation''])) or (v_replay.connection_key = ''primary'' and v_batch.mode = any(array[''history'',''cutover_delta_reconciliation''])))');
  if v_new is distinct from v_def then execute v_new;
  elsif position('is distinct from (v_replay.connection_key' in v_def)=0 then
    raise exception 'message-model replay authority rewrite did not match' using errcode='23514';
  end if;
end;
$rewrite_replay$;

-- The confirmed refusal occurs before a job attempt is claimed. Therefore no
-- attempt restoration is authorized or performed by this migration.

do $verify$
declare v_def text; v_constraints text;
begin
  select pg_get_functiondef('private.truth_shadow_model_commissioning_job_allowed(text,uuid)'::regprocedure) into v_def;
  if position('truth_gmail_live_message_model_job_allowed_v1' in v_def)=0 then
    raise exception 'live message-model job authority is absent' using errcode='55000'; end if;
  select pg_get_functiondef('private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'::regprocedure) into v_def;
  if position('truth_gmail_live_message_model_root_allowed_v1' in v_def)=0
    or position('valid_truth_review_token' in v_def)=0 or position('valid_truth_sync_token' in v_def)=0
    or position('''shadowOnly'', v_shadow_only' in v_def)=0 then
    raise exception 'live message-model prepare authority is incomplete' using errcode='55000'; end if;
  select string_agg(pg_get_constraintdef(oid),' ') into v_constraints from pg_constraint
   where conrelid='public.truth_shadow_gmail_model_commissioning_scopes'::regclass and contype='c';
  if position('connection_key = ''primary''' in v_constraints)=0 or position('shadow_only = false' in v_constraints)=0 then
    raise exception 'live message-model scope constraints are incomplete' using errcode='55000'; end if;
end;
$verify$;
