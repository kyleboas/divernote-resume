import { importAgentSession } from './import.mjs';

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const USAGE = 'Usage: divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]';

function parseOptions(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (options.json) throw new Error('Duplicate --json.');
      options.json = true;
      continue;
    }
    if (!['--session-id', '--from', '--source'].includes(flag) || index + 1 >= argv.length) throw new Error(USAGE);
    const name = flag.slice(2);
    if (options[name] !== undefined) throw new Error(`Duplicate ${flag}.`);
    options[name] = argv[++index];
  }
  for (const name of ['session-id', 'from', 'source']) {
    if (typeof options[name] !== 'string' || !options[name].trim()) throw new Error(`--${name} is required. ${USAGE}`);
  }
  if (!REFERENCE.test(options['session-id'])) throw new Error('--session-id is invalid.');
  return options;
}

export async function runPiImportCli(argv, {
  env = process.env,
  stdout = text => process.stdout.write(text),
  divernote,
  importSession = importAgentSession,
} = {}) {
  const options = parseOptions(argv);
  const { client } = await divernote.openVault({ env });
  const data = await client.readProjects();
  const matches = [];
  for (const project of Array.isArray(data?.projects) ? data.projects : []) {
    for (const task of Array.isArray(project?.tasks) ? project.tasks : []) {
      if (task?.workItem?.sessionId === options['session-id']) matches.push({ project, task, item: task.workItem });
    }
  }
  if (matches.length !== 1) throw new Error('The Divernote issue was not found.');
  const { project, task, item } = matches[0];
  if (task.completed || !item.agent || item.state === 'closed') throw new Error('A closed Divernote issue cannot take a conversation.');
  if (item.state === 'working') throw new Error('The issue is running. Stop it before importing a conversation.');
  const imported = await importSession({ agent: options.from, source: options.source, project, sessionId: item.sessionId, divernote, env });
  const output = { status: 'imported', project: project.slug, taskId: task.id, sessionId: item.sessionId, agent: imported.agent };
  if (options.json) stdout(`${JSON.stringify(output)}\n`);
  else stdout(`imported: ${output.project}/${output.taskId} now continues the ${output.agent} conversation. Send a message to resume it.\n`);
  return 0;
}
