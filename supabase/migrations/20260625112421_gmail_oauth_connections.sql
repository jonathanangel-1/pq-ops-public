create table if not exists public.gmail_oauth_connections (
  provider text not null default 'gmail',
  connection_key text not null default 'primary',
  account_email text not null default '',
  status text not null default 'connected',
  scopes text[] not null default '{}'::text[],
  encrypted_refresh_token jsonb not null,
  token_fingerprint text not null default '',
  token_redacted text not null default '[encrypted:redacted]',
  connected_at timestamptz not null default now(),
  last_token_refresh_at timestamptz,
  last_token_refresh_error text,
  last_profile jsonb not null default '{}'::jsonb,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, connection_key),
  constraint gmail_oauth_connections_provider_check
    check (provider = 'gmail'),
  constraint gmail_oauth_connections_status_check
    check (status = any (array['connected'::text, 'error'::text, 'revoked'::text]))
);

create index if not exists gmail_oauth_connections_status_idx
  on public.gmail_oauth_connections (status, updated_at desc);

alter table public.gmail_oauth_connections enable row level security;

revoke all on public.gmail_oauth_connections from anon, authenticated, public;
grant select, insert, update, delete on public.gmail_oauth_connections to service_role;
