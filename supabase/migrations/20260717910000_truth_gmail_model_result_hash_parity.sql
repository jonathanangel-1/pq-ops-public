-- Align Gmail model result materialization with the authoritative model-request
-- ledger's normalized-result hash contract. The ledger records SHA-256 over
-- PostgreSQL jsonb::text; the downstream materializer must verify that same
-- representation rather than introducing a second JSON serializer.
--
-- This migration performs no provider call, job transition, candidate write,
-- claim acceptance, source cut, build, publication, email, or freight mutation.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regprocedure(
      'private.record_gmail_model_extraction_result(text,uuid,text,bigint,text,text,text,text,jsonb,text)'
    ) is null
    or to_regclass('public.truth_model_sync_attempt_outcomes') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'Gmail model result hash-parity prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

do $install_result_hash_parity$
declare
  v_signature regprocedure :=
    'private.record_gmail_model_extraction_result(text,uuid,text,bigint,text,text,text,text,jsonb,text)'::regprocedure;
  v_definition text;
  v_old text := 'private.truth_canonical_json_text(v_outcome.normalized_result)';
  v_new text := 'v_outcome.normalized_result::text';
  v_matches integer;
  v_installed_matches integer;
  v_installed_parenthesized_matches integer;
begin
  select pg_get_functiondef(v_signature) into strict v_definition;
  v_matches := (
    length(v_definition)-length(replace(v_definition,v_old,''))
  )/length(v_old);
  v_installed_matches := (
    length(v_definition)-length(replace(v_definition,v_new,''))
  )/length(v_new);
  v_installed_parenthesized_matches := (
    length(v_definition)-length(replace(
      v_definition,'(v_outcome.normalized_result)::text',''
    ))
  )/length('(v_outcome.normalized_result)::text');
  if v_matches=1
    and v_installed_matches+v_installed_parenthesized_matches=0 then
    execute replace(v_definition,v_old,v_new);
  elsif v_matches=0
    and v_installed_matches+v_installed_parenthesized_matches=1 then
    null;
  else
    raise exception 'Gmail model result hash-parity patch shape differs: old %, installed %, parenthesized %, fragment %',
      v_matches,v_installed_matches,v_installed_parenthesized_matches,
      substr(v_definition,greatest(
        position('normalized_result_hash' in v_definition)-120,1
      ),480)
      using errcode='55000';
  end if;
end;
$install_result_hash_parity$;

do $verify_result_hash_parity$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.record_gmail_model_extraction_result(text,uuid,text,bigint,text,text,text,text,jsonb,text)'::regprocedure
  ) into strict v_definition;
  if position('v_outcome.normalized_result::text' in v_definition)=0
    and position('(v_outcome.normalized_result)::text' in v_definition)=0
    or position(
      'private.truth_canonical_json_text(v_outcome.normalized_result)' in v_definition
    )>0 then
    raise exception 'Gmail model result hash-parity installation is incomplete'
      using errcode='55000';
  end if;
end;
$verify_result_hash_parity$;

comment on function private.record_gmail_model_extraction_result(
  text,uuid,text,bigint,text,text,text,text,jsonb,text
) is 'Persists server-derived Gmail model candidates after verifying the exact durable provider outcome; normalized-result integrity follows the truth request ledger PostgreSQL jsonb-text hash contract.';
