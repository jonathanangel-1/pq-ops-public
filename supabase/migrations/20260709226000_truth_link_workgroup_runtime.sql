create extension if not exists pgcrypto with schema extensions;

-- Durable, reviewable staging for cross-thread entity links and operational
-- workgroups. A fenced resolver stores the complete bounded context and every
-- proposal atomically before policy decisions can be appended. Only accepted
-- items copied through the existing evidence-envelope RPCs may enter builds.

create table if not exists public.truth_link_resolution_runs (
  resolution_run_id text primary key
    check (resolution_run_id ~ '^link-resolution:v1:[0-9a-f]{64}$'),
  workspace_key text not null,
  job_id uuid not null unique references public.source_processing_jobs(job_id) on delete restrict,
  anchor_observation_id text not null references public.source_observations(observation_id) on delete restrict,
  root_batch_id uuid not null references public.source_ingest_batches(batch_id) on delete restrict,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  linker_version text not null,
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  linker_output_hash text not null check (linker_output_hash ~ '^[0-9a-f]{64}$'),
  context_observation_count integer not null check (context_observation_count > 0),
  proposal_count integer not null check (proposal_count >= 0),
  resolution_hash text not null unique check (resolution_hash ~ '^[0-9a-f]{64}$'),
  resolution_schema_version text not null,
  canonical_resolution jsonb not null check (jsonb_typeof(canonical_resolution) = 'object'),
  created_at timestamptz not null default now(),
  check (resolution_run_id = 'link-resolution:v1:' || resolution_hash)
);

create table if not exists public.truth_link_resolution_context (
  resolution_run_id text not null
    references public.truth_link_resolution_runs(resolution_run_id) on delete restrict,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  observation_content_hash text not null check (observation_content_hash ~ '^[0-9a-f]{64}$'),
  ordinal bigint not null check (ordinal >= 0),
  primary key (resolution_run_id, observation_id),
  unique (resolution_run_id, ordinal)
);

create table if not exists public.truth_link_candidate_proposals (
  proposal_id text primary key check (proposal_id ~ '^link-proposal:v1:[0-9a-f]{64}$'),
  resolution_run_id text not null
    references public.truth_link_resolution_runs(resolution_run_id) on delete restrict,
  workspace_key text not null,
  candidate_kind text not null
    check (candidate_kind = any (array['entity_link', 'workgroup', 'workgroup_membership'])),
  candidate_key text not null,
  parent_candidate_key text not null default '',
  proposal_method text not null check (proposal_method = any (array['deterministic', 'model', 'operator'])),
  auto_accept_eligible boolean not null,
  requires_review boolean not null,
  policy_disposition text not null check (policy_disposition = any (array['accept', 'review', 'reject'])),
  policy_class text not null,
  has_conflict boolean not null,
  membership_change boolean not null,
  proposal_hash text not null unique check (proposal_hash ~ '^[0-9a-f]{64}$'),
  proposal_schema_version text not null,
  canonical_proposal jsonb not null check (jsonb_typeof(canonical_proposal) = 'object'),
  created_at timestamptz not null default now(),
  unique (resolution_run_id, candidate_key),
  check (proposal_id = 'link-proposal:v1:' || proposal_hash)
);

create table if not exists public.truth_link_candidate_evidence (
  proposal_id text not null references public.truth_link_candidate_proposals(proposal_id) on delete restrict,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  ordinal bigint not null check (ordinal >= 0),
  primary key (proposal_id, observation_id),
  unique (proposal_id, ordinal)
);

create table if not exists public.truth_link_candidate_decisions (
  decision_version_id text primary key
    check (decision_version_id ~ '^link-decision:v1:[0-9a-f]{64}$'),
  proposal_id text not null references public.truth_link_candidate_proposals(proposal_id) on delete restrict,
  decision_no integer not null check (decision_no > 0),
  previous_decision_version_id text
    references public.truth_link_candidate_decisions(decision_version_id) on delete restrict,
  decision text not null check (decision = any (array['accept', 'review', 'reject'])),
  decision_method text not null check (decision_method = any (array['policy', 'operator'])),
  policy_version text not null,
  decided_by text not null,
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array'),
  accepted_item_request jsonb
    check (accepted_item_request is null or jsonb_typeof(accepted_item_request) = 'object'),
  decision_hash text not null unique check (decision_hash ~ '^[0-9a-f]{64}$'),
  decision_schema_version text not null,
  canonical_decision jsonb not null check (jsonb_typeof(canonical_decision) = 'object'),
  created_at timestamptz not null default now(),
  unique (proposal_id, decision_no),
  check (decision_version_id = 'link-decision:v1:' || decision_hash),
  check ((decision = 'accept') = (accepted_item_request is not null))
);

create unique index if not exists truth_link_candidate_decisions_previous_unique
  on public.truth_link_candidate_decisions(previous_decision_version_id)
  where previous_decision_version_id is not null;

create table if not exists public.truth_link_acceptance_bindings (
  binding_id text primary key check (binding_id ~ '^link-acceptance:v1:[0-9a-f]{64}$'),
  proposal_id text not null unique
    references public.truth_link_candidate_proposals(proposal_id) on delete restrict,
  decision_version_id text not null unique
    references public.truth_link_candidate_decisions(decision_version_id) on delete restrict,
  accepted_item_kind text not null
    check (accepted_item_kind = any (array['entity_link', 'workgroup', 'workgroup_membership'])),
  accepted_item_id text not null,
  binding_hash text not null unique check (binding_hash ~ '^[0-9a-f]{64}$'),
  binding_schema_version text not null,
  canonical_binding jsonb not null check (jsonb_typeof(canonical_binding) = 'object'),
  created_at timestamptz not null default now(),
  check (binding_id = 'link-acceptance:v1:' || binding_hash)
);

create index if not exists truth_link_resolution_runs_workspace_idx
  on public.truth_link_resolution_runs(workspace_key, created_at desc);
create index if not exists truth_link_resolution_context_observation_idx
  on public.truth_link_resolution_context(observation_id, resolution_run_id);
create index if not exists truth_link_candidate_proposals_review_idx
  on public.truth_link_candidate_proposals(workspace_key, policy_disposition, created_at desc);
create index if not exists truth_link_candidate_evidence_observation_idx
  on public.truth_link_candidate_evidence(observation_id, proposal_id);
