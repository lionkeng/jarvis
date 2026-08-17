export type TranscriptRole = "user" | "agent";
export type TranscriptStatus = "streaming" | "complete" | "interrupted";

export interface TranscriptMessage {
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
