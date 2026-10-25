import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Edit, PackageCheck, Printer, Receipt, Send, Truck, XCircle, FileDiff, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney, labelize, todayLocal } from '@/lib/utils';
import { PRIORITIES } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useUsers, useWarehouses } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea, Checkbox } from '@/components/ui/form-controls';
import { ConfirmDialog, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';
import type { WorkOrderRow } from './WorkOrdersPage';

interface Line { id: string; line_no: number; requested_qty: number; approved_qty: number | null; unit_price_cents: number | null; notes: string | null;
  device_categories: { name: string }; device_models: { manufacturer: string; model_name: string } | null }
interface Allocation { id: string; status: string; line_id: string; reserved_at: string; picked_at: string; issued_at: string; dispatched_at: string; delivered_at: string;
  release_reason: string | null; devices: { id: string; serial_number: string; asset_tag: string; status: string; condition: string; device_models: { model_name: string } } }

export function useWorkOrder(id: string | undefined) {
  return useQuery({
    queryKey: ['work-order', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const [wo, lines, allocations] = await Promise.all([
        fetchOne<WorkOrderRow & Record<string, string>>('v_work_orders', 'id', id),
        fetchAll<Line>('work_order_lines', '*, device_categories(name), device_models(manufacturer, model_name)', (q) => q.eq('work_order_id', id).order('line_no')),
        fetchAll<Allocation>('work_order_devices', 'id, status, line_id, reserved_at, picked_at, issued_at, dispatched_at, delivered_at, release_reason, devices(id, serial_number, asset_tag, status, condition, device_models(model_name))',
          (q) => q.eq('work_order_id', id).order('created_at')),
      ]);
      return { wo, lines, allocations };
    },
  });
}

const ACTIVE_ALLOC = ['reserved', 'picked', 'issued', 'dispatched', 'delivered'];

export function WorkOrderDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can, profile } = useAuth();
  const q = useWorkOrder(id);
  const [dialog, setDialog] = useState<null | 'approve' | 'return' | 'schedule' | 'cancel' | 'amend' | 'exempt' | 'complete' | 'release'>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['work-order', id] });
    void qc.invalidateQueries({ queryKey: ['work-orders'] });
    void qc.invalidateQueries({ queryKey: ['wo-tab'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast.success(msg); refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : 'Action failed'); throw e; } finally { setBusy(false); }
  };

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data?.wo) return <ErrorState error={new Error('Work order not found or not in your scope')} />;
  const { wo, lines, allocations } = q.data;
  const s = wo.status;
  const isCreator = wo.created_by === profile?.id;
  const canEdit = ['draft', 'returned_for_correction'].includes(s) && can('work_orders.create') && (isCreator || can('work_orders.edit_any'));
  const issuingOpen = ['scheduled_pending_issuing', 'issuing_in_progress', 'ready_for_dispatch', 'partially_dispatched', 'partially_delivered'].includes(s);
  const invoiceable = wo.invoice_required && ['issued', 'pending_invoicing', 'invoiced', 'ready_for_dispatch', 'partially_dispatched', 'dispatched', 'partially_delivered', 'delivered'].includes(s);

  return (
    <div className="space-y-4">
      <PageHeader title={wo.wo_number} crumbs={[{ label: 'Work Orders', to: '/work-orders' }, { label: wo.wo_number }]}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={s} kind="wo" /> {wo.institution_name} · EMIS {wo.emis_number}
          {wo.has_pending_amendment && <Badge tone="amber">Amendment pending</Badge>}
          {Number(wo.open_discrepancies) > 0 && <Badge tone="red">{wo.open_discrepancies} open discrepancy</Badge>}
          {!wo.invoice_required && <Badge tone="gray">Invoice-exempt</Badge>}</span>}
        actions={<>
          <Button variant="outline" size="sm" asChild><Link to={`/print/work-order/${wo.id}`} target="_blank"><Printer /> Print</Link></Button>
          {canEdit && <Button variant="outline" size="sm" asChild><Link to={`/work-orders/${wo.id}/edit`}><Edit /> Edit</Link></Button>}
          {canEdit && <Button size="sm" loading={busy} onClick={() => void run(() => rpc('submit_work_order', { p_id: wo.id }), 'Submitted for authorisation').catch(() => {})}><Send /> Submit</Button>}
          {s === 'pending_authorisation' && can('work_orders.approve') && <>
            <Button size="sm" onClick={() => setDialog('approve')}><CheckCircle2 /> Approve</Button>
            <Button size="sm" variant="outline" onClick={() => setDialog('return')}><XCircle /> Return</Button>
          </>}
          {['pending_scheduling', 'scheduled', 'scheduled_pending_issuing'].includes(s) && can('work_orders.schedule') &&
            <Button size="sm" variant={s === 'pending_scheduling' ? 'default' : 'outline'} onClick={() => setDialog('schedule')}><CalendarDays /> {s === 'pending_scheduling' ? 'Schedule' : 'Reschedule'}</Button>}
          {s === 'scheduled' && (can('work_orders.schedule') || can('issuing.pick')) && <Button size="sm" onClick={() => setDialog('release')}><PackageCheck /> Release for issuing</Button>}
          {issuingOpen && can('issuing.pick') && <Button size="sm" asChild><Link to={`/issuing/${wo.id}`}><PackageCheck /> Issuing workspace</Link></Button>}
          {invoiceable && can('invoices.create') && wo.invoice_status !== 'invoiced' && (
            <Button size="sm" loading={busy} onClick={() => void run(async () => { const inv = await rpc<string>('create_invoice_draft', { p_work_order_id: wo.id, p_auto_fill: true }); nav(`/invoicing/${inv}`); }, 'Draft invoice created').catch(() => {})}><Receipt /> Create invoice</Button>
          )}
          {((wo.invoice_required && s === 'invoiced') || (!wo.invoice_required && s === 'issued')) && can('dispatch.create') &&
            <Button size="sm" loading={busy} onClick={() => void run(() => rpc('mark_ready_for_dispatch', { p_work_order_id: wo.id }), 'Released for dispatch').catch(() => {})}><Truck /> Mark ready for dispatch</Button>}
          {['ready_for_dispatch', 'partially_dispatched', 'partially_delivered'].includes(s) && can('dispatch.create') && (
            <Button size="sm" loading={busy} onClick={() => void run(async () => { const d = await rpc<string>('create_dispatch', { p_work_order_id: wo.id, p: {} }); nav(`/dispatch/${d}`); }, 'Dispatch created').catch(() => {})}><Truck /> Create dispatch</Button>
          )}
          {s === 'delivered' && can('work_orders.complete') && <Button size="sm" onClick={() => setDialog('complete')}><CheckCircle2 /> Complete</Button>}
          {['approved', 'pending_scheduling', 'scheduled', 'scheduled_pending_issuing', 'issuing_in_progress', 'issued'].includes(s) && can('work_orders.amend') && !wo.has_pending_amendment &&
            <Button size="sm" variant="outline" onClick={() => setDialog('amend')}><FileDiff /> Request amendment</Button>}
          {can('invoices.exempt') && !['invoiced', 'ready_for_dispatch', 'partially_dispatched', 'dispatched', 'partially_delivered', 'delivered', 'completed', 'cancelled'].includes(s) &&
            <Button size="sm" variant="outline" onClick={() => setDialog('exempt')}>{wo.invoice_required ? 'Exempt from invoicing' : 'Require invoicing'}</Button>}
          {!['completed', 'cancelled', 'dispatched', 'partially_dispatched', 'partially_delivered', 'delivered'].includes(s) && (can('work_orders.cancel') || (s === 'draft' && isCreator)) &&
            <Button size="sm" variant="destructive" onClick={() => setDialog('cancel')}><Ban /> Cancel</Button>}
        </>} />

      {wo.rejection_reason && s === 'returned_for_correction' && (
        <div role="alert" className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900"><strong>Returned for correction:</strong> {wo.rejection_reason}</div>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          {['overview', 'devices', 'approvals', 'scheduling', 'invoice', 'dispatch', 'delivery', 'attachments', 'history'].map((t) =>
            <TabsTrigger key={t} value={t}>{labelize(t)}</TabsTrigger>)}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle>Details</CardTitle></CardHeader>
              <CardContent>
                <KeyValue columns={3} items={[
                  ['Work order type', wo.work_order_type_name], ['Priority', labelize(wo.priority)], ['Created', `${formatDateTime(wo.created_at)} by ${wo.created_by_name}`],
                  ['Province', wo.province_name], ['District', wo.district_name], ['Institution', <Link to={`/institutions/${wo.institution_id}`} className="text-primary hover:underline">{wo.institution_name}</Link>],
                  ['EMIS number', wo.emis_number], ['Institution phone', wo.institution_phone], ['Town', wo.institution_town],
                  ['Recipient type', labelize(wo.recipient_type)], ['Recipient', wo.recipient_name ?? wo.recipient_group ?? '—'], ['Grade / class', [wo.grade, wo.class_name].filter(Boolean).join(' / ') || '—'],
                  ['Warehouse', wo.warehouse_code ? `${wo.warehouse_code} — ${wo.warehouse_name}` : 'Not yet assigned'], ['Scheduled date', formatDate(wo.scheduled_date)], ['Assigned to', wo.assigned_to_name ?? wo.assigned_team ?? '—'],
                  ['Invoice', wo.invoice_required ? (wo.invoice_numbers ?? labelize(wo.invoice_status)) : `Exempt — ${wo.invoice_exempt_reason}`], ['Dispatch', wo.dispatch_numbers ?? '—'], ['Delivery status', <StatusBadge status={wo.delivery_status} />],
                  ['Source reference', wo.source_reference], ['Imported', formatDateTime(wo.imported_at)], ['Approved', wo.approved_at ? formatDateTime(wo.approved_at) : '—'],
                ]} />
                {(wo.description || wo.instructions) && <div className="mt-4 grid gap-4 sm:grid-cols-2 text-sm">
                  <div><p className="text-xs text-muted-foreground">Description</p><p className="whitespace-pre-wrap">{wo.description ?? '—'}</p></div>
                  <div><p className="text-xs text-muted-foreground">Instructions</p><p className="whitespace-pre-wrap">{wo.instructions ?? '—'}</p></div>
                </div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Fulfilment</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {([['Requested', wo.total_requested], ['Approved', wo.total_approved], ['Allocated', wo.total_allocated], ['Issued', wo.total_issued], ['Dispatched', wo.total_dispatched], ['Delivered', wo.total_delivered]] as [string, number][]).map(([k, v]) => (
                  <div key={k}>
                    <div className="flex justify-between"><span>{k}</span><span className="tabular-nums font-medium">{v}</span></div>
                    <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary" style={{ width: `${Math.min(100, (v / Math.max(1, wo.total_approved || wo.total_requested)) * 100)}%` }} /></div>
                  </div>
                ))}
                <InternalNotes woId={wo.id} notes={wo.internal_notes} onSaved={refresh} />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Device lines</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
                  <th className="px-3 py-2">#</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Model</th><th className="px-3 py-2 text-right">Requested</th>
                  <th className="px-3 py-2 text-right">Approved</th><th className="px-3 py-2 text-right">Allocated</th><th className="px-3 py-2 text-right">Unit price</th><th className="px-3 py-2">Notes</th></tr></thead>
                <tbody>{lines.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="px-3 py-2">{l.line_no}</td><td className="px-3 py-2">{l.device_categories.name}</td>
                    <td className="px-3 py-2">{l.device_models ? `${l.device_models.manufacturer} ${l.device_models.model_name}` : 'Any'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.requested_qty}</td><td className="px-3 py-2 text-right tabular-nums">{l.approved_qty ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{allocations.filter((a) => a.line_id === l.id && ACTIVE_ALLOC.includes(a.status)).length}</td>
                    <td className="px-3 py-2 text-right">{formatMoney(l.unit_price_cents)}</td><td className="px-3 py-2">{l.notes ?? ''}</td>
                  </tr>))}</tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="devices">
          <Card>
            <CardHeader><CardTitle>Allocated physical devices</CardTitle>
              {issuingOpen && can('issuing.pick') && <Button size="sm" asChild><Link to={`/issuing/${wo.id}`}>Open issuing workspace</Link></Button>}</CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {allocations.length ? (
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
                    <th className="px-3 py-2">Serial</th><th className="px-3 py-2">Asset tag</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">Allocation</th>
                    <th className="px-3 py-2">Device status</th><th className="px-3 py-2">Issued</th><th className="px-3 py-2">Delivered</th><th className="px-3 py-2">Note</th></tr></thead>
                  <tbody>{allocations.map((a) => (
                    <tr key={a.id} className="border-t">
                      <td className="px-3 py-2"><Link to={`/devices/${a.devices.id}`} className="mono text-primary hover:underline">{a.devices.serial_number}</Link></td>
                      <td className="mono px-3 py-2">{a.devices.asset_tag}</td><td className="px-3 py-2">{a.devices.device_models.model_name}</td>
                      <td className="px-3 py-2"><StatusBadge status={a.status} /></td><td className="px-3 py-2"><StatusBadge status={a.devices.status} kind="device" /></td>
                      <td className="px-3 py-2">{formatDateTime(a.issued_at)}</td><td className="px-3 py-2">{formatDateTime(a.delivered_at)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{a.release_reason}</td>
                    </tr>))}</tbody>
                </table>
              ) : <EmptyState title="No devices allocated yet" description="Devices are reserved when the work order is released for issuing, then verified by serial during picking." />}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approvals"><ApprovalsTab woId={wo.id} /></TabsContent>
        <TabsContent value="scheduling"><SchedulesTab woId={wo.id} /></TabsContent>
        <TabsContent value="invoice"><InvoicesTab woId={wo.id} /></TabsContent>
        <TabsContent value="dispatch"><DispatchTab woId={wo.id} /></TabsContent>
        <TabsContent value="delivery"><DeliveryTab woId={wo.id} /></TabsContent>
        <TabsContent value="attachments"><AttachmentsPanel entityType="work_order" entityId={wo.id} /></TabsContent>
        <TabsContent value="history"><HistoryTab woId={wo.id} /></TabsContent>
      </Tabs>

      {dialog === 'approve' && <ApproveDialog lines={lines} onClose={() => setDialog(null)}
        onApprove={(approved, comment) => run(() => rpc('approve_work_order', { p_id: wo.id, p_lines: approved, p_comment: comment || null }), 'Work order approved')} />}
      <ConfirmDialog open={dialog === 'return'} onOpenChange={(o) => !o && setDialog(null)} title="Return for correction" reasonLabel="Reason for returning"
        description="The creator will be notified and can correct and resubmit." confirmLabel="Return work order"
        onConfirm={(r) => run(() => rpc('reject_work_order', { p_id: wo.id, p_reason: r }), 'Returned for correction')} />
      <ConfirmDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} title={`Cancel ${wo.wo_number}?`} destructive reasonLabel="Cancellation reason"
        description="Reservations and issued devices are released back to stock through recorded reversal movements. Draft invoices are cancelled. Nothing is deleted." confirmLabel="Cancel work order"
        onConfirm={(r) => run(() => rpc('cancel_work_order', { p_id: wo.id, p_reason: r }), 'Work order cancelled')} />
      <ConfirmDialog open={dialog === 'complete'} onOpenChange={(o) => !o && setDialog(null)} title="Complete work order"
        description="All approved devices have been delivered. Completing closes the work order." confirmLabel="Complete"
        onConfirm={() => run(() => rpc('complete_work_order', { p_work_order_id: wo.id, p_notes: null }), 'Work order completed')} />
      <ConfirmDialog open={dialog === 'exempt'} onOpenChange={(o) => !o && setDialog(null)} title={wo.invoice_required ? 'Exempt from invoicing' : 'Require invoicing'} reasonLabel="Reason"
        onConfirm={(r) => run(() => rpc('set_invoice_exemption', { p_work_order_id: wo.id, p_exempt: wo.invoice_required, p_reason: r }), 'Invoicing requirement updated')} />
      {dialog === 'release' && <ReleaseDialog onClose={() => setDialog(null)} onConfirm={(auto) => run(async () => {
        const r = await rpc<{ reservations: { line_no: number; needed: number; reserved: number }[] }>('release_for_issuing', { p_id: wo.id, p_auto_reserve: auto });
        const short = r.reservations.filter((x) => x.reserved < x.needed);
        if (short.length) toast.warning(`Released. Not enough stock to reserve: ${short.map((x) => `line ${x.line_no} (${x.reserved}/${x.needed})`).join(', ')}`);
      }, 'Released for issuing')} />}
      {dialog === 'schedule' && <ScheduleDialog wo={wo} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'amend' && <AmendDialog wo={wo} lines={lines} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function InternalNotes({ woId, notes, onSaved }: { woId: string; notes: string | null; onSaved: () => void }) {
  const { canAny } = useAuth();
  const [value, setValue] = useState(notes ?? '');
  const [saving, setSaving] = useState(false);
  const editable = canAny('work_orders.create', 'work_orders.schedule', 'issuing.pick');
  return (
    <div className="border-t pt-3">
      <Field label="Internal notes" htmlFor="wo-notes">
        <Textarea id="wo-notes" value={value} onChange={(e) => setValue(e.target.value)} disabled={!editable} />
      </Field>
      {editable && value !== (notes ?? '') && (
        <Button size="sm" className="mt-2" loading={saving} onClick={async () => {
          setSaving(true);
          try { await rpc('update_work_order_notes', { p_work_order_id: woId, p_notes: value }); toast.success('Notes saved'); onSaved(); }
          catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
        }}>Save notes</Button>
      )}
    </div>
  );
}

function ApproveDialog({ lines, onClose, onApprove }: { lines: Line[]; onClose: () => void; onApprove: (l: { line_id: string; approved_qty: number }[], c: string) => Promise<unknown> }) {
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(lines.map((l) => [l.id, l.requested_qty])));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const invalid = lines.some((l) => !(qty[l.id] >= 0 && qty[l.id] <= l.requested_qty && Number.isInteger(qty[l.id]))) || lines.every((l) => qty[l.id] === 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title="Approve work order" description="Confirm the approved quantity per line. It cannot exceed the requested quantity. Prices are taken from the model price list." />
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.id} className="grid grid-cols-[1fr_auto_120px] items-center gap-3 text-sm">
              <span>{l.line_no}. {l.device_models ? `${l.device_models.manufacturer} ${l.device_models.model_name}` : `Any ${l.device_categories.name}`}</span>
              <span className="text-muted-foreground">requested {l.requested_qty}</span>
              <Input aria-label={`Approved quantity line ${l.line_no}`} type="number" min={0} max={l.requested_qty} value={qty[l.id]}
                onChange={(e) => setQty((s) => ({ ...s, [l.id]: Number(e.target.value) }))} />
            </div>
          ))}
          <Field label="Comment (optional)" htmlFor="appr-c"><Textarea id="appr-c" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={invalid} loading={busy} onClick={async () => {
            setBusy(true);
            try { await onApprove(lines.map((l) => ({ line_id: l.id, approved_qty: qty[l.id] })), comment); onClose(); } catch { /* toast shown */ } finally { setBusy(false); }
          }}>Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (auto: boolean) => Promise<unknown> }) {
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Release for issuing" description="The work order moves to the warehouse issuing queue." />
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)} className="mt-0.5" />
          <span>Automatically reserve specific available devices (oldest stock first). Operators must then scan exactly these serials when picking.</span></label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(auto); onClose(); } catch { /* shown */ } finally { setBusy(false); } }}>Release</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleDialog({ wo, onClose, onDone }: { wo: WorkOrderRow & Record<string, string>; onClose: () => void; onDone: () => void }) {
  const warehouses = useWarehouses().data;
  const users = useUsers().data;
  const [form, setForm] = useState({ warehouse_id: wo.warehouse_id ?? '', date: wo.scheduled_date ?? todayLocal(1), team: wo.assigned_team ?? '', assigned_to: wo.assigned_to ?? '', priority: wo.priority, reason: '' });
  const [shortages, setShortages] = useState<{ line_no: number; model: string; needed: number; available: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reschedule = wo.status !== 'pending_scheduling';
  const check = useQuery({
    queryKey: ['stock-check', wo.id, form.warehouse_id],
    enabled: Boolean(form.warehouse_id),
    queryFn: () => rpc<{ line_no: number; model_name: string; approved_qty: number; allocated_qty: number; available_qty: number }[]>('work_order_stock_check', { p_work_order_id: wo.id, p_warehouse_id: form.warehouse_id }),
  });
  const submit = async (accept: boolean) => {
    setBusy(true);
    try {
      const r = await rpc<{ ok: boolean; message?: string; shortages?: typeof shortages }>('schedule_work_order', {
        p_id: wo.id, p_warehouse_id: form.warehouse_id, p_scheduled_date: form.date, p_assigned_team: form.team || null,
        p_assigned_to: form.assigned_to || null, p_priority: form.priority, p_reason: form.reason || null, p_accept_shortage: accept });
      if (!r.ok) { setShortages(r.shortages ?? []); toast.warning(r.message ?? 'Stock shortage'); return; }
      toast.success(reschedule ? 'Rescheduled' : 'Scheduled'); onDone(); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title={reschedule ? 'Reschedule work order' : 'Schedule work order'} description="Stock availability is checked against the selected warehouse before the schedule is confirmed." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Warehouse" htmlFor="s-wh" required><Select id="s-wh" placeholder="Select…" value={form.warehouse_id} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}
            options={opts(warehouses?.filter((w) => w.is_active), (w) => `${w.code} — ${w.name}`)} /></Field>
          <Field label="Scheduled date" htmlFor="s-date" required><Input id="s-date" type="date" min={todayLocal()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="Team" htmlFor="s-team"><Input id="s-team" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} /></Field>
          <Field label="Assigned staff member" htmlFor="s-user"><Select id="s-user" placeholder="Unassigned" value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}
            options={opts(users?.filter((u) => u.is_active), (u) => u.full_name)} /></Field>
          <Field label="Priority" htmlFor="s-pri"><Select id="s-pri" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} options={PRIORITIES.map((p) => ({ value: p, label: labelize(p) }))} /></Field>
          <Field label={reschedule ? 'Reason for rescheduling' : 'Notes / shortage reason'} htmlFor="s-reason" required={reschedule}><Input id="s-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        </div>
        {check.data && (
          <div className="mt-4 rounded-md border">
            <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-1.5">Line</th><th className="px-3 py-1.5">Model</th><th className="px-3 py-1.5 text-right">Outstanding</th><th className="px-3 py-1.5 text-right">Available</th></tr></thead>
              <tbody>{check.data.map((l) => {
                const need = l.approved_qty - l.allocated_qty;
                return <tr key={l.line_no} className={need > l.available_qty ? 'bg-red-50 text-red-800' : ''}><td className="px-3 py-1.5">{l.line_no}</td><td className="px-3 py-1.5">{l.model_name}</td>
                  <td className="px-3 py-1.5 text-right">{need}</td><td className="px-3 py-1.5 text-right">{l.available_qty}</td></tr>;
              })}</tbody></table>
          </div>
        )}
        {shortages && <p role="alert" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">Stock is insufficient. You can schedule anyway with a recorded reason; receiving staff will be notified.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {shortages ? <Button variant="destructive" loading={busy} disabled={form.reason.trim().length < 5} onClick={() => void submit(true)}>Schedule despite shortage</Button>
            : <Button loading={busy} disabled={!form.warehouse_id || !form.date || (reschedule && form.reason.trim().length < 5)} onClick={() => void submit(false)}>Confirm schedule</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AmendDialog({ wo, lines, onClose, onDone }: { wo: WorkOrderRow & Record<string, string>; lines: Line[]; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(lines.map((l) => [l.id, l.approved_qty ?? l.requested_qty])));
  const [instructions, setInstructions] = useState(wo.instructions ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title="Request amendment" description="Changes after approval are recorded as an amendment and require approval before they take effect." />
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.id} className="grid grid-cols-[1fr_auto_120px] items-center gap-3 text-sm">
              <span>{l.line_no}. {l.device_models ? l.device_models.model_name : l.device_categories.name}</span>
              <span className="text-muted-foreground">currently {l.approved_qty}</span>
              <Input type="number" min={0} aria-label={`New approved quantity line ${l.line_no}`} value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: Number(e.target.value) })} />
            </div>
          ))}
          <Field label="Delivery instructions" htmlFor="am-i"><Textarea id="am-i" value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field>
          <Field label="Reason for amendment" htmlFor="am-r" required><Textarea id="am-r" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={reason.trim().length < 5} onClick={async () => {
            setBusy(true);
            try {
              await rpc('request_amendment', { p_work_order_id: wo.id, p_reason: reason, p_changes: {
                lines: lines.filter((l) => qty[l.id] !== l.approved_qty).map((l) => ({ line_id: l.id, approved_qty: qty[l.id] })),
                ...(instructions !== (wo.instructions ?? '') ? { instructions } : {}) } });
              toast.success('Amendment submitted for approval'); onDone(); onClose();
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Submit amendment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalsTab({ woId }: { woId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['wo-tab', 'approvals', woId],
    queryFn: async () => ({
      approvals: await fetchAll<{ id: string; action: string; comments: string | null; decided_at: string; profiles: { full_name: string } | null }>('work_order_approvals', '*, profiles:decided_by(full_name)', (x) => x.eq('work_order_id', woId).order('decided_at')),
      amendments: await fetchAll<{ id: string; status: string; reason: string; changes: unknown; requested_at: string; decision_comment: string | null; requester: { full_name: string } | null }>('work_order_amendments', '*, requester:requested_by(full_name)', (x) => x.eq('work_order_id', woId).order('requested_at', { ascending: false })),
    }),
  });
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean } | null>(null);
  if (!q.data) return <LoadingState />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Approval history</CardTitle></CardHeader><CardContent className="p-0">
        {q.data.approvals.length ? <ul className="divide-y text-sm">{q.data.approvals.map((a) => (
          <li key={a.id} className="px-4 py-2"><div className="flex justify-between"><StatusBadge status={a.action} /><span className="text-xs text-muted-foreground">{formatDateTime(a.decided_at)}</span></div>
            <p className="mt-1">{a.profiles?.full_name}{a.comments ? ` — ${a.comments}` : ''}</p></li>))}</ul> : <EmptyState title="Not yet submitted" />}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Amendments</CardTitle></CardHeader><CardContent className="p-0">
        {q.data.amendments.length ? <ul className="divide-y text-sm">{q.data.amendments.map((m) => (
          <li key={m.id} className="space-y-1 px-4 py-2">
            <div className="flex justify-between"><StatusBadge status={m.status} /><span className="text-xs text-muted-foreground">{formatDateTime(m.requested_at)} by {m.requester?.full_name}</span></div>
            <p>{m.reason}</p>
            <pre className="mono overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(m.changes, null, 1)}</pre>
            {m.decision_comment && <p className="text-xs text-muted-foreground">Decision: {m.decision_comment}</p>}
            {m.status === 'pending' && can('work_orders.approve') && <div className="flex gap-2">
              <Button size="sm" onClick={() => setDeciding({ id: m.id, approve: true })}>Approve amendment</Button>
              <Button size="sm" variant="outline" onClick={() => setDeciding({ id: m.id, approve: false })}>Reject</Button></div>}
          </li>))}</ul> : <EmptyState title="No amendments" />}
      </CardContent></Card>
      <ConfirmDialog open={!!deciding} onOpenChange={(o) => !o && setDeciding(null)} title={deciding?.approve ? 'Approve amendment' : 'Reject amendment'}
        reasonLabel={deciding?.approve ? undefined : 'Reason'} confirmLabel={deciding?.approve ? 'Approve' : 'Reject'}
        onConfirm={async (r) => {
          try {
            await rpc('decide_amendment', { p_amendment_id: deciding!.id, p_approve: deciding!.approve, p_comment: r || null });
            toast.success('Amendment decided');
            void qc.invalidateQueries({ queryKey: ['wo-tab'] }); void qc.invalidateQueries({ queryKey: ['work-order', woId] });
          } catch (e) { toast.error((e as Error).message); throw e; }
        }} />
    </div>
  );
}

