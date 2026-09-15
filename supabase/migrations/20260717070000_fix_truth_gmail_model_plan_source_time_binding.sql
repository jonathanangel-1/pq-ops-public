-- Recover only the shadow Gmail model-commissioning parent replays that spent
-- attempts on the pre-fix sourceRecordedAt precision mismatch.
--
-- The SQL sealer correctly binds a present model plan to the worker context's
-- fixed six-digit UTC timestamp.  The matching JS fix preserves that exact
-- representation.  This migration does not weaken or replace the sealer: it
-- appends one immutable authorization per affected successor, preserves the
-- attempt/fence/payload/lineage history, and grants three bounded attempts for
-- the repaired parent to seal and release its server-derived model child.

create schema if not exists private;

do $preflight$
declare
  v_replay_validator regprocedure := to_regprocedure(
    'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)'
  );
  v_parent_admission regprocedure := to_regprocedure(
    'private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(text,uuid)'
  );
  v_definition text;
begin
  if v_replay_validator is null
    or v_parent_admission is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_scopes') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.candidate_claim_job_lineage') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null
    or to_regclass('public.truth_model_requests') is null then
    raise exception 'shadow Gmail model-plan binding recovery prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_replay_validator)) into v_definition;
  if (
      position('successor.state <> ''superseded''' in v_definition) = 0
      and position('v_successor.state = ''superseded''' in v_definition) = 0
    )
    or (
      position('replay.successor_payload' in v_definition) = 0
      and position('v_replay.successor_payload' in v_definition) = 0
    )
    or (
      position('replay.source_observation_content_hash' in v_definition) = 0
      and position('v_replay.source_observation_content_hash' in v_definition) = 0
    )
    or (
      position('production_publication_attempted = false' in v_definition) = 0
      and position('v_replay.production_publication_attempted' in v_definition) = 0
    ) then
    raise exception 'shadow Gmail commissioning replay validator differs from its reviewed contract'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_parent_admission)) into v_definition;
  if position('successor.state not in (''dead_letter'', ''superseded'')' in v_definition) = 0
    or position('truth_shadow_claim_acceptance_epochs' in v_definition) = 0
    or position('truth_shadow_root_source_cuts' in v_definition) = 0
    or position('truth_publications' in v_definition) = 0 then
    raise exception 'shadow Gmail commissioning parent admission differs from its reviewed contract'
      using errcode = '23514';
  end if;
end;
$preflight$;

create or replace function private.truth_shadow_gmail_model_plan_binding_failure_v1(
  p_error_code text,
  p_safe_error_detail text
)
returns boolean
language plpgsql
immutable
strict
security definer
set search_path = ''
as $function$
declare
  v_detail jsonb;
begin
  if p_error_code <> 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED' then
    return false;
  end if;
  v_detail := p_safe_error_detail::jsonb;
  return jsonb_typeof(v_detail) = 'object'
    and v_detail->>'schemaVersion' = 'truth-gmail-parent-planning-failure-v2'
    and v_detail->>'errorCode' = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingCode' = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'postgresCode' = '23514'
    and v_detail->>'postgresMessage' =
      'Gmail model plan is invalid or not bound to immutable source text'
    and position(
      'Gmail model plan is invalid or not bound to immutable source text'
      in coalesce(v_detail->>'underlyingMessage', '')
    ) > 0
    and v_detail->>'jobKind' = 'gmail_extract_message_claims';
exception when others then
  return false;
end;
$function$;

revoke all on function private.truth_shadow_gmail_model_plan_binding_failure_v1(
  text, text
) from public, anon, authenticated, service_role;

