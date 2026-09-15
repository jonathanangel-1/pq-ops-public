-- 20260717420000_pull_forward_stats_wipe_claim_retry.sql
--
-- Scheduling authority only — no state, attempt, or content mutation.
--
-- The 09:36 crash-restart wiped cumulative planner statistics
-- (pg_stat_user_tables showed n_live_tup=0 / last_analyze=null on
-- source_processing_jobs and candidate_claim_envelopes at 19:27 despite
-- real row counts), so every lookup inside private.append_candidate_claim
-- ran a catastrophic plan and a SINGLE candidate append exceeded the 8s
-- session budget (job 487382cf attempt 9, detail below). ANALYZE has been
-- re-run on the append path's tables and verified populated. The attempt-9
-- failure scheduled a ~2h exponential backoff; waiting it out serves no
-- purpose once the plans are sane. This pulls the retry window to now for
-- exactly the class that failed on the stats wipe. Reapply-idempotent
-- (second run matches zero rows).

do $pull$
declare
  v_updated integer;
begin
  update public.source_processing_jobs job
  set available_at=clock_timestamp(),
    updated_at=clock_timestamp()
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind=any(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims'
    ])
    and job.state='retry_wait'
    and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
    and job.safe_error_detail=
      'append candidate claim failed: canceling statement due to statement timeout'
    and job.available_at>clock_timestamp();
  get diagnostics v_updated=row_count;
  raise notice 'stats-wipe claim retries pulled forward: %', v_updated;
end;
$pull$;
