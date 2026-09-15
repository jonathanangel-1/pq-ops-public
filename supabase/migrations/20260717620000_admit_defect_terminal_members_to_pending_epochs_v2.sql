-- Supersede 610000's completion-envelope hash with the acceptance runtime's
-- exact extraction-only worker-result hash discipline. Admit only still-
-- pending epochs; sealed acceptance history remains immutable.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_documented_claim_defect_exclusions') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null then
    raise exception 'pending defect membership v2 prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

-- Capture only the rows this application is obligated to admit. Historical
-- memberships were minted by earlier authorities with their own valid worker-
-- result construction and must never be re-audited under this authority.
drop table if exists pg_temp.truth_gmail_pending_defect_membership_v2_cohort;
create temporary table truth_gmail_pending_defect_membership_v2_cohort(
  workspace_key text not null,
  obligation_id text not null,
  source_job_id uuid not null,
  primary key(workspace_key,obligation_id,source_job_id)
);

insert into pg_temp.truth_gmail_pending_defect_membership_v2_cohort(
  workspace_key,obligation_id,source_job_id
)
select job.workspace_key,pending.obligation_id,job.job_id
from public.source_processing_jobs job
join public.source_processing_job_lineage lineage
  on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
join public.truth_gmail_documented_claim_defect_exclusions receipt
  on receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id
 and receipt.canonical_exclusion->>'authorityVersion'
   ='truth-gmail-parent-planning-v2-defect-terminal-v1'
join public.candidate_claim_job_manifests manifest
  on manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
 and manifest.candidate_count=0
join public.truth_pending_acceptance_epochs pending
  on pending.workspace_key=job.workspace_key
 and pending.source_system=job.source_system
 and pending.connection_key=job.connection_key
 and pending.root_batch_id=lineage.root_batch_id
where job.workspace_key='primary' and job.source_system='gmail'
  and job.connection_key='primary'
  and job.job_kind='gmail_extract_message_claims'
  and job.state='succeeded'
  and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
  and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
    where epoch.workspace_key=pending.workspace_key
      and epoch.obligation_id=pending.obligation_id)
  and not exists(select 1 from public.truth_pending_acceptance_epoch_manifests membership
    where membership.workspace_key=job.workspace_key
      and membership.obligation_id=pending.obligation_id
      and membership.source_job_id=job.job_id);

do $admit$
declare
  v_job record;
  v_pending public.truth_pending_acceptance_epochs%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_worker_result jsonb;
  v_worker_result_hash text;
  v_membership jsonb;
  v_membership_hash text;
