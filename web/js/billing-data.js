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
    const [me, ozow, settings, fees, invoices, units, props] = await Promise.all([
      sb.from('landlords').select('tier, custom_price').single(),
      sb.from('ozow_accounts').select('*').maybeSingle(),
      sb.from('platform_settings').select('*').maybeSingle(),
      sb.from('platform_fees').select('*').is('invoice_id', null).order('created_at', { ascending: false }),
      sb.from('platform_invoices').select('*').order('period_month', { ascending: false }),
      sb.from('units').select('id', { count: 'exact', head: true }),
      sb.from('properties').select('id', { count: 'exact', head: true }),
    ]);
    const { tier, custom_price } = check(me);
    return { tier, plan: { ...TIERS[tier], price_zar: TIERS[tier].price_zar ?? custom_price ?? null }, ozow: check(ozow),
      settings: check(settings) || FEE_DEFAULTS, fees: check(fees), invoices: check(invoices),
      usage: { units: units.count ?? 0, properties: props.count ?? 0 } };
  },
  async changePlan(tier) { const sb = await client(); check(await sb.rpc('change_my_plan', { p_tier: tier })); },
  async autopay() {
    const sb = await client();
    const [set, mandates, leases, admin] = await Promise.all([
      sb.from('autopay_settings').select('*').maybeSingle(),
      sb.from('payment_mandates').select('id, lease_id, provider, status, max_amount, created_at, activated_at, cancelled_at, mandate_collections(period_month, amount, status)').order('created_at', { ascending: false }),
      sb.from('leases').select('id, status, tenant:tenants(full_name), unit:units(label)').in('status', ['signed', 'active']),
      sb.rpc('is_account_admin')]);
    if (set.error?.code === '42P01') return null;                        // database update 015 not installed yet
    return { settings: set.data || { ozow_capitec: false, netcash: false, reminders: true }, mandates: check(mandates), leases: check(leases), isAdmin: admin.data !== false };
  },
  async saveAutopay(v) {
    const sb = await client();
    check(await sb.rpc('save_autopay_settings', { p_ozow_capitec: !!v.ozow_capitec, p_netcash: !!v.netcash, p_netcash_service_key: v.netcash_key || '', p_reminders: v.reminders !== false }));
  },
  async addDebicheck(v) {
    const sb = await client();
    check(await sb.rpc('add_debicheck_mandate', { p_lease: v.lease_id, p_mandate_ref: v.mandate_ref, p_account_ref: v.account_ref, p_max: Number(v.max) }));
  },
  async stopMandate(id) { const sb = await client(); check(await sb.rpc('cancel_mandate', { p_mandate: id })); },
  async saveOzow(v) {
    const sb = await client();
    if ((v.method || 'one') === 'classic')
      check(await sb.rpc('save_ozow_classic', { p_site_code: v.site_code, p_private_key: v.private_key || '', p_api_key: v.api_key || '',
        p_is_test: Boolean(v.is_test), p_enabled: v.enabled !== false }));
    else
      check(await sb.rpc('save_ozow_account', { p_site_code: v.site_code, p_client_id: v.client_id || '', p_client_secret: v.client_secret || '',
        p_is_test: Boolean(v.is_test), p_enabled: v.enabled !== false }));
  },
  async removeOzow() { const sb = await client(); check(await sb.rpc('remove_ozow_account')); },
  async payInvoice(id) { return startOzow({ invoice_id: id }); },
};

