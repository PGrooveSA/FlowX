import { useState } from 'react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { rpc, friendlyMessage } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form-controls';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/common';
import { passwordSchema } from '@/pages/auth/AuthPages';

export function ProfilePage() {
  const { profile, roles, permissions, refresh } = useAuth();
  const [v, setV] = useState({ full_name: profile?.full_name ?? '', phone: profile?.phone ?? '', job_title: profile?.job_title ?? '' });
  const pw = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="My profile" crumbs={[{ label: 'Profile' }]} />
      <Card><CardHeader><CardTitle>Details</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor="p-n"><Input id="p-n" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} /></Field>
        <Field label="Email" htmlFor="p-e"><Input id="p-e" value={profile?.email ?? ''} disabled /></Field>
        <Field label="Phone" htmlFor="p-p"><Input id="p-p" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
        <Field label="Job title" htmlFor="p-j"><Input id="p-j" value={v.job_title} onChange={(e) => setV({ ...v, job_title: e.target.value })} /></Field>
        <div className="sm:col-span-2 flex justify-end"><Button onClick={async () => {
          try { await rpc('update_profile', { p_user_id: profile!.id, p: v }); toast.success('Profile saved'); refresh(); } catch (e) { toast.error((e as Error).message); }
        }}>Save</Button></div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Change password</CardTitle></CardHeader><CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={pw.handleSubmit(async (x) => {
          const { error } = await supabase.auth.updateUser({ password: x.password });
          if (error) toast.error(friendlyMessage(error)); else { toast.success('Password changed'); pw.reset(); }
        })} noValidate>
          <Field label="New password" htmlFor="p-np" error={pw.formState.errors.password?.message}><Input id="p-np" type="password" autoComplete="new-password" {...pw.register('password')} /></Field>
          <Field label="Confirm" htmlFor="p-nc" error={pw.formState.errors.confirm?.message}><Input id="p-nc" type="password" autoComplete="new-password" {...pw.register('confirm')} /></Field>
          <div className="sm:col-span-2 flex justify-end"><Button type="submit" loading={pw.formState.isSubmitting}>Change password</Button></div>
        </form>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>My access</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
        <p>Roles: {roles.length ? roles.join(', ') : 'none'}</p>
        <div className="flex flex-wrap gap-1">{[...permissions].sort().map((p) => <Badge key={p} tone="gray">{p}</Badge>)}</div>
      </CardContent></Card>
    </div>
  );
}
