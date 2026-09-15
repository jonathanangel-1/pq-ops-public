-- A 370000 zero-candidate membership can predate 600000's more specific
-- parent-planning-v2 terminal result. The membership remains valid evidence of
-- its original authority, but its worker-result hash no longer describes the
-- current immutable terminal result. Append a proof-carrying supersession and
-- make acceptance construct its new frontier from the effective hash. Never
-- update the original membership or any completed acceptance epoch.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.truth_gmail_documented_claim_defect_exclusions') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null then
    raise exception 'documented-defect acceptance supersession prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('shadow acceptance frontier failed immutable hash validation' in v_definition)=0
    or (position($needle$'workerResultHash', membership.worker_result_hash$needle$
      in v_definition)=0
      and position('truth_effective_acceptance_worker_result_hash_v1'
        in v_definition)=0) then
    raise exception 'acceptance runtime differs from the reviewed frontier contract'
      using errcode='23514';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_acceptance_membership_supersessions(
  supersession_id text primary key check(
    supersession_id~'^truth-gmail-acceptance-membership-supersession:v1:[0-9a-f]{64}$'
  ),
  supersession_hash text not null unique check(supersession_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  obligation_id text not null,
  source_job_id uuid not null,
  prior_membership_hash text not null check(prior_membership_hash~'^[0-9a-f]{64}$'),
  prior_worker_result_hash text not null check(prior_worker_result_hash~'^[0-9a-f]{64}$'),
  superseding_worker_result_hash text not null check(
    superseding_worker_result_hash~'^[0-9a-f]{64}$'
  ),
  defect_exclusion_id text not null,
  canonical_supersession jsonb not null check(
    jsonb_typeof(canonical_supersession)='object'
    and canonical_supersession->>'schemaVersion'
      ='truth-gmail-acceptance-membership-supersession-v1'
    and canonical_supersession->>'authorityVersion'
      ='truth-gmail-documented-defect-acceptance-frontier-supersession-v1'
    and canonical_supersession->>'originalMembershipPreserved'='true'
    and canonical_supersession->>'completedAcceptanceEpochRewritten'='false'
    and canonical_supersession->>'productionPublicationAttempted'='false'
  ),
  schema_version text not null check(
    schema_version='truth-gmail-acceptance-membership-supersession-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,obligation_id,source_job_id),
  foreign key(workspace_key,obligation_id,source_job_id)
    references public.truth_pending_acceptance_epoch_manifests(
      workspace_key,obligation_id,source_job_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key,source_job_id)
    references public.truth_gmail_documented_claim_defect_exclusions(
      workspace_key,source_job_id
    ) on update restrict on delete restrict,
  check(supersession_id=
    'truth-gmail-acceptance-membership-supersession:v1:'||supersession_hash),
  check(supersession_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_supersession),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_supersession->>'workspaceKey'=workspace_key),
  check(canonical_supersession->>'obligationId'=obligation_id),
  check(canonical_supersession->>'sourceJobId'=source_job_id::text),
  check(canonical_supersession->>'priorMembershipHash'=prior_membership_hash),
  check(canonical_supersession->>'priorWorkerResultHash'=prior_worker_result_hash),
  check(canonical_supersession->>'supersedingWorkerResultHash'
    =superseding_worker_result_hash),
  check(canonical_supersession->>'defectExclusionId'=defect_exclusion_id)
);

drop trigger if exists truth_gmail_acceptance_membership_supersessions_immutable
  on public.truth_gmail_acceptance_membership_supersessions;
create trigger truth_gmail_acceptance_membership_supersessions_immutable
before update or delete on public.truth_gmail_acceptance_membership_supersessions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_acceptance_membership_supersessions enable row level security;
alter table public.truth_gmail_acceptance_membership_supersessions force row level security;
revoke all on public.truth_gmail_acceptance_membership_supersessions
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_acceptance_membership_supersessions to service_role;

do $mint$
declare
  v_item record;
  v_receipt jsonb;
  v_hash text;
begin
  for v_item in
    select membership.workspace_key,membership.obligation_id,
      membership.source_job_id,membership.membership_hash,
      membership.worker_result_hash,receipt.exclusion_id,
      encode(extensions.digest(convert_to(private.truth_canonical_json_text(
        job.result-array[
          'truthPlan','completionHash','resultObservationIds','childJobs',
          'rootBatchId','sourceCursorVersion','sourceCursorValue'
        ]::text[]
      ),'UTF8'),'sha256'),'hex') current_worker_result_hash
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.source_processing_jobs job
      on job.workspace_key=membership.workspace_key
     and job.job_id=membership.source_job_id
    join public.truth_gmail_documented_claim_defect_exclusions receipt
      on receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id
     and receipt.canonical_exclusion->>'authorityVersion'
       ='truth-gmail-parent-planning-v2-defect-terminal-v1'
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id
     and manifest.candidate_count=0
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.state='succeeded'
      and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
      and membership.worker_result_hash<>encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(job.result-array[
          'truthPlan','completionHash','resultObservationIds','childJobs',
          'rootBatchId','sourceCursorVersion','sourceCursorValue'
        ]::text[]),'UTF8'),'sha256'),'hex')
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=membership.workspace_key
          and epoch.obligation_id=membership.obligation_id)
      and not exists(select 1
        from public.truth_gmail_acceptance_membership_supersessions existing
        where existing.workspace_key=membership.workspace_key
          and existing.obligation_id=membership.obligation_id
          and existing.source_job_id=membership.source_job_id)
    order by membership.obligation_id,membership.source_job_id
    for update of job
  loop
    v_receipt:=jsonb_build_object(
      'schemaVersion','truth-gmail-acceptance-membership-supersession-v1',
      'authorityVersion',
        'truth-gmail-documented-defect-acceptance-frontier-supersession-v1',
      'workspaceKey',v_item.workspace_key,
      'obligationId',v_item.obligation_id,
      'sourceJobId',v_item.source_job_id,
      'priorMembershipHash',v_item.membership_hash,
      'priorWorkerResultHash',v_item.worker_result_hash,
      'supersedingWorkerResultHash',v_item.current_worker_result_hash,
      'defectExclusionId',v_item.exclusion_id,
      'cause','documented_defect_terminal_result_superseded_prior_membership_result',
      'originalMembershipPreserved',true,
      'completedAcceptanceEpochRewritten',false,
      'frontierRecomputedAtAcceptance',true,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_receipt),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_acceptance_membership_supersessions(
      supersession_id,supersession_hash,workspace_key,obligation_id,
      source_job_id,prior_membership_hash,prior_worker_result_hash,
      superseding_worker_result_hash,defect_exclusion_id,
      canonical_supersession,schema_version
    ) values(
      'truth-gmail-acceptance-membership-supersession:v1:'||v_hash,
      v_hash,v_item.workspace_key,v_item.obligation_id,v_item.source_job_id,
      v_item.membership_hash,v_item.worker_result_hash,
      v_item.current_worker_result_hash,v_item.exclusion_id,v_receipt,
      'truth-gmail-acceptance-membership-supersession-v1'
    );
  end loop;
