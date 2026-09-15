-- Bind the producer lane before an audit starts and expose independent,
-- bounded shadow-ingest and standalone-audit health. A clean run in one lane
-- must never make a dead, degraded, failed, or regressing sibling look green.

set check_function_bodies = off;

create or replace function private.truth_audit_canonical_json_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $function$
declare
  v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':' || private.truth_audit_canonical_json_text(entry.value),
        ',' order by entry.key
      ), '') || '}'
      into v_result
      from jsonb_each(p_value) entry;
    when 'array' then
      select '[' || coalesce(string_agg(
        private.truth_audit_canonical_json_text(item.value),
        ',' order by item.ordinal
      ), '') || ']'
      into v_result
      from jsonb_array_elements(p_value) with ordinality item(value, ordinal);
    else
      v_result := p_value::text;
  end case;
  return v_result;
end;
$function$;

create or replace function private.valid_truth_audit_producer_context(
  p_context jsonb,
  p_audit_mode text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_keys text[];
  v_lane text;
  v_status text;
  v_worker_rounds integer;
  v_worker_failures integer;
  v_gap_count integer;
begin
  if jsonb_typeof(p_context) <> 'object' then return false; end if;
  select array_agg(key order by key) into v_keys
  from jsonb_object_keys(p_context) as item(key);
  if v_keys is distinct from array[
    'failureCode', 'failureStage', 'gmailSyncDisposition', 'producerLane',
    'producerStatus', 'schemaVersion', 'shadowBuildStatus',
    'sourceCutCompleteness', 'sourceCutId', 'sourceCutStatus', 'sourceGapCount',
    'sourceGapsHash', 'workerFailureCount', 'workerRounds', 'workersDrained'
  ]::text[] then
    return false;
  end if;
  if exists (
    select 1
    from (values
      ('failureCode'),('failureStage'),('gmailSyncDisposition'),('producerLane'),
      ('producerStatus'),('schemaVersion'),('shadowBuildStatus'),
      ('sourceCutCompleteness'),('sourceCutId'),('sourceCutStatus'),
      ('sourceGapsHash')
    ) required(field_name)
    where jsonb_typeof(p_context->required.field_name) is distinct from 'string'
      or p_context->>required.field_name is distinct from btrim(p_context->>required.field_name)
      or octet_length(p_context->>required.field_name) > 100
  )
    or p_context->>'schemaVersion' <> 'truth-audit-producer-context-v1'
    or jsonb_typeof(p_context->'workersDrained') <> 'boolean'
    or jsonb_typeof(p_context->'workerRounds') <> 'number'
    or jsonb_typeof(p_context->'workerFailureCount') <> 'number'
    or jsonb_typeof(p_context->'sourceGapCount') <> 'number'
    or coalesce(p_context->>'workerRounds', '') !~ '^[0-9]+$'
    or coalesce(p_context->>'workerFailureCount', '') !~ '^[0-9]+$'
    or coalesce(p_context->>'sourceGapCount', '') !~ '^[0-9]+$'
  then
    return false;
  end if;
  v_worker_rounds := (p_context->>'workerRounds')::integer;
  v_worker_failures := (p_context->>'workerFailureCount')::integer;
  v_gap_count := (p_context->>'sourceGapCount')::integer;
  if v_worker_rounds > 100 or v_worker_failures > 1000000 or v_gap_count > 5000 then
    return false;
  end if;

  v_lane := p_context->>'producerLane';
  v_status := p_context->>'producerStatus';
  if p_audit_mode = 'delta' then
    if v_lane <> 'truth-shadow'
      or v_status not in ('succeeded', 'degraded', 'failed', 'busy')
      or p_context->>'gmailSyncDisposition' not in ('ready', 'yield', 'busy', 'failed')
      or p_context->>'sourceCutStatus' not in ('sealed', 'not_ready', 'not_run')
      or p_context->>'sourceCutCompleteness' not in ('complete', 'degraded', 'not_run')
      or p_context->>'shadowBuildStatus' not in ('succeeded', 'busy', 'failed', 'not_run')
      or coalesce(p_context->>'sourceGapsHash', '') !~ '^[0-9a-f]{64}$'
      or (
        p_context->>'sourceCutStatus' = 'sealed'
        and coalesce(p_context->>'sourceCutId', '') !~ '^(?:source-)?cut:v1:[0-9a-f]{64}$'
      )
      or (
        p_context->>'sourceCutStatus' <> 'sealed'
        and coalesce(p_context->>'sourceCutId', '') <> ''
      )
    then
      return false;
    end if;
    if v_status = 'failed' then
      if nullif(p_context->>'failureStage', '') is null
        or coalesce(p_context->>'failureCode', '') !~ '^[A-Z0-9_]{3,100}$'
      then return false; end if;
    elsif coalesce(p_context->>'failureStage', '') <> ''
      or coalesce(p_context->>'failureCode', '') <> ''
    then
      return false;
    end if;
    if v_status = 'succeeded' and not (
      p_context->>'gmailSyncDisposition' = 'ready'
      and (p_context->>'workersDrained')::boolean
      and v_worker_failures = 0
      and p_context->>'sourceCutStatus' = 'sealed'
      and p_context->>'sourceCutCompleteness' = 'complete'
      and v_gap_count = 0
      and p_context->>'shadowBuildStatus' = 'succeeded'
    ) then
      return false;
    end if;
    return true;
  end if;

  if p_audit_mode = 'hourly' then
    return v_lane = 'standalone-audit'
      and v_status = 'ready'
      and p_context->>'gmailSyncDisposition' = 'not_applicable'
      and v_worker_rounds = 0
      and (p_context->>'workersDrained')::boolean
      and v_worker_failures = 0
      and p_context->>'sourceCutStatus' = 'not_applicable'
      and coalesce(p_context->>'sourceCutId', '') = ''
      and p_context->>'sourceCutCompleteness' = 'not_applicable'
      and v_gap_count = 0
      and coalesce(p_context->>'sourceGapsHash', '') = ''
      and p_context->>'shadowBuildStatus' = 'not_applicable'
      and coalesce(p_context->>'failureStage', '') = ''
      and coalesce(p_context->>'failureCode', '') = '';
  end if;
  return false;
exception when others then
  return false;
end;
$function$;

alter table public.truth_audit_runs
  add column if not exists producer_context jsonb;

create index if not exists truth_audit_runs_lane_recent_idx
  on public.truth_audit_runs (workspace_key, audit_mode, started_at desc, audit_run_id desc);

drop index if exists public.truth_audit_runs_one_running_workspace_idx;
create unique index if not exists truth_audit_runs_one_running_lane_idx
  on public.truth_audit_runs (workspace_key, audit_mode)
  where status = 'running';

-- Permit exactly one same-transaction context fill after the legacy begin RPC,
-- then make the context immutable and server-bind it into every final metric.
create or replace function public.guard_truth_audit_run_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth_audit_runs is append-only' using errcode = '55000';
  end if;

  if old.status = 'running' and new.status = 'running' then
    if old.producer_context is not null
      or private.valid_truth_audit_producer_context(new.producer_context, new.audit_mode) is distinct from true
      or (to_jsonb(new) - 'producer_context') is distinct from (to_jsonb(old) - 'producer_context')
    then
      raise exception 'truth audit producer context is immutable' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status <> 'running' then
    raise exception 'final truth audit runs are immutable' using errcode = '55000';
  end if;
  if new.status not in ('succeeded', 'failed') then
    raise exception 'truth audit runs only transition from running to a final state'
      using errcode = '55000';
  end if;
  if row(
    new.audit_run_id, new.workspace_key, new.audit_mode, new.observer_version,
    new.model_version, new.mutates_operational_state, new.started_at,
    new.lease_expires_at, new.previous_audit_run_id, new.reconciliation_from,
    new.expected_interval_seconds, new.producer_context
  ) is distinct from row(
    old.audit_run_id, old.workspace_key, old.audit_mode, old.observer_version,
    old.model_version, old.mutates_operational_state, old.started_at,
    old.lease_expires_at, old.previous_audit_run_id, old.reconciliation_from,
    old.expected_interval_seconds, old.producer_context
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

  if old.producer_context is not null then
    new.metrics := jsonb_set(new.metrics, '{producerContext}', old.producer_context, true);
  else
    new.metrics := new.metrics - 'producerContext';
  end if;
  if new.status = 'succeeded'
    and old.audit_mode = 'delta'
    and old.producer_context->>'sourceCutStatus' = 'sealed'
    and coalesce(new.source_cut_id, '') is distinct from old.producer_context->>'sourceCutId'
  then
    raise exception 'delta audit source cut does not match its bound producer context'
      using errcode = '23514';
  end if;
  if new.status = 'succeeded' and (
    new.input_digest is null or new.error_code <> '' or new.error_detail <> ''
  ) then
    raise exception 'a successful truth audit requires an input digest and no error'
      using errcode = '23514';
  end if;
  if new.status = 'failed' and nullif(new.error_code, '') is null then
    raise exception 'a failed truth audit requires an error code' using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function private.begin_truth_audit_run(
  p_workspace_key text,
  p_audit_mode text,
  p_observer_version text,
  p_model_version text,
  p_lease_seconds integer,
  p_expected_interval_seconds integer,
  p_producer_context jsonb,
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
  v_source_cut public.source_cuts%rowtype;
  v_now timestamptz := clock_timestamp();
  v_schedule_gap_seconds bigint;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode = '28000';
  end if;
  if private.valid_truth_audit_producer_context(p_producer_context, p_audit_mode) is distinct from true
    or nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_audit_mode not in ('delta', 'hourly')
    or nullif(trim(coalesce(p_observer_version, '')), '') is null
    or length(p_observer_version) > 200
    or length(coalesce(p_model_version, '')) > 200
    or p_lease_seconds is null
    or p_lease_seconds < 30
    or p_lease_seconds > 900
    or p_expected_interval_seconds is null
    or (p_audit_mode = 'delta' and p_expected_interval_seconds <> 300)
    or (p_audit_mode = 'hourly' and p_expected_interval_seconds <> 900)
  then
    raise exception 'invalid truth audit producer context' using errcode = '22023';
  end if;
  if p_producer_context->>'sourceCutStatus' = 'sealed' then
    select * into v_source_cut
    from public.source_cuts source_cut
    where source_cut.workspace_key = p_workspace_key
      and source_cut.source_cut_id = p_producer_context->>'sourceCutId';
    if not found then
      raise exception 'truth audit producer source cut is unavailable in this workspace'
        using errcode = '23503';
    end if;
    if p_producer_context->>'sourceCutCompleteness' is distinct from v_source_cut.completeness
      or (p_producer_context->>'sourceGapCount')::integer is distinct from jsonb_array_length(v_source_cut.gaps)
      or p_producer_context->>'sourceGapsHash' is distinct from encode(extensions.digest(
        convert_to(private.truth_audit_canonical_json_text(v_source_cut.gaps),'UTF8'),
        'sha256'
      ),'hex')
    then
      raise exception 'truth audit producer source cut witness does not match the sealed row'
        using errcode = '23514';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-audit-runtime:' || p_workspace_key || ':' || p_audit_mode,
    0
  ));

  select * into v_running
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
    and run.audit_mode = p_audit_mode
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
      'auditMode', v_running.audit_mode,
      'startedAt', v_running.started_at,
      'leaseExpiresAt', v_running.lease_expires_at,
      'producerContext', v_running.producer_context,
      'mutatesOperationalState', false
    );
  end if;

  if found then
    update public.truth_audit_runs
    set status = 'failed',
        error_code = 'AUDIT_LEASE_EXPIRED',
        error_detail = 'A later same-lane audit reconciled this stale running lease.',
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
    and run.audit_mode = p_audit_mode
    and run.status = 'succeeded'
    and run.expected_interval_seconds = p_expected_interval_seconds
    and private.valid_truth_audit_producer_context(run.producer_context, run.audit_mode)
    and run.metrics->'producerContext' = run.producer_context
    and (
      (p_audit_mode = 'delta' and run.producer_context->>'producerStatus' = 'succeeded')
      or (p_audit_mode <> 'delta' and run.producer_context->>'producerStatus' = 'ready')
    )
  order by run.finished_at desc, run.audit_run_id desc
  limit 1;

  if found then
    v_schedule_gap_seconds := greatest(
      0,
      floor(extract(epoch from (v_now - v_previous.finished_at)))::bigint
    );
  end if;

  insert into public.truth_audit_runs (
    workspace_key, audit_mode, observer_version, model_version, status,
    mutates_operational_state, lease_expires_at, previous_audit_run_id,
    reconciliation_from, expected_interval_seconds, producer_context
  ) values (
    p_workspace_key, p_audit_mode, p_observer_version, coalesce(p_model_version, ''),
    'running', false, v_now + make_interval(secs => p_lease_seconds),
    v_previous.audit_run_id, v_previous.finished_at, p_expected_interval_seconds,
    p_producer_context
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
    'producerContext', v_run.producer_context,
    'mutatesOperationalState', false
  );
