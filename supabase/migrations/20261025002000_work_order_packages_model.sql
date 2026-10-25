-- Work order packages: a package is one recipient's kit on a work order (e.g. a
-- learner's tablet + SIM). Packages exist from the time the work order is prepared;
-- allocated devices are later linked to a package. Replaces the per-device
-- recipient introduced in migration 1900. Also adds an optional Work Order Name.

alter table public.work_orders
  add column work_order_name text check (work_order_name is null or length(work_order_name) <= 200);

-- Package numbers are purely numeric, so a sequence may have an empty prefix.
alter table public.document_sequences drop constraint document_sequences_prefix_check;
alter table public.document_sequences add constraint document_sequences_prefix_check check (prefix ~ '^[A-Z]{0,6}$');
insert into public.document_sequences (code, prefix, include_year, padding, separator, description)
values ('package', '', false, 9, '', 'Work order packages')
on conflict (code) do nothing;

create table public.work_order_packages (
  id uuid primary key default gen_random_uuid(),
  package_number text not null unique,
  work_order_id uuid not null references public.work_orders(id),
  recipient_id uuid references public.recipients(id),
  grade text,
  class_name text,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index work_order_packages_wo_idx on public.work_order_packages (work_order_id, status);
create unique index work_order_packages_recipient_uniq on public.work_order_packages (work_order_id, recipient_id)
  where status = 'active' and recipient_id is not null;

alter table public.work_order_packages enable row level security;
grant select on public.work_order_packages to authenticated;
create policy work_order_packages_read on public.work_order_packages for select to authenticated
  using (exists (select 1 from public.work_orders w where w.id = work_order_id));

alter table public.work_order_devices add column package_id uuid references public.work_order_packages(id);
create index work_order_devices_package_idx on public.work_order_devices (package_id) where package_id is not null;

-- Carry over any per-device recipients recorded since migration 1900.
do $$
declare a record; v_pkg uuid;
begin
  for a in select x.id, x.work_order_id, x.recipient_id, x.created_at from public.work_order_devices x where x.recipient_id is not null loop
    select id into v_pkg from public.work_order_packages
      where work_order_id = a.work_order_id and recipient_id = a.recipient_id and status = 'active';
    if v_pkg is null then
      insert into public.work_order_packages (package_number, work_order_id, recipient_id, created_at)
      values (app_private.next_document_number('package'), a.work_order_id, a.recipient_id, a.created_at)
      returning id into v_pkg;
    end if;
    update public.work_order_devices set package_id = v_pkg where id = a.id;
  end loop;
end $$;

drop view if exists public.v_work_order_packages;
drop view if exists public.v_work_order_allocations;
drop function if exists public.assign_allocation_recipient(uuid, uuid);
alter table public.work_order_devices drop column recipient_id;

-- save_work_order now also stores work_order_name (otherwise unchanged).
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
      warehouse_id, invoice_required, invoice_exempt_reason, source_reference, imported_at, created_by, device_to_use, purpose, work_order_name)
    values (app_private.next_document_number('work_order'), v_type.id, coalesce(p_header ->> 'priority', 'normal'),
      v_inst.province_id, v_inst.district_id, v_inst.id,
      p_header ->> 'recipient_type', v_recipient.id, nullif(p_header ->> 'recipient_group', ''),
      nullif(p_header ->> 'grade', ''), nullif(p_header ->> 'class_name', ''),
      nullif(p_header ->> 'description', ''), nullif(p_header ->> 'instructions', ''), nullif(p_header ->> 'internal_notes', ''),
      v_warehouse, v_type.requires_invoice,
      case when v_type.requires_invoice then null else format('Work order type "%s" is configured as invoice-exempt', v_type.name) end,
      nullif(p_header ->> 'source_reference', ''), nullif(p_header ->> 'imported_at', '')::timestamptz, auth.uid(),
      coalesce(nullif(p_header ->> 'device_to_use', ''), 'new_deployment'), coalesce(nullif(p_header ->> 'purpose', ''), 'normal'), nullif(trim(p_header ->> 'work_order_name'), ''))
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
      work_order_name = nullif(trim(p_header ->> 'work_order_name'), ''),
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

