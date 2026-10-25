import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ClipboardList, Cpu, PackageCheck, Receipt, ShieldAlert, Truck, Wrench, Clock, CheckCircle2, CalendarDays } from 'lucide-react';
import { fetchAll, rpc } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from '@/components/common';

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

const COLORS = ['#1d4ed8', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#475569', '#0d9488', '#ea580c'];
const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-ZA');

function ChartCard({ title, children, empty }: { title: string; children: React.ReactNode; empty?: boolean }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="h-64">{empty ? <EmptyState title="No data yet" /> : children}</CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { can, profile } = useAuth();
  const summary = useQuery({ queryKey: ['dashboard'], queryFn: () => rpc<Summary>('dashboard_summary'), refetchInterval: 60_000 });
  const activity = useQuery({
    queryKey: ['dashboard', 'activity'],
    enabled: can('work_orders.view'),
    queryFn: () => fetchAll<{ id: number; to_status: string; from_status: string; reason: string; changed_at: string; work_orders: { id: string; wo_number: string } }>(
      'work_order_status_history', 'id, to_status, from_status, reason, changed_at, work_orders(id, wo_number)', (q) => q.order('changed_at', { ascending: false }).limit(10)),
  });

  if (summary.isLoading) return <LoadingState />;
  if (summary.error) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const s = summary.data!;
  const wo = s.work_orders, dv = s.devices, inv = s.invoices;

  const categoryData = Object.values(s.devices_by_category.reduce<Record<string, Record<string, number | string>>>((acc, r) => {
    acc[r.category] ??= { category: r.category };
    acc[r.category][r.condition] = r.count;
    return acc;
  }, {}));
  const conditions = [...new Set(s.devices_by_category.map((r) => r.condition))];

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`} description="Live operational overview calculated from current records." />

      <section aria-label="Work order summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Total work orders" value={n(wo.total)} icon={ClipboardList} to="/work-orders" />
        <StatCard label="Pending authorisation" value={n(wo.pending_authorisation)} tone={wo.pending_authorisation ? 'warning' : 'default'} icon={Clock} to="/work-orders?tab=pending_authorisation" />
        <StatCard label="Pending scheduling" value={n(wo.pending_scheduling)} icon={CalendarDays} to="/work-orders?tab=pending_scheduling" />
        <StatCard label="Scheduled" value={n(wo.scheduled)} icon={CalendarDays} to="/work-orders?tab=issued" />
        <StatCard label="Pending issuing" value={n(wo.pending_issuing)} icon={PackageCheck} to="/work-orders?tab=issued" />
        <StatCard label="Issued" value={n(wo.issued)} icon={PackageCheck} to="/work-orders?tab=completed" />
        <StatCard label="Pending dispatch" value={n(wo.pending_dispatch)} icon={Truck} to="/dispatch" />
        <StatCard label="Dispatched / in delivery" value={n(wo.dispatched)} icon={Truck} to="/work-orders?tab=dispatched" />
        <StatCard label="Completed" value={n(wo.completed)} tone="success" icon={CheckCircle2} to="/work-orders?tab=dispatched" />
        <StatCard label="Pending delivery confirmation" value={n(s.deliveries_pending)} icon={Truck} to="/delivery" />
      </section>

      <section aria-label="Devices and finance summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Registered devices" value={n(dv.total)} icon={Cpu} to="/devices" />
        <StatCard label="Available" value={n(dv.available)} tone="success" icon={Cpu} to="/devices?status=available" />
        <StatCard label="Reserved / picked" value={n(dv.reserved)} icon={Cpu} to="/devices?status=reserved" />
        <StatCard label="Undergoing repair" value={n(dv.in_repair)} icon={Wrench} to="/repairs" />
        <StatCard label="Faulty awaiting assessment" value={n(dv.awaiting_assessment)} tone={dv.awaiting_assessment ? 'warning' : 'default'} icon={AlertTriangle} to="/assessments" />
        <StatCard label="Open serial discrepancies" value={n(s.open_discrepancies)} tone={s.open_discrepancies ? 'danger' : 'default'} icon={ShieldAlert} to="/discrepancies" />
        {can('invoices.view') && <>
          <StatCard label="Outstanding invoices" value={n(inv.outstanding_count)} hint={formatMoney(inv.outstanding_cents)} icon={Receipt} to="/invoicing?status=outstanding" />
          <StatCard label="Overdue invoices" value={n(inv.overdue_count)} hint={formatMoney(inv.overdue_cents)} tone={inv.overdue_count ? 'danger' : 'default'} icon={Receipt} to="/invoicing?status=overdue" />
        </>}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Work orders by status" empty={!s.wo_by_status.length}>
          <ResponsiveContainer>
            <BarChart data={s.wo_by_status.map((r) => ({ ...r, label: labelize(r.status) }))} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} fontSize={11} />
              <YAxis type="category" dataKey="label" width={150} fontSize={11} />
              <Tooltip />
              <Bar dataKey="count" fill="rgb(var(--primary))" radius={[0, 3, 3, 0]} name="Work orders" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Stock levels by warehouse" empty={!s.stock_by_warehouse.length}>
          <ResponsiveContainer>
            <BarChart data={s.stock_by_warehouse}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="warehouse" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip /><Legend />
              <Bar dataKey="available" stackId="a" fill="#16a34a" name="Available" />
              <Bar dataKey="reserved" stackId="a" fill="#1d4ed8" name="Reserved / issued" />
              <Bar dataKey="repair" stackId="a" fill="#d97706" name="Faulty / repair / quarantine" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Devices by category and condition" empty={!categoryData.length}>
          <ResponsiveContainer>
            <BarChart data={categoryData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="category" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip /><Legend />
              {conditions.map((c, i) => <Bar key={c} dataKey={c} stackId="c" fill={COLORS[i % COLORS.length]} name={labelize(c)} />)}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Work orders by province" empty={!s.wo_by_province.length}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={s.wo_by_province} dataKey="count" nameKey="province" outerRadius={90} label={(e) => e.province}>
                {s.wo_by_province.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Device allocations by institution (top 10)" empty={!s.allocations_by_institution.length}>
          <ResponsiveContainer>
            <BarChart data={s.allocations_by_institution} layout="vertical" margin={{ left: 40 }}>
              <XAxis type="number" allowDecimals={false} fontSize={11} />
              <YAxis type="category" dataKey="institution" width={170} fontSize={11} />
              <Tooltip />
              <Bar dataKey="count" fill="#0891b2" name="Devices" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Repairs by status" empty={!s.repairs_by_status.length}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={s.repairs_by_status.map((r) => ({ ...r, label: labelize(r.status) }))} dataKey="count" nameKey="label" innerRadius={50} outerRadius={90}>
                {s.repairs_by_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip /><Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Monthly dispatch volume" empty={!s.monthly_dispatch.length}>
          <ResponsiveContainer>
            <LineChart data={s.monthly_dispatch}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip /><Legend />
              <Line type="monotone" dataKey="devices" stroke="#7c3aed" name="Devices dispatched" />
              <Line type="monotone" dataKey="dispatches" stroke="#1d4ed8" name="Shipments" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        {can('invoices.view') && (
          <ChartCard title="Invoice totals and outstanding balances" empty={!s.invoice_totals.length}>
            <ResponsiveContainer>
              <BarChart data={s.invoice_totals.map((r) => ({ month: r.month, invoiced: r.invoiced_cents / 100, outstanding: r.outstanding_cents / 100 }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number) => formatMoney(Math.round(v * 100))} /><Legend />
                <Bar dataKey="invoiced" fill="#1d4ed8" name="Invoiced" />
                <Bar dataKey="outstanding" fill="#dc2626" name="Outstanding" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Overdue tasks</CardTitle></CardHeader>
          <CardContent className="p-0">
            {s.overdue_tasks.length ? (
              <ul className="divide-y text-sm">
                {s.overdue_tasks.map((t) => (
                  <li key={`${t.type}-${t.id}`} className="flex items-center justify-between gap-2 px-4 py-2">
                    <Link className="mono text-primary hover:underline"
                      to={t.type === 'invoice' ? `/invoicing/${t.id}` : t.type === 'dispatch' ? `/dispatch/${t.id}` : `/work-orders/${t.id}`}>{t.reference}</Link>
                    <span className="text-xs text-muted-foreground">due {formatDate(t.due)}</span>
                    <StatusBadge status={t.status} kind={t.type === 'work_order' ? 'wo' : 'generic'} />
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="Nothing overdue" />}
          </CardContent>
        </Card>
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Low-stock alerts</CardTitle></CardHeader>
          <CardContent className="p-0">
            {s.low_stock.length ? (
              <ul className="divide-y text-sm">
                {s.low_stock.map((l) => (
                  <li key={`${l.warehouse}-${l.model}`} className="flex items-center justify-between gap-2 px-4 py-2">
                    <span><span className="mono text-xs">{l.warehouse}</span> · {l.model}</span>
                    <span className="font-medium text-amber-700">{l.available} / {l.threshold}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="All stock above thresholds" />}
          </CardContent>
        </Card>
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
          <CardContent className="p-0">
            {activity.data?.length ? (
              <ul className="divide-y text-sm">
                {activity.data.map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Link to={`/work-orders/${a.work_orders?.id}`} className="mono text-primary hover:underline">{a.work_orders?.wo_number}</Link>
                      <StatusBadge status={a.to_status} kind="wo" />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{formatDateTime(a.changed_at)} · {a.reason}</p>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No recent activity" />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
