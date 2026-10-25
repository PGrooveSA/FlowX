import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc, type Filter } from '@/lib/api';
import { formatDateTime, formatMoney, labelize, parseMoneyToCents } from '@/lib/utils';
import { DEVICE_CONDITIONS } from '@/lib/status';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, useDebounce } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();

export function AssessmentsPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const filters = useMemo<Filter[]>(() => [{ column: 'status', op: 'eq', value: status }], [status]);
  return (
    <div>
      <PageHeader title="Device Assessments" crumbs={[{ label: 'Assessments' }]} description="Assessment queue for faulty and returned devices. Faults are reported from the device record." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={['pending', 'in_progress', 'completed', 'cancelled'].map((s) => ({ value: s, label: labelize(s) }))} />
        <Input aria-label="Search" className="max-w-xs" placeholder="Serial, asset tag, number…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ServerDataTable<Row> source="v_assessments" queryKey={['assessments']} filters={filters} search={debounced} searchColumns={['serial_number', 'asset_tag', 'assessment_number']}
        defaultSort={{ column: 'reported_at', desc: false }} onRowClick={(r) => nav(`/assessments/${r.id}`)} emptyTitle="No assessments in this queue" exportName="assessments"
        columns={[
          c.accessor('assessment_number', { header: 'Assessment', cell: (x) => <Link className="mono text-primary hover:underline" to={`/assessments/${x.row.original.id}`}>{x.getValue()}</Link> }),
          c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }),
          c.accessor('serial_number', { header: 'Serial', cell: (x) => <span className="mono">{x.getValue()}</span> }),
          c.accessor('model_name', { header: 'Model' }), c.accessor('reported_fault', { header: 'Reported fault' }), c.accessor('origin', { header: 'Origin' }),
          c.accessor('wo_number', { header: 'Work order', cell: (x) => x.getValue() ?? '—' }), c.accessor('outcome', { header: 'Outcome', cell: (x) => x.getValue() ? <StatusBadge status={x.getValue()} /> : '—' }),
          c.accessor('technician_name', { header: 'Technician', cell: (x) => x.getValue() ?? '—' }), c.accessor('reported_at', { header: 'Reported', cell: (x) => formatDateTime(x.getValue()) }),
        ]}
        exportColumns={['assessment_number', 'status', 'serial_number', 'model_name', 'reported_fault', 'outcome', 'estimated_cost_cents', 'warranty_status', 'technician_name', 'reported_at', 'assessed_at'].map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
    </div>
  );
}

