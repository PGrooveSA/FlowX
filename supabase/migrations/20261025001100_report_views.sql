-- Additional report views (security_invoker: caller's RLS applies)

create or replace view public.v_allocations with (security_invoker = true) as
select x.id, x.status as allocation_status, x.created_at, x.reserved_at, x.picked_at, x.issued_at, x.dispatched_at, x.delivered_at, x.release_reason,
  w.id as work_order_id, w.wo_number, w.status as work_order_status, w.warehouse_id, w.province_id, i.name as institution_name, i.emis_number,
  d.id as device_id, d.serial_number, d.asset_tag, m.manufacturer, m.model_name, c.name as category_name, wh.code as warehouse_code
from work_order_devices x
join work_orders w on w.id = x.work_order_id
join institutions i on i.id = w.institution_id
join devices d on d.id = x.device_id
join device_models m on m.id = d.model_id
join device_categories c on c.id = d.category_id
left join warehouses wh on wh.id = w.warehouse_id;

create or replace view public.v_stock_variance with (security_invoker = true) as
select l.id, sc.count_number, sc.status as count_status, sc.warehouse_id, w.code as warehouse_code, sc.started_at, sc.approved_at,
  l.result, coalesce(d.serial_number, l.scanned_serial) as serial_number, d.asset_tag, d.status as system_status,
  el.code as expected_location, fl.code as found_location, l.scanned_at
from stock_count_lines l
join stock_counts sc on sc.id = l.stock_count_id
join warehouses w on w.id = sc.warehouse_id
left join devices d on d.id = l.device_id
left join warehouse_locations el on el.id = l.expected_location_id
left join warehouse_locations fl on fl.id = l.found_location_id
where l.result in ('missing','unexpected','wrong_location');

create or replace view public.v_replacements with (security_invoker = true) as
select r.id, r.replacement_number, r.created_at, r.reason, r.original_device_new_status, w.wo_number, w.id as work_order_id,
  od.serial_number as original_serial, od.warranty_expires_on as original_warranty_expires_on,
  (od.warranty_expires_on >= r.created_at::date) as original_in_warranty,
  nd.serial_number as replacement_serial, m.model_name, p.full_name as authorised_by_name
from replacement_transactions r
join work_orders w on w.id = r.work_order_id
join devices od on od.id = r.original_device_id
join devices nd on nd.id = r.replacement_device_id
join device_models m on m.id = od.model_id
left join profiles p on p.id = r.authorised_by;

create or replace view public.v_wo_ageing with (security_invoker = true) as
select v.id, v.wo_number, v.status, v.institution_name, v.emis_number, v.province_id, v.province_name, v.warehouse_id, v.warehouse_code,
  v.created_at, v.age_days, v.total_approved, v.total_delivered,
  case when v.age_days <= 7 then '0-7 days' when v.age_days <= 30 then '8-30 days' when v.age_days <= 60 then '31-60 days'
       when v.age_days <= 90 then '61-90 days' else '90+ days' end as age_bucket
from v_work_orders v
where v.status not in ('completed','cancelled');

grant select on public.v_allocations, public.v_stock_variance, public.v_replacements, public.v_wo_ageing to authenticated;
revoke all on public.v_allocations, public.v_stock_variance, public.v_replacements, public.v_wo_ageing from anon;
