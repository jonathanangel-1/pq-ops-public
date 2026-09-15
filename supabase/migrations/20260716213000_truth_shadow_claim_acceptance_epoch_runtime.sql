-- Candidate-v1 is a compatibility extraction format, not the actor-authorized
-- candidate-v2 production contract. This forward authority commissions it only
-- for explicitly shadow-scoped Gmail connections. It serializes the complete
-- source frontier, derives versions/predecessors in PostgreSQL, leaves every
-- legacy source-job lease fence intact, and structurally forbids production use.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.truth_pending_acceptance_epochs') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.candidate_claim_envelopes') is null
    or to_regclass('public.candidate_claim_decisions') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null
    or to_regclass('public.accepted_claims') is null
    or to_regclass('public.truth_build_pair_runs') is null
    or to_regclass('public.truth_production_publication_approvals') is null then
    raise exception 'truth shadow acceptance prerequisites are unavailable'
      using errcode = '55000';
  end if;
  if to_regprocedure(
      'private.append_accepted_claim_source_chronology(text,jsonb,jsonb,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'private.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)'
    ) is null
    or to_regprocedure(
      'private.seal_source_cut(text,text,jsonb,jsonb,jsonb,jsonb,text,text)'
    ) is null then
    raise exception 'truth shadow acceptance function prerequisites are unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('v_has_model_plan boolean:=false;' in v_definition) = 0
    or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0
    or position('MODEL_NESTED_PROVENANCE_REQUIRED' in v_definition) = 0 then
    raise exception 'Gmail plan sealer differs from the reviewed installed contract'
      using errcode = '23514';
  end if;
end;
$preflight$;

create table if not exists public.truth_shadow_claim_acceptance_epochs (
  epoch_id text primary key check (
    epoch_id ~ '^truth-shadow-acceptance-epoch:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  pending_job_id uuid not null unique,
  obligation_id text not null unique,
  obligation_hash text not null check (obligation_hash ~ '^[0-9a-f]{64}$'),
  predecessor_epoch_id text references public.truth_shadow_claim_acceptance_epochs(epoch_id)
    on update restrict on delete restrict,
  predecessor_epoch_hash text not null default '' check (
    predecessor_epoch_hash = '' or predecessor_epoch_hash ~ '^[0-9a-f]{64}$'
  ),
  frontier_manifest jsonb not null check (jsonb_typeof(frontier_manifest) = 'object'),
  frontier_manifest_hash text not null check (frontier_manifest_hash ~ '^[0-9a-f]{64}$'),
  decision_manifest jsonb not null check (jsonb_typeof(decision_manifest) = 'array'),
  decision_manifest_hash text not null check (decision_manifest_hash ~ '^[0-9a-f]{64}$'),
  head_manifest jsonb not null check (jsonb_typeof(head_manifest) = 'array'),
  head_manifest_hash text not null check (head_manifest_hash ~ '^[0-9a-f]{64}$'),
  candidate_count integer not null check (candidate_count >= 0),
  accepted_count integer not null check (accepted_count >= 0),
  rejected_count integer not null check (rejected_count >= 0),
  review_count integer not null check (review_count >= 0),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-claim-acceptance-epoch-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, source_system, connection_key, root_batch_id),
  unique (workspace_key, obligation_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, pending_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, obligation_id)
    references public.truth_pending_acceptance_epochs(workspace_key, obligation_id)
    on update restrict on delete restrict,
  check (candidate_count = accepted_count + rejected_count + review_count),
  check ((predecessor_epoch_id is null) = (predecessor_epoch_hash = '')),
  check (receipt_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt), 'UTF8'
  ), 'sha256'), 'hex')),
  check (epoch_id = 'truth-shadow-acceptance-epoch:v1:' || receipt_hash)
);

create unique index if not exists candidate_claim_envelopes_workspace_identity_uidx
  on public.candidate_claim_envelopes(workspace_key, candidate_claim_version_id);
create unique index if not exists truth_shadow_acceptance_epoch_workspace_identity_uidx
  on public.truth_shadow_claim_acceptance_epochs(workspace_key, epoch_id);

alter table public.truth_shadow_claim_acceptance_epochs
  drop constraint if exists truth_shadow_acceptance_epoch_predecessor_workspace_fkey;
alter table public.truth_shadow_claim_acceptance_epochs
  add constraint truth_shadow_acceptance_epoch_predecessor_workspace_fkey
  foreign key (workspace_key, predecessor_epoch_id)
  references public.truth_shadow_claim_acceptance_epochs(workspace_key, epoch_id)
  on update restrict on delete restrict;

create table if not exists public.truth_shadow_claim_acceptance_epoch_items (
  item_id text primary key check (
    item_id ~ '^truth-shadow-acceptance-item:v1:[0-9a-f]{64}$'
  ),
  epoch_id text not null
    references public.truth_shadow_claim_acceptance_epochs(epoch_id)
    on update restrict on delete restrict,
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  obligation_id text not null,
  ordinal integer not null check (ordinal >= 0),
  source_job_id uuid not null,
  candidate_claim_version_id text not null unique
    references public.candidate_claim_envelopes(candidate_claim_version_id)
    on update restrict on delete restrict,
  candidate_item_hash text not null check (candidate_item_hash ~ '^[0-9a-f]{64}$'),
  original_claim_key text not null,
  shadow_claim_key text not null,
  chronology_at timestamptz not null,
  decision text not null check (decision = any(array['accept', 'reject', 'review'])),
  reason_codes jsonb not null check (
    jsonb_typeof(reason_codes) = 'array' and jsonb_array_length(reason_codes) > 0
  ),
  decision_version_id text not null unique
    references public.candidate_claim_decisions(decision_version_id)
    on update restrict on delete restrict,
  decision_item_hash text not null check (decision_item_hash ~ '^[0-9a-f]{64}$'),
  accepted_claim_version_id text unique
    references public.accepted_claims(claim_version_id)
    on update restrict on delete restrict,
  accepted_claim_item_hash text not null default '' check (
    accepted_claim_item_hash = '' or accepted_claim_item_hash ~ '^[0-9a-f]{64}$'
  ),
  binding_id text unique
    references public.candidate_claim_acceptance_bindings(binding_id)
    on update restrict on delete restrict,
  binding_item_hash text not null default '' check (
    binding_item_hash = '' or binding_item_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_item jsonb not null check (jsonb_typeof(canonical_item) = 'object'),
  item_hash text not null unique check (item_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-claim-acceptance-epoch-item-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (epoch_id, ordinal),
  unique (workspace_key, obligation_id, candidate_claim_version_id),
  foreign key (workspace_key, obligation_id)
    references public.truth_shadow_claim_acceptance_epochs(workspace_key, obligation_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, candidate_claim_version_id)
    references public.candidate_claim_envelopes(
      workspace_key, candidate_claim_version_id
    ) on update restrict on delete restrict,
  check (
    (decision = 'accept'
      and accepted_claim_version_id is not null
      and accepted_claim_item_hash <> ''
      and binding_id is not null
      and binding_item_hash <> '')
    or
    (decision in ('reject', 'review')
      and accepted_claim_version_id is null
      and accepted_claim_item_hash = ''
      and binding_id is null
      and binding_item_hash = '')
  ),
  check (item_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_item), 'UTF8'
  ), 'sha256'), 'hex')),
  check (item_id = 'truth-shadow-acceptance-item:v1:' || item_hash)
);

create index if not exists truth_shadow_acceptance_epoch_scope_idx
  on public.truth_shadow_claim_acceptance_epochs(
    workspace_key, source_system, connection_key, source_cursor_version
  );
create index if not exists truth_shadow_acceptance_item_claim_key_idx
  on public.truth_shadow_claim_acceptance_epoch_items(
    workspace_key, shadow_claim_key, chronology_at, ordinal
  );

create table if not exists public.truth_shadow_root_source_cuts (
  source_cut_id text primary key
    references public.source_cuts(source_cut_id) on update restrict on delete restrict,
  scope_receipt_id text not null unique check (
    scope_receipt_id ~ '^truth-shadow-root-source-cut:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null
    references public.truth_workspaces(workspace_key) on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  through_cursor_version bigint not null check (through_cursor_version > 0),
  through_cursor_value text not null,
  source_cut_manifest_hash text not null check (source_cut_manifest_hash ~ '^[0-9a-f]{64}$'),
  acceptance_epoch_manifest jsonb not null check (
    jsonb_typeof(acceptance_epoch_manifest) = 'array'
    and jsonb_array_length(acceptance_epoch_manifest) > 0
  ),
  acceptance_epoch_manifest_hash text not null check (
    acceptance_epoch_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_scope_receipt jsonb not null check (
    jsonb_typeof(canonical_scope_receipt) = 'object'
  ),
  scope_receipt_hash text not null unique check (scope_receipt_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-root-source-cut-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (production_eligible = false),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_cut_id)
    references public.source_cuts(workspace_key, source_cut_id)
    on update restrict on delete restrict,
  check (acceptance_epoch_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(acceptance_epoch_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (scope_receipt_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_scope_receipt), 'UTF8'
  ), 'sha256'), 'hex')),
  check (scope_receipt_id = 'truth-shadow-root-source-cut:v1:' || scope_receipt_hash)
);

do $immutability$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_shadow_claim_acceptance_epochs',
    'truth_shadow_claim_acceptance_epoch_items',
    'truth_shadow_root_source_cuts'
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
      'revoke all on public.%I from public, anon, authenticated, service_role',
      v_table
    );
    execute format('grant select on public.%I to service_role', v_table);
  end loop;
end;
$immutability$;

create or replace function private.truth_shadow_claim_scope_hash(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(jsonb_build_object(
      'schemaVersion', 'truth-shadow-claim-scope-v1',
      'workspaceKey', p_workspace_key,
      'sourceSystem', p_source_system,
      'connectionKey', p_connection_key
    )), 'UTF8'
  ), 'sha256'), 'hex');
$function$;

revoke all on function private.truth_shadow_claim_scope_hash(text, text, text)
  from public, anon, authenticated, service_role;

