-- Close the Gmail link-enrollment producer vocabulary. Linkable observations
-- are durably produced by exactly these job families:
--   1. gmail_parse_rfc822             -> gmail_message_parsed
--   2. gmail_parse_message            -> gmail_message_parsed (legacy)
--   3. gmail_extract_attachment       -> gmail_attachment_extracted
--   4. gmail_review_attachment_extraction -> gmail_attachment_extracted
--      (model finalization currently spawns a claim child, not a link child;
--       it is admitted here so any designed link routing uses the same proof).
-- Each family must prove that its successful result names the exact immutable
-- observation consumed by the parked link job. The checkpoint gap remains
-- immutable; this migration only appends its reconciliation receipt.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create or replace function private.reconcile_truth_gmail_checkpoint_late_parse_v1(
  p_workspace_key text,p_link_job_id uuid
)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare
  v record; v_body jsonb; v_hash text; v_id text;
  v_member jsonb; v_member_hash text; v_member_id text;
begin
  if exists(select 1 from public.truth_gmail_parse_checkpoint_late_parse_reconciliations
    where workspace_key=p_workspace_key and link_job_id=p_link_job_id) then
    return false; end if;
  select job.observation_id,job.state,job.last_error_code,lineage.connection_key,
    lineage.root_batch_id,observation.content_hash,observation.source_object_id,
    observation.source_object_type,checkpoint.checkpoint_id,checkpoint.checkpoint_hash,
    gap.member_id gap_member_id,gap.member_hash gap_member_hash,
    gap.terminal_disposition,producer.job_id parse_job_id,
    producer.job_kind producer_job_kind,producer.result->>'schemaVersion' producer_result_schema,
    epoch.epoch_id,epoch.epoch_hash
  into v
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
  join public.source_observations observation
    on observation.workspace_key=job.workspace_key
   and observation.observation_id=job.observation_id
   and ((observation.source_object_type='gmail_message_parsed'
      and observation.normalized_payload->>'schemaVersion'='gmail-parsed-message-v2')
     or (observation.source_object_type='gmail_attachment_extracted'
      and observation.normalized_payload->>'schemaVersion'='gmail-attachment-extracted-v1'))
  join public.gmail_parse_checkpoints checkpoint
    on checkpoint.workspace_key=lineage.workspace_key
   and checkpoint.root_batch_id=lineage.root_batch_id
  join public.gmail_parse_checkpoint_members gap
    on gap.workspace_key=checkpoint.workspace_key
   and gap.root_batch_id=checkpoint.root_batch_id
   and gap.message_id=case when observation.source_object_type='gmail_message_parsed'
      then observation.source_object_id
      else coalesce(nullif(observation.normalized_payload#>>'{gmail,messageId}',''),
        nullif(observation.normalized_payload->>'messageId','')) end
   and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
  join public.source_processing_jobs producer
    on producer.workspace_key=job.workspace_key
   and producer.job_id=lineage.parent_job_id
   and producer.source_system='gmail'
   and producer.connection_key=job.connection_key
   and producer.state='succeeded'
   and ((producer.job_kind=any(array['gmail_parse_rfc822','gmail_parse_message'])
      and producer.result->>'schemaVersion'='gmail-parse-result-v2'
      and producer.result->'resultObservationIds' ? job.observation_id)
     or (producer.job_kind='gmail_extract_attachment'
      and producer.result->>'schemaVersion'='gmail-attachment-evidence-result-v1'
      and producer.result->>'attachmentObservationId'=job.observation_id)
     or (producer.job_kind='gmail_review_attachment_extraction'
      and producer.result->>'schemaVersion'='gmail-attachment-model-review-result-v1'
      and producer.result->>'derivedObservationId'=job.observation_id))
  left join public.truth_gmail_link_epochs epoch
    on epoch.workspace_key=lineage.workspace_key
   and epoch.root_batch_id=lineage.root_batch_id
  where job.workspace_key=p_workspace_key and job.job_id=p_link_job_id
    and job.source_system='gmail' and job.job_kind='gmail_resolve_entity_links'
    and job.state='waiting_runtime'
    and job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    and job.lease_owner is null and job.lease_expires_at is null
    and not exists(select 1 from public.truth_gmail_link_epoch_seals seal
      where seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id)
  order by producer.completed_at desc nulls last,producer.job_id limit 1
  for update of job;
  if not found then return false; end if;
  if (select count(*) from public.gmail_parse_checkpoint_members gap
    where gap.workspace_key=p_workspace_key and gap.root_batch_id=v.root_batch_id
      and gap.message_id=case when v.source_object_type='gmail_message_parsed'
        then v.source_object_id else (select coalesce(
          nullif(observation.normalized_payload#>>'{gmail,messageId}',''),
          nullif(observation.normalized_payload->>'messageId',''))
          from public.source_observations observation
          where observation.workspace_key=p_workspace_key
            and observation.observation_id=v.observation_id) end
      and gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut'))<>1 then
    raise exception 'late observation does not identify one exact checkpoint gap member'
      using errcode='23514'; end if;
  v_body:=jsonb_build_object(
    'schemaVersion','gmail-parse-checkpoint-late-parse-reconciliation-v1',
    'authorityVersion','gmail-checkpoint-late-observation-gap-reconciliation-v2',
    'workspaceKey',p_workspace_key,'connectionKey',v.connection_key,
    'rootBatchId',v.root_batch_id,'checkpointId',v.checkpoint_id,
    'checkpointHash',v.checkpoint_hash,'gapMemberId',v.gap_member_id,
    'gapMemberHash',v.gap_member_hash,'gapTerminalDisposition',v.terminal_disposition,
    'parseJobId',v.parse_job_id,'observationProducerJobId',v.parse_job_id,
    'observationProducerJobKind',v.producer_job_kind,
    'observationProducerResultSchema',v.producer_result_schema,
    'parsedObservationId',v.observation_id,
    'parsedObservationContentHash',v.content_hash,'linkJobId',p_link_job_id,
    'productionPublicationAttempted',false);
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  v_id:='gmail-parse-checkpoint-late-parse:v1:'||v_hash;
  insert into public.truth_gmail_parse_checkpoint_late_parse_reconciliations(
    reconciliation_id,reconciliation_hash,workspace_key,connection_key,
    root_batch_id,checkpoint_id,checkpoint_hash,gap_member_id,gap_member_hash,
    gap_terminal_disposition,parse_job_id,parsed_observation_id,
    parsed_observation_content_hash,link_job_id,canonical_reconciliation
  ) values(v_id,v_hash,p_workspace_key,v.connection_key,v.root_batch_id,
    v.checkpoint_id,v.checkpoint_hash,v.gap_member_id,v.gap_member_hash,
    v.terminal_disposition,v.parse_job_id,v.observation_id,v.content_hash,
    p_link_job_id,v_body);

  if v.epoch_id is not null then
    v_member:=jsonb_build_object('schemaVersion','gmail-link-epoch-member-v1',
      'workspaceKey',p_workspace_key,'epochId',v.epoch_id,'linkJobId',p_link_job_id,
      'observationId',v.observation_id,'observationContentHash',v.content_hash);
    v_member_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_member),'UTF8'),'sha256'),'hex');
    v_member_id:='gmail-link-epoch-member:v1:'||v_member_hash;
    insert into public.truth_gmail_link_epoch_members(workspace_key,epoch_id,
      link_job_id,observation_id,observation_content_hash,member_id,
      canonical_member,member_hash,schema_version)
    values(p_workspace_key,v.epoch_id,p_link_job_id,v.observation_id,v.content_hash,
      v_member_id,v_member,v_member_hash,'gmail-link-epoch-member-v1')
    on conflict(link_job_id) do nothing;
    update public.source_processing_jobs set state='queued',last_error_code='',
      safe_error_detail='',available_at=clock_timestamp(),updated_at=clock_timestamp()
    where workspace_key=p_workspace_key and job_id=p_link_job_id
      and state='waiting_runtime' and last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED';
  end if;
  return true;
