export type DiffLine = { kind: "context" | "removed" | "added"; text: string; before: number | null; after: number | null };
/** Bounded, exact line diff for the reviewed replacement (not a guessed game file).
 * Preserve common prefix/suffix context and show the entire changed middle.
 */
export function replacementDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n"), right = after.split("\n");
  let start = 0, end = 0;
  while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
  while (end < Math.min(left.length, right.length) - start && left[left.length-end-1] === right[right.length-end-1]) end++;
  return [
    ...left.slice(0,start).map((text,index): DiffLine => ({ kind: "context", text, before: index+1, after: index+1 })),
    ...left.slice(start,left.length-end).map((text,index): DiffLine => ({ kind: "removed", text, before: start+index+1, after: null })),
    ...right.slice(start,right.length-end).map((text,index): DiffLine => ({ kind: "added", text, before: null, after: start+index+1 })),
    ...left.slice(left.length-end).map((text,index): DiffLine => ({ kind: "context", text, before: left.length-end+index+1, after: right.length-end+index+1 })),
  ];
}
