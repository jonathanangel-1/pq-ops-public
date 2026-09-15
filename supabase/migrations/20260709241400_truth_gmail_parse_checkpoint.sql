-- Gmail provider-revision and incremental parse-checkpoint authority.
--
-- Every committed batch contributes one bounded delta to an immutable hash
-- chain. Link and claim jobs remain waiting at attempt zero until later
-- migrations add a canonical link epoch and candidate frontier.

-- -------------------------------------------------------------------------
-- Stable Gmail source cut and incremental parse checkpoint
-- -------------------------------------------------------------------------


alter table public.source_processing_jobs
  drop constraint if exists source_processing_jobs_state_check;
alter table public.source_processing_jobs
  add constraint source_processing_jobs_state_check check (
    state=any(array[
      'queued','leased','retry_wait','waiting_runtime',
      'succeeded','dead_letter','superseded'
    ])
  );

create or replace function private.gmail_model_canonical_history_id_v1(
  p_observation public.source_observations
)
returns numeric
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_value text;
begin
  v_value := coalesce(
    nullif(p_observation.normalized_payload #>> '{gmail,historyId}', ''),
    nullif(p_observation.normalized_payload->>'historyId', ''),
    case when p_observation.source_revision ~ '^[0-9]+$'
      then p_observation.source_revision else null end,
    substring(p_observation.source_revision from '^history:([0-9]+):')
  );
  if v_value is null or v_value !~ '^[0-9]+$' then
    return null;
  end if;
  return v_value::numeric;
end;
$function$;


-- Gmail v2 pages persist provider events first. Materialization routes are
-- synthesized only after the complete page chain is known at commit.
create or replace function private.append_gmail_ingest_page(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
  p_page jsonb,
  p_observations jsonb,
  p_jobs jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_page_ordinal integer := coalesce((p_page->>'pageOrdinal')::integer, 0);
  v_event_digest text;
  v_provider_response jsonb := coalesce(p_page->'providerResponse', 'null'::jsonb);
  v_provider_response_hash text;
  v_provider_event_manifest jsonb := coalesce(p_page->'providerEvents', 'null'::jsonb);
  v_derived_provider_event_manifest jsonb;
  v_provider_event_count integer;
  v_provider_event_distinct_count integer;
  v_observation_manifest jsonb;
  v_job_manifest jsonb;
  v_observation_input_count integer;
  v_observation_distinct_count integer;
  v_job_input_count integer;
  v_job_distinct_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id;
  if not found then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;

  -- Every writer takes the cursor fence before the batch row. This makes lease
  -- replacement and page append mutually exclusive and keeps the same lock
  -- order as begin/commit, avoiding a stale writer or a cursor/batch deadlock.
  select * into v_cursor
  from public.source_cursors
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
  for update;
  if not found
    or v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;

  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id
  for update;
  if not found or v_batch.status <> 'running'
    or v_batch.expected_cursor_version <> v_cursor.cursor_version
    or v_batch.expected_cursor_value is distinct from v_cursor.cursor_value then
    raise exception 'source sync lease lost or batch unavailable' using errcode = '40001';
  end if;
  if v_batch.source_system <> 'gmail' then
    raise exception 'Gmail page append requires a Gmail source batch' using errcode = '23514';
  end if;
  if coalesce(p_page->>'responseMailboxHistoryId', '') !~ '^[0-9]+$'
    or (coalesce(p_page->>'firstHistoryId', '') <> '' and coalesce(p_page->>'firstHistoryId', '') !~ '^[0-9]+$')
    or (coalesce(p_page->>'lastHistoryId', '') <> '' and coalesce(p_page->>'lastHistoryId', '') !~ '^[0-9]+$') then
    raise exception 'Gmail page contains an invalid decimal history ID' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_observations, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_jobs, '[]'::jsonb)) <> 'array' then
    raise exception 'Gmail page observations and jobs must be arrays' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_jobs,'[]'::jsonb))<>0 then
    raise exception 'Gmail v2 pages are observations-only; jobs are sealed at commit'
      using errcode='23514';
  end if;
  if jsonb_typeof(v_provider_response) <> 'object'
    or jsonb_typeof(v_provider_event_manifest) <> 'array'
    or jsonb_typeof(coalesce(v_provider_response->'history', '[]'::jsonb)) <> 'array' then
    raise exception 'Gmail page requires a provider response and event manifest' using errcode = '22023';
  end if;
  if coalesce(v_provider_response->>'historyId', '') is distinct from coalesce(p_page->>'responseMailboxHistoryId', '')
    or coalesce(v_provider_response->>'nextPageToken', '') is distinct from coalesce(p_page->>'responseNextPageToken', '') then
    raise exception 'Gmail provider response does not match page cursor metadata' using errcode = '23514';
  end if;
  select count(*)::integer, count(distinct (item->>'observationId'))::integer
  into v_observation_input_count, v_observation_distinct_count
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item;
  select count(*)::integer, count(distinct (item->>'dedupeKey'))::integer
  into v_job_input_count, v_job_distinct_count
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item;
  select count(*)::integer, count(distinct (item->>'eventId'))::integer
  into v_provider_event_count, v_provider_event_distinct_count
  from jsonb_array_elements(v_provider_event_manifest) item;
  if v_observation_input_count <> v_observation_distinct_count
    or v_job_input_count <> v_job_distinct_count
    or v_provider_event_count <> v_provider_event_distinct_count
    or v_provider_event_count <> v_observation_input_count then
    raise exception 'Gmail page contains duplicate observation or job identities' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_provider_event_manifest) event
    where jsonb_typeof(event) <> 'object'
      or coalesce(event->>'eventId', '') !~ '^gmail-event:v1:[0-9a-f]{64}$'
      or coalesce(event->>'historyId', '') !~ '^[0-9]+$'
      or not (coalesce(event->>'eventType', '') = any (array[
        'message_added', 'message_deleted', 'labels_added', 'labels_removed',
        'message_discovered'
      ]))
      or nullif(event->>'messageId', '') is null
  ) then
    raise exception 'Gmail provider event manifest is invalid' using errcode = '23514';
  end if;
  if (v_batch.mode = 'history' and exists (
    select 1 from jsonb_array_elements(v_provider_event_manifest) event
    where event->>'eventType' = 'message_discovered'
  )) or (v_batch.mode in ('backfill', 'reconciliation') and exists (
    select 1 from jsonb_array_elements(v_provider_event_manifest) event
    where event->>'eventType' <> 'message_discovered'
  )) then
    raise exception 'Gmail provider event type is invalid for the ingest mode' using errcode = '23514';
  end if;
  if (v_batch.mode='history'
      and jsonb_array_length(coalesce(v_provider_response->'messages','[]'::jsonb))<>0)
    or (v_batch.mode in ('backfill','reconciliation')
      and jsonb_array_length(coalesce(v_provider_response->'history','[]'::jsonb))<>0)
    or exists (
      select 1
      from jsonb_array_elements(coalesce(v_provider_response->'history','[]'::jsonb)) history
      where jsonb_typeof(history)<>'object'
        or coalesce(history->>'id','')!~'^[0-9]+$'
    )
    or exists (
      select 1
      from jsonb_array_elements(coalesce(v_provider_response->'messages','[]'::jsonb)) message
      where jsonb_typeof(message)<>'object'
        or nullif(message->>'id','') is null
        or (message ? 'threadId' and jsonb_typeof(message->'threadId')<>'string')
    ) then
    raise exception 'Gmail provider response mode or coordinates are invalid'
      using errcode='23514';
  end if;
  with raw_event_payloads as (
    select jsonb_build_object(
      'schemaVersion','gmail-history-event-v1',
      'eventType',spec.event_type,'historyId',history->>'id',
      'messageId',row->'message'->>'id',
      'threadId',coalesce(row->'message'->>'threadId',''),
      'messageLabelIds',coalesce((
        select jsonb_agg(to_jsonb(label_value) order by label_value)
        from (
          select distinct label#>>'{}' as label_value
          from jsonb_array_elements(coalesce(
            row->'message'->'labelIds','[]'::jsonb
          )) label
        ) labels
      ),'[]'::jsonb),
      'changedLabelIds',coalesce((
        select jsonb_agg(to_jsonb(label_value) order by label_value)
        from (
          select distinct label#>>'{}' as label_value
          from jsonb_array_elements(coalesce(row->'labelIds','[]'::jsonb)) label
        ) labels
      ),'[]'::jsonb)
    ) as payload
    from jsonb_array_elements(coalesce(v_provider_response->'history','[]'::jsonb)) history
    cross join lateral (values
      ('messagesAdded','message_added'),
      ('messagesDeleted','message_deleted'),
      ('labelsAdded','labels_added'),
      ('labelsRemoved','labels_removed')
    ) spec(field_name,event_type)
    cross join lateral jsonb_array_elements(coalesce(
      history->spec.field_name,'[]'::jsonb
    )) row
    union all
    select jsonb_build_object(
      'schemaVersion','gmail-mailbox-discovery-event-v1',
      'eventType','message_discovered',
      'historyId',v_provider_response->>'historyId',
      'messageId',message->>'id',
      'threadId',coalesce(message->>'threadId',''),
      'discoveryMode',v_batch.mode
    )
    from jsonb_array_elements(coalesce(v_provider_response->'messages','[]'::jsonb)) message
  ), distinct_payloads as (
    select distinct payload from raw_event_payloads
  ), derived_events as (
    select jsonb_build_object(
      'eventId','gmail-event:v1:'||encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(payload),'UTF8'
      ),'sha256'),'hex')
    )||payload as event
    from distinct_payloads
  )
  select coalesce(jsonb_agg(event order by event->>'eventId'),'[]'::jsonb)
  into v_derived_provider_event_manifest
  from derived_events;
  if v_provider_event_manifest is distinct from v_derived_provider_event_manifest then
    raise exception 'Gmail provider event manifest is not the exact response projection'
      using errcode='23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_provider_event_manifest) event
    where not (
      (event->>'eventType' = 'message_discovered' and exists (
        select 1 from jsonb_array_elements(coalesce(v_provider_response->'messages', '[]'::jsonb)) message
        where message->>'id' = event->>'messageId'
      ))
      or (event->>'eventType' <> 'message_discovered' and exists (
      select 1
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      where history->>'id' = event->>'historyId'
        and case event->>'eventType'
          when 'message_added' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'messagesAdded', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          when 'message_deleted' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'messagesDeleted', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          when 'labels_added' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'labelsAdded', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          when 'labels_removed' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'labelsRemoved', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          else false
        end
      ))
    )
  ) then
    raise exception 'Gmail event manifest contains an event absent from the provider response' using errcode = '23514';
  end if;
  if exists (
    with provider_events as (
      select history->>'id' as history_id, 'message_added'::text as event_type,
             row->'message'->>'id' as message_id
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'messagesAdded', '[]'::jsonb)) row
      union
      select history->>'id', 'message_deleted', row->'message'->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'messagesDeleted', '[]'::jsonb)) row
      union
      select history->>'id', 'labels_added', row->'message'->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'labelsAdded', '[]'::jsonb)) row
      union
      select history->>'id', 'labels_removed', row->'message'->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'labelsRemoved', '[]'::jsonb)) row
      union
      select coalesce(v_provider_response->>'historyId', ''), 'message_discovered', message->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'messages', '[]'::jsonb)) message
    )
    select 1
    from provider_events provider_event
    left join jsonb_array_elements(v_provider_event_manifest) event
      on event->>'historyId' = provider_event.history_id
     and event->>'eventType' = provider_event.event_type
     and event->>'messageId' = provider_event.message_id
    where event is null
  ) then
    raise exception 'Gmail provider response contains an unmapped event' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_provider_event_manifest) event
    left join jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) observation
      on observation->'normalizedPayload'->>'eventId' = event->>'eventId'
    where observation is null
      or observation->'normalizedPayload'->>'eventType' is distinct from event->>'eventType'
      or observation->'normalizedPayload'->>'historyId' is distinct from event->>'historyId'
      or observation->'normalizedPayload'->>'messageId' is distinct from event->>'messageId'
  ) or exists (
    select 1
    from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) observation
    left join jsonb_array_elements(v_provider_event_manifest) event
      on event->>'eventId' = observation->'normalizedPayload'->>'eventId'
    where event is null
  ) then
    raise exception 'Gmail provider events are not fully mapped to observations' using errcode = '23514';
  end if;
  v_provider_response_hash := encode(extensions.digest(
    convert_to(v_provider_response::text, 'UTF8'), 'sha256'
  ), 'hex');
  select coalesce(jsonb_agg(item - 'capturedAt' order by item->>'observationId'), '[]'::jsonb)
  into v_observation_manifest
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item;
  select coalesce(jsonb_agg(item order by item->>'dedupeKey'), '[]'::jsonb)
  into v_job_manifest
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item;
  v_event_digest := encode(extensions.digest(convert_to(jsonb_build_object(
    'pageOrdinal', v_page_ordinal,
    'requestPageToken', coalesce(p_page->>'requestPageToken', ''),
    'responseNextPageToken', coalesce(p_page->>'responseNextPageToken', ''),
    'responseMailboxHistoryId', coalesce(p_page->>'responseMailboxHistoryId', ''),
    'firstHistoryId', coalesce(p_page->>'firstHistoryId', ''),
    'lastHistoryId', coalesce(p_page->>'lastHistoryId', ''),
    'isFinal', coalesce((p_page->>'isFinal')::boolean, false),
    'providerResponseHash', v_provider_response_hash,
    'providerEvents', v_provider_event_manifest,
    'observations', v_observation_manifest,
    'jobs', v_job_manifest
  )::text, 'UTF8'), 'sha256'), 'hex');

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
    join public.source_observations existing
      on existing.workspace_key = v_batch.workspace_key
     and existing.source_system = v_batch.source_system
     and existing.connection_key = v_batch.connection_key
     and existing.source_object_type = item->>'sourceObjectType'
     and existing.source_object_id = item->>'sourceObjectId'
     and existing.source_revision = coalesce(item->>'sourceRevision', '')
     and existing.operation = coalesce(item->>'operation', 'content')
    where existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source coordinate hash conflict' using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
    join public.source_observations existing
      on existing.observation_id = item->>'observationId'
    where existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.source_object_type is distinct from item->>'sourceObjectType'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.source_revision is distinct from coalesce(item->>'sourceRevision', '')
      or existing.operation is distinct from coalesce(item->>'operation', 'content')
      or existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source observation identity conflict' using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item
    join public.source_processing_jobs existing
      on existing.dedupe_key = item->>'dedupeKey'
    where existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.job_kind is distinct from item->>'jobKind'
      or existing.source_object_id is distinct from coalesce(item->>'sourceObjectId', '')
      or existing.observation_id::text is distinct from nullif(item->>'observationId', '')
  ) then
    raise exception 'source processing job identity conflict' using errcode = '23505';
  end if;

  insert into public.gmail_ingest_pages (
    batch_id, page_ordinal, request_page_token, response_next_page_token,
    response_mailbox_history_id, first_history_id, last_history_id,
    provider_response, provider_response_hash, provider_event_manifest,
    event_count, job_count, event_digest, is_final
  ) values (
    p_batch_id,
    v_page_ordinal,
    coalesce(p_page->>'requestPageToken', ''),
    coalesce(p_page->>'responseNextPageToken', ''),
    coalesce(p_page->>'responseMailboxHistoryId', ''),
    coalesce(p_page->>'firstHistoryId', ''),
    coalesce(p_page->>'lastHistoryId', ''),
    v_provider_response,
    v_provider_response_hash,
    v_provider_event_manifest,
    v_provider_event_count,
    v_job_input_count,
    v_event_digest,
    coalesce((p_page->>'isFinal')::boolean, false)
  ) on conflict (batch_id, page_ordinal) do nothing;

  if exists (
    select 1 from public.gmail_ingest_pages
    where batch_id = p_batch_id and page_ordinal = v_page_ordinal
      and (
        request_page_token is distinct from coalesce(p_page->>'requestPageToken', '')
        or response_next_page_token is distinct from coalesce(p_page->>'responseNextPageToken', '')
        or response_mailbox_history_id is distinct from coalesce(p_page->>'responseMailboxHistoryId', '')
        or first_history_id is distinct from coalesce(p_page->>'firstHistoryId', '')
        or last_history_id is distinct from coalesce(p_page->>'lastHistoryId', '')
        or provider_response_hash is distinct from v_provider_response_hash
        or provider_event_manifest is distinct from v_provider_event_manifest
        or event_count is distinct from v_provider_event_count
        or job_count is distinct from v_job_input_count
        or event_digest is distinct from v_event_digest
        or is_final is distinct from coalesce((p_page->>'isFinal')::boolean, false)
      )
  ) then
    raise exception 'Gmail page replay conflict' using errcode = '23505';
  end if;

  insert into public.source_observations (
    observation_id, workspace_key, source_system, connection_key,
    source_object_type, source_object_id, source_revision, operation,
    source_cursor_version, batch_id, content_hash, source_recorded_at,
    captured_at, normalized_payload, normalized_text, source_fidelity,
    schema_version
  )
  select
    item->>'observationId', v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    item->>'sourceObjectType', item->>'sourceObjectId', coalesce(item->>'sourceRevision', ''),
    coalesce(item->>'operation', 'content'), v_batch.expected_cursor_version + 1,
    p_batch_id, item->>'contentHash', nullif(item->>'sourceRecordedAt', '')::timestamptz,
    clock_timestamp(),
    coalesce(item->'normalizedPayload', '{}'::jsonb), coalesce(item->>'normalizedText', ''),
    coalesce(item->>'sourceFidelity', 'normalized_source'),
    coalesce(item->>'schemaVersion', 'source-observation-v1')
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
  on conflict do nothing;

  insert into public.gmail_ingest_page_observations (
    batch_id, page_ordinal, observation_id
  )
  select p_batch_id, v_page_ordinal, existing.observation_id
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
  join public.source_observations existing
    on existing.observation_id = item->>'observationId'
  on conflict do nothing;

  if (
    select count(*)::integer
    from public.gmail_ingest_page_observations
    where batch_id = p_batch_id and page_ordinal = v_page_ordinal
  ) <> v_observation_input_count then
    raise exception 'Gmail page observation persistence is incomplete' using errcode = '23514';
  end if;

  insert into public.source_processing_jobs (
    dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, max_attempts, payload
  )
  select
    item->>'dedupeKey', v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    item->>'jobKind', nullif(item->>'observationId', ''), coalesce(item->>'sourceObjectId', ''),
    coalesce((item->>'maxAttempts')::integer, 5),
    jsonb_set(coalesce(item->'payload', '{}'::jsonb), '{batchId}', to_jsonb(p_batch_id::text), true)
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item
  on conflict (dedupe_key) do nothing;

  insert into public.gmail_ingest_page_jobs (
    batch_id, page_ordinal, job_id, dedupe_key
  )
  select p_batch_id, v_page_ordinal, existing.job_id, existing.dedupe_key
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item
  join public.source_processing_jobs existing
    on existing.dedupe_key = item->>'dedupeKey'
  on conflict do nothing;

  if (
    select count(*)::integer
    from public.gmail_ingest_page_jobs
    where batch_id = p_batch_id and page_ordinal = v_page_ordinal
  ) <> v_job_input_count then
    raise exception 'Gmail page job persistence is incomplete' using errcode = '23514';
  end if;

  update public.source_ingest_batches b
  set page_count = counts.page_count,
      observation_count = counts.observation_count,
      job_count = counts.job_count
  from (
    select
      (select count(*)::integer from public.gmail_ingest_pages where batch_id = p_batch_id) as page_count,
      (select count(distinct observation_id)::integer from public.gmail_ingest_page_observations where batch_id = p_batch_id) as observation_count,
      (select count(distinct job_id)::integer from public.gmail_ingest_page_jobs where batch_id = p_batch_id) as job_count
  ) counts
  where b.batch_id = p_batch_id;

  return jsonb_build_object(
    'ok', true,
    'batchId', p_batch_id,
    'pageOrdinal', v_page_ordinal,
    'eventDigest', v_event_digest,
    'observationCount', v_observation_input_count,
    'jobCount', v_job_input_count
  );
end;
$function$;


-- A checkpoint stores only one committed batch delta.  The cumulative proof is
-- a fixed-size hash chain, never a copy of every earlier page or prerequisite.
create unique index if not exists source_ingest_batches_workspace_batch_uq
  on public.source_ingest_batches(workspace_key,batch_id);
create unique index if not exists source_processing_jobs_workspace_job_uq
  on public.source_processing_jobs(workspace_key,job_id);

create table if not exists public.gmail_message_revision_obligations (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  obligation_id text not null unique check (
    obligation_id~'^gmail-message-revision-obligation:v1:[0-9a-f]{64}$'
  ),
  fetch_job_id uuid not null,
  root_batch_id uuid not null,
  connection_key text not null,
  message_id text not null check(message_id<>''),
  thread_id text not null default '',
  trigger_observation_id text not null,
  trigger_history_id text not null check(trigger_history_id~'^[0-9]+$'),
  source_cursor_version bigint not null check(source_cursor_version>0),
  source_cursor_value text not null check(source_cursor_value~'^[0-9]+$'),
  provider_history_id text not null default '' check(
    provider_history_id='' or provider_history_id~'^[0-9]+$'
  ),
  provider_history_value_hash text not null check(
    provider_history_value_hash~'^[0-9a-f]{64}$'
  ),
  reason_code text not null check(reason_code=any(array[
    'PROVIDER_HISTORY_ID_MISSING','PROVIDER_HISTORY_ID_MALFORMED',
    'PROVIDER_HISTORY_ID_AHEAD_OF_COMMITTED_CUT',
    'PROVIDER_HISTORY_ID_BEHIND_TRIGGER',
    'PROVIDER_MESSAGE_DELETED_UNAVAILABLE','FETCH_POISON_QUARANTINED_REVIEW'
  ])),
  canonical_obligation jsonb not null check(jsonb_typeof(canonical_obligation)='object'),
  obligation_hash text not null unique check(obligation_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-message-revision-obligation-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,fetch_job_id),
  unique(workspace_key,obligation_id),
  foreign key(workspace_key,fetch_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,trigger_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check(obligation_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_obligation),'UTF8'
  ),'sha256'),'hex')),
  check(obligation_id='gmail-message-revision-obligation:v1:'||obligation_hash)
);

create table if not exists public.gmail_message_revision_resolutions (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  resolution_id text not null unique check(
    resolution_id~'^gmail-message-revision-resolution:v1:[0-9a-f]{64}$'
  ),
  obligation_id text not null,
  superseded_fetch_job_id uuid not null,
  resolution_kind text not null check(resolution_kind=any(array[
    'later_parsed_exact_revision','later_provider_deletion'
  ])),
  resolving_group_id text not null,
  resolving_group_hash text not null check(
    resolving_group_hash~'^[0-9a-f]{64}$'
  ),
  resolving_receipt_id text not null default '',
  resolving_receipt_hash text not null default '' check(
    resolving_receipt_hash='' or resolving_receipt_hash~'^[0-9a-f]{64}$'
  ),
  resolving_fetch_job_id uuid,
  resolving_root_batch_id uuid not null,
  resolving_source_cursor_version bigint not null check(
    resolving_source_cursor_version>0
  ),
  resolving_source_cursor_value text not null check(
    resolving_source_cursor_value~'^[0-9]+$'
  ),
  provider_history_id text not null check(provider_history_id~'^[0-9]+$'),
  resolution_observation_id text not null,
  canonical_resolution jsonb not null check(jsonb_typeof(canonical_resolution)='object'),
  resolution_hash text not null unique check(resolution_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-message-revision-resolution-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,obligation_id),
  unique(workspace_key,superseded_fetch_job_id),
  foreign key(workspace_key,obligation_id)
    references public.gmail_message_revision_obligations(workspace_key,obligation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,superseded_fetch_job_id)
    references public.gmail_message_revision_obligations(workspace_key,fetch_job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,resolving_fetch_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,resolving_root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,resolution_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check(
    (resolution_kind='later_parsed_exact_revision'
      and resolving_fetch_job_id is not null
      and resolving_receipt_id<>'' and resolving_receipt_hash<>'')
    or
    (resolution_kind='later_provider_deletion'
      and resolving_fetch_job_id is null
      and resolving_receipt_id='' and resolving_receipt_hash='')
  ),
  check(resolution_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_resolution),'UTF8'
  ),'sha256'),'hex')),
  check(resolution_id='gmail-message-revision-resolution:v1:'||resolution_hash)
);

