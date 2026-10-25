import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const TIMEZONE = 'Africa/Johannesburg';

/** Formats integer cents as South African Rand. Never uses floating point for storage. */
export function formatMoney(cents: number | null | undefined, currency = 'ZAR') {
  if (cents === null || cents === undefined) return '—';
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  // Group thousands with a plain space (SA convention) independent of the runtime's locale data
  const rands = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const minor = String(abs % 100).padStart(2, '0');
  const symbol = currency === 'ZAR' ? 'R' : `${currency} `;
  return `${negative ? '-' : ''}${symbol}${rands}.${minor}`;
}

/** Parses a user-entered Rand amount ("1 234,50", "1234.5", "R 99") into integer cents. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[R\s]/gi, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return cleaned.startsWith('-') ? -cents : cents;
}

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return '—';
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { timeZone: TIMEZONE, year: 'numeric', month: 'short', day: '2-digit' });
}

/** dd/mm/yyyy in the configured timezone. */
export function formatDateNumeric(value: string | Date | null | undefined) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-ZA', { timeZone: TIMEZONE, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Today's date (YYYY-MM-DD) in the configured South African timezone. */
export function todayLocal(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

export function labelize(value: string | null | undefined) {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function hexToRgbTriple(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`;
}
