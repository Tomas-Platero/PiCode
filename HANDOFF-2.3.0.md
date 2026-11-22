# Handoff: PiCode 2.3.0 (sessions on branches, parallel chats, Worktree box)

Read `AGENTS.md` first. It is the owner's list of rules and wins over anything here. The owner talks to you in Spanish. Everything the product shows is in English, translated into 13 languages.

## Where things stand

- **Branch:** `feat/2.3.0`, cut from `master`. 18 commits ahead of `master`, clean tree, **nothing pushed, no release made**.
- **Last commit:** `f5794076 feat(picode): Worktree box under a new chat replaces the separate-copy switch`.
- **Last portable build:** `PiCode-Win32-x64-experimental/PiCode Experimental.exe`, built from that commit. Tests and typecheck pass. **Nobody has tried it in the app yet.**
- **Setup redesign:** lives on a separate branch, `refs/heads/claude/nostalgic-volhard-9bbd93`, based on `master`. It is not merged into `feat/2.3.0`, and the owner chose to build without it for now. If they want it in 2.3.0, cherry-pick only these three commits:
  - `d294a140` feat(onboarding): five-step setup with in-place rendering
  - `dab955ba` chore(l10n): translate the new setup copy into 13 languages
  - `1d864b30` refactor(picode): drop the unused package commands from the setup host

## What 2.3.0 contains (owner's request, 2026-11-16)

1. **Branches and PRs on each session in the Agent layout**, like Claude Code desktop.
   - Each row shows a branch badge; hovering it opens a card with the branches the session touched and their PRs.
   - The PRs only show with GitHub connected (Pro).
2. **Parallel sessions, each on its own branch, answering at the same time.**
   - Each chat can work in its own git worktree at `<parent>/.picode-worktrees/<repo>/<branch>`.
   - Each chat has its own turn state (permissions, MCP tool token, edit ledger), so turns no longer queue.
3. **Worktree box** (latest change, after the owner asked for it to work like Codex and Claude):
   - A checkbox labelled *Worktree* in the chat input bar. It only shows while the chat has no messages and the folder is a git repo.
   - When ticked, the first message creates the worktree on a placeholder branch, renames the branch from the first words of the message (`picode/<words>`), and the session runs there.
   - Once the chat has a message, the box is replaced by a branch chip with `+/-` counts; clicking the chip reviews the changes.
   - The old "In a separate copy" switch in the sessions column is gone.
4. **Session row menu** (right-click on a pi session):
   - *Rename…*.
   - Only for sessions with a worktree: *Review Changes*, *Create Pull Request*, *Merge into Main Branch…*, *Open Copy in New Window*.
   - Archiving a session offers to remove its worktree, but never one that has uncommitted changes.
   - Every menu entry has an icon, drawn in its own column (`showMenuIcons` was added to the upstream context menu).
5. **Status → Entorno** follows the chat in front, including its worktree and branch.

Full design and decisions: `docs/DECISIONS.md`, **ADR-043** with addenda 1 and 2.

## Key files

**Connector** (`extensions/picode/src/`):

| File | What it does |
|---|---|
| `agent.ts` | Per-chat state (`ChatPi`: `worktree`, `turn`, `toolToken`, `turnsWaiting`).<br>Binding a chat to a worktree: `bindChatToWorktree`, `chatWorktrees.bind`.<br>The Worktree box state: `chatsWantingWorktree`, `setChatWantsWorktree`, `chatWantsWorktree`. The worktree is created just before `cwd` is chosen in the request handler.<br>The placeholder branch is renamed on the first turn. |
| `session-worktree.ts` | Git worktree helpers: `openWorktree`, `removeWorktree`, `placeholderBranch`, `branchSlugOf`, `renameBranch`, `changedFiles`, `mergeIntoBase`, `pushBranch`. |
| `session-git.ts` | Per-session record in `<profile>/session-git.json`: branches, worktree, title. |
| `session-transcript.ts` | Writes a pi JSONL transcript up front, so a session is listed before its first message. |
| `session-branch-commands.ts` | Commands: `picode.session.bindWorktree`, `worktreeOption`, `setWorktree`, `newOnBranch`, `removeBranchCopy`; also `worktreeOfChatKey`. |
| `session-actions.ts` | The row actions: rename, review, PR, merge, open copy, offer to remove copy; plus `newIsolated`. |
| `sessions-register.ts` | The session rows: `badge` and `metadata.picodeGit`. |
| `chat-edits.ts` | `TurnEditLedger`, one per turn. |

