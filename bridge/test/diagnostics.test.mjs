import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDiagnostics } from '../diagnostics.mjs';

test('diagnostic logs keep bounded event metadata without prompts, credentials or raw errors', () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-diagnostics-test-'));
  try {
    const file = join(temp, 'diagnostics.log');
    const log = createDiagnostics(file);
    log('receiver.failed', { mode: 'independent', code: 'ECONNRESET', token: 'private-token', text: 'private prompt', error: 'private message' });
    log('command.failed', { mode: 'desktop', code: 'private-password!' });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].code, 'ECONNRESET');
    assert.ok(!('code' in lines[1]));
    assert.doesNotMatch(readFileSync(file, 'utf8'), /private/);
    writeFileSync(file, 'x'.repeat(256 * 1024));
    log('receiver.recovered');
    assert.ok(existsSync(file + '.previous'));
    assert.ok(readFileSync(file, 'utf8').length < 1000);
    assert.doesNotThrow(() => createDiagnostics(join(temp, 'missing', 'log'))('receiver.started'));
  } finally {
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'));
    assert.match(temp, /remote-codex-diagnostics-test-/);
    rmSync(temp, { recursive: true, force: true });
  }
});
