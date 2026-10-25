import { cn, labelize } from '@/lib/utils';
import { toneFor, type Tone } from '@/lib/status';

const TONES: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200',
  orange: 'bg-orange-50 text-orange-800 ring-orange-200',
};

export function Badge({ tone = 'gray', className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, kind = 'generic', className }: { status: string | null | undefined; kind?: 'wo' | 'device' | 'generic'; className?: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return <Badge tone={toneFor(kind, status)} className={className}>{labelize(status)}</Badge>;
}
