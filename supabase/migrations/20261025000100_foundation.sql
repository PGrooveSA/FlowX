-- =====================================================================
-- DeviceFlow foundation: extensions, RBAC, reference data, settings,
-- document numbering, audit trail and notifications.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to postgres, service_role;

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
create or replace function app_private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.normalize_serial(p text) returns text
language sql immutable parallel safe as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[\s\-_/\.]+', '', 'g')), '')
$$;

-- ---------------------------------------------------------------------
-- Profiles and RBAC
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  job_title text,
  is_active boolean not null default true,
  default_warehouse_id uuid,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_email_idx on public.profiles (lower(email));
create trigger profiles_touch before update on public.profiles
  for each row execute function app_private.touch_updated_at();

create table public.permissions (
  code text primary key,
  module text not null,
  description text not null,
  is_sensitive boolean not null default false
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  description text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger roles_touch before update on public.roles
  for each row execute function app_private.touch_updated_at();

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

create table public.provinces (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.districts (
  id uuid primary key default gen_random_uuid(),
  province_id uuid not null references public.provinces(id),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (province_id, name)
);
create index districts_province_idx on public.districts (province_id);

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9\-]{2,20}$'),
  name text not null,
  province_id uuid not null references public.provinces(id),
  address_line1 text,
  address_line2 text,
  city text,
  postal_code text,
  phone text,
  manager_id uuid references public.profiles(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger warehouses_touch before update on public.warehouses
  for each row execute function app_private.touch_updated_at();

alter table public.profiles
  add constraint profiles_default_wh_fk foreign key (default_warehouse_id) references public.warehouses(id);

create table public.warehouse_locations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id),
  code text not null,
  zone text,
  shelf text,
  bin text,
  location_type text not null default 'storage'
    check (location_type in ('storage','receiving','quarantine','repair','dispatch','returns')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (warehouse_id, code)
);
create index warehouse_locations_wh_idx on public.warehouse_locations (warehouse_id);

-- A user can hold several roles; each assignment can be limited to a
-- warehouse and/or province. An assignment with both NULL is global scope.
create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  warehouse_id uuid references public.warehouses(id),
  province_id uuid references public.provinces(id),
  assigned_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create unique index user_role_assignments_uniq on public.user_role_assignments
  (user_id, role_id, coalesce(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(province_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index user_role_assignments_user_idx on public.user_role_assignments (user_id);

-- Granular per-user grants (granted = true) or explicit denials (granted = false).
create table public.user_permission_overrides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  granted boolean not null,
  reason text,
  set_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (user_id, permission_code)
);

-- ---------------------------------------------------------------------
-- Permission and scope checks (used by RLS policies and RPCs)
-- ---------------------------------------------------------------------
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
$$;

create or replace function public.has_permission(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
     and (
       exists (select 1 from user_permission_overrides o
               where o.user_id = auth.uid() and o.permission_code = p_code and o.granted)
       or (
         exists (select 1 from user_role_assignments a
                 join roles r on r.id = a.role_id and r.is_active
                 join role_permissions rp on rp.role_id = a.role_id
                 where a.user_id = auth.uid() and rp.permission_code = p_code)
         and not exists (select 1 from user_permission_overrides o
                         where o.user_id = auth.uid() and o.permission_code = p_code and not o.granted)
       )
     )
$$;

create or replace function public.my_permissions() returns setof text
language sql stable security definer set search_path = public as $$
  select p.code from permissions p where public.has_permission(p.code) order by p.code
$$;

create or replace function public.has_global_scope() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
     and exists (select 1 from user_role_assignments a join roles r on r.id = a.role_id and r.is_active
                 where a.user_id = auth.uid() and a.warehouse_id is null and a.province_id is null)
$$;

-- Warehouses the current user may operate in (explicit or via province scope).
create or replace function public.my_warehouse_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct w.id), '{}')
  from warehouses w
  where public.has_global_scope()
     or exists (select 1 from user_role_assignments a
                where a.user_id = auth.uid()
                  and (a.warehouse_id = w.id or a.province_id = w.province_id))
$$;

create or replace function public.my_province_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p.id), '{}')
  from provinces p
  where public.has_global_scope()
     or exists (select 1 from user_role_assignments a
                left join warehouses w on w.id = a.warehouse_id
                where a.user_id = auth.uid()
                  and (a.province_id = p.id or w.province_id = p.id))
$$;

