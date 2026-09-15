-- Close the remaining shadow Gmail message-claim manifest residuals without
-- inventing claim decisions or weakening the acceptance coordinator.
--
-- * Exact exhausted first-generation message claim jobs rejected by a
--   stale-plan conflict, immutable source binding, nested-provenance parity
--   mismatch, or statement timeout receive one final snapshot-bound retry
--   window.
-- * Stale-plan conflicts are intentionally retried through the live worker so
--   its reconciliation RPC creates the real successor and supersession proofs.
-- * Selection is bound directly to immutable job, observation, and lineage
--   evidence. Commissioning replay ancestry is neither required nor inferred.
--
-- All mutation is confined to one named, unregistered shadow root. This file
-- creates no source cut, build, publication, attachment disposition, or
-- operational-board write. Attachment claim producers remain fully manifest-
-- bearing and are deliberately outside this authority.

create schema if not exists private;

do $preflight$
declare
  v_acceptance regprocedure := to_regprocedure(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
  );
  v_definition text;
begin
  if v_acceptance is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure(
      'private.gmail_model_forwarded_provenance_failure_v1(text,text,jsonb,text)'
    ) is null
    or to_regprocedure('public.reject_immutable_truth_mutation()') is null
    or to_regclass('public.truth_workspaces') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_observations') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.candidate_claim_job_lineage') is null
    or to_regclass('public.candidate_claim_decisions') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null
    or to_regclass('public.truth_model_requests') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epoch_items') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null then
    raise exception 'shadow Gmail message-residual prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_acceptance)) into v_definition;
  if to_regclass(
      'public.truth_shadow_gmail_attachment_claim_residual_actions'
    ) is not null
    or position('direct_attachment_residual_coverage_v1' in v_definition) > 0
    or position(
      'truth_shadow_gmail_attachment_claim_residual_covered_v1'
      in v_definition
    ) > 0 then
    raise exception 'partial attachment residual authority requires explicit cleanup'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- Classify only the four exact failure-v2 classes observed at this shadow
-- frontier. The nested-provenance class is admitted only with the worker-side
-- full-tail/registry-order parity repair; the SQL sealer remains the independent
-- immutable-evidence authority. The live worker owns any stale-plan
-- reconciliation. Everything else fails closed.
create or replace function private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
  p_error_code text,
  p_safe_error_detail text
)
returns text
language plpgsql
immutable
strict
security definer
set search_path = ''
as $function$
declare
  v_detail jsonb;
  v_diagnostic text;
  v_stale_message constant text :=
    'sealed Gmail extraction plan conflicts with retry input';
  v_binding_message constant text :=
    'Gmail model plan is invalid or not bound to immutable source text';
  v_nested_message constant text :=
    'Gmail nested-provenance failure differs from forwarded source evidence';
begin
  if p_error_code <> 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED' then
    return '';
  end if;
  v_detail := p_safe_error_detail::jsonb;
  if jsonb_typeof(v_detail) <> 'object'
    or v_detail->>'schemaVersion' <>
      'truth-gmail-parent-planning-failure-v2'
    or v_detail->>'errorCode' <> 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or v_detail->>'underlyingCode' <> 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or v_detail->>'jobKind' <> 'gmail_extract_message_claims' then
    return '';
  end if;
  v_diagnostic := concat_ws(' ',
    v_detail->>'postgresMessage',
    v_detail->>'underlyingMessage',
    v_detail->>'message',
    v_detail->>'detail'
  );
  if v_detail->>'postgresCode' = '23505'
    and position(v_stale_message in v_diagnostic) > 0 then
    return 'stale_plan_conflict';
  end if;
  if v_detail->>'postgresCode' = '23514'
    and position(v_binding_message in v_diagnostic) > 0 then
    return 'immutable_source_binding';
  end if;
  if v_detail->>'postgresCode' = '23514'
    and v_detail->>'postgresMessage' = v_nested_message
    and v_detail->>'underlyingMessage' =
      'seal Gmail parent extraction plan failed: ' || v_nested_message
    and v_detail->>'postgresDetail' = '' then
    return 'nested_provenance_evidence_mismatch';
  end if;
  if v_detail->>'postgresCode' = '57014'
    and position('statement timeout' in lower(v_diagnostic)) > 0 then
    return 'statement_timeout';
  end if;
  return '';
exception when others then
  return '';
end;
$function$;

revoke all on function
  private.truth_shadow_gmail_model_plan_residual_failure_class_v1(text,text)
  from public, anon, authenticated, service_role;

create or replace function private.truth_shadow_gmail_model_plan_residual_failure_v1(
  p_error_code text,
  p_safe_error_detail text
)
returns boolean
language sql
immutable
strict
security definer
set search_path = ''
as $function$
  select private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
    p_error_code, p_safe_error_detail
  ) <> '';
