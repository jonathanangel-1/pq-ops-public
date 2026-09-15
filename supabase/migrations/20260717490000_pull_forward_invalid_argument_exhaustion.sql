-- 20260717490000_pull_forward_invalid_argument_exhaustion.sql
--
-- Scheduling authority only — no state, attempt, or content mutation.
--
-- The 20260717470000 restoration gave the invalid-argument attachment
-- review class bounded retries under the fixed adapter. Live retries show
-- the provider still rejects these payloads (the unsupported-mime family):
-- they fail fast and free, and the correct terminal path is exhaustion ->
-- dead_letter -> 20260717480000 auto-classification with receipts. The
-- 600s retry backoff only delays that inevitability while the acceptance
-- chain head-waits. Pull the retry windows to now for exactly this class.
-- Reapply-idempotent and intended to be reapplied until the class drains.

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
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='retry_wait'
    and job.last_error_code in (
      'ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
      'OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    )
    and job.available_at>clock_timestamp();
  get diagnostics v_updated=row_count;
  raise notice 'invalid-argument exhaustion pulls: %', v_updated;
end;
$pull$;
