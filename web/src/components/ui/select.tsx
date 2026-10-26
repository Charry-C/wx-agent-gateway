// 自定义下拉选择（替代原生 <select>，避免深色模式下原生弹层突兀）：
// 触发器与 Input 同款样式，弹层为卡片面板，支持键盘导航、点击外部/Esc 关闭、底部空间不足时向上弹出。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  /** 加在最外层容器上，用于控制宽度（w-28 / w-full 等） */
  className?: string;
  size?: "default" | "sm";
  ariaLabel?: string;
}

export function Select({
  value,
  options,
  onValueChange,
  className,
  size = "default",
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 打开时根据剩余空间决定弹出方向，并把高亮移到当前选中项
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setDropUp(window.innerHeight - rect.bottom < 240 && rect.top > 240);
    setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (next: string) => {
    onValueChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlight(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[highlight];
      if (option) choose(option.value);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={onKeyDown}
        className={cn(
          "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background text-left shadow-xs transition-[border-color,box-shadow] hover:border-muted-foreground/35 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-expanded:border-ring",
          size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3 text-[13px]",
        )}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? value}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute z-50 max-h-64 w-max min-w-full overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg animate-[dialog-in_0.15s_cubic-bezier(0.16,1,0.3,1)]",
            dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                onClick={() => choose(option.value)}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex h-8 cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 text-[13px]",
                  isSelected ? "font-medium text-foreground" : "text-muted-foreground",
                  index === highlight && "bg-accent text-foreground",
                )}
              >
                <span className="whitespace-nowrap">{option.label}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
