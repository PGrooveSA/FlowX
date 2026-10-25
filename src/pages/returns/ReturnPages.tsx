import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc, type ScanResult } from '@/lib/api';
import { formatDateTime, labelize } from '@/lib/utils';
import { DEVICE_CONDITIONS } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useWarehouses } from '@/hooks/useLookups';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, ScanInput, ScanLog, type ScanLogEntry } from '@/components/common';
import { InstitutionPicker, type InstitutionLite } from '@/components/common/InstitutionPicker';
import { AttachmentsPanel } from '@/components/common/Attachments';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();

export function ReturnsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Returns and Reverse Logistics" crumbs={[{ label: 'Returns' }]} description="Returned devices go to quarantine and must be inspected before they can return to available stock."
        actions={can('returns.manage') && <Button onClick={() => setOpen(true)}><Plus /> New return</Button>} />
      <ServerDataTable<Row> source="v_returns" queryKey={['returns']} defaultSort={{ column: 'created_at', desc: true }} onRowClick={(r) => nav(`/returns/${r.id}`)} emptyTitle="No returns"
        columns={[c.accessor('return_number', { header: 'Return', cell: (x) => <Link className="mono text-primary hover:underline" to={`/returns/${x.row.original.id}`}>{x.getValue()}</Link> }),
          c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }), c.accessor('source', { header: 'Source', cell: (x) => labelize(x.getValue()) }),
          c.accessor('institution_name', { header: 'Institution', cell: (x) => x.getValue() ?? '—' }), c.accessor('wo_number', { header: 'Work order', cell: (x) => x.getValue() ?? '—' }),
          c.accessor('dispatch_number', { header: 'Dispatch', cell: (x) => x.getValue() ?? '—' }), c.accessor('return_reason', { header: 'Reason' }), c.accessor('warehouse_code', { header: 'Warehouse' }),
          c.accessor('received_count', { header: 'Received', enableSorting: false }), c.accessor('pending_inspection', { header: 'To inspect', enableSorting: false }),
          c.accessor('created_at', { header: 'Created', cell: (x) => formatDateTime(x.getValue()) })]} />
      {open && <NewReturnDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function NewReturnDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const warehouses = useWarehouses().data;
  const [inst, setInst] = useState<InstitutionLite | null>(null);
  const [v, setV] = useState({ source: 'institution', returned_by_name: '', return_reason: '', receiving_warehouse_id: '', dispatch_number: '', notes: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title="Authorise a return" description="Link the original dispatch where known so returned serials are verified against its manifest." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source" htmlFor="rs" required><Select id="rs" value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })} options={['institution', 'recipient', 'courier', 'repair_provider', 'other'].map((s) => ({ value: s, label: labelize(s) }))} /></Field>
          <Field label="Receiving warehouse" htmlFor="rw" required><Select id="rw" placeholder="Select…" value={v.receiving_warehouse_id} onChange={(e) => setV({ ...v, receiving_warehouse_id: e.target.value })} options={opts(warehouses?.filter((w) => w.is_active), (w) => w.code)} /></Field>
          <Field label="Returning institution" htmlFor="ri" className="sm:col-span-2"><InstitutionPicker id="ri" value={inst} onChange={setInst} /></Field>
          <Field label="Original dispatch number (optional)" htmlFor="rd"><Input id="rd" className="mono" placeholder="DSP-2026-000001" value={v.dispatch_number} onChange={(e) => setV({ ...v, dispatch_number: e.target.value.trim() })} /></Field>
          <Field label="Returned by (name)" htmlFor="rb"><Input id="rb" value={v.returned_by_name} onChange={(e) => setV({ ...v, returned_by_name: e.target.value })} /></Field>
          <Field label="Return reason" htmlFor="rr" required className="sm:col-span-2"><Textarea id="rr" value={v.return_reason} onChange={(e) => setV({ ...v, return_reason: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!v.receiving_warehouse_id || v.return_reason.trim().length < 5} onClick={async () => {
            setBusy(true);
            try {
              let dispatchId: string | null = null;
              if (v.dispatch_number) {
                const d = await fetchOne<{ id: string }>('dispatches', 'dispatch_number', v.dispatch_number, 'id');
                if (!d) throw new Error(`Dispatch ${v.dispatch_number} not found`);
                dispatchId = d.id;
              }
              const id = await rpc<string>('create_return', { p: { ...v, institution_id: inst?.id ?? null, original_dispatch_id: dispatchId } });
              nav(`/returns/${id}`);
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Create return</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReturnDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [condition, setCondition] = useState('good');
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [inspect, setInspect] = useState<Row | null>(null);
  const q = useQuery({ queryKey: ['return', id], queryFn: async () => ({
    ret: await fetchOne<Row>('v_returns', 'id', id),
    lines: await fetchAll<Row & { devices: { id: string; serial_number: string; asset_tag: string; status: string; device_models: { model_name: string } } }>(
      'return_lines', '*, devices(id, serial_number, asset_tag, status, device_models(model_name))', (x) => x.eq('return_id', id).order('received_at')),
  }) });
  if (q.isLoading) return <LoadingState />;
  const rt = q.data?.ret;
  if (!rt) return <ErrorState error={new Error('Return not found')} />;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['return', id] }); void qc.invalidateQueries({ queryKey: ['returns'] }); };
  return (
    <div className="space-y-4">
      <PageHeader title={rt.return_number} crumbs={[{ label: 'Returns', to: '/returns' }, { label: rt.return_number }]}
        description={<span className="flex items-center gap-2"><StatusBadge status={rt.status} /> {rt.institution_name ?? labelize(rt.source)} → {rt.warehouse_code}</span>}
        actions={rt.status === 'inspected' && can('returns.manage') && <Button onClick={async () => { try { await rpc('close_return', { p_return_id: rt.id }); toast.success('Return closed'); refresh(); } catch (e) { toast.error((e as Error).message); } }}>Close return</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader><CardTitle>Return</CardTitle></CardHeader><CardContent>
          <KeyValue columns={1} items={[['Reason', rt.return_reason], ['Source', labelize(rt.source)], ['Returned by', rt.returned_by_name], ['Original work order', rt.wo_number], ['Original dispatch', rt.dispatch_number], ['Created', formatDateTime(rt.created_at)]]} />
        </CardContent></Card>
        {['authorised', 'receiving'].includes(rt.status) && can('returns.manage') && (
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Receive returned devices</CardTitle></CardHeader><CardContent className="space-y-3">
            <Field label="Condition on return" htmlFor="rc"><Select id="rc" value={condition} onChange={(e) => setCondition(e.target.value)} options={DEVICE_CONDITIONS.map((d) => ({ value: d, label: labelize(d) }))} /></Field>
            <ScanInput onScan={async (s) => {
              try { const r = await rpc<ScanResult>('receive_return_device', { p_return_id: rt.id, p_serial: s, p_condition: condition, p_notes: null });
                setLog((l) => [{ at: new Date(), ok: r.ok, message: r.message, serial: s }, ...l]); if (r.ok) refresh(); else toast.error(r.message); }
              catch (e) { toast.error((e as Error).message); }
            }} />
            <ScanLog entries={log} />
          </CardContent></Card>
        )}
      </div>
      <Card><CardHeader><CardTitle>Returned devices</CardTitle></CardHeader><CardContent className="p-0">
        {q.data!.lines.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Serial</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">Condition</th><th className="px-3 py-2">Device status</th><th className="px-3 py-2">Inspection</th><th className="px-3 py-2" /></tr></thead>
          <tbody>{q.data!.lines.map((l) => (
            <tr key={l.id} className="border-t"><td className="px-3 py-2"><Link className="mono text-primary hover:underline" to={`/devices/${l.devices.id}`}>{l.devices.serial_number}</Link></td><td className="px-3 py-2">{l.devices.device_models.model_name}</td>
              <td className="px-3 py-2">{labelize(l.condition_on_return)}</td><td className="px-3 py-2"><StatusBadge status={l.devices.status} kind="device" /></td>
              <td className="px-3 py-2">{l.inspection_outcome ? <><StatusBadge status={l.inspection_outcome} /> <span className="text-xs text-muted-foreground">{l.inspection_notes}</span></> : 'Pending'}</td>
              <td className="px-3 py-2 text-right">{!l.inspection_outcome && can('returns.manage') && <Button size="sm" variant="outline" onClick={() => setInspect(l)}>Inspect</Button>}
                {l.inspection_outcome === 'release_to_stock' && l.devices.status === 'returned_to_warehouse' && can('inventory.release') && <Button size="sm" asChild><Link to={`/devices/${l.devices.id}`}>Release to stock</Link></Button>}</td></tr>))}</tbody></table>
          : <EmptyState title="No devices received yet" />}
      </CardContent></Card>
      <AttachmentsPanel entityType="return" entityId={rt.id} title="Return photographs and documents" />
      {inspect && <InspectDialog line={inspect} onClose={() => setInspect(null)} onDone={refresh} />}
    </div>
  );
}

function InspectDialog({ line, onClose, onDone }: { line: Row; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Inspect returned device" description="Decide how the device is routed. Release to stock still requires the release step by an authorised user." />
        <div className="space-y-3">
          <Field label="Outcome" htmlFor="io" required><Select id="io" placeholder="Select…" value={outcome} onChange={(e) => setOutcome(e.target.value)}
            options={['release_to_stock', 'repair', 'replacement', 'quarantine', 'write_off'].map((o) => ({ value: o, label: labelize(o) }))} /></Field>
          <Field label="Inspection notes" htmlFor="in" required><Textarea id="in" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!outcome || notes.trim().length < 5} onClick={async () => {
            setBusy(true);
            try { await rpc('inspect_return_line', { p_line_id: line.id, p_outcome: outcome, p_notes: notes }); toast.success('Inspection recorded'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Save inspection</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
