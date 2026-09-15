-- A crashed audit must become unhealthy when its durable lease expires even
-- if no later cron invocation arrives to reconcile the row. Wrap the reviewed
-- bounded status reader so status remains read-only and migration-reentrant.

set check_function_bodies = off;

do $block$
begin
  if to_regprocedure(
    'private.read_truth_audit_status_core(text,integer,text)'
  ) is null then
    alter function private.read_truth_audit_status(text, integer, text)
      rename to read_truth_audit_status_core;
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
  v_status jsonb;
  v_audit_run_id uuid;
  v_lease_expires_at timestamptz;
  v_lease_expired boolean := false;
begin
  v_status := private.read_truth_audit_status_core(
    p_workspace_key,
    p_finding_limit,
    p_sync_token
  );

  if v_status->'latestRun'->>'status' = 'running' then
    v_audit_run_id := (v_status->'latestRun'->>'auditRunId')::uuid;
    select run.lease_expires_at
    into v_lease_expires_at
    from public.truth_audit_runs run
    where run.workspace_key = p_workspace_key
      and run.audit_run_id = v_audit_run_id;

    v_lease_expired := v_lease_expires_at is null
      or v_lease_expires_at <= statement_timestamp();
    v_status := jsonb_set(
      v_status,
      '{latestRun,leaseExpiresAt}',
      coalesce(to_jsonb(v_lease_expires_at), 'null'::jsonb),
      true
    );
    v_status := jsonb_set(
      v_status,
      '{latestRun,leaseExpired}',
      to_jsonb(v_lease_expired),
      true
    );

    if v_lease_expired then
      v_status := jsonb_set(v_status, '{health}', '"stale"'::jsonb, true);
      v_status := jsonb_set(v_status, '{stale}', 'true'::jsonb, true);
    elsif v_status->>'lastSuccessfulFinishedAt' is null then
      -- A first audit that is actively inside its lease is not stale merely
      -- because it has not produced its first completion yet.
      v_status := jsonb_set(v_status, '{stale}', 'false'::jsonb, true);
    end if;
  end if;

  return v_status;
end;
$function$;

revoke all on function private.read_truth_audit_status_core(text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_audit_status(text, integer, text)
  from public, anon, authenticated, service_role;

set check_function_bodies = on;
