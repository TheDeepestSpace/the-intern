// Loaded via `node -r` before a target script that self-invokes on require
// (send-telegram.js, react-telegram.js, download-telegram-photo.js). Sets up
// an undici MockAgent as the global dispatcher so the script's real `fetch`
// calls hit mocked responses instead of the network, per MOCK_HTTP_SPEC (a
// JSON array of { origin, method, path, statusCode, body } passed via env).
//
// This only works because Node's global `fetch` reads its dispatcher from a
// well-known Symbol.for() key that the npm `undici` package writes to when
// its major version matches the version Node bundled internally (Dockerfile
// pins Node 24.15.0, which bundles undici 7.x) — a different major version
// here would silently fall through to the real network instead of the mock.
const { MockAgent, setGlobalDispatcher } = require('undici');

const specs = JSON.parse(process.env.MOCK_HTTP_SPEC || '[]');
const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const captureRequestBody = process.env.CAPTURE_REQUEST_BODY === '1';

const clients = new Map();
for (const spec of specs) {
  if (!clients.has(spec.origin)) clients.set(spec.origin, agent.get(spec.origin));
  const client = clients.get(spec.origin);
  client
    .intercept({ path: spec.path, method: spec.method || 'GET' })
    .reply(opts => {
      if (captureRequestBody) {
        console.log(`CAPTURED_REQUEST_BODY:${opts.body || ''}`);
      }
      return { statusCode: spec.statusCode ?? 200, data: spec.body };
    })
    .persist();
}
