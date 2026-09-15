set statement_timeout=0;
set lock_timeout=30000;
-- Complete the lifecycle of the documented missing-anchor link exclusions.
-- The 310000 receipt already made the epoch member terminal for link-manifest
-- purposes.  This authority acknowledges that durable disposition on the
-- processing job by moving it to superseded; it does not pretend a link was
-- resolved.  Unreceipted dead letters remain blocking.

do $preflight$
begin
  if to_regclass('public.truth_gmail_link_epoch_dead_member_resolutions') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'receipted dead-link terminal acknowledgement prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

-- Preserve tenant scope across the acknowledgement -> disposition receipt
-- relationship.  The receipt id is globally content-addressed, but the
-- composite key prevents a future tenant-aware caller from relying on that
-- global uniqueness as its isolation boundary.
create unique index if not exists
  truth_gmail_link_epoch_dead_member_resolutions_workspace_resolution_uidx
  on public.truth_gmail_link_epoch_dead_member_resolutions(workspace_key,resolution_id);

create table if not exists public.truth_gmail_dead_link_terminal_acknowledgements (
  acknowledgement_id text primary key check(
    acknowledgement_id='truth-gmail-dead-link-terminal-ack:v1:'||acknowledgement_hash
  ),
  acknowledgement_hash text not null unique check(acknowledgement_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  dead_member_resolution_id text not null unique,
  dead_member_resolution_hash text not null check(dead_member_resolution_hash~'^[0-9a-f]{64}$'),
  prior_state text not null check(prior_state='dead_letter'),
  terminal_state text not null check(terminal_state='superseded'),
  prior_error_code text not null check(prior_error_code='TRUTH_LINK_JOB_FAILED'),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  canonical_acknowledgement jsonb not null check(
    jsonb_typeof(canonical_acknowledgement)='object'
    and canonical_acknowledgement->>'disposition'=
      'documented_context_builder_defect_terminally_acknowledged'
    and canonical_acknowledgement->>'linkResolutionMinted'='false'
    and canonical_acknowledgement->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,dead_member_resolution_id)
    references public.truth_gmail_link_epoch_dead_member_resolutions(
      workspace_key,resolution_id
    )
    on update restrict on delete restrict,
  check(acknowledgement_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_acknowledgement),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_dead_link_terminal_acknowledgements_immutable
  on public.truth_gmail_dead_link_terminal_acknowledgements;
create trigger truth_gmail_dead_link_terminal_acknowledgements_immutable
before update or delete on public.truth_gmail_dead_link_terminal_acknowledgements
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_dead_link_terminal_acknowledgements enable row level security;
alter table public.truth_gmail_dead_link_terminal_acknowledgements force row level security;
revoke all on public.truth_gmail_dead_link_terminal_acknowledgements
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_dead_link_terminal_acknowledgements to service_role;

do $acknowledge$
declare
  v_row record;
  v_body jsonb;
  v_hash text;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_row in
    select job.*,receipt.resolution_id,receipt.resolution_hash,
      receipt.canonical_resolution
    from public.source_processing_jobs job
    join public.truth_gmail_link_epoch_dead_member_resolutions receipt
      on receipt.workspace_key=job.workspace_key
     and receipt.connection_key=job.connection_key
     and receipt.source_job_id=job.job_id
     and receipt.action_kind='exclude_missing_anchor_context_defect'
     and receipt.prior_error_code='TRUTH_LINK_JOB_FAILED'
     and receipt.prior_error_detail_hash=encode(extensions.digest(convert_to(
       job.safe_error_detail,'UTF8'),'sha256'),'hex')
     and receipt.resolution_hash=encode(extensions.digest(convert_to(
       private.truth_canonical_json_text(receipt.canonical_resolution),'UTF8'
     ),'sha256'),'hex')
     and receipt.resolution_id='gmail-link-epoch-dead-member-resolution:v1:'||
       receipt.resolution_hash
     and receipt.canonical_resolution->>'reasonCode'=
       'DOCUMENTED_LINK_CONTEXT_BUILDER_ANCHOR_OMISSION'
     and receipt.canonical_resolution->>'productionPublicationAttempted'='false'
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_resolve_entity_links'
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth link context omitted its anchor' in job.safe_error_detail)>0
      and job.lease_owner is null and job.lease_expires_at is null
    order by job.job_id
    for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-dead-link-terminal-acknowledgement-v1',
      'workspaceKey','primary','connectionKey','primary',
      'sourceJobId',v_row.job_id,
      'deadMemberResolutionId',v_row.resolution_id,
      'deadMemberResolutionHash',v_row.resolution_hash,
      'priorState','dead_letter','terminalState','superseded',
      'priorAttemptCount',v_row.attempt_count,
      'priorMaxAttempts',v_row.max_attempts,
      'priorErrorCode',v_row.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_row.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'disposition','documented_context_builder_defect_terminally_acknowledged',
      'linkResolutionMinted',false,
      'operatorReviewResolved',false,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_dead_link_terminal_acknowledgements(
      acknowledgement_id,acknowledgement_hash,workspace_key,connection_key,
      source_job_id,dead_member_resolution_id,dead_member_resolution_hash,
      prior_state,terminal_state,prior_error_code,prior_error_detail_hash,
      canonical_acknowledgement
    ) values(
      'truth-gmail-dead-link-terminal-ack:v1:'||v_hash,v_hash,'primary','primary',
      v_row.job_id,v_row.resolution_id,v_row.resolution_hash,'dead_letter',
      'superseded',v_row.last_error_code,v_body->>'priorErrorDetailHash',v_body
    ) on conflict(source_job_id) do nothing;

    if not exists(
      select 1 from public.truth_gmail_dead_link_terminal_acknowledgements ack
      where ack.workspace_key='primary' and ack.source_job_id=v_row.job_id
        and ack.dead_member_resolution_id=v_row.resolution_id
        and ack.dead_member_resolution_hash=v_row.resolution_hash
        and ack.canonical_acknowledgement is not distinct from v_body
    ) then
      raise exception 'dead-link terminal acknowledgement conflicts on replay: %',v_row.job_id
        using errcode='23505';
    end if;

    update public.source_processing_jobs
    set state='superseded',completed_at=coalesce(completed_at,clock_timestamp()),
      last_error_code='',safe_error_detail='',
      processor_version='truth-gmail-dead-link-terminal-ack-v1',
      result=jsonb_build_object(
        'schemaVersion','truth-gmail-dead-link-terminal-ack-result-v1',
        'disposition','documented_context_builder_defect_terminally_acknowledged',
        'deadMemberResolutionId',v_row.resolution_id,
        'deadMemberResolutionHash',v_row.resolution_hash,
        'terminalAcknowledgementId','truth-gmail-dead-link-terminal-ack:v1:'||v_hash,
        'terminalAcknowledgementHash',v_hash,
        'linkResolutionMinted',false,
        'productionPublicationAttempted',false
      ),updated_at=clock_timestamp()
    where workspace_key='primary' and job_id=v_row.job_id
      and state='dead_letter' and last_error_code='TRUTH_LINK_JOB_FAILED'
      and encode(extensions.digest(convert_to(safe_error_detail,'UTF8'),'sha256'),'hex')=
        v_body->>'priorErrorDetailHash';
    if not found then
      raise exception 'dead-link terminal acknowledgement lost its fenced job: %',v_row.job_id
        using errcode='40001';
    end if;
  end loop;
end;
$acknowledge$;

do $verify$
begin
  if exists(
    select 1
    from public.source_processing_jobs job
    join public.truth_gmail_link_epoch_dead_member_resolutions receipt
      on receipt.workspace_key=job.workspace_key
     and receipt.source_job_id=job.job_id
     and receipt.action_kind='exclude_missing_anchor_context_defect'
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_kind='gmail_resolve_entity_links'
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth link context omitted its anchor' in job.safe_error_detail)>0
  ) or exists(
    select 1 from public.truth_gmail_dead_link_terminal_acknowledgements ack
    join public.source_processing_jobs job
      on job.workspace_key=ack.workspace_key and job.job_id=ack.source_job_id
    where job.state<>'superseded'
      or job.result->>'deadMemberResolutionId'<>ack.dead_member_resolution_id
      or job.result->>'terminalAcknowledgementHash'<>ack.acknowledgement_hash
      or ack.canonical_acknowledgement->>'productionPublicationAttempted'<>'false'
  ) then
    raise exception 'receipted dead-link terminal acknowledgement is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
