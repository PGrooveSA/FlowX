import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createColumnHelper } from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Printer, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { rpc, type Filter } from '@/lib/api';
import { formatDate, labelize } from '@/lib/utils';
import { DEVICE_CONDITIONS, DEVICE_STATUSES } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useCategories, useLocations, useModels, useSuppliers, useWarehouses } from '@/hooks/useLookups';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { PageHeader, useDebounce } from '@/components/common';

export type DeviceRow = Record<string, unknown> & {
  id: string; asset_tag: string; serial_number: string | null; manufacturer: string; model_name: string; category_name: string; status: string;
  condition: string; warehouse_code: string; location_code: string | null; wo_number: string | null; current_work_order_id: string | null;
  institution_name: string | null; has_open_discrepancy: boolean; received_at: string; imei: string | null; warranty_expires_on: string | null;
};
const col = createColumnHelper<DeviceRow>();

export function DeviceRegisterPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [f, setF] = useState<Record<string, string>>({ status: params.get('status') ?? '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [registerOpen, setRegisterOpen] = useState(false);
  const debounced = useDebounce(search);
  const warehouses = useWarehouses().data;
  const categories = useCategories().data;
  const models = useModels().data;
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const filters = useMemo<Filter[]>(() => [
    { column: 'status', op: 'eq', value: f.status }, { column: 'condition', op: 'eq', value: f.condition },
    { column: 'warehouse_id', op: 'eq', value: f.warehouse_id }, { column: 'category_id', op: 'eq', value: f.category_id },
    { column: 'model_id', op: 'eq', value: f.model_id }, { column: 'institution_name', op: 'ilike', value: f.institution },
  ], [f]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const columns = [
    col.display({ id: 'select', header: '', enableHiding: false, cell: (c) => <Checkbox aria-label={`Select ${c.row.original.asset_tag}`} checked={selected.has(c.row.original.id)} onChange={() => toggle(c.row.original.id)} /> }),
    col.accessor('serial_number', { header: 'Serial number', cell: (c) => <Link to={`/devices/${c.row.original.id}`} className="mono font-medium text-primary hover:underline">{c.getValue() ?? '(serial exception)'}</Link> }),
    col.accessor('asset_tag', { header: 'Asset tag', cell: (c) => <span className="mono">{c.getValue()}</span> }),
    col.accessor('manufacturer', { header: 'Manufacturer' }),
    col.accessor('model_name', { header: 'Model' }),
    col.accessor('category_name', { header: 'Category' }),
    col.accessor('status', { header: 'Status', cell: (c) => <span className="flex items-center gap-1"><StatusBadge status={c.getValue()} kind="device" />{c.row.original.has_open_discrepancy && <Badge tone="red">discrepancy</Badge>}</span> }),
    col.accessor('condition', { header: 'Condition', cell: (c) => labelize(c.getValue()) }),
    col.accessor('warehouse_code', { header: 'Warehouse' }),
    col.accessor('location_code', { header: 'Location', cell: (c) => c.getValue() ?? '—' }),
    col.accessor('wo_number', { header: 'Work order', cell: (c) => c.getValue() ? <Link className="mono text-primary hover:underline" to={`/work-orders/${c.row.original.current_work_order_id}`}>{c.getValue()}</Link> : '—' }),
    col.accessor('institution_name', { header: 'Institution', cell: (c) => c.getValue() ?? '—' }),
    col.accessor('imei', { header: 'IMEI', enableSorting: false, cell: (c) => c.getValue() ?? '—' }),
    col.accessor('warranty_expires_on', { header: 'Warranty to', cell: (c) => formatDate(c.getValue()) }),
    col.accessor('received_at', { header: 'Received', cell: (c) => formatDate(c.getValue()) }),
  ];

  const printLabels = () => {
    try { sessionStorage.setItem('df.labels', JSON.stringify([...selected])); } catch { /* ignore */ }
    window.open(`/print/labels?ids=${[...selected].slice(0, 400).join(',')}`, '_blank', 'noopener');
  };

  return (
    <div>
      <PageHeader title="Device Register" crumbs={[{ label: 'Device Register' }]}
        description="Every physical device has its own permanent record and identity."
        actions={<>
          {can('labels.print') && <Button variant="outline" disabled={!selected.size} onClick={printLabels}><Printer /> Print labels ({selected.size})</Button>}
          {can('devices.register') && can('data.import') && <Button variant="outline" asChild><Link to="/devices/import"><Upload /> Import</Link></Button>}
          {can('devices.register') && <Button onClick={() => setRegisterOpen(true)}><Plus /> Register device</Button>}
        </>} />
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Input aria-label="Search" placeholder="Serial, asset tag, barcode…" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:col-span-2" />
        <Select aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)} placeholder="All statuses" options={DEVICE_STATUSES.map((s) => ({ value: s, label: labelize(s) }))} />
        <Select aria-label="Condition" value={f.condition ?? ''} onChange={(e) => set('condition', e.target.value)} placeholder="Any condition" options={DEVICE_CONDITIONS.map((s) => ({ value: s, label: labelize(s) }))} />
        <Select aria-label="Warehouse" value={f.warehouse_id ?? ''} onChange={(e) => set('warehouse_id', e.target.value)} placeholder="All warehouses" options={opts(warehouses, (w) => w.code)} />
        <Select aria-label="Category" value={f.category_id ?? ''} onChange={(e) => { set('category_id', e.target.value); set('model_id', ''); }} placeholder="All categories" options={opts(categories, (c) => c.name)} />
        <Select aria-label="Model" value={f.model_id ?? ''} onChange={(e) => set('model_id', e.target.value)} placeholder="All models"
          options={opts(models?.filter((m) => !f.category_id || m.category_id === f.category_id), (m) => `${m.manufacturer} ${m.model_name}`)} />
        <Input aria-label="Institution" placeholder="Institution" value={f.institution ?? ''} onChange={(e) => set('institution', e.target.value)} />
      </div>
      <ServerDataTable<DeviceRow> source="v_devices" queryKey={['devices']} columns={columns} filters={filters} search={debounced}
        searchColumns={['serial_number', 'asset_tag', 'barcode_value', 'acquisition_reference']} defaultSort={{ column: 'created_at', desc: true }}
        storageKey="devices" onRowClick={(r) => nav(`/devices/${r.id}`)} exportName="device-register" countMode="exact"
        exportColumns={[
          { header: 'Serial number', value: (r) => r.serial_number }, { header: 'Asset tag', value: (r) => r.asset_tag },
          { header: 'Manufacturer', value: (r) => r.manufacturer }, { header: 'Model', value: (r) => r.model_name },
          { header: 'Category', value: (r) => r.category_name }, { header: 'Status', value: (r) => r.status }, { header: 'Condition', value: (r) => r.condition },
          { header: 'Warehouse', value: (r) => r.warehouse_code }, { header: 'Location', value: (r) => r.location_code },
          { header: 'Work order', value: (r) => r.wo_number }, { header: 'Institution', value: (r) => r.institution_name }, { header: 'IMEI', value: (r) => r.imei },
          { header: 'Warranty to', value: (r) => r.warranty_expires_on }, { header: 'Received', value: (r) => r.received_at },
        ]} />
      {registerOpen && <RegisterDeviceDialog onClose={() => setRegisterOpen(false)} />}
    </div>
  );
}

