-- Extend automatic attachment-review producer closure to two proof-carrying
-- terminal classes:
--   1. provider outcome unknown, including an in_flight request with no durable
--      outcome (the original acknowledgement remains hash-bound), and
--   2. invalid argument only after 470000-authorized retry headroom is recorded
--      and subsequently exhausted.
-- Undocumented failures remain nonterminal by design.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_model_job_terminalizations') is null
    or to_regclass('public.gmail_attachment_model_requests') is null
    or to_regprocedure('private.terminalize_truth_gmail_attachment_model_review_job_v2(uuid)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure(
      'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'
    ) is null then
    raise exception 'documented attachment-model dead-letter prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_outcome_unknown_adoptions (
  adoption_id text primary key check (
    adoption_id='truth-gmail-attachment-outcome-unknown:v1:'||adoption_hash
  ),
  adoption_hash text not null unique check (adoption_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  request_id text not null unique,
  acknowledgement_hash text not null check(acknowledgement_hash~'^[0-9a-f]{64}$'),
  canonical_adoption jsonb not null check(
    jsonb_typeof(canonical_adoption)='object'
    and canonical_adoption->>'disposition'='provider_outcome_unknown'
    and canonical_adoption->>'operatorReviewResolved'='false'
    and canonical_adoption->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,request_id)
    references public.gmail_attachment_model_requests(workspace_key,request_id)
    on update restrict on delete restrict,
  check(adoption_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_adoption),'UTF8'
  ),'sha256'),'hex'))
);

create table if not exists public.truth_gmail_attachment_invalid_argument_retry_lineage (
  lineage_id text primary key check (
    lineage_id='truth-gmail-attachment-invalid-retry:v1:'||lineage_hash
  ),
  lineage_hash text not null unique check(lineage_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  authorized_attempt_count integer not null check(authorized_attempt_count>=0),
  authorized_max_attempts integer not null check(
    authorized_max_attempts>=authorized_attempt_count+1
  ),
  authorization_error_detail_hash text not null check(
    authorization_error_detail_hash~'^[0-9a-f]{64}$'
  ),
  canonical_lineage jsonb not null check(
    jsonb_typeof(canonical_lineage)='object'
    and canonical_lineage->>'reasonCode'='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED'
    and canonical_lineage->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,lineage_id),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(lineage_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_lineage),'UTF8'
  ),'sha256'),'hex'))
);

create table if not exists public.truth_gmail_attachment_invalid_argument_terminalizations (
  terminalization_id text primary key check (
    terminalization_id='truth-gmail-attachment-invalid-terminal:v1:'||terminalization_hash
  ),
  terminalization_hash text not null unique check(terminalization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  retry_lineage_id text not null unique,
  prior_attempt_count integer not null,
  prior_max_attempts integer not null check(prior_attempt_count>=prior_max_attempts),
  failure_detail_hash text not null check(failure_detail_hash~'^[0-9a-f]{64}$'),
  canonical_terminalization jsonb not null check(
    jsonb_typeof(canonical_terminalization)='object'
    and canonical_terminalization->>'disposition'='authorized_invalid_argument_retries_exhausted'
    and canonical_terminalization->>'operatorReviewResolved'='false'
    and canonical_terminalization->>'productionPublicationAttempted'='false'
  ),
  canonical_result jsonb not null check(jsonb_typeof(canonical_result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,retry_lineage_id)
    references public.truth_gmail_attachment_invalid_argument_retry_lineage(
      workspace_key,lineage_id
    )
    on update restrict on delete restrict,
  check(terminalization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_terminalization),'UTF8'
  ),'sha256'),'hex'))
);

do $secure_tables$
declare v_table text;
begin
  foreach v_table in array array[
    'truth_gmail_attachment_outcome_unknown_adoptions',
    'truth_gmail_attachment_invalid_argument_retry_lineage',
    'truth_gmail_attachment_invalid_argument_terminalizations'
  ] loop
    execute format('drop trigger if exists %I on public.%I',v_table||'_immutable',v_table);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',v_table||'_immutable',v_table);
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on table public.%I to service_role',v_table);
  end loop;
