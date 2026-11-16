// Employment contract for someone the owner employs directly (a caretaker, handyman, gardener
// or domestic worker). Plain language around the Basic Conditions of Employment Act 75 of 1997,
// Sectoral Determination 7 (domestic workers), the National Minimum Wage Act 9 of 2018, the
// Unemployment Insurance Act and COIDA. A starting point, not legal advice.
import { esc } from './shell.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = s => { if (!s) return '__________'; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const rand = n => { const v = Number(n) || 0; const [w, c] = v.toFixed(2).split('.'); return `R ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${c === '00' ? '' : ',' + c}`; };
const blank = (v, fallback = '__________') => (v ?? '').toString().trim() || fallback;

export const PAY_PERIODS = { week: 'every week', fortnight: 'every two weeks', month: 'every month' };
export const PAY_METHODS = { eft: 'by bank transfer into the Employee’s own account', cash: 'in cash, against a signed payslip' };

export function contractDefaults(member = {}, owner = {}, previous = {}) {
  return {
    employer_name: previous.employer_name || owner.full_name || '', employer_id_number: previous.employer_id_number || '',
    employer_address: previous.employer_address || '', employer_phone: previous.employer_phone || owner.phone || '',
    employer_email: previous.employer_email || owner.email || '',
    employee_name: member.full_name || '', employee_id_number: '', employee_address: '',
    employee_phone: member.phone || '', employee_email: member.email || '',
    job_title: member.trade || 'Caretaker and handyman',
    duties: 'General repairs and maintenance at the properties\nKeeping common areas, gardens and refuse areas clean and tidy\nReporting faults and security problems to the Employer',
    workplace: previous.workplace || '', start_date: '',
    days: 'Monday to Friday', start_time: '08:00', end_time: '17:00', meal_break: 60, hours_per_week: 40,
    saturday: '',
    wage: '', pay_period: 'month', pay_method: 'eft',
    accommodation: false, accommodation_value: '', transport_allowance: '',
    annual_leave_days: 21, other_conditions: '',
  };
}

export function validateContract(v) {
  if (!v.employer_name?.trim()) throw new Error('Enter the employer’s name.');
  if (!v.employee_name?.trim()) throw new Error('Enter the employee’s name.');
  if (!v.start_date) throw new Error('Choose the start date.');
  if (!(Number(v.wage) > 0)) throw new Error('Enter the wage.');
  if (!(Number(v.hours_per_week) > 0 && Number(v.hours_per_week) <= 45)) throw new Error('Ordinary hours can’t be more than 45 a week.');
  if (Number(v.annual_leave_days) < 15) throw new Error('Annual leave can’t be less than three weeks (15 working days for a 5-day week).');
}

