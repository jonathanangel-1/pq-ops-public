-- Canonical Gmail link epochs are deliberately separate from proposal writes.
-- A parsed checkpoint opens one immutable epoch; link workers may run only
-- against that epoch, and claim workers may run only after its result seal.

create table if not exists public.truth_gmail_link_epochs (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  root_batch_id uuid not null,
  connection_key text not null,
  parse_checkpoint_id text not null,
  parse_checkpoint_hash text not null check(parse_checkpoint_hash~'^[0-9a-f]{64}$'),
  predecessor_epoch_id text,
  predecessor_epoch_hash text check(predecessor_epoch_hash is null or predecessor_epoch_hash~'^[0-9a-f]{64}$'),
  epoch_id text not null unique check(epoch_id~'^gmail-link-epoch:v1:[0-9a-f]{64}$'),
  canonical_epoch jsonb not null check(jsonb_typeof(canonical_epoch)='object'),
  epoch_hash text not null unique check(epoch_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(schema_version='gmail-link-epoch-v1'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,root_batch_id),
  unique(workspace_key,epoch_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parse_checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,predecessor_epoch_id)
    references public.truth_gmail_link_epochs(workspace_key,epoch_id)
    on update restrict on delete restrict,
  check((predecessor_epoch_id is null)=(predecessor_epoch_hash is null)),
  check(epoch_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_epoch),'UTF8'
  ),'sha256'),'hex')),
  check(epoch_id='gmail-link-epoch:v1:'||epoch_hash)
);

create table if not exists public.truth_gmail_link_epoch_members (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  epoch_id text not null,
  link_job_id uuid not null unique,
  observation_id text not null,
  observation_content_hash text not null check(observation_content_hash~'^[0-9a-f]{64}$'),
  member_id text not null unique check(member_id~'^gmail-link-epoch-member:v1:[0-9a-f]{64}$'),
  canonical_member jsonb not null check(jsonb_typeof(canonical_member)='object'),
  member_hash text not null unique check(member_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(schema_version='gmail-link-epoch-member-v1'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,epoch_id,link_job_id),
  foreign key(workspace_key,epoch_id)
    references public.truth_gmail_link_epochs(workspace_key,epoch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,link_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check(member_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_member),'UTF8'
  ),'sha256'),'hex')),
  check(member_id='gmail-link-epoch-member:v1:'||member_hash)
);

create table if not exists public.truth_gmail_link_epoch_seals (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  epoch_id text not null,
  link_manifest_hash text not null check(link_manifest_hash~'^[0-9a-f]{64}$'),
  link_member_count integer not null check(link_member_count>=0),
  seal_id text not null unique check(seal_id~'^gmail-link-epoch-seal:v1:[0-9a-f]{64}$'),
  canonical_seal jsonb not null check(jsonb_typeof(canonical_seal)='object'),
  seal_hash text not null unique check(seal_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(schema_version='gmail-link-epoch-seal-v1'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,epoch_id),
  foreign key(workspace_key,epoch_id)
    references public.truth_gmail_link_epochs(workspace_key,epoch_id)
    on update restrict on delete restrict,
  check(seal_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_seal),'UTF8'
  ),'sha256'),'hex')),
  check(seal_id='gmail-link-epoch-seal:v1:'||seal_hash)
);

do $block$
declare v_table text;
begin
  foreach v_table in array array[
    'truth_gmail_link_epochs','truth_gmail_link_epoch_members',
    'truth_gmail_link_epoch_seals'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I',v_table,v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I '
      ||'for each row execute function public.reject_immutable_truth_mutation()',
      v_table,v_table
    );
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on public.%I to service_role',v_table);
  end loop;
