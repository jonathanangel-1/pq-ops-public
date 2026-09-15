-- Bind control-room shipment metadata to the exact current TMS observations
-- inside a sealed truth build. Metadata is a deterministic, immutable
-- projection of source_observations; callers cannot inject a mutable details
-- map into the canonical build runner.

create table if not exists public.truth_shipment_metadata_envelopes (
  metadata_version_id text primary key
    check (metadata_version_id ~ '^shipment-metadata:v1:[0-9a-f]{64}$'),
  workspace_key text not null,
  shipment_key text not null check (shipment_key ~ '^[0-9]{11}$'),
  source_observation_id text not null unique,
  source_observation_content_hash text not null
    check (source_observation_content_hash ~ '^[0-9a-f]{64}$'),
  snapshot_time timestamptz not null,
  envelope_hash text not null unique check (envelope_hash ~ '^[0-9a-f]{64}$'),
  canonical_envelope jsonb not null check (jsonb_typeof(canonical_envelope) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  check (metadata_version_id = 'shipment-metadata:v1:' || envelope_hash)
);

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and table_row.relname = 'truth_shipment_metadata_envelopes'
      and constraint_row.conname = 'truth_shipment_metadata_envelopes_workspace_fk'
  ) then
    alter table public.truth_shipment_metadata_envelopes
      add constraint truth_shipment_metadata_envelopes_workspace_fk
      foreign key (workspace_key)
      references public.truth_workspaces(workspace_key)
      on update restrict on delete restrict not deferrable;
  end if;
end
$block$;

-- Repair forward if an earlier local replay created the original unscoped
-- observation FK, then install the tenant-scoped structural reference. The
-- table predates this new child, so establish the matching composite parent
-- identity explicitly before adding the late-bound FK.
create unique index if not exists source_observations_workspace_observation_uidx
  on public.source_observations (workspace_key, observation_id);
alter table public.truth_shipment_metadata_envelopes
  drop constraint if exists truth_shipment_metadata_envelopes_source_observation_id_fkey;
do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and table_row.relname = 'truth_shipment_metadata_envelopes'
      and constraint_row.conname = 'truth_shipment_metadata_envelopes_observation_workspace_fk'
  ) then
    alter table public.truth_shipment_metadata_envelopes
      add constraint truth_shipment_metadata_envelopes_observation_workspace_fk
      foreign key (workspace_key, source_observation_id)
      references public.source_observations(workspace_key, observation_id)
      on update restrict on delete restrict not deferrable;
  end if;
end
$block$;

create index if not exists truth_shipment_metadata_workspace_shipment_idx
  on public.truth_shipment_metadata_envelopes (workspace_key, shipment_key, snapshot_time desc);

drop trigger if exists truth_shipment_metadata_envelopes_immutable
  on public.truth_shipment_metadata_envelopes;
create trigger truth_shipment_metadata_envelopes_immutable
before update or delete on public.truth_shipment_metadata_envelopes
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_shipment_metadata_envelopes enable row level security;
alter table public.truth_shipment_metadata_envelopes force row level security;
revoke all on public.truth_shipment_metadata_envelopes from public, anon, authenticated;
revoke insert, update, delete, truncate on public.truth_shipment_metadata_envelopes from service_role;
grant select on public.truth_shipment_metadata_envelopes to service_role;

alter table public.truth_build_inputs
  drop constraint if exists truth_build_inputs_item_kind_check;
alter table public.truth_build_inputs
  add constraint truth_build_inputs_item_kind_check
  check (item_kind = any (array[
    'accepted_claim', 'entity_link', 'workgroup_membership', 'shipment_metadata'
  ]));

alter table public.truth_build_pair_runs
  add column if not exists shipment_metadata_manifest_hash text
    default encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex');
alter table public.truth_build_pair_runs
  add column if not exists shipment_metadata_row_count integer default 0;
update public.truth_build_pair_runs
set shipment_metadata_manifest_hash = coalesce(
      shipment_metadata_manifest_hash,
      encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex')
    ),
    shipment_metadata_row_count = coalesce(shipment_metadata_row_count, 0)
where shipment_metadata_manifest_hash is null
   or shipment_metadata_row_count is null;
alter table public.truth_build_pair_runs
  alter column shipment_metadata_manifest_hash set not null;
alter table public.truth_build_pair_runs
  alter column shipment_metadata_row_count set not null;
alter table public.truth_build_pair_runs
  alter column shipment_metadata_manifest_hash drop default;
alter table public.truth_build_pair_runs
  alter column shipment_metadata_row_count drop default;
alter table public.truth_build_pair_runs
  drop constraint if exists truth_build_pair_runs_shipment_metadata_manifest_hash_check;
alter table public.truth_build_pair_runs
  add constraint truth_build_pair_runs_shipment_metadata_manifest_hash_check
  check (shipment_metadata_manifest_hash ~ '^[0-9a-f]{64}$');
