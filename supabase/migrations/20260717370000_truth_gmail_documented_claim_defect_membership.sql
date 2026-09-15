-- A claim producer whose exact deterministic plan defect was preserved by
-- 20260717250000 is absent evidence, not an endlessly retryable producer.
-- Record that absence immutably, seal an empty candidate manifest, and let the
-- existing acceptance trigger append the zero-candidate frontier membership.
-- The source observation remains unresolved and may only be reconsidered by a
-- future, separately receipted parity/reconciliation epoch.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regprocedure('private.create_pending_acceptance_epoch_v1()') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'documented Gmail claim-defect membership prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_documented_claim_defect_exclusions (
  exclusion_id text primary key check (
    exclusion_id ~ '^truth-gmail-documented-claim-defect:v1:[0-9a-f]{64}$'
  ),
  exclusion_hash text not null unique check (exclusion_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  source_job_id uuid not null,
  source_observation_id text not null,
  defect_class text not null constraint truth_gmail_documented_claim_defect_exclusions_defect_class_check
    check (defect_class=any(array[
      'gmail_model_plan_seal_validation_refusal',
      'gmail_parent_planning_context_absent',
      'gmail_model_plan_exhaustive_current_source_residual'
    ])),
  prior_job_state text not null check (prior_job_state='dead_letter'),
  prior_attempt_count integer not null check (prior_attempt_count>=0),
  prior_max_attempts integer not null check (prior_max_attempts>0),
  prior_error_code text not null check (
    prior_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check (
    prior_error_detail_hash ~ '^[0-9a-f]{64}$'
  ),
  candidate_manifest_hash text not null check (
    candidate_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_exclusion jsonb not null check (
    jsonb_typeof(canonical_exclusion)='object'
    and canonical_exclusion->>'disposition'='documented_claim_absence'
    and canonical_exclusion->>'candidateCount'='0'
    and canonical_exclusion->>'underlyingEvidenceRemainsUnresolved'='true'
    and canonical_exclusion->>'productionPublicationAttempted'='false'
  ),
  canonical_result jsonb not null check (jsonb_typeof(canonical_result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,source_job_id),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check (exclusion_id='truth-gmail-documented-claim-defect:v1:'||exclusion_hash)
);

-- Reapplication over the first 370000 revision widens the original single
-- class constraint without changing its already-minted receipt.
do $widen_defect_class$
declare
  v_constraint record;
begin
  for v_constraint in
    select constraint_row.conname constraint_name
    from pg_constraint constraint_row
    where constraint_row.conrelid=
        'public.truth_gmail_documented_claim_defect_exclusions'::regclass
      and constraint_row.contype='c'
      and pg_get_constraintdef(constraint_row.oid) like '%defect_class%'
      and constraint_row.conname<>
        'truth_gmail_documented_claim_defect_exclusions_defect_class_check'
  loop
    execute format('alter table public.truth_gmail_documented_claim_defect_exclusions drop constraint %I',
      v_constraint.constraint_name);
  end loop;
  if not exists(
    select 1 from pg_constraint
    where conrelid='public.truth_gmail_documented_claim_defect_exclusions'::regclass
      and conname='truth_gmail_documented_claim_defect_exclusions_defect_class_check'
  ) then
    alter table public.truth_gmail_documented_claim_defect_exclusions
      add constraint truth_gmail_documented_claim_defect_exclusions_defect_class_check
      check (defect_class=any(array[
        'gmail_model_plan_seal_validation_refusal',
        'gmail_parent_planning_context_absent',
        'gmail_model_plan_exhaustive_current_source_residual'
      ]));
  end if;
end;
$widen_defect_class$;

drop trigger if exists truth_gmail_documented_claim_defect_exclusions_immutable
  on public.truth_gmail_documented_claim_defect_exclusions;
create trigger truth_gmail_documented_claim_defect_exclusions_immutable
before update or delete on public.truth_gmail_documented_claim_defect_exclusions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_documented_claim_defect_exclusions enable row level security;
alter table public.truth_gmail_documented_claim_defect_exclusions force row level security;
revoke all on table public.truth_gmail_documented_claim_defect_exclusions
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_documented_claim_defect_exclusions
  to service_role;

do $reject_unknown_parent_planning_defects$
begin
  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'schemaVersion'
        ='truth-gmail-parent-planning-failure-v2'
      and job.safe_error_detail::jsonb->>'errorCode'
        ='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'underlyingCode'
        ='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'jobKind'='gmail_extract_message_claims'
      and not (
        (job.safe_error_detail::jsonb->>'postgresCode'='23514'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            like 'seal Gmail parent extraction plan failed:%')
        or
        (job.safe_error_detail::jsonb->>'postgresCode'='P0002'
          and job.safe_error_detail::jsonb->>'postgresMessage'='query returned no rows'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            ='load Gmail parent planning context failed: query returned no rows')
      )
  ) then
    raise exception 'unknown Gmail parent-planning dead-letter class requires its own authority'
      using errcode='55000';
  end if;
end;
$reject_unknown_parent_planning_defects$;

do $close_documented_claim_defects$
declare
  v_job record;
  v_manifest jsonb;
  v_manifest_hash text;
  v_worker_result jsonb;
  v_result jsonb;
  v_completion_hash text;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_exclusion jsonb;
  v_obligation jsonb;
  v_obligation_hash text;
  v_obligation_id text;
  v_dedupe_key text;
  v_pending_job_id uuid;
  v_existing public.truth_pending_acceptance_epochs%rowtype;
  v_membership jsonb;
  v_membership_hash text;
  v_hash text;
  v_id text;
  v_now timestamptz;
begin
  alter table public.source_processing_jobs
    disable trigger source_processing_job_pending_acceptance_epoch;
  for v_job in
    select job.*,observation.content_hash,
      case
        when job.safe_error_detail::jsonb->>'postgresCode'='23514'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            like 'seal Gmail parent extraction plan failed:%'
          then 'gmail_model_plan_seal_validation_refusal'
        when job.safe_error_detail::jsonb->>'postgresCode'='P0002'
          and job.safe_error_detail::jsonb->>'postgresMessage'='query returned no rows'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            ='load Gmail parent planning context failed: query returned no rows'
          then 'gmail_parent_planning_context_absent'
      end defect_class
    from public.source_processing_jobs job
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and job.lease_owner is null and job.lease_expires_at is null
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'schemaVersion'
        ='truth-gmail-parent-planning-failure-v2'
      and job.safe_error_detail::jsonb->>'errorCode'
        ='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'underlyingCode'
        ='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'jobKind'='gmail_extract_message_claims'
      and (
        (job.safe_error_detail::jsonb->>'postgresCode'='23514'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            like 'seal Gmail parent extraction plan failed:%')
        or
        (job.safe_error_detail::jsonb->>'postgresCode'='P0002'
          and job.safe_error_detail::jsonb->>'postgresMessage'='query returned no rows'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            ='load Gmail parent planning context failed: query returned no rows')
      )
      and job.result='{}'::jsonb
      and not exists(select 1 from public.candidate_claim_job_lineage lineage
        where lineage.job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
      and not exists(select 1 from public.truth_pending_acceptance_epoch_manifests member
        where member.workspace_key=job.workspace_key and member.source_job_id=job.job_id)
      and not exists(select 1 from public.truth_gmail_documented_claim_defect_exclusions existing
        where existing.workspace_key=job.workspace_key and existing.source_job_id=job.job_id)
    order by job.job_id
    for update of job
  loop
    v_now:=clock_timestamp();
    select * into strict v_lineage
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=v_job.workspace_key and lineage.job_id=v_job.job_id;

    v_manifest:=jsonb_build_object(
      'manifestSchemaVersion','candidate-claim-job-manifest-v1',
      'workspaceKey',v_job.workspace_key,'jobId',v_job.job_id,
      'sourceObservationId',v_job.observation_id,'candidates','[]'::jsonb
    );
    v_manifest_hash:=encode(extensions.digest(
      convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
    v_worker_result:=jsonb_build_object(
      'schemaVersion','truth-claim-worker-result-v2',
      'processorVersion','truth-gmail-documented-claim-defect-terminal-v1',
      'acceptancePolicyVersion','gmail-candidate-acceptance-review-boundary-v1',
      'jobKind','gmail_extract_message_claims',
      'sourceObservationId',v_job.observation_id,
      'candidateCount',0,'acceptedCount',0,'rejectedCount',0,'reviewCount',0,
      'pendingCount',0,'acceptanceDisposition','pending_acceptance_coordinator',
      'canonicalMutationCount',0,'candidates','[]'::jsonb
    );
    v_completion_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
      'jobId',v_job.job_id,'leaseFence',v_job.lease_fence,
      'processorVersion','truth-gmail-documented-claim-defect-terminal-v1',
      'result',v_worker_result,'observations','[]'::jsonb,'childJobs','[]'::jsonb,
      'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value
    )::text,'UTF8'),'sha256'),'hex');
    v_result:=v_worker_result||jsonb_build_object(
      'completionHash',v_completion_hash,
      'resultObservationIds','[]'::jsonb,'childJobs','[]'::jsonb,
      'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value
    );
    v_exclusion:=jsonb_build_object(
      'schemaVersion','truth-gmail-documented-claim-defect-exclusion-v1',
      'authorityVersion','truth-gmail-documented-claim-defect-terminal-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,
      'defectClass',v_job.defect_class,
      'priorJobState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(
        convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'disposition','documented_claim_absence',
      'candidateCount',0,'candidateManifestHash',v_manifest_hash,
      'underlyingEvidenceRemainsUnresolved',true,
      'laterResolutionPath','future_gmail_model_plan_parity_reconciliation_epoch',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_exclusion),'UTF8'),'sha256'),'hex');
    v_id:='truth-gmail-documented-claim-defect:v1:'||v_hash;

    insert into public.candidate_claim_job_manifests(
      job_id,workspace_key,source_observation_id,candidate_count,
      manifest_hash,manifest_schema_version,canonical_manifest
    ) values (
      v_job.job_id,v_job.workspace_key,v_job.observation_id,0,
      v_manifest_hash,'candidate-claim-job-manifest-v1',v_manifest
    );
    insert into public.truth_gmail_documented_claim_defect_exclusions(
      exclusion_id,exclusion_hash,workspace_key,connection_key,source_job_id,
      source_observation_id,defect_class,prior_job_state,prior_attempt_count,
      prior_max_attempts,prior_error_code,prior_error_detail_hash,
      candidate_manifest_hash,canonical_exclusion,canonical_result
    ) values (
      v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
      v_job.observation_id,v_job.defect_class,
      v_job.state,v_job.attempt_count,v_job.max_attempts,v_job.last_error_code,
      v_exclusion->>'priorErrorDetailHash',v_manifest_hash,v_exclusion,v_result
    );
    update public.source_processing_jobs job
    set state='succeeded',lease_owner=null,lease_expires_at=null,
        last_error_code='',safe_error_detail='',
        processor_version='truth-gmail-documented-claim-defect-terminal-v1',
        result=v_result,updated_at=v_now,completed_at=v_now
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail=v_job.safe_error_detail
      and job.lease_owner is null and job.lease_expires_at is null;
    if not found then
      raise exception 'documented Gmail claim-defect job changed during closure: %',
        v_job.job_id using errcode='40001';
    end if;

    v_obligation:=jsonb_build_object(
      'schemaVersion','pending-acceptance-epoch-obligation-v1',
      'workspaceKey',v_job.workspace_key,'sourceSystem',v_job.source_system,
      'connectionKey',v_job.connection_key,'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value,
      'blockerCode','ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
    );
    v_obligation_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_obligation),'UTF8'),'sha256'),'hex');
    v_obligation_id:='pending-acceptance-epoch:v1:'||v_obligation_hash;
    v_dedupe_key:='truth:pending-acceptance-epoch:v1:'||v_obligation_hash;
    insert into public.source_processing_jobs(
      dedupe_key,workspace_key,source_system,connection_key,job_kind,
      observation_id,source_object_id,state,max_attempts,last_error_code,
      safe_error_detail,payload
    ) values (
      v_dedupe_key,v_job.workspace_key,v_job.source_system,v_job.connection_key,
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
      v_pending_job_id,v_job.workspace_key,v_job.source_system,v_job.connection_key,
      v_lineage.root_batch_id,null,v_pending_job_id,
      v_lineage.source_cursor_version,v_lineage.source_cursor_value
    ) on conflict(job_id) do nothing;
    insert into public.truth_pending_acceptance_epochs(
      workspace_key,source_system,connection_key,root_batch_id,
      source_cursor_version,source_cursor_value,pending_job_id,obligation_id,
      canonical_obligation,obligation_hash,schema_version
    ) values (
      v_job.workspace_key,v_job.source_system,v_job.connection_key,
      v_lineage.root_batch_id,v_lineage.source_cursor_version,
      v_lineage.source_cursor_value,v_pending_job_id,v_obligation_id,
      v_obligation,v_obligation_hash,'pending-acceptance-epoch-obligation-v1'
    ) on conflict(workspace_key,source_system,connection_key,root_batch_id)
      do nothing;
    select * into strict v_existing
    from public.truth_pending_acceptance_epochs pending
    where pending.workspace_key=v_job.workspace_key
      and pending.source_system=v_job.source_system
      and pending.connection_key=v_job.connection_key
      and pending.root_batch_id=v_lineage.root_batch_id;
    if v_existing.canonical_obligation is distinct from v_obligation
      or v_existing.pending_job_id is distinct from v_pending_job_id then
      raise exception 'documented claim-defect pending epoch conflicts on replay'
        using errcode='23505';
    end if;
    v_membership:=jsonb_build_object(
      'schemaVersion','pending-acceptance-epoch-manifest-v1',
      'workspaceKey',v_job.workspace_key,'obligationId',v_obligation_id,
      'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,
      'candidateCount',0,'candidateManifestHash',v_manifest_hash,
      'workerResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_worker_result),'UTF8'),'sha256'),'hex')
    );
    v_membership_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_membership),'UTF8'),'sha256'),'hex');
    insert into public.truth_pending_acceptance_epoch_manifests(
      workspace_key,obligation_id,source_job_id,source_observation_id,
      source_observation_content_hash,candidate_count,candidate_manifest_hash,
      worker_result_hash,canonical_membership,membership_hash,schema_version
    ) values (
      v_job.workspace_key,v_obligation_id,v_job.job_id,v_job.observation_id,
      v_job.content_hash,0,v_manifest_hash,v_membership->>'workerResultHash',
      v_membership,v_membership_hash,'pending-acceptance-epoch-manifest-v1'
    );
  end loop;
  alter table public.source_processing_jobs
    enable trigger source_processing_job_pending_acceptance_epoch;
