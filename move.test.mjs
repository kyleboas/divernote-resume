import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeSession, projectForFolder, runPiMoveCli } from './move.mjs';

const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const line = value => JSON.stringify(value);

test('a Claude Code conversation is named by what the user first asked, past commands and tool results', () => {
  const text = [
    line({ type: 'user', isMeta: true, cwd: '/code/app', message: { role: 'user', content: 'caveat' } }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the\n export   button' }] } }),
    line({ type: 'user', message: { role: 'user', content: 'later' } }),
  ].join('\n');
  assert.deepEqual(describeSession('claude', text), { cwd: '/code/app', title: 'fix the export button' });
});

test('a Pi conversation is named by its session name, else what the user first asked', () => {
  const header = line({ type: 'session', id: 'p', cwd: '/code/app' });
  const asked = line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(300) }] } });
  const plain = describeSession('pi', `${header}\n${asked}\n`);
  assert.equal(plain.cwd, '/code/app');
  assert.equal(plain.title.length, 120);
  assert.ok(plain.title.endsWith('…'));
  assert.equal(describeSession('pi', `${header}\n${line({ type: 'session_info', name: 'Export fix' })}\n${asked}\n`).title, 'Export fix');
});

test('a folder belongs to the one project whose repository holds it or shares its git store', async () => {
  const projects = [{ slug: 'app', name: 'App' }, { slug: 'web', name: 'Web' }, { slug: 'gone', name: 'Gone' }];
  const repositories = { app: '/code/app', web: '/code/web' };
  const divernote = { resolvePiProject: async slug => { if (!repositories[slug]) throw new Error('none'); return repositories[slug]; } };
  const commonDirectory = async cwd => (cwd.startsWith('/code/app') || cwd.startsWith('/wt/app') ? '/code/app/.git' : undefined);
  const find = cwd => projectForFolder(projects, cwd, { divernote, env: {}, commonDirectory });
  assert.equal((await find('/code/app/src'))?.slug, 'app');
  assert.equal((await find('/wt/app/feature'))?.slug, 'app');
  assert.equal(await find('/elsewhere'), undefined);
  assert.equal(await find(undefined), undefined);
});

