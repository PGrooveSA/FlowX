import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAll, fetchList, fetchOne, type Filter } from '@/lib/api';
import { cn, formatDateNumeric, labelize, TIMEZONE } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, useDebounce } from '@/components/common';
import { GridHeaderCell, PagerBar, type GridColumn } from '@/components/data-table/ListControls';

interface Header {
  id: string; wo_number: string; emis_number: string; institution_name: string; province_code: string; created_at: string;
  recipient_type: string; work_order_type_name: string; status: string; priority: string; scheduled_date: string | null;
  first_dispatched_at: string | null; description: string | null; device_count: number; dispatch_numbers: string | null;
}
interface Line { id: string; line_no: number; device_categories: { name: string }; device_models: { model_code: string; model_name: string } | null }
interface Package { id: string; package_id: string; recipient_name: string | null; grade: string | null; classroom: string | null; created_at: string }

const RECIPIENT_PLURAL: Record<string, string> = { learner: 'Learners', teacher: 'Teachers', school: 'the School', department: 'the Department', other: 'Recipients' };

/** yyyy/mm/dd in the configured timezone (the reference shows dispatch dates this way). */
const isoSlash = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-CA', { timeZone: TIMEZONE }).replace(/-/g, '/') : '');

function Fact({ label, value, bold = true }: { label: string; value: React.ReactNode; bold?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_1.9fr] items-start gap-4 py-1">
      <dt>{label}</dt>
      <dd className={cn(bold && 'font-semibold')}>{value}</dd>
    </div>
  );
}

