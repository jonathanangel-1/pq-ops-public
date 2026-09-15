-- Document terminal parse absence without laundering it into parsed evidence.
-- A checkpoint gap is classifiable only when it has no parsed observation, no
-- late-parse reconciliation, no successful Gmail message-parse producer, and
-- every extant message-parse producer is terminal-failed. The immutable gap
-- remains unchanged. Its receipt is included in the link-epoch seal manifest
-- as disposition=parse_absent_documented. Ambiguous or runnable producers
-- remain hard blockers; delta-frontier exclusion remains a separate authority.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.truth_gmail_parse_absence_resolutions (
  resolution_id text primary key check(
    resolution_id='gmail-parse-absence-resolution:v1:'||resolution_hash),
  resolution_hash text not null unique check(resolution_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  root_batch_id uuid not null,
  checkpoint_id text not null,
  checkpoint_hash text not null check(checkpoint_hash~'^[0-9a-f]{64}$'),
  gap_member_id text not null,
  gap_member_hash text not null check(gap_member_hash~'^[0-9a-f]{64}$'),
  message_id text not null,
  disposition text not null check(disposition='parse_absent_documented'),
  producer_manifest jsonb not null check(jsonb_typeof(producer_manifest)='array'),
  producer_manifest_hash text not null check(producer_manifest_hash~'^[0-9a-f]{64}$'),
  canonical_resolution jsonb not null check(
    jsonb_typeof(canonical_resolution)='object'
    and canonical_resolution->>'disposition'='parse_absent_documented'
    and canonical_resolution->>'evidenceMinted'='false'
    and canonical_resolution->>'productionPublicationAttempted'='false'),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,gap_member_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,gap_member_id)
    references public.gmail_parse_checkpoint_members(workspace_key,member_id)
    on update restrict on delete restrict,
  check(producer_manifest_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(producer_manifest),'UTF8'),'sha256'),'hex')),
  check(resolution_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_resolution),'UTF8'),'sha256'),'hex'))
);
drop trigger if exists truth_gmail_parse_absence_resolutions_immutable
  on public.truth_gmail_parse_absence_resolutions;
create trigger truth_gmail_parse_absence_resolutions_immutable
before update or delete on public.truth_gmail_parse_absence_resolutions
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_parse_absence_resolutions enable row level security;
alter table public.truth_gmail_parse_absence_resolutions force row level security;
revoke all on public.truth_gmail_parse_absence_resolutions
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_parse_absence_resolutions to service_role;

do $classify$
declare v_gap record; v_manifest jsonb; v_manifest_hash text;
  v_body jsonb; v_hash text; v_id text;
begin
  for v_gap in
    select gap.*,checkpoint.checkpoint_id,checkpoint.checkpoint_hash,
      checkpoint.connection_key
    from public.gmail_parse_checkpoint_members gap
    join public.gmail_parse_checkpoints checkpoint
      on checkpoint.workspace_key=gap.workspace_key
     and checkpoint.root_batch_id=gap.root_batch_id
    where gap.terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
      and gap.parsed_observation_id is null
      and not exists(select 1
        from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
        where reconciliation.workspace_key=gap.workspace_key
          and reconciliation.gap_member_id=gap.member_id)
      and not exists(select 1 from public.source_observations observation
        where observation.workspace_key=gap.workspace_key
          and observation.source_system='gmail'
          and observation.connection_key=checkpoint.connection_key
          and observation.source_object_type='gmail_message_parsed'
          and observation.source_object_id=gap.message_id
          and observation.operation='content')
      and not exists(select 1 from public.source_processing_jobs producer
        join public.source_processing_job_lineage lineage
          on lineage.workspace_key=producer.workspace_key
         and lineage.job_id=producer.job_id
        where producer.workspace_key=gap.workspace_key
          and producer.source_system='gmail'
          and producer.connection_key=checkpoint.connection_key
          and producer.job_kind=any(array['gmail_parse_rfc822','gmail_parse_message'])
          and producer.source_object_id=gap.message_id
          and lineage.root_batch_id=gap.root_batch_id
          and producer.state not in ('dead_letter','superseded'))
    order by gap.workspace_key,gap.root_batch_id,gap.member_id
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
      'jobId',producer.job_id,'jobKind',producer.job_kind,'state',producer.state,
      'attemptCount',producer.attempt_count,'maxAttempts',producer.max_attempts,
      'lastErrorCode',producer.last_error_code,
      'resultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(producer.result),'UTF8'),'sha256'),'hex'))
      order by producer.job_id),'[]'::jsonb)
    into v_manifest
    from public.source_processing_jobs producer
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=producer.workspace_key and lineage.job_id=producer.job_id
    where producer.workspace_key=v_gap.workspace_key
      and producer.source_system='gmail' and producer.connection_key=v_gap.connection_key
      and producer.job_kind=any(array['gmail_parse_rfc822','gmail_parse_message'])
      and producer.source_object_id=v_gap.message_id
      and lineage.root_batch_id=v_gap.root_batch_id;
    v_manifest_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_manifest),'UTF8'),'sha256'),'hex');
    v_body:=jsonb_build_object(
      'schemaVersion','gmail-parse-absence-resolution-v1',
      'authorityVersion','gmail-terminal-parse-absence-v1',
      'workspaceKey',v_gap.workspace_key,'connectionKey',v_gap.connection_key,
      'rootBatchId',v_gap.root_batch_id,'checkpointId',v_gap.checkpoint_id,
      'checkpointHash',v_gap.checkpoint_hash,'gapMemberId',v_gap.member_id,
      'gapMemberHash',v_gap.member_hash,'messageId',v_gap.message_id,
      'gapTerminalDisposition',v_gap.terminal_disposition,
      'disposition','parse_absent_documented',
      'producerManifestHash',v_manifest_hash,'producerCount',jsonb_array_length(v_manifest),
      'evidenceMinted',false,'productionPublicationAttempted',false);
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id:='gmail-parse-absence-resolution:v1:'||v_hash;
    insert into public.truth_gmail_parse_absence_resolutions(
      resolution_id,resolution_hash,workspace_key,connection_key,root_batch_id,
      checkpoint_id,checkpoint_hash,gap_member_id,gap_member_hash,message_id,
      disposition,producer_manifest,producer_manifest_hash,canonical_resolution)
    values(v_id,v_hash,v_gap.workspace_key,v_gap.connection_key,v_gap.root_batch_id,
      v_gap.checkpoint_id,v_gap.checkpoint_hash,v_gap.member_id,v_gap.member_hash,
      v_gap.message_id,'parse_absent_documented',v_manifest,v_manifest_hash,v_body)
    on conflict(workspace_key,gap_member_id) do nothing;
  end loop;
