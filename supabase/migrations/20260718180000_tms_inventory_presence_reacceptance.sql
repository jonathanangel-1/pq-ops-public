-- A TMS inventory row is a snapshot-scoped witness, not a reusable semantic
-- fact. Preserve duplicate rejection everywhere else, while allowing a later
-- exact shipment_observed_in_tms candidate to advance the accepted snapshot
-- chain. The recovery RPC appends corrective authority for the already-sealed
-- pre-fix current cohort without rewriting its original epoch or decisions.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null
    or to_regprocedure(
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
    ) is null
    or to_regprocedure('private.truth_tms_policy_candidate_eligible(jsonb)') is null
    or to_regprocedure(
      'private.append_accepted_claim_source_chronology(text,jsonb,jsonb,jsonb,text)'
    ) is null then
    raise exception 'TMS inventory presence reacceptance prerequisites are missing'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('DUPLICATE_CURRENT_SHADOW_FACT' in v_definition) = 0
    or position('private.truth_tms_policy_candidate_eligible(v_candidate_body)'
      in v_definition) = 0 then
    raise exception 'generic acceptance coordinator differs from the reviewed runtime'
      using errcode = '23514';
  end if;
end;
$preflight$;

do $rewrite_snapshot_presence_duplicate_policy$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$      elsif jsonb_typeof(v_prior_head) = 'object'
        and v_prior_head->>'polarity' is not distinct from v_candidate_body->>'polarity'
        and v_prior_head->'normalizedValue' is not distinct from
          v_candidate_body->'normalizedValue' then
        v_decision := 'reject';
        v_reasons := jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT');$old$;
  v_new text := $new$      elsif jsonb_typeof(v_prior_head) = 'object'
        and v_prior_head->>'polarity' is not distinct from v_candidate_body->>'polarity'
        and v_prior_head->'normalizedValue' is not distinct from
          v_candidate_body->'normalizedValue'
        -- TMS_SNAPSHOT_PRESENCE_REACCEPTANCE_V1: equal inventory presence at
        -- a later source clock is the new snapshot witness, not a duplicate.
        and not (
          v_pending.source_system = 'tms'
          and v_candidate_body->>'predicate' = 'shipment_observed_in_tms'
        ) then
        v_decision := 'reject';
        v_reasons := jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT');$new$;
  v_matches integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('TMS_SNAPSHOT_PRESENCE_REACCEPTANCE_V1' in v_definition) = 0 then
    v_matches := (length(v_definition) - length(replace(v_definition, v_old, '')))
      / length(v_old);
    if v_matches <> 1 then
      raise exception 'TMS inventory duplicate-policy rewrite expected 1 match, found %',
        v_matches using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_snapshot_presence_duplicate_policy$;

create table if not exists public.truth_tms_inventory_presence_recoveries (
  recovery_id text primary key check(
    recovery_id = 'truth-tms-inventory-presence-recovery:v1:' || receipt_hash
  ),
  receipt_hash text not null unique check(receipt_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key = 'primary'),
  source_system text not null check(source_system = 'tms'),
  connection_key text not null check(connection_key = 'couriercloud-ops-tlv-us'),
  root_batch_id uuid not null
    references public.source_ingest_batches(batch_id)
    on update restrict on delete restrict,
  source_cursor_version bigint not null check(source_cursor_version > 0),
  source_cursor_value text not null,
  current_observation_count integer not null check(current_observation_count > 0),
  already_accepted_count integer not null check(already_accepted_count >= 0),
  repaired_count integer not null check(repaired_count > 0),
  item_manifest jsonb not null check(jsonb_typeof(item_manifest) = 'array'),
  item_manifest_hash text not null check(item_manifest_hash ~ '^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check(jsonb_typeof(canonical_receipt) = 'object'),
  schema_version text not null check(
    schema_version = 'truth-tms-inventory-presence-recovery-v1'
  ),
  production_publication_attempted boolean not null default false
    check(production_publication_attempted = false),
  performs_actions boolean not null default false check(performs_actions = false),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key, source_system, connection_key, source_cursor_version),
  unique(workspace_key, recovery_id),
  foreign key(workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  check(item_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(item_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check(receipt_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt), 'UTF8'
  ), 'sha256'), 'hex')),
  check(canonical_receipt->>'schemaVersion' = schema_version),
  check(canonical_receipt->>'workspaceKey' = workspace_key),
  check(canonical_receipt->>'sourceSystem' = source_system),
  check(canonical_receipt->>'connectionKey' = connection_key),
  check(canonical_receipt->>'rootBatchId' = root_batch_id::text),
  check((canonical_receipt->>'sourceCursorVersion')::bigint = source_cursor_version),
  check(canonical_receipt->>'sourceCursorValue' = source_cursor_value),
  check((canonical_receipt->>'currentObservationCount')::integer =
    current_observation_count),
  check((canonical_receipt->>'alreadyAcceptedCount')::integer =
    already_accepted_count),
  check((canonical_receipt->>'repairedCount')::integer = repaired_count),
  check(canonical_receipt->>'itemManifestHash' = item_manifest_hash),
  check((canonical_receipt->>'productionPublicationAttempted')::boolean = false),
  check((canonical_receipt->>'performsActions')::boolean = false)
);

