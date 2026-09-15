-- A July-10 deterministic/model-off seal could record a complete null-model
-- plan even when immutable source residuals still required review.  Those
-- seals are audit evidence and must not be reset.  This authority validates
-- the exact envelope-only drift, atomically seals the current failure plan on
-- one sibling successor, supersedes the stale leased job, and quarantines only
-- the stale plan's otherwise-unreviewable candidate artifacts.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epoch_items') is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
    ) is null
    or to_regprocedure(
      'private.read_truth_review_queue(text,text,integer,text)'
    ) is null
    or to_regprocedure(
      'private.truth_review_gaps_for_source_cut(text,jsonb)'
    ) is null then
    raise exception 'stale Gmail plan reconciliation prerequisites are unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('v_has_model_plan boolean:=false;' in v_definition) = 0
    or position('gmail-model-runtime-disabled-review-v1' in v_definition) = 0
    or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0 then
    raise exception 'Gmail plan sealer differs from the commissioned shadow contract'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- Restore full residual/model presence equivalence for all future complete
-- seals.  Review-required MODEL_RUNTIME_DISABLED plans remain valid.
do $sealer_presence_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$    if v_planning_status='complete' and v_has_model_plan
      and jsonb_array_length(v_expected_residual->'unresolvedSignals')=0 then$old$;
  v_new text := $new$    if v_planning_status='complete' and
      v_has_model_plan is distinct from
        (jsonb_array_length(v_expected_residual->'unresolvedSignals')>0) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0
      or position('gmail-model-runtime-disabled-review-v1' in v_definition) = 0 then
      raise exception 'Gmail plan presence rewrite did not match the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition or position(v_new in v_updated) = 0
      or position(v_old in v_updated) > 0 then
      raise exception 'Gmail plan presence rewrite is incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_old in v_definition) > 0 then
    raise exception 'Gmail plan presence rewrite is only partially installed'
      using errcode = '23514';
  end if;
end;
$sealer_presence_rewrite$;

