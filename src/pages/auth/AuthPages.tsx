import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { friendlyMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const { branding } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-2">
          {branding.logoUrl ? <img src={branding.logoUrl} alt="" className="h-9 w-9 rounded" />
            : <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-bold text-white">{branding.appName.charAt(0)}</span>}
          <div>
            <p className="font-semibold leading-tight">{branding.appName}</p>
            <p className="text-xs text-muted-foreground">{branding.orgName}</p>
          </div>
        </div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mb-4 mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export function LoginPage() {
  const { session } = useAuth();
  const nav = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });

  if (session) return <Navigate to={location.state?.from ?? '/'} replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: v.email, password: v.password });
    if (err) {
      setError(/invalid/i.test(err.message) ? 'Incorrect email or password.' : friendlyMessage(err));
      return;
    }
    nav(location.state?.from ?? '/', { replace: true });
  });

  return (
    <AuthShell title="Sign in" subtitle="Use the account your administrator created for you.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="username" {...form.register('email')} aria-invalid={!!form.formState.errors.email} />
        </Field>
        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
        </Field>
        {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Sign in</Button>
        <p className="text-center text-sm"><Link to="/forgot-password" className="text-primary hover:underline">Forgot your password?</Link></p>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const form = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.string().trim().email('Enter a valid email address') })) });
  const onSubmit = form.handleSubmit(async ({ email }) => {
    const redirectTo = `${import.meta.env.VITE_APP_URL ?? window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error && !/rate/i.test(error.message)) { toast.error(friendlyMessage(error)); return; }
    setSent(true); // Same message whether or not the account exists (no account enumeration)
  });
  return (
    <AuthShell title="Reset your password" subtitle="We will email you a link to choose a new password.">
      {sent ? (
        <div className="space-y-4 text-sm">
          <p>If an account exists for that address, a reset link has been sent. The link expires after one hour.</p>
          <p className="text-xs text-muted-foreground">Local development: emails are captured by Mailpit at http://127.0.0.1:55424.</p>
          <Link to="/login" className="text-primary hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="fp-email" error={form.formState.errors.email?.message}>
            <Input id="fp-email" type="email" {...form.register('email')} />
          </Field>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Send reset link</Button>
          <p className="text-center text-sm"><Link to="/login" className="text-primary hover:underline">Back to sign in</Link></p>
        </form>
      )}
    </AuthShell>
  );
}

export const passwordSchema = z.object({
  password: z.string().min(12, 'Use at least 12 characters')
    .regex(/[A-Z]/, 'Include an uppercase letter').regex(/[a-z]/, 'Include a lowercase letter').regex(/[0-9]/, 'Include a number'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

/** Handles both password recovery and invitation/activation links. */
export function ResetPasswordPage() {
  const { session } = useAuth();
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const form = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 600); // allow the client to exchange the link token
    return () => clearTimeout(t);
  }, []);
  const onSubmit = form.handleSubmit(async (v) => {
    const { error } = await supabase.auth.updateUser({ password: v.password });
    if (error) { toast.error(friendlyMessage(error)); return; }
    toast.success('Password set. Welcome to DeviceFlow.');
    nav('/', { replace: true });
  });
  if (ready && !session) {
    return (
      <AuthShell title="Link invalid or expired">
        <p className="text-sm">Request a new password reset link or ask your administrator to resend your invitation.</p>
        <Link to="/forgot-password" className="mt-4 inline-block text-sm text-primary hover:underline">Request a new link</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a password" subtitle="Set the password you will use to sign in.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="New password" htmlFor="np" error={form.formState.errors.password?.message} hint="At least 12 characters with upper- and lowercase letters and a number.">
          <Input id="np" type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Field label="Confirm password" htmlFor="npc" error={form.formState.errors.confirm?.message}>
          <Input id="npc" type="password" autoComplete="new-password" {...form.register('confirm')} />
        </Field>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting} disabled={!session}>Save password</Button>
      </form>
    </AuthShell>
  );
}
