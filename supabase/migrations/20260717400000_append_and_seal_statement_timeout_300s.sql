-- 20260717400000_append_and_seal_statement_timeout_300s.sql
--
-- 20260717390000 set a 120s function-scoped budget for the heavy
-- append-and-seal RPC; job 487382cf's attempt 7 then ran the full 120s
-- and was cancelled at the new ceiling (observed live in pg_stat_activity
-- at 1m47s, statement gone at ~120s, no server-side completion). The
-- write is real work larger than 120s on this instance. One attempt
-- remains before re-dead-letter, so the budget moves to 300s: still
-- far under the 900s worker lease, scoped to this one function only.
-- Reapply-idempotent (ALTER ... SET is a plain overwrite).

alter function public.append_and_seal_candidate_claim_job(text, uuid, text, bigint, text, jsonb, text)
  set statement_timeout = '300s';
