import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDownToLine, CalendarDays, CheckCircle2, ClipboardList, Clock, Cpu, FilePlus2, History, PackageCheck,
  Receipt, RefreshCw, ShieldAlert, Truck, Wrench,
} from 'lucide-react';
import { fetchAll, rpc } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ErrorState, LoadingState } from '@/components/common';
import type { AnchorPositions, ZoneKey } from './warehouseScene';
import './dashboard.css';

interface Summary {
  work_orders: Record<string, number>;
  devices: Record<string, number>;
  invoices: Record<string, number>;
  deliveries_pending: number;
  open_discrepancies: number;
  wo_by_status: { status: string; count: number }[];
  wo_by_province: { province: string; count: number }[];
  devices_by_category: { category: string; condition: string; count: number }[];
  stock_by_warehouse: { warehouse: string; available: number; reserved: number; repair: number }[];
  allocations_by_institution: { institution: string; count: number }[];
  repairs_by_status: { status: string; count: number }[];
  monthly_dispatch: { month: string; dispatches: number; devices: number }[];
  invoice_totals: { month: string; invoiced_cents: number; outstanding_cents: number }[];
  low_stock: { warehouse: string; model: string; available: number; threshold: number }[];
  overdue_tasks: { type: string; id: string; reference: string; status: string; due: string }[];
}
interface Activity { id: number; to_status: string; from_status: string | null; reason: string | null; changed_at: string; work_orders: { id: string; wo_number: string } | null }

const n = (v: number | undefined | null) => (v ?? 0).toLocaleString('en-ZA');
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// which Work Orders tab a status sits in, so the pipeline bars open the right list
const TAB_OF: Record<string, string> = {
  pending_authorisation: 'pending_authorisation', pending_scheduling: 'pending_scheduling',
  scheduled: 'issued', scheduled_pending_issuing: 'issued', issuing_in_progress: 'issued',
  issued: 'completed', pending_invoicing: 'completed', invoiced: 'completed', ready_for_dispatch: 'completed',
  partially_dispatched: 'dispatched', dispatched: 'dispatched', partially_delivered: 'dispatched', delivered: 'dispatched', completed: 'dispatched',
};
const ACTIVITY_ICON: Record<string, typeof Clock> = {
  pending_authorisation: Clock, pending_scheduling: CalendarDays, scheduled: CalendarDays, issuing_in_progress: PackageCheck, issued: PackageCheck,
  invoiced: Receipt, pending_invoicing: Receipt, ready_for_dispatch: Truck, dispatched: Truck, partially_dispatched: Truck,
  delivered: CheckCircle2, completed: CheckCircle2, cancelled: AlertTriangle, rejected: AlertTriangle,
};

