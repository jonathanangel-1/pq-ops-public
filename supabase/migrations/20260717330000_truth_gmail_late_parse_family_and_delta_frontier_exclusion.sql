-- Extend late-parse reconciliation across both historical Gmail parse job
-- vocabularies and provide an explicit, operator-invoked delta-frontier
-- exclusion receipt. Exclusions never complete or rewrite claim jobs.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $parse_family$
declare v_signature regprocedure; v_definition text;
begin
  foreach v_signature in array array[
    'private.reconcile_truth_gmail_checkpoint_late_parse_v1(text,uuid)'::regprocedure,
    'private.route_truth_gmail_checkpoint_late_parse_parent_v1()'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    if position('gmail_parse_message' in v_definition)=0 then
      v_definition:=replace(v_definition,
        $old$parse_job.job_kind='gmail_parse_rfc822'$old$,
        $new$parse_job.job_kind=any(array['gmail_parse_rfc822','gmail_parse_message'])$new$);
      v_definition:=replace(v_definition,
        $old$new.job_kind='gmail_parse_rfc822'$old$,
        $new$new.job_kind=any(array['gmail_parse_rfc822','gmail_parse_message'])$new$);
      if position('gmail_parse_message' in v_definition)=0 then
        raise exception 'late-parse family rewrite did not match %',v_signature
          using errcode='23514';
      end if;
      execute v_definition;
    end if;
  end loop;
end;
$parse_family$;

-- One-time catch-up for children and parents that were already terminal before
-- the 320000 triggers existed. Reapplication also catches later arrivals.
do $backfill$
declare v_job record;
begin
  for v_job in
    select job.workspace_key,job.job_id
    from public.source_processing_jobs job
    where job.source_system='gmail' and job.job_kind='gmail_resolve_entity_links'
      and job.state='waiting_runtime'
      and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    order by job.workspace_key,job.job_id
  loop
    perform private.reconcile_truth_gmail_checkpoint_late_parse_v1(
      v_job.workspace_key,v_job.job_id);
  end loop;
end;
$backfill$;

create unique index if not exists truth_gmail_cutover_delta_plans_workspace_plan_key
  on public.truth_gmail_cutover_delta_plans(workspace_key,plan_id);

create table if not exists public.truth_gmail_cutover_delta_frontier_exclusions (
  exclusion_id text primary key check(
    exclusion_id='truth-gmail-cutover-delta-frontier-exclusion:v1:'||exclusion_hash),
  exclusion_hash text not null unique check(exclusion_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  plan_id text not null,
  root_batch_id uuid not null,
  checkpoint_id text not null,
  checkpoint_hash text not null check(checkpoint_hash~'^[0-9a-f]{64}$'),
  claim_job_id uuid not null,
  claim_job_kind text not null check(claim_job_kind=any(array[
    'gmail_extract_message_claims','gmail_extract_attachment_claims'])),
  prior_job_state text not null check(prior_job_state=any(array[
    'waiting_runtime','queued','retry_wait','dead_letter'])),
  prior_error_code text not null,
  reason_code text not null check(
    reason_code='DOCUMENTED_LATE_PARSE_CHECKPOINT_DEFECT'),
  canonical_exclusion jsonb not null check(
    jsonb_typeof(canonical_exclusion)='object'
    and canonical_exclusion->>'claimsRemainPending'='true'
    and canonical_exclusion->>'productionPublicationAttempted'='false'),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,plan_id,claim_job_id),
  foreign key(workspace_key,plan_id)
    references public.truth_gmail_cutover_delta_plans(workspace_key,plan_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,claim_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(exclusion_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_exclusion),'UTF8'),'sha256'),'hex'))
);
drop trigger if exists truth_gmail_cutover_delta_frontier_exclusions_immutable
  on public.truth_gmail_cutover_delta_frontier_exclusions;
create trigger truth_gmail_cutover_delta_frontier_exclusions_immutable
before update or delete on public.truth_gmail_cutover_delta_frontier_exclusions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_cutover_delta_frontier_exclusions enable row level security;
alter table public.truth_gmail_cutover_delta_frontier_exclusions force row level security;
revoke all on public.truth_gmail_cutover_delta_frontier_exclusions
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_cutover_delta_frontier_exclusions to service_role;