export function AssessmentDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['assessment', id], queryFn: () => fetchOne<Row>('v_assessments', 'id', id) });
  const [v, setV] = useState({ outcome: '', physical_condition: '', diagnostic_results: '', recommended_action: '', estimated: '', warranty_status: '', provider_type: 'internal', external_provider: '', warranty_claim_reference: '', condition: 'good' });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <LoadingState />;
  const a = q.data;
  if (!a) return <ErrorState error={new Error('Assessment not found')} />;
  const editable = can('assessments.record') && ['pending', 'in_progress'].includes(a.status);
  const cost = v.estimated ? parseMoneyToCents(v.estimated) : null;

  return (
    <div className="space-y-4">
      <PageHeader title={a.assessment_number} crumbs={[{ label: 'Assessments', to: '/assessments' }, { label: a.assessment_number }]}
        description={<span className="flex items-center gap-2"><StatusBadge status={a.status} /> <Link className="mono text-primary hover:underline" to={`/devices/${a.device_id}`}>{a.serial_number}</Link> {a.manufacturer} {a.model_name}</span>}
        actions={a.status === 'pending' && can('assessments.record') ? <Button onClick={async () => { try { await rpc('start_assessment', { p_assessment_id: a.id }); toast.success('Assessment started'); void q.refetch(); } catch (e) { toast.error((e as Error).message); } }}>Start assessment</Button> : null} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader><CardTitle>Report</CardTitle></CardHeader><CardContent>
          <KeyValue columns={1} items={[['Reported fault', a.reported_fault], ['Origin', a.origin], ['Work order', a.wo_number], ['Institution', a.institution_name], ['Reported', formatDateTime(a.reported_at)],
            ['Device status', <StatusBadge status={a.device_status} kind="device" />], ['Technician', a.technician_name], ['Outcome', a.outcome ? <StatusBadge status={a.outcome} /> : '—'],
            ['Diagnostics', a.diagnostic_results], ['Estimated cost', formatMoney(Number(a.estimated_cost_cents) || null)], ['Warranty', labelize(a.warranty_status)], ['Approval', <StatusBadge status={a.approval_status} />]]} />
        </CardContent></Card>
        {editable && (
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Record assessment</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="Outcome" htmlFor="o" required><Select id="o" placeholder="Select…" value={v.outcome} onChange={(e) => setV({ ...v, outcome: e.target.value })}
              options={['no_fault_found', 'return_to_service', 'repair_required', 'warranty_claim', 'replacement_recommended', 'scrap_recommended'].map((o) => ({ value: o, label: labelize(o) }))} /></Field>
            <Field label="Physical condition" htmlFor="pc"><Input id="pc" value={v.physical_condition} onChange={(e) => setV({ ...v, physical_condition: e.target.value })} /></Field>
            <Field label="Diagnostic results" htmlFor="dr" required className="sm:col-span-2"><Textarea id="dr" value={v.diagnostic_results} onChange={(e) => setV({ ...v, diagnostic_results: e.target.value })} /></Field>
            <Field label="Recommended action" htmlFor="ra"><Input id="ra" value={v.recommended_action} onChange={(e) => setV({ ...v, recommended_action: e.target.value })} /></Field>
            <Field label="Estimated repair cost (R)" htmlFor="ec" error={v.estimated && cost === null ? 'Enter an amount like 450.00' : undefined} hint="Costs above the configured threshold need approval.">
              <Input id="ec" inputMode="decimal" value={v.estimated} onChange={(e) => setV({ ...v, estimated: e.target.value })} /></Field>
            <Field label="Warranty status" htmlFor="ws"><Select id="ws" placeholder="Determine from warranty date" value={v.warranty_status} onChange={(e) => setV({ ...v, warranty_status: e.target.value })}
              options={['in_warranty', 'out_of_warranty', 'unknown'].map((o) => ({ value: o, label: labelize(o) }))} /></Field>
            {['repair_required', 'warranty_claim'].includes(v.outcome) && <>
              <Field label="Repair provider" htmlFor="pt"><Select id="pt" value={v.provider_type} onChange={(e) => setV({ ...v, provider_type: e.target.value })} options={['internal', 'external'].map((o) => ({ value: o, label: labelize(o) }))} /></Field>
              <Field label="External provider / warranty claim ref" htmlFor="ep"><Input id="ep" value={v.external_provider} onChange={(e) => setV({ ...v, external_provider: e.target.value })} /></Field>
            </>}
            {['no_fault_found', 'return_to_service'].includes(v.outcome) && <Field label="Device condition" htmlFor="dc"><Select id="dc" value={v.condition} onChange={(e) => setV({ ...v, condition: e.target.value })} options={['new', 'good', 'fair'].map((o) => ({ value: o, label: labelize(o) }))} /></Field>}
            <div className="sm:col-span-2 flex justify-end">
              <Button loading={busy} disabled={!v.outcome || v.diagnostic_results.trim().length < 5 || (!!v.estimated && cost === null)} onClick={async () => {
                setBusy(true);
                try {
                  const r = await rpc<{ repair_id: string | null; needs_approval: boolean }>('complete_assessment', { p_assessment_id: a.id, p: { ...v, estimated_cost_cents: cost, warranty_claim_reference: v.outcome === 'warranty_claim' ? v.external_provider : null } });
                  toast.success(r.needs_approval ? 'Assessment recorded — repair awaiting cost approval' : 'Assessment recorded');
                  void qc.invalidateQueries({ queryKey: ['assessments'] });
                  if (r.repair_id) nav(`/repairs/${r.repair_id}`); else void q.refetch();
                } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
              }}>Save assessment</Button>
            </div>
          </CardContent></Card>
        )}
      </div>
      <AttachmentsPanel entityType="assessment" entityId={a.id} title="Photographs and diagnostics" />
    </div>
  );
}

