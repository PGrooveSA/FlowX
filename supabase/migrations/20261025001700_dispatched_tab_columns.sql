-- Dispatched tab columns: when issuing completed, when the first shipment left,
-- and who made the latest status change.
create or replace view public.v_work_order_list with (security_invoker = true) as
select v.*,
  p.code as province_code,
  coalesce(v.imported_at, v.created_at) as downloaded_at,
  coalesce(nullif(v.total_approved, 0), v.total_requested) as device_count,
  (select string_agg(coalesce(m.model_code || ' - ' || m.model_name, 'Any ' || c.name), ',' order by l.line_no)
     from public.work_order_lines l
     join public.device_categories c on c.id = l.category_id
     left join public.device_models m on m.id = l.model_id
    where l.work_order_id = v.id) as device_names,
  (select min(h.changed_at) from public.work_order_status_history h
    where h.work_order_id = v.id and h.to_status in ('scheduled', 'scheduled_pending_issuing', 'issuing_in_progress', 'issued')) as started_at,
  (select string_agg(x.code || ' (' || x.n || case when x.n = 1 then ' Device)' else ' Devices)' end, ', ' order by x.code)
     from (select coalesce(loc.code, 'Unassigned') as code, count(*) as n
             from public.work_order_devices a
             join public.devices d on d.id = a.device_id
             left join public.warehouse_locations loc on loc.id = d.location_id
            where a.work_order_id = v.id and a.status in ('reserved', 'picked', 'issued', 'dispatched', 'delivered')
            group by 1) x) as allocated_clusters,
  (select min(h.changed_at) from public.work_order_status_history h
    where h.work_order_id = v.id and h.to_status = 'issued') as issuing_completed_at,
  (select min(dp.dispatched_at) from public.dispatches dp
    where dp.work_order_id = v.id and dp.dispatched_at is not null) as first_dispatched_at,
  (select pr.full_name from public.work_order_status_history h
     join public.profiles pr on pr.id = h.changed_by
    where h.work_order_id = v.id order by h.changed_at desc, h.id desc limit 1) as updated_by_name
from public.v_work_orders v
join public.provinces p on p.id = v.province_id;
