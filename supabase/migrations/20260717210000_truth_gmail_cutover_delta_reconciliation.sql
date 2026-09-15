-- Bounded adoption of the exact Gmail cutover delta left open by
-- 20260717170000.
--
-- The parked 218,989-observation backfill remains parked and its historical
-- drain gap remains open.  This authority proves one immutable provider scan
-- over history IDs 19571223..19640268 (or an explicitly weaker, date-scoped
-- current-mailbox scan after a provider 404), adopts at most twenty messages
-- per committed root, and leaves the live cursor value unchanged.  The normal
-- Gmail materialization, parse-checkpoint, link-epoch, and claim machinery owns
-- every adopted root.  No function in this migration publishes a packet.

do $preflight$
begin
  if to_regclass('public.truth_gmail_backfill_parking_receipts') is null
    or to_regclass('public.gmail_parse_checkpoints') is null
    or to_regclass('public.truth_gmail_link_epoch_members') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_jsonb_has_only_keys(jsonb,text[])') is null
    or to_regprocedure('private.truth_deterministic_uuid_v1(text)') is null
    or to_regprocedure('private.gmail_history_id_at_least(text,text)') is null
    or to_regprocedure(
      'private.truth_gmail_claims_readiness_parking_receipt_valid_v1(public.truth_gmail_backfill_parking_receipts)'
    ) is null
    or to_regprocedure(
      'private.append_gmail_ingest_page(uuid,text,bigint,jsonb,jsonb,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.commit_source_ingest_batch(uuid,text,bigint,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_materialization_routes_v1(text,uuid)'
    ) is null then
    raise exception 'Gmail cutover-delta reconciliation prerequisites are missing'
      using errcode = '55000';
  end if;
end;
$preflight$;

-- The mode is deliberately distinct from ordinary provider history and from
-- HISTORY_EXPIRED reconciliation.  It is a content-addressed projection of a
-- separately sealed provider scan and therefore must never close a generic
-- HISTORY_EXPIRED gap in private.commit_source_ingest_batch.
alter table public.source_ingest_batches
  drop constraint if exists source_ingest_batches_mode_check;
alter table public.source_ingest_batches
  add constraint source_ingest_batches_mode_check check (mode = any (array[
    'history', 'backfill', 'reconciliation', 'snapshot',
    'snapshot_recovery', 'cutover_delta_reconciliation'
  ]));

-- The immutable model-plan seal records the root batch mode even when its
-- execution mode is Batch.  Preserve every predecessor vocabulary member and
-- admit only this new proof-carrying historical projection.
alter table public.gmail_model_extraction_plans
  drop constraint if exists gmail_model_extraction_plans_root_ingest_mode_check;
alter table public.gmail_model_extraction_plans
  add constraint gmail_model_extraction_plans_root_ingest_mode_check check (
    root_ingest_mode = any (array[
      'history', 'backfill', 'reconciliation', 'snapshot',
      'snapshot_recovery', 'cutover_delta_reconciliation'
    ])
  );

-- Compose the exact discovery-only mode into the active Gmail v2 append
-- authority.  Both reviewed predicates must be present exactly once; drift is
-- a hard migration failure rather than a permissive rewrite.
do $rewrite_append_mode$
declare
  v_signature regprocedure :=
    'private.append_gmail_ingest_page(uuid,text,bigint,jsonb,jsonb,jsonb,text)'::regprocedure;
  v_definition text;
  v_old_spaced text := $old$v_batch.mode in ('backfill', 'reconciliation')$old$;
  v_new_spaced text := $new$v_batch.mode in (
    'backfill', 'reconciliation', 'cutover_delta_reconciliation'
  )$new$;
  v_old_compact text := $old$v_batch.mode in ('backfill','reconciliation')$old$;
  v_new_compact text := $new$v_batch.mode in (
      'backfill','reconciliation','cutover_delta_reconciliation'
    )$new$;
  v_count_spaced integer;
  v_count_compact integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('cutover_delta_reconciliation' in v_definition) = 0 then
    v_count_spaced := (
      length(v_definition) - length(replace(v_definition, v_old_spaced, ''))
    ) / length(v_old_spaced);
    v_count_compact := (
      length(v_definition) - length(replace(v_definition, v_old_compact, ''))
    ) / length(v_old_compact);
    if v_count_spaced is distinct from 1
      or v_count_compact is distinct from 1 then
      raise exception 'Gmail cutover-delta append-mode rewrite was incomplete'
        using errcode = '55000';
    end if;
    v_definition := replace(v_definition, v_old_spaced, v_new_spaced);
    v_definition := replace(v_definition, v_old_compact, v_new_compact);
    execute v_definition;
  end if;
end;
$rewrite_append_mode$;

-- A model-required message from this bounded historical projection is a Batch
-- request, never a parked request.  No claim admission or provider policy is
-- weakened here.
do $rewrite_model_execution_mode$
declare
  v_signature regprocedure :=
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure;
  v_definition text;
  v_old text := $old$when v_batch.mode in ('backfill','reconciliation') then 'batch'$old$;
  v_new text := $new$when v_batch.mode in (
      'backfill','reconciliation','cutover_delta_reconciliation'
    ) then 'batch'$new$;
  v_occurrences integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
    '''backfill'',''reconciliation'',''cutover_delta_reconciliation'''
    in replace(replace(v_definition, ' ', ''), E'\n', '')
  ) = 0 then
    v_occurrences := (
      length(v_definition) - length(replace(v_definition, v_old, ''))
    ) / length(v_old);
    if v_occurrences is distinct from 1 then
      raise exception 'Gmail cutover-delta model execution-mode rewrite was incomplete'
        using errcode = '55000';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_model_execution_mode$;

create unique index if not exists truth_gmail_backfill_parking_receipts_delta_proof_key
  on public.truth_gmail_backfill_parking_receipts(
    receipt_id, receipt_hash, workspace_key, source_system, connection_key,
    parked_batch_id, backfill_gap_id, cutover_delta_gap_id, coordinator_job_id
  );

create table if not exists public.truth_gmail_cutover_delta_plans (
  plan_id text primary key check (
    plan_id ~ '^truth-gmail-cutover-delta-plan:v1:[0-9a-f]{64}$'
  ),
  plan_hash text not null unique check (plan_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  source_system text not null check (source_system = 'gmail'),
  connection_key text not null,
  parking_receipt_id text not null unique,
  parking_receipt_hash text not null check (
    parking_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  parked_batch_id uuid not null unique,
  backfill_gap_id uuid not null unique,
  cutover_delta_gap_id uuid not null unique,
  coordinator_job_id uuid not null unique,
  prior_cursor_value text not null check (prior_cursor_value = '19571223'),
  recovery_anchor_value text not null check (recovery_anchor_value = '19640268'),
  window_start timestamptz not null check (
    window_start = '2026-07-13 00:42:00+00'::timestamptz
  ),
  window_end timestamptz not null check (
    window_end = '2026-07-18 18:03:00+00'::timestamptz
  ),
  provider_account_email text not null check (provider_account_email <> ''),
  strategy text not null check (strategy = any (array[
    'history_retained', 'date_scoped_current_mailbox'
  ])),
  scan_page_count integer not null check (scan_page_count between 1 and 100),
  member_count integer not null check (member_count between 1 and 5000),
  provider_deleted_count integer not null check (
    provider_deleted_count between 0 and member_count
  ),
  canonical_plan jsonb not null check (jsonb_typeof(canonical_plan) = 'object'),
  schema_version text not null check (
    schema_version = 'truth-gmail-cutover-delta-plan-v1'
  ),
  opened_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (
    parking_receipt_id, parking_receipt_hash, workspace_key, source_system,
    connection_key, parked_batch_id, backfill_gap_id, cutover_delta_gap_id,
    coordinator_job_id
  ) references public.truth_gmail_backfill_parking_receipts(
    receipt_id, receipt_hash, workspace_key, source_system, connection_key,
    parked_batch_id, backfill_gap_id, cutover_delta_gap_id, coordinator_job_id
  ) on update restrict on delete restrict,
  foreign key (cutover_delta_gap_id, workspace_key, connection_key)
    references public.gmail_completeness_gaps(
      gap_id, workspace_key, connection_key
    ) on update restrict on delete restrict,
  check (plan_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_plan), 'UTF8'
  ), 'sha256'), 'hex')),
  check (plan_id = 'truth-gmail-cutover-delta-plan:v1:' || plan_hash),
  check (canonical_plan->>'productionPublicationAttempted' = 'false')
);

create table if not exists public.truth_gmail_cutover_delta_members (
  plan_id text not null
    references public.truth_gmail_cutover_delta_plans(plan_id)
    on update restrict on delete restrict,
  member_ordinal integer not null check (member_ordinal >= 0),
  message_id text not null check (message_id <> ''),
  thread_id text not null default '',
  provider_history_id text not null check (provider_history_id ~ '^[0-9]+$'),
  source_event_type text not null check (source_event_type = any (array[
    'message_added', 'message_deleted', 'labels_added', 'labels_removed',
    'message_discovered'
  ])),
  provider_deleted boolean not null,
  canonical_member jsonb not null check (jsonb_typeof(canonical_member) = 'object'),
  member_hash text not null unique check (member_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (
    schema_version = 'truth-gmail-cutover-delta-member-v1'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (plan_id, member_ordinal),
  unique (plan_id, message_id),
  check (member_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_member), 'UTF8'
  ), 'sha256'), 'hex')),
  check (canonical_member->>'memberOrdinal' = member_ordinal::text),
  check (canonical_member->>'messageId' = message_id),
  check (canonical_member->>'threadId' = thread_id),
  check (canonical_member->>'providerHistoryId' = provider_history_id),
  check (canonical_member->>'sourceEventType' = source_event_type),
  check ((canonical_member->>'providerDeleted')::boolean = provider_deleted)
);

create table if not exists public.truth_gmail_cutover_delta_chunks (
  chunk_id text primary key check (
    chunk_id ~ '^truth-gmail-cutover-delta-chunk:v1:[0-9a-f]{64}$'
  ),
  chunk_hash text not null unique check (chunk_hash ~ '^[0-9a-f]{64}$'),
  plan_id text not null
    references public.truth_gmail_cutover_delta_plans(plan_id)
    on update restrict on delete restrict,
  chunk_ordinal integer not null check (chunk_ordinal >= 0),
  first_member_ordinal integer not null check (first_member_ordinal >= 0),
  last_member_ordinal integer not null check (
    last_member_ordinal >= first_member_ordinal
  ),
  member_count integer not null check (
    member_count between 1 and 20
    and member_count = last_member_ordinal - first_member_ordinal + 1
  ),
  adopted_message_count integer not null check (
    adopted_message_count between 0 and member_count
  ),
  provider_deleted_count integer not null check (
    provider_deleted_count = member_count - adopted_message_count
  ),
  root_batch_id uuid not null unique,
  root_batch_hash text not null check (root_batch_hash ~ '^[0-9a-f]{64}$'),
  expected_cursor_version bigint not null check (expected_cursor_version >= 1),
  committed_cursor_version bigint not null check (
    committed_cursor_version = expected_cursor_version + 1
  ),
  committed_cursor_value text not null check (committed_cursor_value ~ '^[0-9]+$'),
  route_seal_id text not null check (
    route_seal_id ~ '^gmail-materialization-route-seal:v1:[0-9a-f]{64}$'
  ),
  route_seal_hash text not null check (route_seal_hash ~ '^[0-9a-f]{64}$'),
  route_count integer not null check (route_count >= 0),
  member_manifest_hash text not null check (
    member_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  canonical_chunk jsonb not null check (jsonb_typeof(canonical_chunk) = 'object'),
  schema_version text not null check (
    schema_version = 'truth-gmail-cutover-delta-chunk-v1'
  ),
  committed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (plan_id, chunk_ordinal),
  unique (plan_id, first_member_ordinal),
  unique (plan_id, last_member_ordinal),
  foreign key (root_batch_id)
    references public.source_ingest_batches(batch_id)
    on update restrict on delete restrict,
  foreign key (route_seal_id)
    references public.gmail_batch_materialization_route_seals(seal_id)
    on update restrict on delete restrict,
  check (chunk_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_chunk), 'UTF8'
  ), 'sha256'), 'hex')),
  check (chunk_id = 'truth-gmail-cutover-delta-chunk:v1:' || chunk_hash),
  check (canonical_chunk->>'productionPublicationAttempted' = 'false')
);

create table if not exists public.truth_gmail_cutover_delta_seals (
  seal_id text primary key check (
    seal_id ~ '^truth-gmail-cutover-delta-seal:v1:[0-9a-f]{64}$'
  ),
  seal_hash text not null unique check (seal_hash ~ '^[0-9a-f]{64}$'),
  plan_id text not null unique
    references public.truth_gmail_cutover_delta_plans(plan_id)
    on update restrict on delete restrict,
  cutover_delta_gap_id uuid not null unique,
  strategy text not null check (strategy = any (array[
    'history_retained', 'date_scoped_current_mailbox'
  ])),
  chunk_count integer not null check (chunk_count > 0),
  member_count integer not null check (member_count > 0),
  adopted_message_count integer not null check (
    adopted_message_count between 1 and member_count
  ),
  provider_deleted_count integer not null check (
    provider_deleted_count = member_count - adopted_message_count
  ),
  root_manifest_hash text not null check (root_manifest_hash ~ '^[0-9a-f]{64}$'),
  parse_manifest_hash text not null check (parse_manifest_hash ~ '^[0-9a-f]{64}$'),
  link_action jsonb not null check (jsonb_typeof(link_action) = 'object'),
  canonical_seal jsonb not null check (jsonb_typeof(canonical_seal) = 'object'),
  schema_version text not null check (
    schema_version = 'truth-gmail-cutover-delta-seal-v1'
  ),
  sealed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (cutover_delta_gap_id)
    references public.gmail_completeness_gaps(gap_id)
    on update restrict on delete restrict,
  check (seal_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_seal), 'UTF8'
  ), 'sha256'), 'hex')),
  check (seal_id = 'truth-gmail-cutover-delta-seal:v1:' || seal_hash),
  check (canonical_seal->>'productionPublicationAttempted' = 'false')
);

