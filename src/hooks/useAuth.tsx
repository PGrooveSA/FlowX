import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { hexToRgbTriple } from '@/lib/utils';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  job_title: string | null;
  is_active: boolean;
  default_warehouse_id: string | null;
}

export interface Branding {
  appName: string;
  orgName: string;
  logoUrl: string;
  primaryColor: string;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  profile: Profile | null;
  permissions: Set<string>;
  roles: string[];
  branding: Branding;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const defaultBranding: Branding = { appName: 'DeviceFlow', orgName: 'DeviceFlow', logoUrl: '', primaryColor: '#1d4ed8' };
const AuthContext = createContext<AuthState | null>(null);

export function useBranding() {
  return useQuery({
    queryKey: ['branding'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Branding> => {
      const { data, error } = await supabase.rpc('get_public_branding');
      if (error || !data) return defaultBranding;
      const b = data as Record<string, string>;
      return {
        appName: b['org.app_name'] || defaultBranding.appName,
        orgName: b['org.name'] || defaultBranding.orgName,
        logoUrl: b['org.logo_url'] || '',
        primaryColor: b['org.primary_color'] || defaultBranding.primaryColor,
      };
    },
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  const branding = useBranding().data ?? defaultBranding;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) qc.clear();
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  useEffect(() => {
    const triple = hexToRgbTriple(branding.primaryColor);
    if (triple) document.documentElement.style.setProperty('--primary', triple);
    document.title = branding.appName;
  }, [branding.primaryColor, branding.appName]);

  const userId = session?.user.id;
  const access = useQuery({
    queryKey: ['me', userId],
    enabled: Boolean(userId),
    staleTime: 60_000,
    queryFn: async () => {
      const [profile, perms, roles] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId!).maybeSingle(),
        supabase.rpc('my_permissions'),
        supabase.from('user_role_assignments').select('roles(code, name)').eq('user_id', userId!),
      ]);
      void supabase.rpc('touch_last_seen');
      return {
        profile: (profile.data ?? null) as Profile | null,
        permissions: new Set<string>((perms.data as string[] | null) ?? []),
        roles: ((roles.data ?? []) as unknown as { roles: { name: string } | null }[]).map((r) => r.roles?.name ?? '').filter(Boolean),
      };
    },
  });

  const permissions = useMemo(() => access.data?.permissions ?? new Set<string>(), [access.data]);
  const can = useCallback((p: string) => permissions.has(p), [permissions]);
  const canAny = useCallback((...ps: string[]) => ps.some((p) => permissions.has(p)), [permissions]);

  const value: AuthState = {
    session,
    loading: loading || (Boolean(userId) && access.isLoading),
    profile: access.data?.profile ?? null,
    permissions,
    roles: access.data?.roles ?? [],
    branding,
    can,
    canAny,
    signOut: async () => {
      await supabase.auth.signOut();
      qc.clear();
    },
    refresh: () => void access.refetch(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