const registerSchema = z.object({
  model_id: z.string().uuid('Select a model'),
  warehouse_id: z.string().uuid('Select a warehouse'),
  location_id: z.string().optional(),
  serial_number: z.string().trim().max(64).optional(),
  serial_exception_reason: z.string().max(300).optional(),
  imei: z.string().trim().regex(/^$|^\d{14,16}$/, 'IMEI must be 14–16 digits').optional(),
  condition: z.enum(['new', 'good', 'fair', 'poor', 'faulty', 'damaged', 'beyond_repair']),
  supplier_id: z.string().optional(),
  acquisition_reference: z.string().max(100).optional(),
  purchase_date: z.string().optional(),
  notes: z.string().max(1000).optional(),
}).refine((v) => (v.serial_number?.length ?? 0) > 0 || (v.serial_exception_reason?.trim().length ?? 0) >= 5, {
  message: 'Enter the serial number, or record a serial-number exception reason', path: ['serial_number'],
});

function RegisterDeviceDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const models = useModels().data;
  const categories = useCategories().data;
  const warehouses = useWarehouses().data;
  const suppliers = useSuppliers().data;
  const form = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema), defaultValues: { condition: 'new' } });
  const wh = form.watch('warehouse_id');
  const modelId = form.watch('model_id');
  const locations = useLocations(wh).data;
  const cat = categories?.find((c) => c.id === models?.find((m) => m.id === modelId)?.category_id);
  const [keepOpen, setKeepOpen] = useState(true);
  const e = form.formState.errors;

  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await rpc<{ asset_tag: string }>('register_device', { p: v });
      toast.success(`Registered ${v.serial_number || '(serial exception)'} as ${r.asset_tag}`);
      void qc.invalidateQueries({ queryKey: ['devices'] });
      if (keepOpen) form.reset({ ...v, serial_number: '', imei: '', serial_exception_reason: '' });
      else onClose();
    } catch (err) {
      form.setError('serial_number', { message: (err as Error).message });
    }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title="Register device" description="Each serial number may be registered only once per manufacturer. Scan the serial printed by the manufacturer." />
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
          <Field label="Model" htmlFor="r-model" required error={e.model_id?.message}>
            <Select id="r-model" placeholder="Select…" {...form.register('model_id')} options={opts(models?.filter((m) => m.is_active), (m) => `${m.manufacturer} ${m.model_name}`)} />
          </Field>
          <Field label="Condition" htmlFor="r-cond" required><Select id="r-cond" {...form.register('condition')} options={DEVICE_CONDITIONS.map((c) => ({ value: c, label: labelize(c) }))} /></Field>
          <Field label="Serial number" htmlFor="r-serial" required={cat?.requires_serial !== false} error={e.serial_number?.message}>
            <Input id="r-serial" className="mono" autoComplete="off" {...form.register('serial_number')} />
          </Field>
          <Field label={`IMEI${cat?.requires_imei ? '' : ' (if applicable)'}`} htmlFor="r-imei" required={cat?.requires_imei} error={e.imei?.message}>
            <Input id="r-imei" className="mono" inputMode="numeric" {...form.register('imei')} />
          </Field>
          <Field label="Warehouse" htmlFor="r-wh" required error={e.warehouse_id?.message}>
            <Select id="r-wh" placeholder="Select…" {...form.register('warehouse_id')} options={opts(warehouses?.filter((w) => w.is_active), (w) => `${w.code} — ${w.name}`)} />
          </Field>
          <Field label="Storage location" htmlFor="r-loc"><Select id="r-loc" placeholder="Unassigned" disabled={!wh} {...form.register('location_id')} options={opts(locations, (l) => `${l.code} (${l.location_type})`)} /></Field>
          <Field label="Supplier" htmlFor="r-sup"><Select id="r-sup" placeholder="—" {...form.register('supplier_id')} options={opts(suppliers, (s) => s.name)} /></Field>
          <Field label="Purchase / acquisition reference" htmlFor="r-ref"><Input id="r-ref" {...form.register('acquisition_reference')} /></Field>
          <Field label="Purchase date" htmlFor="r-pd" hint="Warranty end is calculated from the model warranty period."><Input id="r-pd" type="date" {...form.register('purchase_date')} /></Field>
          <Field label="Serial exception reason" htmlFor="r-exc" hint="Only if the serial cannot be captured; requires the serial-exception permission.">
            <Input id="r-exc" {...form.register('serial_exception_reason')} />
          </Field>
          <Field label="Notes" htmlFor="r-notes" className="sm:col-span-2"><Textarea id="r-notes" {...form.register('notes')} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={keepOpen} onChange={(ev) => setKeepOpen(ev.target.checked)} /> Keep this form open to register the next device</label>
          <div className="sm:col-span-2"><DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            <Button type="submit" loading={form.formState.isSubmitting}>Register device</Button>
          </DialogFooter></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