alter table public.truth_build_pair_runs
  drop constraint if exists truth_build_pair_runs_shipment_metadata_row_count_check;
alter table public.truth_build_pair_runs
  add constraint truth_build_pair_runs_shipment_metadata_row_count_check
  check (shipment_metadata_row_count >= 0
    and bundle_row_count + shipment_metadata_row_count <= bundle_row_limit);

alter table public.truth_builds
  add column if not exists shipment_metadata_manifest_hash text
    default encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex');
update public.truth_builds
set shipment_metadata_manifest_hash = coalesce(
  shipment_metadata_manifest_hash,
  encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex')
)
where shipment_metadata_manifest_hash is null;
alter table public.truth_builds
  alter column shipment_metadata_manifest_hash set not null;
alter table public.truth_builds
  alter column shipment_metadata_manifest_hash drop default;
alter table public.truth_builds
  drop constraint if exists truth_builds_shipment_metadata_manifest_hash_check;
alter table public.truth_builds
  add constraint truth_builds_shipment_metadata_manifest_hash_check
  check (shipment_metadata_manifest_hash ~ '^[0-9a-f]{64}$');

create or replace function private.truth_tms_control_room_metadata_details(
  p_shipment jsonb
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  with fields as (
    select
      trim(coalesce(p_shipment->>'order', p_shipment->>'shipmentNumber', '')) as order_id,
      trim(coalesce(p_shipment->>'customerName', '')) as client,
      trim(coalesce(nullif(p_shipment->>'deliveryAirport', ''), p_shipment->>'dest', '')) as station,
      trim(coalesce(p_shipment->>'orig', '')) as origin,
      trim(coalesce(nullif(p_shipment->>'dest', ''), p_shipment->>'deliveryAirport', '')) as destination,
      trim(coalesce(p_shipment->>'dep', '')) as departure_leg,
      trim(coalesce(p_shipment->>'arr', '')) as arrival_leg,
      trim(coalesce(p_shipment->>'nextTask', '')) as recovery_hint
  ), normalized as (
    select *,
      case when origin <> '' and destination <> '' then origin || '-' || destination else '' end as route,
      trim(departure_leg || case when departure_leg <> '' and arrival_leg <> '' then ' ' else '' end || arrival_leg) as tms_flight,
      concat_ws(', ',
        nullif(trim(coalesce(p_shipment->>'deliveryAddress1', '')), ''),
        nullif(trim(coalesce(p_shipment->>'deliveryAddress2', '')), ''),
        nullif(trim(coalesce(p_shipment->>'deliveryAddress3', '')), ''),
        nullif(trim(coalesce(p_shipment->>'deliveryCity', '')), ''),
        nullif(trim(coalesce(p_shipment->>'deliveryState', '')), ''),
        nullif(trim(coalesce(p_shipment->>'deliveryCountry', '')), '')
      ) as full_delivery_address
    from fields
  )
  select jsonb_build_object(
    'schemaVersion', 'tms-control-room-details-v1',
    'orderId', order_id,
    'client', client,
    'station', station,
    'origin', origin,
    'destination', destination,
    'airline', '',
    'route', route,
    'cargo', jsonb_build_object(
      'pieces', trim(coalesce(p_shipment->>'pieces', '')),
      'weight', trim(coalesce(p_shipment->>'weight', '')),
      'weightUom', trim(coalesce(p_shipment->>'weightUom', '')),
      'contents', trim(coalesce(p_shipment->>'contents', '')),
      'declaredValue', trim(coalesce(p_shipment->>'value', '')),
      'source', 'sealed-tms-observation'
    ),
    'flightDetails', jsonb_build_object(
      'flights', case when departure_leg = '' then '[]'::jsonb else jsonb_build_array(
        jsonb_build_object(
          'flight', departure_leg,
          'sourceSegment', departure_leg,
          'sourceField', 'dep',
          'suffix', ''
        )
      ) end,
      'primaryFlight', departure_leg,
      'tmsFlight', tms_flight,
      'departureLeg', departure_leg,
      'arrivalLeg', arrival_leg,
      'route', route,
      'origin', origin,
      'destination', destination,
      'etaHint', recovery_hint,
      'recoveryHint', recovery_hint,
      'source', 'sealed-tms-observation'
    ),
    'delivery', jsonb_build_object(
      'consignee', trim(coalesce(p_shipment->>'consigneeCompany', '')),
      'contactEmail', trim(coalesce(p_shipment->>'consigneeEmail', '')),
      'contactPhone', trim(coalesce(p_shipment->>'consigneePhone', '')),
      'address1', trim(coalesce(p_shipment->>'deliveryAddress1', '')),
      'address2', trim(coalesce(p_shipment->>'deliveryAddress2', '')),
      'address3', trim(coalesce(p_shipment->>'deliveryAddress3', '')),
      'city', trim(coalesce(p_shipment->>'deliveryCity', '')),
      'state', trim(coalesce(p_shipment->>'deliveryState', '')),
      'country', trim(coalesce(p_shipment->>'deliveryCountry', '')),
      'countryName', trim(coalesce(p_shipment->>'deliveryCountryName', '')),
      'airport', trim(coalesce(p_shipment->>'deliveryAirport', '')),
      'courier', trim(coalesce(p_shipment->>'deliveryCourier', '')),
      'actualArrivalDate', trim(coalesce(p_shipment->>'deliveryActualArrivalDate', '')),
      'actualArrivalTime', trim(coalesce(p_shipment->>'deliveryActualArrivalTime', '')),
      'fullAddress', full_delivery_address,
      'source', 'sealed-tms-observation'
    ),
    'freightBroker', jsonb_build_object(
      'broker', trim(coalesce(p_shipment->>'deliveryCourier', '')),
      'rawTmsCourier', trim(coalesce(p_shipment->>'deliveryCourier', '')),
      'sourceField', 'deliveryCourier'
    ),
    'customsBroker', jsonb_build_object(
      'broker', trim(coalesce(p_shipment->>'customsBrokerName', '')),
      'portOfEntry', trim(coalesce(p_shipment->>'customsPortOfEntry', '')),
      'sourceField', 'customsBrokerName'
    ),
    'contacts', jsonb_build_object(
      'shipper', jsonb_build_object(
        'name', trim(coalesce(p_shipment->>'shipperName', '')),
        'email', trim(coalesce(p_shipment->>'shipperEmail', '')),
        'phone', trim(coalesce(p_shipment->>'shipperPhone', ''))
      ),
      'pickup', jsonb_build_object(
        'company', trim(coalesce(p_shipment->>'pickupCompany', '')),
        'email', trim(coalesce(p_shipment->>'pickupEmail', '')),
        'phone', trim(coalesce(p_shipment->>'pickupPhone', '')),
        'airport', trim(coalesce(p_shipment->>'pickupAirport', '')),
        'address1', trim(coalesce(p_shipment->>'pickupAddress1', '')),
        'address2', trim(coalesce(p_shipment->>'pickupAddress2', '')),
        'address3', trim(coalesce(p_shipment->>'pickupAddress3', '')),
        'city', trim(coalesce(p_shipment->>'pickupCity', '')),
        'state', trim(coalesce(p_shipment->>'pickupState', '')),
        'country', trim(coalesce(p_shipment->>'pickupCountry', ''))
      ),
      'consignee', jsonb_build_object(
        'company', trim(coalesce(p_shipment->>'consigneeCompany', '')),
        'email', trim(coalesce(p_shipment->>'consigneeEmail', '')),
        'phone', trim(coalesce(p_shipment->>'consigneePhone', ''))
      ),
      'internalOwner', jsonb_build_object(
        'code', trim(coalesce(p_shipment->>'owner', '')),
        'office', trim(coalesce(p_shipment->>'office', '')),
        'officeName', trim(coalesce(p_shipment->>'officeName', ''))
      )
    )
  )
  from normalized;
$function$;

create or replace function private.truth_tms_shipment_metadata_envelope(
  p_observation_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_observation public.source_observations%rowtype;
  v_shipment jsonb;
  v_snapshot_time timestamptz;
  v_awb text;
  v_status text;
  v_envelope jsonb;
  v_hash text;
begin
  select * into v_observation
  from public.source_observations observation
  where observation.observation_id = p_observation_id;
  if not found
    or v_observation.source_system <> 'tms'
    or v_observation.source_object_type <> 'tms_shipment_snapshot'
    or v_observation.operation <> 'content'
    or v_observation.source_fidelity <> 'normalized_source'
    or v_observation.schema_version <> 'tms-shipment-source-observation-v1'
    or v_observation.normalized_payload->>'schemaVersion'
      is distinct from 'tms-shipment-source-observation-v1'
    or jsonb_typeof(coalesce(v_observation.normalized_payload->'shipment', 'null'::jsonb)) <> 'object' then
    raise exception 'TMS shipment metadata observation is invalid' using errcode = '23514';
  end if;
  v_shipment := v_observation.normalized_payload->'shipment';
  v_awb := regexp_replace(coalesce(v_shipment->>'trackingNumber', ''), '[^0-9]', '', 'g');
  v_status := trim(coalesce(nullif(v_shipment->>'tmsStatus', ''), v_shipment->>'status', ''));
  if v_awb !~ '^[0-9]{11}$'
    or nullif(v_status, '') is null
    or lower(trim(coalesce(v_shipment->>'shipmentGuid', '')))
      is distinct from lower(v_observation.source_object_id)
    or nullif(trim(coalesce(v_observation.normalized_payload->>'snapshotTime', '')), '') is null then
    raise exception 'TMS shipment metadata identity is invalid' using errcode = '23514';
  end if;
  begin
    v_snapshot_time := (v_observation.normalized_payload->>'snapshotTime')::timestamptz;
  exception when others then
    raise exception 'TMS shipment metadata snapshot time is invalid' using errcode = '23514';
  end;
  if v_observation.source_recorded_at is null
    or v_observation.source_recorded_at is distinct from v_snapshot_time then
    raise exception 'TMS shipment metadata is not bound to source time' using errcode = '23514';
  end if;

  v_envelope := jsonb_build_object(
    'schemaVersion', 'tms-shipment-control-room-metadata-v1',
    'workspaceKey', v_observation.workspace_key,
    'sourceSystem', 'tms',
    'shipmentKey', v_awb,
    'sourceObservationId', v_observation.observation_id,
    'sourceObservationContentHash', v_observation.content_hash,
    'sourceRecordedAt', private.canonical_truth_timestamp(v_observation.source_recorded_at),
    'snapshotTime', private.canonical_truth_timestamp(v_snapshot_time),
    'details', private.truth_tms_control_room_metadata_details(v_shipment)
  );
  v_hash := encode(extensions.digest(
    convert_to(v_envelope::text, 'UTF8'), 'sha256'
  ), 'hex');
  return jsonb_build_object(
    'metadataVersionId', 'shipment-metadata:v1:' || v_hash,
    'envelopeHash', v_hash,
    'shipmentKey', v_awb,
    'sourceObservationId', v_observation.observation_id,
    'sourceObservationContentHash', v_observation.content_hash,
    'snapshotTime', private.canonical_truth_timestamp(v_snapshot_time),
    'canonicalEnvelope', v_envelope
  );
end;
$function$;

create or replace function private.derive_truth_build_shipment_metadata(
  p_workspace_key text,
  p_source_cut_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_envelopes jsonb;
  v_inputs jsonb;
  v_manifest_hash text;
  v_row_count integer;
begin
  if not exists (
    select 1 from public.source_cuts source_cut
    where source_cut.source_cut_id = p_source_cut_id
      and source_cut.workspace_key = p_workspace_key
      and source_cut.completeness = 'complete'
  ) then
    raise exception 'shipment metadata requires an exact complete source cut'
      using errcode = '23514';
  end if;

  with current_observations as (
    select observation.observation_id,
           private.truth_tms_shipment_metadata_envelope(observation.observation_id) as envelope
    from public.source_cut_cursors cursor_row
    join public.source_observations observation
      on observation.workspace_key = p_workspace_key
     and observation.source_system = cursor_row.source_system
     and observation.connection_key = cursor_row.connection_key
     and observation.source_cursor_version = cursor_row.through_cursor_version
     and observation.source_system = 'tms'
     and observation.source_object_type = 'tms_shipment_snapshot'
     and observation.operation = 'content'
     and observation.normalized_payload->>'snapshotTime' = cursor_row.through_cursor_value
    where cursor_row.source_cut_id = p_source_cut_id
      and private.source_observation_within_cut(
        p_workspace_key,
        p_source_cut_id,
        observation.observation_id,
        observation.content_hash
      )
  )
  select coalesce(jsonb_agg(envelope order by envelope->>'shipmentKey'), '[]'::jsonb)
  into v_envelopes
  from current_observations;

  if exists (
    select 1
    from jsonb_array_elements(v_envelopes) left_row
    join jsonb_array_elements(v_envelopes) right_row
      on left_row->>'shipmentKey' = right_row->>'shipmentKey'
     and left_row->>'sourceObservationId' < right_row->>'sourceObservationId'
  ) then
    raise exception 'current TMS cut contains duplicate normalized shipment metadata AWBs'
      using errcode = '23514';
  end if;

  -- Metadata cannot outrun claim extraction. Every exact current TMS row must
  -- already have one accepted presence claim bound to the same observation,
  -- and that claim is what materializes the shipment for reduction.
  if exists (
    select 1
    from jsonb_array_elements(v_envelopes) item
    where (
      select count(*)
      from public.accepted_claims claim
      join public.accepted_claim_envelopes envelope
        on envelope.claim_version_id = claim.claim_version_id
       and envelope.workspace_key = p_workspace_key
       and envelope.envelope_hash = claim.claim_content_hash
      where claim.primary_observation_id = item->>'sourceObservationId'
        and claim.subject_type = 'shipment'
        and claim.subject_key = item->>'shipmentKey'
        and claim.predicate = 'shipment_observed_in_tms'
        and claim.gate = 'context'
        and claim.polarity = 'neutral'
        and claim.decision = 'accepted'
    ) <> 1
  ) then
    raise exception 'current TMS metadata is missing its exact accepted inventory presence claim'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'metadataVersionId',
    'itemHash', item->>'envelopeHash'
  ) order by item->>'shipmentKey'), '[]'::jsonb)
  into v_inputs
  from jsonb_array_elements(v_envelopes) item;
  v_manifest_hash := encode(extensions.digest(
    convert_to(v_inputs::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_row_count := jsonb_array_length(v_envelopes);
  return jsonb_build_object(
    'schemaVersion', 'truth-build-shipment-metadata-manifest-v1',
    'shipmentMetadataInputs', v_inputs,
    'shipmentMetadataEnvelopes', v_envelopes,
    'shipmentMetadataManifestHash', v_manifest_hash,
    'shipmentMetadataRowCount', v_row_count
  );
end;
$function$;

-- Preserve the reviewed v2 claim/link/workgroup derivation and wrap it with
-- the server-derived TMS metadata manifest. This DO block is reapply-safe.
do $block$
begin
  if to_regprocedure(
    'private.derive_truth_build_candidate_manifest_core(text,text,jsonb)'
  ) is null then
    alter function private.derive_truth_build_candidate_manifest(text, text, jsonb)
      rename to derive_truth_build_candidate_manifest_core;
  end if;
end;
$block$;

create or replace function private.derive_truth_build_candidate_manifest(
  p_workspace_key text,
  p_source_cut_id text,
  p_versions jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_base jsonb;
  v_metadata jsonb;
  v_input_manifest jsonb;
  v_input_manifest_hash text;
begin
  v_base := private.derive_truth_build_candidate_manifest_core(
    p_workspace_key, p_source_cut_id, p_versions
  );
  v_metadata := private.derive_truth_build_shipment_metadata(
    p_workspace_key, p_source_cut_id
  );
  v_input_manifest := (v_base->'inputManifest') || jsonb_build_object(
    'schemaVersion', 'truth-build-input-manifest-v3',
    'shipmentMetadata', v_metadata->'shipmentMetadataInputs',
    'shipmentMetadataManifestHash', v_metadata->>'shipmentMetadataManifestHash'
  );
  v_input_manifest_hash := encode(extensions.digest(
    convert_to(v_input_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  return v_base || jsonb_build_object(
    'inputManifest', v_input_manifest,
    'inputManifestHash', v_input_manifest_hash,
    'shipmentMetadataInputs', v_metadata->'shipmentMetadataInputs',
    'shipmentMetadataManifestHash', v_metadata->>'shipmentMetadataManifestHash',
    'shipmentMetadataRowCount', (v_metadata->>'shipmentMetadataRowCount')::integer,
    'totalBundleRowCount', (v_base->>'bundleRowCount')::integer
      + (v_metadata->>'shipmentMetadataRowCount')::integer
  );
end;
$function$;

create or replace function private.authoritative_truth_input_hash(
  p_item_kind text,
  p_item_id text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_hash text;
begin
  case p_item_kind
    when 'accepted_claim' then
      select envelope.envelope_hash into v_hash
      from public.accepted_claim_envelopes envelope
      join public.accepted_claims claim
        on claim.claim_version_id = envelope.claim_version_id
       and claim.claim_content_hash = envelope.envelope_hash
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'), 'sha256'
       ), 'hex')
      where envelope.claim_version_id = p_item_id;
    when 'entity_link' then
      select envelope.envelope_hash into v_hash
      from public.observation_entity_link_envelopes envelope
      join public.observation_entity_links entity_link
        on entity_link.link_version_id = envelope.link_version_id
       and entity_link.content_hash = envelope.envelope_hash
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'), 'sha256'
       ), 'hex')
      where envelope.link_version_id = p_item_id;
    when 'workgroup_membership' then
      select envelope.envelope_hash into v_hash
      from public.operational_workgroup_membership_envelopes envelope
      join public.operational_workgroup_memberships membership
        on membership.membership_version_id = envelope.membership_version_id
       and membership.content_hash = envelope.envelope_hash
       and membership.workgroup_id = envelope.workgroup_id
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'), 'sha256'
       ), 'hex')
      join public.operational_workgroup_envelopes workgroup_envelope
        on workgroup_envelope.workgroup_id = envelope.workgroup_id
       and workgroup_envelope.workspace_key = envelope.workspace_key
       and workgroup_envelope.definition_hash = encode(extensions.digest(
         convert_to(workgroup_envelope.canonical_definition::text, 'UTF8'), 'sha256'
       ), 'hex')
      where envelope.membership_version_id = p_item_id;
    when 'shipment_metadata' then
      select envelope.envelope_hash into v_hash
      from public.truth_shipment_metadata_envelopes envelope
      join public.source_observations observation
        on observation.observation_id = envelope.source_observation_id
       and observation.workspace_key = envelope.workspace_key
       and observation.content_hash = envelope.source_observation_content_hash
       and observation.source_system = 'tms'
       and observation.source_object_type = 'tms_shipment_snapshot'
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'), 'sha256'
       ), 'hex')
      where envelope.metadata_version_id = p_item_id;
    else
      raise exception 'unsupported truth build input kind' using errcode = '22023';
  end case;
  if v_hash is null then
    raise exception 'authoritative truth build input is unavailable' using errcode = '23503';
  end if;
  return v_hash;
