import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type UIEvent } from "react";
import type { TranscriptMessage, TranscriptStore } from "@jarvis-viz/core";

export interface TranscriptViewProps {
  store: TranscriptStore;
  height?: number;
  rowHeight?: number;
  className?: string;
}

const roleLabel = (role: TranscriptMessage["role"]) => role === "agent" ? "Agent" : "You";

export function TranscriptView({ store, height = 280, rowHeight = 68, className }: TranscriptViewProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const searchId = useId();
  const messages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? snapshot.messages.filter((message) => message.text.toLocaleLowerCase().includes(normalized)) : snapshot.messages;
  }, [query, snapshot]);
  const overscan = 3;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(height / rowHeight) + overscan * 2;
  const visible = messages.slice(start, start + count);
  const latestAgent = [...snapshot.messages].reverse().find((message) => message.role === "agent");

  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const nextScrollTop = Math.max(0, messages.length * rowHeight - height);
    setScrollTop(nextScrollTop);
    if (viewportRef.current) viewportRef.current.scrollTop = nextScrollTop;
  }, [height, messages.length, rowHeight, snapshot.revision]);

  const styles: Record<string, CSSProperties> = {
    root: { color: "inherit", font: "13px ui-monospace, SFMono-Regular, Menlo, monospace" },
    label: { display: "block", marginBottom: 6, fontSize: 11, fontWeight: 700 },
    input: { width: "100%", boxSizing: "border-box", padding: "9px 10px", border: "1px solid currentColor", borderRadius: 8, color: "inherit", background: "transparent" },
    viewport: { position: "relative", height, overflowY: "auto", marginTop: 10, borderTop: "1px solid color-mix(in srgb, currentColor 24%, transparent)" },
    spacer: { position: "relative", height: messages.length * rowHeight },
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    const maxScrollTop = Math.max(0, messages.length * rowHeight - height);
    pinnedRef.current = maxScrollTop - nextScrollTop <= rowHeight;
    setScrollTop(nextScrollTop);
  };

  return (
    <section className={className} style={styles.root} aria-label="Conversation transcript">
      <label style={styles.label} htmlFor={searchId}>Search transcript</label>
      <input id={searchId} style={styles.input} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find a phrase" />
      <div ref={viewportRef} style={styles.viewport} onScroll={onScroll} tabIndex={0} aria-label="Transcript messages">
        <div style={styles.spacer}>
          {visible.map((message, index) => (
            <article key={message.id} style={{ position: "absolute", top: (start + index) * rowHeight, left: 0, right: 0, height: rowHeight, padding: "10px 4px", boxSizing: "border-box" }}>
              <strong>{roleLabel(message.role)}</strong>
              <div>{message.text || "Waiting for speech"}</div>
            </article>
          ))}
        </div>
      </div>
      <p aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {latestAgent ? `Agent: ${latestAgent.text}` : "No agent response yet"}
      </p>
    </section>
  );
}
