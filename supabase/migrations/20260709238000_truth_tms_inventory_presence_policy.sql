-- TMS inventory completeness is entity existence, not lifecycle truth.
-- Preserve every earlier predicate/extractor policy row and add one narrowly
-- versioned TMS-only context predicate. The acceptance predicate below binds
-- the candidate subject to the exact normalized AWB in its immutable source
-- observation before automatic acceptance is possible.

insert into public.candidate_claim_predicate_registry (
  predicate, extractor_version, candidate_schema_version, source_system,
  gate, statuses, effects, registry_version, registry_hash,
  acceptance_policy_version
)
select
  prior.predicate,
  replace(
    prior.extractor_version,
    '73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
    '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
  ),
  prior.candidate_schema_version,
  prior.source_system,
  prior.gate,
  prior.statuses,
  prior.effects,
  'pikiio-shipment-predicates-2026-07-09-v2',
  '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e',
  replace(
    prior.acceptance_policy_version,
    'pikiio-shipment-predicates-2026-07-09-v1',
    'pikiio-shipment-predicates-2026-07-09-v2'
  )
from public.candidate_claim_predicate_registry prior
where prior.registry_hash =
    '73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942'
  and prior.registry_version = 'pikiio-shipment-predicates-2026-07-09-v1'
on conflict (predicate, extractor_version) do nothing;

insert into public.candidate_claim_predicate_registry (
  predicate, extractor_version, candidate_schema_version, source_system,
  gate, statuses, effects, registry_version, registry_hash,
  acceptance_policy_version
) values (
  'shipment_observed_in_tms',
  'tms-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e',
  'tms-candidate-claim-v1',
  'tms',
  'context',
  '{"positive":"observed","negative":"not_observed","requested":"observation_requested","neutral":"observed","unknown":"unknown"}'::jsonb,
  '{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}'::jsonb,
  'pikiio-shipment-predicates-2026-07-09-v2',
  '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e',
  'tms-candidate-acceptance-v1+pikiio-shipment-predicates-2026-07-09-v2'
)
on conflict (predicate, extractor_version) do nothing;

do $block$
declare
  v_counts jsonb;
begin
  select coalesce(jsonb_object_agg(source_system, row_count), '{}'::jsonb)
  into v_counts
  from (
    select source_system, count(*)::integer as row_count
    from public.candidate_claim_predicate_registry
    where registry_hash =
      '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
      and registry_version = 'pikiio-shipment-predicates-2026-07-09-v2'
      and extractor_version = any (array[
        'gmail-claim-extractor-v3+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e',
        'tms-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e',
        'tracking-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e',
        'operator-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
      ])
    group by source_system
  ) counts;
  if v_counts is distinct from
      '{"gmail":17,"operator":17,"tms":7,"tracking":2}'::jsonb
    or exists (
      select 1
      from public.candidate_claim_predicate_registry policy
      where policy.registry_hash =
        '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
        and policy.predicate = 'shipment_observed_in_tms'
        and (
          policy.source_system <> 'tms'
          or policy.gate <> 'context'
          or policy.statuses->>'neutral' <> 'observed'
          or policy.effects->>'neutral' <> 'context'
        )
    )
    or exists (
      select 1
      from public.candidate_claim_predicate_registry prior
      left join public.candidate_claim_predicate_registry next
        on next.source_system = prior.source_system
       and next.predicate = prior.predicate
       and next.extractor_version = replace(
         prior.extractor_version,
         '73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
         '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
       )
       and next.registry_hash =
         '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
      where prior.registry_hash =
        '73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942'
        and (
          next.predicate is null
          or next.gate is distinct from prior.gate
          or next.statuses is distinct from prior.statuses
          or next.effects is distinct from prior.effects
          or next.candidate_schema_version is distinct from prior.candidate_schema_version
        )
    ) then
    raise exception 'predicate registry v2 is incomplete, widened, or inconsistent with v1'
      using errcode = '23514';
  end if;
end;
$block$;

