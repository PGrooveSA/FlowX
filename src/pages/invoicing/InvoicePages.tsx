import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Ban, FileMinus, Plus, Printer, Send, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, fetchOne, rpc, type Filter } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney, labelize, parseMoneyToCents, todayLocal } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, useDebounce } from '@/components/common';
import { AttachmentsPanel } from '@/components/common/Attachments';
import type { WorkOrderRow } from '@/pages/work-orders/WorkOrdersPage';

type Row = Record<string, string>;
const c = createColumnHelper<Row>();
const w = createColumnHelper<WorkOrderRow>();

export function InvoicesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const filters = useMemo<Filter[]>(() => {
    if (status === 'outstanding') return [{ column: 'status', op: 'in', value: ['issued', 'partially_paid'] }];
    if (status === 'overdue') return [{ column: 'is_overdue', op: 'eq', value: true }];
    return [{ column: 'status', op: 'eq', value: status }];
  }, [status]);
  const [creating, setCreating] = useState<string | null>(null);

  return (
    <div>
      <PageHeader title="Invoicing" crumbs={[{ label: 'Invoicing' }]} description="Invoices are validated against actually issued device allocations. An invoice is not proof of dispatch or delivery." />
      <Tabs defaultValue={params.get('tab') ?? 'invoices'}>
        <TabsList><TabsTrigger value="invoices">Invoice register</TabsTrigger>{can('invoices.create') && <TabsTrigger value="ready">Ready for invoicing</TabsTrigger>}</TabsList>
        <TabsContent value="invoices">
          <div className="mb-3 flex flex-wrap gap-2">
            <Select aria-label="Status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses"
              options={['draft', 'outstanding', 'overdue', 'issued', 'partially_paid', 'paid', 'credited', 'cancelled'].map((s) => ({ value: s, label: labelize(s) }))} />
            <Input aria-label="Search" className="max-w-xs" placeholder="Invoice no., customer, EMIS, WO…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <ServerDataTable<Row> source="v_invoices" queryKey={['invoices']} filters={filters} search={debounced} searchColumns={['invoice_number', 'customer_name', 'emis_number', 'wo_number', 'po_reference']}
            defaultSort={{ column: 'created_at', desc: true }} onRowClick={(r) => nav(`/invoicing/${r.id}`)} exportName="invoice-register" emptyTitle="No invoices"
            columns={[
              c.accessor('invoice_number', { header: 'Invoice', cell: (x) => <Link className="mono text-primary hover:underline" to={`/invoicing/${x.row.original.id}`}>{x.getValue() ?? 'Draft'}</Link> }),
              c.accessor('display_status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} /> }),
              c.accessor('customer_name', { header: 'Customer' }), c.accessor('emis_number', { header: 'EMIS' }),
              c.accessor('wo_number', { header: 'Work order', cell: (x) => <span className="mono">{x.getValue() ?? '—'}</span> }),
              c.accessor('invoice_date', { header: 'Date', cell: (x) => formatDate(x.getValue()) }), c.accessor('due_date', { header: 'Due', cell: (x) => formatDate(x.getValue()) }),
              c.accessor('device_quantity', { header: 'Devices', enableSorting: false }),
              c.accessor('total_cents', { header: 'Total', cell: (x) => <span className="tabular-nums">{formatMoney(Number(x.getValue()))}</span> }),
              c.accessor('balance_cents', { header: 'Balance', cell: (x) => <span className="tabular-nums">{formatMoney(Number(x.getValue()))}</span> }),
            ]}
            exportColumns={['invoice_number', 'status', 'customer_name', 'emis_number', 'wo_number', 'po_reference', 'invoice_date', 'due_date', 'subtotal_cents', 'discount_cents', 'vat_cents', 'total_cents', 'amount_paid_cents', 'credited_cents', 'balance_cents', 'days_overdue']
              .map((k) => ({ header: k, value: (r: Row) => (k.endsWith('_cents') ? (Number(r[k]) / 100).toFixed(2) : r[k]) }))} />
        </TabsContent>
        <TabsContent value="ready">
          <ServerDataTable<WorkOrderRow> source="v_work_orders" queryKey={['work-orders', 'to-invoice']}
            filters={[{ column: 'invoice_required', op: 'eq', value: true }, { column: 'status', op: 'in', value: ['issued', 'pending_invoicing', 'partially_dispatched', 'partially_delivered', 'dispatched', 'delivered'] },
              { column: 'invoice_status', op: 'in', value: ['not_invoiced', 'partially_invoiced'] }]}
            defaultSort={{ column: 'updated_at', desc: false }} emptyTitle="No work orders waiting for invoicing"
            columns={[
              w.accessor('wo_number', { header: 'Work order', cell: (x) => <Link className="mono text-primary hover:underline" to={`/work-orders/${x.row.original.id}`}>{x.getValue()}</Link> }),
              w.accessor('status', { header: 'Status', cell: (x) => <StatusBadge status={x.getValue()} kind="wo" /> }), w.accessor('institution_name', { header: 'Institution' }),
              w.accessor('total_approved', { header: 'Approved', enableSorting: false }), w.accessor('total_issued', { header: 'Issued', enableSorting: false }),
              w.accessor('invoice_status', { header: 'Invoice', cell: (x) => <StatusBadge status={x.getValue()} /> }),
              w.display({ id: 'act', header: '', cell: (x) => <Button size="sm" loading={creating === x.row.original.id} onClick={async () => {
                setCreating(x.row.original.id);
                try { const id = await rpc<string>('create_invoice_draft', { p_work_order_id: x.row.original.id, p_auto_fill: true }); nav(`/invoicing/${id}`); }
                catch (e) { toast.error((e as Error).message); } finally { setCreating(null); }
              }}>Create draft invoice</Button> }),
            ]} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface InvoiceLine { id: string; line_no: number; line_type: string; description: string; work_order_line_id: string | null; quantity: number; unit_price_cents: number; discount_cents: number; vat_rate: number; line_subtotal_cents: number; vat_cents: number; line_total_cents: number }

export function InvoiceDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | 'issue' | 'cancel' | 'payment' | 'credit' | 'device' | 'charge' | 'edit'>(null);
  const [discount, setDiscount] = useState<InvoiceLine | null>(null);
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const inv = await fetchOne<Row>('v_invoices', 'id', id);
      const [lines, links, payments, credits, woLines] = await Promise.all([
        fetchAll<InvoiceLine>('invoice_lines', '*', (x) => x.eq('invoice_id', id).order('line_no')),
        fetchAll<{ id: string; status: string; invoice_line_id: string; devices: { id: string; serial_number: string; asset_tag: string } }>('invoice_device_links', 'id, status, invoice_line_id, devices(id, serial_number, asset_tag)', (x) => x.eq('invoice_id', id)),
        fetchAll<Row>('payments', '*', (x) => x.eq('invoice_id', id).order('payment_date')),
        fetchAll<Row>('credit_notes', '*', (x) => x.eq('invoice_id', id).order('created_at')),
        inv?.work_order_id ? fetchAll<{ id: string; line_no: number; approved_qty: number; device_categories: { name: string }; device_models: { model_name: string } | null }>('work_order_lines', 'id, line_no, approved_qty, device_categories(name), device_models(model_name)', (x) => x.eq('work_order_id', inv.work_order_id).order('line_no')) : Promise.resolve([]),
      ]);
      return { inv, lines, links, payments, credits, woLines };
    },
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['invoice', id] }); void qc.invalidateQueries({ queryKey: ['invoices'] }); void qc.invalidateQueries({ queryKey: ['work-orders'] }); };
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast.success(msg); refresh(); } catch (e) { toast.error((e as Error).message); throw e; } };

  if (q.isLoading) return <LoadingState />;
  const inv = q.data?.inv;
  if (!inv) return <ErrorState error={new Error('Invoice not found')} />;
  const draft = inv.status === 'draft';
  const open = ['issued', 'partially_paid'].includes(inv.status);
  const activeLinks = q.data!.links.filter((l) => l.status === 'active');

  return (
    <div className="space-y-4">
      <PageHeader title={inv.invoice_number ?? 'Draft invoice'} crumbs={[{ label: 'Invoicing', to: '/invoicing' }, { label: inv.invoice_number ?? 'Draft' }]}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={inv.display_status} /> {inv.customer_name}{inv.wo_number && <> · <Link className="mono text-primary hover:underline" to={`/work-orders/${inv.work_order_id}`}>{inv.wo_number}</Link></>}</span>}
        actions={<>
          <Button size="sm" variant="outline" asChild><Link to={`/print/invoice/${inv.id}`} target="_blank"><Printer /> {draft ? 'Preview' : 'Print / PDF'}</Link></Button>
          {draft && can('invoices.create') && <Button size="sm" variant="outline" onClick={() => setDialog('edit')}>Edit details</Button>}
          {draft && can('invoices.create') && inv.work_order_id && <Button size="sm" variant="outline" onClick={() => setDialog('device')}><Plus /> Device line</Button>}
          {draft && can('invoices.charges') && <Button size="sm" variant="outline" onClick={() => setDialog('charge')}><Plus /> Charge</Button>}
          {draft && can('invoices.issue') && <Button size="sm" onClick={() => setDialog('issue')}><Send /> Issue invoice</Button>}
          {draft && can('invoices.cancel') && <Button size="sm" variant="destructive" onClick={() => setDialog('cancel')}><Ban /> Cancel draft</Button>}
          {open && can('invoices.payments') && <Button size="sm" onClick={() => setDialog('payment')}><Wallet /> Record payment</Button>}
          {['issued', 'partially_paid', 'paid'].includes(inv.status) && can('invoices.credit') && <Button size="sm" variant="outline" onClick={() => setDialog('credit')}><FileMinus /> Credit note</Button>}
        </>} />

      {inv.status === 'cancelled' && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900">Cancelled {formatDateTime(inv.cancelled_at)}: {inv.cancellation_reason}</div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Billing details</CardTitle></CardHeader><CardContent>
          <KeyValue columns={3} items={[['Customer', inv.customer_name], ['Address', inv.customer_address], ['Customer VAT no.', inv.customer_vat_number], ['EMIS number', inv.emis_number],
            ['PO reference', inv.po_reference], ['Invoice date', formatDate(inv.invoice_date)], ['Payment terms', `${inv.payment_terms_days} days`], ['Due date', formatDate(inv.due_date)],
            ['Issued', inv.issued_at ? `${formatDateTime(inv.issued_at)} by ${inv.issued_by_name}` : '—'], ['Created by', inv.created_by_name]]} />
          {inv.notes && <p className="mt-3 text-sm"><span className="text-xs text-muted-foreground">Notes</span><br />{inv.notes}</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Totals ({inv.currency})</CardTitle></CardHeader><CardContent className="space-y-1.5 text-sm tabular-nums">
          {([['Subtotal', inv.subtotal_cents], ['Discount', -Number(inv.discount_cents)], ['VAT', inv.vat_cents]] as [string, number | string][]).map(([k, v]) => <div key={k} className="flex justify-between"><span>{k}</span><span>{formatMoney(Number(v))}</span></div>)}
          <div className="flex justify-between border-t pt-1.5 text-base font-semibold"><span>Total</span><span>{formatMoney(Number(inv.total_cents))}</span></div>
          <div className="flex justify-between"><span>Paid</span><span>{formatMoney(Number(inv.amount_paid_cents))}</span></div>
          <div className="flex justify-between"><span>Credited</span><span>{formatMoney(Number(inv.credited_cents))}</span></div>
          <div className="flex justify-between font-semibold"><span>Balance</span><span className={Number(inv.balance_cents) > 0 && inv.is_overdue ? 'text-red-700' : ''}>{formatMoney(Number(inv.balance_cents))}</span></div>
        </CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle>Line items</CardTitle></CardHeader><CardContent className="overflow-x-auto p-0">
        {q.data!.lines.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">#</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Type</th>
          <th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Unit price</th><th className="px-3 py-2 text-right">Discount</th><th className="px-3 py-2 text-right">VAT %</th><th className="px-3 py-2 text-right">VAT</th><th className="px-3 py-2 text-right">Total</th><th /></tr></thead>
          <tbody>{q.data!.lines.map((l) => (
            <tr key={l.id} className="border-t"><td className="px-3 py-2">{l.line_no}</td><td className="px-3 py-2">{l.description}
              {l.line_type === 'device' && <span className="block text-xs text-muted-foreground">{activeLinks.filter((k) => k.invoice_line_id === l.id).length} linked device(s)</span>}</td>
              <td className="px-3 py-2">{labelize(l.line_type)}</td><td className="px-3 py-2 text-right">{l.quantity}</td><td className="px-3 py-2 text-right">{formatMoney(l.unit_price_cents)}</td>
              <td className="px-3 py-2 text-right">{formatMoney(l.discount_cents)}</td><td className="px-3 py-2 text-right">{Number(l.vat_rate).toFixed(2)}</td><td className="px-3 py-2 text-right">{formatMoney(l.vat_cents)}</td>
              <td className="px-3 py-2 text-right font-medium">{formatMoney(l.line_total_cents)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">{draft && can('invoices.discount') && <Button size="sm" variant="ghost" onClick={() => setDiscount(l)}>Discount</Button>}
                {draft && can('invoices.create') && <Button size="icon" variant="ghost" aria-label={`Remove line ${l.line_no}`} onClick={() => void act(() => rpc('remove_invoice_line', { p_line_id: l.id }), 'Line removed').catch(() => {})}><Trash2 /></Button>}</td></tr>))}</tbody></table>
          : <EmptyState title="No lines" description="Add device lines from the work order's issued allocations, or authorised charges." />}
      </CardContent></Card>

      <Tabs defaultValue="devices">
        <TabsList><TabsTrigger value="devices">Invoiced devices ({activeLinks.length})</TabsTrigger><TabsTrigger value="payments">Payments ({q.data!.payments.length})</TabsTrigger>
          <TabsTrigger value="credits">Credit notes ({q.data!.credits.length})</TabsTrigger><TabsTrigger value="attachments">Attachments</TabsTrigger></TabsList>
        <TabsContent value="devices"><Card><CardContent className="max-h-80 overflow-y-auto p-0">
          {q.data!.links.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Serial</th><th className="px-3 py-2">Asset tag</th><th className="px-3 py-2">Link status</th></tr></thead>
            <tbody>{q.data!.links.map((k) => <tr key={k.id} className="border-t"><td className="px-3 py-1.5"><Link className="mono text-primary hover:underline" to={`/devices/${k.devices.id}`}>{k.devices.serial_number}</Link></td><td className="mono px-3 py-1.5">{k.devices.asset_tag}</td><td className="px-3 py-1.5"><StatusBadge status={k.status} /></td></tr>)}</tbody></table>
            : <EmptyState title="No device links" />}</CardContent></Card></TabsContent>
        <TabsContent value="payments"><Card><CardContent className="p-0">
          {q.data!.payments.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Payment</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Method</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
            <tbody>{q.data!.payments.map((p) => <tr key={p.id} className="border-t"><td className="mono px-3 py-1.5">{p.payment_number}</td><td className="px-3 py-1.5">{formatDate(p.payment_date)}</td><td className="px-3 py-1.5">{labelize(p.method)}</td><td className="px-3 py-1.5">{p.reference}</td><td className="px-3 py-1.5 text-right">{formatMoney(Number(p.amount_cents))}</td></tr>)}</tbody></table>
            : <EmptyState title="No payments recorded" />}</CardContent></Card></TabsContent>
        <TabsContent value="credits"><Card><CardContent className="p-0">
          {q.data!.credits.length ? <table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Credit note</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
            <tbody>{q.data!.credits.map((cr) => <tr key={cr.id} className="border-t"><td className="mono px-3 py-1.5">{cr.credit_note_number}</td><td className="px-3 py-1.5">{formatDateTime(cr.created_at)}</td>
              <td className="px-3 py-1.5">{String(cr.is_full_credit) === 'true' ? <Badge tone="gray">Full — {cr.released_allocations} allocation(s) released</Badge> : 'Partial'}</td><td className="px-3 py-1.5">{cr.reason}</td><td className="px-3 py-1.5 text-right">{formatMoney(Number(cr.amount_cents))}</td></tr>)}</tbody></table>
            : <EmptyState title="No credit notes" />}</CardContent></Card></TabsContent>
        <TabsContent value="attachments"><AttachmentsPanel entityType="invoice" entityId={inv.id} /></TabsContent>
      </Tabs>

      <ConfirmDialog open={dialog === 'issue'} onOpenChange={(o) => !o && setDialog(null)} title="Issue invoice"
        description="A sequential invoice number is assigned. Issued invoices cannot be edited or deleted — corrections require a credit note." confirmLabel="Issue invoice"
        onConfirm={() => act(() => rpc('issue_invoice', { p_invoice_id: inv.id }), 'Invoice issued')} />
      <ConfirmDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} title="Cancel draft invoice" destructive reasonLabel="Reason"
        description="Device allocations on this draft are released for invoicing again. The cancelled draft is kept for audit."
        onConfirm={(r) => act(() => rpc('cancel_invoice', { p_invoice_id: inv.id, p_reason: r }), 'Draft cancelled')} />
      {dialog === 'payment' && <PaymentDialog invoiceId={inv.id} balance={Number(inv.balance_cents)} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'credit' && <CreditDialog inv={inv} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'device' && <DeviceLineDialog invoiceId={inv.id} woLines={q.data!.woLines} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'charge' && <ChargeDialog invoiceId={inv.id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'edit' && <EditInvoiceDialog inv={inv} onClose={() => setDialog(null)} onDone={refresh} />}
      {discount && <MoneyPrompt title={`Discount for line ${discount.line_no}`} label="Discount amount (R)" max={discount.quantity * discount.unit_price_cents} onClose={() => setDiscount(null)}
        onSubmit={(cents) => act(() => rpc('set_invoice_line_discount', { p_line_id: discount.id, p_discount_cents: cents }), 'Discount applied')} />}
    </div>
  );
}

function MoneyPrompt({ title, label, max, onClose, onSubmit }: { title: string; label: string; max?: number; onClose: () => void; onSubmit: (cents: number) => Promise<unknown> }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const cents = parseMoneyToCents(v);
  const invalid = cents === null || cents < 0 || (max !== undefined && cents > max);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title={title} />
        <Field label={label} htmlFor="mp" error={v && invalid ? `Enter an amount between R0.00 and ${formatMoney(max ?? 0)}` : undefined}><Input id="mp" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={invalid} onClick={async () => { setBusy(true); try { await onSubmit(cents!); onClose(); } catch { /* toast shown */ } finally { setBusy(false); } }}>Apply</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentDialog({ invoiceId, balance, onClose, onDone }: { invoiceId: string; balance: number; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ amount: (balance / 100).toFixed(2), date: todayLocal(), method: 'eft', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const cents = parseMoneyToCents(v.amount);
  const invalid = cents === null || cents <= 0 || cents > balance;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Record payment" description={`Outstanding balance: ${formatMoney(balance)}`} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (R)" htmlFor="pa" required error={v.amount && invalid ? 'Amount must be more than zero and not exceed the balance' : undefined}><Input id="pa" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
          <Field label="Payment date" htmlFor="pd" required><Input id="pd" type="date" max={todayLocal()} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
          <Field label="Method" htmlFor="pm"><Select id="pm" value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} options={['eft', 'cash', 'cheque', 'card', 'journal', 'other'].map((m) => ({ value: m, label: m.toUpperCase() }))} /></Field>
          <Field label="Payment reference" htmlFor="pr"><Input id="pr" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
          <Field label="Notes" htmlFor="pn" className="sm:col-span-2"><Input id="pn" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={invalid} onClick={async () => {
            setBusy(true);
            try { await rpc('record_payment', { p_invoice_id: invoiceId, p_amount_cents: cents, p_payment_date: v.date, p_method: v.method, p_reference: v.reference || null, p_notes: v.notes || null }); toast.success('Payment recorded'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Record payment</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreditDialog({ inv, onClose, onDone }: { inv: Row; onClose: () => void; onDone: () => void }) {
  const [full, setFull] = useState(Number(inv.amount_paid_cents) === 0);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const cents = parseMoneyToCents(amount);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Issue credit note" description="The original invoice is kept unchanged; the credit note reduces its balance." />
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm"><Checkbox checked={full} disabled={Number(inv.amount_paid_cents) > 0} onChange={(e) => setFull(e.target.checked)} className="mt-0.5" />
            <span>Full credit — credits the outstanding balance and releases all device allocations so they can be re-invoiced correctly.{Number(inv.amount_paid_cents) > 0 && ' (Not available: payments recorded.)'}</span></label>
          {!full && <Field label="Credit amount incl. VAT (R)" htmlFor="ca" required><Input id="ca" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
          <Field label="Reason" htmlFor="cr" required><Textarea id="cr" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={reason.trim().length < 5 || (!full && (cents === null || cents <= 0))} onClick={async () => {
            setBusy(true);
            try { const r = await rpc<{ credit_note_number: string }>('create_credit_note', { p_invoice_id: inv.id, p_reason: reason, p_full: full, p_amount_cents: full ? null : cents }); toast.success(`Credit note ${r.credit_note_number} issued`); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Issue credit note</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceLineDialog({ invoiceId, woLines, onClose, onDone }: { invoiceId: string; woLines: { id: string; line_no: number; approved_qty: number; device_categories: { name: string }; device_models: { model_name: string } | null }[]; onClose: () => void; onDone: () => void }) {
  const [line, setLine] = useState(woLines[0]?.id ?? '');
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Add device line" description="Only issued devices that are not already on an active invoice are billable. Excess quantities are rejected." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Work order line" htmlFor="dl"><Select id="dl" value={line} onChange={(e) => setLine(e.target.value)} options={woLines.map((l) => ({ value: l.id, label: `${l.line_no}. ${l.device_models?.model_name ?? l.device_categories.name} (approved ${l.approved_qty})` }))} /></Field>
          <Field label="Quantity" htmlFor="dq"><Input id="dq" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!line || Number(qty) < 1} onClick={async () => {
            setBusy(true);
            try { await rpc('add_invoice_device_line', { p_invoice_id: invoiceId, p_work_order_line_id: line, p_quantity: Number(qty) }); toast.success('Device line added'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChargeDialog({ invoiceId, onClose, onDone }: { invoiceId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ type: 'service', description: '', qty: '1', price: '' });
  const [busy, setBusy] = useState(false);
  const cents = parseMoneyToCents(v.price);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Add authorised charge" description="Service, repair or delivery charges. VAT is applied at the configured rate." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Charge type" htmlFor="ct"><Select id="ct" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })} options={['service', 'repair', 'delivery', 'other'].map((t) => ({ value: t, label: labelize(t) }))} /></Field>
          <Field label="Quantity" htmlFor="cq"><Input id="cq" type="number" min={1} value={v.qty} onChange={(e) => setV({ ...v, qty: e.target.value })} /></Field>
          <Field label="Description" htmlFor="cd" required className="sm:col-span-2"><Input id="cd" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
          <Field label="Unit price excl. VAT (R)" htmlFor="cp" required><Input id="cp" inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={v.description.trim().length < 3 || cents === null || cents < 0 || Number(v.qty) < 1} onClick={async () => {
            setBusy(true);
            try { await rpc('add_invoice_charge_line', { p_invoice_id: invoiceId, p_line_type: v.type, p_description: v.description, p_quantity: Number(v.qty), p_unit_price_cents: cents }); toast.success('Charge added'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Add charge</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditInvoiceDialog({ inv, onClose, onDone }: { inv: Row; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ po_reference: inv.po_reference ?? '', payment_terms_days: String(inv.payment_terms_days), invoice_date: inv.invoice_date ?? '', customer_name: inv.customer_name,
    customer_address: inv.customer_address ?? '', customer_vat_number: inv.customer_vat_number ?? '', notes: inv.notes ?? '', terms: inv.terms ?? '' });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide><DialogHeader title="Edit draft invoice details" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name" htmlFor="ec"><Input id="ec" value={v.customer_name} onChange={(e) => setV({ ...v, customer_name: e.target.value })} /></Field>
          <Field label="Customer VAT number" htmlFor="ev"><Input id="ev" value={v.customer_vat_number} onChange={(e) => setV({ ...v, customer_vat_number: e.target.value })} /></Field>
          <Field label="Billing address" htmlFor="ea" className="sm:col-span-2"><Input id="ea" value={v.customer_address} onChange={(e) => setV({ ...v, customer_address: e.target.value })} /></Field>
          <Field label="Purchase order reference" htmlFor="ep"><Input id="ep" value={v.po_reference} onChange={(e) => setV({ ...v, po_reference: e.target.value })} /></Field>
          <Field label="Payment terms (days)" htmlFor="et"><Input id="et" type="number" min={0} max={365} value={v.payment_terms_days} onChange={(e) => setV({ ...v, payment_terms_days: e.target.value })} /></Field>
          <Field label="Invoice date" htmlFor="ed" hint="Defaults to the issue date"><Input id="ed" type="date" value={v.invoice_date} onChange={(e) => setV({ ...v, invoice_date: e.target.value })} /></Field>
          <Field label="Notes" htmlFor="en" className="sm:col-span-2"><Textarea id="en" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
          <Field label="Terms" htmlFor="etr" className="sm:col-span-2"><Textarea id="etr" value={v.terms} onChange={(e) => setV({ ...v, terms: e.target.value })} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={async () => {
            setBusy(true);
            try { await rpc('update_invoice_draft', { p_invoice_id: inv.id, p: { ...v, payment_terms_days: Number(v.payment_terms_days) } }); toast.success('Saved'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
