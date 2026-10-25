-- =====================================================================
-- Core helpers and the work order / allocation / issuing lifecycle.
-- Every public function here is SECURITY DEFINER and validates the
-- caller's permissions, scope and the business rules server-side.
-- =====================================================================

create or replace function app_private.label(p text) returns text
language sql immutable as $$ select initcap(replace(coalesce(p, ''), '_', ' ')) $$;

-- Apply a device status/location change and write the custody ledger entry.
create or replace function app_private.move_device(p_device uuid, p_to_status text, p_movement text, p_opts jsonb default '{}'::jsonb)
returns public.devices
language plpgsql security definer set search_path = public as $$
declare
  d public.devices;
  n public.devices;
begin
  select * into d from devices where id = p_device for update;
  if not found then raise exception 'Device not found'; end if;

  update devices set
    status = coalesce(p_to_status, status),
    warehouse_id = case when p_opts ? 'to_warehouse_id' then (p_opts ->> 'to_warehouse_id')::uuid else warehouse_id end,
    location_id = case when p_opts ? 'to_location_id' then nullif(p_opts ->> 'to_location_id', '')::uuid else location_id end,
    current_work_order_id = case when p_opts ? 'assign_work_order_id' then nullif(p_opts ->> 'assign_work_order_id', '')::uuid else current_work_order_id end,
    current_institution_id = case when p_opts ? 'assign_institution_id' then nullif(p_opts ->> 'assign_institution_id', '')::uuid else current_institution_id end,
    current_recipient_id = case when p_opts ? 'assign_recipient_id' then nullif(p_opts ->> 'assign_recipient_id', '')::uuid else current_recipient_id end,
    condition = coalesce(nullif(p_opts ->> 'condition', ''), condition),
    last_verified_at = case when coalesce((p_opts ->> 'verified')::boolean, false) then now() else last_verified_at end
  where id = p_device
  returning * into n;

  insert into device_movements (device_id, movement_type, from_status, to_status, from_warehouse_id, to_warehouse_id,
                                from_location_id, to_location_id, institution_id, work_order_id, dispatch_id, reference, reason, performed_by)
  values (p_device, p_movement, d.status, n.status, d.warehouse_id, n.warehouse_id, d.location_id, n.location_id,
          coalesce(nullif(p_opts ->> 'institution_id', '')::uuid, n.current_institution_id),
          nullif(p_opts ->> 'work_order_id', '')::uuid, nullif(p_opts ->> 'dispatch_id', '')::uuid,
          p_opts ->> 'reference', p_opts ->> 'reason', auth.uid());
  return n;
end $$;

