import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc } from '@/lib/api';
import { labelize } from '@/lib/utils';
import { PRIORITIES, RECIPIENT_TYPES } from '@/lib/status';
import { opts, useCategories, useModels, useWarehouses, useWorkOrderTypes } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { ErrorState, LoadingState, PageHeader } from '@/components/common';
import { InstitutionPicker, type InstitutionLite } from '@/components/common/InstitutionPicker';

export const workOrderSchema = z.object({
  institution: z.object({ id: z.string().uuid(), name: z.string(), emis_number: z.string(), town: z.string().nullable(), status: z.string() }, {
    required_error: 'Select the institution', invalid_type_error: 'Select the institution' }),
  work_order_type_id: z.string().uuid('Select a work order type'),
  recipient_type: z.enum(['learner', 'teacher', 'school', 'department', 'other'], { errorMap: () => ({ message: 'Select the recipient type' }) }),
  recipient_id: z.string().optional(),
  recipient_group: z.string().max(200).optional(),
  grade: z.string().max(20).optional(),
  class_name: z.string().max(40).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  purpose: z.enum(['normal', 'urgent', 'replacement', 'special_project']),
  device_to_use: z.enum(['new_deployment', 'refurbished', 'existing_device', 'replacement_stock']),
  warehouse_id: z.string().optional(),
  work_order_name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(2000).optional(),
  internal_notes: z.string().max(4000).optional(),
  source_reference: z.string().max(100).optional(),
  lines: z.array(z.object({
    category_id: z.string().uuid('Select a device category'),
    model_id: z.string().optional(),
    requested_qty: z.coerce.number({ invalid_type_error: 'Enter a quantity' }).int('Whole numbers only').min(1, 'At least 1').max(100000, 'Too large'),
    notes: z.string().max(500).optional(),
  })).min(1, 'Add at least one device line'),
});
export type WorkOrderFormValues = z.infer<typeof workOrderSchema>;

