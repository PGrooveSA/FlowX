import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import { fetchList, rpc } from '@/lib/api';
import { cn, formatDateTime, labelize } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/form-controls';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/common';

interface Note { id: string; title: string; body: string | null; link: string | null; category: string; severity: string; is_read: boolean; created_at: string; email_status: string }

export function NotificationsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('unread');
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['notifications', filter, page],
    queryFn: () => fetchList<Note>('notifications', { page, pageSize: 30, sort: { column: 'created_at', desc: true },
      filters: filter === 'unread' ? [{ column: 'is_read', op: 'eq', value: false }] : filter ? [{ column: 'category', op: 'eq', value: filter }] : [] }),
  });
  const markRead = async (ids: string[] | null) => {
    try { const n = await rpc<number>('mark_notifications_read', { p_ids: ids }); if (ids === null) toast.success(`${n} marked as read`); void qc.invalidateQueries({ queryKey: ['notifications'] }); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Notifications" crumbs={[{ label: 'Notifications' }]}
        description="In-app notifications. Email delivery is not configured in this installation; notifications are shown here only."
        actions={<Button variant="outline" onClick={() => void markRead(null)}><CheckCheck /> Mark all as read</Button>} />
      <Select aria-label="Filter" className="mb-3 w-56" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} placeholder="All notifications"
        options={[{ value: 'unread', label: 'Unread' }, ...['approval', 'scheduling', 'issuing', 'stock', 'discrepancy', 'repair', 'invoice', 'dispatch', 'delivery', 'work_order'].map((c) => ({ value: c, label: labelize(c) }))]} />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data?.rows.length ? <EmptyState title="You're all caught up" /> : (
        <Card><CardContent className="p-0"><ul className="divide-y">{q.data.rows.map((n) => (
          <li key={n.id} className={cn('flex gap-3 px-4 py-3', !n.is_read && 'bg-primary/[0.03]')}>
            <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : n.severity === 'critical' ? 'bg-red-500' : n.severity === 'warning' ? 'bg-amber-500' : 'bg-primary')} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {n.link ? <Link to={n.link} onClick={() => !n.is_read && void markRead([n.id])} className="font-medium hover:underline">{n.title}</Link> : <span className="font-medium">{n.title}</span>}
                <Badge tone={n.severity === 'critical' ? 'red' : n.severity === 'warning' ? 'amber' : n.severity === 'success' ? 'green' : 'blue'}>{labelize(n.category)}</Badge>
              </div>
              {n.body && <p className="text-sm text-muted-foreground">{n.body}</p>}
              <p className="text-xs text-muted-foreground">{formatDateTime(n.created_at)}{n.email_status === 'not_configured' ? ' · email not configured' : ` · email ${n.email_status}`}</p>
            </div>
            {!n.is_read && <Button size="sm" variant="ghost" onClick={() => void markRead([n.id])}>Mark read</Button>}
          </li>))}</ul></CardContent></Card>
      )}
      {q.data && q.data.count > 30 && <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={(page + 1) * 30 >= q.data.count} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </div>
  );
}
