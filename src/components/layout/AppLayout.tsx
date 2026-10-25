import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronsLeft, ChevronsRight, LogOut, Menu, X, Search } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { visibleNav } from '@/lib/navigation';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { GlobalSearch } from '@/components/common/GlobalSearch';

function useUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    enabled,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false);
      return count ?? 0;
    },
  });
}

export function AppLayout() {
  const { can, profile, roles, signOut, branding } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('df.sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();
  const unread = useUnreadCount(Boolean(profile)).data ?? 0;
  const items = visibleNav(can);
  const groups = [...new Set(items.map((i) => i.group))];

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    try { localStorage.setItem('df.sidebar', collapsed ? 'collapsed' : 'expanded'); } catch { /* storage unavailable */ }
  }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav = (compact: boolean) => (
    <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2 py-3">
      {groups.map((g) => (
        <div key={g} className="mb-3">
          {!compact && <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g}</div>}
          {items.filter((i) => i.group === g).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'} title={compact ? i.label : undefined}
              className={({ isActive }) => cn('flex items-center gap-3 rounded-md px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white',
                isActive && 'bg-primary text-white hover:bg-primary', compact && 'justify-center')}>
              <i.icon className="h-4 w-4 shrink-0" aria-hidden />
              {!compact && <span className="truncate">{i.label}</span>}
              {!compact && i.to === '/notifications' && unread > 0 && (
                <span className="ml-auto rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{unread}</span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const brand = (compact: boolean) => (
    <Link to="/" className="flex h-14 items-center gap-2 border-b border-slate-800 px-4 text-white">
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" className="h-7 w-7 rounded" />
        : <span className="flex h-7 w-7 items-center justify-center rounded bg-primary text-sm font-bold">{branding.appName.charAt(0)}</span>}
      {!compact && <span className="truncate font-semibold">{branding.appName}</span>}
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-card focus:p-2">Skip to content</a>
      <aside className={cn('no-print sticky top-0 hidden h-screen shrink-0 flex-col bg-slate-900 transition-all lg:flex', collapsed ? 'w-16' : 'w-64')}>
        {brand(collapsed)}
        {nav(collapsed)}
        <button onClick={() => setCollapsed((c) => !c)} className="flex items-center justify-center gap-2 border-t border-slate-800 py-2 text-xs text-slate-400 hover:text-white"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
        </button>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-slate-900">
            <div className="flex items-center justify-between pr-2">{brand(false)}
              <button onClick={() => setMobileOpen(false)} className="text-slate-300" aria-label="Close navigation"><X className="h-5 w-5" /></button>
            </div>
            {nav(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <button onClick={() => setSearchOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-muted">
            <Search className="h-4 w-4" /> <span className="truncate">Search serial, asset tag, work order…</span>
            <kbd className="ml-auto hidden rounded border bg-card px-1.5 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <Button asChild variant="ghost" size="icon" aria-label={`Notifications (${unread} unread)`} className="relative">
              <Link to="/notifications"><Bell />{unread > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />}</Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted" aria-label="Account menu">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {(profile?.full_name || profile?.email || '?').charAt(0).toUpperCase()}
                  </span>
                  <span className="hidden text-left text-sm leading-tight md:block">
                    <span className="block font-medium">{profile?.full_name}</span>
                    <span className="block text-xs text-muted-foreground">{roles.join(', ') || 'No role assigned'}</span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>{profile?.email}</DropdownMenuLabel>
                <DropdownMenuItem asChild><Link to="/profile">My profile</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut()}><LogOut className="h-4 w-4" /> Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main id="main" className="flex-1 px-3 py-4 sm:px-6 sm:py-6">
          <Outlet />
        </main>
      </div>
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