**Workbench** (`src/vs/workbench/contrib/picode/browser/`):

| File | What it does |
|---|---|
| `picodeChatBranchChip.ts` | The Worktree box and the branch chip, in `MenuId.ChatInput`. |
| `picodeSessionBranchHover.ts` | The branch/PR hover card, and archive → offer to remove the copy. |
| `picodeAgentSessionsView.ts` | The sessions column; the `picode.agent.newChatOnWorktree` command. |
| `picodeAgentOverviewView.ts` | Status/Entorno following the focused chat. |
| `picodeWhatsNewHighlights.ts` / `picodeWhatsNewWindow.ts` | The 2.3.0 pages `parallelSessions` and `sessionBranches`. |

**Upstream files touched:**

| File | Change |
|---|---|
| `chat/browser/agentSessions/agentSessionsControl.ts` | Menu icons, `picodeSessionHasCopy`. |
| `agentSessionsViewer.ts` | Branch icon in the badge, hover. |
| `media/agentsessionsviewer.css` | Styles for the above. |
| `base/browser/ui/menu/menu.ts`, `base/browser/contextmenu.ts`, `platform/contextview/browser/contextMenuHandler.ts` | `showIcons` / `showMenuIcons`. |

**Server:** `host/cloud/sync-api/src/lib/connect-proxy.ts` now allows `GET /repos/{o}/{r}/pulls`. **It is not deployed.** The GitHub App also needs the *Pull requests: Read-only* permission before PRs show.

## How to work here

- **Typecheck:**
  - `node_modules/.bin/tsc --project ./src/tsconfig.json --noEmit --skipLibCheck`
  - `node_modules/.bin/tsc -p extensions/picode/tsconfig.test.json`
- **Connector tests** (run from the repo root):
  `for f in extensions/picode/test/*.test.ts; do node --experimental-strip-types --test "$f" || exit 1; done`
- **Translations:** never edit the language files by hand.
  1. Editor strings with a `picode*` key: add them to `src/vs/workbench/contrib/picode/l10n/source.json`. A full `extract` needs an upstream VS Code checkout, so add the keys yourself instead.
  2. Extension strings: `node build/l10n.mjs extract --surface extension`.
  3. For each of the 13 languages: `node build/l10n.mjs split <lang> [--surface extension]`, write the `NN.out.json` answers, then `node build/l10n.mjs merge <lang> [--surface extension]`.
  4. `node build/l10n.mjs check` must pass. It flags keys removed from the code; delete those from `source.json` and from every language file.
- **Build:** portable pack only, never the installer unless the owner asks:
  `PICODE_CHANNEL=experimental PICODE_SKIP_INSTALLER=yes bash build/build-fast.sh`
  Close any running PiCode Experimental first: it locks the output folder.
- **Line endings:** files are CRLF. Watch out for shell heredocs mangling backslashes and backticks.
- **Commits:** Conventional Commits, in English, with **no AI attribution or Co-Authored-By lines**. Do not push, open PRs or release unless the owner asks.
- **Never touch** the `pi` on PATH or `~/.pi`.

## Open items

1. **The owner tests the Worktree box in the app:**
   - Tick *Worktree* in a new chat and send → the session runs in its own worktree, the branch is named from the message, and the chip shows up.
   - Check that the right-click menu icons look right.
2. **Decide** whether the setup redesign (the 3 commits above) goes into 2.3.0.
3. **Known gaps**, accepted for now and not fixed:
   - `agentTodos` (the plan board) and `PICODE_CHAT_MODEL` are global to the window, not per chat.
   - `gentleAgents.clear()` and `trimLiveChats` run before the per-chat queue.
   - `resumeTurnContext` is shared by all resumed sessions.
   - A session with a worktree only appears in the list after its first message. The palette command *New Session in a Separate Copy* still creates the copy straight away.
   - "Archive" in the session menu is an upstream string and stays untranslated in Spanish.
4. **Release 2.3.0** when the owner says so:
   - Bump the version.
   - Write the What's New text: app, web, and the release page.
   - Publish to the channels in this order: experimental → beta → stable.
   - Delete the previous release in each channel.

   See `AGENTS.md` §7.
