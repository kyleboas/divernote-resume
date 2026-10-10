// Moving a conversation that is open right now into a new Divernote issue:
//   divernote pi-move --from <claude|pi> [--source <session-id-or-path>] [--project <slug>] [--title <text>] [--json]
// The issue is filed in review, so the worker leaves it alone until the user
// sends it a message, and the next run resumes the moved conversation.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { findSessionSource, importAgentSession, IMPORT_AGENTS } from './import.mjs';

const run = promisify(execFile);
const USAGE = 'Usage: divernote pi-move --from <claude|pi> [--source <session-id-or-path>] [--project <slug>] [--title <text>] [--json]';
const TITLE_LIMIT = 120;

function parseOptions(argv) {
  const options = { json: false, rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (options.json) throw new Error('Duplicate --json.');
      options.json = true;
      continue;
    }
    if (!flag.startsWith('--')) {
      options.rest.push(flag);
      continue;
    }
    if (!['--from', '--source', '--project', '--title'].includes(flag) || index + 1 >= argv.length) throw new Error(USAGE);
    const name = flag.slice(2);
    if (options[name] !== undefined) throw new Error(`Duplicate ${flag}.`);
    options[name] = argv[++index];
  }
  // "/divernote myproject fix the export" from inside a session: a project, then a title.
  if (options.rest.length) {
    if (options.project === undefined) options.project = options.rest.shift();
    if (options.title === undefined && options.rest.length) options.title = options.rest.join(' ');
    else if (options.rest.length) throw new Error(USAGE);
  }
  if (!IMPORT_AGENTS.includes(options.from)) throw new Error(`--from must be claude or pi. ${USAGE}`);
  return options;
}

/** The session this command was run from, when it was run inside Claude Code. */
function currentSource(agent, env) {
  if (agent === 'claude' && env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  throw new Error(`--source is required outside a ${agent === 'claude' ? 'Claude Code' : 'Pi'} session.`);
}

function oneLine(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : line;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' ');
}

/** Where a conversation ran and what it was first asked, read from its transcript. */
export function describeSession(agent, text) {
  let cwd;
  let name;
  let first;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (agent === 'claude') {
      cwd ??= typeof entry.cwd === 'string' ? entry.cwd : undefined;
      // Slash commands, their output and tool results are not what the user asked.
      if (first === undefined && entry.type === 'user' && !entry.isMeta && entry.message?.role === 'user') {
        const said = textOf(entry.message.content).trim();
        if (said && !said.startsWith('<')) first = said;
      }
    } else {
      if (entry.type === 'session') cwd ??= typeof entry.cwd === 'string' ? entry.cwd : undefined;
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) name = entry.name;
      if (first === undefined && entry.type === 'message' && entry.message?.role === 'user') {
        const said = textOf(entry.message.content).trim();
        if (said) first = said;
      }
    }
  }
  return { cwd, title: oneLine(name ?? first) };
}

async function gitCommonDirectory(cwd) {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 10_000 });
    return resolve(stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * The project whose repository the conversation ran in: the same folder, a
 * folder inside it, or one of its worktrees.
 */
export async function projectForFolder(projects, cwd, { divernote, env, commonDirectory = gitCommonDirectory }) {
  if (!cwd) return undefined;
  const common = await commonDirectory(cwd);
  const found = [];
  for (const project of projects) {
    let repository;
    try { repository = await divernote.resolvePiProject(project.slug, { env, projectName: project.name }); } catch { continue; }
    const inside = cwd === repository || cwd.startsWith(`${repository}/`);
    if (inside || (common && common === await commonDirectory(repository))) found.push(project);
  }
  return found.length === 1 ? found[0] : undefined;
}

export async function runPiMoveCli(argv, {
  env = process.env,
  stdout = text => process.stdout.write(text),
  divernote,
  importSession = importAgentSession,
  findProject = projectForFolder,
} = {}) {
  const options = parseOptions(argv);
  const agent = options.from;
  const path = await findSessionSource(agent, options.source ?? currentSource(agent, env), { env });
  const session = describeSession(agent, await readFile(path, 'utf8'));
  const title = oneLine(options.title) || session.title;
  if (!title) throw new Error('The conversation has nothing to name the issue by. Pass --title.');

  const { client } = await divernote.openVault({ env });
  try {
    const data = await client.readProjects();
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    let project;
    if (options.project !== undefined) {
      project = projects.find(item => item?.slug === options.project);
      if (!project) throw new Error(`No project is called "${options.project}".`);
    } else {
      project = await findProject(projects, session.cwd, { divernote, env });
      if (!project) throw new Error(`No one project holds ${session.cwd ?? 'this conversation'}. Pass --project.`);
    }

    // The conversation goes into the issue's worktree before the issue
    // exists, so nothing can start the issue without it.
    const prepared = divernote.prepareIssue(title, { initialState: 'review' });
    const imported = await importSession({ agent, source: path, project, sessionId: prepared.id, divernote, env });
    await divernote.addIssue(client, project.id, prepared);

    const output = { status: 'moved', project: project.slug, taskId: prepared.id, sessionId: prepared.id, agent: imported.agent, title, worktree: imported.cwd, from: session.cwd };
    if (options.json) stdout(`${JSON.stringify(output)}\n`);
    else {
      stdout(`Moved to ${project.name}: ${title}\n`);
      stdout(`The issue continues this ${agent === 'claude' ? 'Claude Code' : 'Pi'} conversation in ${imported.cwd}. Send it a message to pick it up.\n`);
      if (session.cwd && resolve(session.cwd) !== resolve(imported.cwd)) stdout(`Changes not committed in ${session.cwd} stay there.\n`);
    }
    return 0;
  } finally {
    await client.close?.()?.catch?.(() => undefined);
  }
}
