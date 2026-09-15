revoke all on public.operator_events from anon, authenticated, public;
revoke all on public.operator_push_subscriptions from anon, authenticated, public;
revoke all on public.operator_push_outbox from anon, authenticated, public;
revoke all on public.operator_action_ledger from anon, authenticated, public;

grant select, insert, update, delete on public.operator_events to service_role;
grant select, insert, update, delete on public.operator_push_subscriptions to service_role;
grant select, insert, update, delete on public.operator_push_outbox to service_role;
grant select, insert, update, delete on public.operator_action_ledger to service_role;
