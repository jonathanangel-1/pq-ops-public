-- The ceremony's one-source Gmail cut is permanent shadow acceptance proof,
-- never production build authority. Seal a separate exact required-source cut
-- while the same accepted Gmail head is pinned, and bind the two with an
-- immutable receipt. No build, approval, publication, claim, model, Gmail, or
-- operational mutation is performed here.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.truth_primary_model_review_cut_frontiers') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure(
      'private.seal_source_cut(text,text,jsonb,jsonb,jsonb,jsonb,text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_build_documented_gap_exclusions_v1(text,text)'
    ) is null
    or to_regprocedure(
      'private.read_truth_ceremony_gmail_head_v1(text,text)'
    ) is null then
    raise exception 'production-cut bridge prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_production_cut_acceptance_bridges (
  bridge_id text primary key check(
    bridge_id='truth-production-cut-acceptance-bridge:v1:'||bridge_hash
  ),
  bridge_hash text not null unique check(bridge_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  shadow_source_cut_id text not null
    references public.source_cuts(source_cut_id)
    on update restrict on delete restrict,
  production_source_cut_id text not null unique
    references public.source_cuts(source_cut_id)
    on update restrict on delete restrict,
  shadow_scope_receipt_id text not null
    references public.truth_shadow_root_source_cuts(scope_receipt_id)
    on update restrict on delete restrict,
  shadow_scope_receipt_hash text not null check(
    shadow_scope_receipt_hash~'^[0-9a-f]{64}$'
  ),
  acceptance_epoch_manifest_hash text not null check(
    acceptance_epoch_manifest_hash~'^[0-9a-f]{64}$'
  ),
  primary_model_review_frontier_hash text not null check(
    primary_model_review_frontier_hash='' or
    primary_model_review_frontier_hash~'^[0-9a-f]{64}$'
  ),
  required_source_manifest jsonb not null check(
    jsonb_typeof(required_source_manifest)='array' and
    jsonb_array_length(required_source_manifest)>0
  ),
  required_source_manifest_hash text not null check(
    required_source_manifest_hash~'^[0-9a-f]{64}$'
  ),
  cursor_manifest jsonb not null check(
    jsonb_typeof(cursor_manifest)='array' and
    jsonb_array_length(cursor_manifest)>0
  ),
  cursor_manifest_hash text not null check(
    cursor_manifest_hash~'^[0-9a-f]{64}$'
  ),
  documented_gap_exclusions jsonb not null check(
    jsonb_typeof(documented_gap_exclusions)='array'
  ),
  documented_gap_exclusion_hash text not null check(
    documented_gap_exclusion_hash~'^[0-9a-f]{64}$'
  ),
  canonical_receipt jsonb not null check(jsonb_typeof(canonical_receipt)='object'),
  schema_version text not null check(
    schema_version='truth-production-cut-acceptance-bridge-v1'
  ),
  production_eligible boolean not null default true check(production_eligible=true),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  publishes_truth boolean not null default false check(publishes_truth=false),
  performs_actions boolean not null default false check(performs_actions=false),
  created_at timestamptz not null default clock_timestamp(),
  unique(shadow_source_cut_id,production_source_cut_id),
  foreign key(workspace_key,shadow_source_cut_id)
    references public.source_cuts(workspace_key,source_cut_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,production_source_cut_id)
    references public.source_cuts(workspace_key,source_cut_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,shadow_scope_receipt_id)
    references public.truth_shadow_root_source_cuts(workspace_key,scope_receipt_id)
    on update restrict on delete restrict,
  check(shadow_source_cut_id<>production_source_cut_id),
  check(required_source_manifest_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(required_source_manifest),'UTF8'
  ),'sha256'),'hex')),
  check(cursor_manifest_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(cursor_manifest),'UTF8'
  ),'sha256'),'hex')),
  check(documented_gap_exclusion_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(documented_gap_exclusions),'UTF8'
  ),'sha256'),'hex')),
  check(bridge_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_receipt->>'schemaVersion'=schema_version),
  check(canonical_receipt->>'workspaceKey'=workspace_key),
  check(canonical_receipt->>'shadowSourceCutId'=shadow_source_cut_id),
  check(canonical_receipt->>'productionSourceCutId'=production_source_cut_id),
  check(canonical_receipt->>'shadowScopeReceiptId'=shadow_scope_receipt_id),
  check(canonical_receipt->>'shadowScopeReceiptHash'=shadow_scope_receipt_hash),
  check(canonical_receipt->>'acceptanceEpochManifestHash'=
    acceptance_epoch_manifest_hash),
  check(canonical_receipt->>'primaryModelReviewFrontierHash'=
    primary_model_review_frontier_hash),
  check(canonical_receipt->>'requiredSourceManifestHash'=
    required_source_manifest_hash),
  check(canonical_receipt->>'cursorManifestHash'=cursor_manifest_hash),
  check(canonical_receipt->>'documentedGapExclusionHash'=
    documented_gap_exclusion_hash),
  check((canonical_receipt->>'productionEligible')::boolean=true),
  check((canonical_receipt->>'productionPublicationAttempted')::boolean=false),
  check((canonical_receipt->>'publishesTruth')::boolean=false),
  check((canonical_receipt->>'performsActions')::boolean=false)
);

