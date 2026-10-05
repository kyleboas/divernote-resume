# divernote-resume

A Divernote extension that continues a Claude Code or Pi conversation in a Divernote issue.

```bash
divernote install git:github.com/kyleboas/divernote-resume
divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]
```

`--source` is a session ID looked up in that agent's own store on this computer, or an absolute path to the session's `.jsonl` file. The conversation is copied into the issue's worktree under the issue's session ID and the issue is switched to the agent that wrote it; the original is untouched. Import refuses an issue that is working, closed, or already has a conversation.

## Hand an issue to another agent

A message in an issue that opens with an installed agent's name hands the issue to that agent, optionally with a model and effort:

```text
claude fix the export
pi sol high check the tests again
```

Before the next run, the agent that had the issue summarizes the conversation in a throwaway fork of its session (`claude -p --resume … --fork-session --no-session-persistence`, or `pi --print --fork …` into a temporary folder). The new agent gets that summary, the path of the full transcript, and the message. Divernote keeps the new agent for the issue.

Needs a Divernote version with extension commands (`registerCommand`). Handoffs need the `issue-run` hook; on an older Divernote only `pi-import` loads.

## Test

```bash
npm test
```
