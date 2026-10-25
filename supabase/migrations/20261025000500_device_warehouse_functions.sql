-- =====================================================================
-- Device register, goods receiving, transfers, adjustments, stock counts
-- =====================================================================

-- Validates and inserts one physical device. Raises on any rule violation.
create or replace function app_private.create_device(p jsonb, p_status text, p_movement text, p_reference text default null)
returns public.devices
language plpgsql security definer set search_path = public as $$
declare
  v_model public.device_models;
  v_cat public.device_categories;
  v_wh public.warehouses;
  v_loc uuid := nullif(p ->> 'location_id', '')::uuid;
  v_serial text := nullif(trim(p ->> 'serial_number'), '');
  v_exception text := nullif(trim(p ->> 'serial_exception_reason'), '');
  v_imei text := nullif(trim(p ->> 'imei'), '');
  v_condition text := coalesce(nullif(p ->> 'condition', ''), 'new');
  v_status text := p_status;
  v_existing text;
  v_tag text := nullif(trim(p ->> 'asset_tag'), '');
  v_purchase date := nullif(p ->> 'purchase_date', '')::date;
  d public.devices;
begin
  select * into v_model from device_models
  where (id = nullif(p ->> 'model_id', '')::uuid or (nullif(p ->> 'model_id', '') is null and model_code = p ->> 'model_code'))
    and is_active;
  if not found then
    raise exception 'Unknown or inactive device model %', coalesce(p ->> 'model_code', p ->> 'model_id', '(blank)');
  end if;
  select * into v_cat from device_categories where id = v_model.category_id;
  select * into v_wh from warehouses where id = nullif(p ->> 'warehouse_id', '')::uuid and is_active;
  if not found then raise exception 'Select an active warehouse'; end if;
  if v_loc is not null and not exists (select 1 from warehouse_locations where id = v_loc and warehouse_id = v_wh.id and is_active) then
    raise exception 'The storage location does not belong to warehouse %', v_wh.code;
  end if;

  if v_serial is null then
    if v_cat.requires_serial then
      if v_exception is null then
        raise exception 'A serial number is required for % devices', v_cat.name;
      end if;
      if not public.has_permission('inventory.serial_exception') then
        raise exception 'Permission denied: recording a serial-number exception requires "inventory.serial_exception"' using errcode = '42501';
      end if;
    else
      v_exception := coalesce(v_exception, format('Category %s does not require serial numbers', v_cat.name));
    end if;
  else
    if length(v_serial) > 64 then raise exception 'Serial number is too long'; end if;
    select asset_tag into v_existing from devices
    where upper(manufacturer) = upper(v_model.manufacturer) and serial_normalized = public.normalize_serial(v_serial);
    if v_existing is not null then
      raise exception 'Duplicate serial number: % % is already registered as %', v_model.manufacturer, v_serial, v_existing
        using errcode = '23505';
    end if;
    v_exception := null;
  end if;

  if v_cat.requires_imei and v_imei is null then
    raise exception 'An IMEI is required for % devices', v_cat.name;
  end if;
  if v_imei is not null then
    select dv.asset_tag into v_existing from device_identifiers i join devices dv on dv.id = i.device_id
    where i.identifier_type = 'imei' and i.value_normalized = public.normalize_serial(v_imei);
    if v_existing is not null then
      raise exception 'Duplicate IMEI: % is already registered to %', v_imei, v_existing using errcode = '23505';
    end if;
  end if;

  if v_condition not in ('new','good','fair','poor','faulty','damaged','beyond_repair') then
    raise exception 'Invalid condition %', v_condition;
  end if;
  if v_condition in ('faulty','damaged','beyond_repair','poor') and v_status in ('available','received') then
    v_status := case when v_status = 'received' then 'received' else 'faulty' end;
  end if;

  if v_tag is null then
    v_tag := app_private.next_document_number('asset_tag');
  elsif exists (select 1 from devices where asset_tag = v_tag) then
    raise exception 'Asset tag % is already in use', v_tag using errcode = '23505';
  end if;

  insert into devices (asset_tag, model_id, category_id, manufacturer, serial_number, serial_exception_reason, barcode_value,
    status, condition, warehouse_id, location_id, supplier_id, acquisition_reference, purchase_date, unit_cost_cents,
    warranty_expires_on, warranty_notes, received_at, notes, goods_receipt_id, goods_receipt_line_id, created_by, updated_by)
  values (v_tag, v_model.id, v_cat.id, v_model.manufacturer, v_serial, v_exception, coalesce(v_serial, v_tag),
    v_status, v_condition, v_wh.id, v_loc, nullif(p ->> 'supplier_id', '')::uuid, nullif(p ->> 'acquisition_reference', ''),
    v_purchase, nullif(p ->> 'unit_cost_cents', '')::bigint,
    coalesce(nullif(p ->> 'warranty_expires_on', '')::date,
             (coalesce(v_purchase, (now() at time zone 'Africa/Johannesburg')::date) + make_interval(months => v_model.warranty_months))::date),
    nullif(p ->> 'warranty_notes', ''), now(), nullif(p ->> 'notes', ''),
    nullif(p ->> 'goods_receipt_id', '')::uuid, nullif(p ->> 'goods_receipt_line_id', '')::uuid, auth.uid(), auth.uid())
  returning * into d;

  if v_imei is not null then
    insert into device_identifiers (device_id, identifier_type, value, created_by) values (d.id, 'imei', v_imei, auth.uid());
  end if;
  insert into device_movements (device_id, movement_type, from_status, to_status, to_warehouse_id, to_location_id, reference, reason, performed_by)
  values (d.id, p_movement, null, d.status, d.warehouse_id, d.location_id, p_reference,
          case when v_exception is not null then 'Serial exception: ' || v_exception end, auth.uid());
  return d;
