-- Adopt legacy queued attachment-review jobs into the shadow Gmail model
-- commissioning state machine.
--
-- Attachment reviews created before model commissioning defaulted to queued,
-- while the bounded commissioning selector deliberately acquires only
-- waiting_runtime jobs.  Future shadow attachment reviews must park until one
-- exact immutable root scope exists; prepare then activates that same durable
-- job without resetting attempt, lease-fence, payload, or result history.

create schema if not exists private;

do $preflight$
declare
  v_route regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_prepare regprocedure := to_regprocedure(
    'private.prepare_truth_shadow_gmail_model_commissioning(text,text,uuid,integer,text,text)'
  );
  v_definition text;
begin
  if v_route is null
    or v_claim is null
    or v_prepare is null
    or to_regprocedure(
      'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.select_truth_shadow_gmail_attachment_commissioning_v1(text,text,uuid,bigint,text,integer)'
    ) is null
    or to_regprocedure(
      'private.unresolved_gmail_attachment_extraction_v1(text,uuid,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_ingest_batches') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_scopes') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null then
    raise exception 'shadow Gmail attachment-review adoption prerequisites are unavailable'
      using errcode = '55000';
  end if;

  select lower(pg_get_functiondef(v_route)) into v_definition;
  if position('gmail_attachment_model_commissioning_required' in v_definition) = 0
    and (
      position('gmail_fetch_raw_message' in v_definition) = 0
      or position('gmail_resolve_entity_links' in v_definition) = 0
      or position('gmail_extract_message_claims' in v_definition) = 0
      or position('gmail_extract_attachment_claims' in v_definition) = 0
      or position('gmail_extract_message_model_claims' in v_definition) = 0
      or position('gmail_review_model_extraction' in v_definition) = 0
      or position(
        'truth_shadow_gmail_model_commissioning_child_input_allowed_v1'
        in v_definition
      ) = 0
    ) then
    raise exception 'Gmail routing trigger differs from its reviewed predecessor'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_claim)) into v_definition;
  if position('gmail_attachment_model_commissioning_required' in v_definition) = 0
    and (
      position('expired_jobs as materialized' in v_definition) = 0
      or position('lineage_job_candidates as materialized' in v_definition) = 0
      or position('for update of job skip locked' in v_definition) = 0
      or position('gmail_extract_message_model_claims' in v_definition) = 0
      or position(
        'truth_shadow_gmail_model_commissioning_job_allowed_v1'
        in v_definition
      ) = 0
    ) then
    raise exception 'source-processing claim authority differs from its reviewed predecessor'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_prepare)) into v_definition;
  if position(
      'select_truth_shadow_gmail_attachment_commissioning_v1('
      in v_definition
    ) = 0
    or position('greatest(p_limit - v_prepared_count, 0)' in v_definition) = 0
    or position('productionpublicationattempted'', false' in v_definition) = 0 then
    raise exception 'shadow Gmail prepare authority differs from its bounded predecessor'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.source_processing_jobs'::regclass
      and trigger_row.tgname = 'source_processing_job_gmail_link_claim_wait'
      and trigger_row.tgfoid = v_route
      and not trigger_row.tgisinternal
  ) then
    raise exception 'source-processing Gmail route trigger is unavailable'
      using errcode = '23514';
  end if;
end;
$preflight$;