-- Model-off residual evidence is not a successful empty plan. Admit one exact,
-- server-recomputed planning-failure reason into the existing zero-manifest
-- review path; all existing model and source-evidence checks remain intact.
do $model_off_review_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  );
  v_definition text;
  v_updated text;
  v_old_codes text := $old$      and v_failure_code in (
        'MODEL_PLAN_BOUNDS_EXCEEDED','MODEL_NESTED_PROVENANCE_REQUIRED'
      ) then$old$;
  v_new_codes text := $new$      and v_failure_code in (
        'MODEL_PLAN_BOUNDS_EXCEEDED','MODEL_NESTED_PROVENANCE_REQUIRED',
        'MODEL_RUNTIME_DISABLED'
      ) then$new$;
  v_old_branch text := $old$    else
      v_forwarded_failure_core:=private.gmail_model_forwarded_provenance_failure_v1(
        v_observation.observation_id,v_observation.content_hash,
        v_observation.normalized_payload,v_observation.normalized_text
      );$old$;
  v_new_branch text := $new$    elsif v_failure_code='MODEL_RUNTIME_DISABLED' then
      v_plan_local_failure_core:=jsonb_build_object(
        'schemaVersion','gmail-model-runtime-disabled-review-v1',
        'sourceObservationId',v_observation.observation_id,
        'sourceObservationContentHash',v_observation.content_hash,
        'deterministicCandidateCount',jsonb_array_length(v_deterministic),
        'residual',v_expected_residual
      );
      v_plan_local_detail_hash:=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_plan_local_failure_core),'UTF8'
      ),'sha256'),'hex');
      if jsonb_array_length(v_expected_residual->'unresolvedSignals')=0
        or v_failure_detail_hash is distinct from v_plan_local_detail_hash then
        raise exception 'Gmail model-runtime-disabled review differs from the server-derived residual'
          using errcode='23514';
      end if;
    else
      v_forwarded_failure_core:=private.gmail_model_forwarded_provenance_failure_v1(
        v_observation.observation_id,v_observation.content_hash,
        v_observation.normalized_payload,v_observation.normalized_text
      );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('gmail-model-runtime-disabled-review-v1' in v_definition) = 0 then
    if position(v_old_codes in v_definition) = 0
      or position(v_old_branch in v_definition) = 0
      or position('v_has_model_plan boolean:=false;' in v_definition) = 0
      or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0 then
      raise exception 'Gmail model-off review rewrite did not match the reviewed sealer'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old_codes, v_new_codes);
    v_updated := replace(v_updated, v_old_branch, v_new_branch);
    if v_updated = v_definition
      or position('gmail-model-runtime-disabled-review-v1' in v_updated) = 0
      or position(v_new_codes in v_updated) = 0 then
      raise exception 'Gmail model-off review rewrite is incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(v_new_codes in v_definition) = 0
    or position('Gmail model-runtime-disabled review differs from the server-derived residual' in v_definition) = 0 then
    raise exception 'Gmail model-off review authority is only partially installed'
      using errcode = '23514';
  end if;
end;
$model_off_review_rewrite$;

