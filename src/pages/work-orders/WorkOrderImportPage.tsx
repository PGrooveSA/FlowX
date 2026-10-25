import { supabase } from '@/lib/supabase';
import { rpc } from '@/lib/api';
import { RECIPIENT_TYPES } from '@/lib/status';
import { useModels, useWorkOrderTypes } from '@/hooks/useLookups';
import { PageHeader, LoadingState } from '@/components/common';
import { ImportWizard, type ValidatedRow } from '@/components/common/ImportWizard';

const TEMPLATE = 'emis_number,work_order_type_code,recipient_type,model_code,quantity,description,source_reference\n900100101,new_allocation,school,LNV-100E-G4,10,Grade 7 allocation,DOE-IMPORT-001\n';

export function WorkOrderImportPage() {
  const models = useModels().data;
  const types = useWorkOrderTypes().data;
  if (!models || !types) return <LoadingState />;

  const validate = async (rows: Record<string, string>[], onProgress: (p: number) => void): Promise<ValidatedRow[]> => {
    const emis = [...new Set(rows.map((r) => r.emis_number).filter(Boolean))];
    const known = new Map<string, string>();
    for (let i = 0; i < emis.length; i += 200) {
      const { data } = await supabase.from('institutions').select('id, emis_number, status').in('emis_number', emis.slice(i, i + 200));
      (data ?? []).filter((x) => x.status === 'active').forEach((x) => known.set(x.emis_number, x.id));
      onProgress(Math.round(((i + 200) / Math.max(1, emis.length)) * 100));
    }
    return rows.map((r, i) => {
      const errors: string[] = [];
      if (!known.has(r.emis_number)) errors.push('Unknown or inactive EMIS number');
      if (!types.some((t) => t.code === r.work_order_type_code && t.is_active)) errors.push('Unknown work order type code');
      if (!RECIPIENT_TYPES.includes(r.recipient_type)) errors.push('Invalid recipient type');
      if (!models.some((m) => m.model_code === r.model_code && m.is_active)) errors.push('Unknown model code');
      if (!/^\d+$/.test(r.quantity ?? '') || Number(r.quantity) < 1) errors.push('Quantity must be a whole number of at least 1');
      return { row: i + 2, data: { ...r, institution_id: known.get(r.emis_number) ?? '' }, errors };
    });
  };

  const commit = async (rows: ValidatedRow[], onProgress: (p: number) => void) => {
    let created = 0; const messages: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].data;
      const model = models.find((m) => m.model_code === r.model_code)!;
      try {
        await rpc('save_work_order', { p_id: null, p_header: {
          institution_id: r.institution_id, work_order_type_id: types.find((t) => t.code === r.work_order_type_code)!.id,
          recipient_type: r.recipient_type, priority: 'normal', description: r.description, source_reference: r.source_reference,
          imported_at: new Date().toISOString() },
          p_lines: [{ category_id: model.category_id, model_id: model.id, requested_qty: Number(r.quantity) }] });
        created++;
      } catch (e) { messages.push(`Row ${rows[i].row}: ${(e as Error).message}`); }
      onProgress(Math.round(((i + 1) / rows.length) * 100));
    }
    return { created, failed: messages.length, messages };
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Import work orders" crumbs={[{ label: 'Work Orders', to: '/work-orders' }, { label: 'Import' }]}
        description="Each valid row becomes a draft work order. Drafts are reviewed and submitted for authorisation as normal." />
      <ImportWizard requiredColumns={['emis_number', 'work_order_type_code', 'recipient_type', 'model_code', 'quantity']} optionalColumns={['description', 'source_reference']}
        template={TEMPLATE} templateName="work-order-import-template.csv" validate={validate} commit={commit} maxRows={5000} />
    </div>
  );
}
