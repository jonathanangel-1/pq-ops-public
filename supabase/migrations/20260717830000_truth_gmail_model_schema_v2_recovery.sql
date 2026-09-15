-- Admit the provider-compatible Gmail model response schema v2 and authorize
-- only commissioned successors of zero-cost invalid_json_schema reviews.
-- The authorizer and parent sealer are evidence-only: they do not call a
-- model, accept claims, build, publish, send Gmail, or mutate freight state.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_proc regprocedure; v_definition text;
begin
  if to_regclass('public.truth_model_requests') is null
    or to_regclass('public.truth_model_sync_attempt_outcomes') is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regprocedure('private.gmail_model_response_schema_text_v1()') is null
    or to_regprocedure(
      'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v3(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'Gmail model schema v2 recovery prerequisites are unavailable'
      using errcode='55000';
  end if;
  foreach v_proc in array array[
    'private.gmail_model_response_schema_text_v1()'::regprocedure,
    'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'::regprocedure,
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure,
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_proc) into v_definition;
    if position('gmail-model-candidate-claims-v1' in v_definition)=0
      and position('gmail-model-candidate-claims-v2' in v_definition)=0 then
      raise exception 'Gmail model schema function differs from reviewed v1/v2 contract: %',v_proc
        using errcode='23514';
    end if;
  end loop;
end;
$preflight$;

do $install_schema_v2$
declare v_proc regprocedure; v_definition text; v_updated text;
begin
  foreach v_proc in array array[
    'private.gmail_model_response_schema_text_v1()'::regprocedure,
    'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'::regprocedure,
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure,
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_proc) into v_definition;
    v_updated:=replace(
      v_definition,'gmail-model-candidate-claims-v1','gmail-model-candidate-claims-v2'
    );
    if v_proc='private.gmail_model_response_schema_text_v1()'::regprocedure then
      v_updated:=replace(v_updated,',"uniqueItems":true','');
    end if;
    if v_proc='private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure then
      v_updated:=replace(
        v_updated,'gmail_model_candidate_claims_v1','gmail_model_candidate_claims_v2'
      );
      v_updated:=replace(
        v_updated,'pikiio-gmail-action-prompt-v3-462e61dbf657b7de',
        'pikiio-gmail-action-prompt-v3-12e73760f3ff6092'
      );
    end if;
    if position('gmail-model-candidate-claims-v1' in v_updated)>0
      or (v_proc='private.gmail_model_response_schema_text_v1()'::regprocedure
        and position('"uniqueItems":true' in v_updated)>0)
      or (v_proc='private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure
        and (position('gmail_model_candidate_claims_v2' in v_updated)=0
          or position('pikiio-gmail-action-prompt-v3-12e73760f3ff6092' in v_updated)=0)) then
      raise exception 'Gmail model schema v2 rewrite is incomplete: %',v_proc
        using errcode='23514';
    end if;
    execute v_updated;
  end loop;
end;
$install_schema_v2$;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=p_workspace_key
      and lineage.job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||lineage.root_batch_id::text
      and p_processor_version='primary-message-model-drain-v1:parents-v7-28d0ac5a'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

create table if not exists public.truth_gmail_model_schema_retry_parent_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-gmail-model-schema-retry-parent-authorization:v1:'
      ||authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  run_token_hash text not null check(run_token_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  replay_id text not null unique,
  prior_review_job_id uuid not null,
  prior_obligation_id text not null,
  prior_model_child_job_id uuid not null,
  prior_model_request_id text not null,
  prior_model_outcome_id text not null,
  source_observation_id text not null,
  source_observation_content_hash text not null check(
    source_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  successor_payload_hash text not null check(successor_payload_hash~'^[0-9a-f]{64}$'),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v7-28d0ac5a'
  ),
  canonical_authorization jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-model-schema-retry-parent-authorization-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  authorized_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_authorization->>'schemaVersion'=schema_version),
  check(canonical_authorization->>'workspaceKey'=workspace_key),
  check(canonical_authorization->>'connectionKey'=connection_key),
  check(canonical_authorization->>'sourceJobId'=source_job_id::text),
  check(canonical_authorization->>'rootBatchId'=root_batch_id::text),
  check(canonical_authorization->>'replayId'=replay_id),
  check(canonical_authorization->>'runTokenHash'=run_token_hash),
  check(canonical_authorization->>'reasonCode'='PROVIDER_SCHEMA_UNIQUEITEMS_REFUSED'),
  check(canonical_authorization->>'activeProcessorVersion'=active_processor_version),
  check(canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_model_schema_retry_parent_authorizations_immutable
  on public.truth_gmail_model_schema_retry_parent_authorizations;
create trigger truth_gmail_model_schema_retry_parent_authorizations_immutable
before update or delete on public.truth_gmail_model_schema_retry_parent_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_model_schema_retry_parent_authorizations enable row level security;
alter table public.truth_gmail_model_schema_retry_parent_authorizations force row level security;
revoke all on public.truth_gmail_model_schema_retry_parent_authorizations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_model_schema_retry_parent_authorizations to service_role;

create or replace function private.authorize_truth_gmail_model_schema_retry_parents(
  p_workspace_key text,p_connection_key text,p_root_batch_id uuid,p_limit integer,
  p_review_token text,p_sync_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
declare v_row record; v_body jsonb; v_hash text; v_items jsonb:='[]'::jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token)
    or not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth authorization token' using errcode='28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_connection_key is distinct from 'primary'
    or p_root_batch_id is null or p_limit is null or p_limit<1 or p_limit>10 then
    raise exception 'schema-retry parent authorization scope is invalid'
      using errcode='22023';
  end if;
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  for v_row in
    select replay.*,successor.payload as current_successor_payload,
      obligation.model_child_job_id as prior_model_child_job_id,
      request.request_id as prior_model_request_id,
      outcome.outcome_id as prior_model_outcome_id
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.gmail_model_extraction_review_obligations obligation
      on obligation.workspace_key=replay.workspace_key
     and obligation.obligation_id=replay.obligation_id
     and obligation.review_job_id=replay.prior_review_job_id
     and obligation.extraction_plan_id=replay.prior_extraction_plan_id
    join public.gmail_model_extraction_review_intents intent
      on intent.workspace_key=obligation.workspace_key
     and intent.model_child_job_id=obligation.model_child_job_id
     and intent.model_plan_id=obligation.model_plan_id
     and intent.reason_code='CONFIGURATION_ERROR'
    join public.truth_model_requests request
      on request.workspace_key=intent.workspace_key
     and request.source_job_id=intent.model_child_job_id
     and request.state='review_required'
     and request.review_reason='CONFIGURATION_ERROR'
     and request.actual_microusd=0
    join public.truth_model_sync_attempt_outcomes outcome
      on outcome.workspace_key=request.workspace_key
     and outcome.request_id=request.request_id
     and outcome.attempt_number=1
     and outcome.classification='configuration_error'
     and outcome.request_sent=true and outcome.http_status=400
     and outcome.provider_error_code='invalid_json_schema'
     and outcome.outcome_unknown=false and outcome.billing_outcome_unknown=false
     and outcome.provider_response_id='' and outcome.actual_model=''
     and outcome.normalized_result is null and outcome.actual_microusd=0
    join public.source_processing_jobs prior_child
      on prior_child.workspace_key=intent.workspace_key
     and prior_child.job_id=intent.model_child_job_id
     and prior_child.state='succeeded'
     and prior_child.result->>'outcome'='review_required'
     and prior_child.result->>'reviewReason'='CONFIGURATION_ERROR'
    join public.source_processing_jobs prior_review
      on prior_review.workspace_key=obligation.workspace_key
     and prior_review.job_id=obligation.review_job_id
     and prior_review.state='superseded'
    join public.source_processing_jobs successor
      on successor.workspace_key=replay.workspace_key
     and successor.job_id=replay.successor_parent_job_id
     and successor.source_system='gmail'
     and successor.connection_key='primary'
     and successor.job_kind='gmail_extract_message_claims'
     and successor.state='queued' and successor.attempt_count=0
     and successor.result='{}'::jsonb and successor.completed_at is null
     and successor.lease_owner is null and successor.lease_expires_at is null
     and successor.payload=replay.successor_payload
     and successor.dedupe_key=replay.successor_dedupe_key
    where replay.workspace_key=p_workspace_key
      and replay.connection_key=p_connection_key
      and replay.root_batch_id=p_root_batch_id
      and replay.shadow_only=false and replay.production_eligible=false
      and replay.production_publication_attempted=false
      and replay.source_observation_id=successor.observation_id
      and replay.source_observation_content_hash=(select observation.content_hash
        from public.source_observations observation
        where observation.workspace_key=replay.workspace_key
          and observation.observation_id=replay.source_observation_id)
      and replay.replay_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_replay),'UTF8'
      ),'sha256'),'hex')
      and replay.receipt_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_receipt),'UTF8'
      ),'sha256'),'hex')
      and not exists(select 1 from public.gmail_model_extraction_results result
        where result.workspace_key=request.workspace_key
          and result.model_plan_id=intent.model_plan_id)
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=prior_child.job_id)
      and not exists(select 1 from public.truth_gmail_model_schema_retry_parent_authorizations auth
        where auth.workspace_key=replay.workspace_key
          and auth.source_job_id=replay.successor_parent_job_id)
    order by replay.created_at,replay.replay_id
    limit p_limit
    for update of successor
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-schema-retry-parent-authorization-v1',
      'workspaceKey',v_row.workspace_key,'connectionKey',v_row.connection_key,
      'sourceJobId',v_row.successor_parent_job_id,'rootBatchId',v_row.root_batch_id,
      'replayId',v_row.replay_id,'priorReviewJobId',v_row.prior_review_job_id,
      'priorObligationId',v_row.obligation_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'priorModelOutcomeId',v_row.prior_model_outcome_id,
      'sourceObservationId',v_row.source_observation_id,
      'sourceObservationContentHash',v_row.source_observation_content_hash,
      'successorPayloadHash',v_row.successor_payload_hash,
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000004',
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v7-28d0ac5a',
      'reasonCode','PROVIDER_SCHEMA_UNIQUEITEMS_REFUSED',
      'providerCode','invalid_json_schema','providerHttpStatus',400,
      'providerActualMicrousd',0,'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_model_schema_retry_parent_authorizations(
      authorization_id,authorization_hash,run_token_hash,workspace_key,
      connection_key,source_job_id,root_batch_id,replay_id,prior_review_job_id,
      prior_obligation_id,prior_model_child_job_id,prior_model_request_id,
      prior_model_outcome_id,source_observation_id,source_observation_content_hash,
      successor_payload_hash,active_processor_version,canonical_authorization,
      schema_version
    ) values(
      'truth-gmail-model-schema-retry-parent-authorization:v1:'||v_hash,v_hash,
      v_body->>'runTokenHash',v_row.workspace_key,v_row.connection_key,
      v_row.successor_parent_job_id,v_row.root_batch_id,v_row.replay_id,
      v_row.prior_review_job_id,v_row.obligation_id,v_row.prior_model_child_job_id,
      v_row.prior_model_request_id,v_row.prior_model_outcome_id,
      v_row.source_observation_id,v_row.source_observation_content_hash,
      v_row.successor_payload_hash,
      'primary-message-model-drain-v1:parents-v7-28d0ac5a',v_body,
      'truth-gmail-model-schema-retry-parent-authorization-v1'
    );
    v_items:=v_items||jsonb_build_array(jsonb_build_object(
      'authorizationId','truth-gmail-model-schema-retry-parent-authorization:v1:'||v_hash,
      'sourceJobId',v_row.successor_parent_job_id,'replayId',v_row.replay_id,
      'sourceObservationId',v_row.source_observation_id
    ));
  end loop;
  return jsonb_build_object(
    'ok',true,'schemaVersion','truth-gmail-model-schema-retry-parent-authorization-receipt-v1',
    'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
    'rootBatchId',p_root_batch_id,'authorizedCount',jsonb_array_length(v_items),
    'items',v_items,'modelCallsPerformed',false,'candidateClaimsAutoAccepted',false,
    'productionPublicationAttempted',false
  );
