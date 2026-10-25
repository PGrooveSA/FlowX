import { useMemo, useState } from 'react';
import { createColumnHelper } from '@tanstack/react-table';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import { fetchForExport, type Filter } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { opts, useProvinces, useWarehouses } from '@/hooks/useLookups';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader, useDebounce } from '@/components/common';
import { cn } from '@/lib/utils';

type Row = Record<string, string>;
type Fmt = 'text' | 'date' | 'datetime' | 'money' | 'status' | 'wo_status' | 'device_status' | 'mono' | 'label';
interface ReportCol { key: string; label: string; fmt?: Fmt }
interface ReportDef {
  key: string; title: string; group: string; description: string; source: string; permission?: string;
  columns: ReportCol[]; sort: { column: string; desc: boolean }; dateColumn?: string; statusColumn?: string; statuses?: string[];
  warehouseColumn?: string; provinceColumn?: string; searchColumns?: string[]; fixed?: Filter[];
}

const WO_STATUSES = ['draft', 'pending_authorisation', 'returned_for_correction', 'pending_scheduling', 'scheduled', 'scheduled_pending_issuing', 'issuing_in_progress', 'issued', 'pending_invoicing', 'invoiced', 'ready_for_dispatch', 'partially_dispatched', 'dispatched', 'partially_delivered', 'delivered', 'completed', 'cancelled'];

