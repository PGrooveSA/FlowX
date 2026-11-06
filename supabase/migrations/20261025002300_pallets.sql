-- Pallets: a numbered group of received devices, so a pallet label can be printed and the pallet found again later.
create sequence if not exists public.pallet_number_seq;

create table if not exists public.pallets (
  id uuid primary key default gen_random_uuid(),
  pallet_number text not null unique default ('PLT-' || lpad(nextval('public.pallet_number_seq')::text, 6, '0')),
  warehouse_id uuid references public.warehouses(id),
  reference text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- a device sits on one pallet at a time
create table if not exists public.pallet_devices (
  device_id uuid primary key references public.devices(id) on delete cascade,
  pallet_id uuid not null references public.pallets(id) on delete cascade,
  added_at timestamptz not null default now()
);
create index if not exists pallet_devices_pallet_idx on public.pallet_devices(pallet_id);

alter table public.pallets enable row level security;
alter table public.pallet_devices enable row level security;
revoke all on public.pallets, public.pallet_devices from anon;
revoke insert, update, delete on public.pallets, public.pallet_devices from authenticated;
create policy pallets_read on public.pallets for select to authenticated using ((select public.is_active_user()));
create policy pallet_devices_read on public.pallet_devices for select to authenticated using ((select public.is_active_user()));

create or replace view public.v_pallet_devices with (security_invoker = true) as
select pd.pallet_id, v.id, v.asset_tag, v.serial_number, v.imei, v.manufacturer, v.model_name, v.condition, v.warehouse_code
from public.pallet_devices pd
join public.v_devices v on v.id = pd.device_id;

-- Create a pallet from a list of devices. Devices already on another pallet move to the new one.
create or replace function public.create_pallet(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
  v_found int;
  r public.pallets;
begin
  perform app_private.require_permission('labels.print');
  select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p -> 'device_ids', '[]'::jsonb)) x;
  if v_ids is null or cardinality(v_ids) = 0 then raise exception 'Choose at least one device for the pallet'; end if;
  if cardinality(v_ids) > 5000 then raise exception 'A pallet can hold at most 5000 devices'; end if;
  select count(*) into v_found from devices where id = any(v_ids);
  if v_found <> cardinality(v_ids) then raise exception '% of the devices were not found', cardinality(v_ids) - v_found; end if;

  insert into pallets (warehouse_id, reference, notes)
  values (nullif(p ->> 'warehouse_id', '')::uuid, nullif(trim(p ->> 'reference'), ''), nullif(trim(p ->> 'notes'), ''))
  returning * into r;
  insert into pallet_devices (device_id, pallet_id) select unnest(v_ids), r.id
  on conflict (device_id) do update set pallet_id = excluded.pallet_id, added_at = now();

  perform app_private.audit('create_pallet', 'pallet', r.id::text, null, to_jsonb(r) || jsonb_build_object('devices', cardinality(v_ids)), null, '{}'::jsonb);
  return jsonb_build_object('id', r.id, 'pallet_number', r.pallet_number, 'devices', cardinality(v_ids));
end $$;

revoke execute on function public.create_pallet(jsonb) from public, anon;
grant execute on function public.create_pallet(jsonb) to authenticated, service_role;
grant select on public.v_pallet_devices to authenticated;
