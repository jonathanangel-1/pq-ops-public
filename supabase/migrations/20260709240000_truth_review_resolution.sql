create extension if not exists pgcrypto with schema extensions;

-- Explicit human review is a separate, non-publishing authority. A review
-- request is immutable, idempotent, and resolves exactly one candidate claim
-- or link/workgroup proposal. Acceptance materialization and its authorization
-- binding share this RPC transaction, so a crash cannot expose an unbound
-- accepted item to a later source cut.

create table if not exists public.truth_review_resolutions (
  review_resolution_id text primary key
    check (review_resolution_id ~ '^review-resolution:v1:[0-9a-f]{64}$'),
  workspace_key text not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  target_kind text not null
    check (target_kind = any (array['candidate_claim', 'link_proposal'])),
  target_id text not null,
  target_item_hash text not null check (target_item_hash ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision = any (array['accept', 'reject'])),
  decision_version_id text not null,
  decision_item_hash text not null check (decision_item_hash ~ '^[0-9a-f]{64}$'),
  accepted_kind text not null default '',
  accepted_item_id text not null default '',
  accepted_item_hash text not null default '',
  binding_id text not null default '',
  binding_item_hash text not null default '',
  request_hash text not null unique check (request_hash ~ '^[0-9a-f]{64}$'),
  request_schema_version text not null,
  canonical_request jsonb not null check (jsonb_typeof(canonical_request) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_key, idempotency_key_hash),
  unique (workspace_key, target_kind, target_id),
  check (review_resolution_id = 'review-resolution:v1:' || request_hash),
  check (
    (decision = 'accept' and accepted_kind <> '' and accepted_item_id <> ''
      and accepted_item_hash ~ '^[0-9a-f]{64}$' and binding_id <> ''
      and binding_item_hash ~ '^[0-9a-f]{64}$')
    or
    (decision = 'reject' and accepted_kind = '' and accepted_item_id = ''
      and accepted_item_hash = '' and binding_id = '' and binding_item_hash = '')
  )
);

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and table_row.relname = 'truth_review_resolutions'
      and constraint_row.conname = 'truth_review_resolutions_workspace_fk'
  ) then
    alter table public.truth_review_resolutions
      add constraint truth_review_resolutions_workspace_fk
      foreign key (workspace_key)
      references public.truth_workspaces(workspace_key)
      on update restrict on delete restrict not deferrable;
  end if;
end
$block$;

create index if not exists truth_review_resolutions_target_idx
  on public.truth_review_resolutions(workspace_key, target_kind, target_id, created_at desc);

-- Gmail source chronology is a new extractor/policy contract, not an in-place
-- reinterpretation of v3 candidates. Pin a distinct registry row for every
-- predicate previously supported by the Gmail extractor.
insert into public.candidate_claim_predicate_registry (
  predicate, extractor_version, candidate_schema_version, source_system,
  gate, statuses, effects, registry_version, registry_hash,
  acceptance_policy_version
)
select
  registry.predicate,
  'gmail-claim-extractor-v4-source-chronology+predicates:' || registry.registry_hash,
  registry.candidate_schema_version,
  registry.source_system,
  registry.gate,
  registry.statuses,
  registry.effects,
  registry.registry_version,
  registry.registry_hash,
  'gmail-candidate-acceptance-v3-source-chronology+' || registry.registry_version
from public.candidate_claim_predicate_registry registry
where registry.source_system = 'gmail'
  and registry.extractor_version =
    'gmail-claim-extractor-v3+predicates:' || registry.registry_hash
on conflict (predicate, extractor_version) do nothing;

drop trigger if exists truth_review_resolutions_immutable on public.truth_review_resolutions;
create trigger truth_review_resolutions_immutable
  before update or delete on public.truth_review_resolutions
  for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_review_resolutions enable row level security;
alter table public.truth_review_resolutions force row level security;
revoke all on table public.truth_review_resolutions from public, anon, authenticated;
grant select on table public.truth_review_resolutions to service_role;
revoke insert, update, delete, truncate on table public.truth_review_resolutions from service_role;