end;
$function$;

create or replace function private.prepare_truth_build_pair_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_metadata jsonb;
begin
  v_metadata := private.derive_truth_build_shipment_metadata(
    new.workspace_key, new.source_cut_id
  );
  new.shipment_metadata_manifest_hash := v_metadata->>'shipmentMetadataManifestHash';
  new.shipment_metadata_row_count := (v_metadata->>'shipmentMetadataRowCount')::integer;
  if new.bundle_row_count + new.shipment_metadata_row_count > new.bundle_row_limit then
    raise exception 'truth build bundle plus shipment metadata exceeds its declared row bound'
      using errcode = '54000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_build_pair_metadata_prepare
  on public.truth_build_pair_runs;
create trigger truth_build_pair_metadata_prepare
before insert on public.truth_build_pair_runs
for each row execute function private.prepare_truth_build_pair_metadata();

create or replace function private.prepare_truth_build_metadata_inputs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_metadata jsonb;
begin
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = new.build_pair_id;
  if not found
    or new.workspace_key is distinct from v_pair.workspace_key
    or new.source_cut_id is distinct from v_pair.source_cut_id
    or new.input_manifest_hash is distinct from v_pair.input_manifest_hash then
    raise exception 'truth build metadata input identity does not match its build pair'
      using errcode = '23514';
  end if;
  v_metadata := private.derive_truth_build_shipment_metadata(
    new.workspace_key, new.source_cut_id
  );
  if v_metadata->>'shipmentMetadataManifestHash'
      is distinct from v_pair.shipment_metadata_manifest_hash
    or (v_metadata->>'shipmentMetadataRowCount')::integer
      is distinct from v_pair.shipment_metadata_row_count then
    raise exception 'truth build metadata changed after pair claim'
      using errcode = '23514';
  end if;
  new.shipment_metadata_manifest_hash := v_pair.shipment_metadata_manifest_hash;

  insert into public.truth_shipment_metadata_envelopes (
    metadata_version_id, workspace_key, shipment_key,
    source_observation_id, source_observation_content_hash,
    snapshot_time, envelope_hash, canonical_envelope
  )
  select item->>'metadataVersionId', new.workspace_key,
         item->>'shipmentKey', item->>'sourceObservationId',
         item->>'sourceObservationContentHash',
         (item->>'snapshotTime')::timestamptz,
         item->>'envelopeHash', item->'canonicalEnvelope'
  from jsonb_array_elements(v_metadata->'shipmentMetadataEnvelopes') item
  on conflict (metadata_version_id) do nothing;

  if exists (
    select 1
    from jsonb_array_elements(v_metadata->'shipmentMetadataEnvelopes') item
    left join public.truth_shipment_metadata_envelopes stored
      on stored.metadata_version_id = item->>'metadataVersionId'
    where stored.metadata_version_id is null
      or stored.workspace_key is distinct from new.workspace_key
      or stored.shipment_key is distinct from item->>'shipmentKey'
      or stored.source_observation_id is distinct from item->>'sourceObservationId'
      or stored.source_observation_content_hash
        is distinct from item->>'sourceObservationContentHash'
      or stored.envelope_hash is distinct from item->>'envelopeHash'
      or stored.canonical_envelope is distinct from item->'canonicalEnvelope'
  ) then
    raise exception 'truth shipment metadata envelope identity conflict'
      using errcode = '23505';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_build_metadata_prepare on public.truth_builds;
