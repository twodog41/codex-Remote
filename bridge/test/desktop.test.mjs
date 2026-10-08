import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppServer } from '../server.mjs';
import { DesktopBridge } from '../desktop.mjs';
import { WeixinRemote } from '../weixin.mjs';

test('external referenced files do not change the chat working directory; a failed switch retains its target', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-desktop-test-'));
  const other = join(temp, 'other-project'); mkdirSync(other);
  const first = '00000000-0000-7000-8000-000000000001';
  const second = '00000000-0000-7000-8000-000000000002';
  const wrap = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const threads = [{ id: first, cwd: temp, title: 'A', kind: 'codex', hostId: 'local' }];
  const calls = [];
  const rpc = { write() {}, close: async () => {}, request: async (method, params) => {
    if (method === 'initialize') return {};
    const { name, arguments: args } = params;
    if (name === 'list_threads') return wrap({ threads });
    if (name === 'send_message_to_thread') { calls.push(args.threadId); return wrap({ threadId: args.threadId }); }
    if (args.threadId === second) throw new Error('desktop connection temporarily unavailable');
    return wrap({ thread: { ...threads[0], status: { type: 'idle' } }, turns: [{ id: 'old', status: 'completed',
      items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Manage ' + join(other, 'file.txt') },
        { type: 'localImage', path: join(other, 'image.png') }] }] }] });
  } };
  const bridge = new DesktopBridge({ threadId: first, rpc, pollMs: 0, allowedProjects: [temp, other] });
  try {
    await bridge.start();
    assert.equal(bridge.snapshot().project, temp);
    assert.equal((await bridge.listThreads()).length, 1);
    await assert.rejects(bridge.switchThread(second), /temporarily unavailable/);
    assert.equal(bridge.snapshot().threadId, first);
    assert.equal(bridge.snapshot().online, true);
    assert.equal(bridge.switching, false);
    await bridge.action('/message', { text: 'continue' });
    assert.deepEqual(calls, [first]);
  } finally {
    await bridge.close();
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'));
    assert.match(temp, /remote-codex-desktop-test-/);
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an unapproved startup target keeps WeChat switching available without relaying or executing tasks', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-desktop-test-'));
  const first = '00000000-0000-7000-8000-000000000001';
  const blocked = '00000000-0000-7000-8000-000000000002';
  mkdirSync(join(temp, 'other-project'));
  const configFile = join(temp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ desktop: { threadId: blocked } }));
  const fake = fileURLToPath(new URL('fake-desktop-tools.mjs', import.meta.url));
  const bridge = new DesktopBridge({ threadId: blocked, project: temp, allowedProjects: [temp], pollMs: 0, configFile,
    rpc: new AppServer(process.execPath, [fake], temp) });
  const now = Date.now();
  let index = 0;
  const input = text => ({ create_time_ms: now, message_id: String(++index), from_user_id: 'owner', to_user_id: 'bot',
    message_type: 1, context_token: 'context', item_list: [{ type: 1, text_item: { text } }] });
  try {
    await bridge.start();
    assert.equal(bridge.snapshot().blocked, true);
    assert.deepEqual(bridge.snapshot().messages, []);
    await assert.rejects(bridge.action('/message', { text: 'must not execute' }), /未获电脑端批准/);
    const remote = new WeixinRemote({ bridge, api: { send: async () => {} },
      credentials: { owner: 'owner', botID: 'bot', token: 'test' }, now: () => now });
    await remote.receive(input('切换项目'));
    assert.ok(remote.threadMenu.items.length);
    assert.ok(!remote.threadMenu.items.some(t => t.id === blocked));
    const choice = remote.threadMenu.items.findIndex(t => t.id === first) + 1;
    await remote.receive(input(String(choice)));
    assert.equal(bridge.snapshot().online, true);
    assert.equal(bridge.snapshot().blocked, false);
    assert.equal(JSON.parse(readFileSync(configFile)).desktop.threadId, first);
    await assert.rejects(bridge.switchThread(blocked), /未获电脑端批准/);
    assert.equal(bridge.snapshot().threadId, first);
    bridge.allowedProjects = [];
    await bridge.refresh();
    assert.equal(bridge.snapshot().blocked, true);
    assert.deepEqual(bridge.snapshot().messages, []);
    assert.deepEqual(await bridge.listThreads(), []);
    await assert.rejects(bridge.action('/interrupt', {}), /未获电脑端批准/);
    bridge.allowedProjects = [temp];
    const stranger = input('关闭白名单'); stranger.from_user_id = 'stranger';
    assert.equal(await remote.receive(stranger), false);
    assert.equal(bridge.allowlistEnabled, true);
    await remote.receive(input('关闭白名单'));
    assert.equal(bridge.allowlistEnabled, false);
    assert.equal(JSON.parse(readFileSync(configFile)).allowlistEnabled, false);
    assert.ok((await bridge.listThreads()).some(t => t.id === blocked));
    await bridge.switchThread(blocked);
    await remote.receive(input('开启白名单'));
    assert.equal(bridge.allowlistEnabled, true);
    assert.equal(JSON.parse(readFileSync(configFile)).allowlistEnabled, true);
    assert.equal(bridge.snapshot().blocked, true);
    assert.equal(remote.threadMenu, null);
    await assert.rejects(bridge.action('/message', { text: 'must still not execute' }), /未获电脑端批准/);
    await remote.receive(input('关闭白名单'));
    assert.equal(bridge.snapshot().online, true);
    assert.equal(bridge.snapshot().blocked, false);
  } finally {
    await bridge.close();
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'));
    assert.match(temp, /remote-codex-desktop-test-/);
    rmSync(temp, { recursive: true, force: true });
  }
});

