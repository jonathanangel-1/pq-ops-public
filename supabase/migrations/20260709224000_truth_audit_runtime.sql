create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

-- An audit finding identity describes the regression, not one occurrence of
-- it. The original single-column primary key therefore made a stable finding
-- impossible to record in two runs. Keep the stable ID and key occurrences by
-- (run, finding).
alter table public.truth_audit_findings
  drop constraint if exists truth_audit_findings_pkey;

alter table public.truth_audit_findings
  add primary key (audit_run_id, finding_id);

alter table public.truth_audit_findings
  add column if not exists evidence_ids text[] not null default '{}'::text[];

alter table public.truth_audit_runs
  add column if not exists input_digest text;

alter table public.truth_audit_runs
  add column if not exists lease_expires_at timestamptz;

alter table public.truth_audit_runs
  add column if not exists previous_audit_run_id uuid
    references public.truth_audit_runs(audit_run_id) on delete restrict;

alter table public.truth_audit_runs
  add column if not exists reconciliation_from timestamptz;

alter table public.truth_audit_runs
  add column if not exists expected_interval_seconds integer not null default 900;

-- This is an additive pre-runtime migration, but reconcile any rows created by
-- an earlier local attempt so the durable one-running-run invariant can be
-- installed without deleting history.
with ranked_running as (
  select
    audit_run_id,
    row_number() over (
      partition by workspace_key
      order by started_at desc, audit_run_id desc
    ) as ordinal
  from public.truth_audit_runs
  where status = 'running'
)
update public.truth_audit_runs run
set status = 'failed',
    error_code = 'AUDIT_MIGRATION_SUPERSEDED',
    error_detail = 'Superseded while installing the durable audit runtime lease.',
    metrics = jsonb_build_object('mutatesOperationalState', false),
    finished_at = clock_timestamp()
from ranked_running ranked
where ranked.audit_run_id = run.audit_run_id
  and ranked.ordinal > 1;

update public.truth_audit_runs
set lease_expires_at = started_at + interval '5 minutes'
where status = 'running'
  and lease_expires_at is null;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.truth_audit_runs'::regclass
      and conname = 'truth_audit_runs_input_digest_check'
  ) then
    alter table public.truth_audit_runs
      add constraint truth_audit_runs_input_digest_check
      check (input_digest is null or input_digest ~ '^[0-9a-f]{64}$');
  end if;
end;
$block$;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.truth_audit_runs'::regclass
      and conname = 'truth_audit_runs_lease_check'
  ) then
    alter table public.truth_audit_runs
      add constraint truth_audit_runs_lease_check
      check (
        expected_interval_seconds between 60 and 86400
        and (status <> 'running' or lease_expires_at is not null)
      );
  end if;
end;
$block$;

create unique index if not exists truth_audit_runs_one_running_workspace_idx
  on public.truth_audit_runs (workspace_key)
  where status = 'running';

create index if not exists truth_audit_runs_success_reconcile_idx
  on public.truth_audit_runs (workspace_key, finished_at desc)
  where status = 'succeeded';

create index if not exists truth_audit_findings_stable_identity_idx
  on public.truth_audit_findings (workspace_key, finding_id, created_at desc);

create index if not exists source_cuts_workspace_sealed_audit_idx
  on public.source_cuts (workspace_key, sealed_at desc, source_cut_id);

create index if not exists source_processing_jobs_workspace_audit_idx
  on public.source_processing_jobs (workspace_key, state, created_at, job_id)
  where state in ('queued', 'leased', 'retry_wait', 'dead_letter');

create index if not exists gmail_completeness_gaps_workspace_audit_idx
  on public.gmail_completeness_gaps (workspace_key, detected_at, gap_id)
  where status = 'open';

