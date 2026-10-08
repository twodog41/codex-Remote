import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { AppServer } from './server.mjs';
import { assertTarget, projectAllowed } from './safety.mjs';

// Use the installed desktop plugin's MCP interface; never start a second writer for the thread.
export class DesktopBridge {
  constructor({ threadId, serverFile, pipePath, project, rpc, pollMs = 5000, configFile, allowedProjects = [project], allowlistEnabled = true }) {
    if (!/^[a-f0-9-]{36}$/i.test(threadId ?? '')) throw new Error('桌面会话 ID 无效。');
    if (!rpc && (!existsSync(serverFile ?? '') || !pipePath?.startsWith('\\\\.\\pipe\\'))) {
      throw new Error('桌面连接未配置，请在 Codex 中重新绑定微信入口。');
    }
    this.desktop = true;
    this.pollMs = pollMs;
    this.configFile = configFile;
    this.allowedProjects = allowedProjects;
    this.allowlistEnabled = allowlistEnabled;
    this.rpc = rpc ?? new AppServer(process.execPath, [serverFile], undefined,
      { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath });
    const write = this.rpc.write.bind(this.rpc);
    this.rpc.write = message => write({ jsonrpc: '2.0', ...message });
    this.state = { epoch: randomUUID(), revision: 0, threadId, project, online: false, busy: false,
      access: 'desktop', status: '正在连接桌面 Codex', messages: [], activity: [], approvals: [] };
    this.rpc.onExit = error => Object.assign(this.state, { online: false, error: error.message, status: '桌面连接已断开' });
    this.refreshing = false;
    this.routeVersion = 0;
  }

  async tool(name, args) {
    const response = await this.rpc.request('tools/call', { name, arguments: args,
      _meta: { 'openai/threadId': this.state.threadId } });
    const text = response.content?.find(c => c.type === 'text')?.text;
    if (response.isError) throw new Error(text?.slice(0, 1000) || '桌面 Codex 拒绝操作。');
    if (!text) throw new Error('桌面 Codex 返回了空结果。');
    return JSON.parse(text);
  }

