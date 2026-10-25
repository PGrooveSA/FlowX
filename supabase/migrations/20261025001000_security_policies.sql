-- =====================================================================
-- Row Level Security, table/function privileges and storage policies.
-- Operational tables are read-only to clients: every write goes through
-- the validated SECURITY DEFINER functions defined in earlier migrations.
-- =====================================================================

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- Tables that authorised users may edit directly (RLS limits who and what).
grant insert, update on public.provinces, public.districts, public.warehouses, public.warehouse_locations,
  public.suppliers, public.device_categories, public.device_models, public.work_order_types,
  public.institutions, public.institution_contacts, public.recipients to authenticated;
grant insert on public.attachments to authenticated;
grant insert, update on public.roles to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on function public.get_public_branding() to anon;
grant execute on function public.get_delivery_by_token(text) to anon;
grant execute on function public.confirm_delivery_by_token(text, jsonb) to anon;
grant execute on function public.normalize_serial(text) to anon;

alter default privileges in schema public revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------
-- Helper expressions
--   (select public.has_permission('x'))   is evaluated once per statement.
-- ---------------------------------------------------------------------

-- Identity & RBAC
create policy profiles_read on public.profiles for select to authenticated using ((select public.is_active_user()) or id = auth.uid());
create policy permissions_read on public.permissions for select to authenticated using ((select public.is_active_user()));
create policy roles_read on public.roles for select to authenticated using ((select public.is_active_user()));
create policy roles_write on public.roles for insert to authenticated with check ((select public.has_permission('roles.manage')));
create policy roles_update on public.roles for update to authenticated
  using ((select public.has_permission('roles.manage')) and code <> 'administrator')
  with check ((select public.has_permission('roles.manage')) and code <> 'administrator');
create policy role_permissions_read on public.role_permissions for select to authenticated using ((select public.is_active_user()));
create policy ura_read on public.user_role_assignments for select to authenticated
  using (user_id = auth.uid() or (select public.has_permission('users.manage')));
create policy upo_read on public.user_permission_overrides for select to authenticated
  using (user_id = auth.uid() or (select public.has_permission('users.manage')));

-- Reference / master data: readable by active users, editable with master_data.manage
do $$
declare t text;
begin
  foreach t in array array['provinces','districts','warehouses','warehouse_locations','suppliers','device_categories',
                           'device_models','work_order_types'] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_active_user()))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.has_permission(''master_data.manage'')))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.has_permission(''master_data.manage''))) with check ((select public.has_permission(''master_data.manage'')))', t || '_update', t);
  end loop;
end $$;

create policy settings_read on public.system_settings for select to authenticated using ((select public.is_active_user()));
create policy sequences_read on public.document_sequences for select to authenticated using ((select public.is_active_user()));
create policy wo_transitions_read on public.work_order_status_transitions for select to authenticated using ((select public.is_active_user()));
create policy device_transitions_read on public.device_status_transitions for select to authenticated using ((select public.is_active_user()));
create policy repair_transitions_read on public.repair_status_transitions for select to authenticated using ((select public.is_active_user()));

-- Institutions & recipients (learner PII requires recipients.view_learners)
create policy institutions_read on public.institutions for select to authenticated using (
  (select public.has_permission('institutions.view')) or (select public.has_permission('work_orders.view'))
  or (select public.has_permission('invoices.view')) or (select public.has_permission('dispatch.view'))
  or (select public.has_permission('delivery.view')));
create policy institutions_insert on public.institutions for insert to authenticated with check ((select public.has_permission('institutions.manage')));
create policy institutions_update on public.institutions for update to authenticated
  using ((select public.has_permission('institutions.manage'))) with check ((select public.has_permission('institutions.manage')));
create policy contacts_read on public.institution_contacts for select to authenticated using (exists (select 1 from public.institutions i where i.id = institution_id));
create policy contacts_insert on public.institution_contacts for insert to authenticated with check ((select public.has_permission('institutions.manage')));
create policy contacts_update on public.institution_contacts for update to authenticated
  using ((select public.has_permission('institutions.manage'))) with check ((select public.has_permission('institutions.manage')));
