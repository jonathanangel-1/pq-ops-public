-- A retry authority proves that another bounded attempt was honest; it does
-- not predict the final error class. Close invalid-argument exhaustion after
-- either documented retry authority while preserving the authority that
-- actually granted the budget. The original invalid-lineage path remains
-- byte-for-byte authoritative; this migration adds the ledger-RPC crossover.
-- Human review remains unresolved. No production publication is attempted.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_ledger_rpc_retry_authorizations') is null
    or to_regclass('public.truth_gmail_attachment_invalid_argument_terminalizations') is null
    or to_regprocedure('private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(uuid)') is null
    or to_regprocedure('private.truth_gmail_attachment_worker_failure_v1(text,text)') is null then
    raise exception 'cross-authority attachment exhaustion prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_cross_authority_invalid_terminalizations (
  terminalization_id text primary key check(
    terminalization_id='truth-gmail-attachment-cross-authority-invalid-terminal:v1:'||terminalization_hash
  ),
  terminalization_hash text not null unique check(terminalization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  authorizing_authority_kind text not null check(
    authorizing_authority_kind='ledger_rpc_retry_authorization'
  ),
  authorizing_authority_id text not null unique,
  observed_failure_class text not null check(
    observed_failure_class='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
  ),
  prior_attempt_count integer not null,
  prior_max_attempts integer not null check(prior_attempt_count>=prior_max_attempts),
  failure_detail_hash text not null check(failure_detail_hash~'^[0-9a-f]{64}$'),
  canonical_terminalization jsonb not null check(
    canonical_terminalization->>'disposition'='authorized_retries_exhausted_as_invalid_argument'
    and canonical_terminalization->>'operatorReviewResolved'='false'
    and canonical_terminalization->>'productionPublicationAttempted'='false'
  ),
  canonical_result jsonb not null check(jsonb_typeof(canonical_result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,authorizing_authority_id)
    references public.truth_gmail_attachment_ledger_rpc_retry_authorizations(
      workspace_key,authorization_id
    ) on update restrict on delete restrict,
  check(terminalization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_terminalization),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_attachment_cross_authority_invalid_terminalizations_immutable
  on public.truth_gmail_attachment_cross_authority_invalid_terminalizations;
create trigger truth_gmail_attachment_cross_authority_invalid_terminalizations_immutable
before update or delete on public.truth_gmail_attachment_cross_authority_invalid_terminalizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_attachment_cross_authority_invalid_terminalizations
  enable row level security;
alter table public.truth_gmail_attachment_cross_authority_invalid_terminalizations
  force row level security;
revoke all on table public.truth_gmail_attachment_cross_authority_invalid_terminalizations
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_attachment_cross_authority_invalid_terminalizations
  to service_role;

create or replace function private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(
  p_job_id uuid
) returns boolean language plpgsql security definer set search_path='' as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_authority public.truth_gmail_attachment_ledger_rpc_retry_authorizations%rowtype;
  v_body jsonb; v_hash text; v_id text; v_result jsonb; v_updated integer;
begin
  select * into v_job from public.source_processing_jobs job
  where job.workspace_key='primary' and job.job_id=p_job_id
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and private.truth_gmail_attachment_worker_failure_v1(
      job.safe_error_detail,job.last_error_code)
    and job.attempt_count>=job.max_attempts
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
  for update;
  if not found then return false; end if;

  -- The native invalid lineage remains first authority. Never duplicate it.
  if exists(select 1 from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
    where lineage.workspace_key=v_job.workspace_key
      and lineage.source_job_id=v_job.job_id
      and lineage.authorized_max_attempts=v_job.max_attempts) then
    return private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(v_job.job_id);
  end if;

  select * into v_authority
  from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
  where authority.workspace_key=v_job.workspace_key
    and authority.source_job_id=v_job.job_id
    and authority.authorized_max_attempts=v_job.max_attempts;
  if not found then return false; end if;
  if exists(select 1
    from public.truth_gmail_attachment_cross_authority_invalid_terminalizations prior
    where prior.source_job_id=v_job.job_id) then return true; end if;

  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-cross-authority-invalid-terminalization-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
    'authorizingAuthorityKind','ledger_rpc_retry_authorization',
    'authorizingAuthorityId',v_authority.authorization_id,
    'authorizedMaxAttempts',v_authority.authorized_max_attempts,
    'observedFailureClass','OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT',
    'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
    'failureDetailHash',encode(extensions.digest(convert_to(
      v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'disposition','authorized_retries_exhausted_as_invalid_argument',
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  v_id:='truth-gmail-attachment-cross-authority-invalid-terminal:v1:'||v_hash;
  v_result:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-cross-authority-invalid-result-v1',
    'terminalizationId',v_id,'terminalizationHash',v_hash,
    'authorizingAuthorityKind','ledger_rpc_retry_authorization',
    'authorizingAuthorityId',v_authority.authorization_id,
    'observedFailureClass','OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT',
    'disposition','authorized_retries_exhausted_as_invalid_argument',
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  insert into public.truth_gmail_attachment_cross_authority_invalid_terminalizations(
    terminalization_id,terminalization_hash,workspace_key,connection_key,
    source_job_id,authorizing_authority_kind,authorizing_authority_id,
    observed_failure_class,prior_attempt_count,prior_max_attempts,
    failure_detail_hash,canonical_terminalization,canonical_result
  ) values(v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
    'ledger_rpc_retry_authorization',v_authority.authorization_id,
    'OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT',v_job.attempt_count,
    v_job.max_attempts,v_body->>'failureDetailHash',v_body,v_result);
  update public.source_processing_jobs job set state='succeeded',
    last_error_code='',safe_error_detail='',
    processor_version='truth-gmail-attachment-cross-authority-invalid-terminal-v1',
    result=v_result,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state=v_job.state and job.attempt_count=v_job.attempt_count
    and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
    and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail
    and job.lease_owner is null and job.lease_expires_at is null;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'cross-authority terminalization fence changed'
    using errcode='40001'; end if;
  return true;
end;
$function$;
revoke all on function private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(uuid)
  from public,anon,authenticated,service_role;

-- Preserve later explicit human resolution after producer terminalization.
do $extend_resolver$
declare
  v_signature regprocedure:=
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_anchor text:=$old$          select 1 from public.truth_gmail_attachment_ledger_rpc_terminalizations ledger_terminal
          where ledger_terminal.workspace_key=job.workspace_key
            and ledger_terminal.source_job_id=job.job_id
            and ledger_terminal.canonical_terminalization->>'operatorReviewResolved'='false'$old$;
  v_replacement text:=v_anchor||$new$
        ) or exists (
          select 1 from public.truth_gmail_attachment_cross_authority_invalid_terminalizations cross_terminal
          where cross_terminal.workspace_key=job.workspace_key
            and cross_terminal.source_job_id=job.job_id
            and cross_terminal.canonical_terminalization->>'operatorReviewResolved'='false'
        $new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_attachment_cross_authority_invalid_terminalizations cross_terminal'
      in v_definition)=0 then
    if position(v_anchor in v_definition)=0 then
      raise exception 'attachment resolver cross-authority extension anchor drifted'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_anchor,v_replacement);
    execute v_definition;
  end if;
end;
$extend_resolver$;

create or replace function private.route_truth_gmail_attachment_documented_dead_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED' then
    perform private.record_truth_gmail_attachment_invalid_retry_lineage_v1(new.job_id);
  elsif new.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN' then
    perform private.adopt_truth_gmail_attachment_outcome_unknown_v1(new.job_id);
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  elsif new.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT' then
    if not private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(new.job_id) then
      perform private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(new.job_id);
    end if;
  elsif new.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED' then
    perform private.terminalize_truth_gmail_attachment_ledger_rpc_exhaustion_v1(new.job_id);
  else
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  end if;
  return null;
end;
$function$;

do $backfill$
declare v_job record;
begin
  for v_job in select job.job_id from public.source_processing_jobs job
    join public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
      on authority.workspace_key=job.workspace_key
     and authority.source_job_id=job.job_id
     and authority.authorized_max_attempts=job.max_attempts
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='dead_letter'
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and private.truth_gmail_attachment_worker_failure_v1(
        job.safe_error_detail,job.last_error_code)
      and job.attempt_count>=job.max_attempts
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
    order by job.job_id
  loop
    perform private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(v_job.job_id);
  end loop;
end;
$backfill$;

do $verify$
begin
  if exists(select 1 from public.source_processing_jobs job
    join public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
      on authority.workspace_key=job.workspace_key
     and authority.source_job_id=job.job_id
     and authority.authorized_max_attempts=job.max_attempts
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='dead_letter'
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and private.truth_gmail_attachment_worker_failure_v1(
        job.safe_error_detail,job.last_error_code)
      and job.attempt_count>=job.max_attempts) then
    raise exception 'cross-authority attachment invalid exhaustion remained'
      using errcode='23514';
  end if;
end;
$verify$;
