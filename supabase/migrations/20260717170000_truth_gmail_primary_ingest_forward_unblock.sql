-- Forward-only Gmail primary ingestion unblock.
--
-- The original inbox-wide backfill durably persisted 2,190 immutable provider
-- pages and 218,989 content-addressed observations, but its atomic committed-
-- root routing step cannot fit the five-second hosted cron budget.  This
-- authority does not discard, rewrite, or pretend to commit that history.  It
-- parks the exact batch, records an open historical-drain obligation, and
-- advances the source cursor to a fresh Gmail profile history checkpoint.  It
-- records the unmaterialized interval from the persisted backfill anchor to
-- that checkpoint as a separate open reconciliation gap.  A fresh provider
-- profile/checkpoint probe is required before the transition.  The next
-- ordinary hosted history tick starts at that checkpoint and supplies the
-- first real committed/current cursor witness.
--
-- This migration installs the authority.  It deliberately does not execute
-- it without a provider probe and the plaintext sync credential.

create table if not exists public.truth_gmail_backfill_parking_receipts (
  receipt_id text primary key check (
    receipt_id ~ '^truth-gmail-backfill-parking:v1:[0-9a-f]{64}$'
  ),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null,
  provider_account_email text not null check (provider_account_email <> ''),
  provider_account_binding_hash text not null check (
    provider_account_binding_hash ~ '^[0-9a-f]{64}$'
  ),
  parked_batch_id uuid not null unique,
  backfill_gap_id uuid not null unique,
  cutover_delta_gap_id uuid not null unique,
  coordinator_job_id uuid not null unique,
  persisted_anchor_history_id text not null check (
    persisted_anchor_history_id ~ '^[0-9]+$'
  ),
  cutover_history_id text not null check (cutover_history_id ~ '^[0-9]+$'),
  prior_cursor_version bigint not null check (prior_cursor_version >= 0),
  resumed_cursor_version bigint not null check (
    resumed_cursor_version = prior_cursor_version + 1
  ),
  page_count integer not null check (page_count > 0),
  observation_count integer not null check (observation_count > 0),
  job_count integer not null check (job_count = 0),
  page_manifest_hash text not null check (page_manifest_hash ~ '^[0-9a-f]{64}$'),
  provider_probe_hash text not null check (provider_probe_hash ~ '^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  schema_version text not null check (
    schema_version = 'truth-gmail-backfill-parking-receipt-v1'
  ),
  parked_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_key, source_system, connection_key)
    references public.source_cursors(workspace_key, source_system, connection_key)
    on delete restrict,
  foreign key (
    parked_batch_id, workspace_key, source_system, connection_key
  ) references public.source_ingest_batches(
    batch_id, workspace_key, source_system, connection_key
  ) on update restrict on delete restrict,
  foreign key (
    backfill_gap_id, workspace_key, connection_key
  ) references public.gmail_completeness_gaps(
    gap_id, workspace_key, connection_key
  ) on update restrict on delete restrict,
  foreign key (
    cutover_delta_gap_id, workspace_key, connection_key
  ) references public.gmail_completeness_gaps(
    gap_id, workspace_key, connection_key
  ) on update restrict on delete restrict,
  foreign key (
    coordinator_job_id, workspace_key, source_system, connection_key
  ) references public.source_processing_jobs(
    job_id, workspace_key, source_system, connection_key
  ) on update restrict on delete restrict
);

drop trigger if exists truth_gmail_backfill_parking_receipts_immutable
  on public.truth_gmail_backfill_parking_receipts;
create trigger truth_gmail_backfill_parking_receipts_immutable
before update or delete on public.truth_gmail_backfill_parking_receipts
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_gmail_backfill_parking_receipts enable row level security;
alter table public.truth_gmail_backfill_parking_receipts force row level security;
revoke all on table public.truth_gmail_backfill_parking_receipts
  from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.truth_gmail_backfill_parking_receipts from service_role;
grant select on table public.truth_gmail_backfill_parking_receipts to service_role;

create index if not exists truth_gmail_backfill_parking_receipts_scope_idx
  on public.truth_gmail_backfill_parking_receipts(
    workspace_key, connection_key, parked_at desc, parked_batch_id
  );

