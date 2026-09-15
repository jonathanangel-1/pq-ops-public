-- The generic Gmail backfill authority deliberately plans model work as Batch,
-- while the installed Batch transport remains parked.  Commissioning must not
-- reinterpret an immutable MODEL_RUNTIME_DISABLED plan or pretend that its
-- review child established a no-claims decision.  This forward authority
-- records one exact shadow root scope, appends sibling parent replays for the
-- unresolved runtime-disabled obligations, and admits synchronous model work
-- only for descendants whose complete replay relation verifies in PostgreSQL.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.gmail_model_extraction_review_resolutions') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null
    or to_regprocedure('private.valid_truth_review_token(text)') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure(
      'private.truth_shadow_is_reconciled_stale_candidate_v1(text,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
    ) is null
    or to_regprocedure(
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
    ) is null
    or to_regprocedure('private.route_gmail_link_claim_wait_v2()') is null
    or to_regprocedure('private.unresolved_gmail_model_extraction_reviews(text)') is null then
    raise exception 'shadow Gmail model commissioning prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('v_has_model_plan boolean:=false;' in v_definition) = 0
    or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('gmail-model-runtime-disabled-review-v1' in v_definition) = 0
    or position('v_batch.mode in (''backfill'',''reconciliation'') then ''batch''' in v_definition) = 0 then
    raise exception 'Gmail plan sealer differs from the commissioned predecessor'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  )) into v_definition;
  if position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('expired_jobs as materialized' in v_definition) = 0
    or position('lineage_job_candidates as materialized' in v_definition) = 0
    or position('for update of job skip locked' in v_definition) = 0
    or position('gmail_extract_message_model_claims' in v_definition) = 0
    or position('gmail_review_model_extraction' in v_definition) = 0 then
    raise exception 'source-processing claim authority differs from the commissioned predecessor'
      using errcode = '23514';
  end if;

  select pg_get_functiondef('private.route_gmail_link_claim_wait_v2()'::regprocedure)
    into v_definition;
  if position('GMAIL_MODEL_RUNTIME_DISABLED' in v_definition) = 0
    or position('gmail_extract_message_model_claims' in v_definition) = 0 then
    raise exception 'Gmail runtime routing trigger differs from the commissioned predecessor'
      using errcode = '23514';
  end if;
end;
$preflight$;

create table if not exists public.truth_shadow_gmail_model_commissioning_scopes (
  commissioning_scope_id text primary key check (
    commissioning_scope_id ~ '^truth-shadow-gmail-model-scope:v1:[0-9a-f]{64}$'
  ),
  scope_hash text not null unique check (scope_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  root_ingest_mode text not null check (root_ingest_mode in ('backfill', 'reconciliation')),
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  execution_mode text not null check (execution_mode = 'sync'),
  canonical_scope jsonb not null check (jsonb_typeof(canonical_scope) = 'object'),
  schema_version text not null check (
    schema_version = 'truth-shadow-gmail-model-commissioning-scope-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, commissioning_scope_id),
  unique (workspace_key, connection_key, root_batch_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  check (commissioning_scope_id = 'truth-shadow-gmail-model-scope:v1:' || scope_hash),
  check (scope_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_scope), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_scope->>'schemaVersion' =
    'truth-shadow-gmail-model-commissioning-scope-v1'),
  check (canonical_scope->>'workspaceKey' = workspace_key),
  check (canonical_scope->>'sourceSystem' = source_system),
  check (canonical_scope->>'connectionKey' = connection_key),
  check (canonical_scope->>'rootBatchId' = root_batch_id::text),
  check (canonical_scope->>'rootIngestMode' = root_ingest_mode),
  check ((canonical_scope->>'sourceCursorVersion')::bigint = source_cursor_version),
  check (canonical_scope->>'sourceCursorValue' = source_cursor_value),
  check (canonical_scope->>'executionMode' = execution_mode),
  check (canonical_scope->>'shadowOnly' = 'true'),
  check (canonical_scope->>'mutatesOperationalState' = 'false'),
  check (canonical_scope->>'productionPublicationAttempted' = 'false')
);

create table if not exists public.truth_shadow_gmail_model_commissioning_replays (
  replay_id text primary key check (
    replay_id ~ '^truth-shadow-gmail-model-replay:v1:[0-9a-f]{64}$'
  ),
  replay_hash text not null unique check (replay_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  commissioning_scope_id text not null,
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  obligation_id text not null unique check (
    obligation_id ~ '^gmail-model-review:v1:[0-9a-f]{64}$'
  ),
  prior_extraction_plan_id text not null unique check (
    prior_extraction_plan_id ~ '^gmail-extraction-plan:v1:[0-9a-f]{64}$'
  ),
  prior_extraction_plan_hash text not null check (
    prior_extraction_plan_hash ~ '^[0-9a-f]{64}$'
  ),
  prior_plan_seal_hash text not null check (prior_plan_seal_hash ~ '^[0-9a-f]{64}$'),
  prior_parent_job_id uuid not null unique,
  prior_review_job_id uuid not null unique,
  successor_parent_job_id uuid not null unique,
  original_parent_job_id uuid not null,
  root_job_id uuid not null,
  source_observation_id text not null,
  source_observation_content_hash text not null check (
    source_observation_content_hash ~ '^[0-9a-f]{64}$'
  ),
  successor_dedupe_key text not null unique,
  successor_payload jsonb not null check (jsonb_typeof(successor_payload) = 'object'),
  successor_payload_hash text not null check (successor_payload_hash ~ '^[0-9a-f]{64}$'),
  canonical_replay jsonb not null check (jsonb_typeof(canonical_replay) = 'object'),
  canonical_supersession jsonb not null check (
    jsonb_typeof(canonical_supersession) = 'object'
  ),
  supersession_hash text not null unique check (supersession_hash ~ '^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-gmail-model-commissioning-replay-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, replay_id),
  foreign key (workspace_key, commissioning_scope_id)
    references public.truth_shadow_gmail_model_commissioning_scopes(
      workspace_key, commissioning_scope_id
    ) on update restrict on delete restrict,
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, obligation_id)
    references public.gmail_model_extraction_review_obligations(workspace_key, obligation_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, prior_extraction_plan_id)
    references public.gmail_model_extraction_plans(workspace_key, extraction_plan_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, prior_parent_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, prior_review_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, successor_parent_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, original_parent_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, root_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  check (replay_id = 'truth-shadow-gmail-model-replay:v1:' || replay_hash),
  check (replay_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_replay), 'UTF8'
  ), 'sha256'), 'hex')),
  check (successor_payload_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(successor_payload), 'UTF8'
  ), 'sha256'), 'hex')),
  check (supersession_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_supersession), 'UTF8'
  ), 'sha256'), 'hex')),
  check (receipt_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_replay->>'schemaVersion' =
    'truth-shadow-gmail-model-commissioning-replay-v1'),
  check (canonical_replay->>'workspaceKey' = workspace_key),
  check (canonical_replay->>'commissioningScopeId' = commissioning_scope_id),
  check (canonical_replay->>'connectionKey' = connection_key),
  check (canonical_replay->>'rootBatchId' = root_batch_id::text),
  check (canonical_replay->>'obligationId' = obligation_id),
  check (canonical_replay->>'priorExtractionPlanId' = prior_extraction_plan_id),
  check (canonical_replay->>'priorParentJobId' = prior_parent_job_id::text),
  check (canonical_replay->>'priorReviewJobId' = prior_review_job_id::text),
  check (canonical_replay->>'sourceObservationId' = source_observation_id),
  check (canonical_replay->>'shadowOnly' = 'true'),
  check (canonical_replay->>'productionPublicationAttempted' = 'false'),
  check (canonical_supersession->>'schemaVersion' =
    'truth-shadow-gmail-model-review-supersession-v1'),
  check (canonical_supersession->>'replayId' = replay_id),
  check (canonical_supersession->>'obligationId' = obligation_id),
  check (canonical_supersession->>'reviewJobId' = prior_review_job_id::text),
  check (canonical_supersession->>'successorParentJobId' = successor_parent_job_id::text),
  check (canonical_supersession->>'status' = 'superseded_by_model_commissioning_replay'),
  check (canonical_supersession->>'shadowOnly' = 'true'),
  check (canonical_supersession->>'mutatesOperationalState' = 'false'),
  check (canonical_supersession->>'productionPublicationAttempted' = 'false'),
  check (canonical_receipt->>'schemaVersion' =
    'truth-shadow-gmail-model-commissioning-receipt-v1'),
  check (canonical_receipt->>'replayId' = replay_id),
  check (canonical_receipt->>'successorParentJobId' = successor_parent_job_id::text),
  check (canonical_receipt->>'shadowOnly' = 'true'),
  check (canonical_receipt->>'mutatesOperationalState' = 'false'),
  check (canonical_receipt->>'productionPublicationAttempted' = 'false')
);

