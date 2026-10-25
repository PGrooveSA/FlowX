import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call, cleanupUsers, deviceBySerial, fails, fixtures, getTeam, invoiceAndRelease, issue, registerDevices, scheduledWorkOrder,
  serial, svc, woStatus, type Team,
} from './helpers';

let t: Team;
beforeAll(async () => { t = await getTeam(); await fixtures(); });
afterAll(async () => { await cleanupUsers(); });

describe('Scenario A â€” duplicate serial number', () => {
  it('rejects registering an existing serial, including formatting variants', async () => {
    const [s] = await registerDevices(t.manager, 1, 'A');
    const f = await fixtures();
    const dup = await fails(t.manager, 'register_device', { p: { model_id: f.model.id, warehouse_id: f.warehouseId, serial_number: s, condition: 'new' } });
    expect(dup.message).toMatch(/Duplicate serial number/);
    const variant = `${s.slice(0, 4)}-${s.slice(4).toLowerCase()}`;
    const dup2 = await fails(t.manager, 'register_device', { p: { model_id: f.model.id, warehouse_id: f.warehouseId, serial_number: variant, condition: 'new' } });
    expect(dup2.message).toMatch(/Duplicate serial number/);
    const { count } = await svc.from('devices').select('id', { count: 'exact', head: true }).eq('serial_number', s);
    expect(count).toBe(1);
  });

  it('rejects duplicates inside a bulk import without committing the chunk', async () => {
    const s = serial('AI');
    const r = await call<{ committed: boolean; errors: unknown[] }>(t.admin, 'import_devices', {
      p_rows: [{ model_code: 'DELL-LAT3440', serial_number: s }, { model_code: 'DELL-LAT3440', serial_number: s }],
      p_warehouse_id: (await fixtures()).warehouseId, p_dry_run: false,
    });
    expect(r.committed).toBe(false);
    expect(r.errors).toHaveLength(1);
    const { count } = await svc.from('devices').select('id', { count: 'exact', head: true }).eq('serial_number', s);
    expect(count).toBe(0);
  });
});

describe('Scenario B â€” wrong device during issuing (anti-swap)', () => {
  it('blocks a scanned serial that does not match the reserved serial and records the discrepancy', async () => {
    const [expected, wrong] = await registerDevices(t.manager, 2, 'B');
    const wo = await scheduledWorkOrder(1);
    const res = await call<{ ok: boolean }>(t.manager, 'reserve_device', { p_work_order_id: wo, p_serial: expected });
    expect(res.ok).toBe(true);

    const r = await call<{ ok: boolean; code: string; expected_serial: string; scanned_serial: string; discrepancy_number: string }>(
      t.operator, 'pick_device', { p_work_order_id: wo, p_serial: wrong });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('serial_mismatch');
    expect(r.expected_serial).toBe(expected);
    expect(r.scanned_serial).toBe(wrong);

    const { data: disc } = await svc.from('serial_discrepancies').select('*').eq('discrepancy_number', r.discrepancy_number).single();
    expect(disc).toMatchObject({ status: 'open', reason_code: 'serial_mismatch', expected_serial: expected, scanned_serial: wrong, work_order_id: wo, reported_by: t.operator.id });
    const { data: audit } = await svc.from('audit_logs').select('success, action').eq('entity_id', disc!.id);
    expect(audit?.[0]).toMatchObject({ success: false, action: 'serial_discrepancy' });

    expect((await deviceBySerial(wrong)).status).toBe('available');
    // Scanned device is blocked from use elsewhere until resolved, and issuing cannot be confirmed
    const again = await call<{ ok: boolean; code: string }>(t.operator, 'pick_device', { p_work_order_id: wo, p_serial: wrong });
    expect(again.code).toBe('blocked_by_discrepancy');
    await call(t.operator, 'pick_device', { p_work_order_id: wo, p_serial: expected });
    const blocked = await fails(t.operator, 'confirm_issuing', { p_work_order_id: wo });
    expect(blocked.message).toMatch(/open serial discrepancies/);

    // Resolution by another authorised user (not the reporter) unblocks
    await call(t.manager, 'resolve_discrepancy', { p_id: disc!.id, p_resolution: 'Wrong label applied; correct device located and scanned', p_dismiss: false });
    const ok = await call<{ issued_now: number }>(t.operator, 'confirm_issuing', { p_work_order_id: wo });
    expect(ok.issued_now).toBe(1);
    expect((await deviceBySerial(expected)).status).toBe('issued');
  });
});