create table if not exists public.truth_shadow_gmail_model_plan_binding_retry_authorizations (
  authorization_id text primary key check (
    authorization_id ~ '^truth-shadow-gmail-plan-binding-retry:v1:[0-9a-f]{64}$'
  ),
  authorization_hash text not null unique check (
    authorization_hash ~ '^[0-9a-f]{64}$'
  ),
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  commissioning_scope_id text not null,
  replay_id text not null,
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  successor_parent_job_id uuid not null unique,
  source_observation_id text not null,
  prior_state text not null check (prior_state in ('retry_wait', 'dead_letter')),
  prior_attempt_count integer not null check (prior_attempt_count > 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  prior_lease_fence bigint not null check (prior_lease_fence > 0),
  prior_error_code text not null check (
    prior_error_code = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check (
    prior_error_detail_hash ~ '^[0-9a-f]{64}$'
  ),
  authorized_max_attempts integer not null check (
    authorized_max_attempts >= prior_max_attempts
    and authorized_max_attempts >= prior_attempt_count + 3
  ),
  canonical_authorization jsonb not null check (
    jsonb_typeof(canonical_authorization) = 'object'
  ),
  schema_version text not null check (
    schema_version = 'truth-shadow-gmail-model-plan-binding-retry-authorization-v1'
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
  foreign key (workspace_key, commissioning_scope_id)
    references public.truth_shadow_gmail_model_commissioning_scopes(
      workspace_key, commissioning_scope_id
    ) on update restrict on delete restrict,
  foreign key (workspace_key, replay_id)
    references public.truth_shadow_gmail_model_commissioning_replays(
      workspace_key, replay_id
    ) on update restrict on delete restrict,
  foreign key (workspace_key, successor_parent_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  check (authorization_id =
    'truth-shadow-gmail-plan-binding-retry:v1:' || authorization_hash),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_authorization->>'schemaVersion' =
    'truth-shadow-gmail-model-plan-binding-retry-authorization-v1'),
  check (canonical_authorization->>'workspaceKey' = workspace_key),
  check (canonical_authorization->>'commissioningScopeId' = commissioning_scope_id),
  check (canonical_authorization->>'replayId' = replay_id),
  check (canonical_authorization->>'connectionKey' = connection_key),
  check (canonical_authorization->>'rootBatchId' = root_batch_id::text),
  check (canonical_authorization->>'successorParentJobId' =
    successor_parent_job_id::text),
  check (canonical_authorization->>'sourceObservationId' = source_observation_id),
  check (canonical_authorization->>'priorState' = prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer =
    prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer =
    prior_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint =
    prior_lease_fence),
  check (canonical_authorization->>'priorErrorCode' = prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash' =
    prior_error_detail_hash),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer =
    authorized_max_attempts),
  check (canonical_authorization->>'reasonCode' =
    'IMMUTABLE_SOURCE_TIME_BINDING_CANONICALIZATION'),
  check (canonical_authorization->>'shadowOnly' = 'true'),
  check (canonical_authorization->>'mutatesOperationalState' = 'false'),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
);

create index if not exists truth_shadow_gmail_plan_binding_retry_scope_idx
  on public.truth_shadow_gmail_model_plan_binding_retry_authorizations(
    workspace_key, connection_key, root_batch_id, successor_parent_job_id
  );

drop trigger if exists truth_shadow_gmail_model_plan_binding_retry_authorizations_immutable
  on public.truth_shadow_gmail_model_plan_binding_retry_authorizations;
create trigger truth_shadow_gmail_model_plan_binding_retry_authorizations_immutable
before update or delete
on public.truth_shadow_gmail_model_plan_binding_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_shadow_gmail_model_plan_binding_retry_authorizations
  enable row level security;
alter table public.truth_shadow_gmail_model_plan_binding_retry_authorizations
  force row level security;
revoke all on table public.truth_shadow_gmail_model_plan_binding_retry_authorizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_shadow_gmail_model_plan_binding_retry_authorizations
  to service_role;

do $authorize_exact_shadow_root$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root_batch constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
  v_candidate record;
  v_authorization jsonb;
  v_authorization_hash text;
  v_authorization_id text;
  v_authorized_max_attempts integer;
  v_inserted integer;
  v_updated integer;
  v_readback record;
begin
  if exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_scopes scope_row
    where scope_row.workspace_key = v_workspace
      and scope_row.source_system = 'gmail'
      and scope_row.connection_key = v_connection
      and scope_row.root_batch_id = v_root_batch
      and scope_row.shadow_only = true
      and scope_row.production_eligible = false
      and scope_row.production_publication_attempted = false
  ) then
    perform private.truth_source_cut_mutation_lock(v_workspace);

    for v_candidate in
      select
        replay.commissioning_scope_id,
        replay.replay_id,
        replay.source_observation_id,
        successor.job_id as successor_parent_job_id,
        successor.state as prior_state,
        successor.attempt_count as prior_attempt_count,
        successor.max_attempts as prior_max_attempts,
        successor.lease_fence as prior_lease_fence,
        successor.last_error_code as prior_error_code,
        encode(extensions.digest(convert_to(
          successor.safe_error_detail, 'UTF8'
        ), 'sha256'), 'hex') as prior_error_detail_hash
      from public.truth_shadow_gmail_model_commissioning_replays replay
      join public.truth_shadow_gmail_model_commissioning_scopes scope_row
        on scope_row.workspace_key = replay.workspace_key
       and scope_row.commissioning_scope_id = replay.commissioning_scope_id
      join public.source_processing_jobs successor
        on successor.workspace_key = replay.workspace_key
       and successor.job_id = replay.successor_parent_job_id
      join public.source_processing_job_lineage successor_lineage
        on successor_lineage.workspace_key = successor.workspace_key
       and successor_lineage.job_id = successor.job_id
      where replay.workspace_key = v_workspace
        and replay.connection_key = v_connection
        and replay.root_batch_id = v_root_batch
        and replay.shadow_only = true
        and replay.production_eligible = false
        and replay.production_publication_attempted = false
        and scope_row.source_system = 'gmail'
        and scope_row.connection_key = v_connection
        and scope_row.root_batch_id = v_root_batch
        and scope_row.execution_mode = 'sync'
        and scope_row.shadow_only = true
        and scope_row.production_eligible = false
        and scope_row.production_publication_attempted = false
        and successor.source_system = 'gmail'
        and successor.connection_key = v_connection
        and successor.job_kind = 'gmail_extract_message_claims'
        and successor.observation_id = replay.source_observation_id
        and successor.payload = replay.successor_payload
        and successor.state in ('retry_wait', 'dead_letter')
        and successor.attempt_count > 0
        and successor.lease_fence > 0
        and successor.lease_owner is null
        and successor.lease_expires_at is null
        and successor.result = '{}'::jsonb
        and (
          (successor.state = 'retry_wait' and successor.completed_at is null)
          or (successor.state = 'dead_letter'
            and successor.attempt_count >= successor.max_attempts
            and successor.completed_at is not null)
        )
        and private.truth_shadow_gmail_model_plan_binding_failure_v1(
          successor.last_error_code, successor.safe_error_detail
        )
        and successor_lineage.root_batch_id = replay.root_batch_id
        and successor_lineage.parent_job_id = replay.original_parent_job_id
        and successor_lineage.root_job_id = replay.root_job_id
        and successor_lineage.source_cursor_version = replay.source_cursor_version
        and successor_lineage.source_cursor_value = replay.source_cursor_value
        and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
          replay.workspace_key, replay.obligation_id
        )
        and not exists (
          select 1 from public.truth_shadow_claim_acceptance_epochs epoch
          where epoch.workspace_key = replay.workspace_key
            and epoch.root_batch_id = replay.root_batch_id
        )
        and not exists (
          select 1 from public.truth_shadow_root_source_cuts root_cut
          where root_cut.workspace_key = replay.workspace_key
            and root_cut.root_batch_id = replay.root_batch_id
        )
        and not exists (
          select 1
          from public.truth_builds build
          join public.truth_shadow_root_source_cuts root_cut
            on root_cut.workspace_key = build.workspace_key
           and root_cut.source_cut_id = build.source_cut_id
          where root_cut.workspace_key = replay.workspace_key
            and root_cut.root_batch_id = replay.root_batch_id
        )
        and not exists (
          select 1
          from public.truth_publications publication
          join public.truth_shadow_root_source_cuts root_cut
            on root_cut.workspace_key = publication.workspace_key
           and root_cut.source_cut_id = publication.source_cut_id
          where root_cut.workspace_key = replay.workspace_key
            and root_cut.root_batch_id = replay.root_batch_id
        )
        and not exists (
          select 1
          from public.truth_shadow_gmail_model_plan_binding_retry_authorizations auth_row
          where auth_row.workspace_key = replay.workspace_key
            and auth_row.successor_parent_job_id = successor.job_id
        )
        and not exists (
          select 1 from public.gmail_model_extraction_plans plan_row
          where plan_row.workspace_key = successor.workspace_key
            and plan_row.parent_job_id = successor.job_id
        )
        and not exists (
          select 1 from public.gmail_model_extraction_context_seals context_row
          where context_row.workspace_key = successor.workspace_key
            and context_row.parent_job_id = successor.job_id
        )
        and not exists (
          select 1 from public.candidate_claim_job_manifests manifest
          where manifest.workspace_key = successor.workspace_key
            and manifest.job_id = successor.job_id
        )
        and not exists (
          select 1 from public.candidate_claim_job_lineage candidate_lineage
          where candidate_lineage.job_id = successor.job_id
        )
        and not exists (
          select 1 from public.source_processing_job_children child_link
          where child_link.parent_job_id = successor.job_id
        )
        and not exists (
          select 1 from public.truth_pending_acceptance_epoch_manifests pending_manifest
          where pending_manifest.workspace_key = successor.workspace_key
            and pending_manifest.source_job_id = successor.job_id
        )
        and not exists (
          select 1 from public.truth_model_requests request_row
          where request_row.workspace_key = successor.workspace_key
            and request_row.source_job_id = successor.job_id
        )
      order by successor.job_id
      for update of successor
    loop
      v_authorized_max_attempts := greatest(
        v_candidate.prior_max_attempts,
        v_candidate.prior_attempt_count + 3
      );
      v_authorization := jsonb_build_object(
        'schemaVersion',
          'truth-shadow-gmail-model-plan-binding-retry-authorization-v1',
        'workspaceKey', v_workspace,
        'commissioningScopeId', v_candidate.commissioning_scope_id,
        'replayId', v_candidate.replay_id,
        'connectionKey', v_connection,
        'rootBatchId', v_root_batch,
        'successorParentJobId', v_candidate.successor_parent_job_id,
        'sourceObservationId', v_candidate.source_observation_id,
        'priorState', v_candidate.prior_state,
        'priorAttemptCount', v_candidate.prior_attempt_count,
        'priorMaxAttempts', v_candidate.prior_max_attempts,
        'priorLeaseFence', v_candidate.prior_lease_fence,
        'priorErrorCode', v_candidate.prior_error_code,
        'priorErrorDetailHash', v_candidate.prior_error_detail_hash,
        'authorizedMaxAttempts', v_authorized_max_attempts,
        'reasonCode', 'IMMUTABLE_SOURCE_TIME_BINDING_CANONICALIZATION',
        'shadowOnly', true,
        'mutatesOperationalState', false,
        'productionPublicationAttempted', false
      );
      v_authorization_hash := encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_authorization), 'UTF8'
      ), 'sha256'), 'hex');
      v_authorization_id :=
        'truth-shadow-gmail-plan-binding-retry:v1:' || v_authorization_hash;

      insert into public.truth_shadow_gmail_model_plan_binding_retry_authorizations(
        authorization_id, authorization_hash, workspace_key,
        commissioning_scope_id, replay_id, connection_key, root_batch_id,
        successor_parent_job_id, source_observation_id, prior_state,
        prior_attempt_count, prior_max_attempts, prior_lease_fence,
        prior_error_code, prior_error_detail_hash, authorized_max_attempts,
        canonical_authorization, schema_version, shadow_only,
        mutates_operational_state, production_eligible,
        production_publication_attempted
      ) values (
        v_authorization_id, v_authorization_hash, v_workspace,
        v_candidate.commissioning_scope_id, v_candidate.replay_id,
        v_connection, v_root_batch, v_candidate.successor_parent_job_id,
        v_candidate.source_observation_id, v_candidate.prior_state,
        v_candidate.prior_attempt_count, v_candidate.prior_max_attempts,
        v_candidate.prior_lease_fence, v_candidate.prior_error_code,
        v_candidate.prior_error_detail_hash, v_authorized_max_attempts,
        v_authorization,
        'truth-shadow-gmail-model-plan-binding-retry-authorization-v1',
        true, false, false, false
      ) on conflict (successor_parent_job_id) do nothing;
      get diagnostics v_inserted = row_count;
      if v_inserted <> 1 then
        raise exception 'model-plan retry authorization identity conflicted'
          using errcode = '23505';
      end if;

      update public.source_processing_jobs successor
      set state = 'retry_wait',
          max_attempts = v_authorized_max_attempts,
          available_at = clock_timestamp(),
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = 'GMAIL_MODEL_PLAN_BINDING_RETRY_AUTHORIZED',
          safe_error_detail =
            'Exact shadow commissioning replay reauthorized after immutable source-time binding repair.',
          updated_at = clock_timestamp(),
          completed_at = null
      where successor.workspace_key = v_workspace
        and successor.job_id = v_candidate.successor_parent_job_id
        and successor.connection_key = v_connection
        and successor.job_kind = 'gmail_extract_message_claims'
        and successor.state = v_candidate.prior_state
        and successor.attempt_count = v_candidate.prior_attempt_count
        and successor.max_attempts = v_candidate.prior_max_attempts
        and successor.lease_fence = v_candidate.prior_lease_fence
        and successor.lease_owner is null
        and successor.lease_expires_at is null
        and successor.last_error_code = v_candidate.prior_error_code
        and encode(extensions.digest(convert_to(
          successor.safe_error_detail, 'UTF8'
        ), 'sha256'), 'hex') = v_candidate.prior_error_detail_hash
        and successor.result = '{}'::jsonb;
      get diagnostics v_updated = row_count;
      if v_updated <> 1 then
        raise exception 'model-plan retry target changed during authorization'
          using errcode = '40001';
      end if;

      select state, attempt_count, max_attempts, lease_fence, lease_owner,
        lease_expires_at, completed_at, last_error_code, result
      into v_readback
      from public.source_processing_jobs
      where workspace_key = v_workspace
        and job_id = v_candidate.successor_parent_job_id;
      if v_readback.state <> 'retry_wait'
        or v_readback.attempt_count <> v_candidate.prior_attempt_count
        or v_readback.max_attempts <> v_authorized_max_attempts
        or v_readback.lease_fence <> v_candidate.prior_lease_fence
        or v_readback.lease_owner is not null
        or v_readback.lease_expires_at is not null
        or v_readback.completed_at is not null
        or v_readback.last_error_code <>
          'GMAIL_MODEL_PLAN_BINDING_RETRY_AUTHORIZED'
        or v_readback.result <> '{}'::jsonb then
        raise exception 'model-plan retry authorization failed its exact read-back'
          using errcode = '23514';
      end if;
    end loop;
  end if;
