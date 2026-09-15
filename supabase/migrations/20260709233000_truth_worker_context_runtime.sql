create extension if not exists pgcrypto with schema extensions;

-- Read-only, fenced context loading for the claim and cross-thread link
-- workers.  Workers never assemble truth context with ad-hoc table reads:
-- each receipt is tied to the exact live lease, immutable observations, and
-- an explicit deterministic bound.

create or replace function private.truth_worker_context_hash(p_value jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select encode(
    extensions.digest(convert_to(p_value::text, 'UTF8'), 'sha256'),
    'hex'
  );
$function$;

revoke all on function private.truth_worker_context_hash(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.truth_worker_canonical_millis(p_value timestamptz)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$function$;

revoke all on function private.truth_worker_canonical_millis(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.truth_worker_awbs(
  p_payload jsonb,
  p_text text
)
returns text[]
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_match text[];
  v_awbs text[] := array[]::text[];
  v_source_awb text;
begin
  -- Structured non-email sources never derive subject scope from display
  -- text.  Their source adapters already pin the exact subject coordinates.
  if p_payload->>'schemaVersion' = 'tracking-source-observation-v1' then
    v_source_awb := regexp_replace(coalesce(p_payload->>'awb', ''), '[^0-9]', '', 'g');
    if v_source_awb ~ '^[0-9]{11}$' then
      return array[v_source_awb];
    end if;
    return array[]::text[];
  end if;

  if p_payload->>'schemaVersion' = 'operator-event-source-observation-v1' then
    if jsonb_typeof(p_payload->'event'->'subject'->'awbs') <> 'array' then
      return array[]::text[];
    end if;
    return coalesce((
      select array_agg(distinct normalized_awb order by normalized_awb)
      from (
        select regexp_replace(awb, '[^0-9]', '', 'g') as normalized_awb
        from jsonb_array_elements_text(p_payload->'event'->'subject'->'awbs') supplied(awb)
      ) normalized
      where normalized_awb ~ '^[0-9]{11}$'
    ), array[]::text[]);
  end if;

  v_source_awb := regexp_replace(
    coalesce(p_payload #>> '{shipment,trackingNumber}', ''), '[^0-9]', '', 'g'
  );
  if v_source_awb ~ '^[0-9]{11}$' then
    v_awbs := array_append(v_awbs, v_source_awb);
  end if;

  for v_match in
    select match
    from regexp_matches(
      coalesce(p_text, '') || E'\n' || coalesce(p_payload->>'subject', ''),
      '(^|[^0-9])([0-9]{3})[-[:space:]]?([0-9]{8})(?=$|[^0-9])',
      'g'
    ) as match
  loop
    v_awbs := array_append(v_awbs, v_match[2] || v_match[3]);
  end loop;

  return coalesce((
    select array_agg(distinct awb order by awb)
    from unnest(v_awbs) as supplied(awb)
    where awb ~ '^[0-9]{11}$'
  ), array[]::text[]);
end;
$function$;

revoke all on function private.truth_worker_awbs(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function private.truth_worker_gmail_addresses(p_payload jsonb)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $function$
  with address_items as (
    select item
    from jsonb_array_elements(
      jsonb_build_array(coalesce(p_payload->'from', 'null'::jsonb))
      || case when jsonb_typeof(p_payload->'to') = 'array'
        then p_payload->'to' else '[]'::jsonb end
      || case when jsonb_typeof(p_payload->'cc') = 'array'
        then p_payload->'cc' else '[]'::jsonb end
      || case when jsonb_typeof(p_payload->'bcc') = 'array'
        then p_payload->'bcc' else '[]'::jsonb end
      || case when jsonb_typeof(p_payload->'replyTo') = 'array'
        then p_payload->'replyTo' else '[]'::jsonb end
    ) item
  ), normalized as (
    select lower(trim(item->>'address')) as address
    from address_items
    where jsonb_typeof(item) = 'object'
  )
  select coalesce(array_agg(distinct address order by address), array[]::text[])
  from normalized
  where address ~ '^[^@[:space:]]+@[^@[:space:]]+$';
$function$;

revoke all on function private.truth_worker_gmail_addresses(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.truth_worker_gmail_domains(p_payload jsonb)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(array_agg(distinct split_part(address, '@', 2)
    order by split_part(address, '@', 2)), array[]::text[])
  from unnest(private.truth_worker_gmail_addresses(p_payload)) supplied(address)
  where split_part(address, '@', 2) <> '';
$function$;

revoke all on function private.truth_worker_gmail_domains(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.assert_truth_worker_context_lease(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_allowed_job_kinds text[]
)
returns public.source_processing_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
begin
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or coalesce(cardinality(p_allowed_job_kinds), 0) = 0 then
    raise exception 'truth worker context lease request is invalid'
      using errcode = '22023';
  end if;

  select job.* into v_job
  from public.source_processing_jobs job
  join public.source_processing_job_lineage lineage
    on lineage.job_id = job.job_id
   and lineage.workspace_key = job.workspace_key
   and lineage.source_system = job.source_system
   and lineage.connection_key = job.connection_key
  join public.source_ingest_batches batch
    on batch.batch_id = lineage.root_batch_id
   and batch.workspace_key = lineage.workspace_key
   and batch.source_system = lineage.source_system
   and batch.connection_key = lineage.connection_key
   and batch.status = 'committed'
   and batch.committed_cursor_version = lineage.source_cursor_version
   and batch.committed_cursor_value = lineage.source_cursor_value
  join public.source_observations observation
    on observation.observation_id = job.observation_id
   and observation.workspace_key = job.workspace_key
   and observation.source_system = job.source_system
   and observation.connection_key = job.connection_key
   and observation.source_object_id = job.source_object_id
   and observation.batch_id = lineage.root_batch_id
   and observation.source_cursor_version = lineage.source_cursor_version
  where job.job_id = p_job_id
    and job.workspace_key = p_workspace_key
    and job.job_kind = any(p_allowed_job_kinds)
    and job.state = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_fence = p_lease_fence
    and job.processor_version = p_processor_version
    and job.lease_expires_at > clock_timestamp()
    and observation.operation = 'content'
    and (
      (
        job.job_kind = 'gmail_extract_message_claims'
        and job.source_system = 'gmail'
        and observation.source_object_type = 'gmail_message_parsed'
        and observation.normalized_payload->>'schemaVersion' = 'gmail-parsed-message-v2'
      )
      or (
        job.job_kind = 'gmail_extract_attachment_claims'
        and job.source_system = 'gmail'
        and observation.source_object_type = 'gmail_attachment_extracted'
        and observation.normalized_payload->>'schemaVersion' = 'gmail-attachment-extracted-v1'
      )
      or (
        job.job_kind = 'tms_extract_claims'
        and job.source_system = 'tms'
        and observation.source_object_type = 'tms_shipment_snapshot'
        and observation.normalized_payload->>'schemaVersion' = 'tms-shipment-source-observation-v1'
      )
      or (
        job.job_kind = 'tracking_extract_claims'
        and job.source_system = 'tracking'
        and observation.source_object_type = 'tracking_shipment_snapshot'
        and observation.normalized_payload->>'schemaVersion' = 'tracking-source-observation-v1'
      )
      or (
        job.job_kind = 'operator_extract_claims'
        and job.source_system = 'operator'
        and observation.source_object_type = 'operator_event'
        and observation.normalized_payload->>'schemaVersion' = 'operator-event-source-observation-v1'
      )
      or (
        job.job_kind = 'gmail_resolve_entity_links'
        and job.source_system = 'gmail'
        and observation.source_object_type = 'gmail_message_parsed'
        and observation.normalized_payload->>'schemaVersion' = 'gmail-parsed-message-v2'
      )
    )
  for share of job, batch, observation;

  if not found then
    raise exception 'truth worker context lease lost or crossed its workspace/evidence lineage'
      using errcode = '40001';
  end if;
  return v_job;
end;
$function$;

revoke all on function private.assert_truth_worker_context_lease(
  text, uuid, text, bigint, text, text[]
) from public, anon, authenticated, service_role;

create or replace function private.load_truth_worker_observation(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_observation public.source_observations%rowtype;
  v_core jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_job := private.assert_truth_worker_context_lease(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    array[
      'gmail_extract_message_claims',
      'gmail_extract_attachment_claims',
      'tms_extract_claims',
      'tracking_extract_claims',
      'operator_extract_claims'
    ]
  );
  select * into strict v_observation
  from public.source_observations
  where observation_id = v_job.observation_id
    and workspace_key = p_workspace_key
    and source_system = v_job.source_system
    and connection_key = v_job.connection_key;

  v_core := jsonb_build_object(
    'schemaVersion', 'truth-worker-observation-receipt-v1',
    'workspaceKey', p_workspace_key,
    'jobId', v_job.job_id,
    'jobKind', v_job.job_kind,
    'workerId', p_worker_id,
    'leaseFence', p_lease_fence,
    'processorVersion', p_processor_version,
    'observation', jsonb_build_object(
      'observationId', v_observation.observation_id,
      'sourceSystem', v_observation.source_system,
      'connectionKey', v_observation.connection_key,
      'sourceObjectType', v_observation.source_object_type,
      'sourceObjectId', v_observation.source_object_id,
      'sourceRevision', v_observation.source_revision,
      'operation', v_observation.operation,
      'contentHash', v_observation.content_hash,
      'sourceRecordedAt', case when v_observation.source_recorded_at is null
        then null else private.truth_worker_canonical_millis(v_observation.source_recorded_at) end,
      'capturedAt', private.truth_worker_canonical_millis(v_observation.captured_at),
      'normalizedPayload', v_observation.normalized_payload,
      'normalizedText', v_observation.normalized_text,
      'sourceFidelity', v_observation.source_fidelity,
      'schemaVersion', v_observation.schema_version,
      'journalSequence', v_observation.journal_seq
    )
  );
  return v_core || jsonb_build_object(
    'ok', true,
    'contextHash', private.truth_worker_context_hash(v_core)
  );
end;
$function$;

revoke all on function private.load_truth_worker_observation(
  text, uuid, text, bigint, text, text
) from public, anon, authenticated, service_role;

create or replace function private.load_truth_claim_worker_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_max_items integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_observation public.source_observations%rowtype;
  v_awbs text[];
  v_subject_awbs text[];
  v_message_id text;
  v_thread_id text;
  v_workgroup_ids text[];
  v_workgroup_id text;
  v_operator_subject jsonb;
  v_operator_event_type text := '';
  v_operator_recorded_at timestamptz;
  v_operator_related_event_id text := '';
  v_operator_related_observation_id text := '';
  v_related_observation public.source_observations%rowtype;
  v_raw_awb_count integer := 0;
  v_database_member_awbs text[] := array[]::text[];
  v_member_awbs text[] := array[]::text[];
  v_observation_awbs text[] := array[]::text[];
  v_linked_thread_ids text[] := array[]::text[];
  v_linked_observation_ids text[] := array[]::text[];
  v_workgroup_context jsonb := 'null'::jsonb;
  v_accepted_claims jsonb := '[]'::jsonb;
  v_claim_count integer := 0;
  v_context_journal_bound bigint;
  v_context_bound jsonb;
  v_core jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_max_items is null or p_max_items < 1 or p_max_items > 2000 then
    raise exception 'truth claim context maximum must be between 1 and 2000'
      using errcode = '22023';
  end if;
  v_job := private.assert_truth_worker_context_lease(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    array[
      'gmail_extract_message_claims',
      'gmail_extract_attachment_claims',
      'tms_extract_claims',
      'tracking_extract_claims',
      'operator_extract_claims'
    ]
  );
  select * into strict v_observation
  from public.source_observations
  where observation_id = v_job.observation_id
    and workspace_key = p_workspace_key
    and source_system = v_job.source_system
    and connection_key = v_job.connection_key;
  v_context_journal_bound := v_observation.journal_seq;

  -- Message claims and entity linking are sibling jobs emitted by the Gmail
  -- parser.  A claim candidate set is immutable once sealed, so allowing the
  -- claim sibling to read before linking succeeds would permanently discard
  -- cross-thread workgroup scope.  A successful job flag alone is not enough:
  -- require the durable resolution run and its exact anchor hash witness.
  if v_job.job_kind = 'gmail_extract_message_claims' then
    select max(context_observation.journal_seq)
    into v_context_journal_bound
    from public.source_processing_job_lineage claim_lineage
      join public.source_processing_job_lineage link_lineage
        on link_lineage.root_batch_id = claim_lineage.root_batch_id
       and link_lineage.root_job_id = claim_lineage.root_job_id
       and link_lineage.parent_job_id is not distinct from claim_lineage.parent_job_id
       and link_lineage.workspace_key = claim_lineage.workspace_key
       and link_lineage.source_system = claim_lineage.source_system
       and link_lineage.connection_key = claim_lineage.connection_key
      join public.source_processing_jobs link_job
        on link_job.job_id = link_lineage.job_id
       and link_job.workspace_key = p_workspace_key
       and link_job.source_system = 'gmail'
       and link_job.connection_key = v_job.connection_key
       and link_job.job_kind = 'gmail_resolve_entity_links'
       and link_job.observation_id = v_observation.observation_id
       and link_job.source_object_id = v_observation.source_object_id
       and link_job.state = 'succeeded'
       and link_job.result->>'schemaVersion' = 'truth-link-worker-result-v1'
       and link_job.result->>'sourceObservationId' = v_observation.observation_id
      join public.truth_link_resolution_runs resolution
        on resolution.job_id = link_job.job_id
       and resolution.workspace_key = p_workspace_key
       and resolution.anchor_observation_id = v_observation.observation_id
      join public.truth_link_resolution_context resolution_context
        on resolution_context.resolution_run_id = resolution.resolution_run_id
      join public.source_observations context_observation
        on context_observation.observation_id = resolution_context.observation_id
       and context_observation.workspace_key = p_workspace_key
       and context_observation.source_system = 'gmail'
       and context_observation.content_hash = resolution_context.observation_content_hash
    where claim_lineage.job_id = v_job.job_id
      and exists (
        select 1
        from public.truth_link_resolution_context resolution_anchor
        where resolution_anchor.resolution_run_id = resolution.resolution_run_id
          and resolution_anchor.observation_id = v_observation.observation_id
          and resolution_anchor.observation_content_hash = v_observation.content_hash
      );
    if v_context_journal_bound is null then
      raise exception 'truth claim context not ready: exact Gmail link sibling has no successful durable resolution'
        using errcode = '55000';
    end if;
  end if;

  v_awbs := private.truth_worker_awbs(
    v_observation.normalized_payload,
    v_observation.normalized_text
  );
  v_message_id := coalesce(v_observation.normalized_payload #>> '{gmail,messageId}', '');
  v_thread_id := coalesce(v_observation.normalized_payload #>> '{gmail,threadId}', '');

  if v_job.source_system = 'tracking' then
    if cardinality(v_awbs) <> 1
      or regexp_replace(coalesce(v_observation.normalized_payload->>'awb', ''), '[^0-9]', '', 'g')
        is distinct from v_awbs[1]
      or v_observation.source_object_id is distinct from v_awbs[1] then
      raise exception 'tracking claim context lacks one exact payload-bound shipment subject'
        using errcode = '23514';
    end if;
  elsif v_job.source_system = 'operator' then
    v_operator_subject := v_observation.normalized_payload->'event'->'subject';
    v_operator_event_type := coalesce(
      v_observation.normalized_payload->'event'->>'eventType', ''
    );
    if jsonb_typeof(v_operator_subject) <> 'object'
      or jsonb_typeof(v_operator_subject->'awbs') <> 'array'
      or not (coalesce(v_operator_subject->>'type', '') = any(array['shipment', 'workgroup']))
      or cardinality(v_awbs) = 0 then
      raise exception 'operator claim context lacks an exact structured subject'
        using errcode = '23514';
    end if;
    select count(*)::integer into v_raw_awb_count
    from jsonb_array_elements_text(v_operator_subject->'awbs') supplied(awb)
    where regexp_replace(awb, '[^0-9]', '', 'g') ~ '^[0-9]{11}$';
    if v_raw_awb_count <> jsonb_array_length(v_operator_subject->'awbs')
      or v_raw_awb_count <> cardinality(v_awbs)
      or (v_operator_subject->>'type' = 'shipment' and cardinality(v_awbs) <> 1)
      or (
        v_operator_subject->>'type' = 'workgroup'
        and (
          coalesce(v_operator_subject->>'workgroupKey', '')
            !~ '^workgroup:v1:[0-9a-f]{64}$'
          or coalesce(v_operator_subject->>'membershipComplete', 'false') <> 'true'
        )
      ) then
      raise exception 'operator claim context subject scope is invalid or duplicated'
        using errcode = '23514';
    end if;
    begin
      v_operator_recorded_at := (
        v_observation.normalized_payload->'event'->>'recordedAt'
      )::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'operator claim context recorded timestamp is invalid'
        using errcode = '23514';
    end;
    if v_operator_recorded_at is null then
      raise exception 'operator claim context recorded timestamp is missing'
        using errcode = '23514';
    end if;

    if v_operator_event_type = any(array['correction', 'revocation']) then
      v_operator_related_event_id := coalesce(
        v_observation.normalized_payload->'event'->'relatedEvent'->>'eventId', ''
      );
      select prior.* into v_related_observation
      from public.source_observations prior
      where prior.workspace_key = p_workspace_key
        and prior.source_system = 'operator'
        and prior.connection_key = v_job.connection_key
        and prior.source_object_type = 'operator_event'
        and prior.operation = 'content'
        and prior.source_object_id = v_operator_related_event_id
        and prior.normalized_payload->'event'->>'sequence'
          = v_observation.normalized_payload->'event'->'relatedEvent'->>'sequence'
        and prior.journal_seq < v_observation.journal_seq
      order by prior.journal_seq desc
      limit 1;
      if not found
        or v_related_observation.normalized_payload->'event'->'subject'
          is distinct from v_operator_subject
        or v_related_observation.normalized_payload->'event'->'assertion'->>'predicate'
          is distinct from v_observation.normalized_payload->'event'->'assertion'->>'predicate' then
        raise exception 'operator correction/revocation crosses its immutable prior subject chain'
          using errcode = '23514';
      end if;
      v_operator_related_observation_id := v_related_observation.observation_id;
    elsif v_operator_event_type <> 'assertion' then
      raise exception 'operator claim context event type is unsupported'
        using errcode = '23514';
    end if;
  end if;

  if v_job.source_system = 'operator'
    and v_operator_subject->>'type' = 'workgroup' then
    v_workgroup_id := v_operator_subject->>'workgroupKey';
    if not exists (
      select 1
      from public.operational_workgroups_v2 workgroup
      join public.operational_workgroup_envelopes envelope
        on envelope.workgroup_id = workgroup.workgroup_id
       and envelope.workspace_key = p_workspace_key
      where workgroup.workgroup_id = v_workgroup_id
        and workgroup.created_at <= v_operator_recorded_at
    ) then
      raise exception 'operator event references a future or unavailable workgroup'
        using errcode = '23514';
    end if;
    v_workgroup_ids := array[v_workgroup_id];
  elsif v_job.source_system = any(array['tracking', 'operator']) then
    v_workgroup_ids := array[]::text[];
  else
    select coalesce(array_agg(distinct workgroup_id order by workgroup_id), array[]::text[])
    into v_workgroup_ids
    from (
      select membership.workgroup_id
      from public.operational_workgroup_memberships membership
      join public.operational_workgroup_envelopes workgroup_envelope
        on workgroup_envelope.workgroup_id = membership.workgroup_id
       and workgroup_envelope.workspace_key = p_workspace_key
      left join public.operational_workgroup_membership_evidence evidence
        on evidence.membership_version_id = membership.membership_version_id
      where membership.decision = 'added'
        and not exists (
          select 1
          from public.operational_workgroup_memberships later
          where later.membership_key = membership.membership_key
            and later.version_no > membership.version_no
        )
        and (
          (v_message_id <> '' and membership.member_type = 'gmail_message'
            and membership.member_key = v_message_id)
          or (v_thread_id <> '' and membership.member_type = 'gmail_thread'
            and membership.member_key = v_thread_id)
          or membership.observation_id = v_observation.observation_id
          or membership.basis_observation_id = v_observation.observation_id
          or evidence.observation_id = v_observation.observation_id
          or (
            v_job.source_system = 'tms'
            and membership.member_type = 'shipment'
            and membership.member_key = any(v_awbs)
          )
        )
    ) relevant_workgroups;
  end if;

  if cardinality(v_workgroup_ids) > 1 then
    raise exception 'claim context has more than one active evidence-bound workgroup'
      using errcode = '21000';
  end if;
  if cardinality(v_workgroup_ids) = 1 then
    v_workgroup_id := v_workgroup_ids[1];

    if v_job.source_system = 'operator' then
      v_member_awbs := v_awbs;
      select coalesce(array_agg(distinct membership.member_key order by membership.member_key), array[]::text[])
      into v_database_member_awbs
      from public.operational_workgroup_memberships membership
      join public.operational_workgroup_membership_envelopes membership_envelope
        on membership_envelope.membership_version_id = membership.membership_version_id
       and membership_envelope.workspace_key = p_workspace_key
       and membership_envelope.workgroup_id = membership.workgroup_id
       and membership_envelope.envelope_hash = membership.content_hash
      where membership.workgroup_id = v_workgroup_id
        and membership.member_type = 'shipment'
        and membership.member_key ~ '^[0-9]{11}$'
        and membership.decision = 'added'
        and membership.recorded_at <= v_operator_recorded_at
        and not exists (
          select 1 from public.operational_workgroup_memberships later
          where later.membership_key = membership.membership_key
            and later.version_no > membership.version_no
            and later.recorded_at <= v_operator_recorded_at
        )
        and exists (
          select 1
          from public.operational_workgroup_membership_evidence evidence
          where evidence.membership_version_id = membership.membership_version_id
        )
        and not exists (
          select 1
          from public.operational_workgroup_membership_evidence evidence
          join public.source_observations evidence_observation
            on evidence_observation.observation_id = evidence.observation_id
          where evidence.membership_version_id = membership.membership_version_id
            and (
              evidence_observation.workspace_key <> p_workspace_key
              or evidence_observation.journal_seq > v_context_journal_bound
            )
        );
      if exists (
        select 1
        from public.operational_workgroup_memberships membership
        join public.operational_workgroup_membership_envelopes membership_envelope
          on membership_envelope.membership_version_id = membership.membership_version_id
         and membership_envelope.workspace_key = p_workspace_key
         and membership_envelope.workgroup_id = membership.workgroup_id
         and membership_envelope.envelope_hash = membership.content_hash
        join public.source_observations basis_observation
          on basis_observation.observation_id = any(array[
            membership.observation_id, membership.basis_observation_id
          ])
        where membership.workgroup_id = v_workgroup_id
          and membership.member_type = 'shipment'
          and membership.member_key = any(v_member_awbs)
          and membership.decision = 'added'
          and membership.recorded_at <= v_operator_recorded_at
          and (
            basis_observation.workspace_key <> p_workspace_key
            or basis_observation.journal_seq > v_context_journal_bound
          )
      ) then
        raise exception 'operator workgroup membership depends on future-journal evidence'
          using errcode = '23514';
      end if;
      if v_database_member_awbs is distinct from v_member_awbs then
        raise exception 'operator workgroup payload differs from durable membership at its journal cut'
          using errcode = '23514';
      end if;
    else
      select coalesce(array_agg(distinct membership.member_key order by membership.member_key), array[]::text[])
      into v_member_awbs
      from public.operational_workgroup_memberships membership
      join public.operational_workgroup_membership_envelopes membership_envelope
        on membership_envelope.membership_version_id = membership.membership_version_id
       and membership_envelope.workspace_key = p_workspace_key
       and membership_envelope.workgroup_id = membership.workgroup_id
       and membership_envelope.envelope_hash = membership.content_hash
      where membership.workgroup_id = v_workgroup_id
        and membership.member_type = 'shipment'
        and membership.member_key ~ '^[0-9]{11}$'
        and membership.decision = 'added'
        and not exists (
          select 1 from public.operational_workgroup_memberships later
          where later.membership_key = membership.membership_key
            and later.version_no > membership.version_no
        );
    end if;

    if cardinality(v_member_awbs) > p_max_items then
      raise exception 'claim workgroup context exceeds its explicit item bound'
        using errcode = '54000';
    end if;
    if cardinality(v_member_awbs) < 2 then
      raise exception 'claim workgroup context does not contain a multi-shipment membership'
        using errcode = '23514';
    end if;

    if v_job.source_system = 'operator' then
      v_observation_awbs := v_awbs;
    else
      select coalesce(array_agg(distinct awb order by awb), array[]::text[])
      into v_observation_awbs
      from (
        select unnest(v_awbs) as awb
        union
        select link.entity_key
        from public.observation_entity_links link
        join public.observation_entity_link_envelopes envelope
          on envelope.link_version_id = link.link_version_id
         and envelope.workspace_key = p_workspace_key
        where link.observation_id = v_observation.observation_id
          and link.entity_type = 'shipment'
          and link.decision = 'linked'
          and not exists (
            select 1 from public.observation_entity_links later
            where later.link_key = link.link_key
              and later.version_no > link.version_no
          )
      ) mentioned
      where awb = any(v_member_awbs);
    end if;

    select coalesce(array_agg(distinct linked.observation_id order by linked.observation_id), array[]::text[])
    into v_linked_observation_ids
    from (
      select v_observation.observation_id as observation_id
      union
      select evidence.observation_id
      from public.operational_workgroup_memberships membership
      join public.operational_workgroup_membership_evidence evidence
        on evidence.membership_version_id = membership.membership_version_id
      where membership.workgroup_id = v_workgroup_id
        and membership.decision = 'added'
        and not exists (
          select 1 from public.operational_workgroup_memberships later
          where later.membership_key = membership.membership_key
            and later.version_no > membership.version_no
        )
      union
      select observation.observation_id
      from public.operational_workgroup_memberships membership
      join public.source_observations observation
        on observation.workspace_key = p_workspace_key
       and observation.source_system = 'gmail'
       and observation.source_object_type = 'gmail_message_parsed'
       and observation.operation = 'content'
       and observation.source_object_id = membership.member_key
      where membership.workgroup_id = v_workgroup_id
        and membership.member_type = 'gmail_message'
        and membership.decision = 'added'
        and not exists (
          select 1 from public.operational_workgroup_memberships later
          where later.membership_key = membership.membership_key
            and later.version_no > membership.version_no
        )
    ) linked
    join public.source_observations bounded_observation
      on bounded_observation.observation_id = linked.observation_id
     and bounded_observation.workspace_key = p_workspace_key
     and bounded_observation.journal_seq <= v_context_journal_bound;

    if cardinality(v_linked_observation_ids) > p_max_items then
      raise exception 'claim workgroup evidence context exceeds its explicit item bound'
        using errcode = '54000';
    end if;

    select coalesce(array_agg(distinct thread_id order by thread_id), array[]::text[])
    into v_linked_thread_ids
    from (
      select v_thread_id as thread_id where v_thread_id <> ''
      union
      select observation.normalized_payload #>> '{gmail,threadId}' as thread_id
      from public.source_observations observation
      where observation.observation_id = any(v_linked_observation_ids)
        and observation.workspace_key = p_workspace_key
        and observation.source_system = 'gmail'
        and observation.source_object_type = 'gmail_message_parsed'
        and nullif(observation.normalized_payload #>> '{gmail,threadId}', '') is not null
    ) threads;

    v_workgroup_context := jsonb_build_object(
      'workgroupId', v_workgroup_id,
      'memberAwbs', to_jsonb(v_member_awbs),
      'observationAwbs', to_jsonb(v_observation_awbs),
      'linkedThreadIds', to_jsonb(v_linked_thread_ids),
      'linkedObservationIds', to_jsonb(v_linked_observation_ids)
    );
  end if;

  v_subject_awbs := coalesce((
    select array_agg(distinct awb order by awb)
    from unnest(v_awbs || v_member_awbs) supplied(awb)
  ), array[]::text[]);

  select count(*)::integer
  into v_claim_count
  from public.accepted_claims claim
  join public.accepted_claim_envelopes envelope
    on envelope.claim_version_id = claim.claim_version_id
   and envelope.workspace_key = p_workspace_key
   and envelope.envelope_hash = claim.claim_content_hash
  join public.source_observations primary_observation
    on primary_observation.observation_id = claim.primary_observation_id
   and primary_observation.workspace_key = p_workspace_key
   and primary_observation.journal_seq <= v_context_journal_bound
  where claim.decision = 'accepted'
    and not exists (
      select 1
      from public.accepted_claim_evidence future_evidence
      join public.source_observations future_observation
        on future_observation.observation_id = future_evidence.observation_id
      where future_evidence.claim_version_id = claim.claim_version_id
        and (
          future_observation.workspace_key <> p_workspace_key
          or future_observation.journal_seq > v_context_journal_bound
        )
    )
    and (
      (claim.subject_type = 'shipment' and claim.subject_key = any(v_subject_awbs))
      or (v_workgroup_id is not null and claim.subject_type = 'workgroup'
        and claim.subject_key = v_workgroup_id)
    );
  if v_claim_count > p_max_items then
    raise exception 'accepted-claim context exceeds its explicit item bound'
      using errcode = '54000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'claimVersionId', claim.claim_version_id,
    'itemHash', claim.claim_content_hash,
    'claimKey', claim.claim_key,
    'versionNo', claim.version_no,
    'subjectType', claim.subject_type,
    'subjectKey', claim.subject_key,
    'predicate', claim.predicate,
    'gate', claim.gate,
    'polarity', claim.polarity,
    'normalizedValue', claim.normalized_value,
    'appliesToAwbs', case
      when claim.subject_type = 'shipment' then jsonb_build_array(claim.subject_key)
      when claim.subject_type = 'workgroup' and claim.subject_key = v_workgroup_id
        then to_jsonb(v_member_awbs)
      else '[]'::jsonb
    end
  ) order by claim.claim_key, claim.version_no, claim.claim_version_id), '[]'::jsonb)
  into v_accepted_claims
  from public.accepted_claims claim
  join public.accepted_claim_envelopes envelope
    on envelope.claim_version_id = claim.claim_version_id
   and envelope.workspace_key = p_workspace_key
   and envelope.envelope_hash = claim.claim_content_hash
  join public.source_observations primary_observation
    on primary_observation.observation_id = claim.primary_observation_id
   and primary_observation.workspace_key = p_workspace_key
   and primary_observation.journal_seq <= v_context_journal_bound
  where claim.decision = 'accepted'
    and not exists (
      select 1
      from public.accepted_claim_evidence future_evidence
      join public.source_observations future_observation
        on future_observation.observation_id = future_evidence.observation_id
      where future_evidence.claim_version_id = claim.claim_version_id
        and (
          future_observation.workspace_key <> p_workspace_key
          or future_observation.journal_seq > v_context_journal_bound
        )
    )
    and (
      (claim.subject_type = 'shipment' and claim.subject_key = any(v_subject_awbs))
      or (v_workgroup_id is not null and claim.subject_type = 'workgroup'
        and claim.subject_key = v_workgroup_id)
    );

  v_context_bound := jsonb_build_object(
    'basis', 'immutable-subject-and-workgroup-membership',
    'sourceObservationId', v_observation.observation_id,
    'sourceObservationContentHash', v_observation.content_hash,
    'journalSequenceInclusive', v_context_journal_bound,
    'subjectAwbs', to_jsonb(v_subject_awbs),
    'workgroupId', coalesce(v_workgroup_id, ''),
    'operatorRelatedEventId', v_operator_related_event_id,
    'operatorRelatedObservationId', v_operator_related_observation_id,
    'maximumItemsPerCollection', p_max_items,
    'acceptedClaimCount', v_claim_count,
    'linkedObservationCount', cardinality(v_linked_observation_ids)
  );
  v_core := jsonb_build_object(
    'schemaVersion', 'truth-claim-worker-context-receipt-v1',
    'workspaceKey', p_workspace_key,
    'jobId', v_job.job_id,
    'jobKind', v_job.job_kind,
    'workerId', p_worker_id,
    'leaseFence', p_lease_fence,
    'processorVersion', p_processor_version,
    'contextBound', v_context_bound,
    'workgroupContext', v_workgroup_context,
    'acceptedClaims', v_accepted_claims
  );
  return v_core || jsonb_build_object(
    'ok', true,
    'contextHash', private.truth_worker_context_hash(v_core)
  );
end;
$function$;

revoke all on function private.load_truth_claim_worker_context(
  text, uuid, text, bigint, text, integer, text
) from public, anon, authenticated, service_role;

create or replace function private.load_truth_link_worker_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_max_observations integer,
  p_window_seconds integer,
  p_internal_domains text[],
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_anchor public.source_observations%rowtype;
  v_journal_bound bigint;
  v_anchor_time timestamptz;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_internal_domains text[];
  v_anchor_external_addresses text[];
  v_anchor_external_domains text[];
  v_context_ids text[];
  v_context_count integer;
  v_observations jsonb;
  v_mentioned_awbs text[];
  v_known_shipments text[];
  v_known_brokers text[];
  v_current_workgroups jsonb := '[]'::jsonb;
  v_workgroup_count integer := 0;
  v_contradictions jsonb := '[]'::jsonb;
  v_contradiction_count integer := 0;
  v_context_bound jsonb;
  v_core jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_max_observations is null or p_max_observations < 1 or p_max_observations > 2000
    or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 604800
    or p_internal_domains is null
    or exists (
      select 1 from unnest(p_internal_domains) domain
      where nullif(trim(coalesce(domain, '')), '') is null
        or lower(trim(domain)) !~ '^[a-z0-9.-]+$'
    ) then
    raise exception 'truth link context bound is invalid' using errcode = '22023';
  end if;
  v_internal_domains := coalesce((
    select array_agg(distinct lower(trim(domain)) order by lower(trim(domain)))
    from unnest(p_internal_domains) supplied(domain)
  ), array[]::text[]);

  v_job := private.assert_truth_worker_context_lease(
    p_workspace_key,
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    array['gmail_resolve_entity_links']
  );
  select * into strict v_anchor
  from public.source_observations
  where observation_id = v_job.observation_id
    and workspace_key = p_workspace_key
    and source_system = 'gmail'
    and connection_key = v_job.connection_key;

  select max(journal_seq) into v_journal_bound
  from public.source_observations
  where workspace_key = p_workspace_key
    and source_system = 'gmail'
    and connection_key = v_job.connection_key;
  if v_journal_bound is null or v_journal_bound < v_anchor.journal_seq then
    raise exception 'truth link context journal bound does not contain its anchor'
      using errcode = '23514';
  end if;

  v_anchor_time := coalesce(v_anchor.source_recorded_at, v_anchor.captured_at);
  v_window_start := v_anchor_time - make_interval(secs => p_window_seconds);
  v_window_end := v_anchor_time + make_interval(secs => p_window_seconds);

  select coalesce(array_agg(address order by address), array[]::text[])
  into v_anchor_external_addresses
  from unnest(private.truth_worker_gmail_addresses(v_anchor.normalized_payload)) supplied(address)
  where not (split_part(address, '@', 2) = any(v_internal_domains));
  select coalesce(array_agg(domain order by domain), array[]::text[])
  into v_anchor_external_domains
  from unnest(private.truth_worker_gmail_domains(v_anchor.normalized_payload)) supplied(domain)
  where not (domain = any(v_internal_domains));

  with latest_messages as (
    select distinct on (observation.source_object_id)
      observation.*,
      coalesce(observation.source_recorded_at, observation.captured_at) as context_time
    from public.source_observations observation
    where observation.workspace_key = p_workspace_key
      and observation.source_system = 'gmail'
      and observation.connection_key = v_job.connection_key
      and observation.source_object_type = 'gmail_message_parsed'
      and observation.operation = 'content'
      and observation.normalized_payload->>'schemaVersion' = 'gmail-parsed-message-v2'
      and observation.journal_seq <= v_journal_bound
    order by observation.source_object_id,
      observation.source_cursor_version desc,
      observation.journal_seq desc,
      observation.observation_id
  ), relevant as (
    select message.*
    from latest_messages message
    where message.observation_id = v_anchor.observation_id
      or (
        message.context_time between v_window_start and v_window_end
        and (
          nullif(message.normalized_payload #>> '{gmail,threadId}', '')
            = nullif(v_anchor.normalized_payload #>> '{gmail,threadId}', '')
          or private.truth_worker_gmail_addresses(message.normalized_payload)
            && v_anchor_external_addresses
          or private.truth_worker_gmail_domains(message.normalized_payload)
            && v_anchor_external_domains
        )
      )
  )
  select array_agg(observation_id order by
    case when observation_id = v_anchor.observation_id then 0 else 1 end,
    abs(extract(epoch from (context_time - v_anchor_time))),
    context_time,
    journal_seq,
    observation_id
  )
  into v_context_ids
  from relevant;

  v_context_count := coalesce(cardinality(v_context_ids), 0);
  if v_context_count = 0 or not (v_anchor.observation_id = any(v_context_ids)) then
    raise exception 'truth link context omitted its anchor' using errcode = '23514';
  end if;
  if v_context_count > p_max_observations then
    raise exception 'truth link context exceeds its explicit observation bound'
      using errcode = '54000';
  end if;

  select jsonb_agg(jsonb_build_object(
    'observationId', observation.observation_id,
    'contentHash', observation.content_hash,
    'sourceSystem', observation.source_system,
    'sourceObjectType', observation.source_object_type,
    'sourceObjectId', observation.source_object_id,
    'sourceRecordedAt', case when observation.source_recorded_at is null
      then null else private.truth_worker_canonical_millis(observation.source_recorded_at) end,
    'capturedAt', private.truth_worker_canonical_millis(observation.captured_at),
    'parsedMessage', observation.normalized_payload
  ) order by ids.ordinality)
  into v_observations
  from unnest(v_context_ids) with ordinality ids(observation_id, ordinality)
  join public.source_observations observation
    on observation.observation_id = ids.observation_id
   and observation.workspace_key = p_workspace_key;

  select coalesce(array_agg(distinct awb order by awb), array[]::text[])
  into v_mentioned_awbs
  from unnest(v_context_ids) context_id
  join public.source_observations observation
    on observation.observation_id = context_id
  cross join lateral unnest(private.truth_worker_awbs(
    observation.normalized_payload,
    observation.normalized_text
  )) mentioned(awb);

  select coalesce(array_agg(distinct awb order by awb), array[]::text[])
  into v_known_shipments
  from unnest(v_mentioned_awbs) mentioned(awb)
  where exists (
      select 1
      from public.source_observations tms
      where tms.workspace_key = p_workspace_key
        and tms.source_system = 'tms'
        and tms.source_object_type = 'tms_shipment_snapshot'
        and tms.operation = 'content'
        and regexp_replace(
          coalesce(tms.normalized_payload #>> '{shipment,trackingNumber}', ''),
          '[^0-9]', '', 'g'
        ) = mentioned.awb
    )
    or exists (
      select 1
      from public.accepted_claims claim
      join public.accepted_claim_envelopes envelope
        on envelope.claim_version_id = claim.claim_version_id
       and envelope.workspace_key = p_workspace_key
       and envelope.envelope_hash = claim.claim_content_hash
      where claim.subject_type = 'shipment'
        and claim.subject_key = mentioned.awb
        and claim.decision = 'accepted'
    )
    or exists (
      select 1
      from public.observation_entity_links link
      join public.observation_entity_link_envelopes envelope
        on envelope.link_version_id = link.link_version_id
       and envelope.workspace_key = p_workspace_key
      where link.entity_type = 'shipment'
        and link.entity_key = mentioned.awb
        and link.decision = 'linked'
        and not exists (
          select 1 from public.observation_entity_links later
          where later.link_key = link.link_key
            and later.version_no > link.version_no
        )
    )
    or exists (
      select 1
      from public.operational_workgroup_memberships membership
      join public.operational_workgroup_envelopes workgroup_envelope
        on workgroup_envelope.workgroup_id = membership.workgroup_id
       and workgroup_envelope.workspace_key = p_workspace_key
      where membership.member_type = 'shipment'
        and membership.member_key = mentioned.awb
        and membership.decision = 'added'
        and not exists (
          select 1 from public.operational_workgroup_memberships later
          where later.membership_key = membership.membership_key
            and later.version_no > membership.version_no
        )
    );

  select coalesce(array_agg(distinct broker_key order by broker_key), array[]::text[])
  into v_known_brokers
  from (
    select 'broker-domain:' || split_part(address, '@', 2) as broker_key
    from unnest(v_context_ids) context_id
    join public.source_observations observation
      on observation.observation_id = context_id
    cross join lateral unnest(
      private.truth_worker_gmail_addresses(observation.normalized_payload)
    ) supplied(address)
    where not (split_part(address, '@', 2) = any(v_internal_domains))
    union
    select 'broker-email:' || address as broker_key
    from unnest(v_context_ids) context_id
    join public.source_observations observation
      on observation.observation_id = context_id
    cross join lateral unnest(
      private.truth_worker_gmail_addresses(observation.normalized_payload)
    ) supplied(address)
    where not (split_part(address, '@', 2) = any(v_internal_domains))
  ) brokers;

  if cardinality(v_known_shipments) > 2000 or cardinality(v_known_brokers) > 2000 then
    raise exception 'truth link entity context exceeds its explicit item bound'
      using errcode = '54000';
  end if;

  select count(*)::integer
  into v_workgroup_count
  from public.operational_workgroups_v2 workgroup
  join public.operational_workgroup_envelopes envelope
    on envelope.workgroup_id = workgroup.workgroup_id
   and envelope.workspace_key = p_workspace_key
  where exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(workgroup.identity_basis->'shipmentKeys') = 'array'
          then workgroup.identity_basis->'shipmentKeys' else '[]'::jsonb end
      ) shipment_key
      where shipment_key = any(v_known_shipments)
    )
    or exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(workgroup.identity_basis->'brokerKeys') = 'array'
          then workgroup.identity_basis->'brokerKeys' else '[]'::jsonb end
      ) broker_key
      where broker_key = any(v_known_brokers)
    );
  if v_workgroup_count > 2000 then
    raise exception 'truth link workgroup context exceeds its explicit item bound'
      using errcode = '54000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'identityKey', workgroup.identity_key,
    'shipmentKeys', case
      when jsonb_typeof(workgroup.identity_basis->'shipmentKeys') = 'array'
        then workgroup.identity_basis->'shipmentKeys' else '[]'::jsonb end,
    'brokerKeys', case
      when jsonb_typeof(workgroup.identity_basis->'brokerKeys') = 'array'
        then workgroup.identity_basis->'brokerKeys' else '[]'::jsonb end,
    'purposes', case
      when jsonb_typeof(workgroup.identity_basis->'purposes') = 'array'
        then workgroup.identity_basis->'purposes' else '[]'::jsonb end
  ) order by workgroup.identity_key), '[]'::jsonb)
  into v_current_workgroups
  from public.operational_workgroups_v2 workgroup
  join public.operational_workgroup_envelopes envelope
    on envelope.workgroup_id = workgroup.workgroup_id
   and envelope.workspace_key = p_workspace_key
  where exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(workgroup.identity_basis->'shipmentKeys') = 'array'
          then workgroup.identity_basis->'shipmentKeys' else '[]'::jsonb end
      ) shipment_key
      where shipment_key = any(v_known_shipments)
    )
    or exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(workgroup.identity_basis->'brokerKeys') = 'array'
          then workgroup.identity_basis->'brokerKeys' else '[]'::jsonb end
      ) broker_key
      where broker_key = any(v_known_brokers)
    );

  with latest_links as (
    select link.*
    from public.observation_entity_links link
    join public.observation_entity_link_envelopes envelope
      on envelope.link_version_id = link.link_version_id
     and envelope.workspace_key = p_workspace_key
    where not exists (
      select 1 from public.observation_entity_links later
      where later.link_key = link.link_key
        and later.version_no > link.version_no
    )
  ), latest_memberships as (
    select membership.*, workgroup.identity_key
    from public.operational_workgroup_memberships membership
    join public.operational_workgroups_v2 workgroup
      on workgroup.workgroup_id = membership.workgroup_id
    join public.operational_workgroup_envelopes envelope
      on envelope.workgroup_id = workgroup.workgroup_id
     and envelope.workspace_key = p_workspace_key
    where not exists (
      select 1 from public.operational_workgroup_memberships later
      where later.membership_key = membership.membership_key
        and later.version_no > membership.version_no
    )
  ), conflicted_proposals as (
    select proposal.*,
      coalesce((
        select decision.reasons
        from public.truth_link_candidate_decisions decision
        where decision.proposal_id = proposal.proposal_id
        order by decision.decision_no desc, decision.decision_version_id desc
        limit 1
      ), '[]'::jsonb) as reasons
    from public.truth_link_candidate_proposals proposal
    where proposal.workspace_key = p_workspace_key
      and (proposal.has_conflict or proposal.membership_change)
      and exists (
        select 1
        from public.truth_link_candidate_evidence evidence
        where evidence.proposal_id = proposal.proposal_id
          and evidence.observation_id = any(v_context_ids)
      )
  ), contradiction_rows as (
    select jsonb_build_object(
      'candidateKey', '',
      'observationId', link.observation_id,
      'entityKey', link.entity_key,
      'workgroupIdentityKey', '',
      'reason', 'latest durable entity-link decision is unlinked'
    ) as contradiction
    from latest_links link
    where link.decision = 'unlinked'
      and (link.observation_id = any(v_context_ids) or link.entity_key = any(v_known_shipments))
    union
    select jsonb_build_object(
      'candidateKey', '',
      'observationId', '',
      'entityKey', membership.member_key,
      'workgroupIdentityKey', membership.identity_key,
      'reason', 'latest durable workgroup membership decision is removed'
    )
    from latest_memberships membership
    where membership.decision = 'removed'
      and (
        membership.member_key = any(v_known_shipments)
        or membership.member_key = any(v_known_brokers)
      )
    union
    select jsonb_build_object(
      'candidateKey', proposal.candidate_key,
      'observationId', '',
      'entityKey', '',
      'workgroupIdentityKey', '',
      'reason', coalesce(proposal.reasons->>0,
        case when proposal.membership_change
          then 'durable link review records a membership change'
          else 'durable link review records a conflict' end)
    )
    from conflicted_proposals proposal
  )
  select count(*)::integer,
    coalesce(jsonb_agg(contradiction order by contradiction::text), '[]'::jsonb)
  into v_contradiction_count, v_contradictions
  from contradiction_rows;
  if v_contradiction_count > 2000 then
    raise exception 'truth link contradiction context exceeds its explicit item bound'
      using errcode = '54000';
  end if;

  v_context_bound := jsonb_build_object(
    'basis', 'anchor-time-and-external-participant-at-journal-sequence',
    'journalSequenceInclusive', v_journal_bound,
    'anchorObservationId', v_anchor.observation_id,
    'anchorContentHash', v_anchor.content_hash,
    'anchorSourceTime', private.truth_worker_canonical_millis(v_anchor_time),
    'windowStartInclusive', private.truth_worker_canonical_millis(v_window_start),
    'windowEndInclusive', private.truth_worker_canonical_millis(v_window_end),
    'windowSecondsEachDirection', p_window_seconds,
    'maximumObservations', p_max_observations,
    'candidateObservationCount', v_context_count,
    'internalDomains', to_jsonb(v_internal_domains)
  );
  v_core := jsonb_build_object(
    'schemaVersion', 'truth-link-worker-context-receipt-v1',
    'workspaceKey', p_workspace_key,
    'jobId', v_job.job_id,
    'jobKind', v_job.job_kind,
    'workerId', p_worker_id,
    'leaseFence', p_lease_fence,
    'processorVersion', p_processor_version,
    'contextBound', v_context_bound,
    'observations', v_observations,
    'knownShipments', to_jsonb(v_known_shipments),
    'knownBrokers', to_jsonb(v_known_brokers),
    'currentWorkgroups', v_current_workgroups,
    'contradictions', v_contradictions
  );
  return v_core || jsonb_build_object(
    'ok', true,
    'contextHash', private.truth_worker_context_hash(v_core)
  );
