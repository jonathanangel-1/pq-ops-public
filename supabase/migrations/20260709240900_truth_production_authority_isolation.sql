-- Production truth publication authority and post-claim workspace isolation.
--
-- The normal truth sync credential is deliberately insufficient for a
-- production publication. Production needs a separately issued, expiring,
-- one-time capability that is bound to the exact head transition. Shadow
-- workers receive neither the issuer credential nor the one-time capability.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

-- Composite authorities used by the approval record. They also prevent a
-- workspace-bearing approval from pointing at a build/publication in another
-- workspace.
create unique index if not exists truth_build_pair_runs_workspace_authority_uidx
  on public.truth_build_pair_runs (
    workspace_key,
    build_pair_id,
    source_cut_id,
    full_build_id
  );

create unique index if not exists truth_publications_workspace_authority_uidx
  on public.truth_publications (
    workspace_key,
    publication_id,
    source_cut_id,
    build_id
  );

create unique index if not exists truth_publications_workspace_identity_uidx
  on public.truth_publications (workspace_key, publication_id);

create table if not exists public.truth_production_publication_approvals (
  approval_id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  operation text not null
    check (operation = any (array['build_pair_publish', 'rollback_forward'])),
  build_pair_id uuid,
  target_publication_id uuid,
  source_cut_id text not null,
  build_id uuid not null,
  approval_request_key text not null,
  approval_request_hash text not null check (approval_request_hash ~ '^[0-9a-f]{64}$'),
  publication_request_key text not null,
  expected_head_version bigint not null check (expected_head_version >= 0),
  expected_head_packet_hash text not null
    check (expected_head_packet_hash ~ '^(|[0-9a-f]{64})$'),
  publication_reason text not null
    check (publication_reason = any (array['normal', 'repair', 'rollback'])),
  publisher_version text not null,
  published_by text not null,
  approved_by text not null,
  approval_reason text not null,
  approval_credential_hash text not null
    check (approval_credential_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'issued'
    check (status = any (array['issued', 'consumed'])),
  expires_at timestamptz not null,
  issued_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  consumed_publication_id uuid,
  unique (workspace_key, approval_request_key),
  foreign key (workspace_key)
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  foreign key (workspace_key, build_pair_id, source_cut_id, build_id)
    references public.truth_build_pair_runs(
      workspace_key, build_pair_id, source_cut_id, full_build_id
    ) on update restrict on delete restrict,
  foreign key (workspace_key, target_publication_id, source_cut_id, build_id)
    references public.truth_publications(
      workspace_key, publication_id, source_cut_id, build_id
    ) on update restrict on delete restrict,
  foreign key (workspace_key, consumed_publication_id)
    references public.truth_publications(workspace_key, publication_id)
    on update restrict on delete restrict,
  check (
    (operation = 'build_pair_publish'
      and build_pair_id is not null
      and target_publication_id is null
      and publication_reason = any (array['normal', 'repair']))
    or
    (operation = 'rollback_forward'
      and build_pair_id is null
      and target_publication_id is not null
      and publication_reason = 'rollback')
  ),
  check (
    (status = 'issued'
      and consumed_at is null
      and consumed_publication_id is null)
    or
    (status = 'consumed'
      and consumed_at is not null
      and consumed_publication_id is not null)
  ),
  check (expires_at > issued_at),
  check (expires_at <= issued_at + interval '15 minutes')
);

create index if not exists truth_production_approvals_target_idx
  on public.truth_production_publication_approvals (
    workspace_key,
    operation,
    build_pair_id,
    target_publication_id,
    status,
    expires_at
  );

create or replace function private.guard_truth_production_approval_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth production approvals are append-only'
      using errcode = '55000';
  end if;
  if old.status <> 'issued' or new.status <> 'consumed' then
    raise exception 'truth production approval has an invalid transition'
      using errcode = '55000';
  end if;
  if row(
    new.approval_id,
    new.workspace_key,
    new.operation,
    new.build_pair_id,
    new.target_publication_id,
    new.source_cut_id,
    new.build_id,
    new.approval_request_key,
    new.approval_request_hash,
    new.publication_request_key,
    new.expected_head_version,
    new.expected_head_packet_hash,
    new.publication_reason,
    new.publisher_version,
    new.published_by,
    new.approved_by,
    new.approval_reason,
    new.approval_credential_hash,
    new.expires_at,
    new.issued_at
  ) is distinct from row(
    old.approval_id,
    old.workspace_key,
    old.operation,
    old.build_pair_id,
    old.target_publication_id,
    old.source_cut_id,
    old.build_id,
    old.approval_request_key,
    old.approval_request_hash,
    old.publication_request_key,
    old.expected_head_version,
    old.expected_head_packet_hash,
    old.publication_reason,
    old.publisher_version,
    old.published_by,
    old.approved_by,
    old.approval_reason,
    old.approval_credential_hash,
    old.expires_at,
    old.issued_at
  ) or new.consumed_at is null or new.consumed_publication_id is null then
    raise exception 'truth production approval immutable fields changed'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_production_approval_guard
  on public.truth_production_publication_approvals;
create trigger truth_production_approval_guard
before update or delete on public.truth_production_publication_approvals
for each row execute function private.guard_truth_production_approval_transition();

alter table public.truth_production_publication_approvals enable row level security;
alter table public.truth_production_publication_approvals force row level security;
revoke all on table public.truth_production_publication_approvals
  from public, anon, authenticated, service_role;

create or replace function private.valid_truth_production_approval_issuer_token(
  p_issuer_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select length(coalesce(p_issuer_token, '')) between 32 and 4096
    and exists (
      select 1
      from public.sync_tokens token
      where token.token_name = 'truth_production_approval_issuer'
        and token.token_hash = encode(
          extensions.digest(convert_to(p_issuer_token, 'UTF8'), 'sha256'),
          'hex'
        )
    );
$function$;

create or replace function private.truth_production_approval_receipt(
  p_approval_id uuid,
  p_idempotent boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'idempotent', p_idempotent,
    'approvalId', approval.approval_id,
    'workspaceKey', approval.workspace_key,
    'operation', approval.operation,
    'buildPairId', approval.build_pair_id,
    'targetPublicationId', approval.target_publication_id,
    'sourceCutId', approval.source_cut_id,
    'buildId', approval.build_id,
    'publicationRequestKey', approval.publication_request_key,
    'expectedHeadVersion', approval.expected_head_version,
    'expectedHeadPacketHash', approval.expected_head_packet_hash,
    'publicationReason', approval.publication_reason,
    'publisherVersion', approval.publisher_version,
    'publishedBy', approval.published_by,
    'approvedBy', approval.approved_by,
    'approvalReason', approval.approval_reason,
    'status', approval.status,
    'expiresAt', approval.expires_at,
    'issuedAt', approval.issued_at,
    'consumedAt', approval.consumed_at,
    'consumedPublicationId', approval.consumed_publication_id
  ))
  from public.truth_production_publication_approvals approval
  where approval.approval_id = p_approval_id;
$function$;

create or replace function private.require_active_truth_workspace(
  p_workspace_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_status text;
begin
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null then
    raise exception 'truth workspace identity is invalid'
      using errcode = '22023';
  end if;
  -- Keep a share lock through the caller transaction. FOR KEY SHARE would not
  -- conflict with the FOR NO KEY UPDATE lock used by a status-only UPDATE.
  -- FOR SHARE makes disable/revocation serialize after this operation.
  select workspace.status into v_status
  from public.truth_workspaces workspace
  where workspace.workspace_key = p_workspace_key
  for share;
  if not found then
    raise exception 'truth workspace is unavailable'
      using errcode = '23503';
  end if;
  if v_status is distinct from 'active' then
    raise exception 'truth workspace is disabled'
      using errcode = '42501';
  end if;
end;
$function$;

create or replace function private.require_truth_build_pair_workspace(
  p_workspace_key text,
  p_build_pair_id uuid
)
returns public.truth_build_pair_runs
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
begin
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_build_pair_id is null then
    raise exception 'truth build pair workspace binding is invalid'
      using errcode = '22023';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.workspace_key = p_workspace_key
    and pair.build_pair_id = p_build_pair_id;
  if not found then
    raise exception 'truth build pair is unavailable in the requested workspace'
      using errcode = '23503';
  end if;
  return v_pair;
end;
$function$;

create or replace function private.issue_truth_production_publication_approval(
  p_workspace_key text,
  p_operation text,
  p_build_pair_id uuid,
  p_target_publication_id uuid,
  p_approval_request_key text,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_approved_by text,
  p_approval_reason text,
  p_expires_at timestamptz,
  p_approval_credential text,
  p_issuer_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_pair public.truth_build_pair_runs%rowtype;
  v_target public.truth_publications%rowtype;
  v_head public.truth_publication_heads%rowtype;
  v_existing public.truth_production_publication_approvals%rowtype;
  v_approval_id uuid := gen_random_uuid();
  v_source_cut_id text;
  v_build_id uuid;
  v_request_hash text;
  v_credential_hash text;
begin
  if not private.valid_truth_production_approval_issuer_token(p_issuer_token) then
    raise exception 'invalid production approval issuer token'
      using errcode = '28000';
  end if;
  if p_operation is null
    or not (p_operation = any (array['build_pair_publish', 'rollback_forward']))
    or nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_approval_request_key, '')), '') is null
    or nullif(trim(coalesce(p_publication_request_key, '')), '') is null
    or nullif(trim(coalesce(p_publisher_version, '')), '') is null
    or nullif(trim(coalesce(p_published_by, '')), '') is null
    or nullif(trim(coalesce(p_approved_by, '')), '') is null
    or nullif(trim(coalesce(p_approval_reason, '')), '') is null
    or p_expected_head_version is null or p_expected_head_version < 0
    or coalesce(p_expected_head_packet_hash, '') !~ '^(|[0-9a-f]{64})$'
    or p_expires_at is null
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '15 minutes'
    or length(coalesce(p_approval_credential, '')) < 32
    or length(coalesce(p_approval_credential, '')) > 4096 then
    raise exception 'production approval request is invalid'
      using errcode = '22023';
  end if;
  if octet_length(p_workspace_key) > 128
    or octet_length(p_approval_request_key) > 500
    or octet_length(p_publication_request_key) > 500
    or octet_length(p_publisher_version) > 500
    or octet_length(p_published_by) > 500
    or octet_length(p_approved_by) > 500
    or octet_length(p_approval_reason) > 2000 then
    raise exception 'production approval field is too long'
      using errcode = '22023';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);

  if p_operation = 'build_pair_publish' then
    if p_build_pair_id is null or p_target_publication_id is not null
      or p_publication_reason is null
      or not (p_publication_reason = any (array['normal', 'repair'])) then
      raise exception 'build-pair production approval target is invalid'
        using errcode = '22023';
    end if;
    select pair.* into v_pair
    from public.truth_build_pair_runs pair
    where pair.workspace_key = p_workspace_key
      and pair.build_pair_id = p_build_pair_id
      and pair.publication_channel = 'production'
      and pair.build_channel = 'candidate'
      and pair.status = 'succeeded'
      and exists (
        select 1
        from public.truth_build_parity_receipts parity
        where parity.build_pair_id = pair.build_pair_id
          and parity.exact_payload_equal
          and parity.citation_integrity_ok
          and parity.source_cut_integrity_ok
      );
    if not found then
      raise exception 'production approval build pair is unavailable'
        using errcode = '23503';
    end if;
    v_source_cut_id := v_pair.source_cut_id;
    v_build_id := v_pair.full_build_id;
  else
    if p_build_pair_id is not null or p_target_publication_id is null
      or p_publication_reason is distinct from 'rollback' then
      raise exception 'rollback production approval target is invalid'
        using errcode = '22023';
    end if;
    select publication.* into v_target
    from public.truth_publications publication
    where publication.workspace_key = p_workspace_key
      and publication.channel = 'production'
      and publication.publication_id = p_target_publication_id;
    if not found then
      raise exception 'production rollback target is unavailable'
        using errcode = '23503';
    end if;
    if v_target.publication_version >= p_expected_head_version then
      raise exception 'production rollback target must precede the expected head'
        using errcode = '23514';
    end if;
    v_source_cut_id := v_target.source_cut_id;
    v_build_id := v_target.build_id;
  end if;

  select head.* into v_head
  from public.truth_publication_heads head
  where head.workspace_key = p_workspace_key
    and head.channel = 'production';
  if found then
    if v_head.publication_version is distinct from p_expected_head_version
      or v_head.packet_hash is distinct from coalesce(p_expected_head_packet_hash, '') then
      raise exception 'production approval expected head is stale'
        using errcode = '40001';
    end if;
  elsif p_expected_head_version <> 0
    or coalesce(p_expected_head_packet_hash, '') <> '' then
    raise exception 'production approval expected head is stale'
      using errcode = '40001';
  end if;

  v_credential_hash := encode(extensions.digest(
    convert_to(p_approval_credential, 'UTF8'),
    'sha256'
  ), 'hex');
  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-production-approval-request-v1',
    'workspaceKey', p_workspace_key,
    'operation', p_operation,
    'buildPairId', p_build_pair_id,
    'targetPublicationId', p_target_publication_id,
    'sourceCutId', v_source_cut_id,
    'buildId', v_build_id,
    'publicationRequestKey', p_publication_request_key,
    'expectedHeadVersion', p_expected_head_version,
    'expectedHeadPacketHash', coalesce(p_expected_head_packet_hash, ''),
    'publicationReason', p_publication_reason,
    'publisherVersion', p_publisher_version,
    'publishedBy', p_published_by,
    'approvedBy', p_approved_by,
    'approvalReason', p_approval_reason,
    'expiresAt', p_expires_at,
    'approvalCredentialHash', v_credential_hash
  )::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-production-approval:' || p_workspace_key || ':' || p_approval_request_key,
    0
  ));
  select approval.* into v_existing
  from public.truth_production_publication_approvals approval
  where approval.workspace_key = p_workspace_key
    and approval.approval_request_key = p_approval_request_key;
  if found then
    if v_existing.approval_request_hash is distinct from v_request_hash then
      raise exception 'production approval idempotency key has conflicting request content'
        using errcode = '23505';
    end if;
    return private.truth_production_approval_receipt(
      v_existing.approval_id,
      true
    );
  end if;

  insert into public.truth_production_publication_approvals (
    approval_id,
    workspace_key,
    operation,
    build_pair_id,
    target_publication_id,
    source_cut_id,
    build_id,
    approval_request_key,
    approval_request_hash,
    publication_request_key,
    expected_head_version,
    expected_head_packet_hash,
    publication_reason,
    publisher_version,
    published_by,
    approved_by,
    approval_reason,
    approval_credential_hash,
    status,
    expires_at,
    issued_at
  ) values (
    v_approval_id,
    p_workspace_key,
    p_operation,
    p_build_pair_id,
    p_target_publication_id,
    v_source_cut_id,
    v_build_id,
    p_approval_request_key,
    v_request_hash,
    p_publication_request_key,
    p_expected_head_version,
    coalesce(p_expected_head_packet_hash, ''),
    p_publication_reason,
    p_publisher_version,
    p_published_by,
    p_approved_by,
    p_approval_reason,
    v_credential_hash,
    'issued',
    p_expires_at,
    v_now
  );
  return private.truth_production_approval_receipt(v_approval_id, false);
