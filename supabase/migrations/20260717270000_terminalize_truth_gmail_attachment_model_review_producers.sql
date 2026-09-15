-- Close the source-processing producer after the attachment model ledger has
-- reached a durable review boundary. This does not decide the attachment
-- review and does not mint evidence. The immutable request plus this receipt
-- remains visible to the explicit attachment-review authority.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.gmail_attachment_model_requests') is null
    or to_regclass('public.gmail_attachment_model_attempt_dispatches') is null
    or to_regclass('public.gmail_attachment_model_attempt_outcomes') is null
    or to_regclass('public.gmail_attachment_extraction_resolutions') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure(
      'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'
    ) is null then
    raise exception 'attachment-model review terminalization prerequisites are unavailable'
      using errcode = '55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_attachment_model_job_terminalizations (
  terminalization_id text primary key check (
    terminalization_id ~ '^truth-gmail-attachment-model-job-terminalization:v1:[0-9a-f]{64}$'
  ),
  terminalization_hash text not null unique check (
    terminalization_hash ~ '^[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  source_job_id uuid not null,
  request_id text not null,
  request_state text not null check (
    request_state = any(array['review_required','outcome_unknown','succeeded'])
  ),
  disposition text not null check (disposition = any(array[
    'operator_review_remains_open',
    'provider_outcome_unknown_review_remains_open',
    'succeeded_without_completion_review_remains_open',
    'succeeded_request_completion_acknowledged'
  ])),
  prior_job_state text not null check (
    prior_job_state = any(array['queued','retry_wait'])
  ),
  prior_attempt_count integer not null check (prior_attempt_count >= 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  review_reason text not null,
  canonical_terminalization jsonb not null check (
    jsonb_typeof(canonical_terminalization) = 'object'
    and canonical_terminalization->>'productionPublicationAttempted' = 'false'
    and (
      (disposition in ('operator_review_remains_open',
          'provider_outcome_unknown_review_remains_open',
          'succeeded_without_completion_review_remains_open')
        and canonical_terminalization->>'operatorReviewResolved' = 'false'
        and canonical_terminalization->>'operationalEvidenceMinted' = 'false')
      or
      (disposition = 'succeeded_request_completion_acknowledged'
        and canonical_terminalization->>'operatorReviewResolved' = 'true'
        and canonical_terminalization->>'operationalEvidenceMinted' = 'true')
    )
  ),
  canonical_result jsonb not null check (
    jsonb_typeof(canonical_result) = 'object'
    and canonical_result->>'productionPublicationAttempted' = 'false'
    and canonical_result->>'operatorReviewResolved' =
      case when disposition='succeeded_request_completion_acknowledged'
        then 'true' else 'false' end
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, source_job_id),
  unique (workspace_key, request_id),
  foreign key (workspace_key, source_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, request_id)
    references public.gmail_attachment_model_requests(workspace_key, request_id)
    on update restrict on delete restrict,
  check (
    terminalization_id =
      'truth-gmail-attachment-model-job-terminalization:v1:' || terminalization_hash
  )
);

create index if not exists truth_gmail_attachment_model_job_terminalizations_review_idx
  on public.truth_gmail_attachment_model_job_terminalizations(
    workspace_key, connection_key, disposition, created_at, source_job_id
  );

drop trigger if exists truth_gmail_attachment_model_job_terminalizations_immutable
  on public.truth_gmail_attachment_model_job_terminalizations;
create trigger truth_gmail_attachment_model_job_terminalizations_immutable
before update or delete on public.truth_gmail_attachment_model_job_terminalizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_gmail_attachment_model_job_terminalizations
  enable row level security;
alter table public.truth_gmail_attachment_model_job_terminalizations
  force row level security;
revoke all on table public.truth_gmail_attachment_model_job_terminalizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_gmail_attachment_model_job_terminalizations
  to service_role;

-- A terminalized producer is still an unresolved operator-review target. The
-- existing explicit resolver is extended only for a receipt-bound succeeded
-- job and may later append the normal attachment resolution. It then replaces
-- the job result with the ordinary resolution result; the immutable
-- terminalization receipt preserves the true earlier timeline.
do $extend_explicit_review_resolver$
declare
  v_signature regprocedure :=
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_old_candidates text := $old$        job.state in ('queued', 'retry_wait', 'dead_letter')
        or (
          job.state = 'waiting_runtime'
          and job.last_error_code =
            'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED'
        )$old$;
  v_new_candidates text := $new$        job.state in ('queued', 'retry_wait', 'dead_letter')
        or (
          job.state = 'waiting_runtime'
          and job.last_error_code =
            'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED'
        )
        or (
          job.state = 'succeeded'
          and exists (
            select 1
            from public.truth_gmail_attachment_model_job_terminalizations terminalization
            where terminalization.workspace_key = job.workspace_key
              and terminalization.source_job_id = job.job_id
              and terminalization.disposition in (
                'operator_review_remains_open',
                'provider_outcome_unknown_review_remains_open',
                'succeeded_without_completion_review_remains_open'
              )
              and terminalization.canonical_terminalization->>'operatorReviewResolved' = 'false'
              and not exists (
                select 1
                from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key = job.workspace_key
                  and resolution.review_job_id = job.job_id
              )
          )
        )$new$;
  v_old_exact text := $old$      job.state in ('queued', 'retry_wait', 'dead_letter')
      or (
        job.state = 'waiting_runtime'
        and job.last_error_code =
          'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED'
      )$old$;
  v_new_exact text := $new$      job.state in ('queued', 'retry_wait', 'dead_letter')
      or (
        job.state = 'waiting_runtime'
        and job.last_error_code =
          'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED'
      )
      or (
        job.state = 'succeeded'
        and exists (
          select 1
          from public.truth_gmail_attachment_model_job_terminalizations terminalization
          where terminalization.workspace_key = job.workspace_key
            and terminalization.source_job_id = job.job_id
            and terminalization.disposition in (
              'operator_review_remains_open',
              'provider_outcome_unknown_review_remains_open',
              'succeeded_without_completion_review_remains_open'
            )
            and terminalization.canonical_terminalization->>'operatorReviewResolved' = 'false'
            and not exists (
              select 1
              from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key = job.workspace_key
                and resolution.review_job_id = job.job_id
            )
        )
      )$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_attachment_model_job_terminalizations terminalization' in
      v_definition) = 0 then
    if position(v_old_candidates in v_definition) = 0
      or position(v_old_exact in v_definition) = 0 then
      raise exception 'attachment review resolver state matcher differs from predecessor'
        using errcode = '23514';
    end if;
    v_definition := replace(v_definition, v_old_candidates, v_new_candidates);
    v_definition := replace(v_definition, v_old_exact, v_new_exact);
    if position('truth_gmail_attachment_model_job_terminalizations terminalization' in
        v_definition) = 0 then
      raise exception 'attachment review resolver state extension was incomplete'
        using errcode = '23514';
    end if;
    execute v_definition;
  end if;
