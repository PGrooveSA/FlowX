import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { toast } from 'sonner';
import { fetchAll, rpc } from '@/lib/api';
import { formatDateTime, formatMoney, labelize } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog, EmptyState, LoadingState, PageHeader } from '@/components/common';
import type { WorkOrderRow } from '@/pages/work-orders/WorkOrdersPage';

const col = createColumnHelper<WorkOrderRow>();

export function ApprovalsPage() {
  const { can, profile } = useAuth();
  const nav = useNavigate();
  const tabs = [
    can('work_orders.approve') && 'work_orders', can('work_orders.approve') && 'amendments',
    can('repairs.approve') && 'repairs', can('inventory.adjust_approve') && 'adjustments',
  ].filter(Boolean) as string[];
  return (
    <div>
      <PageHeader title="Approvals" crumbs={[{ label: 'Approvals' }]}
        description="Items awaiting your decision. Segregation of duties prevents approving your own requests." />
      <Tabs defaultValue={tabs[0]}>
        <TabsList>{tabs.map((t) => <TabsTrigger key={t} value={t}>{labelize(t)}</TabsTrigger>)}</TabsList>
        <TabsContent value="work_orders">
          <ServerDataTable<WorkOrderRow> source="v_work_orders" queryKey={['work-orders', 'approvals']} filters={[{ column: 'status', op: 'eq', value: 'pending_authorisation' }]}
            defaultSort={{ column: 'submitted_at', desc: false }} onRowClick={(r) => nav(`/work-orders/${r.id}`)} emptyTitle="No work orders awaiting authorisation"
            columns={[
              col.accessor('wo_number', { header: 'Work order', cell: (c) => <Link className="mono text-primary hover:underline" to={`/work-orders/${c.row.original.id}`}>{c.getValue()}</Link> }),
              col.accessor('institution_name', { header: 'Institution' }), col.accessor('emis_number', { header: 'EMIS' }),
              col.accessor('work_order_type_name', { header: 'Type', enableSorting: false }), col.accessor('category_names', { header: 'Devices', enableSorting: false }),
              col.accessor('total_requested', { header: 'Requested', enableSorting: false }),
              col.accessor('created_by_name', { header: 'Requested by', cell: (c) => <>{c.getValue()}{c.row.original.created_by === profile?.id && <span className="ml-1 text-xs text-amber-700">(you)</span>}</> }),
              col.accessor('submitted_at', { header: 'Submitted', cell: (c) => formatDateTime(c.getValue() as string) }),
            ]} />
        </TabsContent>
        <TabsContent value="amendments"><AmendmentQueue /></TabsContent>
        <TabsContent value="repairs"><RepairQueue /></TabsContent>
        <TabsContent value="adjustments"><AdjustmentQueue /></TabsContent>
      </Tabs>
    </div>
  );
}

function AmendmentQueue() {
  const q = useQuery({ queryKey: ['approvals', 'amendments'], queryFn: () => fetchAll<{ id: string; reason: string; changes: unknown; requested_at: string; work_orders: { id: string; wo_number: string }; requester: { full_name: string } }>(
    'work_order_amendments', 'id, reason, changes, requested_at, work_orders(id, wo_number), requester:requested_by(full_name)', (x) => x.eq('status', 'pending').order('requested_at')) });
  if (!q.data) return <LoadingState />;
  if (!q.data.length) return <EmptyState title="No pending amendments" />;
  return <Card><CardContent className="p-0"><ul className="divide-y text-sm">{q.data.map((m) => (
    <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div><Link className="mono text-primary hover:underline" to={`/work-orders/${m.work_orders.id}`}>{m.work_orders.wo_number}</Link> — {m.reason}
        <p className="text-xs text-muted-foreground">{m.requester.full_name} · {formatDateTime(m.requested_at)}</p></div>
      <Button size="sm" variant="outline" asChild><Link to={`/work-orders/${m.work_orders.id}`}>Review on work order</Link></Button>
    </li>))}</ul></CardContent></Card>;
}

