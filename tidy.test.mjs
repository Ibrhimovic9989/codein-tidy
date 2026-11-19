import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { scan, clean, formatReport, reviewList, unfinishedWork, formatWork, formatNotice, savePlan, saveFolder, savedList, restoreSaved, closePlan, closeFolders, formatClose, takeSlot, releaseSlot, listSlots, guardShell, writeRules, RULES_BLOCK, depsReport, formatDeps, guardRun, guardSchedule, guardInstall, guidedPlan, guidedRun, formatGuided, readAnswer, parseScope, recheckWork, formatForAgent, recordReview, hookWorktreeCreate, hookWorktreeRemove, hookSessionEnd, repairFolder, checkFolder, formatCheck, findSecrets } from './tidy.mjs';

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
  // Nothing unfinished is listed any more (4 worktrees is over the default budget of 3, which the notice still says).
  assert.equal(formatNotice(await unfinishedWork({ ...m.options, cwd: repo })).includes('unfinished work'), false);
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
  // One file holds it all: the local file git ignores and the agent's context, each labelled by what it is.
  assert.deepEqual(saved.extras.files.map((f) => [f.rel, f.role]).sort(), [['.code-in/state/x.json', 'context'], ['.env.local', 'local']]);
  assert.deepEqual([saved.parts.work > 0, saved.parts.local, saved.parts.context, saved.reviewed], [true, 1, 1, false]);
  assert.equal(g(['bundle', 'list-heads', saved.bundle], repo).split('\n').length, 2, 'the work snapshot and the extras, in one bundle');
  assert.equal(await exists(join(m.home, '.codein-tidy', 'kept')), false, 'no loose copies beside the bundle');
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
  assert.equal(await exists(join(tree, '.code-in', 'state', 'x.json')), true, 'agent context comes back too');
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

  // A plain close never takes uncommitted work, not even saved first: it is committed first.
  const plain = await closePlan({ ...m.options, cwd: wt('here'), now: later });
  assert.deepEqual(plain.candidates.map((x) => basename(x.path)).sort(), ['done', 'env']);
  assert.match(plain.folders.find((x) => basename(x.path) === 'dirty').keep, /holds 1 uncommitted file\(s\): commit them first/);
  // Chosen knowingly, it is saved and closed.
  const plan = await closePlan({ ...m.options, cwd: wt('here'), now: later, includeUncommitted: true });
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
  // The one bundle holds what no remote has: the dirty folder's work snapshot, its scratch file, and the env
  // folder's local file. (The env folder's own commit is on the remote already.)
  const heads = g(['bundle', 'list-heads', receipt.bundles[0]], repo).split('\n').map((l) => l.split(' ')[0]);
  const dirty = receipt.saved.find((r) => r.path === wt('dirty')), envSaved = receipt.saved.find((r) => r.path === wt('env'));
  assert.deepEqual(heads.sort(), [dirty.snapshot, dirty.extras.commit, envSaved.extras.commit].sort());
  assert.deepEqual(dirty.extras.files.map((f) => [f.rel, f.role]), [['.tmp-probe.py', 'scratch']]);
  assert.equal(g(['ls-tree', '-r', '--name-only', dirty.snapshot], repo).includes('.tmp-probe'), false, 'the work snapshot holds work only');

  const saved = await savedList({ home: m.home });
  const back = await restoreSaved(saved.find((r) => r.path === wt('dirty')).id, { home: m.home });
  assert.deepEqual([back.restored, back.branch], [true, 'dirty']);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(wt('dirty'), 'work.js'), 'utf8'), 'unfinished');
  assert.equal(await exists(join(wt('dirty'), '.tmp-probe.py')), true, 'the scratch file came back from the same bundle');
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
  assert.deepEqual(record.extras.files.map((f) => [f.rel, f.role]), [['.env.local', 'local']]);
  const back = await restoreSaved(record.id, { home: m.home });
  assert.equal(back.restored, true);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(tree, '.env.local'), 'utf8'), 'TOKEN=only-copy');
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

test('Claude Code hooks: its own worktrees come from the pool, go back to it with work saved, and a session end frees what it held', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.codein-tidy.json'), JSON.stringify({ budget: 2 }));
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.codein-tidy.json\n');
  const opts = { ...m.options, cwd: repo, home: m.home };
  const event = (session, extra = {}) => ({ session_id: session, cwd: repo, hook_event_name: 'WorktreeCreate', ...extra });

  // Two sessions each start a worktree: two slots, on Claude Code's own branch names, from the remote's default branch.
  g(['commit', '-q', '--allow-empty', '-m', 'local only'], repo);
  const a = await hookWorktreeCreate(event('s1', { name: 'bold-oak-a3f2' }), opts);
  const b = await hookWorktreeCreate(event('s2', { name: 'calm-fox' }), opts);
  assert.deepEqual([a.created, a.branch, b.branch], [true, 'worktree-bold-oak-a3f2', 'worktree-calm-fox']);
  assert.equal(g(['rev-parse', 'HEAD'], a.path), g(['rev-parse', 'origin/main'], repo), 'based on origin/HEAD, not the local commit');
  await assert.rejects(hookWorktreeCreate(event('s3', { name: 'third' }), opts), (e) => e.code === 'OVER_BUDGET');

  // Session 1 removes its worktree with unfinished work: the work is saved, the folder stays as an idle slot.
  await writeFile(join(a.path, 'half.js'), 'half done');
  const removed = await hookWorktreeRemove({ session_id: 's1', worktree_path: a.path }, opts);
  assert.ok(removed.released && removed.savedId);

  // Session 3 now gets session 1's folder, clean; session 2 ends and its slot is free for the next one.
  const c = await hookWorktreeCreate(event('s3', { name: 'third' }), opts);
  assert.deepEqual([c.reused, c.path, await exists(join(c.path, 'half.js'))], [true, a.path, false]);
  await writeFile(join(b.path, 'wip.js'), 'not committed');
  assert.deepEqual(await hookSessionEnd({ session_id: 's2', cwd: repo }, opts), { released: 1 });
  const d = await hookWorktreeCreate(event('s4', { name: 'fourth' }), opts);
  assert.equal(d.path, b.path);
  assert.ok(d.savedFirst, 'work session 2 left behind is saved before the folder is reused');
  assert.equal(g(['worktree', 'list'], repo).split('\n').length, 3, 'two slots plus the main checkout, after four sessions');
  const back = await restoreSaved(removed.savedId, { home: m.home, to: join(m.root, 'restored') });
  assert.equal(back.restored, true, 'the unfinished work session 1 left comes back');
});

