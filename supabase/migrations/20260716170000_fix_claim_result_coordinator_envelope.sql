-- Claim workers submit an extraction-only result-v2. The completion authority
-- then appends six generic receipt fields, and the Gmail planning authority
-- appends a server-owned truthPlan witness. The parse-checkpoint trigger was
-- added later but validated the persisted envelope as if it were still the raw
-- worker result, making every real result-v2 completion fail. Keep the three
-- contracts separate and bind every server-owned field to durable server state.
do $migration$
declare
  v_signature regprocedure:=to_regprocedure(
    'private.create_pending_acceptance_epoch_v1()'
  );
  v_definition text;
  v_completion_signature regprocedure:=to_regprocedure(
    'private.complete_source_processing_job_pre_model_plan(uuid,text,bigint,text,jsonb,jsonb,jsonb,text)'
  );
  v_completion_definition text;
  v_model_signature regprocedure:=to_regprocedure(
    'private.complete_source_processing_job(uuid,text,bigint,text,jsonb,jsonb,jsonb,text)'
  );
  v_model_definition text;
begin
  if v_signature is null then
    raise exception 'pending acceptance epoch trigger is unavailable for claim-envelope repair'
      using errcode='55000';
  end if;
  if v_completion_signature is null or v_model_signature is null then
    raise exception 'source-processing completion wrappers are unavailable for claim-envelope repair'
      using errcode='55000';
  end if;

  select pg_get_functiondef(v_signature) into v_definition;
  select pg_get_functiondef(v_completion_signature) into v_completion_definition;
  select pg_get_functiondef(v_model_signature) into v_model_definition;

  if position('v_worker_result jsonb;' in v_definition)>0 then
    if position('v_expected_result_observation_ids jsonb;' in v_definition)=0
      or position('v_expected_child_jobs jsonb;' in v_definition)=0
      or position('v_plan public.gmail_model_extraction_plans%rowtype;' in v_definition)=0
      or position('claim result-v2 has an invalid server completion envelope' in v_definition)=0
      or position('Gmail claim result-v2 has an invalid server truth-plan witness' in v_definition)=0
      or position('non-Gmail claim result-v2 cannot carry a Gmail truth-plan witness' in v_definition)=0
      or position('private.truth_canonical_json_text(v_worker_result)' in v_definition)=0
      or position('private.truth_canonical_json_text(new.result)' in v_definition)>0 then
      raise exception 'claim-envelope repair is only partially installed'
        using errcode='23514';
    end if;
  elsif position('truth_jsonb_has_only_keys(new.result,array[' in v_definition)=0
    or position('(select count(*) from jsonb_object_keys(new.result))<>13' in v_definition)=0
    or position('claim result-v2 is not extraction-only coordinator input' in v_definition)=0
    or position('private.truth_canonical_json_text(new.result)' in v_definition)=0 then
    raise exception 'pending acceptance epoch trigger differs from the reviewed pre-repair contract'
      using errcode='23514';
  end if;

  if position('''completionHash'', v_completion_hash' in v_completion_definition)=0
    or position('''resultObservationIds'', v_result_observation_ids' in v_completion_definition)=0
    or position('''childJobs'', v_child_job_receipts' in v_completion_definition)=0
    or position('''rootBatchId'', v_lineage.root_batch_id' in v_completion_definition)=0
    or position('''sourceCursorVersion'', v_lineage.source_cursor_version' in v_completion_definition)=0
    or position('''sourceCursorValue'', v_lineage.source_cursor_value' in v_completion_definition)=0 then
    raise exception 'generic completion envelope differs from the reviewed server-owned contract'
      using errcode='23514';
  end if;
  if position('v_effective_result:=p_result||jsonb_build_object(''truthPlan''' in v_model_definition)=0
    or position('''gmail-extraction-plan-completion-witness-v2''' in v_model_definition)=0 then
    raise exception 'Gmail completion witness differs from the reviewed server-owned contract'
      using errcode='23514';
  end if;
end;
$migration$;

create or replace function private.create_pending_acceptance_epoch_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_lineage public.source_processing_job_lineage%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_observation public.source_observations%rowtype;
  v_plan public.gmail_model_extraction_plans%rowtype;
  v_worker_result jsonb;
  v_expected_result_observation_ids jsonb;
  v_expected_child_jobs jsonb;
  v_obligation jsonb;
  v_obligation_hash text;
  v_obligation_id text;
  v_dedupe_key text;
  v_pending_job_id uuid;
  v_membership jsonb;
  v_membership_hash text;
  v_existing public.truth_pending_acceptance_epochs%rowtype;
begin
  if new.state<>'succeeded'
    or new.result->>'schemaVersion'<>'truth-claim-worker-result-v2' then
    return new;
  end if;

  select * into strict v_lineage
  from public.source_processing_job_lineage
  where job_id=new.job_id and workspace_key=new.workspace_key;

  v_worker_result:=new.result-array[
    'truthPlan','completionHash','resultObservationIds','childJobs',
    'rootBatchId','sourceCursorVersion','sourceCursorValue'
  ]::text[];

  if not private.truth_jsonb_has_only_keys(v_worker_result,array[
      'schemaVersion','processorVersion','acceptancePolicyVersion','jobKind',
      'sourceObservationId','candidateCount','acceptedCount','rejectedCount',
      'reviewCount','pendingCount','acceptanceDisposition',
      'canonicalMutationCount','candidates'
    ])
    or (select count(*) from jsonb_object_keys(v_worker_result))<>13
    or new.job_kind<>all(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims',
      'tms_extract_claims','tracking_extract_claims','operator_extract_claims'
    ])
    or v_worker_result->>'jobKind'<>new.job_kind
    or v_worker_result->>'sourceObservationId'<>new.observation_id
    or v_worker_result->>'acceptanceDisposition'<>'pending_acceptance_coordinator'
    or coalesce(v_worker_result->>'candidateCount','')!~'^[0-9]+$'
    or coalesce(v_worker_result->>'pendingCount','')!~'^[0-9]+$'
    or (v_worker_result->>'candidateCount')::integer
      <> (v_worker_result->>'pendingCount')::integer
    or v_worker_result->>'acceptedCount'<>'0'
    or v_worker_result->>'rejectedCount'<>'0'
    or v_worker_result->>'reviewCount'<>'0'
    or v_worker_result->>'canonicalMutationCount'<>'0'
    or jsonb_typeof(v_worker_result->'candidates')<>'array'
    or jsonb_array_length(v_worker_result->'candidates')
      <> (v_worker_result->>'candidateCount')::integer
    or exists (
      select 1 from jsonb_array_elements(v_worker_result->'candidates') candidate
      where jsonb_typeof(candidate)<>'object'
        or candidate->>'disposition'<>'pending_acceptance_coordinator'
        or candidate ?| array[
          'decision','decisionVersionId','acceptedClaimVersionId','bindingId'
        ]
    ) then
    raise exception 'claim result-v2 is not extraction-only coordinator input'
      using errcode='23514';
  end if;

  select coalesce(jsonb_agg(membership.observation_id order by membership.ordinal),'[]'::jsonb)
  into v_expected_result_observation_ids
  from public.source_processing_job_observations membership
  where membership.job_id=new.job_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId',child.job_id,
    'dedupeKey',child.dedupe_key,
    'jobKind',child.job_kind,
    'observationId',child.observation_id
  ) order by membership.ordinal),'[]'::jsonb)
  into v_expected_child_jobs
  from public.source_processing_job_children membership
  join public.source_processing_jobs child on child.job_id=membership.child_job_id
  where membership.parent_job_id=new.job_id;

  if not private.truth_jsonb_has_only_keys(new.result,array[
      'schemaVersion','processorVersion','acceptancePolicyVersion','jobKind',
      'sourceObservationId','candidateCount','acceptedCount','rejectedCount',
      'reviewCount','pendingCount','acceptanceDisposition',
      'canonicalMutationCount','candidates','completionHash',
      'resultObservationIds','childJobs','rootBatchId','sourceCursorVersion',
      'sourceCursorValue','truthPlan'
    ])
    or (select count(*) from jsonb_object_keys(new.result))
      <> (case when new.job_kind='gmail_extract_message_claims' then 20 else 19 end)
    or coalesce(new.result->>'completionHash','')!~'^[0-9a-f]{64}$'
    or jsonb_typeof(new.result->'resultObservationIds')<>'array'
    or new.result->'resultObservationIds' is distinct from v_expected_result_observation_ids
    or jsonb_typeof(new.result->'childJobs')<>'array'
    or new.result->'childJobs' is distinct from v_expected_child_jobs
    or new.result->>'rootBatchId' is distinct from v_lineage.root_batch_id::text
    or new.result->>'sourceCursorVersion'
      is distinct from v_lineage.source_cursor_version::text
    or new.result->>'sourceCursorValue' is distinct from v_lineage.source_cursor_value then
    raise exception 'claim result-v2 has an invalid server completion envelope'
      using errcode='23514';
  end if;

  if new.job_kind='gmail_extract_message_claims' then
    select * into strict v_plan
    from public.gmail_model_extraction_plans
    where workspace_key=new.workspace_key and parent_job_id=new.job_id;
    if jsonb_typeof(new.result->'truthPlan')<>'object'
      or not private.truth_jsonb_has_only_keys(new.result->'truthPlan',array[
        'schemaVersion','extractionPlanId','planSealHash',
        'deterministicManifestHash','deterministicCandidateCount',
        'materializedDeterministicCandidateCount',
        'plannedDeterministicCandidateSetHash','modelPlanId','planningStatus',
        'planningFailureCode'
      ])
      or (select count(*) from jsonb_object_keys(new.result->'truthPlan'))<>10
      or new.result #>> '{truthPlan,schemaVersion}'
        is distinct from 'gmail-extraction-plan-completion-witness-v2'
      or new.result #>> '{truthPlan,extractionPlanId}'
        is distinct from v_plan.extraction_plan_id
      or new.result #>> '{truthPlan,planSealHash}'
        is distinct from v_plan.plan_seal_hash
      or new.result #>> '{truthPlan,deterministicManifestHash}'
        is distinct from v_plan.deterministic_manifest_hash
      or new.result #>> '{truthPlan,deterministicCandidateCount}'
        is distinct from v_plan.planned_deterministic_candidate_count::text
      or new.result #>> '{truthPlan,materializedDeterministicCandidateCount}'
        is distinct from v_plan.deterministic_candidate_count::text
      or new.result #>> '{truthPlan,plannedDeterministicCandidateSetHash}'
        is distinct from v_plan.planned_deterministic_candidate_set_hash
      or new.result #>> '{truthPlan,modelPlanId}'
        is distinct from coalesce(v_plan.model_plan_id,'')
      or new.result #>> '{truthPlan,planningStatus}'
        is distinct from v_plan.planning_status
      or new.result #>> '{truthPlan,planningFailureCode}'
        is distinct from v_plan.planning_failure_code
      or v_plan.source_observation_id is distinct from new.observation_id
      or v_worker_result->>'candidateCount'
        is distinct from v_plan.deterministic_candidate_count::text then
      raise exception 'Gmail claim result-v2 has an invalid server truth-plan witness'
        using errcode='23514';
    end if;
  elsif new.result ? 'truthPlan' then
    raise exception 'non-Gmail claim result-v2 cannot carry a Gmail truth-plan witness'
      using errcode='23514';
  end if;

  select * into strict v_manifest
  from public.candidate_claim_job_manifests
  where job_id=new.job_id and workspace_key=new.workspace_key;
  select * into strict v_observation
  from public.source_observations
  where observation_id=new.observation_id and workspace_key=new.workspace_key;
  if v_manifest.source_observation_id<>new.observation_id
    or v_manifest.candidate_count<>(v_worker_result->>'candidateCount')::integer then
    raise exception 'claim result-v2 differs from its sealed candidate manifest'
      using errcode='23514';
  end if;
  v_obligation:=jsonb_build_object(
    'schemaVersion','pending-acceptance-epoch-obligation-v1',
    'workspaceKey',new.workspace_key,'sourceSystem',new.source_system,
    'connectionKey',new.connection_key,'rootBatchId',v_lineage.root_batch_id,
    'sourceCursorVersion',v_lineage.source_cursor_version,
    'sourceCursorValue',v_lineage.source_cursor_value,
    'blockerCode','ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
  );
  v_obligation_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_obligation),'UTF8'
  ),'sha256'),'hex');
  v_obligation_id:='pending-acceptance-epoch:v1:'||v_obligation_hash;
  v_dedupe_key:='truth:pending-acceptance-epoch:v1:'||v_obligation_hash;
  insert into public.source_processing_jobs(
    dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,max_attempts,last_error_code,
    safe_error_detail,payload
  ) values (
    v_dedupe_key,new.workspace_key,new.source_system,new.connection_key,
    'truth_sequence_claim_acceptance_epoch',null,v_lineage.root_batch_id::text,
    'waiting_runtime',1,'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED',
    'Candidate frontier is sealed; canonical acceptance epoch runtime is required.',
    v_obligation||jsonb_build_object('obligationId',v_obligation_id)
  ) on conflict(dedupe_key) do nothing;
  select job_id into strict v_pending_job_id
  from public.source_processing_jobs where dedupe_key=v_dedupe_key;
  insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) values (
    v_pending_job_id,new.workspace_key,new.source_system,new.connection_key,
    v_lineage.root_batch_id,null,v_pending_job_id,
    v_lineage.source_cursor_version,v_lineage.source_cursor_value
  ) on conflict(job_id) do nothing;
  insert into public.truth_pending_acceptance_epochs(
    workspace_key,source_system,connection_key,root_batch_id,
    source_cursor_version,source_cursor_value,pending_job_id,obligation_id,
    canonical_obligation,obligation_hash,schema_version
  ) values (
    new.workspace_key,new.source_system,new.connection_key,v_lineage.root_batch_id,
    v_lineage.source_cursor_version,v_lineage.source_cursor_value,v_pending_job_id,
    v_obligation_id,v_obligation,v_obligation_hash,
    'pending-acceptance-epoch-obligation-v1'
  ) on conflict(workspace_key,source_system,connection_key,root_batch_id)
    do nothing;
  select * into strict v_existing
  from public.truth_pending_acceptance_epochs
  where workspace_key=new.workspace_key
    and source_system=new.source_system
    and connection_key=new.connection_key
    and root_batch_id=v_lineage.root_batch_id;
  if v_existing.canonical_obligation is distinct from v_obligation
    or v_existing.pending_job_id is distinct from v_pending_job_id then
    raise exception 'pending acceptance epoch conflicts on replay'
      using errcode='23505';
  end if;
  v_membership:=jsonb_build_object(
    'schemaVersion','pending-acceptance-epoch-manifest-v1',
    'workspaceKey',new.workspace_key,'obligationId',v_obligation_id,
    'sourceJobId',new.job_id,'sourceObservationId',new.observation_id,
    'sourceObservationContentHash',v_observation.content_hash,
    'candidateCount',v_manifest.candidate_count,
    'candidateManifestHash',v_manifest.manifest_hash,
    'workerResultHash',encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_worker_result),'UTF8'
    ),'sha256'),'hex')
  );
  v_membership_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_membership),'UTF8'
  ),'sha256'),'hex');
  insert into public.truth_pending_acceptance_epoch_manifests(
    workspace_key,obligation_id,source_job_id,source_observation_id,
    source_observation_content_hash,candidate_count,candidate_manifest_hash,
    worker_result_hash,canonical_membership,membership_hash,schema_version
  ) values (
    new.workspace_key,v_obligation_id,new.job_id,new.observation_id,
    v_observation.content_hash,v_manifest.candidate_count,v_manifest.manifest_hash,
    v_membership->>'workerResultHash',v_membership,v_membership_hash,
    'pending-acceptance-epoch-manifest-v1'
  ) on conflict(source_job_id) do nothing;
  return new;
