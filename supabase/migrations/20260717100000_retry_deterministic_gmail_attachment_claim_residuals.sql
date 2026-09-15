-- Reauthorize the exact deterministic extracted-PDF claim producers stranded by
-- the attachment adapter's pre-manifest failure-acknowledgement seam.
--
-- This authority does not resolve, supersede, accept, cut, build, or publish
-- anything.  It only returns an untouched, immutable-text attachment claim job
-- to retry_wait so the corrected extraction-only worker can seal its real
-- candidate manifest (including a valid empty manifest when the text proves no
-- supported claim).

create schema if not exists private;

do $preflight$
begin
  if to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('public.reject_immutable_truth_mutation()') is null
    or to_regclass('public.truth_workspaces') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_observations') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.candidate_claim_job_lineage') is null
    or to_regclass('public.candidate_claim_decisions') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null
    or to_regclass('public.gmail_attachment_extraction_resolutions') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epoch_items') is null
    or to_regclass('public.truth_gmail_link_epochs') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null then
    raise exception 'deterministic attachment-claim retry prerequisites are unavailable'
      using errcode = '55000';
  end if;

  if to_regclass('public.truth_shadow_gmail_attachment_claim_residual_actions')
      is not null
    or exists (
      select 1
      from pg_proc function_row
      where function_row.oid = to_regprocedure(
        'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
      )
        and position(
          'DIRECT_ATTACHMENT_RESIDUAL_COVERAGE_V1'
          in pg_get_functiondef(function_row.oid)
        ) > 0
    ) then
    raise exception 'obsolete attachment supersession authority is partially installed'
      using errcode = '23514';
  end if;
end;
$preflight$;

