// DEVELOPMENT ONLY: creates demo users and drives the real workflow functions
// (as those users) to produce work orders in many states, invoices, a dispatch
// with delivery confirmation, a serial mismatch, a replacement and a repair.
//   npm run setup:demo            (refuses to run against a non-local URL)
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) throw new Error('Run `npm run setup:env` first (missing Supabase environment variables)');
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
  throw new Error(`Refusing to seed demo data into a non-local Supabase (${url})`);
}

let password = process.env.DEMO_USER_PASSWORD;
if (!password) {
  password = 'Df-' + randomBytes(9).toString('base64url');
  const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
  writeFileSync('.env.local', /^DEMO_USER_PASSWORD=.*$/m.test(env)
    ? env.replace(/^DEMO_USER_PASSWORD=.*$/m, `DEMO_USER_PASSWORD=${password}`)
    : `${env}\nDEMO_USER_PASSWORD=${password}\n`);
}

const svc = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const USERS = [
  { key: 'admin', email: 'admin@deviceflow.test', name: 'Demo Administrator', roles: [['administrator']] },
  { key: 'creator', email: 'creator@deviceflow.test', name: 'Demo Standard User', roles: [['standard_user']] },
  { key: 'approver', email: 'approver@deviceflow.test', name: 'Demo Approver', roles: [['approver']] },
  { key: 'manager', email: 'manager@deviceflow.test', name: 'Demo Warehouse Manager', roles: [['warehouse_manager', 'JHB-01']] },
  { key: 'operator', email: 'operator@deviceflow.test', name: 'Demo Warehouse Operator', roles: [['warehouse_operator', 'JHB-01']] },
  { key: 'technician', email: 'technician@deviceflow.test', name: 'Demo Technician', roles: [['technician']] },
  { key: 'invoicer', email: 'invoicer@deviceflow.test', name: 'Demo Invoicer', roles: [['invoicer']] },
  { key: 'dispatcher', email: 'dispatcher@deviceflow.test', name: 'Demo Dispatcher', roles: [['dispatcher', 'JHB-01']] },
  { key: 'auditor', email: 'auditor@deviceflow.test', name: 'Demo Auditor', roles: [['auditor']] },
];

const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
};

const { data: whs } = await svc.from('warehouses').select('id, code');
const wh = Object.fromEntries(whs.map((w) => [w.code, w.id]));
const { data: roleRows } = await svc.from('roles').select('id, code');
const roleId = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));

const ids = {};
const { data: list } = await svc.auth.admin.listUsers({ perPage: 1000 });
for (const u of USERS) {
  let user = list.users.find((x) => x.email === u.email);
  if (!user) {
    user = must(await svc.auth.admin.createUser({ email: u.email, password, email_confirm: true, user_metadata: { full_name: u.name } }), `create ${u.email}`).user;
  } else {
    must(await svc.auth.admin.updateUserById(user.id, { password }), `update ${u.email}`);
  }
  ids[u.key] = user.id;
  await svc.from('profiles').upsert({ id: user.id, email: u.email, full_name: u.name, is_active: true });
  await svc.from('user_role_assignments').delete().eq('user_id', user.id);
  for (const [code, whCode] of u.roles) {
    must(await svc.from('user_role_assignments').insert({ user_id: user.id, role_id: roleId[code], warehouse_id: whCode ? wh[whCode] : null }), `role ${code}`);
  }
}
console.log('Demo users ready:', USERS.map((u) => u.email).join(', '));

const { count } = await svc.from('work_orders').select('id', { count: 'exact', head: true });
if (count > 0 && !process.argv.includes('--force')) {
  console.log(`Work orders already exist (${count}); skipping demo workflows. Run \`npm run db:reset\` then this script for a fresh demo.`);
  printSummary();
  process.exit(0);
}

const C = {};
for (const u of USERS) {
  const c = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  must(await c.auth.signInWithPassword({ email: u.email, password }), `sign in ${u.email}`);
  C[u.key] = c;
}
const rpc = async (who, fn, args) => must(await C[who].rpc(fn, args), `${who}.${fn}`);
const okScan = async (who, fn, args) => {
  const r = await rpc(who, fn, args);
  if (r && r.ok === false) throw new Error(`${fn} rejected: ${r.message}`);
  return r;
};

const byCode = async (table, col, val) => must(await svc.from(table).select('*').eq(col, val).single(), `${table}.${val}`);
const inst = async (emis) => (await byCode('institutions', 'emis_number', emis)).id;
const type = async (code) => (await byCode('work_order_types', 'code', code)).id;
const model = async (code) => byCode('device_models', 'model_code', code);
const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
const day = (n) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);

const lenovo = await model('LNV-100E-G4');
const hp = await model('HP-PB440-G10');
const tab = await model('SAM-TABA9');

