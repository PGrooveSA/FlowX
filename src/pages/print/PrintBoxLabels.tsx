import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import { Printer } from 'lucide-react';
import { fetchAll, fetchOne } from '@/lib/api';
import { formatDateNumeric } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/common';

interface WorkOrder { id: string; wo_number: string; institution_name: string; province_code: string; emis_number: string; delivery_address?: string | null }
interface Device { box_number: string; serial_number: string | null; asset_tag: string; device_name: string; device_type: string }

function Barcode({ value, height = 44 }: { value: string; height?: number }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => { if (svg.current) JsBarcode(svg.current, value, { format: 'CODE128', displayValue: true, fontSize: 12, height, margin: 0, width: 1.6 }); }, [value, height]);
  return <svg ref={svg} aria-label={`Barcode ${value}`} />;
}

/** One 100 × 150 mm label per box: box and work order barcodes, destination and the serials inside. */
export function PrintBoxLabels() {
  const [params] = useSearchParams();
  const woId = params.get('wo');
  const onlyBox = params.get('box');
  const q = useQuery({
    queryKey: ['box-labels', woId, onlyBox],
    enabled: Boolean(woId),
    queryFn: async () => {
      const wo = await fetchOne<WorkOrder>('v_work_order_list', 'id', woId, 'id, wo_number, institution_name, province_code, emis_number');
      const devices = await fetchAll<Device>('v_work_order_allocations', 'box_number, serial_number, asset_tag, device_name, device_type',
        (x) => { let r = x.eq('work_order_id', woId).not('box_number', 'is', null); if (onlyBox) r = r.eq('box_number', onlyBox); return r.order('serial_number'); });
      return { wo, devices };
    },
  });
  if (!woId) return <ErrorState error={new Error('No work order selected')} />;
  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data?.wo) return <ErrorState error={q.error ?? new Error('Work order not found')} />;
  const { wo, devices } = q.data;
  const boxes = [...new Set(devices.map((d) => d.box_number))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!boxes.length) return <ErrorState error={new Error('No boxes found for this work order')} />;

  return (
    <div className="min-h-screen bg-slate-200 p-4 print:bg-white print:p-0">
      <style>{'@media print { @page { size: 100mm 150mm; margin: 0; } .box-label { break-after: page; } }'}</style>
      <div className="no-print mb-4 flex items-center gap-3 rounded-lg bg-white p-3 shadow">
        <span className="text-sm">{boxes.length} box label{boxes.length === 1 ? '' : 's'} for {wo.wo_number} (100 × 150 mm)</span>
        <Button className="ml-auto" onClick={() => window.print()}><Printer /> Print labels</Button>
      </div>
      <div className="flex flex-wrap gap-4 print:block">
        {boxes.map((box, i) => {
          const items = devices.filter((d) => d.box_number === box);
          return (
            <section key={box} className="box-label flex flex-col overflow-hidden bg-white p-[5mm] text-[9pt] text-black shadow print:shadow-none" style={{ width: '100mm', height: '150mm' }}>
              <div className="flex items-start justify-between border-b border-black pb-2">
                <div>
                  <p className="text-[8pt] uppercase">Box</p>
                  <p className="text-[18pt] font-bold leading-tight">{box}</p>
                  <p className="text-[8pt]">Box {i + 1} of {boxes.length}</p>
                </div>
                <div className="text-right">
                  <p className="text-[8pt] uppercase">Devices</p>
                  <p className="text-[18pt] font-bold leading-tight">{items.length}</p>
                </div>
              </div>
              <div className="mt-2 flex justify-center"><Barcode value={box} /></div>
              <div className="mt-2 border-t border-black pt-2">
                <p className="text-[8pt] uppercase">Deliver to</p>
                <p className="font-bold">{wo.province_code} - {wo.institution_name.toUpperCase()}</p>
                <p>EMIS {wo.emis_number}</p>
              </div>
              <div className="mt-2 flex items-end justify-between border-t border-black pt-2">
                <div><p className="text-[8pt] uppercase">Work order</p><p className="font-bold">{wo.wo_number}</p></div>
                <Barcode value={wo.wo_number} height={30} />
              </div>
              <table className="mt-2 w-full border-collapse text-[7.5pt]">
                <thead><tr className="border-b border-black text-left"><th>Serial</th><th>Asset tag</th><th>Device</th></tr></thead>
                <tbody>{items.slice(0, 18).map((d) => (
                  <tr key={d.asset_tag} className="border-b border-slate-300"><td className="font-mono">{d.serial_number ?? ''}</td><td className="font-mono">{d.asset_tag}</td><td>{d.device_type}</td></tr>
                ))}</tbody>
              </table>
              {items.length > 18 && <p className="mt-1 text-[7.5pt]">+ {items.length - 18} more device(s) — see the dispatch manifest.</p>}
              <p className="mt-auto pt-1 text-right text-[7pt]">Printed {formatDateNumeric(new Date())}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
