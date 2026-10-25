import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc } from '@/lib/api';
import { formatDate, formatDateTime, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, LoadingState, PageHeader } from '@/components/common';
import { SignaturePad } from '@/components/common/SignaturePad';
import { AttachmentsPanel } from '@/components/common/Attachments';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();

export function DeliveryPage() {
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="Delivery Confirmation" crumbs={[{ label: 'Delivery' }]} description="Record proof of receipt against the actual dispatch manifest, including partial, damaged, missing and failed deliveries." />
      <Tabs defaultValue="transit">
        <TabsList><TabsTrigger value="transit">In transit</TabsTrigger><TabsTrigger value="confirmed">Confirmations</TabsTrigger></TabsList>
        <TabsContent value="transit">
          <ServerDataTable<Row> source="v_dispatches" queryKey={['dispatches', 'transit']} filters={[{ column: 'status', op: 'eq', value: 'dispatched' }]} defaultSort={{ column: 'dispatched_at', desc: false }}
            onRowClick={(r) => nav(`/delivery/${r.id}`)} emptyTitle="No shipments awaiting confirmation"
            columns={[c.accessor('dispatch_number', { header: 'Dispatch', cell: (x) => <Link className="mono text-primary hover:underline" to={`/delivery/${x.row.original.id}`}>{x.getValue()}</Link> }),
              c.accessor('wo_number', { header: 'Work order', cell: (x) => <span className="mono">{x.getValue()}</span> }), c.accessor('institution_name', { header: 'Destination' }),
              c.accessor('courier_name', { header: 'Courier' }), c.accessor('tracking_number', { header: 'Tracking', cell: (x) => <span className="mono">{x.getValue() ?? '—'}</span> }),
              c.accessor('device_count', { header: 'Devices', enableSorting: false }), c.accessor('dispatched_at', { header: 'Dispatched', cell: (x) => formatDateTime(x.getValue()) }),
              c.accessor('expected_delivery_date', { header: 'Expected', cell: (x) => { const late = x.getValue() && x.getValue() < new Date().toISOString().slice(0, 10); return <span className={late ? 'font-medium text-red-700' : ''}>{formatDate(x.getValue())}{late ? ' (late)' : ''}</span>; } })]} />
        </TabsContent>
        <TabsContent value="confirmed">
          <ServerDataTable<Row> source="v_deliveries" queryKey={['deliveries']} defaultSort={{ column: 'recorded_at', desc: true }} exportName="delivery-confirmations"
            columns={[c.accessor('delivery_number', { header: 'POD', cell: (x) => <Link className="mono text-primary hover:underline" to={`/print/delivery/${x.row.original.id}`} target="_blank">{x.getValue()}</Link> }),
              c.accessor('outcome', { header: 'Outcome', cell: (x) => <StatusBadge status={x.getValue()} /> }), c.accessor('dispatch_number', { header: 'Dispatch', cell: (x) => <span className="mono">{x.getValue()}</span> }),
              c.accessor('wo_number', { header: 'Work order', cell: (x) => <span className="mono">{x.getValue()}</span> }), c.accessor('institution_name', { header: 'Institution' }),
              c.accessor('received_by_name', { header: 'Received by', cell: (x) => x.getValue() ?? '—' }), c.accessor('quantity_expected', { header: 'Expected' }), c.accessor('quantity_received', { header: 'Received' }),
              c.accessor('quantity_outstanding', { header: 'Outstanding' }), c.accessor('delivered_at', { header: 'Delivered', cell: (x) => formatDateTime(x.getValue()) }),
              c.accessor('via_recipient_link', { header: 'Via link', cell: (x) => String(x.getValue()) === 'true' ? 'Yes' : 'No' }), c.accessor('recorded_by_name', { header: 'Recorded by', cell: (x) => x.getValue() ?? 'Recipient' })]}
            exportColumns={['delivery_number', 'outcome', 'dispatch_number', 'wo_number', 'institution_name', 'emis_number', 'received_by_name', 'received_by_role', 'quantity_expected', 'quantity_received', 'quantity_damaged', 'quantity_missing', 'quantity_rejected', 'delivered_at', 'recorded_by_name', 'comments']
              .map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const RESULTS = ['received', 'damaged', 'missing', 'rejected'];

export function DeliveryRecordPage() {
  const { dispatchId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['delivery-record', dispatchId], queryFn: async () => ({
    d: await fetchOne<Row>('v_dispatches', 'id', dispatchId),
    manifest: await fetchAll<{ id: string; status: string; devices: { serial_number: string; asset_tag: string; device_models: { model_name: string } } }>('dispatch_devices', 'id, status, devices(serial_number, asset_tag, device_models(model_name))', (x) => x.eq('dispatch_id', dispatchId).eq('status', 'dispatched')),
  }) });
  const [failed, setFailed] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});
  const [v, setV] = useState({ received_by_name: '', received_by_role: '', delivered_at: '', comments: '', failure_reason: '' });
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <LoadingState />;
  const d = q.data?.d;
  if (!d) return <ErrorState error={new Error('Dispatch not found')} />;
  if (d.status !== 'dispatched') return <ErrorState error={new Error(`Dispatch ${d.dispatch_number} is ${labelize(d.status)}; delivery can only be recorded for shipments in transit.`)} />;
  if (!can('delivery.confirm')) return <ErrorState error={new Error('You do not have permission to record deliveries')} />;
  const manifest = q.data!.manifest;
  const resultFor = (id: string) => results[id] ?? 'received';
  const received = manifest.filter((m) => resultFor(m.id) === 'received').length;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={`Record delivery — ${d.dispatch_number}`} crumbs={[{ label: 'Delivery', to: '/delivery' }, { label: d.dispatch_number }]}
        description={`${d.institution_name} · ${d.wo_number} · ${manifest.length} device(s) on manifest`} />
      <Card><CardHeader><CardTitle>Outcome</CardTitle></CardHeader><CardContent className="space-y-3">
        <Field label="Delivery result" htmlFor="dfail"><Select id="dfail" value={failed} onChange={(e) => setFailed(e.target.value)}
          options={[{ value: '', label: 'Delivered (record per-device results below)' }, { value: 'failed', label: 'Failed delivery — nothing handed over' }, { value: 'returned_to_sender', label: 'Returned to sender' }]} /></Field>
        {failed ? <Field label="Reason for failure" htmlFor="dfr" required><Textarea id="dfr" value={v.failure_reason} onChange={(e) => setV({ ...v, failure_reason: e.target.value })} /></Field> : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Received by (name)" htmlFor="drn" required><Input id="drn" value={v.received_by_name} onChange={(e) => setV({ ...v, received_by_name: e.target.value })} /></Field>
            <Field label="Role / relationship" htmlFor="drr"><Input id="drr" placeholder="e.g. Principal, ICT teacher" value={v.received_by_role} onChange={(e) => setV({ ...v, received_by_role: e.target.value })} /></Field>
            <Field label="Delivered at" htmlFor="dat" hint="Defaults to now"><Input id="dat" type="datetime-local" value={v.delivered_at} onChange={(e) => setV({ ...v, delivered_at: e.target.value })} /></Field>
          </div>)}
      </CardContent></Card>
      {!failed && (
        <Card><CardHeader><CardTitle>Devices received ({received} of {manifest.length})</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setResults({})}>Mark all received</Button></CardHeader><CardContent className="p-0">
          <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Serial</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">Result</th></tr></thead>
            <tbody>{manifest.map((m) => (
              <tr key={m.id} className="border-t"><td className="mono px-3 py-1.5">{m.devices.serial_number}</td><td className="px-3 py-1.5">{m.devices.device_models.model_name}</td>
                <td className="px-3 py-1.5"><Select aria-label={`Result for ${m.devices.serial_number}`} className="h-8 w-40" value={resultFor(m.id)} onChange={(e) => setResults({ ...results, [m.id]: e.target.value })}
                  options={RESULTS.map((r) => ({ value: r, label: labelize(r) }))} /></td></tr>))}</tbody></table>
        </CardContent></Card>
      )}
      <Card><CardContent className="space-y-3 pt-4">
        <Field label="Comments" htmlFor="dcm"><Textarea id="dcm" value={v.comments} onChange={(e) => setV({ ...v, comments: e.target.value })} /></Field>
        {!failed && <SignaturePad onChange={setSignature} />}
        <p className="text-xs text-muted-foreground">The signature and name are stored as an operational record of receipt. Whether this constitutes legally acceptable proof is defined by your organisation's policy.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => nav(-1)}>Cancel</Button>
          <Button loading={busy} disabled={failed ? v.failure_reason.trim().length < 5 : v.received_by_name.trim().length < 2} onClick={async () => {
            setBusy(true);
            try {
              const r = await rpc<{ delivery_id: string; delivery_number: string; outcome: string; outstanding: number }>('record_delivery', { p_dispatch_id: d.id, p: {
                ...v, outcome: failed || null, delivered_at: v.delivered_at ? new Date(v.delivered_at).toISOString() : null, signature_data: signature,
                devices: manifest.map((m) => ({ dispatch_device_id: m.id, result: resultFor(m.id) })) } });
              toast.success(`${r.delivery_number}: ${labelize(r.outcome)}${r.outstanding ? ` — ${r.outstanding} outstanding` : ''}`);
              void qc.invalidateQueries({ queryKey: ['dispatches'] }); void qc.invalidateQueries({ queryKey: ['deliveries'] });
              nav(`/dispatch/${d.id}`);
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Save delivery confirmation</Button>
        </div>
      </CardContent></Card>
      <AttachmentsPanel entityType="dispatch" entityId={d.id} title="Proof-of-delivery photographs and documents" />
    </div>
  );
}