end;
$close_documented_claim_defects$;

do $verify$
begin
  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and job.lease_owner is null and job.lease_expires_at is null
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'schemaVersion'
        ='truth-gmail-parent-planning-failure-v2'
      and job.safe_error_detail::jsonb->>'errorCode'
        ='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'underlyingCode'
        ='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'jobKind'='gmail_extract_message_claims'
      and (
        (job.safe_error_detail::jsonb->>'postgresCode'='23514'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            like 'seal Gmail parent extraction plan failed:%')
        or
        (job.safe_error_detail::jsonb->>'postgresCode'='P0002'
          and job.safe_error_detail::jsonb->>'postgresMessage'='query returned no rows'
          and job.safe_error_detail::jsonb->>'underlyingMessage'
            ='load Gmail parent planning context failed: query returned no rows')
      )
  ) or exists(
    select 1
    from public.truth_gmail_documented_claim_defect_exclusions exclusion
    join public.source_processing_jobs job
      on job.workspace_key=exclusion.workspace_key and job.job_id=exclusion.source_job_id
    left join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=exclusion.workspace_key and manifest.job_id=exclusion.source_job_id
    left join public.truth_pending_acceptance_epoch_manifests member
      on member.workspace_key=exclusion.workspace_key and member.source_job_id=exclusion.source_job_id
    where job.state<>'succeeded' or manifest.candidate_count<>0
      or member.candidate_count<>0
      or member.candidate_manifest_hash<>manifest.manifest_hash
      or exclusion.candidate_manifest_hash<>manifest.manifest_hash
      or exclusion.canonical_exclusion->>'underlyingEvidenceRemainsUnresolved'<>'true'
      or exclusion.canonical_exclusion->>'productionPublicationAttempted'<>'false'
  ) then
    raise exception 'documented Gmail claim-defect frontier closure is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