create policy recipients_read on public.recipients for select to authenticated using (
  ((select public.has_permission('institutions.view')) or (select public.has_permission('work_orders.view')))
  and (recipient_type <> 'learner' or (select public.has_permission('recipients.view_learners'))));
create policy recipients_insert on public.recipients for insert to authenticated with check (
  (select public.has_permission('recipients.manage'))
  and (recipient_type <> 'learner' or (select public.has_permission('recipients.view_learners'))));
create policy recipients_update on public.recipients for update to authenticated
  using ((select public.has_permission('recipients.manage')) and (recipient_type <> 'learner' or (select public.has_permission('recipients.view_learners'))))
  with check ((select public.has_permission('recipients.manage')) and (recipient_type <> 'learner' or (select public.has_permission('recipients.view_learners'))));

-- Devices (warehouse scope)
create policy devices_read on public.devices for select to authenticated using (
  ((select public.has_permission('devices.view')) or (select public.has_permission('inventory.view')))
  and warehouse_id = any ((select public.my_warehouse_ids())::uuid[]));
create policy device_identifiers_read on public.device_identifiers for select to authenticated
  using (exists (select 1 from public.devices d where d.id = device_id));
create policy device_movements_read on public.device_movements for select to authenticated
  using (exists (select 1 from public.devices d where d.id = device_id));

-- Work orders (creator, warehouse scope or province scope)
create policy work_orders_read on public.work_orders for select to authenticated using (
  (select public.has_permission('work_orders.view'))
  and (created_by = auth.uid()
       or (select public.has_global_scope())
       or warehouse_id = any ((select public.my_warehouse_ids())::uuid[])
       or province_id = any ((select public.my_province_ids())::uuid[])));
do $$
declare t text;
begin
  foreach t in array array['work_order_lines','work_order_devices','work_order_status_history','work_order_approvals',
                           'work_order_amendments','schedules'] loop
    execute format('create policy %I on public.%I for select to authenticated using (exists (select 1 from public.work_orders w where w.id = work_order_id))', t || '_read', t);
  end loop;
end $$;
create policy replacements_read on public.replacement_transactions for select to authenticated
  using (exists (select 1 from public.work_orders w where w.id = work_order_id));
create policy discrepancies_read on public.serial_discrepancies for select to authenticated using (
  (select public.has_permission('devices.view')) or (select public.has_permission('issuing.pick')) or (select public.has_permission('dispatch.view')));

-- Warehouse operations
create policy goods_receipts_read on public.goods_receipts for select to authenticated using (
  (select public.has_permission('inventory.view')) and warehouse_id = any ((select public.my_warehouse_ids())::uuid[]));
create policy goods_receipt_lines_read on public.goods_receipt_lines for select to authenticated
  using (exists (select 1 from public.goods_receipts g where g.id = goods_receipt_id));
create policy stock_movements_read on public.stock_movements for select to authenticated using (
  (select public.has_permission('inventory.view'))
  and (from_warehouse_id = any ((select public.my_warehouse_ids())::uuid[]) or to_warehouse_id = any ((select public.my_warehouse_ids())::uuid[])));
create policy stock_movement_lines_read on public.stock_movement_lines for select to authenticated
  using (exists (select 1 from public.stock_movements m where m.id = stock_movement_id));
create policy stock_counts_read on public.stock_counts for select to authenticated using (
  (select public.has_permission('inventory.view')) and warehouse_id = any ((select public.my_warehouse_ids())::uuid[]));
create policy stock_count_lines_read on public.stock_count_lines for select to authenticated
  using (exists (select 1 from public.stock_counts c where c.id = stock_count_id));

-- Assessments & repairs
create policy assessments_read on public.device_assessments for select to authenticated using ((select public.has_permission('assessments.view')));
create policy repairs_read on public.repair_jobs for select to authenticated using ((select public.has_permission('assessments.view')));
create policy repair_parts_read on public.repair_parts for select to authenticated using ((select public.has_permission('assessments.view')));
create policy repair_history_read on public.repair_history for select to authenticated using ((select public.has_permission('assessments.view')));