create index if not exists truth_link_candidate_decisions_proposal_idx
  on public.truth_link_candidate_decisions(proposal_id, decision_no);

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_link_resolution_runs',
    'truth_link_resolution_context',
    'truth_link_candidate_proposals',
    'truth_link_candidate_evidence',
    'truth_link_candidate_decisions',
    'truth_link_acceptance_bindings'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',
      v_table,
      v_table
    );
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('grant select on public.%I to service_role', v_table);
    execute format('revoke insert, update, delete, truncate on public.%I from service_role', v_table);
  end loop;
end;
$block$;

create or replace function private.valid_truth_link_operator_token(p_operator_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens
    where token_name = 'truth_link_operator_decider'
      and token_hash = encode(
        extensions.digest(convert_to(p_operator_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

create or replace function private.bind_truth_link_candidate_acceptance(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_proposal_id text,
  p_decision_version_id text,
  p_accepted_item_id text,
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_proposal public.truth_link_candidate_proposals%rowtype;
  v_run public.truth_link_resolution_runs%rowtype;
  v_decision public.truth_link_candidate_decisions%rowtype;
  v_request jsonb;
  v_kind text;
  v_link public.observation_entity_links%rowtype;
  v_link_envelope public.observation_entity_link_envelopes%rowtype;
  v_workgroup public.operational_workgroups_v2%rowtype;
  v_workgroup_envelope public.operational_workgroup_envelopes%rowtype;
  v_membership public.operational_workgroup_memberships%rowtype;
  v_membership_envelope public.operational_workgroup_membership_envelopes%rowtype;
  v_evidence jsonb;
  v_binding jsonb;
  v_binding_hash text;
  v_binding_id text;
  v_existing public.truth_link_acceptance_bindings%rowtype;
  v_idempotent boolean := false;
begin
  select * into v_proposal
  from public.truth_link_candidate_proposals
  where proposal_id = p_proposal_id
    and workspace_key = p_workspace_key;
  select * into v_decision
  from public.truth_link_candidate_decisions
  where decision_version_id = p_decision_version_id
    and proposal_id = p_proposal_id
    and decision = 'accept';
  if v_proposal.proposal_id is null
    or v_decision.decision_version_id is null
    or v_decision.accepted_item_request is null then
    raise exception 'truth-link acceptance authorization is unavailable'
      using errcode = '23503';
  end if;
  select * into v_run
  from public.truth_link_resolution_runs
  where resolution_run_id = v_proposal.resolution_run_id;
  if v_decision.decision_method = 'policy' then
    if not private.valid_truth_sync_token(p_token) then
      raise exception 'invalid sync token' using errcode = '28000';
    end if;
    v_job := private.assert_truth_link_job_lease(
      p_job_id, p_worker_id, p_lease_fence, p_processor_version
    );
    if v_job.workspace_key is distinct from p_workspace_key
      or v_run.job_id is distinct from p_job_id then
      raise exception 'truth-link policy binding is outside the fenced resolution job'
        using errcode = '23514';
    end if;
  elsif not private.valid_truth_link_operator_token(p_token) then
    raise exception 'invalid truth-link operator token' using errcode = '28000';
  end if;

  v_request := v_decision.accepted_item_request;
  v_kind := v_request->>'acceptedKind';
  if v_kind is distinct from v_proposal.candidate_kind then
    raise exception 'truth-link accepted item kind differs from its candidate'
      using errcode = '23514';
  end if;

  if v_kind = 'entity_link' then
    select * into v_link
    from public.observation_entity_links
    where link_version_id = p_accepted_item_id;
    select * into v_link_envelope
    from public.observation_entity_link_envelopes
    where link_version_id = p_accepted_item_id
      and workspace_key = p_workspace_key;
    if v_link.link_version_id is null
      or v_link_envelope.link_version_id is null
      or v_link.content_hash is distinct from v_link_envelope.envelope_hash
      or v_link.link_key is distinct from v_request->'link'->>'linkKey'
      or v_link.version_no is distinct from (v_request->'link'->>'versionNo')::integer
      or coalesce(v_link.previous_link_version_id, '') is distinct from
        coalesce(v_request->'link'->>'previousLinkVersionId', '')
      or v_link.observation_id is distinct from v_request->'link'->>'observationId'
      or v_link.entity_type is distinct from v_request->'link'->>'entityType'
      or v_link.entity_key is distinct from v_request->'link'->>'entityKey'
      or v_link.relationship is distinct from v_request->'link'->>'relationship'
      or v_link.decision is distinct from v_request->'link'->>'decision'
      or v_link.confidence is distinct from (v_request->'link'->>'confidence')::numeric
      or v_link.link_method is distinct from v_request->'link'->>'linkMethod'
      or v_link.linker_version is distinct from v_request->'link'->>'linkerVersion'
      or v_link.evidence_span is distinct from v_request->'link'->'evidenceSpan'
      or v_link.recorded_at is distinct from (v_request->'link'->>'recordedAt')::timestamptz then
      raise exception 'accepted entity link does not satisfy its candidate authorization'
        using errcode = '23514';
    end if;
  elsif v_kind = 'workgroup' then
    select * into v_workgroup
    from public.operational_workgroups_v2
    where workgroup_id = p_accepted_item_id
      and workspace_key = p_workspace_key;
    select * into v_workgroup_envelope
    from public.operational_workgroup_envelopes
    where workgroup_id = p_accepted_item_id
      and workspace_key = p_workspace_key;
    if v_workgroup.workgroup_id is null
      or v_workgroup_envelope.workgroup_id is null
      or v_workgroup.workgroup_type is distinct from v_request->'workgroup'->>'workgroupType'
      or v_workgroup.identity_key is distinct from v_request->'workgroup'->>'identityKey'
      or v_workgroup.identity_basis is distinct from v_request->'workgroup'->'identityBasis'
      or v_workgroup.created_method is distinct from v_request->'workgroup'->>'createdMethod'
      or v_workgroup.linker_version is distinct from v_request->'workgroup'->>'linkerVersion'
      or v_workgroup.initial_confidence is distinct from
        (v_request->'workgroup'->>'initialConfidence')::numeric
      or v_workgroup.created_at is distinct from
        (v_request->'workgroup'->>'createdAt')::timestamptz then
      raise exception 'accepted workgroup does not satisfy its candidate authorization'
        using errcode = '23514';
    end if;
  elsif v_kind = 'workgroup_membership' then
    select * into v_membership
    from public.operational_workgroup_memberships
    where membership_version_id = p_accepted_item_id;
    select * into v_membership_envelope
    from public.operational_workgroup_membership_envelopes
    where membership_version_id = p_accepted_item_id
      and workspace_key = p_workspace_key;
    select * into v_workgroup
    from public.operational_workgroups_v2
    where workgroup_id = v_membership.workgroup_id
      and workspace_key = p_workspace_key;
    if v_membership.membership_version_id is null
      or v_membership_envelope.membership_version_id is null
      or v_membership.content_hash is distinct from v_membership_envelope.envelope_hash
      or v_membership.membership_key is distinct from v_request->'membership'->>'membershipKey'
      or v_membership.version_no is distinct from
        (v_request->'membership'->>'versionNo')::integer
      or v_membership.member_type is distinct from v_request->'membership'->>'memberType'
      or v_membership.member_key is distinct from v_request->'membership'->>'memberKey'
      or v_membership.role is distinct from v_request->'membership'->>'role'
      or v_membership.decision is distinct from v_request->'membership'->>'decision'
      or v_membership.confidence is distinct from
        (v_request->'membership'->>'confidence')::numeric
      or v_membership.membership_method is distinct from
        v_request->'membership'->>'membershipMethod'
      or v_membership.linker_version is distinct from
        v_request->'membership'->>'linkerVersion'
      or v_membership.basis_observation_id is distinct from
        v_request->'membership'->>'basisObservationId'
      or v_membership.recorded_at is distinct from
        (v_request->'membership'->>'recordedAt')::timestamptz
      or v_workgroup.workgroup_type is distinct from v_request->'workgroup'->>'workgroupType'
      or v_workgroup.identity_key is distinct from v_request->'workgroup'->>'identityKey'
      or v_workgroup.identity_basis is distinct from v_request->'workgroup'->'identityBasis' then
      raise exception 'accepted workgroup membership does not satisfy its candidate authorization'
        using errcode = '23514';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'observationId', evidence.observation_id,
      'evidenceRole', evidence.evidence_role,
      'evidenceSpan', evidence.evidence_span
    ) order by evidence.observation_id), '[]'::jsonb)
    into v_evidence
    from public.operational_workgroup_membership_evidence evidence
    where evidence.membership_version_id = p_accepted_item_id;
    if v_evidence is distinct from v_request->'evidence' then
      raise exception 'accepted workgroup membership evidence differs from its authorization'
        using errcode = '23514';
    end if;
  else
    raise exception 'truth-link accepted item kind is unsupported' using errcode = '22023';
  end if;

  v_binding := jsonb_build_object(
    'bindingSchemaVersion', 'truth-link-acceptance-binding-v1',
    'workspaceKey', p_workspace_key,
    'proposalId', v_proposal.proposal_id,
    'proposalItemHash', v_proposal.proposal_hash,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'acceptedItemKind', v_kind,
    'acceptedItemId', p_accepted_item_id
  );
  v_binding_hash := encode(extensions.digest(
    convert_to(v_binding::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_binding_id := 'link-acceptance:v1:' || v_binding_hash;
  select * into v_existing
  from public.truth_link_acceptance_bindings
  where binding_id = v_binding_id;
  if found then
    v_idempotent := true;
    if v_existing.canonical_binding is distinct from v_binding then
      raise exception 'truth-link acceptance binding hash collision' using errcode = '23505';
    end if;
  else
    if exists (
      select 1 from public.truth_link_acceptance_bindings binding
      where binding.proposal_id = p_proposal_id
         or binding.decision_version_id = p_decision_version_id
    ) then
      raise exception 'truth-link acceptance already has a different binding'
        using errcode = '23505';
    end if;
    insert into public.truth_link_acceptance_bindings (
      binding_id, proposal_id, decision_version_id, accepted_item_kind,
      accepted_item_id, binding_hash, binding_schema_version,
      canonical_binding
    ) values (
      v_binding_id, p_proposal_id, p_decision_version_id, v_kind,
      p_accepted_item_id, v_binding_hash,
      'truth-link-acceptance-binding-v1', v_binding
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'bindingId', v_binding_id,
    'itemHash', v_binding_hash,
    'proposalId', p_proposal_id,
    'decisionVersionId', p_decision_version_id,
    'acceptedItemKind', v_kind,
    'acceptedItemId', p_accepted_item_id
  );
end;
$function$;

create or replace function private.append_truth_link_candidate_decision(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_proposal_id text,
  p_decision jsonb,
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_proposal public.truth_link_candidate_proposals%rowtype;
  v_run public.truth_link_resolution_runs%rowtype;
  v_raw jsonb;
  v_assessment jsonb;
  v_parent public.truth_link_candidate_proposals%rowtype;
  v_parent_raw jsonb;
  v_decision_no integer;
  v_previous_decision_version_id text;
  v_previous public.truth_link_candidate_decisions%rowtype;
  v_primary_observation_id text;
  v_evidence jsonb;
  v_membership_key text;
  v_accepted_item_request jsonb;
  v_canonical_decision jsonb;
  v_decision_hash text;
  v_decision_version_id text;
  v_existing public.truth_link_candidate_decisions%rowtype;
  v_idempotent boolean := false;
begin
  if jsonb_typeof(coalesce(p_decision, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(p_decision, array[
      'decisionNo', 'previousDecisionVersionId', 'decision', 'method',
      'policyVersion', 'decidedBy', 'reasons'
    ])
    or coalesce(p_decision->>'decisionNo', '') !~ '^[1-9][0-9]*$'
    or length(p_decision->>'decisionNo') > 10
    or (p_decision->>'decisionNo')::numeric > 2147483647
    or not (coalesce(p_decision->>'decision', '') = any (array['accept', 'review', 'reject']))
    or not (coalesce(p_decision->>'method', '') = any (array['policy', 'operator']))
    or nullif(trim(coalesce(p_decision->>'policyVersion', '')), '') is null
    or nullif(trim(coalesce(p_decision->>'decidedBy', '')), '') is null
    or jsonb_typeof(coalesce(p_decision->'reasons', 'null'::jsonb)) <> 'array'
    or jsonb_array_length(p_decision->'reasons') = 0
    or exists (
      select 1 from jsonb_array_elements(p_decision->'reasons') reason
      where jsonb_typeof(reason) <> 'string' or nullif(trim(reason #>> '{}'), '') is null
    ) then
    raise exception 'truth-link candidate decision is invalid' using errcode = '22023';
  end if;
  if p_decision ? 'previousDecisionVersionId'
    and jsonb_typeof(p_decision->'previousDecisionVersionId') not in ('string', 'null') then
    raise exception 'truth-link previous decision identifier is invalid' using errcode = '22023';
  end if;
  v_decision_no := (p_decision->>'decisionNo')::integer;
  v_previous_decision_version_id := nullif(
    coalesce(p_decision->>'previousDecisionVersionId', ''), ''
  );

  select * into v_proposal
  from public.truth_link_candidate_proposals
  where proposal_id = p_proposal_id
    and workspace_key = p_workspace_key;
  if not found then
    raise exception 'truth-link candidate proposal is unavailable' using errcode = '23503';
  end if;
  select * into v_run
  from public.truth_link_resolution_runs
  where resolution_run_id = v_proposal.resolution_run_id;
  v_raw := v_proposal.canonical_proposal->'candidate'->'proposal';
  v_assessment := v_proposal.canonical_proposal->'candidate'->'assessment';

  if p_decision->>'method' = 'policy' then
    if not private.valid_truth_sync_token(p_token) then
      raise exception 'invalid sync token' using errcode = '28000';
    end if;
    v_job := private.assert_truth_link_job_lease(
      p_job_id, p_worker_id, p_lease_fence, p_processor_version
    );
    if v_job.workspace_key is distinct from p_workspace_key
      or v_run.job_id is distinct from p_job_id then
      raise exception 'truth-link policy decision is outside the fenced resolution job'
        using errcode = '23514';
    end if;
  elsif not private.valid_truth_link_operator_token(p_token) then
    raise exception 'invalid truth-link operator token' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-link-decision:' || p_workspace_key || ':' || p_proposal_id,
    0
  ));
  if v_decision_no = 1 then
    if v_previous_decision_version_id is not null then
      raise exception 'truth-link decision version one cannot have a predecessor'
        using errcode = '23514';
    end if;
  else
    if v_previous_decision_version_id is null then
      raise exception 'truth-link decision chain is incomplete' using errcode = '23514';
    end if;
    select * into v_previous
    from public.truth_link_candidate_decisions
    where decision_version_id = v_previous_decision_version_id;
    if not found
      or v_previous.proposal_id is distinct from p_proposal_id
      or v_previous.decision_no <> v_decision_no - 1 then
      raise exception 'truth-link previous decision is not the exact predecessor'
        using errcode = '23514';
    end if;
    if v_previous.decision in ('accept', 'reject') then
      raise exception 'truth-link terminal decision cannot be superseded'
        using errcode = '55000';
    end if;
  end if;

  if p_decision->>'method' = 'policy' then
    if p_decision->>'decision' = 'accept' then
      if v_proposal.proposal_method <> 'deterministic'
        or not v_proposal.auto_accept_eligible
        or v_proposal.requires_review
        or v_proposal.has_conflict
        or v_proposal.membership_change
        or v_proposal.policy_disposition <> 'accept'
        or not (v_proposal.policy_class = any (
          array['explicit_awb_mention', 'explicit_count_matched_group']
        )) then
        raise exception 'truth-link proposal is not eligible for deterministic policy acceptance'
          using errcode = '23514';
      end if;
      if v_proposal.policy_class = 'explicit_awb_mention'
        and not (
          v_proposal.candidate_kind = 'entity_link'
          and v_raw->>'entityType' = 'shipment'
          and v_raw->>'relationship' = 'mentions'
          and v_raw->>'reasonCode' = 'explicit_full_awb_mention'
          and v_raw->>'linkMethod' = 'deterministic'
          and (v_raw->>'autoAcceptEligible')::boolean
        ) then
        raise exception 'truth-link explicit-AWB policy evidence is invalid'
          using errcode = '23514';
      end if;
      if v_proposal.policy_class = 'explicit_count_matched_group' then
        if v_proposal.candidate_kind = 'workgroup' then
          if not (
            (v_raw->>'autoAcceptEligible')::boolean
            and not (v_raw->>'requiresReview')::boolean
            and v_raw->'definition'->>'createdMethod' = 'deterministic'
            and exists (
              select 1 from jsonb_array_elements(v_raw->'reasons') reason
              where reason->>'reasonCode' = 'broker_plural_reply_confirms_batch_scope'
                and (reason->>'exactCountConfirmed')::boolean
            )
          ) then
            raise exception 'truth-link exact group evidence is invalid' using errcode = '23514';
          end if;
        elsif v_proposal.candidate_kind = 'workgroup_membership' then
          select * into v_parent
          from public.truth_link_candidate_proposals
          where resolution_run_id = v_proposal.resolution_run_id
            and candidate_key = v_proposal.parent_candidate_key
            and candidate_kind = 'workgroup'
            and policy_class = 'explicit_count_matched_group'
            and policy_disposition = 'accept';
          if not found
            or v_raw->>'membershipMethod' <> 'deterministic'
            or not (v_raw->>'autoAcceptEligible')::boolean then
            raise exception 'truth-link exact group membership evidence is invalid'
              using errcode = '23514';
          end if;
        elsif v_proposal.candidate_kind = 'entity_link' then
          select * into v_parent
          from public.truth_link_candidate_proposals
          where resolution_run_id = v_proposal.resolution_run_id
            and candidate_key = v_raw->'evidenceSpan'->>'candidateWorkgroupId'
            and candidate_kind = 'workgroup'
            and policy_class = 'explicit_count_matched_group'
            and policy_disposition = 'accept';
          if not found
            or v_raw->>'entityType' <> 'shipment'
            or v_raw->>'relationship' <> 'shared_execution'
            or v_raw->>'reasonCode' <> 'alert_batch_workgroup_propagation'
            or v_raw->>'linkMethod' <> 'deterministic'
            or not (v_raw->>'autoAcceptEligible')::boolean then
            raise exception 'truth-link exact group shared-link evidence is invalid'
              using errcode = '23514';
          end if;
        else
          raise exception 'truth-link exact group policy kind is invalid' using errcode = '23514';
        end if;
      end if;
    elsif p_decision->>'decision' = 'review'
      and v_proposal.policy_disposition <> 'review' then
      raise exception 'truth-link policy review does not match the durable assessment'
        using errcode = '23514';
    elsif p_decision->>'decision' = 'reject'
      and v_proposal.policy_disposition <> 'reject' then
      raise exception 'truth-link policy rejection does not match the durable assessment'
        using errcode = '23514';
    end if;
  end if;

  if p_decision->>'decision' = 'accept' then
    if v_proposal.candidate_kind = 'entity_link' then
      v_accepted_item_request := jsonb_build_object(
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
    elsif v_proposal.candidate_kind = 'workgroup' then
      v_accepted_item_request := jsonb_build_object(
        'acceptedKind', 'workgroup',
        'workgroup', v_raw->'definition'
      );
    else
      select * into v_parent
      from public.truth_link_candidate_proposals
      where resolution_run_id = v_proposal.resolution_run_id
        and candidate_key = v_proposal.parent_candidate_key
        and candidate_kind = 'workgroup';
      if not found then
        raise exception 'truth-link membership lacks its durable workgroup proposal'
          using errcode = '23503';
      end if;
      v_parent_raw := v_parent.canonical_proposal->'candidate'->'proposal';
      select coalesce(
        (
          select evidence->>'observationId'
          from jsonb_array_elements(v_raw->'evidence') evidence
          where evidence->>'evidenceRole' = 'primary'
          order by evidence->>'observationId'
          limit 1
        ),
        (
          select evidence->>'observationId'
          from jsonb_array_elements(v_raw->'evidence') evidence
          order by evidence->>'observationId'
          limit 1
        )
      ) into v_primary_observation_id;
      if v_primary_observation_id is null then
        raise exception 'truth-link membership acceptance lacks source evidence'
          using errcode = '23514';
      end if;
      select jsonb_agg(jsonb_build_object(
        'observationId', evidence->>'observationId',
        'evidenceRole', case
          when evidence->>'observationId' = v_primary_observation_id then 'primary'
          else case
            when evidence->>'evidenceRole' = 'contradicting' then 'contradicting'
            else 'supporting'
          end
        end,
        'evidenceSpan', coalesce(evidence->'evidenceSpan', '{}'::jsonb)
      ) order by evidence->>'observationId')
      into v_evidence
      from jsonb_array_elements(v_raw->'evidence') evidence;
      v_membership_key := 'workgroup-membership:v1:' || encode(extensions.digest(
        convert_to(jsonb_build_object(
          'workgroupIdentityKey', v_raw->>'workgroupIdentityKey',
          'memberType', v_raw->>'memberType',
          'memberKey', v_raw->>'memberKey',
          'role', v_raw->>'role'
        )::text, 'UTF8'),
        'sha256'
      ), 'hex');
      v_accepted_item_request := jsonb_build_object(
        'acceptedKind', 'workgroup_membership',
        'workgroup', v_parent_raw->'definition',
        'membership', jsonb_build_object(
          'membershipKey', v_membership_key,
          'versionNo', 1,
          'previousMembershipVersionId', null,
          'memberType', v_raw->>'memberType',
          'memberKey', v_raw->>'memberKey',
          'role', v_raw->>'role',
          'decision', v_raw->>'decision',
          'confidence', (v_raw->>'confidence')::numeric,
          'membershipMethod', v_raw->>'membershipMethod',
          'linkerVersion', v_raw->>'linkerVersion',
          'basisObservationId', v_primary_observation_id,
          'recordedAt', v_parent_raw->'definition'->>'createdAt',
          'schemaVersion', 'operational-workgroup-membership-v1'
        ),
        'evidence', v_evidence
      );
    end if;
  end if;

  v_canonical_decision := jsonb_build_object(
    'decisionSchemaVersion', 'truth-link-candidate-decision-v1',
    'workspaceKey', p_workspace_key,
    'proposalId', v_proposal.proposal_id,
    'proposalItemHash', v_proposal.proposal_hash,
    'decision', jsonb_build_object(
      'decisionNo', v_decision_no,
      'previousDecisionVersionId', coalesce(v_previous_decision_version_id, ''),
      'decision', p_decision->>'decision',
      'method', p_decision->>'method',
      'policyVersion', p_decision->>'policyVersion',
      'decidedBy', p_decision->>'decidedBy',
      'reasons', p_decision->'reasons',
      'acceptedItemRequest', v_accepted_item_request
    )
  );
  v_decision_hash := encode(extensions.digest(
    convert_to(v_canonical_decision::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_decision_version_id := 'link-decision:v1:' || v_decision_hash;

  select * into v_existing
  from public.truth_link_candidate_decisions
  where decision_version_id = v_decision_version_id;
  if found then
    v_idempotent := true;
    if v_existing.proposal_id is distinct from p_proposal_id
      or v_existing.canonical_decision is distinct from v_canonical_decision then
      raise exception 'truth-link candidate decision hash collision' using errcode = '23505';
    end if;
  else
    if exists (
      select 1 from public.truth_link_candidate_decisions decision_row
      where decision_row.proposal_id = p_proposal_id
        and decision_row.decision_no = v_decision_no
    ) then
      raise exception 'truth-link logical decision version already differs'
        using errcode = '23505';
    end if;
    insert into public.truth_link_candidate_decisions (
      decision_version_id, proposal_id, decision_no,
      previous_decision_version_id, decision, decision_method,
      policy_version, decided_by, reasons, accepted_item_request,
      decision_hash, decision_schema_version, canonical_decision
    ) values (
      v_decision_version_id, p_proposal_id, v_decision_no,
      v_previous_decision_version_id, p_decision->>'decision',
      p_decision->>'method', p_decision->>'policyVersion',
      p_decision->>'decidedBy', p_decision->'reasons',
      v_accepted_item_request, v_decision_hash,
      'truth-link-candidate-decision-v1', v_canonical_decision
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'proposalId', p_proposal_id,
    'decisionVersionId', v_decision_version_id,
    'itemHash', v_decision_hash,
    'decision', p_decision->>'decision',
    'acceptedItemRequest', v_accepted_item_request
  );
end;
$function$;

revoke all on function private.valid_truth_link_operator_token(text)
  from public, anon, authenticated, service_role;

create or replace function private.assert_truth_link_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text
)
returns public.source_processing_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
begin
  select job.* into v_job
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.job_id = job.job_id
   and lineage.workspace_key = job.workspace_key
   and lineage.source_system = job.source_system
   and lineage.connection_key = job.connection_key
  join public.source_ingest_batches batch
    on batch.batch_id = lineage.root_batch_id
   and batch.status = 'committed'
   and batch.committed_cursor_version = lineage.source_cursor_version
   and batch.committed_cursor_value = lineage.source_cursor_value
  join public.source_observations observation
    on observation.observation_id = job.observation_id
   and observation.workspace_key = job.workspace_key
   and observation.source_system = job.source_system
   and observation.connection_key = job.connection_key
  where job.job_id = p_job_id
    and job.job_kind = 'gmail_resolve_entity_links'
    and job.source_system = 'gmail'
    and job.state = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_fence = p_lease_fence
    and job.processor_version = p_processor_version
    and job.lease_expires_at > clock_timestamp()
    and observation.source_object_type = 'gmail_message_parsed'
    and observation.operation = 'content'
    and observation.normalized_payload->>'schemaVersion' = 'gmail-parsed-message-v2'
  for update of job;
  if not found then
    raise exception 'truth-link source-processing lease lost' using errcode = '40001';
  end if;
  return v_job;
end;
$function$;

revoke all on function private.assert_truth_link_job_lease(uuid, text, bigint, text)
  from public, anon, authenticated, service_role;

create or replace function private.append_truth_link_resolution(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_context_manifest jsonb,
  p_resolution jsonb,
  p_proposals jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_context_count integer;
  v_proposal_count integer;
  v_expected_count integer;
  v_envelope jsonb;
  v_hash text;
  v_resolution_run_id text;
  v_existing public.truth_link_resolution_runs%rowtype;
  v_item jsonb;
  v_proposal_envelope jsonb;
  v_proposal_hash text;
  v_proposal_id text;
  v_receipts jsonb := '[]'::jsonb;
  v_missing_proposals jsonb;
  v_idempotent boolean := false;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or jsonb_typeof(coalesce(p_context_manifest, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_resolution, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_proposals, 'null'::jsonb)) <> 'array' then
    raise exception 'truth-link resolution request is invalid' using errcode = '22023';
  end if;
  v_job := private.assert_truth_link_job_lease(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if v_job.workspace_key is distinct from p_workspace_key then
    raise exception 'truth-link job is outside the workspace' using errcode = '23514';
  end if;
  select * into v_lineage
  from public.source_processing_job_lineage
  where job_id = p_job_id;

  select count(*)::integer into v_context_count
  from jsonb_array_elements(p_context_manifest);
  if v_context_count < 1 or v_context_count > 2000
    or v_context_count <> (
      select count(distinct item->>'observationId')::integer
      from jsonb_array_elements(p_context_manifest) item
    )
    or exists (
      select 1
      from jsonb_array_elements(p_context_manifest) item
      where jsonb_typeof(item) <> 'object'
        or not private.truth_jsonb_has_only_keys(item, array['observationId', 'contentHash'])
        or coalesce(item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
        or coalesce(item->>'contentHash', '') !~ '^[0-9a-f]{64}$'
    )
    or p_context_manifest is distinct from (
      select jsonb_agg(item order by item->>'observationId')
      from jsonb_array_elements(p_context_manifest) item
    ) then
    raise exception 'truth-link context manifest is invalid or noncanonical' using errcode = '23514';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(p_context_manifest) item
    where item->>'observationId' = v_job.observation_id
  ) then
    raise exception 'truth-link context omits the job anchor' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_context_manifest) item
    left join public.source_observations observation
      on observation.observation_id = item->>'observationId'
    where observation.observation_id is null
      or observation.workspace_key is distinct from p_workspace_key
      or observation.source_system <> 'gmail'
      or observation.source_object_type <> 'gmail_message_parsed'
      or observation.operation <> 'content'
      or observation.content_hash is distinct from item->>'contentHash'
      or observation.normalized_payload->>'schemaVersion' <> 'gmail-parsed-message-v2'
  ) then
    raise exception 'truth-link context is outside immutable parsed Gmail evidence'
      using errcode = '23503';
  end if;

  if not private.truth_jsonb_has_only_keys(p_resolution, array[
    'schemaVersion', 'linkerVersion', 'inputManifestHash', 'inputObservationCount',
    'graph', 'candidateLinks', 'alertBatchCandidates', 'alertBatchBridges',
    'candidateWorkgroups', 'ambiguities', 'exclusions', 'outputHash'
  ])
    or p_resolution->>'schemaVersion' <> 'gmail-cross-thread-link-candidates-v1'
    or nullif(trim(coalesce(p_resolution->>'linkerVersion', '')), '') is null
    or coalesce(p_resolution->>'inputManifestHash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_resolution->>'outputHash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_resolution->>'inputObservationCount', '') !~ '^[0-9]+$'
    or (p_resolution->>'inputObservationCount')::numeric > 2000
    or (p_resolution->>'inputObservationCount')::integer <> v_context_count
    or jsonb_typeof(coalesce(p_resolution->'candidateLinks', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_resolution->'candidateWorkgroups', 'null'::jsonb)) <> 'array' then
    raise exception 'truth-link linker output is invalid' using errcode = '23514';
  end if;

  select count(*)::integer into v_proposal_count
  from jsonb_array_elements(p_proposals);
  select jsonb_array_length(p_resolution->'candidateLinks')
    + jsonb_array_length(p_resolution->'candidateWorkgroups')
    + coalesce(sum(jsonb_array_length(coalesce(workgroup->'memberships', '[]'::jsonb))), 0)::integer
  into v_expected_count
  from jsonb_array_elements(p_resolution->'candidateWorkgroups') workgroup;
  if v_proposal_count <> v_expected_count
    or v_proposal_count <> (
      select count(distinct item->>'candidateKey')::integer
      from jsonb_array_elements(p_proposals) item
    ) then
    raise exception 'truth-link proposal set is incomplete or duplicated' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_proposals) item
    where jsonb_typeof(item) <> 'object'
      or not private.truth_jsonb_has_only_keys(item, array[
        'candidateKind', 'candidateKey', 'parentCandidateKey', 'method',
        'autoAcceptEligible', 'requiresReview', 'evidenceObservationIds',
        'proposal', 'assessment'
      ])
      or not (coalesce(item->>'candidateKind', '') = any (
        array['entity_link', 'workgroup', 'workgroup_membership']
      ))
      or nullif(trim(coalesce(item->>'candidateKey', '')), '') is null
      or not (coalesce(item->>'method', '') = any (array['deterministic', 'model', 'operator']))
      or jsonb_typeof(item->'autoAcceptEligible') <> 'boolean'
      or jsonb_typeof(item->'requiresReview') <> 'boolean'
      or jsonb_typeof(coalesce(item->'evidenceObservationIds', 'null'::jsonb)) <> 'array'
      or jsonb_array_length(item->'evidenceObservationIds') = 0
      or jsonb_typeof(coalesce(item->'proposal', 'null'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(item->'assessment', 'null'::jsonb)) <> 'object'
      or not private.truth_jsonb_has_only_keys(
        item->'assessment',
        array['policyDisposition', 'policyClass', 'conflict', 'membershipChange', 'reasons']
      )
      or not (coalesce(item->'assessment'->>'policyDisposition', '') = any (
        array['accept', 'review', 'reject']
      ))
      or nullif(trim(coalesce(item->'assessment'->>'policyClass', '')), '') is null
      or jsonb_typeof(item->'assessment'->'conflict') <> 'boolean'
      or jsonb_typeof(item->'assessment'->'membershipChange') <> 'boolean'
      or jsonb_typeof(coalesce(item->'assessment'->'reasons', 'null'::jsonb)) <> 'array'
      or jsonb_array_length(item->'assessment'->'reasons') = 0
      or exists (
        select 1 from jsonb_array_elements(item->'assessment'->'reasons') reason
        where jsonb_typeof(reason) <> 'string' or nullif(trim(reason #>> '{}'), '') is null
      )
      or (item->>'method' <> 'deterministic' and item->'assessment'->>'policyDisposition' = 'accept')
      or (
        ((item->'assessment'->>'conflict')::boolean
          or (item->'assessment'->>'membershipChange')::boolean
          or (item->>'requiresReview')::boolean)
        and item->'assessment'->>'policyDisposition' = 'accept'
      )
  ) then
    raise exception 'truth-link proposal or policy assessment is invalid' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_proposals) item
    cross join lateral jsonb_array_elements_text(item->'evidenceObservationIds') evidence(observation_id)
    left join jsonb_array_elements(p_context_manifest) context_item(value)
      on context_item.value->>'observationId' = evidence.observation_id
    where context_item.value is null
      or evidence.observation_id !~ '^obs:v1:[0-9a-f]{64}$'
  ) or exists (
    select 1
    from jsonb_array_elements(p_proposals) item
    where item->'evidenceObservationIds' is distinct from (
      select jsonb_agg(to_jsonb(evidence.observation_id) order by evidence.observation_id)
      from (
        select distinct value as observation_id
        from jsonb_array_elements_text(item->'evidenceObservationIds') value
      ) evidence
    )
  ) then
    raise exception 'truth-link proposal evidence is outside or noncanonical to context'
      using errcode = '23514';
  end if;

  -- Proposals are an exhaustive normalized view over the immutable linker
  -- artifact. Candidate keys, kinds, and parentage must cover the artifact;
  -- both the raw artifact and normalized proposal are committed together in
  -- the server-derived resolution envelope and are revalidated at decision.
  with expected as (
      select 'entity_link'::text as candidate_kind,
             link->>'candidateLinkId' as candidate_key,
             coalesce(link->'evidenceSpan'->>'candidateWorkgroupId', '') as parent_candidate_key,
             link as proposal
      from jsonb_array_elements(p_resolution->'candidateLinks') link
      union all
      select 'workgroup', workgroup->>'candidateWorkgroupId', '', workgroup
      from jsonb_array_elements(p_resolution->'candidateWorkgroups') workgroup
      union all
      select 'workgroup_membership', membership->>'candidateMembershipId',
             workgroup->>'candidateWorkgroupId', membership
      from jsonb_array_elements(p_resolution->'candidateWorkgroups') workgroup
      cross join lateral jsonb_array_elements(workgroup->'memberships') membership
    )
    select jsonb_agg(jsonb_build_object(
      'candidateKind', expected.candidate_kind,
      'candidateKey', expected.candidate_key,
      'parentCandidateKey', expected.parent_candidate_key
    ) order by expected.candidate_key)
    into v_missing_proposals
    from expected
    left join jsonb_array_elements(p_proposals) supplied(value)
      on supplied.value->>'candidateKind' = expected.candidate_kind
     and supplied.value->>'candidateKey' = expected.candidate_key
     and coalesce(supplied.value->>'parentCandidateKey', '') = expected.parent_candidate_key
    where supplied.value is null;
  if v_missing_proposals is not null then
    raise exception 'truth-link proposal projection differs from linker output: %',
      v_missing_proposals using errcode = '23514';
  end if;

  v_envelope := jsonb_build_object(
    'resolutionSchemaVersion', 'truth-link-resolution-envelope-v1',
    'workspaceKey', p_workspace_key,
    'job', jsonb_build_object(
      'jobId', p_job_id,
      'anchorObservationId', v_job.observation_id,
      'rootBatchId', v_lineage.root_batch_id,
      'sourceCursorVersion', v_lineage.source_cursor_version,
      'sourceCursorValue', v_lineage.source_cursor_value,
      'leaseFence', p_lease_fence,
      'processorVersion', p_processor_version
    ),
    'contextManifest', p_context_manifest,
    'linkerOutput', p_resolution,
    'proposals', p_proposals
  );
  v_hash := encode(extensions.digest(convert_to(v_envelope::text, 'UTF8'), 'sha256'), 'hex');
  v_resolution_run_id := 'link-resolution:v1:' || v_hash;

  select * into v_existing
  from public.truth_link_resolution_runs
  where job_id = p_job_id;
  if found then
    if v_existing.resolution_run_id is distinct from v_resolution_run_id
      or v_existing.canonical_resolution is distinct from v_envelope then
      raise exception 'truth-link job already has a different durable resolution'
        using errcode = '23505';
    end if;
    v_idempotent := true;
  else
    insert into public.truth_link_resolution_runs (
      resolution_run_id, workspace_key, job_id, anchor_observation_id,
      root_batch_id, source_cursor_version, source_cursor_value, linker_version,
      input_manifest_hash, linker_output_hash, context_observation_count,
      proposal_count, resolution_hash, resolution_schema_version,
      canonical_resolution
    ) values (
      v_resolution_run_id, p_workspace_key, p_job_id, v_job.observation_id,
      v_lineage.root_batch_id, v_lineage.source_cursor_version,
      v_lineage.source_cursor_value, p_resolution->>'linkerVersion',
      p_resolution->>'inputManifestHash', p_resolution->>'outputHash',
      v_context_count, v_proposal_count, v_hash,
      'truth-link-resolution-envelope-v1', v_envelope
    );
    insert into public.truth_link_resolution_context (
      resolution_run_id, observation_id, observation_content_hash, ordinal
    )
    select v_resolution_run_id, item->>'observationId', item->>'contentHash',
           row_number() over (order by item->>'observationId') - 1
    from jsonb_array_elements(p_context_manifest) item;
  end if;

  for v_item in select value from jsonb_array_elements(p_proposals) order by value->>'candidateKey'
  loop
    v_proposal_envelope := jsonb_build_object(
      'proposalSchemaVersion', 'truth-link-candidate-proposal-v1',
      'workspaceKey', p_workspace_key,
      'resolutionRunId', v_resolution_run_id,
      'resolutionItemHash', v_hash,
      'candidate', v_item
    );
    v_proposal_hash := encode(extensions.digest(
      convert_to(v_proposal_envelope::text, 'UTF8'), 'sha256'
    ), 'hex');
    v_proposal_id := 'link-proposal:v1:' || v_proposal_hash;
    insert into public.truth_link_candidate_proposals (
      proposal_id, resolution_run_id, workspace_key, candidate_kind,
      candidate_key, parent_candidate_key, proposal_method,
      auto_accept_eligible, requires_review, policy_disposition,
      policy_class, has_conflict, membership_change, proposal_hash,
      proposal_schema_version, canonical_proposal
    ) values (
      v_proposal_id, v_resolution_run_id, p_workspace_key,
      v_item->>'candidateKind', v_item->>'candidateKey',
      coalesce(v_item->>'parentCandidateKey', ''), v_item->>'method',
      (v_item->>'autoAcceptEligible')::boolean,
      (v_item->>'requiresReview')::boolean,
      v_item->'assessment'->>'policyDisposition',
      v_item->'assessment'->>'policyClass',
      (v_item->'assessment'->>'conflict')::boolean,
      (v_item->'assessment'->>'membershipChange')::boolean,
      v_proposal_hash, 'truth-link-candidate-proposal-v1',
      v_proposal_envelope
    ) on conflict (proposal_id) do nothing;
    if not exists (
      select 1 from public.truth_link_candidate_proposals proposal
      where proposal.proposal_id = v_proposal_id
        and proposal.canonical_proposal = v_proposal_envelope
    ) then
      raise exception 'truth-link proposal persistence conflicts with its envelope'
        using errcode = '23505';
    end if;
    insert into public.truth_link_candidate_evidence (
      proposal_id, observation_id, ordinal
    )
    select v_proposal_id, evidence.value,
           row_number() over (order by evidence.value) - 1
    from jsonb_array_elements_text(v_item->'evidenceObservationIds') evidence(value)
    on conflict do nothing;
    if (
      select count(*)::integer from public.truth_link_candidate_evidence evidence
      where evidence.proposal_id = v_proposal_id
    ) <> jsonb_array_length(v_item->'evidenceObservationIds') then
      raise exception 'truth-link proposal evidence persistence is incomplete'
        using errcode = '23514';
    end if;
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
      'candidateKey', v_item->>'candidateKey',
      'candidateKind', v_item->>'candidateKind',
      'proposalId', v_proposal_id,
      'itemHash', v_proposal_hash,
      'policyDisposition', v_item->'assessment'->>'policyDisposition'
    ));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'resolutionRunId', v_resolution_run_id,
    'itemHash', v_hash,
    'proposalCount', v_proposal_count,
    'proposals', v_receipts
  );
end;
$function$;

create or replace function public.append_truth_link_resolution(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_context_manifest jsonb,
  p_resolution jsonb,
  p_proposals jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_truth_link_resolution(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_context_manifest, p_resolution,
    p_proposals, p_sync_token
  );
$function$;

create or replace function public.append_truth_link_candidate_decision(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_proposal_id text,
  p_decision jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_truth_link_candidate_decision(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_proposal_id, p_decision, p_sync_token
  );
$function$;

create or replace function public.bind_truth_link_candidate_acceptance(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_proposal_id text,
  p_decision_version_id text,
  p_accepted_item_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.bind_truth_link_candidate_acceptance(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_proposal_id, p_decision_version_id,
    p_accepted_item_id, p_sync_token
  );
$function$;

-- Later operator adjudication is deliberately independent of the completed
-- worker lease and requires its own backend token. The public wrapper is the
-- only executable surface; private functions remain inaccessible.
create or replace function public.append_operator_truth_link_candidate_decision(
  p_workspace_key text,
  p_proposal_id text,
  p_decision jsonb,
  p_operator_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.append_truth_link_candidate_decision(
    p_workspace_key, null::uuid, null::text, null::bigint, null::text,
    p_proposal_id, p_decision, p_operator_token
  );
$function$;

create or replace function public.bind_operator_truth_link_candidate_acceptance(
  p_workspace_key text,
  p_proposal_id text,
  p_decision_version_id text,
  p_accepted_item_id text,
  p_operator_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.bind_truth_link_candidate_acceptance(
    p_workspace_key, null::uuid, null::text, null::bigint, null::text,
    p_proposal_id, p_decision_version_id, p_accepted_item_id,
    p_operator_token
  );
$function$;

revoke all on function private.append_truth_link_resolution(text, uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.append_truth_link_candidate_decision(text, uuid, text, bigint, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.bind_truth_link_candidate_acceptance(text, uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.append_truth_link_resolution(text, uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.append_truth_link_candidate_decision(text, uuid, text, bigint, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.bind_truth_link_candidate_acceptance(text, uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.append_operator_truth_link_candidate_decision(text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.bind_operator_truth_link_candidate_acceptance(text, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.append_truth_link_resolution(text, uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function public.append_truth_link_candidate_decision(text, uuid, text, bigint, text, text, jsonb, text)
  to service_role;
grant execute on function public.bind_truth_link_candidate_acceptance(text, uuid, text, bigint, text, text, text, text, text)
  to service_role;
grant execute on function public.append_operator_truth_link_candidate_decision(text, text, jsonb, text)
  to service_role;
grant execute on function public.bind_operator_truth_link_candidate_acceptance(text, text, text, text, text)
  to service_role;
