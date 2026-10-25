// Privileged user administration. The service-role key exists only here (server side).
// Every call re-verifies that the caller is an active user holding `users.manage`.
import { createClient } from 'npm:@supabase/supabase-js@2.46.1';

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json(401, { error: 'Authentication required' });

  // Client acting as the caller: RLS and has_permission() apply to them.
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: me, error: meErr } = await asCaller.auth.getUser();
  if (meErr || !me.user) return json(401, { error: 'Invalid session' });
  const { data: allowed } = await asCaller.rpc('has_permission', { p_code: 'users.manage' });
  if (!allowed) return json(403, { error: 'Permission denied: "users.manage" is required' });

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON body' }); }

  try {
    switch (body.action) {
      case 'invite': {
        const email = String(body.email ?? '').trim().toLowerCase();
        const fullName = String(body.full_name ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Enter a valid email address' });
        if (fullName.length < 2) return json(400, { error: 'Enter the user\'s full name' });
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo: body.redirect_to });
        if (error) return json(400, { error: /already/i.test(error.message) ? 'A user with this email already exists' : error.message });
        await admin.from('audit_logs').insert({ user_id: me.user.id, user_email: me.user.email, action: 'invite_user', entity_type: 'user',
          entity_id: data.user.id, new_values: { email, full_name: fullName }, correlation_id: req.headers.get('x-correlation-id') });
        return json(200, { ok: true, user_id: data.user.id, message: `Invitation sent to ${email}` });
      }
      case 'deactivate':
      case 'activate': {
        if (!body.user_id) return json(400, { error: 'user_id is required' });
        if (body.user_id === me.user.id) return json(400, { error: 'You cannot change your own account status' });
        const active = body.action === 'activate';
        // Record through the database function as the caller (audit + rules), then revoke/restore sessions.
        const { error: rpcErr } = await asCaller.rpc('set_user_active', { p_user_id: body.user_id, p_active: active, p_reason: body.reason ?? null });
        if (rpcErr) return json(400, { error: rpcErr.message });
        const { error } = await admin.auth.admin.updateUserById(body.user_id, { ban_duration: active ? 'none' : '876000h' });
        if (error) return json(400, { error: error.message });
        return json(200, { ok: true, message: active ? 'User reactivated' : 'User deactivated and signed out' });
      }
      case 'reset_password': {
        const { error } = await admin.auth.resetPasswordForEmail(String(body.email), { redirectTo: body.redirect_to });
        if (error) return json(400, { error: error.message });
        await admin.from('audit_logs').insert({ user_id: me.user.id, user_email: me.user.email, action: 'send_password_reset', entity_type: 'user',
          entity_id: body.email, correlation_id: req.headers.get('x-correlation-id') });
        return json(200, { ok: true, message: 'Password reset email sent' });
      }
      default:
        return json(400, { error: 'Unknown action' });
    }
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : 'Unexpected error' });
  }
});
