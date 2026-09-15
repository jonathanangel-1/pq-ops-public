create extension if not exists pgcrypto with schema extensions;

-- Durable candidate-claim staging. Candidates are evidence-bound, immutable,
-- and intentionally absent from truth_build_inputs' allowed item kinds. Only
-- an accepted-claim envelope can become reducer input.

create table if not exists public.candidate_claim_envelopes (
  candidate_claim_version_id text primary key
    check (candidate_claim_version_id ~ '^candidate:v1:[0-9a-f]{64}$'),
  workspace_key text not null,
  source_observation_id text not null
    references public.source_observations(observation_id) on delete restrict,
  source_observation_content_hash text not null
    check (source_observation_content_hash ~ '^[0-9a-f]{64}$'),
  source_object_type text not null
    check (source_object_type = any (array[
      'gmail_message_parsed',
      'gmail_attachment_extracted',
      'tms_shipment_snapshot',
      'tracking_shipment_snapshot',
      'operator_event'
    ])),
  source_object_id text not null,
  source_review_required boolean not null,
  source_extraction_method text not null,
  claim_key text not null,
  version_no integer not null check (version_no > 0),
  previous_claim_version_id text
    references public.accepted_claims(claim_version_id) on delete restrict,
  extraction_method text not null
    check (extraction_method = any (array['deterministic', 'model'])),
  recommendation text not null
    check (recommendation = any (array['accept', 'review', 'reject'])),
  recommendation_policy_version text not null,
  ambiguity_status text not null
    check (ambiguity_status = any (array['none', 'review'])),
  contradiction_status text not null
    check (contradiction_status = any (array['none', 'known'])),
  envelope_hash text not null unique check (envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope_schema_version text not null,
  extractor_candidate jsonb not null check (jsonb_typeof(extractor_candidate) = 'object'),
  canonical_envelope jsonb not null check (jsonb_typeof(canonical_envelope) = 'object'),
  created_at timestamptz not null default now(),
  check (candidate_claim_version_id = 'candidate:v1:' || envelope_hash),
  unique (workspace_key, claim_key, version_no, source_observation_id, envelope_hash)
);

-- The database independently pins the candidate predicate semantics used by
-- automatic acceptance. A candidate cannot promote an arbitrary status or
-- effect merely because an extractor emitted syntactically valid JSON.
create table if not exists public.candidate_claim_predicate_registry (
  predicate text not null,
  extractor_version text not null,
  candidate_schema_version text not null,
  source_system text not null
    check (source_system = any (array['gmail', 'tms', 'tracking', 'operator'])),
  gate text not null,
  statuses jsonb not null check (jsonb_typeof(statuses) = 'object'),
  effects jsonb not null check (jsonb_typeof(effects) = 'object'),
  registry_version text not null,
  registry_hash text not null check (registry_hash ~ '^[0-9a-f]{64}$'),
  acceptance_policy_version text not null,
  created_at timestamptz not null default now(),
  primary key (predicate, extractor_version)
);

insert into public.candidate_claim_predicate_registry (
  predicate, extractor_version, candidate_schema_version, source_system,
  gate, statuses, effects, registry_version, registry_hash,
  acceptance_policy_version
)
select
  predicate.predicate,
  extractor.extractor_version,
  extractor.candidate_schema_version,
  extractor.source_system,
  predicate.gate,
  predicate.statuses::jsonb,
  predicate.effects::jsonb,
  'pikiio-shipment-predicates-2026-07-09-v1',
  '73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
  extractor.acceptance_policy_version
from (values
  ('arrival_confirmed', 'arrival', '{"positive":"arrived","negative":"not_arrived","requested":"requested","neutral":"planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('transport_in_transit', 'arrival', '{"positive":"in_transit","negative":"not_in_transit","requested":"status_requested","neutral":"scheduled","unknown":"unknown"}', '{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}'),
  ('cargo_not_found', 'arrival', '{"positive":"not_found","negative":"located","requested":"location_requested","neutral":"investigating","unknown":"unknown"}', '{"positive":"block","negative":"context","requested":"request","neutral":"context","unknown":"context"}'),
  ('customs_release', 'customs', '{"positive":"released","negative":"not_released","requested":"requested","neutral":"planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('customs_hold', 'customs', '{"positive":"active","negative":"removed","requested":"status_requested","neutral":"expected","unknown":"unknown"}', '{"positive":"block","negative":"context","requested":"request","neutral":"context","unknown":"context"}'),
  ('delivery_order_received', 'customs', '{"positive":"received","negative":"missing","requested":"requested","neutral":"expected","unknown":"unknown"}', '{"positive":"context","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('station_fees_due', 'fees', '{"positive":"due","negative":"none_due","requested":"amount_requested","neutral":"estimated","unknown":"unknown"}', '{"positive":"block","negative":"context","requested":"request","neutral":"context","unknown":"context"}'),
  ('station_fees_paid', 'fees', '{"positive":"paid","negative":"unpaid","requested":"payment_requested","neutral":"payment_planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('dispatch_confirmed', 'dispatch', '{"positive":"confirmed","negative":"not_confirmed","requested":"requested","neutral":"planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('pickup_scheduled', 'pickup', '{"positive":"scheduled","negative":"cancelled","requested":"schedule_requested","neutral":"planned","unknown":"unknown"}', '{"positive":"context","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('pickup_completed', 'pickup', '{"positive":"picked_up","negative":"not_picked_up","requested":"requested","neutral":"planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('out_for_delivery', 'delivery', '{"positive":"out_for_delivery","negative":"not_out_for_delivery","requested":"status_requested","neutral":"planned","unknown":"unknown"}', '{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}'),
  ('delivery_scheduled', 'delivery', '{"positive":"scheduled","negative":"cancelled","requested":"schedule_requested","neutral":"planned","unknown":"unknown"}', '{"positive":"context","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('delivery_completed', 'delivery', '{"positive":"delivered","negative":"not_delivered","requested":"requested","neutral":"planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('pod_received', 'pod', '{"positive":"received","negative":"missing","requested":"requested","neutral":"planned","unknown":"unknown"}', '{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}'),
  ('last_free_day', 'fees', '{"positive":"stated","negative":"unknown","requested":"requested","neutral":"estimated","unknown":"unknown"}', '{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}'),
  ('quote_received', 'dispatch', '{"positive":"received","negative":"missing","requested":"requested","neutral":"expected","unknown":"unknown"}', '{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}')
) as predicate(predicate, gate, statuses, effects)
cross join (values
  (
    'gmail-claim-extractor-v3+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
    'gmail-candidate-claim-v1',
    'gmail',
    'gmail-candidate-acceptance-v2+pikiio-shipment-predicates-2026-07-09-v1',
    null::text[]
  ),
  (
    'tms-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
    'tms-candidate-claim-v1',
    'tms',
    'tms-candidate-acceptance-v1+pikiio-shipment-predicates-2026-07-09-v1',
    array[
      'arrival_confirmed', 'transport_in_transit', 'out_for_delivery',
      'customs_release', 'delivery_completed', 'pod_received'
    ]::text[]
  ),
  (
    'tracking-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
    'tracking-candidate-claim-v1',
    'tracking',
    'tracking-candidate-acceptance-v1+pikiio-shipment-predicates-2026-07-09-v1',
    array['arrival_confirmed', 'transport_in_transit']::text[]
  ),
  (
    'operator-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
    'operator-candidate-claim-v1',
    'operator',
    'operator-candidate-acceptance-v1+pikiio-shipment-predicates-2026-07-09-v1',
    null::text[]
  )
) as extractor(
  extractor_version, candidate_schema_version, source_system,
  acceptance_policy_version, supported_predicates
)
where extractor.supported_predicates is null
   or predicate.predicate = any (extractor.supported_predicates)
on conflict (predicate, extractor_version) do nothing;

create table if not exists public.candidate_claim_job_lineage (
  candidate_claim_version_id text not null
    references public.candidate_claim_envelopes(candidate_claim_version_id) on delete restrict,
  job_id uuid not null
    references public.source_processing_jobs(job_id) on delete restrict,
  source_observation_id text not null
    references public.source_observations(observation_id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (candidate_claim_version_id, job_id)
);

create table if not exists public.candidate_claim_job_manifests (
  job_id uuid primary key
    references public.source_processing_jobs(job_id) on delete restrict,
  workspace_key text not null,
  source_observation_id text not null
    references public.source_observations(observation_id) on delete restrict,
  candidate_count integer not null check (candidate_count >= 0),
  manifest_hash text not null unique check (manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest_schema_version text not null,
  canonical_manifest jsonb not null check (jsonb_typeof(canonical_manifest) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.candidate_claim_decisions (
  decision_version_id text primary key
    check (decision_version_id ~ '^candidate-decision:v1:[0-9a-f]{64}$'),
  candidate_claim_version_id text not null
    references public.candidate_claim_envelopes(candidate_claim_version_id) on delete restrict,
  decision_no integer not null check (decision_no > 0),
  previous_decision_version_id text
    references public.candidate_claim_decisions(decision_version_id) on delete restrict,
  decision text not null check (decision = any (array['accept', 'review', 'reject'])),
  decision_method text not null check (decision_method = any (array['policy', 'operator'])),
  policy_version text not null,
  decided_by text not null,
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array'),
  accepted_claim_request jsonb
    check (accepted_claim_request is null or jsonb_typeof(accepted_claim_request) = 'object'),
  decision_hash text not null unique check (decision_hash ~ '^[0-9a-f]{64}$'),
  decision_schema_version text not null,
  canonical_decision jsonb not null check (jsonb_typeof(canonical_decision) = 'object'),
  created_at timestamptz not null default now(),
  check (decision_version_id = 'candidate-decision:v1:' || decision_hash),
  check ((decision = 'accept') = (accepted_claim_request is not null)),
  unique (candidate_claim_version_id, decision_no)
);

create unique index if not exists candidate_claim_decisions_previous_unique
  on public.candidate_claim_decisions(previous_decision_version_id)
  where previous_decision_version_id is not null;

create table if not exists public.candidate_claim_acceptance_bindings (
  binding_id text primary key
    check (binding_id ~ '^candidate-acceptance:v1:[0-9a-f]{64}$'),
  candidate_claim_version_id text not null unique
    references public.candidate_claim_envelopes(candidate_claim_version_id) on delete restrict,
  decision_version_id text not null unique
    references public.candidate_claim_decisions(decision_version_id) on delete restrict,
  accepted_claim_version_id text not null unique
    references public.accepted_claims(claim_version_id) on delete restrict,
  binding_hash text not null unique check (binding_hash ~ '^[0-9a-f]{64}$'),
  binding_schema_version text not null,
  canonical_binding jsonb not null check (jsonb_typeof(canonical_binding) = 'object'),
  created_at timestamptz not null default now(),
  check (binding_id = 'candidate-acceptance:v1:' || binding_hash)
);

create index if not exists candidate_claim_envelopes_observation_idx
  on public.candidate_claim_envelopes(workspace_key, source_observation_id, created_at);
create index if not exists candidate_claim_envelopes_pending_idx
  on public.candidate_claim_envelopes(workspace_key, created_at);
create index if not exists candidate_claim_job_lineage_job_idx
  on public.candidate_claim_job_lineage(job_id, candidate_claim_version_id);
create index if not exists candidate_claim_decisions_candidate_idx
  on public.candidate_claim_decisions(candidate_claim_version_id, decision_no);

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'candidate_claim_envelopes',
    'candidate_claim_predicate_registry',
    'candidate_claim_job_lineage',
    'candidate_claim_job_manifests',
    'candidate_claim_decisions',
    'candidate_claim_acceptance_bindings'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',
      v_table,
      v_table
    );
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('grant select on public.%I to service_role', v_table);
    execute format('revoke insert, update, delete, truncate on public.%I from service_role', v_table);
  end loop;
end;
$block$;

-- Candidate-origin accepted claims are not reducer inputs until their
-- immutable candidate/decision/accepted-claim binding exists. This closes the
-- crash window between the accepted-claim append and the worker's final bind.
create or replace function public.guard_truth_build_input_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_status text;
begin
  select build.status into v_status
  from public.truth_builds build
  where build.build_id = new.build_id
  for update;
  if not found or v_status <> 'running' then
    raise exception 'truth build inputs may only be inserted while the build is running'
      using errcode = '55000';
  end if;
  if new.item_kind = 'accepted_claim'
    and exists (
      select 1 from public.accepted_claims claim
      where claim.claim_version_id = new.item_id
        and claim.schema_version = 'candidate-accepted-claim-v1'
    )
    and not exists (
      select 1 from public.candidate_claim_acceptance_bindings binding
      where binding.accepted_claim_version_id = new.item_id
    ) then
    raise exception 'candidate-origin accepted claim lacks its immutable acceptance binding'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function private.truth_utf16_span_matches(
  p_text text,
  p_span jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_start integer;
  v_end integer;
  v_units integer := 0;
  v_width integer;
  v_char text;
  v_slice text := '';
  v_index integer;
begin
  if jsonb_typeof(coalesce(p_span, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(p_span, array['start', 'end', 'unit', 'quote'])
    or coalesce(p_span->>'start', '') !~ '^[0-9]+$'
    or coalesce(p_span->>'end', '') !~ '^[0-9]+$'
    or length(p_span->>'start') > 10
    or length(p_span->>'end') > 10
    or p_span->>'unit' <> 'utf16_code_units'
    or jsonb_typeof(coalesce(p_span->'quote', 'null'::jsonb)) <> 'string' then
    return false;
  end if;
  if (p_span->>'start')::numeric > 2147483647
    or (p_span->>'end')::numeric > 2147483647 then
    return false;
  end if;
  v_start := (p_span->>'start')::integer;
  v_end := (p_span->>'end')::integer;
  if v_end <= v_start then
    return false;
  end if;
  if v_start = 0 and v_end = 0 then
    return p_span->>'quote' = '';
  end if;
  if char_length(coalesce(p_text, '')) = 0 then
    return false;
  end if;
  for v_index in 1..char_length(p_text) loop
    v_char := substr(p_text, v_index, 1);
    v_width := case when ascii(v_char) > 65535 then 2 else 1 end;
    if v_units < v_start and v_units + v_width > v_start then
      return false;
    end if;
    if v_units >= v_start and v_units < v_end then
      v_slice := v_slice || v_char;
    end if;
    v_units := v_units + v_width;
    if v_units >= v_end then
      exit;
    end if;
  end loop;
  return v_units = v_end and v_slice = p_span->>'quote';
end;
$function$;

revoke all on function private.truth_utf16_span_matches(text, jsonb)
  from public, anon, authenticated, service_role;

-- Match the compact, recursively key-sorted JSON encoding used by the source
-- adapters and Node extractors. This lets structured operator assertions cite
-- an exact object without trusting client-provided hash or preview fields.
create or replace function private.truth_canonical_json_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $function$
declare
  v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':' || private.truth_canonical_json_text(entry.value),
        ',' order by entry.key
      ), '') || '}'
      into v_result
      from jsonb_each(p_value) entry;
    when 'array' then
      select '[' || coalesce(string_agg(
        private.truth_canonical_json_text(item.value),
        ',' order by item.ordinal
      ), '') || ']'
      into v_result
      from jsonb_array_elements(p_value) with ordinality item(value, ordinal);
    else
      v_result := p_value::text;
  end case;
  return v_result;
end;
$function$;

revoke all on function private.truth_canonical_json_text(jsonb)
  from public, anon, authenticated, service_role;

-- TMS, tracking, and operator evidence is structured rather than prose. The
-- citation must resolve to an exact immutable normalized-payload field, and
-- both the hash and preview are derived again by the server.
create or replace function private.truth_structured_field_matches(
  p_payload jsonb,
  p_span jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_value jsonb := p_payload;
  v_key text;
  v_text text;
begin
  if jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_span, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(
      p_span,
      array['kind', 'path', 'valueHash', 'valuePreview']
    )
    or p_span->>'kind' <> 'structured_field'
    or jsonb_typeof(coalesce(p_span->'path', 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_span->'path') = 0
    or exists (
      select 1 from jsonb_array_elements(p_span->'path') path_item
      where jsonb_typeof(path_item) <> 'string'
        or nullif(path_item #>> '{}', '') is null
    )
    or coalesce(p_span->>'valueHash', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(coalesce(p_span->'valuePreview', 'null'::jsonb)) <> 'string' then
    return false;
  end if;
  for v_key in select jsonb_array_elements_text(p_span->'path') loop
    if jsonb_typeof(v_value) <> 'object' or not (v_value ? v_key) then
      return false;
    end if;
    v_value := v_value->v_key;
  end loop;
  v_text := case
    when jsonb_typeof(v_value) = 'string' then trim(v_value #>> '{}')
    else trim(private.truth_canonical_json_text(v_value))
  end;
  return encode(
    extensions.digest(
      convert_to(private.truth_canonical_json_text(v_value), 'UTF8'),
      'sha256'
    ),
    'hex'
  ) = p_span->>'valueHash'
    and left(v_text, 500) = p_span->>'valuePreview';
end;
$function$;

revoke all on function private.truth_structured_field_matches(jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.truth_iso_date_valid(p_value text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return false;
  end if;
  return to_char(p_value::date, 'YYYY-MM-DD') = p_value;
exception when others then
  return false;
end;
$function$;

revoke all on function private.truth_iso_date_valid(text)
  from public, anon, authenticated, service_role;

create or replace function private.truth_tms_policy_candidate_eligible(p_candidate jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select
    p_candidate->>'schemaVersion' = 'tms-candidate-claim-v1'
    and p_candidate->>'sourceObjectType' = 'tms_shipment_snapshot'
    and p_candidate->'normalizedValue'->>'sourceClass' = 'tms'
    and p_candidate->'normalizedValue'->>'responsibleActor' = 'automated_system'
    and p_candidate->'normalizedValue'->>'evidenceDirectness' = 'operational_summary'
    and jsonb_typeof(p_candidate->'normalizedValue'->'statusCode') = 'number'
    and (
      (
        p_candidate->>'predicate' = 'arrival_confirmed'
        and (
          ((p_candidate->'normalizedValue'->>'statusCode')::integer = 280
            and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^280-ARR@DEST(?:$|[^A-Z0-9])')
          or ((p_candidate->'normalizedValue'->>'statusCode')::integer = 295
            and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^295-CUSTOMS REL(?:$|[^A-Z0-9])')
          or ((p_candidate->'normalizedValue'->>'statusCode')::integer = 320
            and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^320-OUT FOR DEL(?:$|[^A-Z0-9])')
        )
      )
      or (
        p_candidate->>'predicate' = 'transport_in_transit'
        and (
          ((p_candidate->'normalizedValue'->>'statusCode')::integer = 240
            and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^240-DROPPED@A/L(?:$|[^A-Z0-9])')
          or ((p_candidate->'normalizedValue'->>'statusCode')::integer = 270
            and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^270-INTRANSIT(?:$|[^A-Z0-9])')
          or ((p_candidate->'normalizedValue'->>'statusCode')::integer = 275
            and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^275-CONF ONBOAR(?:$|[^A-Z0-9])')
        )
      )
      or (
        p_candidate->>'predicate' = 'out_for_delivery'
        and (p_candidate->'normalizedValue'->>'statusCode')::integer = 320
        and p_candidate->'normalizedValue'->>'tmsStatus' ~* '^320-OUT FOR DEL(?:$|[^A-Z0-9])'
      )
    );
$function$;

revoke all on function private.truth_tms_policy_candidate_eligible(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.truth_tracking_policy_candidate_eligible(
  p_candidate jsonb,
  p_payload jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_raw_code text;
  v_event_code text;
  v_expected_path jsonb;
begin
  if p_candidate->>'schemaVersion' <> 'tracking-candidate-claim-v1'
    or p_candidate->>'sourceObjectType' <> 'tracking_shipment_snapshot'
    or p_payload->>'schemaVersion' <> 'tracking-source-observation-v1'
    or p_payload->'sourceHealth'->>'positiveEvidenceEligible' <> 'true'
    or p_payload->'sourceHealth'->>'status' <> 'healthy'
    or p_payload->'tracking'->>'ok' <> 'true'
    or coalesce(p_payload->'tracking'->>'noResult', 'false') = 'true'
    or jsonb_typeof(p_payload->'tracking'->'latestEvent') <> 'object'
    or p_payload->'provenance'->>'sourceKind' <> 'official_carrier_tracking'
    or nullif(trim(coalesce(p_payload->'provenance'->>'url', '')), '') is null
    or nullif(trim(coalesce(p_payload->'provenance'->>'title', '')), '') is null
    or nullif(trim(coalesce(p_payload->'provenance'->>'status', '')), '') is null
    or p_candidate->>'sourceObjectId' is distinct from p_payload->>'awb'
    or p_candidate->>'subjectType' <> 'shipment'
    or p_candidate->>'subjectKey' is distinct from p_payload->>'awb'
    or p_candidate->'appliesToAwbs' is distinct from jsonb_build_array(p_payload->>'awb')
    or p_candidate->'occurredAt' is distinct from 'null'::jsonb
    or p_candidate->>'confidenceLabel' <> 'high'
    or not private.truth_jsonb_has_only_keys(
      p_candidate->'normalizedValue',
      array[
        'status', 'effect', 'sourceClass', 'responsibleActor',
        'evidenceDirectness', 'carrier', 'eventCode', 'eventDescription',
        'station', 'eventTimeLocal'
      ]
    )
    or (select count(*) from jsonb_each(p_candidate->'normalizedValue')) <> 10
    or p_candidate->'normalizedValue'->>'sourceClass' <> 'tracking'
    or p_candidate->'normalizedValue'->>'responsibleActor' <> 'carrier_tracking'
    or p_candidate->'normalizedValue'->>'evidenceDirectness' <> 'direct_provider_event'
    or p_candidate->'normalizedValue'->>'carrier'
      is distinct from trim(coalesce(p_payload->>'carrier', ''))
    or p_candidate->'normalizedValue'->>'eventDescription'
      is distinct from trim(coalesce(p_payload->'tracking'->'latestEvent'->>'description', ''))
    or p_candidate->'normalizedValue'->>'station'
      is distinct from trim(coalesce(p_payload->'tracking'->'latestEvent'->>'station', ''))
    or p_candidate->'normalizedValue'->>'eventTimeLocal'
      is distinct from trim(coalesce(p_payload->'tracking'->'latestEvent'->>'timeLocal', '')) then
    return false;
  end if;

  if nullif(trim(coalesce(p_payload->'tracking'->'latestEvent'->>'code', '')), '') is not null then
    v_raw_code := p_payload->'tracking'->'latestEvent'->>'code';
    v_expected_path := '["tracking","latestEvent","code"]'::jsonb;
  elsif nullif(trim(coalesce(p_payload->'tracking'->>'summaryCode', '')), '') is not null then
    v_raw_code := p_payload->'tracking'->>'summaryCode';
    v_expected_path := '["tracking","summaryCode"]'::jsonb;
  elsif nullif(trim(coalesce(p_payload->'tracking'->>'status', '')), '') is not null then
    v_raw_code := p_payload->'tracking'->>'status';
    v_expected_path := '["tracking","status"]'::jsonb;
  else
    return false;
  end if;
  v_event_code := upper(regexp_replace(trim(v_raw_code), '\s+', ' ', 'g'));
  if p_candidate->'normalizedValue'->>'eventCode' is distinct from v_event_code
    or p_candidate->'evidenceSpan'->'path' is distinct from v_expected_path then
    return false;
  end if;
  return (
    p_candidate->>'predicate' = 'arrival_confirmed'
    and v_event_code = any (array['ARR', 'RCF', 'AWD'])
    and (p_candidate->>'confidence')::numeric = 0.96
  ) or (
    p_candidate->>'predicate' = 'transport_in_transit'
    and v_event_code = any (array['DEP', 'IN_TRANSIT', 'IN-TRANSIT', 'IN TRANSIT'])
    and (p_candidate->>'confidence')::numeric = 0.95
  );
end;
$function$;

revoke all on function private.truth_tracking_policy_candidate_eligible(jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.truth_operator_policy_candidate_eligible(
  p_candidate jsonb,
  p_payload jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select
    p_candidate->>'schemaVersion' = 'operator-candidate-claim-v1'
    and p_candidate->>'sourceObjectType' = 'operator_event'
    and p_payload->>'schemaVersion' = 'operator-event-source-observation-v1'
    and p_payload->'event'->>'eventType' = 'assertion'
    and p_candidate->>'sourceObjectId' = p_payload->'event'->>'eventId'
    and p_candidate->>'predicate' = p_payload->'event'->'assertion'->>'predicate'
    and p_candidate->>'polarity' = p_payload->'event'->'assertion'->>'polarity'
    and p_payload->'event'->'assertion'->>'contractVersion'
      = 'pikiio-shipment-predicates-2026-07-09-v1'
    and p_candidate->'normalizedValue' = p_payload->'event'->'assertion'->'value'
    and private.truth_jsonb_has_only_keys(
      p_candidate->'normalizedValue', array['status', 'effect']
    )
    and (select count(*) from jsonb_each(p_candidate->'normalizedValue')) = 2
    and p_candidate->'evidenceSpan'->'path' = '["event","assertion"]'::jsonb
    and p_candidate->>'confidence' = '1'
    and p_candidate->>'confidenceLabel' = 'high'
    and (p_candidate->>'occurredAt')::timestamptz
      = (p_payload->'event'->>'occurredAt')::timestamptz;
$function$;

revoke all on function private.truth_operator_policy_candidate_eligible(jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.valid_candidate_operator_token(p_operator_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens
    where token_name = 'candidate_claim_operator_decider'
      and token_hash = encode(
        extensions.digest(convert_to(p_operator_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

revoke all on function private.valid_candidate_operator_token(text)
  from public, anon, authenticated, service_role;

create or replace function private.assert_candidate_claim_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text
)
returns public.source_processing_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
begin
  select * into v_job
  from public.source_processing_jobs
  where job_id = p_job_id
  for update;
  if not found
    or not (
      (
        v_job.source_system = 'gmail'
        and v_job.job_kind = any (array[
          'gmail_extract_message_claims',
          'gmail_extract_attachment_claims'
        ])
      )
      or (
        v_job.source_system = 'tms'
        and v_job.job_kind = 'tms_extract_claims'
      )
      or (
        v_job.source_system = 'tracking'
        and v_job.job_kind = 'tracking_extract_claims'
      )
      or (
        v_job.source_system = 'operator'
        and v_job.job_kind = 'operator_extract_claims'
      )
    )
    or v_job.state <> 'leased'
    or v_job.lease_owner is distinct from p_worker_id
    or v_job.lease_fence is distinct from p_lease_fence
    or v_job.processor_version is distinct from p_processor_version
    or v_job.lease_expires_at is null
    or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'candidate-claim source-processing lease lost' using errcode = '40001';
  end if;
  return v_job;
end;
$function$;

revoke all on function private.assert_candidate_claim_job_lease(uuid, text, bigint, text)
  from public, anon, authenticated, service_role;

create or replace function private.append_candidate_claim(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_observation public.source_observations%rowtype;
  v_previous_claim_version_id text;
  v_version_no integer;
  v_confidence numeric;
  v_awbs jsonb;
  v_source_awbs jsonb;
  v_ambiguity jsonb;
  v_contradiction jsonb;
  v_recommendation jsonb;
  v_temporal jsonb;
  v_predicate_policy public.candidate_claim_predicate_registry%rowtype;
  v_occurred_at timestamptz;
  v_source_message_id text;
  v_source_thread_id text;
  v_source_review_required boolean := false;
  v_source_extraction_method text := '';
  v_source_anchor timestamptz;
  v_envelope jsonb;
  v_envelope_hash text;
  v_candidate_claim_version_id text;
  v_existing public.candidate_claim_envelopes%rowtype;
  v_idempotent boolean := false;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or jsonb_typeof(coalesce(p_candidate, 'null'::jsonb)) <> 'object' then
    raise exception 'candidate claim request is invalid' using errcode = '22023';
  end if;
  if not private.truth_jsonb_has_only_keys(p_candidate, array[
    'schemaVersion', 'claimKey', 'versionNo', 'previousClaimVersionId',
    'sourceObservationId', 'sourceObservationContentHash', 'sourceObjectType',
    'sourceObjectId', 'sourceMessageId', 'sourceThreadId', 'sourceCapturedAt',
    'subjectType', 'subjectKey',
    'appliesToAwbs', 'predicate', 'gate', 'polarity', 'normalizedValue',
    'occurredAt', 'confidence', 'confidenceLabel', 'evidenceSpan',
    'extractionMethod', 'extractorVersion', 'model', 'promptVersion',
    'ambiguity', 'contradiction', 'acceptanceRecommendation'
  ]) then
    raise exception 'candidate claim contains unsupported fields' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'schemaVersion', 'claimKey', 'sourceObservationId',
      'sourceObservationContentHash', 'subjectType', 'subjectKey',
      'predicate', 'gate', 'polarity',
      'confidenceLabel', 'extractionMethod', 'extractorVersion'
    ]) required_key
    where nullif(trim(coalesce(p_candidate->>required_key, '')), '') is null
  ) then
    raise exception 'candidate claim required fields are incomplete' using errcode = '23514';
  end if;
  if not (p_candidate->>'schemaVersion' = any (array[
      'gmail-candidate-claim-v1',
      'tms-candidate-claim-v1',
      'tracking-candidate-claim-v1',
      'operator-candidate-claim-v1'
    ]))
    or jsonb_typeof(coalesce(p_candidate->'versionNo', 'null'::jsonb)) <> 'number'
    or coalesce(p_candidate->>'versionNo', '') !~ '^[1-9][0-9]*$'
    or length(p_candidate->>'versionNo') > 10
    or (p_candidate->>'versionNo')::numeric > 2147483647
    or jsonb_typeof(coalesce(p_candidate->'normalizedValue', 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_candidate->'appliesToAwbs', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_candidate->'confidence', 'null'::jsonb)) <> 'number' then
    raise exception 'candidate claim scalar or JSON type is invalid' using errcode = '22023';
  end if;
  v_version_no := (p_candidate->>'versionNo')::integer;
  v_previous_claim_version_id := nullif(coalesce(p_candidate->>'previousClaimVersionId', ''), '');
  if p_candidate ? 'previousClaimVersionId'
    and jsonb_typeof(p_candidate->'previousClaimVersionId') not in ('string', 'null') then
    raise exception 'candidate previous claim identifier is invalid' using errcode = '22023';
  end if;
  if p_candidate->>'schemaVersion' = 'gmail-candidate-claim-v1'
    and (
      jsonb_typeof(coalesce(p_candidate->'sourceMessageId', 'null'::jsonb)) <> 'string'
      or nullif(trim(coalesce(p_candidate->>'sourceMessageId', '')), '') is null
      or jsonb_typeof(coalesce(p_candidate->'sourceThreadId', 'null'::jsonb)) <> 'string'
      or p_candidate ? 'sourceObjectType'
      or p_candidate ? 'sourceObjectId'
    ) then
    raise exception 'candidate Gmail source message/thread identity is invalid'
      using errcode = '22023';
  end if;
  if p_candidate->>'schemaVersion' = 'tms-candidate-claim-v1'
    and (
      jsonb_typeof(coalesce(p_candidate->'sourceObjectType', 'null'::jsonb)) <> 'string'
      or p_candidate->>'sourceObjectType' <> 'tms_shipment_snapshot'
      or jsonb_typeof(coalesce(p_candidate->'sourceObjectId', 'null'::jsonb)) <> 'string'
      or nullif(trim(coalesce(p_candidate->>'sourceObjectId', '')), '') is null
      or p_candidate ? 'sourceMessageId'
      or p_candidate ? 'sourceThreadId'
    ) then
    raise exception 'candidate TMS source object identity is invalid'
      using errcode = '22023';
  end if;
  if p_candidate->>'schemaVersion' = 'tracking-candidate-claim-v1'
    and (
      jsonb_typeof(coalesce(p_candidate->'sourceObjectType', 'null'::jsonb)) <> 'string'
      or p_candidate->>'sourceObjectType' <> 'tracking_shipment_snapshot'
      or jsonb_typeof(coalesce(p_candidate->'sourceObjectId', 'null'::jsonb)) <> 'string'
      or p_candidate->>'sourceObjectId' !~ '^[0-9]{11}$'
      or p_candidate ? 'sourceMessageId'
      or p_candidate ? 'sourceThreadId'
    ) then
    raise exception 'candidate tracking source object identity is invalid'
      using errcode = '22023';
  end if;
  if p_candidate->>'schemaVersion' = 'operator-candidate-claim-v1'
    and (
      jsonb_typeof(coalesce(p_candidate->'sourceObjectType', 'null'::jsonb)) <> 'string'
      or p_candidate->>'sourceObjectType' <> 'operator_event'
      or jsonb_typeof(coalesce(p_candidate->'sourceObjectId', 'null'::jsonb)) <> 'string'
      or p_candidate->>'sourceObjectId' !~ '^operator-event:v1:[0-9a-f]{64}$'
      or p_candidate ? 'sourceMessageId'
      or p_candidate ? 'sourceThreadId'
    ) then
    raise exception 'candidate operator source object identity is invalid'
      using errcode = '22023';
  end if;
  if p_candidate ? 'sourceThreadId'
    and jsonb_typeof(p_candidate->'sourceThreadId') <> 'string' then
    raise exception 'candidate source thread identifier is invalid' using errcode = '22023';
  end if;
  if p_candidate ? 'sourceCapturedAt'
    and jsonb_typeof(p_candidate->'sourceCapturedAt') not in ('string', 'null') then
    raise exception 'candidate source capture time is invalid' using errcode = '22023';
  end if;
  if p_candidate ? 'occurredAt'
    and jsonb_typeof(p_candidate->'occurredAt') not in ('string', 'null') then
    raise exception 'candidate occurrence time is invalid' using errcode = '22023';
  end if;
  if nullif(coalesce(p_candidate->>'occurredAt', ''), '') is not null then
    v_occurred_at := (p_candidate->>'occurredAt')::timestamptz;
  end if;
  v_confidence := (p_candidate->>'confidence')::numeric;
  if v_confidence < 0 or v_confidence > 1
    or v_confidence is distinct from round(v_confidence, 6) then
    raise exception 'candidate confidence is outside the canonical range' using errcode = '22023';
  end if;
  v_confidence := trim_scale(v_confidence);

  if not (p_candidate->>'subjectType' = any (array['shipment', 'workgroup']))
    or not (p_candidate->>'polarity' = any (array['positive', 'negative', 'requested', 'neutral', 'unknown']))
    or not (p_candidate->>'extractionMethod' = any (array['deterministic', 'model'])) then
    raise exception 'candidate claim enum value is invalid' using errcode = '22023';
  end if;
  select * into v_predicate_policy
  from public.candidate_claim_predicate_registry policy
  where policy.predicate = p_candidate->>'predicate'
    and policy.extractor_version = p_candidate->>'extractorVersion';
  if not found
    or v_predicate_policy.gate is distinct from p_candidate->>'gate'
    or v_predicate_policy.candidate_schema_version is distinct from p_candidate->>'schemaVersion'
    or p_candidate->'normalizedValue'->>'status'
      is distinct from v_predicate_policy.statuses->>(p_candidate->>'polarity')
    or p_candidate->'normalizedValue'->>'effect'
      is distinct from v_predicate_policy.effects->>(p_candidate->>'polarity') then
    raise exception 'candidate predicate status/effect is outside the pinned registry policy'
      using errcode = '23514';
  end if;
  if p_candidate->>'schemaVersion' = 'gmail-candidate-claim-v1'
    and not private.truth_jsonb_has_only_keys(
      p_candidate->'normalizedValue',
      array['status', 'effect', 'temporal', 'lastFreeDay']
    ) then
    raise exception 'Gmail candidate normalized value contains unsupported fields'
      using errcode = '23514';
  end if;
  if p_candidate->>'schemaVersion' = 'tms-candidate-claim-v1' then
    if not private.truth_jsonb_has_only_keys(
      p_candidate->'normalizedValue',
      array[
        'status', 'effect', 'sourceClass', 'responsibleActor',
        'evidenceDirectness', 'tmsStatus', 'statusCode', 'tmsField',
        'tmsFieldValue', 'deliveryActualArrivalTime', 'temporal'
      ]
    )
      or p_candidate->'normalizedValue'->>'sourceClass' <> 'tms'
      or p_candidate->'normalizedValue'->>'responsibleActor' <> 'automated_system'
      or not (coalesce(
        p_candidate->'normalizedValue'->>'evidenceDirectness', ''
      ) = any (array['operational_summary', 'direct_system_event'])) then
      raise exception 'TMS candidate normalized source semantics are invalid'
        using errcode = '23514';
    end if;
    if p_candidate->'normalizedValue'->>'evidenceDirectness' = 'operational_summary'
      and (
        jsonb_typeof(coalesce(p_candidate->'normalizedValue'->'tmsStatus', 'null'::jsonb)) <> 'string'
        or nullif(trim(coalesce(p_candidate->'normalizedValue'->>'tmsStatus', '')), '') is null
        or jsonb_typeof(coalesce(p_candidate->'normalizedValue'->'statusCode', 'null'::jsonb)) not in ('number', 'null')
        or p_candidate->'normalizedValue' ? 'tmsField'
        or p_candidate->'normalizedValue' ? 'tmsFieldValue'
        or p_candidate->'normalizedValue' ? 'deliveryActualArrivalTime'
        or p_candidate->'normalizedValue' ? 'temporal'
      ) then
      raise exception 'TMS status candidate shape is invalid' using errcode = '23514';
    end if;
    if jsonb_typeof(coalesce(p_candidate->'normalizedValue'->'statusCode', 'null'::jsonb)) = 'number'
      and (
        coalesce(p_candidate->'normalizedValue'->>'statusCode', '') !~ '^[0-9]{3}$'
        or (p_candidate->'normalizedValue'->>'statusCode')::integer < 100
      ) then
      raise exception 'TMS status code is invalid' using errcode = '23514';
    end if;
    if p_candidate->'normalizedValue'->>'evidenceDirectness' = 'direct_system_event'
      and (
        jsonb_typeof(coalesce(p_candidate->'normalizedValue'->'tmsField', 'null'::jsonb)) <> 'string'
        or jsonb_typeof(coalesce(p_candidate->'normalizedValue'->'tmsFieldValue', 'null'::jsonb)) <> 'string'
        or nullif(trim(coalesce(p_candidate->'normalizedValue'->>'tmsFieldValue', '')), '') is null
        or p_candidate->'normalizedValue' ? 'tmsStatus'
        or p_candidate->'normalizedValue' ? 'statusCode'
        or not (
          (p_candidate->'normalizedValue'->>'tmsField' = 'customsActualRelease'
            and p_candidate->>'predicate' = 'customs_release')
          or (p_candidate->'normalizedValue'->>'tmsField' = 'deliveryActualArrivalDate'
            and p_candidate->>'predicate' = 'delivery_completed')
          or (p_candidate->'normalizedValue'->>'tmsField' = 'podSignature'
            and p_candidate->>'predicate' = 'pod_received')
        )
        or (
          p_candidate->'normalizedValue' ? 'deliveryActualArrivalTime'
          and (
            p_candidate->'normalizedValue'->>'tmsField' <> 'deliveryActualArrivalDate'
            or jsonb_typeof(
              p_candidate->'normalizedValue'->'deliveryActualArrivalTime'
            ) <> 'string'
          )
        )
      ) then
      raise exception 'TMS sensitive event candidate shape is invalid'
      using errcode = '23514';
    end if;
  end if;
  if p_candidate->>'schemaVersion' = 'tracking-candidate-claim-v1'
    and (
      not private.truth_jsonb_has_only_keys(
        p_candidate->'normalizedValue',
        array[
          'status', 'effect', 'sourceClass', 'responsibleActor',
          'evidenceDirectness', 'carrier', 'eventCode', 'eventDescription',
          'station', 'eventTimeLocal'
        ]
      )
      or (select count(*) from jsonb_each(p_candidate->'normalizedValue')) <> 10
      or p_candidate->'normalizedValue'->>'sourceClass' <> 'tracking'
      or p_candidate->'normalizedValue'->>'responsibleActor' <> 'carrier_tracking'
      or p_candidate->'normalizedValue'->>'evidenceDirectness' <> 'direct_provider_event'
      or exists (
        select 1
        from unnest(array[
          'carrier', 'eventCode', 'eventDescription', 'station', 'eventTimeLocal'
        ]) required_string
        where jsonb_typeof(
          coalesce(p_candidate->'normalizedValue'->required_string, 'null'::jsonb)
        ) <> 'string'
      )
    ) then
    raise exception 'tracking candidate normalized source semantics are invalid'
      using errcode = '23514';
  end if;
  if p_candidate->>'schemaVersion' = 'operator-candidate-claim-v1'
    and p_candidate->'normalizedValue' is null then
    raise exception 'operator candidate structured assertion value is missing'
      using errcode = '23514';
  end if;
  v_temporal := p_candidate->'normalizedValue'->'temporal';
  if v_temporal is not null and (
    jsonb_typeof(v_temporal) <> 'object'
    or not private.truth_jsonb_has_only_keys(v_temporal, array[
      'resolverVersion', 'status', 'occurredOn', 'basis', 'expression', 'confidence'
    ])
    or v_temporal->>'resolverVersion' <> 'truth-temporal-resolver-v1'
    or not (coalesce(v_temporal->>'status', '') = any (array[
      'exact', 'date_only', 'ambiguous', 'future_conflict'
    ]))
    or jsonb_typeof(coalesce(v_temporal->'occurredOn', 'null'::jsonb)) not in ('string', 'null')
    or (
      nullif(coalesce(v_temporal->>'occurredOn', ''), '') is not null
      and not private.truth_iso_date_valid(v_temporal->>'occurredOn')
    )
    or jsonb_typeof(coalesce(v_temporal->'basis', 'null'::jsonb)) <> 'string'
    or nullif(trim(coalesce(v_temporal->>'basis', '')), '') is null
    or jsonb_typeof(coalesce(v_temporal->'expression', 'null'::jsonb)) <> 'string'
    or nullif(trim(coalesce(v_temporal->>'expression', '')), '') is null
    or jsonb_typeof(coalesce(v_temporal->'confidence', 'null'::jsonb)) <> 'number'
    or (v_temporal->>'confidence')::numeric < 0
    or (v_temporal->>'confidence')::numeric > 1
    or (v_temporal->>'confidence')::numeric
      is distinct from round((v_temporal->>'confidence')::numeric, 6)
  ) then
    raise exception 'candidate temporal evidence envelope is invalid' using errcode = '23514';
  end if;
  if v_temporal is null and v_occurred_at is not null
    and p_candidate->>'schemaVersion' <> 'operator-candidate-claim-v1'
    and not (
      p_candidate->>'schemaVersion' = 'gmail-candidate-claim-v1'
      and p_candidate->>'extractorVersion' = any(array[
        'gmail-claim-extractor-v4-source-chronology+predicates:'
          || v_predicate_policy.registry_hash,
        'gmail-claim-extractor-v5-quote-boundary-source-chronology+predicates:'
          || v_predicate_policy.registry_hash,
        'gmail-claim-extractor-v6-server-semantic-quote-boundary-source-chronology+predicates:'
          || v_predicate_policy.registry_hash,
        'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:'
          || v_predicate_policy.registry_hash
      ])
      and p_candidate->>'extractionMethod' = 'deterministic'
    ) then
    raise exception 'candidate occurrence time lacks a temporal evidence envelope'
      using errcode = '23514';
  end if;
  if v_temporal is not null and (
    (v_temporal->>'status' = 'exact' and v_occurred_at is null)
    or (v_temporal->>'status' <> 'exact' and v_occurred_at is not null)
    or (
      v_temporal->>'status' in ('exact', 'date_only', 'future_conflict')
      and nullif(coalesce(v_temporal->>'occurredOn', ''), '') is null
    )
    or (
      v_temporal->>'status' = 'ambiguous'
      and nullif(coalesce(v_temporal->>'occurredOn', ''), '') is not null
    )
  ) then
    raise exception 'candidate occurrence time conflicts with temporal resolution status'
      using errcode = '23514';
  end if;
  if p_candidate->'normalizedValue' ? 'lastFreeDay' and (
    p_candidate->>'predicate' <> 'last_free_day'
    or jsonb_typeof(p_candidate->'normalizedValue'->'lastFreeDay') <> 'string'
    or not private.truth_iso_date_valid(
      p_candidate->'normalizedValue'->>'lastFreeDay'
    )
    or v_temporal is null
    or p_candidate->'normalizedValue'->>'lastFreeDay'
      is distinct from v_temporal->>'occurredOn'
  ) then
    raise exception 'candidate last-free-day value lacks matching temporal evidence'
      using errcode = '23514';
  end if;
  if p_candidate->>'claimKey' is distinct from (
    (p_candidate->>'subjectType') || ':' || (p_candidate->>'subjectKey') || ':' || (p_candidate->>'predicate')
  ) then
    raise exception 'candidate claim key is not canonical' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  into v_awbs
  from (
    select value
    from jsonb_array_elements_text(p_candidate->'appliesToAwbs') item(value)
  ) awb;
  if jsonb_array_length(v_awbs) = 0
    or jsonb_array_length(v_awbs) <> (
      select count(distinct value)::integer
      from jsonb_array_elements_text(p_candidate->'appliesToAwbs') item(value)
    )
    or exists (
      select 1
      from jsonb_array_elements_text(p_candidate->'appliesToAwbs') item(value)
      where value !~ '^[0-9]{11}$'
    )
    or v_awbs is distinct from p_candidate->'appliesToAwbs' then
    raise exception 'candidate AWB membership must be nonempty, unique, normalized, and sorted'
      using errcode = '23514';
  end if;
  if p_candidate->>'subjectType' = 'shipment'
    and (
      p_candidate->>'subjectKey' !~ '^[0-9]{11}$'
      or v_awbs is distinct from jsonb_build_array(p_candidate->>'subjectKey')
    ) then
    raise exception 'shipment candidate must apply only to its exact AWB' using errcode = '23514';
  end if;
  if p_candidate->>'subjectType' = 'workgroup'
    and (
      p_candidate->>'subjectKey' !~ '^workgroup:v1:[0-9a-f]{64}$'
      or not exists (
        select 1 from public.operational_workgroup_envelopes workgroup
        where workgroup.workgroup_id = p_candidate->>'subjectKey'
          and workgroup.workspace_key = p_workspace_key
      )
    ) then
    raise exception 'workgroup candidate lacks an authoritative workgroup envelope'
      using errcode = '23503';
  end if;

  v_ambiguity := p_candidate->'ambiguity';
  v_contradiction := p_candidate->'contradiction';
  v_recommendation := p_candidate->'acceptanceRecommendation';
  if jsonb_typeof(coalesce(v_ambiguity, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(v_ambiguity, array['status', 'reasons'])
    or not (coalesce(v_ambiguity->>'status', '') = any (array['none', 'review']))
    or jsonb_typeof(coalesce(v_ambiguity->'reasons', 'null'::jsonb)) <> 'array'
    or exists (
      select 1 from jsonb_array_elements(v_ambiguity->'reasons') reason
      where jsonb_typeof(reason) <> 'string' or nullif(trim(reason #>> '{}'), '') is null
  ) then
    raise exception 'candidate ambiguity envelope is invalid' using errcode = '23514';
  end if;
  if v_temporal is not null
    and v_temporal->>'status' in ('ambiguous', 'future_conflict')
    and (
      v_ambiguity->>'status' <> 'review'
      or not exists (
        select 1 from jsonb_array_elements_text(v_ambiguity->'reasons') reason(value)
        where reason.value = ('temporal:' || (v_temporal->>'status'))
      )
    ) then
    raise exception 'ambiguous or future-conflict temporal evidence must remain review-gated'
      using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(v_contradiction, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(
      v_contradiction,
      array['status', 'acceptedClaimVersionIds', 'reasons']
    )
    or not (coalesce(v_contradiction->>'status', '') = any (array['none', 'known']))
    or jsonb_typeof(coalesce(v_contradiction->'acceptedClaimVersionIds', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(v_contradiction->'reasons', 'null'::jsonb)) <> 'array'
    or exists (
      select 1 from jsonb_array_elements(v_contradiction->'reasons') reason
      where jsonb_typeof(reason) <> 'string' or nullif(trim(reason #>> '{}'), '') is null
    ) then
    raise exception 'candidate contradiction envelope is invalid' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_contradiction->'acceptedClaimVersionIds') item(value)
    left join public.accepted_claim_envelopes envelope
      on envelope.claim_version_id = item.value
    where envelope.claim_version_id is null
      or envelope.workspace_key is distinct from p_workspace_key
  ) then
    raise exception 'candidate contradiction references unavailable accepted evidence'
      using errcode = '23503';
  end if;
  if jsonb_typeof(coalesce(v_recommendation, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(
      v_recommendation,
      array['decision', 'method', 'policyVersion', 'reasons']
    )
    or not (coalesce(v_recommendation->>'decision', '') = any (array['accept', 'review', 'reject']))
    or not (coalesce(v_recommendation->>'method', '') = any (array['policy', 'operator']))
    or nullif(trim(coalesce(v_recommendation->>'policyVersion', '')), '') is null
    or jsonb_typeof(coalesce(v_recommendation->'reasons', 'null'::jsonb)) <> 'array'
    or exists (
      select 1 from jsonb_array_elements(v_recommendation->'reasons') reason
      where jsonb_typeof(reason) <> 'string' or nullif(trim(reason #>> '{}'), '') is null
    ) then
    raise exception 'candidate acceptance recommendation is invalid' using errcode = '23514';
  end if;
  if v_recommendation->>'policyVersion'
    is distinct from v_predicate_policy.acceptance_policy_version then
    raise exception 'candidate acceptance recommendation uses an unpinned policy version'
      using errcode = '23514';
  end if;
  if p_candidate->>'schemaVersion' = 'tms-candidate-claim-v1'
    and p_candidate->'normalizedValue'->>'evidenceDirectness' = 'direct_system_event'
    and (
      v_ambiguity->>'status' <> 'review'
      or v_recommendation->>'decision' <> 'review'
      or v_recommendation->>'method' <> 'operator'
    ) then
    raise exception 'TMS actual-release, delivery, and POD fields must remain review-gated'
      using errcode = '23514';
  end if;

  v_job := private.assert_candidate_claim_job_lease(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if v_job.workspace_key is distinct from p_workspace_key
    or v_job.observation_id::text is distinct from p_candidate->>'sourceObservationId' then
    raise exception 'candidate job lineage is outside the requested evidence' using errcode = '23514';
  end if;
  select * into v_observation
  from public.source_observations
  where observation_id = p_candidate->>'sourceObservationId'
    and workspace_key = p_workspace_key;
  if not found
    or v_observation.source_system is distinct from v_job.source_system
    or v_predicate_policy.source_system is distinct from v_job.source_system
    or v_observation.operation <> 'content'
    or v_observation.content_hash is distinct from p_candidate->>'sourceObservationContentHash' then
    raise exception 'candidate evidence is unavailable or does not match immutable source content'
      using errcode = '23503';
  end if;
  if v_job.job_kind = 'gmail_extract_message_claims' then
    if v_observation.source_object_type <> 'gmail_message_parsed'
      or v_observation.normalized_payload->>'schemaVersion' <> 'gmail-parsed-message-v2' then
      raise exception 'message-claim job requires a parsed Gmail message observation'
        using errcode = '23514';
    end if;
    v_source_message_id := v_observation.normalized_payload->'gmail'->>'messageId';
    v_source_thread_id := v_observation.normalized_payload->'gmail'->>'threadId';
    if nullif(trim(coalesce(v_source_thread_id, '')), '') is null then
      raise exception 'parsed Gmail message lacks its thread identity' using errcode = '23514';
    end if;
    v_source_review_required := false;
    v_source_extraction_method := 'gmail-rfc822-parser-v1';
  elsif v_job.job_kind = 'gmail_extract_attachment_claims' then
    if v_observation.source_object_type <> 'gmail_attachment_extracted'
      or v_observation.normalized_payload->>'schemaVersion' <> 'gmail-attachment-extracted-v1'
      or v_observation.normalized_payload->'extraction'->>'status' <> 'extracted'
      or jsonb_typeof(v_observation.normalized_payload->'extraction'->'reviewRequired') <> 'boolean'
      or nullif(trim(coalesce(v_observation.normalized_payload->'extraction'->>'method', '')), '') is null
      or v_observation.normalized_payload->>'attachmentId' is distinct from v_observation.source_object_id then
      raise exception 'attachment-claim job requires a complete extracted Gmail attachment observation'
        using errcode = '23514';
    end if;
    -- Attachment provenance is resolved from the attachment observation's own
    -- schema. It is not assumed to share message-parser payload placement.
    v_source_message_id := coalesce(
      v_observation.normalized_payload->'gmail'->>'messageId',
      v_observation.normalized_payload->>'messageId'
    );
    v_source_thread_id := coalesce(
      v_observation.normalized_payload->'gmail'->>'threadId',
      v_observation.normalized_payload->>'threadId',
      ''
    );
    v_source_review_required := (
      v_observation.normalized_payload->'extraction'->>'reviewRequired'
    )::boolean;
    v_source_extraction_method := v_observation.normalized_payload->'extraction'->>'method';
  elsif v_job.job_kind = 'tms_extract_claims' then
    if v_observation.source_system <> 'tms'
      or v_observation.source_object_type <> 'tms_shipment_snapshot'
      or v_observation.normalized_payload->>'schemaVersion'
        <> 'tms-shipment-source-observation-v1'
      or jsonb_typeof(v_observation.normalized_payload->'shipment') <> 'object'
      or lower(coalesce(
        v_observation.normalized_payload->'shipment'->>'shipmentGuid', ''
      )) is distinct from v_observation.source_object_id
      or p_candidate->>'sourceObjectType' is distinct from v_observation.source_object_type
      or lower(coalesce(p_candidate->>'sourceObjectId', ''))
        is distinct from v_observation.source_object_id
      or v_job.source_object_id is distinct from v_observation.source_object_id
      or v_job.payload->>'schemaVersion' <> 'tms-extract-claims-job-v1'
      or v_job.payload->>'sourceObservationId' is distinct from v_observation.observation_id
      or lower(coalesce(v_job.payload->>'shipmentGuid', ''))
        is distinct from v_observation.source_object_id
      or v_job.payload->>'sourceSnapshotTime'
        is distinct from v_observation.normalized_payload->>'snapshotTime'
      or v_job.payload->>'trackingNumber'
        is distinct from v_observation.normalized_payload->'shipment'->>'trackingNumber' then
      raise exception 'TMS claim job requires an exact immutable shipment snapshot'
        using errcode = '23514';
    end if;
    if coalesce(v_observation.normalized_payload->>'snapshotTime', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or v_observation.source_recorded_at is null then
      raise exception 'TMS source snapshot time is not canonical'
        using errcode = '23514';
    end if;
    begin
      if (v_observation.normalized_payload->>'snapshotTime')::timestamptz
          is distinct from v_observation.source_recorded_at
        or v_observation.source_recorded_at > v_observation.captured_at + interval '24 hours' then
        raise exception 'TMS source snapshot clock differs from source evidence chronology'
          using errcode = '23514';
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'TMS source snapshot time is invalid' using errcode = '23514';
    end;
    if p_candidate->'normalizedValue'->>'evidenceDirectness' = 'operational_summary'
      and not (
        (
          p_candidate->'evidenceSpan'->'path' = '["shipment","tmsStatus"]'::jsonb
          and p_candidate->'normalizedValue'->>'tmsStatus'
            is not distinct from v_observation.normalized_payload->'shipment'->>'tmsStatus'
        )
        or (
          p_candidate->'evidenceSpan'->'path' = '["shipment","status"]'::jsonb
          and p_candidate->'normalizedValue'->>'tmsStatus'
            is not distinct from v_observation.normalized_payload->'shipment'->>'status'
        )
      ) then
      raise exception 'TMS status candidate is not bound to its exact status field'
        using errcode = '23514';
    end if;
    if p_candidate->'normalizedValue'->>'evidenceDirectness' = 'direct_system_event'
      and (
        p_candidate->'evidenceSpan'->'path' is distinct from jsonb_build_array(
          'shipment', p_candidate->'normalizedValue'->>'tmsField'
        )
        or p_candidate->'normalizedValue'->>'tmsFieldValue' is distinct from (
          v_observation.normalized_payload->'shipment'->>(
            p_candidate->'normalizedValue'->>'tmsField'
          )
        )
        or (
          p_candidate->'normalizedValue' ? 'deliveryActualArrivalTime'
          and p_candidate->'normalizedValue'->>'deliveryActualArrivalTime'
            is distinct from v_observation.normalized_payload->'shipment'->>'deliveryActualArrivalTime'
        )
      ) then
      raise exception 'TMS sensitive candidate is not bound to its exact source field'
        using errcode = '23514';
    end if;
    v_source_message_id := '';
    v_source_thread_id := '';
    v_source_review_required := false;
    v_source_extraction_method := 'tms-shipment-source-observation-v1';
  elsif v_job.job_kind = 'tracking_extract_claims' then
    if v_observation.source_system <> 'tracking'
      or v_observation.source_object_type <> 'tracking_shipment_snapshot'
      or v_observation.normalized_payload->>'schemaVersion'
        <> 'tracking-source-observation-v1'
      or v_observation.normalized_payload->>'awb'
        is distinct from v_observation.source_object_id
      or p_candidate->>'sourceObjectType' is distinct from v_observation.source_object_type
      or p_candidate->>'sourceObjectId' is distinct from v_observation.source_object_id
      or v_job.source_object_id is distinct from v_observation.source_object_id
      or v_job.payload->>'schemaVersion' <> 'tracking-extract-claims-job-v1'
      or v_job.payload->>'sourceObservationId' is distinct from v_observation.observation_id
      or v_job.payload->>'awb' is distinct from v_observation.source_object_id
      or v_job.payload->>'sourceSnapshotTime'
        is distinct from v_observation.normalized_payload->>'snapshotTime'
      or v_job.payload->>'contentHash' is distinct from v_observation.content_hash
      or v_job.payload->>'healthStatus'
        is distinct from v_observation.normalized_payload->'sourceHealth'->>'status'
      or v_job.payload->>'extractorVersion'
        <> 'tracking-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942'
      or v_observation.content_hash is distinct from encode(extensions.digest(
        convert_to(
          private.truth_canonical_json_text(v_observation.normalized_payload),
          'UTF8'
        ),
        'sha256'
      ), 'hex')
      or not private.truth_tracking_policy_candidate_eligible(
        p_candidate, v_observation.normalized_payload
      ) then
      raise exception 'tracking claim job requires exact direct official-carrier evidence'
        using errcode = '23514';
    end if;
    if coalesce(v_observation.normalized_payload->>'snapshotTime', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or v_observation.source_recorded_at is null then
      raise exception 'tracking source snapshot time is not canonical'
        using errcode = '23514';
    end if;
    begin
      if (v_observation.normalized_payload->>'snapshotTime')::timestamptz
          is distinct from v_observation.source_recorded_at
        or v_observation.source_recorded_at > v_observation.captured_at + interval '24 hours' then
        raise exception 'tracking source snapshot clock differs from source evidence chronology'
          using errcode = '23514';
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'tracking source snapshot time is invalid' using errcode = '23514';
    end;
    v_source_message_id := '';
    v_source_thread_id := '';
    v_source_review_required := false;
    v_source_extraction_method := 'tracking-source-observation-v1';
  elsif v_job.job_kind = 'operator_extract_claims' then
    if v_observation.source_system <> 'operator'
      or v_observation.source_object_type <> 'operator_event'
      or v_observation.normalized_payload->>'schemaVersion'
        <> 'operator-event-source-observation-v1'
      or jsonb_typeof(v_observation.normalized_payload->'event') <> 'object'
      or v_observation.normalized_payload->'event'->>'schemaVersion'
        <> 'operator-recorded-event-v1'
      or v_observation.normalized_payload->'event'->>'eventId'
        is distinct from v_observation.source_object_id
      or v_observation.source_object_id is distinct from (
        'operator-event:v1:' || encode(extensions.digest(
          convert_to(private.truth_canonical_json_text(
            (v_observation.normalized_payload->'event') - 'eventId'::text
          ), 'UTF8'),
          'sha256'
        ), 'hex')
      )
      or p_candidate->>'sourceObjectType' is distinct from v_observation.source_object_type
      or p_candidate->>'sourceObjectId' is distinct from v_observation.source_object_id
      or v_job.source_object_id is distinct from v_observation.source_object_id
      or v_job.payload->>'schemaVersion' <> 'operator-extract-claims-job-v1'
      or v_job.payload->>'sourceObservationId' is distinct from v_observation.observation_id
      or v_job.payload->>'eventId' is distinct from v_observation.source_object_id
      or v_job.payload->>'eventSequence'
        is distinct from v_observation.normalized_payload->'event'->>'sequence'
      or v_job.payload->>'contentHash' is distinct from v_observation.content_hash
      or v_job.payload->>'extractorVersion'
        <> 'operator-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942'
      or v_observation.content_hash is distinct from encode(extensions.digest(
        convert_to(
          private.truth_canonical_json_text(v_observation.normalized_payload),
          'UTF8'
        ),
        'sha256'
      ), 'hex')
      or v_observation.normalized_payload->'event'->'assertion'->>'contractVersion'
        <> 'pikiio-shipment-predicates-2026-07-09-v1'
      or p_candidate->>'predicate'
        is distinct from v_observation.normalized_payload->'event'->'assertion'->>'predicate'
      or p_candidate->>'polarity'
        is distinct from v_observation.normalized_payload->'event'->'assertion'->>'polarity'
      or p_candidate->'normalizedValue'
        is distinct from v_observation.normalized_payload->'event'->'assertion'->'value'
      or p_candidate->'evidenceSpan'->'path'
        is distinct from '["event","assertion"]'::jsonb
      or p_candidate->>'subjectType'
        is distinct from v_observation.normalized_payload->'event'->'subject'->>'type'
      or p_candidate->>'occurredAt'
        is distinct from v_observation.normalized_payload->'event'->>'occurredAt' then
      raise exception 'operator claim job requires an exact immutable structured assertion event'
        using errcode = '23514';
    end if;
    if coalesce(v_observation.normalized_payload->'event'->>'sequence', '')
        !~ '^(0|[1-9][0-9]*)$'
      or jsonb_typeof(v_observation.normalized_payload->'event'->'subject') <> 'object'
      or jsonb_typeof(v_observation.normalized_payload->'event'->'subject'->'awbs') <> 'array'
      or not (v_observation.normalized_payload->'event'->'subject'->>'type'
        = any (array['shipment', 'workgroup']))
      or (
        v_observation.normalized_payload->'event'->'subject'->>'type' = 'workgroup'
        and coalesce(
          v_observation.normalized_payload->'event'->'subject'->>'membershipComplete',
          'false'
        ) <> 'true'
      )
      or nullif(trim(coalesce(
        v_observation.normalized_payload->'event'->'contact'->>'name', ''
      )), '') is null
      or nullif(trim(coalesce(
        v_observation.normalized_payload->'event'->'contact'->>'organization', ''
      )), '') is null
      or nullif(trim(coalesce(
        v_observation.normalized_payload->'event'->'recordedBy'->>'operatorId', ''
      )), '') is null
      or nullif(trim(coalesce(
        v_observation.normalized_payload->'event'->'recordedBy'->>'name', ''
      )), '') is null
      or coalesce(v_observation.normalized_payload->'event'->>'recordedSummary', '')
        !~ '^(I|We)([[:space:]]|$)'
      or trim(v_observation.normalized_payload->'event'->>'recordedSummary')
        is distinct from v_observation.normalized_payload->'event'->>'recordedSummary'
      or coalesce(v_observation.normalized_payload->'event'->>'occurredAt', '')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or coalesce(v_observation.normalized_payload->'event'->>'recordedAt', '')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or coalesce(v_observation.normalized_payload->>'capturedAt', '')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
      raise exception 'operator event provenance is incomplete for truth acceptance'
        using errcode = '23514';
    end if;
    begin
      if (v_observation.normalized_payload->'event'->>'occurredAt')::timestamptz
          > (v_observation.normalized_payload->'event'->>'recordedAt')::timestamptz
        or (v_observation.normalized_payload->'event'->>'recordedAt')::timestamptz
          > (v_observation.normalized_payload->>'capturedAt')::timestamptz
        or (v_observation.normalized_payload->>'capturedAt')::timestamptz
          is distinct from v_observation.captured_at then
        raise exception 'operator event clocks are out of append-only order'
          using errcode = '23514';
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'operator event clock is invalid' using errcode = '23514';
    end;
    select coalesce(jsonb_agg(normalized_awb order by normalized_awb), '[]'::jsonb)
    into v_source_awbs
    from (
      select regexp_replace(awb, '[^0-9]', '', 'g') as normalized_awb
      from jsonb_array_elements_text(
        v_observation.normalized_payload->'event'->'subject'->'awbs'
      ) source_awb(awb)
    ) normalized;
    if v_source_awbs is distinct from v_awbs
      or (
        p_candidate->>'subjectType' = 'shipment'
        and p_candidate->>'subjectKey' is distinct from v_awbs->>0
      )
      or (
        p_candidate->>'subjectType' = 'workgroup'
        and p_candidate->>'subjectKey' is distinct from
          v_observation.normalized_payload->'event'->'subject'->>'workgroupKey'
      ) then
      raise exception 'operator candidate subject scope differs from its recorded event'
        using errcode = '23514';
    end if;
    if v_observation.normalized_payload->'event'->>'eventType' = 'assertion' then
      if v_observation.normalized_payload->'event' ? 'relatedEvent' then
        raise exception 'first operator assertion cannot rewrite a prior event'
          using errcode = '23514';
      end if;
    elsif v_observation.normalized_payload->'event'->>'eventType'
      = any (array['correction', 'revocation']) then
      if v_observation.normalized_payload->'event'->'relatedEvent'->>'relation'
          is distinct from (case
            when v_observation.normalized_payload->'event'->>'eventType' = 'correction'
              then 'corrects'
            else 'revokes'
          end)
        or coalesce(v_observation.normalized_payload->'event'->'relatedEvent'->>'eventId', '')
          !~ '^operator-event:v1:[0-9a-f]{64}$'
        or coalesce(v_observation.normalized_payload->'event'->'relatedEvent'->>'sequence', '')
          !~ '^(0|[1-9][0-9]*)$'
        or coalesce(v_observation.normalized_payload->'event'->>'sequence', '')
          !~ '^(0|[1-9][0-9]*)$'
        or (v_observation.normalized_payload->'event'->'relatedEvent'->>'sequence')::numeric
          >= (v_observation.normalized_payload->'event'->>'sequence')::numeric
        or not exists (
          select 1
          from public.source_observations prior_observation
          where prior_observation.workspace_key = p_workspace_key
            and prior_observation.source_system = 'operator'
            and prior_observation.source_object_type = 'operator_event'
            and prior_observation.source_object_id =
              v_observation.normalized_payload->'event'->'relatedEvent'->>'eventId'
            and prior_observation.normalized_payload->'event'->>'sequence' =
              v_observation.normalized_payload->'event'->'relatedEvent'->>'sequence'
        ) then
        raise exception 'operator correction or revocation lacks its exact prior event chain'
          using errcode = '23514';
      end if;
      if v_observation.normalized_payload->'event'->>'eventType' = 'revocation'
        and p_candidate->>'polarity' <> 'unknown' then
        raise exception 'operator revocation must append explicit unknown truth'
          using errcode = '23514';
      end if;
    else
      raise exception 'operator event type is unsupported' using errcode = '23514';
    end if;
    v_source_message_id := '';
    v_source_thread_id := '';
    v_source_review_required := (
      v_observation.normalized_payload->'event'->>'eventType' <> 'assertion'
    );
    v_source_extraction_method := 'operator-event-source-observation-v1';
  else
    raise exception 'candidate-claim job kind is unsupported' using errcode = '0A000';
  end if;
  if v_job.source_system = 'gmail'
    and (
      nullif(trim(coalesce(v_source_message_id, '')), '') is null
      or v_source_message_id is distinct from p_candidate->>'sourceMessageId'
      or coalesce(v_source_thread_id, '') is distinct from p_candidate->>'sourceThreadId'
    ) then
      raise exception 'candidate Gmail message/thread provenance does not match its source observation'
        using errcode = '23514';
  end if;
  if nullif(coalesce(p_candidate->>'sourceCapturedAt', ''), '') is not null
    and (p_candidate->>'sourceCapturedAt')::timestamptz is distinct from v_observation.captured_at then
    raise exception 'candidate source capture time does not match the observation'
      using errcode = '23514';
  end if;
  if v_observation.source_system = 'gmail'
    and v_temporal is null
    and v_occurred_at is not null
    and (
      not (p_candidate->>'extractorVersion' = any(array[
        'gmail-claim-extractor-v4-source-chronology+predicates:'
          || v_predicate_policy.registry_hash,
        'gmail-claim-extractor-v5-quote-boundary-source-chronology+predicates:'
          || v_predicate_policy.registry_hash,
        'gmail-claim-extractor-v6-server-semantic-quote-boundary-source-chronology+predicates:'
          || v_predicate_policy.registry_hash,
        'gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:'
          || v_predicate_policy.registry_hash
      ]))
      or p_candidate->>'extractionMethod' <> 'deterministic'
      or v_observation.source_recorded_at is null
      or not private.is_canonical_utc_millis(p_candidate->>'occurredAt')
      or v_occurred_at is distinct from v_observation.source_recorded_at
    ) then
    raise exception 'Gmail internal-date occurrence is not bound to immutable source chronology'
      using errcode = '23514';
  end if;
  v_source_anchor := v_observation.captured_at;
  if v_observation.source_system = 'gmail'
    and nullif(trim(coalesce(v_observation.normalized_payload->>'date', '')), '') is not null then
    begin
      v_source_anchor := (v_observation.normalized_payload->>'date')::timestamptz;
    exception when others then
      raise exception 'candidate source message date is not a valid temporal anchor'
        using errcode = '23514';
    end;
  elsif v_observation.source_system = 'tms' then
    begin
      v_source_anchor := (v_observation.normalized_payload->>'snapshotTime')::timestamptz;
    exception when others then
      raise exception 'candidate TMS snapshot time is not a valid temporal anchor'
        using errcode = '23514';
    end;
  elsif v_observation.source_system = 'tracking' then
    begin
      v_source_anchor := (v_observation.normalized_payload->>'snapshotTime')::timestamptz;
    exception when others then
      raise exception 'candidate tracking snapshot time is not a valid temporal anchor'
        using errcode = '23514';
    end;
  elsif v_observation.source_system = 'operator' then
    begin
      v_source_anchor := (
        v_observation.normalized_payload->'event'->>'recordedAt'
      )::timestamptz;
    exception when others then
      raise exception 'candidate operator record time is not a valid temporal anchor'
        using errcode = '23514';
    end;
  end if;
  if v_temporal is not null
    and v_temporal->>'status' = 'date_only'
    and p_candidate->'normalizedValue'->>'effect' in ('complete', 'block')
    and (v_temporal->>'occurredOn')::date
      > (v_source_anchor at time zone 'UTC')::date
    and (
      v_ambiguity->>'status' <> 'review'
      or v_recommendation->>'decision' <> 'review'
      or v_recommendation->>'method' <> 'operator'
    ) then
    raise exception 'future-dated completion or blocker must remain review-gated'
      using errcode = '23514';
  end if;
  if v_occurred_at is not null
    and p_candidate->'normalizedValue'->>'effect' in ('complete', 'block')
    and v_occurred_at > v_source_anchor + interval '1 hour' then
    raise exception 'completed or blocking candidate occurrence is after its source evidence'
      using errcode = '23514';
  end if;
  if (
    v_observation.source_system = 'gmail'
    and not private.truth_utf16_span_matches(
      v_observation.normalized_text,
      p_candidate->'evidenceSpan'
    )
  ) or (
    v_observation.source_system = any (array['tms', 'tracking', 'operator'])
    and not private.truth_structured_field_matches(
      v_observation.normalized_payload,
      p_candidate->'evidenceSpan'
    )
  ) then
    raise exception 'candidate citation is not an exact immutable observation span'
      using errcode = '23514';
  end if;
  if v_temporal is not null and (
    (
      v_observation.source_system = 'gmail'
      and position(v_temporal->>'expression' in p_candidate->'evidenceSpan'->>'quote') = 0
    )
    or (
      v_observation.source_system = any (array['tms', 'tracking'])
      and position(v_temporal->>'expression' in p_candidate->'evidenceSpan'->>'valuePreview') = 0
    )
  ) then
    raise exception 'candidate temporal expression is outside its exact evidence citation'
      using errcode = '23514';
  end if;

  if v_previous_claim_version_id is null then
    if v_version_no <> 1 then
      raise exception 'candidate claim chain is missing its predecessor' using errcode = '23514';
    end if;
  else
    if not exists (
      select 1
      from public.accepted_claims claim
      join public.accepted_claim_envelopes envelope
        on envelope.claim_version_id = claim.claim_version_id
       and envelope.workspace_key = p_workspace_key
       and envelope.envelope_hash = claim.claim_content_hash
      where claim.claim_version_id = v_previous_claim_version_id
        and claim.claim_key = p_candidate->>'claimKey'
        and claim.version_no = v_version_no - 1
        and claim.subject_type = p_candidate->>'subjectType'
        and claim.subject_key = p_candidate->>'subjectKey'
        and claim.predicate = p_candidate->>'predicate'
        and claim.gate = p_candidate->>'gate'
    ) then
      raise exception 'candidate previous claim is not the exact accepted predecessor'
        using errcode = '23514';
    end if;
  end if;

  v_envelope := jsonb_build_object(
    'envelopeSchemaVersion', 'candidate-claim-envelope-v1',
    'workspaceKey', p_workspace_key,
    'candidate', jsonb_build_object(
      'schemaVersion', p_candidate->>'schemaVersion',
      'claimKey', p_candidate->>'claimKey',
      'versionNo', v_version_no,
      'previousClaimVersionId', coalesce(v_previous_claim_version_id, ''),
      'sourceObservationId', v_observation.observation_id,
      'sourceObservationContentHash', v_observation.content_hash,
      'sourceObjectType', v_observation.source_object_type,
      'sourceObjectId', v_observation.source_object_id,
      'sourceReviewRequired', v_source_review_required,
      'sourceExtractionMethod', v_source_extraction_method,
      'sourceMessageId', p_candidate->>'sourceMessageId',
      'sourceThreadId', p_candidate->>'sourceThreadId',
      'sourceCapturedAt', private.canonical_truth_timestamp(v_observation.captured_at),
      'subjectType', p_candidate->>'subjectType',
      'subjectKey', p_candidate->>'subjectKey',
      'appliesToAwbs', v_awbs,
      'predicate', p_candidate->>'predicate',
      'gate', p_candidate->>'gate',
      'polarity', p_candidate->>'polarity',
      'normalizedValue', p_candidate->'normalizedValue',
      'occurredAt', case
        when v_occurred_at is null then null
        else private.canonical_truth_timestamp(v_occurred_at)
      end,
      'confidence', v_confidence,
      'confidenceLabel', p_candidate->>'confidenceLabel',
      'evidenceSpan', p_candidate->'evidenceSpan',
      'extractionMethod', p_candidate->>'extractionMethod',
      'extractorVersion', p_candidate->>'extractorVersion',
      'model', coalesce(p_candidate->>'model', ''),
      'promptVersion', coalesce(p_candidate->>'promptVersion', ''),
      'ambiguity', v_ambiguity,
      'contradiction', v_contradiction,
      'acceptanceRecommendation', v_recommendation
    )
  );
  v_envelope_hash := encode(extensions.digest(
    convert_to(v_envelope::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_candidate_claim_version_id := 'candidate:v1:' || v_envelope_hash;

  if exists (
    select 1
    from public.candidate_claim_job_manifests manifest
    where manifest.job_id = p_job_id
      and not exists (
        select 1
        from jsonb_array_elements(manifest.canonical_manifest->'candidates') item
        where item->>'candidateClaimVersionId' = v_candidate_claim_version_id
          and item->>'itemHash' = v_envelope_hash
      )
  ) then
    raise exception 'sealed candidate manifest cannot gain another candidate'
      using errcode = '55000';
  end if;

  select * into v_existing
  from public.candidate_claim_envelopes
  where candidate_claim_version_id = v_candidate_claim_version_id;
  if found then
    v_idempotent := true;
    if v_existing.workspace_key is distinct from p_workspace_key
      or v_existing.extractor_candidate is distinct from p_candidate
      or v_existing.canonical_envelope is distinct from v_envelope then
      raise exception 'candidate claim envelope hash collision' using errcode = '23505';
    end if;
  else
    insert into public.candidate_claim_envelopes (
      candidate_claim_version_id, workspace_key, source_observation_id,
      source_observation_content_hash, source_object_type, source_object_id,
      source_review_required, source_extraction_method, claim_key, version_no,
      previous_claim_version_id, extraction_method, recommendation,
      recommendation_policy_version, ambiguity_status, contradiction_status,
      envelope_hash, envelope_schema_version, extractor_candidate, canonical_envelope
    ) values (
      v_candidate_claim_version_id, p_workspace_key, v_observation.observation_id,
      v_observation.content_hash, v_observation.source_object_type,
      v_observation.source_object_id, v_source_review_required,
      v_source_extraction_method, p_candidate->>'claimKey', v_version_no,
      v_previous_claim_version_id, p_candidate->>'extractionMethod',
      v_recommendation->>'decision', v_recommendation->>'policyVersion',
      v_ambiguity->>'status', v_contradiction->>'status',
      v_envelope_hash, 'candidate-claim-envelope-v1', p_candidate, v_envelope
    );
  end if;

  insert into public.candidate_claim_job_lineage (
    candidate_claim_version_id, job_id, source_observation_id
  ) values (
    v_candidate_claim_version_id, p_job_id, v_observation.observation_id
  ) on conflict do nothing;
  if not exists (
    select 1 from public.candidate_claim_job_lineage lineage
    where lineage.candidate_claim_version_id = v_candidate_claim_version_id
      and lineage.job_id = p_job_id
      and lineage.source_observation_id = v_observation.observation_id
  ) then
    raise exception 'candidate claim job lineage persistence is incomplete'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'candidateClaimVersionId', v_candidate_claim_version_id,
    'itemHash', v_envelope_hash,
    'workspaceKey', p_workspace_key,
    'sourceObservationId', v_observation.observation_id,
    'recommendation', v_recommendation->>'decision',
    'extractionMethod', p_candidate->>'extractionMethod'
  );
end;
$function$;

create or replace function private.seal_candidate_claim_job_manifest(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidates jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_candidate_count integer;
  v_distinct_count integer;
  v_lineage_count integer;
  v_candidates jsonb;
  v_manifest jsonb;
  v_manifest_hash text;
  v_existing public.candidate_claim_job_manifests%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if jsonb_typeof(coalesce(p_candidates, 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_candidates) > 50 then
    raise exception 'candidate job manifest must be an array of at most fifty candidates'
      using errcode = '22023';
  end if;
  v_job := private.assert_candidate_claim_job_lease(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if v_job.workspace_key is distinct from p_workspace_key then
    raise exception 'candidate job manifest is outside the workspace' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_candidates) item
    where jsonb_typeof(item) <> 'object'
      or not private.truth_jsonb_has_only_keys(
        item,
        array['candidateClaimVersionId', 'itemHash']
      )
      or coalesce(item->>'candidateClaimVersionId', '') !~ '^candidate:v1:[0-9a-f]{64}$'
      or coalesce(item->>'itemHash', '') !~ '^[0-9a-f]{64}$'
      or (item->>'candidateClaimVersionId') <> ('candidate:v1:' || (item->>'itemHash'))
  ) then
    raise exception 'candidate job manifest entry is invalid' using errcode = '23514';
  end if;
  select count(*)::integer,
         count(distinct (item->>'candidateClaimVersionId'))::integer
  into v_candidate_count, v_distinct_count
  from jsonb_array_elements(p_candidates) item;
  if v_candidate_count <> v_distinct_count then
    raise exception 'candidate job manifest identities must be unique' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_candidates) item
    left join public.candidate_claim_envelopes candidate
      on candidate.candidate_claim_version_id = item->>'candidateClaimVersionId'
     and candidate.envelope_hash = item->>'itemHash'
     and candidate.workspace_key = p_workspace_key
     and candidate.source_observation_id = v_job.observation_id
    left join public.candidate_claim_job_lineage lineage
      on lineage.candidate_claim_version_id = candidate.candidate_claim_version_id
     and lineage.job_id = p_job_id
     and lineage.source_observation_id = v_job.observation_id
    where candidate.candidate_claim_version_id is null
       or lineage.candidate_claim_version_id is null
  ) then
    raise exception 'candidate job manifest references unavailable job evidence'
      using errcode = '23503';
  end if;
  select count(*)::integer into v_lineage_count
  from public.candidate_claim_job_lineage lineage
  where lineage.job_id = p_job_id;
  if v_lineage_count <> v_candidate_count then
    raise exception 'candidate job manifest must seal every and only persisted job candidate'
      using errcode = '23514';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateClaimVersionId', candidate.candidate_claim_version_id,
    'itemHash', candidate.envelope_hash
  ) order by candidate.candidate_claim_version_id), '[]'::jsonb)
  into v_candidates
  from jsonb_array_elements(p_candidates) item
  join public.candidate_claim_envelopes candidate
    on candidate.candidate_claim_version_id = item->>'candidateClaimVersionId';
  v_manifest := jsonb_build_object(
    'manifestSchemaVersion', 'candidate-claim-job-manifest-v1',
    'workspaceKey', p_workspace_key,
    'jobId', p_job_id,
    'sourceObservationId', v_job.observation_id,
    'candidates', v_candidates
  );
  v_manifest_hash := encode(extensions.digest(
    convert_to(v_manifest::text, 'UTF8'),
    'sha256'
  ), 'hex');

  select * into v_existing
  from public.candidate_claim_job_manifests
  where job_id = p_job_id;
  if found then
    if v_existing.workspace_key is distinct from p_workspace_key
      or v_existing.canonical_manifest is distinct from v_manifest
      or v_existing.manifest_hash is distinct from v_manifest_hash then
      raise exception 'candidate job manifest conflicts with its sealed candidate set'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'jobId', p_job_id,
      'manifestHash', v_manifest_hash,
      'candidateCount', v_candidate_count,
      'candidates', v_candidates
    );
  end if;
  insert into public.candidate_claim_job_manifests (
    job_id, workspace_key, source_observation_id, candidate_count,
    manifest_hash, manifest_schema_version, canonical_manifest
  ) values (
    p_job_id, p_workspace_key, v_job.observation_id, v_candidate_count,
    v_manifest_hash, 'candidate-claim-job-manifest-v1', v_manifest
  );
  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'jobId', p_job_id,
    'manifestHash', v_manifest_hash,
    'candidateCount', v_candidate_count,
    'candidates', v_candidates
  );
end;
$function$;

create or replace function private.get_candidate_claim_job_state(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_candidates jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_job := private.assert_candidate_claim_job_lease(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if v_job.workspace_key is distinct from p_workspace_key then
    raise exception 'candidate job state is outside the workspace' using errcode = '23514';
  end if;
  select * into v_manifest
  from public.candidate_claim_job_manifests
  where job_id = p_job_id;
  if not found then
    return jsonb_build_object(
      'ok', true,
      'jobId', p_job_id,
      'sealed', false,
      'manifestHash', '',
      'candidateCount', 0,
      'candidates', '[]'::jsonb
    );
  end if;
  if v_manifest.workspace_key is distinct from p_workspace_key
    or v_manifest.source_observation_id is distinct from v_job.observation_id
    or v_manifest.manifest_hash is distinct from encode(extensions.digest(
      convert_to(v_manifest.canonical_manifest::text, 'UTF8'),
      'sha256'
    ), 'hex') then
    raise exception 'sealed candidate job manifest failed integrity validation'
      using errcode = '23514';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateClaimVersionId', candidate.candidate_claim_version_id,
    'itemHash', candidate.envelope_hash,
    'candidate', candidate.extractor_candidate
  ) order by candidate.candidate_claim_version_id), '[]'::jsonb)
  into v_candidates
  from jsonb_array_elements(v_manifest.canonical_manifest->'candidates') item
  join public.candidate_claim_envelopes candidate
    on candidate.candidate_claim_version_id = item->>'candidateClaimVersionId'
   and candidate.envelope_hash = item->>'itemHash';
  if jsonb_array_length(v_candidates) <> v_manifest.candidate_count then
    raise exception 'sealed candidate job state is incomplete' using errcode = '23514';
  end if;
  return jsonb_build_object(
    'ok', true,
    'jobId', p_job_id,
    'sealed', true,
    'manifestHash', v_manifest.manifest_hash,
    'candidateCount', v_manifest.candidate_count,
    'candidates', v_candidates
  );
end;
$function$;

create or replace function private.append_and_seal_candidate_claim_job(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidates jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate jsonb;
  v_receipt jsonb;
  v_receipts jsonb := '[]'::jsonb;
  v_manifest_candidates jsonb := '[]'::jsonb;
  v_manifest_receipt jsonb;
begin
  if jsonb_typeof(coalesce(p_candidates, 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_candidates) > 50 then
    raise exception 'candidate extraction batch must contain at most fifty candidates'
      using errcode = '22023';
  end if;
  -- Every append and the manifest seal share this transaction. A provider or
  -- process failure cannot leave an ambiguous partial candidate set.
  for v_candidate in
    select item.value
    from jsonb_array_elements(p_candidates) with ordinality item(value, ordinal)
    order by item.ordinal
  loop
    v_receipt := private.append_candidate_claim(
      p_workspace_key,
      p_job_id,
      p_worker_id,
      p_lease_fence,
      p_processor_version,
      v_candidate,
      p_sync_token
    );
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
      'candidateClaimVersionId', v_receipt->>'candidateClaimVersionId',
      'itemHash', v_receipt->>'itemHash'
    ));
    v_manifest_candidates := v_manifest_candidates || jsonb_build_array(jsonb_build_object(
      'candidateClaimVersionId', v_receipt->>'candidateClaimVersionId',
      'itemHash', v_receipt->>'itemHash'
    ));
  end loop;
  v_manifest_receipt := private.seal_candidate_claim_job_manifest(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    v_manifest_candidates,
    p_sync_token
  );
  return v_manifest_receipt || jsonb_build_object(
    'candidateReceipts', v_receipts
  );
end;
$function$;

create or replace function private.append_candidate_claim_decision(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_decision jsonb,
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
  v_source_observation public.source_observations%rowtype;
  v_decision_no integer;
  v_previous_decision_version_id text;
  v_previous public.candidate_claim_decisions%rowtype;
  v_reasons jsonb;
  v_accepted_claim_request jsonb;
  v_supersessions jsonb := '[]'::jsonb;
  v_canonical_decision jsonb;
  v_decision_hash text;
  v_decision_version_id text;
  v_existing public.candidate_claim_decisions%rowtype;
  v_idempotent boolean := false;
begin
  if jsonb_typeof(coalesce(p_decision, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(p_decision, array[
      'decisionNo', 'previousDecisionVersionId', 'decision', 'method',
      'policyVersion', 'decidedBy', 'reasons'
    ])
    or coalesce(p_decision->>'decisionNo', '') !~ '^[1-9][0-9]*$'
    or length(p_decision->>'decisionNo') > 10
    or (p_decision->>'decisionNo')::numeric > 2147483647
    or not (coalesce(p_decision->>'decision', '') = any (array['accept', 'review', 'reject']))
    or not (coalesce(p_decision->>'method', '') = any (array['policy', 'operator']))
    or nullif(trim(coalesce(p_decision->>'policyVersion', '')), '') is null
    or nullif(trim(coalesce(p_decision->>'decidedBy', '')), '') is null
    or jsonb_typeof(coalesce(p_decision->'reasons', 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_decision->'reasons') = 0
    or exists (
      select 1 from jsonb_array_elements(p_decision->'reasons') reason
      where jsonb_typeof(reason) <> 'string' or nullif(trim(reason #>> '{}'), '') is null
    ) then
    raise exception 'candidate claim decision is invalid' using errcode = '22023';
  end if;
  if p_decision ? 'previousDecisionVersionId'
    and jsonb_typeof(p_decision->'previousDecisionVersionId') not in ('string', 'null') then
    raise exception 'candidate previous decision identifier is invalid' using errcode = '22023';
  end if;
  v_decision_no := (p_decision->>'decisionNo')::integer;
  v_previous_decision_version_id := nullif(coalesce(p_decision->>'previousDecisionVersionId', ''), '');
  v_reasons := p_decision->'reasons';

  select * into v_candidate
  from public.candidate_claim_envelopes
  where candidate_claim_version_id = p_candidate_claim_version_id
    and workspace_key = p_workspace_key;
  if not found then
    raise exception 'candidate claim is unavailable' using errcode = '23503';
  end if;
  v_candidate_body := v_candidate.canonical_envelope->'candidate';
  select * into v_source_observation
  from public.source_observations
  where observation_id = v_candidate.source_observation_id
    and workspace_key = p_workspace_key;
  if not found then
    raise exception 'candidate source observation is unavailable' using errcode = '23503';
  end if;

  if p_decision->>'method' = 'policy' then
    if not private.valid_truth_sync_token(p_sync_token) then
      raise exception 'invalid sync token' using errcode = '28000';
    end if;
    v_job := private.assert_candidate_claim_job_lease(
      p_job_id, p_worker_id, p_lease_fence, p_processor_version
    );
    if v_job.workspace_key is distinct from p_workspace_key
      or not exists (
        select 1 from public.candidate_claim_job_lineage lineage
        where lineage.candidate_claim_version_id = p_candidate_claim_version_id
          and lineage.job_id = p_job_id
          and lineage.source_observation_id = v_job.observation_id
      ) then
      raise exception 'candidate policy decision is outside the fenced job lineage'
        using errcode = '23514';
    end if;
  elsif not private.valid_candidate_operator_token(p_sync_token) then
    raise exception 'invalid candidate operator token' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'candidate-decision:' || p_workspace_key || ':' || p_candidate_claim_version_id,
    0
  ));
  if v_decision_no = 1 then
    if v_previous_decision_version_id is not null then
      raise exception 'candidate decision version one cannot have a predecessor'
        using errcode = '23514';
    end if;
  else
    if v_previous_decision_version_id is null then
      raise exception 'candidate decision chain is incomplete' using errcode = '23514';
    end if;
    select * into v_previous
    from public.candidate_claim_decisions
    where decision_version_id = v_previous_decision_version_id;
    if not found
      or v_previous.candidate_claim_version_id is distinct from p_candidate_claim_version_id
      or v_previous.decision_no <> v_decision_no - 1 then
      raise exception 'candidate decision predecessor is not the exact chain version'
        using errcode = '23514';
    end if;
    if v_previous.decision in ('accept', 'reject') then
      raise exception 'candidate terminal decision cannot be superseded'
        using errcode = '55000';
    end if;
  end if;

  if p_decision->>'method' = 'policy' then
    if p_decision->>'decision' <> 'accept'
      or v_candidate.extraction_method <> 'deterministic'
      or v_candidate.recommendation <> 'accept'
      or v_candidate.recommendation_policy_version is distinct from p_decision->>'policyVersion'
      or v_candidate.ambiguity_status <> 'none'
      or v_candidate.contradiction_status <> 'none'
      or coalesce(
        v_candidate_body->'normalizedValue'->'temporal'->>'status',
        ''
      ) in ('ambiguous', 'future_conflict')
      or v_candidate.source_review_required
      or (
        v_candidate.source_object_type = 'gmail_attachment_extracted'
        and not (v_candidate.source_extraction_method = any (array[
          'pdf-text+quality-v1',
          'utf8-text-v1',
          'html-to-text-v1'
        ]))
      )
      or (
        v_candidate.source_object_type = 'tms_shipment_snapshot'
        and not private.truth_tms_policy_candidate_eligible(v_candidate_body)
      )
      or (
        v_candidate.source_object_type = 'tracking_shipment_snapshot'
        and not private.truth_tracking_policy_candidate_eligible(
          v_candidate_body, v_source_observation.normalized_payload
        )
      )
      or (
        v_candidate.source_object_type = 'operator_event'
        and not private.truth_operator_policy_candidate_eligible(
          v_candidate_body, v_source_observation.normalized_payload
        )
      )
      or not exists (
        select 1
        from public.candidate_claim_job_manifests manifest,
             jsonb_array_elements(manifest.canonical_manifest->'candidates') item
        where manifest.job_id = p_job_id
          and manifest.workspace_key = p_workspace_key
          and item->>'candidateClaimVersionId' = p_candidate_claim_version_id
          and item->>'itemHash' = v_candidate.envelope_hash
      )
      or jsonb_array_length(v_candidate_body->'ambiguity'->'reasons') <> 0
      or jsonb_array_length(v_candidate_body->'contradiction'->'acceptedClaimVersionIds') <> 0
      or jsonb_array_length(v_candidate_body->'contradiction'->'reasons') <> 0
      or v_candidate_body->'acceptanceRecommendation'->>'method' <> 'policy' then
      raise exception 'candidate is not eligible for deterministic policy acceptance'
        using errcode = '23514';
    end if;
  elsif p_decision->>'decision' = 'accept'
    and v_candidate.contradiction_status <> 'none'
    and not (
      v_candidate.source_object_type = 'operator_event'
      and v_source_observation.normalized_payload->'event'->>'eventType'
        = any (array['correction', 'revocation'])
    ) then
    raise exception 'operator acceptance of a contradiction requires an explicit supersession contract'
      using errcode = '0A000';
  end if;

  if p_decision->>'decision' = 'accept'
    and v_candidate.source_object_type = 'operator_event'
    and v_source_observation.normalized_payload->'event'->>'eventType'
      = any (array['correction', 'revocation']) then
    if v_decision_no < 2
      or v_previous.decision <> 'review'
      or nullif(v_candidate_body->>'previousClaimVersionId', '') is null
      or not exists (
        select 1
        from public.accepted_claims previous_claim
        join public.source_observations previous_observation
          on previous_observation.observation_id = previous_claim.primary_observation_id
         and previous_observation.workspace_key = p_workspace_key
         and previous_observation.source_system = 'operator'
         and previous_observation.source_object_type = 'operator_event'
        where previous_claim.claim_version_id =
            v_candidate_body->>'previousClaimVersionId'
          and previous_observation.source_object_id =
            v_source_observation.normalized_payload->'event'->'relatedEvent'->>'eventId'
      ) then
      raise exception 'operator correction or revocation requires reviewed exact accepted-claim lineage'
        using errcode = '23514';
    end if;
    v_supersessions := jsonb_build_array(jsonb_build_object(
      'supersededClaimVersionId', v_candidate_body->>'previousClaimVersionId',
      'relationship', case
        when v_source_observation.normalized_payload->'event'->>'eventType' = 'correction'
          then 'corrects'
        else 'resolves'
      end,
      'policyVersion', p_decision->>'policyVersion'
    ));
  end if;

  if p_decision->>'decision' = 'accept' then
    v_accepted_claim_request := jsonb_build_object(
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
        'acceptanceMethod', p_decision->>'method',
        'acceptancePolicyVersion', p_decision->>'policyVersion',
        'acceptedBy', p_decision->>'decidedBy',
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
  end if;

  v_canonical_decision := jsonb_build_object(
    'decisionSchemaVersion', 'candidate-claim-decision-v1',
    'workspaceKey', p_workspace_key,
    'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
    'candidateItemHash', v_candidate.envelope_hash,
    'decision', jsonb_build_object(
      'decisionNo', v_decision_no,
      'previousDecisionVersionId', coalesce(v_previous_decision_version_id, ''),
      'decision', p_decision->>'decision',
      'method', p_decision->>'method',
      'policyVersion', p_decision->>'policyVersion',
      'decidedBy', p_decision->>'decidedBy',
      'reasons', v_reasons,
      'acceptedClaimRequest', v_accepted_claim_request
    )
  );
  v_decision_hash := encode(extensions.digest(
    convert_to(v_canonical_decision::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_decision_version_id := 'candidate-decision:v1:' || v_decision_hash;

  select * into v_existing
  from public.candidate_claim_decisions
  where decision_version_id = v_decision_version_id;
  if found then
    v_idempotent := true;
    if v_existing.candidate_claim_version_id is distinct from p_candidate_claim_version_id
      or v_existing.canonical_decision is distinct from v_canonical_decision then
      raise exception 'candidate decision hash collision' using errcode = '23505';
    end if;
  else
    if exists (
      select 1 from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id = p_candidate_claim_version_id
        and decision_row.decision_no = v_decision_no
    ) then
      raise exception 'candidate logical decision version already differs'
        using errcode = '23505';
    end if;
    insert into public.candidate_claim_decisions (
      decision_version_id, candidate_claim_version_id, decision_no,
      previous_decision_version_id, decision, decision_method, policy_version,
      decided_by, reasons, accepted_claim_request, decision_hash,
      decision_schema_version, canonical_decision
    ) values (
      v_decision_version_id, p_candidate_claim_version_id, v_decision_no,
      v_previous_decision_version_id, p_decision->>'decision',
      p_decision->>'method', p_decision->>'policyVersion',
      p_decision->>'decidedBy', v_reasons, v_accepted_claim_request,
      v_decision_hash, 'candidate-claim-decision-v1', v_canonical_decision
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'candidateClaimVersionId', p_candidate_claim_version_id,
    'decisionVersionId', v_decision_version_id,
    'itemHash', v_decision_hash,
    'decision', p_decision->>'decision',
    'acceptedClaimRequest', v_accepted_claim_request
  );
end;
$function$;

create or replace function private.bind_candidate_claim_acceptance(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_decision_version_id text,
  p_accepted_claim_version_id text,
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
  v_decision public.candidate_claim_decisions%rowtype;
  v_request jsonb;
  v_claim public.accepted_claims%rowtype;
  v_claim_envelope public.accepted_claim_envelopes%rowtype;
  v_binding jsonb;
  v_binding_hash text;
  v_binding_id text;
  v_existing public.candidate_claim_acceptance_bindings%rowtype;
  v_idempotent boolean := false;
begin
  select * into v_candidate
  from public.candidate_claim_envelopes
  where candidate_claim_version_id = p_candidate_claim_version_id
    and workspace_key = p_workspace_key;
  select * into v_decision
  from public.candidate_claim_decisions
  where decision_version_id = p_decision_version_id
    and candidate_claim_version_id = p_candidate_claim_version_id
    and decision = 'accept';
  if v_candidate.candidate_claim_version_id is null
    or v_decision.decision_version_id is null
    or v_decision.accepted_claim_request is null then
    raise exception 'candidate policy acceptance authorization is unavailable'
      using errcode = '23503';
  end if;
  v_request := v_decision.accepted_claim_request;

  if v_decision.decision_method = 'policy' then
    if not private.valid_truth_sync_token(p_sync_token) then
      raise exception 'invalid sync token' using errcode = '28000';
    end if;
    v_job := private.assert_candidate_claim_job_lease(
      p_job_id, p_worker_id, p_lease_fence, p_processor_version
    );
    if v_job.workspace_key is distinct from p_workspace_key
      or not exists (
        select 1 from public.candidate_claim_job_lineage lineage
        where lineage.candidate_claim_version_id = p_candidate_claim_version_id
          and lineage.job_id = p_job_id
          and lineage.source_observation_id = v_job.observation_id
      ) then
      raise exception 'candidate policy acceptance binding is outside the fenced job lineage'
        using errcode = '23514';
    end if;
  elsif not private.valid_candidate_operator_token(p_sync_token) then
    raise exception 'invalid candidate operator token' using errcode = '28000';
  end if;

  select * into v_claim
  from public.accepted_claims
  where claim_version_id = p_accepted_claim_version_id;
  select * into v_claim_envelope
  from public.accepted_claim_envelopes
  where claim_version_id = p_accepted_claim_version_id
    and workspace_key = p_workspace_key;
  if v_claim.claim_version_id is null
    or v_claim_envelope.claim_version_id is null
    or v_claim.claim_content_hash is distinct from v_claim_envelope.envelope_hash
    or v_claim.claim_key is distinct from v_request->'claim'->>'claimKey'
    or v_claim.version_no is distinct from (v_request->'claim'->>'versionNo')::integer
    or coalesce(v_claim.previous_claim_version_id, '') is distinct from coalesce(v_request->'claim'->>'previousClaimVersionId', '')
    or v_claim.primary_observation_id is distinct from v_candidate.source_observation_id
    or v_claim.subject_type is distinct from v_request->'claim'->>'subjectType'
    or v_claim.subject_key is distinct from v_request->'claim'->>'subjectKey'
    or v_claim.predicate is distinct from v_request->'claim'->>'predicate'
    or v_claim.gate is distinct from v_request->'claim'->>'gate'
    or v_claim.polarity is distinct from v_request->'claim'->>'polarity'
    or v_claim.normalized_value is distinct from v_request->'claim'->'normalizedValue'
    or v_claim.confidence is distinct from (v_request->'claim'->>'confidence')::numeric
    or v_claim.confidence_label is distinct from v_request->'claim'->>'confidenceLabel'
    or v_claim.extraction_method is distinct from v_request->'claim'->>'extractionMethod'
    or v_claim.extractor_version is distinct from v_request->'claim'->>'extractorVersion'
    or v_claim.prompt_version is distinct from v_request->'claim'->>'promptVersion'
    or v_claim.model is distinct from v_request->'claim'->>'model'
    or v_claim.acceptance_method is distinct from v_decision.decision_method
    or v_claim.acceptance_policy_version is distinct from v_decision.policy_version
    or v_claim.accepted_by is distinct from v_decision.decided_by
    or v_claim.decision <> 'accepted'
    or v_claim.evidence_span is distinct from v_request->'claim'->'evidenceSpan'
    or v_claim.schema_version is distinct from v_request->'claim'->>'schemaVersion'
    or (
      select count(*) from public.accepted_claim_evidence evidence
      where evidence.claim_version_id = v_claim.claim_version_id
        and evidence.observation_id = v_candidate.source_observation_id
        and evidence.evidence_role = 'primary'
        and evidence.evidence_span = v_request->'claim'->'evidenceSpan'
    ) <> 1
    or (
      select count(*) from public.accepted_claim_evidence evidence
      where evidence.claim_version_id = v_claim.claim_version_id
    ) <> 1
    or (
      select count(*) from public.claim_supersessions supersession
      where supersession.resolving_claim_version_id = v_claim.claim_version_id
    ) <> jsonb_array_length(v_request->'supersessions')
    or exists (
      select 1
      from jsonb_array_elements(v_request->'supersessions') expected
      left join public.claim_supersessions actual
        on actual.resolving_claim_version_id = v_claim.claim_version_id
       and actual.superseded_claim_version_id = expected->>'supersededClaimVersionId'
       and actual.relationship = expected->>'relationship'
       and actual.policy_version = expected->>'policyVersion'
      where actual.resolving_claim_version_id is null
    ) then
    raise exception 'accepted claim does not exactly satisfy its candidate authorization'
      using errcode = '23514';
  end if;

  v_binding := jsonb_build_object(
    'bindingSchemaVersion', 'candidate-claim-acceptance-binding-v1',
    'workspaceKey', p_workspace_key,
    'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
    'candidateItemHash', v_candidate.envelope_hash,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'acceptedClaimVersionId', v_claim.claim_version_id,
    'acceptedClaimItemHash', v_claim_envelope.envelope_hash
  );
  v_binding_hash := encode(extensions.digest(
    convert_to(v_binding::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_binding_id := 'candidate-acceptance:v1:' || v_binding_hash;

  select * into v_existing
  from public.candidate_claim_acceptance_bindings
  where binding_id = v_binding_id;
  if found then
    v_idempotent := true;
    if v_existing.canonical_binding is distinct from v_binding then
      raise exception 'candidate acceptance binding hash collision' using errcode = '23505';
    end if;
  else
    if exists (
      select 1 from public.candidate_claim_acceptance_bindings binding
      where binding.candidate_claim_version_id = p_candidate_claim_version_id
         or binding.decision_version_id = p_decision_version_id
         or binding.accepted_claim_version_id = p_accepted_claim_version_id
    ) then
      raise exception 'candidate acceptance already has a different binding'
        using errcode = '23505';
    end if;
    insert into public.candidate_claim_acceptance_bindings (
      binding_id, candidate_claim_version_id, decision_version_id,
      accepted_claim_version_id, binding_hash, binding_schema_version,
      canonical_binding
    ) values (
      v_binding_id, p_candidate_claim_version_id, p_decision_version_id,
      p_accepted_claim_version_id, v_binding_hash,
      'candidate-claim-acceptance-binding-v1', v_binding
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'bindingId', v_binding_id,
    'itemHash', v_binding_hash,
    'candidateClaimVersionId', p_candidate_claim_version_id,
    'decisionVersionId', p_decision_version_id,
    'acceptedClaimVersionId', p_accepted_claim_version_id
  );
end;
$function$;

create or replace function public.append_candidate_claim(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_candidate_claim(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidate, p_sync_token
  );
$function$;

create or replace function public.seal_candidate_claim_job_manifest(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidates jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.seal_candidate_claim_job_manifest(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidates, p_sync_token
  );
$function$;

create or replace function public.append_and_seal_candidate_claim_job(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidates jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_and_seal_candidate_claim_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidates, p_sync_token
  );
$function$;

create or replace function public.get_candidate_claim_job_state(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.get_candidate_claim_job_state(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_sync_token
  );
$function$;

create or replace function public.append_candidate_claim_decision(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_decision jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_candidate_claim_decision(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidate_claim_version_id, p_decision, p_sync_token
  );
$function$;

create or replace function public.bind_candidate_claim_acceptance(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_candidate_claim_version_id text,
  p_decision_version_id text,
  p_accepted_claim_version_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.bind_candidate_claim_acceptance(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_candidate_claim_version_id,
    p_decision_version_id, p_accepted_claim_version_id, p_sync_token
  );
$function$;

-- Operator adjudication is deliberately independent of a completed worker
-- lease and requires a distinct backend token. It records immutable review,
-- rejection, or explicit acceptance decisions; contradictory acceptance is
-- withheld until a supersession contract exists.
create or replace function public.append_operator_candidate_claim_decision(
  p_workspace_key text,
  p_candidate_claim_version_id text,
  p_decision jsonb,
  p_operator_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_candidate_claim_decision(
    p_workspace_key,
    null::uuid,
    null::text,
    null::bigint,
    null::text,
    p_candidate_claim_version_id,
    p_decision,
    p_operator_token
  );
$function$;

create or replace function public.bind_operator_candidate_claim_acceptance(
  p_workspace_key text,
  p_candidate_claim_version_id text,
  p_decision_version_id text,
  p_accepted_claim_version_id text,
  p_operator_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.bind_candidate_claim_acceptance(
    p_workspace_key,
    null::uuid,
    null::text,
    null::bigint,
    null::text,
    p_candidate_claim_version_id,
    p_decision_version_id,
    p_accepted_claim_version_id,
    p_operator_token
  );
$function$;

revoke all on function private.append_candidate_claim(text, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.seal_candidate_claim_job_manifest(text, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.append_and_seal_candidate_claim_job(text, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.get_candidate_claim_job_state(text, uuid, text, bigint, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.append_candidate_claim_decision(text, uuid, text, bigint, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.bind_candidate_claim_acceptance(text, uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.append_candidate_claim(text, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.seal_candidate_claim_job_manifest(text, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.append_and_seal_candidate_claim_job(text, uuid, text, bigint, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.get_candidate_claim_job_state(text, uuid, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.append_candidate_claim_decision(text, uuid, text, bigint, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.bind_candidate_claim_acceptance(text, uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.append_operator_candidate_claim_decision(text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.bind_operator_candidate_claim_acceptance(text, text, text, text, text)
  from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function public.append_candidate_claim(text, uuid, text, bigint, text, jsonb, text)
  to service_role;
grant execute on function public.seal_candidate_claim_job_manifest(text, uuid, text, bigint, text, jsonb, text)
  to service_role;
grant execute on function public.append_and_seal_candidate_claim_job(text, uuid, text, bigint, text, jsonb, text)
  to service_role;
grant execute on function public.get_candidate_claim_job_state(text, uuid, text, bigint, text, text)
  to service_role;
grant execute on function public.append_candidate_claim_decision(text, uuid, text, bigint, text, text, jsonb, text)
  to service_role;
grant execute on function public.bind_candidate_claim_acceptance(text, uuid, text, bigint, text, text, text, text, text)
  to service_role;
grant execute on function public.append_operator_candidate_claim_decision(text, text, jsonb, text)
  to service_role;
grant execute on function public.bind_operator_candidate_claim_acceptance(text, text, text, text, text)
  to service_role;
