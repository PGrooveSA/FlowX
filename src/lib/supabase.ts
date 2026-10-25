import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && anonKey);

function newCorrelationId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Every request carries a correlation id that the database writes into the audit trail.
const correlatedFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('x-correlation-id')) headers.set('x-correlation-id', newCorrelationId());
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(url ?? 'http://127.0.0.1:55421', anonKey ?? 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: correlatedFetch },
});
