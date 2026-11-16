// The RTC Rentals residential lease. buildLease(inputs) returns the whole agreement as data
// (parties, key terms, numbered sections) so the exact text that was signed is stored with
// the signatures and never changes when this template is improved later.
//
// Written in plain language around the Rental Housing Act 50 of 1999 and the Consumer
// Protection Act 68 of 2008. It is a starting point, not legal advice.
import { PROVINCES } from './data.js';

export const TEMPLATE_VERSION = 1;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rand = n => {
  const v = Number(n) || 0;
  const [whole, cents] = v.toFixed(2).split('.');
  return `R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${cents === '00' ? '' : ',' + cents}`;
};
const longDate = s => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const ordinal = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const list = a => a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
const clean = s => (s ?? '').toString().trim();

// Starting values for the lease form, from what the owner has already captured.
export function leaseDefaults({ lease, tenant, unit, property, profile, previous }) {
  const prev = previous?.inputs || {};
  const address = [unit?.label, property?.street_address, property?.suburb, property?.city, property?.postal_code]
    .map(clean).filter(Boolean).join(', ');
  const rooms = unit ? [`${unit.bedrooms} bedroom${unit.bedrooms === 1 ? '' : 's'}`,
    `${Number(unit.bathrooms)} bathroom${Number(unit.bathrooms) === 1 ? '' : 's'}`].join(', ') : '';
  return {
    landlord_name: prev.landlord_name || profile?.company_name || profile?.full_name || '',
    landlord_id_number: prev.landlord_id_number || '',
    landlord_address: prev.landlord_address || '',
    landlord_email: prev.landlord_email || profile?.email || '',
    landlord_phone: prev.landlord_phone || profile?.phone || '',
    tenant_name: tenant?.full_name || '',
    tenant_id_number: tenant?.id_number || '',
    tenant_address: address,
    tenant_email: tenant?.email || '',
    tenant_phone: tenant?.phone || '',
    premises_address: address,
    premises_description: rooms,
    parking: '',
    max_occupants: Math.max(2, (unit?.bedrooms || 1) * 2),
    pets_allowed: false,
    start_date: lease?.start_date || '',
    end_date: lease?.end_date || '',
    monthly_rent: lease?.monthly_rent ?? '',
    deposit: lease?.deposit ?? '',
    rent_due_day: lease?.rent_due_day ?? 1,
    escalation_pct: lease?.escalation_pct ?? 0,
    bank_name: prev.bank_name || '', bank_holder: prev.bank_holder || '', bank_account: prev.bank_account || '',
    bank_branch: prev.bank_branch || '', bank_type: prev.bank_type || '',
    payment_reference: '',
    late_fee: '', late_fee_days: 7,
    water_included: Boolean(unit?.water_included),
    electricity_included: Boolean(unit?.electricity_included),
    prepaid_meter: unit?.prepaid_meter_number || '',
    levies_by_landlord: true,
    province: property?.province || 'GP',
    special_conditions: '',
    witnesses_per_party: 0,
  };
}

export function validateLease(i) {
  const need = [['landlord_name', 'the landlord’s name'], ['tenant_name', 'the tenant’s name'],
    ['premises_address', 'the address of the home'], ['start_date', 'the start date']];
  for (const [k, label] of need) if (!clean(i[k])) throw new Error(`Enter ${label}.`);
  if (!(Number(i.monthly_rent) > 0)) throw new Error('Enter the monthly rent.');
  if (i.end_date && i.end_date <= i.start_date) throw new Error('The end date must be after the start date.');
  const d = Number(i.rent_due_day);
  if (!(d >= 1 && d <= 31)) throw new Error('Rent due day must be between 1 and 31.');
  if (i.end_date) {
    const months = (new Date(i.end_date) - new Date(i.start_date)) / (864e5 * 30.44);
    if (months > 24.2) throw new Error('A fixed lease can run for 24 months at most (Consumer Protection Act). Use a shorter period or leave the end date blank.');
  }
}

