-- Give ordinary primary Gmail commissioning a durable forward authority.
-- Historical schema/prompt/modality recovery receipts remain separate. A
-- valid new replay mints its parent receipt before prepare releases the parent
-- to the queue; one new token/version pair owns claim and seal.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v9(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null then
    raise exception 'primary forward-parent authority prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_primary_forward_parent_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-gmail-primary-forward-parent-authorization:v1:'||
      authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  replay_id text not null unique,
  commissioning_scope_id text not null,
  parent_job_id uuid not null unique,
  root_batch_id uuid not null,
  source_observation_id text not null,
  source_observation_content_hash text not null check(
    source_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  parent_payload_hash text not null check(parent_payload_hash~'^[0-9a-f]{64}$'),
  run_token_hash text not null check(
    run_token_hash='0000000000000000000000000000000000000000000000000000000000000005'
  ),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v13-36b25f2b'
  ),
  canonical_authorization jsonb not null check(
    jsonb_typeof(canonical_authorization)='object'
  ),
  schema_version text not null check(
    schema_version='truth-gmail-primary-forward-parent-authorization-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  authorized_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,authorization_id),
  foreign key(workspace_key,replay_id)
    references public.truth_shadow_gmail_model_commissioning_replays(
      workspace_key,replay_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key,parent_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check(authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_authorization->>'schemaVersion'=schema_version),
  check(canonical_authorization->>'workspaceKey'=workspace_key),
  check(canonical_authorization->>'connectionKey'=connection_key),
  check(canonical_authorization->>'replayId'=replay_id),
  check(canonical_authorization->>'commissioningScopeId'=commissioning_scope_id),
  check(canonical_authorization->>'parentJobId'=parent_job_id::text),
  check(canonical_authorization->>'rootBatchId'=root_batch_id::text),
  check(canonical_authorization->>'sourceObservationId'=source_observation_id),
  check(canonical_authorization->>'sourceObservationContentHash'=
    source_observation_content_hash),
  check(canonical_authorization->>'parentPayloadHash'=parent_payload_hash),
  check(canonical_authorization->>'runTokenHash'=run_token_hash),
  check(canonical_authorization->>'activeProcessorVersion'=active_processor_version),
  check(canonical_authorization->>'reasonCode'='ORDINARY_PRIMARY_FORWARD_COMMISSIONING'),
  check(canonical_authorization->>'candidateClaimsAutoAccepted'='false'),
  check(canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_primary_forward_parent_authorizations_immutable
  on public.truth_gmail_primary_forward_parent_authorizations;
create trigger truth_gmail_primary_forward_parent_authorizations_immutable
before update or delete on public.truth_gmail_primary_forward_parent_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_primary_forward_parent_authorizations enable row level security;
alter table public.truth_gmail_primary_forward_parent_authorizations force row level security;
revoke all on public.truth_gmail_primary_forward_parent_authorizations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_primary_forward_parent_authorizations to service_role;

create or replace function private.mint_truth_gmail_primary_forward_parent_authorization_v1(
  p_workspace_key text,p_replay_id text
) returns text
language plpgsql security definer set search_path=''
as $function$
declare
  v_row record;
  v_body jsonb;
  v_hash text;
  v_authorization_id text;
  v_existing public.truth_gmail_primary_forward_parent_authorizations%rowtype;
begin
  select replay.*,job.payload as parent_payload,lineage.parent_job_id as lineage_parent_job_id,
    lineage.root_job_id as lineage_root_job_id,
    lineage.source_cursor_version as lineage_cursor_version,
    lineage.source_cursor_value as lineage_cursor_value
  into v_row
  from public.truth_shadow_gmail_model_commissioning_replays replay
  join public.source_processing_jobs job
    on job.workspace_key=replay.workspace_key
   and job.job_id=replay.successor_parent_job_id
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key=job.workspace_key
   and lineage.source_system=job.source_system
   and lineage.connection_key=job.connection_key
   and lineage.job_id=job.job_id
  where replay.workspace_key=p_workspace_key and replay.replay_id=p_replay_id
    and replay.workspace_key='primary' and replay.connection_key='primary'
    and replay.shadow_only=false and replay.production_eligible=false
    and replay.production_publication_attempted=false
    and job.source_system='gmail' and job.connection_key='primary'
    and job.job_kind='gmail_extract_message_claims'
    and job.job_id=replay.successor_parent_job_id
    and job.observation_id=replay.source_observation_id
    and job.state in ('waiting_runtime','queued') and job.attempt_count=0
    and job.processor_version='' and job.result='{}'::jsonb
    and job.completed_at is null and job.lease_owner is null
    and job.lease_expires_at is null
    and job.payload->>'modelCommissioningReplayId'=replay.replay_id
    and job.payload->>'modelCommissioningScopeId'=replay.commissioning_scope_id
    and job.payload->>'shadowOnly'='false'
    and not (job.payload ?| array[
      'modelSchemaRetryVersion','modelTemperatureRetryVersion',
      'modelPodPromptRetryVersion','modelModalityRetryVersion'
    ])
    and lineage.root_batch_id=replay.root_batch_id
    and lineage.parent_job_id=replay.original_parent_job_id
    and lineage.root_job_id=replay.root_job_id
    and lineage.source_cursor_version=replay.source_cursor_version
    and lineage.source_cursor_value=replay.source_cursor_value
    and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
      replay.workspace_key,replay.obligation_id
    )
    and private.truth_gmail_live_message_model_root_allowed_v1(
      replay.workspace_key,replay.connection_key,replay.root_batch_id
    )
    and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=replay.workspace_key
        and epoch.root_batch_id=replay.root_batch_id)
    and not exists(select 1 from public.truth_shadow_root_source_cuts root_cut
      where root_cut.workspace_key=replay.workspace_key
        and root_cut.root_batch_id=replay.root_batch_id);

  if not found then
    return '';
  end if;

  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-primary-forward-parent-authorization-v1',
    'workspaceKey','primary','connectionKey','primary',
    'replayId',v_row.replay_id,
    'commissioningScopeId',v_row.commissioning_scope_id,
    'parentJobId',v_row.successor_parent_job_id,
    'rootBatchId',v_row.root_batch_id,
    'sourceObservationId',v_row.source_observation_id,
    'sourceObservationContentHash',v_row.source_observation_content_hash,
    'parentPayloadHash',encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_row.parent_payload),'UTF8'
    ),'sha256'),'hex'),
    'runTokenHash','0000000000000000000000000000000000000000000000000000000000000005',
    'activeProcessorVersion','primary-message-model-drain-v1:parents-v13-36b25f2b',
    'reasonCode','ORDINARY_PRIMARY_FORWARD_COMMISSIONING',
    'candidateClaimsAutoAccepted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  v_authorization_id:='truth-gmail-primary-forward-parent-authorization:v1:'||v_hash;

  insert into public.truth_gmail_primary_forward_parent_authorizations(
    authorization_id,authorization_hash,workspace_key,connection_key,replay_id,
    commissioning_scope_id,parent_job_id,root_batch_id,source_observation_id,
    source_observation_content_hash,parent_payload_hash,run_token_hash,
    active_processor_version,canonical_authorization,schema_version
  ) values(
    v_authorization_id,v_hash,'primary','primary',v_row.replay_id,
    v_row.commissioning_scope_id,v_row.successor_parent_job_id,v_row.root_batch_id,
    v_row.source_observation_id,v_row.source_observation_content_hash,
    v_body->>'parentPayloadHash',v_body->>'runTokenHash',
    v_body->>'activeProcessorVersion',v_body,
    'truth-gmail-primary-forward-parent-authorization-v1'
  ) on conflict(parent_job_id) do nothing;

  select * into v_existing
  from public.truth_gmail_primary_forward_parent_authorizations auth
  where auth.workspace_key='primary'
    and auth.parent_job_id=v_row.successor_parent_job_id;
  if not found or v_existing.authorization_id<>v_authorization_id
    or v_existing.replay_id<>v_row.replay_id then
    raise exception 'primary forward-parent authorization conflict'
      using errcode='23514';
  end if;
  return v_authorization_id;
