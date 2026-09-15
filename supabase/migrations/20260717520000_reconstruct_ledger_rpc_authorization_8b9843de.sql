-- 20260717520000_reconstruct_ledger_rpc_authorization_8b9843de.sql
--
-- Post-hoc authorization receipt for a race between two restorations:
-- 20260717495000 (this operator lane) restored job 8b9843de (ledger-RPC
-- dead letter, 8/8 -> max 11) minutes BEFORE 20260717500000 landed; the
-- latter's authorization-minting pass therefore found the job already in
-- retry_wait and skipped it, leaving the retries authorized in prose but
-- unreceipted in the authorization table. The job then exhausted 11/11 as
-- OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT, and the 20260717510000
-- cross-authority classifier correctly refuses without the authorization
-- row. This migration mints exactly the receipt 500000 would have minted
-- (same schema, same reason code, failure-detail hash of the envelope the
-- job carried at restoration time), then invokes the existing classifier.
-- No new authority semantics. Reapply-idempotent (not-exists fence).

do $reconstruct$
declare
  v_job public.source_processing_jobs%rowtype;
  v_detail constant text :=
    '{"schemaVersion":"truth-gmail-attachment-model-worker-failure-v1","errorCode":"TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED","productionPublicationAttempted":false}';
  v_body jsonb;
  v_hash text;
  v_classified boolean;
begin
  select * into v_job from public.source_processing_jobs job
  where job.workspace_key='primary' and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.job_id::text like '8b9843de-%'
    and job.state='dead_letter'
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and job.attempt_count=11 and job.max_attempts=11
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(select 1
      from public.truth_gmail_attachment_ledger_rpc_retry_authorizations authority
      where authority.source_job_id=job.job_id)
  for update;
  if not found then
    raise notice 'ledger-rpc authorization reconstruction: nothing to do';
    return;
  end if;
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-ledger-rpc-retry-authorization-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,'priorAttemptCount',8,
    'priorMaxAttempts',8,
    'authorizedMaxAttempts',11,
    'failureDetailHash',encode(extensions.digest(convert_to(
      v_detail,'UTF8'),'sha256'),'hex'),
    'reasonCode','ATTACHMENT_MODEL_LEDGER_RPC_TRANSIENT_RETRY_AUTHORIZED',
    'operatorIncidentClass','EDGE_PROXY_OR_COMPLETION_RPC_TRANSIENT',
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  insert into public.truth_gmail_attachment_ledger_rpc_retry_authorizations(
    authorization_id,authorization_hash,workspace_key,connection_key,
    source_job_id,prior_attempt_count,prior_max_attempts,
    authorized_max_attempts,failure_detail_hash,canonical_authorization
  ) values('truth-gmail-attachment-ledger-rpc-retry:v1:'||v_hash,v_hash,
    v_job.workspace_key,v_job.connection_key,v_job.job_id,8,8,11,
    v_body->>'failureDetailHash',v_body)
  on conflict(source_job_id) do nothing;
  v_classified:=private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(v_job.job_id);
  if not v_classified then
    raise exception 'cross-authority classifier refused after authorization reconstruction'
      using errcode='23514';
  end if;
end;
$reconstruct$;
