-- Server-derived source-cut coordination.
--
-- A hosted worker must never assemble its own cursor vector from several
-- round trips. The required-source registry below is configuration-as-data;
-- the coordinator locks that exact vector, derives freshness/open-batch/empty
-- scope gaps, and delegates immutable sealing to private.seal_source_cut in
-- the same database transaction.

create table if not exists public.truth_required_sources (
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null
    check (source_system = any (array['gmail', 'tms', 'tracking', 'operator'])),
  connection_key text not null,
  cursor_kind text not null,
  freshness_seconds integer
    check (freshness_seconds is null or freshness_seconds between 60 and 604800),
  allow_empty_scope boolean not null default false,
  registry_version text not null default 'truth-required-sources-v1',
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_key, source_system, connection_key)
);

insert into public.truth_required_sources (
  workspace_key, source_system, connection_key, cursor_kind,
  freshness_seconds, allow_empty_scope, registry_version
) values
  ('primary', 'gmail', 'primary', 'gmail_history_id', 3600, false, 'truth-required-sources-v1'),
  ('primary', 'tms', 'couriercloud-ops-tlv-us', 'tms_snapshot_timestamp', 129600, false, 'truth-required-sources-v1'),
  ('primary', 'tracking', 'carrier-tracking-primary', 'tracking_snapshot_timestamp', 129600, false, 'truth-required-sources-v1'),
  ('primary', 'operator', 'operator-phone-primary', 'operator_sequence', null, true, 'truth-required-sources-v1')
on conflict (workspace_key, source_system, connection_key) do nothing;

do $block$
begin
  if exists (
    (
      select *
      from (values
        ('primary'::text, 'gmail'::text, 'primary'::text, 'gmail_history_id'::text,
          3600::integer, false, 'truth-required-sources-v1'::text),
        ('primary', 'tms', 'couriercloud-ops-tlv-us', 'tms_snapshot_timestamp',
          129600, false, 'truth-required-sources-v1'),
        ('primary', 'tracking', 'carrier-tracking-primary', 'tracking_snapshot_timestamp',
          129600, false, 'truth-required-sources-v1'),
        ('primary', 'operator', 'operator-phone-primary', 'operator_sequence',
          null::integer, true, 'truth-required-sources-v1')
      ) expected(
        workspace_key, source_system, connection_key, cursor_kind,
        freshness_seconds, allow_empty_scope, registry_version
      )
      except
      select
        required_source.workspace_key,
        required_source.source_system,
        required_source.connection_key,
        required_source.cursor_kind,
        required_source.freshness_seconds,
        required_source.allow_empty_scope,
        required_source.registry_version
      from public.truth_required_sources required_source
      where required_source.workspace_key = 'primary'
    )
    union all
    (
      select
        required_source.workspace_key,
        required_source.source_system,
        required_source.connection_key,
        required_source.cursor_kind,
        required_source.freshness_seconds,
        required_source.allow_empty_scope,
        required_source.registry_version
      from public.truth_required_sources required_source
      where required_source.workspace_key = 'primary'
      except
      select *
      from (values
        ('primary'::text, 'gmail'::text, 'primary'::text, 'gmail_history_id'::text,
          3600::integer, false, 'truth-required-sources-v1'::text),
        ('primary', 'tms', 'couriercloud-ops-tlv-us', 'tms_snapshot_timestamp',
          129600, false, 'truth-required-sources-v1'),
        ('primary', 'tracking', 'carrier-tracking-primary', 'tracking_snapshot_timestamp',
          129600, false, 'truth-required-sources-v1'),
        ('primary', 'operator', 'operator-phone-primary', 'operator_sequence',
          null::integer, true, 'truth-required-sources-v1')
      ) expected(
        workspace_key, source_system, connection_key, cursor_kind,
        freshness_seconds, allow_empty_scope, registry_version
      )
    )
  ) then
    raise exception 'primary truth required-source registry conflicts with migration contract'
      using errcode = '23514';
  end if;
