-- Resume an already-sealed, self-owned Gmail model plan instead of asking a
-- retrying parent to derive and seal a second plan. This authority is confined
-- to unfinished shadow Gmail claim parents and returns immutable plan identity
-- only; ordinary fenced parent completion remains the sole child-job writer.
--
-- The same forward migration replaces the two position-indexed UTF-16 helpers
-- used by residual derivation with linear set-based implementations. The old
-- PL/pgSQL loops repeatedly called substr(text, index, 1), making planning
-- superlinear on otherwise modest messages. Planning RPCs retain bounded
-- database and client budgets; nothing here grants publication authority.

do $preflight$
begin
  if to_regprocedure(
      'private.assert_candidate_claim_job_lease_pre_model(uuid,text,bigint,text)'
    ) is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.gmail_model_utf16_length(text)') is null
    or to_regprocedure('private.gmail_model_utf16_slice(text,integer,integer)') is null
    or to_regprocedure(
      'private.load_gmail_parent_planning_context(text,uuid,text,bigint,text,text)'
    ) is null
    or to_regprocedure(
      'public.load_gmail_parent_planning_context(text,uuid,text,bigint,text,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null then
    raise exception 'truth Gmail sealed-plan resume prerequisites are incomplete';
  end if;
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_processing_job_children') is null
    or to_regclass('public.source_ingest_batches') is null
    or to_regclass('public.source_observations') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_required_sources') is null then
    raise exception 'truth Gmail sealed-plan resume tables are incomplete';
  end if;
end;
$preflight$;

create or replace function private.gmail_model_utf16_length(p_text text)
returns integer
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_text is null then null
    when p_text = '' then 0
    else (
      select sum(case when ascii(supplied.ch) > 65535 then 2 else 1 end)::integer
      from regexp_split_to_table(p_text, '') supplied(ch)
    )
  end;
$function$;

create or replace function private.gmail_model_utf16_slice(
  p_text text,
  p_start integer,
  p_end integer
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  with chars as (
    select
      supplied.ch,
      supplied.ordinality,
      case when ascii(supplied.ch) > 65535 then 2 else 1 end::integer as width
    from regexp_split_to_table(p_text, '') with ordinality supplied(ch, ordinality)
    where p_text <> ''
  ), positioned as (
    select
      chars.ch,
      chars.ordinality,
      (
        sum(chars.width) over (
          order by chars.ordinality
          rows between unbounded preceding and current row
        ) - chars.width
      )::integer as start_unit,
      sum(chars.width) over (
        order by chars.ordinality
        rows between unbounded preceding and current row
      )::integer as end_unit
    from chars
  ), selected as (
    select
      string_agg(positioned.ch, '' order by positioned.ordinality) as slice,
      min(positioned.start_unit) as actual_start,
      max(positioned.end_unit) as actual_end
    from positioned
    where positioned.start_unit >= p_start
      and positioned.end_unit <= p_end
  )
  select case
    when p_text is null or p_start is null or p_end is null
      or p_start < 0 or p_end <= p_start then null
    when selected.actual_start = p_start and selected.actual_end = p_end
      then selected.slice
    else null
  end
  from selected;
$function$;

revoke all on function private.gmail_model_utf16_length(text)
  from public, anon, authenticated, service_role;
revoke all on function private.gmail_model_utf16_slice(text,integer,integer)
  from public, anon, authenticated, service_role;

create or replace function private.resume_truth_shadow_gmail_sealed_model_parent(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '60s'
set lock_timeout = '30s'
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_observation public.source_observations%rowtype;
  v_plan public.gmail_model_extraction_plans%rowtype;
  v_context public.gmail_model_extraction_context_seals%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_not_resumable jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence < 1
    or nullif(trim(coalesce(p_processor_version, '')), '') is null then
    raise exception 'sealed Gmail parent resume request is invalid'
      using errcode = '22023';
  end if;
  v_not_resumable := jsonb_build_object(
    'ok', true,
    'status', 'not_resumable',
    'schemaVersion', 'gmail-sealed-model-parent-resume-receipt-v1',
    'workspaceKey', p_workspace_key,
    'parentJobId', p_job_id,
    'extractionPlanId', '',
    'extractionPlanHash', '',
    'deterministicManifestHash', '',
    'deterministicCandidateCount', 0,
    'materializedDeterministicCandidateCount', 0,
    'plannedDeterministicCandidateSetHash', '',
    'contextSealId', '',
    'modelPlanId', '',
    'executionMode', 'none',
    'rootIngestMode', '',
    'planningStatus', '',
    'planningFailureCode', '',
    'planSealHash', '',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );

  -- Shared mutation lock prevents a shadow source cut from racing the fenced
  -- inspection while preserving concurrency among ordinary claim workers.
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  v_job := private.assert_candidate_claim_job_lease_pre_model(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if v_job.workspace_key is distinct from p_workspace_key
    or v_job.source_system <> 'gmail'
    or v_job.job_kind <> 'gmail_extract_message_claims'
    or v_job.result <> '{}'::jsonb
    or v_job.completed_at is not null then
    raise exception 'sealed Gmail parent resume requires one unfinished Gmail claim lease'
      using errcode = '23514';
  end if;
  if v_job.connection_key not like 'shadow-%'
    or exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = v_job.workspace_key
        and required_source.source_system = v_job.source_system
        and required_source.connection_key = v_job.connection_key
    ) then
    return v_not_resumable;
  end if;

  select * into strict v_lineage
  from public.source_processing_job_lineage lineage
  where lineage.workspace_key = p_workspace_key
    and lineage.job_id = p_job_id;
  select * into strict v_batch
  from public.source_ingest_batches batch
  where batch.workspace_key = p_workspace_key
    and batch.batch_id = v_lineage.root_batch_id;
  if v_lineage.parent_job_id is null
    or v_lineage.source_system is distinct from v_job.source_system
    or v_lineage.connection_key is distinct from v_job.connection_key
    or not exists (
      select 1
      from public.source_processing_job_children child
      where child.parent_job_id = v_lineage.parent_job_id
        and child.child_job_id = p_job_id
    )
    or v_batch.status <> 'committed'
    or v_batch.source_system <> 'gmail'
    or v_batch.connection_key is distinct from v_job.connection_key
    or exists (
      select 1
      from public.truth_shadow_root_source_cuts source_cut
      where source_cut.workspace_key = p_workspace_key
        and source_cut.source_system = 'gmail'
        and source_cut.connection_key = v_job.connection_key
        and source_cut.root_batch_id = v_lineage.root_batch_id
    ) then
    raise exception 'sealed Gmail parent resume scope is no longer mutable shadow evidence'
      using errcode = '23514';
  end if;

  select * into v_plan
  from public.gmail_model_extraction_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.parent_job_id = p_job_id;
  if not found
    or v_plan.planning_status <> 'complete'
    or v_plan.model_plan_id is null
    or v_plan.model_plan_hash is null
    or v_plan.model_plan is null
    or v_plan.execution_mode = 'none' then
    return v_not_resumable;
  end if;

  select * into strict v_observation
  from public.source_observations observation
  where observation.workspace_key = p_workspace_key
    and observation.observation_id = v_job.observation_id;
  select * into strict v_context
  from public.gmail_model_extraction_context_seals context_seal
  where context_seal.workspace_key = p_workspace_key
    and context_seal.context_seal_id = v_plan.context_seal_id;
  select * into strict v_manifest
  from public.candidate_claim_job_manifests manifest
  where manifest.workspace_key = p_workspace_key
    and manifest.job_id = p_job_id;

  if v_observation.source_object_type <> 'gmail_message_parsed'
    or v_observation.normalized_payload->>'schemaVersion' <> 'gmail-parsed-message-v2'
    or v_plan.source_observation_id is distinct from v_job.observation_id
    or v_plan.source_observation_content_hash is distinct from v_observation.content_hash
    or v_plan.extraction_plan_id <> 'gmail-extraction-plan:v1:' || v_plan.extraction_plan_hash
    or v_plan.model_plan_id <> 'gmail-model-plan:v1:' || v_plan.model_plan_hash
    or v_plan.model_plan->>'modelPlanId' is distinct from v_plan.model_plan_id
    or v_plan.model_plan->>'modelPlanHash' is distinct from v_plan.model_plan_hash
    or v_plan.model_plan->>'sourceObservationId' is distinct from v_observation.observation_id
    or v_plan.model_plan->>'sourceObservationContentHash' is distinct from v_observation.content_hash
    or v_plan.model_plan_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_plan.model_plan - 'modelPlanId' - 'modelPlanHash'),
      'UTF8'
    ), 'sha256'), 'hex')
    or v_plan.planning_failure_code <> ''
    or v_plan.planning_failure_detail_hash <> ''
    or v_plan.root_ingest_mode is distinct from v_batch.mode
    or v_plan.deterministic_candidate_count <> v_plan.planned_deterministic_candidate_count
    or v_plan.deterministic_manifest_hash is distinct from v_manifest.manifest_hash
    or v_plan.deterministic_candidate_count is distinct from v_manifest.candidate_count
    or v_manifest.source_observation_id is distinct from v_observation.observation_id
    or v_manifest.manifest_hash is distinct from encode(extensions.digest(convert_to(
      v_manifest.canonical_manifest::text, 'UTF8'
    ), 'sha256'), 'hex')
    or v_context.parent_job_id is distinct from p_job_id
    or v_context.source_observation_id is distinct from v_observation.observation_id
    or v_context.source_observation_content_hash is distinct from v_observation.content_hash
    or v_context.seal_hash is distinct from encode(extensions.digest(convert_to(
      v_context.canonical_seal::text, 'UTF8'
    ), 'sha256'), 'hex')
    or v_plan.plan_seal_hash is distinct from encode(extensions.digest(convert_to(
      v_plan.canonical_plan_seal::text, 'UTF8'
    ), 'sha256'), 'hex')
    or v_plan.canonical_plan_seal->>'schemaVersion' <>
      'gmail-model-extraction-plan-seal-v1'
    or v_plan.canonical_plan_seal->>'workspaceKey' is distinct from p_workspace_key
    or v_plan.canonical_plan_seal->>'parentJobId' is distinct from p_job_id::text
    or v_plan.canonical_plan_seal->>'sourceObservationId' is distinct from
      v_observation.observation_id
    or v_plan.canonical_plan_seal->>'sourceObservationContentHash' is distinct from
      v_observation.content_hash
    or v_plan.canonical_plan_seal->>'extractionPlanId' is distinct from
      v_plan.extraction_plan_id
    or v_plan.canonical_plan_seal->>'extractionPlanHash' is distinct from
      v_plan.extraction_plan_hash
    or v_plan.canonical_plan_seal->>'deterministicManifestHash' is distinct from
      v_plan.deterministic_manifest_hash
    or (v_plan.canonical_plan_seal->>'deterministicCandidateCount')::integer is distinct from
      v_plan.planned_deterministic_candidate_count
    or (v_plan.canonical_plan_seal->>'materializedDeterministicCandidateCount')::integer
      is distinct from v_plan.deterministic_candidate_count
    or v_plan.canonical_plan_seal->>'plannedDeterministicCandidateSetHash' is distinct from
      v_plan.planned_deterministic_candidate_set_hash
    or v_plan.canonical_plan_seal->>'contextSealId' is distinct from v_plan.context_seal_id
    or v_plan.canonical_plan_seal->>'modelPlanId' is distinct from v_plan.model_plan_id
    or v_plan.canonical_plan_seal->>'modelPlanHash' is distinct from v_plan.model_plan_hash
    or v_plan.canonical_plan_seal->>'expectedRequestPayloadHash' is distinct from
      v_plan.expected_request_payload_hash
    or (v_plan.canonical_plan_seal->>'expectedRequestPayloadBytes')::integer is distinct from
      v_plan.expected_request_payload_bytes
    or v_plan.canonical_plan_seal->>'wireContractVersion' is distinct from
      v_plan.wire_contract_version
    or v_plan.canonical_plan_seal->>'processingConfigVersion' is distinct from
      v_plan.expected_processing_config_version
    or v_plan.canonical_plan_seal->>'processingConfigHash' is distinct from
      v_plan.expected_processing_config_hash
    or v_plan.canonical_plan_seal->>'executionMode' is distinct from v_plan.execution_mode
    or v_plan.canonical_plan_seal->>'rootIngestMode' is distinct from v_plan.root_ingest_mode
    or v_plan.canonical_plan_seal->>'planningStatus' is distinct from v_plan.planning_status
    or v_plan.canonical_plan_seal->>'planningFailureCode' <> ''
    or v_plan.canonical_plan_seal->>'planningFailureDetailHash' <> '' then
    raise exception 'sealed Gmail model parent failed immutable resume integrity'
      using errcode = '23514';
  end if;

  if exists (
      select 1 from public.source_processing_job_children child
      where child.parent_job_id = p_job_id
    )
    or exists (
      select 1 from public.source_processing_job_lineage child_lineage
      where child_lineage.parent_job_id = p_job_id
    )
    or exists (
      select 1 from public.source_processing_job_observations output
      where output.job_id = p_job_id
    )
    or exists (
      select 1 from public.truth_pending_acceptance_epoch_manifests membership
      where membership.workspace_key = p_workspace_key
        and membership.source_job_id = p_job_id
    )
    or exists (
      select 1
      from public.candidate_claim_job_lineage candidate_lineage
      join public.candidate_claim_decisions decision_row
        on decision_row.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
      where candidate_lineage.job_id = p_job_id
    )
    or exists (
      select 1
      from public.candidate_claim_job_lineage candidate_lineage
      join public.candidate_claim_acceptance_bindings binding
        on binding.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
      where candidate_lineage.job_id = p_job_id
    )
    or exists (
      select 1 from public.gmail_model_extraction_results model_result
      where model_result.workspace_key = p_workspace_key
        and model_result.model_plan_id = v_plan.model_plan_id
    )
    or exists (
      select 1 from public.gmail_model_extraction_review_intents review_intent
      where review_intent.workspace_key = p_workspace_key
        and review_intent.extraction_plan_id = v_plan.extraction_plan_id
    )
    or exists (
      select 1 from public.gmail_model_extraction_review_obligations obligation
      where obligation.workspace_key = p_workspace_key
        and obligation.extraction_plan_id = v_plan.extraction_plan_id
    ) then
    raise exception 'sealed Gmail model parent already has downstream authority'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'resumed_sealed_model_plan',
    'schemaVersion', 'gmail-sealed-model-parent-resume-receipt-v1',
    'workspaceKey', p_workspace_key,
    'parentJobId', p_job_id,
    'extractionPlanId', v_plan.extraction_plan_id,
    'extractionPlanHash', v_plan.extraction_plan_hash,
    'deterministicManifestHash', v_plan.deterministic_manifest_hash,
    'deterministicCandidateCount', v_plan.planned_deterministic_candidate_count,
    'materializedDeterministicCandidateCount', v_plan.deterministic_candidate_count,
    'plannedDeterministicCandidateSetHash', v_plan.planned_deterministic_candidate_set_hash,
    'contextSealId', v_plan.context_seal_id,
    'modelPlanId', v_plan.model_plan_id,
    'executionMode', v_plan.execution_mode,
    'rootIngestMode', v_plan.root_ingest_mode,
    'planningStatus', v_plan.planning_status,
    'planningFailureCode', v_plan.planning_failure_code,
    'planSealHash', v_plan.plan_seal_hash,
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.resume_truth_shadow_gmail_sealed_model_parent(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '60s'
set lock_timeout = '30s'
as $function$
  select private.resume_truth_shadow_gmail_sealed_model_parent(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    p_sync_token
  );
$function$;

revoke all on function private.resume_truth_shadow_gmail_sealed_model_parent(
  text,uuid,text,bigint,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.resume_truth_shadow_gmail_sealed_model_parent(
  text,uuid,text,bigint,text,text
) from public, anon, authenticated;
grant execute on function public.resume_truth_shadow_gmail_sealed_model_parent(
  text,uuid,text,bigint,text,text
) to service_role;

-- Keep the database budget bounded while allowing the optimized residual pass
-- to finish under the Data API and local commissioning client deadline.
alter function private.load_gmail_parent_planning_context(
  text,uuid,text,bigint,text,text
) set statement_timeout = '60s';
alter function private.load_gmail_parent_planning_context(
  text,uuid,text,bigint,text,text
) set lock_timeout = '30s';
alter function public.load_gmail_parent_planning_context(
  text,uuid,text,bigint,text,text
) set statement_timeout = '60s';
alter function public.load_gmail_parent_planning_context(
  text,uuid,text,bigint,text,text
) set lock_timeout = '30s';
alter function private.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) set statement_timeout = '60s';
alter function private.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) set lock_timeout = '30s';
alter function public.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) set statement_timeout = '60s';
alter function public.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) set lock_timeout = '30s';