create table if not exists public.truth_shadow_gmail_attachment_claim_retry_authorizations (
  authorization_id text primary key check (
    authorization_id ~
      '^truth-shadow-gmail-attachment-claim-retry:v1:[0-9a-f]{64}$'
  ),
  authorization_hash text not null unique check (
    authorization_hash ~ '^[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  claim_job_id uuid not null unique,
  source_observation_id text not null,
  source_observation_content_hash text not null check (
    source_observation_content_hash ~ '^[0-9a-f]{64}$'
  ),
  extraction_method text not null check (
    extraction_method = any(array[
      'pdf-text+quality-v1', 'utf8-text-v1', 'html-to-text-v1'
    ])
  ),
  prior_state text not null check (prior_state = any(array['leased','dead_letter'])),
  prior_attempt_count integer not null check (prior_attempt_count > 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  prior_lease_fence bigint not null check (prior_lease_fence > 0),
  prior_lease_owner text,
  prior_lease_expires_at timestamptz,
  prior_error_code text not null,
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
    schema_version =
      'truth-shadow-gmail-attachment-claim-retry-authorization-v1'
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
  unique(workspace_key, authorization_id),
  foreign key(workspace_key, claim_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  check (authorization_id =
    'truth-shadow-gmail-attachment-claim-retry:v1:' || authorization_hash),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_authorization->>'schemaVersion' = schema_version),
  check (canonical_authorization->>'workspaceKey' = workspace_key),
  check (canonical_authorization->>'connectionKey' = connection_key),
  check (canonical_authorization->>'rootBatchId' = root_batch_id::text),
  check (canonical_authorization->>'claimJobId' = claim_job_id::text),
  check (canonical_authorization->>'sourceObservationId' =
    source_observation_id),
  check (canonical_authorization->>'sourceObservationContentHash' =
    source_observation_content_hash),
  check (canonical_authorization->>'extractionMethod' = extraction_method),
  check (canonical_authorization->>'priorState' = prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer =
    prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer =
    prior_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint =
    prior_lease_fence),
  check (canonical_authorization->>'priorLeaseOwner' =
    coalesce(prior_lease_owner, '')),
  check (canonical_authorization->>'priorLeaseExpiresAt' = coalesce(to_char(
    prior_lease_expires_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ), '')),
  check (canonical_authorization->>'priorErrorCode' = prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash' =
    prior_error_detail_hash),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer =
    authorized_max_attempts),
  check (canonical_authorization->>'reasonCode' =
    'DETERMINISTIC_ATTACHMENT_CLAIM_WORKER_RETRY'),
  check (canonical_authorization->>'shadowOnly' = 'true'),
  check (canonical_authorization->>'mutatesOperationalState' = 'false'),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
);

create index if not exists truth_shadow_gmail_attachment_claim_retry_scope_idx
  on public.truth_shadow_gmail_attachment_claim_retry_authorizations(
    workspace_key, connection_key, root_batch_id, claim_job_id
  );

drop trigger if exists truth_shadow_gmail_attachment_claim_retry_immutable
  on public.truth_shadow_gmail_attachment_claim_retry_authorizations;
create trigger truth_shadow_gmail_attachment_claim_retry_immutable
before update or delete
on public.truth_shadow_gmail_attachment_claim_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_shadow_gmail_attachment_claim_retry_authorizations
  enable row level security;
alter table public.truth_shadow_gmail_attachment_claim_retry_authorizations
  force row level security;
revoke all on table public.truth_shadow_gmail_attachment_claim_retry_authorizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_shadow_gmail_attachment_claim_retry_authorizations
  to service_role;

do $authorize_exact_deterministic_attachment_claims$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
  v_candidate record;
  v_authorization jsonb;
  v_hash text;
  v_id text;
  v_max integer;
  v_inserted integer;
  v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock(v_workspace);

  for v_candidate in
    select
      claim.job_id,
      claim.observation_id,
      observation.content_hash,
      observation.normalized_payload->'extraction'->>'method'
        as extraction_method,
      claim.state,
      claim.attempt_count,
      claim.max_attempts,
      claim.lease_fence,
      claim.lease_owner,
      claim.lease_expires_at,
      claim.last_error_code,
      encode(extensions.digest(convert_to(
        claim.safe_error_detail, 'UTF8'
      ), 'sha256'), 'hex') as error_detail_hash
    from public.source_processing_jobs claim
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = claim.workspace_key
     and lineage.job_id = claim.job_id
    join public.source_observations observation
      on observation.workspace_key = claim.workspace_key
     and observation.observation_id = claim.observation_id
    where claim.workspace_key = v_workspace
      and claim.source_system = 'gmail'
      and claim.connection_key = v_connection
      and claim.job_kind = 'gmail_extract_attachment_claims'
      and lineage.root_batch_id = v_root
      and claim.payload->>'schemaVersion' =
        'gmail-extract-attachment-claims-job-v1'
      and claim.payload->>'attachmentObservationId' = claim.observation_id
      and claim.payload->>'contentHash' = observation.content_hash
      and claim.result = '{}'::jsonb
      and claim.attempt_count > 0
      and claim.lease_fence > 0
      and (
        (claim.state = 'leased'
          and claim.lease_owner =
            'local-truth-gmail-slice:attachment-claims'
          and claim.lease_expires_at is not null
          and claim.completed_at is null)
        or
        (claim.state = 'dead_letter'
          and claim.attempt_count >= claim.max_attempts
          and claim.lease_owner is null
          and claim.lease_expires_at is null
          and claim.completed_at is not null
          and claim.last_error_code = 'LEASE_EXPIRED')
      )
      and observation.source_system = 'gmail'
      and observation.connection_key = v_connection
      and observation.source_object_type = 'gmail_attachment_extracted'
      and observation.operation = 'content'
      and observation.normalized_payload->>'schemaVersion' =
        'gmail-attachment-extracted-v1'
      and observation.normalized_payload->'extraction'->>'status' = 'extracted'
      and observation.normalized_payload->'extraction'->>'provenance' =
        'deterministic'
      and observation.normalized_payload->'extraction'->>'method' = any(array[
        'pdf-text+quality-v1', 'utf8-text-v1', 'html-to-text-v1'
      ])
      and coalesce(
        (observation.normalized_payload->'extraction'->>'reviewRequired')::boolean,
        false
      ) = false
      and length(observation.normalized_text) > 0
      and observation.normalized_payload->>'text' =
        observation.normalized_text
      and observation.content_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(observation.normalized_payload),
        'UTF8'
      ), 'sha256'), 'hex')
      and exists (
        select 1
        from public.truth_gmail_link_epochs epoch
        join public.truth_gmail_link_epoch_seals seal
          on seal.workspace_key = epoch.workspace_key
         and seal.epoch_id = epoch.epoch_id
        where epoch.workspace_key = claim.workspace_key
          and epoch.root_batch_id = lineage.root_batch_id
      )
      and not exists (
        select 1 from public.gmail_attachment_extraction_resolutions resolution
        where resolution.workspace_key = claim.workspace_key
          and resolution.connection_key = claim.connection_key
          and resolution.attachment_observation_id = claim.observation_id
      )
      and not exists (
        select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key = claim.workspace_key
          and manifest.job_id = claim.job_id
      )
      and not exists (
        select 1 from public.candidate_claim_job_lineage candidate_lineage
        where candidate_lineage.job_id = claim.job_id
      )
      and not exists (
        select 1
        from public.truth_pending_acceptance_epoch_manifests membership
        where membership.workspace_key = claim.workspace_key
          and membership.source_job_id = claim.job_id
      )
      and not exists (
        select 1 from public.truth_shadow_claim_acceptance_epoch_items item
        where item.workspace_key = claim.workspace_key
          and item.source_job_id = claim.job_id
      )
      and not exists (
        select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key = claim.workspace_key
          and epoch.root_batch_id = v_root
      )
      and not exists (
        select 1 from public.truth_shadow_root_source_cuts root_cut
        where root_cut.workspace_key = claim.workspace_key
          and root_cut.root_batch_id = v_root
      )
      and not exists (
        select 1
        from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = build.workspace_key
         and root_cut.source_cut_id = build.source_cut_id
        where root_cut.workspace_key = claim.workspace_key
          and root_cut.root_batch_id = v_root
      )
      and not exists (
        select 1
        from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = publication.workspace_key
         and root_cut.source_cut_id = publication.source_cut_id
        where root_cut.workspace_key = claim.workspace_key
          and root_cut.root_batch_id = v_root
      )
      and not exists (
        select 1
        from public.truth_shadow_gmail_attachment_claim_retry_authorizations auth
        where auth.workspace_key = claim.workspace_key
          and auth.claim_job_id = claim.job_id
      )
    order by claim.job_id
    for update of claim
  loop
    v_max := greatest(v_candidate.max_attempts, v_candidate.attempt_count + 3);
    v_authorization := jsonb_build_object(
      'schemaVersion',
        'truth-shadow-gmail-attachment-claim-retry-authorization-v1',
      'workspaceKey', v_workspace,
      'connectionKey', v_connection,
      'rootBatchId', v_root,
      'claimJobId', v_candidate.job_id,
      'sourceObservationId', v_candidate.observation_id,
      'sourceObservationContentHash', v_candidate.content_hash,
      'extractionMethod', v_candidate.extraction_method,
      'priorState', v_candidate.state,
      'priorAttemptCount', v_candidate.attempt_count,
      'priorMaxAttempts', v_candidate.max_attempts,
      'priorLeaseFence', v_candidate.lease_fence,
      'priorLeaseOwner', coalesce(v_candidate.lease_owner, ''),
      'priorLeaseExpiresAt', coalesce(to_char(
        v_candidate.lease_expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ), ''),
      'priorErrorCode', v_candidate.last_error_code,
      'priorErrorDetailHash', v_candidate.error_detail_hash,
      'authorizedMaxAttempts', v_max,
      'reasonCode', 'DETERMINISTIC_ATTACHMENT_CLAIM_WORKER_RETRY',
      'shadowOnly', true,
      'mutatesOperationalState', false,
      'productionPublicationAttempted', false
    );
    v_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_authorization), 'UTF8'
    ), 'sha256'), 'hex');
    v_id := 'truth-shadow-gmail-attachment-claim-retry:v1:' || v_hash;

    insert into public.truth_shadow_gmail_attachment_claim_retry_authorizations(
      authorization_id, authorization_hash, workspace_key, connection_key,
      root_batch_id, claim_job_id, source_observation_id,
      source_observation_content_hash, extraction_method, prior_state,
      prior_attempt_count, prior_max_attempts, prior_lease_fence,
      prior_lease_owner, prior_lease_expires_at, prior_error_code,
      prior_error_detail_hash, authorized_max_attempts,
      canonical_authorization, schema_version, shadow_only,
      mutates_operational_state, production_eligible,
      production_publication_attempted
    ) values (
      v_id, v_hash, v_workspace, v_connection, v_root, v_candidate.job_id,
      v_candidate.observation_id, v_candidate.content_hash,
      v_candidate.extraction_method, v_candidate.state,
      v_candidate.attempt_count, v_candidate.max_attempts,
      v_candidate.lease_fence, v_candidate.lease_owner,
      v_candidate.lease_expires_at, v_candidate.last_error_code,
      v_candidate.error_detail_hash, v_max, v_authorization,
      'truth-shadow-gmail-attachment-claim-retry-authorization-v1',
      true, false, false, false
    );
    get diagnostics v_inserted = row_count;
    if v_inserted <> 1 then
      raise exception 'deterministic attachment-claim retry authorization conflicted'
        using errcode = '23505';
    end if;

    update public.source_processing_jobs claim
    set state = 'retry_wait',
        max_attempts = v_max,
        available_at = clock_timestamp(),
        lease_owner = null,
        lease_expires_at = null,
        last_error_code =
          'GMAIL_DETERMINISTIC_ATTACHMENT_CLAIM_RETRY_AUTHORIZED',
        safe_error_detail =
          'Exact deterministic attachment text must seal its real claim manifest.',
        updated_at = clock_timestamp(),
        completed_at = null
    where claim.workspace_key = v_workspace
      and claim.job_id = v_candidate.job_id
      and claim.state = v_candidate.state
      and claim.attempt_count = v_candidate.attempt_count
      and claim.max_attempts = v_candidate.max_attempts
      and claim.lease_fence = v_candidate.lease_fence
      and claim.lease_owner is not distinct from v_candidate.lease_owner
      and claim.lease_expires_at is not distinct from
        v_candidate.lease_expires_at
      and claim.last_error_code = v_candidate.last_error_code
      and encode(extensions.digest(convert_to(
        claim.safe_error_detail, 'UTF8'
      ), 'sha256'), 'hex') = v_candidate.error_detail_hash
      and claim.result = '{}'::jsonb;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'deterministic attachment-claim retry target changed'
        using errcode = '40001';
    end if;
  end loop;