-- Preserve every predecessor route.  The new attachment branch is shadow-only
-- and queries the stored job: on INSERT the row/lineage is not visible yet, so
-- it parks; on prepare's UPDATE the exact scope and lineage already exist, so
-- that same job is allowed to enter queued.  Retry transitions inside an
-- already commissioned scope remain runnable.
create or replace function private.route_gmail_link_claim_wait_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.source_system='gmail' and new.job_kind='gmail_fetch_raw_message'
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MESSAGE_REVISION_SCHEMA_REQUIRED';
    new.safe_error_detail:='Legacy raw-fetch jobs are quarantined; revision materialization v1 is required.';
  elsif new.source_system='gmail' and new.job_kind='gmail_resolve_entity_links'
    and new.state in ('queued','retry_wait') and not exists (
      select 1 from public.truth_gmail_link_epoch_members member
      where member.workspace_key=new.workspace_key and member.link_job_id=new.job_id
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED';
    new.safe_error_detail:='Parsed evidence is durable; an epoch-bound link member is required.';
  elsif new.source_system='gmail' and new.job_kind=any(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims'
    ]) and new.state in ('queued','retry_wait') and not exists (
      select 1 from public.source_processing_job_lineage lineage
      join public.truth_gmail_link_epochs epoch
        on epoch.workspace_key=lineage.workspace_key and epoch.root_batch_id=lineage.root_batch_id
      join public.truth_gmail_link_epoch_seals seal
        on seal.workspace_key=epoch.workspace_key and seal.epoch_id=epoch.epoch_id
      where lineage.job_id=new.job_id and lineage.workspace_key=new.workspace_key
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SEAL_REQUIRED';
    new.safe_error_detail:='Claim extraction waits for the exact sealed Gmail link epoch.';
  elsif new.source_system='gmail'
    and new.job_kind='gmail_extract_message_model_claims'
    and new.state in ('queued','retry_wait')
    and not private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
      new.workspace_key,
      new.payload->>'parentJobId',
      new.job_id,
      new.dedupe_key,
      new.observation_id,
      new.payload
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MODEL_RUNTIME_DISABLED';
    new.safe_error_detail:=
      'Model extraction requires an exact shadow commissioning replay authority.';
  elsif new.source_system='gmail'
    and new.job_kind='gmail_review_model_extraction'
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MODEL_RUNTIME_DISABLED';
    new.safe_error_detail:='The local shadow rollout permits only explicitly commissioned model execution.';
  elsif new.source_system='gmail'
    and new.connection_key like 'shadow-%'
    and new.job_kind='gmail_review_attachment_extraction'
    and new.state in ('queued','retry_wait')
    and not private.truth_shadow_model_commissioning_job_allowed(
      new.workspace_key, new.job_id
    ) then
    new.state:='waiting_runtime'; new.lease_owner:=null; new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED';
    new.safe_error_detail:=
      'Attachment model extraction requires one exact shadow commissioning activation.';
  end if;
  return new;
end;
$function$;

revoke all on function private.route_gmail_link_claim_wait_v2()
  from public, anon, authenticated, service_role;

-- A legacy queued attachment review must not bypass bounded prepare by moving
-- directly to leased.  Non-shadow attachment review workflows are unchanged.
do $claim_rewrite$
declare
  v_signature regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_updated text;
  v_old text := $old$      and (job.source_system <> 'gmail'
        or job.job_kind <> 'gmail_extract_message_model_claims'
        or private.truth_shadow_gmail_model_commissioning_job_allowed_v1(
          job.workspace_key, job.job_id
        ))$old$;
  v_new text := $new$      and (job.source_system <> 'gmail'
        or job.job_kind <> 'gmail_extract_message_model_claims'
        or private.truth_shadow_gmail_model_commissioning_job_allowed_v1(
          job.workspace_key, job.job_id
        ))
      -- GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED admission gate.
      and (job.source_system <> 'gmail'
        or job.connection_key not like 'shadow-%'
        or job.job_kind <> 'gmail_review_attachment_extraction'
        or private.truth_shadow_model_commissioning_job_allowed(
          job.workspace_key, job.job_id
        ))$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED admission gate' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'attachment claim admission rewrite did not match its reviewed predecessor'
        using errcode = '23514';
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition
      or position(
        'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED admission gate'
        in v_updated
      ) = 0
      or position(
        'job.job_kind <> ''gmail_review_attachment_extraction'''
        in v_updated
      ) = 0
      or position(
        'private.truth_shadow_model_commissioning_job_allowed('
        in v_updated
      ) = 0 then
      raise exception 'attachment claim admission rewrite was incomplete'
        using errcode = '23514';
    end if;
    execute v_updated;
  elsif position(
      'job.job_kind <> ''gmail_review_attachment_extraction'''
      in v_definition
    ) = 0
    or position(
      'private.truth_shadow_model_commissioning_job_allowed('
      in v_definition
    ) = 0 then
    raise exception 'attachment claim admission rewrite is partially installed'
      using errcode = '23514';
  end if;
end;
$claim_rewrite$;

revoke all on function private.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) from public, anon, authenticated, service_role;

-- One-time adoption is deliberately limited to the commissioned production
-- shadow root named by the operator.  updated_at < scope.created_at identifies
-- only jobs that predate the commissioning scope and makes a later migration
-- replay a no-op after either this adoption or prepare has touched the job.
do $adopt_exact_legacy_root$
declare
  v_workspace constant text := 'primary';
  v_connection constant text := 'shadow-current-awbs-20260710-c475a8ca';
  v_root_batch constant uuid := 'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid;
  v_updated integer := 0;
