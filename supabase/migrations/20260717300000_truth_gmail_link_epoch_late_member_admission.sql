-- Admit link jobs created after their immutable parse checkpoint and open link
-- epoch. The epoch header does not commit to membership; its seal commits the
-- final member manifest. Therefore an exact checkpoint-bound observation may
-- join only while the epoch is unsealed. Sealed history is never changed.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_link_epochs') is null
    or to_regclass('public.truth_gmail_link_epoch_members') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regclass('public.gmail_parse_checkpoint_members') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'Gmail late link-member prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

-- The original identifiers are globally unique. Add equivalent composite
-- keys so every new authority FK also proves workspace isolation.
do $workspace_keys$
begin
  if not exists (select 1 from pg_constraint
    where conrelid='public.gmail_parse_checkpoint_members'::regclass
      and conname='gmail_parse_checkpoint_members_workspace_member_key') then
    alter table public.gmail_parse_checkpoint_members
      add constraint gmail_parse_checkpoint_members_workspace_member_key
      unique(workspace_key,member_id);
  end if;
  if not exists (select 1 from pg_constraint
    where conrelid='public.truth_gmail_link_epoch_members'::regclass
      and conname='truth_gmail_link_epoch_members_workspace_member_key') then
    alter table public.truth_gmail_link_epoch_members
      add constraint truth_gmail_link_epoch_members_workspace_member_key
      unique(workspace_key,member_id);
  end if;
end;
$workspace_keys$;

