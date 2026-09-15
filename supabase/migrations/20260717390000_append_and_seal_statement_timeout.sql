-- 20260717390000_append_and_seal_statement_timeout.sql
--
-- PostgREST sessions log in as `authenticator`, whose role config pins
-- statement_timeout=8s for every RPC regardless of the worker's lease
-- length. The append-and-seal RPC for large candidate batches provably
-- needs more than 8s (job 487382cf dead-lettered on attempts 1-5 and
-- failed restored attempt 6 with "canceling statement due to statement
-- timeout", post-ANALYZE, so the cost is real work, not a stale plan).
--
-- Function-scoped override: the budget applies only while this function
-- runs, stays far under the 900s worker lease, and touches no other RPC.
-- Reapply-idempotent (ALTER ... SET is a plain overwrite).

alter function public.append_and_seal_candidate_claim_job(text, uuid, text, bigint, text, jsonb, text)
  set statement_timeout = '120s';