end;
$authorize_exact_deterministic_attachment_claims$;

analyze public.source_processing_jobs;
analyze public.truth_shadow_gmail_attachment_claim_retry_authorizations;

do $verify$
begin
  if exists (
    select 1
    from public.truth_shadow_gmail_attachment_claim_retry_authorizations auth
    join public.source_processing_jobs claim
      on claim.workspace_key = auth.workspace_key
     and claim.job_id = auth.claim_job_id
    join public.source_observations observation
      on observation.observation_id = auth.source_observation_id
    where auth.shadow_only is distinct from true
      or auth.mutates_operational_state is distinct from false
      or auth.production_eligible is distinct from false
      or auth.production_publication_attempted is distinct from false
      or auth.connection_key <> 'shadow-current-awbs-20260710-c475a8ca'
      or auth.root_batch_id <>
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
      or claim.job_kind <> 'gmail_extract_attachment_claims'
      or claim.observation_id <> auth.source_observation_id
      or observation.content_hash <> auth.source_observation_content_hash
      or observation.normalized_payload->'extraction'->>'status' <> 'extracted'
      or observation.normalized_payload->'extraction'->>'provenance' <>
        'deterministic'
      or claim.state in ('dead_letter', 'superseded')
      or (claim.state = 'retry_wait' and (
        claim.lease_owner is not null or claim.lease_expires_at is not null
        or claim.completed_at is not null
        or claim.attempt_count <> auth.prior_attempt_count
        or claim.lease_fence <> auth.prior_lease_fence
        or claim.max_attempts <> auth.authorized_max_attempts
      ))
  ) then
    raise exception 'deterministic attachment-claim retry failed read-back'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.source_processing_jobs claim
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = claim.workspace_key
     and lineage.job_id = claim.job_id
    join public.source_observations observation
      on observation.workspace_key = claim.workspace_key
     and observation.observation_id = claim.observation_id
    where claim.workspace_key = 'primary'
      and claim.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
      and claim.job_kind = 'gmail_extract_attachment_claims'
      and lineage.root_batch_id =
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
      and claim.result = '{}'::jsonb
      and (
        (claim.state = 'leased'
          and claim.lease_owner =
            'local-truth-gmail-slice:attachment-claims')
        or
        (claim.state = 'dead_letter'
          and claim.last_error_code = 'LEASE_EXPIRED')
      )
      and observation.source_object_type = 'gmail_attachment_extracted'
      and observation.normalized_payload->'extraction'->>'status' = 'extracted'
      and observation.normalized_payload->'extraction'->>'provenance' =
        'deterministic'
      and observation.normalized_payload->'extraction'->>'method' = any(array[
        'pdf-text+quality-v1', 'utf8-text-v1', 'html-to-text-v1'
      ])
      and length(observation.normalized_text) > 0
      and not exists (
        select 1 from public.gmail_attachment_extraction_resolutions resolution
        where resolution.workspace_key = claim.workspace_key
          and resolution.attachment_observation_id = claim.observation_id
      )
      and not exists (
        select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key = claim.workspace_key
          and manifest.job_id = claim.job_id
      )
      and not exists (
        select 1
        from public.truth_shadow_gmail_attachment_claim_retry_authorizations auth
        where auth.workspace_key = claim.workspace_key
          and auth.claim_job_id = claim.job_id
      )
  ) then
    raise exception 'exact deterministic attachment claim residual remained'
      using errcode = '23514';
  end if;

  if has_table_privilege(
      'anon',
      'public.truth_shadow_gmail_attachment_claim_retry_authorizations',
      'SELECT'
    ) or has_table_privilege(
      'authenticated',
      'public.truth_shadow_gmail_attachment_claim_retry_authorizations',
      'SELECT'
    ) then
    raise exception 'deterministic attachment-claim retry ACL escaped service role'
      using errcode = '23514';
  end if;
end;
$verify$;