end;
$extend_explicit_review_resolver$;

-- The request state transition guard already admits in_flight ->
-- outcome_unknown/review_required/succeeded. The migration adopts only exact
-- live-mailbox rows and records the receipt before changing the job.
do $terminalize_live_attachment_model_jobs$
declare
  v_row record;
  v_request_state text;
  v_disposition text;
  v_review_reason text;
  v_terminalization jsonb;
  v_hash text;
  v_id text;
  v_result jsonb;
  v_now timestamptz;
begin
  for v_row in
    select
      job.job_id, job.state as prior_job_state, job.attempt_count,
      job.max_attempts, job.observation_id, job.lease_owner,
      job.lease_expires_at, request.request_id, request.state as request_state,
      request.review_reason, request.completion_observation_id,
      request.completion_claim_job_id, request.completion_resolution_id,
      request.completion_receipt_hash,
      (select count(*)::integer
       from public.gmail_attachment_model_attempt_outcomes outcome
       where outcome.workspace_key=request.workspace_key
         and outcome.request_id=request.request_id) as outcome_count,
      (select outcome.classification
       from public.gmail_attachment_model_attempt_outcomes outcome
       where outcome.workspace_key=request.workspace_key
         and outcome.request_id=request.request_id
       order by outcome.attempt_number desc limit 1) as outcome_classification
    from public.source_processing_jobs job
    join public.gmail_attachment_model_requests request
      on request.workspace_key=job.workspace_key
     and request.source_job_id=job.job_id
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state in ('queued','retry_wait')
      and job.lease_owner is null
      and job.lease_expires_at is null
      and request.connection_key='primary'
      and request.state in ('review_required','in_flight','succeeded')
      and not exists (
        select 1 from public.truth_gmail_attachment_model_job_terminalizations existing
        where existing.workspace_key=job.workspace_key
          and existing.source_job_id=job.job_id
      )
    order by job.job_id
    for update of job, request
  loop
    v_now := clock_timestamp();
    v_request_state := v_row.request_state;
    v_review_reason := coalesce(nullif(v_row.review_reason,''), '');

    if v_row.request_state='in_flight' then
      if v_row.outcome_count=0 then
        -- A dispatch may have crossed the provider wire. Never send it again.
        update public.gmail_attachment_model_requests request
        set state='outcome_unknown',
            review_reason='DISPATCH_REPLAY_OUTCOME_UNKNOWN',
            provider_finalized_at=coalesce(request.provider_finalized_at,v_now),
            updated_at=v_now
        where request.workspace_key='primary'
          and request.request_id=v_row.request_id
          and request.state='in_flight';
        v_request_state := 'outcome_unknown';
        v_review_reason := 'DISPATCH_REPLAY_OUTCOME_UNKNOWN';
      elsif v_row.outcome_count=1
        and v_row.outcome_classification='succeeded'
        and v_row.completion_receipt_hash is not null then
        update public.gmail_attachment_model_requests request
        set state='succeeded', updated_at=v_now
        where request.workspace_key='primary'
          and request.request_id=v_row.request_id
          and request.state='in_flight';
        v_request_state := 'succeeded';
      else
        raise exception 'in-flight attachment request has an unadoptable outcome: %',
          v_row.request_id using errcode='23514';
      end if;
    end if;

    if v_request_state='succeeded' then
      if v_row.completion_observation_id is not null
        and v_row.completion_claim_job_id is not null
        and v_row.completion_resolution_id is not null
        and v_row.completion_receipt_hash is not null then
        v_disposition := 'succeeded_request_completion_acknowledged';
        v_review_reason := 'SUCCEEDED_REQUEST_COMPLETION_ACK_LOST';
      elsif v_row.completion_observation_id is null
        and v_row.completion_claim_job_id is null
        and v_row.completion_resolution_id is null
        and v_row.completion_receipt_hash is null
        and v_row.outcome_count=1
        and v_row.outcome_classification='succeeded' then
        -- The paid provider outcome committed, but the killed worker never
        -- appended extracted evidence. Response bytes are not retained, so
        -- completion cannot be replayed honestly. Raw evidence stays queued
        -- for the explicit human attachment-review authority.
        v_disposition := 'succeeded_without_completion_review_remains_open';
        v_review_reason := 'PAID_MODEL_EXTRACTION_LOST_BEFORE_EVIDENCE_COMPLETION';
      else
        raise exception 'succeeded attachment request has partial or ambiguous completion proof: %',
          v_row.request_id using errcode='23514';
      end if;
    elsif v_request_state='outcome_unknown' then
      v_disposition := 'provider_outcome_unknown_review_remains_open';
    else
      v_disposition := 'operator_review_remains_open';
    end if;

    v_terminalization := jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-model-job-terminalization-v1',
      'authorityVersion','truth-gmail-attachment-model-review-producer-terminalization-v1',
      'workspaceKey','primary','connectionKey','primary',
      'jobId',v_row.job_id,'requestId',v_row.request_id,
      'requestState',v_request_state,'disposition',v_disposition,
      'reviewReason',v_review_reason,
      'priorJobState',v_row.prior_job_state,
      'priorAttemptCount',v_row.attempt_count,
      'priorMaxAttempts',v_row.max_attempts,
      'operatorReviewResolved',(v_disposition='succeeded_request_completion_acknowledged'),
      'operationalEvidenceMinted',(v_disposition='succeeded_request_completion_acknowledged'),
      'productionPublicationAttempted',false
    );
    v_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_terminalization),'UTF8'
    ),'sha256'),'hex');
    v_id := 'truth-gmail-attachment-model-job-terminalization:v1:' || v_hash;
    v_result := jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-model-review-boundary-result-v1',
      'terminalizationId',v_id,'terminalizationHash',v_hash,
      'requestId',v_row.request_id,'requestState',v_request_state,
      'reviewReason',v_review_reason,'disposition',v_disposition,
      'operatorReviewResolved',(v_disposition='succeeded_request_completion_acknowledged'),
      'operationalEvidenceMinted',(v_disposition='succeeded_request_completion_acknowledged'),
      'productionPublicationAttempted',false
    );

    insert into public.truth_gmail_attachment_model_job_terminalizations(
      terminalization_id,terminalization_hash,workspace_key,connection_key,
      source_job_id,request_id,request_state,disposition,prior_job_state,
      prior_attempt_count,prior_max_attempts,review_reason,
      canonical_terminalization,canonical_result
    ) values (
      v_id,v_hash,'primary','primary',v_row.job_id,v_row.request_id,
      v_request_state,v_disposition,v_row.prior_job_state,v_row.attempt_count,
      v_row.max_attempts,v_review_reason,v_terminalization,v_result
    );

    update public.source_processing_jobs job
    set state='succeeded', lease_owner=null, lease_expires_at=null,
        last_error_code='', safe_error_detail='',
        processor_version='truth-gmail-attachment-model-review-boundary-v1',
        result=v_result, updated_at=v_now, completed_at=v_now
    where job.workspace_key='primary' and job.job_id=v_row.job_id
      and job.state=v_row.prior_job_state
      and job.lease_owner is null and job.lease_expires_at is null;
    if not found then
      raise exception 'attachment review producer changed during terminalization: %',
        v_row.job_id using errcode='40001';
    end if;
  end loop;
