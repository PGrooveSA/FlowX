import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { toast } from 'sonner';
import { rpc, type Filter } from '@/lib/api';
import { formatDateTime, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Select, Checkbox } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { ConfirmDialog, PageHeader } from '@/components/common';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();

export function DiscrepanciesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const [context, setContext] = useState('');
  const [resolve, setResolve] = useState<Row | null>(null);
  const [dismiss, setDismiss] = useState(false);
  const filters = useMemo<Filter[]>(() => [{ column: 'status', op: 'eq', value: status }, { column: 'context', op: 'eq', value: context }], [status, context]);
  return (
    <div>
      <PageHeader title="Serial Discrepancies" crumbs={[{ label: 'Discrepancies' }]}
        description="Every blocked scan, mismatch and missing device is recorded here. Affected devices stay blocked until an authorised user (not the reporter) resolves the record." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={['open', 'resolved', 'dismissed'].map((s) => ({ value: s, label: labelize(s) }))} />
        <Select aria-label="Context" className="w-44" value={context} onChange={(e) => setContext(e.target.value)} placeholder="All contexts" options={['issuing', 'reservation', 'dispatch', 'delivery', 'stock_count', 'receiving', 'return'].map((s) => ({ value: s, label: labelize(s) }))} />
      </div>
      <ServerDataTable<Row> source="v_discrepancies" queryKey={['discrepancies']} filters={filters} defaultSort={{ column: 'created_at', desc: true }} exportName="discrepancies" emptyTitle="No discrepancies"
        columns={[
          c.accessor('discrepancy_number', { header: 'Number', cell: (x) => <span className="mono">{x.getValue()}</span> }),
          c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }),
          c.accessor('context', { header: 'Context', cell: (x) => labelize(x.getValue()) }), c.accessor('reason_code', { header: 'Reason', cell: (x) => <StatusBadge status={x.getValue()} /> }),
          c.accessor('expected_serial', { header: 'Expected', cell: (x) => <span className="mono">{x.getValue() ?? '—'}</span> }),
          c.accessor('scanned_serial', { header: 'Scanned', cell: (x) => <span className="mono font-semibold text-red-700">{x.getValue() ?? '—'}</span> }),
          c.accessor('wo_number', { header: 'Work order', cell: (x) => x.getValue() ? <Link className="mono text-primary hover:underline" to={`/work-orders/${x.row.original.work_order_id}`}>{x.getValue()}</Link> : '—' }),
          c.accessor('dispatch_number', { header: 'Dispatch', cell: (x) => x.getValue() ?? '—' }),
          c.accessor('message', { header: 'Details' }), c.accessor('reported_by_name', { header: 'Reported by', cell: (x) => x.getValue() ?? '—' }),
          c.accessor('created_at', { header: 'When', cell: (x) => formatDateTime(x.getValue()) }),
          c.accessor('resolution', { header: 'Resolution', cell: (x) => x.getValue() ? <span className="text-xs">{x.getValue()} — {x.row.original.resolved_by_name}</span> : '' }),
          c.display({ id: 'act', header: '', cell: (x) => x.row.original.status === 'open' && can('devices.resolve_discrepancy') ? <Button size="sm" variant="outline" onClick={() => setResolve(x.row.original)}>Resolve</Button> : null }),
        ]}
        exportColumns={['discrepancy_number', 'status', 'context', 'reason_code', 'expected_serial', 'scanned_serial', 'wo_number', 'dispatch_number', 'message', 'reported_by_name', 'created_at', 'resolution', 'resolved_by_name', 'resolved_at'].map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
      <ConfirmDialog open={!!resolve} onOpenChange={(o) => { if (!o) { setResolve(null); setDismiss(false); } }} title={`Resolve ${resolve?.discrepancy_number}`} reasonLabel="Resolution (what was found and done)" minReason={10}
        description={resolve?.message}
        onConfirm={async (r) => {
          try { await rpc('resolve_discrepancy', { p_id: resolve!.id, p_resolution: r, p_dismiss: dismiss }); toast.success('Discrepancy resolved; affected device unblocked'); void qc.invalidateQueries({ queryKey: ['discrepancies'] }); }
          catch (e) { toast.error((e as Error).message); throw e; }
        }}>
        <label className="mb-3 flex items-center gap-2 text-sm"><Checkbox checked={dismiss} onChange={(e) => setDismiss(e.target.checked)} /> Dismiss as raised in error</label>
      </ConfirmDialog>
    </div>
  );
}
