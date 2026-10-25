import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, ClipboardList, Download, Filter as FilterIcon, ListChecks, MoreVertical, Plus, SlidersHorizontal, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { fetchForExport, fetchList, rpc, type Filter } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { cn, formatDateNumeric, labelize } from '@/lib/utils';
import { PRIORITIES, RECIPIENT_TYPES } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useCategories, useDistricts, useProvinces, useUsers, useWarehouses, useWorkOrderTypes } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { Input, Select } from '@/components/ui/form-controls';
import { ErrorState, PageHeader, useDebounce } from '@/components/common';

export type WorkOrderRow = Record<string, unknown> & {
  id: string; wo_number: string; status: string; institution_name: string; emis_number: string; province_name: string;
  district_name: string; work_order_type_name: string; recipient_type: string; total_requested: number; total_approved: number;
  total_issued: number; total_dispatched: number; total_delivered: number; warehouse_code: string | null; scheduled_date: string | null;
  invoice_status: string; delivery_status: string; created_at: string; created_by_name: string; priority: string; category_names: string;
  open_discrepancies: number; assigned_to_name: string | null; invoice_numbers: string | null; dispatch_numbers: string | null;
};
type ListRow = WorkOrderRow & { province_code: string; downloaded_at: string; updated_at: string; device_count: number; description: string | null;
  device_names: string | null; started_at: string | null; allocated_clusters: string | null; invoice_required: boolean };

// Columns shown per tab; tabs without their own layout use DEFAULT_COLUMNS.
const DEFAULT_COLUMNS = ['wo_number', 'downloaded_at', 'province_code', 'emis_number', 'institution_name', 'description', 'recipient_type', 'category_names', 'device_count', 'work_order_type_name'];

const TABS: { key: string; label: string; statuses: string[]; description: string; columns?: string[]; sort?: { column: string; desc: boolean }; actionLabel?: string }[] = [
  { key: 'pending_authorisation', label: 'Pending Authorisation', statuses: ['pending_authorisation'],
    description: 'This is a list of Work Orders that are currently waiting to be authorised to move into the scheduling process.' },
  { key: 'pending_scheduling', label: 'Pending Scheduling', statuses: ['approved', 'pending_scheduling'],
    description: 'This is a list of Work Orders that are currently waiting for scheduling.',
    columns: ['wo_number', 'updated_at', 'province_code', 'emis_number', 'institution_name', 'description', 'priority', 'recipient_type', 'category_names', 'device_names', 'device_count', 'work_order_type_name'],
    sort: { column: 'updated_at', desc: true }, actionLabel: 'Action' },
  // Scheduled work orders are "issued for processing" to the warehouse, so the Issued tab
  // covers everything from scheduling until dispatch (there is no separate issuing tab).
  { key: 'issued', label: 'Issued', statuses: ['scheduled', 'scheduled_pending_issuing', 'issuing_in_progress', 'issued', 'pending_invoicing', 'invoiced', 'ready_for_dispatch'],
    description: 'This is a list of Work Orders that have been issued for processing.',
    columns: ['wo_number', 'started_at', 'province_code', 'emis_number', 'institution_name', 'description', 'recipient_type', 'device_count', 'category_names', 'work_order_type_name', 'allocated_clusters'],
    sort: { column: 'started_at', desc: true }, actionLabel: 'Action' },
  { key: 'completed', label: 'Completed', statuses: ['delivered', 'completed'],
    description: 'This is a list of Work Orders that have been delivered and completed.' },
  { key: 'dispatched', label: 'Dispatched', statuses: ['partially_dispatched', 'dispatched', 'partially_delivered'],
    description: 'This is a list of Work Orders that have been dispatched and are awaiting delivery confirmation.' },
];

type ColumnFilterKind = { type: 'text'; column: string } | { type: 'select'; column: string; options: { value: string; label: string }[]; op?: 'eq' | 'cs' }
  | { type: 'date'; column: string } | { type: 'number'; column: string };
interface Column { key: string; label: string; sort?: string; filter?: ColumnFilterKind; width?: string; render: (r: ListRow) => React.ReactNode }

