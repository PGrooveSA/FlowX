import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { Plus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, rpc } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { formatDateTime } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { opts, useProvinces, useWarehouses } from '@/hooks/useLookups';
import { ServerDataTable } from '@/components/data-table/ServerDataTable';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog, LoadingState, PageHeader } from '@/components/common';

type UserRow = Record<string, unknown> & { id: string; email: string; full_name: string; is_active: boolean; roles_summary: string | null; last_seen_at: string | null; created_at: string };
interface Role { id: string; code: string; name: string; description: string | null; is_system: boolean; is_active: boolean }
interface Permission { code: string; module: string; description: string; is_sensitive: boolean }
const c = createColumnHelper<UserRow>();

/** Calls the admin-users edge function, which verifies users.manage server-side and holds the service key. */
async function adminCall(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { const ctx = (error as { context?: Response }).context; if (ctx) msg = (await ctx.json()).error ?? msg; } catch { /* keep message */ }
    throw new Error(msg);
  }
  return data as { ok: boolean; message?: string; user_id?: string };
}

export function UsersPage() {
  const { can } = useAuth();
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<UserRow | null>(null);
  return (
    <div>
      <PageHeader title="User Management" crumbs={[{ label: 'Users' }]} description="Invite users, assign role templates with warehouse/province scope, and grant or deny individual permissions."
        actions={can('users.manage') && <Button onClick={() => setInvite(true)}><UserPlus /> Invite user</Button>} />
      <Tabs defaultValue="users">
        <TabsList><TabsTrigger value="users">Users</TabsTrigger>{can('roles.manage') && <TabsTrigger value="roles">Roles and permissions</TabsTrigger>}</TabsList>
        <TabsContent value="users">
          <ServerDataTable<UserRow> source="v_users" queryKey={['users']} defaultSort={{ column: 'full_name', desc: false }} searchColumns={['full_name', 'email']}
            onRowClick={can('users.manage') ? setEdit : undefined}
            columns={[c.accessor('full_name', { header: 'Name' }), c.accessor('email', { header: 'Email' }),
              c.accessor('roles_summary', { header: 'Roles (scope)', enableSorting: false, cell: (x) => x.getValue() ?? <span className="text-amber-700">No role</span> }),
              c.accessor('is_active', { header: 'Status', cell: (x) => x.getValue() ? <Badge tone="green">Active</Badge> : <Badge tone="red">Deactivated</Badge> }),
              c.accessor('last_seen_at', { header: 'Last active', cell: (x) => formatDateTime(x.getValue()) }), c.accessor('created_at', { header: 'Created', cell: (x) => formatDateTime(x.getValue()) })]} />
        </TabsContent>
        <TabsContent value="roles"><RolesTab /></TabsContent>
      </Tabs>
      {invite && <InviteDialog onClose={() => setInvite(false)} />}
      {edit && <UserDialog user={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function useRoles() { return useQuery({ queryKey: ['roles'], queryFn: () => fetchAll<Role>('roles', '*', (q) => q.order('name')) }); }
function usePermissions() { return useQuery({ queryKey: ['permissions'], queryFn: () => fetchAll<Permission>('permissions', '*', (q) => q.order('module').order('code')) }); }

function InviteDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const roles = useRoles().data;
  const warehouses = useWarehouses().data;
  const [v, setV] = useState({ email: '', full_name: '', role_id: '', warehouse_id: '' });
  const [busy, setBusy] = useState(false);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email) && v.full_name.trim().length > 1 && v.role_id;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader title="Invite user" description="The user receives an email to set their password and activate the account. (Local development: see Mailpit at http://127.0.0.1:55424.)" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="iv-e" required><Input id="iv-e" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
          <Field label="Full name" htmlFor="iv-n" required><Input id="iv-n" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} /></Field>
          <Field label="Role template" htmlFor="iv-r" required><Select id="iv-r" placeholder="Select…" value={v.role_id} onChange={(e) => setV({ ...v, role_id: e.target.value })} options={opts(roles?.filter((r) => r.is_active), (r) => r.name)} /></Field>
          <Field label="Warehouse scope" htmlFor="iv-w" hint="Leave empty for all warehouses"><Select id="iv-w" placeholder="All warehouses" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })} options={opts(warehouses, (w) => w.code)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!valid} onClick={async () => {
            setBusy(true);
            try {
              const r = await adminCall({ action: 'invite', email: v.email.trim(), full_name: v.full_name.trim(), redirect_to: `${import.meta.env.VITE_APP_URL ?? window.location.origin}/reset-password` });
              await rpc('set_user_roles', { p_user_id: r.user_id, p_assignments: [{ role_id: v.role_id, warehouse_id: v.warehouse_id || null }] });
              toast.success(r.message ?? 'Invitation sent'); void qc.invalidateQueries({ queryKey: ['users'] }); onClose();
            } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}><Plus /> Send invitation</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const roles = useRoles().data;
  const permissions = usePermissions().data;
  const warehouses = useWarehouses().data;
  const provinces = useProvinces().data;
  const q = useQuery({ queryKey: ['user-access', user.id], queryFn: async () => ({
    assignments: await fetchAll<{ role_id: string; warehouse_id: string | null; province_id: string | null }>('user_role_assignments', 'role_id, warehouse_id, province_id', (x) => x.eq('user_id', user.id)),
    overrides: await fetchAll<{ permission_code: string; granted: boolean; reason: string | null }>('user_permission_overrides', 'permission_code, granted, reason', (x) => x.eq('user_id', user.id)),
  }) });
  const [assignments, setAssignments] = useState<{ role_id: string; warehouse_id: string; province_id: string }[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, '' | 'grant' | 'deny'> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = assignments ?? q.data?.assignments.map((x) => ({ role_id: x.role_id, warehouse_id: x.warehouse_id ?? '', province_id: x.province_id ?? '' })) ?? [];
  const o = overrides ?? Object.fromEntries((q.data?.overrides ?? []).map((x) => [x.permission_code, x.granted ? 'grant' : 'deny'])) as Record<string, '' | 'grant' | 'deny'>;
  const modules = useMemo(() => [...new Set((permissions ?? []).map((p) => p.module))], [permissions]);
  const self = user.id === profile?.id;
  if (q.isLoading) return null;

  return (
    <Dialog open onOpenChange={(op) => !op && onClose()}>
      <DialogContent wide className="max-w-4xl"><DialogHeader title={user.full_name} description={user.email} />
        <Tabs defaultValue="roles">
          <TabsList><TabsTrigger value="roles">Roles and scope</TabsTrigger><TabsTrigger value="overrides">Individual permissions</TabsTrigger><TabsTrigger value="account">Account</TabsTrigger></TabsList>
          <TabsContent value="roles" className="space-y-2">
            {a.map((x, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Select aria-label="Role" value={x.role_id} onChange={(e) => setAssignments(a.map((y, j) => j === i ? { ...y, role_id: e.target.value } : y))} placeholder="Role…" options={opts(roles?.filter((r) => r.is_active), (r) => r.name)} />
                <Select aria-label="Warehouse scope" value={x.warehouse_id} onChange={(e) => setAssignments(a.map((y, j) => j === i ? { ...y, warehouse_id: e.target.value } : y))} placeholder="Any warehouse" options={opts(warehouses, (w) => w.code)} />
                <Select aria-label="Province scope" value={x.province_id} onChange={(e) => setAssignments(a.map((y, j) => j === i ? { ...y, province_id: e.target.value } : y))} placeholder="Any province" options={opts(provinces, (p) => p.name)} />
                <Button variant="ghost" onClick={() => setAssignments(a.filter((_, j) => j !== i))}>Remove</Button>
              </div>))}
            <p className="text-xs text-muted-foreground">An assignment with no warehouse and no province gives global scope. Scope limits which warehouses' devices, stock and work orders the user can see and act on.</p>
            <div className="flex justify-between">
              <Button size="sm" variant="outline" onClick={() => setAssignments([...a, { role_id: '', warehouse_id: '', province_id: '' }])}><Plus /> Add role</Button>
              <Button size="sm" loading={busy} disabled={a.some((x) => !x.role_id)} onClick={async () => {
                setBusy(true);
                try { await rpc('set_user_roles', { p_user_id: user.id, p_assignments: a.map((x) => ({ role_id: x.role_id, warehouse_id: x.warehouse_id || null, province_id: x.province_id || null })) });
                  toast.success('Roles saved'); void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['user-access', user.id] }); }
                catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
              }}>Save roles</Button>
            </div>
          </TabsContent>
          <TabsContent value="overrides">
            {self ? <p className="text-sm text-muted-foreground">You cannot change your own permission overrides.</p> : <>
              <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-2">
                {modules.map((m) => (
                  <div key={m}><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{m}</p>
                    {permissions!.filter((p) => p.module === m).map((p) => (
                      <div key={p.code} className="flex items-center justify-between gap-2 border-b py-1 text-sm">
                        <span>{p.description} <span className="mono text-xs text-muted-foreground">{p.code}</span>{p.is_sensitive && <Badge tone="amber" className="ml-1">sensitive</Badge>}</span>
                        <Select aria-label={`Override ${p.code}`} className="h-8 w-36" value={o[p.code] ?? ''} onChange={(e) => setOverrides({ ...o, [p.code]: e.target.value as '' | 'grant' | 'deny' })}
                          options={[{ value: '', label: 'From roles' }, { value: 'grant', label: 'Grant' }, { value: 'deny', label: 'Deny' }]} />
                      </div>))}
                  </div>))}
              </div>
              <div className="mt-3 flex justify-end"><Button size="sm" loading={busy} onClick={async () => {
                setBusy(true);
                try { await rpc('set_user_permission_overrides', { p_user_id: user.id, p_overrides: Object.entries(o).filter(([, v]) => v).map(([k, v]) => ({ permission_code: k, granted: v === 'grant' })) });
                  toast.success('Permission overrides saved'); void qc.invalidateQueries({ queryKey: ['user-access', user.id] }); }
                catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
              }}>Save overrides</Button></div>
            </>}
          </TabsContent>
          <TabsContent value="account" className="space-y-3 text-sm">
            <p>Status: {user.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Deactivated</Badge>}</p>
            <div className="flex flex-wrap gap-2">
              {!self && <Button variant={user.is_active ? 'destructive' : 'default'} onClick={() => setConfirm(true)}>{user.is_active ? 'Deactivate user' : 'Reactivate user'}</Button>}
              <Button variant="outline" onClick={async () => {
                try { const r = await adminCall({ action: 'reset_password', email: user.email, redirect_to: `${import.meta.env.VITE_APP_URL ?? window.location.origin}/reset-password` }); toast.success(r.message ?? 'Reset email sent'); }
                catch (e) { toast.error((e as Error).message); }
              }}>Send password reset</Button>
            </div>
          </TabsContent>
        </Tabs>
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={user.is_active ? 'Deactivate user' : 'Reactivate user'} destructive={user.is_active} reasonLabel="Reason"
          description={user.is_active ? 'The user is signed out and can no longer access the system. Their history is kept.' : undefined}
          onConfirm={async (reason) => {
            try { await adminCall({ action: user.is_active ? 'deactivate' : 'activate', user_id: user.id, reason }); toast.success('Account updated'); void qc.invalidateQueries({ queryKey: ['users'] }); onClose(); }
            catch (e) { toast.error((e as Error).message); throw e; }
          }} />
      </DialogContent>
    </Dialog>
  );
}