-- The audit runtime has a token that is intentionally not accepted by the
-- source/canonical writer RPCs. Possession of the audit credential pair does
-- not confer the general local_snapshot_writer capability.
create or replace function private.valid_truth_audit_token(p_sync_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select length(coalesce(p_sync_token, '')) between 16 and 4096
    and exists (
      select 1
      from public.sync_tokens token
      where token.token_name = 'truth_audit_runtime'
        and token.token_hash = encode(
          extensions.digest(convert_to(p_sync_token, 'UTF8'), 'sha256'),
          'hex'
        )
    );
$function$;

create or replace function public.guard_truth_audit_run_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth_audit_runs is append-only' using errcode = '55000';
  end if;

  if old.status <> 'running' then
    raise exception 'final truth audit runs are immutable' using errcode = '55000';
  end if;

  if new.status not in ('succeeded', 'failed') then
    raise exception 'truth audit runs only transition from running to a final state'
      using errcode = '55000';
  end if;

  if row(
    new.audit_run_id,
    new.workspace_key,
    new.audit_mode,
    new.observer_version,
    new.model_version,
    new.mutates_operational_state,
    new.started_at,
    new.lease_expires_at,
    new.previous_audit_run_id,
    new.reconciliation_from,
    new.expected_interval_seconds
  ) is distinct from row(
    old.audit_run_id,
    old.workspace_key,
    old.audit_mode,
    old.observer_version,
    old.model_version,
    old.mutates_operational_state,
    old.started_at,
    old.lease_expires_at,
    old.previous_audit_run_id,
    old.reconciliation_from,
    old.expected_interval_seconds
  ) then
    raise exception 'truth audit run identity is immutable' using errcode = '55000';
  end if;

  if new.mutates_operational_state
    or new.finished_at is null
    or new.finished_at < new.started_at
    or jsonb_typeof(new.metrics) <> 'object'
  then
    raise exception 'invalid final truth audit run' using errcode = '23514';
  end if;

  if new.status = 'succeeded' and (
    new.input_digest is null
    or new.error_code <> ''
    or new.error_detail <> ''
  ) then
    raise exception 'a successful truth audit requires an input digest and no error'
      using errcode = '23514';
  end if;

  if new.status = 'failed' and nullif(new.error_code, '') is null then
    raise exception 'a failed truth audit requires an error code'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

drop trigger if exists truth_audit_runs_guard on public.truth_audit_runs;
create trigger truth_audit_runs_guard
before update or delete on public.truth_audit_runs
for each row execute function public.guard_truth_audit_run_transition();

create or replace function private.truth_audit_citation_ids(
  p_packet jsonb,
  p_kind text
)
returns table(citation_id text)
language sql
immutable
security invoker
set search_path = ''
as $function$
  with recursive nodes(value) as (
    select p_packet
    union all
    select child.value
    from nodes parent
    cross join lateral (
      select object_child.value
      from jsonb_each(parent.value) object_child
      where jsonb_typeof(parent.value) = 'object'
      union all
      select array_child.value
      from jsonb_array_elements(parent.value) array_child
      where jsonb_typeof(parent.value) = 'array'
    ) child
  ), entries as (
    select entry.key, entry.value
    from nodes
    cross join lateral jsonb_each(nodes.value) entry
    where jsonb_typeof(nodes.value) = 'object'
  ), raw_ids as (
    select value #>> '{}' as citation_id
    from entries
    where jsonb_typeof(value) = 'string'
      and p_kind = 'observation'
      and lower(key) ~ 'observationid$'
    union all
    select array_value #>> '{}'
    from entries
    cross join lateral jsonb_array_elements(entries.value) array_value
    where jsonb_typeof(entries.value) = 'array'
      and jsonb_typeof(array_value) = 'string'
      and p_kind = 'observation'
      and lower(key) ~ '(observationids|evidenceobservationids)$'
  )
  select distinct raw_ids.citation_id
  from raw_ids
  where nullif(raw_ids.citation_id, '') is not null;
$function$;

-- Read one bounded, transaction-consistent JSON witness. Only the current
-- cursor batches, current source cut, its builds/envelopes, publication state,
-- and outstanding/dead-letter processing jobs are included. If any collection
-- exceeds the bound, `bounds.truncated` is true and the JS runner fails the run
-- instead of auditing a deceptive partial snapshot.
create or replace function private.read_truth_audit_snapshot(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '25s'
as $function$
declare
  v_snapshot jsonb;
  v_head_publication_payloads jsonb := '[]'::jsonb;
  v_head_publication_payload_count bigint := 0;
  v_head_publication_payload_bytes bigint := 0;
  v_head_publication_payload_byte_limit constant bigint := 33554432;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_row_limit is null
    or p_row_limit < 100
    or p_row_limit > 50000
  then
    raise exception 'invalid truth audit snapshot request' using errcode = '22023';
  end if;

  -- The payload ledger is installed by the later build/publication runtime
  -- migration. Resolve it dynamically so this earlier migration remains
  -- installable in timestamp order while deployed audit runs can still carry
  -- the at-most-two current head payloads (shadow and production). Measure
  -- before materializing: an oversized payload witness fails closed through
  -- bounds.truncated instead of forcing an unbounded JSON response.
  if to_regclass('public.truth_publication_payloads') is not null then
    execute $query$
      select
        count(*)::bigint,
        coalesce(sum(pg_column_size(to_jsonb(payload))), 0)::bigint
      from public.truth_publication_payloads payload
      join public.truth_publication_heads head
        on head.publication_id = payload.publication_id
       and head.workspace_key = payload.workspace_key
       and head.channel = payload.channel
      where payload.workspace_key = $1
    $query$
    into v_head_publication_payload_count, v_head_publication_payload_bytes
    using p_workspace_key;

    if v_head_publication_payload_count <= p_row_limit
      and v_head_publication_payload_bytes <= v_head_publication_payload_byte_limit
    then
      execute $query$
        select coalesce(
          jsonb_agg(to_jsonb(selected) order by selected.channel),
          '[]'::jsonb
        )
        from (
          select payload.*
          from public.truth_publication_payloads payload
          join public.truth_publication_heads head
            on head.publication_id = payload.publication_id
           and head.workspace_key = payload.workspace_key
           and head.channel = payload.channel
          where payload.workspace_key = $1
          order by payload.channel
          limit $2
        ) selected
      $query$
      into v_head_publication_payloads
      using p_workspace_key, p_row_limit;
    end if;
  end if;

  with
  parameters as (
    select p_workspace_key as workspace_key, p_row_limit as row_limit
  ),
  -- Prefer the newest sealed cut over the production head on purpose. During
  -- shadow operation this makes publication lag visible instead of silently
  -- redefining "current" as whatever production already serves.
  target as (
    select coalesce(
      (
        select cut.source_cut_id
        from public.source_cuts cut, parameters p
        where cut.workspace_key = p.workspace_key
        order by cut.sealed_at desc, cut.source_cut_id desc
        limit 1
      ),
      (
        select head.source_cut_id
        from public.truth_publication_heads head, parameters p
        where head.workspace_key = p.workspace_key
          and head.channel = 'production'
        limit 1
      )
    ) as source_cut_id
  ),
  current_batch_ids as (
    select distinct cursor.last_batch_id as batch_id
    from public.source_cursors cursor, parameters p
    where cursor.workspace_key = p.workspace_key
      and cursor.last_batch_id is not null
  ),
  current_batches_base as (
    select batch.*
    from public.source_ingest_batches batch
    join current_batch_ids selected on selected.batch_id = batch.batch_id
  ),
  current_pages_base as (
    select page.*
    from public.gmail_ingest_pages page
    join current_batch_ids selected on selected.batch_id = page.batch_id
  ),
  current_page_observations_base as (
    select membership.*
    from public.gmail_ingest_page_observations membership
    join current_batch_ids selected on selected.batch_id = membership.batch_id
  ),
  current_page_jobs_base as (
    select membership.*
    from public.gmail_ingest_page_jobs membership
    join current_batch_ids selected on selected.batch_id = membership.batch_id
  ),
  current_job_lineage_base as (
    select lineage.*
    from public.source_processing_job_lineage lineage
    join current_batch_ids selected on selected.batch_id = lineage.root_batch_id
  ),
  current_job_children_base as (
    select child.*
    from public.source_processing_job_children child
    where exists (
      select 1
      from current_job_lineage_base lineage
      where lineage.job_id = child.parent_job_id
         or lineage.job_id = child.child_job_id
    )
  ),
  current_job_observations_base as (
    select output.*
    from public.source_processing_job_observations output
    join current_job_lineage_base lineage on lineage.job_id = output.job_id
  ),
  current_observations_base as (
    select
      observation.journal_seq,
      observation.observation_id,
      observation.workspace_key,
      observation.source_system,
      observation.connection_key,
      observation.source_object_type,
      observation.source_object_id,
      observation.source_revision,
      observation.operation,
      observation.source_cursor_version,
      observation.batch_id,
      observation.content_hash,
      observation.source_recorded_at,
      observation.captured_at,
      case
        when exists (
          select 1
          from current_page_observations_base membership
          where membership.observation_id = observation.observation_id
        ) then observation.normalized_payload
        when observation.source_object_type = 'gmail_attachment_extracted' then
          jsonb_build_object(
            'schemaVersion', observation.normalized_payload->>'schemaVersion',
            'parentObservationId', observation.normalized_payload->>'parentObservationId',
            'attachmentId', observation.normalized_payload->>'attachmentId',
            'filename', observation.normalized_payload->>'filename',
            'mimeType', observation.normalized_payload->>'mimeType',
            'extraction', coalesce(observation.normalized_payload->'extraction', '{}'::jsonb),
            'classification', observation.normalized_payload->'classification'
          )
        else jsonb_build_object(
          'schemaVersion', observation.schema_version,
          'payloadHash', encode(extensions.digest(
            convert_to(observation.normalized_payload::text, 'UTF8'),
            'sha256'
          ), 'hex'),
          'payloadBytes', pg_column_size(observation.normalized_payload)
        )
      end as normalized_payload,
      ''::text as normalized_text,
      observation.raw_object_bucket,
      observation.raw_object_key,
      observation.raw_object_version,
      observation.raw_object_etag,
      observation.raw_object_hash,
      observation.raw_object_bytes,
      observation.raw_content_type,
      observation.source_fidelity,
      observation.schema_version,
      observation.retention_class,
      observation.created_at
    from public.source_observations observation
    where exists (
      select 1
      from current_page_observations_base membership
      where membership.observation_id = observation.observation_id
    ) or exists (
      select 1
      from current_job_observations_base output
      where output.observation_id = observation.observation_id
    )
  ),
  current_jobs_base as (
    select job.*
    from public.source_processing_jobs job, parameters p
    where job.workspace_key = p.workspace_key
      and (
        job.state in ('queued', 'leased', 'retry_wait', 'dead_letter')
        or exists (
          select 1
          from current_page_jobs_base membership
          where membership.job_id = job.job_id
        )
        or exists (
          select 1
          from current_job_lineage_base lineage
          where lineage.job_id = job.job_id
        )
      )
  ),
  current_gaps_base as (
    select gap.*
    from public.gmail_completeness_gaps gap, parameters p
    where gap.workspace_key = p.workspace_key
      and gap.status = 'open'
  ),
  current_snapshot_failures_base as (
    select failure.*
    from public.source_snapshot_failures failure, parameters p
    where failure.workspace_key = p.workspace_key
      and not exists (
        select 1
        from public.source_snapshot_failure_resolutions resolution
        where resolution.failure_id = failure.failure_id
      )
  ),
  target_cuts_base as (
    select cut.*
    from public.source_cuts cut, target
    where cut.source_cut_id = target.source_cut_id
  ),
  target_cut_cursors_base as (
    select cursor.*
    from public.source_cut_cursors cursor, target
    where cursor.source_cut_id = target.source_cut_id
  ),
  target_cut_partition_witnesses_base as (
    select
      cursor.source_cut_id,
      cursor.source_system,
      cursor.connection_key,
      cursor.through_cursor_version,
      (partition.witness->>'observationCount')::integer as observation_count,
      partition.witness->>'partitionHash' as partition_hash
    from target_cut_cursors_base cursor
    cross join parameters p
    cross join lateral (
      select private.source_cut_partition_witness(
        p.workspace_key,
        cursor.source_system,
        cursor.connection_key,
        cursor.through_cursor_version
      ) as witness
    ) partition
  ),
  target_cut_observations_base as (
    select membership.*
    from public.source_cut_observations membership, target
    where membership.source_cut_id = target.source_cut_id
  ),
  target_builds_base as (
    select build.*
    from public.truth_builds build, parameters p, target
    where build.workspace_key = p.workspace_key
      and (
        build.source_cut_id = target.source_cut_id
        or exists (
          select 1
          from public.truth_publication_heads head
          join public.truth_publications publication
            on publication.publication_id = head.publication_id
          where head.workspace_key = p.workspace_key
            and publication.build_id = build.build_id
        )
      )
  ),
  target_build_inputs_base as (
    select input.*
    from public.truth_build_inputs input
    join target_builds_base build on build.build_id = input.build_id
  ),
  target_cut_build_inputs_base as (
    select input.*
    from target_build_inputs_base input
    join target_builds_base build on build.build_id = input.build_id
    cross join target
    where build.source_cut_id = target.source_cut_id
  ),
  target_evidence_ids_base as (
    select evidence.observation_id
    from target_cut_build_inputs_base input
    join public.accepted_claim_evidence evidence
      on input.item_kind = 'accepted_claim'
     and evidence.claim_version_id = input.item_id
    union
    select entity_link.observation_id
    from target_cut_build_inputs_base input
    join public.observation_entity_links entity_link
      on input.item_kind = 'entity_link'
     and entity_link.link_version_id = input.item_id
    union
    select evidence.observation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_membership_evidence evidence
      on input.item_kind = 'workgroup_membership'
     and evidence.membership_version_id = input.item_id
    union
    select membership.observation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_memberships membership
      on input.item_kind = 'workgroup_membership'
     and membership.membership_version_id = input.item_id
    where membership.observation_id is not null
    union
    select membership.basis_observation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_memberships membership
      on input.item_kind = 'workgroup_membership'
     and membership.membership_version_id = input.item_id
    where membership.basis_observation_id is not null
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.accepted_claim_envelopes envelope
      on input.item_kind = 'accepted_claim'
     and envelope.claim_version_id = input.item_id
    cross join lateral private.truth_audit_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.observation_entity_link_envelopes envelope
      on input.item_kind = 'entity_link'
     and envelope.link_version_id = input.item_id
    cross join lateral private.truth_audit_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_membership_envelopes envelope
      on input.item_kind = 'workgroup_membership'
     and envelope.membership_version_id = input.item_id
    cross join lateral private.truth_audit_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_membership_envelopes membership_envelope
      on input.item_kind = 'workgroup_membership'
     and membership_envelope.membership_version_id = input.item_id
    join public.operational_workgroup_envelopes workgroup
      on workgroup.workgroup_id = membership_envelope.workgroup_id
    cross join lateral private.truth_audit_citation_ids(
      workgroup.canonical_definition, 'observation'
    ) citation
  ),
  target_evidence_observations_base as (
    select
      target.source_cut_id,
      observation.observation_id,
      observation.workspace_key,
      observation.source_system,
      observation.connection_key,
      observation.source_cursor_version,
      observation.batch_id,
      observation.content_hash,
      batch.status as batch_status,
      batch.workspace_key as batch_workspace_key,
      batch.source_system as batch_source_system,
      batch.connection_key as batch_connection_key,
      batch.committed_cursor_version,
      private.source_observation_within_cut(
        p.workspace_key,
        target.source_cut_id,
        observation.observation_id,
        observation.content_hash
      ) as within_cut
    from target_evidence_ids_base evidence
    join public.source_observations observation
      on observation.observation_id = evidence.observation_id
    join public.source_ingest_batches batch
      on batch.batch_id = observation.batch_id
    cross join parameters p
    cross join target
  ),
  accepted_envelopes_base as (
    select envelope.*
    from public.accepted_claim_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'accepted_claim'
     and input.item_id = envelope.claim_version_id
  ),
  link_envelopes_base as (
    select envelope.*
    from public.observation_entity_link_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'entity_link'
     and input.item_id = envelope.link_version_id
  ),
  workgroup_envelopes_base as (
    select envelope.*
    from public.operational_workgroup_membership_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'workgroup_membership'
     and input.item_id = envelope.membership_version_id
  ),
  workgroup_definition_envelopes_base as (
    select distinct workgroup.*
    from public.operational_workgroup_envelopes workgroup
    join workgroup_envelopes_base membership
      on membership.workgroup_id = workgroup.workgroup_id
  ),
  publications_base as (
    select publication.*
    from public.truth_publications publication
    join public.truth_publication_heads head
      on head.publication_id = publication.publication_id
     and head.workspace_key = publication.workspace_key
    join parameters p on p.workspace_key = publication.workspace_key
  ),
  heads_base as (
    select head.*
    from public.truth_publication_heads head, parameters p
    where head.workspace_key = p.workspace_key
  ),
  cache_snapshots_base as (
    select snapshot.*
    from public.app_snapshots snapshot
    where snapshot.snapshot_key in ('shipment-truth-packets', 'active-awb-index')
  ),
  cache_metadata_base as (
    select metadata.*
    from public.app_snapshot_metadata metadata
    where metadata.snapshot_key in ('shipment-truth-packets', 'active-awb-index')
  ),
  counts as (
    select jsonb_build_object(
      'cursors', (select count(*) from public.source_cursors cursor, parameters p where cursor.workspace_key = p.workspace_key),
      'ingestBatches', (select count(*) from current_batches_base),
      'gmailPages', (select count(*) from current_pages_base),
      'pageObservations', (select count(*) from current_page_observations_base),
      'pageJobs', (select count(*) from current_page_jobs_base),
      'jobLineage', (select count(*) from current_job_lineage_base),
      'jobChildren', (select count(*) from current_job_children_base),
      'jobObservations', (select count(*) from current_job_observations_base),
      'observations', (select count(*) from current_observations_base),
      'jobs', (select count(*) from current_jobs_base),
      'gaps', (select count(*) from current_gaps_base),
      'snapshotFailures', (select count(*) from current_snapshot_failures_base),
      'sourceCutCursors', (select count(*) from target_cut_cursors_base),
      'sourceCutPartitionWitnesses', (select count(*) from target_cut_partition_witnesses_base),
      'sourceCutObservations', (select count(*) from target_cut_observations_base),
      'sourceCutEvidenceObservations', (select count(*) from target_evidence_observations_base),
      'builds', (select count(*) from target_builds_base),
      'buildInputs', (select count(*) from target_build_inputs_base),
      'acceptedClaimEnvelopes', (select count(*) from accepted_envelopes_base),
      'entityLinkEnvelopes', (select count(*) from link_envelopes_base),
      'workgroupMembershipEnvelopes', (select count(*) from workgroup_envelopes_base),
      'workgroupDefinitionEnvelopes', (select count(*) from workgroup_definition_envelopes_base),
      'publications', (select count(*) from publications_base),
      'publicationHeads', (select count(*) from heads_base),
      'publicationPayloads', v_head_publication_payload_count
    ) as value
  ),
  bounded_cursors as (
    select cursor.*
    from public.source_cursors cursor, parameters p
    where cursor.workspace_key = p.workspace_key
    order by cursor.source_system, cursor.connection_key
    limit (select row_limit from parameters)
  ),
  bounded_batches as (
    select * from current_batches_base
    order by started_at desc, batch_id
    limit (select row_limit from parameters)
  ),
  bounded_pages as (
    select * from current_pages_base
    order by batch_id, page_ordinal
    limit (select row_limit from parameters)
  ),
  bounded_page_observations as (
    select * from current_page_observations_base
    order by batch_id, page_ordinal, observation_id
    limit (select row_limit from parameters)
  ),
  bounded_page_jobs as (
    select * from current_page_jobs_base
    order by batch_id, page_ordinal, job_id
    limit (select row_limit from parameters)
  ),
  bounded_job_lineage as (
    select * from current_job_lineage_base
    order by root_batch_id, root_job_id, job_id
    limit (select row_limit from parameters)
  ),
  bounded_job_children as (
    select * from current_job_children_base
    order by parent_job_id, ordinal, child_job_id
    limit (select row_limit from parameters)
  ),
  bounded_job_observations as (
    select * from current_job_observations_base
    order by job_id, ordinal, observation_id
    limit (select row_limit from parameters)
  ),
  bounded_observations as (
    select * from current_observations_base
    order by journal_seq
    limit (select row_limit from parameters)
  ),
  bounded_jobs as (
    select * from current_jobs_base
    order by created_at, job_id
    limit (select row_limit from parameters)
  ),
  bounded_gaps as (
    select * from current_gaps_base
    order by detected_at, gap_id
    limit (select row_limit from parameters)
  ),
  bounded_snapshot_failures as (
    select * from current_snapshot_failures_base
    order by created_at, failure_id
    limit (select row_limit from parameters)
  ),
  bounded_cut_observations as (
    select * from target_cut_observations_base
    order by ordinal, observation_id
    limit (select row_limit from parameters)
  ),
  bounded_cut_cursors as (
    select * from target_cut_cursors_base
    order by source_system, connection_key
    limit (select row_limit from parameters)
  ),
  bounded_cut_partition_witnesses as (
    select * from target_cut_partition_witnesses_base
    order by source_system, connection_key
    limit (select row_limit from parameters)
  ),
  bounded_cut_evidence_observations as (
    select * from target_evidence_observations_base
    order by observation_id
    limit (select row_limit from parameters)
  ),
  bounded_builds as (
    select * from target_builds_base
    order by started_at, build_id
    limit (select row_limit from parameters)
  ),
  bounded_build_inputs as (
    select * from target_build_inputs_base
    order by build_id, item_kind, ordinal, item_id
    limit (select row_limit from parameters)
  ),
  bounded_accepted_envelopes as (
    select * from accepted_envelopes_base
    order by claim_version_id
    limit (select row_limit from parameters)
  ),
  bounded_link_envelopes as (
    select * from link_envelopes_base
    order by link_version_id
    limit (select row_limit from parameters)
  ),
  bounded_workgroup_envelopes as (
    select * from workgroup_envelopes_base
    order by membership_version_id
    limit (select row_limit from parameters)
  ),
  bounded_workgroup_definition_envelopes as (
    select * from workgroup_definition_envelopes_base
    order by workgroup_id
    limit (select row_limit from parameters)
  ),
  bounded_publications as (
    select * from publications_base
    order by published_at desc, publication_id
    limit (select row_limit from parameters)
  )
  select jsonb_build_object(
    'schemaVersion', 'relational-truth-audit-snapshot-v1',
    'workspaceKey', p.workspace_key,
    'capturedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'bounds', jsonb_build_object(
      'rowLimit', p.row_limit,
      'observationProjection', 'audit-slim-v1',
      'publicationPayloadBytes', v_head_publication_payload_bytes,
      'publicationPayloadByteLimit', v_head_publication_payload_byte_limit,
      'counts', counts.value,
      'truncated', exists (
        select 1
        from jsonb_each_text(counts.value) item
        where item.value::bigint > p.row_limit
      ) or v_head_publication_payload_bytes > v_head_publication_payload_byte_limit
    ),
    'source', jsonb_build_object(
      'requiredSources', coalesce(
        (select cut.required_sources from target_cuts_base cut limit 1),
        '[]'::jsonb
      ),
      'cursors', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.source_system, row_value.connection_key) from bounded_cursors row_value), '[]'::jsonb),
      'ingestBatches', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.started_at desc, row_value.batch_id) from bounded_batches row_value), '[]'::jsonb),
      'gmailPages', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal) from bounded_pages row_value), '[]'::jsonb),
      'observations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.journal_seq) from bounded_observations row_value), '[]'::jsonb),
      'jobs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.created_at, row_value.job_id) from bounded_jobs row_value), '[]'::jsonb),
      'pageObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal, row_value.observation_id) from bounded_page_observations row_value), '[]'::jsonb),
      'pageJobs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal, row_value.job_id) from bounded_page_jobs row_value), '[]'::jsonb),
      'jobLineage', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.root_batch_id, row_value.root_job_id, row_value.job_id) from bounded_job_lineage row_value), '[]'::jsonb),
      'jobChildren', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.parent_job_id, row_value.ordinal, row_value.child_job_id) from bounded_job_children row_value), '[]'::jsonb),
      'jobObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.job_id, row_value.ordinal, row_value.observation_id) from bounded_job_observations row_value), '[]'::jsonb),
      'gaps', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.detected_at, row_value.gap_id) from bounded_gaps row_value), '[]'::jsonb),
      'snapshotFailures', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.created_at, row_value.failure_id) from bounded_snapshot_failures row_value), '[]'::jsonb)
    ),
    'canonical', jsonb_build_object(
      'currentSourceCutId', target.source_cut_id,
      'sourceCuts', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.source_cut_id) from target_cuts_base row_value), '[]'::jsonb),
      'sourceCutCursors', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.source_system, row_value.connection_key) from bounded_cut_cursors row_value), '[]'::jsonb),
      'sourceCutPartitionWitnesses', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.source_system, row_value.connection_key) from bounded_cut_partition_witnesses row_value), '[]'::jsonb),
      'sourceCutObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.ordinal, row_value.observation_id) from bounded_cut_observations row_value), '[]'::jsonb),
      'sourceCutEvidenceObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.observation_id) from bounded_cut_evidence_observations row_value), '[]'::jsonb),
      'acceptedClaimEnvelopes', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.claim_version_id) from bounded_accepted_envelopes row_value), '[]'::jsonb),
      'entityLinkEnvelopes', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.link_version_id) from bounded_link_envelopes row_value), '[]'::jsonb),
      'workgroupMembershipEnvelopes', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.membership_version_id) from bounded_workgroup_envelopes row_value), '[]'::jsonb),
      'workgroupDefinitionEnvelopes', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.workgroup_id) from bounded_workgroup_definition_envelopes row_value), '[]'::jsonb),
      'builds', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.started_at, row_value.build_id) from bounded_builds row_value), '[]'::jsonb),
      'buildInputs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.build_id, row_value.item_kind, row_value.ordinal) from bounded_build_inputs row_value), '[]'::jsonb),
      'publications', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.published_at desc, row_value.publication_id) from bounded_publications row_value), '[]'::jsonb),
      'publicationHeads', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.channel) from heads_base row_value), '[]'::jsonb),
      'publicationPayloads', v_head_publication_payloads,
      'cacheSnapshots', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.snapshot_key) from cache_snapshots_base row_value), '[]'::jsonb),
      'cacheMetadata', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.snapshot_key) from cache_metadata_base row_value), '[]'::jsonb)
    )
  )
  into v_snapshot
  from parameters p
  cross join target
  cross join counts;

  return v_snapshot;