drop trigger if exists truth_production_cut_acceptance_bridges_immutable
  on public.truth_production_cut_acceptance_bridges;
create trigger truth_production_cut_acceptance_bridges_immutable
before update or delete on public.truth_production_cut_acceptance_bridges
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_production_cut_acceptance_bridges enable row level security;
alter table public.truth_production_cut_acceptance_bridges force row level security;
revoke all on public.truth_production_cut_acceptance_bridges
  from public,anon,authenticated,service_role;
grant select on public.truth_production_cut_acceptance_bridges to service_role;

create or replace function private.seal_truth_production_cut_from_accepted_gmail_v1(
  p_workspace_key text,
  p_shadow_source_cut_id text,
  p_created_by text,
  p_sync_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='250s'
as $function$
declare
  v_scope public.truth_shadow_root_source_cuts%rowtype;
  v_shadow_cut public.source_cuts%rowtype;
  v_gmail_cursor public.source_cursors%rowtype;
  v_head jsonb;
  v_required_sources jsonb;
  v_input_cursors jsonb;
  v_seed jsonb;
  v_cut public.source_cuts%rowtype;
  v_exclusions jsonb;
  v_required_hash text;
  v_cursor_hash text;
  v_exclusion_hash text;
  v_model_frontier_hash text;
  v_receipt jsonb;
  v_bridge_hash text;
  v_existing public.truth_production_cut_acceptance_bridges%rowtype;
  v_required_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key<>'primary'
    or nullif(trim(coalesce(p_created_by,'')),'') is null
    or coalesce(p_shadow_source_cut_id,'')!~'^cut:v1:[0-9a-f]{64}$' then
    raise exception 'production-cut bridge identity is invalid' using errcode='22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:'||p_workspace_key,0
  )) then
    return jsonb_build_object(
      'ok',true,'status','busy','retryable',true,
      'productionPublicationAttempted',false
    );
  end if;

  select * into v_scope
  from public.truth_shadow_root_source_cuts scope_row
  where scope_row.workspace_key=p_workspace_key
    and scope_row.source_cut_id=p_shadow_source_cut_id;
  if not found
    or v_scope.source_system<>'gmail'
    or v_scope.connection_key<>'primary'
    or not v_scope.shadow_only
    or v_scope.production_eligible
    or v_scope.production_publication_attempted then
    raise exception 'accepted primary Gmail shadow-root cut is unavailable'
      using errcode='42501';
  end if;
  select * into strict v_shadow_cut from public.source_cuts cut
  where cut.workspace_key=p_workspace_key
    and cut.source_cut_id=p_shadow_source_cut_id;
  if jsonb_array_length(v_shadow_cut.required_sources)<>1
    or v_shadow_cut.required_sources#>>'{0,sourceSystem}'<>'gmail'
    or v_shadow_cut.required_sources#>>'{0,connectionKey}'<>'primary'
    or v_shadow_cut.manifest_hash<>v_scope.source_cut_manifest_hash then
    raise exception 'shadow-root cut is not the exact Gmail acceptance vector'
      using errcode='23514';
  end if;
  select * into strict v_gmail_cursor from public.source_cursors cursor_row
  where cursor_row.workspace_key=p_workspace_key
    and cursor_row.source_system='gmail'
    and cursor_row.connection_key='primary'
    and cursor_row.status='live';
  if v_gmail_cursor.cursor_version<>v_scope.through_cursor_version
    or v_gmail_cursor.cursor_value<>v_scope.through_cursor_value then
    raise exception 'accepted Gmail shadow root is no longer the live cursor'
      using errcode='40001';
  end if;
  v_head:=private.read_truth_ceremony_gmail_head_v1(p_workspace_key,p_sync_token);
  if coalesce((v_head->>'accepted')::boolean,false)<>true
    or v_head->>'rootBatchId'<>v_scope.root_batch_id::text
    or (v_head->>'sourceCursorVersion')::bigint<>v_gmail_cursor.cursor_version
    or v_head->>'sourceCursorValue'<>v_gmail_cursor.cursor_value then
    raise exception 'accepted Gmail ceremony head changed before production cut'
      using errcode='40001';
  end if;

  select count(*)::integer into v_required_count
  from public.truth_required_sources source_row
  where source_row.workspace_key=p_workspace_key;
  if v_required_count<>4
    or not exists(select 1 from public.truth_required_sources
      where workspace_key=p_workspace_key and source_system='gmail'
        and connection_key='primary')
    or not exists(select 1 from public.truth_required_sources
      where workspace_key=p_workspace_key and source_system='operator'
        and connection_key='operator-phone-primary')
    or not exists(select 1 from public.truth_required_sources
      where workspace_key=p_workspace_key and source_system='tms'
        and connection_key='couriercloud-ops-tlv-us')
    or not exists(select 1 from public.truth_required_sources
      where workspace_key=p_workspace_key and source_system='tracking'
        and connection_key='carrier-tracking-primary') then
    raise exception 'production required-source registry is not the reviewed four-source vector'
      using errcode='23514';
  end if;

  perform source_row.workspace_key
  from public.truth_required_sources source_row
  where source_row.workspace_key=p_workspace_key
  order by source_row.source_system,source_row.connection_key
  for share of source_row;
  perform cursor_row.workspace_key
  from public.truth_required_sources source_row
  join public.source_cursors cursor_row
    on cursor_row.workspace_key=source_row.workspace_key
   and cursor_row.source_system=source_row.source_system
   and cursor_row.connection_key=source_row.connection_key
  where source_row.workspace_key=p_workspace_key
  order by source_row.source_system,source_row.connection_key
  for share of cursor_row;

  if exists(
    select 1
    from public.truth_required_sources source_row
    left join public.source_cursors cursor_row
      on cursor_row.workspace_key=source_row.workspace_key
     and cursor_row.source_system=source_row.source_system
     and cursor_row.connection_key=source_row.connection_key
    left join public.source_ingest_batches batch
      on batch.workspace_key=cursor_row.workspace_key
     and batch.batch_id=cursor_row.last_batch_id
     and batch.source_system=cursor_row.source_system
     and batch.connection_key=cursor_row.connection_key
     and batch.status='committed'
     and batch.committed_cursor_version=cursor_row.cursor_version
     and batch.committed_cursor_value=cursor_row.cursor_value
    left join public.source_ingest_manifests manifest
      on manifest.workspace_key=batch.workspace_key
     and manifest.batch_id=batch.batch_id
     and manifest.source_system=batch.source_system
     and manifest.connection_key=batch.connection_key
     and manifest.next_cursor_value=cursor_row.cursor_value
    where source_row.workspace_key=p_workspace_key
      and (
        cursor_row.workspace_key is null
        or cursor_row.status<>'live'
        or cursor_row.cursor_kind<>source_row.cursor_kind
        or nullif(cursor_row.cursor_value,'') is null
        or batch.batch_id is null
        or (source_row.source_system<>'gmail' and (
          manifest.batch_id is null
          or manifest.provider_manifest_hash<>encode(extensions.digest(convert_to(
            manifest.provider_manifest::text,'UTF8'),'sha256'),'hex')
          or manifest.observation_manifest_hash<>encode(extensions.digest(convert_to(
            manifest.observation_manifest::text,'UTF8'),'sha256'),'hex')
          or manifest.job_manifest_hash<>encode(extensions.digest(convert_to(
            manifest.job_manifest::text,'UTF8'),'sha256'),'hex')
          or manifest.provider_manifest->>'upstreamWatermark'<>cursor_row.cursor_value
          or manifest.source_snapshot_at is null
        ))
        or (source_row.freshness_seconds is not null and
          case when source_row.source_system='gmail' then batch.committed_at
               else manifest.source_snapshot_at end
          < clock_timestamp()-make_interval(secs=>source_row.freshness_seconds))
      )
  ) then
    raise exception 'production required-source vector is missing, stale, or unproved'
      using errcode='55000';
  end if;
  if exists(
    select 1 from public.truth_required_sources source_row
    join public.source_cursors cursor_row
      on cursor_row.workspace_key=source_row.workspace_key
     and cursor_row.source_system=source_row.source_system
     and cursor_row.connection_key=source_row.connection_key
    join public.source_ingest_batches batch
      on batch.workspace_key=cursor_row.workspace_key
     and batch.source_system=cursor_row.source_system
     and batch.connection_key=cursor_row.connection_key
    where source_row.workspace_key=p_workspace_key
      and batch.status in ('running','failed')
      and batch.expected_cursor_version>=cursor_row.cursor_version
  ) then
    raise exception 'production required-source vector has an open or failed batch'
      using errcode='55000';
  end if;

  select jsonb_agg(jsonb_build_object(
    'sourceSystem',source_row.source_system,
    'connectionKey',source_row.connection_key
  ) order by source_row.source_system,source_row.connection_key)
  into v_required_sources
  from public.truth_required_sources source_row
  where source_row.workspace_key=p_workspace_key;

  select jsonb_agg(jsonb_build_object(
    'sourceSystem',cursor_row.source_system,
    'connectionKey',cursor_row.connection_key,
    'cursorKind',cursor_row.cursor_kind,
    'throughCursorVersion',cursor_row.cursor_version,
    'throughCursorValue',cursor_row.cursor_value,
    'upstreamWatermark',case when cursor_row.source_system='gmail'
      then cursor_row.cursor_value else manifest.provider_manifest->>'upstreamWatermark' end,
    'sourceSnapshotAt',private.canonical_truth_timestamp(case
      when cursor_row.source_system='gmail' then batch.committed_at
      else manifest.source_snapshot_at end)
  ) order by cursor_row.source_system,cursor_row.connection_key)
  into v_input_cursors
  from public.truth_required_sources source_row
  join public.source_cursors cursor_row
    on cursor_row.workspace_key=source_row.workspace_key
   and cursor_row.source_system=source_row.source_system
   and cursor_row.connection_key=source_row.connection_key
  join public.source_ingest_batches batch
    on batch.workspace_key=cursor_row.workspace_key
   and batch.batch_id=cursor_row.last_batch_id
   and batch.source_system=cursor_row.source_system
   and batch.connection_key=cursor_row.connection_key
   and batch.status='committed'
  left join public.source_ingest_manifests manifest
    on manifest.workspace_key=batch.workspace_key
   and manifest.batch_id=batch.batch_id
   and manifest.source_system=batch.source_system
   and manifest.connection_key=batch.connection_key
   and manifest.next_cursor_value=cursor_row.cursor_value
  where source_row.workspace_key=p_workspace_key;

  v_seed:=private.seal_source_cut(
    p_workspace_key,'source-cut-manifest-v2',v_required_sources,'[]'::jsonb,
    v_input_cursors,'[]'::jsonb,p_created_by,p_sync_token
  );
  if coalesce(v_seed->>'sourceCutId','')!~'^cut:v1:[0-9a-f]{64}$' then
    raise exception 'production required-source cut did not seal'
      using errcode='55000';
  end if;
  select * into strict v_cut from public.source_cuts cut
  where cut.workspace_key=p_workspace_key
    and cut.source_cut_id=v_seed->>'sourceCutId';
  if v_cut.source_cut_id=p_shadow_source_cut_id
    or v_cut.required_sources is distinct from v_required_sources
    or jsonb_array_length(v_cut.manifest->'cursors')<>v_required_count
    or exists(select 1 from public.truth_shadow_root_source_cuts root_scope
      where root_scope.source_cut_id=v_cut.source_cut_id)
    or not exists(
      select 1 from public.source_cut_cursors cut_cursor
      where cut_cursor.source_cut_id=v_cut.source_cut_id
        and cut_cursor.source_system='gmail'
        and cut_cursor.connection_key='primary'
        and cut_cursor.through_cursor_version=v_scope.through_cursor_version
        and cut_cursor.through_cursor_value=v_scope.through_cursor_value
    ) then
    raise exception 'production cut escaped the exact accepted required-source vector'
      using errcode='23514';
  end if;

  v_exclusions:=private.truth_build_documented_gap_exclusions_v1(
    p_workspace_key,v_cut.source_cut_id
  );
  if jsonb_typeof(v_exclusions)<>'array'
    or (v_cut.completeness='complete' and (
      v_cut.gaps<>'[]'::jsonb or v_exclusions<>'[]'::jsonb))
    or (v_cut.completeness='degraded' and (
      jsonb_array_length(v_cut.gaps)=0
      or jsonb_array_length(v_exclusions)<>jsonb_array_length(v_cut.gaps))) then
    raise exception 'production cut documented-gap receipt is not exact'
      using errcode='23514';
  end if;

  select coalesce(frontier.frontier_hash,'') into v_model_frontier_hash
  from public.truth_primary_model_review_cut_frontiers frontier
  where frontier.workspace_key=p_workspace_key
    and frontier.source_cut_id=p_shadow_source_cut_id;
  v_model_frontier_hash:=coalesce(v_model_frontier_hash,'');
  v_required_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_cut.required_sources),'UTF8'
  ),'sha256'),'hex');
  v_cursor_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_cut.manifest->'cursors'),'UTF8'
  ),'sha256'),'hex');
  v_exclusion_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_exclusions),'UTF8'
  ),'sha256'),'hex');
  v_receipt:=jsonb_build_object(
    'schemaVersion','truth-production-cut-acceptance-bridge-v1',
    'workspaceKey',p_workspace_key,
    'shadowSourceCutId',p_shadow_source_cut_id,
    'shadowSourceCutManifestHash',v_shadow_cut.manifest_hash,
    'productionSourceCutId',v_cut.source_cut_id,
    'productionSourceCutManifestHash',v_cut.manifest_hash,
    'shadowScopeReceiptId',v_scope.scope_receipt_id,
    'shadowScopeReceiptHash',v_scope.scope_receipt_hash,
    'acceptanceEpochManifestHash',v_scope.acceptance_epoch_manifest_hash,
    'primaryModelReviewFrontierHash',v_model_frontier_hash,
    'requiredSourceManifestHash',v_required_hash,
    'cursorManifestHash',v_cursor_hash,
    'documentedGapExclusionHash',v_exclusion_hash,
    'sourceCutCompleteness',v_cut.completeness,
    'productionEligible',true,
    'productionPublicationAttempted',false,
    'publishesTruth',false,
    'performsActions',false
  );
  v_bridge_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt),'UTF8'
  ),'sha256'),'hex');

  select * into v_existing
  from public.truth_production_cut_acceptance_bridges bridge
  where bridge.production_source_cut_id=v_cut.source_cut_id;
  if found then
    if v_existing.shadow_source_cut_id<>p_shadow_source_cut_id
      or v_existing.canonical_receipt is distinct from v_receipt
      or v_existing.bridge_hash<>v_bridge_hash then
      raise exception 'production-cut bridge conflicts on replay'
        using errcode='23505';
    end if;
    return v_seed||jsonb_build_object(
      'status','already_bridged','bridgeId',v_existing.bridge_id,
      'bridgeHash',v_existing.bridge_hash,
      'productionSourceCutId',v_cut.source_cut_id,
      'shadowSourceCutId',p_shadow_source_cut_id,
      'productionEligible',true,'productionPublicationAttempted',false,
      'publishesTruth',false,'performsActions',false
    );
  end if;
  if exists(select 1 from public.truth_builds build
      where build.workspace_key=p_workspace_key
        and build.source_cut_id=v_cut.source_cut_id)
    or exists(select 1 from public.truth_publications publication
      where publication.workspace_key=p_workspace_key
        and publication.source_cut_id=v_cut.source_cut_id) then
    raise exception 'production-cut bridge cannot attach after build or publication'
      using errcode='23514';
  end if;

  insert into public.truth_production_cut_acceptance_bridges(
    bridge_id,bridge_hash,workspace_key,shadow_source_cut_id,
    production_source_cut_id,shadow_scope_receipt_id,shadow_scope_receipt_hash,
    acceptance_epoch_manifest_hash,primary_model_review_frontier_hash,
    required_source_manifest,required_source_manifest_hash,cursor_manifest,
    cursor_manifest_hash,documented_gap_exclusions,
    documented_gap_exclusion_hash,canonical_receipt,schema_version
  ) values(
    'truth-production-cut-acceptance-bridge:v1:'||v_bridge_hash,v_bridge_hash,
    p_workspace_key,p_shadow_source_cut_id,v_cut.source_cut_id,
    v_scope.scope_receipt_id,v_scope.scope_receipt_hash,
    v_scope.acceptance_epoch_manifest_hash,v_model_frontier_hash,
    v_cut.required_sources,v_required_hash,v_cut.manifest->'cursors',v_cursor_hash,
    v_exclusions,v_exclusion_hash,v_receipt,
    'truth-production-cut-acceptance-bridge-v1'
  );
  return v_seed||jsonb_build_object(
    'status','bridged','bridgeId',
      'truth-production-cut-acceptance-bridge:v1:'||v_bridge_hash,
    'bridgeHash',v_bridge_hash,
    'productionSourceCutId',v_cut.source_cut_id,
    'shadowSourceCutId',p_shadow_source_cut_id,
    'productionEligible',true,'productionPublicationAttempted',false,
    'publishesTruth',false,'performsActions',false
  );