do $verify$
declare
  v_private_resume text;
  v_public_resume text;
  v_length_definition text;
  v_slice_definition text;
  v_signature text;
  v_configs text[];
begin
  select pg_get_functiondef(
    'private.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)'
      ::regprocedure
  ) into v_private_resume;
  select pg_get_functiondef(
    'public.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)'
      ::regprocedure
  ) into v_public_resume;
  select pg_get_functiondef('private.gmail_model_utf16_length(text)'::regprocedure)
    into v_length_definition;
  select pg_get_functiondef(
    'private.gmail_model_utf16_slice(text,integer,integer)'::regprocedure
  ) into v_slice_definition;

  if v_private_resume not like '%resumed_sealed_model_plan%'
    or v_private_resume not like '%connection_key not like ''shadow-%%'
    or v_private_resume not like '%productionPublicationAttempted%false%'
    or v_private_resume not like '%truth_shadow_root_source_cuts%'
    or v_private_resume not like '%truth_required_sources%'
    or v_public_resume not like '%private.resume_truth_shadow_gmail_sealed_model_parent%' then
    raise exception 'sealed Gmail parent resume shadow guard verification failed';
  end if;
  if v_length_definition not like '%regexp_split_to_table%'
    or v_length_definition like '%for v_index in%'
    or v_slice_definition not like '%with ordinality%'
    or v_slice_definition like '%for v_index in%' then
    raise exception 'linear Gmail UTF-16 helper rewrite verification failed';
  end if;
  if private.gmail_model_utf16_length(null) is not null
    or private.gmail_model_utf16_length('') <> 0
    or private.gmail_model_utf16_length('a😀b') <> 4
    or private.gmail_model_utf16_length(E'א\r\n中😀') <> 6
    or private.gmail_model_utf16_slice('a😀b', 1, 3) <> '😀'
    or private.gmail_model_utf16_slice('a😀b', 2, 3) is not null
    or private.gmail_model_utf16_slice(E'א\r\n中😀', 0, 4) <> E'א\r\n中' then
    raise exception 'linear Gmail UTF-16 helper semantic verification failed';
  end if;

  foreach v_signature in array array[
    'private.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
    'public.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
    'private.load_gmail_parent_planning_context(text,uuid,text,bigint,text,text)',
    'public.load_gmail_parent_planning_context(text,uuid,text,bigint,text,text)',
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)',
    'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  ] loop
    select coalesce(proconfig, array[]::text[]) into v_configs
    from pg_proc
    where oid = v_signature::regprocedure;
    if not ('statement_timeout=60s' = any(v_configs))
      or not ('lock_timeout=30s' = any(v_configs))
      or 'statement_timeout=0' = any(v_configs)
      or 'lock_timeout=0' = any(v_configs) then
      raise exception 'bounded Gmail planning timeout verification failed for %', v_signature;
    end if;
  end loop;

  if not has_function_privilege(
      'service_role',
      'public.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'private.resume_truth_shadow_gmail_sealed_model_parent(text,uuid,text,bigint,text,text)',
      'EXECUTE'
    ) then
    raise exception 'sealed Gmail parent resume ACL verification failed';
  end if;
end;
$verify$;
