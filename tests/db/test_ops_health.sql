-- 018: ops_health() returns totals, and only the service role can call it.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
reset role;
do $$ declare h jsonb := public.ops_health(); begin
  assert h ? 'payments' and h ? 'jobs' and h ? 'billing' and h ? 'accounts' and h ? 'maintenance' and h ? 'documents', 'all sections present';
  assert (h->'payments'->>'alerts_24h')::int >= 0, 'counts are numbers';
  assert jsonb_typeof(h->'jobs'->'runs') = 'object';
  assert h::text !~* '@', 'no email addresses in the summary';
end $$;
set role authenticated;
do $$ begin
  begin perform public.ops_health(); raise exception 'expected: app users refused';
  exception when insufficient_privilege then null; end;
end $$;
set role anon;
do $$ begin
  begin perform public.ops_health(); raise exception 'expected: anon refused';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
\echo 'Ops health tests passed'
