import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
  {
    variants: {
      tone: {
        default: "border-lab-border bg-lab-panel-2 text-lab-muted",
        active: "border-lab-accent/40 bg-lab-accent/12 text-lab-accent",
        warn: "border-lab-amber/45 bg-lab-amber/12 text-lab-amber",
        error: "border-lab-red/45 bg-lab-red/12 text-lab-red",
        idle: "border-lab-border bg-white/[0.03] text-lab-muted",
        done: "border-lab-cyan/40 bg-lab-cyan/10 text-lab-cyan",
        violet: "border-lab-violet/40 bg-lab-violet/10 text-lab-violet",
        cyan: "border-lab-cyan/40 bg-lab-cyan/10 text-lab-cyan",
        emerald: "border-lab-accent/40 bg-lab-accent/10 text-lab-accent",
        amber: "border-lab-amber/45 bg-lab-amber/10 text-lab-amber",
        rose: "border-lab-red/45 bg-lab-red/10 text-lab-red",
        slate: "border-lab-border bg-white/[0.04] text-lab-muted",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