export function buildLease(input) {
  const i = { ...input };
  validateLease(i);
  const fixed = Boolean(i.end_date);
  const esc = Number(i.escalation_pct) || 0;
  const dueDay = Number(i.rent_due_day);
  const witnesses = Math.min(2, Math.max(0, Number(i.witnesses_per_party) || 0));
  const province = PROVINCES[i.province] || 'the province where the Premises are';
  const hasBank = clean(i.bank_name) && clean(i.bank_account);
  const lateFee = Number(i.late_fee) || 0;

  const included = [i.water_included && 'water', i.electricity_included && 'electricity'].filter(Boolean);
  const tenantPays = [!i.water_included && 'water', !i.electricity_included && 'electricity'].filter(Boolean);

  const S = [];
  const add = (heading, clauses) => S.push({ heading, clauses: clauses.filter(Boolean) });

  add('This agreement', [
    'This is a lease of a home between the Landlord and the Tenant named above. It sets out what each of them has agreed to do.',
    'South African law applies to it, including the Rental Housing Act 50 of 1999 and, where it applies to this lease, the Consumer Protection Act 68 of 2008. Where a term of this lease gives either party less than those laws require, the law applies instead of that term.',
  ]);

  add('The home', [
    `The Landlord lets to the Tenant the home at ${clean(i.premises_address)} (“the Premises”)${clean(i.premises_description) ? `, which has ${clean(i.premises_description)}` : ''}.${clean(i.parking) ? ` Parking: ${clean(i.parking)}.` : ''}`,
    'The Premises include the Landlord’s fixtures and fittings, such as the locks and keys, built-in cupboards, stove, geyser, taps, basins and light fittings.',
    `The Premises may be used only as a private home. No more than ${Number(i.max_occupants) || 2} people may live there unless the Landlord agrees in writing.`,
    i.pets_allowed
      ? 'The Tenant may keep pets, as long as they are allowed by the rules of the complex or building, do not disturb neighbours, and any damage they cause is repaired at the Tenant’s cost.'
      : 'No pets may be kept at the Premises unless the Landlord agrees in writing.',
  ]);

  add('How long the lease runs', [
    fixed ? `The lease starts on ${longDate(i.start_date)} and ends on ${longDate(i.end_date)}.`
          : `The lease starts on ${longDate(i.start_date)} and runs from month to month.`,
    fixed && 'Between 40 and 80 business days before the end date, the Landlord will remind the Tenant in writing that the lease is about to end and say what terms are proposed for a renewal.',
    `${fixed ? 'If the Tenant stays on after the end date with the Landlord’s agreement and no new lease is signed, the lease carries on from month to month on the same terms. ' : ''}While the lease runs from month to month, either party may end it by giving the other at least one full calendar month’s written notice.`,
  ]);

  add('Rent', [
    `The rent is ${rand(i.monthly_rent)} a month.`,
    `Rent is paid in advance, on or before the ${ordinal(dueDay)} day of each month${dueDay > 28 ? ' (or the last day of a shorter month)' : ''}, in full, without deductions and free of bank charges.`,
    hasBank
      ? `Rent is paid by electronic transfer to: ${clean(i.bank_name)}, account holder ${clean(i.bank_holder) || clean(i.landlord_name)}, account number ${clean(i.bank_account)}${clean(i.bank_branch) ? `, branch code ${clean(i.bank_branch)}` : ''}${clean(i.bank_type) ? ` (${clean(i.bank_type)} account)` : ''}.${clean(i.payment_reference) ? ` Payment reference: ${clean(i.payment_reference)}.` : ''}`
      : 'Rent is paid by electronic transfer into the bank account the Landlord gives the Tenant in writing.',
    'The Landlord will give the Tenant a dated receipt for every payment, showing the amount, the month it is for and any amount still owing. Receipts and a running statement are available to both parties in the RTC Rentals app.',
    esc > 0
      ? `The rent goes up by ${esc}% on each anniversary of the start date for as long as the Tenant stays in the Premises.`
      : `The rent does not go up during ${fixed ? 'the fixed period' : 'the first 12 months'}. After that the Landlord may change the rent by giving the Tenant at least two full calendar months’ written notice.`,
    lateFee > 0 && `If rent is still unpaid ${Number(i.late_fee_days) || 7} days after it was due, the Tenant will pay an administration fee of ${rand(lateFee)} for that month towards the Landlord’s reasonable cost of following up.`,
  ]);

  add('Deposit', [
    Number(i.deposit) > 0 ? `The Tenant pays a deposit of ${rand(i.deposit)} when this lease is signed, unless the Landlord already holds it.`
                          : 'No deposit is payable under this lease.',
    Number(i.deposit) > 0 && 'The Landlord must keep the deposit in an interest-bearing account with a bank. The interest belongs to the Tenant, who may ask for written proof of the interest earned.',
    Number(i.deposit) > 0 && 'The Tenant may not use the deposit as rent for the last month or for any other month.',
    Number(i.deposit) > 0 && 'When the lease ends, the Landlord may use the deposit and its interest to settle what the Tenant still owes under this lease: unpaid rent and charges, the reasonable cost of repairing damage the Tenant is responsible for, and the cost of replacing lost keys. The Landlord must keep the receipts for these costs and show them to the Tenant on request.',
    Number(i.deposit) > 0 && 'The balance of the deposit and interest must be paid back to the Tenant within 14 days after the Premises are handed back. If nothing is owed, the full deposit and interest must be paid back within 7 days after the lease ends.',
    Number(i.deposit) > 0 && 'If the Tenant does not respond to the Landlord’s request for a move-out inspection, the Landlord must inspect the Premises within 7 days after the lease ends and pay back the balance within 21 days after the lease ends.',
  ]);

  add('Move-in and move-out inspections', [
    'Before the Tenant moves in, the Landlord and the Tenant must inspect the Premises together and record every defect and any damage. That record, confirmed by both of them, forms part of this lease.',
    'The Tenant must tell the Landlord in writing about any further defects found within 7 days of moving in.',
    'In the 3 days before the lease ends, the Landlord and the Tenant must inspect the Premises together again and record any damage caused during the lease.',
    'If the Landlord does not carry out these inspections with the Tenant, the Landlord is taken to accept that the Premises are in good condition and may not keep any part of the deposit for damage.',
    'Inspections are recorded in the RTC Rentals app, room by room and with photographs. A record that both parties have confirmed in the app counts as signed by both of them.',
    'The Tenant must hand the Premises back in the condition recorded at the start, apart from fair wear and tear.',
  ]);

  add('Water, electricity and other charges', [
    included.length ? `The rent includes ${list(included)}, for normal household use.` : null,
    tenantPays.length ? `The Tenant pays for the ${list(tenantPays)} used at the Premises${clean(i.prepaid_meter) && !i.electricity_included ? ` (prepaid electricity meter number ${clean(i.prepaid_meter)})` : ''}, and for any other services the Tenant orders, such as internet and television.` : 'The Tenant pays for any other services the Tenant orders, such as internet and television.',
    `The Landlord pays the municipal rates and taxes on the Premises${i.levies_by_landlord ? ', and any levies owed to the body corporate or homeowners’ association' : ''}.`,
  ]);

  add('What the Landlord must do', [
    'Give the Tenant the Premises, empty and clean, on the start date, and let the Tenant live there undisturbed for as long as the lease runs.',
    'Keep the structure, roof, outside walls, plumbing, electrical installation and geyser in good working order, and repair fair wear and tear to them. This does not cover damage caused by the Tenant or by people the Tenant allows onto the Premises.',
    'Attend to repairs that are the Landlord’s responsibility within a reasonable time after the Tenant reports them.',
    'Give the Tenant at least 24 hours’ notice before entering the Premises to inspect, do repairs or show them to a possible new tenant or buyer, and come at a reasonable time. No notice is needed in an emergency.',
    'Never cut off water or electricity, change the locks, or remove the Tenant or the Tenant’s belongings without a court order.',
  ]);

  add('What the Tenant must do', [
    'Pay the rent and other amounts due under this lease on time.',
    'Keep the inside of the Premises clean and in good condition, replace light bulbs, and pay for damage caused by the Tenant or by people the Tenant allows onto the Premises, including broken windows and drains blocked through misuse.',
    'Report defects and damage to the Landlord as soon as they are noticed. Repairs can be reported in the RTC Rentals app.',
    'Not make structural changes, paint, or install fixtures without the Landlord’s written consent, which will not be unreasonably refused.',
    'Not sublet the Premises or any part of them, offer them for short-term letting, or hand this lease over to anyone else without the Landlord’s written consent.',
    'Follow the rules of the complex, body corporate or homeowners’ association, of which the Landlord will provide a copy, and not disturb the neighbours.',
    'Not use the Premises for anything unlawful, and not do anything that could cancel the Landlord’s insurance of the building or increase its cost.',
    'Keep any garden, yard or balcony that is part of the Premises tidy.',
    'When the lease ends: remove all belongings, leave the Premises clean, and return every key, remote control and access tag.',
  ]);

  add('Insurance and risk', [
    'The Landlord insures the building. The Tenant’s belongings are kept at the Premises at the Tenant’s own risk, and the Tenant is advised to insure them.',
    'The Landlord is not responsible for loss of or damage to the Tenant’s belongings, or for interruptions to water or electricity that are outside the Landlord’s control, except where the loss is caused by the Landlord’s own negligence or the law does not allow that responsibility to be excluded.',
  ]);

  add('If the home is damaged or destroyed', [
    'If the Premises can no longer be lived in, through no fault of the Tenant, either party may end the lease by written notice and rent stops being payable from the day the Premises became unusable.',
    'If only part of the Premises can’t be used, the lease continues, the Landlord must repair the damage as soon as reasonably possible, and the rent is reduced fairly until the repair is done.',
    'If the damage was caused by the Tenant or by people the Tenant allowed onto the Premises, the Tenant is responsible for the cost of repair.',
  ]);

  add('Ending the lease early', [
    fixed ? 'The Tenant may cancel this lease before the end date by giving the Landlord at least 20 business days’ written notice.'
          : 'Either party may end this lease by giving the notice set out in the section on how long the lease runs.',
    fixed && 'The Landlord may then charge a reasonable cancellation penalty. It must take into account the rent already owing, how much of the lease is left, how soon another tenant can reasonably be found, and the Landlord’s actual cost of re-letting. The Landlord must take reasonable steps to find another tenant.',
  ]);

  add('If someone breaks this lease', [
    'If either party does not do what this lease requires, the other may give written notice describing the problem and asking for it to be put right within 20 business days.',
    'If it is not put right in that time, the party who gave notice may cancel the lease and claim what they are owed.',
    'If the Tenant stays in the Premises while a cancellation is in dispute, the Tenant must keep paying an amount equal to the rent each month until the dispute is settled. Accepting those payments does not mean the Landlord gives up any rights.',
    'The Tenant may only be evicted in terms of a court order.',
  ]);

  add('Disputes', [
    'The parties will first try to settle any disagreement by discussing it and confirming the outcome in writing.',
    `Either party may refer a dispute about this lease to the Rental Housing Tribunal for ${province}, which does not charge for its service, or to a court. The parties agree that the Magistrate’s Court may hear any claim arising from this lease.`,
  ]);

  add('Notices', [
    'The addresses given for the Landlord and the Tenant at the top of this lease are the addresses each chooses for receiving notices and legal documents.',
    'A notice under this lease must be in writing. It may be delivered by hand, sent to the email address given above, or sent as a message in the RTC Rentals app. A notice sent by email or in the app is taken to be received on the next business day.',
    'A party whose address, email address or phone number changes must tell the other in writing within 7 days.',
  ]);

  add('Personal information', [
    'Each party agrees that the other, and Ryno-Tec Consulting (Pty) Ltd as the operator of the RTC Rentals app, may use the personal information in this lease to manage the lease, collect rent, arrange repairs and keep the records the law requires, in line with the Protection of Personal Information Act 4 of 2013.',
    'That information will not be shared with anyone else unless this lease or the law requires it. Either party may ask to see their information and to have mistakes corrected.',
  ]);

  add('General', [
    'This document is the whole agreement between the parties about the Premises. A change to it is only valid if it is in writing and accepted by both parties, which they may do in the RTC Rentals app.',
    'If a party is lenient about a term on one occasion, that party may still insist on the term later.',
    'If a court finds any term of this lease invalid, the rest of the lease still stands.',
  ]);

  add('Signing', [
    'This lease is signed electronically, as the Electronic Communications and Transactions Act 25 of 2002 allows. Each party signs in the RTC Rentals app under their own account.',
    'For every signature the app records the signer’s name, the date and time, and a digital fingerprint of this document, so that any later change to the text can be detected.',
    witnesses === 0 ? 'The law does not require witnesses for this lease, and the parties have chosen to sign without them.'
      : `The law does not require witnesses for this lease, but the parties have chosen that ${witnesses === 1 ? 'one witness' : 'two witnesses'} will sign for each of them. A witness confirms that the person named signed this lease, and may sign in the app or through a secure link.`,
    'Both parties can open and print the signed lease in the app at any time.',
  ]);

  const special = clean(i.special_conditions).split(/\n+/).map(clean).filter(Boolean);
  if (special.length) add('Special conditions', special);

  return {
    version: TEMPLATE_VERSION,
    title: 'Residential lease agreement',
    parties: {
      landlord: { name: clean(i.landlord_name), id_number: clean(i.landlord_id_number), address: clean(i.landlord_address), email: clean(i.landlord_email), phone: clean(i.landlord_phone) },
      tenant: { name: clean(i.tenant_name), id_number: clean(i.tenant_id_number), address: clean(i.tenant_address) || clean(i.premises_address), email: clean(i.tenant_email), phone: clean(i.tenant_phone) },
    },
    premises: { address: clean(i.premises_address), description: clean(i.premises_description) },
    summary: [
      ['Home', clean(i.premises_address)],
      ['Lease period', fixed ? `${longDate(i.start_date)} to ${longDate(i.end_date)}` : `From ${longDate(i.start_date)}, month to month`],
      ['Rent', `${rand(i.monthly_rent)} a month, due on the ${ordinal(dueDay)}`],
      ['Yearly increase', esc > 0 ? `${esc}% on each anniversary` : 'None agreed'],
      ['Deposit', Number(i.deposit) > 0 ? rand(i.deposit) : 'None'],
      ['Included in the rent', included.length ? list(included).replace(/^./, c => c.toUpperCase()) : 'Nothing extra'],
    ],
    sections: S,
    witnesses_per_party: witnesses,
    inputs: i,
  };
}