end;
$block$;

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
  v_canonical jsonb;
  v_epoch_hash text;
  v_epoch_id text;
  v_member jsonb;
  v_member_hash text;
  v_member_id text;
  v_count integer:=0;
  v_job record;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=p_root_batch_id
    and source_system='gmail' and status='committed';
  select * into strict v_checkpoint from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id
    and terminal_gap_count=0;
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-link-epoch:'||p_workspace_key||':'||v_batch.connection_key,0
  ));
  select * into v_epoch from public.truth_gmail_link_epochs
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  if found then
    return jsonb_build_object(
      'ok',true,'epochId',v_epoch.epoch_id,'epochHash',v_epoch.epoch_hash,
      'parseCheckpointId',v_checkpoint.checkpoint_id,
      'memberCount',(select count(*) from public.truth_gmail_link_epoch_members
        where workspace_key=p_workspace_key and epoch_id=v_epoch.epoch_id),
      'mutatesOperationalState',false,'publishesTruth',false,'performsActions',false
    );
  end if;
  select * into v_previous from public.truth_gmail_link_epochs
  where workspace_key=p_workspace_key and connection_key=v_batch.connection_key
    and root_batch_id<>p_root_batch_id
  order by created_at desc,epoch_id desc limit 1;
  v_canonical:=jsonb_build_object(
    'schemaVersion','gmail-link-epoch-v1',
    'workspaceKey',p_workspace_key,'connectionKey',v_batch.connection_key,
    'rootBatchId',p_root_batch_id,
    'parseCheckpointId',v_checkpoint.checkpoint_id,
    'parseCheckpointHash',v_checkpoint.checkpoint_hash,
    'predecessor',case when v_previous.epoch_id is null then null else jsonb_build_object(
      'epochId',v_previous.epoch_id,'epochHash',v_previous.epoch_hash
    ) end,
    'policyVersion','gmail-link-epoch-policy-v1'
  );
  v_epoch_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical),'UTF8'
  ),'sha256'),'hex');
  v_epoch_id:='gmail-link-epoch:v1:'||v_epoch_hash;
  insert into public.truth_gmail_link_epochs(
    workspace_key,root_batch_id,connection_key,parse_checkpoint_id,parse_checkpoint_hash,
    predecessor_epoch_id,predecessor_epoch_hash,epoch_id,canonical_epoch,epoch_hash,schema_version
  ) values (
    p_workspace_key,p_root_batch_id,v_batch.connection_key,v_checkpoint.checkpoint_id,v_checkpoint.checkpoint_hash,
    v_previous.epoch_id,v_previous.epoch_hash,v_epoch_id,v_canonical,v_epoch_hash,'gmail-link-epoch-v1'
  ) on conflict(workspace_key,root_batch_id) do nothing;
  select * into strict v_epoch from public.truth_gmail_link_epochs
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  if v_epoch.canonical_epoch is distinct from v_canonical then
    raise exception 'Gmail link epoch conflicts on replay' using errcode='23505';
  end if;
  for v_job in
    select job.job_id,job.observation_id,observation.content_hash
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.job_id=job.job_id and lineage.workspace_key=job.workspace_key
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key and observation.observation_id=job.observation_id
    where job.workspace_key=p_workspace_key and job.source_system='gmail'
      and job.job_kind='gmail_resolve_entity_links'
      and lineage.root_batch_id=p_root_batch_id
      and observation.source_object_type='gmail_message_parsed'
    order by job.job_id
  loop
    v_member:=jsonb_build_object(
      'schemaVersion','gmail-link-epoch-member-v1',
      'workspaceKey',p_workspace_key,'epochId',v_epoch.epoch_id,
      'linkJobId',v_job.job_id,'observationId',v_job.observation_id,
      'observationContentHash',v_job.content_hash
    );
    v_member_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_member),'UTF8'
    ),'sha256'),'hex');
    v_member_id:='gmail-link-epoch-member:v1:'||v_member_hash;
    insert into public.truth_gmail_link_epoch_members(
      workspace_key,epoch_id,link_job_id,observation_id,observation_content_hash,
      member_id,canonical_member,member_hash,schema_version
    ) values (
      p_workspace_key,v_epoch.epoch_id,v_job.job_id,v_job.observation_id,v_job.content_hash,
      v_member_id,v_member,v_member_hash,'gmail-link-epoch-member-v1'
    ) on conflict(link_job_id) do nothing;
    v_count:=v_count+1;
  end loop;
  if v_count<>v_checkpoint.member_count then
    raise exception 'Gmail link epoch must bind every parsed checkpoint member'
      using errcode='23514';
  end if;
  update public.source_processing_jobs job
  set state='queued',last_error_code='',safe_error_detail='',available_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=p_workspace_key and job.state='waiting_runtime'
    and job.job_kind='gmail_resolve_entity_links'
    and exists (select 1 from public.truth_gmail_link_epoch_members member
      where member.workspace_key=p_workspace_key and member.link_job_id=job.job_id
        and member.epoch_id=v_epoch.epoch_id);
  return jsonb_build_object(
    'ok',true,'epochId',v_epoch.epoch_id,'epochHash',v_epoch.epoch_hash,
    'parseCheckpointId',v_checkpoint.checkpoint_id,'memberCount',v_count,
    'mutatesOperationalState',false,'publishesTruth',false,'performsActions',false
  );
