-- The cutover-delta chunk guard protects the database from additional live
-- runnable work. Three waiting_runtime classes are deliberately policy-parked
-- and cannot consume workers before their separate coordinators/policies are
-- enabled. Exclude only those exact classes from the backpressure census.
-- Every queued/leased/retry_wait job and every undocumented waiting_runtime
-- job remains counted. Chunk authority, receipts, and publication fences are
-- otherwise byte-identical.

do $preflight$
begin
  if to_regprocedure(
    'private.run_truth_gmail_cutover_delta_reconciliation_chunk_v1(text,integer,integer,text,integer,text)'
  ) is null then
    raise exception 'cutover-delta chunk authority is unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

do $rewrite$
declare
  v_signature regprocedure:=
    'private.run_truth_gmail_cutover_delta_reconciliation_chunk_v1(text,integer,integer,text,integer,text)'::regprocedure;
  v_definition text;
  v_old text:=$old$     and job.state not in ('succeeded', 'superseded')
    where prior_chunk.plan_id = p_plan_id$old$;
  v_new text:=$new$     and job.state not in ('succeeded', 'superseded')
     and not (
       job.state = 'waiting_runtime'
       and job.last_error_code in (
         'GMAIL_MODEL_RUNTIME_DISABLED',
         'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED',
         'HISTORICAL_DRAIN_COORDINATOR_REQUIRED'
       )
     )
    where prior_chunk.plan_id = p_plan_id$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('GMAIL_MODEL_RUNTIME_DISABLED' in v_definition)>0
    and position('ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED' in v_definition)>0
    and position('HISTORICAL_DRAIN_COORDINATOR_REQUIRED' in v_definition)>0 then
    return;
  end if;
  if position(v_old in v_definition)=0 then
    raise exception 'cutover-delta backpressure census rewrite anchor drifted'
      using errcode='23514';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$rewrite$;

do $verify$
declare
  v_definition text;
  v_census text;
begin
  select pg_get_functiondef(
    'private.run_truth_gmail_cutover_delta_reconciliation_chunk_v1(text,integer,integer,text,integer,text)'::regprocedure
  ) into v_definition;
  v_census:=split_part(split_part(v_definition,
    'select count(*)::integer into v_nonterminal_count',2),
    'if v_nonterminal_count >= p_max_nonterminal_jobs',1);
  if position('job.state = ''waiting_runtime''' in v_census)=0
    or position('GMAIL_MODEL_RUNTIME_DISABLED' in v_census)=0
    or position('ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED' in v_census)=0
    or position('HISTORICAL_DRAIN_COORDINATOR_REQUIRED' in v_census)=0
    or position('job.state not in (''succeeded'', ''superseded'')' in v_census)=0
    or position('p_max_nonterminal_jobs + 1' in v_census)=0 then
    raise exception 'cutover-delta policy-parked backpressure rewrite is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;
