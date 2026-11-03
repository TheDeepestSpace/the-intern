import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { bundle, libAsEsm } from '../bundle-agentic.js';

describe('bundle-agentic', () => {
  it('writes an ES module with the normalized spec and a working router, and refuses an invalid file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-agentic-'));
    const out = path.join(dir, 'agentic.generated.mjs');
    const { agents } = bundle({ out });
    expect(agents).toContain('default');
    const mod = await import(out);
    expect(mod.SPEC.agents.default).toBeTruthy();
    expect(mod.loadSpecObject(mod.SPEC).errors).toEqual([]);
    const r = mod.explain(mod.SPEC, { kind: 'telegram', chat_id: 1, message_id: 1, body: 'hi' });
    expect(r.agent).toBe('telegram');
    const bad = path.join(dir, 'bad.yaml');
    fs.writeFileSync(bad, 'version: 2\nagents: {}\n');
    expect(() => bundle({ file: bad, out: path.join(dir, 'never.mjs') })).toThrow(/invalid/);
    expect(fs.existsSync(path.join(dir, 'never.mjs'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a lib that grew a dependency or lost its exports block', () => {
    expect(() => libAsEsm("const y = require('yaml');\nmodule.exports = { y };\n")).toThrow(/dependency-free/);
    expect(() => libAsEsm('const a = 1;\n')).toThrow(/module.exports/);
    expect(libAsEsm('const a = 1;\nmodule.exports = { a };\n')).toBe('const a = 1;\nexport { a };\n');
  });
});