end;
$classify$;

-- Compose the absence receipt into the exact unreconciled-gap refusal.
do $open_gate$
declare v_signature regprocedure :=
  'private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure;
  v_definition text;
  v_old text := $old$and not exists(select 1
        from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
        where reconciliation.workspace_key=gap.workspace_key
          and reconciliation.gap_member_id=gap.member_id
          and reconciliation.checkpoint_id=v_checkpoint.checkpoint_id
          and reconciliation.checkpoint_hash=v_checkpoint.checkpoint_hash)$old$;
  v_new text := $new$and not exists(select 1
        from public.truth_gmail_parse_checkpoint_late_parse_reconciliations reconciliation
        where reconciliation.workspace_key=gap.workspace_key
          and reconciliation.gap_member_id=gap.member_id
          and reconciliation.checkpoint_id=v_checkpoint.checkpoint_id
          and reconciliation.checkpoint_hash=v_checkpoint.checkpoint_hash)
      and not exists(select 1
        from public.truth_gmail_parse_absence_resolutions absence
        where absence.workspace_key=gap.workspace_key
          and absence.gap_member_id=gap.member_id
          and absence.checkpoint_id=v_checkpoint.checkpoint_id
          and absence.checkpoint_hash=v_checkpoint.checkpoint_hash)$new$;
  v_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_parse_absence_resolutions absence' in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
    if v_count is distinct from 1 then
      raise exception 'parse-absence open gate rewrite matched % sites',v_count
        using errcode='23514'; end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$open_gate$;

-- The seal manifest carries every absence classification even though there is
-- correctly no link member for an observation that does not exist.
do $seal_manifest$
declare v_signature regprocedure :=
  'private.seal_truth_gmail_link_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_decl_old text := $old$v_manifest jsonb; v_canonical jsonb;$old$;
  v_decl_new text := $new$v_manifest jsonb; v_absence_manifest jsonb; v_canonical jsonb;$new$;
  v_hash_old text := $old$v_manifest_hash:=encode(extensions.digest(convert_to($old$;
  v_hash_new text := $new$select coalesce(jsonb_agg(jsonb_build_object(
    'disposition','parse_absent_documented','messageId',absence.message_id,
    'gapMemberId',absence.gap_member_id,'gapMemberHash',absence.gap_member_hash,
    'absenceReceiptId',absence.resolution_id,
    'absenceReceiptHash',absence.resolution_hash)
    order by absence.message_id,absence.gap_member_id),'[]'::jsonb)
  into v_absence_manifest
  from public.truth_gmail_parse_absence_resolutions absence
  where absence.workspace_key=p_workspace_key
    and absence.root_batch_id=v_epoch.root_batch_id
    and absence.checkpoint_id=v_epoch.parse_checkpoint_id
    and absence.checkpoint_hash=v_epoch.parse_checkpoint_hash;
  v_manifest:=v_manifest||v_absence_manifest;
  v_manifest_hash:=encode(extensions.digest(convert_to($new$;
  v_count integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_absence_manifest jsonb' in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_decl_old,'')))/length(v_decl_old);
    if v_count is distinct from 1 then raise exception
      'parse-absence seal declaration rewrite matched % sites',v_count using errcode='23514'; end if;
    v_definition:=replace(v_definition,v_decl_old,v_decl_new);
  end if;
  if position($probe$'parse_absent_documented'$probe$ in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_hash_old,'')))/length(v_hash_old);
    if v_count is distinct from 1 then raise exception
      'parse-absence seal manifest rewrite matched % sites',v_count using errcode='23514'; end if;
    v_definition:=replace(v_definition,v_hash_old,v_hash_new);
  end if;
  execute v_definition;
end;
$seal_manifest$;

do $verify$
declare v_open text; v_seal text;
begin
  select pg_get_functiondef('private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure)
    into v_open;
  select pg_get_functiondef('private.seal_truth_gmail_link_epoch(text,text,text)'::regprocedure)
    into v_seal;
  if position('truth_gmail_parse_absence_resolutions absence' in v_open)=0
    or position('parse_absent_documented' in v_seal)=0 then
    raise exception 'parse-absence epoch authority is incomplete' using errcode='23514'; end if;
  if exists(select 1 from public.truth_gmail_parse_absence_resolutions resolution
    where resolution.canonical_resolution->>'productionPublicationAttempted'<>'false'
      or resolution.canonical_resolution->>'evidenceMinted'<>'false') then
    raise exception 'parse-absence receipt exceeded its authority' using errcode='23514'; end if;
end;
$verify$;
