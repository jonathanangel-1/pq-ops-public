-- Close a shadow-only link-review frontier without pretending that 947
-- mechanical decisions were individually reviewed.  One immutable sealed
-- Gmail link epoch is sampled by deterministic hash rank with mandatory
-- coverage of every entity-type/relationship/reason-code stratum.  The sample
-- is resolved by a real operator; only an all-accept sample may authorize the
-- remaining uniform deterministic, conflict-free proposals under a distinct
-- policy authority.  Every proposal keeps its original review decision and
-- receives an explicit second decision, accepted link, standard binding, and
-- proof-carrying authority receipt.

create schema if not exists private;

do $preflight$
begin
  if to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.valid_truth_review_token(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.append_observation_entity_link(text,jsonb,text)') is null
    or to_regprocedure('private.truth_review_gaps_for_source_cut(text,jsonb)') is null
    or to_regclass('public.truth_gmail_link_epochs') is null
    or to_regclass('public.truth_gmail_link_epoch_members') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regclass('public.truth_link_resolution_runs') is null
    or to_regclass('public.truth_link_candidate_proposals') is null
    or to_regclass('public.truth_link_candidate_evidence') is null
    or to_regclass('public.truth_link_candidate_decisions') is null
    or to_regclass('public.truth_link_acceptance_bindings') is null
    or to_regclass('public.truth_review_resolutions') is null
    or to_regclass('public.observation_entity_links') is null
    or to_regclass('public.observation_entity_link_envelopes') is null
    or to_regclass('public.truth_shadow_root_source_cuts') is null
    or to_regclass('public.source_cuts') is null
    or to_regclass('public.truth_builds') is null
    or to_regclass('public.truth_publications') is null then
    raise exception 'shadow link sampled-acceptance prerequisites are unavailable'
      using errcode = '55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_shadow_link_sample_acceptance_plans (
  plan_id text primary key check (
    plan_id ~ '^truth-shadow-link-sample-plan:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null check (connection_key like 'shadow-%'),
  root_batch_id uuid not null,
  link_epoch_id text not null,
  link_epoch_hash text not null check (link_epoch_hash ~ '^[0-9a-f]{64}$'),
  link_epoch_seal_id text not null,
  link_epoch_seal_hash text not null check (
    link_epoch_seal_hash ~ '^[0-9a-f]{64}$'
  ),
  degraded_source_cut_id text not null,
  degraded_source_cut_manifest_hash text not null check (
    degraded_source_cut_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  degraded_gap_witness_hash text not null check (
    degraded_gap_witness_hash ~ '^[0-9a-f]{64}$'
  ),
  policy_version text not null check (
    policy_version = 'truth-shadow-deterministic-link-sampled-acceptance-v1'
  ),
  sample_review_policy_version text not null check (
    sample_review_policy_version = 'truth-shadow-deterministic-link-sample-review-v1'
  ),
  sample_algorithm_version text not null check (
    sample_algorithm_version = 'truth-shadow-link-stratified-hash-sample-v1'
  ),
  population_count integer not null check (population_count > 0),
  sample_count integer not null check (
    sample_count > 0 and sample_count <= population_count
  ),
  stratum_count integer not null check (
    stratum_count > 0 and stratum_count <= sample_count
  ),
  population_manifest jsonb not null check (
    jsonb_typeof(population_manifest) = 'array'
  ),
  population_manifest_hash text not null check (
    population_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  sample_seed text not null check (sample_seed ~ '^[0-9a-f]{64}$'),
  canonical_plan jsonb not null check (jsonb_typeof(canonical_plan) = 'object'),
  plan_hash text not null unique check (plan_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-link-sample-acceptance-plan-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  mutates_operational_state boolean not null default false check (
    mutates_operational_state = false
  ),
  production_eligible boolean not null default false check (
    production_eligible = false
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, root_batch_id),
  unique (workspace_key, plan_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, link_epoch_id)
    references public.truth_gmail_link_epochs(workspace_key, epoch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, degraded_source_cut_id)
    references public.source_cuts(workspace_key, source_cut_id)
    on update restrict on delete restrict,
  check (population_count = jsonb_array_length(population_manifest)),
  check (population_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(population_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (plan_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_plan), 'UTF8'
  ), 'sha256'), 'hex')),
  check (plan_id = 'truth-shadow-link-sample-plan:v1:' || plan_hash)
);

create table if not exists public.truth_shadow_link_sample_acceptance_members (
  plan_id text not null,
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  proposal_id text not null,
  ordinal integer not null check (ordinal > 0),
  is_sample boolean not null,
  sample_ordinal integer check (sample_ordinal is null or sample_ordinal > 0),
  stratum jsonb not null check (jsonb_typeof(stratum) = 'object'),
  stratum_hash text not null check (stratum_hash ~ '^[0-9a-f]{64}$'),
  sample_rank_hash text not null check (sample_rank_hash ~ '^[0-9a-f]{64}$'),
  proposal_hash text not null check (proposal_hash ~ '^[0-9a-f]{64}$'),
  resolution_run_id text not null,
  resolution_hash text not null check (resolution_hash ~ '^[0-9a-f]{64}$'),
  initial_decision_version_id text not null,
  initial_decision_hash text not null check (
    initial_decision_hash ~ '^[0-9a-f]{64}$'
  ),
  evidence_manifest jsonb not null check (
    jsonb_typeof(evidence_manifest) = 'array'
    and jsonb_array_length(evidence_manifest) > 0
  ),
  evidence_manifest_hash text not null check (
    evidence_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_member jsonb not null check (
    jsonb_typeof(canonical_member) = 'object'
  ),
  member_hash text not null unique check (member_hash ~ '^[0-9a-f]{64}$'),
  member_id text not null unique check (
    member_id ~ '^truth-shadow-link-sample-member:v1:[0-9a-f]{64}$'
  ),
  schema_version text not null check (
    schema_version = 'truth-shadow-link-sample-acceptance-member-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (
    production_eligible = false
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_key, plan_id, proposal_id),
  unique (workspace_key, plan_id, ordinal),
  foreign key (workspace_key, plan_id)
    references public.truth_shadow_link_sample_acceptance_plans(
      workspace_key, plan_id
    ) on update restrict on delete restrict,
  check (is_sample = (sample_ordinal is not null)),
  check (evidence_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(evidence_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (member_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_member), 'UTF8'
  ), 'sha256'), 'hex')),
  check (member_id = 'truth-shadow-link-sample-member:v1:' || member_hash)
);

create unique index if not exists
  truth_shadow_link_sample_member_sample_ordinal_unique
on public.truth_shadow_link_sample_acceptance_members(
  workspace_key, plan_id, sample_ordinal
)
where sample_ordinal is not null;

create index if not exists truth_shadow_link_sample_member_run_idx
  on public.truth_shadow_link_sample_acceptance_members(
    workspace_key, plan_id, is_sample, ordinal
  );

create table if not exists public.truth_shadow_link_sample_authorizations (
  authorization_id text primary key check (
    authorization_id ~ '^truth-shadow-link-sample-authorization:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  plan_id text not null,
  sample_manifest jsonb not null check (jsonb_typeof(sample_manifest) = 'array'),
  sample_manifest_hash text not null check (
    sample_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  authorized_by text not null,
  attestation_reason text not null,
  canonical_authorization jsonb not null check (
    jsonb_typeof(canonical_authorization) = 'object'
  ),
  authorization_hash text not null unique check (
    authorization_hash ~ '^[0-9a-f]{64}$'
  ),
  schema_version text not null check (
    schema_version = 'truth-shadow-link-sample-authorization-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  mutates_operational_state boolean not null default false check (
    mutates_operational_state = false
  ),
  production_eligible boolean not null default false check (
    production_eligible = false
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, plan_id),
  foreign key (workspace_key, plan_id)
    references public.truth_shadow_link_sample_acceptance_plans(
      workspace_key, plan_id
    ) on update restrict on delete restrict,
  check (sample_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(sample_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (
    authorization_id =
      'truth-shadow-link-sample-authorization:v1:' || authorization_hash
  )
);

create table if not exists public.truth_shadow_link_sample_acceptance_items (
  item_id text primary key check (
    item_id ~ '^truth-shadow-link-sample-item:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  plan_id text not null,
  proposal_id text not null,
  ordinal integer not null check (ordinal > 0),
  authority_kind text not null check (
    authority_kind = any (array['operator_sample', 'sampled_policy'])
  ),
  review_resolution_id text,
  review_resolution_hash text not null default '' check (
    review_resolution_hash = '' or review_resolution_hash ~ '^[0-9a-f]{64}$'
  ),
  decision_version_id text not null,
  decision_hash text not null check (decision_hash ~ '^[0-9a-f]{64}$'),
  accepted_link_version_id text not null,
  accepted_link_item_hash text not null check (
    accepted_link_item_hash ~ '^[0-9a-f]{64}$'
  ),
  binding_id text not null,
  binding_hash text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  canonical_item jsonb not null check (jsonb_typeof(canonical_item) = 'object'),
  item_hash text not null unique check (item_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-link-sample-acceptance-item-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (
    production_eligible = false
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, plan_id, proposal_id),
  unique (workspace_key, plan_id, ordinal),
  foreign key (workspace_key, plan_id, proposal_id)
    references public.truth_shadow_link_sample_acceptance_members(
      workspace_key, plan_id, proposal_id
    ) on update restrict on delete restrict,
  check (
    (authority_kind = 'operator_sample'
      and review_resolution_id is not null
      and review_resolution_hash ~ '^[0-9a-f]{64}$')
    or
    (authority_kind = 'sampled_policy'
      and review_resolution_id is null
      and review_resolution_hash = '')
  ),
  check (item_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_item), 'UTF8'
  ), 'sha256'), 'hex')),
  check (item_id = 'truth-shadow-link-sample-item:v1:' || item_hash)
);

create table if not exists public.truth_shadow_link_sample_acceptance_seals (
  seal_id text primary key check (
    seal_id ~ '^truth-shadow-link-sample-seal:v1:[0-9a-f]{64}$'
  ),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  plan_id text not null,
  population_count integer not null check (population_count > 0),
  sample_count integer not null check (sample_count > 0),
  operator_sample_acceptance_count integer not null check (
    operator_sample_acceptance_count > 0
  ),
  sampled_policy_acceptance_count integer not null check (
    sampled_policy_acceptance_count >= 0
  ),
  item_manifest jsonb not null check (jsonb_typeof(item_manifest) = 'array'),
  item_manifest_hash text not null check (item_manifest_hash ~ '^[0-9a-f]{64}$'),
  canonical_seal jsonb not null check (jsonb_typeof(canonical_seal) = 'object'),
  seal_hash text not null unique check (seal_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-shadow-link-sample-acceptance-seal-v1'
  ),
  shadow_only boolean not null default true check (shadow_only = true),
  production_eligible boolean not null default false check (
    production_eligible = false
  ),
  production_publication_attempted boolean not null default false check (
    production_publication_attempted = false
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, plan_id),
  foreign key (workspace_key, plan_id)
    references public.truth_shadow_link_sample_acceptance_plans(
      workspace_key, plan_id
    ) on update restrict on delete restrict,
  check (population_count = jsonb_array_length(item_manifest)),
  check (population_count =
    operator_sample_acceptance_count + sampled_policy_acceptance_count),
  check (sample_count = operator_sample_acceptance_count),
  check (item_manifest_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(item_manifest), 'UTF8'
  ), 'sha256'), 'hex')),
  check (seal_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_seal), 'UTF8'
  ), 'sha256'), 'hex')),
  check (seal_id = 'truth-shadow-link-sample-seal:v1:' || seal_hash)
);