test('Claude Code hooks: a session end releases only its own slots, and a slot abandoned for a day is reused', async () => {
  const m = await machine();
  const { repo } = await project(m);
  await writeFile(join(repo, '.codein-tidy.json'), JSON.stringify({ budget: 1 }));
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.codein-tidy.json\n');
  const opts = { ...m.options, cwd: repo, home: m.home };
  const a = await hookWorktreeCreate({ session_id: 'crashed', cwd: repo, name: 'a' }, opts);
  assert.deepEqual(await hookSessionEnd({ session_id: 'someone-else' }, opts), { released: 0 });
  assert.deepEqual(await hookSessionEnd({}, opts), { released: 0 }, 'no session id: nothing is released');
  await assert.rejects(hookWorktreeCreate({ session_id: 'next', cwd: repo, name: 'b' }, opts), (e) => e.code === 'OVER_BUDGET');
  // Two days later, nothing in the slot changed: the crashed session no longer holds it.
  const later = Date.now() + 2 * DAY;
  const b = await hookWorktreeCreate({ session_id: 'next', cwd: repo, name: 'b' }, { ...opts, now: later });
  assert.deepEqual([b.reused, b.path], [true, a.path]);
});

test('Claude Code hooks: removing a worktree made before the pool saves its work and local files, then removes it', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const old = join(m.root, 'old-wt');
  g(['worktree', 'add', '-q', '-b', 'old', old], repo);
  await writeFile(join(old, 'wip.js'), 'unsaved'); await writeFile(join(old, '.env.local'), 'SECRET=1');
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.env.local\n');
  const r = await hookWorktreeRemove({ worktree_path: old }, { ...m.options, cwd: repo, home: m.home });
  assert.equal(r.removed, true);
  assert.equal(await exists(old), false);
  const back = await restoreSaved(r.savedId, { home: m.home, to: join(m.root, 'back') });
  assert.equal(back.restored, true);
  assert.equal(await exists(join(m.root, 'back', '.env.local')), true, 'the ignored local file came back too');
  assert.deepEqual(await hookWorktreeRemove({ worktree_path: old }, { ...m.options, home: m.home }), { path: old, removed: true, note: 'already gone' });
});

/** A worktree as a removal that stopped halfway leaves it (seen 2026-11-19): tracked files and .gitignore gone,
 * dependencies still there, an empty stale lock, and optionally the .git link file gone too. */
async function halfRemoved(m, g, repo, name, { brokenLink = true } = {}) {
  const { rm, utimes } = await import('node:fs/promises');
  const tree = join(m.root, 'wt', name);
  g(['worktree', 'add', '-q', '-b', name, tree], repo);
  for (const f of ['b.txt', 'c.txt']) await writeFile(join(tree, f), f);
  g(['add', '.'], tree); g(['commit', '-q', '-m', `${name} files`], tree); g(['push', '-q', '-u', 'origin', name], tree);
  for (const f of ['a.txt', 'b.txt', '.gitignore']) await rm(join(tree, f));
  await aged(join(tree, 'node_modules', 'dep', 'index.js'), 0, 'dependency');
  const gitDir = g(['rev-parse', '--absolute-git-dir'], tree);
  await writeFile(join(gitDir, 'index.lock'), '');
  const old = new Date(Date.now() - 2 * DAY); await utimes(join(gitDir, 'index.lock'), old, old);
  if (brokenLink) await rm(join(tree, '.git'));
  return tree;
}

test('half-removed worktree: found though git calls it prunable, repaired, saved and closed; its branch stays', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const tree = await halfRemoved(m, g, repo, 'half');
  const later = Date.now() + 3 * DAY;
  const [p] = await unfinishedWork({ cwd: repo, now: later });
  const row = p.folders.find((f) => f.path === tree);
  assert.equal(row?.stage, 'broken link', 'not dropped as prunable: its files are still there');

  // Nothing is changed by a plan.
  assert.deepEqual((await repairFolder(tree, { common: join(repo, '.git') })).actions, ['restore the .git link (git worktree repair)']);
  assert.equal(await exists(join(tree, '.git')), false);

  const plan = await closePlan({ ...m.options, cwd: repo, now: later });
  assert.deepEqual(plan.candidates.map((x) => x.path), [tree]);
  const receipt = await closeFolders(plan, { home: m.home, gitRunning: false });
  assert.deepEqual(receipt.failed, []);
  assert.deepEqual(receipt.repaired[0].actions.map((a) => a.split(' from ')[0]),
    ['restore the .git link (git worktree repair)', 'remove a stale empty git lock', 'put back 1 deleted .gitignore file(s)']);
  assert.equal(await exists(tree), false);
  assert.equal(g(['rev-parse', '--verify', 'half'], repo).length, 40, 'the branch and its commit stay');
  assert.equal(receipt.saved.length, 1, 'what was left (the missing files) is recorded by the save');
});

test('half-removed worktree with real work in it: repaired, then refused, nothing removed', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const tree = await halfRemoved(m, g, repo, 'busy');
  await writeFile(join(tree, 'c.txt'), 'changed by someone');
  const plan = await closePlan({ ...m.options, cwd: repo, now: Date.now() + 3 * DAY });
  const receipt = await closeFolders(plan, { home: m.home, gitRunning: false });
  assert.equal(receipt.closed.length, 0);
  assert.match(receipt.failed[0].error, /holds 1 uncommitted file\(s\) \(c\.txt\): commit them first/);
  assert.equal(await (await import('node:fs/promises')).readFile(join(tree, 'c.txt'), 'utf8'), 'changed by someone');
});

