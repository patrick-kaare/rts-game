// Node 20 has no global WebSocket (Node 22 does); NetTransport uses the
// browser one. Fill it in from `ws` so the network tests run on either.
import { WebSocket } from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}
