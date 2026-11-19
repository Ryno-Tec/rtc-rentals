-- 018: Operational health summary for Khaphela (Ryno-Tec's monitoring assistant).
-- Totals only: no names, emails, references or amounts per person leave the database.
-- Callable by the service role alone; the ops-health Edge Function exposes it behind a separate key.
-- Safe to run more than once.

create or replace function public.ops_health()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'generated_at', now(),
    'accounts', jsonb_build_object(
      'landlords', (select count(*) from public.landlords),
      'active_leases', (select count(*) from public.leases where status = 'active'),
      'units', (select count(*) from public.units),
      'tenants', (select count(*) from public.tenants where archived_at is null)),
    'payments', jsonb_build_object(
      'alerts_24h', (select count(*) from public.payment_events where alert and at > now() - interval '24 hours'),
      'alerts_7d', (select count(*) from public.payment_events where alert and at > now() - interval '7 days'),
      'alerts_by_kind_7d', coalesce((select jsonb_object_agg(kind, n) from (
          select kind, count(*) n from public.payment_events where alert and at > now() - interval '7 days' group by kind) k), '{}'::jsonb),
      'pending_investigation', (select count(*) from public.online_payments where status = 'pending_investigation'),
      'stuck_started', (select count(*) from public.online_payments where status in ('started', 'pending') and created_at < now() - interval '2 hours' and created_at > now() - interval '7 days'),
      'online_completed_24h', (select count(*) from public.online_payments where status = 'complete' and completed_at > now() - interval '24 hours'),
      'online_value_24h', (select coalesce(sum(amount), 0) from public.online_payments where status = 'complete' and completed_at > now() - interval '24 hours' and not is_test),
      'online_value_30d', (select coalesce(sum(amount), 0) from public.online_payments where status = 'complete' and completed_at > now() - interval '30 days' and not is_test),
      'ozow_connected', (select count(*) from public.ozow_accounts where enabled)),
    'autopay', jsonb_build_object(
      'active_mandates', (select count(*) from public.payment_mandates where status = 'active'),
      'failed_mandates_7d', (select count(*) from public.payment_mandates where status = 'failed' and coalesce(cancelled_at, activated_at, created_at) > now() - interval '7 days')),
    'billing', jsonb_build_object(
      'open_invoices', (select count(*) from public.platform_invoices where status = 'open'),
      'overdue_invoices', (select count(*) from public.platform_invoices where status = 'open' and due_date < current_date),
      'overdue_value', (select coalesce(sum(total), 0) from public.platform_invoices where status = 'open' and due_date < current_date)),
    'rent', jsonb_build_object(
      'late_payments', (select count(*) from public.payments where status in ('late', 'pending', 'partial') and amount_paid < amount_due and period_month < date_trunc('month', current_date)),
      'reminders_24h', (select count(*) from public.rent_reminders where sent_at > now() - interval '24 hours')),
    'jobs', jsonb_build_object(
      'reconcile_last', (select last_reconcile_at from public.platform_settings limit 1),
      'full_reconcile_last', (select last_full_reconcile_at from public.platform_settings limit 1),
      'runs', coalesce((select jsonb_object_agg(name, last_run) from public.job_runs), '{}'::jsonb)),
    'maintenance', jsonb_build_object(
      'open_requests', (select count(*) from public.maintenance_requests where status not in ('resolved', 'closed')),
      'urgent_open', (select count(*) from public.maintenance_requests where status not in ('resolved', 'closed') and priority = 'urgent')),
    'documents', jsonb_build_object(
      'unsigned_sent_14d', (select count(*) from public.lease_documents where status = 'sent' and sent_at < now() - interval '14 days'),
      'receipts_unnumbered', (select count(*) from public.payments where amount_paid > 0 and receipt_no is null))
  );
$$;
revoke all on function public.ops_health() from public, anon, authenticated;
grant execute on function public.ops_health() to service_role;