do $immutability$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_shadow_link_sample_acceptance_plans',
    'truth_shadow_link_sample_acceptance_members',
    'truth_shadow_link_sample_authorizations',
    'truth_shadow_link_sample_acceptance_items',
    'truth_shadow_link_sample_acceptance_seals'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I',
      v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I '
      || 'for each row execute function public.reject_immutable_truth_mutation()',
      v_table, v_table
    );
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format(
      'revoke all on public.%I from public,anon,authenticated,service_role',
      v_table
    );
    execute format('grant select on public.%I to service_role', v_table);
  end loop;
end;
$immutability$;

-- This selector is deliberately narrower than the old auto-link policy.  It
-- describes the new sampled cohort without rewriting the historical review
-- disposition that produced it.
create or replace function private.truth_shadow_link_sample_population_v1(
  p_workspace_key text,
  p_epoch_id text
)
returns table (
  proposal_id text,
  proposal_hash text,
  resolution_run_id text,
  resolution_hash text,
  initial_decision_version_id text,
  initial_decision_hash text,
  evidence_manifest jsonb,
  evidence_manifest_hash text,
  stratum jsonb,
  stratum_hash text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    proposal.proposal_id,
    proposal.proposal_hash,
    run.resolution_run_id,
    run.resolution_hash,
    latest.decision_version_id,
    latest.decision_hash,
    evidence.manifest,
    encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(evidence.manifest), 'UTF8'
    ), 'sha256'), 'hex'),
    stratum.value,
    encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(stratum.value), 'UTF8'
    ), 'sha256'), 'hex')
  from public.truth_gmail_link_epoch_members member
  join public.truth_link_resolution_runs run
    on run.workspace_key = member.workspace_key
   and run.job_id = member.link_job_id
  join public.truth_link_candidate_proposals proposal
    on proposal.workspace_key = run.workspace_key
   and proposal.resolution_run_id = run.resolution_run_id
  join lateral (
    select decision_row.*
    from public.truth_link_candidate_decisions decision_row
    where decision_row.proposal_id = proposal.proposal_id
    order by decision_row.decision_no desc
    limit 1
  ) latest on true
  cross join lateral (
    select jsonb_build_object(
      'entityType', proposal.canonical_proposal #>>
        '{candidate,proposal,entityType}',
      'relationship', proposal.canonical_proposal #>>
        '{candidate,proposal,relationship}',
      'reasonCode', proposal.canonical_proposal #>>
        '{candidate,proposal,reasonCode}'
    ) as value
  ) stratum
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'ordinal', candidate_evidence.ordinal,
      'observationId', observation.observation_id,
      'observationContentHash', observation.content_hash
    ) order by candidate_evidence.ordinal), '[]'::jsonb) as manifest
    from public.truth_link_candidate_evidence candidate_evidence
    join public.source_observations observation
      on observation.workspace_key = proposal.workspace_key
     and observation.observation_id = candidate_evidence.observation_id
     and observation.source_system = 'gmail'
    where candidate_evidence.proposal_id = proposal.proposal_id
  ) evidence
  where member.workspace_key = p_workspace_key
    and member.epoch_id = p_epoch_id
    and run.root_batch_id = (
      select epoch.root_batch_id
      from public.truth_gmail_link_epochs epoch
      where epoch.workspace_key = p_workspace_key
        and epoch.epoch_id = p_epoch_id
    )
    and proposal.candidate_kind = 'entity_link'
    and proposal.proposal_method = 'deterministic'
    and proposal.auto_accept_eligible = true
    and proposal.requires_review = true
    and proposal.policy_disposition = 'review'
    and proposal.policy_class = 'operator_review_required'
    and proposal.has_conflict = false
    and proposal.membership_change = false
    and proposal.canonical_proposal #>>
      '{candidate,proposal,linkMethod}' = 'deterministic'
    and proposal.canonical_proposal #>>
      '{candidate,proposal,autoAcceptEligible}' = 'true'
    and nullif(proposal.canonical_proposal #>>
      '{candidate,proposal,entityType}', '') is not null
    and nullif(proposal.canonical_proposal #>>
      '{candidate,proposal,entityKey}', '') is not null
    and nullif(proposal.canonical_proposal #>>
      '{candidate,proposal,relationship}', '') is not null
    and nullif(proposal.canonical_proposal #>>
      '{candidate,proposal,reasonCode}', '') is not null
    and proposal.canonical_proposal #>>
      '{candidate,assessment,policyDisposition}' = 'review'
    and proposal.canonical_proposal #>>
      '{candidate,assessment,policyClass}' = 'operator_review_required'
    and proposal.canonical_proposal #>>
      '{candidate,assessment,conflict}' = 'false'
    and proposal.canonical_proposal #>>
      '{candidate,assessment,membershipChange}' = 'false'
    -- The link resolver stored proposal_hash over the jsonb text rendering
    -- (canonical for a given stored jsonb value), not truth_canonical_json_text.
    -- Integrity must be checked in the writer's own convention.
    and proposal.proposal_hash = encode(extensions.digest(convert_to(
      proposal.canonical_proposal::text, 'UTF8'
    ), 'sha256'), 'hex')
    and latest.decision_no = 1
    and latest.previous_decision_version_id is null
    and latest.decision = 'review'
    and latest.decision_method = 'policy'
    and latest.policy_version = 'truth-link-policy-v1'
    and latest.decision_hash = encode(extensions.digest(convert_to(
      latest.canonical_decision::text, 'UTF8'
    ), 'sha256'), 'hex')
    and jsonb_array_length(evidence.manifest) > 0
    and not exists (
      select 1
      from public.truth_link_acceptance_bindings binding
      where binding.proposal_id = proposal.proposal_id
    )
    and not exists (
      select 1
      from public.truth_review_resolutions review_resolution
      where review_resolution.workspace_key = proposal.workspace_key
        and review_resolution.target_kind = 'link_proposal'
        and review_resolution.target_id = proposal.proposal_id
    );
$function$;

revoke all on function private.truth_shadow_link_sample_population_v1(text,text)
  from public, anon, authenticated, service_role;

create or replace function private.truth_shadow_link_sample_scope_open_v1(
  p_workspace_key text,
  p_plan_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.truth_shadow_link_sample_acceptance_plans plan
    where plan.workspace_key = p_workspace_key
      and plan.plan_id = p_plan_id
      and plan.source_system = 'gmail'
      and plan.connection_key like 'shadow-%'
      and plan.shadow_only = true
      and plan.mutates_operational_state = false
      and plan.production_eligible = false
      and plan.production_publication_attempted = false
      and not exists (
        select 1
        from public.truth_shadow_root_source_cuts root_cut
        join public.source_cuts source_cut
          on source_cut.workspace_key = root_cut.workspace_key
         and source_cut.source_cut_id = root_cut.source_cut_id
        where root_cut.workspace_key = plan.workspace_key
          and root_cut.root_batch_id = plan.root_batch_id
          and source_cut.completeness = 'complete'
      )
      and not exists (
        select 1
        from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = build.workspace_key
         and root_cut.source_cut_id = build.source_cut_id
        where root_cut.workspace_key = plan.workspace_key
          and root_cut.root_batch_id = plan.root_batch_id
      )
      and not exists (
        select 1
        from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key = publication.workspace_key
         and root_cut.source_cut_id = publication.source_cut_id
        where root_cut.workspace_key = plan.workspace_key
          and root_cut.root_batch_id = plan.root_batch_id
      )
  );
$function$;

revoke all on function private.truth_shadow_link_sample_scope_open_v1(text,text)
  from public, anon, authenticated, service_role;

create or replace function private.open_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_epoch public.truth_gmail_link_epochs%rowtype;
  v_epoch_seal public.truth_gmail_link_epoch_seals%rowtype;
  v_existing public.truth_shadow_link_sample_acceptance_plans%rowtype;
  v_cut record;
  v_population_count integer;
  v_all_proposal_count integer;
  v_declared_proposal_count integer;
  v_member_count integer;
  v_stratum_count integer;
  v_sample_count integer;
  v_population_manifest jsonb;
  v_population_manifest_hash text;
  v_current_gap_witness_hash text;
  v_sample_seed_canonical jsonb;
  v_sample_seed text;
  v_canonical_plan jsonb;
  v_plan_hash text;
  v_plan_id text;