function SchedulesTab({ woId }: { woId: string }) {
  const q = useQuery({ queryKey: ['wo-tab', 'schedules', woId], queryFn: () => fetchAll<{ id: string; scheduled_date: string; status: string; assigned_team: string | null; reason: string | null; shortage_accepted: boolean; created_at: string; warehouses: { code: string }; assignee: { full_name: string } | null }>(
    'schedules', '*, warehouses(code), assignee:assigned_to(full_name)', (x) => x.eq('work_order_id', woId).order('created_at', { ascending: false })) });
  if (!q.data) return <LoadingState />;
  return <Card><CardContent className="p-0">{q.data.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
    <th className="px-3 py-2">Date</th><th className="px-3 py-2">Warehouse</th><th className="px-3 py-2">Team / staff</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Recorded</th></tr></thead>
    <tbody>{q.data.map((s) => <tr key={s.id} className="border-t"><td className="px-3 py-2">{formatDate(s.scheduled_date)}</td><td className="px-3 py-2">{s.warehouses.code}</td>
      <td className="px-3 py-2">{[s.assigned_team, s.assignee?.full_name].filter(Boolean).join(' · ') || '—'}</td><td className="px-3 py-2"><StatusBadge status={s.status} /> {s.shortage_accepted && <Badge tone="red">shortage accepted</Badge>}</td>
      <td className="px-3 py-2">{s.reason ?? ''}</td><td className="px-3 py-2">{formatDateTime(s.created_at)}</td></tr>)}</tbody></table> : <EmptyState title="Not scheduled yet" />}</CardContent></Card>;
}