end;
$function$;

create or replace function private.lock_truth_production_publication_approval(
  p_approval_id uuid,
  p_approval_credential text,
  p_workspace_key text,
  p_operation text,
  p_build_pair_id uuid,
  p_target_publication_id uuid,
  p_source_cut_id text,
  p_build_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text
)
returns public.truth_production_publication_approvals
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_approval public.truth_production_publication_approvals%rowtype;
  v_credential_hash text;
begin
  if p_approval_id is null
    or length(coalesce(p_approval_credential, '')) < 32
    or length(coalesce(p_approval_credential, '')) > 4096 then
    raise exception 'production publication approval is required'
      using errcode = '42501';
  end if;
  v_credential_hash := encode(extensions.digest(
    convert_to(p_approval_credential, 'UTF8'),
    'sha256'
  ), 'hex');
  select approval.* into v_approval
  from public.truth_production_publication_approvals approval
  where approval.approval_id = p_approval_id
    and approval.workspace_key = p_workspace_key
  for update;
  if not found
    or v_approval.approval_credential_hash is distinct from v_credential_hash then
    raise exception 'production publication approval is invalid'
      using errcode = '42501';
  end if;
  if v_approval.operation is distinct from p_operation
    or v_approval.build_pair_id is distinct from p_build_pair_id
    or v_approval.target_publication_id is distinct from p_target_publication_id
    or v_approval.source_cut_id is distinct from p_source_cut_id
    or v_approval.build_id is distinct from p_build_id
    or v_approval.publication_request_key is distinct from p_publication_request_key
    or v_approval.expected_head_version is distinct from p_expected_head_version
    or v_approval.expected_head_packet_hash is distinct from
      coalesce(p_expected_head_packet_hash, '')
    or v_approval.publication_reason is distinct from p_publication_reason
    or v_approval.publisher_version is distinct from p_publisher_version
    or v_approval.published_by is distinct from p_published_by then
    raise exception 'production publication approval binding does not match request'
      using errcode = '42501';
  end if;
  if v_approval.status = 'issued' and v_approval.expires_at <= clock_timestamp() then
    raise exception 'production publication approval expired'
      using errcode = '42501';
  end if;
  return v_approval;
