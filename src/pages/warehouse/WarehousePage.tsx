import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { rpc, type Filter } from '@/lib/api';
import { formatDate, formatDateTime, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { opts, useLocations, useModels, useSuppliers, useWarehouses } from '@/hooks/useLookups';
import { supabase } from '@/lib/supabase';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { PageHeader } from '@/components/common';
import { AdjustmentQueue } from '@/pages/approvals/ApprovalsPage';

type Row = Record<string, unknown>;
const c = createColumnHelper<Row>();
const txt = (k: string, header: string, mono = false) => c.accessor((r) => r[k] as string, { id: k, header, cell: (x) => <span className={mono ? 'mono' : ''}>{x.getValue() ?? '—'}</span> });

export function WarehousePage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'stock';
  const [warehouse, setWarehouse] = useState('');
  const warehouses = useWarehouses().data;
  const whFilter = (col: string): Filter[] => [{ column: col, op: 'eq', value: warehouse }];

  return (
    <div>
      <PageHeader title="Warehouse Inventory" crumbs={[{ label: 'Warehouse' }]} description="Stock levels are calculated from individual device records; they cannot be overwritten."
        actions={<Select aria-label="Warehouse" className="w-56" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} placeholder="All warehouses in scope" options={opts(warehouses, (w) => `${w.code} — ${w.name}`)} />} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          {['stock', 'receiving', 'transfers', 'adjustments', 'counts', 'locations'].map((t) => <TabsTrigger key={t} value={t}>{t === 'stock' ? 'Stock overview' : labelize(t)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="stock">
          <ServerDataTable<Row> source="v_stock_summary" queryKey={['stock', 'summary']} filters={whFilter('warehouse_id')} defaultSort={{ column: 'warehouse_code', desc: false }}
            exportName="stock-summary" emptyTitle="No stock in scope" columns={[
              txt('warehouse_code', 'Warehouse', true), txt('manufacturer', 'Manufacturer'), txt('model_name', 'Model'), txt('category_name', 'Category'),
              c.accessor((r) => r.available as number, { id: 'available', header: 'Available', cell: (x) => <span className={x.row.original.is_low_stock ? 'font-semibold text-amber-700' : 'font-semibold'}>{x.getValue()}{x.row.original.is_low_stock ? ' ⚠' : ''}</span> }),
              c.accessor((r) => r.reserved as number, { id: 'reserved', header: 'Reserved' }), c.accessor((r) => r.picked_issued as number, { id: 'picked_issued', header: 'Picked / issued' }),
              c.accessor((r) => r.in_repair as number, { id: 'in_repair', header: 'Faulty / repair' }), c.accessor((r) => r.quarantine as number, { id: 'quarantine', header: 'Quarantine / returns' }),
              c.accessor((r) => r.in_transit as number, { id: 'in_transit', header: 'In transit' }), c.accessor((r) => r.on_hand as number, { id: 'on_hand', header: 'On hand' }),
              c.accessor((r) => r.low_stock_threshold as number, { id: 'low_stock_threshold', header: 'Low-stock threshold' }),
            ]}
            exportColumns={['warehouse_code', 'manufacturer', 'model_name', 'category_name', 'available', 'reserved', 'picked_issued', 'in_repair', 'quarantine', 'in_transit', 'on_hand'].map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
        </TabsContent>
        <TabsContent value="receiving"><ReceivingTab filters={whFilter('warehouse_id')} canCreate={can('inventory.receive')} /></TabsContent>
        <TabsContent value="transfers"><TransfersTab warehouse={warehouse} canCreate={can('inventory.transfer')} /></TabsContent>
        <TabsContent value="adjustments" className="space-y-4">
          {can('inventory.adjust_approve') && <><h2 className="section-title">Awaiting your approval</h2><AdjustmentQueue /></>}
          <h2 className="section-title">All adjustments</h2>
          <ServerDataTable<Row> source="v_stock_movements" queryKey={['stock', 'adjustments']} defaultSort={{ column: 'requested_at', desc: true }}
            filters={[{ column: 'movement_type', op: 'eq', value: 'adjustment' }, ...whFilter('from_warehouse_id')]}
            columns={[txt('movement_number', 'Number', true), c.accessor((r) => r.adjustment_type as string, { id: 'adjustment_type', header: 'Type', cell: (x) => <StatusBadge status={x.getValue()} /> }),
              c.accessor((r) => r.status as string, { id: 'status', header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }), txt('serials', 'Device', true), txt('from_warehouse_code', 'Warehouse'),
              txt('reason', 'Reason'), txt('requested_by_name', 'Requested by'), c.accessor((r) => r.requested_at as string, { id: 'requested_at', header: 'Requested', cell: (x) => formatDateTime(x.getValue()) }),
              txt('approved_by_name', 'Decided by'), txt('decision_comment', 'Decision note')]} />
        </TabsContent>
        <TabsContent value="counts"><CountsTab warehouse={warehouse} canCreate={can('inventory.count')} /></TabsContent>
        <TabsContent value="locations"><LocationsTab warehouse={warehouse} /></TabsContent>
      </Tabs>
    </div>
  );
}

function ReceivingTab({ filters, canCreate }: { filters: Filter[]; canCreate: boolean }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      {canCreate && <div className="flex justify-end"><Button onClick={() => setOpen(true)}><Plus /> New goods receipt</Button></div>}
      <ServerDataTable<Row> source="v_goods_receipts" queryKey={['stock', 'receipts']} filters={filters} defaultSort={{ column: 'created_at', desc: true }}
        onRowClick={(r) => nav(`/warehouse/receiving/${r.id}`)} emptyTitle="No goods receipts"
        columns={[c.accessor((r) => r.grn_number as string, { id: 'grn_number', header: 'GRN', cell: (x) => <Link className="mono text-primary hover:underline" to={`/warehouse/receiving/${x.row.original.id}`}>{x.getValue()}</Link> }),
          c.accessor((r) => r.status as string, { id: 'status', header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }), txt('warehouse_code', 'Warehouse'), txt('supplier_name', 'Supplier'),
          txt('source_type', 'Source'), txt('source_reference', 'PO / reference', true), c.accessor((r) => `${r.received_qty} / ${r.expected_qty}`, { id: 'qty', header: 'Received / expected', enableSorting: false }),
          c.accessor((r) => r.receiving_date as string, { id: 'receiving_date', header: 'Date', cell: (x) => formatDate(x.getValue()) }), txt('received_by_name', 'Received by')]} />
      {open && <NewReceiptDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function NewReceiptDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const warehouses = useWarehouses().data;
  const suppliers = useSuppliers().data;
  const models = useModels().data;
  const [v, setV] = useState({ warehouse_id: '', supplier_id: '', source_type: 'purchase', source_reference: '', notes: '' });
  const [lines, setLines] = useState([{ model_id: '', expected_qty: 1 }]);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title="New goods receipt" description="Record what is expected; each device is then scanned in individually." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Warehouse" htmlFor="g-wh" required><Select id="g-wh" placeholder="Select…" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })} options={opts(warehouses?.filter((w) => w.is_active), (w) => w.code)} /></Field>
          <Field label="Source" htmlFor="g-src"><Select id="g-src" value={v.source_type} onChange={(e) => setV({ ...v, source_type: e.target.value })} options={['purchase', 'return', 'transfer', 'initial_import', 'donation', 'other'].map((s) => ({ value: s, label: labelize(s) }))} /></Field>
          <Field label="Supplier" htmlFor="g-sup"><Select id="g-sup" placeholder="—" value={v.supplier_id} onChange={(e) => setV({ ...v, supplier_id: e.target.value })} options={opts(suppliers, (s) => s.name)} /></Field>
          <Field label="Purchase order / reference" htmlFor="g-ref"><Input id="g-ref" value={v.source_reference} onChange={(e) => setV({ ...v, source_reference: e.target.value })} /></Field>
          <div className="space-y-2 sm:col-span-2">
            <p className="text-sm font-medium">Expected models</p>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_auto] gap-2">
                <Select aria-label={`Model line ${i + 1}`} placeholder="Select model…" value={l.model_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, model_id: e.target.value } : x))}
                  options={opts(models?.filter((m) => m.is_active), (m) => `${m.manufacturer} ${m.model_name}`)} />
                <Input aria-label={`Expected quantity line ${i + 1}`} type="number" min={0} value={l.expected_qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, expected_qty: Number(e.target.value) } : x))} />
                <Button variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setLines([...lines, { model_id: '', expected_qty: 1 }])}><Plus /> Add model</Button>
          </div>
          <Field label="Notes" htmlFor="g-n" className="sm:col-span-2"><Textarea id="g-n" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!v.warehouse_id || lines.some((l) => !l.model_id || l.expected_qty < 0)} onClick={async () => {
            setBusy(true);
            try { const id = await rpc<string>('create_goods_receipt', { p: { ...v, lines } }); nav(`/warehouse/receiving/${id}`); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Create and start receiving</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransfersTab({ warehouse, canCreate }: { warehouse: string; canCreate: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const filters = useMemo<Filter[]>(() => [{ column: 'movement_type', op: 'eq', value: 'transfer' }], []);
  const receive = async (id: string) => {
    try { const r = await rpc<{ received: number; outstanding: number }>('receive_stock_transfer', { p_transfer_id: id, p_location_id: null, p_serials: null });
      toast.success(`Received ${r.received} device(s); ${r.outstanding} outstanding`); void qc.invalidateQueries({ queryKey: ['stock'] }); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-3">
      {canCreate && <div className="flex justify-end"><Button onClick={() => setOpen(true)}><Plus /> New transfer</Button></div>}
      <ServerDataTable<Row> source="v_stock_movements" queryKey={['stock', 'transfers', warehouse]} filters={filters} defaultSort={{ column: 'requested_at', desc: true }}
        columns={[txt('movement_number', 'Transfer', true), c.accessor((r) => r.status as string, { id: 'status', header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }),
          txt('from_warehouse_code', 'From'), txt('to_warehouse_code', 'To'), c.accessor((r) => r.device_count as number, { id: 'device_count', header: 'Devices', enableSorting: false }),
          txt('reason', 'Reason'), txt('requested_by_name', 'By'), c.accessor((r) => r.requested_at as string, { id: 'requested_at', header: 'Created', cell: (x) => formatDateTime(x.getValue()) }),
          c.display({ id: 'act', header: '', cell: (x) => x.row.original.status === 'in_transit' && canCreate ? <Button size="sm" variant="outline" onClick={() => void receive(x.row.original.id as string)}>Receive all</Button> : null })]} />
      {open && <TransferDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const warehouses = useWarehouses().data;
  const [v, setV] = useState({ from: '', to: '', reason: '', serials: '' });
  const [busy, setBusy] = useState(false);
  const serials = v.serials.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Transfer stock between warehouses" description="Devices are in transit until the destination receives them. Only available, unallocated devices can be transferred." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" htmlFor="t-f" required><Select id="t-f" placeholder="Select…" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} options={opts(warehouses, (w) => w.code)} /></Field>
          <Field label="To" htmlFor="t-t" required><Select id="t-t" placeholder="Select…" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} options={opts(warehouses?.filter((w) => w.id !== v.from && w.is_active), (w) => w.code)} /></Field>
          <Field label="Serial numbers (scan one per line)" htmlFor="t-s" required className="sm:col-span-2" hint={`${serials.length} serial(s)`}>
            <Textarea id="t-s" className="mono min-h-[140px]" value={v.serials} onChange={(e) => setV({ ...v, serials: e.target.value })} /></Field>
          <Field label="Reason" htmlFor="t-r" required className="sm:col-span-2"><Input id="t-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!v.from || !v.to || !serials.length || v.reason.trim().length < 3} onClick={async () => {
            setBusy(true);
            try { const r = await rpc<{ number: string }>('create_stock_transfer', { p_from_warehouse: v.from, p_to_warehouse: v.to, p_serials: serials, p_reason: v.reason, p_reference: null });
              toast.success(`Transfer ${r.number} created`); void qc.invalidateQueries({ queryKey: ['stock'] }); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Create transfer</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CountsTab({ warehouse, canCreate }: { warehouse: string; canCreate: boolean }) {
  const nav = useNavigate();
  const warehouses = useWarehouses().data;
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ warehouse_id: '', location_id: '', notes: '' });
  const locations = useLocations(v.warehouse_id).data;
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      {canCreate && <div className="flex justify-end"><Button onClick={() => setOpen(true)}><Plus /> Start stock count</Button></div>}
      <ServerDataTable<Row> source="v_stock_counts" queryKey={['stock', 'counts']} filters={[{ column: 'warehouse_id', op: 'eq', value: warehouse }]} defaultSort={{ column: 'started_at', desc: true }}
        onRowClick={(r) => nav(`/warehouse/counts/${r.id}`)} columns={[
          c.accessor((r) => r.count_number as string, { id: 'count_number', header: 'Count', cell: (x) => <Link className="mono text-primary hover:underline" to={`/warehouse/counts/${x.row.original.id}`}>{x.getValue()}</Link> }),
          c.accessor((r) => r.status as string, { id: 'status', header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }), txt('warehouse_code', 'Warehouse'), txt('location_code', 'Location'),
          c.accessor((r) => r.expected_count as number, { id: 'expected_count', header: 'Expected' }), c.accessor((r) => r.found_count as number, { id: 'found_count', header: 'Found' }),
          c.accessor((r) => r.missing_count as number, { id: 'missing_count', header: 'Missing', cell: (x) => x.getValue() ? <Badge tone="red">{x.getValue()}</Badge> : x.getValue() ?? '—' }),
          c.accessor((r) => r.unexpected_count as number, { id: 'unexpected_count', header: 'Unexpected' }), txt('started_by_name', 'Started by'),
          c.accessor((r) => r.started_at as string, { id: 'started_at', header: 'Started', cell: (x) => formatDateTime(x.getValue()) })]} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader title="Start a stock count" description="The system snapshots the devices expected in the warehouse or location. Scan everything physically present." />
          <div className="space-y-3">
            <Field label="Warehouse" htmlFor="c-wh" required><Select id="c-wh" placeholder="Select…" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value, location_id: '' })} options={opts(warehouses, (w) => w.code)} /></Field>
            <Field label="Location (optional)" htmlFor="c-loc"><Select id="c-loc" placeholder="Whole warehouse" value={v.location_id} onChange={(e) => setV({ ...v, location_id: e.target.value })} options={opts(locations, (l) => l.code)} /></Field>
            <Field label="Notes" htmlFor="c-n"><Input id="c-n" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={busy} disabled={!v.warehouse_id} onClick={async () => {
              setBusy(true);
              try { const id = await rpc<string>('start_stock_count', { p_warehouse_id: v.warehouse_id, p_location_id: v.location_id || null, p_notes: v.notes || null }); nav(`/warehouse/counts/${id}`); }
              catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
            }}>Start count</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LocationsTab({ warehouse }: { warehouse: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const warehouses = useWarehouses().data;
  const [v, setV] = useState({ warehouse_id: warehouse, code: '', zone: '', shelf: '', bin: '', location_type: 'storage' });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      {can('master_data.manage') && (
        <div className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-7">
          <Select aria-label="Warehouse" placeholder="Warehouse…" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })} options={opts(warehouses, (w) => w.code)} />
          <Input aria-label="Location code" placeholder="Code e.g. A-03-01" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />
          <Input aria-label="Zone" placeholder="Zone" value={v.zone} onChange={(e) => setV({ ...v, zone: e.target.value })} />
          <Input aria-label="Shelf" placeholder="Shelf" value={v.shelf} onChange={(e) => setV({ ...v, shelf: e.target.value })} />
          <Input aria-label="Bin" placeholder="Bin" value={v.bin} onChange={(e) => setV({ ...v, bin: e.target.value })} />
          <Select aria-label="Type" value={v.location_type} onChange={(e) => setV({ ...v, location_type: e.target.value })} options={['storage', 'receiving', 'quarantine', 'repair', 'dispatch', 'returns'].map((t) => ({ value: t, label: labelize(t) }))} />
          <Button loading={busy} disabled={!v.warehouse_id || !v.code} onClick={async () => {
            setBusy(true);
            const { error } = await supabase.from('warehouse_locations').insert({ ...v, zone: v.zone || null, shelf: v.shelf || null, bin: v.bin || null });
            setBusy(false);
            if (error) toast.error(error.message); else { toast.success('Location added'); setV({ ...v, code: '', bin: '' }); void qc.invalidateQueries({ queryKey: ['stock', 'locations'] }); void qc.invalidateQueries({ queryKey: ['lookup', 'locations'] }); }
          }}><Plus /> Add</Button>
        </div>
      )}
      <ServerDataTable<Row> source="warehouse_locations" select="*, warehouses(code)" queryKey={['stock', 'locations']} filters={[{ column: 'warehouse_id', op: 'eq', value: warehouse }]}
        defaultSort={{ column: 'code', desc: false }} columns={[c.accessor((r) => (r.warehouses as { code: string }).code, { id: 'wh', header: 'Warehouse', enableSorting: false }),
          txt('code', 'Code', true), txt('zone', 'Zone'), txt('shelf', 'Shelf'), txt('bin', 'Bin'), c.accessor((r) => r.location_type as string, { id: 'location_type', header: 'Type', cell: (x) => labelize(x.getValue()) }),
          c.accessor((r) => r.is_active as boolean, { id: 'is_active', header: 'Active', cell: (x) => x.getValue() ? 'Yes' : 'No' })]} />
    </div>
  );
}
