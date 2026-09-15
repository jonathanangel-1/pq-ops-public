-- Restore attachment-model review jobs dead-lettered under
-- TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED: a transient RPC failure
-- during completion in this afternoon's edge-proxy window, not a payload
-- or truth defect. Retry authority only, never evidence exclusion. The
-- in-flight 20260717500000 authority adds lineage discipline for this
-- class; its fences are reapply-idempotent and skip jobs already restored
-- here. Reapply-idempotent (fenced update matches zero rows on rerun).

do $restore$
declare
  v_updated integer;
begin
  update public.source_processing_jobs job
  set state='retry_wait',
    max_attempts=job.max_attempts+3,
    available_at=clock_timestamp(),
    lease_owner=null,lease_expires_at=null,completed_at=null,
    last_error_code='ATTACHMENT_MODEL_LEDGER_RPC_RETRY_AUTHORIZED',
    safe_error_detail=
      'The prior attempts failed on a transient completion-RPC error during the 2026-07-20 edge-proxy window; bounded retry is authorized.',
    updated_at=clock_timestamp()
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED'
    and job.lease_owner is null and job.lease_expires_at is null;
  get diagnostics v_updated=row_count;
  raise notice 'ledger-rpc attachment-model retries restored: %', v_updated;
end;
$restore$;