-- The link epoch intentionally parks review jobs. Explicit token-protected
-- resolution may consume that one parked state, but no other waiting-runtime
-- job becomes resolvable through this authority.
do $review_state_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.resolve_gmail_model_extraction_review(text,text,text,jsonb,text,text,text,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  if not found or v_review.state not in ('queued','retry_wait','dead_letter') then$old$;
  v_new text := $new$  if not found or (
    v_review.state not in ('queued','retry_wait','dead_letter')
    and not (
      v_review.state='waiting_runtime'
      and v_review.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED'
    )
  ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'Gmail model review resolver differs from the reviewed state contract'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition then
      raise exception 'Gmail model review state rewrite did not apply'
        using errcode = '23514';
    end if;
    execute v_updated;
  end if;
end;
$review_state_rewrite$;

revoke all on function private.seal_gmail_model_extraction_plan(
  text, uuid, text, bigint, text, jsonb, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.seal_gmail_model_extraction_plan(
  text, uuid, text, bigint, text, jsonb, integer, text
) from public, anon, authenticated;
grant execute on function public.seal_gmail_model_extraction_plan(
  text, uuid, text, bigint, text, jsonb, integer, text
) to service_role;
revoke all on function private.resolve_gmail_model_extraction_review(
  text, text, text, jsonb, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_gmail_model_extraction_review(
  text, text, text, jsonb, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_gmail_model_extraction_review(
  text, text, text, jsonb, text, text, text, text, text
) to service_role;

-- Scope attachment completeness by the exact cut vector. Without this overload,
-- an unresolved attachment in a local shadow connection degrades the canonical
-- primary vector because the inherited wrapper scans the whole workspace.
create or replace function private.unresolved_gmail_attachment_extractions(
  p_workspace_key text,
  p_cursors jsonb
)
returns table (
  attachment_observation_id text,
  attachment_content_hash text,
  attachment_id text,
  connection_key text,
  source_cursor_version bigint,
  root_batch_id uuid,
  review_job_id uuid,
  review_job_state text,
  extraction_status text,
  extraction_method text,
  extraction_provenance text,
  filename text,
  mime_type text,
  raw_sha256 text,
  captured_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select unresolved.*
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  join jsonb_array_elements(p_cursors) cursor_item
    on cursor_item->>'sourceSystem' = 'gmail'
   and cursor_item->>'connectionKey' = unresolved.connection_key
   and unresolved.source_cursor_version <=
     (cursor_item->>'throughCursorVersion')::bigint;
$function$;

revoke all on function private.unresolved_gmail_attachment_extractions(text, jsonb)
  from public, anon, authenticated, service_role;

do $attachment_scope_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.seal_source_cut_pre_model_extraction(text,text,jsonb,jsonb,jsonb,jsonb,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := 'from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved;';
  v_new text := 'from private.unresolved_gmail_attachment_extractions(p_workspace_key,p_cursors) unresolved;';
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'attachment source-cut wrapper differs from the reviewed contract'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    execute v_updated;
  end if;
end;
$attachment_scope_rewrite$;

do $current_attachment_scope_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.seal_current_source_cut_pre_model_extraction(text,text,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved;$old$;
  v_new text := $new$  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key=p_workspace_key
      and required_source.source_system='gmail'
      and required_source.connection_key=unresolved.connection_key
  );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'current-cut attachment wrapper differs from the reviewed contract'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    execute v_updated;
  end if;
end;
$current_attachment_scope_rewrite$;

create or replace function private.run_truth_shadow_claim_acceptance_epoch(
  p_workspace_key text,
  p_obligation_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pending public.truth_pending_acceptance_epochs%rowtype;
  v_pending_job public.source_processing_jobs%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_existing public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_predecessor public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_candidate record;
  v_candidate_body jsonb;
  v_scope_hash text;
  v_shadow_claim_key text;
  v_chronology_at timestamptz;
  v_prior_head jsonb;
  v_heads jsonb := '{}'::jsonb;
  v_head_manifest jsonb := '[]'::jsonb;
  v_head_manifest_hash text;
  v_policy_eligible boolean;
  v_decision text;
  v_reasons jsonb;
  v_version_no integer;
  v_previous_claim_version_id text;
  v_supersessions jsonb;
  v_claim_request jsonb;
  v_claim_receipt jsonb;
  v_canonical_decision jsonb;
  v_decision_hash text;
  v_decision_version_id text;
  v_binding jsonb;
  v_binding_hash text;
  v_binding_id text;
  v_canonical_item jsonb;
  v_item_hash text;
  v_item_id text;
  v_items jsonb := '[]'::jsonb;
  v_decision_manifest jsonb;
  v_decision_manifest_hash text;
  v_frontier_jobs jsonb;
  v_frontier jsonb;
  v_frontier_hash text;
  v_receipt jsonb;
  v_receipt_hash text;
  v_epoch_id text;
  v_job_result jsonb;
  v_claim_job_count integer;
  v_membership_count integer;
  v_candidate_count integer;
  v_candidate_distinct_count integer;
  v_accepted_count integer := 0;
  v_rejected_count integer := 0;
  v_review_count integer := 0;
  v_ordinal integer := 0;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or coalesce(p_obligation_id, '')
      !~ '^pending-acceptance-epoch:v1:[0-9a-f]{64}$' then
    raise exception 'shadow acceptance epoch identity is invalid'
      using errcode = '22023';
  end if;

  -- Do not wait behind an overlapping cut writer. The caller can retry the same
  -- content-addressed obligation without consuming a source-processing attempt.
  if not pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:' || p_workspace_key, 0
  )) then
    return jsonb_build_object(
      'ok', true,
      'status', 'busy',
      'obligationId', p_obligation_id,
      'retryable', true,
      'productionPublicationAttempted', false
    );
  end if;

  select * into v_pending
  from public.truth_pending_acceptance_epochs pending
  where pending.workspace_key = p_workspace_key
    and pending.obligation_id = p_obligation_id
  for key share;
  if not found then
    raise exception 'pending shadow acceptance obligation is unavailable'
      using errcode = '23503';
  end if;

  select * into v_existing
  from public.truth_shadow_claim_acceptance_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.obligation_id = p_obligation_id;
  if found then
    select * into v_pending_job
    from public.source_processing_jobs job
    where job.workspace_key = p_workspace_key
      and job.job_id = v_existing.pending_job_id;
    if v_existing.obligation_hash is distinct from v_pending.obligation_hash
      or v_existing.root_batch_id is distinct from v_pending.root_batch_id
      or v_existing.source_cursor_version is distinct from v_pending.source_cursor_version
      or v_existing.source_cursor_value is distinct from v_pending.source_cursor_value
      or v_pending_job.state is distinct from 'succeeded'
      or v_pending_job.result->>'epochId' is distinct from v_existing.epoch_id
      or v_pending_job.result->>'epochReceiptHash' is distinct from v_existing.receipt_hash
      or v_existing.shadow_only is distinct from true
      or v_existing.production_eligible is distinct from false
      or v_existing.production_publication_attempted is distinct from false then
      raise exception 'completed shadow acceptance epoch failed replay validation'
        using errcode = '23514';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object(
      'ok', true,
      'status', 'succeeded',
      'idempotent', true,
      'epochId', v_existing.epoch_id,
      'epochReceiptHash', v_existing.receipt_hash
    );
  end if;

  if v_pending.source_system <> 'gmail'
    or v_pending.connection_key not like 'shadow-%'
    or exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = v_pending.workspace_key
        and required_source.source_system = v_pending.source_system
        and required_source.connection_key = v_pending.connection_key
    ) then
    raise exception 'candidate-v1 acceptance epoch is restricted to an unregistered shadow Gmail scope'
      using errcode = '42501';
  end if;

  select * into v_pending_job
  from public.source_processing_jobs job
  where job.workspace_key = p_workspace_key
    and job.job_id = v_pending.pending_job_id
  for update;
  if not found
    or v_pending_job.source_system is distinct from v_pending.source_system
    or v_pending_job.connection_key is distinct from v_pending.connection_key
    or v_pending_job.job_kind <> 'truth_sequence_claim_acceptance_epoch'
    or v_pending_job.source_object_id is distinct from v_pending.root_batch_id::text
    or v_pending_job.state <> 'waiting_runtime'
    or v_pending_job.attempt_count <> 0
    or v_pending_job.lease_owner is not null
    or v_pending_job.lease_expires_at is not null
    or v_pending_job.last_error_code <> 'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
    or v_pending_job.payload->>'obligationId' is distinct from v_pending.obligation_id
    or v_pending_job.payload->>'rootBatchId' is distinct from v_pending.root_batch_id::text
    or v_pending_job.payload->>'sourceCursorVersion'
      is distinct from v_pending.source_cursor_version::text
    or v_pending_job.payload->>'sourceCursorValue'
      is distinct from v_pending.source_cursor_value then
    raise exception 'pending shadow acceptance job differs from its immutable obligation'
      using errcode = '23514';
  end if;

  select * into v_batch
  from public.source_ingest_batches batch
  where batch.workspace_key = p_workspace_key
    and batch.batch_id = v_pending.root_batch_id;
  if not found
    or v_batch.source_system is distinct from v_pending.source_system
    or v_batch.connection_key is distinct from v_pending.connection_key
    or v_batch.status <> 'committed'
    or v_batch.committed_cursor_version is distinct from v_pending.source_cursor_version
    or v_batch.committed_cursor_value is distinct from v_pending.source_cursor_value
    or not exists (
      select 1
      from public.source_cursors cursor_row
      where cursor_row.workspace_key = p_workspace_key
        and cursor_row.source_system = v_pending.source_system
        and cursor_row.connection_key = v_pending.connection_key
        and cursor_row.cursor_version = v_pending.source_cursor_version
        and cursor_row.cursor_value = v_pending.source_cursor_value
        and cursor_row.last_batch_id = v_pending.root_batch_id
        and cursor_row.status = 'live'
    ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'SHADOW_ROOT_CURSOR_NOT_CURRENT',
      'productionPublicationAttempted', false
    );
  end if;

  if not exists (
      select 1
      from public.gmail_parse_checkpoints checkpoint
      where checkpoint.workspace_key = p_workspace_key
        and checkpoint.root_batch_id = v_pending.root_batch_id
        and checkpoint.connection_key = v_pending.connection_key
        and checkpoint.source_cursor_version = v_pending.source_cursor_version
        and checkpoint.source_cursor_value = v_pending.source_cursor_value
    ) or not exists (
      select 1
      from public.truth_gmail_link_epochs link_epoch
      join public.truth_gmail_link_epoch_seals link_seal
        on link_seal.workspace_key = link_epoch.workspace_key
       and link_seal.epoch_id = link_epoch.epoch_id
      where link_epoch.workspace_key = p_workspace_key
        and link_epoch.root_batch_id = v_pending.root_batch_id
        and link_epoch.connection_key = v_pending.connection_key
    ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'PARSE_OR_LINK_EPOCH_NOT_SEALED',
      'productionPublicationAttempted', false
    );
  end if;

  -- Attachment/review parents can create later claim children. Do not certify a
  -- frontier while any such producer is still nonterminal.
  if exists (
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.job_id = job.job_id
     and lineage.workspace_key = job.workspace_key
    where job.workspace_key = p_workspace_key
      and lineage.root_batch_id = v_pending.root_batch_id
      and job.job_kind = any(array[
        'gmail_materialize_message_revision',
        'gmail_parse_rfc822',
        'gmail_parse_message',
        'gmail_extract_attachment',
        'gmail_review_attachment_extraction'
      ])
      and job.state not in ('succeeded', 'superseded')
  ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'CLAIM_PRODUCER_FRONTIER_OPEN',
      'productionPublicationAttempted', false
    );
  end if;

  if exists (
    select 1
    from public.truth_pending_acceptance_epochs prior
    where prior.workspace_key = p_workspace_key
      and prior.source_system = v_pending.source_system
      and prior.connection_key = v_pending.connection_key
      and prior.source_cursor_version < v_pending.source_cursor_version
      and not exists (
        select 1
        from public.truth_shadow_claim_acceptance_epochs completed
        where completed.workspace_key = prior.workspace_key
          and completed.obligation_id = prior.obligation_id
          and completed.obligation_hash = prior.obligation_hash
      )
  ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'EARLIER_ACCEPTANCE_EPOCH_INCOMPLETE',
      'productionPublicationAttempted', false
    );
  end if;

  select count(*)::integer into v_claim_job_count
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.job_id = job.job_id
   and lineage.workspace_key = job.workspace_key
  where job.workspace_key = p_workspace_key
    and job.source_system = v_pending.source_system
    and job.connection_key = v_pending.connection_key
    and lineage.root_batch_id = v_pending.root_batch_id
    and job.job_kind = any(array[
      'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
    ]);
  select count(*)::integer into v_membership_count
  from public.truth_pending_acceptance_epoch_manifests membership
  where membership.workspace_key = p_workspace_key
    and membership.obligation_id = p_obligation_id;
  if v_claim_job_count = 0
    or v_claim_job_count <> v_membership_count
    or exists (
      select 1
      from public.source_processing_jobs job
      join public.source_processing_job_lineage lineage
        on lineage.job_id = job.job_id
       and lineage.workspace_key = job.workspace_key
      left join public.candidate_claim_job_manifests manifest
        on manifest.workspace_key = job.workspace_key
       and manifest.job_id = job.job_id
      left join public.truth_pending_acceptance_epoch_manifests membership
        on membership.workspace_key = job.workspace_key
       and membership.obligation_id = p_obligation_id
       and membership.source_job_id = job.job_id
      where job.workspace_key = p_workspace_key
        and job.source_system = v_pending.source_system
        and job.connection_key = v_pending.connection_key
        and lineage.root_batch_id = v_pending.root_batch_id
        and job.job_kind = any(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
        ])
        and (
          job.state <> 'succeeded'
          or manifest.job_id is null
          or membership.source_job_id is null
          or manifest.source_observation_id is distinct from job.observation_id
          or membership.source_observation_id is distinct from job.observation_id
          or membership.candidate_count is distinct from manifest.candidate_count
          or membership.candidate_manifest_hash is distinct from manifest.manifest_hash
        )
    ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'CLAIM_FRONTIER_MANIFEST_INCOMPLETE',
      'claimJobCount', v_claim_job_count,
      'manifestCount', v_membership_count,
      'productionPublicationAttempted', false
    );
  end if;

  if exists (
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.source_processing_jobs job
      on job.workspace_key = membership.workspace_key
     and job.job_id = membership.source_job_id
    join public.source_observations observation
      on observation.workspace_key = membership.workspace_key
     and observation.observation_id = membership.source_observation_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = membership.workspace_key
     and manifest.job_id = membership.source_job_id
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
      and (
        membership.source_observation_content_hash is distinct from observation.content_hash
        or membership.candidate_manifest_hash is distinct from encode(extensions.digest(
          convert_to(manifest.canonical_manifest::text, 'UTF8'), 'sha256'
        ), 'hex')
        or membership.membership_hash is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(membership.canonical_membership), 'UTF8'
        ), 'sha256'), 'hex')
        or membership.worker_result_hash is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.result - array[
            'truthPlan', 'completionHash', 'resultObservationIds', 'childJobs',
            'rootBatchId', 'sourceCursorVersion', 'sourceCursorValue'
          ]::text[]), 'UTF8'
        ), 'sha256'), 'hex')
        or manifest.candidate_count is distinct from
          jsonb_array_length(manifest.canonical_manifest->'candidates')
      )
  ) then
    raise exception 'shadow acceptance frontier failed immutable hash validation'
      using errcode = '23514';
  end if;

  select count(*)::integer,
         count(distinct candidate.candidate_claim_version_id)::integer
  into v_candidate_count, v_candidate_distinct_count
  from public.truth_pending_acceptance_epoch_manifests membership
  join public.candidate_claim_job_manifests manifest
    on manifest.workspace_key = membership.workspace_key
   and manifest.job_id = membership.source_job_id
  join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
    on true
  join public.candidate_claim_envelopes candidate
    on candidate.candidate_claim_version_id = item->>'candidateClaimVersionId'
   and candidate.envelope_hash = item->>'itemHash'
   and candidate.workspace_key = membership.workspace_key
  join public.candidate_claim_job_lineage candidate_lineage
    on candidate_lineage.candidate_claim_version_id = candidate.candidate_claim_version_id
   and candidate_lineage.job_id = membership.source_job_id
   and candidate_lineage.source_observation_id = membership.source_observation_id
  where membership.workspace_key = p_workspace_key
    and membership.obligation_id = p_obligation_id;
  if v_candidate_count <> v_candidate_distinct_count
    or v_candidate_count <> (
      select coalesce(sum(membership.candidate_count), 0)::integer
      from public.truth_pending_acceptance_epoch_manifests membership
      where membership.workspace_key = p_workspace_key
        and membership.obligation_id = p_obligation_id
    )
    or v_candidate_count > 5000 then
    raise exception 'shadow acceptance frontier candidate set is incomplete, duplicated, or unbounded'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.candidate_claim_job_lineage lineage
      on lineage.job_id = membership.source_job_id
    join public.candidate_claim_decisions decision_row
      on decision_row.candidate_claim_version_id = lineage.candidate_claim_version_id
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
  ) then
    raise exception 'shadow acceptance frontier already has a legacy decision authority'
      using errcode = '55000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceJobId', membership.source_job_id,
    'sourceObservationId', membership.source_observation_id,
    'sourceObservationContentHash', membership.source_observation_content_hash,
    'candidateCount', membership.candidate_count,
    'candidateManifestHash', membership.candidate_manifest_hash,
    'workerResultHash', membership.worker_result_hash,
    'membershipHash', membership.membership_hash
  ) order by membership.source_job_id), '[]'::jsonb)
  into v_frontier_jobs
  from public.truth_pending_acceptance_epoch_manifests membership
  where membership.workspace_key = p_workspace_key
    and membership.obligation_id = p_obligation_id;
  v_frontier := jsonb_build_object(
    'schemaVersion', 'truth-shadow-claim-frontier-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', v_pending.source_system,
    'connectionKey', v_pending.connection_key,
    'rootBatchId', v_pending.root_batch_id,
    'sourceCursorVersion', v_pending.source_cursor_version,
    'sourceCursorValue', v_pending.source_cursor_value,
    'obligationId', v_pending.obligation_id,
    'obligationHash', v_pending.obligation_hash,
    'candidateCount', v_candidate_count,
    'sourceManifests', v_frontier_jobs
  );
  v_frontier_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_frontier), 'UTF8'
  ), 'sha256'), 'hex');
  v_scope_hash := private.truth_shadow_claim_scope_hash(
    p_workspace_key, v_pending.source_system, v_pending.connection_key
  );

  select * into v_predecessor
  from public.truth_shadow_claim_acceptance_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.source_system = v_pending.source_system
    and epoch.connection_key = v_pending.connection_key
    and epoch.source_cursor_version < v_pending.source_cursor_version
  order by epoch.source_cursor_version desc, epoch.epoch_id desc
  limit 1;
  if found then
    select coalesce(jsonb_object_agg(
      head->>'originalClaimKey', head
    ), '{}'::jsonb)
    into v_heads
    from jsonb_array_elements(v_predecessor.head_manifest) head;
  end if;

  for v_candidate in
    select
      membership.source_job_id,
      candidate.*,
      observation.source_recorded_at,
      observation.captured_at as observation_captured_at,
      observation.journal_seq
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = membership.workspace_key
     and manifest.job_id = membership.source_job_id
    join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      on true
    join public.candidate_claim_envelopes candidate
      on candidate.candidate_claim_version_id = item->>'candidateClaimVersionId'
     and candidate.envelope_hash = item->>'itemHash'
     and candidate.workspace_key = membership.workspace_key
    join public.source_observations observation
      on observation.workspace_key = candidate.workspace_key
     and observation.observation_id = candidate.source_observation_id
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
    order by
      coalesce(
        nullif(candidate.canonical_envelope->'candidate'->>'occurredAt', '')::timestamptz,
        observation.source_recorded_at,
        observation.captured_at
      ),
      observation.journal_seq,
      membership.source_job_id,
      candidate.candidate_claim_version_id
  loop
    v_candidate_body := v_candidate.canonical_envelope->'candidate';
    v_chronology_at := coalesce(
      nullif(v_candidate_body->>'occurredAt', '')::timestamptz,
      v_candidate.source_recorded_at,
      v_candidate.observation_captured_at
    );
    v_shadow_claim_key := 'shadow:v1:' || v_scope_hash || ':' ||
      (v_candidate_body->>'claimKey');
    v_policy_eligible :=
      v_candidate.extraction_method = 'deterministic'
      and v_candidate.recommendation = 'accept'
      and v_candidate.source_review_required = false
      and v_candidate.ambiguity_status = 'none'
      and v_candidate.contradiction_status = 'none'
      and coalesce(v_candidate_body->'normalizedValue'->'temporal'->>'status', '')
        not in ('ambiguous', 'future_conflict')
      and jsonb_array_length(coalesce(
        v_candidate_body->'ambiguity'->'reasons', '[]'::jsonb
      )) = 0
      and jsonb_array_length(coalesce(
        v_candidate_body->'contradiction'->'acceptedClaimVersionIds', '[]'::jsonb
      )) = 0
      and jsonb_array_length(coalesce(
        v_candidate_body->'contradiction'->'reasons', '[]'::jsonb
      )) = 0
      and v_candidate_body->'acceptanceRecommendation'->>'method' = 'policy'
      and v_candidate_body->'acceptanceRecommendation'->>'decision' = 'accept'
      and v_candidate.source_object_type = any(array[
        'gmail_message_parsed', 'gmail_attachment_extracted'
      ])
      and (
        v_candidate.source_object_type <> 'gmail_attachment_extracted'
        or v_candidate.source_extraction_method = any(array[
          'pdf-text+quality-v1', 'utf8-text-v1', 'html-to-text-v1'
        ])
      )
      and exists (
        select 1
        from public.candidate_claim_predicate_registry registry
        where registry.predicate = v_candidate_body->>'predicate'
          and registry.extractor_version = v_candidate_body->>'extractorVersion'
          and registry.source_system = 'gmail'
          and registry.gate = v_candidate_body->>'gate'
          and registry.acceptance_policy_version =
            v_candidate.recommendation_policy_version
          and registry.statuses->>(v_candidate_body->>'polarity') =
            v_candidate_body->'normalizedValue'->>'status'
          and registry.effects->>(v_candidate_body->>'polarity') =
            v_candidate_body->'normalizedValue'->>'effect'
      );

    if not (v_heads ? (v_candidate_body->>'claimKey')) then
      v_prior_head := null;
      select jsonb_build_object(
        'originalClaimKey', item.original_claim_key,
        'shadowClaimKey', item.shadow_claim_key,
        'claimVersionId', claim.claim_version_id,
        'claimItemHash', claim.claim_content_hash,
        'versionNo', claim.version_no,
        'polarity', claim.polarity,
        'normalizedValue', claim.normalized_value,
        'chronologyAt', private.canonical_truth_timestamp(item.chronology_at),
        'epochItemId', item.item_id,
        'epochItemHash', item.item_hash
      ) into v_prior_head
      from public.truth_shadow_claim_acceptance_epoch_items item
      join public.truth_shadow_claim_acceptance_epochs epoch
        on epoch.epoch_id = item.epoch_id
      join public.accepted_claims claim
        on claim.claim_version_id = item.accepted_claim_version_id
      where epoch.workspace_key = p_workspace_key
        and epoch.source_system = v_pending.source_system
        and epoch.connection_key = v_pending.connection_key
        and item.original_claim_key = v_candidate_body->>'claimKey'
        and item.decision = 'accept'
      order by claim.version_no desc
      limit 1;
      v_heads := jsonb_set(
        v_heads,
        array[v_candidate_body->>'claimKey'],
        coalesce(v_prior_head, 'null'::jsonb),
        true
      );
    end if;
    v_prior_head := v_heads->(v_candidate_body->>'claimKey');

    if not v_policy_eligible then
      v_decision := 'review';
      v_reasons := jsonb_build_array('SHADOW_CANDIDATE_V1_POLICY_REVIEW');
    elsif jsonb_typeof(v_prior_head) = 'object'
      and v_prior_head->>'polarity' is not distinct from v_candidate_body->>'polarity'
      and v_prior_head->'normalizedValue' is not distinct from
        v_candidate_body->'normalizedValue' then
      v_decision := 'reject';
      v_reasons := jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT');
    elsif jsonb_typeof(v_prior_head) = 'object'
      and v_chronology_at <= (v_prior_head->>'chronologyAt')::timestamptz then
      v_decision := 'review';
      v_reasons := jsonb_build_array('NON_MONOTONIC_SHADOW_CHRONOLOGY');
    else
      v_decision := 'accept';
      v_reasons := jsonb_build_array('DETERMINISTIC_SHADOW_POLICY_ACCEPT');
    end if;

    v_claim_request := null;
    v_claim_receipt := null;
    v_binding := null;
    v_binding_hash := '';
    v_binding_id := null;
    if v_decision = 'accept' then
      v_version_no := case
        when jsonb_typeof(v_prior_head) = 'object'
          then (v_prior_head->>'versionNo')::integer + 1
        else 1
      end;
      v_previous_claim_version_id := case
        when jsonb_typeof(v_prior_head) = 'object'
          then v_prior_head->>'claimVersionId'
        else null
      end;
      v_supersessions := case
        when v_previous_claim_version_id is null then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object(
          'supersededClaimVersionId', v_previous_claim_version_id,
          'relationship', case
            when v_prior_head->>'polarity' is distinct from v_candidate_body->>'polarity'
              then 'contradicts'
            else 'corrects'
          end,
          'policyVersion', v_candidate.recommendation_policy_version
        ))
      end;
      v_claim_request := jsonb_build_object(
        'claim', jsonb_build_object(
          'claimKey', v_shadow_claim_key,
          'versionNo', v_version_no,
          'previousClaimVersionId', v_previous_claim_version_id,
          'primaryObservationId', v_candidate.source_observation_id,
          'subjectType', v_candidate_body->>'subjectType',
          'subjectKey', v_candidate_body->>'subjectKey',
          'predicate', v_candidate_body->>'predicate',
          'gate', v_candidate_body->>'gate',
          'polarity', v_candidate_body->>'polarity',
          'normalizedValue', v_candidate_body->'normalizedValue',
          'occurredAt', v_candidate_body->'occurredAt',
          'confidence', v_candidate_body->'confidence',
          'confidenceLabel', v_candidate_body->>'confidenceLabel',
          'extractionMethod', v_candidate_body->>'extractionMethod',
          'extractorVersion', v_candidate_body->>'extractorVersion',
          'promptVersion', coalesce(v_candidate_body->>'promptVersion', ''),
          'model', coalesce(v_candidate_body->>'model', ''),
          'acceptanceMethod', 'policy',
          'acceptancePolicyVersion', v_candidate.recommendation_policy_version,
          'acceptedBy', 'truth-shadow-acceptance-epoch-v1',
          'decision', 'accepted',
          'evidenceSpan', v_candidate_body->'evidenceSpan',
          'recordedAt', private.canonical_truth_timestamp(v_chronology_at),
          'schemaVersion', 'candidate-accepted-claim-v1'
        ),
        'evidence', jsonb_build_array(jsonb_build_object(
          'observationId', v_candidate.source_observation_id,
          'evidenceRole', 'primary',
          'evidenceSpan', v_candidate_body->'evidenceSpan'
        )),
        'supersessions', v_supersessions
      );
    end if;

    v_canonical_decision := jsonb_build_object(
      'decisionSchemaVersion', 'candidate-claim-decision-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
      'candidateItemHash', v_candidate.envelope_hash,
      'decision', jsonb_build_object(
        'decisionNo', 1,
        'previousDecisionVersionId', '',
        'decision', v_decision,
        'method', 'policy',
        'policyVersion', v_candidate.recommendation_policy_version,
        'decidedBy', 'truth-shadow-acceptance-epoch-v1',
        'reasons', v_reasons,
        'acceptedClaimRequest', v_claim_request
      )
    );
    v_decision_hash := encode(extensions.digest(convert_to(
      v_canonical_decision::text, 'UTF8'
    ), 'sha256'), 'hex');
    v_decision_version_id := 'candidate-decision:v1:' || v_decision_hash;
    insert into public.candidate_claim_decisions (
      decision_version_id, candidate_claim_version_id, decision_no,
      previous_decision_version_id, decision, decision_method, policy_version,
      decided_by, reasons, accepted_claim_request, decision_hash,
      decision_schema_version, canonical_decision
    ) values (
      v_decision_version_id, v_candidate.candidate_claim_version_id, 1,
      null, v_decision, 'policy', v_candidate.recommendation_policy_version,
      'truth-shadow-acceptance-epoch-v1', v_reasons, v_claim_request,
      v_decision_hash, 'candidate-claim-decision-v1', v_canonical_decision
    );

    if v_decision = 'accept' then
      v_claim_receipt := private.append_accepted_claim_source_chronology(
        p_workspace_key,
        v_claim_request->'claim',
        v_claim_request->'evidence',
        v_claim_request->'supersessions',
        p_sync_token
      );
      v_binding := jsonb_build_object(
        'bindingSchemaVersion', 'candidate-claim-acceptance-binding-v1',
        'workspaceKey', p_workspace_key,
        'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
        'candidateItemHash', v_candidate.envelope_hash,
        'decisionVersionId', v_decision_version_id,
        'decisionItemHash', v_decision_hash,
        'acceptedClaimVersionId', v_claim_receipt->>'claimVersionId',
        'acceptedClaimItemHash', v_claim_receipt->>'itemHash'
      );
      v_binding_hash := encode(extensions.digest(convert_to(
        v_binding::text, 'UTF8'
      ), 'sha256'), 'hex');
      v_binding_id := 'candidate-acceptance:v1:' || v_binding_hash;
      insert into public.candidate_claim_acceptance_bindings (
        binding_id, candidate_claim_version_id, decision_version_id,
        accepted_claim_version_id, binding_hash, binding_schema_version,
        canonical_binding
      ) values (
        v_binding_id, v_candidate.candidate_claim_version_id,
        v_decision_version_id, v_claim_receipt->>'claimVersionId',
        v_binding_hash, 'candidate-claim-acceptance-binding-v1', v_binding
      );
      v_accepted_count := v_accepted_count + 1;
    elsif v_decision = 'reject' then
      v_rejected_count := v_rejected_count + 1;
    else
      v_review_count := v_review_count + 1;
    end if;

    v_canonical_item := jsonb_build_object(
      'schemaVersion', 'truth-shadow-claim-acceptance-epoch-item-v1',
      'workspaceKey', p_workspace_key,
      'obligationId', p_obligation_id,
      'ordinal', v_ordinal,
      'sourceJobId', v_candidate.source_job_id,
      'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
      'candidateItemHash', v_candidate.envelope_hash,
      'originalClaimKey', v_candidate_body->>'claimKey',
      'shadowClaimKey', v_shadow_claim_key,
      'chronologyAt', private.canonical_truth_timestamp(v_chronology_at),
      'decision', v_decision,
      'reasonCodes', v_reasons,
      'decisionVersionId', v_decision_version_id,
      'decisionItemHash', v_decision_hash,
      'acceptedClaimVersionId', coalesce(v_claim_receipt->>'claimVersionId', ''),
      'acceptedClaimItemHash', coalesce(v_claim_receipt->>'itemHash', ''),
      'bindingId', coalesce(v_binding_id, ''),
      'bindingItemHash', coalesce(v_binding_hash, '')
    );
    v_item_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical_item), 'UTF8'
    ), 'sha256'), 'hex');
    v_item_id := 'truth-shadow-acceptance-item:v1:' || v_item_hash;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id,
      'itemHash', v_item_hash,
      'canonicalItem', v_canonical_item
    ));
    if v_decision = 'accept' then
      v_heads := jsonb_set(v_heads, array[v_candidate_body->>'claimKey'], jsonb_build_object(
        'originalClaimKey', v_candidate_body->>'claimKey',
        'shadowClaimKey', v_shadow_claim_key,
        'claimVersionId', v_claim_receipt->>'claimVersionId',
        'claimItemHash', v_claim_receipt->>'itemHash',
        'versionNo', v_version_no,
        'polarity', v_candidate_body->>'polarity',
        'normalizedValue', v_candidate_body->'normalizedValue',
        'chronologyAt', private.canonical_truth_timestamp(v_chronology_at),
        'epochItemId', v_item_id,
        'epochItemHash', v_item_hash
      ), true);
    end if;
    v_ordinal := v_ordinal + 1;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId',
    'itemHash', item->>'itemHash',
    'candidateClaimVersionId', item #>> '{canonicalItem,candidateClaimVersionId}',
    'decision', item #>> '{canonicalItem,decision}',
    'acceptedClaimVersionId', item #>> '{canonicalItem,acceptedClaimVersionId}'
  ) order by (item #>> '{canonicalItem,ordinal}')::integer), '[]'::jsonb)
  into v_decision_manifest
  from jsonb_array_elements(v_items) item;
  v_decision_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_decision_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  select coalesce(jsonb_agg(value order by key), '[]'::jsonb)
  into v_head_manifest
  from jsonb_each(v_heads) head(key, value)
  where jsonb_typeof(value) = 'object';
  v_head_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_head_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  v_receipt := jsonb_build_object(
    'schemaVersion', 'truth-shadow-claim-acceptance-epoch-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', v_pending.source_system,
    'connectionKey', v_pending.connection_key,
    'rootBatchId', v_pending.root_batch_id,
    'sourceCursorVersion', v_pending.source_cursor_version,
    'sourceCursorValue', v_pending.source_cursor_value,
    'pendingJobId', v_pending.pending_job_id,
    'obligationId', v_pending.obligation_id,
    'obligationHash', v_pending.obligation_hash,
    'predecessorEpochId', coalesce(v_predecessor.epoch_id, ''),
    'predecessorEpochHash', coalesce(v_predecessor.receipt_hash, ''),
    'frontierManifestHash', v_frontier_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'headManifestHash', v_head_manifest_hash,
    'candidateCount', v_candidate_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'reviewCount', v_review_count,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
  v_receipt_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt), 'UTF8'
  ), 'sha256'), 'hex');
  v_epoch_id := 'truth-shadow-acceptance-epoch:v1:' || v_receipt_hash;

  insert into public.truth_shadow_claim_acceptance_epochs (
    epoch_id, workspace_key, source_system, connection_key, root_batch_id,
    source_cursor_version, source_cursor_value, pending_job_id, obligation_id,
    obligation_hash, predecessor_epoch_id, predecessor_epoch_hash,
    frontier_manifest, frontier_manifest_hash, decision_manifest,
    decision_manifest_hash, head_manifest, head_manifest_hash,
    candidate_count, accepted_count, rejected_count, review_count,
    canonical_receipt, receipt_hash, schema_version, shadow_only,
    production_eligible, production_publication_attempted
  ) values (
    v_epoch_id, p_workspace_key, v_pending.source_system, v_pending.connection_key,
    v_pending.root_batch_id, v_pending.source_cursor_version,
    v_pending.source_cursor_value, v_pending.pending_job_id,
    v_pending.obligation_id, v_pending.obligation_hash,
    v_predecessor.epoch_id, coalesce(v_predecessor.receipt_hash, ''),
    v_frontier, v_frontier_hash, v_decision_manifest,
    v_decision_manifest_hash, v_head_manifest, v_head_manifest_hash,
    v_candidate_count, v_accepted_count, v_rejected_count, v_review_count,
    v_receipt, v_receipt_hash, 'truth-shadow-claim-acceptance-epoch-v1',
    true, false, false
  );

  insert into public.truth_shadow_claim_acceptance_epoch_items (
    item_id, epoch_id, workspace_key, obligation_id, ordinal, source_job_id,
    candidate_claim_version_id, candidate_item_hash, original_claim_key,
    shadow_claim_key, chronology_at, decision, reason_codes,
    decision_version_id, decision_item_hash, accepted_claim_version_id,
    accepted_claim_item_hash, binding_id, binding_item_hash,
    canonical_item, item_hash, schema_version
  )
  select
    item->>'itemId', v_epoch_id, p_workspace_key, p_obligation_id,
    (item #>> '{canonicalItem,ordinal}')::integer,
    (item #>> '{canonicalItem,sourceJobId}')::uuid,
    item #>> '{canonicalItem,candidateClaimVersionId}',
    item #>> '{canonicalItem,candidateItemHash}',
    item #>> '{canonicalItem,originalClaimKey}',
    item #>> '{canonicalItem,shadowClaimKey}',
    (item #>> '{canonicalItem,chronologyAt}')::timestamptz,
    item #>> '{canonicalItem,decision}',
    item #> '{canonicalItem,reasonCodes}',
    item #>> '{canonicalItem,decisionVersionId}',
    item #>> '{canonicalItem,decisionItemHash}',
    nullif(item #>> '{canonicalItem,acceptedClaimVersionId}', ''),
    item #>> '{canonicalItem,acceptedClaimItemHash}',
    nullif(item #>> '{canonicalItem,bindingId}', ''),
    item #>> '{canonicalItem,bindingItemHash}',
    item->'canonicalItem', item->>'itemHash',
    'truth-shadow-claim-acceptance-epoch-item-v1'
  from jsonb_array_elements(v_items) item;

  v_job_result := jsonb_build_object(
    'schemaVersion', 'truth-claim-acceptance-epoch-result-v1',
    'epochId', v_epoch_id,
    'epochReceiptHash', v_receipt_hash,
    'frontierManifestHash', v_frontier_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'headManifestHash', v_head_manifest_hash,
    'candidateCount', v_candidate_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'reviewCount', v_review_count,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
  update public.source_processing_jobs job
  set state = 'succeeded',
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = '',
      safe_error_detail = '',
      processor_version = 'truth-shadow-acceptance-epoch-v1',
      result = v_job_result,
      updated_at = clock_timestamp(),
      completed_at = clock_timestamp()
  where job.job_id = v_pending.pending_job_id
    and job.workspace_key = p_workspace_key
    and job.state = 'waiting_runtime'
    and job.attempt_count = 0
    and job.last_error_code = 'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED';
  if not found then
    raise exception 'pending shadow acceptance job changed during epoch commit'
      using errcode = '40001';
  end if;

  return v_receipt || jsonb_build_object(
    'ok', true,
    'status', 'succeeded',
    'idempotent', false,
    'epochId', v_epoch_id,
    'epochReceiptHash', v_receipt_hash
  );
end;
$function$;

create or replace function public.run_truth_shadow_claim_acceptance_epoch(
  p_workspace_key text,
  p_obligation_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '250s'
as $function$
  select private.run_truth_shadow_claim_acceptance_epoch(
    p_workspace_key, p_obligation_id, p_sync_token
  );
$function$;

revoke all on function private.run_truth_shadow_claim_acceptance_epoch(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.run_truth_shadow_claim_acceptance_epoch(text, text, text)
  from public, anon, authenticated;
grant execute on function public.run_truth_shadow_claim_acceptance_epoch(text, text, text)
  to service_role;

-- Once a frontier is sealed, later membership insertion would make the receipt
-- stale. The coordinator's completeness precondition makes this trigger a hard
-- invariant rather than a normal runtime branch.
create or replace function private.reject_shadow_acceptance_membership_after_epoch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.truth_shadow_claim_acceptance_epochs epoch
    where epoch.workspace_key = new.workspace_key
      and epoch.obligation_id = new.obligation_id
  ) then
    raise exception 'completed shadow acceptance frontier cannot gain a later manifest'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_pending_acceptance_manifest_after_epoch
  on public.truth_pending_acceptance_epoch_manifests;
create trigger truth_pending_acceptance_manifest_after_epoch
before insert on public.truth_pending_acceptance_epoch_manifests
for each row execute function private.reject_shadow_acceptance_membership_after_epoch();
revoke all on function private.reject_shadow_acceptance_membership_after_epoch()
  from public, anon, authenticated, service_role;

-- Pending rows are immutable evidence. They stop blocking only when an exact
-- completed epoch receipt covers the same obligation, root, cursor and job.
create or replace function private.reject_truth_cut_or_build_with_pending_epoch_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_table_name = 'source_cut_cursors' and exists (
    select 1
    from public.source_cuts cut
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key = cut.workspace_key
     and pending.source_system = to_jsonb(new)->>'source_system'
     and pending.connection_key = to_jsonb(new)->>'connection_key'
     and pending.source_cursor_version <=
       (to_jsonb(new)->>'through_cursor_version')::bigint
    where cut.source_cut_id = new.source_cut_id
      and not exists (
        select 1
        from public.truth_shadow_claim_acceptance_epochs epoch
        join public.source_processing_jobs epoch_job
          on epoch_job.workspace_key = epoch.workspace_key
         and epoch_job.job_id = epoch.pending_job_id
        where epoch.workspace_key = pending.workspace_key
          and epoch.obligation_id = pending.obligation_id
          and epoch.obligation_hash = pending.obligation_hash
          and epoch.root_batch_id = pending.root_batch_id
          and epoch.source_cursor_version = pending.source_cursor_version
          and epoch.source_cursor_value = pending.source_cursor_value
          and epoch.pending_job_id = pending.pending_job_id
          and epoch_job.state = 'succeeded'
          and epoch_job.result->>'epochId' = epoch.epoch_id
          and epoch_job.result->>'epochReceiptHash' = epoch.receipt_hash
          and epoch.production_publication_attempted = false
      )
  ) then
    raise exception 'source cut is waiting for a canonical acceptance epoch'
      using errcode = '55000';
  elsif tg_table_name = 'truth_builds' and exists (
    select 1
    from public.source_cuts cut
    join public.source_cut_cursors cursor_row
      on cursor_row.source_cut_id = cut.source_cut_id
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key = cut.workspace_key
     and pending.source_system = cursor_row.source_system
     and pending.connection_key = cursor_row.connection_key
     and pending.source_cursor_version <= cursor_row.through_cursor_version
    where cut.source_cut_id = new.source_cut_id
      and not exists (
        select 1
        from public.truth_shadow_claim_acceptance_epochs epoch
        join public.source_processing_jobs epoch_job
          on epoch_job.workspace_key = epoch.workspace_key
         and epoch_job.job_id = epoch.pending_job_id
        where epoch.workspace_key = pending.workspace_key
          and epoch.obligation_id = pending.obligation_id
          and epoch.obligation_hash = pending.obligation_hash
          and epoch.root_batch_id = pending.root_batch_id
          and epoch.source_cursor_version = pending.source_cursor_version
          and epoch.source_cursor_value = pending.source_cursor_value
          and epoch.pending_job_id = pending.pending_job_id
          and epoch_job.state = 'succeeded'
          and epoch_job.result->>'epochId' = epoch.epoch_id
          and epoch_job.result->>'epochReceiptHash' = epoch.receipt_hash
          and epoch.production_publication_attempted = false
      )
  ) then
    raise exception 'truth build is waiting for a canonical acceptance epoch'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

revoke all on function private.reject_truth_cut_or_build_with_pending_epoch_v1()
  from public, anon, authenticated, service_role;

-- Epoch-origin claims are visible only to extraction jobs on their exact source
-- connection. This prevents global accepted_claims identities from entering the
-- canonical primary Gmail context while preserving normal pre-epoch claims.
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
  );
$function$;

revoke all on function private.truth_shadow_claim_visible_to_connection(
  text, text, text, text
) from public, anon, authenticated, service_role;

do $claim_context_scope_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.load_truth_claim_worker_context(text,uuid,text,bigint,text,integer,text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$  where claim.decision = 'accepted'$old$;
  v_new text := $new$  where claim.decision = 'accepted'
    and private.truth_shadow_claim_visible_to_connection(
      claim.claim_version_id,
      p_workspace_key,
      v_job.source_system,
      v_job.connection_key
    )$new$;
  v_occurrences integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_old, ''))
  ) / length(v_old);
  if position('truth_shadow_claim_visible_to_connection' in v_definition) = 0 then
    if v_occurrences <> 2 then
      raise exception 'claim context accepted-claim queries differ from the reviewed contract'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition or (
      length(v_updated) - length(replace(
        v_updated, 'truth_shadow_claim_visible_to_connection', ''
      ))
    ) / length('truth_shadow_claim_visible_to_connection') <> 2 then
      raise exception 'claim context shadow-scope rewrite is incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif (
    length(v_definition) - length(replace(
      v_definition, 'truth_shadow_claim_visible_to_connection', ''
    ))
  ) / length('truth_shadow_claim_visible_to_connection') <> 2 then
    raise exception 'claim context shadow visibility filter is partially installed'
      using errcode = '23514';
  end if;
end;
$claim_context_scope_rewrite$;

create or replace function private.register_truth_shadow_root_source_cut(
  p_source_cut_id text
)
returns public.truth_shadow_root_source_cuts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cut public.source_cuts%rowtype;
  v_cursor public.source_cut_cursors%rowtype;
  v_latest_epoch public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_epoch_manifest jsonb;
  v_epoch_manifest_hash text;
  v_scope jsonb;
  v_scope_hash text;
  v_existing public.truth_shadow_root_source_cuts%rowtype;
begin
  select * into strict v_cut
  from public.source_cuts cut
  where cut.source_cut_id = p_source_cut_id;
  select * into strict v_cursor
  from public.source_cut_cursors cursor_row
  where cursor_row.source_cut_id = p_source_cut_id
    and cursor_row.source_system = 'gmail'
    and cursor_row.connection_key like 'shadow-%';

  if jsonb_array_length(v_cut.required_sources) <> 1
    or jsonb_array_length(v_cut.manifest->'cursors') <> 1
    or v_cut.required_sources #>> '{0,sourceSystem}' <> 'gmail'
    or v_cut.required_sources #>> '{0,connectionKey}'
      is distinct from v_cursor.connection_key
    or v_cut.manifest #>> '{cursors,0,sourceSystem}' <> 'gmail'
    or v_cut.manifest #>> '{cursors,0,connectionKey}'
      is distinct from v_cursor.connection_key
    or v_cut.manifest #>> '{cursors,0,throughCursorVersion}'
      is distinct from v_cursor.through_cursor_version::text
    or v_cut.manifest #>> '{cursors,0,throughCursorValue}'
      is distinct from v_cursor.through_cursor_value then
    raise exception 'shadow Gmail source cut must be an exact one-source vector'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.source_cut_cursors other_cursor
    where other_cursor.source_cut_id = p_source_cut_id
      and (other_cursor.source_system, other_cursor.connection_key)
        is distinct from ('gmail'::text, v_cursor.connection_key)
  ) then
    raise exception 'shadow Gmail source cut cannot be mixed with another source vector'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key = v_cut.workspace_key
      and required_source.source_system = 'gmail'
      and required_source.connection_key = v_cursor.connection_key
  ) then
    raise exception 'registered canonical Gmail source cannot use shadow cut authority'
      using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.truth_pending_acceptance_epochs pending
    where pending.workspace_key = v_cut.workspace_key
      and pending.source_system = 'gmail'
      and pending.connection_key = v_cursor.connection_key
      and pending.source_cursor_version <= v_cursor.through_cursor_version
      and not exists (
        select 1
        from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key = pending.workspace_key
          and epoch.obligation_id = pending.obligation_id
          and epoch.obligation_hash = pending.obligation_hash
          and epoch.root_batch_id = pending.root_batch_id
          and epoch.source_cursor_version = pending.source_cursor_version
          and epoch.source_cursor_value = pending.source_cursor_value
      )
  ) then
    raise exception 'shadow source cut lacks exact acceptance-epoch coverage'
      using errcode = '55000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'epochId', epoch.epoch_id,
    'epochReceiptHash', epoch.receipt_hash,
    'obligationId', epoch.obligation_id,
    'obligationHash', epoch.obligation_hash,
    'rootBatchId', epoch.root_batch_id,
    'sourceCursorVersion', epoch.source_cursor_version,
    'sourceCursorValue', epoch.source_cursor_value,
    'frontierManifestHash', epoch.frontier_manifest_hash,
    'decisionManifestHash', epoch.decision_manifest_hash,
    'headManifestHash', epoch.head_manifest_hash,
    'candidateCount', epoch.candidate_count,
    'acceptedCount', epoch.accepted_count,
    'rejectedCount', epoch.rejected_count,
    'reviewCount', epoch.review_count
  ) order by epoch.source_cursor_version, epoch.epoch_id), '[]'::jsonb)
  into v_epoch_manifest
  from public.truth_shadow_claim_acceptance_epochs epoch
  where epoch.workspace_key = v_cut.workspace_key
    and epoch.source_system = 'gmail'
    and epoch.connection_key = v_cursor.connection_key
    and epoch.source_cursor_version <= v_cursor.through_cursor_version;
  if jsonb_array_length(v_epoch_manifest) = 0 then
    raise exception 'shadow source cut requires at least one completed acceptance epoch'
      using errcode = '55000';
  end if;
  select * into strict v_latest_epoch
  from public.truth_shadow_claim_acceptance_epochs epoch
  where epoch.workspace_key = v_cut.workspace_key
    and epoch.source_system = 'gmail'
    and epoch.connection_key = v_cursor.connection_key
    and epoch.source_cursor_version <= v_cursor.through_cursor_version
  order by epoch.source_cursor_version desc, epoch.epoch_id desc
  limit 1;
  if v_latest_epoch.source_cursor_version is distinct from
      v_cursor.through_cursor_version
    or v_latest_epoch.source_cursor_value is distinct from
      v_cursor.through_cursor_value then
    raise exception 'shadow source cut cursor is not covered by an exact epoch head'
      using errcode = '23514';
  end if;
  v_epoch_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_epoch_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_scope := jsonb_build_object(
    'schemaVersion', 'truth-shadow-root-source-cut-v1',
    'workspaceKey', v_cut.workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', v_cursor.connection_key,
    'rootBatchId', v_latest_epoch.root_batch_id,
    'throughCursorVersion', v_cursor.through_cursor_version,
    'throughCursorValue', v_cursor.through_cursor_value,
    'sourceCutId', v_cut.source_cut_id,
    'sourceCutManifestHash', v_cut.manifest_hash,
    'sourceCutCompleteness', v_cut.completeness,
    'acceptanceEpochManifestHash', v_epoch_manifest_hash,
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false
  );
  v_scope_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_scope), 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.truth_shadow_root_source_cuts (
    source_cut_id, scope_receipt_id, workspace_key, source_system,
    connection_key, root_batch_id, through_cursor_version,
    through_cursor_value, source_cut_manifest_hash,
    acceptance_epoch_manifest, acceptance_epoch_manifest_hash,
    canonical_scope_receipt, scope_receipt_hash, schema_version,
    shadow_only, production_eligible, production_publication_attempted
  ) values (
    v_cut.source_cut_id, 'truth-shadow-root-source-cut:v1:' || v_scope_hash,
    v_cut.workspace_key, 'gmail', v_cursor.connection_key,
    v_latest_epoch.root_batch_id, v_cursor.through_cursor_version,
    v_cursor.through_cursor_value, v_cut.manifest_hash, v_epoch_manifest,
    v_epoch_manifest_hash, v_scope, v_scope_hash,
    'truth-shadow-root-source-cut-v1', true, false, false
  ) on conflict (source_cut_id) do nothing;
  select * into strict v_existing
  from public.truth_shadow_root_source_cuts scope_row
  where scope_row.source_cut_id = v_cut.source_cut_id;
  if v_existing.canonical_scope_receipt is distinct from v_scope
    or v_existing.acceptance_epoch_manifest is distinct from v_epoch_manifest
    or v_existing.production_publication_attempted is distinct from false then
    raise exception 'shadow source-cut scope conflicts on replay'
      using errcode = '23505';
  end if;
  return v_existing;