end;
$block$;

-- An operator event stream legitimately begins empty. The genesis cursor has
-- a deterministic committed batch + manifest so it satisfies the same cursor
-- fence as every other required source without inventing an observation.
-- Every later operator event must advance it through the generic transaction.
insert into public.source_cursors (
  workspace_key, source_system, connection_key, cursor_kind,
  cursor_value, cursor_version, status, last_committed_at,
  last_error_code, last_error_detail
) values (
  'primary', 'operator', 'operator-phone-primary', 'operator_sequence',
  '0', 0, 'live', '1970-01-01T00:00:00.000Z'::timestamptz, '', ''
) on conflict (workspace_key, source_system, connection_key) do nothing;

do $block$
declare
  v_cursor public.source_cursors%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_manifest public.source_ingest_manifests%rowtype;
  v_batch_id uuid := '00000000-0000-4000-8000-000000000340'::uuid;
  v_genesis_at timestamptz := '1970-01-01T00:00:00.000Z'::timestamptz;
  v_provider_manifest jsonb := jsonb_build_object(
    'schemaVersion', 'operator-source-delta-v1',
    'sourceSystem', 'operator',
    'connectionKey', 'operator-phone-primary',
    'upstreamWatermark', '0',
    'sourceSnapshotAt', '1970-01-01T00:00:00.000Z',
    'eventCount', 0,
    'events', '[]'::jsonb
  );
  v_empty_manifest jsonb := '[]'::jsonb;
  v_provider_hash text;
  v_empty_hash text;
  v_batch_hash text;
  v_payload_identity_hash text;