export function WorkOrderFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const types = useWorkOrderTypes().data;
  const categories = useCategories().data;
  const models = useModels().data;
  const warehouses = useWarehouses().data;
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);

  const existing = useQuery({
    queryKey: ['work-order-edit', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const wo = await fetchOne<Record<string, string>>('work_orders', 'id', id);
      const inst = wo ? await fetchOne<InstitutionLite>('institutions', 'id', wo.institution_id, 'id, name, emis_number, town, status') : null;
      const lines = await fetchAll<Record<string, string | number>>('work_order_lines', '*', (q) => q.eq('work_order_id', id).order('line_no'));
      return { wo, inst, lines };
    },
  });

  const form = useForm<WorkOrderFormValues>({
    resolver: zodResolver(workOrderSchema),
    defaultValues: { priority: 'normal', purpose: 'normal', device_to_use: 'new_deployment', recipient_type: 'school', lines: [{ category_id: '', model_id: '', requested_qty: 1 }] },
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const institution = form.watch('institution');
  const recipients = useQuery({
    queryKey: ['recipients', institution?.id],
    enabled: Boolean(institution?.id),
    queryFn: () => fetchAll<{ id: string; full_name: string; recipient_type: string }>('recipients', 'id, full_name, recipient_type', (q) => q.eq('institution_id', institution!.id).eq('is_active', true).order('full_name')),
  });

  useEffect(() => {
    const d = existing.data;
    if (!d?.wo || !d.inst) return;
    form.reset({
      institution: d.inst, work_order_type_id: d.wo.work_order_type_id, recipient_type: d.wo.recipient_type as WorkOrderFormValues['recipient_type'],
      recipient_id: d.wo.recipient_id ?? '', recipient_group: d.wo.recipient_group ?? '', grade: d.wo.grade ?? '', class_name: d.wo.class_name ?? '',
      priority: d.wo.priority as WorkOrderFormValues['priority'], purpose: (d.wo.purpose ?? 'normal') as WorkOrderFormValues['purpose'],
      device_to_use: (d.wo.device_to_use ?? 'new_deployment') as WorkOrderFormValues['device_to_use'], warehouse_id: d.wo.warehouse_id ?? '', work_order_name: d.wo.work_order_name ?? '', description: d.wo.description ?? '',
      instructions: d.wo.instructions ?? '', internal_notes: d.wo.internal_notes ?? '', source_reference: d.wo.source_reference ?? '',
      lines: d.lines.map((l) => ({ category_id: String(l.category_id), model_id: (l.model_id as string) ?? '', requested_qty: Number(l.requested_qty), notes: (l.notes as string) ?? '' })),
    });
  }, [existing.data, form]);

  const save = (mode: 'draft' | 'submit') => form.handleSubmit(async (v) => {
    setSaving(mode);
    try {
      const header = { ...v, institution_id: v.institution.id, institution: undefined };
      const woId = await rpc<string>('save_work_order', { p_id: id ?? null, p_header: header, p_lines: v.lines });
      if (mode === 'submit') await rpc('submit_work_order', { p_id: woId });
      toast.success(mode === 'submit' ? 'Work order submitted for authorisation' : 'Draft saved');
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['work-order', woId] });
      nav(`/work-orders/${woId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the work order');
    } finally {
      setSaving(null);
    }
  })();

  if (id && existing.isLoading) return <LoadingState />;
  if (existing.error) return <ErrorState error={existing.error} />;
  if (id && existing.data?.wo && !['draft', 'returned_for_correction'].includes(existing.data.wo.status)) {
    return <ErrorState error={new Error('Only draft or returned work orders can be edited. Use "Request amendment" on the work order instead.')} />;
  }
  const errors = form.formState.errors;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={id ? `Edit ${existing.data?.wo?.wo_number ?? 'work order'}` : 'New work order'}
        crumbs={[{ label: 'Work Orders', to: '/work-orders' }, { label: id ? 'Edit' : 'New' }]}
        description={existing.data?.wo?.rejection_reason ? `Returned for correction: ${existing.data.wo.rejection_reason}` : 'Save as a draft or submit for authorisation.'} />
      <form className="space-y-4" onSubmit={(e) => e.preventDefault()} noValidate>
        <Card>
          <CardHeader><CardTitle>Institution and recipient</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Institution" htmlFor="inst" required error={errors.institution?.message as string} className="md:col-span-2"
              hint="Province and district are taken from the institution record.">
              <InstitutionPicker id="inst" value={institution ?? null} invalid={!!errors.institution}
                onChange={(i) => { form.setValue('institution', i as WorkOrderFormValues['institution'], { shouldValidate: true }); form.setValue('recipient_id', ''); }} />
            </Field>
            <Field label="Work order type" htmlFor="type" required error={errors.work_order_type_id?.message}>
              <Select id="type" placeholder="Select…" {...form.register('work_order_type_id')} options={opts(types?.filter((t) => t.is_active), (t) => `${t.name}${t.requires_invoice ? '' : ' (invoice-exempt)'}`)} />
            </Field>
            <Field label="Priority" htmlFor="priority" required>
              <Select id="priority" {...form.register('priority')} options={PRIORITIES.map((p) => ({ value: p, label: labelize(p) }))} />
            </Field>
            <Field label="Purpose of work order" htmlFor="purpose" required>
              <Select id="purpose" {...form.register('purpose')} options={['normal', 'urgent', 'replacement', 'special_project'].map((p) => ({ value: p, label: labelize(p) }))} />
            </Field>
            <Field label="Device to use" htmlFor="device_to_use" required>
              <Select id="device_to_use" {...form.register('device_to_use')}
                options={['new_deployment', 'refurbished', 'existing_device', 'replacement_stock'].map((p) => ({ value: p, label: labelize(p) }))} />
            </Field>
            <Field label="Recipient type" htmlFor="rtype" required error={errors.recipient_type?.message}>
              <Select id="rtype" {...form.register('recipient_type')} options={RECIPIENT_TYPES.map((r) => ({ value: r, label: labelize(r) }))} />
            </Field>
            <Field label="Named recipient (optional)" htmlFor="rid" hint="Learner records are visible only to users authorised for learner data.">
              <Select id="rid" placeholder={institution ? 'None / group recipient' : 'Select an institution first'} disabled={!institution} {...form.register('recipient_id')}
                options={(recipients.data ?? []).map((r) => ({ value: r.id, label: `${r.full_name} (${labelize(r.recipient_type)})` }))} />
            </Field>
            <Field label="Recipient group" htmlFor="rgroup" hint="E.g. 'Grade 7 learners' or 'ICT lab'">
              <Input id="rgroup" {...form.register('recipient_group')} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Grade" htmlFor="grade"><Input id="grade" {...form.register('grade')} /></Field>
              <Field label="Class" htmlFor="class"><Input id="class" {...form.register('class_name')} /></Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Devices requested</CardTitle>
            <Button type="button" size="sm" variant="outline" onClick={() => lines.append({ category_id: '', model_id: '', requested_qty: 1 })}><Plus /> Add line</Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {typeof errors.lines?.message === 'string' && <p className="text-sm text-destructive">{errors.lines.message}</p>}
            {lines.fields.map((fld, i) => {
              const cat = form.watch(`lines.${i}.category_id`);
              return (
                <div key={fld.id} className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-[1fr_1.4fr_120px_1fr_auto]">
                  <Field label={`Line ${i + 1} category`} htmlFor={`cat-${i}`} required error={errors.lines?.[i]?.category_id?.message}>
                    <Select id={`cat-${i}`} placeholder="Select…" {...form.register(`lines.${i}.category_id`)} options={opts(categories?.filter((c) => c.is_active), (c) => c.name)} />
                  </Field>
                  <Field label="Model" htmlFor={`model-${i}`} hint="Leave as 'Any' to allow any model in the category">
                    <Select id={`model-${i}`} placeholder="Any model in category" disabled={!cat} {...form.register(`lines.${i}.model_id`)}
                      options={opts(models?.filter((m) => m.category_id === cat && m.is_active), (m) => `${m.manufacturer} ${m.model_name}`)} />
                  </Field>
                  <Field label="Quantity" htmlFor={`qty-${i}`} required error={errors.lines?.[i]?.requested_qty?.message}>
                    <Input id={`qty-${i}`} type="number" min={1} inputMode="numeric" {...form.register(`lines.${i}.requested_qty`)} />
                  </Field>
                  <Field label="Notes" htmlFor={`notes-${i}`}><Input id={`notes-${i}`} {...form.register(`lines.${i}.notes`)} /></Field>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.fields.length === 1} onClick={() => lines.remove(i)}><Trash2 /></Button>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Instructions and fulfilment</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Preferred warehouse" htmlFor="wh" hint="Final warehouse is confirmed during scheduling.">
              <Select id="wh" placeholder="Decide at scheduling" {...form.register('warehouse_id')} options={opts(warehouses?.filter((w) => w.is_active), (w) => `${w.code} — ${w.name}`)} />
            </Field>
            <Field label="Source / import reference" htmlFor="src"><Input id="src" {...form.register('source_reference')} /></Field>
            <Field label="Work order name" htmlFor="wo-name" className="md:col-span-2" hint="Optional. Leave blank to name it from the type, recipient type and EMIS number.">
              <Input id="wo-name" {...form.register('work_order_name')} />
            </Field>
            <Field label="Description" htmlFor="desc" className="md:col-span-2"><Textarea id="desc" {...form.register('description')} /></Field>
            <Field label="Delivery instructions" htmlFor="instr"><Textarea id="instr" {...form.register('instructions')} /></Field>
            <Field label="Internal notes" htmlFor="notes"><Textarea id="notes" {...form.register('internal_notes')} /></Field>
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => nav(-1)}>Cancel</Button>
          <Button type="button" variant="secondary" loading={saving === 'draft'} disabled={!!saving} onClick={() => void save('draft')}>Save draft</Button>
          <Button type="button" loading={saving === 'submit'} disabled={!!saving} onClick={() => void save('submit')}>Save and submit for authorisation</Button>
        </div>
      </form>
    </div>
  );
}
