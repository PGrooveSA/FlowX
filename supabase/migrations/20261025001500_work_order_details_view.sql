-- Work Order Details screen: purpose and device-to-use on work orders, boxing of
-- scanned devices, and the per-device allocation grid.

alter table public.work_orders
  add column device_to_use text not null default 'new_deployment'
    check (device_to_use in ('new_deployment','refurbished','existing_device','replacement_stock')),
  add column purpose text not null default 'normal'
    check (purpose in ('normal','urgent','replacement','special_project'));

alter table public.work_order_devices
  add column box_number text check (box_number is null or length(trim(box_number)) between 1 and 40),
  add column boxed_at timestamptz,
  add column boxed_by uuid references public.profiles(id);

-- save_work_order now also stores device_to_use and purpose (otherwise unchanged).
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
  if coalesce(p_header ->> 'device_to_use', 'new_deployment') not in ('new_deployment','refurbished','existing_device','replacement_stock') then
    raise exception 'Invalid device to use';
  end if;
  if coalesce(p_header ->> 'purpose', 'normal') not in ('normal','urgent','replacement','special_project') then
    raise exception 'Invalid purpose of work order';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A work order needs at least one device line';
  end if;

  if p_id is null then
    insert into work_orders (wo_number, work_order_type_id, priority, province_id, district_id, institution_id,
      recipient_type, recipient_id, recipient_group, grade, class_name, description, instructions, internal_notes,
      warehouse_id, invoice_required, invoice_exempt_reason, source_reference, imported_at, created_by, device_to_use, purpose)
    values (app_private.next_document_number('work_order'), v_type.id, coalesce(p_header ->> 'priority', 'normal'),
      v_inst.province_id, v_inst.district_id, v_inst.id,
      p_header ->> 'recipient_type', v_recipient.id, nullif(p_header ->> 'recipient_group', ''),
      nullif(p_header ->> 'grade', ''), nullif(p_header ->> 'class_name', ''),
      nullif(p_header ->> 'description', ''), nullif(p_header ->> 'instructions', ''), nullif(p_header ->> 'internal_notes', ''),
      v_warehouse, v_type.requires_invoice,
      case when v_type.requires_invoice then null else format('Work order type "%s" is configured as invoice-exempt', v_type.name) end,
      nullif(p_header ->> 'source_reference', ''), nullif(p_header ->> 'imported_at', '')::timestamptz, auth.uid(),
      coalesce(nullif(p_header ->> 'device_to_use', ''), 'new_deployment'), coalesce(nullif(p_header ->> 'purpose', ''), 'normal'))
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
      device_to_use = coalesce(nullif(p_header ->> 'device_to_use', ''), 'new_deployment'),
      purpose = coalesce(nullif(p_header ->> 'purpose', ''), 'normal'),
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

-- Box scanned devices (or clear their box with a null box number). Only devices that
-- were verified by a serial scan and have not left the warehouse can be boxed.
create or replace function public.assign_box(p_work_order_id uuid, p_allocation_ids uuid[], p_box_number text)
returns int
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  v_box text := nullif(trim(p_box_number), '');
  v_count int;
begin
  perform app_private.require_permission('issuing.pick');
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if coalesce(cardinality(p_allocation_ids), 0) = 0 then raise exception 'Select the devices to box'; end if;
  if v_box is not null and length(v_box) > 40 then raise exception 'Box number is too long'; end if;
  if exists (select 1 from work_order_devices where id = any(p_allocation_ids)
             and (work_order_id <> w.id or status not in ('picked','issued'))) then
    raise exception 'Only scanned devices that are still in the warehouse on this work order can be boxed';
  end if;
  update work_order_devices set box_number = v_box, boxed_at = case when v_box is null then null else now() end,
    boxed_by = case when v_box is null then null else auth.uid() end
  where id = any(p_allocation_ids);
  get diagnostics v_count = row_count;
  perform app_private.audit(case when v_box is null then 'clear_box' else 'assign_box' end, 'work_order', w.id::text, null,
    jsonb_build_object('box_number', v_box, 'devices', v_count), null, jsonb_build_object('work_order_id', w.id));
  return v_count;
end $$;

revoke execute on function public.assign_box(uuid, uuid[], text) from public, anon;
grant execute on function public.assign_box(uuid, uuid[], text) to authenticated, service_role;

-- One row per device allocated to a work order (active allocations and replaced ones).
create or replace view public.v_work_order_allocations with (security_invoker = true) as
select a.id, a.work_order_id, a.device_id, a.status as allocation_status, a.box_number, a.boxed_at,
  dense_rank() over (partition by a.work_order_id order by (a.reserved_at at time zone 'Africa/Johannesburg')::date) as shift_number,
  a.reserved_at, a.picked_at, a.issued_at,
  (a.picked_at is not null) as scanned,
  case when a.box_number is not null then 'boxed'
       when a.picked_at is null then 'not_scanned'
       when a.status in ('picked','issued') then 'pending_boxing'
       else 'scanned' end as scan_status,
  loc.code as location_code, d.serial_number, d.asset_tag, c.name as device_type, m.model_name as device_name,
  m.manufacturer, s.name as service_provider, d.status as current_phase,
  od.asset_tag as previous_asset_tag, om.model_name as previous_device_name
from public.work_order_devices a
join public.devices d on d.id = a.device_id
join public.device_models m on m.id = d.model_id
join public.device_categories c on c.id = d.category_id
left join public.warehouse_locations loc on loc.id = d.location_id
left join public.suppliers s on s.id = d.supplier_id
left join public.replacement_transactions rt on rt.new_allocation_id = a.id
left join public.devices od on od.id = rt.original_device_id
left join public.device_models om on om.id = od.model_id
where a.status in ('reserved','picked','issued','dispatched','delivered');

grant select on public.v_work_order_allocations to authenticated;
revoke all on public.v_work_order_allocations from anon;
