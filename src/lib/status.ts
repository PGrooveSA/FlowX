export type Tone = 'gray' | 'blue' | 'indigo' | 'amber' | 'green' | 'red' | 'purple' | 'teal' | 'orange';

const WO: Record<string, Tone> = {
  draft: 'gray', pending_authorisation: 'amber', returned_for_correction: 'orange', approved: 'blue',
  pending_scheduling: 'amber', scheduled: 'blue', scheduled_pending_issuing: 'indigo', issuing_in_progress: 'indigo',
  issued: 'teal', pending_invoicing: 'amber', invoiced: 'teal', ready_for_dispatch: 'purple', partially_dispatched: 'purple',
  dispatched: 'purple', partially_delivered: 'orange', delivered: 'green', completed: 'green', cancelled: 'red',
};
const DEVICE: Record<string, Tone> = {
  expected: 'gray', received: 'blue', available: 'green', reserved: 'indigo', picked: 'indigo', issued: 'teal',
  in_transit: 'purple', dispatched: 'purple', delivered: 'green', faulty: 'red', under_assessment: 'amber', under_repair: 'amber',
  awaiting_parts: 'orange', repair_completed: 'teal', returned_to_warehouse: 'blue', quarantined: 'orange', lost: 'red',
  stolen: 'red', written_off: 'gray',
};
const GENERIC: Record<string, Tone> = {
  // invoices
  issued: 'blue', partially_paid: 'amber', paid: 'green', credited: 'gray', overdue: 'red',
  not_required: 'gray', not_invoiced: 'amber', partially_invoiced: 'orange', invoiced: 'green',
  // dispatch & delivery
  in_transit: 'purple', not_dispatched: 'gray', failed: 'red', returned: 'orange', rejected: 'red', damaged: 'red', missing: 'red',
  returned_to_sender: 'orange', received: 'green', not_delivered: 'red', loaded: 'indigo', removed: 'gray',
  // generic workflow
  open: 'amber', resolved: 'green', dismissed: 'gray', requested: 'amber', completed: 'green', approved: 'green', applied: 'green',
  pending: 'amber', in_progress: 'indigo', submitted: 'blue', authorised: 'blue', receiving: 'indigo', inspected: 'teal',
  closed: 'gray', cancelled: 'red', active: 'green', inactive: 'gray', completed_with_discrepancies: 'orange',
  // repairs
  repair_requested: 'amber', awaiting_assessment: 'amber', assessed: 'blue', awaiting_approval: 'amber', awaiting_parts: 'orange',
  under_repair: 'amber', repair_completed: 'teal', quality_check: 'indigo', ready_for_return: 'teal', returned_to_warehouse: 'blue',
  returned_to_recipient: 'green',
  // allocations
  reserved: 'indigo', picked: 'indigo', replaced: 'gray', released: 'gray',
  info: 'blue', success: 'green', warning: 'amber', critical: 'red',
};

export function toneFor(kind: 'wo' | 'device' | 'generic', status: string | null | undefined): Tone {
  if (!status) return 'gray';
  const map = kind === 'wo' ? WO : kind === 'device' ? DEVICE : GENERIC;
  return map[status] ?? GENERIC[status] ?? WO[status] ?? 'gray';
}

export const WORK_ORDER_STATUSES = Object.keys(WO);
export const DEVICE_STATUSES = Object.keys(DEVICE);
export const DEVICE_CONDITIONS = ['new', 'good', 'fair', 'poor', 'faulty', 'damaged', 'beyond_repair'];
export const RECIPIENT_TYPES = ['learner', 'teacher', 'school', 'department', 'other'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
