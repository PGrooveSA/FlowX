# Roles, permissions and business rules

## How access control works

- **Permissions** (`permissions` table, ~65 codes such as `work_orders.approve`, `invoices.issue`, `dispatch.confirm`)
  are the unit of authorisation. Every database function checks them with `has_permission()`; RLS policies check
  them for reads. Hiding a button in the UI is only a convenience.
- **Roles** are configurable templates (bundles of permissions). Administrators can create and edit roles in
  *User Management → Roles and permissions*. The `administrator` role cannot be edited.
- **Assignments** give a user a role, optionally limited to a **warehouse** and/or **province**. An assignment with
  neither is global scope. Scope limits which devices, stock, receipts, counts, dispatches and work orders are visible
  and actionable (`my_warehouse_ids()` in RLS and `require_warehouse_scope()` in functions).
- **Individual overrides** grant or explicitly deny a single permission for one user (deny wins over roles).
- Deactivated users (`profiles.is_active = false`) lose every permission immediately and are also banned in Auth by
  the `admin-users` edge function, which ends their sessions.

## Role templates shipped

| Role | Purpose |
|---|---|
| Administrator | Everything, including users, roles, settings, audit and master data |
| Standard User | Create/submit work orders, institutions and recipients, register devices, report faults, request adjustments, upload files |
| Invoicer | Invoices: drafts, issue, payments, credit notes, cancel drafts (no allocation changes) |
| Dispatcher | Dispatch manifests, handover confirmation, delivery confirmation, returns |
| Invoicer / Dispatcher | Union of the two above — either half can be removed per user with overrides |
| Warehouse Manager | Scheduling, receiving, transfers, reservations, issuing, adjustments (approve), counts (approve), releases, replacements, discrepancy resolution, completion |
| Warehouse Operator | Receiving, transfers, reservations, picking and issuing, counts, returns, adjustment requests |
| Technician | Assessments and repairs |
| Approver | Work order and amendment approval (incl. large quantities), repair cost approval, completion |
| Auditor | Read-only across modules plus financial reports and the audit trail |
| Read-Only Management | Read-only operational overview |

Sensitive permissions not granted to non-admin templates by default: `devices.correct_identity`,
`inventory.serial_exception` (managers only), `invoices.discount`, `invoices.charges`, `invoices.exempt`,
`work_orders.cancel`, `recipients.view_learners`, `users.manage`, `roles.manage`, `settings.manage`, `master_data.manage`.

## Segregation of duties (configurable in System Settings → Workflow)

- A work order's creator cannot approve it, and a requester cannot approve their own amendment.
- A stock adjustment requester cannot approve it; the person who started and submitted a count cannot approve it.
- A repair job's creator cannot approve its cost.
- A discrepancy cannot be resolved by the user who reported it (administrators excepted).
- Work orders above the large-quantity threshold need `work_orders.approve_large`.

## Workflow states

**Work order:** Draft → Pending Authorisation → (Returned for Correction → resubmit) → Approved → Pending Scheduling →
Scheduled → Scheduled Pending Issuing → Issuing in Progress → Issued → Pending Invoicing → Invoiced → Ready for
Dispatch → Partially Dispatched / Dispatched → Partially Delivered / Delivered → Completed. Cancelled from any
pre-dispatch state. Allowed transitions are data in `work_order_status_transitions`; every change records user,
time, previous/new status and reason in `work_order_status_history`. Invoice-exempt orders go Issued → Ready for
Dispatch, with the exemption reason recorded.

**Device:** Expected, Received, Available, Reserved, Picked, Issued, In Transit, Dispatched, Delivered, Faulty, Under
Assessment, Under Repair, Awaiting Parts, Repair Completed, Returned to Warehouse, Quarantined, Lost, Stolen, Written
Off. A trigger enforces `device_status_transitions` on every update, so contradictory states cannot be written even by
a buggy function.

**Repair:** Repair Requested → Awaiting Assessment → Assessed → Awaiting Approval → Awaiting Parts / Under Repair →
Repair Completed → Quality Check → Ready for Return → Returned to Warehouse / Returned to Recipient → Closed
(`repair_status_transitions`, each with its required permission).

