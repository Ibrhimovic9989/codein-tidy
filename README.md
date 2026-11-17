# codein-tidy

AI coding tools keep snapshots, caches, logs, browser recordings, old app versions and git worktrees, and
most of them never delete any of it. `codein-tidy` shows where your disk went and frees only what is safe.

Works with **Claude Code, Codex, Cursor and Antigravity** on Windows, macOS and Linux. No dependencies.

```
npx codein-tidy            # one command: review everything, choose, confirm once, done
```

In a terminal it scans everything with a live progress bar, then shows one list: each item with its size and
what will happen. Move with the arrow keys, Space selects, A selects all, Right shows the folders or files behind
an item, Enter continues. You confirm once (Yes, back to the list, or quit), then it does it with a live bar:
every idle worktree's work is saved into one file per project before the folder is removed, then caches, logs and
leftovers are freed. Through an agent (no terminal) the same list is printed with a name per item; the agent shows it to
you and runs your choice with `npx codein-tidy --apply=<names>` (or `--apply=suggested`, `--apply=all`).

```
npx codein-tidy work       # unfinished work in this project, from every tool: reads only
npx codein-tidy report     # the detailed report: reads only
npx codein-tidy clean      # the older step-by-step: shows the plan, removes nothing (add --yes)
```

## Unfinished work

Agents leave work behind in worktrees: a Codex task never committed, a Claude Code subagent's commit never
merged. Switch tools and you no longer know it exists. `npx codein-tidy work` lists every working folder of the
project you run it in (the main checkout and every worktree, whichever tool made it) by stage:

| Stage | Meaning |
|---|---|
| Uncommitted work | real changes; agent leftovers are counted apart, never as work |
| Committed, not pushed | commits that exist on no remote, so on this machine only |
| Pushed, not in the release branch | the remote's default branch, or `"release"` in `.codein-tidy.json` |

Whether the release branch is live is not checked. `--all` lists every project the tools' worktrees belong to.

**At the start of every session.** The Claude Code plugin runs `work --notice` when a session starts: when
the project has unfinished work, the agent sees a short list and is told to tell you before starting something
new. When everything is finished it prints nothing. For Codex, add this to `~/.codex/hooks.json` (not yet
tested here):

```json
{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "npx -y codein-tidy@latest work --notice", "timeout": 60}]}]}}
```

## Keep projects lean

Agents make a new worktree for every task and never close it; one machine had 76 for two projects. These
commands keep a project's disk use tied to how many agents work on it at once, never losing work.

