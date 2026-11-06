import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[transform,background-color,box-shadow,color] duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-primary/90 bg-primary/90 text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_6px_16px_rgba(29,29,27,.22)] hover:bg-primary/80',
        destructive: 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
        outline: 'glass-strong text-foreground hover:bg-white',
        secondary: 'glass-strong text-foreground hover:bg-white',
        ghost: 'hover:bg-black/5',
        link: 'text-primary underline-offset-4 hover:underline px-0',
      },
      size: {
        default: 'h-10 px-[18px] py-2',
        sm: 'h-8 px-3 text-[12.5px]',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} disabled={disabled || loading}
            aria-busy={loading || undefined} {...props}>
        {asChild ? children : (<>{loading && <Loader2 className="animate-spin" aria-hidden />}{children}</>)}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
