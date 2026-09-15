-- 20260718230000_compact_production_cache_audit_witness.sql
--
-- source-verified-compact-v1
-- The publication payload remains complete for shipment semantics.  The two
-- production app_snapshots rows duplicate those packet bodies, so verify each
-- cache preimage hash inside the token-gated function and transport only its
-- exact identity plus a fail-closed boolean verdict.

do $rewrite$
declare
  v_signature constant regprocedure :=
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;
  v_definition text;
  v_old constant text := 'then snapshot.payload';
  v_new constant text := $new$then jsonb_strip_nulls(jsonb_build_object(
          'cacheWitnessMode','source-verified-compact-v1',
          'payloadHashVerifiedAtSource',case
            when snapshot.snapshot_key='shipment-truth-packets' then
              coalesce(snapshot.payload->>'deliveryPayloadHash','')~'^[0-9a-f]{64}$'
              and snapshot.payload->>'contentSignature'=
                snapshot.payload->>'deliveryPayloadHash'
              and encode(extensions.digest(convert_to(
                (snapshot.payload-'deliveryPayloadHash'-'contentSignature')::text,
                'UTF8'
              ),'sha256'),'hex')=snapshot.payload->>'deliveryPayloadHash'
            when snapshot.snapshot_key='active-awb-index' then
              coalesce(snapshot.payload->>'contentSignature','')~'^[0-9a-f]{64}$'
              and encode(extensions.digest(convert_to(
                (snapshot.payload-'contentSignature')::text,'UTF8'
              ),'sha256'),'hex')=snapshot.payload->>'contentSignature'
            else false
          end,
          'publicationId',coalesce(
            snapshot.payload->'publicationId',snapshot.payload->'publication_id'
          ),
          'publicationVersion',coalesce(
            snapshot.payload->'publicationVersion',snapshot.payload->'publication_version'
          ),
          'publicationChannel',coalesce(
            snapshot.payload->'publicationChannel',snapshot.payload->'publication_channel'
          ),
          'sourceCutId',coalesce(
            snapshot.payload->'sourceCutId',snapshot.payload->'source_cut_id'
          ),
          'packetHash',coalesce(
            snapshot.payload->'packetHash',snapshot.payload->'packet_hash'
          ),
          'deliveryPayloadHash',coalesce(
            snapshot.payload->'deliveryPayloadHash',snapshot.payload->'delivery_payload_hash'
          ),
          'contentSignature',coalesce(
            snapshot.payload->'contentSignature',snapshot.payload->'content_signature'
          ),
          'truthPacketContentSignature',coalesce(
            snapshot.payload->'truthPacketContentSignature',
            snapshot.payload->'truth_packet_content_signature'
          ),
          'writerVersion',coalesce(
            snapshot.payload->'writerVersion',snapshot.payload->'writer_version'
          )
        ))$new$;
  v_occurrences integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('source-verified-compact-v1' in v_definition)=0 then
    v_occurrences :=
      (length(v_definition)-length(replace(v_definition,v_old,'')))
      / length(v_old);
    if v_occurrences is distinct from 1 then
      raise exception 'truth audit production-cache branch differs from reviewed predecessor'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite$;

revoke all on function private.read_truth_audit_snapshot_core(
  text,integer,text
) from public,anon,authenticated,service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(p.oid),p.proconfig into v_definition,v_config
  from pg_catalog.pg_proc p
  where p.oid=
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;
  if position('source-verified-compact-v1' in v_definition)=0
    or position('payloadHashVerifiedAtSource' in v_definition)=0
    or position('then snapshot.payload' in v_definition)>0
    or position(
      $needle$snapshot.payload-'deliveryPayloadHash'-'contentSignature'$needle$
      in v_definition
    )=0
    or position(
      $needle$snapshot.payload-'contentSignature'$needle$ in v_definition
    )=0
    or v_config is distinct from
      array['search_path=""','statement_timeout=25s']::text[] then
    raise exception 'truth audit compact production-cache witness is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;