test('repair never removes a lock while git runs, or when that cannot be told', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const tree = await halfRemoved(m, g, repo, 'locked', { brokenLink: false });
  for (const gitRunning of [true, null]) {
    const r = await repairFolder(tree, { common: join(repo, '.git'), yes: true, gitRunning });
    assert.match(r.actions[0], /^not removing the git lock/);
    assert.equal(await exists(join(g(['rev-parse', '--absolute-git-dir'], tree), 'index.lock')), true);
  }
});

test('missing tracked files are not work; scratch is never work; secrets are flagged before a commit', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const tree = join(m.root, 'wt', 'mixed');
  g(['worktree', 'add', '-q', '-b', 'mixed', tree], repo);
  await (await import('node:fs/promises')).rm(join(tree, 'a.txt'));
  for (const f of ['.vm-submit-api-f22a6e11b.sh', 'coupon-tests.log', '.understory-runtime-fix.sse', 'codein-src.tar', 'build.log.err'])
    await writeFile(join(tree, f), 'scratch');
  await writeFile(join(tree, '.pre-commit-config.yaml'), 'repos: []');
  await writeFile(join(tree, 'adapter.py'), 'print("real work")');
  await writeFile(join(tree, 'config.js'), `export const token = "ghp_${'a1B2'.repeat(9)}";`);
  const r = await checkFolder(tree);
  assert.deepEqual(r.work.map((w) => w.rel).sort(), ['.pre-commit-config.yaml', 'adapter.py', 'config.js']);
  assert.deepEqual(r.scratch.sort(), ['.understory-runtime-fix.sse', '.vm-submit-api-f22a6e11b.sh', 'build.log.err', 'codein-src.tar', 'coupon-tests.log']);
  assert.equal(r.missing, 1);
  assert.deepEqual(r.work.find((w) => w.rel === 'config.js').secrets, [{ line: 1, what: 'GitHub token' }]);
  assert.match(formatCheck(r), /Do not commit the 1 file\(s\) marked as secrets/);
  const [p] = await unfinishedWork({ cwd: repo });
  const row = p.folders.find((f) => f.path === tree);
  assert.deepEqual([row.changed, row.missingFiles], [3, 1], 'the deletion is counted apart, scratch not at all');
  assert.deepEqual(findSecrets('plain text\nkey = AKIAABCDEFGHIJKLMNOP\n-----BEGIN RSA PRIVATE KEY-----'), [{ line: 2, what: 'AWS access key' }, { line: 3, what: 'private key' }]);
  assert.deepEqual(findSecrets('const x = 1; // sk-short'), []);
});

test('an agent that commits and records a folder hands it back: the fresh commit does not keep it; secrets in that commit are flagged', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const tree = join(m.root, 'wt', 'handed');
  g(['worktree', 'add', '-q', '-b', 'handed', tree], repo);
  const headAt = g(['rev-parse', 'HEAD'], tree);
  await writeFile(join(tree, 'work.js'), `const key = "AKIAABCDEFGHIJKLMNOP";`);
  g(['add', 'work.js'], tree); g(['commit', '-q', '-m', 'work'], tree);
  const opts = { ...m.options, cwd: repo, home: m.home };
  assert.equal((await closePlan(opts)).folders.find((x) => x.path === tree).keep, 'used today');
  await recordReview(tree, { summary: 'a test change', relevant: 'none' }, { home: m.home });
  assert.deepEqual((await closePlan(opts)).candidates.map((x) => x.path), [tree], 'recorded: ready despite the fresh commit');
  // The guided recheck reads the new commit's added lines.
  const item = { notReady: true, changed: 1, identity: { email: 't@example.com' }, close: [{ path: tree, headAt, project: 'app', branch: 'handed' }] };
  await recheckWork({ items: [item] });
  assert.equal(item.selected, false, 'not selected while the commit looks like it holds a secret');
  assert.match(item.warn, /1 line\(s\) that look like secrets \(AWS access key\)/);
});

test('close --only takes exactly the folders named', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const a = join(m.root, 'wt', 'a'), b = join(m.root, 'wt', 'b');
  g(['worktree', 'add', '-q', '--detach', a, 'main'], repo); g(['worktree', 'add', '-q', '--detach', b, 'main'], repo);
  const plan = await closePlan({ ...m.options, cwd: repo, now: Date.now() + 3 * DAY, only: [b.toUpperCase()] });
  assert.deepEqual(plan.candidates.map((x) => x.path), [b]);
  assert.deepEqual(plan.folders.map((x) => x.path), [b]);
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

test('guard close mode brings a project back inside its budget unattended, oldest idle first, work saved', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.codein-tidy.json'), JSON.stringify({ budget: 1 }));
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.codein-tidy.json\n');
  const { utimes } = await import('node:fs/promises');
  const make = async (name, ageDays, dirty) => {
    const tree = join(m.root, 'wt', name);
    g(['worktree', 'add', '-q', '-b', name, tree], repo);
    // Idle time counts the last commit too: give each folder a commit from its own day.
    const date = new Date(Date.now() - ageDays * DAY).toISOString();
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', name], { cwd: tree, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'ignore' });
    if (dirty) await writeFile(join(tree, 'work.js'), name);
    const when = new Date(Date.now() - ageDays * DAY);
    for (const f of await (await import('node:fs/promises')).readdir(tree)) await utimes(join(tree, f), when, when);
    await utimes(tree, when, when);
    return tree;
  };
  const oldest = await make('oldest', 20, true), middle = await make('middle', 10, false), newest = await make('newest', 5, true);
  // Registered as a known project; the commits are new, so judge idleness by "now" a month ahead of the folders.
  await (await import('node:fs/promises')).mkdir(join(m.home, '.codein-tidy'), { recursive: true });
  await writeFile(join(m.home, '.codein-tidy', 'projects.json'), JSON.stringify([repo]));
  const notify = await guardRun({ ...m.options, home: m.home, mode: 'notify' });
  assert.deepEqual(notify.projects.map((p) => [p.linked, p.budget, p.over, p.closed]), [[3, 1, 2, 0]]);
  assert.equal(await exists(oldest), true, 'notify changes nothing');
  // Unattended, the guard closes only folders without uncommitted work; the two holding work stay, over budget.
  const run = await guardRun({ ...m.options, home: m.home, mode: 'close', now: Date.now() + 2 * DAY });
  assert.deepEqual(run.projects.map((p) => [p.linked, p.over, p.closed]), [[2, 1, 1]]);
  assert.deepEqual([await exists(oldest), await exists(middle), await exists(newest)], [true, false, true]);
  assert.equal(await (await import('node:fs/promises')).readFile(join(oldest, 'work.js'), 'utf8'), 'oldest', 'uncommitted work is never closed unattended');
  const { readFile } = await import('node:fs/promises');
  assert.equal(JSON.parse(await readFile(join(m.home, '.codein-tidy', 'guard.json'), 'utf8')).mode, 'close');
});

