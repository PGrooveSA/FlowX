import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, wide, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { wide?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px]" />
      <DialogPrimitive.Content
        className={cn('fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card p-5 shadow-xl',
          wide ? 'max-w-3xl' : 'max-w-lg', className)}
        {...props}>
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-4 pr-6">
      <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
      {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
        : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
    </div>
  );
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}