$function$;

revoke all on function private.truth_shadow_gmail_model_plan_residual_failure_v1(
  text, text
) from public, anon, authenticated, service_role;

-- A direct-session execution of an earlier draft may have committed an empty
-- migration-time supersession table and its exact validator rewrite before the
-- final guard aborted. That draft never became authority. Restore the original
-- validator and drop only an empty table; any row fails closed.
do $remove_aborted_supersession_draft$
declare
  v_table regclass := to_regclass(
    'public.truth_shadow_gmail_stale_plan_residual_supersession_adoptions'
  );
  v_function regprocedure := to_regprocedure(
    'private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)'
  );
  v_definition text;
  v_has_rows boolean := false;
  v_old text := $old$    or v_successor.state = 'superseded' then$old$;
  v_draft text := $draft$    or (
      v_successor.state = 'superseded'
      and not exists (
        select 1
        from public.truth_shadow_gmail_stale_plan_residual_supersession_adoptions adoption
        join public.gmail_stale_extraction_plan_reconciliations reconciliation
          on reconciliation.workspace_key = adoption.workspace_key
         and reconciliation.reconciliation_id = adoption.reconciliation_id
         and reconciliation.stale_parent_job_id = adoption.stale_parent_job_id
         and reconciliation.successor_job_id = adoption.succeeded_successor_job_id
        join public.source_processing_jobs replacement
          on replacement.workspace_key = adoption.workspace_key
         and replacement.job_id = adoption.succeeded_successor_job_id
        join public.candidate_claim_job_manifests replacement_manifest
          on replacement_manifest.workspace_key = replacement.workspace_key
         and replacement_manifest.job_id = replacement.job_id
        where adoption.workspace_key = v_replay.workspace_key
          and adoption.stale_parent_job_id = v_successor.job_id
          and adoption.connection_key = v_replay.connection_key
          and adoption.root_batch_id = v_replay.root_batch_id
          and adoption.shadow_only = true
          and adoption.production_eligible = false
          and adoption.production_publication_attempted = false
          and replacement.state = 'succeeded'
          and replacement.completed_at is not null
          and replacement.lease_owner is null
          and replacement.lease_expires_at is null
          and replacement_manifest.manifest_hash = adoption.successor_manifest_hash
          and private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
            adoption.workspace_key, adoption.stale_parent_job_id
          )
      )
    ) then$draft$;
begin
  if v_table is null then
    return;
  end if;
  if v_function is null then
    raise exception 'commissioning replay validator is unavailable'
      using errcode = '55000';
  end if;
  execute 'select exists (select 1 from '
    || v_table::text || ')' into v_has_rows;
  if v_has_rows then
    raise exception 'aborted supersession draft contains authority rows'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(v_function) into v_definition;
  if position(
      'truth_shadow_gmail_stale_plan_residual_supersession_adoptions'
      in v_definition
    ) > 0 then
    if (length(v_definition) - length(replace(v_definition, v_draft, '')))
        / length(v_draft) <> 1 then
      raise exception 'aborted supersession validator rewrite drifted'
        using errcode = '55000';
    end if;
    execute replace(v_definition, v_draft, v_old);
  end if;
  select pg_get_functiondef(v_function) into v_definition;
  if position(
      'truth_shadow_gmail_stale_plan_residual_supersession_adoptions'
      in v_definition
    ) > 0 then
    raise exception 'aborted supersession validator rewrite remained'
      using errcode = '23514';
  end if;
  drop table public.truth_shadow_gmail_stale_plan_residual_supersession_adoptions;
end;
$remove_aborted_supersession_draft$;

-- A previously aborted non-transactional execution may have left the empty
-- replay-bound draft table. It is not authority until it has rows, so replace
-- an empty table. A populated table must already have the final standalone-job
-- contract; any other populated shape fails closed.
do $normalize_aborted_retry_table$
declare
  v_table regclass := to_regclass(
    'public.truth_shadow_gmail_model_residual_retry_authorizations'
  );
  v_has_rows boolean;