end;
$function$;

revoke all on function private.mint_truth_gmail_primary_forward_parent_authorization_v1(
  text,text
) from public,anon,authenticated,service_role;

create or replace function private.route_truth_gmail_primary_forward_parent_authorization_v1()
returns trigger
language plpgsql security definer set search_path=''
as $function$
declare v_authorization_id text;
begin
  if new.workspace_key='primary' and new.connection_key='primary'
    and new.shadow_only=false and new.production_publication_attempted=false then
    v_authorization_id:=private.mint_truth_gmail_primary_forward_parent_authorization_v1(
      new.workspace_key,new.replay_id
    );
    if v_authorization_id='' then
      raise exception 'primary commissioning replay could not mint forward-parent authority'
        using errcode='23514';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.route_truth_gmail_primary_forward_parent_authorization_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists route_truth_gmail_primary_forward_parent_authorization_v1
  on public.truth_shadow_gmail_model_commissioning_replays;
create trigger route_truth_gmail_primary_forward_parent_authorization_v1
after insert on public.truth_shadow_gmail_model_commissioning_replays
for each row execute function
  private.route_truth_gmail_primary_forward_parent_authorization_v1();

do $backfill$
declare v_replay record; v_authorization_id text; v_count integer:=0;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_replay in
    select replay.workspace_key,replay.replay_id
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.source_processing_jobs job
      on job.workspace_key=replay.workspace_key
     and job.job_id=replay.successor_parent_job_id
    where replay.workspace_key='primary' and replay.connection_key='primary'
      and replay.shadow_only=false and replay.production_publication_attempted=false
      and job.state='queued' and job.attempt_count=0
      and job.job_kind='gmail_extract_message_claims'
      and job.processor_version='' and job.result='{}'::jsonb
      and job.completed_at is null and job.lease_owner is null
      and job.lease_expires_at is null
      and not (job.payload ?| array[
        'modelSchemaRetryVersion','modelTemperatureRetryVersion',
        'modelPodPromptRetryVersion','modelModalityRetryVersion'
      ])
    order by replay.created_at,replay.replay_id
    for update of job
  loop
    v_authorization_id:=private.mint_truth_gmail_primary_forward_parent_authorization_v1(
      v_replay.workspace_key,v_replay.replay_id
    );
    if v_authorization_id='' then
      raise exception 'eligible queued primary parent could not be authorized'
        using errcode='23514';
    end if;
    v_count:=v_count+1;
  end loop;
  if v_count>50 then
    raise exception 'primary forward-parent authorization backfill exceeded bound'
      using errcode='54000';
  end if;
