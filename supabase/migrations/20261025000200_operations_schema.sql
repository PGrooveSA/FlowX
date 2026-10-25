-- =====================================================================
-- DeviceFlow operational schema: devices, work orders, warehouse,
-- repairs, invoicing, dispatch, delivery and returns.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Physical devices
-- ---------------------------------------------------------------------
create table public.device_status_transitions (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  asset_tag text not null unique,
  model_id uuid not null references public.device_models(id),
  category_id uuid not null references public.device_categories(id),
  manufacturer text not null,
  serial_number text,
  serial_normalized text generated always as (public.normalize_serial(serial_number)) stored,
  serial_exception_reason text,
  barcode_value text,
  status text not null default 'available' check (status in (
    'expected','received','available','reserved','picked','issued','in_transit','dispatched','delivered',
    'faulty','under_assessment','under_repair','awaiting_parts','repair_completed','returned_to_warehouse',
    'quarantined','lost','stolen','written_off')),
  condition text not null default 'new' check (condition in ('new','good','fair','poor','faulty','damaged','beyond_repair')),
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.warehouse_locations(id),
  current_work_order_id uuid,
  current_institution_id uuid references public.institutions(id),
  current_recipient_id uuid references public.recipients(id),
  supplier_id uuid references public.suppliers(id),
  acquisition_reference text,
  purchase_date date,
  unit_cost_cents bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  warranty_expires_on date,
  warranty_notes text,
  received_at timestamptz,
  last_verified_at timestamptz,
  goods_receipt_id uuid,
  notes text,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint devices_serial_required check (serial_number is not null or serial_exception_reason is not null)
);
-- A manufacturer serial may only be registered once per manufacturer.
create unique index devices_serial_uniq on public.devices (upper(manufacturer), serial_normalized)
  where serial_normalized is not null;
create index devices_serial_lookup_idx on public.devices (serial_normalized);
create index devices_serial_trgm on public.devices using gin (serial_normalized extensions.gin_trgm_ops);
create index devices_status_idx on public.devices (status);
create index devices_wh_status_idx on public.devices (warehouse_id, status, model_id);
create index devices_model_idx on public.devices (model_id);
create index devices_wo_idx on public.devices (current_work_order_id) where current_work_order_id is not null;
create index devices_inst_idx on public.devices (current_institution_id) where current_institution_id is not null;
create index devices_created_idx on public.devices (created_at desc);

create table public.device_identifiers (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id),
  identifier_type text not null check (identifier_type in ('imei','imei2','mac','barcode','sim_iccid','other')),
  value text not null,
  value_normalized text generated always as (public.normalize_serial(value)) stored,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create unique index device_identifiers_uniq on public.device_identifiers (identifier_type, value_normalized);
create index device_identifiers_device_idx on public.device_identifiers (device_id);
create index device_identifiers_lookup_idx on public.device_identifiers (value_normalized);

-- Enforce explicit device status transitions on every update.
create or replace function app_private.enforce_device_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.device_status_transitions t
                   where t.from_status = old.status and t.to_status = new.status) then
      raise exception 'Invalid device status change for % from "%" to "%"', old.asset_tag, old.status, new.status
        using errcode = 'P0001';
    end if;
  end if;
  if new.serial_number is distinct from old.serial_number and current_setting('deviceflow.identity_correction', true) is distinct from 'on' then
    raise exception 'A registered serial number cannot be changed except through an authorised identity correction';
  end if;
  new.updated_at := now();
  new.version := old.version + 1;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
create trigger devices_enforce_transition before update on public.devices
  for each row execute function app_private.enforce_device_transition();