create trigger truth_build_metadata_prepare
before insert on public.truth_builds
for each row execute function private.prepare_truth_build_metadata_inputs();

create or replace function private.append_truth_build_metadata_inputs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.truth_build_inputs (
    build_id, item_kind, item_id, item_hash, ordinal
  )
  select new.build_id, 'shipment_metadata',
         envelope.metadata_version_id, envelope.envelope_hash,
         row_number() over (order by envelope.shipment_key) - 1
  from public.truth_shipment_metadata_envelopes envelope
  where envelope.workspace_key = new.workspace_key
    and exists (
      select 1
      from public.source_cut_cursors cursor_row
      join public.source_observations observation
        on observation.observation_id = envelope.source_observation_id
       and observation.workspace_key = new.workspace_key
       and observation.source_system = 'tms'
       and observation.connection_key = cursor_row.connection_key
       and observation.source_cursor_version = cursor_row.through_cursor_version
       and observation.normalized_payload->>'snapshotTime' = cursor_row.through_cursor_value
      where cursor_row.source_cut_id = new.source_cut_id
        and cursor_row.source_system = 'tms'
    )
  order by envelope.shipment_key;
  if (select count(*) from public.truth_build_inputs input
      where input.build_id = new.build_id and input.item_kind = 'shipment_metadata')
      <> (select shipment_metadata_row_count from public.truth_build_pair_runs pair
          where pair.build_pair_id = new.build_pair_id) then
    raise exception 'truth build metadata input count is incomplete'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