end;
$function$;

create or replace function private.begin_truth_audit_run(
  p_workspace_key text,
  p_audit_mode text,
  p_observer_version text,
  p_model_version text,
  p_lease_seconds integer,
  p_expected_interval_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.truth_audit_runs%rowtype;
  v_running public.truth_audit_runs%rowtype;
  v_previous public.truth_audit_runs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_schedule_gap_seconds bigint;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_audit_mode not in ('delta', 'hourly', 'morning_full', 'browser_witness')
    or nullif(trim(coalesce(p_observer_version, '')), '') is null
    or length(p_observer_version) > 200
    or length(coalesce(p_model_version, '')) > 200
    or p_lease_seconds is null
    or p_lease_seconds < 30
    or p_lease_seconds > 900
    or p_expected_interval_seconds is null
    or p_expected_interval_seconds < 60
    or p_expected_interval_seconds > 86400
  then
    raise exception 'invalid truth audit begin request' using errcode = '22023';
  end if;

  -- Serialize begin transactions, then retain exclusion after this transaction
  -- through the partial unique index and durable lease on the running row.
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-audit-runtime:' || p_workspace_key,
    0
  ));

  select * into v_running
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
    and run.status = 'running'
  for update;

  if found and v_running.lease_expires_at > v_now then
    return jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'AUDIT_BUSY',
      'status', 'busy',
      'auditRunId', v_running.audit_run_id,
      'workspaceKey', v_running.workspace_key,
      'startedAt', v_running.started_at,
      'leaseExpiresAt', v_running.lease_expires_at,
      'mutatesOperationalState', false
    );
  end if;

  if found then
    update public.truth_audit_runs
    set status = 'failed',
        error_code = 'AUDIT_LEASE_EXPIRED',
        error_detail = 'A later audit reconciled this stale running lease.',
        metrics = jsonb_build_object(
          'reconciledByNextRun', true,
          'mutatesOperationalState', false
        ),
        finished_at = v_now
    where audit_run_id = v_running.audit_run_id;
  end if;

  select * into v_previous
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
    and run.status = 'succeeded'
  order by run.finished_at desc, run.audit_run_id desc
  limit 1;

  if found then
    v_schedule_gap_seconds := greatest(
      0,
      floor(extract(epoch from (v_now - v_previous.finished_at)))::bigint
    );
  end if;

  insert into public.truth_audit_runs (
    workspace_key,
    audit_mode,
    observer_version,
    model_version,
    status,
    mutates_operational_state,
    lease_expires_at,
    previous_audit_run_id,
    reconciliation_from,
    expected_interval_seconds
  ) values (
    p_workspace_key,
    p_audit_mode,
    p_observer_version,
    coalesce(p_model_version, ''),
    'running',
    false,
    v_now + make_interval(secs => p_lease_seconds),
    v_previous.audit_run_id,
    v_previous.finished_at,
    p_expected_interval_seconds
  ) returning * into v_run;

  return jsonb_build_object(
    'ok', true,
    'auditRunId', v_run.audit_run_id,
    'workspaceKey', v_run.workspace_key,
    'auditMode', v_run.audit_mode,
    'observerVersion', v_run.observer_version,
    'status', v_run.status,
    'startedAt', v_run.started_at,
    'leaseExpiresAt', v_run.lease_expires_at,
    'previousAuditRunId', v_run.previous_audit_run_id,
    'reconciliationFrom', v_run.reconciliation_from,
    'scheduleGapSeconds', v_schedule_gap_seconds,
    'missedExpectedRun', coalesce(
      v_schedule_gap_seconds > (p_expected_interval_seconds * 2)::bigint,
      false
    ),
    'mutatesOperationalState', false
  );
