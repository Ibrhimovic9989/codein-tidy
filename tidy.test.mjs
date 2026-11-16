import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, clean, formatReport, reviewList } from './tidy.mjs';

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
  return { root, home, temp, config, options: { home, temp, os: 'linux', env: { XDG_CONFIG_HOME: config }, running: new Set(), lookup: () => null } };
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