end;
$function$;

create or replace function public.begin_truth_audit_run(
  p_workspace_key text,
  p_audit_mode text,
  p_observer_version text,
  p_model_version text,
  p_lease_seconds integer,
  p_expected_interval_seconds integer,
  p_producer_context jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.begin_truth_audit_run(
    p_workspace_key, p_audit_mode, p_observer_version, p_model_version,
    p_lease_seconds, p_expected_interval_seconds, p_producer_context, p_sync_token
  );
$function$;

grant create on schema public to truth_audit_rpc_owner;
alter function public.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)
  owner to truth_audit_rpc_owner;
revoke create on schema public from truth_audit_rpc_owner;
revoke all on function private.valid_truth_audit_producer_context(jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_audit_canonical_json_text(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function private.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)
  to truth_audit_rpc_owner;
revoke all on function public.begin_truth_audit_run(text,text,text,text,integer,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function public.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)
  from public, authenticated, service_role;
grant execute on function public.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)
  to anon;

create or replace function private.truth_audit_lane_status_v1(
  p_workspace_key text,
  p_producer_lane text,
  p_audit_mode text,
  p_expected_interval_seconds integer,
  p_stale_after_seconds integer,
  p_finding_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_run public.truth_audit_runs%rowtype;
  v_completed public.truth_audit_runs%rowtype;
  v_success public.truth_audit_runs%rowtype;
  v_context_valid boolean := false;
  v_completed_context_valid boolean := false;
  v_lease_expired boolean := false;
  v_stale boolean := true;
  v_health text := 'never_run';
  v_producer_status text := 'never_run';
  v_seconds_since_latest bigint;
  v_seconds_since_success bigint;
  v_counts jsonb := jsonb_build_object('blocking',0,'attention',0,'informational',0);
  v_finding_count integer := 0;
  v_findings jsonb := '[]'::jsonb;
  v_latest jsonb := null;
  v_latest_completed jsonb := null;
  v_latest_success jsonb := null;
begin
  select * into v_run
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
    and run.audit_mode = p_audit_mode
  order by run.started_at desc, run.audit_run_id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'schemaVersion','truth-audit-lane-status-v1',
      'producerLane',p_producer_lane,
      'auditMode',p_audit_mode,
      'health','never_run',
      'stale',true,
      'expectedIntervalSeconds',p_expected_interval_seconds,
      'staleAfterSeconds',p_stale_after_seconds,
      'latestRun',null,
      'latestCompleted',null,
      'latestSuccess',null,
      'lastSuccessfulFinishedAt',null,
      'secondsSinceLastSuccess',null,
      'secondsSinceLatestRun',null,
      'producerStatus','never_run',
      'producerContextValid',false,
      'findingCount',0,
      'findingsTruncated',false,
      'counts',v_counts,
      'findings',v_findings,
      'mutatesOperationalState',false
    );
  end if;

  v_context_valid := coalesce(private.valid_truth_audit_producer_context(
    v_run.producer_context, v_run.audit_mode
  ),false) and v_run.expected_interval_seconds=p_expected_interval_seconds and (
    v_run.status = 'running'
    or v_run.metrics->'producerContext' = v_run.producer_context
  );
  v_seconds_since_latest := greatest(0, floor(extract(epoch from (
    statement_timestamp() - coalesce(v_run.finished_at, v_run.started_at)
  )))::bigint);
  v_lease_expired := v_run.status = 'running'
    and (v_run.lease_expires_at is null or v_run.lease_expires_at <= statement_timestamp());
  v_stale := v_lease_expired or v_seconds_since_latest > p_stale_after_seconds;

  select * into v_completed
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
    and run.audit_mode = p_audit_mode
    and run.status in ('succeeded','failed')
  order by run.finished_at desc, run.audit_run_id desc
  limit 1;
  if found then
    v_completed_context_valid := coalesce(private.valid_truth_audit_producer_context(
      v_completed.producer_context,v_completed.audit_mode
    ),false) and v_completed.expected_interval_seconds=p_expected_interval_seconds
      and v_completed.metrics->'producerContext'=v_completed.producer_context;
  end if;

  select count(*)::integer,
    jsonb_build_object(
      'blocking',count(*) filter (where finding.severity='blocking'),
      'attention',count(*) filter (where finding.severity='attention'),
      'informational',count(*) filter (where finding.severity='informational')
    )
  into v_finding_count,v_counts
  from public.truth_audit_findings finding
  where finding.workspace_key=p_workspace_key
    and finding.audit_run_id=v_completed.audit_run_id;

  select coalesce(jsonb_agg(to_jsonb(bounded) order by
    case bounded.severity when 'blocking' then 0 when 'attention' then 1 else 2 end,
    bounded.stage,bounded.classification,bounded."subjectKey",bounded."findingId"
  ),'[]'::jsonb)
  into v_findings
  from (
    select
      finding.finding_id as "findingId", finding.stage, finding.severity,
      finding.classification, finding.subject_type as "subjectType",
      finding.subject_key as "subjectKey", finding.evidence_ids as "evidenceIds",
      finding.evidence_observation_ids as "evidenceObservationIds", finding.detail,
      finding.created_at as "createdAt", false as "mutatesOperationalState"
    from public.truth_audit_findings finding
    where finding.workspace_key=p_workspace_key
      and finding.audit_run_id=v_completed.audit_run_id
    order by case finding.severity when 'blocking' then 0 when 'attention' then 1 else 2 end,
      finding.stage,finding.classification,finding.subject_key,finding.finding_id
    limit p_finding_limit
  ) bounded;

  select * into v_success
  from public.truth_audit_runs run
  where run.workspace_key=p_workspace_key
    and run.audit_mode=p_audit_mode
    and run.status='succeeded'
    and run.expected_interval_seconds=p_expected_interval_seconds
    and private.valid_truth_audit_producer_context(run.producer_context,run.audit_mode)
    and run.metrics->'producerContext'=run.producer_context
    and (
      (p_producer_lane='truth-shadow' and run.producer_context->>'producerStatus'='succeeded')
      or (p_producer_lane='standalone-audit' and run.producer_context->>'producerStatus'='ready')
    )
  order by run.finished_at desc,run.audit_run_id desc
  limit 1;
  if found then
    v_seconds_since_success := greatest(0,floor(extract(epoch from (
      statement_timestamp()-v_success.finished_at
    )))::bigint);
    v_latest_success := jsonb_build_object(
      'auditRunId',v_success.audit_run_id,
      'auditMode',v_success.audit_mode,
      'status',v_success.status,
      'finishedAt',v_success.finished_at,
      'expectedIntervalSeconds',v_success.expected_interval_seconds,
      'producerContext',v_success.producer_context,
      'producerContextValid',true,
      'mutatesOperationalState',false
    );
  end if;

  v_producer_status := case
    when not v_context_valid then 'metadata_missing'
    when v_run.status='running' then 'running'
    when v_run.status='failed' then 'failed'
    else v_run.producer_context->>'producerStatus'
  end;
  v_health := case
    when v_run.status='failed' then 'failed'
    when not v_context_valid then 'failed'
    when v_lease_expired then 'stale'
    when v_stale then 'stale'
    when v_run.status='running' and v_completed.audit_run_id is not null
      and (v_completed.status='failed' or not v_completed_context_valid) then 'failed'
    when v_run.status='running'
      and v_completed.producer_context->>'producerStatus'='failed' then 'failed'
    when v_run.status='running'
      and v_completed.producer_context->>'producerStatus' in ('degraded','busy') then 'degraded'
    when v_run.producer_context->>'producerStatus'='failed' then 'failed'
    when v_run.producer_context->>'producerStatus' in ('degraded','busy') then 'degraded'
    when (v_counts->>'blocking')::integer>0 then 'regressions'
    when (v_counts->>'attention')::integer>0 then 'attention'
    when v_run.status='running' then 'running'
    else 'healthy'
  end;

  v_latest := jsonb_build_object(
    'auditRunId',v_run.audit_run_id,
    'auditMode',v_run.audit_mode,
    'status',v_run.status,
    'sourceCutId',coalesce(v_run.source_cut_id,''),
    'packetHash',coalesce(v_run.packet_hash,''),
    'productionPacketHash',coalesce(v_run.production_packet_hash,''),
    'observerVersion',v_run.observer_version,
    'modelVersion',v_run.model_version,
    'startedAt',v_run.started_at,
    'finishedAt',v_run.finished_at,
    'leaseExpiresAt',v_run.lease_expires_at,
    'leaseExpired',v_lease_expired,
    'expectedIntervalSeconds',v_run.expected_interval_seconds,
    'errorCode',v_run.error_code,
    'errorDetail',v_run.error_detail,
    'metrics',case when v_context_valid then v_run.metrics else v_run.metrics-'producerContext' end,
    'producerContext',case when v_context_valid then v_run.producer_context else null end,
    'producerContextValid',v_context_valid,
    'mutatesOperationalState',false
  );

  if v_completed.audit_run_id is not null then
    v_latest_completed := jsonb_build_object(
      'auditRunId',v_completed.audit_run_id,
      'auditMode',v_completed.audit_mode,
      'status',v_completed.status,
      'sourceCutId',coalesce(v_completed.source_cut_id,''),
      'packetHash',coalesce(v_completed.packet_hash,''),
      'productionPacketHash',coalesce(v_completed.production_packet_hash,''),
      'observerVersion',v_completed.observer_version,
      'modelVersion',v_completed.model_version,
      'startedAt',v_completed.started_at,
      'finishedAt',v_completed.finished_at,
      'leaseExpiresAt',v_completed.lease_expires_at,
      'leaseExpired',false,
      'expectedIntervalSeconds',v_completed.expected_interval_seconds,
      'errorCode',v_completed.error_code,
      'errorDetail',v_completed.error_detail,
      'metrics',case when v_completed_context_valid then v_completed.metrics
        else v_completed.metrics-'producerContext' end,
      'producerContext',case when v_completed_context_valid then v_completed.producer_context else null end,
      'producerContextValid',v_completed_context_valid,
      'mutatesOperationalState',false
    );
  end if;

  return jsonb_build_object(
    'schemaVersion','truth-audit-lane-status-v1',
    'producerLane',p_producer_lane,
    'auditMode',p_audit_mode,
    'health',v_health,
    'stale',v_stale,
    'expectedIntervalSeconds',p_expected_interval_seconds,
    'staleAfterSeconds',p_stale_after_seconds,
    'latestRun',v_latest,
    'latestCompleted',v_latest_completed,
    'latestSuccess',v_latest_success,
    'lastSuccessfulFinishedAt',v_success.finished_at,
    'secondsSinceLastSuccess',v_seconds_since_success,
    'secondsSinceLatestRun',v_seconds_since_latest,
    'producerStatus',v_producer_status,
    'producerContextValid',v_context_valid,
    'findingCount',v_finding_count,
    'findingsTruncated',v_finding_count>jsonb_array_length(v_findings),
    'counts',v_counts,
    'findings',v_findings,
    'mutatesOperationalState',false
  );
