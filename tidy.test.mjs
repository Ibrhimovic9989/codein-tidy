import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, clean, formatReport, reviewList, unfinishedWork, formatWork, formatNotice, savePlan, saveFolder, savedList, restoreSaved, closePlan, closeFolders, formatClose, takeSlot, releaseSlot, listSlots, guardShell, writeRules, RULES_BLOCK, depsReport, formatDeps } from './tidy.mjs';

const DAY = 24 * 60 * 60_000;
const exists = (path) => access(path).then(() => true, () => false);

async function aged(path, days, content = 'x'.repeat(1000)) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  const when = new Date(Date.now() - days * DAY);
  await utimes(path, when, when);
}
async function ageTree(path, days) {
  const when = new Date(Date.now() - days * DAY);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === '.git' && entry.isDirectory()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await ageTree(child, days); else await utimes(child, when, when);
  }
  await utimes(path, when, when);
}

async function machine() {
  const root = await mkdtemp(join(tmpdir(), 'tidy-'));
  const home = join(root, 'home'), temp = join(root, 'temp'), config = join(root, 'config');
  // cwd too: worktree discovery asks git about the repository it runs in, which must be the test's, never the real one.
  return { root, home, temp, config, options: { home, temp, cwd: root, os: 'linux', env: { XDG_CONFIG_HOME: config }, running: new Set(), lookup: () => null } };
}

test('report only reads, and counts what each tool holds', async () => {
  const m = await machine();
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10);
  await aged(join(m.home, '.claude', 'projects', 'p', 'chat.jsonl'), 90);
  const plans = await scan(m.options);
  const snapshots = plans.find((p) => p.item === 'Shell snapshots');
  assert.equal(snapshots.bytes, 1000);
  assert.equal(snapshots.removable.length, 1);
  assert.equal(plans.find((p) => p.item === 'Chat transcripts').removable.length, 0);
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old.sh')), true);
  assert.match(formatReport(plans), /AI tools use 2 KB here\. 1 KB can be freed safely now\./);
});

test('clean removes only old rebuildable data; history stays unless asked', async () => {
  const m = await machine();
  const oldSnap = join(m.home, '.claude', 'shell-snapshots', 'old.sh');
  const newSnap = join(m.home, '.claude', 'shell-snapshots', 'new.sh');
  const oldHistory = join(m.home, '.claude', 'file-history', 's1', 'v1');
  const transcript = join(m.home, '.claude', 'projects', 'p', 'chat.jsonl');
  const oldRecording = join(m.home, '.gemini', 'antigravity', 'browser_recordings', 'r1', 'f.jpg');
  const brain = join(m.home, '.gemini', 'antigravity', 'brain', 'b1', 'notes.md');
  const oldSession = join(m.home, '.codex', 'sessions', '2026', '09', '01', 'rollout-a.jsonl');
  await aged(oldSnap, 10); await aged(newSnap, 1); await aged(oldHistory, 40); await aged(transcript, 90);
  await aged(oldRecording, 9); await aged(brain, 90); await aged(oldSession, 60);
  await ageTree(join(m.home, '.claude', 'file-history', 's1'), 40);
  await ageTree(join(m.home, '.gemini', 'antigravity', 'browser_recordings', 'r1'), 9);
  await ageTree(join(m.home, '.codex', 'sessions', '2026'), 60);

  const receipt = await clean(await scan(m.options));
  assert.equal(receipt.removed, 2);
  assert.equal(await exists(oldSnap), false);
  assert.equal(await exists(oldRecording), false);
  for (const kept of [newSnap, oldHistory, transcript, brain, oldSession]) assert.equal(await exists(kept), true, kept);

  const withHistory = await clean(await scan({ ...m.options, history: true }));
  assert.equal(withHistory.removed, 2); // file-history s1 and the 2026 sessions folder
  assert.equal(await exists(oldHistory), false);
  assert.equal(await exists(oldSession), false);
  for (const kept of [newSnap, transcript, brain]) assert.equal(await exists(kept), true, kept);
});

test('Claude Code temp: only old session folders, never the app files beside them', async () => {
  const m = await machine();
  const project = join(m.temp, 'claude', 'ca50095283f085ef');
  await aged(join(project, 'old-session', 'tasks', 'a.output'), 10);
  await ageTree(join(project, 'old-session'), 10);
  await aged(join(project, 'live-session', 'tasks', 'b.output'), 0);
  await aged(join(m.temp, 'claude', 'bundled-skills', '2.1', 'SKILL.md'), 30);
  await ageTree(join(m.temp, 'claude', 'bundled-skills'), 30);
  await clean(await scan(m.options));
  assert.equal(await exists(join(project, 'old-session')), false);
  assert.equal(await exists(join(project, 'live-session')), true);
  assert.equal(await exists(join(m.temp, 'claude', 'bundled-skills', '2.1', 'SKILL.md')), true);
});

test('app caches are skipped while the app runs, and cleared when it is closed', async () => {
  const m = await machine();
  const cache = join(m.config, 'Antigravity', 'Cache', 'Cache_Data', 'f_000001');
  await aged(cache, 0);
  const running = await scan({ ...m.options, running: new Set(['antigravity']) });
  assert.match(formatReport(running), /antigravity is running: close it first/);
  assert.equal((await clean(running)).removed, 0);
  assert.equal(await exists(cache), true);
  await clean(await scan(m.options));
  assert.equal(await exists(cache), false);
  assert.equal(await exists(join(m.config, 'Antigravity', 'Cache')), true); // the folder itself stays
});

test('Cursor keeps its newest app version and removes older ones', async () => {
  const m = await machine();
  const cached = join(m.config, 'Cursor', 'CachedData');
  await aged(join(cached, 'v1', 'a'), 30); await ageTree(join(cached, 'v1'), 30);
  await aged(join(cached, 'v2', 'a'), 1);
  await clean(await scan(m.options));
  assert.deepEqual(await readdir(cached), ['v2']);
});