-- Permanent custody ledger, one row per physical movement or status change.
create table public.device_movements (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.devices(id),
  movement_type text not null,
  from_status text,
  to_status text,
  from_warehouse_id uuid references public.warehouses(id),
  to_warehouse_id uuid references public.warehouses(id),
  from_location_id uuid references public.warehouse_locations(id),
  to_location_id uuid references public.warehouse_locations(id),
  institution_id uuid references public.institutions(id),
  work_order_id uuid,
  dispatch_id uuid,
  reference text,
  reason text,
  performed_by uuid references public.profiles(id),
  performed_at timestamptz not null default now()
);
create index device_movements_device_idx on public.device_movements (device_id, performed_at desc);
create index device_movements_time_idx on public.device_movements (performed_at desc);
create index device_movements_wo_idx on public.device_movements (work_order_id) where work_order_id is not null;
create trigger device_movements_immutable before update or delete on public.device_movements
  for each row execute function app_private.prevent_audit_mutation();

-- ---------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------
create table public.work_order_status_transitions (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  wo_number text not null unique,
  work_order_type_id uuid not null references public.work_order_types(id),
  status text not null default 'draft' check (status in (
    'draft','pending_authorisation','returned_for_correction','approved','pending_scheduling','scheduled',
    'scheduled_pending_issuing','issuing_in_progress','issued','pending_invoicing','invoiced','ready_for_dispatch',
    'partially_dispatched','dispatched','partially_delivered','delivered','completed','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  province_id uuid not null references public.provinces(id),
  district_id uuid not null references public.districts(id),
  institution_id uuid not null references public.institutions(id),
  recipient_type text not null check (recipient_type in ('learner','teacher','school','department','other')),
  recipient_id uuid references public.recipients(id),
  recipient_group text,
  grade text,
  class_name text,
  description text,
  instructions text,
  internal_notes text,
  warehouse_id uuid references public.warehouses(id),
  scheduled_date date,
  assigned_team text,
  assigned_to uuid references public.profiles(id),
  invoice_required boolean not null default true,
  invoice_exempt_reason text,
  source_reference text,
  imported_at timestamptz,
  has_pending_amendment boolean not null default false,
  amendment_count int not null default 0,
  rejection_reason text,
  cancellation_reason text,
  created_by uuid not null references public.profiles(id),
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  constraint wo_exempt_reason check (invoice_required or invoice_exempt_reason is not null)
);
create index work_orders_status_idx on public.work_orders (status, created_at desc);
create index work_orders_inst_idx on public.work_orders (institution_id);
create index work_orders_wh_idx on public.work_orders (warehouse_id);
create index work_orders_province_idx on public.work_orders (province_id, district_id);
create index work_orders_created_idx on public.work_orders (created_at desc);
create index work_orders_sched_idx on public.work_orders (scheduled_date) where scheduled_date is not null;
create index work_orders_creator_idx on public.work_orders (created_by);
create index work_orders_number_trgm on public.work_orders using gin (wo_number extensions.gin_trgm_ops);

alter table public.devices add constraint devices_wo_fk foreign key (current_work_order_id) references public.work_orders(id);
alter table public.device_movements add constraint device_movements_wo_fk foreign key (work_order_id) references public.work_orders(id);

create table public.work_order_lines (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id),
  line_no int not null,
  category_id uuid not null references public.device_categories(id),
  model_id uuid references public.device_models(id),
  requested_qty int not null check (requested_qty > 0),
  approved_qty int check (approved_qty is null or approved_qty >= 0),
  unit_price_cents bigint check (unit_price_cents is null or unit_price_cents >= 0),
  notes text,
  created_at timestamptz not null default now(),
  unique (work_order_id, line_no)
);
create index work_order_lines_wo_idx on public.work_order_lines (work_order_id);

-- Each physical device allocated to a work order. A device may have only
-- one ACTIVE allocation at a time (enforced by the partial unique index).
create table public.work_order_devices (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id),
  line_id uuid not null references public.work_order_lines(id),
  device_id uuid not null references public.devices(id),
  status text not null check (status in ('reserved','picked','issued','dispatched','delivered','released','replaced','returned','cancelled')),
  reserved_at timestamptz,
  reserved_by uuid references public.profiles(id),
  picked_at timestamptz,
  picked_by uuid references public.profiles(id),
  issued_at timestamptz,
  issued_by uuid references public.profiles(id),
  dispatched_at timestamptz,
  delivered_at timestamptz,
  released_at timestamptz,
  released_by uuid references public.profiles(id),
  release_reason text,
  replaced_by_id uuid references public.work_order_devices(id),
  created_at timestamptz not null default now()
);
create unique index work_order_devices_active_uniq on public.work_order_devices (device_id)
  where status in ('reserved','picked','issued','dispatched');
