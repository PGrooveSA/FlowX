import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createColumnHelper } from '@tanstack/react-table';
import type { Filter } from '@/lib/api';
import { formatDateTime, labelize } from '@/lib/utils';
import { opts, useWarehouses } from '@/hooks/useLookups';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Input, Select } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { PageHeader, useDebounce } from '@/components/common';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();
const TYPES = ['registered', 'imported', 'goods_received', 'receipt_completed', 'reserved', 'picked', 'issued', 'dispatched', 'delivered', 'returned',
  'transfer_out', 'transfer_in', 'location_change', 'allocation_released', 'allocation_reversal', 'replaced_out', 'replaced_in', 'fault_reported',
  'repair_started', 'repair_completed', 'returned_from_repair', 'released_to_stock', 'damaged_on_arrival', 'identity_correction',
  'adjustment_mark_lost', 'adjustment_mark_stolen', 'adjustment_write_off', 'adjustment_found', 'adjustment_condition_change', 'count_location_correction'];

export function MovementsPage() {
  const [search, setSearch] = useState('');
  const [f, setF] = useState<Record<string, string>>({});
  const debounced = useDebounce(search);
  const warehouses = useWarehouses().data;
  const filters = useMemo<Filter[]>(() => [
    { column: 'movement_type', op: 'eq', value: f.type },
    { column: 'to_warehouse_id', op: 'eq', value: f.warehouse },
    { column: 'performed_at', op: 'gte', value: f.from ? `${f.from}T00:00:00+02:00` : '' },
    { column: 'performed_at', op: 'lte', value: f.to ? `${f.to}T23:59:59+02:00` : '' },
  ], [f]);
  return (
    <div>
      <PageHeader title="Stock Movements" crumbs={[{ label: 'Stock Movements' }]} description="Permanent custody ledger of every device movement and status change. Records cannot be edited or deleted." />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input aria-label="Search" placeholder="Serial, asset tag, reference…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Movement type" value={f.type ?? ''} onChange={(e) => setF({ ...f, type: e.target.value })} placeholder="All movement types" options={TYPES.map((t) => ({ value: t, label: labelize(t) }))} />
        <Select aria-label="Warehouse" value={f.warehouse ?? ''} onChange={(e) => setF({ ...f, warehouse: e.target.value })} placeholder="All warehouses" options={opts(warehouses, (w) => w.code)} />
        <Input type="date" aria-label="From" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input type="date" aria-label="To" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      <ServerDataTable<Row> source="v_device_movements" queryKey={['movements']} filters={filters} search={debounced} searchColumns={['serial_number', 'asset_tag', 'reference', 'wo_number', 'dispatch_number']}
        defaultSort={{ column: 'performed_at', desc: true }} exportName="device-movements" storageKey="movements"
        columns={[
          c.accessor('performed_at', { header: 'When', cell: (x) => <span className="whitespace-nowrap">{formatDateTime(x.getValue())}</span> }),
          c.accessor('serial_number', { header: 'Serial', cell: (x) => <Link className="mono text-primary hover:underline" to={`/devices/${x.row.original.device_id}`}>{x.getValue() ?? x.row.original.asset_tag}</Link> }),
          c.accessor('model_name', { header: 'Model' }),
          c.accessor('movement_type', { header: 'Movement', cell: (x) => labelize(x.getValue()) }),
          c.accessor('to_status', { header: 'Status change', cell: (x) => <span className="whitespace-nowrap">{x.row.original.from_status && <><StatusBadge status={x.row.original.from_status} kind="device" /> → </>}<StatusBadge status={x.getValue()} kind="device" /></span> }),
          c.accessor('from_warehouse_code', { header: 'From', cell: (x) => [x.getValue(), x.row.original.from_location_code].filter(Boolean).join(' / ') || '—' }),
          c.accessor('to_warehouse_code', { header: 'To', cell: (x) => [x.getValue(), x.row.original.to_location_code].filter(Boolean).join(' / ') || x.row.original.institution_name || '—' }),
          c.accessor('reference', { header: 'Reference', cell: (x) => <span className="mono text-xs">{x.row.original.wo_number ?? x.row.original.dispatch_number ?? x.getValue() ?? ''}</span> }),
          c.accessor('reason', { header: 'Reason', cell: (x) => x.getValue() ?? '' }),
          c.accessor('performed_by_name', { header: 'By', cell: (x) => x.getValue() ?? 'System' }),
        ]}
        exportColumns={['performed_at', 'serial_number', 'asset_tag', 'model_name', 'movement_type', 'from_status', 'to_status', 'from_warehouse_code', 'to_warehouse_code', 'institution_name', 'wo_number', 'dispatch_number', 'reference', 'reason', 'performed_by_name']
          .map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
    </div>
  );
}