test('WeChat routes to the existing desktop thread, skips old history, retains dedup and leaves permissions on PC', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-desktop-test-'));
  const threadId = '00000000-0000-7000-8000-000000000001';
  const secondId = '00000000-0000-7000-8000-000000000002';
  const configFile = join(temp, 'config.json');
  const otherProject = join(temp, 'other-project');
  mkdirSync(otherProject);
  writeFileSync(configFile, JSON.stringify({ desktop: { threadId }, otherSetting: 'keep' }));
  const fake = fileURLToPath(new URL('fake-desktop-tools.mjs', import.meta.url));
  const bridge = new DesktopBridge({ threadId, project: temp, allowedProjects: [temp, otherProject], pollMs: 0, configFile,
    rpc: new AppServer(process.execPath, [fake], temp) });
  const deliveries = [];
  const api = { send: async (owner, context, text) => { assert.equal(owner, 'owner'); deliveries.push(text); } };
  let index = 0;
  let now = Date.now();
  const input = text => ({ create_time_ms: now, message_id: String(++index), from_user_id: 'owner', to_user_id: 'bot', message_type: 1,
    context_token: 'context', item_list: [{ type: 1, text_item: { text } }] });
  try {
    await bridge.start();
    const options = { bridge, api, credentials: { owner: 'owner', botID: 'bot', token: 'test-secret' },
      stateFile: join(temp, 'weixin-state.json'), now: () => now };
    writeFileSync(options.stateFile, JSON.stringify({ owner: 'owner', botID: 'bot', context: 'context', seen: [],
      sent: {}, notified: [], outbox: [{ id: 'legacy', text: 'obsolete mixed history' }], routingThreadId: threadId }));
    let remote = new WeixinRemote(options);
    assert.equal(remote.state.outbox.length, 0, 'old mixed queue is discarded on delivery migration');
    remote.collect();
    await remote.drain();
    assert.ok(!deliveries.some(text => text.includes('older desktop reply')));
    assert.ok(!deliveries.some(text => text.includes('obsolete mixed history')));
    const instruction = input('continue this conversation');
    await remote.receive(instruction);
    await bridge.refresh();
    remote.collect();
    await remote.drain();
    assert.equal(bridge.snapshot().threadId, threadId);
    assert.match(bridge.snapshot().messages.find(m => m.role === 'user').text, /^\[微信\]\n\[遥控任务 wx-[a-f0-9]+\]\ncontinue this conversation$/);
    assert.ok(deliveries.some(text => text.includes('desktop reply to [微信]')));
    assert.ok(!deliveries.some(text => text.includes('internal working progress')));
    assert.equal(deliveries.filter(t => t.includes('✅ 本轮回答已结束')).length, 1);
    remote.collect(); await remote.drain();
    assert.equal(deliveries.filter(t => t.includes('✅ 本轮回答已结束')).length, 1, 'finish marker is sent once per turn');
    assert.equal((await bridge.listThreads()).length, 2, 'dedup local projects and omit smoke/remote/ChatGPT');
    assert.equal((await bridge.listThreads(false)).length, 3, 'show older chats on request');
    const stranger = input('切换项目'); stranger.from_user_id = 'stranger';
    assert.equal(await remote.receive(stranger), false);
    assert.ok(!remote.threadMenu);
    await remote.receive(input('切换项目'));
    await remote.receive(input('999'));
    assert.equal(bridge.snapshot().threadId, threadId);
    now += 300001;
    await remote.receive(input('切换 1'));
    assert.equal(bridge.snapshot().threadId, threadId, 'expired menus cannot switch');
    await remote.receive(input('切换项目'));
    const choice = remote.threadMenu.items.findIndex(t => t.id === secondId) + 1;
    const selection = input(String(choice));
    await remote.receive(selection);
    assert.equal(bridge.snapshot().threadId, secondId);
    assert.equal(JSON.parse(readFileSync(configFile)).desktop.threadId, secondId);
    assert.equal(JSON.parse(readFileSync(configFile)).otherSetting, 'keep');
    assert.equal(await remote.receive(selection), false);
    const before = deliveries.length;
    await remote.drain();
    assert.ok(!deliveries.slice(before).some(text => text.includes('older desktop reply')));
    await remote.receive(input('work in the selected project'));
    await bridge.refresh(); remote.collect(); await remote.drain();
    assert.match(bridge.snapshot().messages.find(m => m.role === 'user').text, /\nwork in the selected project$/);
    assert.ok(deliveries.some(text => text.includes('Codex [other-project]')));
    assert.equal(deliveries.filter(t => t.includes('✅ 本轮回答已结束')).length, 2, 'new project turn has its own finish marker');
    const persisted = JSON.parse(readFileSync(join(temp, 'weixin-state.json')));
    assert.equal(persisted.routingThreadId, secondId);
    remote = new WeixinRemote(options);
    assert.equal(await remote.receive(instruction), false);
    await remote.receive(input('完全访问'));
    assert.equal(remote.challenge, null);
    assert.equal(bridge.snapshot().access, 'desktop');
    await assert.rejects(bridge.action('/approval', {}), /电脑 Codex/);
    await remote.receive(input('停止'));
    assert.ok(remote.state.outbox.some(m => m.text.includes('尚未确认停止')));
  } finally {
    await bridge.close();
    const absolute = resolve(temp);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + '\\') || absolute.startsWith(resolve(tmpdir()) + '/'));
    assert.match(absolute, /remote-codex-desktop-test-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});

