-- The adoption RPC is a server-side worker boundary. The repository Supabase
-- client authenticates as service_role, matching the neighboring primary
-- claim/load/create RPCs; browser roles remain excluded. The sync token and
-- live lease fence are still enforced inside the function.

do $preflight$
begin
  if to_regprocedure(
    'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)'
  ) is null then
    raise exception 'attachment replay-adoption RPC is unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

revoke all on function public.adopt_truth_gmail_attachment_model_replay(
  text,uuid,text,bigint,text,text,text,text,text,text,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.adopt_truth_gmail_attachment_model_replay(
  text,uuid,text,bigint,text,text,text,text,text,text,text,text
) to service_role;

do $verify$
begin
  if not has_function_privilege('service_role',
      'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)',
      'execute')
    or has_function_privilege('anon',
      'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)',
      'execute')
    or has_function_privilege('authenticated',
      'public.adopt_truth_gmail_attachment_model_replay(text,uuid,text,bigint,text,text,text,text,text,text,text,text)',
      'execute') then
    raise exception 'attachment replay-adoption RPC ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;
