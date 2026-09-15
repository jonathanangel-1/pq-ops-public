-- Version the Gmail claim extractor for the server-signal modality anchor and
-- authorize attempt two only for the exact two v12 content-addressed plan
-- collisions. No model call, candidate acceptance, cut, build, publication,
-- email, or freight mutation occurs here.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regprocedure(
      'private.append_candidate_claim(text,uuid,text,bigint,text,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'private.derive_gmail_model_candidate_v1(text,text,text,jsonb)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v9(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regclass('public.truth_gmail_model_modality_retry_authorizations') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'Gmail model modality identity retry prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function private.gmail_model_modality_quote_v1(
  p_model_input jsonb,p_predicate text,p_span jsonb,p_segment jsonb
) returns text
language plpgsql immutable security invoker set search_path=''
as $function$
declare
  v_signal_count integer; v_anchor_start integer; v_anchor_end integer;
  v_quote text; v_segment_start integer; v_total integer;
  v_pattern text:='\,[[:space:]]+'; v_ordinal integer:=1;
  v_start_char integer; v_end_char integer; v_relative_start integer:=0;
  v_relative_end integer; v_raw text; v_leading text; v_trailing text;
  v_unit_start integer; v_unit_end integer; v_unit_quote text;
begin
  if jsonb_typeof(p_model_input)<>'object'
    or jsonb_typeof(p_model_input->'unresolvedSignals')<>'array'
    or jsonb_typeof(p_span)<>'object' or jsonb_typeof(p_segment)<>'object'
    or coalesce(p_span->>'start','')!~'^[0-9]+$'
    or coalesce(p_span->>'end','')!~'^[0-9]+$'
    or coalesce(p_segment->>'start','')!~'^[0-9]+$'
    or jsonb_typeof(p_segment->'quote')<>'string' then
    return null;
  end if;
  select count(*)::integer,min((signal->>'start')::integer),
    min((signal->>'end')::integer)
  into v_signal_count,v_anchor_start,v_anchor_end
  from jsonb_array_elements(p_model_input->'unresolvedSignals') item(signal)
  where signal->>'predicate'=p_predicate
    and coalesce(signal->>'start','')~'^[0-9]+$'
    and coalesce(signal->>'end','')~'^[0-9]+$'
    and (signal->>'start')::integer<(p_span->>'end')::integer
    and (signal->>'end')::integer>(p_span->>'start')::integer;
  if v_signal_count<>1 then
    v_anchor_start:=(p_span->>'start')::integer;
    v_anchor_end:=(p_span->>'end')::integer;
  end if;
  v_quote:=p_segment->>'quote';
  v_segment_start:=(p_segment->>'start')::integer;
  v_total:=private.gmail_model_utf16_length(v_quote);
  loop
    v_start_char:=regexp_instr(v_quote,v_pattern,1,v_ordinal,0);
    if v_start_char=0 then
      v_relative_end:=v_total;
    else
      v_relative_end:=private.gmail_model_utf16_length(
        substr(v_quote,1,v_start_char-1)
      );
    end if;
    v_raw:=private.gmail_model_utf16_slice(
      v_quote,v_relative_start,v_relative_end
    );
    v_leading:=coalesce(substring(v_raw from '^[[:space:]]*'),'');
    v_trailing:=coalesce(substring(v_raw from '[[:space:]]*$'),'');
    v_unit_start:=v_segment_start+v_relative_start
      +private.gmail_model_utf16_length(v_leading);
    v_unit_end:=v_segment_start+v_relative_end
      -private.gmail_model_utf16_length(v_trailing);
    if v_unit_end>v_unit_start
      and v_anchor_start>=v_unit_start and v_anchor_end<=v_unit_end then
      v_unit_quote:=private.gmail_model_utf16_slice(
        v_quote,v_unit_start-v_segment_start,v_unit_end-v_segment_start
      );
      return v_unit_quote;
    end if;
    if v_start_char=0 then exit; end if;
    v_end_char:=regexp_instr(v_quote,v_pattern,1,v_ordinal,1);
    v_relative_start:=private.gmail_model_utf16_length(
      substr(v_quote,1,v_end_char-1)
    );
    v_ordinal:=v_ordinal+1;
  end loop;
  return v_quote;
end;
$function$;

revoke all on function private.gmail_model_modality_quote_v1(jsonb,text,jsonb,jsonb)
  from public,anon,authenticated,service_role;

do $install_extractor_v8$
declare
  v_name text; v_proc regprocedure; v_definition text; v_updated text;
  v_v7 text:=
    'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e';
  v_v7_pattern text:=
    'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology\+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e';
  v_v8 text:=
    'gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e';
begin
  foreach v_name in array array[
      'private.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)',
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  ] loop
    v_proc:=to_regprocedure(v_name);
    if v_proc is null then continue; end if;
    select pg_get_functiondef(v_proc) into v_definition;
    if position(v_v8 in v_definition)>0
      and position(v_v7 in v_definition)>0 then
      v_updated:=v_definition;
    elsif position(v_v7 in v_definition)>0 then
      v_updated:=regexp_replace(
        v_definition,
        '(p_extraction_plan->>''extractorVersion'')\s*<>\s*'''||v_v7_pattern||'''',
        '\1 <> all(array['''||v_v7||''','''||v_v8||'''])','g'
      );
      v_updated:=regexp_replace(
        v_updated,
        '(v_model_plan->>''extractorVersion'')\s*<>\s*'''||v_v7_pattern||'''',
        '\1 <> all(array['''||v_v7||''','''||v_v8||'''])','g'
      );
    else
      raise exception 'Gmail extractor v7/v8 marker missing from %',v_proc
        using errcode='23514';
    end if;
    if position(v_v7 in v_updated)=0 or position(v_v8 in v_updated)=0
      or v_updated is not distinct from v_definition
        and position(v_v8 in v_definition)=0 then
      raise exception 'Gmail extractor v8 rewrite is incomplete: %',v_proc
        using errcode='23514';
    end if;
    execute v_updated;
  end loop;
end;
$install_extractor_v8$;

do $install_model_candidate_modality_v8$
declare v_proc regprocedure; v_definition text; v_updated text;
begin
  v_proc:=to_regprocedure(
    'private.derive_gmail_model_candidate_v1(text,text,text,jsonb)'
  );
  select pg_get_functiondef(v_proc) into v_definition;
  if position('v_declarative_future_document boolean;' in v_definition)>0 then
    v_updated:=v_definition;
  else
    if position('v_semantic_quote text;' in v_definition)=0
      or position('v_semantic_quote:=v_segment->>''quote'';' in v_definition)=0
      or position(
        'v_is_request:=private.gmail_deterministic_request_speech_v1(v_semantic_quote);'
        in v_definition
      )=0 then
      raise exception 'Gmail model candidate modality v8 patch markers are unavailable'
        using errcode='23514';
    end if;
    v_updated:=replace(
      v_definition,'v_semantic_quote text;',
      'v_semantic_quote text; v_declarative_future_document boolean;'
    );
    v_updated:=replace(
      v_updated,'v_semantic_quote:=v_segment->>''quote'';',
      'if v_plan.extractor_version='||quote_literal(
        'gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:'
      )||'||v_policy.registry_hash then '
      ||'v_semantic_quote:=private.gmail_model_modality_quote_v1('
      ||'v_plan.model_plan->''modelInput'',p_raw_claim->>''predicate'',v_span,v_segment); '
      ||'if v_semantic_quote is null then return null; end if; '
      ||'else v_semantic_quote:=v_segment->>''quote''; end if;'
    );
    v_updated:=replace(
      v_updated,
      'v_is_request:=private.gmail_deterministic_request_speech_v1(v_semantic_quote);',
      'v_declarative_future_document:=v_plan.extractor_version='||quote_literal(
        'gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:'
      )||'||v_policy.registry_hash and v_semantic_quote~* '
      ||quote_literal('^[[:space:]]*will[[:space:]]+(send|share|provide|forward)([^a-z]|$)')
      ||'; v_is_request:=private.gmail_deterministic_request_speech_v1(v_semantic_quote) '
      ||'and not v_declarative_future_document;'
    );
  end if;
  if position('v_declarative_future_document boolean;' in v_updated)=0
    or position('private.gmail_model_modality_quote_v1(' in v_updated)=0 then
    raise exception 'Gmail model candidate modality v8 patch is incomplete'
      using errcode='23514';
  end if;
  execute v_updated;
end;
$install_model_candidate_modality_v8$;

-- The plan envelope and model candidates use v8 because the model-response
-- validator changed. Deterministic candidates remain on v7: their semantic
-- policy did not change. Copy the immutable predicate registry to the new
-- model-candidate identity without rewriting v7.
insert into public.candidate_claim_predicate_registry(
  predicate,extractor_version,candidate_schema_version,source_system,gate,
  statuses,effects,registry_version,registry_hash,acceptance_policy_version
)
select predicate,
  'gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:'||registry_hash,
  candidate_schema_version,source_system,gate,statuses,effects,
  registry_version,registry_hash,acceptance_policy_version
from public.candidate_claim_predicate_registry
where extractor_version=
  'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:'||registry_hash
  and source_system='gmail'
on conflict(predicate,extractor_version) do nothing;

do $verify_model_candidate_registry_v8$
declare v_v7 integer; v_v8 integer;
begin
  select count(*) into v_v7
  from public.candidate_claim_predicate_registry
  where extractor_version=
    'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:'||registry_hash
    and source_system='gmail';
  select count(*) into v_v8
  from public.candidate_claim_predicate_registry
  where extractor_version=
    'gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:'||registry_hash
    and source_system='gmail';
  if v_v7=0 or v_v8<>v_v7 then
    raise exception 'Gmail model candidate v8 registry copy is incomplete: v7 %, v8 %',
      v_v7,v_v8 using errcode='23514';
  end if;
end;
$verify_model_candidate_registry_v8$;

create table if not exists public.truth_gmail_model_modality_collision_retries (
  retry_id text primary key check(
    retry_id='truth-gmail-model-modality-collision-retry:v1:'||retry_hash
  ),
  retry_hash text not null unique check(retry_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  authorization_id text not null unique,
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  prior_extraction_plan_id text not null unique,
  prior_model_plan_id text not null unique,
  prior_failure_safe_detail_hash text not null check(
    prior_failure_safe_detail_hash~'^[0-9a-f]{64}$'
  ),
  run_token_hash text not null check(
    run_token_hash='0000000000000000000000000000000000000000000000000000000000000003'
  ),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v12-39d43130'
  ),
  authorized_attempt integer not null check(authorized_attempt=2),
  canonical_retry jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-model-modality-collision-retry-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  authorized_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,retry_id),
  foreign key(workspace_key,authorization_id)
    references public.truth_gmail_model_modality_retry_authorizations(
      workspace_key,authorization_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(retry_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_retry),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_retry->>'schemaVersion'=schema_version),
  check(canonical_retry->>'workspaceKey'=workspace_key),
  check(canonical_retry->>'authorizationId'=authorization_id),
  check(canonical_retry->>'sourceJobId'=source_job_id::text),
  check(canonical_retry->>'rootBatchId'=root_batch_id::text),
  check(canonical_retry->>'priorExtractionPlanId'=prior_extraction_plan_id),
  check(canonical_retry->>'priorModelPlanId'=prior_model_plan_id),
  check(canonical_retry->>'priorFailureSafeDetailHash'=prior_failure_safe_detail_hash),
  check(canonical_retry->>'runTokenHash'=run_token_hash),
  check(canonical_retry->>'activeProcessorVersion'=active_processor_version),
  check((canonical_retry->>'authorizedAttempt')::integer=authorized_attempt),
  check(canonical_retry->>'reasonCode'='EXTRACTOR_IDENTITY_NOT_ROTATED'),
  check(canonical_retry->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_model_modality_collision_retries_immutable
  on public.truth_gmail_model_modality_collision_retries;
create trigger truth_gmail_model_modality_collision_retries_immutable
before update or delete on public.truth_gmail_model_modality_collision_retries
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_model_modality_collision_retries enable row level security;
alter table public.truth_gmail_model_modality_collision_retries force row level security;
revoke all on public.truth_gmail_model_modality_collision_retries
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_model_modality_collision_retries to service_role;

do $authorize_retry$
declare v_row record; v_body jsonb; v_hash text; v_count integer:=0;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-gmail-model-modality-collision-retry-v1',0
  ));
  for v_row in
    select auth.authorization_id,auth.source_job_id,auth.root_batch_id,
      auth.run_token_hash,auth.active_processor_version,
      prior_plan.extraction_plan_id,prior_plan.model_plan_id,
      encode(extensions.digest(convert_to(job.safe_error_detail,'UTF8'),'sha256'),'hex')
        as safe_detail_hash
    from public.truth_gmail_model_modality_retry_authorizations auth
    join public.source_processing_jobs job
      on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
    join public.gmail_model_extraction_plans prior_plan
      on prior_plan.workspace_key=auth.workspace_key
     and prior_plan.parent_job_id=auth.prior_pod_prompt_parent_job_id
    where auth.workspace_key='primary'
      and auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v12-39d43130'
      and auth.run_token_hash=
        '0000000000000000000000000000000000000000000000000000000000000003'
      and job.state='retry_wait' and job.attempt_count=1
      and job.processor_version=auth.active_processor_version
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and (job.safe_error_detail::jsonb)->>'schemaVersion'=
        'truth-gmail-parent-planning-failure-v2'
      and (job.safe_error_detail::jsonb)->>'underlyingCode'=
        'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and (job.safe_error_detail::jsonb)->>'postgresCode'='23505'
      and (job.safe_error_detail::jsonb)->>'postgresDetail'=
        'Key (extraction_plan_id)=('||prior_plan.extraction_plan_id||') already exists.'
      and prior_plan.model_plan->>'promptVersion'='gmail-claim-extraction-prompt-v4'
      and prior_plan.model_plan->>'responseSchemaVersion'=
        'gmail-model-candidate-claims-v4'
      and not exists(select 1 from public.gmail_model_extraction_plans current_plan
        where current_plan.workspace_key=job.workspace_key
          and current_plan.parent_job_id=job.job_id)
      and not exists(select 1 from public.source_processing_job_children child
        where child.parent_job_id=job.job_id)
      and not exists(select 1
        from public.truth_gmail_model_modality_collision_retries existing
        where existing.workspace_key=auth.workspace_key
          and existing.source_job_id=auth.source_job_id)
    order by auth.authorization_id
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-modality-collision-retry-v1',
      'workspaceKey','primary','authorizationId',v_row.authorization_id,
      'sourceJobId',v_row.source_job_id,'rootBatchId',v_row.root_batch_id,
      'priorExtractionPlanId',v_row.extraction_plan_id,
      'priorModelPlanId',v_row.model_plan_id,
      'priorFailureSafeDetailHash',v_row.safe_detail_hash,
      'runTokenHash',v_row.run_token_hash,
      'activeProcessorVersion',v_row.active_processor_version,
      'authorizedAttempt',2,'reasonCode','EXTRACTOR_IDENTITY_NOT_ROTATED',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_model_modality_collision_retries(
      retry_id,retry_hash,workspace_key,authorization_id,source_job_id,
      root_batch_id,prior_extraction_plan_id,prior_model_plan_id,
      prior_failure_safe_detail_hash,run_token_hash,active_processor_version,
      authorized_attempt,canonical_retry,schema_version
    ) values(
      'truth-gmail-model-modality-collision-retry:v1:'||v_hash,v_hash,'primary',
      v_row.authorization_id,v_row.source_job_id,v_row.root_batch_id,
      v_row.extraction_plan_id,v_row.model_plan_id,v_row.safe_detail_hash,
      v_row.run_token_hash,v_row.active_processor_version,2,v_body,
      'truth-gmail-model-modality-collision-retry-v1'
    );
    v_count:=v_count+1;
  end loop;
  if v_count>2 then
    raise exception 'Gmail modality collision retry exceeded bounded cohort'
      using errcode='54000';
  end if;
end;
$authorize_retry$;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v9(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
    p_workspace_key,p_job_id,p_worker_id,p_processor_version
  ) then
    raise exception 'model-modality retry parent worker refused' using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_model_modality_retry_authorizations auth
      join public.source_processing_jobs job
        on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=auth.workspace_key and lineage.job_id=auth.source_job_id
       and lineage.root_batch_id=auth.root_batch_id
      where auth.workspace_key=p_workspace_key and auth.source_job_id=p_job_id
        and auth.active_processor_version=p_processor_version
        and auth.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence and job.attempt_count in (1,2)
        and job.processor_version=p_processor_version
        and (job.attempt_count=1 or exists(
          select 1
          from public.truth_gmail_model_modality_collision_retries retry
          where retry.workspace_key=auth.workspace_key
            and retry.authorization_id=auth.authorization_id
            and retry.source_job_id=job.job_id
            and retry.root_batch_id=auth.root_batch_id
            and retry.authorized_attempt=job.attempt_count
            and retry.run_token_hash=auth.run_token_hash
            and retry.active_processor_version=auth.active_processor_version
            and retry.prior_failure_safe_detail_hash=encode(extensions.digest(
              convert_to(job.safe_error_detail,'UTF8'),'sha256'
            ),'hex')
            and retry.production_publication_attempted=false
        ))
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
    raise exception 'model-modality retry parent token refused' using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v9(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v9(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare v_reconcile text; v_seal text; v_derive text; v_v9 text;
begin
  select pg_get_functiondef(
    'private.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)'::regprocedure
  ) into v_reconcile;
  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_seal;
  select pg_get_functiondef(
    'private.derive_gmail_model_candidate_v1(text,text,text,jsonb)'::regprocedure
  ) into v_derive;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v9(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v9;
  if position('gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:' in v_reconcile)=0
    or position('gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:' in v_reconcile)=0
    or position('gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:' in v_seal)=0
    or position('gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:' in v_seal)=0
    or position('private.gmail_model_modality_quote_v1(' in v_derive)=0
    or position('v_declarative_future_document boolean;' in v_derive)=0
    or position('truth_gmail_model_modality_collision_retries' in v_v9)=0
    or position('job.attempt_count in (1,2)' in v_v9)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v9)=0 then
    raise exception 'Gmail model modality identity retry is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_model_modality_collision_retries
    where production_publication_attempted
      or canonical_retry->>'productionPublicationAttempted'<>'false') then
    raise exception 'Gmail model modality identity retry attempted publication'
      using errcode='55000';
  end if;
  if has_table_privilege(
      'service_role','public.truth_gmail_model_modality_collision_retries',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'Gmail model modality identity retry ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_model_modality_collision_retries;