function RolesTab() {
  const qc = useQueryClient();
  const roles = useRoles();
  const permissions = usePermissions().data;
  const [edit, setEdit] = useState<Role | 'new' | null>(null);
  const rp = useQuery({ queryKey: ['role-permissions'], queryFn: () => fetchAll<{ role_id: string; permission_code: string }>('role_permissions', 'role_id, permission_code') });
  if (!roles.data || !permissions) return <LoadingState />;
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button onClick={() => setEdit('new')}><Plus /> New role template</Button></div>
      <Card><CardContent className="p-0"><ul className="divide-y text-sm">{roles.data.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2">
          <div><p className="font-medium">{r.name} {!r.is_active && <Badge tone="gray">inactive</Badge>} {r.is_system && <Badge tone="blue">template</Badge>}</p>
            <p className="text-xs text-muted-foreground">{r.description} · {rp.data?.filter((x) => x.role_id === r.id).length ?? 0} permissions</p></div>
          {r.code !== 'administrator' && <Button size="sm" variant="outline" onClick={() => setEdit(r)}>Edit</Button>}
        </li>))}</ul></CardContent></Card>
      {edit && <RoleDialog role={edit === 'new' ? null : edit} permissions={permissions} current={edit === 'new' ? [] : (rp.data ?? []).filter((x) => x.role_id === edit.id).map((x) => x.permission_code)}
        onClose={() => setEdit(null)} onDone={() => { void qc.invalidateQueries({ queryKey: ['roles'] }); void qc.invalidateQueries({ queryKey: ['role-permissions'] }); }} />}
    </div>
  );
}