const REPORTS: ReportDef[] = [
  { key: 'wo_status', group: 'Work orders', title: 'Work order status report', description: 'All work orders with fulfilment quantities.', source: 'v_work_orders',
    columns: [{ key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'status', label: 'Status', fmt: 'wo_status' }, { key: 'institution_name', label: 'Institution' }, { key: 'emis_number', label: 'EMIS' },
      { key: 'province_name', label: 'Province' }, { key: 'work_order_type_name', label: 'Type' }, { key: 'total_approved', label: 'Approved' }, { key: 'total_issued', label: 'Issued' },
      { key: 'total_dispatched', label: 'Dispatched' }, { key: 'total_delivered', label: 'Delivered' }, { key: 'invoice_status', label: 'Invoice', fmt: 'status' }, { key: 'created_at', label: 'Created', fmt: 'date' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'created_at', statusColumn: 'status', statuses: WO_STATUSES, warehouseColumn: 'warehouse_id', provinceColumn: 'province_id', searchColumns: ['wo_number', 'institution_name', 'emis_number'] },
  { key: 'wo_ageing', group: 'Work orders', title: 'Work order ageing', description: 'Open work orders by age bucket.', source: 'v_wo_ageing',
    columns: [{ key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'status', label: 'Status', fmt: 'wo_status' }, { key: 'age_bucket', label: 'Age bucket' }, { key: 'age_days', label: 'Days open' },
      { key: 'institution_name', label: 'Institution' }, { key: 'province_name', label: 'Province' }, { key: 'warehouse_code', label: 'Warehouse' }, { key: 'total_approved', label: 'Approved' }, { key: 'total_delivered', label: 'Delivered' }],
    sort: { column: 'age_days', desc: true }, statusColumn: 'status', statuses: WO_STATUSES, warehouseColumn: 'warehouse_id', provinceColumn: 'province_id', searchColumns: ['wo_number', 'institution_name'] },
  { key: 'approval_turnaround', group: 'Work orders', title: 'Approval turnaround', description: 'Time from submission to authorisation decision.', source: 'v_approval_turnaround',
    columns: [{ key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'status', label: 'Status', fmt: 'wo_status' }, { key: 'institution_name', label: 'Institution' }, { key: 'submitted_at', label: 'Submitted', fmt: 'datetime' },
      { key: 'approved_at', label: 'Approved', fmt: 'datetime' }, { key: 'approved_by_name', label: 'Approved by' }, { key: 'hours_to_decision', label: 'Hours' }],
    sort: { column: 'submitted_at', desc: true }, dateColumn: 'submitted_at', searchColumns: ['wo_number', 'institution_name'] },
  { key: 'device_inventory', group: 'Devices & stock', title: 'Device inventory', description: 'Every registered device with status, condition and location.', source: 'v_devices',
    columns: [{ key: 'serial_number', label: 'Serial', fmt: 'mono' }, { key: 'asset_tag', label: 'Asset tag', fmt: 'mono' }, { key: 'manufacturer', label: 'Manufacturer' }, { key: 'model_name', label: 'Model' },
      { key: 'status', label: 'Status', fmt: 'device_status' }, { key: 'condition', label: 'Condition', fmt: 'label' }, { key: 'warehouse_code', label: 'Warehouse' }, { key: 'location_code', label: 'Location' },
      { key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'institution_name', label: 'Institution' }, { key: 'warranty_expires_on', label: 'Warranty to', fmt: 'date' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'created_at', statusColumn: 'status',
    statuses: ['available', 'reserved', 'picked', 'issued', 'in_transit', 'dispatched', 'delivered', 'faulty', 'under_assessment', 'under_repair', 'awaiting_parts', 'repair_completed', 'returned_to_warehouse', 'quarantined', 'lost', 'stolen', 'written_off'],
    warehouseColumn: 'warehouse_id', searchColumns: ['serial_number', 'asset_tag', 'institution_name'] },
  { key: 'custody', group: 'Devices & stock', title: 'Device custody and movement history', description: 'Permanent ledger of every movement. Search by serial for a serial-number lookup.', source: 'v_device_movements',
    columns: [{ key: 'performed_at', label: 'When', fmt: 'datetime' }, { key: 'serial_number', label: 'Serial', fmt: 'mono' }, { key: 'movement_type', label: 'Movement', fmt: 'label' }, { key: 'from_status', label: 'From', fmt: 'device_status' },
      { key: 'to_status', label: 'To', fmt: 'device_status' }, { key: 'to_warehouse_code', label: 'Warehouse' }, { key: 'institution_name', label: 'Institution' }, { key: 'wo_number', label: 'Work order', fmt: 'mono' },
      { key: 'reference', label: 'Reference', fmt: 'mono' }, { key: 'reason', label: 'Reason' }, { key: 'performed_by_name', label: 'By' }],
    sort: { column: 'performed_at', desc: true }, dateColumn: 'performed_at', warehouseColumn: 'to_warehouse_id', searchColumns: ['serial_number', 'asset_tag', 'reference', 'wo_number'] },
  { key: 'stock_availability', group: 'Devices & stock', title: 'Stock availability', description: 'Calculated stock by warehouse and model.', source: 'v_stock_summary',
    columns: [{ key: 'warehouse_code', label: 'Warehouse' }, { key: 'manufacturer', label: 'Manufacturer' }, { key: 'model_name', label: 'Model' }, { key: 'available', label: 'Available' }, { key: 'reserved', label: 'Reserved' },
      { key: 'picked_issued', label: 'Picked/issued' }, { key: 'in_repair', label: 'Repair' }, { key: 'quarantine', label: 'Quarantine' }, { key: 'on_hand', label: 'On hand' }, { key: 'low_stock_threshold', label: 'Threshold' }],
    sort: { column: 'warehouse_code', desc: false }, warehouseColumn: 'warehouse_id', searchColumns: ['model_name', 'manufacturer'] },
  { key: 'stock_variance', group: 'Devices & stock', title: 'Stock variance', description: 'Missing, unexpected and misplaced devices from stock counts.', source: 'v_stock_variance',
    columns: [{ key: 'count_number', label: 'Count', fmt: 'mono' }, { key: 'count_status', label: 'Count status', fmt: 'status' }, { key: 'warehouse_code', label: 'Warehouse' }, { key: 'result', label: 'Result', fmt: 'status' },
      { key: 'serial_number', label: 'Serial', fmt: 'mono' }, { key: 'system_status', label: 'System status', fmt: 'device_status' }, { key: 'expected_location', label: 'Expected' }, { key: 'found_location', label: 'Found' }, { key: 'started_at', label: 'Count date', fmt: 'date' }],
    sort: { column: 'started_at', desc: true }, dateColumn: 'started_at', statusColumn: 'result', statuses: ['missing', 'unexpected', 'wrong_location'], warehouseColumn: 'warehouse_id', searchColumns: ['serial_number', 'count_number'] },
  { key: 'allocations', group: 'Devices & stock', title: 'Device allocation report', description: 'Every device-to-work-order allocation and its outcome.', source: 'v_allocations',
    columns: [{ key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'institution_name', label: 'Institution' }, { key: 'serial_number', label: 'Serial', fmt: 'mono' }, { key: 'model_name', label: 'Model' },
      { key: 'allocation_status', label: 'Allocation', fmt: 'status' }, { key: 'issued_at', label: 'Issued', fmt: 'datetime' }, { key: 'delivered_at', label: 'Delivered', fmt: 'datetime' }, { key: 'release_reason', label: 'Release reason' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'created_at', statusColumn: 'allocation_status', statuses: ['reserved', 'picked', 'issued', 'dispatched', 'delivered', 'released', 'replaced', 'returned', 'cancelled'],
    warehouseColumn: 'warehouse_id', provinceColumn: 'province_id', searchColumns: ['wo_number', 'serial_number', 'institution_name'] },
  { key: 'repair_turnaround', group: 'Repairs', title: 'Repair turnaround', description: 'Repair jobs with costs and days open.', source: 'v_repairs',
    columns: [{ key: 'repair_number', label: 'Repair', fmt: 'mono' }, { key: 'status', label: 'Status', fmt: 'status' }, { key: 'serial_number', label: 'Serial', fmt: 'mono' }, { key: 'model_name', label: 'Model' },
      { key: 'provider_type', label: 'Provider', fmt: 'label' }, { key: 'total_cost_cents', label: 'Cost', fmt: 'money' }, { key: 'turnaround_days', label: 'Days' }, { key: 'qc_result', label: 'QC' }, { key: 'created_at', label: 'Created', fmt: 'date' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'created_at', statusColumn: 'status', statuses: ['assessed', 'awaiting_approval', 'awaiting_parts', 'under_repair', 'repair_completed', 'quality_check', 'ready_for_return', 'returned_to_warehouse', 'closed', 'cancelled'], searchColumns: ['repair_number', 'serial_number'] },
  { key: 'fault_trends', group: 'Repairs', title: 'Fault and failure trends', description: 'Assessments per month, model and outcome.', source: 'v_fault_trends',
    columns: [{ key: 'month', label: 'Month', fmt: 'date' }, { key: 'manufacturer', label: 'Manufacturer' }, { key: 'model_name', label: 'Model' }, { key: 'outcome', label: 'Outcome', fmt: 'status' }, { key: 'assessments', label: 'Assessments' }],
    sort: { column: 'month', desc: true }, dateColumn: 'month', searchColumns: ['model_name', 'manufacturer'] },
  { key: 'replacements', group: 'Repairs', title: 'Warranty and replacement report', description: 'Replacement transactions with warranty status of the original device.', source: 'v_replacements',
    columns: [{ key: 'replacement_number', label: 'Replacement', fmt: 'mono' }, { key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'original_serial', label: 'Original', fmt: 'mono' }, { key: 'replacement_serial', label: 'Replacement', fmt: 'mono' },
      { key: 'model_name', label: 'Model' }, { key: 'original_in_warranty', label: 'In warranty' }, { key: 'reason', label: 'Reason' }, { key: 'authorised_by_name', label: 'Authorised by' }, { key: 'created_at', label: 'Date', fmt: 'date' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'created_at', searchColumns: ['original_serial', 'replacement_serial', 'wo_number'] },
  { key: 'invoice_register', group: 'Finance', title: 'Invoice register', permission: 'reports.financial', description: 'All invoices and their balances.', source: 'v_invoices',
    columns: [{ key: 'invoice_number', label: 'Invoice', fmt: 'mono' }, { key: 'display_status', label: 'Status', fmt: 'status' }, { key: 'customer_name', label: 'Customer' }, { key: 'wo_number', label: 'Work order', fmt: 'mono' },
      { key: 'invoice_date', label: 'Date', fmt: 'date' }, { key: 'due_date', label: 'Due', fmt: 'date' }, { key: 'subtotal_cents', label: 'Subtotal', fmt: 'money' }, { key: 'vat_cents', label: 'VAT', fmt: 'money' },
      { key: 'total_cents', label: 'Total', fmt: 'money' }, { key: 'amount_paid_cents', label: 'Paid', fmt: 'money' }, { key: 'balance_cents', label: 'Balance', fmt: 'money' }],
    sort: { column: 'invoice_date', desc: true }, dateColumn: 'invoice_date', statusColumn: 'status', statuses: ['draft', 'issued', 'partially_paid', 'paid', 'credited', 'cancelled'], searchColumns: ['invoice_number', 'customer_name', 'wo_number'] },
  { key: 'outstanding_invoices', group: 'Finance', title: 'Outstanding invoices', permission: 'reports.financial', description: 'Unpaid balances with days overdue.', source: 'v_invoices',
    fixed: [{ column: 'status', op: 'in', value: ['issued', 'partially_paid'] }],
    columns: [{ key: 'invoice_number', label: 'Invoice', fmt: 'mono' }, { key: 'display_status', label: 'Status', fmt: 'status' }, { key: 'customer_name', label: 'Customer' }, { key: 'due_date', label: 'Due', fmt: 'date' },
      { key: 'days_overdue', label: 'Days overdue' }, { key: 'total_cents', label: 'Total', fmt: 'money' }, { key: 'balance_cents', label: 'Balance', fmt: 'money' }],
    sort: { column: 'due_date', desc: false }, dateColumn: 'invoice_date', searchColumns: ['invoice_number', 'customer_name'] },
  { key: 'dispatch_register', group: 'Logistics', title: 'Dispatch register', description: 'Every shipment with courier and quantities.', source: 'v_dispatches',
    columns: [{ key: 'dispatch_number', label: 'Dispatch', fmt: 'mono' }, { key: 'status', label: 'Status', fmt: 'status' }, { key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'institution_name', label: 'Destination' },
      { key: 'courier_name', label: 'Courier' }, { key: 'tracking_number', label: 'Tracking', fmt: 'mono' }, { key: 'device_count', label: 'Devices' }, { key: 'delivered_count', label: 'Delivered' }, { key: 'dispatched_at', label: 'Dispatched', fmt: 'datetime' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'dispatched_at', statusColumn: 'status', statuses: ['draft', 'dispatched', 'partially_delivered', 'delivered', 'failed', 'cancelled'], warehouseColumn: 'origin_warehouse_id', searchColumns: ['dispatch_number', 'tracking_number', 'wo_number'] },
  { key: 'deliveries', group: 'Logistics', title: 'Delivery confirmation report', description: 'Proof-of-delivery records.', source: 'v_deliveries',
    columns: [{ key: 'delivery_number', label: 'POD', fmt: 'mono' }, { key: 'outcome', label: 'Outcome', fmt: 'status' }, { key: 'dispatch_number', label: 'Dispatch', fmt: 'mono' }, { key: 'institution_name', label: 'Institution' },
      { key: 'received_by_name', label: 'Received by' }, { key: 'quantity_expected', label: 'Expected' }, { key: 'quantity_received', label: 'Received' }, { key: 'quantity_outstanding', label: 'Outstanding' }, { key: 'delivered_at', label: 'Delivered', fmt: 'datetime' }],
    sort: { column: 'delivered_at', desc: true }, dateColumn: 'delivered_at', statusColumn: 'outcome', statuses: ['delivered', 'partially_delivered', 'failed', 'damaged', 'missing', 'rejected', 'returned_to_sender'], searchColumns: ['delivery_number', 'dispatch_number', 'institution_name'] },
  { key: 'delivery_exceptions', group: 'Logistics', title: 'Partial and failed deliveries', description: 'Deliveries that were not fully received.', source: 'v_deliveries',
    fixed: [{ column: 'outcome', op: 'neq', value: 'delivered' }],
    columns: [{ key: 'delivery_number', label: 'POD', fmt: 'mono' }, { key: 'outcome', label: 'Outcome', fmt: 'status' }, { key: 'dispatch_number', label: 'Dispatch', fmt: 'mono' }, { key: 'institution_name', label: 'Institution' },
      { key: 'quantity_expected', label: 'Expected' }, { key: 'quantity_received', label: 'Received' }, { key: 'quantity_damaged', label: 'Damaged' }, { key: 'quantity_missing', label: 'Missing' }, { key: 'quantity_rejected', label: 'Rejected' }, { key: 'failure_reason', label: 'Failure reason' }],
    sort: { column: 'delivered_at', desc: true }, dateColumn: 'delivered_at', searchColumns: ['delivery_number', 'dispatch_number'] },
  { key: 'discrepancies', group: 'Logistics', title: 'Missing device and discrepancy report', description: 'Serial mismatches, unknown serials and missing devices.', source: 'v_discrepancies',
    columns: [{ key: 'discrepancy_number', label: 'Number', fmt: 'mono' }, { key: 'status', label: 'Status', fmt: 'status' }, { key: 'context', label: 'Context', fmt: 'label' }, { key: 'reason_code', label: 'Reason', fmt: 'status' },
      { key: 'expected_serial', label: 'Expected', fmt: 'mono' }, { key: 'scanned_serial', label: 'Scanned', fmt: 'mono' }, { key: 'wo_number', label: 'Work order', fmt: 'mono' }, { key: 'reported_by_name', label: 'Reported by' }, { key: 'created_at', label: 'When', fmt: 'datetime' }],
    sort: { column: 'created_at', desc: true }, dateColumn: 'created_at', statusColumn: 'status', statuses: ['open', 'resolved', 'dismissed'], searchColumns: ['discrepancy_number', 'scanned_serial', 'expected_serial', 'wo_number'] },
  { key: 'user_activity', group: 'Governance', title: 'User activity', permission: 'audit.view', description: 'Actions per user per day, including failed attempts.', source: 'v_user_activity',
    columns: [{ key: 'activity_date', label: 'Date', fmt: 'date' }, { key: 'user_email', label: 'User' }, { key: 'actions', label: 'Actions' }, { key: 'failed_actions', label: 'Failed' }, { key: 'action_types', label: 'Action types' }],
    sort: { column: 'activity_date', desc: true }, dateColumn: 'activity_date', searchColumns: ['user_email'] },
];

function fmt(v: string | undefined | null, f: Fmt = 'text') {
  if (v === null || v === undefined || v === '') return '—';
  switch (f) {
    case 'date': return formatDate(v);
    case 'datetime': return formatDateTime(v);
    case 'money': return formatMoney(Number(v));
    case 'status': return <StatusBadge status={v} />;
    case 'wo_status': return <StatusBadge status={v} kind="wo" />;
    case 'device_status': return <StatusBadge status={v} kind="device" />;
    case 'mono': return <span className="mono">{v}</span>;
    case 'label': return labelize(v);
    default: return String(v);
  }
}
const plain = (v: string | undefined | null, f: Fmt = 'text') => (v === null || v === undefined ? '' : f === 'money' ? (Number(v) / 100).toFixed(2) : String(v));
const c = createColumnHelper<Row>();

export function ReportsPage() {
  const { can, branding } = useAuth();
  const available = REPORTS.filter((r) => can(r.permission ?? 'reports.view'));
  const [key, setKey] = useState(available[0]?.key);
  const r = available.find((x) => x.key === key)!;
  const [f, setF] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const warehouses = useWarehouses().data;
  const provinces = useProvinces().data;
  const [printRows, setPrintRows] = useState<Row[] | null>(null);

  const filters = useMemo<Filter[]>(() => !r ? [] : [
    ...(r.fixed ?? []),
    ...(r.statusColumn ? [{ column: r.statusColumn, op: 'eq' as const, value: f.status }] : []),
    ...(r.warehouseColumn ? [{ column: r.warehouseColumn, op: 'eq' as const, value: f.warehouse }] : []),
    ...(r.provinceColumn ? [{ column: r.provinceColumn, op: 'eq' as const, value: f.province }] : []),
    ...(r.dateColumn ? [{ column: r.dateColumn, op: 'gte' as const, value: f.from }, { column: r.dateColumn, op: 'lte' as const, value: f.to ? `${f.to}T23:59:59+02:00` : '' }] : []),
  ], [r, f]);

  if (!r) return <PageHeader title="Reports" description="No reports are available for your role." />;
  const columns = r.columns.map((col) => c.accessor((row) => row[col.key], { id: col.key, header: col.label, cell: (x) => fmt(x.getValue(), col.fmt) }));

  const printReport = async () => {
    try {
      const rows = await fetchForExport<Row>(r.source, { sort: r.sort, filters, search: debounced, searchColumns: r.searchColumns }, 2000);
      setPrintRows(rows);
      setTimeout(() => { window.print(); }, 300);
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <div className="no-print">
        <PageHeader title="Reports & Analytics" crumbs={[{ label: 'Reports' }]} description="All reports run live database queries and respect your permissions and scope. Export to CSV/Excel or print to PDF." />
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <Card><CardContent className="p-2">
            {[...new Set(available.map((x) => x.group))].map((g) => (
              <div key={g} className="mb-2">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
                {available.filter((x) => x.group === g).map((x) => (
                  <button key={x.key} onClick={() => { setKey(x.key); setF({}); setSearch(''); }}
                    className={cn('block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted', x.key === key && 'bg-primary/10 font-medium text-primary')}>{x.title}</button>
                ))}
              </div>
            ))}
          </CardContent></Card>
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><h2 className="text-lg font-semibold">{r.title}</h2><p className="text-sm text-muted-foreground">{r.description}</p></div>
              <Button variant="outline" onClick={() => void printReport()}><Printer /> Print / PDF</Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
              {r.searchColumns && <Input aria-label="Search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="lg:col-span-2" />}
              {r.statusColumn && <Select aria-label="Status" value={f.status ?? ''} onChange={(e) => setF({ ...f, status: e.target.value })} placeholder="All statuses" options={(r.statuses ?? []).map((s) => ({ value: s, label: labelize(s) }))} />}
              {r.warehouseColumn && <Select aria-label="Warehouse" value={f.warehouse ?? ''} onChange={(e) => setF({ ...f, warehouse: e.target.value })} placeholder="All warehouses" options={opts(warehouses, (w) => w.code)} />}
              {r.provinceColumn && <Select aria-label="Province" value={f.province ?? ''} onChange={(e) => setF({ ...f, province: e.target.value })} placeholder="All provinces" options={opts(provinces, (p) => p.name)} />}
              {r.dateColumn && <><Input type="date" aria-label="From date" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} />
                <Input type="date" aria-label="To date" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} /></>}
            </div>
            <ServerDataTable<Row> key={r.key} source={r.source} queryKey={['report', r.key]} columns={columns} filters={filters} search={debounced} searchColumns={r.searchColumns}
              defaultSort={r.sort} exportName={r.key} exportColumns={r.columns.map((col) => ({ header: col.label, value: (row: Row) => plain(row[col.key], col.fmt) }))} />
          </div>
        </div>
      </div>
      {printRows && (
        <div className="hidden print:block">
          <h1 className="text-lg font-semibold">{r.title}</h1>
          <p className="mb-3 text-xs">{branding.orgName} · generated {formatDateTime(new Date())} · {printRows.length} rows{printRows.length === 2000 ? ' (first 2000 — export for the full set)' : ''}</p>
          <table className="w-full border-collapse text-[10px]"><thead><tr>{r.columns.map((col) => <th key={col.key} className="border px-1 py-0.5 text-left">{col.label}</th>)}</tr></thead>
            <tbody>{printRows.map((row, i) => <tr key={i}>{r.columns.map((col) => <td key={col.key} className="border px-1 py-0.5">{plain(row[col.key], col.fmt)}</td>)}</tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}