create table if not exists public.truth_gmail_cutover_delta_link_retry_authorizations (
  authorization_id text primary key check (
    authorization_id ~ '^truth-gmail-cutover-delta-link-retry:v1:[0-9a-f]{64}$'
  ),
  authorization_hash text not null unique check (
    authorization_hash ~ '^[0-9a-f]{64}$'
  ),
  plan_id text not null unique
    references public.truth_gmail_cutover_delta_plans(plan_id)
    on update restrict on delete restrict,
  original_job_id uuid not null unique
    references public.source_processing_jobs(job_id)
    on update restrict on delete restrict,
  runnable_job_id uuid not null
    references public.source_processing_jobs(job_id)
    on update restrict on delete restrict,
  disposition text not null check (disposition = any (array[
    'retry_exact_current_anchor', 'retry_current_anchor_successor',
    'current_anchor_already_runnable', 'current_anchor_already_succeeded'
  ])),
  canonical_authorization jsonb not null check (
    jsonb_typeof(canonical_authorization) = 'object'
  ),
  schema_version text not null check (
    schema_version = 'truth-gmail-cutover-delta-link-retry-v1'
  ),
  authorized_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (authorization_hash = encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization), 'UTF8'
  ), 'sha256'), 'hex')),
  check (authorization_id =
    'truth-gmail-cutover-delta-link-retry:v1:' || authorization_hash),
  check (canonical_authorization->>'productionPublicationAttempted' = 'false')
);

create index if not exists truth_gmail_cutover_delta_members_message_idx
  on public.truth_gmail_cutover_delta_members(plan_id, message_id);
create index if not exists truth_gmail_cutover_delta_chunks_frontier_idx
  on public.truth_gmail_cutover_delta_chunks(
    plan_id, first_member_ordinal, last_member_ordinal
  );
create index if not exists truth_gmail_cutover_delta_chunks_root_idx
  on public.truth_gmail_cutover_delta_chunks(root_batch_id, plan_id);

do $protect_tables$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_gmail_cutover_delta_plans',
    'truth_gmail_cutover_delta_members',
    'truth_gmail_cutover_delta_chunks',
    'truth_gmail_cutover_delta_seals',
    'truth_gmail_cutover_delta_link_retry_authorizations'
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
      'revoke all on table public.%I from public,anon,authenticated,service_role',
      v_table
    );
    execute format('grant select on table public.%I to service_role', v_table);
  end loop;
end;
$protect_tables$;

create or replace function private.truth_gmail_cutover_delta_critical_messages_v1()
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $function$
  select array[
    '1aa0000000000043',
    '1aa0000000000044',
    '1aa0000000000045',
    '1aa0000000000046',
    '1aa0000000000047',
    '1aa0000000000048',
    '1aa0000000000049',
    '1aa000000000004a'
  ]::text[];
$function$;

create or replace function private.truth_gmail_cutover_delta_gap_boundary_valid_v1(
  p_receipt public.truth_gmail_backfill_parking_receipts,
  p_backfill_gap public.gmail_completeness_gaps,
  p_cutover_gap public.gmail_completeness_gaps
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    private.truth_gmail_claims_readiness_parking_receipt_valid_v1(p_receipt)
    and p_backfill_gap.gap_id = p_receipt.backfill_gap_id
    and p_backfill_gap.workspace_key = 'primary'
    and p_backfill_gap.connection_key = 'primary'
    and p_backfill_gap.gap_type = 'PARKED_BACKFILL_HISTORICAL_DRAIN'
    and p_backfill_gap.status = 'open'
    and p_backfill_gap.recovery_anchor_value =
      p_receipt.persisted_anchor_history_id
    and p_backfill_gap.detected_at = p_receipt.parked_at
    and p_backfill_gap.detail->>'parkingReceiptId' = p_receipt.receipt_id
    and p_backfill_gap.detail->>'parkingReceiptHash' = p_receipt.receipt_hash
    and p_backfill_gap.detail->>'parkedBatchId' =
      p_receipt.parked_batch_id::text
    and p_backfill_gap.detail->>'productionPublicationAttempted' = 'false'
    and p_cutover_gap.gap_id = p_receipt.cutover_delta_gap_id
    and p_cutover_gap.workspace_key = 'primary'
    and p_cutover_gap.connection_key = 'primary'
    and p_cutover_gap.gap_type = 'GMAIL_CUTOVER_DELTA_RECONCILIATION'
    and p_cutover_gap.status = 'open'
    and p_cutover_gap.prior_cursor_value =
      p_receipt.persisted_anchor_history_id
    and p_cutover_gap.recovery_anchor_value = p_receipt.cutover_history_id
    and p_cutover_gap.detected_at = p_receipt.parked_at
    and p_cutover_gap.detail->>'parkingReceiptId' = p_receipt.receipt_id
    and p_cutover_gap.detail->>'parkingReceiptHash' = p_receipt.receipt_hash
    and p_cutover_gap.detail->>'parkedBatchId' =
      p_receipt.parked_batch_id::text
    and p_cutover_gap.detail->>'productionPublicationAttempted' = 'false'
    and p_receipt.canonical_receipt->'completenessGaps' @>
      jsonb_build_array(jsonb_build_object(
        'gapId', p_backfill_gap.gap_id,
        'gapType', p_backfill_gap.gap_type,
        'priorCursorValue', p_backfill_gap.prior_cursor_value,
        'recoveryAnchorValue', p_backfill_gap.recovery_anchor_value
      ))
    and p_receipt.canonical_receipt->'completenessGaps' @>
      jsonb_build_array(jsonb_build_object(
        'gapId', p_cutover_gap.gap_id,
        'gapType', p_cutover_gap.gap_type,
        'priorCursorValue', p_cutover_gap.prior_cursor_value,
        'recoveryAnchorValue', p_cutover_gap.recovery_anchor_value
      )),
    false
  );
$function$;

create or replace function private.truth_gmail_cutover_delta_history_members_v1(
  p_plan jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with raw_events as (
    select history->>'id' as provider_history_id,
           spec.event_type as source_event_type,
           spec.precedence,
           row_value->'message'->>'id' as message_id,
           coalesce(row_value->'message'->>'threadId', '') as thread_id
    from jsonb_array_elements(coalesce(p_plan->'scanPages', '[]'::jsonb)) page
    cross join lateral jsonb_array_elements(coalesce(
      page->'providerResponse'->'history', '[]'::jsonb
    )) history
    cross join lateral (values
      ('messagesAdded'::text, 'message_added'::text, 2),
      ('messagesDeleted'::text, 'message_deleted'::text, 5),
      ('labelsAdded'::text, 'labels_added'::text, 3),
      ('labelsRemoved'::text, 'labels_removed'::text, 4)
    ) spec(field_name, event_type, precedence)
    cross join lateral jsonb_array_elements(coalesce(
      history -> spec.field_name, '[]'::jsonb
    )) row_value
    where history->>'id' ~ '^[0-9]+$'
      and (history->>'id')::numeric > 19571223::numeric
      and (history->>'id')::numeric <= 19640268::numeric
  ), ranked as (
    select raw_events.*,
           row_number() over (
             partition by message_id
             order by provider_history_id::numeric desc,
                      precedence desc,
                      source_event_type desc,
                      thread_id desc
           ) as event_rank
    from raw_events
  ), selected as (
    select message_id, thread_id, provider_history_id, source_event_type,
           source_event_type = 'message_deleted' as provider_deleted
    from ranked
    where event_rank = 1
  ), ordered as (
    select (row_number() over (
             order by message_id, provider_history_id, source_event_type
           ) - 1)::integer as member_ordinal,
           selected.*
    from selected
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberOrdinal', member_ordinal,
    'messageId', message_id,
    'threadId', thread_id,
    'providerHistoryId', provider_history_id,
    'sourceEventType', source_event_type,
    'providerDeleted', provider_deleted
  ) order by member_ordinal), '[]'::jsonb)
  from ordered;
$function$;

create or replace function private.truth_gmail_cutover_delta_date_members_v1(
  p_plan jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with filtered as (
    select metadata->>'messageId' as message_id,
           coalesce(metadata->>'threadId', '') as thread_id,
           metadata->>'providerHistoryId' as provider_history_id
    from jsonb_array_elements(coalesce(
      p_plan->'messageMetadata', '[]'::jsonb
    )) metadata
    where metadata->>'internalDate' ~ '^[0-9]+$'
      and (metadata->>'internalDate')::numeric >= 1783903320000::numeric
      and (metadata->>'internalDate')::numeric < 1784397780000::numeric
  ), distinct_messages as (
    select distinct on (message_id)
           message_id, thread_id, provider_history_id
    from filtered
    order by message_id, provider_history_id::numeric desc, thread_id desc
  ), ordered as (
    select (row_number() over (
             order by message_id, provider_history_id
           ) - 1)::integer as member_ordinal,
           distinct_messages.*
    from distinct_messages
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberOrdinal', member_ordinal,
    'messageId', message_id,
    'threadId', thread_id,
    'providerHistoryId', provider_history_id,
    'sourceEventType', 'message_discovered',
    'providerDeleted', false
  ) order by member_ordinal), '[]'::jsonb)
  from ordered;
$function$;

revoke all on function
  private.truth_gmail_cutover_delta_critical_messages_v1()
  from public, anon, authenticated, service_role;
revoke all on function
  private.truth_gmail_cutover_delta_gap_boundary_valid_v1(
    public.truth_gmail_backfill_parking_receipts,
    public.gmail_completeness_gaps,
    public.gmail_completeness_gaps
  ) from public, anon, authenticated, service_role;
