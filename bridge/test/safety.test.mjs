import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServer, Bridge } from '../server.mjs';
import { WeixinRemote } from '../weixin.mjs';
import { redact } from '../safety.mjs';
import { savePrivateJSON, readPrivateJSON, unprotect } from '../vault.mjs';
import { cleanImages } from '../images.mjs';
import { projectAllowed } from '../safety.mjs';
import { assertEnabled } from '../safety.mjs';

test('persistent PC stop flag blocks new inbound work, collection and delivery before side effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  try {
    const flag = join(root, 'remote-disabled');
    let sends = 0;
    const remote = new WeixinRemote({ bridge: { snapshot: () => ({ threadId: 'thread', messages: [] }) },
      api: { send: async () => sends++ }, disabledFile: flag, credentials: { owner: 'owner', botID: 'bot', token: 'test' } });
    writeFileSync(flag, 'disabled');
    assert.throws(() => assertEnabled(flag), /停用/);
    await assert.rejects(remote.receive({}), /停用/);
    assert.throws(() => remote.collect(), /停用/);
    await assert.rejects(remote.drain(), /停用/);
    assert.equal(sends, 0);
  } finally { clean(root); }
});

test('target is rechecked after a valid image download; no command is sent to the replacement project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  let threadId = 'first', actions = 0;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
  try {
    const now = Date.now();
    const remote = new WeixinRemote({ bridge: { snapshot: () => ({ threadId, project: root, messages: [], activity: [], approvals: [] }), action: async () => actions++ }, api: {},
      now: () => now, credentials: { owner: 'owner', botID: 'bot', token: 'test' }, imageDirectory: root,
      imageFetcher: async () => { threadId = 'replacement'; return new Response(png); } });
    await remote.receive({ message_id: 'image-race', create_time_ms: now, from_user_id: 'owner', to_user_id: 'bot',
      message_type: 1, context_token: 'context', item_list: [{ type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/image' } } }] });
    assert.equal(actions, 0);
    assert.ok(remote.state.outbox.some(item => item.text.includes('会话已改变')));
  } finally { clean(root); }
});

test('Windows DPAPI secrets round-trip, legacy plaintext migrates, corrupted vault fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  try {
    const file = join(root, 'weixin.json');
    writeFileSync(file, JSON.stringify({ token: 'private-test-token', context: 'private-test-context', owner: 'owner' }));
    assert.equal(readPrivateJSON(file).token, 'private-test-token');
    assert.ok(!readFileSync(file, 'utf8').includes('private-test-token'));
    assert.ok(!readFileSync(file, 'utf8').includes('private-test-context'));
    assert.equal(readPrivateJSON(file).context, 'private-test-context');
    savePrivateJSON(file, { token: 'replacement-test-token' });
    assert.equal(readPrivateJSON(file).token, 'replacement-test-token');
    assert.throws(() => unprotect('dpapi-current-user:' + Buffer.from('invalid').toString('base64')), /凭据保护失败/);
  } finally { clean(root); }
});

test('image retention removes only expired generated images, and project allowlist fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  try {
    const image = join(root, '00000000-0000-4000-8000-000000000001.jpg');
    const unrelated = join(root, 'keep-me.txt');
    writeFileSync(image, 'old image'); writeFileSync(unrelated, 'unrelated');
    const old = new Date(Date.now() - 8 * 86400000);
    utimesSync(image, old, old);
    cleanImages(root);
    assert.equal(existsSync(image), false);
    assert.equal(existsSync(unrelated), true);
    writeFileSync(image, 'recent image');
    cleanImages(root, Date.now(), 200 * 1024 * 1024);
    assert.equal(existsSync(image), false);
    const allowed = join(root, 'allowed'), denied = join(root, 'denied');
    mkdirSync(allowed); mkdirSync(denied);
    assert.equal(projectAllowed(allowed, [allowed]), true);
    assert.equal(projectAllowed(denied, [allowed]), false);
    assert.equal(projectAllowed(join(root, 'missing'), [allowed]), false);
  } finally { clean(root); }
});

test('approved physical roots do not follow a replaced junction to another project', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  try {
    const allowed = join(root, 'approved'), denied = join(root, 'denied'), alias = join(root, 'alias');
    mkdirSync(allowed); mkdirSync(denied);
    symlinkSync(allowed, alias, 'junction');
    assert.equal(projectAllowed(alias, [allowed]), true);
    renameSync(allowed, join(root, 'old-approved'));
    symlinkSync(denied, allowed, 'junction');
    assert.equal(projectAllowed(allowed, [allowed]), false);
  } finally { clean(root); }
});

function clean(root) {
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + '\\') || absolute.startsWith(resolve(tmpdir()) + '/'));
  assert.match(absolute, /remote-codex-safety-test-/);
  rmSync(absolute, { recursive: true, force: true });
}

