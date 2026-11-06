import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/form-controls';
import { ErrorState, LoadingState } from '@/components/common';

interface LabelDevice { id: string; serial_number: string | null; asset_tag: string; manufacturer: string; model_name: string; wo_number: string | null; imei: string | null }

interface LabelSize { w: number; h: number; name: string; /** label sheet layout; absent for roll labels (one label per printed page) */ sheet?: { cols: number; rows: number } }

export const LABEL_SIZES: Record<string, LabelSize> = {
  '50x25': { w: 50, h: 25, name: 'Label printer 50 × 25 mm' },
  '62x29': { w: 62, h: 29, name: 'Label printer 62 × 29 mm' },
  '100x50': { w: 100, h: 50, name: 'Label printer 100 × 50 mm' },
  '70x37': { w: 70, h: 37, name: 'A4 sheet, 24 per page (3 × 8, 70 × 37 mm)', sheet: { cols: 3, rows: 8 } },
  'a4-2x7': { w: 105, h: 42.3, name: 'A4 sheet, 14 per page (2 × 7, 105 × 42 mm)', sheet: { cols: 2, rows: 7 } },
  'a4-2x4': { w: 105, h: 74, name: 'A4 sheet, 8 per page (2 × 4, 105 × 74 mm)', sheet: { cols: 2, rows: 4 } },
};
type Codes = 'both' | 'barcode' | 'qr';
const CODES: Record<Codes, string> = { both: 'Barcode and QR code', barcode: 'Barcode only', qr: 'QR code only' };
const PREFS = 'df.labels.prefs';

function Label({ d, size, showWo, codes }: { d: LabelDevice; size: LabelSize; showWo: boolean; codes: Codes }) {
  const svg = useRef<SVGSVGElement>(null);
  const [qr, setQr] = useState('');
  const value = d.serial_number ?? d.asset_tag;
  useEffect(() => {
    if (svg.current) JsBarcode(svg.current, value, { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.4 });
    if (codes !== 'barcode') void QRCode.toDataURL(`DF:${d.asset_tag}|SN:${value}`, { margin: 0, width: 240, errorCorrectionLevel: 'M' }).then(setQr);
  }, [value, d.asset_tag, codes, size.w, size.h]);   // the size changes which svg is on screen, so draw again
  const small = size.h < 30, large = size.h >= 60;
  const qrMm = Math.min(size.h - 4, size.w * 0.42, 40);
  const text = small ? 'text-[6pt]' : large ? 'text-[10pt]' : 'text-[7.5pt]';
  if (large) return (
    // big sheet label: details across the top, barcode and QR code side by side underneath
    <div className="label flex flex-col overflow-hidden bg-white text-black" style={{ width: `${size.w}mm`, height: `${size.h}mm`, padding: '4mm 5mm' }}>
      <div className={`${text} leading-snug`}>
        <div className="truncate text-[12pt] font-bold">{d.manufacturer} {d.model_name}</div>
        <div className="mono truncate">SN {value}</div>
        <div className="mono truncate">Asset {d.asset_tag}{showWo && d.wo_number ? ` · ${d.wo_number}` : ''}</div>
        {d.imei && <div className="mono truncate">IMEI {d.imei}</div>}
      </div>
      <div className="mt-auto flex items-end gap-[4mm]">
        {codes !== 'qr' && <svg ref={svg} className="min-w-0 flex-1" style={{ height: '18mm' }} preserveAspectRatio="none" aria-label={`Barcode ${value}`} />}
        {codes !== 'barcode' && qr && <img src={qr} alt={`QR code ${d.asset_tag}`} className="shrink-0" style={{ width: '30mm', height: '30mm' }} />}
      </div>
    </div>
  );
  return (
    <div className="label flex items-center overflow-hidden bg-white p-[1.5mm] text-black" style={{ width: `${size.w}mm`, height: `${size.h}mm`, padding: size.sheet ? '2.5mm 3mm' : undefined }}>
      <div className="flex h-full min-w-0 flex-1 flex-col justify-between">
        <div className={`${text} leading-tight`}>
          <div className="truncate font-bold">{d.manufacturer} {d.model_name}</div>
          <div className="mono truncate">SN {value}</div>
          <div className="mono truncate">{d.asset_tag}{showWo && d.wo_number ? ` · ${d.wo_number}` : ''}</div>
          {large && d.imei && <div className="mono truncate">IMEI {d.imei}</div>}
        </div>
        {codes !== 'qr' && <svg ref={svg} className="w-full" style={{ height: small ? '7mm' : large ? '16mm' : '11mm' }} preserveAspectRatio="none" aria-label={`Barcode ${value}`} />}
      </div>
      {codes !== 'barcode' && qr && <img src={qr} alt={`QR code ${d.asset_tag}`} className="ml-[1.5mm] shrink-0" style={{ width: `${qrMm}mm`, height: `${qrMm}mm` }} />}
    </div>
  );
}

