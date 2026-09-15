do $migration$
declare
  current_definition text;
  next_definition text;
begin
  select pg_get_functiondef('public.sync_ops_memory(jsonb, text)'::regprocedure)
    into current_definition;

  if current_definition like '%public.valid_sync_token(p_sync_token)%' then
    return;
  end if;

  next_definition := regexp_replace(
    current_definition,
    'if not exists \(\s+select 1\s+from public\.sync_tokens\s+where token_name = ''local_snapshot_writer''\s+and token_hash = encode\(extensions\.digest\(convert_to\(p_sync_token, ''UTF8''\), ''sha256''\), ''hex''\)\s+\) then',
    'if not public.valid_sync_token(p_sync_token) then',
    'm'
  );

  if next_definition = current_definition then
    raise exception 'sync_ops_memory token guard was not rewritten';
  end if;

  execute next_definition;
end;
$migration$;
