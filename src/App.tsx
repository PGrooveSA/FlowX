import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { isConfigured } from '@/lib/supabase';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoadingState, RequirePermission } from '@/components/common';
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from '@/pages/auth/AuthPages';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = (loader: () => Promise<any>, name: string) =>
  lazy(() => loader().then((m) => ({ default: m[name] as React.ComponentType })));

const DashboardPage = page(() => import('@/pages/dashboard/DashboardPage'), 'DashboardPage');
const WorkOrdersPage = page(() => import('@/pages/work-orders/WorkOrdersPage'), 'WorkOrdersPage');
const WorkOrderFormPage = page(() => import('@/pages/work-orders/WorkOrderFormPage'), 'WorkOrderFormPage');
const WorkOrderDetailPage = page(() => import('@/pages/work-orders/WorkOrderDetailPage'), 'WorkOrderDetailPage');
const WorkOrderViewPage = page(() => import('@/pages/work-orders/WorkOrderViewPage'), 'WorkOrderViewPage');
const WorkOrderDetailsPage =page(() => import('@/pages/work-orders/WorkOrderDetailsPage'), 'WorkOrderDetailsPage');
const WorkOrderImportPage =page(() => import('@/pages/work-orders/WorkOrderImportPage'), 'WorkOrderImportPage');
const DeviceRegisterPage = page(() => import('@/pages/devices/DeviceRegisterPage'), 'DeviceRegisterPage');
const DeviceDetailPage = page(() => import('@/pages/devices/DeviceDetailPage'), 'DeviceDetailPage');
const DeviceImportPage = page(() => import('@/pages/devices/DeviceImportPage'), 'DeviceImportPage');
const WarehousePage = page(() => import('@/pages/warehouse/WarehousePage'), 'WarehousePage');
const GoodsReceiptPage = page(() => import('@/pages/warehouse/GoodsReceiptPage'), 'GoodsReceiptPage');
const StockCountPage = page(() => import('@/pages/warehouse/StockCountPage'), 'StockCountPage');
const MovementsPage = page(() => import('@/pages/warehouse/MovementsPage'), 'MovementsPage');
const IssuingQueuePage = page(() => import('@/pages/issuing/IssuingPages'), 'IssuingQueuePage');
const IssuingWorkspacePage = page(() => import('@/pages/issuing/IssuingPages'), 'IssuingWorkspacePage');
const AssessmentsPage = page(() => import('@/pages/repairs/RepairPages'), 'AssessmentsPage');
const RepairsPage = page(() => import('@/pages/repairs/RepairPages'), 'RepairsPage');
const RepairDetailPage = page(() => import('@/pages/repairs/RepairPages'), 'RepairDetailPage');
const AssessmentDetailPage = page(() => import('@/pages/repairs/RepairPages'), 'AssessmentDetailPage');
const ReturnsPage = page(() => import('@/pages/returns/ReturnPages'), 'ReturnsPage');
const ReturnDetailPage = page(() => import('@/pages/returns/ReturnPages'), 'ReturnDetailPage');
const DiscrepanciesPage = page(() => import('@/pages/discrepancies/DiscrepanciesPage'), 'DiscrepanciesPage');
const InvoicesPage = page(() => import('@/pages/invoicing/InvoicePages'), 'InvoicesPage');
const InvoiceDetailPage = page(() => import('@/pages/invoicing/InvoicePages'), 'InvoiceDetailPage');
const DispatchPage = page(() => import('@/pages/dispatch/DispatchPages'), 'DispatchPage');
const DispatchDetailPage = page(() => import('@/pages/dispatch/DispatchPages'), 'DispatchDetailPage');
const DeliveryPage = page(() => import('@/pages/delivery/DeliveryPages'), 'DeliveryPage');
const DeliveryRecordPage = page(() => import('@/pages/delivery/DeliveryPages'), 'DeliveryRecordPage');
const RecipientConfirmPage = page(() => import('@/pages/delivery/RecipientConfirmPage'), 'RecipientConfirmPage');
const InstitutionDetailPage = page(() => import('@/pages/institutions/InstitutionPages'), 'InstitutionDetailPage');
const ReportsPage = page(() => import('@/pages/reports/ReportsPage'), 'ReportsPage');
const NotificationsPage = page(() => import('@/pages/notifications/NotificationsPage'), 'NotificationsPage');
const AuditPage = page(() => import('@/pages/audit/AuditPage'), 'AuditPage');
const UsersPage = page(() => import('@/pages/admin/UsersPage'), 'UsersPage');
const SettingsPage = page(() => import('@/pages/admin/SettingsPage'), 'SettingsPage');
const ProfilePage = page(() => import('@/pages/admin/ProfilePage'), 'ProfilePage');
const PrintWorkOrder = page(() => import('@/pages/print/PrintPages'), 'PrintWorkOrder');
const PrintInvoice = page(() => import('@/pages/print/PrintPages'), 'PrintInvoice');
const PrintDispatchNote = page(() => import('@/pages/print/PrintPages'), 'PrintDispatchNote');
const PrintDeliveryReceipt = page(() => import('@/pages/print/PrintPages'), 'PrintDeliveryReceipt');
const PrintLabels = page(() => import('@/pages/print/PrintLabels'), 'PrintLabels');

function Protected({ children }: { children: React.ReactNode }) {
  const { session, loading, profile } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState label="Checking your sessionâ€¦" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (profile && !profile.is_active) {
    return <div className="p-10 text-center">Your account has been deactivated. Contact an administrator.</div>;
  }
  return <>{children}</>;
}

