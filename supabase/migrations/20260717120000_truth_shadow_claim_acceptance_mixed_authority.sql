-- The first shadow Gmail acceptance frontier was honestly reviewed before the
-- source-wide acceptance epoch coordinator existed.  Preserve those immutable
-- operator decisions as their own authority and let the epoch certify them as
-- members of the complete frontier.  The epoch decides only candidates which
-- still have no decision authority.  Nothing in this migration publishes or
-- makes the resulting claims production-eligible.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_shadow_claim_acceptance_epoch_items') is null
    or to_regclass('public.truth_review_resolutions') is null
    or to_regclass('public.candidate_claim_decisions') is null
    or to_regclass('public.candidate_claim_acceptance_bindings') is null then
    raise exception 'mixed-authority shadow acceptance prerequisites are unavailable'
      using errcode = '55000';
  end if;
  if to_regprocedure(
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'
    ) is null
    or to_regprocedure(
      'private.authoritative_truth_input_hash(text,text)'
    ) is null then
    raise exception 'mixed-authority shadow acceptance functions are unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('truth-shadow-claim-acceptance-epoch-v2' in v_definition) = 0
    and (
      position('shadow acceptance frontier already has a legacy decision authority' in v_definition) = 0
      or position('truth-shadow-claim-acceptance-epoch-v1' in v_definition) = 0
      or position('truth-source-cut-serialization-v1:' in v_definition) = 0
    ) then
    raise exception 'shadow acceptance coordinator differs from the reviewed v1 contract'
      using errcode = '23514';
  end if;
end;
$preflight$;

alter table public.truth_shadow_claim_acceptance_epochs
  add column if not exists decision_authority_manifest jsonb not null default '[]'::jsonb,
  add column if not exists decision_authority_manifest_hash text not null default
    '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  add column if not exists epoch_policy_decision_count integer not null default 0,
  add column if not exists adopted_review_decision_count integer not null default 0;

alter table public.truth_shadow_claim_acceptance_epochs
  alter column decision_authority_manifest_hash set default
    '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

alter table public.truth_shadow_claim_acceptance_epoch_items
  add column if not exists decision_authority_kind text not null default
    'truth_shadow_acceptance_epoch',
  add column if not exists review_resolution_id text,
  add column if not exists review_request_hash text not null default '',
  add column if not exists review_receipt_hash text not null default '',
  add column if not exists decision_authored_at timestamptz,
  add column if not exists review_resolved_at timestamptz;

create unique index if not exists truth_review_resolutions_workspace_identity_uidx
  on public.truth_review_resolutions(workspace_key, review_resolution_id);

do $constraints$
begin
  alter table public.truth_shadow_claim_acceptance_epochs
    drop constraint if exists truth_shadow_claim_acceptance_epochs_schema_version_check;
  alter table public.truth_shadow_claim_acceptance_epoch_items
    drop constraint if exists truth_shadow_claim_acceptance_epoch_items_schema_version_check;

  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epochs'::regclass
      and constraint_row.conname =
        'truth_shadow_claim_acceptance_epochs_schema_version_v2_check'
  ) then
    alter table public.truth_shadow_claim_acceptance_epochs
      add constraint truth_shadow_claim_acceptance_epochs_schema_version_v2_check
      check (schema_version = any(array[
        'truth-shadow-claim-acceptance-epoch-v1',
        'truth-shadow-claim-acceptance-epoch-v2'
      ]));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epochs'::regclass
      and constraint_row.conname =
        'truth_shadow_claim_acceptance_epochs_authority_v2_check'
  ) then
    alter table public.truth_shadow_claim_acceptance_epochs
      add constraint truth_shadow_claim_acceptance_epochs_authority_v2_check
      check (
        jsonb_typeof(decision_authority_manifest) = 'array'
        and decision_authority_manifest_hash ~ '^[0-9a-f]{64}$'
        and decision_authority_manifest_hash = encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(decision_authority_manifest), 'UTF8'
        ), 'sha256'), 'hex')
        and epoch_policy_decision_count >= 0
        and adopted_review_decision_count >= 0
        and (
          schema_version = 'truth-shadow-claim-acceptance-epoch-v1'
          or (
            epoch_policy_decision_count + adopted_review_decision_count = candidate_count
            and jsonb_array_length(decision_authority_manifest) = candidate_count
          )
        )
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epoch_items'::regclass
      and constraint_row.conname =
        'truth_shadow_claim_acceptance_epoch_items_schema_version_v2_check'
  ) then
    alter table public.truth_shadow_claim_acceptance_epoch_items
      add constraint truth_shadow_claim_acceptance_epoch_items_schema_version_v2_check
      check (schema_version = any(array[
        'truth-shadow-claim-acceptance-epoch-item-v1',
        'truth-shadow-claim-acceptance-epoch-item-v2'
      ]));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epoch_items'::regclass
      and constraint_row.conname =
        'truth_shadow_claim_acceptance_epoch_items_authority_v2_check'
  ) then
    alter table public.truth_shadow_claim_acceptance_epoch_items
      add constraint truth_shadow_claim_acceptance_epoch_items_authority_v2_check
      check (
        decision_authority_kind = any(array[
          'truth_shadow_acceptance_epoch', 'truth_review_resolution'
        ])
        and (
          schema_version = 'truth-shadow-claim-acceptance-epoch-item-v1'
          or decision_authored_at is not null
        )
        and (
          (decision_authority_kind = 'truth_shadow_acceptance_epoch'
            and review_resolution_id is null
            and review_request_hash = ''
            and review_receipt_hash = ''
            and review_resolved_at is null)
          or
          (decision_authority_kind = 'truth_review_resolution'
            and review_resolution_id is not null
            and review_request_hash ~ '^[0-9a-f]{64}$'
            and review_receipt_hash ~ '^[0-9a-f]{64}$'
            and review_resolved_at is not null
            and decision_authored_at <= review_resolved_at)
        )
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epoch_items'::regclass
      and constraint_row.conname =
        'truth_shadow_claim_acceptance_epoch_items_review_resolution_fkey'
  ) then
    alter table public.truth_shadow_claim_acceptance_epoch_items
      add constraint truth_shadow_claim_acceptance_epoch_items_review_resolution_fkey
      foreign key (workspace_key, review_resolution_id)
      references public.truth_review_resolutions(workspace_key, review_resolution_id)
      on update restrict on delete restrict;
  end if;
end;
$constraints$;

create unique index if not exists truth_shadow_acceptance_item_review_resolution_uidx
  on public.truth_shadow_claim_acceptance_epoch_items(review_resolution_id)
  where review_resolution_id is not null;

