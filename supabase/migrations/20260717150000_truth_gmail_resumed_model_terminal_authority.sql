-- Close the exact ten-child Gmail model residual without rewriting an
-- immutable parent plan or weakening the generic source-processing queue.
--
-- Seven pre-070000 plans bind source time with the old millisecond rendering.
-- They cannot safely produce candidates against the current microsecond-bound
-- observation contract, so they receive a proof-carrying human-review terminal.
-- Three later plans have exact current bindings and receive an indexed stored-
-- child admission.  The same immutable ten-row authority makes claim selection
-- bounded before the expensive legacy commissioning validators are evaluated.

create schema if not exists private;

do $preflight$
declare
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_route regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_claim_definition text;
  v_route_definition text;
begin
  if v_claim is null
    or v_route is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_child_input_allowed_v2(text,text,uuid,text,text,jsonb)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.require_live_truth_model_source_job(text,uuid,text,bigint,text)'
    ) is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_jsonb_has_only_keys(jsonb,text[])') is null
    or to_regprocedure('private.truth_worker_canonical_millis(timestamptz)') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_review_intents') is null
    or to_regclass('public.truth_model_requests') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_processing_job_children') is null
    or to_regclass('public.source_observations') is null
    or to_regclass('public.source_cuts') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null then
    raise exception 'resumed Gmail model terminal authority prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(v_claim) into v_claim_definition;
  select pg_get_functiondef(v_route) into v_route_definition;
  if position('truth_shadow_gmail_model_job_allowed_v2' in v_claim_definition) = 0
    and position('truth_shadow_gmail_model_job_allowed_v3' in v_claim_definition) = 0 then
    raise exception 'Gmail model claim admission differs from the reviewed v2 contract'
      using errcode = '23514';
  end if;
  if position('truth_shadow_gmail_model_child_input_allowed_v2' in v_route_definition) = 0
    and position('truth_shadow_gmail_model_child_input_allowed_v3' in v_route_definition) = 0 then
    raise exception 'Gmail model route admission differs from the reviewed v2 contract'
      using errcode = '23514';
  end if;
end;
$preflight$;

