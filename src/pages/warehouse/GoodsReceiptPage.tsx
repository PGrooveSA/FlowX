import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc, type ScanResult } from '@/lib/api';
import { formatDate, formatDateTime, labelize } from '@/lib/utils';
import { DEVICE_CONDITIONS } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useLocations } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { ErrorState, KeyValue, LoadingState, PageHeader, ScanInput, ScanLog, type ScanLogEntry } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';

export function GoodsReceiptPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['receipt', id],
    queryFn: async () => ({
      grn: await fetchOne<Record<string, string>>('v_goods_receipts', 'id', id),
      lines: await fetchAll<{ id: string; expected_qty: number; device_models: { manufacturer: string; model_name: string; device_categories: { requires_imei: boolean; requires_serial: boolean } } }>(
        'goods_receipt_lines', 'id, expected_qty, device_models(manufacturer, model_name, device_categories(requires_imei, requires_serial))', (x) => x.eq('goods_receipt_id', id)),
      devices: await fetchAll<{ id: string; serial_number: string | null; asset_tag: string; condition: string; status: string; goods_receipt_line_id: string; created_at: string }>(
        'devices', 'id, serial_number, asset_tag, condition, status, goods_receipt_line_id, created_at', (x) => x.eq('goods_receipt_id', id).order('created_at', { ascending: false })),
    }),
  });
  const [line, setLine] = useState('');
  const [condition, setCondition] = useState('new');
  const [location, setLocation] = useState('');
  const [imei, setImei] = useState('');
  const [exception, setException] = useState('');
  const [notes, setNotes] = useState('');
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const locations = useLocations(q.data?.grn?.warehouse_id).data;

  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data?.grn) return <ErrorState error={q.error ?? new Error('Receipt not found')} />;
  const { grn, lines, devices } = q.data;
  const draft = grn.status === 'draft';
  const activeLine = line || lines[0]?.id;
  const lineInfo = lines.find((l) => l.id === activeLine);

  const receive = async (serial: string | null) => {
    setBusy(true);
    try {
      const r = await rpc<ScanResult>('receive_device_into_receipt', { p_receipt_id: grn.id, p_line_id: activeLine,
        p: { serial_number: serial, imei: imei || null, condition, location_id: location || null, serial_exception_reason: serial ? null : exception } });
      setLog((l) => [{ at: new Date(), ok: r.ok, message: r.message, serial: serial ?? '(exception)' }, ...l]);
      if (r.ok) { setImei(''); void qc.invalidateQueries({ queryKey: ['receipt', id] }); } else toast.error(r.message);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const complete = async () => {
    try {
      const r = await rpc<{ ok: boolean; message?: string; released?: number }>('complete_goods_receipt', { p_receipt_id: grn.id, p_discrepancy_notes: notes || null });
      if (!r.ok) { toast.warning(r.message); return; }
      toast.success(`Receipt completed; ${r.released} device(s) released to stock`); void qc.invalidateQueries({ queryKey: ['receipt', id] }); void qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={grn.grn_number} crumbs={[{ label: 'Warehouse', to: '/warehouse?tab=receiving' }, { label: grn.grn_number }]}
        description={<span className="flex items-center gap-2"><StatusBadge status={grn.status} /> {grn.warehouse_code} · {grn.supplier_name ?? 'No supplier'} · {grn.source_reference ?? ''}</span>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1"><CardHeader><CardTitle>Receipt</CardTitle></CardHeader><CardContent className="space-y-4">
          <KeyValue columns={1} items={[['Source', labelize(grn.source_type)], ['Receiving date', formatDate(grn.receiving_date)], ['Received by', grn.received_by_name], ['Completed', formatDateTime(grn.completed_at)], ['Discrepancy notes', grn.discrepancy_notes]]} />
          <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th>Model</th><th className="text-right">Expected</th><th className="text-right">Received</th></tr></thead>
            <tbody>{lines.map((l) => { const n = devices.filter((d) => d.goods_receipt_line_id === l.id).length; return (
              <tr key={l.id} className={n !== l.expected_qty ? 'text-amber-700' : ''}><td>{l.device_models.manufacturer} {l.device_models.model_name}</td><td className="text-right">{l.expected_qty}</td><td className="text-right font-medium">{n}</td></tr>); })}</tbody></table>
        </CardContent></Card>
        {draft && can('inventory.receive') && (
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Scan devices in</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Model line" htmlFor="gl"><Select id="gl" value={activeLine} onChange={(e) => setLine(e.target.value)} options={lines.map((l) => ({ value: l.id, label: `${l.device_models.manufacturer} ${l.device_models.model_name}` }))} /></Field>
              <Field label="Condition" htmlFor="gc"><Select id="gc" value={condition} onChange={(e) => setCondition(e.target.value)} options={DEVICE_CONDITIONS.map((c) => ({ value: c, label: labelize(c) }))} /></Field>
              <Field label="Location" htmlFor="glo"><Select id="glo" placeholder="Unassigned" value={location} onChange={(e) => setLocation(e.target.value)} options={opts(locations, (l) => l.code)} /></Field>
              {lineInfo?.device_models.device_categories.requires_imei && <Field label="IMEI (required)" htmlFor="gi"><Input id="gi" className="mono" value={imei} onChange={(e) => setImei(e.target.value)} /></Field>}
            </div>
            <ScanInput busy={busy} onScan={(s) => receive(s)} />
            {can('inventory.serial_exception') && (
              <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
                <Field label="Serial-number exception (device has no readable serial)" htmlFor="gex" className="flex-1"><Input id="gex" value={exception} onChange={(e) => setException(e.target.value)} placeholder="Reason, e.g. serial sticker missing - verified by photo" /></Field>
                <Button variant="outline" disabled={exception.trim().length < 5 || busy} onClick={() => void receive(null)}>Receive with exception</Button>
              </div>
            )}
            <ScanLog entries={log} />
            <div className="border-t pt-3">
              <Field label="Discrepancy notes (required if quantities differ)" htmlFor="gdn"><Textarea id="gdn" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              <Button className="mt-2" onClick={() => void complete()} disabled={!devices.length}>Complete receipt and release to stock</Button>
            </div>
          </CardContent></Card>
        )}
      </div>
      <Card><CardHeader><CardTitle>Devices on this receipt ({devices.length})</CardTitle></CardHeader><CardContent className="max-h-96 overflow-y-auto p-0">
        <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Serial</th><th className="px-3 py-2">Asset tag</th><th className="px-3 py-2">Condition</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Scanned</th></tr></thead>
          <tbody>{devices.map((d) => <tr key={d.id} className="border-t"><td className="mono px-3 py-1.5">{d.serial_number ?? '(exception)'}</td><td className="mono px-3 py-1.5">{d.asset_tag}</td>
            <td className="px-3 py-1.5">{labelize(d.condition)}</td><td className="px-3 py-1.5"><StatusBadge status={d.status} kind="device" /></td><td className="px-3 py-1.5">{formatDateTime(d.created_at)}</td></tr>)}</tbody></table>
      </CardContent></Card>
      <AttachmentsPanel entityType="goods_receipt" entityId={grn.id} title="Delivery notes and supporting documents" />
    </div>
  );
}
