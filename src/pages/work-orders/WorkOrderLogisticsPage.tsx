import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { fetchAll, fetchOne } from '@/lib/api';
import { cn, labelize } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { GridHeaderCell, PagerBar, type GridColumn } from '@/components/data-table/ListControls';

// Box labels are available while a work order is in the Issued or Completed tab.
const LABEL_STATUSES = ['scheduled', 'scheduled_pending_issuing', 'issuing_in_progress', 'issued', 'pending_invoicing', 'invoiced', 'ready_for_dispatch'];

interface Box { box_number: string; device_count: number }
interface Found { id: string; wo_number: string; status: string }

/** Work Orders ▸ Logistics: look up a work order's boxes and print their labels. */
export function WorkOrderLogisticsPage() {
  const nav = useNavigate();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState({ column: 'box_number', desc: false });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const backToList = () => (window.history.length > 1 ? nav(-1) : nav('/work-orders'));

  const getBoxes = async () => {
    const wo = number.trim().toUpperCase();
    setMessage(null); setFound(null); setBoxes(null); setPage(0);
    if (!wo) { setMessage('Enter a work order number.'); return; }
    setBusy(true);
    try {
      const row = await fetchOne<Found>('work_orders', 'wo_number', wo, 'id, wo_number, status');
      if (!row) { setMessage(`Work order ${wo} was not found, or it is outside your scope.`); return; }
      if (!LABEL_STATUSES.includes(row.status)) {
        setMessage(`Work order ${row.wo_number} is "${labelize(row.status)}". Box labels can be generated for work orders in the Issued or Completed status.`);
        return;
      }
      const devices = await fetchAll<{ box_number: string }>('v_work_order_allocations', 'box_number', (q) => q.eq('work_order_id', row.id).not('box_number', 'is', null));
      const counts = new Map<string, number>();
      for (const d of devices) counts.set(d.box_number, (counts.get(d.box_number) ?? 0) + 1);
      setFound(row);
      setBoxes([...counts].map(([box_number, device_count]) => ({ box_number, device_count })));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const printLabels = (box?: string) => {
    if (!found) return;
    window.open(`/print/box-labels?wo=${found.id}${box ? `&box=${encodeURIComponent(box)}` : ''}`, '_blank', 'noopener');
  };

  const columns: GridColumn<Box>[] = [
    { key: 'box_number', label: 'Box Number', sort: 'box_number', filter: { type: 'text', column: 'box_number' }, render: (r) => r.box_number },
    { key: 'device_count', label: 'No. of Devices', sort: 'device_count', filter: { type: 'number', column: 'device_count' }, render: (r) => r.device_count },
  ];

  const visible = useMemo(() => {
    let rows = [...(boxes ?? [])];
    if (colFilters.box_number) rows = rows.filter((r) => r.box_number.toLowerCase().includes(colFilters.box_number.toLowerCase()));
    if (colFilters.device_count) rows = rows.filter((r) => r.device_count === Number(colFilters.device_count));
    rows.sort((a, b) => {
      const v = sort.column === 'device_count' ? a.device_count - b.device_count : a.box_number.localeCompare(b.box_number, undefined, { numeric: true });
      return sort.desc ? -v : v;
    });
    return rows;
  }, [boxes, colFilters, sort]);
  const pageRows = visible.slice(page * pageSize, (page + 1) * pageSize);
  const resultBar = boxes && visible.length > 0
    ? <PagerBar page={page} pageSize={pageSize} total={visible.length} onPage={setPage} onPageSize={setPageSize} />
    : <p className="text-sm">No results</p>;

  return (
    <div className="-mx-3 -my-4 min-h-full bg-slate-50 px-6 py-3 text-[13px] text-slate-900 sm:-mx-6 sm:-my-6">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-6 rounded-sm border-slate-800 px-2 text-xs text-primary" onClick={backToList}>&lt;Back to List</Button>
        <Link to="/work-orders" className="text-sm text-primary hover:underline">Work Orders</Link>
      </div>
      <h1 className="border-b border-slate-300 pb-4 text-xl font-semibold">Work Orders <span aria-hidden>▸</span> Logistics</h1>

      <form className="mt-6 grid gap-2 sm:grid-cols-[180px_minmax(0,440px)_auto] sm:items-start" onSubmit={(e) => { e.preventDefault(); void getBoxes(); }}>
        <label htmlFor="logistics-wo" className="pt-2">Work Order Number:</label>
        <div>
          <input id="logistics-wo" value={number} onChange={(e) => setNumber(e.target.value)} autoComplete="off"
            className="h-9 w-full rounded border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <p className="mt-1 text-xs italic">Box labels can be generated for work orders in the Issued or Completed status.</p>
        </div>
        <Button type="submit" variant="outline" size="sm" loading={busy} className="h-8 rounded-sm border-primary text-xs text-primary">Get Boxes</Button>
      </form>

      {message && <p role="alert" className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}

      <div className="mt-8 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">{resultBar}</div>
          {found && boxes && boxes.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => printLabels()}><Printer /> Print all box labels ({found.wo_number})</Button>
          )}
        </div>
        <div className="overflow-x-auto bg-white">
          <table className="w-full min-w-[600px] border-collapse">
            <thead>
              <tr className="border-b border-slate-300 bg-slate-50">
                {columns.map((c) => (
                  <GridHeaderCell key={c.key} column={c} sort={sort} onSort={(col) => setSort((s) => (s.column === col ? { column: col, desc: !s.desc } : { column: col, desc: false }))}
                    filterValue={colFilters[c.key] ?? ''} onFilter={(v) => { setColFilters((s) => ({ ...s, [c.key]: v })); setPage(0); }} />
                ))}
                <th scope="col" className="border-l border-slate-200 px-2 py-2 text-left align-bottom font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {!boxes ? (
                <tr className="bg-slate-100"><td colSpan={3} className="px-2 py-2 text-center">Please search for a Work Order Number to view the Boxes</td></tr>
              ) : pageRows.length === 0 ? (
                <tr className="bg-slate-100"><td colSpan={3} className="px-2 py-2 text-center">
                  {boxes.length === 0 ? `No boxes have been packed for ${found?.wo_number} yet. Assign boxes on the Work Order Details page.` : 'No boxes match the filters.'}
                </td></tr>
              ) : pageRows.map((r) => (
                <tr key={r.box_number} className="border-b border-slate-200 odd:bg-slate-100">
                  <td className="px-2 py-1.5">{r.box_number}</td>
                  <td className="border-l border-slate-200 px-2 py-1.5">{r.device_count}</td>
                  <td className="border-l border-slate-200 px-2 py-1">
                    <button type="button" onClick={() => printLabels(r.box_number)} aria-label={`Print label for box ${r.box_number}`} title="Print box label"
                      className={cn('inline-flex rounded p-1 text-primary hover:bg-primary/10')}><Printer className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {resultBar}
        <div className="flex justify-end pt-4">
          <Button variant="outline" size="sm" className="h-7 rounded-sm border-primary text-xs text-primary" onClick={backToList}>Back To List</Button>
        </div>
      </div>
    </div>
  );
}
