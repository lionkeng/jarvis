import { createServer } from '../../server/src/index.ts';
globalThis.fetch = async () => Response.json({ session: { id: 'live_fixture' }, transport: { type: 'webrtc', sdp: 'answer' } });
const server = createServer({
  providers: [{ protocol: 'openai-live', apiKey: 'test-only', model: 'gpt-live-1', backendModel: 'gpt-5.6-luna', maxOutputTokens: 128 }],
  port: 0, allowedOrigins: ['http://localhost:5180'], lifetimeStreamsPerOrigin: 4,
  rateLimitRequests: 20, rateLimitWindowMs: 1000,
  sessionBudgetRequests: 20, sessionBudgetWindowMs: 1000,
});
console.log(server.url.href);