create or replace function private.truth_shadow_review_decision_adoption_v1(
  p_workspace_key text,
  p_obligation_id text,
  p_source_job_id uuid,
  p_candidate_claim_version_id text,
  p_candidate_item_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.candidate_claim_envelopes%rowtype;
  v_decision public.candidate_claim_decisions%rowtype;
  v_resolution public.truth_review_resolutions%rowtype;
  v_binding public.candidate_claim_acceptance_bindings%rowtype;
  v_claim public.accepted_claims%rowtype;
  v_envelope public.accepted_claim_envelopes%rowtype;
  v_expected_request jsonb;
  v_expected_receipt jsonb;
  v_expected_binding jsonb;
  v_authority jsonb;
  v_authority_hash text;
  v_decision_count integer;
begin
  if not exists (
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = membership.workspace_key
     and manifest.job_id = membership.source_job_id
    join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      on true
    join public.candidate_claim_job_lineage lineage
      on lineage.job_id = membership.source_job_id
     and lineage.candidate_claim_version_id = item->>'candidateClaimVersionId'
     and lineage.source_observation_id = membership.source_observation_id
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
      and membership.source_job_id = p_source_job_id
      and item->>'candidateClaimVersionId' = p_candidate_claim_version_id
      and item->>'itemHash' = p_candidate_item_hash
  ) then
    raise exception 'review decision adoption target is outside the sealed frontier'
      using errcode = '23514';
  end if;

  select * into v_candidate
  from public.candidate_claim_envelopes candidate
  where candidate.workspace_key = p_workspace_key
    and candidate.candidate_claim_version_id = p_candidate_claim_version_id
    and candidate.envelope_hash = p_candidate_item_hash;
  if not found then
    raise exception 'review decision adoption candidate is unavailable'
      using errcode = '23503';
  end if;

  select * into v_decision
  from public.candidate_claim_decisions decision_row
  where decision_row.candidate_claim_version_id = p_candidate_claim_version_id
  order by decision_row.decision_no desc
  limit 1;
  if not found then
    return jsonb_build_object(
      'status', 'absent',
      'decisionAuthorityKind', 'truth_shadow_acceptance_epoch'
    );
  end if;

  select count(*)::integer into v_decision_count
  from public.candidate_claim_decisions decision_row
  where decision_row.candidate_claim_version_id = p_candidate_claim_version_id;
  if v_decision_count <> v_decision.decision_no
    or v_decision.decision_no < 1
    or exists (
      select 1
      from public.candidate_claim_decisions current_decision
      where current_decision.candidate_claim_version_id = p_candidate_claim_version_id
        and (
          (current_decision.decision_no = 1
            and current_decision.previous_decision_version_id is not null)
          or
          (current_decision.decision_no > 1 and not exists (
            select 1
            from public.candidate_claim_decisions prior_decision
            where prior_decision.candidate_claim_version_id = p_candidate_claim_version_id
              and prior_decision.decision_no = current_decision.decision_no - 1
              and prior_decision.decision_version_id =
                current_decision.previous_decision_version_id
          ))
        )
    )
    or exists (
      select 1
      from public.candidate_claim_decisions prior_decision
      where prior_decision.candidate_claim_version_id =
        p_candidate_claim_version_id
        and prior_decision.decision_no < v_decision.decision_no
        and prior_decision.decision <> 'review'
    )
    or v_decision.decision <> all(array['accept', 'reject'])
    or v_decision.decision_method <> 'operator'
    or v_decision.policy_version <> 'truth-shadow-model-commissioning-review-v1'
    or v_decision.decision_schema_version <> 'candidate-claim-decision-v1'
    or v_decision.decision_hash is distinct from encode(extensions.digest(
      convert_to(v_decision.canonical_decision::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_decision.decision_version_id is distinct from
      'candidate-decision:v1:' || v_decision.decision_hash
    or v_decision.canonical_decision is distinct from jsonb_build_object(
      'decisionSchemaVersion', 'candidate-claim-decision-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', p_candidate_claim_version_id,
      'candidateItemHash', p_candidate_item_hash,
      'decision', jsonb_build_object(
        'decisionNo', v_decision.decision_no,
        'previousDecisionVersionId',
          coalesce(v_decision.previous_decision_version_id, ''),
        'decision', v_decision.decision,
        'method', v_decision.decision_method,
        'policyVersion', v_decision.policy_version,
        'decidedBy', v_decision.decided_by,
        'reasons', v_decision.reasons,
        'acceptedClaimRequest', v_decision.accepted_claim_request
      )
    ) then
    raise exception 'frontier candidate has an unadoptable decision authority'
      using errcode = '55000';
  end if;

  select * into v_resolution
  from public.truth_review_resolutions resolution
  where resolution.workspace_key = p_workspace_key
    and resolution.target_kind = 'candidate_claim'
    and resolution.target_id = p_candidate_claim_version_id;
  if not found
    or v_resolution.target_item_hash is distinct from p_candidate_item_hash
    or v_resolution.decision is distinct from v_decision.decision
    or v_resolution.decision_version_id is distinct from v_decision.decision_version_id
    or v_resolution.decision_item_hash is distinct from v_decision.decision_hash
    or v_resolution.request_schema_version <> 'truth-review-resolution-v1'
    or v_resolution.request_hash is distinct from encode(extensions.digest(
      convert_to(v_resolution.canonical_request::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_resolution.receipt_hash is distinct from encode(extensions.digest(
      convert_to(v_resolution.canonical_receipt::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_resolution.review_resolution_id is distinct from
      'review-resolution:v1:' || v_resolution.request_hash
    or jsonb_array_length(v_decision.reasons) <> 1 then
    raise exception 'frontier decision lacks its exact immutable review resolution'
      using errcode = '55000';
  end if;

  v_expected_request := jsonb_build_object(
    'requestSchemaVersion', 'truth-review-resolution-v1',
    'workspaceKey', p_workspace_key,
    'idempotencyKeyHash', v_resolution.idempotency_key_hash,
    'targetKind', 'candidate_claim',
    'targetId', p_candidate_claim_version_id,
    'expectedTargetHash', p_candidate_item_hash,
    'expectedPreviousDecisionVersionId',
      coalesce(v_decision.previous_decision_version_id, ''),
    'decision', v_decision.decision,
    'policyVersion', v_decision.policy_version,
    'decidedBy', v_decision.decided_by,
    'reason', v_decision.reasons->>0
  );
  v_expected_receipt := jsonb_build_object(
    'ok', true,
    'reviewResolutionId', v_resolution.review_resolution_id,
    'targetKind', 'candidate_claim',
    'targetId', p_candidate_claim_version_id,
    'targetItemHash', p_candidate_item_hash,
    'decision', v_decision.decision,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'acceptedKind', v_resolution.accepted_kind,
    'acceptedItemId', v_resolution.accepted_item_id,
    'acceptedItemHash', v_resolution.accepted_item_hash,
    'bindingId', v_resolution.binding_id,
    'bindingItemHash', v_resolution.binding_item_hash,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );
  if v_resolution.canonical_request is distinct from v_expected_request
    or v_resolution.canonical_receipt is distinct from v_expected_receipt then
    raise exception 'frontier review resolution canonical provenance is invalid'
      using errcode = '23514';
  end if;

  if v_decision.decision = 'accept' then
    select * into v_binding
    from public.candidate_claim_acceptance_bindings binding
    where binding.candidate_claim_version_id = p_candidate_claim_version_id
      and binding.decision_version_id = v_decision.decision_version_id
      and binding.binding_id = v_resolution.binding_id
      and binding.binding_hash = v_resolution.binding_item_hash
      and binding.accepted_claim_version_id = v_resolution.accepted_item_id;
    select * into v_claim
    from public.accepted_claims claim
    where claim.claim_version_id = v_resolution.accepted_item_id;
    select * into v_envelope
    from public.accepted_claim_envelopes envelope
    where envelope.workspace_key = p_workspace_key
      and envelope.claim_version_id = v_resolution.accepted_item_id;
    v_expected_binding := jsonb_build_object(
      'bindingSchemaVersion', 'candidate-claim-acceptance-binding-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', p_candidate_claim_version_id,
      'candidateItemHash', p_candidate_item_hash,
      'decisionVersionId', v_decision.decision_version_id,
      'decisionItemHash', v_decision.decision_hash,
      'acceptedClaimVersionId', v_resolution.accepted_item_id,
      'acceptedClaimItemHash', v_resolution.accepted_item_hash
    );
    if v_resolution.accepted_kind <> 'accepted_claim'
      or v_decision.accepted_claim_request is null
      or v_binding.binding_id is null
      or v_binding.binding_schema_version <> 'candidate-claim-acceptance-binding-v1'
      or v_binding.binding_hash is distinct from encode(extensions.digest(
        convert_to(v_binding.canonical_binding::text, 'UTF8'), 'sha256'
      ), 'hex')
      or v_binding.binding_id is distinct from
        'candidate-acceptance:v1:' || v_binding.binding_hash
      or v_binding.canonical_binding is distinct from v_expected_binding
      or v_claim.claim_version_id is null
      or v_envelope.claim_version_id is null
      or v_claim.claim_content_hash is distinct from v_resolution.accepted_item_hash
      or v_envelope.envelope_hash is distinct from v_resolution.accepted_item_hash
      or private.authoritative_truth_input_hash(
        'accepted_claim', v_claim.claim_version_id
      ) is distinct from v_resolution.accepted_item_hash
      or v_claim.claim_key is distinct from
        v_decision.accepted_claim_request->'claim'->>'claimKey'
      or v_claim.version_no is distinct from
        (v_decision.accepted_claim_request->'claim'->>'versionNo')::integer
      or coalesce(v_claim.previous_claim_version_id, '') is distinct from coalesce(
        v_decision.accepted_claim_request->'claim'->>'previousClaimVersionId', ''
      )
      or v_claim.primary_observation_id is distinct from v_candidate.source_observation_id
      or v_claim.subject_type is distinct from
        v_decision.accepted_claim_request->'claim'->>'subjectType'
      or v_claim.subject_key is distinct from
        v_decision.accepted_claim_request->'claim'->>'subjectKey'
      or v_claim.predicate is distinct from
        v_decision.accepted_claim_request->'claim'->>'predicate'
      or v_claim.gate is distinct from
        v_decision.accepted_claim_request->'claim'->>'gate'
      or v_claim.polarity is distinct from
        v_decision.accepted_claim_request->'claim'->>'polarity'
      or v_claim.normalized_value is distinct from
        v_decision.accepted_claim_request->'claim'->'normalizedValue'
      or v_claim.confidence is distinct from
        (v_decision.accepted_claim_request->'claim'->>'confidence')::numeric
      or v_claim.confidence_label is distinct from
        v_decision.accepted_claim_request->'claim'->>'confidenceLabel'
      or v_claim.extraction_method is distinct from
        v_decision.accepted_claim_request->'claim'->>'extractionMethod'
      or v_claim.extractor_version is distinct from
        v_decision.accepted_claim_request->'claim'->>'extractorVersion'
      or v_claim.prompt_version is distinct from
        v_decision.accepted_claim_request->'claim'->>'promptVersion'
      or v_claim.model is distinct from
        v_decision.accepted_claim_request->'claim'->>'model'
      or v_claim.acceptance_method is distinct from v_decision.decision_method
      or v_claim.acceptance_policy_version is distinct from v_decision.policy_version
      or v_claim.accepted_by is distinct from v_decision.decided_by
      or v_claim.decision <> 'accepted'
      or v_claim.evidence_span is distinct from
        v_decision.accepted_claim_request->'claim'->'evidenceSpan'
      or v_claim.schema_version is distinct from
        v_decision.accepted_claim_request->'claim'->>'schemaVersion'
      or (
        select count(*)
        from public.accepted_claim_evidence evidence
        where evidence.claim_version_id = v_claim.claim_version_id
          and evidence.observation_id = v_candidate.source_observation_id
          and evidence.evidence_role = 'primary'
          and evidence.evidence_span =
            v_decision.accepted_claim_request->'claim'->'evidenceSpan'
      ) <> 1
      or (
        select count(*)
        from public.accepted_claim_evidence evidence
        where evidence.claim_version_id = v_claim.claim_version_id
      ) <> 1
      or (
        select count(*)
        from public.claim_supersessions supersession
        where supersession.resolving_claim_version_id = v_claim.claim_version_id
      ) <> jsonb_array_length(
        v_decision.accepted_claim_request->'supersessions'
      )
      or exists (
        select 1
        from jsonb_array_elements(
          v_decision.accepted_claim_request->'supersessions'
        ) expected
        left join public.claim_supersessions actual
          on actual.resolving_claim_version_id = v_claim.claim_version_id
         and actual.superseded_claim_version_id =
           expected->>'supersededClaimVersionId'
         and actual.relationship = expected->>'relationship'
         and actual.policy_version = expected->>'policyVersion'
        where actual.resolving_claim_version_id is null
      ) then
      raise exception 'adopted review acceptance binding is not exact'
        using errcode = '23514';
    end if;
  else
    if v_decision.accepted_claim_request is not null
      or v_resolution.accepted_kind <> ''
      or v_resolution.accepted_item_id <> ''
      or v_resolution.accepted_item_hash <> ''
      or v_resolution.binding_id <> ''
      or v_resolution.binding_item_hash <> ''
      or exists (
        select 1 from public.candidate_claim_acceptance_bindings binding
        where binding.candidate_claim_version_id = p_candidate_claim_version_id
          or binding.decision_version_id = v_decision.decision_version_id
      ) then
      raise exception 'adopted review rejection has acceptance artifacts'
        using errcode = '23514';
    end if;
  end if;

  if exists (
    select 1
    from public.truth_shadow_claim_acceptance_epoch_items item
    where item.candidate_claim_version_id = p_candidate_claim_version_id
      or (
        v_resolution.accepted_item_id <> ''
        and item.accepted_claim_version_id = v_resolution.accepted_item_id
      )
  ) then
    raise exception 'review decision is already certified by an acceptance epoch'
      using errcode = '23505';
  end if;

  v_authority := jsonb_build_object(
    'schemaVersion', 'truth-shadow-review-decision-adoption-v1',
    'workspaceKey', p_workspace_key,
    'obligationId', p_obligation_id,
    'sourceJobId', p_source_job_id,
    'candidateClaimVersionId', p_candidate_claim_version_id,
    'candidateItemHash', p_candidate_item_hash,
    'decisionAuthorityKind', 'truth_review_resolution',
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'decision', v_decision.decision,
    'decisionMethod', v_decision.decision_method,
    'policyVersion', v_decision.policy_version,
    'decidedBy', v_decision.decided_by,
    'reasonCodes', v_decision.reasons,
    'decisionAuthoredAt', private.canonical_truth_timestamp(v_decision.created_at),
    'reviewResolutionId', v_resolution.review_resolution_id,
    'reviewRequestHash', v_resolution.request_hash,
    'reviewReceiptHash', v_resolution.receipt_hash,
    'reviewResolvedAt', private.canonical_truth_timestamp(v_resolution.created_at),
    'acceptedClaimVersionId', v_resolution.accepted_item_id,
    'acceptedClaimItemHash', v_resolution.accepted_item_hash,
    'bindingId', v_resolution.binding_id,
    'bindingItemHash', v_resolution.binding_item_hash
  );
  v_authority_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_authority), 'UTF8'
  ), 'sha256'), 'hex');
  return jsonb_build_object(
    'status', 'adopted',
    'decisionAuthorityKind', 'truth_review_resolution',
    'authority', v_authority,
    'authorityHash', v_authority_hash,
    'decision', v_decision.decision,
    'reasonCodes', v_decision.reasons,
    'decisionVersionId', v_decision.decision_version_id,
    'decisionItemHash', v_decision.decision_hash,
    'decisionAuthoredAt', private.canonical_truth_timestamp(v_decision.created_at),
    'reviewResolutionId', v_resolution.review_resolution_id,
    'reviewRequestHash', v_resolution.request_hash,
    'reviewReceiptHash', v_resolution.receipt_hash,
    'reviewResolvedAt', private.canonical_truth_timestamp(v_resolution.created_at),
    'acceptedClaimVersionId', v_resolution.accepted_item_id,
    'acceptedClaimItemHash', v_resolution.accepted_item_hash,
    'acceptedClaimKey', coalesce(v_claim.claim_key, ''),
    'acceptedClaimVersionNo', coalesce(v_claim.version_no, 0),
    'acceptedPreviousClaimVersionId',
      coalesce(v_claim.previous_claim_version_id, ''),
    'bindingId', v_resolution.binding_id,
    'bindingItemHash', v_resolution.binding_item_hash
  );
end;
$function$;

revoke all on function private.truth_shadow_review_decision_adoption_v1(
  text, text, uuid, text, text
) from public, anon, authenticated, service_role;

do $rewrite_declarations$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  v_candidate record;
  v_candidate_body jsonb;$old$;
  v_new text := $new$  v_candidate record;
  v_lock_candidate record;
  v_candidate_body jsonb;
  v_adoption jsonb;
  v_decision_authority_kind text;
  v_authority jsonb;
  v_authority_hash text;
  v_authority_manifest jsonb := '[]'::jsonb;
  v_authority_manifest_hash text;
  v_decision_authored_at timestamptz;
  v_review_resolution_id text;
  v_review_request_hash text;
  v_review_receipt_hash text;
  v_review_resolved_at timestamptz;
  v_accepted_claim_key text;$new$;
  v_old_counts text := $old$  v_review_count integer := 0;
  v_ordinal integer := 0;$old$;
  v_new_counts text := $new$  v_review_count integer := 0;
  v_epoch_policy_decision_count integer := 0;
  v_adopted_review_decision_count integer := 0;
  v_ordinal integer := 0;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_adopted_review_decision_count integer := 0;' in v_definition) = 0 then
    if position(v_old in v_definition) = 0
      or position(v_old_counts in v_definition) = 0 then
      raise exception 'shadow acceptance declaration rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    v_definition := replace(v_definition, v_old_counts, v_new_counts);
    execute v_definition;
  end if;
end;
$rewrite_declarations$;

do $rewrite_legacy_guard$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  if exists (
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.candidate_claim_job_lineage lineage
      on lineage.job_id = membership.source_job_id
    join public.candidate_claim_decisions decision_row
      on decision_row.candidate_claim_version_id = lineage.candidate_claim_version_id
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
  ) then
    raise exception 'shadow acceptance frontier already has a legacy decision authority'
      using errcode = '55000';
  end if;$old$;
  v_new text := $new$  -- Review resolution and epoch execution use the same candidate-scoped
  -- serialization key.  Acquire all pre-existing authorities in stable order
  -- before validating any of them, so the 39-candidate snapshot cannot split.
  for v_lock_candidate in
    select distinct candidate.candidate_claim_version_id
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = membership.workspace_key
     and manifest.job_id = membership.source_job_id
    join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      on true
    join public.candidate_claim_envelopes candidate
      on candidate.workspace_key = membership.workspace_key
     and candidate.candidate_claim_version_id = item->>'candidateClaimVersionId'
     and candidate.envelope_hash = item->>'itemHash'
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
      and exists (
        select 1 from public.candidate_claim_decisions decision_row
        where decision_row.candidate_claim_version_id =
          candidate.candidate_claim_version_id
      )
    order by candidate.candidate_claim_version_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'candidate-decision:' || p_workspace_key || ':' ||
        v_lock_candidate.candidate_claim_version_id,
      0
    ));
  end loop;

  -- This is an explicit first-frontier bridge.  A later mixed-authority epoch
  -- requires a separately reviewed continuity contract and must fail closed.
  if exists (
    select 1
    from public.truth_pending_acceptance_epoch_manifests membership
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key = membership.workspace_key
     and manifest.job_id = membership.source_job_id
    join lateral jsonb_array_elements(manifest.canonical_manifest->'candidates') item
      on true
    join public.candidate_claim_decisions decision_row
      on decision_row.candidate_claim_version_id = item->>'candidateClaimVersionId'
    where membership.workspace_key = p_workspace_key
      and membership.obligation_id = p_obligation_id
  ) and exists (
    select 1
    from public.truth_shadow_claim_acceptance_epochs prior_epoch
    where prior_epoch.workspace_key = p_workspace_key
      and prior_epoch.source_system = v_pending.source_system
      and prior_epoch.connection_key = v_pending.connection_key
      and prior_epoch.source_cursor_version < v_pending.source_cursor_version
  ) then
    raise exception 'later shadow acceptance frontier has a mixed decision authority'
      using errcode = '55000';
  end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('later shadow acceptance frontier has a mixed decision authority' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance legacy-authority guard rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_legacy_guard$;

do $rewrite_adoption_load$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    v_shadow_claim_key := 'shadow:v1:' || v_scope_hash || ':' ||
      (v_candidate_body->>'claimKey');
    v_policy_eligible :=$old$;
  v_new text := $new$    v_shadow_claim_key := 'shadow:v1:' || v_scope_hash || ':' ||
      (v_candidate_body->>'claimKey');
    v_adoption := private.truth_shadow_review_decision_adoption_v1(
      p_workspace_key,
      p_obligation_id,
      v_candidate.source_job_id,
      v_candidate.candidate_claim_version_id,
      v_candidate.envelope_hash
    );
    v_decision_authority_kind := v_adoption->>'decisionAuthorityKind';
    v_authority := null;
    v_authority_hash := '';
    v_decision_authored_at := null;
    v_review_resolution_id := null;
    v_review_request_hash := '';
    v_review_receipt_hash := '';
    v_review_resolved_at := null;
    v_accepted_claim_key := '';
    v_policy_eligible :=$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_adoption := private.truth_shadow_review_decision_adoption_v1(' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance adoption-load rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_adoption_load$;

do $rewrite_decision_selection$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    if not v_policy_eligible then
      v_decision := 'review';
      v_reasons := jsonb_build_array('SHADOW_CANDIDATE_V1_POLICY_REVIEW');
    elsif jsonb_typeof(v_prior_head) = 'object'
      and v_prior_head->>'polarity' is not distinct from v_candidate_body->>'polarity'
      and v_prior_head->'normalizedValue' is not distinct from
        v_candidate_body->'normalizedValue' then
      v_decision := 'reject';
      v_reasons := jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT');
    elsif jsonb_typeof(v_prior_head) = 'object'
      and v_chronology_at <= (v_prior_head->>'chronologyAt')::timestamptz then
      v_decision := 'review';
      v_reasons := jsonb_build_array('NON_MONOTONIC_SHADOW_CHRONOLOGY');
    else
      v_decision := 'accept';
      v_reasons := jsonb_build_array('DETERMINISTIC_SHADOW_POLICY_ACCEPT');
    end if;$old$;
  v_new text := $new$    if v_adoption->>'status' = 'adopted' then
      v_decision := v_adoption->>'decision';
      v_reasons := v_adoption->'reasonCodes';
      v_decision_version_id := v_adoption->>'decisionVersionId';
      v_decision_hash := v_adoption->>'decisionItemHash';
      v_decision_authored_at :=
        (v_adoption->>'decisionAuthoredAt')::timestamptz;
      v_review_resolution_id := v_adoption->>'reviewResolutionId';
      v_review_request_hash := v_adoption->>'reviewRequestHash';
      v_review_receipt_hash := v_adoption->>'reviewReceiptHash';
      v_review_resolved_at := (v_adoption->>'reviewResolvedAt')::timestamptz;
      v_authority := v_adoption->'authority';
      v_authority_hash := v_adoption->>'authorityHash';
      v_adopted_review_decision_count :=
        v_adopted_review_decision_count + 1;
    else
      if not v_policy_eligible then
        v_decision := 'review';
        v_reasons := jsonb_build_array('SHADOW_CANDIDATE_V1_POLICY_REVIEW');
      elsif jsonb_typeof(v_prior_head) = 'object'
        and v_prior_head->>'polarity' is not distinct from v_candidate_body->>'polarity'
        and v_prior_head->'normalizedValue' is not distinct from
          v_candidate_body->'normalizedValue' then
        v_decision := 'reject';
        v_reasons := jsonb_build_array('DUPLICATE_CURRENT_SHADOW_FACT');
      elsif jsonb_typeof(v_prior_head) = 'object'
        and v_chronology_at <= (v_prior_head->>'chronologyAt')::timestamptz then
        v_decision := 'review';
        v_reasons := jsonb_build_array('NON_MONOTONIC_SHADOW_CHRONOLOGY');
      else
        v_decision := 'accept';
        v_reasons := jsonb_build_array('DETERMINISTIC_SHADOW_POLICY_ACCEPT');
      end if;
      v_epoch_policy_decision_count := v_epoch_policy_decision_count + 1;
    end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_adopted_review_decision_count :=' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance decision-selection rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_decision_selection$;

do $rewrite_claim_request$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    v_claim_request := null;
    v_claim_receipt := null;
    v_binding := null;
    v_binding_hash := '';
    v_binding_id := null;
    if v_decision = 'accept' then
      v_version_no := case
        when jsonb_typeof(v_prior_head) = 'object'
          then (v_prior_head->>'versionNo')::integer + 1
        else 1
      end;
      v_previous_claim_version_id := case
        when jsonb_typeof(v_prior_head) = 'object'
          then v_prior_head->>'claimVersionId'
        else null
      end;
      v_supersessions := case
        when v_previous_claim_version_id is null then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object(
          'supersededClaimVersionId', v_previous_claim_version_id,
          'relationship', case
            when v_prior_head->>'polarity' is distinct from v_candidate_body->>'polarity'
              then 'contradicts'
            else 'corrects'
          end,
          'policyVersion', v_candidate.recommendation_policy_version
        ))
      end;
      v_claim_request := jsonb_build_object(
        'claim', jsonb_build_object(
          'claimKey', v_shadow_claim_key,
          'versionNo', v_version_no,
          'previousClaimVersionId', v_previous_claim_version_id,
          'primaryObservationId', v_candidate.source_observation_id,
          'subjectType', v_candidate_body->>'subjectType',
          'subjectKey', v_candidate_body->>'subjectKey',
          'predicate', v_candidate_body->>'predicate',
          'gate', v_candidate_body->>'gate',
          'polarity', v_candidate_body->>'polarity',
          'normalizedValue', v_candidate_body->'normalizedValue',
          'occurredAt', v_candidate_body->'occurredAt',
          'confidence', v_candidate_body->'confidence',
          'confidenceLabel', v_candidate_body->>'confidenceLabel',
          'extractionMethod', v_candidate_body->>'extractionMethod',
          'extractorVersion', v_candidate_body->>'extractorVersion',
          'promptVersion', coalesce(v_candidate_body->>'promptVersion', ''),
          'model', coalesce(v_candidate_body->>'model', ''),
          'acceptanceMethod', 'policy',
          'acceptancePolicyVersion', v_candidate.recommendation_policy_version,
          'acceptedBy', 'truth-shadow-acceptance-epoch-v1',
          'decision', 'accepted',
          'evidenceSpan', v_candidate_body->'evidenceSpan',
          'recordedAt', private.canonical_truth_timestamp(v_chronology_at),
          'schemaVersion', 'candidate-accepted-claim-v1'
        ),
        'evidence', jsonb_build_array(jsonb_build_object(
          'observationId', v_candidate.source_observation_id,
          'evidenceRole', 'primary',
          'evidenceSpan', v_candidate_body->'evidenceSpan'
        )),
        'supersessions', v_supersessions
      );
    end if;$old$;
  v_new text := $new$    v_claim_request := null;
    v_claim_receipt := null;
    v_binding := null;
    v_binding_hash := '';
    v_binding_id := null;
    if v_adoption->>'status' = 'adopted' then
      if v_decision = 'accept' then
        v_claim_receipt := jsonb_build_object(
          'claimVersionId', v_adoption->>'acceptedClaimVersionId',
          'itemHash', v_adoption->>'acceptedClaimItemHash'
        );
        v_binding_id := v_adoption->>'bindingId';
        v_binding_hash := v_adoption->>'bindingItemHash';
        v_accepted_claim_key := v_adoption->>'acceptedClaimKey';
        v_version_no := (v_adoption->>'acceptedClaimVersionNo')::integer;
        if jsonb_typeof(v_prior_head) = 'object'
          and coalesce(
            v_prior_head->>'acceptedClaimKey',
            v_prior_head->>'shadowClaimKey'
          ) = v_accepted_claim_key
          and (
            v_version_no <> (v_prior_head->>'versionNo')::integer + 1
            or v_adoption->>'acceptedPreviousClaimVersionId' is distinct from
              v_prior_head->>'claimVersionId'
          ) then
          raise exception 'adopted review claim chronology differs from the frontier head'
            using errcode = '23514';
        end if;
      end if;
    elsif v_decision = 'accept' then
      -- The review authority used the original candidate claim key.  A later
      -- epoch fact starts the namespaced shadow chain at version one and links
      -- across authorities through an explicit supersession, never through an
      -- invalid cross-key predecessor.
      v_version_no := case
        when jsonb_typeof(v_prior_head) = 'object'
          and coalesce(
            v_prior_head->>'acceptedClaimKey',
            v_prior_head->>'shadowClaimKey'
          ) = v_shadow_claim_key
          then (v_prior_head->>'versionNo')::integer + 1
        else 1
      end;
      v_previous_claim_version_id := case
        when jsonb_typeof(v_prior_head) = 'object'
          and coalesce(
            v_prior_head->>'acceptedClaimKey',
            v_prior_head->>'shadowClaimKey'
          ) = v_shadow_claim_key
          then v_prior_head->>'claimVersionId'
        else null
      end;
      v_supersessions := case
        when jsonb_typeof(v_prior_head) <> 'object' then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object(
          'supersededClaimVersionId', v_prior_head->>'claimVersionId',
          'relationship', case
            when v_prior_head->>'polarity' is distinct from v_candidate_body->>'polarity'
              then 'contradicts'
            else 'corrects'
          end,
          'policyVersion', v_candidate.recommendation_policy_version
        ))
      end;
      v_claim_request := jsonb_build_object(
        'claim', jsonb_build_object(
          'claimKey', v_shadow_claim_key,
          'versionNo', v_version_no,
          'previousClaimVersionId', v_previous_claim_version_id,
          'primaryObservationId', v_candidate.source_observation_id,
          'subjectType', v_candidate_body->>'subjectType',
          'subjectKey', v_candidate_body->>'subjectKey',
          'predicate', v_candidate_body->>'predicate',
          'gate', v_candidate_body->>'gate',
          'polarity', v_candidate_body->>'polarity',
          'normalizedValue', v_candidate_body->'normalizedValue',
          'occurredAt', v_candidate_body->'occurredAt',
          'confidence', v_candidate_body->'confidence',
          'confidenceLabel', v_candidate_body->>'confidenceLabel',
          'extractionMethod', v_candidate_body->>'extractionMethod',
          'extractorVersion', v_candidate_body->>'extractorVersion',
          'promptVersion', coalesce(v_candidate_body->>'promptVersion', ''),
          'model', coalesce(v_candidate_body->>'model', ''),
          'acceptanceMethod', 'policy',
          'acceptancePolicyVersion', v_candidate.recommendation_policy_version,
          'acceptedBy', 'truth-shadow-acceptance-epoch-v1',
          'decision', 'accepted',
          'evidenceSpan', v_candidate_body->'evidenceSpan',
          'recordedAt', private.canonical_truth_timestamp(v_chronology_at),
          'schemaVersion', 'candidate-accepted-claim-v1'
        ),
        'evidence', jsonb_build_array(jsonb_build_object(
          'observationId', v_candidate.source_observation_id,
          'evidenceRole', 'primary',
          'evidenceSpan', v_candidate_body->'evidenceSpan'
        )),
        'supersessions', v_supersessions
      );
    end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('The review authority used the original candidate claim key.' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance claim-request rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_claim_request$;

do $rewrite_decision_materialization$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    v_canonical_decision := jsonb_build_object(
      'decisionSchemaVersion', 'candidate-claim-decision-v1',
      'workspaceKey', p_workspace_key,
      'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
      'candidateItemHash', v_candidate.envelope_hash,
      'decision', jsonb_build_object(
        'decisionNo', 1,
        'previousDecisionVersionId', '',
        'decision', v_decision,
        'method', 'policy',
        'policyVersion', v_candidate.recommendation_policy_version,
        'decidedBy', 'truth-shadow-acceptance-epoch-v1',
        'reasons', v_reasons,
        'acceptedClaimRequest', v_claim_request
      )
    );
    v_decision_hash := encode(extensions.digest(convert_to(
      v_canonical_decision::text, 'UTF8'
    ), 'sha256'), 'hex');
    v_decision_version_id := 'candidate-decision:v1:' || v_decision_hash;
    insert into public.candidate_claim_decisions (
      decision_version_id, candidate_claim_version_id, decision_no,
      previous_decision_version_id, decision, decision_method, policy_version,
      decided_by, reasons, accepted_claim_request, decision_hash,
      decision_schema_version, canonical_decision
    ) values (
      v_decision_version_id, v_candidate.candidate_claim_version_id, 1,
      null, v_decision, 'policy', v_candidate.recommendation_policy_version,
      'truth-shadow-acceptance-epoch-v1', v_reasons, v_claim_request,
      v_decision_hash, 'candidate-claim-decision-v1', v_canonical_decision
    );

    if v_decision = 'accept' then
      v_claim_receipt := private.append_accepted_claim_source_chronology(
        p_workspace_key,
        v_claim_request->'claim',
        v_claim_request->'evidence',
        v_claim_request->'supersessions',
        p_sync_token
      );
      v_binding := jsonb_build_object(
        'bindingSchemaVersion', 'candidate-claim-acceptance-binding-v1',
        'workspaceKey', p_workspace_key,
        'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
        'candidateItemHash', v_candidate.envelope_hash,
        'decisionVersionId', v_decision_version_id,
        'decisionItemHash', v_decision_hash,
        'acceptedClaimVersionId', v_claim_receipt->>'claimVersionId',
        'acceptedClaimItemHash', v_claim_receipt->>'itemHash'
      );
      v_binding_hash := encode(extensions.digest(convert_to(
        v_binding::text, 'UTF8'
      ), 'sha256'), 'hex');
      v_binding_id := 'candidate-acceptance:v1:' || v_binding_hash;
      insert into public.candidate_claim_acceptance_bindings (
        binding_id, candidate_claim_version_id, decision_version_id,
        accepted_claim_version_id, binding_hash, binding_schema_version,
        canonical_binding
      ) values (
        v_binding_id, v_candidate.candidate_claim_version_id,
        v_decision_version_id, v_claim_receipt->>'claimVersionId',
        v_binding_hash, 'candidate-claim-acceptance-binding-v1', v_binding
      );
      v_accepted_count := v_accepted_count + 1;
    elsif v_decision = 'reject' then
      v_rejected_count := v_rejected_count + 1;
    else
      v_review_count := v_review_count + 1;
    end if;$old$;
  v_new text := $new$    if v_adoption->>'status' <> 'adopted' then
      v_canonical_decision := jsonb_build_object(
        'decisionSchemaVersion', 'candidate-claim-decision-v1',
        'workspaceKey', p_workspace_key,
        'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
        'candidateItemHash', v_candidate.envelope_hash,
        'decision', jsonb_build_object(
          'decisionNo', 1,
          'previousDecisionVersionId', '',
          'decision', v_decision,
          'method', 'policy',
          'policyVersion', v_candidate.recommendation_policy_version,
          'decidedBy', 'truth-shadow-acceptance-epoch-v1',
          'reasons', v_reasons,
          'acceptedClaimRequest', v_claim_request
        )
      );
      v_decision_hash := encode(extensions.digest(convert_to(
        v_canonical_decision::text, 'UTF8'
      ), 'sha256'), 'hex');
      v_decision_version_id := 'candidate-decision:v1:' || v_decision_hash;
      insert into public.candidate_claim_decisions (
        decision_version_id, candidate_claim_version_id, decision_no,
        previous_decision_version_id, decision, decision_method, policy_version,
        decided_by, reasons, accepted_claim_request, decision_hash,
        decision_schema_version, canonical_decision
      ) values (
        v_decision_version_id, v_candidate.candidate_claim_version_id, 1,
        null, v_decision, 'policy', v_candidate.recommendation_policy_version,
        'truth-shadow-acceptance-epoch-v1', v_reasons, v_claim_request,
        v_decision_hash, 'candidate-claim-decision-v1', v_canonical_decision
      ) returning created_at into v_decision_authored_at;

      if v_decision = 'accept' then
        v_claim_receipt := private.append_accepted_claim_source_chronology(
          p_workspace_key,
          v_claim_request->'claim',
          v_claim_request->'evidence',
          v_claim_request->'supersessions',
          p_sync_token
        );
        v_binding := jsonb_build_object(
          'bindingSchemaVersion', 'candidate-claim-acceptance-binding-v1',
          'workspaceKey', p_workspace_key,
          'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
          'candidateItemHash', v_candidate.envelope_hash,
          'decisionVersionId', v_decision_version_id,
          'decisionItemHash', v_decision_hash,
          'acceptedClaimVersionId', v_claim_receipt->>'claimVersionId',
          'acceptedClaimItemHash', v_claim_receipt->>'itemHash'
        );
        v_binding_hash := encode(extensions.digest(convert_to(
          v_binding::text, 'UTF8'
        ), 'sha256'), 'hex');
        v_binding_id := 'candidate-acceptance:v1:' || v_binding_hash;
        insert into public.candidate_claim_acceptance_bindings (
          binding_id, candidate_claim_version_id, decision_version_id,
          accepted_claim_version_id, binding_hash, binding_schema_version,
          canonical_binding
        ) values (
          v_binding_id, v_candidate.candidate_claim_version_id,
          v_decision_version_id, v_claim_receipt->>'claimVersionId',
          v_binding_hash, 'candidate-claim-acceptance-binding-v1', v_binding
        );
        v_accepted_claim_key := v_shadow_claim_key;
      end if;
      v_authority := jsonb_build_object(
        'schemaVersion', 'truth-shadow-epoch-policy-decision-authority-v1',
        'workspaceKey', p_workspace_key,
        'obligationId', p_obligation_id,
        'sourceJobId', v_candidate.source_job_id,
        'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
        'candidateItemHash', v_candidate.envelope_hash,
        'decisionAuthorityKind', 'truth_shadow_acceptance_epoch',
        'decisionVersionId', v_decision_version_id,
        'decisionItemHash', v_decision_hash,
        'decision', v_decision,
        'decisionMethod', 'policy',
        'policyVersion', v_candidate.recommendation_policy_version,
        'decidedBy', 'truth-shadow-acceptance-epoch-v1',
        'reasonCodes', v_reasons,
        'decisionAuthoredAt',
          private.canonical_truth_timestamp(v_decision_authored_at),
        'reviewResolutionId', '',
        'reviewRequestHash', '',
        'reviewReceiptHash', '',
        'reviewResolvedAt', '',
        'acceptedClaimVersionId',
          coalesce(v_claim_receipt->>'claimVersionId', ''),
        'acceptedClaimItemHash', coalesce(v_claim_receipt->>'itemHash', ''),
        'bindingId', coalesce(v_binding_id, ''),
        'bindingItemHash', coalesce(v_binding_hash, '')
      );
      v_authority_hash := encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_authority), 'UTF8'
      ), 'sha256'), 'hex');
    end if;

    if v_decision = 'accept' then
      v_accepted_count := v_accepted_count + 1;
    elsif v_decision = 'reject' then
      v_rejected_count := v_rejected_count + 1;
    else
      v_review_count := v_review_count + 1;
    end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth-shadow-epoch-policy-decision-authority-v1' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance decision materialization rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_decision_materialization$;

do $rewrite_epoch_item$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    v_canonical_item := jsonb_build_object(
      'schemaVersion', 'truth-shadow-claim-acceptance-epoch-item-v1',
      'workspaceKey', p_workspace_key,
      'obligationId', p_obligation_id,
      'ordinal', v_ordinal,
      'sourceJobId', v_candidate.source_job_id,
      'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
      'candidateItemHash', v_candidate.envelope_hash,
      'originalClaimKey', v_candidate_body->>'claimKey',
      'shadowClaimKey', v_shadow_claim_key,
      'chronologyAt', private.canonical_truth_timestamp(v_chronology_at),
      'decision', v_decision,
      'reasonCodes', v_reasons,
      'decisionVersionId', v_decision_version_id,
      'decisionItemHash', v_decision_hash,
      'acceptedClaimVersionId', coalesce(v_claim_receipt->>'claimVersionId', ''),
      'acceptedClaimItemHash', coalesce(v_claim_receipt->>'itemHash', ''),
      'bindingId', coalesce(v_binding_id, ''),
      'bindingItemHash', coalesce(v_binding_hash, '')
    );
    v_item_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical_item), 'UTF8'
    ), 'sha256'), 'hex');
    v_item_id := 'truth-shadow-acceptance-item:v1:' || v_item_hash;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id,
      'itemHash', v_item_hash,
      'canonicalItem', v_canonical_item
    ));
    if v_decision = 'accept' then
      v_heads := jsonb_set(v_heads, array[v_candidate_body->>'claimKey'], jsonb_build_object(
        'originalClaimKey', v_candidate_body->>'claimKey',
        'shadowClaimKey', v_shadow_claim_key,
        'claimVersionId', v_claim_receipt->>'claimVersionId',
        'claimItemHash', v_claim_receipt->>'itemHash',
        'versionNo', v_version_no,
        'polarity', v_candidate_body->>'polarity',
        'normalizedValue', v_candidate_body->'normalizedValue',
        'chronologyAt', private.canonical_truth_timestamp(v_chronology_at),
        'epochItemId', v_item_id,
        'epochItemHash', v_item_hash
      ), true);
    end if;$old$;
  v_new text := $new$    v_canonical_item := jsonb_build_object(
      'schemaVersion', 'truth-shadow-claim-acceptance-epoch-item-v2',
      'workspaceKey', p_workspace_key,
      'obligationId', p_obligation_id,
      'ordinal', v_ordinal,
      'sourceJobId', v_candidate.source_job_id,
      'candidateClaimVersionId', v_candidate.candidate_claim_version_id,
      'candidateItemHash', v_candidate.envelope_hash,
      'originalClaimKey', v_candidate_body->>'claimKey',
      'shadowClaimKey', v_shadow_claim_key,
      'acceptedClaimKey', v_accepted_claim_key,
      'chronologyAt', private.canonical_truth_timestamp(v_chronology_at),
      'decision', v_decision,
      'reasonCodes', v_reasons,
      'decisionAuthorityKind', v_decision_authority_kind,
      'decisionAuthority', v_authority,
      'decisionAuthorityHash', v_authority_hash,
      'decisionVersionId', v_decision_version_id,
      'decisionItemHash', v_decision_hash,
      'decisionAuthoredAt',
        private.canonical_truth_timestamp(v_decision_authored_at),
      'reviewResolutionId', coalesce(v_review_resolution_id, ''),
      'reviewRequestHash', v_review_request_hash,
      'reviewReceiptHash', v_review_receipt_hash,
      'reviewResolvedAt', coalesce(
        private.canonical_truth_timestamp(v_review_resolved_at), ''
      ),
      'acceptedClaimVersionId', coalesce(v_claim_receipt->>'claimVersionId', ''),
      'acceptedClaimItemHash', coalesce(v_claim_receipt->>'itemHash', ''),
      'bindingId', coalesce(v_binding_id, ''),
      'bindingItemHash', coalesce(v_binding_hash, '')
    );
    v_item_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical_item), 'UTF8'
    ), 'sha256'), 'hex');
    v_item_id := 'truth-shadow-acceptance-item:v1:' || v_item_hash;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id,
      'itemHash', v_item_hash,
      'canonicalItem', v_canonical_item
    ));
    if v_decision = 'accept' then
      v_heads := jsonb_set(v_heads, array[v_candidate_body->>'claimKey'], jsonb_build_object(
        'originalClaimKey', v_candidate_body->>'claimKey',
        'shadowClaimKey', v_shadow_claim_key,
        'acceptedClaimKey', v_accepted_claim_key,
        'claimVersionId', v_claim_receipt->>'claimVersionId',
        'claimItemHash', v_claim_receipt->>'itemHash',
        'versionNo', v_version_no,
        'polarity', v_candidate_body->>'polarity',
        'normalizedValue', v_candidate_body->'normalizedValue',
        'chronologyAt', private.canonical_truth_timestamp(v_chronology_at),
        'decisionAuthorityKind', v_decision_authority_kind,
        'epochItemId', v_item_id,
        'epochItemHash', v_item_hash
      ), true);
    end if;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position($marker$'acceptedClaimKey', v_accepted_claim_key$marker$ in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance epoch-item rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_epoch_item$;

do $rewrite_authority_manifest$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId',
    'itemHash', item->>'itemHash',
    'candidateClaimVersionId', item #>> '{canonicalItem,candidateClaimVersionId}',
    'decision', item #>> '{canonicalItem,decision}',
    'acceptedClaimVersionId', item #>> '{canonicalItem,acceptedClaimVersionId}'
  ) order by (item #>> '{canonicalItem,ordinal}')::integer), '[]'::jsonb)
  into v_decision_manifest
  from jsonb_array_elements(v_items) item;
  v_decision_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_decision_manifest), 'UTF8'
  ), 'sha256'), 'hex');$old$;
  v_new text := $new$  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId',
    'itemHash', item->>'itemHash',
    'candidateClaimVersionId', item #>> '{canonicalItem,candidateClaimVersionId}',
    'decision', item #>> '{canonicalItem,decision}',
    'decisionAuthorityKind', item #>> '{canonicalItem,decisionAuthorityKind}',
    'decisionVersionId', item #>> '{canonicalItem,decisionVersionId}',
    'acceptedClaimVersionId', item #>> '{canonicalItem,acceptedClaimVersionId}',
    'reviewResolutionId', item #>> '{canonicalItem,reviewResolutionId}'
  ) order by (item #>> '{canonicalItem,ordinal}')::integer), '[]'::jsonb)
  into v_decision_manifest
  from jsonb_array_elements(v_items) item;
  v_decision_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_decision_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateClaimVersionId', item #>> '{canonicalItem,candidateClaimVersionId}',
    'candidateItemHash', item #>> '{canonicalItem,candidateItemHash}',
    'decisionAuthorityKind', item #>> '{canonicalItem,decisionAuthorityKind}',
    'decisionAuthorityHash', item #>> '{canonicalItem,decisionAuthorityHash}',
    'decisionVersionId', item #>> '{canonicalItem,decisionVersionId}',
    'decisionItemHash', item #>> '{canonicalItem,decisionItemHash}',
    'decisionAuthoredAt', item #>> '{canonicalItem,decisionAuthoredAt}',
    'reviewResolutionId', item #>> '{canonicalItem,reviewResolutionId}',
    'reviewRequestHash', item #>> '{canonicalItem,reviewRequestHash}',
    'reviewReceiptHash', item #>> '{canonicalItem,reviewReceiptHash}',
    'reviewResolvedAt', item #>> '{canonicalItem,reviewResolvedAt}'
  ) order by (item #>> '{canonicalItem,ordinal}')::integer), '[]'::jsonb)
  into v_authority_manifest
  from jsonb_array_elements(v_items) item;
  v_authority_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_authority_manifest), 'UTF8'
  ), 'sha256'), 'hex');$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_authority_manifest_hash := encode' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance authority-manifest rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_authority_manifest$;