create index work_order_devices_wo_idx on public.work_order_devices (work_order_id, status);
create index work_order_devices_line_idx on public.work_order_devices (line_id, status);
create index work_order_devices_device_idx on public.work_order_devices (device_id);

create table public.work_order_status_history (
  id bigint generated always as identity primary key,
  work_order_id uuid not null references public.work_orders(id),
  from_status text,
  to_status text not null,
  reason text,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);
create index wo_status_history_wo_idx on public.work_order_status_history (work_order_id, changed_at);
create trigger wo_status_history_immutable before update or delete on public.work_order_status_history
  for each row execute function app_private.prevent_audit_mutation();

create table public.work_order_approvals (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id),
  action text not null check (action in ('submitted','approved','returned','amendment_requested','amendment_approved','amendment_rejected')),
  comments text,
  snapshot jsonb,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz not null default now()
);
create index wo_approvals_wo_idx on public.work_order_approvals (work_order_id, decided_at);

create table public.work_order_amendments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected','applied')),
  reason text not null,
  changes jsonb not null,
  previous_values jsonb,
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_comment text
);
create index wo_amendments_wo_idx on public.work_order_amendments (work_order_id);
create unique index wo_amendments_one_pending on public.work_order_amendments (work_order_id) where status = 'pending';

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id),
  warehouse_id uuid not null references public.warehouses(id),
  scheduled_date date not null,
  assigned_team text,
  assigned_to uuid references public.profiles(id),
  priority text not null,
  status text not null default 'active' check (status in ('active','superseded','cancelled')),
  reason text,
  shortage_accepted boolean not null default false,
  shortage_details jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index schedules_wo_idx on public.schedules (work_order_id);
create index schedules_date_idx on public.schedules (scheduled_date) where status = 'active';

-- ---------------------------------------------------------------------
-- Serial discrepancies (anti-swap protection)
-- ---------------------------------------------------------------------
create table public.serial_discrepancies (
  id uuid primary key default gen_random_uuid(),
  discrepancy_number text not null unique,
  context text not null check (context in ('issuing','reservation','dispatch','delivery','stock_count','receiving','return','invoice')),
  reason_code text not null,
  message text not null,
  work_order_id uuid references public.work_orders(id),
  dispatch_id uuid,
  expected_device_id uuid references public.devices(id),
  expected_serial text,
  scanned_serial text,
  scanned_device_id uuid references public.devices(id),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  reported_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index discrepancies_open_idx on public.serial_discrepancies (status, created_at desc);
create index discrepancies_wo_idx on public.serial_discrepancies (work_order_id) where status = 'open';
create index discrepancies_device_idx on public.serial_discrepancies (scanned_device_id) where status = 'open';

-- ---------------------------------------------------------------------
-- Warehouse: receiving, movements, adjustments, transfers, counts
-- ---------------------------------------------------------------------
create table public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  grn_number text not null unique,
  warehouse_id uuid not null references public.warehouses(id),
  supplier_id uuid references public.suppliers(id),
  source_type text not null default 'purchase' check (source_type in ('purchase','return','transfer','initial_import','donation','other')),
  source_reference text,
  receiving_date date not null default current_date,
  status text not null default 'draft' check (status in ('draft','completed','completed_with_discrepancies','cancelled')),
  notes text,
  discrepancy_notes text,
  received_by uuid references public.profiles(id),
  completed_by uuid references public.profiles(id),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index goods_receipts_wh_idx on public.goods_receipts (warehouse_id, created_at desc);

create table public.goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references public.goods_receipts(id),
  model_id uuid not null references public.device_models(id),
  expected_qty int not null check (expected_qty >= 0),
  unit_cost_cents bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  notes text,
  created_at timestamptz not null default now()
);
create index goods_receipt_lines_grn_idx on public.goods_receipt_lines (goods_receipt_id);

