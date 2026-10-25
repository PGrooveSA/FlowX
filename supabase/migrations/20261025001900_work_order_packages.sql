-- View Work Order page: each allocated device ("package") can name its own recipient
-- (e.g. the learner receiving it). Without one, the work order's recipient applies.

alter table public.work_order_devices
  add column recipient_id uuid references public.recipients(id);
create index work_order_devices_recipient_idx on public.work_order_devices (recipient_id) where recipient_id is not null;

create or replace function public.assign_allocation_recipient(p_allocation_id uuid, p_recipient_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  a public.work_order_devices;
  w public.work_orders;
  r public.recipients;
begin
  if not (public.has_permission('recipients.manage') or public.has_permission('issuing.pick')) then
    raise exception 'Permission denied: recipient or issuing permission is required' using errcode = '42501';
  end if;
  select * into a from work_order_devices where id = p_allocation_id for update;
  if not found then raise exception 'Allocation not found'; end if;
  if a.status not in ('reserved','picked','issued','dispatched','delivered') then
    raise exception 'Only active allocations can be assigned to a recipient';
  end if;
  select * into w from work_orders where id = a.work_order_id;
  perform app_private.require_warehouse_scope(w.warehouse_id);
  if p_recipient_id is not null then
    select * into r from recipients where id = p_recipient_id;
    if not found or r.institution_id <> w.institution_id then
      raise exception 'The recipient does not belong to this work order''s institution';
    end if;
    if not r.is_active then raise exception 'The recipient is inactive'; end if;
    -- Learner personal information is restricted (POPIA)
    if r.recipient_type = 'learner' and not public.has_permission('recipients.view_learners') then
      raise exception 'Permission denied: learner records require "recipients.view_learners"' using errcode = '42501';
    end if;
  end if;
  update work_order_devices set recipient_id = p_recipient_id where id = a.id;
  perform app_private.audit('assign_recipient', 'work_order_device', a.id::text, jsonb_build_object('recipient_id', a.recipient_id),
    jsonb_build_object('recipient_id', p_recipient_id), null, jsonb_build_object('work_order_id', w.id, 'device_id', a.device_id));
end $$;

revoke execute on function public.assign_allocation_recipient(uuid, uuid) from public, anon;
grant execute on function public.assign_allocation_recipient(uuid, uuid) to authenticated, service_role;

-- One row per package. Recipient details come through RLS on recipients, so learner
-- names stay hidden from users without recipients.view_learners.
create or replace view public.v_work_order_packages with (security_invoker = true) as
select a.id, a.work_order_id, a.recipient_id, a.created_at,
  coalesce(d.serial_number, d.asset_tag) as package_id,
  coalesce(r.full_name, wr.full_name, w.recipient_group) as recipient_name,
  coalesce(r.grade, wr.grade, w.grade) as grade,
  coalesce(r.class_name, wr.class_name, w.class_name) as classroom
from public.work_order_devices a
join public.work_orders w on w.id = a.work_order_id
join public.devices d on d.id = a.device_id
left join public.recipients r on r.id = a.recipient_id
left join public.recipients wr on wr.id = w.recipient_id
where a.status in ('reserved','picked','issued','dispatched','delivered');

grant select on public.v_work_order_packages to authenticated;
revoke all on public.v_work_order_packages from anon;

-- The Work Order Details grid shows each package's assigned recipient.
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
  od.asset_tag as previous_asset_tag, om.model_name as previous_device_name,
  a.recipient_id, rc.full_name as recipient_name
from public.work_order_devices a
join public.devices d on d.id = a.device_id
join public.device_models m on m.id = d.model_id
join public.device_categories c on c.id = d.category_id
left join public.warehouse_locations loc on loc.id = d.location_id
left join public.suppliers s on s.id = d.supplier_id
left join public.replacement_transactions rt on rt.new_allocation_id = a.id
left join public.devices od on od.id = rt.original_device_id
left join public.device_models om on om.id = od.model_id
left join public.recipients rc on rc.id = a.recipient_id
where a.status in ('reserved','picked','issued','dispatched','delivered');
