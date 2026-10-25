import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreVertical } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchForExport, fetchList, fetchOne, rpc, type Filter } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { cn, labelize, TIMEZONE } from '@/lib/utils';
import { DEVICE_STATUSES } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { ErrorState, LoadingState, useDebounce } from '@/components/common';
import { GridHeaderCell, PagerBar, type GridColumn } from '@/components/data-table/ListControls';

interface Header {
  id: string; wo_number: string; work_order_type_name: string; description: string | null; emis_number: string; created_at: string;
  category_names: string | null; priority: string; device_count: number; province_code: string; institution_name: string; status: string;
  device_to_use?: string; purpose?: string; institution_id: string;
}
interface Allocation {
  id: string; device_id: string; allocation_status: string; shift_number: number; location_code: string | null; serial_number: string | null;
  device_type: string; asset_tag: string; device_name: string; service_provider: string | null; current_phase: string;
  previous_asset_tag: string | null; previous_device_name: string | null; box_number: string | null; scan_status: string; scanned: boolean;
  recipient_id: string | null; recipient_name: string | null;
}

const SCAN_FILTERS = [
  { value: '', label: 'All' },
  { value: 'scanned', label: 'Scanned' },
  { value: 'not_scanned', label: 'Not Scanned' },
  { value: 'pending_boxing', label: 'Pending Boxing' },
  { value: 'boxed', label: 'Boxed' },
];
const ALLOCATION_STATUSES = ['reserved', 'picked', 'issued', 'dispatched', 'delivered'];

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="font-semibold">{label}</dt>
      <dd className="mt-0.5">{value ?? ''}</dd>
    </div>
  );
}

