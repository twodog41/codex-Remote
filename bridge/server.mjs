import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFresh, assertTarget, assertEnabled, projectAllowed } from './safety.mjs';
import { readPrivateJSON, assertStandardUser } from './vault.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const clip = (text, length = 2000) => String(text ?? '').slice(0, length);

export class AppServer {
  constructor(command = 'codex', args = ['app-server', '--listen', 'stdio://'], cwd, env = process.env) {
    // Run an executable directly: .cmd launchers are deliberately not passed to a shell.
    this.child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextID = 1;
    this.dead = false;
    this.onEvent = () => {};
    this.onExit = () => {};
    this.child.stderr.on('data', () => {}); // Codex diagnostics may contain local paths; don't forward them.
    this.child.stdin.on('error', error => this.died(error));
    this.child.on('error', error => this.died(error));
    this.child.on('exit', code => this.died(new Error(`Codex app-server 已退出 (${code})，请重启 bridge。`)));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.method) this.onEvent(message);
        else {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        }
      } catch (error) { this.died(new Error(`Codex 协议处理失败：${error.message}`)); }
    });
  }

  write(message) {
    if (this.dead) throw fail(503, 'Codex 不在线，请在 PC 重启 bridge。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex ${method} 超时；执行状态未知，请检查进度。`);
        reject(error);
        // A timed-out mutation may still execute. Stop this server instead of risking a duplicate.
        this.died(error);
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  died(error) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (process.platform === 'win32' && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      } catch {
        this.child.kill();
        error = new Error(error.message + ' 未确认所有子进程停止，请在电脑检查。');
      }
    } else this.child.kill();
    this.onExit(error);
  }

  close() {
    const exited = !this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => this.child.once('exit', resolve));
    this.died(new Error('Bridge 已停止。'));
    return exited;
  }
}