end;
$mint$;

create or replace function private.truth_effective_acceptance_worker_result_hash_v1(
  p_workspace_key text,p_obligation_id text,p_source_job_id uuid,
  p_membership_hash text,p_worker_result_hash text
)
returns text
language sql
stable
security definer
set search_path=''
as $function$
  select coalesce((select supersession.superseding_worker_result_hash
    from public.truth_gmail_acceptance_membership_supersessions supersession
    where supersession.workspace_key=p_workspace_key
      and supersession.obligation_id=p_obligation_id
      and supersession.source_job_id=p_source_job_id
      and supersession.prior_membership_hash=p_membership_hash
      and supersession.prior_worker_result_hash=p_worker_result_hash
      and supersession.supersession_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(supersession.canonical_supersession),
        'UTF8'),'sha256'),'hex')
  ),p_worker_result_hash)
$function$;

revoke all on function private.truth_effective_acceptance_worker_result_hash_v1(
  text,text,uuid,text,text
) from public,anon,authenticated,service_role;

do $rewrite_runtime$
declare
  v_signature regprocedure:=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old_validation text:=$old$membership.worker_result_hash is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.result - array[
            'truthPlan', 'completionHash', 'resultObservationIds', 'childJobs',
            'rootBatchId', 'sourceCursorVersion', 'sourceCursorValue'
          ]::text[]), 'UTF8'
        ), 'sha256'), 'hex')$old$;
  v_new_validation text:=$new$private.truth_effective_acceptance_worker_result_hash_v1(
          membership.workspace_key,membership.obligation_id,membership.source_job_id,
          membership.membership_hash,membership.worker_result_hash
        ) is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.result - array[
            'truthPlan', 'completionHash', 'resultObservationIds', 'childJobs',
            'rootBatchId', 'sourceCursorVersion', 'sourceCursorValue'
          ]::text[]), 'UTF8'
        ), 'sha256'), 'hex')$new$;
  v_old_frontier text:=$old$'workerResultHash', membership.worker_result_hash,$old$;
  v_new_frontier text:=$new$'workerResultHash',
      private.truth_effective_acceptance_worker_result_hash_v1(
        membership.workspace_key,membership.obligation_id,membership.source_job_id,
        membership.membership_hash,membership.worker_result_hash
      ),$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_effective_acceptance_worker_result_hash_v1' in v_definition)=0 then
    if position(v_old_validation in v_definition)=0
      or position(v_old_frontier in v_definition)=0 then
      raise exception 'acceptance frontier supersession rewrite did not match installed runtime'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old_validation,v_new_validation);
    v_definition:=replace(v_definition,v_old_frontier,v_new_frontier);
    execute v_definition;
  end if;
end;
$rewrite_runtime$;

do $verify$
declare
  v_definition text;
begin
  if exists(
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.source_processing_jobs job
      on job.workspace_key=membership.workspace_key
     and job.job_id=membership.source_job_id
    join public.truth_gmail_documented_claim_defect_exclusions receipt
      on receipt.workspace_key=job.workspace_key and receipt.source_job_id=job.job_id
     and receipt.canonical_exclusion->>'authorityVersion'
       ='truth-gmail-parent-planning-v2-defect-terminal-v1'
    where job.workspace_key='primary' and job.connection_key='primary'
      and job.state='succeeded'
      and job.processor_version='truth-gmail-parent-planning-v2-defect-terminal-v1'
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=membership.workspace_key
          and epoch.obligation_id=membership.obligation_id)
      and private.truth_effective_acceptance_worker_result_hash_v1(
        membership.workspace_key,membership.obligation_id,membership.source_job_id,
        membership.membership_hash,membership.worker_result_hash
      ) is distinct from encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(job.result-array[
          'truthPlan','completionHash','resultObservationIds','childJobs',
          'rootBatchId','sourceCursorVersion','sourceCursorValue'
        ]::text[]),'UTF8'),'sha256'),'hex')
  ) then
    raise exception 'documented-defect acceptance membership supersession is incomplete'
      using errcode='23514';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if (length(v_definition)-length(replace(
      v_definition,'truth_effective_acceptance_worker_result_hash_v1','')))
      /length('truth_effective_acceptance_worker_result_hash_v1')<>2 then
    raise exception 'acceptance runtime lacks exact validation/frontier supersession wiring'
      using errcode='23514';
  end if;
end;
$verify$;