async function newWO(emis, typeCode, lines, extra = {}) {
  return rpc('creator', 'save_work_order', {
    p_id: null,
    p_header: { institution_id: await inst(emis), work_order_type_id: await type(typeCode), recipient_type: 'school',
                priority: 'normal', description: 'Demo work order', ...extra },
    p_lines: lines.map(([m, qty]) => ({ category_id: m.category_id, model_id: m.id, requested_qty: qty })),
  });
}
const submit = (id) => rpc('creator', 'submit_work_order', { p_id: id });
const approve = (id) => rpc('approver', 'approve_work_order', { p_id: id, p_lines: [], p_comment: 'Approved for demo' });
const schedule = (id, d = 0) => rpc('manager', 'schedule_work_order', {
  p_id: id, p_warehouse_id: wh['JHB-01'], p_scheduled_date: day(d), p_assigned_team: 'Team A',
  p_assigned_to: ids.operator, p_priority: 'normal', p_reason: null, p_accept_shortage: false });
const release = (id, auto = true) => rpc('manager', 'release_for_issuing', { p_id: id, p_auto_reserve: auto });
async function pickReserved(id) {
  const { data } = await svc.from('work_order_devices').select('devices(serial_number)').eq('work_order_id', id).eq('status', 'reserved');
  for (const r of data) await okScan('operator', 'pick_device', { p_work_order_id: id, p_serial: r.devices.serial_number });
}
const issue = (id) => rpc('operator', 'confirm_issuing', { p_work_order_id: id });
async function invoiceAndIssue(id) {
  const inv = await rpc('invoicer', 'create_invoice_draft', { p_work_order_id: id, p_auto_fill: true });
  await rpc('invoicer', 'issue_invoice', { p_invoice_id: inv });
  return inv;
}
async function issuedSerials(id) {
  const { data } = await svc.from('work_order_devices').select('id, devices(serial_number)').eq('work_order_id', id).eq('status', 'issued');
  return data.map((r) => r.devices.serial_number);
}
async function dispatchSerials(id, serials) {
  const dsp = await rpc('dispatcher', 'create_dispatch', { p_work_order_id: id, p: {
    courier_name: 'Demo Courier Services', tracking_number: 'TRK' + Math.floor(Math.random() * 1e8), parcel_count: 1,
    expected_delivery_date: day(2) } });
  for (const s of serials) await okScan('dispatcher', 'dispatch_scan_device', { p_dispatch_id: dsp, p_serial: s });
  await rpc('dispatcher', 'confirm_dispatch', { p_dispatch_id: dsp });
  return dsp;
}
async function deliver(dsp, outcomes) {
  const { data } = await svc.from('dispatch_devices').select('id, devices(serial_number)').eq('dispatch_id', dsp);
  return rpc('dispatcher', 'record_delivery', { p_dispatch_id: dsp, p: {
    received_by_name: 'Demo Receiving Clerk', received_by_role: 'School administrator', comments: 'Demo delivery',
    devices: data.map((r, i) => ({ dispatch_device_id: r.id, result: outcomes[i] ?? 'received' })) } });
}

// A: draft
await newWO('900100101', 'new_allocation', [[lenovo, 10]], { description: 'Grade 7 laptop allocation (draft)' });
// B: pending authorisation
await submit(await newWO('900100102', 'new_allocation', [[hp, 5]], { recipient_type: 'teacher', description: 'Teacher laptops' }));
// C: returned for correction
const c = await newWO('900100103', 'additional_allocation', [[lenovo, 20]]);
await submit(c);
await rpc('approver', 'reject_work_order', { p_id: c, p_reason: 'Please confirm the learner numbers with the district office.' });
// D: pending scheduling
const d = await newWO('900100104', 'new_allocation', [[tab, 8]]);
await submit(d); await approve(d);
// E: scheduled
const e = await newWO('900100101', 'new_allocation', [[hp, 3]], { recipient_type: 'teacher' });
await submit(e); await approve(e); await schedule(e, 3);
// F: scheduled pending issuing with ABC123 reserved, then a mismatched scan of XYZ789
const f = await newWO('900100102', 'replacement', [[lenovo, 1]], { description: 'Replacement for ICT lab' });
await submit(f); await approve(f); await schedule(f, 1); await release(f, false);
await okScan('manager', 'reserve_device', { p_work_order_id: f, p_serial: 'ABC123' });
const mismatch = await rpc('operator', 'pick_device', { p_work_order_id: f, p_serial: 'XYZ789' });
console.log('Anti-swap demo:', mismatch.message);
// G: completed end-to-end with a part payment
const g = await newWO('900100101', 'full', [[lenovo, 4]], { description: 'Full work order - completed' });
await submit(g); await approve(g); await schedule(g, 0); await release(g); await pickReserved(g); await issue(g);
const gInv = await invoiceAndIssue(g);
const { data: gInvRow } = await svc.from('invoices').select('total_cents').eq('id', gInv).single();
await rpc('invoicer', 'record_payment', { p_invoice_id: gInv, p_amount_cents: Math.round(gInvRow.total_cents / 2), p_payment_date: day(0),
  p_method: 'eft', p_reference: 'EFT-DEMO-0001', p_notes: 'Part payment' });