create table if not exists public.gmail_stale_extraction_plan_reconciliations (
  reconciliation_id text primary key check (
    reconciliation_id ~ '^gmail-plan-reconciliation:v1:[0-9a-f]{64}$'
  ),
  reconciliation_hash text not null unique check (reconciliation_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  stale_parent_job_id uuid not null unique,
  successor_job_id uuid not null unique,
  original_parent_job_id uuid not null,
  root_job_id uuid not null,
  source_observation_id text not null,
  source_observation_content_hash text not null check (
    source_observation_content_hash ~ '^[0-9a-f]{64}$'
  ),
  stale_extraction_plan_id text not null unique check (
    stale_extraction_plan_id ~ '^gmail-extraction-plan:v1:[0-9a-f]{64}$'
  ),
  stale_extraction_plan_hash text not null check (stale_extraction_plan_hash ~ '^[0-9a-f]{64}$'),
  stale_plan_seal_hash text not null check (stale_plan_seal_hash ~ '^[0-9a-f]{64}$'),
  stale_context_seal_id text not null check (
    stale_context_seal_id ~ '^gmail-model-context:v1:[0-9a-f]{64}$'
  ),
  stale_context_seal_hash text not null check (stale_context_seal_hash ~ '^[0-9a-f]{64}$'),
  stale_candidate_manifest_hash text not null check (
    stale_candidate_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  stale_candidate_count integer not null check (stale_candidate_count between 0 and 50),
  expected_extraction_plan_id text not null unique check (
    expected_extraction_plan_id ~ '^gmail-extraction-plan:v1:[0-9a-f]{64}$'
  ),
  expected_extraction_plan_hash text not null check (
    expected_extraction_plan_hash ~ '^[0-9a-f]{64}$'
  ),
  expected_planning_failure_code text not null check (
    expected_planning_failure_code = 'MODEL_RUNTIME_DISABLED'
  ),
  expected_planning_failure_detail_hash text not null check (
    expected_planning_failure_detail_hash ~ '^[0-9a-f]{64}$'
  ),
  expected_deterministic_candidate_count integer not null check (
    expected_deterministic_candidate_count between 0 and 50
  ),
  expected_deterministic_candidate_set_hash text not null check (
    expected_deterministic_candidate_set_hash ~ '^[0-9a-f]{64}$'
  ),
  successor_dedupe_key text not null unique,
  successor_payload jsonb not null check (jsonb_typeof(successor_payload) = 'object'),
  successor_payload_hash text not null check (successor_payload_hash ~ '^[0-9a-f]{64}$'),
  canonical_current_plan jsonb not null check (jsonb_typeof(canonical_current_plan) = 'object'),
  canonical_reconciliation jsonb not null check (jsonb_typeof(canonical_reconciliation) = 'object'),
  canonical_supersession jsonb not null check (jsonb_typeof(canonical_supersession) = 'object'),
  supersession_hash text not null unique check (supersession_hash ~ '^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'gmail-stale-extraction-plan-reconciliation-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, reconciliation_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, stale_parent_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, successor_job_id)
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
  foreign key (workspace_key, stale_extraction_plan_id)
    references public.gmail_model_extraction_plans(workspace_key, extraction_plan_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, expected_extraction_plan_id)
    references public.gmail_model_extraction_plans(workspace_key, extraction_plan_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, stale_context_seal_id)
    references public.gmail_model_extraction_context_seals(workspace_key, context_seal_id)
    on update restrict on delete restrict,
  check (reconciliation_id = 'gmail-plan-reconciliation:v1:' || reconciliation_hash),
  check (reconciliation_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_reconciliation), 'UTF8'
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
  check (canonical_current_plan->>'extractionPlanId' = expected_extraction_plan_id),
  check (canonical_current_plan->>'extractionPlanHash' = expected_extraction_plan_hash),
  check (canonical_current_plan->>'schemaVersion' = 'gmail-claim-extraction-plan-failure-v2'),
  check (canonical_current_plan #>> '{planningFailure,code}' = expected_planning_failure_code),
  check (canonical_current_plan #>> '{planningFailure,detailHash}' = expected_planning_failure_detail_hash),
  check (jsonb_typeof(canonical_current_plan->'modelPlan') = 'null'),
  check (jsonb_array_length(canonical_current_plan->'deterministicCandidates')
    = expected_deterministic_candidate_count),
  check (expected_extraction_plan_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(
      canonical_current_plan - 'extractionPlanId' - 'extractionPlanHash'
    ), 'UTF8'
  ), 'sha256'), 'hex')),
  check (expected_deterministic_candidate_set_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_current_plan->'deterministicCandidates'), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_reconciliation->>'schemaVersion' =
    'gmail-stale-extraction-plan-reconciliation-v1'),
  check (canonical_reconciliation->>'workspaceKey' = workspace_key),
  check (canonical_reconciliation->>'connectionKey' = connection_key),
  check (canonical_reconciliation->>'rootBatchId' = root_batch_id::text),
  check (canonical_reconciliation->>'staleParentJobId' = stale_parent_job_id::text),
  check (canonical_reconciliation->>'originalParentJobId' = original_parent_job_id::text),
  check (canonical_reconciliation->>'rootJobId' = root_job_id::text),
  check (canonical_reconciliation->>'sourceObservationId' = source_observation_id),
  check (canonical_reconciliation->>'sourceObservationContentHash' =
    source_observation_content_hash),
  check (canonical_reconciliation->>'staleExtractionPlanId' = stale_extraction_plan_id),
  check (canonical_reconciliation->>'staleExtractionPlanHash' = stale_extraction_plan_hash),
  check (canonical_reconciliation->>'expectedExtractionPlanId' = expected_extraction_plan_id),
  check (canonical_reconciliation->>'expectedExtractionPlanHash' = expected_extraction_plan_hash),
  check ((canonical_reconciliation->>'expectedDeterministicCandidateCount')::integer =
    expected_deterministic_candidate_count),
  check (canonical_reconciliation->>'expectedDeterministicCandidateSetHash' =
    expected_deterministic_candidate_set_hash),
  check (canonical_reconciliation->>'shadowOnly' = 'true'),
  check (canonical_reconciliation->>'productionPublicationAttempted' = 'false'),
  check (canonical_supersession->>'schemaVersion' =
    'gmail-stale-extraction-plan-supersession-v1'),
  check (canonical_supersession->>'reconciliationId' = reconciliation_id),
  check (canonical_supersession->>'staleParentJobId' = stale_parent_job_id::text),
  check (canonical_supersession->>'successorJobId' = successor_job_id::text),
  check (canonical_supersession->>'staleExtractionPlanId' = stale_extraction_plan_id),
  check (canonical_supersession->>'expectedExtractionPlanId' = expected_extraction_plan_id),
  check (canonical_supersession->>'status' = 'superseded_by_current_review_plan'),
  check (canonical_supersession->>'shadowOnly' = 'true'),
  check (canonical_supersession->>'productionPublicationAttempted' = 'false'),
  check (private.truth_jsonb_has_only_keys(canonical_receipt, array[
    'ok','idempotent','status','schemaVersion','workspaceKey','staleParentJobId',
    'successorJobId','reconciliationId','reconciliationHash','staleExtractionPlanId',
    'staleExtractionPlanHash','expectedExtractionPlanId','expectedExtractionPlanHash',
    'deterministicCandidateCount','plannedDeterministicCandidateSetHash','shadowOnly',
    'mutatesOperationalState','productionPublicationAttempted'
  ])),
  check (canonical_receipt->>'ok' = 'true' and canonical_receipt->>'idempotent' = 'false'),
  check (canonical_receipt->>'status' = 'requeued_current_plan'),
  check (canonical_receipt->>'schemaVersion' =
    'gmail-stale-extraction-plan-reconciliation-receipt-v1'),
  check (canonical_receipt->>'workspaceKey' = workspace_key),
  check (canonical_receipt->>'staleParentJobId' = stale_parent_job_id::text),
  check (canonical_receipt->>'successorJobId' = successor_job_id::text),
  check (canonical_receipt->>'reconciliationId' = reconciliation_id),
  check (canonical_receipt->>'reconciliationHash' = reconciliation_hash),
  check (canonical_receipt->>'staleExtractionPlanId' = stale_extraction_plan_id),
  check (canonical_receipt->>'staleExtractionPlanHash' = stale_extraction_plan_hash),
  check (canonical_receipt->>'expectedExtractionPlanId' = expected_extraction_plan_id),
  check (canonical_receipt->>'expectedExtractionPlanHash' = expected_extraction_plan_hash),
  check ((canonical_receipt->>'deterministicCandidateCount')::integer =
    expected_deterministic_candidate_count),
  check (canonical_receipt->>'plannedDeterministicCandidateSetHash' =
    expected_deterministic_candidate_set_hash),
  check (canonical_receipt->>'shadowOnly' = 'true'),
  check (canonical_receipt->>'mutatesOperationalState' = 'false'),
  check (canonical_receipt->>'productionPublicationAttempted' = 'false')
);

create index if not exists gmail_stale_plan_reconciliation_scope_idx
  on public.gmail_stale_extraction_plan_reconciliations(
    workspace_key, connection_key, root_batch_id, stale_parent_job_id
  );

drop trigger if exists gmail_stale_extraction_plan_reconciliations_immutable
  on public.gmail_stale_extraction_plan_reconciliations;
create trigger gmail_stale_extraction_plan_reconciliations_immutable
before update or delete on public.gmail_stale_extraction_plan_reconciliations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.gmail_stale_extraction_plan_reconciliations enable row level security;
alter table public.gmail_stale_extraction_plan_reconciliations force row level security;
revoke all on table public.gmail_stale_extraction_plan_reconciliations
  from public, anon, authenticated, service_role;
grant select on table public.gmail_stale_extraction_plan_reconciliations to service_role;