alter table public.devices add column goods_receipt_line_id uuid references public.goods_receipt_lines(id);
alter table public.devices add constraint devices_grn_fk foreign key (goods_receipt_id) references public.goods_receipts(id);

-- Multi-device stock operations (transfers and adjustments) with approval.
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  movement_number text not null unique,
  movement_type text not null check (movement_type in ('transfer','adjustment')),
  adjustment_type text check (adjustment_type in ('mark_lost','mark_stolen','write_off','found','condition_change','location_correction','quarantine')),
  status text not null default 'requested' check (status in ('requested','approved','in_transit','completed','rejected','cancelled')),
  from_warehouse_id uuid references public.warehouses(id),
  to_warehouse_id uuid references public.warehouses(id),
  to_location_id uuid references public.warehouse_locations(id),
  new_condition text,
  reason text not null check (length(trim(reason)) >= 3),
  reference text,
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  decision_comment text,
  completed_by uuid references public.profiles(id),
  completed_at timestamptz
);
create index stock_movements_status_idx on public.stock_movements (status, requested_at desc);

create table public.stock_movement_lines (
  id uuid primary key default gen_random_uuid(),
  stock_movement_id uuid not null references public.stock_movements(id),
  device_id uuid not null references public.devices(id),
  from_status text,
  from_location_id uuid references public.warehouse_locations(id),
  created_at timestamptz not null default now(),
  unique (stock_movement_id, device_id)
);
create index stock_movement_lines_device_idx on public.stock_movement_lines (device_id);

create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  count_number text not null unique,
  warehouse_id uuid not null references public.warehouses(id),
  location_id uuid references public.warehouse_locations(id),
  status text not null default 'open' check (status in ('open','submitted','approved','cancelled')),
  notes text,
  started_by uuid references public.profiles(id),
  started_at timestamptz not null default now(),
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  expected_count int,
  found_count int,
  missing_count int,
  unexpected_count int
);

create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references public.stock_counts(id),
  device_id uuid references public.devices(id),
  scanned_serial text,
  expected_location_id uuid references public.warehouse_locations(id),
  found_location_id uuid references public.warehouse_locations(id),
  result text not null default 'pending' check (result in ('pending','found','missing','unexpected','wrong_location')),
  scanned_by uuid references public.profiles(id),
  scanned_at timestamptz
);
create index stock_count_lines_count_idx on public.stock_count_lines (stock_count_id, result);
create unique index stock_count_lines_device_uniq on public.stock_count_lines (stock_count_id, device_id) where device_id is not null;

-- ---------------------------------------------------------------------
-- Assessments, repairs and replacements
-- ---------------------------------------------------------------------
create table public.device_assessments (
  id uuid primary key default gen_random_uuid(),
  assessment_number text not null unique,
  device_id uuid not null references public.devices(id),
  work_order_id uuid references public.work_orders(id),
  institution_id uuid references public.institutions(id),
  origin text,
  reported_fault text not null,
  physical_condition text,
  diagnostic_results text,
  status text not null default 'pending' check (status in ('pending','in_progress','completed','cancelled')),
  outcome text check (outcome in ('no_fault_found','repair_required','replacement_recommended','warranty_claim','scrap_recommended','return_to_service')),
  recommended_action text,
  estimated_cost_cents bigint check (estimated_cost_cents is null or estimated_cost_cents >= 0),
  warranty_status text check (warranty_status in ('in_warranty','out_of_warranty','unknown')),
  approval_status text not null default 'not_required' check (approval_status in ('not_required','pending','approved','rejected')),
  technician_id uuid references public.profiles(id),
  reported_by uuid references public.profiles(id),
  reported_at timestamptz not null default now(),
  assessed_at timestamptz,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz
);
create index assessments_status_idx on public.device_assessments (status, reported_at desc);
create index assessments_device_idx on public.device_assessments (device_id);

create table public.repair_status_transitions (
  from_status text not null,
  to_status text not null,
  permission_code text not null,
  primary key (from_status, to_status)
);