const guard = (anyOf: string[], el: React.ReactNode) => <RequirePermission anyOf={anyOf}>{el}</RequirePermission>;

export function App() {
  if (!isConfigured) {
    return (
      <div className="mx-auto max-w-xl p-10 text-sm">
        <h1 className="mb-2 text-lg font-semibold">DeviceFlow is not configured</h1>
        <p>Create <code>.env.local</code> with <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (run <code>npm run setup:env</code>), then restart.</p>
      </div>
    );
  }
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/confirm-delivery/:token" element={<RecipientConfirmPage />} />

        <Route path="/print/work-order/:id" element={<Protected><PrintWorkOrder /></Protected>} />
        <Route path="/print/invoice/:id" element={<Protected>{guard(['invoices.view'], <PrintInvoice />)}</Protected>} />
        <Route path="/print/dispatch/:id" element={<Protected>{guard(['dispatch.view'], <PrintDispatchNote />)}</Protected>} />
        <Route path="/print/delivery/:id" element={<Protected>{guard(['delivery.view'], <PrintDeliveryReceipt />)}</Protected>} />
        <Route path="/print/labels" element={<Protected>{guard(['labels.print'], <PrintLabels />)}</Protected>} />

        <Route element={<Protected><AppLayout /></Protected>}>
          <Route index element={guard(['dashboard.view'], <DashboardPage />)} />
          <Route path="work-orders" element={guard(['work_orders.view'], <WorkOrdersPage />)} />
          <Route path="work-orders/new" element={guard(['work_orders.create'], <WorkOrderFormPage />)} />
          <Route path="work-orders/import" element={guard(['work_orders.import'], <WorkOrderImportPage />)} />
          <Route path="work-orders/:id" element={guard(['work_orders.view'], <WorkOrderDetailPage />)} />
          <Route path="work-orders/:id/view" element={guard(['work_orders.view'], <WorkOrderViewPage />)} />
          <Route path="work-orders/:id/details" element={guard(['work_orders.view'], <WorkOrderDetailsPage />)} />
          <Route path="work-orders/:id/edit" element={guard(['work_orders.create'], <WorkOrderFormPage />)} />
          {/* Approvals, Scheduling and the Institutions list were removed; old links (e.g. in notifications) land on the matching tab. */}
          <Route path="approvals" element={<Navigate to="/work-orders?tab=pending_authorisation" replace />} />
          <Route path="scheduling" element={<Navigate to="/work-orders?tab=pending_scheduling" replace />} />
          <Route path="devices" element={guard(['devices.view'], <DeviceRegisterPage />)} />
          <Route path="devices/import" element={guard(['devices.register'], <DeviceImportPage />)} />
          <Route path="devices/:id" element={guard(['devices.view'], <DeviceDetailPage />)} />
          <Route path="warehouse" element={guard(['inventory.view'], <WarehousePage />)} />
          <Route path="warehouse/receiving/:id" element={guard(['inventory.view'], <GoodsReceiptPage />)} />
          <Route path="warehouse/counts/:id" element={guard(['inventory.view'], <StockCountPage />)} />
          <Route path="movements" element={guard(['inventory.view'], <MovementsPage />)} />
          <Route path="issuing" element={guard(['issuing.pick', 'issuing.confirm', 'inventory.reserve'], <IssuingQueuePage />)} />
          <Route path="issuing/:id" element={guard(['issuing.pick', 'issuing.confirm', 'inventory.reserve'], <IssuingWorkspacePage />)} />
          <Route path="assessments" element={guard(['assessments.view'], <AssessmentsPage />)} />
          <Route path="assessments/:id" element={guard(['assessments.view'], <AssessmentDetailPage />)} />
          <Route path="repairs" element={guard(['assessments.view'], <RepairsPage />)} />
          <Route path="repairs/:id" element={guard(['assessments.view'], <RepairDetailPage />)} />
          <Route path="returns" element={guard(['returns.manage', 'inventory.view'], <ReturnsPage />)} />
          <Route path="returns/:id" element={guard(['returns.manage', 'inventory.view'], <ReturnDetailPage />)} />
          <Route path="discrepancies" element={guard(['devices.view', 'dispatch.view', 'issuing.pick'], <DiscrepanciesPage />)} />
          <Route path="invoicing" element={guard(['invoices.view'], <InvoicesPage />)} />
          <Route path="invoicing/:id" element={guard(['invoices.view'], <InvoiceDetailPage />)} />
          <Route path="dispatch" element={guard(['dispatch.view'], <DispatchPage />)} />
          <Route path="dispatch/:id" element={guard(['dispatch.view'], <DispatchDetailPage />)} />
          <Route path="delivery" element={guard(['delivery.view'], <DeliveryPage />)} />
          <Route path="delivery/:dispatchId" element={guard(['delivery.view'], <DeliveryRecordPage />)} />
          <Route path="institutions" element={<Navigate to="/work-orders" replace />} />
          <Route path="institutions/:id" element={guard(['institutions.view'], <InstitutionDetailPage />)} />
          <Route path="reports" element={guard(['reports.view'], <ReportsPage />)} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="audit" element={guard(['audit.view'], <AuditPage />)} />
          <Route path="admin/users" element={guard(['users.manage', 'roles.manage'], <UsersPage />)} />
          <Route path="admin/settings" element={guard(['settings.manage', 'master_data.manage'], <SettingsPage />)} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="*" element={<div className="py-20 text-center text-sm text-muted-foreground">Page not found.</div>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