-- The candidate runtime independently pins tracking/operator extractor and
-- operator assertion identities inside its security-definer functions. Rotate
-- only those exact constants; abort if the expected v1 definitions are absent
-- so drift cannot silently weaken validation.
do $block$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(
    'private.append_candidate_claim(text,uuid,text,bigint,text,jsonb,text)'::regprocedure
  ) into v_definition;
  if position(
      'tracking-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
      in v_definition
    ) = 0
    or position(
      'operator-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
      in v_definition
    ) = 0 then
    if position(
        'tracking-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942'
        in v_definition
      ) = 0
      or position(
        'operator-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942'
        in v_definition
      ) = 0 then
      raise exception 'candidate runtime extractor pins are unavailable for exact v2 rotation'
        using errcode = '23514';
    end if;
    v_updated := replace(
      replace(
        replace(
          v_definition,
          'tracking-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
          'tracking-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
        ),
        'operator-claim-extractor-v1+predicates:73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942',
        'operator-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
      ),
      'pikiio-shipment-predicates-2026-07-09-v1',
      'pikiio-shipment-predicates-2026-07-09-v2'
    );
    execute v_updated;
  end if;

  select pg_get_functiondef(
    'private.truth_operator_policy_candidate_eligible(jsonb,jsonb)'::regprocedure
  ) into v_definition;
  if position('pikiio-shipment-predicates-2026-07-09-v2' in v_definition) = 0 then
    if position('pikiio-shipment-predicates-2026-07-09-v1' in v_definition) = 0 then
      raise exception 'operator candidate contract pin is unavailable for exact v2 rotation'
        using errcode = '23514';
    end if;
    execute replace(
      v_definition,
      'pikiio-shipment-predicates-2026-07-09-v1',
      'pikiio-shipment-predicates-2026-07-09-v2'
    );
  end if;

end;
$block$;

create or replace function private.truth_tms_policy_candidate_eligible(p_candidate jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_observation public.source_observations%rowtype;
  v_shipment jsonb;
  v_status_field text;
  v_tms_status text;
  v_awb text;
  v_status_code integer;
begin
  if p_candidate->>'predicate' = 'shipment_observed_in_tms' then
    select * into v_observation
    from public.source_observations observation
    where observation.observation_id = p_candidate->>'sourceObservationId';
    if not found
      or v_observation.source_system <> 'tms'
      or v_observation.source_object_type <> 'tms_shipment_snapshot'
      or v_observation.operation <> 'content'
      or v_observation.normalized_payload->>'schemaVersion'
        <> 'tms-shipment-source-observation-v1'
      or jsonb_typeof(v_observation.normalized_payload->'shipment') <> 'object' then
      return false;
    end if;
    v_shipment := v_observation.normalized_payload->'shipment';
    if nullif(trim(coalesce(v_shipment->>'tmsStatus', '')), '') is not null then
      v_status_field := 'tmsStatus';
    else
      v_status_field := 'status';
    end if;
    v_tms_status := trim(coalesce(v_shipment->>v_status_field, ''));
    v_awb := regexp_replace(coalesce(v_shipment->>'trackingNumber', ''), '[^0-9]', '', 'g');
    if v_tms_status ~ '^[0-9]{3}' then
      v_status_code := substring(v_tms_status from '^([0-9]{3})')::integer;
    else
      v_status_code := null;
    end if;
    return
      p_candidate->>'schemaVersion' = 'tms-candidate-claim-v1'
      and p_candidate->>'sourceObjectType' = 'tms_shipment_snapshot'
      and lower(coalesce(p_candidate->>'sourceObjectId', '')) = v_observation.source_object_id
      and lower(coalesce(v_shipment->>'shipmentGuid', '')) = v_observation.source_object_id
      and p_candidate->>'subjectType' = 'shipment'
      and p_candidate->>'subjectKey' = v_awb
      and v_awb ~ '^[0-9]{11}$'
      and p_candidate->'appliesToAwbs' = jsonb_build_array(v_awb)
      and p_candidate->>'gate' = 'context'
      and p_candidate->>'polarity' = 'neutral'
      and p_candidate->>'occurredAt' is null
      and p_candidate->>'confidence' = '1'
      and p_candidate->>'confidenceLabel' = 'high'
      and private.truth_jsonb_has_only_keys(
        p_candidate->'normalizedValue',
        array[
          'status', 'effect', 'sourceClass', 'responsibleActor',
          'evidenceDirectness', 'tmsStatus', 'statusCode'
        ]
      )
      and (select count(*) from jsonb_each(p_candidate->'normalizedValue')) = 7
      and p_candidate->'normalizedValue'->>'status' = 'observed'
      and p_candidate->'normalizedValue'->>'effect' = 'context'
      and p_candidate->'normalizedValue'->>'sourceClass' = 'tms'
      and p_candidate->'normalizedValue'->>'responsibleActor' = 'automated_system'
      and p_candidate->'normalizedValue'->>'evidenceDirectness' = 'operational_summary'
      and p_candidate->'normalizedValue'->>'tmsStatus' = v_tms_status
      and p_candidate->'normalizedValue'->'statusCode'
        is not distinct from coalesce(to_jsonb(v_status_code), 'null'::jsonb)
      and p_candidate->'evidenceSpan'->'path'
        = jsonb_build_array('shipment', v_status_field)
      and v_tms_status <> '';
  end if;

  return
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
end;
$function$;

revoke all on function private.truth_tms_policy_candidate_eligible(jsonb)
  from public, anon, authenticated, service_role;
