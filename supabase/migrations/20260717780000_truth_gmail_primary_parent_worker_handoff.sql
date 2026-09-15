-- Make the Fable-to-Codex primary parent-worker handoff explicit. Retire the
-- old processor version at both claim and plan-seal authority, admit only the
-- reviewed batch-scoped successor version, and leave an immutable receipt.
-- This migration performs no model call, claim acceptance, source cut, build,
-- publication, Gmail send, or TMS/manual operational mutation.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_worker_definition text; v_seal_definition text;
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_v1(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'primary parent-worker handoff prerequisites are unavailable'
      using errcode='55000';
  end if;

  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker_definition;
  if position('primary-message-model-drain-v1:parents-v1' in v_worker_definition)=0
    and position('primary-message-model-drain-v1:parents-v2' in v_worker_definition)=0 then
    raise exception 'commissioned parent-worker gate differs from reviewed predecessor'
      using errcode='23514';
  end if;

  select pg_get_functiondef(
    'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_seal_definition;
  if position('private.seal_gmail_model_extraction_plan' in v_seal_definition)=0 then
    raise exception 'public Gmail plan sealer differs from reviewed predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=p_workspace_key
      and lineage.job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||lineage.root_batch_id::text
      and p_processor_version='primary-message-model-drain-v1:parents-v2'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

-- The ordinary sealer still owns all validation and mutation. This public
-- entry gate adds only the live commissioned-parent worker-version fence, so
-- a stale remote parents-v1 monitor is rejected even if it retained the old
-- job id, lease owner, and fence before the handoff.
create or replace function public.seal_gmail_model_extraction_plan(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if private.truth_gmail_live_commissioned_parent_v1(
      p_workspace_key,p_job_id
    ) and not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
      p_workspace_key,p_job_id,p_worker_id,p_processor_version
    ) then
    raise exception 'retired primary commissioned parent worker refused'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) to service_role;

create table if not exists public.truth_gmail_live_parent_worker_handoffs (
  handoff_id text primary key check(
    handoff_id='truth-gmail-live-parent-worker-handoff:v1:'||handoff_hash
  ),
  handoff_hash text not null unique check(handoff_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  retired_processor_version text not null check(
    retired_processor_version='primary-message-model-drain-v1:parents-v1'
  ),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v2'
  ),
  canonical_handoff jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-parent-worker-handoff-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  handed_off_at timestamptz not null default clock_timestamp(),
  check(handoff_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_handoff),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_handoff->>'schemaVersion'=schema_version),
  check(canonical_handoff->>'workspaceKey'=workspace_key),
  check(canonical_handoff->>'connectionKey'=connection_key),
  check(canonical_handoff->>'retiredProcessorVersion'=retired_processor_version),
  check(canonical_handoff->>'activeProcessorVersion'=active_processor_version),
  check(canonical_handoff->>'reasonCode'='FABLE_BACKGROUND_WORKER_RETIRED'),
  check(canonical_handoff->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_parent_worker_handoffs_immutable
  on public.truth_gmail_live_parent_worker_handoffs;
create trigger truth_gmail_live_parent_worker_handoffs_immutable
before update or delete on public.truth_gmail_live_parent_worker_handoffs
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_parent_worker_handoffs enable row level security;
alter table public.truth_gmail_live_parent_worker_handoffs force row level security;
revoke all on public.truth_gmail_live_parent_worker_handoffs
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_parent_worker_handoffs to service_role;

do $receipt$
declare v_body jsonb; v_hash text;
begin
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-live-parent-worker-handoff-v1',
    'workspaceKey','primary','connectionKey','primary',
    'retiredProcessorVersion','primary-message-model-drain-v1:parents-v1',
    'activeProcessorVersion','primary-message-model-drain-v1:parents-v2',
    'reasonCode','FABLE_BACKGROUND_WORKER_RETIRED',
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  insert into public.truth_gmail_live_parent_worker_handoffs(
    handoff_id,handoff_hash,workspace_key,connection_key,
    retired_processor_version,active_processor_version,canonical_handoff,
    schema_version
  ) values(
    'truth-gmail-live-parent-worker-handoff:v1:'||v_hash,v_hash,
    'primary','primary','primary-message-model-drain-v1:parents-v1',
    'primary-message-model-drain-v1:parents-v2',v_body,
    'truth-gmail-live-parent-worker-handoff-v1'
  ) on conflict(handoff_id) do nothing;
end;
$receipt$;

do $verify$
declare v_worker_definition text; v_seal_definition text;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker_definition;
  select pg_get_functiondef(
    'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_seal_definition;
  if position('primary-message-model-drain-v1:parents-v2' in v_worker_definition)=0
    or position('primary-message-model-drain-v1:parents-v1' in v_worker_definition)>0
    or position('retired primary commissioned parent worker refused' in v_seal_definition)=0
    or position('truth_gmail_live_commissioned_parent_worker_allowed_v1' in v_seal_definition)=0 then
    raise exception 'primary commissioned parent worker handoff is incomplete'
      using errcode='55000';
  end if;
  if (select count(*) from public.truth_gmail_live_parent_worker_handoffs)<>1
    or exists(select 1 from public.truth_gmail_live_parent_worker_handoffs
      where production_publication_attempted
        or canonical_handoff->>'productionPublicationAttempted'<>'false') then
    raise exception 'primary parent-worker handoff receipt is invalid'
      using errcode='55000';
  end if;
  if has_table_privilege(
      'anon','public.truth_gmail_live_parent_worker_handoffs','SELECT'
    ) or has_table_privilege(
      'authenticated','public.truth_gmail_live_parent_worker_handoffs','SELECT'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_live_parent_worker_handoffs',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'primary parent-worker handoff ledger ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_live_parent_worker_handoffs;