begin
  if exists (
    select 1
    from public.source_ingest_batches batch
    join public.truth_shadow_gmail_model_commissioning_scopes scope
      on scope.workspace_key = batch.workspace_key
     and scope.source_system = batch.source_system
     and scope.connection_key = batch.connection_key
     and scope.root_batch_id = batch.batch_id
    where batch.workspace_key = v_workspace
      and batch.source_system = 'gmail'
      and batch.connection_key = v_connection
      and batch.batch_id = v_root_batch
      and batch.mode in ('backfill', 'reconciliation')
      and batch.status = 'committed'
      and batch.committed_cursor_version is not null
      and nullif(batch.committed_cursor_value, '') is not null
      and scope.shadow_only = true
      and scope.production_eligible = false
      and scope.production_publication_attempted = false
  ) then
    perform private.truth_source_cut_mutation_lock(v_workspace);

    if exists (
        select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key = v_workspace
          and epoch.root_batch_id = v_root_batch
      )
      or exists (
        select 1 from public.truth_shadow_root_source_cuts root_cut
        where root_cut.workspace_key = v_workspace
          and root_cut.root_batch_id = v_root_batch
      )
      or exists (
        select 1
        from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = build.workspace_key
         and root_cut.source_cut_id = build.source_cut_id
        where root_cut.workspace_key = v_workspace
          and root_cut.root_batch_id = v_root_batch
      )
      or exists (
        select 1
        from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = publication.workspace_key
         and root_cut.source_cut_id = publication.source_cut_id
        where root_cut.workspace_key = v_workspace
          and root_cut.root_batch_id = v_root_batch
      ) then
      raise exception 'accepted/cut/built/published roots cannot adopt attachment reviews'
        using errcode = '23514';
    end if;

    update public.source_processing_jobs review_job
    set state = 'waiting_runtime',
        last_error_code = 'GMAIL_ATTACHMENT_MODEL_COMMISSIONING_REQUIRED',
        safe_error_detail =
          'Attachment model extraction requires one exact shadow commissioning activation.',
        updated_at = clock_timestamp()
    from public.source_processing_job_lineage review_lineage
    join public.source_ingest_batches batch
      on batch.workspace_key = review_lineage.workspace_key
     and batch.source_system = review_lineage.source_system
     and batch.connection_key = review_lineage.connection_key
     and batch.batch_id = review_lineage.root_batch_id
    join public.truth_shadow_gmail_model_commissioning_scopes scope
      on scope.workspace_key = batch.workspace_key
     and scope.source_system = batch.source_system
     and scope.connection_key = batch.connection_key
     and scope.root_batch_id = batch.batch_id
    where review_job.workspace_key = v_workspace
      and review_job.source_system = 'gmail'
      and review_job.connection_key = v_connection
      and review_job.job_kind = 'gmail_review_attachment_extraction'
      and review_job.state = 'queued'
      and review_job.attempt_count < review_job.max_attempts
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.completed_at is null
      and review_job.result = '{}'::jsonb
      and review_job.payload->>'schemaVersion' =
        'gmail-review-attachment-extraction-job-v1'
      and review_lineage.workspace_key = review_job.workspace_key
      and review_lineage.source_system = review_job.source_system
      and review_lineage.connection_key = review_job.connection_key
      and review_lineage.job_id = review_job.job_id
      and review_lineage.root_batch_id = v_root_batch
      and review_lineage.source_cursor_version = batch.committed_cursor_version
      and review_lineage.source_cursor_value = batch.committed_cursor_value
      and batch.mode in ('backfill', 'reconciliation')
      and batch.status = 'committed'
      and scope.shadow_only = true
      and scope.production_eligible = false
      and scope.production_publication_attempted = false
      and review_job.updated_at < scope.created_at
      and private.truth_shadow_model_commissioning_job_allowed(
        review_job.workspace_key, review_job.job_id
      )
      and exists (
        select 1
        from private.unresolved_gmail_attachment_extraction_v1(
          review_job.workspace_key,
          review_job.job_id,
          review_job.observation_id
        ) target
        where target.connection_key = v_connection
          and target.root_batch_id = v_root_batch
      );
    get diagnostics v_updated = row_count;

    if exists (
      select 1
      from public.source_processing_jobs review_job
      join public.source_processing_job_lineage review_lineage
        on review_lineage.workspace_key = review_job.workspace_key
       and review_lineage.source_system = review_job.source_system
       and review_lineage.connection_key = review_job.connection_key
       and review_lineage.job_id = review_job.job_id
      join public.truth_shadow_gmail_model_commissioning_scopes scope
        on scope.workspace_key = review_lineage.workspace_key
       and scope.source_system = review_lineage.source_system
       and scope.connection_key = review_lineage.connection_key
       and scope.root_batch_id = review_lineage.root_batch_id
      where review_job.workspace_key = v_workspace
        and review_job.source_system = 'gmail'
        and review_job.connection_key = v_connection
        and review_job.job_kind = 'gmail_review_attachment_extraction'
        and review_job.state = 'queued'
        and review_job.attempt_count < review_job.max_attempts
        and review_job.lease_owner is null
        and review_job.lease_expires_at is null
        and review_job.completed_at is null
        and review_job.result = '{}'::jsonb
        and review_job.payload->>'schemaVersion' =
          'gmail-review-attachment-extraction-job-v1'
        and review_lineage.root_batch_id = v_root_batch
        and review_job.updated_at < scope.created_at
    ) then
      raise exception 'eligible pre-scope attachment reviews remain outside waiting_runtime'
        using errcode = '23514';
    end if;
  end if;
