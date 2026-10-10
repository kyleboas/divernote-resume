// Continue a Claude Code or Pi conversation in a Divernote issue:
//   divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]
// move one that is still open into a new issue:
//   divernote pi-move --from <claude|pi> [--source …] [--project <slug>] [--title <text>]
// and hand an issue to another agent mid-conversation with a message that
// opens with its name: "claude fix the export".
export default divernote => {
  divernote.registerCommand('pi-import', async ({ argv, ...context }) => {
    const { runPiImportCli } = await import('./command.mjs');
    return runPiImportCli(argv, context);
  });
  // Move the conversation open right now into a new issue: /divernote in Claude Code or Pi runs it.
  divernote.registerCommand('pi-move', async ({ argv, ...context }) => {
    const { runPiMoveCli } = await import('./move.mjs');
    return runPiMoveCli(argv, context);
  });
  // A Divernote without the issue-run hook still gets pi-import.
  try {
    divernote.on('issue-run', async (run, helpers) => {
      const { handOffIssueRun } = await import('./handoff.mjs');
      return handOffIssueRun(run, helpers);
    });
  } catch { /* no hand-offs on this Divernote */ }
};