create index if not exists gmail_revision_resolution_root_idx
  on public.gmail_message_revision_resolutions(
    workspace_key,resolving_root_batch_id,obligation_id
  );
create index if not exists gmail_completeness_gap_checkpoint_delta_idx
  on public.gmail_completeness_gaps(
    workspace_key,connection_key,detected_at,gap_id
  );

create or replace function private.truth_deterministic_uuid_v1(p_hash text)
returns uuid language sql immutable security invoker set search_path=''
as $function$
  select (
    substr(p_hash,1,8)||'-'||substr(p_hash,9,4)||'-5'||substr(p_hash,14,3)
    ||'-a'||substr(p_hash,18,3)||'-'||substr(p_hash,21,12)
  )::uuid
  where p_hash~'^[0-9a-f]{64}$';
$function$;
revoke all on function private.truth_deterministic_uuid_v1(text)
  from public,anon,authenticated,service_role;

create table if not exists public.gmail_message_materialization_groups (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  root_batch_id uuid not null,
  group_id text not null unique check(
    group_id~'^gmail-materialization-group:v1:[0-9a-f]{64}$'
  ),
  connection_key text not null,
  source_cursor_version bigint not null check(source_cursor_version>0),
  source_cursor_value text not null check(source_cursor_value~'^[0-9]+$'),
  message_id text not null check(message_id<>''),
  thread_id text not null default '',
  selected_observation_id text not null,
  selected_observation_content_hash text not null check(
    selected_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  selected_trigger_kind text not null check(
    selected_trigger_kind=any(array['history_event','mailbox_discovery'])
  ),
  selected_event_type text not null check(selected_event_type=any(array[
    'message_added','message_deleted','labels_added','labels_removed',
    'message_discovered'
  ])),
  selected_history_id text not null check(selected_history_id~'^[0-9]+$'),
  route_disposition text not null check(route_disposition=any(array[
    'materialize_revision','deleted_at_cut'
  ])),
  materialization_job_id uuid,
  coverage_count integer not null check(coverage_count>0),
  coverage_manifest_hash text not null check(
    coverage_manifest_hash~'^[0-9a-f]{64}$'
  ),
  canonical_group jsonb not null check(jsonb_typeof(canonical_group)='object'),
  group_hash text not null unique check(group_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-message-materialization-group-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,root_batch_id,message_id),
  unique(workspace_key,group_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,selected_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,materialization_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check((route_disposition='materialize_revision')
    =(materialization_job_id is not null)),
  check(materialization_job_id is null or materialization_job_id=
    private.truth_deterministic_uuid_v1(group_hash)),
  check(group_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_group),'UTF8'
  ),'sha256'),'hex')),
  check(group_id='gmail-materialization-group:v1:'||group_hash)
);

create table if not exists public.gmail_message_materialization_coverage (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  group_id text not null,
  root_batch_id uuid not null,
  page_ordinal integer not null check(page_ordinal>=0),
  trigger_observation_id text not null,
  trigger_observation_content_hash text not null check(
    trigger_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  trigger_kind text not null check(
    trigger_kind=any(array['history_event','mailbox_discovery'])
  ),
  event_type text not null,
  history_id text not null check(history_id~'^[0-9]+$'),
  coverage_disposition text not null check(coverage_disposition=any(array[
    'selected_trigger','coalesced_same_root'
  ])),
  canonical_coverage jsonb not null check(jsonb_typeof(canonical_coverage)='object'),
  coverage_hash text not null unique check(coverage_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-message-materialization-coverage-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,group_id,page_ordinal,trigger_observation_id),
  foreign key(workspace_key,group_id)
    references public.gmail_message_materialization_groups(workspace_key,group_id)
    on update restrict on delete restrict,
  foreign key(root_batch_id,page_ordinal,trigger_observation_id)
    references public.gmail_ingest_page_observations(
      batch_id,page_ordinal,observation_id
    ) on update restrict on delete restrict,
  check(coverage_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_coverage),'UTF8'
  ),'sha256'),'hex'))
);

create table if not exists public.gmail_batch_materialization_route_seals (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  root_batch_id uuid not null,
  seal_id text not null unique check(
    seal_id~'^gmail-materialization-route-seal:v1:[0-9a-f]{64}$'
  ),
  connection_key text not null,
  route_count integer not null check(route_count>=0),
  materialization_count integer not null check(materialization_count>=0),
  deleted_count integer not null check(deleted_count>=0),
  route_manifest_hash text not null check(route_manifest_hash~'^[0-9a-f]{64}$'),
  canonical_seal jsonb not null check(jsonb_typeof(canonical_seal)='object'),
  seal_hash text not null unique check(seal_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-materialization-route-seal-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,root_batch_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(route_count=materialization_count+deleted_count),
  check(seal_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_seal),'UTF8'
  ),'sha256'),'hex')),
  check(seal_id='gmail-materialization-route-seal:v1:'||seal_hash)
);

create table if not exists public.gmail_message_materialization_receipts (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  receipt_id text not null unique check(
    receipt_id~'^gmail-materialization-receipt:v1:[0-9a-f]{64}$'
  ),
  group_id text not null,
  group_hash text not null check(group_hash~'^[0-9a-f]{64}$'),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check(source_cursor_version>0),
  source_cursor_value text not null check(source_cursor_value~'^[0-9]+$'),
  message_id text not null check(message_id<>''),
  provider_history_id text not null check(provider_history_id~'^[0-9]+$'),
  disposition text not null check(disposition=any(array[
    'first_materialized','prior_exact_revision_reobserved'
  ])),
  evidence_owner_group_id text not null,
  evidence_owner_group_hash text not null check(
    evidence_owner_group_hash~'^[0-9a-f]{64}$'
  ),
  evidence_owner_source_cursor_version bigint not null check(
    evidence_owner_source_cursor_version>0
  ),
  evidence_owner_source_cursor_value text not null check(
    evidence_owner_source_cursor_value~'^[0-9]+$'
  ),
  raw_observation_id text not null,
  raw_observation_content_hash text not null check(
    raw_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  parse_job_id uuid not null,
  canonical_receipt jsonb not null check(jsonb_typeof(canonical_receipt)='object'),
  receipt_hash text not null unique check(receipt_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-materialization-receipt-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,group_id),
  unique(workspace_key,root_batch_id,message_id),
  foreign key(workspace_key,group_id)
    references public.gmail_message_materialization_groups(workspace_key,group_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,evidence_owner_group_id)
    references public.gmail_message_materialization_groups(workspace_key,group_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,raw_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parse_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(evidence_owner_source_cursor_version<=source_cursor_version),
  check((disposition='first_materialized')=(group_id=evidence_owner_group_id)),
  check(receipt_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_receipt),'UTF8'
  ),'sha256'),'hex')),
  check(receipt_id='gmail-materialization-receipt:v1:'||receipt_hash)
);

create index if not exists gmail_materialization_receipt_revision_idx
  on public.gmail_message_materialization_receipts(
    workspace_key,message_id,provider_history_id,
    evidence_owner_source_cursor_version,evidence_owner_group_id
  );
create unique index if not exists gmail_materialization_first_revision_uq
  on public.gmail_message_materialization_receipts(
    workspace_key,message_id,provider_history_id
  ) where disposition='first_materialized';

alter table public.gmail_message_revision_resolutions
  drop constraint if exists gmail_revision_resolution_group_fk;
alter table public.gmail_message_revision_resolutions
  add constraint gmail_revision_resolution_group_fk
  foreign key(workspace_key,resolving_group_id)
  references public.gmail_message_materialization_groups(workspace_key,group_id)
  on update restrict on delete restrict;

create table if not exists public.gmail_parse_processing_epochs (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  epoch_id text not null unique check(
    epoch_id~'^gmail-parse-processing-epoch:v1:[0-9a-f]{64}$'
  ),
  genesis_root_batch_id uuid not null,
  genesis_source_cursor_version bigint not null check(
    genesis_source_cursor_version>0
  ),
  genesis_source_cursor_value text not null check(
    genesis_source_cursor_value~'^[0-9]+$'
  ),
  legacy_batch_count bigint not null check(legacy_batch_count>=0),
  legacy_batch_manifest_hash text not null check(
    legacy_batch_manifest_hash~'^[0-9a-f]{64}$'
  ),
  genesis_route_seal_id text not null,
  genesis_route_seal_hash text not null check(
    genesis_route_seal_hash~'^[0-9a-f]{64}$'
  ),
  canonical_epoch jsonb not null check(jsonb_typeof(canonical_epoch)='object'),
  epoch_hash text not null unique check(epoch_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-parse-processing-epoch-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,connection_key),
  unique(workspace_key,genesis_root_batch_id),
  foreign key(workspace_key,genesis_root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(epoch_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_epoch),'UTF8'
  ),'sha256'),'hex')),
  check(epoch_id='gmail-parse-processing-epoch:v1:'||epoch_hash)
);

create or replace function private.gmail_materialization_group_job_valid_v1(
  p_job public.source_processing_jobs,
  p_lineage public.source_processing_job_lineage,
  p_group public.gmail_message_materialization_groups,
  p_anchor public.source_observations
)
returns boolean
language sql
stable
security invoker
set search_path=''
as $function$
  select p_job.source_system='gmail'
    and p_job.job_kind='gmail_materialize_message_revision'
    and p_job.observation_id is null
    and p_job.source_object_id=p_group.message_id
    and p_job.job_id=p_group.materialization_job_id
    and p_job.payload->>'schemaVersion'
      ='gmail-materialize-message-revision-job-v1'
    and private.truth_jsonb_has_only_keys(p_job.payload,array[
      'schemaVersion','groupId','messageId','materializerVersion','requestedFormat'
    ])
    and (select count(*) from jsonb_object_keys(p_job.payload))=5
    and p_job.payload->>'groupId'=p_group.group_id
    and p_job.payload->>'messageId'=p_group.message_id
    and p_job.payload->>'materializerVersion'
      ='gmail-message-revision-materializer-v1'
    and p_job.payload->>'requestedFormat'='raw'
    and p_group.route_disposition='materialize_revision'
    and p_group.selected_event_type<>'message_deleted'
    and p_lineage.job_id=p_job.job_id
    and p_lineage.root_batch_id=p_group.root_batch_id
    and p_lineage.parent_job_id is null
    and p_lineage.root_job_id=p_job.job_id
    and p_lineage.source_cursor_version=p_group.source_cursor_version
    and p_lineage.source_cursor_value=p_group.source_cursor_value
    and p_anchor.observation_id=p_group.selected_observation_id
    and p_anchor.content_hash=p_group.selected_observation_content_hash
    and p_anchor.source_system='gmail'
    and p_anchor.connection_key=p_group.connection_key
    and p_anchor.source_object_id=p_group.message_id
    and p_anchor.normalized_payload->>'historyId'=p_group.selected_history_id
    and p_anchor.normalized_payload->>'eventType'=p_group.selected_event_type
    and exists (
      select 1 from public.gmail_message_materialization_coverage coverage
      where coverage.workspace_key=p_group.workspace_key
        and coverage.group_id=p_group.group_id
        and coverage.trigger_observation_id=p_group.selected_observation_id
        and coverage.coverage_disposition='selected_trigger'
    );
$function$;

revoke all on function private.gmail_materialization_group_job_valid_v1(
  public.source_processing_jobs,public.source_processing_job_lineage,
  public.gmail_message_materialization_groups,public.source_observations
) from public,anon,authenticated,service_role;

create or replace function private.load_gmail_materialization_authority_v1(
  p_workspace_key text,p_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_group public.gmail_message_materialization_groups%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_seal public.gmail_batch_materialization_route_seals%rowtype;
begin
  select group_row.* into strict v_group
  from public.gmail_message_materialization_groups group_row
  where group_row.workspace_key=p_workspace_key
    and group_row.materialization_job_id=p_job_id
    and group_row.route_disposition='materialize_revision';
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=v_group.root_batch_id
    and status='committed' and batch_hash~'^[0-9a-f]{64}$';
  select * into strict v_seal
  from public.gmail_batch_materialization_route_seals
  where workspace_key=p_workspace_key and root_batch_id=v_group.root_batch_id;
  return jsonb_build_object(
    'schemaVersion','gmail-materialization-claim-authority-v1',
    'groupId',v_group.group_id,'groupHash',v_group.group_hash,
    'routeSealId',v_seal.seal_id,'routeSealHash',v_seal.seal_hash,
    'rootBatchId',v_group.root_batch_id,'rootBatchHash',v_batch.batch_hash,
    'connectionKey',v_group.connection_key,
    'sourceCursorVersion',v_group.source_cursor_version,
    'sourceCursorValue',v_group.source_cursor_value,
    'messageId',v_group.message_id,
    'threadId',v_group.thread_id,
    'selectedTrigger',jsonb_build_object(
      'observationId',v_group.selected_observation_id,
      'contentHash',v_group.selected_observation_content_hash,
      'kind',v_group.selected_trigger_kind,
      'eventType',v_group.selected_event_type,
      'historyId',v_group.selected_history_id
    ),
    'coverageManifestId','gmail-materialization-coverage-manifest:v1:'
      ||v_group.coverage_manifest_hash,
    'coverageManifestHash',v_group.coverage_manifest_hash,
    'coverageCount',v_group.coverage_count,
    'materializerVersion','gmail-message-revision-materializer-v1'
  );
end;
$function$;

revoke all on function private.load_gmail_materialization_authority_v1(text,uuid)
  from public,anon,authenticated,service_role;

create table if not exists public.gmail_parse_checkpoint_obligations (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  obligation_id text not null unique check(
    obligation_id~'^gmail-parse-checkpoint-obligation:v1:[0-9a-f]{64}$'
  ),
  root_batch_id uuid not null,
  job_id uuid not null,
  obligation_kind text not null check(obligation_kind=any(array[
    'FETCH_CONTRACT_INVALID','FETCH_OUTPUT_CONFLICT','PARSE_CONTRACT_INVALID',
    'PARSED_OUTPUT_CONFLICT','LINK_CONTEXT_OVERFLOW'
  ])),
  canonical_obligation jsonb not null check(jsonb_typeof(canonical_obligation)='object'),
  obligation_hash text not null unique check(obligation_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(
    schema_version='gmail-parse-checkpoint-obligation-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,root_batch_id,job_id,obligation_kind),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check(obligation_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_obligation),'UTF8'
  ),'sha256'),'hex')),
  check(obligation_id='gmail-parse-checkpoint-obligation:v1:'||obligation_hash)
);

create table if not exists public.gmail_parse_checkpoint_members (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  root_batch_id uuid not null,
  group_id text not null,
  group_hash text not null check(group_hash~'^[0-9a-f]{64}$'),
  materialization_job_id uuid,
  message_id text not null check(message_id<>''),
  trigger_history_id text not null check(trigger_history_id~'^[0-9]+$'),
  provider_history_id text not null default '' check(
    provider_history_id='' or provider_history_id~'^[0-9]+$'
  ),
  terminal_disposition text not null check(terminal_disposition=any(array[
    'parsed_exact_revision','deleted_at_cut','revision_contract_gap',
    'provider_revision_ahead_gap','provider_deleted_unavailable_gap',
    'poison_quarantined_review'
  ])),
  materialization_receipt_id text not null default '',
  materialization_receipt_hash text not null default '' check(
    materialization_receipt_hash=''
      or materialization_receipt_hash~'^[0-9a-f]{64}$'
  ),
  raw_observation_id text,
  parse_job_id uuid,
  parsed_observation_id text,
  terminal_authority_id text not null default '',
  terminal_authority_hash text not null default '' check(
    terminal_authority_hash='' or terminal_authority_hash~'^[0-9a-f]{64}$'
  ),
  member_id text not null unique check(
    member_id~'^gmail-parse-checkpoint-member:v1:[0-9a-f]{64}$'
  ),
  canonical_member jsonb not null check(jsonb_typeof(canonical_member)='object'),
  member_hash text not null unique check(member_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(schema_version='gmail-parse-checkpoint-member-v1'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,root_batch_id,group_id),
  unique(workspace_key,group_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,group_id)
    references public.gmail_message_materialization_groups(workspace_key,group_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,materialization_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parse_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,raw_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parsed_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check(
    (terminal_disposition='parsed_exact_revision'
      and provider_history_id<>'' and raw_observation_id is not null
      and parse_job_id is not null and parsed_observation_id is not null
      and materialization_job_id is not null
      and materialization_receipt_id<>''
      and materialization_receipt_hash<>''
      and terminal_authority_id=materialization_receipt_id
      and terminal_authority_hash=materialization_receipt_hash)
    or
    (terminal_disposition='deleted_at_cut'
      and provider_history_id<>'' and materialization_job_id is null
      and materialization_receipt_id='' and materialization_receipt_hash=''
      and raw_observation_id is null and parse_job_id is null
      and parsed_observation_id is null
      and terminal_authority_id<>'' and terminal_authority_hash<>'')
    or
    (terminal_disposition not in ('parsed_exact_revision','deleted_at_cut')
      and materialization_job_id is not null
      and terminal_authority_id<>'' and terminal_authority_hash<>'')
  ),
  check(member_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_member),'UTF8'
  ),'sha256'),'hex')),
  check(member_id='gmail-parse-checkpoint-member:v1:'||member_hash)
);

create table if not exists public.gmail_parse_checkpoints (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  root_batch_id uuid not null,
  checkpoint_id text not null unique check(
    checkpoint_id~'^gmail-parse-checkpoint:v1:[0-9a-f]{64}$'
  ),
  connection_key text not null,
  processing_epoch_id text not null,
  processing_epoch_hash text not null check(
    processing_epoch_hash~'^[0-9a-f]{64}$'
  ),
  source_cursor_version bigint not null check(source_cursor_version>0),
  source_cursor_value text not null check(source_cursor_value~'^[0-9]+$'),
  predecessor_checkpoint_id text,
  predecessor_checkpoint_hash text check(
    predecessor_checkpoint_hash is null or predecessor_checkpoint_hash~'^[0-9a-f]{64}$'
  ),
  predecessor_accumulator_hash text check(
    predecessor_accumulator_hash is null or predecessor_accumulator_hash~'^[0-9a-f]{64}$'
  ),
  source_delta_hash text not null check(source_delta_hash~'^[0-9a-f]{64}$'),
  member_manifest_hash text not null check(member_manifest_hash~'^[0-9a-f]{64}$'),
  member_count integer not null check(member_count>=0),
  terminal_gap_count integer not null check(
    terminal_gap_count>=0 and terminal_gap_count<=member_count
  ),
  cumulative_member_count bigint not null check(cumulative_member_count>=0),
  cumulative_terminal_gap_count bigint not null check(
    cumulative_terminal_gap_count>=0
      and cumulative_terminal_gap_count<=cumulative_member_count
  ),
  cumulative_resolved_terminal_gap_count bigint not null check(
    cumulative_resolved_terminal_gap_count>=0
      and cumulative_resolved_terminal_gap_count<=cumulative_terminal_gap_count
  ),
  cumulative_open_terminal_gap_count bigint not null check(
    cumulative_open_terminal_gap_count>=0
  ),
  cumulative_batch_count bigint not null check(cumulative_batch_count>0),
  cumulative_gap_count bigint not null check(cumulative_gap_count>=0),
  cumulative_reconciled_gap_count bigint not null check(
    cumulative_reconciled_gap_count>=0
  ),
  cumulative_open_gap_count bigint not null check(cumulative_open_gap_count>=0),
  accumulator_hash text not null unique check(accumulator_hash~'^[0-9a-f]{64}$'),
  canonical_checkpoint jsonb not null check(jsonb_typeof(canonical_checkpoint)='object'),
  checkpoint_hash text not null unique check(checkpoint_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check(schema_version='gmail-parse-checkpoint-v1'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_key,root_batch_id),
  unique(workspace_key,checkpoint_id),
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,predecessor_checkpoint_id)
    references public.gmail_parse_checkpoints(workspace_key,checkpoint_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,connection_key)
    references public.gmail_parse_processing_epochs(workspace_key,connection_key)
    on update restrict on delete restrict,
  check((predecessor_checkpoint_id is null)=(predecessor_checkpoint_hash is null)),
  check((predecessor_checkpoint_id is null)=(predecessor_accumulator_hash is null)),
  check(cumulative_open_gap_count=
    cumulative_gap_count-cumulative_reconciled_gap_count),
  check(cumulative_open_terminal_gap_count=
    cumulative_terminal_gap_count-cumulative_resolved_terminal_gap_count),
  check(checkpoint_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_checkpoint),'UTF8'
  ),'sha256'),'hex')),
  check(checkpoint_id='gmail-parse-checkpoint:v1:'||checkpoint_hash)
);

do $block$
declare v_table text;
begin
  foreach v_table in array array[
    'gmail_message_revision_obligations','gmail_message_revision_resolutions',
    'gmail_message_materialization_groups',
    'gmail_message_materialization_coverage',
    'gmail_message_materialization_receipts',
    'gmail_batch_materialization_route_seals',
    'gmail_parse_processing_epochs',
    'gmail_parse_checkpoint_obligations','gmail_parse_checkpoint_members',
    'gmail_parse_checkpoints'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I',v_table,v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I '
      ||'for each row execute function public.reject_immutable_truth_mutation()',
      v_table,v_table
    );
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format(
      'revoke all on public.%I from public,anon,authenticated,service_role',v_table
    );
    execute format('grant select on public.%I to service_role',v_table);
  end loop;
end;
$block$;

