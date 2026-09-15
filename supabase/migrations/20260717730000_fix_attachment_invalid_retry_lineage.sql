-- Make invalid-argument retry lineage atomic with the RETRY_AUTHORIZED marker
-- transition.  Repair exhausted historical +3 cohorts, and grant the first
-- bounded retry to fresh default-attempt failures.  No evidence is minted and
-- operator review remains available after terminalization.

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_invalid_argument_retry_lineage') is null
    or to_regprocedure('private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(uuid)') is null
    or to_regprocedure('private.truth_gmail_attachment_worker_failure_v1(text,text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'invalid-argument retry-lineage repair prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_invalid_retry_lineage_repairs (
  repair_id text primary key check(
    repair_id='truth-gmail-attachment-invalid-retry-lineage-repair:v1:'||repair_hash
  ),
  repair_hash text not null unique check(repair_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  observed_attempt_count integer not null,
  observed_max_attempts integer not null check(
    observed_attempt_count=observed_max_attempts
    and observed_max_attempts>=8
    and mod(observed_max_attempts-5,3)=0
  ),
  reconstructed_prior_max_attempts integer not null check(
    reconstructed_prior_max_attempts=observed_max_attempts-3
  ),
  failure_detail_hash text not null check(failure_detail_hash~'^[0-9a-f]{64}$'),
  canonical_repair jsonb not null check(
    jsonb_typeof(canonical_repair)='object'
    and canonical_repair->>'reasonCode'=
      'AUTHORIZED_INVALID_ARGUMENT_MARKER_OVERWRITTEN_BEFORE_LINEAGE_CAPTURE'
    and canonical_repair->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(repair_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_repair),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_attachment_invalid_retry_lineage_repairs_immutable
  on public.truth_gmail_attachment_invalid_retry_lineage_repairs;
create trigger truth_gmail_attachment_invalid_retry_lineage_repairs_immutable
before update or delete on public.truth_gmail_attachment_invalid_retry_lineage_repairs
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_attachment_invalid_retry_lineage_repairs enable row level security;
alter table public.truth_gmail_attachment_invalid_retry_lineage_repairs force row level security;
revoke all on public.truth_gmail_attachment_invalid_retry_lineage_repairs
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_attachment_invalid_retry_lineage_repairs to service_role;

create or replace function private.capture_truth_gmail_attachment_invalid_retry_lineage_v2()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_body jsonb;
  v_hash text;
  v_marker constant text :=
    'The prior attempts ran under the adapter that sent the unsupported temperature parameter; the adapter is fixed and bounded retry is authorized.';
begin
  if new.workspace_key<>'primary' or new.source_system<>'gmail'
    or new.connection_key<>'primary'
    or new.job_kind<>'gmail_review_attachment_extraction'
    or new.state<>all(array['retry_wait','leased'])
    or new.last_error_code<>'ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED'
    or new.safe_error_detail<>v_marker
    or new.max_attempts<new.attempt_count+1 then
    return null;
  end if;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-v1',
    'workspaceKey',new.workspace_key,'connectionKey',new.connection_key,
    'sourceJobId',new.job_id,'authorizedAttemptCount',new.attempt_count,
    'authorizedMaxAttempts',new.max_attempts,
    'authorizationErrorDetailHash',encode(extensions.digest(
      convert_to(new.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'reasonCode','ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    'captureAuthority','retry_authorization_transition_v2',
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  insert into public.truth_gmail_attachment_invalid_argument_retry_lineage(
    lineage_id,lineage_hash,workspace_key,connection_key,source_job_id,
    authorized_attempt_count,authorized_max_attempts,
    authorization_error_detail_hash,canonical_lineage
  ) values(
    'truth-gmail-attachment-invalid-retry:v1:'||v_hash,v_hash,
    new.workspace_key,new.connection_key,new.job_id,new.attempt_count,
    new.max_attempts,v_body->>'authorizationErrorDetailHash',v_body
  ) on conflict(source_job_id) do nothing;
  if not exists(
    select 1 from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
    where lineage.workspace_key=new.workspace_key
      and lineage.source_job_id=new.job_id
      and lineage.authorized_attempt_count=new.attempt_count
      and lineage.authorized_max_attempts=new.max_attempts
      and lineage.canonical_lineage is not distinct from v_body
  ) then
    raise exception 'invalid-argument retry lineage conflicts on transition: %',new.job_id
      using errcode='23505';
  end if;
  return null;
end;
$function$;

revoke all on function private.capture_truth_gmail_attachment_invalid_retry_lineage_v2()
  from public,anon,authenticated,service_role;
drop trigger if exists truth_gmail_attachment_invalid_retry_lineage_on_marker
  on public.source_processing_jobs;
create trigger truth_gmail_attachment_invalid_retry_lineage_on_marker
after insert or update on public.source_processing_jobs
for each row when(
  new.workspace_key='primary' and new.source_system='gmail'
  and new.connection_key='primary'
  and new.job_kind='gmail_review_attachment_extraction'
  and new.state=any(array['retry_wait','leased'])
  and new.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED'
)
execute function private.capture_truth_gmail_attachment_invalid_retry_lineage_v2();

do $repair_and_restore$
declare
  v_job record;
  v_body jsonb;
  v_hash text;
  v_repair_id text;
  v_marker constant text :=
    'The prior attempts ran under the adapter that sent the unsupported temperature parameter; the adapter is fixed and bounded retry is authorized.';
begin
  -- Historical jobs that exhausted at 5+3n prove that bounded headroom was
  -- granted, but the marker was overwritten before lineage capture.
  for v_job in
    select job.*
    from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='dead_letter'
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and private.truth_gmail_attachment_worker_failure_v1(
        job.safe_error_detail,job.last_error_code)
      and job.attempt_count=job.max_attempts and job.max_attempts>=8
      and mod(job.max_attempts-5,3)=0
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
      and not exists(select 1
        from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
        where lineage.workspace_key=job.workspace_key
          and lineage.source_job_id=job.job_id)
      and not exists(select 1
        from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
        where authority.workspace_key=job.workspace_key
          and authority.source_job_id=job.job_id
          and authority.authorized_max_attempts=job.max_attempts)
    order by job.job_id
    for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-repair-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'observedAttemptCount',v_job.attempt_count,
      'observedMaxAttempts',v_job.max_attempts,
      'reconstructedPriorMaxAttempts',v_job.max_attempts-3,
      'failureDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'reasonCode','AUTHORIZED_INVALID_ARGUMENT_MARKER_OVERWRITTEN_BEFORE_LINEAGE_CAPTURE',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_repair_id:='truth-gmail-attachment-invalid-retry-lineage-repair:v1:'||v_hash;
    insert into public.truth_gmail_attachment_invalid_retry_lineage_repairs(
      repair_id,repair_hash,workspace_key,connection_key,source_job_id,
      observed_attempt_count,observed_max_attempts,
      reconstructed_prior_max_attempts,failure_detail_hash,canonical_repair
    ) values(v_repair_id,v_hash,v_job.workspace_key,v_job.connection_key,
      v_job.job_id,v_job.attempt_count,v_job.max_attempts,v_job.max_attempts-3,
      v_body->>'failureDetailHash',v_body)
    on conflict(source_job_id) do nothing;
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,
      'authorizedAttemptCount',v_job.max_attempts-3,
      'authorizedMaxAttempts',v_job.max_attempts,
      'authorizationErrorDetailHash',encode(extensions.digest(convert_to(
        v_marker,'UTF8'),'sha256'),'hex'),
      'reasonCode','ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
      'reconstructionId',v_repair_id,'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_attachment_invalid_argument_retry_lineage(
      lineage_id,lineage_hash,workspace_key,connection_key,source_job_id,
      authorized_attempt_count,authorized_max_attempts,
      authorization_error_detail_hash,canonical_lineage
    ) values('truth-gmail-attachment-invalid-retry:v1:'||v_hash,v_hash,
      v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.max_attempts-3,
      v_job.max_attempts,v_body->>'authorizationErrorDetailHash',v_body)
    on conflict(source_job_id) do nothing;
    perform private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(v_job.job_id);
  end loop;

  -- A default 5/5 failure has no proof of a post-fix retry. Grant exactly one
  -- +3 cohort; the transition trigger above records its lineage atomically.
  update public.source_processing_jobs job
  set state='retry_wait',max_attempts=job.attempt_count+3,
    available_at=clock_timestamp(),lease_owner=null,lease_expires_at=null,
    completed_at=null,
    last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    safe_error_detail=v_marker,updated_at=clock_timestamp()
  where job.workspace_key='primary' and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and private.truth_gmail_attachment_worker_failure_v1(
      job.safe_error_detail,job.last_error_code)
    and job.attempt_count=5 and job.max_attempts=5
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(select 1
      from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
      where lineage.workspace_key=job.workspace_key
        and lineage.source_job_id=job.job_id);
end;
$repair_and_restore$;

do $verify$
declare v_trigger text;
begin
  select pg_get_functiondef(
    'private.capture_truth_gmail_attachment_invalid_retry_lineage_v2()'::regprocedure
  ) into v_trigger;
  if position('new.last_error_code<>''ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED''' in v_trigger)=0
    or position('select * into' in lower(v_trigger))>0
    or exists(
      select 1 from public.source_processing_jobs job
      where job.workspace_key='primary' and job.source_system='gmail'
        and job.connection_key='primary'
        and job.job_kind='gmail_review_attachment_extraction'
        and job.state='dead_letter'
        and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
        and private.truth_gmail_attachment_worker_failure_v1(
          job.safe_error_detail,job.last_error_code)
        and job.attempt_count=job.max_attempts and job.max_attempts>=8
        and mod(job.max_attempts-5,3)=0
        and job.lease_owner is null and job.lease_expires_at is null
        and job.result='{}'::jsonb
        and not exists(select 1
          from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
          where authority.workspace_key=job.workspace_key
            and authority.source_job_id=job.job_id
            and authority.authorized_max_attempts=job.max_attempts)
    ) or exists(
      select 1 from public.source_processing_jobs job
      where job.workspace_key='primary' and job.source_system='gmail'
        and job.connection_key='primary'
        and job.job_kind='gmail_review_attachment_extraction'
        and job.state='dead_letter'
        and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
        and job.attempt_count=5 and job.max_attempts=5
        and private.truth_gmail_attachment_worker_failure_v1(
          job.safe_error_detail,job.last_error_code)
    ) then
    raise exception 'invalid-argument retry-lineage closure is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
