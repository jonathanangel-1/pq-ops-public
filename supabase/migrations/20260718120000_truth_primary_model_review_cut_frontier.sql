-- Bind explicitly reviewed primary Gmail model claims to the exact source cut
-- that existed after their durable review. Candidate acceptance alone is not
-- a sealed-cut frontier. This migration creates receipts only; it does not
-- create/alter claims, perform model work, publish truth, send mail, or act.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_guard text;
begin
  if to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.candidate_claim_envelopes') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.candidate_claim_decisions') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null
    or to_regclass('public.truth_review_resolutions') is null
    or to_regclass('public.gmail_model_extraction_results') is null
    or to_regclass('public.truth_model_requests') is null
    or to_regclass('public.truth_model_sync_attempt_outcomes') is null
    or to_regprocedure(
      'private.truth_gmail_live_message_model_job_allowed_v1(text,uuid)'
    ) is null
    or to_regprocedure('private.source_observation_within_cut(text,text,text,text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.guard_truth_shadow_build_input_scope()') is null then
    raise exception 'primary model-review cut frontier prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.guard_truth_shadow_build_input_scope()'::regprocedure
  ) into v_guard;
  if position('truth_shadow_late_claim_bound_to_cut_v1' in v_guard)=0
    or position('shadow build accepted claim escaped the sealed acceptance frontier'
      in v_guard)=0 then
    raise exception 'shadow build accepted-claim guard differs from reviewed contract'
      using errcode='23514';
  end if;
end;
$preflight$;

create table if not exists public.truth_primary_model_review_cut_frontiers (
  frontier_id text primary key check (
    frontier_id='truth-primary-model-review-cut:v1:'||frontier_hash
  ),
  frontier_hash text not null unique check(frontier_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  source_system text not null check(source_system='gmail'),
  connection_key text not null check(connection_key='primary'),
  source_cut_id text not null unique,
  source_cut_manifest_hash text not null check(source_cut_manifest_hash~'^[0-9a-f]{64}$'),
  source_cut_completeness text not null check(source_cut_completeness in ('complete','degraded')),
  root_scope_receipt_id text not null unique,
  root_scope_receipt_hash text not null check(root_scope_receipt_hash~'^[0-9a-f]{64}$'),
  root_batch_id uuid not null,
  through_cursor_version bigint not null check(through_cursor_version>0),
  through_cursor_value text not null,
  item_count integer not null check(item_count>0),
  item_manifest jsonb not null check(
    jsonb_typeof(item_manifest)='array'
    and jsonb_array_length(item_manifest)=item_count
  ),
  item_manifest_hash text not null check(item_manifest_hash~'^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check(jsonb_typeof(canonical_receipt)='object'),
  schema_version text not null check(
    schema_version='truth-primary-model-review-cut-frontier-v1'
  ),
  shadow_only boolean not null default true check(shadow_only=true),
  production_eligible boolean not null default false check(production_eligible=false),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_cut_id)
    references public.source_cuts(workspace_key,source_cut_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_scope_receipt_id)
    references public.truth_shadow_root_source_cuts(workspace_key,scope_receipt_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(item_manifest_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(item_manifest),'UTF8'
  ),'sha256'),'hex')),
  check(frontier_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_receipt->>'schemaVersion'=schema_version),
  check(canonical_receipt->>'workspaceKey'=workspace_key),
  check(canonical_receipt->>'sourceSystem'=source_system),
  check(canonical_receipt->>'connectionKey'=connection_key),
  check(canonical_receipt->>'sourceCutId'=source_cut_id),
  check(canonical_receipt->>'sourceCutManifestHash'=source_cut_manifest_hash),
  check(canonical_receipt->>'sourceCutCompleteness'=source_cut_completeness),
  check(canonical_receipt->>'rootScopeReceiptId'=root_scope_receipt_id),
  check(canonical_receipt->>'rootScopeReceiptHash'=root_scope_receipt_hash),
  check(canonical_receipt->>'rootBatchId'=root_batch_id::text),
  check((canonical_receipt->>'throughCursorVersion')::bigint=through_cursor_version),
  check(canonical_receipt->>'throughCursorValue'=through_cursor_value),
  check((canonical_receipt->>'itemCount')::integer=item_count),
  check(canonical_receipt->>'itemManifestHash'=item_manifest_hash),
  check((canonical_receipt->>'shadowOnly')::boolean=true),
  check((canonical_receipt->>'productionEligible')::boolean=false),
  check((canonical_receipt->>'productionPublicationAttempted')::boolean=false),
  check((canonical_receipt->>'candidateClaimsCreated')::boolean=false),
  check((canonical_receipt->>'acceptedClaimsCreated')::boolean=false),
  check((canonical_receipt->>'modelCallsPerformed')::boolean=false),
  check((canonical_receipt->>'publishesTruth')::boolean=false),
  check((canonical_receipt->>'performsActions')::boolean=false),
  unique(workspace_key,frontier_id)
);

create unique index if not exists gmail_model_extraction_results_workspace_identity_uidx
  on public.gmail_model_extraction_results(workspace_key,result_id);

