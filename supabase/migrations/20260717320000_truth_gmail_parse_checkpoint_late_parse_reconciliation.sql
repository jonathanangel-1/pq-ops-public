-- Append-only reconciliation for parses that completed after their batch's
-- immutable parse checkpoint was cut. The original checkpoint and its gap
-- member remain byte-for-byte intact; this receipt binds that exact gap to a
-- later successful parse observation and permits the link epoch to consume it.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.truth_gmail_parse_checkpoint_late_parse_reconciliations (
  reconciliation_id text primary key check(
    reconciliation_id='gmail-parse-checkpoint-late-parse:v1:'||reconciliation_hash),
  reconciliation_hash text not null unique check(reconciliation_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  root_batch_id uuid not null,
  checkpoint_id text not null,
  checkpoint_hash text not null check(checkpoint_hash~'^[0-9a-f]{64}$'),
  gap_member_id text not null,
  gap_member_hash text not null check(gap_member_hash~'^[0-9a-f]{64}$'),
  gap_terminal_disposition text not null,
  parse_job_id uuid not null,
  parsed_observation_id text not null,
  parsed_observation_content_hash text not null check(parsed_observation_content_hash~'^[0-9a-f]{64}$'),
  link_job_id uuid not null,
  canonical_reconciliation jsonb not null check(
    jsonb_typeof(canonical_reconciliation)='object'
    and canonical_reconciliation->>'productionPublicationAttempted'='false'),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,link_job_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,gap_member_id)
    references public.gmail_parse_checkpoint_members(workspace_key,member_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parse_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parsed_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,link_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(reconciliation_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_reconciliation),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_parse_checkpoint_late_parse_reconciliations_immutable
  on public.truth_gmail_parse_checkpoint_late_parse_reconciliations;
create trigger truth_gmail_parse_checkpoint_late_parse_reconciliations_immutable
before update or delete on public.truth_gmail_parse_checkpoint_late_parse_reconciliations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_parse_checkpoint_late_parse_reconciliations enable row level security;
alter table public.truth_gmail_parse_checkpoint_late_parse_reconciliations force row level security;
revoke all on public.truth_gmail_parse_checkpoint_late_parse_reconciliations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_parse_checkpoint_late_parse_reconciliations to service_role;

create or replace function private.reconcile_truth_gmail_checkpoint_late_parse_v1(
  p_workspace_key text,p_link_job_id uuid
)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare
  v record; v_body jsonb; v_hash text; v_id text;
  v_member jsonb; v_member_hash text; v_member_id text;
begin
  if exists(select 1 from public.truth_gmail_parse_checkpoint_late_parse_reconciliations
    where workspace_key=p_workspace_key and link_job_id=p_link_job_id) then
    return false; end if;
  select job.observation_id,job.state,job.last_error_code,lineage.connection_key,
    lineage.root_batch_id,observation.content_hash,observation.source_object_id,
    checkpoint.checkpoint_id,checkpoint.checkpoint_hash,
    gap.member_id gap_member_id,gap.member_hash gap_member_hash,
    gap.terminal_disposition,parse_job.job_id parse_job_id,
    epoch.epoch_id,epoch.epoch_hash
  into v
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
  join public.source_observations observation
    on observation.workspace_key=job.workspace_key
   and observation.observation_id=job.observation_id
   and observation.source_object_type='gmail_message_parsed'
   and observation.normalized_payload->>'schemaVersion'='gmail-parsed-message-v2'
  join public.gmail_parse_checkpoints checkpoint
    on checkpoint.workspace_key=lineage.workspace_key
   and checkpoint.root_batch_id=lineage.root_batch_id
  join public.gmail_parse_checkpoint_members gap
    on gap.workspace_key=checkpoint.workspace_key
   and gap.root_batch_id=checkpoint.root_batch_id
   and gap.message_id=observation.source_object_id
   and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
  join public.source_processing_jobs parse_job
    on parse_job.workspace_key=job.workspace_key
   and parse_job.job_id=lineage.parent_job_id
   and parse_job.source_system='gmail'
   and parse_job.connection_key=job.connection_key
   and parse_job.job_kind='gmail_parse_rfc822'
   and parse_job.state='succeeded'
   and parse_job.result->>'schemaVersion'='gmail-parse-result-v2'
   and parse_job.result->'resultObservationIds' ? job.observation_id
  left join public.truth_gmail_link_epochs epoch
    on epoch.workspace_key=lineage.workspace_key
   and epoch.root_batch_id=lineage.root_batch_id
  where job.workspace_key=p_workspace_key and job.job_id=p_link_job_id
    and job.source_system='gmail' and job.job_kind='gmail_resolve_entity_links'
    and job.state='waiting_runtime'
    and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    and job.lease_owner is null and job.lease_expires_at is null
    and not exists(select 1 from public.truth_gmail_link_epoch_seals seal
      where seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id)
  order by parse_job.completed_at desc nulls last,parse_job.job_id limit 1
  for update of job;
  if not found then return false; end if;
  if (select count(*) from public.gmail_parse_checkpoint_members gap
    where gap.workspace_key=p_workspace_key and gap.root_batch_id=v.root_batch_id
      and gap.message_id=v.source_object_id
      and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut'))<>1 then
    raise exception 'late parse does not identify one exact checkpoint gap member'
      using errcode='23514'; end if;
  v_body:=jsonb_build_object(
    'schemaVersion','gmail-parse-checkpoint-late-parse-reconciliation-v1',
    'authorityVersion','gmail-checkpoint-late-parse-gap-reconciliation-v1',
    'workspaceKey',p_workspace_key,'connectionKey',v.connection_key,
    'rootBatchId',v.root_batch_id,'checkpointId',v.checkpoint_id,
    'checkpointHash',v.checkpoint_hash,'gapMemberId',v.gap_member_id,
    'gapMemberHash',v.gap_member_hash,'gapTerminalDisposition',v.terminal_disposition,
    'parseJobId',v.parse_job_id,'parsedObservationId',v.observation_id,
    'parsedObservationContentHash',v.content_hash,'linkJobId',p_link_job_id,
    'productionPublicationAttempted',false);
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  v_id:='gmail-parse-checkpoint-late-parse:v1:'||v_hash;
  insert into public.truth_gmail_parse_checkpoint_late_parse_reconciliations(
    reconciliation_id,reconciliation_hash,workspace_key,connection_key,
    root_batch_id,checkpoint_id,checkpoint_hash,gap_member_id,gap_member_hash,
    gap_terminal_disposition,parse_job_id,parsed_observation_id,
    parsed_observation_content_hash,link_job_id,canonical_reconciliation
  ) values(v_id,v_hash,p_workspace_key,v.connection_key,v.root_batch_id,
    v.checkpoint_id,v.checkpoint_hash,v.gap_member_id,v.gap_member_hash,
    v.terminal_disposition,v.parse_job_id,v.observation_id,v.content_hash,
    p_link_job_id,v_body);

  if v.epoch_id is not null then
    v_member:=jsonb_build_object('schemaVersion','gmail-link-epoch-member-v1',
      'workspaceKey',p_workspace_key,'epochId',v.epoch_id,'linkJobId',p_link_job_id,
      'observationId',v.observation_id,'observationContentHash',v.content_hash);
    v_member_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_member),'UTF8'),'sha256'),'hex');
    v_member_id:='gmail-link-epoch-member:v1:'||v_member_hash;
    insert into public.truth_gmail_link_epoch_members(workspace_key,epoch_id,
      link_job_id,observation_id,observation_content_hash,member_id,
      canonical_member,member_hash,schema_version)
    values(p_workspace_key,v.epoch_id,p_link_job_id,v.observation_id,v.content_hash,
      v_member_id,v_member,v_member_hash,'gmail-link-epoch-member-v1')
    on conflict(link_job_id) do nothing;
    update public.source_processing_jobs set state='queued',last_error_code='',
      safe_error_detail='',available_at=clock_timestamp(),updated_at=clock_timestamp()
    where workspace_key=p_workspace_key and job_id=p_link_job_id
      and state='waiting_runtime' and last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED';
  end if;
  return true;
