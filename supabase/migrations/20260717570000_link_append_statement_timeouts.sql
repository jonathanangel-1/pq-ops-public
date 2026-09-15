-- 20260717570000_link_append_statement_timeouts.sql
--
-- Companions to 20260717560000: the link lane's append RPCs hit the same
-- 8s authenticator session cap on heavy workgroups (candidate-decision
-- append proven live at 00:05; resolution append proven earlier in the
-- span-matcher era and still heavy for large link sets). Function-scoped
-- 90s budgets, under the edge proxy's ~100s ceiling, scoped to these two
-- functions only. Reapply-idempotent (ALTER ... SET overwrites).

alter function public.append_truth_link_candidate_decision(text, uuid, text, bigint, text, text, jsonb, text)
  set statement_timeout = '90s';
alter function public.append_truth_link_resolution(text, uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  set statement_timeout = '90s';
