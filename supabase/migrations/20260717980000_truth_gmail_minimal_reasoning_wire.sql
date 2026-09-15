-- Keep bounded primary Gmail extraction from spending nearly all of its
-- structured-output allowance on hidden reasoning. This migration changes one
-- immutable provider-wire constructor only. It performs no retry, provider
-- call, review decision, candidate acceptance, cut, build, or publication.

do $preflight$
declare
  v_definition text;
  v_marker_count integer;
begin
  if to_regprocedure(
      'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'
    ) is null then
    raise exception 'minimal-reasoning Gmail model wire prerequisite is unavailable'
      using errcode='55000';
  end if;

  select pg_get_functiondef(
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure
  ) into strict v_definition;
  v_marker_count := (
    length(v_definition)
      - length(replace(v_definition, '"reasoning":{"effort":"minimal"}', ''))
  ) / length('"reasoning":{"effort":"minimal"}');

  if position('gmail-claim-extraction-prompt-v4' in v_definition)=0
    or position('gmail-model-candidate-claims-v4' in v_definition)=0
    or position('gmail_model_candidate_claims_v4' in v_definition)=0
    or position('"temperature"' in v_definition)>0
    or v_marker_count not in (0,1) then
    raise exception 'Gmail model wire differs from reviewed prompt-v4 predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

do $install$
declare
  v_signature constant regprocedure :=
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_updated text;
  v_old constant text := $old$'}]}],"max_output_tokens":8192,"store":false,'$old$;
  v_new constant text := $new$'}]}],"reasoning":{"effort":"minimal"},"max_output_tokens":8192,"store":false,'$new$;
  v_matches integer;
begin
  select pg_get_functiondef(v_signature) into strict v_definition;
  if position('"reasoning":{"effort":"minimal"}' in v_definition)>0 then
    v_updated := v_definition;
  else
    v_matches := (length(v_definition)-length(replace(v_definition,v_old,'')))
      / length(v_old);
    if v_matches<>1 then
      raise exception 'minimal-reasoning Gmail model wire splice matched % times',
        v_matches using errcode='23514';
    end if;
    v_updated := replace(v_definition,v_old,v_new);
    execute v_updated;
  end if;
end;
$install$;

revoke all on function private.expected_gmail_model_wire_v1(
  jsonb,jsonb,text,jsonb,jsonb
) from public,anon,authenticated,service_role;

do $postflight$
declare
  v_definition text;
  v_marker_count integer;
begin
  select pg_get_functiondef(
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure
  ) into strict v_definition;
  v_marker_count := (
    length(v_definition)
      - length(replace(v_definition, '"reasoning":{"effort":"minimal"}', ''))
  ) / length('"reasoning":{"effort":"minimal"}');
  if v_marker_count<>1
    or position(
      '"reasoning":{"effort":"minimal"},"max_output_tokens":8192'
      in v_definition
    )=0
    or position('"temperature"' in v_definition)>0 then
    raise exception 'minimal-reasoning Gmail model wire rewrite is incomplete'
      using errcode='23514';
  end if;
end;
$postflight$;