create or replace function private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
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
    from public.gmail_stale_extraction_plan_reconciliations reconciliation
    join public.source_processing_jobs stale_job
      on stale_job.workspace_key = reconciliation.workspace_key
     and stale_job.job_id = reconciliation.stale_parent_job_id
    join public.source_processing_jobs successor_job
      on successor_job.workspace_key = reconciliation.workspace_key
     and successor_job.job_id = reconciliation.successor_job_id
    join public.source_processing_job_lineage stale_lineage
      on stale_lineage.workspace_key = reconciliation.workspace_key
     and stale_lineage.job_id = reconciliation.stale_parent_job_id
    join public.source_processing_job_lineage successor_lineage
      on successor_lineage.workspace_key = reconciliation.workspace_key
     and successor_lineage.job_id = reconciliation.successor_job_id
    join public.source_processing_job_children original_child
      on original_child.parent_job_id = reconciliation.original_parent_job_id
     and original_child.child_job_id = reconciliation.stale_parent_job_id
    join public.gmail_model_extraction_plans stale_plan
      on stale_plan.workspace_key = reconciliation.workspace_key
     and stale_plan.extraction_plan_id = reconciliation.stale_extraction_plan_id
     and stale_plan.parent_job_id = reconciliation.stale_parent_job_id
    join public.gmail_model_extraction_plans successor_plan
      on successor_plan.workspace_key = reconciliation.workspace_key
     and successor_plan.extraction_plan_id = reconciliation.expected_extraction_plan_id
     and successor_plan.parent_job_id = reconciliation.successor_job_id
    join public.gmail_model_extraction_context_seals stale_context
      on stale_context.workspace_key = reconciliation.workspace_key
     and stale_context.context_seal_id = reconciliation.stale_context_seal_id
     and stale_context.parent_job_id = reconciliation.stale_parent_job_id
    join public.candidate_claim_job_manifests stale_manifest
      on stale_manifest.workspace_key = reconciliation.workspace_key
     and stale_manifest.job_id = reconciliation.stale_parent_job_id
    join public.candidate_claim_job_manifests successor_manifest
      on successor_manifest.workspace_key = reconciliation.workspace_key
     and successor_manifest.job_id = reconciliation.successor_job_id
    where reconciliation.workspace_key = p_workspace_key
      and reconciliation.stale_parent_job_id = p_job_id
      and reconciliation.shadow_only = true
      and reconciliation.production_eligible = false
      and reconciliation.production_publication_attempted = false
      and reconciliation.connection_key like 'shadow-%'
      and reconciliation.reconciliation_id =
        'gmail-plan-reconciliation:v1:' || reconciliation.reconciliation_hash
      and reconciliation.reconciliation_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(reconciliation.canonical_reconciliation), 'UTF8'
      ), 'sha256'), 'hex')
      and reconciliation.successor_payload_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(reconciliation.successor_payload), 'UTF8'
      ), 'sha256'), 'hex')
      and reconciliation.supersession_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(reconciliation.canonical_supersession), 'UTF8'
      ), 'sha256'), 'hex')
      and reconciliation.receipt_hash = encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(reconciliation.canonical_receipt), 'UTF8'
      ), 'sha256'), 'hex')
      and stale_job.state = 'superseded'
      and stale_job.lease_owner is null
      and stale_job.lease_expires_at is null
      and stale_job.last_error_code = 'GMAIL_STALE_EXTRACTION_PLAN_RECONCILED'
      and stale_job.result = reconciliation.canonical_supersession
      and stale_job.completed_at is not null
      and stale_job.workspace_key = successor_job.workspace_key
      and stale_job.source_system = successor_job.source_system
      and stale_job.connection_key = successor_job.connection_key
      and stale_job.job_kind = successor_job.job_kind
      and stale_job.observation_id = successor_job.observation_id
      and stale_job.source_object_id = successor_job.source_object_id
      and successor_job.dedupe_key = reconciliation.successor_dedupe_key
      and successor_job.payload = reconciliation.successor_payload
      and successor_job.state not in ('dead_letter', 'superseded')
      and stale_lineage.root_batch_id = reconciliation.root_batch_id
      and stale_lineage.parent_job_id = reconciliation.original_parent_job_id
      and stale_lineage.root_job_id = reconciliation.root_job_id
      and stale_lineage.source_cursor_version = reconciliation.source_cursor_version
      and stale_lineage.source_cursor_value = reconciliation.source_cursor_value
      and successor_lineage.root_batch_id = stale_lineage.root_batch_id
      and successor_lineage.parent_job_id is not distinct from stale_lineage.parent_job_id
      and successor_lineage.root_job_id = stale_lineage.root_job_id
      and successor_lineage.source_cursor_version = stale_lineage.source_cursor_version
      and successor_lineage.source_cursor_value = stale_lineage.source_cursor_value
      and stale_plan.extraction_plan_hash = reconciliation.stale_extraction_plan_hash
      and stale_plan.plan_seal_hash = reconciliation.stale_plan_seal_hash
      and stale_plan.context_seal_id = reconciliation.stale_context_seal_id
      and stale_plan.deterministic_manifest_hash = reconciliation.stale_candidate_manifest_hash
      and stale_plan.deterministic_candidate_count = reconciliation.stale_candidate_count
      and stale_plan.planned_deterministic_candidate_count =
        reconciliation.expected_deterministic_candidate_count
      and stale_plan.planned_deterministic_candidate_set_hash =
        reconciliation.expected_deterministic_candidate_set_hash
      and stale_plan.planning_status = 'complete'
      and stale_plan.model_plan_id is null
      and stale_plan.model_plan_hash is null
      and stale_plan.model_plan is null
      and stale_plan.execution_mode = 'none'
      and stale_plan.planning_failure_code = ''
      and stale_plan.planning_failure_detail_hash = ''
      and stale_plan.plan_seal_hash = encode(extensions.digest(convert_to(
        stale_plan.canonical_plan_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and stale_context.seal_hash = reconciliation.stale_context_seal_hash
      and stale_context.seal_hash = encode(extensions.digest(convert_to(
        stale_context.canonical_seal::text, 'UTF8'
      ), 'sha256'), 'hex')
      and stale_manifest.manifest_hash = reconciliation.stale_candidate_manifest_hash
      and stale_manifest.candidate_count = reconciliation.stale_candidate_count
      and stale_manifest.manifest_hash = encode(extensions.digest(convert_to(
        stale_manifest.canonical_manifest::text, 'UTF8'
      ), 'sha256'), 'hex')
      and successor_plan.extraction_plan_hash = reconciliation.expected_extraction_plan_hash
      and successor_plan.planning_status = 'review_required'
      and successor_plan.planning_failure_code = 'MODEL_RUNTIME_DISABLED'
      and successor_plan.planning_failure_detail_hash =
        reconciliation.expected_planning_failure_detail_hash
      and successor_plan.planned_deterministic_candidate_count =
        reconciliation.expected_deterministic_candidate_count
      and successor_plan.planned_deterministic_candidate_set_hash =
        reconciliation.expected_deterministic_candidate_set_hash
      and successor_plan.deterministic_candidate_count = 0
      and successor_manifest.candidate_count = 0
      and successor_manifest.manifest_hash = successor_plan.deterministic_manifest_hash
      and not exists (
        select 1 from public.source_processing_job_children child
        where child.child_job_id = reconciliation.successor_job_id
           or child.parent_job_id = reconciliation.stale_parent_job_id
      )
      and not exists (
        select 1 from public.source_processing_job_lineage child_lineage
        where child_lineage.parent_job_id = reconciliation.stale_parent_job_id
      )
      and not exists (
        select 1 from public.truth_pending_acceptance_epoch_manifests membership
        where membership.workspace_key = reconciliation.workspace_key
          and membership.source_job_id = reconciliation.stale_parent_job_id
      )
      and not exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.candidate_claim_decisions decision_row
          on decision_row.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
        where candidate_lineage.job_id = reconciliation.stale_parent_job_id
      )
      and not exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.candidate_claim_acceptance_bindings binding
          on binding.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
        where candidate_lineage.job_id = reconciliation.stale_parent_job_id
      )
      and not exists (
        select 1 from public.truth_shadow_claim_acceptance_epoch_items item
        where item.workspace_key = reconciliation.workspace_key
          and (item.source_job_id = reconciliation.stale_parent_job_id
            or item.candidate_claim_version_id in (
              select candidate_lineage.candidate_claim_version_id
              from public.candidate_claim_job_lineage candidate_lineage
              where candidate_lineage.job_id = reconciliation.stale_parent_job_id
            ))
      )
  );
