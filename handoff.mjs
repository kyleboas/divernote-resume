// Handing an issue to another coding agent mid-conversation. A message that
// opens with an agent's name ("claude fix the export", "pi sol high check
// the tests") moves the issue to that agent. The agent that had it first
// summarizes the conversation in a throwaway fork of its session, so its own
// session is untouched, and the new agent gets that summary with the message.

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUMMARY_LIMIT = 16_000;
const SUMMARY_TIMEOUT_MS = 5 * 60_000;
const NAMES = { pi: 'Pi', claude: 'Claude Code' };

export const SUMMARY_PROMPT = [
  'Another coding agent is taking over this conversation from you. Write the handoff it needs to continue without asking the user again.',
  'Cover: what the user wants; what has been done (files changed, commands run, branches, pull requests); decisions made and why; what is in progress or left to do; open questions.',
  'Be concrete and brief, in short bullet points. Reply with the handoff only.',
].join('\n');

function agentName(id) {
  return NAMES[id] ?? `${String(id).charAt(0).toUpperCase()}${String(id).slice(1)}`;
}

/**
 * The agent, model and effort a message's leading words name, and the rest of
 * it, read the way an issue's own first words are: "claude opus high fix it".
 * Each word needs words after it, so the message itself is never used up.
 */
export function parseHandoff(prompt, agents, { codingAgentForWord, modelForWord, effortForWord }) {
  const value = String(prompt ?? '');
  const words = [...value.matchAll(/\S+/g)];
  const agent = (Array.isArray(agents) ? agents : []).find(choice => choice.id === codingAgentForWord(words[0]?.[0])?.id);
  if (!agent || words.length < 2) return undefined;
  let used = 1;
  const model = words.length > used + 1 ? modelForWord(agent.models, words[used][0]) : undefined;
  if (model) used += 1;
  const thinking = words.length > used + 1 ? effortForWord(agent.efforts, words[used][0]) : undefined;
  if (thinking) used += 1;
  const last = words[used - 1];
  return { agent: agent.id, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), text: value.slice(last.index + last[0].length).trim() };
}

async function exists(path) {
  return Boolean(path) && access(path).then(() => true, () => false);
}

/** Variables a surrounding Claude Code session sets for its children stop a nested one from resuming. */
function claudeEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(name)));
}

/** Run a command to completion and return what it printed, or throw. */
export function runCommand(command, args, { cwd, env, timeoutMs = SUMMARY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < SUMMARY_LIMIT * 4) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 4_000) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`${command} could not summarize the conversation${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : '.'}`));
    });
  });
}

/**
 * Where the outgoing agent keeps the issue's conversation, and how to ask a
 * throwaway fork of it for a summary. Undefined when it has none yet.
 */
async function summarySource(agent, { cwd, sessionId }, divernote, env) {
  if (agent === 'claude') {
    const path = divernote.claudeTranscriptPath(cwd, sessionId, env);
    if (!await exists(path)) return undefined;
    return {
      path,
      // The prompt goes first: --tools takes every word after it.
      summarize: run => run('claude', ['-p', SUMMARY_PROMPT, '--resume', divernote.claudeSessionId(sessionId), '--fork-session', '--no-session-persistence', '--tools', ''], { cwd, env: claudeEnvironment(env) }),
    };
  }
  if (agent === 'pi') {
    const path = await divernote.piSessionFile(cwd, sessionId, env);
    if (!await exists(path)) return undefined;
    return {
      path,
      // Pi cannot fork without saving, so the fork is saved somewhere thrown away.
      summarize: async run => {
        const scratch = await mkdtemp(join(tmpdir(), 'divernote-handoff-'));
        try {
          return await run('pi', ['--print', '--fork', path, '--session-dir', scratch, '--no-tools', SUMMARY_PROMPT], { cwd, env });
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      },
    };
  }
  return undefined;
}

/** The new agent's first turn: what the old one handed over, then the user's message. */
export function handoffPrompt({ from, summary, path, text }) {
  const name = agentName(from);
  return [
    `[Handoff from ${name}] ${name} has been working on this issue. You are taking over from here.`,
    summary ? `${name}'s summary of the conversation so far:\n\n${summary.slice(0, SUMMARY_LIMIT)}` : `${name} could not summarize the conversation.`,
    `${name}'s full transcript is at ${path}; read it if you need more detail.`,
    `The user's message:\n\n${text}`,
  ].join('\n\n');
}

/**
 * The issue-run hook: a message naming another agent moves the issue to it
 * with a handoff. One naming the current agent with a model or effort only
 * changes those. Anything else runs as it is.
 */
export async function handOffIssueRun(run, divernote, { env = process.env, run: runImpl = runCommand, onError = error => process.stderr.write(`${error.message}\n`) } = {}) {
  const handoff = parseHandoff(run.prompt, run.agents, divernote);
  if (!handoff || !handoff.text) return undefined;
  const { agent, model, thinking, text } = handoff;
  if (agent === run.agent) return model || thinking ? { model, thinking, prompt: text } : undefined;
  const source = await summarySource(run.agent, run, divernote, env);
  if (!source) return { agent, model, thinking, prompt: text };
  let summary;
  try {
    summary = await source.summarize(runImpl);
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
  return { agent, model, thinking, prompt: handoffPrompt({ from: run.agent, summary, path: source.path, text }) };
}