async function claudeHome(content) {
  const home = await mkdtemp(join(tmpdir(), 'move-'));
  const folder = join(home, '.claude', 'projects', '-code-app');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${CLAUDE_ID}.jsonl`), content);
  return home;
}

function fakeDivernote(calls, projects = [{ id: 'project-1', slug: 'app', name: 'App' }]) {
  const project = projects[0];
  const client = { readProjects: async () => ({ projects }), close: async () => { calls.push('close'); } };
  return {
    project,
    divernote: {
      openVault: async () => ({ client }),
      prepareIssue: (text, options) => { calls.push(['prepare', text, options]); return { id: 'issue-9', title: text }; },
      addIssue: async (given, projectId, prepared) => { assert.equal(given, client); calls.push(['add', projectId, prepared.id]); },
    },
  };
}

test('the open Claude Code session moves into a new issue filed in review, after its conversation is in place', async () => {
  const home = await claudeHome(`${line({ type: 'user', cwd: '/code/app', message: { role: 'user', content: 'fix the export' } })}\n`);
  const calls = [];
  const { divernote, project } = fakeDivernote(calls);
  let output = '';
  const code = await runPiMoveCli(['--from', 'claude', '--json'], {
    env: { HOME: home, CLAUDE_CODE_SESSION_ID: CLAUDE_ID },
    stdout: text => { output += text; },
    divernote,
    findProject: async (_projects, cwd) => (cwd === '/code/app' ? project : undefined),
    importSession: async ({ agent, source, sessionId }) => {
      calls.push(['import', agent, source.endsWith(`${CLAUDE_ID}.jsonl`), sessionId]);
      return { agent, cwd: '/wt/app/issue-9' };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ['prepare', 'fix the export', { initialState: 'review' }],
    ['import', 'claude', true, 'issue-9'],
    ['add', 'project-1', 'issue-9'],
    'close',
  ]);
  assert.deepEqual(JSON.parse(output), { status: 'moved', project: 'app', taskId: 'issue-9', sessionId: 'issue-9', agent: 'claude', title: 'fix the export', worktree: '/wt/app/issue-9', from: '/code/app' });
});

test('a project and title can be named, and a failed import files no issue', async () => {
  const home = await claudeHome(`${line({ type: 'user', cwd: '/nowhere', message: { role: 'user', content: 'hi' } })}\n`);
  const env = { HOME: home };
  const calls = [];
  const { divernote } = fakeDivernote(calls);
  let output = '';
  await runPiMoveCli(['--from', 'claude', '--source', CLAUDE_ID, 'app', 'Export', 'fix'], {
    env, stdout: text => { output += text; }, divernote,
    importSession: async ({ agent }) => ({ agent, cwd: '/wt/app/issue-9' }),
  });
  assert.deepEqual(calls[0], ['prepare', 'Export fix', { initialState: 'review' }]);
  assert.match(output, /^Moved to App: Export fix\n.*Send it a message.*\nChanges not committed in \/nowhere stay there\.\n$/s);

  calls.length = 0;
  await assert.rejects(runPiMoveCli(['--from', 'claude', '--source', CLAUDE_ID], { env, divernote, findProject: async () => undefined }), /No one project holds \/nowhere\. Pass --project/);
  await assert.rejects(runPiMoveCli(['--from', 'claude', '--source', CLAUDE_ID, '--project', 'nope'], { env, divernote }), /No project is called "nope"/);
  await assert.rejects(runPiMoveCli(['--from', 'claude', '--source', CLAUDE_ID, 'app'], {
    env, divernote, importSession: async () => { throw new Error('The issue already has a conversation.'); },
  }), /already has a conversation/);
  assert.equal(calls.some(call => call[0] === 'add'), false);
});

test('a renamed project moves by display name, ID, or durable slug without changing its identity', async () => {
  const home = await claudeHome(`${line({ type: 'user', cwd: '/code/app', message: { role: 'user', content: 'fix export' } })}\n`);
  const project = { id: 'project-1', slug: 'sporting-director', name: 'Libero' };
  for (const reference of ['libero', 'Libero', 'LIBERO', project.id, project.slug]) {
    const calls = [];
    const { divernote } = fakeDivernote(calls, [project]);
    let output = '';
    await runPiMoveCli(['--from', 'claude', '--source', CLAUDE_ID, reference, '--json'], {
      env: { HOME: home }, divernote, stdout: text => { output += text; },
      importSession: async ({ project: selected, agent }) => {
        assert.equal(selected, project);
        return { agent, cwd: '/wt/sporting-director/issue-9' };
      },
    });
    assert.equal(JSON.parse(output).project, 'sporting-director');
    assert.ok(calls.some(call => call[0] === 'add' && call[1] === project.id));
  }
});

test('ambiguous names fail before importing, while exact stable references take precedence', async () => {
  const home = await claudeHome(`${line({ type: 'user', message: { role: 'user', content: 'fix export' } })}\n`);
  const projects = [
    { id: 'project-1', slug: 'sporting-director', name: 'Libero' },
    { id: 'project-2', slug: 'other', name: 'LIBERO' },
  ];
  const calls = [];
  const { divernote } = fakeDivernote(calls, projects);
  const args = ['--from', 'claude', '--source', CLAUDE_ID, '--project', 'libero'];
  await assert.rejects(runPiMoveCli(args, { env: { HOME: home }, divernote }), /More than one project is called "libero"/);
  assert.deepEqual(calls, ['close']);
  projects[0].slug = 'libero';
  await runPiMoveCli(args, {
    env: { HOME: home }, divernote, stdout: () => {},
    importSession: async ({ project, agent }) => {
      assert.equal(project, projects[0]);
      return { agent, cwd: '/wt/libero/issue-9' };
    },
  });
});

test('outside a session the source must be given', async () => {
  await assert.rejects(runPiMoveCli(['--from', 'pi'], { env: {}, divernote: {} }), /--source is required outside a Pi session/);
  await assert.rejects(runPiMoveCli(['--from', 'codex'], { env: {}, divernote: {} }), /--from must be claude or pi/);
});
