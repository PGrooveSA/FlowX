import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Checkbox, Select } from '@/components/ui/form-controls';
import { ErrorState, LoadingState } from '@/components/common';

interface LabelDevice { id: string; serial_number: string | null; asset_tag: string; manufacturer: string; model_name: string; wo_number: string | null }

export const LABEL_SIZES: Record<string, { w: number; h: number; name: string }> = {
  '50x25': { w: 50, h: 25, name: 'Small warehouse label 50 × 25 mm' },
  '62x29': { w: 62, h: 29, name: 'Address label 62 × 29 mm' },
  '70x37': { w: 70, h: 37, name: 'A4 sheet, 3 × 8 (70 × 37 mm)' },
  '100x50': { w: 100, h: 50, name: 'Large 100 × 50 mm' },
};

function Label({ d, size, showWo }: { d: LabelDevice; size: { w: number; h: number }; showWo: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const [qr, setQr] = useState('');
  const value = d.serial_number ?? d.asset_tag;
  useEffect(() => {
    if (svg.current) JsBarcode(svg.current, value, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.4 });
    void QRCode.toDataURL(`DF:${d.asset_tag}|SN:${value}`, { margin: 0, width: 160, errorCorrectionLevel: 'M' }).then(setQr);
  }, [value, d.asset_tag]);
  const small = size.h < 30;
  return (
    <div className="label flex overflow-hidden bg-white p-[1.5mm] text-black" style={{ width: `${size.w}mm`, height: `${size.h}mm` }}>
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div className={small ? 'text-[6pt] leading-tight' : 'text-[7.5pt] leading-tight'}>
          <div className="truncate font-bold">{d.manufacturer} {d.model_name}</div>
          <div className="mono truncate">SN {value}</div>
          <div className="mono truncate">{d.asset_tag}{showWo && d.wo_number ? ` · ${d.wo_number}` : ''}</div>
        </div>
        <svg ref={svg} className="w-full" style={{ height: small ? '7mm' : '11mm' }} preserveAspectRatio="none" aria-label={`Barcode ${value}`} />
      </div>
      {qr && <img src={qr} alt={`QR code ${d.asset_tag}`} className="ml-[1mm] shrink-0 self-center" style={{ width: `${size.h - 4}mm`, height: `${size.h - 4}mm` }} />}
    </div>
  );
}

export function PrintLabels() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
  const [size, setSize] = useState('50x25');
  const [showWo, setShowWo] = useState(true);
  const q = useQuery({ queryKey: ['labels', ids], enabled: ids.length > 0, queryFn: async () => {
    const { data, error } = await supabase.from('v_devices').select('id, serial_number, asset_tag, manufacturer, model_name, wo_number').in('id', ids.slice(0, 400));
    if (error) throw new Error(error.message);
    return data as LabelDevice[];
  } });
  if (!ids.length) return <ErrorState error={new Error('No devices selected for printing')} />;
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const s = LABEL_SIZES[size];
  return (
    <div className="min-h-screen bg-slate-200 p-4 print:bg-white print:p-0">
      <style>{`@media print { @page { size: ${size === '70x37' ? 'A4' : `${s.w}mm ${s.h}mm`}; margin: ${size === '70x37' ? '8mm 0' : '0'}; } }`}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-white p-3 shadow">
        <Select aria-label="Label size" className="w-72" value={size} onChange={(e) => setSize(e.target.value)} options={Object.entries(LABEL_SIZES).map(([k, v]) => ({ value: k, label: v.name }))} />
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={showWo} onChange={(e) => setShowWo(e.target.checked)} /> Include work order reference</label>
        <span className="text-sm text-muted-foreground">{q.data?.length} label(s). The barcode encodes the manufacturer serial; labels never replace scanning the serial on the device.</span>
        <Button className="ml-auto" onClick={() => window.print()}><Printer /> Print labels</Button>
      </div>
      <div className={`label-sheet flex flex-wrap gap-2 ${size === '70x37' ? 'mx-auto max-w-[210mm] gap-0 bg-white' : ''}`}>
        {q.data?.map((d) => <Label key={d.id} d={d} size={s} showWo={showWo} />)}
      </div>
    </div>
  );
}