create or replace function private.seal_gmail_materialization_routes_v1(
  p_workspace_key text,p_root_batch_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_message record;
  v_selected record;
  v_coverage_manifest jsonb;
  v_coverage_count integer;
  v_route_disposition text;
  v_group_core jsonb;
  v_group_hash text;
  v_group_id text;
  v_job_id uuid;
  v_job_payload jsonb;
  v_job_dedupe text;
  v_coverage jsonb;
  v_coverage_hash text;
  v_route_manifest jsonb;
  v_route_manifest_hash text;
  v_route_count integer;
  v_materialization_count integer;
  v_deleted_count integer;
  v_seal jsonb;
  v_seal_hash text;
  v_seal_id text;
  v_existing public.gmail_batch_materialization_route_seals%rowtype;
begin
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=p_root_batch_id
    and source_system='gmail' and status='committed'
    and batch_hash~'^[0-9a-f]{64}$'
    and committed_cursor_version is not null
    and committed_cursor_value~'^[0-9]+$';
  select * into v_existing from public.gmail_batch_materialization_route_seals
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  if found then
    return jsonb_build_object(
      'ok',true,'idempotent',true,'sealId',v_existing.seal_id,
      'sealHash',v_existing.seal_hash,
      'routeManifestHash',v_existing.route_manifest_hash,
      'routeCount',v_existing.route_count,
      'materializationCount',v_existing.materialization_count,
      'deletedCount',v_existing.deleted_count
    );
  end if;

  for v_message in
    select distinct observation.source_object_id as message_id
    from public.gmail_ingest_page_observations membership
    join public.source_observations observation
      on observation.observation_id=membership.observation_id
     and observation.workspace_key=p_workspace_key
     and observation.source_system='gmail'
     and observation.connection_key=v_batch.connection_key
    where membership.batch_id=p_root_batch_id
      and (
        (observation.source_object_type='gmail_message_history_event'
          and observation.schema_version='gmail-history-event-v1'
          and observation.normalized_payload->>'eventType'=any(array[
            'message_added','message_deleted','labels_added','labels_removed'
          ]))
        or
        (observation.source_object_type='gmail_message_discovery_event'
          and observation.schema_version='gmail-mailbox-discovery-event-v1'
          and observation.normalized_payload->>'eventType'='message_discovered')
      )
    order by observation.source_object_id
  loop
    select observation.observation_id,observation.content_hash,
      observation.normalized_payload->>'historyId' as history_id,
      observation.normalized_payload->>'eventType' as event_type,
      coalesce(observation.normalized_payload->>'threadId','') as thread_id,
      case when observation.source_object_type='gmail_message_history_event'
        then 'history_event' else 'mailbox_discovery' end as trigger_kind
    into strict v_selected
    from public.gmail_ingest_page_observations membership
    join public.source_observations observation
      on observation.observation_id=membership.observation_id
     and observation.workspace_key=p_workspace_key
    where membership.batch_id=p_root_batch_id
      and observation.source_object_id=v_message.message_id
      and observation.normalized_payload->>'historyId'~'^[0-9]+$'
      and observation.normalized_payload->>'eventType'=any(array[
        'message_added','message_deleted','labels_added','labels_removed',
        'message_discovered'
      ])
    order by (observation.normalized_payload->>'historyId')::numeric desc,
      case observation.normalized_payload->>'eventType'
        when 'message_deleted' then 5 when 'labels_removed' then 4
        when 'labels_added' then 3 when 'message_added' then 2 else 1 end desc,
      observation.observation_id desc
    limit 1;
    select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
      'pageOrdinal',membership.page_ordinal,
      'triggerObservationId',observation.observation_id,
      'triggerObservationContentHash',observation.content_hash,
      'triggerKind',case
        when observation.source_object_type='gmail_message_history_event'
          then 'history_event' else 'mailbox_discovery' end,
      'eventType',observation.normalized_payload->>'eventType',
      'historyId',observation.normalized_payload->>'historyId'
    ) order by (observation.normalized_payload->>'historyId')::numeric,
      observation.normalized_payload->>'eventType',observation.observation_id,
      membership.page_ordinal),'[]'::jsonb)
    into v_coverage_count,v_coverage_manifest
    from public.gmail_ingest_page_observations membership
    join public.source_observations observation
      on observation.observation_id=membership.observation_id
     and observation.workspace_key=p_workspace_key
    where membership.batch_id=p_root_batch_id
      and observation.source_object_id=v_message.message_id
      and observation.normalized_payload->>'historyId'~'^[0-9]+$'
      and observation.normalized_payload->>'eventType'=any(array[
        'message_added','message_deleted','labels_added','labels_removed',
        'message_discovered'
      ]);
    v_route_disposition:=case when v_selected.event_type='message_deleted'
      then 'deleted_at_cut' else 'materialize_revision' end;
    v_group_core:=jsonb_build_object(
      'schemaVersion','gmail-message-materialization-group-v1',
      'workspaceKey',p_workspace_key,'rootBatchId',p_root_batch_id,
      'rootBatchHash',v_batch.batch_hash,'connectionKey',v_batch.connection_key,
      'sourceCursorVersion',v_batch.committed_cursor_version,
      'sourceCursorValue',v_batch.committed_cursor_value,
      'messageId',v_message.message_id,'threadId',v_selected.thread_id,
      'selectedTrigger',jsonb_build_object(
        'observationId',v_selected.observation_id,
        'contentHash',v_selected.content_hash,'kind',v_selected.trigger_kind,
        'eventType',v_selected.event_type,'historyId',v_selected.history_id
      ),
      'routeDisposition',v_route_disposition,
      'coverageCount',v_coverage_count,
      'coverageManifestHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_coverage_manifest),'UTF8'
      ),'sha256'),'hex')
    );
    v_group_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_group_core),'UTF8'
    ),'sha256'),'hex');
    v_group_id:='gmail-materialization-group:v1:'||v_group_hash;
    v_job_id:=case when v_route_disposition='materialize_revision'
      then private.truth_deterministic_uuid_v1(v_group_hash) else null end;
    if v_job_id is not null then
      v_job_dedupe:='gmail:materialize-message-revision:v1:'||v_group_hash;
      v_job_payload:=jsonb_build_object(
        'schemaVersion','gmail-materialize-message-revision-job-v1',
        'groupId',v_group_id,'messageId',v_message.message_id,
        'materializerVersion','gmail-message-revision-materializer-v1',
        'requestedFormat','raw'
      );
      insert into public.source_processing_jobs(
        job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
        observation_id,source_object_id,state,max_attempts,payload
      ) values (
        v_job_id,v_job_dedupe,p_workspace_key,'gmail',v_batch.connection_key,
        'gmail_materialize_message_revision',null,v_message.message_id,
        'queued',5,v_job_payload
      ) on conflict(dedupe_key) do nothing;
      if not exists (
        select 1 from public.source_processing_jobs job
        where job.job_id=v_job_id and job.dedupe_key=v_job_dedupe
          and job.workspace_key=p_workspace_key and job.source_system='gmail'
          and job.connection_key=v_batch.connection_key
          and job.job_kind='gmail_materialize_message_revision'
          and job.observation_id is null
          and job.source_object_id=v_message.message_id
          and job.payload=v_job_payload
      ) then
        raise exception 'Gmail materialization job identity conflicts on replay'
          using errcode='23505';
      end if;
      insert into public.source_processing_job_lineage(
        job_id,workspace_key,source_system,connection_key,root_batch_id,
        parent_job_id,root_job_id,source_cursor_version,source_cursor_value
      ) values (
        v_job_id,p_workspace_key,'gmail',v_batch.connection_key,p_root_batch_id,
        null,v_job_id,v_batch.committed_cursor_version,
        v_batch.committed_cursor_value
      ) on conflict(job_id) do nothing;
    end if;
    insert into public.gmail_message_materialization_groups(
      workspace_key,root_batch_id,group_id,connection_key,
      source_cursor_version,source_cursor_value,message_id,
      thread_id,
      selected_observation_id,selected_observation_content_hash,
      selected_trigger_kind,selected_event_type,selected_history_id,
      route_disposition,materialization_job_id,coverage_count,
      coverage_manifest_hash,canonical_group,group_hash,schema_version
    ) values (
      p_workspace_key,p_root_batch_id,v_group_id,v_batch.connection_key,
      v_batch.committed_cursor_version,v_batch.committed_cursor_value,
      v_message.message_id,v_selected.thread_id,
      v_selected.observation_id,v_selected.content_hash,
      v_selected.trigger_kind,v_selected.event_type,v_selected.history_id,
      v_route_disposition,v_job_id,v_coverage_count,
      v_group_core->>'coverageManifestHash',v_group_core,v_group_hash,
      'gmail-message-materialization-group-v1'
    ) on conflict(workspace_key,root_batch_id,message_id) do nothing;
    if not exists (
      select 1 from public.gmail_message_materialization_groups group_row
      where group_row.workspace_key=p_workspace_key
        and group_row.root_batch_id=p_root_batch_id
        and group_row.message_id=v_message.message_id
        and group_row.canonical_group=v_group_core
        and group_row.materialization_job_id is not distinct from v_job_id
    ) then
      raise exception 'Gmail materialization group conflicts on replay'
        using errcode='23505';
    end if;
    for v_coverage in select value from jsonb_array_elements(v_coverage_manifest)
    loop
      v_coverage:=jsonb_build_object(
        'schemaVersion','gmail-message-materialization-coverage-v1',
        'workspaceKey',p_workspace_key,'groupId',v_group_id,
        'rootBatchId',p_root_batch_id,
        'pageOrdinal',(v_coverage->>'pageOrdinal')::integer,
        'triggerObservationId',v_coverage->>'triggerObservationId',
        'triggerObservationContentHash',
          v_coverage->>'triggerObservationContentHash',
        'triggerKind',v_coverage->>'triggerKind',
        'eventType',v_coverage->>'eventType','historyId',v_coverage->>'historyId',
        'coverageDisposition',case
          when v_coverage->>'triggerObservationId'=v_selected.observation_id
            then 'selected_trigger' else 'coalesced_same_root' end
      );
      v_coverage_hash:=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_coverage),'UTF8'
      ),'sha256'),'hex');
      insert into public.gmail_message_materialization_coverage(
        workspace_key,group_id,root_batch_id,page_ordinal,
        trigger_observation_id,trigger_observation_content_hash,trigger_kind,
        event_type,history_id,coverage_disposition,canonical_coverage,
        coverage_hash,schema_version
      ) values (
        p_workspace_key,v_group_id,p_root_batch_id,
        (v_coverage->>'pageOrdinal')::integer,
        v_coverage->>'triggerObservationId',
        v_coverage->>'triggerObservationContentHash',v_coverage->>'triggerKind',
        v_coverage->>'eventType',v_coverage->>'historyId',
        v_coverage->>'coverageDisposition',v_coverage,v_coverage_hash,
        'gmail-message-materialization-coverage-v1'
      ) on conflict do nothing;
    end loop;
  end loop;
  select count(*)::integer,
    count(*) filter(where route_disposition='materialize_revision')::integer,
    count(*) filter(where route_disposition='deleted_at_cut')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'groupId',group_id,'groupHash',group_hash,'messageId',message_id,
      'routeDisposition',route_disposition
    ) order by message_id,group_id),'[]'::jsonb)
  into v_route_count,v_materialization_count,v_deleted_count,v_route_manifest
  from public.gmail_message_materialization_groups
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  v_route_manifest_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_route_manifest),'UTF8'
  ),'sha256'),'hex');
  v_seal:=jsonb_build_object(
    'schemaVersion','gmail-materialization-route-seal-v1',
    'workspaceKey',p_workspace_key,'rootBatchId',p_root_batch_id,
    'rootBatchHash',v_batch.batch_hash,'connectionKey',v_batch.connection_key,
    'sourceCursorVersion',v_batch.committed_cursor_version,
    'sourceCursorValue',v_batch.committed_cursor_value,
    'routeCount',v_route_count,'materializationCount',v_materialization_count,
    'deletedCount',v_deleted_count,'routeManifestHash',v_route_manifest_hash
  );
  v_seal_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_seal),'UTF8'
  ),'sha256'),'hex');
  v_seal_id:='gmail-materialization-route-seal:v1:'||v_seal_hash;
  insert into public.gmail_batch_materialization_route_seals(
    workspace_key,root_batch_id,seal_id,connection_key,route_count,
    materialization_count,deleted_count,route_manifest_hash,canonical_seal,
    seal_hash,schema_version
  ) values (
    p_workspace_key,p_root_batch_id,v_seal_id,v_batch.connection_key,
    v_route_count,v_materialization_count,v_deleted_count,
    v_route_manifest_hash,v_seal,v_seal_hash,
    'gmail-materialization-route-seal-v1'
  );
  return jsonb_build_object(
    'ok',true,'idempotent',false,'sealId',v_seal_id,'sealHash',v_seal_hash,
    'routeManifestHash',v_route_manifest_hash,
    'routeCount',v_route_count,'materializationCount',v_materialization_count,
    'deletedCount',v_deleted_count
  );
end;
$function$;

revoke all on function private.seal_gmail_materialization_routes_v1(text,uuid)
  from public,anon,authenticated,service_role;

