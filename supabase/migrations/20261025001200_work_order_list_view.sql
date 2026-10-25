-- Columns used by the work order list tabs: province code, downloaded/imported date
-- and the device count shown per work order (approved quantity once approved).
create or replace view public.v_work_order_list with (security_invoker = true) as
select v.*,
  p.code as province_code,
  coalesce(v.imported_at, v.created_at) as downloaded_at,
  coalesce(nullif(v.total_approved, 0), v.total_requested) as device_count
from public.v_work_orders v
join public.provinces p on p.id = v.province_id;

grant select on public.v_work_order_list to authenticated;
revoke all on public.v_work_order_list from anon;
