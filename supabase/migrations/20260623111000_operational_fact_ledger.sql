create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ops_evidence_documents (
  evidence_id text primary key,
  source_type text not null,
  source_id text not null default '',
  awb text,
  thread_id text,
  message_id text,
  attachment_id text,
  filename text,
  mime_type text,
  body_hash text not null default '',
  text_preview text not null default '',
  payload jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ops_evidence_documents_source_type_check
    check (source_type = any (array[
      'gmail-message'::text,
      'gmail-attachment'::text,
      'tms'::text,
      'tracking'::text,
      'operator-note'::text,
      'system'::text
    ]))
);

create table if not exists public.ops_workgroups (
  workgroup_id text primary key,
  workgroup_type text not null,
  group_key text not null,
  awbs text[] not null default '{}'::text[],
  station_code text,
  consignee text,
  broker_name text,
  broker_email text,
  thread_id text,
  status text not null default 'active',
  confidence numeric not null default 0.5,
  summary text not null default '',
  next_action text not null default '',
  evidence_ids text[] not null default '{}'::text[],
  payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ops_workgroups_status_check
    check (status = any (array['active'::text, 'resolved'::text, 'dismissed'::text, 'unknown'::text]))
);

create table if not exists public.ops_facts (
  fact_id text primary key,
  awb text not null,
  fact_type text not null,
  gate text not null default 'context',
  polarity text not null default 'neutral',
  confidence numeric not null default 0.5,
  confidence_label text not null default 'medium',
  actor_name text,
  actor_role text,
  summary text not null default '',
  evidence_text text not null default '',
  occurred_at timestamptz,
  observed_at timestamptz not null default now(),
  source_type text not null default 'system',
  source_id text not null default '',
  thread_id text,
  message_id text,
  attachment_id text,
  evidence_id text references public.ops_evidence_documents(evidence_id) on delete set null,
  workgroup_id text references public.ops_workgroups(workgroup_id) on delete set null,
  extraction_method text not null default 'deterministic',
  extractor_version text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ops_facts_gate_check
    check (gate = any (array[
      'arrival'::text,
      'customs'::text,
      'fees'::text,
      'quote'::text,
      'dispatch'::text,
      'pickup'::text,
      'delivery'::text,
      'pod'::text,
      'storage'::text,
      'exception'::text,
      'context'::text,
      'workgroup'::text
    ])),
  constraint ops_facts_polarity_check
    check (polarity = any (array[
      'positive'::text,
      'negative'::text,
      'requested'::text,
      'neutral'::text,
      'unknown'::text
    ])),
  constraint ops_facts_confidence_check
    check (confidence >= 0 and confidence <= 1)
);