/** Work Order Details: header facts, scan summary and the per-device allocation grid. */
export function WorkOrderDetailsPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [scanFilter, setScanFilter] = useState('');
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState({ column: 'shift_number', desc: false });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [boxing, setBoxing] = useState<{ ids: string[]; clear?: boolean } | null>(null);
  const [assigning, setAssigning] = useState<Allocation | null>(null);
  const [exporting, setExporting] = useState(false);
  const debounced = useDebounce(colFilters, 250);

  const header = useQuery({
    queryKey: ['wo-details', id, 'header'],
    queryFn: async () => {
      const [wo, extra] = await Promise.all([
        fetchOne<Header>('v_work_order_list', 'id', id),
        fetchOne<{ device_to_use: string; purpose: string }>('work_orders', 'id', id, 'device_to_use, purpose'),
      ]);
      return wo ? { ...wo, ...extra } : null;
    },
  });
  const summary = useQuery({
    queryKey: ['wo-details', id, 'summary'],
    queryFn: () => fetchAll<{ id: string; scan_status: string; scanned: boolean }>('v_work_order_allocations', 'id, scan_status, scanned', (q) => q.eq('work_order_id', id)),
  });

  const columns: GridColumn<Allocation>[] = [
    { key: 'shift_number', label: 'Shift Number', sort: 'shift_number', filter: { type: 'number', column: 'shift_number' }, render: (r) => r.shift_number },
    { key: 'allocation_status', label: 'Shift Status', sort: 'allocation_status', filter: { type: 'select', column: 'allocation_status', options: ALLOCATION_STATUSES.map((s) => ({ value: s, label: labelize(s) })) }, render: (r) => labelize(r.allocation_status) },
    { key: 'location_code', label: 'Location', sort: 'location_code', filter: { type: 'text', column: 'location_code' }, render: (r) => r.location_code ?? '' },
    { key: 'serial_number', label: 'e-Package Number', sort: 'serial_number', filter: { type: 'text', column: 'serial_number' }, render: (r) => r.serial_number ?? '' },
    { key: 'device_type', label: 'Device Type', sort: 'device_type', filter: { type: 'text', column: 'device_type' }, render: (r) => r.device_type },
    { key: 'asset_tag', label: 'Asset Tag Number', sort: 'asset_tag', filter: { type: 'text', column: 'asset_tag' }, render: (r) => r.asset_tag },
    { key: 'device_name', label: 'Device Name', sort: 'device_name', filter: { type: 'text', column: 'device_name' }, render: (r) => r.device_name },
    { key: 'service_provider', label: 'Service Provider', sort: 'service_provider', filter: { type: 'text', column: 'service_provider' }, render: (r) => r.service_provider ?? '' },
    { key: 'current_phase', label: 'Current Phase', sort: 'current_phase', filter: { type: 'select', column: 'current_phase', options: DEVICE_STATUSES.map((s) => ({ value: s, label: labelize(s) })) }, render: (r) => labelize(r.current_phase) },
    { key: 'previous_asset_tag', label: 'Previous Asset Tag', sort: 'previous_asset_tag', filter: { type: 'text', column: 'previous_asset_tag' }, render: (r) => r.previous_asset_tag ?? '' },
    { key: 'previous_device_name', label: 'Previous Device Name', sort: 'previous_device_name', filter: { type: 'text', column: 'previous_device_name' }, render: (r) => r.previous_device_name ?? '' },
    { key: 'box_number', label: 'Box Number', sort: 'box_number', filter: { type: 'text', column: 'box_number' }, render: (r) => r.box_number ?? '' },
  ];

  const filters = useMemo<Filter[]>(() => {
    const f: Filter[] = [{ column: 'work_order_id', op: 'eq', value: id }];
    if (scanFilter === 'scanned') f.push({ column: 'scanned', op: 'eq', value: true });
    else if (scanFilter) f.push({ column: 'scan_status', op: 'eq', value: scanFilter });
    for (const c of columns) {
      const v = debounced[c.key];
      if (!v || !c.filter) continue;
      if (c.filter.type === 'text') f.push({ column: c.filter.column, op: 'ilike', value: v });
      else if (c.filter.type === 'number') f.push({ column: c.filter.column, op: 'eq', value: Number(v) });
      else f.push({ column: c.filter.column, op: 'eq', value: v });
    }
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scanFilter, debounced]);
  const filterKey = JSON.stringify(filters);
  useEffect(() => setPage(0), [filterKey, pageSize]);

  const grid = useQuery({
    queryKey: ['wo-details', id, 'grid', filterKey, sort, page, pageSize],
    placeholderData: keepPreviousData,
    queryFn: () => fetchList<Allocation>('v_work_order_allocations', { page, pageSize, sort, filters }),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['wo-details', id] });
  const exportGrid = async () => {
    setExporting(true);
    try {
      const rows = await fetchForExport<Allocation>('v_work_order_allocations', { sort, filters });
      downloadCsv(rows, columns.map((c) => ({ header: c.label, value: (r: Allocation) => { const v = c.render(r); return typeof v === 'string' || typeof v === 'number' ? v : ''; } })),
        `${header.data?.wo_number ?? 'work-order'}-devices`);
      toast.success(`Exported ${rows.length} devices`);
    } catch (e) { toast.error((e as Error).message); } finally { setExporting(false); }
  };

  if (header.isLoading) return <LoadingState />;
  if (header.error || !header.data) return <ErrorState error={header.error ?? new Error('Work order not found or outside your scope')} />;
  const wo = header.data;
  const counts = summary.data ?? [];
  const scanned = counts.filter((r) => r.scanned).length;
  const pendingBoxing = counts.filter((r) => r.scan_status === 'pending_boxing');
  const boxed = counts.filter((r) => r.scan_status === 'boxed').length;
  const year = new Date(wo.created_at).toLocaleDateString('en-ZA', { timeZone: TIMEZONE, year: 'numeric' });
  const rows = grid.data?.rows ?? [];

  return (
    <div className="-mx-3 -my-4 min-h-full bg-slate-50 px-6 py-3 text-[13px] text-slate-900 sm:-mx-6 sm:-my-6">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-6 rounded-sm border-slate-800 px-2 text-xs text-primary" onClick={() => nav('/work-orders?tab=issued')}>&lt;Back to List</Button>
        <Link to="/work-orders?tab=issued" className="text-sm text-primary hover:underline">Work Orders</Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 pb-3">
        <h1 className="text-2xl font-normal">Work Order Details <span aria-hidden className="text-lg">▸</span> {wo.province_code} - {wo.institution_name.toUpperCase()}</h1>
        <div className="flex gap-1">
          <Button variant="outline" onClick={refresh}>Refresh grid</Button>
          <Button onClick={() => void exportGrid()} loading={exporting}>Export</Button>
        </div>
      </div>

      <div className="grid gap-6 py-5 lg:grid-cols-[1fr_360px]">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-5 text-sm sm:grid-cols-3">
          <div className="space-y-5">
            <Info label="Work Order Number" value={wo.wo_number} />
            <Info label="EMIS" value={wo.emis_number} />
            <Info label="Scheduling Priority" value={labelize(wo.priority)} />
            <Info label="Purpose of Work Order" value={labelize(wo.purpose)} />
          </div>
          <div className="space-y-5">
            <Info label="Work Order Type" value={wo.work_order_type_name} />
            <Info label="Year" value={year} />
            <Info label="Number of Devices" value={wo.device_count} />
          </div>
          <div className="space-y-5">
            <Info label="Description" value={wo.description} />
            <Info label="Device Types" value={(wo.category_names ?? '').replace(/, /g, ',')} />
            <Info label="Device to Use" value={labelize(wo.device_to_use)} />
          </div>
        </dl>
        <div className="space-y-6 lg:pt-8">
          <section className="rounded border border-slate-300 bg-white" aria-label="Scan Summary">
            <h2 className="border-b border-slate-300 py-3 text-center text-sm font-semibold">Scan Summary</h2>
            <dl className="space-y-2 px-9 py-4 text-sm">
              {([['Scanned', scanned], ['Pending Boxing', pendingBoxing.length], ['Boxed', boxed]] as [string, number][]).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[1fr_80px]"><dt className="font-semibold">{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
            {pendingBoxing.length > 0 && can('issuing.pick') && (
              <div className="border-t border-slate-200 px-9 py-2">
                <Button size="sm" variant="outline" onClick={() => setBoxing({ ids: pendingBoxing.map((r) => r.id) })}>Box all pending devices</Button>
              </div>
            )}
          </section>
          <div className="flex items-center justify-end gap-4">
            <label htmlFor="scan-status-filter" className="text-sm font-semibold">Scan Status Filter:</label>
            <select id="scan-status-filter" value={scanFilter} onChange={(e) => setScanFilter(e.target.value)}
              className="h-9 w-[355px] max-w-full rounded border border-slate-300 bg-white px-8 text-sm text-primary">
              {SCAN_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-300 pt-5">
        <PagerBar className="mb-3" page={page} pageSize={pageSize} total={grid.data?.count ?? 0} loading={grid.isFetching && !grid.data} onPage={setPage} onPageSize={setPageSize} />
        {grid.error ? <ErrorState error={grid.error} onRetry={() => void grid.refetch()} /> : (
          <div className="overflow-x-auto bg-white">
            <table className="w-full min-w-[1400px] border-collapse">
              <thead>
                <tr className="border-b-2 border-slate-800">
                  {columns.map((c) => (
                    <GridHeaderCell key={c.key} column={c} sort={sort} onSort={(col) => setSort((s) => (s.column === col ? { column: col, desc: !s.desc } : { column: col, desc: false }))}
                      filterValue={colFilters[c.key] ?? ''} onFilter={(v) => setColFilters((s) => ({ ...s, [c.key]: v }))} />
                  ))}
                  <th scope="col" className="border-l border-slate-200 px-2 py-2 text-left align-bottom font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className={cn(grid.isFetching && 'opacity-70')}>
                {grid.isLoading ? (
                  <tr><td colSpan={columns.length + 1} className="px-2 py-6"><div className="h-3 w-full animate-pulse rounded bg-slate-200" /></td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={columns.length + 1} className="px-2 py-10 text-center text-muted-foreground">No devices allocated to this work order yet.</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-200 odd:bg-slate-100">
                    {columns.map((c) => <td key={c.key} className="border-l border-slate-200 px-2 py-2 first:border-l-0">{c.render(r)}</td>)}
                    <td className="border-l border-slate-200 px-2 py-1 text-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" aria-label={`Actions for ${r.serial_number ?? r.asset_tag}`} className="inline-flex rounded p-1 text-primary hover:bg-primary/10"><MoreVertical className="h-4 w-4" /></button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => nav(`/devices/${r.device_id}`)}>View device</DropdownMenuItem>
                          {can('issuing.pick') && ['picked', 'issued'].includes(r.allocation_status) && (
                            <DropdownMenuItem onSelect={() => setBoxing({ ids: [r.id] })}>{r.box_number ? 'Change box' : 'Assign box'}</DropdownMenuItem>
                          )}
                          {can('issuing.pick') && r.box_number && ['picked', 'issued'].includes(r.allocation_status) && (
                            <DropdownMenuItem onSelect={() => setBoxing({ ids: [r.id], clear: true })}>Remove from box</DropdownMenuItem>
                          )}
                          {can('recipients.manage') || can('issuing.pick') ? (
                            <DropdownMenuItem onSelect={() => setAssigning(r)}>{r.recipient_name ? `Change recipient (${r.recipient_name})` : 'Assign recipient'}</DropdownMenuItem>
                          ) : null}
                          {can('issuing.pick') && r.allocation_status === 'reserved' && (
                            <DropdownMenuItem onSelect={() => nav(`/issuing/${id}`)}>Scan in issuing workspace</DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && <PagerBar className="mt-3" page={page} pageSize={pageSize} total={grid.data?.count ?? 0} onPage={setPage} onPageSize={setPageSize} />}
      </div>

      {boxing && <BoxDialog workOrderId={wo.id} ids={boxing.ids} clear={boxing.clear} onClose={() => setBoxing(null)} onDone={refresh} />}
      {assigning && <RecipientDialog institutionId={wo.institution_id} allocation={assigning} onClose={() => setAssigning(null)} onDone={refresh} />}
    </div>
  );
}

function BoxDialog({ workOrderId, ids, clear, onClose, onDone }: { workOrderId: string; ids: string[]; clear?: boolean; onClose: () => void; onDone: () => void }) {
  const [box, setBox] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const n = await rpc<number>('assign_box', { p_work_order_id: workOrderId, p_allocation_ids: ids, p_box_number: clear ? null : box.trim() });
      toast.success(clear ? 'Removed from box' : `${n} device(s) placed in box ${box.trim()}`);
      onDone(); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={clear ? 'Remove from box' : `Assign box (${ids.length} device${ids.length === 1 ? '' : 's'})`}
          description={clear ? 'The device returns to Pending Boxing.' : 'Only devices verified by a serial scan can be boxed.'} />
        {!clear && <Field label="Box number" htmlFor="box-no" required><Input id="box-no" autoFocus value={box} onChange={(e) => setBox(e.target.value)} maxLength={40} /></Field>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!clear && !box.trim()} onClick={() => void submit()}>{clear ? 'Remove' : 'Assign box'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Names the recipient (e.g. learner) receiving one package; learners are listed only for authorised users. */
function RecipientDialog({ institutionId, allocation, onClose, onDone }: { institutionId: string; allocation: Allocation; onClose: () => void; onDone: () => void }) {
  const [recipient, setRecipient] = useState(allocation.recipient_id ?? '');
  const [busy, setBusy] = useState(false);
  const recipients = useQuery({
    queryKey: ['recipients', institutionId, 'active'],
    queryFn: () => fetchAll<{ id: string; full_name: string; recipient_type: string; grade: string | null; class_name: string | null }>('recipients',
      'id, full_name, recipient_type, grade, class_name', (q) => q.eq('institution_id', institutionId).eq('is_active', true).order('full_name')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Recipient for ${allocation.serial_number ?? allocation.asset_tag}`}
          description="The package is listed under this person on the View Work Order page. Leave empty to use the work order's recipient." />
        <Field label="Recipient" htmlFor="pkg-recipient">
          <Select id="pkg-recipient" placeholder="Work order recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)}
            options={(recipients.data ?? []).map((r) => ({ value: r.id, label: `${r.full_name} (${labelize(r.recipient_type)}${r.grade ? `, Grade ${r.grade}${r.class_name ? ` ${r.class_name}` : ''}` : ''})` }))} />
        </Field>
        {recipients.data && recipients.data.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No recipients you can see are registered for this institution. Add them on the institution's page.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={async () => {
            setBusy(true);
            try { await rpc('assign_allocation_recipient', { p_allocation_id: allocation.id, p_recipient_id: recipient || null }); toast.success('Recipient saved'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}