end;
$backfill$;

do $preserve_parent_worker$
begin
  if to_regprocedure(
    'private.truth_gmail_parent_worker_pre_forward_v1(text,uuid,text,text)'
  ) is null then
    alter function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
      text,uuid,text,text
    ) rename to truth_gmail_parent_worker_pre_forward_v1;
  end if;
end;
$preserve_parent_worker$;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select private.truth_gmail_parent_worker_pre_forward_v1(
    p_workspace_key,p_parent_job_id,p_worker_id,p_processor_version
  ) or exists(
    select 1
    from public.truth_gmail_primary_forward_parent_authorizations auth
    join public.source_processing_jobs job
      on job.workspace_key=auth.workspace_key and job.job_id=auth.parent_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    where auth.workspace_key=p_workspace_key and auth.parent_job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||auth.root_batch_id::text
      and p_processor_version=auth.active_processor_version
      and auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v13-36b25f2b'
      and auth.authorization_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth.canonical_authorization),'UTF8'
      ),'sha256'),'hex')
      and auth.parent_payload_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(job.payload),'UTF8'
      ),'sha256'),'hex')
      and lineage.root_batch_id=auth.root_batch_id
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_parent_worker_pre_forward_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;
revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

do $preserve_child_input$
begin
  if to_regprocedure(
    'private.truth_gmail_child_input_pre_forward_v1(text,text,uuid,text,text,jsonb)'
  ) is null then
    alter function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
      text,text,uuid,text,text,jsonb
    ) rename to truth_gmail_child_input_pre_forward_v1;
  end if;
end;
$preserve_child_input$;

