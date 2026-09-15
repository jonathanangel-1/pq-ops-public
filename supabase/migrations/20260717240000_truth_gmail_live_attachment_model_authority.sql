-- Extend the evidence-only Gmail attachment-model authority to the exact
-- receipt-certified primary mailbox forward world. Shadow admission remains
-- unchanged. Restore attempts consumed by the pre-extension worker only when
-- the immutable failure envelope proves that exact authority refusal class.
-- No accepted claim or publication is written here.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.gmail_attachment_model_requests') is null
    or to_regclass('public.gmail_attachment_model_attempt_dispatches') is null
    or to_regclass('public.gmail_attachment_model_attempt_outcomes') is null
    or to_regprocedure(
      'private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(public.gmail_parse_processing_epochs)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'
    ) is null
    or to_regprocedure(
      'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'
    ) is null
    or to_regprocedure('private.guard_gmail_model_candidate()') is null then
    raise exception 'live Gmail attachment-model prerequisites are unavailable'
      using errcode = '55000';
  end if;
end;
$preflight$;

-- Flip-critical first operation: the 20260717230000 runtime already admits
-- exact receipt-bound primary obligations, but this original table constraint
-- still rejected its atomic epoch insert.
do $acceptance_connection_scope$
declare v_constraint text;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epochs'::regclass
      and constraint_row.contype = 'c'
      and pg_get_constraintdef(constraint_row.oid) like
        '%connection_key%shadow-%'
  loop
    execute format(
      'alter table public.truth_shadow_claim_acceptance_epochs drop constraint %I',
      v_constraint
    );
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epochs'::regclass
      and constraint_row.conname =
        'truth_shadow_claim_acceptance_epochs_connection_scope_v2_check'
  ) then
    alter table public.truth_shadow_claim_acceptance_epochs
      add constraint truth_shadow_claim_acceptance_epochs_connection_scope_v2_check
      check (connection_key like 'shadow-%' or connection_key = 'primary');
  end if;
end;
$acceptance_connection_scope$;

create or replace function private.truth_gmail_live_forward_job_allowed_v1(
  p_workspace_key text,
  p_job_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_boundary public.gmail_parse_processing_epochs%rowtype;
  v_floor bigint;
begin
  if p_workspace_key is distinct from 'primary' or p_job_id is null then
    return false;
  end if;
  select * into v_boundary
  from public.gmail_parse_processing_epochs epoch
  where epoch.workspace_key = 'primary' and epoch.connection_key = 'primary';
  if not found or not
    private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(v_boundary) then
    return false;
  end if;
  v_floor := (v_boundary.canonical_epoch#>>
    '{parkedCompletenessBoundary,resumedCursorVersion}')::bigint;
  return exists (
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
     and lineage.source_system=job.source_system
     and lineage.connection_key=job.connection_key
    join public.source_ingest_batches batch
      on batch.workspace_key=lineage.workspace_key
     and batch.batch_id=lineage.root_batch_id
    where job.workspace_key='primary' and job.job_id=p_job_id
      and job.source_system='gmail' and job.connection_key='primary'
      and lineage.source_cursor_version > v_floor
      and private.gmail_history_id_at_least(
        lineage.source_cursor_value,
        v_boundary.canonical_epoch#>>
          '{parkedCompletenessBoundary,cutoverHistoryId}'
      )
      and batch.source_system='gmail' and batch.connection_key='primary'
      and batch.status='committed'
      and batch.committed_cursor_version=lineage.source_cursor_version
      and batch.committed_cursor_value=lineage.source_cursor_value
  );
end;
$function$;

revoke all on function private.truth_gmail_live_forward_job_allowed_v1(text,uuid)
  from public, anon, authenticated, service_role;

-- Stale-plan reconciliation stays evidence-only. Live rows carry
-- shadowOnly=false truthfully, while every receipt remains explicitly
-- productionPublicationAttempted=false.
do $stale_reconciliation_constraints$
declare v_constraint text;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.gmail_stale_extraction_plan_reconciliations'::regclass
      and constraint_row.contype='c'
      and (
        pg_get_constraintdef(constraint_row.oid) like '%connection_key%shadow-%'
        or pg_get_constraintdef(constraint_row.oid) like '%shadow_only = true%'
        or pg_get_constraintdef(constraint_row.oid) like
          '%canonical_reconciliation%shadowOnly%true%'
        or pg_get_constraintdef(constraint_row.oid) like
          '%canonical_supersession%shadowOnly%true%'
        or pg_get_constraintdef(constraint_row.oid) like
          '%canonical_receipt%shadowOnly%true%'
      )
  loop
    execute format(
      'alter table public.gmail_stale_extraction_plan_reconciliations drop constraint %I',
      v_constraint
    );
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.gmail_stale_extraction_plan_reconciliations'::regclass
      and constraint_row.conname =
        'gmail_stale_plan_reconciliation_scope_v2_check'
  ) then
    alter table public.gmail_stale_extraction_plan_reconciliations
      add constraint gmail_stale_plan_reconciliation_scope_v2_check check (
        (connection_key like 'shadow-%' and shadow_only=true
          and canonical_reconciliation->>'shadowOnly'='true'
          and canonical_supersession->>'shadowOnly'='true'
          and canonical_receipt->>'shadowOnly'='true')
        or
        (connection_key='primary' and shadow_only=false
          and canonical_reconciliation->>'shadowOnly'='false'
          and canonical_supersession->>'shadowOnly'='false'
          and canonical_receipt->>'shadowOnly'='false')
      );
  end if;