create or replace function app_private.require_permission(p_code text) returns void
language plpgsql stable as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.has_permission(p_code) then
    raise exception 'Permission denied: "%" is required for this action', p_code using errcode = '42501';
  end if;
end $$;

create or replace function app_private.require_warehouse_scope(p_warehouse uuid) returns void
language plpgsql stable as $$
begin
  if p_warehouse is not null and not (p_warehouse = any(public.my_warehouse_ids())) then
    raise exception 'Permission denied: you are not assigned to this warehouse' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Institutions and recipients
-- ---------------------------------------------------------------------
create table public.institutions (
  id uuid primary key default gen_random_uuid(),
  emis_number text not null,
  name text not null,
  institution_type text not null default 'school'
    check (institution_type in ('school','district_office','department','tvet_college','special_school','other')),
  phase text,
  province_id uuid not null references public.provinces(id),
  district_id uuid not null references public.districts(id),
  address_line1 text,
  address_line2 text,
  town text,
  postal_code text,
  delivery_address text,
  phone text,
  email text,
  principal_name text,
  billing_name text,
  billing_address text,
  billing_vat_number text,
  status text not null default 'active' check (status in ('active','inactive','closed')),
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index institutions_emis_uniq on public.institutions (upper(trim(emis_number)));
create index institutions_name_trgm on public.institutions using gin (name extensions.gin_trgm_ops);
create index institutions_district_idx on public.institutions (district_id);
create index institutions_province_idx on public.institutions (province_id);
create trigger institutions_touch before update on public.institutions
  for each row execute function app_private.touch_updated_at();

create table public.institution_contacts (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id),
  full_name text not null,
  role_title text,
  phone text,
  email text,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index institution_contacts_inst_idx on public.institution_contacts (institution_id);

-- Learner data is personal information (POPIA). Only collect what is needed
-- and restrict visibility with recipients.view_learners.
create table public.recipients (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id),
  recipient_type text not null check (recipient_type in ('learner','teacher','school','department','other')),
  full_name text not null,
  reference_number text,
  grade text,
  class_name text,
  phone text,
  email text,
  is_active boolean not null default true,
  retention_review_date date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recipients_inst_idx on public.recipients (institution_id);
create unique index recipients_ref_uniq on public.recipients (institution_id, recipient_type, reference_number)
  where reference_number is not null;
create trigger recipients_touch before update on public.recipients
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- Master data: suppliers, categories, models, work order types
-- ---------------------------------------------------------------------
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  contact_name text,
  phone text,
  email text,
  vat_number text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.device_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  requires_serial boolean not null default true,
  requires_imei boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.device_models (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.device_categories(id),
  manufacturer text not null,
  model_name text not null,
  model_code text not null unique,
  description text,
  unit_price_cents bigint not null default 0 check (unit_price_cents >= 0),
  warranty_months int not null default 12 check (warranty_months >= 0),
  low_stock_threshold int not null default 10 check (low_stock_threshold >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manufacturer, model_name)
);
create index device_models_category_idx on public.device_models (category_id);
create trigger device_models_touch before update on public.device_models
  for each row execute function app_private.touch_updated_at();

create table public.work_order_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  description text,
  requires_invoice boolean not null default true,
  is_active boolean not null default true,
  sort_order int not null default 100
);