test('credential patterns are filtered before chunks and desktop-originated answers stay off WeChat', () => {
  const text = 'api_key=secret123 password: hunter2 Bearer abcdefghijklmnop sk-' + 'a'.repeat(40);
  assert.ok(!redact(text).includes('secret123'));
  assert.ok(!redact(text).includes('hunter2'));
  assert.ok(!redact(text).includes('abcdefghijklmnop'));
  let snapshot = { threadId: 'thread', project: 'C:\\project', status: '就绪', messages: [], activity: [], approvals: [], recentTurns: [] };
  const remote = new WeixinRemote({ bridge: { desktop: true, snapshot: () => snapshot }, api: {},
    credentials: { owner: 'owner', botID: 'bot', token: 'test' } });
  remote.state.context = 'context';
  snapshot = { ...snapshot, recentTurns: [{ id: 'pc-turn', status: 'completed' }], messages: [
    { id: 'pc-user', turnId: 'pc-turn', role: 'user', text: 'local PC task' },
    { id: 'pc-answer', turnId: 'pc-turn', role: 'assistant', text: 'private PC answer' }] };
  remote.collect();
  assert.equal(remote.state.outbox.length, 0);
});

test('active freshness-window receipts prevent replay even after the 512-ID history rolls over', async () => {
  const now = Date.now();
  const remote = new WeixinRemote({ bridge: { snapshot: () => ({ threadId: 'thread', messages: [], activity: [], approvals: [] }) },
    api: {}, now: () => now, credentials: { owner: 'owner', botID: 'bot', token: 'test' } });
  const message = id => ({ message_id: String(id), create_time_ms: now, from_user_id: 'owner', to_user_id: 'bot',
    message_type: 1, context_token: 'context', item_list: [{ type: 1, text_item: { text: '帮助' } }] });
  for (let id = 0; id < 514; id++) await remote.receive(message(id));
  assert.ok(!remote.state.seen.includes('0'));
  assert.equal(await remote.receive(message(0)), false);
});

test('obsolete, missing and future timestamps never dispatch; project changes during image download fail closed', async () => {
  let now = 1000000, threadId = 'first', downloads = 0;
  const actions = [];
  const bridge = { snapshot: () => ({ threadId, project: 'C:\\first', messages: [], activity: [], approvals: [] }),
    action: async (path, body) => actions.push({ path, body }) };
  const remote = new WeixinRemote({ bridge, api: {}, credentials: { owner: 'owner', botID: 'bot', token: 'test' },
    now: () => now, imageDirectory: 'unused', imageFetcher: async () => { downloads++; throw Error('should not download'); } });
  const message = (id, time = now) => ({ message_id: id, create_time_ms: time, from_user_id: 'owner', to_user_id: 'bot',
    message_type: 1, context_token: 'context', item_list: [{ type: 1, text_item: { text: 'run a task' } }] });
  for (const time of [undefined, 0, 999999, now + 30001]) {
    const msg = message(String(time)); msg.create_time_ms = time;
    await remote.receive(msg);
  }
  assert.equal(actions.length, 0);
  now += 120001;
  await remote.receive(message('expired', 1000000));
  assert.equal(actions.length, 0);
  await remote.receive(message('fresh'));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].body.expectedThreadId, 'first');
  assert.equal(downloads, 0);
});

test('full-access lease expires while a turn runs and also resets after one completed turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  const bridge = new Bridge({ project: root, token: 'b'.repeat(64), fullAccessMs: 70,
    rpc: new AppServer(process.execPath, [fileURLToPath(new URL('fake-app-server.mjs', import.meta.url))], root) });
  try {
    await bridge.start();
    await bridge.action('/access', { mode: 'full', confirm: 'ALLOW_FULL_PC_ACCESS' });
    await bridge.action('/message', { id: 'test-expiring-full-access', text: 'hold' });
    assert.equal(bridge.snapshot().access, 'full');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(bridge.snapshot().access, 'workspace');
    assert.equal(bridge.snapshot().busy, false);
    await bridge.action('/access', { mode: 'full', confirm: 'ALLOW_FULL_PC_ACCESS' });
    await bridge.action('/message', { id: 'test-one-full-round', text: 'hello' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(bridge.snapshot().access, 'workspace');
  } finally {
    await bridge.close();
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + '\\') || absolute.startsWith(resolve(tmpdir()) + '/'));
    assert.match(absolute, /remote-codex-safety-test-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});

test('closing the owned Windows RPC service terminates its actual descendant process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-safety-test-'));
  const fixture = join(root, 'owned-parent.mjs');
  writeFileSync(fixture, `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ id: request.id, result: { pid: child.pid } }) + '\\n');
});`);
  const rpc = new AppServer(process.execPath, [fixture], root);
  let childPID;
  try {
    childPID = (await rpc.request('test-owned-descendant')).pid;
    assert.ok(Number.isSafeInteger(childPID) && childPID !== process.pid && childPID !== rpc.child.pid);
    process.kill(childPID, 0);
    await rpc.close();
    let exists = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(childPID, 0); } catch { exists = false; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(exists, false, 'owned descendant must stop, not just its RPC parent');
  } finally {
    await rpc.close();
    if (childPID) { try { process.kill(childPID); } catch {} }
    clean(root);
  }
});
