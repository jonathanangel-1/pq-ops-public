-- 20260717440000_utf16_span_matcher_linear.sql
--
-- private.truth_utf16_span_matches walked the observation text one
-- character at a time with substr(p_text, i, 1); on UTF-8 varlena text
-- each substr scans from the string head, making the check O(n^2) in the
-- observation length. A single candidate against a large parsed
-- attachment measured 107s of pure CPU (job 487382cf), which is what
-- head-blocked the acceptance chain behind statement budgets and the
-- edge proxy all afternoon.
--
-- Replacement semantics are IDENTICAL:
--   * same validation prologue, same unreachable (0,0) branch order;
--   * spans may not begin or end inside an astral (surrogate-pair)
--     character — exactly the old mid-character false;
--   * quote must equal the exact sliced text.
-- Fast path: text with no astral characters (every observed freight
-- document) has UTF-16 units equal to character positions, so the check
-- is one substr comparison. Astral texts use an O(n log n) binary search
-- on the monotone char->utf16-units mapping.

create or replace function private.truth_utf16_span_matches(p_text text, p_span jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_start integer;
  v_end integer;
  v_chars integer;
  v_astral constant text := '[\U00010000-\U0010FFFF]';
  v_total_units integer;
  v_c_start integer;
  v_c_end integer;
  v_lo integer;
  v_hi integer;
  v_mid integer;
  v_units integer;
begin
  if jsonb_typeof(coalesce(p_span, 'null'::jsonb)) <> 'object'
    or not private.truth_jsonb_has_only_keys(p_span, array['start', 'end', 'unit', 'quote'])
    or coalesce(p_span->>'start', '') !~ '^[0-9]+$'
    or coalesce(p_span->>'end', '') !~ '^[0-9]+$'
    or length(p_span->>'start') > 10
    or length(p_span->>'end') > 10
    or p_span->>'unit' <> 'utf16_code_units'
    or jsonb_typeof(coalesce(p_span->'quote', 'null'::jsonb)) <> 'string' then
    return false;
  end if;
  if (p_span->>'start')::numeric > 2147483647
    or (p_span->>'end')::numeric > 2147483647 then
    return false;
  end if;
  v_start := (p_span->>'start')::integer;
  v_end := (p_span->>'end')::integer;
  if v_end <= v_start then
    return false;
  end if;
  if v_start = 0 and v_end = 0 then
    return p_span->>'quote' = '';
  end if;
  if char_length(coalesce(p_text, '')) = 0 then
    return false;
  end if;
  v_chars := char_length(p_text);

  if p_text !~ v_astral then
    -- No surrogate pairs: UTF-16 units are character positions.
    if v_end > v_chars then
      return false;
    end if;
    return substr(p_text, v_start + 1, v_end - v_start) = p_span->>'quote';
  end if;

  -- Astral-aware path. units(C) = C + (astral chars within first C chars),
  -- computed in C-speed regexp, monotone strictly increasing in C.
  v_total_units := v_chars
    + (v_chars - char_length(regexp_replace(p_text, v_astral, '', 'g')));
  if v_end > v_total_units then
    return false;
  end if;

  if v_start = 0 then
    v_c_start := 0;
  else
    v_lo := 1; v_hi := v_chars;
    while v_lo < v_hi loop
      v_mid := (v_lo + v_hi) / 2;
      v_units := v_mid + (v_mid - char_length(
        regexp_replace(left(p_text, v_mid), v_astral, '', 'g')));
      if v_units >= v_start then
        v_hi := v_mid;
      else
        v_lo := v_mid + 1;
      end if;
    end loop;
    v_units := v_lo + (v_lo - char_length(
      regexp_replace(left(p_text, v_lo), v_astral, '', 'g')));
    if v_units <> v_start then
      -- span begins inside an astral character
      return false;
    end if;
    v_c_start := v_lo;
  end if;

  v_lo := v_c_start + 1; v_hi := v_chars;
  while v_lo < v_hi loop
    v_mid := (v_lo + v_hi) / 2;
    v_units := v_mid + (v_mid - char_length(
      regexp_replace(left(p_text, v_mid), v_astral, '', 'g')));
    if v_units >= v_end then
      v_hi := v_mid;
    else
      v_lo := v_mid + 1;
    end if;
  end loop;
  v_units := v_lo + (v_lo - char_length(
    regexp_replace(left(p_text, v_lo), v_astral, '', 'g')));
  if v_units <> v_end then
    -- span ends inside an astral character (or past the text)
    return false;
  end if;
  v_c_end := v_lo;

  return substr(p_text, v_c_start + 1, v_c_end - v_c_start) = p_span->>'quote';
end;
$function$;

do $tests$
begin
  -- plain ASCII span
  if not private.truth_utf16_span_matches('hello world',
    '{"start":6,"end":11,"unit":"utf16_code_units","quote":"world"}'::jsonb) then
    raise exception 'span matcher regression: ascii exact match';
  end if;
  -- wrong quote
  if private.truth_utf16_span_matches('hello world',
    '{"start":6,"end":11,"unit":"utf16_code_units","quote":"worlt"}'::jsonb) then
    raise exception 'span matcher regression: wrong quote accepted';
  end if;
  -- end past text
  if private.truth_utf16_span_matches('hello',
    '{"start":0,"end":6,"unit":"utf16_code_units","quote":"hello!"}'::jsonb) then
    raise exception 'span matcher regression: overrun accepted';
  end if;
  -- astral prefix: U+1F600 counts as two UTF-16 units
  if not private.truth_utf16_span_matches(U&'\+01F600ab',
    '{"start":2,"end":4,"unit":"utf16_code_units","quote":"ab"}'::jsonb) then
    raise exception 'span matcher regression: astral offset';
  end if;
  -- span starting mid-astral must fail
  if private.truth_utf16_span_matches(U&'\+01F600ab',
    '{"start":1,"end":3,"unit":"utf16_code_units","quote":"?a"}'::jsonb) then
    raise exception 'span matcher regression: mid-astral start accepted';
  end if;
  -- astral inside the span
  if not private.truth_utf16_span_matches(U&'x\+01F600y',
    '{"start":0,"end":4,"unit":"utf16_code_units","quote":"x😀y"}'::jsonb) then
    raise exception 'span matcher regression: astral inside span';
  end if;
end;
$tests$;
