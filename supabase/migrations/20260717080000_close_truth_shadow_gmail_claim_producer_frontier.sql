-- Close the final shadow Gmail claim-producer frontier without weakening any
-- canonical or publication authority.
--
-- 1. Reauthorize only exact commissioning successors that exhausted attempts
--    under the legacy three-field source-time binding failure envelope.
-- 2. Append an immutable supersession authority when an explicit attachment
--    resolution has already discharged a sibling attachment-claim producer.
-- 3. Resolve attachment/model review children by their exact active job rather
--    than an ambiguous historical obligation/child row.
--
-- Every mutation is limited to the named, unregistered shadow Gmail root. No
-- source cut, build, publication, or operational state is written.

create schema if not exists private;

do $preflight$
declare
  v_acceptance regprocedure := to_regprocedure(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
  );
  v_attachment_resolver regprocedure := to_regprocedure(
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'
  );
  v_definition text;
begin
  if to_regprocedure(
      'private.truth_shadow_gmail_model_plan_binding_failure_v1(text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)'
    ) is null
    or to_regprocedure(
      'private.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)'
    ) is null
    or to_regprocedure(
      'private.unresolved_gmail_attachment_extraction_v1(text,uuid,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_jsonb_has_only_keys(jsonb,text[])') is null
    or v_acceptance is null
    or v_attachment_resolver is null
    or to_regclass(
      'public.truth_shadow_gmail_model_plan_binding_retry_authorizations'
    ) is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_scopes') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regclass('public.gmail_attachment_extraction_resolutions') is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.gmail_model_extraction_review_resolutions') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_processing_job_children') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.candidate_claim_job_lineage') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null then
    raise exception 'shadow Gmail producer-frontier closure prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_acceptance)) into v_definition;
  if position('model_commissioning_frontier_open' in v_definition) = 0
    or position('claim_producer_frontier_open' in v_definition) = 0
    or position('claim_frontier_manifest_incomplete' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0 then
    raise exception 'shadow acceptance coordinator differs from its reviewed predecessor'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_attachment_resolver)) into v_definition;
  if (
      position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) = 0
      and position('bounded_exact_attachment_review_child_v1' in v_definition) = 0
    )
    or position('attachment review child is not available for explicit resolution' in v_definition) = 0 then
    raise exception 'attachment review resolver differs from its reviewed predecessor'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- Historical parent-planning failures used a deliberately small v1 envelope.
-- The richer v2 envelope added PostgreSQL detail later. Both identify the same
-- pre-provider binding rejection, but v1 must match exactly three keys so this
-- recovery cannot become a generic dead-letter reset.
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
  if jsonb_typeof(v_detail) <> 'object' then
    return false;
  end if;

  if v_detail->>'schemaVersion' = 'truth-gmail-parent-planning-failure-v1' then
    return private.truth_jsonb_has_only_keys(v_detail, array[
      'schemaVersion', 'errorCode', 'jobKind'
    ])
      and (select count(*) from jsonb_object_keys(v_detail)) = 3
      and v_detail->>'errorCode' = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and v_detail->>'jobKind' = 'gmail_extract_message_claims';
  end if;

  return v_detail->>'schemaVersion' = 'truth-gmail-parent-planning-failure-v2'
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

-- Reuse the immutable 070000 authorization ledger. The selector is identical
-- to that reviewed recovery except that the classifier now also recognizes the
-- exact legacy v1 envelope that survived in production.
do $reauthorize_exact_legacy_replays$
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
          select 1 from public.truth_pending_acceptance_epoch_manifests membership
          where membership.workspace_key = successor.workspace_key
            and membership.source_job_id = successor.job_id
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
        raise exception 'legacy model-plan retry authorization identity conflicted'
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
        raise exception 'legacy model-plan retry target changed during authorization'
          using errcode = '40001';
      end if;
    end loop;
  end if;
end;
$reauthorize_exact_legacy_replays$;

-- An attachment review resolution and its sibling claim job are distinct
-- obligations. This immutable authority records why the claim producer may be
-- superseded: the operator explicitly resolved the exact source bytes, and no
-- candidate/manifest write ever began for that claim job. The decision and all
-- replacement evidence IDs remain visible in the supersession receipt.
create unique index if not exists gmail_attachment_resolution_workspace_id_uq
  on public.gmail_attachment_extraction_resolutions(
    workspace_key, resolution_id
  );