describe('Scenario C â€” faulty device cannot be allocated or dispatched', () => {
  it('rejects reserving and picking a device under repair', async () => {
    const [s] = await registerDevices(t.manager, 1, 'C');
    const dev = await deviceBySerial(s);
    const asm = await call<string>(t.technician, 'report_device_fault', { p_device_id: dev.id, p_fault: 'Does not power on' });
    const done = await call<{ repair_id: string }>(t.technician, 'complete_assessment', { p_assessment_id: asm, p: { outcome: 'repair_required', diagnostic_results: 'Faulty power board', estimated_cost_cents: 10000 } });
    await call(t.technician, 'advance_repair', { p_repair_id: done.repair_id, p_to_status: 'under_repair', p: {} });
    expect((await deviceBySerial(s)).status).toBe('under_repair');

    const wo = await scheduledWorkOrder(1);
    const res = await call<{ ok: boolean; code: string; message: string }>(t.manager, 'reserve_device', { p_work_order_id: wo, p_serial: s });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Under Repair/);
    const pick = await call<{ ok: boolean; code: string }>(t.operator, 'pick_device', { p_work_order_id: wo, p_serial: s });
    expect(pick.ok).toBe(false);
    expect(pick.code).toBe('ineligible');
    // release to stock is blocked while the repair is open
    const loc = await svc.from('warehouse_locations').select('id').eq('warehouse_id', (await fixtures()).warehouseId).eq('code', 'A-01-01').single();
    const rel = await fails(t.manager, 'release_device_to_stock', { p_device_id: dev.id, p_location_id: loc.data!.id, p_condition: 'good' });
    expect(rel.message).toMatch(/returned, repaired or quarantined|open repair/);
  });

  it('rejects dispatching a device that is not an issued allocation', async () => {
    const [good, faulty] = await registerDevices(t.manager, 2, 'CD');
    const wo = await scheduledWorkOrder(1);
    await issue(wo, [good]);
    await invoiceAndRelease(wo);
    const dev = await deviceBySerial(faulty);
    await call(t.technician, 'report_device_fault', { p_device_id: dev.id, p_fault: 'Cracked screen' });
    const dsp = await call<string>(t.dispatcher, 'create_dispatch', { p_work_order_id: wo, p: { courier_name: 'IT Courier', parcel_count: 1 } });
    const r = await call<{ ok: boolean; code: string }>(t.dispatcher, 'dispatch_scan_device', { p_dispatch_id: dsp, p_serial: faulty });
    expect(r.ok).toBe(false);
    expect(['not_allocated', 'ineligible']).toContain(r.code);
    expect((await deviceBySerial(faulty)).status).toBe('faulty');
  });
});

