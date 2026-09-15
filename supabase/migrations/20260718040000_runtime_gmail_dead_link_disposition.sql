-- Historical migrations proved safe terminal dispositions for two exact Gmail
-- link-worker defect classes, but executed the repair only once. Install the
-- same proof-bound authority as a bounded runtime RPC so post-migration rows
-- cannot strand otherwise-complete link epochs.

create or replace function private.reconcile_truth_gmail_dead_link_members_v1(
  p_workspace_key text,p_connection_key text,p_limit integer,p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job record;
  v_run public.truth_link_resolution_runs%rowtype;
  v_resolution public.truth_gmail_link_epoch_dead_member_resolutions%rowtype;
  v_ack public.truth_gmail_dead_link_terminal_acknowledgements%rowtype;
  v_action text;
  v_reason text;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_ack_body jsonb;
  v_ack_hash text;
  v_count integer:=0;
  v_durable_count integer:=0;
  v_missing_anchor_count integer:=0;
  v_items jsonb:='[]'::jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key<>'primary' or p_connection_key<>'primary'
    or p_limit is null or p_limit<1 or p_limit>25 then
    raise exception 'invalid Gmail dead-link reconciliation request'
      using errcode='22023';
  end if;
  if to_regclass('public.truth_gmail_link_epoch_dead_member_resolutions') is null
    or to_regclass('public.truth_gmail_dead_link_terminal_acknowledgements') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'Gmail dead-link reconciliation prerequisites are missing'
      using errcode='55000';
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  for v_job in
    select job.*,member.epoch_id,member.member_id epoch_member_id,
      epoch.root_batch_id
    from public.source_processing_jobs job
    left join lateral(
      select candidate.epoch_id,candidate.member_id
      from public.truth_gmail_link_epoch_members candidate
      where candidate.workspace_key=job.workspace_key
        and candidate.link_job_id=job.job_id
      order by candidate.epoch_id,candidate.member_id limit 1
    ) member on true
    left join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key=job.workspace_key and epoch.epoch_id=member.epoch_id
    where job.workspace_key=p_workspace_key and job.source_system='gmail'
      and job.connection_key=p_connection_key
      and job.job_kind='gmail_resolve_entity_links'
      and job.state='dead_letter' and job.attempt_count>=job.max_attempts
      and job.lease_owner is null and job.lease_expires_at is null
      and member.epoch_id is not null and member.member_id is not null
      and job.last_error_code='TRUTH_LINK_JOB_FAILED'
      and (
        position('truth-link job already has a different durable resolution'
          in job.safe_error_detail)>0
        or position('truth link context omitted its anchor'
          in job.safe_error_detail)>0
      )
    order by job.updated_at,job.job_id
    limit p_limit
    for update of job
  loop
    v_run:=null;
    if position('truth-link job already has a different durable resolution'
      in v_job.safe_error_detail)>0 then
      if v_job.epoch_id is null or v_job.epoch_member_id is null then
        continue;
      end if;
      select * into v_run from public.truth_link_resolution_runs run
      where run.workspace_key=v_job.workspace_key and run.job_id=v_job.job_id
        and run.anchor_observation_id=v_job.observation_id
        and run.resolution_hash=encode(extensions.digest(convert_to(
          run.canonical_resolution::text,'UTF8'),'sha256'),'hex')
        and run.resolution_run_id='link-resolution:v1:'||run.resolution_hash
        and run.canonical_resolution#>>'{job,jobId}'=v_job.job_id::text
        and run.canonical_resolution#>>'{job,anchorObservationId}'=v_job.observation_id
        and jsonb_typeof(run.canonical_resolution)='object';
      if not found then continue; end if;
      v_action:='terminal_ack_own_durable_resolution';
      v_reason:='DURABLE_LINK_RESOLUTION_PRECEDED_FAILED_ACKNOWLEDGEMENT';
    else
      if exists(select 1 from public.truth_link_resolution_runs run
        where run.workspace_key=v_job.workspace_key and run.job_id=v_job.job_id) then
        continue;
      end if;
      v_action:='exclude_missing_anchor_context_defect';
      v_reason:='DOCUMENTED_LINK_CONTEXT_BUILDER_ANCHOR_OMISSION';
    end if;

    v_body:=jsonb_build_object(
      'schemaVersion','gmail-link-epoch-dead-member-resolution-v1',
      'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
      'sourceJobId',v_job.job_id,'epochId',v_job.epoch_id,
      'epochMemberId',v_job.epoch_member_id,'actionKind',v_action,
      'reasonCode',v_reason,'priorState','dead_letter',
      'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_job.max_attempts,
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'proofId',case when v_run.resolution_run_id is null then '' else v_run.resolution_run_id end,
      'proofHash',case when v_run.resolution_hash is null then '' else v_run.resolution_hash end,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id:='gmail-link-epoch-dead-member-resolution:v1:'||v_hash;
    insert into public.truth_gmail_link_epoch_dead_member_resolutions(
      resolution_id,resolution_hash,workspace_key,connection_key,source_job_id,
      epoch_id,epoch_member_id,action_kind,prior_state,prior_attempt_count,
      prior_max_attempts,authorized_max_attempts,prior_error_code,
      prior_error_detail_hash,proof_id,proof_hash,canonical_resolution
    ) values(
      v_id,v_hash,p_workspace_key,p_connection_key,v_job.job_id,v_job.epoch_id,
      v_job.epoch_member_id,v_action,'dead_letter',v_job.attempt_count,
      v_job.max_attempts,v_job.max_attempts,v_job.last_error_code,
      v_body->>'priorErrorDetailHash',v_body->>'proofId',v_body->>'proofHash',v_body
    ) on conflict(workspace_key,source_job_id,action_kind,prior_error_detail_hash)
      do nothing;
    select * into strict v_resolution
    from public.truth_gmail_link_epoch_dead_member_resolutions receipt
    where receipt.workspace_key=p_workspace_key
      and receipt.source_job_id=v_job.job_id
      and receipt.action_kind=v_action
      and receipt.prior_error_detail_hash=v_body->>'priorErrorDetailHash';
    if v_resolution.resolution_id<>v_id or v_resolution.resolution_hash<>v_hash
      or v_resolution.canonical_resolution is distinct from v_body then
      raise exception 'Gmail dead-link runtime resolution conflicts on replay: %',v_job.job_id
        using errcode='23505';
    end if;

    if v_action='terminal_ack_own_durable_resolution' then
      update public.source_processing_jobs set state='succeeded',
        completed_at=clock_timestamp(),last_error_code='',safe_error_detail='',
        processor_version='truth-gmail-dead-link-runtime-v1',
        result=jsonb_build_object(
          'schemaVersion','truth-link-worker-result-v1',
          'resolutionRunId',v_run.resolution_run_id,
          'resolutionHash',v_run.resolution_hash,
          'proposalCount',v_run.proposal_count,
          'terminalAcknowledgement',true,
          'productionPublicationAttempted',false
        ),updated_at=clock_timestamp()
      where workspace_key=p_workspace_key and job_id=v_job.job_id
        and state='dead_letter' and attempt_count>=max_attempts
        and lease_owner is null and lease_expires_at is null;
      if not found then raise exception 'Gmail durable-link acknowledgement lost its job'
        using errcode='40001'; end if;
      v_durable_count:=v_durable_count+1;
      v_items:=v_items||jsonb_build_array(jsonb_build_object(
        'rootBatchId',v_job.root_batch_id,
        'sourceJobId',v_job.job_id,
        'disposition','durable_resolution_acknowledged',
        'resolutionId',v_id,'resolutionHash',v_hash));
    else
      v_ack_body:=jsonb_build_object(
        'schemaVersion','truth-gmail-dead-link-terminal-acknowledgement-v1',
        'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
        'sourceJobId',v_job.job_id,
        'deadMemberResolutionId',v_id,'deadMemberResolutionHash',v_hash,
        'priorState','dead_letter','terminalState','superseded',
        'priorAttemptCount',v_job.attempt_count,
        'priorMaxAttempts',v_job.max_attempts,
        'priorErrorCode',v_job.last_error_code,
        'priorErrorDetailHash',v_body->>'priorErrorDetailHash',
        'disposition','documented_context_builder_defect_terminally_acknowledged',
        'linkResolutionMinted',false,'operatorReviewResolved',false,
        'productionPublicationAttempted',false
      );
      v_ack_hash:=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_ack_body),'UTF8'),'sha256'),'hex');
      insert into public.truth_gmail_dead_link_terminal_acknowledgements(
        acknowledgement_id,acknowledgement_hash,workspace_key,connection_key,
        source_job_id,dead_member_resolution_id,dead_member_resolution_hash,
        prior_state,terminal_state,prior_error_code,prior_error_detail_hash,
        canonical_acknowledgement
      ) values(
        'truth-gmail-dead-link-terminal-ack:v1:'||v_ack_hash,v_ack_hash,
        p_workspace_key,p_connection_key,v_job.job_id,v_id,v_hash,
        'dead_letter','superseded',v_job.last_error_code,
        v_body->>'priorErrorDetailHash',v_ack_body
      ) on conflict(source_job_id) do nothing;
      select * into strict v_ack
      from public.truth_gmail_dead_link_terminal_acknowledgements ack
      where ack.workspace_key=p_workspace_key and ack.source_job_id=v_job.job_id;
      if v_ack.acknowledgement_hash<>v_ack_hash
        or v_ack.dead_member_resolution_id<>v_id
        or v_ack.canonical_acknowledgement is distinct from v_ack_body then
        raise exception 'Gmail missing-anchor acknowledgement conflicts on replay: %',v_job.job_id
          using errcode='23505';
      end if;
      update public.source_processing_jobs set state='superseded',
        completed_at=clock_timestamp(),last_error_code='',safe_error_detail='',
        processor_version='truth-gmail-dead-link-runtime-v1',
        result=jsonb_build_object(
          'schemaVersion','truth-gmail-dead-link-terminal-ack-result-v1',
          'disposition','documented_context_builder_defect_terminally_acknowledged',
          'deadMemberResolutionId',v_id,'deadMemberResolutionHash',v_hash,
          'terminalAcknowledgementId','truth-gmail-dead-link-terminal-ack:v1:'||v_ack_hash,
          'terminalAcknowledgementHash',v_ack_hash,
          'linkResolutionMinted',false,
          'productionPublicationAttempted',false
        ),updated_at=clock_timestamp()
      where workspace_key=p_workspace_key and job_id=v_job.job_id
        and state='dead_letter' and attempt_count>=max_attempts
        and lease_owner is null and lease_expires_at is null;
      if not found then raise exception 'Gmail missing-anchor acknowledgement lost its job'
        using errcode='40001'; end if;
      v_missing_anchor_count:=v_missing_anchor_count+1;
      v_items:=v_items||jsonb_build_array(jsonb_build_object(
        'rootBatchId',v_job.root_batch_id,
        'sourceJobId',v_job.job_id,
        'disposition','missing_anchor_excluded',
        'resolutionId',v_id,'resolutionHash',v_hash));
    end if;
    v_count:=v_count+1;
  end loop;

  return jsonb_build_object(
    'ok',true,'reconciledCount',v_count,
    'durableAcknowledgedCount',v_durable_count,
    'missingAnchorExcludedCount',v_missing_anchor_count,
    'items',v_items,'mutatesOperationalState',false,
    'publishesTruth',false,'performsActions',false,
    'productionPublicationAttempted',false
  );
