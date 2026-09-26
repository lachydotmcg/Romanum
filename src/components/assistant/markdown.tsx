import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 font-semibold text-fg">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 font-semibold text-fg">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 font-semibold text-fg">{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left tabular-nums">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line-strong py-1.5 pr-4 font-medium text-fg-muted">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line py-1.5 pr-4 align-top">{children}</td>,
};

/** Renders the assistant's Markdown. Raw HTML in the text is not rendered. */
export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {text}
    </Markdown>
  );
}
