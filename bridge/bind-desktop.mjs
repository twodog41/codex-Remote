import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopBridge } from './desktop.mjs';
import { loadConfig } from './server.mjs';

const threadId = process.argv[process.argv.indexOf('--thread') + 1];
if (!process.argv.includes('--thread') || !/^[a-f0-9-]{36}$/i.test(threadId ?? '')) throw new Error('请指定 --thread 会话ID。');
const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!pipePath) throw new Error('请从桌面 Codex 中执行绑定；普通终端没有桌面连接信息。');
const pluginRoot = join(process.env.USERPROFILE, '.codex', 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
const serverFile = readdirSync(pluginRoot).map(name => join(pluginRoot, name, 'server.mjs'))
  .filter(file => existsSync(file)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const config = loadConfig();
const desktop = new DesktopBridge({ threadId, serverFile, pipePath, project: config.project, allowedProjects: config.allowedProjects, allowlistEnabled: config.allowlistEnabled, pollMs: 0 });
try {
  await desktop.start();
  const configRoot = process.env.REMOTE_CODEX_HOME || join(process.env.LOCALAPPDATA, 'RemoteCodex');
  const configFile = join(configRoot, 'config.json');
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  saved.desktop = { threadId, serverFile, pipePath };
  writeFileSync(configFile + '.tmp', JSON.stringify(saved), { mode: 0o600 });
  renameSync(configFile + '.tmp', configFile);
  console.log('已绑定桌面聊天：' + desktop.snapshot().threadTitle + '\n会话 ID：' + threadId);
} finally { await desktop.close(); }