create table if not exists public.truth_shadow_gmail_attachment_claim_resolution_supersessions (
  supersession_id text primary key check (
    supersession_id ~ '^truth-shadow-gmail-attachment-claim-supersession:v1:[0-9a-f]{64}$'
  ),
  supersession_hash text not null unique check (
    supersession_hash ~ '^[0-9a-f]{64}$'
  ),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  claim_job_id uuid not null unique,
  review_job_id uuid not null,
  resolution_id text not null unique,
  attachment_observation_id text not null,
  attachment_content_hash text not null check (
    attachment_content_hash ~ '^[0-9a-f]{64}$'
  ),
  decision text not null check (decision = any(array[
    'reviewed_non_operational', 'operational_evidence_recorded'
  ])),
  resolution_evidence_observation_ids jsonb not null check (
    jsonb_typeof(resolution_evidence_observation_ids) = 'array'
  ),
  prior_state text not null check (prior_state = any(array[
    'queued', 'retry_wait', 'waiting_runtime', 'leased', 'dead_letter'
  ])),
  prior_attempt_count integer not null check (prior_attempt_count >= 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  prior_lease_fence bigint not null check (prior_lease_fence >= 0),
  prior_lease_owner text,
  prior_lease_expires_at timestamptz,
  canonical_supersession jsonb not null check (
    jsonb_typeof(canonical_supersession) = 'object'
  ),
  canonical_job_result jsonb not null check (
    jsonb_typeof(canonical_job_result) = 'object'
  ),
  job_result_hash text not null unique check (job_result_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-gmail-attachment-claim-resolution-supersession-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  mutates_operational_state boolean not null default false check (
    mutates_operational_state = false
  ),
  production_eligible boolean not null default false check (
    production_eligible = false
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_key, claim_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, review_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, attachment_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, resolution_id)
    references public.gmail_attachment_extraction_resolutions(
      workspace_key, resolution_id
    ) on update restrict on delete restrict,
  check (supersession_id =
    'truth-shadow-gmail-attachment-claim-supersession:v1:' || supersession_hash),
  check (supersession_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_supersession), 'UTF8'
  ), 'sha256'), 'hex')),
  check (job_result_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_job_result), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_supersession->>'schemaVersion' = schema_version),
  check (canonical_supersession->>'workspaceKey' = workspace_key),
  check (canonical_supersession->>'connectionKey' = connection_key),
  check (canonical_supersession->>'rootBatchId' = root_batch_id::text),
  check (canonical_supersession->>'claimJobId' = claim_job_id::text),
  check (canonical_supersession->>'reviewJobId' = review_job_id::text),
  check (canonical_supersession->>'resolutionId' = resolution_id),
  check (canonical_supersession->>'attachmentObservationId' =
    attachment_observation_id),
  check (canonical_supersession->>'attachmentContentHash' =
    attachment_content_hash),
  check (canonical_supersession->>'decision' = decision),
  check (canonical_supersession->'resolutionEvidenceObservationIds' =
    resolution_evidence_observation_ids),
  check (canonical_supersession->>'priorState' = prior_state),
  check ((canonical_supersession->>'priorAttemptCount')::integer =
    prior_attempt_count),
  check ((canonical_supersession->>'priorMaxAttempts')::integer =
    prior_max_attempts),
  check ((canonical_supersession->>'priorLeaseFence')::bigint =
    prior_lease_fence),
  check (canonical_supersession->>'reasonCode' =
    'EXPLICIT_ATTACHMENT_EXTRACTION_RESOLUTION'),
  check (canonical_supersession->>'shadowOnly' = 'true'),
  check (canonical_supersession->>'mutatesOperationalState' = 'false'),
  check (canonical_supersession->>'productionPublicationAttempted' = 'false'),
  check (canonical_job_result->>'schemaVersion' =
    'truth-shadow-gmail-attachment-claim-supersession-result-v1'),
  check (canonical_job_result->>'supersessionId' = supersession_id),
  check (canonical_job_result->>'resolutionId' = resolution_id),
  check (canonical_job_result->>'reviewJobId' = review_job_id::text),
  check (canonical_job_result->>'sourceObservationId' =
    attachment_observation_id),
  check (canonical_job_result->>'sourceObservationContentHash' =
    attachment_content_hash),
  check (canonical_job_result->>'decision' = decision),
  check (canonical_job_result->'resolutionEvidenceObservationIds' =
    resolution_evidence_observation_ids),
  check (canonical_job_result->>'candidateCount' = '0'),
  check (canonical_job_result->>'disposition' =
    'superseded_by_explicit_attachment_resolution'),
  check (canonical_job_result->>'shadowOnly' = 'true'),
  check (canonical_job_result->>'productionPublicationAttempted' = 'false')
);

create index if not exists truth_shadow_gmail_attachment_claim_supersession_scope_idx
  on public.truth_shadow_gmail_attachment_claim_resolution_supersessions(
    workspace_key, connection_key, root_batch_id, claim_job_id
  );

drop trigger if exists truth_shadow_gmail_attachment_claim_resolution_supersessions_immutable
  on public.truth_shadow_gmail_attachment_claim_resolution_supersessions;
create trigger truth_shadow_gmail_attachment_claim_resolution_supersessions_immutable
before update or delete
on public.truth_shadow_gmail_attachment_claim_resolution_supersessions
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_shadow_gmail_attachment_claim_resolution_supersessions
  enable row level security;
alter table public.truth_shadow_gmail_attachment_claim_resolution_supersessions
  force row level security;
revoke all on table public.truth_shadow_gmail_attachment_claim_resolution_supersessions
  from public, anon, authenticated, service_role;
grant select on table public.truth_shadow_gmail_attachment_claim_resolution_supersessions
  to service_role;

