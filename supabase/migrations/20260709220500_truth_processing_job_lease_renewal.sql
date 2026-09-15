-- Long MIME/PDF jobs renew the same fenced lease rather than relying on a
-- best-effort completion inside the original lease window.

create or replace function private.renew_source_processing_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_lease_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid source-processing lease renewal' using errcode = '22023';
  end if;

  update public.source_processing_jobs
  set lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  where job_id = p_job_id
    and state = 'leased'
    and lease_owner = p_worker_id
    and lease_fence = p_lease_fence
    and processor_version = p_processor_version
    and lease_expires_at is not null
    and lease_expires_at > v_now
  returning * into v_job;
  if not found then
    raise exception 'source-processing lease lost' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'jobId', v_job.job_id,
    'state', v_job.state,
    'leaseFence', v_job.lease_fence,
    'leaseExpiresAt', v_job.lease_expires_at,
    'processorVersion', v_job.processor_version
  );
end;
$function$;

create or replace function public.renew_source_processing_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_lease_seconds integer,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.renew_source_processing_job_lease(
    p_job_id,
    p_worker_id,
    p_lease_fence,
    p_processor_version,
    p_lease_seconds,
    p_sync_token
  );
$function$;

revoke all on function private.renew_source_processing_job_lease(uuid, text, bigint, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.renew_source_processing_job_lease(uuid, text, bigint, text, integer, text)
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.renew_source_processing_job_lease(uuid, text, bigint, text, integer, text)
  to service_role;
grant execute on function public.renew_source_processing_job_lease(uuid, text, bigint, text, integer, text)
  to service_role;
