import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, friendlyMessage, rpc } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { formatMoney, labelize, parseMoneyToCents } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { opts, useCategories, useModels, useProvinces, useWarehouses } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingState, PageHeader } from '@/components/common';

interface Setting { key: string; value: unknown; category: string; description: string }

export function SettingsPage() {
  const { can } = useAuth();
  const tabs = [...(can('settings.manage') ? ['organisation', 'finance', 'workflow', 'numbering', 'maintenance'] : []), ...(can('master_data.manage') ? ['master_data'] : [])];
  return (
    <div>
      <PageHeader title="System Settings" crumbs={[{ label: 'Settings' }]} description="Organisation branding, VAT and finance rules, workflow policy, document numbering and master data." />
      <Tabs defaultValue={tabs[0]}>
        <TabsList>{tabs.map((t) => <TabsTrigger key={t} value={t}>{labelize(t)}</TabsTrigger>)}</TabsList>
        <TabsContent value="organisation"><SettingsGroup categories={['branding', 'general']} /></TabsContent>
        <TabsContent value="finance"><SettingsGroup categories={['finance']} /></TabsContent>
        <TabsContent value="workflow"><SettingsGroup categories={['workflow', 'labels', 'integrations', 'privacy']} /></TabsContent>
        <TabsContent value="numbering"><Sequences /></TabsContent>
        <TabsContent value="maintenance"><Maintenance /></TabsContent>
        <TabsContent value="master_data"><MasterData /></TabsContent>
      </Tabs>
    </div>
  );
}

function SettingsGroup({ categories }: { categories: string[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => fetchAll<Setting>('system_settings', '*', (x) => x.order('key')) });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  if (!q.data) return <LoadingState />;
  const rows = q.data.filter((s) => categories.includes(s.category));
  const changed = Object.keys(draft).length > 0;
  return (
    <Card><CardContent className="space-y-4 pt-4">
      {rows.map((s) => {
        const v = s.key in draft ? draft[s.key] : s.value;
        const set = (nv: unknown) => setDraft({ ...draft, [s.key]: nv });
        return (
          <div key={s.key} className="grid gap-1 sm:grid-cols-[1fr_1.4fr] sm:items-center">
            <div><p className="text-sm font-medium">{s.description}</p><p className="mono text-xs text-muted-foreground">{s.key}</p></div>
            {typeof s.value === 'boolean' ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(v)} onChange={(e) => set(e.target.checked)} /> {v ? 'Enabled' : 'Disabled'}</label>
              : typeof s.value === 'number' ? (s.key.endsWith('_cents')
                ? <Input aria-label={s.description} inputMode="decimal" defaultValue={(Number(v) / 100).toFixed(2)} onChange={(e) => { const c = parseMoneyToCents(e.target.value); if (c !== null) set(c); }} />
                : <Input aria-label={s.description} type="number" step="any" value={String(v)} onChange={(e) => set(Number(e.target.value))} />)
              : s.key === 'org.primary_color' ? <div className="flex gap-2"><input type="color" aria-label="Primary colour" value={String(v)} onChange={(e) => set(e.target.value)} className="h-9 w-12 rounded border" /><Input value={String(v)} onChange={(e) => set(e.target.value)} /></div>
              : s.key === 'email.provider' ? <Select aria-label={s.description} value={String(v)} onChange={(e) => set(e.target.value)} options={[{ value: 'none', label: 'None (in-app notifications only)' }, { value: 'smtp', label: 'SMTP (requires server configuration)' }]} />
              : String(v).length > 60 ? <Textarea aria-label={s.description} value={String(v)} onChange={(e) => set(e.target.value)} />
              : <Input aria-label={s.description} value={String(v)} onChange={(e) => set(e.target.value)} />}
          </div>);
      })}
      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="outline" disabled={!changed} onClick={() => setDraft({})}>Discard</Button>
        <Button disabled={!changed} loading={busy} onClick={async () => {
          setBusy(true);
          try { await rpc('update_settings', { p_values: draft }); toast.success('Settings saved'); setDraft({}); void qc.invalidateQueries({ queryKey: ['settings'] }); void qc.invalidateQueries({ queryKey: ['branding'] }); }
          catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
        }}>Save changes</Button>
      </div>
    </CardContent></Card>
  );
}

