# divernote-resume

A Divernote extension that continues a Claude Code or Pi conversation in a Divernote issue.

```bash
divernote install git:github.com/kyleboas/divernote-resume
divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]
```

`--source` is a session ID looked up in that agent's own store on this computer, or an absolute path to the session's `.jsonl` file. The conversation is copied into the issue's worktree under the issue's session ID and the issue is switched to the agent that wrote it; the original is untouched. Import refuses an issue that is working, closed, or already has a conversation.

Needs a Divernote version with extension commands (`registerCommand`).

## Test

```bash
npm test
```
