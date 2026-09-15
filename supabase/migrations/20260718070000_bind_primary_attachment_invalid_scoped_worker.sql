-- The primary first-exhaustion authority must hand its bounded cohort to the
-- dedicated invalid-retry worker. Preserve an immutable receipt for the two
-- already-authorized rows before correcting their processor identity, and
-- rewrite the authority so future transitions are atomic.

create table if not exists public.truth_gmail_primary_attachment_invalid_worker_handoffs(
  handoff_id text primary key check(
    handoff_id='truth-gmail-primary-attachment-invalid-worker-handoff:v1:'||handoff_hash
  ),
  handoff_hash text not null unique check(handoff_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  retry_lineage_id text not null unique,
  retry_lineage_hash text not null check(retry_lineage_hash~'^[0-9a-f]{64}$'),
  prior_processor_version text not null check(
    prior_processor_version='primary-attachment-model-drain-v1:worker-v1'
  ),
  next_processor_version text not null check(
    next_processor_version='primary-attachment-invalid-drain-v1:worker-v1'
  ),
  attempt_count integer not null check(attempt_count=5),
  max_attempts integer not null check(max_attempts=8),
  canonical_handoff jsonb not null check(
    canonical_handoff->>'reasonCode'='PRIMARY_ATTACHMENT_INVALID_SCOPED_WORKER_HANDOFF'
    and canonical_handoff->>'candidateClaimsAutoAccepted'='false'
    and canonical_handoff->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,retry_lineage_id)
    references public.truth_gmail_attachment_invalid_argument_retry_lineage(
      workspace_key,lineage_id
    ) on update restrict on delete restrict,
  check(handoff_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_handoff),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_primary_attachment_invalid_worker_handoffs_immutable
  on public.truth_gmail_primary_attachment_invalid_worker_handoffs;
create trigger truth_gmail_primary_attachment_invalid_worker_handoffs_immutable
before update or delete on public.truth_gmail_primary_attachment_invalid_worker_handoffs
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_primary_attachment_invalid_worker_handoffs enable row level security;
alter table public.truth_gmail_primary_attachment_invalid_worker_handoffs force row level security;
revoke all on public.truth_gmail_primary_attachment_invalid_worker_handoffs
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_primary_attachment_invalid_worker_handoffs
  to service_role;

do $rewrite_authority$
declare
  v_signature constant regprocedure :=
    'private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(uuid)'::regprocedure;
  v_definition text;
  v_old constant text := $old$  set state='retry_wait',max_attempts=v_job.attempt_count+3,
    available_at=clock_timestamp(),lease_owner=null,lease_expires_at=null,$old$;
  v_new constant text := $new$  set state='retry_wait',max_attempts=v_job.attempt_count+3,
    processor_version='primary-attachment-invalid-drain-v1:worker-v1',
    available_at=clock_timestamp(),lease_owner=null,lease_expires_at=null,$new$;
begin
  select pg_get_functiondef(v_signature) into strict v_definition;
  if position(v_new in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'primary invalid authority differs from reviewed worker-handoff predecessor'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old,v_new);
    execute v_definition;
  end if;
end;
$rewrite_authority$;

do $repair_live_handoff$
declare
  v_job record;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_updated integer;
begin
  for v_job in
    select job.*,lineage.lineage_id,lineage.lineage_hash
    from public.source_processing_jobs job
    join public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
      on lineage.workspace_key=job.workspace_key
     and lineage.source_job_id=job.job_id
     and lineage.authorized_attempt_count=5
     and lineage.authorized_max_attempts=8
     and lineage.canonical_lineage->>'captureAuthority'
       ='retry_authorization_transition_v2'
     and lineage.canonical_lineage->>'producerAuthority'
       ='primary_attachment_model_drain_v1'
     and lineage.canonical_lineage->>'productionPublicationAttempted'='false'
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.processor_version='primary-attachment-model-drain-v1:worker-v1'
      and job.state='retry_wait' and job.attempt_count=5 and job.max_attempts=8
      and job.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED'
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
    order by job.job_id
    for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-primary-attachment-invalid-worker-handoff-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'retryLineageId',v_job.lineage_id,
      'retryLineageHash',v_job.lineage_hash,
      'priorProcessorVersion',v_job.processor_version,
      'nextProcessorVersion','primary-attachment-invalid-drain-v1:worker-v1',
      'attemptCount',v_job.attempt_count,'maxAttempts',v_job.max_attempts,
      'reasonCode','PRIMARY_ATTACHMENT_INVALID_SCOPED_WORKER_HANDOFF',
      'candidateClaimsAutoAccepted',false,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id:='truth-gmail-primary-attachment-invalid-worker-handoff:v1:'||v_hash;
    insert into public.truth_gmail_primary_attachment_invalid_worker_handoffs(
      handoff_id,handoff_hash,workspace_key,connection_key,source_job_id,
      retry_lineage_id,retry_lineage_hash,prior_processor_version,
      next_processor_version,attempt_count,max_attempts,canonical_handoff
    ) values(
      v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
      v_job.lineage_id,v_job.lineage_hash,v_job.processor_version,
      'primary-attachment-invalid-drain-v1:worker-v1',
      v_job.attempt_count,v_job.max_attempts,v_body
    );
    update public.source_processing_jobs job
    set processor_version='primary-attachment-invalid-drain-v1:worker-v1',
      updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.processor_version=v_job.processor_version
      and job.state=v_job.state and job.attempt_count=v_job.attempt_count
      and job.max_attempts=v_job.max_attempts
      and job.lease_fence is not distinct from v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result=v_job.result;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'primary invalid scoped-worker handoff fence changed: %',
        v_job.job_id using errcode='40001';
    end if;
  end loop;
end;
$repair_live_handoff$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(uuid)'::regprocedure
  ) into v_definition;
  if position(
      'processor_version=''primary-attachment-invalid-drain-v1:worker-v1'''
      in v_definition
    )=0
    or exists(select 1
      from public.source_processing_jobs job
      join public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
        on lineage.workspace_key=job.workspace_key
       and lineage.source_job_id=job.job_id
       and lineage.canonical_lineage->>'producerAuthority'
         ='primary_attachment_model_drain_v1'
      where job.workspace_key='primary'
        and job.processor_version='primary-attachment-model-drain-v1:worker-v1'
        and job.state='retry_wait' and job.attempt_count=5 and job.max_attempts=8)
    or exists(select 1
      from public.truth_gmail_primary_attachment_invalid_worker_handoffs handoff
      join public.source_processing_jobs job
        on job.workspace_key=handoff.workspace_key
       and job.job_id=handoff.source_job_id
      where job.processor_version<>handoff.next_processor_version
        or handoff.canonical_handoff->>'productionPublicationAttempted'<>'false') then
    raise exception 'primary invalid scoped-worker handoff is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
