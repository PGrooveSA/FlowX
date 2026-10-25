import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Edit, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, friendlyMessage } from '@/lib/api';
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
import { EmptyState, ErrorState, KeyValue, LoadingState, PageHeader } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();
const INSTITUTION_TYPES = ['school', 'district_office', 'department', 'tvet_college', 'special_school', 'other'];

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
      <PageHeader title={i.name} crumbs={[{ label: 'Work Orders', to: '/work-orders' }, { label: i.name }]}
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
