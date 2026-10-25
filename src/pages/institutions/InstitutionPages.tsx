import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Edit, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, friendlyMessage, type Filter } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { formatDate, labelize } from '@/lib/utils';
import { RECIPIENT_TYPES } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useDistricts, useProvinces } from '@/hooks/useLookups';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, useDebounce } from '@/components/common';
import { ImportWizard, markFileDuplicates, type ValidatedRow } from '@/components/common/ImportWizard';
import { AttachmentsPanel } from '@/components/common/Attachments';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();
const INSTITUTION_TYPES = ['school', 'district_office', 'department', 'tvet_college', 'special_school', 'other'];

export function InstitutionsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [f, setF] = useState<Record<string, string>>({ status: 'active' });
  const debounced = useDebounce(search);
  const provinces = useProvinces().data;
  const districts = useDistricts().data;
  const [open, setOpen] = useState(false);
  const filters = useMemo<Filter[]>(() => [{ column: 'status', op: 'eq', value: f.status }, { column: 'province_id', op: 'eq', value: f.province_id },
    { column: 'district_id', op: 'eq', value: f.district_id }, { column: 'institution_type', op: 'eq', value: f.type }], [f]);
  return (
    <div>
      <PageHeader title="Institutions and Recipients" crumbs={[{ label: 'Institutions' }]} description="EMIS numbers are unique; duplicates are rejected."
        actions={<>
          {can('institutions.manage') && can('data.import') && <Button variant="outline" asChild><Link to="/institutions/import"><Upload /> Import</Link></Button>}
          {can('institutions.manage') && <Button onClick={() => setOpen(true)}><Plus /> New institution</Button>}
        </>} />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input aria-label="Search" placeholder="Name, EMIS, town…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Province" value={f.province_id ?? ''} onChange={(e) => setF({ ...f, province_id: e.target.value, district_id: '' })} placeholder="All provinces" options={opts(provinces, (p) => p.name)} />
        <Select aria-label="District" value={f.district_id ?? ''} onChange={(e) => setF({ ...f, district_id: e.target.value })} placeholder="All districts" options={opts(districts?.filter((d) => !f.province_id || d.province_id === f.province_id), (d) => d.name)} />
        <Select aria-label="Type" value={f.type ?? ''} onChange={(e) => setF({ ...f, type: e.target.value })} placeholder="All types" options={INSTITUTION_TYPES.map((t) => ({ value: t, label: labelize(t) }))} />
        <Select aria-label="Status" value={f.status ?? ''} onChange={(e) => setF({ ...f, status: e.target.value })} placeholder="Any status" options={['active', 'inactive', 'closed'].map((t) => ({ value: t, label: labelize(t) }))} />
      </div>
      <ServerDataTable<Row> source="institutions" select="*, provinces(name), districts(name)" queryKey={['institutions']} filters={filters} search={debounced}
        searchColumns={['name', 'emis_number', 'town']} defaultSort={{ column: 'name', desc: false }} onRowClick={(r) => nav(`/institutions/${r.id}`)} exportName="institutions"
        columns={[c.accessor('name', { header: 'Institution', cell: (x) => <Link className="font-medium text-primary hover:underline" to={`/institutions/${x.row.original.id}`}>{x.getValue()}</Link> }),
          c.accessor('emis_number', { header: 'EMIS', cell: (x) => <span className="mono">{x.getValue()}</span> }), c.accessor('institution_type', { header: 'Type', cell: (x) => labelize(x.getValue()) }),
          c.accessor((r) => (r.provinces as unknown as { name: string }).name, { id: 'province', header: 'Province', enableSorting: false }),
          c.accessor((r) => (r.districts as unknown as { name: string }).name, { id: 'district', header: 'District', enableSorting: false }),
          c.accessor('town', { header: 'Town' }), c.accessor('phone', { header: 'Phone' }), c.accessor('principal_name', { header: 'Principal / contact' }),
          c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> })]}
        exportColumns={['emis_number', 'name', 'institution_type', 'phase', 'town', 'postal_code', 'address_line1', 'phone', 'email', 'principal_name', 'status'].map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
      {open && <InstitutionDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

const institutionSchema = z.object({
  emis_number: z.string().trim().regex(/^[0-9A-Za-z-]{5,20}$/, 'EMIS number must be 5–20 letters/digits'),
  name: z.string().trim().min(3, 'Enter the institution name').max(200),
  institution_type: z.string(), phase: z.string().optional(),
  province_id: z.string().uuid('Select the province'), district_id: z.string().uuid('Select the district'),
  address_line1: z.string().optional(), address_line2: z.string().optional(), town: z.string().optional(), postal_code: z.string().optional(),
  delivery_address: z.string().optional(), phone: z.string().optional(), email: z.string().email('Invalid email').or(z.literal('')).optional(),
  principal_name: z.string().optional(), billing_name: z.string().optional(), billing_address: z.string().optional(), billing_vat_number: z.string().optional(),
  status: z.enum(['active', 'inactive', 'closed']),
});
type InstitutionForm = z.infer<typeof institutionSchema>;

function InstitutionDialog({ existing, onClose }: { existing?: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const provinces = useProvinces().data;
  const districts = useDistricts().data;
  const form = useForm<InstitutionForm>({ resolver: zodResolver(institutionSchema), defaultValues: existing ? (Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, v ?? '']))) as InstitutionForm : { institution_type: 'school', status: 'active' } });
  const prov = form.watch('province_id');
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    const payload = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val === '' ? null : val]));
    const res = existing ? await supabase.from('institutions').update(payload).eq('id', existing.id) : await supabase.from('institutions').insert(payload);
    if (res.error) {
      if (res.error.code === '23505') form.setError('emis_number', { message: 'An institution with this EMIS number already exists' });
      else toast.error(friendlyMessage(res.error));
      return;
    }
    toast.success(existing ? 'Institution updated' : 'Institution created');
    void qc.invalidateQueries({ queryKey: ['institutions'] }); void qc.invalidateQueries({ queryKey: ['institution'] });
    onClose();
  });
  const text = (k: keyof InstitutionForm, label: string, req = false, span = false) => (
    <Field label={label} htmlFor={`i-${k}`} required={req} error={e[k]?.message} className={span ? 'sm:col-span-2' : ''}><Input id={`i-${k}`} {...form.register(k)} /></Field>);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title={existing ? 'Edit institution' : 'New institution'} />
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
          {text('emis_number', 'EMIS number', true)}{text('name', 'Name', true)}
          <Field label="Type" htmlFor="i-type"><Select id="i-type" {...form.register('institution_type')} options={INSTITUTION_TYPES.map((t) => ({ value: t, label: labelize(t) }))} /></Field>
          {text('phase', 'Phase')}
          <Field label="Province" htmlFor="i-prov" required error={e.province_id?.message}><Select id="i-prov" placeholder="Select…" {...form.register('province_id')} options={opts(provinces, (p) => p.name)} /></Field>
          <Field label="District" htmlFor="i-dist" required error={e.district_id?.message}><Select id="i-dist" placeholder="Select…" {...form.register('district_id')} options={opts(districts?.filter((d) => d.province_id === prov), (d) => d.name)} /></Field>
          {text('address_line1', 'Address line 1')}{text('address_line2', 'Address line 2')}{text('town', 'Town')}{text('postal_code', 'Postal code')}
          {text('delivery_address', 'Delivery address (if different)', false, true)}{text('phone', 'Phone')}{text('email', 'Email')}{text('principal_name', 'Principal / primary contact')}
          <Field label="Status" htmlFor="i-st"><Select id="i-st" {...form.register('status')} options={['active', 'inactive', 'closed'].map((t) => ({ value: t, label: labelize(t) }))} /></Field>
          {text('billing_name', 'Billing name')}{text('billing_vat_number', 'Billing VAT number')}{text('billing_address', 'Billing address', false, true)}
          <div className="sm:col-span-2"><DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={form.formState.isSubmitting}>Save</Button></DialogFooter></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InstitutionDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const q = useQuery({ queryKey: ['institution', id], queryFn: async () => ({
    inst: await fetchOne<Row>('institutions', 'id', id, '*, provinces(name), districts(name)'),
    contacts: await fetchAll<Row>('institution_contacts', '*', (x) => x.eq('institution_id', id).order('is_primary', { ascending: false })),
    recipients: await fetchAll<Row>('recipients', '*', (x) => x.eq('institution_id', id).order('recipient_type').order('full_name')),
  }) });
  if (q.isLoading) return <LoadingState />;
  const i = q.data?.inst;
  if (!i) return <ErrorState error={new Error('Institution not found')} />;
  return (
    <div className="space-y-4">
      <PageHeader title={i.name} crumbs={[{ label: 'Institutions', to: '/institutions' }, { label: i.name }]}
        description={<span className="flex items-center gap-2"><StatusBadge status={i.status} /> EMIS <span className="mono">{i.emis_number}</span></span>}
        actions={can('institutions.manage') && <Button variant="outline" onClick={() => setEdit(true)}><Edit /> Edit</Button>} />
      <Tabs defaultValue="overview">
        <TabsList><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="recipients">Recipients ({q.data!.recipients.length})</TabsTrigger>
          <TabsTrigger value="work_orders">Work orders</TabsTrigger><TabsTrigger value="attachments">Attachments</TabsTrigger></TabsList>
        <TabsContent value="overview" className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Details</CardTitle></CardHeader><CardContent>
            <KeyValue columns={3} items={[['Type', labelize(i.institution_type)], ['Phase', i.phase], ['Province', (i.provinces as unknown as { name: string }).name], ['District', (i.districts as unknown as { name: string }).name],
              ['Address', [i.address_line1, i.address_line2, i.town, i.postal_code].filter(Boolean).join(', ')], ['Delivery address', i.delivery_address], ['Phone', i.phone], ['Email', i.email],
              ['Principal', i.principal_name], ['Billing name', i.billing_name], ['Billing address', i.billing_address], ['Billing VAT', i.billing_vat_number]]} />
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Contacts</CardTitle>{can('institutions.manage') && <Button size="sm" variant="outline" onClick={() => setContactOpen(true)}><Plus /> Add</Button>}</CardHeader><CardContent className="p-0">
            {q.data!.contacts.length ? <ul className="divide-y text-sm">{q.data!.contacts.map((ct) => <li key={ct.id} className="px-4 py-2"><p className="font-medium">{ct.full_name} {String(ct.is_primary) === 'true' && <span className="text-xs text-primary">(primary)</span>}</p>
              <p className="text-xs text-muted-foreground">{[ct.role_title, ct.phone, ct.email].filter(Boolean).join(' · ')}</p></li>)}</ul> : <EmptyState title="No contacts" />}
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="recipients">
          <Card><CardHeader><CardTitle>Recipients</CardTitle>{can('recipients.manage') && <Button size="sm" onClick={() => setRecipientOpen(true)}><Plus /> Add recipient</Button>}</CardHeader>
            <CardContent className="p-0">
              {!can('recipients.view_learners') && <p className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">Learner records are hidden: viewing learner personal information requires the POPIA-restricted permission.</p>}
              {q.data!.recipients.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Grade / class</th><th className="px-3 py-2">Retention review</th><th className="px-3 py-2">Active</th></tr></thead>
                <tbody>{q.data!.recipients.map((r) => <tr key={r.id} className="border-t"><td className="px-3 py-1.5">{r.full_name}</td><td className="px-3 py-1.5">{labelize(r.recipient_type)}</td><td className="mono px-3 py-1.5">{r.reference_number ?? ''}</td>
                  <td className="px-3 py-1.5">{[r.grade, r.class_name].filter(Boolean).join(' / ')}</td><td className="px-3 py-1.5">{formatDate(r.retention_review_date)}</td><td className="px-3 py-1.5">{String(r.is_active) === 'true' ? 'Yes' : 'No'}</td></tr>)}</tbody></table>
                : <EmptyState title="No recipients visible" />}
            </CardContent></Card>
        </TabsContent>
        <TabsContent value="work_orders">
          <ServerDataTable<Row> source="v_work_orders" queryKey={['work-orders', 'institution', id]} filters={[{ column: 'institution_id', op: 'eq', value: id }]} defaultSort={{ column: 'created_at', desc: true }}
            columns={[c.accessor('wo_number', { header: 'Work order', cell: (x) => <Link className="mono text-primary hover:underline" to={`/work-orders/${x.row.original.id}`}>{x.getValue()}</Link> }),
              c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} kind="wo" /> }), c.accessor('work_order_type_name', { header: 'Type', enableSorting: false }),
              c.accessor('total_approved', { header: 'Approved', enableSorting: false }), c.accessor('total_delivered', { header: 'Delivered', enableSorting: false }), c.accessor('created_at', { header: 'Created', cell: (x) => formatDate(x.getValue()) })]} />
        </TabsContent>
        <TabsContent value="attachments"><AttachmentsPanel entityType="institution" entityId={i.id} /></TabsContent>
      </Tabs>
      {edit && <InstitutionDialog existing={i} onClose={() => setEdit(false)} />}
      {recipientOpen && <RecipientDialog institutionId={i.id} onClose={() => setRecipientOpen(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['institution', id] })} />}
      {contactOpen && <ContactDialog institutionId={i.id} onClose={() => setContactOpen(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['institution', id] })} />}
    </div>
  );
}

