-- A provider-deleted-unavailable checkpoint member can never acquire parsed
-- evidence. Record that absence as a plan- and member-bound exclusion rather
-- than pretending a late parse occurred. This authority is limited to delta
-- chunk batches, validates the original Gmail revision obligation byte-for-
-- byte, and refuses while any claim producer for the batch is nonterminal.
-- No source evidence, claim, publication, or live-board row is changed.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_cutover_delta_plans') is null
    or to_regclass('public.truth_gmail_cutover_delta_chunks') is null
    or to_regclass('public.gmail_parse_checkpoint_members') is null
    or to_regclass('public.gmail_message_revision_obligations') is null
    or to_regprocedure(
      'private.truth_gmail_cutover_delta_checkpoint_complete_v2(text,public.gmail_parse_checkpoints)'
    ) is null then
    raise exception 'provider-deleted delta checkpoint prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create unique index if not exists gmail_parse_checkpoint_members_workspace_member_key
  on public.gmail_parse_checkpoint_members(workspace_key,member_id);

create table if not exists public.truth_gmail_cutover_delta_provider_deleted_exclusions (
  exclusion_id text primary key check(
    exclusion_id='truth-gmail-cutover-delta-provider-deleted-exclusion:v1:'||exclusion_hash
  ),
  exclusion_hash text not null unique check(exclusion_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  plan_id text not null,
  root_batch_id uuid not null,
  checkpoint_id text not null,
  checkpoint_hash text not null check(checkpoint_hash~'^[0-9a-f]{64}$'),
  checkpoint_member_id text not null unique,
  checkpoint_member_hash text not null check(checkpoint_member_hash~'^[0-9a-f]{64}$'),
  terminal_authority_id text not null,
  terminal_authority_hash text not null check(terminal_authority_hash~'^[0-9a-f]{64}$'),
  reason_code text not null check(reason_code='PROVIDER_DELETED_UNAVAILABLE_GAP'),
  canonical_exclusion jsonb not null check(
    canonical_exclusion->>'parsedEvidenceMinted'='false'
    and canonical_exclusion->>'claimsRemainPending'='false'
    and canonical_exclusion->>'productionPublicationAttempted'='false'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,plan_id,checkpoint_member_id),
  foreign key(workspace_key,plan_id)
    references public.truth_gmail_cutover_delta_plans(workspace_key,plan_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_member_id)
    references public.gmail_parse_checkpoint_members(workspace_key,member_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,terminal_authority_id)
    references public.gmail_message_revision_obligations(workspace_key,obligation_id)
    on update restrict on delete restrict,
  check(exclusion_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_exclusion),'UTF8'
  ),'sha256'),'hex'))
);

drop trigger if exists truth_gmail_cutover_delta_provider_deleted_exclusions_immutable
  on public.truth_gmail_cutover_delta_provider_deleted_exclusions;
create trigger truth_gmail_cutover_delta_provider_deleted_exclusions_immutable
before update or delete on public.truth_gmail_cutover_delta_provider_deleted_exclusions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_cutover_delta_provider_deleted_exclusions
  enable row level security;
alter table public.truth_gmail_cutover_delta_provider_deleted_exclusions
  force row level security;
revoke all on table public.truth_gmail_cutover_delta_provider_deleted_exclusions
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_cutover_delta_provider_deleted_exclusions
  to service_role;

create or replace function private.truth_gmail_cutover_delta_provider_deleted_exclusion_valid_v1(
  p_exclusion public.truth_gmail_cutover_delta_provider_deleted_exclusions
) returns boolean language sql stable security definer set search_path='' as $function$
  select p_exclusion.exclusion_hash=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(p_exclusion.canonical_exclusion),'UTF8'
    ),'sha256'),'hex')
    and p_exclusion.exclusion_id=
      'truth-gmail-cutover-delta-provider-deleted-exclusion:v1:'||p_exclusion.exclusion_hash
    and p_exclusion.canonical_exclusion->>'workspaceKey'=p_exclusion.workspace_key
    and p_exclusion.canonical_exclusion->>'connectionKey'=p_exclusion.connection_key
    and p_exclusion.canonical_exclusion->>'planId'=p_exclusion.plan_id
    and p_exclusion.canonical_exclusion->>'rootBatchId'=p_exclusion.root_batch_id::text
    and p_exclusion.canonical_exclusion->>'checkpointId'=p_exclusion.checkpoint_id
    and p_exclusion.canonical_exclusion->>'checkpointHash'=p_exclusion.checkpoint_hash
    and p_exclusion.canonical_exclusion->>'checkpointMemberId'=p_exclusion.checkpoint_member_id
    and p_exclusion.canonical_exclusion->>'checkpointMemberHash'=p_exclusion.checkpoint_member_hash
    and p_exclusion.canonical_exclusion->>'terminalAuthorityId'=p_exclusion.terminal_authority_id
    and p_exclusion.canonical_exclusion->>'terminalAuthorityHash'=p_exclusion.terminal_authority_hash
    and p_exclusion.canonical_exclusion->>'reasonCode'=p_exclusion.reason_code
    and p_exclusion.canonical_exclusion->>'parsedEvidenceMinted'='false'
    and p_exclusion.canonical_exclusion->>'claimsRemainPending'='false'
    and p_exclusion.canonical_exclusion->>'productionPublicationAttempted'='false'
