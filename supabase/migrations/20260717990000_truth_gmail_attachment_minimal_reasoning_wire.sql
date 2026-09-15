-- Bind the primary attachment reader's explicit minimal-reasoning wire to a
-- new immutable processing-config identity. The request RPC continues to
-- enforce the pinned model, schema, prompt, token bounds, and request-body
-- hash; this migration changes no job, request, budget, claim, build, or
-- publication row.

create schema if not exists private;

do $rewrite$
declare
  v_signature regprocedure :=
    'private.create_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,integer,text,text,text,text,text,text,integer,integer,integer,text)'::regprocedure;
  v_definition text;
  v_updated text;
  v_old_version constant text := 'gmail-attachment-model-processing-config-v1';
  v_new_version constant text := 'gmail-attachment-model-processing-config-v2';
  v_old_hash constant text := '8d1b7f10f68ad9e953e57545835582f6da4e3a6f78d9c014bde176e74456cdd3';
  v_new_hash constant text := 'ef97ded848a80bd68d394d602b3767816234e55cce79b93ebf7560dd4715fd25';
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new_version in v_definition)>0
    and position(v_new_hash in v_definition)>0
    and position(v_old_version in v_definition)=0
    and position(v_old_hash in v_definition)=0 then
    return;
  end if;
  if position(v_old_version in v_definition)=0
    or position(v_old_hash in v_definition)=0
    or position(v_new_version in v_definition)>0
    or position(v_new_hash in v_definition)>0 then
    raise exception 'attachment processing-config authority differs from reviewed predecessor'
      using errcode='23514';
  end if;
  v_updated:=replace(v_definition,v_old_version,v_new_version);
  v_updated:=replace(v_updated,v_old_hash,v_new_hash);
  if v_updated=v_definition
    or position(v_new_version in v_updated)=0
    or position(v_new_hash in v_updated)=0
    or position(v_old_version in v_updated)>0
    or position(v_old_hash in v_updated)>0 then
    raise exception 'attachment processing-config rewrite was incomplete'
      using errcode='23514';
  end if;
  execute v_updated;
end;
$rewrite$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.create_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,integer,text,text,text,text,text,text,integer,integer,integer,text)'::regprocedure
  ) into v_definition;
  if position('gmail-attachment-model-processing-config-v2' in v_definition)=0
    or position('ef97ded848a80bd68d394d602b3767816234e55cce79b93ebf7560dd4715fd25'
      in v_definition)=0
    or position('gmail-attachment-model-processing-config-v1' in v_definition)>0
    or position('8d1b7f10f68ad9e953e57545835582f6da4e3a6f78d9c014bde176e74456cdd3'
      in v_definition)>0 then
    raise exception 'attachment minimal-reasoning wire authority is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
