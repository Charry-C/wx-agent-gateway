import * as React from "react";
import { cn } from "@/lib/utils";

const fieldClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-muted-foreground/35 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type} className={cn(fieldClass, className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn("text-[13px] font-medium leading-none text-foreground/90", className)} {...props} />
  ),
);
Label.displayName = "Label";
