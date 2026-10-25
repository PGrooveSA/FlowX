import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Inbox, Loader2, ScanLine, ShieldOff } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn, formatMoney } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Field } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';

export interface Crumb { label: string; to?: string }

export function PageHeader({ title, description, crumbs, actions }: { title: string; description?: React.ReactNode; crumbs?: Crumb[]; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 space-y-2">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="no-print flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">Home</Link>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3" aria-hidden />
              {c.to ? <Link to={c.to} className="hover:text-foreground">{c.label}</Link> : <span aria-current="page">{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }: { title: string; description?: string; action?: React.ReactNode; icon?: typeof Inbox }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Failed to load data';
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-800">
      <AlertTriangle className="h-6 w-6" aria-hidden />
      <p>{message}</p>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function NoAccess() {
  return <EmptyState icon={ShieldOff} title="You do not have access to this page" description="Ask an administrator to assign the required permission." />;
}

export function RequirePermission({ anyOf, children }: { anyOf: string[]; children: React.ReactNode }) {
  const { canAny } = useAuth();
  if (anyOf.length && !canAny(...anyOf)) return <NoAccess />;
  return <>{children}</>;
}

export function StatCard({ label, value, hint, tone = 'default', to, icon: Icon }: {
  label: string; value: React.ReactNode; hint?: string; tone?: 'default' | 'warning' | 'danger' | 'success'; to?: string; icon?: typeof Inbox;
}) {
  const body = (
    <div className={cn('h-full rounded-lg border bg-card p-4 shadow-sm transition-colors', to && 'hover:border-primary/50 hover:bg-primary/[0.02]')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && <Icon className={cn('h-4 w-4', tone === 'warning' ? 'text-amber-600' : tone === 'danger' ? 'text-red-600' : tone === 'success' ? 'text-emerald-600' : 'text-primary')} aria-hidden />}
      </div>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-red-700', tone === 'warning' && 'text-amber-700')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}

export function KeyValue({ items, columns = 2 }: { items: [string, React.ReactNode][]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 break-words text-sm">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Confirmation dialog for sensitive actions. When `reasonLabel` is set a reason is mandatory. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', destructive, reasonLabel, minReason = 5, onConfirm, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: React.ReactNode; confirmLabel?: string;
  destructive?: boolean; reasonLabel?: string; minReason?: number; onConfirm: (reason: string) => Promise<unknown> | void; children?: React.ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) setReason(''); }, [open]);
  const invalid = Boolean(reasonLabel) && reason.trim().length < minReason;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader title={title} description={description} />
        {children}
        {reasonLabel && (
          <Field label={reasonLabel} htmlFor="confirm-reason" required hint={`At least ${minReason} characters. This is recorded in the audit trail.`}>
            <Textarea id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={invalid} loading={busy}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(reason.trim()); onOpenChange(false); } catch { /* the caller shows the error */ } finally { setBusy(false); }
            }}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Serial entry for USB/Bluetooth barcode scanners (keyboard wedge: they type and press Enter),
 * the device camera (BarcodeDetector where the browser supports it), or manual typing.
 */
export function ScanInput({ onScan, placeholder = 'Scan or type the serial number, then press Enter', disabled, busy, label = 'Serial number' }: {
  onScan: (value: string) => Promise<unknown> | void; placeholder?: string; disabled?: boolean; busy?: boolean; label?: string;
}) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!disabled && !busy) ref.current?.focus(); }, [disabled, busy]);
  const submit = async (v: string) => {
    const s = v.trim();
    if (!s) return;
    setValue('');
    await onScan(s);
    ref.current?.focus();
  };
  const supportsCamera = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices;
  return (
    <div className="space-y-2">
      <label htmlFor="scan-input" className="text-sm font-medium">{label}</label>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void submit(value); }}>
        <div className="relative flex-1">
          <ScanLine className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input id="scan-input" ref={ref} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder}
            className="pl-9 mono" autoComplete="off" spellCheck={false} disabled={disabled || busy} />
        </div>
        <Button type="submit" disabled={disabled || !value.trim()} loading={busy}>Verify</Button>
        {supportsCamera && <Button type="button" variant="outline" onClick={() => setCamera(true)} disabled={disabled}>Camera</Button>}
      </form>
      <p className="text-xs text-muted-foreground">Scan the manufacturer serial on the device itself. Labels never override the registered identity.</p>
      {camera && <CameraScanner onClose={() => setCamera(false)} onDetected={(v) => { setCamera(false); void submit(v); }} />}
    </div>
  );
}

function CameraScanner({ onClose, onDetected }: { onClose: () => void; onDetected: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detector = new (window as any).BarcodeDetector({ formats: ['code_128', 'code_39', 'qr_code', 'ean_13', 'data_matrix'] });
        while (!stop) {
          const codes = await detector.detect(video.current);
          if (codes.length) { onDetected(codes[0].rawValue); return; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Camera unavailable');
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onDetected]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Scan with camera" description="Point the camera at the serial barcode on the device." />
        {error ? <p className="text-sm text-red-700">{error}. Use a USB scanner or type the serial instead.</p>
          : <video ref={video} className="w-full rounded bg-black" muted playsInline />}
      </DialogContent>
    </Dialog>
  );
}

export interface ScanLogEntry { at: Date; ok: boolean; message: string; serial: string }

export function ScanLog({ entries }: { entries: ScanLogEntry[] }) {
  if (!entries.length) return null;
  return (
    <ul className="max-h-64 space-y-1 overflow-y-auto text-sm" aria-live="polite">
      {entries.map((e, i) => (
        <li key={i} className={cn('rounded border px-3 py-2', e.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900')}>
          <span className="mono mr-2 text-xs opacity-70">{e.at.toLocaleTimeString('en-ZA')}</span>
          <span className="mono font-semibold">{e.serial}</span> — {e.message}
        </li>
      ))}
    </ul>
  );
}

/** Wraps an RPC call: success toast, error toast, and cache invalidation. */
export function useAction<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, opts: { success?: string | ((r: TResult) => string); invalidate?: string[][] } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast.success(msg);
      (opts.invalidate ?? []).forEach((key) => void qc.invalidateQueries({ queryKey: key }));
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDebounce<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function Money({ cents }: { cents: number | null | undefined }) {
  return <span className="tabular-nums">{formatMoney(cents)}</span>;
}
