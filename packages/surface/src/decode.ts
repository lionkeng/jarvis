import { NOT_STATED, NO_CONTROL, axisQuestionId, itemQuestionId, polarityQuestionId } from "./compile.js";
import type {
  ChoiceAnswer,
  ConfidenceBars,
  InterpretAnswerMap,
  Interpretation,
  NoulAnswer,
  ScoreAnswer,
  VoiceCommand,
  VoiceControl,
  VoiceItem,
} from "./types.js";

export const DEFAULT_BARS: ConfidenceBars = { operates: 0.5, ordinary: 0.5, high: 0.85 };

export interface DecodeInterpretAnswersInput {
  answers: InterpretAnswerMap;
  controls: VoiceControl[];
  bars?: ConfidenceBars;
}

export function decodeInterpretAnswers(input: DecodeInterpretAnswersInput): Interpretation {
  const { answers, controls } = input;
  const bars = input.bars ?? DEFAULT_BARS;

  const operatesAnswer = readNoul(answers, "operates");
  if (operatesAnswer === undefined) return malformed("operates is missing or is not a noul answer");
  const operates = operatesAnswer.noul;
  if (operates < bars.operates) return { kind: "none", operates, confidence: 1 - operates };

  const controlAnswer = readChoice(answers, "control");
  if (controlAnswer === undefined) return malformed("control is missing or is not a choice answer");
  if (controlAnswer.choice === NO_CONTROL) return { kind: "none", operates, confidence: controlAnswer.confidence };

  const control = controls.find((candidate) => candidate.id === controlAnswer.choice);
  if (control === undefined) return malformed(`control names ${controlAnswer.choice}, which is not on screen`);

  const controlNames = new Map(controls.map((candidate) => [candidate.id, candidate.what]));
  const controlCandidates = (): string[] => topTwo(controlAnswer, (key) => controlNames.get(key));
  const consumed: Consumed[] = [{ confidence: controlAnswer.confidence, candidates: controlCandidates }];
  let command: VoiceCommand;

  switch (control.kind) {
    case "press": {
      command = { control: control.id, kind: "press" };
      break;
    }
    case "pick": {
      const picked = readItem(answers, control, control.items, consumed);
      if (picked.kind !== "item") return picked.result;
      command = { control: control.id, kind: "pick", item: picked.item.id };
      break;
    }
    case "toggle": {
      const picked = readItem(answers, control, control.items, consumed);
      if (picked.kind !== "item") return picked.result;
      const polarity = readChoice(answers, polarityQuestionId(control.id));
      if (polarity === undefined) return malformed(`${polarityQuestionId(control.id)} is missing or is not a choice answer`);
      consumed.push({
        confidence: polarity.confidence,
        candidates: () => topTwo(polarity, (key) => (key === "on" || key === "off" ? key : undefined)),
      });
      let to: "on" | "off";
      if (polarity.choice === "on" || polarity.choice === "off") to = polarity.choice;
      else if (polarity.choice === NOT_STATED) to = picked.item.on === true ? "off" : "on";
      else return malformed(`${polarityQuestionId(control.id)} names ${polarity.choice}, which is not a polarity`);
      command = { control: control.id, kind: "toggle", item: picked.item.id, to };
      break;
    }
    case "adjust": {
      const axisAnswer = readChoice(answers, axisQuestionId(control.id));
      if (axisAnswer === undefined) return malformed(`${axisQuestionId(control.id)} is missing or is not a choice answer`);
      const words = new Map<string, string>();
      for (const axis of control.axes) {
        words.set(`${axis.id}.more`, axis.more);
        words.set(`${axis.id}.less`, axis.less);
      }
      consumed.push({
        confidence: axisAnswer.confidence,
        candidates: () => topTwo(axisAnswer, (key) => words.get(key)),
      });
      if (axisAnswer.choice === NOT_STATED) {
        return {
          kind: "unclear",
          candidates: topTwo(axisAnswer, (key) => words.get(key)),
          confidence: lowest(consumed),
        };
      }
      const split = axisAnswer.choice.lastIndexOf(".");
      const axisId = axisAnswer.choice.slice(0, split);
      const direction = axisAnswer.choice.slice(split + 1);
      if (!control.axes.some((axis) => axis.id === axisId) || (direction !== "more" && direction !== "less")) {
        return malformed(`${axisQuestionId(control.id)} names ${axisAnswer.choice}, which is not an axis direction`);
      }
      const amountAnswer = readScore(answers, "amount");
      if (amountAnswer === undefined) return malformed("amount is missing or is not a score answer");
      // The amount levels are not a question the user can answer, so a weak amount asks about the control.
      consumed.push({ confidence: amountAnswer.confidence, candidates: controlCandidates });
      command = { control: control.id, kind: "adjust", axis: axisId, direction, amount: amountFor(amountAnswer.score) };
      break;
    }
    default: {
      const unreachable: never = control;
      throw new Error(`Unexpected control ${JSON.stringify(unreachable)}`);
    }
  }

  const confidence = lowest(consumed);
  const bar = "risk" in control && control.risk === "high" ? bars.high : bars.ordinary;
  if (confidence < bar) {
    return { kind: "unclear", candidates: (weakest(consumed) ?? { candidates: controlCandidates }).candidates(), confidence };
  }
  return { kind: "command", command, control, confidence };
}