create table if not exists public.truth_primary_model_review_cut_frontier_items (
  item_id text primary key check(
    item_id='truth-primary-model-review-cut-item:v1:'||item_hash
  ),
  item_hash text not null unique check(item_hash~'^[0-9a-f]{64}$'),
  frontier_id text not null,
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  ordinal integer not null check(ordinal>=0),
  source_cut_id text not null,
  root_batch_id uuid not null,
  source_cursor_version bigint not null check(source_cursor_version>0),
  source_cursor_value text not null,
  source_observation_id text not null,
  source_observation_content_hash text not null check(
    source_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  model_child_job_id uuid not null,
  model_result_id text not null,
  model_result_hash text not null check(model_result_hash~'^[0-9a-f]{64}$'),
  model_request_id text not null,
  model_request_hash text not null check(model_request_hash~'^[0-9a-f]{64}$'),
  model_outcome_id text not null,
  model_outcome_hash text not null check(model_outcome_hash~'^[0-9a-f]{64}$'),
  candidate_manifest_hash text not null check(candidate_manifest_hash~'^[0-9a-f]{64}$'),
  candidate_claim_version_id text not null,
  candidate_item_hash text not null check(candidate_item_hash~'^[0-9a-f]{64}$'),
  decision_version_id text not null,
  decision_item_hash text not null check(decision_item_hash~'^[0-9a-f]{64}$'),
  review_resolution_id text not null,
  review_receipt_hash text not null check(review_receipt_hash~'^[0-9a-f]{64}$'),
  acceptance_binding_id text not null,
  acceptance_binding_hash text not null check(acceptance_binding_hash~'^[0-9a-f]{64}$'),
  accepted_claim_version_id text not null,
  accepted_claim_item_hash text not null check(accepted_claim_item_hash~'^[0-9a-f]{64}$'),
  canonical_item jsonb not null check(jsonb_typeof(canonical_item)='object'),
  schema_version text not null check(
    schema_version='truth-primary-model-review-cut-frontier-item-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique(frontier_id,ordinal),
  unique(frontier_id,accepted_claim_version_id),
  foreign key(workspace_key,frontier_id)
    references public.truth_primary_model_review_cut_frontiers(
      workspace_key,frontier_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key,source_cut_id)
    references public.source_cuts(workspace_key,source_cut_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,model_child_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,model_result_id)
    references public.gmail_model_extraction_results(workspace_key,result_id)
    on update restrict on delete restrict,
  foreign key(model_request_id,workspace_key)
    references public.truth_model_requests(request_id,workspace_key)
    on update restrict on delete restrict,
  foreign key(workspace_key,model_outcome_id)
    references public.truth_model_sync_attempt_outcomes(workspace_key,outcome_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,candidate_claim_version_id)
    references public.candidate_claim_envelopes(workspace_key,candidate_claim_version_id)
    on update restrict on delete restrict,
  foreign key(decision_version_id)
    references public.candidate_claim_decisions(decision_version_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,review_resolution_id)
    references public.truth_review_resolutions(workspace_key,review_resolution_id)
    on update restrict on delete restrict,
  foreign key(acceptance_binding_id)
    references public.candidate_claim_acceptance_bindings(binding_id)
    on update restrict on delete restrict,
  foreign key(accepted_claim_version_id)
    references public.accepted_claims(claim_version_id)
    on update restrict on delete restrict,
  check(item_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_item),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_item->>'schemaVersion'=schema_version),
  check(canonical_item->>'workspaceKey'=workspace_key),
  check(canonical_item->>'sourceCutId'=source_cut_id),
  check(canonical_item->>'rootBatchId'=root_batch_id::text),
  check((canonical_item->>'sourceCursorVersion')::bigint=source_cursor_version),
  check(canonical_item->>'sourceCursorValue'=source_cursor_value),
  check(canonical_item->>'sourceObservationId'=source_observation_id),
  check(canonical_item->>'sourceObservationContentHash'=source_observation_content_hash),
  check(canonical_item->>'modelChildJobId'=model_child_job_id::text),
  check(canonical_item->>'modelResultId'=model_result_id),
  check(canonical_item->>'modelResultHash'=model_result_hash),
  check(canonical_item->>'modelRequestId'=model_request_id),
  check(canonical_item->>'modelRequestHash'=model_request_hash),
  check(canonical_item->>'modelOutcomeId'=model_outcome_id),
  check(canonical_item->>'modelOutcomeHash'=model_outcome_hash),
  check(canonical_item->>'candidateManifestHash'=candidate_manifest_hash),
  check(canonical_item->>'candidateClaimVersionId'=candidate_claim_version_id),
  check(canonical_item->>'candidateItemHash'=candidate_item_hash),
  check(canonical_item->>'decisionVersionId'=decision_version_id),
  check(canonical_item->>'decisionItemHash'=decision_item_hash),
  check(canonical_item->>'reviewResolutionId'=review_resolution_id),
  check(canonical_item->>'reviewReceiptHash'=review_receipt_hash),
  check(canonical_item->>'acceptanceBindingId'=acceptance_binding_id),
  check(canonical_item->>'acceptanceBindingHash'=acceptance_binding_hash),
  check(canonical_item->>'acceptedClaimVersionId'=accepted_claim_version_id),
  check(canonical_item->>'acceptedClaimItemHash'=accepted_claim_item_hash),
  check((canonical_item->>'productionPublicationAttempted')::boolean=false)
);

do $immutable$
declare v_table text;
begin
  foreach v_table in array array[
    'truth_primary_model_review_cut_frontiers',
    'truth_primary_model_review_cut_frontier_items'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I',v_table,v_table);
    execute format('create trigger %I_immutable before update or delete on public.%I '
      ||'for each row execute function public.reject_immutable_truth_mutation()',v_table,v_table);
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on public.%I to service_role',v_table);
  end loop;
end;
$immutable$;

create or replace function private.bind_truth_primary_model_review_cut_frontier_v1(
  p_source_cut_id text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='120s' set lock_timeout='10s'
as $function$
declare
  v_cut public.source_cuts%rowtype;
  v_scope public.truth_shadow_root_source_cuts%rowtype;
  v_cursor public.source_cut_cursors%rowtype;
  v_existing public.truth_primary_model_review_cut_frontiers%rowtype;
  v_potential_count integer;
  v_rows jsonb;
  v_item_count integer;
  v_manifest jsonb;
  v_manifest_hash text;
  v_receipt jsonb;
  v_frontier_hash text;
  v_frontier_id text;
  v_row jsonb;
begin
  select * into strict v_cut from public.source_cuts cut
  where cut.source_cut_id=p_source_cut_id;
  select * into v_scope from public.truth_shadow_root_source_cuts scope_row
  where scope_row.workspace_key=v_cut.workspace_key
    and scope_row.source_cut_id=v_cut.source_cut_id;
  if not found or v_scope.source_system<>'gmail'
    or v_scope.connection_key<>'primary' then
    return jsonb_build_object('ok',true,'status','not_applicable',
      'productionPublicationAttempted',false);
  end if;
  select * into strict v_cursor from public.source_cut_cursors cursor_row
  where cursor_row.source_cut_id=v_cut.source_cut_id
    and cursor_row.source_system='gmail'
    and cursor_row.connection_key='primary';
  select * into v_existing
  from public.truth_primary_model_review_cut_frontiers frontier
  where frontier.source_cut_id=v_cut.source_cut_id;
  if found then
    return v_existing.canonical_receipt||jsonb_build_object(
      'ok',true,'status','already_bound','frontierId',v_existing.frontier_id,
      'frontierHash',v_existing.frontier_hash,
      'productionPublicationAttempted',false);
  end if;

  perform private.truth_source_cut_mutation_lock(v_cut.workspace_key);
  if exists(select 1 from public.truth_builds build
      where build.workspace_key=v_cut.workspace_key
        and build.source_cut_id=v_cut.source_cut_id)
    or exists(select 1 from public.truth_publications publication
      where publication.workspace_key=v_cut.workspace_key
        and publication.source_cut_id=v_cut.source_cut_id) then
    raise exception 'primary model-review frontier cannot attach after build or publication'
      using errcode='55000';
  end if;

  select count(distinct claim.claim_version_id)::integer into v_potential_count
  from public.accepted_claims claim
  join public.accepted_claim_envelopes claim_envelope
    on claim_envelope.workspace_key=v_cut.workspace_key
   and claim_envelope.claim_version_id=claim.claim_version_id
  join public.candidate_claim_acceptance_bindings acceptance
    on acceptance.accepted_claim_version_id=claim.claim_version_id
  join public.candidate_claim_envelopes candidate
    on candidate.workspace_key=v_cut.workspace_key
   and candidate.candidate_claim_version_id=acceptance.candidate_claim_version_id
  join public.source_observations observation
    on observation.workspace_key=candidate.workspace_key
   and observation.observation_id=candidate.source_observation_id
   and observation.content_hash=candidate.source_observation_content_hash
  where claim.decision='accepted'
    and claim.acceptance_method='operator'
    and candidate.extraction_method='model'
    and candidate.source_object_type='gmail_message_parsed'
    and observation.source_system='gmail'
    and observation.connection_key='primary'
    and observation.source_cursor_version<=v_cursor.through_cursor_version
    and private.source_observation_within_cut(
      v_cut.workspace_key,v_cut.source_cut_id,
      observation.observation_id,observation.content_hash
    )
    and not exists(
      select 1
      from public.truth_shadow_claim_acceptance_epoch_items epoch_item
      join public.truth_shadow_claim_acceptance_epochs epoch
        on epoch.workspace_key=epoch_item.workspace_key
       and epoch.epoch_id=epoch_item.epoch_id
      where epoch_item.workspace_key=v_cut.workspace_key
        and epoch_item.accepted_claim_version_id=claim.claim_version_id
        and epoch_item.accepted_claim_item_hash=claim_envelope.envelope_hash
        and epoch_item.decision='accept'
        and v_scope.acceptance_epoch_manifest@>jsonb_build_array(
          jsonb_build_object('epochId',epoch.epoch_id,
            'epochReceiptHash',epoch.receipt_hash)
        )
    )
    and not private.truth_shadow_late_claim_bound_to_cut_v1(
      v_cut.workspace_key,v_cut.source_cut_id,
      claim.claim_version_id,claim_envelope.envelope_hash
    );

  if v_potential_count=0 then
    return jsonb_build_object('ok',true,'status','not_applicable',
      'itemCount',0,'productionPublicationAttempted',false);
  end if;

  with base as (
    select claim.claim_version_id,claim_envelope.envelope_hash as claim_item_hash,
      claim.predicate,claim.polarity,claim.normalized_value,
      candidate.candidate_claim_version_id,candidate.envelope_hash as candidate_item_hash,
      decision.decision_version_id,decision.decision_hash,
      review.review_resolution_id,review.receipt_hash as review_receipt_hash,
      acceptance.binding_id,acceptance.binding_hash,
      observation.observation_id,observation.content_hash as observation_content_hash,
      lineage.job_id as model_child_job_id,lineage.root_batch_id,
      lineage.source_cursor_version,lineage.source_cursor_value,
      job.processor_version,job.result->>'completionHash' as completion_hash,
      model_result.result_id,model_result.result_hash,
      model_request.request_id as model_request_id,
      model_request.request_hash as model_request_hash,
      model_outcome.outcome_id as model_outcome_id,
      model_outcome.outcome_hash as model_outcome_hash,
      manifest.manifest_hash as candidate_manifest_hash,
      claim.created_at as claim_created_at,review.created_at as review_created_at
    from public.accepted_claims claim
    join public.accepted_claim_envelopes claim_envelope
      on claim_envelope.workspace_key=v_cut.workspace_key
     and claim_envelope.claim_version_id=claim.claim_version_id
     and claim_envelope.envelope_hash=claim.claim_content_hash
    join public.candidate_claim_acceptance_bindings acceptance
      on acceptance.accepted_claim_version_id=claim.claim_version_id
    join public.candidate_claim_envelopes candidate
      on candidate.workspace_key=v_cut.workspace_key
     and candidate.candidate_claim_version_id=acceptance.candidate_claim_version_id
    join public.candidate_claim_decisions decision
      on decision.candidate_claim_version_id=candidate.candidate_claim_version_id
     and decision.decision_version_id=acceptance.decision_version_id
    join public.truth_review_resolutions review
      on review.workspace_key=candidate.workspace_key
     and review.target_kind='candidate_claim'
     and review.target_id=candidate.candidate_claim_version_id
     and review.target_item_hash=candidate.envelope_hash
     and review.decision='accept'
     and review.decision_version_id=decision.decision_version_id
     and review.decision_item_hash=decision.decision_hash
     and review.accepted_kind='accepted_claim'
     and review.accepted_item_id=claim.claim_version_id
     and review.accepted_item_hash=claim_envelope.envelope_hash
     and review.binding_id=acceptance.binding_id
     and review.binding_item_hash=acceptance.binding_hash
    join public.source_observations observation
      on observation.workspace_key=candidate.workspace_key
     and observation.observation_id=candidate.source_observation_id
     and observation.content_hash=candidate.source_observation_content_hash
    join lateral (
      select (array_agg(candidate_lineage.job_id order by candidate_lineage.job_id))[1]
          as job_id,
        (array_agg(job_lineage.root_batch_id order by candidate_lineage.job_id))[1]
          as root_batch_id,
        min(job_lineage.source_cursor_version) as source_cursor_version,
        min(job_lineage.source_cursor_value) as source_cursor_value,
        count(*)::integer as lineage_count
      from public.candidate_claim_job_lineage candidate_lineage
      join public.source_processing_job_lineage job_lineage
        on job_lineage.job_id=candidate_lineage.job_id
       and job_lineage.workspace_key=candidate.workspace_key
      where candidate_lineage.candidate_claim_version_id=
        candidate.candidate_claim_version_id
        and candidate_lineage.source_observation_id=candidate.source_observation_id
    ) lineage on lineage.lineage_count=1
    join public.source_processing_jobs job
      on job.workspace_key=candidate.workspace_key
     and job.job_id=lineage.job_id
     and job.source_system='gmail' and job.connection_key='primary'
     and job.job_kind='gmail_extract_message_model_claims'
     and job.observation_id=candidate.source_observation_id
     and job.source_object_id=candidate.source_object_id
     and job.state='succeeded'
     and job.result->>'outcome'='succeeded'
    join public.gmail_model_extraction_results model_result
      on model_result.workspace_key=job.workspace_key
     and model_result.model_child_job_id=job.job_id
     and job.result#>>'{modelTerminal,resultId}'=model_result.result_id
     and job.result#>>'{modelTerminal,resultHash}'=model_result.result_hash
    join public.truth_model_requests model_request
      on model_request.workspace_key=model_result.workspace_key
     and model_request.request_id=model_result.model_request_id
     and model_request.source_job_id=job.job_id
     and model_request.observation_id=observation.observation_id
     and model_request.observation_content_hash=observation.content_hash
     and model_request.state='succeeded'
     and model_request.model_snapshot=model_result.actual_model
    join public.truth_model_sync_attempt_outcomes model_outcome
      on model_outcome.workspace_key=model_result.workspace_key
     and model_outcome.outcome_id=model_result.model_attempt_outcome_id
     and model_outcome.request_id=model_request.request_id
     and model_outcome.classification='success'
     and model_outcome.request_sent=true
     and model_outcome.http_status between 200 and 299
     and model_outcome.outcome_unknown=false
     and model_outcome.billing_outcome_unknown=false
     and model_outcome.provider_result_hash=model_result.provider_result_hash
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=job.workspace_key
     and manifest.job_id=job.job_id
     and manifest.source_observation_id=observation.observation_id
     and manifest.manifest_hash=model_result.candidate_manifest_hash
     and manifest.candidate_count=model_result.candidate_count
     and manifest.canonical_manifest->'candidates'@>jsonb_build_array(
       jsonb_build_object(
         'candidateClaimVersionId',candidate.candidate_claim_version_id,
         'itemHash',candidate.envelope_hash
       )
     )
    where claim.decision='accepted' and claim.acceptance_method='operator'
      and decision.decision='accept' and decision.decision_method='operator'
      and candidate.extraction_method='model'
      and candidate.recommendation='review'
      and candidate.source_review_required=false
      and candidate.source_object_type='gmail_message_parsed'
      and observation.source_system='gmail' and observation.connection_key='primary'
      and observation.source_cursor_version=lineage.source_cursor_version
      and observation.source_cursor_version<=v_cursor.through_cursor_version
      and lineage.source_cursor_version<=v_cursor.through_cursor_version
      and claim.created_at<=v_cut.sealed_at
      and candidate.created_at<=v_cut.sealed_at
      and decision.created_at<=v_cut.sealed_at
      and acceptance.created_at<=v_cut.sealed_at
      and review.created_at<=v_cut.sealed_at
      and model_result.created_at<=v_cut.sealed_at
      and private.truth_gmail_live_message_model_job_allowed_v1(
        job.workspace_key,job.job_id
      )
      and private.source_observation_within_cut(
        v_cut.workspace_key,v_cut.source_cut_id,
        observation.observation_id,observation.content_hash
      )
      and exists(select 1 from public.accepted_claim_evidence evidence
        where evidence.claim_version_id=claim.claim_version_id
          and evidence.evidence_role='primary'
          and evidence.observation_id=claim.primary_observation_id)
      and not exists(
        select 1
        from public.accepted_claim_evidence evidence
        left join public.source_observations evidence_observation
          on evidence_observation.workspace_key=v_cut.workspace_key
         and evidence_observation.observation_id=evidence.observation_id
        where evidence.claim_version_id=claim.claim_version_id
          and (evidence_observation.observation_id is null
            or evidence_observation.source_system<>'gmail'
            or evidence_observation.connection_key<>'primary'
            or evidence_observation.source_cursor_version>
              v_cursor.through_cursor_version
            or not private.source_observation_within_cut(
              v_cut.workspace_key,v_cut.source_cut_id,
              evidence_observation.observation_id,evidence_observation.content_hash
            ))
      )
      and not exists(
        select 1
        from public.truth_shadow_claim_acceptance_epoch_items epoch_item
        join public.truth_shadow_claim_acceptance_epochs epoch
          on epoch.workspace_key=epoch_item.workspace_key
         and epoch.epoch_id=epoch_item.epoch_id
        where epoch_item.workspace_key=v_cut.workspace_key
          and epoch_item.accepted_claim_version_id=claim.claim_version_id
          and epoch_item.accepted_claim_item_hash=claim_envelope.envelope_hash
          and epoch_item.decision='accept'
          and v_scope.acceptance_epoch_manifest@>jsonb_build_array(
            jsonb_build_object('epochId',epoch.epoch_id,
              'epochReceiptHash',epoch.receipt_hash)
          )
      )
      and not private.truth_shadow_late_claim_bound_to_cut_v1(
        v_cut.workspace_key,v_cut.source_cut_id,
        claim.claim_version_id,claim_envelope.envelope_hash
      )
  ), numbered as (
    select base.*,row_number() over(
      order by claim_created_at,claim_version_id
    )-1 as ordinal
    from base
  ), canonicalized as (
    select numbered.*,jsonb_build_object(
      'schemaVersion','truth-primary-model-review-cut-frontier-item-v1',
      'workspaceKey',v_cut.workspace_key,
      'sourceCutId',v_cut.source_cut_id,
      'rootBatchId',root_batch_id,
      'sourceCursorVersion',source_cursor_version,
      'sourceCursorValue',source_cursor_value,
      'sourceObservationId',observation_id,
      'sourceObservationContentHash',observation_content_hash,
      'modelChildJobId',model_child_job_id,
      'modelProcessorVersion',processor_version,
      'modelCompletionHash',completion_hash,
      'modelResultId',result_id,
      'modelResultHash',result_hash,
      'modelRequestId',model_request_id,
      'modelRequestHash',model_request_hash,
      'modelOutcomeId',model_outcome_id,
      'modelOutcomeHash',model_outcome_hash,
      'candidateManifestHash',candidate_manifest_hash,
      'candidateClaimVersionId',candidate_claim_version_id,
      'candidateItemHash',candidate_item_hash,
      'decisionVersionId',decision_version_id,
      'decisionItemHash',decision_hash,
      'reviewResolutionId',review_resolution_id,
      'reviewReceiptHash',review_receipt_hash,
      'acceptanceBindingId',binding_id,
      'acceptanceBindingHash',binding_hash,
      'acceptedClaimVersionId',claim_version_id,
      'acceptedClaimItemHash',claim_item_hash,
      'predicate',predicate,'polarity',polarity,
      'normalizedValue',normalized_value,
      'claimCreatedAt',private.canonical_truth_timestamp(claim_created_at),
      'reviewCreatedAt',private.canonical_truth_timestamp(review_created_at),
      'productionPublicationAttempted',false
    ) as canonical_item
    from numbered
  ), hashed as (
    select canonicalized.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(canonical_item),'UTF8'
    ),'sha256'),'hex') as item_hash
    from canonicalized
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ordinal',ordinal,
    'itemId','truth-primary-model-review-cut-item:v1:'||item_hash,
    'itemHash',item_hash,
    'acceptedClaimVersionId',claim_version_id,
    'canonicalItem',canonical_item
  ) order by ordinal),'[]'::jsonb) into v_rows
  from hashed;

  v_item_count:=jsonb_array_length(v_rows);
  if v_item_count<>v_potential_count then
    raise exception 'primary model-review cut frontier is partial (% eligible, % potential)',
      v_item_count,v_potential_count using errcode='23514';
  end if;
  select jsonb_agg(jsonb_build_object(
    'ordinal',(entry->>'ordinal')::integer,
    'itemId',entry->>'itemId','itemHash',entry->>'itemHash',
    'acceptedClaimVersionId',entry->>'acceptedClaimVersionId'
  ) order by (entry->>'ordinal')::integer)
  into v_manifest from jsonb_array_elements(v_rows) entry;
  v_manifest_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_manifest),'UTF8'
  ),'sha256'),'hex');
  v_receipt:=jsonb_build_object(
    'schemaVersion','truth-primary-model-review-cut-frontier-v1',
    'workspaceKey',v_cut.workspace_key,'sourceSystem','gmail',
    'connectionKey','primary','sourceCutId',v_cut.source_cut_id,
    'sourceCutManifestHash',v_cut.manifest_hash,
    'sourceCutCompleteness',v_cut.completeness,
    'rootScopeReceiptId',v_scope.scope_receipt_id,
    'rootScopeReceiptHash',v_scope.scope_receipt_hash,
    'rootBatchId',v_scope.root_batch_id,
    'throughCursorVersion',v_cursor.through_cursor_version,
    'throughCursorValue',v_cursor.through_cursor_value,
    'itemCount',v_item_count,'itemManifestHash',v_manifest_hash,
    'authorityKind','explicit_operator_model_review',
    'shadowOnly',true,'productionEligible',false,
    'productionPublicationAttempted',false,
    'candidateClaimsCreated',false,'acceptedClaimsCreated',false,
    'modelCallsPerformed',false,'publishesTruth',false,'performsActions',false
  );
  v_frontier_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt),'UTF8'
  ),'sha256'),'hex');
  v_frontier_id:='truth-primary-model-review-cut:v1:'||v_frontier_hash;
  insert into public.truth_primary_model_review_cut_frontiers(
    frontier_id,frontier_hash,workspace_key,source_system,connection_key,
    source_cut_id,source_cut_manifest_hash,source_cut_completeness,
    root_scope_receipt_id,root_scope_receipt_hash,root_batch_id,
    through_cursor_version,through_cursor_value,item_count,item_manifest,
    item_manifest_hash,canonical_receipt,schema_version
  ) values(
    v_frontier_id,v_frontier_hash,v_cut.workspace_key,'gmail','primary',
    v_cut.source_cut_id,v_cut.manifest_hash,v_cut.completeness,
    v_scope.scope_receipt_id,v_scope.scope_receipt_hash,v_scope.root_batch_id,
    v_cursor.through_cursor_version,v_cursor.through_cursor_value,
    v_item_count,v_manifest,v_manifest_hash,v_receipt,
    'truth-primary-model-review-cut-frontier-v1'
  );

  for v_row in select value from jsonb_array_elements(v_rows) loop
    insert into public.truth_primary_model_review_cut_frontier_items(
      item_id,item_hash,frontier_id,workspace_key,ordinal,source_cut_id,
      root_batch_id,source_cursor_version,source_cursor_value,
      source_observation_id,source_observation_content_hash,
      model_child_job_id,model_result_id,model_result_hash,
      model_request_id,model_request_hash,model_outcome_id,model_outcome_hash,
      candidate_manifest_hash,candidate_claim_version_id,candidate_item_hash,
      decision_version_id,decision_item_hash,review_resolution_id,
      review_receipt_hash,acceptance_binding_id,acceptance_binding_hash,
      accepted_claim_version_id,accepted_claim_item_hash,
      canonical_item,schema_version
    ) values(
      v_row->>'itemId',v_row->>'itemHash',v_frontier_id,v_cut.workspace_key,
      (v_row->>'ordinal')::integer,v_cut.source_cut_id,
      (v_row->'canonicalItem'->>'rootBatchId')::uuid,
      (v_row->'canonicalItem'->>'sourceCursorVersion')::bigint,
      v_row->'canonicalItem'->>'sourceCursorValue',
      v_row->'canonicalItem'->>'sourceObservationId',
      v_row->'canonicalItem'->>'sourceObservationContentHash',
      (v_row->'canonicalItem'->>'modelChildJobId')::uuid,
      v_row->'canonicalItem'->>'modelResultId',
      v_row->'canonicalItem'->>'modelResultHash',
      v_row->'canonicalItem'->>'modelRequestId',
      v_row->'canonicalItem'->>'modelRequestHash',
      v_row->'canonicalItem'->>'modelOutcomeId',
      v_row->'canonicalItem'->>'modelOutcomeHash',
      v_row->'canonicalItem'->>'candidateManifestHash',
      v_row->'canonicalItem'->>'candidateClaimVersionId',
      v_row->'canonicalItem'->>'candidateItemHash',
      v_row->'canonicalItem'->>'decisionVersionId',
      v_row->'canonicalItem'->>'decisionItemHash',
      v_row->'canonicalItem'->>'reviewResolutionId',
      v_row->'canonicalItem'->>'reviewReceiptHash',
      v_row->'canonicalItem'->>'acceptanceBindingId',
      v_row->'canonicalItem'->>'acceptanceBindingHash',
      v_row->'canonicalItem'->>'acceptedClaimVersionId',
      v_row->'canonicalItem'->>'acceptedClaimItemHash',
      v_row->'canonicalItem',
      'truth-primary-model-review-cut-frontier-item-v1'
    );
  end loop;
  return v_receipt||jsonb_build_object(
    'ok',true,'status','bound','frontierId',v_frontier_id,
    'frontierHash',v_frontier_hash,'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function private.bind_truth_primary_model_review_cut_frontier_v1(text)
  from public,anon,authenticated,service_role;

create or replace function private.auto_bind_truth_primary_model_review_cut_frontier_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.source_system='gmail' and new.connection_key='primary' then
    perform private.bind_truth_primary_model_review_cut_frontier_v1(new.source_cut_id);
  end if;
  return new;
end;
$function$;

drop trigger if exists zzzz_truth_primary_model_review_cut_frontier
  on public.truth_shadow_root_source_cuts;
create trigger zzzz_truth_primary_model_review_cut_frontier
after insert on public.truth_shadow_root_source_cuts
for each row execute function
  private.auto_bind_truth_primary_model_review_cut_frontier_v1();
revoke all on function private.auto_bind_truth_primary_model_review_cut_frontier_v1()
  from public,anon,authenticated,service_role;

create or replace function private.truth_primary_model_review_claim_bound_to_cut_v1(
  p_workspace_key text,p_source_cut_id text,
  p_claim_version_id text,p_claim_item_hash text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.truth_primary_model_review_cut_frontier_items item
    join public.truth_primary_model_review_cut_frontiers frontier
      on frontier.frontier_id=item.frontier_id
     and frontier.workspace_key=item.workspace_key
     and frontier.source_cut_id=item.source_cut_id
    join public.source_cuts cut
      on cut.workspace_key=frontier.workspace_key
     and cut.source_cut_id=frontier.source_cut_id
     and cut.manifest_hash=frontier.source_cut_manifest_hash
    join public.truth_shadow_root_source_cuts scope_row
      on scope_row.workspace_key=frontier.workspace_key
     and scope_row.source_cut_id=frontier.source_cut_id
     and scope_row.scope_receipt_id=frontier.root_scope_receipt_id
     and scope_row.scope_receipt_hash=frontier.root_scope_receipt_hash
    join public.accepted_claim_envelopes claim_envelope
      on claim_envelope.workspace_key=item.workspace_key
     and claim_envelope.claim_version_id=item.accepted_claim_version_id
     and claim_envelope.envelope_hash=item.accepted_claim_item_hash
    join public.accepted_claims claim
      on claim.claim_version_id=claim_envelope.claim_version_id
     and claim.claim_content_hash=claim_envelope.envelope_hash
     and claim.decision='accepted' and claim.acceptance_method='operator'
    join public.candidate_claim_acceptance_bindings acceptance
      on acceptance.binding_id=item.acceptance_binding_id
     and acceptance.binding_hash=item.acceptance_binding_hash
     and acceptance.accepted_claim_version_id=claim.claim_version_id
     and acceptance.candidate_claim_version_id=item.candidate_claim_version_id
     and acceptance.decision_version_id=item.decision_version_id
    join public.candidate_claim_envelopes candidate
      on candidate.workspace_key=item.workspace_key
     and candidate.candidate_claim_version_id=item.candidate_claim_version_id
     and candidate.envelope_hash=item.candidate_item_hash
     and candidate.extraction_method='model'
     and candidate.source_review_required=false
     and candidate.source_object_type='gmail_message_parsed'
    join public.candidate_claim_decisions decision
      on decision.decision_version_id=item.decision_version_id
     and decision.decision_hash=item.decision_item_hash
     and decision.candidate_claim_version_id=candidate.candidate_claim_version_id
     and decision.decision='accept' and decision.decision_method='operator'
    join public.truth_review_resolutions review
      on review.workspace_key=item.workspace_key
     and review.review_resolution_id=item.review_resolution_id
     and review.receipt_hash=item.review_receipt_hash
     and review.target_kind='candidate_claim'
     and review.target_id=candidate.candidate_claim_version_id
     and review.target_item_hash=candidate.envelope_hash
     and review.decision='accept'
     and review.accepted_item_id=claim.claim_version_id
     and review.accepted_item_hash=claim_envelope.envelope_hash
     and review.binding_id=acceptance.binding_id
    join public.source_processing_jobs job
      on job.workspace_key=item.workspace_key
     and job.job_id=item.model_child_job_id
     and job.source_system='gmail' and job.connection_key='primary'
     and job.job_kind='gmail_extract_message_model_claims'
     and job.state='succeeded' and job.result->>'outcome'='succeeded'
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=item.workspace_key
     and lineage.job_id=job.job_id
     and lineage.root_batch_id=item.root_batch_id
     and lineage.source_cursor_version=item.source_cursor_version
     and lineage.source_cursor_value=item.source_cursor_value
    join public.candidate_claim_job_lineage candidate_lineage
      on candidate_lineage.job_id=job.job_id
     and candidate_lineage.candidate_claim_version_id=candidate.candidate_claim_version_id
     and candidate_lineage.source_observation_id=item.source_observation_id
    join public.gmail_model_extraction_results model_result
      on model_result.workspace_key=item.workspace_key
     and model_result.model_child_job_id=job.job_id
     and model_result.result_id=item.model_result_id
     and model_result.result_hash=item.model_result_hash
     and model_result.model_request_id=item.model_request_id
     and model_result.model_attempt_outcome_id=item.model_outcome_id
     and model_result.candidate_manifest_hash=item.candidate_manifest_hash
    join public.truth_model_requests model_request
      on model_request.workspace_key=item.workspace_key
     and model_request.request_id=item.model_request_id
     and model_request.request_hash=item.model_request_hash
     and model_request.source_job_id=job.job_id
     and model_request.state='succeeded'
    join public.truth_model_sync_attempt_outcomes model_outcome
      on model_outcome.workspace_key=item.workspace_key
     and model_outcome.outcome_id=item.model_outcome_id
     and model_outcome.outcome_hash=item.model_outcome_hash
     and model_outcome.request_id=model_request.request_id
     and model_outcome.classification='success'
     and model_outcome.request_sent=true
     and model_outcome.outcome_unknown=false
     and model_outcome.billing_outcome_unknown=false
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=item.workspace_key
     and manifest.job_id=job.job_id
     and manifest.manifest_hash=item.candidate_manifest_hash
     and manifest.candidate_count=model_result.candidate_count
    where item.workspace_key=p_workspace_key
      and item.source_cut_id=p_source_cut_id
      and item.accepted_claim_version_id=p_claim_version_id
      and item.accepted_claim_item_hash=p_claim_item_hash
      and frontier.source_system='gmail' and frontier.connection_key='primary'
      and frontier.frontier_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(frontier.canonical_receipt),'UTF8'
      ),'sha256'),'hex')
      and frontier.item_manifest@>jsonb_build_array(jsonb_build_object(
        'ordinal',item.ordinal,'itemId',item.item_id,'itemHash',item.item_hash,
        'acceptedClaimVersionId',item.accepted_claim_version_id
      ))
      and item.item_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(item.canonical_item),'UTF8'
      ),'sha256'),'hex')
      and claim.created_at<=cut.sealed_at and review.created_at<=cut.sealed_at
      and item.source_cursor_version<=frontier.through_cursor_version
      and private.truth_gmail_live_message_model_job_allowed_v1(
        item.workspace_key,item.model_child_job_id
      )
      and exists(select 1 from public.accepted_claim_evidence evidence
        where evidence.claim_version_id=claim.claim_version_id
          and evidence.evidence_role='primary'
          and evidence.observation_id=claim.primary_observation_id)
      and not exists(
        select 1
        from public.accepted_claim_evidence evidence
        left join public.source_observations observation
          on observation.workspace_key=item.workspace_key
         and observation.observation_id=evidence.observation_id
        where evidence.claim_version_id=claim.claim_version_id
          and (observation.observation_id is null
            or observation.source_system<>'gmail'
            or observation.connection_key<>'primary'
            or observation.source_cursor_version>frontier.through_cursor_version
            or not private.source_observation_within_cut(
              item.workspace_key,item.source_cut_id,
              observation.observation_id,observation.content_hash
            ))
      )
      and frontier.production_publication_attempted=false
  );