end;
$function$;

revoke all on function private.register_truth_shadow_root_source_cut(text)
  from public, anon, authenticated, service_role;

create or replace function private.auto_register_truth_shadow_root_source_cut()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.source_system = 'gmail' and new.connection_key like 'shadow-%' then
    perform private.register_truth_shadow_root_source_cut(new.source_cut_id);
  elsif exists (
    select 1
    from public.source_cuts cut
    where cut.source_cut_id = new.source_cut_id
      and exists (
        select 1
        from jsonb_array_elements(cut.required_sources) required_source
        where required_source->>'connectionKey' like 'shadow-%'
      )
  ) then
    raise exception 'mixed shadow source-cut vector is forbidden'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists zz_truth_shadow_source_cut_scope
  on public.source_cut_cursors;
create trigger zz_truth_shadow_source_cut_scope
after insert on public.source_cut_cursors
for each row execute function private.auto_register_truth_shadow_root_source_cut();
revoke all on function private.auto_register_truth_shadow_root_source_cut()
  from public, anon, authenticated, service_role;

create or replace function private.seal_truth_shadow_root_source_cut(
  p_workspace_key text,
  p_obligation_id text,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_epoch public.truth_shadow_claim_acceptance_epochs%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_cut jsonb;
  v_scope public.truth_shadow_root_source_cuts%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_created_by, '')), '') is null then
    raise exception 'shadow source-cut creator is required' using errcode = '22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:' || p_workspace_key, 0
  )) then
    return jsonb_build_object(
      'ok', true, 'status', 'busy', 'retryable', true,
      'productionPublicationAttempted', false
    );
  end if;
  select * into v_epoch
  from public.truth_shadow_claim_acceptance_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.obligation_id = p_obligation_id;
  if not found then
    raise exception 'completed shadow acceptance epoch is unavailable'
      using errcode = '23503';
  end if;
  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = p_workspace_key
    and cursor_row.source_system = v_epoch.source_system
    and cursor_row.connection_key = v_epoch.connection_key
    and cursor_row.cursor_version = v_epoch.source_cursor_version
    and cursor_row.cursor_value = v_epoch.source_cursor_value
    and cursor_row.last_batch_id = v_epoch.root_batch_id
    and cursor_row.status = 'live';
  v_cut := private.seal_source_cut(
    p_workspace_key,
    'source-cut-manifest-v2',
    jsonb_build_array(jsonb_build_object(
      'sourceSystem', v_cursor.source_system,
      'connectionKey', v_cursor.connection_key
    )),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'sourceSystem', v_cursor.source_system,
      'connectionKey', v_cursor.connection_key,
      'cursorKind', v_cursor.cursor_kind,
      'throughCursorVersion', v_cursor.cursor_version,
      'throughCursorValue', v_cursor.cursor_value,
      'upstreamWatermark', '',
      'sourceSnapshotAt', private.canonical_truth_timestamp(v_cursor.last_committed_at)
    )),
    '[]'::jsonb,
    p_created_by,
    p_sync_token
  );
  v_scope := private.register_truth_shadow_root_source_cut(v_cut->>'sourceCutId');
  return v_cut || jsonb_build_object(
    'status', case when v_cut->>'completeness' = 'complete' then 'ready' else 'degraded' end,
    'scopeReceiptId', v_scope.scope_receipt_id,
    'scopeReceiptHash', v_scope.scope_receipt_hash,
    'acceptanceEpochManifestHash', v_scope.acceptance_epoch_manifest_hash,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'publishesTruth', false,
    'performsActions', false
  );
