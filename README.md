# codein-tidy

AI coding tools keep snapshots, caches, logs, browser recordings, old app versions and git worktrees, and
most of them never delete any of it. `codein-tidy` shows where your disk went and frees only what is safe.

Works with **Claude Code, Codex, Cursor and Antigravity** on Windows, macOS and Linux. No dependencies.

```
npx codein-tidy            # one command: review everything, choose, confirm once, done
```

The one command is the whole job, in a terminal with the arrow keys or through your coding agent:

1. **Where to look.** This computer, the drives you tick, or only this project.
2. **Scan**, with a live progress bar.
3. **Ready and not ready.** Ready items free space now. A worktree holding uncommitted work is not ready: a
   coding agent should read that work and commit it first.
4. **Hand-off.** From the same screen, hand those folders to an agent installed on your machine (Claude Code,
   code.in and OpenCode are tested; Codex is wired but not yet tested here), or copy the task for your own agent.
   Each folder is checked afterwards and the list updates by itself, also when your agent commits in another
   window.
5. **Choose and confirm once.** Space selects, A selects all, Right shows what is behind an item. The confirm
   screen names the file each project's work is saved into.
6. **Save, then free**, with a live bar.

### Memory

```
npx codein-tidy ram        # memory by agent session, and idle leftovers you can stop
```

Coding agents start dev servers, headless browsers and watchers, and some keep running after the session that
started them has ended. `ram` shows memory per agent session (and what each one started), your editors, helpers
that run once per session, and leftovers: idle developer processes whose parent program is gone. It never offers a
process that is still using the processor or started in the last 10 minutes, and it re-checks each one right
before stopping it. The session-start notice mentions leftovers when they hold 200 MB or more.

Through an agent (no terminal) the same steps are printed as text: the scope question first
(`--scope=computer`, `--scope=drive:C,D`, `--scope=project`), then the list with a name per item and the task
for the folders that are not ready. The agent runs your choice with `npx codein-tidy --scope=... --apply=<names>`.

## How commits are handled

Projects use different git and GitHub accounts, so commits are never made in a guessed name.

- The tool itself never commits your work. Its saves are snapshots under its own name (`codein-tidy`), kept
  under `refs/tidy` and in a bundle file; they are local saves, never pushed.
- The agent is told to commit as the git identity each folder already has (shown per folder), never to change
  git config, never to pass `--author`, and never to push.
- Afterwards every folder is checked against git itself. Work that vanished without a commit (a stash, a reset)
  is flagged and the folder is not called ready. A commit made as another account, or one that was pushed, is
  said out loud.
- A folder changed in the last two hours is treated as in use: it is shown, never offered.

## What is saved, and where

Before a worktree is removed, everything only that folder holds goes into **one file per project per run**
(`~/.codein-tidy/saved/<project>-<time>.bundle`, a git bundle: compressed, and a file shared by many folders is
stored once), with one line per folder in `~/.codein-tidy/saved/index.jsonl`. Each part is labelled:

| Part | What it is |
|---|---|
| work | uncommitted changes and new files, as a snapshot commit that holds work only |
| commits | commits that exist on no remote |
| local | files git ignores that only this folder has, such as `.env.local` |
| context | what agents kept here (`.claude`, `.codex`, `.code-in`, ...) |
| scratch | temp scripts, screenshots, probe files |

Rebuildable folders (`node_modules`, build output, caches) are left out. A context or scratch file over 20 MB,
or beyond 200 MB per folder, is left out too and named in the record, so nothing goes missing silently.

**The agent's review is a label, never a filter.** `codein-tidy record --project=<folder> --summary="..."
--relevant=<files|none|all>` lets the agent say what the work was and which context files matter. A summary can
lose something, so it never replaces a file: every file is still stored whole, and the summary and the
`relevant` marks sit on top as an index. `codein-tidy restore <id>` puts a folder back exactly.

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
| `save --project=PATH [--yes]` | Saves a folder exactly, into one bundle file: a snapshot commit of its work (built without touching your branch, index or hooks) and a second commit with ignored local files, agent context and scratch. `saved` lists saves; `restore ID` puts one back. |
| `close [--all] [--idle-days=N] [--only=PATH,PATH] [--yes]` | For every idle worktree (default: untouched for a day): everything only that folder holds is saved into one file per project, then git removes the folder. Never the main checkout, the folder you are in, a locked worktree, or one holding uncommitted work (commit it first, or add `--include-uncommitted` to close it knowingly with its save as the only copy). A worktree a removal left half done is repaired first (see `repair`). `--only` takes exactly the folders named. |
| `repair --project=PATH [--yes]` | A worktree a removal stopped halfway in: restores its `.git` link (`git worktree repair`), removes an empty git lock older than 10 minutes when no git process runs, and puts back deleted `.gitignore` files from its own commit. Work is never touched. |
| `check --project=PATH` | Before an agent commits a folder's work: what is work, what is scratch (logs, captured streams, archives, probe scripts: never committed, kept in the save), which tracked files are only missing from disk, and which files look like secrets (exit code 3). |
| `slot take --branch=X` / `slot release` / `slot list` | A small pool of working folders per project (budget 3, or `"budget"` in `.codein-tidy.json`), reused across tasks: installed dependencies stay, work left in a slot is saved first. |
| `deps` | Proves which installs are shared with a store and which are private copies, with the cause and the fix (for example: npm has no shared store; pnpm's store is on another drive). |
| `guard [--mode=notify\|close]`, `guard --install [--dry-run]` | A daily job (Task Scheduler, launchd or cron) that keeps every known project inside its budget. `notify` only reports; `close` saves and closes the oldest idle worktrees. |
| `rules [--write]` | The instructions block for `AGENTS.md` (read by Claude Code, Codex, Cursor, OpenCode and Antigravity). |

**Enforcement.** The Claude Code plugin refuses `git worktree add` when the project is at its budget and points
the agent to `slot take`. The check only starts for commands that contain `worktree add`, so other commands run
at full speed. Claude Code's own worktrees (`claude --worktree`, subagents with `isolation: worktree`, workflows,
background sessions) also come from the pool: its `WorktreeCreate` hook takes a slot, `WorktreeRemove` saves the
work and gives the folder back, and when a session ends its slots go back to the pool. A slot left in use with no
change for a day is reused, so a crashed session cannot hold it. Over budget, Claude Code says why and creates
nothing. For Codex, add a `PreToolUse` hook running `npx -y codein-tidy@latest guard-shell`;
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
| `record --project=PATH --summary="..." [--relevant=files\|none\|all]` | An agent's review of a folder, stored with its work when the folder is saved. It also hands the folder back: the commit the agent just made no longer counts as the folder being in use. |
| `ram` | Reads only. Memory by agent session, the editors, helpers running once per session, and idle leftovers whose parent program is gone. In a terminal it asks before stopping them; an agent asks the user, then runs `ram --stop=KEY,KEY` or `--stop=all`. A process that is still working is never offered, and each one is re-checked before it is stopped. |
| `save`, `saved`, `restore`, `close`, `slot`, `deps`, `guard`, `rules` | See "Keep projects lean" above. |

## Why

Made by [code.in](https://code.in), the coding agent that cleans up after itself.
