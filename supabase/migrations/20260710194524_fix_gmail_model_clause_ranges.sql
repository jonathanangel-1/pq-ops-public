-- A clause made entirely of whitespace matches both edge expressions.  The
-- original sealer subtracted both lengths and passed a negative length to
-- substr(), preventing deterministic planning before model dispatch is even
-- considered.  Preserve the existing span policy and treat that clause as
-- empty.
create or replace function private.gmail_model_clause_ranges_v1(
  p_normalized_payload jsonb,p_normalized_text text
)
returns jsonb language plpgsql immutable security invoker set search_path=''
as $function$
declare
  v_current jsonb; v_body text; v_body_start integer; v_search integer:=1; v_segment text;
  v_relative integer; v_raw_start integer; v_leading text; v_trailing text;
  v_content_length integer; v_quote text; v_start integer; v_ranges jsonb:='[]'::jsonb;
begin
  v_current:=private.gmail_model_current_body_v1(p_normalized_payload,p_normalized_text);
  v_body:=v_current->>'text';
  v_body_start:=(v_current->>'start')::integer;
  for v_segment in
    select captures[1] from regexp_matches(v_body,'([^\n.!?]+[.!?]?)','g') captures
  loop
    v_relative:=strpos(substr(v_body,v_search),v_segment);
    if v_relative=0 then raise exception 'Gmail model clause scan lost source position' using errcode='23514'; end if;
    v_raw_start:=v_search+v_relative-1;
    v_search:=v_raw_start+char_length(v_segment);
    v_leading:=coalesce(substring(v_segment from '^[[:space:]]*'),'');
    v_trailing:=coalesce(substring(v_segment from '[[:space:]]*$'),'');
    v_content_length:=char_length(v_segment)-char_length(v_leading)-char_length(v_trailing);
    v_quote:=case when v_content_length>0 then substr(
      v_segment,1+char_length(v_leading),v_content_length
    ) else '' end;
    if v_quote<>'' then
      v_start:=v_body_start+private.gmail_model_utf16_length(
        substr(v_body,1,v_raw_start-1+char_length(v_leading))
      );
      v_ranges:=v_ranges||jsonb_build_array(jsonb_build_object(
        'start',v_start,'end',v_start+private.gmail_model_utf16_length(v_quote),'quote',v_quote
      ));
    end if;
  end loop;
  return v_ranges;
end;
$function$;

revoke all on function private.gmail_model_clause_ranges_v1(jsonb,text)
  from public,anon,authenticated,service_role;
