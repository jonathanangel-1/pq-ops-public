-- Terminalize attachment-review producers whose immutable MIME type cannot be
-- represented by the pinned OpenAI attachment request authority. No provider
-- call was attempted, no extraction or claim is asserted, and explicit human
-- review remains open. Claim manifests are deliberately untouched: this job
-- kind is a producer prerequisite, not an acceptance-manifest member.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.gmail_attachment_extraction_resolutions') is null
    or to_regprocedure(
      'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'
    ) is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'unsupported attachment-review prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_unsupported_attachment_review_terminalizations (
  terminalization_id text primary key check (
    terminalization_id ~ '^truth-gmail-unsupported-attachment-review:v1:[0-9a-f]{64}$'
  ),
  terminalization_hash text not null unique check (terminalization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  source_job_id uuid not null,
  source_observation_id text not null,
  normalized_mime_type text not null,
  prior_job_state text not null check (prior_job_state=any(array['queued','retry_wait'])),
  prior_attempt_count integer not null check (prior_attempt_count>=0),
  prior_max_attempts integer not null check (prior_max_attempts>0),
  prior_error_code text not null,
  canonical_terminalization jsonb not null check (
    jsonb_typeof(canonical_terminalization)='object'
    and canonical_terminalization->>'extractionAttempted'='false'
    and canonical_terminalization->>'operatorReviewResolved'='false'
    and canonical_terminalization->>'productionPublicationAttempted'='false'
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
  check (terminalization_id='truth-gmail-unsupported-attachment-review:v1:'||terminalization_hash)
);

drop trigger if exists truth_gmail_unsupported_attachment_review_terminalizations_immutable
  on public.truth_gmail_unsupported_attachment_review_terminalizations;
create trigger truth_gmail_unsupported_attachment_review_terminalizations_immutable
before update or delete on public.truth_gmail_unsupported_attachment_review_terminalizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_unsupported_attachment_review_terminalizations enable row level security;
alter table public.truth_gmail_unsupported_attachment_review_terminalizations force row level security;
revoke all on table public.truth_gmail_unsupported_attachment_review_terminalizations
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_unsupported_attachment_review_terminalizations
  to service_role;

-- Preserve the ordinary explicit attachment-review RPC after producer
-- terminalization. The resolution remains a later append; this receipt is not
-- rewritten and the already-sealed acceptance epoch is never reopened.
do $extend_explicit_review_resolver$
declare
  v_signature regprocedure :=
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_candidate_anchor text := $old$        )$old$;
  v_candidate_addition text := $new$        )
        or (
          job.state = 'succeeded'
          and exists (
            select 1
            from public.truth_gmail_unsupported_attachment_review_terminalizations unsupported
            where unsupported.workspace_key = job.workspace_key
              and unsupported.source_job_id = job.job_id
              and unsupported.canonical_terminalization->>'operatorReviewResolved' = 'false'
              and not exists (
                select 1 from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key=job.workspace_key
                  and resolution.review_job_id=job.job_id
              )
          )
        )$new$;
  v_exact_anchor text := $old$      )$old$;
  v_exact_addition text := $new$      )
      or (
        job.state = 'succeeded'
        and exists (
          select 1
          from public.truth_gmail_unsupported_attachment_review_terminalizations unsupported
          where unsupported.workspace_key = job.workspace_key
            and unsupported.source_job_id = job.job_id
            and unsupported.canonical_terminalization->>'operatorReviewResolved' = 'false'
            and not exists (
              select 1 from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key=job.workspace_key
                and resolution.review_job_id=job.job_id
            )
        )
      )$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_unsupported_attachment_review_terminalizations unsupported'
      in v_definition)=0 then
    -- Insert immediately after each receipt-bound succeeded-job branch already
    -- installed by 270000. The unique marker occurs once at each indentation.
    v_definition:=replace(v_definition,
      $old$              and not exists (
                select 1
                from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key = job.workspace_key
                  and resolution.review_job_id = job.job_id
              )
          )
        )$old$,
      $new$              and not exists (
                select 1
                from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key = job.workspace_key
                  and resolution.review_job_id = job.job_id
              )
          )
        )
        or (
          job.state = 'succeeded'
          and exists (
            select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations unsupported
            where unsupported.workspace_key=job.workspace_key
              and unsupported.source_job_id=job.job_id
              and unsupported.canonical_terminalization->>'operatorReviewResolved'='false'
              and not exists (
                select 1 from public.gmail_attachment_extraction_resolutions resolution
                where resolution.workspace_key=job.workspace_key
                  and resolution.review_job_id=job.job_id
              )
          )
        )$new$);
    v_definition:=replace(v_definition,
      $old$            and not exists (
              select 1
              from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key = job.workspace_key
                and resolution.review_job_id = job.job_id
            )
        )
      )$old$,
      $new$            and not exists (
              select 1
              from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key = job.workspace_key
                and resolution.review_job_id = job.job_id
            )
        )
      )
      or (
        job.state = 'succeeded'
        and exists (
          select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations unsupported
          where unsupported.workspace_key=job.workspace_key
            and unsupported.source_job_id=job.job_id
            and unsupported.canonical_terminalization->>'operatorReviewResolved'='false'
            and not exists (
              select 1 from public.gmail_attachment_extraction_resolutions resolution
              where resolution.workspace_key=job.workspace_key
                and resolution.review_job_id=job.job_id
            )
        )
      )$new$);
    if position('truth_gmail_unsupported_attachment_review_terminalizations unsupported'
        in v_definition)=0 then
      raise exception 'unsupported attachment resolver extension did not match predecessor'
        using errcode='23514';
    end if;
    execute v_definition;
  end if;
