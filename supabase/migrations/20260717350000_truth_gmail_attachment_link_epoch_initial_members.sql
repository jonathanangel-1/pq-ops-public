-- Total Gmail link-epoch observation vocabulary.
--
-- Parse checkpoints remain message-materialization cuts: one member per routed
-- Gmail message. They must not contain one row per attachment because a single
-- message may yield N attachments. The epoch path has three observation gates:
--   1. checkpoint acquisition before epoch creation;
--   2. initial link-job observation enumeration;
--   3. exact checkpoint/reconciliation admission inside that enumeration.
--
-- This migration makes (1) repair a not-yet-cut target through the existing
-- checkpoint-chain authority, and makes (2)/(3) total over the linkable source
-- vocabulary:
--   gmail_message_parsed      <- gmail_parse_rfc822 | gmail_parse_message
--   gmail_attachment_extracted <- gmail_extract_attachment |
--                                 gmail_review_attachment_extraction
-- Attachment admission is bound to the exact succeeded producer result and
-- root-batch lineage. No checkpoint row, source observation, or job result is
-- rewritten, and no publication surface is touched.

create schema if not exists private;

do $rewrite_open_epoch$
declare
  v_signature regprocedure :=
    'private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure;
  v_definition text;
  v_checkpoint_old text := $old$select * into strict v_checkpoint from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;$old$;
  v_checkpoint_new text := $new$select * into v_checkpoint from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  if not found then
    perform private.ensure_gmail_parse_checkpoint_chain_v1(
      p_workspace_key,v_batch.connection_key,p_root_batch_id,500);
    select * into strict v_checkpoint from public.gmail_parse_checkpoints
    where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  end if;$new$;
  v_type_old text := $old$and (observation.source_object_type='gmail_message_parsed'
        or exists(select 1
          from public.truth_gmail_parse_checkpoint_late_parse_reconciliations family_receipt
          where family_receipt.workspace_key=job.workspace_key
            and family_receipt.link_job_id=job.job_id
            and family_receipt.parsed_observation_id=job.observation_id))$old$;
  v_type_new text := $new$and observation.source_object_type=any(array[
        'gmail_message_parsed','gmail_attachment_extracted'])$new$;
  v_admission_old text := $old$and (exists(select 1 from public.gmail_parse_checkpoint_members member
          where member.workspace_key=p_workspace_key and member.root_batch_id=p_root_batch_id
            and member.parsed_observation_id=job.observation_id
            and member.terminal_disposition='parsed_exact_revision')
        or exists(select 1 from public.truth_gmail_parse_checkpoint_late_parse_reconciliations r
          where r.workspace_key=p_workspace_key and r.link_job_id=job.job_id
            and r.checkpoint_id=v_checkpoint.checkpoint_id))$old$;
  v_admission_new text := $new$and (
        (observation.source_object_type='gmail_message_parsed' and exists(
          select 1 from public.gmail_parse_checkpoint_members member
          where member.workspace_key=p_workspace_key
            and member.root_batch_id=p_root_batch_id
            and member.parsed_observation_id=job.observation_id
            and member.terminal_disposition='parsed_exact_revision'))
        or exists(
          select 1
          from public.truth_gmail_parse_checkpoint_late_parse_reconciliations r
          where r.workspace_key=p_workspace_key and r.link_job_id=job.job_id
            and r.checkpoint_id=v_checkpoint.checkpoint_id
            and r.parsed_observation_id=job.observation_id)
        or (observation.source_object_type='gmail_attachment_extracted' and exists(
          select 1
          from public.source_processing_jobs producer
          where producer.workspace_key=job.workspace_key
            and producer.job_id=lineage.parent_job_id
            and producer.source_system='gmail'
            and producer.connection_key=job.connection_key
            and producer.state='succeeded'
            and ((producer.job_kind='gmail_extract_attachment'
              and producer.result->>'schemaVersion'='gmail-attachment-evidence-result-v1'
              and producer.result->>'attachmentObservationId'=job.observation_id)
             or (producer.job_kind='gmail_review_attachment_extraction'
              and producer.result->>'schemaVersion'='gmail-attachment-model-review-result-v1'
              and producer.result->>'derivedObservationId'=job.observation_id))))
      )$new$;
  v_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('ensure_gmail_parse_checkpoint_chain_v1' in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_checkpoint_old,'')))
      /length(v_checkpoint_old);
    if v_count is distinct from 1 then
      raise exception 'link epoch checkpoint acquisition rewrite matched % sites',v_count
        using errcode='23514'; end if;
    v_definition:=replace(v_definition,v_checkpoint_old,v_checkpoint_new);
  end if;
  if position($probe$observation.source_object_type = ANY (ARRAY['gmail_message_parsed'::text, 'gmail_attachment_extracted'::text])$probe$ in v_definition)=0
    and position($probe$observation.source_object_type=any(array['gmail_message_parsed','gmail_attachment_extracted'])$probe$ in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_type_old,'')))
      /length(v_type_old);
    if v_count is distinct from 1 then
      raise exception 'link epoch observation-type rewrite matched % sites',v_count
        using errcode='23514'; end if;
    v_definition:=replace(v_definition,v_type_old,v_type_new);
  end if;
  if position($probe$producer.job_kind = 'gmail_extract_attachment'::text$probe$ in v_definition)=0
    and position($probe$producer.job_kind='gmail_extract_attachment'$probe$ in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_admission_old,'')))
      /length(v_admission_old);
    if v_count is distinct from 1 then
      raise exception 'link epoch observation-admission rewrite matched % sites',v_count
        using errcode='23514'; end if;
    v_definition:=replace(v_definition,v_admission_old,v_admission_new);
  end if;
  execute v_definition;