describe('Scenario D â€” duplicate reservation', () => {
  it('allows only one of two concurrent reservations of the same device for different work orders', async () => {
    const [s] = await registerDevices(t.manager, 1, 'D');
    const wo1 = await scheduledWorkOrder(1);
    const wo2 = await scheduledWorkOrder(1);
    const [r1, r2] = await Promise.all([
      call<{ ok: boolean }>(t.manager, 'reserve_device', { p_work_order_id: wo1, p_serial: s }),
      call<{ ok: boolean }>(t.operator, 'reserve_device', { p_work_order_id: wo2, p_serial: s }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const dev = await deviceBySerial(s);
    const { data: active } = await svc.from('work_order_devices').select('work_order_id').eq('device_id', dev.id).in('status', ['reserved', 'picked', 'issued', 'dispatched']);
    expect(active).toHaveLength(1);
    expect(dev.status).toBe('reserved');
  });
});

describe('Scenario E â€” invoice quantity', () => {
  it('rejects invoicing more devices than are authorised/issued', async () => {
    const serials = await registerDevices(t.manager, 2, 'E');
    const wo = await scheduledWorkOrder(2);
    await issue(wo, serials);
    const inv = await call<string>(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: false });
    const { data: line } = await svc.from('work_order_lines').select('id').eq('work_order_id', wo).single();
    const err = await fails(t.invoicer, 'add_invoice_device_line', { p_invoice_id: inv, p_work_order_line_id: line!.id, p_quantity: 3 });
    expect(err.message).toMatch(/exceeds the billable quantity 2/);
    await call(t.invoicer, 'add_invoice_device_line', { p_invoice_id: inv, p_work_order_line_id: line!.id, p_quantity: 2 });
    const { data: invoice } = await svc.from('invoices').select('total_cents, vat_cents').eq('id', inv).single();
    const f = await fixtures();
    expect(invoice!.total_cents).toBe(Math.round(2 * f.model.unit_price_cents * 1.15));
  });
});

describe('Scenario F â€” duplicate invoice', () => {
  it('prevents invoicing the same allocation twice', async () => {
    const serials = await registerDevices(t.manager, 1, 'F');
    const wo = await scheduledWorkOrder(1);
    await issue(wo, serials);
    const inv = await call<string>(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: true });
    const draftDup = await fails(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: true });
    expect(draftDup.message).toMatch(/draft invoice already exists/);
    await call(t.invoicer, 'issue_invoice', { p_invoice_id: inv });
    const dup = await fails(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: true });
    expect(dup.message).toMatch(/already been invoiced/);
    // Database constraint is the final guard: one active link per allocation
    const { data: links } = await svc.from('invoice_device_links').select('work_order_device_id').eq('status', 'active').eq('invoice_id', inv);
    const { error } = await svc.from('invoice_device_links').insert({ invoice_id: inv, invoice_line_id: (await svc.from('invoice_lines').select('id').eq('invoice_id', inv).single()).data!.id,
      work_order_device_id: links![0].work_order_device_id, device_id: (await deviceBySerial(serials[0])).id });
    expect(error?.code).toBe('23505');
  });
});

describe('Scenario G + H â€” partial dispatch and partial delivery', () => {
  it('marks only scanned devices as dispatched and records received/outstanding quantities', async () => {
    const serials = await registerDevices(t.manager, 3, 'G');
    const wo = await scheduledWorkOrder(3);
    await issue(wo, serials);
    await invoiceAndRelease(wo);
    const dsp = await call<string>(t.dispatcher, 'create_dispatch', { p_work_order_id: wo, p: { courier_name: 'IT Courier', parcel_count: 1 } });
    for (const s of serials.slice(0, 2)) {
      const r = await call<{ ok: boolean }>(t.dispatcher, 'dispatch_scan_device', { p_dispatch_id: dsp, p_serial: s });
      expect(r.ok).toBe(true);
    }
    await call(t.dispatcher, 'confirm_dispatch', { p_dispatch_id: dsp });
    expect((await deviceBySerial(serials[0])).status).toBe('dispatched');
    expect((await deviceBySerial(serials[1])).status).toBe('dispatched');
    expect((await deviceBySerial(serials[2])).status).toBe('issued');
    expect(await woStatus(wo)).toBe('partially_dispatched');

    // Scenario H
    const { data: manifest } = await svc.from('dispatch_devices').select('id, devices(serial_number)').eq('dispatch_id', dsp);
    const res = await call<{ outcome: string; expected: number; received: number; outstanding: number }>(t.dispatcher, 'record_delivery', {
      p_dispatch_id: dsp, p: { received_by_name: 'IT Receiver', devices: manifest!.map((m, i) => ({ dispatch_device_id: m.id, result: i === 0 ? 'received' : 'missing' })) } });
    expect(res).toMatchObject({ outcome: 'partially_delivered', expected: 2, received: 1, outstanding: 1 });
    const { data: dc } = await svc.from('delivery_confirmations').select('*').eq('dispatch_id', dsp).single();
    expect(dc).toMatchObject({ quantity_expected: 2, quantity_received: 1, quantity_missing: 1 });
    const received = (manifest![0].devices as unknown as { serial_number: string }).serial_number;
    expect((await deviceBySerial(received)).status).toBe('delivered');
    expect(await woStatus(wo)).toBe('partially_delivered');
    const { count } = await svc.from('serial_discrepancies').select('id', { count: 'exact', head: true }).eq('dispatch_id', dsp).eq('reason_code', 'missing_on_delivery');
    expect(count).toBe(1);
    // A delivery cannot be recorded twice for the same dispatch
    await fails(t.dispatcher, 'record_delivery', { p_dispatch_id: dsp, p: { received_by_name: 'x', devices: [] } });
  });
});