test('worktrees: only committed ones kept by a branch, and only with --worktrees', async () => {
  const m = await machine();
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const remote = join(m.root, 'remote.git'), repo = join(m.root, 'repo');
  g(['init', '--bare', '-q', remote], m.root);
  g(['clone', '-q', remote, repo], m.root);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(['config', k, v], repo);
  await writeFile(join(repo, 'a.txt'), 'a'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'a'], repo); g(['push', '-q', 'origin', 'HEAD'], repo);
  const trees = join(m.home, '.codex', 'worktrees');
  const clean1 = join(trees, 'w1', 'repo'), dirty = join(trees, 'w2', 'repo'), unpushed = join(trees, 'w3', 'repo');
  g(['worktree', 'add', '-q', '--detach', clean1], repo);
  g(['worktree', 'add', '-q', '--detach', dirty], repo);
  await writeFile(join(dirty, 'wip.txt'), 'work in progress');
  g(['worktree', 'add', '-q', '-b', 'local-only', unpushed], repo);
  await writeFile(join(unpushed, 'b.txt'), 'b'); g(['add', '.'], unpushed); g(['commit', '-q', '-m', 'b'], unpushed);
  for (const tree of [clean1, dirty, unpushed]) await ageTree(tree, 30);

  assert.equal((await clean(await scan(m.options))).removed, 0);
  const plans = await scan({ ...m.options, worktrees: true });
  const codexTrees = plans.find((p) => p.tool === 'Codex' && p.item === 'Worktrees');
  assert.deepEqual(codexTrees.kept.map((k) => k.why), ['has uncommitted changes: needs review (codein-tidy review)']);
  const receipt = await clean(plans);
  assert.equal(receipt.removed, 2, JSON.stringify(receipt.failed));
  assert.equal(await exists(clean1), false);
  assert.equal(await exists(join(dirty, 'wip.txt')), true);
  assert.equal(await exists(unpushed), false); // committed on branch local-only, which stays in the repo
  assert.equal(g(['show', 'local-only:b.txt'], repo), 'b');
  assert.equal(g(['worktree', 'list'], repo).includes('w1'), false); // git forgot it too
});

test('hard-linked files count once and never as freeable (pnpm links one file into many worktrees)', async () => {
  const m = await machine();
  const { link } = await import('node:fs/promises');
  const store = join(m.root, 'store', 'pkg.js');
  await aged(store, 30, 'y'.repeat(5000));
  const snaps = join(m.home, '.claude', 'shell-snapshots');
  await mkdir(join(snaps, 'a'), { recursive: true }); await mkdir(join(snaps, 'b'), { recursive: true });
  await link(store, join(snaps, 'a', 'pkg.js')); await link(store, join(snaps, 'b', 'pkg.js'));
  await aged(join(snaps, 'own.sh'), 30, 'z'.repeat(1000));
  for (const dir of ['a', 'b']) await ageTree(join(snaps, dir), 30);
  const plans = await scan(m.options);
  const target = plans.find((p) => p.item === 'Shell snapshots');
  assert.equal(target.bytes, 6000); // 5000 once, plus 1000
  assert.equal(target.removable.reduce((s, e) => s + e.freeable, 0), 1000);
  const receipt = await clean(plans);
  assert.equal(receipt.bytes, 1000);
  assert.equal(await exists(store), true);
});

async function repoWithRemote(m) {
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const remote = join(m.root, 'remote.git'), repo = join(m.root, 'repo');
  g(['init', '--bare', '-q', remote], m.root);
  g(['clone', '-q', remote, repo], m.root);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) g(['config', k, v], repo);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  await writeFile(join(repo, 'a.txt'), 'a'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'a'], repo); g(['push', '-q', 'origin', 'HEAD'], repo);
  return { g, repo };
}

