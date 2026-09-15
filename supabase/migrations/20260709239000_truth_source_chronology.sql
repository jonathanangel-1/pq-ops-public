-- Provider chronology must survive delayed and out-of-order source processing.
-- `captured_at` remains the immutable Pikiio ingest clock. Accepted claims with
-- no explicit real-world event timestamp use their primary observation's
-- source clock, falling back to capture time only when the source supplied no
-- timestamp at all. The original validating append function remains the core;
-- this wrapper is the sole service-role ingress and cannot weaken its checks.

create or replace function private.append_accepted_claim_source_chronology(
  p_workspace_key text,
  p_claim jsonb,
  p_evidence jsonb,
  p_supersessions jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claim jsonb := p_claim;
  v_primary_observation public.source_observations%rowtype;
  v_parent_observation public.source_observations%rowtype;
  v_source_recorded_at timestamptz;
  v_source_capture_at timestamptz;
  v_effective_occurred_at timestamptz;
begin
  -- Authenticate before resolving an observation so invalid callers cannot use
  -- this function as a source-observation existence oracle.
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  if jsonb_typeof(coalesce(p_claim, 'null'::jsonb)) = 'object'
    and nullif(trim(coalesce(p_claim->>'occurredAt', '')), '') is null
    and nullif(trim(coalesce(p_claim->>'primaryObservationId', '')), '') is not null
    and nullif(trim(coalesce(p_workspace_key, '')), '') is not null then
    select observation.*
    into v_primary_observation
    from public.source_observations observation
    where observation.observation_id = p_claim->>'primaryObservationId'
      and observation.workspace_key = p_workspace_key;

    if found then
      v_source_recorded_at := v_primary_observation.source_recorded_at;
      v_source_capture_at := v_primary_observation.captured_at;
      -- Extracted attachments are a derived observation whose immutable raw
      -- attachment parent carries the Gmail message clock. Preserve that
      -- lineage instead of treating document-extractor completion as event
      -- time.
      if v_source_recorded_at is null
        and v_primary_observation.source_system = 'gmail'
        and v_primary_observation.source_object_type = 'gmail_attachment_extracted'
        and nullif(trim(coalesce(
          v_primary_observation.normalized_payload->>'parentObservationId', ''
        )), '') is not null then
        select parent.*
        into v_parent_observation
        from public.source_observations parent
        where parent.observation_id =
            v_primary_observation.normalized_payload->>'parentObservationId'
          and parent.workspace_key = v_primary_observation.workspace_key
          and parent.source_system = 'gmail'
          and parent.connection_key = v_primary_observation.connection_key
          and parent.source_object_type = 'gmail_attachment'
          and parent.source_object_id = v_primary_observation.source_object_id;
        if found then
          v_source_recorded_at := v_parent_observation.source_recorded_at;
          v_source_capture_at := v_parent_observation.captured_at;
        end if;
      end if;

      -- Gmail internalDate is provider-owned but may still be malformed on API
      -- imports. Never let a timestamp more than one day beyond Pikiio capture
      -- become the effective event chronology.
      if v_primary_observation.source_system = 'gmail'
        and v_source_recorded_at is not null
        and v_source_recorded_at
          > v_source_capture_at + interval '24 hours' then
        raise exception 'Gmail source chronology is impossibly ahead of capture time'
          using errcode = '22008';
      end if;

      v_effective_occurred_at := coalesce(
        v_source_recorded_at,
        v_primary_observation.captured_at
      );
      v_claim := jsonb_set(
        p_claim,
        array['occurredAt'],
        to_jsonb(private.canonical_truth_timestamp(v_effective_occurred_at)),
        true
      );
    end if;
  end if;

  return private.append_accepted_claim(
    p_workspace_key,
    v_claim,
    p_evidence,
    p_supersessions,
    p_sync_token
  );
end;
$function$;

create or replace function public.append_accepted_claim(
  p_workspace_key text,
  p_claim jsonb,
  p_evidence jsonb,
  p_supersessions jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.append_accepted_claim_source_chronology(
    p_workspace_key,
    p_claim,
    p_evidence,
    p_supersessions,
    p_sync_token
  );
$function$;

-- Prevent service code from bypassing the chronology wrapper while retaining
-- the original private function as the single validation/append core.
revoke all on function private.append_accepted_claim(
  text, jsonb, jsonb, jsonb, text
) from service_role;
revoke all on function private.append_accepted_claim_source_chronology(
  text, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public.append_accepted_claim(
  text, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.append_accepted_claim_source_chronology(
  text, jsonb, jsonb, jsonb, text
) to service_role;
grant execute on function public.append_accepted_claim(
  text, jsonb, jsonb, jsonb, text
) to service_role;
