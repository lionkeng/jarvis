# How to evaluate GPT-Live UI tool reliability

Use this procedure to score live sessions for the voice demo, on GPT Live-1 and on Gemini 3.8 Live. Deterministic simulation proves the browser executor. It does not prove model routing, argument quality, or acknowledgement length.

The scoring rules and corpus live in `thoughts/shared/plans/2026-08-20-realtime-tool-reliability/testing.md`. Record each trial with the fields listed there. Compare a completed run with `thoughts/shared/research/2026-08-20-realtime-reliability-baseline.md` and store the scored table in `thoughts/shared/research/2026-08-20-realtime-reliability-results.md`.

## Start a Live session

1. Set `OPENAI_API_KEY` in `server/.env` and start the BFF. Defaults are `OPENAI_LIVE_MODEL=gpt-live-1` and `OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-luna`.
2. Open `http://localhost:5180/`, select **OpenAI**, and connect.
3. Confirm startup waits for `session.started`. Speak and verify both audible playback and UI action results.
4. End the conversation and confirm `session.closed` supplies final cumulative voice seconds. A dropped connection or timeout leaves final usage unconfirmed.

The historical baseline and corpus remain unchanged for comparison. Record both model IDs, pacing preferences, spoken captions, backend events, action results, and usage for each OpenAI trial.

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

## Reset UI state between independent trials

Reset the hash route to `#/dashboard` and restore the demo model to its starting theme, library selection, details-panel, bookmark, and scroll positions. Independent trials need a fresh UI even when you keep the same Live connection. Fresh-session cases also need a new Live connection.

## Run the chained library then article case

1. Start on the dashboard in a new or reset session.
2. Say “Open library.” Wait until navigation finishes and the success acknowledgement ends.
3. Say “Open article and scroll.”
4. Expect one `perform_ui_actions` call whose `actions` array is article navigation followed by one `article.content` scroll with `direction` `down`.

Treat “Open the article and scroll to the bottom” as a separate compound case. The explicit bottom direction is authoritative there.

## Count acknowledgement words

Score the provider transcript of the post-tool spoken response, not the input transcription.

- Split sentences on `.`, `?`, and `!`.
- Split words on whitespace after trimming punctuation around tokens.
- A success acknowledgement passes only when it is one sentence and at most ten words.
- Fail the trial if the acknowledgement names internal action types, target IDs, JSON, or action counts, or if it starts a second tool call.

## Classify a failure

Assign exactly one primary stage.

- Transcription. The spoken words and the input transcript disagree enough that routing from the transcript would mislead. Still classify routing from the model’s actual tool call or speech.
- Routing. The model spoke instead of calling `perform_ui_actions`, called the tool for an ordinary question, or produced the wrong action family.
- Arguments. The call existed but the browser parser rejected it.
- Execution. The parser accepted the call and the browser failed to apply the expected effects.
- Reporting. The browser applied the effects and did not submit a tool result.
- Acknowledgement. The result was reported and the follow-up speech was too long, claimed an unreported success, or called a tool again.

## Simulator results

The simulated scripts on the voice-first demo in simulation mode exercise the interaction actor and ordered executor. Mark those rows as simulation. Do not count them toward the 19 of 20 live routing gate.