begin
  if v_table is not null then
    execute 'select exists (select 1 from ' || v_table::text || ')'
      into v_has_rows;
    if not v_has_rows then
      drop table public.truth_shadow_gmail_model_residual_retry_authorizations;
    elsif not exists (
        select 1
        from pg_attribute attribute_row
        where attribute_row.attrelid = v_table
          and attribute_row.attname = 'claim_job_id'
          and not attribute_row.attisdropped
      )
      or not exists (
        select 1
        from pg_attribute attribute_row
        where attribute_row.attrelid = v_table
          and attribute_row.attname = 'prior_payload_hash'
          and not attribute_row.attisdropped
      )
      or exists (
        select 1
        from pg_attribute attribute_row
        where attribute_row.attrelid = v_table
          and attribute_row.attname = any(array[
            'commissioning_scope_id', 'replay_id',
            'prior_authorization_id', 'successor_parent_job_id'
          ])
          and not attribute_row.attisdropped
      )
      or not exists (
        select 1 from pg_constraint constraint_row
        where constraint_row.conrelid = v_table
          and constraint_row.conname =
            'truth_shadow_gmail_model_residual_retry_failure_class_check'
      )
      or not exists (
        select 1 from pg_constraint constraint_row
        where constraint_row.conrelid = v_table
          and constraint_row.conname =
            'truth_shadow_gmail_model_residual_retry_reason_code_check'
      ) then
      raise exception 'populated legacy message residual retry authority requires explicit reconciliation'
        using errcode = '23514';
    end if;
  end if;
end;
$normalize_aborted_retry_table$;