end;
$rewrite_open_epoch$;

-- Existing attachment-only batches are advanced by the hosted readiness
-- coordinator. This sweep only retries the already-designed checkpoint/open
-- steps; refusals remain fail-closed and no job is directly rewritten.
do $backfill$
declare v_batch record; v_checkpoint jsonb;
begin
  for v_batch in
    select distinct batch.workspace_key,batch.connection_key,batch.batch_id
    from public.source_ingest_batches batch
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=batch.workspace_key
     and lineage.root_batch_id=batch.batch_id
    join public.source_processing_jobs link_job
      on link_job.workspace_key=lineage.workspace_key
     and link_job.job_id=lineage.job_id
    join public.source_observations observation
      on observation.workspace_key=link_job.workspace_key
     and observation.observation_id=link_job.observation_id
    where batch.status='committed' and batch.source_system='gmail'
      and link_job.job_kind='gmail_resolve_entity_links'
      and link_job.state='waiting_runtime'
      and link_job.last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED'
      and observation.source_object_type='gmail_attachment_extracted'
      and not exists(select 1 from public.truth_gmail_link_epochs epoch
        where epoch.workspace_key=batch.workspace_key
          and epoch.root_batch_id=batch.batch_id)
    order by batch.workspace_key,batch.connection_key,batch.batch_id
  loop
    v_checkpoint:=private.ensure_gmail_parse_checkpoint_chain_v1(
      v_batch.workspace_key,v_batch.connection_key,v_batch.batch_id,500);
    -- The hosted coordinator owns the token-gated open step on its next round.
    -- This migration only ensures the missing checkpoint row is materialized.
    continue when v_checkpoint->>'status'='ready';
  end loop;
end;
$backfill$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure)
    into v_definition;
  if position('ensure_gmail_parse_checkpoint_chain_v1' in v_definition)=0
    or position('gmail_attachment_extracted' in v_definition)=0
    or position('gmail_extract_attachment' in v_definition)=0
    or position('attachmentObservationId' in v_definition)=0
    or position('gmail_review_attachment_extraction' in v_definition)=0
    or position('derivedObservationId' in v_definition)=0 then
    raise exception 'Gmail link-epoch initial observation vocabulary is incomplete'
      using errcode='23514'; end if;
end;
$verify$;
