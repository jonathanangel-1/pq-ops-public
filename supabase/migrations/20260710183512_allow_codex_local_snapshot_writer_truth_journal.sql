-- Restore the established dual local-writer authority for fenced truth-journal
-- RPCs. Both hashes are already provisioned independently in sync_tokens; this
-- migration intentionally does not insert, update, delete, or rotate either
-- credential and does not alter production-publication authority.
create or replace function private.valid_truth_sync_token(p_sync_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens
    where token_name in ('local_snapshot_writer', 'codex_local_snapshot_writer')
      and token_hash = encode(
        extensions.digest(convert_to(p_sync_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

revoke all on function private.valid_truth_sync_token(text)
  from public, anon, authenticated;
