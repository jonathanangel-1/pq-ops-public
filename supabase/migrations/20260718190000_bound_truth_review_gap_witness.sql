-- 20260718190000_bound_truth_review_gap_witness.sql
--
-- Preserve the exact immutable review-gap witness while keeping source-cut
-- sealing inside the hosted RPC budget.  The predecessor invoked the complete
-- stale-plan reconciliation proof for every in-scope candidate and performed
-- one latest-decision lookup per scoped link.  Only candidate lineage already
-- present in the five-row reconciliation ledger can satisfy that proof.

do $preflight$
begin
  if to_regprocedure(
    'private.truth_review_gaps_for_source_cut(text,jsonb)'
  ) is null
    or to_regprocedure(
      'private.truth_shadow_is_reconciled_stale_candidate_v1(text,text)'
    ) is null
    or to_regclass(
      'public.gmail_stale_extraction_plan_reconciliations'
    ) is null then
    raise exception 'truth review-gap predecessor contract is unavailable'
      using errcode = '23514';
  end if;
end;
$preflight$;

create or replace function private.truth_review_gaps_for_source_cut(
  p_workspace_key text,
  p_cursors jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with in_scope_observations as materialized (
    select observation.observation_id
    from jsonb_array_elements(p_cursors) cursor_item
    join public.source_observations observation
      on observation.workspace_key = p_workspace_key
     and observation.source_system = cursor_item->>'sourceSystem'
     and observation.connection_key = cursor_item->>'connectionKey'
     and observation.source_cursor_version <=
       (cursor_item->>'throughCursorVersion')::bigint
  ), reconciled_stale_candidates as materialized (
    select distinct lineage.candidate_claim_version_id
    from public.candidate_claim_job_lineage lineage
    join public.gmail_stale_extraction_plan_reconciliations reconciliation
      on reconciliation.workspace_key = p_workspace_key
     and reconciliation.stale_parent_job_id = lineage.job_id
    where private.truth_shadow_is_reconciled_stale_candidate_v1(
      p_workspace_key,
      lineage.candidate_claim_version_id
    )
  ), latest_candidate_decisions as materialized (
    select distinct on (decision_row.candidate_claim_version_id)
      decision_row.candidate_claim_version_id,
      decision_row.decision_version_id,
      decision_row.decision
    from public.candidate_claim_decisions decision_row
    order by decision_row.candidate_claim_version_id,
      decision_row.decision_no desc
  ), unresolved_candidates as (
    select candidate.candidate_claim_version_id as target_id,
           candidate.envelope_hash as item_hash
    from public.candidate_claim_envelopes candidate
    join in_scope_observations scoped
      on scoped.observation_id = candidate.source_observation_id
    left join latest_candidate_decisions latest
      on latest.candidate_claim_version_id =
        candidate.candidate_claim_version_id
    left join public.candidate_claim_acceptance_bindings binding
      on binding.candidate_claim_version_id =
        candidate.candidate_claim_version_id
    left join reconciled_stale_candidates stale
      on stale.candidate_claim_version_id =
        candidate.candidate_claim_version_id
    where candidate.workspace_key = p_workspace_key
      and stale.candidate_claim_version_id is null
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), scoped_link_ids as materialized (
    select distinct evidence.proposal_id
    from public.truth_link_candidate_evidence evidence
    join in_scope_observations scoped
      on scoped.observation_id = evidence.observation_id
  ), latest_link_decisions as materialized (
    select distinct on (decision_row.proposal_id)
      decision_row.proposal_id,
      decision_row.decision_version_id,
      decision_row.decision
    from public.truth_link_candidate_decisions decision_row
    order by decision_row.proposal_id, decision_row.decision_no desc
  ), unresolved_links as (
    select proposal.proposal_id as target_id,
           proposal.proposal_hash as item_hash
    from scoped_link_ids scoped
    join public.truth_link_candidate_proposals proposal
      on proposal.proposal_id = scoped.proposal_id
    left join latest_link_decisions latest
      on latest.proposal_id = proposal.proposal_id
    left join public.truth_link_acceptance_bindings binding
      on binding.proposal_id = proposal.proposal_id
    where proposal.workspace_key = p_workspace_key
      and (
        latest.decision_version_id is null
        or latest.decision = 'review'
        or (latest.decision = 'accept' and binding.binding_id is null)
      )
  ), gaps as (
    select jsonb_build_object(
      'gapType', 'CANDIDATE_CLAIM_REVIEW_PENDING',
      'count', count(*)::integer,
      'witnessHash', encode(extensions.digest(convert_to(
        coalesce(string_agg(
          target_id || ':' || item_hash,
          ',' order by target_id
        ), ''),
        'UTF8'
      ), 'sha256'), 'hex')
    ) as gap
    from unresolved_candidates
    having count(*) > 0
    union all
    select jsonb_build_object(
      'gapType', 'LINK_WORKGROUP_REVIEW_PENDING',
      'count', count(*)::integer,
      'witnessHash', encode(extensions.digest(convert_to(
        coalesce(string_agg(
          target_id || ':' || item_hash,
          ',' order by target_id
        ), ''),
        'UTF8'
      ), 'sha256'), 'hex')
    ) as gap
    from unresolved_links
    having count(*) > 0
  )
  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb)
  from gaps;
$function$;

revoke all on function private.truth_review_gaps_for_source_cut(text,jsonb)
  from public, anon, authenticated, service_role;

do $verify$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'private.truth_review_gaps_for_source_cut(text,jsonb)'::regprocedure
  ) into v_definition;
  if position('reconciled_stale_candidates as materialized' in lower(v_definition)) = 0
    or position('gmail_stale_extraction_plan_reconciliations' in v_definition) = 0
    or position('latest_candidate_decisions as materialized' in lower(v_definition)) = 0
    or position('scoped_link_ids as materialized' in lower(v_definition)) = 0
    or position('latest_link_decisions as materialized' in lower(v_definition)) = 0
    or position('left join lateral' in lower(v_definition)) <> 0 then
    raise exception 'bounded truth review-gap witness rewrite is incomplete'
      using errcode = '23514';
  end if;
end;
$verify$;
