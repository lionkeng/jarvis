# @jarvis-viz/wc

Shadow-DOM web component adapter for `@jarvis-viz/core`.

```ts
import { defineVoiceVizElement } from "@jarvis-viz/wc";
defineVoiceVizElement();
```

```html
<jarvis-voice-viz
  style="display:block;height:480px"
  presets="ring,particles,hud"
  theme="cyan"
  token-endpoint="/session"
  auto-connect
></jarvis-voice-viz>
```

The element owns its `VoiceViz` lifecycle and isolates local layout defaults in Shadow DOM.