begin
  if not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth review token' using errcode = '28000';
  end if;
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or coalesce(p_connection_key, '') not like 'shadow-%'
    or p_root_batch_id is null then
    raise exception 'shadow link sample plan scope is invalid'
      using errcode = '22023';
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-shadow-link-sample-plan:' || p_workspace_key || ':'
      || p_root_batch_id::text,
    0
  ));

  select * into v_existing
  from public.truth_shadow_link_sample_acceptance_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.root_batch_id = p_root_batch_id;
  if found then
    if v_existing.connection_key is distinct from p_connection_key then
      raise exception 'shadow link sample plan conflicts on replay'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true, 'status', 'opened', 'idempotent', true,
      'planId', v_existing.plan_id,
      'planHash', v_existing.plan_hash,
      'populationCount', v_existing.population_count,
      'sampleCount', v_existing.sample_count,
      'stratumCount', v_existing.stratum_count,
      'authorized', exists (
        select 1 from public.truth_shadow_link_sample_authorizations auth
        where auth.workspace_key = p_workspace_key
          and auth.plan_id = v_existing.plan_id
      ),
      'sealed', exists (
        select 1 from public.truth_shadow_link_sample_acceptance_seals seal
        where seal.workspace_key = p_workspace_key
          and seal.plan_id = v_existing.plan_id
      ),
      'productionPublicationAttempted', false
    );
  end if;

  select epoch.* into strict v_epoch
  from public.truth_gmail_link_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.root_batch_id = p_root_batch_id
    and epoch.connection_key = p_connection_key;
  select seal.* into strict v_epoch_seal
  from public.truth_gmail_link_epoch_seals seal
  where seal.workspace_key = p_workspace_key
    and seal.epoch_id = v_epoch.epoch_id;

  select count(*)::integer into v_member_count
  from public.truth_gmail_link_epoch_members member
  where member.workspace_key = p_workspace_key
    and member.epoch_id = v_epoch.epoch_id;
  if v_member_count <> v_epoch_seal.link_member_count then
    raise exception 'sealed Gmail link epoch member count is inconsistent'
      using errcode = '23514';
  end if;

  select count(*)::integer into v_all_proposal_count
  from public.truth_gmail_link_epoch_members member
  join public.truth_link_resolution_runs run
    on run.workspace_key = member.workspace_key
   and run.job_id = member.link_job_id
   and run.root_batch_id = v_epoch.root_batch_id
  join public.truth_link_candidate_proposals proposal
    on proposal.workspace_key = run.workspace_key
   and proposal.resolution_run_id = run.resolution_run_id
  where member.workspace_key = p_workspace_key
    and member.epoch_id = v_epoch.epoch_id;

  select coalesce(sum(run.proposal_count), 0)::integer
  into v_declared_proposal_count
  from public.truth_gmail_link_epoch_members member
  join public.truth_link_resolution_runs run
    on run.workspace_key = member.workspace_key
   and run.job_id = member.link_job_id
   and run.root_batch_id = v_epoch.root_batch_id
  where member.workspace_key = p_workspace_key
    and member.epoch_id = v_epoch.epoch_id;

  select count(*)::integer,
         count(distinct population.stratum_hash)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'proposalId', population.proposal_id,
           'proposalHash', population.proposal_hash,
           'resolutionRunId', population.resolution_run_id,
           'resolutionHash', population.resolution_hash,
           'initialDecisionVersionId', population.initial_decision_version_id,
           'initialDecisionHash', population.initial_decision_hash,
           'evidenceManifestHash', population.evidence_manifest_hash,
           'stratum', population.stratum,
           'stratumHash', population.stratum_hash
         ) order by population.proposal_id), '[]'::jsonb)
  into v_population_count, v_stratum_count, v_population_manifest
  from private.truth_shadow_link_sample_population_v1(
    p_workspace_key, v_epoch.epoch_id
  ) population;

  if v_population_count = 0
    or v_population_count <> v_all_proposal_count
    or v_population_count <> v_declared_proposal_count then
    raise exception 'sealed Gmail link epoch is not one exact uniform sampled cohort'
      using errcode = '23514';
  end if;
  v_sample_count := least(
    v_population_count,
    greatest(64, v_stratum_count)
  );
  v_population_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_population_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  select encode(extensions.digest(convert_to(
    coalesce(string_agg(
      population.proposal_id || ':' || population.proposal_hash,
      ',' order by population.proposal_id
    ), ''), 'UTF8'
  ), 'sha256'), 'hex')
  into v_current_gap_witness_hash
  from private.truth_shadow_link_sample_population_v1(
    p_workspace_key, v_epoch.epoch_id
  ) population;

  select root_cut.source_cut_id,
         source_cut.manifest_hash,
         gap.value->>'witnessHash' as gap_witness_hash
  into v_cut
  from public.truth_shadow_root_source_cuts root_cut
  join public.source_cuts source_cut
    on source_cut.workspace_key = root_cut.workspace_key
   and source_cut.source_cut_id = root_cut.source_cut_id
  cross join lateral jsonb_array_elements(source_cut.gaps) gap(value)
  where root_cut.workspace_key = p_workspace_key
    and root_cut.root_batch_id = p_root_batch_id
    and root_cut.connection_key = p_connection_key
    and root_cut.shadow_only = true
    and root_cut.production_eligible = false
    and root_cut.production_publication_attempted = false
    and source_cut.completeness = 'degraded'
    and gap.value->>'gapType' = 'LINK_WORKGROUP_REVIEW_PENDING'
    and (gap.value->>'count')::integer = v_population_count
    and gap.value->>'witnessHash' ~ '^[0-9a-f]{64}$'
  order by source_cut.sealed_at desc, root_cut.source_cut_id desc
  limit 1;
  if v_cut.source_cut_id is null then
    raise exception 'exact degraded link-review source-cut witness is unavailable'
      using errcode = '23514';
  end if;
  if v_cut.gap_witness_hash is distinct from v_current_gap_witness_hash then
    raise exception 'degraded link-review witness differs from the sampled cohort'
      using errcode = '23514';
  end if;

  if exists (
      select 1
      from public.truth_shadow_root_source_cuts root_cut
      join public.source_cuts source_cut
        on source_cut.workspace_key = root_cut.workspace_key
       and source_cut.source_cut_id = root_cut.source_cut_id
      where root_cut.workspace_key = p_workspace_key
        and root_cut.root_batch_id = p_root_batch_id
        and source_cut.completeness = 'complete'
    )
    or exists (
      select 1
      from public.truth_builds build
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = build.workspace_key
       and root_cut.source_cut_id = build.source_cut_id
      where root_cut.workspace_key = p_workspace_key
        and root_cut.root_batch_id = p_root_batch_id
    )
    or exists (
      select 1
      from public.truth_publications publication
      join public.truth_shadow_root_source_cuts root_cut
        on root_cut.workspace_key = publication.workspace_key
       and root_cut.source_cut_id = publication.source_cut_id
      where root_cut.workspace_key = p_workspace_key
        and root_cut.root_batch_id = p_root_batch_id
    ) then
    raise exception 'complete/built/published roots cannot open sampled link acceptance'
      using errcode = '23514';
  end if;

  v_sample_seed_canonical := jsonb_build_object(
    'schemaVersion', 'truth-shadow-link-sample-seed-v1',
    'workspaceKey', p_workspace_key,
    'connectionKey', p_connection_key,
    'rootBatchId', p_root_batch_id,
    'linkEpochId', v_epoch.epoch_id,
    'linkEpochHash', v_epoch.epoch_hash,
    'linkEpochSealHash', v_epoch_seal.seal_hash,
    'populationManifestHash', v_population_manifest_hash,
    'policyVersion', 'truth-shadow-deterministic-link-sampled-acceptance-v1',
    'sampleAlgorithmVersion', 'truth-shadow-link-stratified-hash-sample-v1'
  );
  v_sample_seed := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_sample_seed_canonical), 'UTF8'
  ), 'sha256'), 'hex');
  v_canonical_plan := jsonb_build_object(
    'schemaVersion', 'truth-shadow-link-sample-acceptance-plan-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', p_connection_key,
    'rootBatchId', p_root_batch_id,
    'linkEpochId', v_epoch.epoch_id,
    'linkEpochHash', v_epoch.epoch_hash,
    'linkEpochSealId', v_epoch_seal.seal_id,
    'linkEpochSealHash', v_epoch_seal.seal_hash,
    'degradedSourceCutId', v_cut.source_cut_id,
    'degradedSourceCutManifestHash', v_cut.manifest_hash,
    'degradedGapWitnessHash', v_cut.gap_witness_hash,
    'policyVersion', 'truth-shadow-deterministic-link-sampled-acceptance-v1',
    'sampleReviewPolicyVersion',
      'truth-shadow-deterministic-link-sample-review-v1',
    'sampleAlgorithmVersion', 'truth-shadow-link-stratified-hash-sample-v1',
    'populationCount', v_population_count,
    'sampleCount', v_sample_count,
    'stratumCount', v_stratum_count,
    'populationManifestHash', v_population_manifest_hash,
    'sampleSeed', v_sample_seed,
    'sampleRule', jsonb_build_object(
      'minimumGlobalSampleCount', 64,
      'mandatoryFirstRankPerStratum', true,
      'fillOrder', 'sha256-rank',
      'stratumFields', jsonb_build_array(
        'entityType', 'relationship', 'reasonCode'
      )
    ),
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionEligible', false,
    'productionPublicationAttempted', false
  );
  v_plan_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical_plan), 'UTF8'
  ), 'sha256'), 'hex');
  v_plan_id := 'truth-shadow-link-sample-plan:v1:' || v_plan_hash;

  insert into public.truth_shadow_link_sample_acceptance_plans (
    plan_id, workspace_key, source_system, connection_key, root_batch_id,
    link_epoch_id, link_epoch_hash, link_epoch_seal_id, link_epoch_seal_hash,
    degraded_source_cut_id, degraded_source_cut_manifest_hash,
    degraded_gap_witness_hash, policy_version, sample_review_policy_version,
    sample_algorithm_version, population_count, sample_count, stratum_count,
    population_manifest, population_manifest_hash, sample_seed,
    canonical_plan, plan_hash, schema_version
  ) values (
    v_plan_id, p_workspace_key, 'gmail', p_connection_key, p_root_batch_id,
    v_epoch.epoch_id, v_epoch.epoch_hash, v_epoch_seal.seal_id,
    v_epoch_seal.seal_hash, v_cut.source_cut_id, v_cut.manifest_hash,
    v_cut.gap_witness_hash,
    'truth-shadow-deterministic-link-sampled-acceptance-v1',
    'truth-shadow-deterministic-link-sample-review-v1',
    'truth-shadow-link-stratified-hash-sample-v1',
    v_population_count, v_sample_count, v_stratum_count,
    v_population_manifest, v_population_manifest_hash, v_sample_seed,
    v_canonical_plan, v_plan_hash,
    'truth-shadow-link-sample-acceptance-plan-v1'
  );

  with population as (
    select population.*,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(jsonb_build_object(
          'schemaVersion', 'truth-shadow-link-sample-rank-v1',
          'sampleSeed', v_sample_seed,
          'proposalId', population.proposal_id,
          'proposalHash', population.proposal_hash
        )), 'UTF8'
      ), 'sha256'), 'hex') as rank_hash
    from private.truth_shadow_link_sample_population_v1(
      p_workspace_key, v_epoch.epoch_id
    ) population
  ), stratum_ranked as (
    select population.*,
      row_number() over (
        partition by population.stratum_hash
        order by population.rank_hash, population.proposal_id
      ) as stratum_rank
    from population
  ), fill_ranked as (
    select stratum_ranked.*,
      count(*) filter (where stratum_rank > 1) over (
        order by rank_hash, proposal_id
      ) as fill_rank
    from stratum_ranked
  ), flagged as (
    select fill_ranked.*,
      (
        stratum_rank = 1
        or fill_rank <= v_sample_count - v_stratum_count
      ) as is_sample_member
    from fill_ranked
  ), numbered as (
    select flagged.*,
      row_number() over (order by proposal_id)::integer as member_ordinal,
      case when is_sample_member then
        count(*) filter (where is_sample_member) over (
          order by rank_hash, proposal_id
        )::integer
      end as member_sample_ordinal
    from flagged
  ), canonicalized as (
    select numbered.*,
      jsonb_build_object(
        'schemaVersion', 'truth-shadow-link-sample-acceptance-member-v1',
        'workspaceKey', p_workspace_key,
        'planId', v_plan_id,
        'proposalId', proposal_id,
        'proposalHash', proposal_hash,
        'resolutionRunId', resolution_run_id,
        'resolutionHash', resolution_hash,
        'initialDecisionVersionId', initial_decision_version_id,
        'initialDecisionHash', initial_decision_hash,
        'ordinal', member_ordinal,
        'isSample', is_sample_member,
        'sampleOrdinal', coalesce(member_sample_ordinal, 0),
        'stratum', stratum,
        'stratumHash', stratum_hash,
        'sampleRankHash', rank_hash,
        'evidenceManifestHash', evidence_manifest_hash,
        'shadowOnly', true,
        'productionEligible', false,
        'productionPublicationAttempted', false
      ) as member_canonical
    from numbered
  ), hashed as (
    select canonicalized.*,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(member_canonical), 'UTF8'
      ), 'sha256'), 'hex') as computed_member_hash
    from canonicalized
  )
  insert into public.truth_shadow_link_sample_acceptance_members (
    plan_id, workspace_key, proposal_id, ordinal, is_sample, sample_ordinal,
    stratum, stratum_hash, sample_rank_hash, proposal_hash,
    resolution_run_id, resolution_hash, initial_decision_version_id,
    initial_decision_hash, evidence_manifest, evidence_manifest_hash,
    canonical_member, member_hash, member_id, schema_version
  )
  select v_plan_id, p_workspace_key, proposal_id, member_ordinal,
    is_sample_member, member_sample_ordinal, stratum, stratum_hash, rank_hash,
    proposal_hash, resolution_run_id, resolution_hash,
    initial_decision_version_id, initial_decision_hash, evidence_manifest,
    evidence_manifest_hash, member_canonical, computed_member_hash,
    'truth-shadow-link-sample-member:v1:' || computed_member_hash,
    'truth-shadow-link-sample-acceptance-member-v1'
  from hashed;

  if (select count(*) from public.truth_shadow_link_sample_acceptance_members
      where workspace_key = p_workspace_key and plan_id = v_plan_id)
       <> v_population_count
    or (select count(*) from public.truth_shadow_link_sample_acceptance_members
      where workspace_key = p_workspace_key and plan_id = v_plan_id
        and is_sample) <> v_sample_count
    or exists (
      select 1
      from public.truth_shadow_link_sample_acceptance_members member
      where member.workspace_key = p_workspace_key
        and member.plan_id = v_plan_id
      group by member.stratum_hash
      having count(*) filter (where member.is_sample) = 0
    ) then
    raise exception 'stratified link sample membership is incomplete'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true, 'status', 'opened', 'idempotent', false,
    'planId', v_plan_id, 'planHash', v_plan_hash,
    'populationCount', v_population_count,
    'sampleCount', v_sample_count,
    'stratumCount', v_stratum_count,
    'authorized', false, 'sealed', false,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.open_truth_shadow_link_sample_acceptance(
  text,text,uuid,text,text
) from public, anon, authenticated, service_role;

