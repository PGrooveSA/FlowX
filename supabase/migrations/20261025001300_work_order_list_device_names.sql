-- Device Name(s) column for the work order list: "<model code> - <model name>" per line,
-- or "Any <category>" where a line allows any model in its category.
create or replace view public.v_work_order_list with (security_invoker = true) as
select v.*,
  p.code as province_code,
  coalesce(v.imported_at, v.created_at) as downloaded_at,
  coalesce(nullif(v.total_approved, 0), v.total_requested) as device_count,
  (select string_agg(coalesce(m.model_code || ' - ' || m.model_name, 'Any ' || c.name), ',' order by l.line_no)
     from public.work_order_lines l
     join public.device_categories c on c.id = l.category_id
     left join public.device_models m on m.id = l.model_id
    where l.work_order_id = v.id) as device_names
from public.v_work_orders v
join public.provinces p on p.id = v.province_id;
