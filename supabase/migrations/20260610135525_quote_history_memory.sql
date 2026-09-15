create table if not exists public.ops_quote_history (
  quote_id text primary key,
  awb text not null references public.ops_shipments (awb) on delete cascade,
  broker_key text references public.ops_brokers (broker_key),
  broker_name text not null,
  contact_email text,
  amount numeric,
  currency text,
  rate_text text,
  service_context text,
  quote_category text,
  is_recommended boolean not null default false,
  is_selected boolean not null default false,
  quote_status text,
  quoted_at timestamptz,
  evidence jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  snapshot_time timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ops_quote_history enable row level security;

create index if not exists ops_quote_history_awb_idx
  on public.ops_quote_history (awb);

create index if not exists ops_quote_history_broker_key_idx
  on public.ops_quote_history (broker_key);

create index if not exists ops_quote_history_awb_amount_idx
  on public.ops_quote_history (awb, amount nulls last);

create index if not exists ops_quote_history_recommended_idx
  on public.ops_quote_history (is_recommended)
  where is_recommended;

create or replace function public.sync_quote_memory(p_payload jsonb, p_sync_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  shipment jsonb;
  quote jsonb;
  recommended jsonb;
  snapshot_time timestamptz;
  v_awb_key text;
  v_broker_name text;
  v_broker_key text;
  v_quote_id text;
  v_amount numeric;
  v_recommended_broker text;
  v_recommended_amount numeric;
  synced_quotes integer := 0;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  snapshot_time := nullif(p_payload->>'snapshotTime', '')::timestamptz;

  for shipment in
    select value from jsonb_array_elements(coalesce(p_payload->'shipments', '[]'::jsonb))
  loop
    v_awb_key := nullif(trim(shipment->>'awb'), '');
    if v_awb_key is null then
      continue;
    end if;

    recommended := coalesce(shipment#>'{freightBroker,recommendedAward}', '{}'::jsonb);
    v_recommended_broker := lower(nullif(trim(recommended->>'broker'), ''));
    v_recommended_amount := nullif(regexp_replace(coalesce(recommended->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric;

    for quote in
      select value from jsonb_array_elements(coalesce(shipment#>'{freightBroker,quotes}', '[]'::jsonb))
    loop
      v_broker_name := nullif(trim(quote->>'broker'), '');
      if v_broker_name is null then
        continue;
      end if;

      v_broker_key := 'freight:' || lower(regexp_replace(v_broker_name, '\s+', ' ', 'g'));
      v_amount := nullif(regexp_replace(coalesce(quote->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
      v_quote_id := v_awb_key || ':' || md5(quote::text);

      insert into public.ops_brokers (
        broker_key,
        broker_type,
        display_name,
        contact_email,
        context,
        updated_at
      )
      values (
        v_broker_key,
        'freight',
        v_broker_name,
        nullif(quote->>'contactEmail', ''),
        jsonb_build_object('lastQuote', quote),
        now()
      )
      on conflict (broker_key) do update
      set display_name = excluded.display_name,
          contact_email = coalesce(excluded.contact_email, ops_brokers.contact_email),
          context = ops_brokers.context || excluded.context,
          updated_at = excluded.updated_at;

      insert into public.ops_quote_history (
        quote_id,
        awb,
        broker_key,
        broker_name,
        contact_email,
        amount,
        currency,
        rate_text,
        service_context,
        quote_category,
        is_recommended,
        is_selected,
        quote_status,
        quoted_at,
        evidence,
        payload,
        snapshot_time,
        updated_at
      )
      values (
        v_quote_id,
        v_awb_key,
        v_broker_key,
        v_broker_name,
        nullif(quote->>'contactEmail', ''),
        v_amount,
        nullif(quote->>'currency', ''),
        nullif(quote->>'rate', ''),
        nullif(quote->>'service', ''),
        nullif(quote->>'category', ''),
        coalesce(
          v_recommended_broker = lower(v_broker_name) and
            (v_recommended_amount is null or v_amount = v_recommended_amount),
          false
        ),
        coalesce(
          (shipment#>>'{freightBroker,quoteDecision,status}') = 'override-selected' and
            v_recommended_broker = lower(v_broker_name) and
            (v_recommended_amount is null or v_amount = v_recommended_amount),
          false
        ),
        nullif(shipment#>>'{freightBroker,quoteDecision,status}', ''),
        nullif(quote->>'quotedAt', '')::timestamptz,
        coalesce(quote->'evidence', '[]'::jsonb),
        quote,
        snapshot_time,
        now()
      )
      on conflict (quote_id) do update
      set broker_key = excluded.broker_key,
          broker_name = excluded.broker_name,
          contact_email = coalesce(excluded.contact_email, ops_quote_history.contact_email),
          amount = excluded.amount,
          currency = excluded.currency,
          rate_text = excluded.rate_text,
          service_context = excluded.service_context,
          quote_category = excluded.quote_category,
          is_recommended = excluded.is_recommended,
          is_selected = excluded.is_selected,
          quote_status = excluded.quote_status,
          quoted_at = coalesce(excluded.quoted_at, ops_quote_history.quoted_at),
          evidence = excluded.evidence,
          payload = excluded.payload,
          snapshot_time = excluded.snapshot_time,
          updated_at = excluded.updated_at;

      synced_quotes := synced_quotes + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'quotes', synced_quotes,
    'syncedAt', now()
  );
end;
$function$;

grant execute on function public.sync_quote_memory(jsonb, text) to anon, authenticated;
