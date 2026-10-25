-- =====================================================================
-- Assessments, repairs and returns
-- =====================================================================

create or replace function public.start_assessment(p_assessment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.device_assessments; d public.devices;
begin
  perform app_private.require_permission('assessments.record');
  select * into a from device_assessments where id = p_assessment_id for update;
  if not found then raise exception 'Assessment not found'; end if;
  if a.status <> 'pending' then raise exception 'Assessment % is already %', a.assessment_number, a.status; end if;
  select * into d from devices where id = a.device_id for update;
  if exists (select 1 from work_order_devices where device_id = d.id and status = 'delivered') then
    raise exception 'Device % is at the institution. Receive it through Returns before assessing it.', coalesce(d.serial_number, d.asset_tag);
  end if;
  if d.status <> 'under_assessment' then
    perform app_private.move_device(d.id, 'under_assessment', 'assessment_started', jsonb_build_object('reference', a.assessment_number));
  end if;
  update device_assessments set status = 'in_progress', technician_id = auth.uid() where id = a.id;
  perform app_private.audit('start_assessment', 'assessment', a.id::text, null, null, null, jsonb_build_object('device_id', d.id));
end $$;

create or replace function public.complete_assessment(p_assessment_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.device_assessments;
  d public.devices;
  v_outcome text := p ->> 'outcome';
  v_cost bigint := nullif(p ->> 'estimated_cost_cents', '')::bigint;
  v_needs_approval boolean;
  v_repair_id uuid;
  v_repair_number text;
  v_adjustment uuid;
begin
  perform app_private.require_permission('assessments.record');
  select * into a from device_assessments where id = p_assessment_id for update;
  if not found then raise exception 'Assessment not found'; end if;
  if a.status = 'pending' then
    perform public.start_assessment(a.id);
  elsif a.status <> 'in_progress' then
    raise exception 'Assessment % is %', a.assessment_number, a.status;
  end if;
  if v_outcome not in ('no_fault_found','repair_required','replacement_recommended','warranty_claim','scrap_recommended','return_to_service') then
    raise exception 'Select an assessment outcome';
  end if;
  if length(trim(coalesce(p ->> 'diagnostic_results', ''))) < 5 then raise exception 'Record the diagnostic results'; end if;
  select * into d from devices where id = a.device_id for update;

  v_needs_approval := v_outcome in ('repair_required','warranty_claim')
                      and coalesce(v_cost, 0) > app_private.setting_num('repair.approval_threshold_cents', 150000);

  update device_assessments set status = 'completed', outcome = v_outcome,
    physical_condition = nullif(p ->> 'physical_condition', ''), diagnostic_results = p ->> 'diagnostic_results',
    recommended_action = nullif(p ->> 'recommended_action', ''), estimated_cost_cents = v_cost,
    warranty_status = coalesce(nullif(p ->> 'warranty_status', ''),
      case when d.warranty_expires_on >= current_date then 'in_warranty' when d.warranty_expires_on is null then 'unknown' else 'out_of_warranty' end),
    approval_status = case when v_needs_approval then 'pending' else 'not_required' end,
    technician_id = coalesce(technician_id, auth.uid()), assessed_at = now()
  where id = a.id;

  if v_outcome in ('no_fault_found','return_to_service') then
    perform app_private.move_device(d.id, 'returned_to_warehouse', 'assessment_cleared',
      jsonb_build_object('reference', a.assessment_number, 'reason', 'Assessment: ' || app_private.label(v_outcome),
        'condition', coalesce(nullif(p ->> 'condition', ''), 'good')));
  elsif v_outcome in ('repair_required','warranty_claim') then
    v_repair_number := app_private.next_document_number('repair');
    insert into repair_jobs (repair_number, device_id, assessment_id, work_order_id, status, fault_description, provider_type,
                             external_provider, warranty_claim_reference, technician_id, estimated_cost_cents, created_by)
    values (v_repair_number, d.id, a.id, a.work_order_id, case when v_needs_approval then 'awaiting_approval' else 'assessed' end,
            a.reported_fault, case when v_outcome = 'warranty_claim' then 'warranty' else coalesce(nullif(p ->> 'provider_type', ''), 'internal') end,
            nullif(p ->> 'external_provider', ''), nullif(p ->> 'warranty_claim_reference', ''), auth.uid(), v_cost, auth.uid())
    returning id into v_repair_id;
    insert into repair_history (repair_job_id, from_status, to_status, notes, changed_by)
    values (v_repair_id, null, case when v_needs_approval then 'awaiting_approval' else 'assessed' end, 'Created from ' || a.assessment_number, auth.uid());
    if v_needs_approval then
      perform app_private.notify_permission('repairs.approve', 'Repair approval required: ' || v_repair_number,
        format('Estimated cost exceeds the approval threshold for %s', coalesce(d.serial_number, d.asset_tag)),
        '/repairs/' || v_repair_id, 'repair', 'warning', 'repair', v_repair_id, d.warehouse_id);
    end if;
  elsif v_outcome = 'replacement_recommended' then
    perform app_private.move_device(d.id, 'faulty', 'assessment_replacement',
      jsonb_build_object('reference', a.assessment_number, 'reason', 'Replacement recommended', 'condition', 'faulty'));
  elsif v_outcome = 'scrap_recommended' then
    perform app_private.move_device(d.id, 'faulty', 'assessment_scrap',
      jsonb_build_object('reference', a.assessment_number, 'reason', 'Scrap / write-off recommended', 'condition', 'beyond_repair'));
    if public.has_permission('inventory.adjust_request') then
      v_adjustment := public.request_stock_adjustment(d.id, 'write_off', 'Assessment ' || a.assessment_number || ' recommends write-off');
    end if;
  end if;

  perform app_private.audit('complete_assessment', 'assessment', a.id::text, null,
    jsonb_build_object('outcome', v_outcome, 'repair', v_repair_number), null, jsonb_build_object('device_id', d.id, 'work_order_id', a.work_order_id));
  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'repair_id', v_repair_id, 'repair_number', v_repair_number,
    'needs_approval', v_needs_approval, 'write_off_request_id', v_adjustment);
end $$;

create or replace function public.decide_repair_approval(p_repair_id uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.repair_jobs;
begin
  perform app_private.require_permission('repairs.approve');
  select * into r from repair_jobs where id = p_repair_id for update;
  if not found then raise exception 'Repair job not found'; end if;
  if r.status <> 'awaiting_approval' then raise exception 'Repair % is not awaiting approval', r.repair_number; end if;
  if r.created_by = auth.uid() then
    raise exception 'Segregation of duties: you cannot approve a repair you created' using errcode = '42501';
  end if;
  if not p_approve and length(trim(coalesce(p_comment, ''))) < 5 then raise exception 'A reason is required to reject a repair'; end if;
  update repair_jobs set status = case when p_approve then 'assessed' else 'cancelled' end,
    approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = r.id;
  update device_assessments set approval_status = case when p_approve then 'approved' else 'rejected' end,
    approved_by = auth.uid(), approved_at = now() where id = r.assessment_id;
  insert into repair_history (repair_job_id, from_status, to_status, notes, changed_by)
  values (r.id, r.status, case when p_approve then 'assessed' else 'cancelled' end, coalesce(p_comment, case when p_approve then 'Approved' else 'Rejected' end), auth.uid());
  if not p_approve then
    perform app_private.move_device(r.device_id, 'faulty', 'repair_rejected', jsonb_build_object('reference', r.repair_number, 'reason', p_comment));
  end if;
  perform app_private.audit(case when p_approve then 'approve_repair' else 'reject_repair' end, 'repair', r.id::text, null, null, p_comment,
    jsonb_build_object('device_id', r.device_id));
  perform app_private.notify_user(r.created_by, 'Repair ' || case when p_approve then 'approved: ' else 'rejected: ' end || r.repair_number,
    p_comment, '/repairs/' || r.id, 'repair', case when p_approve then 'success' else 'warning' end, 'repair', r.id);
end $$;

create or replace function public.advance_repair(p_repair_id uuid, p_to_status text, p jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.repair_jobs;
  t public.repair_status_transitions;
  d public.devices;
  v_inst uuid;
begin
  select * into r from repair_jobs where id = p_repair_id for update;
  if not found then raise exception 'Repair job not found'; end if;
  select * into t from repair_status_transitions where from_status = r.status and to_status = p_to_status;
  if not found then
    raise exception 'Repair % cannot move from "%" to "%"', r.repair_number, app_private.label(r.status), app_private.label(p_to_status);
  end if;
  perform app_private.require_permission(t.permission_code);
  select * into d from devices where id = r.device_id for update;

  if p_to_status = 'under_repair' then
    if d.status <> 'under_repair' then
      perform app_private.move_device(d.id, 'under_repair', 'repair_started', jsonb_build_object('reference', r.repair_number));
    end if;
    update repair_jobs set started_at = coalesce(started_at, now()) where id = r.id;
  elsif p_to_status = 'awaiting_parts' then
    perform app_private.move_device(d.id, 'awaiting_parts', 'awaiting_parts', jsonb_build_object('reference', r.repair_number, 'reason', p ->> 'notes'));
  elsif p_to_status = 'repair_completed' then
    if coalesce(p ->> 'final_condition', '') not in ('new','good','fair','poor','faulty','damaged','beyond_repair') then
      raise exception 'Record the final device condition';
    end if;
    update repair_jobs set completed_at = now(), final_condition = p ->> 'final_condition',
      labour_cost_cents = coalesce(nullif(p ->> 'labour_cost_cents', '')::bigint, labour_cost_cents),
      technician_notes = coalesce(nullif(p ->> 'technician_notes', ''), technician_notes) where id = r.id;
    perform app_private.move_device(d.id, 'repair_completed', 'repair_completed',
      jsonb_build_object('reference', r.repair_number, 'condition', p ->> 'final_condition'));
  elsif p_to_status = 'ready_for_return' then
    if coalesce(p ->> 'qc_result', '') <> 'pass' then
      raise exception 'Quality check must pass before the device is ready for return';
    end if;
    update repair_jobs set qc_result = 'pass', qc_notes = p ->> 'qc_notes', qc_by = auth.uid(), qc_at = now() where id = r.id;
  elsif p_to_status = 'under_repair' or (r.status = 'quality_check' and p_to_status = 'under_repair') then
    null;
  elsif p_to_status = 'returned_to_warehouse' then
    if p ? 'location_id' and nullif(p ->> 'location_id', '') is not null then
      perform app_private.move_device(d.id, 'returned_to_warehouse', 'returned_from_repair',
        jsonb_build_object('reference', r.repair_number, 'to_location_id', p ->> 'location_id'));
    else
      perform app_private.move_device(d.id, 'returned_to_warehouse', 'returned_from_repair', jsonb_build_object('reference', r.repair_number));
    end if;
  elsif p_to_status = 'returned_to_recipient' then
    select coalesce(a.institution_id, wo.institution_id) into v_inst
    from repair_jobs rj left join device_assessments a on a.id = rj.assessment_id left join work_orders wo on wo.id = rj.work_order_id
    where rj.id = r.id;
    if v_inst is null then raise exception 'This repair is not linked to an institution; return it to the warehouse instead'; end if;
    perform app_private.move_device(d.id, 'delivered', 'returned_to_recipient',
      jsonb_build_object('reference', r.repair_number, 'assign_institution_id', v_inst, 'to_location_id', null));
  elsif p_to_status = 'cancelled' then
    perform app_private.move_device(d.id, 'faulty', 'repair_cancelled', jsonb_build_object('reference', r.repair_number, 'reason', p ->> 'notes'));
  end if;

  if r.status = 'quality_check' and p_to_status = 'under_repair' then
    update repair_jobs set qc_result = 'fail', qc_notes = p ->> 'qc_notes', qc_by = auth.uid(), qc_at = now() where id = r.id;
  end if;

  update repair_jobs set status = p_to_status, updated_at = now(),
    technician_notes = case when p ? 'technician_notes' and p_to_status <> 'repair_completed'
                            then concat_ws(E'\n', technician_notes, p ->> 'technician_notes') else technician_notes end
  where id = r.id;
  insert into repair_history (repair_job_id, from_status, to_status, notes, changed_by)
  values (r.id, r.status, p_to_status, coalesce(p ->> 'notes', p ->> 'qc_notes', p ->> 'technician_notes'), auth.uid());
  perform app_private.audit('repair_status', 'repair', r.id::text, jsonb_build_object('status', r.status),
    jsonb_build_object('status', p_to_status), p ->> 'notes', jsonb_build_object('device_id', d.id, 'work_order_id', r.work_order_id));
end $$;

create or replace function public.add_repair_part(p_repair_id uuid, p_part_name text, p_part_number text, p_quantity int, p_unit_cost_cents bigint)
returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.repair_jobs; v_id uuid;
begin
  perform app_private.require_permission('repairs.manage');
  select * into r from repair_jobs where id = p_repair_id for update;
  if not found then raise exception 'Repair job not found'; end if;
  if r.status not in ('assessed','awaiting_parts','under_repair') then raise exception 'Parts can only be recorded on an active repair'; end if;
  if length(trim(coalesce(p_part_name, ''))) = 0 or coalesce(p_quantity, 0) < 1 or coalesce(p_unit_cost_cents, -1) < 0 then
    raise exception 'Enter a part name, a quantity of at least 1 and a cost of zero or more';
  end if;
  insert into repair_parts (repair_job_id, part_name, part_number, quantity, unit_cost_cents, added_by)
  values (r.id, trim(p_part_name), nullif(trim(p_part_number), ''), p_quantity, p_unit_cost_cents, auth.uid()) returning id into v_id;
  perform app_private.audit('add_repair_part', 'repair', r.id::text, null,
    jsonb_build_object('part', p_part_name, 'qty', p_quantity, 'unit_cost_cents', p_unit_cost_cents), null, jsonb_build_object('device_id', r.device_id));
  return v_id;
end $$;

-- =====================================================================
-- Returns
-- =====================================================================
create or replace function public.create_return(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_wh uuid := nullif(p ->> 'receiving_warehouse_id', '')::uuid;
  v_dispatch public.dispatches;
  v_wo uuid := nullif(p ->> 'original_work_order_id', '')::uuid;
  v_inst uuid := nullif(p ->> 'institution_id', '')::uuid;
begin
  perform app_private.require_permission('returns.manage');
  if not exists (select 1 from warehouses where id = v_wh and is_active) then raise exception 'Select the receiving warehouse'; end if;
  perform app_private.require_warehouse_scope(v_wh);
  if length(trim(coalesce(p ->> 'return_reason', ''))) < 5 then raise exception 'A return reason is required'; end if;
  if coalesce(p ->> 'source', '') not in ('institution','recipient','courier','repair_provider','other') then
    raise exception 'Select the return source';
  end if;
  if nullif(p ->> 'original_dispatch_id', '') is not null then
    select * into v_dispatch from dispatches where id = (p ->> 'original_dispatch_id')::uuid;
    if not found then raise exception 'Original dispatch not found'; end if;
    v_wo := v_dispatch.work_order_id;
    v_inst := coalesce(v_inst, v_dispatch.institution_id);
  end if;
  insert into returns (return_number, original_work_order_id, original_dispatch_id, institution_id, source, returned_by_name,
                       return_reason, receiving_warehouse_id, expected_qty, notes, created_by)
  values (app_private.next_document_number('return'), v_wo, v_dispatch.id, v_inst, p ->> 'source', nullif(p ->> 'returned_by_name', ''),
          p ->> 'return_reason', v_wh, nullif(p ->> 'expected_qty', '')::int, nullif(p ->> 'notes', ''), auth.uid())
  returning id into v_id;
  perform app_private.audit('create_return', 'return', v_id::text, null, p, null, jsonb_build_object('work_order_id', v_wo, 'dispatch_id', v_dispatch.id));
  return v_id;
end $$;

create or replace function public.receive_return_device(p_return_id uuid, p_serial text, p_condition text, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rt public.returns;
  d public.devices;
  v_ids uuid[];
  a public.work_order_devices;
  v_loc uuid;
  v_wo uuid;
begin
  perform app_private.require_permission('returns.manage');
  select * into rt from returns where id = p_return_id for update;
  if not found then raise exception 'Return not found'; end if;
  perform app_private.require_warehouse_scope(rt.receiving_warehouse_id);
  if rt.status not in ('authorised','receiving') then raise exception 'Return % is %', rt.return_number, rt.status; end if;
  if p_condition not in ('new','good','fair','poor','faulty','damaged','beyond_repair') then raise exception 'Record the condition on return'; end if;

  v_ids := app_private.find_scanned_device(p_serial, rt.original_work_order_id);
  if v_ids is null or cardinality(v_ids) <> 1 then
    return app_private.record_discrepancy('return', 'unknown_serial',
      format('Returned serial %s does not identify exactly one registered device on return %s', p_serial, rt.return_number),
      rt.original_work_order_id, rt.original_dispatch_id, null, null, p_serial, null);
  end if;
  select * into d from devices where id = v_ids[1] for update;
  if exists (select 1 from return_lines where return_id = rt.id and device_id = d.id) then
    return jsonb_build_object('ok', false, 'code', 'duplicate_scan', 'message', format('%s is already on this return', p_serial));
  end if;
  if rt.original_dispatch_id is not null and not exists
     (select 1 from dispatch_devices where dispatch_id = rt.original_dispatch_id and device_id = d.id) then
    return app_private.record_discrepancy('return', 'not_on_original_dispatch',
      format('Device %s was not on the original dispatch for return %s', p_serial, rt.return_number),
      rt.original_work_order_id, rt.original_dispatch_id, null, null, p_serial, d.id);
  end if;
  if d.status not in ('dispatched','delivered','faulty','lost','stolen') then
    return app_private.scan_fail('return', 'not_returnable',
      format('Device %s is "%s" in the system and is not expected back', p_serial, app_private.label(d.status)),
      jsonb_build_object('device_id', d.id, 'scanned_serial', p_serial));
  end if;
  if d.status = 'faulty' and d.current_institution_id is null then
    return app_private.scan_fail('return', 'not_returnable', format('Device %s is already in a warehouse', p_serial),
      jsonb_build_object('device_id', d.id, 'scanned_serial', p_serial));
  end if;

  select * into a from work_order_devices where device_id = d.id and status in ('dispatched','delivered') order by created_at desc limit 1 for update;
  if found then
    update work_order_devices set status = 'returned', released_at = now(), released_by = auth.uid(),
      release_reason = 'Returned on ' || rt.return_number || ': ' || rt.return_reason where id = a.id;
    v_wo := a.work_order_id;
  end if;
  update dispatch_devices set status = 'returned' where device_id = d.id and status in ('dispatched','rejected','not_delivered','damaged','missing');

  select id into v_loc from warehouse_locations where warehouse_id = rt.receiving_warehouse_id and is_active
    and location_type in ('returns','quarantine') order by case location_type when 'returns' then 0 else 1 end limit 1;
  perform app_private.move_device(d.id, 'returned_to_warehouse', 'returned',
    jsonb_build_object('reference', rt.return_number, 'reason', rt.return_reason, 'to_warehouse_id', rt.receiving_warehouse_id,
      'to_location_id', v_loc, 'condition', p_condition, 'work_order_id', v_wo,
      'assign_work_order_id', null, 'assign_institution_id', null, 'assign_recipient_id', null));
  insert into return_lines (return_id, device_id, scanned_serial, condition_on_return, received_by, notes)
  values (rt.id, d.id, p_serial, p_condition, auth.uid(), p_notes);
  update returns set status = 'receiving' where id = rt.id and status = 'authorised';
  if v_wo is not null then
    perform app_private.recompute_fulfilment(v_wo);
  end if;
  perform app_private.audit('receive_return', 'return', rt.id::text, jsonb_build_object('device_status', d.status),
    jsonb_build_object('serial', p_serial, 'condition', p_condition), rt.return_reason, jsonb_build_object('device_id', d.id, 'work_order_id', v_wo));
  return jsonb_build_object('ok', true, 'message', format('%s received into quarantine on %s', p_serial, rt.return_number), 'device_id', d.id);
end $$;

create or replace function public.inspect_return_line(p_line_id uuid, p_outcome text, p_notes text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ln public.return_lines;
  rt public.returns;
  d public.devices;
  v_assessment uuid;
  v_adjustment uuid;
begin
  perform app_private.require_permission('returns.manage');
  select * into ln from return_lines where id = p_line_id for update;
  if not found then raise exception 'Return line not found'; end if;
  if ln.inspection_outcome is not null then raise exception 'This device has already been inspected'; end if;
  if p_outcome not in ('release_to_stock','repair','replacement','quarantine','write_off') then raise exception 'Select an inspection outcome'; end if;
  if length(trim(coalesce(p_notes, ''))) < 5 then raise exception 'Record the inspection notes'; end if;
  select * into rt from returns where id = ln.return_id for update;
  select * into d from devices where id = ln.device_id for update;
  if p_outcome = 'release_to_stock' and ln.condition_on_return not in ('new','good','fair') then
    raise exception 'A device returned in "%" condition cannot be released to stock without repair', app_private.label(ln.condition_on_return);
  end if;

  update return_lines set inspection_outcome = p_outcome, inspection_notes = p_notes, inspected_by = auth.uid(), inspected_at = now()
  where id = ln.id;

  if p_outcome in ('repair','replacement') then
    perform app_private.move_device(d.id, 'faulty', 'return_inspection', jsonb_build_object('reference', rt.return_number, 'reason', p_notes, 'condition', 'faulty'));
    insert into device_assessments (assessment_number, device_id, work_order_id, institution_id, origin, reported_fault, reported_by)
    values (app_private.next_document_number('assessment'), d.id, rt.original_work_order_id, rt.institution_id,
            'Return ' || rt.return_number, p_notes, auth.uid()) returning id into v_assessment;
  elsif p_outcome = 'quarantine' then
    perform app_private.move_device(d.id, 'quarantined', 'return_inspection', jsonb_build_object('reference', rt.return_number, 'reason', p_notes));
  elsif p_outcome = 'write_off' then
    if public.has_permission('inventory.adjust_request') then
      v_adjustment := public.request_stock_adjustment(d.id, 'write_off', 'Return inspection ' || rt.return_number || ': ' || p_notes);
    end if;
  end if;

  if not exists (select 1 from return_lines where return_id = rt.id and inspection_outcome is null) then
    update returns set status = 'inspected' where id = rt.id;
  end if;
  perform app_private.audit('inspect_return', 'return', rt.id::text, null, jsonb_build_object('outcome', p_outcome), p_notes,
    jsonb_build_object('device_id', d.id));
  return jsonb_build_object('ok', true, 'assessment_id', v_assessment, 'write_off_request_id', v_adjustment);
end $$;

create or replace function public.close_return(p_return_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rt public.returns;
begin
  perform app_private.require_permission('returns.manage');
  select * into rt from returns where id = p_return_id for update;
  if not found then raise exception 'Return not found'; end if;
  if rt.status <> 'inspected' then raise exception 'All returned devices must be inspected before the return is closed'; end if;
  update returns set status = 'closed', closed_at = now() where id = rt.id;
  perform app_private.audit('close_return', 'return', rt.id::text);
end $$;