export function RepairsPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const filters = useMemo<Filter[]>(() => status ? [{ column: 'status', op: 'eq', value: status }] : [{ column: 'status', op: 'not_in', value: ['closed', 'cancelled'] }], [status]);
  return (
    <div>
      <PageHeader title="Repairs" crumbs={[{ label: 'Repairs' }]} description="Faulty devices cannot be allocated or dispatched until repaired, quality-checked and released to stock." />
      <Select aria-label="Status" className="mb-3 w-56" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All open repairs"
        options={['repair_requested', 'awaiting_assessment', 'assessed', 'awaiting_approval', 'awaiting_parts', 'under_repair', 'repair_completed', 'quality_check', 'ready_for_return', 'returned_to_warehouse', 'returned_to_recipient', 'closed', 'cancelled'].map((s) => ({ value: s, label: labelize(s) }))} />
      <ServerDataTable<Row> source="v_repairs" queryKey={['repairs']} filters={filters} defaultSort={{ column: 'created_at', desc: true }} onRowClick={(r) => nav(`/repairs/${r.id}`)}
        exportName="repairs" emptyTitle="No repairs" columns={[
          c.accessor('repair_number', { header: 'Repair', cell: (x) => <Link className="mono text-primary hover:underline" to={`/repairs/${x.row.original.id}`}>{x.getValue()}</Link> }),
          c.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }), c.accessor('serial_number', { header: 'Serial', cell: (x) => <span className="mono">{x.getValue()}</span> }),
          c.accessor('model_name', { header: 'Model' }), c.accessor('fault_description', { header: 'Fault' }), c.accessor('provider_type', { header: 'Provider', cell: (x) => labelize(x.getValue()) }),
          c.accessor('technician_name', { header: 'Technician', cell: (x) => x.getValue() ?? '—' }), c.accessor('total_cost_cents', { header: 'Cost', cell: (x) => formatMoney(Number(x.getValue())) }),
          c.accessor('turnaround_days', { header: 'Days open' }), c.accessor('created_at', { header: 'Created', cell: (x) => formatDateTime(x.getValue()) }),
        ]}
        exportColumns={['repair_number', 'status', 'serial_number', 'model_name', 'fault_description', 'provider_type', 'external_provider', 'technician_name', 'labour_cost_cents', 'parts_cost_cents', 'total_cost_cents', 'turnaround_days', 'qc_result', 'created_at', 'completed_at'].map((k) => ({ header: k, value: (r: Row) => r[k] }))} />
    </div>
  );
}

const NEXT_LABEL: Record<string, string> = {
  awaiting_assessment: 'Send for assessment', assessed: 'Mark assessed', awaiting_approval: 'Request cost approval', under_repair: 'Start repair', awaiting_parts: 'Awaiting parts',
  repair_completed: 'Repair completed', quality_check: 'Send to quality check', ready_for_return: 'Pass quality check', returned_to_warehouse: 'Return to warehouse',
  returned_to_recipient: 'Return to recipient', closed: 'Close', cancelled: 'Cancel repair',
};

