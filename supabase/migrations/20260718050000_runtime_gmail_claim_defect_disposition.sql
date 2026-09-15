-- Historical migrations closed exact Gmail parent-planning defects only once.
-- Make that receipt-bound zero-candidate disposition available to the hosted
-- acceptance coordinator for identical post-migration jobs.

create or replace function private.reconcile_truth_gmail_claim_defects_v1(
  p_workspace_key text,p_connection_key text,p_limit integer,p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job record;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_epoch public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_pending public.truth_pending_acceptance_epochs%rowtype;
  v_manifest_row public.candidate_claim_job_manifests%rowtype;
  v_exclusion_row public.truth_gmail_documented_claim_defect_exclusions%rowtype;
  v_late_row public.truth_gmail_documented_claim_defect_late_memberships%rowtype;
  v_pending_member public.truth_pending_acceptance_epoch_manifests%rowtype;
  v_manifest jsonb;
  v_manifest_hash text;
  v_worker jsonb;
  v_result jsonb;
  v_completion_hash text;
  v_exclusion jsonb;
  v_exclusion_hash text;
  v_exclusion_id text;
  v_membership jsonb;
  v_membership_hash text;
  v_obligation jsonb;
  v_obligation_hash text;
  v_obligation_id text;
  v_dedupe_key text;
  v_pending_job_id uuid;
  v_has_epoch boolean;
  v_count integer:=0;
  v_pending_count integer:=0;
  v_late_count integer:=0;
  v_items jsonb:='[]'::jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key<>'primary' or p_connection_key<>'primary'
    or p_limit is null or p_limit<1 or p_limit>10 then
    raise exception 'invalid Gmail claim-defect reconciliation request'
      using errcode='22023';
  end if;
  if to_regprocedure(
      'private.truth_gmail_parent_planning_v2_defect_class_v1(text,text)'
    ) is null
    or to_regclass('public.truth_gmail_documented_claim_defect_exclusions') is null
    or to_regclass('public.truth_gmail_documented_claim_defect_late_memberships') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'Gmail claim-defect reconciliation prerequisites are missing'
      using errcode='55000';
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  for v_job in
    select job.*,observation.content_hash,
      private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail
      ) parent_planning_failure_class,
      case private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail
      )
        when 'gmail_parent_planning_context_absent'
          then 'gmail_parent_planning_context_absent'
        else 'gmail_model_plan_seal_validation_refusal'
      end defect_class
    from public.source_processing_jobs job
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    where job.workspace_key=p_workspace_key and job.source_system='gmail'
      and job.connection_key=p_connection_key
      and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter' and job.attempt_count>=job.max_attempts
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
      and private.truth_gmail_parent_planning_v2_defect_class_v1(
        job.last_error_code,job.safe_error_detail
      )<>''
      and exists(select 1 from public.source_processing_job_lineage lineage
        where lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
          and manifest.candidate_count<>0)
      and not exists(select 1
        from public.truth_gmail_documented_claim_defect_exclusions receipt
        where receipt.workspace_key=job.workspace_key
          and receipt.source_job_id=job.job_id)
    order by job.updated_at,job.job_id
    limit p_limit
    for update of job
  loop
    select * into strict v_lineage
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=v_job.workspace_key
      and lineage.job_id=v_job.job_id;

    select * into v_epoch
    from public.truth_shadow_claim_acceptance_epochs epoch
    where epoch.workspace_key=v_job.workspace_key
      and epoch.connection_key=v_job.connection_key
      and epoch.root_batch_id=v_lineage.root_batch_id;
    v_has_epoch:=found;

    select * into v_manifest_row
    from public.candidate_claim_job_manifests manifest
    where manifest.workspace_key=v_job.workspace_key
      and manifest.job_id=v_job.job_id;
    if found then
      if v_manifest_row.candidate_count<>0
        or v_manifest_row.source_observation_id<>v_job.observation_id
        or v_manifest_row.manifest_schema_version<>'candidate-claim-job-manifest-v1'
        or v_manifest_row.canonical_manifest->>'manifestSchemaVersion'
          <>'candidate-claim-job-manifest-v1'
        or v_manifest_row.canonical_manifest->>'workspaceKey'<>v_job.workspace_key
        or v_manifest_row.canonical_manifest->>'jobId'<>v_job.job_id::text
        or v_manifest_row.canonical_manifest->>'sourceObservationId'
          <>v_job.observation_id
        or v_manifest_row.canonical_manifest->'candidates'<>'[]'::jsonb
        or v_manifest_row.manifest_hash<>encode(extensions.digest(convert_to(
          v_manifest_row.canonical_manifest::text,'UTF8'),'sha256'),'hex') then
        raise exception 'existing claim-defect manifest is not exact zero-candidate proof'
          using errcode='23514';
      end if;
      v_manifest:=v_manifest_row.canonical_manifest;
      v_manifest_hash:=v_manifest_row.manifest_hash;
    else
      v_manifest:=jsonb_build_object(
        'manifestSchemaVersion','candidate-claim-job-manifest-v1',
        'workspaceKey',v_job.workspace_key,'jobId',v_job.job_id,
        'sourceObservationId',v_job.observation_id,'candidates','[]'::jsonb
      );
      v_manifest_hash:=encode(extensions.digest(convert_to(
        v_manifest::text,'UTF8'),'sha256'),'hex');
      insert into public.candidate_claim_job_manifests(
        job_id,workspace_key,source_observation_id,candidate_count,
        manifest_hash,manifest_schema_version,canonical_manifest
      ) values(
        v_job.job_id,v_job.workspace_key,v_job.observation_id,0,
        v_manifest_hash,'candidate-claim-job-manifest-v1',v_manifest
      );
    end if;

    v_worker:=jsonb_build_object(
      'schemaVersion','truth-claim-worker-result-v2',
      'processorVersion','truth-gmail-claim-defect-runtime-v1',
      'acceptancePolicyVersion','gmail-candidate-acceptance-review-boundary-v1',
      'jobKind','gmail_extract_message_claims',
      'sourceObservationId',v_job.observation_id,
      'candidateCount',0,'acceptedCount',0,'rejectedCount',0,'reviewCount',0,
      'pendingCount',0,'acceptanceDisposition','pending_acceptance_coordinator',
      'canonicalMutationCount',0,'candidates','[]'::jsonb
    );
    v_completion_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
      'jobId',v_job.job_id,'leaseFence',v_job.lease_fence,
      'processorVersion','truth-gmail-claim-defect-runtime-v1',
      'result',v_worker,'observations','[]'::jsonb,'childJobs','[]'::jsonb,
      'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value
    )::text,'UTF8'),'sha256'),'hex');
    v_result:=v_worker||jsonb_build_object(
      'completionHash',v_completion_hash,'resultObservationIds','[]'::jsonb,
      'childJobs','[]'::jsonb,'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value
    );
    v_exclusion:=jsonb_build_object(
      'schemaVersion','truth-gmail-documented-claim-defect-exclusion-v1',
      'authorityVersion','truth-gmail-claim-defect-runtime-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,
      'defectClass',v_job.defect_class,
      'parentPlanningFailureClass',v_job.parent_planning_failure_class,
      'priorJobState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'disposition','documented_claim_absence','candidateCount',0,
      'candidateManifestHash',v_manifest_hash,
      'underlyingEvidenceRemainsUnresolved',true,
      'laterResolutionPath','future_gmail_model_plan_parity_reconciliation_epoch',
      'productionPublicationAttempted',false
    );
    v_exclusion_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_exclusion),'UTF8'),'sha256'),'hex');
    v_exclusion_id:='truth-gmail-documented-claim-defect:v1:'||v_exclusion_hash;
    insert into public.truth_gmail_documented_claim_defect_exclusions(
      exclusion_id,exclusion_hash,workspace_key,connection_key,source_job_id,
      source_observation_id,defect_class,prior_job_state,prior_attempt_count,
      prior_max_attempts,prior_error_code,prior_error_detail_hash,
      candidate_manifest_hash,canonical_exclusion,canonical_result
    ) values(
      v_exclusion_id,v_exclusion_hash,v_job.workspace_key,v_job.connection_key,
      v_job.job_id,v_job.observation_id,v_job.defect_class,v_job.state,
      v_job.attempt_count,v_job.max_attempts,v_job.last_error_code,
      v_exclusion->>'priorErrorDetailHash',v_manifest_hash,v_exclusion,v_result
    ) on conflict(workspace_key,source_job_id) do nothing;
    select * into strict v_exclusion_row
    from public.truth_gmail_documented_claim_defect_exclusions receipt
    where receipt.workspace_key=v_job.workspace_key
      and receipt.source_job_id=v_job.job_id;
    if v_exclusion_row.exclusion_id<>v_exclusion_id
      or v_exclusion_row.exclusion_hash<>v_exclusion_hash
      or v_exclusion_row.canonical_exclusion is distinct from v_exclusion
      or v_exclusion_row.canonical_result is distinct from v_result then
      raise exception 'Gmail claim-defect exclusion conflicts on replay: %',v_job.job_id
        using errcode='23505';
    end if;

    if v_has_epoch then
      v_membership:=jsonb_build_object(
        'schemaVersion','truth-gmail-documented-claim-defect-late-membership-v1',
        'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
        'rootBatchId',v_lineage.root_batch_id,'sourceJobId',v_job.job_id,
        'defectExclusionId',v_exclusion_id,'candidateCount',0,
        'parentPlanningFailureClass',v_job.parent_planning_failure_class,
        'candidateManifestHash',v_manifest_hash,
        'priorAcceptanceEpochId',v_epoch.epoch_id,
        'priorAcceptanceReceiptHash',v_epoch.receipt_hash,
        'sealedAcceptanceEpochRewritten',false,
        'underlyingEvidenceRemainsUnresolved',true,
        'productionPublicationAttempted',false
      );
      v_membership_hash:=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_membership),'UTF8'),'sha256'),'hex');
      insert into public.truth_gmail_documented_claim_defect_late_memberships(
        membership_id,membership_hash,workspace_key,connection_key,root_batch_id,
        source_job_id,defect_exclusion_id,candidate_manifest_hash,
        prior_acceptance_epoch_id,prior_acceptance_receipt_hash,canonical_membership
      ) values(
        'truth-gmail-documented-claim-defect-late-membership:v1:'||v_membership_hash,
        v_membership_hash,v_job.workspace_key,v_job.connection_key,
        v_lineage.root_batch_id,v_job.job_id,v_exclusion_id,v_manifest_hash,
        v_epoch.epoch_id,v_epoch.receipt_hash,v_membership
      ) on conflict(source_job_id) do nothing;
      select * into strict v_late_row
      from public.truth_gmail_documented_claim_defect_late_memberships membership
      where membership.workspace_key=v_job.workspace_key
        and membership.source_job_id=v_job.job_id;
      if v_late_row.membership_hash<>v_membership_hash
        or v_late_row.canonical_membership is distinct from v_membership then
        raise exception 'Gmail late claim-defect membership conflicts on replay: %',v_job.job_id
          using errcode='23505';
      end if;
      v_late_count:=v_late_count+1;
      v_items:=v_items||jsonb_build_array(jsonb_build_object(
        'rootBatchId',v_lineage.root_batch_id,'sourceJobId',v_job.job_id,
        'disposition','late_absence_membership','exclusionId',v_exclusion_id
      ));
    else
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
      ) values(
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
      ) values(
        v_pending_job_id,v_job.workspace_key,v_job.source_system,v_job.connection_key,
        v_lineage.root_batch_id,null,v_pending_job_id,
        v_lineage.source_cursor_version,v_lineage.source_cursor_value
      ) on conflict(job_id) do nothing;
      insert into public.truth_pending_acceptance_epochs(
        workspace_key,source_system,connection_key,root_batch_id,
        source_cursor_version,source_cursor_value,pending_job_id,obligation_id,
        canonical_obligation,obligation_hash,schema_version
      ) values(
        v_job.workspace_key,v_job.source_system,v_job.connection_key,
        v_lineage.root_batch_id,v_lineage.source_cursor_version,
        v_lineage.source_cursor_value,v_pending_job_id,v_obligation_id,
        v_obligation,v_obligation_hash,'pending-acceptance-epoch-obligation-v1'
      ) on conflict(workspace_key,source_system,connection_key,root_batch_id)
        do nothing;
      select * into strict v_pending
      from public.truth_pending_acceptance_epochs pending
      where pending.workspace_key=v_job.workspace_key
        and pending.source_system=v_job.source_system
        and pending.connection_key=v_job.connection_key
        and pending.root_batch_id=v_lineage.root_batch_id;
      if v_pending.obligation_id<>v_obligation_id
        or v_pending.canonical_obligation is distinct from v_obligation
        or v_pending.pending_job_id<>v_pending_job_id then
        raise exception 'Gmail claim-defect pending epoch conflicts on replay: %',v_job.job_id
          using errcode='23505';
      end if;
      v_membership:=jsonb_build_object(
        'schemaVersion','pending-acceptance-epoch-manifest-v1',
        'workspaceKey',v_job.workspace_key,'obligationId',v_obligation_id,
        'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
        'sourceObservationContentHash',v_job.content_hash,
        'candidateCount',0,'candidateManifestHash',v_manifest_hash,
        'workerResultHash',encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(v_worker),'UTF8'),'sha256'),'hex')
      );
      v_membership_hash:=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_membership),'UTF8'),'sha256'),'hex');
      insert into public.truth_pending_acceptance_epoch_manifests(
        workspace_key,obligation_id,source_job_id,source_observation_id,
        source_observation_content_hash,candidate_count,candidate_manifest_hash,
        worker_result_hash,canonical_membership,membership_hash,schema_version
      ) values(
        v_job.workspace_key,v_obligation_id,v_job.job_id,v_job.observation_id,
        v_job.content_hash,0,v_manifest_hash,v_membership->>'workerResultHash',
        v_membership,v_membership_hash,'pending-acceptance-epoch-manifest-v1'
      ) on conflict(source_job_id) do nothing;
      select * into strict v_pending_member
      from public.truth_pending_acceptance_epoch_manifests member
      where member.workspace_key=v_job.workspace_key
        and member.source_job_id=v_job.job_id;
      if v_pending_member.obligation_id<>v_obligation_id
        or v_pending_member.membership_hash<>v_membership_hash
        or v_pending_member.canonical_membership is distinct from v_membership then
        raise exception 'Gmail pending claim-defect membership conflicts on replay: %',v_job.job_id
          using errcode='23505';
      end if;
      v_pending_count:=v_pending_count+1;
      v_items:=v_items||jsonb_build_array(jsonb_build_object(
        'rootBatchId',v_lineage.root_batch_id,'sourceJobId',v_job.job_id,
        'disposition','pending_epoch_zero_candidate','exclusionId',v_exclusion_id
      ));
    end if;

    update public.source_processing_jobs job
    set state='succeeded',last_error_code='',safe_error_detail='',
      lease_owner=null,lease_expires_at=null,
      processor_version='truth-gmail-claim-defect-runtime-v1',
      result=v_result,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state='dead_letter' and job.attempt_count>=job.max_attempts
      and job.lease_fence is not distinct from v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.lease_owner is null and job.lease_expires_at is null;
    if not found then
      raise exception 'Gmail claim-defect job changed during reconciliation: %',v_job.job_id
        using errcode='40001';
    end if;
    v_count:=v_count+1;
  end loop;

  return jsonb_build_object(
    'ok',true,'reconciledCount',v_count,
    'pendingMembershipCount',v_pending_count,
    'lateMembershipCount',v_late_count,'items',v_items,
    'mutatesOperationalState',false,'publishesTruth',false,
    'performsActions',false,'productionPublicationAttempted',false
  );
