import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppServer, Bridge } from '../server.mjs';
import { WeixinAPI, WeixinRemote, parseApiJSON, trustedBase, chunks, qrSVG, login } from '../weixin.mjs';
import { readPrivateJSON } from '../vault.mjs';

const json = value => new Response(JSON.stringify(value), { status: 200 });
const tempDir = () => mkdtempSync(join(tmpdir(), 'remote-codex-weixin-test-'));
function clean(temp) {
  const path = resolve(temp);
  assert.ok(path.startsWith(resolve(tmpdir()) + '\\') || path.startsWith(resolve(tmpdir()) + '/'));
  assert.ok(path.includes('remote-codex-weixin-test-'));
  rmSync(path, { recursive: true, force: true });
}

test('unsupported project switching and transient network failures do not terminate the independent receiver', async () => {
  const controller = new AbortController();
  const actions = [], deliveries = [], reports = [];
  let polls = 0;
  const snapshot = { threadId: 'thread', project: 'project', access: 'workspace', status: '就绪',
    messages: [], activity: [], approvals: [], busy: false };
  const bridge = { snapshot: () => snapshot, action: async (path, body) => {
    actions.push({ path, text: body.text }); controller.abort();
  } };
  const input = (id, text) => ({ create_time_ms: Date.now(), message_id: id, message_type: 1, from_user_id: 'owner',
    to_user_id: 'bot', context_token: 'context', item_list: [{ type: 1, text_item: { text } }] });
  const api = { call: async () => ({}), send: async (owner, context, text) => deliveries.push(text),
    updates: async () => {
      polls++;
      if (polls === 1) return { msgs: [input('1', '切换项目')] };
      if (polls === 2) throw Object.assign(new Error('temporary network reset'), { code: 'ECONNRESET' });
      return { msgs: [input('2', '只回复“测试”，不要添加其他文字。')] };
    } };
  const remote = new WeixinRemote({ bridge, api, credentials: { owner: 'owner', botID: 'bot', token: 'test' } });
  const watchdog = setTimeout(() => controller.abort(), 4000);
  try {
    await remote.run(controller.signal, message => reports.push(message));
    assert.deepEqual(actions, [{ path: '/message', text: '只回复“测试”，不要添加其他文字。' }]);
    assert.ok(deliveries.some(text => text.includes('当前是独立模式') && text.includes('微信连接保持运行')));
    assert.equal(reports.length, 2);
    assert.match(reports[0], /自动重试/);
    assert.match(reports[1], /已恢复/);
    assert.equal(polls, 3);
  } finally { clearTimeout(watchdog); }
});

test('expired WeChat authentication is distinguished from retryable disconnections in diagnostics', async () => {
  const events = [];
  const bridge = { snapshot: () => ({ threadId: 'thread', messages: [], recentTurns: [] }) };
  const api = { call: async () => ({}), updates: async () => { throw Object.assign(new Error('login expired'), { code: -14 }); } };
  const remote = new WeixinRemote({ bridge, api, credentials: { owner: 'owner', botID: 'bot', token: 'test' },
    diagnostic: (event, fields) => events.push({ event, ...fields }) });
  await assert.rejects(remote.run(new AbortController().signal, () => {}), error => error.code === -14);
  assert.ok(events.some(e => e.event === 'receiver.login_expired' && e.code === -14));
  assert.equal(events.at(-1).event, 'receiver.stopped');
});

