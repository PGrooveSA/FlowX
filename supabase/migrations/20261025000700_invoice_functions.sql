-- =====================================================================
-- Invoicing: drafts, validated device lines, issue, payments, credits
-- Money is stored as integer cents. Prices and VAT come from the server.
-- =====================================================================

create or replace function app_private.recalc_invoice(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update invoice_lines set
    line_subtotal_cents = quantity * unit_price_cents - discount_cents,
    vat_cents = round((quantity * unit_price_cents - discount_cents) * vat_rate / 100.0)::bigint,
    line_total_cents = (quantity * unit_price_cents - discount_cents) + round((quantity * unit_price_cents - discount_cents) * vat_rate / 100.0)::bigint
  where invoice_id = p_invoice;
  update invoices i set
    subtotal_cents = coalesce(x.gross, 0),
    discount_cents = coalesce(x.disc, 0),
    vat_cents = coalesce(x.vat, 0),
    total_cents = coalesce(x.total, 0)
  from (select sum(quantity * unit_price_cents) as gross, sum(discount_cents) as disc, sum(vat_cents) as vat, sum(line_total_cents) as total
        from invoice_lines where invoice_id = p_invoice) x
  where i.id = p_invoice;
end $$;

create or replace function app_private.billable_count(p_line uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from work_order_devices x
  where x.line_id = p_line and x.status in ('issued','dispatched','delivered')
    and not exists (select 1 from invoice_device_links k where k.work_order_device_id = x.id and k.status = 'active')
$$;

-- Add device lines for a work order line. Raises if the quantity exceeds the billable quantity.
create or replace function app_private.add_device_lines(p_invoice uuid, p_line uuid, p_qty int) returns int
language plpgsql security definer set search_path = public as $$
declare
  wl public.work_order_lines;
  v_ids uuid[];
  v_count int;
  g record;
  v_line_id uuid;
  v_no int;
  v_vat numeric := app_private.setting_num('finance.vat_rate', 15);
begin
  select * into wl from work_order_lines where id = p_line;
  if not found then raise exception 'Work order line not found'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;

  select array_agg(id) into v_ids from (
    select x.id from work_order_devices x
    where x.line_id = p_line and x.status in ('issued','dispatched','delivered')
      and not exists (select 1 from invoice_device_links k where k.work_order_device_id = x.id and k.status = 'active')
    order by x.issued_at, x.id
    limit p_qty
    for update of x
  ) s;
  v_count := coalesce(cardinality(v_ids), 0);
  if v_count < p_qty then
    raise exception 'Requested quantity % exceeds the billable quantity % for line % (only issued, not yet invoiced devices are billable)',
      p_qty, v_count, wl.line_no;
  end if;

  for g in
    select dv.model_id, m.manufacturer, m.model_name, m.unit_price_cents as model_price, array_agg(x.id) as alloc_ids, count(*)::int as cnt
    from work_order_devices x join devices dv on dv.id = x.device_id join device_models m on m.id = dv.model_id
    where x.id = any(v_ids)
    group by dv.model_id, m.manufacturer, m.model_name, m.unit_price_cents
  loop
    select id into v_line_id from invoice_lines
    where invoice_id = p_invoice and work_order_line_id = p_line and model_id = g.model_id and line_type = 'device';
    if v_line_id is null then
      select coalesce(max(line_no), 0) + 1 into v_no from invoice_lines where invoice_id = p_invoice;
      insert into invoice_lines (invoice_id, line_no, line_type, description, work_order_line_id, model_id, quantity, unit_price_cents, vat_rate)
      values (p_invoice, v_no, 'device', g.manufacturer || ' ' || g.model_name, p_line, g.model_id, g.cnt,
              coalesce(case when wl.model_id = g.model_id then wl.unit_price_cents end, g.model_price), v_vat)
      returning id into v_line_id;
    else
      update invoice_lines set quantity = quantity + g.cnt where id = v_line_id;
    end if;
    insert into invoice_device_links (invoice_id, invoice_line_id, work_order_device_id, device_id)
    select p_invoice, v_line_id, x.id, x.device_id from work_order_devices x where x.id = any(g.alloc_ids);
  end loop;
  return v_count;
end $$;

create or replace function public.create_invoice_draft(p_work_order_id uuid, p_auto_fill boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  inst public.institutions;
  v_id uuid;
  l record;
  v_billable int;
begin
  perform app_private.require_permission('invoices.create');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if not w.invoice_required then
    raise exception 'Work order % is invoice-exempt: %', w.wo_number, w.invoice_exempt_reason;
  end if;
  if w.status not in ('issued','pending_invoicing','invoiced','ready_for_dispatch','partially_dispatched','dispatched','partially_delivered','delivered') then
    raise exception 'Work order % is "%" and has no issued devices to invoice', w.wo_number, app_private.label(w.status);
  end if;
  if w.has_pending_amendment then raise exception 'Work order % has a pending amendment', w.wo_number; end if;
  if exists (select 1 from invoices where work_order_id = w.id and status = 'draft') then
    raise exception 'A draft invoice already exists for %', w.wo_number;
  end if;
  select coalesce(sum(app_private.billable_count(id)), 0) into v_billable from work_order_lines where work_order_id = w.id;
  if v_billable = 0 then
    raise exception 'All issued devices on % have already been invoiced', w.wo_number;
  end if;

  select * into inst from institutions where id = w.institution_id;
  insert into invoices (work_order_id, institution_id, customer_name, customer_address, customer_vat_number, emis_number,
                        payment_terms_days, terms, created_by)
  values (w.id, inst.id, coalesce(inst.billing_name, inst.name),
          coalesce(inst.billing_address, concat_ws(', ', inst.address_line1, inst.address_line2, inst.town, inst.postal_code)),
          inst.billing_vat_number, inst.emis_number,
          app_private.setting_num('finance.payment_terms_days', 30)::int, app_private.setting_text('finance.invoice_terms', null), auth.uid())
  returning id into v_id;

  if p_auto_fill then
    for l in select id from work_order_lines where work_order_id = w.id order by line_no loop
      v_billable := app_private.billable_count(l.id);
      if v_billable > 0 then
        perform app_private.add_device_lines(v_id, l.id, v_billable);
      end if;
    end loop;
  end if;
  perform app_private.recalc_invoice(v_id);
  if w.status = 'issued' then
    perform app_private.set_wo_status(w.id, 'pending_invoicing', 'Draft invoice created');
  end if;
  perform app_private.audit('create_invoice_draft', 'invoice', v_id::text, null, jsonb_build_object('work_order', w.wo_number), null,
    jsonb_build_object('invoice_id', v_id, 'work_order_id', w.id));
  return v_id;
end $$;

create or replace function public.add_invoice_device_line(p_invoice_id uuid, p_work_order_line_id uuid, p_quantity int) returns void
language plpgsql security definer set search_path = public as $$
declare i public.invoices;
begin
  perform app_private.require_permission('invoices.create');
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'draft' then raise exception 'Only draft invoices can be changed'; end if;
  if not exists (select 1 from work_order_lines where id = p_work_order_line_id and work_order_id = i.work_order_id) then
    raise exception 'The line does not belong to this invoice''s work order';
  end if;
  perform app_private.add_device_lines(i.id, p_work_order_line_id, p_quantity);
  perform app_private.recalc_invoice(i.id);
  perform app_private.audit('add_invoice_line', 'invoice', i.id::text, null,
    jsonb_build_object('work_order_line_id', p_work_order_line_id, 'quantity', p_quantity), null, jsonb_build_object('invoice_id', i.id));
end $$;

create or replace function public.add_invoice_charge_line(p_invoice_id uuid, p_line_type text, p_description text,
  p_quantity int, p_unit_price_cents bigint) returns void
language plpgsql security definer set search_path = public as $$
declare i public.invoices; v_no int;
begin
  perform app_private.require_permission('invoices.charges');
  if not app_private.setting_bool('invoice.allow_charges', true) then raise exception 'Non-device charges are disabled in settings'; end if;
  if p_line_type not in ('service','repair','delivery','other') then raise exception 'Invalid charge type'; end if;
  if length(trim(coalesce(p_description, ''))) < 3 then raise exception 'Enter a description'; end if;
  if coalesce(p_quantity, 0) < 1 or coalesce(p_unit_price_cents, -1) < 0 then raise exception 'Enter a valid quantity and price'; end if;
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'draft' then raise exception 'Only draft invoices can be changed'; end if;
  select coalesce(max(line_no), 0) + 1 into v_no from invoice_lines where invoice_id = i.id;
  insert into invoice_lines (invoice_id, line_no, line_type, description, quantity, unit_price_cents, vat_rate)
  values (i.id, v_no, p_line_type, trim(p_description), p_quantity, p_unit_price_cents, app_private.setting_num('finance.vat_rate', 15));
  perform app_private.recalc_invoice(i.id);
  perform app_private.audit('add_invoice_charge', 'invoice', i.id::text, null,
    jsonb_build_object('type', p_line_type, 'description', p_description, 'qty', p_quantity, 'unit_price_cents', p_unit_price_cents),
    null, jsonb_build_object('invoice_id', i.id));
end $$;

-- Draft content is editable; removing a line releases its device links.
create or replace function public.remove_invoice_line(p_line_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare ln public.invoice_lines; i public.invoices;
begin
  perform app_private.require_permission('invoices.create');
  select * into ln from invoice_lines where id = p_line_id;
  if not found then raise exception 'Invoice line not found'; end if;
  select * into i from invoices where id = ln.invoice_id for update;
  if i.status <> 'draft' then raise exception 'Only draft invoices can be changed'; end if;
  delete from invoice_device_links where invoice_line_id = ln.id;
  delete from invoice_lines where id = ln.id;
  perform app_private.recalc_invoice(i.id);
  perform app_private.audit('remove_invoice_line', 'invoice', i.id::text, to_jsonb(ln), null, null, jsonb_build_object('invoice_id', i.id));
end $$;

create or replace function public.set_invoice_line_discount(p_line_id uuid, p_discount_cents bigint) returns void
language plpgsql security definer set search_path = public as $$
declare ln public.invoice_lines; i public.invoices;
begin
  perform app_private.require_permission('invoices.discount');
  select * into ln from invoice_lines where id = p_line_id;
  if not found then raise exception 'Invoice line not found'; end if;
  select * into i from invoices where id = ln.invoice_id for update;
  if i.status <> 'draft' then raise exception 'Only draft invoices can be changed'; end if;
  if p_discount_cents < 0 or p_discount_cents > ln.quantity * ln.unit_price_cents then
    raise exception 'The discount must be between 0 and the line value';
  end if;
  update invoice_lines set discount_cents = p_discount_cents where id = ln.id;
  perform app_private.recalc_invoice(i.id);
  perform app_private.audit('invoice_discount', 'invoice', i.id::text, jsonb_build_object('discount_cents', ln.discount_cents),
    jsonb_build_object('discount_cents', p_discount_cents), null, jsonb_build_object('invoice_id', i.id));
end $$;

create or replace function public.update_invoice_draft(p_invoice_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare i public.invoices;
begin
  perform app_private.require_permission('invoices.create');
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'draft' then raise exception 'Only draft invoices can be changed'; end if;
  if p ? 'payment_terms_days' and ((p ->> 'payment_terms_days')::int < 0 or (p ->> 'payment_terms_days')::int > 365) then
    raise exception 'Payment terms must be between 0 and 365 days';
  end if;
  update invoices set
    po_reference = case when p ? 'po_reference' then nullif(p ->> 'po_reference', '') else po_reference end,
    notes = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
    terms = case when p ? 'terms' then nullif(p ->> 'terms', '') else terms end,
    payment_terms_days = case when p ? 'payment_terms_days' then (p ->> 'payment_terms_days')::int else payment_terms_days end,
    invoice_date = case when p ? 'invoice_date' then nullif(p ->> 'invoice_date', '')::date else invoice_date end,
    customer_name = case when p ? 'customer_name' and length(trim(p ->> 'customer_name')) > 0 then p ->> 'customer_name' else customer_name end,
    customer_address = case when p ? 'customer_address' then nullif(p ->> 'customer_address', '') else customer_address end,
    customer_vat_number = case when p ? 'customer_vat_number' then nullif(p ->> 'customer_vat_number', '') else customer_vat_number end
  where id = i.id;
  perform app_private.audit('update_invoice_draft', 'invoice', i.id::text, to_jsonb(i), p, null, jsonb_build_object('invoice_id', i.id));
end $$;

create or replace function public.issue_invoice(p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i public.invoices;
  w public.work_orders;
  v_number text;
  v_date date;
  v_approved int;
  v_invoiced int;
begin
  perform app_private.require_permission('invoices.issue');
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'draft' then raise exception 'Only draft invoices can be issued'; end if;
  if not exists (select 1 from invoice_lines where invoice_id = i.id) then raise exception 'The invoice has no lines'; end if;
  perform app_private.recalc_invoice(i.id);
  select * into i from invoices where id = p_invoice_id;
  if i.total_cents <= 0 then raise exception 'The invoice total must be greater than zero'; end if;

  if i.work_order_id is not null then
    select * into w from work_orders where id = i.work_order_id for update;
    if w.has_pending_amendment then raise exception 'Work order % has a pending amendment', w.wo_number; end if;
    -- every linked allocation must still be a valid billable allocation
    if exists (select 1 from invoice_device_links k join work_order_devices x on x.id = k.work_order_device_id
               where k.invoice_id = i.id and k.status = 'active' and x.status not in ('issued','dispatched','delivered')) then
      raise exception 'One or more invoiced devices are no longer validly allocated. Remove and re-add the device lines.';
    end if;
    if exists (select 1 from invoice_lines ln where ln.invoice_id = i.id and ln.line_type = 'device'
               and ln.quantity <> (select count(*) from invoice_device_links k where k.invoice_line_id = ln.id and k.status = 'active')) then
      raise exception 'Device line quantities do not match the linked device allocations';
    end if;
    select coalesce(sum(approved_qty), 0) into v_approved from work_order_lines where work_order_id = w.id;
    select count(*) into v_invoiced from invoice_device_links k join invoices x on x.id = k.invoice_id
    where x.work_order_id = w.id and k.status = 'active' and (x.status in ('issued','partially_paid','paid') or x.id = i.id);
    if v_invoiced > v_approved then
      raise exception 'Invoiced quantity % exceeds the authorised quantity %', v_invoiced, v_approved;
    end if;
    if v_invoiced < v_approved and not app_private.setting_bool('invoice.allow_partial', false) then
      raise exception 'Partial invoicing is disabled: % of % authorised devices would be invoiced', v_invoiced, v_approved;
    end if;
  end if;

  v_number := app_private.next_document_number('invoice');
  v_date := coalesce(i.invoice_date, (now() at time zone 'Africa/Johannesburg')::date);
  update invoices set status = 'issued', invoice_number = v_number, invoice_date = v_date,
    due_date = v_date + i.payment_terms_days, issued_by = auth.uid(), issued_at = now(),
    currency = app_private.setting_text('finance.currency', 'ZAR')
  where id = i.id;

  if w.id is not null and v_invoiced >= v_approved and w.status = 'pending_invoicing' then
    perform app_private.set_wo_status(w.id, 'invoiced', 'Invoice ' || v_number || ' issued');
    perform app_private.notify_permission('dispatch.create', 'Invoiced and ready for dispatch preparation: ' || w.wo_number,
      'Invoice ' || v_number || ' has been issued.', '/dispatch', 'dispatch', 'info', 'work_order', w.id, w.warehouse_id);
  end if;
  perform app_private.audit('issue_invoice', 'invoice', i.id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'issued', 'number', v_number, 'total_cents', i.total_cents), null,
    jsonb_build_object('invoice_id', i.id, 'work_order_id', i.work_order_id));
  return jsonb_build_object('ok', true, 'invoice_number', v_number);
end $$;

create or replace function public.record_payment(p_invoice_id uuid, p_amount_cents bigint, p_payment_date date,
  p_method text default 'eft', p_reference text default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare i public.invoices; v_balance bigint; v_id uuid;
begin
  perform app_private.require_permission('invoices.payments');
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status not in ('issued','partially_paid') then raise exception 'Payments can only be recorded on issued, unpaid invoices'; end if;
  v_balance := i.total_cents - i.amount_paid_cents - i.credited_cents;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'The payment amount must be greater than zero'; end if;
  if p_amount_cents > v_balance then raise exception 'The payment exceeds the outstanding balance'; end if;
  if p_payment_date is null or p_payment_date > (now() at time zone 'Africa/Johannesburg')::date then
    raise exception 'Enter a valid payment date (not in the future)';
  end if;
  insert into payments (payment_number, invoice_id, amount_cents, payment_date, method, reference, notes, recorded_by)
  values (app_private.next_document_number('payment'), i.id, p_amount_cents, p_payment_date, coalesce(p_method, 'eft'), p_reference, p_notes, auth.uid())
  returning id into v_id;
  update invoices set amount_paid_cents = amount_paid_cents + p_amount_cents,
    status = case when amount_paid_cents + p_amount_cents + credited_cents >= total_cents then 'paid' else 'partially_paid' end
  where id = i.id;
  perform app_private.audit('record_payment', 'invoice', i.id::text, jsonb_build_object('amount_paid_cents', i.amount_paid_cents),
    jsonb_build_object('amount_paid_cents', i.amount_paid_cents + p_amount_cents, 'reference', p_reference), null,
    jsonb_build_object('invoice_id', i.id, 'work_order_id', i.work_order_id));
  return v_id;
end $$;

create or replace function public.create_credit_note(p_invoice_id uuid, p_reason text, p_full boolean, p_amount_cents bigint default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i public.invoices;
  w public.work_orders;
  v_balance bigint;
  v_amount bigint;
  v_released int := 0;
  v_number text;
begin
  perform app_private.require_permission('invoices.credit');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason is required for a credit note'; end if;
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status not in ('issued','partially_paid','paid') then raise exception 'Only issued invoices can be credited'; end if;
  v_balance := i.total_cents - i.amount_paid_cents - i.credited_cents;

  if p_full then
    if i.amount_paid_cents > 0 then
      raise exception 'Invoice % has payments recorded. Record the refund outside the system and issue a partial credit for the balance.', i.invoice_number;
    end if;
    v_amount := v_balance;
    update invoice_device_links set status = 'credited', ended_at = now() where invoice_id = i.id and status = 'active';
    get diagnostics v_released = row_count;
  else
    v_amount := p_amount_cents;
    if v_amount is null or v_amount <= 0 or v_amount > v_balance then
      raise exception 'The credit amount must be greater than zero and not exceed the outstanding balance';
    end if;
  end if;
  if v_amount <= 0 then raise exception 'There is no outstanding balance to credit'; end if;

  v_number := app_private.next_document_number('credit_note');
  insert into credit_notes (credit_note_number, invoice_id, amount_cents, vat_cents, is_full_credit, reason, released_allocations, created_by)
  values (v_number, i.id, v_amount, case when i.total_cents > 0 then round(v_amount::numeric * i.vat_cents / i.total_cents)::bigint else 0 end,
          p_full, p_reason, v_released, auth.uid());
  update invoices set credited_cents = credited_cents + v_amount,
    status = case when p_full then 'credited'
                  when amount_paid_cents + credited_cents + v_amount >= total_cents then case when amount_paid_cents > 0 then 'paid' else 'credited' end
                  else status end
  where id = i.id;

  if p_full and i.work_order_id is not null then
    select * into w from work_orders where id = i.work_order_id for update;
    if w.status in ('invoiced','ready_for_dispatch') then
      perform app_private.set_wo_status(w.id, 'pending_invoicing', 'Credit note ' || v_number || ': ' || p_reason);
    end if;
  end if;
  perform app_private.audit('credit_note', 'invoice', i.id::text, jsonb_build_object('credited_cents', i.credited_cents),
    jsonb_build_object('credit_note', v_number, 'amount_cents', v_amount, 'full', p_full, 'released_allocations', v_released), p_reason,
    jsonb_build_object('invoice_id', i.id, 'work_order_id', i.work_order_id));
  return jsonb_build_object('ok', true, 'credit_note_number', v_number, 'amount_cents', v_amount, 'released_allocations', v_released);
end $$;

create or replace function public.cancel_invoice(p_invoice_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare i public.invoices; w public.work_orders;
begin
  perform app_private.require_permission('invoices.cancel');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A cancellation reason is required'; end if;
  select * into i from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'draft' then
    raise exception 'Issued invoice % cannot be cancelled or deleted. Issue a credit note instead.', i.invoice_number;
  end if;
  update invoice_device_links set status = 'cancelled', ended_at = now() where invoice_id = i.id and status = 'active';
  update invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancellation_reason = p_reason where id = i.id;
  if i.work_order_id is not null then
    select * into w from work_orders where id = i.work_order_id for update;
    if w.status = 'pending_invoicing' and not exists
       (select 1 from invoices where work_order_id = w.id and status in ('draft','issued','partially_paid','paid')) then
      perform app_private.set_wo_status(w.id, 'issued', 'Draft invoice cancelled');
    end if;
  end if;
  perform app_private.audit('cancel_invoice', 'invoice', i.id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'cancelled'), p_reason, jsonb_build_object('invoice_id', i.id, 'work_order_id', i.work_order_id));
end $$;
