-- Close the two residual live attachment-model producer classes without
-- weakening frontier completeness:
--   * reconstruct the 470000 retry lineage for the single, independently
--     identified job whose marker was overwritten before 480000 observed it;
--   * grant bounded retry authority to transient ledger-RPC failures and only
--     terminalize a later exhaustion when that authority is immutably proven.
-- Human attachment review remains open after either terminalization. This
-- authority never publishes and never writes shipment-truth-packets.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_invalid_argument_retry_lineage') is null
    or to_regclass('public.truth_gmail_attachment_invalid_argument_terminalizations') is null
    or to_regprocedure('private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(uuid)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'attachment-model retry-lineage residual prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_invalid_retry_reconstructions (
  reconstruction_id text primary key check(
    reconstruction_id='truth-gmail-attachment-invalid-retry-reconstruction:v1:'||reconstruction_hash
  ),
  reconstruction_hash text not null unique check(reconstruction_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  observed_attempt_count integer not null check(observed_attempt_count=8),
  observed_max_attempts integer not null check(observed_max_attempts=8),
  reconstructed_prior_max_attempts integer not null check(reconstructed_prior_max_attempts=5),
  failure_detail_hash text not null check(failure_detail_hash~'^[0-9a-f]{64}$'),
  canonical_reconstruction jsonb not null check(
    canonical_reconstruction->>'reasonCode'='470000_RETRY_MARKER_OVERWRITTEN_BEFORE_480000_LINEAGE_CAPTURE'
    and canonical_reconstruction->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(reconstruction_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_reconstruction),'UTF8'
  ),'sha256'),'hex'))
);

create table if not exists public.truth_gmail_attachment_ledger_rpc_retry_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-gmail-attachment-ledger-rpc-retry:v1:'||authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  prior_attempt_count integer not null check(prior_attempt_count>=prior_max_attempts),
  prior_max_attempts integer not null check(prior_max_attempts>0),
  authorized_max_attempts integer not null check(authorized_max_attempts=prior_attempt_count+3),
  failure_detail_hash text not null check(failure_detail_hash~'^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null check(
    canonical_authorization->>'reasonCode'='ATTACHMENT_MODEL_LEDGER_RPC_TRANSIENT_RETRY_AUTHORIZED'
    and canonical_authorization->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,authorization_id),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex'))
);

create table if not exists public.truth_gmail_attachment_ledger_rpc_terminalizations (
  terminalization_id text primary key check(
    terminalization_id='truth-gmail-attachment-ledger-rpc-terminal:v1:'||terminalization_hash
  ),
  terminalization_hash text not null unique check(terminalization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  authorization_id text not null unique,
  prior_attempt_count integer not null,
  prior_max_attempts integer not null check(prior_attempt_count>=prior_max_attempts),
  failure_detail_hash text not null check(failure_detail_hash~'^[0-9a-f]{64}$'),
  canonical_terminalization jsonb not null check(
    canonical_terminalization->>'disposition'='authorized_ledger_rpc_retries_exhausted'
    and canonical_terminalization->>'operatorReviewResolved'='false'
    and canonical_terminalization->>'productionPublicationAttempted'='false'
  ),
  canonical_result jsonb not null check(jsonb_typeof(canonical_result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,authorization_id)
    references public.truth_gmail_attachment_ledger_rpc_retry_authorizations(
      workspace_key,authorization_id
    ) on update restrict on delete restrict,
  check(terminalization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_terminalization),'UTF8'
  ),'sha256'),'hex'))
);

do $secure$
declare v_table text;
begin
  foreach v_table in array array[
    'truth_gmail_attachment_invalid_retry_reconstructions',
    'truth_gmail_attachment_ledger_rpc_retry_authorizations',
    'truth_gmail_attachment_ledger_rpc_terminalizations'
  ] loop
    execute format('drop trigger if exists %I on public.%I',v_table||'_immutable',v_table);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',v_table||'_immutable',v_table);
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on table public.%I to service_role',v_table);
  end loop;
end;
$secure$;

create or replace function private.truth_gmail_attachment_worker_failure_v1(
  p_detail text,p_error_code text
) returns boolean language plpgsql immutable set search_path='' as $function$
begin
  if p_detail is null then return false; end if;
  return p_detail::jsonb=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-model-worker-failure-v1',
      'errorCode',p_error_code,
      'productionPublicationAttempted',false
    );
exception when others then return false;
end;
$function$;

create or replace function private.terminalize_truth_gmail_attachment_ledger_rpc_exhaustion_v1(
  p_job_id uuid
) returns boolean language plpgsql security definer set search_path='' as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_auth public.truth_gmail_attachment_ledger_rpc_retry_authorizations%rowtype;
  v_body jsonb; v_hash text; v_id text; v_result jsonb; v_updated integer;