$function$;

create or replace function private.truth_shadow_is_reconciled_stale_candidate_v1(
  p_workspace_key text,
  p_candidate_claim_version_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.candidate_claim_job_lineage lineage
    where lineage.candidate_claim_version_id = p_candidate_claim_version_id
      and private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
        p_workspace_key, lineage.job_id
      )
  ) and not exists (
    select 1
    from public.candidate_claim_job_lineage lineage
    join public.source_processing_jobs job on job.job_id = lineage.job_id
    where lineage.candidate_claim_version_id = p_candidate_claim_version_id
      and job.workspace_key = p_workspace_key
      and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
        p_workspace_key, lineage.job_id
      )
  );
$function$;

revoke all on function private.truth_shadow_is_reconciled_stale_gmail_claim_v1(text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_shadow_is_reconciled_stale_candidate_v1(text,text)
  from public, anon, authenticated, service_role;

create or replace function private.guard_reconciled_stale_candidate_decision_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_workspace_key text;
begin
  select candidate.workspace_key into strict v_workspace_key
  from public.candidate_claim_envelopes candidate
  where candidate.candidate_claim_version_id = new.candidate_claim_version_id;
  if private.truth_shadow_is_reconciled_stale_candidate_v1(
    v_workspace_key, new.candidate_claim_version_id
  ) then
    raise exception 'reconciled stale Gmail candidate is quarantined from review decisions'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_reconciled_stale_candidate_decision_v1()
  from public, anon, authenticated, service_role;
drop trigger if exists candidate_claim_decisions_stale_gmail_quarantine
  on public.candidate_claim_decisions;
create trigger candidate_claim_decisions_stale_gmail_quarantine
before insert on public.candidate_claim_decisions
for each row execute function private.guard_reconciled_stale_candidate_decision_v1();

create or replace function private.reconcile_stale_shadow_gmail_extraction_plan(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_extraction_plan jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_observation public.source_observations%rowtype;
  v_old_plan public.gmail_model_extraction_plans%rowtype;
  v_old_context public.gmail_model_extraction_context_seals%rowtype;
  v_old_manifest public.candidate_claim_job_manifests%rowtype;
  v_existing public.gmail_stale_extraction_plan_reconciliations%rowtype;
  v_successor_job_id uuid;
  v_successor_dedupe_key text;
  v_successor_payload jsonb;
  v_successor_payload_hash text;
  v_candidate_manifest jsonb;
  v_candidate_count integer;
  v_candidate_set_hash text;
  v_reconciliation jsonb;
  v_reconciliation_hash text;
  v_reconciliation_id text;
  v_supersession jsonb;
  v_supersession_hash text;
  v_plan_receipt jsonb;
  v_receipt jsonb;
  v_receipt_hash text;
  v_updated_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence < 1
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or jsonb_typeof(coalesce(p_extraction_plan, 'null'::jsonb)) <> 'object' then
    raise exception 'stale Gmail plan reconciliation request is invalid'
      using errcode = '22023';
  end if;
  if not private.truth_jsonb_has_only_keys(p_extraction_plan, array[
      'extractionPlanId','extractionPlanHash','schemaVersion','sourceObservationId',
      'sourceObservationContentHash','extractorVersion','deterministicCandidates',
      'deterministicCoverage','modelPlan','planningFailure'
    ])
    or p_extraction_plan->>'schemaVersion' <> 'gmail-claim-extraction-plan-failure-v2'
    or coalesce(p_extraction_plan->>'extractionPlanHash', '') !~ '^[0-9a-f]{64}$'
    or p_extraction_plan->>'extractionPlanId' <>
      'gmail-extraction-plan:v1:' || (p_extraction_plan->>'extractionPlanHash')
    or jsonb_typeof(p_extraction_plan->'deterministicCandidates') <> 'array'
    or jsonb_typeof(p_extraction_plan->'deterministicCoverage') <> 'array'
    or jsonb_array_length(p_extraction_plan->'deterministicCandidates') > 50
    or jsonb_array_length(p_extraction_plan->'deterministicCoverage') <>
      jsonb_array_length(p_extraction_plan->'deterministicCandidates')
    or jsonb_typeof(p_extraction_plan->'modelPlan') <> 'null'
    or jsonb_typeof(p_extraction_plan->'planningFailure') <> 'object'
    or p_extraction_plan #>> '{planningFailure,code}' <> 'MODEL_RUNTIME_DISABLED'
    or coalesce(p_extraction_plan #>> '{planningFailure,detailHash}', '') !~ '^[0-9a-f]{64}$'
    or p_extraction_plan->>'extractorVersion' <>
      'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
    or encode(extensions.digest(convert_to(private.truth_canonical_json_text(
      p_extraction_plan - 'extractionPlanId' - 'extractionPlanHash'
    ), 'UTF8'), 'sha256'), 'hex') is distinct from p_extraction_plan->>'extractionPlanHash' then
    raise exception 'current Gmail review plan is not the exact runtime-disabled envelope'
      using errcode = '23514';
  end if;

  v_candidate_count := jsonb_array_length(p_extraction_plan->'deterministicCandidates');
  v_candidate_set_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(p_extraction_plan->'deterministicCandidates'), 'UTF8'
  ), 'sha256'), 'hex');

  select * into v_existing
  from public.gmail_stale_extraction_plan_reconciliations reconciliation
  where reconciliation.workspace_key = p_workspace_key
    and reconciliation.stale_parent_job_id = p_job_id;
  if found then
    if v_existing.canonical_current_plan is distinct from p_extraction_plan
      or v_existing.expected_extraction_plan_id is distinct from p_extraction_plan->>'extractionPlanId'
      or v_existing.expected_extraction_plan_hash is distinct from p_extraction_plan->>'extractionPlanHash'
      or v_existing.expected_deterministic_candidate_count is distinct from v_candidate_count
      or v_existing.expected_deterministic_candidate_set_hash is distinct from v_candidate_set_hash
      or not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(p_workspace_key, p_job_id) then
      raise exception 'stale Gmail plan reconciliation replay conflicts or lost integrity'
        using errcode = '23505';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object('idempotent', true);
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  v_job := private.assert_candidate_claim_job_lease_pre_model(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if v_job.workspace_key is distinct from p_workspace_key
    or v_job.source_system <> 'gmail'
    or v_job.job_kind <> 'gmail_extract_message_claims'
    or v_job.connection_key not like 'shadow-%'
    or v_job.result <> '{}'::jsonb
    or v_job.completed_at is not null
    or exists (
      select 1 from public.truth_required_sources required_source
      where required_source.workspace_key = v_job.workspace_key
        and required_source.source_system = v_job.source_system
        and required_source.connection_key = v_job.connection_key
    ) then
    raise exception 'stale Gmail plan reconciliation is confined to unfinished shadow claims'
      using errcode = '23514';
  end if;
  select * into strict v_lineage
  from public.source_processing_job_lineage lineage
  where lineage.workspace_key = p_workspace_key and lineage.job_id = p_job_id;
  if v_lineage.parent_job_id is null
    or not exists (
      select 1 from public.source_processing_job_children child
      where child.parent_job_id = v_lineage.parent_job_id
        and child.child_job_id = p_job_id
    ) then
    raise exception 'stale Gmail claim lacks its immutable original parent membership'
      using errcode = '23514';
  end if;
  select * into strict v_observation
  from public.source_observations observation
  where observation.workspace_key = p_workspace_key
    and observation.observation_id = v_job.observation_id;
  if v_observation.source_object_type <> 'gmail_message_parsed'
    or v_observation.normalized_payload->>'schemaVersion' <> 'gmail-parsed-message-v2'
    or p_extraction_plan->>'sourceObservationId' is distinct from v_observation.observation_id
    or p_extraction_plan->>'sourceObservationContentHash' is distinct from v_observation.content_hash then
    raise exception 'stale Gmail plan reconciliation source evidence is crossed'
      using errcode = '23514';
  end if;
  select * into strict v_old_plan
  from public.gmail_model_extraction_plans plan
  where plan.workspace_key = p_workspace_key and plan.parent_job_id = p_job_id;
  select * into strict v_old_context
  from public.gmail_model_extraction_context_seals context_seal
  where context_seal.workspace_key = p_workspace_key
    and context_seal.context_seal_id = v_old_plan.context_seal_id;
  select * into strict v_old_manifest
  from public.candidate_claim_job_manifests manifest
  where manifest.workspace_key = p_workspace_key and manifest.job_id = p_job_id;

  if v_old_plan.planning_status <> 'complete'
    or v_old_plan.model_plan_id is not null
    or v_old_plan.model_plan_hash is not null
    or v_old_plan.model_plan is not null
    or v_old_plan.execution_mode <> 'none'
    or v_old_plan.planning_failure_code <> ''
    or v_old_plan.planning_failure_detail_hash <> ''
    or v_old_plan.extractor_version is distinct from p_extraction_plan->>'extractorVersion'
    or v_old_plan.extraction_plan_id = p_extraction_plan->>'extractionPlanId'
    or v_old_plan.extraction_plan_hash = p_extraction_plan->>'extractionPlanHash'
    or v_old_plan.deterministic_candidate_count <>
      v_old_plan.planned_deterministic_candidate_count
    or v_old_plan.planned_deterministic_candidate_count <> v_candidate_count
    or v_old_plan.planned_deterministic_candidate_set_hash <> v_candidate_set_hash
    or v_old_plan.deterministic_manifest_hash <> v_old_manifest.manifest_hash
    or v_old_plan.deterministic_candidate_count <> v_old_manifest.candidate_count
    or v_old_plan.context_seal_id <> v_old_context.context_seal_id
    or v_old_plan.plan_seal_hash <> encode(extensions.digest(convert_to(
      v_old_plan.canonical_plan_seal::text, 'UTF8'
    ), 'sha256'), 'hex')
    or v_old_context.seal_hash <> encode(extensions.digest(convert_to(
      v_old_context.canonical_seal::text, 'UTF8'
    ), 'sha256'), 'hex')
    or v_old_manifest.manifest_hash <> encode(extensions.digest(convert_to(
      v_old_manifest.canonical_manifest::text, 'UTF8'
    ), 'sha256'), 'hex') then
    raise exception 'sealed Gmail plan is not the exact pre-fix null-model shape'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateClaimVersionId', envelope.candidate_claim_version_id,
    'itemHash', envelope.envelope_hash
  ) order by envelope.candidate_claim_version_id), '[]'::jsonb)
  into v_candidate_manifest
  from jsonb_array_elements(p_extraction_plan->'deterministicCandidates') item
  join public.candidate_claim_envelopes envelope
    on envelope.workspace_key = p_workspace_key
   and envelope.extractor_candidate = item - 'candidateClaimVersionId' - 'candidateHash'
  join public.candidate_claim_job_lineage candidate_lineage
    on candidate_lineage.candidate_claim_version_id = envelope.candidate_claim_version_id
   and candidate_lineage.job_id = p_job_id;
  if v_old_manifest.canonical_manifest->'candidates' is distinct from v_candidate_manifest
    or (select count(*) from public.candidate_claim_job_lineage candidate_lineage
      where candidate_lineage.job_id = p_job_id) <> v_candidate_count
    or exists (
      select 1 from jsonb_array_elements(v_candidate_manifest) candidate
      where not exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.candidate_claim_envelopes envelope
          on envelope.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
        where candidate_lineage.job_id = p_job_id
          and candidate_lineage.candidate_claim_version_id = candidate->>'candidateClaimVersionId'
          and envelope.workspace_key = p_workspace_key
          and envelope.envelope_hash = candidate->>'itemHash'
      )
    ) then
    raise exception 'stale Gmail candidate manifest differs from the current deterministic frontier'
      using errcode = '23514';
  end if;

  if exists (select 1 from public.truth_pending_acceptance_epoch_manifests membership
      where membership.workspace_key = p_workspace_key and membership.source_job_id = p_job_id)
    or exists (select 1 from public.source_processing_job_observations output
      where output.job_id = p_job_id)
    or exists (select 1 from public.source_processing_job_children child
      where child.parent_job_id = p_job_id)
    or exists (select 1 from public.source_processing_job_lineage child_lineage
      where child_lineage.parent_job_id = p_job_id)
    or exists (
      select 1 from public.candidate_claim_job_lineage candidate_lineage
      join public.candidate_claim_decisions decision_row
        on decision_row.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
      where candidate_lineage.job_id = p_job_id
    )
    or exists (
      select 1 from public.candidate_claim_job_lineage candidate_lineage
      join public.candidate_claim_acceptance_bindings binding
        on binding.candidate_claim_version_id = candidate_lineage.candidate_claim_version_id
      where candidate_lineage.job_id = p_job_id
    )
    or exists (select 1 from public.truth_shadow_claim_acceptance_epoch_items item
      where item.workspace_key = p_workspace_key and (item.source_job_id = p_job_id
        or item.candidate_claim_version_id in (
          select candidate_lineage.candidate_claim_version_id
          from public.candidate_claim_job_lineage candidate_lineage
          where candidate_lineage.job_id = p_job_id
        )))
    or exists (select 1 from public.gmail_model_extraction_results result_row
      where result_row.workspace_key = p_workspace_key
        and result_row.model_plan_id = v_old_plan.model_plan_id)
    or exists (select 1 from public.gmail_model_extraction_review_intents intent
      where intent.workspace_key = p_workspace_key
        and intent.extraction_plan_id = v_old_plan.extraction_plan_id)
    or exists (select 1 from public.gmail_model_extraction_review_obligations obligation
      where obligation.workspace_key = p_workspace_key
        and obligation.extraction_plan_id = v_old_plan.extraction_plan_id) then
    raise exception 'stale Gmail plan already has downstream authority and cannot be reconciled'
      using errcode = '23514';
  end if;

  v_reconciliation := jsonb_build_object(
    'schemaVersion', 'gmail-stale-extraction-plan-reconciliation-v1',
    'workspaceKey', p_workspace_key,
    'connectionKey', v_job.connection_key,
    'rootBatchId', v_lineage.root_batch_id,
    'staleParentJobId', p_job_id,
    'originalParentJobId', v_lineage.parent_job_id,
    'rootJobId', v_lineage.root_job_id,
    'sourceObservationId', v_observation.observation_id,
    'sourceObservationContentHash', v_observation.content_hash,
    'staleExtractionPlanId', v_old_plan.extraction_plan_id,
    'staleExtractionPlanHash', v_old_plan.extraction_plan_hash,
    'expectedExtractionPlanId', p_extraction_plan->>'extractionPlanId',
    'expectedExtractionPlanHash', p_extraction_plan->>'extractionPlanHash',
    'expectedDeterministicCandidateCount', v_candidate_count,
    'expectedDeterministicCandidateSetHash', v_candidate_set_hash,
    'shadowOnly', true,
    'productionPublicationAttempted', false
  );
  v_reconciliation_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_reconciliation), 'UTF8'
  ), 'sha256'), 'hex');
  v_reconciliation_id := 'gmail-plan-reconciliation:v1:' || v_reconciliation_hash;
  v_successor_job_id := (
    substr(v_reconciliation_hash, 1, 8) || '-' ||
    substr(v_reconciliation_hash, 9, 4) || '-4' ||
    substr(v_reconciliation_hash, 14, 3) || '-8' ||
    substr(v_reconciliation_hash, 18, 3) || '-' ||
    substr(v_reconciliation_hash, 21, 12)
  )::uuid;
  v_successor_dedupe_key := 'truth-shadow-stale-plan-successor:v1:' || v_reconciliation_hash;
  v_successor_payload := v_job.payload || jsonb_build_object(
    'stalePlanReconciliationId', v_reconciliation_id,
    'staleParentJobId', p_job_id,
    'expectedExtractionPlanId', p_extraction_plan->>'extractionPlanId',
    'shadowOnly', true,
    'productionPublicationAttempted', false
  );
  v_successor_payload_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_successor_payload), 'UTF8'
  ), 'sha256'), 'hex');

  insert into public.source_processing_jobs(
    job_id, dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, state, attempt_count, max_attempts,
    available_at, lease_owner, lease_fence, lease_expires_at, processor_version,
    payload, result, created_at, updated_at, completed_at
  ) values (
    v_successor_job_id, v_successor_dedupe_key, v_job.workspace_key, v_job.source_system,
    v_job.connection_key, v_job.job_kind, v_job.observation_id, v_job.source_object_id,
    'waiting_runtime', 0, v_job.max_attempts, clock_timestamp(), null, 0, null, '',
    v_successor_payload, '{}'::jsonb, clock_timestamp(), clock_timestamp(), null
  );
  insert into public.source_processing_job_lineage(
    job_id, workspace_key, source_system, connection_key, root_batch_id,
    parent_job_id, root_job_id, source_cursor_version, source_cursor_value
  ) values (
    v_successor_job_id, v_lineage.workspace_key, v_lineage.source_system,
    v_lineage.connection_key, v_lineage.root_batch_id, v_lineage.parent_job_id,
    v_lineage.root_job_id, v_lineage.source_cursor_version, v_lineage.source_cursor_value
  );
  update public.source_processing_jobs successor
  set state = 'leased', lease_owner = p_worker_id, lease_fence = 1,
      lease_expires_at = clock_timestamp() + interval '10 minutes',
      processor_version = p_processor_version, last_error_code = '', safe_error_detail = '',
      updated_at = clock_timestamp()
  where successor.job_id = v_successor_job_id and successor.state = 'waiting_runtime';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'stale Gmail successor could not acquire its internal validation lease'
      using errcode = '40001';
  end if;

  -- Reuse the canonical sealer as the exhaustive semantic validator.  This
  -- writes only a zero-materialized review manifest for the successor.
  v_plan_receipt := private.seal_gmail_model_extraction_plan(
    p_workspace_key, v_successor_job_id, p_worker_id, 1, p_processor_version,
    p_extraction_plan, 64, p_sync_token
  );
  if v_plan_receipt->>'planningStatus' <> 'review_required'
    or v_plan_receipt->>'planningFailureCode' <> 'MODEL_RUNTIME_DISABLED'
    or (v_plan_receipt->>'materializedDeterministicCandidateCount')::integer <> 0
    or v_plan_receipt->>'plannedDeterministicCandidateSetHash' <> v_candidate_set_hash then
    raise exception 'stale Gmail successor did not seal the exact zero-materialized review plan'
      using errcode = '23514';
  end if;

  v_supersession := jsonb_build_object(
    'schemaVersion', 'gmail-stale-extraction-plan-supersession-v1',
    'reconciliationId', v_reconciliation_id,
    'staleParentJobId', p_job_id,
    'successorJobId', v_successor_job_id,
    'staleExtractionPlanId', v_old_plan.extraction_plan_id,
    'expectedExtractionPlanId', p_extraction_plan->>'extractionPlanId',
    'status', 'superseded_by_current_review_plan',
    'shadowOnly', true,
    'productionPublicationAttempted', false
  );
  v_supersession_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_supersession), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt := jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'requeued_current_plan',
    'schemaVersion', 'gmail-stale-extraction-plan-reconciliation-receipt-v1',
    'workspaceKey', p_workspace_key,
    'staleParentJobId', p_job_id,
    'successorJobId', v_successor_job_id,
    'reconciliationId', v_reconciliation_id,
    'reconciliationHash', v_reconciliation_hash,
    'staleExtractionPlanId', v_old_plan.extraction_plan_id,
    'staleExtractionPlanHash', v_old_plan.extraction_plan_hash,
    'expectedExtractionPlanId', p_extraction_plan->>'extractionPlanId',
    'expectedExtractionPlanHash', p_extraction_plan->>'extractionPlanHash',
    'deterministicCandidateCount', v_candidate_count,
    'plannedDeterministicCandidateSetHash', v_candidate_set_hash,
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_receipt_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt), 'UTF8'
  ), 'sha256'), 'hex');

  insert into public.gmail_stale_extraction_plan_reconciliations(
    reconciliation_id, reconciliation_hash, workspace_key, connection_key,
    root_batch_id, source_cursor_version, source_cursor_value,
    stale_parent_job_id, successor_job_id, original_parent_job_id, root_job_id,
    source_observation_id, source_observation_content_hash,
    stale_extraction_plan_id, stale_extraction_plan_hash, stale_plan_seal_hash,
    stale_context_seal_id, stale_context_seal_hash,
    stale_candidate_manifest_hash, stale_candidate_count,
    expected_extraction_plan_id, expected_extraction_plan_hash,
    expected_planning_failure_code, expected_planning_failure_detail_hash,
    expected_deterministic_candidate_count, expected_deterministic_candidate_set_hash,
    successor_dedupe_key, successor_payload, successor_payload_hash,
    canonical_current_plan, canonical_reconciliation, canonical_supersession,
    supersession_hash, canonical_receipt, receipt_hash, schema_version,
    shadow_only, production_eligible, production_publication_attempted
  ) values (
    v_reconciliation_id, v_reconciliation_hash, p_workspace_key, v_job.connection_key,
    v_lineage.root_batch_id, v_lineage.source_cursor_version, v_lineage.source_cursor_value,
    p_job_id, v_successor_job_id, v_lineage.parent_job_id, v_lineage.root_job_id,
    v_observation.observation_id, v_observation.content_hash,
    v_old_plan.extraction_plan_id, v_old_plan.extraction_plan_hash, v_old_plan.plan_seal_hash,
    v_old_context.context_seal_id, v_old_context.seal_hash,
    v_old_manifest.manifest_hash, v_old_manifest.candidate_count,
    p_extraction_plan->>'extractionPlanId', p_extraction_plan->>'extractionPlanHash',
    'MODEL_RUNTIME_DISABLED', p_extraction_plan #>> '{planningFailure,detailHash}',
    v_candidate_count, v_candidate_set_hash,
    v_successor_dedupe_key, v_successor_payload, v_successor_payload_hash,
    p_extraction_plan, v_reconciliation, v_supersession,
    v_supersession_hash, v_receipt, v_receipt_hash,
    'gmail-stale-extraction-plan-reconciliation-v1', true, false, false
  );

  update public.source_processing_jobs stale
  set state = 'superseded', lease_owner = null, lease_expires_at = null,
      last_error_code = 'GMAIL_STALE_EXTRACTION_PLAN_RECONCILED',
      safe_error_detail =
        'Immutable stale plan was quarantined; an exact shadow-only successor was queued.',
      result = v_supersession, updated_at = clock_timestamp(), completed_at = clock_timestamp()
  where stale.job_id = p_job_id and stale.workspace_key = p_workspace_key
    and stale.state = 'leased' and stale.lease_owner = p_worker_id
    and stale.lease_fence = p_lease_fence
    and stale.processor_version = p_processor_version;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'stale Gmail plan lease changed before supersession'
      using errcode = '40001';
  end if;

  update public.source_processing_jobs successor
  set state = 'queued', available_at = clock_timestamp(), lease_owner = null,
      lease_expires_at = null, last_error_code = '', safe_error_detail = '',
      updated_at = clock_timestamp(), completed_at = null
  where successor.job_id = v_successor_job_id and successor.state = 'leased'
    and successor.lease_owner = p_worker_id and successor.lease_fence = 1;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'validated Gmail successor could not be routed'
      using errcode = '40001';
  end if;
  if not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(p_workspace_key, p_job_id) then
    raise exception 'stale Gmail plan reconciliation failed integrity read-back'
      using errcode = '23514';
  end if;
  return v_receipt;
