import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppServer, Bridge } from '../server.mjs';

test('real HTTP + stdio: auth, live replies, approvals, safe access switches, reconnect, deduplication', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-test-'));
  const token = 'a'.repeat(64);
  const fake = fileURLToPath(new URL('fake-app-server.mjs', import.meta.url));
  const make = () => new Bridge({ rpc: new AppServer(process.execPath, [fake], temp), project: temp,
    token, stateFile: join(temp, 'state.json'), pollMs: 150 });
  let bridge = make();
  let base;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify({ sentAt: Date.now(), ...body }) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const until = async predicate => {
    for (let i = 0; i < 100; i++) {
      const state = (await request('/state')).data;
      if (predicate(state)) return state;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('State did not settle');
  };
  const message = text => request('/message', { id: randomUUID(), text });
  try {
    await bridge.start();
    assert.equal(JSON.parse(readFileSync(join(temp, 'state.json'), 'utf8')).threadId, null);
    base = 'http://127.0.0.1:' + await bridge.listen(0);
    assert.equal(bridge.server.address().address, '127.0.0.1');
    assert.equal((await request('/state', undefined, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request('/state', undefined, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/command', { command: 'anything' })).status, 404);
    assert.equal((await request('/message', { id: randomUUID(), text: ' ' })).status, 400);
    assert.equal((await request('/message', null)).status, 400);
    assert.equal((await request('/message', { id: randomUUID(), text: 'x'.repeat(20001) })).status, 400);
    assert.equal((await request('/message', { id: randomUUID(), text: 'x'.repeat(130 * 1024) })).status, 413);
    const initial = (await request('/state')).data;
    assert.equal((await request('/message', { id: randomUUID(), text: 'expired', sentAt: Date.now() - 120001 })).status, 409);
    assert.equal((await request('/message', { id: randomUUID(), text: 'wrong chat', expectedThreadId: 'wrong-thread' })).status, 409);
    assert.equal((await request('/state')).data.messages.length, initial.messages.length);
    const watch = request(`/state?after=${initial.revision}&epoch=${initial.epoch}`);
    const id = randomUUID();
    assert.equal((await request('/message', { id, text: 'hello' })).status, 200);
    assert.ok((await watch).data.revision > initial.revision);
    let state = await until(s => !s.busy);
    assert.equal(state.messages.filter(m => m.role === 'assistant').at(-1).text, '你好');
    const count = state.messages.length;
    assert.equal((await request('/message', { id, text: 'hello' })).status, 200);
    assert.equal((await request('/state')).data.messages.length, count);
    assert.equal((await request('/message', { id, text: 'different' })).status, 409);
    assert.equal((await request('/access', { mode: 'full' })).status, 400);
    assert.equal((await request('/access', { mode: 'wrong' })).status, 400);

    await message('approval');
    state = await until(s => s.approvals.length === 1);
    assert.equal(state.approvals[0].detail, 'echo safe-preview');
    assert.equal((await message('cannot run concurrently')).status, 409);
    const approval = state.approvals[0].id;
    assert.equal((await request('/approval', { id: approval, decision: 'auto' })).status, 400);
    assert.equal((await request('/approval', { id: approval, decision: 'deny' })).status, 200);
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /decline/);
    assert.equal((await request('/approval', { id: approval, decision: 'allow' })).status, 409);

    await message('file');
    state = await until(s => s.approvals.length === 1);
    assert.match(state.approvals[0].detail, /review me/);
    await request('/approval', { id: state.approvals[0].id, decision: 'allow' });
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /accept/);

    await message('permissions');
    state = await until(s => s.approvals.length === 1);
    await request('/approval', { id: state.approvals[0].id, decision: 'allow' });
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /"scope":"turn"/);
    assert.doesNotMatch(state.messages.at(-1).text, /fileSystem/);

    await message('permissions');
    state = await until(s => s.approvals.length === 1);
    await request('/approval', { id: state.approvals[0].id, decision: 'deny' });
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /"permissions":\{\}/);

    await message('question');
    state = await until(s => s.approvals.length === 1);
    assert.equal((await request('/approval', { id: state.approvals[0].id, answers: {} })).status, 400);
    await request('/approval', { id: state.approvals[0].id, answers: { choice: 'B' } });
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /"answers":\["B"\]/);

    await message('approval');
    state = await until(s => s.approvals.length === 1);
    const stale = state.approvals[0].id;
    assert.equal((await request('/access', { mode: 'full', confirm: 'ALLOW_FULL_PC_ACCESS' })).status, 200);
    state = await until(s => !s.busy);
    assert.equal(state.access, 'workspace', 'full access is withdrawn after the replacement turn completes');
    assert.equal(state.approvals.length, 0);
    assert.equal((await request('/approval', { id: stale, decision: 'allow' })).status, 409);
    await message('hold');
    await until(s => s.busy && s.turnId);
    assert.equal((await request('/access', { mode: 'workspace' })).status, 200);
    state = await until(s => !s.busy);
    assert.equal(state.access, 'workspace');

    await message('retry');
    state = await until(s => s.status.includes('Reconnecting'));
    assert.equal(state.error, null);
    state = await until(s => !s.busy);
    assert.equal(state.status, '已完成');

    await message('hold');
    await until(s => s.busy && s.turnId);
    assert.equal((await request('/interrupt', {})).status, 200);
    await until(s => !s.busy);
    await message('unknown');
    state = await until(s => !s.busy);
    assert.equal(state.approvals.length, 0);
    assert.equal(state.status, '执行失败');

    await request('/access', { mode: 'full', confirm: 'ALLOW_FULL_PC_ACCESS' });
    const oldEpoch = (await request('/state')).data.epoch;
    await bridge.close();
    bridge = make();
    await bridge.start();
    base = 'http://127.0.0.1:' + await bridge.listen(0);
    state = (await request('/state?after=99999&epoch=' + oldEpoch)).data;
    assert.notEqual(state.epoch, oldEpoch);
    assert.equal(state.access, 'workspace');
    assert.equal(state.threadId, 'test-thread');
    const afterRestartCount = state.messages.length;
    await request('/message', { id, text: 'hello' });
    assert.equal((await request('/state')).data.messages.length, afterRestartCount);
    await message('crash');
    state = await until(s => !s.online);
    assert.equal(state.access, 'workspace');
    assert.equal((await message('offline')).status, 503);
  } finally {
    await bridge.close();
    const target = resolve(temp);
    assert.ok(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'));
    assert.ok(target.includes('remote-codex-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});