end;
$function$;

create or replace function private.seal_truth_gmail_link_epoch(
  p_workspace_key text,p_epoch_id text,p_sync_token text
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_epoch public.truth_gmail_link_epochs%rowtype;
  v_seal public.truth_gmail_link_epoch_seals%rowtype;
  v_manifest jsonb;
  v_canonical jsonb;
  v_manifest_hash text;
  v_seal_hash text;
  v_seal_id text;
  v_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  select * into strict v_epoch from public.truth_gmail_link_epochs
  where workspace_key=p_workspace_key and epoch_id=p_epoch_id;
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-link-epoch-seal:'||p_workspace_key||':'||p_epoch_id,0
  ));
  select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
    'linkJobId',member.link_job_id,'observationId',member.observation_id,
    'memberHash',member.member_hash,
    'workerResultHash',encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(job.result),'UTF8'
    ),'sha256'),'hex')
  ) order by member.observation_id,member.link_job_id),'[]'::jsonb)
  into v_count,v_manifest
  from public.truth_gmail_link_epoch_members member
  join public.source_processing_jobs job
    on job.workspace_key=member.workspace_key and job.job_id=member.link_job_id
  where member.workspace_key=p_workspace_key and member.epoch_id=p_epoch_id
    and job.state='succeeded';
  if v_count<>(select count(*) from public.truth_gmail_link_epoch_members
      where workspace_key=p_workspace_key and epoch_id=p_epoch_id) then
    raise exception 'Gmail link epoch is waiting for every bound link resolution'
      using errcode='55000';
  end if;
  v_manifest_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_manifest),'UTF8'
  ),'sha256'),'hex');
  v_canonical:=jsonb_build_object(
    'schemaVersion','gmail-link-epoch-seal-v1',
    'workspaceKey',p_workspace_key,'epochId',v_epoch.epoch_id,
    'epochHash',v_epoch.epoch_hash,'linkManifestHash',v_manifest_hash,
    'linkMemberCount',v_count
  );
  v_seal_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical),'UTF8'
  ),'sha256'),'hex');
  v_seal_id:='gmail-link-epoch-seal:v1:'||v_seal_hash;
  insert into public.truth_gmail_link_epoch_seals(
    workspace_key,epoch_id,link_manifest_hash,link_member_count,seal_id,
    canonical_seal,seal_hash,schema_version
  ) values (
    p_workspace_key,p_epoch_id,v_manifest_hash,v_count,v_seal_id,
    v_canonical,v_seal_hash,'gmail-link-epoch-seal-v1'
  ) on conflict(workspace_key,epoch_id) do nothing;
  select * into strict v_seal from public.truth_gmail_link_epoch_seals
  where workspace_key=p_workspace_key and epoch_id=p_epoch_id;
  if v_seal.canonical_seal is distinct from v_canonical then
    raise exception 'Gmail link epoch seal conflicts on replay' using errcode='23505';
  end if;
  update public.source_processing_jobs job
  set state='queued',last_error_code='',safe_error_detail='',available_at=clock_timestamp(),updated_at=clock_timestamp()
  from public.source_processing_job_lineage lineage
  where job.job_id=lineage.job_id and job.workspace_key=p_workspace_key
    and lineage.workspace_key=p_workspace_key and lineage.root_batch_id=v_epoch.root_batch_id
    and job.state='waiting_runtime'
    and job.job_kind=any(array['gmail_extract_message_claims','gmail_extract_attachment_claims']);
  return jsonb_build_object(
    'ok',true,'epochId',v_epoch.epoch_id,'epochHash',v_epoch.epoch_hash,
    'sealId',v_seal.seal_id,'sealHash',v_seal.seal_hash,'linkMemberCount',v_count,
    'mutatesOperationalState',false,'publishesTruth',false,'performsActions',false
  );
