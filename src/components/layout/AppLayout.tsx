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
    <nav aria-label="Main navigation" className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3 pt-1">
      {groups.map((g) => (
        <div key={g} className="mt-2">
          {!compact && <div className="whitespace-nowrap px-2.5 pb-0.5 pt-1 text-[10.5px] font-medium uppercase tracking-[.12em] text-muted-foreground">{g}</div>}
          {items.filter((i) => i.group === g).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'} title={compact ? i.label : undefined}
              className={({ isActive }) => cn('group relative my-0.5 flex items-center gap-[11px] whitespace-nowrap rounded-full px-2 py-1 text-[14px] text-ink-2 transition-[background-color,color,transform] active:scale-95',
                isActive ? 'bg-ink text-white shadow-[0_6px_16px_rgba(29,29,27,.18)] after:absolute after:right-3 after:top-1/2 after:h-[7px] after:w-[7px] after:-translate-y-1/2 after:rounded-full after:bg-sky after:shadow-[0_0_10px_rgba(142,207,245,.9)]' : 'hover:bg-black/[.045] hover:text-ink',
                compact && 'justify-center after:hidden')}>
              <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full border border-[#e1e7ec] bg-white text-ink transition-transform duration-300 group-hover:translate-x-[3px] group-hover:scale-105 group-aria-[current=page]:border-transparent group-aria-[current=page]:bg-white/15 group-aria-[current=page]:text-white"><i.icon className="h-[15px] w-[15px]" aria-hidden /></span>
              {!compact && <span className="truncate">{i.label}</span>}
              {!compact && i.to === '/notifications' && unread > 0 && (
                <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-sky px-1.5 text-[11px] font-semibold text-ink shadow-[0_0_0_2px_#fff]">{unread}</span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const brand = (compact: boolean) => (
    <Link to="/" className="flex h-16 items-center gap-3 px-4 text-ink">
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" className="h-10 w-10 rounded-full object-contain" />
        : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink text-base font-semibold text-white">{branding.appName.charAt(0)}</span>}
      {!compact && <span className="grid min-w-0"><b className="truncate text-base font-semibold">{branding.appName}</b><small className="text-[11px] uppercase tracking-[.06em] text-muted-foreground">Device lifecycle</small></span>}
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-card focus:p-2">Skip to content</a>
      <aside className={cn('no-print sticky top-0 z-40 hidden h-screen shrink-0 flex-col border-r border-white/80 bg-white/40 shadow-[inset_-1px_0_0_rgba(255,255,255,.6),8px_0_30px_rgba(20,30,40,.05)] backdrop-blur-[20px] backdrop-saturate-150 transition-all lg:flex', collapsed ? 'w-[76px]' : 'w-[248px]')}>
        {brand(collapsed)}
        {nav(collapsed)}
        <button onClick={() => setCollapsed((c) => !c)} className="mx-2.5 mb-2.5 flex items-center justify-center gap-2 rounded-full border-t border-transparent py-2 text-xs text-muted-foreground hover:bg-black/[.045] hover:text-ink"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
        </button>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-[rgba(15,22,30,.35)] backdrop-blur-[2px]" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-white/80 bg-white/80 backdrop-blur-[20px]">
            <div className="flex items-center justify-between pr-2">{brand(false)}
              <button onClick={() => setMobileOpen(false)} className="rounded-full p-1.5 text-ink hover:bg-black/5" aria-label="Close navigation"><X className="h-5 w-5" /></button>
            </div>
            {nav(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/70 bg-[rgba(240,244,247,.86)] px-3 shadow-[0_1px_0_rgba(20,30,40,.04),0_6px_18px_rgba(20,30,40,.05)] backdrop-blur-[20px] backdrop-saturate-150 sm:px-[22px]">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <button onClick={() => setSearchOpen(true)}
            className="glass-strong flex h-10 w-full max-w-md items-center gap-2 rounded-full px-4 text-sm text-muted-foreground transition-colors hover:bg-white">
            <Search className="h-4 w-4" /> <span className="truncate">Search serial, asset tag, work order…</span>
            <kbd className="ml-auto hidden rounded-full border border-black/10 bg-white/70 px-2 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="icon" aria-label={`Notifications (${unread} unread)`} className="relative h-[42px] w-[42px]">
              <Link to="/notifications"><Bell />{unread > 0 && <span className="absolute -right-1 -top-1 grid h-[19px] min-w-[19px] place-items-center rounded-full bg-sky px-1 text-[10.5px] font-semibold text-ink shadow-[0_0_0_2px_#fff]">{unread}</span>}</Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="glass-strong flex items-center gap-2 rounded-full py-1 pl-1 pr-4 transition-transform active:scale-95" aria-label="Account menu">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sky text-xs font-semibold text-ink">
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
        <main id="main" className="flex-1 px-3 py-4 sm:px-[22px] sm:py-[18px]">
          <Outlet />
        </main>
      </div>
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
