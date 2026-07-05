/**
 * Tiny in-app client: connects to the WebSocket gateway as a subscriber and
 * prints everything pushed to it.
 *
 *   npm run ws:client              # connects as "alice"
 *   npm run ws:client -- bob
 */
import WebSocket from 'ws';

const subscriberId = process.argv[2] ?? 'alice';
const base = process.env.WS_URL ?? 'ws://localhost:3001';
const apiKey = process.env.API_KEY ?? 'dev-api-key-123';
const token = process.env.SUBSCRIBER_TOKEN;

// Prefer a subscriber token (browser-style auth) when provided.
const ws = new WebSocket(
  token
    ? `${base}/?token=${encodeURIComponent(token)}`
    : `${base}/?apiKey=${encodeURIComponent(apiKey)}&subscriberId=${encodeURIComponent(subscriberId)}`,
);

ws.on('open', () => console.log(`[ws-client] connected as "${subscriberId}"`));
ws.on('message', (data) => console.log(`[ws-client] ${data.toString()}`));
ws.on('close', (code, reason) =>
  console.log(`[ws-client] closed: ${code} ${reason.toString()}`),
);
ws.on('error', (err) => console.error('[ws-client] error:', err.message));