$function$;
revoke all on function private.truth_gmail_cutover_delta_provider_deleted_exclusion_valid_v1(
  public.truth_gmail_cutover_delta_provider_deleted_exclusions
) from public,anon,authenticated,service_role;

do $backfill$
declare
  v_row record; v_body jsonb; v_hash text;
begin
  for v_row in
    select plan.plan_id,plan.plan_hash,chunk.root_batch_id,
      checkpoint.checkpoint_id,checkpoint.checkpoint_hash,
      member.member_id,member.member_hash,member.message_id,
      member.terminal_authority_id,member.terminal_authority_hash
    from public.truth_gmail_cutover_delta_plans plan
    join public.truth_gmail_cutover_delta_chunks chunk
      on chunk.plan_id=plan.plan_id
    join public.gmail_parse_checkpoints checkpoint
      on checkpoint.workspace_key=plan.workspace_key
     and checkpoint.root_batch_id=chunk.root_batch_id
     and checkpoint.connection_key='primary'
     and checkpoint.terminal_gap_count>0
    join public.gmail_parse_checkpoint_members member
      on member.workspace_key=checkpoint.workspace_key
     and member.root_batch_id=checkpoint.root_batch_id
     and member.terminal_disposition='provider_deleted_unavailable_gap'
    join public.gmail_message_revision_obligations obligation
      on obligation.workspace_key=member.workspace_key
     and obligation.obligation_id=member.terminal_authority_id
     and obligation.obligation_hash=member.terminal_authority_hash
     and obligation.root_batch_id=member.root_batch_id
     and obligation.fetch_job_id=member.materialization_job_id
     and obligation.message_id=member.message_id
     and obligation.reason_code='PROVIDER_MESSAGE_DELETED_UNAVAILABLE'
    where plan.workspace_key='primary' and plan.connection_key='primary'
      and not exists(select 1
        from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
        where reconciliation.workspace_key=member.workspace_key
          and reconciliation.gap_member_id=member.member_id)
      and not exists(select 1
        from public.source_processing_jobs claim_job
        join public.source_processing_job_lineage lineage
          on lineage.workspace_key=claim_job.workspace_key
         and lineage.job_id=claim_job.job_id
        where claim_job.workspace_key=member.workspace_key
          and lineage.root_batch_id=member.root_batch_id
          and claim_job.job_kind=any(array[
            'gmail_extract_message_claims','gmail_extract_attachment_claims'])
          and claim_job.state in ('waiting_runtime','queued','leased','retry_wait','dead_letter'))
    order by plan.plan_id,chunk.root_batch_id,member.member_id
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-cutover-delta-provider-deleted-exclusion-v1',
      'authorityVersion','truth-gmail-provider-deleted-checkpoint-boundary-v1',
      'workspaceKey','primary','connectionKey','primary',
      'planId',v_row.plan_id,'planHash',v_row.plan_hash,
      'rootBatchId',v_row.root_batch_id,'checkpointId',v_row.checkpoint_id,
      'checkpointHash',v_row.checkpoint_hash,
      'checkpointMemberId',v_row.member_id,
      'checkpointMemberHash',v_row.member_hash,
      'messageId',v_row.message_id,
      'terminalAuthorityId',v_row.terminal_authority_id,
      'terminalAuthorityHash',v_row.terminal_authority_hash,
      'reasonCode','PROVIDER_DELETED_UNAVAILABLE_GAP',
      'parsedEvidenceMinted',false,'claimsRemainPending',false,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_cutover_delta_provider_deleted_exclusions(
      exclusion_id,exclusion_hash,workspace_key,connection_key,plan_id,
      root_batch_id,checkpoint_id,checkpoint_hash,checkpoint_member_id,
      checkpoint_member_hash,terminal_authority_id,terminal_authority_hash,
      reason_code,canonical_exclusion
    ) values(
      'truth-gmail-cutover-delta-provider-deleted-exclusion:v1:'||v_hash,
      v_hash,'primary','primary',v_row.plan_id,v_row.root_batch_id,
      v_row.checkpoint_id,v_row.checkpoint_hash,v_row.member_id,v_row.member_hash,
      v_row.terminal_authority_id,v_row.terminal_authority_hash,
      'PROVIDER_DELETED_UNAVAILABLE_GAP',v_body
    ) on conflict(workspace_key,plan_id,checkpoint_member_id) do nothing;
  end loop;
