-- 20260718240000_bound_model_review_commissioning_witness.sql
--
-- model-review-commissioning-prefilter-v1
-- Only obligations with an immutable commissioning replay can possibly be
-- excluded by the full replay validator.  Validate that bounded candidate set
-- once, then anti-join its exact valid obligation identities.

create or replace function private.unresolved_gmail_model_extraction_reviews(
  p_workspace_key text
)
returns table(
  obligation_id text,
  extraction_plan_id text,
  model_plan_id text,
  review_job_id uuid,
  review_job_state text,
  reason_code text,
  safe_detail_hash text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path=''
as $function$
  with valid_commissioning_replays as materialized (
    select replay.obligation_id
    from public.truth_shadow_gmail_model_commissioning_replays replay
    where replay.workspace_key=p_workspace_key
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key,replay.obligation_id
      )
  )
  select obligation.obligation_id,obligation.extraction_plan_id,
    coalesce(obligation.model_plan_id,''),obligation.review_job_id,review.state,
    obligation.reason_code,obligation.safe_detail_hash,obligation.created_at
  from public.gmail_model_extraction_review_obligations obligation
  join public.source_processing_jobs review on review.job_id=obligation.review_job_id
   and review.workspace_key=obligation.workspace_key
   and review.job_kind='gmail_review_model_extraction'
  left join valid_commissioning_replays valid
    on valid.obligation_id=obligation.obligation_id
  where obligation.workspace_key=p_workspace_key
    and valid.obligation_id is null
    and not exists(
      select 1
      from public.gmail_model_extraction_review_resolutions resolution
      where resolution.workspace_key=obligation.workspace_key
        and resolution.obligation_id=obligation.obligation_id
    )
  order by obligation.created_at,obligation.obligation_id;
$function$;

revoke all on function private.unresolved_gmail_model_extraction_reviews(text)
  from public,anon,authenticated,service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(p.oid),p.proconfig into v_definition,v_config
  from pg_catalog.pg_proc p
  where p.oid=
    'private.unresolved_gmail_model_extraction_reviews(text)'::regprocedure;
  if position(
      'valid_commissioning_replays as materialized' in lower(v_definition)
    )=0 then
    raise exception 'bounded model-review commissioning witness is missing'
      using errcode='55000';
  end if;
  if position('truth_shadow_gmail_model_commissioning_replays replay'
      in lower(v_definition))=0
    or position('replay.workspace_key,replay.obligation_id' in v_definition)=0
    or position('obligation.workspace_key,obligation.obligation_id'
      in v_definition)>0
    or position('valid.obligation_id is null' in lower(v_definition))=0
    or v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege(
      'anon','private.unresolved_gmail_model_extraction_reviews(text)','EXECUTE'
    )
    or has_function_privilege(
      'authenticated','private.unresolved_gmail_model_extraction_reviews(text)','EXECUTE'
    ) then
    raise exception 'bounded model-review commissioning witness is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