end;
$authorize_exact_shadow_root$;

analyze public.truth_shadow_gmail_model_plan_binding_retry_authorizations;
analyze public.source_processing_jobs;

do $verify$
declare
  v_helper regprocedure := to_regprocedure(
    'private.truth_shadow_gmail_model_plan_binding_failure_v1(text,text)'
  );
  v_definition text;
  v_rls record;
begin
  if v_helper is null then
    raise exception 'model-plan binding failure classifier is unavailable'
      using errcode = '23514';
  end if;
  select lower(pg_get_functiondef(v_helper)) into v_definition;
  if position('truth-gmail-parent-planning-failure-v2' in v_definition) = 0
    or position('truth_gmail_model_plan_rpc_failed' in v_definition) = 0
    or position('postgrescode' in v_definition) = 0
    or position('23514' in v_definition) = 0
    or position('not bound to immutable source text' in v_definition) = 0 then
    raise exception 'model-plan binding failure classifier is incomplete'
      using errcode = '23514';
  end if;

  select catalog.relrowsecurity as rls_enabled,
    catalog.relforcerowsecurity as rls_forced,
    has_table_privilege('service_role', catalog.oid, 'select') as service_select,
    has_table_privilege('service_role', catalog.oid, 'insert') as service_insert,
    has_table_privilege('service_role', catalog.oid, 'update') as service_update
  into v_rls
  from pg_catalog.pg_class catalog
  where catalog.oid =
    'public.truth_shadow_gmail_model_plan_binding_retry_authorizations'::regclass;
  if v_rls.rls_enabled is distinct from true
    or v_rls.rls_forced is distinct from true
    or v_rls.service_select is distinct from true
    or v_rls.service_insert is distinct from false
    or v_rls.service_update is distinct from false then
    raise exception 'model-plan retry authorizations are not RLS-sealed read-only evidence'
      using errcode = '23514';
  end if;

  if not exists (
      select 1 from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid =
        'public.truth_shadow_gmail_model_plan_binding_retry_authorizations'::regclass
        and trigger_row.tgname =
          'truth_shadow_gmail_model_plan_binding_retry_authorizations_immutable'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled = 'O'
    )
    or has_function_privilege(
      'service_role',
      'private.truth_shadow_gmail_model_plan_binding_failure_v1(text,text)',
      'execute'
    ) then
    raise exception 'model-plan retry authorization immutability or helper ACL is incomplete'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_model_plan_binding_retry_authorizations auth_row
    where auth_row.authorization_id <>
        'truth-shadow-gmail-plan-binding-retry:v1:' || auth_row.authorization_hash
      or auth_row.authorization_hash <> encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth_row.canonical_authorization),
        'UTF8'
      ), 'sha256'), 'hex')
      or auth_row.shadow_only is distinct from true
      or auth_row.mutates_operational_state is distinct from false
      or auth_row.production_eligible is distinct from false
      or auth_row.production_publication_attempted is distinct from false
      or auth_row.canonical_authorization->>'productionPublicationAttempted'
        <> 'false'
  ) then
    raise exception 'stored model-plan retry authorization failed integrity read-back'
      using errcode = '23514';
  end if;
end;
$verify$;
