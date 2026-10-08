import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 10 * 1024 * 1024;
export function cleanImages(directory, now = Date.now(), reserve = 0) {
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('图片目录不能是链接。');
  const files = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(name)).map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    return { path, stat };
  }).filter(file => file.stat.isFile() && !file.stat.isSymbolicLink()).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let size = files.reduce((sum, file) => sum + file.stat.size, 0);
  for (const file of files) {
    if (now - file.stat.mtimeMs > 7 * 86400000 || size + reserve > 200 * 1024 * 1024) {
      unlinkSync(file.path); size -= file.stat.size;
    }
  }
  if (size + reserve > 200 * 1024 * 1024) throw new Error('图片存储已达上限。');
}

export async function downloadImage(item, directory, fetcher = fetch) {
  const image = item.image_item;
  const media = image?.media;
  if (!media?.full_url && !media?.encrypt_query_param) throw new Error('微信图片缺少下载信息，请重新发送普通图片。');
  const url = new URL(media.full_url || 'https://novac2c.cdn.weixin.qq.com/c2c/download');
  if (!media.full_url) url.searchParams.set('encrypted_query_param', media.encrypt_query_param);
  if (url.protocol !== 'https:' || !(url.hostname === 'cdn.weixin.qq.com' || url.hostname.endsWith('.cdn.weixin.qq.com')) ||
      url.username || url.password || (url.port && url.port !== '443')) throw new Error('图片下载地址不属于微信 HTTPS CDN。');
  let response;
  try { response = await fetcher(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('微信图片下载失败，请检查网络后重新发送。'); }
  if (!response.ok) throw new Error('微信图片下载接口拒绝请求。');
  if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('图片超过 10 MB。');
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > LIMIT) throw new Error('图片超过 10 MB。');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let bytes = Buffer.concat(parts);
  if (image.aeskey || media.aes_key) {
    let key;
    if (image.aeskey) {
      if (!/^[a-f0-9]{32}$/i.test(image.aeskey)) throw new Error('图片解密信息无效。');
      key = Buffer.from(image.aeskey, 'hex');
    } else {
      key = Buffer.from(media.aes_key, 'base64');
      if (key.length === 32 && /^[a-f0-9]{32}$/i.test(key.toString('ascii'))) key = Buffer.from(key.toString('ascii'), 'hex');
      if (key.length !== 16) throw new Error('图片解密信息无效。');
    }
    try { const decipher = createDecipheriv('aes-128-ecb', key, null); bytes = Buffer.concat([decipher.update(bytes), decipher.final()]); }
    catch { throw new Error('图片解密失败，请重新发送。'); }
  }
  const extension = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!extension) throw new Error('首版只支持普通 PNG、JPEG、WebP 图片，请不要以文件形式发送。');
  cleanImages(directory, Date.now(), bytes.length);
  const path = join(directory, randomUUID() + '.' + extension);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return path;
}