drop trigger if exists truth_build_metadata_inputs_append on public.truth_builds;
create trigger truth_build_metadata_inputs_append
after insert on public.truth_builds
for each row execute function private.append_truth_build_metadata_inputs();

-- Preserve the already-reviewed bounded bundle reader and add the exact
-- metadata envelopes after its existing claim/link/evidence checks pass.
do $block$
begin
  if to_regprocedure(
    'private.truth_build_bundle_from_inputs_core(uuid)'
  ) is null then
    alter function private.truth_build_bundle_from_inputs(uuid)
      rename to truth_build_bundle_from_inputs_core;
  end if;
end;
$block$;

create or replace function private.truth_build_bundle_from_inputs(
  p_build_pair_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_bundle jsonb;
  v_metadata jsonb;
  v_metadata_inputs jsonb;
  v_metadata_hash text;
  v_total_count integer;
begin
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = p_build_pair_id;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  v_bundle := private.truth_build_bundle_from_inputs_core(p_build_pair_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'metadataVersionId', envelope.metadata_version_id,
    'envelopeHash', envelope.envelope_hash,
    'canonicalEnvelope', envelope.canonical_envelope
  ) order by envelope.shipment_key), '[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object(
    'itemId', envelope.metadata_version_id,
    'itemHash', envelope.envelope_hash
  ) order by envelope.shipment_key), '[]'::jsonb)
  into v_metadata, v_metadata_inputs
  from public.truth_build_inputs input
  join public.truth_shipment_metadata_envelopes envelope
    on input.item_kind = 'shipment_metadata'
   and envelope.metadata_version_id = input.item_id
   and envelope.envelope_hash = input.item_hash
  where input.build_id = v_pair.full_build_id;
  v_metadata_hash := encode(extensions.digest(
    convert_to(v_metadata_inputs::text, 'UTF8'), 'sha256'
  ), 'hex');
  if jsonb_array_length(v_metadata) <> v_pair.shipment_metadata_row_count
    or v_metadata_hash is distinct from v_pair.shipment_metadata_manifest_hash
    or exists (
      (
        select item_kind, item_id, item_hash
        from public.truth_build_inputs
        where build_id = v_pair.full_build_id and item_kind = 'shipment_metadata'
        except
        select item_kind, item_id, item_hash
        from public.truth_build_inputs
        where build_id = v_pair.incremental_build_id and item_kind = 'shipment_metadata'
      ) union all (
        select item_kind, item_id, item_hash
        from public.truth_build_inputs
        where build_id = v_pair.incremental_build_id and item_kind = 'shipment_metadata'
        except
        select item_kind, item_id, item_hash
        from public.truth_build_inputs
        where build_id = v_pair.full_build_id and item_kind = 'shipment_metadata'
      )
    ) then
    raise exception 'truth build shipment metadata manifest is corrupt or divergent'
      using errcode = '23514';
  end if;
  v_total_count := (v_bundle->'bounds'->>'rowCount')::integer
    + jsonb_array_length(v_metadata);
  if v_total_count > v_pair.bundle_row_limit then
    raise exception 'truth build bundle with metadata would truncate'
      using errcode = '54000';
  end if;
  return v_bundle || jsonb_build_object(
    'shipmentMetadataManifestHash', v_metadata_hash,
    'shipmentMetadataEnvelopes', v_metadata,
    'bounds', (v_bundle->'bounds') || jsonb_build_object(
      'shipmentMetadataRowCount', jsonb_array_length(v_metadata),
      'totalRowCount', v_total_count
    )
  );
