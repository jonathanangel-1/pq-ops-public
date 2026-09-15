-- A bounded claim-planning refusal is an operator-review obligation, not a
-- retryable extraction failure. Seal the exact empty candidate set, complete
-- the producer honestly, and let the existing acceptance trigger append its
-- zero-candidate epoch membership. No claim, decision, or publication is made.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regprocedure('private.create_pending_acceptance_epoch_v1()') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'attachment claim-planning review prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_claim_planning_reviews (
  review_obligation_id text primary key check (
    review_obligation_id ~ '^truth-gmail-attachment-claim-planning-review:v1:[0-9a-f]{64}$'
  ),
  obligation_hash text not null unique check (obligation_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  source_job_id uuid not null,
  source_observation_id text not null,
  prior_job_state text not null check (
    prior_job_state=any(array['queued','retry_wait','waiting_runtime','dead_letter'])
  ),
  prior_attempt_count integer not null check (prior_attempt_count>=0),
  prior_max_attempts integer not null check (prior_max_attempts>0),
  prior_error_code text not null check (
    prior_error_code='GMAIL_CLAIM_PLANNING_REVIEW_REQUIRED'
  ),
  status text not null default 'open' check (status='open'),
  candidate_manifest_hash text not null check (candidate_manifest_hash~'^[0-9a-f]{64}$'),
  canonical_obligation jsonb not null check (
    jsonb_typeof(canonical_obligation)='object'
    and canonical_obligation->>'operatorReviewResolved'='false'
    and canonical_obligation->>'candidateCount'='0'
    and canonical_obligation->>'productionPublicationAttempted'='false'
  ),
  canonical_result jsonb not null check (jsonb_typeof(canonical_result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,source_job_id),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check (review_obligation_id=
    'truth-gmail-attachment-claim-planning-review:v1:'||obligation_hash)
);

drop trigger if exists truth_gmail_attachment_claim_planning_reviews_immutable
  on public.truth_gmail_attachment_claim_planning_reviews;
create trigger truth_gmail_attachment_claim_planning_reviews_immutable
before update or delete on public.truth_gmail_attachment_claim_planning_reviews
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_attachment_claim_planning_reviews enable row level security;
alter table public.truth_gmail_attachment_claim_planning_reviews force row level security;
revoke all on table public.truth_gmail_attachment_claim_planning_reviews
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_attachment_claim_planning_reviews
  to service_role;

do $close_review_gated_claim_producers$
declare
  v_job record;
  v_manifest jsonb;
  v_manifest_hash text;
  v_result jsonb;
  v_worker_result jsonb;
  v_completion_hash text;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_obligation jsonb;
  v_hash text;
  v_id text;
  v_now timestamptz;
begin
  for v_job in
    select job.*, observation.content_hash
    from public.source_processing_jobs job
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_attachment_claims'
      and job.state in ('queued','retry_wait','waiting_runtime','dead_letter')
      and job.lease_owner is null and job.lease_expires_at is null
      and job.last_error_code='GMAIL_CLAIM_PLANNING_REVIEW_REQUIRED'
      and job.result='{}'::jsonb
      and not exists (
        select 1 from public.candidate_claim_job_lineage lineage
        where lineage.job_id=job.job_id
      )
      and not exists (
        select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
      )
      and not exists (
        select 1 from public.truth_pending_acceptance_epoch_manifests member
        where member.workspace_key=job.workspace_key and member.source_job_id=job.job_id
      )
      and not exists (
        select 1 from public.truth_gmail_attachment_claim_planning_reviews existing
        where existing.workspace_key=job.workspace_key
          and existing.source_job_id=job.job_id
      )
    order by job.job_id
    for update of job
  loop
    v_now:=clock_timestamp();
    v_manifest:=jsonb_build_object(
      'manifestSchemaVersion','candidate-claim-job-manifest-v1',
      'workspaceKey',v_job.workspace_key,'jobId',v_job.job_id,
      'sourceObservationId',v_job.observation_id,'candidates','[]'::jsonb
    );
    v_manifest_hash:=encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
    select * into strict v_lineage
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=v_job.workspace_key
      and lineage.job_id=v_job.job_id;
    v_worker_result:=jsonb_build_object(
      'schemaVersion','truth-claim-worker-result-v2',
      'processorVersion','truth-gmail-attachment-claim-planning-review-terminal-v1',
      'acceptancePolicyVersion','gmail-candidate-acceptance-review-boundary-v1',
      'jobKind','gmail_extract_attachment_claims',
      'sourceObservationId',v_job.observation_id,
      'candidateCount',0,'acceptedCount',0,'rejectedCount',0,'reviewCount',0,
      'pendingCount',0,'acceptanceDisposition','pending_acceptance_coordinator',
      'canonicalMutationCount',0,'candidates','[]'::jsonb
    );
    v_completion_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
      'jobId',v_job.job_id,'leaseFence',v_job.lease_fence,
      'processorVersion','truth-gmail-attachment-claim-planning-review-terminal-v1',
      'result',v_worker_result,'observations','[]'::jsonb,'childJobs','[]'::jsonb,
      'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value
    )::text,'UTF8'),'sha256'),'hex');
    v_result:=v_worker_result||jsonb_build_object(
      'completionHash',v_completion_hash,
      'resultObservationIds','[]'::jsonb,'childJobs','[]'::jsonb,
      'rootBatchId',v_lineage.root_batch_id,
      'sourceCursorVersion',v_lineage.source_cursor_version,
      'sourceCursorValue',v_lineage.source_cursor_value
    );
    v_obligation:=jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-claim-planning-review-obligation-v1',
      'authorityVersion','truth-gmail-attachment-claim-planning-review-terminal-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.content_hash,
      'priorJobState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,
      'priorErrorCode',v_job.last_error_code,
      'disposition','claim_planning_review_gated',
      'candidateCount',0,'candidateManifestHash',v_manifest_hash,
      'operatorReviewResolved',false,
      'laterResolutionPath','resolve_gmail_attachment_extraction_then_later_source_epoch',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_obligation),'UTF8'
    ),'sha256'),'hex');
    v_id:='truth-gmail-attachment-claim-planning-review:v1:'||v_hash;

    insert into public.candidate_claim_job_manifests(
      job_id,workspace_key,source_observation_id,candidate_count,
      manifest_hash,manifest_schema_version,canonical_manifest
    ) values (
      v_job.job_id,v_job.workspace_key,v_job.observation_id,0,
      v_manifest_hash,'candidate-claim-job-manifest-v1',v_manifest
    );
    insert into public.truth_gmail_attachment_claim_planning_reviews(
      review_obligation_id,obligation_hash,workspace_key,connection_key,
      source_job_id,source_observation_id,prior_job_state,prior_attempt_count,
      prior_max_attempts,prior_error_code,candidate_manifest_hash,
      canonical_obligation,canonical_result
    ) values (
      v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
      v_job.observation_id,v_job.state,v_job.attempt_count,v_job.max_attempts,
      v_job.last_error_code,v_manifest_hash,v_obligation,v_result
    );
    update public.source_processing_jobs job
    set state='succeeded',lease_owner=null,lease_expires_at=null,
        last_error_code='',safe_error_detail='',
        processor_version='truth-gmail-attachment-claim-planning-review-terminal-v1',
        result=v_result,updated_at=v_now,completed_at=v_now
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state=v_job.state and job.last_error_code=v_job.last_error_code
      and job.lease_owner is null and job.lease_expires_at is null;
    if not found then
      raise exception 'attachment claim-planning review job changed during closure: %',
        v_job.job_id using errcode='40001';
    end if;
  end loop;
end;
$close_review_gated_claim_producers$;

do $verify$
begin
  if exists (
    select 1
    from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_attachment_claims'
      and job.state in ('queued','retry_wait','waiting_runtime','dead_letter')
      and job.lease_owner is null and job.lease_expires_at is null
      and job.last_error_code='GMAIL_CLAIM_PLANNING_REVIEW_REQUIRED'
  ) or exists (
    select 1
    from public.truth_gmail_attachment_claim_planning_reviews review
    join public.source_processing_jobs job
      on job.workspace_key=review.workspace_key and job.job_id=review.source_job_id
    left join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=review.workspace_key and manifest.job_id=review.source_job_id
    left join public.truth_pending_acceptance_epoch_manifests member
      on member.workspace_key=review.workspace_key and member.source_job_id=review.source_job_id
    where job.state<>'succeeded' or manifest.candidate_count<>0
      or member.candidate_count<>0
      or member.candidate_manifest_hash<>manifest.manifest_hash
      or review.canonical_obligation->>'productionPublicationAttempted'<>'false'
  ) then
    raise exception 'attachment claim-planning review frontier closure is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
