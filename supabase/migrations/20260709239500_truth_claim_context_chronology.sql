-- Accepted-claim worker context must expose the immutable source and claim
-- clocks needed to decide whether a contradictory message is strictly newer.
-- This forward wrapper preserves the complete 33000 readiness/bounds query,
-- then enriches only claim IDs already admitted by that exact bounded receipt.

create or replace function private.load_truth_claim_worker_context_chronology(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_max_items integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receipt jsonb;
  v_claims jsonb;
  v_core jsonb;
begin
  -- The original loader remains authoritative for authentication, live lease,
  -- link-before-claim readiness, journal cutoff, workspace scope, workgroup
  -- membership, collection bounds, and accepted-claim eligibility.
  v_receipt := private.load_truth_claim_worker_context(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    p_max_items,
    p_sync_token
  );

  if v_receipt->>'schemaVersion' <> 'truth-claim-worker-context-receipt-v1'
    or jsonb_typeof(coalesce(v_receipt->'acceptedClaims', 'null'::jsonb)) <> 'array'
    or coalesce((v_receipt->'contextBound'->>'acceptedClaimCount')::integer, -1)
      <> jsonb_array_length(v_receipt->'acceptedClaims') then
    raise exception 'base truth-claim context receipt is invalid' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(
    returned.item || jsonb_build_object(
      'occurredAt', case when claim.occurred_at is null then null
        else private.truth_worker_canonical_millis(claim.occurred_at) end,
      'capturedAt', private.truth_worker_canonical_millis(claim.captured_at),
      'sourceRecordedAt', case when observation.source_recorded_at is null then null
        else private.truth_worker_canonical_millis(observation.source_recorded_at) end
    )
    order by returned.ordinality
  ), '[]'::jsonb)
  into v_claims
  from jsonb_array_elements(v_receipt->'acceptedClaims')
    with ordinality returned(item, ordinality)
  join public.accepted_claims claim
    on claim.claim_version_id = returned.item->>'claimVersionId'
   and claim.claim_content_hash = returned.item->>'itemHash'
   and claim.claim_key = returned.item->>'claimKey'
   and claim.version_no = (returned.item->>'versionNo')::integer
  join public.accepted_claim_envelopes envelope
    on envelope.claim_version_id = claim.claim_version_id
   and envelope.workspace_key = p_workspace_key
   and envelope.envelope_hash = claim.claim_content_hash
  join public.source_observations observation
    on observation.observation_id = claim.primary_observation_id
   and observation.workspace_key = p_workspace_key
  where claim.captured_at = observation.captured_at;

  if jsonb_array_length(v_claims) <> jsonb_array_length(v_receipt->'acceptedClaims') then
    raise exception 'accepted-claim chronology escaped or truncated bounded context'
      using errcode = '23514';
  end if;

  v_core := (v_receipt - 'ok' - 'contextHash') || jsonb_build_object(
    'schemaVersion', 'truth-claim-worker-context-receipt-v2',
    'acceptedClaims', v_claims
  );
  return v_core || jsonb_build_object(
    'ok', true,
    'contextHash', private.truth_worker_context_hash(v_core)
  );
end;
$function$;

create or replace function public.load_truth_claim_worker_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_max_items integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.load_truth_claim_worker_context_chronology(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    p_max_items,
    p_sync_token
  );
$function$;

revoke all on function private.load_truth_claim_worker_context_chronology(
  text, uuid, text, bigint, text, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.load_truth_claim_worker_context(
  text, uuid, text, bigint, text, integer, text
) from public, anon, authenticated;
grant execute on function public.load_truth_claim_worker_context(
  text, uuid, text, bigint, text, integer, text
) to service_role;