end;
$function$;
revoke all on function private.reconcile_truth_gmail_checkpoint_late_parse_v1(text,uuid)
  from public,anon,authenticated,service_role;

create or replace function private.route_truth_gmail_checkpoint_late_parse_parent_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare v_child record;
begin
  if new.source_system='gmail' and new.job_kind=any(array[
      'gmail_parse_rfc822','gmail_parse_message','gmail_extract_attachment',
      'gmail_review_attachment_extraction'])
    and new.state='succeeded' and old.state is distinct from new.state then
    for v_child in select lineage.job_id
      from public.source_processing_job_lineage lineage
      join public.source_processing_jobs child
        on child.workspace_key=lineage.workspace_key and child.job_id=lineage.job_id
      where lineage.workspace_key=new.workspace_key
        and lineage.parent_job_id=new.job_id
        and child.job_kind='gmail_resolve_entity_links'
    loop perform private.reconcile_truth_gmail_checkpoint_late_parse_v1(
      new.workspace_key,v_child.job_id); end loop;
  end if;
  return new;
end;
$function$;
revoke all on function private.route_truth_gmail_checkpoint_late_parse_parent_v1()
  from public,anon,authenticated,service_role;

-- Epoch creation must enumerate receipted attachment observations as well as
-- direct parsed-message checkpoint members.
do $open_epoch_family$
declare v_signature regprocedure :=
  'private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure;
  v_definition text; v_old text :=
    $old$and observation.source_object_type='gmail_message_parsed'$old$;
  v_new text := $new$and (observation.source_object_type='gmail_message_parsed'
        or exists(select 1
          from public.truth_gmail_parse_checkpoint_late_parse_reconciliations family_receipt
          where family_receipt.workspace_key=job.workspace_key
            and family_receipt.link_job_id=job.job_id
            and family_receipt.parsed_observation_id=job.observation_id))$new$;
  v_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('family_receipt.parsed_observation_id=job.observation_id' in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
    if v_count is distinct from 1 then
      raise exception 'link-epoch observation-family rewrite matched % sites',v_count
        using errcode='23514'; end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$open_epoch_family$;

-- Existing terminal producers predate this trigger vocabulary; catch them in
-- a bounded-by-population, idempotent sweep.
do $reconcile_backlog$
declare v_job record;
begin
  for v_job in select workspace_key,job_id from public.source_processing_jobs
    where source_system='gmail' and job_kind='gmail_resolve_entity_links'
      and state='waiting_runtime' and last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
    order by workspace_key,job_id
  loop perform private.reconcile_truth_gmail_checkpoint_late_parse_v1(
    v_job.workspace_key,v_job.job_id); end loop;
end;
$reconcile_backlog$;

do $verify$
declare v_reconcile text; v_parent text; v_open text;
begin
  select pg_get_functiondef(
    'private.reconcile_truth_gmail_checkpoint_late_parse_v1(text,uuid)'::regprocedure)
    into v_reconcile;
  select pg_get_functiondef(
    'private.route_truth_gmail_checkpoint_late_parse_parent_v1()'::regprocedure)
    into v_parent;
  select pg_get_functiondef(
    'private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure)
    into v_open;
  if position('gmail_parse_rfc822' in v_reconcile)=0
    or position('gmail_parse_message' in v_reconcile)=0
    or position('gmail_extract_attachment' in v_reconcile)=0
    or position('gmail_review_attachment_extraction' in v_reconcile)=0
    or position('attachmentObservationId' in v_reconcile)=0
    or position('derivedObservationId' in v_reconcile)=0
    or position('gmail_extract_attachment' in v_parent)=0
    or position('family_receipt.parsed_observation_id=job.observation_id' in v_open)=0 then
    raise exception 'Gmail link observation-producer vocabulary is incomplete'
      using errcode='23514'; end if;
  if exists(select 1
    from public.truth_gmail_parse_checkpoint_late_parse_reconciliations receipt
    join public.source_processing_jobs producer
      on producer.workspace_key=receipt.workspace_key
     and producer.job_id=receipt.parse_job_id
    where producer.job_kind='gmail_extract_attachment'
      and (producer.state<>'succeeded'
        or producer.result->>'schemaVersion'<>'gmail-attachment-evidence-result-v1'
        or producer.result->>'attachmentObservationId'<>receipt.parsed_observation_id
        or receipt.canonical_reconciliation->>'productionPublicationAttempted'<>'false')) then
    raise exception 'attachment observation reconciliation proof is invalid'
      using errcode='23514'; end if;
end;
$verify$;