test('uncommitted work is never deleted: review lists it, the agent commits it, then clean removes the worktree', async () => {
  const m = await machine();
  const { g, repo } = await repoWithRemote(m);
  const { readFile } = await import('node:fs/promises');
  const trees = join(m.home, '.codex', 'worktrees');
  const dirty = join(trees, 'w1', 'repo'), unbranched = join(trees, 'w2', 'repo'), localBranch = join(trees, 'w3', 'repo');
  g(['worktree', 'add', '-q', '-b', 'feature-a', dirty], repo);
  await writeFile(join(dirty, 'a.txt'), 'edited');
  await writeFile(join(dirty, 'new.txt'), 'brand new');
  g(['worktree', 'add', '-q', '--detach', unbranched], repo);
  await writeFile(join(unbranched, 'b.txt'), 'b'); g(['add', '.'], unbranched); g(['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'b'], unbranched);
  // Committed on a local branch that was never pushed: safe, the branch outlives the folder.
  g(['worktree', 'add', '-q', '-b', 'local-only', localBranch], repo);
  await writeFile(join(localBranch, 'c.txt'), 'c'); g(['add', '.'], localBranch); g(['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'c'], localBranch);
  for (const tree of [dirty, unbranched, localBranch]) await ageTree(tree, 20);

  // Even --deep never removes uncommitted or unbranched work.
  const first = await clean(await scan({ ...m.options, deep: true }));
  assert.equal(first.removed, 1); // only the committed local branch
  assert.equal(await exists(localBranch), false);
  assert.equal(g(['show', 'local-only:c.txt'], repo), 'c');
  assert.equal(await readFile(join(dirty, 'new.txt'), 'utf8'), 'brand new');
  assert.equal(await exists(join(unbranched, 'b.txt')), true);

  const review = await reviewList(m.options);
  assert.deepEqual(review.map((w) => [w.branch, w.changedFiles, w.untrackedFiles, w.unbranched]).sort(),
    [['feature-a', 2, 1, false], [null, 0, 0, true]].sort());

  // What the agent does after reading the work: commit it, and give unbranched commits a branch.
  g(['add', '-A'], dirty); g(['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Finish feature A'], dirty);
  g(['switch', '-q', '-c', 'tidy/w2'], unbranched);
  for (const tree of [dirty, unbranched]) await ageTree(tree, 20);
  assert.equal((await reviewList(m.options)).length, 0);

  const second = await clean(await scan({ ...m.options, deep: true }));
  assert.equal(second.removed, 2, JSON.stringify(second.failed));
  assert.equal(g(['show', 'feature-a:new.txt'], repo), 'brand new');
  assert.equal(g(['show', 'feature-a:a.txt'], repo), 'edited');
  assert.equal(g(['show', 'tidy/w2:b.txt'], repo), 'b');
});

test('deep: finished-session temp folders go after a day instead of a week', async () => {
  const m = await machine();
  const session = join(m.temp, 'claude', 'ca50095283f085ef', 'old-session');
  await aged(join(session, 'scratchpad', 'notes.txt'), 2); await ageTree(session, 2);
  await clean(await scan(m.options));
  assert.equal(await exists(session), true);
  await clean(await scan({ ...m.options, deep: true }));
  assert.equal(await exists(session), false);
});

test('project: agent leftovers git does not track move to trash; tracked files and real assets stay', async () => {
  const m = await machine();
  const { g, repo } = await repoWithRemote(m);
  await writeFile(join(repo, 'tracked-shot.png'), 'png'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'asset'], repo);
  const files = {
    rootShot: join(repo, 'page-1.png'), mcp: join(repo, '.playwright-mcp', 'console.log'), tmp: join(repo, '.tmp-probe.py'),
    stray: join(repo, '-'), newTmp: join(repo, '.tmp-fresh.py'), asset: join(repo, 'apps', 'web', 'logo.png'), notes: join(repo, 'notes.md'),
  };
  for (const [name, path] of Object.entries(files)) await aged(path, name === 'newTmp' ? 0 : 10);
  await utimes(join(repo, 'tracked-shot.png'), new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
  const trashDir = join(m.root, 'trash');
  await mkdir(join(trashDir, 'old-run'), { recursive: true });
  await utimes(join(trashDir, 'old-run'), new Date(Date.now() - 9 * DAY), new Date(Date.now() - 9 * DAY));

  const plans = await scan({ ...m.options, project: repo, trashDir });
  assert.match(formatReport(plans), /Agent leftovers in this project: 4 file\(s\)/);
  const receipt = await clean(plans);
  assert.equal(receipt.moved, 4);
  for (const gone of [files.rootShot, files.mcp, files.tmp, files.stray]) assert.equal(await exists(gone), false, gone);
  for (const kept of [files.newTmp, files.asset, files.notes, join(repo, 'tracked-shot.png')]) assert.equal(await exists(kept), true, kept);
  assert.equal(await exists(join(receipt.trash, 'repo', 'page-1.png')), true);
  assert.equal(await exists(join(receipt.trash, 'repo', '.playwright-mcp', 'console.log')), true);
  assert.equal(await exists(join(trashDir, 'old-run')), false); // trash older than 7 days is emptied
});

test('prepare: leftovers to trash, agent state ignored locally, real work untouched and listed for review', async () => {
  const m = await machine();
  const { g, repo } = await repoWithRemote(m);
  const { readFile } = await import('node:fs/promises');
  const { prepareWorktree } = await import('./tidy.mjs');
  await aged(join(repo, '.claude', 'commands', 'ship.md'), 1); g(['add', '.'], repo); g(['commit', '-q', '-m', 'commands'], repo);
  await writeFile(join(repo, 'a.txt'), 'edited');                                        // real work: tracked change
  await aged(join(repo, 'src', 'feature.js'), 1);                                         // real work: new file
  await aged(join(repo, '.claude', 'agents', 'reviewer.md'), 1);                               // .claude is partly tracked: left as work
  await aged(join(repo, '.tmp-release-1', 'Dockerfile'), 1);                               // leftover folder
  await aged(join(repo, '.tmp-checkout.cjs'), 1);                                          // leftover file
  await aged(join(repo, 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache'), 1);  // leftover cache
  await aged(join(repo, '.code-in', 'state', 'anchor.json'), 1);                           // agent state, nothing tracked
  await aged(join(repo, 'apps', 'web', '.code-in', 'state', 'b.json'), 1);                 // nested agent state

  const plan = await prepareWorktree(repo, { home: m.home });
  assert.equal(plan.applied, false);
  assert.equal(plan.leftovers.length, 3);
  assert.deepEqual(plan.state.sort(), ['.code-in', 'apps/web/.code-in']);
  assert.equal(await exists(join(repo, '.tmp-checkout.cjs')), true); // a plan changes nothing

  const done = await prepareWorktree(repo, { yes: true, home: m.home });
  assert.equal(done.moved, 3);
  for (const gone of ['.tmp-release-1/Dockerfile', '.tmp-checkout.cjs', 'Microsoft/Windows/PowerShell/ModuleAnalysisCache']) {
    assert.equal(await exists(join(repo, gone)), false, gone);
    assert.equal(await exists(join(done.trash, 'repo', gone)), true, gone);
  }
  assert.equal(await exists(join(repo, '.code-in', 'state', 'anchor.json')), true); // state is ignored, not deleted
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.code-in\/$/m);
  assert.deepEqual(done.remainingWork.map((l) => l.slice(3)).sort(), ['.claude/agents/reviewer.md', 'a.txt', 'src/feature.js']);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'edited');

  // Running it again adds nothing twice.
  await prepareWorktree(repo, { yes: true, home: m.home });
  assert.equal((await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).match(/^\/\.code-in\/$/gm).length, 1);
});

test('package caches: only with --caches; the package manager cleans; old Playwright revisions go; freed space is measured', async () => {
  const m = await machine();
  const { link, rm } = await import('node:fs/promises');
  const npmDir = join(m.root, 'npm-cache'), store = join(m.root, 'pnpm-store');
  await aged(join(npmDir, '_cacache', 'content', 'a'), 1, 'n'.repeat(3000));
  await aged(join(npmDir, '_npx', 'old', 'pkg.js'), 10); await ageTree(join(npmDir, '_npx', 'old'), 10);
  await aged(join(store, 'files', 'used.js'), 1, 'u'.repeat(4000));
  await aged(join(store, 'files', 'unused.js'), 1, 'x'.repeat(2000));
  await mkdir(join(m.root, 'project', 'node_modules'), { recursive: true });
  await link(join(store, 'files', 'used.js'), join(m.root, 'project', 'node_modules', 'used.js')); // in use by a project
  const browsers = join(m.home, '.cache', 'ms-playwright');
  for (const name of ['chromium-100', 'chromium-200', 'ffmpeg-1']) await aged(join(browsers, name, 'bin'), 30);
  const lookup = (command) => ({ npm: npmDir, pnpm: store })[command] ?? null;
  const ran = [];
  const runner = async ([command, args]) => {
    ran.push([command, ...args].join(' '));
    if (command === 'npm') await rm(join(npmDir, '_cacache'), { recursive: true, force: true });
    if (command === 'pnpm') await rm(join(store, 'files', 'unused.js'));
  };

  const plain = await scan({ ...m.options, lookup });
  assert.equal((await clean(plain, Date.now(), { runner })).removed, 0);
  assert.deepEqual(ran, []);
  assert.match(formatReport(plain), /add --caches/);

  const plans = await scan({ ...m.options, lookup, caches: true });
  const pnpmPlan = plans.find((p) => p.item.startsWith('pnpm'));
  assert.equal(pnpmPlan.removable[0].freeable, 2000); // only what no project links to
  const receipt = await clean(plans, Date.now(), { runner });
  assert.deepEqual(ran.sort(), ['npm cache clean --force', 'pnpm store prune']);
  assert.equal(await exists(join(browsers, 'chromium-100')), false);
  assert.equal(await exists(join(browsers, 'chromium-200')), true);
  assert.equal(await exists(join(browsers, 'ffmpeg-1')), true);
  assert.equal(await exists(join(npmDir, '_npx', 'old')), false);
  assert.equal(await exists(join(store, 'files', 'used.js')), true);
  // 3000 (npm) + 2000 (pnpm, measured after the prune) + chromium-100 + old npx entry.
  assert.equal(receipt.bytes, 3000 + 2000 + 1000 + 1000);
});

test('worktrees outside the tool folders are found through git, under the same rules', async () => {
  const m = await machine();
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const remote = join(m.root, 'remote.git'), repo = join(m.root, 'repo');
  g(['init', '--bare', '-q', remote], m.root);
  g(['clone', '-q', remote, repo], m.root);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(['config', k, v], repo);
  await writeFile(join(repo, 'a.txt'), 'a'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'a'], repo); g(['push', '-q', 'origin', 'HEAD'], repo);
  // One worktree in Codex's folder (how the repository is found), three in a folder of the user's own choosing.
  const codexTree = join(m.home, '.codex', 'worktrees', 'w1', 'repo');
  const elsewhere = join(m.root, 'repo-wt'), done = join(elsewhere, 'done'), wip = join(elsewhere, 'wip'), recent = join(elsewhere, 'recent');
  for (const tree of [codexTree, done, wip, recent]) g(['worktree', 'add', '-q', '--detach', tree], repo);
  await writeFile(join(wip, 'notes.md'), 'unfinished');
  for (const tree of [codexTree, done, wip]) await ageTree(tree, 30);
  const options = { ...m.options, cwd: m.root };

  const plain = await scan(options);
  const other = plain.find((p) => p.tool === 'Other git worktrees');
  assert.ok(other, 'the outside worktrees are reported');
  assert.equal(other.item, 'Worktrees of repo');
  assert.deepEqual([...other.paths].sort(), [done, recent, wip].sort(), 'never the main worktree, never the Codex one twice');
  assert.match(formatReport(plain), /with --worktrees/);
  assert.equal((await clean(plain)).removed, 0, 'nothing without --worktrees');

  const review = await reviewList(options);
  assert.ok(review.some((w) => w.path === wip && w.work === 1), 'uncommitted work outside the tool folders is listed for review');

  const plans = await scan({ ...options, worktrees: true });
  const outside = plans.find((p) => p.tool === 'Other git worktrees');
  assert.deepEqual(outside.removable.map((e) => e.path), [done]);
  assert.deepEqual(outside.kept.map((k) => [k.path, k.why]).sort(), [[recent, 'used recently'], [wip, 'has uncommitted changes: needs review (codein-tidy review)']].sort());
  const receipt = await clean(plans);
  assert.deepEqual(receipt.failed, []);
  assert.equal(await exists(done), false);
  assert.equal(await exists(join(wip, 'notes.md')), true);
  assert.equal(await exists(join(repo, 'a.txt')), true);
  assert.equal(g(['worktree', 'list'], repo).includes('done'), false);

  // Run from inside an outside worktree: that one is never a candidate.
  const fromInside = await scan({ ...options, cwd: wip, worktrees: true });
  assert.equal(fromInside.find((p) => p.tool === 'Other git worktrees').paths.includes(wip), false);
});

test('a path git stops listing as a worktree after the plan is never removed', async () => {
  const m = await machine();
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const repo = join(m.root, 'repo');
  g(['init', '-q', repo], m.root);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(['config', k, v], repo);
  await writeFile(join(repo, 'a.txt'), 'a'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'a'], repo);
  const tree = join(m.root, 'side');
  g(['worktree', 'add', '-q', tree], repo);
  await ageTree(tree, 30);
  const plans = await scan({ ...m.options, cwd: repo, worktrees: true });
  assert.deepEqual(plans.find((p) => p.tool === 'Other git worktrees').removable.map((e) => e.path), [tree]);
  // Between plan and clean, the worktree goes away and someone puts their own folder there.
  g(['worktree', 'remove', tree], repo);
  await aged(join(tree, 'mine.txt'), 0);
  const receipt = await clean(plans);
  assert.equal(receipt.removed, 0);
  assert.match(receipt.failed[0].error, /no longer lists/);
  assert.equal(await exists(join(tree, 'mine.txt')), true);
});

test('the summary says what each flag would free, never "0 KB more"', async () => {
  const m = await machine();
  const npmDir = join(m.root, 'npm-cache');
  await aged(join(npmDir, '_cacache', 'content', 'a'), 1, 'n'.repeat(3 * 1024 * 1024));
  await aged(join(m.home, '.codex', 'archived_sessions', 'old.jsonl'), 90, 'h'.repeat(2 * 1024 * 1024));
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10, 's'.repeat(1024 * 1024));
  const report = formatReport(await scan({ ...m.options, cwd: m.root, lookup: (c) => (c === 'npm' ? npmDir : null) }));
  assert.doesNotMatch(report, /0 KB more/);
  assert.match(report, /AI tools use 3 MB here\. 1 MB can be freed safely now; 2 MB with --history\./);
  assert.match(report, /Package caches use 3 MB\. 3 MB with --caches \(they download again when needed\)\./);
  assert.match(report, /Everything above together: 6 MB with --history --caches/);
});

test('a node_modules mostly linked to the pnpm store is skipped and named; a copied one is counted', async () => {
  const m = await machine();
  const { link } = await import('node:fs/promises');
  const store = join(m.root, 'store');
  const linked = join(m.home, '.claude', 'shell-snapshots', 'linked', 'node_modules');
  const copied = join(m.home, '.claude', 'shell-snapshots', 'copied', 'node_modules');
  for (let i = 0; i < 12; i++) {
    const rel = join('.pnpm', `pkg${i}@1.0.0`, 'node_modules', `pkg${i}`, 'index.js');
    await aged(join(store, `f${i}`), 10, 's'.repeat(5000));
    await mkdir(join(linked, rel, '..'), { recursive: true });
    // Two packages were built on install: their files are copies, as on a real machine.
    if (i < 10) await link(join(store, `f${i}`), join(linked, rel)); else await aged(join(linked, rel), 10, 'b'.repeat(5000));
    await aged(join(copied, rel), 10, 'c'.repeat(3000));
  }
  const plans = await scan({ ...m.options, cwd: m.root });
  const snapshots = plans.find((p) => p.item === 'Shell snapshots');
  assert.equal(snapshots.bytes, 12 * 3000, 'only the copied node_modules is counted');
  assert.equal(snapshots.sharedModules, 1);
  assert.match(formatReport(plans), /not counted: 1 node_modules linked to the pnpm store/);
});

test('--json prints only JSON, in report and clean modes', async () => {
  const m = await machine();
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10);
  // A real child process reads the real environment: redirect EVERY root the tool reads (2026-11-17: an earlier
  // version of this test left APPDATA real and its clean --yes emptied the developer's Antigravity app caches).
  const local = join(m.root, 'local'), roaming = join(m.root, 'roaming');
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, TEMP: m.temp, TMP: m.temp, TMPDIR: m.temp,
    APPDATA: roaming, LOCALAPPDATA: local, XDG_CONFIG_HOME: m.config, XDG_CACHE_HOME: join(m.root, 'xdg-cache'),
    CLAUDE_CONFIG_DIR: join(m.home, '.claude'), CODEX_HOME: join(m.home, '.codex'), PLAYWRIGHT_BROWSERS_PATH: join(local, 'ms-playwright'),
    npm_config_cache: join(m.root, 'npm-cache'), CODEIN_TIDY_PROFILE: '' };
  const run = (...args) => execFileSync(process.execPath, [join(process.cwd(), 'tidy.mjs'), ...args], { cwd: m.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const plan = JSON.parse(run('clean', '--json'));
  assert.ok(Array.isArray(plan));
  assert.ok(Array.isArray(JSON.parse(run('report', '--json'))));
  // Guard before the one real clean: everything it would touch must be inside this test's folder.
  const touched = plan.filter((p) => !p.skipped && p.removable?.length).flatMap((p) => p.removable.map((e) => e.path));
  const outside = touched.filter((path) => !path.startsWith(m.root));
  assert.deepEqual(outside, [], 'refusing to run clean --yes: it would touch paths outside the test folder');
  assert.equal(touched.length, 1);
  const done = JSON.parse(run('clean', '--yes', '--json'));
  assert.equal(done.receipt.removed, 1);
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old.sh')), false);
});

test('Windows: the fast listing of a copied node_modules equals the exact walk', { skip: process.platform !== 'win32' }, async () => {
  const m = await machine();
  const modules = join(m.home, '.claude', 'shell-snapshots', 'app', 'node_modules');
  for (let i = 0; i < 6; i++) await aged(join(modules, `pkg${i}`, 'lib', 'index.js'), 10, 'x'.repeat(1000 + i));
  await aged(join(modules, '.bin', 'pkg0.cmd'), 10, 'shim');
  const fast = (await scan({ ...m.options, cwd: m.root })).find((p) => p.item === 'Shell snapshots');
  process.env.CODEIN_TIDY_NO_ROBOCOPY = '1';
  try {
    const walked = (await scan({ ...m.options, cwd: m.root })).find((p) => p.item === 'Shell snapshots');
    assert.deepEqual([fast.bytes, fast.files], [walked.bytes, walked.files]);
    assert.equal(fast.bytes, 6 * 1000 + 15 + 4);
  } finally { delete process.env.CODEIN_TIDY_NO_ROBOCOPY; }
});

async function project(m) {
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const remote = join(m.root, 'remote.git'), repo = join(m.root, 'app');
  g(['init', '--bare', '-q', '-b', 'main', remote], m.root);
  g(['clone', '-q', remote, repo], m.root);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(['config', k, v], repo);
  g(['checkout', '-q', '-b', 'main'], repo);
  await writeFile(join(repo, 'a.txt'), 'a'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'a'], repo); g(['push', '-q', '-u', 'origin', 'main'], repo);
  g(['remote', 'set-head', 'origin', 'main'], repo);
  return { g, repo };
}