begin
  select * into v_job from public.source_processing_jobs job
  where job.workspace_key='primary' and job.job_id=p_job_id
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED'
    and private.truth_gmail_attachment_worker_failure_v1(
      job.safe_error_detail,job.last_error_code)
    and job.attempt_count>=job.max_attempts
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
  for update;
  if not found then return false; end if;
  select * into v_auth
  from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
  where authority.workspace_key=v_job.workspace_key
    and authority.source_job_id=v_job.job_id
    and authority.authorized_max_attempts=v_job.max_attempts;
  if not found then return false; end if;
  if exists(select 1 from public.truth_gmail_attachment_ledger_rpc_terminalizations prior
    where prior.source_job_id=v_job.job_id) then return true; end if;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-ledger-rpc-terminalization-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
    'authorizationId',v_auth.authorization_id,
    'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
    'failureDetailHash',encode(extensions.digest(convert_to(
      v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'disposition','authorized_ledger_rpc_retries_exhausted',
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  v_id:='truth-gmail-attachment-ledger-rpc-terminal:v1:'||v_hash;
  v_result:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-ledger-rpc-terminal-result-v1',
    'terminalizationId',v_id,'terminalizationHash',v_hash,
    'authorizationId',v_auth.authorization_id,
    'disposition','authorized_ledger_rpc_retries_exhausted',
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  insert into public.truth_gmail_attachment_ledger_rpc_terminalizations(
    terminalization_id,terminalization_hash,workspace_key,connection_key,
    source_job_id,authorization_id,prior_attempt_count,prior_max_attempts,
    failure_detail_hash,canonical_terminalization,canonical_result
  ) values(v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
    v_auth.authorization_id,v_job.attempt_count,v_job.max_attempts,
    v_body->>'failureDetailHash',v_body,v_result);
  update public.source_processing_jobs job set state='succeeded',
    last_error_code='',safe_error_detail='',
    processor_version='truth-gmail-attachment-ledger-rpc-exhaustion-terminal-v1',
    result=v_result,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state=v_job.state and job.attempt_count=v_job.attempt_count
    and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
    and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail
    and job.lease_owner is null and job.lease_expires_at is null;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'ledger-RPC terminalization fence changed'
    using errcode='40001'; end if;
  return true;
end;
$function$;

revoke all on function private.truth_gmail_attachment_worker_failure_v1(text,text)
  from public,anon,authenticated,service_role;
revoke all on function private.terminalize_truth_gmail_attachment_ledger_rpc_exhaustion_v1(uuid)
  from public,anon,authenticated,service_role;

-- Preserve the operator's later explicit attachment-resolution path.
do $extend_resolver$
declare
  v_signature regprocedure:=
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_anchor text:=$old$          select 1 from public.truth_gmail_attachment_invalid_argument_terminalizations invalid_terminal
            where invalid_terminal.workspace_key=job.workspace_key
              and invalid_terminal.source_job_id=job.job_id
              and invalid_terminal.canonical_terminalization->>'operatorReviewResolved'='false'$old$;
  v_replacement text:=v_anchor||$new$
        ) or exists (
          select 1 from public.truth_gmail_attachment_ledger_rpc_terminalizations ledger_terminal
          where ledger_terminal.workspace_key=job.workspace_key
            and ledger_terminal.source_job_id=job.job_id
            and ledger_terminal.canonical_terminalization->>'operatorReviewResolved'='false'
        $new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_attachment_ledger_rpc_terminalizations ledger_terminal' in v_definition)=0 then
    if position(v_anchor in v_definition)=0 then
      raise exception 'attachment resolver ledger-RPC extension anchor drifted'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_anchor,v_replacement);
    execute v_definition;
  end if;
end;
$extend_resolver$;

-- Extend the existing automatic router without changing prior classes.
create or replace function private.route_truth_gmail_attachment_documented_dead_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED' then
    perform private.record_truth_gmail_attachment_invalid_retry_lineage_v1(new.job_id);
  elsif new.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN' then
    perform private.adopt_truth_gmail_attachment_outcome_unknown_v1(new.job_id);
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  elsif new.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT' then
    perform private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(new.job_id);
  elsif new.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED' then
    perform private.terminalize_truth_gmail_attachment_ledger_rpc_exhaustion_v1(new.job_id);
  else
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  end if;
  return null;
end;
$function$;

drop trigger if exists truth_gmail_attachment_model_review_auto_terminal
  on public.source_processing_jobs;
create trigger truth_gmail_attachment_model_review_auto_terminal
after insert or update on public.source_processing_jobs
for each row when(
  new.workspace_key='primary' and new.source_system='gmail'
  and new.connection_key='primary'
  and new.job_kind='gmail_review_attachment_extraction'
  and new.state=any(array['queued','retry_wait','leased','dead_letter'])
  and new.last_error_code=any(array[
    'ATTACHMENT_MODEL_REVIEW_REQUIRED','ATTACHMENT_MODEL_OUTCOME_UNKNOWN',
    'ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    'OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT',
    'TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED'
  ])
) execute function private.route_truth_gmail_attachment_documented_dead_v1();

do $repair$
declare
  v_job public.source_processing_jobs%rowtype;
  v_body jsonb; v_hash text; v_marker text:=
    'The prior attempts ran under the adapter that sent the unsupported temperature parameter; the adapter is fixed and bounded retry is authorized.';
  v_count integer;
begin
  -- Exact one-shot reconstruction: the short id is operator-confirmed and must
  -- resolve to at most one row. No generic max-attempt arithmetic is trusted.
  select count(*) into v_count from public.source_processing_jobs job
  where job.job_id::text like '1666d50d-%';
  if v_count>1 then raise exception 'invalid retry reconstruction job prefix is ambiguous'
    using errcode='23514'; end if;
  select * into v_job from public.source_processing_jobs job
  where job.job_id::text like '1666d50d-%'
    and job.workspace_key='primary' and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and private.truth_gmail_attachment_worker_failure_v1(job.safe_error_detail,job.last_error_code)
    and job.attempt_count=8 and job.max_attempts=8
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(select 1 from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
      where lineage.source_job_id=job.job_id)
  for update;
  if found then
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-invalid-retry-reconstruction-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'observedAttemptCount',8,'observedMaxAttempts',8,
      'reconstructedPriorMaxAttempts',5,
      'failureDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'reasonCode','470000_RETRY_MARKER_OVERWRITTEN_BEFORE_480000_LINEAGE_CAPTURE',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_attachment_invalid_retry_reconstructions(
      reconstruction_id,reconstruction_hash,workspace_key,connection_key,
      source_job_id,observed_attempt_count,observed_max_attempts,
      reconstructed_prior_max_attempts,failure_detail_hash,canonical_reconstruction
    ) values('truth-gmail-attachment-invalid-retry-reconstruction:v1:'||v_hash,
      v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,8,8,5,
      v_body->>'failureDetailHash',v_body) on conflict(source_job_id) do nothing;
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'authorizedAttemptCount',5,
      'authorizedMaxAttempts',8,
      'authorizationErrorDetailHash',encode(extensions.digest(convert_to(
        v_marker,'UTF8'),'sha256'),'hex'),
      'reasonCode','ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
      'reconstructionId','truth-gmail-attachment-invalid-retry-reconstruction:v1:'||v_hash,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_attachment_invalid_argument_retry_lineage(
      lineage_id,lineage_hash,workspace_key,connection_key,source_job_id,
      authorized_attempt_count,authorized_max_attempts,
      authorization_error_detail_hash,canonical_lineage
    ) values('truth-gmail-attachment-invalid-retry:v1:'||v_hash,v_hash,
      v_job.workspace_key,v_job.connection_key,v_job.job_id,5,8,
      v_body->>'authorizationErrorDetailHash',v_body) on conflict(source_job_id) do nothing;
    perform private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(v_job.job_id);
  end if;

  -- Every current exact-class ledger failure receives its own bounded receipt.
  for v_job in select job.* from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED'
      and private.truth_gmail_attachment_worker_failure_v1(job.safe_error_detail,job.last_error_code)
      and job.attempt_count>=job.max_attempts
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
      and not exists(select 1 from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
        where authority.source_job_id=job.job_id)
    order by job.job_id for update
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-ledger-rpc-retry-authorization-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_job.attempt_count+3,
      'failureDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'reasonCode','ATTACHMENT_MODEL_LEDGER_RPC_TRANSIENT_RETRY_AUTHORIZED',
      'operatorIncidentClass','EDGE_PROXY_OR_COMPLETION_RPC_TRANSIENT',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_attachment_ledger_rpc_retry_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,prior_attempt_count,prior_max_attempts,
      authorized_max_attempts,failure_detail_hash,canonical_authorization
    ) values('truth-gmail-attachment-ledger-rpc-retry:v1:'||v_hash,v_hash,
      v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.attempt_count,
      v_job.max_attempts,v_job.attempt_count+3,v_body->>'failureDetailHash',v_body);
    update public.source_processing_jobs job set state='retry_wait',
      max_attempts=v_job.attempt_count+3,available_at=clock_timestamp(),
      lease_owner=null,lease_expires_at=null,completed_at=null,
      last_error_code='ATTACHMENT_MODEL_LEDGER_RPC_RETRY_AUTHORIZED',
      safe_error_detail='A transient attachment-model ledger/completion RPC failure consumed the prior budget; three bounded retries are authorized.',
      updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state=v_job.state and job.attempt_count=v_job.attempt_count
      and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.lease_owner is null and job.lease_expires_at is null;
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'ledger-RPC retry authorization fence changed'
      using errcode='40001'; end if;
  end loop;
end;
$repair$;

do $verify$
begin
  if exists(select 1 from public.source_processing_jobs job
    where job.job_id::text like '1666d50d-%'
      and job.workspace_key='primary' and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='dead_letter'
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and job.attempt_count=8 and job.max_attempts=8)
    or exists(select 1 from public.source_processing_jobs job
      where job.workspace_key='primary' and job.connection_key='primary'
        and job.job_kind='gmail_review_attachment_extraction'
        and job.state='dead_letter'
        and job.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED'
        and private.truth_gmail_attachment_worker_failure_v1(
          job.safe_error_detail,job.last_error_code)
        and not exists(select 1 from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
          where authority.source_job_id=job.job_id)) then
    raise exception 'attachment-model retry-lineage residual remained after closure'
      using errcode='23514';
  end if;
end;
$verify$;
