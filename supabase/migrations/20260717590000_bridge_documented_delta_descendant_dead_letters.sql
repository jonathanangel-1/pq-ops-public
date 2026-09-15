-- Bridge already-documented descendant failures into the exact cutover-delta
-- plan census. This does not create a new defect finding: every bridge row
-- cross-references an immutable receipt from its originating authority.
-- Unreceipted dead descendants remain hard finalizer blockers.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_invalid_argument_terminalizations') is null
    or to_regclass('public.truth_gmail_attachment_cross_authority_invalid_terminalizations') is null
    or to_regclass('public.truth_gmail_documented_claim_defect_exclusions') is null
    or to_regprocedure(
      'private.finalize_truth_gmail_cutover_delta_reconciliation_v1(text,text)'
    ) is null then
    raise exception 'documented delta descendant bridge prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_cutover_delta_descendant_defect_bridges (
  bridge_id text primary key check(
    bridge_id='truth-gmail-cutover-delta-descendant-defect-bridge:v1:'||bridge_hash
  ),
  bridge_hash text not null unique check(bridge_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  plan_id text not null,
  root_batch_id uuid not null,
  source_job_id uuid not null,
  source_job_kind text not null check(source_job_kind=any(array[
    'gmail_review_attachment_extraction','gmail_extract_message_claims'
  ])),
  source_error_code text not null check(source_error_code=any(array[
    'OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT',
    'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ])),
  source_error_detail_hash text not null check(source_error_detail_hash~'^[0-9a-f]{64}$'),
  authority_family text not null check(authority_family=any(array[
    'attachment_invalid_argument_terminalization',
    'attachment_cross_authority_invalid_terminalization',
    'documented_claim_defect_exclusion'
  ])),
  authority_receipt_id text not null,
  authority_receipt_hash text not null check(authority_receipt_hash~'^[0-9a-f]{64}$'),
  canonical_bridge jsonb not null check(
    canonical_bridge->>'descendantRemainsDeadLettered'='true'
    and canonical_bridge->>'underlyingAuthorityPreserved'='true'
    and canonical_bridge->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,plan_id,source_job_id),
  foreign key(workspace_key,plan_id)
    references public.truth_gmail_cutover_delta_plans(workspace_key,plan_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(bridge_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_bridge),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_cutover_delta_descendant_defect_bridges_immutable
  on public.truth_gmail_cutover_delta_descendant_defect_bridges;
create trigger truth_gmail_cutover_delta_descendant_defect_bridges_immutable
before update or delete on public.truth_gmail_cutover_delta_descendant_defect_bridges
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_cutover_delta_descendant_defect_bridges
  enable row level security;
alter table public.truth_gmail_cutover_delta_descendant_defect_bridges
  force row level security;
revoke all on table public.truth_gmail_cutover_delta_descendant_defect_bridges
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_cutover_delta_descendant_defect_bridges
  to service_role;

create or replace function private.truth_gmail_cutover_delta_descendant_bridge_valid_v1(
  p_bridge public.truth_gmail_cutover_delta_descendant_defect_bridges
) returns boolean language plpgsql stable security definer set search_path='' as $function$
declare v_valid boolean:=false;
begin
  if p_bridge.bridge_hash<>encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(p_bridge.canonical_bridge),'UTF8'
    ),'sha256'),'hex')
    or p_bridge.bridge_id<>
      'truth-gmail-cutover-delta-descendant-defect-bridge:v1:'||p_bridge.bridge_hash
    or p_bridge.canonical_bridge->>'planId'<>p_bridge.plan_id
    or p_bridge.canonical_bridge->>'rootBatchId'<>p_bridge.root_batch_id::text
    or p_bridge.canonical_bridge->>'sourceJobId'<>p_bridge.source_job_id::text
    or p_bridge.canonical_bridge->>'sourceJobKind'<>p_bridge.source_job_kind
    or p_bridge.canonical_bridge->>'sourceErrorCode'<>p_bridge.source_error_code
    or p_bridge.canonical_bridge->>'sourceErrorDetailHash'<>p_bridge.source_error_detail_hash
    or p_bridge.canonical_bridge->>'authorityFamily'<>p_bridge.authority_family
    or p_bridge.canonical_bridge->>'authorityReceiptId'<>p_bridge.authority_receipt_id
    or p_bridge.canonical_bridge->>'authorityReceiptHash'<>p_bridge.authority_receipt_hash
    or p_bridge.canonical_bridge->>'productionPublicationAttempted'<>'false' then
    return false;
  end if;
  if p_bridge.authority_family='attachment_invalid_argument_terminalization' then
    select exists(select 1
      from public.truth_gmail_attachment_invalid_argument_terminalizations receipt
      where receipt.workspace_key=p_bridge.workspace_key
        and receipt.source_job_id=p_bridge.source_job_id
        and receipt.terminalization_id=p_bridge.authority_receipt_id
        and receipt.terminalization_hash=p_bridge.authority_receipt_hash)
      into v_valid;
  elsif p_bridge.authority_family=
      'attachment_cross_authority_invalid_terminalization' then
    select exists(select 1
      from public.truth_gmail_attachment_cross_authority_invalid_terminalizations receipt
      where receipt.workspace_key=p_bridge.workspace_key
        and receipt.source_job_id=p_bridge.source_job_id
        and receipt.terminalization_id=p_bridge.authority_receipt_id
        and receipt.terminalization_hash=p_bridge.authority_receipt_hash)
      into v_valid;
  elsif p_bridge.authority_family='documented_claim_defect_exclusion' then
    select exists(select 1
      from public.truth_gmail_documented_claim_defect_exclusions receipt
      where receipt.workspace_key=p_bridge.workspace_key
        and receipt.source_job_id=p_bridge.source_job_id
        and receipt.exclusion_id=p_bridge.authority_receipt_id
        and receipt.exclusion_hash=p_bridge.authority_receipt_hash)
      into v_valid;
  end if;
  return coalesce(v_valid,false);
end;
$function$;
revoke all on function private.truth_gmail_cutover_delta_descendant_bridge_valid_v1(
  public.truth_gmail_cutover_delta_descendant_defect_bridges
) from public,anon,authenticated,service_role;

do $backfill$
declare v_row record; v_body jsonb; v_hash text;
begin
  for v_row in
    select plan.plan_id,plan.plan_hash,chunk.root_batch_id,job.job_id,
      job.job_kind,job.last_error_code,job.safe_error_detail,
      receipt.authority_family,receipt.receipt_id,receipt.receipt_hash
    from public.truth_gmail_cutover_delta_plans plan
    join public.truth_gmail_cutover_delta_chunks chunk on chunk.plan_id=plan.plan_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=plan.workspace_key
     and lineage.source_system='gmail' and lineage.connection_key='primary'
     and lineage.root_batch_id=chunk.root_batch_id
    join public.source_processing_jobs job
      on job.workspace_key=lineage.workspace_key and job.job_id=lineage.job_id
     and job.state='dead_letter'
    join lateral (
      select 'attachment_invalid_argument_terminalization'::text authority_family,
        native.terminalization_id receipt_id,native.terminalization_hash receipt_hash
      from public.truth_gmail_attachment_invalid_argument_terminalizations native
      where job.job_kind='gmail_review_attachment_extraction'
        and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
        and native.workspace_key=job.workspace_key and native.source_job_id=job.job_id
      union all
      select 'attachment_cross_authority_invalid_terminalization',
        cross_terminal.terminalization_id,cross_terminal.terminalization_hash
      from public.truth_gmail_attachment_cross_authority_invalid_terminalizations cross_terminal
      where job.job_kind='gmail_review_attachment_extraction'
        and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
        and cross_terminal.workspace_key=job.workspace_key
        and cross_terminal.source_job_id=job.job_id
      union all
      select 'documented_claim_defect_exclusion',documented.exclusion_id,
        documented.exclusion_hash
      from public.truth_gmail_documented_claim_defect_exclusions documented
      where job.job_kind='gmail_extract_message_claims'
        and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
        and documented.workspace_key=job.workspace_key
        and documented.source_job_id=job.job_id
    ) receipt on true
    where plan.workspace_key='primary' and plan.connection_key='primary'
      and not exists(select 1 from public.truth_gmail_cutover_delta_seals seal
        where seal.plan_id=plan.plan_id)
    order by plan.plan_id,chunk.root_batch_id,job.job_id,receipt.authority_family
  loop
    if exists(select 1 from public.truth_gmail_cutover_delta_descendant_defect_bridges prior
      where prior.workspace_key='primary' and prior.plan_id=v_row.plan_id
        and prior.source_job_id=v_row.job_id) then continue; end if;
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-cutover-delta-descendant-defect-bridge-v1',
      'authorityVersion','truth-gmail-delta-documented-descendant-bridge-v1',
      'workspaceKey','primary','connectionKey','primary',
      'planId',v_row.plan_id,'planHash',v_row.plan_hash,
      'rootBatchId',v_row.root_batch_id,'sourceJobId',v_row.job_id,
      'sourceJobKind',v_row.job_kind,'sourceErrorCode',v_row.last_error_code,
      'sourceErrorDetailHash',encode(extensions.digest(convert_to(
        v_row.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'authorityFamily',v_row.authority_family,
      'authorityReceiptId',v_row.receipt_id,
      'authorityReceiptHash',v_row.receipt_hash,
      'descendantRemainsDeadLettered',true,
      'underlyingAuthorityPreserved',true,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_cutover_delta_descendant_defect_bridges(
      bridge_id,bridge_hash,workspace_key,connection_key,plan_id,root_batch_id,
      source_job_id,source_job_kind,source_error_code,source_error_detail_hash,
      authority_family,authority_receipt_id,authority_receipt_hash,canonical_bridge
    ) values('truth-gmail-cutover-delta-descendant-defect-bridge:v1:'||v_hash,
      v_hash,'primary','primary',v_row.plan_id,v_row.root_batch_id,v_row.job_id,
      v_row.job_kind,v_row.last_error_code,v_body->>'sourceErrorDetailHash',
      v_row.authority_family,v_row.receipt_id,v_row.receipt_hash,v_body);
  end loop;
end;
$backfill$;

-- Preserve every finalizer precondition; exclude only a dead descendant with
-- an exact, valid plan-scoped bridge to its original immutable authority.
do $finalizer_rewrite$
declare
  v_signature regprocedure:=
    'private.finalize_truth_gmail_cutover_delta_reconciliation_v1(text,text)'::regprocedure;
  v_definition text;
  v_old text:=$old$      and not exists (
        select 1 from public.truth_gmail_cutover_delta_frontier_exclusions exclusion
        where exclusion.workspace_key=job.workspace_key
          and exclusion.plan_id=p_plan_id
          and exclusion.claim_job_id=job.job_id
      )$old$;
  v_new text:=v_old||$new$
      and not exists (
        select 1 from public.truth_gmail_cutover_delta_descendant_defect_bridges bridge
        where bridge.workspace_key=job.workspace_key
          and bridge.plan_id=p_plan_id
          and bridge.root_batch_id=chunk.root_batch_id
          and bridge.source_job_id=job.job_id
          and bridge.source_job_kind=job.job_kind
          and bridge.source_error_code=job.last_error_code
          and bridge.source_error_detail_hash=encode(extensions.digest(
            convert_to(job.safe_error_detail,'UTF8'),'sha256'),'hex')
          and private.truth_gmail_cutover_delta_descendant_bridge_valid_v1(bridge)
      )$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_cutover_delta_descendant_defect_bridges bridge'
      in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'delta descendant bridge finalizer anchor drifted'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old,v_new);
    execute v_definition;
  end if;
end;
$finalizer_rewrite$;

do $verify$
begin
  if exists(select 1
    from public.truth_gmail_cutover_delta_descendant_defect_bridges bridge
    where not private.truth_gmail_cutover_delta_descendant_bridge_valid_v1(bridge)) then
    raise exception 'invalid cutover-delta descendant bridge was recorded'
      using errcode='23514';
  end if;
  if position('truth_gmail_cutover_delta_descendant_defect_bridges bridge' in
    pg_get_functiondef(
      'private.finalize_truth_gmail_cutover_delta_reconciliation_v1(text,text)'::regprocedure
    ))=0 then
    raise exception 'cutover-delta descendant bridge finalizer is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