create or replace function private.ensure_gmail_parse_processing_epoch_v1(
  p_workspace_key text,p_root_batch_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_seal public.gmail_batch_materialization_route_seals%rowtype;
  v_existing public.gmail_parse_processing_epochs%rowtype;
  v_legacy_count bigint;
  v_legacy_manifest jsonb;
  v_legacy_hash text;
  v_body jsonb;
  v_hash text;
  v_id text;
begin
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=p_root_batch_id
    and source_system='gmail' and status='committed'
    and committed_cursor_version is not null
    and committed_cursor_value~'^[0-9]+$'
    and mode in ('backfill','reconciliation');
  select * into strict v_seal
  from public.gmail_batch_materialization_route_seals
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id;
  select * into v_existing from public.gmail_parse_processing_epochs
  where workspace_key=p_workspace_key and connection_key=v_batch.connection_key;
  if found then
    return jsonb_build_object(
      'ok',true,'idempotent',true,'epochId',v_existing.epoch_id,
      'epochHash',v_existing.epoch_hash,
      'genesisRootBatchId',v_existing.genesis_root_batch_id
    );
  end if;
  select count(*)::bigint,coalesce(jsonb_agg(jsonb_build_object(
    'rootBatchId',prior.batch_id,'rootBatchHash',prior.batch_hash,
    'sourceCursorVersion',prior.committed_cursor_version,
    'sourceCursorValue',prior.committed_cursor_value
  ) order by prior.committed_cursor_version,prior.batch_id),'[]'::jsonb)
  into v_legacy_count,v_legacy_manifest
  from public.source_ingest_batches prior
  where prior.workspace_key=p_workspace_key and prior.source_system='gmail'
    and prior.connection_key=v_batch.connection_key and prior.status='committed'
    and prior.batch_hash~'^[0-9a-f]{64}$'
    and prior.committed_cursor_version is not null
    and prior.committed_cursor_version<v_batch.committed_cursor_version;
  v_legacy_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_legacy_manifest),'UTF8'
  ),'sha256'),'hex');
  v_body:=jsonb_build_object(
    'schemaVersion','gmail-parse-processing-epoch-v1',
    'workspaceKey',p_workspace_key,'connectionKey',v_batch.connection_key,
    'genesisRootBatchId',v_batch.batch_id,
    'genesisRootBatchHash',v_batch.batch_hash,
    'genesisSourceCursorVersion',v_batch.committed_cursor_version,
    'genesisSourceCursorValue',v_batch.committed_cursor_value,
    'genesisMode',v_batch.mode,
    'genesisRouteSealId',v_seal.seal_id,
    'genesisRouteSealHash',v_seal.seal_hash,
    'legacyBatchCount',v_legacy_count,
    'legacyBatchManifestHash',v_legacy_hash,
    'policyVersion','gmail-v2-full-mailbox-genesis-policy-v1'
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  v_id:='gmail-parse-processing-epoch:v1:'||v_hash;
  insert into public.gmail_parse_processing_epochs(
    workspace_key,connection_key,epoch_id,genesis_root_batch_id,
    genesis_source_cursor_version,genesis_source_cursor_value,
    legacy_batch_count,legacy_batch_manifest_hash,genesis_route_seal_id,
    genesis_route_seal_hash,canonical_epoch,epoch_hash,schema_version
  ) values (
    p_workspace_key,v_batch.connection_key,v_id,v_batch.batch_id,
    v_batch.committed_cursor_version,v_batch.committed_cursor_value,
    v_legacy_count,v_legacy_hash,v_seal.seal_id,v_seal.seal_hash,
    v_body,v_hash,'gmail-parse-processing-epoch-v1'
  ) on conflict(workspace_key,connection_key) do nothing;
  select * into strict v_existing from public.gmail_parse_processing_epochs
  where workspace_key=p_workspace_key and connection_key=v_batch.connection_key;
  if v_existing.canonical_epoch is distinct from v_body then
    raise exception 'Gmail parse processing epoch conflicts on replay'
      using errcode='23505';
  end if;
  return jsonb_build_object(
    'ok',true,'idempotent',false,'epochId',v_existing.epoch_id,
    'epochHash',v_existing.epoch_hash,
    'genesisRootBatchId',v_existing.genesis_root_batch_id
  );
end;
$function$;

revoke all on function private.ensure_gmail_parse_processing_epoch_v1(text,uuid)
  from public,anon,authenticated,service_role;

create or replace function public.commit_source_ingest_batch(
  p_batch_id uuid,p_owner_id text,p_lease_fence bigint,p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_receipt jsonb;
  v_batch public.source_ingest_batches%rowtype;
  v_routes jsonb;
begin
  perform private.truth_source_cut_serialization_lock_for_batch(p_batch_id);
  v_receipt:=private.commit_source_ingest_batch(
    p_batch_id,p_owner_id,p_lease_fence,p_sync_token
  );
  select * into strict v_batch from public.source_ingest_batches
  where batch_id=p_batch_id;
  if v_batch.source_system='gmail' then
    v_routes:=private.seal_gmail_materialization_routes_v1(
      v_batch.workspace_key,p_batch_id
    );
    if v_batch.mode in ('backfill','reconciliation') then
      perform private.ensure_gmail_parse_processing_epoch_v1(
        v_batch.workspace_key,p_batch_id
      );
    end if;
    return v_receipt||jsonb_build_object('materializationRoutes',v_routes);
  end if;
  return v_receipt;
end;
$function$;

revoke all on function public.commit_source_ingest_batch(
  uuid,text,bigint,text
) from public,anon,authenticated,service_role;
grant execute on function public.commit_source_ingest_batch(
  uuid,text,bigint,text
) to service_role;

create or replace function private.append_gmail_parse_checkpoint_obligation_v1(
  p_workspace_key text,p_root_batch_id uuid,p_job_id uuid,
  p_obligation_kind text,p_detail jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_body jsonb;
  v_hash text;
  v_id text;
  v_existing public.gmail_parse_checkpoint_obligations%rowtype;
begin
  if p_obligation_kind<>all(array[
      'FETCH_CONTRACT_INVALID','FETCH_OUTPUT_CONFLICT','PARSE_CONTRACT_INVALID',
      'PARSED_OUTPUT_CONFLICT','LINK_CONTEXT_OVERFLOW'
    ])
    or jsonb_typeof(coalesce(p_detail,'null'::jsonb))<>'object' then
    raise exception 'Gmail parse-checkpoint obligation input is invalid'
      using errcode='22023';
  end if;
  v_body:=jsonb_build_object(
    'schemaVersion','gmail-parse-checkpoint-obligation-v1',
    'workspaceKey',p_workspace_key,'rootBatchId',p_root_batch_id,
    'jobId',p_job_id,'obligationKind',p_obligation_kind,'detail',p_detail
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  v_id:='gmail-parse-checkpoint-obligation:v1:'||v_hash;
  insert into public.gmail_parse_checkpoint_obligations(
    workspace_key,obligation_id,root_batch_id,job_id,obligation_kind,
    canonical_obligation,obligation_hash,schema_version
  ) values (
    p_workspace_key,v_id,p_root_batch_id,p_job_id,p_obligation_kind,
    v_body,v_hash,'gmail-parse-checkpoint-obligation-v1'
  ) on conflict(workspace_key,root_batch_id,job_id,obligation_kind) do nothing;
  select * into strict v_existing
  from public.gmail_parse_checkpoint_obligations
  where workspace_key=p_workspace_key and root_batch_id=p_root_batch_id
    and job_id=p_job_id and obligation_kind=p_obligation_kind;
  if v_existing.canonical_obligation is distinct from v_body then
    raise exception 'Gmail parse-checkpoint obligation conflicts on replay'
      using errcode='23505';
  end if;
  return jsonb_build_object(
    'ok',true,'obligationId',v_id,'obligationHash',v_hash,
    'obligationKind',p_obligation_kind
  );
end;
$function$;

create or replace function private.complete_gmail_message_revision_obligation(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_reason_code text,p_provider_history_value jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_group public.gmail_message_materialization_groups%rowtype;
  v_anchor public.source_observations%rowtype;
  v_existing public.gmail_message_revision_obligations%rowtype;
  v_provider_history_value jsonb:=coalesce(p_provider_history_value,'null'::jsonb);
  v_provider_history_id text:='';
  v_trigger_history_id text;
  v_trigger_kind text;
  v_value_hash text;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_result jsonb;
  v_completion jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_reason_code<>all(array[
      'PROVIDER_HISTORY_ID_MISSING','PROVIDER_HISTORY_ID_MALFORMED',
      'PROVIDER_HISTORY_ID_AHEAD_OF_COMMITTED_CUT',
      'PROVIDER_HISTORY_ID_BEHIND_TRIGGER',
      'PROVIDER_MESSAGE_DELETED_UNAVAILABLE','FETCH_POISON_QUARANTINED_REVIEW'
    ]) or pg_column_size(v_provider_history_value)>256 then
    raise exception 'Gmail message-revision obligation input is invalid'
      using errcode='22023';
  end if;
  select * into strict v_job from public.source_processing_jobs
  where workspace_key=p_workspace_key and job_id=p_job_id;
  select * into strict v_lineage from public.source_processing_job_lineage
  where workspace_key=p_workspace_key and job_id=p_job_id;
  select * into strict v_group
  from public.gmail_message_materialization_groups
  where workspace_key=p_workspace_key and materialization_job_id=p_job_id;
  select * into strict v_anchor from public.source_observations
  where workspace_key=p_workspace_key
    and observation_id=v_group.selected_observation_id;
  v_trigger_history_id:=v_group.selected_history_id;
  v_trigger_kind:=v_group.selected_trigger_kind;
  if not private.gmail_materialization_group_job_valid_v1(
      v_job,v_lineage,v_group,v_anchor
    )
    or v_lineage.source_cursor_value!~'^[0-9]+$'
    or not private.gmail_history_id_at_least(
      v_lineage.source_cursor_value,v_trigger_history_id
    ) then
    raise exception 'Gmail revision obligation job authority is invalid'
      using errcode='23514';
  end if;
  if jsonb_typeof(v_provider_history_value)='string' then
    v_provider_history_id:=v_provider_history_value#>>'{}';
  end if;
  if p_reason_code='PROVIDER_HISTORY_ID_MISSING'
      and jsonb_typeof(v_provider_history_value)<>'null'
    or p_reason_code='PROVIDER_HISTORY_ID_MALFORMED'
      and (jsonb_typeof(v_provider_history_value)='null'
        or v_provider_history_id~'^[0-9]+$')
    or p_reason_code='PROVIDER_HISTORY_ID_AHEAD_OF_COMMITTED_CUT'
      and (v_provider_history_id!~'^[0-9]+$'
        or private.gmail_history_id_at_least(
          v_lineage.source_cursor_value,v_provider_history_id
        ))
    or p_reason_code='PROVIDER_HISTORY_ID_BEHIND_TRIGGER'
      and (v_trigger_kind<>'history_event'
        or v_provider_history_id!~'^[0-9]+$'
        or private.gmail_history_id_at_least(
          v_provider_history_id,v_trigger_history_id
        ))
    or p_reason_code=any(array[
        'PROVIDER_MESSAGE_DELETED_UNAVAILABLE','FETCH_POISON_QUARANTINED_REVIEW'
      ]) and jsonb_typeof(v_provider_history_value)<>'null' then
    raise exception 'Gmail revision obligation reason differs from provider value'
      using errcode='23514';
  end if;
  if v_provider_history_id!~'^[0-9]+$' then v_provider_history_id:=''; end if;
  v_value_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_provider_history_value),'UTF8'
  ),'sha256'),'hex');
  v_body:=jsonb_build_object(
    'schemaVersion','gmail-message-revision-obligation-v1',
    'workspaceKey',p_workspace_key,'fetchJobId',p_job_id,
    'rootBatchId',v_lineage.root_batch_id,'connectionKey',v_job.connection_key,
    'messageId',v_job.source_object_id,
    'materializationGroupId',v_group.group_id,
    'materializationGroupHash',v_group.group_hash,
    'triggerObservationId',v_group.selected_observation_id,
    'triggerObservationContentHash',v_anchor.content_hash,
    'triggerKind',v_trigger_kind,
    'triggerEventType',v_group.selected_event_type,
    'triggerHistoryId',v_trigger_history_id,
    'sourceCursorVersion',v_lineage.source_cursor_version,
    'sourceCursorValue',v_lineage.source_cursor_value,
    'providerHistoryId',v_provider_history_id,
    'providerHistoryValueHash',v_value_hash,'reasonCode',p_reason_code
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  v_id:='gmail-message-revision-obligation:v1:'||v_hash;
  select * into v_existing from public.gmail_message_revision_obligations
  where workspace_key=p_workspace_key and fetch_job_id=p_job_id;
  if found then
    if v_existing.canonical_obligation is distinct from v_body then
      raise exception 'Gmail message-revision obligation conflicts on replay'
        using errcode='23505';
    end if;
    return jsonb_build_object(
      'ok',true,'idempotent',true,'jobId',p_job_id,'state',v_job.state,
      'attemptCount',v_job.attempt_count,'leaseFence',v_job.lease_fence,
      'completionHash',v_job.result->>'completionHash',
      'resultObservationIds',v_job.result->'resultObservationIds',
      'childJobs',v_job.result->'childJobs',
      'rootBatchId',v_job.result->>'rootBatchId',
      'sourceCursorVersion',(v_job.result->>'sourceCursorVersion')::bigint,
      'sourceCursorValue',v_job.result->>'sourceCursorValue',
      'obligationId',v_existing.obligation_id,
      'obligationHash',v_existing.obligation_hash,
      'reasonCode',v_existing.reason_code
    );
  end if;
  if v_job.state<>'leased' or v_job.lease_owner<>p_worker_id
    or v_job.lease_fence<>p_lease_fence
    or v_job.processor_version<>p_processor_version
    or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'Gmail revision-obligation lease lost' using errcode='40001';
  end if;
  v_result:=jsonb_build_object(
    'schemaVersion','gmail-message-revision-obligation-result-v1',
    'messageId',v_job.source_object_id,
    'materializationGroupId',v_group.group_id,
    'triggerObservationId',v_group.selected_observation_id,
    'triggerHistoryId',v_trigger_history_id,
    'providerMessageHistoryId',v_provider_history_id,
    'providerHistoryValueHash',v_value_hash,'reasonCode',p_reason_code,
    'obligationId',v_id,'obligationHash',v_hash,
    'rawObservationCount',0,'childJobCount',0
  );
  v_completion:=private.complete_source_processing_job(
    p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    v_result,'[]'::jsonb,'[]'::jsonb,p_sync_token
  );
  insert into public.gmail_message_revision_obligations(
    workspace_key,obligation_id,fetch_job_id,root_batch_id,connection_key,
    message_id,trigger_observation_id,trigger_history_id,
    source_cursor_version,source_cursor_value,provider_history_id,
    provider_history_value_hash,reason_code,canonical_obligation,
    obligation_hash,schema_version
  ) values (
    p_workspace_key,v_id,p_job_id,v_lineage.root_batch_id,v_job.connection_key,
    v_job.source_object_id,v_group.selected_observation_id,v_trigger_history_id,
    v_lineage.source_cursor_version,v_lineage.source_cursor_value,
    v_provider_history_id,v_value_hash,p_reason_code,v_body,v_hash,
    'gmail-message-revision-obligation-v1'
  );
  return v_completion||jsonb_build_object(
    'obligationId',v_id,'obligationHash',v_hash,'reasonCode',p_reason_code
  );
end;
$function$;

create or replace function public.complete_gmail_message_revision_obligation(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_reason_code text,p_provider_history_value jsonb,
  p_sync_token text
)
returns jsonb language sql security definer set search_path=''
as $function$
  select private.complete_gmail_message_revision_obligation(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_reason_code,p_provider_history_value,p_sync_token
  );
$function$;

revoke all on function private.append_gmail_parse_checkpoint_obligation_v1(
  text,uuid,uuid,text,jsonb
) from public,anon,authenticated,service_role;
revoke all on function private.complete_gmail_message_revision_obligation(
  text,uuid,text,bigint,text,text,jsonb,text
) from public,anon,authenticated,service_role;
revoke all on function public.complete_gmail_message_revision_obligation(
  text,uuid,text,bigint,text,text,jsonb,text
) from public,anon,authenticated,service_role;
grant execute on function public.complete_gmail_message_revision_obligation(
  text,uuid,text,bigint,text,text,jsonb,text
) to service_role;

create or replace function private.complete_gmail_message_revision_materialization(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_result jsonb,p_raw_observation jsonb,
  p_parse_child jsonb,p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_group public.gmail_message_materialization_groups%rowtype;
  v_owner_group public.gmail_message_materialization_groups%rowtype;
  v_anchor public.source_observations%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_seal public.gmail_batch_materialization_route_seals%rowtype;
  v_raw public.source_observations%rowtype;
  v_parse public.source_processing_jobs%rowtype;
  v_existing public.gmail_message_materialization_receipts%rowtype;
  v_owner public.gmail_message_materialization_receipts%rowtype;
  v_provider_history text;
  v_raw_sha text;
  v_raw_bytes bigint;
  v_raw_identity jsonb;
  v_raw_id text;
  v_parse_hash text;
  v_parse_dedupe text;
  v_disposition text;
  v_receipt_body jsonb;
  v_receipt_hash text;
  v_receipt_id text;
  v_observation_manifest jsonb;
  v_child_manifest jsonb;
  v_child_receipts jsonb;
  v_completion_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or p_job_id is null or nullif(trim(coalesce(p_worker_id,'')),'') is null
    or p_lease_fence is null or p_lease_fence<=0
    or nullif(trim(coalesce(p_processor_version,'')),'') is null
    or jsonb_typeof(coalesce(p_result,'null'::jsonb))<>'object'
    or jsonb_typeof(coalesce(p_raw_observation,'null'::jsonb))<>'object'
    or jsonb_typeof(coalesce(p_parse_child,'null'::jsonb))<>'object' then
    raise exception 'Gmail materialization completion request is invalid'
      using errcode='22023';
  end if;
  select * into strict v_job from public.source_processing_jobs
  where workspace_key=p_workspace_key and job_id=p_job_id for update;
  select * into strict v_lineage from public.source_processing_job_lineage
  where workspace_key=p_workspace_key and job_id=p_job_id;
  select * into strict v_group
  from public.gmail_message_materialization_groups
  where workspace_key=p_workspace_key and materialization_job_id=p_job_id;
  select * into strict v_anchor from public.source_observations
  where workspace_key=p_workspace_key
    and observation_id=v_group.selected_observation_id;
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=v_group.root_batch_id
    and source_system='gmail' and connection_key=v_group.connection_key
    and status='committed' and batch_hash~'^[0-9a-f]{64}$'
    and committed_cursor_version=v_group.source_cursor_version
    and committed_cursor_value=v_group.source_cursor_value;
  select * into strict v_seal
  from public.gmail_batch_materialization_route_seals
  where workspace_key=p_workspace_key and root_batch_id=v_group.root_batch_id;
  if not private.gmail_materialization_group_job_valid_v1(
      v_job,v_lineage,v_group,v_anchor
    ) then
    raise exception 'Gmail materialization group authority is invalid'
      using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-materialization:'||p_workspace_key||':'||v_group.connection_key
      ||':'||v_group.message_id,0
  ));
  if exists (
    select 1
    from public.gmail_message_materialization_groups prior_group
    join public.source_processing_jobs prior_job
      on prior_job.workspace_key=prior_group.workspace_key
     and prior_job.job_id=prior_group.materialization_job_id
    where prior_group.workspace_key=p_workspace_key
      and prior_group.connection_key=v_group.connection_key
      and prior_group.message_id=v_group.message_id
      and prior_group.route_disposition='materialize_revision'
      and (prior_group.source_cursor_version<v_group.source_cursor_version
        or (prior_group.source_cursor_version=v_group.source_cursor_version
          and prior_group.group_id<v_group.group_id))
      and prior_job.state not in ('succeeded','dead_letter','superseded')
  ) then
    raise exception 'Earlier Gmail materialization group is not terminal'
      using errcode='40001';
  end if;

  v_provider_history:=p_result->>'providerMessageHistoryId';
  v_raw_sha:=p_result->>'rawSha256';
  if coalesce(p_result->>'rawBytes','')~'^[0-9]+$' then
    v_raw_bytes:=(p_result->>'rawBytes')::bigint;
  end if;
  if not private.truth_jsonb_has_only_keys(p_result,array[
      'schemaVersion','materializationGroupId','messageId',
      'providerMessageHistoryId','rawSha256','rawBytes'
    ]) or (select count(*) from jsonb_object_keys(p_result))<>6
    or p_result->>'schemaVersion'
      <>'gmail-message-revision-materialization-result-v1'
    or p_result->>'materializationGroupId'<>v_group.group_id
    or p_result->>'messageId'<>v_group.message_id
    or v_provider_history!~'^[0-9]+$'
    or v_raw_sha!~'^[0-9a-f]{64}$' or v_raw_bytes is null
    or v_raw_bytes<1 or v_raw_bytes>9007199254740991
    or not private.gmail_history_id_at_least(
      v_group.source_cursor_value,v_provider_history
    )
    or (v_group.selected_trigger_kind='history_event' and not
      private.gmail_history_id_at_least(
        v_provider_history,v_group.selected_history_id
      )) then
    raise exception 'Gmail materialization result authority is invalid'
      using errcode='23514';
  end if;
  if not private.truth_jsonb_has_only_keys(p_raw_observation,array[
      'observationId','sourceObjectType','sourceObjectId','sourceRevision',
      'operation','contentHash','sourceRecordedAt','normalizedPayload',
      'normalizedText','rawObject','sourceFidelity','schemaVersion',
      'retentionClass'
    ]) or (select count(*) from jsonb_object_keys(p_raw_observation))<>13
    or p_raw_observation->>'sourceObjectType'<>'gmail_message_raw'
    or p_raw_observation->>'sourceObjectId'<>v_group.message_id
    or p_raw_observation->>'sourceRevision'<>v_provider_history
    or p_raw_observation->>'operation'<>'content'
    or p_raw_observation->>'contentHash'<>v_raw_sha
    or p_raw_observation->>'sourceFidelity'<>'raw'
    or p_raw_observation->>'schemaVersion'<>'gmail-raw-message-v2'
    or p_raw_observation->>'retentionClass'<>'shipment-operations'
    or jsonb_typeof(p_raw_observation->'normalizedPayload')<>'object'
    or jsonb_typeof(p_raw_observation->'rawObject')<>'object' then
    raise exception 'Gmail intrinsic raw observation envelope is invalid'
      using errcode='23514';
  end if;
  -- normalizedText is intentionally empty; spell the check separately so SQL
  -- cannot coerce a missing value into an accepted witness.
  if p_raw_observation->>'normalizedText' is distinct from '' then
    raise exception 'Gmail intrinsic raw observation text must be empty'
      using errcode='23514';
  end if;
  if not private.truth_jsonb_has_only_keys(
      p_raw_observation->'normalizedPayload',array[
        'schemaVersion','messageId','threadId','providerMessageHistoryId',
        'internalDate','providerReceivedAt','labelIds','sizeEstimate',
        'rawSha256','rawBytes'
      ])
    or (select count(*) from jsonb_object_keys(
      p_raw_observation->'normalizedPayload'))<>10
    or p_raw_observation#>>'{normalizedPayload,schemaVersion}'
      <>'gmail-raw-message-v2'
    or p_raw_observation#>>'{normalizedPayload,messageId}'<>v_group.message_id
    or p_raw_observation#>>'{normalizedPayload,providerMessageHistoryId}'
      <>v_provider_history
    or coalesce(p_raw_observation#>>'{normalizedPayload,internalDate}','')
      !~'^[0-9]+$'
    or nullif(p_raw_observation#>>'{normalizedPayload,providerReceivedAt}','')
      is null
    or p_raw_observation#>>'{normalizedPayload,providerReceivedAt}'
      is distinct from p_raw_observation->>'sourceRecordedAt'
    or jsonb_typeof(p_raw_observation#>'{normalizedPayload,labelIds}')<>'array'
    or p_raw_observation#>>'{normalizedPayload,rawSha256}'<>v_raw_sha
    or coalesce(p_raw_observation#>>'{normalizedPayload,rawBytes}','')
      <>v_raw_bytes::text
    or jsonb_typeof(p_raw_observation#>'{normalizedPayload,sizeEstimate}')
      not in ('number','null') then
    raise exception 'Gmail intrinsic raw payload is invalid'
      using errcode='23514';
  end if;
  perform (p_raw_observation->>'sourceRecordedAt')::timestamptz;
  if exists (
    select 1 from jsonb_array_elements(
      p_raw_observation#>'{normalizedPayload,labelIds}'
    ) label where jsonb_typeof(label)<>'string'
  ) or jsonb_array_length(p_raw_observation#>'{normalizedPayload,labelIds}')
    is distinct from (
      select count(distinct label#>>'{}')::integer
      from jsonb_array_elements(
        p_raw_observation#>'{normalizedPayload,labelIds}'
      ) label
    ) or p_raw_observation#>'{normalizedPayload,labelIds}' is distinct from (
      select coalesce(jsonb_agg(label order by label#>>'{}'),'[]'::jsonb)
      from jsonb_array_elements(
        p_raw_observation#>'{normalizedPayload,labelIds}'
      ) label
    ) then
    raise exception 'Gmail intrinsic raw labels are not sorted unique strings'
      using errcode='23514';
  end if;
  if not private.truth_jsonb_has_only_keys(p_raw_observation->'rawObject',array[
      'bucket','key','version','etag','hash','bytes','contentType'
    ]) or (select count(*) from jsonb_object_keys(
      p_raw_observation->'rawObject'))<>7
    or nullif(p_raw_observation#>>'{rawObject,bucket}','') is null
    or nullif(p_raw_observation#>>'{rawObject,key}','') is null
    or p_raw_observation#>>'{rawObject,hash}'<>v_raw_sha
    or coalesce(p_raw_observation#>>'{rawObject,bytes}','')<>v_raw_bytes::text
    or p_raw_observation#>>'{rawObject,contentType}'<>'message/rfc822' then
    raise exception 'Gmail intrinsic raw object witness is invalid'
      using errcode='23514';
  end if;
  v_raw_identity:=jsonb_build_object(
    'schemaVersion','source-observation-identity-v1',
    'workspaceKey',p_workspace_key,'sourceSystem','gmail',
    'connectionKey',v_group.connection_key,
    'sourceObjectType','gmail_message_raw',
    'sourceObjectId',v_group.message_id,'sourceRevision',v_provider_history,
    'operation','content','contentHash',v_raw_sha
  );
  v_raw_id:='obs:v1:'||encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_raw_identity),'UTF8'
  ),'sha256'),'hex');
  if p_raw_observation->>'observationId'<>v_raw_id then
    raise exception 'Gmail intrinsic raw observation identity is invalid'
      using errcode='23514';
  end if;
  if not private.truth_jsonb_has_only_keys(p_parse_child,array[
      'dedupeKey','jobKind','observationId','sourceObjectId','maxAttempts','payload'
    ]) or (select count(*) from jsonb_object_keys(p_parse_child))<>6
    or p_parse_child->>'jobKind'<>'gmail_parse_rfc822'
    or p_parse_child->>'observationId'<>v_raw_id
    or p_parse_child->>'sourceObjectId'<>v_group.message_id
    or p_parse_child->>'maxAttempts'<>'5'
    or jsonb_typeof(p_parse_child->'payload')<>'object'
    or not private.truth_jsonb_has_only_keys(p_parse_child->'payload',array[
      'schemaVersion','messageId','threadId','providerMessageHistoryId',
      'rawObservationId','rawObservationContentHash','internalDate',
      'sourceRecordedAt','labelIds','rawObject','parserVersion'
    ]) or (select count(*) from jsonb_object_keys(p_parse_child->'payload'))<>11
    or p_parse_child#>>'{payload,schemaVersion}'<>'gmail-parse-rfc822-job-v2'
    or p_parse_child#>>'{payload,messageId}'<>v_group.message_id
    or p_parse_child#>>'{payload,providerMessageHistoryId}'<>v_provider_history
    or p_parse_child#>>'{payload,rawObservationId}'<>v_raw_id
    or p_parse_child#>>'{payload,rawObservationContentHash}'<>v_raw_sha
    or p_parse_child#>>'{payload,threadId}' is distinct from
      p_raw_observation#>>'{normalizedPayload,threadId}'
    or p_parse_child#>>'{payload,internalDate}' is distinct from
      p_raw_observation#>>'{normalizedPayload,internalDate}'
    or p_parse_child#>>'{payload,sourceRecordedAt}' is distinct from
      p_raw_observation#>>'{normalizedPayload,providerReceivedAt}'
    or p_parse_child#>'{payload,labelIds}' is distinct from
      p_raw_observation#>'{normalizedPayload,labelIds}'
    or p_parse_child#>'{payload,rawObject}' is distinct from
      p_raw_observation->'rawObject'
    or nullif(p_parse_child#>>'{payload,parserVersion}','') is null then
    raise exception 'Gmail intrinsic parse child authority is invalid'
      using errcode='23514';
  end if;
  v_parse_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(p_parse_child->'payload'),'UTF8'
  ),'sha256'),'hex');
  v_parse_dedupe:='gmail:parse-rfc822:v2:'||v_parse_hash;
  if p_parse_child->>'dedupeKey'<>v_parse_dedupe then
    raise exception 'Gmail intrinsic parse child identity is invalid'
      using errcode='23514';
  end if;

  select * into v_raw from public.source_observations
  where workspace_key=p_workspace_key and source_system='gmail'
    and connection_key=v_group.connection_key
    and source_object_type='gmail_message_raw'
    and source_object_id=v_group.message_id
    and source_revision=v_provider_history and operation='content';
  if found then
    select receipt.* into strict v_owner
    from public.gmail_message_materialization_receipts receipt
    where receipt.workspace_key=p_workspace_key
      and receipt.message_id=v_group.message_id
      and receipt.provider_history_id=v_provider_history
      and receipt.disposition='first_materialized';
    select * into strict v_owner_group
    from public.gmail_message_materialization_groups
    where workspace_key=p_workspace_key and group_id=v_owner.group_id;
    if v_raw.observation_id<>v_raw_id or v_raw.content_hash<>v_raw_sha
      or v_raw.schema_version<>'gmail-raw-message-v2'
      or v_raw.source_fidelity<>'raw'
      or v_raw.normalized_payload is distinct from
        p_raw_observation->'normalizedPayload'
      or v_raw.raw_object_bucket<>p_raw_observation#>>'{rawObject,bucket}'
      or v_raw.raw_object_key<>p_raw_observation#>>'{rawObject,key}'
      or coalesce(v_raw.raw_object_version,'')<>
        coalesce(p_raw_observation#>>'{rawObject,version}','')
      or coalesce(v_raw.raw_object_etag,'')<>
        coalesce(p_raw_observation#>>'{rawObject,etag}','')
      or v_raw.raw_object_hash<>v_raw_sha
      or v_raw.raw_object_bytes<>v_raw_bytes
      or v_raw.raw_content_type<>'message/rfc822' then
      raise exception 'Gmail provider revision conflicts with intrinsic evidence'
        using errcode='23505';
    end if;
    select * into strict v_parse from public.source_processing_jobs
    where workspace_key=p_workspace_key and job_id=v_owner.parse_job_id;
    if v_parse.dedupe_key<>v_parse_dedupe
      or v_parse.job_kind<>'gmail_parse_rfc822'
      or v_parse.observation_id<>v_raw_id
      or v_parse.source_object_id<>v_group.message_id
      or v_parse.payload is distinct from p_parse_child->'payload' then
      raise exception 'Gmail provider revision parse authority conflicts'
        using errcode='23505';
    end if;
    v_disposition:=case when v_owner.group_id=v_group.group_id
      then 'first_materialized' else 'prior_exact_revision_reobserved' end;
  else
    insert into public.source_observations(
      observation_id,workspace_key,source_system,connection_key,
      source_object_type,source_object_id,source_revision,operation,
      source_cursor_version,batch_id,content_hash,source_recorded_at,captured_at,
      normalized_payload,normalized_text,raw_object_bucket,raw_object_key,
      raw_object_version,raw_object_etag,raw_object_hash,raw_object_bytes,
      raw_content_type,source_fidelity,schema_version,retention_class
    ) values (
      v_raw_id,p_workspace_key,'gmail',v_group.connection_key,
      'gmail_message_raw',v_group.message_id,v_provider_history,'content',
      v_group.source_cursor_version,v_group.root_batch_id,v_raw_sha,
      (p_raw_observation->>'sourceRecordedAt')::timestamptz,clock_timestamp(),
      p_raw_observation->'normalizedPayload','',
      p_raw_observation#>>'{rawObject,bucket}',
      p_raw_observation#>>'{rawObject,key}',
      nullif(p_raw_observation#>>'{rawObject,version}',''),
      nullif(p_raw_observation#>>'{rawObject,etag}',''),
      v_raw_sha,v_raw_bytes,'message/rfc822','raw','gmail-raw-message-v2',
      'shipment-operations'
    );
    select * into strict v_raw from public.source_observations
    where workspace_key=p_workspace_key and observation_id=v_raw_id;
    insert into public.source_processing_jobs(
      dedupe_key,workspace_key,source_system,connection_key,job_kind,
      observation_id,source_object_id,state,max_attempts,payload
    ) values (
      v_parse_dedupe,p_workspace_key,'gmail',v_group.connection_key,
      'gmail_parse_rfc822',v_raw_id,v_group.message_id,'queued',5,
      p_parse_child->'payload'
    );
    select * into strict v_parse from public.source_processing_jobs
    where dedupe_key=v_parse_dedupe;
    insert into public.source_processing_job_lineage(
      job_id,workspace_key,source_system,connection_key,root_batch_id,
      parent_job_id,root_job_id,source_cursor_version,source_cursor_value
    ) values (
      v_parse.job_id,p_workspace_key,'gmail',v_group.connection_key,
      v_group.root_batch_id,p_job_id,p_job_id,v_group.source_cursor_version,
      v_group.source_cursor_value
    );
    insert into public.source_processing_job_children(
      parent_job_id,child_job_id,ordinal
    ) values (p_job_id,v_parse.job_id,0);
    v_owner_group:=v_group;
    v_disposition:='first_materialized';
  end if;
  insert into public.source_processing_job_observations(
    job_id,observation_id,ordinal
  ) values (p_job_id,v_raw_id,0) on conflict do nothing;

  v_receipt_body:=jsonb_build_object(
    'schemaVersion','gmail-materialization-receipt-v1',
    'workspaceKey',p_workspace_key,
    'materializationGroupId',v_group.group_id,
    'materializationGroupHash',v_group.group_hash,
    'routeSealId',v_seal.seal_id,'routeSealHash',v_seal.seal_hash,
    'rootBatchId',v_group.root_batch_id,'rootBatchHash',v_batch.batch_hash,
    'sourceCursorVersion',v_group.source_cursor_version,
    'sourceCursorValue',v_group.source_cursor_value,
    'messageId',v_group.message_id,
    'providerMessageHistoryId',v_provider_history,
    'disposition',v_disposition,
    'evidenceOwnerGroupId',v_owner_group.group_id,
    'evidenceOwnerGroupHash',v_owner_group.group_hash,
    'evidenceOwnerSourceCursorVersion',v_owner_group.source_cursor_version,
    'evidenceOwnerSourceCursorValue',v_owner_group.source_cursor_value,
    'rawObservationId',v_raw_id,
    'rawObservationContentHash',v_raw_sha,
    'parseJobId',v_parse.job_id,
    'parseJobDedupeKey',v_parse.dedupe_key
  );
  v_receipt_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt_body),'UTF8'
  ),'sha256'),'hex');
  v_receipt_id:='gmail-materialization-receipt:v1:'||v_receipt_hash;
  insert into public.gmail_message_materialization_receipts(
    workspace_key,receipt_id,group_id,group_hash,root_batch_id,
    source_cursor_version,source_cursor_value,message_id,provider_history_id,
    disposition,evidence_owner_group_id,evidence_owner_group_hash,
    evidence_owner_source_cursor_version,evidence_owner_source_cursor_value,
    raw_observation_id,raw_observation_content_hash,parse_job_id,
    canonical_receipt,receipt_hash,schema_version
  ) values (
    p_workspace_key,v_receipt_id,v_group.group_id,v_group.group_hash,
    v_group.root_batch_id,v_group.source_cursor_version,
    v_group.source_cursor_value,v_group.message_id,v_provider_history,
    v_disposition,v_owner_group.group_id,v_owner_group.group_hash,
    v_owner_group.source_cursor_version,v_owner_group.source_cursor_value,
    v_raw_id,v_raw_sha,v_parse.job_id,v_receipt_body,v_receipt_hash,
    'gmail-materialization-receipt-v1'
  ) on conflict(workspace_key,group_id) do nothing;
  select * into strict v_existing
  from public.gmail_message_materialization_receipts
  where workspace_key=p_workspace_key and group_id=v_group.group_id;
  if v_existing.canonical_receipt is distinct from v_receipt_body then
    raise exception 'Gmail materialization receipt conflicts on replay'
      using errcode='23505';
  end if;

  v_observation_manifest:=jsonb_build_array(p_raw_observation);
  v_child_manifest:=case when v_disposition='first_materialized'
    then jsonb_build_array(p_parse_child) else '[]'::jsonb end;
  v_child_receipts:=case when v_disposition='first_materialized'
    then jsonb_build_array(jsonb_build_object(
      'jobId',v_parse.job_id,'dedupeKey',v_parse.dedupe_key,
      'jobKind',v_parse.job_kind,'observationId',v_parse.observation_id
    )) else '[]'::jsonb end;
  v_completion_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
    'jobId',p_job_id,'leaseFence',p_lease_fence,
    'processorVersion',p_processor_version,'result',p_result,
    'observations',v_observation_manifest,'childJobs',v_child_manifest,
    'rootBatchId',v_group.root_batch_id,
    'sourceCursorVersion',v_group.source_cursor_version,
    'sourceCursorValue',v_group.source_cursor_value,
    'materializationReceiptHash',v_receipt_hash
  )::text,'UTF8'),'sha256'),'hex');
  if v_job.state='succeeded' then
    if v_job.lease_fence<>p_lease_fence
      or v_job.processor_version<>p_processor_version
      or v_job.result->>'completionHash'<>v_completion_hash then
      raise exception 'Gmail materialization completion conflicts on replay'
        using errcode='23505';
    end if;
  else
    if v_job.state<>'leased' or v_job.lease_owner<>p_worker_id
      or v_job.lease_fence<>p_lease_fence
      or v_job.processor_version<>p_processor_version
      or v_job.lease_expires_at<=v_now then
      raise exception 'Gmail materialization lease lost' using errcode='40001';
    end if;
    update public.source_processing_jobs
    set state='succeeded',lease_owner=null,lease_expires_at=null,
      result=p_result||jsonb_build_object(
        'completionHash',v_completion_hash,
        'resultObservationIds',jsonb_build_array(v_raw_id),
        'childJobs',v_child_receipts,'rootBatchId',v_group.root_batch_id,
        'sourceCursorVersion',v_group.source_cursor_version,
        'sourceCursorValue',v_group.source_cursor_value,
        'materializationReceiptId',v_receipt_id,
        'materializationReceiptHash',v_receipt_hash,
        'materializationDisposition',v_disposition,
        'materializationGroupHash',v_group.group_hash,
        'evidenceOwnerGroupId',v_owner_group.group_id,
        'evidenceOwnerGroupHash',v_owner_group.group_hash,
        'evidenceOwnerSourceCursorVersion',v_owner_group.source_cursor_version,
        'evidenceOwnerSourceCursorValue',v_owner_group.source_cursor_value,
        'rawObservationId',v_raw_id,
        'rawObservationContentHash',v_raw_sha,'parseJobId',v_parse.job_id
      ),updated_at=v_now,completed_at=v_now
    where workspace_key=p_workspace_key and job_id=p_job_id
      and state='leased' and lease_owner=p_worker_id
      and lease_fence=p_lease_fence and lease_expires_at>v_now
      and processor_version=p_processor_version;
    if not found then
      raise exception 'Gmail materialization lease lost' using errcode='40001';
    end if;
  end if;
  return jsonb_build_object(
    'ok',true,'idempotent',v_job.state='succeeded','jobId',p_job_id,
    'state','succeeded','attemptCount',v_job.attempt_count,
    'leaseFence',p_lease_fence,'completionHash',v_completion_hash,
    'resultObservationIds',jsonb_build_array(v_raw_id),
    'childJobs',v_child_receipts,'rootBatchId',v_group.root_batch_id,
    'sourceCursorVersion',v_group.source_cursor_version,
    'sourceCursorValue',v_group.source_cursor_value,
    'materializationReceiptId',v_receipt_id,
    'materializationReceiptHash',v_receipt_hash,
    'materializationDisposition',v_disposition,
    'materializationGroupId',v_group.group_id,
    'materializationGroupHash',v_group.group_hash,
    'evidenceOwnerGroupId',v_owner_group.group_id,
    'evidenceOwnerGroupHash',v_owner_group.group_hash,
    'evidenceOwnerSourceCursorVersion',v_owner_group.source_cursor_version,
    'evidenceOwnerSourceCursorValue',v_owner_group.source_cursor_value,
    'providerMessageHistoryId',v_provider_history,
    'rawObservationId',v_raw_id,'rawObservationContentHash',v_raw_sha,
    'parseJobId',v_parse.job_id
  );
end;
$function$;

create or replace function public.complete_gmail_message_revision_materialization(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_result jsonb,p_raw_observation jsonb,
  p_parse_child jsonb,p_sync_token text
)
returns jsonb language sql security definer set search_path=''
as $function$
  select private.complete_gmail_message_revision_materialization(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_result,p_raw_observation,p_parse_child,p_sync_token
  );
$function$;

revoke all on function private.complete_gmail_message_revision_materialization(
  text,uuid,text,bigint,text,jsonb,jsonb,jsonb,text
) from public,anon,authenticated,service_role;
revoke all on function public.complete_gmail_message_revision_materialization(
  text,uuid,text,bigint,text,jsonb,jsonb,jsonb,text
) from public,anon,authenticated,service_role;
grant execute on function public.complete_gmail_message_revision_materialization(
  text,uuid,text,bigint,text,jsonb,jsonb,jsonb,text
) to service_role;


create or replace function private.gmail_materialization_terminal_member_v1(
  p_workspace_key text,p_group_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_group public.gmail_message_materialization_groups%rowtype;
  v_owner_group public.gmail_message_materialization_groups%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_seal public.gmail_batch_materialization_route_seals%rowtype;
  v_anchor public.source_observations%rowtype;
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_receipt public.gmail_message_materialization_receipts%rowtype;
  v_raw public.source_observations%rowtype;
  v_parse public.source_processing_jobs%rowtype;
  v_parse_lineage public.source_processing_job_lineage%rowtype;
  v_parsed public.source_observations%rowtype;
  v_revision public.gmail_message_revision_obligations%rowtype;
  v_coverage_manifest jsonb;
  v_coverage_count integer;
  v_coverage_hash text;
  v_parsed_count integer;
  v_parsed_id text;
  v_provider_history text:='';
  v_disposition text;
  v_terminal_id text:='';
  v_terminal_hash text:='';
  v_obligation jsonb;
  v_member jsonb;
  v_hash text;
  v_labels_hash text;
  v_parsed_hash text;
  v_parsed_identity jsonb;
  v_expected_parsed_id text;
begin
  select * into strict v_group
  from public.gmail_message_materialization_groups
  where workspace_key=p_workspace_key and group_id=p_group_id;
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=v_group.root_batch_id
    and source_system='gmail' and connection_key=v_group.connection_key
    and status='committed' and batch_hash~'^[0-9a-f]{64}$'
    and committed_cursor_version=v_group.source_cursor_version
    and committed_cursor_value=v_group.source_cursor_value;
  select * into strict v_seal
  from public.gmail_batch_materialization_route_seals
  where workspace_key=p_workspace_key and root_batch_id=v_group.root_batch_id;
  select * into strict v_anchor from public.source_observations
  where workspace_key=p_workspace_key
    and observation_id=v_group.selected_observation_id;
  select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
    'pageOrdinal',coverage.page_ordinal,
    'triggerObservationId',coverage.trigger_observation_id,
    'triggerObservationContentHash',coverage.trigger_observation_content_hash,
    'triggerKind',coverage.trigger_kind,'eventType',coverage.event_type,
    'historyId',coverage.history_id
  ) order by coverage.history_id::numeric,coverage.event_type,
    coverage.trigger_observation_id,coverage.page_ordinal),'[]'::jsonb)
  into v_coverage_count,v_coverage_manifest
  from public.gmail_message_materialization_coverage coverage
  where coverage.workspace_key=p_workspace_key
    and coverage.group_id=v_group.group_id;
  v_coverage_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_coverage_manifest),'UTF8'
  ),'sha256'),'hex');
  if v_coverage_count<>v_group.coverage_count
    or v_coverage_hash<>v_group.coverage_manifest_hash
    or v_anchor.content_hash<>v_group.selected_observation_content_hash
    or v_anchor.source_object_id<>v_group.message_id
    or v_anchor.normalized_payload->>'historyId'<>v_group.selected_history_id
    or v_anchor.normalized_payload->>'eventType'<>v_group.selected_event_type then
    raise exception 'Gmail materialization group coverage authority is invalid'
      using errcode='23514';
  end if;

  if v_group.route_disposition='deleted_at_cut' then
    if v_group.materialization_job_id is not null
      or v_group.selected_event_type<>'message_deleted'
      or v_anchor.source_object_type<>'gmail_message_history_event'
      or v_anchor.operation<>'delete' then
      raise exception 'Gmail deleted route lacks exact provider authority'
        using errcode='23514';
    end if;
    v_provider_history:=v_group.selected_history_id;
    v_disposition:='deleted_at_cut';
    v_terminal_id:=v_group.group_id;
    v_terminal_hash:=v_group.group_hash;
  else
    select * into strict v_job from public.source_processing_jobs
    where workspace_key=p_workspace_key and job_id=v_group.materialization_job_id;
    select * into strict v_lineage from public.source_processing_job_lineage
    where workspace_key=p_workspace_key and job_id=v_group.materialization_job_id;
    if not private.gmail_materialization_group_job_valid_v1(
        v_job,v_lineage,v_group,v_anchor
      ) then
      v_obligation:=private.append_gmail_parse_checkpoint_obligation_v1(
        p_workspace_key,v_group.root_batch_id,v_job.job_id,
        'FETCH_CONTRACT_INVALID',jsonb_build_object(
          'schemaVersion','gmail-parse-checkpoint-obligation-detail-v1',
          'reasonCode','MATERIALIZATION_GROUP_OR_LINEAGE_CONTRACT_INVALID'
        )
      );
      v_disposition:='poison_quarantined_review';
      v_terminal_id:=v_obligation->>'obligationId';
      v_terminal_hash:=v_obligation->>'obligationHash';
    else
      select * into v_revision
      from public.gmail_message_revision_obligations
      where workspace_key=p_workspace_key and fetch_job_id=v_job.job_id;
      select * into v_receipt
      from public.gmail_message_materialization_receipts
      where workspace_key=p_workspace_key and group_id=v_group.group_id;
      if v_revision.obligation_id is not null
        and v_receipt.receipt_id is not null then
        raise exception 'Gmail materialization has both revision gap and evidence receipt'
          using errcode='23514';
      elsif v_revision.obligation_id is not null then
        if v_job.state<>'succeeded'
          or v_job.result->>'schemaVersion'
            <>'gmail-message-revision-obligation-result-v1'
          or v_job.result->>'obligationId'<>v_revision.obligation_id
          or v_job.result->>'obligationHash'<>v_revision.obligation_hash then
          raise exception 'Gmail revision obligation differs from job result'
            using errcode='23514';
        end if;
        v_provider_history:=v_revision.provider_history_id;
        v_terminal_id:=v_revision.obligation_id;
        v_terminal_hash:=v_revision.obligation_hash;
        v_disposition:=case v_revision.reason_code
          when 'PROVIDER_HISTORY_ID_AHEAD_OF_COMMITTED_CUT'
            then 'provider_revision_ahead_gap'
          when 'PROVIDER_MESSAGE_DELETED_UNAVAILABLE'
            then 'provider_deleted_unavailable_gap'
          when 'FETCH_POISON_QUARANTINED_REVIEW'
            then 'poison_quarantined_review'
          else 'revision_contract_gap' end;
      elsif v_receipt.receipt_id is null
        and v_job.state in ('queued','leased','retry_wait','waiting_runtime') then
        return jsonb_build_object(
          'status','not_ready','reasonCode','MATERIALIZATION_NOT_TERMINAL'
        );
      elsif v_receipt.receipt_id is null and v_job.state='dead_letter' then
        v_obligation:=private.append_gmail_parse_checkpoint_obligation_v1(
          p_workspace_key,v_group.root_batch_id,v_job.job_id,
          'FETCH_CONTRACT_INVALID',jsonb_build_object(
            'schemaVersion','gmail-parse-checkpoint-obligation-detail-v1',
            'reasonCode','FETCH_POISON_QUARANTINED_REVIEW',
            'lastErrorCode',v_job.last_error_code
          )
        );
        v_disposition:='poison_quarantined_review';
        v_terminal_id:=v_obligation->>'obligationId';
        v_terminal_hash:=v_obligation->>'obligationHash';
      elsif v_receipt.receipt_id is null then
        raise exception 'Gmail materialization terminal state lacks authority'
          using errcode='23514';
      else
        v_provider_history:=v_receipt.provider_history_id;
        select * into strict v_owner_group
        from public.gmail_message_materialization_groups
        where workspace_key=p_workspace_key
          and group_id=v_receipt.evidence_owner_group_id;
        select * into strict v_raw from public.source_observations
        where workspace_key=p_workspace_key
          and observation_id=v_receipt.raw_observation_id;
        select * into strict v_parse from public.source_processing_jobs
        where workspace_key=p_workspace_key and job_id=v_receipt.parse_job_id;
        select * into strict v_parse_lineage
        from public.source_processing_job_lineage
        where workspace_key=p_workspace_key and job_id=v_receipt.parse_job_id;
        if v_job.state<>'succeeded'
          or v_job.result->>'materializationReceiptId'<>v_receipt.receipt_id
          or v_job.result->>'materializationReceiptHash'<>v_receipt.receipt_hash
          or v_job.result->>'materializationDisposition'<>v_receipt.disposition
          or v_job.result->>'providerMessageHistoryId'<>v_provider_history
          or v_job.result->>'rawObservationId'<>v_raw.observation_id
          or v_job.result->>'rawObservationContentHash'<>v_raw.content_hash
          or v_job.result->>'parseJobId'<>v_parse.job_id::text
          or v_raw.source_system<>'gmail'
          or v_raw.connection_key<>v_group.connection_key
          or v_raw.source_object_type<>'gmail_message_raw'
          or v_raw.source_object_id<>v_group.message_id
          or v_raw.source_revision<>v_provider_history
          or v_raw.operation<>'content'
          or v_raw.content_hash<>v_receipt.raw_observation_content_hash
          or v_raw.schema_version<>'gmail-raw-message-v2'
          or v_raw.source_fidelity<>'raw'
          or not private.truth_jsonb_has_only_keys(v_raw.normalized_payload,array[
            'schemaVersion','messageId','threadId','providerMessageHistoryId',
            'internalDate','providerReceivedAt','labelIds','sizeEstimate',
            'rawSha256','rawBytes'
          ])
          or (select count(*) from jsonb_object_keys(v_raw.normalized_payload))<>10
          or v_raw.normalized_payload->>'schemaVersion'<>'gmail-raw-message-v2'
          or v_raw.normalized_payload->>'messageId'<>v_group.message_id
          or v_raw.normalized_payload->>'providerMessageHistoryId'
            <>v_provider_history
          or v_raw.normalized_payload->>'rawSha256'<>v_raw.content_hash
          or v_raw.raw_object_hash<>v_raw.content_hash
          or v_raw.normalized_payload->>'rawBytes'<>v_raw.raw_object_bytes::text
          or v_parse.job_kind<>'gmail_parse_rfc822'
          or v_parse.observation_id<>v_raw.observation_id
          or v_parse.source_object_id<>v_group.message_id
          or v_parse.payload->>'schemaVersion'<>'gmail-parse-rfc822-job-v2'
          or not private.truth_jsonb_has_only_keys(v_parse.payload,array[
            'schemaVersion','messageId','threadId','providerMessageHistoryId',
            'rawObservationId','rawObservationContentHash','internalDate',
            'sourceRecordedAt','labelIds','rawObject','parserVersion'
          ])
          or (select count(*) from jsonb_object_keys(v_parse.payload))<>11
          or v_parse.payload->>'messageId'<>v_group.message_id
          or v_parse.payload->>'providerMessageHistoryId'<>v_provider_history
          or v_parse.payload->>'rawObservationId'<>v_raw.observation_id
          or v_parse.payload->>'rawObservationContentHash'<>v_raw.content_hash
          or v_parse.payload->>'threadId' is distinct from
            v_raw.normalized_payload->>'threadId'
          or v_parse.payload->>'internalDate' is distinct from
            v_raw.normalized_payload->>'internalDate'
          or v_parse.payload->>'sourceRecordedAt' is distinct from
            v_raw.normalized_payload->>'providerReceivedAt'
          or v_parse.payload->'labelIds' is distinct from
            v_raw.normalized_payload->'labelIds'
          or v_parse_lineage.parent_job_id<>v_owner_group.materialization_job_id
          or v_parse_lineage.root_job_id<>v_owner_group.materialization_job_id
          or v_parse_lineage.root_batch_id<>v_owner_group.root_batch_id
          or v_parse_lineage.source_cursor_version
            <>v_owner_group.source_cursor_version
          or v_parse_lineage.source_cursor_value
            <>v_owner_group.source_cursor_value then
          raise exception 'Gmail intrinsic raw or parse authority is invalid'
            using errcode='23514';
        end if;
        if v_parse.state in ('queued','leased','retry_wait','waiting_runtime') then
          return jsonb_build_object(
            'status','not_ready','reasonCode','PARSE_CHILD_NOT_TERMINAL'
          );
        elsif v_parse.state='dead_letter' then
          v_obligation:=private.append_gmail_parse_checkpoint_obligation_v1(
            p_workspace_key,v_group.root_batch_id,v_parse.job_id,
            'PARSE_CONTRACT_INVALID',jsonb_build_object(
              'schemaVersion','gmail-parse-checkpoint-obligation-detail-v1',
              'reasonCode','PARSE_POISON_QUARANTINED_REVIEW',
              'lastErrorCode',v_parse.last_error_code
            )
          );
          v_disposition:='poison_quarantined_review';
          v_terminal_id:=v_obligation->>'obligationId';
          v_terminal_hash:=v_obligation->>'obligationHash';
        elsif v_parse.state<>'succeeded'
          or not private.truth_jsonb_has_only_keys(v_parse.result,array[
            'schemaVersion','messageId','providerMessageHistoryId',
            'rawObservationId','parserVersion','parsedContentHash',
            'attachmentCount','completionHash','resultObservationIds','childJobs',
            'rootBatchId','sourceCursorVersion','sourceCursorValue'
          ])
          or v_parse.result->>'schemaVersion'<>'gmail-parse-result-v2'
          or v_parse.result->>'messageId'<>v_group.message_id
          or v_parse.result->>'providerMessageHistoryId'<>v_provider_history
          or v_parse.result->>'rawObservationId'<>v_raw.observation_id
          or v_parse.result->>'parserVersion'<>v_parse.payload->>'parserVersion'
          or coalesce(v_parse.result->>'parsedContentHash','')
            !~'^[0-9a-f]{64}$'
          or coalesce(v_parse.result->>'attachmentCount','')!~'^[0-9]+$' then
          v_obligation:=private.append_gmail_parse_checkpoint_obligation_v1(
            p_workspace_key,v_group.root_batch_id,v_parse.job_id,
            'PARSE_CONTRACT_INVALID',jsonb_build_object(
              'schemaVersion','gmail-parse-checkpoint-obligation-detail-v1',
              'reasonCode','PARSE_RESULT_OR_LINEAGE_CONTRACT_INVALID'
            )
          );
          v_disposition:='poison_quarantined_review';
          v_terminal_id:=v_obligation->>'obligationId';
          v_terminal_hash:=v_obligation->>'obligationHash';
        else
          select count(*)::integer,min(observation.observation_id)
          into v_parsed_count,v_parsed_id
          from public.source_processing_job_observations witness
          join public.source_observations observation
            on observation.observation_id=witness.observation_id
           and observation.workspace_key=p_workspace_key
           and observation.source_object_type='gmail_message_parsed'
          where witness.job_id=v_parse.job_id;
          if v_parsed_count<>1 then
            v_obligation:=private.append_gmail_parse_checkpoint_obligation_v1(
              p_workspace_key,v_group.root_batch_id,v_parse.job_id,
              'PARSED_OUTPUT_CONFLICT',jsonb_build_object(
                'schemaVersion','gmail-parse-checkpoint-obligation-detail-v1',
                'reasonCode','PARSED_OUTPUT_CARDINALITY_INVALID',
                'outputCount',v_parsed_count
              )
            );
            v_disposition:='poison_quarantined_review';
            v_terminal_id:=v_obligation->>'obligationId';
            v_terminal_hash:=v_obligation->>'obligationHash';
          else
            select * into strict v_parsed from public.source_observations
            where workspace_key=p_workspace_key and observation_id=v_parsed_id;
            v_parsed_hash:=encode(extensions.digest(convert_to(
              private.truth_canonical_json_text(v_parsed.normalized_payload),
              'UTF8'
            ),'sha256'),'hex');
            v_labels_hash:=encode(extensions.digest(convert_to(
              private.truth_canonical_json_text(
                v_raw.normalized_payload->'labelIds'
              ),'UTF8'
            ),'sha256'),'hex');
            v_parsed_identity:=jsonb_build_object(
              'schemaVersion','source-observation-identity-v1',
              'workspaceKey',p_workspace_key,'sourceSystem','gmail',
              'connectionKey',v_group.connection_key,
              'sourceObjectType','gmail_message_parsed',
              'sourceObjectId',v_group.message_id,
              'sourceRevision',v_provider_history,'operation','content',
              'contentHash',v_parsed.content_hash
            );
            v_expected_parsed_id:='obs:v1:'||encode(extensions.digest(convert_to(
              private.truth_canonical_json_text(v_parsed_identity),'UTF8'
            ),'sha256'),'hex');
            if v_parsed.observation_id<>v_expected_parsed_id
              or v_parsed.source_system<>'gmail'
              or v_parsed.connection_key<>v_group.connection_key
              or v_parsed.source_object_type<>'gmail_message_parsed'
              or v_parsed.source_object_id<>v_group.message_id
              or v_parsed.source_revision<>v_provider_history
              or v_parsed.operation<>'content'
              or v_parsed.content_hash<>v_parse.result->>'parsedContentHash'
              or v_parsed.content_hash<>v_parsed_hash
              or v_parsed.schema_version<>'gmail-parsed-message-v2'
              or v_parsed.normalized_payload->>'schemaVersion'
                <>'gmail-parsed-message-v2'
              or jsonb_typeof(v_parsed.normalized_payload->'gmail')<>'object'
              or not private.truth_jsonb_has_only_keys(
                v_parsed.normalized_payload->'gmail',array[
                  'messageId','threadId','historyId','providerHistoryId',
                  'internalDate','providerReceivedAt','labelIds','labelIdsHash',
                  'rawObservationId','rawObservationContentHash'
                ])
              or (select count(*) from jsonb_object_keys(
                v_parsed.normalized_payload->'gmail'))<>10
              or v_parsed.normalized_payload#>>'{gmail,messageId}'
                <>v_group.message_id
              or v_parsed.normalized_payload#>>'{gmail,threadId}' is distinct from
                v_raw.normalized_payload->>'threadId'
              or v_parsed.normalized_payload#>>'{gmail,historyId}'
                <>v_provider_history
              or v_parsed.normalized_payload#>>'{gmail,providerHistoryId}'
                <>v_provider_history
              or v_parsed.normalized_payload#>>'{gmail,internalDate}'
                is distinct from v_raw.normalized_payload->>'internalDate'
              or v_parsed.normalized_payload#>>'{gmail,providerReceivedAt}'
                is distinct from v_raw.normalized_payload->>'providerReceivedAt'
              or v_parsed.normalized_payload#>'{gmail,labelIds}' is distinct from
                v_raw.normalized_payload->'labelIds'
              or v_parsed.normalized_payload#>>'{gmail,labelIdsHash}'
                <>v_labels_hash
              or v_parsed.normalized_payload#>>'{gmail,rawObservationId}'
                <>v_raw.observation_id
              or v_parsed.normalized_payload#>>'{gmail,rawObservationContentHash}'
                <>v_raw.content_hash then
              v_obligation:=private.append_gmail_parse_checkpoint_obligation_v1(
                p_workspace_key,v_group.root_batch_id,v_parse.job_id,
                'PARSED_OUTPUT_CONFLICT',jsonb_build_object(
                  'schemaVersion','gmail-parse-checkpoint-obligation-detail-v1',
                  'reasonCode','PARSED_INTRINSIC_CONTENT_AUTHORITY_INVALID'
                )
              );
              v_disposition:='poison_quarantined_review';
              v_terminal_id:=v_obligation->>'obligationId';
              v_terminal_hash:=v_obligation->>'obligationHash';
            else
              v_disposition:='parsed_exact_revision';
              v_terminal_id:=v_receipt.receipt_id;
              v_terminal_hash:=v_receipt.receipt_hash;
            end if;
          end if;
        end if;
      end if;
    end if;
  end if;

  v_member:=jsonb_build_object(
    'schemaVersion','gmail-parse-checkpoint-member-v1',
    'workspaceKey',p_workspace_key,'rootBatchId',v_batch.batch_id,
    'rootBatchHash',v_batch.batch_hash,'connectionKey',v_group.connection_key,
    'sourceCursorVersion',v_group.source_cursor_version,
    'sourceCursorValue',v_group.source_cursor_value,
    'routeSealId',v_seal.seal_id,'routeSealHash',v_seal.seal_hash,
    'routeManifestHash',v_seal.route_manifest_hash,
    'groupId',v_group.group_id,'groupHash',v_group.group_hash,
    'messageId',v_group.message_id,
    'routeDisposition',v_group.route_disposition,
    'selectedTrigger',jsonb_build_object(
      'observationId',v_group.selected_observation_id,
      'contentHash',v_group.selected_observation_content_hash,
      'kind',v_group.selected_trigger_kind,
      'eventType',v_group.selected_event_type,
      'historyId',v_group.selected_history_id
    ),
    'coverageCount',v_group.coverage_count,
    'coverageManifestHash',v_group.coverage_manifest_hash,
    'materializationJobId',coalesce(v_group.materialization_job_id::text,''),
    'materializationReceiptId',coalesce(v_receipt.receipt_id,''),
    'materializationReceiptHash',coalesce(v_receipt.receipt_hash,''),
    'providerHistoryId',coalesce(v_provider_history,''),
    'terminalDisposition',v_disposition,
    'rawObservationId',coalesce(v_raw.observation_id,''),
    'rawContentHash',coalesce(v_raw.content_hash,''),
    'parseJobId',coalesce(v_parse.job_id::text,''),
    'parsedObservationId',coalesce(v_parsed.observation_id,''),
    'parsedContentHash',coalesce(v_parsed.content_hash,''),
    'terminalAuthorityId',v_terminal_id,
    'terminalAuthorityHash',v_terminal_hash
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_member),'UTF8'
  ),'sha256'),'hex');
  return jsonb_build_object(
    'status','ready','canonicalMember',v_member,'memberHash',v_hash,
    'memberId','gmail-parse-checkpoint-member:v1:'||v_hash,
    'terminalDisposition',v_disposition
  );