function RecipientDialog({ institutionId, onClose, onDone }: { institutionId: string; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const [v, setV] = useState({ recipient_type: 'teacher', full_name: '', reference_number: '', grade: '', class_name: '', phone: '', email: '' });
  const [busy, setBusy] = useState(false);
  const learner = v.recipient_type === 'learner';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Add recipient" description={learner ? 'Collect only what is needed to allocate the device (POPIA). Learner records are reviewed for retention.' : undefined} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Recipient type" htmlFor="rt"><Select id="rt" value={v.recipient_type} onChange={(e) => setV({ ...v, recipient_type: e.target.value })}
            options={RECIPIENT_TYPES.filter((t) => t !== 'learner' || can('recipients.view_learners')).map((t) => ({ value: t, label: labelize(t) }))} /></Field>
          <Field label="Full name / group name" htmlFor="rn" required><Input id="rn" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} /></Field>
          <Field label={learner ? 'Learner number' : 'Reference (e.g. persal number)'} htmlFor="rr"><Input id="rr" value={v.reference_number} onChange={(e) => setV({ ...v, reference_number: e.target.value })} /></Field>
          {learner && <><Field label="Grade" htmlFor="rg"><Input id="rg" value={v.grade} onChange={(e) => setV({ ...v, grade: e.target.value })} /></Field>
            <Field label="Class" htmlFor="rc"><Input id="rc" value={v.class_name} onChange={(e) => setV({ ...v, class_name: e.target.value })} /></Field></>}
          {!learner && <><Field label="Phone" htmlFor="rp"><Input id="rp" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
            <Field label="Email" htmlFor="re"><Input id="re" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field></>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={v.full_name.trim().length < 2} onClick={async () => {
            setBusy(true);
            const months = 24;
            const review = new Date(); review.setMonth(review.getMonth() + months);
            const { error } = await supabase.from('recipients').insert({ ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null])), institution_id: institutionId,
              retention_review_date: learner ? review.toISOString().slice(0, 10) : null });
            setBusy(false);
            if (error) toast.error(error.code === '23505' ? 'A recipient with this reference already exists at this institution' : friendlyMessage(error)); else { toast.success('Recipient added'); onDone(); onClose(); }
          }}>Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContactDialog({ institutionId, onClose, onDone }: { institutionId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ full_name: '', role_title: '', phone: '', email: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Add contact person" />
        <div className="grid gap-3 sm:grid-cols-2">
          {(['full_name', 'role_title', 'phone', 'email'] as const).map((k) => <Field key={k} label={labelize(k)} htmlFor={`ct-${k}`} required={k === 'full_name'}><Input id={`ct-${k}`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={v.full_name.trim().length < 2} onClick={async () => {
            setBusy(true);
            const { error } = await supabase.from('institution_contacts').insert({ ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null])), institution_id: institutionId });
            setBusy(false);
            if (error) toast.error(friendlyMessage(error)); else { toast.success('Contact added'); onDone(); onClose(); }
          }}>Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TEMPLATE = 'emis_number,name,institution_type,province_code,district_code,address_line1,town,postal_code,phone,email,principal_name\n900999001,Example Primary School,school,GP,GP-JN,1 Example Road,Johannesburg,2001,+27 11 000 0000,office@example.org,Ms Example\n';

export function InstitutionImportPage() {
  const provinces = useProvinces().data;
  const districts = useDistricts().data;
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  if (!provinces || !districts) return <LoadingState />;

  const validate = async (rows: Record<string, string>[], onProgress: (p: number) => void): Promise<ValidatedRow[]> => {
    const emis = rows.map((r) => r.emis_number?.trim().toUpperCase()).filter(Boolean);
    const existing = new Set<string>();
    for (let i = 0; i < emis.length; i += 300) {
      const { data } = await supabase.from('institutions').select('emis_number').in('emis_number', emis.slice(i, i + 300));
      (data ?? []).forEach((x) => existing.add(x.emis_number.toUpperCase()));
      onProgress(Math.round(((i + 300) / Math.max(1, emis.length)) * 100));
    }
    const validated = rows.map((r, i) => {
      const errors: string[] = [];
      const prov = provinces.find((p) => p.code === r.province_code?.toUpperCase());
      const dist = districts.find((d) => d.code === r.district_code?.toUpperCase());
      if (!/^[0-9A-Za-z-]{5,20}$/.test(r.emis_number ?? '')) errors.push('Invalid EMIS number');
      if (!r.name || r.name.length < 3) errors.push('Name is required');
      if (!prov) errors.push('Unknown province code');
      if (!dist || dist.province_id !== prov?.id) errors.push('Unknown district code for the province');
      if (r.institution_type && !INSTITUTION_TYPES.includes(r.institution_type)) errors.push('Invalid institution type');
      if (existing.has(r.emis_number?.toUpperCase()) && mode === 'skip') errors.push('EMIS number already exists (duplicate)');
      return { row: i + 2, data: { ...r, province_id: prov?.id ?? '', district_id: dist?.id ?? '', _exists: existing.has(r.emis_number?.toUpperCase()) ? '1' : '' }, errors };
    });
    return markFileDuplicates(validated, (r) => r.data.emis_number?.toUpperCase(), 'EMIS number');
  };
  const commit = async (rows: ValidatedRow[], onProgress: (p: number) => void) => {
    let created = 0; const messages: string[] = [];
    const fields = ['emis_number', 'name', 'institution_type', 'province_id', 'district_id', 'address_line1', 'town', 'postal_code', 'phone', 'email', 'principal_name'];
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      const toPayload = (r: ValidatedRow) => Object.fromEntries(fields.map((k) => [k, r.data[k] || (k === 'institution_type' ? 'school' : null)]));
      const inserts = part.filter((r) => !r.data._exists).map(toPayload);
      if (inserts.length) {
        const { error } = await supabase.from('institutions').insert(inserts);
        if (error) messages.push(`Rows ${part[0].row}–${part[part.length - 1].row}: ${friendlyMessage(error)}`); else created += inserts.length;
      }
      for (const r of part.filter((x) => x.data._exists)) {
        const { emis_number, ...rest } = toPayload(r);
        const { error } = await supabase.from('institutions').update(rest).eq('emis_number', emis_number as string);
        if (error) messages.push(`Row ${r.row}: ${friendlyMessage(error)}`); else created++;
      }
      onProgress(Math.round(((i + part.length) / rows.length) * 100));
    }
    return { created, failed: messages.length, messages };
  };
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Import institutions" crumbs={[{ label: 'Institutions', to: '/institutions' }, { label: 'Import' }]} description="Validated against existing EMIS numbers, provinces and districts before anything is saved." />
      <ImportWizard requiredColumns={['emis_number', 'name', 'province_code', 'district_code']} optionalColumns={['institution_type', 'address_line1', 'town', 'postal_code', 'phone', 'email', 'principal_name']}
        template={TEMPLATE} templateName="institution-import-template.csv" validate={validate} commit={commit}>
        <Field label="Existing EMIS numbers" htmlFor="imode"><Select id="imode" value={mode} onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
          options={[{ value: 'skip', label: 'Reject as duplicates' }, { value: 'update', label: 'Update the existing institution (authorised update)' }]} /></Field>
      </ImportWizard>
    </div>
  );
}