test('desktop backlog retains the newest completed answer and expires old notifications', async () => {
  let now = 1000000;
  let snapshot = { threadId: 'thread', project: 'C:\\project', status: '就绪', messages: [], activity: [], approvals: [],
    recentTurns: [{ id: 'old', status: 'completed' }] };
  const deliveries = [];
  const remote = new WeixinRemote({ bridge: { desktop: true, snapshot: () => snapshot },
    api: { send: async (owner, context, text) => deliveries.push(text) },
    credentials: { owner: 'owner', botID: 'bot', token: 'test' }, now: () => now });
  remote.state.context = 'test';
  remote.state.phoneTasks = [{ id: 'request1', threadId: 'thread' }, { id: 'request2', threadId: 'thread' }];
  snapshot = { ...snapshot, messages: [{ id: 'u1', turnId: 'first', role: 'user', text: '[微信]\n[遥控任务 request1]\ntask' },
    { id: 'one', turnId: 'first', role: 'assistant', text: 'obsolete answer' }],
    recentTurns: [{ id: 'first', status: 'completed' }] };
  remote.collect();
  snapshot = { ...snapshot, messages: [{ id: 'u2', turnId: 'second', role: 'user', text: '[微信]\n[遥控任务 request2]\ntask' },
    { id: 'two', turnId: 'second', role: 'assistant', text: 'latest answer' }],
    recentTurns: [{ id: 'second', status: 'completed' }, { id: 'first', status: 'completed' }] };
  remote.collect(); remote.collect();
  assert.equal(remote.state.outbox.length, 1);
  assert.match(remote.state.outbox[0].text, /latest answer.*\n\n✅ 本轮回答已结束/s);
  await remote.drain();
  assert.equal(deliveries.length, 1);
  remote.enqueue('expired notification');
  now += 600001;
  await remote.drain();
  assert.equal(deliveries.length, 1);
});