end;
$function$;

revoke all on function private.create_pending_acceptance_epoch_v1()
  from public,anon,authenticated,service_role;

do $migration$
declare
  v_signature regprocedure:=to_regprocedure(
    'private.create_pending_acceptance_epoch_v1()'
  );
  v_definition text;
begin
  if v_signature is null then
    raise exception 'claim-envelope repair failed to install the pending acceptance trigger function'
      using errcode='55000';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_worker_result jsonb;' in v_definition)=0
    or position('v_expected_result_observation_ids jsonb;' in v_definition)=0
    or position('v_expected_child_jobs jsonb;' in v_definition)=0
    or position('v_plan public.gmail_model_extraction_plans%rowtype;' in v_definition)=0
    or position('claim result-v2 has an invalid server completion envelope' in v_definition)=0
    or position('Gmail claim result-v2 has an invalid server truth-plan witness' in v_definition)=0
    or position('non-Gmail claim result-v2 cannot carry a Gmail truth-plan witness' in v_definition)=0
    or position('private.truth_canonical_json_text(v_worker_result)' in v_definition)=0
    or position('private.truth_canonical_json_text(new.result)' in v_definition)>0 then
    raise exception 'claim-envelope repair failed read-back verification'
      using errcode='23514';
  end if;
end;
$migration$;
