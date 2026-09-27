"use client";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

/** An on/off switch. Its label and description sit beside it, so the choice and what it means read together. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-fg">{label}</p>
        <p className="mt-0.5 text-xs leading-5 text-fg-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
          checked ? "bg-fg" : "bg-surface-hover"
        } ${FOCUS}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block size-4.5 rounded-full transition-transform motion-reduce:transition-none ${checked ? "translate-x-[19px] bg-canvas" : "translate-x-[3px] bg-fg-muted"}`}
        />
      </button>
    </div>
  );
}
