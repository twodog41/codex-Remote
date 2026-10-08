import { createInterface } from 'node:readline';
import { join } from 'node:path';
const threadId = '00000000-0000-7000-8000-000000000001';
const secondId = '00000000-0000-7000-8000-000000000002';
const olderId = '00000000-0000-7000-8000-000000000003';
let turnNumber = 0;
const threads = [
  { id: threadId, kind: 'codex', hostId: 'local', cwd: process.cwd(), title: 'Existing desktop chat', updatedAt: 3000 },
  { id: secondId, kind: 'codex', hostId: 'local', cwd: join(process.cwd(), 'other-project'), title: 'Other project chat', updatedAt: 4000 },
  { id: olderId, kind: 'codex', hostId: 'local', cwd: process.cwd(), title: 'Older chat in same project', updatedAt: 1000 }
];
const turns = new Map(threads.map(t => [t.id, { id: 'old-turn-' + t.id, status: 'completed', items: [
  { id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'existing history' }] },
  { id: 'old-reply', type: 'agentMessage', text: 'older desktop reply' }
] }]));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== '2.0') throw Error('MCP JSON-RPC header missing');
  const ok = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  const result = value => ok({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
  if (message.method === 'initialize') ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-desktop', version: '1' } });
  else if (message.method === 'notifications/initialized') {}
  else if (message.method === 'tools/call') {
    const p = message.params;
    if (!threads.some(t => t.id === p._meta['openai/threadId'])) throw Error('Wrong desktop caller');
    const target = threads.find(t => t.id === p.arguments.threadId);
    if (p.name === 'list_threads') result({ pinnedThreads: [threads[0]], threads: [...threads,
      { id: 'cloud', kind: 'codex', hostId: 'remote', cwd: '/remote', title: 'Remote host' },
      { id: 'chatgpt', kind: 'chatgpt', cwd: process.cwd(), title: 'ChatGPT' },
      { id: 'smoke', kind: 'codex', hostId: 'local', cwd: join(process.cwd(), 'remote-codex-smoke-hidden'), title: 'Smoke test' }
    ] });
    else if (!target) ok({ content: [{ type: 'text', text: 'Thread no longer exists' }], isError: true });
    else if (p.name === 'read_thread') result({ thread: { ...target, status: { type: 'idle' } }, turns: [turns.get(target.id)] });
    else if (p.name === 'send_message_to_thread') {
      if (!p.arguments.prompt.startsWith('[微信]\n')) throw Error('WeChat source marker missing');
      const number = ++turnNumber;
      turns.set(target.id, { id: 'new-turn-' + number, status: 'completed', items: [
        { id: 'new-user-' + number, type: 'userMessage', content: [{ type: 'text', text: p.arguments.prompt }] },
        { id: 'progress-' + number, type: 'agentMessage', phase: 'commentary', text: 'internal working progress' },
        { id: 'new-reply-' + number, type: 'agentMessage', phase: 'final_answer', text: 'desktop reply to ' + p.arguments.prompt }
      ] });
      result({ threadId: target.id });
    } else throw Error('Unexpected desktop tool: ' + p.name);
  } else throw Error('Unexpected desktop method: ' + message.method);
});