describe('Scenario I â€” replacement', () => {
  it('preserves both devices, the reason, the authorisation and both custody histories', async () => {
    const [orig, repl] = await registerDevices(t.manager, 2, 'I');
    const wo = await scheduledWorkOrder(1);
    await call(t.manager, 'reserve_device', { p_work_order_id: wo, p_serial: orig });
    const o = await deviceBySerial(orig);
    const { data: alloc } = await svc.from('work_order_devices').select('id').eq('device_id', o.id).eq('status', 'reserved').single();
    const r = await call<{ replacement_number: string }>(t.manager, 'replace_allocated_device', {
      p_allocation_id: alloc!.id, p_new_serial: repl, p_reason: 'Hinge broken during inspection', p_original_new_status: 'faulty' });
    const { data: tx } = await svc.from('replacement_transactions').select('*').eq('replacement_number', r.replacement_number).single();
    const n = await deviceBySerial(repl);
    expect(tx).toMatchObject({ original_device_id: o.id, replacement_device_id: n.id, reason: 'Hinge broken during inspection', authorised_by: t.manager.id, work_order_id: wo });
    expect((await deviceBySerial(orig)).status).toBe('faulty');
    expect(n.status).toBe('reserved');
    const { data: oldAlloc } = await svc.from('work_order_devices').select('status, replaced_by_id').eq('id', alloc!.id).single();
    expect(oldAlloc!.status).toBe('replaced');
    expect(oldAlloc!.replaced_by_id).toBe(tx!.new_allocation_id);
    const { data: mo } = await svc.from('device_movements').select('movement_type').eq('device_id', o.id);
    const { data: mn } = await svc.from('device_movements').select('movement_type').eq('device_id', n.id);
    expect(mo!.map((m) => m.movement_type)).toEqual(expect.arrayContaining(['registered', 'reserved', 'replaced_out']));
    expect(mn!.map((m) => m.movement_type)).toEqual(expect.arrayContaining(['registered', 'replaced_in']));
  });
});

describe('Scenario J â€” role permissions enforced by the backend', () => {
  it('rejects a standard user issuing invoices, approving work orders or approving stock adjustments', async () => {
    const serials = await registerDevices(t.manager, 1, 'J');
    const wo = await scheduledWorkOrder(1);
    await issue(wo, serials);
    const inv = await call<string>(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: true });
    const e1 = await fails(t.standard, 'issue_invoice', { p_invoice_id: inv });
    expect(e1.code).toBe('42501');

    const f = await fixtures();
    const draft = await call<string>(t.standard, 'save_work_order', { p_id: null,
      p_header: { institution_id: f.institutionId, work_order_type_id: f.typeId, recipient_type: 'school', priority: 'normal' },
      p_lines: [{ category_id: f.model.category_id, model_id: f.model.id, requested_qty: 1 }] });
    await call(t.standard, 'submit_work_order', { p_id: draft });
    const e2 = await fails(t.standard, 'approve_work_order', { p_id: draft, p_lines: [], p_comment: null });
    expect(e2.code).toBe('42501');

    const dev = await deviceBySerial((await registerDevices(t.manager, 1, 'J2'))[0]);
    const adj = await call<string>(t.standard, 'request_stock_adjustment', { p_device_id: dev.id, p_type: 'mark_lost', p_reason: 'Cannot find it on the shelf' });
    const e3 = await fails(t.standard, 'decide_stock_adjustment', { p_adjustment_id: adj, p_approve: true, p_comment: null });
    expect(e3.code).toBe('42501');
    // Segregation of duties: the requester cannot approve their own adjustment either
    const self = await call<string>(t.manager, 'request_stock_adjustment', { p_device_id: (await deviceBySerial((await registerDevices(t.manager, 1, 'J3'))[0])).id, p_type: 'mark_lost', p_reason: 'Spot check missing' });
    const e4 = await fails(t.manager, 'decide_stock_adjustment', { p_adjustment_id: self, p_approve: true, p_comment: null });
    expect(e4.message).toMatch(/Segregation of duties/);

    // Direct table writes are refused (no browser-supplied statuses)
    const direct = await t.standard.client.from('devices').update({ status: 'available' }).eq('id', dev.id);
    expect(direct.error?.code).toBe('42501');
    const direct2 = await t.admin.client.from('audit_logs').delete().gt('id', 0);
    expect(direct2.error).toBeTruthy();
    const { data: unchanged } = await svc.from('devices').select('status').eq('id', dev.id).single();
    expect(unchanged!.status).toBe('available');
  });
});