create or replace function private.truth_shadow_gmail_old_millisecond_time_binding_v1(
  p_model_plan jsonb,
  p_captured_at timestamptz,
  p_source_recorded_at timestamptz
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare
  v_old_captured text;
  v_old_recorded text;
  v_current_captured text;
  v_current_recorded text;
begin
  if jsonb_typeof(coalesce(p_model_plan, 'null'::jsonb)) <> 'object'
    or p_captured_at is null then
    return false;
  end if;
  v_old_captured := to_char(
    date_trunc('milliseconds', p_captured_at) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_current_captured := private.truth_worker_canonical_millis(p_captured_at);
  v_old_recorded := case when p_source_recorded_at is null then null else to_char(
    date_trunc('milliseconds', p_source_recorded_at) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) end;
  v_current_recorded := case when p_source_recorded_at is null then null
    else private.truth_worker_canonical_millis(p_source_recorded_at) end;
  return p_model_plan->>'sourceCapturedAt' = v_old_captured
    and (p_model_plan->>'sourceRecordedAt') is not distinct from v_old_recorded
    and (
      p_model_plan->>'sourceCapturedAt' is distinct from v_current_captured
      or (p_model_plan->>'sourceRecordedAt') is distinct from v_current_recorded
    );
exception when others then
  return false;
end;
$function$;

create or replace function private.truth_shadow_gmail_current_source_time_binding_v1(
  p_model_plan jsonb,
  p_captured_at timestamptz,
  p_source_recorded_at timestamptz
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $function$
  select jsonb_typeof(coalesce(p_model_plan, 'null'::jsonb)) = 'object'
    and p_captured_at is not null
    and p_model_plan->>'sourceCapturedAt' =
      private.truth_worker_canonical_millis(p_captured_at)
    and (p_model_plan->>'sourceRecordedAt') is not distinct from case
      when p_source_recorded_at is null then null
      else private.truth_worker_canonical_millis(p_source_recorded_at)
    end;
$function$;

revoke all on function private.truth_shadow_gmail_old_millisecond_time_binding_v1(
  jsonb,timestamptz,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.truth_shadow_gmail_current_source_time_binding_v1(
  jsonb,timestamptz,timestamptz
) from public, anon, authenticated, service_role;

create table if not exists public.truth_shadow_gmail_resumed_model_child_authorizations (
  authorization_id text primary key check (
    authorization_id ~ '^truth-shadow-gmail-resumed-model-child:v1:[0-9a-f]{64}$'
  ),
  authorization_hash text not null unique check (
    authorization_hash ~ '^[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  parent_job_id uuid not null,
  model_child_job_id uuid not null unique,
  source_observation_id text not null,
  source_observation_content_hash text not null check (
    source_observation_content_hash ~ '^[0-9a-f]{64}$'
  ),
  extraction_plan_id text not null,
  model_plan_id text not null,
  model_plan_hash text not null check (model_plan_hash ~ '^[0-9a-f]{64}$'),
  plan_seal_hash text not null check (plan_seal_hash ~ '^[0-9a-f]{64}$'),
  parent_manifest_hash text not null check (parent_manifest_hash ~ '^[0-9a-f]{64}$'),
  predecessor_epoch_id text not null,
  predecessor_epoch_receipt_hash text not null check (
    predecessor_epoch_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  disposition text not null check (disposition = any(array[
    'model_execution', 'stale_time_binding_review'
  ])),
  sealed_source_captured_at text not null,
  canonical_source_captured_at text not null,
  sealed_source_recorded_at text,
  canonical_source_recorded_at text,
  prior_state text not null check (prior_state in ('retry_wait', 'waiting_runtime')),
  prior_attempt_count integer not null check (prior_attempt_count >= 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  prior_lease_fence bigint not null check (prior_lease_fence >= 0),
  authorized_max_attempts integer not null check (
    authorized_max_attempts >= prior_max_attempts
    and authorized_max_attempts >= prior_attempt_count + 3
  ),
  canonical_authorization jsonb not null check (
    jsonb_typeof(canonical_authorization) = 'object'
  ),
  schema_version text not null check (
    schema_version = 'truth-shadow-gmail-resumed-model-child-authorization-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  mutates_operational_state boolean not null default false check (
    mutates_operational_state = false
  ),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, authorization_id),
  unique (workspace_key, model_child_job_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, parent_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, model_child_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, extraction_plan_id)
    references public.gmail_model_extraction_plans(workspace_key, extraction_plan_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, model_plan_id)
    references public.gmail_model_extraction_plans(workspace_key, model_plan_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, predecessor_epoch_id)
    references public.truth_shadow_claim_acceptance_epochs(workspace_key, epoch_id)
    on update restrict on delete restrict,
  check (authorization_id =
    'truth-shadow-gmail-resumed-model-child:v1:' || authorization_hash),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_authorization->>'workspaceKey' = workspace_key),
  check (canonical_authorization->>'schemaVersion' = schema_version),
  check (canonical_authorization->>'sourceSystem' = source_system),
  check (canonical_authorization->>'connectionKey' = connection_key),
  check (canonical_authorization->>'rootBatchId' = root_batch_id::text),
  check ((canonical_authorization->>'sourceCursorVersion')::bigint =
    source_cursor_version),
  check (canonical_authorization->>'sourceCursorValue' = source_cursor_value),
  check (canonical_authorization->>'parentJobId' = parent_job_id::text),
  check (canonical_authorization->>'modelChildJobId' = model_child_job_id::text),
  check (canonical_authorization->>'sourceObservationId' = source_observation_id),
  check (canonical_authorization->>'sourceObservationContentHash' =
    source_observation_content_hash),
  check (canonical_authorization->>'extractionPlanId' = extraction_plan_id),
  check (canonical_authorization->>'modelPlanId' = model_plan_id),
  check (canonical_authorization->>'modelPlanHash' = model_plan_hash),
  check (canonical_authorization->>'planSealHash' = plan_seal_hash),
  check (canonical_authorization->>'parentManifestHash' = parent_manifest_hash),
  check (canonical_authorization->>'predecessorEpochId' = predecessor_epoch_id),
  check (canonical_authorization->>'predecessorEpochReceiptHash' =
    predecessor_epoch_receipt_hash),
  check (canonical_authorization->>'disposition' = disposition),
  check (canonical_authorization->>'sealedSourceCapturedAt' =
    sealed_source_captured_at),
  check (canonical_authorization->>'canonicalSourceCapturedAt' =
    canonical_source_captured_at),
  check (canonical_authorization->>'sealedSourceRecordedAt' =
    coalesce(sealed_source_recorded_at, '')),
  check (canonical_authorization->>'canonicalSourceRecordedAt' =
    coalesce(canonical_source_recorded_at, '')),
  check (canonical_authorization->>'priorState' = prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer =
    prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer =
    prior_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint =
    prior_lease_fence),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer =
    authorized_max_attempts),
  check (canonical_authorization->>'shadowOnly' = 'true'),
  check (canonical_authorization->>'mutatesOperationalState' = 'false'),
  check (canonical_authorization->>'productionEligible' = 'false'),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
  ,check (
    canonical_authorization ?& array[
      'schemaVersion','workspaceKey','sourceSystem','connectionKey','rootBatchId',
      'sourceCursorVersion','sourceCursorValue','parentJobId','modelChildJobId',
      'sourceObservationId','sourceObservationContentHash','extractionPlanId',
      'modelPlanId','modelPlanHash','planSealHash','parentManifestHash',
      'predecessorEpochId','predecessorEpochReceiptHash','disposition',
      'sealedSourceCapturedAt','canonicalSourceCapturedAt',
      'sealedSourceRecordedAt','canonicalSourceRecordedAt','priorState',
      'priorAttemptCount','priorMaxAttempts','priorLeaseFence',
      'authorizedMaxAttempts','shadowOnly','mutatesOperationalState',
      'productionEligible','productionPublicationAttempted'
    ]::text[]
    and private.truth_jsonb_has_only_keys(canonical_authorization, array[
      'schemaVersion','workspaceKey','sourceSystem','connectionKey','rootBatchId',
      'sourceCursorVersion','sourceCursorValue','parentJobId','modelChildJobId',
      'sourceObservationId','sourceObservationContentHash','extractionPlanId',
      'modelPlanId','modelPlanHash','planSealHash','parentManifestHash',
      'predecessorEpochId','predecessorEpochReceiptHash','disposition',
      'sealedSourceCapturedAt','canonicalSourceCapturedAt',
      'sealedSourceRecordedAt','canonicalSourceRecordedAt','priorState',
      'priorAttemptCount','priorMaxAttempts','priorLeaseFence',
      'authorizedMaxAttempts','shadowOnly','mutatesOperationalState',
      'productionEligible','productionPublicationAttempted'
    ])
  )
);

create index if not exists truth_shadow_gmail_resumed_model_child_scope_idx
  on public.truth_shadow_gmail_resumed_model_child_authorizations(
    workspace_key, connection_key, root_batch_id, disposition, model_child_job_id
  );

drop trigger if exists truth_shadow_gmail_resumed_model_child_authorizations_immutable
  on public.truth_shadow_gmail_resumed_model_child_authorizations;
create trigger truth_shadow_gmail_resumed_model_child_authorizations_immutable
before update or delete
on public.truth_shadow_gmail_resumed_model_child_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_shadow_gmail_resumed_model_child_authorizations
  enable row level security;
alter table public.truth_shadow_gmail_resumed_model_child_authorizations
  force row level security;
revoke all on table public.truth_shadow_gmail_resumed_model_child_authorizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_shadow_gmail_resumed_model_child_authorizations
  to service_role;

-- Mint the authority only from the exact installed ten-child residual.  An
-- empty fixture stack legitimately has no such root; a populated production
-- root must prove all ten rows or the migration rolls back atomically.
do $seed_exact_authority$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
  v_existing_count integer;
  v_candidate record;
  v_disposition text;
  v_authorized_max integer;
  v_body jsonb;
  v_hash text;
  v_total integer := 0;
  v_stale integer := 0;
  v_execution integer := 0;
begin
  select count(*)::integer into v_existing_count
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = v_workspace
    and authority.connection_key = v_connection
    and authority.root_batch_id = v_root;

  if v_existing_count not in (0, 10) then
    raise exception 'resumed Gmail model child authority is partially populated'
      using errcode = '23514';
  end if;
  if v_existing_count = 10 then
    select count(*)::integer,
           count(*) filter (where disposition = 'stale_time_binding_review')::integer,
           count(*) filter (where disposition = 'model_execution')::integer
      into v_total, v_stale, v_execution
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key = v_workspace
      and authority.connection_key = v_connection
      and authority.root_batch_id = v_root;
    if (v_total, v_stale, v_execution) is distinct from (10, 7, 3) then
      raise exception 'resumed Gmail model child authority split is corrupt'
        using errcode = '23514';
    end if;
    return;
  end if;

  if not exists (
    select 1 from public.source_ingest_batches batch
    where batch.workspace_key = v_workspace
      and batch.source_system = 'gmail'
      and batch.connection_key = v_connection
      and batch.batch_id = v_root
  ) then
    return;
  end if;

  perform private.truth_source_cut_mutation_lock(v_workspace);
  if exists (
      select 1
      from public.truth_shadow_root_source_cuts root_cut
      join public.source_cuts source_cut
        on source_cut.workspace_key = root_cut.workspace_key
       and source_cut.source_cut_id = root_cut.source_cut_id
      where root_cut.workspace_key = v_workspace
        and root_cut.root_batch_id = v_root
        and source_cut.completeness = 'complete'
    ) or exists (
      select 1 from public.truth_builds build
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = build.workspace_key
       and root_cut.source_cut_id = build.source_cut_id
      where root_cut.workspace_key = v_workspace
        and root_cut.root_batch_id = v_root
    ) or exists (
      select 1 from public.truth_publications publication
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = publication.workspace_key
       and root_cut.source_cut_id = publication.source_cut_id
      where root_cut.workspace_key = v_workspace
        and root_cut.root_batch_id = v_root
    ) then
    raise exception 'complete/built/published root cannot mint late model child authority'
      using errcode = '23514';
  end if;

  for v_candidate in
    select
      retry.authorization_id as retry_authorization_id,
      retry.authorization_hash as retry_authorization_hash,
      retry.artifact_mode,
      parent.job_id as parent_job_id,
      parent.result as parent_result,
      child.job_id as child_job_id,
      child.state as child_state,
      child.attempt_count,
      child.max_attempts,
      child.lease_fence,
      child.last_error_code,
      child.payload as child_payload,
      child.dedupe_key as child_dedupe_key,
      child.observation_id as child_observation_id,
      child.source_object_id as child_source_object_id,
      child_lineage.root_batch_id,
      child_lineage.root_job_id,
      child_lineage.source_cursor_version,
      child_lineage.source_cursor_value,
      observation.observation_id,
      observation.content_hash as observation_content_hash,
      observation.captured_at,
      observation.source_recorded_at,
      plan.extraction_plan_id,
      plan.model_plan_id,
      plan.model_plan_hash,
      plan.model_plan,
      plan.plan_seal_hash,
      plan.context_seal_id,
      manifest.manifest_hash as parent_manifest_hash,
      membership.worker_result_hash,
      membership.membership_hash,
      epoch.epoch_id,
      epoch.receipt_hash as epoch_receipt_hash
    from public.truth_shadow_gmail_model_residual_retry_authorizations retry
    join public.source_processing_jobs parent
      on parent.workspace_key = retry.workspace_key
     and parent.job_id = retry.claim_job_id
    join public.source_processing_job_lineage parent_lineage
      on parent_lineage.workspace_key = parent.workspace_key
     and parent_lineage.source_system = parent.source_system
     and parent_lineage.connection_key = parent.connection_key
     and parent_lineage.job_id = parent.job_id
    join public.source_processing_job_children edge
      on edge.parent_job_id = parent.job_id
    join public.source_processing_jobs child
      on child.workspace_key = parent.workspace_key
     and child.job_id = edge.child_job_id
    join public.source_processing_job_lineage child_lineage
      on child_lineage.workspace_key = child.workspace_key
     and child_lineage.source_system = child.source_system
     and child_lineage.connection_key = child.connection_key
     and child_lineage.job_id = child.job_id
     and child_lineage.parent_job_id = parent.job_id
     and child_lineage.root_batch_id = parent_lineage.root_batch_id
     and child_lineage.root_job_id = parent_lineage.root_job_id
     and child_lineage.source_cursor_version = parent_lineage.source_cursor_version
     and child_lineage.source_cursor_value = parent_lineage.source_cursor_value
    join public.source_ingest_batches batch
      on batch.workspace_key = child_lineage.workspace_key
     and batch.source_system = child_lineage.source_system
     and batch.connection_key = child_lineage.connection_key
     and batch.batch_id = child_lineage.root_batch_id
     and batch.status = 'committed'
     and batch.mode in ('backfill', 'reconciliation')
     and batch.committed_cursor_version = child_lineage.source_cursor_version
     and batch.committed_cursor_value = child_lineage.source_cursor_value
    join public.source_observations observation
      on observation.workspace_key = parent.workspace_key
     and observation.observation_id = parent.observation_id
     and observation.observation_id = child.observation_id
     and observation.batch_id = batch.batch_id
     and observation.source_cursor_version = batch.committed_cursor_version
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = parent.workspace_key
     and plan.parent_job_id = parent.job_id
     and plan.source_observation_id = observation.observation_id
     and plan.source_observation_content_hash = observation.content_hash
    join public.gmail_model_extraction_context_seals context_seal
      on context_seal.workspace_key = plan.workspace_key
     and context_seal.context_seal_id = plan.context_seal_id
     and context_seal.parent_job_id = plan.parent_job_id
     and context_seal.source_observation_id = plan.source_observation_id
     and context_seal.source_observation_content_hash = plan.source_observation_content_hash
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = parent.workspace_key
     and manifest.job_id = parent.job_id
     and manifest.source_observation_id = observation.observation_id
    join public.truth_pending_acceptance_epoch_manifests membership
      on membership.workspace_key = manifest.workspace_key
     and membership.source_job_id = manifest.job_id
     and membership.source_observation_id = manifest.source_observation_id
     and membership.source_observation_content_hash = observation.content_hash
     and membership.candidate_manifest_hash = manifest.manifest_hash
    join public.truth_shadow_claim_acceptance_epochs epoch
      on epoch.workspace_key = membership.workspace_key
     and epoch.obligation_id = membership.obligation_id
     and epoch.connection_key = parent.connection_key
     and epoch.root_batch_id = parent_lineage.root_batch_id
     and epoch.source_cursor_version = parent_lineage.source_cursor_version
     and epoch.source_cursor_value = parent_lineage.source_cursor_value
    where retry.workspace_key = v_workspace
      and retry.connection_key = v_connection
      and retry.root_batch_id = v_root
      and retry.authorization_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(retry.canonical_authorization), 'UTF8'
      ), 'sha256'), 'hex')
      and retry.shadow_only = true
      and retry.mutates_operational_state = false
      and retry.production_eligible = false
      and retry.production_publication_attempted = false
      and parent.source_system = 'gmail'
      and parent.connection_key = v_connection
      and parent.job_kind = 'gmail_extract_message_claims'
      and parent.state = 'succeeded'
      and parent.completed_at is not null
      and parent.lease_owner is null
      and parent.lease_expires_at is null
      and child.source_system = 'gmail'
      and child.connection_key = v_connection
      and child.job_kind = 'gmail_extract_message_model_claims'
      and child.completed_at is null
      and child.lease_owner is null
      and child.lease_expires_at is null
      and child.result = '{}'::jsonb
      and child.payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
      and private.truth_jsonb_has_only_keys(child.payload, array[
        'schemaVersion','modelPlanId','contextSealId','batchId',
        'rootBatchId','rootJobId','parentJobId'
      ])
      and (select count(*) from jsonb_object_keys(child.payload)) = 7
      and child.payload->>'modelPlanId' = plan.model_plan_id
      and child.payload->>'contextSealId' = plan.context_seal_id
      and child.payload->>'batchId' = child_lineage.root_batch_id::text
      and child.payload->>'rootBatchId' = child_lineage.root_batch_id::text
      and child.payload->>'rootJobId' = child_lineage.root_job_id::text
      and child.payload->>'parentJobId' = parent.job_id::text
      and child.dedupe_key = 'gmail:model-claims:v1:' || plan.model_plan_hash
      and child.observation_id = parent.observation_id
      and child.source_object_id = parent.source_object_id
      and (
        -- Attempt count is 3 or 4: the operator agent ran two diagnostic claim
        -- rounds after this migration's fixture snapshot; identity stays pinned
        -- by error code, dedupe key, plan seal, and the binding proof below,
        -- and the authorization receipt records each row's true prior count.
        (child.state = 'retry_wait' and child.attempt_count in (3, 4)
          and child.max_attempts = 5
          and child.last_error_code = 'MODEL_REQUEST_CONFIGURATION_ERROR'
          and retry.artifact_mode = 'sealed_resume_or_reconcile'
          and private.truth_shadow_gmail_old_millisecond_time_binding_v1(
            plan.model_plan, observation.captured_at, observation.source_recorded_at
          ))
        or
        (child.state = 'waiting_runtime' and child.attempt_count = 0
          and child.max_attempts = 5
          and child.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
          and retry.artifact_mode = 'unstarted'
          and private.truth_shadow_gmail_current_source_time_binding_v1(
            plan.model_plan, observation.captured_at, observation.source_recorded_at
          ))
      )
      and plan.planning_status = 'complete'
      and plan.planning_failure_code = ''
      and plan.planning_failure_detail_hash = ''
      -- Production plans for this cohort were sealed in batch mode; both modes
      -- carry the same authority semantics here.
      and plan.execution_mode in ('sync', 'batch')
      and plan.model_plan_id = 'gmail-model-plan:v1:' || plan.model_plan_hash
      and plan.model_plan->>'modelPlanId' = plan.model_plan_id
      and plan.model_plan->>'modelPlanHash' = plan.model_plan_hash
      and plan.model_plan->>'sourceObservationId' = observation.observation_id
      and plan.model_plan->>'sourceObservationContentHash' = observation.content_hash
      and plan.model_plan_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(plan.model_plan - 'modelPlanId' - 'modelPlanHash'),
        'UTF8'
      ), 'sha256'), 'hex')
      and context_seal.seal_hash = encode(extensions.digest(convert_to(
        context_seal.canonical_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and plan.plan_seal_hash = encode(extensions.digest(convert_to(
        plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and manifest.manifest_hash = encode(extensions.digest(convert_to(
        manifest.canonical_manifest::text, 'UTF8'
      ), 'sha256'), 'hex')
      and membership.membership_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(membership.canonical_membership), 'UTF8'
      ), 'sha256'), 'hex')
      and epoch.frontier_manifest_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(epoch.frontier_manifest), 'UTF8'
      ), 'sha256'), 'hex')
      and epoch.receipt_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(epoch.canonical_receipt), 'UTF8'
      ), 'sha256'), 'hex')
      and exists (
        select 1
        from jsonb_array_elements(epoch.frontier_manifest->'sourceManifests') item
        where item->>'sourceJobId' = parent.job_id::text
          and item->>'sourceObservationId' = observation.observation_id
          and item->>'sourceObservationContentHash' = observation.content_hash
          and item->>'candidateManifestHash' = manifest.manifest_hash
          and item->>'workerResultHash' = membership.worker_result_hash
          and item->>'membershipHash' = membership.membership_hash
      )
      and parent.result #>> '{truthPlan,extractionPlanId}' = plan.extraction_plan_id
      and parent.result #>> '{truthPlan,planSealHash}' = plan.plan_seal_hash
      and parent.result #>> '{truthPlan,deterministicManifestHash}' = manifest.manifest_hash
      and parent.result #>> '{truthPlan,modelPlanId}' = plan.model_plan_id
      and parent.result #>> '{truthPlan,planningStatus}' = 'complete'
      and not exists (select 1 from public.truth_model_requests request
        where request.workspace_key = child.workspace_key
          and request.source_job_id = child.job_id)
      and not exists (select 1 from public.gmail_model_extraction_results result
        where result.workspace_key = child.workspace_key
          and result.model_child_job_id = child.job_id)
      and not exists (select 1 from public.gmail_model_extraction_review_intents intent
        where intent.workspace_key = child.workspace_key
          and intent.model_child_job_id = child.job_id)
      and not exists (select 1 from public.candidate_claim_job_manifests child_manifest
        where child_manifest.workspace_key = child.workspace_key
          and child_manifest.job_id = child.job_id)
      and not exists (select 1 from public.truth_required_sources required_source
        where required_source.workspace_key = parent.workspace_key
          and required_source.source_system = parent.source_system
          and required_source.connection_key = parent.connection_key)
    order by child.job_id
  loop
    v_disposition := case when v_candidate.child_state = 'retry_wait'
      then 'stale_time_binding_review' else 'model_execution' end;
    v_authorized_max := greatest(
      v_candidate.max_attempts, v_candidate.attempt_count + 3
    );
    v_body := jsonb_build_object(
      'schemaVersion', 'truth-shadow-gmail-resumed-model-child-authorization-v1',
      'workspaceKey', v_workspace,
      'sourceSystem', 'gmail',
      'connectionKey', v_connection,
      'rootBatchId', v_root,
      'sourceCursorVersion', v_candidate.source_cursor_version,
      'sourceCursorValue', v_candidate.source_cursor_value,
      'parentJobId', v_candidate.parent_job_id,
      'modelChildJobId', v_candidate.child_job_id,
      'sourceObservationId', v_candidate.observation_id,
      'sourceObservationContentHash', v_candidate.observation_content_hash,
      'extractionPlanId', v_candidate.extraction_plan_id,
      'modelPlanId', v_candidate.model_plan_id,
      'modelPlanHash', v_candidate.model_plan_hash,
      'planSealHash', v_candidate.plan_seal_hash,
      'parentManifestHash', v_candidate.parent_manifest_hash,
      'predecessorEpochId', v_candidate.epoch_id,
      'predecessorEpochReceiptHash', v_candidate.epoch_receipt_hash,
      'disposition', v_disposition,
      'sealedSourceCapturedAt', v_candidate.model_plan->>'sourceCapturedAt',
      'canonicalSourceCapturedAt',
        private.truth_worker_canonical_millis(v_candidate.captured_at),
      'sealedSourceRecordedAt', coalesce(
        v_candidate.model_plan->>'sourceRecordedAt', ''
      ),
      'canonicalSourceRecordedAt', case
        when v_candidate.source_recorded_at is null then ''
        else private.truth_worker_canonical_millis(v_candidate.source_recorded_at)
      end,
      'priorState', v_candidate.child_state,
      'priorAttemptCount', v_candidate.attempt_count,
      'priorMaxAttempts', v_candidate.max_attempts,
      'priorLeaseFence', v_candidate.lease_fence,
      'authorizedMaxAttempts', v_authorized_max,
      'shadowOnly', true,
      'mutatesOperationalState', false,
      'productionEligible', false,
      'productionPublicationAttempted', false
    );
    v_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body), 'UTF8'
    ), 'sha256'), 'hex');
    insert into public.truth_shadow_gmail_resumed_model_child_authorizations (
      authorization_id, authorization_hash, workspace_key, source_system,
      connection_key, root_batch_id, source_cursor_version, source_cursor_value,
      parent_job_id, model_child_job_id, source_observation_id,
      source_observation_content_hash, extraction_plan_id, model_plan_id,
      model_plan_hash, plan_seal_hash, parent_manifest_hash,
      predecessor_epoch_id, predecessor_epoch_receipt_hash, disposition,
      sealed_source_captured_at, canonical_source_captured_at,
      sealed_source_recorded_at, canonical_source_recorded_at, prior_state,
      prior_attempt_count, prior_max_attempts, prior_lease_fence,
      authorized_max_attempts, canonical_authorization, schema_version,
      shadow_only, mutates_operational_state, production_eligible,
      production_publication_attempted
    ) values (
      'truth-shadow-gmail-resumed-model-child:v1:' || v_hash, v_hash,
      v_workspace, 'gmail', v_connection, v_root,
      v_candidate.source_cursor_version, v_candidate.source_cursor_value,
      v_candidate.parent_job_id, v_candidate.child_job_id,
      v_candidate.observation_id, v_candidate.observation_content_hash,
      v_candidate.extraction_plan_id, v_candidate.model_plan_id,
      v_candidate.model_plan_hash, v_candidate.plan_seal_hash,
      v_candidate.parent_manifest_hash, v_candidate.epoch_id,
      v_candidate.epoch_receipt_hash, v_disposition,
      v_candidate.model_plan->>'sourceCapturedAt',
      private.truth_worker_canonical_millis(v_candidate.captured_at),
      nullif(v_candidate.model_plan->>'sourceRecordedAt', ''),
      case when v_candidate.source_recorded_at is null then null
        else private.truth_worker_canonical_millis(v_candidate.source_recorded_at) end,
      v_candidate.child_state, v_candidate.attempt_count,
      v_candidate.max_attempts, v_candidate.lease_fence, v_authorized_max,
      v_body, 'truth-shadow-gmail-resumed-model-child-authorization-v1',
      true, false, false, false
    );
    v_total := v_total + 1;
    if v_disposition = 'stale_time_binding_review' then
      v_stale := v_stale + 1;
    else
      v_execution := v_execution + 1;
    end if;
  end loop;

  if (v_total, v_stale, v_execution) is distinct from (10, 7, 3) then
    raise exception 'exact resumed Gmail model child residual is not 10/7/3'
      using errcode = '23514';
  end if;
