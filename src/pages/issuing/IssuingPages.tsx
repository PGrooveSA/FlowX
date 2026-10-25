import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { AlertOctagon, CheckCircle2, RefreshCw, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { rpc, type ScanResult } from '@/lib/api';
import { formatDate, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { ConfirmDialog, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, ScanInput, ScanLog, type ScanLogEntry } from '@/components/common';
import { useWorkOrder } from '@/pages/work-orders/WorkOrderDetailPage';
import type { WorkOrderRow } from '@/pages/work-orders/WorkOrdersPage';

const col = createColumnHelper<WorkOrderRow>();

export function IssuingQueuePage() {
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="Allocations & Issuing" crumbs={[{ label: 'Issuing' }]} description="Work orders released to the warehouse. Every device must be verified by its physical serial number." />
      <ServerDataTable<WorkOrderRow> source="v_work_orders" queryKey={['work-orders', 'issuing']}
        filters={[{ column: 'status', op: 'in', value: ['scheduled', 'scheduled_pending_issuing', 'issuing_in_progress'] }]}
        defaultSort={{ column: 'scheduled_date', desc: false }} onRowClick={(r) => nav(`/issuing/${r.id}`)} emptyTitle="Nothing waiting to be issued"
        columns={[
          col.accessor('wo_number', { header: 'Work order', cell: (c) => <Link className="mono text-primary hover:underline" to={`/issuing/${c.row.original.id}`}>{c.getValue()}</Link> }),
          col.accessor('status', { header: 'Status', cell: (c) => <StatusBadge status={c.getValue()} kind="wo" /> }),
          col.accessor('scheduled_date', { header: 'Scheduled', cell: (c) => formatDate(c.getValue()) }),
          col.accessor('priority', { header: 'Priority', cell: (c) => <Badge tone={c.getValue() === 'urgent' ? 'red' : c.getValue() === 'high' ? 'amber' : 'gray'}>{c.getValue()}</Badge> }),
          col.accessor('warehouse_code', { header: 'Warehouse' }), col.accessor('institution_name', { header: 'Institution' }),
          col.accessor('category_names', { header: 'Devices', enableSorting: false }),
          col.display({ id: 'progress', header: 'Issued / approved', cell: (c) => `${c.row.original.total_issued} / ${c.row.original.total_approved}` }),
          col.accessor('open_discrepancies', { header: 'Discrepancies', enableSorting: false, cell: (c) => Number(c.getValue()) > 0 ? <Badge tone="red">{c.getValue() as number}</Badge> : '—' }),
          col.accessor('assigned_to_name', { header: 'Assigned', cell: (c) => c.getValue() ?? '—' }),
        ]} />
    </div>
  );
}

export function IssuingWorkspacePage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useWorkOrder(id);
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'pick' | 'reserve'>('pick');
  const [confirm, setConfirm] = useState(false);
  const [release, setRelease] = useState<string | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const [lastMismatch, setLastMismatch] = useState<ScanResult | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['work-order', id] }); void qc.invalidateQueries({ queryKey: ['work-orders'] }); };

  if (q.isLoading) return <LoadingState />;
  if (!q.data?.wo) return <ErrorState error={q.error ?? new Error('Work order not found')} />;
  const { wo, lines, allocations } = q.data;
  const open = ['scheduled_pending_issuing', 'issuing_in_progress', 'ready_for_dispatch', 'partially_dispatched', 'partially_delivered'].includes(wo.status);
  const reservable = ['scheduled', 'scheduled_pending_issuing', 'issuing_in_progress'].includes(wo.status);
  const active = allocations.filter((a) => ['reserved', 'picked', 'issued', 'dispatched', 'delivered'].includes(a.status));
  const picked = active.filter((a) => a.status === 'picked');

  const scan = async (serial: string) => {
    setBusy(true);
    try {
      const r = await rpc<ScanResult>(mode === 'pick' ? 'pick_device' : 'reserve_device', { p_work_order_id: wo.id, p_serial: serial });
      setLog((l) => [{ at: new Date(), ok: r.ok, message: r.message, serial }, ...l].slice(0, 50));
      setLastMismatch(r.ok ? null : r);
      if (!r.ok) toast.error(r.message, { duration: 8000 });
      refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={`Issuing — ${wo.wo_number}`} crumbs={[{ label: 'Issuing', to: '/issuing' }, { label: wo.wo_number }]}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={wo.status} kind="wo" /> {wo.institution_name} · EMIS {wo.emis_number} · {wo.warehouse_code}</span>}
        actions={<>
          <Button variant="outline" size="sm" asChild><Link to={`/work-orders/${wo.id}`}>Work order</Link></Button>
          {reservable && can('inventory.reserve') && <Button size="sm" variant="outline" onClick={async () => {
            try { const r = await rpc<{ reservations: { line_no: number; needed: number; reserved: number }[] }>('auto_reserve_devices', { p_work_order_id: wo.id });
              toast.success(`Reserved ${r.reservations.reduce((s, x) => s + x.reserved, 0)} device(s)`); refresh(); } catch (e) { toast.error((e as Error).message); }
          }}><RefreshCw /> Auto-reserve outstanding</Button>}
          {can('issuing.confirm') && <Button size="sm" disabled={!picked.length || Number(wo.open_discrepancies) > 0} onClick={() => setConfirm(true)}><CheckCircle2 /> Confirm issuing ({picked.length})</Button>}
        </>} />

      {Number(wo.open_discrepancies) > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0" />
          <div><strong>{wo.open_discrepancies} open serial discrepancy.</strong> Issuing cannot be confirmed until an authorised user resolves it.
            <Link to="/discrepancies" className="ml-1 underline">View discrepancies</Link></div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card><CardHeader><CardTitle>Lines</CardTitle></CardHeader><CardContent className="p-0">
            <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Device</th><th className="px-3 py-2 text-right">Approved</th>
              <th className="px-3 py-2 text-right">Reserved</th><th className="px-3 py-2 text-right">Picked</th><th className="px-3 py-2 text-right">Issued+</th><th className="px-3 py-2 text-right">Remaining</th></tr></thead>
              <tbody>{lines.map((l) => {
                const la = active.filter((a) => a.line_id === l.id);
                const cnt = (s: string[]) => la.filter((a) => s.includes(a.status)).length;
                const remaining = (l.approved_qty ?? 0) - cnt(['picked', 'issued', 'dispatched', 'delivered']);
                return <tr key={l.id} className="border-t"><td className="px-3 py-2">{l.device_models ? `${l.device_models.manufacturer} ${l.device_models.model_name}` : `Any ${l.device_categories.name}`}</td>
                  <td className="px-3 py-2 text-right">{l.approved_qty}</td><td className="px-3 py-2 text-right">{cnt(['reserved'])}</td><td className="px-3 py-2 text-right">{cnt(['picked'])}</td>
                  <td className="px-3 py-2 text-right">{cnt(['issued', 'dispatched', 'delivered'])}</td>
                  <td className="px-3 py-2 text-right font-semibold">{remaining > 0 ? remaining : <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-600" />}</td></tr>;
              })}</tbody></table>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>Allocated devices</CardTitle></CardHeader><CardContent className="max-h-[480px] overflow-y-auto p-0">
            {active.length ? <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Expected serial</th><th className="px-3 py-2">Asset tag</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">Allocation</th><th className="px-3 py-2">Condition</th><th className="px-3 py-2" /></tr></thead>
              <tbody>{active.map((a) => (
                <tr key={a.id} className="border-t"><td className="mono px-3 py-1.5 font-semibold">{a.devices.serial_number}</td><td className="mono px-3 py-1.5">{a.devices.asset_tag}</td><td className="px-3 py-1.5">{a.devices.device_models.model_name}</td>
                  <td className="px-3 py-1.5"><StatusBadge status={a.status} /></td><td className="px-3 py-1.5">{labelize(a.devices.condition)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    {['reserved', 'picked'].includes(a.status) && (can('issuing.pick') || can('inventory.reserve')) && <Button size="sm" variant="ghost" onClick={() => setRelease(a.id)}>Release</Button>}
                    {['reserved', 'picked', 'issued'].includes(a.status) && can('devices.replace') && <Button size="sm" variant="ghost" onClick={() => setReplace(a.id)}><Repeat /> Replace</Button>}
                  </td></tr>))}</tbody></table>
              : <EmptyState title="No devices allocated yet" description="Scan devices to pick them, or auto-reserve available stock first." />}
          </CardContent></Card>
        </div>

        <div className="space-y-4">
          <Card><CardHeader><CardTitle>Scan devices</CardTitle></CardHeader><CardContent className="space-y-3">
            {!open && !reservable ? <EmptyState title={`Work order is ${labelize(wo.status)}`} description="It is not open for issuing." /> : <>
              <Field label="Mode" htmlFor="scan-mode"><Select id="scan-mode" value={mode} onChange={(e) => setMode(e.target.value as 'pick' | 'reserve')}
                options={[...(open && can('issuing.pick') ? [{ value: 'pick', label: 'Pick for issuing (verify physical serial)' }] : []),
                  ...(reservable && can('inventory.reserve') ? [{ value: 'reserve', label: 'Reserve a specific device' }] : [])]} /></Field>
              <ScanInput onScan={scan} busy={busy} />
              {lastMismatch?.code === 'serial_mismatch' && (
                <div role="alert" className="rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm text-red-900">
                  <p className="flex items-center gap-2 font-semibold"><AlertOctagon className="h-4 w-4" /> SERIAL MISMATCH — DO NOT ISSUE</p>
                  <KeyValue columns={1} items={[['Scanned (physical device)', <span className="mono">{lastMismatch.scanned_serial}</span>], ['Expected by work order', <span className="mono">{lastMismatch.expected_serial}</span>], ['Discrepancy', lastMismatch.discrepancy_number]]} />
                  <p className="mt-2 text-xs">The scanned device is blocked. Set it aside and ask a supervisor to resolve the discrepancy, or use an authorised replacement.</p>
                </div>
              )}
              <ScanLog entries={log} />
            </>}
          </CardContent></Card>
        </div>
      </div>

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Confirm issuing of ${picked.length} device(s)`}
        description="Each picked device is re-verified (status, condition, warehouse) before it is issued to the recipient. Partial issuing leaves the remaining quantity outstanding."
        onConfirm={async () => {
          try { const r = await rpc<{ issued_now: number; outstanding: number }>('confirm_issuing', { p_work_order_id: wo.id });
            toast.success(`${r.issued_now} device(s) issued. ${r.outstanding > 0 ? `${r.outstanding} still outstanding.` : 'Work order fully issued.'}`); refresh(); }
          catch (e) { toast.error((e as Error).message); throw e; }
        }} />
      <ConfirmDialog open={!!release} onOpenChange={(o) => !o && setRelease(null)} title="Release allocation" reasonLabel="Reason" minReason={3}
        description="The device returns to available stock through a recorded movement."
        onConfirm={async (r) => { try { await rpc('release_allocation', { p_allocation_id: release, p_reason: r }); toast.success('Released'); refresh(); } catch (e) { toast.error((e as Error).message); throw e; } }} />
      <ConfirmDialog open={!!replace} onOpenChange={(o) => !o && setReplace(null)} title="Replace allocated device" reasonLabel="Reason for replacement"
        description="Creates a replacement transaction linking the original and replacement device. Both histories are kept; invoice coverage moves to the replacement."
        onConfirm={async (r) => {
          const serial = (document.getElementById('repl-serial') as HTMLInputElement)?.value;
          const status = (document.getElementById('repl-status') as HTMLSelectElement)?.value;
          try { const res = await rpc<{ replacement_number: string }>('replace_allocated_device', { p_allocation_id: replace, p_new_serial: serial, p_reason: r, p_original_new_status: status });
            toast.success(`Replacement ${res.replacement_number} recorded`); refresh(); } catch (e) { toast.error((e as Error).message); throw e; }
        }}>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Field label="Replacement device serial (scan)" htmlFor="repl-serial" required><Input id="repl-serial" className="mono" /></Field>
          <Field label="Original device becomes" htmlFor="repl-status"><Select id="repl-status" defaultValue="faulty" options={['faulty', 'available', 'quarantined', 'lost', 'stolen'].map((s) => ({ value: s, label: labelize(s) }))} /></Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}