-- Controlled work order status change with history and audit.
create or replace function app_private.set_wo_status(p_wo uuid, p_to text, p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_number text;
begin
  select status, wo_number into v_from, v_number from work_orders where id = p_wo for update;
  if not found then raise exception 'Work order not found'; end if;
  if v_from = p_to then return; end if;
  if not exists (select 1 from work_order_status_transitions where from_status = v_from and to_status = p_to) then
    raise exception 'Work order % cannot move from "%" to "%"', v_number, app_private.label(v_from), app_private.label(p_to);
  end if;
  update work_orders set
    status = p_to,
    updated_at = now(),
    version = version + 1,
    completed_at = case when p_to = 'completed' then now() else completed_at end,
    cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end
  where id = p_wo;
  insert into work_order_status_history (work_order_id, from_status, to_status, reason, changed_by)
  values (p_wo, v_from, p_to, p_reason, auth.uid());
  perform app_private.audit('status_change', 'work_order', p_wo::text,
    jsonb_build_object('status', v_from), jsonb_build_object('status', p_to), p_reason,
    jsonb_build_object('work_order_id', p_wo));
end $$;

create or replace function app_private.scan_fail(p_context text, p_code text, p_message text, p_refs jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform app_private.audit('scan_rejected', p_context, coalesce(p_refs ->> 'device_id', p_refs ->> 'work_order_id'),
    null, null, p_message, p_refs, false, jsonb_build_object('code', p_code, 'scanned_serial', p_refs ->> 'scanned_serial'));
  return jsonb_build_object('ok', false, 'code', p_code, 'message', p_message);
end $$;

-- Record a serial discrepancy; the transaction that called this commits the
-- record but the requested operation itself is NOT performed.
create or replace function app_private.record_discrepancy(
  p_context text, p_reason text, p_message text, p_wo uuid, p_dispatch uuid,
  p_expected_device uuid, p_expected_serial text, p_scanned_serial text, p_scanned_device uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_number text := app_private.next_document_number('discrepancy');
  v_wh uuid;
begin
  insert into serial_discrepancies (discrepancy_number, context, reason_code, message, work_order_id, dispatch_id,
    expected_device_id, expected_serial, scanned_serial, scanned_device_id, reported_by)
  values (v_number, p_context, p_reason, p_message, p_wo, p_dispatch, p_expected_device, p_expected_serial,
    p_scanned_serial, p_scanned_device, auth.uid())
  returning id into v_id;

  perform app_private.audit('serial_discrepancy', 'serial_discrepancy', v_id::text, null,
    jsonb_build_object('number', v_number, 'reason', p_reason, 'expected_serial', p_expected_serial, 'scanned_serial', p_scanned_serial),
    p_message,
    jsonb_build_object('work_order_id', p_wo, 'dispatch_id', p_dispatch, 'device_id', coalesce(p_scanned_device, p_expected_device)),
    false, jsonb_build_object('context', p_context));

  select warehouse_id into v_wh from work_orders where id = p_wo;
  perform app_private.notify_permission('devices.resolve_discrepancy', 'Serial discrepancy ' || v_number, p_message,
    '/discrepancies', 'discrepancy', 'critical', 'serial_discrepancy', v_id, v_wh);

  return jsonb_build_object('ok', false, 'code', p_reason, 'message', p_message, 'discrepancy_id', v_id,
    'discrepancy_number', v_number, 'expected_serial', p_expected_serial, 'scanned_serial', p_scanned_serial);
end $$;

-- Returns a human-readable reason why the device may not be issued, or NULL.
create or replace function app_private.device_issue_problem(d public.devices, p_warehouse uuid, p_expected_status text)
returns text
language plpgsql stable security definer set search_path = public as $$
declare v_wh text;
begin
  if d.status in ('faulty','under_assessment','under_repair','awaiting_parts','quarantined','returned_to_warehouse','repair_completed') then
    return format('Device %s is "%s" and cannot be allocated until it is inspected and released', coalesce(d.serial_number, d.asset_tag), app_private.label(d.status));
  end if;
  if d.status in ('lost','stolen','written_off') then
    return format('Device %s is recorded as "%s"', coalesce(d.serial_number, d.asset_tag), app_private.label(d.status));
  end if;
  if d.status <> p_expected_status then
    return format('Device %s is "%s" (expected "%s")', coalesce(d.serial_number, d.asset_tag), app_private.label(d.status), app_private.label(p_expected_status));
  end if;
  if d.condition in ('faulty','damaged','beyond_repair') then
    return format('Device %s condition is "%s"', coalesce(d.serial_number, d.asset_tag), app_private.label(d.condition));
  end if;
  if p_warehouse is not null and d.warehouse_id <> p_warehouse then
    select code into v_wh from warehouses where id = d.warehouse_id;
    return format('Device %s is held in warehouse %s, not the work order warehouse', coalesce(d.serial_number, d.asset_tag), v_wh);
  end if;
  if exists (select 1 from serial_discrepancies where scanned_device_id = d.id and status = 'open') then
    return format('Device %s has an open serial discrepancy', coalesce(d.serial_number, d.asset_tag));
  end if;
  return null;
end $$;

create or replace function app_private.line_matches(l public.work_order_lines, d public.devices) returns boolean
language sql immutable as $$
  select (l.model_id is not null and l.model_id = d.model_id) or (l.model_id is null and l.category_id = d.category_id)
$$;

create or replace function app_private.line_active_count(p_line uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from work_order_devices
  where line_id = p_line and status in ('reserved','picked','issued','dispatched','delivered')
$$;

create or replace function public.work_order_progress(p_work_order_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'requested', (select coalesce(sum(requested_qty), 0) from work_order_lines where work_order_id = p_work_order_id),
    'approved', (select coalesce(sum(approved_qty), 0) from work_order_lines where work_order_id = p_work_order_id),
    'reserved', count(*) filter (where status = 'reserved'),
    'picked', count(*) filter (where status = 'picked'),
    'issued', count(*) filter (where status in ('issued','dispatched','delivered')),
    'dispatched', count(*) filter (where status in ('dispatched','delivered')),
    'delivered', count(*) filter (where status = 'delivered'),
    'returned', count(*) filter (where status = 'returned')
  )
  from work_order_devices where work_order_id = p_work_order_id
$$;

-- Recompute dispatch-phase status from the per-device allocation states.
create or replace function app_private.recompute_fulfilment(p_wo uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_approved int;
  v_delivered int;
  v_transit int;
  v_target text;
begin
  select status into v_status from work_orders where id = p_wo for update;
  if v_status not in ('ready_for_dispatch','partially_dispatched','dispatched','partially_delivered','delivered') then
    return;
  end if;
  select coalesce(sum(approved_qty), 0) into v_approved from work_order_lines where work_order_id = p_wo;
  select count(*) filter (where status = 'delivered'), count(*) filter (where status = 'dispatched')
    into v_delivered, v_transit from work_order_devices where work_order_id = p_wo;
  v_target := case
    when v_delivered >= v_approved and v_approved > 0 then 'delivered'
    when v_delivered > 0 then 'partially_delivered'
    when v_transit >= v_approved and v_approved > 0 then 'dispatched'
    when v_transit > 0 then 'partially_dispatched'
    else v_status end;
  if v_target <> v_status then
    perform app_private.set_wo_status(p_wo, v_target, 'Fulfilment recalculated from device allocations');
  end if;
end $$;

-- Find exactly one device for a scanned serial, narrowing by work order lines when needed.
create or replace function app_private.find_scanned_device(p_serial text, p_wo uuid) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v_ids uuid[];
begin
  select array_agg(id) into v_ids from devices where serial_normalized = public.normalize_serial(p_serial);
  if v_ids is not null and cardinality(v_ids) > 1 and p_wo is not null then
    select array_agg(d.id) into v_ids from devices d
    where d.id = any(v_ids)
      and exists (select 1 from work_order_lines l where l.work_order_id = p_wo and app_private.line_matches(l, d));
  end if;
  return v_ids;
end $$;

-- =====================================================================
-- Work order creation, submission and approval
-- =====================================================================
create or replace function public.save_work_order(p_id uuid, p_header jsonb, p_lines jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  v_inst public.institutions;
  v_type public.work_order_types;
  v_id uuid;
  v_line jsonb;
  v_no int := 0;
  v_cat public.device_categories;
  v_model public.device_models;
  v_qty int;
  v_recipient public.recipients;
  v_old_lines jsonb;
  v_warehouse uuid := nullif(p_header ->> 'warehouse_id', '')::uuid;
begin
  perform app_private.require_permission('work_orders.create');

  select * into v_inst from institutions where id = nullif(p_header ->> 'institution_id', '')::uuid;
  if not found then raise exception 'Select a valid institution'; end if;
  if v_inst.status <> 'active' then raise exception 'Institution % is %', v_inst.name, v_inst.status; end if;

  select * into v_type from work_order_types where id = nullif(p_header ->> 'work_order_type_id', '')::uuid and is_active;
  if not found then raise exception 'Select a valid work order type'; end if;

  if coalesce(p_header ->> 'recipient_type', '') not in ('learner','teacher','school','department','other') then
    raise exception 'Select a valid recipient type';
  end if;
  if nullif(p_header ->> 'recipient_id', '') is not null then
    select * into v_recipient from recipients where id = (p_header ->> 'recipient_id')::uuid;
    if not found or v_recipient.institution_id <> v_inst.id then
      raise exception 'The selected recipient does not belong to %', v_inst.name;
    end if;
  end if;
  if v_warehouse is not null then
    if not exists (select 1 from warehouses where id = v_warehouse and is_active) then
      raise exception 'Select an active warehouse';
    end if;
  end if;
  if coalesce(p_header ->> 'priority', 'normal') not in ('low','normal','high','urgent') then
    raise exception 'Invalid priority';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A work order needs at least one device line';
  end if;

  if p_id is null then
    insert into work_orders (wo_number, work_order_type_id, priority, province_id, district_id, institution_id,
      recipient_type, recipient_id, recipient_group, grade, class_name, description, instructions, internal_notes,
      warehouse_id, invoice_required, invoice_exempt_reason, source_reference, imported_at, created_by)
    values (app_private.next_document_number('work_order'), v_type.id, coalesce(p_header ->> 'priority', 'normal'),
      v_inst.province_id, v_inst.district_id, v_inst.id,
      p_header ->> 'recipient_type', v_recipient.id, nullif(p_header ->> 'recipient_group', ''),
      nullif(p_header ->> 'grade', ''), nullif(p_header ->> 'class_name', ''),
      nullif(p_header ->> 'description', ''), nullif(p_header ->> 'instructions', ''), nullif(p_header ->> 'internal_notes', ''),
      v_warehouse, v_type.requires_invoice,
      case when v_type.requires_invoice then null else format('Work order type "%s" is configured as invoice-exempt', v_type.name) end,
      nullif(p_header ->> 'source_reference', ''), nullif(p_header ->> 'imported_at', '')::timestamptz, auth.uid())
    returning id into v_id;
    insert into work_order_status_history (work_order_id, from_status, to_status, reason, changed_by)
    values (v_id, null, 'draft', 'Created', auth.uid());
  else
    select * into w from work_orders where id = p_id for update;
    if not found then raise exception 'Work order not found'; end if;
    if w.status not in ('draft','returned_for_correction') then
      raise exception 'Work order % is "%" and can no longer be edited directly. Request an amendment instead.', w.wo_number, app_private.label(w.status);
    end if;
    if w.created_by <> auth.uid() and not public.has_permission('work_orders.edit_any') then
      raise exception 'Permission denied: only the creator can edit this draft' using errcode = '42501';
    end if;
    v_id := w.id;
    select jsonb_agg(to_jsonb(l) order by l.line_no) into v_old_lines from work_order_lines l where l.work_order_id = v_id;
    update work_orders set
      work_order_type_id = v_type.id, priority = coalesce(p_header ->> 'priority', 'normal'),
      province_id = v_inst.province_id, district_id = v_inst.district_id, institution_id = v_inst.id,
      recipient_type = p_header ->> 'recipient_type', recipient_id = v_recipient.id,
      recipient_group = nullif(p_header ->> 'recipient_group', ''), grade = nullif(p_header ->> 'grade', ''),
      class_name = nullif(p_header ->> 'class_name', ''), description = nullif(p_header ->> 'description', ''),
      instructions = nullif(p_header ->> 'instructions', ''), internal_notes = nullif(p_header ->> 'internal_notes', ''),
      warehouse_id = v_warehouse, invoice_required = v_type.requires_invoice,
      invoice_exempt_reason = case when v_type.requires_invoice then null else format('Work order type "%s" is configured as invoice-exempt', v_type.name) end,
      source_reference = nullif(p_header ->> 'source_reference', ''),
      updated_at = now(), version = version + 1
    where id = v_id;
    -- Draft lines have no allocations yet, so they are replaced; the audit row keeps the previous lines.
    delete from work_order_lines where work_order_id = v_id;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    select * into v_cat from device_categories where id = nullif(v_line ->> 'category_id', '')::uuid and is_active;
    if not found then raise exception 'Line %: select a valid device category', v_no; end if;
    v_model := null;
    if nullif(v_line ->> 'model_id', '') is not null then
      select * into v_model from device_models where id = (v_line ->> 'model_id')::uuid and is_active;
      if not found or v_model.category_id <> v_cat.id then
        raise exception 'Line %: the model does not belong to category %', v_no, v_cat.name;
      end if;
    end if;
    begin
      v_qty := (v_line ->> 'requested_qty')::int;
    exception when others then
      raise exception 'Line %: quantity must be a whole number', v_no;
    end;
    if v_qty is null or v_qty < 1 or v_qty > 100000 then
      raise exception 'Line %: quantity must be between 1 and 100000', v_no;
    end if;
    insert into work_order_lines (work_order_id, line_no, category_id, model_id, requested_qty, notes)
    values (v_id, v_no, v_cat.id, v_model.id, v_qty, nullif(v_line ->> 'notes', ''));
  end loop;

  perform app_private.audit(case when p_id is null then 'create' else 'update' end, 'work_order', v_id::text,
    case when p_id is null then null else jsonb_build_object('header', to_jsonb(w), 'lines', v_old_lines) end,
    jsonb_build_object('header', p_header, 'lines', p_lines), null, jsonb_build_object('work_order_id', v_id));
  return v_id;
end $$;

create or replace function public.submit_work_order(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('work_orders.create');
  select * into w from work_orders where id = p_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.created_by <> auth.uid() and not public.has_permission('work_orders.edit_any') then
    raise exception 'Permission denied: only the creator can submit this work order' using errcode = '42501';
  end if;
  if not exists (select 1 from work_order_lines where work_order_id = p_id) then
    raise exception 'Add at least one device line before submitting';
  end if;
  perform app_private.set_wo_status(p_id, 'pending_authorisation', 'Submitted for authorisation');
  update work_orders set submitted_at = now(), rejection_reason = null where id = p_id;
  insert into work_order_approvals (work_order_id, action, decided_by, snapshot)
  values (p_id, 'submitted', auth.uid(), (select jsonb_agg(to_jsonb(l)) from work_order_lines l where l.work_order_id = p_id));
  perform app_private.notify_permission('work_orders.approve', 'Authorisation required: ' || w.wo_number,
    'A work order has been submitted and is awaiting authorisation.', '/work-orders/' || p_id, 'approval', 'warning',
    'work_order', p_id, null, auth.uid());
end $$;

create or replace function public.approve_work_order(p_id uuid, p_lines jsonb default '[]'::jsonb, p_comment text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  l record;
  v_approved int;
  v_total int := 0;
  v_entry jsonb;
begin
  perform app_private.require_permission('work_orders.approve');
  select * into w from work_orders where id = p_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.status <> 'pending_authorisation' then
    raise exception 'Work order % is "%" and is not awaiting authorisation', w.wo_number, app_private.label(w.status);
  end if;
  if app_private.setting_bool('workflow.sod_creator_cannot_approve', true) and w.created_by = auth.uid() then
    raise exception 'Segregation of duties: you cannot approve a work order you created' using errcode = '42501';
  end if;

  for l in select * from work_order_lines where work_order_id = p_id order by line_no loop
    select e into v_entry from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e where e ->> 'line_id' = l.id::text;
    v_approved := coalesce((v_entry ->> 'approved_qty')::int, l.requested_qty);
    if v_approved < 0 or v_approved > l.requested_qty then
      raise exception 'Line %: approved quantity must be between 0 and the requested quantity (%)', l.line_no, l.requested_qty;
    end if;
    v_total := v_total + v_approved;
    update work_order_lines set approved_qty = v_approved,
      unit_price_cents = (select unit_price_cents from device_models where id = l.model_id)
    where id = l.id;
  end loop;

  if v_total = 0 then raise exception 'At least one device must be approved. Return the work order instead.'; end if;
  if v_total > app_private.setting_num('workflow.large_quantity_threshold', 100) then
    perform app_private.require_permission('work_orders.approve_large');
  end if;

  update work_orders set approved_at = now(), approved_by = auth.uid() where id = p_id;
  perform app_private.set_wo_status(p_id, 'approved', coalesce(p_comment, 'Approved'));
  perform app_private.set_wo_status(p_id, 'pending_scheduling', 'Awaiting scheduling');
  insert into work_order_approvals (work_order_id, action, comments, decided_by, snapshot)
  values (p_id, 'approved', p_comment, auth.uid(), (select jsonb_agg(to_jsonb(x)) from work_order_lines x where x.work_order_id = p_id));
  perform app_private.notify_user(w.created_by, 'Work order approved: ' || w.wo_number,
    format('%s device(s) approved.', v_total), '/work-orders/' || p_id, 'approval', 'success', 'work_order', p_id);
  perform app_private.notify_permission('work_orders.schedule', 'Scheduling required: ' || w.wo_number,
    'An approved work order is waiting to be scheduled.', '/scheduling', 'scheduling', 'info', 'work_order', p_id, w.warehouse_id);
end $$;

create or replace function public.reject_work_order(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('work_orders.approve');
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason (at least 5 characters) is required when returning a work order';
  end if;
  select * into w from work_orders where id = p_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.status <> 'pending_authorisation' then
    raise exception 'Work order % is not awaiting authorisation', w.wo_number;
  end if;
  perform app_private.set_wo_status(p_id, 'returned_for_correction', p_reason);
  update work_orders set rejection_reason = p_reason where id = p_id;
  insert into work_order_approvals (work_order_id, action, comments, decided_by) values (p_id, 'returned', p_reason, auth.uid());
  perform app_private.notify_user(w.created_by, 'Work order returned for correction: ' || w.wo_number, p_reason,
    '/work-orders/' || p_id, 'approval', 'warning', 'work_order', p_id);
end $$;

-- Cancellation uses compensating transactions: allocations are released,
-- draft invoices cancelled and every change recorded. Nothing is deleted.
create or replace function public.cancel_work_order(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  r record;
begin
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A cancellation reason (at least 5 characters) is required';
  end if;
  select * into w from work_orders where id = p_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if not (public.has_permission('work_orders.cancel')
          or (w.status = 'draft' and w.created_by = auth.uid() and public.has_permission('work_orders.create'))) then
    raise exception 'Permission denied: "work_orders.cancel" is required for this action' using errcode = '42501';
  end if;
  if exists (select 1 from work_order_devices where work_order_id = p_id and status in ('dispatched','delivered')) then
    raise exception 'Work order % has dispatched devices and cannot be cancelled. Record returns instead.', w.wo_number;
  end if;
  if exists (select 1 from invoice_device_links k join invoices i on i.id = k.invoice_id
             where i.work_order_id = p_id and k.status = 'active' and i.status not in ('draft','cancelled')) then
    raise exception 'Work order % has an issued invoice. Issue a credit note before cancelling.', w.wo_number;
  end if;

  for r in select id from invoices where work_order_id = p_id and status = 'draft' loop
    update invoice_device_links set status = 'cancelled', ended_at = now() where invoice_id = r.id and status = 'active';
    update invoices set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
      cancellation_reason = 'Work order cancelled: ' || p_reason where id = r.id;
  end loop;

  for r in select dd.id from dispatch_devices dd join dispatches dp on dp.id = dd.dispatch_id
           where dp.work_order_id = p_id and dp.status = 'draft' and dd.status = 'loaded' loop
    update dispatch_devices set status = 'removed' where id = r.id;
  end loop;
  update dispatches set status = 'cancelled', cancelled_reason = 'Work order cancelled' where work_order_id = p_id and status = 'draft';

  for r in select * from work_order_devices where work_order_id = p_id and status in ('reserved','picked','issued') loop
    update work_order_devices set status = 'cancelled', released_at = now(), released_by = auth.uid(),
      release_reason = 'Work order cancelled: ' || p_reason where id = r.id;
    perform app_private.move_device(r.device_id, 'available', 'allocation_reversal',
      jsonb_build_object('work_order_id', p_id, 'reference', w.wo_number, 'reason', 'Work order cancelled: ' || p_reason,
                         'assign_work_order_id', null, 'assign_institution_id', null, 'assign_recipient_id', null));
  end loop;

  update schedules set status = 'cancelled' where work_order_id = p_id and status = 'active';
  perform app_private.set_wo_status(p_id, 'cancelled', p_reason);
  update work_orders set cancellation_reason = p_reason, has_pending_amendment = false where id = p_id;
  update work_order_amendments set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
    decision_comment = 'Work order cancelled' where work_order_id = p_id and status = 'pending';
  perform app_private.notify_user(w.created_by, 'Work order cancelled: ' || w.wo_number, p_reason,
    '/work-orders/' || p_id, 'work_order', 'warning', 'work_order', p_id);
end $$;

-- =====================================================================
-- Scheduling
-- =====================================================================
create or replace function public.work_order_stock_check(p_work_order_id uuid, p_warehouse_id uuid default null)
returns table (line_id uuid, line_no int, category_name text, model_name text, approved_qty int,
               allocated_qty int, available_qty int, shortage int)
language plpgsql stable security definer set search_path = public as $$
declare v_wh uuid;
begin
  perform app_private.require_permission('work_orders.view');
  select coalesce(p_warehouse_id, w.warehouse_id) into v_wh from work_orders w where w.id = p_work_order_id;
  return query
  select l.id, l.line_no, c.name, case when m.id is null then 'Any ' || c.name else m.manufacturer || ' ' || m.model_name end,
    coalesce(l.approved_qty, l.requested_qty),
    app_private.line_active_count(l.id),
    (select count(*)::int from devices d
      where d.warehouse_id = v_wh and d.status = 'available' and d.condition in ('new','good','fair')
        and (d.model_id = l.model_id or (l.model_id is null and d.category_id = l.category_id))
        and not exists (select 1 from serial_discrepancies s where s.scanned_device_id = d.id and s.status = 'open')),
    0
  from work_order_lines l
  join device_categories c on c.id = l.category_id
  left join device_models m on m.id = l.model_id
  where l.work_order_id = p_work_order_id
  order by l.line_no;
end $$;

create or replace function public.schedule_work_order(
  p_id uuid, p_warehouse_id uuid, p_scheduled_date date, p_assigned_team text default null,
  p_assigned_to uuid default null, p_priority text default null, p_reason text default null,
  p_accept_shortage boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  v_short jsonb;
  v_is_reschedule boolean;
begin
  perform app_private.require_permission('work_orders.schedule');
  select * into w from work_orders where id = p_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.status not in ('pending_scheduling','scheduled','scheduled_pending_issuing') then
    raise exception 'Work order % is "%" and cannot be scheduled', w.wo_number, app_private.label(w.status);
  end if;
  if w.has_pending_amendment then raise exception 'Work order % has a pending amendment', w.wo_number; end if;
  if not exists (select 1 from warehouses where id = p_warehouse_id and is_active) then
    raise exception 'Select an active warehouse';
  end if;
  perform app_private.require_warehouse_scope(p_warehouse_id);
  if p_scheduled_date is null or p_scheduled_date < (now() at time zone 'Africa/Johannesburg')::date then
    raise exception 'The scheduled date cannot be in the past';
  end if;
  if p_priority is not null and p_priority not in ('low','normal','high','urgent') then raise exception 'Invalid priority'; end if;
  if p_assigned_to is not null and not exists (select 1 from profiles where id = p_assigned_to and is_active) then
    raise exception 'The assigned user is not active';
  end if;

  v_is_reschedule := w.status in ('scheduled','scheduled_pending_issuing');
  if v_is_reschedule and length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason is required to reschedule a work order';
  end if;
  if w.warehouse_id is distinct from p_warehouse_id and exists
     (select 1 from work_order_devices where work_order_id = p_id and status in ('reserved','picked','issued')) then
    raise exception 'Release the current reservations before moving the work order to another warehouse';
  end if;

  select jsonb_agg(jsonb_build_object('line_no', s.line_no, 'model', s.model_name,
           'needed', s.approved_qty - s.allocated_qty, 'available', s.available_qty))
    into v_short
  from public.work_order_stock_check(p_id, p_warehouse_id) s
  where s.approved_qty - s.allocated_qty > s.available_qty;

  if v_short is not null then
    if not p_accept_shortage then
      return jsonb_build_object('ok', false, 'code', 'stock_shortage',
        'message', 'Insufficient available stock in the selected warehouse', 'shortages', v_short);
    end if;
    if length(trim(coalesce(p_reason, ''))) < 5 then
      raise exception 'A reason is required to schedule despite a stock shortage';
    end if;
    perform app_private.notify_permission('inventory.receive', 'Stock shortage for ' || w.wo_number,
      'A work order was scheduled with insufficient stock.', '/work-orders/' || p_id, 'stock', 'warning', 'work_order', p_id, p_warehouse_id);
  end if;

  update schedules set status = 'superseded' where work_order_id = p_id and status = 'active';
  insert into schedules (work_order_id, warehouse_id, scheduled_date, assigned_team, assigned_to, priority, reason,
                         shortage_accepted, shortage_details, created_by)
  values (p_id, p_warehouse_id, p_scheduled_date, p_assigned_team, p_assigned_to, coalesce(p_priority, w.priority), p_reason,
          v_short is not null, v_short, auth.uid());
  update work_orders set warehouse_id = p_warehouse_id, scheduled_date = p_scheduled_date, assigned_team = p_assigned_team,
    assigned_to = p_assigned_to, priority = coalesce(p_priority, priority), updated_at = now() where id = p_id;

  if v_is_reschedule then
    insert into work_order_status_history (work_order_id, from_status, to_status, reason, changed_by)
    values (p_id, w.status, w.status, 'Rescheduled to ' || p_scheduled_date || ': ' || p_reason, auth.uid());
    perform app_private.audit('reschedule', 'work_order', p_id::text,
      jsonb_build_object('scheduled_date', w.scheduled_date, 'warehouse_id', w.warehouse_id),
      jsonb_build_object('scheduled_date', p_scheduled_date, 'warehouse_id', p_warehouse_id), p_reason, jsonb_build_object('work_order_id', p_id));
  else
    perform app_private.set_wo_status(p_id, 'scheduled', 'Scheduled for ' || p_scheduled_date);
  end if;
  if p_assigned_to is not null then
    perform app_private.notify_user(p_assigned_to, 'Work order assigned: ' || w.wo_number,
      'Scheduled for ' || p_scheduled_date, '/work-orders/' || p_id, 'scheduling', 'info', 'work_order', p_id);
  end if;
  return jsonb_build_object('ok', true, 'shortages', v_short);
end $$;

-- Reserve specific devices automatically (oldest stock first) for the outstanding quantities.
create or replace function app_private.auto_reserve(p_wo uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  l public.work_order_lines;
  d record;
  v_need int;
  v_done int;
  v_result jsonb := '[]'::jsonb;
begin
  select * into w from work_orders where id = p_wo;
  for l in select * from work_order_lines where work_order_id = p_wo order by line_no loop
    v_need := coalesce(l.approved_qty, 0) - app_private.line_active_count(l.id);
    v_done := 0;
    if v_need > 0 then
      for d in
        select dv.id from devices dv
        where dv.warehouse_id = w.warehouse_id and dv.status = 'available' and dv.condition in ('new','good','fair')
          and (dv.model_id = l.model_id or (l.model_id is null and dv.category_id = l.category_id))
          and not exists (select 1 from serial_discrepancies s where s.scanned_device_id = dv.id and s.status = 'open')
        order by dv.received_at nulls last, dv.created_at
        limit v_need
        for update skip locked
      loop
        insert into work_order_devices (work_order_id, line_id, device_id, status, reserved_at, reserved_by)
        values (p_wo, l.id, d.id, 'reserved', now(), auth.uid());
        perform app_private.move_device(d.id, 'reserved', 'reserved',
          jsonb_build_object('work_order_id', p_wo, 'reference', w.wo_number, 'assign_work_order_id', p_wo));
        v_done := v_done + 1;
      end loop;
    end if;
    v_result := v_result || jsonb_build_object('line_no', l.line_no, 'needed', greatest(v_need, 0), 'reserved', v_done);
  end loop;
  return v_result;
end $$;

create or replace function public.release_for_issuing(p_id uuid, p_auto_reserve boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  v_res jsonb := '[]'::jsonb;
begin
  if not (public.has_permission('work_orders.schedule') or public.has_permission('issuing.pick')) then
    raise exception 'Permission denied: scheduling or issuing permission is required' using errcode = '42501';
  end if;
  select * into w from work_orders where id = p_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if w.status <> 'scheduled' then
    raise exception 'Only scheduled work orders can be released for issuing';
  end if;
  perform app_private.set_wo_status(p_id, 'scheduled_pending_issuing', 'Released to warehouse for issuing');
  if p_auto_reserve then
    v_res := app_private.auto_reserve(p_id);
  end if;
  perform app_private.notify_permission('issuing.pick', 'Ready for picking: ' || w.wo_number,
    'A work order has been released for issuing.', '/issuing/' || p_id, 'issuing', 'info', 'work_order', p_id, w.warehouse_id);
  return jsonb_build_object('ok', true, 'reservations', v_res);
end $$;

-- Reserve one specific device by serial for a work order.
create or replace function public.reserve_device(p_work_order_id uuid, p_serial text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  d public.devices;
  l public.work_order_lines;
  v_ids uuid[];
  v_problem text;
begin
  perform app_private.require_permission('inventory.reserve');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if w.status not in ('scheduled','scheduled_pending_issuing','issuing_in_progress') then
    raise exception 'Devices can be reserved only for scheduled work orders';
  end if;
  v_ids := app_private.find_scanned_device(p_serial, w.id);
  if v_ids is null then
    return app_private.scan_fail('reservation', 'unknown_serial', format('Serial %s is not registered', p_serial),
      jsonb_build_object('work_order_id', w.id, 'scanned_serial', p_serial));
  end if;
  if cardinality(v_ids) <> 1 then
    return app_private.scan_fail('reservation', 'ambiguous_serial', format('Serial %s matches more than one device', p_serial),
      jsonb_build_object('work_order_id', w.id, 'scanned_serial', p_serial));
  end if;
  -- Row lock serialises concurrent reservation attempts for the same device.
  select * into d from devices where id = v_ids[1] for update;
  v_problem := app_private.device_issue_problem(d, w.warehouse_id, 'available');
  if v_problem is not null then
    return app_private.scan_fail('reservation', 'ineligible', v_problem,
      jsonb_build_object('work_order_id', w.id, 'device_id', d.id, 'scanned_serial', p_serial));
  end if;
  select * into l from work_order_lines x where x.work_order_id = w.id and app_private.line_matches(x, d)
    and coalesce(x.approved_qty, 0) > app_private.line_active_count(x.id) order by x.line_no limit 1;
  if not found then
    return app_private.scan_fail('reservation', 'no_capacity', format('No approved line on %s has outstanding quantity for this %s', w.wo_number, d.manufacturer),
      jsonb_build_object('work_order_id', w.id, 'device_id', d.id, 'scanned_serial', p_serial));
  end if;
  insert into work_order_devices (work_order_id, line_id, device_id, status, reserved_at, reserved_by)
  values (w.id, l.id, d.id, 'reserved', now(), auth.uid());
  perform app_private.move_device(d.id, 'reserved', 'reserved',
    jsonb_build_object('work_order_id', w.id, 'reference', w.wo_number, 'assign_work_order_id', w.id));
  perform app_private.audit('reserve_device', 'device', d.id::text, null, jsonb_build_object('work_order', w.wo_number), null,
    jsonb_build_object('work_order_id', w.id, 'device_id', d.id));
  return jsonb_build_object('ok', true, 'message', format('%s reserved for %s', d.serial_number, w.wo_number),
    'device_id', d.id, 'progress', public.work_order_progress(w.id));
end $$;

create or replace function public.auto_reserve_devices(p_work_order_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('inventory.reserve');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if w.status not in ('scheduled','scheduled_pending_issuing','issuing_in_progress') then
    raise exception 'Devices can be reserved only for scheduled work orders';
  end if;
  return jsonb_build_object('ok', true, 'reservations', app_private.auto_reserve(p_work_order_id));
end $$;

-- Release a reservation, an un-issued pick, or reverse an issued (not yet invoiced or dispatched) device.
create or replace function public.release_allocation(p_allocation_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  a public.work_order_devices;
  w public.work_orders;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required'; end if;
  select * into a from work_order_devices where id = p_allocation_id for update;
  if not found then raise exception 'Allocation not found'; end if;
  select * into w from work_orders where id = a.work_order_id for update;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if a.status in ('reserved','picked') then
    if not (public.has_permission('issuing.pick') or public.has_permission('inventory.reserve')) then
      raise exception 'Permission denied: issuing or reservation permission is required' using errcode = '42501';
    end if;
  elsif a.status = 'issued' then
    perform app_private.require_permission('issuing.confirm');
    if exists (select 1 from invoice_device_links where work_order_device_id = a.id and status = 'active') then
      raise exception 'This device is on an invoice. Use a replacement or credit note instead.';
    end if;
  else
    raise exception 'Only reserved, picked or issued allocations can be released';
  end if;

  update work_order_devices set status = 'released', released_at = now(), released_by = auth.uid(), release_reason = p_reason
  where id = a.id;
  perform app_private.move_device(a.device_id, 'available', 'allocation_released',
    jsonb_build_object('work_order_id', w.id, 'reference', w.wo_number, 'reason', p_reason,
      'assign_work_order_id', null, 'assign_institution_id', null, 'assign_recipient_id', null));
  if a.status = 'issued' and w.status = 'issued' then
    perform app_private.set_wo_status(w.id, 'issuing_in_progress', 'Issued device released: ' || p_reason);
  end if;
  perform app_private.audit('release_allocation', 'work_order_device', a.id::text, to_jsonb(a), null, p_reason,
    jsonb_build_object('work_order_id', w.id, 'device_id', a.device_id));
end $$;

-- =====================================================================
-- Issuing with strict serial verification (anti-swap)
-- =====================================================================
create or replace function public.pick_device(p_work_order_id uuid, p_serial text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  d public.devices;
  a public.work_order_devices;
  l public.work_order_lines;
  v_ids uuid[];
  v_problem text;
  v_other text;
  v_expected text;
  v_expected_id uuid;
  v_refs jsonb;
begin
  perform app_private.require_permission('issuing.pick');
  if public.normalize_serial(p_serial) is null then
    raise exception 'Scan or enter the manufacturer serial number shown on the device';
  end if;
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if w.status not in ('scheduled_pending_issuing','issuing_in_progress','ready_for_dispatch','partially_dispatched','partially_delivered') then
    raise exception 'Work order % is "%" and is not open for issuing', w.wo_number, app_private.label(w.status);
  end if;
  if w.has_pending_amendment then
    raise exception 'Work order % has a pending amendment; issuing is blocked until it is decided', w.wo_number;
  end if;

  v_ids := app_private.find_scanned_device(p_serial, w.id);
  if v_ids is null then
    return app_private.record_discrepancy('issuing', 'unknown_serial',
      format('Serial %s is not registered. The device cannot be issued until its identity is verified.', p_serial),
      w.id, null, null, null, p_serial, null);
  end if;
  if cardinality(v_ids) <> 1 then
    return app_private.record_discrepancy('issuing', 'ambiguous_serial',
      format('Serial %s matches more than one registered device. Resolve the identity before issuing.', p_serial),
      w.id, null, null, null, p_serial, null);
  end if;

  select * into d from devices where id = v_ids[1] for update;
  v_refs := jsonb_build_object('work_order_id', w.id, 'device_id', d.id, 'scanned_serial', p_serial);

  if exists (select 1 from serial_discrepancies where scanned_device_id = d.id and status = 'open') then
    return app_private.scan_fail('issuing', 'blocked_by_discrepancy',
      format('Device %s (%s) has an open serial discrepancy and is blocked until it is resolved.', d.serial_number, d.asset_tag), v_refs);
  end if;

  select * into a from work_order_devices
  where device_id = d.id and work_order_id = w.id and status in ('reserved','picked','issued','dispatched');

  if found then
    if a.status <> 'reserved' then
      return app_private.scan_fail('issuing', 'already_picked',
        format('Device %s is already %s on this work order.', d.serial_number, lower(app_private.label(a.status))), v_refs);
    end if;
    v_problem := app_private.device_issue_problem(d, w.warehouse_id, 'reserved');
    if v_problem is not null then
      return app_private.scan_fail('issuing', 'ineligible', v_problem, v_refs);
    end if;
    update work_order_devices set status = 'picked', picked_at = now(), picked_by = auth.uid() where id = a.id;
    perform app_private.move_device(d.id, 'picked', 'picked',
      jsonb_build_object('work_order_id', w.id, 'reference', w.wo_number, 'verified', true));
  else
    select wo.wo_number into v_other from work_order_devices x join work_orders wo on wo.id = x.work_order_id
    where x.device_id = d.id and x.status in ('reserved','picked','issued','dispatched') limit 1;
    if v_other is not null then
      return app_private.record_discrepancy('issuing', 'allocated_elsewhere',
        format('Device %s is allocated to work order %s and cannot be issued on %s.', d.serial_number, v_other, w.wo_number),
        w.id, null, null, null, p_serial, d.id);
    end if;

    select * into l from work_order_lines x
    where x.work_order_id = w.id and app_private.line_matches(x, d)
      and coalesce(x.approved_qty, 0) > app_private.line_active_count(x.id)
    order by x.line_no limit 1;

    if not found then
      if not exists (select 1 from work_order_lines x where x.work_order_id = w.id and app_private.line_matches(x, d)) then
        return app_private.record_discrepancy('issuing', 'wrong_model',
          format('Device %s is a %s %s, which is not on work order %s.', d.serial_number, d.manufacturer,
                 (select model_name from device_models where id = d.model_id), w.wo_number),
          w.id, null, null, null, p_serial, d.id);
      end if;
      select string_agg(dv.serial_number, ', ' order by dv.serial_number), (array_agg(dv.id))[1]
        into v_expected, v_expected_id
      from work_order_devices x
      join devices dv on dv.id = x.device_id
      join work_order_lines xl on xl.id = x.line_id
      where x.work_order_id = w.id and x.status = 'reserved' and app_private.line_matches(xl, d);
      if v_expected is not null then
        return app_private.record_discrepancy('issuing', 'serial_mismatch',
          format('Serial mismatch: scanned %s but work order %s expects %s. The scanned device is blocked until the discrepancy is resolved.',
                 p_serial, w.wo_number, v_expected),
          w.id, null, v_expected_id, v_expected, p_serial, d.id);
      end if;
      return app_private.scan_fail('issuing', 'quantity_exceeded',
        format('All approved devices for this line on %s have already been allocated.', w.wo_number), v_refs);
    end if;

    v_problem := app_private.device_issue_problem(d, w.warehouse_id, 'available');
    if v_problem is not null then
      return app_private.scan_fail('issuing', 'ineligible', v_problem, v_refs);
    end if;
    insert into work_order_devices (work_order_id, line_id, device_id, status, reserved_at, reserved_by, picked_at, picked_by)
    values (w.id, l.id, d.id, 'picked', now(), auth.uid(), now(), auth.uid());
    perform app_private.move_device(d.id, 'picked', 'picked',
      jsonb_build_object('work_order_id', w.id, 'reference', w.wo_number, 'assign_work_order_id', w.id, 'verified', true));
  end if;

  if w.status = 'scheduled_pending_issuing' then
    perform app_private.set_wo_status(w.id, 'issuing_in_progress', 'Picking started');
  end if;
  perform app_private.audit('pick_device', 'device', d.id::text, null,
    jsonb_build_object('work_order', w.wo_number, 'serial', d.serial_number), null, v_refs);
  return jsonb_build_object('ok', true, 'message', format('%s (%s) picked for %s', d.serial_number, d.asset_tag, w.wo_number),
    'device_id', d.id, 'serial_number', d.serial_number, 'asset_tag', d.asset_tag,
    'progress', public.work_order_progress(w.id));
end $$;

-- Keep invoice coverage when a billed allocation is replaced by another device.
create or replace function app_private.carry_forward_invoice_link(p_old_allocation uuid, p_new_allocation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  k public.invoice_device_links;
  v_device uuid;
begin
  select * into k from invoice_device_links where work_order_device_id = p_old_allocation and status = 'active' for update;
  if not found then return; end if;
  select device_id into v_device from work_order_devices where id = p_new_allocation;
  update invoice_device_links set status = 'replaced', ended_at = now() where id = k.id;
  insert into invoice_device_links (invoice_id, invoice_line_id, work_order_device_id, device_id, status)
  values (k.invoice_id, k.invoice_line_id, p_new_allocation, v_device, 'active');
end $$;

create or replace function public.confirm_issuing(p_work_order_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  a record;
  d public.devices;
  v_count int := 0;
  v_prog jsonb;
  v_problem text;
  v_carry uuid;
begin
  perform app_private.require_permission('issuing.confirm');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if w.has_pending_amendment then raise exception 'Work order % has a pending amendment', w.wo_number; end if;
  if exists (select 1 from serial_discrepancies where work_order_id = w.id and status = 'open' and context = 'issuing') then
    raise exception 'Work order % has open serial discrepancies. They must be resolved before issuing can be confirmed.', w.wo_number;
  end if;
  if not exists (select 1 from work_order_devices where work_order_id = w.id and status = 'picked') then
    raise exception 'No picked devices to issue';
  end if;

  for a in select * from work_order_devices where work_order_id = w.id and status = 'picked' order by device_id loop
    select * into d from devices where id = a.device_id for update;
    v_problem := app_private.device_issue_problem(d, w.warehouse_id, 'picked');
    if v_problem is not null then
      raise exception 'Cannot issue: %', v_problem;
    end if;
    update work_order_devices set status = 'issued', issued_at = now(), issued_by = auth.uid() where id = a.id;
    perform app_private.move_device(d.id, 'issued', 'issued',
      jsonb_build_object('work_order_id', w.id, 'reference', w.wo_number,
        'assign_institution_id', w.institution_id, 'assign_recipient_id', w.recipient_id));
    -- If an earlier (billed) allocation on this line was returned, carry its invoice coverage forward.
    select x.id into v_carry from work_order_devices x
      join invoice_device_links k on k.work_order_device_id = x.id and k.status = 'active'
      where x.line_id = a.line_id and x.status = 'returned' limit 1;
    if v_carry is not null then
      perform app_private.carry_forward_invoice_link(v_carry, a.id);
    end if;
    v_count := v_count + 1;
  end loop;

  v_prog := public.work_order_progress(w.id);
  if w.status = 'issuing_in_progress' and (v_prog ->> 'issued')::int >= (v_prog ->> 'approved')::int then
    perform app_private.set_wo_status(w.id, 'issued', format('All %s approved devices issued', v_prog ->> 'approved'));
    if w.invoice_required then
      perform app_private.notify_permission('invoices.create', 'Ready for invoicing: ' || w.wo_number,
        'All approved devices have been issued.', '/invoicing', 'invoice', 'info', 'work_order', w.id);
    else
      perform app_private.notify_permission('dispatch.create', 'Ready for dispatch preparation: ' || w.wo_number,
        'All approved devices have been issued (invoice-exempt).', '/dispatch', 'dispatch', 'info', 'work_order', w.id, w.warehouse_id);
    end if;
  end if;
  perform app_private.audit('confirm_issuing', 'work_order', w.id::text, null,
    jsonb_build_object('issued_now', v_count, 'progress', v_prog), null, jsonb_build_object('work_order_id', w.id));
  return jsonb_build_object('ok', true, 'issued_now', v_count, 'progress', v_prog,
    'outstanding', (v_prog ->> 'approved')::int - (v_prog ->> 'issued')::int);
end $$;

-- Explicit replacement transaction: the original allocation is retained as
-- "replaced" and linked to the new allocation; both device histories remain.
create or replace function public.replace_allocated_device(
  p_allocation_id uuid, p_new_serial text, p_reason text, p_original_new_status text default 'faulty'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.work_order_devices;
  w public.work_order_lines;
  wo public.work_orders;
  od public.devices;
  nd public.devices;
  v_ids uuid[];
  v_problem text;
  v_new_id uuid;
  v_number text;
  v_new_status text;
begin
  perform app_private.require_permission('devices.replace');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A replacement reason is required'; end if;
  if p_original_new_status not in ('faulty','available','quarantined','lost','stolen') then
    raise exception 'Invalid status for the original device';
  end if;
  select * into a from work_order_devices where id = p_allocation_id for update;
  if not found then raise exception 'Allocation not found'; end if;
  if a.status not in ('reserved','picked','issued') then
    raise exception 'Only reserved, picked or issued allocations can be replaced in the warehouse. Use a return for dispatched devices.';
  end if;
  select * into wo from work_orders where id = a.work_order_id for update;
  perform app_private.require_warehouse_scope(wo.warehouse_id);
  select * into w from work_order_lines where id = a.line_id;
  select * into od from devices where id = a.device_id for update;

  v_ids := app_private.find_scanned_device(p_new_serial, wo.id);
  if v_ids is null or cardinality(v_ids) <> 1 then
    raise exception 'Replacement serial % does not identify exactly one registered device', p_new_serial;
  end if;
  select * into nd from devices where id = v_ids[1] for update;
  if nd.id = od.id then raise exception 'The replacement device must be a different physical device'; end if;
  if not app_private.line_matches(w, nd) then
    raise exception 'Replacement device % is not the model/category required by the work order line', nd.serial_number;
  end if;
  v_problem := app_private.device_issue_problem(nd, wo.warehouse_id, 'available');
  if v_problem is not null then raise exception 'Replacement not allowed: %', v_problem; end if;

  v_new_status := a.status;
  update work_order_devices set status = 'replaced', released_at = now(), released_by = auth.uid(), release_reason = p_reason
    where id = a.id;
  insert into work_order_devices (work_order_id, line_id, device_id, status, reserved_at, reserved_by, picked_at, picked_by, issued_at, issued_by)
  values (wo.id, a.line_id, nd.id, v_new_status, now(), auth.uid(),
          case when v_new_status in ('picked','issued') then now() end, case when v_new_status in ('picked','issued') then auth.uid() end,
          case when v_new_status = 'issued' then now() end, case when v_new_status = 'issued' then auth.uid() end)
  returning id into v_new_id;
  update work_order_devices set replaced_by_id = v_new_id where id = a.id;

  v_number := app_private.next_document_number('replacement');
  perform app_private.move_device(od.id, p_original_new_status, 'replaced_out',
    jsonb_build_object('work_order_id', wo.id, 'reference', v_number, 'reason', p_reason,
      'assign_work_order_id', null, 'assign_institution_id', null, 'assign_recipient_id', null,
      'condition', case when p_original_new_status = 'faulty' then 'faulty' else null end));
  -- the replacement passes through the same states as the allocation it replaces
  perform app_private.move_device(nd.id, 'reserved', 'replaced_in',
    jsonb_build_object('work_order_id', wo.id, 'reference', v_number, 'reason', p_reason, 'assign_work_order_id', wo.id, 'verified', true));
  if v_new_status in ('picked','issued') then
    perform app_private.move_device(nd.id, 'picked', 'picked', jsonb_build_object('work_order_id', wo.id, 'reference', v_number));
  end if;
  if v_new_status = 'issued' then
    perform app_private.move_device(nd.id, 'issued', 'issued', jsonb_build_object('work_order_id', wo.id, 'reference', v_number,
      'assign_institution_id', wo.institution_id, 'assign_recipient_id', wo.recipient_id));
  end if;
  perform app_private.carry_forward_invoice_link(a.id, v_new_id);

  insert into replacement_transactions (replacement_number, work_order_id, original_device_id, replacement_device_id,
    original_allocation_id, new_allocation_id, original_device_new_status, reason, authorised_by)
  values (v_number, wo.id, od.id, nd.id, a.id, v_new_id, p_original_new_status, p_reason, auth.uid());

  if p_original_new_status = 'faulty' then
    insert into device_assessments (assessment_number, device_id, work_order_id, origin, reported_fault, reported_by)
    values (app_private.next_document_number('assessment'), od.id, wo.id, 'Replacement ' || v_number, p_reason, auth.uid());
  end if;

  perform app_private.audit('replace_device', 'replacement', v_number, jsonb_build_object('serial', od.serial_number),
    jsonb_build_object('serial', nd.serial_number), p_reason, jsonb_build_object('work_order_id', wo.id, 'device_id', od.id));
  return jsonb_build_object('ok', true, 'replacement_number', v_number, 'original_serial', od.serial_number,
    'replacement_serial', nd.serial_number);
end $$;

-- =====================================================================
-- Discrepancy resolution, exemptions, readiness, completion, amendments
-- =====================================================================
create or replace function public.resolve_discrepancy(p_id uuid, p_resolution text, p_dismiss boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare s public.serial_discrepancies;
begin
  perform app_private.require_permission('devices.resolve_discrepancy');
  if length(trim(coalesce(p_resolution, ''))) < 10 then
    raise exception 'Describe the resolution (at least 10 characters)';
  end if;
  select * into s from serial_discrepancies where id = p_id for update;
  if not found then raise exception 'Discrepancy not found'; end if;
  if s.status <> 'open' then raise exception 'Discrepancy % is already %', s.discrepancy_number, s.status; end if;
  if s.reported_by = auth.uid() and not public.has_permission('users.manage') then
    raise exception 'Segregation of duties: another authorised user must resolve a discrepancy you reported' using errcode = '42501';
  end if;
  update serial_discrepancies set status = case when p_dismiss then 'dismissed' else 'resolved' end,
    resolution = p_resolution, resolved_by = auth.uid(), resolved_at = now() where id = p_id;
  perform app_private.audit('resolve_discrepancy', 'serial_discrepancy', p_id::text, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', case when p_dismiss then 'dismissed' else 'resolved' end), p_resolution,
    jsonb_build_object('work_order_id', s.work_order_id, 'dispatch_id', s.dispatch_id, 'device_id', s.scanned_device_id));
end $$;

create or replace function public.set_invoice_exemption(p_work_order_id uuid, p_exempt boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('invoices.exempt');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason is required'; end if;
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.status in ('invoiced','ready_for_dispatch','partially_dispatched','dispatched','partially_delivered','delivered','completed','cancelled') then
    raise exception 'The invoicing requirement can no longer be changed for a work order that is "%"', app_private.label(w.status);
  end if;
  if p_exempt and exists (select 1 from invoices where work_order_id = w.id and status not in ('cancelled')) then
    raise exception 'Cancel or credit existing invoices before exempting this work order';
  end if;
  update work_orders set invoice_required = not p_exempt,
    invoice_exempt_reason = case when p_exempt then p_reason else null end where id = w.id;
  if p_exempt and w.status = 'pending_invoicing' then
    perform app_private.set_wo_status(w.id, 'issued', 'Invoice exemption: ' || p_reason);
  end if;
  perform app_private.audit('invoice_exemption', 'work_order', w.id::text,
    jsonb_build_object('invoice_required', w.invoice_required), jsonb_build_object('invoice_required', not p_exempt), p_reason,
    jsonb_build_object('work_order_id', w.id));
end $$;

create or replace function public.mark_ready_for_dispatch(p_work_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('dispatch.create');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.has_pending_amendment then raise exception 'Work order % has a pending amendment', w.wo_number; end if;
  if w.invoice_required then
    if w.status = 'pending_invoicing' and app_private.setting_bool('invoice.allow_partial', false)
       and exists (select 1 from invoices where work_order_id = w.id and status in ('issued','partially_paid','paid')) then
      null;
    elsif w.status <> 'invoiced' then
      raise exception 'Work order % must be invoiced before it can be released for dispatch (current: %)', w.wo_number, app_private.label(w.status);
    end if;
  elsif w.status <> 'issued' then
    raise exception 'Work order % must be fully issued before dispatch (current: %)', w.wo_number, app_private.label(w.status);
  end if;
  perform app_private.set_wo_status(w.id, 'ready_for_dispatch', 'Packed and ready for dispatch');
  perform app_private.notify_permission('dispatch.confirm', 'Dispatch ready: ' || w.wo_number,
    'A work order is ready for dispatch.', '/dispatch', 'dispatch', 'info', 'work_order', w.id, w.warehouse_id);
end $$;

create or replace function public.complete_work_order(p_work_order_id uuid, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('work_orders.complete');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.status <> 'delivered' then
    raise exception 'Only fully delivered work orders can be completed (current: %)', app_private.label(w.status);
  end if;
  if w.invoice_required and exists (
      select 1 from work_order_devices x where x.work_order_id = w.id and x.status = 'delivered'
        and not exists (select 1 from invoice_device_links k join invoices i on i.id = k.invoice_id
                        where k.work_order_device_id = x.id and k.status = 'active' and i.status in ('issued','partially_paid','paid'))) then
    raise exception 'All delivered devices must be on an issued invoice before work order % can be completed', w.wo_number;
  end if;
  perform app_private.set_wo_status(w.id, 'completed', coalesce(p_notes, 'Completed'));
  perform app_private.notify_user(w.created_by, 'Work order completed: ' || w.wo_number, null,
    '/work-orders/' || w.id, 'work_order', 'success', 'work_order', w.id);
end $$;

create or replace function public.request_amendment(p_work_order_id uuid, p_changes jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  v_id uuid;
  e jsonb;
  l public.work_order_lines;
  v_qty int;
begin
  perform app_private.require_permission('work_orders.amend');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'An amendment reason is required'; end if;
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if w.status not in ('approved','pending_scheduling','scheduled','scheduled_pending_issuing','issuing_in_progress','issued') then
    raise exception 'Work order % is "%". Amendments are possible from approval until issuing; afterwards use credit notes and returns.',
      w.wo_number, app_private.label(w.status);
  end if;
  if w.has_pending_amendment then raise exception 'Work order % already has a pending amendment', w.wo_number; end if;

  for e in select * from jsonb_array_elements(coalesce(p_changes -> 'lines', '[]'::jsonb)) loop
    select * into l from work_order_lines where id = (e ->> 'line_id')::uuid and work_order_id = w.id;
    if not found then raise exception 'Amendment refers to an unknown line'; end if;
    v_qty := (e ->> 'approved_qty')::int;
    if v_qty is null or v_qty < 0 then raise exception 'Line %: invalid quantity', l.line_no; end if;
    if v_qty < app_private.line_active_count(l.id) then
      raise exception 'Line %: % device(s) are already allocated. Release allocations before reducing below that number.',
        l.line_no, app_private.line_active_count(l.id);
    end if;
  end loop;
  if p_changes ? 'recipient_id' and nullif(p_changes ->> 'recipient_id', '') is not null and not exists
     (select 1 from recipients where id = (p_changes ->> 'recipient_id')::uuid and institution_id = w.institution_id) then
    raise exception 'The recipient does not belong to this institution';
  end if;

  insert into work_order_amendments (work_order_id, reason, changes, previous_values, requested_by)
  values (w.id, p_reason, p_changes,
    jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('line_id', id, 'approved_qty', approved_qty)) from work_order_lines where work_order_id = w.id),
                       'recipient_id', w.recipient_id, 'recipient_group', w.recipient_group, 'instructions', w.instructions, 'priority', w.priority),
    auth.uid())
  returning id into v_id;
  update work_orders set has_pending_amendment = true where id = w.id;
  insert into work_order_approvals (work_order_id, action, comments, decided_by, snapshot)
  values (w.id, 'amendment_requested', p_reason, auth.uid(), p_changes);
  perform app_private.audit('amendment_requested', 'work_order', w.id::text, null, p_changes, p_reason, jsonb_build_object('work_order_id', w.id));

  if not app_private.setting_bool('workflow.amendment_requires_approval', true) then
    perform app_private.apply_amendment(v_id);
  else
    perform app_private.notify_permission('work_orders.approve', 'Amendment approval required: ' || w.wo_number, p_reason,
      '/approvals', 'approval', 'warning', 'work_order', w.id, null, auth.uid());
  end if;
  return v_id;
end $$;

create or replace function app_private.apply_amendment(p_amendment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.work_order_amendments;
  w public.work_orders;
  e jsonb;
  v_prog jsonb;
begin
  select * into m from work_order_amendments where id = p_amendment for update;
  select * into w from work_orders where id = m.work_order_id for update;
  for e in select * from jsonb_array_elements(coalesce(m.changes -> 'lines', '[]'::jsonb)) loop
    if (e ->> 'approved_qty')::int < app_private.line_active_count((e ->> 'line_id')::uuid) then
      raise exception 'Allocations changed since the amendment was requested; the new quantity is below the allocated quantity';
    end if;
    update work_order_lines set approved_qty = (e ->> 'approved_qty')::int where id = (e ->> 'line_id')::uuid;
  end loop;
  update work_orders set
    recipient_id = case when m.changes ? 'recipient_id' then nullif(m.changes ->> 'recipient_id', '')::uuid else recipient_id end,
    recipient_group = case when m.changes ? 'recipient_group' then nullif(m.changes ->> 'recipient_group', '') else recipient_group end,
    instructions = case when m.changes ? 'instructions' then nullif(m.changes ->> 'instructions', '') else instructions end,
    priority = case when m.changes ? 'priority' then m.changes ->> 'priority' else priority end,
    has_pending_amendment = false, amendment_count = amendment_count + 1, updated_at = now(), version = version + 1
  where id = w.id;
  update work_order_amendments set status = 'applied' where id = m.id;

  v_prog := public.work_order_progress(w.id);
  if w.status = 'issued' and (v_prog ->> 'issued')::int < (v_prog ->> 'approved')::int then
    perform app_private.set_wo_status(w.id, 'issuing_in_progress', 'Amendment increased the approved quantity');
  elsif w.status = 'issuing_in_progress' and (v_prog ->> 'issued')::int >= (v_prog ->> 'approved')::int
        and (v_prog ->> 'picked')::int = 0 and (v_prog ->> 'approved')::int > 0 then
    perform app_private.set_wo_status(w.id, 'issued', 'Amendment reduced the approved quantity to the issued quantity');
  end if;
  perform app_private.audit('amendment_applied', 'work_order', w.id::text, m.previous_values, m.changes, m.reason,
    jsonb_build_object('work_order_id', w.id));
end $$;

create or replace function public.decide_amendment(p_amendment_id uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.work_order_amendments;
begin
  perform app_private.require_permission('work_orders.approve');
  select * into m from work_order_amendments where id = p_amendment_id for update;
  if not found then raise exception 'Amendment not found'; end if;
  if m.status <> 'pending' then raise exception 'This amendment has already been decided'; end if;
  if app_private.setting_bool('workflow.sod_creator_cannot_approve', true) and m.requested_by = auth.uid() then
    raise exception 'Segregation of duties: you cannot approve your own amendment' using errcode = '42501';
  end if;
  if not p_approve and length(trim(coalesce(p_comment, ''))) < 5 then
    raise exception 'A reason is required to reject an amendment';
  end if;
  update work_order_amendments set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_comment = p_comment where id = m.id;
  insert into work_order_approvals (work_order_id, action, comments, decided_by, snapshot)
  values (m.work_order_id, case when p_approve then 'amendment_approved' else 'amendment_rejected' end, p_comment, auth.uid(), m.changes);
  if p_approve then
    perform app_private.apply_amendment(m.id);
  else
    update work_orders set has_pending_amendment = false where id = m.work_order_id;
    perform app_private.audit('amendment_rejected', 'work_order', m.work_order_id::text, null, m.changes, p_comment,
      jsonb_build_object('work_order_id', m.work_order_id));
  end if;
  perform app_private.notify_user(m.requested_by, 'Amendment ' || case when p_approve then 'approved' else 'rejected' end,
    p_comment, '/work-orders/' || m.work_order_id, 'approval', case when p_approve then 'success' else 'warning' end,
    'work_order', m.work_order_id);
end $$;

create or replace function public.update_work_order_notes(p_work_order_id uuid, p_notes text) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders;
begin
  perform app_private.require_permission('work_orders.view');
  if not (public.has_permission('work_orders.create') or public.has_permission('work_orders.schedule') or public.has_permission('issuing.pick')) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  update work_orders set internal_notes = p_notes, updated_at = now() where id = w.id;
  perform app_private.audit('update_notes', 'work_order', w.id::text, jsonb_build_object('internal_notes', w.internal_notes),
    jsonb_build_object('internal_notes', p_notes), null, jsonb_build_object('work_order_id', w.id));
end $$;