end;
$seed_exact_authority$;

-- O(1) validation starts at the immutable child identity.  It replays the
-- complete parent/plan/epoch proof so the table is an index, not an oracle.
create or replace function private.truth_shadow_gmail_resumed_model_authorized_job_v1(
  p_workspace_key text,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.source_processing_jobs child
      on child.workspace_key = authority.workspace_key
     and child.job_id = authority.model_child_job_id
    join public.source_processing_job_lineage child_lineage
      on child_lineage.workspace_key = child.workspace_key
     and child_lineage.source_system = child.source_system
     and child_lineage.connection_key = child.connection_key
     and child_lineage.job_id = child.job_id
    join public.source_processing_jobs parent
      on parent.workspace_key = authority.workspace_key
     and parent.job_id = authority.parent_job_id
     and parent.job_id = child_lineage.parent_job_id
    join public.source_processing_job_lineage parent_lineage
      on parent_lineage.workspace_key = parent.workspace_key
     and parent_lineage.source_system = parent.source_system
     and parent_lineage.connection_key = parent.connection_key
     and parent_lineage.job_id = parent.job_id
    join public.source_processing_job_children edge
      on edge.parent_job_id = parent.job_id
     and edge.child_job_id = child.job_id
    join public.source_observations observation
      on observation.workspace_key = authority.workspace_key
     and observation.observation_id = authority.source_observation_id
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = authority.workspace_key
     and plan.parent_job_id = authority.parent_job_id
     and plan.extraction_plan_id = authority.extraction_plan_id
     and plan.model_plan_id = authority.model_plan_id
    join public.gmail_model_extraction_context_seals context_seal
      on context_seal.workspace_key = plan.workspace_key
     and context_seal.context_seal_id = plan.context_seal_id
     and context_seal.parent_job_id = plan.parent_job_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = parent.workspace_key
     and manifest.job_id = parent.job_id
     and manifest.manifest_hash = authority.parent_manifest_hash
    join public.truth_pending_acceptance_epoch_manifests membership
      on membership.workspace_key = manifest.workspace_key
     and membership.source_job_id = manifest.job_id
    join public.truth_shadow_claim_acceptance_epochs epoch
      on epoch.workspace_key = authority.workspace_key
     and epoch.epoch_id = authority.predecessor_epoch_id
     and epoch.obligation_id = membership.obligation_id
    where authority.workspace_key = p_workspace_key
      and authority.model_child_job_id = p_job_id
      and authority.authorization_id =
        'truth-shadow-gmail-resumed-model-child:v1:' || authority.authorization_hash
      and authority.authorization_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(authority.canonical_authorization), 'UTF8'
      ), 'sha256'), 'hex')
      and authority.shadow_only = true
      and authority.mutates_operational_state = false
      and authority.production_eligible = false
      and authority.production_publication_attempted = false
      and child.source_system = authority.source_system
      and child.connection_key = authority.connection_key
      and child.connection_key like 'shadow-%'
      and child.job_kind = 'gmail_extract_message_model_claims'
      and child.state in ('waiting_runtime', 'queued', 'retry_wait', 'leased')
      and child.attempt_count >= authority.prior_attempt_count
      and child.attempt_count < authority.authorized_max_attempts
      and child.max_attempts = authority.authorized_max_attempts
      and child.completed_at is null
      and child.result = '{}'::jsonb
      and child.observation_id = authority.source_observation_id
      and child.observation_id = parent.observation_id
      and child.source_object_id = parent.source_object_id
      and child.dedupe_key = 'gmail:model-claims:v1:' || authority.model_plan_hash
      and private.truth_jsonb_has_only_keys(child.payload, array[
        'schemaVersion','modelPlanId','contextSealId','batchId',
        'rootBatchId','rootJobId','parentJobId'
      ])
      and (select count(*) from jsonb_object_keys(child.payload)) = 7
      and child.payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
      and child.payload->>'modelPlanId' = authority.model_plan_id
      and child.payload->>'contextSealId' = plan.context_seal_id
      and child.payload->>'batchId' = authority.root_batch_id::text
      and child.payload->>'rootBatchId' = authority.root_batch_id::text
      and child.payload->>'rootJobId' = child_lineage.root_job_id::text
      and child.payload->>'parentJobId' = authority.parent_job_id::text
      and child_lineage.root_batch_id = authority.root_batch_id
      and child_lineage.root_job_id = parent_lineage.root_job_id
      and child_lineage.source_cursor_version = authority.source_cursor_version
      and child_lineage.source_cursor_value = authority.source_cursor_value
      and parent_lineage.root_batch_id = authority.root_batch_id
      and parent_lineage.source_cursor_version = authority.source_cursor_version
      and parent_lineage.source_cursor_value = authority.source_cursor_value
      and parent.state = 'succeeded'
      and parent.completed_at is not null
      and parent.lease_owner is null
      and parent.lease_expires_at is null
      and observation.content_hash = authority.source_observation_content_hash
      and plan.source_observation_id = observation.observation_id
      and plan.source_observation_content_hash = observation.content_hash
      and plan.model_plan_hash = authority.model_plan_hash
      and plan.plan_seal_hash = authority.plan_seal_hash
      and plan.planning_status = 'complete'
      and plan.planning_failure_code = ''
      -- Production plans for this cohort were sealed in batch mode; both modes
      -- carry the same authority semantics here.
      and plan.execution_mode in ('sync', 'batch')
      and plan.model_plan_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(plan.model_plan - 'modelPlanId' - 'modelPlanHash'),
        'UTF8'
      ), 'sha256'), 'hex')
      and plan.plan_seal_hash = encode(extensions.digest(convert_to(
        plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and context_seal.seal_hash = encode(extensions.digest(convert_to(
        context_seal.canonical_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and manifest.manifest_hash = encode(extensions.digest(convert_to(
        manifest.canonical_manifest::text, 'UTF8'
      ), 'sha256'), 'hex')
      and membership.candidate_manifest_hash = manifest.manifest_hash
      and membership.source_observation_id = observation.observation_id
      and membership.source_observation_content_hash = observation.content_hash
      and epoch.connection_key = authority.connection_key
      and epoch.root_batch_id = authority.root_batch_id
      and epoch.source_cursor_version = authority.source_cursor_version
      and epoch.source_cursor_value = authority.source_cursor_value
      and epoch.receipt_hash = authority.predecessor_epoch_receipt_hash
      and epoch.receipt_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(epoch.canonical_receipt), 'UTF8'
      ), 'sha256'), 'hex')
      and exists (
        select 1
        from jsonb_array_elements(epoch.frontier_manifest->'sourceManifests') item
        where item->>'sourceJobId' = parent.job_id::text
          and item->>'sourceObservationId' = observation.observation_id
          and item->>'sourceObservationContentHash' = observation.content_hash
          and item->>'candidateManifestHash' = manifest.manifest_hash
          and item->>'workerResultHash' = membership.worker_result_hash
          and item->>'membershipHash' = membership.membership_hash
      )
      and parent.result #>> '{truthPlan,extractionPlanId}' = plan.extraction_plan_id
      and parent.result #>> '{truthPlan,planSealHash}' = plan.plan_seal_hash
      and parent.result #>> '{truthPlan,deterministicManifestHash}' = manifest.manifest_hash
      and parent.result #>> '{truthPlan,modelPlanId}' = plan.model_plan_id
      and parent.result #>> '{truthPlan,planningStatus}' = 'complete'
      and (
        (authority.disposition = 'stale_time_binding_review'
          and private.truth_shadow_gmail_old_millisecond_time_binding_v1(
            plan.model_plan, observation.captured_at, observation.source_recorded_at
          ))
        or
        (authority.disposition = 'model_execution'
          and private.truth_shadow_gmail_current_source_time_binding_v1(
            plan.model_plan, observation.captured_at, observation.source_recorded_at
          ))
      )
      and not exists (select 1 from public.truth_required_sources required_source
        where required_source.workspace_key = authority.workspace_key
          and required_source.source_system = authority.source_system
          and required_source.connection_key = authority.connection_key)
      and not exists (
        select 1 from public.truth_shadow_root_source_cuts root_cut
        join public.source_cuts source_cut
          on source_cut.workspace_key = root_cut.workspace_key
         and source_cut.source_cut_id = root_cut.source_cut_id
        where root_cut.workspace_key = authority.workspace_key
          and root_cut.root_batch_id = authority.root_batch_id
          and source_cut.completeness = 'complete'
      )
  );
$function$;

revoke all on function
  private.truth_shadow_gmail_resumed_model_authorized_job_v1(text,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.truth_shadow_gmail_model_job_allowed_v3(
  p_workspace_key text,
  p_job_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if private.truth_shadow_gmail_resumed_model_authorized_job_v1(
      p_workspace_key, p_job_id
    ) then
    return true;
  end if;
  return private.truth_shadow_gmail_model_job_allowed_v2(
    p_workspace_key, p_job_id
  );
end;
$function$;

revoke all on function private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.truth_shadow_gmail_model_child_input_allowed_v3(
  p_workspace_key text,
  p_parent_job_id text,
  p_child_job_id uuid,
  p_dedupe_key text,
  p_observation_id text,
  p_payload jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.source_processing_jobs child
      on child.workspace_key = authority.workspace_key
     and child.job_id = authority.model_child_job_id
    where authority.workspace_key = p_workspace_key
      and authority.model_child_job_id = p_child_job_id
      and authority.parent_job_id::text = p_parent_job_id
      and child.dedupe_key = p_dedupe_key
      and child.observation_id = p_observation_id
      and child.payload = p_payload
      and private.truth_shadow_gmail_resumed_model_authorized_job_v1(
        authority.workspace_key, authority.model_child_job_id
      )
  ) then
    return true;
  end if;
  return private.truth_shadow_gmail_model_child_input_allowed_v2(
    p_workspace_key, p_parent_job_id, p_child_job_id, p_dedupe_key,
    p_observation_id, p_payload
  );
end;
$function$;

revoke all on function private.truth_shadow_gmail_model_child_input_allowed_v3(
  text,text,uuid,text,text,jsonb
) from public, anon, authenticated, service_role;

-- Route existing stored children through v3.  The rewrite changes one symbol
-- only; attachment routing and every other job vocabulary remain untouched.
do $route_v3_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_definition text;
  v_updated text;
  v_old constant text := 'private.truth_shadow_gmail_model_child_input_allowed_v2(';
  v_new constant text := 'private.truth_shadow_gmail_model_child_input_allowed_v3(';
  v_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
      / length(v_old);
    if v_count <> 1 then
      raise exception 'Gmail model route v3 rewrite did not match exactly once'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition
      or position(v_old in v_updated) > 0
      or position(v_new in v_updated) = 0
      or position('gmail_review_attachment_extraction' in v_updated) = 0 then
      raise exception 'Gmail model route v3 rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'Gmail model route v3 is partially installed'
      using errcode = '23514';
  end if;
end;
$route_v3_rewrite$;

-- Preserve the installed function settings, including the operator's bounded
-- production time budgets, and replace only the candidates CTE.  MATERIALIZED
-- cheap scope selection prevents PostgreSQL from placing the expensive Gmail
-- validators on the inner side of a lineage nested loop.
do $claim_plan_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_updated text;
  v_start integer;
  v_finish integer;
  v_block text := $replacement$  with scoped_claim_jobs as materialized (
    select job.job_id
    from public.source_processing_jobs job
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and job.state in ('queued', 'retry_wait')
      and job.available_at <= v_now
      and job.attempt_count < job.max_attempts
      and (coalesce(cardinality(p_job_kinds), 0) = 0
        or job.job_kind = any(p_job_kinds))
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_fetch_raw_message')
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_review_model_extraction')
  ), admitted_claim_jobs as materialized (
    select job.job_id
    from scoped_claim_jobs scoped
    join public.source_processing_jobs job
      on job.job_id = scoped.job_id
    where case
      when job.source_system = 'gmail'
        and job.job_kind = 'gmail_extract_message_model_claims'
      then private.truth_shadow_gmail_model_job_allowed_v3(
        job.workspace_key, job.job_id
      )
      else true
    end
      and case
        when job.source_system = 'gmail'
          and job.connection_key like 'shadow-%'
          and job.job_kind = 'gmail_review_attachment_extraction'
        then private.truth_shadow_model_commissioning_job_allowed(
          job.workspace_key, job.job_id
        )
        else true
      end
  ), candidates as (
    select job.job_id
    from admitted_claim_jobs admitted
    join public.source_processing_jobs job
      on job.job_id = admitted.job_id
    join public.source_processing_job_lineage lineage
      on lineage.job_id = job.job_id
     and lineage.workspace_key = job.workspace_key
     and lineage.source_system = job.source_system
     and lineage.connection_key = job.connection_key
    join public.source_ingest_batches batch
      on batch.batch_id = lineage.root_batch_id
     and batch.workspace_key = lineage.workspace_key
     and batch.source_system = lineage.source_system
     and batch.connection_key = lineage.connection_key
     and batch.status = 'committed'
     and batch.committed_cursor_version = lineage.source_cursor_version
     and batch.committed_cursor_value = lineage.source_cursor_value
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and job.state in ('queued', 'retry_wait')
      and job.available_at <= v_now
      and job.attempt_count < job.max_attempts
      and (coalesce(cardinality(p_job_kinds), 0) = 0
        or job.job_kind = any(p_job_kinds))
      and (job.source_system <> 'gmail' or lineage.source_cursor_value ~ '^[0-9]+$')
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_fetch_raw_message')
      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_review_model_extraction')
      and (job.job_kind <> 'gmail_resolve_entity_links' or exists (
        select 1 from public.truth_gmail_link_epoch_members member
        where member.workspace_key = job.workspace_key
          and member.link_job_id = job.job_id
      ))
      and (job.job_kind <> all(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
        ]) or exists (
          select 1 from public.truth_gmail_link_epochs epoch
          join public.truth_gmail_link_epoch_seals seal
            on seal.workspace_key = epoch.workspace_key
           and seal.epoch_id = epoch.epoch_id
          where epoch.workspace_key = job.workspace_key
            and epoch.root_batch_id = lineage.root_batch_id
        ))
      and (job.job_kind <> 'gmail_materialize_message_revision' or (
        exists (
          select 1 from public.gmail_message_materialization_groups group_row
          where group_row.workspace_key = job.workspace_key
            and group_row.materialization_job_id = job.job_id
        )
        and not exists (
          select 1
          from public.gmail_message_materialization_groups current_group
          join public.gmail_message_materialization_groups prior_group
            on prior_group.workspace_key = current_group.workspace_key
           and prior_group.connection_key = current_group.connection_key
           and prior_group.message_id = current_group.message_id
           and prior_group.route_disposition = 'materialize_revision'
           and (prior_group.source_cursor_version < current_group.source_cursor_version
             or (prior_group.source_cursor_version = current_group.source_cursor_version
               and prior_group.group_id < current_group.group_id))
          join public.source_processing_jobs prior_job
            on prior_job.workspace_key = prior_group.workspace_key
           and prior_job.job_id = prior_group.materialization_job_id
          where current_group.workspace_key = job.workspace_key
            and current_group.materialization_job_id = job.job_id
            and prior_job.state not in ('succeeded', 'dead_letter', 'superseded')
        )
      ))
    order by
      case when job.job_kind = 'gmail_materialize_message_revision'
        then lineage.source_cursor_version else 0 end,
      job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit p_limit
$replacement$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('scoped_claim_jobs as materialized' in lower(v_definition)) = 0 then
    if position('private.truth_shadow_gmail_model_job_allowed_v2(' in v_definition) = 0
      or position('private.truth_shadow_model_commissioning_job_allowed(' in v_definition) = 0
      or position('for update of job skip locked' in lower(v_definition)) = 0 then
      raise exception 'source-processing claim differs from reviewed v2 query plan'
        using errcode = '23514';
    end if;
    v_start := position('  with candidates as (' in v_definition);
    v_finish := position('  ), claimed as (' in v_definition);
    if v_start = 0 or v_finish <= v_start then
      raise exception 'source-processing candidates CTE boundary is unavailable'
        using errcode = '23514';
    end if;
    v_updated := substring(v_definition from 1 for v_start - 1)
      || v_block || substring(v_definition from v_finish);
    if position('scoped_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('admitted_claim_jobs as materialized' in lower(v_updated)) = 0
      or position('truth_shadow_gmail_model_job_allowed_v3' in v_updated) = 0
      or position('truth_shadow_gmail_model_job_allowed_v2' in v_updated) > 0
      or position('for update of job skip locked' in lower(v_updated)) = 0 then
      raise exception 'bounded source-processing claim rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position('truth_shadow_gmail_model_job_allowed_v3' in v_definition) = 0
    or position('admitted_claim_jobs as materialized' in lower(v_definition)) = 0 then
    raise exception 'bounded source-processing claim plan is partially installed'
      using errcode = '23514';
  end if;
end;
$claim_plan_rewrite$;

revoke all on function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public, anon, authenticated, service_role;

-- Remove the emergency planner switch without disturbing lock, statement, or
-- custom-plan budgets installed on production.
alter function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) reset enable_nestloop;
alter function public.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) reset enable_nestloop;

-- The BEFORE UPDATE route now recognizes the stored authority.  Adopt only the
-- three exact current-bound children and add fenced headroom for all ten.
do $adopt_authorized_children$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
begin
  update public.source_processing_jobs child
  set max_attempts = authority.authorized_max_attempts,
      available_at = clock_timestamp(),
      updated_at = clock_timestamp()
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = v_workspace
    and authority.connection_key = v_connection
    and authority.root_batch_id = v_root
    and authority.workspace_key = child.workspace_key
    and authority.model_child_job_id = child.job_id
    and child.state = authority.prior_state
    and child.attempt_count = authority.prior_attempt_count
    and child.max_attempts = authority.prior_max_attempts
    and child.lease_fence = authority.prior_lease_fence
    and child.lease_owner is null
    and child.lease_expires_at is null
    and child.completed_at is null
    and child.result = '{}'::jsonb;

  update public.source_processing_jobs child
  set state = 'queued',
      available_at = clock_timestamp(),
      last_error_code = '',
      safe_error_detail = '',
      updated_at = clock_timestamp()
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = v_workspace
    and authority.connection_key = v_connection
    and authority.root_batch_id = v_root
    and authority.disposition = 'model_execution'
    and authority.workspace_key = child.workspace_key
    and authority.model_child_job_id = child.job_id
    and child.state = 'waiting_runtime'
    and child.attempt_count = authority.prior_attempt_count
    and child.max_attempts = authority.authorized_max_attempts
    and child.lease_fence = authority.prior_lease_fence
    and child.lease_owner is null
    and child.lease_expires_at is null
    and child.completed_at is null
    and child.result = '{}'::jsonb
    and private.truth_shadow_gmail_model_job_allowed_v3(
      child.workspace_key, child.job_id
    );
end;
$adopt_authorized_children$;

-- The generic review authority intentionally recognizes only parked plans or
-- terminal model requests.  Add one named authority kind for the independently
-- re-proved immutable timestamp mismatch; do not broaden the generic RPC.
do $review_authority_constraint$
declare
  v_definition text;
begin
  select pg_get_constraintdef(constraint_row.oid)
    into v_definition
  from pg_constraint constraint_row
  where constraint_row.conrelid =
      'public.gmail_model_extraction_review_intents'::regclass
    and constraint_row.conname =
      'gmail_model_extraction_review_intents_authority_kind_check';
  if v_definition is null
    or position('model_plan_execution_mode' in v_definition) = 0
    or position('truth_model_request' in v_definition) = 0
    or (
      position('shadow_stale_source_time_binding_authority' in v_definition) = 0
      and position('ANY' in v_definition) = 0
    ) then
    -- The last ANY check accepts PostgreSQL's normalized predecessor form but
    -- the subsequent drop/add still installs the exact reviewed vocabulary.
    if v_definition is null then
      raise exception 'Gmail model review authority constraint is unavailable'
        using errcode = '55000';
    end if;
  end if;
  alter table public.gmail_model_extraction_review_intents
    drop constraint gmail_model_extraction_review_intents_authority_kind_check;
  alter table public.gmail_model_extraction_review_intents
    add constraint gmail_model_extraction_review_intents_authority_kind_check
    check (authority_kind = any(array[
      'model_plan_execution_mode',
      'truth_model_request',
      'shadow_stale_source_time_binding_authority'
    ]));
end;
$review_authority_constraint$;

create or replace function private.create_truth_shadow_stale_gmail_model_review(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_model_plan_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_authority public.truth_shadow_gmail_resumed_model_child_authorizations%rowtype;
  v_plan public.gmail_model_extraction_plans%rowtype;
  v_observation public.source_observations%rowtype;
  v_existing public.gmail_model_extraction_review_intents%rowtype;
  v_reason constant text := 'STALE_IMMUTABLE_SOURCE_TIME_BINDING';
  v_detail jsonb;
  v_detail_hash text;
  v_body jsonb;
  v_intent_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if coalesce(p_model_plan_id, '') !~ '^gmail-model-plan:v1:[0-9a-f]{64}$' then
    raise exception 'stale Gmail model review request is invalid'
      using errcode = '22023';
  end if;
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  v_job := private.require_live_truth_model_source_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select authority.* into strict v_authority
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = p_workspace_key
    and authority.model_child_job_id = p_job_id
    and authority.model_plan_id = p_model_plan_id
    and authority.disposition = 'stale_time_binding_review';
  select plan.* into strict v_plan
  from public.gmail_model_extraction_plans plan
  where plan.workspace_key = v_authority.workspace_key
    and plan.parent_job_id = v_authority.parent_job_id
    and plan.extraction_plan_id = v_authority.extraction_plan_id
    and plan.model_plan_id = v_authority.model_plan_id
    and plan.model_plan_hash = v_authority.model_plan_hash
    and plan.plan_seal_hash = v_authority.plan_seal_hash;
  select observation.* into strict v_observation
  from public.source_observations observation
  where observation.workspace_key = v_authority.workspace_key
    and observation.observation_id = v_authority.source_observation_id
    and observation.content_hash = v_authority.source_observation_content_hash;
  if not private.truth_shadow_gmail_resumed_model_authorized_job_v1(
      p_workspace_key, p_job_id
    )
    or v_job.state <> 'leased'
    or v_job.result <> '{}'::jsonb
    or not private.truth_shadow_gmail_old_millisecond_time_binding_v1(
      v_plan.model_plan, v_observation.captured_at,
      v_observation.source_recorded_at
    )
    or exists (select 1 from public.truth_model_requests request
      where request.workspace_key = p_workspace_key
        and request.source_job_id = p_job_id)
    or exists (select 1 from public.gmail_model_extraction_results result
      where result.workspace_key = p_workspace_key
        and result.model_child_job_id = p_job_id) then
    raise exception 'stale Gmail model review lacks its exact immutable authority'
      using errcode = '23514';
  end if;

  v_detail := jsonb_build_object(
    'schemaVersion', 'truth-model-extraction-review-detail-v1',
    'jobId', p_job_id,
    'modelPlanId', p_model_plan_id,
    'sourceObservationId', v_observation.observation_id,
    'reasonCode', v_reason,
    'requestId', '',
    'requestState', ''
  );
  v_detail_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_detail), 'UTF8'
  ), 'sha256'), 'hex');

  select * into v_existing
  from public.gmail_model_extraction_review_intents intent
  where intent.workspace_key = p_workspace_key
    and intent.model_plan_id = p_model_plan_id;
  if found then
    if v_existing.model_child_job_id is distinct from p_job_id
      or v_existing.reason_code is distinct from v_reason
      or v_existing.safe_detail_hash is distinct from v_detail_hash
      or v_existing.authority_kind is distinct from
        'shadow_stale_source_time_binding_authority'
      or v_existing.authority_id is distinct from v_authority.authorization_id
      or v_existing.authority_hash is distinct from v_authority.authorization_hash then
      raise exception 'stale Gmail model review retry conflicts with durable intent'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'schemaVersion', 'gmail-model-extraction-review-intent-receipt-v1',
      'workspaceKey', p_workspace_key,
      'modelPlanId', p_model_plan_id,
      'modelChildJobId', p_job_id,
      'intentId', v_existing.intent_id,
      'reasonCode', v_existing.reason_code,
      'safeDetailHash', v_existing.safe_detail_hash,
      'mutatesOperationalState', false,
      'publishesTruth', false
    );
  end if;

  v_body := jsonb_build_object(
    'schemaVersion', 'gmail-model-extraction-review-intent-v1',
    'workspaceKey', p_workspace_key,
    'extractionPlanId', v_plan.extraction_plan_id,
    'modelPlanId', p_model_plan_id,
    'modelChildJobId', p_job_id,
    'sourceObservationId', v_observation.observation_id,
    'reasonCode', v_reason,
    'safeDetailHash', v_detail_hash,
    'authorityKind', 'shadow_stale_source_time_binding_authority',
    'authorityId', v_authority.authorization_id,
    'authorityHash', v_authority.authorization_hash
  );
  v_intent_hash := encode(extensions.digest(convert_to(
    v_body::text, 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.gmail_model_extraction_review_intents (
    intent_id, workspace_key, extraction_plan_id, model_plan_id,
    model_child_job_id, reason_code, safe_detail_hash, authority_kind,
    authority_id, authority_hash, canonical_intent, intent_hash
  ) values (
    'gmail-model-review-intent:v1:' || v_intent_hash,
    p_workspace_key, v_plan.extraction_plan_id, p_model_plan_id, p_job_id,
    v_reason, v_detail_hash, 'shadow_stale_source_time_binding_authority',
    v_authority.authorization_id, v_authority.authorization_hash,
    v_body, v_intent_hash
  );
  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'schemaVersion', 'gmail-model-extraction-review-intent-receipt-v1',
    'workspaceKey', p_workspace_key,
    'modelPlanId', p_model_plan_id,
    'modelChildJobId', p_job_id,
    'intentId', 'gmail-model-review-intent:v1:' || v_intent_hash,
    'reasonCode', v_reason,
    'safeDetailHash', v_detail_hash,
    'mutatesOperationalState', false,
    'publishesTruth', false
  );
end;
$function$;

create or replace function public.create_truth_shadow_stale_gmail_model_review(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_model_plan_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set lock_timeout = '30s'
set statement_timeout = '60s'
as $function$
  select private.create_truth_shadow_stale_gmail_model_review(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_model_plan_id, p_sync_token
  );
$function$;

revoke all on function private.create_truth_shadow_stale_gmail_model_review(
  text,uuid,text,bigint,text,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.create_truth_shadow_stale_gmail_model_review(
  text,uuid,text,bigint,text,text,text
) from public, anon, authenticated;
grant execute on function public.create_truth_shadow_stale_gmail_model_review(
  text,uuid,text,bigint,text,text,text
) to service_role;

-- A late model child can honestly finish in review after its parent manifest
-- has already been certified by the predecessor epoch.  Migration 16213000
-- deliberately taught the token-protected private resolver to consume parked
-- waiting_runtime/GMAIL_MODEL_RUNTIME_DISABLED reviews.  Preserve that
-- reviewed predecessor byte-for-byte for legacy callers.  This predicate and
-- the public gate below prove that any obligation belonging to the late-model
-- population replays its immutable child authority, plan, epoch, terminal
-- intent, and review job before the existing resolver may consume it.
create or replace function private.truth_shadow_late_gmail_model_review_allowed_v1(
  p_workspace_key text,
  p_obligation_id text,
  p_review_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = authority.workspace_key
     and plan.parent_job_id = authority.parent_job_id
     and plan.extraction_plan_id = authority.extraction_plan_id
     and plan.model_plan_id = authority.model_plan_id
     and plan.model_plan_hash = authority.model_plan_hash
     and plan.plan_seal_hash = authority.plan_seal_hash
    join public.source_observations observation
      on observation.workspace_key = authority.workspace_key
     and observation.observation_id = authority.source_observation_id
     and observation.content_hash = authority.source_observation_content_hash
    join public.source_processing_jobs child
      on child.workspace_key = authority.workspace_key
     and child.job_id = authority.model_child_job_id
    join public.source_processing_job_lineage child_lineage
      on child_lineage.workspace_key = child.workspace_key
     and child_lineage.source_system = child.source_system
     and child_lineage.connection_key = child.connection_key
     and child_lineage.job_id = child.job_id
     and child_lineage.parent_job_id = authority.parent_job_id
     and child_lineage.root_batch_id = authority.root_batch_id
     and child_lineage.source_cursor_version = authority.source_cursor_version
     and child_lineage.source_cursor_value = authority.source_cursor_value
    join public.gmail_model_extraction_review_intents intent
      on intent.workspace_key = authority.workspace_key
     and intent.model_child_job_id = authority.model_child_job_id
     and intent.model_plan_id = authority.model_plan_id
    join public.gmail_model_extraction_review_obligations obligation
      on obligation.workspace_key = authority.workspace_key
     and obligation.obligation_id = p_obligation_id
     and obligation.extraction_plan_id = authority.extraction_plan_id
     and obligation.model_plan_id = authority.model_plan_id
     and obligation.model_child_job_id = authority.model_child_job_id
     and obligation.review_job_id = p_review_job_id
     and obligation.reason_code = intent.reason_code
     and obligation.safe_detail_hash = intent.safe_detail_hash
    join public.source_processing_jobs review_job
      on review_job.workspace_key = authority.workspace_key
     and review_job.job_id = obligation.review_job_id
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = review_job.workspace_key
     and review_lineage.source_system = review_job.source_system
     and review_lineage.connection_key = review_job.connection_key
     and review_lineage.job_id = review_job.job_id
     and review_lineage.parent_job_id = child.job_id
     and review_lineage.root_batch_id = child_lineage.root_batch_id
     and review_lineage.root_job_id = child_lineage.root_job_id
     and review_lineage.source_cursor_version = child_lineage.source_cursor_version
     and review_lineage.source_cursor_value = child_lineage.source_cursor_value
    join public.source_processing_job_children review_edge
      on review_edge.parent_job_id = child.job_id
     and review_edge.child_job_id = review_job.job_id
    join public.truth_shadow_claim_acceptance_epochs epoch
      on epoch.workspace_key = authority.workspace_key
     and epoch.epoch_id = authority.predecessor_epoch_id
     and epoch.connection_key = authority.connection_key
     and epoch.root_batch_id = authority.root_batch_id
     and epoch.source_cursor_version = authority.source_cursor_version
     and epoch.source_cursor_value = authority.source_cursor_value
     and epoch.receipt_hash = authority.predecessor_epoch_receipt_hash
    where authority.workspace_key = p_workspace_key
      and authority.authorization_id =
        'truth-shadow-gmail-resumed-model-child:v1:' || authority.authorization_hash
      and authority.authorization_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(authority.canonical_authorization), 'UTF8'
      ), 'sha256'), 'hex')
      and authority.shadow_only = true
      and authority.mutates_operational_state = false
      and authority.production_eligible = false
      and authority.production_publication_attempted = false
      and plan.planning_status = 'complete'
      and plan.planning_failure_code = ''
      -- Production plans for this cohort were sealed in batch mode; both modes
      -- carry the same authority semantics here.
      and plan.execution_mode in ('sync', 'batch')
      and plan.model_plan_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(plan.model_plan - 'modelPlanId' - 'modelPlanHash'),
        'UTF8'
      ), 'sha256'), 'hex')
      and plan.plan_seal_hash = encode(extensions.digest(convert_to(
        plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and epoch.receipt_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(epoch.canonical_receipt), 'UTF8'
      ), 'sha256'), 'hex')
      and epoch.production_publication_attempted = false
      and child.source_system = 'gmail'
      and child.connection_key = authority.connection_key
      and child.connection_key like 'shadow-%'
      and child.job_kind = 'gmail_extract_message_model_claims'
      and child.observation_id = observation.observation_id
      and child.state = 'succeeded'
      and child.completed_at is not null
      and child.lease_owner is null
      and child.lease_expires_at is null
      and child.result->>'schemaVersion' =
        'truth-model-extraction-worker-result-v1'
      and child.result->>'outcome' = 'review_required'
      and child.result->>'modelPlanId' = authority.model_plan_id
      and child.result #>> '{modelTerminal,terminalKind}' = 'review_intent'
      and child.result #>> '{modelTerminal,reviewIntentId}' = intent.intent_id
      and child.result #>> '{modelTerminal,reviewIntentHash}' = intent.intent_hash
      and intent.intent_id = 'gmail-model-review-intent:v1:' || intent.intent_hash
      and intent.intent_hash = encode(extensions.digest(convert_to(
        intent.canonical_intent::text, 'UTF8'
      ), 'sha256'), 'hex')
      and obligation.obligation_id =
        'gmail-model-review:v1:' || obligation.obligation_hash
      and obligation.obligation_hash = encode(extensions.digest(convert_to(
        obligation.canonical_obligation::text, 'UTF8'
      ), 'sha256'), 'hex')
      and review_job.source_system = 'gmail'
      and review_job.connection_key = authority.connection_key
      and review_job.job_kind = 'gmail_review_model_extraction'
      and review_job.observation_id = observation.observation_id
      and review_job.state = 'waiting_runtime'
      and review_job.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.completed_at is null
      and review_job.result = '{}'::jsonb
      and not exists (
        select 1
        from public.gmail_model_extraction_review_resolutions resolution
        where resolution.workspace_key = obligation.workspace_key
          and resolution.obligation_id = obligation.obligation_id
      )
      and not exists (
        select 1
        from public.truth_shadow_root_source_cuts root_cut
        join public.source_cuts source_cut
          on source_cut.workspace_key = root_cut.workspace_key
         and source_cut.source_cut_id = root_cut.source_cut_id
        where root_cut.workspace_key = authority.workspace_key
          and root_cut.root_batch_id = authority.root_batch_id
          and source_cut.completeness = 'complete'
      )
      and (
        (authority.disposition = 'stale_time_binding_review'
          and private.truth_shadow_gmail_old_millisecond_time_binding_v1(
            plan.model_plan, observation.captured_at,
            observation.source_recorded_at
          )
          and intent.authority_kind =
            'shadow_stale_source_time_binding_authority'
          and intent.authority_id = authority.authorization_id
          and intent.authority_hash = authority.authorization_hash
          and intent.reason_code = 'STALE_IMMUTABLE_SOURCE_TIME_BINDING')
        or
        (authority.disposition = 'model_execution'
          and private.truth_shadow_gmail_current_source_time_binding_v1(
            plan.model_plan, observation.captured_at,
            observation.source_recorded_at
          )
          and intent.authority_kind = 'truth_model_request'
          and exists (
            select 1
            from public.truth_model_requests request
            where request.workspace_key = authority.workspace_key
              and request.source_job_id = authority.model_child_job_id
              and request.request_id = intent.authority_id
              and request.request_id = 'model-request:v1:' || request.request_hash
              and request.observation_id = authority.source_observation_id
              and request.observation_content_hash =
                authority.source_observation_content_hash
              and request.plan_hash = authority.model_plan_hash
              and request.prompt_version = plan.prompt_version
              and request.state in ('review_required', 'outcome_unknown')
              and request.review_reason = intent.reason_code
              and intent.authority_hash = encode(extensions.digest(convert_to(
                private.truth_canonical_json_text(jsonb_build_object(
                  'schemaVersion', 'gmail-model-review-authority-v1',
                  'authorityKind', 'truth_model_request',
                  'workspaceKey', authority.workspace_key,
                  'modelPlanId', authority.model_plan_id,
                  'requestId', request.request_id,
                  'requestHash', request.request_hash,
                  'requestState', request.state,
                  'reviewReason', request.review_reason
                )), 'UTF8'
              ), 'sha256'), 'hex')
          ))
      )
  );
