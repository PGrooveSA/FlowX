import { useState } from 'react';
import { rpc } from '@/lib/api';
import { chunk } from '@/lib/csv';
import { opts, useWarehouses } from '@/hooks/useLookups';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { PageHeader } from '@/components/common';
import { ImportWizard, markFileDuplicates, type ValidatedRow } from '@/components/common/ImportWizard';

const TEMPLATE = 'model_code,serial_number,imei,condition,asset_tag,purchase_date,notes\nLNV-100E-G4,PF4X000001,,new,,2026-03-01,\n';
const CHUNK = 500;

interface DryRun { rows: number; valid: number; errors: { row: number; error: string }[]; committed: boolean }

export function DeviceImportPage() {
  const warehouses = useWarehouses().data;
  const [warehouse, setWarehouse] = useState('');
  const [reference, setReference] = useState('');

  // Server-side dry run: every row is validated by the same database function that will insert it.
  const validate = async (rows: Record<string, string>[], onProgress: (p: number) => void) => {
    if (!warehouse) throw new Error('Select the receiving warehouse first');
    const validated: ValidatedRow[] = rows.map((r, i) => ({ row: i + 2, data: r, errors: [] }));
    markFileDuplicates(validated, (r) => r.data.serial_number?.toUpperCase().replace(/[\s\-_/.]+/g, ''), 'serial number');
    const parts = chunk(validated, CHUNK);
    for (let p = 0; p < parts.length; p++) {
      const res = await rpc<DryRun>('import_devices', { p_rows: parts[p].map((r) => ({ ...r.data, _row: r.row })), p_warehouse_id: warehouse, p_dry_run: true, p_reference: reference || null });
      for (const e of res.errors) validated.find((v) => v.row === e.row)?.errors.push(e.error);
      onProgress(Math.round(((p + 1) / parts.length) * 100));
    }
    return validated;
  };

  const commit = async (rows: ValidatedRow[], onProgress: (p: number) => void) => {
    let created = 0; const messages: string[] = [];
    const parts = chunk(rows, CHUNK);
    for (let p = 0; p < parts.length; p++) {
      try {
        const res = await rpc<DryRun>('import_devices', { p_rows: parts[p].map((r) => ({ ...r.data, _row: r.row })), p_warehouse_id: warehouse, p_dry_run: false, p_reference: reference || null });
        if (res.committed) created += res.valid;
        else messages.push(...res.errors.map((e) => `Row ${e.row}: ${e.error} (chunk ${p + 1} not committed)`));
      } catch (e) { messages.push(`Chunk ${p + 1}: ${(e as Error).message}`); }
      onProgress(Math.round(((p + 1) / parts.length) * 100));
    }
    return { created, failed: rows.length - created, messages };
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Import devices" crumbs={[{ label: 'Device Register', to: '/devices' }, { label: 'Import' }]}
        description="Rows are validated by the server (duplicates, models, IMEIs) before anything is saved. Large files are processed in chunks of 500." />
      <ImportWizard requiredColumns={['model_code', 'serial_number']} optionalColumns={['imei', 'condition', 'asset_tag', 'purchase_date', 'notes']}
        template={TEMPLATE} templateName="device-import-template.csv" validate={validate} commit={commit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Receiving warehouse" htmlFor="imp-wh" required><Select id="imp-wh" placeholder="Select…" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}
            options={opts(warehouses?.filter((w) => w.is_active), (w) => `${w.code} — ${w.name}`)} /></Field>
          <Field label="Acquisition / PO reference" htmlFor="imp-ref"><Input id="imp-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
      </ImportWizard>
    </div>
  );
}
