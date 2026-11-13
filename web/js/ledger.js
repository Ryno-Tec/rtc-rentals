// Rent maths shared by the landlord pages. No storage here: pure functions.

// 'YYYY-MM-01' for a Date or ISO date string.
export const monthKey = d => {
  const x = typeof d === 'string' ? new Date(d.slice(0, 10) + 'T00:00:00') : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-01`;
};
export const addMonths = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + n, 1));
};
export const monthsBetween = (a, b) => {
  const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
export const monthLabel = key => new Date(key + 'T00:00:00')
  .toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Rent for a month: the starting rent, raised by the escalation on each lease anniversary.
export function rentFor(lease, month) {
  const years = Math.max(0, Math.floor(monthsBetween(monthKey(lease.start_date), month) / 12));
  const r = Number(lease.monthly_rent) * Math.pow(1 + Number(lease.escalation_pct || 0) / 100, years);
  return Math.round(r);
}
export const currentRent = lease => rentFor(lease, monthKey(new Date()));
export const nextEscalation = lease => {
  if (!Number(lease.escalation_pct)) return null;
  const start = monthKey(lease.start_date), now = monthKey(new Date());
  const yrs = Math.floor(monthsBetween(start, now) / 12) + 1;
  return addMonths(start, yrs * 12);
};

// Months that should have a rent charge: from the lease start to this month (or the lease end).
export function chargeMonths(lease, through = monthKey(new Date())) {
  const start = monthKey(lease.start_date);
  const end = lease.end_date ? monthKey(lease.end_date) : null;
  const last = end && end < through ? addMonths(end, -1) : through;
  const out = [];
  for (let m = start; m <= last; m = addMonths(m, 1)) out.push(m);
  return out;
}

// Due date of a month's rent, as 'YYYY-MM-DD'.
// A due day past the end of a short month falls on its last day (the 31st in April is the 30th).
export const dueDay = (lease, month) => {
  const [y, m] = month.split('-').map(Number);
  return Math.min(Number(lease.rent_due_day) || 1, new Date(y, m, 0).getDate());
};
export const dueDate = (lease, month) => month.slice(0, 8) + String(dueDay(lease, month)).padStart(2, '0');
export const ordinal = n => n + ([, 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th');
export const dueDayText = lease => Number(lease.rent_due_day) >= 29 ? `the ${ordinal(lease.rent_due_day)} (or the last day of shorter months)` : `the ${ordinal(lease.rent_due_day)}`;

// paid | partial | overdue | due | upcoming
export function chargeState(lease, p, on = today()) {
  const paid = Number(p.amount_paid || 0), due = Number(p.amount_due || 0);
  if (due > 0 && paid >= due) return 'paid';
  const dd = dueDate(lease, p.period_month);
  if (paid > 0) return dd < on ? 'overdue' : 'partial';
  if (dd < on) return 'overdue';
  return p.period_month <= monthKey(new Date(on + 'T00:00:00')) ? 'due' : 'upcoming';
}
export const STATE_LABEL = { paid: 'Paid', partial: 'Part paid', overdue: 'Overdue', due: 'Due', upcoming: 'Upcoming' };

export function balance(payments) {
  return payments.reduce((t, p) => t + Number(p.amount_due || 0) - Number(p.amount_paid || 0), 0);
}

// Short reference for EFTs: unit + surname, as on the tenant side.
export function eftReference(unitLabel, tenantName) {
  const surname = (tenantName || '').trim().split(/\s+/).pop() || 'TENANT';
  return `${(unitLabel || '').replace(/[^a-z0-9]/gi, '')}-${surname}`.toUpperCase().slice(0, 20);
}