end;
$function$;

create or replace function public.open_truth_gmail_link_epoch(
  p_workspace_key text,p_root_batch_id uuid,p_sync_token text
) returns jsonb language sql security definer set search_path=''
as $function$
  select private.open_truth_gmail_link_epoch(p_workspace_key,p_root_batch_id,p_sync_token);
$function$;

create or replace function public.seal_truth_gmail_link_epoch(
  p_workspace_key text,p_epoch_id text,p_sync_token text
) returns jsonb language sql security definer set search_path=''
as $function$
  select private.seal_truth_gmail_link_epoch(p_workspace_key,p_epoch_id,p_sync_token);
$function$;

revoke all on function private.open_truth_gmail_link_epoch(text,uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function private.seal_truth_gmail_link_epoch(text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.open_truth_gmail_link_epoch(text,uuid,text)
  from public,anon,authenticated;
revoke all on function public.seal_truth_gmail_link_epoch(text,text,text)
  from public,anon,authenticated;
grant execute on function public.open_truth_gmail_link_epoch(text,uuid,text) to service_role;
grant execute on function public.seal_truth_gmail_link_epoch(text,text,text) to service_role;

-- The existing routing trigger remains the only gateway.  The v2 rule admits
-- exactly epoch-bound deterministic link and claim jobs; model jobs remain
-- visibly parked while the model runtime is disabled.
create or replace function private.route_gmail_link_claim_wait_v2()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.source_system='gmail' and new.job_kind='gmail_fetch_raw_message'
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MESSAGE_REVISION_SCHEMA_REQUIRED';
    new.safe_error_detail:='Legacy raw-fetch jobs are quarantined; revision materialization v1 is required.';
  elsif new.source_system='gmail' and new.job_kind='gmail_resolve_entity_links'
    and new.state in ('queued','retry_wait') and not exists (
      select 1 from public.truth_gmail_link_epoch_members member
      where member.workspace_key=new.workspace_key and member.link_job_id=new.job_id
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED';
    new.safe_error_detail:='Parsed evidence is durable; an epoch-bound link member is required.';
  elsif new.source_system='gmail' and new.job_kind=any(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims'
    ]) and new.state in ('queued','retry_wait') and not exists (
      select 1 from public.source_processing_job_lineage lineage
      join public.truth_gmail_link_epochs epoch
        on epoch.workspace_key=lineage.workspace_key and epoch.root_batch_id=lineage.root_batch_id
      join public.truth_gmail_link_epoch_seals seal
        on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
      where lineage.job_id=new.job_id and lineage.workspace_key=new.workspace_key
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SEAL_REQUIRED';
    new.safe_error_detail:='Claim extraction waits for the exact sealed Gmail link epoch.';
  elsif new.source_system='gmail' and new.job_kind=any(array[
      'gmail_extract_message_model_claims','gmail_review_model_extraction'
    ]) and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MODEL_RUNTIME_DISABLED';
    new.safe_error_detail:='The local shadow rollout permits deterministic extraction only.';
  end if;
  return new;
end;
$function$;

revoke all on function private.route_gmail_link_claim_wait_v2()
  from public,anon,authenticated,service_role;
drop trigger if exists source_processing_job_gmail_link_claim_wait on public.source_processing_jobs;
create trigger source_processing_job_gmail_link_claim_wait
  before insert or update of state on public.source_processing_jobs
  for each row execute function private.route_gmail_link_claim_wait_v2();

-- Preserve the fenced source-processing API, but make the formerly global
-- Gmail exclusion conditional on the durable epoch receipt.  Lineage creation
-- stays in the prior implementation; every job admitted here must already
-- have exact source-batch lineage.
create or replace function private.claim_source_processing_jobs(
  p_workspace_key text,p_source_system text,p_connection_key text,
  p_worker_id text,p_processor_version text,p_limit integer,
  p_lease_seconds integer,p_job_kinds text[],p_sync_token text
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_jobs jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or nullif(trim(coalesce(p_source_system,'')),'') is null
    or nullif(trim(coalesce(p_connection_key,'')),'') is null
    or nullif(trim(coalesce(p_worker_id,'')),'') is null
    or nullif(trim(coalesce(p_processor_version,'')),'') is null
    or p_limit is null or p_limit<1 or p_limit>50
    or p_lease_seconds is null or p_lease_seconds<30 or p_lease_seconds>900
    or exists(select 1 from unnest(coalesce(p_job_kinds,array[]::text[])) item
      where nullif(trim(item),'') is null) then
    raise exception 'invalid source-processing claim request' using errcode='22023';
  end if;
  update public.source_processing_jobs job
  set state=case when job.attempt_count>=job.max_attempts then 'dead_letter' else 'retry_wait' end,
      available_at=case when job.attempt_count>=job.max_attempts then job.available_at else v_now end,
      lease_owner=null,lease_expires_at=null,last_error_code='LEASE_EXPIRED',
      safe_error_detail='The prior processing lease expired before acknowledgement.',
      updated_at=v_now,completed_at=case when job.attempt_count>=job.max_attempts then v_now else null end
  where job.workspace_key=p_workspace_key and job.source_system=p_source_system
    and job.connection_key=p_connection_key and job.state='leased'
    and (job.lease_expires_at is null or job.lease_expires_at<=v_now);
  insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  )
  select distinct job.job_id,job.workspace_key,job.source_system,job.connection_key,
    batch.batch_id,null::uuid,job.job_id,batch.committed_cursor_version,batch.committed_cursor_value
  from public.source_processing_jobs job
  join public.source_ingest_batches batch
    on batch.batch_id::text=job.payload->>'batchId'
   and batch.workspace_key=job.workspace_key and batch.source_system=job.source_system
   and batch.connection_key=job.connection_key and batch.status='committed'
   and batch.committed_cursor_version is not null and nullif(batch.committed_cursor_value,'') is not null
  left join public.gmail_ingest_page_jobs page_job
    on page_job.job_id=job.job_id and page_job.batch_id=batch.batch_id
  left join public.source_observations anchor
    on anchor.observation_id=job.observation_id and anchor.workspace_key=job.workspace_key
   and anchor.source_system=job.source_system and anchor.connection_key=job.connection_key
   and anchor.batch_id=batch.batch_id
  where job.workspace_key=p_workspace_key and job.source_system=p_source_system
    and job.connection_key=p_connection_key
    and not exists(select 1 from public.source_processing_job_lineage lineage where lineage.job_id=job.job_id)
    and ((job.source_system='gmail' and page_job.job_id is not null)
      or (job.source_system<>'gmail' and anchor.observation_id is not null))
    and (job.source_system<>'gmail' or batch.committed_cursor_value~'^[0-9]+$')
  on conflict(job_id) do nothing;
  with candidates as (
    select job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.job_id=job.job_id and lineage.workspace_key=job.workspace_key
       and lineage.source_system=job.source_system and lineage.connection_key=job.connection_key
    join public.source_ingest_batches batch
      on batch.batch_id=lineage.root_batch_id and batch.workspace_key=lineage.workspace_key
       and batch.source_system=lineage.source_system and batch.connection_key=lineage.connection_key
       and batch.status='committed' and batch.committed_cursor_version=lineage.source_cursor_version
       and batch.committed_cursor_value=lineage.source_cursor_value
    where job.workspace_key=p_workspace_key and job.source_system=p_source_system
      and job.connection_key=p_connection_key and job.state in ('queued','retry_wait')
      and job.available_at<=v_now and job.attempt_count<job.max_attempts
      and (coalesce(cardinality(p_job_kinds),0)=0 or job.job_kind=any(p_job_kinds))
      and (job.source_system<>'gmail' or lineage.source_cursor_value~'^[0-9]+$')
      and not (job.source_system='gmail' and job.job_kind='gmail_fetch_raw_message')
      and not (job.source_system='gmail' and job.job_kind=any(array[
        'gmail_extract_message_model_claims','gmail_review_model_extraction'
      ]))
      and (job.job_kind<>'gmail_resolve_entity_links' or exists (
        select 1 from public.truth_gmail_link_epoch_members member
        where member.workspace_key=job.workspace_key and member.link_job_id=job.job_id
      ))
      and (job.job_kind<>all(array['gmail_extract_message_claims','gmail_extract_attachment_claims'])
        or exists (
          select 1 from public.truth_gmail_link_epochs epoch
          join public.truth_gmail_link_epoch_seals seal
            on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
          where epoch.workspace_key=job.workspace_key and epoch.root_batch_id=lineage.root_batch_id
        ))
      and (job.job_kind<>'gmail_materialize_message_revision' or (
        exists(select 1 from public.gmail_message_materialization_groups group_row
          where group_row.workspace_key=job.workspace_key and group_row.materialization_job_id=job.job_id)
        and not exists(
          select 1 from public.gmail_message_materialization_groups current_group
          join public.gmail_message_materialization_groups prior_group
            on prior_group.workspace_key=current_group.workspace_key
           and prior_group.connection_key=current_group.connection_key
           and prior_group.message_id=current_group.message_id
           and prior_group.route_disposition='materialize_revision'
           and (prior_group.source_cursor_version<current_group.source_cursor_version
             or (prior_group.source_cursor_version=current_group.source_cursor_version
               and prior_group.group_id<current_group.group_id))
          join public.source_processing_jobs prior_job
            on prior_job.workspace_key=prior_group.workspace_key and prior_job.job_id=prior_group.materialization_job_id
          where current_group.workspace_key=job.workspace_key and current_group.materialization_job_id=job.job_id
            and prior_job.state not in ('succeeded','dead_letter','superseded')
        )
      ))
    order by case when job.job_kind='gmail_materialize_message_revision' then lineage.source_cursor_version else 0 end,
      job.available_at,job.created_at,job.job_id
    for update of job skip locked limit p_limit
  ), claimed as (
    update public.source_processing_jobs job
    set state='leased',attempt_count=job.attempt_count+1,lease_owner=p_worker_id,
      lease_fence=job.lease_fence+1,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
      last_error_code='',safe_error_detail='',processor_version=p_processor_version,
      updated_at=v_now,completed_at=null
    from candidates where job.job_id=candidates.job_id returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId',claimed.job_id,'dedupeKey',claimed.dedupe_key,'jobKind',claimed.job_kind,
    'observationId',claimed.observation_id,'sourceObjectId',claimed.source_object_id,
    'attemptCount',claimed.attempt_count,'maxAttempts',claimed.max_attempts,
    'leaseFence',claimed.lease_fence,'leaseExpiresAt',claimed.lease_expires_at,
    'processorVersion',claimed.processor_version,'payload',claimed.payload,
    'rootBatchId',lineage.root_batch_id,'rootJobId',lineage.root_job_id,
    'parentJobId',lineage.parent_job_id,'sourceCursorVersion',lineage.source_cursor_version,
    'sourceCursorValue',lineage.source_cursor_value
  )||case when claimed.job_kind='gmail_materialize_message_revision' then jsonb_build_object(
    'materializationAuthority',private.load_gmail_materialization_authority_v1(
      claimed.workspace_key,claimed.job_id
    )
  ) else '{}'::jsonb end order by claimed.available_at,claimed.created_at,claimed.job_id),'[]'::jsonb)
  into v_jobs from claimed join public.source_processing_job_lineage lineage on lineage.job_id=claimed.job_id;
  return jsonb_build_object('ok',true,'workerId',p_worker_id,'processorVersion',p_processor_version,
    'leaseSeconds',p_lease_seconds,'claimedCount',jsonb_array_length(v_jobs),'jobs',v_jobs);
end;
$function$;

revoke all on function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public,anon,authenticated,service_role;
