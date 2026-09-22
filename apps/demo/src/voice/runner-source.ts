import {
  NOT_STATED,
  NO_CONTROL,
  axisQuestionId,
  itemQuestionId,
  polarityQuestionId,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Interpret,
  type InterpretAnswer,
  type InterpretAnswerMap,
  type InterpretAnswers,
  type InterpretQuestion,
  type InterpretRequest,
  type ScoreAnswer,
  type ScoreQuestion,
  type VoiceCommand,
} from "@jarvis-viz/surface";

/** A sentence the table does not list answers as conversation rather than a control. */
const NEUTRAL_OPERATES = 0.05;
const OPERATES = 0.95;

export type SimulationAnswer = "none" | VoiceCommand;
export type SimulationTable = Record<string, SimulationAnswer>;

/**
 * The sentences the simulation scripts emit, plus one ambiguous request.
 * "select a library card" names no card, so its item answer is not_stated and the runner reports unclear.
 */
export const SIMULATION_TABLE: SimulationTable = {
  "go to the dashboard page": { control: "navigation", kind: "pick", item: "dashboard" },
  "go to the library page": { control: "navigation", kind: "pick", item: "library" },
  "go to the article page": { control: "navigation", kind: "pick", item: "article" },
  "go to the settings page": { control: "navigation", kind: "pick", item: "settings" },
  "select the Atlas card": { control: "library.item", kind: "pick", item: "atlas" },
  "select a library card": { control: "library.item", kind: "pick", item: NOT_STATED },
  "open the library details panel": { control: "library.details", kind: "toggle", item: "details", to: "on" },
  "close the library details panel": { control: "library.details", kind: "toggle", item: "details", to: "off" },
  "put the cursor in the search box": { control: "dashboard.search", kind: "press" },
  "bookmark this article": { control: "article.bookmark", kind: "toggle", item: "bookmark", to: "on" },
  "scroll the article down": { control: "article.content", kind: "adjust", axis: "vertical", direction: "more", amount: 2 },
  "scroll the article to the bottom": { control: "article.content", kind: "adjust", axis: "vertical", direction: "more", amount: 4 },
};

export function createLiveInterpret(sessionEndpoint: string): Interpret {
  return async (request, signal) => {
    const response = await fetch(new URL("/interpret", sessionEndpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (response.status !== 200) throw new Error(`Interpretation returned status ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Interpretation returned status ${response.status} with a body that is not JSON`);
    }
    if (!isPlainObject(body) || !isPlainObject(body.answers)) {
      throw new Error(`Interpretation returned status ${response.status} with no answers`);
    }
    const answers: InterpretAnswerMap = {};
    for (const [id, answer] of Object.entries(body.answers)) answers[id] = answer as InterpretAnswer;
    const parsed: InterpretAnswers = { answers };
    if (typeof body.model === "string") parsed.model = body.model;
    if (isPlainObject(body.usage)) parsed.usage = numbersOf(body.usage);
    return parsed;
  };
}

export function createSimulatedInterpret(table: SimulationTable): Interpret {
  return async (request) => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    return { answers: simulatedAnswers(request, table[request.state.request] ?? "none") };
  };
}

function simulatedAnswers(request: InterpretRequest, spec: SimulationAnswer): InterpretAnswerMap {
  const answers: InterpretAnswerMap = {};
  for (const [id, question] of Object.entries(request.questions)) answers[id] = neutralAnswer(id, question);
  if (spec === "none") return answers;

  answers["operates"] = { type: "noul", noul: OPERATES };
  const control = request.questions["control"];
  if (control?.type === "choice") answers["control"] = choiceAnswer(control, spec.control);

  if (spec.kind === "pick" || spec.kind === "toggle") {
    const id = itemQuestionId(spec.control);
    const item = request.questions[id];
    if (item?.type === "choice") answers[id] = choiceAnswer(item, spec.item);
  }
  if (spec.kind === "toggle") {
    const id = polarityQuestionId(spec.control);
    const polarity = request.questions[id];
    if (polarity?.type === "choice") answers[id] = choiceAnswer(polarity, spec.to);
  }
  if (spec.kind === "adjust") {
    const id = axisQuestionId(spec.control);
    const axis = request.questions[id];
    if (axis?.type === "choice") answers[id] = choiceAnswer(axis, `${spec.axis}.${spec.direction}`);
    const amount = request.questions["amount"];
    if (amount?.type === "score") answers["amount"] = scoreAnswer(amount, spec.amount - 1);
  }
  return answers;
}

function neutralAnswer(id: string, question: InterpretQuestion): InterpretAnswer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: NEUTRAL_OPERATES };
    case "choice":
      return choiceAnswer(question, id === "control" ? NO_CONTROL : NOT_STATED);
    case "score":
      return scoreAnswer(question, 0);
    default: {
      const unreachable: never = question;
      throw new Error(`Unexpected question ${JSON.stringify(unreachable)}`);
    }
  }
}

function choiceAnswer(question: ChoiceQuestion, choice: string): ChoiceAnswer {
  const probabilities: Record<string, number> = {};
  for (const key of Object.keys(question.criteria)) probabilities[key] = key === choice ? 1 : 0;
  return { type: "choice", choice, probabilities, confidence: 1 };
}

/** TypeSafe keys a score answer's legend and probabilities by the level index as a string. */
function scoreAnswer(question: ScoreQuestion, level: number): ScoreAnswer {
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  question.criteria.forEach((text, index) => {
    legend[String(index)] = text;
    probabilities[String(index)] = index === level ? 1 : 0;
  });
  return { type: "score", score: level, legend, probabilities, confidence: 1 };
}

function numbersOf(value: Record<string, unknown>): Record<string, number> {
  const numbers: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "number") numbers[key] = entry;
  return numbers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