function Sequences() {
  const q = useQuery({ queryKey: ['sequences'], queryFn: () => fetchAll<{ code: string; prefix: string; include_year: boolean; separator: string; padding: number; next_value: number; current_year: number | null; description: string }>('document_sequences', '*', (x) => x.order('code')) });
  const [edit, setEdit] = useState<Record<string, { prefix: string; separator: string; includeYear: boolean; padding: number; next: string }>>({});
  if (!q.data) return <LoadingState />;
  return (
    <Card><CardContent className="p-0"><table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Document</th><th className="px-3 py-2">Prefix</th><th className="px-3 py-2">Separator</th><th className="px-3 py-2">Year</th><th className="px-3 py-2">Digits</th><th className="px-3 py-2">Next number</th><th className="px-3 py-2">Preview</th><th /></tr></thead>
      <tbody>{q.data.map((s) => {
        const e = edit[s.code] ?? { prefix: s.prefix, separator: s.separator, includeYear: s.include_year, padding: s.padding, next: String(s.next_value) };
        const set = (p: Partial<typeof e>) => setEdit({ ...edit, [s.code]: { ...e, ...p } });
        return (
          <tr key={s.code} className="border-t"><td className="px-3 py-2">{s.description}</td>
            <td className="px-3 py-2"><Input aria-label="Prefix" className="h-8 w-24" value={e.prefix} onChange={(x) => set({ prefix: x.target.value.toUpperCase() })} /></td>
            <td className="px-3 py-2"><Select aria-label="Separator" className="h-8 w-24" value={e.separator} onChange={(x) => set({ separator: x.target.value })}
              options={[{ value: '-', label: '-' }, { value: '/', label: '/' }, { value: '', label: 'None' }]} /></td>
            <td className="px-3 py-2"><Checkbox aria-label="Include year" checked={e.includeYear} onChange={(x) => set({ includeYear: x.target.checked })} /></td>
            <td className="px-3 py-2"><Input aria-label="Digits" className="h-8 w-20" type="number" min={3} max={10} value={e.padding} onChange={(x) => set({ padding: Number(x.target.value) })} /></td>
            <td className="px-3 py-2"><Input aria-label="Next number" className="h-8 w-28" type="number" min={s.next_value} value={e.next} onChange={(x) => set({ next: x.target.value })} /></td>
            <td className="mono px-3 py-2 text-xs">{e.prefix}{e.separator}{e.includeYear ? `${new Date().getFullYear()}${e.separator}` : ''}{String(e.next).padStart(e.padding, '0')}</td>
            <td className="px-3 py-2">{edit[s.code] && <Button size="sm" onClick={async () => {
              try { await rpc('update_document_sequence', { p_code: s.code, p_prefix: e.prefix, p_padding: e.padding, p_next_value: Number(e.next),
                p_separator: e.separator, p_include_year: e.includeYear }); toast.success('Numbering updated'); setEdit({}); void q.refetch(); }
              catch (err) { toast.error((err as Error).message); }
            }}>Save</Button>}</td></tr>);
      })}</tbody></table>
      <p className="px-3 py-2 text-xs text-muted-foreground">Numbers are allocated inside the same database transaction as the document, so committed numbers are unique and sequential. The next number can only be increased.</p>
    </CardContent></Card>
  );
}

function Maintenance() {
  const [busy, setBusy] = useState(false);
  return (
    <Card><CardHeader><CardTitle>Scheduled checks</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      <p>Approaching schedules, overdue/near-due invoices, delayed repairs, late shipments and low stock generate notifications automatically every hour (pg_cron). You can run the checks now.</p>
      <Button loading={busy} onClick={async () => {
        setBusy(true);
        try { const r = await rpc<{ notifications_considered: number }>('run_scheduled_checks'); toast.success(`Checks complete (${r.notifications_considered} conditions evaluated; duplicates are suppressed)`); }
        catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
      }}>Run checks now</Button>
    </CardContent></Card>
  );
}

function MasterData() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <WarehousesCard /><ModelsCard /><CategoriesCard /><DistrictsCard /><SuppliersCard /><WorkOrderTypesCard />
    </div>
  );
}

function useSave(table: string, keys: string[][]) {
  const qc = useQueryClient();
  return async (row: Record<string, unknown>, id?: string) => {
    const clean = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === '' ? null : v]));
    const { error } = id ? await supabase.from(table).update(clean).eq('id', id) : await supabase.from(table).insert(clean);
    if (error) { toast.error(error.code === '23505' ? 'That code or name already exists' : friendlyMessage(error)); return false; }
    toast.success('Saved'); keys.forEach((k) => void qc.invalidateQueries({ queryKey: k })); return true;
  };
}