end;
$function$;
revoke all on function private.reconcile_truth_gmail_checkpoint_late_parse_v1(text,uuid)
  from public,anon,authenticated,service_role;

create or replace function private.route_truth_gmail_checkpoint_late_parse_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.source_system='gmail' then
    perform private.reconcile_truth_gmail_checkpoint_late_parse_v1(
      new.workspace_key,new.job_id);
  end if;
  return new;
end;
$function$;
revoke all on function private.route_truth_gmail_checkpoint_late_parse_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists source_processing_lineage_gmail_checkpoint_late_parse
  on public.source_processing_job_lineage;
create trigger source_processing_lineage_gmail_checkpoint_late_parse
after insert on public.source_processing_job_lineage
for each row execute function private.route_truth_gmail_checkpoint_late_parse_v1();

create or replace function private.route_truth_gmail_checkpoint_late_parse_parent_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare v_child record;
begin
  if new.source_system='gmail' and new.job_kind='gmail_parse_rfc822'
    and new.state='succeeded' and old.state is distinct from new.state then
    for v_child in select lineage.job_id
      from public.source_processing_job_lineage lineage
      join public.source_processing_jobs child
        on child.workspace_key=lineage.workspace_key and child.job_id=lineage.job_id
      where lineage.workspace_key=new.workspace_key
        and lineage.parent_job_id=new.job_id
        and child.job_kind='gmail_resolve_entity_links'
    loop perform private.reconcile_truth_gmail_checkpoint_late_parse_v1(
      new.workspace_key,v_child.job_id); end loop;
  end if;
  return new;