$function$;

revoke all on function private.truth_primary_model_review_claim_bound_to_cut_v1(
  text,text,text,text
) from public,anon,authenticated,service_role;

do $rewrite_build_guard$
declare
  v_signature regprocedure:='private.guard_truth_shadow_build_input_scope()'::regprocedure;
  v_definition text;
  v_old text:=$old$    ) and not private.truth_shadow_late_claim_bound_to_cut_v1(
      v_scope.workspace_key,
      v_scope.source_cut_id,
      new.item_id,
      new.item_hash
    ) then$old$;
  v_new text:=$new$    ) and not private.truth_shadow_late_claim_bound_to_cut_v1(
      v_scope.workspace_key,
      v_scope.source_cut_id,
      new.item_id,
      new.item_hash
    ) and not private.truth_primary_model_review_claim_bound_to_cut_v1(
      v_scope.workspace_key,
      v_scope.source_cut_id,
      new.item_id,
      new.item_hash
    ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_primary_model_review_claim_bound_to_cut_v1' in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'primary model-review build-guard rewrite did not match'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite_build_guard$;

-- Bind only the current primary Gmail cut when it has not started a build.
-- Historical cuts are immutable history and receive no retrospective frontier.
do $bind_current_unbuilt_cut$
declare v_cut_id text;
begin
  select scope_row.source_cut_id into v_cut_id
  from public.truth_shadow_root_source_cuts scope_row
  join public.source_cursors cursor_row
    on cursor_row.workspace_key=scope_row.workspace_key
   and cursor_row.source_system=scope_row.source_system
   and cursor_row.connection_key=scope_row.connection_key
   and cursor_row.cursor_version=scope_row.through_cursor_version
   and cursor_row.cursor_value=scope_row.through_cursor_value
   and cursor_row.last_batch_id=scope_row.root_batch_id
  where scope_row.workspace_key='primary'
    and scope_row.source_system='gmail'
    and scope_row.connection_key='primary'
    and not exists(select 1 from public.truth_builds build
      where build.workspace_key=scope_row.workspace_key
        and build.source_cut_id=scope_row.source_cut_id)
    and not exists(select 1 from public.truth_publications publication
      where publication.workspace_key=scope_row.workspace_key
        and publication.source_cut_id=scope_row.source_cut_id)
  order by scope_row.created_at desc limit 1;
  if v_cut_id is not null then
    perform private.bind_truth_primary_model_review_cut_frontier_v1(v_cut_id);
  end if;
end;
$bind_current_unbuilt_cut$;

do $verify$
declare v_guard text;
begin
  select pg_get_functiondef(
    'private.guard_truth_shadow_build_input_scope()'::regprocedure
  ) into v_guard;
  if position('truth_primary_model_review_claim_bound_to_cut_v1' in v_guard)=0
    or position('truth_shadow_late_claim_bound_to_cut_v1' in v_guard)=0
    or not exists(select 1 from pg_trigger
      where tgrelid='public.truth_shadow_root_source_cuts'::regclass
        and tgname='zzzz_truth_primary_model_review_cut_frontier'
        and tgenabled<>'D')
    or has_function_privilege('anon',
      'private.bind_truth_primary_model_review_cut_frontier_v1(text)','EXECUTE')
    or has_function_privilege('authenticated',
      'private.bind_truth_primary_model_review_cut_frontier_v1(text)','EXECUTE')
    or has_function_privilege('service_role',
      'private.bind_truth_primary_model_review_cut_frontier_v1(text)','EXECUTE') then
    raise exception 'primary model-review cut frontier installation is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
