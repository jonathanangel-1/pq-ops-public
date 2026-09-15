-- Bind every post-migration truth build and publication to one canonical
-- processing watermark before any model-backed extractor can join the graph.
-- Existing rows remain explicitly legacy-unwatermarked; no historical row is
-- upgraded by inference or synthetic defaults.

set check_function_bodies = off;

alter table public.truth_build_pair_runs
  add column if not exists processing_watermark_status text not null
    default 'legacy_unwatermarked',
  add column if not exists processing_watermark jsonb,
  add column if not exists processing_watermark_hash text;

alter table public.truth_builds
  add column if not exists processing_watermark_status text not null
    default 'legacy_unwatermarked',
  add column if not exists processing_watermark jsonb,
  add column if not exists processing_watermark_hash text;

alter table public.truth_build_parity_receipts
  add column if not exists processing_watermark_status text not null
    default 'legacy_unwatermarked',
  add column if not exists processing_watermark jsonb,
  add column if not exists processing_watermark_hash text;

alter table public.truth_publications
  add column if not exists processing_watermark_status text not null
    default 'legacy_unwatermarked',
  add column if not exists processing_watermark jsonb,
  add column if not exists processing_watermark_hash text;

alter table public.truth_publication_heads
  add column if not exists processing_watermark_status text not null
    default 'legacy_unwatermarked',
  add column if not exists processing_watermark jsonb,
  add column if not exists processing_watermark_hash text;

alter table public.truth_publication_payloads
  add column if not exists processing_watermark_status text not null
    default 'legacy_unwatermarked',
  add column if not exists processing_watermark jsonb,
  add column if not exists processing_watermark_hash text;

do $block$
declare
  v_table text;
  v_constraint text;
begin
  foreach v_table in array array[
    'truth_build_pair_runs',
    'truth_builds',
    'truth_build_parity_receipts',
    'truth_publications',
    'truth_publication_heads',
    'truth_publication_payloads'
  ] loop
    v_constraint := v_table || '_processing_watermark_shape_check';
    execute format('alter table public.%I drop constraint if exists %I', v_table, v_constraint);
    execute format($sql$
      alter table public.%I add constraint %I check (
        (
          processing_watermark_status = 'legacy_unwatermarked'
          and processing_watermark is null
          and processing_watermark_hash is null
        ) or (
          processing_watermark_status = 'watermarked'
          and jsonb_typeof(processing_watermark) = 'object'
          and processing_watermark_hash ~ '^[0-9a-f]{64}$'
        )
      )
    $sql$, v_table, v_constraint);
  end loop;
end;
$block$;

create index if not exists truth_build_pair_runs_processing_watermark_idx
  on public.truth_build_pair_runs (workspace_key, processing_watermark_hash)
  where processing_watermark_status = 'watermarked';

create index if not exists truth_publications_processing_watermark_idx
  on public.truth_publications (workspace_key, channel, processing_watermark_hash)
  where processing_watermark_status = 'watermarked';

create or replace function private.truth_processing_watermark_exact_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select jsonb_typeof(coalesce(p_value, 'null'::jsonb)) = 'object'
    and (select count(*) from jsonb_object_keys(p_value)) = cardinality(p_keys)
    and not exists (
      select 1
      from jsonb_object_keys(p_value) supplied_key
      where not (supplied_key = any (p_keys))
    )
    and not exists (
      select 1
      from unnest(p_keys) required_key
      where not (p_value ? required_key)
    );
$function$;

create or replace function private.assert_truth_processing_watermark(
  p_status text,
  p_watermark jsonb,
  p_watermark_hash text
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_claim_processors jsonb;
  v_entity_linkers jsonb;
  v_workgroup_creators jsonb;
  v_membership_linkers jsonb;
  v_linker_sets jsonb;
  v_expected_hash text;
begin
  if p_status = 'legacy_unwatermarked' then
    if p_watermark is not null or p_watermark_hash is not null then
      raise exception 'legacy truth processing watermark must be empty'
        using errcode = '23514';
    end if;
    return;
  end if;
  if p_status is distinct from 'watermarked'
    or not private.truth_processing_watermark_exact_keys(
      p_watermark,
      array['schemaVersion', 'configured', 'observed']
    )
    or p_watermark->>'schemaVersion' is distinct from 'truth-processing-watermark-v1'
    or not private.truth_processing_watermark_exact_keys(
      p_watermark->'configured',
      array[
        'model', 'promptVersion', 'extractorVersion', 'entityLinkerVersion',
        'acceptancePolicyVersion', 'configSnapshotVersion', 'configSnapshotHash',
        'reducerVersion', 'packetBuilderVersion', 'packetSchemaVersion',
        'precedencePolicyVersion', 'precedencePolicyHash'
      ]
    )
    or not private.truth_processing_watermark_exact_keys(
      p_watermark->'observed',
      array[
        'claimProcessors', 'entityLinkers', 'workgroupCreators',
        'workgroupMembershipLinkers',
        'extractorSetVersion', 'linkerSetVersion'
      ]
    ) then
    raise exception 'truth processing watermark shape is invalid'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from unnest(array[
      'model', 'promptVersion', 'extractorVersion', 'entityLinkerVersion',
      'acceptancePolicyVersion', 'configSnapshotVersion', 'configSnapshotHash',
      'reducerVersion', 'packetBuilderVersion', 'packetSchemaVersion',
      'precedencePolicyVersion', 'precedencePolicyHash'
    ]) required_key
    where jsonb_typeof(p_watermark->'configured'->required_key) <> 'string'
      or nullif(trim(coalesce(p_watermark->'configured'->>required_key, '')), '') is null
      or octet_length(p_watermark->'configured'->>required_key) > 500
  )
    or coalesce(p_watermark->'configured'->>'configSnapshotHash', '')
      !~ '^[0-9a-f]{64}$'
    or coalesce(p_watermark->'configured'->>'precedencePolicyHash', '')
      !~ '^[0-9a-f]{64}$'
    or p_watermark->'configured'->>'configSnapshotVersion' is distinct from
      'truth-processing-config-snapshot:v1:' ||
        (p_watermark->'configured'->>'configSnapshotHash')
    or jsonb_typeof(p_watermark->'observed'->'claimProcessors') <> 'array'
    or jsonb_typeof(p_watermark->'observed'->'entityLinkers') <> 'array'
    or jsonb_typeof(p_watermark->'observed'->'workgroupCreators') <> 'array'
    or jsonb_typeof(p_watermark->'observed'->'workgroupMembershipLinkers') <> 'array'
    or jsonb_typeof(p_watermark->'observed'->'extractorSetVersion') <> 'string'
    or jsonb_typeof(p_watermark->'observed'->'linkerSetVersion') <> 'string' then
    raise exception 'truth processing watermark identities are invalid'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_watermark->'observed'->'claimProcessors') item
    where not private.truth_processing_watermark_exact_keys(
      item,
      array[
        'extractionMethod', 'extractorVersion', 'promptVersion', 'model',
        'acceptanceMethod', 'acceptancePolicyVersion'
      ]
    )
      or exists (
        select 1
        from unnest(array[
          'extractionMethod', 'extractorVersion', 'promptVersion', 'model',
          'acceptanceMethod', 'acceptancePolicyVersion'
        ]) required_key
        where jsonb_typeof(item->required_key) <> 'string'
          or nullif(trim(coalesce(item->>required_key, '')), '') is null
          or octet_length(item->>required_key) > 500
      )
      or not (item->>'extractionMethod' = any (
        array['deterministic', 'model', 'operator']
      ))
      or not (item->>'acceptanceMethod' = any (array['policy', 'operator']))
  ) or exists (
    select 1
    from jsonb_array_elements(p_watermark->'observed'->'entityLinkers') item
    where not private.truth_processing_watermark_exact_keys(
      item, array['linkMethod', 'linkerVersion']
    )
      or jsonb_typeof(item->'linkMethod') <> 'string'
      or jsonb_typeof(item->'linkerVersion') <> 'string'
      or not (item->>'linkMethod' = any (
        array['deterministic', 'model', 'operator']
      ))
      or nullif(trim(coalesce(item->>'linkerVersion', '')), '') is null
      or octet_length(item->>'linkerVersion') > 500
  ) or exists (
    select 1
    from jsonb_array_elements(p_watermark->'observed'->'workgroupCreators') item
    where not private.truth_processing_watermark_exact_keys(
      item, array['createdMethod', 'linkerVersion']
    )
      or jsonb_typeof(item->'createdMethod') <> 'string'
      or jsonb_typeof(item->'linkerVersion') <> 'string'
      or not (item->>'createdMethod' = any (
        array['deterministic', 'model', 'operator']
      ))
      or nullif(trim(coalesce(item->>'linkerVersion', '')), '') is null
      or octet_length(item->>'linkerVersion') > 500
  ) or exists (
    select 1
    from jsonb_array_elements(
      p_watermark->'observed'->'workgroupMembershipLinkers'
    ) item
    where not private.truth_processing_watermark_exact_keys(
      item, array['membershipMethod', 'linkerVersion']
    )
      or jsonb_typeof(item->'membershipMethod') <> 'string'
      or jsonb_typeof(item->'linkerVersion') <> 'string'
      or not (item->>'membershipMethod' = any (
        array['deterministic', 'model', 'operator']
      ))
      or nullif(trim(coalesce(item->>'linkerVersion', '')), '') is null
      or octet_length(item->>'linkerVersion') > 500
  ) then
    raise exception 'truth processing watermark observed tuples are invalid'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(item order by (item::text) collate "C"), '[]'::jsonb)
  into v_claim_processors
  from (
    select distinct item
    from jsonb_array_elements(p_watermark->'observed'->'claimProcessors') item
  ) canonical;
  select coalesce(jsonb_agg(item order by (item::text) collate "C"), '[]'::jsonb)
  into v_entity_linkers
  from (
    select distinct item
    from jsonb_array_elements(p_watermark->'observed'->'entityLinkers') item
  ) canonical;
  select coalesce(jsonb_agg(item order by (item::text) collate "C"), '[]'::jsonb)
  into v_workgroup_creators
  from (
    select distinct item
    from jsonb_array_elements(p_watermark->'observed'->'workgroupCreators') item
  ) canonical;
  select coalesce(jsonb_agg(item order by (item::text) collate "C"), '[]'::jsonb)
  into v_membership_linkers
  from (
    select distinct item
    from jsonb_array_elements(
      p_watermark->'observed'->'workgroupMembershipLinkers'
    ) item
  ) canonical;
  v_linker_sets := jsonb_build_object(
    'entityLinkers', v_entity_linkers,
    'workgroupCreators', v_workgroup_creators,
    'workgroupMembershipLinkers', v_membership_linkers
  );
  if p_watermark->'observed'->'claimProcessors' is distinct from v_claim_processors
    or p_watermark->'observed'->'entityLinkers' is distinct from v_entity_linkers
    or p_watermark->'observed'->'workgroupCreators' is distinct from v_workgroup_creators
    or p_watermark->'observed'->'workgroupMembershipLinkers'
      is distinct from v_membership_linkers
    or p_watermark->'observed'->>'extractorSetVersion' is distinct from
      'extractor-set:v2:' || encode(extensions.digest(
        convert_to(v_claim_processors::text, 'UTF8'), 'sha256'
      ), 'hex')
    or p_watermark->'observed'->>'linkerSetVersion' is distinct from
      'linker-set:v2:' || encode(extensions.digest(
        convert_to(v_linker_sets::text, 'UTF8'), 'sha256'
      ), 'hex') then
    raise exception 'truth processing watermark observed sets are noncanonical'
      using errcode = '23514';
  end if;

  v_expected_hash := encode(extensions.digest(
    convert_to(p_watermark::text, 'UTF8'), 'sha256'
  ), 'hex');
  if coalesce(p_watermark_hash, '') !~ '^[0-9a-f]{64}$'
    or p_watermark_hash is distinct from v_expected_hash then
    raise exception 'truth processing watermark hash is invalid'
      using errcode = '23514';
  end if;
