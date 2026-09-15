-- Private, service-only raw evidence storage for replayable source bytes.
--
-- No storage.objects policy is created here. Supabase Storage denies API
-- access by default when a private bucket has no matching RLS policy; the
-- backend worker uses a server-only service/secret key and verifies that the
-- bucket remains private before every process lifetime's first read/write.

do $migration$
declare
  existing_bucket storage.buckets%rowtype;
begin
  if to_regclass('storage.buckets') is null then
    raise exception using
      errcode = 'P0001',
      message = 'TRUTH_EVIDENCE_STORAGE_SCHEMA_MISSING';
  end if;

  select *
    into existing_bucket
    from storage.buckets
   where id = 'pikiio-truth-evidence-v1';

  if not found then
    insert into storage.buckets (id, name, public)
    values ('pikiio-truth-evidence-v1', 'pikiio-truth-evidence-v1', false);
  elsif existing_bucket.name is distinct from 'pikiio-truth-evidence-v1' then
    raise exception using
      errcode = 'P0001',
      message = 'TRUTH_EVIDENCE_BUCKET_NAME_MISMATCH';
  elsif existing_bucket.public is distinct from false then
    raise exception using
      errcode = 'P0001',
      message = 'TRUTH_EVIDENCE_BUCKET_ALREADY_PUBLIC';
  end if;
end
$migration$;
