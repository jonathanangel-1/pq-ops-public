-- Bounded, token-gated visibility for the continuous truth audit. This reads
-- audit state only; the credential remains intentionally unable to write any
-- source observation, accepted claim, publication, action, Gmail, or TMS state.

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
  v_run public.truth_audit_runs%rowtype;
  v_last_success public.truth_audit_runs%rowtype;
  v_findings jsonb := '[]'::jsonb;
  v_counts jsonb := jsonb_build_object(
    'blocking', 0,
    'attention', 0,
    'informational', 0
  );
  v_finding_count integer := 0;
  v_seconds_since_success bigint;
  v_stale boolean := false;
  v_health text;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_finding_limit is null
    or p_finding_limit < 1
    or p_finding_limit > 200
  then
    raise exception 'invalid truth audit status request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.truth_workspaces workspace
    where workspace.workspace_key = p_workspace_key
      and workspace.status = 'active'
  ) then
    raise exception 'truth workspace is unavailable or disabled' using errcode = '23503';
  end if;

  select * into v_run
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
  order by run.started_at desc, run.audit_run_id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'schemaVersion', 'truth-audit-status-v1',
      'ok', true,
      'workspaceKey', p_workspace_key,
      'health', 'never_run',
      'stale', true,
      'latestRun', null,
      'lastSuccessfulFinishedAt', null,
      'secondsSinceLastSuccess', null,
      'findingCount', 0,
      'findingsTruncated', false,
      'counts', v_counts,
      'findings', v_findings,
      'mutatesOperationalState', false
    );
  end if;

  select * into v_last_success
  from public.truth_audit_runs run
  where run.workspace_key = p_workspace_key
    and run.status = 'succeeded'
  order by run.finished_at desc, run.audit_run_id desc
  limit 1;

  if found then
    v_seconds_since_success := greatest(
      0,
      floor(extract(epoch from (statement_timestamp() - v_last_success.finished_at)))::bigint
    );
    v_stale := v_seconds_since_success > (v_run.expected_interval_seconds * 2)::bigint;
  else
    v_seconds_since_success := null;
    v_stale := true;
  end if;

  select count(*)::integer,
         jsonb_build_object(
           'blocking', count(*) filter (where finding.severity = 'blocking'),
           'attention', count(*) filter (where finding.severity = 'attention'),
           'informational', count(*) filter (where finding.severity = 'informational')
         )
    into v_finding_count, v_counts
  from public.truth_audit_findings finding
  where finding.workspace_key = p_workspace_key
    and finding.audit_run_id = v_run.audit_run_id;

  select coalesce(jsonb_agg(to_jsonb(bounded) order by
    case bounded.severity when 'blocking' then 0 when 'attention' then 1 else 2 end,
    bounded.stage,
    bounded.classification,
    bounded."subjectKey",
    bounded."findingId"
  ), '[]'::jsonb)
  into v_findings
  from (
    select
      finding.finding_id as "findingId",
      finding.stage,
      finding.severity,
      finding.classification,
      finding.subject_type as "subjectType",
      finding.subject_key as "subjectKey",
      finding.evidence_ids as "evidenceIds",
      finding.evidence_observation_ids as "evidenceObservationIds",
      finding.detail,
      finding.created_at as "createdAt",
      false as "mutatesOperationalState"
    from public.truth_audit_findings finding
    where finding.workspace_key = p_workspace_key
      and finding.audit_run_id = v_run.audit_run_id
    order by
      case finding.severity when 'blocking' then 0 when 'attention' then 1 else 2 end,
      finding.stage,
      finding.classification,
      finding.subject_key,
      finding.finding_id
    limit p_finding_limit
  ) bounded;

  v_health := case
    when v_run.status = 'running' then 'running'
    when v_run.status = 'failed' then 'failed'
    when v_stale then 'stale'
    when (v_counts->>'blocking')::integer > 0 then 'regressions'
    when (v_counts->>'attention')::integer > 0 then 'attention'
    else 'healthy'
  end;

  return jsonb_build_object(
    'schemaVersion', 'truth-audit-status-v1',
    'ok', true,
    'workspaceKey', p_workspace_key,
    'health', v_health,
    'stale', v_stale,
    'latestRun', jsonb_build_object(
      'auditRunId', v_run.audit_run_id,
      'auditMode', v_run.audit_mode,
      'status', v_run.status,
      'sourceCutId', coalesce(v_run.source_cut_id, ''),
      'packetHash', coalesce(v_run.packet_hash, ''),
      'productionPacketHash', coalesce(v_run.production_packet_hash, ''),
      'observerVersion', v_run.observer_version,
      'modelVersion', v_run.model_version,
      'startedAt', v_run.started_at,
      'finishedAt', v_run.finished_at,
      'expectedIntervalSeconds', v_run.expected_interval_seconds,
      'errorCode', v_run.error_code,
      'errorDetail', v_run.error_detail,
      'metrics', v_run.metrics,
      'mutatesOperationalState', false
    ),
    'lastSuccessfulFinishedAt', v_last_success.finished_at,
    'secondsSinceLastSuccess', v_seconds_since_success,
    'findingCount', v_finding_count,
    'findingsTruncated', v_finding_count > p_finding_limit,
    'counts', v_counts,
    'findings', v_findings,
    'mutatesOperationalState', false
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
    p_workspace_key,
    p_finding_limit,
    p_sync_token
  );
$function$;

revoke all on function private.read_truth_audit_status(text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_truth_audit_status(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_truth_audit_status(text, integer, text) to anon;