/** Read-only work order view with the list of packages (one per allocated device). */
export function WorkOrderViewPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState({ column: 'package_id', desc: false });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const debounced = useDebounce(colFilters, 250);

  const header = useQuery({
    queryKey: ['wo-view', id, 'header'],
    queryFn: async () => {
      const [wo, extra, lines, dispatches] = await Promise.all([
        fetchOne<Header>('v_work_order_list', 'id', id),
        fetchOne<{ device_to_use: string | null; purpose: string | null; work_order_name: string | null }>('work_orders', 'id', id, 'device_to_use, purpose, work_order_name'),
        fetchAll<Line>('work_order_lines', 'id, line_no, device_categories(name), device_models(model_code, model_name)', (q) => q.eq('work_order_id', id).order('line_no')),
        fetchAll<{ id: string }>('dispatches', 'id', (q) => q.eq('work_order_id', id).neq('status', 'cancelled').neq('status', 'draft')),
      ]);
      return wo ? { wo, extra, lines, shipments: dispatches.length } : null;
    },
  });

  const columns: GridColumn<Package>[] = [
    { key: 'package_id', label: 'Package Id', sort: 'package_id', filter: { type: 'text', column: 'package_id' }, render: (r) => r.package_id },
    { key: 'recipient_name', label: 'Recipient Name & Surname', sort: 'recipient_name', filter: { type: 'text', column: 'recipient_name' }, render: (r) => (r.recipient_name ?? '').toUpperCase() },
    { key: 'grade', label: 'Grade', sort: 'grade', filter: { type: 'text', column: 'grade' }, render: (r) => r.grade ?? '' },
    { key: 'classroom', label: 'Classroom', sort: 'classroom', filter: { type: 'text', column: 'classroom' }, render: (r) => r.classroom ?? '' },
    { key: 'created_at', label: 'Created Date', sort: 'created_at', filter: { type: 'date', column: 'created_at' }, render: (r) => formatDateNumeric(r.created_at) },
  ];

  const filters = useMemo<Filter[]>(() => {
    const f: Filter[] = [{ column: 'work_order_id', op: 'eq', value: id }];
    for (const c of columns) {
      const v = debounced[c.key];
      if (!v || !c.filter) continue;
      if (c.filter.type === 'date') f.push({ column: c.filter.column, op: 'gte', value: `${v}T00:00:00+02:00` }, { column: c.filter.column, op: 'lte', value: `${v}T23:59:59+02:00` });
      else f.push({ column: c.filter.column, op: 'ilike', value: v });
    }
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, debounced]);
  const filterKey = JSON.stringify(filters);
  useEffect(() => setPage(0), [filterKey, pageSize]);

  const grid = useQuery({
    queryKey: ['wo-view', id, 'packages', filterKey, sort, page, pageSize],
    placeholderData: keepPreviousData,
    queryFn: () => fetchList<Package>('v_work_order_packages', { page, pageSize, sort, filters }),
  });

  if (header.isLoading) return <LoadingState />;
  if (header.error || !header.data) return <ErrorState error={header.error ?? new Error('Work order not found or outside your scope')} />;
  const { wo, extra, lines, shipments } = header.data;
  // Dispatch dates apply once a work order has been scheduled; earlier stages return to their own tab.
  const scheduled = !['draft', 'pending_authorisation', 'returned_for_correction', 'approved', 'pending_scheduling', 'cancelled'].includes(wo.status);
  const listTab = ['approved', 'pending_scheduling'].includes(wo.status) ? 'pending_scheduling' : 'dispatched';
  const backToList = () => nav(`/work-orders?tab=${listTab}`);
  const rows = grid.data?.rows ?? [];
  const total = grid.data?.count ?? 0;

  return (
    <div className="-mx-3 -my-4 min-h-full bg-slate-50 px-6 py-3 text-[13px] text-slate-900 sm:-mx-6 sm:-my-6">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-6 rounded-sm border-slate-800 px-2 text-xs text-primary" onClick={backToList}>&lt;Back to List</Button>
        <Link to={`/work-orders?tab=${listTab}`} className="text-sm text-primary hover:underline">Work Orders</Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 pb-3">
        <h1 className="text-xl font-semibold">Work Orders <span aria-hidden>▸</span> View Work Order {wo.wo_number}</h1>
        <Button variant="outline" onClick={() => void qc.invalidateQueries({ queryKey: ['wo-view', id] })}>Refresh grid</Button>
      </div>

      <div className="grid gap-x-12 py-5 lg:grid-cols-2">
        <dl>
          <Fact label="EMIS" value={wo.emis_number} />
          <Fact label="Institution Name" value={`${wo.province_code} - ${wo.institution_name.toUpperCase()}`} />
          <Fact label="Year" value={new Date(wo.created_at).toLocaleDateString('en-ZA', { timeZone: TIMEZONE, year: 'numeric' })} />
          <Fact label="Recipient Type" value={labelize(wo.recipient_type)} />
          <Fact label="Work Order Type" value={wo.work_order_type_name} />
          <Fact label="Status" value={labelize(wo.status)} />
          <Fact label="Scheduling Priority" value={labelize(wo.priority)} />
          {scheduled && <>
            <Fact label="Expected Dispatch/Install Date" value={wo.scheduled_date ? isoSlash(wo.scheduled_date) : 'Not set'} bold={false} />
            <Fact label="Actual Dispatch/Install Date" value={wo.first_dispatched_at ? isoSlash(wo.first_dispatched_at) : 'Not set'} bold={false} />
          </>}
        </dl>
        <dl>
          <Fact label="Work Order Name" value={extra?.work_order_name ?? `${wo.work_order_type_name} for ${RECIPIENT_PLURAL[wo.recipient_type] ?? 'Recipients'} at EMIS ${wo.emis_number}`} />
          <Fact label="Description" value={wo.description ?? ''} />
          <Fact label="Device To Use" value={extra?.device_to_use ? labelize(extra.device_to_use) : 'Not Selected'} />
          <Fact label="Purpose of Work Order" value={extra?.purpose ? labelize(extra.purpose) : 'Not Selected'} />
          <div className="grid grid-cols-[1fr_1.9fr] items-start gap-4 py-1">
            <dt>Device Type / Brand / Category</dt>
            <dd>
              <table className="w-full border border-slate-300 bg-slate-200/70 font-semibold">
                <tbody>{lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-300 last:border-b-0">
                    <td className="w-28 border-r border-slate-300 px-2 py-1.5">{l.device_categories.name}</td>
                    <td className="px-2 py-1.5">{l.device_models ? `${l.device_models.model_code} - ${l.device_models.model_name}` : `Any ${l.device_categories.name}`}</td>
                  </tr>
                ))}</tbody>
              </table>
            </dd>
          </div>
          <Fact label="Number of Devices" value={wo.device_count} />
          <Fact label="Split Work Order" value={shipments > 1 ? `Split (${shipments} shipments)` : 'No Split'} />
        </dl>
      </div>

      <div className="flex justify-end pb-3">
        <Button variant="outline" size="sm" className="h-7 rounded-sm border-primary text-xs text-primary" onClick={backToList}>Back To List</Button>
      </div>

      <p className="mb-4">This is a list of Packages currently in this Work Order.</p>
      <PagerBar className="mb-3" page={page} pageSize={pageSize} total={total} loading={grid.isFetching && !grid.data} onPage={setPage} onPageSize={setPageSize} />
      {grid.error ? <ErrorState error={grid.error} onRetry={() => void grid.refetch()} /> : (
        <div className="overflow-x-auto bg-white">
          <table className="w-full min-w-[800px] border-collapse">
            <thead>
              <tr className="border-b border-slate-300 bg-slate-50">
                {columns.map((c) => (
                  <GridHeaderCell key={c.key} column={c} sort={sort} onSort={(col) => setSort((s) => (s.column === col ? { column: col, desc: !s.desc } : { column: col, desc: false }))}
                    filterValue={colFilters[c.key] ?? ''} onFilter={(v) => setColFilters((s) => ({ ...s, [c.key]: v }))} />
                ))}
              </tr>
            </thead>
            <tbody className={cn(grid.isFetching && 'opacity-70')}>
              {grid.isLoading ? (
                <tr><td colSpan={columns.length} className="px-2 py-6"><div className="h-3 w-full animate-pulse rounded bg-slate-200" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-2 py-10 text-center text-muted-foreground">No packages in this work order.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-200 odd:bg-slate-100">
                  {columns.map((c) => <td key={c.key} className="border-l border-slate-200 px-2 py-1.5 first:border-l-0">{c.render(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && <PagerBar className="mt-3" page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />}
    </div>
  );
}