end;
$function$;

create or replace function public.reconcile_stale_shadow_gmail_extraction_plan(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_extraction_plan jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.reconcile_stale_shadow_gmail_extraction_plan(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_extraction_plan, p_sync_token
  );
$function$;

revoke all on function private.reconcile_stale_shadow_gmail_extraction_plan(
  text,uuid,text,bigint,text,jsonb,text
) from public, anon, authenticated, service_role;
revoke all on function public.reconcile_stale_shadow_gmail_extraction_plan(
  text,uuid,text,bigint,text,jsonb,text
) from public, anon, authenticated;
grant execute on function public.reconcile_stale_shadow_gmail_extraction_plan(
  text,uuid,text,bigint,text,jsonb,text
) to service_role;

-- Acceptance counts the exact successor and excludes only the stale job whose
-- complete append-only reconciliation still passes every integrity check.
do $acceptance_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old_count text := $old$    and job.job_kind = any(array[
      'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
    ]);$old$;
  v_new_count text := $new$    and job.job_kind = any(array[
      'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
    ])
    and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
      job.workspace_key, job.job_id
    );$new$;
  v_old_incomplete text := $old$        and job.job_kind = any(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
        ])
        and ($old$;
  v_new_incomplete text := $new$        and job.job_kind = any(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
        ])
        and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
          job.workspace_key, job.job_id
        )
        and ($new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new_count in v_definition) = 0 then
    if position(v_old_count in v_definition) = 0
      or position(v_old_incomplete in v_definition) = 0 then
      raise exception 'shadow acceptance stale-plan rewrite did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old_count, v_new_count);
    v_updated := replace(v_updated, v_old_incomplete, v_new_incomplete);
    if position(v_new_count in v_updated) = 0
      or position(v_new_incomplete in v_updated) = 0 then
      raise exception 'shadow acceptance stale-plan rewrite is incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_new_incomplete in v_definition) = 0
    or position(v_old_count in v_definition) > 0
    or position(v_old_incomplete in v_definition) > 0 then
    raise exception 'shadow acceptance stale-plan rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$acceptance_rewrite$;