// Demo: kept with the shared sample data in this browser.
const { load, save, emit, uid } = demoStore;
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
    return { tier: s.profile.tier, plan: TIERS[s.profile.tier], ozow: b.ozow, settings: FEE_DEFAULTS, fees: b.fees, invoices: b.invoices,
      usage: { units: s.units.length, properties: s.properties.length } };
  },
  async changePlan(tier) {
    const s = load(), b = billing(s), from = TIERS[s.profile.tier], to = TIERS[tier];
    if (!to.price_zar) throw new DataError('The Agency plan is set up with Ryno-Tec. Email rentals@ryno-tec.co.za.');
    if (to.price_zar < from.price_zar) {
      if (b.invoices.some(i => i.status === 'open' && i.due_date < new Date().toISOString().slice(0, 10)))
        throw new DataError('Please pay your overdue invoice before moving to a smaller plan.');
      if (s.units.length > to.max_units) throw new DataError(`The ${to.display_name} plan allows ${to.max_units} units and you have ${s.units.length}. Remove some units first.`);
      if (s.properties.length > to.max_properties) throw new DataError(`The ${to.display_name} plan allows ${to.max_properties} properties and you have ${s.properties.length}. Remove some first.`);
    }
    s.profile.tier = tier; save(s); emit();
  },
  async autopay() {
    const s = load(), b = billing(s);
    b.autopay = b.autopay || { ozow_capitec: false, netcash: false, reminders: true };
    const leases = (s.leases || []).filter(l => ['signed', 'active'].includes(l.status)).map(l => ({ id: l.id, status: l.status,
      tenant: s.tenants.find(t => t.id === l.tenant_id), unit: s.units.find(u => u.id === l.unit_id) }));
    return { settings: b.autopay, mandates: (s.mandates || []).map(m => ({ ...m, mandate_collections: m.mandate_collections || [] })), leases, isAdmin: true };
  },
  async saveAutopay(v) {
    const s = load(), b = billing(s);
    if (v.ozow_capitec && !b.ozow) throw new DataError('Connect Ozow first (Online rent payments)');
    if (v.netcash && !v.netcash_key && !(b.autopay?.netcash_hint)) throw new DataError('Enter your Netcash debit order service key');
    b.autopay = { ozow_capitec: !!v.ozow_capitec, netcash: !!v.netcash, reminders: v.reminders !== false, netcash_hint: v.netcash_key ? v.netcash_key.slice(-4) : b.autopay?.netcash_hint };
    save(s); emit();
  },
  async addDebicheck(v) {
    const s = load(); s.mandates = s.mandates || [];
    if (!/^[A-Za-z0-9-]{4,50}$/.test(v.mandate_ref || '')) throw new DataError('Enter the DebiCheck mandate reference from Netcash');
    if (s.mandates.some(m => m.lease_id === v.lease_id && ['pending', 'active'].includes(m.status))) throw new DataError('That tenant already has automatic payments.');
    s.mandates.push({ id: uid(), lease_id: v.lease_id, provider: 'netcash_debicheck', status: 'active', max_amount: Number(v.max), created_at: new Date().toISOString(), mandate_collections: [] });
    save(s); emit();
  },
  async stopMandate(id) {
    const s = load(); const m = (s.mandates || []).find(x => x.id === id);
    if (m) Object.assign(m, { status: 'cancelled', cancelled_at: new Date().toISOString() }); save(s); emit();
  },
  async saveOzow(v) {
    const s = load(), b = billing(s);
    if (!/^[A-Za-z0-9-]{3,50}$/.test(v.site_code || '')) throw new DataError('Enter the Site Code from your Ozow dashboard');
    const method = v.method || 'one', same = b.ozow && (b.ozow.method || 'one') === method;
    let secret;
    if (method === 'classic') {
      if (!same && (!v.private_key || !v.api_key)) throw new DataError('Enter the Private Key and API Key from your Ozow dashboard (Merchant details)');
      if (v.private_key && v.private_key.length < 16) throw new DataError('That Private Key doesn’t look right');
      if (v.api_key && v.api_key.length < 16) throw new DataError('That API Key doesn’t look right');
      if (v.private_key && v.private_key === v.api_key) throw new DataError('The Private Key and API Key are different keys. Check you copied each one.');
      secret = v.private_key;
    } else {
      if (!same && (!v.client_id || !v.client_secret)) throw new DataError('Enter the Client ID and Client Secret from your Ozow dashboard (One API Clients)');
      if (v.client_secret && v.client_secret.length < 16) throw new DataError('That Client Secret looks too short');
      secret = v.client_secret;
    }
    b.ozow = { site_code: v.site_code, is_test: Boolean(v.is_test), enabled: v.enabled !== false, method,
      key_hint: secret ? secret.slice(-4) : b.ozow.key_hint, updated_at: new Date().toISOString() };
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
