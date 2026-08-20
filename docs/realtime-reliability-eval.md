# How to evaluate Realtime UI tool reliability

Use this procedure to score live OpenAI Realtime sessions for the voice demo. Deterministic simulation proves the browser executor. It does not prove model routing, argument quality, or acknowledgement length.

The scoring rules and corpus live in `thoughts/shared/plans/2026-08-20-realtime-tool-reliability/testing.md`. Record each trial with the fields listed there. Compare a completed run with `thoughts/shared/research/2026-08-20-realtime-reliability-baseline.md` and store the scored table in `thoughts/shared/research/2026-08-20-realtime-reliability-results.md`.

## Start a traced live session

1. Start the BFF from `server/` with no `OPENAI_REALTIME_TRACING` value, or with `OPENAI_REALTIME_TRACING=true`.
2. Start the demo at `http://localhost:5180/voice.html?mode=live`.
3. Connect a new Realtime session after the BFF start. Do not reuse a session created before a tracing-setting change.
4. Confirm the session appears in the [Traces dashboard](https://platform.openai.com/logs?api=traces). Tracing is chosen when the client secret is minted. You cannot turn it on later for the same session.

To disable tracing, restart the BFF with `OPENAI_REALTIME_TRACING=false`, then connect a new session. Confirm no new trace is created. Invalid values such as `TRUE` or `1` must fail BFF startup.

## Reset UI state between independent trials

Reset the hash route to `#/dashboard` and restore the demo model to its starting theme, library selection, details-panel, bookmark, and scroll positions. Independent trials need a fresh UI even when you keep the same Realtime connection. Fresh-session cases also need a new Realtime connection.

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

The simulated scripts on `voice.html` without `mode=live` exercise the interaction actor and ordered executor. Mark those rows as simulation. Do not count them toward the 19 of 20 live routing gate.
