export interface ExportColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: ExportColumn<T>[]) {
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => escape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => escape(c.value(r))).join(',')).join('\r\n');
  return `${head}\r\n${body}`;
}

export function downloadBlob(content: BlobPart, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv<T>(rows: T[], columns: ExportColumn<T>[], filename: string) {
  downloadBlob('﻿' + toCsv(rows, columns), filename.endsWith('.csv') ? filename : `${filename}.csv`, 'text/csv;charset=utf-8');
}

export async function downloadXlsx<T>(rows: T[], columns: ExportColumn<T>[], filename: string) {
  const XLSX = await import('xlsx');
  const data = rows.map((r) => Object.fromEntries(columns.map((c) => [c.header, c.value(r) ?? ''])));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

/** Parse an uploaded CSV or XLSX file into row objects keyed by the header row. */
export async function parseSpreadsheet(file: File): Promise<Record<string, string>[]> {
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false });
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normaliseHeader(k), String(v ?? '').trim()])));
  }
  const Papa = (await import('papaparse')).default;
  const text = await file.text();
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: normaliseHeader });
  return res.data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '').trim()])));
}

export function normaliseHeader(h: string) {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