create or replace function public.open_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.open_truth_shadow_link_sample_acceptance(
    p_workspace_key, p_connection_key, p_root_batch_id,
    p_review_token, p_sync_token
  );
$function$;

revoke all on function public.open_truth_shadow_link_sample_acceptance(
  text,text,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.open_truth_shadow_link_sample_acceptance(
  text,text,uuid,text,text
) to service_role;

create or replace function private.truth_shadow_link_entity_accept_request_v1(
  p_workspace_key text,
  p_proposal_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_proposal public.truth_link_candidate_proposals%rowtype;
  v_raw jsonb;
begin
  select * into strict v_proposal
  from public.truth_link_candidate_proposals proposal
  where proposal.workspace_key = p_workspace_key
    and proposal.proposal_id = p_proposal_id;
  v_raw := v_proposal.canonical_proposal->'candidate'->'proposal';
  if v_proposal.candidate_kind <> 'entity_link'
    or v_proposal.proposal_method <> 'deterministic'
    or not v_proposal.auto_accept_eligible
    or not v_proposal.requires_review
    or v_proposal.policy_disposition <> 'review'
    or v_proposal.policy_class <> 'operator_review_required'
    or v_proposal.has_conflict
    or v_proposal.membership_change
    or v_raw->>'linkMethod' <> 'deterministic'
    or v_raw->>'autoAcceptEligible' <> 'true'
    or nullif(v_raw->>'linkKey', '') is null
    or coalesce(v_raw->>'versionNo', '') !~ '^[1-9][0-9]*$'
    or nullif(v_raw->>'observationId', '') is null
    or nullif(v_raw->>'entityType', '') is null
    or nullif(v_raw->>'entityKey', '') is null
    or nullif(v_raw->>'relationship', '') is null
    or nullif(v_raw->>'decision', '') is null
    or coalesce(v_raw->>'confidence', '') !~ '^(0(\.[0-9]+)?|1(\.0+)?)$'
    or nullif(v_raw->>'linkerVersion', '') is null
    or jsonb_typeof(coalesce(v_raw->'evidenceSpan', 'null'::jsonb)) <> 'object'
    or nullif(v_raw->>'recordedAt', '') is null
    or nullif(v_raw->>'schemaVersion', '') is null then
    raise exception 'sampled link proposal no longer satisfies its exact cohort'
      using errcode = '23514';
  end if;
  return jsonb_build_object(
    'acceptedKind', 'entity_link',
    'link', jsonb_build_object(
      'linkKey', v_raw->>'linkKey',
      'versionNo', (v_raw->>'versionNo')::integer,
      'previousLinkVersionId', nullif(v_raw->>'previousLinkVersionId', ''),
      'observationId', v_raw->>'observationId',
      'entityType', v_raw->>'entityType',
      'entityKey', v_raw->>'entityKey',
      'relationship', v_raw->>'relationship',
      'decision', v_raw->>'decision',
      'confidence', (v_raw->>'confidence')::numeric,
      'linkMethod', v_raw->>'linkMethod',
      'linkerVersion', v_raw->>'linkerVersion',
      'evidenceSpan', coalesce(v_raw->'evidenceSpan', '{}'::jsonb),
      'recordedAt', v_raw->>'recordedAt',
      'schemaVersion', v_raw->>'schemaVersion'
    )
  );
end;
$function$;

revoke all on function private.truth_shadow_link_entity_accept_request_v1(
  text,text
) from public, anon, authenticated, service_role;

create or replace function private.append_truth_shadow_link_sample_decision_v1(
  p_workspace_key text,
  p_plan_id text,
  p_proposal_id text,
  p_decision text,
  p_method text,
  p_decided_by text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.truth_shadow_link_sample_acceptance_plans%rowtype;
  v_member public.truth_shadow_link_sample_acceptance_members%rowtype;
  v_proposal public.truth_link_candidate_proposals%rowtype;
  v_previous public.truth_link_candidate_decisions%rowtype;
  v_existing public.truth_link_candidate_decisions%rowtype;
  v_policy_version text;
  v_accepted_item_request jsonb;
  v_canonical_decision jsonb;
  v_decision_hash text;
  v_decision_version_id text;
  v_idempotent boolean := false;
begin
  if not private.truth_shadow_link_sample_scope_open_v1(
      p_workspace_key, p_plan_id
    ) then
    raise exception 'shadow link sampled-acceptance scope is closed'
      using errcode = '55000';
  end if;
  select * into strict v_plan
  from public.truth_shadow_link_sample_acceptance_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.plan_id = p_plan_id;
  select * into strict v_member
  from public.truth_shadow_link_sample_acceptance_members member
  where member.workspace_key = p_workspace_key
    and member.plan_id = p_plan_id
    and member.proposal_id = p_proposal_id;
  select * into strict v_proposal
  from public.truth_link_candidate_proposals proposal
  where proposal.workspace_key = p_workspace_key
    and proposal.proposal_id = p_proposal_id
    and proposal.proposal_hash = v_member.proposal_hash;
  select * into strict v_previous
  from public.truth_link_candidate_decisions decision_row
  where decision_row.decision_version_id = v_member.initial_decision_version_id
    and decision_row.proposal_id = p_proposal_id
    and decision_row.decision_hash = v_member.initial_decision_hash
    and decision_row.decision_no = 1
    and decision_row.previous_decision_version_id is null
    and decision_row.decision = 'review'
    and decision_row.decision_method = 'policy'
    and decision_row.policy_version = 'truth-link-policy-v1';

  if p_method = 'operator' then
    if not v_member.is_sample
      or p_decision <> all (array['accept', 'reject'])
      or nullif(trim(coalesce(p_decided_by, '')), '') is null
      or length(p_decided_by) > 200
      or nullif(trim(coalesce(p_reason, '')), '') is null
      or length(p_reason) > 2000 then
      raise exception 'operator sample decision is invalid'
        using errcode = '22023';
    end if;
    v_policy_version := v_plan.sample_review_policy_version;
  elsif p_method = 'policy' then
    if v_member.is_sample
      or p_decision <> 'accept'
      or p_decided_by <>
        'truth-shadow-link-sampled-policy-runtime-v1'
      or p_reason <>
        'deterministic conflict-free link accepted after a sealed operator-reviewed stratified sample'
      or not exists (
        select 1
        from public.truth_shadow_link_sample_authorizations auth
        where auth.workspace_key = p_workspace_key
          and auth.plan_id = p_plan_id
      ) then
      raise exception 'sampled policy decision lacks its sealed sample authority'
        using errcode = '23514';
    end if;
    v_policy_version := v_plan.policy_version;
  else
    raise exception 'sampled link decision method is invalid'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-link-decision:' || p_workspace_key || ':' || p_proposal_id,
    0
  ));
  if exists (
    select 1
    from public.truth_link_candidate_decisions decision_row
    where decision_row.proposal_id = p_proposal_id
      and decision_row.decision_no > 1
  ) then
    select * into v_existing
    from public.truth_link_candidate_decisions decision_row
    where decision_row.proposal_id = p_proposal_id
      and decision_row.decision_no = 2;
  end if;

  if p_decision = 'accept' then
    v_accepted_item_request :=
      private.truth_shadow_link_entity_accept_request_v1(
        p_workspace_key, p_proposal_id
      );
  else
    v_accepted_item_request := null;
  end if;
  v_canonical_decision := jsonb_build_object(
    'decisionSchemaVersion', 'truth-link-candidate-decision-v1',
    'workspaceKey', p_workspace_key,
    'proposalId', p_proposal_id,
    'proposalItemHash', v_proposal.proposal_hash,
    'decision', jsonb_build_object(
      'decisionNo', 2,
      'previousDecisionVersionId', v_previous.decision_version_id,
      'decision', p_decision,
      'method', p_method,
      'policyVersion', v_policy_version,
      'decidedBy', p_decided_by,
      'reasons', jsonb_build_array(p_reason),
      'acceptedItemRequest', v_accepted_item_request
    )
  );
  v_decision_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical_decision), 'UTF8'
  ), 'sha256'), 'hex');
  v_decision_version_id := 'link-decision:v1:' || v_decision_hash;

  if v_existing.decision_version_id is not null then
    v_idempotent := true;
    if v_existing.decision_version_id is distinct from v_decision_version_id
      or v_existing.canonical_decision is distinct from v_canonical_decision then
      raise exception 'sampled link decision head already differs'
        using errcode = '23505';
    end if;
  else
    insert into public.truth_link_candidate_decisions (
      decision_version_id, proposal_id, decision_no,
      previous_decision_version_id, decision, decision_method,
      policy_version, decided_by, reasons, accepted_item_request,
      decision_hash, decision_schema_version, canonical_decision
    ) values (
      v_decision_version_id, p_proposal_id, 2,
      v_previous.decision_version_id, p_decision, p_method,
      v_policy_version, p_decided_by, jsonb_build_array(p_reason),
      v_accepted_item_request, v_decision_hash,
      'truth-link-candidate-decision-v1', v_canonical_decision
    );
  end if;
  return jsonb_build_object(
    'ok', true, 'idempotent', v_idempotent,
    'proposalId', p_proposal_id,
    'decisionVersionId', v_decision_version_id,
    'itemHash', v_decision_hash,
    'decision', p_decision,
    'acceptedItemRequest', v_accepted_item_request
  );
end;
$function$;

