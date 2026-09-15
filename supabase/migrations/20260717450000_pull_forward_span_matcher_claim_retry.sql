-- 20260717450000_pull_forward_span_matcher_claim_retry.sql
--
-- Scheduling authority only — no state, attempt, or content mutation.
--
-- Companion to 20260717420000 for the direct-lane detail variant: the
-- commissioning repair client calls the append RPC over the direct
-- connection, so its statement-timeout failures carry the bare Postgres
-- message without the ledger's operation prefix. The root cause (the
-- O(n^2) per-character UTF-16 span matcher) is fixed in 20260717440000
-- with regression tests; a six-hour exponential backoff serves no
-- purpose. Pull the window to now for exactly this class.
-- Reapply-idempotent (second run matches zero rows).

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
    and job.safe_error_detail='canceling statement due to statement timeout'
    and job.available_at>clock_timestamp();
  get diagnostics v_updated=row_count;
  raise notice 'span-matcher claim retries pulled forward: %', v_updated;
end;
$pull$;
