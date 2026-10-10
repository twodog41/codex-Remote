import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopBridge } from './desktop.mjs';

export function discoverDesktopPipes() {
  if (process.platform !== 'win32') return [];
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('discover-desktop.ps1', import.meta.url));
  try {
    const result = JSON.parse(execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    return Array.isArray(result) ? result.filter(p => /^\\\\\.\\pipe\\codex-browser-use-[a-f0-9-]{36}$/i.test(p)).slice(0, 24) : [];
  } catch { return []; }
}

function installedServer(fallback) {
  const root = join(process.env.USERPROFILE ?? '', '.codex', 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  if (!existsSync(root)) return fallback;
  return readdirSync(root).map(name => join(root, name, 'server.mjs')).filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? fallback;
}

export async function connectDesktop(config, { discover = discoverDesktopPipes, create = options => new DesktopBridge(options), timeoutMs = 5000 } = {}) {
  const options = { ...config.desktop, project: config.project, configFile: config.configFile,
    allowedProjects: config.allowedProjects, allowlistEnabled: config.allowlistEnabled };
  async function attempt(pipePath, serverFile) {
    const bridge = create({ ...options, pipePath, serverFile });
    let timer;
    try {
      await Promise.race([bridge.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('桌面连接验证超时。')), timeoutMs); })]);
      if (bridge.snapshot().threadId !== options.threadId) throw new Error('返回的桌面聊天不匹配。');
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  try { return await attempt(options.pipePath, options.serverFile); }
  catch (error) {
    if (existsSync(options.serverFile ?? '') && !/connect (?:ENOENT|ECONNREFUSED)|连接验证超时/.test(error.message)) throw error;
  }
  const serverFile = installedServer(options.serverFile);
  for (const pipePath of discover().filter(p => p !== options.pipePath)) {
    let bridge;
    try { bridge = await attempt(pipePath, serverFile); } catch { continue; }
    try {
      const saved = JSON.parse(readFileSync(config.configFile, 'utf8'));
      if (saved.desktop?.threadId !== options.threadId) throw new Error('绑定聊天已被其他入口修改，请重启。');
      saved.desktop = { ...saved.desktop, pipePath, serverFile };
      writeFileSync(config.configFile + '.tmp', JSON.stringify(saved), { mode: 0o600 });
      renameSync(config.configFile + '.tmp', config.configFile);
      console.log('桌面连接地址已自动更新，继续使用原聊天。');
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }
  throw new Error('原桌面连接地址已失效。请打开 Codex App 后重试；仍无法恢复时，在原聊天中让 Codex 重新绑定微信入口。聊天目标未改变。');
}