create or replace function app_private.require_package_editor(w public.work_orders) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_permission('recipients.manage') or public.has_permission('work_orders.create')) then
    raise exception 'Permission denied: work order or recipient permission is required' using errcode = '42501';
  end if;
  if w.status in ('dispatched', 'partially_delivered', 'delivered', 'completed', 'cancelled') then
    raise exception 'Packages cannot be changed once a work order is "%"', app_private.label(w.status);
  end if;
end $$;

-- Add packages: one per named recipient, plus any number of unnamed packages for a grade/class.
create or replace function public.add_work_order_packages(p_work_order_id uuid, p_recipient_ids uuid[] default '{}',
  p_unnamed_count int default 0, p_grade text default null, p_class_name text default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  w public.work_orders;
  r public.recipients;
  v_id uuid;
  v_count int := 0;
begin
  select * into w from work_orders where id = p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  perform app_private.require_package_editor(w);
  if coalesce(p_unnamed_count, 0) < 0 or coalesce(p_unnamed_count, 0) > 5000 then
    raise exception 'Unnamed packages must be between 0 and 5000';
  end if;
  foreach v_id in array coalesce(p_recipient_ids, '{}') loop
    select * into r from recipients where id = v_id;
    if not found or r.institution_id <> w.institution_id then
      raise exception 'A selected recipient does not belong to this work order''s institution';
    end if;
    if not r.is_active then raise exception 'Recipient % is inactive', r.full_name; end if;
    -- Learner personal information is restricted (POPIA)
    if r.recipient_type = 'learner' and not public.has_permission('recipients.view_learners') then
      raise exception 'Permission denied: learner records require "recipients.view_learners"' using errcode = '42501';
    end if;
    if exists (select 1 from work_order_packages where work_order_id = w.id and recipient_id = r.id and status = 'active') then
      raise exception '% already has a package on this work order', r.full_name;
    end if;
    insert into work_order_packages (package_number, work_order_id, recipient_id, created_by)
    values (app_private.next_document_number('package'), w.id, r.id, auth.uid());
    v_count := v_count + 1;
  end loop;
  for i in 1 .. coalesce(p_unnamed_count, 0) loop
    insert into work_order_packages (package_number, work_order_id, grade, class_name, created_by)
    values (app_private.next_document_number('package'), w.id, nullif(trim(p_grade), ''), nullif(trim(p_class_name), ''), auth.uid());
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'Select recipients or enter a number of packages to add'; end if;
  perform app_private.audit('add_packages', 'work_order', w.id::text, null,
    jsonb_build_object('packages', v_count, 'named', coalesce(cardinality(p_recipient_ids), 0)), null, jsonb_build_object('work_order_id', w.id));
  return v_count;
end $$;

-- Cancel a package that has no device linked to it. Nothing is deleted.
create or replace function public.cancel_work_order_package(p_package_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.work_order_packages;
  w public.work_orders;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required'; end if;
  select * into p from work_order_packages where id = p_package_id for update;
  if not found then raise exception 'Package not found'; end if;
  if p.status <> 'active' then raise exception 'Package % is already cancelled', p.package_number; end if;
  select * into w from work_orders where id = p.work_order_id for update;
  perform app_private.require_package_editor(w);
  if exists (select 1 from work_order_devices where package_id = p.id and status in ('reserved','picked','issued','dispatched','delivered')) then
    raise exception 'Package % has a device linked to it. Unlink the device first.', p.package_number;
  end if;
  update work_order_packages set status = 'cancelled', cancelled_reason = p_reason where id = p.id;
  perform app_private.audit('cancel_package', 'work_order', w.id::text, jsonb_build_object('package', p.package_number), null, p_reason,
    jsonb_build_object('work_order_id', w.id));
end $$;

-- Link an allocated device to one of the work order's packages (or unlink with null).
create or replace function public.assign_allocation_package(p_allocation_id uuid, p_package_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  a public.work_order_devices;
  w public.work_orders;
begin
  if not (public.has_permission('recipients.manage') or public.has_permission('issuing.pick')) then
    raise exception 'Permission denied: recipient or issuing permission is required' using errcode = '42501';
  end if;
  select * into a from work_order_devices where id = p_allocation_id for update;
  if not found then raise exception 'Allocation not found'; end if;
  if a.status not in ('reserved','picked','issued','dispatched','delivered') then
    raise exception 'Only active allocations can be linked to a package';
  end if;
  select * into w from work_orders where id = a.work_order_id;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if p_package_id is not null and not exists
     (select 1 from work_order_packages where id = p_package_id and work_order_id = w.id and status = 'active') then
    raise exception 'The package is not an active package on this work order';
  end if;
  update work_order_devices set package_id = p_package_id where id = a.id;
  perform app_private.audit('link_package', 'work_order_device', a.id::text, jsonb_build_object('package_id', a.package_id),
    jsonb_build_object('package_id', p_package_id), null, jsonb_build_object('work_order_id', w.id, 'device_id', a.device_id));
end $$;

revoke execute on function public.add_work_order_packages(uuid, uuid[], int, text, text) from public, anon;
revoke execute on function public.cancel_work_order_package(uuid, text) from public, anon;
revoke execute on function public.assign_allocation_package(uuid, uuid) from public, anon;
grant execute on function public.add_work_order_packages(uuid, uuid[], int, text, text) to authenticated, service_role;
grant execute on function public.cancel_work_order_package(uuid, text) to authenticated, service_role;
grant execute on function public.assign_allocation_package(uuid, uuid) to authenticated, service_role;

-- Packages list. Recipient details come through RLS on recipients, so learner names
-- stay hidden from users without recipients.view_learners.
create view public.v_work_order_packages with (security_invoker = true) as
select p.id, p.work_order_id, p.package_number as package_id, p.recipient_id, p.created_at,
  r.full_name as recipient_name,
  coalesce(r.grade, p.grade) as grade,
  coalesce(r.class_name, p.class_name) as classroom,
  (select string_agg(coalesce(d.serial_number, d.asset_tag), ', ' order by d.serial_number)
     from public.work_order_devices a join public.devices d on d.id = a.device_id
    where a.package_id = p.id and a.status in ('reserved','picked','issued','dispatched','delivered')) as device_serials
from public.work_order_packages p
left join public.recipients r on r.id = p.recipient_id
where p.status = 'active';

grant select on public.v_work_order_packages to authenticated;
revoke all on public.v_work_order_packages from anon;

create view public.v_work_order_allocations with (security_invoker = true) as
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
  od.asset_tag as previous_asset_tag, om.model_name as previous_device_name,
  a.package_id, pk.package_number, rc.full_name as recipient_name
from public.work_order_devices a
join public.devices d on d.id = a.device_id
join public.device_models m on m.id = d.model_id
join public.device_categories c on c.id = d.category_id
left join public.warehouse_locations loc on loc.id = d.location_id
left join public.suppliers s on s.id = d.supplier_id
left join public.replacement_transactions rt on rt.new_allocation_id = a.id
left join public.devices od on od.id = rt.original_device_id
left join public.device_models om on om.id = od.model_id
left join public.work_order_packages pk on pk.id = a.package_id
left join public.recipients rc on rc.id = pk.recipient_id
where a.status in ('reserved','picked','issued','dispatched','delivered');

grant select on public.v_work_order_allocations to authenticated;
revoke all on public.v_work_order_allocations from anon;