end;
$function$;

create or replace function public.seal_truth_production_cut_from_accepted_gmail_v1(
  p_workspace_key text,
  p_shadow_source_cut_id text,
  p_created_by text,
  p_sync_token text
) returns jsonb
language sql security definer set search_path=''
set statement_timeout='250s' set lock_timeout='10s'
as $function$
  select private.seal_truth_production_cut_from_accepted_gmail_v1(
    p_workspace_key,p_shadow_source_cut_id,p_created_by,p_sync_token
  );
$function$;

revoke all on function private.seal_truth_production_cut_from_accepted_gmail_v1(
  text,text,text,text
) from public,anon,authenticated,service_role;
revoke all on function public.seal_truth_production_cut_from_accepted_gmail_v1(
  text,text,text,text
) from public,anon,authenticated;
grant execute on function public.seal_truth_production_cut_from_accepted_gmail_v1(
  text,text,text,text
) to service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)'
      ::regprocedure
  ) into v_definition;
  if position('truth_shadow_root_source_cuts' in v_definition)=0
    or position('truth_build_documented_gap_exclusions_v1' in v_definition)=0
    or position('production required-source registry is not the reviewed four-source vector'
      in v_definition)=0
    or position('production-cut bridge cannot attach after build or publication'
      in v_definition)=0
    or position('private.seal_source_cut' in v_definition)=0
    or position('insert into public.truth_builds' in v_definition)>0
    or position('insert into public.truth_publications' in v_definition)>0
    or position('insert into public.accepted_claims' in v_definition)>0 then
    raise exception 'production-cut bridge authority is incomplete or over-broad'
      using errcode='55000';
  end if;
  select proconfig into v_config from pg_proc
  where oid='public.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)'
    ::regprocedure;
  if v_config is distinct from array[
      'search_path=""','statement_timeout=250s','lock_timeout=10s'
    ]::text[]
    or has_function_privilege('anon',
      'public.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute')
    or not has_function_privilege('service_role',
      'public.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute') then
    raise exception 'production-cut bridge ACL/config is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;
