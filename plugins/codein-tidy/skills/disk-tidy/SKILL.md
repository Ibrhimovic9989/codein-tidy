---
name: disk-tidy
description: Show unfinished work left in a project's worktrees by any coding agent, and safely free the disk space that AI coding tools (Claude Code, Codex, Cursor, Antigravity) leave behind - old snapshots, caches, logs, browser recordings, old app versions and stale worktrees. Use when a session starts with a codein-tidy notice, when the user asks what work is unfinished or not deployed, says their disk is full, asks what is using space, or asks to clean up after coding agents.
---

# Disk tidy

AI coding tools keep snapshots, logs, caches, recordings and git worktrees that are never removed.
This skill measures them and removes only what is safe.

## Steps

One command does the whole job. You show the person the list; they choose; you apply their choice.

1. Run it. It only reads, and prints a review list: every item with a name, its size and what will happen.

   ```
   npx -y codein-tidy@latest
   ```

2. Show the person the list as it printed. Items marked [x] are suggested; `history` deletes old chats for good,
   so it is never suggested. Idle worktrees are saved (a snapshot commit of their work plus ignored local files,
   in one file per project) before they are removed.

3. Ask which items to free. Wait for the answer. Never choose for them.

4. Run their choice, by name (or `suggested`, or `all`):

   ```
   npx -y codein-tidy@latest --apply=worktrees:my-app,caches,cleanup:claude-code
   ```

   It scans again before acting and skips anything that changed.

5. Report the "Done. About ... freed" line exactly as printed, where the saved work is, and any item it kept.
   `codein-tidy saved` lists saved work; `codein-tidy restore <id>` puts a folder back exactly.

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

## Working folders

- Do not run `git worktree add`. Take a folder from the project's pool:
  `npx -y codein-tidy@latest slot take --branch=<name>`, and release it when the task ends:
  `npx -y codein-tidy@latest slot release`. A refusal means the project is at its budget: release a slot or
  offer the user `close`.
- To free idle worktrees, show the user the plan first: `npx -y codein-tidy@latest close`. It saves every
  folder's work (a snapshot commit plus ignored local files) into one file per project before git removes the
  folder. Run it with `--yes` only after the user agrees. `codein-tidy saved` lists what was saved, and
  `codein-tidy restore <id>` puts a folder back exactly.
- `npx -y codein-tidy@latest deps` shows whether this project's installs are shared or copied, and the fix.

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
