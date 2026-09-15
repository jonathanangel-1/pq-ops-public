-- Server-issued tracking scope authority.
--
-- `expectedAwbs` is only a meaningful completeness witness when it comes from
-- the fenced TMS source, not from the same caller returning tracking rows. A
-- short-lived immutable scope token binds the current TMS cursor and exact AWB
-- set. A trigger rejects tracking commits that omit, alter, reuse, or outlive
-- that server-issued scope.

create table if not exists public.truth_tracking_scopes (
  scope_token text primary key
    check (scope_token ~ '^tracking-scope:v1:[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  tms_source_system text not null default 'tms'
    check (tms_source_system = 'tms'),
  tms_connection_key text not null,
  tracking_source_system text not null default 'tracking'
    check (tracking_source_system = 'tracking'),
  tracking_connection_key text not null,
  tms_cursor_version bigint not null check (tms_cursor_version >= 0),
  tms_cursor_value text not null,
  expected_awbs jsonb not null check (jsonb_typeof(expected_awbs) = 'array'),
  expected_awb_count integer not null
    check (
      expected_awb_count >= 0
      and expected_awb_count = jsonb_array_length(expected_awbs)
    ),
  expected_awbs_hash text not null check (expected_awbs_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > issued_at),
  issued_by text not null
    check (nullif(trim(issued_by), '') is not null and char_length(issued_by) <= 200),
  issuer_version text not null default 'truth-tracking-scope-authority-v1',
  created_at timestamptz not null default clock_timestamp(),
  unique (scope_token, workspace_key, tracking_connection_key),
  foreign key (workspace_key, tms_source_system, tms_connection_key)
    references public.truth_required_sources(
      workspace_key, source_system, connection_key
    ) on update restrict on delete restrict,
  foreign key (workspace_key, tracking_source_system, tracking_connection_key)
    references public.truth_required_sources(
      workspace_key, source_system, connection_key
    ) on update restrict on delete restrict
);

create table if not exists public.truth_tracking_scope_bindings (
  scope_token text primary key,
  batch_id uuid not null unique,
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null default 'tracking'
    check (source_system = 'tracking'),
  tracking_connection_key text not null,
  bound_at timestamptz not null default clock_timestamp(),
  foreign key (scope_token, workspace_key, tracking_connection_key)
    references public.truth_tracking_scopes(
      scope_token, workspace_key, tracking_connection_key
    ) on update restrict on delete restrict,
  foreign key (batch_id, workspace_key, source_system, tracking_connection_key)
    references public.source_ingest_batches(
      batch_id, workspace_key, source_system, connection_key
  ) on update restrict on delete restrict
);

create index if not exists truth_tracking_scopes_tms_requirement_idx
  on public.truth_tracking_scopes (
    workspace_key, tms_source_system, tms_connection_key
  );
create index if not exists truth_tracking_scopes_tracking_requirement_idx
  on public.truth_tracking_scopes (
    workspace_key, tracking_source_system, tracking_connection_key
  );

create or replace function private.issue_truth_tracking_scope(
  p_workspace_key text,
  p_ttl_seconds integer,
  p_issued_by text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tms_requirement public.truth_required_sources%rowtype;
  v_tracking_requirement public.truth_required_sources%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_manifest public.source_ingest_manifests%rowtype;
  v_expected_awbs jsonb;
  v_expected_count integer;
  v_expected_hash text;
  v_issued_at timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_scope_hash text;
  v_scope_token text;
  v_nonce uuid := pg_catalog.gen_random_uuid();
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 3600
    or nullif(trim(coalesce(p_issued_by, '')), '') is null
    or char_length(p_issued_by) > 200 then
    raise exception 'tracking scope issuance request is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.truth_workspaces workspace
    where workspace.workspace_key = p_workspace_key
      and workspace.status = 'active'
  ) then
    raise exception 'tracking scope workspace is unavailable or disabled'
      using errcode = '55000';
  end if;

  select * into v_tms_requirement
  from public.truth_required_sources requirement
  where requirement.workspace_key = p_workspace_key
    and requirement.source_system = 'tms';
  if not found then
    raise exception 'required TMS scope is not configured' using errcode = '23503';
  end if;
  if (
    select count(*) from public.truth_required_sources requirement
    where requirement.workspace_key = p_workspace_key
      and requirement.source_system = 'tms'
  ) <> 1 then
    raise exception 'tracking scope requires exactly one authoritative TMS connection'
      using errcode = '23514';
  end if;

  select * into v_tracking_requirement
  from public.truth_required_sources requirement
  where requirement.workspace_key = p_workspace_key
    and requirement.source_system = 'tracking';
  if not found then
    raise exception 'required tracking connection is not configured' using errcode = '23503';
  end if;
  if (
    select count(*) from public.truth_required_sources requirement
    where requirement.workspace_key = p_workspace_key
      and requirement.source_system = 'tracking'
  ) <> 1 then
    raise exception 'tracking scope requires exactly one tracking connection'
      using errcode = '23514';
  end if;

  select * into v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = p_workspace_key
    and cursor_row.source_system = 'tms'
    and cursor_row.connection_key = v_tms_requirement.connection_key
  for share;
  if not found
    or v_cursor.status <> 'live'
    or v_cursor.cursor_kind is distinct from v_tms_requirement.cursor_kind
    or v_cursor.last_batch_id is null
    or v_cursor.last_committed_at is null
    or (
      v_tms_requirement.freshness_seconds is not null
      and v_cursor.last_committed_at < clock_timestamp()
        - make_interval(secs => v_tms_requirement.freshness_seconds)
    ) then
    raise exception 'authoritative TMS scope is missing, stale, or not live'
      using errcode = '55000';
  end if;

  select manifest.* into v_manifest
  from public.source_ingest_manifests manifest
  join public.source_ingest_batches batch
    on batch.batch_id = manifest.batch_id
   and batch.workspace_key = manifest.workspace_key
   and batch.source_system = manifest.source_system
   and batch.connection_key = manifest.connection_key
  where manifest.batch_id = v_cursor.last_batch_id
    and manifest.workspace_key = p_workspace_key
    and manifest.source_system = 'tms'
    and manifest.connection_key = v_tms_requirement.connection_key
    and batch.status = 'committed'
    and batch.committed_cursor_version = v_cursor.cursor_version
    and batch.committed_cursor_value = v_cursor.cursor_value;
  if not found
    or v_manifest.next_cursor_value is distinct from v_cursor.cursor_value
    or v_manifest.provider_manifest->>'schemaVersion' is distinct from 'tms-detail-source-snapshot-v1'
    or v_manifest.provider_manifest->'complete' is distinct from 'true'::jsonb
    or jsonb_typeof(v_manifest.provider_manifest->'rows') <> 'array' then
    raise exception 'authoritative TMS manifest does not match its live cursor'
      using errcode = '23514';
  end if;
  if v_tms_requirement.freshness_seconds is not null
    and v_manifest.source_snapshot_at < clock_timestamp()
      - make_interval(secs => v_tms_requirement.freshness_seconds) then
    raise exception 'authoritative TMS source snapshot is stale'
      using errcode = '55000';
  end if;

  with normalized as (
    select regexp_replace(coalesce(item->>'trackingNumber', ''), '[^0-9]', '', 'g') as awb
    from jsonb_array_elements(v_manifest.provider_manifest->'rows') item
  )
  select coalesce(jsonb_agg(awb order by awb), '[]'::jsonb), count(*)::integer
  into v_expected_awbs, v_expected_count
  from normalized;
  if v_expected_count <> (v_manifest.provider_manifest->>'recordCount')::integer
    or exists (
      select 1
      from jsonb_array_elements_text(v_expected_awbs) as expected(awb)
      where expected.awb !~ '^[0-9]{11}$'
    )
    or (
      select count(distinct expected.awb)
      from jsonb_array_elements_text(v_expected_awbs) as expected(awb)
    ) <> v_expected_count then
    raise exception 'authoritative TMS manifest cannot issue an exact AWB scope'
      using errcode = '23514';
  end if;
  if v_expected_count = 0 and not v_tms_requirement.allow_empty_scope then
    raise exception 'authoritative TMS scope is empty but empty scope is forbidden'
      using errcode = '23514';
  end if;

  v_expected_hash := encode(extensions.digest(
    convert_to(v_expected_awbs::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_expires_at := v_issued_at + make_interval(secs => p_ttl_seconds);
  v_scope_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-tracking-scope-v1',
    'workspaceKey', p_workspace_key,
    'tmsConnectionKey', v_tms_requirement.connection_key,
    'trackingConnectionKey', v_tracking_requirement.connection_key,
    'tmsCursorVersion', v_cursor.cursor_version,
    'tmsCursorValue', v_cursor.cursor_value,
    'expectedAwbsHash', v_expected_hash,
    'nonce', v_nonce,
    'issuedAt', v_issued_at,
    'expiresAt', v_expires_at,
    'issuedBy', p_issued_by
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_scope_token := 'tracking-scope:v1:' || v_scope_hash;

  insert into public.truth_tracking_scopes (
    scope_token, workspace_key,
    tms_source_system, tms_connection_key,
    tracking_source_system, tracking_connection_key,
    tms_cursor_version, tms_cursor_value, expected_awbs, expected_awb_count,
    expected_awbs_hash, issued_at, expires_at, issued_by, issuer_version
  ) values (
    v_scope_token, p_workspace_key,
    'tms', v_tms_requirement.connection_key,
    'tracking', v_tracking_requirement.connection_key,
    v_cursor.cursor_version,
    v_cursor.cursor_value, v_expected_awbs, v_expected_count,
    v_expected_hash, v_issued_at, v_expires_at, p_issued_by,
    'truth-tracking-scope-authority-v1'
  );

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'truth-tracking-scope-receipt-v1',
    'scopeToken', v_scope_token,
    'workspaceKey', p_workspace_key,
    'tmsConnectionKey', v_tms_requirement.connection_key,
    'trackingConnectionKey', v_tracking_requirement.connection_key,
    'tmsCursorVersion', v_cursor.cursor_version,
    'tmsCursorValue', v_cursor.cursor_value,
    'expectedAwbs', v_expected_awbs,
    'expectedAwbCount', v_expected_count,
    'expectedAwbsHash', v_expected_hash,
    'issuedBy', p_issued_by,
    'issuedAt', v_issued_at,
    'expiresAt', v_expires_at
  );
end;
$function$;

create or replace function private.read_truth_tracking_scope(
  p_workspace_key text,
  p_scope_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope public.truth_tracking_scopes%rowtype;
  v_cursor public.source_cursors%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_scope
  from public.truth_tracking_scopes scope
  where scope.workspace_key = p_workspace_key
    and scope.scope_token = p_scope_token;
  if not found or v_scope.expires_at <= clock_timestamp() then
    raise exception 'tracking scope is unavailable or expired' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.truth_tracking_scope_bindings binding
    where binding.scope_token = v_scope.scope_token
  ) then
    raise exception 'tracking scope is already bound to a committed attempt'
      using errcode = '55000';
  end if;
  select * into v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = v_scope.workspace_key
    and cursor_row.source_system = 'tms'
    and cursor_row.connection_key = v_scope.tms_connection_key
  for share;
  if not found or v_cursor.status <> 'live'
    or v_cursor.cursor_version is distinct from v_scope.tms_cursor_version
    or v_cursor.cursor_value is distinct from v_scope.tms_cursor_value then
    raise exception 'tracking scope is stale against the authoritative TMS cursor'
      using errcode = '40001';
  end if;
  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'truth-tracking-scope-receipt-v1',
    'scopeToken', v_scope.scope_token,
    'workspaceKey', v_scope.workspace_key,
    'tmsConnectionKey', v_scope.tms_connection_key,
    'trackingConnectionKey', v_scope.tracking_connection_key,
    'tmsCursorVersion', v_scope.tms_cursor_version,
    'tmsCursorValue', v_scope.tms_cursor_value,
    'expectedAwbs', v_scope.expected_awbs,
    'expectedAwbCount', v_scope.expected_awb_count,
    'expectedAwbsHash', v_scope.expected_awbs_hash,
    'issuedBy', v_scope.issued_by,
    'issuedAt', v_scope.issued_at,
    'expiresAt', v_scope.expires_at
  );
end;
$function$;

create or replace function public.guard_tracking_scope_manifest_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope public.truth_tracking_scopes%rowtype;
  v_cursor public.source_cursors%rowtype;
begin
  if new.source_system <> 'tracking' then
    return new;
  end if;
  if coalesce(new.provider_manifest->>'scopeToken', '') !~ '^tracking-scope:v1:[0-9a-f]{64}$' then
    raise exception 'tracking source manifest requires a server-issued scope token'
      using errcode = '23514';
  end if;
  select * into v_scope
  from public.truth_tracking_scopes scope
  where scope.scope_token = new.provider_manifest->>'scopeToken'
    and scope.workspace_key = new.workspace_key
    and scope.tracking_connection_key = new.connection_key;
  if not found or v_scope.expires_at <= clock_timestamp()
    or new.provider_manifest->'expectedAwbs' is distinct from v_scope.expected_awbs then
    raise exception 'tracking source manifest scope token is missing, expired, or altered'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.truth_tracking_scope_bindings binding
    where binding.scope_token = v_scope.scope_token
  ) then
    raise exception 'tracking source scope token was already used'
      using errcode = '23505';
  end if;
  -- Serialize the manifest bind against a concurrent TMS cursor advance. If
  -- TMS advances afterward, this tracking commit is ordered before it; if TMS
  -- owns the row first, this statement observes the new cursor and rejects.
  select * into v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = v_scope.workspace_key
    and cursor_row.source_system = 'tms'
    and cursor_row.connection_key = v_scope.tms_connection_key
  for share;
  if not found or v_cursor.status <> 'live'
    or v_cursor.cursor_version is distinct from v_scope.tms_cursor_version
    or v_cursor.cursor_value is distinct from v_scope.tms_cursor_value then
    raise exception 'tracking source scope is stale against the TMS cursor'
      using errcode = '40001';
  end if;
  insert into public.truth_tracking_scope_bindings (
    scope_token, batch_id, workspace_key, source_system,
    tracking_connection_key
  ) values (
    v_scope.scope_token, new.batch_id, new.workspace_key, 'tracking',
    new.connection_key
  );
  return new;
end;
$function$;

drop trigger if exists source_ingest_manifest_tracking_scope_guard
  on public.source_ingest_manifests;
create trigger source_ingest_manifest_tracking_scope_guard
before insert on public.source_ingest_manifests
for each row execute function public.guard_tracking_scope_manifest_insert();

create or replace function public.issue_truth_tracking_scope(
  p_workspace_key text,
  p_ttl_seconds integer,
  p_issued_by text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.issue_truth_tracking_scope(
    p_workspace_key, p_ttl_seconds, p_issued_by, p_sync_token
  );
$function$;

create or replace function public.read_truth_tracking_scope(
  p_workspace_key text,
  p_scope_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.read_truth_tracking_scope(
    p_workspace_key, p_scope_token, p_sync_token
  );
$function$;

alter table public.truth_tracking_scopes enable row level security;
alter table public.truth_tracking_scopes force row level security;
alter table public.truth_tracking_scope_bindings enable row level security;
alter table public.truth_tracking_scope_bindings force row level security;

drop trigger if exists truth_tracking_scopes_immutable
  on public.truth_tracking_scopes;
create trigger truth_tracking_scopes_immutable
before update or delete on public.truth_tracking_scopes
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists truth_tracking_scope_bindings_immutable
  on public.truth_tracking_scope_bindings;
create trigger truth_tracking_scope_bindings_immutable
before update or delete on public.truth_tracking_scope_bindings
for each row execute function public.reject_immutable_truth_mutation();

revoke all on table public.truth_tracking_scopes from public, anon, authenticated;
revoke all on table public.truth_tracking_scope_bindings from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.truth_tracking_scopes from service_role;
revoke insert, update, delete, truncate on table public.truth_tracking_scope_bindings from service_role;
grant select on table public.truth_tracking_scopes to service_role;
grant select on table public.truth_tracking_scope_bindings to service_role;

revoke all on function private.issue_truth_tracking_scope(text, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_tracking_scope(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.guard_tracking_scope_manifest_insert()
  from public, anon, authenticated, service_role;
revoke all on function public.issue_truth_tracking_scope(text, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.read_truth_tracking_scope(text, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_truth_tracking_scope(text, integer, text, text)
  to service_role;
grant execute on function public.read_truth_tracking_scope(text, text, text)
  to service_role;