/** Funnel button with a small popover holding one column filter. */
function ColumnFilterButton({ label, kind, value, onChange }: { label: string; kind: ColumnFilterKind; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const apply = (v: string) => { onChange(v); setOpen(false); };
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`Filter ${label}`} aria-expanded={open}
        className={cn('rounded p-1 hover:bg-slate-200', value ? 'text-primary' : 'text-slate-700')}>
        <FilterIcon className="h-4 w-4" fill={value ? 'currentColor' : 'none'} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border bg-card p-2 font-normal shadow-lg" role="dialog" aria-label={`Filter ${label}`}>
          {kind.type === 'select' ? (
            <Select aria-label={label} autoFocus value={draft} onChange={(e) => apply(e.target.value)} placeholder="All" options={kind.options} />
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); apply(draft.trim()); }} className="space-y-2">
              <Input aria-label={label} autoFocus type={kind.type === 'date' ? 'date' : kind.type === 'number' ? 'number' : 'text'}
                placeholder={kind.type === 'number' ? 'Exact number' : kind.type === 'text' ? 'Contains…' : undefined} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => apply('')}>Clear</Button>
                <Button type="submit" size="sm">Apply</Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Issued tab actions: allocated devices (issuing view) and a menu of the next permitted steps. */
function IssuedRowActions({ row }: { row: ListRow }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const run = async (fn: () => Promise<unknown>, success: string) => {
    try { await fn(); toast.success(success); void qc.invalidateQueries({ queryKey: ['work-orders'] }); }
    catch (e) { toast.error((e as Error).message); }
  };
  const s = row.status;
  const canInvoice = can('invoices.create') && row.invoice_required && ['issued', 'pending_invoicing'].includes(s) && row.invoice_status !== 'invoiced';
  const canRelease = can('dispatch.create') && ((row.invoice_required && s === 'invoiced') || (!row.invoice_required && s === 'issued'));
  const canDispatch = can('dispatch.create') && s === 'ready_for_dispatch';
  return (
    <>
      <Link to={`/issuing/${row.id}`} aria-label={`Allocated devices for ${row.wo_number}`} title="Allocated devices"
        className="inline-flex rounded p-1 text-primary hover:bg-primary/10"><ListChecks className="h-6 w-6" /></Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`More actions for ${row.wo_number}`} title="More actions" className="inline-flex rounded p-1 text-primary hover:bg-primary/10">
            <MoreVertical className="h-6 w-6" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => nav(`/work-orders/${row.id}`)}>View work order</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => nav(`/issuing/${row.id}`)}>Allocated devices</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => window.open(`/print/work-order/${row.id}`, '_blank', 'noopener')}>Print work order</DropdownMenuItem>
          {(canInvoice || canRelease || canDispatch) && <DropdownMenuSeparator />}
          {canInvoice && <DropdownMenuItem onSelect={() => void run(async () => nav(`/invoicing/${await rpc<string>('create_invoice_draft', { p_work_order_id: row.id, p_auto_fill: true })}`), 'Draft invoice created')}>Create invoice</DropdownMenuItem>}
          {canRelease && <DropdownMenuItem onSelect={() => void run(() => rpc('mark_ready_for_dispatch', { p_work_order_id: row.id }), 'Released for dispatch')}>Mark ready for dispatch</DropdownMenuItem>}
          {canDispatch && <DropdownMenuItem onSelect={() => void run(async () => nav(`/dispatch/${await rpc<string>('create_dispatch', { p_work_order_id: row.id, p: {} })}`), 'Dispatch created')}>Create dispatch</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  const start = Math.max(0, Math.min(page - 2, pageCount - 5));
  const pages = Array.from({ length: Math.min(5, pageCount) }, (_, i) => start + i);
  const btn = 'flex h-9 min-w-9 items-center justify-center border px-3 text-sm disabled:cursor-default disabled:bg-slate-200 disabled:text-slate-500';
  return (
    <nav aria-label="Pagination" className="flex items-center gap-1">
      <button className={cn(btn, 'bg-slate-200 text-slate-600')} disabled={page === 0} onClick={() => onPage(0)} aria-label="First page">«</button>
      <button className={cn(btn, 'bg-slate-200 text-slate-600')} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
      {pages.map((p) => (
        <button key={p} onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined}
          className={cn(btn, p === page ? 'border-primary bg-primary text-white' : 'bg-white text-primary hover:bg-slate-50')}>{p + 1}</button>
      ))}
      <button className={cn(btn, 'bg-white text-slate-600')} disabled={page + 1 >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
      <button className={cn(btn, 'bg-white text-slate-600')} disabled={page + 1 >= pageCount} onClick={() => onPage(pageCount - 1)} aria-label="Last page">»</button>
    </nav>
  );
}