end;
$function$;

create or replace function private.truth_build_pair_receipt(
  p_pair public.truth_build_pair_runs,
  p_idempotent boolean,
  p_busy boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'ok', not p_busy,
    'status', case when p_busy then 'busy' else p_pair.status end,
    'code', case when p_busy then 'TRUTH_BUILD_BUSY' else null end,
    'idempotent', p_idempotent,
    'buildPairId', p_pair.build_pair_id,
    'workspaceKey', p_pair.workspace_key,
    'sourceCutId', p_pair.source_cut_id,
    'buildChannel', p_pair.build_channel,
    'publicationChannel', p_pair.publication_channel,
    'basePublicationId', p_pair.base_publication_id,
    'fullBuildId', p_pair.full_build_id,
    'incrementalBuildId', p_pair.incremental_build_id,
    'inputManifestHash', p_pair.input_manifest_hash,
    'shipmentMetadataManifestHash', p_pair.shipment_metadata_manifest_hash,
    'bundleRowCount', p_pair.bundle_row_count,
    'shipmentMetadataRowCount', p_pair.shipment_metadata_row_count,
    'bundleRowLimit', p_pair.bundle_row_limit,
    'leaseOwner', p_pair.lease_owner,
    'leaseFence', p_pair.lease_fence,
    'leaseExpiresAt', p_pair.lease_expires_at,
    'attemptCount', p_pair.attempt_count,
    'packetHash', p_pair.packet_hash,
    'reducerOutputHash', p_pair.reducer_output_hash,
    'reducerPacketHash', p_pair.reducer_packet_hash,
    'semanticHash', p_pair.semantic_hash,
    'errorCode', nullif(p_pair.error_code, ''),
    'safeErrorDetail', nullif(p_pair.safe_error_detail, ''),
    'finishedAt', p_pair.finished_at
  ));
