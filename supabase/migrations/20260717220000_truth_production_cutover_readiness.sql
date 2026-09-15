-- Truth production cutover readiness and proof surface.
-- This migration does not seed or rotate the production approval issuer token.

do $preflight$
begin
  if to_regprocedure(
      'private.commit_truth_publication_runtime(text,text,uuid,text,jsonb,text,text,text,text,text,text,text,bigint,text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_claims_readiness_parking_receipt_valid_v1(public.truth_gmail_backfill_parking_receipts)'
    ) is null then
    raise exception 'truth production cutover readiness prerequisites are missing'
      using errcode = '55000';
  end if;
end;
$preflight$;

-- Preserve the strict production gap gate while recognizing the one certified
-- parked-history boundary. Every other open gap, including the cutover-delta
-- reconciliation gap, remains blocking.
do $rewrite$
declare
  v_signature constant text :=
    'private.commit_truth_publication_runtime(text,text,uuid,text,jsonb,text,text,text,text,text,text,text,bigint,text,text)';
  v_definition text;
  v_old constant text := $old$where gap.workspace_key = p_workspace_key
        and gap.status = 'open'$old$;
  v_new constant text := $new$where gap.workspace_key = p_workspace_key
        and gap.status = 'open'
        and not (
          gap.gap_type = 'PARKED_BACKFILL_HISTORICAL_DRAIN'
          and exists (
            select 1
            from public.truth_gmail_backfill_parking_receipts receipt
            where receipt.workspace_key = gap.workspace_key
              and receipt.connection_key = gap.connection_key
              and receipt.backfill_gap_id = gap.gap_id
              and private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
                receipt
              )
          )
        )$new$;
begin
  select pg_get_functiondef(v_signature::regprocedure) into v_definition;
  if position('truth_gmail_claims_readiness_parking_receipt_valid_v1' in v_definition) = 0 then
    if position(v_old in v_definition) = 0
      or position(v_old in substring(v_definition from position(v_old in v_definition) + length(v_old))) > 0 then
      raise exception 'production publication Gmail gap guard rewrite did not match exactly once'
        using errcode = '55000';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  end if;
  select pg_get_functiondef(v_signature::regprocedure) into v_definition;
  if position('gap.gap_type = ''PARKED_BACKFILL_HISTORICAL_DRAIN''' in v_definition) = 0
    or position('receipt.backfill_gap_id = gap.gap_id' in v_definition) = 0
    or position('receipt.workspace_key = gap.workspace_key' in v_definition) = 0
    or position('receipt.connection_key = gap.connection_key' in v_definition) = 0
    or position('truth_gmail_claims_readiness_parking_receipt_valid_v1' in v_definition) = 0 then
    raise exception 'production publication parked-gap boundary rewrite is incomplete'
      using errcode = '55000';
  end if;
end;
$rewrite$;

