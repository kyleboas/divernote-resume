import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeSessionId, findSessionSource, importAgentSession, rewriteClaudeTranscript, rewritePiSession } from './import.mjs';

const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';

test('a Claude Code transcript is repointed at the issue', () => {
  const source = [
    JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, cwd: '/old', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'summary', summary: 'x' }),
    '',
  ].join('\n');
  const out = rewriteClaudeTranscript(source, { sessionId: 'issue-1', cwd: '/new' }).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(out[0].sessionId, claudeSessionId('issue-1'));
  assert.equal(out[0].cwd, '/new');
  assert.deepEqual(out[1], { type: 'summary', summary: 'x' });
  assert.throws(() => rewriteClaudeTranscript('nope', { sessionId: 'a', cwd: '/n' }), /valid JSONL/);
});

test('a Pi session header is repointed at the issue', () => {
  const source = `${JSON.stringify({ type: 'session', id: 'old', cwd: '/old', timestamp: 't' })}\n${JSON.stringify({ type: 'message', id: 'm1' })}\n`;
  const [header, message] = rewritePiSession(source, { sessionId: 'issue-1', cwd: '/new' }).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(header, { type: 'session', id: 'issue-1', cwd: '/new', timestamp: 't' });
  assert.equal(message.id, 'm1');
  assert.throws(() => rewritePiSession('{"type":"message"}', { sessionId: 'a', cwd: '/n' }), /no header/);
});

test('a session ID is found in the agent store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'import-'));
  const env = { HOME: home };
  const claude = join(home, '.claude', 'projects', '-code-app');
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, `${CLAUDE_ID}.jsonl`), '{}\n');
  assert.equal(await findSessionSource('claude', CLAUDE_ID, { env }), join(claude, `${CLAUDE_ID}.jsonl`));
  const pi = join(home, '.pi', 'agent', 'sessions', '--code-app--');
  await mkdir(pi, { recursive: true });
  await writeFile(join(pi, '2026-01-01T00-00-00-000Z_abc.jsonl'), '{}\n');
  assert.match(await findSessionSource('pi', 'abc', { env }), /_abc\.jsonl$/);
  await assert.rejects(findSessionSource('pi', 'missing', { env }), /not found/);
  await assert.rejects(findSessionSource('claude', 'not-a-uuid', { env }), /UUID/);
  await assert.rejects(findSessionSource('pi', '/etc/passwd', { env }), /could not be read/);
  assert.equal(await readFile(join(claude, `${CLAUDE_ID}.jsonl`), 'utf8'), '{}\n');
});

test('an import copies the session into the issue and switches its agent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'import-'));
  const env = { HOME: home };
  const worktree = join(home, 'work');
  const claude = join(home, '.claude', 'projects', '-code-app');
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, `${CLAUDE_ID}.jsonl`), `${JSON.stringify({ sessionId: CLAUDE_ID, cwd: '/old', type: 'user' })}\n`);
  const settings = { issues: {} };
  let released = false;
  const divernote = {
    tryAcquireIdlePiSession: async () => async () => { released = true; },
    resolvePiProject: async () => worktree,
    hasPiSession: async () => false,
    piSessionDirectory: () => join(home, 'pi'),
    updateIssueSettings: async change => change(settings),
  };
  const result = await importAgentSession({ agent: 'claude', source: CLAUDE_ID, project: { slug: 'app', name: 'App' }, sessionId: 'issue-1', divernote, env });
  const copy = join(home, '.claude', 'projects', worktree.replace(/[^A-Za-z0-9]/g, '-'), `${claudeSessionId('issue-1')}.jsonl`);
  const entry = JSON.parse(await readFile(copy, 'utf8'));
  assert.equal(entry.cwd, worktree);
  assert.equal(entry.sessionId, claudeSessionId('issue-1'));
  assert.deepEqual(settings.issues['issue-1'], { agent: 'claude' });
  assert.equal(result.agent, 'claude');
  assert.equal(released, true);
  assert.match(await readFile(join(claude, `${CLAUDE_ID}.jsonl`), 'utf8'), /"cwd":"\/old"/, 'the original is untouched');
  await assert.rejects(importAgentSession({ agent: 'claude', source: CLAUDE_ID, project: { slug: 'app' }, sessionId: 'issue-1', divernote: { ...divernote, hasPiSession: async () => true }, env }), /already has a conversation/);
  await assert.rejects(importAgentSession({ agent: 'claude', source: CLAUDE_ID, project: { slug: 'app' }, sessionId: 'issue-1', divernote: { ...divernote, tryAcquireIdlePiSession: async () => null }, env }), /is running/);
});
