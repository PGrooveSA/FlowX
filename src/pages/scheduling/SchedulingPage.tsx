import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchAll } from '@/lib/api';
import { cn, formatDate, todayLocal } from '@/lib/utils';
import { opts, useWarehouses } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/form-controls';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { EmptyState, LoadingState, PageHeader } from '@/components/common';

interface Row { id: string; wo_number: string; status: string; institution_name: string; scheduled_date: string | null; priority: string;
  total_approved: number; warehouse_code: string | null; assigned_to_name: string | null; assigned_team: string | null; created_at: string }

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function SchedulingPage() {
  const [month, setMonth] = useState(() => todayLocal().slice(0, 7));
  const [warehouse, setWarehouse] = useState('');
  const warehouses = useWarehouses().data;
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const fromStr = first.toISOString().slice(0, 10), toStr = last.toISOString().slice(0, 10);

  const scheduled = useQuery({
    queryKey: ['scheduling', month, warehouse],
    queryFn: () => fetchAll<Row>('v_work_orders', 'id, wo_number, status, institution_name, scheduled_date, priority, total_approved, warehouse_code, assigned_to_name, assigned_team, created_at',
      (q) => { let r = q.gte('scheduled_date', fromStr).lte('scheduled_date', toStr).not('status', 'in', '(cancelled)'); if (warehouse) r = r.eq('warehouse_id', warehouse); return r.order('scheduled_date'); }),
  });
  const queue = useQuery({
    queryKey: ['scheduling', 'queue'],
    queryFn: () => fetchAll<Row>('v_work_orders', 'id, wo_number, status, institution_name, scheduled_date, priority, total_approved, warehouse_code, assigned_to_name, assigned_team, created_at',
      (q) => q.eq('status', 'pending_scheduling').order('created_at').limit(100)),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of scheduled.data ?? []) map.set(r.scheduled_date!, [...(map.get(r.scheduled_date!) ?? []), r]);
    return map;
  }, [scheduled.data]);

  const offset = (first.getUTCDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((offset + last.getUTCDate()) / 7) * 7 }, (_, i) => {
    const d = i - offset + 1;
    return d >= 1 && d <= last.getUTCDate() ? `${month}-${String(d).padStart(2, '0')}` : null;
  });
  const shift = (n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  const today = todayLocal();
  const overdue = (scheduled.data ?? []).filter((r) => r.scheduled_date! < today && ['scheduled', 'scheduled_pending_issuing', 'issuing_in_progress'].includes(r.status));

  return (
    <div className="space-y-4">
      <PageHeader title="Scheduling" crumbs={[{ label: 'Scheduling' }]} description="Plan warehouse workload. Schedule or reschedule from the work order page; stock is checked before confirmation." />
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="outline" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft /></Button>
              <CardTitle className="w-40 text-center">{first.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</CardTitle>
              <Button size="icon" variant="outline" onClick={() => shift(1)} aria-label="Next month"><ChevronRight /></Button>
              <Button size="sm" variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>Today</Button>
            </div>
            <Select aria-label="Warehouse" className="w-48" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} placeholder="All warehouses" options={opts(warehouses, (w) => w.code)} />
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {scheduled.isLoading ? <LoadingState /> : (
              <div className="grid min-w-[700px] grid-cols-7 gap-px rounded border bg-border text-xs" role="grid" aria-label="Schedule calendar">
                {WEEKDAYS.map((d) => <div key={d} className="bg-muted px-2 py-1 font-semibold" role="columnheader">{d}</div>)}
                {cells.map((date, i) => {
                  const items = date ? byDay.get(date) ?? [] : [];
                  const load = items.reduce((s, r) => s + (r.total_approved || 0), 0);
                  return (
                    <div key={i} role="gridcell" className={cn('min-h-[96px] bg-card p-1', !date && 'bg-muted/40', date === today && 'ring-2 ring-inset ring-primary')}>
                      {date && <div className="mb-1 flex justify-between"><span className="font-medium">{Number(date.slice(8))}</span>
                        {load > 0 && <span className={cn('rounded px-1', load > 200 ? 'bg-red-100 text-red-800' : 'bg-muted')} title="Devices scheduled">{load} dev</span>}</div>}
                      <div className="space-y-0.5">
                        {items.slice(0, 4).map((r) => (
                          <Link key={r.id} to={`/work-orders/${r.id}`} className={cn('block truncate rounded px-1 py-0.5 hover:underline',
                            r.priority === 'urgent' ? 'bg-red-50 text-red-800' : r.priority === 'high' ? 'bg-amber-50 text-amber-900' : 'bg-blue-50 text-blue-900')}>
                            {r.wo_number} · {r.warehouse_code}
                          </Link>
                        ))}
                        {items.length > 4 && <span className="text-muted-foreground">+{items.length - 4} more</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Awaiting scheduling ({queue.data?.length ?? 0})</CardTitle></CardHeader>
            <CardContent className="max-h-[420px] overflow-y-auto p-0">
              {queue.data?.length ? <ul className="divide-y text-sm">{queue.data.map((r) => (
                <li key={r.id} className="px-4 py-2">
                  <div className="flex items-center justify-between"><Link className="mono text-primary hover:underline" to={`/work-orders/${r.id}`}>{r.wo_number}</Link>
                    <Badge tone={r.priority === 'urgent' ? 'red' : r.priority === 'high' ? 'amber' : 'gray'}>{r.priority}</Badge></div>
                  <p className="text-xs text-muted-foreground">{r.institution_name} · {r.total_approved} devices · approved queue since {formatDate(r.created_at)}</p>
                </li>))}</ul> : <EmptyState title="Nothing waiting" />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Overdue this month</CardTitle></CardHeader>
            <CardContent className="p-0">
              {overdue.length ? <ul className="divide-y text-sm">{overdue.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-4 py-2"><Link className="mono text-primary hover:underline" to={`/work-orders/${r.id}`}>{r.wo_number}</Link>
                  <span className="text-xs">{formatDate(r.scheduled_date)}</span><StatusBadge status={r.status} kind="wo" /></li>))}</ul> : <EmptyState title="No overdue schedules" />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
