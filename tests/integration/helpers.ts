// Integration-test helpers. These run against the LOCAL Supabase stack only and
// create isolated users/devices with a unique run id so tests never depend on demo data.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function loadEnv() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

export const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON = process.env.VITE_SUPABASE_ANON_KEY!;
if (!URL || !SERVICE || !ANON) throw new Error('Run `npm run setup:env` first: Supabase env vars are missing');
if (!/127\.0\.0\.1|localhost/.test(URL)) throw new Error('Integration tests only run against a local Supabase stack');

export const RUN = randomBytes(3).toString('hex').toUpperCase();
export const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const PASSWORD = `It-${randomBytes(9).toString('base64url')}`;

export interface TestUser { id: string; client: SupabaseClient; email: string }

export async function makeUser(name: string, roleCodes: string[]): Promise<TestUser> {
  const email = `it-${name}-${RUN.toLowerCase()}@deviceflow.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `IT ${name}` } });
  if (error) throw error;
  const { data: roles } = await svc.from('roles').select('id, code').in('code', roleCodes);
  for (const r of roles ?? []) {
    const { error: e } = await svc.from('user_role_assignments').insert({ user_id: data.user.id, role_id: r.id });
    if (e) throw e;
  }
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: se } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (se) throw se;
  return { id: data.user.id, client, email };
}

/** Calls an RPC and throws on error. */
export async function call<T = unknown>(u: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await u.client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}
/** Calls an RPC expecting failure; returns the error. */
export async function fails(u: TestUser, fn: string, args: Record<string, unknown>) {
  const { error } = await u.client.rpc(fn, args);
  if (!error) throw new Error(`${fn} was expected to fail but succeeded`);
  return error;
}

export interface Fixtures { warehouseId: string; institutionId: string; typeId: string; exemptTypeId: string; model: { id: string; category_id: string; unit_price_cents: number } }
let fx: Fixtures | null = null;
export async function fixtures(): Promise<Fixtures> {
  if (fx) return fx;
  const wh = await svc.from('warehouses').select('id').eq('code', 'CPT-01').single();
  const inst = await svc.from('institutions').select('id').eq('emis_number', '900300301').single();
  const type = await svc.from('work_order_types').select('id').eq('code', 'new_allocation').single();
  const exempt = await svc.from('work_order_types').select('id').eq('code', 'same_learner_same_device').single();
  const model = await svc.from('device_models').select('id, category_id, unit_price_cents').eq('model_code', 'DELL-LAT3440').single();
  if (wh.error || inst.error || type.error || model.error || exempt.error) throw new Error('Seed reference data missing: run `npm run db:reset`');
  fx = { warehouseId: wh.data.id, institutionId: inst.data.id, typeId: type.data.id, exemptTypeId: exempt.data.id, model: model.data };
  return fx;
}

let serialCounter = 0;
export const serial = (tag = 'S') => `IT${RUN}${tag}${String(++serialCounter).padStart(4, '0')}`;

export async function registerDevices(by: TestUser, count: number, tag = 'S'): Promise<string[]> {
  const f = await fixtures();
  const serials: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = serial(tag);
    await call(by, 'register_device', { p: { model_id: f.model.id, warehouse_id: f.warehouseId, serial_number: s, condition: 'new' } });
    serials.push(s);
  }
  return serials;
}

export interface Team { admin: TestUser; creator: TestUser; approver: TestUser; manager: TestUser; operator: TestUser; invoicer: TestUser; dispatcher: TestUser; dispatcher2: TestUser; technician: TestUser; standard: TestUser }
let team: Team | null = null;
export async function getTeam(): Promise<Team> {
  if (team) return team;
  team = {
    admin: await makeUser('admin', ['administrator']),
    creator: await makeUser('creator', ['standard_user']),
    approver: await makeUser('approver', ['approver']),
    manager: await makeUser('manager', ['warehouse_manager']),
    operator: await makeUser('operator', ['warehouse_operator']),
    invoicer: await makeUser('invoicer', ['invoicer']),
    dispatcher: await makeUser('dispatcher', ['dispatcher']),
    dispatcher2: await makeUser('dispatcher2', ['dispatcher']),
    technician: await makeUser('technician', ['technician']),
    standard: await makeUser('standard', ['standard_user']),
  };
  return team;
}

export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

/** Creates a work order and drives it to "scheduled_pending_issuing" (no automatic reservations). */
export async function scheduledWorkOrder(qty: number, opts: { exempt?: boolean } = {}) {
  const t = await getTeam();
  const f = await fixtures();
  const id = await call<string>(t.creator, 'save_work_order', {
    p_id: null,
    p_header: { institution_id: f.institutionId, work_order_type_id: opts.exempt ? f.exemptTypeId : f.typeId, recipient_type: 'school', priority: 'normal' },
    p_lines: [{ category_id: f.model.category_id, model_id: f.model.id, requested_qty: qty }],
  });
  await call(t.creator, 'submit_work_order', { p_id: id });
  await call(t.approver, 'approve_work_order', { p_id: id, p_lines: [], p_comment: 'integration test' });
  await call(t.manager, 'schedule_work_order', { p_id: id, p_warehouse_id: f.warehouseId, p_scheduled_date: today(), p_accept_shortage: true, p_reason: 'integration test' });
  await call(t.manager, 'release_for_issuing', { p_id: id, p_auto_reserve: false });
  return id;
}

/** Picks the given serials and confirms issuing. */
export async function issue(woId: string, serials: string[]) {
  const t = await getTeam();
  for (const s of serials) {
    const r = await call<{ ok: boolean; message: string }>(t.operator, 'pick_device', { p_work_order_id: woId, p_serial: s });
    if (!r.ok) throw new Error(`pick failed: ${r.message}`);
  }
  return call(t.operator, 'confirm_issuing', { p_work_order_id: woId });
}

export async function invoiceAndRelease(woId: string) {
  const t = await getTeam();
  const inv = await call<string>(t.invoicer, 'create_invoice_draft', { p_work_order_id: woId, p_auto_fill: true });
  await call(t.invoicer, 'issue_invoice', { p_invoice_id: inv });
  await call(t.dispatcher, 'mark_ready_for_dispatch', { p_work_order_id: woId });
  return inv;
}

export async function deviceBySerial(s: string) {
  const { data, error } = await svc.from('devices').select('*').eq('serial_number', s).single();
  if (error) throw error;
  return data as { id: string; status: string; condition: string; current_work_order_id: string | null };
}
export async function woStatus(id: string) {
  const { data } = await svc.from('work_orders').select('status').eq('id', id).single();
  return data!.status as string;
}

export async function cleanupUsers() {
  if (!team) return;
  // Users are deactivated (not deleted): their actions are part of the permanent audit history.
  for (const u of Object.values(team)) await svc.from('profiles').update({ is_active: false }).eq('id', u.id);
}
