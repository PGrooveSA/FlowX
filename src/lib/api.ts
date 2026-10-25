// Data-access layer. All reads go through views/tables protected by RLS and
// all writes go through validated database functions (RPC). The browser never
// writes stock levels, prices, statuses or approvals directly.
import type { PostgrestError } from '@supabase/supabase-js';
import { supabase } from './supabase';

export class ApiError extends Error {
  code?: string;
  details?: unknown;
  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function friendlyMessage(err: Partial<PostgrestError> | Error | null | undefined): string {
  if (!err) return 'Something went wrong';
  const msg = (err as PostgrestError).message ?? String(err);
  const code = (err as PostgrestError).code;
  if (code === '42501' && !/Permission denied|Segregation/i.test(msg)) return 'You do not have permission to perform this action.';
  if (code === '23505' && !/Duplicate/i.test(msg)) return 'This record already exists (duplicate value).';
  if (code === 'PGRST301' || /JWT expired/i.test(msg)) return 'Your session has expired. Please sign in again.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Cannot reach the server. Check that the local DeviceFlow services are running.';
  return msg;
}

export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw new ApiError(friendlyMessage(error), error.code, error.details);
  return data as T;
}

/** Result shape returned by scan-style functions (pick, dispatch scan, receive...). */
export interface ScanResult {
  ok: boolean;
  code?: string;
  message: string;
  discrepancy_number?: string;
  expected_serial?: string;
  scanned_serial?: string;
  [key: string]: unknown;
}

export type FilterOp = 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'ilike' | 'cs' | 'is' | 'not_in';
export interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

export interface ListParams {
  select?: string;
  page: number;
  pageSize: number;
  sort?: { column: string; desc: boolean } | null;
  filters?: Filter[];
  search?: string;
  searchColumns?: string[];
  countMode?: 'exact' | 'planned' | 'estimated';
}

function escapeIlike(value: string) {
  return value.replace(/[%_,()]/g, (c) => `\\${c}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyFilters(query: any, filters: Filter[] = [], search?: string, searchColumns?: string[]) {
  let q = query;
  for (const f of filters) {
    if (f.value === undefined || f.value === null || f.value === '' || (Array.isArray(f.value) && f.value.length === 0)) continue;
    switch (f.op) {
      case 'eq': q = q.eq(f.column, f.value); break;
      case 'neq': q = q.neq(f.column, f.value); break;
      case 'in': q = q.in(f.column, f.value as unknown[]); break;
      case 'not_in': q = q.not(f.column, 'in', `(${(f.value as string[]).join(',')})`); break;
      case 'gte': q = q.gte(f.column, f.value); break;
      case 'lte': q = q.lte(f.column, f.value); break;
      case 'ilike': q = q.ilike(f.column, `%${escapeIlike(String(f.value))}%`); break;
      case 'cs': q = q.contains(f.column, f.value as unknown[]); break;
      case 'is': q = q.is(f.column, f.value); break;
    }
  }
  const term = search?.trim();
  if (term && searchColumns?.length) {
    const t = escapeIlike(term);
    q = q.or(searchColumns.map((c) => `${c}.ilike.%${t}%`).join(','));
  }
  return q;
}

export async function fetchList<T = Record<string, unknown>>(source: string, p: ListParams): Promise<{ rows: T[]; count: number }> {
  const from = p.page * p.pageSize;
  let q = supabase.from(source).select(p.select ?? '*', { count: p.countMode ?? 'exact' });
  q = applyFilters(q, p.filters, p.search, p.searchColumns);
  if (p.sort) q = q.order(p.sort.column, { ascending: !p.sort.desc, nullsFirst: false });
  q = q.range(from, from + p.pageSize - 1);
  const { data, error, count } = await q;
  if (error) throw new ApiError(friendlyMessage(error), error.code);
  return { rows: (data ?? []) as T[], count: count ?? 0 };
}

/** Fetches up to `limit` rows for export, in pages of 1000, without loading everything at once. */
export async function fetchForExport<T = Record<string, unknown>>(source: string, p: Omit<ListParams, 'page' | 'pageSize'>, limit = 20000) {
  const rows: T[] = [];
  for (let page = 0; rows.length < limit; page++) {
    const res = await fetchList<T>(source, { ...p, page, pageSize: 1000, countMode: 'planned' });
    rows.push(...res.rows);
    if (res.rows.length < 1000) break;
  }
  return rows.slice(0, limit);
}

export async function fetchOne<T = Record<string, unknown>>(source: string, column: string, value: unknown, select = '*'): Promise<T | null> {
  const { data, error } = await supabase.from(source).select(select).eq(column, value as string).maybeSingle();
  if (error) throw new ApiError(friendlyMessage(error), error.code);
  return data as T | null;
}

export async function fetchAll<T = Record<string, unknown>>(source: string, select = '*', build?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = supabase.from(source).select(select);
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) throw new ApiError(friendlyMessage(error), error.code);
  return (data ?? []) as T[];
}

export async function uploadAttachment(entityType: string, entityId: string, file: File, category = 'document', description?: string) {
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
  const path = `${entityType}/${entityId}/${crypto.randomUUID()}-${safeName}`;
  const up = await supabase.storage.from('attachments').upload(path, file, { upsert: false, contentType: file.type });
  if (up.error) throw new ApiError(up.error.message);
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from('attachments').insert({
    entity_type: entityType, entity_id: entityId, category, storage_path: path, file_name: file.name,
    mime_type: file.type, size_bytes: file.size, description, uploaded_by: u.user?.id,
  });
  if (error) throw new ApiError(friendlyMessage(error), error.code);
  return path;
}

export async function signedUrl(path: string) {
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 300);
  if (error) throw new ApiError(error.message);
  return data.signedUrl;
}
