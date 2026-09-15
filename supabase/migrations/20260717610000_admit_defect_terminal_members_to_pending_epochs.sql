-- 20260717610000_admit_defect_terminal_members_to_pending_epochs.sql
--
-- 20260717600000 terminalized the parent-planning-v2 defect jobs with full
-- receipts, but its membership path covered only ACCEPTED epochs; one job
-- (f4e7adce, batch 380c9497) belongs to a batch whose acceptance epoch was
-- still PENDING, so the pending-epoch manifest row was never minted and the
-- epoch refuses CLAIM_FRONTIER_MANIFEST_INCOMPLETE at 40/41. Mint the
-- pending-acceptance manifest membership for the CLASS: succeeded jobs
-- terminalized under the v2-defect authority, holding a zero-candidate
-- manifest, whose batch has a pending epoch lacking their membership.
-- Shape and hash discipline copied exactly from 20260717370000.
-- Reapply-idempotent (not-exists fence).

do $admit$
declare
  v_job record;
  v_pending public.truth_pending_acceptance_epochs%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_membership jsonb;
  v_membership_hash text;
begin
  for v_job in
    select job.*, obs.content_hash, lineage.root_batch_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.source_observations obs
      on obs.workspace_key=job.workspace_key and obs.observation_id=job.observation_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind in ('gmail_extract_message_claims','gmail_extract_attachment_claims')
      and job.state='succeeded'
      and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
      and exists (select 1 from public.truth_gmail_documented_claim_defect_exclusions receipt
        where receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id)
      and exists (select 1 from public.truth_pending_acceptance_epochs pending
        where pending.workspace_key=job.workspace_key
          and pending.connection_key=job.connection_key
          and pending.root_batch_id=lineage.root_batch_id)
      and not exists (select 1 from public.truth_pending_acceptance_epoch_manifests member
        join public.truth_pending_acceptance_epochs pending2
          on pending2.workspace_key=member.workspace_key
         and pending2.obligation_id=member.obligation_id
        where member.workspace_key=job.workspace_key
          and member.source_job_id=job.job_id
          and pending2.root_batch_id=lineage.root_batch_id)
  loop
    select * into strict v_pending
    from public.truth_pending_acceptance_epochs pending
    where pending.workspace_key=v_job.workspace_key
      and pending.connection_key=v_job.connection_key
      and pending.root_batch_id=v_job.root_batch_id;
    select * into strict v_manifest
    from public.candidate_claim_job_manifests manifest
    where manifest.workspace_key=v_job.workspace_key and manifest.job_id=v_job.job_id;
    if v_manifest.candidate_count<>0 then
      raise exception 'defect-terminal member has a non-empty candidate manifest'
        using errcode='23514';
    end if;
    v_membership:=jsonb_build_object(
      'schemaVersion','pending-acceptance-epoch-manifest-v1',
      'workspaceKey',v_job.workspace_key,'obligationId',v_pending.obligation_id,
      'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,
      'candidateCount',0,'candidateManifestHash',v_manifest.manifest_hash,
      'workerResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex')
    );
    v_membership_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_membership),'UTF8'),'sha256'),'hex');
    insert into public.truth_pending_acceptance_epoch_manifests(
      workspace_key,obligation_id,source_job_id,source_observation_id,
      source_observation_content_hash,candidate_count,candidate_manifest_hash,
      worker_result_hash,canonical_membership,membership_hash,schema_version
    ) values (
      v_job.workspace_key,v_pending.obligation_id,v_job.job_id,v_job.observation_id,
      v_job.content_hash,0,v_manifest.manifest_hash,v_membership->>'workerResultHash',
      v_membership,v_membership_hash,'pending-acceptance-epoch-manifest-v1'
    );
    raise notice 'admitted defect-terminal member % to pending epoch %',
      left(v_job.job_id::text,8), left(v_pending.obligation_id,44);
  end loop;
end;
$admit$;