create or replace function private.apply_truth_shadow_gmail_attachment_claim_resolution_v1(
  p_resolution_id text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root_batch constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
  v_candidate record;
  v_supersession jsonb;
  v_supersession_hash text;
  v_supersession_id text;
  v_job_result jsonb;
  v_job_result_hash text;
  v_inserted integer;
  v_updated integer;
begin
  if coalesce(p_resolution_id, '')
      !~ '^attachment-resolution:v1:[0-9a-f]{64}$' then
    raise exception 'attachment-claim supersession resolution identity is invalid'
      using errcode = '22023';
  end if;

  perform private.truth_source_cut_mutation_lock(v_workspace);

  if exists (
    select 1
    from public.truth_shadow_gmail_attachment_claim_resolution_supersessions existing
    where existing.resolution_id = p_resolution_id
  ) then
    return 0;
  end if;

  select
    resolution.workspace_key,
    resolution.connection_key,
    resolution.resolution_id,
    resolution.review_job_id,
    resolution.attachment_observation_id,
    resolution.attachment_content_hash,
    resolution.decision,
    resolution.resolution_evidence_observation_ids,
    claim_job.job_id as claim_job_id,
    claim_job.state as prior_state,
    claim_job.attempt_count as prior_attempt_count,
    claim_job.max_attempts as prior_max_attempts,
    claim_job.lease_fence as prior_lease_fence,
    claim_job.lease_owner as prior_lease_owner,
    claim_job.lease_expires_at as prior_lease_expires_at
  into v_candidate
  from public.gmail_attachment_extraction_resolutions resolution
  join public.source_processing_jobs review_job
    on review_job.workspace_key = resolution.workspace_key
   and review_job.job_id = resolution.review_job_id
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.job_id = review_job.job_id
  join public.source_processing_job_children review_child
    on review_child.child_job_id = review_job.job_id
   and review_child.parent_job_id = review_lineage.parent_job_id
  join public.source_processing_job_children claim_child
    on claim_child.parent_job_id = review_child.parent_job_id
  join public.source_processing_jobs claim_job
    on claim_job.workspace_key = resolution.workspace_key
   and claim_job.job_id = claim_child.child_job_id
  join public.source_processing_job_lineage claim_lineage
    on claim_lineage.workspace_key = claim_job.workspace_key
   and claim_lineage.job_id = claim_job.job_id
  join public.source_observations observation
    on observation.workspace_key = resolution.workspace_key
   and observation.observation_id = resolution.attachment_observation_id
  where resolution.resolution_id = p_resolution_id
    and resolution.workspace_key = v_workspace
    and resolution.connection_key = v_connection
    and review_job.source_system = 'gmail'
    and review_job.connection_key = v_connection
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.observation_id = resolution.attachment_observation_id
    and review_job.state = 'succeeded'
    and review_job.result->>'resolutionId' = resolution.resolution_id
    and review_lineage.root_batch_id = v_root_batch
    and claim_job.source_system = 'gmail'
    and claim_job.connection_key = v_connection
    and claim_job.job_kind = 'gmail_extract_attachment_claims'
    and claim_job.observation_id = resolution.attachment_observation_id
    and claim_job.payload->>'schemaVersion' =
      'gmail-extract-attachment-claims-job-v1'
    and claim_job.payload->>'attachmentObservationId' =
      resolution.attachment_observation_id
    and claim_job.payload->>'contentHash' = resolution.attachment_content_hash
    and claim_job.state = any(array[
      'queued', 'retry_wait', 'waiting_runtime', 'leased', 'dead_letter'
    ])
    and claim_job.result = '{}'::jsonb
    and (
      (claim_job.state = 'leased'
        and claim_job.lease_owner = 'local-truth-gmail-slice:attachment-claims'
        and claim_job.lease_expires_at is not null)
      or (claim_job.state <> 'leased'
        and claim_job.lease_owner is null
        and claim_job.lease_expires_at is null)
    )
    and claim_lineage.root_batch_id = v_root_batch
    and claim_lineage.parent_job_id = review_lineage.parent_job_id
    and claim_lineage.root_job_id = review_lineage.root_job_id
    and claim_lineage.source_cursor_version = review_lineage.source_cursor_version
    and claim_lineage.source_cursor_value = review_lineage.source_cursor_value
    and observation.source_system = 'gmail'
    and observation.connection_key = v_connection
    and observation.source_object_type = 'gmail_attachment_extracted'
    and observation.content_hash = resolution.attachment_content_hash
    and observation.normalized_payload->>'schemaVersion' =
      'gmail-attachment-extracted-v1'
    and not exists (
      select 1 from public.candidate_claim_job_manifests manifest
      where manifest.workspace_key = claim_job.workspace_key
        and manifest.job_id = claim_job.job_id
    )
    and not exists (
      select 1 from public.candidate_claim_job_lineage candidate_lineage
      where candidate_lineage.job_id = claim_job.job_id
    )
    and not exists (
      select 1 from public.truth_pending_acceptance_epoch_manifests membership
      where membership.workspace_key = claim_job.workspace_key
        and membership.source_job_id = claim_job.job_id
    )
    and not exists (
      select 1
      from public.source_processing_job_children other_child
      join public.source_processing_jobs other_claim
        on other_claim.workspace_key = claim_job.workspace_key
       and other_claim.job_id = other_child.child_job_id
      where other_child.parent_job_id = review_child.parent_job_id
        and other_claim.job_id <> claim_job.job_id
        and other_claim.job_kind = 'gmail_extract_attachment_claims'
        and other_claim.observation_id = resolution.attachment_observation_id
        and other_claim.result = '{}'::jsonb
        and other_claim.state not in ('succeeded', 'superseded')
    )
    and not exists (
      select 1 from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key = claim_job.workspace_key
        and epoch.root_batch_id = v_root_batch
    )
    and not exists (
      select 1 from public.truth_shadow_root_source_cuts root_cut
      where root_cut.workspace_key = claim_job.workspace_key
        and root_cut.root_batch_id = v_root_batch
    )
    and not exists (
      select 1
      from public.truth_builds build
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = build.workspace_key
       and root_cut.source_cut_id = build.source_cut_id
      where root_cut.workspace_key = claim_job.workspace_key
        and root_cut.root_batch_id = v_root_batch
    )
    and not exists (
      select 1
      from public.truth_publications publication
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = publication.workspace_key
       and root_cut.source_cut_id = publication.source_cut_id
      where root_cut.workspace_key = claim_job.workspace_key
        and root_cut.root_batch_id = v_root_batch
    )
  order by claim_job.job_id
  limit 1
  for update of claim_job;

  if not found then
    return 0;
  end if;

  v_supersession := jsonb_build_object(
    'schemaVersion',
      'truth-shadow-gmail-attachment-claim-resolution-supersession-v1',
    'workspaceKey', v_workspace,
    'connectionKey', v_connection,
    'rootBatchId', v_root_batch,
    'claimJobId', v_candidate.claim_job_id,
    'reviewJobId', v_candidate.review_job_id,
    'resolutionId', v_candidate.resolution_id,
    'attachmentObservationId', v_candidate.attachment_observation_id,
    'attachmentContentHash', v_candidate.attachment_content_hash,
    'decision', v_candidate.decision,
    'resolutionEvidenceObservationIds',
      v_candidate.resolution_evidence_observation_ids,
    'priorState', v_candidate.prior_state,
    'priorAttemptCount', v_candidate.prior_attempt_count,
    'priorMaxAttempts', v_candidate.prior_max_attempts,
    'priorLeaseFence', v_candidate.prior_lease_fence,
    'priorLeaseOwner', coalesce(v_candidate.prior_lease_owner, ''),
    'priorLeaseExpiresAt', coalesce(
      to_char(v_candidate.prior_lease_expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      ''
    ),
    'reasonCode', 'EXPLICIT_ATTACHMENT_EXTRACTION_RESOLUTION',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_supersession_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_supersession), 'UTF8'
  ), 'sha256'), 'hex');
  v_supersession_id :=
    'truth-shadow-gmail-attachment-claim-supersession:v1:' ||
    v_supersession_hash;
  v_job_result := jsonb_build_object(
    'schemaVersion',
      'truth-shadow-gmail-attachment-claim-supersession-result-v1',
    'supersessionId', v_supersession_id,
    'resolutionId', v_candidate.resolution_id,
    'reviewJobId', v_candidate.review_job_id,
    'sourceObservationId', v_candidate.attachment_observation_id,
    'sourceObservationContentHash', v_candidate.attachment_content_hash,
    'decision', v_candidate.decision,
    'resolutionEvidenceObservationIds',
      v_candidate.resolution_evidence_observation_ids,
    'candidateCount', 0,
    'disposition', 'superseded_by_explicit_attachment_resolution',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_job_result_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_job_result), 'UTF8'
  ), 'sha256'), 'hex');

  insert into public.truth_shadow_gmail_attachment_claim_resolution_supersessions(
    supersession_id, supersession_hash, workspace_key, connection_key,
    root_batch_id, claim_job_id, review_job_id, resolution_id,
    attachment_observation_id, attachment_content_hash, decision,
    resolution_evidence_observation_ids, prior_state, prior_attempt_count,
    prior_max_attempts, prior_lease_fence, prior_lease_owner,
    prior_lease_expires_at, canonical_supersession, canonical_job_result,
    job_result_hash, schema_version, shadow_only, mutates_operational_state,
    production_eligible, production_publication_attempted
  ) values (
    v_supersession_id, v_supersession_hash, v_workspace, v_connection,
    v_root_batch, v_candidate.claim_job_id, v_candidate.review_job_id,
    v_candidate.resolution_id, v_candidate.attachment_observation_id,
    v_candidate.attachment_content_hash, v_candidate.decision,
    v_candidate.resolution_evidence_observation_ids, v_candidate.prior_state,
    v_candidate.prior_attempt_count, v_candidate.prior_max_attempts,
    v_candidate.prior_lease_fence, v_candidate.prior_lease_owner,
    v_candidate.prior_lease_expires_at, v_supersession, v_job_result,
    v_job_result_hash,
    'truth-shadow-gmail-attachment-claim-resolution-supersession-v1',
    true, false, false, false
  ) on conflict (claim_job_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1 then
    raise exception 'attachment-claim supersession identity conflicted'
      using errcode = '23505';
  end if;

  update public.source_processing_jobs claim_job
  set state = 'superseded',
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = 'GMAIL_ATTACHMENT_CLAIM_RESOLUTION_SUPERSEDED',
      safe_error_detail =
        'Explicit attachment resolution superseded this shadow claim producer; the exact decision remains in its immutable receipt.',
      processor_version = 'truth-shadow-gmail-attachment-claim-supersession-v1',
      result = v_job_result,
      updated_at = clock_timestamp(),
      completed_at = clock_timestamp()
  where claim_job.workspace_key = v_workspace
    and claim_job.job_id = v_candidate.claim_job_id
    and claim_job.connection_key = v_connection
    and claim_job.job_kind = 'gmail_extract_attachment_claims'
    and claim_job.state = v_candidate.prior_state
    and claim_job.attempt_count = v_candidate.prior_attempt_count
    and claim_job.max_attempts = v_candidate.prior_max_attempts
    and claim_job.lease_fence = v_candidate.prior_lease_fence
    and claim_job.lease_owner is not distinct from v_candidate.prior_lease_owner
    and claim_job.lease_expires_at is not distinct from
      v_candidate.prior_lease_expires_at
    and claim_job.result = '{}'::jsonb;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'attachment-claim supersession target changed during authorization'
      using errcode = '40001';
  end if;

  return 1;
end;
$function$;

revoke all on function private.apply_truth_shadow_gmail_attachment_claim_resolution_v1(
  text
) from public, anon, authenticated, service_role;

create or replace function private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
  p_workspace_key text,
  p_claim_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_gmail_attachment_claim_resolution_supersessions auth
    join public.source_processing_jobs claim_job
      on claim_job.workspace_key = auth.workspace_key
     and claim_job.job_id = auth.claim_job_id
    join public.source_processing_job_lineage claim_lineage
      on claim_lineage.workspace_key = claim_job.workspace_key
     and claim_lineage.job_id = claim_job.job_id
    join public.gmail_attachment_extraction_resolutions resolution
      on resolution.resolution_id = auth.resolution_id
     and resolution.workspace_key = auth.workspace_key
    join public.source_processing_jobs review_job
      on review_job.workspace_key = auth.workspace_key
     and review_job.job_id = auth.review_job_id
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = review_job.workspace_key
     and review_lineage.job_id = review_job.job_id
    join public.source_processing_job_children claim_child
      on claim_child.child_job_id = claim_job.job_id
     and claim_child.parent_job_id = claim_lineage.parent_job_id
    join public.source_processing_job_children review_child
      on review_child.child_job_id = review_job.job_id
     and review_child.parent_job_id = review_lineage.parent_job_id
    join public.source_observations observation
      on observation.workspace_key = auth.workspace_key
     and observation.observation_id = auth.attachment_observation_id
    where auth.workspace_key = p_workspace_key
      and auth.claim_job_id = p_claim_job_id
      and auth.connection_key like 'shadow-%'
      and auth.shadow_only = true
      and auth.mutates_operational_state = false
      and auth.production_eligible = false
      and auth.production_publication_attempted = false
      and auth.supersession_id =
        'truth-shadow-gmail-attachment-claim-supersession:v1:' ||
        auth.supersession_hash
      and auth.supersession_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth.canonical_supersession), 'UTF8'
      ), 'sha256'), 'hex')
      and auth.job_result_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth.canonical_job_result), 'UTF8'
      ), 'sha256'), 'hex')
      and claim_job.source_system = 'gmail'
      and claim_job.connection_key = auth.connection_key
      and claim_job.job_kind = 'gmail_extract_attachment_claims'
      and claim_job.observation_id = auth.attachment_observation_id
      and claim_job.state = 'superseded'
      and claim_job.lease_owner is null
      and claim_job.lease_expires_at is null
      and claim_job.last_error_code =
        'GMAIL_ATTACHMENT_CLAIM_RESOLUTION_SUPERSEDED'
      and claim_job.processor_version =
        'truth-shadow-gmail-attachment-claim-supersession-v1'
      and claim_job.result = auth.canonical_job_result
      and claim_job.completed_at is not null
      and claim_lineage.root_batch_id = auth.root_batch_id
      and review_job.source_system = 'gmail'
      and review_job.connection_key = auth.connection_key
      and review_job.job_kind = 'gmail_review_attachment_extraction'
      and review_job.observation_id = auth.attachment_observation_id
      and review_job.state = 'succeeded'
      and review_job.result->>'resolutionId' = auth.resolution_id
      and review_lineage.root_batch_id = auth.root_batch_id
      and review_lineage.parent_job_id = claim_lineage.parent_job_id
      and review_lineage.root_job_id = claim_lineage.root_job_id
      and review_lineage.source_cursor_version =
        claim_lineage.source_cursor_version
      and review_lineage.source_cursor_value = claim_lineage.source_cursor_value
      and resolution.review_job_id = auth.review_job_id
      and resolution.connection_key = auth.connection_key
      and resolution.attachment_observation_id = auth.attachment_observation_id
      and resolution.attachment_content_hash = auth.attachment_content_hash
      and resolution.decision = auth.decision
      and resolution.resolution_evidence_observation_ids =
        auth.resolution_evidence_observation_ids
      and observation.source_system = 'gmail'
      and observation.connection_key = auth.connection_key
      and observation.source_object_type = 'gmail_attachment_extracted'
      and observation.content_hash = auth.attachment_content_hash
      and not exists (
        select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key = auth.workspace_key
          and manifest.job_id = auth.claim_job_id
      )
      and not exists (
        select 1 from public.candidate_claim_job_lineage candidate_lineage
        where candidate_lineage.job_id = auth.claim_job_id
      )
      and not exists (
        select 1 from public.truth_pending_acceptance_epoch_manifests membership
        where membership.workspace_key = auth.workspace_key
          and membership.source_job_id = auth.claim_job_id
      )
  );
