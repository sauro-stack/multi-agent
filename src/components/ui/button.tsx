"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent/60 [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-lab-accent text-lab-void hover:bg-lab-accent/85 shadow-[0_0_20px_-6px_rgba(53,224,161,0.6)]",
        secondary:
          "bg-lab-panel-2 text-lab-text border border-lab-border hover:border-lab-accent/50 hover:bg-lab-panel-2/80",
        outline:
          "border border-lab-border bg-transparent text-lab-text hover:border-lab-accent/50 hover:text-white",
        ghost: "text-lab-muted hover:text-lab-text hover:bg-white/5",
        danger:
          "bg-lab-red/15 text-lab-red border border-lab-red/40 hover:bg-lab-red/25 hover:text-white",
        amber:
          "bg-lab-amber/15 text-lab-amber border border-lab-amber/40 hover:bg-lab-amber/25 hover:text-white",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-7 rounded px-2.5 text-xs",
        lg: "h-11 rounded-md px-6 text-[15px]",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
