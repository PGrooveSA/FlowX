import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { AlertOctagon, ClipboardCheck, Link2, Printer, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc, type ScanResult } from '@/lib/api';
import { formatDate, formatDateTime, todayLocal } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Field, Input, Textarea } from '@/components/ui/form-controls';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, ScanInput, ScanLog, type ScanLogEntry } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';
import type { WorkOrderRow } from '@/pages/work-orders/WorkOrdersPage';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();
const w = createColumnHelper<WorkOrderRow>();

export function DispatchPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [creating, setCreating] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Dispatch" crumbs={[{ label: 'Dispatch' }]} description="Only issued, eligible and (where required) invoiced devices can be loaded. Every device is verified by serial." />
      <Tabs defaultValue="ready">
        <TabsList><TabsTrigger value="ready">Ready for dispatch</TabsTrigger><TabsTrigger value="awaiting">Awaiting release</TabsTrigger><TabsTrigger value="all">Dispatch register</TabsTrigger></TabsList>
        <TabsContent value="ready">
          <ServerDataTable<WorkOrderRow> source="v_work_orders" queryKey={['work-orders', 'dispatch-ready']} filters={[{ column: 'status', op: 'in', value: ['ready_for_dispatch', 'partially_dispatched', 'partially_delivered'] }]}
            defaultSort={{ column: 'updated_at', desc: false }} emptyTitle="Nothing ready for dispatch"
            columns={[
              w.accessor('wo_number', { header: 'Work order', cell: (x) => <Link className="mono text-primary hover:underline" to={`/work-orders/${x.row.original.id}`}>{x.getValue()}</Link> }),
              w.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} kind="wo" /> }), w.accessor('institution_name', { header: 'Destination' }),
              w.accessor('warehouse_code', { header: 'Origin' }), w.accessor('invoice_status', { header: 'Invoice', cell: (x) => <StatusBadge status={x.getValue()} /> }),
              w.display({ id: 'qty', header: 'Issued / dispatched', cell: (x) => `${x.row.original.total_issued} / ${x.row.original.total_dispatched}` }),
              w.display({ id: 'act', header: '', cell: (x) => can('dispatch.create') && <Button size="sm" loading={creating === x.row.original.id} onClick={async () => {
                setCreating(x.row.original.id);
                try { nav(`/dispatch/${await rpc<string>('create_dispatch', { p_work_order_id: x.row.original.id, p: {} })}`); }
                catch (e) { toast.error((e as Error).message); } finally { setCreating(null); }
              }}><Truck /> Create dispatch</Button> }),
            ]} />
        </TabsContent>
        <TabsContent value="awaiting">
          <ServerDataTable<WorkOrderRow> source="v_work_orders" queryKey={['work-orders', 'dispatch-awaiting']}
            filters={[{ column: 'status', op: 'in', value: ['invoiced', 'issued'] }]} defaultSort={{ column: 'updated_at', desc: false }} emptyTitle="Nothing awaiting release"
            columns={[
              w.accessor('wo_number', { header: 'Work order', cell: (x) => <Link className="mono text-primary hover:underline" to={`/work-orders/${x.row.original.id}`}>{x.getValue()}</Link> }),
              w.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} kind="wo" /> }), w.accessor('institution_name', { header: 'Destination' }),
              w.accessor('invoice_status', { header: 'Invoice', cell: (x) => <StatusBadge status={x.getValue()} /> }),
              w.display({ id: 'act', header: '', cell: (x) => {
                const r = x.row.original; const eligible = (r.invoice_required && r.status === 'invoiced') || (!r.invoice_required && r.status === 'issued');
                return can('dispatch.create') && (eligible ? <Button size="sm" variant="outline" onClick={async () => {
                  try { await rpc('mark_ready_for_dispatch', { p_work_order_id: r.id }); toast.success('Released for dispatch'); } catch (e) { toast.error((e as Error).message); }
                }}>Mark packed / ready</Button> : <span className="text-xs text-muted-foreground">Invoice required first</span>);
              } }),
            ]} />
        </TabsContent>
        <TabsContent value="all">
          <ServerDataTable<Row> source="v_dispatches" queryKey={['dispatches']} defaultSort={{ column: 'created_at', desc: true }} onRowClick={(r) => nav(`/dispatch/${r.id}`)}
            searchColumns={['dispatch_number', 'tracking_number', 'wo_number']} exportName="dispatch-register"
            columns={[
              c.accessor('dispatch_number', { header: 'Dispatch', cell: (x) => <Link className="mono text-primary hover:underline" to={`/dispatch/${x.row.original.id}`}>{x.getValue()}</Link> }),
              c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }), c.accessor('wo_number', { header: 'Work order', cell: (x) => <span className="mono">{x.getValue()}</span> }),
              c.accessor('institution_name', { header: 'Destination' }), c.accessor('warehouse_code', { header: 'Origin' }), c.accessor('courier_name', { header: 'Courier', cell: (x) => x.getValue() ?? 'â€”' }),
              c.accessor('tracking_number', { header: 'Tracking', cell: (x) => <span className="mono">{x.getValue() ?? 'â€”'}</span> }),
              c.accessor('device_count', { header: 'Devices', enableSorting: false }), c.accessor('delivered_count', { header: 'Delivered', enableSorting: false }),
              c.accessor('dispatched_at', { header: 'Dispatched', cell: (x) => formatDateTime(x.getValue()) }),
              c.accessor('expected_delivery_date', { header: 'Expected', cell: (x) => formatDate(x.getValue()) }),
            ]}
            exportColumns={['dispatch_number', 'status', 'wo_number', 'institution_name', 'emis_number', 'warehouse_code', 'courier_name', 'tracking_number', 'vehicle_registration', 'driver_name', 'parcel_count', 'device_count', 'delivered_count', 'dispatched_at', 'expected_delivery_date', 'delivery_outcome']
              .map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function DispatchDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'confirm' | 'cancel'>(null);
  const [link, setLink] = useState<{ url: string; expires: string } | null>(null);
  const q = useQuery({
    queryKey: ['dispatch', id],
    queryFn: async () => {
      const d = await fetchOne<Row>('v_dispatches', 'id', id);
      const [manifest, eligible] = await Promise.all([
        fetchAll<{ id: string; status: string; scanned_serial: string; scanned_at: string; devices: { id: string; serial_number: string; asset_tag: string; device_models: { model_name: string } } }>(
          'dispatch_devices', 'id, status, scanned_serial, scanned_at, devices(id, serial_number, asset_tag, device_models(model_name))', (x) => x.eq('dispatch_id', id).neq('status', 'removed').order('scanned_at')),
        d ? fetchAll<{ id: string; devices: { serial_number: string } }>('work_order_devices', 'id, devices(serial_number)', (x) => x.eq('work_order_id', d.work_order_id).eq('status', 'issued')) : Promise.resolve([]),
      ]);
      return { d, manifest, eligible };
    },
  });
  const [details, setDetails] = useState<Record<string, string>>({});
  useEffect(() => {
    const d = q.data?.d;
    if (d) setDetails({ courier_name: d.courier_name ?? '', tracking_number: d.tracking_number ?? '', vehicle_registration: d.vehicle_registration ?? '', driver_name: d.driver_name ?? '',
      parcel_count: d.parcel_count ?? '', dispatch_date: d.dispatch_date ?? todayLocal(), expected_delivery_date: d.expected_delivery_date ?? '', recipient_name: d.recipient_name ?? '',
      delivery_address: d.delivery_address ?? '', shipment_notes: d.shipment_notes ?? '' });
  }, [q.data?.d]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['dispatch', id] }); void qc.invalidateQueries({ queryKey: ['dispatches'] }); void qc.invalidateQueries({ queryKey: ['work-orders'] }); };

  if (q.isLoading) return <LoadingState />;
  const d = q.data?.d;
  if (!d) return <ErrorState error={new Error('Dispatch not found')} />;
  const draft = d.status === 'draft';
  const loaded = q.data!.manifest.filter((m) => m.status === 'loaded');
  const notLoaded = q.data!.eligible.filter((e) => !q.data!.manifest.some((m) => m.devices.serial_number === e.devices.serial_number && ['loaded', 'dispatched'].includes(m.status)));

  const saveDetails = async () => {
    try { await rpc('update_dispatch_details', { p_dispatch_id: d.id, p: { ...details, parcel_count: details.parcel_count ? Number(details.parcel_count) : null } }); toast.success('Shipment details saved'); refresh(); }
    catch (e) { toast.error((e as Error).message); throw e; }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={d.dispatch_number} crumbs={[{ label: 'Dispatch', to: '/dispatch' }, { label: d.dispatch_number }]}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={d.status} /> <Link className="mono text-primary hover:underline" to={`/work-orders/${d.work_order_id}`}>{d.wo_number}</Link> â†’ {d.institution_name} (EMIS {d.emis_number})</span>}
        actions={<>
          <Button size="sm" variant="outline" asChild><Link to={`/print/dispatch/${d.id}`} target="_blank"><Printer /> Dispatch note</Link></Button>
          {draft && can('dispatch.confirm') && <Button size="sm" disabled={!loaded.length} onClick={() => setConfirm('confirm')}><Truck /> Confirm handover ({loaded.length})</Button>}
          {draft && can('dispatch.create') && <Button size="sm" variant="destructive" onClick={() => setConfirm('cancel')}>Cancel draft</Button>}
          {d.status === 'dispatched' && can('delivery.confirm') && <>
            <Button size="sm" asChild><Link to={`/delivery/${d.id}`}><ClipboardCheck /> Record delivery</Link></Button>
            <Button size="sm" variant="outline" onClick={async () => {
              try { const r = await rpc<{ token: string; expires_at: string }>('create_delivery_token', { p_dispatch_id: d.id });
                setLink({ url: `${import.meta.env.VITE_APP_URL ?? window.location.origin}/confirm-delivery/${r.token}`, expires: r.expires_at }); }
              catch (e) { toast.error((e as Error).message); }
            }}><Link2 /> Recipient confirmation link</Button>
          </>}
          {d.delivery_id && <Button size="sm" variant="outline" asChild><Link to={`/print/delivery/${d.delivery_id}`} target="_blank">Proof of delivery</Link></Button>}
        </>} />

      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <Card><CardHeader><CardTitle>Shipment</CardTitle>{draft && can('dispatch.create') && <Button size="sm" variant="outline" onClick={() => void saveDetails().catch(() => {})}>Save details</Button>}</CardHeader>
          <CardContent>{draft && can('dispatch.create') ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {([['courier_name', 'Courier / transport provider'], ['tracking_number', 'Tracking number'], ['vehicle_registration', 'Vehicle registration'], ['driver_name', 'Driver / responsible person'],
                ['parcel_count', 'Number of parcels'], ['dispatch_date', 'Dispatch date'], ['expected_delivery_date', 'Expected delivery date'], ['recipient_name', 'Recipient']] as [string, string][]).map(([k, label]) => (
                <Field key={k} label={label} htmlFor={`d-${k}`} required={['parcel_count', 'dispatch_date'].includes(k)}>
                  <Input id={`d-${k}`} type={k.includes('date') ? 'date' : k === 'parcel_count' ? 'number' : 'text'} value={details[k] ?? ''} onChange={(e) => setDetails({ ...details, [k]: e.target.value })} /></Field>))}
              <Field label="Delivery address" htmlFor="d-addr" className="sm:col-span-2"><Input id="d-addr" value={details.delivery_address ?? ''} onChange={(e) => setDetails({ ...details, delivery_address: e.target.value })} /></Field>
              <Field label="Package and shipment notes" htmlFor="d-notes" className="sm:col-span-2"><Textarea id="d-notes" value={details.shipment_notes ?? ''} onChange={(e) => setDetails({ ...details, shipment_notes: e.target.value })} /></Field>
            </div>
          ) : <KeyValue columns={3} items={[['Courier', d.courier_name], ['Tracking', d.tracking_number], ['Vehicle', d.vehicle_registration], ['Driver', d.driver_name], ['Parcels', d.parcel_count],
            ['Dispatch date', formatDate(d.dispatch_date)], ['Expected delivery', formatDate(d.expected_delivery_date)], ['Dispatched at', formatDateTime(d.dispatched_at)], ['Dispatched by', d.dispatched_by_name],
            ['Recipient', d.recipient_name], ['Address', d.delivery_address], ['Delivery outcome', d.delivery_outcome ? <StatusBadge status={d.delivery_outcome} /> : 'Awaiting confirmation'], ['Notes', d.shipment_notes]]} />}
          </CardContent></Card>
        {draft && can('dispatch.create') && (
          <Card><CardHeader><CardTitle>Scan devices onto the manifest</CardTitle></CardHeader><CardContent className="space-y-3">
            <ScanInput busy={busy} onScan={async (s) => {
              setBusy(true);
              try { const r = await rpc<ScanResult>('dispatch_scan_device', { p_dispatch_id: d.id, p_serial: s });
                setLog((l) => [{ at: new Date(), ok: r.ok, message: r.message, serial: s }, ...l]); if (r.ok) refresh(); else toast.error(r.message, { duration: 8000 }); }
              catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
            }} />
            {log[0] && !log[0].ok && <div role="alert" className="flex items-start gap-2 rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm text-red-900"><AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" /> <span><strong>Do not load this device.</strong> {log[0].message}</span></div>}
            <ScanLog entries={log} />
            {notLoaded.length > 0 && <div className="rounded-md bg-muted p-2 text-xs"><p className="font-medium">Issued devices not yet on a manifest ({notLoaded.length}):</p><p className="mono">{notLoaded.map((e) => e.devices.serial_number).join(', ')}</p></div>}
          </CardContent></Card>
        )}
      </div>

      <Card><CardHeader><CardTitle>Device manifest ({q.data!.manifest.length})</CardTitle></CardHeader><CardContent className="p-0">
        {q.data!.manifest.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Serial</th><th className="px-3 py-2">Asset tag</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Scanned</th><th /></tr></thead>
          <tbody>{q.data!.manifest.map((m) => (
            <tr key={m.id} className="border-t"><td className="px-3 py-1.5"><Link className="mono text-primary hover:underline" to={`/devices/${m.devices.id}`}>{m.devices.serial_number}</Link></td><td className="mono px-3 py-1.5">{m.devices.asset_tag}</td>
              <td className="px-3 py-1.5">{m.devices.device_models.model_name}</td><td className="px-3 py-1.5"><StatusBadge status={m.status} /></td><td className="px-3 py-1.5">{formatDateTime(m.scanned_at)}</td>
              <td className="px-3 py-1.5 text-right">{draft && m.status === 'loaded' && can('dispatch.create') && <Button size="sm" variant="ghost" onClick={async () => {
                try { await rpc('remove_dispatch_device', { p_dispatch_device_id: m.id, p_reason: 'Removed during packing' }); refresh(); } catch (e) { toast.error((e as Error).message); }
              }}>Remove</Button>}</td></tr>))}</tbody></table>
          : <EmptyState title="Manifest is empty" description="Scan the serial number on each physical device being packed." />}
      </CardContent></Card>
      <AttachmentsPanel entityType="dispatch" entityId={d.id} title="Dispatch documents" />

      <ConfirmDialog open={confirm === 'confirm'} onOpenChange={(o) => !o && setConfirm(null)} title={`Confirm handover of ${loaded.length} device(s)`}
        description="Only the devices on this manifest will be marked dispatched. Courier/vehicle and parcel count must be recorded. Each device is re-verified under lock."
        onConfirm={async () => {
          try { await saveDetails(); const r = await rpc<{ dispatched: number }>('confirm_dispatch', { p_dispatch_id: d.id }); toast.success(`${r.dispatched} device(s) dispatched`); refresh(); }
          catch (e) { toast.error((e as Error).message); throw e; }
        }} />
      <ConfirmDialog open={confirm === 'cancel'} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel draft dispatch" destructive reasonLabel="Reason"
        onConfirm={async (r) => { try { await rpc('cancel_dispatch', { p_dispatch_id: d.id, p_reason: r }); toast.success('Dispatch cancelled'); refresh(); } catch (e) { toast.error((e as Error).message); throw e; } }} />
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent><DialogHeader title="Recipient confirmation link" description={`Single use; expires ${formatDateTime(link?.expires)}. It only shows this shipment's devices and lets the recipient confirm what was received.`} />
          <Input readOnly value={link?.url ?? ''} className="mono text-xs" onFocus={(e) => e.target.select()} aria-label="Confirmation link" />
          <p className="mt-2 text-xs text-muted-foreground">Share it with the receiving person through your normal channel. Email sending is not configured in this installation.</p>
          <DialogFooter><Button onClick={() => { void navigator.clipboard?.writeText(link?.url ?? ''); toast.success('Link copied'); }}>Copy link</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
