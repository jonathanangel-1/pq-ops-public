-- Terminalize three deterministic parent-planning-failure-v2 classes that
-- appeared after their batches' acceptance epochs were sealed. The original
-- acceptance epoch remains immutable; a separate late absence-membership
-- receipt records the true later timeline. No candidate or evidence is minted.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_documented_claim_defect_exclusions') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null then
    raise exception 'parent-planning v2 defect prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create unique index if not exists truth_gmail_documented_claim_defects_workspace_exclusion_key
  on public.truth_gmail_documented_claim_defect_exclusions(workspace_key,exclusion_id);

create table if not exists public.truth_gmail_documented_claim_defect_late_memberships (
  membership_id text primary key check(
    membership_id='truth-gmail-documented-claim-defect-late-membership:v1:'||membership_hash
  ),
  membership_hash text not null unique check(membership_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  root_batch_id uuid not null,
  source_job_id uuid not null unique,
  defect_exclusion_id text not null unique,
  candidate_manifest_hash text not null check(candidate_manifest_hash~'^[0-9a-f]{64}$'),
  prior_acceptance_epoch_id text not null default '',
  prior_acceptance_receipt_hash text not null default '' check(
    prior_acceptance_receipt_hash='' or prior_acceptance_receipt_hash~'^[0-9a-f]{64}$'
  ),
  canonical_membership jsonb not null check(
    canonical_membership->>'candidateCount'='0'
    and canonical_membership->>'sealedAcceptanceEpochRewritten'='false'
    and canonical_membership->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,defect_exclusion_id)
    references public.truth_gmail_documented_claim_defect_exclusions(workspace_key,exclusion_id)
    on update restrict on delete restrict,
  check((prior_acceptance_epoch_id='')=(prior_acceptance_receipt_hash='')),
  check(membership_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_membership),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_documented_claim_defect_late_memberships_immutable
  on public.truth_gmail_documented_claim_defect_late_memberships;
create trigger truth_gmail_documented_claim_defect_late_memberships_immutable
before update or delete on public.truth_gmail_documented_claim_defect_late_memberships
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_documented_claim_defect_late_memberships enable row level security;
alter table public.truth_gmail_documented_claim_defect_late_memberships force row level security;
revoke all on table public.truth_gmail_documented_claim_defect_late_memberships
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_documented_claim_defect_late_memberships
  to service_role;

create or replace function private.truth_gmail_parent_planning_v2_defect_class_v1(
  p_error_code text,p_safe_error_detail text
) returns text language plpgsql immutable set search_path='' as $function$
declare v_detail jsonb; v_message text;
begin
  if p_error_code<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED' then return ''; end if;
  v_detail:=p_safe_error_detail::jsonb;
  if jsonb_typeof(v_detail)<>'object'
    or v_detail->>'schemaVersion'<>'truth-gmail-parent-planning-failure-v2'
    or v_detail->>'errorCode'<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or v_detail->>'jobKind'<>'gmail_extract_message_claims' then return ''; end if;
  v_message:=coalesce(v_detail->>'underlyingMessage','');
  if v_detail->>'postgresCode'='P0002'
    and v_detail->>'postgresMessage'='query returned no rows'
    and v_message='load Gmail parent planning context failed: query returned no rows' then
    return 'gmail_parent_planning_context_absent';
  end if;
  if v_detail->>'postgresCode'='23514'
    and v_message like 'reconcile stale shadow Gmail extraction plan failed: sealed Gmail plan is not th%' then
    return 'gmail_stale_plan_reconciliation_validation_refusal';
  end if;
  if v_detail->>'postgresCode'='23514'
    and v_message like 'seal Gmail parent extraction plan failed: deterministic Gmail candidate semantic%' then
    return 'gmail_deterministic_candidate_semantic_validation_refusal';
  end if;
  return '';
exception when others then return '';
end;
$function$;
revoke all on function private.truth_gmail_parent_planning_v2_defect_class_v1(text,text)
  from public,anon,authenticated,service_role;

do $close$
declare
  v_job record; v_lineage public.source_processing_job_lineage%rowtype;
  v_epoch public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_existing_manifest public.candidate_claim_job_manifests%rowtype;
  v_manifest jsonb; v_manifest_hash text; v_worker jsonb; v_result jsonb;
  v_completion_hash text; v_exclusion jsonb; v_exclusion_hash text;
  v_exclusion_id text; v_membership jsonb; v_membership_hash text; v_now timestamptz;
begin
  alter table public.source_processing_jobs
    disable trigger source_processing_job_pending_acceptance_epoch;
  for v_job in select job.*,observation.content_hash,
      private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail) parent_planning_failure_class,
      case private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail)
        when 'gmail_parent_planning_context_absent'
          then 'gmail_parent_planning_context_absent'
        else 'gmail_model_plan_seal_validation_refusal'
      end defect_class
    from public.source_processing_jobs job
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
      and private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail)<>''
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
          and manifest.candidate_count<>0)
      and not exists(select 1 from public.truth_gmail_documented_claim_defect_exclusions receipt
        where receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_now:=clock_timestamp();
    select * into strict v_lineage from public.source_processing_job_lineage lineage
      where lineage.workspace_key=v_job.workspace_key and lineage.job_id=v_job.job_id;
    select * into v_epoch from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=v_job.workspace_key
        and epoch.connection_key=v_job.connection_key
        and epoch.root_batch_id=v_lineage.root_batch_id;
    select * into v_existing_manifest
    from public.candidate_claim_job_manifests manifest
    where manifest.workspace_key=v_job.workspace_key and manifest.job_id=v_job.job_id;
    if found then
      if v_existing_manifest.candidate_count is distinct from 0
        or v_existing_manifest.source_observation_id is distinct from v_job.observation_id
        or v_existing_manifest.manifest_schema_version is distinct from 'candidate-claim-job-manifest-v1'
        or v_existing_manifest.canonical_manifest->>'manifestSchemaVersion'
          is distinct from 'candidate-claim-job-manifest-v1'
        or v_existing_manifest.canonical_manifest->>'workspaceKey' is distinct from v_job.workspace_key
        or v_existing_manifest.canonical_manifest->>'jobId' is distinct from v_job.job_id::text
        or v_existing_manifest.canonical_manifest->>'sourceObservationId' is distinct from v_job.observation_id
        or v_existing_manifest.canonical_manifest->'candidates' is distinct from '[]'::jsonb
        or v_existing_manifest.manifest_hash is distinct from encode(extensions.digest(convert_to(
          v_existing_manifest.canonical_manifest::text,'UTF8'),'sha256'),'hex') then
        raise exception 'existing parent-planning defect manifest is not exact zero-candidate replay proof'
          using errcode='23514';
      end if;
      v_manifest:=v_existing_manifest.canonical_manifest;
      v_manifest_hash:=v_existing_manifest.manifest_hash;
    else
      v_manifest:=jsonb_build_object(
        'manifestSchemaVersion','candidate-claim-job-manifest-v1',
        'workspaceKey',v_job.workspace_key,'jobId',v_job.job_id,
        'sourceObservationId',v_job.observation_id,'candidates','[]'::jsonb);
      v_manifest_hash:=encode(extensions.digest(convert_to(
        v_manifest::text,'UTF8'),'sha256'),'hex');
      insert into public.candidate_claim_job_manifests(job_id,workspace_key,
        source_observation_id,candidate_count,manifest_hash,
        manifest_schema_version,canonical_manifest)
      values(v_job.job_id,v_job.workspace_key,v_job.observation_id,0,
        v_manifest_hash,'candidate-claim-job-manifest-v1',v_manifest);
    end if;
    v_worker:=jsonb_build_object(
      'schemaVersion','truth-claim-worker-result-v2',
      'processorVersion','truth-gmail-parent-planning-v2-defect-terminal-v1',
      'acceptancePolicyVersion','gmail-candidate-acceptance-review-boundary-v1',
      'jobKind','gmail_extract_message_claims','sourceObservationId',v_job.observation_id,
      'candidateCount',0,'acceptedCount',0,'rejectedCount',0,'reviewCount',0,
      'pendingCount',0,'acceptanceDisposition','pending_acceptance_coordinator',
      'canonicalMutationCount',0,'candidates','[]'::jsonb);
    v_completion_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
      'jobId',v_job.job_id,'leaseFence',v_job.lease_fence,
      'processorVersion','truth-gmail-parent-planning-v2-defect-terminal-v1',
      'result',v_worker,'observations','[]'::jsonb,'childJobs','[]'::jsonb,
      'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value)::text,'UTF8'),'sha256'),'hex');
    v_result:=v_worker||jsonb_build_object(
      'completionHash',v_completion_hash,'resultObservationIds','[]'::jsonb,
      'childJobs','[]'::jsonb,'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value);
    v_exclusion:=jsonb_build_object(
      'schemaVersion','truth-gmail-documented-claim-defect-exclusion-v1',
      'authorityVersion','truth-gmail-parent-planning-v2-defect-terminal-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,'defectClass',v_job.defect_class,
      'parentPlanningFailureClass',v_job.parent_planning_failure_class,
      'priorJobState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'disposition','documented_claim_absence','candidateCount',0,
      'candidateManifestHash',v_manifest_hash,'underlyingEvidenceRemainsUnresolved',true,
      'laterResolutionPath','future_gmail_model_plan_parity_reconciliation_epoch',
      'productionPublicationAttempted',false);
    v_exclusion_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_exclusion),'UTF8'),'sha256'),'hex');
    v_exclusion_id:='truth-gmail-documented-claim-defect:v1:'||v_exclusion_hash;
    insert into public.truth_gmail_documented_claim_defect_exclusions(
      exclusion_id,exclusion_hash,workspace_key,connection_key,source_job_id,
      source_observation_id,defect_class,prior_job_state,prior_attempt_count,
      prior_max_attempts,prior_error_code,prior_error_detail_hash,
      candidate_manifest_hash,canonical_exclusion,canonical_result)
    values(v_exclusion_id,v_exclusion_hash,v_job.workspace_key,v_job.connection_key,
      v_job.job_id,v_job.observation_id,v_job.defect_class,v_job.state,
      v_job.attempt_count,v_job.max_attempts,v_job.last_error_code,
      v_exclusion->>'priorErrorDetailHash',v_manifest_hash,v_exclusion,v_result);
    v_membership:=jsonb_build_object(
      'schemaVersion','truth-gmail-documented-claim-defect-late-membership-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'rootBatchId',v_lineage.root_batch_id,'sourceJobId',v_job.job_id,
      'defectExclusionId',v_exclusion_id,'candidateCount',0,
      'parentPlanningFailureClass',v_job.parent_planning_failure_class,
      'candidateManifestHash',v_manifest_hash,
      'priorAcceptanceEpochId',coalesce(v_epoch.epoch_id,''),
      'priorAcceptanceReceiptHash',coalesce(v_epoch.receipt_hash,''),
      'sealedAcceptanceEpochRewritten',false,
      'underlyingEvidenceRemainsUnresolved',true,
      'productionPublicationAttempted',false);
    v_membership_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_membership),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_documented_claim_defect_late_memberships(
      membership_id,membership_hash,workspace_key,connection_key,root_batch_id,
      source_job_id,defect_exclusion_id,candidate_manifest_hash,
      prior_acceptance_epoch_id,prior_acceptance_receipt_hash,canonical_membership)
    values('truth-gmail-documented-claim-defect-late-membership:v1:'||v_membership_hash,
      v_membership_hash,v_job.workspace_key,v_job.connection_key,v_lineage.root_batch_id,
      v_job.job_id,v_exclusion_id,v_manifest_hash,coalesce(v_epoch.epoch_id,''),
      coalesce(v_epoch.receipt_hash,''),v_membership);
    update public.source_processing_jobs job set state='succeeded',
      last_error_code='',safe_error_detail='',lease_owner=null,lease_expires_at=null,
      processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1',
      result=v_result,completed_at=v_now,updated_at=v_now
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state='dead_letter' and job.lease_fence=v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.lease_owner is null and job.lease_expires_at is null;
    if not found then raise exception 'parent-planning v2 defect fence changed'
      using errcode='40001'; end if;
  end loop;
  alter table public.source_processing_jobs
    enable trigger source_processing_job_pending_acceptance_epoch;
