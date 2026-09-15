-- Read candidate reviews for one ordinary primary forward Gmail root without
-- scanning the workspace-wide candidate corpus used by the shared lane.

create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_primary_forward_parent_authorizations') is null
    or to_regprocedure(
      'private.truth_gmail_live_message_model_root_allowed_v1(text,text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_is_reconciled_stale_candidate_v1(text,text)'
    ) is null
    or to_regprocedure('private.valid_truth_review_token(text)') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null then
    raise exception 'primary forward review-read prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function public.read_truth_gmail_primary_forward_candidate_reviews(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_limit integer,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='20s'
set lock_timeout='5s'
as $function$
declare
  v_total_count integer:=0;
  v_items jsonb:='[]'::jsonb;
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid primary forward candidate-review authority'
      using errcode='28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_connection_key is distinct from 'primary'
    or p_root_batch_id is null
    or p_limit is null or p_limit<1 or p_limit>100
    or not private.truth_gmail_live_message_model_root_allowed_v1(
      p_workspace_key,p_connection_key,p_root_batch_id
    ) then
    raise exception 'primary forward candidate-review request is invalid'
      using errcode='22023';
  end if;

  with candidate_queue as materialized(
    select
      candidate.candidate_claim_version_id as target_id,
      candidate.created_at,
      jsonb_build_object(
        'targetKind','candidate_claim',
        'targetId',candidate.candidate_claim_version_id,
        'targetItemHash',candidate.envelope_hash,
        'nextDecisionNo',coalesce(latest.decision_no,0)+1,
        'previousDecisionVersionId',coalesce(latest.decision_version_id,''),
        'currentDisposition',coalesce(latest.decision,'pending'),
        'sourceObservationId',candidate.source_observation_id,
        'sourceSystem',observation.source_system,
        'sourceObjectType',candidate.source_object_type,
        'sourceObjectId',candidate.source_object_id,
        'sourceRecordedAt',case when observation.source_recorded_at is null
          then null else private.canonical_truth_timestamp(
            observation.source_recorded_at
          ) end,
        'recommendation',candidate.recommendation,
        'candidate',candidate.canonical_envelope->'candidate',
        'target',candidate.canonical_envelope,
        'targetObject',candidate.canonical_envelope
      ) as item
    from public.source_processing_job_lineage job_lineage
    join public.truth_gmail_primary_forward_parent_authorizations auth
      on auth.workspace_key=job_lineage.workspace_key
     and auth.parent_job_id=job_lineage.parent_job_id
     and auth.root_batch_id=job_lineage.root_batch_id
     and auth.production_publication_attempted=false
    join public.source_processing_jobs source_job
      on source_job.workspace_key=job_lineage.workspace_key
     and source_job.source_system=job_lineage.source_system
     and source_job.connection_key=job_lineage.connection_key
     and source_job.job_id=job_lineage.job_id
     and source_job.job_kind='gmail_extract_message_model_claims'
     and source_job.state='succeeded'
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=source_job.workspace_key
     and manifest.job_id=source_job.job_id
    join public.candidate_claim_job_lineage candidate_lineage
      on candidate_lineage.job_id=manifest.job_id
     and candidate_lineage.source_observation_id=manifest.source_observation_id
    join public.candidate_claim_envelopes candidate
      on candidate.workspace_key=manifest.workspace_key
     and candidate.candidate_claim_version_id=
       candidate_lineage.candidate_claim_version_id
     and candidate.source_observation_id=manifest.source_observation_id
    join public.source_observations observation
      on observation.workspace_key=candidate.workspace_key
     and observation.observation_id=candidate.source_observation_id
     and observation.source_system='gmail'
     and observation.connection_key='primary'
    left join lateral(
      select decision_row.*
      from public.candidate_claim_decisions decision_row
      where decision_row.candidate_claim_version_id=
        candidate.candidate_claim_version_id
      order by decision_row.decision_no desc
      limit 1
    ) latest on true
    where job_lineage.workspace_key='primary'
      and job_lineage.source_system='gmail'
      and job_lineage.connection_key='primary'
      and job_lineage.root_batch_id=p_root_batch_id
      and manifest.manifest_hash=encode(extensions.digest(convert_to(
        manifest.canonical_manifest::text,'UTF8'
      ),'sha256'),'hex')
      and exists(
        select 1
        from jsonb_array_elements(manifest.canonical_manifest->'candidates') item
        where item->>'candidateClaimVersionId'=
          candidate.candidate_claim_version_id
          and item->>'itemHash'=candidate.envelope_hash
      )
      and not private.truth_shadow_is_reconciled_stale_candidate_v1(
        candidate.workspace_key,candidate.candidate_claim_version_id
      )
      and (latest.decision_version_id is null or latest.decision='review')
  ), bounded as(
    select target_id,created_at,item,count(*) over() as total_count
    from candidate_queue
    order by created_at,target_id
    limit p_limit
  )
  select coalesce(max(total_count),0)::integer,
    coalesce(jsonb_agg(item order by created_at,target_id),'[]'::jsonb)
  into v_total_count,v_items
  from bounded;

  return jsonb_build_object(
    'ok',true,
    'schemaVersion','truth-primary-forward-candidate-review-queue-v1',
    'workspaceKey','primary',
    'sourceSystem','gmail',
    'connectionKey','primary',
    'rootBatchId',p_root_batch_id,
    'targetKind','candidate_claim',
    'limit',p_limit,
    'totalCount',v_total_count,
    'candidateCount',v_total_count,
    'linkCount',0,
    'items',v_items,
    'shadowOnly',false,
    'mutatesOperationalState',false,
    'publishesTruth',false,
    'performsActions',false,
    'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function public.read_truth_gmail_primary_forward_candidate_reviews(
  text,text,uuid,integer,text,text
) from public,anon,authenticated;
grant execute on function public.read_truth_gmail_primary_forward_candidate_reviews(
  text,text,uuid,integer,text,text
) to service_role;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'public.read_truth_gmail_primary_forward_candidate_reviews(text,text,uuid,integer,text,text)'::regprocedure
  ) into v_definition;
  if position('from public.source_processing_job_lineage job_lineage' in v_definition)=0
    or position('truth_gmail_primary_forward_parent_authorizations' in v_definition)=0
    or position('job_lineage.root_batch_id=p_root_batch_id' in v_definition)=0
    or position('candidate_claim_job_manifests' in v_definition)=0
    or position('targetItemHash' in v_definition)=0
    or position('previousDecisionVersionId' in v_definition)=0
    or position('productionPublicationAttempted' in v_definition)=0 then
    raise exception 'primary forward candidate-review read is incomplete'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.read_truth_gmail_primary_forward_candidate_reviews(text,text,uuid,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.read_truth_gmail_primary_forward_candidate_reviews(text,text,uuid,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.read_truth_gmail_primary_forward_candidate_reviews(text,text,uuid,integer,text,text)','EXECUTE'
    ) then
    raise exception 'primary forward candidate-review read ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;
