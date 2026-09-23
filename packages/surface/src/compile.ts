import type {
  ChoiceQuestion,
  ControlCriterion,
  InterpretQuestion,
  InterpretRequest,
  ItemCriterion,
  VoiceControl,
} from "./types.js";

export const MAX_CONTROL_OPTIONS = 16;

export const OPERATES_INSTRUCTIONS =
  "Does `request` ask to change, open, close, select, move, or operate something on the screen described by `screen`, rather than ask a question or make conversation?";
export const CONTROL_INSTRUCTIONS = "Which control on `screen` does `request` ask to operate?";
export const NO_CONTROL_DESCRIPTION = "The request does not operate any control on this screen";
export const NOT_STATED = "not_stated";
export const NO_CONTROL = "none";
export const AMOUNT_INSTRUCTIONS = "How large a change does `request` ask for?";
export const AMOUNT_LEVELS = [
  "The smallest step, with words such as a touch, a bit, a little, or slightly",
  "One ordinary step, with no size words",
  "A large step, with words such as a lot, much, or way",
  "The whole way, with words such as all the way, to the top, to the bottom, to the end, or fully",
];

export interface CompileInterpretRequestInput {
  request: string;
  screen: Record<string, string>;
  controls: VoiceControl[];
}

export function itemQuestionId(controlId: string): string {
  return `${controlId}/item`;
}

export function polarityQuestionId(controlId: string): string {
  return `${controlId}/polarity`;
}

export function axisQuestionId(controlId: string): string {
  return `${controlId}/axis`;
}

export function compileInterpretRequest(input: CompileInterpretRequestInput): InterpretRequest {
  const { request, screen, controls } = input;
  const questions: Record<string, InterpretQuestion> = {
    operates: { type: "noul", instructions: OPERATES_INSTRUCTIONS },
    control: controlQuestion(controls),
  };

  for (const control of controls) {
    if (control.kind !== "pick" && control.kind !== "toggle") continue;
    if (control.items.length < 2) continue;
    questions[itemQuestionId(control.id)] = {
      type: "choice",
      instructions: `Assume \`request\` operates ${control.what}. Which one does it name?`,
      criteria: {
        ...Object.fromEntries(control.items.map((item) => [item.id, itemCriterion(item.spoken, item.hint)])),
        [NOT_STATED]: "No listed option fits",
      },
    };
  }

  for (const control of controls) {
    if (control.kind !== "toggle") continue;
    questions[polarityQuestionId(control.id)] = {
      type: "choice",
      instructions: `Assume \`request\` operates ${control.what}. Does it ask to turn it on or off?`,
      criteria: {
        on: "Turn on, open, show, enable, add, or start",
        off: "Turn off, close, hide, disable, remove, or stop",
        [NOT_STATED]: "The request does not say which, such as toggle, switch, or flip",
      },
    };
  }

  let hasAdjust = false;
  for (const control of controls) {
    if (control.kind !== "adjust") continue;
    hasAdjust = true;
    const criteria: Record<string, ItemCriterion | null> = {};
    for (const axis of control.axes) {
      criteria[`${axis.id}.more`] = axis.more;
      criteria[`${axis.id}.less`] = axis.less;
    }
    criteria[NOT_STATED] = null;
    questions[axisQuestionId(control.id)] = {
      type: "choice",
      instructions: `Assume \`request\` moves ${control.what}. Which way?`,
      criteria,
    };
  }

  if (hasAdjust) {
    questions["amount"] = { type: "score", instructions: AMOUNT_INSTRUCTIONS, criteria: [...AMOUNT_LEVELS] };
  }

  return { state: { request, screen }, questions };
}

function controlQuestion(controls: VoiceControl[]): ChoiceQuestion {
  const criteria: Record<string, ControlCriterion | ItemCriterion | null> = {};
  for (const control of controls) criteria[control.id] = controlCriterion(control);
  criteria[NO_CONTROL] = NO_CONTROL_DESCRIPTION;
  return { type: "choice", instructions: CONTROL_INSTRUCTIONS, criteria };
}

function controlCriterion(control: VoiceControl): ControlCriterion {
  switch (control.kind) {
    case "press":
      return { what: control.what };
    case "pick":
    case "toggle":
      return { what: control.what, options: control.items.slice(0, MAX_CONTROL_OPTIONS).map((item) => item.spoken) };
    case "adjust": {
      const options: string[] = [];
      for (const axis of control.axes) options.push(axis.more, axis.less);
      return { what: control.what, options: options.slice(0, MAX_CONTROL_OPTIONS) };
    }
    default: {
      const unreachable: never = control;
      throw new Error(`Unexpected control ${JSON.stringify(unreachable)}`);
    }
  }
}

function itemCriterion(spoken: string, hint: string | undefined): ItemCriterion {
  return hint === undefined ? spoken : { spoken, hint };
}