end;
$function$;

-- Ordinary Gmail message-claim success still requires a sealed truthPlan. The
-- dedicated defect result has a separate receipt guard below because the
-- absence of a valid plan is the documented failure being receipted.
drop trigger if exists source_processing_job_pending_acceptance_epoch
  on public.source_processing_jobs;
create trigger source_processing_job_pending_acceptance_epoch
  after update of state,result on public.source_processing_jobs
  for each row when(
    new.state='succeeded'
    and new.result->>'schemaVersion'='truth-claim-worker-result-v2'
    and new.processor_version is distinct from 'truth-gmail-claim-defect-runtime-v1'
  ) execute function private.create_pending_acceptance_epoch_v1();

create or replace function private.guard_truth_gmail_claim_defect_result_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare v_memberships integer;
begin
  if new.state<>'succeeded'
    or new.processor_version<>'truth-gmail-claim-defect-runtime-v1' then
    return new;
  end if;
  if old.state<>'dead_letter'
    or new.result->>'schemaVersion'<>'truth-claim-worker-result-v2'
    or new.result->>'processorVersion'<>'truth-gmail-claim-defect-runtime-v1'
    or new.result->>'candidateCount'<>'0'
    or new.result->>'canonicalMutationCount'<>'0'
    or not exists(select 1
      from public.truth_gmail_documented_claim_defect_exclusions receipt
      join public.candidate_claim_job_manifests manifest
        on manifest.workspace_key=receipt.workspace_key
       and manifest.job_id=receipt.source_job_id
      where receipt.workspace_key=new.workspace_key
        and receipt.source_job_id=new.job_id
        and receipt.canonical_result is not distinct from new.result
        and receipt.canonical_exclusion->>'authorityVersion'
          ='truth-gmail-claim-defect-runtime-v1'
        and receipt.canonical_exclusion->>'productionPublicationAttempted'='false'
        and manifest.candidate_count=0
        and receipt.candidate_manifest_hash=manifest.manifest_hash
    ) then
    raise exception 'Gmail claim-defect result lacks exact immutable proof'
      using errcode='23514';
  end if;
  select
    (select count(*) from public.truth_pending_acceptance_epoch_manifests member
      where member.workspace_key=new.workspace_key and member.source_job_id=new.job_id)
    +(select count(*) from public.truth_gmail_documented_claim_defect_late_memberships member
      where member.workspace_key=new.workspace_key and member.source_job_id=new.job_id)
  into v_memberships;
  if v_memberships<>1 then
    raise exception 'Gmail claim-defect result requires exactly one acceptance membership'
      using errcode='23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists source_processing_job_documented_defect_receipt_guard
  on public.source_processing_jobs;
