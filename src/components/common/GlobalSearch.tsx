import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { useDebounce } from '@/components/common';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';

interface Hit { kind: string; id: string; title: string; subtitle: string; status?: string; to: string }

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [term, setTerm] = useState('');
  const q = useDebounce(term.trim(), 250);
  const nav = useNavigate();
  const { can } = useAuth();

  const results = useQuery({
    queryKey: ['global-search', q],
    enabled: q.length >= 2,
    queryFn: async (): Promise<Hit[]> => {
      const t = q.replace(/[%_,()]/g, '');
      const tasks: PromiseLike<Hit[]>[] = [];
      if (can('devices.view')) {
        tasks.push(supabase.rpc('lookup_device', { p_query: t }).then(({ data }) =>
          ((data as Array<Record<string, string>>) ?? []).map((d) => ({ kind: 'Device', id: d.id, title: d.serial_number ?? d.asset_tag,
            subtitle: `${d.asset_tag} Â· ${d.manufacturer} ${d.model} Â· ${d.warehouse}`, status: d.status, to: `/devices/${d.id}` }))));
      }
      if (can('work_orders.view')) {
        tasks.push(supabase.from('v_work_orders').select('id, wo_number, status, institution_name, emis_number')
          .or(`wo_number.ilike.%${t}%,emis_number.ilike.%${t}%,institution_name.ilike.%${t}%`).limit(6)
          .then(({ data }) => (data ?? []).map((w) => ({ kind: 'Work order', id: w.id, title: w.wo_number,
            subtitle: `${w.institution_name} (${w.emis_number})`, status: w.status, to: `/work-orders/${w.id}` }))));
      }
      if (can('invoices.view')) {
        tasks.push(supabase.from('invoices').select('id, invoice_number, status, customer_name').ilike('invoice_number', `%${t}%`).limit(4)
          .then(({ data }) => (data ?? []).map((i) => ({ kind: 'Invoice', id: i.id, title: i.invoice_number ?? 'Draft', subtitle: i.customer_name,
            status: i.status, to: `/invoicing/${i.id}` }))));
      }
      if (can('dispatch.view')) {
        tasks.push(supabase.from('dispatches').select('id, dispatch_number, status, tracking_number')
          .or(`dispatch_number.ilike.%${t}%,tracking_number.ilike.%${t}%`).limit(4)
          .then(({ data }) => (data ?? []).map((d) => ({ kind: 'Dispatch', id: d.id, title: d.dispatch_number,
            subtitle: d.tracking_number ? `Tracking ${d.tracking_number}` : '', status: d.status, to: `/dispatch/${d.id}` }))));
      }
      return (await Promise.all(tasks)).flat();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setTerm(''); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader title="Search" description="Serial number, asset tag, IMEI, work order, EMIS number, invoice or dispatch number." />
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} className="pl-9" placeholder="Start typingâ€¦" aria-label="Search" />
        </div>
        <ul className="mt-3 max-h-96 divide-y overflow-y-auto">
          {q.length >= 2 && results.data?.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No matches</li>}
          {results.data?.map((h) => (
            <li key={`${h.kind}-${h.id}`}>
              <button className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-muted"
                onClick={() => { nav(h.to); onOpenChange(false); setTerm(''); }}>
                <span className="w-20 shrink-0 text-xs text-muted-foreground">{h.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="mono block truncate text-sm font-medium">{h.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{h.subtitle}</span>
                </span>
                {h.status && <StatusBadge status={h.status} kind={h.kind === 'Device' ? 'device' : h.kind === 'Work order' ? 'wo' : 'generic'} />}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