describe('Scenario K â€” cancellation and correction', () => {
  it('cancels an issued work order through compensating reversals without deleting history', async () => {
    const serials = await registerDevices(t.manager, 2, 'K');
    const wo = await scheduledWorkOrder(2);
    await issue(wo, serials);
    await call(t.admin, 'cancel_work_order', { p_id: wo, p_reason: 'Duplicate request from district' });
    expect(await woStatus(wo)).toBe('cancelled');
    for (const s of serials) expect((await deviceBySerial(s)).status).toBe('available');
    const { data: allocs } = await svc.from('work_order_devices').select('status').eq('work_order_id', wo);
    expect(allocs!.every((a) => a.status === 'cancelled')).toBe(true);
    const { count: hist } = await svc.from('work_order_status_history').select('id', { count: 'exact', head: true }).eq('work_order_id', wo);
    expect(hist).toBeGreaterThanOrEqual(8);
    const { data: mv } = await svc.from('device_movements').select('movement_type').eq('device_id', (await deviceBySerial(serials[0])).id);
    expect(mv!.map((m) => m.movement_type)).toEqual(expect.arrayContaining(['issued', 'allocation_reversal']));
  });

  it('corrects an issued invoice only through a credit note, keeping the original', async () => {
    const serials = await registerDevices(t.manager, 1, 'K2');
    const wo = await scheduledWorkOrder(1);
    await issue(wo, serials);
    const inv = await call<string>(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: true });
    await call(t.invoicer, 'issue_invoice', { p_invoice_id: inv });
    const c = await fails(t.invoicer, 'cancel_invoice', { p_invoice_id: inv, p_reason: 'Wrong customer details' });
    expect(c.message).toMatch(/credit note/);
    const tamper = await svc.from('invoices').update({ total_cents: 1 }).eq('id', inv);
    expect(tamper.error?.message).toMatch(/cannot be edited/);
    const cn = await call<{ released_allocations: number }>(t.invoicer, 'create_credit_note', { p_invoice_id: inv, p_reason: 'Wrong customer details', p_full: true });
    expect(cn.released_allocations).toBe(1);
    const { data: invoice } = await svc.from('invoices').select('status, invoice_number, total_cents, credited_cents').eq('id', inv).single();
    expect(invoice!.status).toBe('credited');
    expect(invoice!.credited_cents).toBe(invoice!.total_cents);
    expect(await woStatus(wo)).toBe('pending_invoicing');
    // the allocation can now be re-invoiced correctly
    const inv2 = await call<string>(t.invoicer, 'create_invoice_draft', { p_work_order_id: wo, p_auto_fill: true });
    expect(inv2).not.toBe(inv);
  });
});