create table if not exists public.truth_tms_inventory_presence_recovery_items (
  item_id text primary key check(
    item_id = 'truth-tms-inventory-presence-recovery-item:v1:' || item_hash
  ),
  item_hash text not null unique check(item_hash ~ '^[0-9a-f]{64}$'),
  recovery_id text not null
    references public.truth_tms_inventory_presence_recoveries(recovery_id)
    on update restrict on delete restrict,
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key = 'primary'),
  ordinal integer not null check(ordinal >= 0),
  source_observation_id text not null
    references public.source_observations(observation_id)
    on update restrict on delete restrict,
  candidate_claim_version_id text not null unique
    references public.candidate_claim_envelopes(candidate_claim_version_id)
    on update restrict on delete restrict,
  prior_decision_version_id text not null
    references public.candidate_claim_decisions(decision_version_id)
    on update restrict on delete restrict,
  corrective_decision_version_id text not null unique
    references public.candidate_claim_decisions(decision_version_id)
    on update restrict on delete restrict,
  prior_claim_version_id text not null
    references public.accepted_claims(claim_version_id)
    on update restrict on delete restrict,
  accepted_claim_version_id text not null unique
    references public.accepted_claims(claim_version_id)
    on update restrict on delete restrict,
  binding_id text not null unique
    references public.candidate_claim_acceptance_bindings(binding_id)
    on update restrict on delete restrict,
  canonical_item jsonb not null check(jsonb_typeof(canonical_item) = 'object'),
  schema_version text not null check(
    schema_version = 'truth-tms-inventory-presence-recovery-item-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(recovery_id, ordinal),
  foreign key(workspace_key, recovery_id)
    references public.truth_tms_inventory_presence_recoveries(
      workspace_key, recovery_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key, candidate_claim_version_id)
    references public.candidate_claim_envelopes(
      workspace_key, candidate_claim_version_id
    ) on update restrict on delete restrict,
  check(item_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_item), 'UTF8'
  ), 'sha256'), 'hex')),
  check(canonical_item->>'schemaVersion' = schema_version),
  check(canonical_item->>'workspaceKey' = workspace_key),
  check(canonical_item->>'sourceObservationId' = source_observation_id),
  check(canonical_item->>'candidateClaimVersionId' = candidate_claim_version_id),
  check(canonical_item->>'priorDecisionVersionId' = prior_decision_version_id),
  check(canonical_item->>'correctiveDecisionVersionId' =
    corrective_decision_version_id),
  check(canonical_item->>'priorClaimVersionId' = prior_claim_version_id),
  check(canonical_item->>'acceptedClaimVersionId' = accepted_claim_version_id),
  check(canonical_item->>'bindingId' = binding_id)
);

drop trigger if exists truth_tms_inventory_presence_recoveries_immutable
  on public.truth_tms_inventory_presence_recoveries;
create trigger truth_tms_inventory_presence_recoveries_immutable
before update or delete on public.truth_tms_inventory_presence_recoveries
for each row execute function public.reject_immutable_truth_mutation();
drop trigger if exists truth_tms_inventory_presence_recovery_items_immutable
  on public.truth_tms_inventory_presence_recovery_items;
create trigger truth_tms_inventory_presence_recovery_items_immutable
before update or delete on public.truth_tms_inventory_presence_recovery_items
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_tms_inventory_presence_recoveries enable row level security;
alter table public.truth_tms_inventory_presence_recoveries force row level security;
alter table public.truth_tms_inventory_presence_recovery_items enable row level security;
alter table public.truth_tms_inventory_presence_recovery_items force row level security;
revoke all on public.truth_tms_inventory_presence_recoveries
  from public, anon, authenticated, service_role;
