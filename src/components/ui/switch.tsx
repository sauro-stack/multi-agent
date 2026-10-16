"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-lab-border transition-colors",
      "data-[state=checked]:bg-lab-accent/30 data-[state=checked]:border-lab-accent/60 data-[state=unchecked]:bg-lab-panel-2",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent/50 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block size-3.5 rounded-full bg-lab-text shadow-lg transition-transform",
        "data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[3px] data-[state=checked]:bg-lab-accent",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = "Switch";

export { Switch };