test('Tencent wire format, big IDs, trusted hosts, local QR and fail-closed login', async () => {
  assert.equal(parseApiJSON('{"message_id":18446744073709551615}').message_id, '18446744073709551615');
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.example',
    'https://u:p@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path']) assert.throws(() => trustedBase(value));
  assert.equal(trustedBase(), 'https://ilinkai.weixin.qq.com');
  const brokenNetwork = new WeixinAPI({ fetcher: async () => { throw Object.assign(new Error('secret network details'),
    { cause: { code: 'ECONNRESET', message: 'private proxy password' } }); } });
  await assert.rejects(brokenNetwork.updates('cursor'), error => error.message.includes('ECONNRESET') &&
    error.message.includes('WeixinDirect') && !/secret|password/.test(error.message));
  const text = '中文😀'.repeat(800);
  assert.equal(chunks(text).join(''), text);
  assert.ok(chunks(text).every(c => Buffer.byteLength(c) <= 1800));
  const svg = qrSVG('https://example.invalid/qr-test');
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<script|example.invalid/);
  const temp = tempDir();
  const credentialFile = join(temp, 'weixin.json');
  let incomplete = true;
  const paths = [];
  const api = new WeixinAPI({ fetcher: async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['iLink-App-Id'], 'bot');
    if (path.endsWith('get_bot_qrcode')) {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.AuthorizationType, 'ilink_bot_token');
      assert.equal(JSON.parse(options.body).base_info, undefined);
      return json({ ret: 0, qrcode: 'qrcode', qrcode_img_content: 'qr-content' });
    }
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.AuthorizationType, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return json({ status: 'confirmed', bot_token: 'test-secret', ilink_bot_id: 'test-bot',
      ...(incomplete ? {} : { ilink_user_id: 'owner' }), baseurl: 'https://ilinkai.weixin.qq.com' });
  } });
  try {
    const options = { api, credentialFile, showQR: async content => assert.equal(content, 'qr-content'), askCode: async () => '123456' };
    await assert.rejects(login(options), /完整的登录身份/);
    assert.equal(existsSync(credentialFile), false);
    incomplete = false;
    const credentials = await login(options);
    assert.equal(credentials.owner, 'owner');
    assert.equal(readPrivateJSON(credentialFile).token, 'test-secret');
    assert.ok(!readFileSync(credentialFile, 'utf8').includes('test-secret'));
    assert.equal(paths.length, 4);
    let rawBody;
    const authenticated = new WeixinAPI({ token: 'test-secret', fetcher: async (url, options) => {
      assert.ok(url.endsWith('/sendmessage'));
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.ok(Buffer.from(options.headers['X-WECHAT-UIN'], 'base64').toString().match(/^\d+$/));
      rawBody = JSON.parse(options.body);
      return json({ ret: 0 });
    } });
    await authenticated.send('owner', 'context', '你好', 'id');
    assert.equal(rawBody.msg.to_user_id, 'owner');
    assert.equal(rawBody.msg.context_token, 'context');
    assert.equal(rawBody.msg.message_type, 2);
    assert.equal(rawBody.msg.message_state, 2);
    assert.equal(rawBody.msg.item_list[0].text_item.text, '你好');
    assert.equal(rawBody.base_info.bot_agent, 'RemoteCodex/0.2.5');
    await assert.rejects(authenticated.send('owner', '', 'text', 'id'), /上下文/);
    const expired = new WeixinAPI({ fetcher: async () => json({ ret: -14, errmsg: 'secret should never be printed' }) });
    await assert.rejects(expired.updates('cursor'), error => error.code === -14 && !error.message.includes('secret'));
  } finally { clean(temp); }
});