end;
$function$;

revoke all on function private.gmail_materialization_terminal_member_v1(text,text)
  from public,anon,authenticated,service_role;

create or replace function private.resolve_gmail_message_revision_obligation(
  p_workspace_key text,p_obligation_id text,p_resolution_kind text,
  p_resolving_fetch_job_id uuid,p_resolution_observation_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_obligation public.gmail_message_revision_obligations%rowtype;
  v_existing public.gmail_message_revision_resolutions%rowtype;
  v_group public.gmail_message_materialization_groups%rowtype;
  v_receipt public.gmail_message_materialization_receipts%rowtype;
  v_observation public.source_observations%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_member jsonb;
  v_provider_history text;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_inserted integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_resolution_kind<>all(array[
      'later_parsed_exact_revision','later_provider_deletion'
    ])
    or coalesce(p_obligation_id,'')
      !~'^gmail-message-revision-obligation:v1:[0-9a-f]{64}$'
    or coalesce(p_resolution_observation_id,'')
      !~'^obs:v1:[0-9a-f]{64}$'
    or (p_resolution_kind='later_parsed_exact_revision')
      is distinct from (p_resolving_fetch_job_id is not null) then
    raise exception 'Gmail revision resolution input is invalid'
      using errcode='22023';
  end if;
  select * into strict v_obligation
  from public.gmail_message_revision_obligations
  where workspace_key=p_workspace_key and obligation_id=p_obligation_id;
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-parse-checkpoint:'||p_workspace_key||':'||v_obligation.connection_key,0
  ));
  select * into v_existing
  from public.gmail_message_revision_resolutions
  where workspace_key=p_workspace_key and obligation_id=p_obligation_id;
  if found then
    if v_existing.resolution_kind<>p_resolution_kind
      or v_existing.resolving_fetch_job_id is distinct from p_resolving_fetch_job_id
      or v_existing.resolution_observation_id<>p_resolution_observation_id then
      raise exception 'Gmail revision resolution conflicts on replay'
        using errcode='23505';
    end if;
    return jsonb_build_object(
      'ok',true,'idempotent',true,
      'resolutionId',v_existing.resolution_id,
      'resolutionHash',v_existing.resolution_hash,
      'resolutionKind',v_existing.resolution_kind
    );
  end if;
  if v_obligation.reason_code='FETCH_POISON_QUARANTINED_REVIEW' then
    raise exception 'Poison revision obligations require operator adjudication'
      using errcode='23514';
  end if;
  if p_resolution_kind='later_parsed_exact_revision' then
    select * into strict v_group
    from public.gmail_message_materialization_groups
    where workspace_key=p_workspace_key
      and materialization_job_id=p_resolving_fetch_job_id;
    select * into strict v_receipt
    from public.gmail_message_materialization_receipts
    where workspace_key=p_workspace_key and group_id=v_group.group_id;
    v_member:=private.gmail_materialization_terminal_member_v1(
      p_workspace_key,v_group.group_id
    );
    if v_member->>'status'<>'ready'
      or v_member->>'terminalDisposition'<>'parsed_exact_revision'
      or v_member#>>'{canonicalMember,messageId}'<>v_obligation.message_id
      or v_member#>>'{canonicalMember,parsedObservationId}'
        <>p_resolution_observation_id then
      raise exception 'Gmail revision resolution lacks exact later parsed evidence'
        using errcode='23514';
    end if;
    v_provider_history:=v_member#>>'{canonicalMember,providerHistoryId}';
    select * into strict v_observation from public.source_observations
    where workspace_key=p_workspace_key
      and observation_id=p_resolution_observation_id
      and source_object_type='gmail_message_parsed' and operation='content'
      and source_object_id=v_obligation.message_id
      and normalized_payload->>'schemaVersion'='gmail-parsed-message-v2';
  else
    select * into strict v_group
    from public.gmail_message_materialization_groups
    where workspace_key=p_workspace_key
      and selected_observation_id=p_resolution_observation_id
      and route_disposition='deleted_at_cut'
      and message_id=v_obligation.message_id
      and connection_key=v_obligation.connection_key;
    v_member:=private.gmail_materialization_terminal_member_v1(
      p_workspace_key,v_group.group_id
    );
    if v_member->>'status'<>'ready'
      or v_member->>'terminalDisposition'<>'deleted_at_cut' then
      raise exception 'Gmail deletion resolution lacks exact route authority'
        using errcode='23514';
    end if;
    select * into strict v_observation from public.source_observations
    where workspace_key=p_workspace_key
      and observation_id=p_resolution_observation_id;
    v_provider_history:=v_group.selected_history_id;
  end if;
  select * into strict v_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key and batch_id=v_group.root_batch_id
    and source_system='gmail' and connection_key=v_obligation.connection_key
    and status='committed' and batch_hash~'^[0-9a-f]{64}$'
    and committed_cursor_version=v_group.source_cursor_version
    and committed_cursor_value=v_group.source_cursor_value
    and committed_cursor_value~'^[0-9]+$';
  if exists (
    select 1 from public.gmail_parse_checkpoints checkpoint
    where checkpoint.workspace_key=p_workspace_key
      and checkpoint.root_batch_id=v_batch.batch_id
  ) then
    raise exception 'Gmail resolving batch checkpoint is already sealed'
      using errcode='40001';
  end if;
  if v_provider_history!~'^[0-9]+$'
    or v_group.source_cursor_version<=v_obligation.source_cursor_version
    or not private.gmail_history_id_at_least(
      v_group.source_cursor_value,v_provider_history
    )
    or (v_obligation.provider_history_id<>'' and not
      private.gmail_history_id_at_least(
        v_provider_history,v_obligation.provider_history_id
      ))
    or (v_obligation.provider_history_id<>'' and not
      private.gmail_history_id_at_least(
        v_group.source_cursor_value,v_obligation.provider_history_id
      )) then
    raise exception 'Gmail revision resolution is outside the later committed cut'
      using errcode='23514';
  end if;
  if exists (
    select 1
    from public.gmail_message_materialization_groups earlier
    left join public.gmail_message_materialization_receipts earlier_receipt
      on earlier_receipt.workspace_key=earlier.workspace_key
     and earlier_receipt.group_id=earlier.group_id
    left join public.source_processing_jobs earlier_parse
      on earlier_parse.workspace_key=earlier_receipt.workspace_key
     and earlier_parse.job_id=earlier_receipt.parse_job_id
    where earlier.workspace_key=p_workspace_key
      and earlier.connection_key=v_obligation.connection_key
      and earlier.message_id=v_obligation.message_id
      and earlier.source_cursor_version>v_obligation.source_cursor_version
      and (earlier.source_cursor_version<v_group.source_cursor_version
        or (earlier.source_cursor_version=v_group.source_cursor_version
          and earlier.group_id<v_group.group_id))
      and (
        earlier.route_disposition='deleted_at_cut'
        or (earlier_receipt.receipt_id is not null
          and earlier_parse.state='succeeded'
          and earlier_parse.result->>'schemaVersion'='gmail-parse-result-v2')
      )
  ) then
    raise exception 'Earlier committed Gmail evidence must resolve obligation first'
      using errcode='40001';
  end if;
  v_body:=jsonb_build_object(
    'schemaVersion','gmail-message-revision-resolution-v1',
    'workspaceKey',p_workspace_key,'obligationId',p_obligation_id,
    'supersededFetchJobId',v_obligation.fetch_job_id,
    'resolutionKind',p_resolution_kind,
    'resolvingGroupId',v_group.group_id,
    'resolvingGroupHash',v_group.group_hash,
    'resolvingReceiptId',coalesce(v_receipt.receipt_id,''),
    'resolvingReceiptHash',coalesce(v_receipt.receipt_hash,''),
    'resolvingFetchJobId',coalesce(p_resolving_fetch_job_id::text,''),
    'resolvingRootBatchId',v_batch.batch_id,
    'resolvingSourceCursorVersion',v_batch.committed_cursor_version,
    'resolvingSourceCursorValue',v_batch.committed_cursor_value,
    'providerHistoryId',v_provider_history,
    'resolutionObservationId',p_resolution_observation_id,
    'resolutionObservationContentHash',v_observation.content_hash
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'
  ),'sha256'),'hex');
  v_id:='gmail-message-revision-resolution:v1:'||v_hash;
  insert into public.gmail_message_revision_resolutions(
    workspace_key,resolution_id,obligation_id,superseded_fetch_job_id,
    resolution_kind,resolving_group_id,resolving_group_hash,
    resolving_receipt_id,resolving_receipt_hash,resolving_fetch_job_id,
    resolving_root_batch_id,
    resolving_source_cursor_version,resolving_source_cursor_value,
    provider_history_id,resolution_observation_id,canonical_resolution,
    resolution_hash,schema_version
  ) values (
    p_workspace_key,v_id,p_obligation_id,v_obligation.fetch_job_id,
    p_resolution_kind,v_group.group_id,v_group.group_hash,
    coalesce(v_receipt.receipt_id,''),coalesce(v_receipt.receipt_hash,''),
    p_resolving_fetch_job_id,v_batch.batch_id,
    v_batch.committed_cursor_version,v_batch.committed_cursor_value,
    v_provider_history,p_resolution_observation_id,v_body,v_hash,
    'gmail-message-revision-resolution-v1'
  ) on conflict(workspace_key,obligation_id) do nothing;
  get diagnostics v_inserted=row_count;
  select * into strict v_existing
  from public.gmail_message_revision_resolutions
  where workspace_key=p_workspace_key and obligation_id=p_obligation_id;
  if v_existing.canonical_resolution is distinct from v_body then
    raise exception 'Gmail revision resolution conflicts on replay'
      using errcode='23505';
  end if;
  return jsonb_build_object(
    'ok',true,'idempotent',v_inserted=0,
    'resolutionId',v_id,'resolutionHash',v_hash,
    'resolutionKind',p_resolution_kind
  );