type Consumed = { confidence: number; candidates: () => string[] };

type ItemRead = { kind: "item"; item: VoiceItem } | { kind: "stop"; result: Interpretation };

function readItem(
  answers: InterpretAnswerMap,
  control: VoiceControl,
  items: VoiceItem[],
  consumed: Consumed[],
): ItemRead {
  const only = items[0];
  if (items.length === 1 && only !== undefined) return { kind: "item", item: only };
  if (only === undefined) return { kind: "stop", result: malformed(`${control.id} lists no items`) };
  const answer = readChoice(answers, itemQuestionId(control.id));
  if (answer === undefined) {
    return { kind: "stop", result: malformed(`${itemQuestionId(control.id)} is missing or is not a choice answer`) };
  }
  const spoken = new Map(items.map((item) => [item.id, item.spoken]));
  consumed.push({ confidence: answer.confidence, candidates: () => topTwo(answer, (key) => spoken.get(key)) });
  if (answer.choice === NOT_STATED) {
    return {
      kind: "stop",
      result: { kind: "unclear", candidates: topTwo(answer, (key) => spoken.get(key)), confidence: lowest(consumed) },
    };
  }
  const item = items.find((candidate) => candidate.id === answer.choice);
  if (item === undefined) {
    return {
      kind: "stop",
      result: malformed(`${itemQuestionId(control.id)} names ${answer.choice}, which ${control.id} does not list`),
    };
  }
  return { kind: "item", item };
}

function topTwo(answer: ChoiceAnswer, label: (key: string) => string | undefined): string[] {
  return Object.entries(answer.probabilities)
    .filter(([key]) => key !== NOT_STATED && key !== NO_CONTROL && label(key) !== undefined)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 2)
    .map(([key]) => label(key) ?? key);
}

function amountFor(score: number): 1 | 2 | 3 | 4 {
  const levels = [1, 2, 3, 4] as const;
  const rounded = Math.round(score);
  const level = rounded < 0 ? 0 : rounded > 3 ? 3 : rounded;
  return levels[level] ?? 1;
}

function lowest(consumed: Consumed[]): number {
  return consumed.reduce((low, entry) => (entry.confidence < low ? entry.confidence : low), 1);
}

function weakest(consumed: Consumed[]): Consumed | undefined {
  return consumed.reduce<Consumed | undefined>(
    (low, entry) => (low === undefined || entry.confidence < low.confidence ? entry : low),
    undefined,
  );
}

function malformed(reason: string): Interpretation {
  return { kind: "malformed", reason };
}

function readNoul(answers: InterpretAnswerMap, id: string): NoulAnswer | undefined {
  const answer = answers[id];
  if (answer === undefined || answer.type !== "noul") return undefined;
  return typeof answer.noul === "number" ? answer : undefined;
}

function readChoice(answers: InterpretAnswerMap, id: string): ChoiceAnswer | undefined {
  const answer = answers[id];
  if (answer === undefined || answer.type !== "choice") return undefined;
  if (typeof answer.choice !== "string" || typeof answer.confidence !== "number") return undefined;
  return typeof answer.probabilities === "object" && answer.probabilities !== null ? answer : undefined;
}

function readScore(answers: InterpretAnswerMap, id: string): ScoreAnswer | undefined {
  const answer = answers[id];
  if (answer === undefined || answer.type !== "score") return undefined;
  if (typeof answer.score !== "number" || typeof answer.confidence !== "number") return undefined;
  return answer;
}