test('work: every folder of a project by stage; leftovers are never counted as work', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const wip = join(m.root, 'wt', 'wip'), local = join(m.home, '.codex', 'worktrees', 'local', 'app'), review = join(m.root, 'wt', 'review'), done = join(m.root, 'wt', 'done');
  g(['worktree', 'add', '-q', '-b', 'wip', wip], repo);
  await writeFile(join(wip, 'feature.js'), 'real work');
  await aged(join(wip, '.tmp-probe.py'), 0); await aged(join(wip, '.test-tmp', 'run1', 'x.json'), 0); await aged(join(wip, '.diag-db-host.mjs'), 0);
  g(['worktree', 'add', '-q', '-b', 'local', local], repo);
  await writeFile(join(local, 'b.txt'), 'b'); g(['add', '.'], local); g(['commit', '-q', '-m', 'b'], local);
  g(['worktree', 'add', '-q', '-b', 'review', review], repo);
  await writeFile(join(review, 'c.txt'), 'c'); g(['add', '.'], review); g(['commit', '-q', '-m', 'c'], review); g(['push', '-q', 'origin', 'review'], review);
  g(['worktree', 'add', '-q', '--detach', done, 'main'], repo);

  const [p] = await unfinishedWork({ ...m.options, cwd: repo });
  assert.equal(p.name, 'app'); assert.equal(p.release, 'origin/main');
  const by = Object.fromEntries(p.folders.map((f) => [f.path, f]));
  assert.deepEqual([by[wip].stage, by[wip].changed, by[wip].leftovers], ['uncommitted', 1, 3]);
  assert.deepEqual([by[local].stage, by[local].unpushed, by[local].madeBy], ['not pushed', 1, 'Codex']);
  assert.equal(by[review].stage, 'not merged');
  assert.equal(by[done].stage, 'in release');
  assert.equal(by[repo].stage, 'in release'); assert.equal(by[repo].madeBy, 'main checkout');

  const notice = formatNotice([p]);
  assert.match(notice, /unfinished work in app \(3 of 5 working folders\): 1 hold uncommitted work, 1 hold commits that are not pushed, 1 are pushed but not in origin\/main\./);
  assert.match(notice, /Never delete, reset or stash it/);
  assert.equal(notice.includes(done), false);
  assert.match(formatWork([p]), /Finished \(in origin\/main\): 2 folder\(s\)\. Agent leftovers \(not work\) in 1 folder/);

  // Once the work is finished, the notice says nothing at all.
  g(['add', 'feature.js'], wip); g(['commit', '-q', '-m', 'feature'], wip); g(['push', '-q', 'origin', 'wip'], wip);
  for (const [tree, branch] of [[wip, 'wip'], [local, 'local'], [review, 'review']]) {
    if (branch === 'local') g(['push', '-q', 'origin', 'local'], tree);
    g(['checkout', '-q', 'main'], repo); g(['merge', '-q', '--no-edit', branch], repo);
  }
  g(['push', '-q', 'origin', 'main'], repo);
  assert.equal(formatNotice(await unfinishedWork({ ...m.options, cwd: repo })), '');
});