function RepairQueue() {
  const qc = useQueryClient();
  const [decide, setDecide] = useState<{ id: string; approve: boolean } | null>(null);
  const q = useQuery({ queryKey: ['approvals', 'repairs'], queryFn: () => fetchAll<{ id: string; repair_number: string; serial_number: string; model_name: string; estimated_cost_cents: number; fault_description: string; created_at: string }>(
    'v_repairs', 'id, repair_number, serial_number, model_name, estimated_cost_cents, fault_description, created_at', (x) => x.eq('status', 'awaiting_approval').order('created_at')) });
  if (!q.data) return <LoadingState />;
  if (!q.data.length) return <EmptyState title="No repairs awaiting cost approval" />;
  return <Card><CardContent className="p-0"><ul className="divide-y text-sm">{q.data.map((r) => (
    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div><Link className="mono text-primary hover:underline" to={`/repairs/${r.id}`}>{r.repair_number}</Link> · <span className="mono">{r.serial_number}</span> {r.model_name}
        <p className="text-xs text-muted-foreground">{r.fault_description} · estimate {formatMoney(r.estimated_cost_cents)}</p></div>
      <div className="flex gap-2"><Button size="sm" onClick={() => setDecide({ id: r.id, approve: true })}>Approve</Button>
        <Button size="sm" variant="outline" onClick={() => setDecide({ id: r.id, approve: false })}>Reject</Button></div>
    </li>))}</ul>
    <ConfirmDialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)} title={decide?.approve ? 'Approve repair cost' : 'Reject repair'} reasonLabel={decide?.approve ? undefined : 'Reason'}
      onConfirm={async (reason) => {
        try { await rpc('decide_repair_approval', { p_repair_id: decide!.id, p_approve: decide!.approve, p_comment: reason || null }); toast.success('Decision recorded'); void qc.invalidateQueries({ queryKey: ['approvals'] }); }
        catch (e) { toast.error((e as Error).message); throw e; }
      }} /></CardContent></Card>;
}

export function AdjustmentQueue() {
  const qc = useQueryClient();
  const [decide, setDecide] = useState<{ id: string; approve: boolean } | null>(null);
  const q = useQuery({ queryKey: ['approvals', 'adjustments'], queryFn: () => fetchAll<{ id: string; movement_number: string; adjustment_type: string; reason: string; serials: string; requested_by_name: string; requested_at: string; from_warehouse_code: string }>(
    'v_stock_movements', 'id, movement_number, adjustment_type, reason, serials, requested_by_name, requested_at, from_warehouse_code', (x) => x.eq('movement_type', 'adjustment').eq('status', 'requested').order('requested_at')) });
  if (!q.data) return <LoadingState />;
  if (!q.data.length) return <EmptyState title="No stock adjustments awaiting approval" />;
  return <Card><CardContent className="p-0"><ul className="divide-y text-sm">{q.data.map((a) => (
    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div><span className="mono">{a.movement_number}</span> · <StatusBadge status={a.adjustment_type} /> · <span className="mono">{a.serials}</span> ({a.from_warehouse_code})
        <p className="text-xs text-muted-foreground">{a.reason} — {a.requested_by_name}, {formatDateTime(a.requested_at)}</p></div>
      <div className="flex gap-2"><Button size="sm" onClick={() => setDecide({ id: a.id, approve: true })}>Approve</Button>
        <Button size="sm" variant="outline" onClick={() => setDecide({ id: a.id, approve: false })}>Reject</Button></div>
    </li>))}</ul>
    <ConfirmDialog open={!!decide} onOpenChange={(o) => !o && setDecide(null)} title={decide?.approve ? 'Approve stock adjustment' : 'Reject stock adjustment'}
      description={decide?.approve ? 'The device status changes through a recorded movement. This cannot be silently undone.' : undefined}
      reasonLabel={decide?.approve ? undefined : 'Reason'} destructive={decide?.approve}
      onConfirm={async (reason) => {
        try { await rpc('decide_stock_adjustment', { p_adjustment_id: decide!.id, p_approve: decide!.approve, p_comment: reason || null }); toast.success('Decision recorded'); void qc.invalidateQueries({ queryKey: ['approvals'] }); void qc.invalidateQueries({ queryKey: ['stock'] }); }
        catch (e) { toast.error((e as Error).message); throw e; }
      }} /></CardContent></Card>;
}
