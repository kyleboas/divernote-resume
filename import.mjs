// Continuing a conversation started outside Divernote in an issue: a Claude
// Code or Pi session is copied into the issue's own worktree session store,
// under the issue's session ID, so the issue's next run resumes it.

import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SOURCE_LIMIT = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Claude Code's side of an issue's session, as Divernote's worker names it:
// an ID that is not a UUID always maps to the same one derived from it.
function claudeSessionId(sessionId) {
  const value = String(sessionId ?? '');
  if (UUID.test(value)) return value.toLowerCase();
  const hex = createHash('sha256').update(`divernote:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function claudeConfigDirectory(env) {
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && isAbsolute(env.CLAUDE_CONFIG_DIR)) return env.CLAUDE_CONFIG_DIR;
  return typeof env.HOME === 'string' && isAbsolute(env.HOME) ? join(env.HOME, '.claude') : undefined;
}

function claudeTranscriptPath(cwd, sessionId, env) {
  const directory = claudeConfigDirectory(env);
  if (!directory || !isAbsolute(String(cwd ?? ''))) return undefined;
  return join(directory, 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${claudeSessionId(sessionId)}.jsonl`);
}

export { claudeSessionId };
export const IMPORT_AGENTS = Object.freeze(['claude', 'pi']);

async function regularFile(path) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return (uid === undefined || info.uid === uid) && info.size <= SOURCE_LIMIT;
}

async function fileNamed(directory, matches) {
  const found = [];
  for (const folder of await readdir(directory).catch(() => [])) {
    for (const name of await readdir(join(directory, folder)).catch(() => [])) {
      if (matches(name)) found.push(join(directory, folder, name));
    }
  }
  return found;
}

/**
 * The session file a reference names: an absolute path to a JSONL file, or a
 * session ID looked up in the agent's own store. An ID kept by more than one
 * project is ambiguous and must be given as a path.
 */
export async function findSessionSource(agent, reference, { env = process.env } = {}) {
  const value = String(reference ?? '').trim();
  if (!value) throw new Error('--source is required.');
  if (isAbsolute(value)) {
    if (!value.endsWith('.jsonl') || !await regularFile(value)) throw new Error('The session file could not be read.');
    return value;
  }
  if (!REFERENCE.test(value)) throw new Error('--source must be a session ID or an absolute path.');
  let candidates;
  if (agent === 'claude') {
    const config = claudeConfigDirectory(env);
    if (!config || !UUID.test(value)) throw new Error('A Claude Code session ID is a UUID.');
    candidates = await fileNamed(join(config, 'projects'), name => name === `${value.toLowerCase()}.jsonl`);
  } else {
    const home = env.PI_CODING_AGENT_SESSION_DIR || join(env.PI_CODING_AGENT_DIR || join(env.HOME ?? '', '.pi', 'agent'), 'sessions');
    if (!isAbsolute(home)) throw new Error('Pi session storage could not be found.');
    candidates = await fileNamed(home, name => name.endsWith(`_${value}.jsonl`));
  }
  const readable = [];
  for (const path of candidates) if (await regularFile(path)) readable.push(path);
  if (readable.length === 0) throw new Error('The session was not found on this device.');
  if (readable.length > 1) throw new Error('The session ID matches more than one file. Pass --source as a path.');
  return readable[0];
}

function lines(text) {
  return text.split('\n').filter(line => line.trim());
}

/** A Claude Code transcript with its session and folder pointing at the issue. */
export function rewriteClaudeTranscript(text, { sessionId, cwd }) {
  const id = claudeSessionId(sessionId);
  const out = lines(text).map(line => {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error('The Claude Code session is not valid JSONL.'); }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if ('sessionId' in entry) entry.sessionId = id;
      if ('cwd' in entry) entry.cwd = cwd;
      return JSON.stringify(entry);
    }
    return line;
  });
  if (!out.length) throw new Error('The Claude Code session is empty.');
  return `${out.join('\n')}\n`;
}

/** A Pi session with its header pointing at the issue. */
export function rewritePiSession(text, { sessionId, cwd }) {
  const [first, ...rest] = lines(text);
  let header;
  try { header = JSON.parse(first ?? ''); } catch { header = undefined; }
  if (header?.type !== 'session' || typeof header.id !== 'string') throw new Error('The Pi session has no header.');
  return `${[JSON.stringify({ ...header, id: sessionId, cwd }), ...rest].join('\n')}\n`;
}

async function writeNew(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    // A session that appeared meanwhile must not be replaced.
    if (await lstat(path).then(() => true, () => false)) throw new Error('The issue already has a conversation.');
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Copy `source` into the issue. Refuses an issue that already has a
 * conversation, or one that a run currently holds.
 */
export async function importAgentSession({ agent, source, project, sessionId, divernote, env = process.env }) {
  const { hasPiSession, piSessionDirectory, resolvePiProject, tryAcquireIdlePiSession, updateIssueSettings } = divernote;
  if (!IMPORT_AGENTS.includes(agent)) throw new Error('--from must be claude or pi.');
  if (!REFERENCE.test(String(sessionId ?? ''))) throw new Error('Pi session ID is invalid.');
  const path = await findSessionSource(agent, source, { env });
  const text = await readFile(path, 'utf8');
  const release = await tryAcquireIdlePiSession(sessionId, { env });
  if (!release) throw new Error('The issue is running. Stop it before importing a conversation.');
  try {
    const cwd = await resolvePiProject(project.slug, { env, projectName: project.name, sessionId });
    if (await hasPiSession(cwd, sessionId, { env })) throw new Error('The issue already has a conversation.');
    if (agent === 'claude') {
      const target = claudeTranscriptPath(cwd, sessionId, env);
      if (!target) throw new Error('Claude Code storage could not be found.');
      await writeNew(target, rewriteClaudeTranscript(text, { sessionId, cwd }));
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeNew(join(piSessionDirectory(cwd, env), `${stamp}_${sessionId}.jsonl`), rewritePiSession(text, { sessionId, cwd }));
    }
    // The next run resumes the copy with the agent that wrote it.
    await updateIssueSettings(settings => {
      settings.issues[sessionId] = { ...(settings.issues[sessionId] ?? {}), agent };
    }, { env });
    return { agent, cwd, source: basename(path) };
  } finally {
    await release();
  }
}
