-- Gmail may return an exact empty history page while advancing the mailbox
-- history ID. That is a cursor-only successor, not a new evidence frontier.
-- Admit it only when the entire expected/committed cursor chain, final pages,
-- and zero-event/zero-lineage proof are exact.

do $preflight$
declare
  v_definition text;
begin
  if to_regprocedure(
      'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)'
    ) is null then
    raise exception 'truth ceremony zero-event successor helper is unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)'
      ::regprocedure
  ) into v_definition;
  if position('batch.expected_cursor_value<>batch.previous_cursor_value'
      in v_definition)=0
    and (
      position('p_live_cursor_value' in v_definition)=0
      or position('p_accepted_cursor_value' in v_definition)=0
      or position('page.response_mailbox_history_id' in v_definition)=0
      or position('page.provider_event_manifest' in v_definition)=0
      or position('source_processing_job_lineage' in v_definition)=0
      or position('truth_pending_acceptance_epochs' in v_definition)=0
    ) then
    raise exception 'truth ceremony zero-event helper differs from the reviewed runtime'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_zero_change_successor_span_valid_v1(
  p_workspace_key text,
  p_connection_key text,
  p_accepted_root_batch_id uuid,
  p_accepted_cursor_version bigint,
  p_accepted_cursor_value text,
  p_live_cursor_version bigint,
  p_live_cursor_value text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $function$
  with suffix_base as materialized (
    select batch.*
    from public.source_ingest_batches batch
    where batch.workspace_key=p_workspace_key
      and batch.source_system='gmail'
      and batch.connection_key=p_connection_key
      and batch.committed_cursor_version>p_accepted_cursor_version
      and batch.committed_cursor_version<=p_live_cursor_version
  ),
  suffix as materialized (
    select batch.*,
      coalesce(
        lag(batch.committed_cursor_version) over(
          order by batch.committed_cursor_version
        ),
        p_accepted_cursor_version
      ) as previous_cursor_version,
      coalesce(
        lag(batch.committed_cursor_value) over(
          order by batch.committed_cursor_version
        ),
        p_accepted_cursor_value
      ) as previous_cursor_value
    from suffix_base batch
  )
  select p_workspace_key='primary'
    and p_connection_key='primary'
    and p_live_cursor_version>p_accepted_cursor_version
    and case
      when p_accepted_cursor_value~'^[0-9]+$'
        and p_live_cursor_value~'^[0-9]+$'
      then p_live_cursor_value::numeric>=p_accepted_cursor_value::numeric
      else false
    end
    and exists (
      select 1
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=p_workspace_key
        and epoch.source_system='gmail'
        and epoch.connection_key=p_connection_key
        and epoch.root_batch_id=p_accepted_root_batch_id
        and epoch.source_cursor_version=p_accepted_cursor_version
        and epoch.source_cursor_value=p_accepted_cursor_value
    )
    and exists (
      select 1
      from public.source_cursors cursor_row
      join public.source_ingest_batches live_batch
        on live_batch.workspace_key=cursor_row.workspace_key
       and live_batch.batch_id=cursor_row.last_batch_id
      where cursor_row.workspace_key=p_workspace_key
        and cursor_row.source_system='gmail'
        and cursor_row.connection_key=p_connection_key
        and cursor_row.status='live'
        and cursor_row.cursor_version=p_live_cursor_version
        and cursor_row.cursor_value=p_live_cursor_value
        and live_batch.source_system='gmail'
        and live_batch.connection_key=p_connection_key
        and live_batch.status='committed'
        and live_batch.committed_cursor_version=p_live_cursor_version
        and live_batch.committed_cursor_value=p_live_cursor_value
    )
    and (select count(*) from suffix)=
      (p_live_cursor_version-p_accepted_cursor_version)
    and not exists (
      select 1 from suffix batch
      where batch.mode<>'history'
        or batch.trigger_name<>'truth-shadow-orchestrator-v1:incremental'
        or batch.status<>'committed'
        or batch.expected_cursor_version<>batch.previous_cursor_version
        or batch.expected_cursor_value<>batch.previous_cursor_value
        or batch.committed_cursor_version<>batch.expected_cursor_version+1
        or case
          when batch.expected_cursor_value~'^[0-9]+$'
            and batch.committed_cursor_value~'^[0-9]+$'
          then batch.committed_cursor_value::numeric<
            batch.expected_cursor_value::numeric
          else true
        end
        or batch.page_count<>1
        or batch.observation_count<>0
        or batch.job_count<>0
        or batch.batch_hash is null
    )
    and not exists (
      select 1 from suffix batch
      where not exists (
        select 1
        from public.gmail_ingest_pages page
        where page.batch_id=batch.batch_id
          and page.page_ordinal=0
          and page.request_page_token=''
          and page.response_next_page_token=''
          and page.response_mailbox_history_id=batch.committed_cursor_value
          and page.first_history_id=''
          and page.last_history_id=''
          and page.event_count=0
          and page.job_count=0
          and page.provider_event_manifest='[]'::jsonb
          and page.is_final=true
      )
      or (select count(*) from public.gmail_ingest_pages page
          where page.batch_id=batch.batch_id)<>1
    )
    and not exists (
      select 1
      from public.source_observations observation
      join suffix batch on batch.batch_id=observation.batch_id
    )
    and not exists (
      select 1
      from public.gmail_ingest_page_observations membership
      join suffix batch on batch.batch_id=membership.batch_id
    )
    and not exists (
      select 1
      from public.gmail_ingest_page_jobs membership
      join suffix batch on batch.batch_id=membership.batch_id
    )
    and not exists (
      select 1
      from public.source_processing_job_lineage lineage
      join suffix batch on batch.batch_id=lineage.root_batch_id
    )
    and not exists (
      select 1
      from public.truth_pending_acceptance_epochs pending
      where pending.workspace_key=p_workspace_key
        and pending.source_system='gmail'
        and pending.connection_key=p_connection_key
        and pending.source_cursor_version>p_accepted_cursor_version
        and pending.source_cursor_version<=p_live_cursor_version
    )
    and not exists (
      select 1
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=p_workspace_key
        and epoch.source_system='gmail'
        and epoch.connection_key=p_connection_key
        and epoch.source_cursor_version>p_accepted_cursor_version
        and epoch.source_cursor_version<=p_live_cursor_version
    );
$function$;

revoke all on function private.truth_gmail_zero_change_successor_span_valid_v1(
  text,text,uuid,bigint,text,bigint,text
) from public,anon,authenticated,service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)'
      ::regprocedure
  ) into v_definition;
  select proconfig into v_config from pg_catalog.pg_proc
  where oid=
    'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)'
      ::regprocedure;
  if position('batch.expected_cursor_value<>batch.previous_cursor_value'
      in v_definition)=0
    or position('batch.committed_cursor_version<>batch.expected_cursor_version+1'
      in v_definition)=0
    or position(
      'page.response_mailbox_history_id=batch.committed_cursor_value'
      in v_definition
    )=0
    or position('page.provider_event_manifest=''[]''::jsonb'
      in v_definition)=0
    or position('p_live_cursor_value=p_accepted_cursor_value'
      in v_definition)>0
    or v_config is null
    or not ('search_path=""'=any(v_config))
    or has_function_privilege(
      'public',
      'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'private.truth_gmail_zero_change_successor_span_valid_v1(text,text,uuid,bigint,text,bigint,text)',
      'execute'
    ) then
    raise exception 'truth ceremony empty-history cursor authority is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