function WarehousesCard() {
  const warehouses = useWarehouses().data;
  const provinces = useProvinces().data;
  const save = useSave('warehouses', [['lookup', 'warehouses']]);
  const [v, setV] = useState({ code: '', name: '', province_id: '', city: '' });
  return (
    <Card><CardHeader><CardTitle>Warehouses</CardTitle></CardHeader><CardContent className="space-y-2">
      <ul className="divide-y text-sm">{warehouses?.map((w) => <li key={w.id} className="flex items-center justify-between py-1.5"><span><span className="mono">{w.code}</span> â€” {w.name}</span>
        <label className="flex items-center gap-1 text-xs"><Checkbox checked={w.is_active} onChange={(e) => void save({ is_active: e.target.checked }, w.id)} /> Active</label></li>)}</ul>
      <div className="grid gap-2 sm:grid-cols-5">
        <Input aria-label="Code" placeholder="CODE-01" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />
        <Input aria-label="Name" placeholder="Name" className="sm:col-span-2" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Select aria-label="Province" placeholder="Province" value={v.province_id} onChange={(e) => setV({ ...v, province_id: e.target.value })} options={opts(provinces, (p) => p.code)} />
        <Button disabled={!v.code || !v.name || !v.province_id} onClick={async () => { if (await save(v)) setV({ code: '', name: '', province_id: '', city: '' }); }}><Plus /> Add</Button>
      </div>
    </CardContent></Card>
  );
}

function ModelsCard() {
  const models = useModels().data;
  const categories = useCategories().data;
  const save = useSave('device_models', [['lookup', 'models']]);
  const [v, setV] = useState({ category_id: '', manufacturer: '', model_name: '', model_code: '', price: '', warranty_months: '12', low_stock_threshold: '10' });
  const [prices, setPrices] = useState<Record<string, string>>({});
  useEffect(() => setPrices({}), [models]);
  return (
    <Card><CardHeader><CardTitle>Device models and prices</CardTitle></CardHeader><CardContent className="space-y-2">
      <ul className="max-h-64 divide-y overflow-y-auto text-sm">{models?.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span>{m.manufacturer} {m.model_name} <span className="mono text-xs text-muted-foreground">{m.model_code}</span></span>
          <span className="flex items-center gap-1">
            <Input aria-label={`Price for ${m.model_code}`} className="h-8 w-28" inputMode="decimal" value={prices[m.id] ?? (m.unit_price_cents / 100).toFixed(2)} onChange={(e) => setPrices({ ...prices, [m.id]: e.target.value })} />
            {prices[m.id] !== undefined && <Button size="sm" onClick={() => { const c = parseMoneyToCents(prices[m.id]); if (c === null) toast.error('Invalid price'); else void save({ unit_price_cents: c }, m.id); }}>Save</Button>}
            {!m.is_active && <Badge tone="gray">inactive</Badge>}
          </span></li>))}</ul>
      <p className="text-xs text-muted-foreground">Prices are excl. VAT ({formatMoney(100)} = one rand) and apply to work orders approved after the change; approved work orders keep the price captured at approval. VAT is added on invoices at the configured rate.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Select aria-label="Category" placeholder="Category" value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })} options={opts(categories, (c) => c.name)} />
        <Input aria-label="Manufacturer" placeholder="Manufacturer" value={v.manufacturer} onChange={(e) => setV({ ...v, manufacturer: e.target.value })} />
        <Input aria-label="Model name" placeholder="Model name" value={v.model_name} onChange={(e) => setV({ ...v, model_name: e.target.value })} />
        <Input aria-label="Model code" placeholder="MODEL-CODE" value={v.model_code} onChange={(e) => setV({ ...v, model_code: e.target.value.toUpperCase() })} />
        <Input aria-label="Unit price" placeholder="Price excl. VAT (R)" inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} />
        <Input aria-label="Warranty months" type="number" placeholder="Warranty months" value={v.warranty_months} onChange={(e) => setV({ ...v, warranty_months: e.target.value })} />
        <Button className="sm:col-span-3" disabled={!v.category_id || !v.manufacturer || !v.model_name || !v.model_code || parseMoneyToCents(v.price || '0') === null}
          onClick={async () => { if (await save({ category_id: v.category_id, manufacturer: v.manufacturer, model_name: v.model_name, model_code: v.model_code, unit_price_cents: parseMoneyToCents(v.price || '0'), warranty_months: Number(v.warranty_months), low_stock_threshold: Number(v.low_stock_threshold) })) setV({ ...v, manufacturer: '', model_name: '', model_code: '', price: '' }); }}><Plus /> Add model</Button>
      </div>
    </CardContent></Card>
  );
}