test('guard install: the scheduler entry for each operating system, and a dry run that changes nothing', async () => {
  const win = guardSchedule({ os: 'win32', home: 'C:/Users/me', node: 'C:/Program Files/nodejs/node.exe' });
  assert.deepEqual(win.install[0][1].slice(0, 9), ['/Create', '/F', '/SC', 'DAILY', '/ST', '12:30', '/TN', 'codein-tidy-guard', '/TR']);
  // The node path holds a space, so it is quoted; the script path is under the given home.
  assert.ok(win.install[0][1][9].startsWith('"C:/Program Files/nodejs/node.exe" '), win.install[0][1][9]);
  assert.ok(win.install[0][1][9].endsWith(' guard --run --mode=notify'), win.install[0][1][9]);
  assert.ok(win.install[0][1][9].includes(join('C:/Users/me', '.codein-tidy', 'bin', 'tidy.mjs')), win.install[0][1][9]);
  const mac = guardSchedule({ os: 'darwin', home: '/Users/me', node: '/usr/local/bin/node', mode: 'close' });
  assert.match(mac.file.body, /<string>guard<\/string><string>--run<\/string><string>--mode=close<\/string>/);
  const linux = guardSchedule({ os: 'linux', home: '/home/me', node: '/usr/bin/node' });
  assert.match(linux.cron, /^30 12 \* \* \* '\/usr\/bin\/node' .*'guard' '--run' '--mode=notify' # codein-tidy-guard$/);
  const m = await machine();
  const dry = await guardInstall({ home: m.home, dryRun: true });
  assert.equal(dry.applied, false);
  assert.equal(await exists(join(m.home, '.codein-tidy', 'bin', 'tidy.mjs')), false);
});

test('every command runs through the real command line (sealed environment)', async () => {
  const m = await machine();
  const { repo } = await project(m);
  const local = join(m.root, 'local'), roaming = join(m.root, 'roaming');
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, TEMP: m.temp, TMP: m.temp, TMPDIR: m.temp, APPDATA: roaming, LOCALAPPDATA: local,
    XDG_CONFIG_HOME: m.config, XDG_CACHE_HOME: join(m.root, 'xdg-cache'), CLAUDE_CONFIG_DIR: join(m.home, '.claude'), CODEX_HOME: join(m.home, '.codex'),
    PLAYWRIGHT_BROWSERS_PATH: join(local, 'ms-playwright'), npm_config_cache: join(m.root, 'npm-cache'), CODEIN_TIDY_PROFILE: '' };
  const run = (...args) => { const r = spawnSync(process.execPath, [join(process.cwd(), 'tidy.mjs'), ...args], { cwd: repo, env, encoding: 'utf8', input: '' }); return r; };
  for (const args of [['work'], ['work', '--notice'], ['saved'], ['slot', 'list'], ['slot', 'take', '--branch=cli-task'], ['slot', 'list'], ['rules'], ['deps'],
    ['guard'], ['guard', '--install', '--dry-run'], ['close'], [`save`, `--project=${repo}`], ['guard-shell'], ['review']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.match(run('slot', 'list').stdout, /cli-task/);
});

test('close finishes a folder git dropped but could not delete (Windows: path too long), now and from earlier runs', { skip: process.platform !== 'win32' }, async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n'); g(['add', '.'], repo); g(['commit', '-q', '-m', 'ignore'], repo); g(['push', '-q', 'origin', 'main'], repo);
  const store = join(m.root, 'store', 'pkg'); await aged(join(store, 'i.js'), 0, 'shared');
  const make = async (name) => {
    const tree = join(m.root, 'wt', name);
    g(['worktree', 'add', '-q', '-b', name, tree], repo);
    await writeFile(join(tree, 'work.js'), name);
    await mkdir(join(tree, 'node_modules'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(store, join(tree, 'node_modules', 'pkg'), 'junction');
    // Deeper than Windows' 260-character limit: git's own delete stops here.
    let deep = join(tree, 'node_modules', 'deep'); for (let i = 0; i < 30; i++) deep = join(deep, 'segment');
    await mkdir(deep, { recursive: true }); await writeFile(join(deep, 'f.txt'), 'x');
    return tree;
  };
  const a = await make('a');
  const plan = await closePlan({ ...m.options, cwd: repo, now: Date.now() + 3 * DAY, includeUncommitted: true });
  const receipt = await closeFolders(plan, { home: m.home });
  assert.deepEqual(receipt.failed, []);
  assert.equal(await exists(a), false, 'finished after git stopped at the long path');
  assert.equal(await exists(join(store, 'i.js')), true, 'the junction target is never followed');
  assert.ok((await savedList({ home: m.home })).some((r) => r.path === a), 'its work was saved first');

  // A leftover from an earlier run: saved, dropped by git, files still there.
  const b = await make('b');
  const saved = await saveFolder(b, { home: m.home });
  // git stops at the long path, as on the founder's machine: it fails, drops the worktree, leaves the files.
  assert.throws(() => g(['worktree', 'remove', '--force', b], repo));
  assert.equal(await exists(b), true);
  const again = await closePlan({ ...m.options, cwd: repo, home: m.home });
  assert.deepEqual(again.candidates.filter((x) => x.leftover).map((x) => x.path), [b]);
  assert.match(formatClose(again), /1 folder\(s\) an earlier close saved but could not finish deleting/);
  const r2 = await closeFolders(again, { home: m.home });
  assert.deepEqual(r2.failed, []);
  assert.equal(await exists(b), false);
  assert.equal(await exists(join(store, 'i.js')), true);
  assert.ok(saved.saved);

  // A clean folder (nothing to save) that git dropped half-way is finished too: close logged it before letting go.
  const c = join(m.root, 'wt', 'c');
  g(['worktree', 'add', '-q', '--detach', c, 'main'], repo);
  let deep = join(c, 'node_modules', 'deep'); for (let i = 0; i < 30; i++) deep = join(deep, 'segment');
  await mkdir(deep, { recursive: true }); await writeFile(join(deep, 'f.txt'), 'x');
  const r3 = await closeFolders(await closePlan({ ...m.options, cwd: repo, home: m.home, now: Date.now() + 3 * DAY }), { home: m.home });
  assert.deepEqual(r3.failed, []);
  assert.equal(await exists(c), false);
});

test('guided: one command scans, shows a review list, takes a selection and one yes, saves work, frees space', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const idle = join(m.root, 'wt', 'idle');
  g(['worktree', 'add', '-q', '-b', 'idle', idle], repo);
  await writeFile(join(idle, 'half.js'), 'unfinished');
  await ageTree(idle, 5);
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10);
  await aged(join(m.home, '.codex', 'archived_sessions', 'old.jsonl'), 90);
  await aged(join(repo, '.tmp-probe.py'), 10);
  const { PassThrough } = await import('node:stream');
  const run = async (answers) => {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', (d) => { text += d; });
    const done = guidedRun({ input, output, options: { ...m.options, cwd: repo, home: m.home, now: Date.now() + 2 * DAY } });
    for (const a of answers) input.write(a + '\n');
    input.end();
    return { result: await done, text };
  };

  // Quit changes nothing; the list shows each item with its size, history is not preselected, and a folder
  // holding uncommitted work is "not ready": listed apart and never preselected.
  const quit = await run(['q']);
  assert.equal(quit.result.done, false);
  assert.match(quit.text, /Not ready yet \(uncommitted work.*\):\n +\[ \] +\d+ +.*idle \(app\): 1 uncommitted file\(s\)/);
  assert.match(quit.text, /\[ \] +\d+ +.*Old chat history/);
  assert.match(quit.text, /\[x\] +\d+ +.*Agent leftovers in this project/);
  assert.equal(await exists(idle), true);

  // Details, then select the folder anyway (its work is then saved as a snapshot), go on, yes.
  const n = /\[ \] +(\d+) +\S+ \S+ +idle \(app\)/.exec(quit.text)[1];
  const go = await run([`d ${n}`, n, '', 'y']);
  assert.equal(go.result.done, true, go.text);
  assert.ok(go.text.includes(idle), 'the details list the folder');
  assert.equal(await exists(idle), false, 'the idle worktree is gone');
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old.sh')), false, 'old snapshots freed');
  assert.equal(await exists(join(m.home, '.codex', 'archived_sessions', 'old.jsonl')), true, 'history kept: not selected');
  assert.equal(await exists(join(repo, '.tmp-probe.py')), false, 'leftover moved to trash');
  assert.match(go.text, /Done\. About .* freed\. Work from 1 folder\(s\) saved in:/);
  const [saved] = await savedList({ home: m.home });
  const back = await restoreSaved(saved.id, { home: m.home });
  assert.equal(back.restored, true);

  // Switching an item by number, then answering no, changes nothing.
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old2.sh'), 10);
  const no = await run(['', 'n']);
  assert.equal(no.result.done, false);
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old2.sh')), true);
});

test('guided: plain words work at the prompt (the answers a person really typed)', async () => {
  // Typed by the founder on 0.4.0, where every word was read as item numbers and silently ignored.
  for (const t of ['', 'go', 'Go on with the selected items', 'yes', 'ok', 'continue', 'go ahead.']) assert.equal(readAnswer(t).action, 'go', t);
  for (const t of ['a', 'all', 'All', 'select all']) assert.equal(readAnswer(t).action, 'all', t);
  for (const t of ['n', 'none', 'clear']) assert.equal(readAnswer(t).action, 'none', t);
  for (const t of ['q', 'quit', 'exit', 'cancel']) assert.equal(readAnswer(t).action, 'quit', t);
  assert.deepEqual(readAnswer('2 3 4 5 6 7'), { action: 'switch', numbers: [2, 3, 4, 5, 6, 7] });
  assert.deepEqual(readAnswer('1,7'), { action: 'switch', numbers: [1, 7] });
  assert.deepEqual(readAnswer('details 2'), { action: 'detail', n: 2 });
  assert.equal(readAnswer('yes 2').action, 'unknown', 'a number never counts as go');
  assert.equal(readAnswer('banana').action, 'unknown');

  const m = await machine();
  const { repo } = await project(m);
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10);
  await aged(join(m.home, '.codex', 'archived_sessions', 'old.jsonl'), 90);
  const { PassThrough } = await import('node:stream');
  const run = async (answers) => {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', (d) => { text += d; });
    const done = guidedRun({ input, output, options: { ...m.options, cwd: repo, home: m.home, now: Date.now() + 2 * DAY } });
    for (const a of answers) input.write(a + '\r\n');
    input.end();
    return { result: await done, text };
  };

  // Not understood: said so, nothing changed. An empty yes/no answer asks again instead of giving up.
  const unclear = await run(['banana', '', '', 'n']);
  assert.equal(unclear.result.done, false);
  assert.match(unclear.text, /Not sure what "banana" means/);
  assert.match(unclear.text, /Type y or n\./);
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old.sh')), true);

  // The founder's words: select all, then go on, then yes. Everything selected is freed, history included.
  const words = await run(['all', 'go on with the selected items', 'yes']);
  assert.equal(words.result.done, true, words.text);
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old.sh')), false);
  assert.equal(await exists(join(m.home, '.codex', 'archived_sessions', 'old.jsonl')), false);
});

