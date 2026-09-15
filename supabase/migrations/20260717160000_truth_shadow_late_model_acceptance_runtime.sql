-- Certify model work which honestly completed after the source-wide claim
-- acceptance epoch was sealed.  The predecessor epoch is never rewritten:
-- this authority records a separate, immutable terminal frontier, adopts only
-- already-authored operator review decisions, and binds those facts to a new
-- exact source cut.  Every artifact is permanently shadow-only.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_cut_guard text;
  v_build_guard text;
  v_cut_guard_hash text;
begin
  if to_regclass(
      'public.truth_shadow_gmail_resumed_model_child_authorizations'
    ) is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epoch_items') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.gmail_model_extraction_results') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.gmail_model_context_observations') is null
    or to_regclass('public.gmail_model_context_accepted_claims') is null
    or to_regclass('public.gmail_model_context_workgroup_memberships') is null
    or to_regclass('public.gmail_model_extraction_review_intents') is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.gmail_model_extraction_review_resolutions') is null
    or to_regclass('public.truth_review_resolutions') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.candidate_claim_job_lineage') is null
    or to_regclass('public.candidate_claim_decisions') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null
    or to_regclass('public.accepted_claims') is null
    or to_regclass('public.accepted_claim_envelopes') is null
    or to_regclass('public.accepted_claim_evidence') is null
    or to_regclass('public.operational_workgroup_memberships') is null
    or to_regclass('public.operational_workgroup_membership_envelopes') is null
    or to_regclass('public.operational_workgroup_membership_evidence') is null
    or to_regclass('public.source_cuts') is null
    or to_regclass('public.truth_build_inputs') is null then
    raise exception 'late-model acceptance prerequisites are unavailable'
      using errcode = '55000';
  end if;
  if to_regprocedure('private.valid_truth_review_token(text)') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.source_observation_within_cut(text,text,text,text)') is null
    or to_regprocedure('private.authoritative_truth_input_hash(text,text)') is null
    or to_regprocedure(
      'private.require_exact_complete_source_cut(text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_claim_visible_to_connection(text,text,text,text)'
    ) is null
    or to_regprocedure(
      'private.guard_truth_shadow_build_input_scope()'
    ) is null then
    raise exception 'late-model acceptance function prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'private.require_exact_complete_source_cut(text,text)'::regprocedure
  ) into v_cut_guard;
  v_cut_guard_hash := encode(extensions.digest(
    convert_to(v_cut_guard, 'UTF8'), 'sha256'
  ), 'hex');
  perform set_config(
    'pikiio.migration_160_exact_cut_guard_hash', v_cut_guard_hash, false
  );
  select pg_get_functiondef(
    'private.guard_truth_shadow_build_input_scope()'::regprocedure
  ) into v_build_guard;
  if position('truth build source cut is incomplete or malformed' in v_cut_guard) = 0
    or position('source-cut-partition-witness-v1' in v_cut_guard) = 0
    or position('shadow build accepted claim escaped the sealed acceptance frontier'
      in v_build_guard) = 0 then
    raise exception 'source-cut or shadow-build guard differs from reviewed authority'
      using errcode = '23514';
  end if;
end;
$preflight$;