create or replace function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  p_workspace_key text,p_parent_job_id text,p_child_job_id uuid,
  p_dedupe_key text,p_observation_id text,p_payload jsonb
) returns boolean
language sql stable security definer set search_path=''
set statement_timeout='150s' set lock_timeout='30s'
as $function$
  select private.truth_gmail_child_input_pre_forward_v1(
    p_workspace_key,p_parent_job_id,p_child_job_id,p_dedupe_key,
    p_observation_id,p_payload
  ) or exists(
    select 1
    from public.truth_gmail_primary_forward_parent_authorizations auth
    join public.source_processing_jobs parent_job
      on parent_job.workspace_key=auth.workspace_key
     and parent_job.job_id=auth.parent_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=parent_job.workspace_key
     and lineage.job_id=parent_job.job_id
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key=auth.workspace_key
     and plan.parent_job_id=auth.parent_job_id
    where auth.workspace_key=p_workspace_key
      and auth.parent_job_id::text=p_parent_job_id
      and p_child_job_id is not null
      and p_dedupe_key='gmail:model-claims:v1:'||plan.model_plan_hash
      and p_observation_id=parent_job.observation_id
      and jsonb_typeof(coalesce(p_payload,'null'::jsonb))='object'
      and private.truth_jsonb_has_only_keys(p_payload,array[
        'schemaVersion','modelPlanId','contextSealId','batchId',
        'rootBatchId','rootJobId','parentJobId'
      ])
      and (select count(*) from jsonb_object_keys(p_payload))=7
      and p_payload->>'schemaVersion'='gmail-model-claims-job-v1'
      and p_payload->>'modelPlanId'=plan.model_plan_id
      and p_payload->>'contextSealId'=plan.context_seal_id
      and p_payload->>'batchId'=auth.root_batch_id::text
      and p_payload->>'rootBatchId'=auth.root_batch_id::text
      and p_payload->>'rootJobId'=lineage.root_job_id::text
      and p_payload->>'parentJobId'=auth.parent_job_id::text
      and auth.parent_payload_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(parent_job.payload),'UTF8'
      ),'sha256'),'hex')
      and plan.planning_status='complete' and plan.model_plan_id is not null
      and plan.model_plan_hash is not null and plan.model_plan is not null
      and plan.model_plan->>'promptVersion'='gmail-claim-extraction-prompt-v4'
      and plan.model_plan->>'responseSchemaVersion'=
        'gmail-model-candidate-claims-v4'
      and plan.execution_mode='sync'
      and plan.root_ingest_mode in ('history','cutover_delta_reconciliation')
      and private.truth_gmail_live_message_model_root_allowed_v1(
        auth.workspace_key,'primary',auth.root_batch_id
      )
      and private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
        auth.workspace_key,auth.parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_child_input_pre_forward_v1(
  text,text,uuid,text,text,jsonb
) from public,anon,authenticated,service_role;
revoke all on function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  text,text,uuid,text,text,jsonb
) from public,anon,authenticated,service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v10(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
    p_workspace_key,p_job_id,p_worker_id,p_processor_version
  ) then
    raise exception 'primary forward parent worker refused' using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_primary_forward_parent_authorizations auth
      join public.source_processing_jobs job
        on job.workspace_key=auth.workspace_key and job.job_id=auth.parent_job_id
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
       and lineage.root_batch_id=auth.root_batch_id
      where auth.workspace_key=p_workspace_key and auth.parent_job_id=p_job_id
        and auth.active_processor_version=p_processor_version
        and auth.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and auth.parent_payload_hash=encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.payload),'UTF8'
        ),'sha256'),'hex')
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence and job.attempt_count=1
        and job.processor_version=p_processor_version
        and not exists(select 1 from public.gmail_model_extraction_plans plan
          where plan.workspace_key=job.workspace_key and plan.parent_job_id=job.job_id)
        and not exists(select 1 from public.gmail_model_extraction_context_seals seal
          where seal.workspace_key=job.workspace_key and seal.parent_job_id=job.job_id)
        and not exists(select 1 from public.candidate_claim_job_manifests manifest
          where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
        and not exists(select 1 from public.candidate_claim_job_lineage candidate
          where candidate.job_id=job.job_id)
        and not exists(select 1 from public.source_processing_job_children child
          where child.parent_job_id=job.job_id)
    ) then
    raise exception 'primary forward parent token refused' using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v10(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v10(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare v_worker text; v_child text; v_sealer text; v_count integer;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'::regprocedure
  ) into v_child;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v10(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_sealer;
  if position('truth_gmail_primary_forward_parent_authorizations' in v_worker)=0
    or position('parents-v13-36b25f2b' in v_worker)=0
    or position('truth_gmail_primary_forward_parent_authorizations' in v_child)=0
    or position('gmail-claim-extraction-prompt-v4' in v_child)=0
    or position('primary forward parent token refused' in v_sealer)=0
    or position('private.seal_gmail_model_extraction_plan' in v_sealer)=0 then
    raise exception 'primary forward-parent authority chain is incomplete'
      using errcode='55000';
  end if;
  select count(*) into v_count
  from public.truth_shadow_gmail_model_commissioning_replays replay
  join public.source_processing_jobs job
    on job.workspace_key=replay.workspace_key
   and job.job_id=replay.successor_parent_job_id
  where replay.workspace_key='primary' and replay.connection_key='primary'
    and job.state='queued' and job.attempt_count=0
    and job.job_kind='gmail_extract_message_claims'
    and not (job.payload ?| array[
      'modelSchemaRetryVersion','modelTemperatureRetryVersion',
      'modelPodPromptRetryVersion','modelModalityRetryVersion'
    ])
    and not exists(select 1
      from public.truth_gmail_primary_forward_parent_authorizations auth
      where auth.workspace_key=job.workspace_key and auth.parent_job_id=job.job_id);
  if v_count<>0 then
    raise exception 'queued primary commissioning successor lacks forward authority'
      using errcode='55000';
  end if;
  if exists(select 1
      from public.truth_gmail_primary_forward_parent_authorizations auth
      where auth.production_publication_attempted
        or auth.canonical_authorization->>'productionPublicationAttempted'<>'false')
    or has_table_privilege(
      'service_role','public.truth_gmail_primary_forward_parent_authorizations',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) or has_table_privilege(
      'anon','public.truth_gmail_primary_forward_parent_authorizations','SELECT'
    ) or has_table_privilege(
      'authenticated','public.truth_gmail_primary_forward_parent_authorizations','SELECT'
    ) or has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v10(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v10(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v10(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) then
    raise exception 'primary forward-parent authority ACL/publication contract is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_primary_forward_parent_authorizations;