$function$;

revoke all on function private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
  text, uuid
) from public, anon, authenticated, service_role;

-- Future explicit resolutions insert the immutable resolution first and then
-- complete their exact review child. That state transition is the first point
-- at which all supersession proof is present, so it drives the sibling repair.
create or replace function private.route_truth_shadow_gmail_attachment_claim_resolution_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.workspace_key = 'primary'
    and new.source_system = 'gmail'
    and new.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
    and new.job_kind = 'gmail_review_attachment_extraction'
    and new.state = 'succeeded'
    and new.result->>'resolutionId'
      ~ '^attachment-resolution:v1:[0-9a-f]{64}$' then
    perform private.apply_truth_shadow_gmail_attachment_claim_resolution_v1(
      new.result->>'resolutionId'
    );
  end if;
  return new;
end;
$function$;

revoke all on function private.route_truth_shadow_gmail_attachment_claim_resolution_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists source_processing_job_attachment_claim_resolution_route
  on public.source_processing_jobs;
create trigger source_processing_job_attachment_claim_resolution_route
after update of state, result on public.source_processing_jobs
for each row execute function
  private.route_truth_shadow_gmail_attachment_claim_resolution_v1();

-- Adopt already-resolved exact-root attachments. The helper is a no-op for a
-- resolution without an untouched sibling claim producer.
do $adopt_existing_attachment_resolutions$
declare
  v_resolution record;
