import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { fetchAll, fetchOne } from '@/lib/api';
import { formatDateNumeric, labelize } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/form-controls';
import { ErrorState, LoadingState } from '@/components/common';

interface Pallet { id: string; pallet_number: string; warehouse_id: string | null; reference: string | null; notes: string | null; created_at: string }
interface PalletDevice { id: string; asset_tag: string; serial_number: string | null; imei: string | null; manufacturer: string; model_name: string; condition: string; warehouse_code: string | null }

function Barcode({ value }: { value: string }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => { if (svg.current) JsBarcode(svg.current, value, { format: 'CODE128', displayValue: true, fontSize: 18, height: 90, margin: 0, width: 3 }); }, [value]);
  return <svg ref={svg} aria-label={`Barcode ${value}`} style={{ maxWidth: '120mm' }} />;
}

/** An A4 pallet label: pallet number as barcode and QR code, what is on the pallet, and every serial number. */
export function PrintPalletLabel() {
  const [params] = useSearchParams();
  const id = params.get('id');
  const [qr, setQr] = useState('');
  const [list, setList] = useState(true);
  const q = useQuery({
    queryKey: ['pallet-label', id], enabled: Boolean(id),
    queryFn: async () => {
      const pallet = await fetchOne<Pallet>('pallets', 'id', id, 'id, pallet_number, warehouse_id, reference, notes, created_at');
      const devices = await fetchAll<PalletDevice>('v_pallet_devices', 'id, asset_tag, serial_number, imei, manufacturer, model_name, condition, warehouse_code',
        (x) => x.eq('pallet_id', id).order('asset_tag'));
      return { pallet, devices };
    },
  });
  const pallet = q.data?.pallet;
  useEffect(() => {
    if (pallet) void QRCode.toDataURL(`DF-PALLET:${pallet.pallet_number}|QTY:${q.data?.devices.length ?? 0}`, { margin: 0, width: 360, errorCorrectionLevel: 'M' }).then(setQr);
  }, [pallet, q.data?.devices.length]);

  if (!id) return <ErrorState error={new Error('No pallet selected')} />;
  if (q.isLoading) return <LoadingState />;
  if (q.error || !pallet) return <ErrorState error={q.error ?? new Error('Pallet not found')} />;
  const { devices } = q.data!;
  const groups = new Map<string, number>();
  for (const d of devices) { const k = `${d.manufacturer} ${d.model_name} · ${labelize(d.condition)}`; groups.set(k, (groups.get(k) ?? 0) + 1); }
  const warehouse = devices.find((d) => d.warehouse_code)?.warehouse_code;
  const hasImei = devices.some((d) => d.imei);

  return (
    <div className="min-h-screen bg-slate-200 p-4 print:bg-white print:p-0">
      <style>{'@media print { @page { size: A4; margin: 10mm; } .pallet-sheet { box-shadow: none !important; width: auto !important; min-height: 0 !important; padding: 0 !important; } }'}</style>
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center gap-3 rounded-2xl bg-white p-3 shadow">
        <span className="text-sm">Pallet label for <b>{pallet.pallet_number}</b> · {devices.length} device(s) · A4</span>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={list} onChange={(e) => setList(e.target.checked)} /> List every serial number</label>
        <Button className="ml-auto" onClick={() => window.print()}><Printer /> Print pallet label</Button>
      </div>
      <section className="pallet-sheet mx-auto bg-white p-[10mm] text-black shadow" style={{ width: '210mm', minHeight: '297mm' }}>
        <div className="flex items-start justify-between border-b-4 border-black pb-3">
          <div>
            <p className="text-[12pt] font-semibold uppercase tracking-[.2em]">Pallet</p>
            <p className="text-[44pt] font-bold leading-none">{pallet.pallet_number}</p>
            <p className="mt-2 text-[11pt]">{warehouse ? `Warehouse ${warehouse} · ` : ''}Packed {formatDateNumeric(new Date(pallet.created_at))}</p>
          </div>
          <div className="text-right">
            <p className="text-[12pt] font-semibold uppercase tracking-[.2em]">Quantity</p>
            <p className="text-[56pt] font-bold leading-none">{devices.length}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-6 border-b-2 border-black py-5">
          <Barcode value={pallet.pallet_number} />
          {qr && <img src={qr} alt={`QR code ${pallet.pallet_number}`} style={{ width: '45mm', height: '45mm' }} />}
        </div>
        <div className="grid grid-cols-2 gap-6 border-b-2 border-black py-4 text-[11pt]">
          <div>
            <p className="text-[9pt] font-semibold uppercase tracking-wider">Contents</p>
            {[...groups].map(([k, n]) => <p key={k} className="font-semibold">{n} × {k}</p>)}
          </div>
          <div>
            {pallet.reference && <><p className="text-[9pt] font-semibold uppercase tracking-wider">Reference</p><p className="font-semibold">{pallet.reference}</p></>}
            {pallet.notes && <><p className="mt-2 text-[9pt] font-semibold uppercase tracking-wider">Notes</p><p>{pallet.notes}</p></>}
          </div>
        </div>
        {list && (
          <div className="pt-3">
            <p className="mb-1 text-[9pt] font-semibold uppercase tracking-wider">Devices on this pallet</p>
            <ol className="mono columns-3 gap-4 text-[7.5pt] leading-[1.35]">
              {devices.map((d, i) => (
                <li key={d.id} className="break-inside-avoid">{i + 1}. {d.serial_number ?? '—'} / {d.asset_tag}{hasImei && d.imei ? ` / ${d.imei}` : ''}</li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </div>
  );
}
