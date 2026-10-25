import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, MapPin, PackageOpen, Printer, ShieldCheck, Wrench, FileEdit, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney, labelize } from '@/lib/utils';
import { DEVICE_CONDITIONS } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useLocations } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { ConfirmDialog, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';
import type { DeviceRow } from './DeviceRegisterPage';

const IN_WAREHOUSE = ['received', 'available', 'reserved', 'picked', 'issued', 'faulty', 'under_assessment', 'under_repair', 'awaiting_parts', 'repair_completed', 'returned_to_warehouse', 'quarantined'];

export function DeviceDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | 'fault' | 'adjust' | 'identity' | 'location' | 'release' | 'edit'>(null);
  const q = useQuery({
    queryKey: ['device', id],
    queryFn: async () => {
      const [device, movements, allocations, assessments, repairs, replacements, invoices, dispatches] = await Promise.all([
        fetchOne<DeviceRow & Record<string, string>>('v_devices', 'id', id),
        fetchAll<Record<string, string>>('v_device_movements', '*', (x) => x.eq('device_id', id).order('performed_at', { ascending: false }).limit(200)),
        fetchAll<{ id: string; status: string; created_at: string; release_reason: string | null; work_orders: { id: string; wo_number: string } }>('work_order_devices', 'id, status, created_at, release_reason, work_orders(id, wo_number)', (x) => x.eq('device_id', id).order('created_at', { ascending: false })),
        fetchAll<Record<string, string>>('device_assessments', 'id, assessment_number, status, outcome, reported_fault, reported_at', (x) => x.eq('device_id', id).order('reported_at', { ascending: false })),
        fetchAll<Record<string, string>>('v_repairs', 'id, repair_number, status, total_cost_cents, created_at, qc_result', (x) => x.eq('device_id', id).order('created_at', { ascending: false })),
        fetchAll<Record<string, string>>('replacement_transactions', 'id, replacement_number, reason, created_at, original_device_id, replacement_device_id, original:original_device_id(serial_number), replacement:replacement_device_id(serial_number)', (x) => x.or(`original_device_id.eq.${id},replacement_device_id.eq.${id}`)),
        can('invoices.view') ? fetchAll<{ id: string; status: string; invoices: { id: string; invoice_number: string | null; status: string } }>('invoice_device_links', 'id, status, invoices(id, invoice_number, status)', (x) => x.eq('device_id', id)) : Promise.resolve([]),
        can('dispatch.view') ? fetchAll<{ id: string; status: string; dispatches: { id: string; dispatch_number: string; dispatched_at: string } }>('dispatch_devices', 'id, status, dispatches(id, dispatch_number, dispatched_at)', (x) => x.eq('device_id', id)) : Promise.resolve([]),
      ]);
      return { device, movements, allocations, assessments, repairs, replacements, invoices, dispatches };
    },
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['device', id] }); void qc.invalidateQueries({ queryKey: ['devices'] }); };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); refresh(); } catch (e) { toast.error((e as Error).message); throw e; }
  };

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data?.device;
  if (!d) return <ErrorState error={new Error('Device not found or outside your warehouse scope')} />;
  const inWh = IN_WAREHOUSE.includes(d.status);

  return (
    <div className="space-y-4">
      <PageHeader title={d.serial_number ?? d.asset_tag} crumbs={[{ label: 'Device Register', to: '/devices' }, { label: d.asset_tag }]}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={d.status} kind="device" /> {d.manufacturer} {d.model_name} · {d.asset_tag}
          {d.has_open_discrepancy && <Badge tone="red">Open serial discrepancy — blocked</Badge>}</span>}
        actions={<>
          {can('labels.print') && <Button size="sm" variant="outline" asChild><Link to={`/print/labels?ids=${d.id}`} target="_blank"><Printer /> Label</Link></Button>}
          {can('devices.edit') && <Button size="sm" variant="outline" onClick={() => setDialog('edit')}><FileEdit /> Edit details</Button>}
          {can('inventory.transfer') && inWh && <Button size="sm" variant="outline" onClick={() => setDialog('location')}><MapPin /> Move location</Button>}
          {can('assessments.record') && !['faulty', 'under_assessment', 'under_repair', 'awaiting_parts', 'written_off', 'lost', 'stolen', 'dispatched'].includes(d.status) &&
            <Button size="sm" variant="outline" onClick={() => setDialog('fault')}><Wrench /> Report fault</Button>}
          {can('inventory.release') && ['returned_to_warehouse', 'repair_completed', 'quarantined'].includes(d.status) &&
            <Button size="sm" onClick={() => setDialog('release')}><PackageOpen /> Release to stock</Button>}
          {can('inventory.adjust_request') && <Button size="sm" variant="outline" onClick={() => setDialog('adjust')}><Scale /> Request adjustment</Button>}
          {can('devices.correct_identity') && <Button size="sm" variant="outline" onClick={() => setDialog('identity')}><ShieldCheck /> Correct identity</Button>}
        </>} />

      {['faulty', 'under_assessment', 'under_repair', 'awaiting_parts', 'quarantined', 'returned_to_warehouse', 'repair_completed', 'lost', 'stolen', 'written_off'].includes(d.status) && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"><AlertTriangle className="h-4 w-4" />
          This device cannot be allocated, issued or dispatched while it is "{labelize(d.status)}". It must be inspected and released first.</div>)}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Identity and location</CardTitle></CardHeader><CardContent>
          <KeyValue columns={3} items={[
            ['Serial number', <span className="mono">{d.serial_number ?? `Exception: ${d.serial_exception_reason}`}</span>], ['Asset tag', <span className="mono">{d.asset_tag}</span>], ['IMEI', d.imei],
            ['Manufacturer', d.manufacturer], ['Model', `${d.model_name} (${d.model_code})`], ['Category', d.category_name],
            ['Condition', labelize(d.condition)], ['Warehouse', `${d.warehouse_code} — ${d.warehouse_name}`], ['Location', d.location_code],
            ['Work order', d.wo_number ? <Link className="mono text-primary hover:underline" to={`/work-orders/${d.current_work_order_id}`}>{d.wo_number}</Link> : '—'],
            ['Institution', d.institution_name], ['Supplier', d.supplier_name],
            ['Acquisition reference', d.acquisition_reference], ['Purchase date', formatDate(d.purchase_date)], ['Unit cost', formatMoney(Number(d.unit_cost_cents) || null)],
            ['Warranty to', formatDate(d.warranty_expires_on)], ['Received', formatDateTime(d.received_at)], ['Last verified', formatDateTime(d.last_verified_at)],
          ]} />
          {d.notes && <p className="mt-4 whitespace-pre-wrap text-sm"><span className="text-xs text-muted-foreground">Notes</span><br />{d.notes}</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Linked records</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
          <div><p className="text-xs text-muted-foreground">Allocations</p>{q.data!.allocations.length ? q.data!.allocations.map((a) => (
            <div key={a.id} className="flex items-center justify-between"><Link className="mono text-primary hover:underline" to={`/work-orders/${a.work_orders.id}`}>{a.work_orders.wo_number}</Link><StatusBadge status={a.status} /></div>)) : '—'}</div>
          <div><p className="text-xs text-muted-foreground">Invoices</p>{q.data!.invoices.length ? q.data!.invoices.map((l) => (
            <div key={l.id} className="flex items-center justify-between"><Link className="mono text-primary hover:underline" to={`/invoicing/${l.invoices.id}`}>{l.invoices.invoice_number ?? 'Draft'}</Link><StatusBadge status={l.status} /></div>)) : '—'}</div>
          <div><p className="text-xs text-muted-foreground">Dispatches</p>{q.data!.dispatches.length ? q.data!.dispatches.map((l) => (
            <div key={l.id} className="flex items-center justify-between"><Link className="mono text-primary hover:underline" to={`/dispatch/${l.dispatches.id}`}>{l.dispatches.dispatch_number}</Link><StatusBadge status={l.status} /></div>)) : '—'}</div>
          <div><p className="text-xs text-muted-foreground">Replacements</p>{q.data!.replacements.length ? q.data!.replacements.map((r) => (
            <div key={r.id} className="text-xs"><span className="mono">{r.replacement_number}</span>: {(r.original as unknown as { serial_number: string }).serial_number} → {(r.replacement as unknown as { serial_number: string }).serial_number}<br /><span className="text-muted-foreground">{r.reason}</span></div>)) : '—'}</div>
        </CardContent></Card>
      </div>

      <Tabs defaultValue="custody">
        <TabsList><TabsTrigger value="custody">Custody history</TabsTrigger><TabsTrigger value="repairs">Assessments &amp; repairs</TabsTrigger><TabsTrigger value="attachments">Attachments</TabsTrigger></TabsList>
        <TabsContent value="custody">
          <Card><CardContent className="overflow-x-auto p-0">
            {q.data!.movements.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
              <th className="px-3 py-2">When</th><th className="px-3 py-2">Movement</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">From → To</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">By</th></tr></thead>
              <tbody>{q.data!.movements.map((m) => (
                <tr key={m.id} className="border-t align-top"><td className="whitespace-nowrap px-3 py-2">{formatDateTime(m.performed_at)}</td><td className="px-3 py-2">{labelize(m.movement_type)}</td>
                  <td className="px-3 py-2">{m.from_status && <><StatusBadge status={m.from_status} kind="device" /> → </>}<StatusBadge status={m.to_status} kind="device" /></td>
                  <td className="px-3 py-2 text-xs">{[m.from_warehouse_code, m.from_location_code].filter(Boolean).join('/') || '—'} → {[m.to_warehouse_code, m.to_location_code].filter(Boolean).join('/') || m.institution_name || '—'}</td>
                  <td className="mono px-3 py-2 text-xs">{m.wo_number ?? m.dispatch_number ?? m.reference ?? ''}</td><td className="px-3 py-2 text-xs">{m.reason ?? ''}</td><td className="px-3 py-2 text-xs">{m.performed_by_name ?? 'System'}</td></tr>))}</tbody></table>
              : <EmptyState title="No movements recorded" />}
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="repairs" className="grid gap-4 lg:grid-cols-2">
          <Card><CardHeader><CardTitle>Assessments</CardTitle></CardHeader><CardContent className="p-0">{q.data!.assessments.length ? <ul className="divide-y text-sm">{q.data!.assessments.map((a) => (
            <li key={a.id} className="px-4 py-2"><div className="flex justify-between"><Link className="mono text-primary hover:underline" to={`/assessments/${a.id}`}>{a.assessment_number}</Link><StatusBadge status={a.outcome ?? a.status} /></div>
              <p className="text-xs text-muted-foreground">{a.reported_fault} · {formatDateTime(a.reported_at)}</p></li>))}</ul> : <EmptyState title="No assessments" />}</CardContent></Card>
          <Card><CardHeader><CardTitle>Repairs</CardTitle></CardHeader><CardContent className="p-0">{q.data!.repairs.length ? <ul className="divide-y text-sm">{q.data!.repairs.map((r) => (
            <li key={r.id} className="px-4 py-2"><div className="flex justify-between"><Link className="mono text-primary hover:underline" to={`/repairs/${r.id}`}>{r.repair_number}</Link><StatusBadge status={r.status} /></div>
              <p className="text-xs text-muted-foreground">{formatMoney(Number(r.total_cost_cents))} · QC {r.qc_result ?? 'pending'} · {formatDateTime(r.created_at)}</p></li>))}</ul> : <EmptyState title="No repairs" />}</CardContent></Card>
        </TabsContent>
        <TabsContent value="attachments"><AttachmentsPanel entityType="device" entityId={d.id} /></TabsContent>
      </Tabs>

      <ConfirmDialog open={dialog === 'fault'} onOpenChange={(o) => !o && setDialog(null)} title="Report fault" reasonLabel="Describe the fault"
        description="The device becomes faulty, any reservation is released and an assessment is created for a technician."
        onConfirm={(r) => act(() => rpc('report_device_fault', { p_device_id: d.id, p_fault: r, p_work_order_id: null, p_origin: null }), 'Fault reported')} />
      <ConfirmDialog open={dialog === 'identity'} onOpenChange={(o) => !o && setDialog(null)} title="Correct registered serial number" reasonLabel="Why is the identity being corrected?" minReason={10}
        description="Use only when the registered serial was captured incorrectly. The old and new values are recorded permanently. To swap a device, use a replacement on the work order instead."
        onConfirm={(r) => { const s = (document.getElementById('new-serial') as HTMLInputElement)?.value; return act(() => rpc('correct_device_identity', { p_device_id: d.id, p_new_serial: s, p_reason: r }), 'Identity corrected'); }}>
        <Field label="Correct serial number" htmlFor="new-serial" required><Input id="new-serial" className="mono" defaultValue={d.serial_number ?? ''} /></Field>
      </ConfirmDialog>
      {dialog === 'adjust' && <AdjustDialog device={d} onClose={() => setDialog(null)} onDone={refresh} />}
      {(dialog === 'location' || dialog === 'release') && <LocationDialog device={d} release={dialog === 'release'} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'edit' && <EditDialog device={d} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function AdjustDialog({ device, onClose, onDone }: { device: DeviceRow & Record<string, string>; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState('mark_lost');
  const [condition, setCondition] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Request stock adjustment" description="Adjustments need a reason and approval by another authorised user before stock changes." />
        <div className="space-y-3">
          <Field label="Adjustment" htmlFor="adj-t" required><Select id="adj-t" value={type} onChange={(e) => setType(e.target.value)}
            options={['mark_lost', 'mark_stolen', 'write_off', 'found', 'condition_change', 'quarantine'].map((t) => ({ value: t, label: labelize(t) }))} /></Field>
          {type === 'condition_change' && <Field label="New condition" htmlFor="adj-c" required><Select id="adj-c" placeholder="Select…" value={condition} onChange={(e) => setCondition(e.target.value)}
            options={DEVICE_CONDITIONS.map((c) => ({ value: c, label: labelize(c) }))} /></Field>}
          <Field label="Reason" htmlFor="adj-r" required><Textarea id="adj-r" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={reason.trim().length < 5 || (type === 'condition_change' && !condition)} onClick={async () => {
            setBusy(true);
            try { await rpc('request_stock_adjustment', { p_device_id: device.id, p_type: type, p_reason: reason, p_new_condition: condition || null, p_location_id: null }); toast.success('Adjustment requested'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Submit request</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LocationDialog({ device, release, onClose, onDone }: { device: DeviceRow & Record<string, string>; release: boolean; onClose: () => void; onDone: () => void }) {
  const locations = useLocations(device.warehouse_id).data;
  const [loc, setLoc] = useState('');
  const [condition, setCondition] = useState('good');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={release ? 'Release to available stock' : 'Move to another location'}
          description={release ? 'Confirms the device passed inspection. Open repairs, failed quality checks or uninspected returns block release.' : undefined} />
        <div className="space-y-3">
          <Field label="Location" htmlFor="loc" required><Select id="loc" placeholder="Select…" value={loc} onChange={(e) => setLoc(e.target.value)}
            options={opts(locations?.filter((l) => !release || l.location_type === 'storage'), (l) => `${l.code} (${l.location_type})`)} /></Field>
          {release && <Field label="Verified condition" htmlFor="rc" required><Select id="rc" value={condition} onChange={(e) => setCondition(e.target.value)} options={['new', 'good', 'fair'].map((c) => ({ value: c, label: labelize(c) }))} /></Field>}
          <Field label="Notes" htmlFor="ln"><Input id="ln" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!loc} onClick={async () => {
            setBusy(true);
            try {
              if (release) await rpc('release_device_to_stock', { p_device_id: device.id, p_location_id: loc, p_condition: condition, p_notes: notes || null });
              else await rpc('move_device_location', { p_device_id: device.id, p_location_id: loc, p_reason: notes || null });
              toast.success(release ? 'Released to available stock' : 'Location updated'); onDone(); onClose();
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>{release ? 'Release' : 'Move'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ device, onClose, onDone }: { device: DeviceRow & Record<string, string>; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ notes: device.notes ?? '', warranty_expires_on: device.warranty_expires_on ?? '', warranty_notes: device.warranty_notes ?? '',
    acquisition_reference: device.acquisition_reference ?? '', purchase_date: device.purchase_date ?? '' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Edit device details" description="Identity (serial number) and status cannot be changed here." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Acquisition reference" htmlFor="e-ref"><Input id="e-ref" value={v.acquisition_reference} onChange={(e) => setV({ ...v, acquisition_reference: e.target.value })} /></Field>
          <Field label="Purchase date" htmlFor="e-pd"><Input id="e-pd" type="date" value={v.purchase_date} onChange={(e) => setV({ ...v, purchase_date: e.target.value })} /></Field>
          <Field label="Warranty expires" htmlFor="e-w"><Input id="e-w" type="date" value={v.warranty_expires_on} onChange={(e) => setV({ ...v, warranty_expires_on: e.target.value })} /></Field>
          <Field label="Warranty notes" htmlFor="e-wn"><Input id="e-wn" value={v.warranty_notes} onChange={(e) => setV({ ...v, warranty_notes: e.target.value })} /></Field>
          <Field label="Notes" htmlFor="e-n" className="sm:col-span-2"><Textarea id="e-n" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={async () => {
            setBusy(true);
            try { await rpc('update_device_details', { p_device_id: device.id, p: v }); toast.success('Saved'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