end;
$backfill$;

-- A valid per-member deletion receipt satisfies only that exact terminal gap.
-- Other gap classes still require late-parse reconciliation or the older
-- claim-bound delta-frontier exclusion authority.
create or replace function private.truth_gmail_cutover_delta_checkpoint_complete_v2(
  p_plan_id text,p_checkpoint public.gmail_parse_checkpoints
) returns boolean language sql stable security definer set search_path='' as $function$
  select p_checkpoint.terminal_gap_count=0 or (
    not exists(select 1 from public.gmail_parse_checkpoint_members gap
      where gap.workspace_key=p_checkpoint.workspace_key
        and gap.root_batch_id=p_checkpoint.root_batch_id
        and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
        and not exists(select 1
          from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
          where reconciliation.workspace_key=gap.workspace_key
            and reconciliation.gap_member_id=gap.member_id)
        and not exists(select 1
          from public.truth_gmail_cutover_delta_provider_deleted_exclusions deletion
          where deletion.workspace_key=gap.workspace_key
            and deletion.plan_id=p_plan_id
            and deletion.root_batch_id=p_checkpoint.root_batch_id
            and deletion.checkpoint_member_id=gap.member_id
            and deletion.checkpoint_member_hash=gap.member_hash
            and deletion.reason_code='PROVIDER_DELETED_UNAVAILABLE_GAP'
            and private.truth_gmail_cutover_delta_provider_deleted_exclusion_valid_v1(deletion)))
    or (
      exists(select 1 from public.truth_gmail_cutover_delta_frontier_exclusions exclusion
        where exclusion.workspace_key=p_checkpoint.workspace_key
          and exclusion.plan_id=p_plan_id
          and exclusion.root_batch_id=p_checkpoint.root_batch_id)
      and not exists(
        select 1 from public.source_processing_jobs claim_job
        join public.source_processing_job_lineage lineage
          on lineage.workspace_key=claim_job.workspace_key
         and lineage.job_id=claim_job.job_id
        where claim_job.workspace_key=p_checkpoint.workspace_key
          and lineage.root_batch_id=p_checkpoint.root_batch_id
          and claim_job.job_kind=any(array[
            'gmail_extract_message_claims','gmail_extract_attachment_claims'])
          and claim_job.state in ('waiting_runtime','queued','retry_wait','dead_letter')
          and not exists(select 1
            from public.truth_gmail_cutover_delta_frontier_exclusions exclusion
            where exclusion.workspace_key=claim_job.workspace_key
              and exclusion.plan_id=p_plan_id
              and exclusion.root_batch_id=p_checkpoint.root_batch_id
              and exclusion.claim_job_id=claim_job.job_id)
      )
    )
  );
$function$;
revoke all on function private.truth_gmail_cutover_delta_checkpoint_complete_v2(
  text,public.gmail_parse_checkpoints) from public,anon,authenticated,service_role;

do $verify$
begin
  if exists(select 1
    from public.truth_gmail_cutover_delta_plans plan
    join public.truth_gmail_cutover_delta_chunks chunk on chunk.plan_id=plan.plan_id
    join public.gmail_parse_checkpoints checkpoint
      on checkpoint.workspace_key=plan.workspace_key
     and checkpoint.root_batch_id=chunk.root_batch_id
    where plan.workspace_key='primary' and plan.connection_key='primary'
      and checkpoint.terminal_gap_count>0
      and not exists(select 1 from public.gmail_parse_checkpoint_members member
        where member.workspace_key=checkpoint.workspace_key
          and member.root_batch_id=checkpoint.root_batch_id
          and member.terminal_disposition not in(
            'parsed_exact_revision','deleted_at_cut','provider_deleted_unavailable_gap'))
      and not exists(select 1
        from public.source_processing_jobs claim_job
        join public.source_processing_job_lineage lineage
          on lineage.workspace_key=claim_job.workspace_key
         and lineage.job_id=claim_job.job_id
        where claim_job.workspace_key=checkpoint.workspace_key
          and lineage.root_batch_id=checkpoint.root_batch_id
          and claim_job.job_kind=any(array[
            'gmail_extract_message_claims','gmail_extract_attachment_claims'])
          and claim_job.state in ('waiting_runtime','queued','leased','retry_wait','dead_letter'))
      and not private.truth_gmail_cutover_delta_checkpoint_complete_v2(
        plan.plan_id,checkpoint)) then
    raise exception 'provider-deleted delta checkpoint exclusion remained incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