create or replace function private.read_truth_gmail_backfill_forward_unblock_v1(
  p_batch_id uuid,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_anchor text;
  v_page_count integer;
  v_final_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_batch_id is distinct from
    '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid then
    raise exception 'Gmail forward-unblock batch is outside the exact authority'
      using errcode = '22023';
  end if;

  select * into v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.parked_batch_id = p_batch_id;
  if found then
    select * into strict v_cursor
    from public.source_cursors cursor_row
    where cursor_row.workspace_key = v_receipt.workspace_key
      and cursor_row.source_system = 'gmail'
      and cursor_row.connection_key = v_receipt.connection_key;
    return jsonb_build_object(
      'ok', true,
      'status', 'already_parked',
      'batchId', p_batch_id,
      'persistedAnchorHistoryId', v_receipt.persisted_anchor_history_id,
      'cutoverHistoryId', v_receipt.cutover_history_id,
      'providerAccountEmail', v_receipt.provider_account_email,
      'providerAccountBindingHash', v_receipt.provider_account_binding_hash,
      'receiptId', v_receipt.receipt_id,
      'receiptHash', v_receipt.receipt_hash,
      'backfillGapId', v_receipt.backfill_gap_id,
      'cutoverDeltaGapId', v_receipt.cutover_delta_gap_id,
      'coordinatorJobId', v_receipt.coordinator_job_id,
      'cursorVersion', v_cursor.cursor_version,
      'cursorValue', v_cursor.cursor_value,
      'productionPublicationAttempted', false
    );
  end if;

  select * into strict v_batch
  from public.source_ingest_batches batch
  where batch.batch_id = p_batch_id;
  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = v_batch.workspace_key
    and cursor_row.source_system = v_batch.source_system
    and cursor_row.connection_key = v_batch.connection_key;
  select count(*)::integer,
         count(*) filter (where page.is_final)::integer,
         min(page.response_mailbox_history_id)
  into v_page_count, v_final_count, v_anchor
  from public.gmail_ingest_pages page
  where page.batch_id = p_batch_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'candidate',
    'batchId', v_batch.batch_id,
    'workspaceKey', v_batch.workspace_key,
    'sourceSystem', v_batch.source_system,
    'connectionKey', v_batch.connection_key,
    'batchMode', v_batch.mode,
    'batchStatus', v_batch.status,
    'pageCount', v_batch.page_count,
    'observationCount', v_batch.observation_count,
    'jobCount', v_batch.job_count,
    'persistedPageCount', v_page_count,
    'finalPageCount', v_final_count,
    'persistedAnchorHistoryId', coalesce(v_anchor, ''),
    'cursorKind', v_cursor.cursor_kind,
    'cursorStatus', v_cursor.status,
    'cursorVersion', v_cursor.cursor_version,
    'cursorValue', v_cursor.cursor_value,
    'requiredAccountEmailEnvironmentVariable', 'GMAIL_USER_EMAIL',
    'requiredAccountBindingAuthority',
      'execution-env-plus-live-gmail-profile-v1',
    'requiredProbeSchemaVersion', 'truth-gmail-current-profile-checkpoint-probe-v1',
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_truth_gmail_backfill_forward_unblock(
  p_batch_id uuid,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_truth_gmail_backfill_forward_unblock_v1(
    p_batch_id,
    p_sync_token
  );
$function$;

create or replace function private.run_truth_gmail_backfill_forward_unblock_v1(
  p_batch_id uuid,
  p_provider_probe jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_expected_batch_id constant uuid :=
    '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
  v_workspace_key constant text := 'primary';
  v_connection_key constant text := 'primary';
  v_backfill_gap_type constant text := 'PARKED_BACKFILL_HISTORICAL_DRAIN';
  v_cutover_gap_type constant text := 'GMAIL_CUTOVER_DELTA_RECONCILIATION';
  v_batch public.source_ingest_batches%rowtype;
  v_locked_batch public.source_ingest_batches%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_anchor text;
  v_page_count integer;
  v_min_page integer;
  v_max_page integer;
  v_final_count integer;
  v_page_chain_ok boolean;
  v_membership_count bigint;
  v_membership_distinct_count bigint;
  v_observation_count bigint;
  v_observation_scope_ok boolean;
  v_min_journal_seq bigint;
  v_max_journal_seq bigint;
  v_page_job_count bigint;
  v_connection_job_count bigint;
  v_page_manifest jsonb;
  v_page_manifest_hash text;
  v_account_binding_body jsonb;
  v_account_binding_hash text;
  v_provider_account_email text;
  v_probe_body jsonb;
  v_probe_hash text;
  v_probe_observed_at timestamptz;
  v_cutover_history_id text;
  v_profile_response_hash text;
  v_profile_message_count bigint;
  v_profile_thread_count bigint;
  v_checkpoint_start_history_id text;
  v_checkpoint_page_count integer;
  v_checkpoint_event_count integer;
  v_checkpoint_message_count integer;
  v_checkpoint_actual_event_count bigint;
  v_checkpoint_distinct_event_count bigint;
  v_checkpoint_actual_message_count bigint;
  v_backfill_gap_id uuid;
  v_cutover_gap_id uuid;
  v_job_id uuid;
  v_receipt_body jsonb;
  v_receipt_hash text;
  v_receipt_id text;
  v_parked_at timestamptz := clock_timestamp();
  v_prior_lease_owner text;
  v_prior_lease_fence bigint;
  v_prior_lease_expires_at timestamptz;
  v_lock_acquired boolean;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_batch_id is distinct from v_expected_batch_id then
    raise exception 'Gmail forward-unblock batch is outside the exact authority'
      using errcode = '22023';
  end if;

  select * into v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.parked_batch_id = p_batch_id;
  if found then
    select * into strict v_cursor
    from public.source_cursors cursor_row
    where cursor_row.workspace_key = v_receipt.workspace_key
      and cursor_row.source_system = 'gmail'
      and cursor_row.connection_key = v_receipt.connection_key;
    return jsonb_build_object(
      'ok', true,
      'status', 'already_parked',
      'batchId', p_batch_id,
      'persistedAnchorHistoryId', v_receipt.persisted_anchor_history_id,
      'cutoverHistoryId', v_receipt.cutover_history_id,
      'receiptId', v_receipt.receipt_id,
      'receiptHash', v_receipt.receipt_hash,
      'backfillGapId', v_receipt.backfill_gap_id,
      'cutoverDeltaGapId', v_receipt.cutover_delta_gap_id,
      'coordinatorJobId', v_receipt.coordinator_job_id,
      'cursorVersion', v_cursor.cursor_version,
      'cursorValue', v_cursor.cursor_value,
      'productionPublicationAttempted', false
    );
  end if;

  select * into strict v_batch
  from public.source_ingest_batches batch
  where batch.batch_id = p_batch_id;
  if v_batch.workspace_key is distinct from v_workspace_key
    or v_batch.source_system is distinct from 'gmail'
    or v_batch.connection_key is distinct from v_connection_key
    or v_batch.mode is distinct from 'backfill'
    or v_batch.status is distinct from 'running'
    or v_batch.expected_cursor_version is distinct from 0
    or v_batch.expected_cursor_value is distinct from ''
    or v_batch.committed_cursor_version is not null
    or v_batch.committed_cursor_value is not null
    or v_batch.batch_hash is not null
    or v_batch.page_count is distinct from 2190
    or v_batch.observation_count is distinct from 218989
    or v_batch.job_count is distinct from 0
    or v_batch.error_code is distinct from ''
    or v_batch.error_detail is distinct from ''
    or v_batch.committed_at is not null
    or v_batch.finished_at is not null then
    raise exception 'exact Gmail mega-batch precondition differs from the reviewed fixture'
      using errcode = '23514';
  end if;

  with membership_counts as (
    select member.page_ordinal, count(*)::integer as member_count
    from public.gmail_ingest_page_observations member
    where member.batch_id = p_batch_id
    group by member.page_ordinal
  ), ordered_pages as (
    select page.*,
      lag(page.response_next_page_token) over (
        order by page.page_ordinal
      ) as prior_next_page_token,
      coalesce(member.member_count, 0) as member_count
    from public.gmail_ingest_pages page
    left join membership_counts member
      on member.page_ordinal = page.page_ordinal
    where page.batch_id = p_batch_id
  )
  select count(*)::integer,
         min(page_ordinal),
         max(page_ordinal),
         count(*) filter (where is_final)::integer,
         min(response_mailbox_history_id),
         bool_and(coalesce(
           response_mailbox_history_id ~ '^[0-9]+$'
           and provider_response->>'historyId' = response_mailbox_history_id
           and coalesce(provider_response->>'nextPageToken', '') =
             response_next_page_token
           and jsonb_typeof(provider_event_manifest) = 'array'
           and jsonb_array_length(provider_event_manifest) = event_count
           and event_count = member_count
           and job_count = 0
           and (
             (page_ordinal = 0 and request_page_token = '')
             or
             (page_ordinal > 0 and request_page_token = prior_next_page_token)
           )
           and (
             (is_final and page_ordinal = 2189 and response_next_page_token = '')
             or
             (not is_final and response_next_page_token <> '')
           )
         , false))
  into v_page_count, v_min_page, v_max_page, v_final_count, v_anchor,
       v_page_chain_ok
  from ordered_pages;
  if v_page_count <> 2190 or v_min_page <> 0 or v_max_page <> 2189
    or v_final_count <> 1 or not coalesce(v_page_chain_ok, false)
    or v_anchor !~ '^[0-9]+$'
    or exists (
      select 1
      from public.gmail_ingest_pages page
      where page.batch_id = p_batch_id
        and page.response_mailbox_history_id is distinct from v_anchor
    ) then
    raise exception 'exact Gmail mega-batch page chain or profile anchor is invalid'
      using errcode = '23514';
  end if;

  select count(*)::bigint, count(distinct member.observation_id)::bigint
  into v_membership_count, v_membership_distinct_count
  from public.gmail_ingest_page_observations member
  where member.batch_id = p_batch_id;
  select count(*)::bigint,
         bool_and(coalesce(
           observation.workspace_key = v_workspace_key
           and observation.source_system = 'gmail'
           and observation.connection_key = v_connection_key
           and observation.batch_id = p_batch_id
           and observation.source_cursor_version = 1
           and observation.source_object_type = 'gmail_message_discovery_event'
           and observation.schema_version = 'gmail-mailbox-discovery-event-v1'
           and observation.normalized_payload->>'eventType' = 'message_discovered'
           and observation.normalized_payload->>'historyId' = v_anchor
         , false)),
         min(observation.journal_seq),
         max(observation.journal_seq)
  into v_observation_count, v_observation_scope_ok,
       v_min_journal_seq, v_max_journal_seq
  from public.source_observations observation
  where observation.batch_id = p_batch_id;
  if v_membership_count <> 218989
    or v_membership_distinct_count <> 218989
    or v_observation_count <> 218989
    or not coalesce(v_observation_scope_ok, false)
    or exists (
      select 1
      from public.source_observations observation
      where observation.batch_id = p_batch_id
        and not exists (
          select 1
          from public.gmail_ingest_page_observations member
          where member.batch_id = p_batch_id
            and member.observation_id = observation.observation_id
        )
    )
    or exists (
      select 1
      from public.gmail_ingest_page_observations member
      where member.batch_id = p_batch_id
        and not exists (
          select 1
          from public.source_observations observation
          where observation.batch_id = p_batch_id
            and observation.observation_id = member.observation_id
        )
    ) then
    raise exception 'exact Gmail mega-batch immutable observation membership is incomplete'
      using errcode = '23514';
  end if;

  select count(*)::bigint into v_page_job_count
  from public.gmail_ingest_page_jobs member
  where member.batch_id = p_batch_id;
  select count(*)::bigint into v_connection_job_count
  from public.source_processing_jobs job
  where job.workspace_key = v_workspace_key
    and job.source_system = 'gmail'
    and job.connection_key = v_connection_key;
  if v_page_job_count <> 0 or v_connection_job_count <> 0
    or exists (
      select 1 from public.gmail_batch_materialization_route_seals seal
      where seal.workspace_key = v_workspace_key
        and seal.root_batch_id = p_batch_id
    )
    or exists (
      select 1 from public.gmail_message_materialization_groups group_row
      where group_row.workspace_key = v_workspace_key
        and group_row.root_batch_id = p_batch_id
    )
    or exists (
      select 1 from public.source_processing_job_lineage lineage
      where lineage.workspace_key = v_workspace_key
        and lineage.root_batch_id = p_batch_id
    )
    or exists (
      select 1 from public.gmail_parse_processing_epochs epoch
      where epoch.workspace_key = v_workspace_key
        and epoch.connection_key = v_connection_key
    )
    or exists (
      select 1 from public.gmail_parse_checkpoints checkpoint
      where checkpoint.workspace_key = v_workspace_key
        and checkpoint.connection_key = v_connection_key
    ) then
    raise exception 'exact Gmail mega-batch already has a downstream processing authority'
      using errcode = '23514';
  end if;

  if jsonb_typeof(p_provider_probe) is distinct from 'object'
    or not private.truth_jsonb_has_only_keys(p_provider_probe, array[
      'schemaVersion','workspaceKey','connectionKey','batchId',
      'persistedAnchorHistoryId','cutoverHistoryId','profileResponseHash',
      'accountIdentity','profileEvidence','checkpointEvidence','observedAt',
      'productionPublicationAttempted','probeHash'
    ])
    or (select count(*) from jsonb_object_keys(p_provider_probe)) <> 13
    or p_provider_probe->>'schemaVersion' is distinct from
      'truth-gmail-current-profile-checkpoint-probe-v1'
    or p_provider_probe->>'workspaceKey' is distinct from v_workspace_key
    or p_provider_probe->>'connectionKey' is distinct from v_connection_key
    or p_provider_probe->>'batchId' is distinct from p_batch_id::text
    or p_provider_probe->>'persistedAnchorHistoryId' is distinct from v_anchor
    or coalesce(p_provider_probe->>'cutoverHistoryId', '') !~ '^[0-9]+$'
    or jsonb_typeof(p_provider_probe->'accountIdentity') is distinct from 'object'
    or not private.truth_jsonb_has_only_keys(
      p_provider_probe->'accountIdentity', array[
        'schemaVersion','authority','environmentVariable',
        'expectedAccountEmail','profileAccountEmail','bindingHash'
      ]
    )
    or (select count(*) from jsonb_object_keys(
      p_provider_probe->'accountIdentity'
    )) <> 6
    or p_provider_probe #>> '{accountIdentity,schemaVersion}'
      is distinct from 'truth-gmail-env-profile-account-binding-v1'
    or p_provider_probe #>> '{accountIdentity,authority}'
      is distinct from 'execution-env-plus-live-gmail-profile-v1'
    or p_provider_probe #>> '{accountIdentity,environmentVariable}'
      is distinct from 'GMAIL_USER_EMAIL'
    or nullif(trim(
      p_provider_probe #>> '{accountIdentity,expectedAccountEmail}'
    ), '') is null
    or lower(trim(
      p_provider_probe #>> '{accountIdentity,expectedAccountEmail}'
    )) is distinct from p_provider_probe #>>
      '{accountIdentity,expectedAccountEmail}'
    or lower(trim(
      p_provider_probe #>> '{accountIdentity,profileAccountEmail}'
    )) is distinct from p_provider_probe #>>
      '{accountIdentity,profileAccountEmail}'
    or p_provider_probe #>> '{accountIdentity,profileAccountEmail}'
      is distinct from p_provider_probe #>>
        '{accountIdentity,expectedAccountEmail}'
    or coalesce(p_provider_probe #>> '{accountIdentity,bindingHash}', '')
      !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_provider_probe->'profileEvidence') is distinct from 'object'
    or not private.truth_jsonb_has_only_keys(
      p_provider_probe->'profileEvidence',
      array['emailAddress','historyId','messagesTotal','threadsTotal']
    )
    or (select count(*) from jsonb_object_keys(
      p_provider_probe->'profileEvidence'
    )) <> 4
    or lower(trim(coalesce(
      p_provider_probe #>> '{profileEvidence,emailAddress}', ''
    ))) is distinct from p_provider_probe #>>
      '{accountIdentity,profileAccountEmail}'
    or coalesce(p_provider_probe #>> '{profileEvidence,historyId}', '')
      !~ '^[0-9]+$'
    or jsonb_typeof(p_provider_probe #> '{profileEvidence,messagesTotal}')
      is distinct from 'number'
    or jsonb_typeof(p_provider_probe #> '{profileEvidence,threadsTotal}')
      is distinct from 'number'
    or jsonb_typeof(p_provider_probe->'checkpointEvidence')
      is distinct from 'object'
    or not private.truth_jsonb_has_only_keys(
      p_provider_probe->'checkpointEvidence', array[
        'checkpointKind','startMessageId','startHistoryId','terminalHistoryId',
        'historyTypes','pageCount','eventCount','distinctMessageCount','pageManifest'
      ]
    )
    or (select count(*) from jsonb_object_keys(
      p_provider_probe->'checkpointEvidence'
    )) <> 9
    or p_provider_probe #>> '{checkpointEvidence,checkpointKind}'
      is distinct from 'recent-message-to-terminal-history-list-v1'
    or nullif(p_provider_probe #>> '{checkpointEvidence,startMessageId}', '')
      is null
    or coalesce(p_provider_probe #>> '{checkpointEvidence,startHistoryId}', '')
      !~ '^[0-9]+$'
    or p_provider_probe #>> '{checkpointEvidence,terminalHistoryId}'
      is distinct from p_provider_probe->>'cutoverHistoryId'
    or p_provider_probe #> '{checkpointEvidence,historyTypes}' is distinct from
      '["messageAdded","messageDeleted","labelAdded","labelRemoved"]'::jsonb
    or jsonb_typeof(p_provider_probe #> '{checkpointEvidence,pageCount}')
      is distinct from 'number'
    or jsonb_typeof(p_provider_probe #> '{checkpointEvidence,eventCount}')
      is distinct from 'number'
    or jsonb_typeof(p_provider_probe #> '{checkpointEvidence,distinctMessageCount}')
      is distinct from 'number'
    or jsonb_typeof(p_provider_probe #> '{checkpointEvidence,pageManifest}')
      is distinct from 'array'
    or coalesce(p_provider_probe->>'profileResponseHash', '')
      !~ '^[0-9a-f]{64}$'
    or p_provider_probe->'productionPublicationAttempted'
      is distinct from 'false'::jsonb
    or coalesce(p_provider_probe->>'probeHash', '') !~ '^[0-9a-f]{64}$'
    or not private.is_canonical_utc_millis(
      coalesce(p_provider_probe->>'observedAt', '')
    ) then
    raise exception 'Gmail current-profile checkpoint probe envelope is invalid'
      using errcode = '23514';
  end if;

  begin
    v_probe_observed_at := (p_provider_probe->>'observedAt')::timestamptz;
    v_profile_message_count :=
      (p_provider_probe #>> '{profileEvidence,messagesTotal}')::bigint;
    v_profile_thread_count :=
      (p_provider_probe #>> '{profileEvidence,threadsTotal}')::bigint;
    v_checkpoint_start_history_id :=
      p_provider_probe #>> '{checkpointEvidence,startHistoryId}';
    v_checkpoint_page_count :=
      (p_provider_probe #>> '{checkpointEvidence,pageCount}')::integer;
    v_checkpoint_event_count :=
      (p_provider_probe #>> '{checkpointEvidence,eventCount}')::integer;
    v_checkpoint_message_count :=
      (p_provider_probe #>> '{checkpointEvidence,distinctMessageCount}')::integer;
  exception when others then
    raise exception 'Gmail current-profile checkpoint probe values are invalid'
      using errcode = '23514';
  end;
  v_cutover_history_id := p_provider_probe->>'cutoverHistoryId';
  v_provider_account_email :=
    p_provider_probe #>> '{accountIdentity,profileAccountEmail}';
  v_account_binding_body :=
    (p_provider_probe->'accountIdentity') - ('bindingHash'::text);
  v_account_binding_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_account_binding_body),
    'UTF8'
  ), 'sha256'), 'hex');
  v_profile_response_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(p_provider_probe->'profileEvidence'),
    'UTF8'
  ), 'sha256'), 'hex');
  v_probe_body := p_provider_probe - 'probeHash';
  v_probe_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_probe_body), 'UTF8'
  ), 'sha256'), 'hex');
  if p_provider_probe #>> '{accountIdentity,bindingHash}'
      is distinct from v_account_binding_hash then
    raise exception 'Gmail environment/profile account binding hash is invalid'
      using errcode = '23514';
  end if;
  if p_provider_probe->>'probeHash' is distinct from v_probe_hash
    or p_provider_probe->>'profileResponseHash'
      is distinct from v_profile_response_hash
    or v_profile_message_count < 0
    or v_profile_thread_count < 0
    or v_checkpoint_page_count < 1 or v_checkpoint_page_count > 5
    or jsonb_array_length(
      p_provider_probe #> '{checkpointEvidence,pageManifest}'
    ) <> v_checkpoint_page_count
    or v_checkpoint_event_count < 0 or v_checkpoint_event_count > 1000
    or v_checkpoint_message_count < 0 or v_checkpoint_message_count > 500
    or v_checkpoint_message_count > v_checkpoint_event_count
    or not coalesce(private.gmail_history_id_at_least(
      p_provider_probe #>> '{profileEvidence,historyId}',
      v_checkpoint_start_history_id
    ), false)
    or not coalesce(private.gmail_history_id_at_least(
      v_checkpoint_start_history_id, v_anchor
    ), false)
    or not coalesce(private.gmail_history_id_at_least(
      v_cutover_history_id, v_checkpoint_start_history_id
    ), false)
    or not coalesce(private.gmail_history_id_at_least(
      v_cutover_history_id,
      p_provider_probe #>> '{profileEvidence,historyId}'
    ), false)
    or v_probe_observed_at < clock_timestamp() - interval '10 minutes'
    or v_probe_observed_at > clock_timestamp() + interval '5 minutes'
    or not coalesce(private.gmail_history_id_at_least(
      v_cutover_history_id, v_anchor
    ), false) then
    raise exception 'Gmail current-profile checkpoint probe is stale or regressed'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from (
      select item, ordinal,
        lag(item->>'responseNextPageTokenHash') over (
          order by ordinal
        ) as prior_response_token_hash
      from jsonb_array_elements(
        p_provider_probe #> '{checkpointEvidence,pageManifest}'
      ) with ordinality source(item, ordinal)
    ) manifest
    where jsonb_typeof(manifest.item) is distinct from 'object'
      or coalesce((manifest.item->>'pageOrdinal')::integer, -1)
        <> manifest.ordinal - 1
      or coalesce(manifest.item->>'requestPageTokenHash', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(manifest.item->>'responseNextPageTokenHash', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(manifest.item->>'providerResponseHash', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(manifest.item->>'responseHistoryId', '') !~ '^[0-9]+$'
      or not coalesce(private.gmail_history_id_at_least(
        manifest.item->>'responseHistoryId', v_checkpoint_start_history_id
      ), false)
      or not coalesce(private.gmail_history_id_at_least(
        v_cutover_history_id, manifest.item->>'responseHistoryId'
      ), false)
      or jsonb_typeof(manifest.item->'eventManifest') is distinct from 'array'
      or jsonb_typeof(manifest.item->'nextPageTokenPresent')
        is distinct from 'boolean'
      or (
        manifest.ordinal = 1
        and manifest.item->>'requestPageTokenHash' is distinct from
          encode(extensions.digest(convert_to('', 'UTF8'), 'sha256'), 'hex')
      )
      or (
        manifest.ordinal > 1
        and manifest.item->>'requestPageTokenHash'
          is distinct from manifest.prior_response_token_hash
      )
      or (
        manifest.ordinal < v_checkpoint_page_count
        and manifest.item->'nextPageTokenPresent' is distinct from 'true'::jsonb
      )
      or (
        manifest.ordinal = v_checkpoint_page_count
        and manifest.item->'nextPageTokenPresent' is distinct from 'false'::jsonb
      )
      or (
        manifest.ordinal = v_checkpoint_page_count
        and manifest.item->>'responseNextPageTokenHash' is distinct from
          encode(extensions.digest(convert_to('', 'UTF8'), 'sha256'), 'hex')
      )
  )
  or (
    p_provider_probe #> '{checkpointEvidence,pageManifest}'
      -> (v_checkpoint_page_count - 1) ->> 'responseHistoryId'
  ) is distinct from v_cutover_history_id then
    raise exception 'Gmail current-profile checkpoint page manifest is invalid'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(
      p_provider_probe #> '{checkpointEvidence,pageManifest}'
    ) page
    cross join lateral jsonb_array_elements(page->'eventManifest') event
    where jsonb_typeof(event) is distinct from 'object'
      or coalesce(event->>'eventId', '') !~ '^gmail-event:v1:[0-9a-f]{64}$'
      or event->>'eventId' is distinct from 'gmail-event:v1:' ||
        encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(event - 'eventId'), 'UTF8'
        ), 'sha256'), 'hex')
      or coalesce(event->>'historyId', '') !~ '^[0-9]+$'
      or nullif(event->>'messageId', '') is null
      or not (coalesce(event->>'eventType', '') = any (array[
        'message_added','message_deleted','labels_added','labels_removed'
      ]))
      or not coalesce(private.gmail_history_id_at_least(
        event->>'historyId', v_checkpoint_start_history_id
      ), false)
      or not coalesce(private.gmail_history_id_at_least(
        v_cutover_history_id, event->>'historyId'
      ), false)
  ) then
    raise exception 'Gmail current-profile checkpoint event manifest is invalid'
      using errcode = '23514';
  end if;

  select count(*)::bigint,
         count(distinct event->>'eventId')::bigint,
         count(distinct event->>'messageId')::bigint
  into v_checkpoint_actual_event_count,
       v_checkpoint_distinct_event_count,
       v_checkpoint_actual_message_count
  from jsonb_array_elements(
    p_provider_probe #> '{checkpointEvidence,pageManifest}'
  ) page
  cross join lateral jsonb_array_elements(page->'eventManifest') event;
  if v_checkpoint_actual_event_count <> v_checkpoint_event_count
    or v_checkpoint_distinct_event_count <> v_checkpoint_event_count
    or v_checkpoint_actual_message_count <> v_checkpoint_message_count then
    raise exception 'Gmail current-profile checkpoint counters are invalid'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'pageOrdinal', page.page_ordinal,
    'providerResponseHash', page.provider_response_hash,
    'eventDigest', page.event_digest,
    'eventCount', page.event_count,
    'jobCount', page.job_count,
    'isFinal', page.is_final
  ) order by page.page_ordinal), '[]'::jsonb)
  into v_page_manifest
  from public.gmail_ingest_pages page
  where page.batch_id = p_batch_id;
  v_page_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_page_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  v_backfill_gap_id := private.truth_deterministic_uuid_v1(encode(extensions.digest(
    convert_to('truth-gmail-backfill-parking-gap-v1:' || p_batch_id::text,
      'UTF8'), 'sha256'), 'hex'));
  v_cutover_gap_id := private.truth_deterministic_uuid_v1(encode(extensions.digest(
    convert_to('truth-gmail-cutover-delta-gap-v1:' || p_batch_id::text || ':' ||
      v_cutover_history_id, 'UTF8'), 'sha256'), 'hex'));
  v_job_id := private.truth_deterministic_uuid_v1(encode(extensions.digest(
    convert_to('truth-gmail-backfill-historical-drain-v1:' || p_batch_id::text,
      'UTF8'), 'sha256'), 'hex'));

  v_lock_acquired := pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:' || v_workspace_key,
    0
  ));
  if not v_lock_acquired then
    return jsonb_build_object(
      'ok', true,
      'status', 'busy',
      'retryable', true,
      'batchId', p_batch_id,
      'productionPublicationAttempted', false
    );
  end if;

  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = v_workspace_key
    and cursor_row.source_system = 'gmail'
    and cursor_row.connection_key = v_connection_key
  for update;
  select * into strict v_locked_batch
  from public.source_ingest_batches batch
  where batch.batch_id = p_batch_id
  for update;
  if v_locked_batch is distinct from v_batch
    or v_cursor.cursor_kind <> 'gmail_history_id'
    or v_cursor.status <> 'backfill_required'
    or v_cursor.cursor_version <> v_batch.expected_cursor_version
    or v_cursor.cursor_value is distinct from v_batch.expected_cursor_value
    or v_cursor.last_batch_id is not null
    or v_cursor.last_committed_at is not null then
    raise exception 'Gmail forward-unblock cursor or batch changed after preflight'
      using errcode = '40001';
  end if;
  if v_probe_observed_at < clock_timestamp() - interval '10 minutes'
    or v_probe_observed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Gmail environment/profile checkpoint aged out during preflight'
      using errcode = '40001';
  end if;
  v_prior_lease_owner := v_cursor.lease_owner;
  v_prior_lease_fence := v_cursor.lease_fence;
  v_prior_lease_expires_at := v_cursor.lease_expires_at;

  v_receipt_body := jsonb_build_object(
    'schemaVersion', 'truth-gmail-backfill-parking-receipt-v1',
    'authorityVersion', 'truth-gmail-primary-ingest-forward-unblock-v1',
    'workspaceKey', v_workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', v_connection_key,
    'providerAccountIdentity', p_provider_probe->'accountIdentity',
    'parkedBatchId', p_batch_id,
    'parkedBatchMode', v_batch.mode,
    'parkedBatchStartedAt', private.canonical_truth_timestamp(v_batch.started_at),
    'pageCount', v_page_count,
    'observationCount', v_observation_count,
    'jobCount', 0,
    'pageManifestHash', v_page_manifest_hash,
    'observationJournalBounds', jsonb_build_object(
      'minimumJournalSeq', v_min_journal_seq,
      'maximumJournalSeq', v_max_journal_seq,
      'membershipCount', v_membership_count,
      'distinctMembershipCount', v_membership_distinct_count
    ),
    'persistedAnchor', jsonb_build_object(
      'historyId', v_anchor,
      'proofKind', 'gmail-backfill-profile-anchor-repeated-on-every-page-v1'
    ),
    'providerProbe', p_provider_probe,
    'providerProbeHash', v_probe_hash,
    'priorCursor', jsonb_build_object(
      'kind', v_cursor.cursor_kind,
      'status', v_cursor.status,
      'version', v_cursor.cursor_version,
      'value', v_cursor.cursor_value,
      'lastBatchId', v_cursor.last_batch_id,
      'lastCommittedAt', case when v_cursor.last_committed_at is null then null
        else private.canonical_truth_timestamp(v_cursor.last_committed_at) end,
      'lastErrorCode', v_cursor.last_error_code,
      'lastErrorDetail', v_cursor.last_error_detail,
      'leaseOwner', v_prior_lease_owner,
      'leaseFence', v_prior_lease_fence,
      'leaseExpiresAt', case when v_prior_lease_expires_at is null then null
        else private.canonical_truth_timestamp(v_prior_lease_expires_at) end
    ),
    'resumedCursor', jsonb_build_object(
      'kind', 'gmail_history_id',
      'status', 'live',
      'version', v_cursor.cursor_version + 1,
      'value', v_cutover_history_id,
      'lastBatchId', null,
      'lastCommittedAt', null,
      'leaseFence', v_cursor.lease_fence + 1
    ),
    'completenessGaps', jsonb_build_array(
      jsonb_build_object(
        'gapId', v_backfill_gap_id,
        'gapType', v_backfill_gap_type,
        'priorCursorValue', v_cursor.cursor_value,
        'recoveryAnchorValue', v_anchor
      ),
      jsonb_build_object(
        'gapId', v_cutover_gap_id,
        'gapType', v_cutover_gap_type,
        'priorCursorValue', v_anchor,
        'recoveryAnchorValue', v_cutover_history_id
      )
    ),
    'coordinatorJobId', v_job_id,
    'coverageDisposition',
      'immutable_backfill_parked_pending_bounded_historical_adoption',
    'parkedAt', private.canonical_truth_timestamp(v_parked_at),
    'productionPublicationAttempted', false
  );
  v_receipt_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_receipt_body), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt_id := 'truth-gmail-backfill-parking:v1:' || v_receipt_hash;

  insert into public.gmail_completeness_gaps(
    gap_id, workspace_key, connection_key, gap_type,
    prior_cursor_value, recovery_anchor_value, detected_at,
    status, detail, created_at
  ) values (
    v_backfill_gap_id, v_workspace_key, v_connection_key, v_backfill_gap_type,
    v_cursor.cursor_value, v_anchor, v_parked_at,
    'open', jsonb_build_object(
      'schemaVersion', 'truth-gmail-backfill-parking-gap-v1',
      'authorityVersion', 'truth-gmail-primary-ingest-forward-unblock-v1',
      'parkedBatchId', p_batch_id,
      'parkingReceiptId', v_receipt_id,
      'parkingReceiptHash', v_receipt_hash,
      'pageCount', v_page_count,
      'observationCount', v_observation_count,
      'pageManifestHash', v_page_manifest_hash,
      'providerProbeHash', v_probe_hash,
      'historicalDrainRequired', true,
      'productionPublicationAttempted', false
    ), v_parked_at
  );

  insert into public.gmail_completeness_gaps(
    gap_id, workspace_key, connection_key, gap_type,
    prior_cursor_value, recovery_anchor_value, detected_at,
    status, detail, created_at
  ) values (
    v_cutover_gap_id, v_workspace_key, v_connection_key, v_cutover_gap_type,
    v_anchor, v_cutover_history_id, v_parked_at,
    'open', jsonb_build_object(
      'schemaVersion', 'truth-gmail-cutover-delta-gap-v1',
      'authorityVersion', 'truth-gmail-primary-ingest-forward-unblock-v1',
      'parkedBatchId', p_batch_id,
      'parkingReceiptId', v_receipt_id,
      'parkingReceiptHash', v_receipt_hash,
      'persistedAnchorHistoryId', v_anchor,
      'cutoverHistoryId', v_cutover_history_id,
      'profileResponseHash', v_profile_response_hash,
      'providerProbeHash', v_probe_hash,
      'mailboxReconciliationRequired', true,
      'productionPublicationAttempted', false
    ), v_parked_at
  );

  insert into public.source_processing_jobs(
    job_id, dedupe_key, workspace_key, source_system, connection_key,
    job_kind, observation_id, source_object_id, state,
    attempt_count, max_attempts, available_at,
    lease_owner, lease_fence, lease_expires_at,
    last_error_code, safe_error_detail, processor_version,
    payload, result, created_at, updated_at, completed_at
  ) values (
    v_job_id,
    'truth:gmail:drain-parked-backfill:v1:' || p_batch_id::text,
    v_workspace_key, 'gmail', v_connection_key,
    'truth_drain_parked_gmail_backfill', null, p_batch_id::text,
    'waiting_runtime', 0, 1, v_parked_at,
    null, 0, null,
    'HISTORICAL_DRAIN_COORDINATOR_REQUIRED',
    'The immutable Gmail backfill is parked pending bounded historical adoption.',
    '',
    jsonb_build_object(
      'schemaVersion', 'truth-gmail-parked-backfill-drain-job-v1',
      'parkedBatchId', p_batch_id,
      'parkingReceiptId', v_receipt_id,
      'parkingReceiptHash', v_receipt_hash,
      'backfillGapId', v_backfill_gap_id,
      'cutoverDeltaGapId', v_cutover_gap_id,
      'persistedAnchorHistoryId', v_anchor,
      'cutoverHistoryId', v_cutover_history_id,
      'pageCount', v_page_count,
      'observationCount', v_observation_count,
      'productionPublicationAttempted', false
    ),
    '{}'::jsonb, v_parked_at, v_parked_at, null
  );
  insert into public.source_processing_job_lineage(
    job_id, workspace_key, source_system, connection_key,
    root_batch_id, parent_job_id, root_job_id,
    source_cursor_version, source_cursor_value, created_at
  ) values (
    v_job_id, v_workspace_key, 'gmail', v_connection_key,
    p_batch_id, null, v_job_id,
    v_cursor.cursor_version + 1, v_cutover_history_id, v_parked_at
  );

  update public.source_ingest_batches
  set status = 'superseded',
      error_code = 'GMAIL_BACKFILL_PARKED_FOR_BOUNDED_HISTORICAL_DRAIN',
      error_detail = jsonb_build_object(
        'schemaVersion', 'truth-gmail-backfill-parking-detail-v1',
        'parkingReceiptId', v_receipt_id,
        'parkingReceiptHash', v_receipt_hash,
        'backfillGapId', v_backfill_gap_id,
        'cutoverDeltaGapId', v_cutover_gap_id,
        'coordinatorJobId', v_job_id
      )::text,
      finished_at = v_parked_at
  where batch_id = p_batch_id;

  update public.source_cursors
  set cursor_value = v_cutover_history_id,
      cursor_version = cursor_version + 1,
      status = 'live',
      last_batch_id = null,
      last_committed_at = null,
      last_error_code = 'GMAIL_INCREMENTAL_COMMIT_WITNESS_PENDING',
      last_error_detail = jsonb_build_object(
        'schemaVersion', 'truth-gmail-incremental-witness-pending-v1',
        'parkingReceiptId', v_receipt_id,
        'parkingReceiptHash', v_receipt_hash,
        'persistedAnchorHistoryId', v_anchor,
        'cutoverHistoryId', v_cutover_history_id,
        'backfillGapId', v_backfill_gap_id,
        'cutoverDeltaGapId', v_cutover_gap_id
      )::text,
      lease_owner = null,
      lease_fence = lease_fence + 1,
      lease_expires_at = null,
      updated_at = v_parked_at
  where workspace_key = v_workspace_key
    and source_system = 'gmail'
    and connection_key = v_connection_key
    and cursor_version = v_batch.expected_cursor_version
    and cursor_value is not distinct from v_batch.expected_cursor_value;
  if not found then
    raise exception 'Gmail forward-unblock cursor compare-and-swap failed'
      using errcode = '40001';
  end if;

  insert into public.truth_gmail_backfill_parking_receipts(
    receipt_id, receipt_hash, workspace_key, source_system, connection_key,
    provider_account_email, provider_account_binding_hash,
    parked_batch_id, backfill_gap_id, cutover_delta_gap_id, coordinator_job_id,
    persisted_anchor_history_id, cutover_history_id, prior_cursor_version,
    resumed_cursor_version, page_count, observation_count, job_count,
    page_manifest_hash, provider_probe_hash, canonical_receipt,
    schema_version, parked_at, created_at
  ) values (
    v_receipt_id, v_receipt_hash, v_workspace_key, 'gmail', v_connection_key,
    v_provider_account_email, v_account_binding_hash,
    p_batch_id, v_backfill_gap_id, v_cutover_gap_id, v_job_id,
    v_anchor, v_cutover_history_id, v_batch.expected_cursor_version,
    v_batch.expected_cursor_version + 1,
    v_page_count, v_observation_count, 0,
    v_page_manifest_hash, v_probe_hash, v_receipt_body,
    'truth-gmail-backfill-parking-receipt-v1', v_parked_at, v_parked_at
  ) returning * into v_receipt;

  select * into strict v_cursor
  from public.source_cursors cursor_row
  where cursor_row.workspace_key = v_workspace_key
    and cursor_row.source_system = 'gmail'
    and cursor_row.connection_key = v_connection_key;
  select * into strict v_locked_batch
  from public.source_ingest_batches batch
  where batch.batch_id = p_batch_id;
  if v_locked_batch.status is distinct from 'superseded'
    or v_receipt.provider_account_email
      is distinct from v_provider_account_email
    or v_receipt.provider_account_binding_hash
      is distinct from v_account_binding_hash
    or v_locked_batch.page_count is distinct from 2190
    or v_locked_batch.observation_count is distinct from 218989
    or v_locked_batch.job_count is distinct from 0
    or v_locked_batch.committed_cursor_version is not null
    or v_locked_batch.committed_cursor_value is not null
    or v_locked_batch.batch_hash is not null
    or v_cursor.status is distinct from 'live'
    or v_cursor.cursor_version is distinct from v_batch.expected_cursor_version + 1
    or v_cursor.cursor_value is distinct from v_cutover_history_id
    or v_cursor.last_batch_id is not null
    or v_cursor.last_committed_at is not null
    or v_cursor.lease_owner is not null
    or v_cursor.lease_expires_at is not null
    or v_cursor.lease_fence <> v_prior_lease_fence + 1
    or not exists (
      select 1 from public.gmail_completeness_gaps gap
      where gap.gap_id = v_backfill_gap_id and gap.status = 'open'
        and gap.gap_type = v_backfill_gap_type
        and gap.prior_cursor_value = v_batch.expected_cursor_value
        and gap.recovery_anchor_value = v_anchor
    )
    or not exists (
      select 1 from public.gmail_completeness_gaps gap
      where gap.gap_id = v_cutover_gap_id and gap.status = 'open'
        and gap.gap_type = v_cutover_gap_type
        and gap.prior_cursor_value = v_anchor
        and gap.recovery_anchor_value = v_cutover_history_id
    )
    or not exists (
      select 1 from public.source_processing_jobs job
      where job.job_id = v_job_id
        and job.state = 'waiting_runtime'
        and job.last_error_code = 'HISTORICAL_DRAIN_COORDINATOR_REQUIRED'
    )
    or not exists (
      select 1 from public.source_processing_job_lineage lineage
      where lineage.job_id = v_job_id
        and lineage.root_batch_id = p_batch_id
        and lineage.source_cursor_version = v_batch.expected_cursor_version + 1
        and lineage.source_cursor_value = v_cutover_history_id
    ) then
    raise exception 'Gmail forward-unblock postcondition is incomplete'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'parked',
    'batchId', p_batch_id,
    'persistedAnchorHistoryId', v_anchor,
    'cutoverHistoryId', v_cutover_history_id,
    'profileResponseHash', v_profile_response_hash,
    'providerAccountEmail', v_provider_account_email,
    'providerAccountBindingHash', v_account_binding_hash,
    'receiptId', v_receipt.receipt_id,
    'receiptHash', v_receipt.receipt_hash,
    'backfillGapId', v_backfill_gap_id,
    'cutoverDeltaGapId', v_cutover_gap_id,
    'coordinatorJobId', v_job_id,
    'cursorVersion', v_cursor.cursor_version,
    'cursorValue', v_cursor.cursor_value,
    'nextIncrementalMode', 'history',
    'commitWitnessPending', true,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.run_truth_gmail_backfill_forward_unblock(
  p_batch_id uuid,
  p_provider_probe jsonb,
  p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.run_truth_gmail_backfill_forward_unblock_v1(
    p_batch_id,
    p_provider_probe,
    p_sync_token
  );
$function$;

revoke all on function private.read_truth_gmail_backfill_forward_unblock_v1(
  uuid, text
) from public, anon, authenticated, service_role;
revoke all on function private.run_truth_gmail_backfill_forward_unblock_v1(
  uuid, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.read_truth_gmail_backfill_forward_unblock(
  uuid, text
) from public, anon, authenticated;
revoke all on function public.run_truth_gmail_backfill_forward_unblock(
  uuid, jsonb, text
) from public, anon, authenticated;
grant execute on function public.read_truth_gmail_backfill_forward_unblock(
  uuid, text
) to service_role;
grant execute on function public.run_truth_gmail_backfill_forward_unblock(
  uuid, jsonb, text
) to service_role;

do $verify$
declare
  v_table_count integer;
  v_rls_enabled boolean;
  v_rls_forced boolean;
  v_public_config text[];
  v_private_config text[];
begin
  select count(*)::integer, bool_and(cls.relrowsecurity), bool_and(cls.relforcerowsecurity)
  into v_table_count, v_rls_enabled, v_rls_forced
  from pg_catalog.pg_class cls
  join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public'
    and cls.relname = 'truth_gmail_backfill_parking_receipts'
    and cls.relkind = 'r';
  if v_table_count <> 1 or not coalesce(v_rls_enabled, false)
    or not coalesce(v_rls_forced, false) then
    raise exception 'Gmail backfill parking receipt storage is not protected'
      using errcode = '23514';
  end if;

  if to_regprocedure(
      'public.read_truth_gmail_backfill_forward_unblock(uuid,text)'
    ) is null
    or to_regprocedure(
      'public.run_truth_gmail_backfill_forward_unblock(uuid,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.read_truth_gmail_backfill_forward_unblock_v1(uuid,text)'
    ) is null
    or to_regprocedure(
      'private.run_truth_gmail_backfill_forward_unblock_v1(uuid,jsonb,text)'
    ) is null then
    raise exception 'Gmail backfill forward-unblock authority is incomplete'
      using errcode = '23514';
  end if;

  if has_function_privilege(
      'anon',
      'public.run_truth_gmail_backfill_forward_unblock(uuid,jsonb,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.run_truth_gmail_backfill_forward_unblock(uuid,jsonb,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.run_truth_gmail_backfill_forward_unblock(uuid,jsonb,text)',
      'EXECUTE'
    ) then
    raise exception 'Gmail backfill forward-unblock RPC privileges are unsafe'
      using errcode = '42501';
  end if;

  select proconfig into v_public_config
  from pg_catalog.pg_proc
  where oid = 'public.commit_source_ingest_batch(uuid,text,bigint,text)'::regprocedure;
  select proconfig into v_private_config
  from pg_catalog.pg_proc
  where oid = 'private.commit_source_ingest_batch(uuid,text,bigint,text)'::regprocedure;
  if exists (
      select 1 from unnest(coalesce(v_public_config, array[]::text[])) setting
      where setting ~ '^(enable_|plan_cache_mode|cpu_|random_page_cost|seq_page_cost)'
    )
    or exists (
      select 1 from unnest(coalesce(v_private_config, array[]::text[])) setting
      where setting ~ '^(enable_|plan_cache_mode|cpu_|random_page_cost|seq_page_cost)'
    ) then
    raise exception 'cron-path Gmail commit authority carries a planner override'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.truth_gmail_backfill_parking_receipts receipt
    where receipt.parked_batch_id =
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid
      and (
        receipt.workspace_key is distinct from 'primary'
        or receipt.source_system is distinct from 'gmail'
        or receipt.connection_key is distinct from 'primary'
        or nullif(trim(receipt.provider_account_email), '') is null
        or receipt.provider_account_binding_hash !~ '^[0-9a-f]{64}$'
        or receipt.page_count is distinct from 2190
        or receipt.observation_count is distinct from 218989
        or receipt.job_count is distinct from 0
        or receipt.cutover_history_id !~ '^[0-9]+$'
        or receipt.canonical_receipt->>'productionPublicationAttempted'
          is distinct from 'false'
        or receipt.canonical_receipt #>> '{resumedCursor,value}'
          is distinct from receipt.cutover_history_id
        or receipt.canonical_receipt #>>
          '{providerAccountIdentity,profileAccountEmail}'
          is distinct from receipt.provider_account_email
        or receipt.canonical_receipt #>>
          '{providerAccountIdentity,expectedAccountEmail}'
          is distinct from receipt.provider_account_email
        or receipt.canonical_receipt #>>
          '{providerAccountIdentity,bindingHash}'
          is distinct from receipt.provider_account_binding_hash
        or receipt.provider_account_binding_hash is distinct from
          encode(extensions.digest(convert_to(
            private.truth_canonical_json_text(
              (receipt.canonical_receipt->'providerAccountIdentity')
                - ('bindingHash'::text)
            ),
            'UTF8'
          ), 'sha256'), 'hex')
        or receipt.receipt_hash is distinct from encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(receipt.canonical_receipt),
          'UTF8'
        ), 'sha256'), 'hex')
      )
  ) then
    raise exception 'exact Gmail backfill parking receipt failed read-back verification'
      using errcode = '23514';
  end if;
end;
$verify$;
