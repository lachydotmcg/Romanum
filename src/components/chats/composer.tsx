"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_QUESTION_CHARS } from "@/lib/chats/limits";
import { ReferencePicker } from "@/components/projects/reference-picker";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
/** The prompt grows with its text up to this height, then scrolls. */
const MAX_TEXT_HEIGHT = 208;

/** An image picked for the next message, previewed from the browser's own copy of the file. */
export type PendingImage = { id: string; file: File; url: string };

const isImage = (file: File) => (IMAGE_TYPES as readonly string[]).includes(file.type);

/** The chat's prompt bar: a message, up to three reference images (picked, pasted or dropped), send and stop. */
export function Composer({
  connected,
  running,
  suggestion,
  onSend,
  onStop,
  onDismissSuggestion,
  starters = [],
  projectId,
}: {
  connected: boolean;
  running: boolean;
  suggestion: string | null;
  /** Takes over the images' preview URLs. */
  onSend: (text: string, images: PendingImage[]) => void;
  onStop: () => void;
  onDismissSuggestion: () => void;
  starters?: { label: string; prompt: string }[];
  projectId?: string;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);
  const [referencePending, setReferencePending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Preview URLs this bar still owns, released when it unmounts.
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const owned = previews.current;
    return () => owned.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useLayoutEffect(() => {
    const field = textRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_TEXT_HEIGHT)}px`;
  }, [text]);

  function addFiles(files: File[]) {
    if (!files.length) return;
    const usable = files.filter((file) => isImage(file) && file.size <= MAX_ATTACHMENT_BYTES);
    const room = Math.max(0, MAX_ATTACHMENTS - imagesRef.current.length);
    const added = usable.slice(0, room).map((file) => {
      const url = URL.createObjectURL(file);
      previews.current.add(url);
      return { id: crypto.randomUUID(), file, url };
    });
    if (added.length) { imagesRef.current = [...imagesRef.current, ...added]; setImages(imagesRef.current); }
    setNotice(
      usable.length < files.length
        ? "Images must be PNG, JPEG or WebP, up to 5 MB."
        : usable.length > room
          ? "Attach up to 3 images."
          : null,
    );
  }

  function remove(image: PendingImage) {
    previews.current.delete(image.url);
    URL.revokeObjectURL(image.url);
    imagesRef.current = imagesRef.current.filter((item) => item.id !== image.id);
    setImages(imagesRef.current);
    setNotice(null);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = text.trim();
    if (!question || running || !connected || referencePending) return;
    for (const image of imagesRef.current) previews.current.delete(image.url);
    onSend(question, imagesRef.current);
    setText("");
    setImages([]);
    imagesRef.current = [];
    setNotice(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Tab" && !event.shiftKey && suggestion && !text) {
      // Tab only takes the suggestion while the bar is empty; otherwise it moves focus as usual.
      event.preventDefault();
      setText(suggestion);
    } else if (event.key === "Escape" && suggestion && !text) {
      onDismissSuggestion();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  }

  const dropProps = connected
    ? {
        onDragOver: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        },
      }
    : {};

  return (
    <div>
      <form
        onSubmit={submit}
        {...dropProps}
        aria-label="Chat"
        className={`rounded-3xl border bg-surface p-2 transition-colors ${dragging ? "border-line-strong" : "border-line focus-within:border-line-strong"}`}
      >
        {images.length > 0 && (
          <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-1 pt-1 pb-2">
            {images.map((image) => (
              <li key={image.id} className="relative">
                <Image
                  src={image.url}
                  alt={image.file.name}
                  width={56}
                  height={56}
                  unoptimized
                  className="size-14 rounded-xl border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => remove(image)}
                  aria-label={`Remove ${image.file.name}`}
                  title="Remove"
                  className={`absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-white text-black ${FOCUS}`}
                >
                  <X className="size-3" strokeWidth={2.5} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          ref={textRef}
          rows={1}
          value={text}
          disabled={!connected}
          maxLength={MAX_QUESTION_CHARS}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={suggestion ?? "Ask Romanum…"}
          aria-describedby={suggestion && !text ? "chat-suggestion-hint" : undefined}
          className={`block w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 text-fg focus:outline-none disabled:cursor-not-allowed ${
            suggestion ? "placeholder:text-fg-muted" : "placeholder:text-fg-subtle"
          }`}
        />
        <span id="chat-suggestion-hint" className="sr-only">
          Press Tab to use the suggested question.
        </span>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!connected || images.length >= MAX_ATTACHMENTS}
            aria-label="Attach images"
            title="Attach up to 3 images"
            className={`grid size-8 place-items-center rounded-full text-white hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-white/40 disabled:hover:bg-transparent ${FOCUS}`}
          >
            <ImagePlus className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {projectId && <ReferencePicker projectId={projectId} disabled={!connected || images.length >= MAX_ATTACHMENTS} onPick={file => addFiles([file])} onPendingChange={setReferencePending} />}
          {!connected && (
            <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-fg-muted">Not connected</span>
          )}
          <span className="flex-1" />
          <Link href="/privacy#ai" target="_blank" className={`inline-flex min-h-8 items-center rounded-sm text-xs text-fg-muted hover:text-fg ${FOCUS}`}>AI privacy</Link>
          {suggestion && !text && !running && (
            <button
              type="button"
              onClick={() => {
                setText(suggestion);
                textRef.current?.focus();
              }}
              aria-label={`Use suggestion: ${suggestion}`}
              className={`shrink-0 rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] leading-4 text-fg-muted hover:bg-surface-hover hover:text-fg ${FOCUS}`}
            >
              Tab
            </button>
          )}
          {running ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className={`grid size-8 shrink-0 place-items-center rounded-full bg-surface-hover text-fg ${FOCUS}`}
            >
              <Square className="size-3.5 fill-current text-white" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!connected || !text.trim() || referencePending}
              aria-label="Send"
              className={`grid size-8 shrink-0 place-items-center rounded-full bg-white text-black disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-white/40 ${FOCUS}`}
            >
              <ArrowUp className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      {starters.length > 0 && !text && !running && connected && <div className="mt-4 flex flex-wrap justify-center gap-2">{starters.map((starter) => <button key={starter.label} type="button" onClick={() => { setText(starter.prompt); textRef.current?.focus(); }} className={`min-h-10 rounded-lg border border-line px-3 text-xs text-fg-muted hover:bg-surface hover:text-fg ${FOCUS}`}>{starter.label}</button>)}</div>}
      {notice && (
        <p role="alert" className="mt-2 px-4 text-xs text-fg-muted">
          {notice}
        </p>
      )}
    </div>
  );
}