export function WorkOrdersPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('tab')) ?? TABS[0];
  const provinces = useProvinces().data;
  const districts = useDistricts().data;
  const warehouses = useWarehouses().data;
  const types = useWorkOrderTypes().data;
  const categories = useCategories().data;
  const users = useUsers().data;

  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [more, setMore] = useState<Record<string, string>>({});
  const [showMore, setShowMore] = useState(false);
  const [sort, setSort] = useState<{ column: string; desc: boolean }>(tab.sort ?? { column: 'downloaded_at', desc: true });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [exporting, setExporting] = useState(false);
  const debouncedCols = useDebounce(colFilters, 250);

  const catalog: Column[] = [
    { key: 'wo_number', label: 'Work Order Number', sort: 'wo_number', filter: { type: 'text', column: 'wo_number' }, render: (r) => r.wo_number },
    { key: 'downloaded_at', label: 'Downloaded Date', sort: 'downloaded_at', filter: { type: 'date', column: 'downloaded_at' }, render: (r) => formatDateNumeric(r.downloaded_at) },
    { key: 'updated_at', label: 'Updated Date', sort: 'updated_at', filter: { type: 'date', column: 'updated_at' }, render: (r) => formatDateNumeric(r.updated_at) },
    { key: 'started_at', label: 'Started Date', sort: 'started_at', filter: { type: 'date', column: 'started_at' }, render: (r) => formatDateNumeric(r.started_at) },
    { key: 'allocated_clusters', label: 'Allocated Clusters', sort: 'allocated_clusters', filter: { type: 'text', column: 'allocated_clusters' }, render: (r) => r.allocated_clusters ?? '' },
    { key: 'priority', label: 'Priority', sort: 'priority', filter: { type: 'select', column: 'priority', options: PRIORITIES.map((p) => ({ value: p, label: labelize(p) })) }, render: (r) => labelize(r.priority) },
    { key: 'device_names', label: 'Device Name(s)', render: (r) => r.device_names ?? '' },
    { key: 'province_code', label: 'Province', sort: 'province_code', filter: { type: 'select', column: 'province_code', options: (provinces ?? []).map((p) => ({ value: p.code, label: p.code })) }, render: (r) => r.province_code },
    { key: 'emis_number', label: 'Emis', sort: 'emis_number', filter: { type: 'text', column: 'emis_number' }, render: (r) => r.emis_number },
    { key: 'institution_name', label: 'Institution', sort: 'institution_name', filter: { type: 'text', column: 'institution_name' }, render: (r) => `${r.province_code} - ${r.institution_name.toUpperCase()}` },
    { key: 'description', label: 'Description', sort: 'description', filter: { type: 'text', column: 'description' }, render: (r) => r.description ?? '' },
    { key: 'recipient_type', label: 'Recipient Type', sort: 'recipient_type', filter: { type: 'select', column: 'recipient_type', options: RECIPIENT_TYPES.map((t) => ({ value: t, label: labelize(t) })) }, render: (r) => labelize(r.recipient_type) },
    { key: 'category_names', label: 'Device Type(s)', render: (r) => (r.category_names ?? '').replace(/, /g, ',') },
    { key: 'device_count', label: '# Of Devices', sort: 'device_count', filter: { type: 'number', column: 'device_count' }, render: (r) => r.device_count },
    { key: 'work_order_type_name', label: 'Work Order Type', filter: { type: 'select', column: 'work_order_type_id', options: opts(types, (t) => t.name) }, render: (r) => r.work_order_type_name },
  ];
  // The Issued tab labels EMIS in capitals and lets Device Type(s) and Work Order Type be sorted and filtered.
  const issuedOverrides: Record<string, Partial<Column>> = {
    emis_number: { label: 'EMIS' },
    category_names: { sort: 'category_names', filter: { type: 'select', column: 'category_ids', op: 'cs', options: opts(categories, (c) => c.name) }, render: (r) => r.category_names ?? '' },
    work_order_type_name: { sort: 'work_order_type_name' },
  };
  const columns = (tab.columns ?? DEFAULT_COLUMNS).map((k) => {
    const c = catalog.find((x) => x.key === k)!;
    return tab.key === 'issued' ? { ...c, ...issuedOverrides[k] } : c;
  });

  const filters = useMemo<Filter[]>(() => {
    const f: Filter[] = [{ column: 'status', op: 'in', value: tab.statuses }];
    for (const c of columns) {
      const v = debouncedCols[c.key];
      if (!v || !c.filter) continue;
      if (c.filter.type === 'text') f.push({ column: c.filter.column, op: 'ilike', value: v });
      else if (c.filter.type === 'number') f.push({ column: c.filter.column, op: 'eq', value: Number(v) });
      else if (c.filter.type === 'date') f.push({ column: c.filter.column, op: 'gte', value: `${v}T00:00:00+02:00` }, { column: c.filter.column, op: 'lte', value: `${v}T23:59:59+02:00` });
      else if (c.filter.op === 'cs') f.push({ column: c.filter.column, op: 'cs', value: [v] });
      else f.push({ column: c.filter.column, op: 'eq', value: v });
    }
    f.push({ column: 'district_id', op: 'eq', value: more.district_id }, { column: 'warehouse_id', op: 'eq', value: more.warehouse_id },
      { column: 'assigned_to', op: 'eq', value: more.assigned_to }, { column: 'invoice_status', op: 'eq', value: more.invoice_status },
      { column: 'delivery_status', op: 'eq', value: more.delivery_status },
      { column: 'category_ids', op: 'cs', value: more.category_id ? [more.category_id] : [] },
      { column: 'downloaded_at', op: 'gte', value: more.from ? `${more.from}T00:00:00+02:00` : '' },
      { column: 'downloaded_at', op: 'lte', value: more.to ? `${more.to}T23:59:59+02:00` : '' });
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key, debouncedCols, more]);

  const filterKey = JSON.stringify(filters);
  useEffect(() => setPage(0), [filterKey, pageSize]);

  const q = useQuery({
    queryKey: ['work-orders', 'list', filterKey, sort, page, pageSize],
    placeholderData: keepPreviousData,
    queryFn: () => fetchList<ListRow>('v_work_order_list', { page, pageSize, sort, filters }),
  });
  const total = q.data?.count ?? 0;
  const rows = q.data?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  const toggleSort = (column: string) => setSort((s) => (s.column === column ? { column, desc: !s.desc } : { column, desc: false }));
  const switchTab = (key: string) => {
    setParams({ tab: key }); setColFilters({}); setPage(0);
    setSort(TABS.find((t) => t.key === key)?.sort ?? { column: 'downloaded_at', desc: true });
  };

  const exportRows = async () => {
    setExporting(true);
    try {
      const data = await fetchForExport<ListRow>('v_work_order_list', { sort, filters });
      downloadCsv(data, [
        ...columns.map((c) => ({ header: c.label, value: (r: ListRow) => { const v = c.render(r); return typeof v === 'string' || typeof v === 'number' ? v : ''; } })),
        { header: 'Status', value: (r: ListRow) => labelize(r.status) },
      ], `work-orders-${tab.key}`);
      toast.success(`Exported ${data.length} work orders`);
    } catch (e) { toast.error((e as Error).message); } finally { setExporting(false); }
  };

  return (
    <div>
      <PageHeader title="Work Orders" crumbs={[{ label: 'Work Orders' }]}
        actions={<>
          <Button variant="outline" onClick={() => setShowMore((s) => !s)} aria-expanded={showMore}><SlidersHorizontal /> More filters</Button>
          {can('data.export') && <Button variant="outline" loading={exporting} onClick={() => void exportRows()}><Download /> Export</Button>}
          {can('work_orders.import') && <Button variant="outline" asChild><Link to="/work-orders/import"><Upload /> Import</Link></Button>}
          {can('work_orders.create') && <Button asChild><Link to="/work-orders/new"><Plus /> New work order</Link></Button>}
        </>} />

      {showMore && (
        <div className="mb-4 grid gap-2 rounded-md border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <Select aria-label="Device type" value={more.category_id ?? ''} onChange={(e) => setMore({ ...more, category_id: e.target.value })} placeholder="All device types" options={opts(categories, (c) => c.name)} />
          <Select aria-label="District" value={more.district_id ?? ''} onChange={(e) => setMore({ ...more, district_id: e.target.value })} placeholder="All districts" options={opts(districts, (d) => d.name)} />
          <Select aria-label="Warehouse" value={more.warehouse_id ?? ''} onChange={(e) => setMore({ ...more, warehouse_id: e.target.value })} placeholder="All warehouses" options={opts(warehouses, (w) => w.code)} />
          <Select aria-label="Assigned user" value={more.assigned_to ?? ''} onChange={(e) => setMore({ ...more, assigned_to: e.target.value })} placeholder="Any assignee" options={opts(users, (u) => u.full_name)} />
          <Select aria-label="Invoice status" value={more.invoice_status ?? ''} onChange={(e) => setMore({ ...more, invoice_status: e.target.value })} placeholder="Any invoice status"
            options={['not_required', 'not_invoiced', 'draft', 'partially_invoiced', 'invoiced'].map((s) => ({ value: s, label: labelize(s) }))} />
          <Select aria-label="Dispatch status" value={more.delivery_status ?? ''} onChange={(e) => setMore({ ...more, delivery_status: e.target.value })} placeholder="Any dispatch status"
            options={['not_dispatched', 'in_transit', 'partially_delivered', 'delivered'].map((s) => ({ value: s, label: labelize(s) }))} />
          <Input type="date" aria-label="Downloaded from" value={more.from ?? ''} onChange={(e) => setMore({ ...more, from: e.target.value })} />
          <Input type="date" aria-label="Downloaded to" value={more.to ?? ''} onChange={(e) => setMore({ ...more, to: e.target.value })} />
        </div>
      )}

      <div role="tablist" aria-label="Work order stage" className="flex overflow-x-auto border-b border-slate-300 bg-slate-100">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === tab.key} onClick={() => switchTab(t.key)}
            className={cn('-mb-px whitespace-nowrap border border-transparent px-4 py-2.5 text-[15px] font-semibold',
              t.key === tab.key ? 'rounded-t border-slate-300 border-b-white bg-white text-primary' : 'text-slate-400 hover:text-slate-600')}>
            {t.label}
          </button>
        ))}
      </div>

      <section role="tabpanel" aria-label={tab.label} className="bg-white px-3 pb-4 pt-4 text-[13px] text-slate-900">
        <p className="mb-4 text-[15px]">{tab.description}</p>

        <div className="mb-3 grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
          <p className="text-sm" aria-live="polite">{q.isFetching && !q.data ? 'Loading…' : `Showing ${from} to ${to} of ${total}`}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Pagination page={page} pageCount={pageCount} onPage={setPage} />
            <select aria-label="Rows per page" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-9 rounded border border-slate-300 bg-white px-3 pr-8 text-sm">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div />
        </div>

        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse">
              <thead>
                <tr className="border-b-2 border-slate-800">
                  {columns.map((c) => {
                    const sorted = sort.column === c.sort;
                    return (
                      <th key={c.key} scope="col" className="border-l border-slate-200 px-2 py-2 text-left align-bottom font-semibold first:border-l-0"
                        aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                        <div className="flex items-end gap-1">
                          {c.sort ? (
                            <button type="button" onClick={() => toggleSort(c.sort!)} className="flex flex-1 items-end justify-between gap-1 text-left">
                              <span>{c.label}</span>
                              {sorted ? (sort.desc ? <ArrowDown className="h-3.5 w-3.5 shrink-0 text-slate-700" /> : <ArrowUp className="h-3.5 w-3.5 shrink-0 text-slate-700" />)
                                : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                            </button>
                          ) : <span className="flex-1">{c.label}</span>}
                          {c.filter && (
                            <span className="ml-1 border-l border-slate-200 pl-1">
                              <ColumnFilterButton label={c.label} kind={c.filter} value={colFilters[c.key] ?? ''} onChange={(v) => setColFilters((s) => ({ ...s, [c.key]: v }))} />
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                  <th scope="col" className="border-l border-slate-200 px-2 py-2 text-left align-bottom font-semibold">{tab.actionLabel ?? 'Actions'}</th>
                </tr>
              </thead>
              <tbody className={cn(q.isFetching && 'opacity-70')}>
                {q.isLoading ? Array.from({ length: pageSize > 10 ? 10 : pageSize }).map((_, i) => (
                  <tr key={i} className="odd:bg-slate-100"><td colSpan={columns.length + 1} className="px-2 py-3"><div className="h-3 w-full animate-pulse rounded bg-slate-200" /></td></tr>
                )) : rows.length === 0 ? (
                  <tr><td colSpan={columns.length + 1} className="px-2 py-10 text-center text-muted-foreground">No work orders found.</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-200 align-top odd:bg-slate-100">
                    {columns.map((c) => <td key={c.key} className="px-2 py-3">{c.render(r)}</td>)}
                    <td className="px-2 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Link to={`/work-orders/${r.id}`} aria-label={`Open ${r.wo_number}`} title="View work order" className="inline-flex rounded p-1 text-primary hover:bg-primary/10">
                          <ClipboardList className="h-6 w-6" />
                        </Link>
                        {tab.key === 'issued' && <IssuedRowActions row={r} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && (
          <div className="mt-3 grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
            <p className="text-sm">{`Showing ${from} to ${to} of ${total}`}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Pagination page={page} pageCount={pageCount} onPage={setPage} />
              <select aria-label="Rows per page" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
                className="h-9 rounded border border-slate-300 bg-white px-3 pr-8 text-sm">
                {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div />
          </div>
        )}
      </section>
    </div>
  );
}