-- Quarantined stale candidates are neither operator-review targets nor
-- completeness gaps.  Candidates with any non-stale lineage remain visible.
do $review_queue_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.read_truth_review_queue(text,text,integer,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$    where candidate.workspace_key = p_workspace_key
      and ($old$;
  v_new text := $new$    where candidate.workspace_key = p_workspace_key
      and not private.truth_shadow_is_reconciled_stale_candidate_v1(
        candidate.workspace_key, candidate.candidate_claim_version_id
      )
      and ($new$;
  v_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  if v_count = 0 then
    if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 2 then
      raise exception 'truth review queue stale-candidate rewrite did not match twice'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    execute v_updated;
    select pg_get_functiondef(v_signature) into v_definition;
    v_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  end if;
  if v_count <> 2 or position(v_old in v_definition) > 0 then
    raise exception 'truth review queue stale-candidate rewrite failed read-back'
      using errcode = '23514';
  end if;
end;
$review_queue_rewrite$;

do $review_gap_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.truth_review_gaps_for_source_cut(text,jsonb)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$    where candidate.workspace_key = p_workspace_key
      and ($old$;
  v_new text := $new$    where candidate.workspace_key = p_workspace_key
      and not private.truth_shadow_is_reconciled_stale_candidate_v1(
        candidate.workspace_key, candidate.candidate_claim_version_id
      )
      and ($new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'source-cut review-gap rewrite did not match predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    execute v_updated;
    select pg_get_functiondef(v_signature) into v_definition;
  end if;
  if position(v_new in v_definition) = 0 or position(v_old in v_definition) > 0 then
    raise exception 'source-cut review-gap rewrite failed read-back'
      using errcode = '23514';
  end if;
end;
$review_gap_rewrite$;

-- Reassert all ACLs after guarded function replacement.
revoke all on function private.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public, anon, authenticated, service_role;
revoke all on function private.run_truth_shadow_claim_acceptance_epoch(text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_review_queue(text,text,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_review_gaps_for_source_cut(text,jsonb)
  from public, anon, authenticated, service_role;

do $verify$
declare
  v_definition text;
  v_count integer;
begin
  if not exists (
    select 1 from pg_class table_row
    where table_row.oid = 'public.gmail_stale_extraction_plan_reconciliations'::regclass
      and table_row.relrowsecurity and table_row.relforcerowsecurity
  ) then
    raise exception 'stale Gmail reconciliation table RLS is not forced'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.gmail_stale_extraction_plan_reconciliations'::regclass
      and trigger_row.tgname = 'gmail_stale_extraction_plan_reconciliations_immutable'
      and not trigger_row.tgisinternal
  ) or not exists (
    select 1 from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.candidate_claim_decisions'::regclass
      and trigger_row.tgname = 'candidate_claim_decisions_stale_gmail_quarantine'
      and not trigger_row.tgisinternal
  ) then
    raise exception 'stale Gmail reconciliation immutability/quarantine triggers are unavailable'
      using errcode = '23514';
  end if;
  if has_function_privilege('anon',
      'public.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)',
      'execute')
    or not has_function_privilege('service_role',
      'public.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)',
      'execute')
    or has_function_privilege('service_role',
      'private.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)',
      'execute') then
    raise exception 'stale Gmail reconciliation RPC ACLs are unsafe'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('v_has_model_plan is distinct from' in v_definition) = 0
    or position('gmail-model-runtime-disabled-review-v1' in v_definition) = 0 then
    raise exception 'stale Gmail reconciliation sealer hardening is absent'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  v_count := (length(v_definition) - length(replace(
    v_definition, 'truth_shadow_is_reconciled_stale_gmail_claim_v1', ''
  ))) / length('truth_shadow_is_reconciled_stale_gmail_claim_v1');
  if v_count <> 2 then
    raise exception 'shadow acceptance stale-job exclusions are not exact'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.read_truth_review_queue(text,text,integer,text)'::regprocedure
  ) into v_definition;
  v_count := (length(v_definition) - length(replace(
    v_definition, 'truth_shadow_is_reconciled_stale_candidate_v1', ''
  ))) / length('truth_shadow_is_reconciled_stale_candidate_v1');
  if v_count <> 2 then
    raise exception 'truth review queue stale-candidate exclusions are not exact'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.truth_review_gaps_for_source_cut(text,jsonb)'::regprocedure
  ) into v_definition;
  if position('truth_shadow_is_reconciled_stale_candidate_v1' in v_definition) = 0 then
    raise exception 'source-cut review gap stale-candidate exclusion is absent'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.gmail_stale_extraction_plan_reconciliations reconciliation
    where not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
      reconciliation.workspace_key, reconciliation.stale_parent_job_id
    )
  ) then
    raise exception 'stored stale Gmail reconciliation failed migration read-back'
      using errcode = '23514';
  end if;
end;
$verify$;