end;
$function$;

do $block$
begin
  if to_regprocedure('private.read_truth_audit_status_pre_lane_v2(text,integer,text)') is null then
    alter function private.read_truth_audit_status(text,integer,text)
      rename to read_truth_audit_status_pre_lane_v2;
  end if;
end
$block$;

create or replace function private.read_truth_audit_status(
  p_workspace_key text,
  p_finding_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_authorized jsonb;
  v_shadow jsonb;
  v_standalone jsonb;
  v_health text;
  v_counts jsonb;
  v_findings jsonb;
begin
  -- Preserve the reviewed authentication, workspace, and limit checks.
  v_authorized := private.read_truth_audit_status_pre_lane_v2(
    p_workspace_key,p_finding_limit,p_sync_token
  );
  v_shadow := private.truth_audit_lane_status_v1(
    p_workspace_key,'truth-shadow','delta',300,600,p_finding_limit
  );
  v_standalone := private.truth_audit_lane_status_v1(
    p_workspace_key,'standalone-audit','hourly',900,1800,p_finding_limit
  );

  v_health := case
    when v_shadow->>'health'='failed' or v_standalone->>'health'='failed' then 'failed'
    when v_shadow->>'health'='stale' or v_standalone->>'health'='stale' then 'stale'
    when v_shadow->>'health'='never_run' or v_standalone->>'health'='never_run' then 'never_run'
    when v_shadow->>'health'='regressions' or v_standalone->>'health'='regressions' then 'regressions'
    when v_shadow->>'health'='degraded' or v_standalone->>'health'='degraded' then 'degraded'
    when v_shadow->>'health'='running' or v_standalone->>'health'='running' then 'running'
    when v_shadow->>'health'='attention' or v_standalone->>'health'='attention' then 'attention'
    else 'healthy'
  end;
  v_counts := jsonb_build_object(
    'blocking',(v_shadow#>>'{counts,blocking}')::integer+(v_standalone#>>'{counts,blocking}')::integer,
    'attention',(v_shadow#>>'{counts,attention}')::integer+(v_standalone#>>'{counts,attention}')::integer,
    'informational',(v_shadow#>>'{counts,informational}')::integer+(v_standalone#>>'{counts,informational}')::integer
  );
  select coalesce(jsonb_agg(item.value order by
    case item.value->>'severity' when 'blocking' then 0 when 'attention' then 1 else 2 end,
    item.value->>'stage',item.value->>'classification',item.value->>'subjectKey',
    item.value->>'findingId'
  ),'[]'::jsonb)
  into v_findings
  from (
    select combined.value
    from (
      select value from jsonb_array_elements(v_shadow->'findings')
      union all
      select value from jsonb_array_elements(v_standalone->'findings')
    ) combined
    order by
      case combined.value->>'severity' when 'blocking' then 0 when 'attention' then 1 else 2 end,
      combined.value->>'stage',combined.value->>'classification',combined.value->>'subjectKey',
      combined.value->>'findingId'
    limit p_finding_limit
  ) item;

  return jsonb_build_object(
    'schemaVersion','truth-audit-status-v2',
    'ok',true,
    'workspaceKey',p_workspace_key,
    'health',v_health,
    'stale',(v_shadow->>'stale')::boolean or (v_standalone->>'stale')::boolean,
    'policy',jsonb_build_object(
      'schemaVersion','truth-audit-lane-status-policy-v1',
      'lanes',jsonb_build_object(
        'truth-shadow',jsonb_build_object(
          'auditMode','delta','expectedIntervalSeconds',300,'staleAfterSeconds',600
        ),
        'standalone-audit',jsonb_build_object(
          'auditMode','hourly','expectedIntervalSeconds',900,'staleAfterSeconds',1800
        )
      )
    ),
    'lanes',jsonb_build_object(
      'truth-shadow',v_shadow,
      'standalone-audit',v_standalone
    ),
    'findingCount',(v_shadow->>'findingCount')::integer+(v_standalone->>'findingCount')::integer,
    'findingsTruncated',(v_shadow->>'findingCount')::integer
      +(v_standalone->>'findingCount')::integer > jsonb_array_length(v_findings),
    'counts',v_counts,
    'findings',v_findings,
    'mutatesOperationalState',false
  );
end;
$function$;

create or replace function public.read_truth_audit_status(
  p_workspace_key text,
  p_finding_limit integer,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_truth_audit_status(
    p_workspace_key,p_finding_limit,p_sync_token
  );
$function$;

grant create on schema public to truth_audit_rpc_owner;
alter function public.read_truth_audit_status(text,integer,text)
  owner to truth_audit_rpc_owner;
revoke create on schema public from truth_audit_rpc_owner;

revoke all on function private.truth_audit_lane_status_v1(text,text,text,integer,integer,integer)
  from public,anon,authenticated,service_role;
revoke all on function private.read_truth_audit_status_pre_lane_v2(text,integer,text)
  from public,anon,authenticated,service_role,truth_audit_rpc_owner;
revoke all on function private.read_truth_audit_status(text,integer,text)
  from public,anon,authenticated,service_role,truth_audit_rpc_owner;
grant execute on function private.read_truth_audit_status(text,integer,text)
  to truth_audit_rpc_owner;
revoke all on function public.read_truth_audit_status(text,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.read_truth_audit_status(text,integer,text) to anon;

set check_function_bodies = on;