create table if not exists public.truth_shadow_gmail_model_residual_retry_authorizations (
  authorization_id text primary key check (
    authorization_id ~ '^truth-shadow-gmail-model-residual-retry:v2:[0-9a-f]{64}$'
  ),
  authorization_hash text not null unique check (authorization_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  claim_job_id uuid not null unique,
  claim_job_dedupe_key text not null check (claim_job_dedupe_key <> ''),
  source_observation_id text not null,
  source_object_id text not null,
  source_observation_content_hash text not null check (
    source_observation_content_hash ~ '^[0-9a-f]{64}$'
  ),
  prior_payload_hash text not null check (prior_payload_hash ~ '^[0-9a-f]{64}$'),
  lineage_parent_job_id uuid,
  lineage_root_job_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value_hash text not null check (
    source_cursor_value_hash ~ '^[0-9a-f]{64}$'
  ),
  prior_state text not null check (prior_state = 'dead_letter'),
  prior_attempt_count integer not null check (prior_attempt_count > 0),
  prior_max_attempts integer not null check (prior_max_attempts > 0),
  prior_lease_fence bigint not null check (prior_lease_fence > 0),
  prior_completed_at timestamptz not null,
  prior_result_hash text not null check (prior_result_hash ~ '^[0-9a-f]{64}$'),
  prior_error_code text not null check (
    prior_error_code = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check (prior_error_detail_hash ~ '^[0-9a-f]{64}$'),
  failure_class text not null constraint
    truth_shadow_gmail_model_residual_retry_failure_class_check check (
    failure_class = any(array[
      'stale_plan_conflict',
      'immutable_source_binding',
      'nested_provenance_evidence_mismatch',
      'statement_timeout'
    ])
  ),
  artifact_mode text not null check (
    artifact_mode = any(array['unstarted', 'sealed_resume_or_reconcile'])
  ),
  authorized_max_attempts integer not null check (
    authorized_max_attempts >= prior_max_attempts
    and authorized_max_attempts >= prior_attempt_count + 3
  ),
  canonical_authorization jsonb not null check (
    jsonb_typeof(canonical_authorization) = 'object'
  ),
  schema_version text not null check (
    schema_version = 'truth-shadow-gmail-model-residual-retry-authorization-v2'
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
  foreign key (workspace_key, claim_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  check (authorization_id =
    'truth-shadow-gmail-model-residual-retry:v2:' || authorization_hash),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_authorization->>'schemaVersion' = schema_version),
  check (canonical_authorization->>'workspaceKey' = workspace_key),
  check (canonical_authorization->>'connectionKey' = connection_key),
  check (canonical_authorization->>'rootBatchId' = root_batch_id::text),
  check (canonical_authorization->>'claimJobId' = claim_job_id::text),
  check (canonical_authorization->>'claimJobDedupeKey' = claim_job_dedupe_key),
  check (canonical_authorization->>'sourceObservationId' = source_observation_id),
  check (canonical_authorization->>'sourceObjectId' = source_object_id),
  check (canonical_authorization->>'sourceObservationContentHash' =
    source_observation_content_hash),
  check (canonical_authorization->>'priorPayloadHash' = prior_payload_hash),
  check (canonical_authorization->>'lineageParentJobId' =
    coalesce(lineage_parent_job_id::text, '')),
  check (canonical_authorization->>'lineageRootJobId' =
    lineage_root_job_id::text),
  check ((canonical_authorization->>'sourceCursorVersion')::bigint =
    source_cursor_version),
  check (canonical_authorization->>'sourceCursorValueHash' =
    source_cursor_value_hash),
  check (canonical_authorization->>'priorState' = prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer = prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer = prior_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint = prior_lease_fence),
  check (canonical_authorization->>'priorCompletedAt' = to_char(
    prior_completed_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )),
  check (canonical_authorization->>'priorResultHash' = prior_result_hash),
  check (canonical_authorization->>'priorErrorCode' = prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash' = prior_error_detail_hash),
  check (canonical_authorization->>'failureClass' = failure_class),
  check (canonical_authorization->>'artifactMode' = artifact_mode),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer =
    authorized_max_attempts),
  constraint truth_shadow_gmail_model_residual_retry_reason_code_check check (
    canonical_authorization->>'reasonCode' = case failure_class
    when 'stale_plan_conflict' then
      'RESIDUAL_STALE_PLAN_CONFLICT_RETRY'
    when 'immutable_source_binding' then
      'RESIDUAL_IMMUTABLE_PLAN_BINDING_RETRY'
    when 'nested_provenance_evidence_mismatch' then
      'RESIDUAL_NESTED_PROVENANCE_PARITY_RETRY'
    when 'statement_timeout' then
      'RESIDUAL_MODEL_PLAN_STATEMENT_TIMEOUT_RETRY'
  end),
  check (canonical_authorization->>'shadowOnly' = 'true'),
  check (canonical_authorization->>'mutatesOperationalState' = 'false'),
  check (canonical_authorization->>'productionEligible' = 'false'),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
);

-- A statement-by-statement direct runner may have committed the first eleven
-- authorization rows from the earlier three-class draft before its final guard
-- stopped on the four nested-provenance rows. Expand only the two named class
-- constraints; immutable receipts and job snapshots are never rewritten.
alter table public.truth_shadow_gmail_model_residual_retry_authorizations
  drop constraint truth_shadow_gmail_model_residual_retry_failure_class_check;
alter table public.truth_shadow_gmail_model_residual_retry_authorizations
  add constraint truth_shadow_gmail_model_residual_retry_failure_class_check check (
    failure_class = any(array[
      'stale_plan_conflict',
      'immutable_source_binding',
      'nested_provenance_evidence_mismatch',
      'statement_timeout'
    ])
  );
alter table public.truth_shadow_gmail_model_residual_retry_authorizations
  drop constraint truth_shadow_gmail_model_residual_retry_reason_code_check;
alter table public.truth_shadow_gmail_model_residual_retry_authorizations
  add constraint truth_shadow_gmail_model_residual_retry_reason_code_check check (
    canonical_authorization->>'reasonCode' = case failure_class
      when 'stale_plan_conflict' then
        'RESIDUAL_STALE_PLAN_CONFLICT_RETRY'
      when 'immutable_source_binding' then
        'RESIDUAL_IMMUTABLE_PLAN_BINDING_RETRY'
      when 'nested_provenance_evidence_mismatch' then
        'RESIDUAL_NESTED_PROVENANCE_PARITY_RETRY'
      when 'statement_timeout' then
        'RESIDUAL_MODEL_PLAN_STATEMENT_TIMEOUT_RETRY'
    end
  );

create index if not exists truth_shadow_gmail_model_residual_retry_scope_idx
  on public.truth_shadow_gmail_model_residual_retry_authorizations(
    workspace_key, connection_key, root_batch_id, claim_job_id
  );

drop trigger if exists truth_shadow_gmail_model_residual_retry_authorizations_immutable
  on public.truth_shadow_gmail_model_residual_retry_authorizations;
create trigger truth_shadow_gmail_model_residual_retry_authorizations_immutable
before update or delete
on public.truth_shadow_gmail_model_residual_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_shadow_gmail_model_residual_retry_authorizations
  enable row level security;
alter table public.truth_shadow_gmail_model_residual_retry_authorizations
  force row level security;
revoke all on table public.truth_shadow_gmail_model_residual_retry_authorizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_shadow_gmail_model_residual_retry_authorizations
  to service_role;

do $authorize_message_residuals$
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
    select successor.observation_id as source_observation_id,
      observation.content_hash as source_observation_content_hash,
      successor.job_id,
      successor.dedupe_key,
      successor.source_object_id,
      successor.attempt_count, successor.max_attempts,
      successor.lease_fence, successor.completed_at,
      successor.last_error_code,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(successor.payload), 'UTF8'
      ), 'sha256'), 'hex') as payload_hash,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(successor.result), 'UTF8'
      ), 'sha256'), 'hex') as result_hash,
      encode(extensions.digest(convert_to(successor.safe_error_detail, 'UTF8'),
        'sha256'), 'hex') as error_detail_hash,
      lineage.parent_job_id,
      lineage.root_job_id,
      lineage.source_cursor_version,
      encode(extensions.digest(convert_to(lineage.source_cursor_value, 'UTF8'),
        'sha256'), 'hex') as source_cursor_value_hash,
      private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
        successor.last_error_code, successor.safe_error_detail
      ) as failure_class,
      case when exists (
        select 1 from public.gmail_model_extraction_plans plan_row
        where plan_row.workspace_key = successor.workspace_key
          and plan_row.parent_job_id = successor.job_id
      ) or exists (
        select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key = successor.workspace_key
          and manifest.job_id = successor.job_id
      ) then 'sealed_resume_or_reconcile' else 'unstarted' end as artifact_mode
    from public.source_processing_jobs successor
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = successor.workspace_key
     and lineage.job_id = successor.job_id
    join public.source_observations observation
      on observation.workspace_key = successor.workspace_key
     and observation.observation_id = successor.observation_id
     and observation.source_system = successor.source_system
     and observation.connection_key = successor.connection_key
    where successor.workspace_key = v_workspace
      and successor.source_system = 'gmail'
      and successor.connection_key = v_connection
      and successor.job_kind = 'gmail_extract_message_claims'
      and successor.state = 'dead_letter'
      and successor.attempt_count >= successor.max_attempts
      and successor.lease_owner is null
      and successor.lease_expires_at is null
      and successor.completed_at is not null
      and successor.result = '{}'::jsonb
      and successor.last_error_code = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
        successor.last_error_code, successor.safe_error_detail
      ) = any(array[
        'stale_plan_conflict',
        'immutable_source_binding',
        'nested_provenance_evidence_mismatch',
        'statement_timeout'
      ])
      and lineage.root_batch_id = v_root
      and lineage.source_system = successor.source_system
      and lineage.connection_key = successor.connection_key
      and not exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.candidate_claim_decisions decision_row
          on decision_row.candidate_claim_version_id =
            candidate_lineage.candidate_claim_version_id
        where candidate_lineage.job_id = successor.job_id
      )
      and not exists (
        select 1
        from public.candidate_claim_job_lineage candidate_lineage
        join public.candidate_claim_acceptance_bindings binding
          on binding.candidate_claim_version_id =
            candidate_lineage.candidate_claim_version_id
        where candidate_lineage.job_id = successor.job_id
      )
      and not exists (
        select 1 from public.truth_pending_acceptance_epoch_manifests membership
        where membership.workspace_key = successor.workspace_key
          and membership.source_job_id = successor.job_id
      )
      and not exists (
        select 1 from public.truth_shadow_claim_acceptance_epoch_items item
        where item.workspace_key = successor.workspace_key
          and item.source_job_id = successor.job_id
      )
      and not exists (
        select 1 from public.truth_model_requests request_row
        where request_row.workspace_key = successor.workspace_key
          and request_row.source_job_id = successor.job_id
      )
      and not exists (
        select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key = successor.workspace_key
          and epoch.root_batch_id = v_root
      )
      and not exists (
        select 1 from public.truth_shadow_root_source_cuts root_cut
        where root_cut.workspace_key = successor.workspace_key
          and root_cut.root_batch_id = v_root
      )
      and not exists (
        select 1 from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = build.workspace_key
         and root_cut.source_cut_id = build.source_cut_id
        where root_cut.workspace_key = successor.workspace_key
          and root_cut.root_batch_id = v_root
      )
      and not exists (
        select 1 from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = publication.workspace_key
         and root_cut.source_cut_id = publication.source_cut_id
        where root_cut.workspace_key = successor.workspace_key
          and root_cut.root_batch_id = v_root
      )
      and not exists (
        select 1
        from public.truth_shadow_gmail_model_residual_retry_authorizations auth
        where auth.workspace_key = successor.workspace_key
          and auth.claim_job_id = successor.job_id
      )
    order by successor.job_id
    for update of successor
  loop
    v_max := greatest(v_candidate.max_attempts, v_candidate.attempt_count + 3);
    v_authorization := jsonb_build_object(
      'schemaVersion',
        'truth-shadow-gmail-model-residual-retry-authorization-v2',
      'workspaceKey', v_workspace,
      'connectionKey', v_connection,
      'rootBatchId', v_root,
      'claimJobId', v_candidate.job_id,
      'claimJobDedupeKey', v_candidate.dedupe_key,
      'sourceObservationId', v_candidate.source_observation_id,
      'sourceObjectId', v_candidate.source_object_id,
      'sourceObservationContentHash',
        v_candidate.source_observation_content_hash,
      'priorPayloadHash', v_candidate.payload_hash,
      'lineageParentJobId', coalesce(v_candidate.parent_job_id::text, ''),
      'lineageRootJobId', v_candidate.root_job_id,
      'sourceCursorVersion', v_candidate.source_cursor_version,
      'sourceCursorValueHash', v_candidate.source_cursor_value_hash,
      'priorState', 'dead_letter',
      'priorAttemptCount', v_candidate.attempt_count,
      'priorMaxAttempts', v_candidate.max_attempts,
      'priorLeaseFence', v_candidate.lease_fence,
      'priorCompletedAt', to_char(
        v_candidate.completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'priorResultHash', v_candidate.result_hash,
      'priorErrorCode', v_candidate.last_error_code,
      'priorErrorDetailHash', v_candidate.error_detail_hash,
      'failureClass', v_candidate.failure_class,
      'artifactMode', v_candidate.artifact_mode,
      'authorizedMaxAttempts', v_max,
      'reasonCode', case v_candidate.failure_class
        when 'stale_plan_conflict' then
          'RESIDUAL_STALE_PLAN_CONFLICT_RETRY'
        when 'immutable_source_binding' then
          'RESIDUAL_IMMUTABLE_PLAN_BINDING_RETRY'
        when 'nested_provenance_evidence_mismatch' then
          'RESIDUAL_NESTED_PROVENANCE_PARITY_RETRY'
        when 'statement_timeout' then
          'RESIDUAL_MODEL_PLAN_STATEMENT_TIMEOUT_RETRY'
      end,
      'shadowOnly', true,
      'mutatesOperationalState', false,
      'productionEligible', false,
      'productionPublicationAttempted', false
    );
    v_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_authorization), 'UTF8'
    ), 'sha256'), 'hex');
    v_id := 'truth-shadow-gmail-model-residual-retry:v2:' || v_hash;
    insert into public.truth_shadow_gmail_model_residual_retry_authorizations(
      authorization_id, authorization_hash, workspace_key,
      connection_key, root_batch_id, claim_job_id,
      claim_job_dedupe_key, source_observation_id, source_object_id,
      source_observation_content_hash,
      prior_payload_hash, lineage_parent_job_id, lineage_root_job_id,
      source_cursor_version, source_cursor_value_hash,
      prior_state, prior_attempt_count,
      prior_max_attempts, prior_lease_fence, prior_completed_at,
      prior_result_hash, prior_error_code,
      prior_error_detail_hash, failure_class, artifact_mode,
      authorized_max_attempts,
      canonical_authorization, schema_version, shadow_only,
      mutates_operational_state, production_eligible,
      production_publication_attempted
    ) values (
      v_id, v_hash, v_workspace, v_connection, v_root, v_candidate.job_id,
      v_candidate.dedupe_key, v_candidate.source_observation_id,
      v_candidate.source_object_id,
      v_candidate.source_observation_content_hash,
      v_candidate.payload_hash, v_candidate.parent_job_id,
      v_candidate.root_job_id, v_candidate.source_cursor_version,
      v_candidate.source_cursor_value_hash, 'dead_letter',
      v_candidate.attempt_count, v_candidate.max_attempts,
      v_candidate.lease_fence, v_candidate.completed_at,
      v_candidate.result_hash, v_candidate.last_error_code,
      v_candidate.error_detail_hash, v_candidate.failure_class,
      v_candidate.artifact_mode, v_max,
      v_authorization,
      'truth-shadow-gmail-model-residual-retry-authorization-v2',
      true, false, false, false
    );
    get diagnostics v_inserted = row_count;
    if v_inserted <> 1 then
      raise exception 'message residual retry authorization conflicted'
        using errcode = '23505';
    end if;

    update public.source_processing_jobs successor
    set state = 'retry_wait', max_attempts = v_max,
        available_at = clock_timestamp(), lease_owner = null,
        lease_expires_at = null,
        last_error_code = case v_candidate.failure_class
          when 'stale_plan_conflict' then
            'GMAIL_STALE_PLAN_CONFLICT_RETRY_AUTHORIZED'
          when 'immutable_source_binding' then
            'GMAIL_MODEL_PLAN_RESIDUAL_RETRY_AUTHORIZED'
          when 'nested_provenance_evidence_mismatch' then
            'GMAIL_NESTED_PROVENANCE_PARITY_RETRY_AUTHORIZED'
          when 'statement_timeout' then
            'GMAIL_MODEL_PLAN_TIMEOUT_RETRY_AUTHORIZED'
        end,
        safe_error_detail = case v_candidate.failure_class
          when 'stale_plan_conflict' then
            'Exact exhausted standalone shadow message claim received one bounded stale-plan conflict retry for live reconciliation.'
          when 'immutable_source_binding' then
            'Exact exhausted standalone shadow message claim received one bounded source-binding retry.'
          when 'nested_provenance_evidence_mismatch' then
            'Exact exhausted standalone shadow message claim received one bounded retry after worker-to-sealer nested-provenance parity repair.'
          when 'statement_timeout' then
            'Exact exhausted standalone shadow message claim received one bounded statement-timeout retry.'
        end,
        updated_at = clock_timestamp(), completed_at = null
    where successor.workspace_key = v_workspace
      and successor.job_id = v_candidate.job_id
      and successor.dedupe_key = v_candidate.dedupe_key
      and successor.observation_id = v_candidate.source_observation_id
      and successor.source_object_id = v_candidate.source_object_id
      and successor.state = 'dead_letter'
      and successor.attempt_count = v_candidate.attempt_count
      and successor.max_attempts = v_candidate.max_attempts
      and successor.lease_fence = v_candidate.lease_fence
      and successor.lease_owner is null
      and successor.lease_expires_at is null
      and successor.completed_at = v_candidate.completed_at
      and successor.last_error_code = v_candidate.last_error_code
      and encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(successor.payload), 'UTF8'
      ), 'sha256'), 'hex') = v_candidate.payload_hash
      and encode(extensions.digest(convert_to(successor.safe_error_detail, 'UTF8'),
        'sha256'), 'hex') = v_candidate.error_detail_hash
      and successor.result = '{}'::jsonb
      and encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(successor.result), 'UTF8'
      ), 'sha256'), 'hex') = v_candidate.result_hash;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'message residual retry target changed during authorization'
        using errcode = '40001';
    end if;
  end loop;