create or replace function private.valid_truth_review_token(p_review_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens token_row
    where token_row.token_name = 'truth_review_decider'
      and token_row.token_hash = encode(
        extensions.digest(convert_to(p_review_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

-- The new atomic resolver may call the old binding guards, but the old tokens
-- remain valid only for backwards-compatible migrations/verifiers. Production
-- execution is forced through public.resolve_truth_review below.
create or replace function private.valid_candidate_operator_token(p_operator_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens token_row
    where token_row.token_name = any (array[
        'candidate_claim_operator_decider',
        'truth_review_decider'
      ])
      and token_row.token_hash = encode(
        extensions.digest(convert_to(p_operator_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

create or replace function private.valid_truth_link_operator_token(p_operator_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens token_row
    where token_row.token_name = any (array[
        'truth_link_operator_decider',
        'truth_review_decider'
      ])
      and token_row.token_hash = encode(
        extensions.digest(convert_to(p_operator_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

revoke all on function private.valid_truth_review_token(text)
  from public, anon, authenticated, service_role;
revoke all on function private.valid_candidate_operator_token(text)
  from public, anon, authenticated, service_role;
revoke all on function private.valid_truth_link_operator_token(text)
  from public, anon, authenticated, service_role;

create or replace function private.append_truth_candidate_review_decision(
  p_workspace_key text,
  p_candidate_claim_version_id text,
  p_expected_target_hash text,
  p_expected_previous_decision_version_id text,
  p_decision text,
  p_method text,
  p_policy_version text,
  p_decided_by text,
  p_reasons jsonb,
  p_accepted_claim_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_previous public.candidate_claim_decisions%rowtype;
  v_latest public.candidate_claim_decisions%rowtype;
  v_decision_no integer;
  v_canonical_decision jsonb;
  v_decision_hash text;
  v_decision_version_id text;
  v_existing public.candidate_claim_decisions%rowtype;
  v_idempotent boolean := false;
begin
  if p_decision <> all (array['accept', 'review', 'reject'])
    or p_method <> all (array['policy', 'operator'])
    or nullif(trim(coalesce(p_policy_version, '')), '') is null
    or length(p_policy_version) > 200
    or nullif(trim(coalesce(p_decided_by, '')), '') is null
    or length(p_decided_by) > 200
    or jsonb_typeof(coalesce(p_reasons, 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_reasons) = 0
    or exists (
      select 1 from jsonb_array_elements(p_reasons) reason
      where jsonb_typeof(reason) <> 'string'
        or nullif(trim(reason #>> '{}'), '') is null
        or length(reason #>> '{}') > 2000
    )
    or ((p_decision = 'accept') is distinct from (p_accepted_claim_request is not null)) then
    raise exception 'candidate review decision is invalid' using errcode = '22023';
  end if;
  if p_method = 'operator' and p_decision = 'review' then
    raise exception 'explicit review resolution must be terminal' using errcode = '23514';
  end if;

  select * into v_candidate
  from public.candidate_claim_envelopes candidate
  where candidate.candidate_claim_version_id = p_candidate_claim_version_id
    and candidate.workspace_key = p_workspace_key;
  if not found then
    raise exception 'candidate claim is unavailable in the review workspace'
      using errcode = '23503';
  end if;
  if v_candidate.envelope_hash is distinct from p_expected_target_hash then
    raise exception 'candidate review target hash is stale' using errcode = '40001';
  end if;

  if coalesce(p_expected_previous_decision_version_id, '') = '' then
    v_decision_no := 1;
  else
    select * into v_previous
    from public.candidate_claim_decisions decision_row
    where decision_row.decision_version_id = p_expected_previous_decision_version_id
      and decision_row.candidate_claim_version_id = p_candidate_claim_version_id;
    if not found then
      raise exception 'candidate review predecessor is unavailable'
        using errcode = '40001';
    end if;
    v_decision_no := v_previous.decision_no + 1;
  end if;

  v_canonical_decision := jsonb_build_object(
    'decisionSchemaVersion', 'candidate-claim-decision-v1',
    'workspaceKey', p_workspace_key,
    'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
    'candidateItemHash', v_candidate.envelope_hash,
    'decision', jsonb_build_object(
      'decisionNo', v_decision_no,
      'previousDecisionVersionId', coalesce(p_expected_previous_decision_version_id, ''),
      'decision', p_decision,
      'method', p_method,
      'policyVersion', p_policy_version,
      'decidedBy', p_decided_by,
      'reasons', p_reasons,
      'acceptedClaimRequest', p_accepted_claim_request
    )
  );
  v_decision_hash := encode(extensions.digest(
    convert_to(v_canonical_decision::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_decision_version_id := 'candidate-decision:v1:' || v_decision_hash;

  perform pg_advisory_xact_lock(hashtextextended(
    'candidate-decision:' || p_workspace_key || ':' || p_candidate_claim_version_id,
    0
  ));
  select * into v_existing
  from public.candidate_claim_decisions decision_row
  where decision_row.decision_version_id = v_decision_version_id;
  if found then
    v_idempotent := true;
    if v_existing.candidate_claim_version_id is distinct from p_candidate_claim_version_id
      or v_existing.canonical_decision is distinct from v_canonical_decision then
      raise exception 'candidate review decision hash collision' using errcode = '23505';
    end if;
  else
    select * into v_latest
    from public.candidate_claim_decisions decision_row
    where decision_row.candidate_claim_version_id = p_candidate_claim_version_id
    order by decision_row.decision_no desc
    limit 1;
    if coalesce(p_expected_previous_decision_version_id, '') = '' then
      if found then
        raise exception 'candidate review decision head changed' using errcode = '40001';
      end if;
    elsif not found
      or v_latest.decision_version_id is distinct from p_expected_previous_decision_version_id
      or v_latest.decision <> 'review' then
      raise exception 'candidate review decision head changed or is terminal'
        using errcode = '40001';
    end if;
    insert into public.candidate_claim_decisions (
      decision_version_id, candidate_claim_version_id, decision_no,
      previous_decision_version_id, decision, decision_method, policy_version,
      decided_by, reasons, accepted_claim_request, decision_hash,
      decision_schema_version, canonical_decision
    ) values (
      v_decision_version_id, p_candidate_claim_version_id, v_decision_no,
      nullif(p_expected_previous_decision_version_id, ''), p_decision, p_method,
      p_policy_version, p_decided_by, p_reasons, p_accepted_claim_request,
      v_decision_hash, 'candidate-claim-decision-v1', v_canonical_decision
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'candidateClaimVersionId', p_candidate_claim_version_id,
    'decisionVersionId', v_decision_version_id,
    'itemHash', v_decision_hash,
    'decision', p_decision,
    'acceptedClaimRequest', p_accepted_claim_request
  );
end;
$function$;

revoke all on function private.append_truth_candidate_review_decision(
  text, text, text, text, text, text, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;

create or replace function private.truth_candidate_review_accept_request(
  p_workspace_key text,
  p_candidate_claim_version_id text,
  p_expected_target_hash text,
  p_policy_version text,
  p_decided_by text,
  p_acceptance_method text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_candidate_body jsonb;
  v_source_observation public.source_observations%rowtype;
  v_previous_claim public.accepted_claims%rowtype;
  v_contradiction_ids jsonb;
  v_candidate_occurred_at timestamptz;
  v_contradiction_count integer;
  v_valid_contradiction_count integer;
  v_supersessions jsonb := '[]'::jsonb;
begin
  if p_acceptance_method <> all (array['policy', 'operator']) then
    raise exception 'candidate acceptance method is invalid' using errcode = '22023';
  end if;
  select * into v_candidate
  from public.candidate_claim_envelopes candidate
  where candidate.candidate_claim_version_id = p_candidate_claim_version_id
    and candidate.workspace_key = p_workspace_key;
  if not found or v_candidate.envelope_hash is distinct from p_expected_target_hash then
    raise exception 'candidate acceptance target is unavailable or stale'
      using errcode = '40001';
  end if;
  v_candidate_body := v_candidate.canonical_envelope->'candidate';
  if v_candidate.recommendation = 'reject' then
    raise exception 'extractor-rejected candidate cannot be accepted'
      using errcode = '23514';
  end if;
  select * into v_source_observation
  from public.source_observations observation
  where observation.observation_id = v_candidate.source_observation_id
    and observation.workspace_key = p_workspace_key;
  if not found then
    raise exception 'candidate source observation is unavailable'
      using errcode = '23503';
  end if;

  -- The candidate must still be the exact next immutable version of this
  -- claim key. This closes races between queue read and operator decision.
  select claim.* into v_previous_claim
  from public.accepted_claims claim
  join public.accepted_claim_envelopes envelope
    on envelope.claim_version_id = claim.claim_version_id
   and envelope.workspace_key = p_workspace_key
  where claim.claim_key = v_candidate_body->>'claimKey'
  order by claim.version_no desc
  limit 1;
  if found then
    if v_candidate_body->>'previousClaimVersionId' is distinct from v_previous_claim.claim_version_id
      or (v_candidate_body->>'versionNo')::integer <> v_previous_claim.version_no + 1 then
      raise exception 'candidate accepted-claim lineage changed during review'
        using errcode = '40001';
    end if;
  elsif nullif(v_candidate_body->>'previousClaimVersionId', '') is not null
    or (v_candidate_body->>'versionNo')::integer <> 1 then
    raise exception 'candidate accepted-claim genesis is stale' using errcode = '40001';
  end if;

  v_contradiction_ids := coalesce(
    v_candidate_body->'contradiction'->'acceptedClaimVersionIds',
    '[]'::jsonb
  );
  if jsonb_typeof(v_contradiction_ids) <> 'array'
    or exists (
      select 1 from jsonb_array_elements(v_contradiction_ids) item
      where jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~ '^claim:v1:[0-9a-f]{64}$'
    ) then
    raise exception 'candidate contradiction provenance is invalid'
      using errcode = '23514';
  end if;
  select count(*), count(distinct item #>> '{}')
  into v_contradiction_count, v_valid_contradiction_count
  from jsonb_array_elements(v_contradiction_ids) item;
  if v_contradiction_count <> v_valid_contradiction_count then
    raise exception 'candidate contradiction provenance contains duplicates'
      using errcode = '23514';
  end if;

  if v_candidate.contradiction_status = 'known' then
    if jsonb_typeof(v_candidate_body->'occurredAt') <> 'string'
      or not private.is_canonical_utc_millis(v_candidate_body->>'occurredAt') then
      raise exception 'candidate correction lacks exact source chronology'
        using errcode = '23514';
    end if;
    v_candidate_occurred_at := (v_candidate_body->>'occurredAt')::timestamptz;
    if v_contradiction_count = 0
      or v_candidate_body->>'previousClaimVersionId' is null
      or not (v_contradiction_ids ? (v_candidate_body->>'previousClaimVersionId')) then
      raise exception 'candidate correction lacks the exact prior accepted-claim head'
        using errcode = '23514';
    end if;
    select count(*)::integer into v_valid_contradiction_count
    from jsonb_array_elements_text(v_contradiction_ids) contradiction_id
    join public.accepted_claims prior
      on prior.claim_version_id = contradiction_id
    join public.accepted_claim_envelopes prior_envelope
      on prior_envelope.claim_version_id = prior.claim_version_id
     and prior_envelope.workspace_key = p_workspace_key
    join public.source_observations prior_observation
      on prior_observation.observation_id = prior.primary_observation_id
     and prior_observation.workspace_key = p_workspace_key
    where prior.subject_type = v_candidate_body->>'subjectType'
      and prior.subject_key = v_candidate_body->>'subjectKey'
      and prior.predicate = v_candidate_body->>'predicate'
      and prior.claim_key = v_candidate_body->>'claimKey'
      and prior.polarity <> v_candidate_body->>'polarity'
      and coalesce(prior.occurred_at, prior_observation.source_recorded_at) is not null
      and coalesce(prior.occurred_at, prior_observation.source_recorded_at)
        < v_candidate_occurred_at;
    if v_valid_contradiction_count <> v_contradiction_count then
      raise exception 'candidate correction target crosses workspace, subject, predicate, polarity, or time'
        using errcode = '23514';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'supersededClaimVersionId', contradiction_id,
      'relationship', 'corrects',
      'policyVersion', p_policy_version
    ) order by contradiction_id), '[]'::jsonb)
    into v_supersessions
    from jsonb_array_elements_text(v_contradiction_ids) contradiction_id;
  elsif v_candidate.contradiction_status <> 'none' or v_contradiction_count <> 0 then
    raise exception 'candidate contradiction status and provenance disagree'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'claim', jsonb_build_object(
      'claimKey', v_candidate_body->>'claimKey',
      'versionNo', (v_candidate_body->>'versionNo')::integer,
      'previousClaimVersionId', nullif(v_candidate_body->>'previousClaimVersionId', ''),
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
      'promptVersion', v_candidate_body->>'promptVersion',
      'model', v_candidate_body->>'model',
      'acceptanceMethod', p_acceptance_method,
      'acceptancePolicyVersion', p_policy_version,
      'acceptedBy', p_decided_by,
      'decision', 'accepted',
      'evidenceSpan', v_candidate_body->'evidenceSpan',
      'recordedAt', private.canonical_truth_timestamp(v_candidate.created_at),
      'schemaVersion', 'candidate-accepted-claim-v1'
    ),
    'evidence', jsonb_build_array(jsonb_build_object(
      'observationId', v_candidate.source_observation_id,
      'evidenceRole', 'primary',
      'evidenceSpan', v_candidate_body->'evidenceSpan'
    )),
    'supersessions', v_supersessions
  );
end;
$function$;

revoke all on function private.truth_candidate_review_accept_request(
  text, text, text, text, text, text
) from public, anon, authenticated, service_role;

create or replace function private.authorize_candidate_claim_policy_correction(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_candidate_body jsonb;
  v_accepted_request jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_job := private.assert_candidate_claim_job_lease(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select * into v_candidate
  from public.candidate_claim_envelopes candidate
  where candidate.candidate_claim_version_id = p_candidate_claim_version_id
    and candidate.workspace_key = p_workspace_key;
  if not found or v_job.workspace_key is distinct from p_workspace_key
    or not exists (
      select 1 from public.candidate_claim_job_lineage lineage
      where lineage.candidate_claim_version_id = p_candidate_claim_version_id
        and lineage.job_id = p_job_id
        and lineage.source_observation_id = v_job.observation_id
    )
    or not exists (
      select 1
      from public.candidate_claim_job_manifests manifest,
           jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      where manifest.job_id = p_job_id
        and manifest.workspace_key = p_workspace_key
        and item->>'candidateClaimVersionId' = p_candidate_claim_version_id
        and item->>'itemHash' = v_candidate.envelope_hash
    ) then
    raise exception 'candidate policy correction is outside the fenced sealed job'
      using errcode = '23514';
  end if;
  v_candidate_body := v_candidate.canonical_envelope->'candidate';
  if v_candidate.source_object_type <> all (array[
      'gmail_message_parsed', 'gmail_attachment_extracted',
      'tms_shipment_snapshot', 'tracking_shipment_snapshot'
    ])
    or v_candidate.extraction_method <> 'deterministic'
    or v_candidate.source_review_required
    or v_candidate.recommendation <> 'accept'
    or v_candidate.ambiguity_status <> 'none'
    or v_candidate.contradiction_status <> 'known'
    or v_candidate_body->'acceptanceRecommendation'->>'decision' <> 'accept'
    or v_candidate_body->'acceptanceRecommendation'->>'method' <> 'policy'
    or v_candidate_body->'acceptanceRecommendation'->>'policyVersion'
      is distinct from v_candidate.recommendation_policy_version
    or jsonb_typeof(v_candidate_body->'occurredAt') <> 'string'
    or not private.is_canonical_utc_millis(v_candidate_body->>'occurredAt')
    or jsonb_typeof(v_candidate_body->'contradiction'->'acceptedClaimVersionIds') <> 'array'
    or jsonb_array_length(v_candidate_body->'contradiction'->'acceptedClaimVersionIds') = 0 then
    raise exception 'candidate is not eligible for deterministic policy correction'
      using errcode = '23514';
  end if;
  v_accepted_request := private.truth_candidate_review_accept_request(
    p_workspace_key,
    p_candidate_claim_version_id,
    v_candidate.envelope_hash,
    v_candidate.recommendation_policy_version,
    p_processor_version,
    'policy'
  );
  return private.append_truth_candidate_review_decision(
    p_workspace_key,
    p_candidate_claim_version_id,
    v_candidate.envelope_hash,
    '',
    'accept',
    'policy',
    v_candidate.recommendation_policy_version,
    p_processor_version,
    v_candidate_body->'acceptanceRecommendation'->'reasons',
    v_accepted_request
  );
end;
$function$;

create or replace function public.authorize_candidate_claim_policy_correction(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.authorize_candidate_claim_policy_correction(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidate_claim_version_id, p_sync_token
  );
$function$;

revoke all on function private.authorize_candidate_claim_policy_correction(
  text, uuid, text, bigint, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.authorize_candidate_claim_policy_correction(
  text, uuid, text, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.authorize_candidate_claim_policy_correction(
  text, uuid, text, bigint, text, text, text
) to service_role;

create or replace function private.record_candidate_claim_policy_recommendation(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_recommendation jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_job := private.assert_candidate_claim_job_lease(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select * into v_candidate
  from public.candidate_claim_envelopes candidate
  where candidate.candidate_claim_version_id = p_candidate_claim_version_id
    and candidate.workspace_key = p_workspace_key;
  if not found or v_job.workspace_key is distinct from p_workspace_key
    or not exists (
      select 1 from public.candidate_claim_job_lineage lineage
      where lineage.candidate_claim_version_id = p_candidate_claim_version_id
        and lineage.job_id = p_job_id
        and lineage.source_observation_id = v_job.observation_id
    )
    or not exists (
      select 1
      from public.candidate_claim_job_manifests manifest,
           jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      where manifest.job_id = p_job_id
        and manifest.workspace_key = p_workspace_key
        and item->>'candidateClaimVersionId' = p_candidate_claim_version_id
        and item->>'itemHash' = v_candidate.envelope_hash
    ) then
    raise exception 'candidate policy recommendation is outside the fenced sealed job'
      using errcode = '23514';
  end if;
  v_recommendation := v_candidate.canonical_envelope->'candidate'->'acceptanceRecommendation';
  if v_candidate.recommendation <> all (array['review', 'reject'])
    or v_recommendation->>'decision' is distinct from v_candidate.recommendation
    or v_recommendation->>'policyVersion' is distinct from v_candidate.recommendation_policy_version
    or jsonb_typeof(coalesce(v_recommendation->'reasons', 'null'::jsonb)) <> 'array'
    or jsonb_array_length(v_recommendation->'reasons') = 0 then
    raise exception 'candidate has no durable non-accepting policy recommendation'
      using errcode = '23514';
  end if;
  return private.append_truth_candidate_review_decision(
    p_workspace_key,
    p_candidate_claim_version_id,
    v_candidate.envelope_hash,
    '',
    v_candidate.recommendation,
    'policy',
    v_candidate.recommendation_policy_version,
    p_processor_version,
    v_recommendation->'reasons',
    null
  );
end;
$function$;

create or replace function public.record_candidate_claim_policy_recommendation(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.record_candidate_claim_policy_recommendation(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidate_claim_version_id, p_sync_token
  );
$function$;

revoke all on function private.record_candidate_claim_policy_recommendation(
  text, uuid, text, bigint, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.record_candidate_claim_policy_recommendation(
  text, uuid, text, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_candidate_claim_policy_recommendation(
  text, uuid, text, bigint, text, text, text
) to service_role;

create or replace function private.resolve_truth_review(
  p_workspace_key text,
  p_target_kind text,
  p_target_id text,
  p_expected_target_hash text,
  p_expected_previous_decision_version_id text,
  p_decision text,
  p_policy_version text,
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
  v_idempotency_key_hash text;
  v_canonical_request jsonb;
  v_request_hash text;
  v_review_resolution_id text;
  v_existing public.truth_review_resolutions%rowtype;
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_proposal public.truth_link_candidate_proposals%rowtype;
  v_latest_link_decision public.truth_link_candidate_decisions%rowtype;
  v_decision_no integer;
  v_decision_receipt jsonb;
  v_accepted_request jsonb;
  v_item_receipt jsonb;
  v_binding_receipt jsonb;
  v_accepted_kind text := '';
  v_accepted_item_id text := '';
  v_accepted_item_hash text := '';
  v_binding_id text := '';
  v_binding_item_hash text := '';
  v_workgroup_id text;
  v_workgroup_hash text;
  v_receipt jsonb;
  v_receipt_hash text;
begin
  if not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth review token' using errcode = '28000';
  end if;
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_target_kind <> all (array['candidate_claim', 'link_proposal'])
    or p_decision <> all (array['accept', 'reject'])
    or p_expected_target_hash !~ '^[0-9a-f]{64}$'
    or nullif(trim(coalesce(p_policy_version, '')), '') is null
    or length(p_policy_version) > 200
    or nullif(trim(coalesce(p_decided_by, '')), '') is null
    or length(p_decided_by) > 200
    or nullif(trim(coalesce(p_reason, '')), '') is null
    or length(p_reason) > 2000
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_-]{32,128}$'
    or (p_target_kind = 'candidate_claim' and p_target_id !~ '^candidate:v1:[0-9a-f]{64}$')
    or (p_target_kind = 'link_proposal' and p_target_id !~ '^link-proposal:v1:[0-9a-f]{64}$')
    or (
      coalesce(p_expected_previous_decision_version_id, '') <> ''
      and (
        (p_target_kind = 'candidate_claim'
          and p_expected_previous_decision_version_id !~ '^candidate-decision:v1:[0-9a-f]{64}$')
        or
        (p_target_kind = 'link_proposal'
          and p_expected_previous_decision_version_id !~ '^link-decision:v1:[0-9a-f]{64}$')
      )
    ) then
    raise exception 'truth review request is invalid' using errcode = '22023';
  end if;

  v_idempotency_key_hash := encode(extensions.digest(
    convert_to(p_idempotency_key, 'UTF8'), 'sha256'
  ), 'hex');
  v_canonical_request := jsonb_build_object(
    'requestSchemaVersion', 'truth-review-resolution-v1',
    'workspaceKey', p_workspace_key,
    'idempotencyKeyHash', v_idempotency_key_hash,
    'targetKind', p_target_kind,
    'targetId', p_target_id,
    'expectedTargetHash', p_expected_target_hash,
    'expectedPreviousDecisionVersionId', coalesce(p_expected_previous_decision_version_id, ''),
    'decision', p_decision,
    'policyVersion', p_policy_version,
    'decidedBy', p_decided_by,
    'reason', p_reason
  );
  v_request_hash := encode(extensions.digest(
    convert_to(v_canonical_request::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_review_resolution_id := 'review-resolution:v1:' || v_request_hash;

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-review-request:' || p_workspace_key || ':' || v_idempotency_key_hash,
    0
  ));
  select * into v_existing
  from public.truth_review_resolutions resolution
  where resolution.workspace_key = p_workspace_key
    and resolution.idempotency_key_hash = v_idempotency_key_hash;
  if found then
    if v_existing.canonical_request is distinct from v_canonical_request then
      raise exception 'truth review idempotency key was reused for a different request'
        using errcode = '23505';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object(
      'idempotent', true,
      'reviewItemHash', v_existing.receipt_hash
    );
  end if;

  if p_target_kind = 'candidate_claim' then
    select * into v_candidate
    from public.candidate_claim_envelopes candidate
    where candidate.candidate_claim_version_id = p_target_id
      and candidate.workspace_key = p_workspace_key;
    if not found or v_candidate.envelope_hash is distinct from p_expected_target_hash then
      raise exception 'candidate review target is unavailable or stale'
        using errcode = '40001';
    end if;
    if p_decision = 'accept' then
      v_accepted_request := private.truth_candidate_review_accept_request(
        p_workspace_key, p_target_id, p_expected_target_hash,
        p_policy_version, p_decided_by, 'operator'
      );
    end if;
    v_decision_receipt := private.append_truth_candidate_review_decision(
      p_workspace_key, p_target_id, p_expected_target_hash,
      coalesce(p_expected_previous_decision_version_id, ''), p_decision,
      'operator', p_policy_version, p_decided_by,
      jsonb_build_array(p_reason), v_accepted_request
    );
    if p_decision = 'accept' then
      v_item_receipt := private.append_accepted_claim(
        p_workspace_key,
        v_accepted_request->'claim',
        v_accepted_request->'evidence',
        v_accepted_request->'supersessions',
        p_sync_token
      );
      v_binding_receipt := private.bind_candidate_claim_acceptance(
        p_workspace_key, null::uuid, null::text, null::bigint, null::text,
        p_target_id, v_decision_receipt->>'decisionVersionId',
        v_item_receipt->>'claimVersionId', p_review_token
      );
      v_accepted_kind := 'accepted_claim';
      v_accepted_item_id := v_item_receipt->>'claimVersionId';
      v_accepted_item_hash := v_item_receipt->>'itemHash';
      v_binding_id := v_binding_receipt->>'bindingId';
      v_binding_item_hash := v_binding_receipt->>'itemHash';
    end if;
  else
    select * into v_proposal
    from public.truth_link_candidate_proposals proposal
    where proposal.proposal_id = p_target_id
      and proposal.workspace_key = p_workspace_key;
    if not found or v_proposal.proposal_hash is distinct from p_expected_target_hash then
      raise exception 'truth-link review target is unavailable or stale'
        using errcode = '40001';
    end if;
    select * into v_latest_link_decision
    from public.truth_link_candidate_decisions decision_row
    where decision_row.proposal_id = p_target_id
    order by decision_row.decision_no desc
    limit 1;
    if coalesce(p_expected_previous_decision_version_id, '') = '' then
      if found then
        raise exception 'truth-link review decision head changed' using errcode = '40001';
      end if;
      v_decision_no := 1;
    else
      if not found
        or v_latest_link_decision.decision_version_id is distinct from p_expected_previous_decision_version_id
        or v_latest_link_decision.decision <> 'review' then
        raise exception 'truth-link review decision head changed or is terminal'
          using errcode = '40001';
      end if;
      v_decision_no := v_latest_link_decision.decision_no + 1;
    end if;
    v_decision_receipt := private.append_truth_link_candidate_decision(
      p_workspace_key, null::uuid, null::text, null::bigint, null::text,
      p_target_id,
      jsonb_build_object(
        'decisionNo', v_decision_no,
        'previousDecisionVersionId', nullif(p_expected_previous_decision_version_id, ''),
        'decision', p_decision,
        'method', 'operator',
        'policyVersion', p_policy_version,
        'decidedBy', p_decided_by,
        'reasons', jsonb_build_array(p_reason)
      ),
      p_review_token
    );
    if p_decision = 'accept' then
      v_accepted_request := v_decision_receipt->'acceptedItemRequest';
      v_accepted_kind := v_accepted_request->>'acceptedKind';
      if v_accepted_kind = 'entity_link' then
        v_item_receipt := private.append_observation_entity_link(
          p_workspace_key, v_accepted_request->'link', p_sync_token
        );
        v_accepted_item_id := v_item_receipt->>'linkVersionId';
        v_accepted_item_hash := v_item_receipt->>'itemHash';
      elsif v_accepted_kind = 'workgroup_membership' then
        v_item_receipt := private.append_operational_workgroup_membership(
          p_workspace_key,
          v_accepted_request->'workgroup',
          v_accepted_request->'membership',
          v_accepted_request->'evidence',
          p_sync_token
        );
        v_accepted_item_id := v_item_receipt->>'membershipVersionId';
        v_accepted_item_hash := v_item_receipt->>'itemHash';
      elsif v_accepted_kind = 'workgroup' then
        select membership_envelope.workgroup_id, workgroup_envelope.definition_hash
        into v_workgroup_id, v_workgroup_hash
        from public.truth_link_candidate_proposals member_proposal
        join public.truth_link_acceptance_bindings member_binding
          on member_binding.proposal_id = member_proposal.proposal_id
         and member_binding.accepted_item_kind = 'workgroup_membership'
        join public.operational_workgroup_membership_envelopes membership_envelope
          on membership_envelope.membership_version_id = member_binding.accepted_item_id
         and membership_envelope.workspace_key = p_workspace_key
        join public.operational_workgroup_envelopes workgroup_envelope
          on workgroup_envelope.workgroup_id = membership_envelope.workgroup_id
         and workgroup_envelope.workspace_key = p_workspace_key
        where member_proposal.resolution_run_id = v_proposal.resolution_run_id
          and member_proposal.parent_candidate_key = v_proposal.candidate_key
          and member_proposal.candidate_kind = 'workgroup_membership'
        order by member_binding.accepted_item_id
        limit 1;
        if v_workgroup_id is null then
          raise exception 'workgroup review acceptance requires an accepted evidence-bound membership first'
            using errcode = '23514';
        end if;
        v_accepted_item_id := v_workgroup_id;
        v_accepted_item_hash := v_workgroup_hash;
      else
        raise exception 'truth-link review acceptance kind is invalid'
          using errcode = '23514';
      end if;
      v_binding_receipt := private.bind_truth_link_candidate_acceptance(
        p_workspace_key, null::uuid, null::text, null::bigint, null::text,
        p_target_id, v_decision_receipt->>'decisionVersionId',
        v_accepted_item_id, p_review_token
      );
      v_binding_id := v_binding_receipt->>'bindingId';
      v_binding_item_hash := v_binding_receipt->>'itemHash';
    end if;
  end if;

  v_receipt := jsonb_build_object(
    'ok', true,
    'reviewResolutionId', v_review_resolution_id,
    'targetKind', p_target_kind,
    'targetId', p_target_id,
    'targetItemHash', p_expected_target_hash,
    'decision', p_decision,
    'decisionVersionId', v_decision_receipt->>'decisionVersionId',
    'decisionItemHash', v_decision_receipt->>'itemHash',
    'acceptedKind', v_accepted_kind,
    'acceptedItemId', v_accepted_item_id,
    'acceptedItemHash', v_accepted_item_hash,
    'bindingId', v_binding_id,
    'bindingItemHash', v_binding_item_hash,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
  v_receipt_hash := encode(extensions.digest(
    convert_to(v_receipt::text, 'UTF8'), 'sha256'
  ), 'hex');
  insert into public.truth_review_resolutions (
    review_resolution_id, workspace_key, idempotency_key_hash,
    target_kind, target_id, target_item_hash, decision,
    decision_version_id, decision_item_hash, accepted_kind,
    accepted_item_id, accepted_item_hash, binding_id, binding_item_hash,
    request_hash, request_schema_version, canonical_request,
    receipt_hash, canonical_receipt
  ) values (
    v_review_resolution_id, p_workspace_key, v_idempotency_key_hash,
    p_target_kind, p_target_id, p_expected_target_hash, p_decision,
    v_decision_receipt->>'decisionVersionId', v_decision_receipt->>'itemHash',
    v_accepted_kind, v_accepted_item_id, v_accepted_item_hash,
    v_binding_id, v_binding_item_hash, v_request_hash,
    'truth-review-resolution-v1', v_canonical_request,
    v_receipt_hash, v_receipt
  );
  return v_receipt || jsonb_build_object(
    'idempotent', false,
    'reviewItemHash', v_receipt_hash
  );
end;
$function$;

create or replace function public.resolve_truth_review(
  p_workspace_key text,
  p_target_kind text,
  p_target_id text,
  p_expected_target_hash text,
  p_expected_previous_decision_version_id text,
  p_decision text,
  p_policy_version text,
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
  select private.resolve_truth_review(
    p_workspace_key, p_target_kind, p_target_id, p_expected_target_hash,
    p_expected_previous_decision_version_id, p_decision, p_policy_version,
    p_decided_by, p_reason, p_idempotency_key, p_review_token, p_sync_token
  );
$function$;

revoke all on function private.resolve_truth_review(
  text, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_truth_review(
  text, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_truth_review(
  text, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

-- Old multi-call operator surfaces can expose an accepted item between the
-- evidence append and the authorization binding. Keep the historical
-- functions for migration replay, but remove their runtime service grant.
revoke execute on function public.append_operator_candidate_claim_decision(text, text, jsonb, text)
  from service_role;
revoke execute on function public.bind_operator_candidate_claim_acceptance(text, text, text, text, text)
  from service_role;
revoke execute on function public.append_operator_truth_link_candidate_decision(text, text, jsonb, text)
  from service_role;
revoke execute on function public.bind_operator_truth_link_candidate_acceptance(text, text, text, text, text)
  from service_role;

create or replace function private.read_truth_review_queue(
  p_workspace_key text,
  p_target_kind text,
  p_limit integer,
  p_review_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_total_count integer;
  v_candidate_count integer;
  v_link_count integer;
  v_items jsonb;
begin
  if not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth review token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or coalesce(p_target_kind, '') <> all (array['', 'candidate_claim', 'link_proposal'])
    or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'truth review queue request is invalid' using errcode = '22023';
  end if;

  with candidate_queue as (
    select
      'candidate_claim'::text as target_kind,
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
        'candidate', candidate.canonical_envelope->'candidate'
      ) as item
    from public.candidate_claim_envelopes candidate
    join public.source_observations observation
      on observation.observation_id = candidate.source_observation_id
     and observation.workspace_key = p_workspace_key
    left join lateral (
      select decision_row.*
      from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id = candidate.candidate_claim_version_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    left join public.candidate_claim_acceptance_bindings binding
      on binding.candidate_claim_version_id = candidate.candidate_claim_version_id
    where candidate.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), link_queue as (
    select
      'link_proposal'::text as target_kind,
      proposal.proposal_id as target_id,
      proposal.created_at,
      jsonb_build_object(
        'targetKind', 'link_proposal',
        'targetId', proposal.proposal_id,
        'targetItemHash', proposal.proposal_hash,
        'nextDecisionNo', coalesce(latest.decision_no, 0) + 1,
        'previousDecisionVersionId', coalesce(latest.decision_version_id, ''),
        'currentDisposition', coalesce(latest.decision, 'pending'),
        'candidateKind', proposal.candidate_kind,
        'candidateKey', proposal.candidate_key,
        'parentCandidateKey', proposal.parent_candidate_key,
        'policyDisposition', proposal.policy_disposition,
        'proposal', proposal.canonical_proposal->'candidate',
        'evidenceObservationIds', coalesce(evidence.ids, '[]'::jsonb)
      ) as item
    from public.truth_link_candidate_proposals proposal
    left join lateral (
      select decision_row.*
      from public.truth_link_candidate_decisions decision_row
      where decision_row.proposal_id = proposal.proposal_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    left join public.truth_link_acceptance_bindings binding
      on binding.proposal_id = proposal.proposal_id
    left join lateral (
      select jsonb_agg(link_evidence.observation_id order by link_evidence.ordinal) as ids
      from public.truth_link_candidate_evidence link_evidence
      where link_evidence.proposal_id = proposal.proposal_id
    ) evidence on true
    where proposal.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), queue as (
    select * from candidate_queue where coalesce(p_target_kind, '') in ('', 'candidate_claim')
    union all
    select * from link_queue where coalesce(p_target_kind, '') in ('', 'link_proposal')
  )
  select
    count(*)::integer,
    count(*) filter (where target_kind = 'candidate_claim')::integer,
    count(*) filter (where target_kind = 'link_proposal')::integer
  into v_total_count, v_candidate_count, v_link_count
  from queue;

  with candidate_queue as (
    select
      'candidate_claim'::text as target_kind,
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
        'candidate', candidate.canonical_envelope->'candidate'
      ) as item
    from public.candidate_claim_envelopes candidate
    join public.source_observations observation
      on observation.observation_id = candidate.source_observation_id
     and observation.workspace_key = p_workspace_key
    left join lateral (
      select decision_row.*
      from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id = candidate.candidate_claim_version_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    left join public.candidate_claim_acceptance_bindings binding
      on binding.candidate_claim_version_id = candidate.candidate_claim_version_id
    where candidate.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), link_queue as (
    select
      'link_proposal'::text as target_kind,
      proposal.proposal_id as target_id,
      proposal.created_at,
      jsonb_build_object(
        'targetKind', 'link_proposal',
        'targetId', proposal.proposal_id,
        'targetItemHash', proposal.proposal_hash,
        'nextDecisionNo', coalesce(latest.decision_no, 0) + 1,
        'previousDecisionVersionId', coalesce(latest.decision_version_id, ''),
        'currentDisposition', coalesce(latest.decision, 'pending'),
        'candidateKind', proposal.candidate_kind,
        'candidateKey', proposal.candidate_key,
        'parentCandidateKey', proposal.parent_candidate_key,
        'policyDisposition', proposal.policy_disposition,
        'proposal', proposal.canonical_proposal->'candidate',
        'evidenceObservationIds', coalesce(evidence.ids, '[]'::jsonb)
      ) as item
    from public.truth_link_candidate_proposals proposal
    left join lateral (
      select decision_row.*
      from public.truth_link_candidate_decisions decision_row
      where decision_row.proposal_id = proposal.proposal_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    left join public.truth_link_acceptance_bindings binding
      on binding.proposal_id = proposal.proposal_id
    left join lateral (
      select jsonb_agg(link_evidence.observation_id order by link_evidence.ordinal) as ids
      from public.truth_link_candidate_evidence link_evidence
      where link_evidence.proposal_id = proposal.proposal_id
    ) evidence on true
    where proposal.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), queue as (
    select * from candidate_queue where coalesce(p_target_kind, '') in ('', 'candidate_claim')
    union all
    select * from link_queue where coalesce(p_target_kind, '') in ('', 'link_proposal')
  ), bounded as (
    select item
    from queue
    order by created_at, target_kind, target_id
    limit p_limit
  )
  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items from bounded;

  return jsonb_build_object(
    'ok', true,
    'workspaceKey', p_workspace_key,
    'targetKind', coalesce(p_target_kind, ''),
    'limit', p_limit,
    'totalCount', v_total_count,
    'candidateCount', v_candidate_count,
    'linkCount', v_link_count,
    'items', v_items,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
end;
$function$;

create or replace function public.read_truth_review_queue(
  p_workspace_key text,
  p_target_kind text,
  p_limit integer,
  p_review_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.read_truth_review_queue(
    p_workspace_key, p_target_kind, p_limit, p_review_token
  );
$function$;

revoke all on function private.read_truth_review_queue(text, text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_truth_review_queue(text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.read_truth_review_queue(text, text, integer, text)
  to service_role;

-- Every source cut carries a deterministic witness for unresolved candidate
-- and link/workgroup review. The cut remains sealable for replay, but its
-- completeness is degraded until every target has a terminal rejection or an
-- accepted item with the exact authorization binding.
create or replace function private.truth_review_gaps_for_source_cut(
  p_workspace_key text,
  p_cursors jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with in_scope_observations as (
    select observation.observation_id
    from jsonb_array_elements(p_cursors) cursor_item
    join public.source_observations observation
      on observation.workspace_key = p_workspace_key
     and observation.source_system = cursor_item->>'sourceSystem'
     and observation.connection_key = cursor_item->>'connectionKey'
     and observation.source_cursor_version <= (cursor_item->>'throughCursorVersion')::bigint
  ), unresolved_candidates as (
    select candidate.candidate_claim_version_id as target_id,
           candidate.envelope_hash as item_hash
    from public.candidate_claim_envelopes candidate
    join in_scope_observations scoped
      on scoped.observation_id = candidate.source_observation_id
    left join lateral (
      select decision_row.*
      from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id = candidate.candidate_claim_version_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    left join public.candidate_claim_acceptance_bindings binding
      on binding.candidate_claim_version_id = candidate.candidate_claim_version_id
    where candidate.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), unresolved_links as (
    select distinct proposal.proposal_id as target_id,
           proposal.proposal_hash as item_hash
    from public.truth_link_candidate_proposals proposal
    join public.truth_link_candidate_evidence evidence
      on evidence.proposal_id = proposal.proposal_id
    join in_scope_observations scoped
      on scoped.observation_id = evidence.observation_id
    left join lateral (
      select decision_row.*
      from public.truth_link_candidate_decisions decision_row
      where decision_row.proposal_id = proposal.proposal_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    left join public.truth_link_acceptance_bindings binding
      on binding.proposal_id = proposal.proposal_id
    where proposal.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), gaps as (
    select jsonb_build_object(
      'gapType', 'CANDIDATE_CLAIM_REVIEW_PENDING',
      'count', count(*)::integer,
      'witnessHash', encode(extensions.digest(convert_to(
        coalesce(string_agg(target_id || ':' || item_hash, ',' order by target_id), ''),
        'UTF8'
      ), 'sha256'), 'hex')
    ) as gap
    from unresolved_candidates
    having count(*) > 0
    union all
    select jsonb_build_object(
      'gapType', 'LINK_WORKGROUP_REVIEW_PENDING',
      'count', count(*)::integer,
      'witnessHash', encode(extensions.digest(convert_to(
        coalesce(string_agg(target_id || ':' || item_hash, ',' order by target_id), ''),
        'UTF8'
      ), 'sha256'), 'hex')
    ) as gap
    from unresolved_links
    having count(*) > 0
  )
  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb) from gaps;
$function$;

revoke all on function private.truth_review_gaps_for_source_cut(text, jsonb)
  from public, anon, authenticated, service_role;

do $block$
begin
  if to_regprocedure(
    'private.seal_source_cut_pre_review_v1(text,text,jsonb,jsonb,jsonb,jsonb,text,text)'
  ) is null then
    alter function private.seal_source_cut(
      text, text, jsonb, jsonb, jsonb, jsonb, text, text
    ) rename to seal_source_cut_pre_review_v1;
  end if;
end;
$block$;

create or replace function private.seal_source_cut(
  p_workspace_key text,
  p_manifest_schema_version text,
  p_required_sources jsonb,
  p_gaps jsonb,
  p_cursors jsonb,
  p_observations jsonb,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.seal_source_cut_pre_review_v1(
    p_workspace_key,
    p_manifest_schema_version,
    p_required_sources,
    coalesce(p_gaps, '[]'::jsonb)
      || private.truth_review_gaps_for_source_cut(p_workspace_key, p_cursors),
    p_cursors,
    p_observations,
    p_created_by,
    p_sync_token
  );
$function$;

revoke all on function private.seal_source_cut_pre_review_v1(
  text, text, jsonb, jsonb, jsonb, jsonb, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.seal_source_cut(
  text, text, jsonb, jsonb, jsonb, jsonb, text, text
) from public, anon, authenticated, service_role;