end;
$function$;

create or replace function public.authorize_truth_gmail_model_schema_retry_parents(
  p_workspace_key text,p_connection_key text,p_root_batch_id uuid,p_limit integer,
  p_review_token text,p_sync_token text
) returns jsonb
language sql security definer set search_path=''
as $function$
  select private.authorize_truth_gmail_model_schema_retry_parents(
    p_workspace_key,p_connection_key,p_root_batch_id,p_limit,p_review_token,p_sync_token
  );
$function$;

revoke all on function private.authorize_truth_gmail_model_schema_retry_parents(
  text,text,uuid,integer,text,text
) from public,anon,authenticated,service_role;
revoke all on function public.authorize_truth_gmail_model_schema_retry_parents(
  text,text,uuid,integer,text,text
) from public,anon,authenticated;
grant execute on function public.authorize_truth_gmail_model_schema_retry_parents(
  text,text,uuid,integer,text,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v3(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='5s' set lock_timeout='1s'
as $function$
begin
  raise exception 'primary commissioned parent sealer v3 retired'
    using errcode='42501';
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v3(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v3(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v4(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
    p_workspace_key,p_job_id,p_worker_id,p_processor_version
  ) then
    raise exception 'schema-retry primary commissioned parent worker refused'
      using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_model_schema_retry_parent_authorizations auth
      join public.source_processing_jobs job
        on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=auth.workspace_key and lineage.job_id=auth.source_job_id
       and lineage.root_batch_id=auth.root_batch_id
      where auth.workspace_key=p_workspace_key and auth.source_job_id=p_job_id
        and auth.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and auth.active_processor_version=p_processor_version
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence and job.attempt_count=1
        and job.processor_version=p_processor_version
        and encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.payload),'UTF8'
        ),'sha256'),'hex')=auth.successor_payload_hash
        and not exists(select 1 from public.gmail_model_extraction_plans plan
          where plan.workspace_key=job.workspace_key and plan.parent_job_id=job.job_id)
        and not exists(select 1 from public.gmail_model_extraction_context_seals seal
          where seal.workspace_key=job.workspace_key and seal.parent_job_id=job.job_id)
        and not exists(select 1 from public.candidate_claim_job_manifests manifest
          where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
        and not exists(select 1 from public.candidate_claim_job_lineage candidate
          where candidate.job_id=job.job_id)
        and not exists(select 1 from public.source_processing_job_children child
          where child.parent_job_id=job.job_id)
    ) then
    raise exception 'schema-retry primary commissioned parent token refused'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v4(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v4(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare v_proc regprocedure; v_definition text; v_worker text; v_v3 text; v_v4 text;
begin
  foreach v_proc in array array[
    'private.gmail_model_response_schema_text_v1()'::regprocedure,
    'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'::regprocedure,
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure,
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_proc) into v_definition;
    if position('gmail-model-candidate-claims-v1' in v_definition)>0
      or position('gmail-model-candidate-claims-v2' in v_definition)=0 then
      raise exception 'Gmail model schema v2 is incomplete: %',v_proc using errcode='55000';
    end if;
  end loop;
  select pg_get_functiondef('private.gmail_model_response_schema_text_v1()'::regprocedure)
    into v_definition;
  if position('"uniqueItems":true' in v_definition)>0 then
    raise exception 'provider-incompatible uniqueItems survived' using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v3(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v3;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v4;
  if position('parents-v7-28d0ac5a' in v_worker)=0
    or position('primary commissioned parent sealer v3 retired' in v_v3)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v3)>0
    or position('schema-retry primary commissioned parent token refused' in v_v4)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v4)=0 then
    raise exception 'schema-retry parent authority is incomplete' using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_model_schema_retry_parent_authorizations auth
    where auth.production_publication_attempted
      or auth.canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'schema-retry parent authorization attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_model_schema_retry_parent_authorizations',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'schema-retry parent authority ACL is unsafe' using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_model_schema_retry_parent_authorizations;