end;
$secure_tables$;

create or replace function private.record_truth_gmail_attachment_invalid_retry_lineage_v1(
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare v_job public.source_processing_jobs%rowtype; v_body jsonb; v_hash text;
begin
  select * into v_job from public.source_processing_jobs job
  where job.workspace_key='primary' and job.job_id=p_job_id
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state=any(array['retry_wait','leased'])
    and job.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED'
    and job.safe_error_detail=
      'The prior attempts ran under the adapter that sent the unsupported temperature parameter; the adapter is fixed and bounded retry is authorized.'
    and not exists(select 1 from public.truth_gmail_attachment_invalid_argument_retry_lineage prior
      where prior.source_job_id=job.job_id)
  for update;
  if not found then return false; end if;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'authorizedAttemptCount',v_job.attempt_count,
    'authorizedMaxAttempts',v_job.max_attempts,
    'authorizationErrorDetailHash',encode(extensions.digest(
      convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'reasonCode','ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
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
    v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.attempt_count,
    v_job.max_attempts,v_body->>'authorizationErrorDetailHash',v_body
  );
  return true;
end;
$function$;

create or replace function private.adopt_truth_gmail_attachment_outcome_unknown_v1(
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_request public.gmail_attachment_model_requests%rowtype;
  v_ack jsonb; v_body jsonb; v_hash text;
begin
  select * into v_job from public.source_processing_jobs job
  where job.workspace_key='primary' and job.job_id=p_job_id
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state=any(array['queued','retry_wait','dead_letter'])
    and job.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
  for update;
  if not found then return false; end if;
  begin v_ack:=v_job.safe_error_detail::jsonb;
  exception when others then return false; end;
  if v_ack->>'schemaVersion'<>'truth-gmail-attachment-model-acknowledgement-v1'
    or v_ack->>'requestState'<>'in_flight'
    or v_ack->>'reasonCode'<>'ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
    or v_ack->>'productionPublicationAttempted'<>'false' then return false; end if;
  select * into v_request from public.gmail_attachment_model_requests request
  where request.workspace_key=v_job.workspace_key
    and request.source_job_id=v_job.job_id
    and request.request_id=v_ack->>'requestId'
    and request.connection_key=v_job.connection_key
    and request.state='in_flight'
  for update;
  if not found or exists(
    select 1 from public.gmail_attachment_model_attempt_outcomes outcome
    where outcome.workspace_key=v_request.workspace_key
      and outcome.request_id=v_request.request_id
  ) then return false; end if;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-outcome-unknown-adoption-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'requestId',v_request.request_id,
    'acknowledgementHash',encode(extensions.digest(
      convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'priorRequestState','in_flight','adoptedRequestState','outcome_unknown',
    'disposition','provider_outcome_unknown','operatorReviewResolved',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  insert into public.truth_gmail_attachment_outcome_unknown_adoptions(
    adoption_id,adoption_hash,workspace_key,connection_key,source_job_id,
    request_id,acknowledgement_hash,canonical_adoption
  ) values(
    'truth-gmail-attachment-outcome-unknown:v1:'||v_hash,v_hash,
    v_job.workspace_key,v_job.connection_key,v_job.job_id,v_request.request_id,
    v_body->>'acknowledgementHash',v_body
  ) on conflict(source_job_id) do nothing;
  update public.gmail_attachment_model_requests request
  set state='outcome_unknown',review_reason='DISPATCH_REPLAY_OUTCOME_UNKNOWN',
    provider_finalized_at=coalesce(request.provider_finalized_at,clock_timestamp()),
    updated_at=clock_timestamp()
  where request.workspace_key=v_request.workspace_key
    and request.request_id=v_request.request_id and request.state='in_flight';
  update public.source_processing_jobs job
  set safe_error_detail=jsonb_set(v_ack,'{requestState}','"outcome_unknown"'::jsonb)::text,
    updated_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state=v_job.state and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail;
  return true;
end;
$function$;

create or replace function private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.truth_gmail_attachment_invalid_argument_retry_lineage%rowtype;
  v_body jsonb; v_hash text; v_id text; v_result jsonb; v_updated integer;
begin
  select job.* into v_job from public.source_processing_jobs job
  where job.workspace_key='primary' and job.job_id=p_job_id
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and job.attempt_count>=job.max_attempts
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(select 1 from public.truth_gmail_attachment_invalid_argument_terminalizations prior
      where prior.source_job_id=job.job_id)
  for update;
  if not found then return false; end if;
  select * into v_lineage
  from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
  where lineage.workspace_key=v_job.workspace_key
    and lineage.source_job_id=v_job.job_id
    and lineage.authorized_max_attempts=v_job.max_attempts;
  if not found or v_job.attempt_count<v_lineage.authorized_max_attempts then return false; end if;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-invalid-terminalization-v1',
    'authorityVersion','truth-gmail-attachment-documented-dead-auto-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
    'retryLineageId',v_lineage.lineage_id,
    'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
    'failureDetailHash',encode(extensions.digest(
      convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'disposition','authorized_invalid_argument_retries_exhausted',
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  v_id:='truth-gmail-attachment-invalid-terminal:v1:'||v_hash;
  v_result:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-invalid-terminal-result-v1',
    'terminalizationId',v_id,'terminalizationHash',v_hash,
    'retryLineageId',v_lineage.lineage_id,
    'disposition','authorized_invalid_argument_retries_exhausted',
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  insert into public.truth_gmail_attachment_invalid_argument_terminalizations(
    terminalization_id,terminalization_hash,workspace_key,connection_key,
    source_job_id,retry_lineage_id,prior_attempt_count,prior_max_attempts,
    failure_detail_hash,canonical_terminalization,canonical_result
  ) values(v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
    v_lineage.lineage_id,v_job.attempt_count,v_job.max_attempts,
    v_body->>'failureDetailHash',v_body,v_result);
  update public.source_processing_jobs job
  set state='succeeded',last_error_code='',safe_error_detail='',
    processor_version='truth-gmail-attachment-invalid-exhaustion-terminal-v1',
    result=v_result,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state='dead_letter' and job.attempt_count=v_job.attempt_count
    and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
    and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail
    and job.lease_owner is null and job.lease_expires_at is null;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'invalid-argument terminalization fence changed'
    using errcode='40001'; end if;
  return true;
end;
$function$;

revoke all on function private.record_truth_gmail_attachment_invalid_retry_lineage_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function private.adopt_truth_gmail_attachment_outcome_unknown_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(uuid)
  from public,anon,authenticated,service_role;

-- Preserve explicit human resolution after invalid-argument producer closure.
do $extend_explicit_review_resolver$
declare
  v_signature regprocedure:=
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_old_a text:=$old$        or (
          job.state = 'succeeded'
          and exists (
            select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations unsupported
            where unsupported.workspace_key=job.workspace_key
              and unsupported.source_job_id=job.job_id
              and unsupported.canonical_terminalization->>'operatorReviewResolved'='false'
              and not exists (
                select 1 from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key=job.workspace_key
                  and resolution.review_job_id=job.job_id
              )
          )
        )$old$;
  v_new_a text:=v_old_a||$new$
        or (
          job.state = 'succeeded'
          and exists (
            select 1 from public.truth_gmail_attachment_invalid_argument_terminalizations invalid_terminal
            where invalid_terminal.workspace_key=job.workspace_key
              and invalid_terminal.source_job_id=job.job_id
              and invalid_terminal.canonical_terminalization->>'operatorReviewResolved'='false'
              and not exists (
                select 1 from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key=job.workspace_key
                  and resolution.review_job_id=job.job_id
              )
          )
        )$new$;
  v_old_b text:=$old$      or (
        job.state = 'succeeded'
        and exists (
          select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations unsupported
          where unsupported.workspace_key=job.workspace_key
            and unsupported.source_job_id=job.job_id
            and unsupported.canonical_terminalization->>'operatorReviewResolved'='false'
            and not exists (
              select 1 from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key=job.workspace_key
                and resolution.review_job_id=job.job_id
            )
        )
      )$old$;
  v_new_b text:=v_old_b||$new$
      or (
        job.state = 'succeeded'
        and exists (
          select 1 from public.truth_gmail_attachment_invalid_argument_terminalizations invalid_terminal
          where invalid_terminal.workspace_key=job.workspace_key
            and invalid_terminal.source_job_id=job.job_id
            and invalid_terminal.canonical_terminalization->>'operatorReviewResolved'='false'
            and not exists (
              select 1 from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key=job.workspace_key
                and resolution.review_job_id=job.job_id
            )
        )
      )$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_attachment_invalid_argument_terminalizations invalid_terminal' in
      v_definition)=0 then
    if position(v_old_a in v_definition)=0 or position(v_old_b in v_definition)=0 then
      raise exception 'attachment resolver invalid-argument extension anchor drifted'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old_a,v_new_a);
    v_definition:=replace(v_definition,v_old_b,v_new_b);
    execute v_definition;
  end if;
end;
$extend_explicit_review_resolver$;

create or replace function private.route_truth_gmail_attachment_documented_dead_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED' then
    perform private.record_truth_gmail_attachment_invalid_retry_lineage_v1(new.job_id);
  elsif new.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN' then
    perform private.adopt_truth_gmail_attachment_outcome_unknown_v1(new.job_id);
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  elsif new.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT' then
    perform private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(new.job_id);
  else
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  end if;
  return null;
end;
$function$;
revoke all on function private.route_truth_gmail_attachment_documented_dead_v1()
  from public,anon,authenticated,service_role;

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
    'OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
  ])
)
execute function private.route_truth_gmail_attachment_documented_dead_v1();

do $backfill$
declare v_job record;
begin
  for v_job in select job.job_id,job.last_error_code
    from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state=any(array['queued','retry_wait','leased','dead_letter'])
      and job.last_error_code=any(array[
        'ATTACHMENT_MODEL_REVIEW_REQUIRED','ATTACHMENT_MODEL_OUTCOME_UNKNOWN',
        'ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
        'OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      ])
    order by case when job.last_error_code=
      'ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED' then 0 else 1 end,
      job.job_id
  loop
    if v_job.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED' then
      perform private.record_truth_gmail_attachment_invalid_retry_lineage_v1(v_job.job_id);
    elsif v_job.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN' then
      perform private.adopt_truth_gmail_attachment_outcome_unknown_v1(v_job.job_id);
      perform private.terminalize_truth_gmail_attachment_model_review_job_v2(v_job.job_id);
    elsif v_job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT' then
      perform private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(v_job.job_id);
    else
      perform private.terminalize_truth_gmail_attachment_model_review_job_v2(v_job.job_id);
    end if;
  end loop;
end;
$backfill$;

do $verify$
begin
  if exists(
    select 1 from public.source_processing_jobs job
    join public.gmail_attachment_model_requests request
      on request.workspace_key=job.workspace_key and request.source_job_id=job.job_id
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='dead_letter'
      and job.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
      and request.state=any(array['in_flight','outcome_unknown'])
      and not exists(select 1 from public.gmail_attachment_model_attempt_outcomes outcome
        where outcome.workspace_key=request.workspace_key
          and outcome.request_id=request.request_id)
  ) or exists(
    select 1 from public.source_processing_jobs job
    join public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.source_job_id=job.job_id
    where job.state='dead_letter'
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and job.attempt_count>=job.max_attempts
      and lineage.authorized_max_attempts=job.max_attempts
  ) then
    raise exception 'documented attachment-model dead-letter terminalization is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