  async start() {
    await this.rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'remote-codex-desktop', version: '0.2.1' } });
    this.rpc.write({ method: 'notifications/initialized' });
    await this.refresh();
    if (this.pollMs) this.timer = setInterval(() => {
      this.refresh().catch(error => Object.assign(this.state, { online: false, error: error.message, status: '读取桌面进度失败' }));
    }, this.pollMs);
  }

  async refresh() {
    if (this.refreshing || this.switching) return;
    this.refreshing = true;
    const threadId = this.state.threadId;
    const routeVersion = this.routeVersion;
    try {
      const next = await this.readSnapshot(threadId, true);
      // A slower poll for the old chat must not overwrite a completed switch.
      if (this.state.threadId === threadId && this.routeVersion === routeVersion) Object.assign(this.state, next);
    } catch (error) {
      if (this.routeVersion === routeVersion) throw error;
    } finally { this.refreshing = false; }
  }

  async readSnapshot(threadId, allowBlocked = false) {
      // Read bounded recent rounds without tool outputs; only relay a stable final answer.
      const result = await this.tool('read_thread', { threadId, turnLimit: 5,
        includeOutputs: false, maxOutputCharsPerItem: 20000 });
      if (result.thread?.id !== threadId || result.thread.kind !== 'codex') {
        throw new Error('返回的桌面聊天不匹配绑定会话。');
      }
      if (result.thread.hostId && result.thread.hostId !== 'local') throw new Error('仅支持这台电脑上的本地 Codex 会话。');
      if (!projectAllowed(result.thread.cwd, this.allowedProjects, this.allowlistEnabled)) {
        const error = '当前项目未获电脑端批准。请在微信发送“切换项目”，选择已批准的项目；或在电脑上将此项目加入白名单后重启。';
        if (!allowBlocked) throw new Error(error);
        return { threadId, online: false, blocked: true, error, busy: false, project: result.thread.cwd,
          threadTitle: '未批准的项目', status: error, messages: [], activity: [], approvals: [],
          latestTurn: null, recentTurns: [], revision: this.state.revision + 1 };
      }
      const messages = [], activity = [];
      for (const turn of [...(result.turns ?? [])].reverse()) {
        for (const item of turn.items ?? []) {
          if (item.type === 'agentMessage' && turn.status !== 'inProgress' &&
              (item.phase === 'final_answer' || (!item.phase && item === turn.items.filter(i => i.type === 'agentMessage').at(-1)))) {
            messages.push({ id: item.id, turnId: turn.id, role: 'assistant', text: item.text ?? '' });
          }
          else if (item.type === 'userMessage') messages.push({ id: item.id, turnId: turn.id, role: 'user',
            text: (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n') });
          else if (['commandExecution', 'fileChange', 'webSearch'].includes(item.type)) {
            activity.push({ id: item.id, label: { commandExecution: '执行命令', fileChange: '修改文件', webSearch: '搜索' }[item.type],
              status: item.status, detail: '' });
          }
        }
      }
      const status = result.thread.status;
      const type = typeof status === 'string' ? status : status?.type;
      const busy = type === 'active' || result.turns?.[0]?.status === 'inProgress';
      const waiting = status?.activeFlags?.includes('waitingOnApproval') || status?.activeFlags?.includes('waitingOnUserInput');
      return { threadId, online: true, blocked: false, error: null, busy, project: result.thread.cwd,
        latestTurn: result.turns?.[0] ? { id: result.turns[0].id, status: result.turns[0].status } : null,
        recentTurns: (result.turns ?? []).map(t => ({ id: t.id, status: t.status })),
        threadTitle: result.thread.title || result.thread.preview || threadId,
        status: waiting ? '等待电脑上的审批或回答' : busy ? '桌面 Codex 正在工作' : '桌面会话就绪',
        messages: messages.slice(-200), activity: activity.slice(-40), revision: this.state.revision + 1 };
  }

  async listThreads(groupProjects = true) {
    const result = await this.tool('list_threads', { limit: 50 });
    const threads = [...(result.pinnedThreads ?? []), ...(result.threads ?? [])]
      .filter(t => t.kind === 'codex' && (!t.hostId || t.hostId === 'local') && t.cwd &&
        projectAllowed(t.cwd, this.allowedProjects, this.allowlistEnabled) &&
        !/[\\/]remote-codex-smoke-[^\\/]+$/i.test(t.cwd));
    const time = t => Number(t.updatedAt ?? 0) / (Number(t.updatedAt) > 1e11 ? 1000 : 1);
    threads.sort((a, b) => time(b) - time(a));
    const ids = new Set(), projects = new Set();
    // ponytail: recent 50 chats / 20 choices; add paging if older projects need phone access.
    return threads.filter(t => {
      const project = win32.normalize(t.cwd).toLowerCase();
      if (ids.has(t.id) || (groupProjects && projects.has(project))) return false;
      ids.add(t.id); projects.add(project);
      return true;
    }).slice(0, 20).map(t => ({ id: t.id, project: t.cwd, title: t.title || '未命名聊天' }));
  }

  async switchThread(threadId) {
    if (!/^[a-f0-9-]{36}$/i.test(threadId ?? '')) throw new Error('会话 ID 无效。');
    if (this.switching) throw new Error('正在切换，请稍后重试。');
    this.switching = true;
    try {
      const next = await this.readSnapshot(threadId);
      if (this.configFile) {
        const saved = JSON.parse(readFileSync(this.configFile, 'utf8'));
        if (saved.desktop?.threadId !== this.state.threadId) throw new Error('绑定配置已被其他入口修改，请重启后再切换。');
        saved.desktop.threadId = threadId;
        writeFileSync(this.configFile + '.tmp', JSON.stringify(saved), { mode: 0o600 });
        renameSync(this.configFile + '.tmp', this.configFile);
      }
      Object.assign(this.state, next);
      this.routeVersion++;
    } finally { this.switching = false; }
  }

  async setAllowlist(enabled) {
    if (typeof enabled !== 'boolean' || !this.configFile) throw new Error('此入口无法保存白名单开关。');
    if (this.switching) throw new Error('正在切换，请稍后重试。');
    this.switching = true;
    try {
      const saved = JSON.parse(readFileSync(this.configFile, 'utf8'));
      if (saved.desktop?.threadId !== this.state.threadId) throw new Error('绑定配置已改变，请重启入口。');
      saved.allowlistEnabled = enabled;
      writeFileSync(this.configFile + '.tmp', JSON.stringify(saved), { mode: 0o600 });
      renameSync(this.configFile + '.tmp', this.configFile);
      this.allowlistEnabled = enabled;
      this.routeVersion++;
      Object.assign(this.state, { online: false, messages: [], activity: [], approvals: [], latestTurn: null, recentTurns: [] });
      Object.assign(this.state, await this.readSnapshot(this.state.threadId, true));
    } finally { this.switching = false; }
  }

  snapshot() { return { ...this.state, allowlistEnabled: this.allowlistEnabled }; }

  async action(path, body) {
    if (body.expectedThreadId) assertTarget(this.state, body.expectedThreadId);
    if (this.switching) throw new Error('正在切换会话，请稍后发送指令。');
    if (this.state.blocked) throw new Error(this.state.error);
    if (!this.state.online) throw new Error('桌面 Codex 未连接。');
    if (path === '/message' || path === '/interrupt') {
      const text = path === '/interrupt' ? '请停止当前任务，不再执行后续操作，并报告已经完成的步骤。' : body.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('指令无效。');
      const source = body.requestId ? `[遥控任务 ${body.requestId}]\n` : '';
      const result = await this.tool('send_message_to_thread', { threadId: this.state.threadId, prompt: '[微信]\n' + source + text });
      if (result.threadId !== this.state.threadId) throw new Error('桌面未确认目标会话；请检查聊天记录，避免重复发送。');
      this.state.status = path === '/interrupt' ? '停止请求已发送，尚未确认停止' : '指令已发送到桌面聊天';
    } else if (path === '/approval' || path === '/access') {
      throw new Error('桌面会话的审批和访问权限请在电脑 Codex 中处理；微信入口不会修改桌面权限。');
    } else throw new Error('桌面模式不支持此操作。');
  }

  async close() { clearInterval(this.timer); await this.rpc.close(); }
}