create or replace function private.authorize_truth_gmail_cutover_delta_frontier_exclusion_v1(
  p_plan_id text,p_root_batch_id uuid,p_reason_code text,p_sync_token text
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare v_plan public.truth_gmail_cutover_delta_plans%rowtype;
  v_checkpoint public.gmail_parse_checkpoints%rowtype;
  v_job record; v_body jsonb; v_hash text; v_id text; v_count integer:=0;
  v_checkpoint_complete boolean;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000'; end if;
  if p_reason_code<>'DOCUMENTED_LATE_PARSE_CHECKPOINT_DEFECT' then
    raise exception 'unsupported delta-frontier exclusion reason' using errcode='22023'; end if;
  select * into strict v_plan from public.truth_gmail_cutover_delta_plans
    where plan_id=p_plan_id and workspace_key='primary' and connection_key='primary';
  if not exists(select 1 from public.truth_gmail_cutover_delta_chunks chunk
    where chunk.plan_id=p_plan_id and chunk.root_batch_id=p_root_batch_id) then
    raise exception 'delta-frontier exclusion batch is outside the exact plan'
      using errcode='23514'; end if;
  select * into strict v_checkpoint from public.gmail_parse_checkpoints
    where workspace_key='primary' and root_batch_id=p_root_batch_id
      and terminal_gap_count>0;
  if not exists(select 1 from public.gmail_parse_checkpoint_members member
    where member.workspace_key='primary' and member.root_batch_id=p_root_batch_id
      and member.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
      and not exists(select 1
        from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
        where reconciliation.workspace_key=member.workspace_key
          and reconciliation.gap_member_id=member.member_id)) then
    raise exception 'delta-frontier exclusion lacks an unresolved checkpoint defect'
      using errcode='23514'; end if;
  for v_job in select job.* from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    where job.workspace_key='primary' and job.connection_key='primary'
      and lineage.root_batch_id=p_root_batch_id
      and job.job_kind=any(array['gmail_extract_message_claims','gmail_extract_attachment_claims'])
      and job.state in ('waiting_runtime','queued','retry_wait','dead_letter')
      and (job.last_error_code in ('GMAIL_LINK_EPOCH_SEAL_REQUIRED','GMAIL_LINK_EPOCH_SCHEMA_REQUIRED')
        or position('link epoch' in lower(job.safe_error_detail))>0)
    order by job.job_id
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-cutover-delta-frontier-exclusion-v1',
      'authorityVersion','truth-gmail-delta-documented-defect-bound-v1',
      'workspaceKey','primary','connectionKey','primary','planId',p_plan_id,
      'planHash',v_plan.plan_hash,'rootBatchId',p_root_batch_id,
      'checkpointId',v_checkpoint.checkpoint_id,'checkpointHash',v_checkpoint.checkpoint_hash,
      'claimJobId',v_job.job_id,'claimJobKind',v_job.job_kind,
      'priorJobState',v_job.state,'priorErrorCode',v_job.last_error_code,
      'reasonCode',p_reason_code,'claimsRemainPending',true,
      'productionPublicationAttempted',false);
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id:='truth-gmail-cutover-delta-frontier-exclusion:v1:'||v_hash;
    insert into public.truth_gmail_cutover_delta_frontier_exclusions(
      exclusion_id,exclusion_hash,workspace_key,connection_key,plan_id,
      root_batch_id,checkpoint_id,checkpoint_hash,claim_job_id,claim_job_kind,
      prior_job_state,prior_error_code,reason_code,canonical_exclusion)
    values(v_id,v_hash,'primary','primary',p_plan_id,p_root_batch_id,
      v_checkpoint.checkpoint_id,v_checkpoint.checkpoint_hash,v_job.job_id,
      v_job.job_kind,v_job.state,v_job.last_error_code,p_reason_code,v_body)
    on conflict(workspace_key,plan_id,claim_job_id) do nothing;
    v_count:=v_count+1;
  end loop;
  if v_count=0 then raise exception 'delta-frontier exclusion found no defect-bound claims'
    using errcode='55000'; end if;
  execute 'select private.truth_gmail_cutover_delta_checkpoint_complete_v2($1,$2)'
    into v_checkpoint_complete using p_plan_id,v_checkpoint;
  if not v_checkpoint_complete then
    raise exception 'delta-frontier exclusion left an unreceipted claim producer'
      using errcode='23514';
  end if;
  return jsonb_build_object('ok',true,'planId',p_plan_id,
    'rootBatchId',p_root_batch_id,'excludedClaimCount',v_count,
    'claimsRemainPending',true,'productionPublicationAttempted',false);
end;
$function$;

create or replace function public.authorize_truth_gmail_cutover_delta_frontier_exclusion(
  p_plan_id text,p_root_batch_id uuid,p_reason_code text,p_sync_token text
)
returns jsonb language sql security definer set search_path=''
as $function$
  select private.authorize_truth_gmail_cutover_delta_frontier_exclusion_v1(
    p_plan_id,p_root_batch_id,p_reason_code,p_sync_token);
