# codein-tidy

AI coding tools keep snapshots, caches, logs, browser recordings, old app versions and git worktrees, and
most of them never delete any of it. `codein-tidy` shows where your disk went and frees only what is safe.

Works with **Claude Code, Codex, Cursor and Antigravity** on Windows, macOS and Linux. No dependencies.

```
npx codein-tidy            # report: reads only
npx codein-tidy clean      # shows the plan, removes nothing
npx codein-tidy clean --yes
```

## What it removes

| Default | With `--history` | With `--worktrees` |
|---|---|---|
| Caches, shell snapshots, logs, browser recordings, old app versions, past their age limit | Old chat sessions and edit history (30 days) | Git worktrees untouched for 14 days with nothing uncommitted, whose commit a branch keeps |

It never removes Cursor's chat database or Antigravity's `brain` folder (the only copy of your chats), and
it skips an app's cache while that app is running. Worktrees are removed by git itself, so your main
repository forgets them too. Every worktree it keeps is listed with the reason.

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
| `clean` | Shows the plan. Add `--yes` to carry it out. |
| `review` | Lists worktrees holding uncommitted work, split into real work and agent leftovers. |
| `prepare --project=PATH` | Moves a worktree's agent leftovers to trash and ignores agent state locally. Add `--yes`. |

## Why

Made by [code.in](https://code.in), the coding agent that cleans up after itself.