create table public.repair_jobs (
  id uuid primary key default gen_random_uuid(),
  repair_number text not null unique,
  device_id uuid not null references public.devices(id),
  assessment_id uuid references public.device_assessments(id),
  work_order_id uuid references public.work_orders(id),
  status text not null default 'repair_requested' check (status in (
    'repair_requested','awaiting_assessment','assessed','awaiting_approval','awaiting_parts','under_repair',
    'repair_completed','quality_check','ready_for_return','returned_to_warehouse','returned_to_recipient','closed','cancelled')),
  fault_description text not null,
  provider_type text not null default 'internal' check (provider_type in ('internal','external','warranty')),
  external_provider text,
  warranty_claim_reference text,
  technician_id uuid references public.profiles(id),
  labour_cost_cents bigint not null default 0 check (labour_cost_cents >= 0),
  estimated_cost_cents bigint check (estimated_cost_cents is null or estimated_cost_cents >= 0),
  technician_notes text,
  started_at timestamptz,
  completed_at timestamptz,
  qc_result text check (qc_result in ('pass','fail')),
  qc_notes text,
  qc_by uuid references public.profiles(id),
  qc_at timestamptz,
  final_condition text check (final_condition in ('new','good','fair','poor','faulty','damaged','beyond_repair')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index repair_jobs_status_idx on public.repair_jobs (status, created_at desc);
create index repair_jobs_device_idx on public.repair_jobs (device_id);
create unique index repair_jobs_one_open on public.repair_jobs (device_id)
  where status not in ('closed','cancelled','returned_to_warehouse','returned_to_recipient');

create table public.repair_parts (
  id uuid primary key default gen_random_uuid(),
  repair_job_id uuid not null references public.repair_jobs(id),
  part_name text not null,
  part_number text,
  quantity int not null check (quantity > 0),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  added_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index repair_parts_job_idx on public.repair_parts (repair_job_id);

create table public.repair_history (
  id bigint generated always as identity primary key,
  repair_job_id uuid not null references public.repair_jobs(id),
  from_status text,
  to_status text not null,
  notes text,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);
create index repair_history_job_idx on public.repair_history (repair_job_id, changed_at);

create table public.replacement_transactions (
  id uuid primary key default gen_random_uuid(),
  replacement_number text not null unique,
  work_order_id uuid not null references public.work_orders(id),
  original_device_id uuid not null references public.devices(id),
  replacement_device_id uuid not null references public.devices(id),
  original_allocation_id uuid not null references public.work_order_devices(id),
  new_allocation_id uuid not null references public.work_order_devices(id),
  original_device_new_status text not null,
  reason text not null,
  authorised_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (original_device_id <> replacement_device_id)
);
create index replacements_wo_idx on public.replacement_transactions (work_order_id);

-- ---------------------------------------------------------------------
-- Invoicing
-- ---------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text unique,
  work_order_id uuid references public.work_orders(id),
  institution_id uuid references public.institutions(id),
  status text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','credited','cancelled')),
  customer_name text not null,
  customer_address text,
  customer_vat_number text,
  emis_number text,
  po_reference text,
  invoice_date date,
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 365),
  due_date date,
  currency text not null default 'ZAR',
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  vat_cents bigint not null default 0,
  total_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  credited_cents bigint not null default 0 check (credited_cents >= 0),
  notes text,
  terms text,
  created_by uuid references public.profiles(id),
  issued_by uuid references public.profiles(id),
  issued_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_number_when_issued check (status in ('draft','cancelled') or invoice_number is not null),
  constraint invoices_paid_not_exceed check (amount_paid_cents + credited_cents <= total_cents or status = 'draft')
);
create index invoices_status_idx on public.invoices (status, invoice_date desc);
create index invoices_wo_idx on public.invoices (work_order_id);
create index invoices_due_idx on public.invoices (due_date) where status in ('issued','partially_paid');

-- Issued invoices are immutable apart from controlled payment/credit/cancel fields.
create or replace function app_private.protect_issued_invoice() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    if (new.subtotal_cents, new.vat_cents, new.total_cents, new.discount_cents, new.customer_name, new.invoice_number,
        coalesce(new.invoice_date, '1900-01-01'), coalesce(new.due_date, '1900-01-01'), new.work_order_id)
       is distinct from
       (old.subtotal_cents, old.vat_cents, old.total_cents, old.discount_cents, old.customer_name, old.invoice_number,
        coalesce(old.invoice_date, '1900-01-01'), coalesce(old.due_date, '1900-01-01'), old.work_order_id) then
      raise exception 'Issued invoice % cannot be edited. Use a credit note for corrections.', old.invoice_number;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger invoices_protect before update on public.invoices
  for each row execute function app_private.protect_issued_invoice();

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  line_no int not null,
  line_type text not null check (line_type in ('device','service','repair','delivery','other')),
  description text not null,
  work_order_line_id uuid references public.work_order_lines(id),
  model_id uuid references public.device_models(id),
  quantity int not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  vat_rate numeric(5,2) not null check (vat_rate >= 0 and vat_rate <= 100),
  line_subtotal_cents bigint not null default 0,
  vat_cents bigint not null default 0,
  line_total_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (invoice_id, line_no),
  check (discount_cents <= quantity * unit_price_cents)
);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

