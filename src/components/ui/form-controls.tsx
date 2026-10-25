import * as React from 'react';
import { cn } from '@/lib/utils';

const controlBase =
  'flex w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input type={type} className={cn(controlBase, 'h-9 py-1', className)} ref={ref} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea className={cn(controlBase, 'min-h-[72px] py-2', className)} ref={ref} {...props} />,
);
Textarea.displayName = 'Textarea';

export interface SelectOption { value: string; label: string }

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { options?: SelectOption[]; placeholder?: string }>(
  ({ className, options, placeholder, children, ...props }, ref) => (
    <select ref={ref} className={cn(controlBase, 'h-9 py-1 pr-8', className)} {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium leading-none text-foreground', className)} {...props} />;
}

export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn('h-4 w-4 rounded border-input accent-[rgb(var(--primary))]', className)} {...props} />;
}

/** Labelled form field with hint and validation message, wired for screen readers. */
export function Field({ label, htmlFor, error, hint, required, className, children }: {
  label: string; htmlFor?: string; error?: string; hint?: string; required?: boolean; className?: string; children: React.ReactNode;
}) {
  const id = htmlFor;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}{required && <span className="text-destructive"> *</span>}</Label>
      {children}
      {hint && !error && <p id={id ? `${id}-hint` : undefined} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={id ? `${id}-error` : undefined} role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}