test('Weixin → Codex stdio substitute: owner-only, dedup, streaming, approvals and explicit full access', async () => {
  const temp = tempDir();
  const fake = fileURLToPath(new URL('fake-app-server.mjs', import.meta.url));
  const bridge = new Bridge({ rpc: new AppServer(process.execPath, [fake], temp), project: temp,
    token: 'b'.repeat(64), stateFile: join(temp, 'codex-state.json') });
  const credentials = { owner: 'owner', botID: 'test-bot', token: 'test-secret' };
  const deliveries = [];
  let failSend = false;
  const api = new WeixinAPI({ token: credentials.token, fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(url.endsWith('/sendmessage'));
    assert.equal(body.msg.to_user_id, 'owner');
    assert.equal(body.msg.context_token, 'owner-context');
    deliveries.push(body.msg);
    if (failSend) { failSend = false; throw Error('lost response'); }
    return json({ ret: 0 });
  } });
  let now = Date.now();
  const stateFile = join(temp, 'weixin-state.json');
  const make = () => new WeixinRemote({ bridge, api, credentials, stateFile, now: () => now });
  let remote = make();
  const input = (text, extra = {}) => ({ create_time_ms: now, message_id: randomUUID(), message_type: 1, from_user_id: 'owner',
    to_user_id: 'test-bot', context_token: 'owner-context', item_list: [{ type: 1, text_item: { text } }], ...extra });
  const send = text => remote.receive(input(text));
  const until = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate(bridge.snapshot())) return bridge.snapshot();
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('Codex state did not settle');
  };
  try {
    await bridge.start();
    for (const extra of [{ from_user_id: 'stranger', context_token: 'attacker-context' },
      { group_id: 'group' }, { message_type: 2 }, { to_user_id: 'another-bot' }]) {
      assert.equal(await remote.receive(input('完全访问', extra)), false);
    }
    assert.equal(remote.state.context, '');
    assert.equal(remote.state.outbox.length, 0);
    assert.equal(bridge.snapshot().messages.length, 0);
    await send('帮助');
    await remote.drain();
    assert.ok(deliveries.some(m => m.item_list[0].text_item.text.includes('允许 编号')));

    const instruction = input('hello');
    await remote.receive(instruction);
    await until(s => !s.busy);
    const count = bridge.snapshot().messages.length;
    remote.collect();
    await remote.drain();
    assert.ok(deliveries.some(m => m.item_list[0].text_item.text.includes('你好')));
    assert.equal(await remote.receive(instruction), false);
    assert.equal(bridge.snapshot().messages.length, count);
    remote = make();
    assert.equal(await remote.receive(instruction), false);
    assert.equal(bridge.snapshot().messages.length, count);

    await send('approval');
    let state = await until(s => s.approvals.length === 1);
    const short = state.approvals[0].id.slice(0, 8);
    remote.collect();
    await remote.drain();
    assert.ok(deliveries.some(m => m.item_list[0].text_item.text.includes('允许 ' + short)));
    await send('允许');
    assert.equal(bridge.snapshot().approvals.length, 1);
    await send('允许 ' + short);
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /accept/);
    await send('file');
    state = await until(s => s.approvals.length === 1);
    await send('允许 ' + short);
    assert.equal(bridge.snapshot().approvals.length, 1);
    await send('拒绝 ' + state.approvals[0].id.slice(0, 8));
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /decline/);

    await send('question');
    state = await until(s => s.approvals.length === 1);
    await send('回答 ' + state.approvals[0].id.slice(0, 8) + ' choice B');
    state = await until(s => !s.busy);
    assert.match(state.messages.at(-1).text, /"B"/);

    await send('完全访问');
    assert.equal(bridge.snapshot().access, 'workspace');
    const old = remote.challenge.code;
    now += 120001;
    await send('确认完全访问 ' + old);
    assert.equal(bridge.snapshot().access, 'workspace');
    await send('完全访问');
    const confirmation = input('确认完全访问 ' + remote.challenge.code);
    await remote.receive(confirmation);
    assert.equal(bridge.snapshot().access, 'full');
    await send('撤回完全访问');
    assert.equal(bridge.snapshot().access, 'workspace');
    assert.equal(await remote.receive(confirmation), false);
    assert.equal(bridge.snapshot().access, 'workspace');

    await send('hold');
    await until(s => s.busy && s.turnId);
    await send('状态');
    await send('停止');
    await until(s => !s.busy);
    remote = make();
    assert.equal(remote.challenge, null);
    await send('确认完全访问 ' + old);
    assert.equal(bridge.snapshot().access, 'workspace');
    remote.state.outbox = [];
    remote.enqueue('delivery retry');
    const clientID = remote.state.outbox[0].id;
    failSend = true;
    await assert.rejects(remote.drain());
    assert.equal(remote.state.outbox[0].id, clientID);
    const attempts = deliveries.length;
    await remote.drain();
    assert.equal(deliveries.length, attempts, 'network failures must back off');
    now += 1001;
    await remote.drain();
    assert.equal(remote.state.outbox.length, 0);
    assert.equal(deliveries.at(-1).client_id, clientID);
    assert.equal(deliveries.at(-2).client_id, clientID);
  } finally { await bridge.close(); clean(temp); }
});

