-- Extend the bounded relational truth audit witness with the immutable
-- shipment-metadata envelopes cited by its target builds. Keep this as a
-- follow-on wrapper so the original audit runtime remains timestamp-order
-- installable before the shipment-metadata relation exists.

set check_function_bodies = off;

do $block$
begin
  if to_regprocedure(
    'private.read_truth_audit_snapshot_core(text,integer,text)'
  ) is null then
    alter function private.read_truth_audit_snapshot(text, integer, text)
      rename to read_truth_audit_snapshot_core;
  end if;
end
$block$;

create or replace function private.read_truth_audit_snapshot(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '25s'
as $function$
declare
  v_snapshot jsonb;
  v_envelopes jsonb := '[]'::jsonb;
  v_envelope_count bigint := 0;
  v_truncated boolean := false;
begin
  -- Authentication, request validation, target-cut selection, and all
  -- existing bounds remain owned by the reviewed core implementation.
  v_snapshot := private.read_truth_audit_snapshot_core(
    p_workspace_key, p_row_limit, p_sync_token
  );

  with target_build_ids as (
    select (build_row.value->>'build_id')::uuid as build_id
    from jsonb_array_elements(
      coalesce(v_snapshot->'canonical'->'builds', '[]'::jsonb)
    ) build_row
  ), metadata_base as (
    select envelope.*
    from public.truth_shipment_metadata_envelopes envelope
    where envelope.workspace_key = p_workspace_key
      and exists (
        select 1
        from public.truth_build_inputs input
        join target_build_ids target_build
          on target_build.build_id = input.build_id
        where input.item_kind = 'shipment_metadata'
          and input.item_id = envelope.metadata_version_id
          and input.item_hash = envelope.envelope_hash
      )
  ), bounded_metadata as (
    select *
    from metadata_base
    order by shipment_key, metadata_version_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from metadata_base),
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(row_value)
          order by row_value.shipment_key, row_value.metadata_version_id
        )
        from bounded_metadata row_value
      ),
      '[]'::jsonb
    )
  into v_envelope_count, v_envelopes;

  v_truncated := coalesce(
    (v_snapshot #>> '{bounds,truncated}')::boolean,
    false
  ) or v_envelope_count > p_row_limit;

  v_snapshot := jsonb_set(
    v_snapshot,
    '{canonical,shipmentMetadataEnvelopes}',
    v_envelopes,
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,counts,shipmentMetadataEnvelopes}',
    to_jsonb(v_envelope_count),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,truncated}',
    to_jsonb(v_truncated),
    true
  );
  return v_snapshot;
end;
$function$;

-- The public bridge remains owned by the narrow no-login RPC role and still
-- calls this original private signature. The renamed core is executable only
-- through the security-definer wrapper above.
revoke all on function private.read_truth_audit_snapshot_core(text, integer, text)
  from public, anon, authenticated, service_role, truth_audit_rpc_owner;
revoke all on function private.read_truth_audit_snapshot(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function private.read_truth_audit_snapshot(text, integer, text)
  to truth_audit_rpc_owner;

set check_function_bodies = on;