begin
  for v_resolution in
    select resolution.resolution_id
    from public.gmail_attachment_extraction_resolutions resolution
    join public.source_processing_jobs review_job
      on review_job.workspace_key = resolution.workspace_key
     and review_job.job_id = resolution.review_job_id
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = review_job.workspace_key
     and review_lineage.job_id = review_job.job_id
    where resolution.workspace_key = 'primary'
      and resolution.connection_key =
        'shadow-current-awbs-20260710-c475a8ca'
      and review_lineage.root_batch_id =
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
    order by resolution.resolution_id
  loop
    perform private.apply_truth_shadow_gmail_attachment_claim_resolution_v1(
      v_resolution.resolution_id
    );
  end loop;
end;
$adopt_existing_attachment_resolutions$;

-- The legacy workspace-wide unresolved reader can return an older completed
-- duplicate before the active review child. Replace only that target-selection
-- block with a bounded exact-job lookup and require one admissible child.
do $attachment_review_resolver_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  select * into v_target
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where unresolved.attachment_observation_id = p_attachment_observation_id
    and unresolved.attachment_content_hash = p_expected_content_hash;
  if not found then
    raise exception 'attachment review target is resolved, stale, or unavailable'
      using errcode = '40001';
  end if;
  if v_target.review_job_id is null then
    raise exception 'attachment review target lacks its durable review child'
      using errcode = '23514';
  end if;
  select * into v_review_job
  from public.source_processing_jobs job
  where job.job_id = v_target.review_job_id
    and job.workspace_key = p_workspace_key
    and job.job_kind = 'gmail_review_attachment_extraction'
    and job.observation_id = p_attachment_observation_id
  for update;
  if not found or v_review_job.state not in ('queued', 'retry_wait', 'dead_letter') then
    raise exception 'attachment review child is not available for explicit resolution'
      using errcode = '40001';
  end if;$old$;
  v_new text := $new$  -- BOUNDED_EXACT_ATTACHMENT_REVIEW_CHILD_V1
  with candidates as materialized (
    select target.*
    from public.source_processing_jobs job
    cross join lateral private.unresolved_gmail_attachment_extraction_v1(
      p_workspace_key, job.job_id, p_attachment_observation_id
    ) target
    where job.workspace_key = p_workspace_key
      and job.source_system = 'gmail'
      and job.job_kind = 'gmail_review_attachment_extraction'
      and job.observation_id = p_attachment_observation_id
      and target.attachment_content_hash = p_expected_content_hash
      and job.lease_owner is null
      and job.lease_expires_at is null
      and (
        job.state in ('queued', 'retry_wait', 'dead_letter')
        or (
          job.state = 'waiting_runtime'
          and job.last_error_code =
            'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED'
        )
      )
    order by job.created_at desc, job.job_id
    limit 2
  )
  select candidate.* into v_target
  from candidates candidate
  where (select count(*) from candidates) = 1;
  if not found then
    raise exception 'attachment review target is ambiguous, resolved, stale, or unavailable'
      using errcode = '40001';
  end if;
  select * into v_review_job
  from public.source_processing_jobs job
  where job.job_id = v_target.review_job_id
    and job.workspace_key = p_workspace_key
    and job.source_system = 'gmail'
    and job.job_kind = 'gmail_review_attachment_extraction'
    and job.observation_id = p_attachment_observation_id
    and job.lease_owner is null
    and job.lease_expires_at is null
    and (
      job.state in ('queued', 'retry_wait', 'dead_letter')
      or (
        job.state = 'waiting_runtime'
        and job.last_error_code =
          'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED'
      )
    )
    and exists (
      select 1
      from private.unresolved_gmail_attachment_extraction_v1(
        p_workspace_key, job.job_id, p_attachment_observation_id
      ) exact_target
      where exact_target.attachment_content_hash = p_expected_content_hash
    )
  for update;
  if not found then
    raise exception 'attachment review child is not available for explicit resolution'
      using errcode = '40001';
  end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('BOUNDED_EXACT_ATTACHMENT_REVIEW_CHILD_V1' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'attachment review resolver target block did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition
      or position('BOUNDED_EXACT_ATTACHMENT_REVIEW_CHILD_V1' in v_updated) = 0
      or position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_updated) > 0 then
      raise exception 'attachment review resolver target rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) > 0
    or position('limit 2' in lower(v_definition)) = 0 then
    raise exception 'attachment review resolver target rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$attachment_review_resolver_rewrite$;

