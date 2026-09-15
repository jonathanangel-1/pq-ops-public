-- Admit only the message-model children released by a standalone parent whose
-- exhausted residual received the immutable 090000 retry authorization and
-- whose present model plan passed the 110000 fenced resume authority.
--
-- Commissioning-replay admission remains unchanged.  This adds the missing
-- sibling proof for first-generation residual parents; it does not infer replay
-- ancestry, create a provider request, accept a claim, seal a cut, build, or
-- publish.  One exact production shadow root is adopted from waiting_runtime
-- after the class-wide validators are installed.

create schema if not exists private;

do $preflight$
declare
  v_route regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_route_definition text;
  v_claim_definition text;
begin
  if v_route is null
    or v_claim is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_job_allowed_v1(text,uuid)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regclass(
      'public.truth_shadow_gmail_model_residual_retry_authorizations'
    ) is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_processing_job_children') is null
    or to_regclass('public.source_ingest_batches') is null
    or to_regclass('public.source_observations') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null then
    raise exception 'resumed Gmail model-child admission prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(v_route) into v_route_definition;
  select pg_get_functiondef(v_claim) into v_claim_definition;
  if position(
      'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1('
      in v_route_definition
    ) = 0
    and position(
      'private.truth_shadow_gmail_model_child_input_allowed_v2('
      in v_route_definition
    ) = 0 then
    raise exception 'Gmail model-child route differs from its reviewed predecessor'
      using errcode = '23514';
  end if;
  if position(
      'private.truth_shadow_gmail_model_commissioning_job_allowed_v1('
      in v_claim_definition
    ) = 0
    and position(
      'private.truth_shadow_gmail_model_job_allowed_v2('
      in v_claim_definition
    ) = 0 then
    raise exception 'Gmail model-child claim admission differs from its reviewed predecessor'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- The parent proof is intentionally usable in two temporal positions.  During
