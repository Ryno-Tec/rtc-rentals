// Owner billing: the landlord's own Ozow connection, Ryno-Tec's plan, collection fees and invoices.
import { isDemo, client, demoStore, DataError, TIERS } from './data.js';
import { startOzow } from './ozow-client.js';

export const FEE_DEFAULTS = { collection_fee_pct: 0.5, collection_fee_min: 0, collection_fee_max: 75 };
export const feeFor = (amount, s = FEE_DEFAULTS) =>
  Math.round(Math.min(s.collection_fee_max, Math.max(s.collection_fee_min, amount * s.collection_fee_pct / 100)) * 100) / 100;

const check = r => { if (r.error) throw new DataError(r.error.message); return r.data; };

const live = {
  async overview() {
    const sb = await client();
    const [me, ozow, settings, fees, invoices] = await Promise.all([
      sb.from('landlords').select('tier').single(),
      sb.from('ozow_accounts').select('site_code, is_test, enabled, key_hint, updated_at').maybeSingle(),
      sb.from('platform_settings').select('*').maybeSingle(),
      sb.from('platform_fees').select('*').is('invoice_id', null).order('created_at', { ascending: false }),
      sb.from('platform_invoices').select('*').order('period_month', { ascending: false }),
    ]);
    const tier = check(me).tier;
    return { tier, plan: TIERS[tier], ozow: check(ozow), settings: check(settings) || FEE_DEFAULTS, fees: check(fees), invoices: check(invoices) };
  },
  async saveOzow(v) {
    const sb = await client();
    check(await sb.rpc('save_ozow_account', { p_site_code: v.site_code, p_private_key: v.private_key || '', p_api_key: v.api_key || '',
      p_is_test: Boolean(v.is_test), p_enabled: v.enabled !== false }));
  },
  async removeOzow() { const sb = await client(); check(await sb.rpc('remove_ozow_account')); },
  async payInvoice(id) { return startOzow({ invoice_id: id }); },
};

// Demo: kept with the shared sample data in this browser.
const { load, save, emit } = demoStore;
function billing(s) {
  if (!s.billing) {
    const m = new Date(); m.setDate(1); m.setMonth(m.getMonth() - 1);
    const month = m.toISOString().slice(0, 10).slice(0, 8) + '01';
    s.billing = {
      ozow: null,
      fees: [{ id: 'fee-1', rent_amount: 4500, rate_pct: 0.5, amount: 22.5, created_at: new Date().toISOString() }],
      invoices: [{ id: 'inv-1', number: `RTC-${month.slice(0, 7).replace('-', '')}-DEMO01`, period_month: month, tier: s.profile.tier,
        subscription_amount: TIERS[s.profile.tier].price_zar, collection_fees: 45, total: TIERS[s.profile.tier].price_zar + 45,
        status: 'open', due_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) }],
    };
  }
  return s.billing;
}
const demo = {
  async overview() {
    const s = load(), b = billing(s); save(s);
    return { tier: s.profile.tier, plan: TIERS[s.profile.tier], ozow: b.ozow, settings: FEE_DEFAULTS, fees: b.fees, invoices: b.invoices };
  },
  async saveOzow(v) {
    const s = load(), b = billing(s);
    if (!/^[A-Za-z0-9-]{3,50}$/.test(v.site_code || '')) throw new DataError('Enter the Site Code from your Ozow dashboard');
    if (!b.ozow && !v.private_key) throw new DataError('Enter the Private Key from your Ozow dashboard');
    if (v.private_key && v.private_key.length < 16) throw new DataError('That Private Key looks too short');
    b.ozow = { site_code: v.site_code, is_test: Boolean(v.is_test), enabled: v.enabled !== false,
      key_hint: v.private_key ? v.private_key.slice(-4) : b.ozow.key_hint, updated_at: new Date().toISOString() };
    save(s); emit();
  },
  async removeOzow() { const s = load(); billing(s).ozow = null; save(s); emit(); },
  async payInvoice(id) {
    const s = load(), inv = billing(s).invoices.find(i => i.id === id);
    if (!inv || inv.status !== 'open') throw new DataError('This invoice is already paid.');
    await new Promise(r => setTimeout(r, 700));
    Object.assign(inv, { status: 'paid', paid_at: new Date().toISOString() });
    save(s); emit();
    return inv;
  },
};

export const billingApi = isDemo() ? demo : live;