end;
$extend_explicit_review_resolver$;

do $terminalize$
declare
  v_job record;
  v_receipt jsonb;
  v_hash text;
  v_id text;
  v_result jsonb;
  v_now timestamptz;
begin
  for v_job in
    select job.*,
      lower(trim(split_part(coalesce(nullif(observation.normalized_payload->>'mimeType',''),
        'application/octet-stream'),';',1))) as mime_type
    from public.source_processing_jobs job
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state in ('queued','retry_wait')
      and job.lease_owner is null and job.lease_expires_at is null
      and lower(trim(split_part(coalesce(nullif(observation.normalized_payload->>'mimeType',''),
        'application/octet-stream'),';',1))) not like 'image/%'
      and lower(trim(split_part(coalesce(nullif(observation.normalized_payload->>'mimeType',''),
        'application/octet-stream'),';',1))) <> all(array[
        'application/pdf','application/msword','application/rtf',
        'application/vnd.ms-excel','application/vnd.ms-powerpoint',
        'application/vnd.oasis.opendocument.presentation',
        'application/vnd.oasis.opendocument.spreadsheet',
        'application/vnd.oasis.opendocument.text',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/xhtml+xml','application/xml','text/csv','text/html',
        'text/markdown','text/plain','text/tab-separated-values','text/xml'
      ])
      and not exists (
        select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations prior
        where prior.workspace_key=job.workspace_key and prior.source_job_id=job.job_id
      )
    order by job.job_id for update of job
  loop
    v_now:=clock_timestamp();
    v_receipt:=jsonb_build_object(
      'schemaVersion','truth-gmail-unsupported-attachment-review-terminalization-v1',
      'authorityVersion','truth-gmail-pinned-attachment-mime-boundary-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'jobId',v_job.job_id,'sourceObservationId',v_job.observation_id,
      'normalizedMimeType',v_job.mime_type,'priorJobState',v_job.state,
      'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
      'priorErrorCode',v_job.last_error_code,
      'disposition','unsupported_by_pinned_attachment_extraction_authority',
      'extractionAttempted',false,'operatorReviewResolved',false,
      'futureAuthority','content_sniffing_or_nested_message_lane',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_receipt),'UTF8'
    ),'sha256'),'hex');
    v_id:='truth-gmail-unsupported-attachment-review:v1:'||v_hash;
    v_result:=jsonb_build_object(
      'schemaVersion','truth-gmail-unsupported-attachment-review-result-v1',
      'terminalizationId',v_id,'terminalizationHash',v_hash,
      'normalizedMimeType',v_job.mime_type,
      'disposition','unsupported_by_pinned_attachment_extraction_authority',
      'extractionAttempted',false,'operatorReviewResolved',false,
      'productionPublicationAttempted',false
    );
    insert into public.truth_gmail_unsupported_attachment_review_terminalizations(
      terminalization_id,terminalization_hash,workspace_key,connection_key,
      source_job_id,source_observation_id,normalized_mime_type,prior_job_state,
      prior_attempt_count,prior_max_attempts,prior_error_code,
      canonical_terminalization,canonical_result
    ) values (v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
      v_job.observation_id,v_job.mime_type,v_job.state,v_job.attempt_count,
      v_job.max_attempts,v_job.last_error_code,v_receipt,v_result);
    update public.source_processing_jobs job
    set state='succeeded',lease_owner=null,lease_expires_at=null,
      last_error_code='',safe_error_detail='',
      processor_version='truth-gmail-unsupported-attachment-review-terminal-v1',
      result=v_result,updated_at=v_now,completed_at=v_now
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state=v_job.state and job.lease_owner is null and job.lease_expires_at is null;
    if not found then raise exception 'unsupported attachment review changed during closure: %',
      v_job.job_id using errcode='40001'; end if;
  end loop;
end;
$terminalize$;

do $verify$
begin
  if exists (
    select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations receipt
    join public.source_processing_jobs job
      on job.workspace_key=receipt.workspace_key and job.job_id=receipt.source_job_id
    join public.source_observations observation
      on observation.workspace_key=receipt.workspace_key
     and observation.observation_id=receipt.source_observation_id
    where job.state<>'succeeded'
      or lower(trim(split_part(coalesce(nullif(observation.normalized_payload->>'mimeType',''),
        'application/octet-stream'),';',1))) like 'image/%'
      or lower(trim(split_part(coalesce(nullif(observation.normalized_payload->>'mimeType',''),
        'application/octet-stream'),';',1)))=any(array[
        'application/pdf','application/msword','application/rtf','application/vnd.ms-excel',
        'application/vnd.ms-powerpoint','application/vnd.oasis.opendocument.presentation',
        'application/vnd.oasis.opendocument.spreadsheet','application/vnd.oasis.opendocument.text',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/xhtml+xml','application/xml','text/csv','text/html','text/markdown',
        'text/plain','text/tab-separated-values','text/xml'])
      or receipt.canonical_terminalization->>'productionPublicationAttempted'<>'false'
  ) then raise exception 'unsupported attachment review terminalization verification failed'
    using errcode='23514'; end if;
end;
$verify$;

