-- 20260717670000_build_rpc_statement_timeouts.sql
--
-- The relational build's RPCs exceed the authenticator session's 8s cap on
-- the full-corpus build (claim_truth_build_pair proven live at 06:0x on cut
-- c64926d6: "claim pair failed: canceling statement due to statement
-- timeout"). Same remedy as 390000/560000/570000: function-scoped 90s
-- budgets, under the edge proxy ceiling, scoped to the two build RPCs.
-- Reapply-idempotent (ALTER ... SET overwrites).

alter function public.claim_truth_build_pair(text, text, text, text, text, text, integer, integer, jsonb, text)
  set statement_timeout = '90s';
alter function public.complete_truth_build(uuid, text, text, jsonb, text)
  set statement_timeout = '90s';
