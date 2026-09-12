export type TranscriptRole = "user" | "agent";
export type TranscriptStatus = "streaming" | "complete" | "interrupted";

export interface TranscriptFragment {
  delta: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptMessage {
  fragments?: readonly TranscriptFragment[];
  id: string;
  role: TranscriptRole;
  text: string;
  startedAt: number;
  updatedAt: number;
  status: TranscriptStatus;
}

export interface TranscriptSnapshot {
  messages: readonly TranscriptMessage[];
  revision: number;
}

export type TranscriptListener = (snapshot: TranscriptSnapshot) => void;
