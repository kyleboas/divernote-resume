// Continue a Claude Code or Pi conversation in a Divernote issue:
//   divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]
export default divernote => {
  divernote.registerCommand('pi-import', async ({ argv, ...context }) => {
    const { runPiImportCli } = await import('./command.mjs');
    return runPiImportCli(argv, context);
  });
};
