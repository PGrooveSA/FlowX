import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Pause, Play, Printer, RotateCcw, ScanBarcode, Settings2, Trash2, Upload, XCircle } from 'lucide-react';
import { rpc } from '@/lib/api';
import { labelize } from '@/lib/utils';
import { downloadCsv } from '@/lib/csv';
import { DEVICE_CONDITIONS } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { opts, useCategories, useLocations, useModels, useSuppliers, useWarehouses } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { PageHeader } from '@/components/common';

type ScanField = 'asset_tag' | 'serial_number' | 'imei';
const FIELD_LABEL: Record<ScanField, string> = { asset_tag: 'Asset tag', serial_number: 'Serial number', imei: 'IMEI' };
const ORDERS: Record<string, ScanField[]> = {
  tag_serial_imei: ['asset_tag', 'serial_number', 'imei'],
  serial_imei_tag: ['serial_number', 'imei', 'asset_tag'],
  serial_tag_imei: ['serial_number', 'asset_tag', 'imei'],
};
const ORDER_LABEL: Record<string, string> = {
  tag_serial_imei: 'Asset tag → Serial → IMEI',
  serial_imei_tag: 'Serial → IMEI → Asset tag',
  serial_tag_imei: 'Serial → Asset tag → IMEI',
};

interface Settings {
  model_id: string; condition: string; warehouse_id: string; location_id: string; supplier_id: string;
  acquisition_reference: string; purchase_date: string; notes: string;
  scanTag: boolean; scanImei: boolean; order: string;
}
const DEFAULTS: Settings = {
  model_id: '', condition: 'new', warehouse_id: '', location_id: '', supplier_id: '', acquisition_reference: '', purchase_date: '', notes: '',
  scanTag: true, scanImei: false, order: 'tag_serial_imei',
};
const STORE = 'df.batchScan.settings';

interface Row {
  n: number; asset_tag: string; serial_number: string; imei: string;
  state: 'saving' | 'saved' | 'failed'; message?: string; device_id?: string; saved_tag?: string;
  base: Settings;   // the batch settings in force when the device was scanned
}

const norm = (v: string) => v.trim().toUpperCase().replace(/[\s-]/g, '');

// short tones so the operator does not have to look at the screen after every scan
let audio: AudioContext | null = null;
function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const tones = ok ? [[1320, 0.07]] : [[220, 0.14], [180, 0.18]];
    let t = audio.currentTime;
    for (const [f, d] of tones) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = ok ? 'sine' : 'square';
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + d); t += d + 0.04;
    }
  } catch { /* no audio available */ }
}