test('work: a project without a remote, and the release branch from .codein-tidy.json', async () => {
  const m = await machine();
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const solo = join(m.root, 'solo');
  g(['init', '-q', solo], m.root);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(['config', k, v], solo);
  await writeFile(join(solo, 'a.txt'), 'a'); g(['add', '.'], solo); g(['commit', '-q', '-m', 'a'], solo);
  const [p] = await unfinishedWork({ ...m.options, cwd: solo });
  assert.equal(p.folders[0].stage, 'no remote');
  assert.match(formatNotice([p]), /1 hold commits \(no remote\)/);

  const { g: g2, repo } = await project(m);
  g2(['checkout', '-q', '-b', 'release'], repo); g2(['push', '-q', 'origin', 'release'], repo);
  await writeFile(join(repo, '.codein-tidy.json'), JSON.stringify({ release: 'origin/release' }));
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.codein-tidy.json\n');
  const [q] = await unfinishedWork({ ...m.options, cwd: repo });
  assert.equal(q.release, 'origin/release');
  assert.equal(q.folders[0].stage, 'in release');
});

test('work --notice prints nothing outside a git project and never fails', async () => {
  const m = await machine();
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, TEMP: m.temp, TMP: m.temp, APPDATA: join(m.root, 'roaming'), LOCALAPPDATA: join(m.root, 'local') };
  const out = execFileSync(process.execPath, [join(process.cwd(), 'tidy.mjs'), 'work', '--notice'], { cwd: m.root, env, encoding: 'utf8' });
  assert.equal(out, '');
});