function RoleDialog({ role, permissions, current, onClose, onDone }: { role: Role | null; permissions: Permission[]; current: string[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ code: role?.code ?? '', name: role?.name ?? '', description: role?.description ?? '', is_active: role?.is_active ?? true });
  const [sel, setSel] = useState(new Set(current));
  const [busy, setBusy] = useState(false);
  const modules = [...new Set(permissions.map((p) => p.module))];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide className="max-w-4xl"><DialogHeader title={role ? `Edit ${role.name}` : 'New role template'} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code" htmlFor="rc" required hint="lowercase_with_underscores"><Input id="rc" value={v.code} disabled={!!role} onChange={(e) => setV({ ...v, code: e.target.value })} /></Field>
          <Field label="Name" htmlFor="rn" required><Input id="rn" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <label className="flex items-end gap-2 pb-2 text-sm"><Checkbox checked={v.is_active} onChange={(e) => setV({ ...v, is_active: e.target.checked })} /> Active</label>
          <Field label="Description" htmlFor="rd" className="sm:col-span-3"><Textarea id="rd" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        </div>
        <div className="mt-3 grid max-h-[45vh] gap-3 overflow-y-auto sm:grid-cols-2">
          {modules.map((m) => (
            <div key={m} className="rounded border p-2"><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{m}</p>
              {permissions.filter((p) => p.module === m).map((p) => (
                <label key={p.code} className="flex items-start gap-2 py-0.5 text-sm"><Checkbox className="mt-0.5" checked={sel.has(p.code)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(p.code); else n.delete(p.code); setSel(n); }} />
                  <span>{p.description}{p.is_sensitive && <Badge tone="amber" className="ml-1">sensitive</Badge>}</span></label>))}
            </div>))}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!/^[a-z][a-z0-9_]*$/.test(v.code) || v.name.trim().length < 2} onClick={async () => {
            setBusy(true);
            try { await rpc('save_role', { p_id: role?.id ?? null, p_code: v.code, p_name: v.name, p_description: v.description, p_permissions: [...sel], p_active: v.is_active }); toast.success('Role saved'); onDone(); onClose(); }
            catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>Save role</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