create trigger source_processing_job_documented_defect_receipt_guard
after update of state,result,processor_version on public.source_processing_jobs
for each row when(
  new.state='succeeded'
  and new.processor_version='truth-gmail-claim-defect-runtime-v1'
) execute function private.guard_truth_gmail_claim_defect_result_v1();

create or replace function public.reconcile_truth_gmail_claim_defects(
  p_workspace_key text,p_connection_key text,p_limit integer,p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path=''
as $function$
  select private.reconcile_truth_gmail_claim_defects_v1(
    p_workspace_key,p_connection_key,p_limit,p_sync_token
  );
$function$;

revoke all on function private.reconcile_truth_gmail_claim_defects_v1(
  text,text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function private.guard_truth_gmail_claim_defect_result_v1()
  from public,anon,authenticated,service_role;
revoke all on function public.reconcile_truth_gmail_claim_defects(
  text,text,integer,text
) from public,anon,authenticated;
grant execute on function public.reconcile_truth_gmail_claim_defects(
  text,text,integer,text
) to service_role;

do $verify$
declare v_private text; v_public text; v_trigger text; v_guard text;
begin
  select pg_get_functiondef(
    'private.reconcile_truth_gmail_claim_defects_v1(text,text,integer,text)'::regprocedure
  ) into v_private;
  select pg_get_functiondef(
    'public.reconcile_truth_gmail_claim_defects(text,text,integer,text)'::regprocedure
  ) into v_public;
  select pg_get_functiondef(
    'private.guard_truth_gmail_claim_defect_result_v1()'::regprocedure
  ) into v_guard;
  select pg_get_triggerdef(oid) into v_trigger from pg_trigger
  where tgrelid='public.source_processing_jobs'::regclass
    and tgname='source_processing_job_pending_acceptance_epoch'
    and not tgisinternal;
  if v_private is null or v_public is null or v_guard is null or v_trigger is null
    or position('attempt_count' in v_private)=0
    or position('max_attempts' in v_private)=0
    or position('truth_gmail_parent_planning_v2_defect_class_v1' in v_private)=0
    or position('truth_pending_acceptance_epoch_manifests' in v_private)=0
    or position('truth_gmail_documented_claim_defect_late_memberships' in v_private)=0
    or position('productionPublicationAttempted' in v_private)=0
    or position('private.reconcile_truth_gmail_claim_defects_v1' in v_public)=0
    or position('truth_gmail_documented_claim_defect_exclusions' in v_guard)=0
    or position('truth-gmail-claim-defect-runtime-v1' in v_trigger)=0 then
    raise exception 'Gmail claim-defect runtime reconciliation contract is incomplete'
      using errcode='23514';
  end if;
  if has_function_privilege('anon',
      'public.reconcile_truth_gmail_claim_defects(text,text,integer,text)','EXECUTE')
    or has_function_privilege('authenticated',
      'public.reconcile_truth_gmail_claim_defects(text,text,integer,text)','EXECUTE')
    or not has_function_privilege('service_role',
      'public.reconcile_truth_gmail_claim_defects(text,text,integer,text)','EXECUTE') then
    raise exception 'Gmail claim-defect runtime reconciliation ACL is unsafe'
      using errcode='42501';
  end if;
end;
$verify$;