end;
$function$;

revoke all on function private.load_truth_link_worker_context(
  text, uuid, text, bigint, text, integer, integer, text[], text
) from public, anon, authenticated, service_role;

create or replace function public.load_truth_worker_observation(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.load_truth_worker_observation(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_sync_token
  );
$function$;

create or replace function public.load_truth_claim_worker_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_max_items integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.load_truth_claim_worker_context(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_max_items, p_sync_token
  );
$function$;

create or replace function public.load_truth_link_worker_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_max_observations integer,
  p_window_seconds integer,
  p_internal_domains text[],
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.load_truth_link_worker_context(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_max_observations, p_window_seconds,
    p_internal_domains, p_sync_token
  );
$function$;

revoke all on function public.load_truth_worker_observation(
  text, uuid, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.load_truth_claim_worker_context(
  text, uuid, text, bigint, text, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.load_truth_link_worker_context(
  text, uuid, text, bigint, text, integer, integer, text[], text
) from public, anon, authenticated, service_role;

grant usage on schema private to service_role;
grant execute on function public.load_truth_worker_observation(
  text, uuid, text, bigint, text, text
) to service_role;
grant execute on function public.load_truth_claim_worker_context(
  text, uuid, text, bigint, text, integer, text
) to service_role;
grant execute on function public.load_truth_link_worker_context(
  text, uuid, text, bigint, text, integer, integer, text[], text
) to service_role;

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'source_observations',
    'source_processing_jobs',
    'source_processing_job_lineage',
    'source_ingest_batches',
    'accepted_claims',
    'accepted_claim_evidence',
    'accepted_claim_envelopes',
    'observation_entity_links',
    'observation_entity_link_envelopes',
    'operational_workgroups_v2',
    'operational_workgroup_memberships',
    'operational_workgroup_membership_evidence',
    'operational_workgroup_envelopes',
    'operational_workgroup_membership_envelopes',
    'truth_link_candidate_proposals',
    'truth_link_candidate_evidence',
    'truth_link_candidate_decisions'
  ] loop
    execute format('grant select on public.%I to service_role', v_table);
    execute format(
      'revoke insert, update, delete, truncate on public.%I from service_role',
      v_table
    );
  end loop;
end;
$block$;