end;
$adopt_exact_legacy_root$;

analyze public.source_processing_jobs;
analyze public.source_processing_job_lineage;

do $verify$
declare
  v_route regprocedure := to_regprocedure(
    'private.route_gmail_link_claim_wait_v2()'
  );
  v_claim regprocedure := to_regprocedure(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
  );
  v_definition text;
  v_trigger_definition text;
begin
  select lower(pg_get_functiondef(v_route)) into v_definition;
  if position('gmail_fetch_raw_message' in v_definition) = 0
    or position('gmail_resolve_entity_links' in v_definition) = 0
    or position('gmail_extract_message_claims' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0
    or position('gmail_extract_message_model_claims' in v_definition) = 0
    or position('gmail_review_model_extraction' in v_definition) = 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0
    or position('gmail_attachment_model_commissioning_required' in v_definition) = 0
    or position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0
    or position('new.connection_key like ''shadow-%''' in v_definition) = 0 then
    raise exception 'Gmail route lost predecessor behavior or attachment commissioning park'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(v_claim)) into v_definition;
  if position('gmail_attachment_model_commissioning_required admission gate' in v_definition) = 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0
    or position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0
    or position('for update of job skip locked' in v_definition) = 0 then
    raise exception 'source-processing claim lost attachment commissioning admission'
      using errcode = '23514';
  end if;

  select lower(pg_get_triggerdef(trigger_row.oid, true))
    into v_trigger_definition
  from pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.source_processing_jobs'::regclass
    and trigger_row.tgname = 'source_processing_job_gmail_link_claim_wait'
    and trigger_row.tgfoid = v_route
    and not trigger_row.tgisinternal;
  if v_trigger_definition is null
    or position('before insert or update of state' in v_trigger_definition) = 0 then
    raise exception 'Gmail attachment commissioning route trigger is not active'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.source_processing_jobs review_job
    join public.source_processing_job_lineage review_lineage
      on review_lineage.workspace_key = review_job.workspace_key
     and review_lineage.source_system = review_job.source_system
     and review_lineage.connection_key = review_job.connection_key
     and review_lineage.job_id = review_job.job_id
    join public.truth_shadow_gmail_model_commissioning_scopes scope
      on scope.workspace_key = review_lineage.workspace_key
     and scope.source_system = review_lineage.source_system
     and scope.connection_key = review_lineage.connection_key
     and scope.root_batch_id = review_lineage.root_batch_id
    where review_job.workspace_key = 'primary'
      and review_job.source_system = 'gmail'
      and review_job.connection_key = 'shadow-current-awbs-20260710-c475a8ca'
      and review_job.job_kind = 'gmail_review_attachment_extraction'
      and review_job.state = 'queued'
      and review_job.attempt_count < review_job.max_attempts
      and review_job.lease_owner is null
      and review_job.lease_expires_at is null
      and review_job.completed_at is null
      and review_job.result = '{}'::jsonb
      and review_job.payload->>'schemaVersion' =
        'gmail-review-attachment-extraction-job-v1'
      and review_lineage.root_batch_id =
        'cd12fa59-d02b-462b-a9c8-ed11f93e41f4'::uuid
      and review_job.updated_at < scope.created_at
  ) then
    raise exception 'exact-root legacy attachment adoption failed read-back'
      using errcode = '23514';
  end if;
end;
$verify$;