end $$;

create or replace function public.register_device(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices;
begin
  perform app_private.require_permission('devices.register');
  perform app_private.require_warehouse_scope(nullif(p ->> 'warehouse_id', '')::uuid);
  begin
    d := app_private.create_device(p, 'available', 'registered', nullif(p ->> 'acquisition_reference', ''));
  exception when unique_violation then
    perform app_private.audit('register_device', 'device', null, null, p, sqlerrm, '{}'::jsonb, false);
    raise;
  end;
  perform app_private.audit('register_device', 'device', d.id::text, null, to_jsonb(d), null, jsonb_build_object('device_id', d.id));
  return jsonb_build_object('id', d.id, 'asset_tag', d.asset_tag, 'status', d.status);
end $$;

-- Validate (dry run) or commit a chunk of device rows. All-or-nothing per chunk.
create or replace function public.import_devices(p_rows jsonb, p_warehouse_id uuid, p_dry_run boolean default true, p_reference text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  i int := 0;
  v_ok int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  perform app_private.require_permission('devices.register');
  perform app_private.require_permission('data.import');
  perform app_private.require_warehouse_scope(p_warehouse_id);
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be an array'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'Import at most 1000 rows per chunk'; end if;

  begin
    for r in select * from jsonb_array_elements(p_rows) loop
      i := i + 1;
      begin
        perform app_private.create_device(
          r || jsonb_build_object('warehouse_id', p_warehouse_id, 'acquisition_reference', coalesce(r ->> 'acquisition_reference', p_reference)),
          'available', 'imported', p_reference);
        v_ok := v_ok + 1;
      exception when others then
        v_errors := v_errors || jsonb_build_object('row', coalesce((r ->> '_row')::int, i), 'serial_number', r ->> 'serial_number', 'error', sqlerrm);
      end;
    end loop;
    if p_dry_run or jsonb_array_length(v_errors) > 0 then
      raise exception 'rollback' using errcode = 'DFRBK';
    end if;
  exception when sqlstate 'DFRBK' then
    null;
  end;

  if not p_dry_run then
    perform app_private.audit('import_devices', 'device', null, null,
      jsonb_build_object('rows', i, 'imported', case when jsonb_array_length(v_errors) = 0 then v_ok else 0 end, 'errors', jsonb_array_length(v_errors)),
      p_reference, '{}'::jsonb, jsonb_array_length(v_errors) = 0);
  end if;
  return jsonb_build_object('rows', i, 'valid', v_ok, 'errors', v_errors,
    'committed', (not p_dry_run and jsonb_array_length(v_errors) = 0));
end $$;

create or replace function public.update_device_details(p_device_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d public.devices; n public.devices;
begin
  perform app_private.require_permission('devices.edit');
  select * into d from devices where id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  perform app_private.require_warehouse_scope(d.warehouse_id);
  if p ? 'location_id' and nullif(p ->> 'location_id', '') is not null and not exists
     (select 1 from warehouse_locations where id = (p ->> 'location_id')::uuid and warehouse_id = d.warehouse_id and is_active) then
    raise exception 'The location does not belong to the device warehouse';
  end if;
  update devices set
    notes = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
    warranty_expires_on = case when p ? 'warranty_expires_on' then nullif(p ->> 'warranty_expires_on', '')::date else warranty_expires_on end,
    warranty_notes = case when p ? 'warranty_notes' then nullif(p ->> 'warranty_notes', '') else warranty_notes end,
    acquisition_reference = case when p ? 'acquisition_reference' then nullif(p ->> 'acquisition_reference', '') else acquisition_reference end,
    supplier_id = case when p ? 'supplier_id' then nullif(p ->> 'supplier_id', '')::uuid else supplier_id end,
    purchase_date = case when p ? 'purchase_date' then nullif(p ->> 'purchase_date', '')::date else purchase_date end,
    unit_cost_cents = case when p ? 'unit_cost_cents' then nullif(p ->> 'unit_cost_cents', '')::bigint else unit_cost_cents end
  where id = d.id returning * into n;
  if p ? 'location_id' and nullif(p ->> 'location_id', '')::uuid is distinct from d.location_id then
    perform app_private.move_device(d.id, null, 'location_change',
      jsonb_build_object('to_location_id', nullif(p ->> 'location_id', ''), 'reason', coalesce(p ->> 'reason', 'Location updated')));
  end if;
  perform app_private.audit('update_device', 'device', d.id::text, to_jsonb(d), to_jsonb(n), p ->> 'reason', jsonb_build_object('device_id', d.id));
end $$;

create or replace function public.correct_device_identity(p_device_id uuid, p_new_serial text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.devices; v_existing text;
begin
  perform app_private.require_permission('devices.correct_identity');
  if length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'Describe why the identity is being corrected (at least 10 characters)'; end if;
  if public.normalize_serial(p_new_serial) is null then raise exception 'Enter the corrected serial number'; end if;
  select * into d from devices where id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if d.status in ('dispatched','delivered') then
    raise exception 'The identity of a dispatched or delivered device cannot be corrected. Receive it back first.';
  end if;
  select asset_tag into v_existing from devices
  where id <> d.id and upper(manufacturer) = upper(d.manufacturer) and serial_normalized = public.normalize_serial(p_new_serial);
  if v_existing is not null then
    raise exception 'Duplicate serial number: % is already registered as %', p_new_serial, v_existing using errcode = '23505';
  end if;
  perform set_config('deviceflow.identity_correction', 'on', true);
  update devices set serial_number = trim(p_new_serial), serial_exception_reason = null, barcode_value = trim(p_new_serial) where id = d.id;
  perform set_config('deviceflow.identity_correction', 'off', true);
  insert into device_movements (device_id, movement_type, from_status, to_status, from_warehouse_id, to_warehouse_id, reference, reason, performed_by)
  values (d.id, 'identity_correction', d.status, d.status, d.warehouse_id, d.warehouse_id,
          coalesce(d.serial_number, '(none)') || ' -> ' || trim(p_new_serial), p_reason, auth.uid());
  perform app_private.audit('correct_identity', 'device', d.id::text, jsonb_build_object('serial_number', d.serial_number),
    jsonb_build_object('serial_number', trim(p_new_serial)), p_reason, jsonb_build_object('device_id', d.id));
end $$;

-- Read-only lookup by serial, asset tag, barcode or IMEI for scan screens.
create or replace function public.lookup_device(p_query text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_norm text := public.normalize_serial(p_query);
begin
  perform app_private.require_permission('devices.view');
  if v_norm is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'asset_tag', d.asset_tag, 'serial_number', d.serial_number, 'manufacturer', d.manufacturer,
      'model', m.model_name, 'category', c.name, 'status', d.status, 'condition', d.condition,
      'warehouse', w.code, 'location', l.code, 'work_order', wo.wo_number, 'work_order_id', wo.id,
      'institution', i.name,
      'matched_on', case when d.serial_normalized = v_norm then 'serial' when public.normalize_serial(d.asset_tag) = v_norm then 'asset_tag' else 'identifier' end,
      'open_discrepancy', exists (select 1 from serial_discrepancies s where s.scanned_device_id = d.id and s.status = 'open'),
      'allocation_problem', app_private.device_issue_problem(d, null, 'available')))
    from devices d
    join device_models m on m.id = d.model_id
    join device_categories c on c.id = d.category_id
    join warehouses w on w.id = d.warehouse_id
    left join warehouse_locations l on l.id = d.location_id
    left join work_orders wo on wo.id = d.current_work_order_id
    left join institutions i on i.id = d.current_institution_id
    where (d.serial_normalized = v_norm
       or public.normalize_serial(d.asset_tag) = v_norm
       or exists (select 1 from device_identifiers x where x.device_id = d.id and x.value_normalized = v_norm))
      and d.warehouse_id = any(public.my_warehouse_ids())
  ), '[]'::jsonb);
end $$;

create or replace function public.report_device_fault(p_device_id uuid, p_fault text, p_work_order_id uuid default null, p_origin text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d public.devices;
  a public.work_order_devices;
  v_id uuid;
  v_number text;
begin
  perform app_private.require_permission('assessments.record');
  if length(trim(coalesce(p_fault, ''))) < 5 then raise exception 'Describe the reported fault'; end if;
  select * into d from devices where id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if d.status in ('faulty','under_assessment','under_repair','awaiting_parts','written_off','lost','stolen') then
    raise exception 'Device % is already "%"', coalesce(d.serial_number, d.asset_tag), app_private.label(d.status);
  end if;
  if exists (select 1 from device_assessments where device_id = d.id and status in ('pending','in_progress')) then
    raise exception 'Device % already has an open assessment', coalesce(d.serial_number, d.asset_tag);
  end if;

  select * into a from work_order_devices where device_id = d.id and status in ('reserved','picked','issued','dispatched') for update;
  if found then
    if a.status = 'dispatched' then
      raise exception 'Device % is in transit. Record the outcome on the delivery confirmation.', d.serial_number;
    end if;
    if exists (select 1 from invoice_device_links where work_order_device_id = a.id and status = 'active') then
      raise exception 'Device % is invoiced on its work order. Use "Replace device" so the allocation and invoice stay consistent.', d.serial_number;
    end if;
    update work_order_devices set status = 'released', released_at = now(), released_by = auth.uid(),
      release_reason = 'Reported faulty: ' || p_fault where id = a.id;
  end if;

  perform app_private.move_device(d.id, 'faulty', 'fault_reported',
    jsonb_build_object('reason', p_fault, 'condition', 'faulty', 'work_order_id', coalesce(p_work_order_id, a.work_order_id),
      'assign_work_order_id', case when a.id is not null then null else d.current_work_order_id end));

  v_number := app_private.next_document_number('assessment');
  insert into device_assessments (assessment_number, device_id, work_order_id, institution_id, origin, reported_fault, reported_by)
  values (v_number, d.id, coalesce(p_work_order_id, a.work_order_id), d.current_institution_id,
          coalesce(p_origin, case when d.status = 'delivered' then 'Field' else 'Warehouse' end), p_fault, auth.uid())
  returning id into v_id;

  perform app_private.audit('report_fault', 'device', d.id::text, jsonb_build_object('status', d.status),
    jsonb_build_object('status', 'faulty', 'assessment', v_number), p_fault, jsonb_build_object('device_id', d.id, 'work_order_id', a.work_order_id));
  perform app_private.notify_permission('repairs.manage', 'Device flagged faulty: ' || coalesce(d.serial_number, d.asset_tag),
    p_fault, '/repairs', 'repair', 'warning', 'assessment', v_id, d.warehouse_id);
  return v_id;
end $$;

-- =====================================================================
-- Goods receiving
-- =====================================================================
create or replace function public.create_goods_receipt(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_line jsonb;
  v_wh uuid := nullif(p ->> 'warehouse_id', '')::uuid;
begin
  perform app_private.require_permission('inventory.receive');
  if not exists (select 1 from warehouses where id = v_wh and is_active) then raise exception 'Select an active warehouse'; end if;
  perform app_private.require_warehouse_scope(v_wh);
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then
    raise exception 'Add at least one expected model line';
  end if;
  insert into goods_receipts (grn_number, warehouse_id, supplier_id, source_type, source_reference, receiving_date, notes, received_by)
  values (app_private.next_document_number('goods_receipt'), v_wh, nullif(p ->> 'supplier_id', '')::uuid,
          coalesce(nullif(p ->> 'source_type', ''), 'purchase'), nullif(p ->> 'source_reference', ''),
          coalesce(nullif(p ->> 'receiving_date', '')::date, (now() at time zone 'Africa/Johannesburg')::date),
          nullif(p ->> 'notes', ''), auth.uid())
  returning id into v_id;
  for v_line in select * from jsonb_array_elements(p -> 'lines') loop
    if not exists (select 1 from device_models where id = (v_line ->> 'model_id')::uuid and is_active) then
      raise exception 'Unknown device model on receipt line';
    end if;
    if coalesce((v_line ->> 'expected_qty')::int, -1) < 0 then raise exception 'Expected quantity must be zero or more'; end if;
    insert into goods_receipt_lines (goods_receipt_id, model_id, expected_qty, unit_cost_cents, notes)
    values (v_id, (v_line ->> 'model_id')::uuid, (v_line ->> 'expected_qty')::int, nullif(v_line ->> 'unit_cost_cents', '')::bigint, nullif(v_line ->> 'notes', ''));
  end loop;
  perform app_private.audit('create_goods_receipt', 'goods_receipt', v_id::text, null, p);
  return v_id;
end $$;

create or replace function public.receive_device_into_receipt(p_receipt_id uuid, p_line_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.goods_receipts;
  l public.goods_receipt_lines;
  d public.devices;
begin
  perform app_private.require_permission('inventory.receive');
  select * into g from goods_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Goods receipt not found'; end if;
  perform app_private.require_warehouse_scope(g.warehouse_id);
  if g.status <> 'draft' then raise exception 'Goods receipt % is already %', g.grn_number, g.status; end if;
  select * into l from goods_receipt_lines where id = p_line_id and goods_receipt_id = g.id;
  if not found then raise exception 'Receipt line not found'; end if;
  begin
    d := app_private.create_device(p || jsonb_build_object('model_id', l.model_id, 'warehouse_id', g.warehouse_id,
           'supplier_id', g.supplier_id, 'acquisition_reference', coalesce(g.source_reference, g.grn_number),
           'unit_cost_cents', l.unit_cost_cents, 'goods_receipt_id', g.id, 'goods_receipt_line_id', l.id,
           'purchase_date', g.receiving_date),
         'received', 'goods_received', g.grn_number);
  exception when others then
    return app_private.scan_fail('receiving', case when sqlstate = '23505' then 'duplicate_serial' else 'invalid' end, sqlerrm,
      jsonb_build_object('scanned_serial', p ->> 'serial_number'));
  end;
  return jsonb_build_object('ok', true, 'device_id', d.id, 'asset_tag', d.asset_tag, 'status', d.status,
    'message', format('%s received as %s', coalesce(d.serial_number, '(serial exception)'), d.asset_tag),
    'received_on_line', (select count(*) from devices where goods_receipt_line_id = l.id));
end $$;

create or replace function public.complete_goods_receipt(p_receipt_id uuid, p_discrepancy_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g public.goods_receipts;
  v_mismatch jsonb;
  d record;
  v_count int := 0;
begin
  perform app_private.require_permission('inventory.receive');
  select * into g from goods_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Goods receipt not found'; end if;
  perform app_private.require_warehouse_scope(g.warehouse_id);
  if g.status <> 'draft' then raise exception 'Goods receipt % is already %', g.grn_number, g.status; end if;
  if not exists (select 1 from devices where goods_receipt_id = g.id) then
    raise exception 'No devices have been received on %', g.grn_number;
  end if;

  select jsonb_agg(jsonb_build_object('model', m.model_name, 'expected', l.expected_qty, 'received', x.cnt))
    into v_mismatch
  from goods_receipt_lines l
  join device_models m on m.id = l.model_id
  cross join lateral (select count(*)::int as cnt from devices dv where dv.goods_receipt_line_id = l.id) x
  where l.goods_receipt_id = g.id and x.cnt <> l.expected_qty;

  if v_mismatch is not null and length(trim(coalesce(p_discrepancy_notes, ''))) < 5 then
    return jsonb_build_object('ok', false, 'code', 'quantity_discrepancy',
      'message', 'Received quantities differ from expected quantities. Record discrepancy notes to complete.', 'lines', v_mismatch);
  end if;

  for d in select id, condition from devices where goods_receipt_id = g.id and status = 'received' loop
    perform app_private.move_device(d.id,
      case when d.condition in ('new','good','fair') then 'available' else 'faulty' end,
      'receipt_completed', jsonb_build_object('reference', g.grn_number, 'verified', true));
    v_count := v_count + 1;
  end loop;

  update goods_receipts set status = case when v_mismatch is null then 'completed' else 'completed_with_discrepancies' end,
    discrepancy_notes = p_discrepancy_notes, completed_by = auth.uid(), completed_at = now() where id = g.id;
  perform app_private.audit('complete_goods_receipt', 'goods_receipt', g.id::text, null,
    jsonb_build_object('released', v_count, 'discrepancies', v_mismatch), p_discrepancy_notes);
  if v_mismatch is not null then
    perform app_private.notify_permission('inventory.adjust_approve', 'Receiving discrepancy on ' || g.grn_number,
      p_discrepancy_notes, '/warehouse/receiving/' || g.id, 'stock', 'warning', 'goods_receipt', g.id, g.warehouse_id);
  end if;
  return jsonb_build_object('ok', true, 'released', v_count, 'discrepancies', v_mismatch);
end $$;

-- =====================================================================
-- Location moves, transfers and adjustments
-- =====================================================================
create or replace function public.move_device_location(p_device_id uuid, p_location_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.devices;
begin
  perform app_private.require_permission('inventory.transfer');
  select * into d from devices where id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  perform app_private.require_warehouse_scope(d.warehouse_id);
  if d.status in ('dispatched','delivered','in_transit','lost','stolen','written_off') then
    raise exception 'Device is not physically in the warehouse (status "%")', app_private.label(d.status);
  end if;
  if not exists (select 1 from warehouse_locations where id = p_location_id and warehouse_id = d.warehouse_id and is_active) then
    raise exception 'The location does not belong to the device warehouse';
  end if;
  perform app_private.move_device(d.id, null, 'location_change', jsonb_build_object('to_location_id', p_location_id, 'reason', p_reason));
end $$;

create or replace function public.create_stock_transfer(p_from_warehouse uuid, p_to_warehouse uuid, p_serials text[], p_reason text, p_reference text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_number text;
  s text;
  d public.devices;
  v_ids uuid[];
  v_problem text;
begin
  perform app_private.require_permission('inventory.transfer');
  perform app_private.require_warehouse_scope(p_from_warehouse);
  if p_from_warehouse = p_to_warehouse then raise exception 'Source and destination warehouses must differ'; end if;
  if not exists (select 1 from warehouses where id = p_to_warehouse and is_active) then raise exception 'Destination warehouse is not active'; end if;
  if coalesce(cardinality(p_serials), 0) = 0 then raise exception 'Scan at least one device'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A transfer reason is required'; end if;

  v_number := app_private.next_document_number('stock_movement');
  insert into stock_movements (movement_number, movement_type, status, from_warehouse_id, to_warehouse_id, reason, reference,
                               requested_by, approved_by, approved_at)
  values (v_number, 'transfer', 'in_transit', p_from_warehouse, p_to_warehouse, p_reason, p_reference, auth.uid(), auth.uid(), now())
  returning id into v_id;

  foreach s in array p_serials loop
    v_ids := app_private.find_scanned_device(s, null);
    if v_ids is null or cardinality(v_ids) <> 1 then
      raise exception 'Serial % does not identify exactly one registered device', s;
    end if;
    select * into d from devices where id = v_ids[1] for update;
    v_problem := app_private.device_issue_problem(d, p_from_warehouse, 'available');
    if v_problem is not null then raise exception 'Cannot transfer: %', v_problem; end if;
    insert into stock_movement_lines (stock_movement_id, device_id, from_status, from_location_id)
    values (v_id, d.id, d.status, d.location_id);
    perform app_private.move_device(d.id, 'in_transit', 'transfer_out',
      jsonb_build_object('reference', v_number, 'reason', p_reason, 'to_location_id', null));
  end loop;
  perform app_private.audit('create_transfer', 'stock_movement', v_id::text, null,
    jsonb_build_object('number', v_number, 'devices', cardinality(p_serials)), p_reason);
  perform app_private.notify_permission('inventory.transfer', 'Incoming transfer ' || v_number,
    format('%s device(s) are in transit to your warehouse.', cardinality(p_serials)), '/warehouse/transfers', 'stock', 'info',
    'stock_movement', v_id, p_to_warehouse, auth.uid());
  return jsonb_build_object('ok', true, 'id', v_id, 'number', v_number);
end $$;

create or replace function public.receive_stock_transfer(p_transfer_id uuid, p_location_id uuid default null, p_serials text[] default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.stock_movements;
  r record;
  v_count int := 0;
  v_remaining int;
begin
  perform app_private.require_permission('inventory.transfer');
  select * into t from stock_movements where id = p_transfer_id and movement_type = 'transfer' for update;
  if not found then raise exception 'Transfer not found'; end if;
  perform app_private.require_warehouse_scope(t.to_warehouse_id);
  if t.status <> 'in_transit' then raise exception 'Transfer % is %', t.movement_number, t.status; end if;
  if p_location_id is not null and not exists (select 1 from warehouse_locations where id = p_location_id and warehouse_id = t.to_warehouse_id) then
    raise exception 'The location does not belong to the destination warehouse';
  end if;
  for r in
    select d.id from stock_movement_lines sl join devices d on d.id = sl.device_id
    where sl.stock_movement_id = t.id and d.status = 'in_transit'
      and (p_serials is null or d.serial_normalized = any(select public.normalize_serial(x) from unnest(p_serials) x))
  loop
    perform app_private.move_device(r.id, 'available', 'transfer_in',
      jsonb_build_object('reference', t.movement_number, 'to_warehouse_id', t.to_warehouse_id, 'to_location_id', p_location_id, 'verified', true));
    v_count := v_count + 1;
  end loop;
  select count(*) into v_remaining from stock_movement_lines sl join devices d on d.id = sl.device_id
  where sl.stock_movement_id = t.id and d.status = 'in_transit';
  if v_remaining = 0 then
    update stock_movements set status = 'completed', completed_by = auth.uid(), completed_at = now() where id = t.id;
  end if;
  perform app_private.audit('receive_transfer', 'stock_movement', t.id::text, null,
    jsonb_build_object('received', v_count, 'outstanding', v_remaining));
  return jsonb_build_object('ok', true, 'received', v_count, 'outstanding', v_remaining);
end $$;

create or replace function public.request_stock_adjustment(p_device_id uuid, p_type text, p_reason text,
  p_new_condition text default null, p_location_id uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d public.devices;
  v_id uuid;
begin
  perform app_private.require_permission('inventory.adjust_request');
  if p_type not in ('mark_lost','mark_stolen','write_off','found','condition_change','location_correction','quarantine') then
    raise exception 'Invalid adjustment type';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason (at least 5 characters) is required for every adjustment'; end if;
  select * into d from devices where id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  perform app_private.require_warehouse_scope(d.warehouse_id);
  if exists (select 1 from stock_movement_lines sl join stock_movements m on m.id = sl.stock_movement_id
             where sl.device_id = d.id and m.movement_type = 'adjustment' and m.status = 'requested') then
    raise exception 'Device % already has a pending adjustment', coalesce(d.serial_number, d.asset_tag);
  end if;
  if p_type = 'condition_change' and p_new_condition not in ('new','good','fair','poor','faulty','damaged','beyond_repair') then
    raise exception 'Select the new condition';
  end if;
  if p_type in ('location_correction','found') and p_location_id is not null and not exists
     (select 1 from warehouse_locations where id = p_location_id and warehouse_id = d.warehouse_id) then
    raise exception 'The location does not belong to the device warehouse';
  end if;
  if p_type = 'found' and d.status not in ('lost','stolen') then raise exception 'Only lost or stolen devices can be marked found'; end if;
  if p_type = 'write_off' and d.status in ('dispatched','delivered') then
    raise exception 'A device at an institution must be returned or marked lost before it is written off';
  end if;

  insert into stock_movements (movement_number, movement_type, adjustment_type, status, from_warehouse_id, to_location_id,
                               new_condition, reason, requested_by)
  values (app_private.next_document_number('stock_movement'), 'adjustment', p_type, 'requested', d.warehouse_id,
          p_location_id, p_new_condition, p_reason, auth.uid())
  returning id into v_id;
  insert into stock_movement_lines (stock_movement_id, device_id, from_status, from_location_id) values (v_id, d.id, d.status, d.location_id);
  perform app_private.audit('request_adjustment', 'stock_movement', v_id::text, null,
    jsonb_build_object('type', p_type, 'device', d.asset_tag), p_reason, jsonb_build_object('device_id', d.id));
  perform app_private.notify_permission('inventory.adjust_approve', 'Stock adjustment awaiting approval',
    format('%s for %s: %s', app_private.label(p_type), coalesce(d.serial_number, d.asset_tag), p_reason),
    '/warehouse/adjustments', 'stock', 'warning', 'stock_movement', v_id, d.warehouse_id, auth.uid());
  return v_id;
end $$;

create or replace function public.decide_stock_adjustment(p_adjustment_id uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.stock_movements;
  d public.devices;
  a public.work_order_devices;
  v_target text;
begin
  perform app_private.require_permission('inventory.adjust_approve');
  select * into m from stock_movements where id = p_adjustment_id and movement_type = 'adjustment' for update;
  if not found then raise exception 'Adjustment not found'; end if;
  perform app_private.require_warehouse_scope(m.from_warehouse_id);
  if m.status <> 'requested' then raise exception 'Adjustment % is already %', m.movement_number, m.status; end if;
  if app_private.setting_bool('workflow.sod_adjustment_requester_cannot_approve', true) and m.requested_by = auth.uid() then
    raise exception 'Segregation of duties: you cannot approve an adjustment you requested' using errcode = '42501';
  end if;
  if not p_approve then
    if length(trim(coalesce(p_comment, ''))) < 5 then raise exception 'A reason is required to reject an adjustment'; end if;
    update stock_movements set status = 'rejected', approved_by = auth.uid(), approved_at = now(), decision_comment = p_comment where id = m.id;
    perform app_private.audit('reject_adjustment', 'stock_movement', m.id::text, null, null, p_comment);
    perform app_private.notify_user(m.requested_by, 'Adjustment rejected: ' || m.movement_number, p_comment,
      '/warehouse/adjustments', 'stock', 'warning', 'stock_movement', m.id);
    return;
  end if;

  select d2.* into d from stock_movement_lines sl join devices d2 on d2.id = sl.device_id where sl.stock_movement_id = m.id;
  select * into a from work_order_devices where device_id = d.id and status in ('reserved','picked','issued','dispatched') for update;

  v_target := case m.adjustment_type
    when 'mark_lost' then 'lost'
    when 'mark_stolen' then 'stolen'
    when 'write_off' then 'written_off'
    when 'found' then 'returned_to_warehouse'
    when 'quarantine' then 'quarantined'
    when 'condition_change' then case when m.new_condition in ('faulty','damaged','beyond_repair') and d.status = 'available' then 'faulty' else null end
    else null end;

  if a.id is not null and v_target in ('lost','stolen','written_off','faulty','quarantined') then
    if exists (select 1 from invoice_device_links where work_order_device_id = a.id and status = 'active') and a.status <> 'dispatched' then
      raise exception 'Device is invoiced on an active work order. Use a device replacement first.';
    end if;
    update work_order_devices set status = 'cancelled', released_at = now(), released_by = auth.uid(),
      release_reason = 'Stock adjustment ' || m.movement_number || ': ' || m.reason where id = a.id;
    update dispatch_devices set status = 'missing' where device_id = d.id and status = 'dispatched';
  end if;

  perform app_private.move_device(d.id, v_target, 'adjustment_' || m.adjustment_type,
    jsonb_build_object('reference', m.movement_number, 'reason', m.reason,
      'condition', m.new_condition,
      'to_location_id', case when m.to_location_id is not null then m.to_location_id::text else d.location_id::text end,
      'assign_work_order_id', case when a.id is not null and v_target is not null then null else d.current_work_order_id::text end));

  update stock_movements set status = 'completed', approved_by = auth.uid(), approved_at = now(), decision_comment = p_comment,
    completed_by = auth.uid(), completed_at = now() where id = m.id;
  if a.id is not null then
    perform app_private.recompute_fulfilment(a.work_order_id);
  end if;
  perform app_private.audit('approve_adjustment', 'stock_movement', m.id::text, jsonb_build_object('status', d.status),
    jsonb_build_object('status', coalesce(v_target, d.status), 'type', m.adjustment_type), coalesce(p_comment, m.reason),
    jsonb_build_object('device_id', d.id, 'work_order_id', a.work_order_id));
  perform app_private.notify_user(m.requested_by, 'Adjustment approved: ' || m.movement_number, p_comment,
    '/warehouse/adjustments', 'stock', 'success', 'stock_movement', m.id);
end $$;

create or replace function public.release_device_to_stock(p_device_id uuid, p_location_id uuid, p_condition text, p_notes text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.devices;
  rj public.repair_jobs;
begin
  perform app_private.require_permission('inventory.release');
  select * into d from devices where id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  perform app_private.require_warehouse_scope(d.warehouse_id);
  if d.status not in ('returned_to_warehouse','repair_completed','quarantined') then
    raise exception 'Only returned, repaired or quarantined devices can be released (current: "%")', app_private.label(d.status);
  end if;
  if p_condition not in ('new','good','fair') then
    raise exception 'Only devices in new, good or fair condition can be released to available stock';
  end if;
  if not exists (select 1 from warehouse_locations where id = p_location_id and warehouse_id = d.warehouse_id and is_active and location_type = 'storage') then
    raise exception 'Select an active storage location in the device warehouse';
  end if;
  if exists (select 1 from repair_jobs where device_id = d.id and status not in ('closed','cancelled','returned_to_warehouse','returned_to_recipient')) then
    raise exception 'Device has an open repair job. Complete the repair and quality check first.';
  end if;
  select * into rj from repair_jobs where device_id = d.id and status <> 'cancelled' order by created_at desc limit 1;
  if found and rj.status in ('returned_to_warehouse','closed') and rj.qc_result is distinct from 'pass'
     and not exists (select 1 from device_movements mv where mv.device_id = d.id and mv.movement_type = 'released_to_stock' and mv.performed_at > rj.created_at) then
    raise exception 'The latest repair (%) has not passed quality inspection', rj.repair_number;
  end if;
  if exists (select 1 from return_lines rl where rl.device_id = d.id and rl.inspection_outcome is null) then
    raise exception 'The return inspection for this device is not complete';
  end if;
  if exists (select 1 from return_lines rl where rl.device_id = d.id and rl.inspection_outcome is not null
             and rl.inspection_outcome <> 'release_to_stock'
             and rl.inspected_at = (select max(x.inspected_at) from return_lines x where x.device_id = d.id)
             and not exists (select 1 from repair_jobs r where r.device_id = d.id and r.created_at > rl.inspected_at and r.qc_result = 'pass')) then
    raise exception 'The latest return inspection did not approve release to stock';
  end if;
  if exists (select 1 from device_assessments where device_id = d.id and status in ('pending','in_progress')) then
    raise exception 'The device has an open assessment';
  end if;

  perform app_private.move_device(d.id, 'available', 'released_to_stock',
    jsonb_build_object('to_location_id', p_location_id, 'condition', p_condition, 'reason', coalesce(p_notes, 'Inspected and released'),
      'assign_work_order_id', null, 'assign_institution_id', null, 'assign_recipient_id', null, 'verified', true));
  update repair_jobs set status = 'closed', updated_at = now() where device_id = d.id and status = 'returned_to_warehouse';
  perform app_private.audit('release_to_stock', 'device', d.id::text, jsonb_build_object('status', d.status),
    jsonb_build_object('status', 'available', 'condition', p_condition), p_notes, jsonb_build_object('device_id', d.id));
end $$;

-- =====================================================================
-- Stock counts and reconciliation
-- =====================================================================
create or replace function public.start_stock_count(p_warehouse_id uuid, p_location_id uuid default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_expected int;
begin
  perform app_private.require_permission('inventory.count');
  perform app_private.require_warehouse_scope(p_warehouse_id);
  if p_location_id is not null and not exists (select 1 from warehouse_locations where id = p_location_id and warehouse_id = p_warehouse_id) then
    raise exception 'The location does not belong to the warehouse';
  end if;
  if exists (select 1 from stock_counts where warehouse_id = p_warehouse_id and status = 'open'
             and (location_id is not distinct from p_location_id or location_id is null or p_location_id is null)) then
    raise exception 'An overlapping stock count is already open for this warehouse';
  end if;
  insert into stock_counts (count_number, warehouse_id, location_id, notes, started_by)
  values (app_private.next_document_number('stock_count'), p_warehouse_id, p_location_id, p_notes, auth.uid())
  returning id into v_id;
  insert into stock_count_lines (stock_count_id, device_id, expected_location_id, result)
  select v_id, d.id, d.location_id, 'pending' from devices d
  where d.warehouse_id = p_warehouse_id
    and (p_location_id is null or d.location_id = p_location_id)
    and d.status in ('received','available','reserved','picked','issued','faulty','under_assessment','under_repair',
                     'awaiting_parts','repair_completed','returned_to_warehouse','quarantined');
  get diagnostics v_expected = row_count;
  update stock_counts set expected_count = v_expected where id = v_id;
  perform app_private.audit('start_stock_count', 'stock_count', v_id::text, null, jsonb_build_object('expected', v_expected));
  return v_id;
end $$;

create or replace function public.stock_count_scan(p_count_id uuid, p_serial text, p_location_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.stock_counts;
  ln public.stock_count_lines;
  v_ids uuid[];
  d public.devices;
begin
  perform app_private.require_permission('inventory.count');
  select * into c from stock_counts where id = p_count_id for update;
  if not found then raise exception 'Stock count not found'; end if;
  perform app_private.require_warehouse_scope(c.warehouse_id);
  if c.status <> 'open' then raise exception 'Stock count % is %', c.count_number, c.status; end if;
  v_ids := app_private.find_scanned_device(p_serial, null);
  if v_ids is null then
    insert into stock_count_lines (stock_count_id, scanned_serial, found_location_id, result, scanned_by, scanned_at)
    values (c.id, p_serial, p_location_id, 'unexpected', auth.uid(), now());
    return jsonb_build_object('ok', false, 'code', 'unknown_serial', 'message', format('Serial %s is not registered - recorded as unexpected', p_serial));
  end if;
  select * into d from devices where id = v_ids[1];
  select * into ln from stock_count_lines where stock_count_id = c.id and device_id = d.id for update;
  if found then
    if ln.result <> 'pending' then
      return jsonb_build_object('ok', false, 'code', 'duplicate_scan', 'message', format('%s was already counted', p_serial));
    end if;
    update stock_count_lines set
      result = case when p_location_id is not null and ln.expected_location_id is not null and p_location_id <> ln.expected_location_id
                    then 'wrong_location' else 'found' end,
      scanned_serial = p_serial, found_location_id = p_location_id, scanned_by = auth.uid(), scanned_at = now()
    where id = ln.id;
    return jsonb_build_object('ok', true, 'message', format('%s (%s) counted', d.serial_number, d.asset_tag));
  end if;
  insert into stock_count_lines (stock_count_id, device_id, scanned_serial, found_location_id, result, scanned_by, scanned_at)
  values (c.id, d.id, p_serial, p_location_id, 'unexpected', auth.uid(), now());
  return jsonb_build_object('ok', false, 'code', 'unexpected',
    'message', format('%s is not expected here (system status "%s" in another location or warehouse) - recorded as unexpected', p_serial, app_private.label(d.status)));
end $$;

create or replace function public.submit_stock_count(p_count_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.stock_counts; v jsonb;
begin
  perform app_private.require_permission('inventory.count');
  select * into c from stock_counts where id = p_count_id for update;
  if not found then raise exception 'Stock count not found'; end if;
  if c.status <> 'open' then raise exception 'Stock count % is %', c.count_number, c.status; end if;
  update stock_count_lines set result = 'missing' where stock_count_id = c.id and result = 'pending';
  update stock_counts set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
    found_count = (select count(*) from stock_count_lines where stock_count_id = c.id and result in ('found','wrong_location')),
    missing_count = (select count(*) from stock_count_lines where stock_count_id = c.id and result = 'missing'),
    unexpected_count = (select count(*) from stock_count_lines where stock_count_id = c.id and result = 'unexpected')
  where id = c.id;
  select jsonb_build_object('found', found_count, 'missing', missing_count, 'unexpected', unexpected_count, 'expected', expected_count)
    into v from stock_counts where id = c.id;
  perform app_private.audit('submit_stock_count', 'stock_count', c.id::text, null, v);
  perform app_private.notify_permission('inventory.count_approve', 'Stock count submitted: ' || c.count_number,
    format('Missing: %s, unexpected: %s', v ->> 'missing', v ->> 'unexpected'), '/warehouse/counts/' || c.id, 'stock', 'info',
    'stock_count', c.id, c.warehouse_id);
  return v;
end $$;

-- Approval verifies found devices and corrects locations; missing and unexpected
-- devices are raised as discrepancies. Stock is never silently adjusted.
create or replace function public.approve_stock_count(p_count_id uuid, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.stock_counts;
  ln record;
  v_disc int := 0;
begin
  perform app_private.require_permission('inventory.count_approve');
  select * into c from stock_counts where id = p_count_id for update;
  if not found then raise exception 'Stock count not found'; end if;
  perform app_private.require_warehouse_scope(c.warehouse_id);
  if c.status <> 'submitted' then raise exception 'Only submitted stock counts can be approved'; end if;
  if c.started_by = auth.uid() and c.submitted_by = auth.uid() and app_private.setting_bool('workflow.sod_adjustment_requester_cannot_approve', true) then
    raise exception 'Segregation of duties: another authorised user must approve this count' using errcode = '42501';
  end if;
  update devices set last_verified_at = now()
  where id in (select device_id from stock_count_lines where stock_count_id = c.id and result in ('found','wrong_location'));
  for ln in select * from stock_count_lines where stock_count_id = c.id and result = 'wrong_location' loop
    perform app_private.move_device(ln.device_id, null, 'count_location_correction',
      jsonb_build_object('to_location_id', ln.found_location_id, 'reference', c.count_number, 'reason', 'Stock count location correction'));
  end loop;
  for ln in select l.*, d.serial_number from stock_count_lines l left join devices d on d.id = l.device_id
            where l.stock_count_id = c.id and l.result in ('missing','unexpected') loop
    insert into serial_discrepancies (discrepancy_number, context, reason_code, message, expected_device_id, expected_serial,
                                      scanned_serial, scanned_device_id, reported_by)
    values (app_private.next_document_number('discrepancy'), 'stock_count',
      case when ln.result = 'missing' then 'missing_in_count' else 'unexpected_in_count' end,
      case when ln.result = 'missing' then format('Device %s was expected but not found in count %s', ln.serial_number, c.count_number)
           else format('Serial %s was found but not expected in count %s', coalesce(ln.scanned_serial, ln.serial_number), c.count_number) end,
      case when ln.result = 'missing' then ln.device_id end, case when ln.result = 'missing' then ln.serial_number end,
      ln.scanned_serial, null, auth.uid());
    v_disc := v_disc + 1;
  end loop;
  update stock_counts set status = 'approved', approved_by = auth.uid(), approved_at = now(),
    notes = coalesce(notes || E'\n', '') || coalesce(p_comment, '') where id = c.id;
  perform app_private.audit('approve_stock_count', 'stock_count', c.id::text, null,
    jsonb_build_object('discrepancies_raised', v_disc), p_comment);
  return jsonb_build_object('ok', true, 'discrepancies_raised', v_disc);
end $$;
