-- Close the four evidenced live link dead-letter classes without weakening
-- the link-epoch seal. Successful durable resolutions are acknowledged,
-- operational lease/timeout casualties receive bounded retry authority, and
-- the known missing-anchor context-builder defect remains dead but enters the
-- final manifest through an explicit immutable exclusion receipt.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_link_epoch_members') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regclass('public.truth_link_resolution_runs') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'Gmail dead link-member closure prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_link_epoch_dead_member_resolutions (
  resolution_id text primary key check(
    resolution_id='gmail-link-epoch-dead-member-resolution:v1:'||resolution_hash
  ),
  resolution_hash text not null unique check(resolution_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null,
  epoch_id text,
  epoch_member_id text,
  action_kind text not null check(action_kind=any(array[
    'terminal_ack_own_durable_resolution','retry_context_statement_timeout',
    'retry_lease_death_orphan','exclude_missing_anchor_context_defect'
  ])),
  prior_state text not null check(prior_state='dead_letter'),
  prior_attempt_count integer not null check(prior_attempt_count>=0),
  prior_max_attempts integer not null check(prior_max_attempts>0),
  authorized_max_attempts integer not null check(authorized_max_attempts>=prior_max_attempts),
  prior_error_code text not null,
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  proof_id text not null default '',
  proof_hash text not null default '' check(proof_hash='' or proof_hash~'^[0-9a-f]{64}$'),
  canonical_resolution jsonb not null check(
    jsonb_typeof(canonical_resolution)='object'
    and canonical_resolution->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  constraint truth_gmail_link_epoch_dead_member_resolutions_job_action_error_key
    unique(workspace_key,source_job_id,action_kind,prior_error_detail_hash),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,epoch_id)
    references public.truth_gmail_link_epochs(workspace_key,epoch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,epoch_member_id)
    references public.truth_gmail_link_epoch_members(workspace_key,member_id)
    on update restrict on delete restrict,
  check((action_kind='exclude_missing_anchor_context_defect')
    or (epoch_id is not null and epoch_member_id is not null)),
  check((epoch_id is null)=(epoch_member_id is null)),
  check(resolution_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_resolution),'UTF8'
  ),'sha256'),'hex'))
);

-- Reapplication upgrade: the first applied revision required epoch membership
-- for every receipt. Missing-anchor findings must also be recordable before
-- enrollment, because the context defect can predate an epoch member.
alter table public.truth_gmail_link_epoch_dead_member_resolutions
  alter column epoch_id drop not null,
  alter column epoch_member_id drop not null;
do $receipt_shape$
declare
  v_constraint record;
begin
  -- The first production application let PostgreSQL generate a truncated
  -- constraint name. Identify that v1 uniqueness by its exact column
  -- signature instead of guessing the generated identifier.
  for v_constraint in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid=
        'public.truth_gmail_link_epoch_dead_member_resolutions'::regclass
      and constraint_row.contype='u'
      and (select array_agg(attribute.attname order by key.ordinality)
        from unnest(constraint_row.conkey) with ordinality key(attnum,ordinality)
        join pg_attribute attribute
          on attribute.attrelid=constraint_row.conrelid
         and attribute.attnum=key.attnum
      )=array['workspace_key','source_job_id']::name[]
  loop
    execute format('alter table public.truth_gmail_link_epoch_dead_member_resolutions drop constraint %I',
      v_constraint.conname);
  end loop;
  if not exists(select 1 from pg_constraint
    where conrelid='public.truth_gmail_link_epoch_dead_member_resolutions'::regclass
      and conname='truth_gmail_link_epoch_dead_member_resolutions_job_action_error_key') then
    alter table public.truth_gmail_link_epoch_dead_member_resolutions
      add constraint truth_gmail_link_epoch_dead_member_resolutions_job_action_error_key
      unique(workspace_key,source_job_id,action_kind,prior_error_detail_hash);
  end if;
  if not exists(select 1 from pg_constraint
    where conrelid='public.truth_gmail_link_epoch_dead_member_resolutions'::regclass
      and conname='truth_gmail_link_epoch_dead_member_resolutions_epoch_shape') then
    alter table public.truth_gmail_link_epoch_dead_member_resolutions
      add constraint truth_gmail_link_epoch_dead_member_resolutions_epoch_shape
      check((action_kind='exclude_missing_anchor_context_defect'
        or (epoch_id is not null and epoch_member_id is not null))
        and ((epoch_id is null)=(epoch_member_id is null)));
  end if;
