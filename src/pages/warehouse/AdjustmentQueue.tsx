import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchAll, rpc } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { ConfirmDialog, EmptyState, LoadingState } from '@/components/common';

/** Stock adjustments awaiting approval (shown on Warehouse → Adjustments). */
export function AdjustmentQueue() {
  const qc = useQueryClient();
  const [decide, setDecide] = useState<{ id: string; approve: boolean } | null>(null);
  const q = useQuery({ queryKey: ['stock', 'adjustment-queue'], queryFn: () => fetchAll<{ id: string; movement_number: string; adjustment_type: string; reason: string; serials: string; requested_by_name: string; requested_at: string; from_warehouse_code: string }>(
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
        try { await rpc('decide_stock_adjustment', { p_adjustment_id: decide!.id, p_approve: decide!.approve, p_comment: reason || null }); toast.success('Decision recorded'); void qc.invalidateQueries({ queryKey: ['stock'] }); }
        catch (e) { toast.error((e as Error).message); throw e; }
      }} /></CardContent></Card>;
}