export class Bridge {
  constructor({ rpc, project, stateFile, token, pollMs = 25000, fullAccessMs = 600000, disabledFile, allowedProjects = [project], allowlistEnabled = true }) {
    if (!existsSync(project) || !statSync(project).isDirectory()) throw new Error('项目目录不存在。');
    if (!projectAllowed(project, allowedProjects, allowlistEnabled)) throw new Error('项目未获电脑端批准；未启动。');
    if (!/^[a-f0-9]{64}$/i.test(token ?? '')) throw new Error('配对密钥必须是 64 位十六进制随机值。');
    this.rpc = rpc;
    this.project = resolve(project);
    this.stateFile = stateFile;
    this.token = Buffer.from(token);
    this.pollMs = pollMs;
    this.fullAccessMs = fullAccessMs;
    this.startedAt = Date.now();
    this.disabledFile = disabledFile;
    this.receipts = new Map();
    this.approvals = new Map();
    this.items = new Map();
    this.waiters = new Set();
    this.mutation = false;
    this.state = { epoch: randomUUID(), revision: 0, project: this.project, threadId: null,
      online: false, busy: false, turnId: null, access: 'workspace', status: '正在连接 Codex',
      messages: [], activity: [], error: null };
    if (stateFile && existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved.project !== this.project) throw new Error('状态文件属于其他项目，请使用独立状态目录。');
      this.state.threadId = saved.threadId;
      this.state.messages = saved.messages ?? [];
      this.receipts = new Map(saved.receipts ?? []);
    }
    rpc.onEvent = event => this.event(event);
    rpc.onExit = error => {
      Object.assign(this.state, { online: false, busy: false, turnId: null, access: 'workspace',
        status: 'Codex 已断开', error: error.message });
      this.approvals.clear();
      this.changed();
    };
    this.server = http.createServer((req, res) => this.http(req, res));
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
  }

  save() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temp = this.stateFile + '.tmp';
    // Codex does not materialize a new thread on disk until its first turn.
    const threadId = this.state.messages.length || this.receipts.size ? this.state.threadId : null;
    writeFileSync(temp, JSON.stringify({ project: this.project, threadId,
      messages: this.state.messages, receipts: [...this.receipts] }), { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  changed() {
    this.state.revision++;
    for (const wake of [...this.waiters]) wake();
  }

  snapshot() { return { ...this.state, approvals: [...this.approvals.values()].map(p => p.view) }; }

  async start() {
    await this.rpc.request('initialize', { clientInfo: { name: 'remote_codex', title: 'Remote Codex', version: '0.2.1' },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    this.rpc.write({ method: 'initialized', params: {} });
    const params = { cwd: this.project, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
    let result;
    if (this.state.threadId) {
      try { result = await this.rpc.request('thread/resume', { ...params, threadId: this.state.threadId }); }
      catch (error) {
        if (this.receipts.size || this.state.messages.length || !/no rollout found for thread id/i.test(error.message)) throw error;
        // Recover metadata-only files written by older bridge builds; no instruction can be lost.
        result = await this.rpc.request('thread/start', params);
      }
      // The persisted mobile transcript also works when Codex uses paginated thread history.
      for (const turn of result.thread.turns ?? []) {
        for (const item of turn.items ?? []) this.item(item, true);
      }
    } else result = await this.rpc.request('thread/start', params);
    this.state.threadId = result.thread.id;
    Object.assign(this.state, { online: true, status: '就绪', error: null });
    this.save();
    this.changed();
  }

  addMessage(id, role, text) {
    let message = this.state.messages.find(m => m.id === id);
    if (!message) {
      message = { id, role, text: '' };
      this.state.messages.push(message);
      // ponytail: one recent transcript, add history pagination when >200 messages matters.
      this.state.messages = this.state.messages.slice(-200);
    }
    message.text = text;
    return message;
  }

  activity(id, label, detail, status) {
    const found = this.state.activity.find(a => a.id === id);
    const item = { id, label, detail: clip(detail), status: status ?? 'inProgress' };
    if (found) Object.assign(found, item);
    else this.state.activity.push(item);
    this.state.activity = this.state.activity.slice(-40);
  }

  item(item, history = false) {
    this.items.set(item.id, item);
    if (this.items.size > 300) this.items.delete(this.items.keys().next().value);
    if (item.type === 'agentMessage') this.addMessage(item.id, 'assistant', item.text);
    else if (item.type === 'userMessage') {
      const id = item.clientId ?? item.id;
      this.addMessage(id, 'user', (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
    } else if (!history) {
      const names = { commandExecution: '执行命令', fileChange: '修改文件', webSearch: '搜索',
        mcpToolCall: '调用工具', plan: '计划', reasoning: '正在思考', contextCompaction: '整理上下文' };
      this.activity(item.id, names[item.type] ?? '正在处理', item.command ?? item.text ?? item.tool ??
        (item.changes ?? []).map(c => c.path).join('\n'), item.status);
    }
  }

  event({ id, method, params: p = {} }) {
    if (id !== undefined) return this.serverRequest(id, method, p);
    if (p.threadId && p.threadId !== this.state.threadId) return;
    if (method === 'turn/started') {
      Object.assign(this.state, { busy: true, turnId: p.turn.id, status: 'Codex 正在工作', error: null });
    } else if (method === 'turn/completed') {
      if (this.state.turnId && p.turn.id !== this.state.turnId) return;
      for (const i of p.turn.items ?? []) this.item(i);
      const labels = { completed: '已完成', interrupted: '已停止', failed: '执行失败' };
      Object.assign(this.state, { busy: false, turnId: null, status: labels[p.turn.status] ?? p.turn.status,
        error: p.turn.error?.message ?? null, latestTurn: { id: p.turn.id, status: p.turn.status } });
      this.approvals.clear();
      this.save();
      if (this.state.access === 'full') {
        clearTimeout(this.fullAccessTimer);
        this.state.access = 'workspace';
        this.state.status += '；单轮完全访问已撤回';
        this.state.fullAccessExpiresAt = null;
      }
    } else if (method === 'item/started' || method === 'item/completed') this.item(p.item);
    else if (method === 'item/agentMessage/delta') {
      const m = this.state.messages.find(m => m.id === p.itemId);
      this.addMessage(p.itemId, 'assistant', (m?.text ?? '') + p.delta);
    } else if (method === 'item/commandExecution/outputDelta') {
      const a = this.state.activity.find(a => a.id === p.itemId);
      if (a) a.detail = (a.detail + p.delta).slice(-2000);
    } else if (method === 'turn/plan/updated') {
      this.activity('plan', '计划', (p.plan ?? []).map(s => `${s.status}: ${s.step}`).join('\n'));
    } else if (method === 'serverRequest/resolved') {
      for (const [key, approval] of this.approvals) if (approval.rpcID === p.requestId) this.approvals.delete(key);
      if (!this.approvals.size && this.state.busy) this.state.status = 'Codex 正在工作';
    } else if (method === 'error') {
      if (p.willRetry) this.state.status = p.error?.message ?? 'Codex 正在重连';
      else this.state.error = p.error?.message ?? 'Codex 出错';
    } else return;
    this.changed();
  }

  serverRequest(rpcID, method, p) {
    const types = { 'item/commandExecution/requestApproval': 'command', 'item/fileChange/requestApproval': 'file',
      'item/permissions/requestApproval': 'permissions', 'item/tool/requestUserInput': 'question' };
    const type = types[method];
    if (!type || p.threadId !== this.state.threadId) {
      // Unknown tools/connector prompts never receive a blanket approval, even in full access mode.
      if (method === 'mcpServer/elicitation/request') this.rpc.write({ id: rpcID, result: { action: 'decline', content: null, _meta: null } });
      else this.rpc.write({ id: rpcID, error: { code: -32601, message: `Remote Codex does not support ${method}` } });
      this.state.error = `暂不支持 ${method}，已拒绝；可停止任务后改用普通文字指令。`;
      this.changed();
      return;
    }
    if (p.turnId && this.state.turnId && p.turnId !== this.state.turnId) {
      this.rpc.write({ id: rpcID, error: { code: -32600, message: 'Stale turn request' } });
      return;
    }
    const item = this.items.get(p.itemId);
    const detail = type === 'file' ? JSON.stringify(item?.changes ?? { grantRoot: p.grantRoot }, null, 2)
      : type === 'permissions' ? JSON.stringify(p.permissions, null, 2)
      : p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext, null, 2) : p.command ?? item?.command ?? '';
    const key = randomUUID();
    this.approvals.set(key, { rpcID, method, params: p, view: { id: key, type, reason: p.reason ?? '', detail,
      cwd: p.cwd ?? this.project, questions: p.questions ?? [] } });
    this.state.status = type === 'question' ? '等待你的回答' : '等待你的授权';
    this.changed();
  }

  policy() {
    return this.state.access === 'full'
      ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
      : { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.project],
        networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
  }

  async turn(text, clientId) {
    Object.assign(this.state, { busy: true, status: '正在发送', error: null });
    if (clientId) this.addMessage(clientId, 'user', text);
    try {
      this.save();
      this.changed();
      const result = await this.rpc.request('turn/start', { threadId: this.state.threadId,
        cwd: this.project, ...this.policy(), approvalsReviewer: 'user',
        ...(clientId ? { clientUserMessageId: clientId } : {}), input: [{ type: 'text', text, text_elements: [] }] });
      // Fast turns can complete before the RPC response arrives.
      if (this.state.busy) this.state.turnId = result.turn.id;
      this.changed();
    } catch (error) {
      Object.assign(this.state, { busy: false, turnId: null, status: '发送失败', error: error.message });
      this.changed();
      throw error;
    }
  }

  async interrupt() {
    if (!this.state.busy) return;
    if (!this.state.turnId) throw fail(409, '任务尚在启动，请稍后停止。');
    const turnId = this.state.turnId;
    let timer, wake;
    // Wait for the actual completion event before starting a replacement turn.
    const completed = new Promise((resolve, reject) => {
      wake = () => {
        if (!this.state.online) reject(fail(503, 'Codex 已断开。'));
        else if (!this.state.busy || this.state.turnId !== turnId) resolve();
      };
      this.waiters.add(wake);
      timer = setTimeout(() => reject(fail(504, '停止未确认，请检查 PC；权限尚未切换。')), 15000);
    });
    // Attach a rejection handler while the interrupt RPC is still pending.
    completed.catch(() => {});
    try { await this.rpc.request('turn/interrupt', { threadId: this.state.threadId, turnId }); await completed; }
    finally { clearTimeout(timer); this.waiters.delete(wake); }
  }

  async action(path, body) {
    try { assertEnabled(this.disabledFile); }
    catch (error) { throw fail(403, error.message); }
    if (body.expectedThreadId) {
      try { assertTarget(this.state, body.expectedThreadId); }
      catch (error) { throw fail(409, error.message); }
    }
    if (!this.state.online) throw fail(503, 'Codex 不在线，请在 PC 重启 bridge。');
    if (path === '/message') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000 ||
        typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.id)) throw fail(400, '指令或消息 ID 无效。');
      const old = this.receipts.get(body.id);
      if (old) {
        if (old.text !== body.text) throw fail(409, '消息 ID 已用于另一条指令。');
        if (old.error) throw fail(409, old.error);
        return; // A lost HTTP response must not execute the instruction twice.
      }
      if (this.state.busy) throw fail(409, 'Codex 正在执行，请先停止或等它完成。');
      this.receipts.set(body.id, { text: body.text });
      if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
      this.save();
      try { await this.turn(body.text, body.id); }
      catch (error) {
        this.receipts.get(body.id).error = `这条指令未确认成功：${error.message}。请检查进度，确认后另发一条指令。`;
        this.save();
        throw error;
      }
    } else if (path === '/approval') {
      const pending = this.approvals.get(body.id);
      if (!pending) throw fail(409, '此请求已处理或已过期。');
      let result;
      if (pending.view.type === 'question') {
        const answers = {};
        for (const q of pending.params.questions) {
          const answer = body.answers?.[q.id];
          if (typeof answer !== 'string' || !answer.trim() || answer.length > 10000) throw fail(400, '请回答每个问题。');
          answers[q.id] = { answers: [answer] };
        }
        result = { answers };
      } else {
        if (!['allow', 'deny'].includes(body.decision)) throw fail(400, '授权选择无效。');
        result = pending.view.type === 'permissions'
          ? { permissions: body.decision === 'allow' ? Object.fromEntries(Object.entries(pending.params.permissions).filter(([, v]) => v != null)) : {}, scope: 'turn' }
          : { decision: body.decision === 'allow' ? 'accept' : 'decline' };
      }
      this.rpc.write({ id: pending.rpcID, result });
      this.approvals.delete(body.id);
      this.state.status = this.approvals.size ? '等待你的授权' : 'Codex 正在工作';
      this.activity(randomUUID(), '你的决定', pending.view.type === 'question' ? '已回答' : body.decision === 'allow' ? '允许这一次' : '已拒绝', 'completed');
      this.changed();
    } else if (path === '/access') {
      if (!['workspace', 'full'].includes(body.mode)) throw fail(400, '权限模式无效。');
      if (body.mode === 'full' && body.confirm !== 'ALLOW_FULL_PC_ACCESS') throw fail(400, '需要明确确认完全访问 PC。');
      if (this.state.access === body.mode && body.mode === 'full') return;
      const wasBusy = this.state.busy;
      await this.interrupt();
      this.state.access = body.mode;
      clearTimeout(this.fullAccessTimer);
      this.state.fullAccessExpiresAt = body.mode === 'full' ? Date.now() + this.fullAccessMs : null;
      if (body.mode === 'full') {
        this.fullAccessTimer = setTimeout(() => this.expireFullAccess(), this.fullAccessMs);
        this.fullAccessTimer.unref?.();
      }
      this.state.status = body.mode === 'full' ? '完全访问已启用' : '已恢复项目权限';
      this.changed();
      if (wasBusy && body.mode === 'full') {
        await this.turn('用户已明确允许 Codex 完全访问这台 PC。请继续刚才尚未完成的任务，先检查已完成的操作，避免重复执行。');
      }
    } else if (path === '/interrupt') { await this.interrupt(); }
    else throw fail(404, '接口不存在。');
  }

  async http(req, res) {
    const send = (status, data) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(data));
      }
    };
    try {
      const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (auth.length !== this.token.length || !timingSafeEqual(auth, this.token)) throw fail(401, '配对密钥无效。');
      try { assertEnabled(this.disabledFile); }
      catch (error) { throw fail(403, error.message); }
      // Native requests carry no Origin. Refuse browsers and never emit CORS permissions.
      if (req.headers.origin) throw fail(403, '只允许原生客户端。');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/state') {
        if (url.searchParams.get('epoch') === this.state.epoch && Number(url.searchParams.get('after')) === this.state.revision) {
          if (this.waiters.size >= 16) throw fail(429, '连接过多。');
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.waiters.delete(done); res.off('close', done); resolve(); };
            const timer = setTimeout(done, this.pollMs);
            this.waiters.add(done);
            res.once('close', done);
          });
        }
        return send(200, this.snapshot());
      }
      if (req.method !== 'POST') throw fail(404, '接口不存在。');
      if (!['/message', '/approval', '/access', '/interrupt'].includes(url.pathname)) throw fail(404, '接口不存在。');
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw fail(415, '需要 JSON。');
      const raw = await new Promise((resolve, reject) => {
        let bytes = 0, finished = false;
        const chunks = [];
        req.on('data', chunk => {
          if (finished) return;
          bytes += chunk.length;
          if (bytes > 128 * 1024) {
            finished = true;
            chunks.length = 0;
            reject(fail(413, '请求过大。'));
          } else chunks.push(chunk);
        });
        req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)); } });
        req.on('error', reject);
        req.on('aborted', () => reject(fail(400, '请求已中断。')));
      });
      let body;
      try { body = JSON.parse(raw.toString('utf8')); }
      catch { throw fail(400, 'JSON 无效。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'JSON 对象无效。');
      try { assertFresh(body.sentAt, Date.now(), this.startedAt); }
      catch (error) { throw fail(409, error.message); }
      if (this.mutation) throw fail(409, '另一个操作正在处理，请稍后重试。');
      this.mutation = true;
      try { await this.action(url.pathname, body); send(200, this.snapshot()); }
      finally { this.mutation = false; }
    } catch (error) { send(error.status ?? 500, { error: error.message }); }
  }

  async listen(port = 8787) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    return this.server.address().port;
  }

  async close() {
    clearTimeout(this.fullAccessTimer);
    if (this.state.online && this.state.busy) {
      try { await this.interrupt(); } catch { /* Stop the owned server even if its turn cannot confirm interruption. */ }
    }
    await this.rpc.close();
    for (const wake of [...this.waiters]) wake();
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }

  async expireFullAccess() {
    if (this.state.access !== 'full') return;
    this.state.access = 'workspace';
    this.state.fullAccessExpiresAt = null;
    this.state.status = '完全访问已到期，正在停止高权限任务';
    this.changed();
    try { await this.interrupt(); this.state.status = '完全访问已到期，已恢复项目权限'; }
    catch { this.rpc.died(new Error('高权限到期后无法确认停止，已关闭所拥有的 Codex 服务。')); }
    this.changed();
  }
}