exception when others then
  alter table public.source_processing_jobs
    enable trigger source_processing_job_pending_acceptance_epoch;
  raise;
end;
$close$;

do $verify$
begin
  if exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims' and job.state='dead_letter'
      and private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail)<>'')
    or exists(select 1
      from public.truth_gmail_documented_claim_defect_late_memberships membership
      join public.truth_gmail_documented_claim_defect_exclusions receipt
        on receipt.workspace_key=membership.workspace_key
       and receipt.exclusion_id=membership.defect_exclusion_id
      join public.candidate_claim_job_manifests manifest
        on manifest.workspace_key=membership.workspace_key
       and manifest.job_id=membership.source_job_id
      join public.source_processing_jobs job
        on job.workspace_key=membership.workspace_key
       and job.job_id=membership.source_job_id
      where receipt.canonical_exclusion->>'authorityVersion'
          ='truth-gmail-parent-planning-v2-defect-terminal-v1'
        and membership.canonical_membership->>'schemaVersion'
          ='truth-gmail-documented-claim-defect-late-membership-v1'
        and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
        and (
          job.state<>'succeeded' or manifest.candidate_count<>0
          or receipt.candidate_manifest_hash<>manifest.manifest_hash
          or membership.candidate_manifest_hash<>manifest.manifest_hash
          or membership.canonical_membership->>'sealedAcceptanceEpochRewritten'<>'false'
          or membership.canonical_membership->>'productionPublicationAttempted'<>'false'
        )) then
    raise exception 'parent-planning v2 documented defect closure is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