revoke all on function private.resolve_gmail_attachment_extraction(
  text, text, text, text, jsonb, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_gmail_attachment_extraction(
  text, text, text, text, jsonb, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_gmail_attachment_extraction(
  text, text, text, text, jsonb, text, text, text, text, text
) to service_role;

-- Resolve the current commissioned model-review child by its durable job UUID.
-- This avoids accidentally submitting the superseded pre-commissioning
-- obligation, which must remain unresolved for replay validation.
create or replace function private.resolve_truth_shadow_gmail_model_review_job(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_review_job_id uuid,
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
  v_obligation_id text;
  v_resolution_exists boolean;
  v_review public.source_processing_jobs%rowtype;
  v_receipt jsonb;
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid shadow Gmail model review authority'
      using errcode = '28000';
  end if;
  if p_workspace_key <> 'primary'
    or p_connection_key <>
      'shadow-current-awbs-20260710-c475a8ca'
    or p_root_batch_id is distinct from
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
    or p_review_job_id is null then
    raise exception 'shadow Gmail model review job scope is invalid'
      using errcode = '42501';
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);

  select obligation.obligation_id,
    exists (
      select 1
      from public.gmail_model_extraction_review_resolutions resolution
      where resolution.workspace_key = obligation.workspace_key
        and resolution.obligation_id = obligation.obligation_id
    )
  into v_obligation_id, v_resolution_exists
  from public.gmail_model_extraction_review_obligations obligation
  join public.gmail_model_extraction_plans plan
    on plan.workspace_key = obligation.workspace_key
   and plan.extraction_plan_id = obligation.extraction_plan_id
  join public.source_processing_jobs parent_job
    on parent_job.workspace_key = plan.workspace_key
   and parent_job.job_id = plan.parent_job_id
  join public.source_processing_job_lineage parent_lineage
    on parent_lineage.workspace_key = parent_job.workspace_key
   and parent_lineage.job_id = parent_job.job_id
   and parent_lineage.root_batch_id = p_root_batch_id
  join public.source_processing_jobs review_job
    on review_job.workspace_key = obligation.workspace_key
   and review_job.job_id = obligation.review_job_id
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.job_id = review_job.job_id
   and review_lineage.root_batch_id = parent_lineage.root_batch_id
   and review_lineage.root_job_id = parent_lineage.root_job_id
   and review_lineage.source_cursor_version =
     parent_lineage.source_cursor_version
   and review_lineage.source_cursor_value = parent_lineage.source_cursor_value
  where obligation.workspace_key = p_workspace_key
    and obligation.review_job_id = p_review_job_id
    and parent_job.source_system = 'gmail'
    and parent_job.connection_key = p_connection_key
    and parent_job.job_kind = 'gmail_extract_message_claims'
    and parent_job.observation_id = plan.source_observation_id
    and parent_job.state = 'succeeded'
    and review_job.source_system = 'gmail'
    and review_job.connection_key = p_connection_key
    and review_job.job_kind = 'gmail_review_model_extraction'
    and review_job.observation_id = plan.source_observation_id
    and not exists (
      select 1
      from public.truth_shadow_gmail_model_commissioning_replays prior_replay
      where prior_replay.workspace_key = obligation.workspace_key
        and prior_replay.obligation_id = obligation.obligation_id
    )
    and not exists (
      select 1
      from public.truth_shadow_gmail_model_commissioning_replays current_replay
      where current_replay.workspace_key = obligation.workspace_key
        and current_replay.successor_parent_job_id = plan.parent_job_id
        and (
          current_replay.connection_key <> p_connection_key
          or current_replay.root_batch_id <> p_root_batch_id
          or current_replay.shadow_only is distinct from true
          or current_replay.production_eligible is distinct from false
          or current_replay.production_publication_attempted is distinct from false
          or not private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
            current_replay.workspace_key, current_replay.obligation_id
          )
        )
    )
    and (
      (
        obligation.model_child_job_id is null
        and review_lineage.parent_job_id = plan.parent_job_id
      )
      or (
        obligation.model_child_job_id is not null
        and review_lineage.parent_job_id = obligation.model_child_job_id
        and exists (
          select 1
          from public.source_processing_jobs model_child
          join public.source_processing_job_lineage model_lineage
            on model_lineage.workspace_key = model_child.workspace_key
           and model_lineage.job_id = model_child.job_id
          where model_child.workspace_key = obligation.workspace_key
            and model_child.job_id = obligation.model_child_job_id
            and model_child.job_kind = 'gmail_extract_message_model_claims'
            and model_lineage.parent_job_id = plan.parent_job_id
            and model_lineage.root_batch_id = parent_lineage.root_batch_id
            and model_lineage.root_job_id = parent_lineage.root_job_id
            and model_lineage.source_cursor_version =
              parent_lineage.source_cursor_version
            and model_lineage.source_cursor_value =
              parent_lineage.source_cursor_value
        )
      )
    )
    and not exists (
      select 1 from public.truth_required_sources required_source
      where required_source.workspace_key = obligation.workspace_key
        and required_source.source_system = 'gmail'
        and required_source.connection_key = p_connection_key
    )
    and not exists (
      select 1 from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key = obligation.workspace_key
        and epoch.root_batch_id = parent_lineage.root_batch_id
    )
    and not exists (
      select 1 from public.truth_shadow_root_source_cuts root_cut
      where root_cut.workspace_key = obligation.workspace_key
        and root_cut.root_batch_id = parent_lineage.root_batch_id
    );

  if not found then
    raise exception 'current shadow Gmail model review child is unavailable'
      using errcode = '40001';
  end if;

  if not v_resolution_exists then
    select * into v_review
    from public.source_processing_jobs review_job
    where review_job.workspace_key = p_workspace_key
      and review_job.job_id = p_review_job_id
      and review_job.source_system = 'gmail'
      and review_job.connection_key = p_connection_key
      and review_job.job_kind = 'gmail_review_model_extraction'
    for update;
    if not found
      or v_review.lease_owner is not null
      or v_review.lease_expires_at is not null
      or (
        v_review.state not in ('queued', 'retry_wait', 'dead_letter')
        and not (
          v_review.state = 'waiting_runtime'
          and v_review.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
        )
      ) then
      raise exception 'current shadow Gmail model review child is not resolvable'
        using errcode = '40001';
    end if;
  end if;

  v_receipt := private.resolve_gmail_model_extraction_review(
    p_workspace_key,
    v_obligation_id,
    p_decision,
    p_resolution_evidence_observation_ids,
    p_decided_by,
    p_reason,
    p_idempotency_key,
    p_review_token,
    p_sync_token
  );
  return v_receipt || jsonb_build_object(
    'resolvedByReviewJobId', p_review_job_id,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.resolve_truth_shadow_gmail_model_review_job(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_review_job_id uuid,
  p_decision text,
  p_resolution_evidence_observation_ids jsonb,
  p_decided_by text,
  p_reason text,
  p_idempotency_key text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.resolve_truth_shadow_gmail_model_review_job(
    p_workspace_key, p_connection_key, p_root_batch_id, p_review_job_id,
    p_decision, p_resolution_evidence_observation_ids, p_decided_by,
    p_reason, p_idempotency_key, p_review_token, p_sync_token
  );
$function$;

revoke all on function private.resolve_truth_shadow_gmail_model_review_job(
  text, text, uuid, uuid, text, jsonb, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_truth_shadow_gmail_model_review_job(
  text, text, uuid, uuid, text, jsonb, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_truth_shadow_gmail_model_review_job(
  text, text, uuid, uuid, text, jsonb, text, text, text, text, text
) to service_role;

-- A proof-covered attachment claim has no candidate manifest by design. Keep
-- the coordinator's equality invariant by excluding that exact authority from
-- both the producer count and its incomplete-manifest scan.
do $acceptance_attachment_resolution_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old_count text := $old$    and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
      job.workspace_key, job.job_id
    );$old$;
  v_new_count text := $new$    and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
      job.workspace_key, job.job_id
    )
    -- EXPLICIT_ATTACHMENT_RESOLUTION_CLAIM_COVERAGE_V1
    and not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
      job.workspace_key, job.job_id
    );$new$;
  v_old_scan text := $old$        and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
          job.workspace_key, job.job_id
        )
        and ($old$;
  v_new_scan text := $new$        and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
          job.workspace_key, job.job_id
        )
        and not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
          job.workspace_key, job.job_id
        )
        and ($new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
      'EXPLICIT_ATTACHMENT_RESOLUTION_CLAIM_COVERAGE_V1'
      in v_definition
    ) = 0 then
    if position(v_old_count in v_definition) = 0
      or position(v_old_scan in v_definition) = 0 then
      raise exception 'shadow acceptance attachment frontier blocks did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old_count, v_new_count);
    v_updated := replace(v_updated, v_old_scan, v_new_scan);
    if v_updated = v_definition
      or position(
        'EXPLICIT_ATTACHMENT_RESOLUTION_CLAIM_COVERAGE_V1'
        in v_updated
      ) = 0
      or (
        length(v_updated) - length(replace(
          v_updated,
          'truth_shadow_gmail_attachment_claim_resolution_covered_v1',
          ''
        ))
      ) / length('truth_shadow_gmail_attachment_claim_resolution_covered_v1') <> 2 then
      raise exception 'shadow acceptance attachment frontier rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif (
      length(v_definition) - length(replace(
        v_definition,
        'truth_shadow_gmail_attachment_claim_resolution_covered_v1',
        ''
      ))
    ) / length('truth_shadow_gmail_attachment_claim_resolution_covered_v1') <> 2 then
    raise exception 'shadow acceptance attachment frontier rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$acceptance_attachment_resolution_rewrite$;