test('the plugin carries the same tool its session-start hook runs', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const hash = async (p) => createHash('sha256').update(await readFile(join(process.cwd(), ...p))).digest('hex');
  assert.equal(await hash(['plugins', 'codein-tidy', 'scripts', 'tidy.mjs']), await hash(['tidy.mjs']), 'plugins/codein-tidy/scripts/tidy.mjs is stale: copy tidy.mjs over it');
  const hooks = JSON.parse(await readFile(join(process.cwd(), 'plugins', 'codein-tidy', 'hooks', 'claude-code.json'), 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /scripts\/tidy\.mjs" work --notice$/);
});

test('save then restore gives back the exact folder: changes, deletions, new files, local env file, no-branch commits', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env.local\ndist/\n'); await writeFile(join(repo, 'b.txt'), 'b');
  g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const tree = join(m.root, 'wt', 'feature');
  g(['worktree', 'add', '-q', '--detach', tree, 'main'], repo);
  await writeFile(join(tree, 'local.txt'), 'commit on no branch'); g(['add', '.'], tree); g(['commit', '-q', '-m', 'local'], tree);
  await writeFile(join(tree, 'a.txt'), 'changed'); await (await import('node:fs/promises')).rm(join(tree, 'b.txt'));
  await writeFile(join(tree, 'new.js'), 'new'); await writeFile(join(tree, '.env.local'), 'SECRET=only-here');
  await aged(join(tree, 'node_modules', 'pkg', 'index.js'), 0); await aged(join(tree, 'dist', 'app.js'), 0);
  await aged(join(tree, '.code-in', 'state', 'x.json'), 0);

  const plan = await savePlan(tree);
  assert.deepEqual([plan.changed, plan.unreferenced, plan.keep.map((f) => f.rel)], [true, true, ['.env.local']]);
  const saved = await saveFolder(tree, { home: m.home });
  assert.equal(saved.saved, true);
  assert.ok(saved.bundle && await exists(saved.bundle));
  assert.equal(saved.kept.files, 1);
  assert.equal((await savedList({ home: m.home })).length, 1);
  assert.match(g(['log', '-1', '--format=%an %s', saved.ref], repo), /^codein-tidy codein-tidy snapshot of/);
  assert.equal(g(['status', '--porcelain'], tree).includes('new.js'), true, 'the folder itself is untouched');

  g(['worktree', 'remove', '--force', tree], repo);
  assert.equal(await exists(tree), false);
  const back = await restoreSaved(saved.id, { home: m.home });
  assert.equal(back.restored, true, JSON.stringify(back));
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(tree, 'a.txt'), 'utf8'), 'changed');
  assert.equal(await exists(join(tree, 'b.txt')), false);
  assert.equal(await readFile(join(tree, 'new.js'), 'utf8'), 'new');
  assert.equal(await readFile(join(tree, '.env.local'), 'utf8'), 'SECRET=only-here');
  assert.equal(await readFile(join(tree, 'local.txt'), 'utf8'), 'commit on no branch');
  assert.ok(g(['status', '--porcelain'], tree).includes('M a.txt'), 'the changes are uncommitted again, as they were');
});

