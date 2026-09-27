"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = { value: string; label: string; disabled?: boolean };

/** Select-only combobox. Trigger retains focus; a portal escapes clipped/scrolling cards. */
export function Select({ value, onChange, options, label, id, disabled = false, className = "" }: {
  value: string; onChange: (value: string) => void; options: readonly SelectOption[];
  label: string; id?: string; disabled?: boolean; className?: string;
}) {
  const generatedId = useId(), triggerId = id ?? generatedId, listId = `${triggerId}-options`;
  const trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number; width: number; height: number }>({ top: 0, left: 0, width: 0, height: 300 });
  const selected = options.findIndex((option) => option.value === value);

  function locate() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const height = Math.min(300, Math.max(80, below < 160 && above > below ? above : below));
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
    setPosition({ ...(below < 160 && above > below ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, height });
  }

  function show(index = selected >= 0 && !options[selected].disabled ? selected : options.findIndex((option) => !option.disabled)) {
    if (disabled || index < 0) return;
    locate(); setActive(index); setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value); setOpen(false); trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = () => locate();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
    if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (["Enter", " "].includes(event.key)) { event.preventDefault(); if (open) choose(active); else show(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!enabled.length) return;
      if (event.key === "Home") show(enabled[0]);
      else if (event.key === "End") show(enabled.at(-1));
      else if (!open) show();
      else setActive(enabled[(enabled.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const previous = Date.now() - typeahead.current.time < 700 ? typeahead.current.text : "";
      const text = (previous + event.key).toLocaleLowerCase();
      typeahead.current = { text, time: Date.now() };
      const match = options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(text));
      if (match >= 0) show(match);
    }
  }

  return <>
    <button ref={trigger} id={triggerId} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox"
      aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined}
      disabled={disabled} onKeyDown={keyDown} onClick={() => open ? setOpen(false) : show()}
      className={`inline-flex min-h-10 min-w-0 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 text-left text-sm text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40 ${className}`}>
      <span className="truncate">{options[selected]?.label ?? "Select"}</span><ChevronDown aria-hidden="true" className={`size-4 shrink-0 text-white transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && createPortal(<div ref={list} id={listId} role="listbox" aria-label={label}
      style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.height }}
      className="fixed z-[100] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-xl">
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} data-index={index} role="option" aria-selected={value === option.value} aria-disabled={option.disabled || undefined}
        onPointerDown={(event) => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}
        className={`flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${option.disabled ? "cursor-not-allowed text-fg-subtle" : active === index || value === option.value ? "bg-surface-hover text-white" : "text-fg"}`}>
        <span className="min-w-0 break-words">{option.label}</span>{value === option.value && <Check className="size-4 shrink-0 text-white" aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </>;
}
