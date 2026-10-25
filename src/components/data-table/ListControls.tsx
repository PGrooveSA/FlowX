// Controls shared by the reference-style list grids (Work Orders tabs, Work Order Details).
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Filter as FilterIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form-controls';

export type ColumnFilterKind = { type: 'text'; column: string } | { type: 'select'; column: string; options: { value: string; label: string }[]; op?: 'eq' | 'cs' }
  | { type: 'date'; column: string } | { type: 'number'; column: string };

/** Funnel button with a small popover holding one column filter. */
export function ColumnFilterButton({ label, kind, value, onChange }: { label: string; kind: ColumnFilterKind; value: string; onChange: (v: string) => void }) {
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

export function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
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

/** "Showing X to Y of Z" on the left, pager and rows-per-page centred. */
export function PagerBar({ page, pageSize, total, loading, onPage, onPageSize, className }: {
  page: number; pageSize: number; total: number; loading?: boolean; onPage: (p: number) => void; onPageSize: (n: number) => void; className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className={cn('grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_auto_1fr]', className)}>
      <p className="text-sm" aria-live="polite">{loading ? 'Loading…' : `Showing ${from} to ${to} of ${total}`}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Pagination page={page} pageCount={pageCount} onPage={onPage} />
        <select aria-label="Rows per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
          className="h-9 rounded border border-slate-300 bg-white px-3 pr-8 text-sm">
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div />
    </div>
  );
}

export interface GridColumn<T> { key: string; label: string; sort?: string; filter?: ColumnFilterKind; render: (r: T) => React.ReactNode }

/** Header cell: wrapped bold label, sort arrows, and a funnel separated by a divider. */
export function GridHeaderCell<T>({ column, sort, onSort, filterValue, onFilter }: {
  column: GridColumn<T>; sort: { column: string; desc: boolean }; onSort: (column: string) => void; filterValue: string; onFilter: (v: string) => void;
}) {
  const sorted = sort.column === column.sort;
  return (
    <th scope="col" className="border-l border-slate-200 px-2 py-2 text-left align-bottom font-semibold first:border-l-0"
      aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <div className="flex items-end gap-1">
        {column.sort ? (
          <button type="button" onClick={() => onSort(column.sort!)} className="flex flex-1 items-end justify-between gap-1 text-left">
            <span>{column.label}</span>
            {sorted ? (sort.desc ? <ArrowDown className="h-3.5 w-3.5 shrink-0 text-slate-700" /> : <ArrowUp className="h-3.5 w-3.5 shrink-0 text-slate-700" />)
              : <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
          </button>
        ) : <span className="flex-1">{column.label}</span>}
        {column.filter && (
          <span className="ml-1 border-l border-slate-200 pl-1">
            <ColumnFilterButton label={column.label} kind={column.filter} value={filterValue} onChange={onFilter} />
          </span>
        )}
      </div>
    </th>
  );
}
