import assert from 'node:assert/strict';
import test from 'node:test';
import { getProvider } from '../src/providers.js';

const request = {
  prompt: 'hello',
  cwd: '/tmp/project',
  access: 'workspace-write' as const,
};

test('Codex parser extracts thread and final message', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'assistant_message', text: 'done' },
    }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n');

  assert.deepEqual(getProvider('codex').parse(output), {
    nativeSessionId: 'thread-1',
    response: 'done',
    error: undefined,
    success: true,
  });
});

test('Claude adapter resumes by native session id', () => {
  const command = getProvider('claude').resume(request, 'session-1');
  assert.equal(command.command, 'claude');
  assert.ok(command.args.includes('--resume'));
  assert.ok(command.args.includes('session-1'));

  assert.equal(
    getProvider('claude').parse(
      JSON.stringify({
        session_id: 'session-1',
        result: 'ok',
        is_error: false,
      }),
    ).success,
    true,
  );
});

test('Antigravity parser extracts conversation id', () => {
  assert.deepEqual(
    getProvider('antigravity').parse(
      JSON.stringify({
        conversation_id: 'conversation-1',
        status: 'SUCCESS',
        response: 'ok',
      }),
    ),
    {
      nativeSessionId: 'conversation-1',
      response: 'ok',
      error: undefined,
      success: true,
    },
  );
});


test('Codex resume reapplies execution policy before the resume subcommand', () => {
  const command = getProvider('codex').resume(
    {
      prompt: 'continue',
      cwd: '/tmp/project',
      access: 'read-only',
      model: 'gpt-test',
      effort: 'high',
    },
    'thread-1',
  );

  assert.deepEqual(command.args, [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--model',
    'gpt-test',
    '-c',
    'model_reasoning_effort="high"',
    'resume',
    'thread-1',
    'continue',
  ]);
});

test('Claude adapter applies model and effort on start and resume', () => {
  const configured = {
    prompt: 'hello',
    cwd: '/tmp/project',
    access: 'read-only' as const,
    model: 'opus',
    effort: 'high',
  };
  for (const command of [
    getProvider('claude').start(configured),
    getProvider('claude').resume(configured, 'session-1'),
  ]) {
    assert.ok(command.args.includes('--model'));
    assert.ok(command.args.includes('opus'));
    assert.ok(command.args.includes('--effort'));
    assert.ok(command.args.includes('high'));
  }
});


test('Antigravity access modes map to explicit execution and sandbox policy', () => {
  const adapter = getProvider('antigravity');
  const argsFor = (access: 'read-only' | 'workspace-write' | 'full') =>
    adapter.start({ prompt: 'x', cwd: '/tmp/project', access }).args;

  assert.ok(argsFor('read-only').includes('--mode=plan'));
  assert.ok(argsFor('read-only').includes('--sandbox'));

  assert.ok(argsFor('workspace-write').includes('--mode=accept-edits'));
  assert.ok(argsFor('workspace-write').includes('--sandbox'));

  assert.ok(argsFor('full').includes('--mode=accept-edits'));
  assert.ok(argsFor('full').includes('--dangerously-skip-permissions'));
  assert.equal(argsFor('full').includes('--sandbox'), false);
});