create index if not exists truth_shadow_gmail_model_replay_scope_idx
  on public.truth_shadow_gmail_model_commissioning_replays(
    workspace_key, connection_key, root_batch_id, successor_parent_job_id
  );

do $immutability$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_shadow_gmail_model_commissioning_scopes',
    'truth_shadow_gmail_model_commissioning_replays'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I '
      || 'for each row execute function public.reject_immutable_truth_mutation()',
      v_table, v_table
    );
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format(
      'revoke all on table public.%I from public, anon, authenticated, service_role',
      v_table
    );
    execute format('grant select on table public.%I to service_role', v_table);
  end loop;
end;
$immutability$;

-- This is the permanent integrity witness used only to retire the old review
-- blocker.  It deliberately remains true after a later acceptance epoch/cut;
-- execution admission below adds the temporal no-cut guard separately.
create or replace function private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
  p_workspace_key text,
  p_obligation_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.truth_shadow_gmail_model_commissioning_scopes scope_row
      on scope_row.workspace_key = replay.workspace_key
     and scope_row.commissioning_scope_id = replay.commissioning_scope_id
    join public.source_ingest_batches batch
      on batch.workspace_key = replay.workspace_key
     and batch.batch_id = replay.root_batch_id
    join public.gmail_model_extraction_review_obligations obligation
      on obligation.workspace_key = replay.workspace_key
     and obligation.obligation_id = replay.obligation_id
     and obligation.extraction_plan_id = replay.prior_extraction_plan_id
     and obligation.review_job_id = replay.prior_review_job_id
    join public.gmail_model_extraction_plans prior_plan
      on prior_plan.workspace_key = replay.workspace_key
     and prior_plan.extraction_plan_id = replay.prior_extraction_plan_id
     and prior_plan.parent_job_id = replay.prior_parent_job_id
    join public.source_processing_jobs prior_parent
      on prior_parent.workspace_key = replay.workspace_key
     and prior_parent.job_id = replay.prior_parent_job_id
    join public.source_processing_job_lineage prior_lineage
      on prior_lineage.workspace_key = replay.workspace_key
     and prior_lineage.job_id = replay.prior_parent_job_id
    join public.source_processing_jobs review_job
      on review_job.workspace_key = replay.workspace_key
     and review_job.job_id = replay.prior_review_job_id
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = replay.workspace_key
     and review_lineage.job_id = replay.prior_review_job_id
    join public.source_processing_job_children review_child
      on review_child.parent_job_id = replay.prior_parent_job_id
     and review_child.child_job_id = replay.prior_review_job_id
    join public.source_processing_jobs successor
      on successor.workspace_key = replay.workspace_key
     and successor.job_id = replay.successor_parent_job_id
    join public.source_processing_job_lineage successor_lineage
      on successor_lineage.workspace_key = replay.workspace_key
     and successor_lineage.job_id = replay.successor_parent_job_id
    join public.source_observations observation
      on observation.workspace_key = replay.workspace_key
     and observation.observation_id = replay.source_observation_id
    where replay.workspace_key = p_workspace_key
      and replay.obligation_id = p_obligation_id
      and replay.shadow_only = true
      and replay.production_eligible = false
      and replay.production_publication_attempted = false
      and scope_row.shadow_only = true
      and scope_row.production_eligible = false
      and scope_row.production_publication_attempted = false
      and scope_row.source_system = 'gmail'
      and scope_row.connection_key = replay.connection_key
      and scope_row.root_batch_id = replay.root_batch_id
      and scope_row.execution_mode = 'sync'
      and scope_row.commissioning_scope_id =
        'truth-shadow-gmail-model-scope:v1:' || scope_row.scope_hash
      and scope_row.scope_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(scope_row.canonical_scope), 'UTF8'
      ), 'sha256'), 'hex')
      and replay.replay_id = 'truth-shadow-gmail-model-replay:v1:' || replay.replay_hash
      and replay.replay_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_replay), 'UTF8'
      ), 'sha256'), 'hex')
      and replay.successor_payload_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.successor_payload), 'UTF8'
      ), 'sha256'), 'hex')
      and replay.supersession_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_supersession), 'UTF8'
      ), 'sha256'), 'hex')
      and replay.receipt_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_receipt), 'UTF8'
      ), 'sha256'), 'hex')
      and batch.source_system = 'gmail'
      and batch.connection_key = replay.connection_key
      and batch.mode = scope_row.root_ingest_mode
      and batch.mode in ('backfill', 'reconciliation')
      and batch.status = 'committed'
      and batch.committed_cursor_version = replay.source_cursor_version
      and batch.committed_cursor_value = replay.source_cursor_value
      and obligation.reason_code = 'MODEL_RUNTIME_DISABLED'
      and obligation.model_plan_id is null
      and obligation.model_child_job_id is null
      and obligation.obligation_hash = encode(extensions.digest(convert_to(
        obligation.canonical_obligation::text, 'UTF8'
      ), 'sha256'), 'hex')
      and not exists (
        select 1
        from public.gmail_model_extraction_review_resolutions resolution
        where resolution.workspace_key = replay.workspace_key
          and resolution.obligation_id = replay.obligation_id
      )
      and prior_plan.extraction_plan_hash = replay.prior_extraction_plan_hash
      and prior_plan.plan_seal_hash = replay.prior_plan_seal_hash
      and prior_plan.plan_seal_hash = encode(extensions.digest(convert_to(
        prior_plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and prior_plan.planning_status = 'review_required'
      and prior_plan.planning_failure_code = 'MODEL_RUNTIME_DISABLED'
      and prior_plan.model_plan_id is null
      and prior_plan.model_plan_hash is null
      and prior_plan.model_plan is null
      and prior_plan.execution_mode = 'none'
      and prior_plan.deterministic_candidate_count = 0
      and prior_parent.source_system = 'gmail'
      and prior_parent.connection_key = replay.connection_key
      and prior_parent.job_kind = 'gmail_extract_message_claims'
      and prior_parent.observation_id = replay.source_observation_id
      and prior_parent.state = 'succeeded'
      and prior_parent.result #>> '{truthPlan,extractionPlanId}' =
        replay.prior_extraction_plan_id
      and prior_parent.result #>> '{truthPlan,planningStatus}' = 'review_required'
      and prior_parent.result #>> '{truthPlan,planningFailureCode}' =
        'MODEL_RUNTIME_DISABLED'
      and prior_lineage.root_batch_id = replay.root_batch_id
      and prior_lineage.parent_job_id = replay.original_parent_job_id
      and prior_lineage.root_job_id = replay.root_job_id
      and prior_lineage.source_cursor_version = replay.source_cursor_version
      and prior_lineage.source_cursor_value = replay.source_cursor_value
      and review_job.job_kind = 'gmail_review_model_extraction'
      and review_job.observation_id = replay.source_observation_id
      and review_job.state = 'superseded'
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.last_error_code = 'GMAIL_MODEL_RUNTIME_COMMISSIONED'
      and review_job.result = replay.canonical_supersession
      and review_job.completed_at is not null
      and review_lineage.root_batch_id = replay.root_batch_id
      and review_lineage.parent_job_id = replay.prior_parent_job_id
      and review_lineage.root_job_id = replay.root_job_id
      and review_lineage.source_cursor_version = replay.source_cursor_version
      and review_lineage.source_cursor_value = replay.source_cursor_value
      and successor.dedupe_key = replay.successor_dedupe_key
      and successor.source_system = 'gmail'
      and successor.connection_key = replay.connection_key
      and successor.job_kind = 'gmail_extract_message_claims'
      and successor.observation_id = replay.source_observation_id
      and successor.source_object_id = prior_parent.source_object_id
      and successor.payload = replay.successor_payload
      and successor.state <> 'superseded'
      and successor_lineage.root_batch_id = replay.root_batch_id
      and successor_lineage.parent_job_id = replay.original_parent_job_id
      and successor_lineage.root_job_id = replay.root_job_id
      and successor_lineage.source_cursor_version = replay.source_cursor_version
      and successor_lineage.source_cursor_value = replay.source_cursor_value
      and observation.content_hash = replay.source_observation_content_hash
      and observation.source_system = 'gmail'
      and observation.connection_key = replay.connection_key
      and observation.source_object_type = 'gmail_message_parsed'
      and observation.normalized_payload->>'schemaVersion' = 'gmail-parsed-message-v2'
      and not exists (
        select 1
        from public.truth_required_sources required_source
        where required_source.workspace_key = replay.workspace_key
          and required_source.source_system = 'gmail'
          and required_source.connection_key = replay.connection_key
      )
  );
$function$;

create or replace function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  p_workspace_key text,
  p_parent_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.truth_shadow_gmail_model_commissioning_scopes scope_row
      on scope_row.workspace_key = replay.workspace_key
     and scope_row.commissioning_scope_id = replay.commissioning_scope_id
    join public.source_processing_jobs successor
      on successor.workspace_key = replay.workspace_key
     and successor.job_id = replay.successor_parent_job_id
    where replay.workspace_key = p_workspace_key
      and replay.successor_parent_job_id = p_parent_job_id
      and successor.state not in ('dead_letter', 'superseded')
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key, replay.obligation_id
      )
      and not exists (
        select 1
        from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key = replay.workspace_key
          and epoch.root_batch_id = replay.root_batch_id
      )
      and not exists (
        select 1
        from public.truth_shadow_root_source_cuts root_cut
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
  );
$function$;

-- The BEFORE INSERT routing trigger cannot query the not-yet-visible child row,
-- so it validates the complete server-derived child envelope supplied in NEW.
create or replace function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
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
  select exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = replay.workspace_key
     and plan.parent_job_id = replay.successor_parent_job_id
    where replay.workspace_key = p_workspace_key
      and replay.successor_parent_job_id::text = p_parent_job_id
      and p_child_job_id is not null
      and p_dedupe_key = 'gmail:model-claims:v1:' || plan.model_plan_hash
      and p_observation_id = replay.source_observation_id
      and jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) = 'object'
      and private.truth_jsonb_has_only_keys(p_payload, array[
        'schemaVersion','modelPlanId','contextSealId','batchId',
        'rootBatchId','rootJobId','parentJobId'
      ])
      and p_payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
      and p_payload->>'modelPlanId' = plan.model_plan_id
      and p_payload->>'contextSealId' = plan.context_seal_id
      and p_payload->>'batchId' = replay.root_batch_id::text
      and p_payload->>'rootBatchId' = replay.root_batch_id::text
      and p_payload->>'rootJobId' = replay.root_job_id::text
      and p_payload->>'parentJobId' = replay.successor_parent_job_id::text
      and plan.planning_status = 'complete'
      and plan.model_plan_id is not null
      and plan.model_plan_hash is not null
      and plan.model_plan is not null
      and plan.execution_mode = 'sync'
      and plan.root_ingest_mode in ('backfill', 'reconciliation')
      and private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
        replay.workspace_key, replay.successor_parent_job_id
      )
  );
