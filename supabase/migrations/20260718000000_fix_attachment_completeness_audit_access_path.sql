-- 20260718000000_fix_attachment_completeness_audit_access_path.sql
--
-- The attachment-completeness helper and its purpose-built replacement index
-- used equivalent but syntactically different reviewRequired predicates.
-- PostgreSQL cannot use a partial index unless it can prove the query implies
-- that index predicate. Align the helper with the immutable index expression;
-- missing, null, or any value other than exact text `false` remains unresolved.

do $preflight$
begin
  if to_regprocedure(
    'private.unresolved_gmail_attachment_extractions(text)'
  ) is null then
    raise exception 'attachment completeness helper is unavailable'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'source_observations'
      and indexname = 'source_observations_gmail_attachment_replacement_idx'
      and lower(indexdef) like '%normalized_payload #>>%extraction,reviewrequired%'
      and lower(indexdef) like '%''false''::text%'
  ) then
    raise exception 'attachment replacement partial index is unavailable or malformed'
      using errcode = '23514';
  end if;
end;
$preflight$;

do $rewrite$
declare
  v_signature constant regprocedure :=
    'private.unresolved_gmail_attachment_extractions(text)'::regprocedure;
  v_definition text;
  v_rewritten text;
  v_old constant text := $old$        and coalesce(
          (replacement.normalized_payload->'extraction'->>'reviewRequired')::boolean,
          true
        ) = false$old$;
  v_new constant text := $new$        and coalesce(
          replacement.normalized_payload #>> '{extraction,reviewRequired}',
          'true'
        ) = 'false'$new$;
  v_old_identity constant text := $old_identity$        and replacement.normalized_payload->>'attachmentId'
          is not distinct from observation.normalized_payload->>'attachmentId'
        and replacement.normalized_payload->>'parentObservationId'
          is not distinct from observation.normalized_payload->>'parentObservationId'
        and replacement.normalized_payload->>'rawSha256'
          is not distinct from observation.normalized_payload->>'rawSha256'$old_identity$;
  v_new_identity constant text := $new_identity$        and replacement.normalized_payload->>'attachmentId'
          = observation.normalized_payload->>'attachmentId'
        and replacement.normalized_payload->>'parentObservationId'
          = observation.normalized_payload->>'parentObservationId'
        and replacement.normalized_payload->>'rawSha256'
          = observation.normalized_payload->>'rawSha256'$new_identity$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := v_definition;
  if position(v_new in v_rewritten) = 0 then
    if position(v_old in v_rewritten) = 0 then
      raise exception 'attachment completeness helper differs from the reviewed predicate predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old, v_new);
  end if;
  if position(v_new_identity in v_rewritten) = 0 then
    if position(v_old_identity in v_rewritten) = 0 then
      raise exception 'attachment completeness helper differs from the reviewed identity predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old_identity, v_new_identity);
  end if;
  if position(v_old in v_rewritten) > 0
    or position(v_new in v_rewritten) = 0 then
    raise exception 'attachment completeness access-path rewrite did not apply exactly'
      using errcode = '23514';
  end if;
  if position(v_old_identity in v_rewritten) > 0
    or position(v_new_identity in v_rewritten) = 0 then
    raise exception 'attachment completeness identity rewrite did not apply exactly'
      using errcode = '23514';
  end if;
  if v_rewritten <> v_definition then
    execute v_rewritten;
  end if;
end;
$rewrite$;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(p.oid), p.proconfig
  into v_definition, v_config
  from pg_proc p
  where p.oid = 'private.unresolved_gmail_attachment_extractions(text)'::regprocedure;

  if position(
    $needle$replacement.normalized_payload #>> '{extraction,reviewRequired}'$needle$
    in v_definition
  ) = 0
    or position($needle$) = 'false'$needle$ in v_definition) = 0
    or position(
      $needle$(replacement.normalized_payload->'extraction'->>'reviewRequired')::boolean$needle$
      in v_definition
    ) > 0
    or position($needle$is not distinct from observation.normalized_payload$needle$ in v_definition) > 0
    or position($needle$= observation.normalized_payload->>'attachmentId'$needle$ in v_definition) = 0
    or position($needle$= observation.normalized_payload->>'parentObservationId'$needle$ in v_definition) = 0
    or position($needle$= observation.normalized_payload->>'rawSha256'$needle$ in v_definition) = 0
    or coalesce(not ('search_path=""' = any(v_config)), true) then
    raise exception 'attachment completeness helper failed access-path verification'
      using errcode = '23514';
  end if;
end;
$verify$;

revoke all on function private.unresolved_gmail_attachment_extractions(text)
  from public, anon, authenticated, service_role;
