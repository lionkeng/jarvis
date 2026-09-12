import { createServer } from '../../server/src/index.ts';
globalThis.fetch = async () => Response.json({ session: { id: 'live_fixture' }, transport: { type: 'webrtc', sdp: 'answer' } });
const server = createServer({
  apiKey: 'test-only', model: 'gpt-live-1', backendModel: 'gpt-5.6-luna', port: 0,
  allowedOrigins: ['http://localhost:5180'], maxOutputTokens: 128, lifetimeStreamsPerOrigin: 4,
  rateLimitRequests: 20, rateLimitWindowMs: 1000,
  sessionBudgetRequests: 20, sessionBudgetWindowMs: 1000,
});
console.log(server.url.href);
