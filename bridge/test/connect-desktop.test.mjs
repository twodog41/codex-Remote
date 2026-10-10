import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectDesktop } from '../connect-desktop.mjs';

test('stale desktop addresses recover only the original chat and preserve configuration', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-reconnect-test-'));
  const file = join(temp, 'config.json');
  const serverFile = join(temp, 'server.mjs'); writeFileSync(serverFile, '');
  const threadId = '00000000-0000-7000-8000-000000000001';
  const original = { desktop: { threadId, pipePath: 'old', serverFile }, token: 'private-test-token', allowlistEnabled: true, other: 'keep' };
  writeFileSync(file, JSON.stringify(original));
  const config = { ...original, configFile: file };
  const closed = [];
  const create = options => ({
    start: async () => { if (options.pipePath === 'old') throw new Error('connect ENOENT'); },
    close: async () => closed.push(options.pipePath),
    snapshot: () => ({ threadId: options.pipePath === 'wrong' ? 'another-chat' : threadId })
  });
  try {
    const result = await connectDesktop(config, { create, discover: () => ['wrong', 'new'] });
    assert.equal(result.snapshot().threadId, threadId);
    assert.deepEqual(closed, ['old', 'wrong']);
    const saved = JSON.parse(readFileSync(file));
    assert.equal(saved.desktop.pipePath, 'new');
    assert.equal(saved.desktop.threadId, threadId);
    assert.equal(saved.token, original.token);
    assert.equal(saved.allowlistEnabled, true);
    assert.equal(saved.other, 'keep');
    writeFileSync(file, JSON.stringify(original));
    await assert.rejects(connectDesktop(config, { create, discover: () => [] }), /聊天目标未改变/);
    assert.deepEqual(JSON.parse(readFileSync(file)), original);
    await assert.rejects(connectDesktop(config, { create: options => ({ ...create(options), start: async () => { throw new Error('项目未批准'); } }),
      discover: () => { assert.fail('An authorization failure must not trigger discovery'); } }), /项目未批准/);
  } finally {
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'));
    assert.match(temp, /remote-codex-reconnect-test-/);
    rmSync(temp, { recursive: true, force: true });
  }
});
