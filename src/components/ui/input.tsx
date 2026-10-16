"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-lab-border bg-lab-void/60 px-3 py-1 font-mono text-sm text-lab-text",
        "placeholder:text-lab-muted/60 focus-visible:outline-none focus-visible:border-lab-accent/60",
        "focus-visible:ring-1 focus-visible:ring-lab-accent/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[70px] w-full rounded-md border border-lab-border bg-lab-void/60 px-3 py-2 font-mono text-sm text-lab-text",
        "placeholder:text-lab-muted/60 focus-visible:outline-none focus-visible:border-lab-accent/60",
        "focus-visible:ring-1 focus-visible:ring-lab-accent/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Input, Textarea };
