# @jarvis-viz/react

React lifecycle adapter and accessible transcript view for `@jarvis-viz/core`.

```tsx
<VoiceVizCanvas
  autoConnect
  tokenEndpoint="/session"
  options={{ presets: ["ring", "hud"], theme: "cyan" }}
  style={{ height: 480 }}
/>
```

`TranscriptView` accepts the mounted `VoiceViz` instance's `transcript` store and provides a
virtualized, searchable, selectable, keyboard-scrollable conversation view with a polite live
region for the latest turn.
