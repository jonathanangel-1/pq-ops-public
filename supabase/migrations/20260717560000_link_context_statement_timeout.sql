-- 20260717560000_link_context_statement_timeout.sql
--
-- load_truth_link_worker_context exceeds the authenticator session's 8s
-- statement budget for large workgroup contexts (the "heavy links" that
-- poisoned hosted ticks all weekend; 6 restored link jobs re-failed on
-- exactly this after the 440000 span-matcher fix, so the cost is the
-- context query itself). Function-scoped 90s budget: under the edge
-- proxy's ~100s ceiling and far under the 900s worker lease, scoped to
-- this one function. Reapply-idempotent (ALTER ... SET overwrites).

alter function public.load_truth_link_worker_context(text, uuid, text, bigint, text, integer, integer, text[], text)
  set statement_timeout = '90s';