end;
$function$;

create or replace function private.complete_truth_audit_run(
  p_audit_run_id uuid,
  p_source_cut_id text,
  p_packet_hash text,
  p_production_packet_hash text,
  p_input_digest text,
  p_metrics jsonb,
  p_findings jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.truth_audit_runs%rowtype;
  v_finding jsonb;
  v_finding_count integer;
  v_evidence_ids text[];
  v_evidence_observation_ids text[];
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode = '28000';
  end if;
  if p_audit_run_id is null
    or coalesce(p_source_cut_id, '') !~ '^(|(?:source-)?cut:v1:[0-9a-f]{64})$'
    or coalesce(p_packet_hash, '') !~ '^(|[0-9a-f]{64})$'
    or coalesce(p_production_packet_hash, '') !~ '^(|[0-9a-f]{64})$'
    or coalesce(p_input_digest, '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_metrics) <> 'object'
    or jsonb_typeof(p_findings) <> 'array'
    or jsonb_array_length(p_findings) > 5000
    or pg_column_size(p_metrics) > 1048576
    or pg_column_size(p_findings) > 33554432
  then
    raise exception 'invalid truth audit completion request' using errcode = '22023';
  end if;

  select * into v_run
  from public.truth_audit_runs run
  where run.audit_run_id = p_audit_run_id
  for update;

  if not found then
    raise exception 'truth audit run not found' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    raise exception 'truth audit run is already final' using errcode = '55000';
  end if;
  if p_source_cut_id <> '' and not exists (
    select 1
    from public.source_cuts cut
    where cut.source_cut_id = p_source_cut_id
      and cut.workspace_key = v_run.workspace_key
  ) then
    raise exception 'truth audit source cut is unavailable' using errcode = '23503';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_findings) finding
    group by finding->>'findingId'
    having count(*) > 1
  ) then
    raise exception 'duplicate truth audit finding in one run' using errcode = '23505';
  end if;

  for v_finding in select value from jsonb_array_elements(p_findings)
  loop
    if jsonb_typeof(v_finding) <> 'object'
      or coalesce(v_finding->>'findingId', '') !~ '^truth-audit:v1:[0-9a-f]{64}$'
      or coalesce(v_finding->>'stage', '') not in (
        'source_cursor', 'gmail_ingest', 'processing', 'source_cut',
        'build_inputs', 'build_parity', 'publication', 'production'
      )
      or coalesce(v_finding->>'severity', '') not in ('blocking', 'attention', 'informational')
      or nullif(trim(coalesce(v_finding->>'classification', '')), '') is null
      or length(v_finding->>'classification') > 200
      or jsonb_typeof(v_finding->'mutatesOperationalState') <> 'boolean'
      or (v_finding->>'mutatesOperationalState')::boolean
      or jsonb_typeof(coalesce(v_finding->'evidenceIds', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(v_finding->'evidenceObservationIds', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(v_finding->'detail', '{}'::jsonb)) <> 'object'
    then
      raise exception 'invalid truth audit finding' using errcode = '22023';
    end if;

    select coalesce(array_agg(value order by value), '{}'::text[])
      into v_evidence_ids
    from jsonb_array_elements_text(coalesce(v_finding->'evidenceIds', '[]'::jsonb));

    select coalesce(array_agg(value order by value), '{}'::text[])
      into v_evidence_observation_ids
    from jsonb_array_elements_text(coalesce(v_finding->'evidenceObservationIds', '[]'::jsonb));

    if exists (
      select 1 from unnest(v_evidence_observation_ids) observation_id
      where observation_id !~ '^obs:v1:[0-9a-f]{64}$'
    ) then
      raise exception 'invalid truth audit finding observation evidence' using errcode = '22023';
    end if;

    insert into public.truth_audit_findings (
      finding_id,
      audit_run_id,
      workspace_key,
      source_cut_id,
      packet_hash,
      production_packet_hash,
      stage,
      severity,
      classification,
      subject_type,
      subject_key,
      evidence_ids,
      evidence_observation_ids,
      detail,
      mutates_operational_state
    ) values (
      v_finding->>'findingId',
      v_run.audit_run_id,
      v_run.workspace_key,
      nullif(p_source_cut_id, ''),
      nullif(p_packet_hash, ''),
      nullif(p_production_packet_hash, ''),
      v_finding->>'stage',
      v_finding->>'severity',
      v_finding->>'classification',
      coalesce(v_finding->>'subjectType', ''),
      coalesce(v_finding->>'subjectKey', ''),
      v_evidence_ids,
      v_evidence_observation_ids,
      v_finding->'detail',
      false
    );
  end loop;

  v_finding_count := jsonb_array_length(p_findings);

  update public.truth_audit_runs
  set source_cut_id = nullif(p_source_cut_id, ''),
      packet_hash = nullif(p_packet_hash, ''),
      production_packet_hash = nullif(p_production_packet_hash, ''),
      input_digest = p_input_digest,
      metrics = p_metrics,
      status = 'succeeded',
      error_code = '',
      error_detail = '',
      finished_at = clock_timestamp()
  where audit_run_id = v_run.audit_run_id;

  return jsonb_build_object(
    'ok', true,
    'auditRunId', v_run.audit_run_id,
    'status', 'succeeded',
    'findingCount', v_finding_count,
    'inputDigest', p_input_digest,
    'mutatesOperationalState', false
  );
end;
$function$;

create or replace function private.fail_truth_audit_run(
  p_audit_run_id uuid,
  p_error_code text,
  p_safe_error_detail text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.truth_audit_runs%rowtype;
  v_safe_detail text;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode = '28000';
  end if;
  if p_audit_run_id is null
    or coalesce(p_error_code, '') !~ '^[A-Z0-9_]{3,100}$'
  then
    raise exception 'invalid truth audit failure request' using errcode = '22023';
  end if;

  select * into v_run
  from public.truth_audit_runs run
  where run.audit_run_id = p_audit_run_id
  for update;

  if not found then
    raise exception 'truth audit run not found' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    raise exception 'truth audit run is already final' using errcode = '55000';
  end if;

  v_safe_detail := left(
    regexp_replace(coalesce(p_safe_error_detail, ''), '[[:cntrl:]]+', ' ', 'g'),
    1000
  );

  update public.truth_audit_runs
  set status = 'failed',
      error_code = p_error_code,
      error_detail = v_safe_detail,
      metrics = jsonb_build_object('mutatesOperationalState', false),
      finished_at = clock_timestamp()
  where audit_run_id = v_run.audit_run_id;

  return jsonb_build_object(
    'ok', true,
    'auditRunId', v_run.audit_run_id,
    'status', 'failed',
    'errorCode', p_error_code,
    'mutatesOperationalState', false
  );
end;
$function$;

-- Public Data API bridges. Their SECURITY DEFINER owner has no table grants;
-- it can execute only the four private audit functions below. This avoids
-- granting anon USAGE on the shared private schema, which would widen access
-- to unrelated privileged functions.
do $block$
begin
  if not exists (select 1 from pg_roles where rolname = 'truth_audit_rpc_owner') then
    create role truth_audit_rpc_owner nologin noinherit nobypassrls;
  end if;
end;
$block$;

-- Supabase's managed migration role is intentionally not a superuser.
-- PostgreSQL therefore requires explicit membership in a newly created role
-- before `ALTER FUNCTION ... OWNER TO` can target that role. Keep NOINHERIT on
-- the constrained owner; this gives only the actual migration administrator
-- SET ROLE authority for this and later forward migrations without widening
-- any Data API runtime grant. Using current_user keeps the migration portable
-- to the native/PGlite proof databases, whose administrator is not `postgres`.
do $block$
begin
  execute format('grant truth_audit_rpc_owner to %I', current_user);
end;
$block$;

create or replace function public.read_truth_audit_snapshot(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.read_truth_audit_snapshot(p_workspace_key, p_row_limit, p_sync_token);
$function$;

create or replace function public.begin_truth_audit_run(
  p_workspace_key text,
  p_audit_mode text,
  p_observer_version text,
  p_model_version text,
  p_lease_seconds integer,
  p_expected_interval_seconds integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.begin_truth_audit_run(
    p_workspace_key, p_audit_mode, p_observer_version, p_model_version,
    p_lease_seconds, p_expected_interval_seconds, p_sync_token
  );
$function$;

create or replace function public.complete_truth_audit_run(
  p_audit_run_id uuid,
  p_source_cut_id text,
  p_packet_hash text,
  p_production_packet_hash text,
  p_input_digest text,
  p_metrics jsonb,
  p_findings jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.complete_truth_audit_run(
    p_audit_run_id, p_source_cut_id, p_packet_hash, p_production_packet_hash,
    p_input_digest, p_metrics, p_findings, p_sync_token
  );
$function$;

create or replace function public.fail_truth_audit_run(
  p_audit_run_id uuid,
  p_error_code text,
  p_safe_error_detail text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.fail_truth_audit_run(
    p_audit_run_id, p_error_code, p_safe_error_detail, p_sync_token
  );
$function$;

-- PostgreSQL also requires the new function owner to have CREATE on the
-- containing schema. Grant it only for the ownership transfer and revoke it
-- immediately afterward; the nologin audit owner retains no schema-creation
-- authority at runtime.
grant create on schema public to truth_audit_rpc_owner;

alter function public.read_truth_audit_snapshot(text, integer, text)
  owner to truth_audit_rpc_owner;
alter function public.begin_truth_audit_run(text, text, text, text, integer, integer, text)
  owner to truth_audit_rpc_owner;
alter function public.complete_truth_audit_run(uuid, text, text, text, text, jsonb, jsonb, text)
  owner to truth_audit_rpc_owner;
alter function public.fail_truth_audit_run(uuid, text, text, text)
  owner to truth_audit_rpc_owner;

revoke create on schema public from truth_audit_rpc_owner;

revoke all on public.truth_audit_runs from public, anon, authenticated;
revoke all on public.truth_audit_findings from public, anon, authenticated;
revoke insert, update, delete on public.truth_audit_runs from service_role;
revoke insert, update, delete on public.truth_audit_findings from service_role;
grant select on public.truth_audit_runs, public.truth_audit_findings to service_role;

revoke all on function private.valid_truth_audit_token(text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_audit_citation_ids(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_audit_snapshot(text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function private.begin_truth_audit_run(text, text, text, text, integer, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_truth_audit_run(uuid, text, text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.fail_truth_audit_run(uuid, text, text, text)
  from public, anon, authenticated, service_role;

grant usage on schema private to truth_audit_rpc_owner;
grant execute on function private.truth_audit_citation_ids(jsonb, text)
  to truth_audit_rpc_owner;
grant execute on function private.read_truth_audit_snapshot(text, integer, text)
  to truth_audit_rpc_owner;
grant execute on function private.begin_truth_audit_run(text, text, text, text, integer, integer, text)
  to truth_audit_rpc_owner;
grant execute on function private.complete_truth_audit_run(uuid, text, text, text, text, jsonb, jsonb, text)
  to truth_audit_rpc_owner;
grant execute on function private.fail_truth_audit_run(uuid, text, text, text)
  to truth_audit_rpc_owner;

revoke all on function public.read_truth_audit_snapshot(text, integer, text)
  from public, authenticated, service_role;
revoke all on function public.begin_truth_audit_run(text, text, text, text, integer, integer, text)
  from public, authenticated, service_role;
revoke all on function public.complete_truth_audit_run(uuid, text, text, text, text, jsonb, jsonb, text)
  from public, authenticated, service_role;
revoke all on function public.fail_truth_audit_run(uuid, text, text, text)
  from public, authenticated, service_role;

grant execute on function public.read_truth_audit_snapshot(text, integer, text) to anon;
grant execute on function public.begin_truth_audit_run(text, text, text, text, integer, integer, text) to anon;
grant execute on function public.complete_truth_audit_run(uuid, text, text, text, text, jsonb, jsonb, text) to anon;
grant execute on function public.fail_truth_audit_run(uuid, text, text, text) to anon;