create or replace function public.check_truth_production_publication_issuer(
  p_workspace_key text,
  p_issuer_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_production_approval_issuer_token(p_issuer_token) then
    raise exception 'invalid production approval issuer token'
      using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  return jsonb_build_object(
    'ok', true,
    'workspaceKey', p_workspace_key,
    'issuerTokenReady', true,
    'authority', 'truth_production_approval_issuer',
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_truth_production_cutover_receipt(
  p_workspace_key text,
  p_publication_id uuid,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_publication public.truth_publications%rowtype;
  v_payload public.truth_publication_payloads%rowtype;
  v_approval public.truth_production_publication_approvals%rowtype;
  v_packets jsonb;
  v_index jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid truth sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);

  select publication.* into v_publication
  from public.truth_publications publication
  where publication.workspace_key = p_workspace_key
    and publication.publication_id = p_publication_id
    and publication.channel = 'production';
  if not found then
    raise exception 'production publication is unavailable' using errcode = 'P0002';
  end if;

  select payload.* into strict v_payload
  from public.truth_publication_payloads payload
  where payload.workspace_key = p_workspace_key
    and payload.publication_id = p_publication_id
    and payload.channel = 'production';

  select approval.* into strict v_approval
  from public.truth_production_publication_approvals approval
  where approval.workspace_key = p_workspace_key
    and approval.status = 'consumed'
    and approval.consumed_publication_id = p_publication_id
    and approval.operation = 'build_pair_publish';

  select snapshot.payload into v_packets
  from public.app_snapshots snapshot
  where snapshot.snapshot_key = 'shipment-truth-packets';
  select snapshot.payload into v_index
  from public.app_snapshots snapshot
  where snapshot.snapshot_key = 'active-awb-index';

  if v_approval.source_cut_id is distinct from v_publication.source_cut_id
    or v_approval.build_id is distinct from v_publication.build_id
    or v_approval.publication_request_key is distinct from (
      select request.publication_request_key
      from public.truth_publication_requests request
      where request.workspace_key = p_workspace_key
        and request.channel = 'production'
        and request.publication_id = p_publication_id
    )
    or v_packets is distinct from v_payload.delivery_payload
    or v_index is distinct from v_payload.active_index_payload then
    raise exception 'production cutover receipt failed exact read-back verification'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'workspaceKey', p_workspace_key,
    'publicationId', p_publication_id,
    'publicationChannel', 'production',
    'publicationVersion', v_publication.publication_version,
    'sourceCutId', v_publication.source_cut_id,
    'buildId', v_publication.build_id,
    'packetHash', v_publication.packet_hash,
    'approvalId', v_approval.approval_id,
    'approvalConsumed', true,
    'approvalConsumedAt', v_approval.consumed_at,
    'shipmentTruthPacketsMirrored', true,
    'activeAwbIndexMirrored', true,
    'productionPublicationAttempted', true,
    'mutatesOperationalState', false
  );
exception
  when no_data_found or too_many_rows then
    raise exception 'production cutover receipt is incomplete or ambiguous'
      using errcode = '23514';
end;
$function$;

revoke all on function public.check_truth_production_publication_issuer(text, text)
  from public, anon, authenticated;
revoke all on function public.read_truth_production_cutover_receipt(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.check_truth_production_publication_issuer(text, text)
  to service_role;
grant execute on function public.read_truth_production_cutover_receipt(text, uuid, text)
  to service_role;

do $verify$
declare
  v_issuer_def text;
  v_receipt_def text;
  v_commit_def text;
begin
  if to_regprocedure('public.check_truth_production_publication_issuer(text,text)') is null
    or to_regprocedure('public.read_truth_production_cutover_receipt(text,uuid,text)') is null then
    raise exception 'truth production cutover readiness functions are missing';
  end if;
  select pg_get_functiondef('public.check_truth_production_publication_issuer(text,text)'::regprocedure)
    into v_issuer_def;
  select pg_get_functiondef('public.read_truth_production_cutover_receipt(text,uuid,text)'::regprocedure)
    into v_receipt_def;
  select pg_get_functiondef(
    'private.commit_truth_publication_runtime(text,text,uuid,text,jsonb,text,text,text,text,text,text,text,bigint,text,text)'::regprocedure
  ) into v_commit_def;
  if position('valid_truth_production_approval_issuer_token' in v_issuer_def) = 0
    or position('require_active_truth_workspace' in v_issuer_def) = 0
    or position('truth_production_publication_approvals' in v_receipt_def) = 0
    or position('status = ''consumed''' in v_receipt_def) = 0
    or position('shipment-truth-packets' in v_receipt_def) = 0
    or position('active-awb-index' in v_receipt_def) = 0
    or position('gap.gap_type = ''PARKED_BACKFILL_HISTORICAL_DRAIN''' in v_commit_def) = 0
    or position('receipt.backfill_gap_id = gap.gap_id' in v_commit_def) = 0
    or position('truth_gmail_claims_readiness_parking_receipt_valid_v1' in v_commit_def) = 0
    or position('insert into public.sync_tokens' in lower(v_issuer_def || v_receipt_def)) > 0 then
    raise exception 'truth production cutover readiness rewrite is incomplete';
  end if;
  if has_function_privilege('anon', 'public.check_truth_production_publication_issuer(text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.check_truth_production_publication_issuer(text,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.read_truth_production_cutover_receipt(text,uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.read_truth_production_cutover_receipt(text,uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.check_truth_production_publication_issuer(text,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.read_truth_production_cutover_receipt(text,uuid,text)', 'EXECUTE') then
    raise exception 'truth production cutover readiness grants are unsafe';
  end if;
end;
$verify$;