create table if not exists public.truth_gmail_link_epoch_late_member_admissions (
  admission_id text primary key check (
    admission_id~'^gmail-link-epoch-late-member-admission:v1:[0-9a-f]{64}$'
  ),
  admission_hash text not null unique check(admission_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  root_batch_id uuid not null,
  epoch_id text not null,
  epoch_hash text not null check(epoch_hash~'^[0-9a-f]{64}$'),
  checkpoint_id text not null,
  checkpoint_hash text not null check(checkpoint_hash~'^[0-9a-f]{64}$'),
  checkpoint_member_id text,
  checkpoint_member_hash text check(checkpoint_member_hash is null or checkpoint_member_hash~'^[0-9a-f]{64}$'),
  admission_proof_kind text not null check(admission_proof_kind=any(array[
    'parse_checkpoint_member','existing_epoch_observation_member'
  ])),
  link_job_id uuid not null,
  observation_id text not null,
  observation_content_hash text not null check(observation_content_hash~'^[0-9a-f]{64}$'),
  epoch_member_id text not null,
  epoch_member_hash text not null check(epoch_member_hash~'^[0-9a-f]{64}$'),
  prior_job_state text not null check(prior_job_state='waiting_runtime'),
  prior_error_code text not null check(prior_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'),
  canonical_admission jsonb not null check(
    jsonb_typeof(canonical_admission)='object'
    and canonical_admission->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,link_job_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,epoch_id)
    references public.truth_gmail_link_epochs(workspace_key,epoch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_member_id)
    references public.gmail_parse_checkpoint_members(workspace_key,member_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,link_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,epoch_member_id)
    references public.truth_gmail_link_epoch_members(workspace_key,member_id)
    on update restrict on delete restrict,
  check(admission_id='gmail-link-epoch-late-member-admission:v1:'||admission_hash)
  ,check((checkpoint_member_id is null)=(checkpoint_member_hash is null))
);

drop trigger if exists truth_gmail_link_epoch_late_member_admissions_immutable
  on public.truth_gmail_link_epoch_late_member_admissions;
create trigger truth_gmail_link_epoch_late_member_admissions_immutable
before update or delete on public.truth_gmail_link_epoch_late_member_admissions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_link_epoch_late_member_admissions enable row level security;
alter table public.truth_gmail_link_epoch_late_member_admissions force row level security;
revoke all on public.truth_gmail_link_epoch_late_member_admissions
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_link_epoch_late_member_admissions to service_role;

create or replace function private.admit_truth_gmail_link_epoch_late_member_v1(
  p_workspace_key text,p_link_job_id uuid
)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare
  v_row record;
  v_member jsonb;
  v_member_hash text;
  v_member_id text;
  v_admission jsonb;
  v_admission_hash text;
  v_admission_id text;
begin
  if exists (
    select 1 from public.truth_gmail_link_epoch_members member
    where member.workspace_key=p_workspace_key and member.link_job_id=p_link_job_id
  ) then return false; end if;

  select job.state,job.last_error_code,job.observation_id,
    observation.content_hash,lineage.connection_key,lineage.root_batch_id,
    epoch.epoch_id,epoch.epoch_hash,checkpoint.checkpoint_id,checkpoint.checkpoint_hash,
    checkpoint_member.member_id checkpoint_member_id,
    checkpoint_member.member_hash checkpoint_member_hash,
    case when checkpoint_member.member_id is not null then 'parse_checkpoint_member'
      else 'existing_epoch_observation_member' end admission_proof_kind
  into v_row
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
  join public.source_observations observation
    on observation.workspace_key=job.workspace_key
   and observation.observation_id=job.observation_id
  join public.truth_gmail_link_epochs epoch
    on epoch.workspace_key=lineage.workspace_key
   and epoch.root_batch_id=lineage.root_batch_id
   and epoch.connection_key=lineage.connection_key
  join public.gmail_parse_checkpoints checkpoint
    on checkpoint.workspace_key=epoch.workspace_key
   and checkpoint.checkpoint_id=epoch.parse_checkpoint_id
   and checkpoint.checkpoint_hash=epoch.parse_checkpoint_hash
  left join lateral (
    select member.member_id,member.member_hash
    from public.gmail_parse_checkpoint_members member
    where member.workspace_key=checkpoint.workspace_key
      and member.root_batch_id=checkpoint.root_batch_id
      and member.parsed_observation_id=job.observation_id
      and member.terminal_disposition='parsed_exact_revision'
    order by member.member_id limit 1
  ) checkpoint_member on true
  where job.workspace_key=p_workspace_key and job.job_id=p_link_job_id
    and job.source_system='gmail' and job.job_kind='gmail_resolve_entity_links'
    and job.state='waiting_runtime'
    and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    and job.lease_owner is null and job.lease_expires_at is null
    and (checkpoint_member.member_id is not null or exists (
      select 1 from public.truth_gmail_link_epoch_members existing_member
      where existing_member.workspace_key=epoch.workspace_key
        and existing_member.epoch_id=epoch.epoch_id
        and existing_member.observation_id=job.observation_id
        and existing_member.observation_content_hash=observation.content_hash
    ))
    and not exists (
      select 1 from public.truth_gmail_link_epoch_seals seal
      where seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
    )
  for update of job;
  if not found then return false; end if;

  v_member:=jsonb_build_object(
    'schemaVersion','gmail-link-epoch-member-v1',
    'workspaceKey',p_workspace_key,'epochId',v_row.epoch_id,
    'linkJobId',p_link_job_id,'observationId',v_row.observation_id,
    'observationContentHash',v_row.content_hash
  );
  v_member_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_member),'UTF8'),'sha256'),'hex');
  v_member_id:='gmail-link-epoch-member:v1:'||v_member_hash;
  insert into public.truth_gmail_link_epoch_members(
    workspace_key,epoch_id,link_job_id,observation_id,observation_content_hash,
    member_id,canonical_member,member_hash,schema_version
  ) values (p_workspace_key,v_row.epoch_id,p_link_job_id,v_row.observation_id,
    v_row.content_hash,v_member_id,v_member,v_member_hash,'gmail-link-epoch-member-v1')
  on conflict(link_job_id) do nothing;
  if not exists (
    select 1 from public.truth_gmail_link_epoch_members member
    where member.workspace_key=p_workspace_key and member.link_job_id=p_link_job_id
      and member.epoch_id=v_row.epoch_id and member.member_id=v_member_id
      and member.canonical_member=v_member
  ) then raise exception 'Gmail late link member conflicts with durable membership'
    using errcode='23505'; end if;

  v_admission:=jsonb_build_object(
    'schemaVersion','gmail-link-epoch-late-member-admission-v1',
    'authorityVersion','gmail-link-epoch-open-frontier-admission-v1',
    'workspaceKey',p_workspace_key,'connectionKey',v_row.connection_key,
    'rootBatchId',v_row.root_batch_id,'epochId',v_row.epoch_id,
    'epochHash',v_row.epoch_hash,'checkpointId',v_row.checkpoint_id,
    'checkpointHash',v_row.checkpoint_hash,
    'checkpointMemberId',v_row.checkpoint_member_id,
    'checkpointMemberHash',v_row.checkpoint_member_hash,
    'admissionProofKind',v_row.admission_proof_kind,
    'linkJobId',p_link_job_id,'observationId',v_row.observation_id,
    'observationContentHash',v_row.content_hash,'epochMemberId',v_member_id,
    'epochMemberHash',v_member_hash,'priorJobState',v_row.state,
    'priorErrorCode',v_row.last_error_code,'membershipAddedBeforeSeal',true,
    'productionPublicationAttempted',false
  );
  v_admission_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_admission),'UTF8'),'sha256'),'hex');
  v_admission_id:='gmail-link-epoch-late-member-admission:v1:'||v_admission_hash;
  insert into public.truth_gmail_link_epoch_late_member_admissions(
    admission_id,admission_hash,workspace_key,connection_key,root_batch_id,
    epoch_id,epoch_hash,checkpoint_id,checkpoint_hash,checkpoint_member_id,
    checkpoint_member_hash,admission_proof_kind,link_job_id,observation_id,observation_content_hash,
    epoch_member_id,epoch_member_hash,prior_job_state,prior_error_code,
    canonical_admission
  ) values (v_admission_id,v_admission_hash,p_workspace_key,v_row.connection_key,
    v_row.root_batch_id,v_row.epoch_id,v_row.epoch_hash,v_row.checkpoint_id,
    v_row.checkpoint_hash,v_row.checkpoint_member_id,v_row.checkpoint_member_hash,
    v_row.admission_proof_kind,p_link_job_id,v_row.observation_id,v_row.content_hash,v_member_id,v_member_hash,
    v_row.state,v_row.last_error_code,v_admission)
  on conflict(workspace_key,link_job_id) do nothing;

  update public.source_processing_jobs job set state='queued',last_error_code='',
    safe_error_detail='',available_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=p_workspace_key and job.job_id=p_link_job_id
    and job.state='waiting_runtime'
    and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    and exists (
      select 1 from public.truth_gmail_link_epoch_members member
      where member.workspace_key=job.workspace_key and member.link_job_id=job.job_id
    );
  return true;
