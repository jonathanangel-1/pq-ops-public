-- A later Gmail history batch may refetch an unchanged attachment from the
-- same message. Root-local observation identity must not authorize another
-- provider call for byte-identical evidence under the same frozen model wire.
-- Adopt exactly one complete prior outcome before request creation, receipt
-- first, while preserving review-required evidence as open review.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.gmail_attachment_model_requests') is null
    or to_regclass('public.gmail_attachment_model_attempt_outcomes') is null
    or to_regclass('public.truth_gmail_attachment_model_job_terminalizations') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure(
      'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'
    ) is null then
    raise exception 'attachment replay-adoption prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_replay_adoptions(
  adoption_id text primary key check(
    adoption_id='truth-gmail-attachment-replay-adoption:v1:'||adoption_hash
  ),
  adoption_hash text not null unique check(adoption_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  source_observation_id text not null,
  prior_source_job_id uuid not null,
  prior_request_id text not null,
  prior_request_state text not null check(
    prior_request_state=any(array['succeeded','review_required'])
  ),
  disposition text not null check(disposition=any(array[
    'prior_operational_evidence_recorded',
    'prior_operator_review_remains_open'
  ])),
  source_attachment_id text not null,
  source_message_id text not null,
  source_thread_id text not null,
  raw_sha256 text not null check(raw_sha256~'^[0-9a-f]{64}$'),
  model_snapshot text not null,
  prompt_version text not null,
  response_schema_version text not null,
  response_schema_hash text not null check(response_schema_hash~'^[0-9a-f]{64}$'),
  processing_config_version text not null,
  processing_config_hash text not null check(processing_config_hash~'^[0-9a-f]{64}$'),
  prior_completion_observation_id text,
  prior_claim_job_id uuid,
  canonical_adoption jsonb not null check(
    canonical_adoption->>'schemaVersion'=
      'truth-gmail-attachment-replay-adoption-v1'
    and canonical_adoption->>'candidateClaimsAutoAccepted'='false'
    and canonical_adoption->>'modelRequestCreated'='false'
    and canonical_adoption->>'modelBudgetReserved'='false'
    and canonical_adoption->>'providerDispatchAttempted'='false'
    and canonical_adoption->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,prior_source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,prior_request_id)
    references public.gmail_attachment_model_requests(workspace_key,request_id)
    on update restrict on delete restrict,
  check(source_job_id<>prior_source_job_id),
  check((prior_request_state='succeeded'
      and disposition='prior_operational_evidence_recorded'
      and prior_completion_observation_id~'^obs:v1:[0-9a-f]{64}$'
      and prior_claim_job_id is not null)
    or (prior_request_state='review_required'
      and disposition='prior_operator_review_remains_open'
      and prior_completion_observation_id is null
      and prior_claim_job_id is null)),
  check(adoption_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_adoption),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_attachment_replay_adoptions_immutable
  on public.truth_gmail_attachment_replay_adoptions;
create trigger truth_gmail_attachment_replay_adoptions_immutable
before update or delete on public.truth_gmail_attachment_replay_adoptions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_attachment_replay_adoptions enable row level security;
alter table public.truth_gmail_attachment_replay_adoptions force row level security;
revoke all on public.truth_gmail_attachment_replay_adoptions
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_attachment_replay_adoptions to service_role;

create or replace function private.truth_gmail_attachment_replay_adoption_receipt_v1(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_adopted boolean,p_idempotent boolean
) returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_row public.truth_gmail_attachment_replay_adoptions%rowtype;
begin
  if p_adopted then
    select * into strict v_row
    from public.truth_gmail_attachment_replay_adoptions adoption
    where adoption.workspace_key=p_workspace_key
      and adoption.source_job_id=p_job_id;
  end if;
  return jsonb_build_object(
    'ok',true,'adopted',p_adopted,'idempotent',p_idempotent,
    'schemaVersion','truth-gmail-attachment-replay-adoption-receipt-v1',
    'workspaceKey',p_workspace_key,'jobId',p_job_id,
    'workerId',p_worker_id,'leaseFence',p_lease_fence,
    'processorVersion',p_processor_version,
    'adoptionId',case when p_adopted then v_row.adoption_id else null end,
    'adoptionHash',case when p_adopted then v_row.adoption_hash else null end,
    'priorJobId',case when p_adopted then v_row.prior_source_job_id else null end,
    'priorRequestId',case when p_adopted then v_row.prior_request_id else null end,
    'disposition',case when p_adopted then v_row.disposition else null end,
    'candidateClaimsAutoAccepted',false,'modelRequestCreated',false,
    'modelBudgetReserved',false,'providerDispatchAttempted',false,
    'productionPublicationAttempted',false
  );
end;
$function$;
revoke all on function private.truth_gmail_attachment_replay_adoption_receipt_v1(
  text,uuid,text,bigint,text,boolean,boolean
) from public,anon,authenticated,service_role;

create or replace function private.adopt_truth_gmail_attachment_model_replay_v1(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_model_snapshot text,p_prompt_version text,
  p_response_schema_version text,p_response_schema_hash text,
  p_processing_config_version text,p_processing_config_hash text,
  p_sync_token text
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_prior record;
  v_prior_count integer;
  v_disposition text;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_result jsonb;
  v_updated integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_model_snapshot is distinct from 'gpt-5-nano-2025-08-07'
    or p_prompt_version is distinct from 'gmail-attachment-operational-extraction-v1'
    or p_response_schema_version is distinct from
      'gmail-attachment-model-extraction-result-v1'
    or p_response_schema_hash is distinct from
      'f4cf82f32e2f66f325212bfb7e75657c6dd298d7f6e8fe4526dbda1fc8f84684'
    or p_processing_config_version is distinct from
      'gmail-attachment-model-processing-config-v2'
    or p_processing_config_hash is distinct from
      'ef97ded848a80bd68d394d602b3767816234e55cce79b93ebf7560dd4715fd25' then
    raise exception 'attachment replay adoption escapes the frozen model wire'
      using errcode='23514';
  end if;

  if exists(select 1 from public.truth_gmail_attachment_replay_adoptions adoption
    where adoption.workspace_key=p_workspace_key
      and adoption.source_job_id=p_job_id) then
    return private.truth_gmail_attachment_replay_adoption_receipt_v1(
      p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
      true,true
    );
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  perform private.require_live_truth_gmail_attachment_model_job(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version
  );
  select * into strict v_job from public.source_processing_jobs job
  where job.workspace_key=p_workspace_key and job.job_id=p_job_id
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='leased' and job.lease_owner=p_worker_id
    and job.lease_fence=p_lease_fence and job.processor_version=p_processor_version
    and job.result='{}'::jsonb and job.completed_at is null
  for update;
  select * into strict v_lineage
  from public.source_processing_job_lineage lineage
  where lineage.workspace_key=v_job.workspace_key
    and lineage.source_system=v_job.source_system
    and lineage.connection_key=v_job.connection_key
    and lineage.job_id=v_job.job_id;

  select count(*)::integer into v_prior_count
  from public.gmail_attachment_model_requests request
  join public.source_processing_jobs prior_job
    on prior_job.workspace_key=request.workspace_key
   and prior_job.job_id=request.source_job_id
  where request.workspace_key=v_job.workspace_key
    and request.connection_key=v_job.connection_key
    and request.source_job_id<>v_job.job_id
    and request.source_attachment_id=v_job.payload->>'attachmentId'
    and request.source_message_id=v_job.payload->>'messageId'
    and request.source_thread_id=v_job.payload->>'threadId'
    and request.raw_sha256=v_job.payload->>'rawSha256'
    and request.filename=v_job.payload->>'filename'
    and request.mime_type=v_job.payload->>'mimeType'
    and request.model_snapshot=p_model_snapshot
    and request.prompt_version=p_prompt_version
    and request.response_schema_version=p_response_schema_version
    and request.response_schema_hash=p_response_schema_hash
    and request.processing_config_version=p_processing_config_version
    and request.processing_config_hash=p_processing_config_hash
    and request.state=any(array['succeeded','review_required'])
    and prior_job.source_system='gmail' and prior_job.connection_key='primary'
    and prior_job.job_kind='gmail_review_attachment_extraction'
    and prior_job.source_object_id=v_job.source_object_id
    and prior_job.state='succeeded' and prior_job.completed_at is not null
    and prior_job.created_at<v_job.created_at
    and (
      (request.state='succeeded'
        and request.completion_observation_id is not null
        and request.completion_claim_job_id is not null
        and prior_job.result->>'schemaVersion'=
          'gmail-attachment-model-review-result-v1'
        and prior_job.result->>'decision'='operational_evidence_recorded'
        and prior_job.result->>'requestId'=request.request_id
        and prior_job.result->>'derivedObservationId'=
          request.completion_observation_id
        and prior_job.result#>>'{childJobs,0,jobId}'=
          request.completion_claim_job_id::text
        and exists(select 1 from public.source_processing_jobs claim_job
          where claim_job.workspace_key=request.workspace_key
            and claim_job.job_id=request.completion_claim_job_id
            and claim_job.job_kind='gmail_extract_attachment_claims'
            and claim_job.state='succeeded'))
      or
      (request.state='review_required'
        and request.review_reason='MALFORMED_OUTPUT'
        and request.completion_observation_id is null
        and request.completion_claim_job_id is null
        and prior_job.result->>'schemaVersion'=
          'truth-gmail-attachment-model-review-boundary-result-v1'
        and prior_job.result->>'requestId'=request.request_id
        and prior_job.result->>'requestState'='review_required'
        and prior_job.result->>'operatorReviewResolved'='false'
        and prior_job.result->>'operationalEvidenceMinted'='false'
        and exists(select 1
          from public.truth_gmail_attachment_model_job_terminalizations terminal
          where terminal.workspace_key=request.workspace_key
            and terminal.source_job_id=prior_job.job_id
            and terminal.request_id=request.request_id
            and terminal.request_state='review_required'))
    )
    and exists(select 1
      from public.gmail_attachment_model_attempt_outcomes outcome
      where outcome.workspace_key=request.workspace_key
        and outcome.request_id=request.request_id
        and outcome.request_sent=true and outcome.outcome_unknown=false
        and ((request.state='succeeded' and outcome.classification='succeeded')
          or (request.state='review_required'
            and outcome.classification='malformed_output')));

  if v_prior_count<>1 then
    return private.truth_gmail_attachment_replay_adoption_receipt_v1(
      p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
      false,false
    );
  end if;

  select request.*,prior_job.result as prior_job_result
  into strict v_prior
  from public.gmail_attachment_model_requests request
  join public.source_processing_jobs prior_job
    on prior_job.workspace_key=request.workspace_key
   and prior_job.job_id=request.source_job_id
  where request.workspace_key=v_job.workspace_key
    and request.connection_key=v_job.connection_key
    and request.source_job_id<>v_job.job_id
    and request.source_attachment_id=v_job.payload->>'attachmentId'
    and request.source_message_id=v_job.payload->>'messageId'
    and request.source_thread_id=v_job.payload->>'threadId'
    and request.raw_sha256=v_job.payload->>'rawSha256'
    and request.filename=v_job.payload->>'filename'
    and request.mime_type=v_job.payload->>'mimeType'
    and request.model_snapshot=p_model_snapshot
    and request.prompt_version=p_prompt_version
    and request.response_schema_version=p_response_schema_version
    and request.response_schema_hash=p_response_schema_hash
    and request.processing_config_version=p_processing_config_version
    and request.processing_config_hash=p_processing_config_hash
    and request.state=any(array['succeeded','review_required'])
    and prior_job.source_object_id=v_job.source_object_id
    and prior_job.state='succeeded' and prior_job.completed_at is not null
    and prior_job.created_at<v_job.created_at
    and ((request.state='succeeded'
      and request.completion_observation_id is not null
      and request.completion_claim_job_id is not null
      and prior_job.result->>'schemaVersion'='gmail-attachment-model-review-result-v1'
      and prior_job.result->>'decision'='operational_evidence_recorded'
      and prior_job.result->>'requestId'=request.request_id
      and prior_job.result->>'derivedObservationId'=request.completion_observation_id
      and prior_job.result#>>'{childJobs,0,jobId}'=request.completion_claim_job_id::text
      and exists(select 1 from public.source_processing_jobs claim_job
        where claim_job.workspace_key=request.workspace_key
          and claim_job.job_id=request.completion_claim_job_id
          and claim_job.job_kind='gmail_extract_attachment_claims'
          and claim_job.state='succeeded'))
    or (request.state='review_required' and request.review_reason='MALFORMED_OUTPUT'
      and request.completion_observation_id is null
      and request.completion_claim_job_id is null
      and prior_job.result->>'schemaVersion'=
        'truth-gmail-attachment-model-review-boundary-result-v1'
      and prior_job.result->>'requestId'=request.request_id
      and prior_job.result->>'requestState'='review_required'
      and prior_job.result->>'operatorReviewResolved'='false'
      and prior_job.result->>'operationalEvidenceMinted'='false'
      and exists(select 1
        from public.truth_gmail_attachment_model_job_terminalizations terminal
        where terminal.workspace_key=request.workspace_key
          and terminal.source_job_id=prior_job.job_id
          and terminal.request_id=request.request_id
          and terminal.request_state='review_required')))
    and exists(select 1 from public.gmail_attachment_model_attempt_outcomes outcome
      where outcome.workspace_key=request.workspace_key
        and outcome.request_id=request.request_id
        and outcome.request_sent=true and outcome.outcome_unknown=false
        and ((request.state='succeeded' and outcome.classification='succeeded')
          or (request.state='review_required'
            and outcome.classification='malformed_output')));

  v_disposition:=case v_prior.state when 'succeeded'
    then 'prior_operational_evidence_recorded'
    else 'prior_operator_review_remains_open' end;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-replay-adoption-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'rootBatchId',v_lineage.root_batch_id,
    'sourceObservationId',v_job.observation_id,
    'priorSourceJobId',v_prior.source_job_id,
    'priorRequestId',v_prior.request_id,'priorRequestState',v_prior.state,
    'disposition',v_disposition,
    'sourceAttachmentId',v_prior.source_attachment_id,
    'sourceMessageId',v_prior.source_message_id,
    'sourceThreadId',v_prior.source_thread_id,'rawSha256',v_prior.raw_sha256,
    'modelSnapshot',v_prior.model_snapshot,'promptVersion',v_prior.prompt_version,
    'responseSchemaVersion',v_prior.response_schema_version,
    'responseSchemaHash',v_prior.response_schema_hash,
    'processingConfigVersion',v_prior.processing_config_version,
    'processingConfigHash',v_prior.processing_config_hash,
    'priorCompletionObservationId',v_prior.completion_observation_id,
    'priorClaimJobId',v_prior.completion_claim_job_id,
    'candidateClaimsAutoAccepted',false,'modelRequestCreated',false,
    'modelBudgetReserved',false,'providerDispatchAttempted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  v_id:='truth-gmail-attachment-replay-adoption:v1:'||v_hash;
  insert into public.truth_gmail_attachment_replay_adoptions(
    adoption_id,adoption_hash,workspace_key,connection_key,source_job_id,
    root_batch_id,source_observation_id,prior_source_job_id,prior_request_id,
    prior_request_state,disposition,source_attachment_id,source_message_id,
    source_thread_id,raw_sha256,model_snapshot,prompt_version,
    response_schema_version,response_schema_hash,processing_config_version,
    processing_config_hash,prior_completion_observation_id,prior_claim_job_id,
    canonical_adoption
  ) values(
    v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
    v_lineage.root_batch_id,v_job.observation_id,v_prior.source_job_id,
    v_prior.request_id,v_prior.state,v_disposition,v_prior.source_attachment_id,
    v_prior.source_message_id,v_prior.source_thread_id,v_prior.raw_sha256,
    v_prior.model_snapshot,v_prior.prompt_version,v_prior.response_schema_version,
    v_prior.response_schema_hash,v_prior.processing_config_version,
    v_prior.processing_config_hash,v_prior.completion_observation_id,
    v_prior.completion_claim_job_id,v_body
  );
  v_result:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-replay-adoption-result-v1',
    'adoptionId',v_id,'adoptionHash',v_hash,
    'priorSourceJobId',v_prior.source_job_id,
    'priorRequestId',v_prior.request_id,'priorRequestState',v_prior.state,
    'disposition',v_disposition,'candidateClaimsAutoAccepted',false,
    'modelRequestCreated',false,'modelBudgetReserved',false,
    'providerDispatchAttempted',false,'productionPublicationAttempted',false
  );
  update public.source_processing_jobs job
  set state='succeeded',lease_owner=null,lease_expires_at=null,
    last_error_code='',safe_error_detail='',
    processor_version='truth-gmail-attachment-replay-adoption-v1',
    result=v_result,updated_at=clock_timestamp(),completed_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state='leased' and job.lease_owner=p_worker_id
    and job.lease_fence=p_lease_fence and job.processor_version=p_processor_version
    and job.result='{}'::jsonb and job.completed_at is null;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'attachment replay-adoption lease fence changed'
      using errcode='40001';
  end if;
  return private.truth_gmail_attachment_replay_adoption_receipt_v1(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    true,false
  );
end;
$function$;
revoke all on function private.adopt_truth_gmail_attachment_model_replay_v1(
  text,uuid,text,bigint,text,text,text,text,text,text,text,text
) from public,anon,authenticated,service_role;

create or replace function public.adopt_truth_gmail_attachment_model_replay(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_model_snapshot text,p_prompt_version text,
  p_response_schema_version text,p_response_schema_hash text,
  p_processing_config_version text,p_processing_config_hash text,
  p_sync_token text
) returns jsonb language sql security definer set search_path='' as $function$
  select private.adopt_truth_gmail_attachment_model_replay_v1(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_model_snapshot,p_prompt_version,p_response_schema_version,
    p_response_schema_hash,p_processing_config_version,
    p_processing_config_hash,p_sync_token
  );
$function$;
revoke all on function public.adopt_truth_gmail_attachment_model_replay(
  text,uuid,text,bigint,text,text,text,text,text,text,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.adopt_truth_gmail_attachment_model_replay(
  text,uuid,text,bigint,text,text,text,text,text,text,text,text
) to service_role;

create index if not exists gmail_attachment_model_requests_replay_lookup_idx
  on public.gmail_attachment_model_requests(
    workspace_key,connection_key,source_attachment_id,source_message_id,
    raw_sha256,model_snapshot,prompt_version,state,created_at
  ) where state=any(array['succeeded','review_required']);
analyze public.truth_gmail_attachment_replay_adoptions;
analyze public.gmail_attachment_model_requests;

do $verify$
declare v_function text;
begin
  select lower(pg_get_functiondef(
    'private.adopt_truth_gmail_attachment_model_replay_v1(text,uuid,text,bigint,text,text,text,text,text,text,text,text)'::regprocedure
  )) into v_function;
  if position('v_prior_count<>1' in v_function)=0
    or position('request.raw_sha256=v_job.payload->>''rawsha256''' in v_function)=0
    or position('request.state=any(array[''succeeded'',''review_required''])' in v_function)=0
    or position('outcome.outcome_unknown=false' in v_function)=0
    or position('providerdispatchattempted'',false' in v_function)=0
    or position('productionpublicationattempted'',false' in v_function)=0 then
    raise exception 'attachment replay-adoption authority is incomplete'
      using errcode='55000';
  end if;
  if not has_function_privilege('service_role',
      'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)',
      'execute')
    or has_function_privilege('anon',
      'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)',
      'execute') then
    raise exception 'attachment replay-adoption RPC ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;
