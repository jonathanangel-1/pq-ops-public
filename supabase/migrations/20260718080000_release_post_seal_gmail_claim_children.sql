-- A claim child is inserted before its immutable job-lineage row. The Gmail
-- route trigger therefore cannot see an already-sealed root during the child
-- INSERT and correctly parks the row. Re-evaluate only that exact parked
-- class after lineage becomes durable, receipt first, so attachment reviews
-- completed after the link seal cannot strand their claim children.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.truth_gmail_link_epochs') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.route_gmail_link_claim_wait_v2()') is null then
    raise exception 'post-seal Gmail claim release prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_post_seal_claim_releases(
  release_id text primary key check(
    release_id='truth-gmail-post-seal-claim-release:v1:'||release_hash
  ),
  release_hash text not null unique check(release_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  claim_job_kind text not null check(claim_job_kind=any(array[
    'gmail_extract_message_claims','gmail_extract_attachment_claims'
  ])),
  source_observation_id text not null,
  epoch_id text not null,
  epoch_hash text not null check(epoch_hash~'^[0-9a-f]{64}$'),
  seal_id text not null check(seal_id~'^gmail-link-epoch-seal:v1:[0-9a-f]{64}$'),
  seal_hash text not null check(seal_hash~'^[0-9a-f]{64}$'),
  canonical_release jsonb not null check(
    canonical_release->>'reasonCode'='GMAIL_POST_SEAL_LINEAGE_RELEASE'
    and canonical_release->>'priorState'='waiting_runtime'
    and canonical_release->>'priorErrorCode'='GMAIL_LINK_EPOCH_SEAL_REQUIRED'
    and canonical_release->>'candidateClaimsAutoAccepted'='false'
    and canonical_release->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,epoch_id)
    references public.truth_gmail_link_epoch_seals(workspace_key,epoch_id)
    on update restrict on delete restrict,
  check(release_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_release),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_post_seal_claim_releases_immutable
  on public.truth_gmail_post_seal_claim_releases;
create trigger truth_gmail_post_seal_claim_releases_immutable
before update or delete on public.truth_gmail_post_seal_claim_releases
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_post_seal_claim_releases enable row level security;
alter table public.truth_gmail_post_seal_claim_releases force row level security;
revoke all on public.truth_gmail_post_seal_claim_releases
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_post_seal_claim_releases to service_role;

create or replace function private.release_truth_gmail_post_seal_claim_v1(
  p_workspace_key text,p_job_id uuid
) returns boolean language plpgsql security definer set search_path='' as $function$
declare
  v_row record;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_existing public.truth_gmail_post_seal_claim_releases%rowtype;
  v_updated integer;
begin
  select job.*,lineage.root_batch_id,lineage.source_cursor_version,
    lineage.source_cursor_value,epoch.epoch_id,epoch.epoch_hash,
    seal.seal_id,seal.seal_hash
  into v_row
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
  join public.truth_gmail_link_epochs epoch
    on epoch.workspace_key=lineage.workspace_key
   and epoch.root_batch_id=lineage.root_batch_id
   and epoch.connection_key=job.connection_key
  join public.truth_gmail_link_epoch_seals seal
    on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
  where job.workspace_key=p_workspace_key and job.job_id=p_job_id
    and job.workspace_key='primary' and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind=any(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims'
    ])
    and job.state='waiting_runtime' and job.attempt_count=0
    and job.max_attempts=5 and job.lease_fence=0
    and job.lease_owner is null and job.lease_expires_at is null
    and job.last_error_code='GMAIL_LINK_EPOCH_SEAL_REQUIRED'
    and job.processor_version='' and job.result='{}'::jsonb
    and job.completed_at is null and job.observation_id is not null
    and not exists(select 1 from public.candidate_claim_job_manifests manifest
      where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
  for update of job;
  if not found then return false; end if;

  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-post-seal-claim-release-v1',
    'workspaceKey',v_row.workspace_key,'connectionKey',v_row.connection_key,
    'sourceJobId',v_row.job_id,'rootBatchId',v_row.root_batch_id,
    'claimJobKind',v_row.job_kind,
    'sourceObservationId',v_row.observation_id,
    'sourceCursorVersion',v_row.source_cursor_version,
    'sourceCursorValue',v_row.source_cursor_value,
    'epochId',v_row.epoch_id,'epochHash',v_row.epoch_hash,
    'sealId',v_row.seal_id,'sealHash',v_row.seal_hash,
    'priorState',v_row.state,'priorAttemptCount',v_row.attempt_count,
    'priorMaxAttempts',v_row.max_attempts,'priorLeaseFence',v_row.lease_fence,
    'priorErrorCode',v_row.last_error_code,
    'reasonCode','GMAIL_POST_SEAL_LINEAGE_RELEASE',
    'candidateClaimsAutoAccepted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  v_id:='truth-gmail-post-seal-claim-release:v1:'||v_hash;
  insert into public.truth_gmail_post_seal_claim_releases(
    release_id,release_hash,workspace_key,connection_key,source_job_id,
    root_batch_id,claim_job_kind,source_observation_id,epoch_id,epoch_hash,
    seal_id,seal_hash,canonical_release
  ) values(
    v_id,v_hash,v_row.workspace_key,v_row.connection_key,v_row.job_id,
    v_row.root_batch_id,v_row.job_kind,v_row.observation_id,v_row.epoch_id,
    v_row.epoch_hash,v_row.seal_id,v_row.seal_hash,v_body
  ) on conflict(source_job_id) do nothing;
  select * into strict v_existing
  from public.truth_gmail_post_seal_claim_releases release
  where release.workspace_key=v_row.workspace_key
    and release.source_job_id=v_row.job_id;
  if v_existing.release_id<>v_id
    or v_existing.release_hash<>v_hash
    or v_existing.canonical_release is distinct from v_body then
    raise exception 'post-seal Gmail claim release conflicts on replay'
      using errcode='23505';
  end if;

  update public.source_processing_jobs job
  set state='queued',last_error_code='',safe_error_detail='',
    available_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=v_row.workspace_key and job.job_id=v_row.job_id
    and job.state=v_row.state and job.attempt_count=v_row.attempt_count
    and job.max_attempts=v_row.max_attempts and job.lease_fence=v_row.lease_fence
    and job.lease_owner is null and job.lease_expires_at is null
    and job.last_error_code=v_row.last_error_code
    and job.processor_version=v_row.processor_version
    and job.result=v_row.result and job.completed_at is null;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'post-seal Gmail claim release fence changed'
      using errcode='40001';
  end if;
  return true;
end;
$function$;
revoke all on function private.release_truth_gmail_post_seal_claim_v1(text,uuid)
  from public,anon,authenticated,service_role;

create or replace function private.route_truth_gmail_post_seal_claim_lineage_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.workspace_key='primary' and new.source_system='gmail'
    and new.connection_key='primary' then
    perform private.release_truth_gmail_post_seal_claim_v1(
      new.workspace_key,new.job_id
    );
  end if;
  return new;
end;
$function$;
revoke all on function private.route_truth_gmail_post_seal_claim_lineage_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists source_processing_job_lineage_post_seal_claim_release
  on public.source_processing_job_lineage;
create trigger source_processing_job_lineage_post_seal_claim_release
after insert on public.source_processing_job_lineage
for each row execute function private.route_truth_gmail_post_seal_claim_lineage_v1();

do $backfill_and_verify$
declare v_job record;
begin
  for v_job in
    select job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key=lineage.workspace_key
     and epoch.root_batch_id=lineage.root_batch_id
     and epoch.connection_key=job.connection_key
    join public.truth_gmail_link_epoch_seals seal
      on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind=any(array[
        'gmail_extract_message_claims','gmail_extract_attachment_claims'
      ])
      and job.state='waiting_runtime' and job.attempt_count=0
      and job.max_attempts=5 and job.lease_fence=0
      and job.lease_owner is null and job.lease_expires_at is null
      and job.last_error_code='GMAIL_LINK_EPOCH_SEAL_REQUIRED'
      and job.processor_version='' and job.result='{}'::jsonb
      and job.completed_at is null and job.observation_id is not null
      and not exists(select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
    order by job.job_id
  loop
    if not private.release_truth_gmail_post_seal_claim_v1(
      'primary',v_job.job_id
    ) then
      raise exception 'post-seal Gmail claim release lost an eligible row'
        using errcode='40001';
    end if;
  end loop;
  if exists(
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key=lineage.workspace_key
     and epoch.root_batch_id=lineage.root_batch_id
     and epoch.connection_key=job.connection_key
    join public.truth_gmail_link_epoch_seals seal
      on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind=any(array[
        'gmail_extract_message_claims','gmail_extract_attachment_claims'
      ])
      and job.state='waiting_runtime' and job.attempt_count=0
      and job.lease_owner is null and job.lease_expires_at is null
      and job.last_error_code='GMAIL_LINK_EPOCH_SEAL_REQUIRED'
      and job.processor_version='' and job.result='{}'::jsonb
      and job.completed_at is null
  ) or exists(
    select 1 from public.truth_gmail_post_seal_claim_releases release
    join public.source_processing_jobs job
      on job.workspace_key=release.workspace_key and job.job_id=release.source_job_id
    where (job.state='waiting_runtime'
        and job.last_error_code='GMAIL_LINK_EPOCH_SEAL_REQUIRED')
      or release.canonical_release->>'productionPublicationAttempted'<>'false'
  ) then
    raise exception 'post-seal Gmail claim release verification failed'
      using errcode='55000';
  end if;
end;
$backfill_and_verify$;