end;
$function$;

create or replace function private.prepare_truth_build_pair_processing_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receipt jsonb;
begin
  v_receipt := private.derive_truth_processing_watermark(
    new.workspace_key,
    new.source_cut_id,
    new.source_watermark->'processingWatermark'->'configured'
  );
  if new.source_watermark->>'processingWatermarkStatus'
      is distinct from v_receipt->>'processingWatermarkStatus'
    or new.source_watermark->'processingWatermark'
      is distinct from v_receipt->'processingWatermark'
    or new.source_watermark->>'processingWatermarkHash'
      is distinct from v_receipt->>'processingWatermarkHash'
    or new.extractor_set_version is distinct from
      v_receipt->'processingWatermark'->'observed'->>'extractorSetVersion'
    or new.linker_version is distinct from
      v_receipt->'processingWatermark'->'observed'->>'linkerSetVersion' then
    raise exception 'truth build pair processing watermark is not server-derived'
      using errcode = '23514';
  end if;
  new.processing_watermark_status := v_receipt->>'processingWatermarkStatus';
  new.processing_watermark := v_receipt->'processingWatermark';
  new.processing_watermark_hash := v_receipt->>'processingWatermarkHash';
  perform private.assert_truth_processing_watermark(
    new.processing_watermark_status,
    new.processing_watermark,
    new.processing_watermark_hash
  );
  return new;
end;
$function$;

drop trigger if exists truth_build_pair_processing_watermark_prepare
  on public.truth_build_pair_runs;
create trigger truth_build_pair_processing_watermark_prepare
before insert on public.truth_build_pair_runs
for each row execute function private.prepare_truth_build_pair_processing_watermark();

create or replace function private.prepare_truth_build_processing_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
begin
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = new.build_pair_id
    and pair.workspace_key = new.workspace_key;
  if not found
    or v_pair.processing_watermark_status <> 'watermarked'
    or new.source_cut_id is distinct from v_pair.source_cut_id
    or new.input_manifest_hash is distinct from v_pair.input_manifest_hash
    or new.source_watermark is distinct from v_pair.source_watermark then
    raise exception 'truth build processing watermark does not match its pair'
      using errcode = '23514';
  end if;
  new.processing_watermark_status := v_pair.processing_watermark_status;
  new.processing_watermark := v_pair.processing_watermark;
  new.processing_watermark_hash := v_pair.processing_watermark_hash;
  perform private.assert_truth_processing_watermark(
    new.processing_watermark_status,
    new.processing_watermark,
    new.processing_watermark_hash
  );
  return new;
end;
$function$;

drop trigger if exists truth_build_processing_watermark_prepare
  on public.truth_builds;
create trigger truth_build_processing_watermark_prepare
before insert on public.truth_builds
for each row execute function private.prepare_truth_build_processing_watermark();

create or replace function public.guard_truth_build_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth_builds is append-only' using errcode = '55000';
  end if;
  if old.status <> 'running' then
    raise exception 'final truth builds are immutable' using errcode = '55000';
  end if;
  if row(
    new.build_id, new.build_pair_id, new.workspace_key, new.source_cut_id,
    new.build_mode, new.channel, new.trigger_name, new.base_publication_id,
    new.input_manifest_hash, new.claim_manifest_hash, new.link_manifest_hash,
    new.workgroup_manifest_hash, new.extractor_set_version, new.linker_version,
    new.reducer_version, new.packet_builder_version, new.packet_schema_version,
    new.precedence_policy_version, new.precedence_policy_hash,
    new.shipment_metadata_manifest_hash, new.source_watermark,
    new.processing_watermark_status, new.processing_watermark,
    new.processing_watermark_hash, new.started_at
  ) is distinct from row(
    old.build_id, old.build_pair_id, old.workspace_key, old.source_cut_id,
    old.build_mode, old.channel, old.trigger_name, old.base_publication_id,
    old.input_manifest_hash, old.claim_manifest_hash, old.link_manifest_hash,
    old.workgroup_manifest_hash, old.extractor_set_version, old.linker_version,
    old.reducer_version, old.packet_builder_version, old.packet_schema_version,
    old.precedence_policy_version, old.precedence_policy_hash,
    old.shipment_metadata_manifest_hash, old.source_watermark,
    old.processing_watermark_status, old.processing_watermark,
    old.processing_watermark_hash, old.started_at
  ) then
    raise exception 'truth build manifest fields are immutable' using errcode = '55000';
  end if;
  if new.status = 'succeeded' then
    if new.processing_watermark_status <> 'watermarked'
      or new.packet_hash is null or new.semantic_hash is null
      or new.packet_canonical_text is null or new.packet_payload is null
      or new.finished_at is null then
      raise exception 'successful truth build is incomplete' using errcode = '23514';
    end if;
  elsif new.status = 'failed' then
    if nullif(trim(coalesce(new.error_code, '')), '') is null
      or new.finished_at is null then
      raise exception 'failed truth build requires an error code and finish time'
        using errcode = '23514';
    end if;
  else
    raise exception 'truth build may only transition from running to a final state'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function public.guard_truth_build_pair_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth build pair runs cannot be deleted' using errcode = '55000';
  end if;
  if old.status <> 'running' then
    raise exception 'final truth build pair runs are immutable' using errcode = '55000';
  end if;
  if row(
    new.build_pair_id, new.workspace_key, new.idempotency_key,
    new.caller_request_hash, new.source_cut_id, new.build_channel,
    new.publication_channel, new.trigger_name, new.base_publication_id,
    new.full_build_id, new.incremental_build_id, new.input_manifest_hash,
    new.claim_manifest_hash, new.link_manifest_hash,
    new.workgroup_manifest_hash, new.workgroup_definition_manifest_hash,
    new.extractor_set_version, new.linker_version, new.reducer_version,
    new.packet_builder_version, new.packet_schema_version,
    new.precedence_policy_version, new.precedence_policy_hash,
    new.shipment_metadata_manifest_hash, new.shipment_metadata_row_count,
    new.source_watermark, new.processing_watermark_status,
    new.processing_watermark, new.processing_watermark_hash,
    new.bundle_row_count, new.bundle_row_limit, new.started_at
  ) is distinct from row(
    old.build_pair_id, old.workspace_key, old.idempotency_key,
    old.caller_request_hash, old.source_cut_id, old.build_channel,
    old.publication_channel, old.trigger_name, old.base_publication_id,
    old.full_build_id, old.incremental_build_id, old.input_manifest_hash,
    old.claim_manifest_hash, old.link_manifest_hash,
    old.workgroup_manifest_hash, old.workgroup_definition_manifest_hash,
    old.extractor_set_version, old.linker_version, old.reducer_version,
    old.packet_builder_version, old.packet_schema_version,
    old.precedence_policy_version, old.precedence_policy_hash,
    old.shipment_metadata_manifest_hash, old.shipment_metadata_row_count,
    old.source_watermark, old.processing_watermark_status,
    old.processing_watermark, old.processing_watermark_hash,
    old.bundle_row_count, old.bundle_row_limit, old.started_at
  ) then
    raise exception 'truth build pair immutable manifest changed' using errcode = '55000';
  end if;
  if new.lease_fence < old.lease_fence
    or new.attempt_count < old.attempt_count then
    raise exception 'truth build pair lease fence regressed' using errcode = '55000';
  end if;
  if new.status = 'running' then
    if new.packet_hash is not null or new.reducer_output_hash is not null
      or new.reducer_packet_hash is not null
      or new.semantic_hash is not null or new.finished_at is not null
      or new.error_code <> '' then
      raise exception 'running truth build pair carries final state' using errcode = '23514';
    end if;
  elsif new.status = 'succeeded' then
    if new.processing_watermark_status <> 'watermarked'
      or new.packet_hash is null or new.reducer_output_hash is null
      or new.reducer_packet_hash is null
      or new.semantic_hash is null or new.finished_at is null
      or not exists (
        select 1 from public.truth_build_parity_receipts receipt
        where receipt.build_pair_id = old.build_pair_id
          and receipt.full_build_id = old.full_build_id
          and receipt.incremental_build_id = old.incremental_build_id
          and receipt.processing_watermark_status = 'watermarked'
          and receipt.processing_watermark_hash = old.processing_watermark_hash
      ) then
      raise exception 'successful truth build pair lacks watermarked parity proof'
        using errcode = '23514';
    end if;
  elsif new.status = 'failed' then
    if nullif(trim(new.error_code), '') is null or new.finished_at is null then
      raise exception 'failed truth build pair lacks durable error evidence'
        using errcode = '23514';
    end if;
  else
    raise exception 'unsupported truth build pair transition' using errcode = '55000';
  end if;
  return new;