-- Finance
create policy invoices_read on public.invoices for select to authenticated using (
  (select public.has_permission('invoices.view')) or (select public.has_permission('reports.financial')));
do $$
declare t text;
begin
  foreach t in array array['invoice_lines','invoice_device_links','payments','credit_notes'] loop
    execute format('create policy %I on public.%I for select to authenticated using (exists (select 1 from public.invoices i where i.id = invoice_id))', t || '_read', t);
  end loop;
end $$;

-- Dispatch & delivery
create policy dispatches_read on public.dispatches for select to authenticated using (
  ((select public.has_permission('dispatch.view')) or (select public.has_permission('delivery.view')))
  and origin_warehouse_id = any ((select public.my_warehouse_ids())::uuid[]));
create policy dispatch_devices_read on public.dispatch_devices for select to authenticated
  using (exists (select 1 from public.dispatches d where d.id = dispatch_id));
create policy delivery_confirmations_read on public.delivery_confirmations for select to authenticated
  using (exists (select 1 from public.dispatches d where d.id = dispatch_id));
create policy delivery_devices_read on public.delivery_devices for select to authenticated
  using (exists (select 1 from public.delivery_confirmations c where c.id = delivery_confirmation_id));
create policy pod_files_read on public.proof_of_delivery_files for select to authenticated
  using (exists (select 1 from public.delivery_confirmations c where c.id = delivery_confirmation_id));
-- delivery_tokens: no client policies (hashes only reachable through definer functions)

-- Returns
create policy returns_read on public.returns for select to authenticated using (
  ((select public.has_permission('returns.manage')) or (select public.has_permission('inventory.view')))
  and receiving_warehouse_id = any ((select public.my_warehouse_ids())::uuid[]));
create policy return_lines_read on public.return_lines for select to authenticated
  using (exists (select 1 from public.returns r where r.id = return_id));

-- Attachments: visible when the parent record is visible
create policy attachments_read on public.attachments for select to authenticated using (
  case entity_type
    when 'work_order' then exists (select 1 from public.work_orders x where x.id = entity_id)
    when 'device' then exists (select 1 from public.devices x where x.id = entity_id)
    when 'assessment' then exists (select 1 from public.device_assessments x where x.id = entity_id)
    when 'repair' then exists (select 1 from public.repair_jobs x where x.id = entity_id)
    when 'invoice' then exists (select 1 from public.invoices x where x.id = entity_id)
    when 'dispatch' then exists (select 1 from public.dispatches x where x.id = entity_id)
    when 'delivery' then exists (select 1 from public.delivery_confirmations x where x.id = entity_id)
    when 'return' then exists (select 1 from public.returns x where x.id = entity_id)
    when 'goods_receipt' then exists (select 1 from public.goods_receipts x where x.id = entity_id)
    when 'stock_count' then exists (select 1 from public.stock_counts x where x.id = entity_id)
    when 'institution' then exists (select 1 from public.institutions x where x.id = entity_id)
    else false end);
create policy attachments_insert on public.attachments for insert to authenticated with check (
  (select public.has_permission('attachments.upload')) and uploaded_by = auth.uid() and bucket = 'attachments'
  and storage_path like entity_type || '/' || entity_id::text || '/%');

-- Notifications: own only (updates go through mark_notifications_read)
create policy notifications_read on public.notifications for select to authenticated using (user_id = auth.uid());

-- Audit trail: append-only, readable with audit.view
create policy audit_read on public.audit_logs for select to authenticated using ((select public.has_permission('audit.view')));

-- ---------------------------------------------------------------------
-- Storage: private bucket for attachments and proof of delivery
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf','text/csv',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

create policy "attachments upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'attachments' and public.has_permission('attachments.upload'));
create policy "attachments read" on storage.objects for select to authenticated using (
  bucket_id = 'attachments' and exists (select 1 from public.attachments a where a.storage_path = name));
