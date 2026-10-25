-- =====================================================================
-- Dispatch manifests with serial verification, delivery confirmation,
-- and secure expiring recipient confirmation links.
-- =====================================================================

create or replace function public.create_dispatch(p_work_order_id uuid, p jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  inst public.institutions;
  v_id uuid;
begin
  perform app_private.require_permission('dispatch.create');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if w.status not in ('ready_for_dispatch','partially_dispatched','partially_delivered') then
    raise exception 'Work order % is "%" and is not released for dispatch', w.wo_number, app_private.label(w.status);
  end if;
  if w.has_pending_amendment then raise exception 'Work order % has a pending amendment', w.wo_number; end if;
  if not exists (select 1 from work_order_devices x where x.work_order_id = w.id and x.status = 'issued'
                 and not exists (select 1 from dispatch_devices dd where dd.work_order_device_id = x.id and dd.status = 'loaded')) then
    raise exception 'Work order % has no issued devices waiting for dispatch', w.wo_number;
  end if;
  select * into inst from institutions where id = w.institution_id;
  insert into dispatches (dispatch_number, work_order_id, origin_warehouse_id, institution_id, recipient_name, delivery_address,
    courier_name, tracking_number, vehicle_registration, driver_name, parcel_count, shipment_notes, dispatch_date,
    expected_delivery_date, created_by)
  values (app_private.next_document_number('dispatch'), w.id, w.warehouse_id, w.institution_id,
    coalesce(nullif(p ->> 'recipient_name', ''), (select full_name from recipients where id = w.recipient_id), inst.principal_name),
    coalesce(nullif(p ->> 'delivery_address', ''), inst.delivery_address, concat_ws(', ', inst.address_line1, inst.address_line2, inst.town, inst.postal_code)),
    nullif(p ->> 'courier_name', ''), nullif(p ->> 'tracking_number', ''), nullif(p ->> 'vehicle_registration', ''),
    nullif(p ->> 'driver_name', ''), nullif(p ->> 'parcel_count', '')::int, nullif(p ->> 'shipment_notes', ''),
    coalesce(nullif(p ->> 'dispatch_date', '')::date, (now() at time zone 'Africa/Johannesburg')::date),
    nullif(p ->> 'expected_delivery_date', '')::date, auth.uid())
  returning id into v_id;
  perform app_private.audit('create_dispatch', 'dispatch', v_id::text, null, p, null, jsonb_build_object('dispatch_id', v_id, 'work_order_id', w.id));
  return v_id;
end $$;

create or replace function public.update_dispatch_details(p_dispatch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare dp public.dispatches;
begin
  perform app_private.require_permission('dispatch.create');
  select * into dp from dispatches where id = p_dispatch_id for update;
  if not found then raise exception 'Dispatch not found'; end if;
  if dp.status <> 'draft' then raise exception 'Only draft dispatches can be edited'; end if;
  if p ? 'parcel_count' and nullif(p ->> 'parcel_count', '') is not null and (p ->> 'parcel_count')::int < 1 then
    raise exception 'Parcel count must be at least 1';
  end if;
  update dispatches set
    recipient_name = case when p ? 'recipient_name' then nullif(p ->> 'recipient_name', '') else recipient_name end,
    delivery_address = case when p ? 'delivery_address' then nullif(p ->> 'delivery_address', '') else delivery_address end,
    courier_name = case when p ? 'courier_name' then nullif(p ->> 'courier_name', '') else courier_name end,
    tracking_number = case when p ? 'tracking_number' then nullif(p ->> 'tracking_number', '') else tracking_number end,
    vehicle_registration = case when p ? 'vehicle_registration' then nullif(p ->> 'vehicle_registration', '') else vehicle_registration end,
    driver_name = case when p ? 'driver_name' then nullif(p ->> 'driver_name', '') else driver_name end,
    parcel_count = case when p ? 'parcel_count' then nullif(p ->> 'parcel_count', '')::int else parcel_count end,
    shipment_notes = case when p ? 'shipment_notes' then nullif(p ->> 'shipment_notes', '') else shipment_notes end,
    dispatch_date = case when p ? 'dispatch_date' then nullif(p ->> 'dispatch_date', '')::date else dispatch_date end,
    expected_delivery_date = case when p ? 'expected_delivery_date' then nullif(p ->> 'expected_delivery_date', '')::date else expected_delivery_date end,
    updated_at = now()
  where id = dp.id;
  perform app_private.audit('update_dispatch', 'dispatch', dp.id::text, to_jsonb(dp), p, null, jsonb_build_object('dispatch_id', dp.id));
end $$;

-- Scan the physical serial onto the manifest. Mismatches are recorded and blocked.
create or replace function public.dispatch_scan_device(p_dispatch_id uuid, p_serial text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dp public.dispatches;
  w public.work_orders;
  d public.devices;
  a public.work_order_devices;
  v_ids uuid[];
  v_other text;
  v_refs jsonb;
begin
  perform app_private.require_permission('dispatch.create');
  if public.normalize_serial(p_serial) is null then raise exception 'Scan or enter the serial number on the device'; end if;
  select * into dp from dispatches where id = p_dispatch_id for update;
  if not found then raise exception 'Dispatch not found'; end if;
  if dp.status <> 'draft' then raise exception 'Dispatch % is already %', dp.dispatch_number, dp.status; end if;
  select * into w from work_orders where id = dp.work_order_id;
  perform app_private.require_warehouse_scope(dp.origin_warehouse_id);

  v_ids := app_private.find_scanned_device(p_serial, w.id);
  if v_ids is null then
    return app_private.record_discrepancy('dispatch', 'unknown_serial',
      format('Serial %s is not registered. It cannot be dispatched.', p_serial), w.id, dp.id, null, null, p_serial, null);
  end if;
  if cardinality(v_ids) <> 1 then
    return app_private.record_discrepancy('dispatch', 'ambiguous_serial',
      format('Serial %s matches more than one registered device.', p_serial), w.id, dp.id, null, null, p_serial, null);
  end if;
  select * into d from devices where id = v_ids[1] for update;
  v_refs := jsonb_build_object('work_order_id', w.id, 'dispatch_id', dp.id, 'device_id', d.id, 'scanned_serial', p_serial);

  if exists (select 1 from serial_discrepancies where scanned_device_id = d.id and status = 'open') then
    return app_private.scan_fail('dispatch', 'blocked_by_discrepancy',
      format('Device %s has an open serial discrepancy and is blocked.', d.serial_number), v_refs);
  end if;

  select * into a from work_order_devices where device_id = d.id and work_order_id = w.id
    and status in ('reserved','picked','issued','dispatched','delivered') for update;
  if not found then
    select wo.wo_number into v_other from work_order_devices x join work_orders wo on wo.id = x.work_order_id
      where x.device_id = d.id and x.status in ('reserved','picked','issued','dispatched') limit 1;
    return app_private.record_discrepancy('dispatch',
      case when v_other is null then 'not_allocated' else 'allocated_elsewhere' end,
      case when v_other is null
        then format('Serial mismatch: device %s is not allocated to work order %s and must not be dispatched.', p_serial, w.wo_number)
        else format('Serial mismatch: device %s belongs to work order %s, not %s.', p_serial, v_other, w.wo_number) end,
      w.id, dp.id, null, null, p_serial, d.id);
  end if;
  if a.status in ('dispatched','delivered') then
    return app_private.scan_fail('dispatch', 'already_dispatched', format('Device %s has already been dispatched.', p_serial), v_refs);
  end if;
  if a.status <> 'issued' then
    return app_private.scan_fail('dispatch', 'not_issued',
      format('Device %s is only %s on %s. Confirm issuing first.', p_serial, lower(app_private.label(a.status)), w.wo_number), v_refs);
  end if;
  if d.status <> 'issued' or d.condition in ('faulty','damaged','beyond_repair') then
    return app_private.scan_fail('dispatch', 'ineligible',
      format('Device %s is "%s" (condition %s) and is not eligible for dispatch.', p_serial, app_private.label(d.status), d.condition), v_refs);
  end if;
  if d.warehouse_id <> dp.origin_warehouse_id then
    return app_private.scan_fail('dispatch', 'wrong_warehouse', format('Device %s is not held in the dispatch origin warehouse.', p_serial), v_refs);
  end if;
  if w.invoice_required and not exists (
      select 1 from invoice_device_links k join invoices i on i.id = k.invoice_id
      where k.work_order_device_id = a.id and k.status = 'active' and i.status in ('issued','partially_paid','paid')) then
    return app_private.scan_fail('dispatch', 'not_invoiced', format('Device %s is not on an issued invoice.', p_serial), v_refs);
  end if;
  if exists (select 1 from dispatch_devices where dispatch_id = dp.id and device_id = d.id and status = 'loaded') then
    return app_private.scan_fail('dispatch', 'duplicate_scan', format('Device %s is already on this manifest.', p_serial), v_refs);
  end if;

  begin
    insert into dispatch_devices (dispatch_id, device_id, work_order_device_id, scanned_serial, scanned_by)
    values (dp.id, d.id, a.id, p_serial, auth.uid());
  exception when unique_violation then
    return app_private.scan_fail('dispatch', 'on_other_manifest',
      format('Device %s is already loaded on another dispatch manifest.', p_serial), v_refs);
  end;
  perform app_private.audit('dispatch_scan', 'dispatch', dp.id::text, null, jsonb_build_object('serial', d.serial_number), null, v_refs);
  return jsonb_build_object('ok', true, 'message', format('%s verified and added to %s', d.serial_number, dp.dispatch_number),
    'device_id', d.id, 'loaded', (select count(*) from dispatch_devices where dispatch_id = dp.id and status = 'loaded'));
end $$;

create or replace function public.remove_dispatch_device(p_dispatch_device_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare dd public.dispatch_devices; dp public.dispatches;
begin
  perform app_private.require_permission('dispatch.create');
  select * into dd from dispatch_devices where id = p_dispatch_device_id for update;
  if not found then raise exception 'Manifest line not found'; end if;
  select * into dp from dispatches where id = dd.dispatch_id for update;
  if dp.status <> 'draft' or dd.status <> 'loaded' then raise exception 'Only devices on a draft manifest can be removed'; end if;
  update dispatch_devices set status = 'removed' where id = dd.id;
  perform app_private.audit('dispatch_remove_device', 'dispatch', dp.id::text, null, null, p_reason,
    jsonb_build_object('dispatch_id', dp.id, 'device_id', dd.device_id));
end $$;

create or replace function public.cancel_dispatch(p_dispatch_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare dp public.dispatches;
begin
  perform app_private.require_permission('dispatch.create');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason is required'; end if;
  select * into dp from dispatches where id = p_dispatch_id for update;
  if not found then raise exception 'Dispatch not found'; end if;
  if dp.status <> 'draft' then raise exception 'Confirmed dispatches cannot be cancelled. Record the delivery outcome or a return.'; end if;
  update dispatch_devices set status = 'removed' where dispatch_id = dp.id and status = 'loaded';
  update dispatches set status = 'cancelled', cancelled_reason = p_reason, updated_at = now() where id = dp.id;
  perform app_private.audit('cancel_dispatch', 'dispatch', dp.id::text, null, null, p_reason, jsonb_build_object('dispatch_id', dp.id, 'work_order_id', dp.work_order_id));
end $$;

-- Handover to courier. Only devices on this manifest change to dispatched.
create or replace function public.confirm_dispatch(p_dispatch_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dp public.dispatches;
  w public.work_orders;
  r record;
  d public.devices;
  a public.work_order_devices;
  v_count int := 0;
begin
  perform app_private.require_permission('dispatch.confirm');
  select * into dp from dispatches where id = p_dispatch_id for update;
  if not found then raise exception 'Dispatch not found'; end if;
  perform app_private.require_warehouse_scope(dp.origin_warehouse_id);
  if dp.status <> 'draft' then raise exception 'Dispatch % is already %', dp.dispatch_number, dp.status; end if;
  if coalesce(dp.courier_name, dp.vehicle_registration) is null then
    raise exception 'Record the courier or vehicle before confirming the handover';
  end if;
  if dp.parcel_count is null then raise exception 'Record the number of parcels'; end if;
  if exists (select 1 from serial_discrepancies where (dispatch_id = dp.id or (work_order_id = dp.work_order_id and context = 'dispatch')) and status = 'open') then
    raise exception 'Open serial discrepancies must be resolved before dispatch % can be confirmed', dp.dispatch_number;
  end if;
  select * into w from work_orders where id = dp.work_order_id for update;
  if w.status not in ('ready_for_dispatch','partially_dispatched','partially_delivered') then
    raise exception 'Work order % is "%" and cannot be dispatched', w.wo_number, app_private.label(w.status);
  end if;
  if not exists (select 1 from dispatch_devices where dispatch_id = dp.id and status = 'loaded') then
    raise exception 'The manifest is empty. Scan the devices being dispatched.';
  end if;

  -- lock in a deterministic order to avoid deadlocks between concurrent dispatchers
  for r in select dd.* from dispatch_devices dd where dd.dispatch_id = dp.id and dd.status = 'loaded' order by dd.device_id loop
    select * into d from devices where id = r.device_id for update;
    select * into a from work_order_devices where id = r.work_order_device_id for update;
    if d.status <> 'issued' or a.status <> 'issued' then
      raise exception 'Device % is no longer eligible (device "%", allocation "%"). Remove it from the manifest.',
        d.serial_number, app_private.label(d.status), app_private.label(a.status);
    end if;
    if w.invoice_required and not exists (
        select 1 from invoice_device_links k join invoices i on i.id = k.invoice_id
        where k.work_order_device_id = a.id and k.status = 'active' and i.status in ('issued','partially_paid','paid')) then
      raise exception 'Device % is no longer covered by an issued invoice', d.serial_number;
    end if;
    update work_order_devices set status = 'dispatched', dispatched_at = now() where id = a.id;
    update dispatch_devices set status = 'dispatched' where id = r.id;
    perform app_private.move_device(d.id, 'dispatched', 'dispatched',
      jsonb_build_object('work_order_id', w.id, 'dispatch_id', dp.id, 'reference', dp.dispatch_number, 'to_location_id', null,
        'institution_id', dp.institution_id));
    v_count := v_count + 1;
  end loop;

  update dispatches set status = 'dispatched', dispatched_at = now(), dispatched_by = auth.uid(), updated_at = now() where id = dp.id;
  perform app_private.recompute_fulfilment(w.id);
  perform app_private.audit('confirm_dispatch', 'dispatch', dp.id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'dispatched', 'devices', v_count), null, jsonb_build_object('dispatch_id', dp.id, 'work_order_id', w.id));
  perform app_private.notify_permission('delivery.confirm', 'Shipment dispatched: ' || dp.dispatch_number,
    format('%s device(s) for %s are in transit.', v_count, w.wo_number), '/delivery', 'dispatch', 'info', 'dispatch', dp.id);
  return jsonb_build_object('ok', true, 'dispatched', v_count, 'progress', public.work_order_progress(w.id));
end $$;

-- Shared delivery recording (used by staff and by recipient links).
create or replace function app_private.apply_delivery(p_dispatch uuid, p jsonb, p_recorded_by uuid, p_via_link boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dp public.dispatches;
  w public.work_orders;
  r record;
  v_result text;
  v_results jsonb := coalesce(p -> 'devices', '[]'::jsonb);
  v_failed boolean := coalesce(p ->> 'outcome', '') in ('failed','returned_to_sender');
  v_expected int;
  v_received int := 0;
  v_damaged int := 0;
  v_missing int := 0;
  v_rejected int := 0;
  v_outcome text;
  v_id uuid;
  v_number text;
  v_delivered_at timestamptz := coalesce(nullif(p ->> 'delivered_at', '')::timestamptz, now());
begin
  select * into dp from dispatches where id = p_dispatch for update;
  if not found then raise exception 'Dispatch not found'; end if;
  if dp.status <> 'dispatched' then raise exception 'Dispatch % is "%" and cannot be confirmed', dp.dispatch_number, app_private.label(dp.status); end if;
  if exists (select 1 from delivery_confirmations where dispatch_id = dp.id) then
    raise exception 'Delivery for % has already been recorded', dp.dispatch_number;
  end if;
  if not v_failed and length(trim(coalesce(p ->> 'received_by_name', ''))) < 2 then
    raise exception 'Record the name of the person who received the delivery';
  end if;
  if v_failed and length(trim(coalesce(p ->> 'failure_reason', ''))) < 5 then
    raise exception 'Record why the delivery failed';
  end if;
  if v_delivered_at > now() + interval '10 minutes' then raise exception 'The delivery time cannot be in the future'; end if;
  select * into w from work_orders where id = dp.work_order_id for update;
  select count(*) into v_expected from dispatch_devices where dispatch_id = dp.id and status = 'dispatched';

  v_number := app_private.next_document_number('delivery');
  insert into delivery_confirmations (delivery_number, dispatch_id, work_order_id, institution_id, outcome, received_by_name, received_by_role,
    delivered_at, quantity_expected, quantity_received, comments, failure_reason, signature_data, via_recipient_link, recorded_by)
  values (v_number, dp.id, w.id, dp.institution_id, 'delivered', nullif(p ->> 'received_by_name', ''), nullif(p ->> 'received_by_role', ''),
    v_delivered_at, v_expected, 0, nullif(p ->> 'comments', ''), nullif(p ->> 'failure_reason', ''),
    nullif(p ->> 'signature_data', ''), p_via_link, p_recorded_by)
  returning id into v_id;

  for r in select dd.*, dv.serial_number from dispatch_devices dd join devices dv on dv.id = dd.device_id
           where dd.dispatch_id = dp.id and dd.status = 'dispatched' order by dd.device_id loop
    if v_failed then
      v_result := 'not_delivered';
    else
      select e ->> 'result' into v_result from jsonb_array_elements(v_results) e
      where e ->> 'dispatch_device_id' = r.id::text or public.normalize_serial(e ->> 'serial_number') = public.normalize_serial(r.serial_number)
      limit 1;
      if v_result is null then
        raise exception 'Record the outcome for every device on the manifest (missing: %)', r.serial_number;
      end if;
      if v_result not in ('received','damaged','missing','rejected') then raise exception 'Invalid device outcome %', v_result; end if;
    end if;

    insert into delivery_devices (delivery_confirmation_id, dispatch_device_id, device_id, result, serial_confirmed)
    values (v_id, r.id, r.device_id, v_result, case when v_result = 'received' then r.serial_number end);

    if v_result = 'received' then
      v_received := v_received + 1;
      update dispatch_devices set status = 'delivered' where id = r.id;
      update work_order_devices set status = 'delivered', delivered_at = v_delivered_at where id = r.work_order_device_id;
      perform app_private.move_device(r.device_id, 'delivered', 'delivered',
        jsonb_build_object('work_order_id', w.id, 'dispatch_id', dp.id, 'reference', v_number,
          'assign_institution_id', dp.institution_id, 'assign_recipient_id', w.recipient_id));
    elsif v_result = 'damaged' then
      v_damaged := v_damaged + 1;
      update dispatch_devices set status = 'damaged' where id = r.id;
      perform app_private.move_device(r.device_id, 'faulty', 'damaged_on_arrival',
        jsonb_build_object('work_order_id', w.id, 'dispatch_id', dp.id, 'reference', v_number, 'condition', 'damaged',
          'reason', 'Damaged on arrival'));
    elsif v_result = 'missing' then
      v_missing := v_missing + 1;
      update dispatch_devices set status = 'missing' where id = r.id;
      insert into serial_discrepancies (discrepancy_number, context, reason_code, message, work_order_id, dispatch_id,
                                        expected_device_id, expected_serial, reported_by)
      values (app_private.next_document_number('discrepancy'), 'delivery', 'missing_on_delivery',
        format('Device %s was on manifest %s but was not received', r.serial_number, dp.dispatch_number),
        w.id, dp.id, r.device_id, r.serial_number, p_recorded_by);
    elsif v_result = 'rejected' then
      v_rejected := v_rejected + 1;
      update dispatch_devices set status = 'rejected' where id = r.id;
    else
      update dispatch_devices set status = 'not_delivered' where id = r.id;
    end if;
  end loop;

  v_outcome := case
    when v_failed then p ->> 'outcome'
    when v_received = v_expected then 'delivered'
    when v_received > 0 then 'partially_delivered'
    when v_rejected = v_expected then 'rejected'
    when v_damaged > 0 and v_missing = 0 then 'damaged'
    when v_missing > 0 then 'missing'
    else 'failed' end;
  update delivery_confirmations set outcome = v_outcome, quantity_received = v_received, quantity_damaged = v_damaged,
    quantity_missing = v_missing, quantity_rejected = v_rejected where id = v_id;
  update dispatches set status = case when v_received = v_expected then 'delivered'
                                      when v_received > 0 then 'partially_delivered' else 'failed' end, updated_at = now()
  where id = dp.id;

  perform app_private.recompute_fulfilment(w.id);
  perform app_private.audit('record_delivery', 'delivery', v_id::text, null,
    jsonb_build_object('number', v_number, 'outcome', v_outcome, 'expected', v_expected, 'received', v_received,
      'damaged', v_damaged, 'missing', v_missing, 'rejected', v_rejected, 'via_link', p_via_link),
    p ->> 'comments', jsonb_build_object('dispatch_id', dp.id, 'work_order_id', w.id));
  if v_outcome <> 'delivered' then
    perform app_private.notify_permission('dispatch.view', 'Delivery exception on ' || dp.dispatch_number,
      format('%s: %s of %s received', app_private.label(v_outcome), v_received, v_expected), '/delivery', 'delivery', 'critical',
      'dispatch', dp.id);
  end if;
  return jsonb_build_object('ok', true, 'delivery_id', v_id, 'delivery_number', v_number, 'outcome', v_outcome,
    'expected', v_expected, 'received', v_received, 'outstanding', v_expected - v_received);
end $$;

create or replace function public.record_delivery(p_dispatch_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_permission('delivery.confirm');
  return app_private.apply_delivery(p_dispatch_id, p, auth.uid(), false);
end $$;

create or replace function public.create_delivery_token(p_dispatch_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  dp public.dispatches;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires timestamptz := now() + make_interval(hours => app_private.setting_num('delivery.token_hours', 72)::int);
begin
  perform app_private.require_permission('delivery.confirm');
  select * into dp from dispatches where id = p_dispatch_id;
  if not found then raise exception 'Dispatch not found'; end if;
  if dp.status <> 'dispatched' then raise exception 'A confirmation link can only be created for an in-transit dispatch'; end if;
  update delivery_tokens set revoked_at = now() where dispatch_id = dp.id and used_at is null and revoked_at is null;
  insert into delivery_tokens (dispatch_id, token_hash, expires_at, created_by)
  values (dp.id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expires, auth.uid());
  perform app_private.audit('create_delivery_link', 'dispatch', dp.id::text, null, jsonb_build_object('expires_at', v_expires), null,
    jsonb_build_object('dispatch_id', dp.id));
  return jsonb_build_object('token', v_token, 'expires_at', v_expires);
end $$;

create or replace function app_private.token_dispatch(p_token text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare t public.delivery_tokens;
begin
  if p_token is null or length(p_token) <> 64 then raise exception 'This confirmation link is invalid'; end if;
  select * into t from delivery_tokens where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found or t.revoked_at is not null then raise exception 'This confirmation link is invalid'; end if;
  if t.used_at is not null then raise exception 'This delivery has already been confirmed'; end if;
  if t.expires_at < now() then raise exception 'This confirmation link has expired. Ask the dispatcher for a new link.'; end if;
  return t.dispatch_id;
end $$;

-- Public (anon) view of exactly one shipment: no internal identifiers beyond what is needed.
create or replace function public.get_delivery_by_token(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_dispatch uuid := app_private.token_dispatch(p_token);
begin
  return (
    select jsonb_build_object(
      'dispatch_number', dp.dispatch_number, 'institution', i.name, 'emis_number', i.emis_number,
      'dispatch_date', dp.dispatch_date, 'courier', dp.courier_name, 'tracking_number', dp.tracking_number,
      'organisation', app_private.setting_text('org.name', 'DeviceFlow'),
      'pod_policy', app_private.setting_text('delivery.pod_policy', null),
      'devices', (select jsonb_agg(jsonb_build_object('dispatch_device_id', dd.id, 'serial_number', dv.serial_number,
                    'model', m.manufacturer || ' ' || m.model_name) order by dv.serial_number)
                  from dispatch_devices dd join devices dv on dv.id = dd.device_id join device_models m on m.id = dv.model_id
                  where dd.dispatch_id = dp.id and dd.status = 'dispatched'))
    from dispatches dp join institutions i on i.id = dp.institution_id where dp.id = v_dispatch);
end $$;

create or replace function public.confirm_delivery_by_token(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_dispatch uuid; v_res jsonb;
begin
  v_dispatch := app_private.token_dispatch(p_token);
  if coalesce(p ->> 'outcome', '') in ('failed','returned_to_sender') then
    raise exception 'Recipients can only confirm what was received';
  end if;
  v_res := app_private.apply_delivery(v_dispatch, p - 'delivered_at', null, true);
  update delivery_tokens set used_at = now() where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  return jsonb_build_object('ok', true, 'delivery_number', v_res ->> 'delivery_number', 'received', v_res -> 'received',
    'expected', v_res -> 'expected');
end $$;