await rpc('dispatcher', 'mark_ready_for_dispatch', { p_work_order_id: g });
const gDsp = await dispatchSerials(g, await issuedSerials(g));
await deliver(gDsp, []);
await rpc('manager', 'complete_work_order', { p_work_order_id: g, p_notes: 'All devices received' });
// H: partial dispatch + partial delivery
const h = await newWO('900100103', 'full', [[lenovo, 3]], { description: 'Partial delivery example' });
await submit(h); await approve(h); await schedule(h, 0); await release(h); await pickReserved(h); await issue(h);
await invoiceAndIssue(h);
await rpc('dispatcher', 'mark_ready_for_dispatch', { p_work_order_id: h });
const hSerials = await issuedSerials(h);
const hDsp = await dispatchSerials(h, hSerials.slice(0, 2));
await deliver(hDsp, ['received', 'missing']);
// I: pending invoicing (draft invoice)
const i = await newWO('900100104', 'new_allocation', [[hp, 2]]);
await submit(i); await approve(i); await schedule(i, 0); await release(i); await pickReserved(i); await issue(i);
await rpc('invoicer', 'create_invoice_draft', { p_work_order_id: i, p_auto_fill: true });
// J: invoice-exempt, ready for dispatch
const j = await newWO('900100101', 'same_learner_same_device', [[lenovo, 1]], { recipient_type: 'learner', grade: '7', class_name: '7A' });
await submit(j); await approve(j); await schedule(j, 0); await release(j); await pickReserved(j); await issue(j);
await rpc('dispatcher', 'mark_ready_for_dispatch', { p_work_order_id: j });
// K: replacement transaction + repair of the original device
const k = await newWO('900100102', 'new_allocation', [[lenovo, 2]]);
await submit(k); await approve(k); await schedule(k, 2); await release(k);
const { data: kAlloc } = await svc.from('work_order_devices').select('id').eq('work_order_id', k).eq('status', 'reserved').limit(1).single();
const { data: spare } = await svc.from('devices').select('serial_number').eq('warehouse_id', wh['JHB-01']).eq('status', 'available')
  .eq('model_id', lenovo.id).neq('serial_number', 'XYZ789').order('serial_number', { ascending: false }).limit(1).single();
const repl = await rpc('manager', 'replace_allocated_device', { p_allocation_id: kAlloc.id, p_new_serial: spare.serial_number,
  p_reason: 'Keyboard damage found during pre-issue inspection', p_original_new_status: 'faulty' });
console.log('Replacement demo:', repl.replacement_number, repl.original_serial, '->', repl.replacement_serial);
const { data: asm } = await svc.from('device_assessments').select('id').eq('work_order_id', k).single();
const asmRes = await rpc('technician', 'complete_assessment', { p_assessment_id: asm.id, p: {
  outcome: 'repair_required', diagnostic_results: 'Three keys unresponsive; keyboard ribbon damaged', physical_condition: 'Minor scuffs',
  estimated_cost_cents: 45000, recommended_action: 'Replace keyboard' } });
await rpc('technician', 'advance_repair', { p_repair_id: asmRes.repair_id, p_to_status: 'under_repair', p: { notes: 'Repair started' } });
await rpc('technician', 'add_repair_part', { p_repair_id: asmRes.repair_id, p_part_name: 'Keyboard assembly', p_part_number: 'KB-100E',
  p_quantity: 1, p_unit_cost_cents: 32000 });
// L: a fault reported on stock, awaiting assessment
const { data: tabDev } = await svc.from('devices').select('id').eq('model_id', tab.id).eq('status', 'available').limit(1).single();
await rpc('creator', 'report_device_fault', { p_device_id: tabDev.id, p_fault: 'Screen flickers intermittently', p_work_order_id: null, p_origin: 'Warehouse' });
// M: pending stock adjustment
const { data: adjDev } = await svc.from('devices').select('id').eq('model_id', hp.id).eq('status', 'available').limit(1).single();
await rpc('operator', 'request_stock_adjustment', { p_device_id: adjDev.id, p_type: 'mark_lost', p_reason: 'Not found on shelf A-01-02 during spot check' });
// N: goods receipt completed
const grn = await rpc('manager', 'create_goods_receipt', { p: { warehouse_id: wh['JHB-01'], source_type: 'purchase',
  source_reference: 'PO-DEMO-2026-077', lines: [{ model_id: tab.id, expected_qty: 3 }] } });
const { data: grnLine } = await svc.from('goods_receipt_lines').select('id').eq('goods_receipt_id', grn).single();
const { data: rcvLoc } = await svc.from('warehouse_locations').select('id').eq('warehouse_id', wh['JHB-01']).eq('code', 'A-02-01').single();
for (const s of ['R9TN000901', 'R9TN000902', 'R9TN000903']) {
  await okScan('manager', 'receive_device_into_receipt', { p_receipt_id: grn, p_line_id: grnLine.id, p: { serial_number: s, condition: 'new', location_id: rcvLoc.id } });
}
await rpc('manager', 'complete_goods_receipt', { p_receipt_id: grn, p_discrepancy_notes: null });

console.log('Demo workflows created.');
printSummary();

function printSummary() {
  console.log('\nDemo accounts (development only):');
  for (const u of USERS) console.log(`  ${u.email.padEnd(30)} ${u.name}`);
  console.log('Password: the DEMO_USER_PASSWORD value in .env.local');
}