end;
$function$;
revoke all on function private.route_truth_gmail_checkpoint_late_parse_parent_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists source_processing_job_gmail_checkpoint_late_parse_parent
  on public.source_processing_jobs;
create trigger source_processing_job_gmail_checkpoint_late_parse_parent
after update of state on public.source_processing_jobs
for each row execute function private.route_truth_gmail_checkpoint_late_parse_parent_v1();

do $reconcile_backlog$
declare v_job record;
begin
  for v_job in select workspace_key,job_id from public.source_processing_jobs
    where source_system='gmail' and job_kind='gmail_resolve_entity_links'
      and state='waiting_runtime' and last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    order by workspace_key,job_id
  loop perform private.reconcile_truth_gmail_checkpoint_late_parse_v1(
    v_job.workspace_key,v_job.job_id); end loop;
end;
$reconcile_backlog$;

-- Open consumes the immutable checkpoint plus append-only late-parse receipts.
create or replace function private.open_truth_gmail_link_epoch(
  p_workspace_key text,p_root_batch_id uuid,p_sync_token text
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_checkpoint public.gmail_parse_checkpoints%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_previous public.truth_gmail_link_epochs%rowtype;
  v_epoch public.truth_gmail_link_epochs%rowtype;
  v_canonical jsonb; v_epoch_hash text; v_epoch_id text;
  v_member jsonb; v_member_hash text; v_member_id text;
  v_count integer:=0; v_job record;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000'; end if;
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=p_root_batch_id
    and source_system='gmail' and status='committed';
  select * into strict v_checkpoint from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  if exists(select 1 from public.gmail_parse_checkpoint_members gap
    where gap.workspace_key=p_workspace_key and gap.root_batch_id=p_root_batch_id
      and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
      and not exists(select 1
        from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
        where reconciliation.workspace_key=gap.workspace_key
          and reconciliation.gap_member_id=gap.member_id
          and reconciliation.checkpoint_id=v_checkpoint.checkpoint_id
          and reconciliation.checkpoint_hash=v_checkpoint.checkpoint_hash)) then
    raise exception 'Gmail link epoch has unreconciled parse-checkpoint terminal gaps'
      using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-link-epoch:'||p_workspace_key||':'||v_batch.connection_key,0));
  select * into v_epoch from public.truth_gmail_link_epochs
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  if not found then
    select * into v_previous from public.truth_gmail_link_epochs
    where workspace_key=p_workspace_key and connection_key=v_batch.connection_key
      and root_batch_id<>p_root_batch_id order by created_at desc,epoch_id desc limit 1;
    v_canonical:=jsonb_build_object('schemaVersion','gmail-link-epoch-v1',
      'workspaceKey',p_workspace_key,'connectionKey',v_batch.connection_key,
      'rootBatchId',p_root_batch_id,'parseCheckpointId',v_checkpoint.checkpoint_id,
      'parseCheckpointHash',v_checkpoint.checkpoint_hash,
      'predecessor',case when v_previous.epoch_id is null then null else jsonb_build_object(
        'epochId',v_previous.epoch_id,'epochHash',v_previous.epoch_hash) end,
      'policyVersion','gmail-link-epoch-policy-v1');
    v_epoch_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical),'UTF8'),'sha256'),'hex');
    v_epoch_id:='gmail-link-epoch:v1:'||v_epoch_hash;
    insert into public.truth_gmail_link_epochs(workspace_key,root_batch_id,
      connection_key,parse_checkpoint_id,parse_checkpoint_hash,predecessor_epoch_id,
      predecessor_epoch_hash,epoch_id,canonical_epoch,epoch_hash,schema_version)
    values(p_workspace_key,p_root_batch_id,v_batch.connection_key,
      v_checkpoint.checkpoint_id,v_checkpoint.checkpoint_hash,v_previous.epoch_id,
      v_previous.epoch_hash,v_epoch_id,v_canonical,v_epoch_hash,'gmail-link-epoch-v1')
    on conflict(workspace_key,root_batch_id) do nothing;
    select * into strict v_epoch from public.truth_gmail_link_epochs
    where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
    if v_epoch.canonical_epoch is distinct from v_canonical then
      raise exception 'Gmail link epoch conflicts on replay' using errcode='23505'; end if;
  end if;
  if exists(select 1 from public.truth_gmail_link_epoch_seals seal
    where seal.workspace_key=p_workspace_key and seal.epoch_id=v_epoch.epoch_id) then
    return jsonb_build_object('ok',true,'epochId',v_epoch.epoch_id,
      'epochHash',v_epoch.epoch_hash,'parseCheckpointId',v_checkpoint.checkpoint_id,
      'memberCount',(select count(*) from public.truth_gmail_link_epoch_members
        where workspace_key=p_workspace_key and epoch_id=v_epoch.epoch_id),
      'mutatesOperationalState',false,'publishesTruth',false,'performsActions',false);
  end if;
  for v_job in
    select job.job_id,job.observation_id,observation.content_hash
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key and observation.observation_id=job.observation_id
    where job.workspace_key=p_workspace_key and job.source_system='gmail'
      and job.job_kind='gmail_resolve_entity_links' and lineage.root_batch_id=p_root_batch_id
      and observation.source_object_type='gmail_message_parsed'
      and (exists(select 1 from public.gmail_parse_checkpoint_members member
          where member.workspace_key=p_workspace_key and member.root_batch_id=p_root_batch_id
            and member.parsed_observation_id=job.observation_id
            and member.terminal_disposition='parsed_exact_revision')
        or exists(select 1 from public.truth_gmail_parse_checkpoint_late_parse_reconciliations r
          where r.workspace_key=p_workspace_key and r.link_job_id=job.job_id
            and r.checkpoint_id=v_checkpoint.checkpoint_id))
    order by job.job_id
  loop
    v_member:=jsonb_build_object('schemaVersion','gmail-link-epoch-member-v1',
      'workspaceKey',p_workspace_key,'epochId',v_epoch.epoch_id,
      'linkJobId',v_job.job_id,'observationId',v_job.observation_id,
      'observationContentHash',v_job.content_hash);
    v_member_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_member),'UTF8'),'sha256'),'hex');
    v_member_id:='gmail-link-epoch-member:v1:'||v_member_hash;
    insert into public.truth_gmail_link_epoch_members(workspace_key,epoch_id,
      link_job_id,observation_id,observation_content_hash,member_id,
      canonical_member,member_hash,schema_version)
    values(p_workspace_key,v_epoch.epoch_id,v_job.job_id,v_job.observation_id,
      v_job.content_hash,v_member_id,v_member,v_member_hash,'gmail-link-epoch-member-v1')
    on conflict(link_job_id) do nothing;
  end loop;
  update public.source_processing_jobs job set state='queued',last_error_code='',
    safe_error_detail='',available_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=p_workspace_key and job.state='waiting_runtime'
    and job.job_kind='gmail_resolve_entity_links'
    and exists(select 1 from public.truth_gmail_link_epoch_members member
      where member.workspace_key=p_workspace_key and member.link_job_id=job.job_id
        and member.epoch_id=v_epoch.epoch_id);
  select count(*)::integer into v_count from public.truth_gmail_link_epoch_members
  where workspace_key=p_workspace_key and epoch_id=v_epoch.epoch_id;
  return jsonb_build_object('ok',true,'epochId',v_epoch.epoch_id,
    'epochHash',v_epoch.epoch_hash,'parseCheckpointId',v_checkpoint.checkpoint_id,
    'memberCount',v_count,'mutatesOperationalState',false,
    'publishesTruth',false,'performsActions',false);
end;
$function$;
revoke all on function private.open_truth_gmail_link_epoch(text,uuid,text)
  from public,anon,authenticated,service_role;

do $verify$
begin
  if exists(select 1 from public.truth_gmail_parse_checkpoint_late_parse_reconciliations r
    join public.gmail_parse_checkpoint_members gap
      on gap.workspace_key=r.workspace_key and gap.member_id=r.gap_member_id
    join public.source_processing_jobs parse_job
      on parse_job.workspace_key=r.workspace_key and parse_job.job_id=r.parse_job_id
    where gap.member_hash<>r.gap_member_hash
      or gap.terminal_disposition in ('parsed_exact_revision','deleted_at_cut')
      or parse_job.state<>'succeeded' or parse_job.job_kind<>'gmail_parse_rfc822'
      or parse_job.result->>'schemaVersion'<>'gmail-parse-result-v2'
      or not (parse_job.result->'resultObservationIds' ? r.parsed_observation_id)
      or r.canonical_reconciliation->>'productionPublicationAttempted'<>'false') then
    raise exception 'late parse-checkpoint reconciliation verification failed'
      using errcode='23514'; end if;
end;
$verify$;