do $rewrite_epoch_receipt$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  v_receipt := jsonb_build_object(
    'schemaVersion', 'truth-shadow-claim-acceptance-epoch-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', v_pending.source_system,
    'connectionKey', v_pending.connection_key,
    'rootBatchId', v_pending.root_batch_id,
    'sourceCursorVersion', v_pending.source_cursor_version,
    'sourceCursorValue', v_pending.source_cursor_value,
    'pendingJobId', v_pending.pending_job_id,
    'obligationId', v_pending.obligation_id,
    'obligationHash', v_pending.obligation_hash,
    'predecessorEpochId', coalesce(v_predecessor.epoch_id, ''),
    'predecessorEpochHash', coalesce(v_predecessor.receipt_hash, ''),
    'frontierManifestHash', v_frontier_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'headManifestHash', v_head_manifest_hash,
    'candidateCount', v_candidate_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'reviewCount', v_review_count,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );$old$;
  v_new text := $new$  v_receipt := jsonb_build_object(
    'schemaVersion', 'truth-shadow-claim-acceptance-epoch-v2',
    'workspaceKey', p_workspace_key,
    'sourceSystem', v_pending.source_system,
    'connectionKey', v_pending.connection_key,
    'rootBatchId', v_pending.root_batch_id,
    'sourceCursorVersion', v_pending.source_cursor_version,
    'sourceCursorValue', v_pending.source_cursor_value,
    'pendingJobId', v_pending.pending_job_id,
    'obligationId', v_pending.obligation_id,
    'obligationHash', v_pending.obligation_hash,
    'predecessorEpochId', coalesce(v_predecessor.epoch_id, ''),
    'predecessorEpochHash', coalesce(v_predecessor.receipt_hash, ''),
    'frontierManifestHash', v_frontier_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'decisionAuthorityManifestHash', v_authority_manifest_hash,
    'headManifestHash', v_head_manifest_hash,
    'candidateCount', v_candidate_count,
    'epochPolicyDecisionCount', v_epoch_policy_decision_count,
    'adoptedReviewDecisionCount', v_adopted_review_decision_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'reviewCount', v_review_count,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position($marker$'decisionAuthorityManifestHash', v_authority_manifest_hash$marker$ in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance epoch-receipt rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_epoch_receipt$;

do $rewrite_epoch_insert$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  insert into public.truth_shadow_claim_acceptance_epochs (
    epoch_id, workspace_key, source_system, connection_key, root_batch_id,
    source_cursor_version, source_cursor_value, pending_job_id, obligation_id,
    obligation_hash, predecessor_epoch_id, predecessor_epoch_hash,
    frontier_manifest, frontier_manifest_hash, decision_manifest,
    decision_manifest_hash, head_manifest, head_manifest_hash,
    candidate_count, accepted_count, rejected_count, review_count,
    canonical_receipt, receipt_hash, schema_version, shadow_only,
    production_eligible, production_publication_attempted
  ) values (
    v_epoch_id, p_workspace_key, v_pending.source_system, v_pending.connection_key,
    v_pending.root_batch_id, v_pending.source_cursor_version,
    v_pending.source_cursor_value, v_pending.pending_job_id,
    v_pending.obligation_id, v_pending.obligation_hash,
    v_predecessor.epoch_id, coalesce(v_predecessor.receipt_hash, ''),
    v_frontier, v_frontier_hash, v_decision_manifest,
    v_decision_manifest_hash, v_head_manifest, v_head_manifest_hash,
    v_candidate_count, v_accepted_count, v_rejected_count, v_review_count,
    v_receipt, v_receipt_hash, 'truth-shadow-claim-acceptance-epoch-v1',
    true, false, false
  );$old$;
  v_new text := $new$  insert into public.truth_shadow_claim_acceptance_epochs (
    epoch_id, workspace_key, source_system, connection_key, root_batch_id,
    source_cursor_version, source_cursor_value, pending_job_id, obligation_id,
    obligation_hash, predecessor_epoch_id, predecessor_epoch_hash,
    frontier_manifest, frontier_manifest_hash, decision_manifest,
    decision_manifest_hash, decision_authority_manifest,
    decision_authority_manifest_hash, head_manifest, head_manifest_hash,
    candidate_count, epoch_policy_decision_count,
    adopted_review_decision_count, accepted_count, rejected_count, review_count,
    canonical_receipt, receipt_hash, schema_version, shadow_only,
    production_eligible, production_publication_attempted
  ) values (
    v_epoch_id, p_workspace_key, v_pending.source_system, v_pending.connection_key,
    v_pending.root_batch_id, v_pending.source_cursor_version,
    v_pending.source_cursor_value, v_pending.pending_job_id,
    v_pending.obligation_id, v_pending.obligation_hash,
    v_predecessor.epoch_id, coalesce(v_predecessor.receipt_hash, ''),
    v_frontier, v_frontier_hash, v_decision_manifest,
    v_decision_manifest_hash, v_authority_manifest,
    v_authority_manifest_hash, v_head_manifest, v_head_manifest_hash,
    v_candidate_count, v_epoch_policy_decision_count,
    v_adopted_review_decision_count, v_accepted_count,
    v_rejected_count, v_review_count,
    v_receipt, v_receipt_hash, 'truth-shadow-claim-acceptance-epoch-v2',
    true, false, false
  );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('decision_authority_manifest_hash, head_manifest' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance epoch-insert rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_epoch_insert$;

do $rewrite_item_insert$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  insert into public.truth_shadow_claim_acceptance_epoch_items (
    item_id, epoch_id, workspace_key, obligation_id, ordinal, source_job_id,
    candidate_claim_version_id, candidate_item_hash, original_claim_key,
    shadow_claim_key, chronology_at, decision, reason_codes,
    decision_version_id, decision_item_hash, accepted_claim_version_id,
    accepted_claim_item_hash, binding_id, binding_item_hash,
    canonical_item, item_hash, schema_version
  )
  select
    item->>'itemId', v_epoch_id, p_workspace_key, p_obligation_id,
    (item #>> '{canonicalItem,ordinal}')::integer,
    (item #>> '{canonicalItem,sourceJobId}')::uuid,
    item #>> '{canonicalItem,candidateClaimVersionId}',
    item #>> '{canonicalItem,candidateItemHash}',
    item #>> '{canonicalItem,originalClaimKey}',
    item #>> '{canonicalItem,shadowClaimKey}',
    (item #>> '{canonicalItem,chronologyAt}')::timestamptz,
    item #>> '{canonicalItem,decision}',
    item #> '{canonicalItem,reasonCodes}',
    item #>> '{canonicalItem,decisionVersionId}',
    item #>> '{canonicalItem,decisionItemHash}',
    nullif(item #>> '{canonicalItem,acceptedClaimVersionId}', ''),
    item #>> '{canonicalItem,acceptedClaimItemHash}',
    nullif(item #>> '{canonicalItem,bindingId}', ''),
    item #>> '{canonicalItem,bindingItemHash}',
    item->'canonicalItem', item->>'itemHash',
    'truth-shadow-claim-acceptance-epoch-item-v1'
  from jsonb_array_elements(v_items) item;$old$;
  v_new text := $new$  insert into public.truth_shadow_claim_acceptance_epoch_items (
    item_id, epoch_id, workspace_key, obligation_id, ordinal, source_job_id,
    candidate_claim_version_id, candidate_item_hash, original_claim_key,
    shadow_claim_key, chronology_at, decision, reason_codes,
    decision_authority_kind, review_resolution_id, review_request_hash,
    review_receipt_hash, decision_authored_at, review_resolved_at,
    decision_version_id, decision_item_hash, accepted_claim_version_id,
    accepted_claim_item_hash, binding_id, binding_item_hash,
    canonical_item, item_hash, schema_version
  )
  select
    item->>'itemId', v_epoch_id, p_workspace_key, p_obligation_id,
    (item #>> '{canonicalItem,ordinal}')::integer,
    (item #>> '{canonicalItem,sourceJobId}')::uuid,
    item #>> '{canonicalItem,candidateClaimVersionId}',
    item #>> '{canonicalItem,candidateItemHash}',
    item #>> '{canonicalItem,originalClaimKey}',
    item #>> '{canonicalItem,shadowClaimKey}',
    (item #>> '{canonicalItem,chronologyAt}')::timestamptz,
    item #>> '{canonicalItem,decision}',
    item #> '{canonicalItem,reasonCodes}',
    item #>> '{canonicalItem,decisionAuthorityKind}',
    nullif(item #>> '{canonicalItem,reviewResolutionId}', ''),
    item #>> '{canonicalItem,reviewRequestHash}',
    item #>> '{canonicalItem,reviewReceiptHash}',
    (item #>> '{canonicalItem,decisionAuthoredAt}')::timestamptz,
    nullif(item #>> '{canonicalItem,reviewResolvedAt}', '')::timestamptz,
    item #>> '{canonicalItem,decisionVersionId}',
    item #>> '{canonicalItem,decisionItemHash}',
    nullif(item #>> '{canonicalItem,acceptedClaimVersionId}', ''),
    item #>> '{canonicalItem,acceptedClaimItemHash}',
    nullif(item #>> '{canonicalItem,bindingId}', ''),
    item #>> '{canonicalItem,bindingItemHash}',
    item->'canonicalItem', item->>'itemHash',
    'truth-shadow-claim-acceptance-epoch-item-v2'
  from jsonb_array_elements(v_items) item;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('decision_authority_kind, review_resolution_id' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance item-insert rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_item_insert$;

do $rewrite_job_result$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  v_job_result := jsonb_build_object(
    'schemaVersion', 'truth-claim-acceptance-epoch-result-v1',
    'epochId', v_epoch_id,
    'epochReceiptHash', v_receipt_hash,
    'frontierManifestHash', v_frontier_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'headManifestHash', v_head_manifest_hash,
    'candidateCount', v_candidate_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'reviewCount', v_review_count,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );$old$;
  v_new text := $new$  v_job_result := jsonb_build_object(
    'schemaVersion', 'truth-claim-acceptance-epoch-result-v2',
    'epochId', v_epoch_id,
    'epochReceiptHash', v_receipt_hash,
    'frontierManifestHash', v_frontier_hash,
    'decisionManifestHash', v_decision_manifest_hash,
    'decisionAuthorityManifestHash', v_authority_manifest_hash,
    'headManifestHash', v_head_manifest_hash,
    'candidateCount', v_candidate_count,
    'epochPolicyDecisionCount', v_epoch_policy_decision_count,
    'adoptedReviewDecisionCount', v_adopted_review_decision_count,
    'acceptedCount', v_accepted_count,
    'rejectedCount', v_rejected_count,
    'reviewCount', v_review_count,
    'publicationChannel', 'shadow',
    'shadowOnly', true,
    'productionEligible', false,
    'productionPublicationAttempted', false,
    'mutatesOperationalState', false,
    'publishesTruth', false,
    'performsActions', false
  );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position($marker$'truth-claim-acceptance-epoch-result-v2'$marker$ in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'shadow acceptance job-result rewrite did not match reviewed v1'
        using errcode = '23514';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    v_definition := replace(
      v_definition,
      $old$processor_version = 'truth-shadow-acceptance-epoch-v1',$old$,
      $new$processor_version = 'truth-shadow-acceptance-epoch-v2',$new$
    );
    execute v_definition;
  end if;
end;
$rewrite_job_result$;

revoke all on function private.run_truth_shadow_claim_acceptance_epoch(
  text, text, text
) from public, anon, authenticated, service_role;

-- Function rewrites are installation-time guarded above.  This read-back is
-- deliberately structural: it verifies the authority split, provenance hash,
-- first-epoch boundary, cross-key bridge, and permanent publication quarantine.
do $verify$
declare
  v_definition text;
  v_helper text;
  v_public text;
  v_epoch_columns integer;
  v_item_columns integer;
begin
  select lower(pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  )) into v_definition;
  select lower(pg_get_functiondef(
    'private.truth_shadow_review_decision_adoption_v1(text,text,uuid,text,text)'::regprocedure
  )) into v_helper;
  select lower(pg_get_functiondef(
    'public.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  )) into v_public;

  select count(*)::integer into v_epoch_columns
  from information_schema.columns column_row
  where column_row.table_schema = 'public'
    and column_row.table_name = 'truth_shadow_claim_acceptance_epochs'
    and column_row.column_name = any(array[
      'decision_authority_manifest', 'decision_authority_manifest_hash',
      'epoch_policy_decision_count', 'adopted_review_decision_count'
    ]);
  select count(*)::integer into v_item_columns
  from information_schema.columns column_row
  where column_row.table_schema = 'public'
    and column_row.table_name = 'truth_shadow_claim_acceptance_epoch_items'
    and column_row.column_name = any(array[
      'decision_authority_kind', 'review_resolution_id',
      'review_request_hash', 'review_receipt_hash',
      'decision_authored_at', 'review_resolved_at'
    ]);

  if v_epoch_columns <> 4
    or v_item_columns <> 6
    or position('truth-shadow-claim-acceptance-epoch-v2' in v_definition) = 0
    or position('truth-shadow-claim-acceptance-epoch-item-v2' in v_definition) = 0
    or position('truth_shadow_review_decision_adoption_v1' in v_definition) = 0
    or position('adoptedreviewdecisioncount' in v_definition) = 0
    or position('decisionauthoritymanifesthash' in v_definition) = 0
    or position('later shadow acceptance frontier has a mixed decision authority' in v_definition) = 0
    or position('acceptedclaimkey' in v_definition) = 0
    or position('shadow acceptance frontier already has a legacy decision authority' in v_definition) <> 0
    or position('truth-shadow-model-commissioning-review-v1' in v_helper) = 0
    or position('authoritative_truth_input_hash' in v_helper) = 0
    or position('adopted review acceptance binding is not exact' in v_helper) = 0
    or position('adopted review rejection has acceptance artifacts' in v_helper) = 0
    or position('select private.run_truth_shadow_claim_acceptance_epoch' in v_public) = 0
    or has_function_privilege(
      'service_role',
      'private.truth_shadow_review_decision_adoption_v1(text,text,uuid,text,text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)',
      'execute'
    ) then
    raise exception 'mixed-authority shadow acceptance verification failed'
      using errcode = '23514';
  end if;

  if position('shipment-truth-packets' in lower(v_definition || v_helper)) <> 0
    or position('insert into public.truth_publications' in lower(v_definition || v_helper)) <> 0
    or position($marker$'productionpublicationattempted', false$marker$ in v_definition) = 0 then
    raise exception 'mixed-authority shadow acceptance crossed publication quarantine'
      using errcode = '42501';
  end if;
end;
$verify$;
