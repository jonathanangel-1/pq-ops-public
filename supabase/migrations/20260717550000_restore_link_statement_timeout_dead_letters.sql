-- Restore entity-link jobs dead-lettered on statement timeouts during the
-- pre-440000 era: both their failing statements (context load and
-- resolution append) ran the O(n^2) UTF-16 span matcher replaced by
-- 20260717440000, so their retries were doomed then and are trivial now.
-- Retry authority only, never evidence exclusion. Reapply-idempotent.

do $restore$
declare
  v_updated integer;
begin
  update public.source_processing_jobs job
  set state='retry_wait',
    max_attempts=job.max_attempts+3,
    available_at=clock_timestamp(),
    lease_owner=null,lease_expires_at=null,completed_at=null,
    last_error_code='TRUTH_LINK_STATEMENT_TIMEOUT_RETRY_AUTHORIZED',
    safe_error_detail=
      'The prior attempts ran the quadratic span matcher (fixed in 20260717440000); bounded retry is authorized.',
    updated_at=clock_timestamp()
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_resolve_entity_links'
    and job.state='dead_letter'
    and job.last_error_code='TRUTH_LINK_JOB_FAILED'
    and (job.safe_error_detail='append truth-link resolution failed: canceling statement due to statement timeout'
      or job.safe_error_detail='load truth-link worker context failed: canceling statement due to statement timeout')
    and job.lease_owner is null and job.lease_expires_at is null;
  get diagnostics v_updated=row_count;
  raise notice 'link statement-timeout retries restored: %', v_updated;
end;
$restore$;