end;
$stale_reconciliation_constraints$;

do $rewrite_stale_reconciliation_integrity$
declare
  v_signature regprocedure :=
    'private.truth_shadow_is_reconciled_stale_gmail_claim_v1(text,uuid)'::regprocedure;
  v_definition text;
  v_old text := $old$      and reconciliation.shadow_only = true
      and reconciliation.production_eligible = false
      and reconciliation.production_publication_attempted = false
      and reconciliation.connection_key like 'shadow-%'$old$;
  v_new text := $new$      and (
        (reconciliation.connection_key like 'shadow-%'
          and reconciliation.shadow_only = true)
        or
        (reconciliation.connection_key = 'primary'
          and reconciliation.shadow_only = false
          and private.truth_gmail_live_forward_job_allowed_v1(
            reconciliation.workspace_key,
            reconciliation.stale_parent_job_id
          ))
      )
      and reconciliation.production_eligible = false
      and reconciliation.production_publication_attempted = false$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_live_forward_job_allowed_v1(' in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'stale-plan reconciliation integrity rewrite did not match'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite_stale_reconciliation_integrity$;

do $rewrite_stale_reconciliation_runtime$
declare
  v_signature regprocedure :=
    'private.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)'::regprocedure;
  v_definition text;
  v_old_declaration text := $old$  v_updated_count integer;$old$;
  v_new_declaration text := $new$  v_updated_count integer;
  v_shadow_only boolean;$new$;
  v_old_guard text := $old$    or v_job.connection_key not like 'shadow-%'
    or v_job.result <> '{}'::jsonb
    or v_job.completed_at is not null
    or exists (
      select 1 from public.truth_required_sources required_source
      where required_source.workspace_key = v_job.workspace_key
        and required_source.source_system = v_job.source_system
        and required_source.connection_key = v_job.connection_key
    ) then$old$;
  v_new_guard text := $new$    or not (
      (v_job.connection_key like 'shadow-%' and not exists (
        select 1 from public.truth_required_sources required_source
        where required_source.workspace_key = v_job.workspace_key
          and required_source.source_system = v_job.source_system
          and required_source.connection_key = v_job.connection_key
      ))
      or private.truth_gmail_live_forward_job_allowed_v1(
        v_job.workspace_key,v_job.job_id
      )
    )
    or v_job.result <> '{}'::jsonb
    or v_job.completed_at is not null then$new$;
  v_old_after_guard text := $old$    raise exception 'stale Gmail plan reconciliation is confined to unfinished shadow claims'
      using errcode = '23514';
  end if;
  select * into strict v_lineage$old$;
  v_new_after_guard text := $new$    raise exception 'stale Gmail plan reconciliation is outside its evidence-only scope'
      using errcode = '23514';
  end if;
  v_shadow_only := v_job.connection_key like 'shadow-%';
  select * into strict v_lineage$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_shadow_only boolean;' in v_definition)=0 then
    if position(v_old_declaration in v_definition)=0
      or position(v_old_guard in v_definition)=0
      or position(v_old_after_guard in v_definition)=0 then
      raise exception 'stale-plan live runtime rewrite did not match'
        using errcode='23514';
    end if;
    v_definition := replace(v_definition,v_old_declaration,v_new_declaration);
    v_definition := replace(v_definition,v_old_guard,v_new_guard);
    v_definition := replace(v_definition,v_old_after_guard,v_new_after_guard);
    v_definition := replace(
      v_definition, '''shadowOnly'', true', '''shadowOnly'', v_shadow_only'
    );
    v_definition := replace(
      v_definition,
      $old$'gmail-stale-extraction-plan-reconciliation-v1', true, false, false$old$,
      $new$'gmail-stale-extraction-plan-reconciliation-v1', v_shadow_only, false, false$new$
    );
    execute v_definition;
  end if;
end;
$rewrite_stale_reconciliation_runtime$;

create or replace function private.truth_gmail_live_attachment_model_job_allowed_v1(
  p_workspace_key text,
  p_job_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_boundary public.gmail_parse_processing_epochs%rowtype;
  v_floor bigint;
begin
  if p_workspace_key is distinct from 'primary' or p_job_id is null then
    return false;
  end if;
  select * into v_boundary
  from public.gmail_parse_processing_epochs epoch
  where epoch.workspace_key = 'primary'
    and epoch.connection_key = 'primary';
  if not found
    or not private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
      v_boundary
    ) then
    return false;
  end if;
  v_floor := (v_boundary.canonical_epoch#>>
    '{parkedCompletenessBoundary,resumedCursorVersion}')::bigint;

  return exists (
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = job.workspace_key
     and lineage.source_system = job.source_system
     and lineage.connection_key = job.connection_key
     and lineage.job_id = job.job_id
    join public.source_ingest_batches batch
      on batch.workspace_key = lineage.workspace_key
     and batch.batch_id = lineage.root_batch_id
    join public.source_observations observation
      on observation.workspace_key = job.workspace_key
     and observation.observation_id = job.observation_id
    where job.workspace_key = 'primary'
      and job.job_id = p_job_id
      and job.source_system = 'gmail'
      and job.connection_key = 'primary'
      and job.job_kind = 'gmail_review_attachment_extraction'
      and job.observation_id is not null
      and lineage.source_cursor_version > v_floor
      and private.gmail_history_id_at_least(
        lineage.source_cursor_value,
        v_boundary.canonical_epoch#>>
          '{parkedCompletenessBoundary,cutoverHistoryId}'
      )
      and batch.source_system = 'gmail'
      and batch.connection_key = 'primary'
      and batch.status = 'committed'
      and batch.committed_cursor_version = lineage.source_cursor_version
      and batch.committed_cursor_value = lineage.source_cursor_value
      and observation.source_system = 'gmail'
      and observation.connection_key = 'primary'
      and observation.batch_id = lineage.root_batch_id
      and observation.source_cursor_version = lineage.source_cursor_version
      and observation.source_object_type = 'gmail_attachment_extracted'
      and observation.operation = 'content'
      and observation.normalized_payload->>'schemaVersion' =
        'gmail-attachment-extracted-v1'
  );
end;
$function$;

create or replace function private.truth_gmail_attachment_model_job_allowed_v2(
  p_workspace_key text,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.truth_shadow_model_commissioning_job_allowed(
    p_workspace_key, p_job_id
  ) or private.truth_gmail_live_attachment_model_job_allowed_v1(
    p_workspace_key, p_job_id
  );
$function$;

revoke all on function private.truth_gmail_live_attachment_model_job_allowed_v1(
  text,uuid
) from public, anon, authenticated, service_role;
revoke all on function private.truth_gmail_attachment_model_job_allowed_v2(
  text,uuid
) from public, anon, authenticated, service_role;

do $request_scope_constraint$
declare v_constraint text;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.gmail_attachment_model_requests'::regclass
      and constraint_row.contype = 'c'
      and pg_get_constraintdef(constraint_row.oid) like
        '%connection_key%shadow-%'
  loop
    execute format(
      'alter table public.gmail_attachment_model_requests drop constraint %I',
      v_constraint
    );
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.gmail_attachment_model_requests'::regclass
      and constraint_row.conname =
        'gmail_attachment_model_requests_connection_scope_v2_check'
  ) then
    alter table public.gmail_attachment_model_requests
      add constraint gmail_attachment_model_requests_connection_scope_v2_check
      check (connection_key like 'shadow-%' or connection_key = 'primary');
  end if;
end;
$request_scope_constraint$;

do $rewrite_attachment_authorities$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated text;
  v_signatures regprocedure[] := array[
    'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'::regprocedure,
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'::regprocedure,
    'private.guard_gmail_model_candidate()'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_updated := replace(
      v_definition,
      'private.truth_shadow_model_commissioning_job_allowed(',
      'private.truth_gmail_attachment_model_job_allowed_v2('
    );
    v_updated := replace(
      v_updated,
      'truth_shadow_model_commissioning_job_allowed(',
      'truth_gmail_attachment_model_job_allowed_v2('
    );
    if v_signature =
        'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'::regprocedure then
      v_updated := replace(
        v_updated,
        'and job.connection_key like ''shadow-%''',
        'and (job.connection_key like ''shadow-%'' or job.connection_key = ''primary'')'
      );
    end if;
    if v_updated is distinct from v_definition then
      execute v_updated;
    elsif position(
      'private.truth_gmail_attachment_model_job_allowed_v2('
      in v_definition
    ) = 0 then
      raise exception 'attachment-model live authority rewrite did not match %',
        v_signature using errcode = '23514';
    end if;
  end loop;
end;
$rewrite_attachment_authorities$;

-- Both claim RPC variants must apply the composite attachment admission only
-- after their cheap bounded selection. This removes the old shadow-only branch
-- without restoring the Jul-18 unbounded gate-in-scan pathology.
do $rewrite_claim_attachment_gate$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated text;
  v_signatures regprocedure[] := array[
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure,
    'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_updated := replace(
      v_definition,
      'private.truth_shadow_model_commissioning_job_allowed(',
      'private.truth_gmail_attachment_model_job_allowed_v2('
    );
    v_updated := replace(
      v_updated,
      'truth_shadow_model_commissioning_job_allowed(',
      'truth_gmail_attachment_model_job_allowed_v2('
    );
    v_updated := replace(
      v_updated,
      $old$and job.connection_key like 'shadow-%'
        and job.job_kind = 'gmail_review_attachment_extraction'$old$,
      $new$and job.job_kind = 'gmail_review_attachment_extraction'$new$
    );
    v_updated := replace(
      v_updated,
      $old$and job.connection_key like 'shadow-%'
      and job.job_kind = 'gmail_review_attachment_extraction'$old$,
      $new$and job.job_kind = 'gmail_review_attachment_extraction'$new$
    );
    if v_updated is distinct from v_definition then
      execute v_updated;
    elsif v_signature =
        'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
      and position('private.claim_source_processing_jobs(' in v_definition)>0 then
      null;
    elsif position(
      'private.truth_gmail_attachment_model_job_allowed_v2('
      in v_definition
    )=0 then
      raise exception 'claim attachment admission rewrite did not match %',
        v_signature using errcode='23514';
    end if;
  end loop;
end;
$rewrite_claim_attachment_gate$;

create or replace function private.truth_gmail_attachment_model_ledger_refusal_v1(
  p_error_code text,
  p_safe_error_detail text
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare v_detail jsonb;
begin
  if p_error_code is distinct from
      'TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED' then
    return false;
  end if;
  begin
    v_detail := p_safe_error_detail::jsonb;
  exception when others then
    return false;
  end;
  return v_detail = jsonb_build_object(
    'schemaVersion', 'truth-gmail-attachment-model-worker-failure-v1',
    'errorCode', 'TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED',
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.truth_gmail_attachment_model_ledger_refusal_v1(
  text,text
) from public, anon, authenticated, service_role;

create table if not exists public.truth_gmail_attachment_model_retry_authorizations (
  authorization_id text primary key check (
    authorization_id ~ '^truth-gmail-attachment-model-retry:v1:[0-9a-f]{64}$'
  ),
  authorization_hash text not null unique check (
    authorization_hash ~ '^[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null check (connection_key = 'primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  source_observation_id text not null,
  prior_state text not null check (prior_state = 'retry_wait'),
  prior_attempt_count integer not null check (prior_attempt_count in (3,4)),
  prior_max_attempts integer not null check (prior_max_attempts = 5),
  prior_lease_fence bigint not null check (prior_lease_fence > 0),
  prior_error_code text not null check (
    prior_error_code = 'TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check (
    prior_error_detail_hash ~ '^[0-9a-f]{64}$'
  ),
  authorized_max_attempts integer not null check (
    authorized_max_attempts = prior_attempt_count + 3
  ),
  canonical_authorization jsonb not null check (
    jsonb_typeof(canonical_authorization) = 'object'
  ),
  schema_version text not null check (
    schema_version = 'truth-gmail-attachment-model-retry-authorization-v1'
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_key, source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check (authorization_id =
    'truth-gmail-attachment-model-retry:v1:' || authorization_hash),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_authorization->>'schemaVersion' = schema_version),
  check (canonical_authorization->>'workspaceKey' = workspace_key),
  check (canonical_authorization->>'connectionKey' = connection_key),
  check (canonical_authorization->>'sourceJobId' = source_job_id::text),
  check (canonical_authorization->>'rootBatchId' = root_batch_id::text),
  check (canonical_authorization->>'sourceObservationId' = source_observation_id),
  check (canonical_authorization->>'priorState' = prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer =
    prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer =
    prior_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint =
    prior_lease_fence),
  check (canonical_authorization->>'priorErrorCode' = prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash' =
    prior_error_detail_hash),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer =
    authorized_max_attempts),
  check (canonical_authorization->>'reasonCode' =
    'OPERATOR_TOOLING_AGAINST_REFUSING_LIVE_AUTHORITY'),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
);

drop trigger if exists truth_gmail_attachment_model_retry_authorizations_immutable
  on public.truth_gmail_attachment_model_retry_authorizations;
create trigger truth_gmail_attachment_model_retry_authorizations_immutable
before update or delete on public.truth_gmail_attachment_model_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_attachment_model_retry_authorizations
  enable row level security;
alter table public.truth_gmail_attachment_model_retry_authorizations
  force row level security;
revoke all on table public.truth_gmail_attachment_model_retry_authorizations
  from public, anon, authenticated, service_role;
grant select on table public.truth_gmail_attachment_model_retry_authorizations
  to service_role;

do $restore_exact_refusals$
declare
  v_candidate record;
  v_authorization jsonb;
  v_hash text;
  v_id text;
  v_authorized_max integer;
  v_inserted integer;
  v_updated integer;
begin
  for v_candidate in
    select job.job_id, job.observation_id, lineage.root_batch_id,
      job.state as prior_state, job.attempt_count as prior_attempt_count,
      job.max_attempts as prior_max_attempts,
      job.lease_fence as prior_lease_fence,
      job.last_error_code as prior_error_code,
      encode(extensions.digest(convert_to(job.safe_error_detail,'UTF8'),'sha256'),'hex')
        as prior_error_detail_hash
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = job.workspace_key
     and lineage.job_id = job.job_id
    where job.workspace_key = 'primary'
      and job.source_system = 'gmail'
      and job.connection_key = 'primary'
      and job.job_kind = 'gmail_review_attachment_extraction'
      and job.state = 'retry_wait'
      and job.attempt_count in (3,4)
      and job.max_attempts = 5
      and job.lease_owner is null
      and job.lease_expires_at is null
      and job.completed_at is null
      and job.result = '{}'::jsonb
      and private.truth_gmail_attachment_model_ledger_refusal_v1(
        job.last_error_code, job.safe_error_detail
      )
      and private.truth_gmail_live_attachment_model_job_allowed_v1(
        job.workspace_key, job.job_id
      )
      and not exists (
        select 1
        from public.truth_gmail_attachment_model_retry_authorizations auth
        where auth.source_job_id = job.job_id
      )
    order by job.job_id
    for update of job
  loop
    v_authorized_max := v_candidate.prior_attempt_count + 3;
    v_authorization := jsonb_build_object(
      'schemaVersion','truth-gmail-attachment-model-retry-authorization-v1',
      'workspaceKey','primary','connectionKey','primary',
      'sourceJobId',v_candidate.job_id,
      'rootBatchId',v_candidate.root_batch_id,
      'sourceObservationId',v_candidate.observation_id,
      'priorState',v_candidate.prior_state,
      'priorAttemptCount',v_candidate.prior_attempt_count,
      'priorMaxAttempts',v_candidate.prior_max_attempts,
      'priorLeaseFence',v_candidate.prior_lease_fence,
      'priorErrorCode',v_candidate.prior_error_code,
      'priorErrorDetailHash',v_candidate.prior_error_detail_hash,
      'authorizedMaxAttempts',v_authorized_max,
      'reasonCode','OPERATOR_TOOLING_AGAINST_REFUSING_LIVE_AUTHORITY',
      'productionPublicationAttempted',false
    );
    v_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_authorization),'UTF8'
    ),'sha256'),'hex');
    v_id := 'truth-gmail-attachment-model-retry:v1:' || v_hash;
    insert into public.truth_gmail_attachment_model_retry_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,root_batch_id,source_observation_id,prior_state,
      prior_attempt_count,prior_max_attempts,prior_lease_fence,
      prior_error_code,prior_error_detail_hash,authorized_max_attempts,
      canonical_authorization,schema_version
    ) values (
      v_id,v_hash,'primary','primary',v_candidate.job_id,
      v_candidate.root_batch_id,v_candidate.observation_id,
      v_candidate.prior_state,v_candidate.prior_attempt_count,
      v_candidate.prior_max_attempts,v_candidate.prior_lease_fence,
      v_candidate.prior_error_code,v_candidate.prior_error_detail_hash,
      v_authorized_max,v_authorization,
      'truth-gmail-attachment-model-retry-authorization-v1'
    );
    get diagnostics v_inserted = row_count;
    if v_inserted <> 1 then
      raise exception 'attachment-model retry authorization was not inserted'
        using errcode = '23505';
    end if;

    update public.source_processing_jobs job
    set max_attempts = v_authorized_max,
        available_at = clock_timestamp(),
        last_error_code = 'GMAIL_ATTACHMENT_MODEL_LIVE_AUTHORITY_RETRY_AUTHORIZED',
        safe_error_detail =
          'Attempts restored after operator tooling invoked the correctly refusing pre-extension live attachment-model authority.',
        updated_at = clock_timestamp()
    where job.job_id = v_candidate.job_id
      and job.workspace_key = 'primary'
      and job.state = v_candidate.prior_state
      and job.attempt_count = v_candidate.prior_attempt_count
      and job.max_attempts = v_candidate.prior_max_attempts
      and job.lease_fence = v_candidate.prior_lease_fence
      and job.lease_owner is null and job.lease_expires_at is null
      and job.completed_at is null and job.result = '{}'::jsonb
      and job.last_error_code = v_candidate.prior_error_code
      and encode(extensions.digest(convert_to(
        job.safe_error_detail,'UTF8'
      ),'sha256'),'hex') = v_candidate.prior_error_detail_hash;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'attachment-model retry target changed during authorization'
        using errcode = '40001';
    end if;
  end loop;