$function$;

create or replace function private.validate_truth_build_metadata_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status <> 'succeeded' or old.status = 'succeeded' then
    return new;
  end if;
  if new.packet_payload->'truthProvenance'->>'shipmentMetadataManifestHash'
      is distinct from new.shipment_metadata_manifest_hash
    or new.validation_report->'fullRunnerReport'->>'shipmentMetadataManifestHash'
      is distinct from new.shipment_metadata_manifest_hash
    or (new.validation_report->'fullRunnerReport'->>'shipmentMetadataCount')::integer
      is distinct from (
        select count(*)::integer from public.truth_build_inputs input
        where input.build_id = new.build_id and input.item_kind = 'shipment_metadata'
      ) then
    raise exception 'truth build delivery is missing its shipment metadata provenance'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.truth_build_inputs input
    join public.truth_shipment_metadata_envelopes envelope
      on input.item_kind = 'shipment_metadata'
     and envelope.metadata_version_id = input.item_id
     and envelope.envelope_hash = input.item_hash
    where input.build_id = new.build_id
      and not exists (
        select 1
        from jsonb_array_elements(new.packet_payload->'shipments') shipment
        where regexp_replace(coalesce(
                shipment->>'id', shipment->>'awb', ''
              ), '[^0-9]', '', 'g') = envelope.shipment_key
          and shipment->>'order' is not distinct from envelope.canonical_envelope->'details'->>'orderId'
          and shipment->>'shipmentNumber' is not distinct from envelope.canonical_envelope->'details'->>'orderId'
          and shipment->>'client' is not distinct from envelope.canonical_envelope->'details'->>'client'
          and shipment->>'station' is not distinct from envelope.canonical_envelope->'details'->>'station'
          and shipment->>'origin' is not distinct from envelope.canonical_envelope->'details'->>'origin'
          and shipment->>'destination' is not distinct from envelope.canonical_envelope->'details'->>'destination'
          and shipment->>'airline' is not distinct from envelope.canonical_envelope->'details'->>'airline'
          and shipment->>'route' is not distinct from envelope.canonical_envelope->'details'->>'route'
          and shipment->'cargo' is not distinct from envelope.canonical_envelope->'details'->'cargo'
          and shipment->'flightDetails' is not distinct from envelope.canonical_envelope->'details'->'flightDetails'
          and shipment->'delivery' is not distinct from envelope.canonical_envelope->'details'->'delivery'
          and shipment->'freightBroker' is not distinct from envelope.canonical_envelope->'details'->'freightBroker'
          and shipment->'customsBroker' is not distinct from envelope.canonical_envelope->'details'->'customsBroker'
          and shipment->'contacts' is not distinct from envelope.canonical_envelope->'details'->'contacts'
          and shipment->'sourceCoverage'->>'shipmentMetadataVersionId'
            is not distinct from envelope.metadata_version_id
          and shipment->'sourceCoverage'->>'shipmentMetadataObservationId'
            is not distinct from envelope.source_observation_id
      )
  ) then
    raise exception 'truth build delivery lost or changed cut-bound shipment metadata'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_build_metadata_delivery_validate on public.truth_builds;
create trigger truth_build_metadata_delivery_validate
before update of status, packet_payload, validation_report on public.truth_builds
for each row execute function private.validate_truth_build_metadata_delivery();

revoke all on function private.truth_tms_control_room_metadata_details(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_tms_shipment_metadata_envelope(text)
  from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_build_shipment_metadata(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_build_candidate_manifest_core(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_build_candidate_manifest(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.authoritative_truth_input_hash(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_build_pair_metadata()
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_build_metadata_inputs()
  from public, anon, authenticated, service_role;
revoke all on function private.append_truth_build_metadata_inputs()
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_bundle_from_inputs_core(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_bundle_from_inputs(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_pair_receipt(public.truth_build_pair_runs, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_truth_build_metadata_delivery()
  from public, anon, authenticated, service_role;
