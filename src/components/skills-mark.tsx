import type { SVGProps } from "react";

/** Two offset building blocks around a core, echoing Romanum's tilted square. */
export function SkillsMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
      <g transform="rotate(-12 12 12)">
        <path d="M4 4h10v3H7v7H4V4Zm16 16H10v-3h7v-7h3v10Z" />
        <path d="M10 10h4v4h-4z" />
      </g>
    </svg>
  );
}