end;
$restore_exact_refusals$;

analyze public.truth_gmail_attachment_model_retry_authorizations;

do $verify$
declare
  v_definition text;
  v_constraint_bundle text;
  v_rls record;
begin
  select string_agg(pg_get_constraintdef(constraint_row.oid),' ')
  into v_constraint_bundle
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid =
    'public.truth_shadow_claim_acceptance_epochs'::regclass
    and constraint_row.contype='c';
  if position('connection_key = ''primary''' in v_constraint_bundle)=0
    or position('connection_key ~~ ''shadow-%''' in v_constraint_bundle)=0 then
    raise exception 'primary acceptance epoch connection admission is missing'
      using errcode='55000';
  end if;
  select string_agg(pg_get_constraintdef(constraint_row.oid),' ')
  into v_constraint_bundle
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid =
    'public.gmail_stale_extraction_plan_reconciliations'::regclass
    and constraint_row.contype='c';
  if position('connection_key = ''primary''' in v_constraint_bundle)=0
    or position('shadow_only = false' in v_constraint_bundle)=0
    or position('canonical_reconciliation' in v_constraint_bundle)=0
    or position('canonical_supersession' in v_constraint_bundle)=0
    or position('canonical_receipt' in v_constraint_bundle)=0 then
    raise exception 'live stale-plan receipt scope constraints are incomplete'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.reconcile_stale_shadow_gmail_extraction_plan(text,uuid,text,bigint,text,jsonb,text)'::regprocedure
  ) into v_definition;
  if position('v_shadow_only boolean;' in v_definition)=0
    or position('truth_gmail_live_forward_job_allowed_v1(' in v_definition)=0
    or position('''shadowOnly'', v_shadow_only' in v_definition)=0
    or position('confined to unfinished shadow claims' in v_definition)>0 then
    raise exception 'live stale-plan reconciliation runtime is incomplete'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.truth_shadow_is_reconciled_stale_gmail_claim_v1(text,uuid)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_live_forward_job_allowed_v1(' in v_definition)=0
    or position('reconciliation.shadow_only = false' in v_definition)=0 then
    raise exception 'live stale-plan reconciliation integrity proof is incomplete'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_attachment_model_job_allowed_v2(' in v_definition)=0
    or position($needle$job.connection_key like 'shadow-%'
        and job.job_kind = 'gmail_review_attachment_extraction'$needle$
      in v_definition)>0 then
    raise exception 'bounded claim authority did not adopt the live attachment gate'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_attachment_model_job_allowed_v2' in v_definition) = 0
    or position('job.connection_key = ''primary''' in v_definition) = 0
    or position('truth_shadow_model_commissioning_job_allowed' in v_definition) > 0 then
    raise exception 'live attachment-model lease admission rewrite is incomplete'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_attachment_model_job_allowed_v2' in v_definition) = 0
    or position('truth_attachment_model_runtime' in v_definition) = 0
    or position('operational_evidence_recorded' in v_definition) = 0
    or position('productionPublicationAttempted'', false' in v_definition) = 0 then
    raise exception 'live attachment-model completion authority is incomplete'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.guard_gmail_model_candidate()'::regprocedure
  ) into v_definition;
  if position('truth_gmail_attachment_model_job_allowed_v2' in v_definition) = 0
    or position('truth_attachment_model_runtime' in v_definition) = 0 then
    raise exception 'live attachment-model candidate provenance guard is incomplete'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state='retry_wait' and job.attempt_count in (3,4)
      and job.max_attempts=5 and job.lease_owner is null
      and job.lease_expires_at is null and job.completed_at is null
      and job.result='{}'::jsonb
      and private.truth_gmail_attachment_model_ledger_refusal_v1(
        job.last_error_code,job.safe_error_detail
      )
      and private.truth_gmail_live_attachment_model_job_allowed_v1(
        job.workspace_key,job.job_id
      )
  ) then
    raise exception 'exact live attachment-model refusal residual remained'
      using errcode = '55000';
  end if;
  select catalog.relrowsecurity as rls_enabled,
    catalog.relforcerowsecurity as rls_forced,
    has_table_privilege('service_role',catalog.oid,'select') as service_select,
    has_table_privilege('service_role',catalog.oid,'insert') as service_insert,
    has_table_privilege('service_role',catalog.oid,'update') as service_update
  into v_rls
  from pg_catalog.pg_class catalog
  where catalog.oid =
    'public.truth_gmail_attachment_model_retry_authorizations'::regclass;
  if v_rls.rls_enabled is distinct from true
    or v_rls.rls_forced is distinct from true
    or v_rls.service_select is distinct from true
    or v_rls.service_insert is distinct from false
    or v_rls.service_update is distinct from false then
    raise exception 'attachment-model retry authorization ledger ACL is unsafe'
      using errcode = '55000';
  end if;
  if has_function_privilege('service_role',
      'private.truth_gmail_live_attachment_model_job_allowed_v1(text,uuid)',
      'execute')
    or has_function_privilege('service_role',
      'private.truth_gmail_attachment_model_ledger_refusal_v1(text,text)',
      'execute') then
    raise exception 'private live attachment-model helpers are exposed'
      using errcode = '55000';
  end if;
  if position('shipment-truth-packets' in v_definition) > 0 then
    raise exception 'live attachment-model authority references the live board'
      using errcode = '55000';
  end if;
end;
$verify$;