-- generic completion the parent is still leased and the child row/lineage do
-- not yet exist.  Once stored, the stricter branch requires the succeeded
-- completion witness.  Both positions bind the same immutable residual retry,
-- source, lineage, candidate manifest, context seal, and present model plan.
create or replace function private.truth_shadow_gmail_residual_model_parent_allowed_v1(
  p_workspace_key text,
  p_parent_job_id uuid,
  p_require_completed boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_gmail_model_residual_retry_authorizations auth
    join public.source_processing_jobs parent
      on parent.workspace_key = auth.workspace_key
     and parent.job_id = auth.claim_job_id
    join public.source_processing_job_lineage parent_lineage
      on parent_lineage.workspace_key = parent.workspace_key
     and parent_lineage.source_system = parent.source_system
     and parent_lineage.connection_key = parent.connection_key
     and parent_lineage.job_id = parent.job_id
    join public.source_ingest_batches batch
      on batch.workspace_key = parent_lineage.workspace_key
     and batch.source_system = parent_lineage.source_system
     and batch.connection_key = parent_lineage.connection_key
     and batch.batch_id = parent_lineage.root_batch_id
    join public.source_observations observation
      on observation.workspace_key = parent.workspace_key
     and observation.source_system = parent.source_system
     and observation.connection_key = parent.connection_key
     and observation.observation_id = parent.observation_id
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
     and context_seal.source_observation_content_hash =
       plan.source_observation_content_hash
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = parent.workspace_key
     and manifest.job_id = parent.job_id
     and manifest.source_observation_id = observation.observation_id
    where auth.workspace_key = p_workspace_key
      and auth.claim_job_id = p_parent_job_id
      and auth.connection_key = parent.connection_key
      and auth.root_batch_id = parent_lineage.root_batch_id
      and auth.claim_job_dedupe_key = parent.dedupe_key
      and auth.source_observation_id = parent.observation_id
      and auth.source_object_id = parent.source_object_id
      and auth.source_observation_content_hash = observation.content_hash
      and auth.prior_payload_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(parent.payload), 'UTF8'
      ), 'sha256'), 'hex')
      and auth.lineage_parent_job_id is not distinct from
        parent_lineage.parent_job_id
      and auth.lineage_root_job_id = parent_lineage.root_job_id
      and auth.source_cursor_version = parent_lineage.source_cursor_version
      and auth.source_cursor_value_hash = encode(extensions.digest(convert_to(
        parent_lineage.source_cursor_value, 'UTF8'
      ), 'sha256'), 'hex')
      and auth.prior_state = 'dead_letter'
      and auth.prior_attempt_count >= auth.prior_max_attempts
      and auth.artifact_mode = 'sealed_resume_or_reconcile'
      and auth.authorized_max_attempts = parent.max_attempts
      and parent.attempt_count > auth.prior_attempt_count
      and parent.attempt_count <= auth.authorized_max_attempts
      and auth.authorization_id =
        'truth-shadow-gmail-model-residual-retry:v2:' || auth.authorization_hash
      and auth.authorization_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth.canonical_authorization), 'UTF8'
      ), 'sha256'), 'hex')
      and auth.shadow_only = true
      and auth.mutates_operational_state = false
      and auth.production_eligible = false
      and auth.production_publication_attempted = false
      and parent.source_system = 'gmail'
      and parent.connection_key like 'shadow-%'
      and parent.job_kind = 'gmail_extract_message_claims'
      and parent.completed_at is not null = p_require_completed
      and (
        (not p_require_completed
          and parent.state = 'leased'
          and parent.lease_owner is not null
          and parent.lease_expires_at is not null
          and parent.lease_expires_at > clock_timestamp()
          and parent.result = '{}'::jsonb)
        or
        (p_require_completed
          and parent.state = 'succeeded'
          and parent.lease_owner is null
          and parent.lease_expires_at is null
          and parent.result #>> '{truthPlan,extractionPlanId}' =
            plan.extraction_plan_id
          and parent.result #>> '{truthPlan,planSealHash}' = plan.plan_seal_hash
          and parent.result #>> '{truthPlan,deterministicManifestHash}' =
            plan.deterministic_manifest_hash
          and parent.result #>> '{truthPlan,modelPlanId}' = plan.model_plan_id
          and parent.result #>> '{truthPlan,planningStatus}' = 'complete'
          and parent.result #>> '{truthPlan,planningFailureCode}' = '')
      )
      and batch.status = 'committed'
      and batch.mode in ('backfill', 'reconciliation')
      and batch.committed_cursor_version = parent_lineage.source_cursor_version
      and batch.committed_cursor_value = parent_lineage.source_cursor_value
      and observation.batch_id = batch.batch_id
      and observation.source_cursor_version = parent_lineage.source_cursor_version
      and observation.source_object_type = 'gmail_message_parsed'
      and observation.normalized_payload->>'schemaVersion' =
        'gmail-parsed-message-v2'
      and plan.planning_status = 'complete'
      and plan.planning_failure_code = ''
      and plan.planning_failure_detail_hash = ''
      and plan.model_plan_id is not null
      and plan.model_plan_hash is not null
      and plan.model_plan is not null
      and plan.execution_mode in ('sync', 'batch')
      and plan.root_ingest_mode = batch.mode
      and plan.extraction_plan_id =
        'gmail-extraction-plan:v1:' || plan.extraction_plan_hash
      and plan.model_plan_id = 'gmail-model-plan:v1:' || plan.model_plan_hash
      and plan.model_plan->>'modelPlanId' = plan.model_plan_id
      and plan.model_plan->>'modelPlanHash' = plan.model_plan_hash
      and plan.model_plan->>'sourceObservationId' = observation.observation_id
      and plan.model_plan->>'sourceObservationContentHash' =
        observation.content_hash
      and plan.model_plan_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(
          plan.model_plan - 'modelPlanId' - 'modelPlanHash'
        ), 'UTF8'
      ), 'sha256'), 'hex')
      and plan.deterministic_manifest_hash = manifest.manifest_hash
      and plan.deterministic_candidate_count = manifest.candidate_count
      and plan.planned_deterministic_candidate_count = manifest.candidate_count
      and manifest.manifest_hash = encode(extensions.digest(convert_to(
        manifest.canonical_manifest::text, 'UTF8'
      ), 'sha256'), 'hex')
      and context_seal.seal_hash = encode(extensions.digest(convert_to(
        context_seal.canonical_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and plan.plan_seal_hash = encode(extensions.digest(convert_to(
        plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and plan.canonical_plan_seal->>'parentJobId' = parent.job_id::text
      and plan.canonical_plan_seal->>'sourceObservationId' =
        observation.observation_id
      and plan.canonical_plan_seal->>'sourceObservationContentHash' =
        observation.content_hash
      and plan.canonical_plan_seal->>'modelPlanId' = plan.model_plan_id
      and plan.canonical_plan_seal->>'modelPlanHash' = plan.model_plan_hash
      and plan.canonical_plan_seal->>'contextSealId' = plan.context_seal_id
      and plan.canonical_plan_seal->>'planSealHash' is null
      and not exists (
        select 1
        from public.truth_required_sources required_source
        where required_source.workspace_key = parent.workspace_key
          and required_source.source_system = parent.source_system
          and required_source.connection_key = parent.connection_key
      )
      and not exists (
        select 1
        from public.truth_shadow_root_source_cuts root_cut
        join public.source_cuts source_cut
          on source_cut.workspace_key = root_cut.workspace_key
         and source_cut.source_cut_id = root_cut.source_cut_id
        where root_cut.workspace_key = parent.workspace_key
          and root_cut.root_batch_id = parent_lineage.root_batch_id
          and source_cut.completeness = 'complete'
      )
      and not exists (
        select 1
        from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = build.workspace_key
         and root_cut.source_cut_id = build.source_cut_id
        where root_cut.workspace_key = parent.workspace_key
          and root_cut.root_batch_id = parent_lineage.root_batch_id
      )
      and not exists (
        select 1
        from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = publication.workspace_key
         and root_cut.source_cut_id = publication.source_cut_id
        where root_cut.workspace_key = parent.workspace_key
          and root_cut.root_batch_id = parent_lineage.root_batch_id
      )
  );
$function$;

revoke all on function
  private.truth_shadow_gmail_residual_model_parent_allowed_v1(text,uuid,boolean)
  from public, anon, authenticated, service_role;

-- BEFORE INSERT admission.  The child row and child lineage are deliberately
-- absent here; the generic fenced completion authority validates and writes
-- them immediately after this trigger.
create or replace function private.truth_shadow_gmail_model_child_input_allowed_v2(
  p_workspace_key text,
  p_parent_job_id text,
  p_child_job_id uuid,
  p_dedupe_key text,
  p_observation_id text,
  p_payload jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
      p_workspace_key, p_parent_job_id, p_child_job_id, p_dedupe_key,
      p_observation_id, p_payload
    )
    or exists (
      select 1
      from public.source_processing_jobs parent
      join public.source_processing_job_lineage parent_lineage
        on parent_lineage.workspace_key = parent.workspace_key
       and parent_lineage.source_system = parent.source_system
       and parent_lineage.connection_key = parent.connection_key
       and parent_lineage.job_id = parent.job_id
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = parent.workspace_key
       and plan.parent_job_id = parent.job_id
      where parent.workspace_key = p_workspace_key
        and parent.job_id::text = p_parent_job_id
        and p_child_job_id is not null
        and private.truth_shadow_gmail_residual_model_parent_allowed_v1(
          parent.workspace_key, parent.job_id, false
        )
        and p_dedupe_key = 'gmail:model-claims:v1:' || plan.model_plan_hash
        and p_observation_id = parent.observation_id
        and jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) = 'object'
        and private.truth_jsonb_has_only_keys(p_payload, array[
          'schemaVersion','modelPlanId','contextSealId','batchId',
          'rootBatchId','rootJobId','parentJobId'
        ])
        and (select count(*) from jsonb_object_keys(p_payload)) = 7
        and p_payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
        and p_payload->>'modelPlanId' = plan.model_plan_id
        and p_payload->>'contextSealId' = plan.context_seal_id
        and p_payload->>'batchId' = parent_lineage.root_batch_id::text
        and p_payload->>'rootBatchId' = parent_lineage.root_batch_id::text
        and p_payload->>'rootJobId' = parent_lineage.root_job_id::text
        and p_payload->>'parentJobId' = parent.job_id::text
    );
$function$;

revoke all on function private.truth_shadow_gmail_model_child_input_allowed_v2(
  text,text,uuid,text,text,jsonb
) from public, anon, authenticated, service_role;

-- Stored-job admission.  Unlike the input validator, this requires the exact
-- child edge/lineage and the parent's succeeded plan witness.
create or replace function private.truth_shadow_gmail_model_job_allowed_v2(
  p_workspace_key text,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    private.truth_shadow_gmail_model_commissioning_job_allowed_v1(
      p_workspace_key, p_job_id
    )
    or exists (
      select 1
      from public.source_processing_jobs child
      join public.source_processing_job_lineage child_lineage
        on child_lineage.workspace_key = child.workspace_key
       and child_lineage.source_system = child.source_system
       and child_lineage.connection_key = child.connection_key
       and child_lineage.job_id = child.job_id
      join public.source_processing_jobs parent
        on parent.workspace_key = child.workspace_key
       and parent.job_id = child_lineage.parent_job_id
      join public.source_processing_job_lineage parent_lineage
        on parent_lineage.workspace_key = parent.workspace_key
       and parent_lineage.source_system = parent.source_system
       and parent_lineage.connection_key = parent.connection_key
       and parent_lineage.job_id = parent.job_id
      join public.source_processing_job_children edge
        on edge.parent_job_id = parent.job_id
       and edge.child_job_id = child.job_id
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = parent.workspace_key
       and plan.parent_job_id = parent.job_id
      where child.workspace_key = p_workspace_key
        and child.job_id = p_job_id
        and child.source_system = 'gmail'
        and child.connection_key = parent.connection_key
        and child.connection_key like 'shadow-%'
        and child.job_kind = 'gmail_extract_message_model_claims'
        and child.observation_id = parent.observation_id
        and child.source_object_id = parent.source_object_id
        and child.state in ('waiting_runtime', 'queued', 'retry_wait', 'leased')
        and child.attempt_count < child.max_attempts
        and child.completed_at is null
        and child.result = '{}'::jsonb
        and child.dedupe_key = 'gmail:model-claims:v1:' || plan.model_plan_hash
        and jsonb_typeof(child.payload) = 'object'
        and private.truth_jsonb_has_only_keys(child.payload, array[
          'schemaVersion','modelPlanId','contextSealId','batchId',
          'rootBatchId','rootJobId','parentJobId'
        ])
        and (select count(*) from jsonb_object_keys(child.payload)) = 7
        and child.payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
        and child.payload->>'modelPlanId' = plan.model_plan_id
        and child.payload->>'contextSealId' = plan.context_seal_id
        and child.payload->>'batchId' = child_lineage.root_batch_id::text
        and child.payload->>'rootBatchId' = child_lineage.root_batch_id::text
        and child.payload->>'rootJobId' = child_lineage.root_job_id::text
        and child.payload->>'parentJobId' = parent.job_id::text
        and child_lineage.root_batch_id = parent_lineage.root_batch_id
        and child_lineage.root_job_id = parent_lineage.root_job_id
        and child_lineage.source_cursor_version =
          parent_lineage.source_cursor_version
        and child_lineage.source_cursor_value = parent_lineage.source_cursor_value
        and private.truth_shadow_gmail_residual_model_parent_allowed_v1(
          parent.workspace_key, parent.job_id, true
        )
    );
$function$;

revoke all on function private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)
  from public, anon, authenticated, service_role;

-- Rebind the input authority after the stored-job validator exists.  The
-- leased-parent branch remains the only INSERT path; an UPDATE of an already
-- persisted child may instead prove the stricter stored child edge, lineage,
-- payload, succeeded parent, sealed plan, and residual authorization.  This is
-- what lets the one-time adoption pass its own BEFORE UPDATE route without
-- weakening admission for a newly invented child.
create or replace function private.truth_shadow_gmail_model_child_input_allowed_v2(
  p_workspace_key text,
  p_parent_job_id text,
  p_child_job_id uuid,
  p_dedupe_key text,
  p_observation_id text,
  p_payload jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
      p_workspace_key, p_parent_job_id, p_child_job_id, p_dedupe_key,
      p_observation_id, p_payload
    )
    or exists (
      select 1
      from public.source_processing_jobs parent
      join public.source_processing_job_lineage parent_lineage
        on parent_lineage.workspace_key = parent.workspace_key
       and parent_lineage.source_system = parent.source_system
       and parent_lineage.connection_key = parent.connection_key
       and parent_lineage.job_id = parent.job_id
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = parent.workspace_key
       and plan.parent_job_id = parent.job_id
      where parent.workspace_key = p_workspace_key
        and parent.job_id::text = p_parent_job_id
        and p_child_job_id is not null
        and private.truth_shadow_gmail_residual_model_parent_allowed_v1(
          parent.workspace_key, parent.job_id, false
        )
        and p_dedupe_key = 'gmail:model-claims:v1:' || plan.model_plan_hash
        and p_observation_id = parent.observation_id
        and jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) = 'object'
        and private.truth_jsonb_has_only_keys(p_payload, array[
          'schemaVersion','modelPlanId','contextSealId','batchId',
          'rootBatchId','rootJobId','parentJobId'
        ])
        and (select count(*) from jsonb_object_keys(p_payload)) = 7
        and p_payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
        and p_payload->>'modelPlanId' = plan.model_plan_id
        and p_payload->>'contextSealId' = plan.context_seal_id
        and p_payload->>'batchId' = parent_lineage.root_batch_id::text
        and p_payload->>'rootBatchId' = parent_lineage.root_batch_id::text
        and p_payload->>'rootJobId' = parent_lineage.root_job_id::text
        and p_payload->>'parentJobId' = parent.job_id::text
    )
    or exists (
      select 1
      from public.source_processing_jobs stored_child
      where stored_child.workspace_key = p_workspace_key
        and stored_child.job_id = p_child_job_id
        and stored_child.dedupe_key = p_dedupe_key
        and stored_child.observation_id = p_observation_id
        and stored_child.payload = p_payload
        and stored_child.payload->>'parentJobId' = p_parent_job_id
        and private.truth_shadow_gmail_model_job_allowed_v2(
          stored_child.workspace_key, stored_child.job_id
        )
    );
$function$;

revoke all on function private.truth_shadow_gmail_model_child_input_allowed_v2(
  text,text,uuid,text,text,jsonb
) from public, anon, authenticated, service_role;

-- Route only the message child through the composite input proof.  All
-- attachment commissioning behavior and every predecessor branch remain byte
-- unchanged.
do $route_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_definition text;
  v_updated text;
  v_old constant text :=
    'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(';
  v_new constant text :=
    'private.truth_shadow_gmail_model_child_input_allowed_v2(';
  v_old_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if position(v_new in v_definition) = 0 then
    if v_old_count <> 1 then
      raise exception 'Gmail model-child route rewrite did not match exactly once'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition
      or position(v_new in v_updated) = 0
      or position(v_old in v_updated) > 0 then
      raise exception 'Gmail model-child route rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif v_old_count <> 0 then
    raise exception 'Gmail model-child route admission is partially installed'
      using errcode = '23514';
  end if;
end;
$route_rewrite$;

-- Preserve the optimized SKIP LOCKED claim authority and replace only its
-- message-model admission predicate.  Attachment admission continues through
-- the independent shared attachment commissioning function.
do $claim_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_updated text;
  v_old constant text :=
    'private.truth_shadow_gmail_model_commissioning_job_allowed_v1(';
  v_new constant text := 'private.truth_shadow_gmail_model_job_allowed_v2(';
  v_old_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if position(v_new in v_definition) = 0 then
    if v_old_count <> 1 then
      raise exception 'Gmail model-child claim rewrite did not match exactly once'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition
      or position(v_new in v_updated) = 0
      or position(v_old in v_updated) > 0
      or position('for update of job skip locked' in lower(v_updated)) = 0
      or position(
        'private.truth_shadow_model_commissioning_job_allowed('
        in v_updated
      ) = 0 then
      raise exception 'Gmail model-child claim rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif v_old_count <> 0 then
    raise exception 'Gmail model-child claim admission is partially installed'
      using errcode = '23514';
  end if;
end;
$claim_rewrite$;

revoke all on function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public, anon, authenticated, service_role;

-- Adopt only the ten-class production residual in its exact immutable scope.
-- The UPDATE fires the rewritten route, which independently revalidates the
-- stored child proof.  Attempts, maximum attempts, lease fence, payload,
-- result, parentage, and evidence are untouched.
do $adopt_exact_resume_children$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
begin
  if exists (
    select 1
    from public.source_ingest_batches batch
    where batch.workspace_key = v_workspace
      and batch.source_system = 'gmail'
      and batch.connection_key = v_connection
      and batch.batch_id = v_root
      and batch.status = 'committed'
      and batch.mode in ('backfill', 'reconciliation')
  ) then
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
      )
      or exists (
        select 1
        from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = build.workspace_key
         and root_cut.source_cut_id = build.source_cut_id
        where root_cut.workspace_key = v_workspace
          and root_cut.root_batch_id = v_root
      )
      or exists (
        select 1
        from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = publication.workspace_key
         and root_cut.source_cut_id = publication.source_cut_id
        where root_cut.workspace_key = v_workspace
          and root_cut.root_batch_id = v_root
      ) then
      raise exception 'complete/built/published roots cannot adopt resumed Gmail model children'
        using errcode = '23514';
    end if;

    update public.source_processing_jobs child
    set state = 'queued',
        available_at = clock_timestamp(),
        last_error_code = '',
        safe_error_detail = '',
        updated_at = clock_timestamp()
    from public.source_processing_job_lineage child_lineage
    where child.workspace_key = v_workspace
      and child.source_system = 'gmail'
      and child.connection_key = v_connection
      and child.job_kind = 'gmail_extract_message_model_claims'
      and child.state = 'waiting_runtime'
      and child.attempt_count < child.max_attempts
      and child.lease_owner is null
      and child.lease_expires_at is null
      and child.completed_at is null
      and child.result = '{}'::jsonb
      and child.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
      and child_lineage.workspace_key = child.workspace_key
      and child_lineage.source_system = child.source_system
      and child_lineage.connection_key = child.connection_key
      and child_lineage.job_id = child.job_id
      and child_lineage.root_batch_id = v_root
      and private.truth_shadow_gmail_model_job_allowed_v2(
        child.workspace_key, child.job_id
      );

    if exists (
      select 1
      from public.source_processing_jobs child
      join public.source_processing_job_lineage child_lineage
        on child_lineage.workspace_key = child.workspace_key
       and child_lineage.source_system = child.source_system
       and child_lineage.connection_key = child.connection_key
       and child_lineage.job_id = child.job_id
      where child.workspace_key = v_workspace
        and child.source_system = 'gmail'
        and child.connection_key = v_connection
        and child.job_kind = 'gmail_extract_message_model_claims'
        and child.state = 'waiting_runtime'
        and child.attempt_count < child.max_attempts
        and child.lease_owner is null
        and child.lease_expires_at is null
        and child.completed_at is null
        and child.result = '{}'::jsonb
        and child.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
        and child_lineage.root_batch_id = v_root
        and private.truth_shadow_gmail_model_job_allowed_v2(
          child.workspace_key, child.job_id
        )
    ) then
      raise exception 'exact resumed Gmail model child remained parked after adoption'
        using errcode = '23514';
    end if;
  end if;
end;
$adopt_exact_resume_children$;

analyze public.source_processing_jobs;
analyze public.source_processing_job_lineage;

do $verify$
declare
  v_route regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_trigger_definition text;
begin
  if to_regprocedure(
      'private.truth_shadow_gmail_residual_model_parent_allowed_v1(text,uuid,boolean)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_child_input_allowed_v2(text,text,uuid,text,text,jsonb)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)'
    ) is null then
    raise exception 'resumed Gmail model-child validators are incomplete'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_route)) into v_definition;
  if position('truth_shadow_gmail_model_child_input_allowed_v2' in v_definition) = 0
    or position(
      'truth_shadow_gmail_model_commissioning_child_input_allowed_v1'
      in v_definition
    ) > 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0
    or position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0 then
    raise exception 'Gmail route lost composite message or attachment admission'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_claim)) into v_definition;
  if position('truth_shadow_gmail_model_job_allowed_v2' in v_definition) = 0
    or position(
      'truth_shadow_gmail_model_commissioning_job_allowed_v1'
      in v_definition
    ) > 0
    or position('for update of job skip locked' in v_definition) = 0
    or position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0 then
    raise exception 'source-processing claim lost composite message or attachment admission'
      using errcode = '23514';
  end if;

  select lower(pg_get_triggerdef(trigger_row.oid, true))
    into v_trigger_definition
  from pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.source_processing_jobs'::regclass
    and trigger_row.tgname = 'source_processing_job_gmail_link_claim_wait'
    and trigger_row.tgfoid = v_route
    and not trigger_row.tgisinternal;
  if v_trigger_definition is null
    or position('before insert or update of state' in v_trigger_definition) = 0 then
    raise exception 'Gmail model-child route trigger is not active'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from unnest(array[
      'private.truth_shadow_gmail_residual_model_parent_allowed_v1(text,uuid,boolean)',
      'private.truth_shadow_gmail_model_child_input_allowed_v2(text,text,uuid,text,text,jsonb)',
      'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)'
    ]) signature
    where has_function_privilege('anon', signature, 'EXECUTE')
       or has_function_privilege('authenticated', signature, 'EXECUTE')
       or has_function_privilege('service_role', signature, 'EXECUTE')
  ) then
    raise exception 'private resumed Gmail model-child authority leaked execute privilege'
      using errcode = '42501';
  end if;

  if lower(pg_get_functiondef(
      'private.truth_shadow_gmail_residual_model_parent_allowed_v1(text,uuid,boolean)'::regprocedure
    )) like '%' || 'shipment-' || 'truth-packets' || '%'
    or lower(pg_get_functiondef(
      'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)'::regprocedure
    )) like '%' || 'shipment-' || 'truth-packets' || '%' then
    raise exception 'resumed Gmail model-child authority references the live board'
      using errcode = '23514';
  end if;
end;
$verify$;
