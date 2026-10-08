import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadImage } from '../images.mjs';
import { WeixinRemote } from '../weixin.mjs';

test('authorized WeChat images are bounded, decrypted locally and forwarded once as a PC image path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-image-test-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
  const key = randomBytes(16), cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  let fetches = 0;
  const fetcher = async (url, options) => {
    fetches++; assert.equal(new URL(url).hostname, 'novac2c.cdn.weixin.qq.com');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined);
    return new Response(encrypted);
  };
  const image = { type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'private-param' } } };
  const instructions = [];
  const bridge = { desktop: true, snapshot: () => ({ threadId: 'image-thread', project: root, status: '就绪',
    access: 'desktop', messages: [], activity: [], approvals: [], busy: false }), action: async (path, body) => instructions.push(body.text) };
  const remote = new WeixinRemote({ bridge, api: {}, stateFile: join(root, 'weixin-state.json'), imageDirectory: join(root, 'images'),
    imageFetcher: fetcher, credentials: { owner: 'owner', botID: 'bot', token: 'test' } });
  const message = { create_time_ms: Date.now(), message_id: '1', from_user_id: 'owner', to_user_id: 'bot', message_type: 1, context_token: 'context', item_list: [image] };
  try {
    assert.equal(await remote.receive({ ...message, from_user_id: 'stranger' }), false);
    assert.equal(fetches, 0);
    await remote.receive(message);
    assert.equal(instructions.length, 1); assert.match(instructions[0], /图片查看工具/);
    const path = JSON.parse(instructions[0].split('\n').at(-1));
    assert.ok(path.startsWith(join(root, 'images'))); assert.deepEqual(readFileSync(path), png);
    assert.equal(await remote.receive(message), false); assert.equal(fetches, 1);
    const alternate = { type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download',
      aes_key: Buffer.from(key.toString('hex')).toString('base64') } } };
    assert.deepEqual(readFileSync(await downloadImage(alternate, join(root, 'images'), fetcher)), png);
    await assert.rejects(downloadImage({ type: 2, image_item: { media: { full_url: 'https://evil.example/image' } } }, root, fetcher), /HTTPS CDN/);
    await assert.rejects(downloadImage(image, root, async () => new Response('', { headers: { 'content-length': '20000000' } })), /10 MB/);
    await assert.rejects(downloadImage({ type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/image' } } }, root,
      async () => new Response('not-an-image')), /PNG/);
  } finally {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + '\\') || absolute.startsWith(resolve(tmpdir()) + '/'));
    assert.match(absolute, /remote-codex-image-test-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});

test('finished rounds catch up once and distinguish failure, interruption and active work', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-codex-image-test-'));
  let snapshot = { threadId: 'round-thread', project: root, threadTitle: 'rounds', status: '就绪',
    access: 'desktop', messages: [], activity: [], approvals: [], busy: false,
    recentTurns: [{ id: 'old', status: 'completed' }] };
  const bridge = { snapshot: () => snapshot };
  try {
    const remote = new WeixinRemote({ bridge, api: {}, stateFile: join(root, 'state.json'),
      credentials: { owner: 'owner', botID: 'bot', token: 'test' } });
    remote.state.context = 'test-context';
    snapshot = { ...snapshot, recentTurns: [{ id: 'active', status: 'inProgress' },
      { id: 'stop', status: 'interrupted' }, { id: 'failure', status: 'failed' },
      { id: 'success', status: 'completed' }, { id: 'old', status: 'completed' }] };
    remote.collect(); remote.collect();
    const messages = remote.state.outbox.map(item => item.text).join('\n');
    assert.equal((messages.match(/本轮回答已结束/g) ?? []).length, 1);
    assert.equal((messages.match(/本轮执行失败/g) ?? []).length, 1);
    assert.equal((messages.match(/本轮已停止/g) ?? []).length, 1);
    assert.ok(!remote.state.finishedTurns.includes('round-thread:active'));
  } finally {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + '\\') || absolute.startsWith(resolve(tmpdir()) + '/'));
    assert.match(absolute, /remote-codex-image-test-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});
