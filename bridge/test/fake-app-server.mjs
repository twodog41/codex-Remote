import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const threadId = 'test-thread';
let nextTurn = 0;
let activeTurn;
let pending;
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params: p, result } = JSON.parse(line);
  const ok = result => send({ id, result });
  const event = (method, params) => send({ method, params: { threadId, ...params } });
  if (!method) {
    event('serverRequest/resolved', { requestId: id });
    if (id !== pending?.id) return;
    const text = JSON.stringify(result);
    event('item/agentMessage/delta', { itemId: 'reply-' + activeTurn, delta: text });
    event('turn/completed', { turn: { id: activeTurn, status: 'completed', items: [], error: null } });
    pending = null;
  } else if (method === 'initialize') ok({ userAgent: 'fake' });
  else if (method === 'initialized') {}
  else if (method === 'thread/start' || method === 'thread/resume') {
    if (p.approvalPolicy !== 'on-request' || p.sandbox !== 'workspace-write' || p.approvalsReviewer !== 'user') throw Error('Unsafe thread defaults');
    ok({ thread: { id: threadId, turns: [] } });
  } else if (method === 'turn/interrupt') {
    ok({});
    event('turn/completed', { turn: { id: activeTurn, status: 'interrupted', items: [], error: null } });
    pending = null;
  } else if (method === 'turn/start') {
    activeTurn = 'turn-' + (++nextTurn);
    const text = p.input[0].text;
    const full = p.sandboxPolicy.type === 'dangerFullAccess';
    if (full ? p.approvalPolicy !== 'never' : p.approvalPolicy !== 'on-request' || p.sandboxPolicy.networkAccess !== false) throw Error('Wrong turn policy');
    event('turn/started', { turn: { id: activeTurn } });
    ok({ turn: { id: activeTurn, status: 'inProgress' } });
    event('item/started', { item: { id: 'user-' + activeTurn, clientId: p.clientUserMessageId ?? null, type: 'userMessage', content: p.input } });
    if (['hold', 'approval', 'file', 'permissions', 'question'].includes(text)) {
      if (text === 'hold') return;
      const item = text === 'file'
        ? { id: 'item-' + activeTurn, type: 'fileChange', changes: [{ path: 'example.txt', diff: '+review me' }], status: 'inProgress' }
        : { id: 'item-' + activeTurn, type: 'commandExecution', command: 'echo safe-preview', status: 'inProgress' };
      event('item/started', { item });
      pending = { id: 'server-request-' + nextTurn };
      send({ id: pending.id, method: text === 'approval' ? 'item/commandExecution/requestApproval'
        : text === 'file' ? 'item/fileChange/requestApproval'
        : text === 'permissions' ? 'item/permissions/requestApproval' : 'item/tool/requestUserInput',
        params: { threadId, turnId: activeTurn, itemId: item.id, cwd: process.cwd(), reason: 'test',
          permissions: { network: { enabled: true }, fileSystem: null },
          questions: [{ id: 'choice', header: '选择', question: '哪一个？', isSecret: false, options: null }] } });
    } else if (text === 'unknown') {
      send({ id: 'unsupported', method: 'item/unknown/requestApproval', params: { threadId, turnId: activeTurn } });
      event('turn/completed', { turn: { id: activeTurn, status: 'failed', items: [], error: { message: 'unsupported tool' } } });
    } else if (text === 'retry') {
      event('error', { turnId: activeTurn, error: { message: 'Reconnecting... 1/5' }, willRetry: true });
      setTimeout(() => {
        event('item/completed', { item: { id: 'retry-reply-' + activeTurn, type: 'agentMessage', text: 'recovered' } });
        event('turn/completed', { turn: { id: activeTurn, status: 'completed', items: [], error: null } });
      }, 50);
    } else if (text === 'crash') process.exit(2);
    else {
      event('item/agentMessage/delta', { itemId: 'reply-' + activeTurn, delta: '你' });
      event('item/agentMessage/delta', { itemId: 'reply-' + activeTurn, delta: '好' });
      event('item/completed', { item: { id: 'reply-' + activeTurn, type: 'agentMessage', text: '你好' } });
      event('turn/completed', { turn: { id: activeTurn, status: 'completed', items: [], error: null } });
    }
  } else throw Error('Unexpected method: ' + method);
});