function InvoicesTab({ woId }: { woId: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['wo-tab', 'invoices', woId], enabled: can('invoices.view'), queryFn: () => fetchAll<{ id: string; invoice_number: string | null; display_status: string; total_cents: number; balance_cents: number; invoice_date: string; due_date: string; device_quantity: number }>(
    'v_invoices', 'id, invoice_number, display_status, total_cents, balance_cents, invoice_date, due_date, device_quantity', (x) => x.eq('work_order_id', woId).order('created_at')) });
  if (!can('invoices.view')) return <EmptyState title="You do not have access to invoices" />;
  if (!q.data) return <LoadingState />;
  return <Card><CardContent className="p-0">{q.data.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
    <th className="px-3 py-2">Invoice</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Due</th><th className="px-3 py-2 text-right">Devices</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Balance</th></tr></thead>
    <tbody>{q.data.map((i) => <tr key={i.id} className="border-t"><td className="px-3 py-2"><Link className="mono text-primary hover:underline" to={`/invoicing/${i.id}`}>{i.invoice_number ?? 'Draft'}</Link></td>
      <td className="px-3 py-2"><StatusBadge status={i.display_status} /></td><td className="px-3 py-2">{formatDate(i.invoice_date)}</td><td className="px-3 py-2">{formatDate(i.due_date)}</td>
      <td className="px-3 py-2 text-right">{i.device_quantity}</td><td className="px-3 py-2 text-right">{formatMoney(i.total_cents)}</td><td className="px-3 py-2 text-right">{formatMoney(i.balance_cents)}</td></tr>)}</tbody></table>
    : <EmptyState title="No invoices" description="Invoices are created once devices have been issued." />}</CardContent></Card>;
}

