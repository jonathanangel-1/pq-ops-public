-- Authoritative operator phone-truth ingress.
--
-- Callers provide one bounded, registry-pinned assertion/correction/revocation
-- request and a high-entropy idempotency key. The database owns the operator
-- source cursor, event sequence, event/observation/job identities, and
-- recorded/captured clock. One transaction appends the source observation and
-- extraction job before advancing the cursor. No reducer, publication, action,
-- Gmail, TMS, or tracking state is invoked here.

create table if not exists public.operator_truth_event_requests (
  request_id text primary key
    check (request_id ~ '^operator-request:v1:[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null default 'operator'
    check (source_system = 'operator'),
  connection_key text not null,
  idempotency_key_hash text not null
    check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  canonical_request jsonb not null
    check (jsonb_typeof(canonical_request) = 'object'),
  event_id text not null unique
    check (event_id ~ '^operator-event:v1:[0-9a-f]{64}$'),
  event_sequence bigint not null check (event_sequence > 0),
  prior_observation_id text,
  observation_id text not null unique,
  job_id uuid not null unique,
  batch_id uuid not null unique,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  captured_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, connection_key, idempotency_key_hash),
  unique (workspace_key, connection_key, event_sequence),
  foreign key (observation_id, workspace_key, source_system, connection_key)
    references public.source_observations(
      observation_id, workspace_key, source_system, connection_key
    ) on update restrict on delete restrict,
  foreign key (prior_observation_id, workspace_key, source_system, connection_key)
    references public.source_observations(
      observation_id, workspace_key, source_system, connection_key
    ) on update restrict on delete restrict,
  foreign key (job_id, workspace_key, source_system, connection_key)
    references public.source_processing_jobs(
      job_id, workspace_key, source_system, connection_key
    ) on update restrict on delete restrict,
  foreign key (batch_id, workspace_key, source_system, connection_key)
    references public.source_ingest_batches(
      batch_id, workspace_key, source_system, connection_key
    ) on update restrict on delete restrict
);

create index if not exists operator_truth_event_requests_prior_idx
  on public.operator_truth_event_requests (
    workspace_key, connection_key, prior_observation_id, event_sequence
  ) where prior_observation_id is not null;

drop trigger if exists operator_truth_event_requests_immutable
  on public.operator_truth_event_requests;
create trigger operator_truth_event_requests_immutable
before update or delete on public.operator_truth_event_requests
for each row execute function public.reject_immutable_truth_mutation();

alter table public.operator_truth_event_requests enable row level security;
alter table public.operator_truth_event_requests force row level security;
revoke all on public.operator_truth_event_requests
  from public, anon, authenticated, service_role;
grant select on public.operator_truth_event_requests to service_role;
revoke insert, update, delete, truncate on public.operator_truth_event_requests
  from service_role;