## The non-negotiable rules and where they are enforced

| # | Rule | Enforcement |
|---|---|---|
| 1 | Unique device identity | Unique index on (manufacturer, normalised serial); IMEI unique index; serial changes only via `correct_device_identity` (audited) |
| 2 | No device on two active work orders | Partial unique index on `work_order_devices(device_id)` for reserved/picked/issued/dispatched |
| 3 | Faulty/quarantined/lost/stolen/written-off devices cannot be dispatched | `device_issue_problem()` in reserve/pick/issue; `dispatch_scan_device` and `confirm_dispatch` require status `issued` |
| 4 | Serial mismatch blocks the transaction | `pick_device` / `dispatch_scan_device` record a `serial_discrepancies` row, block the scanned device and block confirmation until resolved |
| 5 | Dispatched only via a dispatch | Only `confirm_dispatch` sets `dispatched`, and only for devices on that manifest |
| 6 | Delivery refers to a real dispatch and manifest | `delivery_confirmations.dispatch_id` (unique), per-device `delivery_devices` rows tied to `dispatch_devices` |
| 7 | Issued invoices are immutable | Trigger blocks changes to totals/lines of non-draft invoices; corrections via `create_credit_note` |
| 8 | Adjustments need reason + authorisation | `request_stock_adjustment` (reason ≥ 5 chars) → `decide_stock_adjustment` (approve permission, SoD) |
| 9 | Replacements keep both histories | `replace_allocated_device` creates `replacement_transactions`; old allocation becomes `replaced` and links to the new one |
| 10 | Partial fulfilment without false completion | Status is recomputed from per-device allocation counts; completion requires all approved devices delivered |
| 11 | Post-approval changes need amendment/reapproval | `request_amendment` → `decide_amendment`; direct edits are refused after Draft/Returned |
| 12 | Backend validation of every critical change | All writes to operational tables go through functions; clients have no INSERT/UPDATE/DELETE privilege on them |
| 13 | No conflicting concurrent reservations/issues/dispatches | Row locks (`SELECT … FOR UPDATE`, deterministic order) plus the partial unique indexes; tested in scenarios D and L |
| 14 | Roles restricted to authorised operations | `require_permission()` in every function, RLS on every table; tested in scenario J |
| 15 | Cancellation/reversal preserves history | `cancel_work_order` releases allocations with `allocation_reversal` movements; nothing is deleted; movements, status history and audit logs are immutable |

Additional rules:

- Stock figures are always calculated from device rows (`v_stock_summary`), never stored.
- A returned device goes to quarantine and needs inspection (`inspect_return_line`) and an authorised
  `release_device_to_stock`; releases are blocked by open repairs, failed QC or uninspected returns.
- Goods receipts cannot complete with quantity differences unless discrepancy notes are recorded; devices without a
  readable serial require `inventory.serial_exception` and a reason.
- Stock counts never adjust stock; missing and unexpected devices become discrepancy records for investigation.
- Invoices: prices come from the model price captured at approval, VAT from settings (default 15%), quantities from
  issued, not-yet-invoiced allocations. One active invoice link per allocation (unique index). Partial invoicing is off
  by default. Full credit notes release the allocations for correct re-invoicing.
- Money is stored as integer cents (`bigint`); timestamps as `timestamptz`, displayed in Africa/Johannesburg.
- Document numbers (`WO-2026-000001`, `INV-…`, `DSP-…`) come from locked sequence rows inside the same transaction, so
  committed numbers are unique and gap-free; the next number can only be increased.

## Privacy (POPIA)

Learner recipients are visible only with `recipients.view_learners` (enforced by RLS). Only the fields needed to
allocate a device are collected (name, learner number, grade, class) and learner records receive a retention review
date (`privacy.learner_retention_months`). Audit entries strip secret-like keys and signature images. The public
delivery link exposes only one shipment's serials, the institution name and EMIS number.