end;
$function$;

create or replace function public.reconcile_truth_gmail_dead_link_members(
  p_workspace_key text,p_connection_key text,p_limit integer,p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path=''
as $function$
  select private.reconcile_truth_gmail_dead_link_members_v1(
    p_workspace_key,p_connection_key,p_limit,p_sync_token
  );
$function$;

revoke all on function private.reconcile_truth_gmail_dead_link_members_v1(
  text,text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function public.reconcile_truth_gmail_dead_link_members(
  text,text,integer,text
) from public,anon,authenticated;
grant execute on function public.reconcile_truth_gmail_dead_link_members(
  text,text,integer,text
) to service_role;

do $verify$
declare
  v_private text;
  v_public text;
begin
  select pg_get_functiondef(
    'private.reconcile_truth_gmail_dead_link_members_v1(text,text,integer,text)'::regprocedure
  ) into v_private;
  select pg_get_functiondef(
    'public.reconcile_truth_gmail_dead_link_members(text,text,integer,text)'::regprocedure
  ) into v_public;
  if position('job.attempt_count>=job.max_attempts' in v_private)=0
    or position('truth-link job already has a different durable resolution' in v_private)=0
    or position('truth link context omitted its anchor' in v_private)=0
    or position('truth_gmail_link_epoch_dead_member_resolutions' in v_private)=0
    or position('truth_gmail_dead_link_terminal_acknowledgements' in v_private)=0
    or position('productionPublicationAttempted' in v_private)=0
    or position('private.reconcile_truth_gmail_dead_link_members_v1' in v_public)=0 then
    raise exception 'Gmail dead-link runtime reconciliation contract is incomplete'
      using errcode='23514';
  end if;
  if has_function_privilege('anon',
      'public.reconcile_truth_gmail_dead_link_members(text,text,integer,text)','EXECUTE')
    or has_function_privilege('authenticated',
      'public.reconcile_truth_gmail_dead_link_members(text,text,integer,text)','EXECUTE')
    or not has_function_privilege('service_role',
      'public.reconcile_truth_gmail_dead_link_members(text,text,integer,text)','EXECUTE') then
    raise exception 'Gmail dead-link runtime reconciliation ACL is unsafe'
      using errcode='42501';
  end if;
end;
$verify$;