function DispatchTab({ woId }: { woId: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['wo-tab', 'dispatches', woId], enabled: can('dispatch.view'), queryFn: () => fetchAll<{ id: string; dispatch_number: string; status: string; courier_name: string; tracking_number: string; dispatched_at: string; device_count: number; delivered_count: number }>(
    'v_dispatches', 'id, dispatch_number, status, courier_name, tracking_number, dispatched_at, device_count, delivered_count', (x) => x.eq('work_order_id', woId).order('created_at')) });
  if (!can('dispatch.view')) return <EmptyState title="You do not have access to dispatches" />;
  if (!q.data) return <LoadingState />;
  return <Card><CardContent className="p-0">{q.data.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
    <th className="px-3 py-2">Dispatch</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Courier</th><th className="px-3 py-2">Tracking</th><th className="px-3 py-2">Dispatched</th><th className="px-3 py-2 text-right">Devices</th><th className="px-3 py-2 text-right">Delivered</th></tr></thead>
    <tbody>{q.data.map((d) => <tr key={d.id} className="border-t"><td className="px-3 py-2"><Link className="mono text-primary hover:underline" to={`/dispatch/${d.id}`}>{d.dispatch_number}</Link></td>
      <td className="px-3 py-2"><StatusBadge status={d.status} /></td><td className="px-3 py-2">{d.courier_name ?? '—'}</td><td className="mono px-3 py-2">{d.tracking_number ?? '—'}</td>
      <td className="px-3 py-2">{formatDateTime(d.dispatched_at)}</td><td className="px-3 py-2 text-right">{d.device_count}</td><td className="px-3 py-2 text-right">{d.delivered_count}</td></tr>)}</tbody></table>
    : <EmptyState title="No dispatches yet" />}</CardContent></Card>;
}