end;
$terminalize_live_attachment_model_jobs$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_attachment_model_job_terminalizations terminalization' in
      v_definition)=0
    or exists (
      select 1
      from public.source_processing_jobs job
      join public.gmail_attachment_model_requests request
        on request.workspace_key=job.workspace_key
       and request.source_job_id=job.job_id
      where job.workspace_key='primary' and job.source_system='gmail'
        and job.connection_key='primary'
        and job.job_kind='gmail_review_attachment_extraction'
        and job.state in ('queued','retry_wait')
        and job.lease_owner is null and job.lease_expires_at is null
        and request.connection_key='primary'
        and request.state in ('review_required','in_flight','succeeded')
    )
    or exists (
      select 1
      from public.truth_gmail_attachment_model_job_terminalizations terminalization
      join public.source_processing_jobs job
        on job.workspace_key=terminalization.workspace_key
       and job.job_id=terminalization.source_job_id
      where job.state<>'succeeded'
        or job.result->>'terminalizationId'<>terminalization.terminalization_id
        or terminalization.canonical_terminalization->>'productionPublicationAttempted'<>'false'
        or terminalization.canonical_terminalization->>'operatorReviewResolved'<>
          case when terminalization.disposition=
            'succeeded_request_completion_acknowledged' then 'true' else 'false' end
    ) then
    raise exception 'attachment-model review producer terminalization verification failed'
      using errcode='23514';
  end if;
end;
$verify$;