test('completion waits for its answer, and a persisted phone task catches up after restart once', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-desktop-test-'));
  const stateFile = join(temp, 'state.json');
  const snapshot = { threadId: 'thread', project: temp, status: '就绪', messages: [], activity: [], approvals: [],
    recentTurns: [{ id: 'phone', status: 'completed' }] };
  const task = { id: 'request', threadId: 'thread' };
  writeFileSync(stateFile, JSON.stringify({ owner: 'owner', botID: 'bot', context: '', phoneTasks: [task], finishedTurns: [],
    seen: [], outbox: [], sent: {}, notified: [], deliveryVersion: 2, privacyVersion: 1 }));
  snapshot.messages.push({ id: 'u', turnId: 'phone', role: 'user', text: '[微信]\n[遥控任务 request]\nreport' });
  const deliveries = [];
  const options = { bridge: { desktop: true, snapshot: () => snapshot },
    api: { send: async (owner, context, text) => deliveries.push(text) }, stateFile,
    credentials: { owner: 'owner', botID: 'bot', token: 'test' } };
  try {
    let remote = new WeixinRemote(options);
    remote.state.context = 'test';
    remote.collect();
    assert.ok(!remote.state.finishedTurns.includes('thread:phone'));
    assert.equal(remote.state.outbox.length, 0);
    snapshot.messages.push({ id: 'a', turnId: 'phone', role: 'assistant', text: 'the delayed answer' });
    remote = new WeixinRemote(options);
    remote.state.context = 'test';
    remote.collect(); await remote.drain();
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0], /the delayed answer/);
    remote = new WeixinRemote(options);
    remote.collect(); await remote.drain();
    assert.equal(deliveries.length, 1);
  } finally {
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/'));
    assert.match(temp, /remote-codex-desktop-test-/);
    rmSync(temp, { recursive: true, force: true });
  }
});

test('late old-thread polls and failures cannot overwrite a switched route, including switching back', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'remote-codex-desktop-test-'));
  const firstProject = join(temp, 'first'), secondProject = join(temp, 'second');
  mkdirSync(firstProject); mkdirSync(secondProject);
  const first = '00000000-0000-7000-8000-000000000001';
  const second = '00000000-0000-7000-8000-000000000002';
  const response = (id, project = id === first ? firstProject : secondProject) => ({ content: [{ type: 'text',
    text: JSON.stringify({ thread: { id, kind: 'codex', hostId: 'local', cwd: project, title: id, status: { type: 'idle' } }, turns: [] }) }] });
  let nextRead;
  const rpc = { write() {}, close: async () => {}, request: async (method, params) => {
    if (method === 'initialize') return {};
    if (nextRead) { const read = nextRead; nextRead = null; return read; }
    return response(params.arguments.threadId);
  } };
  const bridge = new DesktopBridge({ threadId: first, rpc, pollMs: 0, allowedProjects: [firstProject, secondProject] });
  await bridge.start();
  let release;
  nextRead = new Promise(resolve => { release = resolve; });
  const oldPoll = bridge.refresh();
  await bridge.switchThread(second);
  await bridge.switchThread(first);
  release(response(first, 'C:\\stale'));
  await oldPoll;
  assert.equal(bridge.snapshot().project, firstProject);
  let reject;
  nextRead = new Promise((resolve, fail) => { reject = fail; });
  const failedPoll = bridge.refresh();
  await bridge.switchThread(second);
  reject(new Error('old thread failed'));
  await failedPoll;
  assert.equal(bridge.snapshot().threadId, second);
  assert.equal(bridge.snapshot().online, true);
  await bridge.close();
  const absolute = resolve(temp);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + '\\') || absolute.startsWith(resolve(tmpdir()) + '/'));
  assert.match(absolute, /remote-codex-desktop-test-/);
  rmSync(absolute, { recursive: true, force: true });
});