| Command | What it does |
|---|---|
| `save --project=PATH [--yes]` | Saves a folder's work exactly: a snapshot commit (built without touching your branch, index or hooks), plus ignored local files like `.env.local` in a keep folder. `saved` lists saves; `restore ID` puts one back. |
| `close [--all] [--idle-days=N] [--yes]` | For every idle worktree (default: untouched for a day): leftovers to trash, work saved into one file per project, then git removes the folder. Never the main checkout, the folder you are in, or a locked worktree. |
| `slot take --branch=X` / `slot release` / `slot list` | A small pool of working folders per project (budget 3, or `"budget"` in `.codein-tidy.json`), reused across tasks: installed dependencies stay, work left in a slot is saved first. |
| `deps` | Proves which installs are shared with a store and which are private copies, with the cause and the fix (for example: npm has no shared store; pnpm's store is on another drive). |
| `guard [--mode=notify\|close]`, `guard --install [--dry-run]` | A daily job (Task Scheduler, launchd or cron) that keeps every known project inside its budget. `notify` only reports; `close` saves and closes the oldest idle worktrees. |
| `rules [--write]` | The instructions block for `AGENTS.md` (read by Claude Code, Codex, Cursor, OpenCode and Antigravity). |

**Enforcement.** The Claude Code plugin refuses `git worktree add` when the project is at its budget and points
the agent to `slot take`. For Codex, add a `PreToolUse` hook running `npx -y codein-tidy@latest guard-shell`;
for Cursor, a `beforeShellExecution` hook running `npx -y codein-tidy@latest guard-shell --cursor` (both not
yet tested here). Folders a tool creates inside itself are reached by the guard and by the tool's own limit.

## What it removes

| Default | With `--history` | With `--worktrees` |
|---|---|---|
| Caches, shell snapshots, logs, browser recordings, old app versions, past their age limit | Old chat sessions and edit history (30 days) | Git worktrees untouched for 14 days with nothing uncommitted, whose commit a branch keeps |

It never removes Cursor's chat database or Antigravity's `brain` folder (the only copy of your chats), and
it skips an app's cache while that app is running. Worktrees are removed by git itself, so your main
repository forgets them too. Every worktree it keeps is listed with the reason.

It also finds worktrees made outside the tools' own folders (for example `D:\work-wt\feature` or `~/src/app-fix`):
it asks git for every worktree of the repositories the tools work in, and of the repository you run it from. The
same rules apply, and the main checkout is never touched.

### Deep clean

`--deep` frees much more: temp and scratch files of finished sessions after one day, and committed worktrees
idle for three days.

### Worktrees with uncommitted work

Uncommitted work is never deleted. `npx codein-tidy review` lists every worktree that holds it: its branch,
changed and new files. The skill has your agent read that work and commit it (on a new branch if it has
none), never reset or discard it. Once committed, the worktree is safe to remove and its branch stays in your
repository.

### Package caches

`--caches` (also part of `--deep`) cleans npm, npx, pnpm, Yarn, pip and uv caches with each package manager's
own command (`npm cache clean --force`, `pnpm store prune`, ...), and removes old Playwright browser
revisions while keeping the newest of each. The receipt reports the space really freed, measured before and
after. Downloaded AI models (Hugging Face) are reported, never removed.

### Project leftovers

`--project` (or `--project=PATH`) finds what agents leave inside a project: screenshots, `.playwright-mcp`
logs, `.tmp-*` scripts and stray files like `nul` or `-`. Only files git does not track are considered, and
they are moved to a trash folder in `~/.codein-tidy/trash`, emptied after 7 days.

`--older-than=DAYS` changes the age limit. `--json` prints the full plan.

## Use it from your agent

The plugin in `plugins/codein-tidy` carries one skill, `disk-tidy`, that lets your agent do this for you. Ask "what is using my disk?" and it runs the report,
then asks before cleaning. It reviews and commits uncommitted work instead of deleting it.

**Claude Code**

```
/plugin marketplace add Ibrhimovic9989/codein-tidy
/plugin install codein-tidy@codein-tidy
```

**Codex**

```
codex plugin marketplace add Ibrhimovic9989/codein-tidy
```

Then type `/plugins` in Codex and install codein-tidy.

**Cursor:** Customize, then "From GitHub Repository", then `Ibrhimovic9989/codein-tidy`.

**Antigravity:** copy `plugins/codein-tidy/skills/disk-tidy` into `~/.gemini/config/skills/` (a marketplace listing
is on its way).

**Any agent that reads skills:** copy `plugins/codein-tidy/skills/disk-tidy` into its skills folder (for example
`~/.agents/skills/`, `~/.claude/skills/` or `~/.cursor/skills/`).

## Commands

| Command | What it does |
|---|---|
| `report` | Reads only. Shows what each tool keeps and what can be freed. |
| `work` | Reads only. Unfinished work in this project by stage. `--all` for every project, `--notice` for the short session-start form, `--json`. |
| `clean` | Shows the plan. Add `--yes` to carry it out. |
| `review` | Lists worktrees holding uncommitted work, split into real work and agent leftovers. |
| `prepare --project=PATH` | Moves a worktree's agent leftovers to trash and ignores agent state locally. Add `--yes`. |
| `save`, `saved`, `restore`, `close`, `slot`, `deps`, `guard`, `rules` | See "Keep projects lean" above. |

## Why

Made by [code.in](https://code.in), the coding agent that cleans up after itself.