create or replace function app_private.protect_invoice_lines() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status <> 'draft' then
    raise exception 'Lines of an issued invoice cannot be changed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger invoice_lines_protect before insert or update or delete on public.invoice_lines
  for each row execute function app_private.protect_invoice_lines();

-- Links each billable device allocation to exactly one active invoice line.
create table public.invoice_device_links (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  invoice_line_id uuid not null references public.invoice_lines(id),
  work_order_device_id uuid not null references public.work_order_devices(id),
  device_id uuid not null references public.devices(id),
  status text not null default 'active' check (status in ('active','cancelled','credited','replaced')),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index invoice_links_active_uniq on public.invoice_device_links (work_order_device_id) where status = 'active';
create index invoice_links_invoice_idx on public.invoice_device_links (invoice_id);
create index invoice_links_device_idx on public.invoice_device_links (device_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_number text not null unique,
  invoice_id uuid not null references public.invoices(id),
  amount_cents bigint not null check (amount_cents > 0),
  payment_date date not null,
  method text not null default 'eft' check (method in ('eft','cash','cheque','card','journal','other')),
  reference text,
  notes text,
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index payments_invoice_idx on public.payments (invoice_id);

create table public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  credit_note_number text not null unique,
  invoice_id uuid not null references public.invoices(id),
  amount_cents bigint not null check (amount_cents > 0),
  vat_cents bigint not null default 0,
  is_full_credit boolean not null default false,
  reason text not null,
  released_allocations int not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index credit_notes_invoice_idx on public.credit_notes (invoice_id);

-- ---------------------------------------------------------------------
-- Dispatch and delivery
-- ---------------------------------------------------------------------
create table public.dispatches (
  id uuid primary key default gen_random_uuid(),
  dispatch_number text not null unique,
  work_order_id uuid not null references public.work_orders(id),
  origin_warehouse_id uuid not null references public.warehouses(id),
  institution_id uuid not null references public.institutions(id),
  recipient_name text,
  delivery_address text,
  status text not null default 'draft' check (status in ('draft','dispatched','partially_delivered','delivered','failed','returned','cancelled')),
  courier_name text,
  tracking_number text,
  vehicle_registration text,
  driver_name text,
  parcel_count int check (parcel_count is null or parcel_count > 0),
  shipment_notes text,
  dispatch_date date,
  expected_delivery_date date,
  dispatched_at timestamptz,
  dispatched_by uuid references public.profiles(id),
  cancelled_reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index dispatches_status_idx on public.dispatches (status, created_at desc);
create index dispatches_wo_idx on public.dispatches (work_order_id);
alter table public.device_movements add constraint device_movements_dispatch_fk foreign key (dispatch_id) references public.dispatches(id);
alter table public.serial_discrepancies add constraint discrepancies_dispatch_fk foreign key (dispatch_id) references public.dispatches(id);

create table public.dispatch_devices (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references public.dispatches(id),
  device_id uuid not null references public.devices(id),
  work_order_device_id uuid not null references public.work_order_devices(id),
  status text not null default 'loaded' check (status in ('loaded','dispatched','delivered','damaged','missing','rejected','not_delivered','returned','removed')),
  scanned_serial text not null,
  scanned_by uuid references public.profiles(id),
  scanned_at timestamptz not null default now()
);
-- A device can be on only one open manifest at a time.
create unique index dispatch_devices_active_uniq on public.dispatch_devices (device_id) where status in ('loaded','dispatched');
create index dispatch_devices_dispatch_idx on public.dispatch_devices (dispatch_id);

create table public.delivery_confirmations (
  id uuid primary key default gen_random_uuid(),
  delivery_number text not null unique,
  dispatch_id uuid not null references public.dispatches(id),
  work_order_id uuid not null references public.work_orders(id),
  institution_id uuid not null references public.institutions(id),
  outcome text not null check (outcome in ('delivered','partially_delivered','failed','damaged','missing','rejected','returned_to_sender')),
  received_by_name text,
  received_by_role text,
  delivered_at timestamptz not null,
  quantity_expected int not null check (quantity_expected >= 0),
  quantity_received int not null check (quantity_received >= 0),
  quantity_damaged int not null default 0,
  quantity_missing int not null default 0,
  quantity_rejected int not null default 0,
  comments text,
  failure_reason text,
  signature_data text,
  via_recipient_link boolean not null default false,
  recorded_by uuid references public.profiles(id),
  recorded_at timestamptz not null default now(),
  check (quantity_received <= quantity_expected)
);
create unique index delivery_confirmations_dispatch_uniq on public.delivery_confirmations (dispatch_id);
create index delivery_confirmations_wo_idx on public.delivery_confirmations (work_order_id);

create table public.delivery_devices (
  id uuid primary key default gen_random_uuid(),
  delivery_confirmation_id uuid not null references public.delivery_confirmations(id),
  dispatch_device_id uuid not null unique references public.dispatch_devices(id),
  device_id uuid not null references public.devices(id),
  result text not null check (result in ('received','damaged','missing','rejected','not_delivered')),
  serial_confirmed text,
  notes text
);
create index delivery_devices_conf_idx on public.delivery_devices (delivery_confirmation_id);

create table public.proof_of_delivery_files (
  id uuid primary key default gen_random_uuid(),
  delivery_confirmation_id uuid not null references public.delivery_confirmations(id),
  attachment_id uuid not null references public.attachments(id),
  created_at timestamptz not null default now()
);

-- One-time, expiring links that let an external recipient confirm one shipment.
create table public.delivery_tokens (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references public.dispatches(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Returns (reverse logistics)
-- ---------------------------------------------------------------------
create table public.returns (
  id uuid primary key default gen_random_uuid(),
  return_number text not null unique,
  original_work_order_id uuid references public.work_orders(id),
  original_dispatch_id uuid references public.dispatches(id),
  institution_id uuid references public.institutions(id),
  source text not null check (source in ('institution','recipient','courier','repair_provider','other')),
  returned_by_name text,
  return_reason text not null,
  receiving_warehouse_id uuid not null references public.warehouses(id),
  status text not null default 'authorised' check (status in ('authorised','receiving','received','inspected','closed','cancelled')),
  expected_qty int check (expected_qty is null or expected_qty > 0),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index returns_status_idx on public.returns (status, created_at desc);

create table public.return_lines (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.returns(id),
  device_id uuid not null references public.devices(id),
  scanned_serial text not null,
  condition_on_return text not null check (condition_on_return in ('new','good','fair','poor','faulty','damaged','beyond_repair')),
  received_at timestamptz not null default now(),
  received_by uuid references public.profiles(id),
  inspection_outcome text check (inspection_outcome in ('release_to_stock','repair','replacement','quarantine','write_off')),
  inspection_notes text,
  inspected_by uuid references public.profiles(id),
  inspected_at timestamptz,
  notes text,
  unique (return_id, device_id)
);
create index return_lines_device_idx on public.return_lines (device_id);