revoke all on function private.append_truth_shadow_link_sample_decision_v1(
  text,text,text,text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function private.bind_truth_shadow_sampled_entity_link_v1(
  p_workspace_key text,
  p_plan_id text,
  p_proposal_id text,
  p_decision_version_id text,
  p_accepted_link_version_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_member public.truth_shadow_link_sample_acceptance_members%rowtype;
  v_proposal public.truth_link_candidate_proposals%rowtype;
  v_decision public.truth_link_candidate_decisions%rowtype;
  v_link public.observation_entity_links%rowtype;
  v_envelope public.observation_entity_link_envelopes%rowtype;
  v_existing public.truth_link_acceptance_bindings%rowtype;
  v_request jsonb;
  v_binding jsonb;
  v_binding_hash text;
  v_binding_id text;
  v_idempotent boolean := false;
begin
  if not private.truth_shadow_link_sample_scope_open_v1(
      p_workspace_key, p_plan_id
    ) then
    raise exception 'shadow link sampled-acceptance scope is closed'
      using errcode = '55000';
  end if;
  select * into strict v_member
  from public.truth_shadow_link_sample_acceptance_members member
  where member.workspace_key = p_workspace_key
    and member.plan_id = p_plan_id
    and member.proposal_id = p_proposal_id;
  select * into strict v_proposal
  from public.truth_link_candidate_proposals proposal
  where proposal.workspace_key = p_workspace_key
    and proposal.proposal_id = p_proposal_id
    and proposal.proposal_hash = v_member.proposal_hash;
  select * into strict v_decision
  from public.truth_link_candidate_decisions decision_row
  where decision_row.proposal_id = p_proposal_id
    and decision_row.decision_version_id = p_decision_version_id
    and decision_row.decision_no = 2
    and decision_row.previous_decision_version_id =
      v_member.initial_decision_version_id
    and decision_row.decision = 'accept'
    and (
      (v_member.is_sample
        and decision_row.decision_method = 'operator')
      or
      (not v_member.is_sample
        and decision_row.decision_method = 'policy'
        and exists (
          select 1
          from public.truth_shadow_link_sample_authorizations auth
          where auth.workspace_key = p_workspace_key
            and auth.plan_id = p_plan_id
        ))
    );
  v_request := v_decision.accepted_item_request;
  if v_request->>'acceptedKind' <> 'entity_link' then
    raise exception 'sampled link accepted request kind is invalid'
      using errcode = '23514';
  end if;
  select * into strict v_link
  from public.observation_entity_links link
  where link.link_version_id = p_accepted_link_version_id;
  select * into strict v_envelope
  from public.observation_entity_link_envelopes envelope
  where envelope.workspace_key = p_workspace_key
    and envelope.link_version_id = p_accepted_link_version_id;
  if v_link.content_hash is distinct from v_envelope.envelope_hash
    or v_link.link_key is distinct from v_request->'link'->>'linkKey'
    or v_link.version_no is distinct from
      (v_request->'link'->>'versionNo')::integer
    or coalesce(v_link.previous_link_version_id, '') is distinct from
      coalesce(v_request->'link'->>'previousLinkVersionId', '')
    or v_link.observation_id is distinct from
      v_request->'link'->>'observationId'
    or v_link.entity_type is distinct from v_request->'link'->>'entityType'
    or v_link.entity_key is distinct from v_request->'link'->>'entityKey'
    or v_link.relationship is distinct from v_request->'link'->>'relationship'
    or v_link.decision is distinct from v_request->'link'->>'decision'
    or v_link.confidence is distinct from
      (v_request->'link'->>'confidence')::numeric
    or v_link.link_method is distinct from v_request->'link'->>'linkMethod'
    or v_link.linker_version is distinct from
      v_request->'link'->>'linkerVersion'
    or v_link.evidence_span is distinct from
      v_request->'link'->'evidenceSpan'
    or v_link.recorded_at is distinct from
      (v_request->'link'->>'recordedAt')::timestamptz then
    raise exception 'sampled accepted link differs from its proposal authority'
      using errcode = '23514';
  end if;

  v_binding := jsonb_build_object(
    'bindingSchemaVersion', 'truth-link-acceptance-binding-v1',
    'workspaceKey', p_workspace_key,
    'proposalId', p_proposal_id,
    'proposalItemHash', v_proposal.proposal_hash,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'acceptedItemKind', 'entity_link',
    'acceptedItemId', p_accepted_link_version_id
  );
  v_binding_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_binding), 'UTF8'
  ), 'sha256'), 'hex');
  v_binding_id := 'link-acceptance:v1:' || v_binding_hash;
  select * into v_existing
  from public.truth_link_acceptance_bindings binding
  where binding.proposal_id = p_proposal_id;
  if found then
    v_idempotent := true;
    if v_existing.binding_id is distinct from v_binding_id
      or v_existing.canonical_binding is distinct from v_binding then
      raise exception 'sampled link acceptance binding already differs'
        using errcode = '23505';
    end if;
  else
    insert into public.truth_link_acceptance_bindings (
      binding_id, proposal_id, decision_version_id, accepted_item_kind,
      accepted_item_id, binding_hash, binding_schema_version,
      canonical_binding
    ) values (
      v_binding_id, p_proposal_id, v_decision.decision_version_id,
      'entity_link', p_accepted_link_version_id, v_binding_hash,
      'truth-link-acceptance-binding-v1', v_binding
    );
  end if;
  return jsonb_build_object(
    'ok', true, 'idempotent', v_idempotent,
    'bindingId', v_binding_id, 'itemHash', v_binding_hash,
    'proposalId', p_proposal_id,
    'decisionVersionId', v_decision.decision_version_id,
    'acceptedItemKind', 'entity_link',
    'acceptedItemId', p_accepted_link_version_id
  );
end;
$function$;

revoke all on function private.bind_truth_shadow_sampled_entity_link_v1(
  text,text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function private.record_truth_shadow_link_sample_item_v1(
  p_workspace_key text,
  p_plan_id text,
  p_proposal_id text,
  p_authority_kind text,
  p_review_resolution_id text,
  p_review_resolution_hash text,
  p_decision_version_id text,
  p_decision_hash text,
  p_accepted_link_version_id text,
  p_accepted_link_item_hash text,
  p_binding_id text,
  p_binding_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_member public.truth_shadow_link_sample_acceptance_members%rowtype;
  v_existing public.truth_shadow_link_sample_acceptance_items%rowtype;
  v_canonical jsonb;
  v_hash text;
  v_id text;
  v_idempotent boolean := false;
begin
  select * into strict v_member
  from public.truth_shadow_link_sample_acceptance_members member
  where member.workspace_key = p_workspace_key
    and member.plan_id = p_plan_id
    and member.proposal_id = p_proposal_id;
  if (p_authority_kind = 'operator_sample') is distinct from v_member.is_sample
    or p_authority_kind <> all (array['operator_sample', 'sampled_policy'])
    or (p_authority_kind = 'operator_sample' and (
      coalesce(p_review_resolution_id, '') = ''
      or coalesce(p_review_resolution_hash, '') !~ '^[0-9a-f]{64}$'
    ))
    or (p_authority_kind = 'sampled_policy' and (
      p_review_resolution_id is not null
      or coalesce(p_review_resolution_hash, '') <> ''
    )) then
    raise exception 'sampled link authority item provenance is invalid'
      using errcode = '23514';
  end if;
  if not exists (
      select 1
      from public.truth_link_candidate_decisions decision_row
      where decision_row.proposal_id = p_proposal_id
        and decision_row.decision_version_id = p_decision_version_id
        and decision_row.decision_hash = p_decision_hash
        and decision_row.decision = 'accept'
    )
    or not exists (
      select 1
      from public.observation_entity_link_envelopes envelope
      where envelope.workspace_key = p_workspace_key
        and envelope.link_version_id = p_accepted_link_version_id
        and envelope.envelope_hash = p_accepted_link_item_hash
    )
    or not exists (
      select 1
      from public.truth_link_acceptance_bindings binding
      where binding.proposal_id = p_proposal_id
        and binding.binding_id = p_binding_id
        and binding.binding_hash = p_binding_hash
        and binding.decision_version_id = p_decision_version_id
        and binding.accepted_item_kind = 'entity_link'
        and binding.accepted_item_id = p_accepted_link_version_id
    )
    or (p_authority_kind = 'operator_sample' and not exists (
      select 1
      from public.truth_review_resolutions review_resolution
      where review_resolution.workspace_key = p_workspace_key
        and review_resolution.review_resolution_id = p_review_resolution_id
        and review_resolution.receipt_hash = p_review_resolution_hash
        and review_resolution.target_kind = 'link_proposal'
        and review_resolution.target_id = p_proposal_id
        and review_resolution.decision = 'accept'
        and review_resolution.decision_version_id = p_decision_version_id
        and review_resolution.binding_id = p_binding_id
    )) then
    raise exception 'sampled link authority item lacks exact downstream receipts'
      using errcode = '23514';
  end if;
  v_canonical := jsonb_build_object(
    'schemaVersion', 'truth-shadow-link-sample-acceptance-item-v1',
    'workspaceKey', p_workspace_key,
    'planId', p_plan_id,
    'proposalId', p_proposal_id,
    'proposalHash', v_member.proposal_hash,
    'ordinal', v_member.ordinal,
    'authorityKind', p_authority_kind,
    'reviewResolutionId', coalesce(p_review_resolution_id, ''),
    'reviewResolutionHash', coalesce(p_review_resolution_hash, ''),
    'decisionVersionId', p_decision_version_id,
    'decisionHash', p_decision_hash,
    'acceptedLinkVersionId', p_accepted_link_version_id,
    'acceptedLinkItemHash', p_accepted_link_item_hash,
    'bindingId', p_binding_id,
    'bindingHash', p_binding_hash,
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false
  );
  v_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical), 'UTF8'
  ), 'sha256'), 'hex');
  v_id := 'truth-shadow-link-sample-item:v1:' || v_hash;
  select * into v_existing
  from public.truth_shadow_link_sample_acceptance_items item
  where item.workspace_key = p_workspace_key
    and item.plan_id = p_plan_id
    and item.proposal_id = p_proposal_id;
  if found then
    v_idempotent := true;
    if v_existing.item_id is distinct from v_id
      or v_existing.canonical_item is distinct from v_canonical then
      raise exception 'sampled link authority item already differs'
        using errcode = '23505';
    end if;
  else
    insert into public.truth_shadow_link_sample_acceptance_items (
      item_id, workspace_key, plan_id, proposal_id, ordinal, authority_kind,
      review_resolution_id, review_resolution_hash, decision_version_id,
      decision_hash, accepted_link_version_id, accepted_link_item_hash,
      binding_id, binding_hash, canonical_item, item_hash, schema_version
    ) values (
      v_id, p_workspace_key, p_plan_id, p_proposal_id, v_member.ordinal,
      p_authority_kind, p_review_resolution_id,
      coalesce(p_review_resolution_hash, ''), p_decision_version_id,
      p_decision_hash, p_accepted_link_version_id,
      p_accepted_link_item_hash, p_binding_id, p_binding_hash,
      v_canonical, v_hash, 'truth-shadow-link-sample-acceptance-item-v1'
    );
  end if;
  return jsonb_build_object(
    'ok', true, 'idempotent', v_idempotent,
    'itemId', v_id, 'itemHash', v_hash,
    'proposalId', p_proposal_id, 'authorityKind', p_authority_kind
  );
end;
$function$;

