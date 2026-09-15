-- Deterministic/model-off extraction intentionally supplies modelPlan: null.
-- Keep that mode separate from the immutable-source binding required for every
-- present model plan. This guarded forward rewrite aborts if the inherited
-- function differs from the reviewed migration contract.
do $migration$
declare
  v_signature regprocedure:=to_regprocedure(
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
  );
  v_definition text;
  v_updated text;
  v_old_assignment text:=$old$  v_model_plan := p_extraction_plan->'modelPlan';$old$;
  v_new_assignment text:=$new$  v_model_plan := p_extraction_plan->'modelPlan';
  v_has_model_plan:=coalesce(jsonb_typeof(v_model_plan)='object',false);
  if not v_has_model_plan then
    v_model_plan:=null;
  end if;$new$;
  v_old_presence text:=$old$    if v_planning_status='complete' and
      (jsonb_typeof(v_model_plan)='object') is distinct from
        (jsonb_array_length(v_expected_residual->'unresolvedSignals')>0) then$old$;
  v_new_presence text:=$new$    if v_planning_status='complete' and v_has_model_plan
      and jsonb_array_length(v_expected_residual->'unresolvedSignals')=0 then$new$;
begin
  if v_signature is null then
    raise exception 'Gmail model extraction plan sealer is unavailable for deterministic-mode repair'
      using errcode='55000';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;

  if position('v_has_model_plan boolean:=false;' in v_definition)>0 then
    if position(v_new_assignment in v_definition)=0
      or position(v_new_presence in v_definition)=0
      or position('if v_has_model_plan then' in v_definition)=0
      or position('Gmail model plan is invalid or not bound to immutable source text' in v_definition)=0
      or position(v_old_presence in v_definition)>0
      or position('  if jsonb_typeof(v_model_plan) = ''object'' then' in v_definition)>0
      or position('  if jsonb_typeof(v_model_plan)=''object'' then' in v_definition)>0
      or position('    when jsonb_typeof(v_model_plan) <> ''object'' then ''none''' in v_definition)>0
      or position('    case when jsonb_typeof(v_model_plan)=''object'' then v_model_plan else null end,' in v_definition)>0 then
      raise exception 'deterministic Gmail plan repair is only partially installed'
        using errcode='23514';
    end if;
    return;
  end if;

  if position('  v_model_plan jsonb;' in v_definition)=0
    or position(v_old_assignment in v_definition)=0
    or position(v_old_presence in v_definition)=0
    or position('  if jsonb_typeof(v_model_plan) = ''object'' then' in v_definition)=0
    or position('  if jsonb_typeof(v_model_plan)=''object'' then' in v_definition)=0
    or position('    when jsonb_typeof(v_model_plan) <> ''object'' then ''none''' in v_definition)=0
    or position('    case when jsonb_typeof(v_model_plan)=''object'' then v_model_plan else null end,' in v_definition)=0
    or position('Gmail model plan is invalid or not bound to immutable source text' in v_definition)=0 then
    raise exception 'Gmail model extraction plan sealer differs from the reviewed pre-repair contract'
      using errcode='23514';
  end if;

  v_updated:=replace(
    v_definition,
    '  v_model_plan jsonb;',
    E'  v_model_plan jsonb;\n  v_has_model_plan boolean:=false;'
  );
  v_updated:=replace(v_updated,v_old_assignment,v_new_assignment);
  v_updated:=replace(v_updated,v_old_presence,v_new_presence);
  v_updated:=replace(
    v_updated,
    '  if jsonb_typeof(v_model_plan) = ''object'' then',
    '  if v_has_model_plan then'
  );
  v_updated:=replace(
    v_updated,
    '  if jsonb_typeof(v_model_plan)=''object'' then',
    '  if v_has_model_plan then'
  );
  v_updated:=replace(
    v_updated,
    '    when jsonb_typeof(v_model_plan) <> ''object'' then ''none''',
    '    when not v_has_model_plan then ''none'''
  );
  v_updated:=replace(
    v_updated,
    '    case when jsonb_typeof(v_model_plan)=''object'' then v_model_plan else null end,',
    '    case when v_has_model_plan then v_model_plan else null end,'
  );

  if v_updated=v_definition
    or position(v_old_presence in v_updated)>0
    or position('  if jsonb_typeof(v_model_plan) = ''object'' then' in v_updated)>0
    or position('  if jsonb_typeof(v_model_plan)=''object'' then' in v_updated)>0
    or position('    when jsonb_typeof(v_model_plan) <> ''object'' then ''none''' in v_updated)>0
    or position('    case when jsonb_typeof(v_model_plan)=''object'' then v_model_plan else null end,' in v_updated)>0
    or position(v_new_assignment in v_updated)=0
    or position(v_new_presence in v_updated)=0
    or position('Gmail model plan is invalid or not bound to immutable source text' in v_updated)=0 then
    raise exception 'Gmail deterministic plan repair did not produce the exact reviewed branch'
      using errcode='23514';
  end if;
  execute v_updated;

  select pg_get_functiondef(v_signature) into v_definition;
  if position('v_has_model_plan boolean:=false;' in v_definition)=0
    or position(v_new_assignment in v_definition)=0
    or position(v_new_presence in v_definition)=0
    or position('Gmail model plan is invalid or not bound to immutable source text' in v_definition)=0
    or position(v_old_presence in v_definition)>0
    or position('  if jsonb_typeof(v_model_plan) = ''object'' then' in v_definition)>0
    or position('  if jsonb_typeof(v_model_plan)=''object'' then' in v_definition)>0
    or position('    when jsonb_typeof(v_model_plan) <> ''object'' then ''none''' in v_definition)>0
    or position('    case when jsonb_typeof(v_model_plan)=''object'' then v_model_plan else null end,' in v_definition)>0 then
    raise exception 'Gmail deterministic plan repair failed read-back verification'
      using errcode='23514';
  end if;
end;
$migration$;

revoke all on function private.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public,anon,authenticated,service_role;