create table if not exists public.ops_extraction_jobs (
  job_id text primary key,
  job_type text not null,
  status text not null default 'queued',
  source_hash text not null default '',
  source_snapshot_key text not null default '',
  awbs text[] not null default '{}'::text[],
  evidence_ids text[] not null default '{}'::text[],
  workgroup_ids text[] not null default '{}'::text[],
  model text not null default '',
  extractor_version text not null default '',
  prompt_version text not null default '',
  input_payload jsonb not null default '{}'::jsonb,
  output_payload jsonb not null default '{}'::jsonb,
  error text not null default '',
  attempts integer not null default 0,
  token_usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint ops_extraction_jobs_type_check
    check (job_type = any (array['fact-extraction'::text, 'workgroup-resolution'::text, 'dispute-review'::text])),
  constraint ops_extraction_jobs_status_check
    check (status = any (array['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text]))
);

create table if not exists public.ops_fact_disputes (
  dispute_id uuid primary key default gen_random_uuid(),
  dispute_key text unique,
  fact_id text references public.ops_facts(fact_id) on delete set null,
  awb text not null,
  expected_fact_type text not null default '',
  actual_fact_type text not null default '',
  operator_note text not null default '',
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ops_fact_disputes_status_check
    check (status = any (array['open'::text, 'resolved'::text, 'dismissed'::text]))
);

create index if not exists ops_evidence_documents_awb_idx
  on public.ops_evidence_documents (regexp_replace(coalesce(awb, ''), '\D', '', 'g'), observed_at desc);

create index if not exists ops_evidence_documents_source_idx
  on public.ops_evidence_documents (source_type, source_id);

create index if not exists ops_workgroups_active_idx
  on public.ops_workgroups (status, workgroup_type, last_seen_at desc)
  where status = 'active';

create index if not exists ops_workgroups_awbs_idx
  on public.ops_workgroups using gin (awbs);

create index if not exists ops_facts_awb_idx
  on public.ops_facts (regexp_replace(awb, '\D', '', 'g'), occurred_at desc nulls last, observed_at desc);

create index if not exists ops_facts_gate_idx
  on public.ops_facts (gate, fact_type, occurred_at desc nulls last);

create index if not exists ops_facts_workgroup_idx
  on public.ops_facts (workgroup_id, occurred_at desc nulls last)
  where workgroup_id is not null;

create index if not exists ops_facts_source_idx
  on public.ops_facts (source_type, source_id);

create index if not exists ops_extraction_jobs_status_idx
  on public.ops_extraction_jobs (status, updated_at desc);

create index if not exists ops_extraction_jobs_awbs_idx
  on public.ops_extraction_jobs using gin (awbs);

create index if not exists ops_extraction_jobs_evidence_idx
  on public.ops_extraction_jobs using gin (evidence_ids);

create index if not exists ops_fact_disputes_awb_idx
  on public.ops_fact_disputes (regexp_replace(awb, '\D', '', 'g'), created_at desc);

alter table public.ops_evidence_documents enable row level security;
alter table public.ops_workgroups enable row level security;
alter table public.ops_facts enable row level security;
alter table public.ops_extraction_jobs enable row level security;
alter table public.ops_fact_disputes enable row level security;

revoke all on public.ops_evidence_documents from anon, authenticated, public;
revoke all on public.ops_workgroups from anon, authenticated, public;
revoke all on public.ops_facts from anon, authenticated, public;
revoke all on public.ops_extraction_jobs from anon, authenticated, public;
revoke all on public.ops_fact_disputes from anon, authenticated, public;

grant select, insert, update, delete on public.ops_evidence_documents to service_role;
grant select, insert, update, delete on public.ops_workgroups to service_role;
grant select, insert, update, delete on public.ops_facts to service_role;
grant select, insert, update, delete on public.ops_extraction_jobs to service_role;
grant select, insert, update, delete on public.ops_fact_disputes to service_role;

create or replace function public.upsert_ops_fact_ledger(p_payload jsonb, p_sync_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_evidence_count integer := 0;
  v_workgroup_count integer := 0;
  v_fact_count integer := 0;
  v_extraction_job_count integer := 0;
  v_dispute_count integer := 0;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  with input_evidence as (
    select value as item
    from jsonb_array_elements(coalesce(p_payload->'evidenceDocuments', '[]'::jsonb))
    where nullif(value->>'evidenceId', '') is not null
  ),
  upserted_evidence as (
    insert into public.ops_evidence_documents (
      evidence_id,
      source_type,
      source_id,
      awb,
      thread_id,
      message_id,
      attachment_id,
      filename,
      mime_type,
      body_hash,
      text_preview,
      payload,
      observed_at
    )
    select
      item->>'evidenceId',
      coalesce(nullif(item->>'sourceType', ''), 'system'),
      coalesce(item->>'sourceId', ''),
      nullif(item->>'awb', ''),
      nullif(item->>'threadId', ''),
      nullif(item->>'messageId', ''),
      nullif(item->>'attachmentId', ''),
      nullif(item->>'filename', ''),
      nullif(item->>'mimeType', ''),
      coalesce(item->>'bodyHash', ''),
      coalesce(item->>'textPreview', ''),
      coalesce(item->'payload', '{}'::jsonb),
      coalesce(nullif(item->>'observedAt', '')::timestamptz, now())
    from input_evidence
    on conflict (evidence_id) do update
    set source_type = excluded.source_type,
        source_id = excluded.source_id,
        awb = excluded.awb,
        thread_id = excluded.thread_id,
        message_id = excluded.message_id,
        attachment_id = excluded.attachment_id,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        body_hash = excluded.body_hash,
        text_preview = excluded.text_preview,
        payload = excluded.payload,
        observed_at = excluded.observed_at,
        updated_at = now()
    returning 1
  )
  select count(*) into v_evidence_count from upserted_evidence;

  with input_workgroups as (
    select value as item
    from jsonb_array_elements(coalesce(p_payload->'workgroups', '[]'::jsonb))
    where nullif(value->>'workgroupId', '') is not null
  ),
  upserted_workgroups as (
    insert into public.ops_workgroups (
      workgroup_id,
      workgroup_type,
      group_key,
      awbs,
      station_code,
      consignee,
      broker_name,
      broker_email,
      thread_id,
      status,
      confidence,
      summary,
      next_action,
      evidence_ids,
      payload,
      first_seen_at,
      last_seen_at
    )
    select
      item->>'workgroupId',
      coalesce(nullif(item->>'workgroupType', ''), 'context'),
      coalesce(item->>'groupKey', item->>'workgroupId', ''),
      array(select jsonb_array_elements_text(coalesce(item->'awbs', '[]'::jsonb))),
      nullif(item->>'stationCode', ''),
      nullif(item->>'consignee', ''),
      nullif(item->>'brokerName', ''),
      nullif(item->>'brokerEmail', ''),
      nullif(item->>'threadId', ''),
      coalesce(nullif(item->>'status', ''), 'active'),
      least(1, greatest(0, coalesce(nullif(item->>'confidence', '')::numeric, 0.5))),
      coalesce(item->>'summary', ''),
      coalesce(item->>'nextAction', ''),
      array(select jsonb_array_elements_text(coalesce(item->'evidenceIds', '[]'::jsonb))),
      coalesce(item->'payload', '{}'::jsonb),
      nullif(item->>'firstSeenAt', '')::timestamptz,
      nullif(item->>'lastSeenAt', '')::timestamptz
    from input_workgroups
    on conflict (workgroup_id) do update
    set workgroup_type = excluded.workgroup_type,
        group_key = excluded.group_key,
        awbs = excluded.awbs,
        station_code = excluded.station_code,
        consignee = excluded.consignee,
        broker_name = excluded.broker_name,
        broker_email = excluded.broker_email,
        thread_id = excluded.thread_id,
        status = excluded.status,
        confidence = excluded.confidence,
        summary = excluded.summary,
        next_action = excluded.next_action,
        evidence_ids = excluded.evidence_ids,
        payload = excluded.payload,
        first_seen_at = coalesce(public.ops_workgroups.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(coalesce(public.ops_workgroups.last_seen_at, '-infinity'::timestamptz), coalesce(excluded.last_seen_at, '-infinity'::timestamptz)),
        updated_at = now()
    returning 1
  )
  select count(*) into v_workgroup_count from upserted_workgroups;

  with input_facts as (
    select value as item
    from jsonb_array_elements(coalesce(p_payload->'facts', '[]'::jsonb))
    where nullif(value->>'factId', '') is not null
      and nullif(value->>'awb', '') is not null
  ),
  upserted_facts as (
    insert into public.ops_facts (
      fact_id,
      awb,
      fact_type,
      gate,
      polarity,
      confidence,
      confidence_label,
      actor_name,
      actor_role,
      summary,
      evidence_text,
      occurred_at,
      observed_at,
      source_type,
      source_id,
      thread_id,
      message_id,
      attachment_id,
      evidence_id,
      workgroup_id,
      extraction_method,
      extractor_version,
      payload
    )
    select
      item->>'factId',
      item->>'awb',
      coalesce(nullif(item->>'factType', ''), 'context'),
      coalesce(nullif(item->>'gate', ''), 'context'),
      coalesce(nullif(item->>'polarity', ''), 'neutral'),
      least(1, greatest(0, coalesce(nullif(item->>'confidence', '')::numeric, 0.5))),
      coalesce(nullif(item->>'confidenceLabel', ''), 'medium'),
      nullif(item->>'actorName', ''),
      nullif(item->>'actorRole', ''),
      coalesce(item->>'summary', ''),
      coalesce(item->>'evidenceText', ''),
      nullif(item->>'occurredAt', '')::timestamptz,
      coalesce(nullif(item->>'observedAt', '')::timestamptz, now()),
      coalesce(nullif(item->>'sourceType', ''), 'system'),
      coalesce(item->>'sourceId', ''),
      nullif(item->>'threadId', ''),
      nullif(item->>'messageId', ''),
      nullif(item->>'attachmentId', ''),
      nullif(item->>'evidenceId', ''),
      nullif(item->>'workgroupId', ''),
      coalesce(nullif(item->>'extractionMethod', ''), 'deterministic'),
      coalesce(item->>'extractorVersion', ''),
      coalesce(item->'payload', '{}'::jsonb)
    from input_facts
    on conflict (fact_id) do update
    set awb = excluded.awb,
        fact_type = excluded.fact_type,
        gate = excluded.gate,
        polarity = excluded.polarity,
        confidence = excluded.confidence,
        confidence_label = excluded.confidence_label,
        actor_name = excluded.actor_name,
        actor_role = excluded.actor_role,
        summary = excluded.summary,
        evidence_text = excluded.evidence_text,
        occurred_at = excluded.occurred_at,
        observed_at = excluded.observed_at,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        thread_id = excluded.thread_id,
        message_id = excluded.message_id,
        attachment_id = excluded.attachment_id,
        evidence_id = excluded.evidence_id,
        workgroup_id = excluded.workgroup_id,
        extraction_method = excluded.extraction_method,
        extractor_version = excluded.extractor_version,
        payload = excluded.payload,
        updated_at = now()
    returning 1
  )
  select count(*) into v_fact_count from upserted_facts;

  with input_jobs as (
    select value as item
    from jsonb_array_elements(coalesce(p_payload->'extractionJobs', '[]'::jsonb))
    where nullif(value->>'jobId', '') is not null
  ),
  upserted_jobs as (
    insert into public.ops_extraction_jobs (
      job_id,
      job_type,
      status,
      source_hash,
      source_snapshot_key,
      awbs,
      evidence_ids,
      workgroup_ids,
      model,
      extractor_version,
      prompt_version,
      input_payload,
      output_payload,
      error,
      attempts,
      token_usage,
      created_at,
      started_at,
      completed_at
    )
    select
      item->>'jobId',
      coalesce(nullif(item->>'jobType', ''), 'fact-extraction'),
      coalesce(nullif(item->>'status', ''), 'queued'),
      coalesce(item->>'sourceHash', ''),
      coalesce(item->>'sourceSnapshotKey', ''),
      array(select jsonb_array_elements_text(coalesce(item->'awbs', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(item->'evidenceIds', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(item->'workgroupIds', '[]'::jsonb))),
      coalesce(item->>'model', ''),
      coalesce(item->>'extractorVersion', ''),
      coalesce(item->>'promptVersion', ''),
      coalesce(item->'inputPayload', '{}'::jsonb),
      coalesce(item->'outputPayload', '{}'::jsonb),
      coalesce(item->>'error', ''),
      greatest(0, coalesce(nullif(item->>'attempts', '')::integer, 0)),
      coalesce(item->'tokenUsage', '{}'::jsonb),
      coalesce(nullif(item->>'createdAt', '')::timestamptz, now()),
      nullif(item->>'startedAt', '')::timestamptz,
      nullif(item->>'completedAt', '')::timestamptz
    from input_jobs
    on conflict (job_id) do update
    set job_type = excluded.job_type,
        status = case
          when public.ops_extraction_jobs.status = 'succeeded' then public.ops_extraction_jobs.status
          else excluded.status
        end,
        source_hash = excluded.source_hash,
        source_snapshot_key = excluded.source_snapshot_key,
        awbs = excluded.awbs,
        evidence_ids = excluded.evidence_ids,
        workgroup_ids = excluded.workgroup_ids,
        model = excluded.model,
        extractor_version = excluded.extractor_version,
        prompt_version = excluded.prompt_version,
        input_payload = excluded.input_payload,
        output_payload = case
          when public.ops_extraction_jobs.status = 'succeeded' then public.ops_extraction_jobs.output_payload
          else excluded.output_payload
        end,
        error = case
          when public.ops_extraction_jobs.status = 'succeeded' then public.ops_extraction_jobs.error
          else excluded.error
        end,
        attempts = greatest(public.ops_extraction_jobs.attempts, excluded.attempts),
        token_usage = case
          when public.ops_extraction_jobs.status = 'succeeded' then public.ops_extraction_jobs.token_usage
          else excluded.token_usage
        end,
        started_at = coalesce(public.ops_extraction_jobs.started_at, excluded.started_at),
        completed_at = coalesce(public.ops_extraction_jobs.completed_at, excluded.completed_at),
        updated_at = now()
    returning 1
  )
  select count(*) into v_extraction_job_count from upserted_jobs;

  with input_disputes as (
    select value as item
    from jsonb_array_elements(coalesce(p_payload->'disputes', '[]'::jsonb))
    where nullif(value->>'awb', '') is not null
  ),
  upserted_disputes as (
    insert into public.ops_fact_disputes (
      dispute_key,
      fact_id,
      awb,
      expected_fact_type,
      actual_fact_type,
      operator_note,
      payload,
      status
    )
    select
      nullif(item->>'disputeId', ''),
      nullif(item->>'factId', ''),
      item->>'awb',
      coalesce(item->>'expectedFactType', ''),
      coalesce(item->>'actualFactType', ''),
      coalesce(item->>'operatorNote', ''),
      coalesce(item->'payload', '{}'::jsonb),
      coalesce(nullif(item->>'status', ''), 'open')
    from input_disputes
    on conflict (dispute_key) do update
    set fact_id = excluded.fact_id,
        awb = excluded.awb,
        expected_fact_type = excluded.expected_fact_type,
        actual_fact_type = excluded.actual_fact_type,
        operator_note = excluded.operator_note,
        payload = excluded.payload,
        status = excluded.status,
        updated_at = now()
    returning 1
  )
  select count(*) into v_dispute_count from upserted_disputes;

  return jsonb_build_object(
    'ok', true,
    'evidenceCount', coalesce(v_evidence_count, 0),
    'workgroupCount', coalesce(v_workgroup_count, 0),
    'factCount', coalesce(v_fact_count, 0),
    'extractionJobCount', coalesce(v_extraction_job_count, 0),
    'disputeCount', coalesce(v_dispute_count, 0)
  );
end;
$function$;

revoke all on function public.upsert_ops_fact_ledger(jsonb, text) from public;
grant execute on function public.upsert_ops_fact_ledger(jsonb, text) to anon, authenticated, service_role;
