import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/lib/api';

export interface Warehouse { id: string; code: string; name: string; province_id: string; is_active: boolean }
export interface Province { id: string; code: string; name: string }
export interface District { id: string; code: string; name: string; province_id: string }
export interface Category { id: string; code: string; name: string; requires_serial: boolean; requires_imei: boolean; is_active: boolean }
export interface Model { id: string; category_id: string; manufacturer: string; model_name: string; model_code: string; unit_price_cents: number; warranty_months: number; low_stock_threshold: number; is_active: boolean }
export interface WorkOrderType { id: string; code: string; name: string; requires_invoice: boolean; is_active: boolean; sort_order: number }
export interface Location { id: string; warehouse_id: string; code: string; location_type: string; is_active: boolean }
export interface Supplier { id: string; code: string; name: string }
export interface UserLite { id: string; full_name: string; email: string; is_active: boolean }

const stale = { staleTime: 5 * 60_000 };

export const useWarehouses = () => useQuery({ queryKey: ['lookup', 'warehouses'], ...stale, queryFn: () => fetchAll<Warehouse>('warehouses', '*', (q) => q.order('code')) });
export const useProvinces = () => useQuery({ queryKey: ['lookup', 'provinces'], ...stale, queryFn: () => fetchAll<Province>('provinces', '*', (q) => q.order('name')) });
export const useDistricts = () => useQuery({ queryKey: ['lookup', 'districts'], ...stale, queryFn: () => fetchAll<District>('districts', '*', (q) => q.order('name')) });
export const useCategories = () => useQuery({ queryKey: ['lookup', 'categories'], ...stale, queryFn: () => fetchAll<Category>('device_categories', '*', (q) => q.order('name')) });
export const useModels = () => useQuery({ queryKey: ['lookup', 'models'], ...stale, queryFn: () => fetchAll<Model>('device_models', '*', (q) => q.order('manufacturer').order('model_name')) });
export const useWorkOrderTypes = () => useQuery({ queryKey: ['lookup', 'wo_types'], ...stale, queryFn: () => fetchAll<WorkOrderType>('work_order_types', '*', (q) => q.order('sort_order')) });
export const useLocations = (warehouseId?: string | null) => useQuery({
  queryKey: ['lookup', 'locations', warehouseId], enabled: Boolean(warehouseId), ...stale,
  queryFn: () => fetchAll<Location>('warehouse_locations', '*', (q) => q.eq('warehouse_id', warehouseId).eq('is_active', true).order('code')),
});
export const useSuppliers = () => useQuery({ queryKey: ['lookup', 'suppliers'], ...stale, queryFn: () => fetchAll<Supplier>('suppliers', 'id, code, name', (q) => q.order('name')) });
export const useUsers = () => useQuery({ queryKey: ['lookup', 'users'], ...stale, queryFn: () => fetchAll<UserLite>('profiles', 'id, full_name, email, is_active', (q) => q.order('full_name')) });

export const modelLabel = (m?: Pick<Model, 'manufacturer' | 'model_name'> | null) => (m ? `${m.manufacturer} ${m.model_name}` : '—');
export const opts = <T extends { id: string }>(rows: T[] | undefined, label: (r: T) => string) =>
  (rows ?? []).map((r) => ({ value: r.id, label: label(r) }));