revoke all on function private.run_truth_shadow_claim_acceptance_epoch(
  text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.run_truth_shadow_claim_acceptance_epoch(
  text, text, text
) from public, anon, authenticated;
grant execute on function public.run_truth_shadow_claim_acceptance_epoch(
  text, text, text
) to service_role;

analyze public.truth_shadow_gmail_model_plan_binding_retry_authorizations;
analyze public.truth_shadow_gmail_attachment_claim_resolution_supersessions;
analyze public.source_processing_jobs;

do $verify$
declare
  v_definition text;
  v_trigger_definition text;
begin
  if not private.truth_shadow_gmail_model_plan_binding_failure_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v1","errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED","jobKind":"gmail_extract_message_claims"}'
    )
    or private.truth_shadow_gmail_model_plan_binding_failure_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v1","errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED","jobKind":"gmail_extract_message_claims","extra":"unsafe"}'
    ) then
    raise exception 'legacy Gmail model-plan failure classifier is not exact'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.resolve_gmail_attachment_extraction(text,text,text,text,jsonb,text,text,text,text,text)'::regprocedure
  )) into v_definition;
  if position('bounded_exact_attachment_review_child_v1' in v_definition) = 0
    or position('unresolved_gmail_attachment_extraction_v1(' in v_definition) = 0
    or position('limit 2' in v_definition) = 0
    or position('unresolved_gmail_attachment_extractions(p_workspace_key)' in v_definition) > 0 then
    raise exception 'bounded exact attachment review resolver failed read-back'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  )) into v_definition;
  if position('explicit_attachment_resolution_claim_coverage_v1' in v_definition) = 0
    or (
      length(v_definition) - length(replace(
        v_definition,
        'truth_shadow_gmail_attachment_claim_resolution_covered_v1',
        ''
      ))
    ) / length('truth_shadow_gmail_attachment_claim_resolution_covered_v1') <> 2
    or position('model_commissioning_frontier_open' in v_definition) = 0
    or position('claim_producer_frontier_open' in v_definition) = 0 then
    raise exception 'shadow acceptance frontier closure failed read-back'
      using errcode = '23514';
  end if;

  select lower(pg_get_triggerdef(trigger_row.oid, true))
  into v_trigger_definition
  from pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.source_processing_jobs'::regclass
    and trigger_row.tgname =
      'source_processing_job_attachment_claim_resolution_route'
    and not trigger_row.tgisinternal;
  if v_trigger_definition is null
    or position('after update of state, result' in v_trigger_definition) = 0 then
    raise exception 'attachment claim-resolution route trigger is unavailable'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_attachment_claim_resolution_supersessions auth
    where not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
      auth.workspace_key, auth.claim_job_id
    )
  ) then
    raise exception 'attachment claim-resolution supersession failed read-back'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.source_processing_jobs successor
      on successor.workspace_key = replay.workspace_key
     and successor.job_id = replay.successor_parent_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = successor.workspace_key
     and lineage.job_id = successor.job_id
    where replay.workspace_key = 'primary'
      and replay.connection_key =
        'shadow-current-awbs-20260710-c475a8ca'
      and replay.root_batch_id =
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
      and successor.state in ('retry_wait', 'dead_letter')
      and successor.lease_owner is null
      and successor.lease_expires_at is null
      and successor.result = '{}'::jsonb
      and private.truth_shadow_gmail_model_plan_binding_failure_v1(
        successor.last_error_code, successor.safe_error_detail
      )
      and lineage.root_batch_id = replay.root_batch_id
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key, replay.obligation_id
      )
      and not exists (
        select 1
        from public.truth_shadow_gmail_model_plan_binding_retry_authorizations auth
        where auth.workspace_key = successor.workspace_key
          and auth.successor_parent_job_id = successor.job_id
      )
  ) then
    raise exception 'eligible legacy Gmail replay remains unauthorized'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_attachment_claim_resolution_supersessions auth
    where auth.shadow_only is distinct from true
      or auth.mutates_operational_state is distinct from false
      or auth.production_eligible is distinct from false
      or auth.production_publication_attempted is distinct from false
  ) then
    raise exception 'attachment claim-resolution authority escaped shadow-only scope'
      using errcode = '23514';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.resolve_truth_shadow_gmail_model_review_job(text,text,uuid,uuid,text,jsonb,text,text,text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.resolve_truth_shadow_gmail_model_review_job(text,text,uuid,uuid,text,jsonb,text,text,text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.resolve_truth_shadow_gmail_model_review_job(text,text,uuid,uuid,text,jsonb,text,text,text,text,text)',
      'EXECUTE'
    ) then
    raise exception 'shadow Gmail model review-job RPC privilege drifted'
      using errcode = '23514';
  end if;
end;
$verify$;