end;
$function$;

create or replace function private.consume_truth_production_approval(
  p_approval_id uuid,
  p_publication_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.truth_production_publication_approvals approval
  set status = 'consumed',
      consumed_at = clock_timestamp(),
      consumed_publication_id = p_publication_id
  where approval.approval_id = p_approval_id
    and approval.status = 'issued';
  if not found then
    raise exception 'production publication approval consumption was fenced'
      using errcode = '40001';
  end if;
end;
$function$;

create or replace function private.consumed_truth_production_publication_receipt(
  p_approval public.truth_production_publication_approvals
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_approval.status <> 'consumed'
    or p_approval.consumed_publication_id is null
    or not exists (
      select 1
      from public.truth_publication_requests request
      join public.truth_publications publication
        on publication.publication_id = request.publication_id
      where request.workspace_key = p_approval.workspace_key
        and request.channel = 'production'
        and request.publication_request_key = p_approval.publication_request_key
        and request.publication_id = p_approval.consumed_publication_id
        and publication.workspace_key = p_approval.workspace_key
        and publication.source_cut_id = p_approval.source_cut_id
        and publication.build_id = p_approval.build_id
        and publication.publication_reason = p_approval.publication_reason
        and publication.publisher_version = p_approval.publisher_version
        and publication.published_by = p_approval.published_by
        and publication.publication_version = p_approval.expected_head_version + 1
        and (
          (
            p_approval.expected_head_version = 0
            and p_approval.expected_head_packet_hash = ''
            and publication.previous_publication_id is null
          )
          or
          (
            p_approval.expected_head_version > 0
            and exists (
              select 1
              from public.truth_publications previous
              where previous.publication_id = publication.previous_publication_id
                and previous.workspace_key = p_approval.workspace_key
                and previous.channel = 'production'
                and previous.publication_version = p_approval.expected_head_version
                and previous.packet_hash = p_approval.expected_head_packet_hash
            )
          )
        )
    ) then
    raise exception 'consumed production approval receipt is inconsistent'
      using errcode = '23514';
  end if;
  return private.truth_publication_runtime_receipt(
    p_approval.consumed_publication_id,
    true
  );
end;
$function$;

create or replace function private.publish_truth_build_pair_runtime_cas_authorized(
  p_workspace_key text,
  p_build_pair_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_production_approval_id uuid,
  p_production_approval_credential text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_build public.truth_builds%rowtype;
  v_approval public.truth_production_publication_approvals%rowtype;
  v_receipt jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_pair := private.require_truth_build_pair_workspace(
    p_workspace_key,
    p_build_pair_id
  );
  if v_pair.status <> 'succeeded'
    or not exists (
      select 1
      from public.truth_build_parity_receipts parity
      where parity.build_pair_id = v_pair.build_pair_id
        and parity.exact_payload_equal
        and parity.citation_integrity_ok
        and parity.source_cut_integrity_ok
    ) then
    raise exception 'truth build pair lacks successful exact parity proof'
      using errcode = '23514';
  end if;
  if p_publication_reason is null
    or not (p_publication_reason = any (array['normal', 'repair'])) then
    raise exception 'build-pair publication reason must be normal or repair'
      using errcode = '22023';
  end if;
  select build.* into v_build
  from public.truth_builds build
  where build.workspace_key = p_workspace_key
    and build.build_id = v_pair.full_build_id
    and build.status = 'succeeded';
  if not found
    or v_build.packet_hash is distinct from v_pair.packet_hash
    or v_build.packet_payload is null then
    raise exception 'truth build pair full output is unavailable'
      using errcode = '23514';
  end if;

  if v_pair.publication_channel = 'production' then
    v_approval := private.lock_truth_production_publication_approval(
      p_production_approval_id,
      p_production_approval_credential,
      p_workspace_key,
      'build_pair_publish',
      v_pair.build_pair_id,
      null,
      v_pair.source_cut_id,
      v_build.build_id,
      p_publication_request_key,
      p_expected_head_version,
      p_expected_head_packet_hash,
      p_publication_reason,
      p_publisher_version,
      p_published_by
    );
    if v_approval.status = 'consumed' then
      return private.consumed_truth_production_publication_receipt(v_approval);
    end if;
    if exists (
      select 1
      from public.truth_publications publication
      where publication.workspace_key = p_workspace_key
        and publication.channel = 'production'
        and publication.build_id = v_build.build_id
    ) then
      raise exception 'production build pair was already published; a fresh approval cannot republish stale output'
        using errcode = '40001';
    end if;
  elsif p_production_approval_id is not null
    or coalesce(p_production_approval_credential, '') <> '' then
    raise exception 'shadow publication cannot consume production authority'
      using errcode = '42501';
  end if;

  v_receipt := private.commit_truth_publication_runtime(
    v_pair.workspace_key,
    v_pair.publication_channel,
    v_build.build_id,
    v_pair.source_cut_id,
    v_build.packet_payload,
    v_pair.packet_hash,
    v_pair.reducer_packet_hash,
    v_pair.semantic_hash,
    p_publication_reason,
    p_publisher_version,
    p_published_by,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_sync_token
  );
  if v_pair.publication_channel = 'production' then
    perform private.consume_truth_production_approval(
      v_approval.approval_id,
      (v_receipt->>'publicationId')::uuid
    );
  end if;
  return v_receipt;
end;
$function$;

create or replace function private.publish_truth_rollback_forward_authorized(
  p_workspace_key text,
  p_channel text,
  p_target_publication_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publisher_version text,
  p_published_by text,
  p_production_approval_id uuid,
  p_production_approval_credential text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target public.truth_publications%rowtype;
  v_target_payload public.truth_publication_payloads%rowtype;
  v_target_build public.truth_builds%rowtype;
  v_approval public.truth_production_publication_approvals%rowtype;
  v_receipt jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if p_channel is null or not (p_channel = any (array['shadow', 'production'])) then
    raise exception 'rollback publication channel is invalid'
      using errcode = '22023';
  end if;
  select publication.* into v_target
  from public.truth_publications publication
  where publication.publication_id = p_target_publication_id
    and publication.workspace_key = p_workspace_key
    and publication.channel = p_channel;
  if not found then
    raise exception 'rollback target publication is unavailable'
      using errcode = '23503';
  end if;
  select payload.* into v_target_payload
  from public.truth_publication_payloads payload
  where payload.workspace_key = p_workspace_key
    and payload.publication_id = v_target.publication_id;
  if not found then
    raise exception 'rollback target delivery payload is unavailable'
      using errcode = '23503';
  end if;
  if v_target.publication_version >= p_expected_head_version then
    raise exception 'rollback target must precede the current head version'
      using errcode = '23514';
  end if;
  select build.* into v_target_build
  from public.truth_builds build
  where build.workspace_key = p_workspace_key
    and build.build_id = v_target.build_id
    and build.status = 'succeeded';
  if not found or v_target_build.packet_payload is null
    or v_target_build.packet_hash is distinct from v_target.packet_hash then
    raise exception 'rollback target build payload is unavailable'
      using errcode = '23514';
  end if;

  if p_channel = 'production' then
    v_approval := private.lock_truth_production_publication_approval(
      p_production_approval_id,
      p_production_approval_credential,
      p_workspace_key,
      'rollback_forward',
      null,
      v_target.publication_id,
      v_target.source_cut_id,
      v_target.build_id,
      p_publication_request_key,
      p_expected_head_version,
      p_expected_head_packet_hash,
      'rollback',
      p_publisher_version,
      p_published_by
    );
    if v_approval.status = 'consumed' then
      return private.consumed_truth_production_publication_receipt(v_approval);
    end if;
  elsif p_production_approval_id is not null
    or coalesce(p_production_approval_credential, '') <> '' then
    raise exception 'shadow rollback cannot consume production authority'
      using errcode = '42501';
  end if;

  v_receipt := private.commit_truth_publication_runtime(
    p_workspace_key,
    p_channel,
    v_target.build_id,
    v_target.source_cut_id,
    v_target_build.packet_payload,
    v_target.packet_hash,
    v_target_payload.reducer_packet_hash,
    v_target.semantic_hash,
    'rollback',
    p_publisher_version,
    p_published_by,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_sync_token
  );
  if p_channel = 'production' then
    perform private.consume_truth_production_approval(
      v_approval.approval_id,
      (v_receipt->>'publicationId')::uuid
    );
  end if;
  return v_receipt;
end;
$function$;

-- Remove every public post-claim pair operation that omitted workspace scope,
-- plus the static-confirmation publication/rollback overloads.
drop function if exists public.renew_truth_build_pair_lease(
  uuid, text, bigint, integer, text
);
drop function if exists public.read_truth_build_bundle(
  uuid, text, bigint, text
);
drop function if exists public.complete_truth_build_pair(
  uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text
);
drop function if exists public.fail_truth_build_pair(
  uuid, text, bigint, text, text, text
);
drop function if exists public.publish_truth_build_pair_runtime_cas(
  uuid, text, bigint, text, text, text, text, text, text
);
drop function if exists public.publish_truth_rollback_forward(
  text, text, uuid, text, bigint, text, text, text, text, text
);
drop function if exists private.publish_truth_build_pair_runtime_cas(
  uuid, text, bigint, text, text, text, text, text, text
);
drop function if exists private.publish_truth_rollback_forward(
  text, text, uuid, text, bigint, text, text, text, text, text
);

create or replace function public.claim_truth_build_pair(
  p_workspace_key text,
  p_source_cut_id text,
  p_build_channel text,
  p_trigger_name text,
  p_idempotency_key text,
  p_worker_id text,
  p_lease_seconds integer,
  p_bundle_row_limit integer,
  p_versions jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  return private.claim_truth_build_pair(
    p_workspace_key,
    p_source_cut_id,
    p_build_channel,
    p_trigger_name,
    p_idempotency_key,
    p_worker_id,
    p_lease_seconds,
    p_bundle_row_limit,
    p_versions,
    p_sync_token
  );
end;
$function$;

create or replace function public.issue_truth_production_publication_approval(
  p_workspace_key text,
  p_operation text,
  p_build_pair_id uuid,
  p_target_publication_id uuid,
  p_approval_request_key text,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_approved_by text,
  p_approval_reason text,
  p_expires_at timestamptz,
  p_approval_credential text,
  p_issuer_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.issue_truth_production_publication_approval(
    p_workspace_key,
    p_operation,
    p_build_pair_id,
    p_target_publication_id,
    p_approval_request_key,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_publication_reason,
    p_publisher_version,
    p_published_by,
    p_approved_by,
    p_approval_reason,
    p_expires_at,
    p_approval_credential,
    p_issuer_token
  );
$function$;

create or replace function public.renew_truth_build_pair_lease(
  p_workspace_key text,
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_lease_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_truth_build_pair_workspace(
    p_workspace_key,
    p_build_pair_id
  );
  return private.renew_truth_build_pair_lease(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence,
    p_lease_seconds,
    p_sync_token
  );
end;
$function$;

create or replace function public.read_truth_build_bundle(
  p_workspace_key text,
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_truth_build_pair_workspace(
    p_workspace_key,
    p_build_pair_id
  );
  return private.read_truth_build_bundle(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence,
    p_sync_token
  );
end;
$function$;

create or replace function public.complete_truth_build_pair(
  p_workspace_key text,
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_full_packet jsonb,
  p_incremental_packet jsonb,
  p_full_semantic_hash text,
  p_incremental_semantic_hash text,
  p_full_validation_report jsonb,
  p_incremental_validation_report jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_truth_build_pair_workspace(
    p_workspace_key,
    p_build_pair_id
  );
  return private.complete_truth_build_pair(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence,
    p_full_packet,
    p_incremental_packet,
    p_full_semantic_hash,
    p_incremental_semantic_hash,
    p_full_validation_report,
    p_incremental_validation_report,
    p_sync_token
  );
end;
$function$;

create or replace function public.fail_truth_build_pair(
  p_workspace_key text,
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_error_code text,
  p_safe_error_detail text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_truth_build_pair_workspace(
    p_workspace_key,
    p_build_pair_id
  );
  return private.fail_truth_build_pair(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence,
    p_error_code,
    p_safe_error_detail,
    p_sync_token
  );
end;
$function$;

create or replace function public.publish_truth_build_pair_runtime_cas(
  p_workspace_key text,
  p_build_pair_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_production_approval_id uuid,
  p_production_approval_credential text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.publish_truth_build_pair_runtime_cas_authorized(
    p_workspace_key,
    p_build_pair_id,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_publication_reason,
    p_publisher_version,
    p_published_by,
    p_production_approval_id,
    p_production_approval_credential,
    p_sync_token
  );
$function$;

create or replace function public.publish_truth_rollback_forward(
  p_workspace_key text,
  p_channel text,
  p_target_publication_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publisher_version text,
  p_published_by text,
  p_production_approval_id uuid,
  p_production_approval_credential text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.publish_truth_rollback_forward_authorized(
    p_workspace_key,
    p_channel,
    p_target_publication_id,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_publisher_version,
    p_published_by,
    p_production_approval_id,
    p_production_approval_credential,
    p_sync_token
  );
$function$;

revoke all on function private.guard_truth_production_approval_transition()
  from public, anon, authenticated, service_role;
revoke all on function private.valid_truth_production_approval_issuer_token(text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_production_approval_receipt(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.require_active_truth_workspace(text)
  from public, anon, authenticated, service_role;
revoke all on function private.require_truth_build_pair_workspace(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.issue_truth_production_publication_approval(
  text, text, uuid, uuid, text, text, bigint, text, text, text, text,
  text, text, timestamptz, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.lock_truth_production_publication_approval(
  uuid, text, text, text, uuid, uuid, text, uuid, text, bigint, text,
  text, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.consume_truth_production_approval(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.consumed_truth_production_publication_receipt(
  public.truth_production_publication_approvals
) from public, anon, authenticated, service_role;
revoke all on function private.publish_truth_build_pair_runtime_cas_authorized(
  text, uuid, text, bigint, text, text, text, text, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.publish_truth_rollback_forward_authorized(
  text, text, uuid, text, bigint, text, text, text, uuid, text, text
) from public, anon, authenticated, service_role;

revoke all on function public.claim_truth_build_pair(
  text, text, text, text, text, text, integer, integer, jsonb, text
) from public, anon, authenticated;
revoke all on function public.issue_truth_production_publication_approval(
  text, text, uuid, uuid, text, text, bigint, text, text, text, text,
  text, text, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.renew_truth_build_pair_lease(
  text, uuid, text, bigint, integer, text
) from public, anon, authenticated;
revoke all on function public.read_truth_build_bundle(
  text, uuid, text, bigint, text
) from public, anon, authenticated;
revoke all on function public.complete_truth_build_pair(
  text, uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public.fail_truth_build_pair(
  text, uuid, text, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.publish_truth_build_pair_runtime_cas(
  text, uuid, text, bigint, text, text, text, text, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.publish_truth_rollback_forward(
  text, text, uuid, text, bigint, text, text, text, uuid, text, text
) from public, anon, authenticated;

grant execute on function public.issue_truth_production_publication_approval(
  text, text, uuid, uuid, text, text, bigint, text, text, text, text,
  text, text, timestamptz, text, text
) to service_role;
grant execute on function public.claim_truth_build_pair(
  text, text, text, text, text, text, integer, integer, jsonb, text
) to service_role;
grant execute on function public.renew_truth_build_pair_lease(
  text, uuid, text, bigint, integer, text
) to service_role;
grant execute on function public.read_truth_build_bundle(
  text, uuid, text, bigint, text
) to service_role;
grant execute on function public.complete_truth_build_pair(
  text, uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.fail_truth_build_pair(
  text, uuid, text, bigint, text, text, text
) to service_role;
grant execute on function public.publish_truth_build_pair_runtime_cas(
  text, uuid, text, bigint, text, text, text, text, uuid, text, text
) to service_role;
grant execute on function public.publish_truth_rollback_forward(
  text, text, uuid, text, bigint, text, text, text, uuid, text, text
) to service_role;

set check_function_bodies = on;
