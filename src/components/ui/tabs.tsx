import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex w-full gap-1.5 overflow-x-auto p-0.5', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn('glass-strong whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] font-medium text-ink-2 shadow-none transition-colors hover:bg-white hover:text-foreground data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-white',
        className)}
      {...props} />
  );
}

export function TabsContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-4 focus-visible:outline-none', className)} {...props} />;
}
