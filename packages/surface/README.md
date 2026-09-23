# @jarvis-viz/surface

A host UI describes its own controls at runtime. This package turns one spoken request into a
typed command against that description, runs it, and reports the result back to the voice model.

The package has no runtime dependency. React is an optional peer, used only by the `./react`
subpath.

```ts
import {
  VoiceRegistry,
  compileInterpretRequest,
  createVoiceRunner,
  decodeInterpretAnswers,
} from "@jarvis-viz/surface";
import { useVoiceCapability } from "@jarvis-viz/surface/react";
```

## The four control kinds

| Kind | Pointer equivalent | Questions consumed |
|---|---|---|
| `press` | a button | the route Choice only |
| `pick` | one card, tab, link, or swatch in a set | item Choice |
| `toggle` | a checkbox, drawer, tray, or modal | item Choice, polarity Choice |
| `adjust` | chevrons, zoom, scroll, drag | axis Choice, amount Score |

## The pipeline

`compileInterpretRequest` turns a request sentence, a screen description, and the controls on
screen into `{ state, questions }` for one TypeSafe System One call. `decodeInterpretAnswers`
turns the answers back into a `VoiceCommand`, a `none`, an `unclear` with two candidates, or a
`malformed` reason. It applies the confidence bars in `DEFAULT_BARS`, so the offline eval and the
runner agree on which commands are certain enough to run. A command whose weakest answer sits
below its bar comes back as `unclear`, and the two candidates come from that weakest answer: the
control names, the item names, `on` and `off`, or the two direction words. A weak amount asks
about the control, because the size of a step is not a question the user can pick from.

`createVoiceRunner` chains `request_ui_changes` tool calls onto one promise, waits for the
registry to settle before it describes the screen, and submits exactly one tool result per call.
`VoiceRegistry` re-validates every decoded command against the current screen before it runs.