test('save: a branch comes back on its branch; a clean folder needs no save; too-large local files block it', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const tree = join(m.root, 'wt', 'topic');
  g(['worktree', 'add', '-q', '-b', 'topic', tree], repo);
  assert.deepEqual([(await saveFolder(tree, { home: m.home })).saved], [false], 'nothing unsaved in a clean pushed folder');
  await writeFile(join(tree, 'wip.txt'), 'wip');
  const saved = await saveFolder(tree, { home: m.home });
  g(['worktree', 'remove', '--force', tree], repo);
  const back = await restoreSaved(saved.id, { home: m.home });
  assert.deepEqual([back.restored, back.branch], [true, 'topic']);

  await writeFile(join(repo, '.gitignore'), 'big.bin\n');
  const { open } = await import('node:fs/promises');
  const handle = await open(join(repo, 'big.bin'), 'w'); await handle.truncate(21 * 1024 * 1024); await handle.close();
  const blocked = await saveFolder(repo, { home: m.home });
  assert.equal(blocked.saved, false); assert.match(blocked.reason, /too large to keep: big\.bin/);
});

test('close: idle worktrees are saved into one file and freed; recent, locked and current ones stay', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), '.env.local\nnode_modules/\n'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const wt = (name) => join(m.root, 'wt', name);
  g(['worktree', 'add', '-q', '-b', 'dirty', wt('dirty')], repo); await writeFile(join(wt('dirty'), 'work.js'), 'unfinished');
  await aged(join(wt('dirty'), '.tmp-probe.py'), 0);
  g(['worktree', 'add', '-q', '--detach', wt('done'), 'main'], repo);
  g(['worktree', 'add', '-q', '--detach', wt('env'), 'main'], repo); await writeFile(join(wt('env'), '.env.local'), 'KEY=1');
  await aged(join(wt('env'), 'node_modules', 'x', 'i.js'), 0);
  g(['worktree', 'add', '-q', '--detach', wt('locked'), 'main'], repo); g(['worktree', 'lock', wt('locked')], repo);
  g(['worktree', 'add', '-q', '--detach', wt('recent'), 'main'], repo);
  g(['worktree', 'add', '-q', '--detach', wt('here'), 'main'], repo);
  const later = Date.now() + 3 * DAY;
  const { utimes } = await import('node:fs/promises');
  await writeFile(join(wt('recent'), 'touch.txt'), 'x'); await utimes(join(wt('recent'), 'touch.txt'), new Date(later), new Date(later));

  const plan = await closePlan({ ...m.options, cwd: wt('here'), now: later });
  assert.deepEqual(plan.candidates.map((x) => basename(x.path)).sort(), ['dirty', 'done', 'env']);
  const keep = Object.fromEntries(plan.folders.filter((x) => x.keep).map((x) => [basename(x.path), x.keep]));
  assert.deepEqual(keep, { locked: 'locked in git', recent: 'used today', here: 'you are working in it' });
  assert.match(formatClose(plan), /3 idle worktree\(s\) can be closed/);

  const receipt = await closeFolders(plan, { home: m.home });
  assert.deepEqual(receipt.failed, []);
  assert.equal(receipt.closed.length, 3);
  for (const name of ['dirty', 'done', 'env']) assert.equal(await exists(wt(name)), false);
  for (const name of ['locked', 'recent', 'here']) assert.equal(await exists(wt(name)), true);
  assert.equal(await exists(join(repo, 'a.txt')), true, 'the main checkout is never touched');
  assert.equal(receipt.saved.length, 2, 'dirty (its work) and env (its local file); done had nothing to save');
  assert.equal(receipt.bundles.length, 1, 'one file for the project');
  // The bundle holds the commits no remote has: the dirty folder's snapshot. The env folder's commit is on the
  // remote already; its local file is in the keep folder.
  const heads = g(['bundle', 'list-heads', receipt.bundles[0]], repo).split('\n');
  assert.equal(heads.length, 1);
  assert.equal(heads[0].split(' ')[0], receipt.saved.find((r) => r.path === wt('dirty')).snapshot);

  const saved = await savedList({ home: m.home });
  const back = await restoreSaved(saved.find((r) => r.path === wt('dirty')).id, { home: m.home });
  assert.deepEqual([back.restored, back.branch], [true, 'dirty']);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(wt('dirty'), 'work.js'), 'utf8'), 'unfinished');
  const env = await restoreSaved(saved.find((r) => r.path === wt('env')).id, { home: m.home });
  assert.equal(env.restored, true);
  assert.equal(await readFile(join(wt('env'), '.env.local'), 'utf8'), 'KEY=1');
});

test('clean --worktrees keeps a copy of ignored local files before git deletes them', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), '.env.local\n'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const tree = join(m.home, '.codex', 'worktrees', 'w1', 'app');
  g(['worktree', 'add', '-q', '--detach', tree, 'main'], repo);
  await writeFile(join(tree, '.env.local'), 'TOKEN=only-copy');
  await ageTree(tree, 30);
  const receipt = await clean(await scan({ ...m.options, worktrees: true }));
  assert.deepEqual(receipt.failed, []);
  assert.equal(await exists(tree), false);
  const [record] = await savedList({ home: m.home });
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(record.kept.dir, '.env.local'), 'utf8'), 'TOKEN=only-copy');
});