$function$;

create or replace function private.truth_shadow_gmail_model_commissioning_job_allowed_v1(
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
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = job.workspace_key
     and lineage.job_id = job.job_id
    where job.workspace_key = p_workspace_key
      and job.job_id = p_job_id
      and job.source_system = 'gmail'
      and job.job_kind = 'gmail_extract_message_model_claims'
      and lineage.parent_job_id is not null
      and private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
        job.workspace_key,
        lineage.parent_job_id::text,
        job.job_id,
        job.dedupe_key,
        job.observation_id,
        job.payload
      )
  );
$function$;

-- Shared immutable-scope admission used by later commissioning runtimes.  The
-- message branch retains its content-addressed replay proof.  Attachment
-- review jobs have no replay row, so they are admitted only when their
-- immutable lineage lands in the exact shadow-only root scope.  Deliberately
-- do not bind mutable lease/job state or the later review resolution here:
-- deferred candidate validation must be able to re-prove this same source job
-- after successful finalization.
create or replace function private.truth_shadow_model_commissioning_job_allowed(
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
      from public.source_processing_jobs job
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key = job.workspace_key
       and lineage.source_system = job.source_system
       and lineage.connection_key = job.connection_key
       and lineage.job_id = job.job_id
      join public.truth_shadow_gmail_model_commissioning_scopes scope
        on scope.workspace_key = lineage.workspace_key
       and scope.source_system = lineage.source_system
       and scope.connection_key = lineage.connection_key
       and scope.root_batch_id = lineage.root_batch_id
      where job.workspace_key = p_workspace_key
        and job.job_id = p_job_id
        and job.source_system = 'gmail'
        and job.connection_key like 'shadow-%'
        and job.job_kind = 'gmail_review_attachment_extraction'
        and job.observation_id is not null
        and scope.shadow_only = true
        and scope.production_eligible = false
        and scope.production_publication_attempted = false
    );
$function$;

revoke all on function private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  text,text,uuid,text,text,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.truth_shadow_gmail_model_commissioning_job_allowed_v1(text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_shadow_model_commissioning_job_allowed(text,uuid)
  from public, anon, authenticated, service_role;

-- Only a content-addressed replay parent may override the normal backfill Batch
-- choice.  History remains sync, ordinary backfill/reconciliation remains
-- Batch, and plan-less deterministic work remains none.
do $sealer_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  v_execution_mode := case
    when not v_has_model_plan then 'none'
    when v_batch.mode = 'history' then 'sync'
    when v_batch.mode in ('backfill','reconciliation') then 'batch'
    else 'parked' end;$old$;
  v_new text := $new$  v_execution_mode := case
    when not v_has_model_plan then 'none'
    when private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
      p_workspace_key, p_job_id
    ) then 'sync'
    when v_batch.mode = 'history' then 'sync'
    when v_batch.mode in ('backfill','reconciliation') then 'batch'
    else 'parked' end;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'Gmail execution-mode branch differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition or position(v_new in v_updated) = 0
      or position(v_old in v_updated) > 0 then
      raise exception 'Gmail commissioning execution-mode rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'Gmail commissioning execution-mode rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$sealer_rewrite$;

