import * as React from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;

export function DropdownMenuContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content sideOffset={4} align="end"
        className={cn('z-50 min-w-[13rem] rounded-[20px] border border-white/80 bg-white/80 p-1.5 text-sm shadow-[0_2px_6px_rgba(20,30,40,.06),0_18px_44px_rgba(20,30,40,.14)] backdrop-blur-xl', className)} {...props} />
    </Dropdown.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: React.ComponentPropsWithoutRef<typeof Dropdown.Item>) {
  return <Dropdown.Item className={cn('flex cursor-pointer select-none items-center gap-2 rounded-xl px-3 py-2 outline-none data-[highlighted]:bg-white data-[disabled]:opacity-50', className)} {...props} />;
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof Dropdown.CheckboxItem>) {
  return (
    <Dropdown.CheckboxItem className={cn('flex cursor-pointer select-none items-center gap-2 rounded-xl px-3 py-2 outline-none data-[highlighted]:bg-white', className)} {...props}>
      <span className="flex h-4 w-4 items-center justify-center rounded border">
        <Dropdown.ItemIndicator>✓</Dropdown.ItemIndicator>
      </span>
      {children}
    </Dropdown.CheckboxItem>
  );
}

export const DropdownMenuLabel = ({ children }: { children: React.ReactNode }) => (
  <Dropdown.Label className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{children}</Dropdown.Label>
);
export const DropdownMenuSeparator = () => <Dropdown.Separator className="my-1 h-px bg-border" />;