create or replace function private.operator_truth_canonical_json_text(p_value jsonb)
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
        to_jsonb(entry.key)::text || ':' ||
          private.operator_truth_canonical_json_text(entry.value),
        ',' order by entry.key
      ), '') || '}'
      into v_result
      from jsonb_each(p_value) entry;
    when 'array' then
      select '[' || coalesce(string_agg(
        private.operator_truth_canonical_json_text(item.value),
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

create or replace function private.operator_truth_exact_keys(
  p_value jsonb,
  p_expected text[]
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select jsonb_typeof(p_value) = 'object'
    and not exists (
      (select key from jsonb_object_keys(p_value) key)
      except
      (select key from unnest(p_expected) key)
    )
    and not exists (
      (select key from unnest(p_expected) key)
      except
      (select key from jsonb_object_keys(p_value) key)
    );
$function$;

-- This is the status/effect subset of
-- config/truth-predicate-registry-v1.json, pinned to the same registry version
-- and hash used by the operator extractor. An unknown predicate or stale
-- polarity has no contract and therefore cannot enter the source journal.
create or replace function private.operator_truth_predicate_contract(
  p_predicate text,
  p_polarity text
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  with registry(value) as (values ($json$
  {
    "arrival_confirmed":{"statuses":{"positive":"arrived","negative":"not_arrived","requested":"requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "transport_in_transit":{"statuses":{"positive":"in_transit","negative":"not_in_transit","requested":"status_requested","neutral":"scheduled","unknown":"unknown"},"effects":{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}},
    "cargo_not_found":{"statuses":{"positive":"not_found","negative":"located","requested":"location_requested","neutral":"investigating","unknown":"unknown"},"effects":{"positive":"block","negative":"context","requested":"request","neutral":"context","unknown":"context"}},
    "customs_release":{"statuses":{"positive":"released","negative":"not_released","requested":"requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "customs_hold":{"statuses":{"positive":"active","negative":"removed","requested":"status_requested","neutral":"expected","unknown":"unknown"},"effects":{"positive":"block","negative":"context","requested":"request","neutral":"context","unknown":"context"}},
    "delivery_order_received":{"statuses":{"positive":"received","negative":"missing","requested":"requested","neutral":"expected","unknown":"unknown"},"effects":{"positive":"context","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "station_fees_due":{"statuses":{"positive":"due","negative":"none_due","requested":"amount_requested","neutral":"estimated","unknown":"unknown"},"effects":{"positive":"block","negative":"context","requested":"request","neutral":"context","unknown":"context"}},
    "station_fees_paid":{"statuses":{"positive":"paid","negative":"unpaid","requested":"payment_requested","neutral":"payment_planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "dispatch_confirmed":{"statuses":{"positive":"confirmed","negative":"not_confirmed","requested":"requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "pickup_scheduled":{"statuses":{"positive":"scheduled","negative":"cancelled","requested":"schedule_requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"context","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "pickup_completed":{"statuses":{"positive":"picked_up","negative":"not_picked_up","requested":"requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "out_for_delivery":{"statuses":{"positive":"out_for_delivery","negative":"not_out_for_delivery","requested":"status_requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}},
    "delivery_scheduled":{"statuses":{"positive":"scheduled","negative":"cancelled","requested":"schedule_requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"context","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "delivery_completed":{"statuses":{"positive":"delivered","negative":"not_delivered","requested":"requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "pod_received":{"statuses":{"positive":"received","negative":"missing","requested":"requested","neutral":"planned","unknown":"unknown"},"effects":{"positive":"complete","negative":"block","requested":"request","neutral":"context","unknown":"context"}},
    "last_free_day":{"statuses":{"positive":"stated","negative":"unknown","requested":"requested","neutral":"estimated","unknown":"unknown"},"effects":{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}},
    "quote_received":{"statuses":{"positive":"received","negative":"missing","requested":"requested","neutral":"expected","unknown":"unknown"},"effects":{"positive":"context","negative":"context","requested":"request","neutral":"context","unknown":"context"}}
  }
  $json$::jsonb))
  select case
    when value->p_predicate->'statuses'->>p_polarity is null
      or value->p_predicate->'effects'->>p_polarity is null
      then null::jsonb
    else jsonb_build_object(
      'status', value->p_predicate->'statuses'->>p_polarity,
      'effect', value->p_predicate->'effects'->>p_polarity
    )
  end
  from registry;
$function$;

-- The older generic source-snapshot RPC necessarily accepts caller-built
-- operator IDs and sequences. Once this migration lands, operator rows and
-- cursor mutations are legal only inside the authority transaction below.
-- A transaction-local guard cannot leak through a pooled connection. The two
-- explicit genesis exceptions keep the earlier source-cut migration reentrant
-- without reopening caller-controlled sequence advancement.
create or replace function private.guard_operator_event_authority_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_authorized boolean := coalesce(
    current_setting('pikiio.operator_event_authority', true), ''
  ) = 'truth-operator-event-authority-v1';
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
begin
  if tg_table_name = 'source_cursors' and tg_op = 'INSERT'
    and v_new->>'source_system' = 'operator'
    and v_new->>'workspace_key' = 'primary'
    and v_new->>'connection_key' = 'operator-phone-primary'
    and v_new->>'cursor_kind' = 'operator_sequence'
    and v_new->>'cursor_value' = '0'
    and v_new->>'cursor_version' = '0'
    and v_new->>'status' = 'live' then
    return new;
  end if;
  if tg_table_name = 'source_cursors' and tg_op = 'UPDATE'
    and v_new->>'source_system' = 'operator'
    and v_old->>'workspace_key' = 'primary'
    and v_old->>'connection_key' = 'operator-phone-primary'
    and v_old->>'cursor_version' = '0' and v_old->>'cursor_value' = '0'
    and v_new->>'workspace_key' is not distinct from v_old->>'workspace_key'
    and v_new->>'source_system' is not distinct from v_old->>'source_system'
    and v_new->>'connection_key' is not distinct from v_old->>'connection_key'
    and v_new->>'cursor_kind' is not distinct from v_old->>'cursor_kind'
    and v_new->>'cursor_version' is not distinct from v_old->>'cursor_version'
    and v_new->>'cursor_value' is not distinct from v_old->>'cursor_value'
    and v_new->>'status' is not distinct from v_old->>'status'
    and v_new->>'lease_owner' is not distinct from v_old->>'lease_owner'
    and v_new->>'lease_fence' is not distinct from v_old->>'lease_fence'
    and v_new->>'lease_expires_at' is not distinct from v_old->>'lease_expires_at'
    and v_new->>'last_batch_id' = '00000000-0000-4000-8000-000000000340'
    and (v_new->>'last_committed_at')::timestamptz
      = '1970-01-01T00:00:00.000Z'::timestamptz then
    return new;
  end if;
  if tg_table_name = 'source_ingest_batches' and tg_op = 'INSERT'
    and v_new->>'source_system' = 'operator'
    and v_new->>'batch_id' = '00000000-0000-4000-8000-000000000340'
    and v_new->>'workspace_key' = 'primary'
    and v_new->>'connection_key' = 'operator-phone-primary'
    and v_new->>'trigger_name' = 'operator-genesis-v1'
    and v_new->>'status' = 'committed'
    and v_new->>'expected_cursor_version' = '0'
    and v_new->>'expected_cursor_value' = '0'
    and v_new->>'committed_cursor_version' = '0'
    and v_new->>'committed_cursor_value' = '0' then
    return new;
  end if;
  if tg_table_name = 'source_ingest_manifests' and tg_op = 'INSERT'
    and v_new->>'source_system' = 'operator'
    and v_new->>'batch_id' = '00000000-0000-4000-8000-000000000340'
    and v_new->>'workspace_key' = 'primary'
    and v_new->>'connection_key' = 'operator-phone-primary'
    and v_new->>'next_cursor_value' = '0' then
    return new;
  end if;
  if coalesce(v_new->>'source_system', '') <> 'operator' or v_authorized then
    return new;
  end if;
  raise exception 'operator source writes require the authoritative event RPC'
    using errcode = '42501';
end;
$function$;

drop trigger if exists operator_event_authority_cursor_guard
  on public.source_cursors;
create trigger operator_event_authority_cursor_guard
before insert or update on public.source_cursors
for each row execute function private.guard_operator_event_authority_write();

drop trigger if exists operator_event_authority_batch_guard
  on public.source_ingest_batches;
create trigger operator_event_authority_batch_guard
before insert on public.source_ingest_batches
for each row execute function private.guard_operator_event_authority_write();

drop trigger if exists operator_event_authority_observation_guard
  on public.source_observations;
create trigger operator_event_authority_observation_guard
before insert on public.source_observations
for each row execute function private.guard_operator_event_authority_write();

drop trigger if exists operator_event_authority_job_guard
  on public.source_processing_jobs;
create trigger operator_event_authority_job_guard
before insert on public.source_processing_jobs
for each row execute function private.guard_operator_event_authority_write();

drop trigger if exists operator_event_authority_manifest_guard
  on public.source_ingest_manifests;
create trigger operator_event_authority_manifest_guard
before insert on public.source_ingest_manifests
for each row execute function private.guard_operator_event_authority_write();

do $block$
begin
  if exists (
    select 1 from public.source_ingest_batches batch
    where batch.source_system = 'operator' and batch.status = 'running'
  ) then
    raise exception 'operator authority cutover requires no unfinished generic operator batch'
      using errcode = '55000';
  end if;
end;
$block$;

create or replace function private.operator_truth_event_receipt(
  p_request public.operator_truth_event_requests
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_build_object(
    'ok', true,
    'schemaVersion', 'truth-operator-event-receipt-v1',
    'status', 'recorded',
    'requestId', p_request.request_id,
    'requestHash', p_request.request_hash,
    'workspaceKey', p_request.workspace_key,
    'sourceSystem', p_request.source_system,
    'connectionKey', p_request.connection_key,
    'eventId', p_request.event_id,
    'eventSequence', p_request.event_sequence::text,
    'observationId', p_request.observation_id,
    'jobId', p_request.job_id::text,
    'batchId', p_request.batch_id::text,
    'sourceCursorVersion', p_request.source_cursor_version,
    'capturedAt', to_char(
      p_request.captured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'mutatesOperationalState', false,
    'reducesTruth', false,
    'publishesTruth', false
  );
$function$;

create or replace function private.record_operator_truth_event(
  p_workspace_key text,
  p_connection_key text,
  p_idempotency_key text,
  p_request jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_existing public.operator_truth_event_requests%rowtype;
  v_prior public.source_observations%rowtype;
  v_request_row public.operator_truth_event_requests%rowtype;
  v_batch_id uuid := gen_random_uuid();
  v_job_id uuid;
  v_captured_at timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_captured_at_text text;
  v_occurred_at timestamptz;
  v_occurred_at_text text;
  v_idempotency_key_hash text;
  v_request_hash text;
  v_request_id text;
  v_event_type text;
  v_predicate text;
  v_polarity text;
  v_contract jsonb;
  v_previous_sequence bigint;
  v_next_sequence bigint;
  v_event_without_id jsonb;
  v_event jsonb;
  v_event_id text;
  v_prior_observation_id text;
  v_normalized_payload jsonb;
  v_content_hash text;
  v_observation_identity jsonb;
  v_observation_id text;
  v_observation jsonb;
  v_job_payload jsonb;
  v_job jsonb;
  v_dedupe_key text;
  v_manifest_events jsonb;
  v_provider_manifest jsonb;
  v_observation_manifest jsonb;
  v_job_manifest jsonb;
  v_provider_manifest_hash text;
  v_observation_manifest_hash text;
  v_job_manifest_hash text;
  v_payload_identity_hash text;
  v_batch_hash text;
  v_extractor_version text := 'operator-claim-extractor-v1+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e';
  v_owner_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or length(p_workspace_key) > 128
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or length(p_connection_key) > 200
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_-]{32,128}$'
    or jsonb_typeof(coalesce(p_request, 'null'::jsonb)) <> 'object'
    or octet_length(convert_to(p_request::text, 'UTF8')) > 32768 then
    raise exception 'invalid operator truth event request envelope' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.truth_workspaces workspace
    where workspace.workspace_key = p_workspace_key and workspace.status = 'active'
  ) then
    raise exception 'operator truth workspace is unavailable' using errcode = '23503';
  end if;

  v_idempotency_key_hash := encode(extensions.digest(
    convert_to(p_idempotency_key, 'UTF8'), 'sha256'
  ), 'hex');
  v_request_hash := encode(extensions.digest(convert_to(
    private.operator_truth_canonical_json_text(p_request), 'UTF8'
  ), 'sha256'), 'hex');
  v_request_id := 'operator-request:v1:' || encode(extensions.digest(convert_to(
    private.operator_truth_canonical_json_text(jsonb_build_object(
      'schemaVersion', 'operator-truth-request-identity-v1',
      'workspaceKey', p_workspace_key,
      'connectionKey', p_connection_key,
      'idempotencyKeyHash', v_idempotency_key_hash
    )), 'UTF8'
  ), 'sha256'), 'hex');

  select * into v_existing
  from public.operator_truth_event_requests request
  where request.workspace_key = p_workspace_key
    and request.connection_key = p_connection_key
    and request.idempotency_key_hash = v_idempotency_key_hash;
  if found then
    if v_existing.request_hash is distinct from v_request_hash
      or v_existing.canonical_request is distinct from p_request then
      raise exception 'operator idempotency key is already bound to a different request'
        using errcode = '23505';
    end if;
    return private.operator_truth_event_receipt(v_existing);
  end if;

  v_event_type := coalesce(p_request->>'eventType', '');
  if p_request->>'schemaVersion' is distinct from 'operator-truth-event-request-v1'
    or not (v_event_type = any (array['assertion', 'correction', 'revocation']))
    or not private.operator_truth_exact_keys(
      p_request,
      case when v_event_type = 'assertion'
        then array[
          'schemaVersion', 'eventType', 'subject', 'contact', 'recordedBy',
          'occurredAt', 'recordedSummary', 'assertion'
        ]::text[]
        else array[
          'schemaVersion', 'eventType', 'subject', 'contact', 'recordedBy',
          'occurredAt', 'recordedSummary', 'assertion', 'relatedEventId'
        ]::text[]
      end
    ) then
    raise exception 'operator request contains an unsupported or server-owned field'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_request->'subject') <> 'object'
    or jsonb_typeof(p_request->'subject'->'awbs') <> 'array'
    or not (coalesce(p_request->'subject'->>'type', '') = any (array['shipment', 'workgroup']))
    or jsonb_array_length(p_request->'subject'->'awbs') < 1
    or jsonb_array_length(p_request->'subject'->'awbs') > 100
    or exists (
      select 1 from jsonb_array_elements(p_request->'subject'->'awbs') awb
      where jsonb_typeof(awb) <> 'string' or (awb #>> '{}') !~ '^[0-9]{11}$'
    )
    or p_request->'subject'->'awbs' is distinct from (
      select jsonb_agg(awb order by awb #>> '{}')
      from jsonb_array_elements(p_request->'subject'->'awbs') awb
    )
    or jsonb_array_length(p_request->'subject'->'awbs') <> (
      select count(distinct awb #>> '{}')
      from jsonb_array_elements(p_request->'subject'->'awbs') awb
    ) then
    raise exception 'operator subject AWBs must be a bounded canonical unique set'
      using errcode = '22023';
  end if;
  if p_request->'subject'->>'type' = 'shipment' then
    if not private.operator_truth_exact_keys(
      p_request->'subject', array['type', 'awbs']::text[]
    ) or jsonb_array_length(p_request->'subject'->'awbs') <> 1 then
      raise exception 'shipment operator truth requires exactly one AWB'
        using errcode = '22023';
    end if;
  else
    if not private.operator_truth_exact_keys(
      p_request->'subject',
      array['type', 'workgroupKey', 'membershipComplete', 'awbs']::text[]
    )
      or coalesce(p_request->'subject'->>'workgroupKey', '')
        !~ '^workgroup:v1:[0-9a-f]{64}$'
      or p_request->'subject'->'membershipComplete' is distinct from 'true'::jsonb
      or jsonb_array_length(p_request->'subject'->'awbs') < 2
      or not exists (
        select 1
        from public.operational_workgroups_v2 workgroup
        join public.operational_workgroup_envelopes envelope
          on envelope.workgroup_id = workgroup.workgroup_id
         and envelope.workspace_key = p_workspace_key
        where workgroup.workspace_key = p_workspace_key
          and workgroup.workgroup_id = p_request->'subject'->>'workgroupKey'
      ) then
      raise exception 'operator workgroup subject is unavailable or incomplete'
        using errcode = '23503';
    end if;
  end if;
  if not private.operator_truth_exact_keys(
      p_request->'contact', array['name', 'organization', 'channel']::text[]
    )
    or nullif(trim(coalesce(p_request->'contact'->>'name', '')), '') is null
    or octet_length(convert_to(p_request->'contact'->>'name', 'UTF8')) > 200
    or nullif(trim(coalesce(p_request->'contact'->>'organization', '')), '') is null
    or octet_length(convert_to(p_request->'contact'->>'organization', 'UTF8')) > 300
    or p_request->'contact'->>'channel' is distinct from 'phone' then
    raise exception 'operator phone contact provenance is incomplete' using errcode = '22023';
  end if;
  if not private.operator_truth_exact_keys(
      p_request->'recordedBy', array['operatorId', 'name']::text[]
    )
    or nullif(trim(coalesce(p_request->'recordedBy'->>'operatorId', '')), '') is null
    or octet_length(convert_to(p_request->'recordedBy'->>'operatorId', 'UTF8')) > 200
    or nullif(trim(coalesce(p_request->'recordedBy'->>'name', '')), '') is null
    or octet_length(convert_to(p_request->'recordedBy'->>'name', 'UTF8')) > 200 then
    raise exception 'operator recorder provenance is incomplete' using errcode = '22023';
  end if;
  if coalesce(p_request->>'recordedSummary', '') !~ '^(I|We)([[:space:]]|$)'
    or trim(p_request->>'recordedSummary') is distinct from p_request->>'recordedSummary'
    or octet_length(convert_to(p_request->>'recordedSummary', 'UTF8')) > 2000 then
    raise exception 'operator summary must be a bounded first-person record'
      using errcode = '22023';
  end if;
  if not private.is_canonical_utc_millis(p_request->>'occurredAt') then
    raise exception 'operator occurredAt must be canonical UTC milliseconds'
      using errcode = '22023';
  end if;
  begin
    v_occurred_at := (p_request->>'occurredAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'operator occurredAt is invalid' using errcode = '22023';
  end;
  if v_occurred_at > v_captured_at then
    raise exception 'operator occurredAt cannot be later than server capture time'
      using errcode = '22023';
  end if;
  v_captured_at_text := to_char(
    v_captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_occurred_at_text := to_char(
    v_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  if not private.operator_truth_exact_keys(
      p_request->'assertion',
      array['contractVersion', 'predicate', 'polarity', 'value']::text[]
    )
    or p_request->'assertion'->>'contractVersion'
      is distinct from 'pikiio-shipment-predicates-2026-07-09-v2'
    or jsonb_typeof(p_request->'assertion'->'value') <> 'object'
    or octet_length(convert_to((p_request->'assertion'->'value')::text, 'UTF8')) > 8192 then
    raise exception 'operator structured assertion is incomplete or unpinned'
      using errcode = '22023';
  end if;
  v_predicate := coalesce(p_request->'assertion'->>'predicate', '');
  v_polarity := coalesce(p_request->'assertion'->>'polarity', '');
  v_contract := private.operator_truth_predicate_contract(v_predicate, v_polarity);
  if v_contract is null
    or p_request->'assertion'->'value'->>'status' is distinct from v_contract->>'status'
    or p_request->'assertion'->'value'->>'effect' is distinct from v_contract->>'effect' then
    raise exception 'operator assertion is outside the predicate contract'
      using errcode = '23514';
  end if;
  if v_event_type = 'revocation' and (
    v_polarity <> 'unknown'
    or not private.operator_truth_exact_keys(
      p_request->'assertion'->'value', array['status', 'effect']::text[]
    )
  ) then
    raise exception 'operator revocation must append only explicit unknown truth'
      using errcode = '23514';
  end if;

  perform set_config(
    'pikiio.operator_event_authority',
    'truth-operator-event-authority-v1',
    true
  );

  insert into public.source_cursors (
    workspace_key, source_system, connection_key, cursor_kind,
    cursor_value, cursor_version, status
  ) values (
    p_workspace_key, 'operator', p_connection_key, 'operator_sequence',
    '0', 0, 'live'
  ) on conflict (workspace_key, source_system, connection_key) do nothing;

  select * into v_cursor
  from public.source_cursors cursor
  where cursor.workspace_key = p_workspace_key
    and cursor.source_system = 'operator'
    and cursor.connection_key = p_connection_key
  for update;
  if not found
    or v_cursor.cursor_kind is distinct from 'operator_sequence'
    or v_cursor.status <> 'live'
    or v_cursor.cursor_value !~ '^(0|[1-9][0-9]*)$'
    or length(v_cursor.cursor_value) > 16
    or v_cursor.cursor_value::numeric > 9007199254740990 then
    raise exception 'operator source cursor is unavailable or invalid'
      using errcode = '23514';
  end if;

  -- The cursor lock serializes same-key and different-key writers. Re-check the
  -- idempotency binding after the lock so concurrent exact retries cannot mint
  -- two sequences.
  select * into v_existing
  from public.operator_truth_event_requests request
  where request.workspace_key = p_workspace_key
    and request.connection_key = p_connection_key
    and request.idempotency_key_hash = v_idempotency_key_hash;
  if found then
    if v_existing.request_hash is distinct from v_request_hash
      or v_existing.canonical_request is distinct from p_request then
      raise exception 'operator idempotency key is already bound to a different request'
        using errcode = '23505';
    end if;
    return private.operator_truth_event_receipt(v_existing);
  end if;
  if v_cursor.lease_expires_at is not null
    and v_cursor.lease_expires_at > v_captured_at then
    raise exception 'operator source cursor is leased by another writer'
      using errcode = '40001';
  end if;
  if exists (
    select 1 from public.source_ingest_batches batch
    where batch.workspace_key = p_workspace_key
      and batch.source_system = 'operator'
      and batch.connection_key = p_connection_key
      and batch.status = 'running'
      and batch.expected_cursor_version = v_cursor.cursor_version
      and batch.expected_cursor_value = v_cursor.cursor_value
  ) then
    raise exception 'operator source cursor has an unfinished batch'
      using errcode = '40001';
  end if;

  if v_event_type = 'assertion' then
    if p_request ? 'relatedEventId' then
      raise exception 'first operator assertion cannot point at prior truth'
        using errcode = '22023';
    end if;
  else
    if coalesce(p_request->>'relatedEventId', '')
        !~ '^operator-event:v1:[0-9a-f]{64}$' then
      raise exception 'operator revision requires one prior event identity'
        using errcode = '22023';
    end if;
    select prior.* into v_prior
    from public.source_observations prior
    where prior.workspace_key = p_workspace_key
      and prior.source_system = 'operator'
      and prior.connection_key = p_connection_key
      and prior.source_object_type = 'operator_event'
      and prior.operation = 'content'
      and prior.source_object_id = p_request->>'relatedEventId'
    order by prior.journal_seq desc
    limit 1;
    if not found then
      raise exception 'operator revision prior event is unavailable in this source scope'
        using errcode = '23503';
    end if;
    if v_prior.normalized_payload->'event'->'subject'
        is distinct from p_request->'subject'
      or v_prior.normalized_payload->'event'->'assertion'->>'predicate'
        is distinct from v_predicate then
      raise exception 'operator revision crosses its prior subject or predicate chain'
        using errcode = '23514';
    end if;
    v_prior_observation_id := v_prior.observation_id;
  end if;

  v_previous_sequence := v_cursor.cursor_value::bigint;
  v_next_sequence := v_previous_sequence + 1;
  v_owner_id := 'operator-event-authority:v1:' || substr(v_request_hash, 1, 32);
  update public.source_cursors
  set lease_owner = v_owner_id,
      lease_fence = lease_fence + 1,
      lease_expires_at = v_captured_at + interval '120 seconds',
      updated_at = v_captured_at
  where workspace_key = p_workspace_key
    and source_system = 'operator'
    and connection_key = p_connection_key
    and cursor_version = v_cursor.cursor_version
    and cursor_value = v_cursor.cursor_value
  returning * into v_cursor;
  if not found then
    raise exception 'operator source cursor fence changed' using errcode = '40001';
  end if;

  v_event_without_id := jsonb_build_object(
    'schemaVersion', 'operator-recorded-event-v1',
    'sequence', v_next_sequence::text,
    'eventType', v_event_type,
    'subject', p_request->'subject',
    'contact', p_request->'contact',
    'recordedBy', p_request->'recordedBy',
    'occurredAt', v_occurred_at_text,
    'recordedAt', v_captured_at_text,
    'recordedSummary', p_request->>'recordedSummary',
    'assertion', p_request->'assertion'
  );
  if v_event_type <> 'assertion' then
    v_event_without_id := v_event_without_id || jsonb_build_object(
      'relatedEvent', jsonb_build_object(
        'relation', case when v_event_type = 'correction' then 'corrects' else 'revokes' end,
        'eventId', v_prior.source_object_id,
        'sequence', v_prior.normalized_payload->'event'->>'sequence'
      )
    );
  end if;
  v_event_id := 'operator-event:v1:' || encode(extensions.digest(convert_to(
    private.operator_truth_canonical_json_text(v_event_without_id), 'UTF8'
  ), 'sha256'), 'hex');
  v_event := v_event_without_id || jsonb_build_object('eventId', v_event_id);
  v_normalized_payload := jsonb_build_object(
    'schemaVersion', 'operator-event-source-observation-v1',
    'capturedAt', v_captured_at_text,
    'event', v_event
  );
  v_content_hash := encode(extensions.digest(convert_to(
    private.operator_truth_canonical_json_text(v_normalized_payload), 'UTF8'
  ), 'sha256'), 'hex');
  v_observation_identity := jsonb_build_object(
    'schemaVersion', 'source-observation-identity-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'operator',
    'connectionKey', p_connection_key,
    'sourceObjectType', 'operator_event',
    'sourceObjectId', v_event_id,
    'sourceRevision', 'sequence:' || v_next_sequence::text,
    'operation', 'content',
    'contentHash', v_content_hash
  );
  v_observation_id := 'obs:v1:' || encode(extensions.digest(convert_to(
    private.operator_truth_canonical_json_text(v_observation_identity), 'UTF8'
  ), 'sha256'), 'hex');
  v_job_payload := jsonb_build_object(
    'schemaVersion', 'operator-extract-claims-job-v1',
    'sourceObservationId', v_observation_id,
    'eventId', v_event_id,
    'eventSequence', v_next_sequence::text,
    'contentHash', v_content_hash,
    'extractorVersion', v_extractor_version
  );
  v_dedupe_key := 'operator:extract-claims:v1:' || encode(extensions.digest(convert_to(
    private.operator_truth_canonical_json_text(jsonb_build_object(
      'jobKind', 'operator_extract_claims',
      'observationId', v_observation_id,
      'extractorVersion', v_extractor_version
    )), 'UTF8'
  ), 'sha256'), 'hex');
  v_observation := jsonb_build_object(
    'observationId', v_observation_id,
    'sourceObjectType', 'operator_event',
    'sourceObjectId', v_event_id,
    'sourceRevision', 'sequence:' || v_next_sequence::text,
    'operation', 'content',
    'contentHash', v_content_hash,
    'sourceRecordedAt', v_captured_at_text,
    'capturedAt', v_captured_at_text,
    'normalizedPayload', v_normalized_payload,
    'normalizedText', p_request->>'recordedSummary',
    'sourceFidelity', 'normalized_source',
    'schemaVersion', 'operator-event-source-observation-v1',
    'retentionClass', 'shipment-operations'
  );
  v_job := jsonb_build_object(
    'dedupeKey', v_dedupe_key,
    'jobKind', 'operator_extract_claims',
    'observationId', v_observation_id,
    'sourceObjectId', v_event_id,
    'maxAttempts', 5,
    'payload', v_job_payload
  );
  v_manifest_events := jsonb_build_array(jsonb_build_object(
    'eventId', v_event_id,
    'sequence', v_next_sequence::text,
    'observationId', v_observation_id,
    'contentHash', v_content_hash
  ));
  v_provider_manifest := jsonb_build_object(
    'schemaVersion', 'operator-source-delta-v1',
    'complete', true,
    'upstreamWatermark', v_next_sequence::text,
    'sourceSnapshotAt', v_captured_at_text,
    'recordCount', 1,
    'previousSequence', v_previous_sequence::text,
    'nextSequence', v_next_sequence::text,
    'eventManifestHash', encode(extensions.digest(convert_to(
      private.operator_truth_canonical_json_text(v_manifest_events), 'UTF8'
    ), 'sha256'), 'hex'),
    'events', v_manifest_events,
    'appendOnly', true
  );
  v_observation_manifest := private.source_snapshot_observation_manifest(
    jsonb_build_array(v_observation)
  );
  v_job_manifest := private.source_snapshot_job_manifest(jsonb_build_array(v_job));
  v_provider_manifest_hash := encode(extensions.digest(
    convert_to(v_provider_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_observation_manifest_hash := encode(extensions.digest(
    convert_to(v_observation_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_job_manifest_hash := encode(extensions.digest(
    convert_to(v_job_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_payload_identity_hash := private.source_snapshot_payload_identity(
    p_workspace_key, 'operator', p_connection_key, v_next_sequence::text,
    v_provider_manifest_hash, v_observation_manifest_hash, v_job_manifest_hash
  );
  v_batch_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'operator',
    'connectionKey', p_connection_key,
    'expectedCursorVersion', v_cursor.cursor_version,
    'expectedCursorValue', v_previous_sequence::text,
    'committedCursorVersion', v_cursor.cursor_version + 1,
    'committedCursorValue', v_next_sequence::text,
    'payloadIdentityHash', v_payload_identity_hash
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.source_ingest_batches (
    batch_id, workspace_key, source_system, connection_key, mode, trigger_name,
    expected_cursor_version, expected_cursor_value, lease_owner, lease_fence,
    status, started_at
  ) values (
    v_batch_id, p_workspace_key, 'operator', p_connection_key, 'snapshot',
    'truth-operator-event-authority-v1', v_cursor.cursor_version,
    v_previous_sequence::text, v_owner_id, v_cursor.lease_fence, 'running',
    v_captured_at
  );

  insert into public.source_observations (
    observation_id, workspace_key, source_system, connection_key,
    source_object_type, source_object_id, source_revision, operation,
    source_cursor_version, batch_id, content_hash, source_recorded_at,
    captured_at, normalized_payload, normalized_text, source_fidelity,
    schema_version, retention_class
  ) values (
    v_observation_id, p_workspace_key, 'operator', p_connection_key,
    'operator_event', v_event_id, 'sequence:' || v_next_sequence::text,
    'content', v_cursor.cursor_version + 1, v_batch_id, v_content_hash,
    v_captured_at, v_captured_at, v_normalized_payload,
    p_request->>'recordedSummary', 'normalized_source',
    'operator-event-source-observation-v1', 'shipment-operations'
  );

  insert into public.source_processing_jobs (
    dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, max_attempts, payload, created_at,
    updated_at
  ) values (
    v_dedupe_key, p_workspace_key, 'operator', p_connection_key,
    'operator_extract_claims', v_observation_id, v_event_id, 5,
    v_job_payload || jsonb_build_object('batchId', v_batch_id::text),
    v_captured_at, v_captured_at
  ) returning job_id into v_job_id;

  insert into public.source_ingest_batch_jobs (batch_id, job_id, dedupe_key)
  values (v_batch_id, v_job_id, v_dedupe_key);

  insert into public.source_ingest_manifests (
    batch_id, workspace_key, source_system, connection_key,
    next_cursor_value, source_snapshot_at,
    provider_manifest, provider_manifest_hash,
    observation_manifest, observation_manifest_hash,
    job_manifest, job_manifest_hash, payload_identity_hash, created_at
  ) values (
    v_batch_id, p_workspace_key, 'operator', p_connection_key,
    v_next_sequence::text, v_captured_at,
    v_provider_manifest, v_provider_manifest_hash,
    v_observation_manifest, v_observation_manifest_hash,
    v_job_manifest, v_job_manifest_hash, v_payload_identity_hash, v_captured_at
  );

  update public.source_ingest_batches
  set committed_cursor_version = expected_cursor_version + 1,
      committed_cursor_value = v_next_sequence::text,
      status = 'committed',
      batch_hash = v_batch_hash,
      page_count = 1,
      observation_count = 1,
      job_count = 1,
      committed_at = v_captured_at,
      finished_at = v_captured_at
  where batch_id = v_batch_id and status = 'running';
  if not found then
    raise exception 'operator event batch commit was lost' using errcode = '40001';
  end if;

  update public.source_cursors
  set cursor_value = v_next_sequence::text,
      cursor_version = cursor_version + 1,
      status = 'live',
      last_batch_id = v_batch_id,
      last_committed_at = v_captured_at,
      last_error_code = '',
      last_error_detail = '',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_captured_at
  where workspace_key = p_workspace_key
    and source_system = 'operator'
    and connection_key = p_connection_key
    and cursor_version = v_cursor.cursor_version
    and cursor_value = v_previous_sequence::text
    and lease_owner = v_owner_id
    and lease_fence = v_cursor.lease_fence;
  if not found then
    raise exception 'operator source cursor compare-and-swap failed'
      using errcode = '40001';
  end if;

  insert into public.operator_truth_event_requests (
    request_id, workspace_key, source_system, connection_key,
    idempotency_key_hash, request_hash, canonical_request,
    event_id, event_sequence, prior_observation_id,
    observation_id, job_id, batch_id, source_cursor_version, captured_at,
    created_at
  ) values (
    v_request_id, p_workspace_key, 'operator', p_connection_key,
    v_idempotency_key_hash, v_request_hash, p_request,
    v_event_id, v_next_sequence, v_prior_observation_id,
    v_observation_id, v_job_id, v_batch_id, v_cursor.cursor_version + 1,
    v_captured_at, v_captured_at
  ) returning * into v_request_row;

  return private.operator_truth_event_receipt(v_request_row);
end;
$function$;

create or replace function public.record_operator_truth_event(
  p_workspace_key text,
  p_connection_key text,
  p_idempotency_key text,
  p_request jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.record_operator_truth_event(
    p_workspace_key, p_connection_key, p_idempotency_key,
    p_request, p_sync_token
  );
$function$;

revoke all on function private.operator_truth_canonical_json_text(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.operator_truth_exact_keys(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.operator_truth_predicate_contract(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_operator_event_authority_write()
  from public, anon, authenticated, service_role;
revoke all on function private.operator_truth_event_receipt(public.operator_truth_event_requests)
  from public, anon, authenticated, service_role;
revoke all on function private.record_operator_truth_event(text, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_operator_truth_event(text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.record_operator_truth_event(text, text, text, jsonb, text)
  to service_role;