revoke all on public.truth_tms_inventory_presence_recovery_items
  from public, anon, authenticated, service_role;
grant select on public.truth_tms_inventory_presence_recoveries to service_role;
grant select on public.truth_tms_inventory_presence_recovery_items to service_role;

create or replace function private.repair_truth_tms_inventory_presence_acceptance_v1(
  p_workspace_key text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_manifest public.source_ingest_manifests%rowtype;
  v_existing public.truth_tms_inventory_presence_recoveries%rowtype;
  v_target record;
  v_prior record;
  v_current_count integer;
  v_already_count integer;
  v_target_count integer;
  v_ordinal integer := 0;
  v_claim_request jsonb;
  v_claim_receipt jsonb;
  v_canonical_decision jsonb;
  v_decision_hash text;
  v_decision_id text;
  v_binding jsonb;
  v_binding_hash text;
  v_binding_id text;
  v_canonical_item jsonb;
  v_item_hash text;
  v_item_id text;
  v_items jsonb := '[]'::jsonb;
  v_item_manifest jsonb;
  v_item_manifest_hash text;
  v_receipt jsonb;
  v_receipt_hash text;
  v_recovery_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_workspace_key <> 'primary' then
    raise exception 'TMS inventory presence recovery is restricted to primary'
      using errcode = '42501';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:' || p_workspace_key, 0
  )) then
    return jsonb_build_object(
      'ok', true, 'status', 'busy', 'retryable', true,
      'productionPublicationAttempted', false, 'performsActions', false
    );
  end if;

  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = p_workspace_key
    and cursor_row.source_system = 'tms'
    and cursor_row.connection_key = 'couriercloud-ops-tlv-us'
    and cursor_row.status = 'live'
  for share;
  select * into strict v_batch
  from public.source_ingest_batches batch
  where batch.workspace_key = p_workspace_key
    and batch.batch_id = v_cursor.last_batch_id
    and batch.source_system = 'tms'
    and batch.connection_key = 'couriercloud-ops-tlv-us'
    and batch.status = 'committed'
    and batch.committed_cursor_version = v_cursor.cursor_version
    and batch.committed_cursor_value = v_cursor.cursor_value
  for share;
  select * into strict v_manifest
  from public.source_ingest_manifests manifest
  where manifest.workspace_key = p_workspace_key
    and manifest.batch_id = v_batch.batch_id
    and manifest.source_system = v_batch.source_system
    and manifest.connection_key = v_batch.connection_key
    and manifest.next_cursor_value = v_cursor.cursor_value;
  if v_manifest.payload_identity_hash is distinct from
      private.source_snapshot_payload_identity(
        v_manifest.workspace_key,
        v_manifest.source_system,
        v_manifest.connection_key,
        v_manifest.next_cursor_value,
        v_manifest.provider_manifest_hash,
        v_manifest.observation_manifest_hash,
        v_manifest.job_manifest_hash
      ) then
    raise exception 'current TMS snapshot manifest identity is invalid'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.truth_tms_inventory_presence_recoveries recovery
  where recovery.workspace_key = p_workspace_key
    and recovery.source_system = 'tms'
    and recovery.connection_key = 'couriercloud-ops-tlv-us'
    and recovery.source_cursor_version = v_cursor.cursor_version;
  if found then
    if v_existing.root_batch_id is distinct from v_batch.batch_id
      or v_existing.source_cursor_value is distinct from v_cursor.cursor_value
      or v_existing.receipt_hash is distinct from encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_existing.canonical_receipt), 'UTF8'
      ), 'sha256'), 'hex')
      or (select count(*) from public.truth_tms_inventory_presence_recovery_items item
          where item.recovery_id = v_existing.recovery_id)
        is distinct from v_existing.repaired_count then
      raise exception 'completed TMS inventory recovery failed replay validation'
        using errcode = '23514';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object(
      'ok', true, 'status', 'succeeded', 'idempotent', true,
      'recoveryId', v_existing.recovery_id,
      'recoveryReceiptHash', v_existing.receipt_hash
    );
  end if;

  select count(*)::integer into v_current_count
  from public.source_observations observation
  where observation.workspace_key = p_workspace_key
    and observation.batch_id = v_batch.batch_id
    and observation.source_system = 'tms'
    and observation.connection_key = 'couriercloud-ops-tlv-us'
    and observation.source_object_type = 'tms_shipment_snapshot'
    and observation.operation = 'content'
    and observation.source_cursor_version = v_cursor.cursor_version
    and observation.normalized_payload->>'snapshotTime' = v_cursor.cursor_value;
  if v_current_count <= 0
    or v_current_count is distinct from v_batch.observation_count
    or v_current_count is distinct from jsonb_array_length(v_manifest.observation_manifest) then
    raise exception 'current TMS inventory observation frontier is incomplete'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.source_observations observation
    where observation.workspace_key = p_workspace_key
      and observation.batch_id = v_batch.batch_id
      and observation.source_system = 'tms'
      and observation.connection_key = 'couriercloud-ops-tlv-us'
      and observation.source_object_type = 'tms_shipment_snapshot'
      and observation.operation = 'content'
      and observation.source_cursor_version = v_cursor.cursor_version
      and observation.normalized_payload->>'snapshotTime' = v_cursor.cursor_value
      and (
        select count(*)
        from public.accepted_claims claim
        where claim.primary_observation_id = observation.observation_id
          and claim.subject_type = 'shipment'
          and claim.subject_key = regexp_replace(
            observation.normalized_payload->'shipment'->>'trackingNumber',
            '[^0-9]', '', 'g'
          )
          and claim.predicate = 'shipment_observed_in_tms'
          and claim.decision = 'accepted'
      ) > 1
  ) then
    raise exception 'current TMS observation has duplicate accepted inventory presence'
      using errcode = '23514';
  end if;

  select count(*)::integer into v_already_count
  from public.source_observations observation
  where observation.workspace_key = p_workspace_key
    and observation.batch_id = v_batch.batch_id
    and observation.source_system = 'tms'
    and observation.connection_key = 'couriercloud-ops-tlv-us'
    and observation.source_object_type = 'tms_shipment_snapshot'
    and observation.operation = 'content'
    and observation.source_cursor_version = v_cursor.cursor_version
    and observation.normalized_payload->>'snapshotTime' = v_cursor.cursor_value
    and exists (
      select 1
      from public.accepted_claims claim
      where claim.primary_observation_id = observation.observation_id
        and claim.subject_type = 'shipment'
        and claim.subject_key = regexp_replace(
          observation.normalized_payload->'shipment'->>'trackingNumber',
          '[^0-9]', '', 'g'
        )
        and claim.predicate = 'shipment_observed_in_tms'
        and claim.decision = 'accepted'
    );

  select count(*)::integer into v_target_count
  from public.source_observations observation
  join public.candidate_claim_envelopes candidate
    on candidate.workspace_key = observation.workspace_key
   and candidate.source_observation_id = observation.observation_id
   and candidate.source_object_type = 'tms_shipment_snapshot'
   and candidate.canonical_envelope->'candidate'->>'predicate' =
     'shipment_observed_in_tms'
  join lateral (
    select decision.*
    from public.candidate_claim_decisions decision
    where decision.candidate_claim_version_id = candidate.candidate_claim_version_id
    order by decision.decision_no desc
    limit 1
  ) prior_decision on true
  where observation.workspace_key = p_workspace_key
    and observation.batch_id = v_batch.batch_id
    and observation.source_system = 'tms'
    and observation.connection_key = 'couriercloud-ops-tlv-us'
    and observation.source_object_type = 'tms_shipment_snapshot'
    and observation.operation = 'content'
    and observation.source_cursor_version = v_cursor.cursor_version
    and observation.normalized_payload->>'snapshotTime' = v_cursor.cursor_value
    and candidate.recommendation = 'accept'
    and candidate.ambiguity_status = 'none'
    and candidate.contradiction_status = 'none'
    and private.truth_tms_policy_candidate_eligible(
      candidate.canonical_envelope->'candidate'
    )
    and prior_decision.decision_no = 1
    and prior_decision.decision = 'reject'
    and prior_decision.decision_method = 'policy'
    and prior_decision.decided_by = 'truth-shadow-acceptance-epoch-v1'
    and prior_decision.reasons = jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT')
    and not exists (
      select 1 from public.candidate_claim_acceptance_bindings binding
      where binding.candidate_claim_version_id = candidate.candidate_claim_version_id
    )
    and not exists (
      select 1 from public.accepted_claims claim
      where claim.primary_observation_id = observation.observation_id
        and claim.predicate = 'shipment_observed_in_tms'
        and claim.decision = 'accepted'
    );
  if v_target_count <= 0
    or v_target_count + v_already_count <> v_current_count then
    raise exception 'current TMS inventory recovery cohort is incomplete or unexpected'
      using errcode = '23514';
  end if;

  for v_target in
    select observation.*, candidate.candidate_claim_version_id,
           candidate.envelope_hash as candidate_hash,
           candidate.recommendation_policy_version,
           candidate.canonical_envelope->'candidate' as candidate_body,
           prior_decision.decision_version_id as prior_decision_id,
           prior_decision.decision_hash as prior_decision_hash
    from public.source_observations observation
    join public.candidate_claim_envelopes candidate
      on candidate.workspace_key = observation.workspace_key
     and candidate.source_observation_id = observation.observation_id
     and candidate.source_object_type = 'tms_shipment_snapshot'
     and candidate.canonical_envelope->'candidate'->>'predicate' =
       'shipment_observed_in_tms'
    join lateral (
      select decision.*
      from public.candidate_claim_decisions decision
      where decision.candidate_claim_version_id = candidate.candidate_claim_version_id
      order by decision.decision_no desc
      limit 1
    ) prior_decision on true
    where observation.workspace_key = p_workspace_key
      and observation.batch_id = v_batch.batch_id
      and observation.source_system = 'tms'
      and observation.connection_key = 'couriercloud-ops-tlv-us'
      and observation.source_object_type = 'tms_shipment_snapshot'
      and observation.operation = 'content'
      and observation.source_cursor_version = v_cursor.cursor_version
      and observation.normalized_payload->>'snapshotTime' = v_cursor.cursor_value
      and candidate.recommendation = 'accept'
      and candidate.ambiguity_status = 'none'
      and candidate.contradiction_status = 'none'
      and private.truth_tms_policy_candidate_eligible(
        candidate.canonical_envelope->'candidate'
      )
      and prior_decision.decision_no = 1
      and prior_decision.decision = 'reject'
      and prior_decision.decision_method = 'policy'
      and prior_decision.decided_by = 'truth-shadow-acceptance-epoch-v1'
      and prior_decision.reasons = jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT')
      and not exists (
        select 1 from public.candidate_claim_acceptance_bindings binding
        where binding.candidate_claim_version_id = candidate.candidate_claim_version_id
      )
      and not exists (
        select 1 from public.accepted_claims claim
        where claim.primary_observation_id = observation.observation_id
          and claim.predicate = 'shipment_observed_in_tms'
          and claim.decision = 'accepted'
      )
    order by candidate.canonical_envelope->'candidate'->>'subjectKey'
  loop
    select claim.*, envelope.envelope_hash as envelope_hash
    into v_prior
    from public.accepted_claims claim
    join public.accepted_claim_envelopes envelope
      on envelope.claim_version_id = claim.claim_version_id
     and envelope.workspace_key = p_workspace_key
     and envelope.envelope_hash = claim.claim_content_hash
    join public.source_observations prior_observation
      on prior_observation.workspace_key = p_workspace_key
     and prior_observation.observation_id = claim.primary_observation_id
     and prior_observation.source_system = 'tms'
     and prior_observation.connection_key = 'couriercloud-ops-tlv-us'
    where claim.subject_type = 'shipment'
      and claim.subject_key = v_target.candidate_body->>'subjectKey'
      and claim.predicate = 'shipment_observed_in_tms'
      and claim.decision = 'accepted'
      and coalesce(claim.occurred_at, claim.captured_at) <
        coalesce(v_target.source_recorded_at, v_target.captured_at)
      and not exists (
        select 1 from public.claim_supersessions supersession
        where supersession.superseded_claim_version_id = claim.claim_version_id
      )
    order by coalesce(claim.occurred_at, claim.captured_at) desc,
             claim.version_no desc
    limit 1;
    if not found then
      raise exception 'TMS inventory recovery lacks one monotonic prior accepted head for %',
        v_target.candidate_body->>'subjectKey' using errcode = '23514';
    end if;

    v_claim_request := jsonb_build_object(
      'claim', jsonb_build_object(
        'claimKey', v_prior.claim_key,
        'versionNo', v_prior.version_no + 1,
        'previousClaimVersionId', v_prior.claim_version_id,
        'primaryObservationId', v_target.observation_id,
        'subjectType', v_target.candidate_body->>'subjectType',
        'subjectKey', v_target.candidate_body->>'subjectKey',
        'predicate', v_target.candidate_body->>'predicate',
        'gate', v_target.candidate_body->>'gate',
        'polarity', v_target.candidate_body->>'polarity',
        'normalizedValue', v_target.candidate_body->'normalizedValue',
        'occurredAt', v_target.candidate_body->'occurredAt',
        'confidence', v_target.candidate_body->'confidence',
        'confidenceLabel', v_target.candidate_body->>'confidenceLabel',
        'extractionMethod', v_target.candidate_body->>'extractionMethod',
        'extractorVersion', v_target.candidate_body->>'extractorVersion',
        'promptVersion', coalesce(v_target.candidate_body->>'promptVersion', ''),
        'model', coalesce(v_target.candidate_body->>'model', ''),
        'acceptanceMethod', 'policy',
        'acceptancePolicyVersion', v_target.recommendation_policy_version,
        'acceptedBy', 'truth-tms-inventory-presence-recovery-v1',
        'decision', 'accepted',
        'evidenceSpan', v_target.candidate_body->'evidenceSpan',
        'recordedAt', private.canonical_truth_timestamp(
          coalesce(v_target.source_recorded_at, v_target.captured_at)
        ),
        'schemaVersion', 'candidate-accepted-claim-v1'
      ),
      'evidence', jsonb_build_array(jsonb_build_object(
        'observationId', v_target.observation_id,
        'evidenceRole', 'primary',
        'evidenceSpan', v_target.candidate_body->'evidenceSpan'
      )),
      'supersessions', jsonb_build_array(jsonb_build_object(
        'supersededClaimVersionId', v_prior.claim_version_id,
        'relationship', 'corrects',
        'policyVersion', v_target.recommendation_policy_version
      ))
    );

    v_canonical_decision := jsonb_build_object(
      'decisionSchemaVersion', 'candidate-claim-decision-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', v_target.candidate_claim_version_id,
      'candidateItemHash', v_target.candidate_hash,
      'decision', jsonb_build_object(
        'decisionNo', 2,
        'previousDecisionVersionId', v_target.prior_decision_id,
        'decision', 'accept',
        'method', 'policy',
        'policyVersion', v_target.recommendation_policy_version,
        'decidedBy', 'truth-tms-inventory-presence-recovery-v1',
        'reasons', jsonb_build_array(
          'TMS_SNAPSHOT_PRESENCE_POLICY_CORRECTION_V1'
        ),
        'acceptedClaimRequest', v_claim_request
      )
    );
    v_decision_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical_decision), 'UTF8'
    ), 'sha256'), 'hex');
    v_decision_id := 'candidate-decision:v1:' || v_decision_hash;
    if exists (
      select 1 from public.candidate_claim_decisions decision
      where decision.candidate_claim_version_id = v_target.candidate_claim_version_id
        and decision.decision_no = 2
    ) then
      raise exception 'TMS inventory candidate already has a different corrective decision'
        using errcode = '23505';
    end if;
    insert into public.candidate_claim_decisions (
      decision_version_id, candidate_claim_version_id, decision_no,
      previous_decision_version_id, decision, decision_method, policy_version,
      decided_by, reasons, accepted_claim_request, decision_hash,
      decision_schema_version, canonical_decision
    ) values (
      v_decision_id, v_target.candidate_claim_version_id, 2,
      v_target.prior_decision_id, 'accept', 'policy',
      v_target.recommendation_policy_version,
      'truth-tms-inventory-presence-recovery-v1',
      jsonb_build_array('TMS_SNAPSHOT_PRESENCE_POLICY_CORRECTION_V1'),
      v_claim_request, v_decision_hash, 'candidate-claim-decision-v1',
      v_canonical_decision
    );

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
      'candidateClaimVersionId', v_target.candidate_claim_version_id,
      'candidateItemHash', v_target.candidate_hash,
      'decisionVersionId', v_decision_id,
      'decisionItemHash', v_decision_hash,
      'acceptedClaimVersionId', v_claim_receipt->>'claimVersionId',
      'acceptedClaimItemHash', v_claim_receipt->>'itemHash'
    );
    v_binding_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_binding), 'UTF8'
    ), 'sha256'), 'hex');
    v_binding_id := 'candidate-acceptance:v1:' || v_binding_hash;
    insert into public.candidate_claim_acceptance_bindings (
      binding_id, candidate_claim_version_id, decision_version_id,
      accepted_claim_version_id, binding_hash, binding_schema_version,
      canonical_binding
    ) values (
      v_binding_id, v_target.candidate_claim_version_id, v_decision_id,
      v_claim_receipt->>'claimVersionId', v_binding_hash,
      'candidate-claim-acceptance-binding-v1', v_binding
    );

    v_canonical_item := jsonb_build_object(
      'schemaVersion', 'truth-tms-inventory-presence-recovery-item-v1',
      'workspaceKey', p_workspace_key,
      'ordinal', v_ordinal,
      'sourceObservationId', v_target.observation_id,
      'candidateClaimVersionId', v_target.candidate_claim_version_id,
      'candidateItemHash', v_target.candidate_hash,
      'priorDecisionVersionId', v_target.prior_decision_id,
      'priorDecisionItemHash', v_target.prior_decision_hash,
      'correctiveDecisionVersionId', v_decision_id,
      'correctiveDecisionItemHash', v_decision_hash,
      'priorClaimVersionId', v_prior.claim_version_id,
      'priorClaimItemHash', v_prior.envelope_hash,
      'acceptedClaimVersionId', v_claim_receipt->>'claimVersionId',
      'acceptedClaimItemHash', v_claim_receipt->>'itemHash',
      'bindingId', v_binding_id,
      'bindingItemHash', v_binding_hash
    );
    v_item_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical_item), 'UTF8'
    ), 'sha256'), 'hex');
    v_item_id := 'truth-tms-inventory-presence-recovery-item:v1:' || v_item_hash;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id,
      'itemHash', v_item_hash,
      'canonicalItem', v_canonical_item
    ));
    v_ordinal := v_ordinal + 1;
  end loop;

  if v_ordinal <> v_target_count then
    raise exception 'TMS inventory recovery target count changed during repair'
      using errcode = '40001';
  end if;
  if exists (
    select 1
    from public.source_observations observation
    where observation.workspace_key = p_workspace_key
      and observation.batch_id = v_batch.batch_id
      and observation.source_system = 'tms'
      and observation.connection_key = 'couriercloud-ops-tlv-us'
      and observation.source_object_type = 'tms_shipment_snapshot'
      and observation.operation = 'content'
      and observation.source_cursor_version = v_cursor.cursor_version
      and observation.normalized_payload->>'snapshotTime' = v_cursor.cursor_value
      and (
        select count(*)
        from public.accepted_claims claim
        where claim.primary_observation_id = observation.observation_id
          and claim.subject_type = 'shipment'
          and claim.subject_key = regexp_replace(
            observation.normalized_payload->'shipment'->>'trackingNumber',
            '[^0-9]', '', 'g'
          )
          and claim.predicate = 'shipment_observed_in_tms'
          and claim.decision = 'accepted'
      ) <> 1
  ) then
    raise exception 'TMS inventory recovery did not close every exact current observation'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId',
    'itemHash', item->>'itemHash',
    'sourceObservationId', item #>> '{canonicalItem,sourceObservationId}',
    'candidateClaimVersionId', item #>> '{canonicalItem,candidateClaimVersionId}',
    'correctiveDecisionVersionId',
      item #>> '{canonicalItem,correctiveDecisionVersionId}',
    'acceptedClaimVersionId', item #>> '{canonicalItem,acceptedClaimVersionId}',
    'bindingId', item #>> '{canonicalItem,bindingId}'
  ) order by (item #>> '{canonicalItem,ordinal}')::integer), '[]'::jsonb)
  into v_item_manifest
  from jsonb_array_elements(v_items) item;
  v_item_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_item_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt := jsonb_build_object(
    'schemaVersion', 'truth-tms-inventory-presence-recovery-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'tms',
    'connectionKey', 'couriercloud-ops-tlv-us',
    'rootBatchId', v_batch.batch_id,
    'sourceCursorVersion', v_cursor.cursor_version,
    'sourceCursorValue', v_cursor.cursor_value,
    'currentObservationCount', v_current_count,
    'alreadyAcceptedCount', v_already_count,
    'repairedCount', v_target_count,
    'itemManifestHash', v_item_manifest_hash,
    'recoveredAt', private.canonical_truth_timestamp(v_batch.committed_at),
    'productionPublicationAttempted', false,
    'performsActions', false
  );
  v_receipt_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt), 'UTF8'
  ), 'sha256'), 'hex');
  v_recovery_id := 'truth-tms-inventory-presence-recovery:v1:' || v_receipt_hash;
  insert into public.truth_tms_inventory_presence_recoveries (
    recovery_id, receipt_hash, workspace_key, source_system, connection_key,
    root_batch_id, source_cursor_version, source_cursor_value,
    current_observation_count, already_accepted_count, repaired_count,
    item_manifest, item_manifest_hash, canonical_receipt, schema_version,
    production_publication_attempted, performs_actions
  ) values (
    v_recovery_id, v_receipt_hash, p_workspace_key, 'tms',
    'couriercloud-ops-tlv-us', v_batch.batch_id, v_cursor.cursor_version,
    v_cursor.cursor_value, v_current_count, v_already_count, v_target_count,
    v_item_manifest, v_item_manifest_hash, v_receipt,
    'truth-tms-inventory-presence-recovery-v1', false, false
  );
  insert into public.truth_tms_inventory_presence_recovery_items (
    item_id, item_hash, recovery_id, workspace_key, ordinal,
    source_observation_id, candidate_claim_version_id,
    prior_decision_version_id, corrective_decision_version_id,
    prior_claim_version_id, accepted_claim_version_id, binding_id,
    canonical_item, schema_version
  )
  select item->>'itemId', item->>'itemHash', v_recovery_id, p_workspace_key,
         (item #>> '{canonicalItem,ordinal}')::integer,
         item #>> '{canonicalItem,sourceObservationId}',
         item #>> '{canonicalItem,candidateClaimVersionId}',
         item #>> '{canonicalItem,priorDecisionVersionId}',
         item #>> '{canonicalItem,correctiveDecisionVersionId}',
         item #>> '{canonicalItem,priorClaimVersionId}',
         item #>> '{canonicalItem,acceptedClaimVersionId}',
         item #>> '{canonicalItem,bindingId}',
         item->'canonicalItem',
         'truth-tms-inventory-presence-recovery-item-v1'
  from jsonb_array_elements(v_items) item;

  return v_receipt || jsonb_build_object(
    'ok', true, 'status', 'succeeded', 'idempotent', false,
    'recoveryId', v_recovery_id, 'recoveryReceiptHash', v_receipt_hash
  );
end;
$function$;

create or replace function public.repair_truth_tms_inventory_presence_acceptance_v1(
  p_workspace_key text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.repair_truth_tms_inventory_presence_acceptance_v1(
    p_workspace_key, p_sync_token
  );
$function$;

revoke all on function private.repair_truth_tms_inventory_presence_acceptance_v1(
  text, text
) from public, anon, authenticated, service_role;
revoke all on function public.repair_truth_tms_inventory_presence_acceptance_v1(
  text, text
) from public, anon, authenticated;
grant execute on function public.repair_truth_tms_inventory_presence_acceptance_v1(
  text, text
) to service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('TMS_SNAPSHOT_PRESENCE_REACCEPTANCE_V1' in v_definition) = 0
    or position('DUPLICATE_CURRENT_SHADOW_FACT' in v_definition) = 0
    or position('v_pending.source_system = ''tms''' in v_definition) = 0
    or position('v_candidate_body->>''predicate'' = ''shipment_observed_in_tms'''
      in v_definition) = 0 then
    raise exception 'TMS inventory duplicate-policy exception is incomplete'
      using errcode = '55000';
  end if;
  select proconfig into v_config
  from pg_catalog.pg_proc
  where oid = 'private.repair_truth_tms_inventory_presence_acceptance_v1(text,text)'
    ::regprocedure;
  if v_config is null or not ('search_path=""' = any(v_config)) then
    raise exception 'TMS inventory recovery lost its empty search_path'
      using errcode = '55000';
  end if;
  if has_function_privilege('public',
      'public.repair_truth_tms_inventory_presence_acceptance_v1(text,text)',
      'EXECUTE')
    or has_function_privilege('anon',
      'public.repair_truth_tms_inventory_presence_acceptance_v1(text,text)',
      'EXECUTE')
    or has_function_privilege('authenticated',
      'public.repair_truth_tms_inventory_presence_acceptance_v1(text,text)',
      'EXECUTE')
    or not has_function_privilege('service_role',
      'public.repair_truth_tms_inventory_presence_acceptance_v1(text,text)',
      'EXECUTE') then
    raise exception 'TMS inventory recovery RPC privileges are unsafe'
      using errcode = '42501';
  end if;
end;
$verify$;