/** Column chart in the Stock Room style: dark gradient bars, light grid, round tooltip. Optional second series in light blue. */
function ColumnChart({ data, label, unit, alt }: { data: { key: string; label: string; a: number; b?: number }[]; label: string; unit: [string, string]; alt?: [string, string] }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 1000, H = 240, L = 40, R = 8, T = 14, B = 28;
  const max = Math.max(4, ...data.map((d) => Math.max(d.a, d.b ?? 0)));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const iw = W - L - R, ih = H - T - B;
  const bw = iw / Math.max(1, data.length);
  const pair = alt !== undefined;
  const barW = Math.min(pair ? 18 : 26, (pair ? bw / 2 : bw) - 6);
  const y = (v: number) => T + ih - (v / top) * ih;
  const path = (x: number, v: number) => {
    const h = Math.max(v ? 3 : 0, (v / top) * ih);
    if (!h) return '';
    const yy = T + ih - h, r = Math.min(4, h);
    return `M${x},${T + ih} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${T + ih} Z`;
  };
  const show = (e: React.MouseEvent, cx: number, v: number, text: string) => {
    const s = (ref.current?.getBoundingClientRect().width ?? W) / W;
    setTip({ x: cx * s, y: y(v) * s, text });
    e.stopPropagation();
  };
  const plural = (v: number, u: [string, string]) => `${n(v)} ${v === 1 ? u[0] : u[1]}`;
  return (
    <div className="chart" onMouseLeave={() => setTip(null)}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <defs><linearGradient id="fdBarGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a3a36" /><stop offset="1" stopColor="#1d1d1b" /></linearGradient></defs>
        {[0, top / 2, top].map((v) => (
          <g key={v}><line className="grid-line" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text className="axis-text" x={L - 6} y={y(v) + 4} textAnchor="end">{n(Math.round(v))}</text></g>
        ))}
        <line x1={L} x2={W - R} y1={T + ih} y2={T + ih} stroke="#d3dce3" />
        {data.map((d, i) => {
          const x = L + i * bw + (bw - (pair ? barW * 2 + 4 : barW)) / 2;
          const showX = data.length <= 8 || i % 2 === (data.length - 1) % 2;
          const text = `${d.label}: ${plural(d.a, unit)}${pair ? ` · ${plural(d.b ?? 0, alt!)}` : ''}`;
          const peak = Math.max(d.a, d.b ?? 0);
          return (
            <g key={d.key} onMouseMove={(e) => show(e, L + i * bw + bw / 2, peak, text)}>
              <rect className="hit" x={L + i * bw} y={T} width={bw} height={ih} />
              <path className="bar" d={path(x, d.a)} />
              {pair && <path className="bar alt" d={path(x + barW + 4, d.b ?? 0)} />}
              {showX && <text className="axis-text" x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {tip && <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

function HBars({ rows, empty }: { rows: { key: string; name: string; value: number; to?: string; parts?: { v: number; cls?: string }[]; title?: string; display?: string }[]; empty: string }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hbars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="name">{r.name}</span>
            <span className="track">
              {(r.parts ?? [{ v: r.value }]).filter((p) => p.v > 0).map((p, i) => <span key={i} className={`fill ${p.cls ?? ''}`} style={{ width: `${(p.v / max) * 100}%` }} />)}
            </span>
            <span className="val">{r.display ?? n(r.value)}</span>
          </>
        );
        const title = r.title ?? `${r.name}: ${n(r.value)}`;
        return r.to ? <Link key={r.key} to={r.to} className="hbar" title={title}>{inner}</Link> : <div key={r.key} className="hbar" title={title}>{inner}</div>;
      })}
    </div>
  );
}

interface Zone { key: ZoneKey; title: string; value: string; label: string; foot?: string; to: string; alert?: boolean }

/** The live 3D warehouse with a floating summary label over each area. */
function WarehouseStage({ zones, brand }: { zones: Zone[]; brand: string }) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<Partial<Record<ZoneKey, HTMLAnchorElement | null>>>({});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    const onAnchors = (a: AnchorPositions) => {
      const width = host.current?.clientWidth ?? 0;
      for (const [k, p] of Object.entries(a) as [ZoneKey, { x: number; y: number; visible: boolean }][]) {
        const el = labels.current[k];
        if (!el) continue;
        // keep the whole label inside the stage
        const half = el.offsetWidth / 2 + 8;
        const x = Math.min(Math.max(p.x, half), Math.max(half, width - half));
        el.style.transform = `translate(${x}px, ${p.y}px) translate(-50%, -100%)`;
        el.classList.toggle('off', !p.visible);
      }
    };
    // three.js loads on demand so the rest of the app stays light
    import('./warehouseScene').then(({ startWarehouseScene }) => {
      if (cancelled || !host.current) return;
      const s = startWarehouseScene(host.current, { brand, onAnchors });
      if (!s) setFailed(true); else stop = s.stop;
    }).catch(() => setFailed(true));
    return () => { cancelled = true; stop?.(); };
  }, [brand]);
  return (
    <section className="panel stage" aria-label="Warehouse overview">
      <div ref={host} className="stage-canvas" aria-hidden />
      {failed && <div className="stage-fallback">3D view is not available in this browser.</div>}
      <div className="stage-title"><span className="chip-sr">● Live warehouse</span><span className="chip-sr">Click an area to open it</span></div>
      {zones.map((z) => (
        <Link key={z.key} to={z.to} ref={(el) => { labels.current[z.key] = el; }} className={`zone off${z.alert ? ' alert' : ''}`}
          aria-label={`${z.title}: ${z.value} ${z.label}${z.foot ? `, ${z.foot}` : ''}`}>
          <span className="zt"><i />{z.title}</span>
          <span className="zv">{z.value}</span>
          <span className="zl">{z.label}</span>
          {z.foot && <span className="zf">{z.foot}</span>}
        </Link>
      ))}
    </section>
  );
}

