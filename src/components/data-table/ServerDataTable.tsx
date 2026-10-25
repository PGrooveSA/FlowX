import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState, type VisibilityState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, Download } from 'lucide-react';
import { toast } from 'sonner';
import { fetchForExport, fetchList, type Filter } from '@/lib/api';
import { downloadCsv, downloadXlsx, type ExportColumn } from '@/lib/csv';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form-controls';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { EmptyState, ErrorState } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';

export interface ServerDataTableProps<T> {
  source: string;
  select?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  filters?: Filter[];
  search?: string;
  searchColumns?: string[];
  defaultSort?: { column: string; desc: boolean };
  queryKey: unknown[];
  onRowClick?: (row: T) => void;
  exportName?: string;
  exportColumns?: ExportColumn<T>[];
  emptyTitle?: string;
  emptyDescription?: string;
  storageKey?: string;
  initialPageSize?: number;
  countMode?: 'exact' | 'planned' | 'estimated';
}

export function ServerDataTable<T extends Record<string, unknown>>(props: ServerDataTableProps<T>) {
  const { can } = useAuth();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(props.initialPageSize ?? 25);
  const [sorting, setSorting] = useState<SortingState>(props.defaultSort ? [{ id: props.defaultSort.column, desc: props.defaultSort.desc }] : []);
  const [visibility, setVisibility] = useState<VisibilityState>(() => {
    if (!props.storageKey) return {};
    try { return JSON.parse(localStorage.getItem(`df.cols.${props.storageKey}`) ?? '{}'); } catch { return {}; }
  });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!props.storageKey) return;
    try { localStorage.setItem(`df.cols.${props.storageKey}`, JSON.stringify(visibility)); } catch { /* ignore */ }
  }, [visibility, props.storageKey]);

  const filterKey = JSON.stringify([props.filters, props.search]);
  useEffect(() => setPage(0), [filterKey]);

  const sort = sorting[0] ? { column: sorting[0].id, desc: sorting[0].desc } : null;
  const query = useQuery({
    queryKey: [...props.queryKey, { page, pageSize, sort, filterKey }],
    placeholderData: keepPreviousData,
    queryFn: () => fetchList<T>(props.source, {
      select: props.select, page, pageSize, sort, filters: props.filters, search: props.search, searchColumns: props.searchColumns,
      countMode: props.countMode,
    }),
  });

  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const total = query.data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const table = useReactTable({
    data: rows,
    columns: props.columns,
    state: { sorting, columnVisibility: visibility },
    manualSorting: true,
    manualPagination: true,
    pageCount,
    onSortingChange: (u) => { setSorting(u); setPage(0); },
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
  });

  const doExport = async (format: 'csv' | 'xlsx') => {
    if (!props.exportColumns) return;
    setExporting(true);
    try {
      const data = await fetchForExport<T>(props.source, { select: props.select, sort, filters: props.filters, search: props.search, searchColumns: props.searchColumns });
      const name = `${props.exportName ?? props.source}-${new Date().toISOString().slice(0, 10)}`;
      if (format === 'csv') downloadCsv(data, props.exportColumns, name);
      else await downloadXlsx(data, props.exportColumns, name);
      toast.success(`Exported ${data.length} rows`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {query.isFetching ? 'Loading…' : `${total.toLocaleString('en-ZA')} record${total === 1 ? '' : 's'}`}
        </p>
        <div className="flex items-center gap-2">
          {props.exportColumns && can('data.export') && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="outline" loading={exporting}><Download /> Export</Button></DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => void doExport('csv')}>CSV (filtered results)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void doExport('xlsx')}>Excel (filtered results)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" aria-label="Choose columns"><Columns3 /> Columns</Button></DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              {table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => (
                <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(Boolean(v))}
                  onSelect={(e) => e.preventDefault()}>
                  {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {query.error ? <div className="p-4"><ErrorState error={query.error} onRetry={() => void query.refetch()} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const sortable = h.column.getCanSort();
                    const dir = h.column.getIsSorted();
                    return (
                      <th key={h.id} scope="col" className="whitespace-nowrap px-3 py-2 font-medium"
                          aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                        {sortable ? (
                          <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={h.column.getToggleSortingHandler()}>
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                          </button>
                        ) : flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {query.isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    {table.getVisibleLeafColumns().map((c) => <td key={c.id} className="px-3 py-3"><div className="h-3 w-3/4 animate-pulse rounded bg-muted" /></td>)}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={table.getVisibleLeafColumns().length}>
                  <EmptyState title={props.emptyTitle ?? 'No records found'} description={props.emptyDescription ?? 'Try changing the filters or search.'} />
                </td></tr>
              ) : table.getRowModel().rows.map((r) => (
                <tr key={r.id}
                  className={cn('border-t align-top hover:bg-muted/40', props.onRowClick && 'cursor-pointer', query.isFetching && 'opacity-70')}
                  onClick={props.onRowClick ? (e) => { if (!(e.target as HTMLElement).closest('a,button,input')) props.onRowClick!(r.original); } : undefined}
                  onKeyDown={props.onRowClick ? (e) => { if (e.key === 'Enter') props.onRowClick!(r.original); } : undefined}
                  tabIndex={props.onRowClick ? 0 : undefined}>
                  {r.getVisibleCells().map((c) => <td key={c.id} className="px-3 py-2">{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor={`ps-${props.source}`} className="text-xs text-muted-foreground">Rows per page</label>
          <Select id={`ps-${props.source}`} className="h-8 w-20" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
            options={[10, 25, 50, 100].map((n) => ({ value: String(n), label: String(n) }))} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Page {page + 1} of {pageCount}</span>
          <Button size="icon" variant="outline" className="h-8 w-8" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft /></Button>
          <Button size="icon" variant="outline" className="h-8 w-8" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight /></Button>
        </div>
      </div>
    </div>
  );
}