function loadPrefs(): { size?: string; codes?: Codes; showWo?: boolean } {
  try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { return {}; }
}

export function PrintLabels() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
  const title = params.get('title');
  const prefs = loadPrefs();
  const fromUrl = params.get('size');
  const [size, setSize] = useState(fromUrl && LABEL_SIZES[fromUrl] ? fromUrl : prefs.size && LABEL_SIZES[prefs.size] ? prefs.size : '50x25');
  const [codes, setCodes] = useState<Codes>(prefs.codes ?? 'both');
  const [showWo, setShowWo] = useState(prefs.showWo ?? true);
  const [skip, setSkip] = useState(0);
  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify({ size, codes, showWo })); } catch { /* storage unavailable */ } }, [size, codes, showWo]);

  const q = useQuery({ queryKey: ['labels', ids], enabled: ids.length > 0, queryFn: async () => {
    const { data, error } = await supabase.from('v_devices').select('id, serial_number, asset_tag, manufacturer, model_name, wo_number, imei').in('id', ids.slice(0, 400));
    if (error) throw new Error(error.message);
    // keep the order the devices were given in (the scan order)
    const order = new Map(ids.map((id, i) => [id, i]));
    return (data as LabelDevice[]).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } });
  if (!ids.length) return <ErrorState error={new Error('No devices selected for printing')} />;
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const s = LABEL_SIZES[size];
  const devices = q.data ?? [];
  const perPage = s.sheet ? s.sheet.cols * s.sheet.rows : 1;
  const blanks = s.sheet ? Math.min(skip, perPage - 1) : 0;
  const cells: (LabelDevice | null)[] = [...Array<null>(blanks).fill(null), ...devices];
  const pages: (LabelDevice | null)[][] = [];
  if (s.sheet) for (let i = 0; i < cells.length; i += perPage) pages.push(cells.slice(i, i + perPage));

  return (
    <div className="min-h-screen bg-slate-200 p-4 print:bg-white print:p-0">
      <style>{`@media print { @page { size: ${s.sheet ? 'A4' : `${s.w}mm ${s.h}mm`}; margin: 0; } .a4-page { break-after: page; box-shadow: none !important; margin: 0 !important; } .a4-page .label { border: 0 !important; } }`}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-white p-3 shadow">
        {title && <span className="font-semibold">{title}</span>}
        <Select aria-label="Label size" className="w-80" value={size} onChange={(e) => setSize(e.target.value)} options={Object.entries(LABEL_SIZES).map(([k, v]) => ({ value: k, label: v.name }))} />
        <Select aria-label="Codes on the label" className="w-52" value={codes} onChange={(e) => setCodes(e.target.value as Codes)} options={Object.entries(CODES).map(([k, v]) => ({ value: k, label: v }))} />
        {s.sheet && (
          <label className="flex items-center gap-2 text-sm">Skip used labels
            <Input type="number" min={0} max={perPage - 1} className="h-9 w-20" value={skip} onChange={(e) => setSkip(Math.max(0, Math.min(perPage - 1, Number(e.target.value) || 0)))} />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={showWo} onChange={(e) => setShowWo(e.target.checked)} /> Work order reference</label>
        <span className="text-sm text-muted-foreground">{devices.length} label(s){s.sheet ? ` on ${pages.length} A4 page(s)` : ''}.</span>
        <Button className="ml-auto" onClick={() => window.print()}><Printer /> Print labels</Button>
      </div>
      {s.sheet ? (
        <div className="space-y-4 print:space-y-0">
          {pages.map((pg, pi) => (
            <div key={pi} className="a4-page mx-auto bg-white shadow"
              style={{ width: '210mm', height: '297mm', padding: `${(297 - s.sheet!.rows * s.h) / 2}mm ${(210 - s.sheet!.cols * s.w) / 2}mm`, overflow: 'hidden' }}>
              <div className="label-sheet grid" style={{ gridTemplateColumns: `repeat(${s.sheet!.cols}, ${s.w}mm)`, gridAutoRows: `${s.h}mm` }}>
                {pg.map((d, i) => d ? <Label key={d.id} d={d} size={s} showWo={showWo} codes={codes} /> : <div key={`b${i}`} className="label" />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="label-sheet flex flex-wrap gap-2">
          {devices.map((d) => <Label key={d.id} d={d} size={s} showWo={showWo} codes={codes} />)}
        </div>
      )}
    </div>
  );
}