test('rejected reply pauses across restart, new owner input recovers and duplicate input cannot rewind context', async () => {
  const temp = tempDir();
  let now = Date.now(), attempts = 0, rejectSend = false;
  const snapshot = { status: 'Codex 正在工作', project: temp, access: 'workspace', busy: true,
    activity: [{ id: 'command1', label: '执行命令', status: 'inProgress' }], messages: [], approvals: [] };
  const api = new WeixinAPI({ token: 'test-secret', fetcher: async () => {
    attempts++;
    return json(rejectSend ? { ret: -2, errmsg: 'prepare failed' } : { ret: 0 });
  } });
  const stateFile = join(temp, 'weixin-state.json');
  const make = () => new WeixinRemote({ bridge: { snapshot: () => snapshot }, api, stateFile,
    credentials: { token: 'test-secret', owner: 'owner', botID: 'bot' }, now: () => now });
  let remote = make();
  const input = (id, context, from = 'owner') => ({ create_time_ms: now, message_id: id, from_user_id: from, to_user_id: 'bot',
    message_type: 1, context_token: context, item_list: [{ type: 1, text_item: { text: '帮助' } }] });
  try {
    await remote.receive(input('1', 'old-context'));
    await remote.drain();
    const delivered = attempts;
    snapshot.activity[0] = { ...snapshot.activity[0], id: 'command2' };
    now += 11000;
    remote.collect();
    await remote.drain();
    assert.equal(attempts, delivered, 'consecutive commands must not repeat the same progress');
    remote.enqueue('retained reply');
    const id = remote.state.outbox[0].id;
    rejectSend = true;
    await assert.rejects(remote.drain(), /已暂停重发/);
    const rejected = attempts;
    remote = make();
    await remote.drain();
    assert.equal(attempts, rejected, 'restart must not replay a rejected reply');
    await remote.receive(input('attacker', 'attacker-context', 'stranger'));
    await remote.drain();
    assert.equal(attempts, rejected);
    assert.equal(remote.state.outbox[0].id, id);
    await remote.receive(input('2', 'new-context'));
    await remote.receive(input('1', 'old-context'));
    assert.equal(remote.state.context, 'new-context');
    rejectSend = false;
    await remote.drain();
    assert.ok(attempts > rejected);
    assert.equal(remote.state.outbox.length, 0);
    assert.equal(remote.state.sendBlocked, false);
  } finally { clean(temp); }
});

test('running poll loop checkpoints Tencent cursor and delivers the Codex response only to the owner', async () => {
  const temp = tempDir();
  const fake = fileURLToPath(new URL('fake-app-server.mjs', import.meta.url));
  const bridge = new Bridge({ rpc: new AppServer(process.execPath, [fake], temp), project: temp, token: 'c'.repeat(64) });
  const controller = new AbortController();
  const messages = [];
  const paths = [];
  let polls = 0;
  const api = new WeixinAPI({ token: 'test-secret', fetcher: async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    paths.push(path);
    if (path.endsWith('getupdates')) {
      assert.equal(body.get_updates_buf, polls === 0 ? '' : 'cursor1');
      const msgs = polls++ === 0 ? [{ create_time_ms: Date.now(), message_id: '18446744073709551615', message_type: 1,
        from_user_id: 'owner', to_user_id: 'test-bot', context_token: 'context',
        item_list: [{ type: 1, text_item: { text: 'hello' } }] }] : [];
      return json({ ret: 0, msgs, get_updates_buf: 'cursor1' });
    }
    if (path.endsWith('sendmessage')) {
      assert.equal(body.msg.to_user_id, 'owner');
      messages.push(body.msg.item_list[0].text_item.text);
      if (messages.at(-1).includes('你好')) controller.abort();
    }
    return json({ ret: 0 });
  } });
  let remote;
  const watchdog = setTimeout(() => controller.abort(), 8000);
  try {
    await bridge.start();
    remote = new WeixinRemote({ bridge, api, credentials: { token: 'test-secret', owner: 'owner', botID: 'test-bot' },
      stateFile: join(temp, 'weixin-state.json') });
    await remote.run(controller.signal, message => assert.fail(message));
    assert.ok(messages.some(m => m.includes('你好')), JSON.stringify({ messages, state: bridge.snapshot() }));
    assert.equal(remote.state.cursor, 'cursor1');
    assert.ok(remote.state.seen.includes('18446744073709551615'));
    assert.ok(paths.some(p => p.endsWith('notifystart')));
    assert.ok(paths.some(p => p.endsWith('notifystop')));
  } finally { clearTimeout(watchdog); await bridge.close(); clean(temp); }
});
