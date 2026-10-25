import { useMemo, useState } from 'react';
import { createColumnHelper } from '@tanstack/react-table';
import type { Filter } from '@/lib/api';
import { formatDateTime, labelize } from '@/lib/utils';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Input, Select } from '@/components/ui/form-controls';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { PageHeader, useDebounce } from '@/components/common';

type Row = Record<string, unknown> & { id: number; occurred_at: string; user_email: string | null; user_roles: string | null; action: string; entity_type: string; entity_id: string | null;
  reason: string | null; success: boolean; correlation_id: string | null; old_values: unknown; new_values: unknown; details: unknown };
const c = createColumnHelper<Row>();

export function AuditPage() {
  const [search, setSearch] = useState('');
  const [f, setF] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Row | null>(null);
  const debounced = useDebounce(search);
  const filters = useMemo<Filter[]>(() => [
    { column: 'entity_type', op: 'eq', value: f.entity }, { column: 'success', op: 'eq', value: f.success === '' || f.success === undefined ? '' : f.success === 'true' },
    { column: 'occurred_at', op: 'gte', value: f.from ? `${f.from}T00:00:00+02:00` : '' }, { column: 'occurred_at', op: 'lte', value: f.to ? `${f.to}T23:59:59+02:00` : '' },
  ], [f]);
  return (
    <div>
      <PageHeader title="Audit Trail" crumbs={[{ label: 'Audit Trail' }]} description="Append-only record of sensitive operations, including rejected attempts. Records cannot be modified or deleted." />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input aria-label="Search" placeholder="Action, user, record id, reason…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Record type" value={f.entity ?? ''} onChange={(e) => setF({ ...f, entity: e.target.value })} placeholder="All record types"
          options={['work_order', 'device', 'invoice', 'dispatch', 'delivery', 'serial_discrepancy', 'stock_movement', 'stock_count', 'goods_receipt', 'repair', 'assessment', 'return', 'replacement', 'issuing', 'user', 'roles', 'user_role_assignments', 'system_settings', 'institutions'].map((x) => ({ value: x, label: labelize(x) }))} />
        <Select aria-label="Outcome" value={f.success ?? ''} onChange={(e) => setF({ ...f, success: e.target.value })} placeholder="Success and failure" options={[{ value: 'true', label: 'Successful' }, { value: 'false', label: 'Failed / rejected' }]} />
        <Input type="date" aria-label="From" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input type="date" aria-label="To" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      <ServerDataTable<Row> source="audit_logs" queryKey={['audit']} filters={filters} search={debounced} searchColumns={['action', 'user_email', 'entity_id', 'reason', 'correlation_id']}
        defaultSort={{ column: 'occurred_at', desc: true }} onRowClick={setDetail} exportName="audit-trail" countMode="estimated"
        columns={[
          c.accessor('occurred_at', { header: 'When', cell: (x) => <span className="whitespace-nowrap">{formatDateTime(x.getValue())}</span> }),
          c.accessor('user_email', { header: 'User', cell: (x) => x.getValue() ?? 'System' }), c.accessor('user_roles', { header: 'Roles', cell: (x) => x.getValue() ?? '' }),
          c.accessor('action', { header: 'Action', cell: (x) => labelize(x.getValue()) }), c.accessor('entity_type', { header: 'Record', cell: (x) => labelize(x.getValue()) }),
          c.accessor('entity_id', { header: 'Record id', cell: (x) => <span className="mono text-xs">{(x.getValue() ?? '').slice(0, 13)}</span> }),
          c.accessor('success', { header: 'Outcome', cell: (x) => x.getValue() ? <Badge tone="green">Success</Badge> : <Badge tone="red">Rejected</Badge> }),
          c.accessor('reason', { header: 'Reason / message', cell: (x) => <span className="line-clamp-2 text-xs">{x.getValue() ?? ''}</span> }),
        ]}
        exportColumns={[{ header: 'occurred_at', value: (r) => r.occurred_at }, { header: 'user', value: (r) => r.user_email }, { header: 'roles', value: (r) => r.user_roles },
          { header: 'action', value: (r) => r.action }, { header: 'entity_type', value: (r) => r.entity_type }, { header: 'entity_id', value: (r) => r.entity_id },
          { header: 'success', value: (r) => r.success }, { header: 'reason', value: (r) => r.reason }, { header: 'correlation_id', value: (r) => r.correlation_id },
          { header: 'old_values', value: (r) => JSON.stringify(r.old_values) }, { header: 'new_values', value: (r) => JSON.stringify(r.new_values) }]} />
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent wide><DialogHeader title={`${labelize(detail?.action)} — ${labelize(detail?.entity_type)}`} description={`${formatDateTime(detail?.occurred_at)} · ${detail?.user_email ?? 'System'} · correlation ${detail?.correlation_id ?? '—'}`} />
          {detail?.reason && <p className="mb-2 text-sm">{detail.reason}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            {(['old_values', 'new_values', 'details'] as const).map((k) => detail?.[k] ? (
              <div key={k}><p className="text-xs font-medium text-muted-foreground">{labelize(k)}</p><pre className="mono max-h-80 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(detail[k], null, 2)}</pre></div>) : null)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