test('guided in a terminal: arrow keys and space pick, Enter confirms, live progress while it works', async () => {
  const m = await machine();
  const { repo } = await project(m);
  const snap = join(m.home, '.claude', 'shell-snapshots', 'old.sh'), chat = join(m.home, '.codex', 'archived_sessions', 'old.jsonl');
  await aged(snap, 10);
  await aged(chat, 90);
  const { PassThrough } = await import('node:stream');
  const UP = '\x1b[A', DOWN = '\x1b[B', RIGHT = '\x1b[C', ENTER = '\r', SPACE = ' ';
  const run = async (keys) => {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    input.isTTY = true; input.setRawMode = () => input;
    output.isTTY = true; output.columns = 140; output.rows = 40;
    output.on('data', (d) => { text += d; });
    const done = guidedRun({ input, output, options: { ...m.options, cwd: repo, home: m.home, now: Date.now() + 2 * DAY, scope: { kind: 'computer' } } });
    for (const k of keys) input.write(k);
    input.end();
    const result = await done;
    return { result, text, plain: text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
  };

  // Look, open details, quit: nothing changes. The scan showed a live line; the list has sizes and the key help.
  const look = await run([DOWN, UP, RIGHT, 'q']);
  assert.equal(look.result.done, false);
  assert.match(look.plain, /Looking at what AI coding tools left|Measuring what AI coding tools keep/);
  assert.match(look.plain, /> \[x\] +\d/, 'the cursor sits on a selected item');
  assert.match(look.plain, /\[ \] .*Old chat history/);
  assert.match(look.plain, /Up\/Down move +Space select +A all +Right details +Enter continue +Q quit/);
  assert.match(look.plain, /Nothing was changed/);
  assert.equal(await exists(snap), true);

  // Nothing selected and Enter: it says so instead of going on. Then Q.
  const none = await run(['n', ENTER, 'q']);
  assert.match(none.plain, /Nothing is selected\. Press Space on an item, or A for all\./);
  assert.equal(none.result.done, false);

  // Enter, then "No: back to the list" (down, Enter), then Q: nothing changes.
  const back = await run([ENTER, DOWN, ENTER, 'q']);
  assert.match(back.plain, /Yes: free about/);
  assert.equal(back.result.done, false);
  assert.equal(await exists(snap), true);

  // Space on the last item (history) by going up from the top, Enter, Enter on Yes: both are freed, with a bar.
  const go = await run([UP, SPACE, ENTER, ENTER]);
  assert.equal(go.result.done, true, go.plain);
  assert.match(go.plain, /Old chat history will be deleted for good/);
  assert.match(go.plain, /Freeing caches, logs and leftovers/);
  assert.match(go.plain, /✓ Freed caches, logs and leftovers/);
  assert.match(go.plain, /Done\. About .* freed\./);
  assert.equal(await exists(snap), false);
  assert.equal(await exists(chat), false);
});

test('scope: asked first; computer, chosen drives or this project only', async () => {
  assert.deepEqual(parseScope('computer'), { kind: 'computer' });
  assert.deepEqual(parseScope('project'), { kind: 'project' });
  assert.deepEqual(parseScope('drive:c,D'), { kind: 'drives', drives: ['C:', 'D:'] });
  assert.deepEqual(parseScope('drives=d'), { kind: 'drives', drives: ['D:'] });
  assert.equal(parseScope('everything-ish'), null);

  const m = await machine();
  const { g, repo } = await project(m);
  const done = join(m.root, 'wt', 'done');
  g(['worktree', 'add', '-q', '--detach', done, 'main'], repo);
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10);
  await aged(join(repo, '.tmp-probe.py'), 10);
  const base = { ...m.options, cwd: repo, home: m.home, now: Date.now() + 2 * DAY };
  const keys = async (scope) => (await guidedPlan({ ...base, scope })).items.map((i) => i.key).sort();

  assert.deepEqual(await keys({ kind: 'computer' }), ['cleanup:claude-code', 'leftovers', 'worktrees:app']);
  // This project only: its worktrees and leftovers, none of the tools' own data.
  assert.deepEqual(await keys({ kind: 'project' }), ['leftovers', 'worktrees:app']);
  // A folder left over from ANOTHER project's close is not part of this project (seen on a real machine).
  const other = join(m.root, 'other'), gone = join(m.root, 'wt', 'other-gone');
  await mkdir(other, { recursive: true }); g(['init', '-q', '-b', 'main', other], m.root);
  await aged(join(gone, 'node_modules', 'left.js'), 0);
  await mkdir(join(m.home, '.codein-tidy'), { recursive: true });
  await writeFile(join(m.home, '.codein-tidy', 'closed.jsonl'), JSON.stringify({ path: gone, common: join(other, '.git'), savedId: null, at: new Date().toISOString() }) + '\n');
  assert.deepEqual(await keys({ kind: 'computer' }), ['cleanup:claude-code', 'leftovers', 'worktrees:app', 'worktrees:other']);
  assert.deepEqual(await keys({ kind: 'project' }), ['leftovers', 'worktrees:app']);
  await (await import('node:fs/promises')).rm(join(m.home, '.codein-tidy', 'closed.jsonl'));
  // Drives: only what sits on the named drives.
  const here = /^([A-Za-z]:)/.exec(m.root)?.[1].toUpperCase() ?? '/';
  assert.deepEqual(await keys({ kind: 'drives', drives: [here] }), ['cleanup:claude-code', 'leftovers', 'worktrees:app']);
  assert.deepEqual(await keys({ kind: 'drives', drives: ['Q:'] }), []);
  await assert.rejects(guidedPlan({ ...base, cwd: m.root, scope: { kind: 'project' } }), /not inside a git project/);

  // In a terminal the first screen is the scope; drives can be ticked, one or several.
  const { PassThrough } = await import('node:stream');
  const run = async (pressed) => {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    input.isTTY = true; input.setRawMode = () => input;
    output.isTTY = true; output.columns = 140; output.rows = 40;
    output.on('data', (d) => { text += d; });
    const result = guidedRun({ input, output, options: { ...base, driveList: [{ drive: here, free: 5e9, total: 9e9 }, { drive: 'Q:', free: 1e9, total: 2e9 }] } });
    for (const k of pressed) input.write(k);
    input.end();
    return { result: await result, plain: text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
  };
  const DOWN = '\x1b[B', ENTER = '\r';
  const project1 = await run([DOWN, DOWN, ENTER, 'q']);
  assert.match(project1.plain, /Where should it look\?/);
  assert.match(project1.plain, /This computer +everything AI coding tools left/);
  assert.match(project1.plain, /can be freed in this project/);
  assert.doesNotMatch(project1.plain, /Claude Code: shell snapshots/);
  const drives = await run([DOWN, ENTER, ENTER, DOWN, ' ', ENTER, 'q']);
  assert.match(drives.plain, /Which drives\?/);
  assert.match(drives.plain, /No drive is selected\. Press Space on a drive\./);
  assert.match(drives.plain, /Nothing to free on drive Q:/);
});

test('not ready: uncommitted work goes to a coding agent, is checked afterwards, and the list updates', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const wip = join(m.root, 'wt', 'wip');
  g(['worktree', 'add', '-q', '-b', 'wip', wip], repo);
  await writeFile(join(wip, 'feature.js'), 'half done');
  await ageTree(wip, 5);
  const base = { ...m.options, cwd: repo, home: m.home, now: Date.now() + 2 * DAY, scope: { kind: 'computer' } };

  // The plan: not ready, never preselected, with the git identity the folder commits as.
  const plan = await guidedPlan(base);
  const item = plan.items.find((i) => i.notReady);
  assert.deepEqual([item.key, item.selected, item.changed, item.identity.email], ['work:app:wip', false, 1, 't@example.com']);
  const text = formatForAgent(plan);
  assert.match(text, /Not ready yet \(uncommitted work\):\n +\[ \] +work:app:wip/);
  assert.match(text, /never change git config, never pass --author, never push/);
  assert.match(text, /commits as t <t@example\.com>/);
  assert.match(text, /record --project=<folder> --summary=/);
  assert.match(text, /--scope=computer --apply=<names/);

  // Ground truth after the agent: work that vanished without a commit is flagged, never called ready.
  g(['stash', '-u', '-q'], wip);
  assert.equal(await recheckWork(plan), true);
  assert.deepEqual([item.notReady, item.selected], [true, false]);
  assert.match(item.warn, /gone but nothing was committed/);
  g(['stash', 'pop', '-q'], wip);
  // A commit under another account is accepted but said out loud.
  const plan2 = await guidedPlan(base), item2 = plan2.items.find((i) => i.notReady);
  g(['add', '-A'], wip); g(['-c', 'user.email=other@example.com', 'commit', '-q', '-m', 'wrong account'], wip);
  await recheckWork(plan2);
  assert.deepEqual([item2.notReady, item2.selected], [false, true]);
  assert.match(item2.warn, /committed as other@example\.com, this folder's identity is t@example\.com/);
  g(['reset', '-q', '--soft', 'HEAD~1'], wip); g(['reset', '-q'], wip);

  // In a terminal: hand the folder to an agent installed here. A stand-in agent reads the task and commits.
  const script = join(m.root, 'fake-agent.cjs'), seen = join(m.root, 'task-seen.md');
  await writeFile(script, `const { execFileSync } = require('node:child_process'); let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(seen)}, s);
  execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-q', '-m', 'agent: finish the feature']); console.log('committed the feature'); });`);
  const agents = [{ name: 'Stand-in Agent', bin: process.execPath, direct: true, stdin: true, args: () => [script] }];
  const { PassThrough } = await import('node:stream');
  const start = (extra = {}) => {
    const input = new PassThrough(), output = new PassThrough(); const state = { text: '' };
    input.isTTY = true; input.setRawMode = () => input;
    output.isTTY = true; output.columns = 160; output.rows = 50;
    output.on('data', (d) => { state.text += d; });
    const plain = () => state.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const until = async (pattern) => { for (let i = 0; i < 150; i++) { if (pattern.test(plain())) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`never showed ${pattern}:\n${plain()}`); };
    return { input, plain, until, result: guidedRun({ input, output, options: { ...base, agents, ...extra } }) };
  };
  const ENTER = '\r', DOWN = '\x1b[B';
  const run = start();
  await run.until(/1 worktree\(s\) are not ready/);
  assert.match(run.plain(), /Hand them to Stand-in Agent now/);
  run.input.write(ENTER);                       // hand it over
  await run.until(/wip: committed/);
  await run.until(/wip \(app\) +work committed, ready: save, then remove/);
  run.input.write(ENTER);                       // continue with the list (the folder is now selected)
  await run.until(/Yes: save the work of 1 folder/);
  assert.match(run.plain(), /saved[\\/]app-.*\.bundle/, 'the file the work goes into is named before anything is removed');
  run.input.write(ENTER);                       // yes
  run.input.end();
  const done = await run.result;
  assert.equal(done.done, true, run.plain());
  const { readFile } = await import('node:fs/promises');
  const task = await readFile(seen, 'utf8');
  assert.match(task, /never change git config, never pass --author, never push/);
  assert.ok(task.includes(wip));
  assert.equal(g(['log', '-1', '--format=%s %ae', 'wip'], repo), 'agent: finish the feature t@example.com', 'the commit is on the branch, as the folder\'s own account');
  assert.equal(await exists(wip), false, 'then the folder was saved and removed');

  // Or: copy the task for the person's own agent. The list then updates by itself when that agent commits.
  const wip2 = join(m.root, 'wt', 'wip2');
  g(['worktree', 'add', '-q', '-b', 'wip2', wip2], repo);
  await writeFile(join(wip2, 'other.js'), 'half done');
  await ageTree(wip2, 5);
  let copied = '';
  const own = start({ agents: [], copy: (t) => { copied = t; return true; } });
  await own.until(/Copy the task for my own agent/);
  own.input.write(ENTER);                       // with no agent installed, the first choice is the copy
  await own.until(/The task is on the clipboard and saved in/);
  assert.ok(copied.includes(wip2));
  assert.match(own.plain(), /Not ready yet: uncommitted work/);
  g(['add', '-A'], wip2); g(['commit', '-q', '-m', 'done by my own agent'], wip2);
  await own.until(/wip2 \(app\) +work committed, ready/);   // nobody pressed a key: it looked again by itself
  own.input.write('q'); own.input.end();
  assert.equal((await own.result).done, false);
  assert.equal(await exists(wip2), true);
});

test('record: an agent says what the work was and which context matters; every file is still kept whole', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const tree = join(m.root, 'wt', 'topic');
  g(['worktree', 'add', '-q', '-b', 'topic', tree], repo);
  await writeFile(join(tree, 'work.js'), 'the work');
  await aged(join(tree, '.claude', 'plan.md'), 0, 'the plan that explains the work');
  await aged(join(tree, '.tmp-notes.txt'), 0, 'scratch');
  await aged(join(tree, 'screenshot-1.png'), 0, 'png');
  await assert.rejects(recordReview(tree, { summary: '', relevant: 'all' }, { home: m.home }), /a summary is needed/);
  await assert.rejects(recordReview(tree, { summary: 'x', relevant: ['nope.md'] }, { home: m.home }), /not found in this folder: nope\.md/);
  await assert.rejects(recordReview(tree, { summary: 'x', relevant: ['../outside'] }, { home: m.home }), /not found in this folder/);
  const review = await recordReview(tree, { summary: 'Adds the topic feature; half done, tests missing.', relevant: ['.claude/plan.md'] }, { home: m.home });
  assert.deepEqual(review.relevant, ['.claude/plan.md']);

  const saved = await saveFolder(tree, { home: m.home });
  assert.equal(saved.saved, true);
  assert.deepEqual([saved.summary, saved.reviewed, saved.madeBy], ['Adds the topic feature; half done, tests missing.', true, 'git command']);
  // The agent's call is a label. Nothing it left unmarked is dropped.
  assert.deepEqual(saved.extras.files.map((f) => [f.rel, f.role, f.relevant]).sort(),
    [['.claude/plan.md', 'context', true], ['.tmp-notes.txt', 'scratch', false], ['screenshot-1.png', 'scratch', false]]);
  assert.deepEqual([saved.parts.work, saved.parts.context, saved.parts.scratch, saved.parts.relevant, saved.parts.tooLarge], [1, 1, 2, 1, []]);
  assert.deepEqual(g(['ls-tree', '-r', '--name-only', saved.snapshot], repo).split('\n').sort(), ['a.txt', 'work.js'], 'the work snapshot holds work only');
  g(['worktree', 'remove', '--force', tree], repo);
  const back = await restoreSaved(saved.id, { home: m.home });
  assert.equal(back.restored, true);
  for (const rel of ['work.js', '.claude/plan.md', '.tmp-notes.txt', 'screenshot-1.png']) assert.equal(await exists(join(tree, rel)), true, rel);
});