export function RepairDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['repair', id],
    queryFn: async () => {
      const repair = await fetchOne<Row>('v_repairs', 'id', id);
      const [parts, history, transitions] = await Promise.all([
        fetchAll<Row>('repair_parts', '*', (x) => x.eq('repair_job_id', id).order('created_at')),
        fetchAll<Row & { profiles: { full_name: string } | null }>('repair_history', '*, profiles:changed_by(full_name)', (x) => x.eq('repair_job_id', id).order('changed_at')),
        fetchAll<{ to_status: string; permission_code: string }>('repair_status_transitions', 'to_status, permission_code', (x) => x.eq('from_status', repair?.status ?? '')),
      ]);
      return { repair, parts, history, transitions };
    },
  });
  const [target, setTarget] = useState<string | null>(null);
  const [partOpen, setPartOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  if (q.isLoading) return <LoadingState />;
  const r = q.data?.repair;
  if (!r) return <ErrorState error={new Error('Repair not found')} />;
  const decide = can('repairs.approve') && r.status === 'awaiting_approval';
  const rejectDialog = (
    <ConfirmDialog open={rejecting} onOpenChange={setRejecting} title={`Reject repair ${r.repair_number}`} reasonLabel="Reason" destructive
      description="The repair is cancelled and the device stays faulty."
      onConfirm={async (reason) => {
        try { await rpc('decide_repair_approval', { p_repair_id: r.id, p_approve: false, p_comment: reason }); toast.success('Repair rejected'); void q.refetch(); }
        catch (e) { toast.error((e as Error).message); throw e; }
      }} />
  );

  return (
    <div className="space-y-4">
      <PageHeader title={r.repair_number} crumbs={[{ label: 'Repairs', to: '/repairs' }, { label: r.repair_number }]}
        description={<span className="flex items-center gap-2"><StatusBadge status={r.status} /> <Link className="mono text-primary hover:underline" to={`/devices/${r.device_id}`}>{r.serial_number}</Link> {r.manufacturer} {r.model_name}</span>}
        actions={<>
          {decide && <>
            <Button size="sm" onClick={async () => { try { await rpc('decide_repair_approval', { p_repair_id: r.id, p_approve: true, p_comment: null }); toast.success('Repair approved'); void q.refetch(); } catch (e) { toast.error((e as Error).message); } }}>Approve cost</Button>
            <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>Reject</Button>
          </>}
          {!decide && q.data!.transitions.filter((t) => can(t.permission_code) && !(r.status === 'quality_check' && t.to_status === 'under_repair')).map((t) => (
            <Button key={t.to_status} size="sm" variant={t.to_status === 'cancelled' ? 'destructive' : 'default'} onClick={() => setTarget(t.to_status)}>{NEXT_LABEL[t.to_status] ?? labelize(t.to_status)}</Button>))}
          {r.status === 'quality_check' && can('repairs.manage') && <Button size="sm" variant="outline" onClick={() => setTarget('qc_fail')}>Fail quality check</Button>}
          {['assessed', 'awaiting_parts', 'under_repair'].includes(r.status) && can('repairs.manage') && <Button size="sm" variant="outline" onClick={() => setPartOpen(true)}><Plus /> Add part</Button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Repair</CardTitle></CardHeader><CardContent>
          <KeyValue columns={3} items={[['Fault', r.fault_description], ['Assessment', r.assessment_number], ['Work order', r.wo_number], ['Provider', labelize(r.provider_type)], ['External provider', r.external_provider],
            ['Warranty claim', r.warranty_claim_reference], ['Technician', r.technician_name], ['Started', formatDateTime(r.started_at)], ['Completed', formatDateTime(r.completed_at)],
            ['Estimated', formatMoney(Number(r.estimated_cost_cents) || null)], ['Labour', formatMoney(Number(r.labour_cost_cents))], ['Parts', formatMoney(Number(r.parts_cost_cents))],
            ['Total cost', <strong>{formatMoney(Number(r.total_cost_cents))}</strong>], ['Quality check', r.qc_result ? <StatusBadge status={r.qc_result === 'pass' ? 'approved' : 'failed'} /> : 'Pending'], ['Final condition', labelize(r.final_condition)],
            ['Device status', <StatusBadge status={r.device_status} kind="device" />], ['Turnaround (days)', r.turnaround_days]]} />
          {r.technician_notes && <p className="mt-3 whitespace-pre-wrap text-sm"><span className="text-xs text-muted-foreground">Technician notes</span><br />{r.technician_notes}</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>History</CardTitle></CardHeader><CardContent className="p-0">
          <ul className="divide-y text-sm">{q.data!.history.map((h) => (
            <li key={h.id} className="px-4 py-2"><div className="flex justify-between"><StatusBadge status={h.to_status} /><span className="text-xs text-muted-foreground">{formatDateTime(h.changed_at)}</span></div>
              <p className="text-xs text-muted-foreground">{h.profiles?.full_name}{h.notes ? ` — ${h.notes}` : ''}</p></li>))}</ul>
        </CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>Parts used</CardTitle></CardHeader><CardContent className="p-0">
        {q.data!.parts.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Part</th><th className="px-3 py-2">Number</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
          <tbody>{q.data!.parts.map((p) => <tr key={p.id} className="border-t"><td className="px-3 py-2">{p.part_name}</td><td className="mono px-3 py-2">{p.part_number ?? ''}</td><td className="px-3 py-2 text-right">{p.quantity}</td>
            <td className="px-3 py-2 text-right">{formatMoney(Number(p.unit_cost_cents))}</td><td className="px-3 py-2 text-right">{formatMoney(Number(p.unit_cost_cents) * Number(p.quantity))}</td></tr>)}</tbody></table>
          : <EmptyState title="No parts recorded" />}
      </CardContent></Card>
      <AttachmentsPanel entityType="repair" entityId={r.id} title="Before / after photographs and documents" />
      {target && <AdvanceDialog repairId={r.id} target={target} onClose={() => setTarget(null)} onDone={() => void q.refetch()} />}
      {partOpen && <PartDialog repairId={r.id} onClose={() => setPartOpen(false)} onDone={() => void q.refetch()} />}
      {rejectDialog}
    </div>
  );
}

function AdvanceDialog({ repairId, target, onClose, onDone }: { repairId: string; target: string; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState({ notes: '', final_condition: 'good', labour: '', technician_notes: '', qc_notes: '' });
  const [busy, setBusy] = useState(false);
  const qcFail = target === 'qc_fail';
  const to = qcFail ? 'under_repair' : target;
  const labour = p.labour ? parseMoneyToCents(p.labour) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={qcFail ? 'Fail quality check' : NEXT_LABEL[target] ?? labelize(target)} />
        <div className="space-y-3">
          {to === 'repair_completed' && <>
            <Field label="Final condition" htmlFor="fc" required><Select id="fc" value={p.final_condition} onChange={(e) => setP({ ...p, final_condition: e.target.value })} options={DEVICE_CONDITIONS.map((c2) => ({ value: c2, label: labelize(c2) }))} /></Field>
            <Field label="Labour cost (R)" htmlFor="lc" error={p.labour && labour === null ? 'Invalid amount' : undefined}><Input id="lc" inputMode="decimal" value={p.labour} onChange={(e) => setP({ ...p, labour: e.target.value })} /></Field>
            <Field label="Technician notes" htmlFor="tn"><Textarea id="tn" value={p.technician_notes} onChange={(e) => setP({ ...p, technician_notes: e.target.value })} /></Field>
          </>}
          {(target === 'ready_for_return' || qcFail) && <Field label="Quality inspection notes" htmlFor="qn" required><Textarea id="qn" value={p.qc_notes} onChange={(e) => setP({ ...p, qc_notes: e.target.value })} /></Field>}
          {!['repair_completed', 'ready_for_return'].includes(to) && !qcFail && <Field label="Notes" htmlFor="nn"><Textarea id="nn" value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} /></Field>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={((target === 'ready_for_return' || qcFail) && p.qc_notes.trim().length < 3) || (!!p.labour && labour === null)} onClick={async () => {
            setBusy(true);
            try {
              await rpc('advance_repair', { p_repair_id: repairId, p_to_status: to, p: {
                notes: p.notes || null, final_condition: p.final_condition, labour_cost_cents: labour, technician_notes: p.technician_notes || null,
                qc_result: target === 'ready_for_return' ? 'pass' : qcFail ? 'fail' : null, qc_notes: p.qc_notes || null } });
              toast.success('Repair updated'); onDone(); onClose();
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Confirm</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PartDialog({ repairId, onClose, onDone }: { repairId: string; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState({ name: '', number: '', qty: '1', cost: '' });
  const [busy, setBusy] = useState(false);
  const cost = parseMoneyToCents(p.cost);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Record part used" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Part name" htmlFor="pn" required><Input id="pn" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <Field label="Part number" htmlFor="pnum"><Input id="pnum" value={p.number} onChange={(e) => setP({ ...p, number: e.target.value })} /></Field>
          <Field label="Quantity" htmlFor="pq" required><Input id="pq" type="number" min={1} value={p.qty} onChange={(e) => setP({ ...p, qty: e.target.value })} /></Field>
          <Field label="Unit cost (R)" htmlFor="pc" required><Input id="pc" inputMode="decimal" value={p.cost} onChange={(e) => setP({ ...p, cost: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!p.name.trim() || cost === null || Number(p.qty) < 1} onClick={async () => {
            setBusy(true);
            try { await rpc('add_repair_part', { p_repair_id: repairId, p_part_name: p.name, p_part_number: p.number || null, p_quantity: Number(p.qty), p_unit_cost_cents: cost }); toast.success('Part recorded'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Add part</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