end;
$function$;

create or replace function public.seal_truth_shadow_root_source_cut(
  p_workspace_key text,
  p_obligation_id text,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '250s'
as $function$
  select private.seal_truth_shadow_root_source_cut(
    p_workspace_key, p_obligation_id, p_created_by, p_sync_token
  );
$function$;

revoke all on function private.seal_truth_shadow_root_source_cut(
  text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.seal_truth_shadow_root_source_cut(
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.seal_truth_shadow_root_source_cut(
  text, text, text, text
) to service_role;

-- A shadow cursor is quarantined at storage ingress. The normal runtime may
-- build and publish it only on the relational shadow channel; it can never
-- mint candidate/production authority or a production approval.
create or replace function private.guard_truth_shadow_acceptance_quarantine()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_has_shadow_cursor boolean;
  v_scope public.truth_shadow_root_source_cuts%rowtype;
begin
  select exists (
    select 1
    from public.source_cut_cursors cursor_row
    where cursor_row.source_cut_id = new.source_cut_id
      and cursor_row.connection_key like 'shadow-%'
  ) into v_has_shadow_cursor;
  if not v_has_shadow_cursor then
    return new;
  end if;
  select * into v_scope
  from public.truth_shadow_root_source_cuts scope_row
  where scope_row.workspace_key = new.workspace_key
    and scope_row.source_cut_id = new.source_cut_id;
  if not found then
    raise exception 'shadow source cut lacks its immutable quarantine receipt'
      using errcode = '23514';
  end if;

  if tg_table_name = 'truth_build_pair_runs' then
    if to_jsonb(new)->>'build_channel' <> 'shadow'
      or to_jsonb(new)->>'publication_channel' <> 'shadow' then
      raise exception 'shadow acceptance source cut cannot create candidate or production build authority'
        using errcode = '42501';
    end if;
    if new.base_publication_id is not null and not exists (
      select 1
      from public.truth_publications publication
      join public.truth_shadow_root_source_cuts prior_scope
        on prior_scope.source_cut_id = publication.source_cut_id
       and prior_scope.workspace_key = publication.workspace_key
      where publication.publication_id = new.base_publication_id
        and publication.workspace_key = new.workspace_key
        and publication.channel = 'shadow'
        and prior_scope.source_system = v_scope.source_system
        and prior_scope.connection_key = v_scope.connection_key
    ) then
      raise exception 'shadow acceptance build base escaped its source scope'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'truth_builds' then
    if to_jsonb(new)->>'channel' <> 'shadow' or not exists (
      select 1
      from public.truth_build_pair_runs pair
      where pair.build_pair_id = new.build_pair_id
        and pair.workspace_key = new.workspace_key
        and pair.source_cut_id = new.source_cut_id
        and pair.build_channel = 'shadow'
        and pair.publication_channel = 'shadow'
        and (
          (new.build_mode = 'full'
            and pair.full_build_id = new.build_id
            and new.base_publication_id is null)
          or
          (new.build_mode = 'incremental'
            and pair.incremental_build_id = new.build_id
            and new.base_publication_id is not distinct from pair.base_publication_id)
        )
    ) then
      raise exception 'shadow acceptance build is not bound to its exact shadow pair'
        using errcode = '42501';
    end if;
  elsif tg_table_name = 'truth_publications' then
    if to_jsonb(new)->>'channel' <> 'shadow' or not exists (
      select 1
      from public.truth_builds build
      join public.truth_build_pair_runs pair
        on pair.build_pair_id = build.build_pair_id
       and pair.workspace_key = build.workspace_key
       and pair.source_cut_id = build.source_cut_id
      where build.build_id = new.build_id
        and build.workspace_key = new.workspace_key
        and build.source_cut_id = new.source_cut_id
        and build.channel = 'shadow'
        and pair.build_channel = 'shadow'
        and pair.publication_channel = 'shadow'
    ) then
      raise exception 'shadow acceptance publication is not bound to an exact shadow build'
        using errcode = '42501';
    end if;
    if new.previous_publication_id is not null and not exists (
      select 1
      from public.truth_publications previous
      join public.truth_shadow_root_source_cuts previous_scope
        on previous_scope.source_cut_id = previous.source_cut_id
       and previous_scope.workspace_key = previous.workspace_key
      where previous.publication_id = new.previous_publication_id
        and previous.workspace_key = new.workspace_key
        and previous.channel = 'shadow'
        and previous_scope.source_system = v_scope.source_system
        and previous_scope.connection_key = v_scope.connection_key
    ) then
      raise exception 'shadow acceptance publication predecessor escaped its source scope'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'truth_production_publication_approvals' then
    raise exception 'shadow acceptance source cut cannot receive production publication approval'
      using errcode = '42501';
  else
    raise exception 'shadow acceptance quarantine is attached to an unsupported table'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

do $quarantine_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_build_pair_runs',
    'truth_builds',
    'truth_publications',
    'truth_production_publication_approvals'
  ] loop
    execute format(
      'drop trigger if exists aa_truth_shadow_acceptance_quarantine on public.%I',
      v_table
    );
    execute format(
      'create trigger aa_truth_shadow_acceptance_quarantine '
      || 'before insert on public.%I for each row execute function '
      || 'private.guard_truth_shadow_acceptance_quarantine()',
      v_table
    );
  end loop;
end;
$quarantine_triggers$;

revoke all on function private.guard_truth_shadow_acceptance_quarantine()
  from public, anon, authenticated, service_role;

-- Frozen shadow build inputs must be descendants of the registered source
-- scope. This is a second guard; the inherited running-build and candidate-
-- binding guard remains authoritative and unchanged.
create or replace function private.guard_truth_shadow_build_input_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_build public.truth_builds%rowtype;
  v_scope public.truth_shadow_root_source_cuts%rowtype;
begin
  select * into v_build
  from public.truth_builds build
  where build.build_id = new.build_id;
  if not found then
    return new;
  end if;
  select * into v_scope
  from public.truth_shadow_root_source_cuts scope_row
  where scope_row.workspace_key = v_build.workspace_key
    and scope_row.source_cut_id = v_build.source_cut_id;
  if not found then
    return new;
  end if;

  if new.item_kind = 'accepted_claim' then
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
    end if;
  elsif new.item_kind = 'entity_link' then
    if not exists (
      select 1
      from public.observation_entity_link_envelopes envelope
      join public.observation_entity_links entity_link
        on entity_link.link_version_id = envelope.link_version_id
       and entity_link.content_hash = envelope.envelope_hash
      join public.source_observations observation
        on observation.observation_id = entity_link.observation_id
       and observation.workspace_key = envelope.workspace_key
      where envelope.workspace_key = v_scope.workspace_key
        and envelope.link_version_id = new.item_id
        and envelope.envelope_hash = new.item_hash
        and observation.source_system = v_scope.source_system
        and observation.connection_key = v_scope.connection_key
        and observation.source_cursor_version <= v_scope.through_cursor_version
        and private.source_observation_within_cut(
          v_scope.workspace_key, v_scope.source_cut_id,
          observation.observation_id, observation.content_hash
        )
    ) then
      raise exception 'shadow build entity link escaped the registered source cut'
        using errcode = '23514';
    end if;
  elsif new.item_kind = 'workgroup_membership' then
    if not exists (
      select 1
      from public.operational_workgroup_membership_envelopes envelope
      join public.operational_workgroup_memberships membership
        on membership.membership_version_id = envelope.membership_version_id
       and membership.content_hash = envelope.envelope_hash
      where envelope.workspace_key = v_scope.workspace_key
        and envelope.membership_version_id = new.item_id
        and envelope.envelope_hash = new.item_hash
        and exists (
          select 1
          from public.operational_workgroup_membership_evidence primary_evidence
          where primary_evidence.membership_version_id = membership.membership_version_id
            and primary_evidence.evidence_role = 'primary'
        )
        and not exists (
          select 1
          from public.operational_workgroup_membership_evidence evidence
          join public.source_observations observation
            on observation.observation_id = evidence.observation_id
          where evidence.membership_version_id = membership.membership_version_id
            and (
              observation.workspace_key is distinct from v_scope.workspace_key
              or observation.source_system is distinct from v_scope.source_system
              or observation.connection_key is distinct from v_scope.connection_key
              or observation.source_cursor_version > v_scope.through_cursor_version
              or not private.source_observation_within_cut(
                v_scope.workspace_key, v_scope.source_cut_id,
                observation.observation_id, observation.content_hash
              )
            )
        )
        and (
          membership.observation_id is null or exists (
            select 1 from public.source_observations observation
            where observation.observation_id = membership.observation_id
              and observation.workspace_key = v_scope.workspace_key
              and observation.source_system = v_scope.source_system
              and observation.connection_key = v_scope.connection_key
              and observation.source_cursor_version <= v_scope.through_cursor_version
              and private.source_observation_within_cut(
                v_scope.workspace_key, v_scope.source_cut_id,
                observation.observation_id, observation.content_hash
              )
          )
        )
        and (
          membership.basis_observation_id is null or exists (
            select 1 from public.source_observations observation
            where observation.observation_id = membership.basis_observation_id
              and observation.workspace_key = v_scope.workspace_key
              and observation.source_system = v_scope.source_system
              and observation.connection_key = v_scope.connection_key
              and observation.source_cursor_version <= v_scope.through_cursor_version
              and private.source_observation_within_cut(
                v_scope.workspace_key, v_scope.source_cut_id,
                observation.observation_id, observation.content_hash
              )
          )
        )
    ) then
      raise exception 'shadow build workgroup membership escaped the registered source cut'
        using errcode = '23514';
    end if;
  elsif new.item_kind = 'shipment_metadata' then
    raise exception 'single-source Gmail shadow cuts cannot contain TMS shipment metadata'
      using errcode = '23514';
  else
    raise exception 'shadow build input kind is unsupported'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists zz_truth_shadow_build_input_scope
  on public.truth_build_inputs;
create trigger zz_truth_shadow_build_input_scope
before insert on public.truth_build_inputs
for each row execute function private.guard_truth_shadow_build_input_scope();
revoke all on function private.guard_truth_shadow_build_input_scope()
  from public, anon, authenticated, service_role;

-- The migration aborts unless every guarded rewrite and quarantine boundary
-- reads back exactly. Reapplication proves the same contract rather than
-- accepting a partially installed authority.
do $verify$
declare
  v_definition text;
  v_count integer;
begin
  select count(*)::integer into v_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = any(array[
      'truth_shadow_claim_acceptance_epochs',
      'truth_shadow_claim_acceptance_epoch_items',
      'truth_shadow_root_source_cuts'
    ])
    and relation.relkind in ('r', 'p')
    and relation.relrowsecurity
    and relation.relforcerowsecurity;
  if v_count <> 3 then
    raise exception 'shadow acceptance tables are missing FORCE RLS'
      using errcode = '23514';
  end if;

  select count(*)::integer into v_count
  from pg_catalog.pg_trigger trigger_row
  where not trigger_row.tgisinternal
    and trigger_row.tgenabled = 'O'
    and trigger_row.tgname = 'aa_truth_shadow_acceptance_quarantine'
    and trigger_row.tgrelid = any(array[
      'public.truth_build_pair_runs'::regclass,
      'public.truth_builds'::regclass,
      'public.truth_publications'::regclass,
      'public.truth_production_publication_approvals'::regclass
    ]);
  if v_count <> 4 or not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.truth_build_inputs'::regclass
      and trigger_row.tgname = 'zz_truth_shadow_build_input_scope'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
  ) or not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.source_cut_cursors'::regclass
      and trigger_row.tgname = 'zz_truth_shadow_source_cut_scope'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
  ) then
    raise exception 'shadow acceptance quarantine triggers are incomplete'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('pg_try_advisory_xact_lock' in v_definition) = 0
    or position('ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED' in v_definition) = 0
    or position('productionPublicationAttempted'', false' in v_definition) = 0
    or position('v_candidate.recommendation = ''accept''' in v_definition) = 0
    or position('v_candidate.contradiction_status = ''none''' in v_definition) = 0 then
    raise exception 'shadow acceptance epoch authority failed read-back verification'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('MODEL_RUNTIME_DISABLED' in v_definition) = 0
    or position('gmail-model-runtime-disabled-review-v1' in v_definition) = 0
    or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0 then
    raise exception 'model-off review authority failed read-back verification'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.load_truth_claim_worker_context(text,uuid,text,bigint,text,integer,text)'::regprocedure
  ) into v_definition;
  if (
    length(v_definition) - length(replace(
      v_definition, 'truth_shadow_claim_visible_to_connection', ''
    ))
  ) / length('truth_shadow_claim_visible_to_connection') <> 2 then
    raise exception 'shadow accepted-claim context isolation failed read-back verification'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.seal_source_cut_pre_model_extraction(text,text,jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure
  ) into v_definition;
  if position(
    'unresolved_gmail_attachment_extractions(p_workspace_key,p_cursors)'
    in v_definition
  ) = 0 then
    raise exception 'attachment completeness is not scoped to the exact cut vector'
      using errcode = '23514';
  end if;

  select pg_get_functiondef(
    'private.reject_truth_cut_or_build_with_pending_epoch_v1()'::regprocedure
  ) into v_definition;
  if position('truth_shadow_claim_acceptance_epochs' in v_definition) = 0
    or position('epochReceiptHash' in v_definition) = 0 then
    raise exception 'pending acceptance cut guard lacks exact completion receipts'
      using errcode = '23514';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.run_truth_shadow_claim_acceptance_epoch(text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.run_truth_shadow_claim_acceptance_epoch(text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.run_truth_shadow_claim_acceptance_epoch(text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)',
      'EXECUTE'
    ) then
    raise exception 'shadow acceptance epoch RPC ACLs are unsafe'
      using errcode = '42501';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.seal_truth_shadow_root_source_cut(text,text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.seal_truth_shadow_root_source_cut(text,text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.seal_truth_shadow_root_source_cut(text,text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'private.seal_truth_shadow_root_source_cut(text,text,text,text)',
      'EXECUTE'
    ) then
    raise exception 'shadow source-cut RPC ACLs are unsafe'
      using errcode = '42501';
  end if;
end;
$verify$;
