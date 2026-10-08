// Uses the installed CLI and its existing login. --tools also runs one harmless shell command.
import { AppServer, Bridge } from '../server.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const project = mkdtempSync(join(tmpdir(), 'remote-codex-smoke-'));
const token = randomBytes(32).toString('hex');
const rpc = new AppServer(process.env.CODEX_BIN ?? 'codex', undefined, project);
const bridge = new Bridge({ rpc, project, token });
try {
  console.log('Initializing installed Codex app-server...');
  await bridge.start();
  console.log('Starting a no-tools inference turn...');
  const port = await bridge.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const response = await fetch(base + '/message', { method: 'POST', headers, body: JSON.stringify({
    id: randomUUID(), text: 'Do not use any tools. Reply with exactly REMOTE_CODEX_OK.' }) });
  if (!response.ok) throw Error(JSON.stringify(await response.json()));
  let snapshot;
  const deadline = Date.now() + 120000;
  do {
    const query = snapshot ? `?after=${snapshot.revision}&epoch=${snapshot.epoch}` : '';
    snapshot = await (await fetch(base + '/state' + query, { headers })).json();
    if (!snapshot.online || (!snapshot.busy && snapshot.error)) throw Error(snapshot.error ?? 'Codex disconnected');
    if (Date.now() > deadline) throw Error('Smoke turn timed out');
  } while (snapshot.busy);
  const reply = snapshot.messages.filter(m => m.role === 'assistant').at(-1)?.text;
  if (snapshot.messages.filter(m => m.role === 'user').length !== 1) throw Error('Duplicate user message');
  if (reply?.trim() !== 'REMOTE_CODEX_OK' || snapshot.status !== '已完成') throw Error(`Unexpected reply: ${reply}; status: ${snapshot.status}`);
  console.log('PASS: installed Codex initialize → thread/start → turn/start → streamed reply → completed, through authenticated HTTP.');
  const thread = snapshot.threadId;
  const resumed = await rpc.request('thread/resume', { threadId: thread, cwd: project,
    sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  if (resumed.thread.id !== thread) throw Error('Resume returned another thread');
  console.log('PASS: thread/resume preserves the real Codex conversation.');
  if (process.argv.includes('--tools')) {
    console.log('Testing one sandboxed Windows shell command...');
    const response = await fetch(base + '/message', { method: 'POST', headers, body: JSON.stringify({
      id: randomUUID(), text: 'Use the shell tool to run exactly Write-Output REMOTE_CODEX_TOOL_OK in this project. Do not modify any files or run any other command. Then reply with exactly REMOTE_CODEX_TOOL_OK.' }) });
    if (!response.ok) throw Error(JSON.stringify(await response.json()));
    let snapshot;
    let approved = false;
    const deadline = Date.now() + 120000;
    do {
      const query = snapshot ? `?after=${snapshot.revision}&epoch=${snapshot.epoch}` : '';
      snapshot = await (await fetch(base + '/state' + query, { headers })).json();
      if (snapshot.approvals.length) {
        const approval = snapshot.approvals[0];
        // Only the literal test command can be approved, once. Never enable full access.
        const safe = /^(?:"[^"\r\n]+[\\/](?:pwsh|powershell)\.exe"|(?:pwsh|powershell)(?:\.exe)?) -Command (?:'Write-Output REMOTE_CODEX_TOOL_OK'|"Write-Output REMOTE_CODEX_TOOL_OK")$/i;
        if (approved || snapshot.approvals.length !== 1 || approval.type !== 'command' || !safe.test(approval.detail)) {
          throw Error('Unexpected tool approval: ' + JSON.stringify(snapshot.approvals));
        }
        const response = await fetch(base + '/approval', { method: 'POST', headers,
          body: JSON.stringify({ id: approval.id, decision: 'allow' }) });
        if (!response.ok) throw Error(JSON.stringify(await response.json()));
        snapshot = await response.json();
        approved = true;
        console.log('PASS: exact test command approved once through the phone approval API.');
      }
      if (!snapshot.online || (!snapshot.busy && snapshot.error)) throw Error(snapshot.error ?? 'Codex disconnected');
      if (Date.now() > deadline) throw Error('Tool smoke turn timed out');
    } while (snapshot.busy);
    const command = snapshot.activity.find(a => a.label === '执行命令' && a.status === 'completed');
    if (!command || snapshot.messages.filter(m => m.role === 'assistant').at(-1)?.text.trim() !== 'REMOTE_CODEX_TOOL_OK') {
      throw Error(`Shell did not complete: ${JSON.stringify(snapshot.activity)}`);
    }
    console.log('PASS: real Windows shell execution completed; full PC access stayed off.');
  }
  console.log(`Smoke workspace: ${project} (kept for inspection).`);
} finally { await bridge.close(); }
