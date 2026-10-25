// Secure first-administrator setup.
//   npm run create-admin -- --email you@org.example --name "Full Name"
// The password is read from the ADMIN_PASSWORD environment variable or prompted
// interactively; it is never stored in the repository or printed.
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith('--') ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example).');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const email = args.email ?? (await rl.question('Administrator email: '));
const fullName = args.name ?? (await rl.question('Full name: '));
let password = process.env.ADMIN_PASSWORD;
if (!password) password = await rl.question('Password (min 12 characters): ');
rl.close();

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) throw new Error('Enter a valid email address');
if (!password || password.length < 12) throw new Error('The password must be at least 12 characters');

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: existing } = await admin.from('user_role_assignments')
  .select('user_id, roles!inner(code)').eq('roles.code', 'administrator').limit(1);
if (existing?.length && !args.force) {
  console.error('An administrator already exists. Invite further users from User Management (or pass --force).');
  process.exit(1);
}

const { data: created, error } = await admin.auth.admin.createUser({
  email, password, email_confirm: true, user_metadata: { full_name: fullName },
});
if (error) throw error;
const userId = created.user.id;
await admin.from('profiles').upsert({ id: userId, email, full_name: fullName, is_active: true });
const { data: role } = await admin.from('roles').select('id').eq('code', 'administrator').single();
const { error: roleErr } = await admin.from('user_role_assignments').insert({ user_id: userId, role_id: role.id });
if (roleErr) throw roleErr;
console.log(`Administrator ${email} created. Sign in at ${process.env.VITE_APP_URL ?? 'http://localhost:5180'}.`);
