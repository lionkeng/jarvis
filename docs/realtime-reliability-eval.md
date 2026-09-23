# How to evaluate GPT-Live UI tool reliability

Use this procedure to score live sessions for the voice demo, on GPT Live-1 and on Gemini 3.8 Live. Deterministic simulation proves the browser executor. It does not prove model routing, sentence quality, or acknowledgement length.

This document carries the corpus, the scoring rules, and the trial record fields. The repository holds no baseline run and no scored results. The maintainer keeps those as local working notes outside the repository. Record your own baseline run first, then compare later runs against it.

## Run the offline eval first

The live corpus scores the voice model. The offline eval scores the interpretation step on its own. Run it first, and fix what it finds before you spend a live session.

`pnpm build && pnpm eval:interpret --dry-run` needs no key and no network. It builds every answer from the corpus label, so it proves the harness and the corpus rather than the model. Every number should read 100 percent.

`pnpm eval:interpret` with `TYPESAFE_API_KEY` set calls TypeSafe for each corpus entry. It prints accuracy per command kind, confidence against correctness, request latency, and input tokens per request. Set the three confidence bars from that confidence table and write them into the shipped defaults. Only then run the live corpus below.

## Start a Live session

1. Set `OPENAI_API_KEY` in `server/.env` and start the BFF. Defaults are `OPENAI_LIVE_MODEL=gpt-live-1` and `OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-luna`.
2. Open `http://localhost:5180/`, select **OpenAI**, and connect.
3. Confirm startup waits for `session.started`. Speak and verify both audible playback and UI action results.
4. End the conversation and confirm `session.closed` supplies final cumulative voice seconds. A dropped connection or timeout leaves final usage unconfirmed.

Record both model IDs for each OpenAI trial. Also record pacing preferences, spoken captions, backend events, action results, and usage.

Check overlapping speech without cancelling backend actions, late caption fragments, duplicate function items, failures, and reconnects. Backend text must not appear as spoken captions. Score short acknowledgements from actual speech; prompt instructions cannot guarantee exact length or silence.

## Start a Gemini session

1. Set `GEMINI_API_KEY` in `server/.env` and start the BFF. `GEMINI_LIVE_MODEL` is optional and defaults to `gemini-3.8-live`. The other accepted value is `gemini-3.8-live-extended-thinking`.
2. Open `http://localhost:5180/`, select **Gemini**, and connect.
3. Speak and verify both audible playback and UI action results.
4. End the conversation. The browser closes the WebSocket without waiting for a provider message.

Record the Gemini model id with every Gemini trial. Also record pacing preferences, spoken captions, action results, and transcript rows.

Several recorded fields apply to OpenAI trials only. Gemini has no backend model, so its trials have no backend events and no backend text to score. Gemini sends no `session.started` and no `session.closed`. Gemini reports no usage seconds, so leave the usage fields empty. Gemini transcripts carry no timestamps, so score its rows by content and order alone.

Gemini drops its pending function calls when Google reports an interruption. The browser still runs the capability, and the channel then discards the result instead of sending it. Record that trial as interrupted and do not classify it as a reporting failure.

A Gemini connection lasts about 10 minutes, then the channel reconnects on its own. The conversation continues, and the demo shows no disconnect. Each reconnect posts to `/session` again and spends one session-budget slot, so raise `SESSION_BUDGET_REQUESTS` before a long corpus run. A reconnect also drops pending function calls, so repeat any trial that straddles one.

## Run the trial corpus

Run at least 20 UI trials, distributed evenly across these four scenarios.

1. Fresh session, standalone navigation. Say “Open library.” Expect one call with one sentence that opens the library page.
2. Chained session. Say “Open library,” then after success say “Open article and scroll.” Expect the second turn to contain one call with two sentences, opening the article page and then scrolling the article down. The chained case section below gives the full steps.
3. Explicit compound direction. Say “Open the article and scroll to the bottom.” Expect one call with two sentences, and the second must keep the words that mean the whole way.
4. Compound selection. Say “Open the library and select Atlas.” Expect one call with two sentences, opening the library page and then selecting Atlas.

Run at least five ordinary-question trials. Cover short factual questions and questions about the demo's capabilities. Expect speech only and no UI tool call.

Run these safety checks once each. None of them is scored.