-- Preserve every existing Gmail epoch gate.  Only the exact commissioning
-- child envelope can pass the model-disabled route; review jobs stay parked.
create or replace function private.route_gmail_link_claim_wait_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.source_system='gmail' and new.job_kind='gmail_fetch_raw_message'
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MESSAGE_REVISION_SCHEMA_REQUIRED';
    new.safe_error_detail:='Legacy raw-fetch jobs are quarantined; revision materialization v1 is required.';
  elsif new.source_system='gmail' and new.job_kind='gmail_resolve_entity_links'
    and new.state in ('queued','retry_wait') and not exists (
      select 1 from public.truth_gmail_link_epoch_members member
      where member.workspace_key=new.workspace_key and member.link_job_id=new.job_id
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED';
    new.safe_error_detail:='Parsed evidence is durable; an epoch-bound link member is required.';
  elsif new.source_system='gmail' and new.job_kind=any(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims'
    ]) and new.state in ('queued','retry_wait') and not exists (
      select 1 from public.source_processing_job_lineage lineage
      join public.truth_gmail_link_epochs epoch
        on epoch.workspace_key=lineage.workspace_key and epoch.root_batch_id=lineage.root_batch_id
      join public.truth_gmail_link_epoch_seals seal
        on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
      where lineage.job_id=new.job_id and lineage.workspace_key=new.workspace_key
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SEAL_REQUIRED';
    new.safe_error_detail:='Claim extraction waits for the exact sealed Gmail link epoch.';
  elsif new.source_system='gmail'
    and new.job_kind='gmail_extract_message_model_claims'
    and new.state in ('queued','retry_wait')
    and not private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
      new.workspace_key,
      new.payload->>'parentJobId',
      new.job_id,
      new.dedupe_key,
      new.observation_id,
      new.payload
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MODEL_RUNTIME_DISABLED';
    new.safe_error_detail:=
      'Model extraction requires an exact shadow commissioning replay authority.';
  elsif new.source_system='gmail'
    and new.job_kind='gmail_review_model_extraction'
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MODEL_RUNTIME_DISABLED';
    new.safe_error_detail:='The local shadow rollout permits only explicitly commissioned model execution.';
  end if;
  return new;
end;
$function$;

revoke all on function private.route_gmail_link_claim_wait_v2()
  from public, anon, authenticated, service_role;
drop trigger if exists source_processing_job_gmail_link_claim_wait
  on public.source_processing_jobs;
create trigger source_processing_job_gmail_link_claim_wait
before insert or update of state on public.source_processing_jobs
for each row execute function private.route_gmail_link_claim_wait_v2();

-- The claim authority retains all SKIP LOCKED and cut-lock behavior.  Its one
-- model exclusion becomes a proof-gated exception; review jobs remain excluded.
do $claim_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$      and not (job.source_system = 'gmail' and job.job_kind = any(array[
        'gmail_extract_message_model_claims', 'gmail_review_model_extraction'
      ]))$old$;
  v_new text := $new$      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_review_model_extraction')
      and (job.source_system <> 'gmail'
        or job.job_kind <> 'gmail_extract_message_model_claims'
        or private.truth_shadow_gmail_model_commissioning_job_allowed_v1(
          job.workspace_key, job.job_id
        ))$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'model job exclusion differs from the reviewed claim authority'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition or position(v_new in v_updated) = 0
      or position(v_old in v_updated) > 0 then
      raise exception 'model commissioning claim rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'model commissioning claim rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$claim_rewrite$;

-- A runtime-disabled obligation is no longer a blocker only when the complete
-- immutable replay/supersession relation validates.  The queued successor and
-- later model child continue to block through the ordinary processing/model
-- completeness authorities.
do $review_blocker_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.unresolved_gmail_model_extraction_reviews(text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  where obligation.workspace_key=p_workspace_key
    and not exists(select 1 from public.gmail_model_extraction_review_resolutions resolution
      where resolution.obligation_id=obligation.obligation_id)$old$;
  v_new text := $new$  where obligation.workspace_key=p_workspace_key
    and not private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
      obligation.workspace_key, obligation.obligation_id
    )
    and not exists(select 1 from public.gmail_model_extraction_review_resolutions resolution
      where resolution.obligation_id=obligation.obligation_id)$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'unresolved Gmail model review authority differs from predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition or position(v_new in v_updated) = 0
      or position(v_old in v_updated) > 0 then
      raise exception 'Gmail model review blocker rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'Gmail model review blocker rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$review_blocker_rewrite$;

-- The acceptance coordinator predates commissioned model replay parents.  A
-- parent manifest alone is not a sealed candidate frontier when its model
-- child is still missing/runnable.  Return a retryable not-ready receipt until
-- the exact plan is complete and every model plan has either a successful
-- result or its own durable review obligation.
do $acceptance_frontier_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
  );
  v_definition text;
  v_updated text;
  v_anchor text := $anchor$  -- Attachment/review parents can create later claim children. Do not certify a
  -- frontier while any such producer is still nonterminal.$anchor$;
  v_new text := $new$  -- Commissioned message replays can create a model child only after their parent
  -- plan is sealed. Do not freeze the acceptance frontier before that child has
  -- one exact successful result or durable model-review terminal.
  if exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.source_processing_jobs successor
      on successor.workspace_key = replay.workspace_key
     and successor.job_id = replay.successor_parent_job_id
    left join public.gmail_model_extraction_plans plan
      on plan.workspace_key = replay.workspace_key
     and plan.parent_job_id = replay.successor_parent_job_id
    where replay.workspace_key = p_workspace_key
      and replay.connection_key = v_pending.connection_key
      and replay.root_batch_id = v_pending.root_batch_id
      and (
        successor.state <> 'succeeded'
        or plan.extraction_plan_id is null
        or plan.planning_status <> 'complete'
        or (
          plan.model_plan_id is not null
          and exists (
            select 1
            from private.unresolved_gmail_model_extraction_jobs(p_workspace_key) unresolved
            where unresolved.parent_job_id = replay.successor_parent_job_id
          )
        )
      )
  ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'MODEL_COMMISSIONING_FRONTIER_OPEN',
      'productionPublicationAttempted', false
    );
  end if;

  -- Attachment/review parents can create later claim children. Do not certify a
  -- frontier while any such producer is still nonterminal.$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('MODEL_COMMISSIONING_FRONTIER_OPEN' in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0 then
      raise exception 'shadow acceptance frontier anchor differs from predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_anchor, v_new);
    if v_updated = v_definition
      or position('MODEL_COMMISSIONING_FRONTIER_OPEN' in v_updated) = 0 then
      raise exception 'shadow acceptance commissioning rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  end if;
end;
$acceptance_frontier_rewrite$;

create or replace function private.prepare_truth_shadow_gmail_model_commissioning(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_limit integer,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '30s'
set statement_timeout = '120s'
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_scope public.truth_shadow_gmail_model_commissioning_scopes%rowtype;
  v_candidate record;
  v_scope_core jsonb;
  v_scope_hash text;
  v_scope_id text;
  v_replay_core jsonb;
  v_replay_hash text;
  v_replay_id text;
  v_successor_job_id uuid;
  v_successor_dedupe_key text;
  v_successor_payload jsonb;
  v_successor_payload_hash text;
  v_supersession jsonb;
  v_supersession_hash text;
  v_receipt jsonb;
  v_receipt_hash text;
  v_receipts jsonb := '[]'::jsonb;
  v_all_receipts jsonb := '[]'::jsonb;
  v_prepared_count integer := 0;
  v_replay_count integer := 0;
  v_attachment_activated_count integer := 0;
  v_attachment_runnable_count integer := 0;
  v_updated_count integer;
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid shadow Gmail model commissioning authority'
      using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or p_connection_key not like 'shadow-%'
    or p_root_batch_id is null
    or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'shadow Gmail model commissioning request is invalid'
      using errcode = '22023';
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-shadow-gmail-model-commissioning-v1:' || p_workspace_key || ':' ||
      p_connection_key || ':' || p_root_batch_id::text,
    0
  ));

  select * into v_batch
  from public.source_ingest_batches batch
  where batch.workspace_key = p_workspace_key
    and batch.source_system = 'gmail'
    and batch.connection_key = p_connection_key
    and batch.batch_id = p_root_batch_id
  for key share;
  if not found
    or v_batch.status <> 'committed'
    or v_batch.mode not in ('backfill', 'reconciliation')
    or v_batch.committed_cursor_version is null
    or v_batch.committed_cursor_value is null then
    raise exception 'commissioning root is not one committed shadow Gmail backfill/reconciliation'
      using errcode = '23514';
  end if;
  if exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = p_workspace_key
        and required_source.source_system = 'gmail'
        and required_source.connection_key = p_connection_key
    ) then
    raise exception 'required/live Gmail sources cannot enter shadow model commissioning'
      using errcode = '42501';
  end if;
  if not exists (
      select 1
      from public.truth_gmail_link_epochs epoch
      join public.truth_gmail_link_epoch_seals seal
        on seal.workspace_key = epoch.workspace_key
       and seal.epoch_id = epoch.epoch_id
      where epoch.workspace_key = p_workspace_key
        and epoch.connection_key = p_connection_key
        and epoch.root_batch_id = p_root_batch_id
    ) then
    raise exception 'shadow Gmail model commissioning requires the exact sealed link epoch'
      using errcode = '23514';
  end if;
  if exists (
      select 1 from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key = p_workspace_key
        and epoch.root_batch_id = p_root_batch_id
    )
    or exists (
      select 1 from public.truth_shadow_root_source_cuts root_cut
      where root_cut.workspace_key = p_workspace_key
        and root_cut.root_batch_id = p_root_batch_id
    )
    or exists (
      select 1
      from public.truth_builds build
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = build.workspace_key
       and root_cut.source_cut_id = build.source_cut_id
      where root_cut.workspace_key = p_workspace_key
        and root_cut.root_batch_id = p_root_batch_id
    )
    or exists (
      select 1
      from public.truth_publications publication
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = publication.workspace_key
       and root_cut.source_cut_id = publication.source_cut_id
      where root_cut.workspace_key = p_workspace_key
        and root_cut.root_batch_id = p_root_batch_id
    ) then
    raise exception 'accepted/cut/built/published roots cannot be reopened for model commissioning'
      using errcode = '23514';
  end if;

  v_scope_core := jsonb_build_object(
    'schemaVersion', 'truth-shadow-gmail-model-commissioning-scope-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', p_connection_key,
    'rootBatchId', p_root_batch_id,
    'rootIngestMode', v_batch.mode,
    'sourceCursorVersion', v_batch.committed_cursor_version,
    'sourceCursorValue', v_batch.committed_cursor_value,
    'executionMode', 'sync',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_scope_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_scope_core), 'UTF8'
  ), 'sha256'), 'hex');
  v_scope_id := 'truth-shadow-gmail-model-scope:v1:' || v_scope_hash;
  insert into public.truth_shadow_gmail_model_commissioning_scopes(
    commissioning_scope_id, scope_hash, workspace_key, source_system,
    connection_key, root_batch_id, root_ingest_mode, source_cursor_version,
    source_cursor_value, execution_mode, canonical_scope, schema_version,
    shadow_only, production_eligible, production_publication_attempted
  ) values (
    v_scope_id, v_scope_hash, p_workspace_key, 'gmail', p_connection_key,
    p_root_batch_id, v_batch.mode, v_batch.committed_cursor_version,
    v_batch.committed_cursor_value, 'sync', v_scope_core,
    'truth-shadow-gmail-model-commissioning-scope-v1', true, false, false
  ) on conflict (workspace_key, connection_key, root_batch_id) do nothing;
  select * into strict v_scope
  from public.truth_shadow_gmail_model_commissioning_scopes scope_row
  where scope_row.workspace_key = p_workspace_key
    and scope_row.connection_key = p_connection_key
    and scope_row.root_batch_id = p_root_batch_id;
  if v_scope.commissioning_scope_id is distinct from v_scope_id
    or v_scope.scope_hash is distinct from v_scope_hash
    or v_scope.canonical_scope is distinct from v_scope_core
    or v_scope.execution_mode <> 'sync'
    or not v_scope.shadow_only
    or v_scope.production_eligible
    or v_scope.production_publication_attempted then
    raise exception 'shadow Gmail model commissioning scope conflicts with replay input'
      using errcode = '23505';
  end if;

  -- Attachment extraction review jobs predate the model commissioning scope
  -- and may have been deliberately parked in waiting_runtime.  Activate only
  -- unresolved jobs in this exact immutable root.  Queued/retry jobs are left
  -- untouched, and no attempt history is reset.
  update public.source_processing_jobs review_job
  set state = 'queued',
      available_at = clock_timestamp(),
      last_error_code = '',
      safe_error_detail = '',
      updated_at = clock_timestamp()
  from public.source_processing_job_lineage review_lineage
  where review_job.workspace_key = p_workspace_key
    and review_job.source_system = 'gmail'
    and review_job.connection_key = p_connection_key
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.state = 'waiting_runtime'
    and review_job.attempt_count < review_job.max_attempts
    and review_job.lease_owner is null
    and review_job.lease_expires_at is null
    and review_job.completed_at is null
    and review_job.result = '{}'::jsonb
    and review_lineage.workspace_key = review_job.workspace_key
    and review_lineage.source_system = review_job.source_system
    and review_lineage.connection_key = review_job.connection_key
    and review_lineage.job_id = review_job.job_id
    and review_lineage.root_batch_id = p_root_batch_id
    and review_lineage.source_cursor_version = v_batch.committed_cursor_version
    and review_lineage.source_cursor_value = v_batch.committed_cursor_value
    and exists (
      select 1
      from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
      where unresolved.review_job_id = review_job.job_id
        and unresolved.attachment_observation_id = review_job.observation_id
        and unresolved.connection_key = p_connection_key
        and unresolved.root_batch_id = p_root_batch_id
    );
  get diagnostics v_attachment_activated_count = row_count;

  select count(*)::integer into v_attachment_runnable_count
  from public.source_processing_jobs review_job
  join public.source_processing_job_lineage review_lineage
    on review_lineage.workspace_key = review_job.workspace_key
   and review_lineage.source_system = review_job.source_system
   and review_lineage.connection_key = review_job.connection_key
   and review_lineage.job_id = review_job.job_id
  where review_job.workspace_key = p_workspace_key
    and review_job.source_system = 'gmail'
    and review_job.connection_key = p_connection_key
    and review_job.job_kind = 'gmail_review_attachment_extraction'
    and review_job.state in ('queued', 'retry_wait')
    and review_job.attempt_count < review_job.max_attempts
    and review_lineage.root_batch_id = p_root_batch_id
    and private.truth_shadow_model_commissioning_job_allowed(
      review_job.workspace_key, review_job.job_id
    )
    and exists (
      select 1
      from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
      where unresolved.review_job_id = review_job.job_id
        and unresolved.attachment_observation_id = review_job.observation_id
        and unresolved.connection_key = p_connection_key
        and unresolved.root_batch_id = p_root_batch_id
    );

  for v_candidate in
    select
      obligation.obligation_id,
      obligation.obligation_hash,
      obligation.review_job_id,
      plan.extraction_plan_id,
      plan.extraction_plan_hash,
      plan.plan_seal_hash,
      plan.source_observation_id,
      plan.source_observation_content_hash,
      parent_job.job_id as parent_job_id,
      parent_job.source_object_id,
      parent_job.max_attempts,
      parent_job.payload as parent_payload,
      lineage.parent_job_id as original_parent_job_id,
      lineage.root_job_id,
      lineage.source_cursor_version,
      lineage.source_cursor_value
    from public.gmail_model_extraction_review_obligations obligation
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = obligation.workspace_key
     and plan.extraction_plan_id = obligation.extraction_plan_id
    join public.source_processing_jobs parent_job
      on parent_job.workspace_key = obligation.workspace_key
     and parent_job.job_id = plan.parent_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = obligation.workspace_key
     and lineage.job_id = parent_job.job_id
    join public.source_processing_jobs review_job
      on review_job.workspace_key = obligation.workspace_key
     and review_job.job_id = obligation.review_job_id
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = obligation.workspace_key
     and review_lineage.job_id = review_job.job_id
    join public.source_processing_job_children review_child
      on review_child.parent_job_id = parent_job.job_id
     and review_child.child_job_id = review_job.job_id
    join public.source_observations observation
      on observation.workspace_key = obligation.workspace_key
     and observation.observation_id = plan.source_observation_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = obligation.workspace_key
     and manifest.job_id = parent_job.job_id
    where obligation.workspace_key = p_workspace_key
      and parent_job.connection_key = p_connection_key
      and lineage.root_batch_id = p_root_batch_id
      and obligation.reason_code = 'MODEL_RUNTIME_DISABLED'
      and obligation.model_plan_id is null
      and obligation.model_child_job_id is null
      and obligation.obligation_hash = encode(extensions.digest(convert_to(
        obligation.canonical_obligation::text, 'UTF8'
      ), 'sha256'), 'hex')
      and plan.planning_status = 'review_required'
      and plan.planning_failure_code = 'MODEL_RUNTIME_DISABLED'
      and plan.model_plan_id is null
      and plan.model_plan_hash is null
      and plan.model_plan is null
      and plan.execution_mode = 'none'
      and plan.deterministic_candidate_count = 0
      and plan.plan_seal_hash = encode(extensions.digest(convert_to(
        plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and parent_job.source_system = 'gmail'
      and parent_job.job_kind = 'gmail_extract_message_claims'
      and parent_job.observation_id = plan.source_observation_id
      and parent_job.state = 'succeeded'
      and parent_job.completed_at is not null
      and parent_job.result #>> '{truthPlan,extractionPlanId}' = plan.extraction_plan_id
      and parent_job.result #>> '{truthPlan,planningStatus}' = 'review_required'
      and parent_job.result #>> '{truthPlan,planningFailureCode}' = 'MODEL_RUNTIME_DISABLED'
      and lineage.parent_job_id is not null
      and lineage.source_cursor_version = v_batch.committed_cursor_version
      and lineage.source_cursor_value = v_batch.committed_cursor_value
      and review_job.job_kind = 'gmail_review_model_extraction'
      and review_job.observation_id = plan.source_observation_id
      and review_job.state = 'waiting_runtime'
      and review_job.attempt_count = 0
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
      and review_job.result = '{}'::jsonb
      and review_job.completed_at is null
      and review_job.payload->>'extractionPlanId' = plan.extraction_plan_id
      and review_lineage.root_batch_id = lineage.root_batch_id
      and review_lineage.parent_job_id = parent_job.job_id
      and review_lineage.root_job_id = lineage.root_job_id
      and review_lineage.source_cursor_version = lineage.source_cursor_version
      and review_lineage.source_cursor_value = lineage.source_cursor_value
      and observation.content_hash = plan.source_observation_content_hash
      and observation.source_system = 'gmail'
      and observation.connection_key = p_connection_key
      and observation.source_object_type = 'gmail_message_parsed'
      and observation.normalized_payload->>'schemaVersion' = 'gmail-parsed-message-v2'
      and manifest.candidate_count = 0
      and manifest.manifest_hash = plan.deterministic_manifest_hash
      and manifest.manifest_hash = encode(extensions.digest(convert_to(
        manifest.canonical_manifest::text, 'UTF8'
      ), 'sha256'), 'hex')
      and exists (
        select 1
        from public.truth_pending_acceptance_epoch_manifests membership
        join public.truth_pending_acceptance_epochs pending
          on pending.workspace_key = membership.workspace_key
         and pending.obligation_id = membership.obligation_id
        where membership.workspace_key = p_workspace_key
          and membership.source_job_id = parent_job.job_id
          and membership.candidate_count = 0
          and membership.candidate_manifest_hash = manifest.manifest_hash
          and pending.root_batch_id = p_root_batch_id
      )
      and not exists (
        select 1 from public.gmail_model_extraction_review_resolutions resolution
        where resolution.workspace_key = obligation.workspace_key
          and resolution.obligation_id = obligation.obligation_id
      )
      and not exists (
        select 1 from public.truth_shadow_gmail_model_commissioning_replays replay
        where replay.workspace_key = obligation.workspace_key
          and replay.obligation_id = obligation.obligation_id
      )
    order by obligation.created_at, obligation.obligation_id
    for update of review_job skip locked
    limit p_limit
  loop
    v_replay_core := jsonb_build_object(
      'schemaVersion', 'truth-shadow-gmail-model-commissioning-replay-v1',
      'workspaceKey', p_workspace_key,
      'commissioningScopeId', v_scope_id,
      'connectionKey', p_connection_key,
      'rootBatchId', p_root_batch_id,
      'sourceCursorVersion', v_candidate.source_cursor_version,
      'sourceCursorValue', v_candidate.source_cursor_value,
      'obligationId', v_candidate.obligation_id,
      'obligationHash', v_candidate.obligation_hash,
      'priorExtractionPlanId', v_candidate.extraction_plan_id,
      'priorExtractionPlanHash', v_candidate.extraction_plan_hash,
      'priorPlanSealHash', v_candidate.plan_seal_hash,
      'priorParentJobId', v_candidate.parent_job_id,
      'priorReviewJobId', v_candidate.review_job_id,
      'originalParentJobId', v_candidate.original_parent_job_id,
      'rootJobId', v_candidate.root_job_id,
      'sourceObservationId', v_candidate.source_observation_id,
      'sourceObservationContentHash', v_candidate.source_observation_content_hash,
      'executionMode', 'sync',
      'successorJobDerivation', 'uuid-v4-from-replay-hash-v1',
      'shadowOnly', true,
      'productionPublicationAttempted', false
    );
    v_replay_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_replay_core), 'UTF8'
    ), 'sha256'), 'hex');
    v_replay_id := 'truth-shadow-gmail-model-replay:v1:' || v_replay_hash;
    v_successor_job_id := (
      substr(v_replay_hash, 1, 8) || '-' ||
      substr(v_replay_hash, 9, 4) || '-4' ||
      substr(v_replay_hash, 14, 3) || '-8' ||
      substr(v_replay_hash, 18, 3) || '-' ||
      substr(v_replay_hash, 21, 12)
    )::uuid;
    v_successor_dedupe_key :=
      'truth-shadow-gmail-model-replay-parent:v1:' || v_replay_hash;
    v_successor_payload := v_candidate.parent_payload || jsonb_build_object(
      'modelCommissioningScopeId', v_scope_id,
      'modelCommissioningReplayId', v_replay_id,
      'runtimeDisabledObligationId', v_candidate.obligation_id,
      'runtimeDisabledParentJobId', v_candidate.parent_job_id,
      'shadowOnly', true,
      'productionPublicationAttempted', false
    );
    v_successor_payload_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_successor_payload), 'UTF8'
    ), 'sha256'), 'hex');
    v_supersession := jsonb_build_object(
      'schemaVersion', 'truth-shadow-gmail-model-review-supersession-v1',
      'replayId', v_replay_id,
      'commissioningScopeId', v_scope_id,
      'obligationId', v_candidate.obligation_id,
      'priorExtractionPlanId', v_candidate.extraction_plan_id,
      'priorParentJobId', v_candidate.parent_job_id,
      'reviewJobId', v_candidate.review_job_id,
      'successorParentJobId', v_successor_job_id,
      'status', 'superseded_by_model_commissioning_replay',
      'shadowOnly', true,
      'mutatesOperationalState', false,
      'productionPublicationAttempted', false
    );
    v_supersession_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_supersession), 'UTF8'
    ), 'sha256'), 'hex');
    v_receipt := jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'status', 'prepared',
      'schemaVersion', 'truth-shadow-gmail-model-commissioning-receipt-v1',
      'workspaceKey', p_workspace_key,
      'connectionKey', p_connection_key,
      'rootBatchId', p_root_batch_id,
      'commissioningScopeId', v_scope_id,
      'replayId', v_replay_id,
      'replayHash', v_replay_hash,
      'obligationId', v_candidate.obligation_id,
      'priorParentJobId', v_candidate.parent_job_id,
      'priorReviewJobId', v_candidate.review_job_id,
      'successorParentJobId', v_successor_job_id,
      'executionMode', 'sync',
      'shadowOnly', true,
      'mutatesOperationalState', false,
      'productionPublicationAttempted', false
    );
    v_receipt_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_receipt), 'UTF8'
    ), 'sha256'), 'hex');

    insert into public.source_processing_jobs(
      job_id, dedupe_key, workspace_key, source_system, connection_key, job_kind,
      observation_id, source_object_id, state, attempt_count, max_attempts,
      available_at, lease_owner, lease_fence, lease_expires_at,
      last_error_code, safe_error_detail, processor_version,
      payload, result, created_at, updated_at, completed_at
    ) values (
      v_successor_job_id, v_successor_dedupe_key, p_workspace_key, 'gmail',
      p_connection_key, 'gmail_extract_message_claims',
      v_candidate.source_observation_id, v_candidate.source_object_id,
      'waiting_runtime', 0, v_candidate.max_attempts,
      clock_timestamp(), null, 0, null,
      'GMAIL_MODEL_COMMISSIONING_REPLAY_PREPARED',
      'Exact shadow model commissioning replay is being integrity-bound.', '',
      v_successor_payload, '{}'::jsonb, clock_timestamp(), clock_timestamp(), null
    );
    insert into public.source_processing_job_lineage(
      job_id, workspace_key, source_system, connection_key, root_batch_id,
      parent_job_id, root_job_id, source_cursor_version, source_cursor_value
    ) values (
      v_successor_job_id, p_workspace_key, 'gmail', p_connection_key,
      p_root_batch_id, v_candidate.original_parent_job_id,
      v_candidate.root_job_id, v_candidate.source_cursor_version,
      v_candidate.source_cursor_value
    );
    insert into public.truth_shadow_gmail_model_commissioning_replays(
      replay_id, replay_hash, workspace_key, commissioning_scope_id,
      connection_key, root_batch_id, source_cursor_version, source_cursor_value,
      obligation_id, prior_extraction_plan_id, prior_extraction_plan_hash,
      prior_plan_seal_hash, prior_parent_job_id, prior_review_job_id,
      successor_parent_job_id, original_parent_job_id, root_job_id,
      source_observation_id, source_observation_content_hash,
      successor_dedupe_key, successor_payload, successor_payload_hash,
      canonical_replay, canonical_supersession, supersession_hash,
      canonical_receipt, receipt_hash, schema_version,
      shadow_only, production_eligible, production_publication_attempted
    ) values (
      v_replay_id, v_replay_hash, p_workspace_key, v_scope_id,
      p_connection_key, p_root_batch_id, v_candidate.source_cursor_version,
      v_candidate.source_cursor_value, v_candidate.obligation_id,
      v_candidate.extraction_plan_id, v_candidate.extraction_plan_hash,
      v_candidate.plan_seal_hash, v_candidate.parent_job_id,
      v_candidate.review_job_id, v_successor_job_id,
      v_candidate.original_parent_job_id, v_candidate.root_job_id,
      v_candidate.source_observation_id, v_candidate.source_observation_content_hash,
      v_successor_dedupe_key, v_successor_payload, v_successor_payload_hash,
      v_replay_core, v_supersession, v_supersession_hash,
      v_receipt, v_receipt_hash,
      'truth-shadow-gmail-model-commissioning-replay-v1', true, false, false
    );

    update public.source_processing_jobs review_job
    set state = 'superseded', lease_owner = null, lease_expires_at = null,
        last_error_code = 'GMAIL_MODEL_RUNTIME_COMMISSIONED',
        safe_error_detail =
          'Runtime-disabled review was superseded by one exact shadow model replay.',
        processor_version = 'truth-shadow-gmail-model-commissioning-v1',
        result = v_supersession, updated_at = clock_timestamp(),
        completed_at = clock_timestamp()
    where review_job.workspace_key = p_workspace_key
      and review_job.job_id = v_candidate.review_job_id
      and review_job.state = 'waiting_runtime'
      and review_job.attempt_count = 0
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.last_error_code = 'GMAIL_MODEL_RUNTIME_DISABLED'
      and review_job.result = '{}'::jsonb;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'runtime-disabled Gmail review changed during commissioning'
        using errcode = '40001';
    end if;

    update public.source_processing_jobs successor
    set state = 'queued', available_at = clock_timestamp(),
        last_error_code = '', safe_error_detail = '', updated_at = clock_timestamp()
    where successor.workspace_key = p_workspace_key
      and successor.job_id = v_successor_job_id
      and successor.state = 'waiting_runtime'
      and successor.last_error_code = 'GMAIL_MODEL_COMMISSIONING_REPLAY_PREPARED';
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'commissioning successor could not enter the deterministic parent queue'
        using errcode = '40001';
    end if;
    if not private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
      p_workspace_key, v_successor_job_id
    ) then
      raise exception 'commissioning replay failed its exact integrity read-back'
        using errcode = '23514';
    end if;
    v_receipts := v_receipts || jsonb_build_array(v_receipt);
    v_prepared_count := v_prepared_count + 1;
  end loop;

  select count(*)::integer,
    coalesce(jsonb_agg(replay.canonical_receipt order by replay.replay_id), '[]'::jsonb)
  into v_replay_count, v_all_receipts
  from public.truth_shadow_gmail_model_commissioning_replays replay
  where replay.workspace_key = p_workspace_key
    and replay.commissioning_scope_id = v_scope_id;
  if exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    where replay.workspace_key = p_workspace_key
      and replay.commissioning_scope_id = v_scope_id
      and not private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key, replay.obligation_id
      )
  ) then
    raise exception 'stored commissioning replay failed final integrity read-back'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', case when v_prepared_count > 0 or v_attachment_activated_count > 0
      then 'prepared' else 'unchanged' end,
    'idempotent', v_prepared_count = 0 and v_attachment_activated_count = 0,
    'schemaVersion', 'truth-shadow-gmail-model-commissioning-batch-receipt-v1',
    'workspaceKey', p_workspace_key,
    'connectionKey', p_connection_key,
    'rootBatchId', p_root_batch_id,
    'commissioningScopeId', v_scope_id,
    'executionMode', 'sync',
    'preparedCount', v_prepared_count,
    'replayCount', v_replay_count,
    'attachmentActivatedCount', v_attachment_activated_count,
    'attachmentRunnableCount', v_attachment_runnable_count,
    'preparedReplays', v_receipts,
    'allReplays', v_all_receipts,
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.prepare_truth_shadow_gmail_model_commissioning(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_limit integer,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set lock_timeout = '30s'
set statement_timeout = '120s'
as $function$
  select private.prepare_truth_shadow_gmail_model_commissioning(
    p_workspace_key, p_connection_key, p_root_batch_id, p_limit,
    p_review_token, p_sync_token
  );
$function$;

revoke all on function private.prepare_truth_shadow_gmail_model_commissioning(
  text,text,uuid,integer,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.prepare_truth_shadow_gmail_model_commissioning(
  text,text,uuid,integer,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_truth_shadow_gmail_model_commissioning(
  text,text,uuid,integer,text,text
) to service_role;

-- The workspace-wide review reader is intentionally too broad for a one-root
-- commissioning file.  This reader reproduces its candidate item contract but
-- proves every returned target through an immutable candidate manifest and
-- processing-job lineage for exactly the requested shadow connection/root.
create or replace function private.read_truth_shadow_model_commissioning_reviews(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_limit integer,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '60s'
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_total_count integer;
  v_items jsonb;
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid shadow model commissioning review authority'
      using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or p_connection_key not like 'shadow-%'
    or p_root_batch_id is null
    or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'shadow model commissioning review request is invalid'
      using errcode = '22023';
  end if;
  select * into v_batch
  from public.source_ingest_batches batch
  where batch.workspace_key = p_workspace_key
    and batch.source_system = 'gmail'
    and batch.connection_key = p_connection_key
    and batch.batch_id = p_root_batch_id;
  if not found
    or v_batch.status <> 'committed'
    or v_batch.mode not in ('backfill', 'reconciliation')
    or exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = p_workspace_key
        and required_source.source_system = 'gmail'
        and required_source.connection_key = p_connection_key
    ) then
    raise exception 'review export is restricted to one unregistered shadow Gmail root'
      using errcode = '42501';
  end if;

  with candidate_queue as (
    select
      candidate.candidate_claim_version_id as target_id,
      candidate.created_at,
      jsonb_build_object(
        'targetKind', 'candidate_claim',
        'targetId', candidate.candidate_claim_version_id,
        'targetItemHash', candidate.envelope_hash,
        'nextDecisionNo', coalesce(latest.decision_no, 0) + 1,
        'previousDecisionVersionId', coalesce(latest.decision_version_id, ''),
        'currentDisposition', coalesce(latest.decision, 'pending'),
        'sourceObservationId', candidate.source_observation_id,
        'sourceSystem', observation.source_system,
        'sourceObjectType', candidate.source_object_type,
        'sourceObjectId', candidate.source_object_id,
        'sourceRecordedAt', case
          when observation.source_recorded_at is null then null
          else private.canonical_truth_timestamp(observation.source_recorded_at)
        end,
        'recommendation', candidate.recommendation,
        'candidate', candidate.canonical_envelope->'candidate',
        'target', candidate.canonical_envelope,
        'targetObject', candidate.canonical_envelope
      ) as item
    from public.candidate_claim_envelopes candidate
    join public.source_observations observation
      on observation.workspace_key = candidate.workspace_key
     and observation.observation_id = candidate.source_observation_id
    left join lateral (
      select decision_row.*
      from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id = candidate.candidate_claim_version_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    where candidate.workspace_key = p_workspace_key
      and observation.source_system = 'gmail'
      and observation.connection_key = p_connection_key
      and not private.truth_shadow_is_reconciled_stale_candidate_v1(
        candidate.workspace_key, candidate.candidate_claim_version_id
      )
      and exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.source_processing_jobs source_job
          on source_job.job_id = candidate_lineage.job_id
         and source_job.workspace_key = p_workspace_key
        join public.source_processing_job_lineage job_lineage
          on job_lineage.job_id = source_job.job_id
         and job_lineage.workspace_key = source_job.workspace_key
        join public.candidate_claim_job_manifests manifest
          on manifest.workspace_key = source_job.workspace_key
         and manifest.job_id = source_job.job_id
        where candidate_lineage.candidate_claim_version_id =
            candidate.candidate_claim_version_id
          and candidate_lineage.source_observation_id = candidate.source_observation_id
          and source_job.source_system = 'gmail'
          and source_job.connection_key = p_connection_key
          and source_job.job_kind = any(array[
            'gmail_extract_message_claims',
            'gmail_extract_attachment_claims',
            'gmail_extract_message_model_claims'
          ])
          and job_lineage.root_batch_id = p_root_batch_id
          and job_lineage.source_cursor_version = v_batch.committed_cursor_version
          and job_lineage.source_cursor_value = v_batch.committed_cursor_value
          and manifest.source_observation_id = candidate.source_observation_id
          and manifest.manifest_hash = encode(extensions.digest(convert_to(
            manifest.canonical_manifest::text, 'UTF8'
          ), 'sha256'), 'hex')
          and exists (
            select 1
            from jsonb_array_elements(manifest.canonical_manifest->'candidates') item
            where item->>'candidateClaimVersionId' =
                candidate.candidate_claim_version_id
              and item->>'itemHash' = candidate.envelope_hash
          )
      )
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
      )
  )
  select count(*)::integer into v_total_count from candidate_queue;

  with candidate_queue as (
    select
      candidate.candidate_claim_version_id as target_id,
      candidate.created_at,
      jsonb_build_object(
        'targetKind', 'candidate_claim',
        'targetId', candidate.candidate_claim_version_id,
        'targetItemHash', candidate.envelope_hash,
        'nextDecisionNo', coalesce(latest.decision_no, 0) + 1,
        'previousDecisionVersionId', coalesce(latest.decision_version_id, ''),
        'currentDisposition', coalesce(latest.decision, 'pending'),
        'sourceObservationId', candidate.source_observation_id,
        'sourceSystem', observation.source_system,
        'sourceObjectType', candidate.source_object_type,
        'sourceObjectId', candidate.source_object_id,
        'sourceRecordedAt', case
          when observation.source_recorded_at is null then null
          else private.canonical_truth_timestamp(observation.source_recorded_at)
        end,
        'recommendation', candidate.recommendation,
        'candidate', candidate.canonical_envelope->'candidate',
        'target', candidate.canonical_envelope,
        'targetObject', candidate.canonical_envelope
      ) as item
    from public.candidate_claim_envelopes candidate
    join public.source_observations observation
      on observation.workspace_key = candidate.workspace_key
     and observation.observation_id = candidate.source_observation_id
    left join lateral (
      select decision_row.*
      from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id = candidate.candidate_claim_version_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    where candidate.workspace_key = p_workspace_key
      and observation.source_system = 'gmail'
      and observation.connection_key = p_connection_key
      and not private.truth_shadow_is_reconciled_stale_candidate_v1(
        candidate.workspace_key, candidate.candidate_claim_version_id
      )
      and exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.source_processing_jobs source_job
          on source_job.job_id = candidate_lineage.job_id
         and source_job.workspace_key = p_workspace_key
        join public.source_processing_job_lineage job_lineage
          on job_lineage.job_id = source_job.job_id
         and job_lineage.workspace_key = source_job.workspace_key
        join public.candidate_claim_job_manifests manifest
          on manifest.workspace_key = source_job.workspace_key
         and manifest.job_id = source_job.job_id
        where candidate_lineage.candidate_claim_version_id =
            candidate.candidate_claim_version_id
          and candidate_lineage.source_observation_id = candidate.source_observation_id
          and source_job.source_system = 'gmail'
          and source_job.connection_key = p_connection_key
          and source_job.job_kind = any(array[
            'gmail_extract_message_claims',
            'gmail_extract_attachment_claims',
            'gmail_extract_message_model_claims'
          ])
          and job_lineage.root_batch_id = p_root_batch_id
          and job_lineage.source_cursor_version = v_batch.committed_cursor_version
          and job_lineage.source_cursor_value = v_batch.committed_cursor_value
          and manifest.source_observation_id = candidate.source_observation_id
          and manifest.manifest_hash = encode(extensions.digest(convert_to(
            manifest.canonical_manifest::text, 'UTF8'
          ), 'sha256'), 'hex')
          and exists (
            select 1
            from jsonb_array_elements(manifest.canonical_manifest->'candidates') item
            where item->>'candidateClaimVersionId' =
                candidate.candidate_claim_version_id
              and item->>'itemHash' = candidate.envelope_hash
          )
      )
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
      )
  ), bounded as (
    select item
    from candidate_queue
    order by created_at, target_id
    limit p_limit
  )
  select coalesce(jsonb_agg(item), '[]'::jsonb)
  into v_items
  from bounded;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'truth-shadow-model-commissioning-review-queue-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', p_connection_key,
    'rootBatchId', p_root_batch_id,
    'targetKind', 'candidate_claim',
    'limit', p_limit,
    'totalCount', v_total_count,
    'candidateCount', v_total_count,
    'linkCount', 0,
    'items', v_items,
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_truth_shadow_model_commissioning_reviews(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_limit integer,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '60s'
as $function$
  select private.read_truth_shadow_model_commissioning_reviews(
    p_workspace_key, p_connection_key, p_root_batch_id, p_limit,
    p_review_token, p_sync_token
  );
$function$;

revoke all on function private.read_truth_shadow_model_commissioning_reviews(
  text,text,uuid,integer,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.read_truth_shadow_model_commissioning_reviews(
  text,text,uuid,integer,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.read_truth_shadow_model_commissioning_reviews(
  text,text,uuid,integer,text,text
) to service_role;

-- Reassert ACLs on functions replaced through pg_get_functiondef.
revoke all on function private.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public, anon, authenticated, service_role;
revoke all on function private.claim_source_processing_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public, anon, authenticated, service_role;
revoke all on function private.unresolved_gmail_model_extraction_reviews(text)
  from public, anon, authenticated, service_role;
revoke all on function private.run_truth_shadow_claim_acceptance_epoch(text,text,text)
  from public, anon, authenticated, service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
  v_table text;
begin
  foreach v_table in array array[
    'truth_shadow_gmail_model_commissioning_scopes',
    'truth_shadow_gmail_model_commissioning_replays'
  ] loop
    if not exists (
      select 1
      from pg_class table_row
      where table_row.oid = ('public.' || v_table)::regclass
        and table_row.relrowsecurity
        and table_row.relforcerowsecurity
    ) or not exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = ('public.' || v_table)::regclass
        and trigger_row.tgname = v_table || '_immutable'
        and not trigger_row.tgisinternal
    ) then
      raise exception '% is not force-RLS immutable', v_table
        using errcode = '23514';
    end if;
  end loop;

  if has_function_privilege('anon',
      'public.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)',
      'execute')
    or not has_function_privilege('service_role',
      'public.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)',
      'execute')
    or has_function_privilege('service_role',
      'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)',
      'execute') then
    raise exception 'shadow Gmail model commissioning RPC ACLs are unsafe'
      using errcode = '42501';
  end if;
  if has_function_privilege('anon',
      'public.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)',
      'execute')
    or not has_function_privilege('service_role',
      'public.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)',
      'execute')
    or has_function_privilege('service_role',
      'private.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)',
      'execute') then
    raise exception 'scoped commissioning review RPC ACLs are unsafe'
      using errcode = '42501';
  end if;

  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('truth_shadow_gmail_model_commissioning_parent_allowed_v1' in v_definition) = 0
    or position('then ''sync''' in v_definition) = 0
    or position('v_batch.mode in (''backfill'',''reconciliation'') then ''batch''' in v_definition) = 0 then
    raise exception 'Gmail sealer lacks the exact replay-only sync override'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  ) into v_definition;
  if position('truth_shadow_gmail_model_commissioning_job_allowed_v1' in v_definition) = 0
    or position('for update of job skip locked' in lower(v_definition)) = 0
    or position('gmail_review_model_extraction' in v_definition) = 0 then
    raise exception 'claim authority lacks the replay-only model admission gate'
      using errcode = '23514';
  end if;

  if to_regprocedure(
      'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'
    ) is null then
    raise exception 'shared shadow model commissioning job authority is unavailable'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'::regprocedure
  ) into v_definition;
  if position('truth_shadow_gmail_model_commissioning_job_allowed_v1' in v_definition) = 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0
    or position('truth_shadow_gmail_model_commissioning_scopes' in v_definition) = 0
    or position('scope.shadow_only = true' in v_definition) = 0
    or position('scope.production_eligible = false' in v_definition) = 0
    or position('scope.production_publication_attempted = false' in v_definition) = 0 then
    raise exception 'shared shadow model commissioning job authority is incomplete'
      using errcode = '23514';
  end if;
  select proconfig into v_config
  from pg_proc
  where oid = 'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure;
  if not ('plan_cache_mode=force_custom_plan' = any(coalesce(v_config, array[]::text[]))) then
    raise exception 'claim authority lost coordinate-specific planning during rewrite'
      using errcode = '23514';
  end if;

  select pg_get_functiondef('private.route_gmail_link_claim_wait_v2()'::regprocedure)
    into v_definition;
  if position('truth_shadow_gmail_model_commissioning_child_input_allowed_v1' in v_definition) = 0
    or position('GMAIL_MODEL_RUNTIME_DISABLED' in v_definition) = 0 then
    raise exception 'Gmail route lacks the replay-only model admission gate'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.source_processing_jobs'::regclass
      and trigger_row.tgname = 'source_processing_job_gmail_link_claim_wait'
      and trigger_row.tgfoid = 'private.route_gmail_link_claim_wait_v2()'::regprocedure
      and not trigger_row.tgisinternal
  ) then
    raise exception 'Gmail link/model route trigger does not use v2 authority'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.unresolved_gmail_model_extraction_reviews(text)'::regprocedure
  ) into v_definition;
  if position('truth_shadow_gmail_model_commissioning_replay_valid_v1' in v_definition) = 0 then
    raise exception 'old runtime-disabled blocker lacks an integrity-bound replay exclusion'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('MODEL_COMMISSIONING_FRONTIER_OPEN' in v_definition) = 0
    or position('unresolved_gmail_model_extraction_jobs' in v_definition) = 0
    or position('successor.state <> ''succeeded''' in v_definition) = 0 then
    raise exception 'shadow acceptance epoch lacks the commissioned model frontier gate'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'::regprocedure
  ) into v_definition;
  if position('valid_truth_review_token' in v_definition) = 0
    or position('valid_truth_sync_token' in v_definition) = 0
    or position('truth_required_sources' in v_definition) = 0
    or position('truth_shadow_root_source_cuts' in v_definition) = 0
    or position('truth_builds' in v_definition) = 0
    or position('truth_publications' in v_definition) = 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0
    or position('unresolved_gmail_attachment_extractions' in v_definition) = 0
    or position('attachmentActivatedCount' in v_definition) = 0
    or position(
      'insert into public.gmail_model_extraction_review_resolutions'
      in lower(v_definition)
    ) > 0
    or position('productionPublicationAttempted'', false' in v_definition) = 0 then
    raise exception 'commissioning coordinator lost an authority or shadow-only guard'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.read_truth_shadow_model_commissioning_reviews(text,text,uuid,integer,text,text)'::regprocedure
  ) into v_definition;
  if position('valid_truth_review_token' in v_definition) = 0
    or position('valid_truth_sync_token' in v_definition) = 0
    or position('job_lineage.root_batch_id = p_root_batch_id' in v_definition) = 0
    or position('source_job.connection_key = p_connection_key' in v_definition) = 0
    or position('previousDecisionVersionId' in v_definition) = 0
    or position('''target'', candidate.canonical_envelope' in v_definition) = 0
    or position('''targetObject'', candidate.canonical_envelope' in v_definition) = 0
    or position('latest.decision = ''accept'' and binding.binding_id is null' in v_definition) > 0
    or position('productionPublicationAttempted'', false' in v_definition) = 0 then
    raise exception 'scoped commissioning review reader lost an exact-root or shadow-only guard'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    where not private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
      replay.workspace_key, replay.obligation_id
    )
  ) then
    raise exception 'stored shadow Gmail model replay failed migration verification'
      using errcode = '23514';
  end if;
end;
$verify$;
