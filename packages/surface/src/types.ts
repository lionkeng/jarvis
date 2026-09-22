export interface VoiceItem {
  id: string;
  spoken: string;
  hint?: string;
  on?: boolean;
}

export interface VoiceAxis {
  id: string;
  more: string;
  less: string;
}

export type VoiceControl =
  | { kind: "press"; id: string; what: string; risk?: "high" }
  | { kind: "pick"; id: string; what: string; items: VoiceItem[]; risk?: "high" }
  | { kind: "toggle"; id: string; what: string; items: VoiceItem[]; risk?: "high" }
  | { kind: "adjust"; id: string; what: string; axes: VoiceAxis[] };

export type VoiceCommand =
  | { control: string; kind: "press" }
  | { control: string; kind: "pick"; item: string }
  | { control: string; kind: "toggle"; item: string; to: "on" | "off" }
  | { control: string; kind: "adjust"; axis: string; direction: "more" | "less"; amount: 1 | 2 | 3 | 4 };

export interface VoiceOutcome {
  status: "done" | "no_effect" | "unavailable";
  say?: string;
  effects?: string[];
}

export interface VoiceDescription {
  control: VoiceControl;
  facts?: Record<string, string>;
}

export interface VoiceCapability {
  describe(): VoiceDescription;
  execute(command: VoiceCommand, signal: AbortSignal): Promise<VoiceOutcome>;
}

export type ToolCall = { callId: string; name: string; argumentsJson: string };
export type ToolResult = { callId: string; output: string };

export type ControlCriterion = { what: string; options?: string[] };
export type ItemCriterion = string | { spoken: string; hint: string };

export type NoulQuestion = { type: "noul"; instructions: string };
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, ControlCriterion | ItemCriterion | null>;
};
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type InterpretQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface InterpretRequest {
  state: { request: string; screen: Record<string, string> };
  questions: Record<string, InterpretQuestion>;
}

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type InterpretAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type InterpretAnswerMap = Record<string, InterpretAnswer>;

export interface InterpretAnswers {
  answers: InterpretAnswerMap;
  model?: string;
  usage?: Record<string, number>;
}

export interface ConfidenceBars {
  operates: number;
  ordinary: number;
  high: number;
}

export type Interpretation =
  | { kind: "command"; command: VoiceCommand; control: VoiceControl; confidence: number }
  | { kind: "none"; operates: number; confidence: number }
  | { kind: "unclear"; candidates: string[]; confidence: number }
  | { kind: "malformed"; reason: string };
