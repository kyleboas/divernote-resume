import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handOffIssueRun, handoffPrompt, parseHandoff, SUMMARY_PROMPT } from './handoff.mjs';

const AGENTS = [
  { id: 'pi', label: 'pi', efforts: ['low', 'medium', 'high'], models: ['openai/sol'] },
  { id: 'claude', label: 'claude', efforts: ['low', 'medium', 'high'], models: ['claude-opus-5-5', 'claude-sonnet-5'] },
];
const ALIASES = { pi: 'pi', claude: 'claude', cc: 'claude' };

function helpers(home) {
  return {
    codingAgentForWord: word => (ALIASES[String(word).toLowerCase()] ? { id: ALIASES[String(word).toLowerCase()] } : undefined),
    modelForWord: (models, word) => models.find(model => model.split(/[-/]/).includes(String(word).toLowerCase())),
    effortForWord: (efforts, word) => efforts.find(effort => effort === String(word).toLowerCase()),
    claudeSessionId: id => `uuid-${id}`,
    claudeTranscriptPath: (cwd, id) => join(home, 'claude', `${id}.jsonl`),
    piSessionFile: async (cwd, id) => join(home, 'pi', `t_${id}.jsonl`),
  };
}

test('a message names the agent, then its model and effort, before the text', () => {
  const words = helpers('/h');
  assert.deepEqual(parseHandoff('claude opus high fix the export', AGENTS, words), { agent: 'claude', model: 'claude-opus-5-5', thinking: 'high', text: 'fix the export' });
  assert.deepEqual(parseHandoff('CC  take it from here', AGENTS, words), { agent: 'claude', text: 'take it from here' });
  assert.deepEqual(parseHandoff('pi high', AGENTS, words), { agent: 'pi', text: 'high' }, 'the message itself is never used up');
  assert.equal(parseHandoff('claude', AGENTS, words), undefined);
  assert.equal(parseHandoff('codex fix it', AGENTS, words), undefined);
  assert.equal(parseHandoff('please ask claude', AGENTS, words), undefined);
});

test('another agent gets the old agent\'s summary, from a throwaway fork, with the message', async () => {
  const home = await mkdtemp(join(tmpdir(), 'handoff-'));
  await mkdir(join(home, 'pi'));
  await writeFile(join(home, 'pi', 't_issue-1.jsonl'), '{}\n');
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return '- Fixed the parser\n- Tests pending'; };
  const change = await handOffIssueRun({ agent: 'pi', prompt: 'claude sonnet finish the tests', sessionId: 'issue-1', cwd: '/work', agents: AGENTS }, helpers(home), { env: { HOME: home }, run });
  assert.equal(change.agent, 'claude');
  assert.equal(change.model, 'claude-sonnet-5');
  assert.match(change.prompt, /^\[Handoff from Pi\]/);
  assert.match(change.prompt, /- Fixed the parser\n- Tests pending/);
  assert.match(change.prompt, new RegExp(`transcript is at ${join(home, 'pi', 't_issue-1.jsonl')}`));
  assert.match(change.prompt, /The user's message:\n\nfinish the tests$/);
  assert.equal(calls[0].command, 'pi');
  assert.deepEqual(calls[0].args.slice(0, 2), ['--print', '--fork']);
  assert.ok(calls[0].args.includes('--session-dir') && calls[0].args.includes('--no-tools'));
  assert.equal(calls[0].args.at(-1), SUMMARY_PROMPT);
  assert.equal(calls[0].options.cwd, '/work');
});

test('Claude Code summarizes in a fork it never saves', async () => {
  const home = await mkdtemp(join(tmpdir(), 'handoff-'));
  await mkdir(join(home, 'claude'));
  await writeFile(join(home, 'claude', 'issue-1.jsonl'), '{}\n');
  const calls = [];
  const change = await handOffIssueRun({ agent: 'claude', prompt: 'pi go on', sessionId: 'issue-1', cwd: '/work', agents: AGENTS }, helpers(home), {
    env: { HOME: home, CLAUDECODE: '1' }, run: async (command, args, options) => { calls.push({ command, args, options }); return 'summary'; },
  });
  assert.equal(change.agent, 'pi');
  assert.deepEqual(calls[0].args, ['-p', SUMMARY_PROMPT, '--resume', 'uuid-issue-1', '--fork-session', '--no-session-persistence', '--tools', '']);
  assert.equal(calls[0].options.env.CLAUDECODE, undefined);
});

test('a failed summary still hands over, pointing at the transcript; no conversation hands over the message alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'handoff-'));
  await mkdir(join(home, 'pi'));
  await writeFile(join(home, 'pi', 't_issue-1.jsonl'), '{}\n');
  const errors = [];
  const failed = await handOffIssueRun({ agent: 'pi', prompt: 'claude go on', sessionId: 'issue-1', cwd: '/work', agents: AGENTS }, helpers(home), {
    env: {}, run: async () => { throw new Error('pi could not summarize'); }, onError: error => errors.push(error.message),
  });
  assert.equal(failed.agent, 'claude');
  assert.match(failed.prompt, /Pi could not summarize the conversation\./);
  assert.match(failed.prompt, /transcript is at/);
  assert.deepEqual(errors, ['pi could not summarize']);
  const fresh = await handOffIssueRun({ agent: 'pi', prompt: 'claude go on', sessionId: 'issue-2', cwd: '/work', agents: AGENTS }, helpers(home), { env: {}, run: async () => assert.fail('nothing to summarize') });
  assert.deepEqual(fresh, { agent: 'claude', model: undefined, thinking: undefined, prompt: 'go on' });
});

test('naming the current agent changes only its model or effort, and plain messages run as they are', async () => {
  const words = helpers('/nowhere');
  const run = async () => assert.fail('no summary for the same agent');
  assert.deepEqual(await handOffIssueRun({ agent: 'claude', prompt: 'claude high dig deeper', agents: AGENTS }, words, { run }), { model: undefined, thinking: 'high', prompt: 'dig deeper' });
  assert.equal(await handOffIssueRun({ agent: 'claude', prompt: 'claude is wrong here', agents: AGENTS }, words, { run }), undefined);
  assert.equal(await handOffIssueRun({ agent: 'pi', prompt: 'fix the export', agents: AGENTS }, words, { run }), undefined);
});

test('the handoff names who handed over', () => {
  assert.match(handoffPrompt({ from: 'claude', summary: 's', path: '/p', text: 't' }), /^\[Handoff from Claude Code\]/);
});