- Cancel or interrupt during an active UI command.
- Confirm the browser rejects invalid arguments. The deterministic demo and surface suites cover those rules under `pnpm test`.
- Ask for something the surface does not offer and confirm the runner reports it as nothing on this screen.
- Disconnect while the browser reports a result.
- Ask for detail and confirm the direct-answer length rule allows a longer response.
- Issue a pointer navigation before a self-contained voice command, then confirm the voice command still succeeds.

Run the corpus once for each protocol you evaluate. The Gemini section above names the fields that stay empty on Gemini trials.

## Reset UI state between independent trials

Reset the hash route to `#/dashboard` and restore the demo model to its starting theme, library selection, details-panel, bookmark, and scroll positions. Independent trials need a fresh UI even when you keep the same Live connection. Fresh-session cases also need a new Live connection.

- Open a new Live connection after every server restart and after every server configuration change.
- Use a fresh session for each standalone case. Use one deliberate chained session for the follow-up case.
- Keep the model, response timing, speech rate, browser, and microphone constant between the baseline run and the final run where practical.

## Run the chained library then article case

1. Start on the dashboard in a new or reset session.
2. Say “Open library.” Wait until navigation finishes and the success acknowledgement ends.
3. Say “Open article and scroll.”
4. Expect one `request_ui_changes` call whose `requests` array is a sentence that opens the article page followed by a sentence that scrolls the article down, and expect each sentence to decode to the matching command.

Treat “Open the article and scroll to the bottom” as a separate compound case. The explicit bottom direction is authoritative there.

## Record each trial

Record these fields for each live trial.

- run ID and timestamp
- model IDs and server commit
- browser, microphone, response timing, and speech rate
- fresh or chained session
- starting route
- spoken utterance
- input transcription
- model decision
- tool name and the request sentences
- parser outcome and the command decoded from each sentence
- applied effects and execution outcome
- `addedMs`, the time from tool call to execute start
- failure stage and code
- acknowledgement transcript, sentences, and words
- unexpected second tool call
- notes

## Score a run

### Correct routing and execution

A UI trial passes only when every one of these holds.

- The model calls `request_ui_changes` exactly once.
- The call carries the expected number of sentences in the expected order.
- Every sentence decodes to a command, and each command is the expected one.
- All expected UI effects complete successfully.
- The model emits no competing spoken answer before the tool call.

The aggregate gate is at least 19 passing UI trials out of 20.

Record the median `addedMs` over the run. Above 300 ms, prefetching the interpretation from the input transcript becomes the next piece of work.

### Schema validity

Every emitted UI call must pass browser parsing. One invalid emitted call fails the 100 percent schema-valid gate, even when a later retry succeeds.

### Ordinary questions

No ordinary-question trial may call `request_ui_changes` or mutate the UI.

### Successful acknowledgements

Score the provider transcript of the post-tool spoken response, not the input transcription.

- Split sentences on `.`, `?`, and `!`.
- Split words on whitespace after trimming punctuation around tokens.

A success acknowledgement passes only when every one of these holds.

- It follows a successful result.
- It is one sentence of at most ten transcribed words.
- It exposes no target IDs, no JSON, no internal action types, and no action counts.
- It starts no second tool call.
- It claims no effect that the browser did not report as successful.

### Failure and cancellation

- A failure may produce one concise explanation. The model must not retry on its own.
- Cancellation must not produce an unsolicited follow-up response.
- Partial execution must stay visible in the structured browser result, even though no automatic replay occurs.

## Classify a failure

Inspect the browser interaction result before you assign a stage. Assign exactly one primary stage.

- Transcription. The spoken words and the input transcript disagree enough that routing from the transcript would mislead. Still classify routing from the model’s actual tool call or speech.
- Routing. The model spoke instead of calling `request_ui_changes`, called the tool for an ordinary question, or dropped or merged a requested change.
- Arguments. The call existed but the browser parser rejected it.
- Interpretation. The parser accepted the call and a sentence decoded to none, unclear, malformed, or the wrong command.
- Execution. The parser accepted the call and the browser failed to apply the expected effects.
- Reporting. The browser applied the effects and did not submit a tool result.
- Acknowledgement. The result was reported and the follow-up speech was too long, claimed an unreported success, or called a tool again.

## Simulator results

The simulated scripts on the voice-first demo in simulation mode exercise the runner and the ordered executor against a fixed answer table. Mark those rows as simulation. Do not count them toward the 19 of 20 live routing gate.