function CategoriesCard() {
  const categories = useCategories().data;
  const save = useSave('device_categories', [['lookup', 'categories']]);
  const [v, setV] = useState({ code: '', name: '', requires_serial: true, requires_imei: false });
  return (
    <Card><CardHeader><CardTitle>Device categories</CardTitle></CardHeader><CardContent className="space-y-2">
      <ul className="divide-y text-sm">{categories?.map((c) => <li key={c.id} className="flex justify-between py-1.5"><span>{c.name} <span className="mono text-xs text-muted-foreground">{c.code}</span></span>
        <span className="text-xs text-muted-foreground">{c.requires_serial ? 'serial required' : 'no serial'}{c.requires_imei ? ' Â· IMEI required' : ''}</span></li>)}</ul>
      <div className="grid gap-2 sm:grid-cols-5">
        <Input aria-label="Code" placeholder="CODE" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />
        <Input aria-label="Name" placeholder="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <label className="flex items-center gap-1 text-xs"><Checkbox checked={v.requires_serial} onChange={(e) => setV({ ...v, requires_serial: e.target.checked })} /> Serial</label>
        <label className="flex items-center gap-1 text-xs"><Checkbox checked={v.requires_imei} onChange={(e) => setV({ ...v, requires_imei: e.target.checked })} /> IMEI</label>
        <Button disabled={!v.code || !v.name} onClick={async () => { if (await save(v)) setV({ code: '', name: '', requires_serial: true, requires_imei: false }); }}><Plus /> Add</Button>
      </div>
    </CardContent></Card>
  );
}

function DistrictsCard() {
  const provinces = useProvinces().data;
  const save = useSave('districts', [['lookup', 'districts']]);
  const [v, setV] = useState({ province_id: '', code: '', name: '' });
  return (
    <Card><CardHeader><CardTitle>Districts</CardTitle></CardHeader><CardContent>
      <div className="grid gap-2 sm:grid-cols-4">
        <Select aria-label="Province" placeholder="Province" value={v.province_id} onChange={(e) => setV({ ...v, province_id: e.target.value })} options={opts(provinces, (p) => p.name)} />
        <Input aria-label="Code" placeholder="GP-XX" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />
        <Input aria-label="Name" placeholder="District name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Button disabled={!v.province_id || !v.code || !v.name} onClick={async () => { if (await save(v)) setV({ ...v, code: '', name: '' }); }}><Plus /> Add</Button>
      </div>
    </CardContent></Card>
  );
}

function SuppliersCard() {
  const save = useSave('suppliers', [['lookup', 'suppliers']]);
  const [v, setV] = useState({ code: '', name: '', email: '', vat_number: '' });
  return (
    <Card><CardHeader><CardTitle>Suppliers</CardTitle></CardHeader><CardContent>
      <div className="grid gap-2 sm:grid-cols-5">
        <Input aria-label="Code" placeholder="SUP-CODE" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />
        <Input aria-label="Name" placeholder="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Input aria-label="Email" placeholder="Email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        <Input aria-label="VAT number" placeholder="VAT no." value={v.vat_number} onChange={(e) => setV({ ...v, vat_number: e.target.value })} />
        <Button disabled={!v.code || !v.name} onClick={async () => { if (await save(v)) setV({ code: '', name: '', email: '', vat_number: '' }); }}><Plus /> Add</Button>
      </div>
    </CardContent></Card>
  );
}

function WorkOrderTypesCard() {
  const q = useQuery({ queryKey: ['lookup', 'wo_types'], queryFn: () => fetchAll<{ id: string; code: string; name: string; requires_invoice: boolean; is_active: boolean }>('work_order_types', '*', (x) => x.order('sort_order')) });
  const save = useSave('work_order_types', [['lookup', 'wo_types']]);
  const [v, setV] = useState({ code: '', name: '', requires_invoice: true });
  return (
    <Card><CardHeader><CardTitle>Work order types</CardTitle></CardHeader><CardContent className="space-y-2">
      <ul className="divide-y text-sm">{q.data?.map((t) => <li key={t.id} className="flex items-center justify-between py-1.5"><span>{t.name}</span>
        <span className="flex items-center gap-3 text-xs"><label className="flex items-center gap-1"><Checkbox checked={t.requires_invoice} onChange={(e) => void save({ requires_invoice: e.target.checked }, t.id)} /> Invoice required</label>
          <label className="flex items-center gap-1"><Checkbox checked={t.is_active} onChange={(e) => void save({ is_active: e.target.checked }, t.id)} /> Active</label></span></li>)}</ul>
      <div className="grid gap-2 sm:grid-cols-4">
        <Input aria-label="Code" placeholder="code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toLowerCase().replace(/\W+/g, '_') })} />
        <Input aria-label="Name" placeholder="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <label className="flex items-center gap-1 text-xs"><Checkbox checked={v.requires_invoice} onChange={(e) => setV({ ...v, requires_invoice: e.target.checked })} /> Invoice required</label>
        <Button disabled={!v.code || !v.name} onClick={async () => { if (await save(v)) setV({ code: '', name: '', requires_invoice: true }); }}><Plus /> Add</Button>
      </div>
    </CardContent></Card>
  );
}
