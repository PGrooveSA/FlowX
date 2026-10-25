import { describe, expect, it } from 'vitest';
import { formatMoney, hexToRgbTriple, labelize, parseMoneyToCents } from './utils';
import { toCsv, normaliseHeader, chunk } from './csv';
import { toneFor } from './status';
import { visibleNav } from './navigation';

describe('money handling (integer cents, ZAR)', () => {
  it('formats cents as Rand without floating point drift', () => {
    expect(formatMoney(0)).toBe('R0.00');
    expect(formatMoney(450000)).toBe('R4 500.00');
    expect(formatMoney(123456789)).toBe('R1 234 567.89');
    expect(formatMoney(-1999)).toBe('-R19.99');
    expect(formatMoney(null)).toBe('—');
  });
  it('parses user input into exact cents', () => {
    expect(parseMoneyToCents('4500')).toBe(450000);
    expect(parseMoneyToCents('R 1 234,50')).toBe(123450);
    expect(parseMoneyToCents('0.1')).toBe(10);
    expect(parseMoneyToCents('19.99')).toBe(1999);
    expect(parseMoneyToCents('12.345')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
  });
});

describe('csv export', () => {
  it('escapes quotes, commas and neutralises spreadsheet formulas', () => {
    const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: '=HYPERLINK("evil")' }], [
      { header: 'A', value: (r) => r.a }, { header: 'B', value: (r) => r.b }, { header: 'C', value: (r) => r.c }]);
    expect(csv.split('\r\n')[1]).toBe('"x,y","say ""hi""","\'=HYPERLINK(""evil"")"');
  });
  it('normalises import headers and chunks rows', () => {
    expect(normaliseHeader(' Serial Number ')).toBe('serial_number');
    expect(normaliseHeader('EMIS-No.')).toBe('emis_no');
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('presentation helpers', () => {
  it('labels statuses and picks badge tones', () => {
    expect(labelize('scheduled_pending_issuing')).toBe('Scheduled Pending Issuing');
    expect(toneFor('device', 'faulty')).toBe('red');
    expect(toneFor('wo', 'completed')).toBe('green');
    expect(toneFor('generic', 'unknown_thing')).toBe('gray');
  });
  it('converts brand colours for CSS variables', () => {
    expect(hexToRgbTriple('#1d4ed8')).toBe('29 78 216');
    expect(hexToRgbTriple('nope')).toBeNull();
  });
});

describe('navigation is filtered by permissions', () => {
  it('shows only modules the user may access', () => {
    const perms = new Set(['dashboard.view', 'invoices.view']);
    const labels = visibleNav((p) => perms.has(p)).map((i) => i.label);
    expect(labels).toContain('Invoicing');
    expect(labels).toContain('Notifications');
    expect(labels).not.toContain('User Management');
    expect(labels).not.toContain('Dispatch');
  });
});