-- ---------------------------------------------------------------------
-- Settings and document numbering
-- ---------------------------------------------------------------------
create table public.system_settings (
  key text primary key,
  value jsonb not null,
  category text not null default 'general',
  description text,
  is_public boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create or replace function app_private.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from system_settings where key = p_key
$$;
create or replace function app_private.setting_bool(p_key text, p_default boolean) returns boolean
language sql stable as $$ select coalesce((app_private.setting(p_key))::text::boolean, p_default) $$;
create or replace function app_private.setting_num(p_key text, p_default numeric) returns numeric
language sql stable as $$ select coalesce((app_private.setting(p_key))::text::numeric, p_default) $$;
create or replace function app_private.setting_text(p_key text, p_default text) returns text
language sql stable as $$ select coalesce(app_private.setting(p_key) #>> '{}', p_default) $$;

create table public.document_sequences (
  code text primary key,
  prefix text not null check (prefix ~ '^[A-Z]{1,6}$'),
  include_year boolean not null default true,
  padding int not null default 6 check (padding between 3 and 10),
  current_year int,
  next_value bigint not null default 1 check (next_value > 0),
  description text,
  updated_at timestamptz not null default now()
);

-- Gap-free within committed transactions: the counter row is locked and
-- its increment rolls back together with the calling transaction.
create or replace function app_private.next_document_number(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  s public.document_sequences;
  y int := extract(year from (now() at time zone 'Africa/Johannesburg'))::int;
  v bigint;
begin
  select * into s from document_sequences where code = p_code for update;
  if not found then
    raise exception 'Unknown document sequence %', p_code;
  end if;
  v := s.next_value;
  if s.include_year and coalesce(s.current_year, 0) <> y then
    v := 1;
  end if;
  update document_sequences set next_value = v + 1, current_year = y, updated_at = now() where code = p_code;
  return s.prefix || '-' || case when s.include_year then y::text || '-' else '' end || lpad(v::text, s.padding, '0');
end $$;

-- ---------------------------------------------------------------------
-- Audit trail (append-only)
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  user_id uuid,
  user_email text,
  user_roles text,
  action text not null,
  entity_type text not null,
  entity_id text,
  old_values jsonb,
  new_values jsonb,
  reason text,
  work_order_id uuid,
  device_id uuid,
  invoice_id uuid,
  dispatch_id uuid,
  success boolean not null default true,
  correlation_id text,
  details jsonb
);
create index audit_logs_time_idx on public.audit_logs (occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_user_idx on public.audit_logs (user_id, occurred_at desc);
create index audit_logs_wo_idx on public.audit_logs (work_order_id) where work_order_id is not null;
create index audit_logs_device_idx on public.audit_logs (device_id) where device_id is not null;
create index audit_logs_action_idx on public.audit_logs (action);

create or replace function app_private.prevent_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Audit records are append-only and cannot be modified or deleted';
end $$;
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function app_private.prevent_audit_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app_private.prevent_audit_mutation();

create or replace function app_private.correlation_id() returns text
language plpgsql stable as $$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  return left(h ->> 'x-correlation-id', 64);
end $$;

-- Strip any keys that could hold secrets before persisting audit values.
create or replace function app_private.scrub(p jsonb) returns jsonb
language sql immutable as $$
  select case when p is null then null
    else p - array['password','encrypted_password','token','access_token','refresh_token','token_hash','signature_data','raw_token']
  end
$$;

create or replace function app_private.audit(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old jsonb default null,
  p_new jsonb default null,
  p_reason text default null,
  p_refs jsonb default '{}'::jsonb,
  p_success boolean default true,
  p_details jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  insert into audit_logs (user_id, user_email, user_roles, action, entity_type, entity_id, old_values, new_values,
                          reason, work_order_id, device_id, invoice_id, dispatch_id, success, correlation_id, details)
  values (
    v_uid,
    (select email from profiles where id = v_uid),
    (select string_agg(distinct r.code, ',') from user_role_assignments a join roles r on r.id = a.role_id where a.user_id = v_uid),
    p_action, p_entity_type, p_entity_id, app_private.scrub(p_old), app_private.scrub(p_new), p_reason,
    nullif(p_refs ->> 'work_order_id', '')::uuid,
    nullif(p_refs ->> 'device_id', '')::uuid,
    nullif(p_refs ->> 'invoice_id', '')::uuid,
    nullif(p_refs ->> 'dispatch_id', '')::uuid,
    p_success, app_private.correlation_id(), app_private.scrub(p_details)
  );
end $$;

-- Row-level audit for master data and security tables edited directly.
create or replace function app_private.audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_id text;
begin
  if tg_op = 'DELETE' then
    v_id := coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'key', to_jsonb(old) ->> 'code');
    perform app_private.audit(lower(tg_op), tg_table_name, v_id, to_jsonb(old), null);
    return old;
  end if;
  v_id := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'key', to_jsonb(new) ->> 'code');
  if tg_op = 'UPDATE' then
    if to_jsonb(old) = to_jsonb(new) then return new; end if;
    perform app_private.audit('update', tg_table_name, v_id, to_jsonb(old), to_jsonb(new));
  else
    perform app_private.audit('insert', tg_table_name, v_id, null, to_jsonb(new));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text,
  link text,
  category text not null default 'general',
  severity text not null default 'info' check (severity in ('info','success','warning','critical')),
  entity_type text,
  entity_id uuid,
  dedupe_key text,
  is_read boolean not null default false,
  read_at timestamptz,
  email_status text not null default 'not_configured'
    check (email_status in ('not_configured','pending','sent','failed','not_required')),
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, is_read, created_at desc);
create unique index notifications_dedupe_uniq on public.notifications (user_id, dedupe_key) where dedupe_key is not null;

create or replace function app_private.notify_user(
  p_user uuid, p_title text, p_body text, p_link text, p_category text,
  p_severity text default 'info', p_entity_type text default null, p_entity_id uuid default null,
  p_dedupe text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email_status text := case when app_private.setting_text('email.provider', 'none') = 'none'
                              then 'not_configured' else 'pending' end;
begin
  if p_user is null then return; end if;
  insert into notifications (user_id, title, body, link, category, severity, entity_type, entity_id, dedupe_key, email_status)
  values (p_user, p_title, p_body, p_link, p_category, p_severity, p_entity_type, p_entity_id, p_dedupe, v_email_status)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
end $$;

-- Notify every active user holding a permission (optionally limited to a warehouse scope).
create or replace function app_private.notify_permission(
  p_permission text, p_title text, p_body text, p_link text, p_category text,
  p_severity text default 'info', p_entity_type text default null, p_entity_id uuid default null,
  p_warehouse uuid default null, p_exclude uuid default null, p_dedupe text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select distinct pr.id
    from profiles pr
    where pr.is_active
      and (pr.id <> p_exclude or p_exclude is null)
      and (
        exists (select 1 from user_permission_overrides o where o.user_id = pr.id and o.permission_code = p_permission and o.granted)
        or (exists (select 1 from user_role_assignments a join roles ro on ro.id = a.role_id and ro.is_active
                    join role_permissions rp on rp.role_id = a.role_id
                    where a.user_id = pr.id and rp.permission_code = p_permission
                      and (p_warehouse is null or (a.warehouse_id is null and a.province_id is null)
                           or a.warehouse_id = p_warehouse
                           or a.province_id = (select province_id from warehouses where id = p_warehouse)))
            and not exists (select 1 from user_permission_overrides o where o.user_id = pr.id and o.permission_code = p_permission and not o.granted))
      )
  loop
    perform app_private.notify_user(r.id, p_title, p_body, p_link, p_category, p_severity, p_entity_type, p_entity_id, p_dedupe);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Attachments (files live in the private "attachments" storage bucket)
-- ---------------------------------------------------------------------
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in
    ('work_order','device','assessment','repair','invoice','dispatch','delivery','return','goods_receipt','stock_count','institution')),
  entity_id uuid not null,
  category text not null default 'document' check (category in ('document','photo','before','after','pod','signature','other')),
  bucket text not null default 'attachments',
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  description text,
  uploaded_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index attachments_entity_idx on public.attachments (entity_type, entity_id);

-- ---------------------------------------------------------------------
-- New auth users get a profile automatically
-- ---------------------------------------------------------------------
create or replace function app_private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- Row audit for directly-edited administrative tables
create trigger audit_roles after insert or update or delete on public.roles for each row execute function app_private.audit_row_change();
create trigger audit_role_permissions after insert or update or delete on public.role_permissions for each row execute function app_private.audit_row_change();
create trigger audit_user_roles after insert or update or delete on public.user_role_assignments for each row execute function app_private.audit_row_change();
create trigger audit_user_overrides after insert or update or delete on public.user_permission_overrides for each row execute function app_private.audit_row_change();
create trigger audit_profiles after update on public.profiles for each row execute function app_private.audit_row_change();
create trigger audit_provinces after insert or update on public.provinces for each row execute function app_private.audit_row_change();
create trigger audit_districts after insert or update on public.districts for each row execute function app_private.audit_row_change();
create trigger audit_warehouses after insert or update on public.warehouses for each row execute function app_private.audit_row_change();
create trigger audit_wh_locations after insert or update on public.warehouse_locations for each row execute function app_private.audit_row_change();
create trigger audit_institutions after insert or update on public.institutions for each row execute function app_private.audit_row_change();
create trigger audit_recipients after insert or update on public.recipients for each row execute function app_private.audit_row_change();
create trigger audit_suppliers after insert or update on public.suppliers for each row execute function app_private.audit_row_change();
create trigger audit_categories after insert or update on public.device_categories for each row execute function app_private.audit_row_change();
create trigger audit_models after insert or update on public.device_models for each row execute function app_private.audit_row_change();
create trigger audit_wo_types after insert or update on public.work_order_types for each row execute function app_private.audit_row_change();
create trigger audit_settings after insert or update on public.system_settings for each row execute function app_private.audit_row_change();
create trigger audit_sequences after update on public.document_sequences for each row execute function app_private.audit_row_change();