end;
$function$;
revoke all on function private.admit_truth_gmail_link_epoch_late_member_v1(text,uuid)
  from public,anon,authenticated,service_role;

-- Normal child-job commits insert lineage after the parked job. This trigger
-- closes that race for future jobs; the one-time loop below adopts the backlog.
create or replace function private.route_truth_gmail_link_epoch_late_member_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.source_system='gmail' then
    perform private.admit_truth_gmail_link_epoch_late_member_v1(
      new.workspace_key,new.job_id
    );
  end if;
  return new;
end;
$function$;
revoke all on function private.route_truth_gmail_link_epoch_late_member_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists source_processing_lineage_gmail_link_epoch_late_member
  on public.source_processing_job_lineage;
create trigger source_processing_lineage_gmail_link_epoch_late_member
after insert on public.source_processing_job_lineage
for each row execute function private.route_truth_gmail_link_epoch_late_member_v1();

do $adopt_backlog$
declare v_job record;
begin
  for v_job in
    select job.workspace_key,job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key=lineage.workspace_key
     and epoch.root_batch_id=lineage.root_batch_id
    where job.source_system='gmail' and job.job_kind='gmail_resolve_entity_links'
      and job.state='waiting_runtime'
      and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
      and not exists (select 1 from public.truth_gmail_link_epoch_seals seal
        where seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id)
    order by job.workspace_key,job.job_id
  loop
    perform private.admit_truth_gmail_link_epoch_late_member_v1(
      v_job.workspace_key,v_job.job_id
    );
  end loop;
end;
$adopt_backlog$;

do $verify$
begin
  if exists (
    select 1 from public.truth_gmail_link_epoch_late_member_admissions admission
    join public.truth_gmail_link_epoch_members member
      on member.workspace_key=admission.workspace_key
     and member.link_job_id=admission.link_job_id
    join public.source_processing_jobs job
      on job.workspace_key=admission.workspace_key and job.job_id=admission.link_job_id
    left join public.gmail_parse_checkpoint_members checkpoint_member
      on checkpoint_member.workspace_key=admission.workspace_key
     and checkpoint_member.member_id=admission.checkpoint_member_id
    where member.epoch_id<>admission.epoch_id
      or member.member_hash<>admission.epoch_member_hash
      or (admission.admission_proof_kind='parse_checkpoint_member' and (
        checkpoint_member.parsed_observation_id is distinct from admission.observation_id
        or checkpoint_member.member_hash is distinct from admission.checkpoint_member_hash
        or checkpoint_member.terminal_disposition is distinct from 'parsed_exact_revision'
      ))
      or (admission.admission_proof_kind='existing_epoch_observation_member' and not exists (
        select 1 from public.truth_gmail_link_epoch_members existing_member
        where existing_member.workspace_key=admission.workspace_key
          and existing_member.epoch_id=admission.epoch_id
          and existing_member.link_job_id<>admission.link_job_id
          and existing_member.observation_id=admission.observation_id
          and existing_member.observation_content_hash=admission.observation_content_hash
      ))
      or job.state not in ('queued','leased','retry_wait','succeeded','dead_letter','superseded')
      or admission.canonical_admission->>'productionPublicationAttempted'<>'false'
  ) then raise exception 'Gmail late link-member admission verification failed'
    using errcode='23514'; end if;

  if exists (
    select 1 from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key=lineage.workspace_key
     and epoch.root_batch_id=lineage.root_batch_id
    where job.source_system='gmail' and job.job_kind='gmail_resolve_entity_links'
      and job.state='waiting_runtime'
      and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
      and not exists (select 1 from public.truth_gmail_link_epoch_seals seal
        where seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id)
  ) then raise exception 'checkpoint-bound Gmail late link member remained parked'
    using errcode='23514'; end if;
end;
$verify$;
