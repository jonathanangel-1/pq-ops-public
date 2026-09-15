create or replace function public.valid_sync_token(p_sync_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $function$
  select exists (
    select 1
    from public.sync_tokens
    where token_name in ('local_snapshot_writer', 'codex_local_snapshot_writer')
      and token_hash = encode(extensions.digest(convert_to(p_sync_token, 'UTF8'), 'sha256'), 'hex')
  );
$function$;

grant execute on function public.valid_sync_token(text) to anon, authenticated;
