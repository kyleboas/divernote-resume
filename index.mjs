// Continue a Claude Code or Pi conversation in a Divernote issue:
//   divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]
// and hand an issue to another agent mid-conversation with a message that
// opens with its name: "claude fix the export".
export default divernote => {
  divernote.registerCommand('pi-import', async ({ argv, ...context }) => {
    const { runPiImportCli } = await import('./command.mjs');
    return runPiImportCli(argv, context);
  });
  // A Divernote without the issue-run hook still gets pi-import.
  try {
    divernote.on('issue-run', async (run, helpers) => {
      const { handOffIssueRun } = await import('./handoff.mjs');
      return handOffIssueRun(run, helpers);
    });
  } catch { /* no hand-offs on this Divernote */ }
};