end;
$function$;

-- Capture the current 405 manifest derivation, which already includes the
-- immutable TMS shipment-metadata manifest. Never bypass it by calling the
-- older v2 core directly.
do $block$
begin
  if to_regprocedure(
    'private.derive_truth_build_candidate_manifest_pre_processing_watermark(text,text,jsonb)'
  ) is null then
    alter function private.derive_truth_build_candidate_manifest(text, text, jsonb)
      rename to derive_truth_build_candidate_manifest_pre_processing_watermark;
  end if;
end;
$block$;

create or replace function private.derive_truth_processing_watermark(
  p_workspace_key text,
  p_source_cut_id text,
  p_configured jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_base jsonb;
  v_legacy_versions jsonb;
  v_claim_processors jsonb;
  v_entity_linkers jsonb;
  v_workgroup_creators jsonb;
  v_membership_linkers jsonb;
  v_linker_sets jsonb;
  v_extractor_set_version text;
  v_linker_set_version text;
  v_watermark jsonb;
  v_watermark_hash text;
begin
  if not private.truth_processing_watermark_exact_keys(
    p_configured,
    array[
      'model', 'promptVersion', 'extractorVersion', 'entityLinkerVersion',
      'acceptancePolicyVersion', 'configSnapshotVersion', 'configSnapshotHash',
      'reducerVersion', 'packetBuilderVersion', 'packetSchemaVersion',
      'precedencePolicyVersion', 'precedencePolicyHash'
    ]
  ) then
    raise exception 'truth processing configured vector is invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'model', 'promptVersion', 'extractorVersion', 'entityLinkerVersion',
      'acceptancePolicyVersion', 'configSnapshotVersion', 'configSnapshotHash',
      'reducerVersion', 'packetBuilderVersion', 'packetSchemaVersion',
      'precedencePolicyVersion', 'precedencePolicyHash'
    ]) required_key
    where jsonb_typeof(p_configured->required_key) <> 'string'
      or nullif(trim(coalesce(p_configured->>required_key, '')), '') is null
      or octet_length(p_configured->>required_key) > 500
  )
    or coalesce(p_configured->>'configSnapshotHash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_configured->>'precedencePolicyHash', '') !~ '^[0-9a-f]{64}$'
    or p_configured->>'configSnapshotVersion' is distinct from
      'truth-processing-config-snapshot:v1:' || (p_configured->>'configSnapshotHash') then
    raise exception 'truth processing configured identities are invalid'
      using errcode = '22023';
  end if;

  v_legacy_versions := jsonb_build_object(
    'reducerVersion', p_configured->>'reducerVersion',
    'packetBuilderVersion', p_configured->>'packetBuilderVersion',
    'packetSchemaVersion', p_configured->>'packetSchemaVersion',
    'precedencePolicyVersion', p_configured->>'precedencePolicyVersion',
    'precedencePolicyHash', p_configured->>'precedencePolicyHash'
  );
  v_base := private.derive_truth_build_candidate_manifest_pre_processing_watermark(
    p_workspace_key, p_source_cut_id, v_legacy_versions
  );

  if exists (
    select 1
    from jsonb_array_elements(v_base->'claimInputs') item
    join public.accepted_claims claim
      on claim.claim_version_id = item->>'itemId'
    where claim.extraction_method = 'model'
      and (
        nullif(trim(claim.prompt_version), '') is null
        or nullif(trim(claim.model), '') is null
      )
  ) then
    raise exception 'model-derived accepted claim lacks model or prompt identity'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(version_row order by (version_row::text) collate "C"), '[]'::jsonb)
  into v_claim_processors
  from (
    select distinct jsonb_build_object(
      'extractionMethod', claim.extraction_method,
      'extractorVersion', claim.extractor_version,
      'promptVersion', coalesce(nullif(claim.prompt_version, ''), 'deterministic:none'),
      'model', coalesce(nullif(claim.model, ''), 'deterministic:none'),
      'acceptanceMethod', claim.acceptance_method,
      'acceptancePolicyVersion', claim.acceptance_policy_version
    ) as version_row
    from jsonb_array_elements(v_base->'claimInputs') item
    join public.accepted_claims claim
      on claim.claim_version_id = item->>'itemId'
  ) versions;

  select coalesce(jsonb_agg(version_row order by (version_row::text) collate "C"), '[]'::jsonb)
  into v_entity_linkers
  from (
    select distinct jsonb_build_object(
      'linkMethod', entity_link.link_method,
      'linkerVersion', entity_link.linker_version
    ) as version_row
    from jsonb_array_elements(v_base->'linkInputs') item
    join public.observation_entity_links entity_link
      on entity_link.link_version_id = item->>'itemId'
  ) versions;

  select coalesce(jsonb_agg(version_row order by (version_row::text) collate "C"), '[]'::jsonb)
  into v_workgroup_creators
  from (
    select distinct jsonb_build_object(
      'createdMethod', workgroup.created_method,
      'linkerVersion', workgroup.linker_version
    ) as version_row
    from jsonb_array_elements(v_base->'workgroupDefinitions') item
    join public.operational_workgroups_v2 workgroup
      on workgroup.workgroup_id = item->>'workgroupId'
     and workgroup.workspace_key = p_workspace_key
  ) versions;

  select coalesce(jsonb_agg(version_row order by (version_row::text) collate "C"), '[]'::jsonb)
  into v_membership_linkers
  from (
    select distinct jsonb_build_object(
      'membershipMethod', membership.membership_method,
      'linkerVersion', membership.linker_version
    ) as version_row
    from jsonb_array_elements(v_base->'workgroupMembershipInputs') item
    join public.operational_workgroup_memberships membership
      on membership.membership_version_id = item->>'itemId'
  ) versions;

  v_linker_sets := jsonb_build_object(
    'entityLinkers', v_entity_linkers,
    'workgroupCreators', v_workgroup_creators,
    'workgroupMembershipLinkers', v_membership_linkers
  );
  v_extractor_set_version := 'extractor-set:v2:' || encode(extensions.digest(
    convert_to(v_claim_processors::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_linker_set_version := 'linker-set:v2:' || encode(extensions.digest(
    convert_to(v_linker_sets::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_watermark := jsonb_build_object(
    'schemaVersion', 'truth-processing-watermark-v1',
    'configured', p_configured,
    'observed', jsonb_build_object(
      'claimProcessors', v_claim_processors,
      'entityLinkers', v_entity_linkers,
      'workgroupCreators', v_workgroup_creators,
      'workgroupMembershipLinkers', v_membership_linkers,
      'extractorSetVersion', v_extractor_set_version,
      'linkerSetVersion', v_linker_set_version
    )
  );
  v_watermark_hash := encode(extensions.digest(
    convert_to(v_watermark::text, 'UTF8'), 'sha256'
  ), 'hex');
  perform private.assert_truth_processing_watermark(
    'watermarked', v_watermark, v_watermark_hash
  );
  return jsonb_build_object(
    'processingWatermarkStatus', 'watermarked',
    'processingWatermark', v_watermark,
    'processingWatermarkHash', v_watermark_hash
  );
end;
$function$;

create or replace function private.derive_truth_build_candidate_manifest(
  p_workspace_key text,
  p_source_cut_id text,
  p_versions jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_legacy_versions jsonb;
  v_base jsonb;
  v_watermark_receipt jsonb;
  v_input_manifest jsonb;
  v_input_manifest_hash text;
  v_source_watermark jsonb;
begin
  v_watermark_receipt := private.derive_truth_processing_watermark(
    p_workspace_key, p_source_cut_id, p_versions
  );
  v_legacy_versions := jsonb_build_object(
    'reducerVersion', p_versions->>'reducerVersion',
    'packetBuilderVersion', p_versions->>'packetBuilderVersion',
    'packetSchemaVersion', p_versions->>'packetSchemaVersion',
    'precedencePolicyVersion', p_versions->>'precedencePolicyVersion',
    'precedencePolicyHash', p_versions->>'precedencePolicyHash'
  );
  v_base := private.derive_truth_build_candidate_manifest_pre_processing_watermark(
    p_workspace_key, p_source_cut_id, v_legacy_versions
  );
  v_input_manifest := (v_base->'inputManifest') || jsonb_build_object(
    'schemaVersion', 'truth-build-input-manifest-v4',
    'versions', p_versions,
    'processingWatermarkStatus', v_watermark_receipt->>'processingWatermarkStatus',
    'processingWatermark', v_watermark_receipt->'processingWatermark',
    'processingWatermarkHash', v_watermark_receipt->>'processingWatermarkHash'
  );
  v_input_manifest_hash := encode(extensions.digest(
    convert_to(v_input_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_source_watermark := (v_base->'sourceWatermark') || jsonb_build_object(
    'processingWatermarkStatus', v_watermark_receipt->>'processingWatermarkStatus',
    'processingWatermark', v_watermark_receipt->'processingWatermark',
    'processingWatermarkHash', v_watermark_receipt->>'processingWatermarkHash'
  );
  return v_base || jsonb_build_object(
    'inputManifest', v_input_manifest,
    'inputManifestHash', v_input_manifest_hash,
    'extractorSetVersion',
      v_watermark_receipt->'processingWatermark'->'observed'->>'extractorSetVersion',
    'linkerVersion',
      v_watermark_receipt->'processingWatermark'->'observed'->>'linkerSetVersion',
    'sourceWatermark', v_source_watermark,
    'processingWatermarkStatus', v_watermark_receipt->>'processingWatermarkStatus',
    'processingWatermark', v_watermark_receipt->'processingWatermark',
    'processingWatermarkHash', v_watermark_receipt->>'processingWatermarkHash'
  );
end;
$function$;

do $block$
begin
  if to_regprocedure(
    'private.truth_build_bundle_from_inputs_pre_processing_watermark(uuid)'
  ) is null then
    alter function private.truth_build_bundle_from_inputs(uuid)
      rename to truth_build_bundle_from_inputs_pre_processing_watermark;
  end if;
end;
$block$;

create or replace function private.truth_build_bundle_from_inputs(
  p_build_pair_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_bundle jsonb;
begin
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = p_build_pair_id;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  v_bundle := private.truth_build_bundle_from_inputs_pre_processing_watermark(
    p_build_pair_id
  );
  if v_pair.processing_watermark_status <> 'watermarked'
    or v_bundle->>'inputManifestHash' is distinct from v_pair.input_manifest_hash
    or v_bundle->'sourceWatermark' is distinct from v_pair.source_watermark then
    raise exception 'truth build bundle processing identity is incomplete'
      using errcode = '23514';
  end if;
  perform private.assert_truth_processing_watermark(
    v_pair.processing_watermark_status,
    v_pair.processing_watermark,
    v_pair.processing_watermark_hash
  );
  return v_bundle || jsonb_build_object(
    'processingWatermarkStatus', v_pair.processing_watermark_status,
    'processingWatermark', v_pair.processing_watermark,
    'processingWatermarkHash', v_pair.processing_watermark_hash
  );
end;
$function$;

create or replace function private.truth_build_pair_receipt(
  p_pair public.truth_build_pair_runs,
  p_idempotent boolean,
  p_busy boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'ok', not p_busy,
    'status', case when p_busy then 'busy' else p_pair.status end,
    'code', case when p_busy then 'TRUTH_BUILD_BUSY' else null end,
    'idempotent', p_idempotent,
    'buildPairId', p_pair.build_pair_id,
    'workspaceKey', p_pair.workspace_key,
    'sourceCutId', p_pair.source_cut_id,
    'buildChannel', p_pair.build_channel,
    'publicationChannel', p_pair.publication_channel,
    'basePublicationId', p_pair.base_publication_id,
    'fullBuildId', p_pair.full_build_id,
    'incrementalBuildId', p_pair.incremental_build_id,
    'inputManifestHash', p_pair.input_manifest_hash,
    'shipmentMetadataManifestHash', p_pair.shipment_metadata_manifest_hash,
    'processingWatermarkStatus', p_pair.processing_watermark_status,
    'processingWatermark', p_pair.processing_watermark,
    'processingWatermarkHash', p_pair.processing_watermark_hash,
    'bundleRowCount', p_pair.bundle_row_count,
    'shipmentMetadataRowCount', p_pair.shipment_metadata_row_count,
    'bundleRowLimit', p_pair.bundle_row_limit,
    'leaseOwner', p_pair.lease_owner,
    'leaseFence', p_pair.lease_fence,
    'leaseExpiresAt', p_pair.lease_expires_at,
    'attemptCount', p_pair.attempt_count,
    'packetHash', p_pair.packet_hash,
    'reducerOutputHash', p_pair.reducer_output_hash,
    'reducerPacketHash', p_pair.reducer_packet_hash,
    'semanticHash', p_pair.semantic_hash,
    'errorCode', nullif(p_pair.error_code, ''),
    'safeErrorDetail', nullif(p_pair.safe_error_detail, ''),
    'finishedAt', p_pair.finished_at
  ));
$function$;

create or replace function private.prepare_truth_build_parity_processing_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_full public.truth_builds%rowtype;
  v_incremental public.truth_builds%rowtype;
begin
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = new.build_pair_id;
  select * into v_full
  from public.truth_builds build
  where build.build_id = new.full_build_id;
  select * into v_incremental
  from public.truth_builds build
  where build.build_id = new.incremental_build_id;
  if v_pair.build_pair_id is null
    or v_pair.processing_watermark_status <> 'watermarked'
    or v_full.build_id is null or v_incremental.build_id is null
    or v_full.build_pair_id is distinct from v_pair.build_pair_id
    or v_incremental.build_pair_id is distinct from v_pair.build_pair_id
    or v_full.processing_watermark_hash is distinct from v_pair.processing_watermark_hash
    or v_incremental.processing_watermark_hash
      is distinct from v_pair.processing_watermark_hash
    or v_full.input_manifest_hash is distinct from v_pair.input_manifest_hash
    or v_incremental.input_manifest_hash is distinct from v_pair.input_manifest_hash then
    raise exception 'truth build parity processing watermark is divergent'
      using errcode = '23514';
  end if;
  new.processing_watermark_status := v_pair.processing_watermark_status;
  new.processing_watermark := v_pair.processing_watermark;
  new.processing_watermark_hash := v_pair.processing_watermark_hash;
  perform private.assert_truth_processing_watermark(
    new.processing_watermark_status,
    new.processing_watermark,
    new.processing_watermark_hash
  );
  return new;
end;
$function$;

drop trigger if exists truth_build_parity_processing_watermark_prepare
  on public.truth_build_parity_receipts;
create trigger truth_build_parity_processing_watermark_prepare
before insert on public.truth_build_parity_receipts
for each row execute function private.prepare_truth_build_parity_processing_watermark();

do $block$
begin
  if to_regprocedure(
    'private.complete_truth_build_pair_pre_processing_watermark(uuid,text,bigint,jsonb,jsonb,text,text,jsonb,jsonb,text)'
  ) is null then
    alter function private.complete_truth_build_pair(
      uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text
    ) rename to complete_truth_build_pair_pre_processing_watermark;
  end if;
end;
$block$;

create or replace function private.complete_truth_build_pair(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_full_packet jsonb,
  p_incremental_packet jsonb,
  p_full_semantic_hash text,
  p_incremental_semantic_hash text,
  p_full_validation_report jsonb,
  p_incremental_validation_report jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_full_reducer jsonb;
  v_incremental_reducer jsonb;
begin
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = p_build_pair_id;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  if v_pair.processing_watermark_status <> 'watermarked' then
    raise exception 'legacy-unwatermarked truth build cannot complete'
      using errcode = '23514';
  end if;
  perform private.assert_truth_processing_watermark(
    v_pair.processing_watermark_status,
    v_pair.processing_watermark,
    v_pair.processing_watermark_hash
  );
  v_full_reducer := p_full_validation_report->'internalReducerOutput';
  v_incremental_reducer := p_incremental_validation_report->'internalReducerOutput';
  if v_full_reducer->>'inputManifestHash' is distinct from v_pair.input_manifest_hash
    or v_incremental_reducer->>'inputManifestHash'
      is distinct from v_pair.input_manifest_hash
    or p_full_packet->'truthProvenance'->>'inputManifestHash'
      is distinct from v_pair.input_manifest_hash
    or p_incremental_packet->'truthProvenance'->>'inputManifestHash'
      is distinct from v_pair.input_manifest_hash then
    raise exception 'truth build input manifest is not bound to its claimed pair'
      using errcode = '23514';
  end if;
  if v_full_reducer->'sourceWatermark'->>'processingWatermarkStatus'
      is distinct from v_pair.processing_watermark_status
    or v_full_reducer->'sourceWatermark'->'processingWatermark'
      is distinct from v_pair.processing_watermark
    or v_full_reducer->'sourceWatermark'->>'processingWatermarkHash'
      is distinct from v_pair.processing_watermark_hash
    or v_incremental_reducer->'sourceWatermark'->>'processingWatermarkStatus'
      is distinct from v_pair.processing_watermark_status
    or v_incremental_reducer->'sourceWatermark'->'processingWatermark'
      is distinct from v_pair.processing_watermark
    or v_incremental_reducer->'sourceWatermark'->>'processingWatermarkHash'
      is distinct from v_pair.processing_watermark_hash
    or p_full_packet->'truthProvenance'->>'processingWatermarkStatus'
      is distinct from v_pair.processing_watermark_status
    or p_full_packet->'truthProvenance'->'processingWatermark'
      is distinct from v_pair.processing_watermark
    or p_full_packet->'truthProvenance'->>'processingWatermarkHash'
      is distinct from v_pair.processing_watermark_hash
    or p_incremental_packet->'truthProvenance'->>'processingWatermarkStatus'
      is distinct from v_pair.processing_watermark_status
    or p_incremental_packet->'truthProvenance'->'processingWatermark'
      is distinct from v_pair.processing_watermark
    or p_incremental_packet->'truthProvenance'->>'processingWatermarkHash'
      is distinct from v_pair.processing_watermark_hash then
    raise exception 'truth build output processing watermark is incomplete or divergent'
      using errcode = '23514';
  end if;
  return private.complete_truth_build_pair_pre_processing_watermark(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence,
    p_full_packet,
    p_incremental_packet,
    p_full_semantic_hash,
    p_incremental_semantic_hash,
    p_full_validation_report,
    p_incremental_validation_report,
    p_sync_token
  );
end;
$function$;

create or replace function private.validate_truth_build_processing_watermark_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
begin
  if new.status <> 'succeeded' or old.status = 'succeeded' then
    return new;
  end if;
  select * into v_pair
  from public.truth_build_pair_runs pair
  where pair.build_pair_id = new.build_pair_id
    and pair.workspace_key = new.workspace_key;
  if not found
    or new.processing_watermark_status <> 'watermarked'
    or new.processing_watermark is distinct from v_pair.processing_watermark
    or new.processing_watermark_hash is distinct from v_pair.processing_watermark_hash
    or new.input_manifest_hash is distinct from v_pair.input_manifest_hash
    or new.packet_payload->'truthProvenance'->>'inputManifestHash'
      is distinct from v_pair.input_manifest_hash
    or new.packet_payload->'truthProvenance'->>'processingWatermarkStatus'
      is distinct from v_pair.processing_watermark_status
    or new.packet_payload->'truthProvenance'->'processingWatermark'
      is distinct from v_pair.processing_watermark
    or new.packet_payload->'truthProvenance'->>'processingWatermarkHash'
      is distinct from v_pair.processing_watermark_hash then
    raise exception 'successful truth build lacks immutable processing provenance'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_build_processing_watermark_complete_validate
  on public.truth_builds;
create trigger truth_build_processing_watermark_complete_validate
before update of status, packet_payload, validation_report on public.truth_builds
for each row execute function private.validate_truth_build_processing_watermark_completion();

create or replace function private.prepare_truth_publication_processing_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_build public.truth_builds%rowtype;
  v_published_at_text text;
  v_delivery_core jsonb;
  v_delivery_hash text;
begin
  select * into v_build
  from public.truth_builds build
  where build.build_id = new.build_id
    and build.workspace_key = new.workspace_key
    and build.source_cut_id = new.source_cut_id;
  if not found
    or v_build.status <> 'succeeded'
    or v_build.processing_watermark_status <> 'watermarked'
    or new.packet_hash is distinct from v_build.packet_hash
    or v_build.packet_payload->'truthProvenance'->>'inputManifestHash'
      is distinct from v_build.input_manifest_hash
    or v_build.packet_payload->'truthProvenance'->>'processingWatermarkStatus'
      is distinct from v_build.processing_watermark_status
    or v_build.packet_payload->'truthProvenance'->'processingWatermark'
      is distinct from v_build.processing_watermark
    or v_build.packet_payload->'truthProvenance'->>'processingWatermarkHash'
      is distinct from v_build.processing_watermark_hash then
    raise exception 'legacy or divergent truth build cannot be published'
      using errcode = '23514';
  end if;
  new.processing_watermark_status := v_build.processing_watermark_status;
  new.processing_watermark := v_build.processing_watermark;
  new.processing_watermark_hash := v_build.processing_watermark_hash;
  perform private.assert_truth_processing_watermark(
    new.processing_watermark_status,
    new.processing_watermark,
    new.processing_watermark_hash
  );
  v_published_at_text := to_char(
    new.published_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_delivery_core := v_build.packet_payload || jsonb_build_object(
    'publicationId', new.publication_id,
    'publicationVersion', new.publication_version,
    'publicationChannel', new.channel,
    'publishedAt', v_published_at_text,
    'publisherVersion', new.publisher_version,
    'sourceCutId', new.source_cut_id,
    'processingWatermarkStatus', new.processing_watermark_status,
    'processingWatermark', new.processing_watermark,
    'processingWatermarkHash', new.processing_watermark_hash
  );
  v_delivery_hash := encode(extensions.digest(
    convert_to(v_delivery_core::text, 'UTF8'), 'sha256'
  ), 'hex');
  new.delivery_payload_hash := v_delivery_hash;
  return new;
end;
$function$;

drop trigger if exists truth_publication_processing_watermark_prepare
  on public.truth_publications;
create trigger truth_publication_processing_watermark_prepare
before insert on public.truth_publications
for each row execute function private.prepare_truth_publication_processing_watermark();

create or replace function private.prepare_truth_publication_payload_processing_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_publication public.truth_publications%rowtype;
  v_delivery_core jsonb;
  v_delivery_hash text;
  v_active_index_core jsonb;
  v_active_index_hash text;
begin
  select * into v_publication
  from public.truth_publications publication
  where publication.publication_id = new.publication_id;
  if not found
    or v_publication.processing_watermark_status <> 'watermarked'
    or new.workspace_key is distinct from v_publication.workspace_key
    or new.channel is distinct from v_publication.channel
    or new.publication_version is distinct from v_publication.publication_version
    or new.source_cut_id is distinct from v_publication.source_cut_id
    or new.packet_hash is distinct from v_publication.packet_hash then
    raise exception 'truth publication payload processing identity is invalid'
      using errcode = '23514';
  end if;
  if (new.delivery_payload ? 'processingWatermarkStatus'
      and new.delivery_payload->>'processingWatermarkStatus'
        is distinct from v_publication.processing_watermark_status)
    or (new.delivery_payload ? 'processingWatermark'
      and new.delivery_payload->'processingWatermark'
        is distinct from v_publication.processing_watermark)
    or (new.delivery_payload ? 'processingWatermarkHash'
      and new.delivery_payload->>'processingWatermarkHash'
        is distinct from v_publication.processing_watermark_hash) then
    raise exception 'caller-supplied publication watermark conflicts with build authority'
      using errcode = '23514';
  end if;
  new.processing_watermark_status := v_publication.processing_watermark_status;
  new.processing_watermark := v_publication.processing_watermark;
  new.processing_watermark_hash := v_publication.processing_watermark_hash;
  v_delivery_core := (
    new.delivery_payload
      - 'deliveryPayloadHash'
      - 'contentSignature'
      - 'processingWatermarkStatus'
      - 'processingWatermark'
      - 'processingWatermarkHash'
  ) || jsonb_build_object(
    'processingWatermarkStatus', new.processing_watermark_status,
    'processingWatermark', new.processing_watermark,
    'processingWatermarkHash', new.processing_watermark_hash
  );
  v_delivery_hash := encode(extensions.digest(
    convert_to(v_delivery_core::text, 'UTF8'), 'sha256'
  ), 'hex');
  if v_delivery_hash is distinct from v_publication.delivery_payload_hash then
    raise exception 'truth publication delivery watermark hash is inconsistent'
      using errcode = '23514';
  end if;
  new.delivery_payload := v_delivery_core || jsonb_build_object(
    'deliveryPayloadHash', v_delivery_hash,
    'contentSignature', v_delivery_hash
  );
  new.delivery_canonical_text := new.delivery_payload::text;
  new.delivery_payload_hash := v_delivery_hash;

  v_active_index_core := (
    new.active_index_payload
      - 'contentSignature'
      - 'processingWatermarkStatus'
      - 'processingWatermarkHash'
  ) || jsonb_build_object(
    'truthPacketContentSignature', v_delivery_hash,
    'processingWatermarkStatus', new.processing_watermark_status,
    'processingWatermarkHash', new.processing_watermark_hash
  );
  v_active_index_hash := encode(extensions.digest(
    convert_to(v_active_index_core::text, 'UTF8'), 'sha256'
  ), 'hex');
  new.active_index_payload := v_active_index_core || jsonb_build_object(
    'contentSignature', v_active_index_hash
  );
  new.active_index_hash := v_active_index_hash;
  return new;
end;
$function$;

drop trigger if exists truth_publication_payload_processing_watermark_prepare
  on public.truth_publication_payloads;
create trigger truth_publication_payload_processing_watermark_prepare
before insert on public.truth_publication_payloads
for each row execute function private.prepare_truth_publication_payload_processing_watermark();

create or replace function private.prepare_truth_publication_head_processing_watermark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_publication public.truth_publications%rowtype;
  v_payload public.truth_publication_payloads%rowtype;
begin
  select * into v_publication
  from public.truth_publications publication
  where publication.publication_id = new.publication_id;
  select * into v_payload
  from public.truth_publication_payloads payload
  where payload.publication_id = new.publication_id;
  if v_publication.publication_id is null or v_payload.publication_id is null
    or new.workspace_key is distinct from v_publication.workspace_key
    or new.channel is distinct from v_publication.channel
    or new.publication_version is distinct from v_publication.publication_version
    or new.packet_hash is distinct from v_publication.packet_hash
    or new.source_cut_id is distinct from v_publication.source_cut_id
    or v_payload.processing_watermark_hash
      is distinct from v_publication.processing_watermark_hash then
    raise exception 'truth publication head processing identity is invalid'
      using errcode = '23514';
  end if;
  new.delivery_payload_hash := v_publication.delivery_payload_hash;
  new.processing_watermark_status := v_publication.processing_watermark_status;
  new.processing_watermark := v_publication.processing_watermark;
  new.processing_watermark_hash := v_publication.processing_watermark_hash;
  return new;
end;
$function$;

drop trigger if exists truth_publication_head_processing_watermark_prepare
  on public.truth_publication_heads;
create trigger truth_publication_head_processing_watermark_prepare
before insert or update on public.truth_publication_heads
for each row execute function private.prepare_truth_publication_head_processing_watermark();

create or replace function private.mirror_truth_publication_delivery_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payload public.truth_publication_payloads%rowtype;
  v_has_production_head boolean;
begin
  if new.snapshot_key <> all (array['shipment-truth-packets', 'active-awb-index']) then
    return new;
  end if;
  if coalesce(new.payload->>'publicationId', '') <> '' then
    select * into v_payload
    from public.truth_publication_payloads payload
    where payload.publication_id = (new.payload->>'publicationId')::uuid
      and payload.channel = 'production';
    if not found or v_payload.processing_watermark_status <> 'watermarked' then
      raise exception 'production snapshot publication payload is unavailable or unwatermarked'
        using errcode = '23514';
    end if;
    new.payload := case new.snapshot_key
      when 'shipment-truth-packets' then v_payload.delivery_payload
      else v_payload.active_index_payload
    end;
    return new;
  end if;
  select exists (
    select 1
    from public.truth_publication_heads head
    where head.channel = 'production'
  ) into v_has_production_head;
  if v_has_production_head then
    raise exception 'legacy truth snapshot writer is retired after relational authority takeover'
      using errcode = '55000';
  end if;
  -- Shadow installation must not freeze the current legacy production writer.
  return new;
end;
$function$;

drop trigger if exists truth_app_snapshot_processing_watermark_mirror
  on public.app_snapshots;
create trigger truth_app_snapshot_processing_watermark_mirror
before insert or update on public.app_snapshots
for each row execute function private.mirror_truth_publication_delivery_snapshot();

create or replace function private.mirror_truth_publication_delivery_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_snapshot public.app_snapshots%rowtype;
  v_has_production_head boolean;
begin
  if new.snapshot_key <> all (array['shipment-truth-packets', 'active-awb-index']) then
    return new;
  end if;
  select * into v_snapshot
  from public.app_snapshots snapshot
  where snapshot.snapshot_key = new.snapshot_key;
  if found and coalesce(v_snapshot.payload->>'publicationId', '') <> '' then
    new.snapshot_time := v_snapshot.payload->>'snapshotTime';
    new.content_signature := v_snapshot.payload->>'contentSignature';
    new.payload_bytes := pg_column_size(v_snapshot.payload)::integer;
    return new;
  end if;
  select exists (
    select 1
    from public.truth_publication_heads head
    where head.channel = 'production'
  ) into v_has_production_head;
  if v_has_production_head then
    raise exception 'legacy truth snapshot metadata is retired after authority takeover'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_app_snapshot_metadata_processing_watermark_mirror
  on public.app_snapshot_metadata;
create trigger truth_app_snapshot_metadata_processing_watermark_mirror
before insert or update on public.app_snapshot_metadata
for each row execute function private.mirror_truth_publication_delivery_metadata();

create or replace function private.truth_publication_runtime_receipt(
  p_publication_id uuid,
  p_idempotent boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'ok', true,
    'idempotent', p_idempotent,
    'publicationId', publication.publication_id,
    'publicationVersion', publication.publication_version,
    'previousPublicationId', publication.previous_publication_id,
    'publicationReason', publication.publication_reason,
    'workspaceKey', publication.workspace_key,
    'channel', publication.channel,
    'buildId', publication.build_id,
    'sourceCutId', publication.source_cut_id,
    'packetHash', publication.packet_hash,
    'reducerPacketHash', payload.reducer_packet_hash,
    'semanticHash', publication.semantic_hash,
    'deliveryPayloadHash', publication.delivery_payload_hash,
    'activeIndexHash', payload.active_index_hash,
    'processingWatermarkStatus', publication.processing_watermark_status,
    'processingWatermark', publication.processing_watermark,
    'processingWatermarkHash', publication.processing_watermark_hash,
    'publishedAt', publication.published_at,
    'publicationAdapter', jsonb_build_object(
      'publicationId', publication.publication_id,
      'publicationVersion', publication.publication_version,
      'channel', publication.channel,
      'publishedAt', publication.published_at,
      'publisherVersion', publication.publisher_version,
      'sourceCutId', publication.source_cut_id,
      'packetHash', payload.reducer_packet_hash,
      'processingWatermarkStatus', publication.processing_watermark_status,
      'processingWatermark', publication.processing_watermark,
      'processingWatermarkHash', publication.processing_watermark_hash
    )
  )
  from public.truth_publications publication
  join public.truth_publication_payloads payload
    on payload.publication_id = publication.publication_id
  where publication.publication_id = p_publication_id;
$function$;

create or replace function private.read_truth_publication_head_runtime(
  p_workspace_key text,
  p_channel text,
  p_max_payload_bytes integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_head public.truth_publication_heads%rowtype;
  v_payload public.truth_publication_payloads%rowtype;
  v_publication public.truth_publications%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_channel is null or not (p_channel = any (array['shadow', 'production']))
    or p_max_payload_bytes is null or p_max_payload_bytes < 1024
    or p_max_payload_bytes > 33554432 then
    raise exception 'truth publication head read bound is invalid' using errcode = '22023';
  end if;
  select * into v_head
  from public.truth_publication_heads head
  where head.workspace_key = p_workspace_key
    and head.channel = p_channel;
  if not found then
    return jsonb_build_object(
      'ok', true,
      'found', false,
      'workspaceKey', p_workspace_key,
      'channel', p_channel,
      'processingWatermarkStatus', null,
      'processingWatermark', null,
      'processingWatermarkHash', null,
      'truncated', false
    );
  end if;
  select * into v_payload
  from public.truth_publication_payloads payload
  where payload.publication_id = v_head.publication_id;
  if not found then
    raise exception 'truth publication head payload integrity failed' using errcode = '23514';
  end if;
  select * into v_publication
  from public.truth_publications publication
  where publication.publication_id = v_head.publication_id
    and publication.workspace_key = v_head.workspace_key
    and publication.channel = v_head.channel;
  if not found then
    raise exception 'truth publication head publication identity failed' using errcode = '23514';
  end if;

  -- A pre-410 head is readable only as an explicitly unwatermarked CAS base.
  -- Verify the exact original publication/delivery identities before returning
  -- it; this branch never synthesizes or certifies a current watermark.
  if v_head.processing_watermark_status = 'legacy_unwatermarked'
    or v_payload.processing_watermark_status = 'legacy_unwatermarked'
    or v_publication.processing_watermark_status = 'legacy_unwatermarked' then
    if v_head.processing_watermark_status <> 'legacy_unwatermarked'
      or v_payload.processing_watermark_status <> 'legacy_unwatermarked'
      or v_publication.processing_watermark_status <> 'legacy_unwatermarked'
      or v_head.processing_watermark is not null
      or v_head.processing_watermark_hash is not null
      or v_payload.processing_watermark is not null
      or v_payload.processing_watermark_hash is not null
      or v_publication.processing_watermark is not null
      or v_publication.processing_watermark_hash is not null
      or v_payload.delivery_payload ? 'processingWatermarkStatus'
      or v_payload.delivery_payload ? 'processingWatermark'
      or v_payload.delivery_payload ? 'processingWatermarkHash'
      or v_payload.delivery_payload_hash is distinct from v_head.delivery_payload_hash
      or v_publication.delivery_payload_hash is distinct from v_head.delivery_payload_hash
      or v_publication.packet_hash is distinct from v_head.packet_hash
      or v_publication.source_cut_id is distinct from v_head.source_cut_id
      or v_publication.publication_version is distinct from v_head.publication_version
      or v_payload.delivery_canonical_text is distinct from v_payload.delivery_payload::text
      or v_payload.delivery_payload_hash is distinct from encode(extensions.digest(
        convert_to(
          (v_payload.delivery_payload - 'deliveryPayloadHash' - 'contentSignature')::text,
          'UTF8'
        ),
        'sha256'
      ), 'hex')
      or v_payload.delivery_payload->>'deliveryPayloadHash'
        is distinct from v_payload.delivery_payload_hash
      or v_payload.delivery_payload->>'contentSignature'
        is distinct from v_payload.delivery_payload_hash
      or v_payload.active_index_payload->>'truthPacketContentSignature'
        is distinct from v_payload.delivery_payload_hash
      or v_payload.active_index_payload->>'contentSignature'
        is distinct from v_payload.active_index_hash
      or v_payload.active_index_hash is distinct from encode(extensions.digest(
        convert_to((v_payload.active_index_payload - 'contentSignature')::text, 'UTF8'),
        'sha256'
      ), 'hex') then
      raise exception 'legacy truth publication head integrity failed'
        using errcode = '23514';
    end if;
    if pg_column_size(v_payload.delivery_payload) > p_max_payload_bytes then
      raise exception 'truth publication head exceeds the caller read bound; truncation is forbidden'
        using errcode = '54000';
    end if;
    return jsonb_build_object(
      'ok', true,
      'found', true,
      'workspaceKey', p_workspace_key,
      'channel', p_channel,
      'publicationId', v_head.publication_id,
      'publicationVersion', v_head.publication_version,
      'sourceCutId', v_head.source_cut_id,
      'packetHash', v_head.packet_hash,
      'deliveryPayloadHash', v_head.delivery_payload_hash,
      'processingWatermarkStatus', 'legacy_unwatermarked',
      'processingWatermark', null,
      'processingWatermarkHash', null,
      'deliveryPayload', v_payload.delivery_payload,
      'activeIndexPayload', v_payload.active_index_payload,
      'payloadBytes', pg_column_size(v_payload.delivery_payload),
      'maxPayloadBytes', p_max_payload_bytes,
      'truncated', false
    );
  end if;

  if v_head.processing_watermark_status <> 'watermarked'
    or v_payload.processing_watermark_status <> 'watermarked'
    or v_publication.processing_watermark_status <> 'watermarked'
    or v_payload.processing_watermark is distinct from v_head.processing_watermark
    or v_payload.processing_watermark_hash is distinct from v_head.processing_watermark_hash
    or v_publication.processing_watermark is distinct from v_head.processing_watermark
    or v_publication.processing_watermark_hash is distinct from v_head.processing_watermark_hash
    or v_payload.delivery_payload->>'processingWatermarkStatus'
      is distinct from v_head.processing_watermark_status
    or v_payload.delivery_payload->'processingWatermark'
      is distinct from v_head.processing_watermark
    or v_payload.delivery_payload->>'processingWatermarkHash'
      is distinct from v_head.processing_watermark_hash
    or v_payload.delivery_payload_hash is distinct from v_head.delivery_payload_hash
    or v_payload.delivery_canonical_text is distinct from v_payload.delivery_payload::text
    or v_payload.delivery_payload_hash is distinct from encode(extensions.digest(
      convert_to((v_payload.delivery_payload - 'deliveryPayloadHash' - 'contentSignature')::text, 'UTF8'),
      'sha256'
    ), 'hex') then
    raise exception 'truth publication head payload integrity failed' using errcode = '23514';
  end if;
  perform private.assert_truth_processing_watermark(
    v_head.processing_watermark_status,
    v_head.processing_watermark,
    v_head.processing_watermark_hash
  );
  if pg_column_size(v_payload.delivery_payload) > p_max_payload_bytes then
    raise exception 'truth publication head exceeds the caller read bound; truncation is forbidden'
      using errcode = '54000';
  end if;
  return jsonb_build_object(
    'ok', true,
    'found', true,
    'workspaceKey', p_workspace_key,
    'channel', p_channel,
    'publicationId', v_head.publication_id,
    'publicationVersion', v_head.publication_version,
    'sourceCutId', v_head.source_cut_id,
    'packetHash', v_head.packet_hash,
    'deliveryPayloadHash', v_head.delivery_payload_hash,
    'processingWatermarkStatus', v_head.processing_watermark_status,
    'processingWatermark', v_head.processing_watermark,
    'processingWatermarkHash', v_head.processing_watermark_hash,
    'deliveryPayload', v_payload.delivery_payload,
    'activeIndexPayload', v_payload.active_index_payload,
    'payloadBytes', pg_column_size(v_payload.delivery_payload),
    'maxPayloadBytes', p_max_payload_bytes,
    'truncated', false
  );
end;
$function$;

do $block$
begin
  if to_regprocedure(
    'private.read_truth_audit_snapshot_pre_processing_watermark(text,integer,text)'
  ) is null
    and to_regprocedure(
      'private.read_truth_audit_snapshot(text,integer,text)'
    ) is not null then
    alter function private.read_truth_audit_snapshot(text, integer, text)
      rename to read_truth_audit_snapshot_pre_processing_watermark;
  end if;
end;
$block$;

create or replace function private.read_truth_audit_snapshot(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '25s'
as $function$
declare
  v_snapshot jsonb;
  v_source_cut_id text;
  v_pairs jsonb := '[]'::jsonb;
  v_publications jsonb := '[]'::jsonb;
  v_pair_count bigint := 0;
  v_publication_count bigint := 0;
  v_pair_mismatch_count bigint := 0;
  v_publication_mismatch_count bigint := 0;
  v_legacy_count bigint := 0;
  v_truncated boolean := false;
begin
  v_snapshot := private.read_truth_audit_snapshot_pre_processing_watermark(
    p_workspace_key, p_row_limit, p_sync_token
  );
  v_source_cut_id := v_snapshot #>> '{canonical,currentSourceCutId}';

  with pair_base as (
    select
      pair.build_pair_id,
      pair.status as pair_status,
      pair.source_cut_id,
      pair.input_manifest_hash,
      pair.processing_watermark_status,
      pair.processing_watermark_hash,
      pair.full_build_id,
      full_build.status as full_build_status,
      full_build.input_manifest_hash as full_input_manifest_hash,
      full_build.processing_watermark_status as full_watermark_status,
      full_build.processing_watermark_hash as full_watermark_hash,
      pair.incremental_build_id,
      incremental_build.status as incremental_build_status,
      incremental_build.input_manifest_hash as incremental_input_manifest_hash,
      incremental_build.processing_watermark_status as incremental_watermark_status,
      incremental_build.processing_watermark_hash as incremental_watermark_hash,
      parity.build_pair_id is not null as parity_present,
      parity.processing_watermark_status as parity_watermark_status,
      parity.processing_watermark_hash as parity_watermark_hash,
      case
        when pair.processing_watermark_status = 'legacy_unwatermarked'
          then 'legacy_unwatermarked'
        when full_build.build_id is null or incremental_build.build_id is null
          then 'missing_build'
        when pair.status = 'succeeded' and parity.build_pair_id is null
          then 'missing_parity'
        when pair.input_manifest_hash is distinct from full_build.input_manifest_hash
          or pair.input_manifest_hash is distinct from incremental_build.input_manifest_hash
          or pair.processing_watermark_status is distinct from full_build.processing_watermark_status
          or pair.processing_watermark_status is distinct from incremental_build.processing_watermark_status
          or pair.processing_watermark_hash is distinct from full_build.processing_watermark_hash
          or pair.processing_watermark_hash is distinct from incremental_build.processing_watermark_hash
          or (parity.build_pair_id is not null and (
            pair.processing_watermark_status is distinct from parity.processing_watermark_status
            or pair.processing_watermark_hash is distinct from parity.processing_watermark_hash
          )) then 'mismatch'
        else 'consistent'
      end as continuity_status
    from public.truth_build_pair_runs pair
    left join public.truth_builds full_build
      on full_build.build_id = pair.full_build_id
     and full_build.workspace_key = pair.workspace_key
    left join public.truth_builds incremental_build
      on incremental_build.build_id = pair.incremental_build_id
     and incremental_build.workspace_key = pair.workspace_key
    left join public.truth_build_parity_receipts parity
      on parity.build_pair_id = pair.build_pair_id
    where pair.workspace_key = p_workspace_key
      and pair.source_cut_id = v_source_cut_id
  ), bounded_pairs as (
    select * from pair_base order by build_pair_id limit p_row_limit
  )
  select
    (select count(*)::bigint from pair_base),
    (select count(*)::bigint from pair_base
      where continuity_status not in ('consistent', 'legacy_unwatermarked')),
    (select count(*)::bigint from pair_base
      where continuity_status = 'legacy_unwatermarked'),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'buildPairId', build_pair_id,
        'pairStatus', pair_status,
        'sourceCutId', source_cut_id,
        'inputManifestHash', input_manifest_hash,
        'processingWatermarkStatus', processing_watermark_status,
        'processingWatermarkHash', processing_watermark_hash,
        'fullBuild', jsonb_build_object(
          'buildId', full_build_id,
          'status', full_build_status,
          'inputManifestHash', full_input_manifest_hash,
          'processingWatermarkStatus', full_watermark_status,
          'processingWatermarkHash', full_watermark_hash
        ),
        'incrementalBuild', jsonb_build_object(
          'buildId', incremental_build_id,
          'status', incremental_build_status,
          'inputManifestHash', incremental_input_manifest_hash,
          'processingWatermarkStatus', incremental_watermark_status,
          'processingWatermarkHash', incremental_watermark_hash
        ),
        'parity', jsonb_build_object(
          'present', parity_present,
          'processingWatermarkStatus', parity_watermark_status,
          'processingWatermarkHash', parity_watermark_hash
        ),
        'continuityStatus', continuity_status
      ) order by build_pair_id)
      from bounded_pairs
    ), '[]'::jsonb)
  into v_pair_count, v_pair_mismatch_count, v_legacy_count, v_pairs;

  with publication_base as (
    select
      publication.publication_id,
      publication.publication_version,
      publication.channel,
      publication.build_id,
      publication.source_cut_id,
      publication.processing_watermark_status,
      publication.processing_watermark_hash,
      build.processing_watermark_status as build_watermark_status,
      build.processing_watermark_hash as build_watermark_hash,
      payload.processing_watermark_status as payload_watermark_status,
      payload.processing_watermark_hash as payload_watermark_hash,
      head.publication_id is not null as is_head,
      head.processing_watermark_status as head_watermark_status,
      head.processing_watermark_hash as head_watermark_hash,
      case
        when publication.processing_watermark_status = 'legacy_unwatermarked'
          then 'legacy_unwatermarked'
        when build.build_id is null or payload.publication_id is null
          then 'missing_artifact'
        when publication.processing_watermark_status is distinct from build.processing_watermark_status
          or publication.processing_watermark_status is distinct from payload.processing_watermark_status
          or publication.processing_watermark_hash is distinct from build.processing_watermark_hash
          or publication.processing_watermark_hash is distinct from payload.processing_watermark_hash
          or (head.publication_id is not null and (
            publication.processing_watermark_status is distinct from head.processing_watermark_status
            or publication.processing_watermark_hash is distinct from head.processing_watermark_hash
          )) then 'mismatch'
        else 'consistent'
      end as continuity_status
    from public.truth_publications publication
    left join public.truth_builds build
      on build.build_id = publication.build_id
     and build.workspace_key = publication.workspace_key
    left join public.truth_publication_payloads payload
      on payload.publication_id = publication.publication_id
    left join public.truth_publication_heads head
      on head.publication_id = publication.publication_id
     and head.workspace_key = publication.workspace_key
     and head.channel = publication.channel
    where publication.workspace_key = p_workspace_key
      and (
        publication.source_cut_id = v_source_cut_id
        or head.publication_id is not null
      )
  ), bounded_publications as (
    select * from publication_base
    order by channel, publication_version, publication_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from publication_base),
    (select count(*)::bigint from publication_base
      where continuity_status not in ('consistent', 'legacy_unwatermarked')),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'publicationId', publication_id,
        'publicationVersion', publication_version,
        'channel', channel,
        'buildId', build_id,
        'sourceCutId', source_cut_id,
        'processingWatermarkStatus', processing_watermark_status,
        'processingWatermarkHash', processing_watermark_hash,
        'buildProcessingWatermarkStatus', build_watermark_status,
        'buildProcessingWatermarkHash', build_watermark_hash,
        'payloadProcessingWatermarkStatus', payload_watermark_status,
        'payloadProcessingWatermarkHash', payload_watermark_hash,
        'isHead', is_head,
        'headProcessingWatermarkStatus', head_watermark_status,
        'headProcessingWatermarkHash', head_watermark_hash,
        'continuityStatus', continuity_status
      ) order by channel, publication_version, publication_id)
      from bounded_publications
    ), '[]'::jsonb)
  into v_publication_count, v_publication_mismatch_count, v_publications;

  v_truncated := coalesce((v_snapshot #>> '{bounds,truncated}')::boolean, false)
    or v_pair_count > p_row_limit
    or v_publication_count > p_row_limit;
  v_snapshot := jsonb_set(
    v_snapshot,
    '{canonical,processingWatermarkContinuity}',
    jsonb_build_object(
      'schemaVersion', 'truth-processing-watermark-continuity-v1',
      'sourceCutId', v_source_cut_id,
      'complete', v_pair_mismatch_count = 0
        and v_publication_mismatch_count = 0
        and v_legacy_count = 0,
      'mismatchCount', v_pair_mismatch_count + v_publication_mismatch_count,
      'legacyUnwatermarkedPairCount', v_legacy_count,
      'buildPairs', v_pairs,
      'publications', v_publications
    ),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,counts,processingWatermarkBuildPairs}',
    to_jsonb(v_pair_count),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,counts,processingWatermarkPublications}',
    to_jsonb(v_publication_count),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,truncated}',
    to_jsonb(v_truncated),
    true
  );
  return v_snapshot;
end;
$function$;

revoke all on function private.truth_processing_watermark_exact_keys(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.assert_truth_processing_watermark(text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_processing_watermark(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_build_candidate_manifest_pre_processing_watermark(
  text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_build_candidate_manifest(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_build_pair_processing_watermark()
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_build_processing_watermark()
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_bundle_from_inputs_pre_processing_watermark(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_bundle_from_inputs(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_pair_receipt(
  public.truth_build_pair_runs, boolean, boolean
) from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_build_parity_processing_watermark()
  from public, anon, authenticated, service_role;
revoke all on function private.complete_truth_build_pair_pre_processing_watermark(
  uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function private.complete_truth_build_pair(
  uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function private.validate_truth_build_processing_watermark_completion()
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_publication_processing_watermark()
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_publication_payload_processing_watermark()
  from public, anon, authenticated, service_role;
revoke all on function private.prepare_truth_publication_head_processing_watermark()
  from public, anon, authenticated, service_role;
revoke all on function private.mirror_truth_publication_delivery_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function private.mirror_truth_publication_delivery_metadata()
  from public, anon, authenticated, service_role;
revoke all on function private.truth_publication_runtime_receipt(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_publication_head_runtime(text, text, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_audit_snapshot(text, integer, text)
  from public, anon, authenticated, service_role;
do $block$
begin
  if to_regprocedure(
    'private.read_truth_audit_snapshot_pre_processing_watermark(text,integer,text)'
  ) is not null then
    revoke all on function private.read_truth_audit_snapshot_pre_processing_watermark(
      text, integer, text
    ) from public, anon, authenticated, service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'truth_audit_rpc_owner') then
    if to_regprocedure(
      'private.read_truth_audit_snapshot_pre_processing_watermark(text,integer,text)'
    ) is not null then
      execute 'revoke all on function private.read_truth_audit_snapshot_pre_processing_watermark(text,integer,text) from truth_audit_rpc_owner';
    end if;
    execute 'grant execute on function private.read_truth_audit_snapshot(text,integer,text) to truth_audit_rpc_owner';
  end if;
end;
$block$;

set check_function_bodies = on;