function DeliveryTab({ woId }: { woId: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['wo-tab', 'deliveries', woId], enabled: can('delivery.view'), queryFn: () => fetchAll<{ id: string; delivery_number: string; dispatch_number: string; outcome: string; received_by_name: string; delivered_at: string; quantity_expected: number; quantity_received: number; quantity_outstanding: number }>(
    'v_deliveries', 'id, delivery_number, dispatch_number, outcome, received_by_name, delivered_at, quantity_expected, quantity_received, quantity_outstanding', (x) => x.eq('work_order_id', woId).order('delivered_at')) });
  if (!can('delivery.view')) return <EmptyState title="You do not have access to deliveries" />;
  if (!q.data) return <LoadingState />;
  return <Card><CardContent className="p-0">{q.data.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr>
    <th className="px-3 py-2">Proof of delivery</th><th className="px-3 py-2">Dispatch</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Received by</th><th className="px-3 py-2">When</th><th className="px-3 py-2 text-right">Expected</th><th className="px-3 py-2 text-right">Received</th><th className="px-3 py-2 text-right">Outstanding</th></tr></thead>
    <tbody>{q.data.map((d) => <tr key={d.id} className="border-t"><td className="px-3 py-2"><Link className="mono text-primary hover:underline" to={`/print/delivery/${d.id}`} target="_blank">{d.delivery_number}</Link></td>
      <td className="mono px-3 py-2">{d.dispatch_number}</td><td className="px-3 py-2"><StatusBadge status={d.outcome} /></td><td className="px-3 py-2">{d.received_by_name ?? '—'}</td>
      <td className="px-3 py-2">{formatDateTime(d.delivered_at)}</td><td className="px-3 py-2 text-right">{d.quantity_expected}</td><td className="px-3 py-2 text-right">{d.quantity_received}</td><td className="px-3 py-2 text-right">{d.quantity_outstanding}</td></tr>)}</tbody></table>
    : <EmptyState title="No deliveries recorded" />}</CardContent></Card>;
}

function HistoryTab({ woId }: { woId: string }) {
  const q = useQuery({ queryKey: ['wo-tab', 'history', woId], queryFn: () => fetchAll<{ id: number; from_status: string | null; to_status: string; reason: string | null; changed_at: string; profiles: { full_name: string } | null }>(
    'work_order_status_history', '*, profiles:changed_by(full_name)', (x) => x.eq('work_order_id', woId).order('changed_at')) });
  if (!q.data) return <LoadingState />;
  return (
    <Card><CardContent>
      <ol className="relative space-y-4 border-l pl-5">
        {q.data.map((h) => (
          <li key={h.id}>
            <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {h.from_status && <><StatusBadge status={h.from_status} kind="wo" /><span aria-hidden>→</span></>}
              <StatusBadge status={h.to_status} kind="wo" />
              <span className="text-xs text-muted-foreground">{formatDateTime(h.changed_at)} · {h.profiles?.full_name ?? 'System'}</span>
            </div>
            {h.reason && <p className="mt-1 text-sm text-muted-foreground">{h.reason}</p>}
          </li>
        ))}
      </ol>
    </CardContent></Card>
  );
}
