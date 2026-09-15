-- 20260717530000_supersede_fulfilled_acceptance_coordinator_jobs.sql
--
-- The truth_sequence_claim_acceptance_epoch coordinator jobs existed to
-- drive acceptance of their pending epochs. Those epochs were accepted
-- directly (run_truth_shadow_claim_acceptance_epoch receipts exist in
-- truth_shadow_claim_acceptance_epochs for every one), so the jobs'
-- obligations are fulfilled and the jobs are dead weight in every
-- nonterminal count, including the cutover-delta backpressure guard.
-- Supersede exactly the fulfilled ones, keyed by the pending epoch's own
-- pending_job_id and fenced on the acceptance receipt existing.
-- Reapply-idempotent (fenced update matches zero rows on rerun).

do $supersede$
declare
  v_updated integer;
begin
  update public.source_processing_jobs job
  set state='superseded',
    lease_owner=null,lease_expires_at=null,
    last_error_code='',
    safe_error_detail=
      'Superseded: the pending acceptance epoch this coordinator job guarded was accepted directly; the acceptance receipt is the authority.',
    updated_at=clock_timestamp()
  where job.workspace_key='primary'
    and job.job_kind='truth_sequence_claim_acceptance_epoch'
    and job.state='waiting_runtime'
    and exists (
      select 1
      from public.truth_pending_acceptance_epochs p
      join public.truth_shadow_claim_acceptance_epochs d
        on d.workspace_key=p.workspace_key and d.obligation_id=p.obligation_id
      where p.workspace_key=job.workspace_key
        and p.pending_job_id=job.job_id
    );
  get diagnostics v_updated=row_count;
  raise notice 'fulfilled coordinator jobs superseded: %', v_updated;
end;
$supersede$;