end;
$function$;

create or replace function public.resolve_gmail_message_revision_obligation(
  p_workspace_key text,p_obligation_id text,p_resolution_kind text,
  p_resolving_fetch_job_id uuid,p_resolution_observation_id text,
  p_sync_token text
)
returns jsonb language sql security definer set search_path=''
as $function$
  select private.resolve_gmail_message_revision_obligation(
    p_workspace_key,p_obligation_id,p_resolution_kind,p_resolving_fetch_job_id,
    p_resolution_observation_id,p_sync_token
  );
$function$;

revoke all on function private.resolve_gmail_message_revision_obligation(
  text,text,text,uuid,text,text
) from public,anon,authenticated,service_role;
revoke all on function public.resolve_gmail_message_revision_obligation(
  text,text,text,uuid,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.resolve_gmail_message_revision_obligation(
  text,text,text,uuid,text,text
) to service_role;

create or replace function private.auto_resolve_gmail_revision_obligations_v1(
  p_workspace_key text,p_connection_key text,p_target_batch_id uuid,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_target public.source_ingest_batches%rowtype;
  v_epoch public.gmail_parse_processing_epochs%rowtype;
  v_group public.gmail_message_materialization_groups%rowtype;
  v_obligation public.gmail_message_revision_obligations%rowtype;
  v_terminal jsonb;
  v_resolution_kind text;
  v_resolution_job_id uuid;
  v_resolution_observation_id text;
  v_resolved integer:=0;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  select * into strict v_target from public.source_ingest_batches
  where workspace_key=p_workspace_key and source_system='gmail'
    and connection_key=p_connection_key and batch_id=p_target_batch_id
    and status='committed' and committed_cursor_version is not null;
  select * into v_epoch from public.gmail_parse_processing_epochs
  where workspace_key=p_workspace_key and connection_key=p_connection_key;
  if not found
    or v_target.committed_cursor_version<v_epoch.genesis_source_cursor_version then
    return jsonb_build_object('status','ready','resolvedCount',0);
  end if;
  for v_group in
    select group_row.*
    from public.gmail_message_materialization_groups group_row
    where group_row.workspace_key=p_workspace_key
      and group_row.connection_key=p_connection_key
      and group_row.source_cursor_version>=v_epoch.genesis_source_cursor_version
      and group_row.source_cursor_version<=v_target.committed_cursor_version
    order by group_row.source_cursor_version,group_row.message_id,
      group_row.group_id
  loop
    v_terminal:=private.gmail_materialization_terminal_member_v1(
      p_workspace_key,v_group.group_id
    );
    if v_terminal->>'status'='not_ready' then
      return jsonb_build_object(
        'status','not_ready','groupId',v_group.group_id,
        'reasonCode',v_terminal->>'reasonCode','resolvedCount',v_resolved
      );
    end if;
    if v_terminal->>'terminalDisposition'
      not in ('parsed_exact_revision','deleted_at_cut') then
      continue;
    end if;
    if v_terminal->>'terminalDisposition'='parsed_exact_revision' then
      v_resolution_kind:='later_parsed_exact_revision';
      v_resolution_job_id:=v_group.materialization_job_id;
      v_resolution_observation_id:=
        v_terminal#>>'{canonicalMember,parsedObservationId}';
    else
      v_resolution_kind:='later_provider_deletion';
      v_resolution_job_id:=null;
      v_resolution_observation_id:=v_group.selected_observation_id;
    end if;
    for v_obligation in
      select obligation.*
      from public.gmail_message_revision_obligations obligation
      where obligation.workspace_key=p_workspace_key
        and obligation.connection_key=p_connection_key
        and obligation.message_id=v_group.message_id
        and obligation.source_cursor_version>=v_epoch.genesis_source_cursor_version
        and obligation.source_cursor_version<v_group.source_cursor_version
        and obligation.reason_code<>'FETCH_POISON_QUARANTINED_REVIEW'
        and not exists (
          select 1 from public.gmail_message_revision_resolutions resolution
          where resolution.workspace_key=obligation.workspace_key
            and resolution.obligation_id=obligation.obligation_id
        )
      order by obligation.source_cursor_version,obligation.obligation_id
    loop
      perform private.resolve_gmail_message_revision_obligation(
        p_workspace_key,v_obligation.obligation_id,v_resolution_kind,
        v_resolution_job_id,v_resolution_observation_id,p_sync_token
      );
      v_resolved:=v_resolved+1;
    end loop;
  end loop;
  return jsonb_build_object('status','ready','resolvedCount',v_resolved);
end;
$function$;

revoke all on function private.auto_resolve_gmail_revision_obligations_v1(
  text,text,uuid,text
) from public,anon,authenticated,service_role;

create or replace function private.ensure_gmail_parse_checkpoint_chain_v1(
  p_workspace_key text,p_connection_key text,p_target_batch_id uuid,
  p_max_batches integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_target public.source_ingest_batches%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_genesis_batch public.source_ingest_batches%rowtype;
  v_prior_batch public.source_ingest_batches%rowtype;
  v_epoch public.gmail_parse_processing_epochs%rowtype;
  v_seal public.gmail_batch_materialization_route_seals%rowtype;
  v_previous public.gmail_parse_checkpoints%rowtype;
  v_checkpoint public.gmail_parse_checkpoints%rowtype;
  v_group_id text;
  v_terminal jsonb;
  v_members jsonb;
  v_member_manifest jsonb;
  v_route_manifest jsonb;
  v_route_manifest_hash text;
  v_route_count integer;
  v_member_count integer;
  v_terminal_gap_count integer;
  v_pages jsonb;
  v_gap_detections jsonb;
  v_gap_reconciliations jsonb;
  v_fetch_gap_resolutions jsonb;
  v_source_delta jsonb;
  v_source_delta_hash text;
  v_member_manifest_hash text;
  v_cumulative_member_count bigint;
  v_cumulative_terminal_gap_count bigint;
  v_cumulative_resolved_terminal_gap_count bigint;
  v_cumulative_open_terminal_gap_count bigint;
  v_cumulative_batch_count bigint;
  v_cumulative_gap_count bigint;
  v_cumulative_reconciled_gap_count bigint;
  v_cumulative_open_gap_count bigint;
  v_accumulator jsonb;
  v_accumulator_hash text;
  v_source_cut jsonb;
  v_predecessor jsonb;
  v_canonical jsonb;
  v_checkpoint_hash text;
  v_checkpoint_id text;
  v_processed integer:=0;
  v_resolution_required_id text;
begin
  if p_max_batches is null or p_max_batches<1 or p_max_batches>500 then
    raise exception 'Gmail parse-checkpoint page bound is invalid'
      using errcode='22023';
  end if;
  select * into strict v_target from public.source_ingest_batches
  where workspace_key=p_workspace_key and source_system='gmail'
    and connection_key=p_connection_key and batch_id=p_target_batch_id
    and status='committed' and batch_hash~'^[0-9a-f]{64}$'
    and committed_cursor_version is not null
    and committed_cursor_value~'^[0-9]+$';
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-parse-checkpoint:'||p_workspace_key||':'||p_connection_key,0
  ));
  select * into v_epoch from public.gmail_parse_processing_epochs
  where workspace_key=p_workspace_key and connection_key=p_connection_key;
  if not found then
    return jsonb_build_object(
      'status','not_ready','targetBatchId',p_target_batch_id,
      'reasonCode','FULL_MAILBOX_PROCESSING_EPOCH_REQUIRED'
    );
  end if;
  select * into strict v_genesis_batch from public.source_ingest_batches
  where workspace_key=p_workspace_key
    and batch_id=v_epoch.genesis_root_batch_id
    and status='committed' and mode in ('backfill','reconciliation')
    and committed_cursor_version=v_epoch.genesis_source_cursor_version
    and committed_cursor_value=v_epoch.genesis_source_cursor_value;
  if v_target.committed_cursor_version<v_epoch.genesis_source_cursor_version then
    return jsonb_build_object(
      'status','not_ready','targetBatchId',p_target_batch_id,
      'reasonCode','TARGET_PRECEDES_PROCESSING_EPOCH',
      'processingEpochId',v_epoch.epoch_id,
      'genesisRootBatchId',v_epoch.genesis_root_batch_id
    );
  end if;
  select * into v_checkpoint from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and root_batch_id=p_target_batch_id;
  if found then
    return jsonb_build_object(
      'status','ready','checkpointId',v_checkpoint.checkpoint_id,
      'checkpointHash',v_checkpoint.checkpoint_hash,
      'checkpoint',v_checkpoint.canonical_checkpoint
    );
  end if;
  select * into v_previous from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and connection_key=p_connection_key
  order by source_cursor_version desc,root_batch_id desc limit 1;
  if found and v_previous.source_cursor_version>=v_target.committed_cursor_version then
    raise exception 'Gmail parse-checkpoint chain skipped the requested committed batch'
      using errcode='23514';
  end if;

  for v_batch in
    select batch.* from public.source_ingest_batches batch
    where batch.workspace_key=p_workspace_key and batch.source_system='gmail'
      and batch.connection_key=p_connection_key and batch.status='committed'
      and batch.batch_hash~'^[0-9a-f]{64}$'
      and batch.committed_cursor_version is not null
      and batch.committed_cursor_value~'^[0-9]+$'
      and batch.committed_cursor_version
        >coalesce(v_previous.source_cursor_version,0)
      and batch.committed_cursor_version>=v_epoch.genesis_source_cursor_version
      and batch.committed_cursor_version<=v_target.committed_cursor_version
    order by batch.committed_cursor_version,batch.batch_id
    limit p_max_batches
  loop
    v_processed:=v_processed+1;
    select * into v_prior_batch from public.source_ingest_batches prior
    where prior.workspace_key=p_workspace_key and prior.source_system='gmail'
      and prior.connection_key=p_connection_key and prior.status='committed'
      and prior.committed_cursor_version>=v_epoch.genesis_source_cursor_version
      and prior.committed_cursor_version<v_batch.committed_cursor_version
    order by prior.committed_cursor_version desc,prior.batch_id desc limit 1;
    if found then
      if v_previous.root_batch_id is null
        or v_previous.root_batch_id<>v_prior_batch.batch_id then
        raise exception 'Gmail parse-checkpoint predecessor continuity is broken'
          using errcode='23514';
      end if;
    elsif v_previous.root_batch_id is not null
      or v_batch.batch_id<>v_epoch.genesis_root_batch_id then
      raise exception 'Gmail parse-checkpoint genesis continuity is broken'
        using errcode='23514';
    end if;

    select * into strict v_seal
    from public.gmail_batch_materialization_route_seals
    where workspace_key=p_workspace_key and root_batch_id=v_batch.batch_id
      and connection_key=p_connection_key;
    select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
      'groupId',group_row.group_id,'groupHash',group_row.group_hash,
      'messageId',group_row.message_id,
      'routeDisposition',group_row.route_disposition
    ) order by group_row.message_id,group_row.group_id),'[]'::jsonb)
    into v_route_count,v_route_manifest
    from public.gmail_message_materialization_groups group_row
    where group_row.workspace_key=p_workspace_key
      and group_row.root_batch_id=v_batch.batch_id;
    v_route_manifest_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_route_manifest),'UTF8'
    ),'sha256'),'hex');
    if v_route_count<>v_seal.route_count
      or v_route_manifest_hash<>v_seal.route_manifest_hash
      or v_seal.route_count<>v_seal.materialization_count+v_seal.deleted_count
      or v_seal.route_count<>(select count(distinct observation.source_object_id)
        from public.gmail_ingest_page_observations membership
        join public.source_observations observation
          on observation.observation_id=membership.observation_id
         and observation.workspace_key=p_workspace_key
        where membership.batch_id=v_batch.batch_id
          and observation.source_system='gmail'
          and observation.connection_key=p_connection_key
          and observation.normalized_payload->>'eventType'=any(array[
            'message_added','message_deleted','labels_added','labels_removed',
            'message_discovered'
          ])) then
      raise exception 'Gmail materialization route seal is incomplete'
        using errcode='23514';
    end if;
    v_members:='[]'::jsonb;
    for v_group_id in
      select group_row.group_id
      from public.gmail_message_materialization_groups group_row
      where group_row.workspace_key=p_workspace_key
        and group_row.root_batch_id=v_batch.batch_id
      order by group_row.message_id,group_row.group_id
    loop
      v_terminal:=private.gmail_materialization_terminal_member_v1(
        p_workspace_key,v_group_id
      );
      if v_terminal->>'status'='not_ready' then
        return jsonb_build_object(
          'status','not_ready','rootBatchId',v_batch.batch_id,
          'groupId',v_group_id,'reasonCode',v_terminal->>'reasonCode'
        );
      end if;
      if v_terminal->>'status'<>'ready' then
        raise exception 'Gmail terminal member returned an invalid status'
          using errcode='23514';
      end if;
      v_members:=v_members||jsonb_build_array(v_terminal);
    end loop;
    v_member_count:=jsonb_array_length(v_members);
    if v_member_count<>v_seal.route_count then
      raise exception 'Gmail checkpoint member count differs from route seal'
        using errcode='23514';
    end if;
    select count(*)::integer into v_terminal_gap_count
    from jsonb_array_elements(v_members) item
    where item->>'terminalDisposition' not in (
      'parsed_exact_revision','deleted_at_cut'
    );
    select min(obligation.obligation_id) into v_resolution_required_id
    from public.gmail_message_revision_obligations obligation
    where obligation.workspace_key=p_workspace_key
      and obligation.connection_key=p_connection_key
      and obligation.source_cursor_version>=v_epoch.genesis_source_cursor_version
      and obligation.source_cursor_version<v_batch.committed_cursor_version
      and obligation.reason_code<>'FETCH_POISON_QUARANTINED_REVIEW'
      and not exists (
        select 1 from public.gmail_message_revision_resolutions resolution
        where resolution.workspace_key=obligation.workspace_key
          and resolution.obligation_id=obligation.obligation_id
      )
      and (
        exists (
          select 1 from jsonb_array_elements(v_members) item
          where item->>'terminalDisposition'='parsed_exact_revision'
            and item#>>'{canonicalMember,messageId}'=obligation.message_id
        )
        or exists (
          select 1 from public.gmail_ingest_page_observations membership
          join public.source_observations observation
            on observation.observation_id=membership.observation_id
           and observation.workspace_key=p_workspace_key
          where membership.batch_id=v_batch.batch_id
            and observation.source_object_type='gmail_message_history_event'
            and observation.source_object_id=obligation.message_id
            and observation.operation='delete'
            and observation.normalized_payload->>'eventType'='message_deleted'
        )
      );
    if v_resolution_required_id is not null then
      return jsonb_build_object(
        'status','not_ready','rootBatchId',v_batch.batch_id,
        'reasonCode','AUTOMATIC_REVISION_RESOLUTION_INCOMPLETE',
        'obligationId',v_resolution_required_id
      );
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'groupId',item#>>'{canonicalMember,groupId}',
      'groupHash',item#>>'{canonicalMember,groupHash}',
      'memberId',item->>'memberId','memberHash',item->>'memberHash',
      'terminalDisposition',item->>'terminalDisposition'
    ) order by item#>>'{canonicalMember,messageId}',
      item#>>'{canonicalMember,groupId}'),'[]'::jsonb)
    into v_member_manifest from jsonb_array_elements(v_members) item;
    v_member_manifest_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_member_manifest),'UTF8'
    ),'sha256'),'hex');

    select coalesce(jsonb_agg(jsonb_build_object(
      'pageOrdinal',page.page_ordinal,
      'providerResponseHash',page.provider_response_hash,
      'eventDigest',page.event_digest,'eventCount',page.event_count,
      'jobCount',page.job_count,'isFinal',page.is_final
    ) order by page.page_ordinal),'[]'::jsonb)
    into v_pages from public.gmail_ingest_pages page
    where page.batch_id=v_batch.batch_id;
    if jsonb_array_length(v_pages)<>v_batch.page_count
      or coalesce((select sum((item->>'jobCount')::integer)
        from jsonb_array_elements(v_pages) item),0)<>v_batch.job_count then
      raise exception 'Gmail batch page manifest differs from committed counts'
        using errcode='23514';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'gapId',gap.gap_id,'gapType',gap.gap_type,
      'priorCursorValue',gap.prior_cursor_value,
      'recoveryAnchorValue',gap.recovery_anchor_value,
      'detectedAt',private.truth_worker_canonical_millis(gap.detected_at)
    ) order by gap.detected_at,gap.gap_id),'[]'::jsonb)
    into v_gap_detections from public.gmail_completeness_gaps gap
    where gap.workspace_key=p_workspace_key
      and gap.connection_key=p_connection_key
      and gap.detected_at<=v_batch.committed_at
      and gap.detected_at>=v_genesis_batch.started_at
      and (v_previous.root_batch_id is null
        or gap.detected_at>v_prior_batch.committed_at);
    select coalesce(jsonb_agg(jsonb_build_object(
      'gapId',gap.gap_id,'reconciliationBatchId',v_batch.batch_id,
      'reconciliationBatchHash',v_batch.batch_hash
    ) order by gap.gap_id),'[]'::jsonb)
    into v_gap_reconciliations from public.gmail_completeness_gaps gap
    where gap.workspace_key=p_workspace_key
      and gap.connection_key=p_connection_key
      and gap.detected_at>=v_genesis_batch.started_at
      and gap.detail->>'reconciliationBatchId'=v_batch.batch_id::text
      and gap.detail->>'reconciliationBatchHash'=v_batch.batch_hash;
    select coalesce(jsonb_agg(jsonb_build_object(
      'resolutionId',resolution.resolution_id,
      'resolutionHash',resolution.resolution_hash,
      'obligationId',resolution.obligation_id,
      'resolutionKind',resolution.resolution_kind,
      'resolutionObservationId',resolution.resolution_observation_id
    ) order by resolution.obligation_id),'[]'::jsonb)
    into v_fetch_gap_resolutions
    from public.gmail_message_revision_resolutions resolution
    join public.gmail_message_revision_obligations obligation
      on obligation.workspace_key=resolution.workspace_key
     and obligation.obligation_id=resolution.obligation_id
    where resolution.workspace_key=p_workspace_key
      and obligation.source_cursor_version>=v_epoch.genesis_source_cursor_version
      and resolution.resolving_root_batch_id=v_batch.batch_id;
    v_source_delta:=jsonb_build_object(
      'schemaVersion','gmail-source-batch-delta-v1',
      'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
      'rootBatchId',v_batch.batch_id,'rootBatchHash',v_batch.batch_hash,
      'sourceCursorVersion',v_batch.committed_cursor_version,
      'sourceCursorValue',v_batch.committed_cursor_value,
      'materializationRouteSeal',jsonb_build_object(
        'sealId',v_seal.seal_id,'sealHash',v_seal.seal_hash,
        'routeManifestHash',v_seal.route_manifest_hash,
        'routeCount',v_seal.route_count,
        'materializationCount',v_seal.materialization_count,
        'deletedCount',v_seal.deleted_count
      ),
      'pages',v_pages,'gapDetections',v_gap_detections,
      'gapReconciliations',v_gap_reconciliations,
      'messageRevisionResolutions',v_fetch_gap_resolutions
    );
    v_source_delta_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_source_delta),'UTF8'
    ),'sha256'),'hex');

    v_cumulative_member_count:=coalesce(v_previous.cumulative_member_count,0)
      +v_member_count;
    v_cumulative_terminal_gap_count:=coalesce(
      v_previous.cumulative_terminal_gap_count,0
    )+v_terminal_gap_count;
    v_cumulative_resolved_terminal_gap_count:=coalesce(
      v_previous.cumulative_resolved_terminal_gap_count,0
    )+jsonb_array_length(v_fetch_gap_resolutions);
    v_cumulative_open_terminal_gap_count:=v_cumulative_terminal_gap_count
      -v_cumulative_resolved_terminal_gap_count;
    v_cumulative_batch_count:=coalesce(v_previous.cumulative_batch_count,0)+1;
    v_cumulative_gap_count:=coalesce(v_previous.cumulative_gap_count,0)
      +jsonb_array_length(v_gap_detections);
    v_cumulative_reconciled_gap_count:=coalesce(
      v_previous.cumulative_reconciled_gap_count,0
    )+jsonb_array_length(v_gap_reconciliations);
    v_cumulative_open_gap_count:=
      v_cumulative_gap_count-v_cumulative_reconciled_gap_count;
    if v_cumulative_open_gap_count<0
      or v_cumulative_open_terminal_gap_count<0 then
      raise exception 'Gmail completeness-gap checkpoint counts are inconsistent'
        using errcode='23514';
    end if;
    v_accumulator:=jsonb_build_object(
      'schemaVersion','gmail-parse-checkpoint-accumulator-v1',
      'processingEpochId',v_epoch.epoch_id,
      'processingEpochHash',v_epoch.epoch_hash,
      'predecessorAccumulatorHash',coalesce(v_previous.accumulator_hash,''),
      'rootBatchId',v_batch.batch_id,'rootBatchHash',v_batch.batch_hash,
      'sourceDeltaHash',v_source_delta_hash,
      'memberManifestHash',v_member_manifest_hash,
      'memberCount',v_member_count,'terminalGapCount',v_terminal_gap_count,
      'cumulativeMemberCount',v_cumulative_member_count,
      'cumulativeTerminalGapCount',v_cumulative_terminal_gap_count,
      'cumulativeResolvedTerminalGapCount',
        v_cumulative_resolved_terminal_gap_count,
      'cumulativeOpenTerminalGapCount',v_cumulative_open_terminal_gap_count,
      'cumulativeBatchCount',v_cumulative_batch_count,
      'cumulativeGapCount',v_cumulative_gap_count,
      'cumulativeReconciledGapCount',v_cumulative_reconciled_gap_count,
      'cumulativeOpenGapCount',v_cumulative_open_gap_count
    );
    v_accumulator_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_accumulator),'UTF8'
    ),'sha256'),'hex');
    v_source_cut:=jsonb_build_object(
      'schemaVersion','gmail-committed-source-cut-v2',
      'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
      'processingEpochId',v_epoch.epoch_id,
      'processingEpochHash',v_epoch.epoch_hash,
      'legacyBatchCount',v_epoch.legacy_batch_count,
      'legacyBatchManifestHash',v_epoch.legacy_batch_manifest_hash,
      'rootBatchId',v_batch.batch_id,'rootBatchHash',v_batch.batch_hash,
      'sourceCursorVersion',v_batch.committed_cursor_version,
      'sourceCursorValue',v_batch.committed_cursor_value,
      'parseAccumulatorHash',v_accumulator_hash,
      'cumulativeBatchCount',v_cumulative_batch_count,
      'cumulativePrerequisiteCount',v_cumulative_member_count,
      'cumulativeTerminalGapCount',v_cumulative_terminal_gap_count,
      'cumulativeResolvedTerminalGapCount',
        v_cumulative_resolved_terminal_gap_count,
      'cumulativeOpenTerminalGapCount',v_cumulative_open_terminal_gap_count,
      'completenessGapCount',v_cumulative_gap_count,
      'openCompletenessGapCount',v_cumulative_open_gap_count,
      'completenessStatus',case
        when v_cumulative_open_gap_count>0
          or v_cumulative_open_terminal_gap_count>0 then 'degraded_scoped_gaps'
        when v_cumulative_reconciled_gap_count>0
          then 'reconciled_current_mailbox_with_history_gap'
        else 'continuous_history_complete' end
    );
    v_predecessor:=case when v_previous.checkpoint_id is null then null else
      jsonb_build_object(
        'checkpointId',v_previous.checkpoint_id,
        'checkpointHash',v_previous.checkpoint_hash,
        'accumulatorHash',v_previous.accumulator_hash,
        'rootBatchId',v_previous.root_batch_id,
        'sourceCursorVersion',v_previous.source_cursor_version,
        'sourceCursorValue',v_previous.source_cursor_value
      ) end;
    v_canonical:=jsonb_build_object(
      'schemaVersion','gmail-parse-checkpoint-v1',
      'policyVersion','gmail-parse-delta-checkpoint-policy-v1',
      'processingEpoch',jsonb_build_object(
        'epochId',v_epoch.epoch_id,'epochHash',v_epoch.epoch_hash,
        'genesisRootBatchId',v_epoch.genesis_root_batch_id,
        'genesisSourceCursorVersion',v_epoch.genesis_source_cursor_version,
        'genesisSourceCursorValue',v_epoch.genesis_source_cursor_value,
        'legacyBatchCount',v_epoch.legacy_batch_count,
        'legacyBatchManifestHash',v_epoch.legacy_batch_manifest_hash
      ),
      'predecessor',v_predecessor,'sourceDelta',v_source_delta,
      'sourceDeltaHash',v_source_delta_hash,
      'memberManifestHash',v_member_manifest_hash,
      'memberCount',v_member_count,'terminalGapCount',v_terminal_gap_count,
      'cumulativeMemberCount',v_cumulative_member_count,
      'cumulativeTerminalGapCount',v_cumulative_terminal_gap_count,
      'cumulativeResolvedTerminalGapCount',
        v_cumulative_resolved_terminal_gap_count,
      'cumulativeOpenTerminalGapCount',v_cumulative_open_terminal_gap_count,
      'cumulativeBatchCount',v_cumulative_batch_count,
      'cumulativeGapCount',v_cumulative_gap_count,
      'cumulativeReconciledGapCount',v_cumulative_reconciled_gap_count,
      'cumulativeOpenGapCount',v_cumulative_open_gap_count,
      'accumulatorHash',v_accumulator_hash,'sourceCut',v_source_cut
    );
    v_checkpoint_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_canonical),'UTF8'
    ),'sha256'),'hex');
    v_checkpoint_id:='gmail-parse-checkpoint:v1:'||v_checkpoint_hash;

    insert into public.gmail_parse_checkpoint_members(
      workspace_key,root_batch_id,group_id,group_hash,
      materialization_job_id,message_id,
      trigger_history_id,provider_history_id,terminal_disposition,
      materialization_receipt_id,materialization_receipt_hash,
      raw_observation_id,parse_job_id,parsed_observation_id,
      terminal_authority_id,terminal_authority_hash,member_id,
      canonical_member,member_hash,schema_version
    ) select
      p_workspace_key,v_batch.batch_id,
      item#>>'{canonicalMember,groupId}',
      item#>>'{canonicalMember,groupHash}',
      nullif(item#>>'{canonicalMember,materializationJobId}','')::uuid,
      item#>>'{canonicalMember,messageId}',
      item#>>'{canonicalMember,selectedTrigger,historyId}',
      item#>>'{canonicalMember,providerHistoryId}',
      item->>'terminalDisposition',
      item#>>'{canonicalMember,materializationReceiptId}',
      item#>>'{canonicalMember,materializationReceiptHash}',
      nullif(item#>>'{canonicalMember,rawObservationId}',''),
      nullif(item#>>'{canonicalMember,parseJobId}','')::uuid,
      nullif(item#>>'{canonicalMember,parsedObservationId}',''),
      item#>>'{canonicalMember,terminalAuthorityId}',
      item#>>'{canonicalMember,terminalAuthorityHash}',
      item->>'memberId',item->'canonicalMember',item->>'memberHash',
      'gmail-parse-checkpoint-member-v1'
    from jsonb_array_elements(v_members) item;
    insert into public.gmail_parse_checkpoints(
      workspace_key,root_batch_id,checkpoint_id,connection_key,
      processing_epoch_id,processing_epoch_hash,
      source_cursor_version,source_cursor_value,predecessor_checkpoint_id,
      predecessor_checkpoint_hash,predecessor_accumulator_hash,
      source_delta_hash,member_manifest_hash,member_count,terminal_gap_count,
      cumulative_member_count,cumulative_terminal_gap_count,
      cumulative_resolved_terminal_gap_count,cumulative_open_terminal_gap_count,
      cumulative_batch_count,cumulative_gap_count,
      cumulative_reconciled_gap_count,cumulative_open_gap_count,
      accumulator_hash,canonical_checkpoint,checkpoint_hash,schema_version
    ) values (
      p_workspace_key,v_batch.batch_id,v_checkpoint_id,p_connection_key,
      v_epoch.epoch_id,v_epoch.epoch_hash,
      v_batch.committed_cursor_version,v_batch.committed_cursor_value,
      v_previous.checkpoint_id,v_previous.checkpoint_hash,
      v_previous.accumulator_hash,v_source_delta_hash,v_member_manifest_hash,
      v_member_count,v_terminal_gap_count,v_cumulative_member_count,
      v_cumulative_terminal_gap_count,v_cumulative_resolved_terminal_gap_count,
      v_cumulative_open_terminal_gap_count,v_cumulative_batch_count,
      v_cumulative_gap_count,v_cumulative_reconciled_gap_count,
      v_cumulative_open_gap_count,v_accumulator_hash,v_canonical,
      v_checkpoint_hash,'gmail-parse-checkpoint-v1'
    );
    select * into strict v_previous from public.gmail_parse_checkpoints
    where workspace_key=p_workspace_key and root_batch_id=v_batch.batch_id;
  end loop;
  select * into v_checkpoint from public.gmail_parse_checkpoints
  where workspace_key=p_workspace_key and root_batch_id=p_target_batch_id;
  if not found then
    return jsonb_build_object(
      'status','more_work','processedBatchCount',v_processed,
      'targetBatchId',p_target_batch_id,
      'headCheckpointId',coalesce(v_previous.checkpoint_id,''),
      'headSourceCursorVersion',coalesce(v_previous.source_cursor_version,0)
    );
  end if;
  return jsonb_build_object(
    'status','ready','checkpointId',v_checkpoint.checkpoint_id,
    'checkpointHash',v_checkpoint.checkpoint_hash,
    'checkpoint',v_checkpoint.canonical_checkpoint
  );
end;
$function$;

create or replace function private.ensure_gmail_parse_checkpoint(
  p_workspace_key text,p_connection_key text,p_target_batch_id uuid,
  p_max_batches integer,p_sync_token text
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_auto jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  v_auto:=private.auto_resolve_gmail_revision_obligations_v1(
    p_workspace_key,p_connection_key,p_target_batch_id,p_sync_token
  );
  if v_auto->>'status'='not_ready' then
    return v_auto;
  end if;
  return private.ensure_gmail_parse_checkpoint_chain_v1(
    p_workspace_key,p_connection_key,p_target_batch_id
    ,p_max_batches
  );
end;
$function$;

create or replace function public.ensure_gmail_parse_checkpoint(
  p_workspace_key text,p_connection_key text,p_target_batch_id uuid,
  p_max_batches integer,p_sync_token text
)
returns jsonb language sql security definer set search_path=''
as $function$
  select private.ensure_gmail_parse_checkpoint(
    p_workspace_key,p_connection_key,p_target_batch_id,p_max_batches,p_sync_token
  );
$function$;

revoke all on function private.ensure_gmail_parse_checkpoint_chain_v1(
  text,text,uuid,integer
) from public,anon,authenticated,service_role;
revoke all on function private.ensure_gmail_parse_checkpoint(
  text,text,uuid,integer,text
) from public,anon,authenticated,service_role;
revoke all on function public.ensure_gmail_parse_checkpoint(
  text,text,uuid,integer,text
) from public,anon,authenticated,service_role;
grant execute on function public.ensure_gmail_parse_checkpoint(
  text,text,uuid,integer,text
) to service_role;

create or replace function private.route_gmail_link_claim_wait_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.source_system='gmail'
    and new.job_kind='gmail_fetch_raw_message'
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime';
    new.lease_owner:=null;
    new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_MESSAGE_REVISION_SCHEMA_REQUIRED';
    new.safe_error_detail:=
      'Legacy raw-fetch jobs are quarantined; revision materialization v1 is required.';
  elsif new.source_system='gmail'
    and new.job_kind=any(array[
      'gmail_resolve_entity_links','gmail_extract_message_claims',
      'gmail_extract_attachment_claims','gmail_extract_message_model_claims',
      'gmail_review_model_extraction'
    ])
    and new.state in ('queued','retry_wait') then
    new.state:='waiting_runtime';
    new.lease_owner:=null;
    new.lease_expires_at:=null;
    new.last_error_code:='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED';
    new.safe_error_detail:=
      'Parsed evidence is durable; canonical link epoch schema is required before claims run.';
  end if;
  return new;
end;
$function$;

revoke all on function private.route_gmail_link_claim_wait_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists source_processing_job_gmail_link_claim_wait
  on public.source_processing_jobs;
create trigger source_processing_job_gmail_link_claim_wait
  before insert or update of state on public.source_processing_jobs
  for each row execute function private.route_gmail_link_claim_wait_v1();

update public.source_processing_jobs
set state='waiting_runtime',lease_owner=null,lease_expires_at=null,
    last_error_code='GMAIL_LINK_EPOCH_SCHEMA_REQUIRED',
    safe_error_detail=
      'Parsed evidence is durable; canonical link epoch schema is required before claims run.',
    updated_at=clock_timestamp()
where source_system='gmail'
  and job_kind=any(array[
    'gmail_resolve_entity_links','gmail_extract_message_claims',
    'gmail_extract_attachment_claims','gmail_extract_message_model_claims',
    'gmail_review_model_extraction'
  ])
  and state in ('queued','leased','retry_wait');

update public.source_processing_jobs
set state='waiting_runtime',lease_owner=null,lease_expires_at=null,
    lease_fence=lease_fence+case when state='leased' then 1 else 0 end,
    last_error_code='GMAIL_MESSAGE_REVISION_SCHEMA_REQUIRED',
    safe_error_detail=
      'Legacy raw-fetch jobs are quarantined; revision materialization v1 is required.',
    updated_at=clock_timestamp()
where source_system='gmail' and job_kind='gmail_fetch_raw_message'
  and state in ('queued','leased','retry_wait');

create or replace function private.claim_source_processing_jobs(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_worker_id text,
  p_processor_version text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_kinds text[],
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_jobs jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_source_system, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or p_limit is null or p_limit < 1 or p_limit > 50
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900
    or exists (
      select 1 from unnest(coalesce(p_job_kinds, array[]::text[])) job_kind
      where nullif(trim(job_kind), '') is null
    ) then
    raise exception 'invalid source-processing claim request' using errcode = '22023';
  end if;

  update public.source_processing_jobs job
  set state = case when job.attempt_count >= job.max_attempts
        then 'dead_letter' else 'retry_wait' end,
      available_at = case when job.attempt_count >= job.max_attempts
        then job.available_at else v_now end,
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = 'LEASE_EXPIRED',
      safe_error_detail = 'The prior processing lease expired before acknowledgement.',
      updated_at = v_now,
      completed_at = case when job.attempt_count >= job.max_attempts then v_now else null end
  where job.workspace_key = p_workspace_key
    and job.source_system = p_source_system
    and job.connection_key = p_connection_key
    and job.state = 'leased'
    and (job.lease_expires_at is null or job.lease_expires_at <= v_now);

  insert into public.source_processing_job_lineage (
    job_id, workspace_key, source_system, connection_key, root_batch_id,
    parent_job_id, root_job_id, source_cursor_version, source_cursor_value
  )
  select distinct
    job.job_id, job.workspace_key, job.source_system, job.connection_key,
    batch.batch_id, null::uuid, job.job_id,
    batch.committed_cursor_version, batch.committed_cursor_value
  from public.source_processing_jobs job
  join public.source_ingest_batches batch
    on batch.batch_id::text = job.payload->>'batchId'
   and batch.workspace_key = job.workspace_key
   and batch.source_system = job.source_system
   and batch.connection_key = job.connection_key
   and batch.status = 'committed'
   and batch.committed_cursor_version is not null
   and nullif(batch.committed_cursor_value, '') is not null
  left join public.gmail_ingest_page_jobs page_job
    on page_job.job_id = job.job_id and page_job.batch_id = batch.batch_id
  left join public.source_observations anchor
    on anchor.observation_id = job.observation_id
   and anchor.workspace_key = job.workspace_key
   and anchor.source_system = job.source_system
   and anchor.connection_key = job.connection_key
   and anchor.batch_id = batch.batch_id
  where job.workspace_key = p_workspace_key
    and job.source_system = p_source_system
    and job.connection_key = p_connection_key
    and not exists (
      select 1 from public.source_processing_job_lineage lineage
      where lineage.job_id = job.job_id
    )
    and ((job.source_system = 'gmail' and page_job.job_id is not null)
      or (job.source_system <> 'gmail' and anchor.observation_id is not null))
    and (job.source_system <> 'gmail' or batch.committed_cursor_value ~ '^[0-9]+$')
  on conflict (job_id) do nothing;

  with candidates as (
    select job.job_id
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
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and job.state in ('queued', 'retry_wait')
      and job.available_at <= v_now
      and job.attempt_count < job.max_attempts
      and (coalesce(cardinality(p_job_kinds), 0) = 0
        or job.job_kind = any(p_job_kinds))
      and (job.source_system <> 'gmail' or lineage.source_cursor_value ~ '^[0-9]+$')
      and not (job.source_system='gmail' and job.job_kind=any(array[
        'gmail_fetch_raw_message',
        'gmail_resolve_entity_links','gmail_extract_message_claims',
        'gmail_extract_attachment_claims','gmail_extract_message_model_claims',
        'gmail_review_model_extraction'
      ]))
      and (job.job_kind<>'gmail_materialize_message_revision' or (
        exists (
          select 1 from public.gmail_message_materialization_groups current_group
          where current_group.workspace_key=job.workspace_key
            and current_group.materialization_job_id=job.job_id
        )
        and not exists (
          select 1
          from public.gmail_message_materialization_groups current_group
          join public.gmail_message_materialization_groups prior_group
            on prior_group.workspace_key=current_group.workspace_key
           and prior_group.connection_key=current_group.connection_key
           and prior_group.message_id=current_group.message_id
           and prior_group.route_disposition='materialize_revision'
           and (prior_group.source_cursor_version
                  <current_group.source_cursor_version
             or (prior_group.source_cursor_version
                  =current_group.source_cursor_version
               and prior_group.group_id<current_group.group_id))
          join public.source_processing_jobs prior_job
            on prior_job.workspace_key=prior_group.workspace_key
           and prior_job.job_id=prior_group.materialization_job_id
          where current_group.workspace_key=job.workspace_key
            and current_group.materialization_job_id=job.job_id
            and prior_job.state not in ('succeeded','dead_letter','superseded')
        )
      ))
    order by case when job.job_kind='gmail_materialize_message_revision'
        then lineage.source_cursor_version else 0 end,
      case when job.job_kind='gmail_materialize_message_revision' then (
        select current_group.group_id
        from public.gmail_message_materialization_groups current_group
        where current_group.workspace_key=job.workspace_key
          and current_group.materialization_job_id=job.job_id
      ) else '' end,
      job.available_at,job.created_at,job.job_id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.source_processing_jobs job
    set state = 'leased',
        attempt_count = job.attempt_count + 1,
        lease_owner = p_worker_id,
        lease_fence = job.lease_fence + 1,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_error_code = '',
        safe_error_detail = '',
        processor_version = p_processor_version,
        updated_at = v_now,
        completed_at = null
    from candidates
    where job.job_id = candidates.job_id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', claimed.job_id,
    'dedupeKey', claimed.dedupe_key,
    'jobKind', claimed.job_kind,
    'observationId', claimed.observation_id,
    'sourceObjectId', claimed.source_object_id,
    'attemptCount', claimed.attempt_count,
    'maxAttempts', claimed.max_attempts,
    'leaseFence', claimed.lease_fence,
    'leaseExpiresAt', claimed.lease_expires_at,
    'processorVersion', claimed.processor_version,
    'payload', claimed.payload,
    'rootBatchId', lineage.root_batch_id,
    'rootJobId', lineage.root_job_id,
    'parentJobId', lineage.parent_job_id,
    'sourceCursorVersion', lineage.source_cursor_version,
    'sourceCursorValue', lineage.source_cursor_value
  )||case when claimed.job_kind='gmail_materialize_message_revision'
    then jsonb_build_object(
      'materializationAuthority',private.load_gmail_materialization_authority_v1(
        claimed.workspace_key,claimed.job_id
      )
    ) else '{}'::jsonb end
  order by claimed.available_at, claimed.created_at, claimed.job_id), '[]'::jsonb)
  into v_jobs
  from claimed
  join public.source_processing_job_lineage lineage
    on lineage.job_id = claimed.job_id;

  return jsonb_build_object(
    'ok', true,
    'workerId', p_worker_id,
    'processorVersion', p_processor_version,
    'leaseSeconds', p_lease_seconds,
    'claimedCount', jsonb_array_length(v_jobs),
    'jobs', v_jobs
  );
end;
$function$;

revoke all on function private.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) from public, anon, authenticated, service_role;

create or replace function public.claim_source_processing_jobs(
  p_workspace_key text,p_source_system text,p_connection_key text,
  p_worker_id text,p_processor_version text,p_limit integer,
  p_lease_seconds integer,p_job_kinds text[],p_sync_token text
)
returns jsonb language sql security definer set search_path=''
as $function$
  select private.claim_source_processing_jobs(
    p_workspace_key,p_source_system,p_connection_key,p_worker_id,
    p_processor_version,p_limit,p_lease_seconds,p_job_kinds,p_sync_token
  );
$function$;
revoke all on function public.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) from public,anon,authenticated,service_role;
grant execute on function public.claim_source_processing_jobs(
  text, text, text, text, text, integer, integer, text[], text
) to service_role;

-- Result-v2 claim workers are extraction-only.  Every completed manifest,
-- including an empty one, joins a durable candidate-frontier obligation.
-- The waiting-runtime child keeps omission visible without burning attempts;
-- a later source-cut-wide coordinator will consume these exact manifests.
create unique index if not exists candidate_claim_job_manifests_workspace_job_uq
  on public.candidate_claim_job_manifests(workspace_key,job_id);

create table if not exists public.truth_pending_acceptance_epochs (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null,
  connection_key text not null,
  root_batch_id uuid not null,
  source_cursor_version bigint not null check (source_cursor_version>0),
  source_cursor_value text not null,
  pending_job_id uuid not null unique,
  obligation_id text not null unique check (
    obligation_id~'^pending-acceptance-epoch:v1:[0-9a-f]{64}$'
  ),
  canonical_obligation jsonb not null check (
    jsonb_typeof(canonical_obligation)='object'
  ),
  obligation_hash text not null unique check (obligation_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version='pending-acceptance-epoch-obligation-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_key,source_system,connection_key,root_batch_id),
  foreign key (workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key,pending_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check (obligation_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_obligation),'UTF8'
  ),'sha256'),'hex')),
  check (obligation_id='pending-acceptance-epoch:v1:'||obligation_hash)
);