$function$;
revoke all on function private.authorize_truth_gmail_cutover_delta_frontier_exclusion_v1(
  text,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.authorize_truth_gmail_cutover_delta_frontier_exclusion(
  text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.authorize_truth_gmail_cutover_delta_frontier_exclusion(
  text,uuid,text,text) to service_role;

create or replace function private.truth_gmail_cutover_delta_checkpoint_complete_v2(
  p_plan_id text,p_checkpoint public.gmail_parse_checkpoints
)
returns boolean language sql stable security definer set search_path=''
as $function$
  select p_checkpoint.terminal_gap_count=0 or (
    not exists(select 1 from public.gmail_parse_checkpoint_members gap
      where gap.workspace_key=p_checkpoint.workspace_key
        and gap.root_batch_id=p_checkpoint.root_batch_id
        and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
        and not exists(select 1
          from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
          where reconciliation.workspace_key=gap.workspace_key
            and reconciliation.gap_member_id=gap.member_id))
    or (
      exists(select 1 from public.truth_gmail_cutover_delta_frontier_exclusions exclusion
        where exclusion.workspace_key=p_checkpoint.workspace_key
          and exclusion.plan_id=p_plan_id
          and exclusion.root_batch_id=p_checkpoint.root_batch_id)
      and not exists(
        select 1
        from public.source_processing_jobs claim_job
        join public.source_processing_job_lineage lineage
          on lineage.workspace_key=claim_job.workspace_key
          and lineage.job_id=claim_job.job_id
        where claim_job.workspace_key=p_checkpoint.workspace_key
          and lineage.root_batch_id=p_checkpoint.root_batch_id
          and claim_job.job_kind=any(array[
            'gmail_extract_message_claims','gmail_extract_attachment_claims'])
          and claim_job.state in ('waiting_runtime','queued','retry_wait','dead_letter')
          and not exists(
            select 1
            from public.truth_gmail_cutover_delta_frontier_exclusions exclusion
            where exclusion.workspace_key=claim_job.workspace_key
              and exclusion.plan_id=p_plan_id
              and exclusion.root_batch_id=p_checkpoint.root_batch_id
              and exclusion.claim_job_id=claim_job.job_id
          )
      )
    )
  );
$function$;
revoke all on function private.truth_gmail_cutover_delta_checkpoint_complete_v2(
  text,public.gmail_parse_checkpoints) from public,anon,authenticated,service_role;

-- Preserve the large reviewed finalizer byte-for-byte except for its two
-- completeness predicates: effective checkpoint completion and receipted
-- dead claim exclusions.
do $finalizer_rewrite$
declare v_signature regprocedure :=
  'private.finalize_truth_gmail_cutover_delta_reconciliation_v1(text,text)'::regprocedure;
  v_definition text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_cutover_delta_checkpoint_complete_v2' in v_definition)=0 then
    v_definition:=replace(v_definition,
      $old$and checkpoint.terminal_gap_count = 0$old$,
      $new$and private.truth_gmail_cutover_delta_checkpoint_complete_v2(p_plan_id,checkpoint)$new$);
    v_definition:=replace(v_definition,
      $old$and job.state = 'dead_letter'
    where chunk.plan_id = p_plan_id$old$,
      $new$and job.state = 'dead_letter'
    where chunk.plan_id = p_plan_id
      and not exists (
        select 1 from public.truth_gmail_cutover_delta_frontier_exclusions exclusion
        where exclusion.workspace_key=job.workspace_key
          and exclusion.plan_id=p_plan_id
          and exclusion.claim_job_id=job.job_id
      )$new$);
    if position('truth_gmail_cutover_delta_checkpoint_complete_v2' in v_definition)=0
      or position('truth_gmail_cutover_delta_frontier_exclusions exclusion' in v_definition)=0 then
      raise exception 'delta finalizer exclusion rewrite was incomplete'
        using errcode='23514'; end if;
    execute v_definition;
  end if;
end;
$finalizer_rewrite$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.reconcile_truth_gmail_checkpoint_late_parse_v1(text,uuid)'::regprocedure)
    into v_definition;
  if position('gmail_parse_rfc822' in v_definition)=0
    or position('gmail_parse_message' in v_definition)=0 then
    raise exception 'late parse family authority is incomplete' using errcode='23514'; end if;
  select pg_get_functiondef(
    'private.finalize_truth_gmail_cutover_delta_reconciliation_v1(text,text)'::regprocedure)
    into v_definition;
  if position('truth_gmail_cutover_delta_checkpoint_complete_v2' in v_definition)=0 then
    raise exception 'delta fallback is not installed' using errcode='23514'; end if;
end;
$verify$;
