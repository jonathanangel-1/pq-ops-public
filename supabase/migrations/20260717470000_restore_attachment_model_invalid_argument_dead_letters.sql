-- Restore attachment-model review jobs dead-lettered under the
-- OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT class: the provider
-- rejected the extraction request while the adapter still sent the
-- unsupported `temperature` parameter (removed in 20779b05, proven by the
-- 820-job post-fix restoration run). Fresh crops of this class exhausted
-- their attempts under the broken adapter; the fixed adapter deserves a
-- real attempt before any exclusion. Retry authority only, never evidence
-- exclusion. Reapply-idempotent: fenced update matches zero rows on rerun.

do $restore$
declare
  v_updated integer;
begin
  update public.source_processing_jobs job
  set state='retry_wait',
    max_attempts=job.max_attempts+3,
    available_at=clock_timestamp(),
    lease_owner=null,lease_expires_at=null,completed_at=null,
    last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    safe_error_detail=
      'The prior attempts ran under the adapter that sent the unsupported temperature parameter; the adapter is fixed and bounded retry is authorized.',
    updated_at=clock_timestamp()
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='dead_letter'
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and job.lease_owner is null and job.lease_expires_at is null;
  get diagnostics v_updated=row_count;
  raise notice 'invalid-argument attachment-model retries restored: %', v_updated;
end;
$restore$;