create table if not exists public.truth_pending_acceptance_epoch_manifests (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  obligation_id text not null,
  source_job_id uuid not null unique,
  source_observation_id text not null,
  source_observation_content_hash text not null check (
    source_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  candidate_count integer not null check (candidate_count>=0),
  candidate_manifest_hash text not null check (
    candidate_manifest_hash~'^[0-9a-f]{64}$'
  ),
  worker_result_hash text not null check (worker_result_hash~'^[0-9a-f]{64}$'),
  canonical_membership jsonb not null check (
    jsonb_typeof(canonical_membership)='object'
  ),
  membership_hash text not null unique check (membership_hash~'^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version='pending-acceptance-epoch-manifest-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_key,obligation_id,source_job_id),
  foreign key (workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key,source_job_id)
    references public.candidate_claim_job_manifests(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check (membership_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_membership),'UTF8'
  ),'sha256'),'hex'))
);

create unique index if not exists truth_pending_acceptance_epochs_workspace_obligation_uq
  on public.truth_pending_acceptance_epochs(workspace_key,obligation_id);
alter table public.truth_pending_acceptance_epoch_manifests
  drop constraint if exists truth_pending_acceptance_manifest_obligation_fk;
alter table public.truth_pending_acceptance_epoch_manifests
  add constraint truth_pending_acceptance_manifest_obligation_fk
  foreign key (workspace_key,obligation_id)
  references public.truth_pending_acceptance_epochs(workspace_key,obligation_id)
  on update restrict on delete restrict;