begin
  select * into v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = 'primary'
    and cursor_row.source_system = 'operator'
    and cursor_row.connection_key = 'operator-phone-primary'
  for update;

  if not found
    or v_cursor.cursor_kind is distinct from 'operator_sequence'
    or v_cursor.cursor_value !~ '^(0|[1-9][0-9]*)$'
    or (v_cursor.cursor_version = 0 and (
      v_cursor.cursor_value <> '0'
      or v_cursor.status <> 'live'
      or v_cursor.last_error_code <> ''
      or v_cursor.last_error_detail <> ''
    )) then
    raise exception 'operator genesis cursor conflicts with migration contract'
      using errcode = '23514';
  end if;

  if v_cursor.cursor_version > 0 then
    return;
  end if;

  v_provider_hash := encode(extensions.digest(
    convert_to(v_provider_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_empty_hash := encode(extensions.digest(
    convert_to(v_empty_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_batch_hash := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'schemaVersion', 'operator-genesis-batch-v1',
      'workspaceKey', 'primary',
      'connectionKey', 'operator-phone-primary',
      'cursorVersion', 0,
      'cursorValue', '0'
    )::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_payload_identity_hash := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'schemaVersion', 'operator-genesis-payload-v1',
      'providerManifestHash', v_provider_hash,
      'observationManifestHash', v_empty_hash,
      'jobManifestHash', v_empty_hash
    )::text, 'UTF8'), 'sha256'
  ), 'hex');

  insert into public.source_ingest_batches (
    batch_id, workspace_key, source_system, connection_key, mode,
    trigger_name, expected_cursor_version, expected_cursor_value,
    committed_cursor_version, committed_cursor_value, lease_owner,
    lease_fence, status, batch_hash, page_count, observation_count,
    job_count, started_at, committed_at, finished_at
  ) values (
    v_batch_id, 'primary', 'operator', 'operator-phone-primary', 'snapshot',
    'operator-genesis-v1', 0, '0', 0, '0', 'operator-genesis-v1',
    1, 'committed', v_batch_hash, 0, 0, 0,
    v_genesis_at, v_genesis_at, v_genesis_at
  ) on conflict (batch_id) do nothing;

  select * into v_batch
  from public.source_ingest_batches batch
  where batch.batch_id = v_batch_id;
  if not found
    or row(
      v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
      v_batch.mode, v_batch.trigger_name, v_batch.expected_cursor_version,
      v_batch.expected_cursor_value, v_batch.committed_cursor_version,
      v_batch.committed_cursor_value, v_batch.status, v_batch.batch_hash,
      v_batch.observation_count, v_batch.job_count
    ) is distinct from row(
      'primary'::text, 'operator'::text, 'operator-phone-primary'::text,
      'snapshot'::text, 'operator-genesis-v1'::text, 0::bigint,
      '0'::text, 0::bigint, '0'::text, 'committed'::text, v_batch_hash,
      0::integer, 0::integer
    ) then
    raise exception 'operator genesis batch conflicts with migration contract'
      using errcode = '23514';
  end if;

  insert into public.source_ingest_manifests (
    batch_id, workspace_key, source_system, connection_key,
    next_cursor_value, source_snapshot_at, provider_manifest,
    provider_manifest_hash, observation_manifest,
    observation_manifest_hash, job_manifest, job_manifest_hash,
    payload_identity_hash, created_at
  ) values (
    v_batch_id, 'primary', 'operator', 'operator-phone-primary',
    '0', v_genesis_at, v_provider_manifest, v_provider_hash,
    v_empty_manifest, v_empty_hash, v_empty_manifest, v_empty_hash,
    v_payload_identity_hash, v_genesis_at
  ) on conflict (batch_id) do nothing;

  select * into v_manifest
  from public.source_ingest_manifests manifest
  where manifest.batch_id = v_batch_id;
  if not found
    or row(
      v_manifest.workspace_key, v_manifest.source_system,
      v_manifest.connection_key, v_manifest.next_cursor_value,
      v_manifest.source_snapshot_at, v_manifest.provider_manifest,
      v_manifest.provider_manifest_hash, v_manifest.observation_manifest,
      v_manifest.observation_manifest_hash, v_manifest.job_manifest,
      v_manifest.job_manifest_hash, v_manifest.payload_identity_hash
    ) is distinct from row(
      'primary'::text, 'operator'::text, 'operator-phone-primary'::text,
      '0'::text, v_genesis_at, v_provider_manifest, v_provider_hash,
      v_empty_manifest, v_empty_hash, v_empty_manifest, v_empty_hash,
      v_payload_identity_hash
    ) then
    raise exception 'operator genesis manifest conflicts with migration contract'
      using errcode = '23514';
  end if;

  update public.source_cursors
  set last_batch_id = v_batch_id,
      last_committed_at = v_genesis_at
  where workspace_key = 'primary'
    and source_system = 'operator'
    and connection_key = 'operator-phone-primary'
    and cursor_version = 0
    and cursor_value = '0'
    and (last_batch_id is null or last_batch_id = v_batch_id);

  select * into v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = 'primary'
    and cursor_row.source_system = 'operator'
    and cursor_row.connection_key = 'operator-phone-primary';
  if v_cursor.last_batch_id is distinct from v_batch_id
    or v_cursor.last_committed_at is distinct from v_genesis_at then
    raise exception 'operator genesis cursor fence conflicts with migration contract'
      using errcode = '23514';
  end if;
end;
$block$;

create or replace function private.seal_current_source_cut(
  p_workspace_key text,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_required_sources jsonb;
  v_cursors jsonb;
  v_gaps jsonb;
  v_not_ready_gaps jsonb;
  v_receipt jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_created_by, '')), '') is null then
    raise exception 'source-cut coordinator identity is incomplete' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.truth_workspaces workspace
    where workspace.workspace_key = p_workspace_key
      and workspace.status = 'active'
  ) then
    raise exception 'truth workspace is unavailable or disabled' using errcode = '23503';
  end if;

  -- Registry rows are configuration state. Lock them before deriving either
  -- the required-source list or any cursor so the vector cannot change under
  -- this transaction.
  perform required_source.workspace_key
  from public.truth_required_sources required_source
  where required_source.workspace_key = p_workspace_key
  order by required_source.source_system, required_source.connection_key
  for share of required_source;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceSystem', required_source.source_system,
    'connectionKey', required_source.connection_key
  ) order by required_source.source_system, required_source.connection_key), '[]'::jsonb)
  into v_required_sources
  from public.truth_required_sources required_source
  where required_source.workspace_key = p_workspace_key;

  if jsonb_array_length(v_required_sources) = 0 then
    raise exception 'truth workspace has no required-source registry' using errcode = '23514';
  end if;

  -- Lock every existing required cursor in the same registry order. Missing
  -- cursors remain visible in the diagnostic receipt.
  perform cursor_row.workspace_key
  from public.truth_required_sources required_source
  join public.source_cursors cursor_row
    on cursor_row.workspace_key = required_source.workspace_key
   and cursor_row.source_system = required_source.source_system
   and cursor_row.connection_key = required_source.connection_key
  where required_source.workspace_key = p_workspace_key
  order by required_source.source_system, required_source.connection_key
  for share of cursor_row;

  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb)
  into v_not_ready_gaps
  from (
    select jsonb_build_object(
      'gapType', case
        when cursor_row.workspace_key is null then 'REQUIRED_SOURCE_CURSOR_MISSING'
        when cursor_row.cursor_kind is distinct from required_source.cursor_kind
          then 'REQUIRED_SOURCE_CURSOR_KIND_MISMATCH'
        when nullif(cursor_row.cursor_value, '') is null
          then 'REQUIRED_SOURCE_CURSOR_UNINITIALIZED'
        when committed_batch.batch_id is null
          then 'REQUIRED_SOURCE_COMMIT_WITNESS_MISSING'
        else 'REQUIRED_SOURCE_GENERIC_MANIFEST_MISSING'
      end,
      'sourceSystem', required_source.source_system,
      'connectionKey', required_source.connection_key,
      'expectedCursorKind', required_source.cursor_kind,
      'actualCursorKind', coalesce(cursor_row.cursor_kind, ''),
      'status', coalesce(cursor_row.status, 'missing')
    ) as gap
    from public.truth_required_sources required_source
    left join public.source_cursors cursor_row
      on cursor_row.workspace_key = required_source.workspace_key
     and cursor_row.source_system = required_source.source_system
     and cursor_row.connection_key = required_source.connection_key
    left join public.source_ingest_batches committed_batch
      on committed_batch.batch_id = cursor_row.last_batch_id
     and committed_batch.workspace_key = cursor_row.workspace_key
     and committed_batch.source_system = cursor_row.source_system
     and committed_batch.connection_key = cursor_row.connection_key
     and committed_batch.status = 'committed'
     and committed_batch.committed_cursor_version = cursor_row.cursor_version
     and committed_batch.committed_cursor_value = cursor_row.cursor_value
    left join public.source_ingest_manifests committed_manifest
      on committed_manifest.batch_id = committed_batch.batch_id
     and committed_manifest.workspace_key = committed_batch.workspace_key
     and committed_manifest.source_system = committed_batch.source_system
     and committed_manifest.connection_key = committed_batch.connection_key
     and committed_manifest.next_cursor_value = cursor_row.cursor_value
     and committed_manifest.provider_manifest_hash = encode(extensions.digest(
       convert_to(committed_manifest.provider_manifest::text, 'UTF8'), 'sha256'
     ), 'hex')
     and committed_manifest.observation_manifest_hash = encode(extensions.digest(
       convert_to(committed_manifest.observation_manifest::text, 'UTF8'), 'sha256'
     ), 'hex')
     and committed_manifest.job_manifest_hash = encode(extensions.digest(
       convert_to(committed_manifest.job_manifest::text, 'UTF8'), 'sha256'
     ), 'hex')
     and committed_manifest.provider_manifest->>'upstreamWatermark' = cursor_row.cursor_value
     and private.is_canonical_utc_millis(
       committed_manifest.provider_manifest->>'sourceSnapshotAt'
     )
     and (committed_manifest.provider_manifest->>'sourceSnapshotAt')::timestamptz
       = committed_manifest.source_snapshot_at
    where required_source.workspace_key = p_workspace_key
      and (
        cursor_row.workspace_key is null
        or cursor_row.cursor_kind is distinct from required_source.cursor_kind
        or nullif(cursor_row.cursor_value, '') is null
        or committed_batch.batch_id is null
        or (
          required_source.source_system <> 'gmail'
          and committed_manifest.batch_id is null
        )
      )
  ) unavailable;

  if jsonb_array_length(v_not_ready_gaps) > 0 then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'sourceCutId', null,
      'manifestHash', null,
      'completeness', 'degraded',
      'observationCount', 0,
      'gaps', v_not_ready_gaps,
      'manifest', null
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceSystem', cursor_row.source_system,
    'connectionKey', cursor_row.connection_key,
    'cursorKind', cursor_row.cursor_kind,
    'throughCursorVersion', cursor_row.cursor_version,
    'throughCursorValue', cursor_row.cursor_value,
    'upstreamWatermark', case
      when cursor_row.source_system = 'gmail' then cursor_row.cursor_value
      else committed_manifest.provider_manifest->>'upstreamWatermark'
    end,
    'sourceSnapshotAt', private.canonical_truth_timestamp(case
      when cursor_row.source_system = 'gmail' then committed_batch.committed_at
      else committed_manifest.source_snapshot_at
    end)
  ) order by cursor_row.source_system, cursor_row.connection_key), '[]'::jsonb)
  into v_cursors
  from public.truth_required_sources required_source
  join public.source_cursors cursor_row
    on cursor_row.workspace_key = required_source.workspace_key
   and cursor_row.source_system = required_source.source_system
   and cursor_row.connection_key = required_source.connection_key
  join public.source_ingest_batches committed_batch
    on committed_batch.batch_id = cursor_row.last_batch_id
   and committed_batch.workspace_key = cursor_row.workspace_key
   and committed_batch.source_system = cursor_row.source_system
   and committed_batch.connection_key = cursor_row.connection_key
   and committed_batch.status = 'committed'
   and committed_batch.committed_cursor_version = cursor_row.cursor_version
   and committed_batch.committed_cursor_value = cursor_row.cursor_value
  left join public.source_ingest_manifests committed_manifest
    on committed_manifest.batch_id = committed_batch.batch_id
   and committed_manifest.workspace_key = committed_batch.workspace_key
   and committed_manifest.source_system = committed_batch.source_system
   and committed_manifest.connection_key = committed_batch.connection_key
   and committed_manifest.next_cursor_value = cursor_row.cursor_value
  where required_source.workspace_key = p_workspace_key;

  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb)
  into v_gaps
  from (
    select jsonb_build_object(
      'gapType', 'REQUIRED_SOURCE_STALE',
      'sourceSystem', required_source.source_system,
      'connectionKey', required_source.connection_key,
      'lastCommittedAt', case
        when required_source.source_system = 'gmail' then committed_batch.committed_at
        else committed_manifest.source_snapshot_at
      end,
      'freshnessSeconds', required_source.freshness_seconds
    ) as gap
    from public.truth_required_sources required_source
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = required_source.workspace_key
     and cursor_row.source_system = required_source.source_system
     and cursor_row.connection_key = required_source.connection_key
    join public.source_ingest_batches committed_batch
      on committed_batch.batch_id = cursor_row.last_batch_id
     and committed_batch.workspace_key = cursor_row.workspace_key
     and committed_batch.source_system = cursor_row.source_system
     and committed_batch.connection_key = cursor_row.connection_key
     and committed_batch.status = 'committed'
     and committed_batch.committed_cursor_version = cursor_row.cursor_version
     and committed_batch.committed_cursor_value = cursor_row.cursor_value
    left join public.source_ingest_manifests committed_manifest
      on committed_manifest.batch_id = committed_batch.batch_id
     and committed_manifest.workspace_key = committed_batch.workspace_key
     and committed_manifest.source_system = committed_batch.source_system
     and committed_manifest.connection_key = committed_batch.connection_key
    where required_source.workspace_key = p_workspace_key
      and required_source.freshness_seconds is not null
      and (
        (case
          when required_source.source_system = 'gmail' then committed_batch.committed_at
          else committed_manifest.source_snapshot_at
        end) is null
        or (case
          when required_source.source_system = 'gmail' then committed_batch.committed_at
          else committed_manifest.source_snapshot_at
        end) < clock_timestamp()
          - make_interval(secs => required_source.freshness_seconds)
      )
    union
    select jsonb_build_object(
      'gapType', 'REQUIRED_SOURCE_EMPTY',
      'sourceSystem', required_source.source_system,
      'connectionKey', required_source.connection_key,
      'throughCursorVersion', cursor_row.cursor_version
    ) as gap
    from public.truth_required_sources required_source
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = required_source.workspace_key
     and cursor_row.source_system = required_source.source_system
     and cursor_row.connection_key = required_source.connection_key
    cross join lateral (
      select private.source_cut_partition_witness(
        cursor_row.workspace_key,
        cursor_row.source_system,
        cursor_row.connection_key,
        cursor_row.cursor_version
      ) as witness
    ) partition
    where required_source.workspace_key = p_workspace_key
      and required_source.allow_empty_scope = false
      and (partition.witness->>'observationCount')::integer = 0
    union
    select jsonb_build_object(
      'gapType', 'SOURCE_INGEST_BATCH_OPEN',
      'sourceSystem', required_source.source_system,
      'connectionKey', required_source.connection_key,
      'batchId', batch.batch_id,
      'batchStatus', batch.status,
      'batchMode', batch.mode
    ) as gap
    from public.truth_required_sources required_source
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = required_source.workspace_key
     and cursor_row.source_system = required_source.source_system
     and cursor_row.connection_key = required_source.connection_key
    join public.source_ingest_batches batch
      on batch.workspace_key = cursor_row.workspace_key
     and batch.source_system = cursor_row.source_system
     and batch.connection_key = cursor_row.connection_key
    where required_source.workspace_key = p_workspace_key
      and batch.status in ('running', 'failed')
      and batch.expected_cursor_version >= cursor_row.cursor_version
    union
    select jsonb_build_object(
      'gapType', 'REQUIRED_SOURCE_NOT_LIVE',
      'sourceSystem', required_source.source_system,
      'connectionKey', required_source.connection_key,
      'status', cursor_row.status
    ) as gap
    from public.truth_required_sources required_source
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = required_source.workspace_key
     and cursor_row.source_system = required_source.source_system
     and cursor_row.connection_key = required_source.connection_key
    where required_source.workspace_key = p_workspace_key
      and cursor_row.status <> 'live'
  ) derived;

  v_receipt := private.seal_source_cut(
    p_workspace_key,
    'source-cut-manifest-v2',
    v_required_sources,
    v_gaps,
    v_cursors,
    '[]'::jsonb,
    p_created_by,
    p_sync_token
  );
  return v_receipt || jsonb_build_object('status', 'sealed');
end;
$function$;

create or replace function public.seal_current_source_cut(
  p_workspace_key text,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.seal_current_source_cut(
    p_workspace_key,
    p_created_by,
    p_sync_token
  );
$function$;

alter table public.truth_required_sources enable row level security;
alter table public.truth_required_sources force row level security;

revoke all on table public.truth_required_sources from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.truth_required_sources from service_role;
grant select on table public.truth_required_sources to service_role;

revoke all on function private.seal_current_source_cut(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.seal_current_source_cut(text, text, text)
  from public, anon, authenticated;
grant execute on function public.seal_current_source_cut(text, text, text)
  to service_role;
