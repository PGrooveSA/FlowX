import {
  LayoutDashboard, ClipboardList, Cpu, Warehouse, ArrowLeftRight, Stethoscope, Wrench,
  Receipt, Truck, ClipboardCheck, BarChart3, Bell, Users, ScrollText, Settings, Undo2, ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** The item is shown if the user holds ANY of these permissions. */
  anyOf: string[];
  group: 'Operations' | 'Warehouse' | 'Finance & logistics' | 'Insights' | 'Administration';
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard, anyOf: ['dashboard.view'], group: 'Operations' },
  { label: 'Work Orders', to: '/work-orders', icon: ClipboardList, anyOf: ['work_orders.view'], group: 'Operations' },
  { label: 'Device Register', to: '/devices', icon: Cpu, anyOf: ['devices.view'], group: 'Warehouse' },
  { label: 'Warehouse Inventory', to: '/warehouse', icon: Warehouse, anyOf: ['inventory.view'], group: 'Warehouse' },
  { label: 'Stock Movements', to: '/movements', icon: ArrowLeftRight, anyOf: ['inventory.view'], group: 'Warehouse' },
  { label: 'Device Assessments', to: '/assessments', icon: Stethoscope, anyOf: ['assessments.view'], group: 'Warehouse' },
  { label: 'Repairs', to: '/repairs', icon: Wrench, anyOf: ['assessments.view'], group: 'Warehouse' },
  { label: 'Returns', to: '/returns', icon: Undo2, anyOf: ['returns.manage'], group: 'Warehouse' },
  { label: 'Discrepancies', to: '/discrepancies', icon: ShieldAlert, anyOf: ['devices.view', 'dispatch.view'], group: 'Warehouse' },
  { label: 'Invoicing', to: '/invoicing', icon: Receipt, anyOf: ['invoices.view'], group: 'Finance & logistics' },
  { label: 'Dispatch', to: '/dispatch', icon: Truck, anyOf: ['dispatch.view'], group: 'Finance & logistics' },
  { label: 'Delivery Confirmation', to: '/delivery', icon: ClipboardCheck, anyOf: ['delivery.view'], group: 'Finance & logistics' },
  { label: 'Reports & Analytics', to: '/reports', icon: BarChart3, anyOf: ['reports.view'], group: 'Insights' },
  { label: 'Notifications', to: '/notifications', icon: Bell, anyOf: [], group: 'Insights' },
  { label: 'Audit Trail', to: '/audit', icon: ScrollText, anyOf: ['audit.view'], group: 'Insights' },
  { label: 'User Management', to: '/admin/users', icon: Users, anyOf: ['users.manage', 'roles.manage'], group: 'Administration' },
  { label: 'System Settings', to: '/admin/settings', icon: Settings, anyOf: ['settings.manage', 'master_data.manage'], group: 'Administration' },
];

export function visibleNav(can: (p: string) => boolean) {
  return NAV_ITEMS.filter((i) => i.anyOf.length === 0 || i.anyOf.some(can));
}
