import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createColumnHelper } from '@tanstack/react-table';
import { Plus, Upload } from 'lucide-react';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { PageHeader, useDebounce } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/useAuth';
import { opts, useCategories, useDistricts, useProvinces, useUsers, useWarehouses, useWorkOrderTypes } from '@/hooks/useLookups';
import { formatDate, labelize } from '@/lib/utils';
import { RECIPIENT_TYPES, WORK_ORDER_STATUSES } from '@/lib/status';
import type { Filter } from '@/lib/api';

export type WorkOrderRow = Record<string, unknown> & {
  id: string; wo_number: string; status: string; institution_name: string; emis_number: string; province_name: string;
  district_name: string; work_order_type_name: string; recipient_type: string; total_requested: number; total_approved: number;
  total_issued: number; total_dispatched: number; total_delivered: number; warehouse_code: string | null; scheduled_date: string | null;
  invoice_status: string; delivery_status: string; created_at: string; created_by_name: string; priority: string; category_names: string;
  open_discrepancies: number; assigned_to_name: string | null; invoice_numbers: string | null; dispatch_numbers: string | null;
};

const TABS: { key: string; label: string; statuses?: string[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending_authorisation', label: 'Pending Authorisation', statuses: ['pending_authorisation'] },
  { key: 'pending_scheduling', label: 'Pending Scheduling', statuses: ['approved', 'pending_scheduling'] },
  { key: 'scheduled_pending_issuing', label: 'Scheduled Pending Issuing', statuses: ['scheduled', 'scheduled_pending_issuing', 'issuing_in_progress'] },
  { key: 'issued', label: 'Issued', statuses: ['issued', 'pending_invoicing', 'invoiced', 'ready_for_dispatch'] },
  { key: 'dispatched', label: 'Dispatched', statuses: ['partially_dispatched', 'dispatched', 'partially_delivered'] },
  { key: 'completed', label: 'Completed', statuses: ['delivered', 'completed'] },
];

const col = createColumnHelper<WorkOrderRow>();

export function WorkOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'all';
  const [search, setSearch] = useState('');
  const [f, setF] = useState<Record<string, string>>({});
  const debounced = useDebounce(search);
  const provinces = useProvinces().data;
  const districts = useDistricts().data;
  const warehouses = useWarehouses().data;
  const types = useWorkOrderTypes().data;
  const categories = useCategories().data;
  const users = useUsers().data;
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const filters = useMemo<Filter[]>(() => {
    const t = TABS.find((x) => x.key === tab);
    return [
      { column: 'status', op: 'in', value: t?.statuses ?? (f.status ? [f.status] : []) },
      { column: 'province_id', op: 'eq', value: f.province_id },
      { column: 'district_id', op: 'eq', value: f.district_id },
      { column: 'warehouse_id', op: 'eq', value: f.warehouse_id },
      { column: 'work_order_type_id', op: 'eq', value: f.type },
      { column: 'recipient_type', op: 'eq', value: f.recipient_type },
      { column: 'assigned_to', op: 'eq', value: f.assigned_to },
      { column: 'invoice_status', op: 'eq', value: f.invoice_status },
      { column: 'delivery_status', op: 'eq', value: f.delivery_status },
      { column: 'category_ids', op: 'cs', value: f.category ? [f.category] : [] },
      { column: 'created_at', op: 'gte', value: f.from ? `${f.from}T00:00:00+02:00` : '' },
      { column: 'created_at', op: 'lte', value: f.to ? `${f.to}T23:59:59+02:00` : '' },
      { column: 'emis_number', op: 'ilike', value: f.emis },
    ];
  }, [tab, f]);

  const columns = [
    col.accessor('wo_number', { header: 'Work order', cell: (c) => <Link to={`/work-orders/${c.row.original.id}`} className="mono font-medium text-primary hover:underline">{c.getValue()}</Link> }),
    col.accessor('status', { header: 'Status', cell: (c) => <StatusBadge status={c.getValue()} kind="wo" /> }),
    col.accessor('institution_name', { header: 'Institution', cell: (c) => <div><div className="font-medium">{c.getValue()}</div><div className="text-xs text-muted-foreground">EMIS {c.row.original.emis_number}</div></div> }),
    col.accessor('province_name', { header: 'Province' }),
    col.accessor('district_name', { header: 'District' }),
    col.accessor('work_order_type_name', { header: 'Type', enableSorting: false }),
    col.accessor('recipient_type', { header: 'Recipient', cell: (c) => labelize(c.getValue()) }),
    col.accessor('category_names', { header: 'Devices', enableSorting: false }),
    col.display({ id: 'qty', header: 'Qty (appr / issued / deliv.)', cell: (c) => {
      const r = c.row.original;
      return <span className="tabular-nums">{r.total_approved || r.total_requested} / {r.total_issued} / {r.total_delivered}</span>;
    } }),
    col.accessor('warehouse_code', { header: 'Warehouse', cell: (c) => c.getValue() ?? '—' }),
    col.accessor('scheduled_date', { header: 'Scheduled', cell: (c) => formatDate(c.getValue()) }),
    col.accessor('invoice_status', { header: 'Invoice', cell: (c) => <StatusBadge status={c.getValue()} /> }),
    col.accessor('delivery_status', { header: 'Delivery', cell: (c) => <StatusBadge status={c.getValue()} /> }),
    col.accessor('assigned_to_name', { header: 'Assigned', cell: (c) => c.getValue() ?? '—' }),
    col.accessor('created_at', { header: 'Created', cell: (c) => formatDate(c.getValue()) }),
  ];

  return (
    <div>
      <PageHeader title="Work Orders" crumbs={[{ label: 'Work Orders' }]}
        description="Every work order follows a controlled workflow; statuses change only through validated actions."
        actions={<>
          {can('work_orders.import') && <Button variant="outline" asChild><Link to="/work-orders/import"><Upload /> Import</Link></Button>}
          {can('work_orders.create') && <Button asChild><Link to="/work-orders/new"><Plus /> New work order</Link></Button>}
        </>} />

      <Tabs value={tab} onValueChange={(v) => setParams(v === 'all' ? {} : { tab: v })}>
        <TabsList aria-label="Work order workflow stage">
          {TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <div className="my-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Input aria-label="Search" placeholder="Search WO number, institution, EMIS…" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:col-span-2" />
        {tab === 'all' && <Select aria-label="Status" value={f.status ?? ''} onChange={(e) => set('status', e.target.value)} placeholder="All statuses"
          options={WORK_ORDER_STATUSES.map((s) => ({ value: s, label: labelize(s) }))} />}
        <Select aria-label="Province" value={f.province_id ?? ''} onChange={(e) => { set('province_id', e.target.value); set('district_id', ''); }} placeholder="All provinces" options={opts(provinces, (p) => p.name)} />
        <Select aria-label="District" value={f.district_id ?? ''} onChange={(e) => set('district_id', e.target.value)} placeholder="All districts"
          options={opts(districts?.filter((d) => !f.province_id || d.province_id === f.province_id), (d) => d.name)} />
        <Input aria-label="EMIS number" placeholder="EMIS number" value={f.emis ?? ''} onChange={(e) => set('emis', e.target.value)} />
        <Select aria-label="Warehouse" value={f.warehouse_id ?? ''} onChange={(e) => set('warehouse_id', e.target.value)} placeholder="All warehouses" options={opts(warehouses, (w) => w.code)} />
        <Select aria-label="Work order type" value={f.type ?? ''} onChange={(e) => set('type', e.target.value)} placeholder="All types" options={opts(types, (t) => t.name)} />
        <Select aria-label="Device type" value={f.category ?? ''} onChange={(e) => set('category', e.target.value)} placeholder="All device types" options={opts(categories, (c) => c.name)} />
        <Select aria-label="Recipient type" value={f.recipient_type ?? ''} onChange={(e) => set('recipient_type', e.target.value)} placeholder="All recipients"
          options={RECIPIENT_TYPES.map((r) => ({ value: r, label: labelize(r) }))} />
        <Select aria-label="Assigned user" value={f.assigned_to ?? ''} onChange={(e) => set('assigned_to', e.target.value)} placeholder="Any assignee" options={opts(users, (u) => u.full_name)} />
        <Select aria-label="Invoice status" value={f.invoice_status ?? ''} onChange={(e) => set('invoice_status', e.target.value)} placeholder="Any invoice status"
          options={['not_required', 'not_invoiced', 'draft', 'partially_invoiced', 'invoiced'].map((s) => ({ value: s, label: labelize(s) }))} />
        <Select aria-label="Dispatch status" value={f.delivery_status ?? ''} onChange={(e) => set('delivery_status', e.target.value)} placeholder="Any dispatch status"
          options={['not_dispatched', 'in_transit', 'partially_delivered', 'delivered'].map((s) => ({ value: s, label: labelize(s) }))} />
        <Input type="date" aria-label="Created from" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} />
        <Input type="date" aria-label="Created to" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} />
        {Object.values(f).some(Boolean) && <Button variant="ghost" onClick={() => setF({})}>Clear filters</Button>}
      </div>

      <ServerDataTable<WorkOrderRow>
        source="v_work_orders" queryKey={['work-orders']} columns={columns} filters={filters} search={debounced}
        searchColumns={['wo_number', 'institution_name', 'emis_number', 'source_reference']}
        defaultSort={{ column: 'created_at', desc: true }} storageKey="work-orders"
        onRowClick={(r) => nav(`/work-orders/${r.id}`)} exportName="work-orders" emptyTitle="No work orders match"
        exportColumns={[
          { header: 'Work order', value: (r) => r.wo_number }, { header: 'Status', value: (r) => labelize(r.status) },
          { header: 'Institution', value: (r) => r.institution_name }, { header: 'EMIS', value: (r) => r.emis_number },
          { header: 'Province', value: (r) => r.province_name }, { header: 'District', value: (r) => r.district_name },
          { header: 'Type', value: (r) => r.work_order_type_name }, { header: 'Recipient type', value: (r) => r.recipient_type },
          { header: 'Requested', value: (r) => r.total_requested }, { header: 'Approved', value: (r) => r.total_approved },
          { header: 'Issued', value: (r) => r.total_issued }, { header: 'Dispatched', value: (r) => r.total_dispatched },
          { header: 'Delivered', value: (r) => r.total_delivered }, { header: 'Warehouse', value: (r) => r.warehouse_code },
          { header: 'Scheduled', value: (r) => r.scheduled_date }, { header: 'Invoice status', value: (r) => r.invoice_status },
          { header: 'Invoices', value: (r) => r.invoice_numbers }, { header: 'Dispatches', value: (r) => r.dispatch_numbers },
          { header: 'Created', value: (r) => r.created_at }, { header: 'Created by', value: (r) => r.created_by_name },
        ]} />
    </div>
  );
}