export function DashboardPage() {
  const { can, profile, roles, branding } = useAuth();
  const summary = useQuery({ queryKey: ['dashboard'], queryFn: () => rpc<Summary>('dashboard_summary'), refetchInterval: 60_000 });
  const activity = useQuery({
    queryKey: ['dashboard', 'activity'],
    enabled: can('work_orders.view'),
    queryFn: () => fetchAll<Activity>('work_order_status_history', 'id, to_status, from_status, reason, changed_at, work_orders(id, wo_number)',
      (q) => q.order('changed_at', { ascending: false }).limit(8)),
  });
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 13);
  const movements = useQuery({
    queryKey: ['dashboard', 'movements', dayKey(since)],
    enabled: can('inventory.view'),
    queryFn: () => fetchAll<{ performed_at: string }>('v_device_movements', 'performed_at', (q) => q.gte('performed_at', since.toISOString())),
  });

  if (summary.isLoading) return <LoadingState />;
  if (summary.error) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const s = summary.data!;
  const wo = s.work_orders, dv = s.devices, inv = s.invoices;
  const firstName = profile?.full_name?.split(' ')[0];
  const seeInvoices = can('invoices.view');

  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(since); d.setDate(d.getDate() + i); return d; });
  const perDay = new Map<string, number>();
  for (const m of movements.data ?? []) { const k = dayKey(new Date(m.performed_at)); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  const dayData = days.map((d) => ({ key: dayKey(d), label: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }), a: perDay.get(dayKey(d)) ?? 0 }));

  const byCategory = Object.values(s.devices_by_category.reduce<Record<string, { name: string; total: number; good: number }>>((acc, r) => {
    acc[r.category] ??= { name: r.category, total: 0, good: 0 };
    acc[r.category].total += r.count;
    if (['new', 'good', 'refurbished'].includes(r.condition)) acc[r.category].good += r.count;
    return acc;
  }, {})).sort((a, b) => b.total - a.total);

  const zones: Zone[] = [
    { key: 'work_orders', title: 'Work orders', value: n(wo.total), label: 'work orders', foot: `${n(wo.pending_authorisation)} awaiting authorisation`, to: '/work-orders?tab=pending_authorisation', alert: wo.pending_authorisation > 0 },
    { key: 'stock', title: 'Stock', value: n(dv.available), label: 'devices available', foot: `${n(dv.reserved)} reserved · ${n(dv.total)} registered`, to: '/warehouse' },
    { key: 'issuing', title: 'Issuing', value: n(wo.pending_issuing), label: 'pending issuing', foot: `${n(wo.scheduled)} scheduled`, to: '/work-orders?tab=issued' },
    { key: 'repairs', title: 'Repairs', value: n(dv.in_repair), label: 'in repair', foot: `${n(dv.awaiting_assessment)} awaiting assessment`, to: '/repairs', alert: dv.awaiting_assessment > 0 },
    { key: 'discrepancies', title: 'Quarantine', value: n(s.open_discrepancies), label: 'open discrepancies', to: '/discrepancies', alert: s.open_discrepancies > 0 },
    { key: 'dispatch', title: 'Dispatch dock', value: n(wo.pending_dispatch), label: 'ready to dispatch', foot: `${n(wo.dispatched)} in delivery · ${n(s.deliveries_pending)} to confirm`, to: '/dispatch' },
    ...(seeInvoices ? [{ key: 'invoicing' as const, title: 'Invoicing', value: n(inv.outstanding_count), label: 'outstanding invoices', foot: formatMoney(inv.outstanding_cents), to: '/invoicing?status=outstanding', alert: inv.overdue_count > 0 }] : []),
  ];

  const kpi = (v: number, l: string, to: string, Icon: typeof Clock, flag?: string | false) => (
    <Link className="kpi" to={to}>
      <div className="kpi-ic"><Icon aria-hidden /></div><div className="v">{n(v)}</div><div className="l">{l}</div>{flag ? <span className="flag">{flag}</span> : null}
    </Link>
  );

  const pipeline = [
    ['pending_authorisation', 'Pending authorisation', wo.pending_authorisation, '/work-orders?tab=pending_authorisation'],
    ['pending_scheduling', 'Pending scheduling', wo.pending_scheduling, '/work-orders?tab=pending_scheduling'],
    ['scheduled', 'Scheduled', wo.scheduled, '/work-orders?tab=issued'],
    ['pending_issuing', 'Pending issuing', wo.pending_issuing, '/work-orders?tab=issued'],
    ['issued', 'Issued', wo.issued, '/work-orders?tab=completed'],
    ['pending_dispatch', 'Pending dispatch', wo.pending_dispatch, '/dispatch'],
    ['dispatched', 'Dispatched / in delivery', wo.dispatched, '/work-orders?tab=dispatched'],
    ['deliveries', 'Delivery to confirm', s.deliveries_pending, '/delivery'],
    ['completed', 'Completed', wo.completed, '/work-orders?tab=dispatched'],
  ] as const;

  return (
    <div className="fd">
      <section className="hero">
        <div className="hero-text">
          <h1>{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
          <span className="chip-sr">● {branding.appName}{roles.length ? ` · ${roles.join(', ')}` : ''}</span>
          <span className="chip-sr">Updated {summary.dataUpdatedAt ? new Date(summary.dataUpdatedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
        </div>
        <div className="hero-actions">
          {can('work_orders.create') && <Link className="btn sm" to="/work-orders/new"><FilePlus2 aria-hidden /> New work order</Link>}
          {can('inventory.view') && <Link className="btn sm" to="/warehouse"><ArrowDownToLine aria-hidden /> Receive</Link>}
          {can('dispatch.view') && <Link className="btn sm" to="/dispatch"><Truck aria-hidden /> Dispatch</Link>}
          <button type="button" className="btn sm" onClick={() => { void summary.refetch(); void activity.refetch(); void movements.refetch(); }} aria-label="Refresh dashboard">
            <RefreshCw aria-hidden className={summary.isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </section>

      <WarehouseStage zones={zones} brand={branding.appName} />

      <div className="kpis">
        {kpi(dv.available, `Devices available · ${n(dv.total)} registered`, '/devices?status=available', Cpu)}
        {kpi(wo.pending_authorisation, 'Pending authorisation', '/work-orders?tab=pending_authorisation', Clock, wo.pending_authorisation > 0 && 'Action needed')}
        {kpi(wo.pending_issuing, 'Pending issuing', '/work-orders?tab=issued', PackageCheck, wo.scheduled > 0 && `${n(wo.scheduled)} scheduled`)}
        {kpi(wo.pending_dispatch, 'Ready for dispatch', '/dispatch', Truck, s.deliveries_pending > 0 && `${n(s.deliveries_pending)} to confirm`)}
        {kpi(dv.in_repair + dv.awaiting_assessment, 'In repair / assessment', '/repairs', Wrench, dv.awaiting_assessment > 0 && `${n(dv.awaiting_assessment)} awaiting`)}
        {seeInvoices
          ? kpi(inv.outstanding_count, `Outstanding invoices · ${formatMoney(inv.outstanding_cents)}`, '/invoicing?status=outstanding', Receipt, inv.overdue_count > 0 && `${n(inv.overdue_count)} overdue`)
          : kpi(s.open_discrepancies, 'Open serial discrepancies', '/discrepancies', ShieldAlert, s.open_discrepancies > 0 && 'Review')}
      </div>

      {can('inventory.view') && (
        <div className="panel">
          <div className="panel-head"><h2>Device movements per day</h2><span className="muted small">last 14 days · received, reserved, issued, dispatched, returned, repaired</span>
            <span className="spacer" /><Link className="small" to="/movements">All</Link></div>
          {movements.error ? <div className="empty">Could not load movements.</div> : <ColumnChart data={dayData} label="Device movements per day, last 14 days" unit={['movement', 'movements']} />}
        </div>
      )}

      <div className="dash-grid three">
        <div className="panel">
          <div className="panel-head"><h2>Work order pipeline</h2><span className="spacer" /><Link className="small" to="/work-orders">All</Link></div>
          <HBars empty="No work orders yet" rows={pipeline.map(([k, name, v, to]) => ({ key: k, name, value: v ?? 0, to }))} />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Stock by warehouse</h2><span className="spacer" /><Link className="small" to="/warehouse">Warehouse</Link></div>
          <HBars empty="No stock yet" rows={s.stock_by_warehouse.map((w) => ({
            key: w.warehouse, name: w.warehouse, value: w.available + w.reserved + w.repair, to: '/warehouse',
            title: `${w.warehouse}: ${n(w.available)} available, ${n(w.reserved)} reserved / issued, ${n(w.repair)} faulty / repair`,
            parts: [{ v: w.available, cls: 'blue' }, { v: w.reserved }, { v: w.repair, cls: 'grey' }],
          }))} />
          {s.stock_by_warehouse.length > 0 && <div className="legend mt-3"><span><i className="alt" />Available</span><span><i />Reserved / issued</span><span><i style={{ background: '#aab6c0' }} />Faulty / repair</span></div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Devices by category</h2><span className="spacer" /><Link className="small" to="/devices">Register</Link></div>
          <HBars empty="No devices yet" rows={byCategory.slice(0, 9).map((c) => ({ key: c.name, name: c.name, value: c.total, to: '/devices' }))} />
        </div>
      </div>

      <div className="dash-grid two">
        <div className="panel">
          <div className="panel-head"><h2>Monthly dispatch volume</h2><span className="spacer" /><span className="legend"><span><i />Devices</span><span><i className="alt" />Shipments</span></span></div>
          {s.monthly_dispatch.length
            ? <ColumnChart data={s.monthly_dispatch.map((m) => ({ key: m.month, label: m.month, a: m.devices, b: m.dispatches }))} label="Monthly dispatch volume" unit={['device', 'devices']} alt={['shipment', 'shipments']} />
            : <div className="empty">Nothing dispatched yet</div>}
        </div>
        {seeInvoices ? (
          <div className="panel">
            <div className="panel-head"><h2>Invoicing</h2><span className="spacer" /><Link className="small" to="/invoicing">All</Link></div>
            <div className="money">
              <Link to="/invoicing?status=outstanding"><b>{formatMoney(inv.outstanding_cents)}</b><small>{n(inv.outstanding_count)} outstanding</small></Link>
              <Link to="/invoicing?status=overdue"><b className={inv.overdue_count ? 'q-neg' : ''}>{formatMoney(inv.overdue_cents)}</b><small>{n(inv.overdue_count)} overdue</small></Link>
            </div>
            <HBars empty="No invoices yet" rows={s.invoice_totals.slice(-6).map((r) => ({
              key: r.month, name: r.month, value: Math.round(r.invoiced_cents / 100), to: '/invoicing', display: `R${Math.round(r.invoiced_cents / 100000)}k`,
              title: `${r.month}: ${formatMoney(r.invoiced_cents)} invoiced, ${formatMoney(r.outstanding_cents)} outstanding`,
              parts: [{ v: Math.round((r.invoiced_cents - r.outstanding_cents) / 100) }, { v: Math.round(r.outstanding_cents / 100), cls: 'blue' }],
            }))} />
          </div>
        ) : (
          <div className="panel">
            <div className="panel-head"><h2>Repairs by status</h2><span className="spacer" /><Link className="small" to="/repairs">All</Link></div>
            <HBars empty="No repairs" rows={s.repairs_by_status.map((r) => ({ key: r.status, name: labelize(r.status), value: r.count, to: '/repairs' }))} />
          </div>
        )}
      </div>

      <div className="dash-grid three">
        <div className="panel">
          <div className="panel-head"><h2>Work orders by province</h2></div>
          <HBars empty="No work orders yet" rows={[...s.wo_by_province].sort((a, b) => b.count - a.count).map((p) => ({ key: p.province, name: p.province, value: p.count }))} />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Top institutions</h2><span className="muted small">devices allocated</span></div>
          <HBars empty="No allocations yet" rows={s.allocations_by_institution.map((r) => ({ key: r.institution, name: r.institution, value: r.count }))} />
        </div>
        {seeInvoices ? (
          <div className="panel">
            <div className="panel-head"><h2>Repairs by status</h2><span className="spacer" /><Link className="small" to="/repairs">All</Link></div>
            <HBars empty="No repairs" rows={s.repairs_by_status.map((r) => ({ key: r.status, name: labelize(r.status), value: r.count, to: '/repairs' }))} />
          </div>
        ) : (
          <div className="panel">
            <div className="panel-head"><h2>Work orders by status</h2></div>
            <HBars empty="No work orders yet" rows={s.wo_by_status.map((r) => ({ key: r.status, name: labelize(r.status), value: r.count, to: `/work-orders?tab=${TAB_OF[r.status] ?? 'pending_authorisation'}` }))} />
          </div>
        )}
      </div>

      <div className="dash-grid three">
        <div className="panel">
          <div className="panel-head"><h2>Low stock</h2><span className="spacer" /><Link className="small" to="/warehouse">Warehouse</Link></div>
          {s.low_stock.length ? (
            <div className="feed">{s.low_stock.map((r) => (
              <div key={`${r.warehouse}-${r.model}`} className="feed-item">
                <span className="dot"><AlertTriangle aria-hidden /></span>
                <span className="t"><b>{r.model}</b><small>{r.warehouse} · {n(r.available)} available · threshold {n(r.threshold)}</small>
                  <div className="meter"><span style={{ width: `${Math.min(100, (r.available / Math.max(1, r.threshold)) * 100)}%` }} /></div></span>
                <span className="q q-neg">{r.available - r.threshold}</span>
              </div>
            ))}</div>
          ) : <div className="empty">All stock is above its threshold.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Overdue tasks</h2>{s.overdue_tasks.length > 8 && <span className="muted small">8 of {n(s.overdue_tasks.length)}</span>}</div>
          {s.overdue_tasks.length ? (
            <div className="feed">{s.overdue_tasks.slice(0, 8).map((t) => (
              <Link key={`${t.type}-${t.id}`} className="feed-item"
                to={t.type === 'invoice' ? `/invoicing/${t.id}` : t.type === 'dispatch' ? `/dispatch/${t.id}` : `/work-orders/${t.id}/view`}>
                <span className="dot">{t.type === 'invoice' ? <Receipt aria-hidden /> : t.type === 'dispatch' ? <Truck aria-hidden /> : <ClipboardList aria-hidden />}</span>
                <span className="t"><b>{t.reference}</b><small>{labelize(t.type)} · {labelize(t.status)}</small></span>
                <span className="q q-neg">{formatDate(t.due)}</span>
              </Link>
            ))}</div>
          ) : <div className="empty">Nothing overdue</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Recent activity</h2><span className="spacer" /><Link className="small" to="/work-orders">All</Link></div>
          {activity.data?.length ? (
            <div className="feed">{activity.data.map((a) => {
              const Icon = ACTIVITY_ICON[a.to_status] ?? History;
              return (
                <Link key={a.id} className="feed-item" to={a.work_orders ? `/work-orders/${a.work_orders.id}/view` : '/work-orders'}>
                  <span className="dot"><Icon aria-hidden /></span>
                  <span className="t"><b>{a.work_orders?.wo_number ?? 'Work order'}</b><small>{labelize(a.to_status)} · {formatDateTime(a.changed_at)}</small></span>
                  <span className="q" />
                </Link>
              );
            })}</div>
          ) : <div className="empty">No activity yet</div>}
        </div>
      </div>
    </div>
  );
}