revoke all on function
  private.truth_gmail_cutover_delta_history_members_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function
  private.truth_gmail_cutover_delta_date_members_v1(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.open_truth_gmail_cutover_delta_reconciliation_v1(
  p_plan jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_backfill_gap public.gmail_completeness_gaps%rowtype;
  v_delta_gap public.gmail_completeness_gaps%rowtype;
  v_existing public.truth_gmail_cutover_delta_plans%rowtype;
  v_strategy text;
  v_expected_members jsonb;
  v_plan_hash text;
  v_plan_id text;
  v_scan_page_count integer;
  v_member_count integer;
  v_deleted_count integer;
  v_opened_at timestamptz := clock_timestamp();
  v_page_chain_valid boolean;
  v_scan_message_count integer;
  v_metadata_count integer;
  v_metadata_distinct_count integer;
  v_critical_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if jsonb_typeof(coalesce(p_plan, 'null'::jsonb)) is distinct from 'object'
    or not private.truth_jsonb_has_only_keys(p_plan, array[
      'schemaVersion', 'authorityVersion', 'workspaceKey', 'connectionKey',
      'parkingReceiptId', 'parkingReceiptHash', 'parkedBatchId',
      'priorCursorValue', 'recoveryAnchorValue', 'windowStartInclusive',
      'windowEndExclusive', 'accountEmail', 'strategy', 'historyAttempt',
      'profileEvidence', 'scanPages', 'messageMetadata', 'members',
      'criticalMessageIds', 'dateQuery', 'includeSpamTrash',
      'productionPublicationAttempted'
    ])
    or (select count(*) from jsonb_object_keys(p_plan)) <> 22
    or p_plan->>'schemaVersion' is distinct from
      'truth-gmail-cutover-delta-plan-input-v1'
    or p_plan->>'authorityVersion' is distinct from
      'truth-gmail-cutover-delta-reconciliation-v1'
    or p_plan->>'workspaceKey' is distinct from 'primary'
    or p_plan->>'connectionKey' is distinct from 'primary'
    or p_plan->>'parkedBatchId' is distinct from
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'
    or p_plan->>'priorCursorValue' is distinct from '19571223'
    or p_plan->>'recoveryAnchorValue' is distinct from '19640268'
    or p_plan->>'windowStartInclusive' is distinct from
      '2026-07-13T00:42:00.000Z'
    or p_plan->>'windowEndExclusive' is distinct from
      '2026-07-18T18:03:00.000Z'
    or p_plan->>'productionPublicationAttempted' is distinct from 'false'
    or jsonb_typeof(p_plan->'historyAttempt') is distinct from 'object'
    or jsonb_typeof(p_plan->'profileEvidence') is distinct from 'object'
    or jsonb_typeof(p_plan->'scanPages') is distinct from 'array'
    or jsonb_typeof(p_plan->'messageMetadata') is distinct from 'array'
    or jsonb_typeof(p_plan->'members') is distinct from 'array'
    or p_plan->'criticalMessageIds' is distinct from to_jsonb(
      private.truth_gmail_cutover_delta_critical_messages_v1()
    ) then
    raise exception 'Gmail cutover-delta plan envelope is invalid'
      using errcode = '22023';
  end if;

  select * into strict v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.workspace_key = 'primary'
    and receipt.source_system = 'gmail'
    and receipt.connection_key = 'primary'
    and receipt.parked_batch_id =
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
  if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
    v_receipt
  )
    or p_plan->>'parkingReceiptId' is distinct from v_receipt.receipt_id
    or p_plan->>'parkingReceiptHash' is distinct from v_receipt.receipt_hash
    or lower(p_plan->>'accountEmail') is distinct from
      lower(v_receipt.provider_account_email)
    or lower(p_plan#>>'{profileEvidence,emailAddress}') is distinct from
      lower(v_receipt.provider_account_email)
    or coalesce(p_plan#>>'{profileEvidence,historyId}', '') !~ '^[0-9]+$'
    or not private.gmail_history_id_at_least(
      p_plan#>>'{profileEvidence,historyId}', v_receipt.cutover_history_id
    ) then
    raise exception 'Gmail cutover-delta plan differs from parking receipt'
      using errcode = '23514';
  end if;

  select * into strict v_backfill_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_receipt.backfill_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary';
  select * into strict v_delta_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_receipt.cutover_delta_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary'
  for update;
  if not private.truth_gmail_cutover_delta_gap_boundary_valid_v1(
      v_receipt, v_backfill_gap, v_delta_gap
    )
    or v_backfill_gap.gap_type is distinct from
      'PARKED_BACKFILL_HISTORICAL_DRAIN'
    or v_backfill_gap.status is distinct from 'open'
    or v_delta_gap.gap_type is distinct from
      'GMAIL_CUTOVER_DELTA_RECONCILIATION'
    or v_delta_gap.status is distinct from 'open'
    or v_delta_gap.prior_cursor_value is distinct from
      v_receipt.persisted_anchor_history_id
    or v_delta_gap.recovery_anchor_value is distinct from
      v_receipt.cutover_history_id
    or v_delta_gap.detail->>'parkingReceiptId' is distinct from
      v_receipt.receipt_id
    or v_delta_gap.detail->>'parkingReceiptHash' is distinct from
      v_receipt.receipt_hash then
    raise exception 'Gmail cutover-delta gap authority is not exactly open'
      using errcode = '23514';
  end if;

  v_strategy := p_plan->>'strategy';
  v_scan_page_count := jsonb_array_length(p_plan->'scanPages');
  v_member_count := jsonb_array_length(p_plan->'members');
  if v_strategy not in ('history_retained', 'date_scoped_current_mailbox')
    or v_scan_page_count < 1 or v_scan_page_count > 100
    or v_member_count < 1 or v_member_count > 5000
    or exists (
      select 1
      from jsonb_array_elements(p_plan->'scanPages') page
      where jsonb_typeof(page) is distinct from 'object'
        or coalesce(page->>'pageOrdinal', '') !~ '^[0-9]+$'
        or jsonb_typeof(page->'providerResponse') is distinct from 'object'
        or coalesce(page->>'providerResponseHash', '') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(page->'isFinal') is distinct from 'boolean'
        or page->>'providerResponseHash' is distinct from encode(
          extensions.digest(convert_to(private.truth_canonical_json_text(
            page->'providerResponse'
          ), 'UTF8'), 'sha256'), 'hex'
        )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_plan->'members') with ordinality member(value, ordinal)
      where jsonb_typeof(value) is distinct from 'object'
        or not private.truth_jsonb_has_only_keys(value, array[
          'memberOrdinal', 'messageId', 'threadId', 'providerHistoryId',
          'sourceEventType', 'providerDeleted'
        ])
        or (select count(*) from jsonb_object_keys(value)) <> 6
        or coalesce(value->>'memberOrdinal', '') !~ '^[0-9]+$'
        or (value->>'memberOrdinal')::integer <> ordinal - 1
        or nullif(value->>'messageId', '') is null
        or coalesce(value->>'providerHistoryId', '') !~ '^[0-9]+$'
        or jsonb_typeof(value->'providerDeleted') is distinct from 'boolean'
    )
    or (select count(distinct value->>'messageId')
        from jsonb_array_elements(p_plan->'members') value) <> v_member_count then
    raise exception 'Gmail cutover-delta scan or member manifest is invalid'
      using errcode = '23514';
  end if;

  -- Page ordinals and tokens are proved as one complete provider chain.  Raw
  -- provider pages are retained in canonical_plan; bounded roots below are
  -- projections and never masquerade as the original provider response.
  with pages as (
    select page.value,
           page.ordinality::integer - 1 as expected_ordinal,
           lag(coalesce(page.value->>'responseNextPageToken', '')) over (
             order by page.ordinality
           ) as prior_next_token
    from jsonb_array_elements(p_plan->'scanPages') with ordinality page
  )
  select bool_and(
    (value->>'pageOrdinal')::integer = expected_ordinal
    and (
      (expected_ordinal = 0 and coalesce(value->>'requestPageToken', '') = '')
      or
      (expected_ordinal > 0 and coalesce(value->>'requestPageToken', '') =
        prior_next_token)
    )
    and coalesce(value->>'responseNextPageToken', '') =
      coalesce(value#>>'{providerResponse,nextPageToken}', '')
    and (
      ((value->>'isFinal')::boolean
        and expected_ordinal = v_scan_page_count - 1
        and coalesce(value->>'responseNextPageToken', '') = '')
      or
      (not (value->>'isFinal')::boolean
        and expected_ordinal < v_scan_page_count - 1
        and coalesce(value->>'responseNextPageToken', '') <> '')
    )
  ) into v_page_chain_valid
  from pages;
  if not coalesce(v_page_chain_valid, false) then
    raise exception 'Gmail cutover-delta provider page chain is incomplete'
      using errcode = '23514';
  end if;

  if v_strategy = 'history_retained' then
    if p_plan#>>'{historyAttempt,status}' is distinct from 'complete'
      or p_plan#>>'{historyAttempt,startHistoryId}' is distinct from '19571223'
      or p_plan->>'dateQuery' is distinct from ''
      or p_plan->>'includeSpamTrash' is distinct from 'false'
      or p_plan->'messageMetadata' is distinct from '[]'::jsonb
      or exists (
        select 1
        from jsonb_array_elements(p_plan->'scanPages') page
        where coalesce(page#>>'{providerResponse,historyId}', '') !~ '^[0-9]+$'
          or not private.gmail_history_id_at_least(
            page#>>'{providerResponse,historyId}', '19640268'
          )
          or jsonb_typeof(coalesce(
            page->'providerResponse'->'history', '[]'::jsonb
          )) is distinct from 'array'
      )
      or exists (
        select 1
        from jsonb_array_elements(p_plan->'scanPages') page
        cross join lateral jsonb_array_elements(coalesce(
          page->'providerResponse'->'history', '[]'::jsonb
        )) history
        where coalesce(history->>'id', '') !~ '^[0-9]+$'
      ) then
      raise exception 'retained Gmail history proof is invalid'
        using errcode = '23514';
    end if;
    v_expected_members :=
      private.truth_gmail_cutover_delta_history_members_v1(p_plan);
  else
    if p_plan#>>'{historyAttempt,status}' is distinct from 'expired'
      or p_plan#>>'{historyAttempt,startHistoryId}' is distinct from '19571223'
      or p_plan#>>'{historyAttempt,errorCode}' is distinct from
        'GMAIL_HISTORY_CURSOR_EXPIRED'
      or p_plan->>'dateQuery' is distinct from
        'after:1783903319 before:1784397781'
      or p_plan->>'includeSpamTrash' is distinct from 'true'
      or jsonb_array_length(p_plan->'messageMetadata') < 1
      or exists (
        select 1
        from jsonb_array_elements(p_plan->'messageMetadata') metadata
        where jsonb_typeof(metadata) is distinct from 'object'
          or not private.truth_jsonb_has_only_keys(metadata, array[
            'messageId', 'threadId', 'providerHistoryId', 'internalDate',
            'metadataHash'
          ])
          or (select count(*) from jsonb_object_keys(metadata)) <> 5
          or nullif(metadata->>'messageId', '') is null
          or coalesce(metadata->>'providerHistoryId', '') !~ '^[0-9]+$'
          or coalesce(metadata->>'internalDate', '') !~ '^[0-9]+$'
          or coalesce(metadata->>'metadataHash', '') !~ '^[0-9a-f]{64}$'
          or metadata->>'metadataHash' is distinct from encode(
            extensions.digest(convert_to(private.truth_canonical_json_text(
              metadata - 'metadataHash'
            ), 'UTF8'), 'sha256'), 'hex'
          )
      ) then
      raise exception 'date-scoped Gmail metadata proof is invalid'
        using errcode = '23514';
    end if;
    select count(*)::integer,
           count(distinct metadata->>'messageId')::integer
    into v_metadata_count, v_metadata_distinct_count
    from jsonb_array_elements(p_plan->'messageMetadata') metadata;
    select count(distinct message->>'id')::integer
    into v_scan_message_count
    from jsonb_array_elements(p_plan->'scanPages') page
    cross join lateral jsonb_array_elements(coalesce(
      page->'providerResponse'->'messages', '[]'::jsonb
    )) message;
    if v_metadata_count is distinct from v_metadata_distinct_count
      or v_metadata_count is distinct from v_scan_message_count
      or exists (
        select 1
        from jsonb_array_elements(p_plan->'messageMetadata') metadata
        where not exists (
          select 1
          from jsonb_array_elements(p_plan->'scanPages') page
          cross join lateral jsonb_array_elements(coalesce(
            page->'providerResponse'->'messages', '[]'::jsonb
          )) message
          where message->>'id' = metadata->>'messageId'
            and coalesce(message->>'threadId', '') =
              coalesce(metadata->>'threadId', '')
        )
      ) then
      raise exception 'date-scoped Gmail scan and metadata sets differ'
        using errcode = '23514';
    end if;
    v_expected_members :=
      private.truth_gmail_cutover_delta_date_members_v1(p_plan);
  end if;

  if p_plan->'members' is distinct from v_expected_members then
    raise exception 'Gmail cutover-delta members are not the exact provider projection'
      using errcode = '23514';
  end if;
  select count(*)::integer into v_critical_count
  from unnest(private.truth_gmail_cutover_delta_critical_messages_v1()) critical(message_id)
  where exists (
    select 1
    from jsonb_array_elements(v_expected_members) member
    where member->>'messageId' = critical.message_id
      and member->>'providerDeleted' = 'false'
  );
  if v_critical_count is distinct from 8 then
    raise exception 'Gmail cutover-delta scan omits a required backtest message'
      using errcode = '23514';
  end if;

  v_plan_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(p_plan), 'UTF8'
  ), 'sha256'), 'hex');
  v_plan_id := 'truth-gmail-cutover-delta-plan:v1:' || v_plan_hash;
  select * into v_existing
  from public.truth_gmail_cutover_delta_plans plan
  where plan.parking_receipt_id = v_receipt.receipt_id;
  if found then
    if v_existing.plan_id is distinct from v_plan_id
      or v_existing.canonical_plan is distinct from p_plan then
      raise exception 'Gmail cutover-delta plan conflicts with sealed provider proof'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true, 'status', 'already_planned', 'planId', v_existing.plan_id,
      'planHash', v_existing.plan_hash, 'strategy', v_existing.strategy,
      'memberCount', v_existing.member_count,
      'providerDeletedCount', v_existing.provider_deleted_count,
      'productionPublicationAttempted', false
    );
  end if;

  select count(*) filter (where value->>'providerDeleted' = 'true')::integer
  into v_deleted_count
  from jsonb_array_elements(v_expected_members) value;
  insert into public.truth_gmail_cutover_delta_plans(
    plan_id, plan_hash, workspace_key, source_system, connection_key,
    parking_receipt_id, parking_receipt_hash, parked_batch_id,
    backfill_gap_id, cutover_delta_gap_id, coordinator_job_id,
    prior_cursor_value, recovery_anchor_value, window_start, window_end,
    provider_account_email, strategy, scan_page_count, member_count,
    provider_deleted_count, canonical_plan, schema_version, opened_at, created_at
  ) values (
    v_plan_id, v_plan_hash, 'primary', 'gmail', 'primary',
    v_receipt.receipt_id, v_receipt.receipt_hash, v_receipt.parked_batch_id,
    v_receipt.backfill_gap_id, v_receipt.cutover_delta_gap_id,
    v_receipt.coordinator_job_id,
    v_receipt.persisted_anchor_history_id, v_receipt.cutover_history_id,
    '2026-07-13 00:42:00+00'::timestamptz,
    '2026-07-18 18:03:00+00'::timestamptz,
    lower(v_receipt.provider_account_email), v_strategy, v_scan_page_count,
    v_member_count, v_deleted_count, p_plan,
    'truth-gmail-cutover-delta-plan-v1', v_opened_at, v_opened_at
  );
  insert into public.truth_gmail_cutover_delta_members(
    plan_id, member_ordinal, message_id, thread_id, provider_history_id,
    source_event_type, provider_deleted, canonical_member, member_hash,
    schema_version, created_at
  )
  select v_plan_id,
         (member->>'memberOrdinal')::integer,
         member->>'messageId',
         coalesce(member->>'threadId', ''),
         member->>'providerHistoryId',
         member->>'sourceEventType',
         (member->>'providerDeleted')::boolean,
         member,
         encode(extensions.digest(convert_to(
           private.truth_canonical_json_text(member), 'UTF8'
         ), 'sha256'), 'hex'),
         'truth-gmail-cutover-delta-member-v1',
         v_opened_at
  from jsonb_array_elements(v_expected_members) member
  order by (member->>'memberOrdinal')::integer;

  update public.gmail_completeness_gaps
  set detail = detail || jsonb_build_object(
    'deltaReconciliationPlanId', v_plan_id,
    'deltaReconciliationPlanHash', v_plan_hash,
    'deltaReconciliationStrategy', v_strategy,
    'deltaReconciliationMemberCount', v_member_count,
    'deltaReconciliationAdoptedCount', 0,
    'deltaReconciliationProviderDeletedCount', v_deleted_count,
    'deltaReconciliationUpdatedAt',
      private.canonical_truth_timestamp(v_opened_at),
    'productionPublicationAttempted', false
  )
  where gap_id = v_receipt.cutover_delta_gap_id
    and status = 'open';

  return jsonb_build_object(
    'ok', true, 'status', 'planned', 'planId', v_plan_id,
    'planHash', v_plan_hash, 'strategy', v_strategy,
    'scanPageCount', v_scan_page_count, 'memberCount', v_member_count,
    'providerDeletedCount', v_deleted_count,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.open_truth_gmail_cutover_delta_reconciliation(
  p_plan jsonb,
  p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.open_truth_gmail_cutover_delta_reconciliation_v1(
    p_plan, p_sync_token
  );
$function$;

create or replace function private.read_truth_gmail_cutover_delta_reconciliation_v1(
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_plan public.truth_gmail_cutover_delta_plans%rowtype;
  v_seal public.truth_gmail_cutover_delta_seals%rowtype;
  v_delta_gap public.gmail_completeness_gaps%rowtype;
  v_backfill_gap public.gmail_completeness_gaps%rowtype;
  v_chunk_count integer := 0;
  v_chunked_count integer := 0;
  v_adopted_count integer := 0;
  v_status text := 'unplanned';
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into strict v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.workspace_key = 'primary'
    and receipt.source_system = 'gmail'
    and receipt.connection_key = 'primary'
    and receipt.parked_batch_id =
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
  if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
    v_receipt
  ) then
    raise exception 'Gmail cutover-delta parking receipt failed read-back'
      using errcode = '23514';
  end if;
  select * into strict v_delta_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_receipt.cutover_delta_gap_id;
  select * into strict v_backfill_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_receipt.backfill_gap_id;
  if v_delta_gap.status = 'open' and not
      private.truth_gmail_cutover_delta_gap_boundary_valid_v1(
        v_receipt, v_backfill_gap, v_delta_gap
      ) then
    raise exception 'Gmail cutover-delta gap boundary failed read-back'
      using errcode = '23514';
  end if;
  select * into v_plan
  from public.truth_gmail_cutover_delta_plans plan
  where plan.parking_receipt_id = v_receipt.receipt_id;
  if found then
    select count(*)::integer,
           coalesce(sum(chunk.member_count), 0)::integer,
           coalesce(sum(chunk.adopted_message_count), 0)::integer
    into v_chunk_count, v_chunked_count, v_adopted_count
    from public.truth_gmail_cutover_delta_chunks chunk
    where chunk.plan_id = v_plan.plan_id;
    select * into v_seal
    from public.truth_gmail_cutover_delta_seals seal
    where seal.plan_id = v_plan.plan_id;
    v_status := case
      when found then 'finalized'
      when v_chunked_count = v_plan.member_count then 'ready_to_finalize'
      when v_chunked_count > 0 then 'chunking'
      else 'planned'
    end;
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'workspaceKey', 'primary',
    'connectionKey', 'primary',
    'providerAccountEmail', lower(v_receipt.provider_account_email),
    'parkingReceiptId', v_receipt.receipt_id,
    'parkingReceiptHash', v_receipt.receipt_hash,
    'parkedBatchId', v_receipt.parked_batch_id,
    'priorCursorValue', v_receipt.persisted_anchor_history_id,
    'recoveryAnchorValue', v_receipt.cutover_history_id,
    'windowStartInclusive', '2026-07-13T00:42:00.000Z',
    'windowEndExclusive', '2026-07-18T18:03:00.000Z',
    'planId', v_plan.plan_id,
    'planHash', v_plan.plan_hash,
    'strategy', v_plan.strategy,
    'memberCount', coalesce(v_plan.member_count, 0),
    'providerDeletedCount', coalesce(v_plan.provider_deleted_count, 0),
    'chunkCount', v_chunk_count,
    'chunkedMemberCount', v_chunked_count,
    'adoptedMessageCount', v_adopted_count,
    'nextMemberOrdinal', v_chunked_count,
    'deltaGapId', v_receipt.cutover_delta_gap_id,
    'deltaGapStatus', v_delta_gap.status,
    'historicalGapId', v_receipt.backfill_gap_id,
    'historicalGapStatus', v_backfill_gap.status,
    'sealId', v_seal.seal_id,
    'sealHash', v_seal.seal_hash,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_truth_gmail_cutover_delta_reconciliation(
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_truth_gmail_cutover_delta_reconciliation_v1(p_sync_token);
$function$;

create or replace function private.run_truth_gmail_cutover_delta_reconciliation_chunk_v1(
  p_plan_id text,
  p_expected_member_ordinal integer,
  p_limit integer,
  p_worker_id text,
  p_max_nonterminal_jobs integer,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_plan public.truth_gmail_cutover_delta_plans%rowtype;
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_delta_gap public.gmail_completeness_gaps%rowtype;
  v_backfill_gap public.gmail_completeness_gaps%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_route public.gmail_batch_materialization_route_seals%rowtype;
  v_existing public.truth_gmail_cutover_delta_chunks%rowtype;
  v_member_manifest jsonb;
  v_member_manifest_hash text;
  v_messages jsonb;
  v_provider_response jsonb;
  v_provider_events jsonb;
  v_observations jsonb;
  v_append_receipt jsonb;
  v_commit_receipt jsonb;
  v_route_receipt jsonb;
  v_batch_id uuid;
  v_batch_seed_hash text;
  v_chunk_body jsonb;
  v_chunk_hash text;
  v_chunk_id text;
  v_now timestamptz := clock_timestamp();
  v_next_member integer;
  v_member_count integer;
  v_adopted_count integer;
  v_deleted_count integer;
  v_chunk_ordinal integer;
  v_nonterminal_count integer;
  v_lease_fence bigint;
  v_lock_acquired boolean;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if coalesce(p_plan_id, '') !~
      '^truth-gmail-cutover-delta-plan:v1:[0-9a-f]{64}$'
    or p_expected_member_ordinal is null
    or p_expected_member_ordinal < 0
    or p_limit is null or p_limit < 1 or p_limit > 20
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or length(p_worker_id) > 200
    or p_max_nonterminal_jobs is null
    or p_max_nonterminal_jobs < 1
    or p_max_nonterminal_jobs > 500 then
    raise exception 'Gmail cutover-delta chunk request is invalid'
      using errcode = '22023';
  end if;
  select * into strict v_plan
  from public.truth_gmail_cutover_delta_plans plan
  where plan.plan_id = p_plan_id
    and plan.workspace_key = 'primary'
    and plan.source_system = 'gmail'
    and plan.connection_key = 'primary';
  if v_plan.plan_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_plan.canonical_plan), 'UTF8'
    ), 'sha256'), 'hex')
    or v_plan.plan_id is distinct from
      'truth-gmail-cutover-delta-plan:v1:' || v_plan.plan_hash then
    raise exception 'Gmail cutover-delta plan failed canonical read-back'
      using errcode = '23514';
  end if;
  select * into strict v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.receipt_id = v_plan.parking_receipt_id
    and receipt.receipt_hash = v_plan.parking_receipt_hash;
  if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
    v_receipt
  ) then
    raise exception 'Gmail cutover-delta parking receipt failed chunk read-back'
      using errcode = '23514';
  end if;
  select * into strict v_delta_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_plan.cutover_delta_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary';
  select * into strict v_backfill_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_plan.backfill_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary';
  if not private.truth_gmail_cutover_delta_gap_boundary_valid_v1(
      v_receipt, v_backfill_gap, v_delta_gap
    )
    or v_delta_gap.gap_type is distinct from
      'GMAIL_CUTOVER_DELTA_RECONCILIATION'
    or v_delta_gap.status is distinct from 'open' then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'CUTOVER_DELTA_GAP_NOT_OPEN', 'planId', p_plan_id,
      'productionPublicationAttempted', false
    );
  end if;
  if exists (
    select 1 from public.truth_gmail_cutover_delta_seals seal
    where seal.plan_id = p_plan_id
  ) then
    return jsonb_build_object(
      'ok', true, 'status', 'already_finalized', 'retryable', false,
      'planId', p_plan_id, 'productionPublicationAttempted', false
    );
  end if;

  select * into v_existing
  from public.truth_gmail_cutover_delta_chunks chunk
  where chunk.plan_id = p_plan_id
    and chunk.first_member_ordinal = p_expected_member_ordinal;
  if found then
    return jsonb_build_object(
      'ok', true, 'status', 'already_committed', 'retryable', false,
      'planId', p_plan_id, 'chunkId', v_existing.chunk_id,
      'chunkHash', v_existing.chunk_hash,
      'rootBatchId', v_existing.root_batch_id,
      'firstMemberOrdinal', v_existing.first_member_ordinal,
      'lastMemberOrdinal', v_existing.last_member_ordinal,
      'memberCount', v_existing.member_count,
      'adoptedMessageCount', v_existing.adopted_message_count,
      'providerDeletedCount', v_existing.provider_deleted_count,
      'committedCursorVersion', v_existing.committed_cursor_version,
      'committedCursorValue', v_existing.committed_cursor_value,
      'routeCount', v_existing.route_count,
      'productionPublicationAttempted', false
    );
  end if;

  select coalesce(sum(chunk.member_count), 0)::integer,
         count(*)::integer
  into v_next_member, v_chunk_ordinal
  from public.truth_gmail_cutover_delta_chunks chunk
  where chunk.plan_id = p_plan_id;
  if p_expected_member_ordinal is distinct from v_next_member then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'CUTOVER_DELTA_MEMBER_SEQUENCE_MISMATCH',
      'planId', p_plan_id,
      'requestedMemberOrdinal', p_expected_member_ordinal,
      'nextMemberOrdinal', v_next_member,
      'productionPublicationAttempted', false
    );
  end if;
  if v_next_member >= v_plan.member_count then
    return jsonb_build_object(
      'ok', true, 'status', 'ready_to_finalize', 'retryable', false,
      'planId', p_plan_id, 'memberCount', v_plan.member_count,
      'productionPublicationAttempted', false
    );
  end if;

  select count(*)::integer into v_nonterminal_count
  from (
    select 1
    from public.truth_gmail_cutover_delta_chunks prior_chunk
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = 'primary'
     and lineage.source_system = 'gmail'
     and lineage.connection_key = 'primary'
     and lineage.root_batch_id = prior_chunk.root_batch_id
    join public.source_processing_jobs job
      on job.workspace_key = lineage.workspace_key
     and job.job_id = lineage.job_id
     and job.state not in ('succeeded', 'superseded')
    where prior_chunk.plan_id = p_plan_id
    limit p_max_nonterminal_jobs + 1
  ) bounded;
  if v_nonterminal_count >= p_max_nonterminal_jobs then
    return jsonb_build_object(
      'ok', true, 'status', 'backpressure', 'retryable', true,
      'reason', 'CUTOVER_DELTA_NONTERMINAL_JOB_CAP_REACHED',
      'planId', p_plan_id,
      'nonterminalJobCountAtLeast', v_nonterminal_count,
      'maxNonterminalJobs', p_max_nonterminal_jobs,
      'productionPublicationAttempted', false
    );
  end if;

  v_lock_acquired := pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:primary', 0
  ));
  if not v_lock_acquired then
    return jsonb_build_object(
      'ok', true, 'status', 'busy', 'retryable', true,
      'reason', 'SOURCE_CUT_SERIALIZATION_BUSY', 'planId', p_plan_id,
      'productionPublicationAttempted', false
    );
  end if;
  begin
    select * into strict v_cursor
    from public.source_cursors cursor_row
    where cursor_row.workspace_key = 'primary'
      and cursor_row.source_system = 'gmail'
      and cursor_row.connection_key = 'primary'
    for update nowait;
  exception
    when lock_not_available then
      return jsonb_build_object(
        'ok', true, 'status', 'busy', 'retryable', true,
        'reason', 'GMAIL_CURSOR_LOCK_BUSY', 'planId', p_plan_id,
        'productionPublicationAttempted', false
      );
  end;
  if v_cursor.status is distinct from 'live'
    or v_cursor.cursor_kind is distinct from 'gmail_history_id'
    or v_cursor.cursor_value !~ '^[0-9]+$'
    or not private.gmail_history_id_at_least(
      v_cursor.cursor_value, v_plan.recovery_anchor_value
    ) then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'LIVE_GMAIL_CURSOR_PRECEDES_RECOVERY_ANCHOR',
      'planId', p_plan_id, 'cursorValue', v_cursor.cursor_value,
      'productionPublicationAttempted', false
    );
  end if;
  if v_cursor.lease_owner is not null
    and v_cursor.lease_expires_at is not null
    and v_cursor.lease_expires_at > v_now then
    return jsonb_build_object(
      'ok', true, 'status', 'busy', 'retryable', true,
      'reason', 'GMAIL_CURSOR_LEASE_ACTIVE', 'planId', p_plan_id,
      'leaseOwner', v_cursor.lease_owner,
      'leaseExpiresAt', private.canonical_truth_timestamp(
        v_cursor.lease_expires_at
      ),
      'productionPublicationAttempted', false
    );
  end if;
  if exists (
    select 1
    from public.source_ingest_batches running
    where running.workspace_key = 'primary'
      and running.source_system = 'gmail'
      and running.connection_key = 'primary'
      and running.status = 'running'
  ) then
    return jsonb_build_object(
      'ok', true, 'status', 'busy', 'retryable', true,
      'reason', 'GMAIL_RUNNING_BATCH_PRESENT', 'planId', p_plan_id,
      'productionPublicationAttempted', false
    );
  end if;

  select coalesce(jsonb_agg(member.canonical_member
           order by member.member_ordinal), '[]'::jsonb),
         count(*)::integer,
         count(*) filter (where not member.provider_deleted)::integer,
         count(*) filter (where member.provider_deleted)::integer
  into v_member_manifest, v_member_count, v_adopted_count, v_deleted_count
  from (
    select *
    from public.truth_gmail_cutover_delta_members member
    where member.plan_id = p_plan_id
      and member.member_ordinal >= v_next_member
    order by member.member_ordinal
    limit p_limit
  ) member;
  if v_member_count < 1 or v_member_count > 20 then
    raise exception 'Gmail cutover-delta bounded member selection failed'
      using errcode = '23514';
  end if;
  v_member_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_member_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_batch_seed_hash := encode(extensions.digest(convert_to(
    'truth-gmail-cutover-delta-batch-v1:' || p_plan_id || ':' ||
      v_next_member::text || ':' ||
      (v_next_member + v_member_count - 1)::text,
    'UTF8'
  ), 'sha256'), 'hex');
  v_batch_id := private.truth_deterministic_uuid_v1(v_batch_seed_hash);
  v_lease_fence := v_cursor.lease_fence + 1;

  update public.source_cursors
  set lease_owner = p_worker_id,
      lease_fence = v_lease_fence,
      lease_expires_at = v_now + interval '120 seconds',
      updated_at = v_now
  where workspace_key = 'primary'
    and source_system = 'gmail'
    and connection_key = 'primary'
    and cursor_version = v_cursor.cursor_version
    and cursor_value = v_cursor.cursor_value;
  if not found then
    raise exception 'Gmail cutover-delta lease compare-and-swap failed'
      using errcode = '40001';
  end if;
  insert into public.source_ingest_batches(
    batch_id, workspace_key, source_system, connection_key, mode,
    trigger_name, expected_cursor_version, expected_cursor_value,
    lease_owner, lease_fence, status, started_at
  ) values (
    v_batch_id, 'primary', 'gmail', 'primary',
    'cutover_delta_reconciliation',
    'truth-gmail-cutover-delta-reconciliation-v1',
    v_cursor.cursor_version, v_cursor.cursor_value,
    p_worker_id, v_lease_fence, 'running', v_now
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', member.message_id,
    'threadId', member.thread_id
  ) order by member.message_id), '[]'::jsonb)
  into v_messages
  from public.truth_gmail_cutover_delta_members member
  where member.plan_id = p_plan_id
    and member.member_ordinal between v_next_member
      and v_next_member + v_member_count - 1
    and not member.provider_deleted;
  v_provider_response := jsonb_build_object(
    'historyId', v_cursor.cursor_value,
    'history', '[]'::jsonb,
    'messages', v_messages,
    'nextPageToken', ''
  );
  with payloads as (
    select jsonb_build_object(
      'schemaVersion', 'gmail-mailbox-discovery-event-v1',
      'eventType', 'message_discovered',
      'historyId', v_cursor.cursor_value,
      'messageId', member.message_id,
      'threadId', member.thread_id,
      'discoveryMode', 'cutover_delta_reconciliation'
    ) as payload
    from public.truth_gmail_cutover_delta_members member
    where member.plan_id = p_plan_id
      and member.member_ordinal between v_next_member
        and v_next_member + v_member_count - 1
      and not member.provider_deleted
  ), events as (
    select jsonb_build_object(
      'eventId', 'gmail-event:v1:' || encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(payload), 'UTF8'
      ), 'sha256'), 'hex')
    ) || payload as event
    from payloads
  )
  select coalesce(jsonb_agg(event order by event->>'eventId'), '[]'::jsonb)
  into v_provider_events
  from events;
  with payloads as (
    select event as normalized_payload,
           encode(extensions.digest(convert_to(
             private.truth_canonical_json_text(event), 'UTF8'
           ), 'sha256'), 'hex') as content_hash
    from jsonb_array_elements(v_provider_events) event
  ), shaped as (
    select normalized_payload,
           content_hash,
           'discovery:cutover_delta_reconciliation:' ||
             v_cursor.cursor_value || ':' || content_hash as source_revision
    from payloads
  ), identified as (
    select shaped.*,
           jsonb_build_object(
             'schemaVersion', 'source-observation-identity-v1',
             'workspaceKey', 'primary',
             'sourceSystem', 'gmail',
             'connectionKey', 'primary',
             'sourceObjectType', 'gmail_message_discovery_event',
             'sourceObjectId', normalized_payload->>'messageId',
             'sourceRevision', source_revision,
             'operation', 'metadata_change',
             'contentHash', content_hash
           ) as identity
    from shaped
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'observationId', 'obs:v1:' || encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(identity), 'UTF8'
    ), 'sha256'), 'hex'),
    'sourceObjectType', 'gmail_message_discovery_event',
    'sourceObjectId', normalized_payload->>'messageId',
    'sourceRevision', source_revision,
    'operation', 'metadata_change',
    'contentHash', content_hash,
    'normalizedPayload', normalized_payload,
    'normalizedText', '',
    'sourceFidelity', 'normalized_source',
    'schemaVersion', 'gmail-mailbox-discovery-event-v1'
  ) order by normalized_payload->>'messageId'), '[]'::jsonb)
  into v_observations
  from identified;

  v_append_receipt := private.append_gmail_ingest_page(
    v_batch_id, p_worker_id, v_lease_fence,
    jsonb_build_object(
      'pageOrdinal', 0,
      'requestPageToken', '',
      'responseNextPageToken', '',
      'responseMailboxHistoryId', v_cursor.cursor_value,
      'firstHistoryId', case when v_adopted_count > 0
        then v_cursor.cursor_value else '' end,
      'lastHistoryId', case when v_adopted_count > 0
        then v_cursor.cursor_value else '' end,
      'eventDigest', encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_provider_response), 'UTF8'
      ), 'sha256'), 'hex'),
      'providerResponse', v_provider_response,
      'providerEvents', v_provider_events,
      'isFinal', true
    ),
    v_observations,
    '[]'::jsonb,
    p_sync_token
  );
  if coalesce((v_append_receipt->>'ok')::boolean, false) is not true
    or (v_append_receipt->>'observationCount')::integer is distinct from
      v_adopted_count then
    raise exception 'Gmail cutover-delta page append was incomplete'
      using errcode = '23514';
  end if;
  v_commit_receipt := private.commit_source_ingest_batch(
    v_batch_id, p_worker_id, v_lease_fence, p_sync_token
  );
  if coalesce((v_commit_receipt->>'ok')::boolean, false) is not true
    or v_commit_receipt->>'committedCursorValue' is distinct from
      v_cursor.cursor_value
    or (v_commit_receipt->>'committedCursorVersion')::bigint is distinct from
      v_cursor.cursor_version + 1 then
    raise exception 'Gmail cutover-delta commit changed the live cursor contract'
      using errcode = '23514';
  end if;
  v_route_receipt := private.seal_gmail_materialization_routes_v1(
    'primary', v_batch_id
  );
  select * into strict v_batch
  from public.source_ingest_batches batch
  where batch.batch_id = v_batch_id
    and batch.status = 'committed'
    and batch.mode = 'cutover_delta_reconciliation'
    and batch.committed_cursor_value = v_cursor.cursor_value
    and batch.committed_cursor_version = v_cursor.cursor_version + 1;
  select * into strict v_route
  from public.gmail_batch_materialization_route_seals route
  where route.workspace_key = 'primary'
    and route.root_batch_id = v_batch_id
    and route.seal_id = v_route_receipt->>'sealId'
    and route.seal_hash = v_route_receipt->>'sealHash';
  if v_route.route_count is distinct from v_adopted_count
    or v_route.materialization_count is distinct from v_adopted_count
    or v_route.deleted_count is distinct from 0 then
    raise exception 'Gmail cutover-delta route projection is incomplete'
      using errcode = '23514';
  end if;

  v_chunk_body := jsonb_build_object(
    'schemaVersion', 'truth-gmail-cutover-delta-chunk-v1',
    'authorityVersion', 'truth-gmail-cutover-delta-reconciliation-v1',
    'planId', v_plan.plan_id,
    'planHash', v_plan.plan_hash,
    'strategy', v_plan.strategy,
    'chunkOrdinal', v_chunk_ordinal,
    'firstMemberOrdinal', v_next_member,
    'lastMemberOrdinal', v_next_member + v_member_count - 1,
    'memberCount', v_member_count,
    'adoptedMessageCount', v_adopted_count,
    'providerDeletedCount', v_deleted_count,
    'memberManifestHash', v_member_manifest_hash,
    'rootBatchId', v_batch.batch_id,
    'rootBatchHash', v_batch.batch_hash,
    'expectedCursorVersion', v_cursor.cursor_version,
    'committedCursorVersion', v_batch.committed_cursor_version,
    'committedCursorValue', v_batch.committed_cursor_value,
    'routeSealId', v_route.seal_id,
    'routeSealHash', v_route.seal_hash,
    'routeCount', v_route.route_count,
    'committedAt', private.canonical_truth_timestamp(v_batch.committed_at),
    'productionPublicationAttempted', false
  );
  v_chunk_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_chunk_body), 'UTF8'
  ), 'sha256'), 'hex');
  v_chunk_id := 'truth-gmail-cutover-delta-chunk:v1:' || v_chunk_hash;
  insert into public.truth_gmail_cutover_delta_chunks(
    chunk_id, chunk_hash, plan_id, chunk_ordinal, first_member_ordinal,
    last_member_ordinal, member_count, adopted_message_count,
    provider_deleted_count, root_batch_id, root_batch_hash,
    expected_cursor_version, committed_cursor_version,
    committed_cursor_value, route_seal_id, route_seal_hash, route_count,
    member_manifest_hash, canonical_chunk, schema_version,
    committed_at, created_at
  ) values (
    v_chunk_id, v_chunk_hash, p_plan_id, v_chunk_ordinal, v_next_member,
    v_next_member + v_member_count - 1, v_member_count, v_adopted_count,
    v_deleted_count, v_batch.batch_id, v_batch.batch_hash,
    v_cursor.cursor_version, v_batch.committed_cursor_version,
    v_batch.committed_cursor_value, v_route.seal_id, v_route.seal_hash,
    v_route.route_count, v_member_manifest_hash, v_chunk_body,
    'truth-gmail-cutover-delta-chunk-v1', v_batch.committed_at, v_now
  );

  update public.gmail_completeness_gaps
  set detail = detail || jsonb_build_object(
    'deltaReconciliationPlanId', v_plan.plan_id,
    'deltaReconciliationPlanHash', v_plan.plan_hash,
    'deltaReconciliationStrategy', v_plan.strategy,
    'deltaReconciliationMemberCount', v_plan.member_count,
    'deltaReconciliationChunkedCount', v_next_member + v_member_count,
    'deltaReconciliationAdoptedCount', (
      select coalesce(sum(chunk.adopted_message_count), 0)::integer
      from public.truth_gmail_cutover_delta_chunks chunk
      where chunk.plan_id = p_plan_id
    ),
    'deltaReconciliationProviderDeletedCount', v_plan.provider_deleted_count,
    'deltaReconciliationLastChunkId', v_chunk_id,
    'deltaReconciliationLastChunkHash', v_chunk_hash,
    'deltaReconciliationLastRootBatchId', v_batch.batch_id,
    'deltaReconciliationUpdatedAt',
      private.canonical_truth_timestamp(v_now),
    'productionPublicationAttempted', false
  )
  where gap_id = v_plan.cutover_delta_gap_id
    and status = 'open';

  return jsonb_build_object(
    'ok', true, 'status', 'chunk_committed', 'retryable', false,
    'planId', p_plan_id, 'chunkId', v_chunk_id,
    'chunkHash', v_chunk_hash, 'rootBatchId', v_batch.batch_id,
    'firstMemberOrdinal', v_next_member,
    'lastMemberOrdinal', v_next_member + v_member_count - 1,
    'memberCount', v_member_count,
    'adoptedMessageCount', v_adopted_count,
    'providerDeletedCount', v_deleted_count,
    'committedCursorVersion', v_batch.committed_cursor_version,
    'committedCursorValue', v_batch.committed_cursor_value,
    'routeCount', v_route.route_count,
    'nextMemberOrdinal', v_next_member + v_member_count,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.run_truth_gmail_cutover_delta_reconciliation_chunk(
  p_plan_id text,
  p_expected_member_ordinal integer,
  p_limit integer,
  p_worker_id text,
  p_max_nonterminal_jobs integer,
  p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.run_truth_gmail_cutover_delta_reconciliation_chunk_v1(
    p_plan_id, p_expected_member_ordinal, p_limit, p_worker_id,
    p_max_nonterminal_jobs, p_sync_token
  );
$function$;

create or replace function private.finalize_truth_gmail_cutover_delta_reconciliation_v1(
  p_plan_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_original_job_id constant uuid :=
    'c0e31882-da9c-414f-9657-ad310bf5bac3'::uuid;
  v_reply_message_id constant text := '1aa000000000004b';
  v_request_message_id constant text := '1aa0000000000046';
  v_plan public.truth_gmail_cutover_delta_plans%rowtype;
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_delta_gap public.gmail_completeness_gaps%rowtype;
  v_backfill_gap public.gmail_completeness_gaps%rowtype;
  v_backfill_gap_after public.gmail_completeness_gaps%rowtype;
  v_existing public.truth_gmail_cutover_delta_seals%rowtype;
  v_auth public.truth_gmail_cutover_delta_link_retry_authorizations%rowtype;
  v_original public.source_processing_jobs%rowtype;
  v_original_anchor public.source_observations%rowtype;
  v_runnable public.source_processing_jobs%rowtype;
  v_reply public.source_observations%rowtype;
  v_request public.source_observations%rowtype;
  v_link_member public.truth_gmail_link_epoch_members%rowtype;
  v_link_epoch public.truth_gmail_link_epochs%rowtype;
  v_resolution public.truth_link_resolution_runs%rowtype;
  v_link_proposal_id text;
  v_link_proposal_hash text;
  v_link_decision_version_id text;
  v_link_decision_hash text;
  v_link_decision_method text;
  v_link_decided_by text;
  v_link_decided_at timestamptz;
  v_link_binding_id text;
  v_link_binding_hash text;
  v_link_bound_at timestamptz;
  v_link_version_id text;
  v_link_content_hash text;
  v_link_relationship text;
  v_linker_version text;
  v_link_reason_code text;
  v_link_recorded_at timestamptz;
  v_chunk_count integer;
  v_member_count integer;
  v_adopted_count integer;
  v_deleted_count integer;
  v_min_member integer;
  v_max_member integer;
  v_checkpoint_count integer;
  v_critical_count integer;
  v_root_manifest jsonb;
  v_root_manifest_hash text;
  v_parse_manifest jsonb;
  v_parse_manifest_hash text;
  v_critical_manifest jsonb;
  v_link_action jsonb;
  v_auth_body jsonb;
  v_auth_hash text;
  v_auth_id text;
  v_adoption_result jsonb;
  v_seal_body jsonb;
  v_seal_hash text;
  v_seal_id text;
  v_now timestamptz := clock_timestamp();
  v_disposition text;
  v_lock_acquired boolean;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if coalesce(p_plan_id, '') !~
      '^truth-gmail-cutover-delta-plan:v1:[0-9a-f]{64}$' then
    raise exception 'Gmail cutover-delta finalize request is invalid'
      using errcode = '22023';
  end if;
  select * into strict v_plan
  from public.truth_gmail_cutover_delta_plans plan
  where plan.plan_id = p_plan_id;
  select * into strict v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.receipt_id = v_plan.parking_receipt_id
    and receipt.receipt_hash = v_plan.parking_receipt_hash;
  if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
    v_receipt
  ) then
    raise exception 'Gmail cutover-delta parking receipt failed final read-back'
      using errcode = '23514';
  end if;
  select * into v_existing
  from public.truth_gmail_cutover_delta_seals seal
  where seal.plan_id = p_plan_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'status', 'already_finalized', 'retryable', false,
      'planId', p_plan_id, 'sealId', v_existing.seal_id,
      'sealHash', v_existing.seal_hash,
      'chunkCount', v_existing.chunk_count,
      'memberCount', v_existing.member_count,
      'adoptedMessageCount', v_existing.adopted_message_count,
      'providerDeletedCount', v_existing.provider_deleted_count,
      'productionPublicationAttempted', false
    );
  end if;

  v_lock_acquired := pg_try_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:primary', 0
  ));
  if not v_lock_acquired then
    return jsonb_build_object(
      'ok', true, 'status', 'busy', 'retryable', true,
      'reason', 'SOURCE_CUT_SERIALIZATION_BUSY', 'planId', p_plan_id,
      'productionPublicationAttempted', false
    );
  end if;
  select * into strict v_delta_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_plan.cutover_delta_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary'
  for update;
  select * into strict v_backfill_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_plan.backfill_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary'
  for share;
  if not private.truth_gmail_cutover_delta_gap_boundary_valid_v1(
      v_receipt, v_backfill_gap, v_delta_gap
    )
    or v_delta_gap.gap_type is distinct from
      'GMAIL_CUTOVER_DELTA_RECONCILIATION'
    or v_delta_gap.status is distinct from 'open'
    or v_backfill_gap.gap_type is distinct from
      'PARKED_BACKFILL_HISTORICAL_DRAIN'
    or v_backfill_gap.status is distinct from 'open' then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'CUTOVER_DELTA_OR_HISTORICAL_GAP_AUTHORITY_CHANGED',
      'planId', p_plan_id,
      'deltaGapStatus', v_delta_gap.status,
      'historicalGapStatus', v_backfill_gap.status,
      'productionPublicationAttempted', false
    );
  end if;

  select count(*)::integer,
         coalesce(sum(chunk.member_count), 0)::integer,
         coalesce(sum(chunk.adopted_message_count), 0)::integer,
         coalesce(sum(chunk.provider_deleted_count), 0)::integer,
         min(chunk.first_member_ordinal),
         max(chunk.last_member_ordinal),
         coalesce(jsonb_agg(jsonb_build_object(
           'chunkId', chunk.chunk_id,
           'chunkHash', chunk.chunk_hash,
           'chunkOrdinal', chunk.chunk_ordinal,
           'firstMemberOrdinal', chunk.first_member_ordinal,
           'lastMemberOrdinal', chunk.last_member_ordinal,
           'rootBatchId', chunk.root_batch_id,
           'rootBatchHash', chunk.root_batch_hash,
           'committedCursorVersion', chunk.committed_cursor_version,
           'committedCursorValue', chunk.committed_cursor_value,
           'routeSealId', chunk.route_seal_id,
           'routeSealHash', chunk.route_seal_hash
         ) order by chunk.chunk_ordinal), '[]'::jsonb)
  into v_chunk_count, v_member_count, v_adopted_count, v_deleted_count,
       v_min_member, v_max_member, v_root_manifest
  from public.truth_gmail_cutover_delta_chunks chunk
  where chunk.plan_id = p_plan_id;
  if v_chunk_count < 1
    or v_member_count is distinct from v_plan.member_count
    or v_adopted_count is distinct from
      v_plan.member_count - v_plan.provider_deleted_count
    or v_deleted_count is distinct from v_plan.provider_deleted_count
    or v_min_member is distinct from 0
    or v_max_member is distinct from v_plan.member_count - 1
    or exists (
      select 1
      from public.truth_gmail_cutover_delta_chunks chunk
      left join public.truth_gmail_cutover_delta_chunks predecessor
        on predecessor.plan_id = chunk.plan_id
       and predecessor.chunk_ordinal = chunk.chunk_ordinal - 1
      where chunk.plan_id = p_plan_id
        and (
          (chunk.chunk_ordinal = 0 and chunk.first_member_ordinal <> 0)
          or
          (chunk.chunk_ordinal > 0 and (
            predecessor.chunk_id is null
            or chunk.first_member_ordinal <>
              predecessor.last_member_ordinal + 1
          ))
        )
    ) then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'CUTOVER_DELTA_CHUNK_FRONTIER_INCOMPLETE',
      'planId', p_plan_id, 'chunkCount', v_chunk_count,
      'chunkedMemberCount', v_member_count,
      'requiredMemberCount', v_plan.member_count,
      'productionPublicationAttempted', false
    );
  end if;
  v_root_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_root_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'rootBatchId', chunk.root_batch_id,
           'checkpointId', checkpoint.checkpoint_id,
           'checkpointHash', checkpoint.checkpoint_hash,
           'memberCount', checkpoint.member_count,
           'terminalGapCount', checkpoint.terminal_gap_count,
           'accumulatorHash', checkpoint.accumulator_hash
         ) order by chunk.chunk_ordinal), '[]'::jsonb)
  into v_checkpoint_count, v_parse_manifest
  from public.truth_gmail_cutover_delta_chunks chunk
  join public.gmail_parse_checkpoints checkpoint
    on checkpoint.workspace_key = 'primary'
   and checkpoint.connection_key = 'primary'
   and checkpoint.root_batch_id = chunk.root_batch_id
   and checkpoint.terminal_gap_count = 0
  where chunk.plan_id = p_plan_id;
  if v_checkpoint_count is distinct from v_chunk_count then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', true,
      'reason', 'CUTOVER_DELTA_PARSE_CHECKPOINTS_PENDING',
      'planId', p_plan_id, 'checkpointCount', v_checkpoint_count,
      'requiredCheckpointCount', v_chunk_count,
      'productionPublicationAttempted', false
    );
  end if;
  if exists (
    select 1
    from public.truth_gmail_cutover_delta_chunks chunk
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key = 'primary'
     and lineage.source_system = 'gmail'
     and lineage.connection_key = 'primary'
     and lineage.root_batch_id = chunk.root_batch_id
    join public.source_processing_jobs job
      on job.workspace_key = lineage.workspace_key
     and job.job_id = lineage.job_id
     and job.state = 'dead_letter'
    where chunk.plan_id = p_plan_id
  ) then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'CUTOVER_DELTA_DESCENDANT_DEAD_LETTER_PRESENT',
      'planId', p_plan_id, 'productionPublicationAttempted', false
    );
  end if;
  v_parse_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_parse_manifest), 'UTF8'
  ), 'sha256'), 'hex');

  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'messageId', critical.message_id,
           'rootBatchId', member.root_batch_id,
           'checkpointMemberId', member.member_id,
           'checkpointMemberHash', member.member_hash,
           'parsedObservationId', member.parsed_observation_id,
           'parsedObservationContentHash', observation.content_hash
         ) order by critical.message_id), '[]'::jsonb)
  into v_critical_count, v_critical_manifest
  from unnest(private.truth_gmail_cutover_delta_critical_messages_v1())
    critical(message_id)
  join public.gmail_parse_checkpoint_members member
    on member.workspace_key = 'primary'
   and member.message_id = critical.message_id
   and member.terminal_disposition = 'parsed_exact_revision'
  join public.truth_gmail_cutover_delta_chunks chunk
    on chunk.plan_id = p_plan_id
   and chunk.root_batch_id = member.root_batch_id
  join public.source_observations observation
    on observation.workspace_key = 'primary'
   and observation.observation_id = member.parsed_observation_id
   and observation.source_system = 'gmail'
   and observation.connection_key = 'primary'
   and observation.source_object_type = 'gmail_message_parsed'
   and observation.source_object_id = critical.message_id
   and observation.operation = 'content'
   and observation.schema_version = 'gmail-parsed-message-v2'
   and observation.normalized_payload->>'schemaVersion' =
     'gmail-parsed-message-v2';
  if v_critical_count is distinct from 8 then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', true,
      'reason', 'CUTOVER_DELTA_BACKTEST_MESSAGES_NOT_PARSED',
      'planId', p_plan_id, 'parsedCriticalMessageCount', v_critical_count,
      'requiredCriticalMessageCount', 8,
      'productionPublicationAttempted', false
    );
  end if;

  select distinct on (observation.source_object_id) observation.*
  into strict v_request
  from public.source_observations observation
  join public.gmail_parse_checkpoint_members member
    on member.workspace_key = observation.workspace_key
   and member.parsed_observation_id = observation.observation_id
  join public.truth_gmail_cutover_delta_chunks chunk
    on chunk.plan_id = p_plan_id
   and chunk.root_batch_id = member.root_batch_id
  where observation.workspace_key = 'primary'
    and observation.source_system = 'gmail'
    and observation.connection_key = 'primary'
    and observation.source_object_type = 'gmail_message_parsed'
    and observation.source_object_id = v_request_message_id
    and observation.operation = 'content'
    and observation.normalized_payload->>'schemaVersion' =
      'gmail-parsed-message-v2'
  order by observation.source_object_id,
           observation.source_cursor_version desc,
           observation.journal_seq desc,
           observation.observation_id;
  select distinct on (observation.source_object_id) observation.*
  into strict v_reply
  from public.source_observations observation
  where observation.workspace_key = 'primary'
    and observation.source_system = 'gmail'
    and observation.connection_key = 'primary'
    and observation.source_object_type = 'gmail_message_parsed'
    and observation.source_object_id = v_reply_message_id
    and observation.operation = 'content'
    and observation.normalized_payload->>'schemaVersion' =
      'gmail-parsed-message-v2'
  order by observation.source_object_id,
           observation.source_cursor_version desc,
           observation.journal_seq desc,
           observation.observation_id;
  if nullif(v_request.normalized_payload #>> '{gmail,threadId}', '') is null
    or v_request.normalized_payload #>> '{gmail,threadId}' is distinct from
      v_reply.normalized_payload #>> '{gmail,threadId}'
    or coalesce(v_request.source_recorded_at, v_request.captured_at) >=
      coalesce(v_reply.source_recorded_at, v_reply.captured_at)
    or position('70080000314' in regexp_replace(
      coalesce(v_request.normalized_text, ''), '[^0-9]', '', 'g'
    )) = 0 then
    raise exception 'FreightFlex cutover-delta thread proof is invalid'
      using errcode = '23514';
  end if;

  select * into strict v_original
  from public.source_processing_jobs job
  where job.job_id = v_original_job_id
    and job.workspace_key = 'primary'
    and job.source_system = 'gmail'
    and job.connection_key = 'primary'
    and job.job_kind = 'gmail_resolve_entity_links'
  for update;
  select * into strict v_original_anchor
  from public.source_observations observation
  where observation.workspace_key = 'primary'
    and observation.observation_id = v_original.observation_id
    and observation.source_system = 'gmail'
    and observation.connection_key = 'primary'
    and observation.source_object_type = 'gmail_message_parsed'
    and observation.source_object_id = v_reply_message_id
    and observation.operation = 'content'
    and observation.content_hash ~ '^[0-9a-f]{64}$'
    and observation.schema_version = 'gmail-parsed-message-v2'
    and observation.normalized_payload->>'schemaVersion' =
      'gmail-parsed-message-v2'
    and observation.normalized_payload #>> '{gmail,messageId}' =
      v_reply_message_id;
  if v_original.source_object_id is distinct from v_reply_message_id then
    raise exception 'FreightFlex dead-letter source identity is invalid'
      using errcode = '23514';
  end if;
  select * into v_auth
  from public.truth_gmail_cutover_delta_link_retry_authorizations retry_auth
  where retry_auth.plan_id = p_plan_id;
  if not found then
    if v_original.state is distinct from 'dead_letter'
      or v_original.lease_owner is not null
      or v_original.lease_expires_at is not null
      or v_original.completed_at is null
      or v_original.result is distinct from '{}'::jsonb
      or v_original.last_error_code not in ('TRUTH_LINK_JOB_FAILED', '23514')
      or position(
        'truth link context omitted its anchor'
        in v_original.safe_error_detail
      ) = 0
      or exists (
        select 1 from public.truth_link_resolution_runs run
        where run.workspace_key = 'primary'
          and run.job_id = v_original.job_id
      ) then
      raise exception 'FreightFlex dead-letter differs from exact retry authority'
        using errcode = '23514';
    end if;

    if v_original.observation_id = v_reply.observation_id then
      v_runnable := v_original;
      v_disposition := 'retry_exact_current_anchor';
    else
      select job.* into v_runnable
      from public.source_processing_jobs job
      join public.truth_gmail_link_epoch_members member
        on member.workspace_key = job.workspace_key
       and member.link_job_id = job.job_id
       and member.observation_id = v_reply.observation_id
      join public.truth_gmail_link_epochs epoch
        on epoch.workspace_key = member.workspace_key
       and epoch.epoch_id = member.epoch_id
      left join public.truth_gmail_link_epoch_seals epoch_seal
        on epoch_seal.workspace_key = epoch.workspace_key
       and epoch_seal.epoch_id = epoch.epoch_id
      where job.workspace_key = 'primary'
        and job.source_system = 'gmail'
        and job.connection_key = 'primary'
        and job.job_kind = 'gmail_resolve_entity_links'
        and job.observation_id = v_reply.observation_id
        and (
          job.state = 'succeeded'
          or (job.state in (
            'queued', 'retry_wait', 'waiting_runtime', 'dead_letter'
          ) and epoch_seal.epoch_id is null)
        )
      order by case job.state when 'succeeded' then 0 else 1 end,
               job.updated_at desc, job.job_id
      limit 1
      for update of job;
      if not found then
        return jsonb_build_object(
          'ok', true, 'status', 'not_ready', 'retryable', false,
          'reason', 'CURRENT_REPLY_LINK_JOB_MISSING',
          'planId', p_plan_id,
          'originalJobId', v_original.job_id,
          'latestReplyObservationId', v_reply.observation_id,
          'productionPublicationAttempted', false
        );
      end if;
      v_disposition := case
        when v_runnable.state = 'succeeded'
          then 'current_anchor_already_succeeded'
        when v_runnable.state in ('queued', 'retry_wait', 'waiting_runtime')
          then 'current_anchor_already_runnable'
        else 'retry_current_anchor_successor'
      end;
    end if;
    if v_runnable.state = 'leased' then
      return jsonb_build_object(
        'ok', true, 'status', 'busy', 'retryable', true,
        'reason', 'CURRENT_REPLY_LINK_JOB_LEASED',
        'planId', p_plan_id, 'runnableJobId', v_runnable.job_id,
        'productionPublicationAttempted', false
      );
    end if;
    select member.*
    into strict v_link_member
    from public.truth_gmail_link_epoch_members member
    where member.workspace_key = 'primary'
      and member.link_job_id = v_runnable.job_id
      and member.observation_id = v_runnable.observation_id;
    select epoch.*
    into strict v_link_epoch
    from public.truth_gmail_link_epochs epoch
    where epoch.workspace_key = v_link_member.workspace_key
      and epoch.epoch_id = v_link_member.epoch_id;
    if v_runnable.state <> 'succeeded' and exists (
      select 1 from public.truth_gmail_link_epoch_seals epoch_seal
      where epoch_seal.workspace_key = 'primary'
        and epoch_seal.epoch_id = v_link_member.epoch_id
    ) then
      raise exception 'FreightFlex runnable link epoch is already sealed'
        using errcode = '23514';
    end if;
    if v_runnable.state = 'dead_letter' and (
      v_runnable.result is distinct from '{}'::jsonb
      or position(
        'truth link context omitted its anchor'
        in v_runnable.safe_error_detail
      ) = 0
    ) then
      raise exception 'current-anchor link failure is outside retry authority'
        using errcode = '23514';
    end if;

    v_auth_body := jsonb_build_object(
      'schemaVersion', 'truth-gmail-cutover-delta-link-retry-v1',
      'authorityVersion', 'truth-gmail-cutover-delta-reconciliation-v1',
      'planId', v_plan.plan_id,
      'planHash', v_plan.plan_hash,
      'parkingReceiptId', v_receipt.receipt_id,
      'parkingReceiptHash', v_receipt.receipt_hash,
      'cutoverDeltaGapId', v_delta_gap.gap_id,
      'originalJobId', v_original.job_id,
      'originalObservationId', v_original.observation_id,
      'originalFailureCode', v_original.last_error_code,
      'originalFailureDetailHash', encode(extensions.digest(convert_to(
        v_original.safe_error_detail, 'UTF8'
      ), 'sha256'), 'hex'),
      'runnableJobId', v_runnable.job_id,
      'runnableObservationId', v_runnable.observation_id,
      'linkEpochId', v_link_member.epoch_id,
      'linkEpochMemberId', v_link_member.member_id,
      'linkEpochMemberHash', v_link_member.member_hash,
      'disposition', v_disposition,
      'replyMessageId', v_reply_message_id,
      'replyObservationId', v_reply.observation_id,
      'replyObservationContentHash', v_reply.content_hash,
      'adoptedThreadRootMessageId', v_request_message_id,
      'adoptedThreadRootObservationId', v_request.observation_id,
      'adoptedThreadRootObservationContentHash', v_request.content_hash,
      'threadId', v_reply.normalized_payload #>> '{gmail,threadId}',
      'shipmentKey', '70080000314',
      'productionPublicationAttempted', false
    );
    v_auth_hash := encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_auth_body), 'UTF8'
    ), 'sha256'), 'hex');
    v_auth_id := 'truth-gmail-cutover-delta-link-retry:v1:' || v_auth_hash;
    insert into public.truth_gmail_cutover_delta_link_retry_authorizations(
      authorization_id, authorization_hash, plan_id,
      original_job_id, runnable_job_id, disposition,
      canonical_authorization, schema_version, authorized_at, created_at
    ) values (
      v_auth_id, v_auth_hash, p_plan_id, v_original.job_id,
      v_runnable.job_id, v_disposition, v_auth_body,
      'truth-gmail-cutover-delta-link-retry-v1', v_now, v_now
    );
    select * into strict v_auth
    from public.truth_gmail_cutover_delta_link_retry_authorizations retry_auth
    where retry_auth.plan_id = p_plan_id;

    if v_runnable.state in ('dead_letter', 'waiting_runtime') then
      update public.source_processing_jobs
      set state = 'retry_wait',
          max_attempts = greatest(max_attempts, attempt_count + 3),
          available_at = v_now,
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = 'GMAIL_CUTOVER_DELTA_RECONCILED_RETRY_AUTHORIZED',
          safe_error_detail =
            'The exact cutover-delta thread root is parsed; retry is proof-authorized.',
          result = '{}'::jsonb,
          updated_at = v_now,
          completed_at = null
      where job_id = v_runnable.job_id
        and state = v_runnable.state
        and lease_owner is null
        and lease_expires_at is null;
      if not found then
        raise exception 'FreightFlex link retry fence changed during authorization'
          using errcode = '40001';
      end if;
      v_runnable.state := 'retry_wait';
      v_runnable.available_at := v_now;
      v_runnable.lease_owner := null;
      v_runnable.lease_expires_at := null;
      v_runnable.last_error_code :=
        'GMAIL_CUTOVER_DELTA_RECONCILED_RETRY_AUTHORIZED';
      v_runnable.safe_error_detail :=
        'The exact cutover-delta thread root is parsed; retry is proof-authorized.';
      v_runnable.completed_at := null;
    end if;
  else
    if v_auth.authorization_hash is distinct from encode(extensions.digest(
        convert_to(private.truth_canonical_json_text(
          v_auth.canonical_authorization
        ), 'UTF8'), 'sha256'
      ), 'hex')
      or v_auth.authorization_id is distinct from
        'truth-gmail-cutover-delta-link-retry:v1:' ||
          v_auth.authorization_hash
      or v_auth.original_job_id is distinct from v_original.job_id
      or v_auth.canonical_authorization->>'planId' is distinct from p_plan_id
      or v_auth.canonical_authorization->>'replyObservationId' is distinct from
        v_reply.observation_id
      or v_auth.canonical_authorization->>'adoptedThreadRootObservationId'
        is distinct from v_request.observation_id then
      raise exception 'Gmail cutover-delta link authorization failed read-back'
        using errcode = '23514';
    end if;
    select * into strict v_runnable
    from public.source_processing_jobs job
    where job.job_id = v_auth.runnable_job_id
      and job.workspace_key = 'primary'
      and job.source_system = 'gmail'
      and job.connection_key = 'primary'
      and job.job_kind = 'gmail_resolve_entity_links'
    for update;
  end if;

  if v_runnable.state = 'dead_letter' then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', false,
      'reason', 'FREIGHTFLEX_LINK_RETRY_FAILED',
      'planId', p_plan_id,
      'authorizationId', v_auth.authorization_id,
      'authorizationHash', v_auth.authorization_hash,
      'originalJobId', v_auth.original_job_id,
      'runnableJobId', v_auth.runnable_job_id,
      'runnableJobState', v_runnable.state,
      'runnableErrorCode', v_runnable.last_error_code,
      'runnableErrorDetail', v_runnable.safe_error_detail,
      'productionPublicationAttempted', false
    );
  elsif v_runnable.state is distinct from 'succeeded' then
    return jsonb_build_object(
      'ok', true, 'status', 'link_retry_authorized', 'retryable', true,
      'reason', 'FREIGHTFLEX_LINK_RETRY_PENDING',
      'planId', p_plan_id,
      'authorizationId', v_auth.authorization_id,
      'authorizationHash', v_auth.authorization_hash,
      'originalJobId', v_auth.original_job_id,
      'runnableJobId', v_auth.runnable_job_id,
      'runnableJobState', v_runnable.state,
      'productionPublicationAttempted', false
    );
  end if;
  select * into strict v_resolution
  from public.truth_link_resolution_runs run
  where run.workspace_key = 'primary'
    and run.job_id = v_runnable.job_id
    and run.anchor_observation_id = v_runnable.observation_id;
  if v_runnable.result is null or v_runnable.result = '{}'::jsonb
    or v_resolution.resolution_hash !~ '^[0-9a-f]{64}$'
    or v_resolution.canonical_resolution is null then
    raise exception 'FreightFlex runnable link success lacks resolution proof'
      using errcode = '23514';
  end if;
  select proposal.proposal_id,
         proposal.proposal_hash,
         decision.decision_version_id,
         decision.decision_hash,
         decision.decision_method,
         decision.decided_by,
         decision.created_at,
         binding.binding_id,
         binding.binding_hash,
         binding.created_at,
         link.link_version_id,
         link.content_hash,
         link.relationship,
         link.linker_version,
         proposal.canonical_proposal #>>
           '{candidate,proposal,reasonCode}',
         link.recorded_at
  into v_link_proposal_id,
       v_link_proposal_hash,
       v_link_decision_version_id,
       v_link_decision_hash,
       v_link_decision_method,
       v_link_decided_by,
       v_link_decided_at,
       v_link_binding_id,
       v_link_binding_hash,
       v_link_bound_at,
       v_link_version_id,
       v_link_content_hash,
       v_link_relationship,
       v_linker_version,
       v_link_reason_code,
       v_link_recorded_at
  from public.truth_link_candidate_proposals proposal
  join public.truth_link_candidate_decisions decision
    on decision.proposal_id = proposal.proposal_id
   and decision.decision = 'accept'
  join public.truth_link_acceptance_bindings binding
    on binding.proposal_id = proposal.proposal_id
   and binding.decision_version_id = decision.decision_version_id
   and binding.accepted_item_kind = 'entity_link'
  join public.observation_entity_links link
    on link.link_version_id = binding.accepted_item_id
  join public.observation_entity_link_envelopes link_envelope
    on link_envelope.link_version_id = link.link_version_id
   and link_envelope.workspace_key = 'primary'
   and link_envelope.envelope_hash = link.content_hash
  join public.truth_link_candidate_evidence proposal_evidence
    on proposal_evidence.proposal_id = proposal.proposal_id
   and proposal_evidence.observation_id = v_reply.observation_id
  where proposal.workspace_key = 'primary'
    and proposal.resolution_run_id = v_resolution.resolution_run_id
    and proposal.candidate_kind = 'entity_link'
    and proposal.proposal_method = 'deterministic'
    and not proposal.has_conflict
    and proposal.canonical_proposal #>>
      '{candidate,proposal,observationId}' = v_reply.observation_id
    and proposal.canonical_proposal #>>
      '{candidate,proposal,entityType}' = 'shipment'
    and proposal.canonical_proposal #>>
      '{candidate,proposal,entityKey}' = '70080000314'
    and proposal.canonical_proposal #>>
      '{candidate,proposal,decision}' = 'linked'
    and proposal.canonical_proposal #>>
      '{candidate,proposal,linkMethod}' = 'deterministic'
    and (
      (
        proposal.canonical_proposal #>>
          '{candidate,proposal,relationship}' = 'mentions'
        and proposal.canonical_proposal #>>
          '{candidate,proposal,reasonCode}' = 'explicit_full_awb_mention'
      )
      or
      (
        proposal.canonical_proposal #>>
          '{candidate,proposal,relationship}' = 'applies_to'
        and proposal.canonical_proposal #>>
          '{candidate,proposal,reasonCode}' =
            'gmail_thread_or_rfc_component_propagation'
        and coalesce(
          proposal.canonical_proposal #>
            '{candidate,proposal,evidenceSpan,basisObservationIds}',
          '[]'::jsonb
        ) @> jsonb_build_array(v_request.observation_id)
        and exists (
          select 1
          from public.truth_link_candidate_evidence request_evidence
          where request_evidence.proposal_id = proposal.proposal_id
            and request_evidence.observation_id = v_request.observation_id
        )
      )
    )
    and link.observation_id = v_reply.observation_id
    and link.entity_type = 'shipment'
    and link.entity_key = '70080000314'
    and link.relationship = proposal.canonical_proposal #>>
      '{candidate,proposal,relationship}'
    and link.decision = 'linked'
    and link.link_method = 'deterministic'
  order by decision.decision_no desc, proposal.proposal_id
  limit 1;
  if not found then
    return jsonb_build_object(
      'ok', true, 'status', 'not_ready', 'retryable', true,
      'reason', 'FREIGHTFLEX_ACCEPTED_SHIPMENT_LINK_PENDING',
      'planId', p_plan_id,
      'runnableJobId', v_runnable.job_id,
      'resolutionRunId', v_resolution.resolution_run_id,
      'productionPublicationAttempted', false
    );
  end if;

  if v_original.job_id <> v_runnable.job_id then
    v_adoption_result := jsonb_build_object(
      'schemaVersion', 'truth-gmail-cutover-delta-link-successor-adoption-v1',
      'authorityVersion', 'truth-gmail-cutover-delta-reconciliation-v1',
      'authorizationId', v_auth.authorization_id,
      'authorizationHash', v_auth.authorization_hash,
      'originalJobId', v_original.job_id,
      'originalObservationId', v_original.observation_id,
      'successorJobId', v_runnable.job_id,
      'successorObservationId', v_runnable.observation_id,
      'successorWorkerResultHash', encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_runnable.result), 'UTF8'
      ), 'sha256'), 'hex'),
      'successorResolutionRunId', v_resolution.resolution_run_id,
      'successorResolutionHash', v_resolution.resolution_hash,
      'successorProposalId', v_link_proposal_id,
      'successorProposalHash', v_link_proposal_hash,
      'successorDecisionVersionId', v_link_decision_version_id,
      'successorDecisionHash', v_link_decision_hash,
      'successorBindingId', v_link_binding_id,
      'successorBindingHash', v_link_binding_hash,
      'successorLinkVersionId', v_link_version_id,
      'successorLinkContentHash', v_link_content_hash,
      'adoptionDisposition',
        'stale_epoch_member_satisfied_by_current_anchor_resolution',
      'productionPublicationAttempted', false
    );
    if v_original.state = 'dead_letter' then
      update public.source_processing_jobs
      set state = 'succeeded',
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = 'GMAIL_CUTOVER_DELTA_LINK_SUCCESSOR_ADOPTED',
          safe_error_detail =
            'A proof-linked current-anchor successor resolved the same Gmail reply.',
          processor_version =
            'truth-gmail-cutover-delta-link-successor-adoption-v1',
          result = v_adoption_result,
          updated_at = v_now,
          completed_at = v_now
      where job_id = v_original.job_id
        and state = 'dead_letter'
        and result = '{}'::jsonb
        and lease_owner is null
        and lease_expires_at is null;
      if not found then
        raise exception 'FreightFlex stale link adoption fence changed'
          using errcode = '40001';
      end if;
      v_original.result := v_adoption_result;
      v_original.state := 'succeeded';
    elsif v_original.state <> 'succeeded'
      or v_original.result->>'authorizationId' is distinct from
        v_auth.authorization_id then
      raise exception 'FreightFlex stale link job conflicts with adoption proof'
        using errcode = '23505';
    end if;
  elsif v_original.state is distinct from 'succeeded' then
    raise exception 'FreightFlex exact retry is not durably succeeded'
      using errcode = '23514';
  end if;

  v_link_action := jsonb_build_object(
    'schemaVersion', 'truth-gmail-cutover-delta-link-action-v1',
    'authorizationId', v_auth.authorization_id,
    'authorizationHash', v_auth.authorization_hash,
    'disposition', v_auth.disposition,
    'originalJobId', v_original.job_id,
    'runnableJobId', v_runnable.job_id,
    'runnableObservationId', v_runnable.observation_id,
    'runnableWorkerResultHash', encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_runnable.result), 'UTF8'
    ), 'sha256'), 'hex'),
    'resolutionRunId', v_resolution.resolution_run_id,
    'resolutionHash', v_resolution.resolution_hash,
    'proposalId', v_link_proposal_id,
    'proposalHash', v_link_proposal_hash,
    'decisionVersionId', v_link_decision_version_id,
    'decisionHash', v_link_decision_hash,
    'decisionMethod', v_link_decision_method,
    'decidedBy', v_link_decided_by,
    'decidedAt', private.canonical_truth_timestamp(v_link_decided_at),
    'bindingId', v_link_binding_id,
    'bindingHash', v_link_binding_hash,
    'boundAt', private.canonical_truth_timestamp(v_link_bound_at),
    'linkVersionId', v_link_version_id,
    'linkContentHash', v_link_content_hash,
    'entityType', 'shipment',
    'entityKey', '70080000314',
    'relationship', v_link_relationship,
    'reasonCode', v_link_reason_code,
    'linkerVersion', v_linker_version,
    'linkRecordedAt', private.canonical_truth_timestamp(v_link_recorded_at),
    'originalEpochMemberDisposition', case
      when v_original.job_id = v_runnable.job_id
        then 'resolved_by_exact_current_anchor_retry'
      else 'resolved_by_proof_linked_current_anchor_successor' end
  );
  v_seal_body := jsonb_build_object(
    'schemaVersion', 'truth-gmail-cutover-delta-seal-v1',
    'authorityVersion', 'truth-gmail-cutover-delta-reconciliation-v1',
    'planId', v_plan.plan_id,
    'planHash', v_plan.plan_hash,
    'parkingReceiptId', v_receipt.receipt_id,
    'parkingReceiptHash', v_receipt.receipt_hash,
    'parkedBatchId', v_receipt.parked_batch_id,
    'historicalGapId', v_receipt.backfill_gap_id,
    'historicalGapDisposition', 'left_open_unchanged',
    'cutoverDeltaGapId', v_receipt.cutover_delta_gap_id,
    'cutoverDeltaGapDisposition', 'reconciled_current_mailbox',
    'priorCursorValue', v_plan.prior_cursor_value,
    'recoveryAnchorValue', v_plan.recovery_anchor_value,
    'windowStartInclusive', '2026-07-13T00:42:00.000Z',
    'windowEndExclusive', '2026-07-18T18:03:00.000Z',
    'strategy', v_plan.strategy,
    'coverageDisposition', case v_plan.strategy
      when 'history_retained' then
        'exact_retained_history_window_latest_message_state'
      else
        'current_mailbox_date_window_after_recorded_history_expiry' end,
    'chunkCount', v_chunk_count,
    'memberCount', v_member_count,
    'adoptedMessageCount', v_adopted_count,
    'providerDeletedCount', v_deleted_count,
    'rootManifestHash', v_root_manifest_hash,
    'parseManifestHash', v_parse_manifest_hash,
    'criticalMessageManifest', v_critical_manifest,
    'linkAction', v_link_action,
    'shipmentAcceptanceCase', jsonb_build_object(
      'backtestId', 'BT-2026-07-18',
      'shipmentKey', '70080000314',
      'freightFlexRequestMessageId', v_request_message_id,
      'freightFlexReplyMessageId', v_reply_message_id,
      'threadId', v_reply.normalized_payload #>> '{gmail,threadId}'
    ),
    'sealedAt', private.canonical_truth_timestamp(v_now),
    'productionPublicationAttempted', false
  );
  v_seal_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_seal_body), 'UTF8'
  ), 'sha256'), 'hex');
  v_seal_id := 'truth-gmail-cutover-delta-seal:v1:' || v_seal_hash;
  insert into public.truth_gmail_cutover_delta_seals(
    seal_id, seal_hash, plan_id, cutover_delta_gap_id, strategy,
    chunk_count, member_count, adopted_message_count,
    provider_deleted_count, root_manifest_hash, parse_manifest_hash,
    link_action, canonical_seal, schema_version, sealed_at, created_at
  ) values (
    v_seal_id, v_seal_hash, p_plan_id, v_delta_gap.gap_id, v_plan.strategy,
    v_chunk_count, v_member_count, v_adopted_count, v_deleted_count,
    v_root_manifest_hash, v_parse_manifest_hash, v_link_action, v_seal_body,
    'truth-gmail-cutover-delta-seal-v1', v_now, v_now
  );

  update public.gmail_completeness_gaps
  set status = 'reconciled_current_mailbox',
      detail = detail || jsonb_build_object(
        'deltaReconciliationPlanId', v_plan.plan_id,
        'deltaReconciliationPlanHash', v_plan.plan_hash,
        'deltaReconciliationSealId', v_seal_id,
        'deltaReconciliationSealHash', v_seal_hash,
        'deltaReconciliationAuthorizationId', v_auth.authorization_id,
        'deltaReconciliationAuthorizationHash', v_auth.authorization_hash,
        'deltaReconciliationStrategy', v_plan.strategy,
        'deltaReconciliationMemberCount', v_member_count,
        'deltaReconciliationAdoptedCount', v_adopted_count,
        'deltaReconciliationProviderDeletedCount', v_deleted_count,
        'deltaReconciliationReconciledAt',
          private.canonical_truth_timestamp(v_now),
        'productionPublicationAttempted', false
      )
  where gap_id = v_delta_gap.gap_id
    and status = 'open';
  if not found then
    raise exception 'Gmail cutover-delta gap closure fence changed'
      using errcode = '40001';
  end if;
  select * into strict v_backfill_gap_after
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_backfill_gap.gap_id;
  if v_backfill_gap_after.status is distinct from v_backfill_gap.status
    or v_backfill_gap_after.detail is distinct from v_backfill_gap.detail
    or v_backfill_gap_after.closed_by_gap_id is distinct from
      v_backfill_gap.closed_by_gap_id then
    raise exception 'historical backfill gap changed during delta closure'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true, 'status', 'finalized', 'retryable', false,
    'planId', p_plan_id, 'sealId', v_seal_id, 'sealHash', v_seal_hash,
    'authorizationId', v_auth.authorization_id,
    'authorizationHash', v_auth.authorization_hash,
    'chunkCount', v_chunk_count, 'memberCount', v_member_count,
    'adoptedMessageCount', v_adopted_count,
    'providerDeletedCount', v_deleted_count,
    'cutoverDeltaGapStatus', 'reconciled_current_mailbox',
    'historicalGapStatus', v_backfill_gap.status,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.finalize_truth_gmail_cutover_delta_reconciliation(
  p_plan_id text,
  p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.finalize_truth_gmail_cutover_delta_reconciliation_v1(
    p_plan_id, p_sync_token
  );
$function$;

revoke all on function
  private.open_truth_gmail_cutover_delta_reconciliation_v1(jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function
  private.read_truth_gmail_cutover_delta_reconciliation_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function
  private.run_truth_gmail_cutover_delta_reconciliation_chunk_v1(
    text,integer,integer,text,integer,text
  ) from public, anon, authenticated, service_role;
revoke all on function
  private.finalize_truth_gmail_cutover_delta_reconciliation_v1(text,text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.open_truth_gmail_cutover_delta_reconciliation(jsonb,text)
  from public, anon, authenticated;
revoke all on function
  public.read_truth_gmail_cutover_delta_reconciliation(text)
  from public, anon, authenticated;
revoke all on function
  public.run_truth_gmail_cutover_delta_reconciliation_chunk(
    text,integer,integer,text,integer,text
  ) from public, anon, authenticated;
revoke all on function
  public.finalize_truth_gmail_cutover_delta_reconciliation(text,text)
  from public, anon, authenticated;

grant execute on function
  public.open_truth_gmail_cutover_delta_reconciliation(jsonb,text)
  to service_role;
grant execute on function
  public.read_truth_gmail_cutover_delta_reconciliation(text)
  to service_role;
grant execute on function
  public.run_truth_gmail_cutover_delta_reconciliation_chunk(
    text,integer,integer,text,integer,text
  ) to service_role;
grant execute on function
  public.finalize_truth_gmail_cutover_delta_reconciliation(text,text)
  to service_role;

do $verify$
declare
  v_definition text;
  v_table text;
  v_signature text;
begin
  if to_regprocedure(
      'public.open_truth_gmail_cutover_delta_reconciliation(jsonb,text)'
    ) is null
    or to_regprocedure(
      'public.read_truth_gmail_cutover_delta_reconciliation(text)'
    ) is null
    or to_regprocedure(
      'public.run_truth_gmail_cutover_delta_reconciliation_chunk(text,integer,integer,text,integer,text)'
    ) is null
    or to_regprocedure(
      'public.finalize_truth_gmail_cutover_delta_reconciliation(text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_cutover_delta_gap_boundary_valid_v1(public.truth_gmail_backfill_parking_receipts,public.gmail_completeness_gaps,public.gmail_completeness_gaps)'
    ) is null then
    raise exception 'Gmail cutover-delta public authorities are missing'
      using errcode = '55000';
  end if;

  select pg_get_constraintdef(constraint_row.oid)
  into v_definition
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'public.source_ingest_batches'::regclass
    and constraint_row.conname = 'source_ingest_batches_mode_check';
  if position('cutover_delta_reconciliation' in coalesce(v_definition, '')) = 0
    or position('snapshot_recovery' in coalesce(v_definition, '')) = 0 then
    raise exception 'Gmail cutover-delta batch-mode constraint is incomplete'
      using errcode = '55000';
  end if;
  select pg_get_constraintdef(constraint_row.oid)
  into v_definition
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid =
      'public.gmail_model_extraction_plans'::regclass
    and constraint_row.conname =
      'gmail_model_extraction_plans_root_ingest_mode_check';
  if position('cutover_delta_reconciliation' in coalesce(v_definition, '')) = 0
    or position('snapshot_recovery' in coalesce(v_definition, '')) = 0
    or position('history' in coalesce(v_definition, '')) = 0 then
    raise exception 'Gmail cutover-delta model-plan root mode is incomplete'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'private.append_gmail_ingest_page(uuid,text,bigint,jsonb,jsonb,jsonb,text)'::regprocedure
  ) into v_definition;
  if position('cutover_delta_reconciliation' in v_definition) = 0 then
    raise exception 'Gmail cutover-delta append authority is incomplete'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_definition;
  if position('cutover_delta_reconciliation' in v_definition) = 0
    or position('then ''batch''' in v_definition) = 0 then
    raise exception 'Gmail cutover-delta model execution mode is incomplete'
      using errcode = '55000';
  end if;

  foreach v_table in array array[
    'truth_gmail_cutover_delta_plans',
    'truth_gmail_cutover_delta_members',
    'truth_gmail_cutover_delta_chunks',
    'truth_gmail_cutover_delta_seals',
    'truth_gmail_cutover_delta_link_retry_authorizations'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_class relation
      where relation.oid = format('public.%I', v_table)::regclass
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    ) or not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgrelid = format('public.%I', v_table)::regclass
        and trigger_row.tgname = v_table || '_immutable'
        and not trigger_row.tgisinternal
    ) or has_table_privilege(
      'anon', format('public.%I', v_table), 'SELECT,INSERT,UPDATE,DELETE'
    ) or has_table_privilege(
      'authenticated', format('public.%I', v_table),
      'SELECT,INSERT,UPDATE,DELETE'
    ) or not has_table_privilege(
      'service_role', format('public.%I', v_table), 'SELECT'
    ) or has_table_privilege(
      'service_role', format('public.%I', v_table), 'INSERT,UPDATE,DELETE'
    ) then
      raise exception 'Gmail cutover-delta table % protection is invalid',
        v_table using errcode = '55000';
    end if;
  end loop;

  foreach v_signature in array array[
    'public.open_truth_gmail_cutover_delta_reconciliation(jsonb,text)',
    'public.read_truth_gmail_cutover_delta_reconciliation(text)',
    'public.run_truth_gmail_cutover_delta_reconciliation_chunk(text,integer,integer,text,integer,text)',
    'public.finalize_truth_gmail_cutover_delta_reconciliation(text,text)'
  ] loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'Gmail cutover-delta RPC ACL is invalid for %',
        v_signature using errcode = '55000';
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    cross join lateral unnest(coalesce(
      procedure.proconfig, array[]::text[]
    )) setting
    where namespace.nspname in ('public', 'private')
      and procedure.proname like '%truth_gmail_cutover_delta%'
      and setting ~ '^(enable_|plan_cache_mode|statement_timeout|lock_timeout|cpu_|random_page_cost)='
  ) then
    raise exception 'Gmail cutover-delta authority contains a planner/timeout override'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.proname like '%truth_gmail_cutover_delta%'
      and (
        position('shipment-truth-packets' in lower(procedure.prosrc)) > 0
        or position('truth_publications' in lower(procedure.prosrc)) > 0
      )
  ) then
    raise exception 'Gmail cutover-delta authority references publication state'
      using errcode = '55000';
  end if;
end;
$verify$;
