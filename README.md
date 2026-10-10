# divernote-resume

A Divernote extension that continues a Claude Code or Pi conversation in a Divernote issue, including one that is still open.

```bash
divernote install git:github.com/kyleboas/divernote-resume
divernote pi-import --session-id <issue-id> --from <claude|pi> --source <session-id-or-path> [--json]
```

`--source` is a session ID looked up in that agent's own store on this computer, or an absolute path to the session's `.jsonl` file. The conversation is copied into the issue's worktree under the issue's session ID and the issue is switched to the agent that wrote it; the original is untouched. Import refuses an issue that is working, closed, or already has a conversation.

## Move an open conversation into a new issue

Type `/divernote` inside a Claude Code or Pi session to move that conversation into a new Divernote issue:

```text
/divernote                      # project from this folder, title from your first message
/divernote myproject            # name the project
/divernote myproject Fix export # and the title
```

The conversation is copied into the new issue's worktree. The issue is then filed in Review, so nothing runs until you send it a message, and that message resumes the conversation with the same agent. Pi closes the old session for you. In Claude Code, `/exit` once it says the conversation moved. Changes you haven't committed stay in the folder you were working in.

Set up the commands once:

```bash
P=~/.config/divernotes/git/github.com/kyleboas/divernote-resume
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands" ~/.pi/agent/extensions
ln -sf "$P/agents/divernote.md" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands/divernote.md"
ln -sf "$P/agents/divernote.ts" ~/.pi/agent/extensions/divernote-move.ts
```

From a shell, the same move is:

```bash
divernote pi-move --from <claude|pi> --source <session-id-or-path> [--project <slug>] [--title <text>] [--json]
```

Needs a Divernote whose extension commands get `prepareIssue` and `addIssue`.

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