$function$;

revoke all on function
  private.truth_shadow_late_gmail_model_review_allowed_v1(text,text,uuid)
  from public, anon, authenticated, service_role;

do $late_review_private_contract$
declare
  v_definition text;
  v_expected constant text := $expected$  if not found or (
    v_review.state not in ('queued','retry_wait','dead_letter')
    and not (
      v_review.state='waiting_runtime'
      and v_review.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED'
    )
  ) then$expected$;
  v_count integer;
begin
  select pg_get_functiondef(
    'private.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  v_count := (length(v_definition) - length(replace(v_definition, v_expected, '')))
    / length(v_expected);
  if v_count <> 1
    or position('truth_shadow_late_gmail_model_review_allowed_v1' in v_definition) > 0 then
    raise exception 'private Gmail model review resolver differs from reviewed parked-runtime contract'
      using errcode = '23514';
  end if;
end;
$late_review_private_contract$;

create or replace function public.resolve_gmail_model_extraction_review(
  p_workspace_key text,
  p_obligation_id text,
  p_decision text,
  p_resolution_evidence_observation_ids jsonb,
  p_decided_by text,
  p_reason text,
  p_idempotency_key text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_review_job_id uuid;
  v_is_late_authority boolean := false;
  v_receipt jsonb;
begin
  select obligation.review_job_id,
         exists (
           select 1
           from public.truth_shadow_gmail_resumed_model_child_authorizations authority
           where authority.workspace_key = obligation.workspace_key
             and (
               authority.model_child_job_id = obligation.model_child_job_id
               or exists (
                 select 1
                 from public.source_processing_job_children review_edge
                 where review_edge.parent_job_id = authority.model_child_job_id
                   and review_edge.child_job_id = obligation.review_job_id
               )
             )
         )
    into v_review_job_id, v_is_late_authority
  from public.gmail_model_extraction_review_obligations obligation
  where obligation.workspace_key = p_workspace_key
    and obligation.obligation_id = p_obligation_id;

  if coalesce(v_is_late_authority, false) then
    if not private.valid_truth_review_token(p_review_token)
      or not private.valid_truth_sync_token(p_sync_token) then
      raise exception 'invalid Gmail model review authority'
        using errcode = '28000';
    end if;
    perform private.truth_source_cut_serialization_lock(p_workspace_key);
    if not private.truth_shadow_late_gmail_model_review_allowed_v1(
        p_workspace_key, p_obligation_id, v_review_job_id
      ) and not exists (
        select 1
        from public.gmail_model_extraction_review_resolutions resolution
        where resolution.workspace_key = p_workspace_key
          and resolution.obligation_id = p_obligation_id
      ) then
      raise exception 'late Gmail model review child is not available for explicit resolution'
        using errcode = '40001';
    end if;
  end if;

  v_receipt := private.resolve_gmail_model_extraction_review(
    p_workspace_key,
    p_obligation_id,
    p_decision,
    p_resolution_evidence_observation_ids,
    p_decided_by,
    p_reason,
    p_idempotency_key,
    p_review_token,
    p_sync_token
  );
  if coalesce(v_is_late_authority, false) then
    return v_receipt || jsonb_build_object(
      'lateModelReviewAuthorityVerified', true,
      'lateReviewJobId', v_review_job_id,
      'productionPublicationAttempted', false
    );
  end if;
  return v_receipt;
end;
$function$;

revoke all on function private.resolve_gmail_model_extraction_review(
  text,text,text,jsonb,text,text,text,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_gmail_model_extraction_review(
  text,text,text,jsonb,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.resolve_gmail_model_extraction_review(
  text,text,text,jsonb,text,text,text,text,text
) to service_role;

-- The worker diverts the seven stale timestamp bindings before request
-- materialization.  Enforce the same zero-spend boundary at the database
-- ingress so a future or divergent privileged worker cannot reserve/provider-
-- dispatch one of those review-only children.
create or replace function private.reject_truth_shadow_stale_gmail_model_request_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key = new.workspace_key
      and authority.model_child_job_id = new.source_job_id
      and authority.disposition = 'stale_time_binding_review'
      and authority.shadow_only = true
      and authority.mutates_operational_state = false
      and authority.production_eligible = false
      and authority.production_publication_attempted = false
  ) then
    raise exception 'stale-bound shadow Gmail model child is review-only'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists aa_truth_shadow_stale_gmail_model_request_quarantine
  on public.truth_model_requests;
create trigger aa_truth_shadow_stale_gmail_model_request_quarantine
before insert on public.truth_model_requests
for each row execute function
  private.reject_truth_shadow_stale_gmail_model_request_v1();
revoke all on function private.reject_truth_shadow_stale_gmail_model_request_v1()
  from public, anon, authenticated, service_role;

analyze public.truth_shadow_gmail_resumed_model_child_authorizations;
analyze public.source_processing_jobs;

do $verify$
declare
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_public_claim regprocedure := to_regprocedure(
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_route regprocedure := to_regprocedure('private.route_gmail_link_claim_wait_v2()');
  v_definition text;
  v_constraint text;
  v_config text[];
  v_count integer;
  v_stale integer;
  v_execution integer;
begin
  if to_regprocedure(
      'private.truth_shadow_gmail_resumed_model_authorized_job_v1(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_child_input_allowed_v3(text,text,uuid,text,text,jsonb)'
    ) is null
    or to_regprocedure(
      'private.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)'
    ) is null
    or to_regprocedure(
      'public.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_late_gmail_model_review_allowed_v1(text,text,uuid)'
    ) is null
    or to_regprocedure(
      'private.reject_truth_shadow_stale_gmail_model_request_v1()'
    ) is null then
    raise exception 'resumed Gmail model terminal functions are incomplete'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_route)) into v_definition;
  if position('truth_shadow_gmail_model_child_input_allowed_v3' in v_definition) = 0
    or position('truth_shadow_gmail_model_child_input_allowed_v2' in v_definition) > 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0 then
    raise exception 'Gmail route did not retain exact v3 and attachment admission'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_claim)) into v_definition;
  if position('scoped_claim_jobs as materialized' in v_definition) = 0
    or position('admitted_claim_jobs as materialized' in v_definition) = 0
    or position('truth_shadow_gmail_model_job_allowed_v3' in v_definition) = 0
    or position('truth_shadow_gmail_model_job_allowed_v2' in v_definition) > 0
    or position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0
    or position('for update of job skip locked' in v_definition) = 0 then
    raise exception 'bounded source-processing claim authority is incomplete'
      using errcode = '23514';
  end if;

  select proconfig into v_config from pg_proc where oid = v_claim;
  if not ('plan_cache_mode=force_custom_plan' = any(coalesce(v_config, array[]::text[])))
    or exists (select 1 from unnest(coalesce(v_config, array[]::text[])) setting
      where setting = 'enable_nestloop=off') then
    raise exception 'private claim function planner settings are unsafe'
      using errcode = '23514';
  end if;
  select proconfig into v_config from pg_proc where oid = v_public_claim;
  if exists (select 1 from unnest(coalesce(v_config, array[]::text[])) setting
      where setting = 'enable_nestloop=off') then
    raise exception 'public claim function retained emergency nested-loop override'
      using errcode = '23514';
  end if;

  select pg_get_constraintdef(constraint_row.oid)
    into v_constraint
  from pg_constraint constraint_row
  where constraint_row.conrelid =
      'public.gmail_model_extraction_review_intents'::regclass
    and constraint_row.conname =
      'gmail_model_extraction_review_intents_authority_kind_check';
  if position('model_plan_execution_mode' in coalesce(v_constraint, '')) = 0
    or position('truth_model_request' in coalesce(v_constraint, '')) = 0
    or position(
      'shadow_stale_source_time_binding_authority' in coalesce(v_constraint, '')
    ) = 0 then
    raise exception 'stale Gmail review authority vocabulary is incomplete'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  if position($expected$  if not found or (
    v_review.state not in ('queued','retry_wait','dead_letter')
    and not (
      v_review.state='waiting_runtime'
      and v_review.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED'
    )
  ) then$expected$ in v_definition) = 0
    or position('truth_shadow_late_gmail_model_review_allowed_v1' in v_definition) > 0 then
    raise exception 'private Gmail model review resolver was not preserved'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'public.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)'::regprocedure
  )) into v_definition;
  if position('truth_shadow_gmail_resumed_model_child_authorizations' in v_definition) = 0
    or position('truth_shadow_late_gmail_model_review_allowed_v1' in v_definition) = 0
    or position('source_processing_job_children' in v_definition) = 0
    or position('latemodelreviewauthorityverified' in v_definition) = 0
    or position('productionpublicationattempted' in v_definition) = 0 then
    raise exception 'public late Gmail model review authority gate is incomplete'
      using errcode = '23514';
  end if;

  if has_function_privilege(
      'anon',
      'public.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)',
      'EXECUTE'
    ) or has_function_privilege(
      'authenticated',
      'public.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)',
      'EXECUTE'
    ) or not has_function_privilege(
      'service_role',
      'public.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)',
      'EXECUTE'
    ) then
    raise exception 'public late Gmail model review authority ACL is unsafe'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from unnest(array[
      'private.truth_shadow_gmail_old_millisecond_time_binding_v1(jsonb,timestamptz,timestamptz)',
      'private.truth_shadow_gmail_current_source_time_binding_v1(jsonb,timestamptz,timestamptz)',
      'private.truth_shadow_gmail_resumed_model_authorized_job_v1(text,uuid)',
      'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)',
      'private.truth_shadow_gmail_model_child_input_allowed_v3(text,text,uuid,text,text,jsonb)',
      'private.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)',
      'private.truth_shadow_late_gmail_model_review_allowed_v1(text,text,uuid)',
      'private.reject_truth_shadow_stale_gmail_model_request_v1()'
    ]) signature
    where has_function_privilege('anon', signature, 'EXECUTE')
       or has_function_privilege('authenticated', signature, 'EXECUTE')
       or has_function_privilege('service_role', signature, 'EXECUTE')
  ) then
    raise exception 'private resumed Gmail model terminal authority leaked execute privilege'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.truth_model_requests'::regclass
      and trigger_row.tgname =
        'aa_truth_shadow_stale_gmail_model_request_quarantine'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
  ) then
    raise exception 'stale Gmail model request quarantine is unavailable'
      using errcode = '23514';
  end if;
  if has_function_privilege(
      'anon',
      'public.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)',
      'EXECUTE'
    ) or has_function_privilege(
      'authenticated',
      'public.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)',
      'EXECUTE'
    ) or not has_function_privilege(
      'service_role',
      'public.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)',
      'EXECUTE'
    ) then
    raise exception 'public stale Gmail review RPC ACL is unsafe'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.source_ingest_batches batch
    where batch.workspace_key = 'primary'
      and batch.source_system = 'gmail'
      and batch.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
      and batch.batch_id = 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
  ) then
    select count(*)::integer,
           count(*) filter (where disposition = 'stale_time_binding_review')::integer,
           count(*) filter (where disposition = 'model_execution')::integer
      into v_count, v_stale, v_execution
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key = 'primary'
      and authority.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
      and authority.root_batch_id =
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
    if (v_count, v_stale, v_execution) is distinct from (10, 7, 3) then
      raise exception 'resumed Gmail model terminal authority failed exact 10/7/3 read-back'
        using errcode = '23514';
    end if;
  end if;

  if lower(pg_get_functiondef(
      'private.create_truth_shadow_stale_gmail_model_review(text,uuid,text,bigint,text,text,text)'::regprocedure
    )) like '%' || 'shipment-' || 'truth-packets' || '%'
    or lower(pg_get_functiondef(
      'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)'::regprocedure
    )) like '%' || 'shipment-' || 'truth-packets' || '%'
    or lower(pg_get_functiondef(
      'private.truth_shadow_late_gmail_model_review_allowed_v1(text,text,uuid)'::regprocedure
    )) like '%' || 'shipment-' || 'truth-packets' || '%' then
    raise exception 'resumed Gmail model terminal authority references live-board state'
      using errcode = '23514';
  end if;
end;
$verify$;