create table if not exists public.truth_shadow_late_model_acceptance_runs (
  run_id text primary key check (
    run_id ~ '^truth-shadow-late-model-acceptance:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  predecessor_epoch_id text not null,
  predecessor_epoch_receipt_hash text not null check (
    predecessor_epoch_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  predecessor_frontier_manifest_hash text not null check (
    predecessor_frontier_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  predecessor_decision_authority_manifest_hash text not null check (
    predecessor_decision_authority_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  authorization_manifest jsonb not null check (
    jsonb_typeof(authorization_manifest) = 'array'
  ),
  authorization_manifest_hash text not null check (
    authorization_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  terminal_manifest jsonb not null check (jsonb_typeof(terminal_manifest) = 'array'),
  terminal_manifest_hash text not null check (terminal_manifest_hash ~ '^[0-9a-f]{64}$'),
  decision_manifest jsonb not null check (jsonb_typeof(decision_manifest) = 'array'),
  decision_manifest_hash text not null check (decision_manifest_hash ~ '^[0-9a-f]{64}$'),
  authorization_count integer not null check (authorization_count = 10),
  successful_model_child_count integer not null check (
    successful_model_child_count >= 0
  ),
  reviewed_model_child_count integer not null check (
    reviewed_model_child_count >= 0
  ),
  candidate_count integer not null check (candidate_count >= 0),
  accepted_count integer not null check (accepted_count >= 0),
  rejected_count integer not null check (rejected_count >= 0),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-late-model-acceptance-v1'
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
  unique (workspace_key, run_id),
  unique (workspace_key, connection_key, root_batch_id, predecessor_epoch_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, predecessor_epoch_id)
    references public.truth_shadow_claim_acceptance_epochs(workspace_key, epoch_id)
    on update restrict on delete restrict,
  check (successful_model_child_count + reviewed_model_child_count = authorization_count),
  check (candidate_count = accepted_count + rejected_count),
  check (jsonb_array_length(authorization_manifest) = authorization_count),
  check (jsonb_array_length(terminal_manifest) = authorization_count),
  check (jsonb_array_length(decision_manifest) = candidate_count),
  check (authorization_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(authorization_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (terminal_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(terminal_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (decision_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(decision_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (receipt_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt), 'UTF8'
  ), 'sha256'), 'hex')),
  check (run_id = 'truth-shadow-late-model-acceptance:v1:' || receipt_hash),
  check (canonical_receipt->>'schemaVersion' = schema_version),
  check (canonical_receipt->>'workspaceKey' = workspace_key),
  check (canonical_receipt->>'sourceSystem' = source_system),
  check (canonical_receipt->>'connectionKey' = connection_key),
  check (canonical_receipt->>'rootBatchId' = root_batch_id::text),
  check ((canonical_receipt->>'sourceCursorVersion')::bigint = source_cursor_version),
  check (canonical_receipt->>'sourceCursorValue' = source_cursor_value),
  check (canonical_receipt->>'predecessorEpochId' = predecessor_epoch_id),
  check (canonical_receipt->>'predecessorEpochReceiptHash' =
    predecessor_epoch_receipt_hash),
  check (canonical_receipt->>'authorizationManifestHash' =
    authorization_manifest_hash),
  check (canonical_receipt->>'terminalManifestHash' = terminal_manifest_hash),
  check (canonical_receipt->>'decisionManifestHash' = decision_manifest_hash),
  check ((canonical_receipt->>'authorizationCount')::integer = authorization_count),
  check ((canonical_receipt->>'successfulModelChildCount')::integer =
    successful_model_child_count),
  check ((canonical_receipt->>'reviewedModelChildCount')::integer =
    reviewed_model_child_count),
  check ((canonical_receipt->>'candidateCount')::integer = candidate_count),
  check ((canonical_receipt->>'acceptedCount')::integer = accepted_count),
  check ((canonical_receipt->>'rejectedCount')::integer = rejected_count),
  check ((canonical_receipt->>'shadowOnly')::boolean = true),
  check ((canonical_receipt->>'productionEligible')::boolean = false),
  check ((canonical_receipt->>'productionPublicationAttempted')::boolean = false),
  check ((canonical_receipt->>'mutatesOperationalState')::boolean = false),
  check ((canonical_receipt->>'publishesTruth')::boolean = false),
  check ((canonical_receipt->>'performsActions')::boolean = false),
  check (canonical_receipt->>'publicationChannel' = 'shadow'),
  check (canonical_receipt->>'decisionAuthorityKind' = 'truth_review_resolution'),
  check (canonical_receipt->>'predecessorFrontierManifestHash' =
    predecessor_frontier_manifest_hash),
  check (canonical_receipt->>'predecessorDecisionAuthorityManifestHash' =
    predecessor_decision_authority_manifest_hash),
  check (canonical_receipt ?& array[
    'schemaVersion','workspaceKey','sourceSystem','connectionKey','rootBatchId',
    'sourceCursorVersion','sourceCursorValue','predecessorEpochId',
    'predecessorEpochReceiptHash','predecessorFrontierManifestHash',
    'predecessorDecisionAuthorityManifestHash','authorizationManifestHash',
    'terminalManifestHash','decisionManifestHash','authorizationCount',
    'successfulModelChildCount','reviewedModelChildCount','candidateCount',
    'acceptedCount','rejectedCount','decisionAuthorityKind',
    'publicationChannel','shadowOnly','mutatesOperationalState',
    'productionEligible','productionPublicationAttempted','publishesTruth',
    'performsActions'
  ]::text[] and private.truth_jsonb_has_only_keys(canonical_receipt, array[
    'schemaVersion','workspaceKey','sourceSystem','connectionKey','rootBatchId',
    'sourceCursorVersion','sourceCursorValue','predecessorEpochId',
    'predecessorEpochReceiptHash','predecessorFrontierManifestHash',
    'predecessorDecisionAuthorityManifestHash','authorizationManifestHash',
    'terminalManifestHash','decisionManifestHash','authorizationCount',
    'successfulModelChildCount','reviewedModelChildCount','candidateCount',
    'acceptedCount','rejectedCount','decisionAuthorityKind',
    'publicationChannel','shadowOnly','mutatesOperationalState',
    'productionEligible','productionPublicationAttempted','publishesTruth',
    'performsActions'
  ]))
);

create table if not exists public.truth_shadow_late_model_acceptance_items (
  item_id text primary key check (
    item_id ~ '^truth-shadow-late-model-item:v1:[0-9a-f]{64}$'
  ),
  run_id text not null references public.truth_shadow_late_model_acceptance_runs(run_id)
    on update restrict on delete restrict,
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  ordinal integer not null check (ordinal >= 0),
  authorization_id text not null,
  model_child_job_id uuid not null,
  candidate_claim_version_id text not null unique,
  candidate_item_hash text not null check (candidate_item_hash ~ '^[0-9a-f]{64}$'),
  decision_authority_kind text not null check (
    decision_authority_kind = 'truth_review_resolution'
  ),
  decision_authority_hash text not null check (
    decision_authority_hash ~ '^[0-9a-f]{64}$'
  ),
  decision text not null check (decision in ('accept', 'reject')),
  decision_version_id text not null unique,
  decision_item_hash text not null check (decision_item_hash ~ '^[0-9a-f]{64}$'),
  review_resolution_id text not null unique,
  review_request_hash text not null check (review_request_hash ~ '^[0-9a-f]{64}$'),
  review_receipt_hash text not null check (review_receipt_hash ~ '^[0-9a-f]{64}$'),
  accepted_claim_version_id text unique,
  accepted_claim_item_hash text not null default '' check (
    accepted_claim_item_hash = '' or accepted_claim_item_hash ~ '^[0-9a-f]{64}$'
  ),
  binding_id text unique,
  binding_item_hash text not null default '' check (
    binding_item_hash = '' or binding_item_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_item jsonb not null check (jsonb_typeof(canonical_item) = 'object'),
  item_hash text not null unique check (item_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-late-model-acceptance-item-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id, ordinal),
  unique (workspace_key, authorization_id, candidate_claim_version_id),
  foreign key (workspace_key, run_id)
    references public.truth_shadow_late_model_acceptance_runs(workspace_key, run_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, authorization_id)
    references public.truth_shadow_gmail_resumed_model_child_authorizations(
      workspace_key, authorization_id
    ) on update restrict on delete restrict,
  foreign key (workspace_key, model_child_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, candidate_claim_version_id)
    references public.candidate_claim_envelopes(workspace_key, candidate_claim_version_id)
    on update restrict on delete restrict,
  foreign key (decision_version_id)
    references public.candidate_claim_decisions(decision_version_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, review_resolution_id)
    references public.truth_review_resolutions(workspace_key, review_resolution_id)
    on update restrict on delete restrict,
  foreign key (accepted_claim_version_id)
    references public.accepted_claims(claim_version_id)
    on update restrict on delete restrict,
  foreign key (binding_id)
    references public.candidate_claim_acceptance_bindings(binding_id)
    on update restrict on delete restrict,
  check (
    (decision = 'accept'
      and accepted_claim_version_id is not null
      and accepted_claim_item_hash <> ''
      and binding_id is not null
      and binding_item_hash <> '')
    or
    (decision = 'reject'
      and accepted_claim_version_id is null
      and accepted_claim_item_hash = ''
      and binding_id is null
      and binding_item_hash = '')
  ),
  check (item_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_item), 'UTF8'
  ), 'sha256'), 'hex')),
  check (item_id = 'truth-shadow-late-model-item:v1:' || item_hash),
  check (canonical_item->>'schemaVersion' = schema_version),
  check (canonical_item->>'runId' = run_id),
  check (canonical_item->>'workspaceKey' = workspace_key),
  check ((canonical_item->>'ordinal')::integer = ordinal),
  check (canonical_item->>'authorizationId' = authorization_id),
  check (canonical_item->>'modelChildJobId' = model_child_job_id::text),
  check (canonical_item->>'candidateClaimVersionId' = candidate_claim_version_id),
  check (canonical_item->>'candidateItemHash' = candidate_item_hash),
  check (canonical_item->>'decisionAuthorityKind' = decision_authority_kind),
  check (canonical_item->>'decisionAuthorityHash' = decision_authority_hash),
  check (canonical_item->>'decision' = decision),
  check (canonical_item->>'decisionVersionId' = decision_version_id),
  check (canonical_item->>'decisionItemHash' = decision_item_hash),
  check (canonical_item->>'reviewResolutionId' = review_resolution_id),
  check (canonical_item->>'reviewRequestHash' = review_request_hash),
  check (canonical_item->>'reviewReceiptHash' = review_receipt_hash),
  check (canonical_item->>'acceptedClaimVersionId' =
    coalesce(accepted_claim_version_id, '')),
  check (canonical_item->>'acceptedClaimItemHash' = accepted_claim_item_hash),
  check (canonical_item->>'bindingId' = coalesce(binding_id, '')),
  check (canonical_item->>'bindingItemHash' = binding_item_hash),
  check (canonical_item ?& array[
    'schemaVersion','runId','workspaceKey','ordinal','authorizationId',
    'modelChildJobId','candidateClaimVersionId','candidateItemHash',
    'decisionAuthorityKind','decisionAuthorityHash','decision',
    'decisionVersionId','decisionItemHash','reviewResolutionId',
    'reviewRequestHash','reviewReceiptHash','acceptedClaimVersionId',
    'acceptedClaimItemHash','bindingId','bindingItemHash'
  ]::text[] and private.truth_jsonb_has_only_keys(canonical_item, array[
    'schemaVersion','runId','workspaceKey','ordinal','authorizationId',
    'modelChildJobId','candidateClaimVersionId','candidateItemHash',
    'decisionAuthorityKind','decisionAuthorityHash','decision',
    'decisionVersionId','decisionItemHash','reviewResolutionId',
    'reviewRequestHash','reviewReceiptHash','acceptedClaimVersionId',
    'acceptedClaimItemHash','bindingId','bindingItemHash'
  ]))
);

create unique index if not exists truth_shadow_root_source_cut_workspace_scope_uidx
  on public.truth_shadow_root_source_cuts(workspace_key, scope_receipt_id);

create table if not exists public.truth_shadow_late_model_source_cut_bindings (
  binding_id text primary key check (
    binding_id ~ '^truth-shadow-late-model-cut-binding:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  source_cut_id text not null unique,
  source_cut_manifest_hash text not null check (
    source_cut_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  root_scope_receipt_id text not null,
  root_scope_receipt_hash text not null check (root_scope_receipt_hash ~ '^[0-9a-f]{64}$'),
  run_id text not null unique,
  run_receipt_hash text not null check (run_receipt_hash ~ '^[0-9a-f]{64}$'),
  predecessor_epoch_id text not null,
  predecessor_epoch_receipt_hash text not null check (
    predecessor_epoch_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_binding jsonb not null check (jsonb_typeof(canonical_binding) = 'object'),
  binding_hash text not null unique check (binding_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-late-model-source-cut-binding-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, binding_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_cut_id)
    references public.source_cuts(workspace_key, source_cut_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, root_scope_receipt_id)
    references public.truth_shadow_root_source_cuts(workspace_key, scope_receipt_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, run_id)
    references public.truth_shadow_late_model_acceptance_runs(workspace_key, run_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, predecessor_epoch_id)
    references public.truth_shadow_claim_acceptance_epochs(workspace_key, epoch_id)
    on update restrict on delete restrict,
  check (binding_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_binding), 'UTF8'
  ), 'sha256'), 'hex')),
  check (binding_id = 'truth-shadow-late-model-cut-binding:v1:' || binding_hash),
  check (canonical_binding->>'schemaVersion' = schema_version),
  check (canonical_binding->>'workspaceKey' = workspace_key),
  check (canonical_binding->>'sourceSystem' = source_system),
  check (canonical_binding->>'connectionKey' = connection_key),
  check (canonical_binding->>'rootBatchId' = root_batch_id::text),
  check ((canonical_binding->>'sourceCursorVersion')::bigint =
    source_cursor_version),
  check (canonical_binding->>'sourceCursorValue' = source_cursor_value),
  check (canonical_binding->>'sourceCutId' = source_cut_id),
  check (canonical_binding->>'sourceCutManifestHash' = source_cut_manifest_hash),
  check (canonical_binding->>'rootScopeReceiptId' = root_scope_receipt_id),
  check (canonical_binding->>'rootScopeReceiptHash' = root_scope_receipt_hash),
  check (canonical_binding->>'runId' = run_id),
  check (canonical_binding->>'runReceiptHash' = run_receipt_hash),
  check (canonical_binding->>'predecessorEpochId' = predecessor_epoch_id),
  check (canonical_binding->>'predecessorEpochReceiptHash' =
    predecessor_epoch_receipt_hash),
  check ((canonical_binding->>'shadowOnly')::boolean = true),
  check ((canonical_binding->>'productionEligible')::boolean = false),
  check ((canonical_binding->>'productionPublicationAttempted')::boolean = false),
  check ((canonical_binding->>'freshAfterLateAcceptance')::boolean = true),
  check (canonical_binding->>'sourceCutCompleteness' = 'complete'),
  check (canonical_binding->>'publicationChannel' = 'shadow'),
  check ((canonical_binding->>'publishesTruth')::boolean = false),
  check ((canonical_binding->>'performsActions')::boolean = false),
  check (canonical_binding ?& array[
    'schemaVersion','workspaceKey','sourceSystem','connectionKey','rootBatchId',
    'sourceCursorVersion','sourceCursorValue','sourceCutId',
    'sourceCutManifestHash','rootScopeReceiptId','rootScopeReceiptHash',
    'runId','runReceiptHash','predecessorEpochId',
    'predecessorEpochReceiptHash','terminalManifestHash',
    'decisionManifestHash','freshAfterLateAcceptance','sourceCutCompleteness',
    'publicationChannel','shadowOnly','productionEligible',
    'productionPublicationAttempted','publishesTruth','performsActions'
  ]::text[] and private.truth_jsonb_has_only_keys(canonical_binding, array[
    'schemaVersion','workspaceKey','sourceSystem','connectionKey','rootBatchId',
    'sourceCursorVersion','sourceCursorValue','sourceCutId',
    'sourceCutManifestHash','rootScopeReceiptId','rootScopeReceiptHash',
    'runId','runReceiptHash','predecessorEpochId',
    'predecessorEpochReceiptHash','terminalManifestHash',
    'decisionManifestHash','freshAfterLateAcceptance','sourceCutCompleteness',
    'publicationChannel','shadowOnly','productionEligible',
    'productionPublicationAttempted','publishesTruth','performsActions'
  ]))
);

create index if not exists truth_shadow_late_model_run_scope_idx
  on public.truth_shadow_late_model_acceptance_runs(
    workspace_key, connection_key, source_cursor_version
  );
create index if not exists truth_shadow_late_model_item_child_idx
  on public.truth_shadow_late_model_acceptance_items(
    workspace_key, model_child_job_id, candidate_claim_version_id
  );
create index if not exists truth_shadow_late_model_cut_run_idx
  on public.truth_shadow_late_model_source_cut_bindings(workspace_key, run_id, source_cut_id);

do $storage_quarantine$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_shadow_late_model_acceptance_runs',
    'truth_shadow_late_model_acceptance_items',
    'truth_shadow_late_model_source_cut_bindings'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I '
      || 'for each row execute function public.reject_immutable_truth_mutation()',
      v_table, v_table
    );
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select on table public.%I to service_role', v_table);
    execute format(
      'revoke insert, update, delete, truncate on table public.%I from service_role',
      v_table
    );
  end loop;
end;
$storage_quarantine$;

-- A late item is not a second decision.  It is a proof that the immutable
-- operator review authority, accepted claim (when any), and its candidate
-- binding are exact descendants of one authorized late model child.
create or replace function private.truth_shadow_late_model_review_adoption_v1(
  p_workspace_key text,
  p_authorization_id text,
  p_source_job_id uuid,
  p_candidate_claim_version_id text,
  p_candidate_item_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_decision public.candidate_claim_decisions%rowtype;
  v_resolution public.truth_review_resolutions%rowtype;
  v_binding public.candidate_claim_acceptance_bindings%rowtype;
  v_claim public.accepted_claims%rowtype;
  v_envelope public.accepted_claim_envelopes%rowtype;
  v_expected_request jsonb;
  v_expected_receipt jsonb;
  v_expected_binding jsonb;
  v_authority jsonb;
  v_authority_hash text;
  v_decision_count integer;
begin
  if not exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_results model_result
      on model_result.workspace_key = authority.workspace_key
     and model_result.model_child_job_id = authority.model_child_job_id
     and model_result.model_plan_id = authority.model_plan_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = authority.workspace_key
     and manifest.job_id = authority.model_child_job_id
     and manifest.manifest_hash = model_result.candidate_manifest_hash
    join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      on true
    join public.candidate_claim_job_lineage lineage
      on lineage.job_id = authority.model_child_job_id
     and lineage.candidate_claim_version_id = item->>'candidateClaimVersionId'
     and lineage.source_observation_id = authority.source_observation_id
    where authority.workspace_key = p_workspace_key
      and authority.authorization_id = p_authorization_id
      and authority.model_child_job_id = p_source_job_id
      and item->>'candidateClaimVersionId' = p_candidate_claim_version_id
      and item->>'itemHash' = p_candidate_item_hash
      and manifest.source_observation_id = authority.source_observation_id
      and manifest.candidate_count = model_result.candidate_count
      and manifest.manifest_schema_version = 'candidate-claim-job-manifest-v1'
      and manifest.manifest_hash = encode(extensions.digest(
        convert_to(manifest.canonical_manifest::text, 'UTF8'), 'sha256'
      ), 'hex')
  ) then
    raise exception 'late-model review target is outside its authorized result manifest'
      using errcode = '23514';
  end if;

  select * into v_candidate
  from public.candidate_claim_envelopes candidate
  where candidate.workspace_key = p_workspace_key
    and candidate.candidate_claim_version_id = p_candidate_claim_version_id
    and candidate.envelope_hash = p_candidate_item_hash;
  if not found then
    raise exception 'late-model candidate is unavailable'
      using errcode = '23503';
  end if;

  select * into v_decision
  from public.candidate_claim_decisions decision_row
  where decision_row.candidate_claim_version_id = p_candidate_claim_version_id
  order by decision_row.decision_no desc
  limit 1;
  if not found then
    return jsonb_build_object('status', 'pending_review');
  end if;

  select count(*)::integer into v_decision_count
  from public.candidate_claim_decisions decision_row
  where decision_row.candidate_claim_version_id = p_candidate_claim_version_id;
  if v_decision_count <> v_decision.decision_no
    or v_decision.decision_no < 1
    or exists (
      select 1
      from public.candidate_claim_decisions current_decision
      where current_decision.candidate_claim_version_id = p_candidate_claim_version_id
        and (
          (current_decision.decision_no = 1
            and current_decision.previous_decision_version_id is not null)
          or
          (current_decision.decision_no > 1 and not exists (
            select 1
            from public.candidate_claim_decisions prior_decision
            where prior_decision.candidate_claim_version_id = p_candidate_claim_version_id
              and prior_decision.decision_no = current_decision.decision_no - 1
              and prior_decision.decision_version_id =
                current_decision.previous_decision_version_id
          ))
        )
    )
    or exists (
      select 1
      from public.candidate_claim_decisions prior_decision
      where prior_decision.candidate_claim_version_id = p_candidate_claim_version_id
        and prior_decision.decision_no < v_decision.decision_no
        and prior_decision.decision <> 'review'
    )
    or v_decision.decision not in ('accept', 'reject')
    or v_decision.decision_method <> 'operator'
    or v_decision.policy_version <> 'truth-shadow-model-commissioning-review-v1'
    or v_decision.decision_schema_version <> 'candidate-claim-decision-v1'
    or v_decision.decision_hash is distinct from encode(extensions.digest(
      convert_to(v_decision.canonical_decision::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_decision.decision_version_id is distinct from
      'candidate-decision:v1:' || v_decision.decision_hash
    or v_decision.canonical_decision is distinct from jsonb_build_object(
      'decisionSchemaVersion', 'candidate-claim-decision-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', p_candidate_claim_version_id,
      'candidateItemHash', p_candidate_item_hash,
      'decision', jsonb_build_object(
        'decisionNo', v_decision.decision_no,
        'previousDecisionVersionId',
          coalesce(v_decision.previous_decision_version_id, ''),
        'decision', v_decision.decision,
        'method', v_decision.decision_method,
        'policyVersion', v_decision.policy_version,
        'decidedBy', v_decision.decided_by,
        'reasons', v_decision.reasons,
        'acceptedClaimRequest', v_decision.accepted_claim_request
      )
    ) then
    raise exception 'late-model candidate has an unadoptable decision authority'
      using errcode = '55000';
  end if;

  select * into v_resolution
  from public.truth_review_resolutions resolution
  where resolution.workspace_key = p_workspace_key
    and resolution.target_kind = 'candidate_claim'
    and resolution.target_id = p_candidate_claim_version_id;
  if not found
    or v_resolution.target_item_hash is distinct from p_candidate_item_hash
    or v_resolution.decision is distinct from v_decision.decision
    or v_resolution.decision_version_id is distinct from v_decision.decision_version_id
    or v_resolution.decision_item_hash is distinct from v_decision.decision_hash
    or v_resolution.request_schema_version <> 'truth-review-resolution-v1'
    or v_resolution.request_hash is distinct from encode(extensions.digest(
      convert_to(v_resolution.canonical_request::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_resolution.receipt_hash is distinct from encode(extensions.digest(
      convert_to(v_resolution.canonical_receipt::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_resolution.review_resolution_id is distinct from
      'review-resolution:v1:' || v_resolution.request_hash
    or jsonb_array_length(v_decision.reasons) <> 1 then
    raise exception 'late-model decision lacks its exact immutable review resolution'
      using errcode = '55000';
  end if;

  v_expected_request := jsonb_build_object(
    'requestSchemaVersion', 'truth-review-resolution-v1',
    'workspaceKey', p_workspace_key,
    'idempotencyKeyHash', v_resolution.idempotency_key_hash,
    'targetKind', 'candidate_claim',
    'targetId', p_candidate_claim_version_id,
    'expectedTargetHash', p_candidate_item_hash,
    'expectedPreviousDecisionVersionId',
      coalesce(v_decision.previous_decision_version_id, ''),
    'decision', v_decision.decision,
    'policyVersion', v_decision.policy_version,
    'decidedBy', v_decision.decided_by,
    'reason', v_decision.reasons->>0
  );
  v_expected_receipt := jsonb_build_object(
    'ok', true,
    'reviewResolutionId', v_resolution.review_resolution_id,
    'targetKind', 'candidate_claim',
    'targetId', p_candidate_claim_version_id,
    'targetItemHash', p_candidate_item_hash,
    'decision', v_decision.decision,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'acceptedKind', v_resolution.accepted_kind,
    'acceptedItemId', v_resolution.accepted_item_id,
    'acceptedItemHash', v_resolution.accepted_item_hash,
    'bindingId', v_resolution.binding_id,
    'bindingItemHash', v_resolution.binding_item_hash,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
  if v_resolution.canonical_request is distinct from v_expected_request
    or v_resolution.canonical_receipt is distinct from v_expected_receipt then
    raise exception 'late-model review resolution canonical provenance is invalid'
      using errcode = '23514';
  end if;

  if v_decision.decision = 'accept' then
    select * into v_binding
    from public.candidate_claim_acceptance_bindings binding
    where binding.candidate_claim_version_id = p_candidate_claim_version_id
      and binding.decision_version_id = v_decision.decision_version_id
      and binding.binding_id = v_resolution.binding_id
      and binding.binding_hash = v_resolution.binding_item_hash
      and binding.accepted_claim_version_id = v_resolution.accepted_item_id;
    select * into v_claim
    from public.accepted_claims claim
    where claim.claim_version_id = v_resolution.accepted_item_id;
    select * into v_envelope
    from public.accepted_claim_envelopes envelope
    where envelope.workspace_key = p_workspace_key
      and envelope.claim_version_id = v_resolution.accepted_item_id;
    v_expected_binding := jsonb_build_object(
      'bindingSchemaVersion', 'candidate-claim-acceptance-binding-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', p_candidate_claim_version_id,
      'candidateItemHash', p_candidate_item_hash,
      'decisionVersionId', v_decision.decision_version_id,
      'decisionItemHash', v_decision.decision_hash,
      'acceptedClaimVersionId', v_resolution.accepted_item_id,
      'acceptedClaimItemHash', v_resolution.accepted_item_hash
    );
    if v_resolution.accepted_kind <> 'accepted_claim'
      or v_decision.accepted_claim_request is null
      or v_binding.binding_id is null
      or v_binding.binding_schema_version <> 'candidate-claim-acceptance-binding-v1'
      or v_binding.binding_hash is distinct from encode(extensions.digest(
        convert_to(v_binding.canonical_binding::text, 'UTF8'), 'sha256'
      ), 'hex')
      or v_binding.binding_id is distinct from
        'candidate-acceptance:v1:' || v_binding.binding_hash
      or v_binding.canonical_binding is distinct from v_expected_binding
      or v_claim.claim_version_id is null
      or v_envelope.claim_version_id is null
      or v_claim.claim_content_hash is distinct from v_resolution.accepted_item_hash
      or v_envelope.envelope_hash is distinct from v_resolution.accepted_item_hash
      or private.authoritative_truth_input_hash(
        'accepted_claim', v_claim.claim_version_id
      ) is distinct from v_resolution.accepted_item_hash
      or v_claim.claim_key is distinct from
        v_decision.accepted_claim_request->'claim'->>'claimKey'
      or v_claim.version_no is distinct from
        (v_decision.accepted_claim_request->'claim'->>'versionNo')::integer
      or coalesce(v_claim.previous_claim_version_id, '') is distinct from coalesce(
        v_decision.accepted_claim_request->'claim'->>'previousClaimVersionId', ''
      )
      or v_claim.primary_observation_id is distinct from v_candidate.source_observation_id
      or v_claim.subject_type is distinct from
        v_decision.accepted_claim_request->'claim'->>'subjectType'
      or v_claim.subject_key is distinct from
        v_decision.accepted_claim_request->'claim'->>'subjectKey'
      or v_claim.predicate is distinct from
        v_decision.accepted_claim_request->'claim'->>'predicate'
      or v_claim.gate is distinct from
        v_decision.accepted_claim_request->'claim'->>'gate'
      or v_claim.polarity is distinct from
        v_decision.accepted_claim_request->'claim'->>'polarity'
      or v_claim.normalized_value is distinct from
        v_decision.accepted_claim_request->'claim'->'normalizedValue'
      or v_claim.confidence is distinct from
        (v_decision.accepted_claim_request->'claim'->>'confidence')::numeric
      or v_claim.confidence_label is distinct from
        v_decision.accepted_claim_request->'claim'->>'confidenceLabel'
      or v_claim.extraction_method is distinct from
        v_decision.accepted_claim_request->'claim'->>'extractionMethod'
      or v_claim.extractor_version is distinct from
        v_decision.accepted_claim_request->'claim'->>'extractorVersion'
      or v_claim.prompt_version is distinct from
        v_decision.accepted_claim_request->'claim'->>'promptVersion'
      or v_claim.model is distinct from
        v_decision.accepted_claim_request->'claim'->>'model'
      or v_claim.acceptance_method is distinct from v_decision.decision_method
      or v_claim.acceptance_policy_version is distinct from v_decision.policy_version
      or v_claim.accepted_by is distinct from v_decision.decided_by
      or v_claim.decision <> 'accepted'
      or v_claim.evidence_span is distinct from
        v_decision.accepted_claim_request->'claim'->'evidenceSpan'
      or v_claim.schema_version is distinct from
        v_decision.accepted_claim_request->'claim'->>'schemaVersion'
      or (
        select count(*)
        from public.accepted_claim_evidence evidence
        where evidence.claim_version_id = v_claim.claim_version_id
          and evidence.observation_id = v_candidate.source_observation_id
          and evidence.evidence_role = 'primary'
          and evidence.evidence_span =
            v_decision.accepted_claim_request->'claim'->'evidenceSpan'
      ) <> 1
      or (
        select count(*) from public.accepted_claim_evidence evidence
        where evidence.claim_version_id = v_claim.claim_version_id
      ) <> 1
      or (
        select count(*) from public.claim_supersessions supersession
        where supersession.resolving_claim_version_id = v_claim.claim_version_id
      ) <> jsonb_array_length(v_decision.accepted_claim_request->'supersessions')
      or exists (
        select 1
        from jsonb_array_elements(
          v_decision.accepted_claim_request->'supersessions'
        ) expected
        left join public.claim_supersessions actual
          on actual.resolving_claim_version_id = v_claim.claim_version_id
         and actual.superseded_claim_version_id =
           expected->>'supersededClaimVersionId'
         and actual.relationship = expected->>'relationship'
         and actual.policy_version = expected->>'policyVersion'
        where actual.resolving_claim_version_id is null
      ) then
      raise exception 'late-model review acceptance binding is not exact'
        using errcode = '23514';
    end if;
  else
    if v_decision.accepted_claim_request is not null
      or v_resolution.accepted_kind <> ''
      or v_resolution.accepted_item_id <> ''
      or v_resolution.accepted_item_hash <> ''
      or v_resolution.binding_id <> ''
      or v_resolution.binding_item_hash <> ''
      or exists (
        select 1 from public.candidate_claim_acceptance_bindings binding
        where binding.candidate_claim_version_id = p_candidate_claim_version_id
          or binding.decision_version_id = v_decision.decision_version_id
      ) then
      raise exception 'late-model reviewed rejection has acceptance artifacts'
        using errcode = '23514';
    end if;
  end if;

  if exists (
    select 1
    from public.truth_shadow_claim_acceptance_epoch_items item
    where item.candidate_claim_version_id = p_candidate_claim_version_id
      or (
        v_resolution.accepted_item_id <> ''
        and item.accepted_claim_version_id = v_resolution.accepted_item_id
      )
  ) or exists (
    select 1
    from public.truth_shadow_late_model_acceptance_items item
    where item.candidate_claim_version_id = p_candidate_claim_version_id
      or (
        v_resolution.accepted_item_id <> ''
        and item.accepted_claim_version_id = v_resolution.accepted_item_id
      )
  ) then
    raise exception 'late-model review decision is already certified'
      using errcode = '23505';
  end if;

  v_authority := jsonb_build_object(
    'schemaVersion', 'truth-shadow-late-model-review-adoption-v1',
    'workspaceKey', p_workspace_key,
    'authorizationId', p_authorization_id,
    'sourceJobId', p_source_job_id,
    'candidateClaimVersionId', p_candidate_claim_version_id,
    'candidateItemHash', p_candidate_item_hash,
    'decisionAuthorityKind', 'truth_review_resolution',
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'decision', v_decision.decision,
    'decisionMethod', v_decision.decision_method,
    'policyVersion', v_decision.policy_version,
    'decidedBy', v_decision.decided_by,
    'reasonCodes', v_decision.reasons,
    'decisionAuthoredAt', private.canonical_truth_timestamp(v_decision.created_at),
    'reviewResolutionId', v_resolution.review_resolution_id,
    'reviewRequestHash', v_resolution.request_hash,
    'reviewReceiptHash', v_resolution.receipt_hash,
    'reviewResolvedAt', private.canonical_truth_timestamp(v_resolution.created_at),
    'acceptedClaimVersionId', v_resolution.accepted_item_id,
    'acceptedClaimItemHash', v_resolution.accepted_item_hash,
    'bindingId', v_resolution.binding_id,
    'bindingItemHash', v_resolution.binding_item_hash
  );
  v_authority_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_authority), 'UTF8'
  ), 'sha256'), 'hex');
  return jsonb_build_object(
    'status', 'adopted',
    'authority', v_authority,
    'authorityHash', v_authority_hash,
    'decision', v_decision.decision,
    'reasonCodes', v_decision.reasons,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'decisionAuthoredAt', private.canonical_truth_timestamp(v_decision.created_at),
    'reviewResolutionId', v_resolution.review_resolution_id,
    'reviewRequestHash', v_resolution.request_hash,
    'reviewReceiptHash', v_resolution.receipt_hash,
    'reviewResolvedAt', private.canonical_truth_timestamp(v_resolution.created_at),
    'acceptedClaimVersionId', v_resolution.accepted_item_id,
    'acceptedClaimItemHash', v_resolution.accepted_item_hash,
    'bindingId', v_resolution.binding_id,
    'bindingItemHash', v_resolution.binding_item_hash
  );
end;
$function$;

revoke all on function private.truth_shadow_late_model_review_adoption_v1(
  text,text,uuid,text,text
) from public, anon, authenticated, service_role;

create or replace function private.run_truth_shadow_late_model_acceptance(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_epoch public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_existing public.truth_shadow_late_model_acceptance_runs%rowtype;
  v_authorization record;
  v_job public.source_processing_jobs%rowtype;
  v_result public.gmail_model_extraction_results%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_intent public.gmail_model_extraction_review_intents%rowtype;
  v_obligation public.gmail_model_extraction_review_obligations%rowtype;
  v_resolution public.gmail_model_extraction_review_resolutions%rowtype;
  v_review_job public.source_processing_jobs%rowtype;
  v_candidate record;
  v_adoption jsonb;
  v_authorization_manifest jsonb;
  v_authorization_manifest_hash text;
  v_terminal_manifest jsonb := '[]'::jsonb;
  v_terminal_manifest_hash text;
  v_decision_manifest jsonb := '[]'::jsonb;
  v_decision_manifest_hash text;
  v_receipt jsonb;
  v_receipt_hash text;
  v_run_id text;
  v_item jsonb;
  v_item_hash text;
  v_authorization_count integer;
  v_epoch_count integer;
  v_open_count integer;
  v_pending_review_count integer;
  v_pending_candidate_count integer;
  v_success_count integer := 0;
  v_review_count integer := 0;
  v_candidate_count integer := 0;
  v_accepted_count integer := 0;
  v_rejected_count integer := 0;
  v_ordinal integer := 0;
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid late-model acceptance authority'
      using errcode = '28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_connection_key is distinct from
      'shadow-current-awbs-20260710-c475a8ca'
    or p_root_batch_id is distinct from
      'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid then
    raise exception 'late-model acceptance is outside its exact shadow scope'
      using errcode = '42501';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:' || p_workspace_key, 0
  )) then
    return jsonb_build_object(
      'ok', true,
      'status', 'busy',
      'retryable', true,
      'shadowOnly', true,
      'productionPublicationAttempted', false,
      'publishesTruth', false
    );
  end if;

  select count(*)::integer, count(distinct authority.predecessor_epoch_id)::integer
  into v_authorization_count, v_epoch_count
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = p_workspace_key
    and authority.connection_key = p_connection_key
    and authority.root_batch_id = p_root_batch_id;
  if v_authorization_count <> 10 or v_epoch_count <> 1 then
    raise exception 'late-model acceptance does not have its exact ten-row authority'
      using errcode = '23514';
  end if;

  select epoch.* into strict v_epoch
  from public.truth_shadow_claim_acceptance_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.epoch_id = (
      select min(authority.predecessor_epoch_id)
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
    );
  if v_epoch.source_system <> 'gmail'
    or v_epoch.connection_key is distinct from p_connection_key
    or v_epoch.root_batch_id is distinct from p_root_batch_id
    or v_epoch.receipt_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_epoch.canonical_receipt), 'UTF8'
    ), 'sha256'), 'hex')
    or v_epoch.schema_version <> 'truth-shadow-claim-acceptance-epoch-v2'
    or v_epoch.production_publication_attempted <> false
    or exists (
      select 1
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
        and (
          authority.predecessor_epoch_id is distinct from v_epoch.epoch_id
          or authority.predecessor_epoch_receipt_hash is distinct from
            v_epoch.receipt_hash
          or authority.source_cursor_version is distinct from
            v_epoch.source_cursor_version
          or authority.source_cursor_value is distinct from
            v_epoch.source_cursor_value
          or authority.shadow_only <> true
          or authority.mutates_operational_state <> false
          or authority.production_eligible <> false
          or authority.production_publication_attempted <> false
        )
    ) then
    raise exception 'late-model predecessor epoch or authorization chain is invalid'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.truth_shadow_late_model_acceptance_runs run
  where run.workspace_key = p_workspace_key
    and run.connection_key = p_connection_key
    and run.root_batch_id = p_root_batch_id
    and run.predecessor_epoch_id = v_epoch.epoch_id;
  if found then
    if v_existing.receipt_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_existing.canonical_receipt), 'UTF8'
    ), 'sha256'), 'hex')
      or v_existing.production_publication_attempted <> false then
      raise exception 'late-model acceptance replay receipt is corrupt'
        using errcode = '23514';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'status', 'succeeded',
      'lateAcceptanceId', v_existing.run_id,
      'lateAcceptanceReceiptHash', v_existing.receipt_hash,
      'predecessorEpochId', v_existing.predecessor_epoch_id,
      'publicationChannel', 'shadow',
      'shadowOnly', true,
      'productionPublicationAttempted', false,
      'publishesTruth', false
    );
  end if;

  select count(*)::integer into v_open_count
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.source_processing_jobs child
    on child.workspace_key = authority.workspace_key
   and child.job_id = authority.model_child_job_id
  where authority.workspace_key = p_workspace_key
    and authority.connection_key = p_connection_key
    and authority.root_batch_id = p_root_batch_id
    and (
      child.state <> 'succeeded'
      or child.completed_at is null
      or child.lease_owner is not null
      or child.lease_expires_at is not null
    );
  if v_open_count > 0 then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready',
      'reason', 'LATE_MODEL_CHILD_FRONTIER_OPEN',
      'openChildCount', v_open_count,
      'predecessorEpochId', v_epoch.epoch_id,
      'shadowOnly', true,
      'productionPublicationAttempted', false,
      'publishesTruth', false
    );
  end if;

  -- Review terminals are complete only after a human resolution exists.  A
  -- successful model result is mutually exclusive with that review chain.
  select count(*)::integer into v_pending_review_count
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.source_processing_jobs child
    on child.workspace_key = authority.workspace_key
   and child.job_id = authority.model_child_job_id
  left join public.gmail_model_extraction_results model_result
    on model_result.workspace_key = authority.workspace_key
   and model_result.model_child_job_id = authority.model_child_job_id
  left join public.gmail_model_extraction_review_intents intent
    on intent.workspace_key = authority.workspace_key
   and intent.model_child_job_id = authority.model_child_job_id
  left join public.gmail_model_extraction_review_obligations obligation
    on obligation.workspace_key = authority.workspace_key
   and obligation.model_child_job_id = authority.model_child_job_id
  left join public.gmail_model_extraction_review_resolutions resolution
    on resolution.workspace_key = authority.workspace_key
   and resolution.obligation_id = obligation.obligation_id
  left join public.source_processing_jobs review_job
    on review_job.workspace_key = authority.workspace_key
   and review_job.job_id = obligation.review_job_id
  where authority.workspace_key = p_workspace_key
    and authority.connection_key = p_connection_key
    and authority.root_batch_id = p_root_batch_id
    and (
      (model_result.result_id is null and (
        intent.intent_id is null
        or obligation.obligation_id is null
        or resolution.resolution_id is null
        or review_job.state is distinct from 'succeeded'
      ))
      or (model_result.result_id is not null and (
        intent.intent_id is not null
        or obligation.obligation_id is not null
        or resolution.resolution_id is not null
      ))
    );
  if v_pending_review_count > 0 then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready',
      'reason', 'LATE_MODEL_REVIEW_FRONTIER_OPEN',
      'pendingReviewCount', v_pending_review_count,
      'predecessorEpochId', v_epoch.epoch_id,
      'shadowOnly', true,
      'productionPublicationAttempted', false,
      'publishesTruth', false
    );
  end if;

  select count(*)::integer into v_pending_candidate_count
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.gmail_model_extraction_results model_result
    on model_result.workspace_key = authority.workspace_key
   and model_result.model_child_job_id = authority.model_child_job_id
  join public.candidate_claim_job_manifests manifest
    on manifest.workspace_key = authority.workspace_key
   and manifest.job_id = authority.model_child_job_id
   and manifest.manifest_hash = model_result.candidate_manifest_hash
  join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
    on true
  left join public.truth_review_resolutions resolution
    on resolution.workspace_key = authority.workspace_key
   and resolution.target_kind = 'candidate_claim'
   and resolution.target_id = item->>'candidateClaimVersionId'
   and resolution.target_item_hash = item->>'itemHash'
  where authority.workspace_key = p_workspace_key
    and authority.connection_key = p_connection_key
    and authority.root_batch_id = p_root_batch_id
    and resolution.review_resolution_id is null;
  if v_pending_candidate_count > 0 then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready',
      'reason', 'LATE_MODEL_CANDIDATE_REVIEW_PENDING',
      'pendingCandidateCount', v_pending_candidate_count,
      'predecessorEpochId', v_epoch.epoch_id,
      'shadowOnly', true,
      'productionPublicationAttempted', false,
      'publishesTruth', false
    );
  end if;

  -- Fail before creating the immutable run if any source actually used by the
  -- late terminal/review path escapes the predecessor Gmail connection or its
  -- cursor.  The later cut binding proves physical inclusion; this check
  -- prevents an irreversible receipt that no exact cut could ever bind.
  if exists (
    with required_observation(observation_id, expected_content_hash) as (
      select authority.source_observation_id,
             authority.source_observation_content_hash
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
      union
      select member.observation_id, member.observation_content_hash
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = authority.workspace_key
       and plan.model_plan_id = authority.model_plan_id
       and plan.parent_job_id = authority.parent_job_id
      join public.gmail_model_context_observations member
        on member.workspace_key = plan.workspace_key
       and member.context_seal_id = plan.context_seal_id
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
      union
      select evidence.observation_id, null::text
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = authority.workspace_key
       and plan.model_plan_id = authority.model_plan_id
       and plan.parent_job_id = authority.parent_job_id
      join public.gmail_model_context_accepted_claims member
        on member.workspace_key = plan.workspace_key
       and member.context_seal_id = plan.context_seal_id
      join public.accepted_claim_evidence evidence
        on evidence.claim_version_id = member.claim_version_id
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
      union
      select evidence.observation_id, null::text
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = authority.workspace_key
       and plan.model_plan_id = authority.model_plan_id
       and plan.parent_job_id = authority.parent_job_id
      join public.gmail_model_context_workgroup_memberships member
        on member.workspace_key = plan.workspace_key
       and member.context_seal_id = plan.context_seal_id
      join public.operational_workgroup_membership_evidence evidence
        on evidence.membership_version_id = member.membership_version_id
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
      union
      select membership.observation_id, null::text
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = authority.workspace_key
       and plan.model_plan_id = authority.model_plan_id
       and plan.parent_job_id = authority.parent_job_id
      join public.gmail_model_context_workgroup_memberships member
        on member.workspace_key = plan.workspace_key
       and member.context_seal_id = plan.context_seal_id
      join public.operational_workgroup_memberships membership
        on membership.membership_version_id = member.membership_version_id
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
        and membership.observation_id is not null
      union
      select membership.basis_observation_id, null::text
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.gmail_model_extraction_plans plan
        on plan.workspace_key = authority.workspace_key
       and plan.model_plan_id = authority.model_plan_id
       and plan.parent_job_id = authority.parent_job_id
      join public.gmail_model_context_workgroup_memberships member
        on member.workspace_key = plan.workspace_key
       and member.context_seal_id = plan.context_seal_id
      join public.operational_workgroup_memberships membership
        on membership.membership_version_id = member.membership_version_id
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
        and membership.basis_observation_id is not null
      union
      select evidence_id.observation_id, null::text
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.gmail_model_extraction_review_obligations obligation
        on obligation.workspace_key = authority.workspace_key
       and obligation.model_child_job_id = authority.model_child_job_id
      join public.gmail_model_extraction_review_resolutions resolution
        on resolution.workspace_key = obligation.workspace_key
       and resolution.obligation_id = obligation.obligation_id
      join lateral jsonb_array_elements_text(
        resolution.resolution_evidence_observation_ids
      ) evidence_id(observation_id) on true
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
      union
      select evidence.observation_id, null::text
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      join public.candidate_claim_job_lineage lineage
        on lineage.job_id = authority.model_child_job_id
      join public.candidate_claim_acceptance_bindings binding
        on binding.candidate_claim_version_id =
          lineage.candidate_claim_version_id
      join public.accepted_claim_evidence evidence
        on evidence.claim_version_id = binding.accepted_claim_version_id
      where authority.workspace_key = p_workspace_key
        and authority.connection_key = p_connection_key
        and authority.root_batch_id = p_root_batch_id
    )
    select 1
    from required_observation required
    left join public.source_observations observation
      on observation.workspace_key = p_workspace_key
     and observation.observation_id = required.observation_id
    where observation.observation_id is null
       or (
         required.expected_content_hash is not null
         and observation.content_hash is distinct from
           required.expected_content_hash
       )
       or observation.source_system <> v_epoch.source_system
       or observation.connection_key <> v_epoch.connection_key
       or observation.source_cursor_version > v_epoch.source_cursor_version
  ) then
    raise exception 'late-model terminal evidence escapes predecessor source scope'
      using errcode = '23514';
  end if;

  select jsonb_agg(jsonb_build_object(
    'authorizationId', authority.authorization_id,
    'authorizationHash', authority.authorization_hash,
    'parentJobId', authority.parent_job_id,
    'modelChildJobId', authority.model_child_job_id,
    'sourceObservationId', authority.source_observation_id,
    'sourceObservationContentHash', authority.source_observation_content_hash,
    'modelPlanId', authority.model_plan_id,
    'modelPlanHash', authority.model_plan_hash,
    'disposition', authority.disposition
  ) order by authority.authorization_id)
  into v_authorization_manifest
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = p_workspace_key
    and authority.connection_key = p_connection_key
    and authority.root_batch_id = p_root_batch_id;
  v_authorization_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_authorization_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  for v_authorization in
    select authority.*
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key = p_workspace_key
      and authority.connection_key = p_connection_key
      and authority.root_batch_id = p_root_batch_id
    order by authority.authorization_id
  loop
    select * into strict v_job
    from public.source_processing_jobs child
    where child.workspace_key = p_workspace_key
      and child.job_id = v_authorization.model_child_job_id;
    if v_job.source_system <> 'gmail'
      or v_job.connection_key is distinct from p_connection_key
      or v_job.job_kind <> 'gmail_extract_message_model_claims'
      or v_job.state <> 'succeeded'
      or v_job.completed_at is null
      or v_job.lease_owner is not null
      or v_job.lease_expires_at is not null
      or v_job.observation_id is distinct from v_authorization.source_observation_id
      or v_job.payload->>'modelPlanId' is distinct from v_authorization.model_plan_id
      or v_job.result->>'schemaVersion' <>
        'truth-model-extraction-worker-result-v1'
      or v_job.result->>'modelPlanId' is distinct from v_authorization.model_plan_id
      or v_job.result->>'sourceObservationId' is distinct from
        v_authorization.source_observation_id then
      raise exception 'late-model child terminal differs from its authorization'
        using errcode = '23514';
    end if;

    select * into v_result
    from public.gmail_model_extraction_results result
    where result.workspace_key = p_workspace_key
      and result.model_child_job_id = v_authorization.model_child_job_id;
    if found then
      if v_authorization.disposition <> 'model_execution'
        or v_result.model_plan_id is distinct from v_authorization.model_plan_id
        or v_result.result_hash is distinct from encode(extensions.digest(
          convert_to(v_result.canonical_result::text, 'UTF8'), 'sha256'
        ), 'hex')
        or v_result.result_id is distinct from
          'gmail-model-result:v1:' || v_result.result_hash
        or v_job.result->>'outcome' <> 'succeeded'
        or v_job.result #>> '{modelTerminal,terminalKind}' <> 'successful_result'
        or v_job.result #>> '{modelTerminal,resultId}' is distinct from v_result.result_id
        or v_job.result #>> '{modelTerminal,resultHash}' is distinct from v_result.result_hash
        or v_job.result #>> '{modelTerminal,candidateManifestHash}' is distinct from
          v_result.candidate_manifest_hash
        or (v_job.result #>> '{modelTerminal,candidateCount}')::integer is distinct from
          v_result.candidate_count then
        raise exception 'late-model successful terminal proof is invalid'
          using errcode = '23514';
      end if;
      select * into strict v_manifest
      from public.candidate_claim_job_manifests manifest
      where manifest.workspace_key = p_workspace_key
        and manifest.job_id = v_authorization.model_child_job_id
        and manifest.source_observation_id = v_authorization.source_observation_id
        and manifest.manifest_hash = v_result.candidate_manifest_hash;
      if v_manifest.candidate_count is distinct from v_result.candidate_count
        or v_manifest.manifest_schema_version <> 'candidate-claim-job-manifest-v1'
        or v_manifest.manifest_hash is distinct from encode(extensions.digest(
          convert_to(v_manifest.canonical_manifest::text, 'UTF8'), 'sha256'
        ), 'hex')
        or v_manifest.canonical_manifest->>'workspaceKey' is distinct from p_workspace_key
        or v_manifest.canonical_manifest->>'jobId' is distinct from
          v_authorization.model_child_job_id::text
        or v_manifest.canonical_manifest->>'sourceObservationId' is distinct from
          v_authorization.source_observation_id
        or jsonb_array_length(v_manifest.canonical_manifest->'candidates') is distinct from
          v_manifest.candidate_count then
        raise exception 'late-model candidate manifest proof is invalid'
          using errcode = '23514';
      end if;

      v_terminal_manifest := v_terminal_manifest || jsonb_build_array(
        jsonb_build_object(
          'authorizationId', v_authorization.authorization_id,
          'modelChildJobId', v_authorization.model_child_job_id,
          'terminalKind', 'successful_result',
          'completedAt', private.canonical_truth_timestamp(v_job.completed_at),
          'resultId', v_result.result_id,
          'resultHash', v_result.result_hash,
          'modelRequestId', v_result.model_request_id,
          'modelAttemptOutcomeId', v_result.model_attempt_outcome_id,
          'providerResultHash', v_result.provider_result_hash,
          'normalizedResultHash', v_result.normalized_result_hash,
          'candidateManifestHash', v_result.candidate_manifest_hash,
          'candidateCount', v_result.candidate_count
        )
      );
      v_success_count := v_success_count + 1;

      for v_candidate in
        select item->>'candidateClaimVersionId' as candidate_claim_version_id,
               item->>'itemHash' as candidate_item_hash
        from jsonb_array_elements(v_manifest.canonical_manifest->'candidates') item
        order by item->>'candidateClaimVersionId'
      loop
        v_adoption := private.truth_shadow_late_model_review_adoption_v1(
          p_workspace_key,
          v_authorization.authorization_id,
          v_authorization.model_child_job_id,
          v_candidate.candidate_claim_version_id,
          v_candidate.candidate_item_hash
        );
        if v_adoption->>'status' <> 'adopted' then
          raise exception 'late-model candidate review changed during acceptance'
            using errcode = '40001';
        end if;
        v_decision_manifest := v_decision_manifest || jsonb_build_array(
          jsonb_build_object(
            'authorizationId', v_authorization.authorization_id,
            'modelChildJobId', v_authorization.model_child_job_id,
            'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
            'candidateItemHash', v_candidate.candidate_item_hash,
            'decisionAuthorityKind', 'truth_review_resolution',
            'decisionAuthority', v_adoption->'authority',
            'decisionAuthorityHash', v_adoption->>'authorityHash',
            'decision', v_adoption->>'decision',
            'decisionVersionId', v_adoption->>'decisionVersionId',
            'decisionItemHash', v_adoption->>'decisionItemHash',
            'reviewResolutionId', v_adoption->>'reviewResolutionId',
            'reviewRequestHash', v_adoption->>'reviewRequestHash',
            'reviewReceiptHash', v_adoption->>'reviewReceiptHash',
            'acceptedClaimVersionId', v_adoption->>'acceptedClaimVersionId',
            'acceptedClaimItemHash', v_adoption->>'acceptedClaimItemHash',
            'bindingId', v_adoption->>'bindingId',
            'bindingItemHash', v_adoption->>'bindingItemHash'
          )
        );
        v_candidate_count := v_candidate_count + 1;
        if v_adoption->>'decision' = 'accept' then
          v_accepted_count := v_accepted_count + 1;
        else
          v_rejected_count := v_rejected_count + 1;
        end if;
      end loop;
    else
      select * into strict v_intent
      from public.gmail_model_extraction_review_intents intent
      where intent.workspace_key = p_workspace_key
        and intent.model_child_job_id = v_authorization.model_child_job_id
        and intent.model_plan_id = v_authorization.model_plan_id;
      select * into strict v_obligation
      from public.gmail_model_extraction_review_obligations obligation
      where obligation.workspace_key = p_workspace_key
        and obligation.model_child_job_id = v_authorization.model_child_job_id
        and obligation.model_plan_id = v_authorization.model_plan_id;
      select * into strict v_resolution
      from public.gmail_model_extraction_review_resolutions resolution
      where resolution.workspace_key = p_workspace_key
        and resolution.obligation_id = v_obligation.obligation_id;
      select * into strict v_review_job
      from public.source_processing_jobs review_job
      where review_job.workspace_key = p_workspace_key
        and review_job.job_id = v_obligation.review_job_id;
      if v_intent.intent_hash is distinct from encode(extensions.digest(
          convert_to(v_intent.canonical_intent::text, 'UTF8'), 'sha256'
        ), 'hex')
        or v_intent.intent_id is distinct from
          'gmail-model-review-intent:v1:' || v_intent.intent_hash
        or v_obligation.obligation_hash is distinct from encode(extensions.digest(
          convert_to(v_obligation.canonical_obligation::text, 'UTF8'), 'sha256'
        ), 'hex')
        or v_obligation.obligation_id is distinct from
          'gmail-model-review:v1:' || v_obligation.obligation_hash
        or v_resolution.request_hash is distinct from encode(extensions.digest(
          convert_to(v_resolution.canonical_request::text, 'UTF8'), 'sha256'
        ), 'hex')
        or v_resolution.receipt_hash is distinct from encode(extensions.digest(
          convert_to(v_resolution.canonical_receipt::text, 'UTF8'), 'sha256'
        ), 'hex')
        or v_resolution.resolution_id is distinct from
          'gmail-model-review-resolution:v1:' || v_resolution.request_hash
        or v_review_job.job_kind <> 'gmail_review_model_extraction'
        or v_review_job.state <> 'succeeded'
        or v_review_job.completed_at is null
        or v_review_job.result->>'schemaVersion' <> 'gmail-model-review-job-result-v1'
        or v_review_job.result->>'resolutionId' is distinct from v_resolution.resolution_id
        or v_review_job.result->>'receiptHash' is distinct from v_resolution.receipt_hash
        or v_job.result->>'outcome' <> 'review_required'
        or v_job.result #>> '{modelTerminal,terminalKind}' <> 'review_intent'
        or v_job.result #>> '{modelTerminal,reviewIntentId}' is distinct from
          v_intent.intent_id
        or v_job.result #>> '{modelTerminal,reviewIntentHash}' is distinct from
          v_intent.intent_hash
        or (v_authorization.disposition = 'stale_time_binding_review' and (
          v_intent.authority_kind <> 'shadow_stale_source_time_binding_authority'
          or v_intent.authority_id is distinct from v_authorization.authorization_id
          or v_intent.authority_hash is distinct from v_authorization.authorization_hash
          or v_intent.reason_code <> 'STALE_IMMUTABLE_SOURCE_TIME_BINDING'
        ))
        or exists (
          select 1 from public.candidate_claim_job_manifests manifest
          where manifest.workspace_key = p_workspace_key
            and manifest.job_id = v_authorization.model_child_job_id
        ) then
        raise exception 'late-model review terminal proof is invalid'
          using errcode = '23514';
      end if;
      v_terminal_manifest := v_terminal_manifest || jsonb_build_array(
        jsonb_build_object(
          'authorizationId', v_authorization.authorization_id,
          'modelChildJobId', v_authorization.model_child_job_id,
          'terminalKind', 'review_resolution',
          'completedAt', private.canonical_truth_timestamp(v_job.completed_at),
          'reviewIntentId', v_intent.intent_id,
          'reviewIntentHash', v_intent.intent_hash,
          'reviewReasonCode', v_intent.reason_code,
          'reviewObligationId', v_obligation.obligation_id,
          'reviewObligationHash', v_obligation.obligation_hash,
          'reviewJobId', v_obligation.review_job_id,
          'reviewResolutionId', v_resolution.resolution_id,
          'reviewRequestHash', v_resolution.request_hash,
          'reviewReceiptHash', v_resolution.receipt_hash,
          'reviewDecision', v_resolution.decision,
          'resolutionEvidenceObservationIds',
            v_resolution.resolution_evidence_observation_ids
        )
      );
      v_review_count := v_review_count + 1;
    end if;
  end loop;

  if jsonb_array_length(v_terminal_manifest) <> 10
    or v_success_count + v_review_count <> 10
    or jsonb_array_length(v_decision_manifest) <> v_candidate_count
    or v_candidate_count <> v_accepted_count + v_rejected_count
    or exists (
      select 1 from jsonb_array_elements(v_authorization_manifest) item
      where not private.truth_jsonb_has_only_keys(item, array[
        'authorizationId','authorizationHash','parentJobId','modelChildJobId',
        'sourceObservationId','sourceObservationContentHash','modelPlanId',
        'modelPlanHash','disposition'
      ])
    )
    or exists (
      select 1 from jsonb_array_elements(v_terminal_manifest) item
      where (
        item->>'terminalKind' = 'successful_result'
        and not private.truth_jsonb_has_only_keys(item, array[
          'authorizationId','modelChildJobId','terminalKind','completedAt',
          'resultId','resultHash','modelRequestId','modelAttemptOutcomeId',
          'providerResultHash','normalizedResultHash','candidateManifestHash',
          'candidateCount'
        ])
      ) or (
        item->>'terminalKind' = 'review_resolution'
        and not private.truth_jsonb_has_only_keys(item, array[
          'authorizationId','modelChildJobId','terminalKind','completedAt',
          'reviewIntentId','reviewIntentHash','reviewReasonCode',
          'reviewObligationId','reviewObligationHash','reviewJobId',
          'reviewResolutionId','reviewRequestHash','reviewReceiptHash',
          'reviewDecision','resolutionEvidenceObservationIds'
        ])
      ) or item->>'terminalKind' not in (
        'successful_result', 'review_resolution'
      )
    )
    or exists (
      select 1 from jsonb_array_elements(v_decision_manifest) item
      where not private.truth_jsonb_has_only_keys(item, array[
        'authorizationId','modelChildJobId','candidateClaimVersionId',
        'candidateItemHash','decisionAuthorityKind','decisionAuthority',
        'decisionAuthorityHash','decision','decisionVersionId',
        'decisionItemHash','reviewResolutionId','reviewRequestHash',
        'reviewReceiptHash','acceptedClaimVersionId','acceptedClaimItemHash',
        'bindingId','bindingItemHash'
      ])
    ) then
    raise exception 'late-model acceptance frontier cardinality is inconsistent'
      using errcode = '23514';
  end if;
  v_terminal_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_terminal_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_decision_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_decision_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt := jsonb_build_object(
    'schemaVersion', 'truth-shadow-late-model-acceptance-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', p_connection_key,
    'rootBatchId', p_root_batch_id,
    'sourceCursorVersion', v_epoch.source_cursor_version,
    'sourceCursorValue', v_epoch.source_cursor_value,
    'predecessorEpochId', v_epoch.epoch_id,
    'predecessorEpochReceiptHash', v_epoch.receipt_hash,
    'predecessorFrontierManifestHash', v_epoch.frontier_manifest_hash,
    'predecessorDecisionAuthorityManifestHash',
      v_epoch.decision_authority_manifest_hash,
    'authorizationManifestHash', v_authorization_manifest_hash,
    'terminalManifestHash', v_terminal_manifest_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'authorizationCount', 10,
    'successfulModelChildCount', v_success_count,
    'reviewedModelChildCount', v_review_count,
    'candidateCount', v_candidate_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'decisionAuthorityKind', 'truth_review_resolution',
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'publishesTruth', false,
    'performsActions', false
  );
  v_receipt_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt), 'UTF8'
  ), 'sha256'), 'hex');
  v_run_id := 'truth-shadow-late-model-acceptance:v1:' || v_receipt_hash;

  insert into public.truth_shadow_late_model_acceptance_runs (
    run_id, workspace_key, source_system, connection_key, root_batch_id,
    source_cursor_version, source_cursor_value, predecessor_epoch_id,
    predecessor_epoch_receipt_hash, predecessor_frontier_manifest_hash,
    predecessor_decision_authority_manifest_hash, authorization_manifest,
    authorization_manifest_hash, terminal_manifest, terminal_manifest_hash,
    decision_manifest, decision_manifest_hash, authorization_count,
    successful_model_child_count, reviewed_model_child_count, candidate_count,
    accepted_count, rejected_count, canonical_receipt, receipt_hash,
    schema_version, shadow_only, mutates_operational_state,
    production_eligible, production_publication_attempted
  ) values (
    v_run_id, p_workspace_key, 'gmail', p_connection_key, p_root_batch_id,
    v_epoch.source_cursor_version, v_epoch.source_cursor_value,
    v_epoch.epoch_id, v_epoch.receipt_hash, v_epoch.frontier_manifest_hash,
    v_epoch.decision_authority_manifest_hash, v_authorization_manifest,
    v_authorization_manifest_hash, v_terminal_manifest,
    v_terminal_manifest_hash, v_decision_manifest,
    v_decision_manifest_hash, 10, v_success_count, v_review_count,
    v_candidate_count, v_accepted_count, v_rejected_count, v_receipt,
    v_receipt_hash, 'truth-shadow-late-model-acceptance-v1',
    true, false, false, false
  );

  for v_candidate in
    select value as decision_item
    from jsonb_array_elements(v_decision_manifest)
  loop
    v_item := jsonb_build_object(
      'schemaVersion', 'truth-shadow-late-model-acceptance-item-v1',
      'runId', v_run_id,
      'workspaceKey', p_workspace_key,
      'ordinal', v_ordinal,
      'authorizationId', v_candidate.decision_item->>'authorizationId',
      'modelChildJobId', v_candidate.decision_item->>'modelChildJobId',
      'candidateClaimVersionId',
        v_candidate.decision_item->>'candidateClaimVersionId',
      'candidateItemHash', v_candidate.decision_item->>'candidateItemHash',
      'decisionAuthorityKind', 'truth_review_resolution',
      'decisionAuthorityHash',
        v_candidate.decision_item->>'decisionAuthorityHash',
      'decision', v_candidate.decision_item->>'decision',
      'decisionVersionId', v_candidate.decision_item->>'decisionVersionId',
      'decisionItemHash', v_candidate.decision_item->>'decisionItemHash',
      'reviewResolutionId', v_candidate.decision_item->>'reviewResolutionId',
      'reviewRequestHash', v_candidate.decision_item->>'reviewRequestHash',
      'reviewReceiptHash', v_candidate.decision_item->>'reviewReceiptHash',
      'acceptedClaimVersionId',
        v_candidate.decision_item->>'acceptedClaimVersionId',
      'acceptedClaimItemHash',
        v_candidate.decision_item->>'acceptedClaimItemHash',
      'bindingId', v_candidate.decision_item->>'bindingId',
      'bindingItemHash', v_candidate.decision_item->>'bindingItemHash'
    );
    v_item_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_item), 'UTF8'
    ), 'sha256'), 'hex');
    insert into public.truth_shadow_late_model_acceptance_items (
      item_id, run_id, workspace_key, ordinal, authorization_id,
      model_child_job_id, candidate_claim_version_id, candidate_item_hash,
      decision_authority_kind, decision_authority_hash,
      decision, decision_version_id, decision_item_hash, review_resolution_id,
      review_request_hash, review_receipt_hash, accepted_claim_version_id,
      accepted_claim_item_hash, binding_id, binding_item_hash,
      canonical_item, item_hash, schema_version
    ) values (
      'truth-shadow-late-model-item:v1:' || v_item_hash,
      v_run_id, p_workspace_key, v_ordinal,
      v_candidate.decision_item->>'authorizationId',
      (v_candidate.decision_item->>'modelChildJobId')::uuid,
      v_candidate.decision_item->>'candidateClaimVersionId',
      v_candidate.decision_item->>'candidateItemHash',
      'truth_review_resolution',
      v_candidate.decision_item->>'decisionAuthorityHash',
      v_candidate.decision_item->>'decision',
      v_candidate.decision_item->>'decisionVersionId',
      v_candidate.decision_item->>'decisionItemHash',
      v_candidate.decision_item->>'reviewResolutionId',
      v_candidate.decision_item->>'reviewRequestHash',
      v_candidate.decision_item->>'reviewReceiptHash',
      nullif(v_candidate.decision_item->>'acceptedClaimVersionId', ''),
      v_candidate.decision_item->>'acceptedClaimItemHash',
      nullif(v_candidate.decision_item->>'bindingId', ''),
      v_candidate.decision_item->>'bindingItemHash',
      v_item, v_item_hash, 'truth-shadow-late-model-acceptance-item-v1'
    );
    v_ordinal := v_ordinal + 1;
  end loop;

  return v_receipt || jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', 'succeeded',
    'lateAcceptanceId', v_run_id,
    'lateAcceptanceReceiptHash', v_receipt_hash,
    'predecessorEpochId', v_epoch.epoch_id,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionPublicationAttempted', false,
    'publishesTruth', false
  );
