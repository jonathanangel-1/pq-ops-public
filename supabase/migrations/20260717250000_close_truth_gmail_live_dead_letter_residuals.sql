-- Proof-carrying closure of the exact live Gmail dead-letter residual classes
-- observed after the hosted runtime became self-limiting.
--
-- This authority distinguishes retryable lease work from link work whose
-- durable effect already committed. It never touches attachment-review jobs,
-- accepted truth, source cuts, builds, publications, or live packet state.
--
-- The separately reviewed parent-plan job
-- eb36c52b-531f-4edf-8fa7-f8b6856ec8d0 is deliberately excluded. Its current
-- worker output fails the server's exhaustive model-range/signal residual
-- equality guard. Primary does not use the shadow-only sealed-plan resume
-- shortcut, so blind retry would deterministically reproduce the failure.
-- The separately reviewed link-context job
-- c0e31882-da9c-414f-9657-ad310bf5bac3 is also deliberately excluded. It has
-- no cutover-delta retry authorization, no resolution anchored to its source
-- observation, and no succeeded sibling resolver. Its missing-anchor context
-- is a real upstream context-builder defect, not a lost acknowledgement.

do $preflight$
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.truth_link_resolution_runs') is null
    or to_regclass('public.truth_link_resolution_context') is null
    or to_regclass('public.truth_link_candidate_proposals') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'live Gmail dead-letter closure prerequisites are missing'
      using errcode = '55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_live_dead_letter_authorizations (
  authorization_id text primary key
    check (authorization_id = 'truth-gmail-live-dead-letter:v1:' || authorization_hash),
  authorization_hash text not null unique check (authorization_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check (workspace_key = 'primary'),
  connection_key text not null check (connection_key = 'primary'),
  source_job_id uuid not null unique,
  action_kind text not null check (action_kind = any(array[
    'retry_lease_death_orphan',
    'terminal_ack_own_durable_resolution'
  ])),
  prior_state text not null check (prior_state = 'dead_letter'),
  prior_attempt_count integer not null check (prior_attempt_count >= 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  authorized_max_attempts integer not null check (
    authorized_max_attempts >= prior_max_attempts
  ),
  prior_lease_fence bigint not null check (prior_lease_fence >= 0),
  prior_error_code text not null,
  prior_error_detail_hash text not null check (prior_error_detail_hash ~ '^[0-9a-f]{64}$'),
  prior_payload_hash text not null check (prior_payload_hash ~ '^[0-9a-f]{64}$'),
  prior_result_hash text not null check (prior_result_hash ~ '^[0-9a-f]{64}$'),
  proof_kind text not null,
  proof_id text not null default '',
  proof_hash text not null default '' check (proof_hash = '' or proof_hash ~ '^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null check (jsonb_typeof(canonical_authorization) = 'object'),
  schema_version text not null check (schema_version = 'truth-gmail-live-dead-letter-authorization-v1'),
  production_publication_attempted boolean not null default false
    check (production_publication_attempted = false),
  authorized_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_key, source_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_authorization->>'schemaVersion' = schema_version),
  check (canonical_authorization->>'workspaceKey' = workspace_key),
  check (canonical_authorization->>'connectionKey' = connection_key),
  check (canonical_authorization->>'sourceJobId' = source_job_id::text),
  check (canonical_authorization->>'actionKind' = action_kind),
  check (canonical_authorization->>'priorState' = prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer = prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer = prior_max_attempts),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer = authorized_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint = prior_lease_fence),
  check (canonical_authorization->>'priorErrorCode' = prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash' = prior_error_detail_hash),
  check (canonical_authorization->>'priorPayloadHash' = prior_payload_hash),
  check (canonical_authorization->>'priorResultHash' = prior_result_hash),
  check (canonical_authorization->>'proofKind' = proof_kind),
  check (canonical_authorization->>'proofId' = proof_id),
  check (canonical_authorization->>'proofHash' = proof_hash),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
);

drop trigger if exists truth_gmail_live_dead_letter_authorizations_immutable
  on public.truth_gmail_live_dead_letter_authorizations;
create trigger truth_gmail_live_dead_letter_authorizations_immutable
before update or delete on public.truth_gmail_live_dead_letter_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_gmail_live_dead_letter_authorizations enable row level security;
alter table public.truth_gmail_live_dead_letter_authorizations force row level security;
revoke all on table public.truth_gmail_live_dead_letter_authorizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_gmail_live_dead_letter_authorizations to service_role;

create index if not exists truth_gmail_live_dead_letter_authorizations_action_idx
  on public.truth_gmail_live_dead_letter_authorizations(
    workspace_key, connection_key, action_kind, source_job_id
  );

do $close_residuals$
declare
  v_job public.source_processing_jobs%rowtype;
  v_run public.truth_link_resolution_runs%rowtype;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_action text;
  v_proof_kind text;
  v_proof_id text;
  v_proof_hash text;
  v_authorized_max integer;
  v_inserted integer;
  v_updated integer;
  v_lease_count integer := 0;
  v_collision_count integer := 0;
  v_named_present integer;
  v_collision_job constant uuid := 'edccf499-fa92-4b9e-9fc2-e60ebf9e0e06'::uuid;
  v_anchor_job constant uuid := 'c0e31882-da9c-414f-9657-ad310bf5bac3'::uuid;
  v_model_job constant uuid := 'eb36c52b-531f-4edf-8fa7-f8b6856ec8d0'::uuid;
begin
  perform private.truth_source_cut_mutation_lock('primary');

  select count(*)::integer into v_named_present
  from public.source_processing_jobs job
  where job.workspace_key='primary' and job.connection_key='primary'
    and job.state='dead_letter'
    and job.job_id=v_collision_job;
  if v_named_present not in (0,1) then
    raise exception 'named live Gmail collision authority is invalid: % jobs',
      v_named_present using errcode='55000';
  end if;
  if v_named_present=1 and not exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.state='dead_letter' and job.job_id=v_model_job
      and job.job_kind='gmail_extract_message_claims'
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb = jsonb_build_object(
        'schemaVersion','truth-gmail-parent-planning-failure-v2',
        'errorCode','TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
        'underlyingCode','TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
        'underlyingMessage','seal Gmail parent extraction plan failed: sealed Gmail model ranges and signals are not the exhaustive current-source residual',
        'postgresCode','23514',
        'postgresMessage','sealed Gmail model ranges and signals are not the exhaustive current-source residual',
        'postgresDetail','',
        'jobKind','gmail_extract_message_claims'
      )
  ) then
    raise exception 'excluded exhaustive-residual model-plan finding drifted'
      using errcode='55000';
  end if;
  if v_named_present=1 and not exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.state='dead_letter' and job.job_id=v_anchor_job
      and job.job_kind='gmail_resolve_entity_links'
      and job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth link context omitted its anchor' in job.safe_error_detail)>0
      and not exists(select 1 from public.truth_link_resolution_runs run
        where run.workspace_key=job.workspace_key and run.job_id=job.job_id)
      and not exists(select 1 from public.source_processing_jobs sibling
        where sibling.workspace_key=job.workspace_key
          and sibling.connection_key=job.connection_key
          and sibling.job_kind=job.job_kind
          and sibling.observation_id=job.observation_id
          and sibling.job_id<>job.job_id and sibling.state='succeeded')
  ) then
    raise exception 'excluded anchor-omission context finding drifted'
      using errcode='55000';
  end if;
  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.state='dead_letter'
      and not (
        (job.job_kind='gmail_extract_message_claims'
          and job.last_error_code='LEASE_EXPIRED'
          and job.safe_error_detail=
            'The prior processing lease expired before acknowledgement.')
        or job.job_id=any(array[v_collision_job,v_anchor_job,v_model_job])
      )
  ) then
    raise exception 'primary Gmail dead-letter exists outside the lease class, link pair, and excluded model finding'
      using errcode='55000';
  end if;

  for v_job in
    select job.*
    from public.source_processing_jobs job
    where job.workspace_key = 'primary'
      and job.source_system = 'gmail'
      and job.connection_key = 'primary'
      and job.job_kind = 'gmail_extract_message_claims'
      and job.state = 'dead_letter'
      and job.last_error_code = 'LEASE_EXPIRED'
      and job.safe_error_detail =
        'The prior processing lease expired before acknowledgement.'
      and job.lease_owner is null
      and job.lease_expires_at is null
      and job.completed_at is not null
      and job.result = '{}'::jsonb
      and not exists (
        select 1 from public.truth_gmail_live_dead_letter_authorizations auth
        where auth.source_job_id = job.job_id
      )
    order by job.job_id
    for update of job
  loop
    v_action := 'retry_lease_death_orphan';
    v_proof_kind := 'expired_processing_lease_without_acknowledgement';
    v_proof_id := '';
    v_proof_hash := '';
    v_authorized_max := greatest(v_job.max_attempts, v_job.attempt_count + 3);
    v_lease_count := v_lease_count + 1;

    v_body := jsonb_build_object(
      'schemaVersion','truth-gmail-live-dead-letter-authorization-v1',
      'workspaceKey','primary','connectionKey','primary',
      'sourceJobId',v_job.job_id,'jobKind',v_job.job_kind,
      'actionKind',v_action,'reasonCode','LEASE_DEATH_ORPHAN_NOT_WORK_FAILURE',
      'priorState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'authorizedMaxAttempts',v_authorized_max,
      'priorLeaseFence',v_job.lease_fence,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'priorResultHash',encode(extensions.digest(convert_to(private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex'),
      'proofKind',v_proof_kind,'proofId',v_proof_id,'proofHash',v_proof_hash,
      'productionPublicationAttempted',false
    );
    v_hash := encode(extensions.digest(convert_to(private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id := 'truth-gmail-live-dead-letter:v1:' || v_hash;
    insert into public.truth_gmail_live_dead_letter_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,action_kind,prior_state,prior_attempt_count,prior_max_attempts,
      authorized_max_attempts,prior_lease_fence,prior_error_code,
      prior_error_detail_hash,prior_payload_hash,prior_result_hash,
      proof_kind,proof_id,proof_hash,canonical_authorization,schema_version
    ) values (
      v_id,v_hash,'primary','primary',v_job.job_id,v_action,v_job.state,
      v_job.attempt_count,v_job.max_attempts,v_authorized_max,v_job.lease_fence,
      v_job.last_error_code,v_body->>'priorErrorDetailHash',v_body->>'priorPayloadHash',
      v_body->>'priorResultHash',v_proof_kind,v_proof_id,v_proof_hash,v_body,
      'truth-gmail-live-dead-letter-authorization-v1'
    );
    update public.source_processing_jobs job
    set state='retry_wait',max_attempts=v_authorized_max,available_at=clock_timestamp(),
        lease_owner=null,lease_expires_at=null,completed_at=null,
        last_error_code='GMAIL_LEASE_DEATH_ORPHAN_RETRY_AUTHORIZED',
        safe_error_detail='The expired hosted lease was proof-authorized for bounded retry; the work itself did not fail.',
        updated_at=clock_timestamp()
    where job.job_id=v_job.job_id and job.state='dead_letter'
      and job.attempt_count=v_job.attempt_count and job.max_attempts=v_job.max_attempts
      and job.lease_fence=v_job.lease_fence and job.last_error_code='LEASE_EXPIRED'
      and job.safe_error_detail='The prior processing lease expired before acknowledgement.'
      and job.result='{}'::jsonb and job.lease_owner is null and job.lease_expires_at is null;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then raise exception 'lease-death retry fence changed' using errcode='40001'; end if;
  end loop;

  -- A collided append is terminal only when this exact job owns a complete,
  -- content-valid immutable resolution. The failed acknowledgement is not
  -- allowed to replace or reinterpret that resolution.
  for v_job in
    select job.* from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_resolve_entity_links'
      and job.job_id=v_collision_job
      and job.state='dead_letter' and job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth-link job already has a different durable resolution' in job.safe_error_detail)>0
      and job.lease_owner is null and job.lease_expires_at is null
      and job.completed_at is not null and job.result='{}'::jsonb
      and not exists(select 1 from public.truth_gmail_live_dead_letter_authorizations a where a.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    select * into strict v_run from public.truth_link_resolution_runs run
    where run.workspace_key='primary' and run.job_id=v_job.job_id
      and run.anchor_observation_id=v_job.observation_id
      and run.resolution_hash=encode(extensions.digest(convert_to(run.canonical_resolution::text,'UTF8'),'sha256'),'hex')
      and run.resolution_run_id='link-resolution:v1:'||run.resolution_hash
      and run.canonical_resolution#>>'{job,jobId}'=v_job.job_id::text
      and run.canonical_resolution#>>'{job,anchorObservationId}'=v_job.observation_id
      and run.context_observation_count=(select count(*) from public.truth_link_resolution_context c where c.resolution_run_id=run.resolution_run_id)
      and run.proposal_count=(select count(*) from public.truth_link_candidate_proposals p where p.resolution_run_id=run.resolution_run_id)
      and exists(select 1 from public.truth_link_resolution_context c join public.source_observations o on o.observation_id=c.observation_id and o.content_hash=c.observation_content_hash where c.resolution_run_id=run.resolution_run_id and c.observation_id=v_job.observation_id);
    v_action := 'terminal_ack_own_durable_resolution';
    v_proof_kind := 'immutable_truth_link_resolution_run';
    v_proof_id := v_run.resolution_run_id;
    v_proof_hash := v_run.resolution_hash;
    v_authorized_max := v_job.max_attempts;
    v_collision_count := v_collision_count + 1;
    v_body := jsonb_build_object(
      'schemaVersion','truth-gmail-live-dead-letter-authorization-v1','workspaceKey','primary','connectionKey','primary',
      'sourceJobId',v_job.job_id,'jobKind',v_job.job_kind,'actionKind',v_action,
      'reasonCode','DURABLE_LINK_RESOLUTION_PRECEDED_FAILED_ACKNOWLEDGEMENT',
      'priorState',v_job.state,'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_authorized_max,'priorLeaseFence',v_job.lease_fence,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'priorResultHash',encode(extensions.digest(convert_to(private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex'),
      'proofKind',v_proof_kind,'proofId',v_proof_id,'proofHash',v_proof_hash,'productionPublicationAttempted',false);
    v_hash := encode(extensions.digest(convert_to(private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id := 'truth-gmail-live-dead-letter:v1:'||v_hash;
    insert into public.truth_gmail_live_dead_letter_authorizations values(
      v_id,v_hash,'primary','primary',v_job.job_id,v_action,v_job.state,v_job.attempt_count,v_job.max_attempts,
      v_authorized_max,v_job.lease_fence,v_job.last_error_code,v_body->>'priorErrorDetailHash',v_body->>'priorPayloadHash',
      v_body->>'priorResultHash',v_proof_kind,v_proof_id,v_proof_hash,v_body,
      'truth-gmail-live-dead-letter-authorization-v1',false,clock_timestamp(),clock_timestamp());
    update public.source_processing_jobs job set state='superseded',completed_at=clock_timestamp(),
      last_error_code='TRUTH_LINK_DURABLE_RESOLUTION_ACKNOWLEDGED',
      safe_error_detail='The immutable link resolution committed before the failed acknowledgement; this job is terminally acknowledged by proof receipt.',
      result=jsonb_build_object('schemaVersion','truth-link-terminal-acknowledgement-v1','resolutionRunId',v_run.resolution_run_id,
        'resolutionHash',v_run.resolution_hash,'disposition','durable_resolution_already_committed','productionPublicationAttempted',false),
      updated_at=clock_timestamp()
    where job.job_id=v_job.job_id and job.state='dead_letter' and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail and job.result='{}'::jsonb and job.lease_owner is null and job.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then raise exception 'durable-resolution acknowledgement fence changed' using errcode='40001'; end if;
  end loop;

  -- Production inventory guard. Lease orphans are an open class and every
  -- immutable member is individually receipted. The exceptional link/model
  -- authority remains exactly bound to the one proven collision UUID. The
  -- anchor-context and exhaustive-residual findings receive no receipts.
  if (select count(*) from public.truth_gmail_live_dead_letter_authorizations
        where source_job_id=v_collision_job) not in (0,1)
    or (select count(*) from public.truth_gmail_live_dead_letter_authorizations auth
      where (auth.source_job_id=v_collision_job
          and auth.action_kind='terminal_ack_own_durable_resolution')
        ) not in (0,1)
    or (
      (select count(*) from public.truth_gmail_live_dead_letter_authorizations
        where action_kind='terminal_ack_own_durable_resolution'
          and source_job_id=v_collision_job) not in (0,1)
      or exists(
        select 1 from public.truth_gmail_live_dead_letter_authorizations auth
        where auth.action_kind<>'retry_lease_death_orphan'
          and auth.source_job_id<>v_collision_job
      )
    ) then
      raise exception 'named live Gmail dead-letter closure inventory was not proven'
        using errcode='55000';
  end if;
end;
$close_residuals$;

analyze public.source_processing_jobs;
analyze public.truth_gmail_live_dead_letter_authorizations;

do $verify$
declare
  v_count integer;
  v_model_job constant uuid := 'eb36c52b-531f-4edf-8fa7-f8b6856ec8d0'::uuid;
  v_anchor_job constant uuid := 'c0e31882-da9c-414f-9657-ad310bf5bac3'::uuid;
begin
  select count(*) into v_count from public.source_processing_jobs job
  where job.workspace_key='primary' and job.connection_key='primary'
    and job.state='dead_letter'
    and job.job_id<>all(array[v_model_job,v_anchor_job]);
  if v_count<>0 then
    raise exception 'scoped live Gmail dead-letter residual remained after closure' using errcode='55000';
  end if;
  if not exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_id=v_anchor_job and job.state='dead_letter'
      and job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and position('truth link context omitted its anchor' in job.safe_error_detail)>0
      and not exists(select 1 from public.truth_link_resolution_runs run
        where run.workspace_key=job.workspace_key and run.job_id=job.job_id))
    and exists(select 1 from public.truth_gmail_live_dead_letter_authorizations) then
    raise exception 'excluded anchor-omission context finding was not preserved'
      using errcode='55000';
  end if;
  if not exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.job_id=v_model_job and job.state='dead_letter'
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED')
    and exists(select 1 from public.truth_gmail_live_dead_letter_authorizations) then
    raise exception 'excluded exhaustive-residual model finding was not preserved'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_live_dead_letter_authorizations
    where production_publication_attempted or canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'dead-letter closure attempted production publication' using errcode='55000';
  end if;
  if has_table_privilege('anon','public.truth_gmail_live_dead_letter_authorizations','SELECT')
    or has_table_privilege('authenticated','public.truth_gmail_live_dead_letter_authorizations','SELECT')
    or has_table_privilege('service_role','public.truth_gmail_live_dead_letter_authorizations','INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'dead-letter authorization ACL is unsafe' using errcode='55000';
  end if;
end;
$verify$;
