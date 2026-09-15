-- Restore the claim producer whose final attempt failed on a CLIENT payload
-- shape defect: the commissioning lane's direct-path repair forwarded the
-- extractor's client-side identity fields (candidateClaimVersionId,
-- candidateHash) that the ledger normally strips before the RPC, so the
-- function's strict key allowlist rejected the candidate before any write.
-- No truth content was touched; the failure is fully attributable to the
-- repair client, now fixed to replicate ledger normalization. Retry
-- authority only, never evidence exclusion. Reapply-idempotent: the update
-- is fenced on the exact dead state and matches zero rows on rerun.

do $restore$
declare
  v_detail constant text := 'candidate claim contains unsupported fields';
  v_updated integer;
begin
  update public.source_processing_jobs job
  set state='retry_wait',
    max_attempts=job.max_attempts+3,
    available_at=clock_timestamp(),
    lease_owner=null,lease_expires_at=null,completed_at=null,
    last_error_code='TRUTH_CLAIM_PAYLOAD_SHAPE_RETRY_AUTHORIZED',
    safe_error_detail=
      'The prior attempt failed on a repair-client payload shape defect (client-side identity fields not stripped); the client is fixed and bounded retry is authorized.',
    updated_at=clock_timestamp()
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind=any(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims'
    ])
    and job.state='dead_letter'
    and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
    and job.safe_error_detail=v_detail
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb;
  get diagnostics v_updated=row_count;
  raise notice 'payload-shape claim retries restored: %', v_updated;
end;
$restore$;