describe('Scenario L â€” concurrent dispatch', () => {
  it('lets only one of two dispatchers load and dispatch the same device', async () => {
    const serials = await registerDevices(t.manager, 1, 'L');
    const wo = await scheduledWorkOrder(1);
    await issue(wo, serials);
    await invoiceAndRelease(wo);
    const d1 = await call<string>(t.dispatcher, 'create_dispatch', { p_work_order_id: wo, p: { courier_name: 'Courier A', parcel_count: 1 } });
    const d2 = await call<string>(t.dispatcher2, 'create_dispatch', { p_work_order_id: wo, p: { courier_name: 'Courier B', parcel_count: 1 } });
    const [a, b] = await Promise.all([
      call<{ ok: boolean }>(t.dispatcher, 'dispatch_scan_device', { p_dispatch_id: d1, p_serial: serials[0] }),
      call<{ ok: boolean }>(t.dispatcher2, 'dispatch_scan_device', { p_dispatch_id: d2, p_serial: serials[0] }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? { u: t.dispatcher, d: d1 } : { u: t.dispatcher2, d: d2 };
    const loser = a.ok ? { u: t.dispatcher2, d: d2 } : { u: t.dispatcher, d: d1 };
    const [c1, c2] = await Promise.allSettled([
      call(winner.u, 'confirm_dispatch', { p_dispatch_id: winner.d }),
      call(loser.u, 'confirm_dispatch', { p_dispatch_id: loser.d }),
    ]);
    expect(c1.status).toBe('fulfilled');
    expect(c2.status).toBe('rejected');
    const { count } = await svc.from('dispatch_devices').select('id', { count: 'exact', head: true }).eq('device_id', (await deviceBySerial(serials[0])).id).eq('status', 'dispatched');
    expect(count).toBe(1);
    // Confirming the same dispatch twice concurrently is also safe
    const again = await fails(winner.u, 'confirm_dispatch', { p_dispatch_id: winner.d });
    expect(again.message).toMatch(/already dispatched/);
  });
});

describe('Security â€” audit trail, public link and RLS scope', () => {
  it('keeps audit records immutable even for the service role', async () => {
    const { data: row } = await svc.from('audit_logs').select('id').limit(1).single();
    const { error } = await svc.from('audit_logs').update({ action: 'tampered' }).eq('id', row!.id);
    expect(error?.message).toMatch(/append-only/);
  });

  it('restricts the anonymous recipient link to one shipment and one use', async () => {
    const serials = await registerDevices(t.manager, 1, 'T');
    const wo = await scheduledWorkOrder(1);
    await issue(wo, serials);
    await invoiceAndRelease(wo);
    const d = await call<string>(t.dispatcher, 'create_dispatch', { p_work_order_id: wo, p: { courier_name: 'Courier', parcel_count: 1 } });
    await call(t.dispatcher, 'dispatch_scan_device', { p_dispatch_id: d, p_serial: serials[0] });
    await call(t.dispatcher, 'confirm_dispatch', { p_dispatch_id: d });
    const { token } = await call<{ token: string }>(t.dispatcher, 'create_delivery_token', { p_dispatch_id: d });
    const { createClient } = await import('@supabase/supabase-js');
    const anon = createClient(process.env.SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    expect((await anon.from('devices').select('id').limit(1)).data ?? []).toHaveLength(0);
    const info = await anon.rpc('get_delivery_by_token', { p_token: token });
    expect(info.error).toBeNull();
    expect((info.data as { devices: unknown[] }).devices).toHaveLength(1);
    const ok = await anon.rpc('confirm_delivery_by_token', { p_token: token, p: { received_by_name: 'School Clerk', devices: (info.data as { devices: { dispatch_device_id: string }[] }).devices.map((x) => ({ dispatch_device_id: x.dispatch_device_id, result: 'received' })) } });
    expect(ok.error).toBeNull();
    const reuse = await anon.rpc('get_delivery_by_token', { p_token: token });
    expect(reuse.error?.message).toMatch(/already been confirmed/);
    const bogus = await anon.rpc('get_delivery_by_token', { p_token: 'a'.repeat(64) });
    expect(bogus.error?.message).toMatch(/invalid/);
    expect(await woStatus(wo)).toBe('delivered');
  });
});
