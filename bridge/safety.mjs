// Fail closed before any PC action. Tencent's message timestamp is milliseconds.
import { realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
export const COMMAND_TTL = 120000;
export function assertFresh(sentAt, now, notBefore = 0) {
  if (!Number.isSafeInteger(sentAt) || sentAt <= 0 || sentAt > now + 30000 ||
      now - sentAt > COMMAND_TTL || sentAt < notBefore) {
    throw new Error('指令时间无效、已过期或早于本次连接/项目切换；没有执行，请在当前项目重新发送。');
  }
}

export function assertTarget(snapshot, expectedThreadId) {
  if (!expectedThreadId || snapshot.threadId !== expectedThreadId) {
    throw new Error('项目或会话已改变；没有执行，请核对当前项目后重新发送。');
  }
}

export function projectAllowed(project, allowedProjects, enabled = true) {
  try {
    const canonical = realpathSync.native(project).toLowerCase();
    return !enabled || allowedProjects.some(path => resolve(path).toLowerCase() === canonical);
  } catch { return false; }
}

export function assertEnabled(disabledFile) {
  if (disabledFile && existsSync(disabledFile)) throw new Error('遥控已由电脑端停用，需在电脑恢复；没有执行。');
}

export function redact(text) {
  return String(text).replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g, '[私钥已隐藏]')
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{20,}\b/g, '[密钥已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|密码|密钥)["']?\s*[=:：]\s*["']?)[^\s"'`,;]+/gi, '$1[已隐藏]');
}