export function loadConfig() {
  const root = process.env.REMOTE_CODEX_HOME ?? join(process.env.LOCALAPPDATA ?? process.cwd(), 'RemoteCodex');
  const configFile = join(root, 'config.json');
  if (!existsSync(configFile)) throw new Error('请先运行 scripts/setup.ps1 -Project <项目目录>。');
  const config = readPrivateJSON(configFile);
  for (const name of readdirSync(root).filter(name => /^config-before-desktop-[a-zA-Z0-9-]+\.json$/.test(name))) {
    readPrivateJSON(join(root, name));
  }
  const project = resolve(config.project);
  return { project, token: config.token, stateFile: join(root, 'state.json'), port: config.port ?? 8787,
    command: process.env.CODEX_BIN ?? 'codex', desktop: config.desktop, configFile,
    allowedProjects: config.allowedProjects ?? [project], allowlistEnabled: config.allowlistEnabled === true,
    disabledFile: join(root, 'remote-disabled') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let bridge;
  try {
    assertStandardUser();
    const config = loadConfig();
    assertEnabled(config.disabledFile);
    bridge = new Bridge({ ...config, rpc: new AppServer(config.command, undefined, config.project) });
    await bridge.start();
    await bridge.listen(config.port);
    console.log(`Remote Codex: http://127.0.0.1:${config.port} (仅本机；使用 Tailscale Serve 连接)`);
    console.log(`项目: ${config.project}`);
    const stop = async () => { await bridge.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error.message);
    if (bridge) await bridge.close();
    process.exitCode = 1;
  }
}