export function buildContract(v) {
  const per = PAY_PERIODS[v.pay_period] || PAY_PERIODS.month;
  const duties = (v.duties || '').split('\n').map(s => s.trim()).filter(Boolean);
  const extras = (v.other_conditions || '').split('\n').map(s => s.trim()).filter(Boolean);
  const sections = [
    ['The job', [
      `The Employee will start work on ${longDate(v.start_date)} and the employment continues until either party ends it as set out below.`,
      `The Employee is employed as ${blank(v.job_title)}. The main duties are listed at the end of this contract. The Employer may ask for other reasonable work of the same kind.`,
      `The Employee will work at ${blank(v.workplace, 'the Employer’s properties')}.`,
      'The first three months are a probation period, in which the Employer will give guidance and feedback. Probation does not reduce any right in this contract or in law.',
    ]],
    ['Working hours', [
      `Ordinary hours are ${v.hours_per_week} hours a week: ${blank(v.days)}, from ${blank(v.start_time)} to ${blank(v.end_time)}, with a meal break of ${v.meal_break || 60} minutes.${v.saturday ? ` On Saturdays: ${v.saturday}.` : ''}`,
      'Ordinary hours will not be more than 45 hours a week, or 9 hours a day for someone who works 5 days a week (8 hours a day for 6 days a week).',
      'Overtime is only worked when both parties agree, is limited to 15 hours a week and 12 hours a day in total, and is paid at one and a half times the normal rate.',
      'Work on a Sunday or a public holiday is only by agreement and is paid at double the normal rate, unless the parties agree to paid time off instead where the law allows it.',
      'The Employee has a daily rest of at least 12 hours and a weekly rest of at least 36 hours in a row, which includes a Sunday unless agreed otherwise.',
    ]],
    ['Pay', [
      `The Employer pays the Employee a wage of ${rand(v.wage)} ${per}, ${PAY_METHODS[v.pay_method] || PAY_METHODS.eft}, on the last working day of each pay period.`,
      'The wage will never be less than the national minimum wage that applies at the time. The Employer will review the wage at least once a year.',
      `Each payday the Employer gives the Employee a written payslip showing the hours worked, the wage, any overtime, and every deduction.${Number(v.transport_allowance) > 0 ? ` The Employer also pays a transport allowance of ${rand(v.transport_allowance)} ${per}.` : ''}`,
      'The Employer only deducts what the law requires (such as the Employee’s 1% UIF contribution) or what the Employee agreed to in writing for a specific debt. Deductions for breakages or losses need the Employee’s written agreement and a fair process first.',
      v.accommodation
        ? `The Employer provides accommodation. The value of the accommodation (${v.accommodation_value ? rand(v.accommodation_value) + ' ' + per : 'as agreed'}) may only be deducted where the law allows, and never more than 10% of the wage.`
        : 'No accommodation is provided.',
    ]],
    ['Leave', [
      `Annual leave: ${v.annual_leave_days} working days on full pay for every 12 months worked (or one day for every 17 days worked, by agreement). The parties agree on the dates; leave must be taken within 6 months after the 12-month cycle ends.`,
      'Sick leave: in every 36-month cycle, as many paid sick days as the Employee would normally work in 6 weeks. In the first 6 months, one paid sick day for every 26 days worked. The Employer may ask for a medical certificate if the Employee is off sick for more than 2 days in a row, or more than twice in 8 weeks.',
      'Maternity leave: at least 4 months in a row. It is unpaid by the Employer; the Employee may claim from UIF. Parental leave: 10 days in a row when the Employee’s child is born or adopted, which may be claimed from UIF.',
      'Family responsibility leave: 5 paid days a year when the Employee’s child is born or is sick, or when a spouse, life partner, parent, grandparent, child, grandchild or sibling dies. This applies if the Employee works for at least 4 months and at least 4 days a week.',
      'Public holidays: the Employee is not required to work on a public holiday unless they agree, and is paid for a public holiday that falls on a normal working day.',
    ]],
    ['UIF, injury cover and safety', [
      'The Employer registers the Employee with the Unemployment Insurance Fund and pays over 2% of the wage each month (1% from the Employer and 1% deducted from the Employee).',
      'The Employer registers with the Compensation Fund (COIDA), so the Employee is covered for injuries and illness caused by work.',
      'The Employer provides the tools and protective clothing (such as gloves, boots and safety glasses) the work needs, at no cost to the Employee. Work clothing given to the Employee stays the Employer’s property and is returned when the employment ends.',
      'The Employee follows safe working practice, does not do electrical, gas or plumbing work that by law needs a registered or certified person unless they hold that registration, and tells the Employer at once about any danger or injury.',
    ]],
    ['Conduct and the tenants', [
      'The Employee treats tenants with respect, only enters a tenant’s home for work the Employer arranged and at the time agreed with the tenant, and does not share tenants’ personal information with anyone (Protection of Personal Information Act 4 of 2013).',
      'Keys, remotes and access cards given to the Employee are kept safe, used only for work, and returned when asked or when the employment ends.',
      'Discipline follows a fair procedure: the Employee is told what the problem is, may answer, and may have someone help them. Dismissal must be for a fair reason (Labour Relations Act 66 of 1995).',
    ]],
    ['Ending the employment', [
      'Either party may end this contract by giving written notice: one week while the Employee has worked for 6 months or less, and four weeks after that.',
      'When the employment ends the Employer pays all wages owed, pay for annual leave not taken, and gives the Employee a certificate of service and the UIF form (UI-19) so the Employee can claim.',
      v.accommodation ? 'Where the Employee lives on the property and the employment ends, the Employee may stay for at least one month after notice, or for longer where the law requires it.' : null,
    ].filter(Boolean)],
    ['General', [
      'Any change to this contract is only valid if it is in writing and signed by both parties. Where the law gives the Employee a better right than this contract, the law applies.',
      'The Employee confirms that this contract was explained to them in a language they understand, and that they received a signed copy.',
      ...extras,
    ]],
  ];
  return { title: 'Contract of employment', v, duties, sections };
}

export function contractHtml(c) {
  const v = c.v;
  const party = (label, name, id, address, phone, email) => `<div class="lease-party"><h3>${label}</h3><dl class="kv">
    <div><dt>Name</dt><dd>${esc(blank(name))}</dd></div><div><dt>ID number</dt><dd>${esc(blank(id))}</dd></div>
    <div><dt>Address</dt><dd>${esc(blank(address))}</dd></div><div><dt>Phone</dt><dd>${esc(blank(phone))}</dd></div>
    ${email ? `<div><dt>Email</dt><dd>${esc(email)}</dd></div>` : ''}</dl></div>`;
  const sigLine = label => `<div class="sig-slot"><div class="sig-label">${label}</div><div class="sig-line"></div>
    <div class="sig-meta">Signed at ______________________ on ____ / ____ / ________</div></div>`;
  return `<article class="lease-doc printable">
    <header class="lease-head"><div class="lease-brand">RTC Rentals</div><h2>${esc(c.title)}</h2></header>
    <div class="lease-parties">${party('The Employer', v.employer_name, v.employer_id_number, v.employer_address, v.employer_phone, v.employer_email)}
      ${party('The Employee', v.employee_name, v.employee_id_number, v.employee_address, v.employee_phone, v.employee_email)}</div>
    ${c.sections.map((s, si) => `<section class="lease-section"><h3>${si + 1}. ${esc(s[0])}</h3>
      ${s[1].map((t, ci) => `<p><span class="clause-no">${si + 1}.${ci + 1}</span>${esc(t)}</p>`).join('')}</section>`).join('')}
    <section class="lease-section"><h3>Annexure A: duties</h3>${c.duties.length ? `<ul>${c.duties.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '<p>__________</p>'}</section>
    <section class="lease-sigs"><h3>Signatures</h3><div class="sig-grid">
      <div class="sig-side">${sigLine('The Employer')}${sigLine('Witness')}</div>
      <div class="sig-side">${sigLine('The Employee')}${sigLine('Witness')}</div></div></section>
    <footer class="lease-foot"><div>Written in plain language around the Basic Conditions of Employment Act, Sectoral Determination 7 (domestic workers), the National Minimum Wage Act, the Unemployment Insurance Act and COIDA. It is a starting point, not legal advice.</div></footer>
  </article>`;
}