revoke all on function private.record_truth_shadow_link_sample_item_v1(
  text,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function public.read_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_plan_id text,
  p_after_sample_ordinal integer,
  p_limit integer,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.truth_shadow_link_sample_acceptance_plans%rowtype;
  v_items jsonb;
begin
  if not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth review token' using errcode = '28000';
  end if;
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if coalesce(p_after_sample_ordinal, 0) < 0
    or coalesce(p_limit, 0) < 1
    or p_limit > 10 then
    raise exception 'sample read page is invalid' using errcode = '22023';
  end if;
  select * into strict v_plan
  from public.truth_shadow_link_sample_acceptance_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.plan_id = p_plan_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sampleOrdinal', sample.sample_ordinal,
    'proposalId', sample.proposal_id,
    'proposalHash', sample.proposal_hash,
    'expectedPreviousDecisionVersionId',
      sample.initial_decision_version_id,
    'expectedPreviousDecisionHash', sample.initial_decision_hash,
    'stratum', sample.stratum,
    'sampleRankHash', sample.sample_rank_hash,
    'candidate', proposal.canonical_proposal->'candidate',
    'evidenceManifestHash', sample.evidence_manifest_hash,
    'evidence', evidence.items,
    'resolution', case when review_resolution.review_resolution_id is null
      then null
      else jsonb_build_object(
        'reviewResolutionId', review_resolution.review_resolution_id,
        'decision', review_resolution.decision,
        'decisionVersionId', review_resolution.decision_version_id,
        'receiptHash', review_resolution.receipt_hash
      ) end
  ) order by sample.sample_ordinal), '[]'::jsonb)
  into v_items
  from (
    select member.*
    from public.truth_shadow_link_sample_acceptance_members member
    where member.workspace_key = p_workspace_key
      and member.plan_id = p_plan_id
      and member.is_sample
      and member.sample_ordinal > coalesce(p_after_sample_ordinal, 0)
    order by member.sample_ordinal
    limit p_limit
  ) sample
  join public.truth_link_candidate_proposals proposal
    on proposal.proposal_id = sample.proposal_id
   and proposal.proposal_hash = sample.proposal_hash
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'ordinal', manifest_item.item->>'ordinal',
      'observationId', observation.observation_id,
      'observationContentHash', observation.content_hash,
      'sourceObjectId', observation.source_object_id,
      'sourceObjectType', observation.source_object_type,
      'sourceRecordedAt', observation.source_recorded_at,
      'capturedAt', observation.captured_at,
      'normalizedPayload', observation.normalized_payload
    ) order by (manifest_item.item->>'ordinal')::integer), '[]'::jsonb) as items
    from jsonb_array_elements(sample.evidence_manifest) manifest_item(item)
    join public.source_observations observation
      on observation.workspace_key = p_workspace_key
     and observation.observation_id = manifest_item.item->>'observationId'
     and observation.content_hash =
       manifest_item.item->>'observationContentHash'
  ) evidence
  left join public.truth_review_resolutions review_resolution
    on review_resolution.workspace_key = p_workspace_key
   and review_resolution.target_kind = 'link_proposal'
   and review_resolution.target_id = sample.proposal_id;

  return jsonb_build_object(
    'ok', true, 'status', 'read',
    'planId', v_plan.plan_id,
    'planHash', v_plan.plan_hash,
    'populationCount', v_plan.population_count,
    'sampleCount', v_plan.sample_count,
    'stratumCount', v_plan.stratum_count,
    'afterSampleOrdinal', coalesce(p_after_sample_ordinal, 0),
    'items', v_items,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function public.read_truth_shadow_link_sample_acceptance(
  text,text,integer,integer,text,text
) from public, anon, authenticated;
grant execute on function public.read_truth_shadow_link_sample_acceptance(
  text,text,integer,integer,text,text
) to service_role;

create or replace function private.resolve_truth_shadow_link_sample_review(
  p_workspace_key text,
  p_plan_id text,
  p_proposal_id text,
  p_expected_proposal_hash text,
  p_expected_previous_decision_version_id text,
  p_decision text,
  p_decided_by text,
  p_reason text,
  p_idempotency_key text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.truth_shadow_link_sample_acceptance_plans%rowtype;
  v_member public.truth_shadow_link_sample_acceptance_members%rowtype;
  v_idempotency_key_hash text;
  v_canonical_request jsonb;
  v_request_hash text;
  v_review_resolution_id text;
  v_existing public.truth_review_resolutions%rowtype;
  v_decision_receipt jsonb;
  v_item_receipt jsonb;
  v_binding_receipt jsonb;
  v_receipt jsonb;
  v_receipt_hash text;
begin
  if not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth review token' using errcode = '28000';
  end if;
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_decision <> all (array['accept', 'reject'])
    or coalesce(p_expected_proposal_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_expected_previous_decision_version_id, '') !~
      '^link-decision:v1:[0-9a-f]{64}$'
    or nullif(trim(coalesce(p_decided_by, '')), '') is null
    or length(p_decided_by) > 200
    or nullif(trim(coalesce(p_reason, '')), '') is null
    or length(p_reason) > 2000
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'shadow link sample review request is invalid'
      using errcode = '22023';
  end if;
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  if not private.truth_shadow_link_sample_scope_open_v1(
      p_workspace_key, p_plan_id
    ) then
    raise exception 'shadow link sampled-acceptance scope is closed'
      using errcode = '55000';
  end if;
  select * into strict v_plan
  from public.truth_shadow_link_sample_acceptance_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.plan_id = p_plan_id;
  select * into strict v_member
  from public.truth_shadow_link_sample_acceptance_members member
  where member.workspace_key = p_workspace_key
    and member.plan_id = p_plan_id
    and member.proposal_id = p_proposal_id
    and member.is_sample;
  if v_member.proposal_hash is distinct from p_expected_proposal_hash
    or v_member.initial_decision_version_id is distinct from
      p_expected_previous_decision_version_id then
    raise exception 'shadow link sample review target changed'
      using errcode = '40001';
  end if;

  v_idempotency_key_hash := encode(extensions.digest(convert_to(
    p_idempotency_key, 'UTF8'
  ), 'sha256'), 'hex');
  v_canonical_request := jsonb_build_object(
    'requestSchemaVersion', 'truth-review-resolution-v1',
    'workspaceKey', p_workspace_key,
    'idempotencyKeyHash', v_idempotency_key_hash,
    'targetKind', 'link_proposal',
    'targetId', p_proposal_id,
    'expectedTargetHash', p_expected_proposal_hash,
    'expectedPreviousDecisionVersionId',
      p_expected_previous_decision_version_id,
    'decision', p_decision,
    'policyVersion', v_plan.sample_review_policy_version,
    'decidedBy', p_decided_by,
    'reason', p_reason
  );
  v_request_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical_request), 'UTF8'
  ), 'sha256'), 'hex');
  v_review_resolution_id := 'review-resolution:v1:' || v_request_hash;
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-review-request:' || p_workspace_key || ':'
      || v_idempotency_key_hash,
    0
  ));
  select * into v_existing
  from public.truth_review_resolutions review_resolution
  where review_resolution.workspace_key = p_workspace_key
    and review_resolution.idempotency_key_hash = v_idempotency_key_hash;
  if found then
    if v_existing.canonical_request is distinct from v_canonical_request then
      raise exception 'truth review idempotency key was reused for a different request'
        using errcode = '23505';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object(
      'idempotent', true,
      'reviewItemHash', v_existing.receipt_hash,
      'planId', p_plan_id,
      'productionPublicationAttempted', false
    );
  end if;
  if exists (
    select 1
    from public.truth_review_resolutions review_resolution
    where review_resolution.workspace_key = p_workspace_key
      and review_resolution.target_kind = 'link_proposal'
      and review_resolution.target_id = p_proposal_id
  ) then
    raise exception 'shadow link sample already has a different review resolution'
      using errcode = '23505';
  end if;

  v_decision_receipt :=
    private.append_truth_shadow_link_sample_decision_v1(
      p_workspace_key, p_plan_id, p_proposal_id, p_decision,
      'operator', p_decided_by, p_reason
    );
  if p_decision = 'accept' then
    v_item_receipt := private.append_observation_entity_link(
      p_workspace_key,
      v_decision_receipt->'acceptedItemRequest'->'link',
      p_sync_token
    );
    v_binding_receipt := private.bind_truth_shadow_sampled_entity_link_v1(
      p_workspace_key, p_plan_id, p_proposal_id,
      v_decision_receipt->>'decisionVersionId',
      v_item_receipt->>'linkVersionId'
    );
  else
    v_item_receipt := '{}'::jsonb;
    v_binding_receipt := '{}'::jsonb;
  end if;
  v_receipt := jsonb_build_object(
    'ok', true,
    'reviewResolutionId', v_review_resolution_id,
    'targetKind', 'link_proposal',
    'targetId', p_proposal_id,
    'targetItemHash', p_expected_proposal_hash,
    'decision', p_decision,
    'decisionVersionId', v_decision_receipt->>'decisionVersionId',
    'decisionItemHash', v_decision_receipt->>'itemHash',
    'acceptedKind', case when p_decision = 'accept'
      then 'entity_link' else '' end,
    'acceptedItemId', coalesce(v_item_receipt->>'linkVersionId', ''),
    'acceptedItemHash', coalesce(v_item_receipt->>'itemHash', ''),
    'bindingId', coalesce(v_binding_receipt->>'bindingId', ''),
    'bindingItemHash', coalesce(v_binding_receipt->>'itemHash', ''),
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
  v_receipt_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt), 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.truth_review_resolutions (
    review_resolution_id, workspace_key, idempotency_key_hash,
    target_kind, target_id, target_item_hash, decision,
    decision_version_id, decision_item_hash, accepted_kind,
    accepted_item_id, accepted_item_hash, binding_id, binding_item_hash,
    request_hash, request_schema_version, canonical_request,
    receipt_hash, canonical_receipt
  ) values (
    v_review_resolution_id, p_workspace_key, v_idempotency_key_hash,
    'link_proposal', p_proposal_id, p_expected_proposal_hash, p_decision,
    v_decision_receipt->>'decisionVersionId',
    v_decision_receipt->>'itemHash',
    case when p_decision = 'accept' then 'entity_link' else '' end,
    coalesce(v_item_receipt->>'linkVersionId', ''),
    coalesce(v_item_receipt->>'itemHash', ''),
    coalesce(v_binding_receipt->>'bindingId', ''),
    coalesce(v_binding_receipt->>'itemHash', ''),
    v_request_hash, 'truth-review-resolution-v1', v_canonical_request,
    v_receipt_hash, v_receipt
  );
  if p_decision = 'accept' then
    perform private.record_truth_shadow_link_sample_item_v1(
      p_workspace_key, p_plan_id, p_proposal_id, 'operator_sample',
      v_review_resolution_id, v_receipt_hash,
      v_decision_receipt->>'decisionVersionId',
      v_decision_receipt->>'itemHash',
      v_item_receipt->>'linkVersionId', v_item_receipt->>'itemHash',
      v_binding_receipt->>'bindingId', v_binding_receipt->>'itemHash'
    );
  end if;
  return v_receipt || jsonb_build_object(
    'idempotent', false,
    'reviewItemHash', v_receipt_hash,
    'planId', p_plan_id,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.resolve_truth_shadow_link_sample_review(
  text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function public.resolve_truth_shadow_link_sample_review(
  p_workspace_key text,
  p_plan_id text,
  p_proposal_id text,
  p_expected_proposal_hash text,
  p_expected_previous_decision_version_id text,
  p_decision text,
  p_decided_by text,
  p_reason text,
  p_idempotency_key text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.resolve_truth_shadow_link_sample_review(
    p_workspace_key, p_plan_id, p_proposal_id,
    p_expected_proposal_hash, p_expected_previous_decision_version_id,
    p_decision, p_decided_by, p_reason, p_idempotency_key,
    p_review_token, p_sync_token
  );
$function$;

revoke all on function public.resolve_truth_shadow_link_sample_review(
  text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.resolve_truth_shadow_link_sample_review(
  text,text,text,text,text,text,text,text,text,text,text
) to service_role;

create or replace function private.authorize_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_plan_id text,
  p_authorized_by text,
  p_attestation_reason text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.truth_shadow_link_sample_acceptance_plans%rowtype;
  v_existing public.truth_shadow_link_sample_authorizations%rowtype;
  v_resolved_count integer;
  v_rejected_count integer;
  v_sample_manifest jsonb;
  v_sample_manifest_hash text;
  v_canonical jsonb;
  v_hash text;
  v_id text;
begin
  if not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth review token' using errcode = '28000';
  end if;
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_authorized_by, '')), '') is null
    or length(p_authorized_by) > 200
    or nullif(trim(coalesce(p_attestation_reason, '')), '') is null
    or length(p_attestation_reason) < 20
    or length(p_attestation_reason) > 2000 then
    raise exception 'sample authorization attestation is invalid'
      using errcode = '22023';
  end if;
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  if not private.truth_shadow_link_sample_scope_open_v1(
      p_workspace_key, p_plan_id
    ) then
    raise exception 'shadow link sampled-acceptance scope is closed'
      using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-shadow-link-sample-authorization:' || p_workspace_key || ':'
      || p_plan_id,
    0
  ));
  select * into strict v_plan
  from public.truth_shadow_link_sample_acceptance_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.plan_id = p_plan_id;
  select * into v_existing
  from public.truth_shadow_link_sample_authorizations auth
  where auth.workspace_key = p_workspace_key
    and auth.plan_id = p_plan_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'status', 'authorized', 'idempotent', true,
      'planId', p_plan_id,
      'authorizationId', v_existing.authorization_id,
      'authorizationHash', v_existing.authorization_hash,
      'sampleCount', v_plan.sample_count,
      'productionPublicationAttempted', false
    );
  end if;

  select count(*) filter (where review_resolution.decision is not null)::integer,
         count(*) filter (where review_resolution.decision = 'reject')::integer
  into v_resolved_count, v_rejected_count
  from public.truth_shadow_link_sample_acceptance_members member
  left join public.truth_review_resolutions review_resolution
    on review_resolution.workspace_key = member.workspace_key
   and review_resolution.target_kind = 'link_proposal'
   and review_resolution.target_id = member.proposal_id
   and review_resolution.target_item_hash = member.proposal_hash
   and review_resolution.canonical_request->>'policyVersion' =
     v_plan.sample_review_policy_version
   and review_resolution.canonical_request->>
     'expectedPreviousDecisionVersionId' =
       member.initial_decision_version_id
  where member.workspace_key = p_workspace_key
    and member.plan_id = p_plan_id
    and member.is_sample;
  if v_rejected_count > 0 then
    return jsonb_build_object(
      'ok', false, 'status', 'not_ready',
      'reason', 'SAMPLE_REJECTED',
      'planId', p_plan_id,
      'sampleCount', v_plan.sample_count,
      'resolvedCount', v_resolved_count,
      'rejectedCount', v_rejected_count,
      'productionPublicationAttempted', false
    );
  end if;
  if v_resolved_count <> v_plan.sample_count
    or (select count(*)
      from public.truth_shadow_link_sample_acceptance_items item
      where item.workspace_key = p_workspace_key
        and item.plan_id = p_plan_id
        and item.authority_kind = 'operator_sample') <> v_plan.sample_count then
    return jsonb_build_object(
      'ok', false, 'status', 'not_ready',
      'reason', 'SAMPLE_REVIEW_INCOMPLETE',
      'planId', p_plan_id,
      'sampleCount', v_plan.sample_count,
      'resolvedCount', v_resolved_count,
      'productionPublicationAttempted', false
    );
  end if;

  select jsonb_agg(jsonb_build_object(
    'sampleOrdinal', member.sample_ordinal,
    'proposalId', member.proposal_id,
    'proposalHash', member.proposal_hash,
    'stratumHash', member.stratum_hash,
    'evidenceManifestHash', member.evidence_manifest_hash,
    'reviewResolutionId', review_resolution.review_resolution_id,
    'reviewResolutionHash', review_resolution.receipt_hash,
    'decisionVersionId', item.decision_version_id,
    'decisionHash', item.decision_hash,
    'acceptedLinkVersionId', item.accepted_link_version_id,
    'acceptedLinkItemHash', item.accepted_link_item_hash,
    'bindingId', item.binding_id,
    'bindingHash', item.binding_hash,
    'authorityItemId', item.item_id,
    'authorityItemHash', item.item_hash
  ) order by member.sample_ordinal)
  into v_sample_manifest
  from public.truth_shadow_link_sample_acceptance_members member
  join public.truth_shadow_link_sample_acceptance_items item
    on item.workspace_key = member.workspace_key
   and item.plan_id = member.plan_id
   and item.proposal_id = member.proposal_id
   and item.authority_kind = 'operator_sample'
  join public.truth_review_resolutions review_resolution
    on review_resolution.workspace_key = member.workspace_key
   and review_resolution.review_resolution_id = item.review_resolution_id
   and review_resolution.target_kind = 'link_proposal'
   and review_resolution.target_id = member.proposal_id
   and review_resolution.target_item_hash = member.proposal_hash
   and review_resolution.decision = 'accept'
   and review_resolution.decision_version_id = item.decision_version_id
   and review_resolution.receipt_hash = item.review_resolution_hash
  where member.workspace_key = p_workspace_key
    and member.plan_id = p_plan_id
    and member.is_sample;
  if jsonb_array_length(coalesce(v_sample_manifest, '[]'::jsonb)) <>
      v_plan.sample_count then
    raise exception 'operator sample receipt manifest is incomplete'
      using errcode = '23514';
  end if;
  v_sample_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_sample_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_canonical := jsonb_build_object(
    'schemaVersion', 'truth-shadow-link-sample-authorization-v1',
    'workspaceKey', p_workspace_key,
    'planId', p_plan_id,
    'planHash', v_plan.plan_hash,
    'policyVersion', v_plan.policy_version,
    'sampleReviewPolicyVersion', v_plan.sample_review_policy_version,
    'populationCount', v_plan.population_count,
    'sampleCount', v_plan.sample_count,
    'stratumCount', v_plan.stratum_count,
    'sampleManifestHash', v_sample_manifest_hash,
    'authorizedBy', p_authorized_by,
    'attestationReason', p_attestation_reason,
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionEligible', false,
    'productionPublicationAttempted', false
  );
  v_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical), 'UTF8'
  ), 'sha256'), 'hex');
  v_id := 'truth-shadow-link-sample-authorization:v1:' || v_hash;
  insert into public.truth_shadow_link_sample_authorizations (
    authorization_id, workspace_key, plan_id, sample_manifest,
    sample_manifest_hash, authorized_by, attestation_reason,
    canonical_authorization, authorization_hash, schema_version
  ) values (
    v_id, p_workspace_key, p_plan_id, v_sample_manifest,
    v_sample_manifest_hash, p_authorized_by, p_attestation_reason,
    v_canonical, v_hash, 'truth-shadow-link-sample-authorization-v1'
  );
  return jsonb_build_object(
    'ok', true, 'status', 'authorized', 'idempotent', false,
    'planId', p_plan_id,
    'authorizationId', v_id,
    'authorizationHash', v_hash,
    'sampleCount', v_plan.sample_count,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.authorize_truth_shadow_link_sample_acceptance(
  text,text,text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function public.authorize_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_plan_id text,
  p_authorized_by text,
  p_attestation_reason text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.authorize_truth_shadow_link_sample_acceptance(
    p_workspace_key, p_plan_id, p_authorized_by, p_attestation_reason,
    p_review_token, p_sync_token
  );
$function$;

revoke all on function public.authorize_truth_shadow_link_sample_acceptance(
  text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.authorize_truth_shadow_link_sample_acceptance(
  text,text,text,text,text,text
) to service_role;

create or replace function private.run_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_plan_id text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.truth_shadow_link_sample_acceptance_plans%rowtype;
  v_existing_seal public.truth_shadow_link_sample_acceptance_seals%rowtype;
  v_member record;
  v_decision_receipt jsonb;
  v_link_receipt jsonb;
  v_binding_receipt jsonb;
  v_processed integer := 0;
  v_completed_count integer;
  v_operator_count integer;
  v_policy_count integer;
  v_item_manifest jsonb;
  v_item_manifest_hash text;
  v_canonical_seal jsonb;
  v_seal_hash text;
  v_seal_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 50 then
    raise exception 'sampled link acceptance batch limit is invalid'
      using errcode = '22023';
  end if;
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  if not private.truth_shadow_link_sample_scope_open_v1(
      p_workspace_key, p_plan_id
    ) then
    raise exception 'shadow link sampled-acceptance scope is closed'
      using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-shadow-link-sample-run:' || p_workspace_key || ':' || p_plan_id,
    0
  ));
  select * into strict v_plan
  from public.truth_shadow_link_sample_acceptance_plans plan
  where plan.workspace_key = p_workspace_key
    and plan.plan_id = p_plan_id;
  select * into v_existing_seal
  from public.truth_shadow_link_sample_acceptance_seals seal
  where seal.workspace_key = p_workspace_key
    and seal.plan_id = p_plan_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'status', 'succeeded', 'idempotent', true,
      'planId', p_plan_id,
      'sealId', v_existing_seal.seal_id,
      'sealHash', v_existing_seal.seal_hash,
      'populationCount', v_existing_seal.population_count,
      'operatorSampleAcceptanceCount',
        v_existing_seal.operator_sample_acceptance_count,
      'sampledPolicyAcceptanceCount',
        v_existing_seal.sampled_policy_acceptance_count,
      'productionPublicationAttempted', false
    );
  end if;
  if not exists (
    select 1
    from public.truth_shadow_link_sample_authorizations auth
    where auth.workspace_key = p_workspace_key
      and auth.plan_id = p_plan_id
  ) then
    return jsonb_build_object(
      'ok', false, 'status', 'not_ready',
      'reason', 'SAMPLE_AUTHORIZATION_REQUIRED',
      'planId', p_plan_id,
      'productionPublicationAttempted', false
    );
  end if;
  if (select count(*)
    from public.truth_shadow_link_sample_acceptance_items item
    where item.workspace_key = p_workspace_key
      and item.plan_id = p_plan_id
      and item.authority_kind = 'operator_sample') <> v_plan.sample_count then
    raise exception 'authorized operator sample item set is incomplete'
      using errcode = '23514';
  end if;

  for v_member in
    select member.*
    from public.truth_shadow_link_sample_acceptance_members member
    where member.workspace_key = p_workspace_key
      and member.plan_id = p_plan_id
      and not member.is_sample
      and not exists (
        select 1
        from public.truth_shadow_link_sample_acceptance_items item
        where item.workspace_key = member.workspace_key
          and item.plan_id = member.plan_id
          and item.proposal_id = member.proposal_id
      )
    order by member.ordinal
    limit p_limit
  loop
    v_decision_receipt :=
      private.append_truth_shadow_link_sample_decision_v1(
        p_workspace_key, p_plan_id, v_member.proposal_id, 'accept',
        'policy', 'truth-shadow-link-sampled-policy-runtime-v1',
        'deterministic conflict-free link accepted after a sealed operator-reviewed stratified sample'
      );
    v_link_receipt := private.append_observation_entity_link(
      p_workspace_key,
      v_decision_receipt->'acceptedItemRequest'->'link',
      p_sync_token
    );
    v_binding_receipt := private.bind_truth_shadow_sampled_entity_link_v1(
      p_workspace_key, p_plan_id, v_member.proposal_id,
      v_decision_receipt->>'decisionVersionId',
      v_link_receipt->>'linkVersionId'
    );
    perform private.record_truth_shadow_link_sample_item_v1(
      p_workspace_key, p_plan_id, v_member.proposal_id, 'sampled_policy',
      null, '', v_decision_receipt->>'decisionVersionId',
      v_decision_receipt->>'itemHash',
      v_link_receipt->>'linkVersionId', v_link_receipt->>'itemHash',
      v_binding_receipt->>'bindingId', v_binding_receipt->>'itemHash'
    );
    v_processed := v_processed + 1;
  end loop;

  select count(*)::integer,
         count(*) filter (where item.authority_kind = 'operator_sample')::integer,
         count(*) filter (where item.authority_kind = 'sampled_policy')::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'ordinal', item.ordinal,
           'proposalId', item.proposal_id,
           'authorityKind', item.authority_kind,
           'itemId', item.item_id,
           'itemHash', item.item_hash,
           'decisionVersionId', item.decision_version_id,
           'decisionHash', item.decision_hash,
           'acceptedLinkVersionId', item.accepted_link_version_id,
           'acceptedLinkItemHash', item.accepted_link_item_hash,
           'bindingId', item.binding_id,
           'bindingHash', item.binding_hash
         ) order by item.ordinal), '[]'::jsonb)
  into v_completed_count, v_operator_count, v_policy_count, v_item_manifest
  from public.truth_shadow_link_sample_acceptance_items item
  where item.workspace_key = p_workspace_key
    and item.plan_id = p_plan_id;
  if v_completed_count > v_plan.population_count
    or v_operator_count <> v_plan.sample_count
    or v_policy_count <> v_completed_count - v_operator_count then
    raise exception 'sampled link acceptance item accounting is inconsistent'
      using errcode = '23514';
  end if;
  if v_completed_count < v_plan.population_count then
    return jsonb_build_object(
      'ok', true, 'status', 'progress',
      'planId', p_plan_id, 'processedCount', v_processed,
      'completedCount', v_completed_count,
      'populationCount', v_plan.population_count,
      'remainingCount', v_plan.population_count - v_completed_count,
      'operatorSampleAcceptanceCount', v_operator_count,
      'sampledPolicyAcceptanceCount', v_policy_count,
      'productionPublicationAttempted', false
    );
  end if;

  v_item_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_item_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_canonical_seal := jsonb_build_object(
    'schemaVersion', 'truth-shadow-link-sample-acceptance-seal-v1',
    'workspaceKey', p_workspace_key,
    'planId', p_plan_id,
    'planHash', v_plan.plan_hash,
    'authorizationHash', (
      select auth.authorization_hash
      from public.truth_shadow_link_sample_authorizations auth
      where auth.workspace_key = p_workspace_key
        and auth.plan_id = p_plan_id
    ),
    'populationCount', v_plan.population_count,
    'sampleCount', v_plan.sample_count,
    'operatorSampleAcceptanceCount', v_operator_count,
    'sampledPolicyAcceptanceCount', v_policy_count,
    'itemManifestHash', v_item_manifest_hash,
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false
  );
  v_seal_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical_seal), 'UTF8'
  ), 'sha256'), 'hex');
  v_seal_id := 'truth-shadow-link-sample-seal:v1:' || v_seal_hash;
  insert into public.truth_shadow_link_sample_acceptance_seals (
    seal_id, workspace_key, plan_id, population_count, sample_count,
    operator_sample_acceptance_count, sampled_policy_acceptance_count,
    item_manifest, item_manifest_hash, canonical_seal, seal_hash,
    schema_version
  ) values (
    v_seal_id, p_workspace_key, p_plan_id, v_plan.population_count,
    v_plan.sample_count, v_operator_count, v_policy_count,
    v_item_manifest, v_item_manifest_hash, v_canonical_seal, v_seal_hash,
    'truth-shadow-link-sample-acceptance-seal-v1'
  );
  return jsonb_build_object(
    'ok', true, 'status', 'succeeded', 'idempotent', false,
    'planId', p_plan_id, 'processedCount', v_processed,
    'sealId', v_seal_id, 'sealHash', v_seal_hash,
    'populationCount', v_plan.population_count,
    'operatorSampleAcceptanceCount', v_operator_count,
    'sampledPolicyAcceptanceCount', v_policy_count,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.run_truth_shadow_link_sample_acceptance(
  text,text,integer,text
) from public, anon, authenticated, service_role;

create or replace function public.run_truth_shadow_link_sample_acceptance(
  p_workspace_key text,
  p_plan_id text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.run_truth_shadow_link_sample_acceptance(
    p_workspace_key, p_plan_id, p_limit, p_sync_token
  );
$function$;

revoke all on function public.run_truth_shadow_link_sample_acceptance(
  text,text,integer,text
) from public, anon, authenticated;
grant execute on function public.run_truth_shadow_link_sample_acceptance(
  text,text,integer,text
) to service_role;

do $verify$
declare
  v_table text;
  v_signature text;
  v_definition text;
  v_constraint_bundle text;
begin
  foreach v_table in array array[
    'truth_shadow_link_sample_acceptance_plans',
    'truth_shadow_link_sample_acceptance_members',
    'truth_shadow_link_sample_authorizations',
    'truth_shadow_link_sample_acceptance_items',
    'truth_shadow_link_sample_acceptance_seals'
  ] loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'sampled link acceptance table % is unavailable', v_table
        using errcode = '23514';
    end if;
    if not (
      select table_row.relrowsecurity and table_row.relforcerowsecurity
      from pg_catalog.pg_class table_row
      join pg_catalog.pg_namespace namespace_row
        on namespace_row.oid = table_row.relnamespace
      where namespace_row.nspname = 'public'
        and table_row.relname = v_table
    ) then
      raise exception 'sampled link acceptance table % is not force-RLS', v_table
        using errcode = '42501';
    end if;
    if has_table_privilege('anon', 'public.' || v_table, 'INSERT')
      or has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
      or has_table_privilege('service_role', 'public.' || v_table, 'INSERT')
      or has_table_privilege('service_role', 'public.' || v_table, 'UPDATE')
      or has_table_privilege('service_role', 'public.' || v_table, 'DELETE') then
      raise exception 'sampled link acceptance table % leaked mutation privilege',
        v_table using errcode = '42501';
    end if;
    select string_agg(lower(pg_get_constraintdef(constraint_row.oid)), E'\n')
      into v_constraint_bundle
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = ('public.' || v_table)::regclass
      and constraint_row.contype = 'c';
    if position('shadow_only = true' in coalesce(v_constraint_bundle, '')) = 0
      or position('production_eligible = false' in coalesce(v_constraint_bundle, '')) = 0
      or position(
        'production_publication_attempted = false' in
        coalesce(v_constraint_bundle, '')
      ) = 0 then
      raise exception 'sampled link acceptance table % lost a shadow CHECK fence',
        v_table using errcode = '23514';
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid = ('public.' || v_table)::regclass
        and trigger_row.tgname = v_table || '_immutable'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
        and trigger_row.tgfoid =
          'public.reject_immutable_truth_mutation()'::regprocedure
        and (trigger_row.tgtype::integer & 1) = 1
        and (trigger_row.tgtype::integer & 2) = 2
        and (trigger_row.tgtype::integer & 8) = 8
        and (trigger_row.tgtype::integer & 16) = 16
    ) then
      raise exception 'sampled link acceptance table % lost immutability',
        v_table using errcode = '23514';
    end if;
  end loop;

  foreach v_signature in array array[
    'private.truth_shadow_link_sample_population_v1(text,text)',
    'private.truth_shadow_link_sample_scope_open_v1(text,text)',
    'private.open_truth_shadow_link_sample_acceptance(text,text,uuid,text,text)',
    'private.truth_shadow_link_entity_accept_request_v1(text,text)',
    'private.append_truth_shadow_link_sample_decision_v1(text,text,text,text,text,text,text)',
    'private.bind_truth_shadow_sampled_entity_link_v1(text,text,text,text,text)',
    'private.record_truth_shadow_link_sample_item_v1(text,text,text,text,text,text,text,text,text,text,text,text)',
    'private.resolve_truth_shadow_link_sample_review(text,text,text,text,text,text,text,text,text,text,text)',
    'private.authorize_truth_shadow_link_sample_acceptance(text,text,text,text,text,text)',
    'private.run_truth_shadow_link_sample_acceptance(text,text,integer,text)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'private sampled link authority % is unavailable', v_signature
        using errcode = '23514';
    end if;
    if has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'private sampled link authority % leaked execute privilege',
        v_signature using errcode = '42501';
    end if;
    select lower(pg_get_functiondef(to_regprocedure(v_signature)))
      into v_definition;
    if position('set search_path to ''''' in v_definition) = 0
      or position(('shipment-' || 'truth-packets') in v_definition) > 0 then
      raise exception 'private sampled link authority % lost its shadow fence',
        v_signature using errcode = '23514';
    end if;
  end loop;

  foreach v_signature in array array[
    'public.open_truth_shadow_link_sample_acceptance(text,text,uuid,text,text)',
    'public.read_truth_shadow_link_sample_acceptance(text,text,integer,integer,text,text)',
    'public.resolve_truth_shadow_link_sample_review(text,text,text,text,text,text,text,text,text,text,text)',
    'public.authorize_truth_shadow_link_sample_acceptance(text,text,text,text,text,text)',
    'public.run_truth_shadow_link_sample_acceptance(text,text,integer,text)'
  ] loop
    if to_regprocedure(v_signature) is null
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'public sampled link RPC % has invalid ACLs', v_signature
        using errcode = '42501';
    end if;
    select lower(pg_get_functiondef(to_regprocedure(v_signature)))
      into v_definition;
    if position('security definer' in v_definition) = 0
      or position('set search_path to ''''' in v_definition) = 0
      or position(('shipment-' || 'truth-packets') in v_definition) > 0 then
      raise exception 'public sampled link RPC % lost its security fence',
        v_signature using errcode = '23514';
    end if;
  end loop;

  select lower(pg_get_functiondef(
    'private.open_truth_shadow_link_sample_acceptance(text,text,uuid,text,text)'::regprocedure
  )) into v_definition;
  if position('minimumglobalsamplecount'', 64' in v_definition) = 0
    or position('mandatoryfirstrankperstratum'', true' in v_definition) = 0
    or position('link_workgroup_review_pending' in v_definition) = 0
    or position('source_cut.completeness = ''degraded''' in v_definition) = 0 then
    raise exception 'sample plan lost its stratified degraded-gap authority'
      using errcode = '23514';
  end if;

  select lower(pg_get_functiondef(
    'private.append_truth_shadow_link_sample_decision_v1(text,text,text,text,text,text,text)'::regprocedure
  )) into v_definition;
  if position('v_policy_version := v_plan.policy_version' in v_definition) = 0
    or position(
      'truth-shadow-link-sampled-policy-runtime-v1' in v_definition
    ) = 0 then
    raise exception 'sampled decision authority lost its policy identity'
      using errcode = '23514';
  end if;
  select lower(pg_get_functiondef(
    'private.run_truth_shadow_link_sample_acceptance(text,text,integer,text)'::regprocedure
  )) into v_definition;
  if position('p_limit > 50' in v_definition) = 0
    or position('productionpublicationattempted'', false' in v_definition) = 0 then
    raise exception 'sampled policy runtime lost its bounded shadow authority'
      using errcode = '23514';
  end if;
end;
$verify$;
