-- =====================================================================
-- Administration, notifications, dashboard and reporting views
-- =====================================================================

create or replace function public.set_user_roles(p_user_id uuid, p_assignments jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  v_admin uuid := (select id from roles where code = 'administrator');
  v_keeps_admin boolean;
begin
  perform app_private.require_permission('users.manage');
  if not exists (select 1 from profiles where id = p_user_id) then raise exception 'User not found'; end if;
  if jsonb_typeof(p_assignments) <> 'array' then raise exception 'Assignments must be a list'; end if;
  v_keeps_admin := exists (select 1 from jsonb_array_elements(p_assignments) x
                           where (x ->> 'role_id')::uuid = v_admin and nullif(x ->> 'warehouse_id', '') is null and nullif(x ->> 'province_id', '') is null);
  if not v_keeps_admin and exists (select 1 from user_role_assignments where user_id = p_user_id and role_id = v_admin)
     and not exists (select 1 from user_role_assignments a join profiles p on p.id = a.user_id
                     where a.role_id = v_admin and a.user_id <> p_user_id and p.is_active) then
    raise exception 'At least one active administrator must remain';
  end if;
  delete from user_role_assignments where user_id = p_user_id;
  for e in select * from jsonb_array_elements(p_assignments) loop
    if not exists (select 1 from roles where id = (e ->> 'role_id')::uuid and is_active) then raise exception 'Unknown or inactive role'; end if;
    insert into user_role_assignments (user_id, role_id, warehouse_id, province_id, assigned_by)
    values (p_user_id, (e ->> 'role_id')::uuid, nullif(e ->> 'warehouse_id', '')::uuid, nullif(e ->> 'province_id', '')::uuid, auth.uid())
    on conflict do nothing;
  end loop;
  perform app_private.audit('set_user_roles', 'user', p_user_id::text, null, p_assignments);
end $$;

create or replace function public.set_user_permission_overrides(p_user_id uuid, p_overrides jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare e jsonb;
begin
  perform app_private.require_permission('users.manage');
  if p_user_id = auth.uid() then raise exception 'You cannot change your own permission overrides'; end if;
  delete from user_permission_overrides where user_id = p_user_id;
  for e in select * from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) loop
    insert into user_permission_overrides (user_id, permission_code, granted, reason, set_by)
    values (p_user_id, e ->> 'permission_code', (e ->> 'granted')::boolean, nullif(e ->> 'reason', ''), auth.uid());
  end loop;
  perform app_private.audit('set_permission_overrides', 'user', p_user_id::text, null, p_overrides);
end $$;

create or replace function public.set_user_active(p_user_id uuid, p_active boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_permission('users.manage');
  if p_user_id = auth.uid() and not p_active then raise exception 'You cannot deactivate your own account'; end if;
  update profiles set is_active = p_active where id = p_user_id;
  if not found then raise exception 'User not found'; end if;
  perform app_private.audit(case when p_active then 'activate_user' else 'deactivate_user' end, 'user', p_user_id::text, null, null, p_reason);
end $$;

create or replace function public.update_profile(p_user_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user_id <> auth.uid() then perform app_private.require_permission('users.manage'); end if;
  if not public.is_active_user() then raise exception 'Authentication required' using errcode = '28000'; end if;
  update profiles set
    full_name = case when p ? 'full_name' and length(trim(p ->> 'full_name')) > 1 then trim(p ->> 'full_name') else full_name end,
    phone = case when p ? 'phone' then nullif(p ->> 'phone', '') else phone end,
    job_title = case when p ? 'job_title' then nullif(p ->> 'job_title', '') else job_title end,
    default_warehouse_id = case when p ? 'default_warehouse_id' then nullif(p ->> 'default_warehouse_id', '')::uuid else default_warehouse_id end
  where id = p_user_id;
end $$;

create or replace function public.save_role(p_id uuid, p_code text, p_name text, p_description text, p_permissions text[], p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; r public.roles;
begin
  perform app_private.require_permission('roles.manage');
  if p_id is null then
    insert into roles (code, name, description, is_active) values (lower(p_code), p_name, p_description, p_active) returning id into v_id;
  else
    select * into r from roles where id = p_id for update;
    if not found then raise exception 'Role not found'; end if;
    if r.code = 'administrator' then raise exception 'The administrator role cannot be modified'; end if;
    update roles set name = p_name, description = p_description, is_active = p_active where id = p_id;
    v_id := p_id;
  end if;
  delete from role_permissions where role_id = v_id;
  insert into role_permissions (role_id, permission_code)
  select v_id, x from unnest(coalesce(p_permissions, '{}')) x where exists (select 1 from permissions where code = x);
  return v_id;
end $$;

create or replace function public.update_settings(p_values jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb;
begin
  perform app_private.require_permission('settings.manage');
  for k, v in select * from jsonb_each(p_values) loop
    if not exists (select 1 from system_settings where key = k) then raise exception 'Unknown setting %', k; end if;
    if k = 'finance.vat_rate' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100) then
      raise exception 'VAT rate must be between 0 and 100';
    end if;
    if k = 'org.primary_color' and (v #>> '{}') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Primary colour must be a hex value like #1d4ed8'; end if;
    update system_settings set value = v, updated_by = auth.uid(), updated_at = now() where key = k;
  end loop;
end $$;

create or replace function public.update_document_sequence(p_code text, p_prefix text, p_padding int, p_next_value bigint default null) returns void
language plpgsql security definer set search_path = public as $$
declare s public.document_sequences;
begin
  perform app_private.require_permission('settings.manage');
  select * into s from document_sequences where code = p_code for update;
  if not found then raise exception 'Unknown sequence'; end if;
  if p_next_value is not null and p_next_value < s.next_value then
    raise exception 'The next number can only be increased (to avoid duplicate document numbers)';
  end if;
  update document_sequences set prefix = upper(p_prefix), padding = p_padding, next_value = coalesce(p_next_value, next_value), updated_at = now()
  where code = p_code;
end $$;

create or replace function public.get_public_branding() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from system_settings where is_public
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update notifications set is_read = true, read_at = now()
  where user_id = auth.uid() and not is_read and (p_ids is null or id = any(p_ids));
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.touch_last_seen() returns void
language sql security definer set search_path = public as $$
  update profiles set last_seen_at = now() where id = auth.uid() and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')
$$;

-- Time-based notifications. Idempotent through dedupe keys; run by pg_cron hourly.
create or replace function public.run_scheduled_checks() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_n int := 0;
begin
  if auth.uid() is not null then perform app_private.require_permission('settings.manage'); end if;

  for r in select id, wo_number, scheduled_date, assigned_to, warehouse_id from work_orders
           where status in ('scheduled','scheduled_pending_issuing') and scheduled_date between v_today and v_today + 1 loop
    if r.assigned_to is not null then
      perform app_private.notify_user(r.assigned_to, 'Scheduled job approaching: ' || r.wo_number, 'Scheduled for ' || r.scheduled_date,
        '/work-orders/' || r.id, 'scheduling', 'info', 'work_order', r.id, 'sched-' || r.id || '-' || r.scheduled_date);
    else
      perform app_private.notify_permission('work_orders.schedule', 'Scheduled job approaching: ' || r.wo_number, 'Scheduled for ' || r.scheduled_date,
        '/work-orders/' || r.id, 'scheduling', 'info', 'work_order', r.id, r.warehouse_id, null, 'sched-' || r.id || '-' || r.scheduled_date);
    end if;
    v_n := v_n + 1;
  end loop;

  for r in select id, invoice_number, due_date from invoices where status in ('issued','partially_paid') loop
    if r.due_date < v_today then
      perform app_private.notify_permission('invoices.payments', 'Invoice overdue: ' || r.invoice_number, 'Due ' || r.due_date,
        '/invoicing/' || r.id, 'invoice', 'critical', 'invoice', r.id, null, null, 'overdue-' || r.id);
      v_n := v_n + 1;
    elsif r.due_date <= v_today + 3 then
      perform app_private.notify_permission('invoices.payments', 'Invoice due soon: ' || r.invoice_number, 'Due ' || r.due_date,
        '/invoicing/' || r.id, 'invoice', 'warning', 'invoice', r.id, null, null, 'due-' || r.id);
      v_n := v_n + 1;
    end if;
  end loop;

  for r in select id, repair_number from repair_jobs
           where status not in ('closed','cancelled','returned_to_warehouse','returned_to_recipient') and created_at < now() - interval '14 days' loop
    perform app_private.notify_permission('repairs.manage', 'Repair delayed: ' || r.repair_number, 'Open for more than 14 days',
      '/repairs/' || r.id, 'repair', 'warning', 'repair', r.id, null, null, 'repair-delay-' || r.id || '-' || to_char(v_today, 'IYYY-IW'));
    v_n := v_n + 1;
  end loop;

  for r in select id, dispatch_number, origin_warehouse_id from dispatches
           where status = 'dispatched' and expected_delivery_date < v_today loop
    perform app_private.notify_permission('dispatch.view', 'Shipment delayed: ' || r.dispatch_number, 'Expected delivery date has passed',
      '/dispatch/' || r.id, 'dispatch', 'warning', 'dispatch', r.id, r.origin_warehouse_id, null, 'ship-delay-' || r.id);
    v_n := v_n + 1;
  end loop;

  for r in select w.id as wh, w.code, m.id as model, m.model_name, m.low_stock_threshold,
                  count(d.id) filter (where d.status = 'available') as available
           from warehouses w cross join device_models m
           left join devices d on d.warehouse_id = w.id and d.model_id = m.id
           where w.is_active and m.is_active and m.low_stock_threshold > 0
           group by w.id, w.code, m.id, m.model_name, m.low_stock_threshold
           having count(d.id) filter (where d.status = 'available') < m.low_stock_threshold
              and count(d.id) > 0 loop
    perform app_private.notify_permission('inventory.receive', format('Low stock: %s at %s', r.model_name, r.code),
      format('%s available (threshold %s)', r.available, r.low_stock_threshold), '/warehouse', 'stock', 'warning',
      null, null, r.wh, null, 'lowstock-' || r.wh || '-' || r.model || '-' || v_today);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('checked_at', now(), 'notifications_considered', v_n);
end $$;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('deviceflow-scheduled-checks', '5 * * * *', 'select public.run_scheduled_checks()');
exception when others then
  raise notice 'pg_cron is not available; run public.run_scheduled_checks() from an external scheduler';
end $$;

-- =====================================================================
-- Reporting views (security_invoker: underlying RLS always applies)
-- =====================================================================
create or replace view public.v_work_orders with (security_invoker = true) as
select w.*,
  t.name as work_order_type_name, t.code as work_order_type_code,
  i.name as institution_name, i.emis_number, i.town as institution_town, i.phone as institution_phone,
  pv.name as province_name, ds.name as district_name,
  wh.code as warehouse_code, wh.name as warehouse_name,
  cr.full_name as created_by_name, asg.full_name as assigned_to_name,
  rc.full_name as recipient_name,
  coalesce(lines.requested, 0) as total_requested, coalesce(lines.approved, 0) as total_approved,
  lines.category_ids, lines.category_names,
  coalesce(al.allocated, 0) as total_allocated, coalesce(al.issued, 0) as total_issued,
  coalesce(al.dispatched, 0) as total_dispatched, coalesce(al.delivered, 0) as total_delivered,
  inv.invoice_numbers,
  case when not w.invoice_required then 'not_required'
       when coalesce(inv.issued_links, 0) = 0 and coalesce(inv.draft_count, 0) > 0 then 'draft'
       when coalesce(inv.issued_links, 0) = 0 then 'not_invoiced'
       when inv.issued_links < coalesce(lines.approved, 0) then 'partially_invoiced'
       else 'invoiced' end as invoice_status,
  dsp.dispatch_numbers,
  case when coalesce(al.delivered, 0) > 0 and al.delivered >= coalesce(lines.approved, 0) then 'delivered'
       when coalesce(al.delivered, 0) > 0 then 'partially_delivered'
       when coalesce(al.dispatched, 0) > 0 then 'in_transit'
       else 'not_dispatched' end as delivery_status,
  (select count(*) from serial_discrepancies s where s.work_order_id = w.id and s.status = 'open') as open_discrepancies,
  (extract(epoch from (now() - w.created_at)) / 86400)::int as age_days
from work_orders w
join work_order_types t on t.id = w.work_order_type_id
join institutions i on i.id = w.institution_id
join provinces pv on pv.id = w.province_id
join districts ds on ds.id = w.district_id
left join warehouses wh on wh.id = w.warehouse_id
left join profiles cr on cr.id = w.created_by
left join profiles asg on asg.id = w.assigned_to
left join recipients rc on rc.id = w.recipient_id
left join lateral (
  select sum(l.requested_qty)::int as requested, sum(l.approved_qty)::int as approved,
         array_agg(distinct l.category_id) as category_ids, string_agg(distinct c.name, ', ') as category_names
  from work_order_lines l join device_categories c on c.id = l.category_id where l.work_order_id = w.id) lines on true
left join lateral (
  select count(*) filter (where x.status in ('reserved','picked','issued','dispatched','delivered'))::int as allocated,
         count(*) filter (where x.status in ('issued','dispatched','delivered'))::int as issued,
         count(*) filter (where x.status in ('dispatched','delivered'))::int as dispatched,
         count(*) filter (where x.status = 'delivered')::int as delivered
  from work_order_devices x where x.work_order_id = w.id) al on true
left join lateral (
  select string_agg(distinct iv.invoice_number, ', ') as invoice_numbers,
         count(*) filter (where iv.status = 'draft') as draft_count,
         (select count(*) from invoice_device_links k join invoices i2 on i2.id = k.invoice_id
           where i2.work_order_id = w.id and k.status = 'active' and i2.status in ('issued','partially_paid','paid'))::int as issued_links
  from invoices iv where iv.work_order_id = w.id and iv.status <> 'cancelled') inv on true
left join lateral (
  select string_agg(dp.dispatch_number, ', ' order by dp.created_at) as dispatch_numbers
  from dispatches dp where dp.work_order_id = w.id and dp.status <> 'cancelled') dsp on true;

create or replace view public.v_devices with (security_invoker = true) as
select d.*, m.model_name, m.model_code, c.name as category_name, w.code as warehouse_code, w.name as warehouse_name,
  l.code as location_code, i.name as institution_name, i.emis_number, wo.wo_number, s.name as supplier_name,
  exists (select 1 from serial_discrepancies x where x.scanned_device_id = d.id and x.status = 'open') as has_open_discrepancy,
  (select string_agg(di.value, ', ') from device_identifiers di where di.device_id = d.id and di.identifier_type = 'imei') as imei
from devices d
join device_models m on m.id = d.model_id
join device_categories c on c.id = d.category_id
join warehouses w on w.id = d.warehouse_id
left join warehouse_locations l on l.id = d.location_id
left join institutions i on i.id = d.current_institution_id
left join work_orders wo on wo.id = d.current_work_order_id
left join suppliers s on s.id = d.supplier_id;

create or replace view public.v_stock_summary with (security_invoker = true) as
select w.id as warehouse_id, w.code as warehouse_code, w.name as warehouse_name, m.id as model_id,
  m.manufacturer, m.model_name, c.id as category_id, c.name as category_name, m.low_stock_threshold,
  count(*) filter (where d.status = 'available')::int as available,
  count(*) filter (where d.status = 'reserved')::int as reserved,
  count(*) filter (where d.status in ('picked','issued'))::int as picked_issued,
  count(*) filter (where d.status in ('faulty','under_assessment','under_repair','awaiting_parts','repair_completed'))::int as in_repair,
  count(*) filter (where d.status in ('quarantined','returned_to_warehouse','received'))::int as quarantine,
  count(*) filter (where d.status = 'in_transit')::int as in_transit,
  count(*) filter (where d.status in ('received','available','reserved','picked','issued','faulty','under_assessment','under_repair',
                                      'awaiting_parts','repair_completed','returned_to_warehouse','quarantined'))::int as on_hand,
  (count(*) filter (where d.status = 'available') < m.low_stock_threshold) as is_low_stock
from devices d
join warehouses w on w.id = d.warehouse_id
join device_models m on m.id = d.model_id
join device_categories c on c.id = m.category_id
group by w.id, w.code, w.name, m.id, m.manufacturer, m.model_name, c.id, c.name, m.low_stock_threshold;

create or replace view public.v_device_movements with (security_invoker = true) as
select mv.*, d.serial_number, d.asset_tag, m.model_name, fw.code as from_warehouse_code, tw.code as to_warehouse_code,
  fl.code as from_location_code, tl.code as to_location_code, wo.wo_number, dp.dispatch_number,
  i.name as institution_name, p.full_name as performed_by_name
from device_movements mv
join devices d on d.id = mv.device_id
join device_models m on m.id = d.model_id
left join warehouses fw on fw.id = mv.from_warehouse_id
left join warehouses tw on tw.id = mv.to_warehouse_id
left join warehouse_locations fl on fl.id = mv.from_location_id
left join warehouse_locations tl on tl.id = mv.to_location_id
left join work_orders wo on wo.id = mv.work_order_id
left join dispatches dp on dp.id = mv.dispatch_id
left join institutions i on i.id = mv.institution_id
left join profiles p on p.id = mv.performed_by;

create or replace view public.v_invoices with (security_invoker = true) as
select iv.*, wo.wo_number, ins.name as institution_name, pv.name as province_name,
  (iv.total_cents - iv.amount_paid_cents - iv.credited_cents) as balance_cents,
  (iv.status in ('issued','partially_paid') and iv.due_date < (now() at time zone 'Africa/Johannesburg')::date) as is_overdue,
  greatest(0, ((now() at time zone 'Africa/Johannesburg')::date - iv.due_date)) as days_overdue,
  case when iv.status in ('issued','partially_paid') and iv.due_date < (now() at time zone 'Africa/Johannesburg')::date then 'overdue'
       else iv.status end as display_status,
  cr.full_name as created_by_name, isr.full_name as issued_by_name,
  (select coalesce(sum(quantity), 0) from invoice_lines l where l.invoice_id = iv.id and l.line_type = 'device')::int as device_quantity
from invoices iv
left join work_orders wo on wo.id = iv.work_order_id
left join institutions ins on ins.id = iv.institution_id
left join provinces pv on pv.id = ins.province_id
left join profiles cr on cr.id = iv.created_by
left join profiles isr on isr.id = iv.issued_by;

create or replace view public.v_dispatches with (security_invoker = true) as
select dp.*, wo.wo_number, wo.invoice_required, i.name as institution_name, i.emis_number, w.code as warehouse_code,
  pr.full_name as dispatched_by_name,
  (select count(*) from dispatch_devices dd where dd.dispatch_id = dp.id and dd.status not in ('removed'))::int as device_count,
  (select count(*) from dispatch_devices dd where dd.dispatch_id = dp.id and dd.status = 'delivered')::int as delivered_count,
  dc.outcome as delivery_outcome, dc.delivery_number, dc.id as delivery_id
from dispatches dp
join work_orders wo on wo.id = dp.work_order_id
join institutions i on i.id = dp.institution_id
join warehouses w on w.id = dp.origin_warehouse_id
left join profiles pr on pr.id = dp.dispatched_by
left join delivery_confirmations dc on dc.dispatch_id = dp.id;

create or replace view public.v_deliveries with (security_invoker = true) as
select dc.*, dp.dispatch_number, wo.wo_number, i.name as institution_name, i.emis_number, pr.full_name as recorded_by_name,
  (dc.quantity_expected - dc.quantity_received) as quantity_outstanding
from delivery_confirmations dc
join dispatches dp on dp.id = dc.dispatch_id
join work_orders wo on wo.id = dc.work_order_id
join institutions i on i.id = dc.institution_id
left join profiles pr on pr.id = dc.recorded_by;

create or replace view public.v_assessments with (security_invoker = true) as
select a.*, d.serial_number, d.asset_tag, d.status as device_status, m.model_name, m.manufacturer, wo.wo_number,
  i.name as institution_name, t.full_name as technician_name
from device_assessments a
join devices d on d.id = a.device_id
join device_models m on m.id = d.model_id
left join work_orders wo on wo.id = a.work_order_id
left join institutions i on i.id = a.institution_id
left join profiles t on t.id = a.technician_id;

create or replace view public.v_repairs with (security_invoker = true) as
select r.*, d.serial_number, d.asset_tag, d.status as device_status, m.model_name, m.manufacturer, wo.wo_number,
  t.full_name as technician_name, a.assessment_number,
  coalesce((select sum(quantity * unit_cost_cents) from repair_parts p where p.repair_job_id = r.id), 0)::bigint as parts_cost_cents,
  (r.labour_cost_cents + coalesce((select sum(quantity * unit_cost_cents) from repair_parts p where p.repair_job_id = r.id), 0))::bigint as total_cost_cents,
  round(extract(epoch from (coalesce(r.completed_at, now()) - r.created_at)) / 86400.0, 1) as turnaround_days
from repair_jobs r
join devices d on d.id = r.device_id
join device_models m on m.id = d.model_id
left join work_orders wo on wo.id = r.work_order_id
left join profiles t on t.id = r.technician_id
left join device_assessments a on a.id = r.assessment_id;

create or replace view public.v_returns with (security_invoker = true) as
select rt.*, wo.wo_number, dp.dispatch_number, i.name as institution_name, w.code as warehouse_code,
  (select count(*) from return_lines l where l.return_id = rt.id)::int as received_count,
  (select count(*) from return_lines l where l.return_id = rt.id and l.inspection_outcome is null)::int as pending_inspection
from returns rt
left join work_orders wo on wo.id = rt.original_work_order_id
left join dispatches dp on dp.id = rt.original_dispatch_id
left join institutions i on i.id = rt.institution_id
join warehouses w on w.id = rt.receiving_warehouse_id;

create or replace view public.v_discrepancies with (security_invoker = true) as
select s.*, wo.wo_number, dp.dispatch_number, rp.full_name as reported_by_name, rs.full_name as resolved_by_name,
  sd.asset_tag as scanned_asset_tag, ed.asset_tag as expected_asset_tag
from serial_discrepancies s
left join work_orders wo on wo.id = s.work_order_id
left join dispatches dp on dp.id = s.dispatch_id
left join profiles rp on rp.id = s.reported_by
left join profiles rs on rs.id = s.resolved_by
left join devices sd on sd.id = s.scanned_device_id
left join devices ed on ed.id = s.expected_device_id;

create or replace view public.v_stock_movements with (security_invoker = true) as
select m.*, fw.code as from_warehouse_code, tw.code as to_warehouse_code, rq.full_name as requested_by_name,
  ap.full_name as approved_by_name,
  (select count(*) from stock_movement_lines l where l.stock_movement_id = m.id)::int as device_count,
  (select string_agg(coalesce(d.serial_number, d.asset_tag), ', ') from stock_movement_lines l join devices d on d.id = l.device_id
    where l.stock_movement_id = m.id) as serials
from stock_movements m
left join warehouses fw on fw.id = m.from_warehouse_id
left join warehouses tw on tw.id = m.to_warehouse_id
left join profiles rq on rq.id = m.requested_by
left join profiles ap on ap.id = m.approved_by;

create or replace view public.v_stock_counts with (security_invoker = true) as
select c.*, w.code as warehouse_code, w.name as warehouse_name, l.code as location_code, p.full_name as started_by_name
from stock_counts c join warehouses w on w.id = c.warehouse_id
left join warehouse_locations l on l.id = c.location_id
left join profiles p on p.id = c.started_by;

create or replace view public.v_goods_receipts with (security_invoker = true) as
select g.*, w.code as warehouse_code, s.name as supplier_name, p.full_name as received_by_name,
  (select coalesce(sum(expected_qty), 0) from goods_receipt_lines l where l.goods_receipt_id = g.id)::int as expected_qty,
  (select count(*) from devices d where d.goods_receipt_id = g.id)::int as received_qty
from goods_receipts g join warehouses w on w.id = g.warehouse_id
left join suppliers s on s.id = g.supplier_id
left join profiles p on p.id = g.received_by;

create or replace view public.v_approval_turnaround with (security_invoker = true) as
select w.id as work_order_id, w.wo_number, w.status, i.name as institution_name, w.submitted_at, w.approved_at,
  ap.full_name as approved_by_name,
  round(extract(epoch from (coalesce(w.approved_at, now()) - w.submitted_at)) / 3600.0, 1) as hours_to_decision
from work_orders w join institutions i on i.id = w.institution_id
left join profiles ap on ap.id = w.approved_by
where w.submitted_at is not null;

create or replace view public.v_user_activity with (security_invoker = true) as
select a.user_id, a.user_email, (a.occurred_at at time zone 'Africa/Johannesburg')::date as activity_date,
  count(*)::int as actions, count(*) filter (where not a.success)::int as failed_actions,
  string_agg(distinct a.action, ', ') as action_types
from audit_logs a where a.user_id is not null
group by a.user_id, a.user_email, (a.occurred_at at time zone 'Africa/Johannesburg')::date;

create or replace view public.v_fault_trends with (security_invoker = true) as
select date_trunc('month', a.reported_at)::date as month, m.manufacturer, m.model_name, coalesce(a.outcome, 'pending') as outcome,
  count(*)::int as assessments
from device_assessments a join devices d on d.id = a.device_id join device_models m on m.id = d.model_id
group by 1, 2, 3, 4;

create or replace view public.v_users with (security_invoker = true) as
select p.*,
  (select string_agg(r.name || coalesce(' @' || w.code, '') || coalesce(' @' || pv.name, ''), ', ' order by r.name)
     from user_role_assignments a join roles r on r.id = a.role_id
     left join warehouses w on w.id = a.warehouse_id left join provinces pv on pv.id = a.province_id
     where a.user_id = p.id) as roles_summary
from profiles p;

-- =====================================================================
-- Dashboard (security invoker: counts respect the caller's RLS scope)
-- =====================================================================
create or replace function public.dashboard_summary() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'work_orders', (select jsonb_build_object(
        'total', count(*),
        'pending_authorisation', count(*) filter (where status = 'pending_authorisation'),
        'pending_scheduling', count(*) filter (where status = 'pending_scheduling'),
        'scheduled', count(*) filter (where status = 'scheduled'),
        'pending_issuing', count(*) filter (where status in ('scheduled_pending_issuing','issuing_in_progress')),
        'issued', count(*) filter (where status in ('issued','pending_invoicing','invoiced')),
        'pending_dispatch', count(*) filter (where status = 'ready_for_dispatch'),
        'dispatched', count(*) filter (where status in ('partially_dispatched','dispatched','partially_delivered')),
        'completed', count(*) filter (where status in ('delivered','completed')),
        'overdue_schedule', count(*) filter (where status in ('scheduled','scheduled_pending_issuing','issuing_in_progress')
                                               and scheduled_date < (now() at time zone 'Africa/Johannesburg')::date))
      from work_orders where status <> 'cancelled'),
    'devices', (select jsonb_build_object(
        'total', count(*),
        'available', count(*) filter (where status = 'available'),
        'reserved', count(*) filter (where status in ('reserved','picked')),
        'in_repair', count(*) filter (where status in ('under_repair','awaiting_parts','repair_completed')),
        'awaiting_assessment', count(*) filter (where status in ('faulty','under_assessment')))
      from devices),
    'invoices', (select jsonb_build_object(
        'outstanding_count', count(*) filter (where status in ('issued','partially_paid')),
        'outstanding_cents', coalesce(sum(total_cents - amount_paid_cents - credited_cents) filter (where status in ('issued','partially_paid')), 0),
        'overdue_count', count(*) filter (where status in ('issued','partially_paid') and due_date < (now() at time zone 'Africa/Johannesburg')::date),
        'overdue_cents', coalesce(sum(total_cents - amount_paid_cents - credited_cents)
                                   filter (where status in ('issued','partially_paid') and due_date < (now() at time zone 'Africa/Johannesburg')::date), 0),
        'drafts', count(*) filter (where status = 'draft'))
      from invoices),
    'deliveries_pending', (select count(*) from dispatches where status = 'dispatched'),
    'open_discrepancies', (select count(*) from serial_discrepancies where status = 'open'),
    'wo_by_status', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', c) order by c desc), '[]')
                     from (select status, count(*) c from work_orders group by status) x),
    'wo_by_province', (select coalesce(jsonb_agg(jsonb_build_object('province', p.name, 'count', x.c) order by x.c desc), '[]')
                       from (select province_id, count(*) c from work_orders where status <> 'cancelled' group by province_id) x
                       join provinces p on p.id = x.province_id),
    'devices_by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', c.name, 'condition', x.condition, 'count', x.n)), '[]')
                            from (select category_id, condition, count(*) n from devices group by category_id, condition) x
                            join device_categories c on c.id = x.category_id),
    'stock_by_warehouse', (select coalesce(jsonb_agg(jsonb_build_object('warehouse', w.code, 'available', x.a, 'reserved', x.r, 'repair', x.f) order by w.code), '[]')
                           from (select warehouse_id,
                                        count(*) filter (where status = 'available') a,
                                        count(*) filter (where status in ('reserved','picked','issued')) r,
                                        count(*) filter (where status in ('faulty','under_assessment','under_repair','awaiting_parts','quarantined','returned_to_warehouse','repair_completed')) f
                                 from devices group by warehouse_id) x join warehouses w on w.id = x.warehouse_id),
    'allocations_by_institution', (select coalesce(jsonb_agg(jsonb_build_object('institution', i.name, 'count', x.c) order by x.c desc), '[]')
                                   from (select current_institution_id, count(*) c from devices
                                         where current_institution_id is not null and status in ('issued','dispatched','delivered')
                                         group by current_institution_id order by count(*) desc limit 10) x
                                   join institutions i on i.id = x.current_institution_id),
    'repairs_by_status', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', c)), '[]')
                          from (select status, count(*) c from repair_jobs group by status) x),
    'monthly_dispatch', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'dispatches', x.c, 'devices', x.n) order by m), '[]')
                         from (select date_trunc('month', dp.dispatched_at) m, count(distinct dp.id) c, count(dd.id) n
                               from dispatches dp left join dispatch_devices dd on dd.dispatch_id = dp.id and dd.status <> 'removed'
                               where dp.dispatched_at > now() - interval '12 months' group by 1) x),
    'invoice_totals', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'invoiced_cents', x.t, 'outstanding_cents', x.o) order by m), '[]')
                       from (select date_trunc('month', invoice_date) m, sum(total_cents) t,
                                    sum(total_cents - amount_paid_cents - credited_cents) o
                             from invoices where status not in ('draft','cancelled') and invoice_date > now() - interval '12 months' group by 1) x),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('warehouse', warehouse_code, 'model', manufacturer || ' ' || model_name,
                                                               'available', available, 'threshold', low_stock_threshold)), '[]')
                  from v_stock_summary where is_low_stock),
    'overdue_tasks', (select coalesce(jsonb_agg(x), '[]') from (
                        select jsonb_build_object('type', 'work_order', 'id', id, 'reference', wo_number, 'status', status,
                                                  'due', scheduled_date) x
                        from work_orders where status in ('scheduled','scheduled_pending_issuing','issuing_in_progress')
                          and scheduled_date < (now() at time zone 'Africa/Johannesburg')::date
                        union all
                        select jsonb_build_object('type', 'invoice', 'id', id, 'reference', invoice_number, 'status', 'overdue', 'due', due_date)
                        from invoices where status in ('issued','partially_paid') and due_date < (now() at time zone 'Africa/Johannesburg')::date
                        union all
                        select jsonb_build_object('type', 'dispatch', 'id', id, 'reference', dispatch_number, 'status', 'delayed', 'due', expected_delivery_date)
                        from dispatches where status = 'dispatched' and expected_delivery_date < (now() at time zone 'Africa/Johannesburg')::date
                        limit 20) t)
  )
$$;
