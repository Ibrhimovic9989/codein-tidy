---
name: disk-tidy
description: Show unfinished work left in a project's worktrees by any coding agent, and safely free the disk space that AI coding tools (Claude Code, Codex, Cursor, Antigravity) leave behind - old snapshots, caches, logs, browser recordings, old app versions and stale worktrees. Use when a session starts with a codein-tidy notice, when the user asks what work is unfinished or not deployed, says their disk is full, asks what is using space, or asks to clean up after coding agents.
---

# Disk tidy

AI coding tools keep snapshots, logs, caches, recordings and git worktrees that are never removed.
This skill measures them and removes only what is safe.

## Steps

1. Run the report. It only reads:

   ```
   npx -y codein-tidy@latest report
   ```

2. Show the user the report as it printed. Name the biggest items and what "can be freed" means.

3. Ask the user before removing anything. Then show the plan:

   ```
   npx -y codein-tidy@latest clean
   ```

4. Only after the user agrees to that plan, run it:

   ```
   npx -y codein-tidy@latest clean --yes
   ```

5. Report the "Removed ... freed" line exactly as printed, and any item it could not remove.

## Unfinished work

Work done in one tool is invisible to the next: a Codex task left uncommitted, a Claude Code subagent's commit
that was never merged. In Claude Code this plugin prints a short notice at the start of every session when the
project has unfinished work. In any tool, list it yourself:

```
npx -y codein-tidy@latest work
```

It lists every working folder of the project (the main checkout and every worktree, whichever tool made it)
by stage: uncommitted, committed but not pushed, pushed but not in the release branch. The release branch is
the remote's default branch, or `"release"` in `.codein-tidy.json`. Whether it is live is not checked.

When you see unfinished work:
1. Tell the user what is there before starting something new, and offer to finish it.
2. For each folder the user wants finished, follow "Worktrees with uncommitted work" below to commit it.
3. Ask the user before pushing or merging anything. Never delete, reset or stash the work.

## Worktrees with uncommitted work

Uncommitted work is never deleted. The report lists worktrees that "hold uncommitted work". Turn that work into
commits so the worktree becomes safe to remove:

1. List them: `npx -y codein-tidy@latest review --json`. Each entry splits what is not committed into real
   `work`, agent `leftovers` (temp scripts, `.tmp-*` folders, screenshots) and `agentState` folders.
2. Separate the noise first: `npx -y codein-tidy@latest prepare --project=<worktree path> --yes`. It moves the
   leftovers to a trash folder (emptied after 7 days) and adds agent state folders to the repository's local
   ignore list. It never touches real work, and it prints what real work is left.
3. Work inside the worktree folder. Read the real work: `git status`, `git diff`, and every new file.
   Understand what it is before you commit it.
4. If it has no branch (`"branch": null`), create one first: `git switch -c tidy/<short-name>`.
5. Commit it with a message that says what the work is: `git add -A` then `git commit -m "..."`.
   Do not push unless the user asks. If nothing real is left after step 2, there is nothing to commit.
6. Never run `git reset`, `git checkout -- .`, `git stash`, `git clean`, or delete files to make a worktree clean.
   If something should not be committed (secrets, huge generated files), stop and ask the user.
7. Tell the user which worktrees you committed, on which branch, and in one line what each held.
8. Run the clean again; those worktrees are now safe to remove, and their branches stay in the repository.

## Rules

- By default it removes only rebuildable data past an age limit (caches, snapshots, logs, recordings).
- If the user wants more space back, offer `--deep`: temp and scratch files of finished sessions after one
  day, and committed worktrees idle for three days.
- Offer `--project` to clean agent leftovers inside the current project (screenshots, `.playwright-mcp`,
  `.tmp-*` scripts, stray shell files). Only files git does not track are touched, and they are moved to a
  trash folder that is emptied after 7 days.
- Offer `--caches` for npm, pnpm, pip and other package caches and old Playwright browsers. They download again
  when needed, so mention that the next install may be slower.
- Add `--history` only when the user explicitly asks to delete old chat history.
- Add `--worktrees` only when the user explicitly asks. Even then it removes only worktrees with nothing
  uncommitted whose commit is kept by a branch, and it lists the ones it kept and why.
- Never delete files by hand instead of using the tool, and never delete Cursor's `state.vscdb` or
  Antigravity's `brain` folder: they hold the only copy of the user's chats.
- If an app is running, its caches are skipped. Tell the user to close it and run again.
