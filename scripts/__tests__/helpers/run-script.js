import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(__dirname, 'mock-http-preload.cjs');
const SCRIPTS_DIR = path.join(__dirname, '..', '..');

// Runs a scripts/*.js file (one of the self-invoking network scripts) in a
// child process with a MockAgent preloaded as the global fetch dispatcher, so
// its real `fetch` calls hit `mockHttp` responses instead of the network.
export function runScript(scriptName, { args = [], env = {}, mockHttp = [], stdin = '' } = {}) {
  const result = spawnSync(
    process.execPath,
    ['-r', PRELOAD, path.join(SCRIPTS_DIR, scriptName), ...args],
    {
      encoding: 'utf8',
      // Always supply `input` (even empty) so a script reading stdin via
      // fs.readFileSync(0) sees immediate EOF instead of blocking.
      input: stdin,
      env: {
        ...process.env,
        ...env,
        MOCK_HTTP_SPEC: JSON.stringify(mockHttp),
      },
      timeout: 10_000,
    }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
