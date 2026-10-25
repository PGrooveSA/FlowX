import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc, type ScanResult } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { opts, useLocations } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/form-controls';
import { StatusBadge } from '@/components/ui/badge';
import { ConfirmDialog, ErrorState, LoadingState, PageHeader, ScanInput, ScanLog, StatCard, type ScanLogEntry } from '@/components/common';

export function StockCountPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [location, setLocation] = useState('');
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<null | 'submit' | 'approve'>(null);
  const q = useQuery({
    queryKey: ['count', id],
    queryFn: async () => ({
      count: await fetchOne<Record<string, string>>('v_stock_counts', 'id', id),
      lines: await fetchAll<{ id: string; result: string; scanned_serial: string | null; scanned_at: string | null; devices: { serial_number: string; asset_tag: string; status: string } | null; expected: { code: string } | null; found: { code: string } | null }>(
        'stock_count_lines', 'id, result, scanned_serial, scanned_at, devices(serial_number, asset_tag, status), expected:expected_location_id(code), found:found_location_id(code)', (x) => x.eq('stock_count_id', id)),
    }),
  });
  const locations = useLocations(q.data?.count?.warehouse_id).data;
  if (q.isLoading) return <LoadingState />;
  if (!q.data?.count) return <ErrorState error={q.error ?? new Error('Count not found')} />;
  const { count, lines } = q.data;
  const tally = (r: string) => lines.filter((l) => l.result === r).length;
  const shown = filter ? lines.filter((l) => l.result === filter) : lines;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['count', id] });

  return (
    <div className="space-y-4">
      <PageHeader title={count.count_number} crumbs={[{ label: 'Warehouse', to: '/warehouse?tab=counts' }, { label: count.count_number }]}
        description={<span className="flex items-center gap-2"><StatusBadge status={count.status} /> {count.warehouse_code}{count.location_code ? ` / ${count.location_code}` : ''} · started {formatDateTime(count.started_at)}</span>}
        actions={<>
          {count.status === 'open' && can('inventory.count') && <Button onClick={() => setConfirm('submit')}>Submit count</Button>}
          {count.status === 'submitted' && can('inventory.count_approve') && <Button onClick={() => setConfirm('approve')}>Approve results</Button>}
        </>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Expected" value={lines.filter((l) => l.result !== 'unexpected').length} />
        <StatCard label="Found" value={tally('found')} tone="success" />
        <StatCard label="Wrong location" value={tally('wrong_location')} tone={tally('wrong_location') ? 'warning' : 'default'} />
        <StatCard label={count.status === 'open' ? 'Not yet scanned' : 'Missing'} value={tally('pending') + tally('missing')} tone={tally('missing') ? 'danger' : 'default'} />
        <StatCard label="Unexpected" value={tally('unexpected')} tone={tally('unexpected') ? 'danger' : 'default'} />
      </div>
      {count.status === 'open' && can('inventory.count') && (
        <Card><CardHeader><CardTitle>Scan devices</CardTitle></CardHeader><CardContent className="space-y-3">
          <Field label="Location being counted" htmlFor="cl" hint="Used to detect devices stored in the wrong location."><Select id="cl" placeholder="Not specified" value={location} onChange={(e) => setLocation(e.target.value)} options={opts(locations, (l) => l.code)} /></Field>
          <ScanInput onScan={async (s) => {
            try { const r = await rpc<ScanResult>('stock_count_scan', { p_count_id: count.id, p_serial: s, p_location_id: location || null }); setLog((l) => [{ at: new Date(), ok: r.ok, message: r.message, serial: s }, ...l]); refresh(); }
            catch (e) { toast.error((e as Error).message); }
          }} />
          <ScanLog entries={log} />
        </CardContent></Card>
      )}
      <Card><CardHeader><CardTitle>Variance</CardTitle>
        <Select aria-label="Filter results" className="w-44" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="All results"
          options={['pending', 'found', 'wrong_location', 'missing', 'unexpected'].map((r) => ({ value: r, label: r.replace('_', ' ') }))} /></CardHeader>
        <CardContent className="max-h-[480px] overflow-y-auto p-0">
          <table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Serial</th><th className="px-3 py-2">Asset tag</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Expected location</th><th className="px-3 py-2">Found location</th><th className="px-3 py-2">System status</th><th className="px-3 py-2">Scanned</th></tr></thead>
            <tbody>{shown.slice(0, 1000).map((l) => (
              <tr key={l.id} className="border-t"><td className="mono px-3 py-1.5">{l.devices?.serial_number ?? l.scanned_serial}</td><td className="mono px-3 py-1.5">{l.devices?.asset_tag ?? '—'}</td>
                <td className="px-3 py-1.5"><StatusBadge status={l.result === 'pending' ? 'pending' : l.result === 'found' ? 'received' : l.result} /></td>
                <td className="px-3 py-1.5">{l.expected?.code ?? '—'}</td><td className="px-3 py-1.5">{l.found?.code ?? '—'}</td>
                <td className="px-3 py-1.5">{l.devices ? <StatusBadge status={l.devices.status} kind="device" /> : '—'}</td><td className="px-3 py-1.5">{formatDateTime(l.scanned_at)}</td></tr>))}</tbody></table>
        </CardContent></Card>
      <ConfirmDialog open={confirm === 'submit'} onOpenChange={(o) => !o && setConfirm(null)} title="Submit stock count"
        description="Devices not scanned will be recorded as missing. You cannot scan further after submitting." confirmLabel="Submit"
        onConfirm={async () => { try { await rpc('submit_stock_count', { p_count_id: count.id }); toast.success('Count submitted for approval'); refresh(); } catch (e) { toast.error((e as Error).message); throw e; } }} />
      <ConfirmDialog open={confirm === 'approve'} onOpenChange={(o) => !o && setConfirm(null)} title="Approve stock count"
        description="Found devices are marked verified and wrong locations corrected. Missing and unexpected devices are raised as discrepancies for investigation — stock is NOT adjusted automatically."
        onConfirm={async () => { try { const r = await rpc<{ discrepancies_raised: number }>('approve_stock_count', { p_count_id: count.id, p_comment: null }); toast.success(`Approved; ${r.discrepancies_raised} discrepancy record(s) raised`); refresh(); } catch (e) { toast.error((e as Error).message); throw e; } }} />
    </div>
  );
}
