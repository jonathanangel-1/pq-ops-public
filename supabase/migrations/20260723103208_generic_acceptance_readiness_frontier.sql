-- Make the already-authorized generic acceptance epoch reachable from the
-- recurring hosted runtime. The frontier is read-only, sync-token gated,
-- service-role only, bounded, and admits only the exact generic source pairs
-- reviewed in 20260718125000.

do $preflight$
begin
  if to_regclass('public.truth_pending_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regprocedure(
      'private.truth_generic_acceptance_scope_valid_v1(public.truth_pending_acceptance_epochs)'
    ) is null
    or to_regprocedure(
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
    ) is null then
    raise exception 'generic acceptance readiness prerequisites are missing'
      using errcode = '55000';
  end if;
end;
$preflight$;

-- Generic claim chains can also be extended by bounded corrective authorities,
-- such as the TMS inventory-presence recovery. Epoch items are therefore not
-- the complete accepted-claim ledger. Resolve the exact namespaced accepted
-- head on every generic candidate before assigning the next logical version.
do $rewrite_generic_accepted_claim_head$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    if not (v_heads ? (v_candidate_body->>'claimKey')) then
      v_prior_head := null;
      select jsonb_build_object(
        'originalClaimKey', item.original_claim_key,
        'shadowClaimKey', item.shadow_claim_key,
        'claimVersionId', claim.claim_version_id,
        'claimItemHash', claim.claim_content_hash,
        'versionNo', claim.version_no,
        'polarity', claim.polarity,
        'normalizedValue', claim.normalized_value,
        'chronologyAt', private.canonical_truth_timestamp(item.chronology_at),
        'epochItemId', item.item_id,
        'epochItemHash', item.item_hash
      ) into v_prior_head
      from public.truth_shadow_claim_acceptance_epoch_items item
      join public.truth_shadow_claim_acceptance_epochs epoch
        on epoch.epoch_id = item.epoch_id
      join public.accepted_claims claim
        on claim.claim_version_id = item.accepted_claim_version_id
      where epoch.workspace_key = p_workspace_key
        and epoch.source_system = v_pending.source_system
        and epoch.connection_key = v_pending.connection_key
        and item.original_claim_key = v_candidate_body->>'claimKey'
        and item.decision = 'accept'
      order by claim.version_no desc
      limit 1;
      v_heads := jsonb_set(
        v_heads,
        array[v_candidate_body->>'claimKey'],
        coalesce(v_prior_head, 'null'::jsonb),
        true
      );
    end if;
    v_prior_head := v_heads->(v_candidate_body->>'claimKey');$old$;
  v_new text := $new$    -- GENERIC_ACCEPTED_CLAIM_HEAD_V1
    if v_pending.source_system = any(array['tms', 'tracking', 'operator']) then
      v_prior_head := null;
      select jsonb_build_object(
        'originalClaimKey', v_candidate_body->>'claimKey',
        'shadowClaimKey', claim.claim_key,
        'acceptedClaimKey', claim.claim_key,
        'claimVersionId', claim.claim_version_id,
        'claimItemHash', claim.claim_content_hash,
        'versionNo', claim.version_no,
        'previousClaimVersionId',
          coalesce(claim.previous_claim_version_id, ''),
        'subjectType', claim.subject_type,
        'subjectKey', claim.subject_key,
        'predicate', claim.predicate,
        'gate', claim.gate,
        'polarity', claim.polarity,
        'normalizedValue', claim.normalized_value,
        'chronologyAt', private.canonical_truth_timestamp(
          coalesce(item.chronology_at, claim.recorded_at)
        ),
        'epochItemId', coalesce(item.item_id, ''),
        'epochItemHash', coalesce(item.item_hash, '')
      ) into v_prior_head
      from public.accepted_claims claim
      left join lateral (
        select epoch_item.*
        from public.truth_shadow_claim_acceptance_epoch_items epoch_item
        join public.truth_shadow_claim_acceptance_epochs epoch
          on epoch.workspace_key = p_workspace_key
         and epoch.epoch_id = epoch_item.epoch_id
         and epoch.source_system = v_pending.source_system
         and epoch.connection_key = v_pending.connection_key
        where epoch_item.accepted_claim_version_id =
          claim.claim_version_id
          and epoch_item.original_claim_key =
            v_candidate_body->>'claimKey'
          and epoch_item.decision = 'accept'
        order by epoch_item.ordinal desc, epoch_item.item_id
        limit 1
      ) item on true
      where claim.claim_key = v_shadow_claim_key
      order by claim.version_no desc, claim.claim_version_id
      limit 1;

      if jsonb_typeof(v_prior_head) = 'object' and (
        v_prior_head->>'shadowClaimKey' is distinct from v_shadow_claim_key
        or v_prior_head->>'acceptedClaimKey' is distinct from
          v_shadow_claim_key
        or v_prior_head->>'subjectType' is distinct from
          v_candidate_body->>'subjectType'
        or v_prior_head->>'subjectKey' is distinct from
          v_candidate_body->>'subjectKey'
        or v_prior_head->>'predicate' is distinct from
          v_candidate_body->>'predicate'
        or v_prior_head->>'gate' is distinct from
          v_candidate_body->>'gate'
        or (
          (v_prior_head->>'versionNo')::integer = 1
          and v_prior_head->>'previousClaimVersionId' <> ''
        )
        or (
          (v_prior_head->>'versionNo')::integer > 1
          and not exists (
            select 1
            from public.accepted_claims predecessor
            where predecessor.claim_version_id =
                v_prior_head->>'previousClaimVersionId'
              and predecessor.claim_key = v_shadow_claim_key
              and predecessor.version_no =
                (v_prior_head->>'versionNo')::integer - 1
          )
        )
      ) then
        raise exception 'generic accepted claim head is inconsistent'
          using errcode = '23514';
      end if;
      v_heads := jsonb_set(
        v_heads,
        array[v_candidate_body->>'claimKey'],
        coalesce(v_prior_head, 'null'::jsonb),
        true
      );
    elsif not (v_heads ? (v_candidate_body->>'claimKey')) then
      v_prior_head := null;
      select jsonb_build_object(
        'originalClaimKey', item.original_claim_key,
        'shadowClaimKey', item.shadow_claim_key,
        'claimVersionId', claim.claim_version_id,
        'claimItemHash', claim.claim_content_hash,
        'versionNo', claim.version_no,
        'polarity', claim.polarity,
        'normalizedValue', claim.normalized_value,
        'chronologyAt', private.canonical_truth_timestamp(item.chronology_at),
        'epochItemId', item.item_id,
        'epochItemHash', item.item_hash
      ) into v_prior_head
      from public.truth_shadow_claim_acceptance_epoch_items item
      join public.truth_shadow_claim_acceptance_epochs epoch
        on epoch.epoch_id = item.epoch_id
      join public.accepted_claims claim
        on claim.claim_version_id = item.accepted_claim_version_id
      where epoch.workspace_key = p_workspace_key
        and epoch.source_system = v_pending.source_system
        and epoch.connection_key = v_pending.connection_key
        and item.original_claim_key = v_candidate_body->>'claimKey'
        and item.decision = 'accept'
      order by claim.version_no desc
      limit 1;
      v_heads := jsonb_set(
        v_heads,
        array[v_candidate_body->>'claimKey'],
        coalesce(v_prior_head, 'null'::jsonb),
        true
      );
    end if;
    v_prior_head := v_heads->(v_candidate_body->>'claimKey');$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('GENERIC_ACCEPTED_CLAIM_HEAD_V1' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'generic accepted-claim head rewrite did not match reviewed runtime'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_generic_accepted_claim_head$;

create or replace function private.read_truth_generic_acceptance_readiness_frontier_v1(
  p_workspace_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_batches jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'invalid generic acceptance-readiness frontier request'
      using errcode = '22023';
  end if;

  with unresolved as materialized (
    select pending.*,
           row_number() over (
             partition by pending.source_system, pending.connection_key
             order by pending.source_cursor_version, pending.root_batch_id
           ) as source_ordinal
    from public.truth_pending_acceptance_epochs pending
    join public.source_processing_jobs sequence_job
      on sequence_job.workspace_key = pending.workspace_key
     and sequence_job.job_id = pending.pending_job_id
    where pending.workspace_key = p_workspace_key
      and (
        (pending.source_system = 'tms'
          and pending.connection_key = 'couriercloud-ops-tlv-us')
        or (pending.source_system = 'tracking'
          and pending.connection_key = 'carrier-tracking-primary')
        or (pending.source_system = 'operator'
          and pending.connection_key = 'operator-phone-primary')
      )
      and (
        sequence_job.state <> 'succeeded'
        or not exists (
          select 1
          from public.truth_shadow_claim_acceptance_epochs completed
          where completed.workspace_key = pending.workspace_key
            and completed.obligation_id = pending.obligation_id
            and completed.obligation_hash = pending.obligation_hash
        )
      )
  ), pending as materialized (
    select unresolved.*
    from unresolved
    order by unresolved.source_ordinal,
             unresolved.source_system,
             unresolved.connection_key,
             unresolved.source_cursor_version,
             unresolved.root_batch_id
    limit p_limit
  ), shaped as (
    select pending.root_batch_id,
           pending.source_system,
           pending.connection_key,
           pending.source_cursor_version,
           pending.source_cursor_value,
           pending.obligation_id,
           coalesce(
             completed.obligation_id is not null
             and sequence_job.state = 'succeeded'
             and sequence_job.result->>'epochId' = completed.epoch_id
             and sequence_job.result->>'epochReceiptHash' = completed.receipt_hash,
             false
           ) as acceptance_complete,
           coalesce(
             private.truth_generic_acceptance_scope_valid_v1(pending_record)
             and sequence_job.job_kind =
               'truth_sequence_claim_acceptance_epoch'
             and sequence_job.source_system = pending.source_system
             and sequence_job.connection_key = pending.connection_key
             and sequence_job.source_object_id = pending.root_batch_id::text
             and sequence_job.state = 'waiting_runtime'
             and sequence_job.attempt_count = 0
             and sequence_job.lease_owner is null
             and sequence_job.lease_expires_at is null
             and sequence_job.last_error_code =
               'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
             and sequence_job.payload->>'obligationId' =
               pending.obligation_id
             and not exists (
               select 1
               from public.truth_pending_acceptance_epochs prior
               where prior.workspace_key = pending.workspace_key
                 and prior.source_system = pending.source_system
                 and prior.connection_key = pending.connection_key
                 and prior.source_cursor_version <
                   pending.source_cursor_version
                 and not exists (
                   select 1
                   from public.truth_shadow_claim_acceptance_epochs prior_done
                   where prior_done.workspace_key = prior.workspace_key
                     and prior_done.obligation_id = prior.obligation_id
                     and prior_done.obligation_hash = prior.obligation_hash
                 )
             )
             and claims.job_count > 0
             and claims.job_count = manifests.member_count
             and claims.job_count = claims.complete_count,
             false
           ) as frontier_sealed
    from pending
    join public.truth_pending_acceptance_epochs pending_record
      on pending_record.workspace_key = pending.workspace_key
     and pending_record.obligation_id = pending.obligation_id
     and pending_record.obligation_hash = pending.obligation_hash
    join public.source_processing_jobs sequence_job
      on sequence_job.workspace_key = pending.workspace_key
     and sequence_job.job_id = pending.pending_job_id
    left join public.truth_shadow_claim_acceptance_epochs completed
      on completed.workspace_key = pending.workspace_key
     and completed.obligation_id = pending.obligation_id
     and completed.obligation_hash = pending.obligation_hash
    left join lateral (
      select count(*)::bigint as job_count,
             count(*) filter (
               where claim_job.state = 'succeeded'
                 and manifest.job_id is not null
                 and member.source_job_id is not null
                 and manifest.source_observation_id =
                   claim_job.observation_id
                 and member.source_observation_id =
                   claim_job.observation_id
                 and member.candidate_count = manifest.candidate_count
                 and member.candidate_manifest_hash =
                   manifest.manifest_hash
             )::bigint as complete_count
      from public.source_processing_jobs claim_job
      join public.source_processing_job_lineage claim_lineage
        on claim_lineage.job_id = claim_job.job_id
       and claim_lineage.workspace_key = claim_job.workspace_key
      left join public.candidate_claim_job_manifests manifest
        on manifest.workspace_key = claim_job.workspace_key
       and manifest.job_id = claim_job.job_id
      left join public.truth_pending_acceptance_epoch_manifests member
        on member.workspace_key = claim_job.workspace_key
       and member.obligation_id = pending.obligation_id
       and member.source_job_id = claim_job.job_id
      where claim_job.workspace_key = pending.workspace_key
        and claim_job.source_system = pending.source_system
        and claim_job.connection_key = pending.connection_key
        and claim_lineage.root_batch_id = pending.root_batch_id
        and claim_job.job_kind = case pending.source_system
          when 'tms' then 'tms_extract_claims'
          when 'tracking' then 'tracking_extract_claims'
          when 'operator' then 'operator_extract_claims'
          else ''
        end
    ) claims on true
    left join lateral (
      select count(*)::bigint as member_count
      from public.truth_pending_acceptance_epoch_manifests member
      where member.workspace_key = pending.workspace_key
        and member.obligation_id = pending.obligation_id
    ) manifests on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rootBatchId', shaped.root_batch_id,
    'sourceSystem', shaped.source_system,
    'connectionKey', shaped.connection_key,
    'sourceCursorVersion', shaped.source_cursor_version,
    'sourceCursorValue', shaped.source_cursor_value,
    'obligationId', shaped.obligation_id,
    'frontierSealed', shaped.frontier_sealed,
    'acceptanceComplete', shaped.acceptance_complete,
    'readyToRun', shaped.frontier_sealed and not shaped.acceptance_complete
  ) order by shaped.source_cursor_version, shaped.source_system,
             shaped.connection_key, shaped.root_batch_id), '[]'::jsonb)
  into v_batches
  from shaped;

  return jsonb_build_object(
    'ok', true,
    'batches', v_batches,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_truth_generic_acceptance_readiness_frontier(
  p_workspace_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_truth_generic_acceptance_readiness_frontier_v1(
    p_workspace_key, p_limit, p_sync_token
  );
$function$;

revoke all on function private.read_truth_generic_acceptance_readiness_frontier_v1(
  text,integer,text
) from public, anon, authenticated, service_role;
revoke all on function public.read_truth_generic_acceptance_readiness_frontier(
  text,integer,text
) from public, anon, authenticated;
grant execute on function public.read_truth_generic_acceptance_readiness_frontier(
  text,integer,text
) to service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.read_truth_generic_acceptance_readiness_frontier_v1(text,integer,text)'::regprocedure
  ) into v_definition;
  if position('private.valid_truth_sync_token(p_sync_token)' in v_definition) = 0
    or position('private.truth_generic_acceptance_scope_valid_v1(pending_record)' in v_definition) = 0
    or position('row_number() over' in v_definition) = 0
    or position('limit p_limit' in v_definition) = 0
    or position('truth_pending_acceptance_epoch_manifests' in v_definition) = 0
    or position('ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED' in v_definition) = 0
    or position('productionPublicationAttempted'', false' in v_definition) = 0 then
    raise exception 'generic acceptance-readiness frontier is incomplete'
      using errcode = '55000';
  end if;
  if position('source_ingest_batches' in v_definition) > 0
    or position('truth_builds' in v_definition) > 0
    or position('truth_publications' in v_definition) > 0
    or position('app_snapshots' in v_definition) > 0 then
    raise exception 'generic acceptance-readiness frontier widened into mutation or publication state'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('GENERIC_ACCEPTED_CLAIM_HEAD_V1' in v_definition) = 0
    or position('where claim.claim_key = v_shadow_claim_key' in v_definition) = 0
    or position('generic accepted claim head is inconsistent' in v_definition) = 0 then
    raise exception 'generic acceptance coordinator does not follow accepted claim heads'
      using errcode = '55000';
  end if;
  select proconfig into v_config
  from pg_catalog.pg_proc
  where oid =
    'public.read_truth_generic_acceptance_readiness_frontier(text,integer,text)'::regprocedure;
  if v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege(
      'anon',
      'public.read_truth_generic_acceptance_readiness_frontier(text,integer,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.read_truth_generic_acceptance_readiness_frontier(text,integer,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.read_truth_generic_acceptance_readiness_frontier(text,integer,text)',
      'execute'
    ) then
    raise exception 'generic acceptance-readiness frontier ACL/config is unsafe'
      using errcode = '55000';
  end if;
end;
$verify$;