end;
$authorize_message_residuals$;


analyze public.source_processing_jobs;
analyze public.truth_shadow_gmail_model_residual_retry_authorizations;

do $verify$
declare
  v_definition text;
  v_forwarded_core jsonb;
  v_multiline_core jsonb;
begin
  if private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v2",'
        || '"errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"underlyingCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"jobKind":"gmail_extract_message_claims",'
        || '"postgresCode":"23505",'
        || '"postgresMessage":"sealed Gmail extraction plan conflicts with retry input"}'
    ) <> 'stale_plan_conflict'
    or private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v2",'
        || '"errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"underlyingCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"jobKind":"gmail_extract_message_claims",'
        || '"postgresCode":"23514",'
        || '"underlyingMessage":"Gmail model plan is invalid or not bound to immutable source text"}'
    ) <> 'immutable_source_binding'
    or private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v2",'
        || '"errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"underlyingCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"jobKind":"gmail_extract_message_claims",'
        || '"postgresCode":"23514",'
        || '"postgresMessage":"Gmail nested-provenance failure differs from forwarded source evidence",'
        || '"underlyingMessage":"seal Gmail parent extraction plan failed: Gmail nested-provenance failure differs from forwarded source evidence",'
        || '"postgresDetail":""}'
    ) <> 'nested_provenance_evidence_mismatch'
    or private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v2",'
        || '"errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"underlyingCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"jobKind":"gmail_extract_message_claims",'
        || '"postgresCode":"57014",'
        || '"postgresMessage":"canceling statement due to statement timeout"}'
    ) <> 'statement_timeout'
    or private.truth_shadow_gmail_model_plan_residual_failure_class_v1(
      'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      '{"schemaVersion":"truth-gmail-parent-planning-failure-v2",'
        || '"errorCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"underlyingCode":"TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED",'
        || '"jobKind":"gmail_extract_attachment_claims",'
        || '"postgresCode":"57014",'
        || '"postgresMessage":"canceling statement due to statement timeout"}'
    ) <> '' then
    raise exception 'four-class message residual classifier failed read-back'
      using errcode = '23514';
  end if;

  -- The worker-side repair deliberately mirrors this existing SQL authority:
  -- full forwarded-tail scanning and the versioned registry order. These two
  -- witnesses catch both production-only seams hidden by the old one-signal
  -- fixtures: predicate ordering and a scheduled phrase spanning a newline.
  v_forwarded_core := private.gmail_model_forwarded_provenance_failure_v1(
    'obs:v1:' || repeat('0', 64),
    repeat('1', 64),
    jsonb_build_object(
      'text', E'-----Original Message-----\nCargo picked up and delivered.'
    ),
    E'-----Original Message-----\nCargo picked up and delivered.'
  );
  v_multiline_core := private.gmail_model_forwarded_provenance_failure_v1(
    'obs:v1:' || repeat('2', 64),
    repeat('3', 64),
    jsonb_build_object(
      'text', E'-----Original Message-----\npickup\nscheduled tomorrow.'
    ),
    E'-----Original Message-----\npickup\nscheduled tomorrow.'
  );
  if (v_forwarded_core->>'tailSignalCount')::integer <> 2
    or v_forwarded_core->'tailPredicates' <>
      '["pickup_completed","delivery_completed"]'::jsonb
    or (v_multiline_core->>'tailSignalCount')::integer <> 2
    or v_multiline_core->'tailPredicates' <>
      '["pickup_scheduled","pickup_completed"]'::jsonb then
    raise exception 'Gmail nested-provenance SQL witness differs from worker parity contract'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  )) into v_definition;
  if to_regclass(
      'public.truth_shadow_gmail_attachment_claim_residual_actions'
    ) is not null
    or position('direct_attachment_residual_coverage_v1' in v_definition) > 0
    or position(
      'truth_shadow_gmail_attachment_claim_residual_covered_v1'
      in v_definition
    ) > 0 then
    raise exception 'attachment residual authority entered message-only closure'
      using errcode = '23514';
  end if;

  if exists (
      select 1
      from pg_attribute attribute_row
      where attribute_row.attrelid =
        'public.truth_shadow_gmail_model_residual_retry_authorizations'::regclass
        and attribute_row.attname = any(array[
          'commissioning_scope_id', 'replay_id',
          'prior_authorization_id', 'successor_parent_job_id'
        ])
        and not attribute_row.attisdropped
    )
    or not exists (
      select 1
      from pg_attribute attribute_row
      where attribute_row.attrelid =
        'public.truth_shadow_gmail_model_residual_retry_authorizations'::regclass
        and attribute_row.attname = 'claim_job_id'
        and not attribute_row.attisdropped
    ) then
    raise exception 'message residual authority retained replay-bound identity'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_shadow_gmail_model_residual_retry_authorizations auth
    where auth.workspace_key <> 'primary'
      or auth.connection_key <> 'shadow-current-awbs-20260710-c475a8ca'
      or auth.root_batch_id <>
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
      or auth.shadow_only is distinct from true
      or auth.mutates_operational_state is distinct from false
      or auth.production_eligible is distinct from false
      or auth.production_publication_attempted is distinct from false
      or auth.schema_version <>
        'truth-shadow-gmail-model-residual-retry-authorization-v2'
      or auth.failure_class not in (
        'stale_plan_conflict',
        'immutable_source_binding',
        'nested_provenance_evidence_mismatch',
        'statement_timeout'
      )
      or not exists (
        select 1
        from public.source_processing_jobs job
        join public.source_processing_job_lineage lineage
          on lineage.workspace_key = job.workspace_key
         and lineage.job_id = job.job_id
        join public.source_observations observation
          on observation.workspace_key = job.workspace_key
         and observation.observation_id = job.observation_id
        where job.workspace_key = auth.workspace_key
          and job.job_id = auth.claim_job_id
          and job.dedupe_key = auth.claim_job_dedupe_key
          and job.source_system = 'gmail'
          and job.connection_key = auth.connection_key
          and job.job_kind = 'gmail_extract_message_claims'
          and job.observation_id = auth.source_observation_id
          and job.source_object_id = auth.source_object_id
          and encode(extensions.digest(convert_to(
            private.truth_canonical_json_text(job.payload), 'UTF8'
          ), 'sha256'), 'hex') = auth.prior_payload_hash
          and lineage.root_batch_id = auth.root_batch_id
          and lineage.parent_job_id is not distinct from
            auth.lineage_parent_job_id
          and lineage.root_job_id = auth.lineage_root_job_id
          and lineage.source_cursor_version = auth.source_cursor_version
          and encode(extensions.digest(convert_to(
            lineage.source_cursor_value, 'UTF8'
          ), 'sha256'), 'hex') = auth.source_cursor_value_hash
          and observation.content_hash =
            auth.source_observation_content_hash
      )
  ) then
    raise exception 'message residual authority escaped its exact shadow scope'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = job.workspace_key
     and lineage.job_id = job.job_id
    where job.workspace_key = 'primary'
      and job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
      and lineage.root_batch_id =
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
      and job.job_kind = 'gmail_extract_message_claims'
      and job.state = 'dead_letter'
      and job.last_error_code = 'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ) then
    raise exception 'exact shadow message claim-manifest residual remained after retry adoption'
      using errcode = '23514';
  end if;

  if has_table_privilege(
      'anon', 'public.truth_shadow_gmail_model_residual_retry_authorizations',
      'SELECT'
    )
    or has_table_privilege(
      'authenticated',
      'public.truth_shadow_gmail_model_residual_retry_authorizations', 'SELECT'
    )
    or not has_table_privilege(
      'service_role',
      'public.truth_shadow_gmail_model_residual_retry_authorizations', 'SELECT'
    ) then
    raise exception 'message residual authority ACL escaped service role'
      using errcode = '23514';
  end if;
end;
$verify$;