test('guided for an agent: the bare command lists named items and how to apply; --apply does only what was named', async () => {
  const m = await machine();
  const { g, repo } = await project(m);
  const idle = join(m.root, 'wt', 'idle');
  g(['worktree', 'add', '-q', '-b', 'idle', idle], repo);
  await writeFile(join(idle, 'half.js'), 'unfinished');
  await aged(join(m.home, '.claude', 'shell-snapshots', 'old.sh'), 10);
  const local = join(m.root, 'local'), roaming = join(m.root, 'roaming');
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, TEMP: m.temp, TMP: m.temp, TMPDIR: m.temp, APPDATA: roaming, LOCALAPPDATA: local,
    XDG_CONFIG_HOME: m.config, XDG_CACHE_HOME: join(m.root, 'xdg-cache'), CLAUDE_CONFIG_DIR: join(m.home, '.claude'), CODEX_HOME: join(m.home, '.codex'),
    PLAYWRIGHT_BROWSERS_PATH: join(local, 'ms-playwright'), npm_config_cache: join(m.root, 'npm-cache'), CODEIN_TIDY_PROFILE: '' };
  const run = (...args) => spawnSync(process.execPath, [join(process.cwd(), 'tidy.mjs'), ...args], { cwd: repo, env, encoding: 'utf8', input: '' });
  // First the scope: the choices and the command for each, nothing measured yet.
  const asked = run();
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.stdout, /choose the scope first\. Ask the person/);
  assert.match(asked.stdout, /--scope=computer/);
  assert.match(asked.stdout, /--scope=project +only this project/);
  assert.doesNotMatch(asked.stdout, /cleanup:claude-code/);
  assert.equal(run('--scope=nonsense').status, 2);
  const listed = run('--scope=computer');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /cleanup:claude-code/);
  assert.match(listed.stdout, /--scope=computer --apply=<names/);
  assert.doesNotMatch(run('--scope=project').stdout, /cleanup:claude-code/);
  assert.match(listed.stdout, /Never run --apply without the person's answer/);
  const json = JSON.parse(run('--json').stdout);
  assert.ok(json.some((i) => i.key === 'cleanup:claude-code' && i.suggested === true));
  // The worktree was changed minutes ago (in use now), so it is not offered; the named item alone is done.
  const applied = run('--scope=computer', '--apply=cleanup:claude-code,history');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Not found now .*history/);
  assert.match(applied.stdout, /Done\. About .* freed\./);
  assert.equal(await exists(join(m.home, '.claude', 'shell-snapshots', 'old.sh')), false);
  assert.equal(await exists(join(idle, 'half.js')), true, 'nothing that was not named');
});