begin
  for v_job in
    select job.*,observation.content_hash,lineage.root_batch_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    join public.truth_gmail_documented_claim_defect_exclusions receipt
      on receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id
     and receipt.canonical_exclusion->>'authorityVersion'
       ='truth-gmail-parent-planning-v2-defect-terminal-v1'
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
     and manifest.candidate_count=0
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key=job.workspace_key
     and pending.source_system=job.source_system
     and pending.connection_key=job.connection_key
     and pending.root_batch_id=lineage.root_batch_id
    join pg_temp.truth_gmail_pending_defect_membership_v2_cohort cohort
      on cohort.workspace_key=job.workspace_key
     and cohort.obligation_id=pending.obligation_id
     and cohort.source_job_id=job.job_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.state='succeeded'
      and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=pending.workspace_key
          and epoch.obligation_id=pending.obligation_id)
    order by lineage.source_cursor_version,lineage.source_cursor_value,job.job_id
    for update of job
  loop
    select * into strict v_pending
    from public.truth_pending_acceptance_epochs pending
    where pending.workspace_key=v_job.workspace_key
      and pending.source_system=v_job.source_system
      and pending.connection_key=v_job.connection_key
      and pending.root_batch_id=v_job.root_batch_id;
    if exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=v_pending.workspace_key
        and epoch.obligation_id=v_pending.obligation_id) then
      raise exception 'defect membership target epoch sealed during admission'
        using errcode='40001';
    end if;
    select * into strict v_manifest
    from public.candidate_claim_job_manifests manifest
    where manifest.workspace_key=v_job.workspace_key and manifest.job_id=v_job.job_id;
    if v_manifest.candidate_count<>0
      or v_manifest.source_observation_id is distinct from v_job.observation_id
      or v_manifest.manifest_hash is distinct from encode(extensions.digest(
        convert_to(v_manifest.canonical_manifest::text,'UTF8'),'sha256'),'hex')
      or v_manifest.canonical_manifest->'candidates' is distinct from '[]'::jsonb then
      raise exception 'pending defect member lacks exact zero-candidate manifest proof'
        using errcode='23514';
    end if;
    v_worker_result:=v_job.result-array[
      'truthPlan','completionHash','resultObservationIds','childJobs',
      'rootBatchId','sourceCursorVersion','sourceCursorValue'
    ]::text[];
    if v_worker_result->>'schemaVersion'<>'truth-claim-worker-result-v2'
      or v_worker_result->>'jobKind'<>v_job.job_kind
      or v_worker_result->>'sourceObservationId'<>v_job.observation_id
      or v_worker_result->>'candidateCount'<>'0'
      or v_worker_result->>'pendingCount'<>'0'
      or v_worker_result->'candidates' is distinct from '[]'::jsonb
      or v_worker_result->>'acceptanceDisposition'<>'pending_acceptance_coordinator' then
      raise exception 'pending defect member has invalid extraction-only worker result'
        using errcode='23514';
    end if;
    v_worker_result_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_worker_result),'UTF8'),'sha256'),'hex');
    v_membership:=jsonb_build_object(
      'schemaVersion','pending-acceptance-epoch-manifest-v1',
      'workspaceKey',v_job.workspace_key,
      'obligationId',v_pending.obligation_id,
      'sourceJobId',v_job.job_id,
      'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,
      'candidateCount',0,
      'candidateManifestHash',v_manifest.manifest_hash,
      'workerResultHash',v_worker_result_hash
    );
    v_membership_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_membership),'UTF8'),'sha256'),'hex');
    insert into public.truth_pending_acceptance_epoch_manifests(
      workspace_key,obligation_id,source_job_id,source_observation_id,
      source_observation_content_hash,candidate_count,candidate_manifest_hash,
      worker_result_hash,canonical_membership,membership_hash,schema_version
    ) values(v_job.workspace_key,v_pending.obligation_id,v_job.job_id,
      v_job.observation_id,v_job.content_hash,0,v_manifest.manifest_hash,
      v_worker_result_hash,v_membership,v_membership_hash,
      'pending-acceptance-epoch-manifest-v1')
    on conflict(workspace_key,obligation_id,source_job_id) do nothing;
  end loop;
end;
$admit$;

do $verify$
begin
  if exists(select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_gmail_documented_claim_defect_exclusions receipt
      on receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id
     and receipt.canonical_exclusion->>'authorityVersion'
       ='truth-gmail-parent-planning-v2-defect-terminal-v1'
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
     and manifest.candidate_count=0
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key=job.workspace_key
     and pending.source_system=job.source_system
     and pending.connection_key=job.connection_key
     and pending.root_batch_id=lineage.root_batch_id
    join pg_temp.truth_gmail_pending_defect_membership_v2_cohort cohort
      on cohort.workspace_key=job.workspace_key
     and cohort.obligation_id=pending.obligation_id
     and cohort.source_job_id=job.job_id
    left join public.truth_pending_acceptance_epoch_manifests membership
      on membership.workspace_key=job.workspace_key
     and membership.obligation_id=pending.obligation_id
     and membership.source_job_id=job.job_id
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.state='succeeded'
      and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=pending.workspace_key
          and epoch.obligation_id=pending.obligation_id)
      and (membership.source_job_id is null
        or membership.source_observation_id is distinct from job.observation_id
        or membership.source_observation_content_hash is distinct from observation.content_hash
        or membership.candidate_count is distinct from 0
        or membership.candidate_manifest_hash is distinct from manifest.manifest_hash
        or membership.worker_result_hash is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.result-array[
            'truthPlan','completionHash','resultObservationIds','childJobs',
            'rootBatchId','sourceCursorVersion','sourceCursorValue'
          ]::text[]),'UTF8'),'sha256'),'hex')
        or membership.membership_hash is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(membership.canonical_membership),
          'UTF8'),'sha256'),'hex'))) then
    raise exception 'pending parent-planning defect membership remains incomplete'
      using errcode='23514';
  end if;
end;
$verify$;

drop table pg_temp.truth_gmail_pending_defect_membership_v2_cohort;
