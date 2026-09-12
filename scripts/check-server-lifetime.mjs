import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OpenAILiveTransport } from '../packages/core/dist/transport/openai.js';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => nativeFetch(url, { ...init, headers: { ...init?.headers, Origin: 'http://localhost:5180' } });
let failed = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
  const child = spawn('bun', [fileURLToPath(new URL('./fixtures/lifetime-server.ts', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let transport;
  try {
    const [base] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) });
    let stopped = false;
    let peerClosed = false;
    const sent = [];
    const channel = new EventTarget();
    channel.readyState = 'open';
    channel.close = () => { channel.readyState = 'closed'; };
    channel.send = (json) => {
      const event = JSON.parse(json);
      sent.push(event.type);
      if (event.type === 'session.close') queueMicrotask(() => channel.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'session.closed', usage: { seconds: 1 } }),
      })));
    };
    class Peer extends EventTarget {
      iceGatheringState = 'complete';
      localDescription = { sdp: 'offer' };
      addTrack() {}
      createDataChannel() { return channel; }
      async createOffer() { return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription() {}
      async setRemoteDescription() { channel.dispatchEvent(new MessageEvent('message', { data: '{"type":"session.started"}' })); }
      close() { peerClosed = true; }
    }
    globalThis.RTCPeerConnection = Peer;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped = true; } }] }) },
    } });
    transport = new OpenAILiveTransport();
    await transport.connect(new URL('session', base).href);
    if (signal === 'SIGINT') {
      await delay(17_000);
      if (!transport.connected) throw new Error('Lifetime stream failed while the server was still running');
    }
    child.kill(signal);
    await once(child, 'exit', { signal: AbortSignal.timeout(5_000) });
    const deadline = Date.now() + 2000;
    while (transport.connected && Date.now() < deadline) await delay(20);
    const result = { signal, connected: transport.connected, microphoneStopped: stopped, peerClosed, closeSent: sent.includes('session.close') };
    const passed = !result.connected && stopped && peerClosed && result.closeSent;
    console.log(`${passed ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}`);
    if (!passed) failed = true;
  } finally {
    await transport?.disconnect();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    lines.close();
  }
}
process.exitCode = failed ? 1 : 0;