do $block$
declare v_table text;
begin
  foreach v_table in array array[
    'truth_pending_acceptance_epochs',
    'truth_pending_acceptance_epoch_manifests'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I',v_table,v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I '
      ||'for each row execute function public.reject_immutable_truth_mutation()',
      v_table,v_table
    );
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format(
      'revoke all on public.%I from public,anon,authenticated,service_role',
      v_table
    );
    execute format('grant select on public.%I to service_role',v_table);
  end loop;
end;
$block$;

create or replace function private.create_pending_acceptance_epoch_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_lineage public.source_processing_job_lineage%rowtype;
  v_manifest public.candidate_claim_job_manifests%rowtype;
  v_observation public.source_observations%rowtype;
  v_obligation jsonb;
  v_obligation_hash text;
  v_obligation_id text;
  v_dedupe_key text;
  v_pending_job_id uuid;
  v_membership jsonb;
  v_membership_hash text;
  v_existing public.truth_pending_acceptance_epochs%rowtype;
begin
  if new.state<>'succeeded'
    or new.result->>'schemaVersion'<>'truth-claim-worker-result-v2' then
    return new;
  end if;
  if not private.truth_jsonb_has_only_keys(new.result,array[
      'schemaVersion','processorVersion','acceptancePolicyVersion','jobKind',
      'sourceObservationId','candidateCount','acceptedCount','rejectedCount',
      'reviewCount','pendingCount','acceptanceDisposition',
      'canonicalMutationCount','candidates'
    ])
    or (select count(*) from jsonb_object_keys(new.result))<>13
    or new.job_kind<>all(array[
      'gmail_extract_message_claims','gmail_extract_attachment_claims',
      'tms_extract_claims','tracking_extract_claims','operator_extract_claims'
    ])
    or new.result->>'jobKind'<>new.job_kind
    or new.result->>'sourceObservationId'<>new.observation_id
    or new.result->>'acceptanceDisposition'<>'pending_acceptance_coordinator'
    or coalesce(new.result->>'candidateCount','')!~'^[0-9]+$'
    or coalesce(new.result->>'pendingCount','')!~'^[0-9]+$'
    or (new.result->>'candidateCount')::integer
      <> (new.result->>'pendingCount')::integer
    or new.result->>'acceptedCount'<>'0'
    or new.result->>'rejectedCount'<>'0'
    or new.result->>'reviewCount'<>'0'
    or new.result->>'canonicalMutationCount'<>'0'
    or jsonb_typeof(new.result->'candidates')<>'array'
    or jsonb_array_length(new.result->'candidates')
      <> (new.result->>'candidateCount')::integer
    or exists (
      select 1 from jsonb_array_elements(new.result->'candidates') candidate
      where jsonb_typeof(candidate)<>'object'
        or candidate->>'disposition'<>'pending_acceptance_coordinator'
        or candidate ?| array[
          'decision','decisionVersionId','acceptedClaimVersionId','bindingId'
        ]
    ) then
    raise exception 'claim result-v2 is not extraction-only coordinator input'
      using errcode='23514';
  end if;
  select * into strict v_lineage
  from public.source_processing_job_lineage
  where job_id=new.job_id and workspace_key=new.workspace_key;
  select * into strict v_manifest
  from public.candidate_claim_job_manifests
  where job_id=new.job_id and workspace_key=new.workspace_key;
  select * into strict v_observation
  from public.source_observations
  where observation_id=new.observation_id and workspace_key=new.workspace_key;
  if v_manifest.source_observation_id<>new.observation_id
    or v_manifest.candidate_count<>(new.result->>'candidateCount')::integer then
    raise exception 'claim result-v2 differs from its sealed candidate manifest'
      using errcode='23514';
  end if;
  v_obligation:=jsonb_build_object(
    'schemaVersion','pending-acceptance-epoch-obligation-v1',
    'workspaceKey',new.workspace_key,'sourceSystem',new.source_system,
    'connectionKey',new.connection_key,'rootBatchId',v_lineage.root_batch_id,
    'sourceCursorVersion',v_lineage.source_cursor_version,
    'sourceCursorValue',v_lineage.source_cursor_value,
    'blockerCode','ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
  );
  v_obligation_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_obligation),'UTF8'
  ),'sha256'),'hex');
  v_obligation_id:='pending-acceptance-epoch:v1:'||v_obligation_hash;
  v_dedupe_key:='truth:pending-acceptance-epoch:v1:'||v_obligation_hash;
  insert into public.source_processing_jobs(
    dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,max_attempts,last_error_code,
    safe_error_detail,payload
  ) values (
    v_dedupe_key,new.workspace_key,new.source_system,new.connection_key,
    'truth_sequence_claim_acceptance_epoch',null,v_lineage.root_batch_id::text,
    'waiting_runtime',1,'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED',
    'Candidate frontier is sealed; canonical acceptance epoch runtime is required.',
    v_obligation||jsonb_build_object('obligationId',v_obligation_id)
  ) on conflict(dedupe_key) do nothing;
  select job_id into strict v_pending_job_id
  from public.source_processing_jobs where dedupe_key=v_dedupe_key;
  insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) values (
    v_pending_job_id,new.workspace_key,new.source_system,new.connection_key,
    v_lineage.root_batch_id,null,v_pending_job_id,
    v_lineage.source_cursor_version,v_lineage.source_cursor_value
  ) on conflict(job_id) do nothing;
  insert into public.truth_pending_acceptance_epochs(
    workspace_key,source_system,connection_key,root_batch_id,
    source_cursor_version,source_cursor_value,pending_job_id,obligation_id,
    canonical_obligation,obligation_hash,schema_version
  ) values (
    new.workspace_key,new.source_system,new.connection_key,v_lineage.root_batch_id,
    v_lineage.source_cursor_version,v_lineage.source_cursor_value,v_pending_job_id,
    v_obligation_id,v_obligation,v_obligation_hash,
    'pending-acceptance-epoch-obligation-v1'
  ) on conflict(workspace_key,source_system,connection_key,root_batch_id)
    do nothing;
  select * into strict v_existing
  from public.truth_pending_acceptance_epochs
  where workspace_key=new.workspace_key
    and source_system=new.source_system
    and connection_key=new.connection_key
    and root_batch_id=v_lineage.root_batch_id;
  if v_existing.canonical_obligation is distinct from v_obligation
    or v_existing.pending_job_id is distinct from v_pending_job_id then
    raise exception 'pending acceptance epoch conflicts on replay'
      using errcode='23505';
  end if;
  v_membership:=jsonb_build_object(
    'schemaVersion','pending-acceptance-epoch-manifest-v1',
    'workspaceKey',new.workspace_key,'obligationId',v_obligation_id,
    'sourceJobId',new.job_id,'sourceObservationId',new.observation_id,
    'sourceObservationContentHash',v_observation.content_hash,
    'candidateCount',v_manifest.candidate_count,
    'candidateManifestHash',v_manifest.manifest_hash,
    'workerResultHash',encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(new.result),'UTF8'
    ),'sha256'),'hex')
  );
  v_membership_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_membership),'UTF8'
  ),'sha256'),'hex');
  insert into public.truth_pending_acceptance_epoch_manifests(
    workspace_key,obligation_id,source_job_id,source_observation_id,
    source_observation_content_hash,candidate_count,candidate_manifest_hash,
    worker_result_hash,canonical_membership,membership_hash,schema_version
  ) values (
    new.workspace_key,v_obligation_id,new.job_id,new.observation_id,
    v_observation.content_hash,v_manifest.candidate_count,v_manifest.manifest_hash,
    v_membership->>'workerResultHash',v_membership,v_membership_hash,
    'pending-acceptance-epoch-manifest-v1'
  ) on conflict(source_job_id) do nothing;
  return new;
end;
$function$;

drop trigger if exists source_processing_job_pending_acceptance_epoch
  on public.source_processing_jobs;
create trigger source_processing_job_pending_acceptance_epoch
  after update of state,result on public.source_processing_jobs
  for each row when (
    new.state='succeeded'
    and new.result->>'schemaVersion'='truth-claim-worker-result-v2'
  ) execute function private.create_pending_acceptance_epoch_v1();
revoke all on function private.create_pending_acceptance_epoch_v1()
  from public,anon,authenticated,service_role;

create or replace function private.reject_truth_cut_or_build_with_pending_epoch_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if tg_table_name='source_cut_cursors' and exists (
    select 1
    from public.source_cuts cut
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key=cut.workspace_key
     and pending.source_system=to_jsonb(new)->>'source_system'
     and pending.connection_key=to_jsonb(new)->>'connection_key'
     and pending.source_cursor_version<=
       (to_jsonb(new)->>'through_cursor_version')::bigint
    where cut.source_cut_id=new.source_cut_id
  ) then
    raise exception 'source cut is waiting for a canonical acceptance epoch'
      using errcode='55000';
  elsif tg_table_name='truth_builds' and exists (
    select 1
    from public.source_cuts cut
    join public.source_cut_cursors cursor_row
      on cursor_row.source_cut_id=cut.source_cut_id
    join public.truth_pending_acceptance_epochs pending
      on pending.workspace_key=cut.workspace_key
     and pending.source_system=cursor_row.source_system
     and pending.connection_key=cursor_row.connection_key
     and pending.source_cursor_version<=cursor_row.through_cursor_version
    where cut.source_cut_id=new.source_cut_id
  ) then
    raise exception 'truth build is waiting for a canonical acceptance epoch'
      using errcode='55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists source_cut_cursor_pending_acceptance_epoch
  on public.source_cut_cursors;
create trigger source_cut_cursor_pending_acceptance_epoch
  before insert or update on public.source_cut_cursors
  for each row execute function private.reject_truth_cut_or_build_with_pending_epoch_v1();
drop trigger if exists truth_build_pending_acceptance_epoch on public.truth_builds;
create trigger truth_build_pending_acceptance_epoch
  before insert or update on public.truth_builds
  for each row execute function private.reject_truth_cut_or_build_with_pending_epoch_v1();
revoke all on function private.reject_truth_cut_or_build_with_pending_epoch_v1()
  from public,anon,authenticated,service_role;