end;
$function$;

create or replace function public.run_truth_shadow_late_model_acceptance(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set lock_timeout = '30s'
set statement_timeout = '300s'
as $function$
  select private.run_truth_shadow_late_model_acceptance(
    p_workspace_key, p_connection_key, p_root_batch_id,
    p_review_token, p_sync_token
  );
$function$;

revoke all on function private.run_truth_shadow_late_model_acceptance(
  text,text,uuid,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.run_truth_shadow_late_model_acceptance(
  text,text,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.run_truth_shadow_late_model_acceptance(
  text,text,uuid,text,text
) to service_role;

create or replace function private.bind_truth_shadow_late_model_source_cut_v1(
  p_source_cut_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cut public.source_cuts%rowtype;
  v_cursor public.source_cut_cursors%rowtype;
  v_scope public.truth_shadow_root_source_cuts%rowtype;
  v_run public.truth_shadow_late_model_acceptance_runs%rowtype;
  v_existing public.truth_shadow_late_model_source_cut_bindings%rowtype;
  v_authorization_count integer;
  v_binding jsonb;
  v_binding_hash text;
begin
  select * into strict v_cut
  from public.source_cuts cut
  where cut.source_cut_id = p_source_cut_id;
  select * into v_cursor
  from public.source_cut_cursors cursor_row
  where cursor_row.source_cut_id = p_source_cut_id
    and cursor_row.source_system = 'gmail'
    and cursor_row.connection_key like 'shadow-%';
  if not found then
    return jsonb_build_object(
      'ok', true, 'status', 'not_applicable',
      'productionPublicationAttempted', false
    );
  end if;

  select * into strict v_scope
  from public.truth_shadow_root_source_cuts scope_row
  where scope_row.workspace_key = v_cut.workspace_key
    and scope_row.source_cut_id = p_source_cut_id
    and scope_row.source_system = 'gmail'
    and scope_row.connection_key = v_cursor.connection_key;
  select count(*)::integer into v_authorization_count
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  where authority.workspace_key = v_cut.workspace_key
    and authority.connection_key = v_cursor.connection_key
    and authority.root_batch_id = v_scope.root_batch_id;
  if v_authorization_count = 0 then
    return jsonb_build_object(
      'ok', true, 'status', 'not_applicable',
      'productionPublicationAttempted', false
    );
  end if;
  if v_authorization_count <> 10 then
    raise exception 'late-model cut scope has a partial authorization frontier'
      using errcode = '23514';
  end if;
  if v_cut.completeness <> 'complete' then
    return jsonb_build_object(
      'ok', true, 'status', 'degraded_unbound',
      'productionPublicationAttempted', false
    );
  end if;

  select * into v_run
  from public.truth_shadow_late_model_acceptance_runs run
  where run.workspace_key = v_cut.workspace_key
    and run.connection_key = v_cursor.connection_key
    and run.root_batch_id = v_scope.root_batch_id
    and run.source_cursor_version = v_cursor.through_cursor_version
    and run.source_cursor_value = v_cursor.through_cursor_value;
  if not found then
    raise exception 'fresh shadow source cut requires completed late-model acceptance'
      using errcode = '55000';
  end if;
  if v_cut.sealed_at < v_run.created_at
    or v_cut.manifest_hash is distinct from encode(extensions.digest(
      convert_to(v_cut.manifest::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_cut.source_cut_id is distinct from 'cut:v1:' || v_cut.manifest_hash
    or v_scope.source_cut_manifest_hash is distinct from v_cut.manifest_hash
    or v_scope.scope_receipt_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_scope.canonical_scope_receipt), 'UTF8'
    ), 'sha256'), 'hex')
    or not (v_scope.acceptance_epoch_manifest @> jsonb_build_array(
      jsonb_build_object(
        'epochId', v_run.predecessor_epoch_id,
        'epochReceiptHash', v_run.predecessor_epoch_receipt_hash
      )
    ))
    or v_run.receipt_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_run.canonical_receipt), 'UTF8'
    ), 'sha256'), 'hex')
    or v_run.production_publication_attempted <> false then
    raise exception 'fresh source cut is not an exact descendant of late-model acceptance'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    left join public.source_observations observation
      on observation.workspace_key = authority.workspace_key
     and observation.observation_id = authority.source_observation_id
     and observation.content_hash = authority.source_observation_content_hash
    where authority.workspace_key = v_run.workspace_key
      and authority.connection_key = v_run.connection_key
      and authority.root_batch_id = v_run.root_batch_id
      and (
        observation.observation_id is null
        or not private.source_observation_within_cut(
          v_run.workspace_key, v_cut.source_cut_id,
          authority.source_observation_id,
          authority.source_observation_content_hash
        )
      )
  ) then
    raise exception 'fresh source cut omits a late-model source observation'
      using errcode = '23514';
  end if;

  -- The source message is only one component of the immutable input. Bind the
  -- complete context seal too: every observation, accepted claim, and
  -- workgroup membership supplied to a late provider call must replay to the
  -- same membership hashes and must be wholly evidenced inside this cut.
  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = authority.workspace_key
     and plan.model_plan_id = authority.model_plan_id
     and plan.parent_job_id = authority.parent_job_id
    join public.gmail_model_extraction_context_seals context_seal
      on context_seal.workspace_key = plan.workspace_key
     and context_seal.context_seal_id = plan.context_seal_id
     and context_seal.parent_job_id = plan.parent_job_id
    cross join lateral (
      select count(*)::integer as member_count,
             coalesce(jsonb_agg(jsonb_build_object(
               'observationId', member.observation_id,
               'contentHash', member.observation_content_hash
             ) order by member.ordinal), '[]'::jsonb) as manifest
      from public.gmail_model_context_observations member
      where member.workspace_key = context_seal.workspace_key
        and member.context_seal_id = context_seal.context_seal_id
    ) context_observations
    cross join lateral (
      select count(*)::integer as member_count,
             coalesce(jsonb_agg(jsonb_build_object(
               'claimVersionId', member.claim_version_id,
               'itemHash', member.claim_item_hash
             ) order by member.ordinal), '[]'::jsonb) as manifest
      from public.gmail_model_context_accepted_claims member
      where member.workspace_key = context_seal.workspace_key
        and member.context_seal_id = context_seal.context_seal_id
    ) context_claims
    cross join lateral (
      select count(*)::integer as member_count,
             coalesce(jsonb_agg(jsonb_build_object(
               'membershipVersionId', member.membership_version_id,
               'itemHash', member.membership_item_hash
             ) order by member.ordinal), '[]'::jsonb) as manifest
      from public.gmail_model_context_workgroup_memberships member
      where member.workspace_key = context_seal.workspace_key
        and member.context_seal_id = context_seal.context_seal_id
    ) context_memberships
    where authority.workspace_key = v_run.workspace_key
      and authority.connection_key = v_run.connection_key
      and authority.root_batch_id = v_run.root_batch_id
      and (
        context_observations.member_count <> context_seal.context_observation_count
        or context_claims.member_count <> context_seal.accepted_claim_count
        or context_memberships.member_count <> context_seal.workgroup_membership_count
        or encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(context_observations.manifest),
          'UTF8'
        ), 'sha256'), 'hex') is distinct from
          context_seal.context_observation_membership_hash
        or encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(context_claims.manifest), 'UTF8'
        ), 'sha256'), 'hex') is distinct from
          context_seal.accepted_claim_membership_hash
        or encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(context_memberships.manifest),
          'UTF8'
        ), 'sha256'), 'hex') is distinct from
          context_seal.workgroup_membership_hash
      )
  ) then
    raise exception 'late-model context seal membership failed exact cut replay'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = authority.workspace_key
     and plan.model_plan_id = authority.model_plan_id
     and plan.parent_job_id = authority.parent_job_id
    join public.gmail_model_context_observations member
      on member.workspace_key = plan.workspace_key
     and member.context_seal_id = plan.context_seal_id
    left join public.source_observations observation
      on observation.workspace_key = member.workspace_key
     and observation.observation_id = member.observation_id
     and observation.content_hash = member.observation_content_hash
    where authority.workspace_key = v_run.workspace_key
      and authority.connection_key = v_run.connection_key
      and authority.root_batch_id = v_run.root_batch_id
      and (
        observation.observation_id is null
        or observation.source_system <> v_run.source_system
        or observation.connection_key <> v_run.connection_key
        or observation.source_cursor_version > v_run.source_cursor_version
        or not private.source_observation_within_cut(
          v_run.workspace_key, v_cut.source_cut_id,
          member.observation_id, member.observation_content_hash
        )
      )
  ) then
    raise exception 'fresh source cut omits a sealed late-model context observation'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = authority.workspace_key
     and plan.model_plan_id = authority.model_plan_id
     and plan.parent_job_id = authority.parent_job_id
    join public.gmail_model_context_accepted_claims member
      on member.workspace_key = plan.workspace_key
     and member.context_seal_id = plan.context_seal_id
    left join public.accepted_claim_envelopes envelope
      on envelope.workspace_key = member.workspace_key
     and envelope.claim_version_id = member.claim_version_id
     and envelope.envelope_hash = member.claim_item_hash
    left join public.accepted_claims claim
      on claim.claim_version_id = member.claim_version_id
     and claim.claim_content_hash = member.claim_item_hash
    where authority.workspace_key = v_run.workspace_key
      and authority.connection_key = v_run.connection_key
      and authority.root_batch_id = v_run.root_batch_id
      and (
        envelope.claim_version_id is null
        or claim.claim_version_id is null
        or not private.truth_shadow_claim_visible_to_connection(
          member.claim_version_id, v_run.workspace_key,
          v_run.source_system, v_run.connection_key
        )
        or not exists (
          select 1
          from public.accepted_claim_evidence primary_evidence
          where primary_evidence.claim_version_id = member.claim_version_id
            and primary_evidence.evidence_role = 'primary'
        )
        or exists (
          select 1
          from public.accepted_claim_evidence evidence
          left join public.source_observations observation
            on observation.observation_id = evidence.observation_id
           and observation.workspace_key = v_run.workspace_key
          where evidence.claim_version_id = member.claim_version_id
            and (
              observation.observation_id is null
              or observation.source_system <> v_run.source_system
              or observation.connection_key <> v_run.connection_key
              or observation.source_cursor_version > v_run.source_cursor_version
              or not private.source_observation_within_cut(
                v_run.workspace_key, v_cut.source_cut_id,
                observation.observation_id, observation.content_hash
              )
            )
        )
      )
  ) then
    raise exception 'fresh source cut omits sealed late-model accepted-claim context'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key = authority.workspace_key
     and plan.model_plan_id = authority.model_plan_id
     and plan.parent_job_id = authority.parent_job_id
    join public.gmail_model_context_workgroup_memberships member
      on member.workspace_key = plan.workspace_key
     and member.context_seal_id = plan.context_seal_id
    left join public.operational_workgroup_membership_envelopes envelope
      on envelope.workspace_key = member.workspace_key
     and envelope.membership_version_id = member.membership_version_id
     and envelope.envelope_hash = member.membership_item_hash
    left join public.operational_workgroup_memberships membership
      on membership.membership_version_id = member.membership_version_id
     and membership.content_hash = member.membership_item_hash
    where authority.workspace_key = v_run.workspace_key
      and authority.connection_key = v_run.connection_key
      and authority.root_batch_id = v_run.root_batch_id
      and (
        envelope.membership_version_id is null
        or membership.membership_version_id is null
        or not exists (
          select 1
          from public.operational_workgroup_membership_evidence primary_evidence
          where primary_evidence.membership_version_id = member.membership_version_id
            and primary_evidence.evidence_role = 'primary'
        )
        or exists (
          select 1
          from public.operational_workgroup_membership_evidence evidence
          left join public.source_observations observation
            on observation.observation_id = evidence.observation_id
           and observation.workspace_key = v_run.workspace_key
          where evidence.membership_version_id = member.membership_version_id
            and (
              observation.observation_id is null
              or observation.source_system <> v_run.source_system
              or observation.connection_key <> v_run.connection_key
              or observation.source_cursor_version > v_run.source_cursor_version
              or not private.source_observation_within_cut(
                v_run.workspace_key, v_cut.source_cut_id,
                observation.observation_id, observation.content_hash
              )
            )
        )
        or (
          membership.observation_id is not null
          and not exists (
            select 1 from public.source_observations observation
            where observation.workspace_key = v_run.workspace_key
              and observation.observation_id = membership.observation_id
              and observation.source_system = v_run.source_system
              and observation.connection_key = v_run.connection_key
              and observation.source_cursor_version <= v_run.source_cursor_version
              and private.source_observation_within_cut(
                v_run.workspace_key, v_cut.source_cut_id,
                observation.observation_id, observation.content_hash
              )
          )
        )
        or (
          membership.basis_observation_id is not null
          and not exists (
            select 1 from public.source_observations observation
            where observation.workspace_key = v_run.workspace_key
              and observation.observation_id = membership.basis_observation_id
              and observation.source_system = v_run.source_system
              and observation.connection_key = v_run.connection_key
              and observation.source_cursor_version <= v_run.source_cursor_version
              and private.source_observation_within_cut(
                v_run.workspace_key, v_cut.source_cut_id,
                observation.observation_id, observation.content_hash
              )
          )
        )
      )
  ) then
    raise exception 'fresh source cut omits sealed late-model workgroup context'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_review_obligations obligation
      on obligation.workspace_key = authority.workspace_key
     and obligation.model_child_job_id = authority.model_child_job_id
    join public.gmail_model_extraction_review_resolutions resolution
      on resolution.workspace_key = obligation.workspace_key
     and resolution.obligation_id = obligation.obligation_id
    join lateral jsonb_array_elements_text(
      resolution.resolution_evidence_observation_ids
    ) evidence_id(observation_id) on true
    left join public.source_observations observation
      on observation.workspace_key = authority.workspace_key
     and observation.observation_id = evidence_id.observation_id
    where authority.workspace_key = v_run.workspace_key
      and authority.connection_key = v_run.connection_key
      and authority.root_batch_id = v_run.root_batch_id
      and (
        observation.observation_id is null
        or observation.source_system <> v_run.source_system
        or observation.connection_key <> v_run.connection_key
        or observation.source_cursor_version > v_run.source_cursor_version
        or not private.source_observation_within_cut(
          v_run.workspace_key, v_cut.source_cut_id,
          observation.observation_id, observation.content_hash
        )
      )
  ) then
    raise exception 'fresh source cut omits late-model review evidence'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_late_model_acceptance_items item
    join public.accepted_claim_evidence evidence
      on evidence.claim_version_id = item.accepted_claim_version_id
    left join public.source_observations observation
      on observation.workspace_key = item.workspace_key
     and observation.observation_id = evidence.observation_id
    where item.run_id = v_run.run_id
      and item.decision = 'accept'
      and (
        observation.observation_id is null
        or observation.source_system <> v_run.source_system
        or observation.connection_key <> v_run.connection_key
        or observation.source_cursor_version > v_run.source_cursor_version
        or not private.source_observation_within_cut(
          v_run.workspace_key, v_cut.source_cut_id,
          observation.observation_id, observation.content_hash
        )
      )
  ) then
    raise exception 'fresh source cut omits late-model accepted-claim evidence'
      using errcode = '23514';
  end if;

  v_binding := jsonb_build_object(
    'schemaVersion', 'truth-shadow-late-model-source-cut-binding-v1',
    'workspaceKey', v_run.workspace_key,
    'sourceSystem', v_run.source_system,
    'connectionKey', v_run.connection_key,
    'rootBatchId', v_run.root_batch_id,
    'sourceCursorVersion', v_run.source_cursor_version,
    'sourceCursorValue', v_run.source_cursor_value,
    'sourceCutId', v_cut.source_cut_id,
    'sourceCutManifestHash', v_cut.manifest_hash,
    'rootScopeReceiptId', v_scope.scope_receipt_id,
    'rootScopeReceiptHash', v_scope.scope_receipt_hash,
    'runId', v_run.run_id,
    'runReceiptHash', v_run.receipt_hash,
    'predecessorEpochId', v_run.predecessor_epoch_id,
    'predecessorEpochReceiptHash', v_run.predecessor_epoch_receipt_hash,
    'terminalManifestHash', v_run.terminal_manifest_hash,
    'decisionManifestHash', v_run.decision_manifest_hash,
    'freshAfterLateAcceptance', true,
    'sourceCutCompleteness', v_cut.completeness,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'publishesTruth', false,
    'performsActions', false
  );
  v_binding_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_binding), 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.truth_shadow_late_model_source_cut_bindings (
    binding_id, workspace_key, source_system, connection_key, root_batch_id,
    source_cursor_version, source_cursor_value,
    source_cut_id, source_cut_manifest_hash,
    root_scope_receipt_id, root_scope_receipt_hash, run_id,
    run_receipt_hash, predecessor_epoch_id, predecessor_epoch_receipt_hash,
    canonical_binding, binding_hash, schema_version, shadow_only,
    production_eligible, production_publication_attempted
  ) values (
    'truth-shadow-late-model-cut-binding:v1:' || v_binding_hash,
    v_run.workspace_key, v_run.source_system, v_run.connection_key,
    v_run.root_batch_id, v_run.source_cursor_version, v_run.source_cursor_value,
    v_cut.source_cut_id, v_cut.manifest_hash,
    v_scope.scope_receipt_id, v_scope.scope_receipt_hash, v_run.run_id,
    v_run.receipt_hash, v_run.predecessor_epoch_id,
    v_run.predecessor_epoch_receipt_hash, v_binding, v_binding_hash,
    'truth-shadow-late-model-source-cut-binding-v1', true, false, false
  ) on conflict (source_cut_id) do nothing;
  select * into strict v_existing
  from public.truth_shadow_late_model_source_cut_bindings binding
  where binding.source_cut_id = v_cut.source_cut_id;
  if v_existing.canonical_binding is distinct from v_binding
    or v_existing.binding_hash is distinct from v_binding_hash
    or v_existing.production_publication_attempted <> false then
    raise exception 'late-model source-cut binding conflicts on replay'
      using errcode = '23505';
  end if;
  return v_binding || jsonb_build_object(
    'ok', true,
    'status', 'bound',
    'bindingId', v_existing.binding_id,
    'bindingHash', v_existing.binding_hash,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.bind_truth_shadow_late_model_source_cut_v1(text)
  from public, anon, authenticated, service_role;

create or replace function private.auto_bind_truth_shadow_late_model_source_cut_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.source_system = 'gmail' and new.connection_key like 'shadow-%' then
    perform private.bind_truth_shadow_late_model_source_cut_v1(new.source_cut_id);
  end if;
  return new;
end;
$function$;

drop trigger if exists zzz_truth_shadow_late_model_source_cut_binding
  on public.source_cut_cursors;
create trigger zzz_truth_shadow_late_model_source_cut_binding
after insert on public.source_cut_cursors
for each row execute function
  private.auto_bind_truth_shadow_late_model_source_cut_v1();
revoke all on function private.auto_bind_truth_shadow_late_model_source_cut_v1()
  from public, anon, authenticated, service_role;

-- Preserve the pre-run quarantine too: an operator-accepted late candidate is
-- scoped through its acceptance binding and authorized child even before the
-- late run exists.  Once certified, the immutable late item carries the same
-- connection scope explicitly.
create or replace function private.truth_shadow_claim_visible_to_connection(
  p_claim_version_id text,
  p_workspace_key text,
  p_source_system text,
  p_connection_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select not exists (
    select 1
    from public.truth_shadow_claim_acceptance_epoch_items item
    join public.truth_shadow_claim_acceptance_epochs epoch
      on epoch.epoch_id = item.epoch_id
    where item.accepted_claim_version_id = p_claim_version_id
      and (
        epoch.workspace_key is distinct from p_workspace_key
        or epoch.source_system is distinct from p_source_system
        or epoch.connection_key is distinct from p_connection_key
      )
  ) and not exists (
    select 1
    from public.truth_shadow_late_model_acceptance_items item
    join public.truth_shadow_late_model_acceptance_runs run
      on run.run_id = item.run_id
     and run.workspace_key = item.workspace_key
    where item.accepted_claim_version_id = p_claim_version_id
      and (
        run.workspace_key is distinct from p_workspace_key
        or run.source_system is distinct from p_source_system
        or run.connection_key is distinct from p_connection_key
      )
  ) and not exists (
    select 1
    from public.candidate_claim_acceptance_bindings candidate_binding
    join public.candidate_claim_job_lineage lineage
      on lineage.candidate_claim_version_id =
        candidate_binding.candidate_claim_version_id
    join public.truth_shadow_gmail_resumed_model_child_authorizations authority
      on authority.model_child_job_id = lineage.job_id
    where candidate_binding.accepted_claim_version_id = p_claim_version_id
      and (
        authority.workspace_key is distinct from p_workspace_key
        or authority.source_system is distinct from p_source_system
        or authority.connection_key is distinct from p_connection_key
      )
  );
$function$;

revoke all on function private.truth_shadow_claim_visible_to_connection(
  text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function private.truth_shadow_late_claim_bound_to_cut_v1(
  p_workspace_key text,
  p_source_cut_id text,
  p_claim_version_id text,
  p_claim_item_hash text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_late_model_acceptance_items item
    join public.truth_shadow_late_model_acceptance_runs run
      on run.workspace_key = item.workspace_key
     and run.run_id = item.run_id
    join public.truth_shadow_late_model_source_cut_bindings cut_binding
      on cut_binding.workspace_key = run.workspace_key
     and cut_binding.run_id = run.run_id
    join public.source_cuts source_cut
      on source_cut.workspace_key = cut_binding.workspace_key
     and source_cut.source_cut_id = cut_binding.source_cut_id
    where item.workspace_key = p_workspace_key
      and cut_binding.source_cut_id = p_source_cut_id
      and item.accepted_claim_version_id = p_claim_version_id
      and item.accepted_claim_item_hash = p_claim_item_hash
      and item.decision = 'accept'
      and cut_binding.run_receipt_hash = run.receipt_hash
      and cut_binding.source_cut_manifest_hash = source_cut.manifest_hash
      and source_cut.completeness = 'complete'
      and cut_binding.production_publication_attempted = false
  );
$function$;

revoke all on function private.truth_shadow_late_claim_bound_to_cut_v1(
  text,text,text,text
) from public, anon, authenticated, service_role;

do $rewrite_shadow_build_claim_scope$
declare
  v_signature regprocedure :=
    'private.guard_truth_shadow_build_input_scope()'::regprocedure;
  v_definition text;
  v_old text := $old$  if new.item_kind = 'accepted_claim' then
    if not exists (
      select 1
      from public.truth_shadow_claim_acceptance_epoch_items item
      join public.truth_shadow_claim_acceptance_epochs epoch
        on epoch.epoch_id = item.epoch_id
       and epoch.workspace_key = item.workspace_key
      where item.workspace_key = v_scope.workspace_key
        and item.accepted_claim_version_id = new.item_id
        and item.accepted_claim_item_hash = new.item_hash
        and item.decision = 'accept'
        and epoch.source_system = v_scope.source_system
        and epoch.connection_key = v_scope.connection_key
        and v_scope.acceptance_epoch_manifest @> jsonb_build_array(
          jsonb_build_object(
            'epochId', epoch.epoch_id,
            'epochReceiptHash', epoch.receipt_hash
          )
        )
    ) then
      raise exception 'shadow build accepted claim escaped the sealed acceptance frontier'
        using errcode = '23514';
    end if;$old$;
  v_new text := $new$  if new.item_kind = 'accepted_claim' then
    if not exists (
      select 1
      from public.truth_shadow_claim_acceptance_epoch_items item
      join public.truth_shadow_claim_acceptance_epochs epoch
        on epoch.epoch_id = item.epoch_id
       and epoch.workspace_key = item.workspace_key
      where item.workspace_key = v_scope.workspace_key
        and item.accepted_claim_version_id = new.item_id
        and item.accepted_claim_item_hash = new.item_hash
        and item.decision = 'accept'
        and epoch.source_system = v_scope.source_system
        and epoch.connection_key = v_scope.connection_key
        and v_scope.acceptance_epoch_manifest @> jsonb_build_array(
          jsonb_build_object(
            'epochId', epoch.epoch_id,
            'epochReceiptHash', epoch.receipt_hash
          )
        )
    ) and not private.truth_shadow_late_claim_bound_to_cut_v1(
      v_scope.workspace_key,
      v_scope.source_cut_id,
      new.item_id,
      new.item_hash
    ) then
      raise exception 'shadow build accepted claim escaped the sealed acceptance frontier'
        using errcode = '23514';
    end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_shadow_late_claim_bound_to_cut_v1' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow build accepted-claim scope rewrite did not match'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  elsif (
    length(v_definition) - length(replace(
      v_definition, 'truth_shadow_late_claim_bound_to_cut_v1', ''
    ))
  ) / length('truth_shadow_late_claim_bound_to_cut_v1') <> 1 then
    raise exception 'shadow build late-model scope is partially installed'
      using errcode = '23514';
  end if;
end;
$rewrite_shadow_build_claim_scope$;

create or replace function private.guard_truth_shadow_late_model_build_cut_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope public.truth_shadow_root_source_cuts%rowtype;
begin
  select * into v_scope
  from public.truth_shadow_root_source_cuts scope_row
  where scope_row.workspace_key = new.workspace_key
    and scope_row.source_cut_id = new.source_cut_id;
  if not found then
    return new;
  end if;
  if exists (
    select 1
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key = v_scope.workspace_key
      and authority.connection_key = v_scope.connection_key
      and authority.root_batch_id = v_scope.root_batch_id
  ) and not exists (
    select 1
    from public.truth_shadow_late_model_source_cut_bindings cut_binding
    join public.truth_shadow_late_model_acceptance_runs run
      on run.workspace_key = cut_binding.workspace_key
     and run.run_id = cut_binding.run_id
    where cut_binding.workspace_key = v_scope.workspace_key
      and cut_binding.source_cut_id = v_scope.source_cut_id
      and run.connection_key = v_scope.connection_key
      and run.root_batch_id = v_scope.root_batch_id
      and cut_binding.source_cut_manifest_hash = v_scope.source_cut_manifest_hash
      and cut_binding.run_receipt_hash = run.receipt_hash
      and cut_binding.production_publication_attempted = false
  ) then
    raise exception 'shadow build requires an exact late-model source-cut binding'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

do $build_cut_binding_triggers$
declare
  v_table text;
begin
  foreach v_table in array array['truth_build_pair_runs', 'truth_builds'] loop
    execute format(
      'drop trigger if exists ab_truth_shadow_late_model_cut_binding on public.%I',
      v_table
    );
    execute format(
      'create trigger ab_truth_shadow_late_model_cut_binding '
      || 'before insert on public.%I for each row execute function '
      || 'private.guard_truth_shadow_late_model_build_cut_binding()',
      v_table
    );
  end loop;
end;
$build_cut_binding_triggers$;

revoke all on function private.guard_truth_shadow_late_model_build_cut_binding()
  from public, anon, authenticated, service_role;

create or replace function private.freeze_truth_shadow_late_model_candidate_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.truth_shadow_late_model_acceptance_items item
    where item.candidate_claim_version_id = new.candidate_claim_version_id
  ) then
    raise exception 'late-model acceptance decision authority is frozen'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists zz_truth_shadow_late_model_decision_freeze
  on public.candidate_claim_decisions;
create trigger zz_truth_shadow_late_model_decision_freeze
before insert on public.candidate_claim_decisions
for each row execute function
  private.freeze_truth_shadow_late_model_candidate_decision();
revoke all on function private.freeze_truth_shadow_late_model_candidate_decision()
  from public, anon, authenticated, service_role;

analyze public.truth_shadow_late_model_acceptance_runs;
analyze public.truth_shadow_late_model_acceptance_items;
analyze public.truth_shadow_late_model_source_cut_bindings;

do $verify$
declare
  v_definition text;
  v_cut_guard_before text;
  v_count integer;
begin
  select count(*)::integer into v_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = any(array[
      'truth_shadow_late_model_acceptance_runs',
      'truth_shadow_late_model_acceptance_items',
      'truth_shadow_late_model_source_cut_bindings'
    ])
    and relation.relkind in ('r', 'p')
    and relation.relrowsecurity
    and relation.relforcerowsecurity;
  if v_count <> 3 then
    raise exception 'late-model acceptance tables are missing FORCE RLS'
      using errcode = '23514';
  end if;

  select count(*)::integer into v_count
  from pg_catalog.pg_trigger trigger_row
  where not trigger_row.tgisinternal
    and trigger_row.tgenabled = 'O'
    and (
      (trigger_row.tgrelid = 'public.source_cut_cursors'::regclass
        and trigger_row.tgname =
          'zzz_truth_shadow_late_model_source_cut_binding')
      or
      (trigger_row.tgrelid = 'public.candidate_claim_decisions'::regclass
        and trigger_row.tgname =
          'zz_truth_shadow_late_model_decision_freeze')
      or
      (trigger_row.tgrelid = any(array[
          'public.truth_build_pair_runs'::regclass,
          'public.truth_builds'::regclass
        ])
        and trigger_row.tgname =
          'ab_truth_shadow_late_model_cut_binding')
    );
  if v_count <> 4 then
    raise exception 'late-model source-cut, build, or freeze triggers are incomplete'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.run_truth_shadow_late_model_acceptance(text,text,uuid,text,text)'::regprocedure
  )) into v_definition;
  if position('pg_try_advisory_xact_lock' in v_definition) = 0
    or position('late_model_child_frontier_open' in v_definition) = 0
    or position('late_model_review_frontier_open' in v_definition) = 0
    or position('late_model_candidate_review_pending' in v_definition) = 0
    or position('truth_shadow_late_model_review_adoption_v1' in v_definition) = 0
    or position($marker$'status', 'succeeded'$marker$ in v_definition) = 0
    or position($marker$'productionpublicationattempted', false$marker$
      in v_definition) = 0 then
    raise exception 'late-model acceptance coordinator failed read-back verification'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.bind_truth_shadow_late_model_source_cut_v1(text)'::regprocedure
  )) into v_definition;
  if position('source_observation_within_cut' in v_definition) = 0
    or position('gmail_model_context_observations' in v_definition) = 0
    or position('gmail_model_context_accepted_claims' in v_definition) = 0
    or position('gmail_model_context_workgroup_memberships' in v_definition) = 0
    or position('late-model context seal membership failed exact cut replay'
      in v_definition) = 0
    or position('freshafterlateacceptance' in v_definition) = 0
    or position('fresh shadow source cut requires completed late-model acceptance'
      in v_definition) = 0
    or position($marker$'productionpublicationattempted', false$marker$
      in v_definition) = 0 then
    raise exception 'late-model fresh-cut binding failed read-back verification'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.truth_shadow_claim_visible_to_connection(text,text,text,text)'::regprocedure
  )) into v_definition;
  if position('truth_shadow_late_model_acceptance_items' in v_definition) = 0
    or position('truth_shadow_gmail_resumed_model_child_authorizations'
      in v_definition) = 0 then
    raise exception 'late-model pre-run claim quarantine is incomplete'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.guard_truth_shadow_build_input_scope()'::regprocedure
  )) into v_definition;
  if position('truth_shadow_late_claim_bound_to_cut_v1' in v_definition) = 0
    or position('shadow build accepted claim escaped the sealed acceptance frontier'
      in v_definition) = 0 then
    raise exception 'shadow build late-model claim scope is incomplete'
      using errcode = '23514';
  end if;

  -- This function is only read.  It is deliberately neither replaced nor
  -- weakened by this migration; the exact-completeness contract remains the
  -- build's first authority.
  select lower(pg_get_functiondef(
    'private.require_exact_complete_source_cut(text,text)'::regprocedure
  )) into v_cut_guard_before;
  if position('truth build source cut is incomplete or malformed'
      in v_cut_guard_before) = 0
    or position('source-cut-partition-witness-v1' in v_cut_guard_before) = 0
    or position('truth_shadow_late_model' in v_cut_guard_before) <> 0
    or encode(extensions.digest(convert_to(
      pg_get_functiondef(
        'private.require_exact_complete_source_cut(text,text)'::regprocedure
      ), 'UTF8'
    ), 'sha256'), 'hex') is distinct from current_setting(
      'pikiio.migration_160_exact_cut_guard_hash', true
    ) then
    raise exception 'exact-complete source-cut validator was weakened'
      using errcode = '23514';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.run_truth_shadow_late_model_acceptance(text,text,uuid,text,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.run_truth_shadow_late_model_acceptance(text,text,uuid,text,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.run_truth_shadow_late_model_acceptance(text,text,uuid,text,text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'private.run_truth_shadow_late_model_acceptance(text,text,uuid,text,text)',
      'execute'
    ) then
    raise exception 'late-model acceptance RPC ACLs are unsafe'
      using errcode = '42501';
  end if;

  select lower(string_agg(pg_get_functiondef(procedure.oid), E'\n'))
  into v_definition
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname in ('private', 'public')
    and procedure.proname = any(array[
      'run_truth_shadow_late_model_acceptance',
      'bind_truth_shadow_late_model_source_cut_v1',
      'truth_shadow_late_claim_bound_to_cut_v1',
      'guard_truth_shadow_late_model_build_cut_binding'
    ]);
  if position('insert into public.truth_publications'
      in coalesce(v_definition, '')) <> 0
    or position('productionpublicationattempted'', true'
      in coalesce(v_definition, '')) <> 0 then
    raise exception 'late-model acceptance crossed publication quarantine'
      using errcode = '42501';
  end if;
end;
$verify$;