end;
$receipt_shape$;

drop trigger if exists truth_gmail_link_epoch_dead_member_resolutions_immutable
  on public.truth_gmail_link_epoch_dead_member_resolutions;
create trigger truth_gmail_link_epoch_dead_member_resolutions_immutable
before update or delete on public.truth_gmail_link_epoch_dead_member_resolutions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_link_epoch_dead_member_resolutions enable row level security;
alter table public.truth_gmail_link_epoch_dead_member_resolutions force row level security;
revoke all on public.truth_gmail_link_epoch_dead_member_resolutions
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_link_epoch_dead_member_resolutions to service_role;

do $resolve$
declare
  v_job record;
  v_run public.truth_link_resolution_runs%rowtype;
  v_action text;
  v_reason text;
  v_proof_id text;
  v_proof_hash text;
  v_max integer;
  v_body jsonb;
  v_hash text;
  v_id text;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_job in
    select job.*,member.epoch_id,member.member_id epoch_member_id
    from public.source_processing_jobs job
    left join public.truth_gmail_link_epoch_members member
      on member.workspace_key=job.workspace_key and member.link_job_id=job.job_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_resolve_entity_links'
      and job.state='dead_letter' and job.lease_owner is null
      and job.lease_expires_at is null
    order by job.job_id for update of job
  loop
    v_proof_id:=''; v_proof_hash:=''; v_max:=v_job.max_attempts;
    if v_job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth-link job already has a different durable resolution'
        in v_job.safe_error_detail)>0 then
      select * into strict v_run from public.truth_link_resolution_runs run
      where run.workspace_key=v_job.workspace_key and run.job_id=v_job.job_id
        and run.anchor_observation_id=v_job.observation_id
        and run.resolution_hash=encode(extensions.digest(convert_to(
          run.canonical_resolution::text,'UTF8'),'sha256'),'hex')
        and run.resolution_run_id='link-resolution:v1:'||run.resolution_hash
        and run.canonical_resolution#>>'{job,jobId}'=v_job.job_id::text
        and run.canonical_resolution#>>'{job,anchorObservationId}'=v_job.observation_id
        and jsonb_typeof(run.canonical_resolution)='object';
      v_action:='terminal_ack_own_durable_resolution';
      v_reason:='DURABLE_LINK_RESOLUTION_PRECEDED_FAILED_ACKNOWLEDGEMENT';
      v_proof_id:=v_run.resolution_run_id; v_proof_hash:=v_run.resolution_hash;
    elsif v_job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('load truth-link worker context failed: canceling statement due to statement timeout'
        in v_job.safe_error_detail)>0 then
      v_action:='retry_context_statement_timeout';
      v_reason:='PLANNER_STATS_CRASH_WIPE_FIXED_BY_ANALYZE';
      v_max:=greatest(v_job.max_attempts,v_job.attempt_count+3);
    elsif v_job.last_error_code='LEASE_EXPIRED'
      and v_job.safe_error_detail='The prior processing lease expired before acknowledgement.' then
      v_action:='retry_lease_death_orphan';
      v_reason:='LEASE_DEATH_ORPHAN_NOT_WORK_FAILURE';
      v_max:=greatest(v_job.max_attempts,v_job.attempt_count+3);
    elsif v_job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth link context omitted its anchor' in v_job.safe_error_detail)>0
      and not exists(select 1 from public.truth_link_resolution_runs run
        where run.workspace_key=v_job.workspace_key and run.job_id=v_job.job_id) then
      v_action:='exclude_missing_anchor_context_defect';
      v_reason:='DOCUMENTED_LINK_CONTEXT_BUILDER_ANCHOR_OMISSION';
    else
      raise exception 'unknown primary Gmail dead link-member class: %',v_job.job_id
        using errcode='55000';
    end if;

    v_body:=jsonb_build_object(
      'schemaVersion','gmail-link-epoch-dead-member-resolution-v1',
      'workspaceKey','primary','connectionKey','primary','sourceJobId',v_job.job_id,
      'epochId',v_job.epoch_id,'epochMemberId',v_job.epoch_member_id,
      'actionKind',v_action,'reasonCode',v_reason,'priorState',v_job.state,
      'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_max,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'proofId',v_proof_id,'proofHash',v_proof_hash,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id:='gmail-link-epoch-dead-member-resolution:v1:'||v_hash;
    insert into public.truth_gmail_link_epoch_dead_member_resolutions(
      resolution_id,resolution_hash,workspace_key,connection_key,source_job_id,
      epoch_id,epoch_member_id,action_kind,prior_state,prior_attempt_count,
      prior_max_attempts,authorized_max_attempts,prior_error_code,
      prior_error_detail_hash,proof_id,proof_hash,canonical_resolution
    ) values(v_id,v_hash,'primary','primary',v_job.job_id,v_job.epoch_id,
      v_job.epoch_member_id,v_action,v_job.state,v_job.attempt_count,
      v_job.max_attempts,v_max,v_job.last_error_code,
      v_body->>'priorErrorDetailHash',v_proof_id,v_proof_hash,v_body)
    on conflict(workspace_key,source_job_id,action_kind,prior_error_detail_hash)
    do nothing;

    if v_action='terminal_ack_own_durable_resolution' then
      update public.source_processing_jobs set state='succeeded',
        completed_at=clock_timestamp(),last_error_code='',safe_error_detail='',
        result=jsonb_build_object('schemaVersion','truth-link-worker-result-v1',
          'resolutionRunId',v_run.resolution_run_id,'resolutionHash',v_run.resolution_hash,
          'proposalCount',v_run.proposal_count,'terminalAcknowledgement',true,
          'productionPublicationAttempted',false),updated_at=clock_timestamp()
      where job_id=v_job.job_id and state='dead_letter';
    elsif v_action in ('retry_context_statement_timeout','retry_lease_death_orphan') then
      update public.source_processing_jobs set state='retry_wait',max_attempts=v_max,
        available_at=clock_timestamp(),completed_at=null,last_error_code=case
          when v_action='retry_context_statement_timeout'
            then 'GMAIL_LINK_CONTEXT_TIMEOUT_RETRY_AUTHORIZED'
          else 'GMAIL_LINK_LEASE_DEATH_RETRY_AUTHORIZED' end,
        safe_error_detail=v_reason,updated_at=clock_timestamp()
      where job_id=v_job.job_id and state='dead_letter';
    end if;
  end loop;
end;
$resolve$;

-- Seal the complete member frontier. A member is complete iff it has a real
-- succeeded worker result or an immutable documented-defect exclusion.
create or replace function private.seal_truth_gmail_link_epoch(
  p_workspace_key text,p_epoch_id text,p_sync_token text
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_epoch public.truth_gmail_link_epochs%rowtype;
  v_seal public.truth_gmail_link_epoch_seals%rowtype;
  v_manifest jsonb; v_canonical jsonb;
  v_manifest_hash text; v_seal_hash text; v_seal_id text;
  v_count integer; v_total integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000'; end if;
  select * into strict v_epoch from public.truth_gmail_link_epochs
  where workspace_key=p_workspace_key and epoch_id=p_epoch_id;
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-link-epoch-seal:'||p_workspace_key||':'||p_epoch_id,0));
  select count(*)::integer,coalesce(jsonb_agg(
    case when job.state='succeeded' then jsonb_build_object(
      'linkJobId',member.link_job_id,'observationId',member.observation_id,
      'memberHash',member.member_hash,'disposition','resolved',
      'workerResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(job.result),'UTF8'),'sha256'),'hex'))
    when legacy_ack.authorization_id is not null then jsonb_build_object(
      'linkJobId',member.link_job_id,'observationId',member.observation_id,
      'memberHash',member.member_hash,
      'disposition','durable_resolution_acknowledged',
      'acknowledgementReceiptId',legacy_ack.authorization_id,
      'acknowledgementReceiptHash',legacy_ack.authorization_hash,
      'resolutionRunId',legacy_ack.proof_id,
      'resolutionHash',legacy_ack.proof_hash)
    else jsonb_build_object(
      'linkJobId',member.link_job_id,'observationId',member.observation_id,
      'memberHash',member.member_hash,
      'disposition','documented_context_builder_defect_excluded',
      'exclusionReceiptId',resolution.resolution_id,
      'exclusionReceiptHash',resolution.resolution_hash)
    end order by member.observation_id,member.link_job_id),'[]'::jsonb)
  into v_count,v_manifest
  from public.truth_gmail_link_epoch_members member
  join public.source_processing_jobs job
    on job.workspace_key=member.workspace_key and job.job_id=member.link_job_id
  left join public.truth_gmail_link_epoch_dead_member_resolutions resolution
    on resolution.workspace_key=member.workspace_key
   and resolution.source_job_id=member.link_job_id
   and resolution.action_kind='exclude_missing_anchor_context_defect'
  left join public.truth_gmail_live_dead_letter_authorizations legacy_ack
    on legacy_ack.workspace_key=member.workspace_key
   and legacy_ack.source_job_id=member.link_job_id
   and legacy_ack.action_kind='terminal_ack_own_durable_resolution'
   and legacy_ack.proof_id<>'' and legacy_ack.proof_hash~'^[0-9a-f]{64}$'
  where member.workspace_key=p_workspace_key and member.epoch_id=p_epoch_id
    and (job.state='succeeded' or resolution.resolution_id is not null
      or (job.state='superseded' and legacy_ack.authorization_id is not null));
  select count(*)::integer into v_total
  from public.truth_gmail_link_epoch_members member
  where member.workspace_key=p_workspace_key and member.epoch_id=p_epoch_id;
  if v_count<>v_total then raise exception
    'Gmail link epoch is waiting for every bound link resolution'
    using errcode='55000'; end if;
  v_manifest_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_manifest),'UTF8'),'sha256'),'hex');
  v_canonical:=jsonb_build_object('schemaVersion','gmail-link-epoch-seal-v1',
    'workspaceKey',p_workspace_key,'epochId',v_epoch.epoch_id,
    'epochHash',v_epoch.epoch_hash,'linkManifestHash',v_manifest_hash,
    'linkMemberCount',v_count);
  v_seal_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical),'UTF8'),'sha256'),'hex');
  v_seal_id:='gmail-link-epoch-seal:v1:'||v_seal_hash;
  insert into public.truth_gmail_link_epoch_seals(workspace_key,epoch_id,
    link_manifest_hash,link_member_count,seal_id,canonical_seal,seal_hash,schema_version)
  values(p_workspace_key,p_epoch_id,v_manifest_hash,v_count,v_seal_id,v_canonical,
    v_seal_hash,'gmail-link-epoch-seal-v1')
  on conflict(workspace_key,epoch_id) do nothing;
  select * into strict v_seal from public.truth_gmail_link_epoch_seals
  where workspace_key=p_workspace_key and epoch_id=p_epoch_id;
  if v_seal.canonical_seal is distinct from v_canonical then
    raise exception 'Gmail link epoch seal conflicts on replay' using errcode='23505'; end if;
  update public.source_processing_jobs job
  set state='queued',last_error_code='',safe_error_detail='',
    available_at=clock_timestamp(),updated_at=clock_timestamp()
  from public.source_processing_job_lineage lineage
  where job.job_id=lineage.job_id and job.workspace_key=p_workspace_key
    and lineage.workspace_key=p_workspace_key and lineage.root_batch_id=v_epoch.root_batch_id
    and job.state='waiting_runtime'
    and job.job_kind=any(array['gmail_extract_message_claims','gmail_extract_attachment_claims']);
  return jsonb_build_object('ok',true,'epochId',v_epoch.epoch_id,
    'epochHash',v_epoch.epoch_hash,'sealId',v_seal.seal_id,
    'sealHash',v_seal.seal_hash,'linkMemberCount',v_count,
    'mutatesOperationalState',false,'publishesTruth',false,'performsActions',false,
    'productionPublicationAttempted',false);
end;
$function$;
revoke all on function private.seal_truth_gmail_link_epoch(text,text,text)
  from public,anon,authenticated,service_role;

do $verify$
begin
  if exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_kind='gmail_resolve_entity_links' and job.state='dead_letter'
      and not exists(select 1 from public.truth_gmail_link_epoch_dead_member_resolutions receipt
        where receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id
          and receipt.action_kind='exclude_missing_anchor_context_defect')) then
    raise exception 'unknown primary Gmail dead link member remained after closure'
      using errcode='55000'; end if;
  if exists(select 1 from public.truth_gmail_link_epoch_dead_member_resolutions receipt
    where receipt.canonical_resolution->>'productionPublicationAttempted'<>'false') then
    raise exception 'dead link-member resolution attempted production publication'
      using errcode='23514'; end if;
end;
$verify$;