/** Register a run of identical devices by scanning only what differs per device: asset tag, serial and IMEI. */
export function BatchScanPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const models = useModels().data;
  const categories = useCategories().data;
  const warehouses = useWarehouses().data;
  const suppliers = useSuppliers().data;
  const [s, setS] = useState<Settings>(() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }; } catch { return DEFAULTS; }
  });
  const locations = useLocations(s.warehouse_id).data;
  const model = models?.find((m) => m.id === s.model_id);
  const cat = categories?.find((c) => c.id === model?.category_id);
  const imeiRequired = Boolean(cat?.requires_imei);
  const scanImei = imeiRequired || s.scanImei;
  const steps = useMemo(() => ORDERS[s.order].filter((f) => (f === 'asset_tag' ? s.scanTag : f === 'imei' ? scanImei : true)), [s.order, s.scanTag, scanImei]);

  const [running, setRunning] = useState(false);
  const [values, setValues] = useState<Record<ScanField, string>>({ asset_tag: '', serial_number: '', imei: '' });
  const [step, setStep] = useState(0);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const counter = useRef(0);
  const seen = useRef({ asset_tag: new Set<string>(), serial_number: new Set<string>(), imei: new Set<string>() });
  const inputs = useRef<Partial<Record<ScanField, HTMLInputElement | null>>>({});
  const queue = useRef<Row[]>([]);
  const working = useRef(false);

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage unavailable */ } }, [s]);
  useEffect(() => { if (running) inputs.current[steps[step]]?.focus(); }, [running, step, steps]);

  const set = (k: keyof Settings, v: string | boolean) => setS((o) => ({ ...o, [k]: v, ...(k === 'warehouse_id' ? { location_id: '' } : {}) }));
  const ready = Boolean(s.model_id && s.warehouse_id && s.condition);

  const patch = (n: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.n === n ? { ...r, ...p } : r)));

  // saves one device at a time in the order scanned, so scanning never waits for the server
  const pump = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    while (queue.current.length) {
      const r = queue.current.shift()!;
      const b = r.base;
      try {
        const res = await rpc<{ id: string; asset_tag: string }>('register_device', { p: {
          model_id: b.model_id, condition: b.condition, warehouse_id: b.warehouse_id, location_id: b.location_id || undefined,
          supplier_id: b.supplier_id || undefined, acquisition_reference: b.acquisition_reference || undefined,
          purchase_date: b.purchase_date || undefined, notes: b.notes || undefined,
          asset_tag: r.asset_tag || undefined, serial_number: r.serial_number, imei: r.imei || undefined,
        } });
        patch(r.n, { state: 'saved', device_id: res.id, saved_tag: res.asset_tag, message: undefined });
      } catch (e) {
        beep(false);
        // forget the values, so the device can be scanned again once the problem is fixed
        seen.current.serial_number.delete(norm(r.serial_number));
        if (r.asset_tag) seen.current.asset_tag.delete(norm(r.asset_tag));
        if (r.imei) seen.current.imei.delete(norm(r.imei));
        patch(r.n, { state: 'failed', message: (e as Error).message });
      }
    }
    working.current = false;
    void qc.invalidateQueries({ queryKey: ['devices'] });
  }, [qc]);

  const fail = (msg: string) => {
    beep(false);
    setFieldError(msg);
    setValues((v) => ({ ...v, [steps[step]]: '' }));
    inputs.current[steps[step]]?.focus();
  };

  const accept = () => {
    const field = steps[step];
    const raw = values[field].trim();
    if (!raw) return;
    if (field === 'imei' && !/^\d{14,16}$/.test(raw)) return fail(`"${raw}" is not an IMEI (14–16 digits). Scan the IMEI barcode.`);
    if (raw.length > (field === 'asset_tag' ? 40 : 64)) return fail(`${FIELD_LABEL[field]} is too long.`);
    if (seen.current[field].has(norm(raw))) return fail(`${FIELD_LABEL[field]} ${raw} was already scanned in this batch.`);
    // a scan of the wrong label: the same value already used for another field of this device
    const others = steps.filter((f) => f !== field).map((f) => norm(values[f]));
    if (others.includes(norm(raw))) return fail(`${raw} was just scanned as another field. Scan the ${FIELD_LABEL[field].toLowerCase()}.`);
    setFieldError(null);
    const next = { ...values, [field]: raw };
    if (step < steps.length - 1) { setValues(next); setStep(step + 1); return; }
    // last field: queue the device and start on the next one
    counter.current += 1;
    const row: Row = { n: counter.current, asset_tag: next.asset_tag, serial_number: next.serial_number, imei: next.imei, state: 'saving', base: s };
    for (const f of steps) seen.current[f].add(norm(next[f]));
    setRows((rs) => [row, ...rs].slice(0, 2000));
    queue.current.push(row);
    void pump();
    beep(true);
    setValues({ asset_tag: '', serial_number: '', imei: '' });
    setStep(0);
  };

  const retry = (r: Row) => {
    for (const f of steps) if (r[f]) seen.current[f].add(norm(r[f]));
    patch(r.n, { state: 'saving', message: undefined });
    queue.current.push(r);
    void pump();
  };
  const remove = (r: Row) => setRows((rs) => rs.filter((x) => x.n !== r.n));
  const resetCurrent = () => { setValues({ asset_tag: '', serial_number: '', imei: '' }); setStep(0); setFieldError(null); };

  const saved = rows.filter((r) => r.state === 'saved');
  const failed = rows.filter((r) => r.state === 'failed');
  const saving = rows.filter((r) => r.state === 'saving').length;

  const exportCsv = () => downloadCsv([...rows].reverse(), [
    { header: '#', value: (r) => r.n }, { header: 'Asset tag', value: (r) => r.saved_tag ?? r.asset_tag },
    { header: 'Serial number', value: (r) => r.serial_number }, { header: 'IMEI', value: (r) => r.imei },
    { header: 'Result', value: (r) => r.state }, { header: 'Message', value: (r) => r.message ?? '' },
  ], `batch-scan-${new Date().toISOString().slice(0, 10)}.csv`);
  const printLabels = () => {
    const ids = saved.map((r) => r.device_id!).slice(0, 400);
    window.open(`/print/labels?ids=${ids.join(',')}`, '_blank', 'noopener');
  };

  return (
    <div>
      <PageHeader title="Batch scan devices" crumbs={[{ label: 'Device Register', to: '/devices' }, { label: 'Batch scan' }]}
        description="Set what all the devices have in common once, then scan each device's labels. Every device is registered as soon as its last label is scanned — no button to press."
        actions={can('data.import') ? <Button variant="outline" asChild><Link to="/devices/import"><Upload /> Import a spreadsheet instead</Link></Button> : undefined} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card>
          <CardHeader><CardTitle>1. What every device in this batch shares</CardTitle>
            {running && <Button size="sm" variant="outline" onClick={() => setRunning(false)}><Settings2 /> Change</Button>}</CardHeader>
          <CardContent>
            <fieldset disabled={running} className="grid gap-3 disabled:opacity-70">
              <Field label="Model" htmlFor="b-model" required>
                <Select id="b-model" placeholder="Select…" value={s.model_id} onChange={(e) => set('model_id', e.target.value)}
                  options={opts(models?.filter((m) => m.is_active), (m) => `${m.manufacturer} ${m.model_name}`)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Condition" htmlFor="b-cond" required>
                  <Select id="b-cond" value={s.condition} onChange={(e) => set('condition', e.target.value)} options={DEVICE_CONDITIONS.map((c) => ({ value: c, label: labelize(c) }))} />
                </Field>
                <Field label="Purchase date" htmlFor="b-pd"><Input id="b-pd" type="date" value={s.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Warehouse" htmlFor="b-wh" required>
                  <Select id="b-wh" placeholder="Select…" value={s.warehouse_id} onChange={(e) => set('warehouse_id', e.target.value)} options={opts(warehouses?.filter((w) => w.is_active), (w) => w.code)} />
                </Field>
                <Field label="Storage location" htmlFor="b-loc">
                  <Select id="b-loc" placeholder="Unassigned" disabled={!s.warehouse_id} value={s.location_id} onChange={(e) => set('location_id', e.target.value)} options={opts(locations, (l) => l.code)} />
                </Field>
              </div>
              <Field label="Supplier" htmlFor="b-sup"><Select id="b-sup" placeholder="—" value={s.supplier_id} onChange={(e) => set('supplier_id', e.target.value)} options={opts(suppliers, (x) => x.name)} /></Field>
              <Field label="Purchase / acquisition reference" htmlFor="b-ref"><Input id="b-ref" value={s.acquisition_reference} onChange={(e) => set('acquisition_reference', e.target.value)} /></Field>
              <Field label="Notes" htmlFor="b-notes"><Input id="b-notes" value={s.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
              <div className="space-y-2 rounded-2xl border border-white/80 bg-white/40 p-3">
                <p className="text-sm font-medium">Labels to scan on each device</p>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked readOnly disabled /> Serial number (always)</label>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={s.scanTag} onChange={(e) => set('scanTag', e.target.checked)} /> Asset tag <span className="text-xs text-muted-foreground">(off: numbers are given automatically)</span></label>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={scanImei} disabled={imeiRequired} onChange={(e) => set('scanImei', e.target.checked)} /> IMEI {imeiRequired && <span className="text-xs text-muted-foreground">(required for {cat?.name})</span>}</label>
                <Field label="Scan order" htmlFor="b-order">
                  <Select id="b-order" value={s.order} onChange={(e) => set('order', e.target.value)} options={Object.keys(ORDERS).map((k) => ({ value: k, label: ORDER_LABEL[k] }))} />
                </Field>
              </div>
            </fieldset>
            {!running && <Button className="mt-4 w-full" size="lg" disabled={!ready} onClick={() => { resetCurrent(); setRunning(true); }}><Play /> Start scanning</Button>}
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>2. Scan each device</CardTitle>
              {running && <Button size="sm" variant="outline" onClick={() => setRunning(false)}><Pause /> Pause</Button>}
            </CardHeader>
            <CardContent>
              {!running ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <ScanBarcode className="mx-auto mb-2 h-10 w-10 opacity-60" aria-hidden />
                  {ready ? 'Press Start scanning, then scan the labels on the first device.' : 'Choose the model and warehouse first.'}
                </div>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); accept(); }} className="space-y-3" autoComplete="off">
                  <p className="text-sm text-muted-foreground">
                    Device <b className="text-foreground">{counter.current + 1}</b> · {model ? `${model.manufacturer} ${model.model_name}` : ''} · {labelize(s.condition)}.
                    Your scanner's Enter moves to the next label; the device is saved after the last one.
                  </p>
                  <div className={`grid gap-3 ${steps.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
                    {steps.map((f, i) => (
                      <Field key={f} label={`${i + 1}. ${FIELD_LABEL[f]}`} htmlFor={`scan-${f}`}>
                        <Input id={`scan-${f}`} ref={(el) => { inputs.current[f] = el; }} value={values[f]} inputMode={f === 'imei' ? 'numeric' : undefined}
                          onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} onFocus={() => setStep(i)}
                          aria-invalid={i === step && fieldError ? true : undefined}
                          className={`mono h-12 text-base ${i === step ? 'ring-2 ring-[#8ecff5]' : i < step ? 'opacity-70' : ''}`} />
                      </Field>
                    ))}
                  </div>
                  {fieldError && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50/80 px-3 py-2 text-sm font-medium text-red-800">{fieldError}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="outline" size="sm">Next (Enter)</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={resetCurrent}><RotateCcw /> Start this device again</Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>This session</CardTitle>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-emerald-800"><CheckCircle2 className="h-4 w-4" aria-hidden /> {saved.length} registered</span>
                {saving > 0 && <span className="rounded-full bg-white/70 px-3 py-1">{saving} saving…</span>}
                {failed.length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-3 py-1 text-red-800"><XCircle className="h-4 w-4" aria-hidden /> {failed.length} need attention</span>}
                {can('labels.print') && saved.length > 0 && <Button size="sm" variant="outline" onClick={printLabels}><Printer /> Labels ({Math.min(400, saved.length)})</Button>}
                {rows.length > 0 && <Button size="sm" variant="outline" onClick={exportCsv}><Download /> CSV</Button>}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {rows.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">Scanned devices appear here.</p> : (
                <div className="max-h-[480px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead><tr><th className="w-12">#</th><th>Asset tag</th><th>Serial number</th>{scanImei && <th>IMEI</th>}<th>Result</th><th className="w-20" /></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.n} className={r.state === 'failed' ? 'bg-red-50/70' : ''}>
                          <td className="text-muted-foreground">{r.n}</td>
                          <td className="mono">{r.saved_tag ?? (r.asset_tag || <span className="text-muted-foreground">auto</span>)}</td>
                          <td className="mono">{r.device_id ? <Link className="hover:underline" to={`/devices/${r.device_id}`}>{r.serial_number}</Link> : r.serial_number}</td>
                          {scanImei && <td className="mono">{r.imei || '—'}</td>}
                          <td>{r.state === 'saved' ? <span className="text-emerald-700">Registered</span> : r.state === 'saving' ? <span className="text-muted-foreground">Saving…</span>
                            : <span className="text-red-700">{r.message}</span>}</td>
                          <td className="whitespace-nowrap text-right">
                            {r.state === 'failed' && <>
                              <Button size="icon" variant="ghost" aria-label={`Retry ${r.serial_number}`} title="Try again" onClick={() => retry(r)}><RotateCcw /></Button>
                              <Button size="icon" variant="ghost" aria-label={`Remove ${r.serial_number} from the list`} title="Remove from list" onClick={() => remove(r)}><Trash2 /></Button>
                            </>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