test('slots: a budget of working folders, reused across tasks; work left in a slot is saved before reuse', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.codein-tidy.json'), JSON.stringify({ budget: 2 }));
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.codein-tidy.json\nnode_modules/\n');
  const opts = { ...m.options, cwd: repo, home: m.home };
  const a = await takeSlot({ ...opts, branch: 'task-a', holder: 'claude' });
  const b = await takeSlot({ ...opts, branch: 'task-b', holder: 'codex' });
  assert.deepEqual([a.created, b.created, basename(a.path), basename(b.path)], [true, true, '1', '2']);
  assert.equal(a.path, join(`${repo}.slots`, '1'));
  await assert.rejects(takeSlot({ ...opts, branch: 'task-c' }), (e) => e.code === 'OVER_BUDGET' && /budget is 2/.test(e.message));

  // Task A ends with unfinished work and installed dependencies in its slot.
  await writeFile(join(a.path, 'half.js'), 'half done'); await aged(join(a.path, 'node_modules', 'dep', 'i.js'), 0);
  const released = await releaseSlot({ ...opts, path: a.path });
  assert.ok(released.savedId);
  const c = await takeSlot({ ...opts, branch: 'task-c', holder: 'claude' });
  assert.deepEqual([c.reused, c.path], [true, a.path]);
  assert.equal(g(['branch', '--show-current'], c.path), 'task-c');
  assert.equal(await exists(join(c.path, 'half.js')), false, 'the slot is clean for the new task');
  assert.equal(await exists(join(c.path, 'node_modules', 'dep', 'i.js')), true, 'installed dependencies stay');
  assert.equal(g(['worktree', 'list'], repo).split('\n').length, 3, 'still two slots plus the main checkout');

  // The unfinished work of task A is saved and comes back on its branch.
  const back = await restoreSaved(released.savedId, { home: m.home, to: join(m.root, 'restored-a') });
  assert.deepEqual([back.restored, back.branch], [true, 'task-a']);
  const [listed] = await listSlots({ home: m.home });
  assert.deepEqual(listed.slots.map((s) => [s.branch, s.state, s.holder]), [['task-c', 'in use', 'claude'], ['task-b', 'in use', 'codex']]);
});

test('guard: git worktree add is refused at the budget, allowed under it; other commands always pass', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.codein-tidy.json'), JSON.stringify({ budget: 1 }));
  const call = (command, cwd = repo) => guardShell({ tool_name: 'Bash', tool_input: { command }, cwd });
  assert.equal(await call('git worktree add ../a -b a'), null, 'under budget');
  g(['worktree', 'add', '-q', '-b', 'one', join(m.root, 'one')], repo);
  for (const command of ['git worktree add ../b -b b', 'cd x && git worktree add ../b', 'git -c core.x=1 worktree add ../b', `git -C "${repo}" worktree add ../b`])
    assert.match(await call(command, command.includes('-C') ? m.root : repo) ?? '', /budget is 1.*slot take/s, command);
  for (const command of ['git worktree list', 'git worktree remove ../one', 'git status', 'npm test', 'git worktree prune'])
    assert.equal(await call(command), null, command);
  assert.equal(await call('git worktree add ../c', m.root), null, 'outside a git project: allowed');
  assert.equal(await guardShell({}), null);
});

test('rules: added to AGENTS.md once, updated in place, other text kept', async () => {
  const m = await machine();
  const { repo } = await project(m);
  const { readFile } = await import('node:fs/promises');
  await writeFile(join(repo, 'AGENTS.md'), '# Project rules\n\nUse tabs.\n');
  assert.equal((await writeRules(repo)).changed, true);
  assert.equal((await writeRules(repo)).changed, false);
  const text = await readFile(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('# Project rules\n\nUse tabs.\n\n<!-- codein-tidy:start -->'));
  assert.equal(text.split('codein-tidy:start').length, 2);
  assert.ok(text.includes(RULES_BLOCK));
});

test('deps: shared installs are proven by link counts; copies are measured with the cause and the fix', async () => {
  const m = await machine();
  const { link } = await import('node:fs/promises');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const make = async (name, lock) => {
    const repo = join(m.root, name);
    g(['init', '-q', repo], m.root);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(['config', k, v], repo);
    await writeFile(join(repo, lock), 'lock'); await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    g(['add', '.'], repo); g(['commit', '-q', '-m', 'init'], repo);
    return repo;
  };
  // npm: real copies, at the top and in a workspace package; a dot folder's install is not the project's.
  const npmRepo = await make('npmapp', 'package-lock.json');
  for (const dir of ['node_modules', join('apps', 'web', 'node_modules'), join('.vscode-test', 'app', 'node_modules')])
    for (let i = 0; i < 4; i++) await aged(join(npmRepo, dir, `pkg${i}`, 'index.js'), 0, 'n'.repeat(2000));
  const [npm] = await depsReport({ ...m.options, cwd: npmRepo, smallBytes: 0 });
  assert.deepEqual(npm.installs.map((i) => [i.ecosystem, i.shared, i.copiedBytes]).sort(), [['npm', false, 8000], ['npm', false, 8000]]);
  assert.match(formatDeps([npm]), /2 npm install\(s\), 16 KB: npm has no shared store/);
  // pnpm: package files hard-linked to a store are shared.
  const pnpmRepo = await make('pnpmapp', 'pnpm-lock.yaml');
  for (let i = 0; i < 4; i++) {
    const file = join(pnpmRepo, 'node_modules', '.pnpm', `pkg${i}@1.0.0`, 'node_modules', `pkg${i}`, 'index.js');
    await aged(join(m.root, 'store', `f${i}`), 0, 's'.repeat(3000));
    await mkdir(join(file, '..'), { recursive: true }); await link(join(m.root, 'store', `f${i}`), file);
  }
  const [pnpm] = await depsReport({ ...m.options, cwd: pnpmRepo, smallBytes: 0 });
  assert.deepEqual(pnpm.installs.map((i) => [i.ecosystem, i.shared, i.copiedBytes]), [['pnpm', true, 0]]);
  assert.match(formatDeps([pnpm]), /Nothing to fix/);
});
