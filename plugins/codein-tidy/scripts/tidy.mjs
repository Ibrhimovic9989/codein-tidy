#!/usr/bin/env node
/**
 * codein-tidy: see and safely free the disk space AI coding tools leave behind.
 * Claude Code, Codex, Cursor and Antigravity. Made by code.in (https://code.in).
 *
 * Safety rules, in order:
 *   1. `report` (the default) only reads.
 *   2. `clean` prints a plan; nothing is removed without `--yes`.
 *   3. By default only rebuildable data is removed (caches, snapshots, logs, recordings), and only once it
 *      is older than its age limit. Chat history needs `--history`. Worktrees need `--worktrees`, and even
 *      then only clean ones: no uncommitted changes and the checked-out commit exists on a remote.
 *   4. App caches are skipped while that app is running.
 *   5. Nothing outside the listed folders is touched; symlinks are never followed.
 */
import { promises as fs, copyFileSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60_000;
// Measuring is millions of small file-system calls; Node runs them on a pool of 4 threads by default. The pool
// is created by the first call, so this must run before any. (Inside a host that already used the pool it is a
// harmless no-op.)
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';

/** Where each OS keeps application data. */
function appData(env, os, home) {
  if (os === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  if (os === 'darwin') return join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/**
 * Every place we know about. kind:
 *   entries   remove direct children older than ageDays (by newest change two levels deep)
 *   whole     remove the folder's contents when the app is closed
 *   versions  keep the newest child, remove the rest
 *   worktrees remove clean git worktrees older than ageDays (needs --worktrees)
 *   report    measure only, never remove
 * class: cache (rebuildable), history (someone may want it), work (may hold uncommitted work)
 */
export function targets({ home = homedir(), temp = tmpdir(), env = process.env, os = platform() } = {}) {
  const claude = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const codex = env.CODEX_HOME ?? join(home, '.codex');
  const app = appData(env, os, home);
  const ag = join(home, '.gemini');
  return [
    // Claude Code. Its own setting `cleanupPeriodDays` also prunes much of this; we add the temp folder.
    { tool: 'Claude Code', item: 'Shell snapshots', path: join(claude, 'shell-snapshots'), kind: 'entries', class: 'cache', ageDays: 7 },
    { tool: 'Claude Code', item: 'Paste cache', path: join(claude, 'paste-cache'), kind: 'entries', class: 'cache', ageDays: 7 },
    { tool: 'Claude Code', item: 'Debug logs', path: join(claude, 'debug'), kind: 'entries', class: 'cache', ageDays: 7 },
    { tool: 'Claude Code', item: 'Session environments', path: join(claude, 'session-env'), kind: 'entries', class: 'cache', ageDays: 7 },
    // Per-session scratch folders only (<project-hash>/<session-id>); the app's own files there are left alone.
    { tool: 'Claude Code', item: 'Session temp folders', path: join(temp, 'claude'), kind: 'entries', class: 'cache', ageDays: 7, deepAgeDays: 1,
      match: /^[0-9a-f]{16}$/, level: 2 },
    { tool: 'Claude Code', item: 'Edit diff snapshots', path: join(temp, 'claude', 'bash-edit-diff'), kind: 'entries', class: 'cache', ageDays: 7, deepAgeDays: 1 },
    { tool: 'Claude Code', item: 'File edit history (undo)', path: join(claude, 'file-history'), kind: 'entries', class: 'history', ageDays: 30 },
    { tool: 'Claude Code', item: 'Chat transcripts', path: join(claude, 'projects'), kind: 'report', class: 'history',
      tip: 'Claude Code prunes these itself: set "cleanupPeriodDays" in ~/.claude/settings.json.' },
    // Codex.
    { tool: 'Codex', item: 'Worktrees', path: join(codex, 'worktrees'), kind: 'worktrees', class: 'work', ageDays: 14, deepAgeDays: 3 },
    { tool: 'Codex', item: 'Temp files', path: join(codex, 'tmp'), kind: 'entries', class: 'cache', ageDays: 7, deepAgeDays: 1 },
    { tool: 'Codex', item: 'Chat sessions', path: join(codex, 'sessions'), kind: 'entries', class: 'history', ageDays: 30, depth: 3 },
    { tool: 'Codex', item: 'Archived sessions', path: join(codex, 'archived_sessions'), kind: 'entries', class: 'history', ageDays: 30 },
    { tool: 'Codex', item: 'Logs', path: join(codex, 'log'), kind: 'entries', class: 'cache', ageDays: 7 },
    { tool: 'Codex', item: 'Cache', path: join(codex, 'cache'), kind: 'entries', class: 'cache', ageDays: 7 },
    { tool: 'Codex', item: 'Log database', path: join(codex, 'logs_2.sqlite'), kind: 'report', class: 'cache', tip: 'In use while Codex runs; not removed.' },
    // Cursor (paths from Cursor's docs and forum reports).
    { tool: 'Cursor', item: 'Chat database backup', path: join(app, 'Cursor', 'User', 'globalStorage', 'state.vscdb.backup'), kind: 'whole', class: 'cache', app: 'cursor' },
    { tool: 'Cursor', item: 'Chat database', path: join(app, 'Cursor', 'User', 'globalStorage', 'state.vscdb'), kind: 'report', class: 'history',
      tip: 'Never delete this file by hand: Cursor loses its chats.' },
    { tool: 'Cursor', item: 'Old app versions', path: join(app, 'Cursor', 'CachedData'), kind: 'versions', class: 'cache', app: 'cursor' },
    { tool: 'Cursor', item: 'Logs', path: join(app, 'Cursor', 'logs'), kind: 'entries', class: 'cache', ageDays: 7 },
    { tool: 'Cursor', item: 'Worktrees', path: join(home, '.cursor', 'worktrees'), kind: 'worktrees', class: 'work', ageDays: 14, deepAgeDays: 3, depth: 2 },
    // Antigravity.
    ...['antigravity', 'antigravity-ide'].flatMap((name) => [
      { tool: 'Antigravity', item: `Browser recordings (${name})`, path: join(ag, name, 'browser_recordings'), kind: 'entries', class: 'cache', ageDays: 7, deepAgeDays: 1 },
      { tool: 'Antigravity', item: `Agent scratch files (${name})`, path: join(ag, name, 'scratch'), kind: 'entries', class: 'cache', ageDays: 7, deepAgeDays: 1 },
      { tool: 'Antigravity', item: `Agent memory and chats (${name})`, path: join(ag, name, 'brain'), kind: 'report', class: 'history',
        tip: 'The only copy of your Antigravity chats; not removed.' },
    ]),
    ...['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'].map((name) =>
      ({ tool: 'Antigravity', item: `App cache (${name})`, path: join(app, 'Antigravity', name), kind: 'whole', class: 'cache', app: 'antigravity' })),
    { tool: 'Antigravity', item: 'App logs', path: join(app, 'Antigravity', 'logs'), kind: 'entries', class: 'cache', ageDays: 7 },
  ];
}

async function lstat(path) { return fs.lstat(path).catch(() => null); }

/**
 * Size of a tree. `bytes` counts each file once even when it has several names (pnpm hard-links every
 * package file into each worktree). `freeable` counts only files with no other name: deleting a file that
 * is also linked from somewhere else gives no space back. Symlinks and junctions are never followed.
 */
async function measure(path, seen = new Set(), memo = null, depth = 0) {
  const stat = await fs.lstat(path, { bigint: true }).catch(() => null);
  if (!stat) return { bytes: 0, files: 0, freeable: 0 };
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0, freeable: 0 };
  if (!stat.isDirectory()) {
    const size = Number(stat.size), key = stat.ino ? `${stat.dev}:${stat.ino}` : null;
    if (key && seen.has(key)) return { bytes: 0, files: 1, freeable: 0 };
    if (key) seen.add(key);
    return { bytes: size, files: 1, freeable: stat.nlink <= 1n ? size : 0 };
  }
  return measureDir(path, seen, memo, depth);
}

/** A folder's total. The listing already says which entries are folders and links, so only files are stat'ed. */
async function measureDir(path, seen, memo, depth) {
  let bytes = 0, files = 0, freeable = 0;
  const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => []);
  // pnpm's node_modules holds hard links into its store: removing it frees almost nothing, and walking its
  // hundreds of thousands of files is most of the time a report takes. Skip it when sampled files are shared.
  if (path.split(/[\\/]/).pop() === 'node_modules' && entries.some((e) => e.name === '.pnpm') && await pnpmLinked(join(path, '.pnpm'))) {
    const result = { bytes: 0, files: 0, freeable: 0, sharedModules: 1 };
    if (memo && depth <= 3) memo.set(resolve(path), result);
    return result;
  }
  // node_modules is most of a checkout's files. When its package files are plain copies, let Windows list it
  // faster. Hard links shared between checkouts must be counted once, which only the exact walk can do, so a
  // single linked file in the sample keeps the walk.
  if (path.split(/[\\/]/).pop() === 'node_modules' && platform() === 'win32') {
    const samples = await packageLinks(entries.some((e) => e.name === '.pnpm') ? join(path, '.pnpm') : path, 12);
    if (samples.length >= 3 && !samples.some((n) => n >= 2n)) {
      const listed = await listedTotals(path);
      if (listed) {
        const result = { bytes: listed.bytes, files: listed.files, freeable: listed.bytes };
        if (memo && depth <= 3) memo.set(resolve(path), result);
        return result;
      }
    }
  }
  const one = (entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) return { bytes: 0, files: 0, freeable: 0 };
    if (entry.isDirectory()) return measureDir(child, seen, memo, depth + 1);
    return measure(child, seen, memo, depth + 1); // files, and anything the listing could not type
  };
  let sharedModules = 0;
  for (let i = 0; i < entries.length; i += 64) {
    const parts = await Promise.all(entries.slice(i, i + 64).map(one));
    for (const part of parts) { bytes += part.bytes; files += part.files; freeable += part.freeable; sharedModules += part.sharedModules ?? 0; }
  }
  const result = sharedModules ? { bytes, files, freeable, sharedModules } : { bytes, files, freeable };
  // Remember the upper levels, so planning never walks a folder a second time.
  if (memo && depth <= 3) memo.set(resolve(path), result);
  return result;
}

/** True when sampled files under a pnpm virtual store are hard links (store on the same drive), not copies. */
async function pnpmLinked(dir) {
  // One package file from each of 12 packages. Most linked means a store-linked install: a few packages built
  // on install hold unlinked files, which is why "every sample linked" never held on real machines (2026-11-17:
  // 84,199 of 85,539 files linked, yet the old check walked all of them, most of the report's time).
  const samples = await packageLinks(dir, 12);
  return samples.length >= 3 && samples.filter((nlink) => nlink >= 2n).length >= samples.length * 0.75;
}

/** Link counts of one real file from each of up to `limit` different packages under `root` (never from .bin,
 * whose small shims are always copies and once made the sample say "not linked" for a linked folder). */
async function packageLinks(root, limit) {
  const samples = [];
  const firstFile = async (dir, depth) => {
    if (depth > 6) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isFile()) {
      const stat = await fs.lstat(join(dir, e.name), { bigint: true }).catch(() => null);
      if (stat?.isFile()) return stat.nlink;
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== '.bin') {
      const found = await firstFile(join(dir, e.name), depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (samples.length >= limit) break;
    if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
    const nlink = await firstFile(join(root, e.name), 1);
    if (nlink !== null) samples.push(nlink);
  }
  return samples;
}


/**
 * Windows only: a folder's file count and bytes from robocopy's list-only mode (/L: nothing is copied), which
 * reads sizes from the directory listing instead of opening each file, about 3 times faster than one stat per
 * file. Junctions and symlinks are skipped (/XJ), as the walk skips them. Used only for folders whose sampled
 * files are not hard links, so every byte counted is a byte freed. Any doubt returns null and the walk runs.
 */
const LISTERS = 6;
let listing = 0;
const waiting = [];
async function listedTotals(dir) {
  if (platform() !== 'win32' || process.env.CODEIN_TIDY_NO_ROBOCOPY) return null;
  if (listing >= LISTERS) await new Promise((resume) => waiting.push(resume));
  listing += 1;
  try {
    const nowhere = join(tmpdir(), `codein-tidy-list-only-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const out = await new Promise((done) => execFile('robocopy', [dir, nowhere, '/L', '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/BYTES', '/R:0', '/W:0'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20, timeout: 10 * 60_000 },
      // robocopy exit codes 0 to 7 are success (1 = "files would be copied"); 8 and above are failures.
      (error, stdout) => done(error && !(typeof error.code === 'number' && error.code < 8) ? null : stdout)));
    if (!out) return null;
    // The summary rows are Dirs, Files, Bytes (labels are translated, the order is not); the first number is the total.
    const rows = out.split(/\r?\n/).map((line) => line.match(/^\s*[^\d\s][^:]*:\s+(\d+)\s+\d+/)).filter(Boolean);
    if (rows.length < 3) return null;
    if (process.env.CODEIN_TIDY_PROFILE) console.error(`    listed ${dir}: ${rows[1][1]} files, ${rows[2][1]} bytes`);
    return { files: Number(rows[1][1]), bytes: Number(rows[2][1]) };
  } finally {
    listing -= 1;
    waiting.shift()?.();
  }
}

/** Newest change in a tree down to `depth` levels: a folder in use has fresh entries. */
async function newest(path, depth = 2) {
  const stat = await lstat(path);
  if (!stat) return 0;
  let latest = stat.mtimeMs;
  if (depth > 0 && stat.isDirectory() && !stat.isSymbolicLink())
    for (const name of await fs.readdir(path).catch(() => [])) latest = Math.max(latest, await newest(join(path, name), depth - 1));
  return latest;
}

function git(args, cwd, env, raw = false) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000, maxBuffer: 256 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
    return raw ? out : out.trim();
  } catch { return null; }
}
/** Status lines start with a space for unstaged changes, so they must never be trimmed. */
const gitStatus = (args, cwd) => git(['status', ...args], cwd, undefined, true);

/**
 * Uncommitted work is never deleted. A worktree is safe to remove only when nothing is uncommitted and its
 * commit is kept by a branch or tag (local or remote): git keeps branches in the main repository after the
 * worktree folder is gone. Anything else needs review: the agent reads the work and commits it.
 */
function worktreeState(path) {
  if (git(['rev-parse', '--is-inside-work-tree'], path) !== 'true') return { safe: false, why: 'not a git worktree' };
  const status = git(['status', '--porcelain', '--untracked-files=normal'], path);
  if (status === null) return { safe: false, why: 'git status failed' };
  if (status) return { safe: false, why: 'has uncommitted changes', review: true };
  const kept = git(['for-each-ref', '--count=1', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], path);
  if (kept === null) return { safe: false, why: 'git could not check its branches' };
  if (!kept) return { safe: false, why: 'its commits are on no branch', review: true };
  return { safe: true };
}

/** What an agent needs to review one worktree: where it is, its branch, and what is not committed. */
function reviewInfo(path) {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], path) || null;
  const status = (gitStatus(['--porcelain', '--untracked-files=all'], path) ?? '').split('\n').filter(Boolean);
  const diffstat = git(['diff', 'HEAD', '--shortstat'], path) ?? '';
  const unbranched = !git(['for-each-ref', '--count=1', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], path);
  const sorted = classifyChanges(path);
  return { path, branch, changedFiles: status.length, untrackedFiles: status.filter((l) => l.startsWith('??')).length, diffstat, unbranched,
    work: sorted.work.length, leftovers: sorted.leftovers.length, agentState: sorted.state, sample: sorted.work.slice(0, 20) };
}

export async function reviewList(options = {}) {
  const list = [];
  for (const target of [...targets(options).filter((t) => t.kind === 'worktrees'), ...await gitWorktreeTargets(options)])
    for (const path of target.paths ?? await findWorktrees(target.path, target.depth ?? 2)) {
      const state = worktreeState(path);
      if (state.review) list.push({ tool: target.tool, ...reviewInfo(path) });
    }
  return list;
}

/** Find worktree folders: a folder holding a `.git` file, searched `depth` levels down. */
async function findWorktrees(root, depth) {
  const found = [];
  async function walk(dir, level) {
    const names = await fs.readdir(dir).catch(() => []);
    if (names.includes('.git')) { found.push(dir); return; }
    if (level >= depth) return;
    for (const name of names) {
      const stat = await lstat(join(dir, name));
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await walk(join(dir, name), level + 1);
    }
  }
  for (const name of await fs.readdir(root).catch(() => [])) {
    const stat = await lstat(join(root, name));
    if (stat?.isDirectory() && !stat.isSymbolicLink()) await walk(join(root, name), 1);
  }
  return found;
}

/**
 * Unfinished work: every working folder of a project (the main checkout and each worktree, whichever tool made
 * it), and how far its work has got. Read-only. Stages, from least to most finished:
 *   uncommitted   real changes (agent leftovers and agent state are counted apart, never as work)
 *   not pushed    commits that exist on no remote, so on this machine only
 *   not merged    pushed, but not in the release branch (the remote's default branch, or .codein-tidy.json "release")
 *   in release    nothing to do
 * Whether the release branch is live is not known from git; it is reported as not checked, never guessed.
 */
const gitAsync = (args, cwd) => new Promise((done) => execFile('git', args,
  { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, out) => done(error ? null : out)));

async function pool(items, size, work) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const at = next++; out[at] = await work(items[at]); } }));
  return out;
}

export function madeBy(path, main = false) {
  if (main) return 'main checkout';
  if (/[\\/]\.claude[\\/]worktrees[\\/]agent-/.test(path)) return 'Claude Code subagent';
  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(path)) return 'Claude Code';
  if (/[\\/]\.codex[\\/]worktrees[\\/]/.test(path)) return 'Codex';
  if (/[\\/]\.cursor[\\/]worktrees[\\/]/.test(path)) return 'Cursor';
  if (/[\\/]opencode[\\/]worktree[\\/]/i.test(path)) return 'OpenCode';
  return 'git command';
}

/** Sort `git status --untracked-files=normal` entries into real work and agent leftovers. Fast: no file walk. */
function sortStatus(raw) {
  const out = { work: [], leftovers: 0 };
  for (const line of raw.split(String.fromCharCode(0)).filter((l) => /^[ MADRCU?!]{2} /.test(l))) {
    const code = line.slice(0, 2), rel = line.slice(3);
    if (code === '??' && (PROJECT_JUNK.some((rule) => rule.test(rel)) || AGENT_STATE_DIRS.includes(rel.split('/')[0]))) out.leftovers += 1;
    else out.work.push(line);
  }
  return out;
}

async function releaseBranch(main) {
  try {
    const config = JSON.parse(await fs.readFile(join(main, '.codein-tidy.json'), 'utf8'));
    if (typeof config.release === 'string' && config.release) return config.release;
  } catch {}
  return (await gitAsync(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], main))?.trim() || null;
}

export async function unfinishedWork(options = {}) {
  const here = resolve(options.cwd ?? process.cwd());
  const seeds = [options.project ?? here];
  if (options.all) for (const t of targets(options).filter((t) => t.kind === 'worktrees')) seeds.push(...await findWorktrees(t.path, 2));
  const commons = new Set();
  for (const seed of seeds) { const c = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], seed); if (c) commons.add(resolve(c)); }
  const projects = [];
  for (const common of commons) {
    const text = git(['worktree', 'list', '--porcelain'], common);
    if (!text) continue;
    const folders = text.split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/)).filter((l) => l[0]?.startsWith('worktree ') && !l.includes('bare'))
      .map((l, i) => ({ path: resolve(l[0].slice(9)), main: i === 0, missing: l.some((x) => x.startsWith('prunable')),
        branch: (l.find((x) => x.startsWith('branch ')) ?? '').replace('branch refs/heads/', '') || null }));
    const main = folders[0]?.path;
    if (!main) continue;
    const release = await releaseBranch(main);
    const hasRemote = Boolean((await gitAsync(['remote'], main))?.trim());
    const rows = await pool(folders.filter((f) => !f.missing), 8, async (f) => {
      const raw = await gitAsync(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], f.path);
      if (raw === null) return { ...f, madeBy: madeBy(f.path, f.main), stage: 'unreadable', changed: 0, leftovers: 0, unpushed: 0 };
      const { work, leftovers } = sortStatus(raw);
      const unpushed = hasRemote ? Number((await gitAsync(['rev-list', '--count', 'HEAD', '--not', '--remotes'], f.path)) ?? 0) : null;
      const merged = release ? (await gitAsync(['merge-base', '--is-ancestor', 'HEAD', release], f.path)) !== null : null;
      const [when = '0', subject = ''] = ((await gitAsync(['log', '-1', '--format=%ct%x09%s'], f.path)) ?? '').trim().split('\t');
      const touched = Math.max(Number(when) * 1000, await newest(f.path, 1));
      const stage = work.length ? 'uncommitted' : !hasRemote ? 'no remote' : unpushed > 0 ? 'not pushed' : merged === false ? 'not merged' : merged ? 'in release' : 'pushed';
      return { ...f, madeBy: madeBy(f.path, f.main), stage, changed: work.length, sample: work.slice(0, 5), leftovers, unpushed: unpushed ?? 0,
        idleDays: Math.max(0, Math.floor(((options.now ?? Date.now()) - touched) / DAY)), lastCommit: subject };
    });
    projects.push({ name: basename(main), main, release, hasRemote, live: 'not checked', budget: await projectBudget(main), folders: rows });
  }
  return projects;
}

const STAGE_ORDER = ['uncommitted', 'not pushed', 'no remote', 'not merged', 'unreadable'];
const STAGE_TITLE = { uncommitted: 'Uncommitted work', 'not pushed': 'Committed, not pushed (only on this machine)',
  'no remote': 'Committed, the project has no remote', 'not merged': 'Pushed, not in the release branch', unreadable: 'Could not be read' };
const what = (f) => f.stage === 'uncommitted' ? `${f.changed} changed file(s)${f.unpushed ? ` + ${f.unpushed} unpushed commit(s)` : ''}`
  : f.stage === 'not pushed' ? `${f.unpushed} commit(s)` : f.stage === 'not merged' ? 'pushed' : f.stage;

export function formatWork(projects) {
  const lines = [];
  for (const p of projects) {
    const open = p.folders.filter((f) => STAGE_ORDER.includes(f.stage));
    lines.push(`${p.name}: ${p.folders.length} working folder(s), ${open.length} with unfinished work. Release branch: ${p.release ?? 'unknown (set "release" in .codein-tidy.json)'}. Live: not checked.`);
    for (const stage of STAGE_ORDER) {
      const list = open.filter((f) => f.stage === stage).sort((a, b) => b.idleDays - a.idleDays);
      if (!list.length) continue;
      lines.push('', `  ${STAGE_TITLE[stage]} (${list.length})`);
      for (const f of list) lines.push(`    ${(f.branch ?? '(no branch)').slice(0, 42).padEnd(42)} ${f.madeBy.padEnd(20)} ${what(f).padEnd(28)} idle ${String(f.idleDays).padStart(3)} d  ${f.path}`);
    }
    const done = p.folders.filter((f) => !STAGE_ORDER.includes(f.stage)).length;
    const junk = p.folders.filter((f) => f.leftovers).length;
    lines.push('', `  Finished (${p.release ? `in ${p.release}` : 'pushed'}): ${done} folder(s).${junk ? ` Agent leftovers (not work) in ${junk} folder(s): codein-tidy prepare --project=<folder> moves them to trash.` : ''}`, '');
  }
  if (!projects.length) lines.push('Not inside a git project. Run it from a project folder, or add --all.');
  return lines.join('\n').trimEnd();
}

/** The short version an agent sees when a session starts. Empty when nothing is unfinished. */
export function formatNotice(projects) {
  const p = projects[0];
  const open = p ? p.folders.filter((f) => STAGE_ORDER.includes(f.stage) && f.stage !== 'unreadable') : [];
  const linked = p ? p.folders.filter((f) => !f.main).length : 0;
  const overBudget = p && p.budget && linked > p.budget
    ? `This project has ${linked} worktrees; its budget is ${p.budget}. Do not create more: take a working folder with \`npx -y codein-tidy@latest slot take --branch=<name>\`, and offer the person \`npx -y codein-tidy@latest close\`, which saves the work and frees idle ones.` : '';
  if (!open.length) return overBudget;
  const count = (s) => open.filter((f) => f.stage === s).length;
  const parts = [['uncommitted', 'hold uncommitted work'], ['not pushed', 'hold commits that are not pushed'], ['no remote', 'hold commits (no remote)'], ['not merged', `are pushed but not in ${p.release}`]]
    .filter(([s]) => count(s)).map(([s, t]) => `${count(s)} ${t}`);
  const top = [...open].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || b.changed + b.unpushed - (a.changed + a.unpushed)).slice(0, 6);
  return [`codein-tidy: unfinished work in ${p.name} (${open.length} of ${p.folders.length} working folders): ${parts.join(', ')}.`,
    ...top.map((f) => `- ${f.path} | ${f.branch ?? 'no branch'} | ${f.madeBy} | ${what(f)} | idle ${f.idleDays} d`),
    ...(open.length > top.length ? [`- and ${open.length - top.length} more: npx codein-tidy work`] : []),
    'Tell the person about this unfinished work before starting something new, and offer to finish it. Never delete, reset or stash it.',
    'To finish one: read it (git -C <folder> status, git -C <folder> diff), commit it on its branch with a clear message, then ask the person before pushing or merging.',
    ...(overBudget ? [overBudget] : []),
  ].join('\n');
}

/** Every worktree git lists for a repository (run in its common git folder). The first is the main one. */
function linkedWorktrees(common) {
  const text = git(['worktree', 'list', '--porcelain'], common);
  if (text === null) return null;
  const blocks = text.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/)).filter((lines) => lines[0]?.startsWith('worktree '));
  const entries = blocks.map((lines) => ({ path: resolve(lines[0].slice('worktree '.length)),
    bare: lines.includes('bare'), prunable: lines.some((l) => l.startsWith('prunable')) }));
  if (!entries.length) return null;
  return { main: entries[0].path, linked: entries.slice(1).filter((e) => !e.bare && !e.prunable).map((e) => e.path) };
}

/**
 * Worktrees outside the tools' own folders (for example D:\work-wt\feature or ~/src/app-fix), found by asking
 * git rather than guessing folder names: every linked worktree of each repository that a tool's worktrees belong
 * to, and of the repository this runs in (or --project). Left out: the main worktree, the one this runs inside,
 * missing ones, and ones already listed under a tool. Same rules as the tools' worktrees.
 */
export async function gitWorktreeTargets(options = {}) {
  const toolRoots = targets(options).filter((t) => t.kind === 'worktrees').map((t) => t.path);
  const here = resolve(options.cwd ?? process.cwd());
  const seeds = [here, ...(options.project ? [options.project] : [])];
  for (const root of toolRoots) seeds.push(...await findWorktrees(root, 2));
  const commons = new Set();
  for (const seed of seeds) {
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], seed);
    if (common) commons.add(resolve(common));
  }
  const out = [];
  for (const common of commons) {
    const listed = linkedWorktrees(common);
    if (!listed) continue;
    const paths = listed.linked.filter((p) => !toolRoots.some((root) => inside(root, p)) && !inside(p, here));
    if (paths.length) out.push({ tool: 'Other git worktrees', item: `Worktrees of ${basename(listed.main)}`, path: listed.main, paths, common,
      kind: 'worktrees', class: 'work', ageDays: 14, deepAgeDays: 3 });
  }
  return out;
}

export function runningApps(os = platform()) {
  try {
    const out = os === 'win32'
      ? execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const text = out.toLowerCase();
    return new Set(['cursor', 'antigravity'].filter((name) => text.includes(name)));
  } catch { return new Set(['cursor', 'antigravity']); } // cannot tell: assume running, skip their caches
}

/** What a target holds, and which entries `clean` would remove under the given options. */
async function plan(target, options) {
  const memo = new Map();
  const walkStarted = Date.now();
  let total = { bytes: 0, files: 0, freeable: 0 };
  if (target.paths) {
    const seen = new Set();
    for (const m of await Promise.all(target.paths.map((path) => measure(path, seen, memo))))
      total = { bytes: total.bytes + m.bytes, files: total.files + m.files, freeable: total.freeable + m.freeable,
        sharedModules: (total.sharedModules ?? 0) + (m.sharedModules ?? 0) };
  } else total = await measure(target.path, new Set(), memo);
  if (process.env.CODEIN_TIDY_PROFILE) console.error(`    walk ${Date.now() - walkStarted} ms ${target.item}`);
  const out = { ...target, ...total, removable: [], skipped: undefined };
  if (!total.files && !total.bytes) return out;
  if (target.kind === 'report') return out;
  if (target.class === 'history' && !options.history) { out.skipped = 'chat history: add --history'; }
  if (target.class === 'work' && !options.worktrees) { out.skipped = 'worktrees: add --worktrees'; }
  if (target.app && options.running.has(target.app)) { out.skipped = `${target.app} is running: close it first`; }
  if (target.tool === 'Package caches' && !options.caches && !options.deep) { out.skipped = 'downloads again when needed: add --caches'; }
  const ageMs = (options.olderThanDays ?? (options.deep ? target.deepAgeDays ?? target.ageDays : target.ageDays) ?? 0) * DAY;
  const candidates = [];
  if (target.kind === 'whole') candidates.push(target.path);
  if (target.kind === 'browsers') candidates.push(...await oldBrowserRevisions(target.path));
  if (target.kind === 'command') {
    // The package manager decides what goes. A full clean frees everything; a prune only what nothing links to.
    out.removable.push({ path: target.path, bytes: total.bytes, files: total.files, freeable: target.partial ? total.freeable : total.bytes });
    return out;
  }
  if (target.kind === 'entries') {
    const entries = [];
    for (const name of await fs.readdir(target.path).catch(() => [])) {
      if (target.match && !target.match.test(name)) continue;
      const path = join(target.path, name);
      if (target.level === 2) {
        const stat = await lstat(path);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) for (const child of await fs.readdir(path).catch(() => [])) entries.push(join(path, child));
      } else entries.push(path);
    }
    for (const path of entries) if (options.now - await newest(path, target.depth ?? 2) > ageMs) candidates.push(path);
  }
  if (target.kind === 'versions') {
    const children = [];
    for (const name of await fs.readdir(target.path).catch(() => [])) children.push({ path: join(target.path, name), at: await newest(join(target.path, name), 1) });
    children.sort((a, b) => b.at - a.at);
    candidates.push(...children.slice(1).map((child) => child.path));
  }
  if (target.kind === 'worktrees') {
    out.kept = [];
    const findStarted = Date.now();
    const found = target.paths ?? await findWorktrees(target.path, target.depth ?? 2);
    if (process.env.CODEIN_TIDY_PROFILE) console.error(`    find ${Date.now() - findStarted} ms`);
    for (const path of found) {
      if (options.now - await newest(path, 1) <= ageMs) { out.kept.push({ path, why: 'used recently' }); continue; }
      const state = worktreeState(path);
      if (state.safe) candidates.push(path);
      else out.kept.push({ path, why: state.review ? `${state.why}: needs review (codein-tidy review)` : state.why, review: !!state.review });
    }
  }
  for (const path of candidates) out.removable.push({ path, ...(memo.get(resolve(path)) ?? await measure(path)) });
  return out;
}

function inside(root, path) {
  const r = resolve(root) + sep, p = resolve(path);
  return p === resolve(root) || p.startsWith(r);
}

async function remove(target, entry) {
  if (target.paths) {
    // A worktree outside the tool folders: it must still be one git lists for that repository, and not the main one.
    const listed = linkedWorktrees(target.common);
    if (!target.paths.includes(resolve(entry.path)) || !listed?.linked.includes(resolve(entry.path)))
      throw new Error('git no longer lists this as a linked worktree');
  } else if (!inside(target.path, entry.path)) throw new Error(`refusing to remove outside ${target.path}`);
  if (target.kind === 'worktrees') {
    // git deletes ignored files of a "clean" worktree without asking (.env.local, local config): keep a copy of
    // any it cannot rebuild first (verified 2026-11-17).
    const saved = await saveFolder(entry.path, { home: target.home });
    if (!saved.saved && !/nothing here/.test(saved.reason)) throw new Error(`not removed: ${saved.reason}`);
    // Let git remove its own worktree, so the main repository forgets it too. Run it from the main
    // repository's git folder: on Windows a process cannot delete the folder it is running in.
    const common = git(['rev-parse', '--git-common-dir'], entry.path);
    if (!common) throw new Error('could not find the main repository');
    // Never --force: git itself refuses to remove a worktree that gained changes since the plan.
    if (git(['worktree', 'remove', entry.path], resolve(entry.path, common)) !== null) return;
    throw new Error('git could not remove the worktree');
  }
  if (target.kind === 'whole' && (await lstat(entry.path))?.isDirectory()) {
    for (const name of await fs.readdir(entry.path)) await fs.rm(join(entry.path, name), { recursive: true, force: true });
    return;
  }
  await fs.rm(entry.path, { recursive: true, force: true });
}

/**
 * Leftovers coding agents write into a project and never remove. Only files git does not track (and does
 * not ignore) are considered, only these patterns, and only once older than the age limit. They are moved
 * to a trash folder, never deleted here; the trash is emptied after TRASH_DAYS.
 */
const PROJECT_JUNK = [
  { why: 'Browser automation screenshots and logs (.playwright-mcp)', test: (rel) => rel.startsWith('.playwright-mcp/') },
  { why: 'Screenshots', test: (rel) => /\.(png|jpe?g|webp|gif)$/i.test(rel) &&
      (!rel.includes('/') || /(^|\/)(screenshots?|shots|captures)\//i.test(rel) || /screen[-_ ]?shot|^capture/i.test(rel.split('/').pop())) },
  { why: 'Temporary scripts and files', test: (rel) => /^(\.tmp-|\.tmp_|tmp-)/i.test(rel.split('/')[0]) || /\.tmp$/i.test(rel) },
  // Throwaway folders agents create at the top of a project (.test-tmp, .rw36-tmp, tmp) and probe files
  // (.diag-db-host.mjs, .debug-build-inspect.ts, .candidate2-body.txt): seen holding 13,700 files in one worktree.
  { why: 'Temporary folders', test: (rel) => /^(\.?tmp|\.[\w-]*-tmp)$/i.test(rel.split('/')[0]) && (rel.includes('/') || rel.endsWith('/')) },
  { why: 'Probe and diagnostic files', test: (rel) => !rel.includes('/') && /^\.(diag|debug|probe|candidate\d*)[-_.]/i.test(rel) },
  { why: 'Stray files from shell mistakes', test: (rel) => ['nul', '-', '$null'].includes(rel.toLowerCase()) },
  { why: 'PowerShell cache written into the project', test: (rel) => rel.startsWith('Microsoft/Windows/PowerShell/') },
];

/** Folders where coding agents keep their own state. Never committed; ignored locally when git tracks nothing in them. */
const AGENT_STATE_DIRS = ['.code-in', '.code-ae', '.codeae', '.codex', '.claude', '.cursor', '.gemini', '.commandcode', '.agents'];

/** Sort what is not committed in a worktree into real work, agent leftovers and agent state. */
function classifyChanges(top) {
  const raw = gitStatus(['--porcelain=v1', '-z', '--untracked-files=all'], top) ?? '';
  const entries = raw.split(String.fromCharCode(0)).filter(Boolean).filter((line) => /^[ MADRCU?!]{2} /.test(line));
  const out = { work: [], leftovers: [], state: new Set() };
  const stateTracked = new Map();
  for (const line of entries) {
    const code = line.slice(0, 2), rel = line.slice(3);
    if (code !== '??') { out.work.push(line); continue; }
    if (PROJECT_JUNK.some((rule) => rule.test(rel))) { out.leftovers.push(rel); continue; }
    // An agent state folder at any depth (apps/web/.code-in/...), when git tracks nothing inside it.
    const parts = rel.split('/');
    const at = parts.slice(0, -1).findIndex((part) => AGENT_STATE_DIRS.includes(part));
    if (at >= 0) {
      const dir = parts.slice(0, at + 1).join('/');
      if (!stateTracked.has(dir)) stateTracked.set(dir, Boolean(git(['ls-files', '--', dir], top)));
      if (!stateTracked.get(dir)) { out.state.add(dir); continue; }
    }
    out.work.push(line);
  }
  return { ...out, state: [...out.state] };
}

/**
 * Get a worktree ready for review: agent leftovers move to the trash, agent state folders are added to the
 * repository's local ignore list (.git/info/exclude, never committed). Real work is never touched.
 */
export async function prepareWorktree(path, options = {}) {
  const top = git(['rev-parse', '--show-toplevel'], path);
  if (!top) throw new Error(`${path} is not inside a git worktree`);
  const changes = classifyChanges(top);
  if (!options.yes) return { top, ...changes, applied: false };
  const trashDir = options.trashDir ?? join(options.home ?? homedir(), '.codein-tidy', 'trash');
  const target = { path: resolve(top), trashDir };
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  let moved = 0;
  for (const rel of changes.leftovers) {
    const full = join(top, rel);
    if (!(await lstat(full))?.isFile()) continue;
    await moveToTrash(target, { path: full, rel }, stamp);
    moved += 1;
  }
  if (changes.state.length) {
    const exclude = resolve(top, git(['rev-parse', '--git-path', 'info/exclude'], top));
    const existing = await fs.readFile(exclude, 'utf8').catch(() => '');
    const NL = String.fromCharCode(10);
    const present = existing.split(NL).map((line) => line.trim());
    const lines = changes.state.map((dir) => `/${dir}/`).filter((line) => !present.includes(line));
    if (lines.length) {
      await fs.mkdir(join(exclude, '..'), { recursive: true });
      const lead = existing && !existing.endsWith(NL) ? NL : '';
      await fs.appendFile(exclude, lead + '# agent state, added by codein-tidy' + NL + lines.join(NL) + NL);
    }
  }
  const after = classifyChanges(top);
  return { top, ...changes, applied: true, moved, trash: moved ? join(trashDir, stamp) : undefined, remainingWork: after.work };
}
const TRASH_DAYS = 7;

async function projectPlans(project, options) {
  const top = git(['rev-parse', '--show-toplevel'], project);
  if (!top) return [];
  const raw = gitStatus(['--porcelain=v1', '-z', '--untracked-files=all'], top);
  if (raw === null) return [];
  const untracked = raw.split('\0').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  const ageMs = (options.olderThanDays ?? (options.deep ? 1 : 7)) * DAY;
  const trashDir = options.trashDir ?? join(options.home ?? homedir(), '.codein-tidy', 'trash');
  const groups = new Map(PROJECT_JUNK.map((rule) => [rule.why, []]));
  let total = 0, files = 0;
  for (const rel of untracked) {
    const rule = PROJECT_JUNK.find((r) => r.test(rel));
    if (!rule) continue;
    const path = join(top, rel);
    const stat = await lstat(path);
    if (!stat?.isFile()) continue;
    total += stat.size; files += 1;
    if (options.now - stat.mtimeMs > ageMs) groups.get(rule.why).push({ path, rel, bytes: stat.size, freeable: stat.size, files: 1 });
  }
  return [...groups].filter(([, entries]) => entries.length).map(([why, entries]) => ({
    tool: `This project (${top})`, item: why, path: resolve(top), kind: 'trash', class: 'project', trashDir,
    bytes: entries.reduce((s, e) => s + e.bytes, 0), files: entries.length, removable: entries, skipped: undefined,
  })).concat(files && ![...groups.values()].some((g) => g.length) ? [{ tool: `This project (${top})`, item: 'Agent leftovers', path: resolve(top),
    kind: 'report', class: 'project', bytes: total, files, removable: [], tip: 'all recent; kept' }] : []);
}

async function moveToTrash(target, entry, stamp) {
  const destination = join(target.trashDir, stamp, target.path.split(/[\\/]/).pop(), entry.rel);
  await fs.mkdir(join(destination, '..'), { recursive: true });
  try { await fs.rename(entry.path, destination); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(entry.path, destination);
    await fs.rm(entry.path);
  }
  return destination;
}

/** Empty trash folders older than TRASH_DAYS. */
async function emptyOldTrash(trashDir, now) {
  for (const name of await fs.readdir(trashDir).catch(() => [])) {
    const stat = await lstat(join(trashDir, name));
    if (stat?.isDirectory() && now - stat.mtimeMs > TRASH_DAYS * DAY) await fs.rm(join(trashDir, name), { recursive: true, force: true });
  }
}

/**
 * Package and browser caches. Everything here downloads again when needed, so it is cleaned only with
 * --caches or --deep. Each package manager cleans its own cache with its own command (it knows which
 * entries are in use); the receipt reports what was really freed, measured before and after.
 */
/** Run a package manager. On Windows npm, pnpm and yarn are .cmd files that need cmd.exe; it gets one fixed command
 * line (our own constant words, never user input) instead of an argument list with shell: true, which Node 24
 * flags as unsafe (DEP0190). */
export function runTool(command, args, options) {
  if (platform() !== 'win32') return execFileSync(command, args, options);
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].join(' ')}"`], { ...options, windowsVerbatimArguments: true });
}

function ask(command, args) {
  try {
    const out = runTool(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
    return out.trim().split(/\r?\n/).pop()?.trim() || null;
  } catch { return null; }
}

function browserCacheDir({ home = homedir(), env = process.env, os = platform() }) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return env.PLAYWRIGHT_BROWSERS_PATH;
  if (os === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright');
  if (os === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright');
}

export function cacheTargets(options = {}) {
  const lookup = options.lookup ?? ask;
  const list = [];
  const npm = lookup('npm', ['config', 'get', 'cache']);
  if (npm) {
    list.push({ tool: 'Package caches', item: 'npm download cache', path: join(npm, '_cacache'), kind: 'command', class: 'cache', run: ['npm', ['cache', 'clean', '--force']] });
    list.push({ tool: 'Package caches', item: 'npx packages', path: join(npm, '_npx'), kind: 'entries', class: 'cache', ageDays: 7, deepAgeDays: 1 });
  }
  const pnpm = lookup('pnpm', ['store', 'path']);
  if (pnpm) list.push({ tool: 'Package caches', item: 'pnpm store (unused packages)', path: pnpm, kind: 'command', class: 'cache', run: ['pnpm', ['store', 'prune']], partial: true });
  const yarn = lookup('yarn', ['cache', 'dir']);
  if (yarn) list.push({ tool: 'Package caches', item: 'Yarn cache', path: yarn, kind: 'command', class: 'cache', run: ['yarn', ['cache', 'clean']] });
  const pip = lookup('pip', ['cache', 'dir']);
  if (pip) list.push({ tool: 'Package caches', item: 'pip cache', path: pip, kind: 'command', class: 'cache', run: ['pip', ['cache', 'purge']] });
  const uv = lookup('uv', ['cache', 'dir']);
  if (uv) list.push({ tool: 'Package caches', item: 'uv cache', path: uv, kind: 'command', class: 'cache', run: ['uv', ['cache', 'prune']], partial: true });
  list.push({ tool: 'Package caches', item: 'Old Playwright browsers', path: browserCacheDir(options), kind: 'browsers', class: 'cache' });
  const hf = join(options.home ?? homedir(), '.cache', 'huggingface');
  list.push({ tool: 'Package caches', item: 'Downloaded AI models (Hugging Face)', path: hf, kind: 'report', class: 'cache', tip: 'Large re-downloads; not removed.' });
  return list;
}

/** Playwright keeps each browser as <name>-<revision>. Keep the newest revision of each name, list the rest. */
async function oldBrowserRevisions(dir) {
  const newest = new Map(), all = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const match = /^(.+)-(\d+)$/.exec(name);
    if (!match) continue;
    const [, kind, revision] = match;
    all.push({ name, kind, revision: Number(revision) });
    newest.set(kind, Math.max(newest.get(kind) ?? 0, Number(revision)));
  }
  return all.filter((b) => b.revision < newest.get(b.kind)).map((b) => join(dir, b.name));
}

function runCacheCommand([command, args]) {
  runTool(command, args, { stdio: 'ignore', timeout: 15 * 60_000 });
}

export async function scan(options = {}) {
  const now = options.now ?? Date.now();
  const running = options.running ?? runningApps(options.os);
  const opts = { ...options, now, running, worktrees: options.worktrees || options.deep };
  // Package caches are always reported; they are cleaned only with --caches or --deep (see plan()).
  const all = [...targets(options), ...await gitWorktreeTargets(options), ...cacheTargets(options)];
  // An agent reads this through a pipe, where the live progress line never shows: say once that work is under way.
  if (!process.stderr.isTTY && !process.env.CODEIN_TIDY_PROFILE) process.stderr.write(`codein-tidy: measuring ${all.length} places...\n`);
  let finished = 0;
  const progress = () => { if (options.onStatus) return options.onStatus({ label: 'Measuring what AI coding tools keep', done: finished, total: all.length }); if (process.stderr.isTTY && !process.env.CODEIN_TIDY_PROFILE) process.stderr.write(`\x1b[2KMeasuring ${all.length} places: ${finished} done...\r`); };
  progress();
  // Places are independent, so they are measured at the same time; the report keeps their order.
  const plans = await Promise.all(all.map(async (target) => {
    const started = Date.now();
    const result = await plan(target, opts);
    finished += 1; progress();
    if (process.env.CODEIN_TIDY_PROFILE) console.error(`${String(Date.now() - started).padStart(7)} ms  ${target.tool}: ${target.item}`);
    return result;
  }));
  if (process.stderr.isTTY && !options.onStatus) process.stderr.write('\x1b[2K');
  if (options.project) plans.push(...await projectPlans(options.project, opts));
  for (const p of plans) p.home = options.home; // where saved work goes (tests pass their own home)
  return plans;
}

export async function clean(plans, now = Date.now(), { runner = runCacheCommand, onStep } = {}) {
  const receipt = { removed: 0, bytes: 0, moved: 0, movedBytes: 0, trash: undefined, failed: [] };
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const total = plans.filter((t) => !t.skipped).reduce((n, t) => n + t.removable.length, 0);
  let done = 0;
  for (const target of plans) {
    if (target.skipped) continue;
    if (target.kind === 'trash') await emptyOldTrash(target.trashDir, now);
    for (const entry of target.removable) {
      onStep?.({ done: done++, total, note: `${target.tool}: ${target.item}` });
      try {
        if (target.kind === 'trash') {
          if (!inside(target.path, entry.path)) throw new Error('outside the project');
          await moveToTrash(target, entry, stamp);
          receipt.moved += 1; receipt.movedBytes += entry.bytes; receipt.trash = join(target.trashDir, stamp);
          continue;
        }
        if (target.kind === 'command') {
          await runner(target.run);
          const after = await measure(target.path);
          receipt.removed += 1; receipt.bytes += Math.max(0, entry.bytes - after.bytes);
          continue;
        }
        await remove(target, entry); receipt.removed += 1; receipt.bytes += entry.freeable;
      }
      catch (error) { receipt.failed.push({ path: entry.path, error: String(error.message ?? error) }); }
    }
  }
  return receipt;
}

export const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.round(bytes / 1024)} KB`;

export function formatReport(plans, { cleaning = false } = {}) {
  const lines = [];
  const present = plans.filter((p) => p.bytes > 0 || p.files > 0);
  let tool = '';
  for (const p of present) {
    if (p.tool !== tool) { tool = p.tool; lines.push('', tool); }
    const free = p.removable.reduce((sum, e) => sum + e.freeable, 0);
    const toReview = (p.kept ?? []).filter((k) => k.review).length;
    const action = p.kind === 'report' ? (p.tip ?? 'measured only')
      : p.kind === 'trash' ? `${p.removable.length} file(s) ${cleaning ? 'will be moved' : 'can be moved'} to trash (emptied after ${TRASH_DAYS} days)`
      : p.skipped ? (free ? `${size(free)} could go; ${p.skipped}` : 'nothing old enough')
      : free ? `${size(free)} ${cleaning ? 'will be freed' : 'can be freed'}${toReview ? `; ${toReview} hold uncommitted work: review and commit them first` : ''}`
      : toReview ? `${toReview} hold uncommitted work: review and commit them first` : 'nothing old enough';
    lines.push(`  ${size(p.bytes).padStart(8)}  ${p.item.padEnd(34)} ${action}`);
    if (p.sharedModules) lines.push(`            not counted: ${p.sharedModules} node_modules linked to the pnpm store (removing them frees almost nothing)`);
    for (const kept of (p.kept ?? []).slice(0, 5)) lines.push(`            kept ${kept.path}: ${kept.why}`);
  }
  const freeOf = (list) => list.filter((p) => !p.skipped).reduce((sum, p) => sum + p.removable.reduce((s, e) => s + e.freeable, 0), 0);
  const tools = present.filter((p) => p.class !== 'project' && p.tool !== 'Package caches');
  const caches = present.filter((p) => p.tool === 'Package caches');
  // What the flags would add: everything held back only because a flag was not given (not apps that are running).
  const held = (list) => {
    const byFlag = new Map();
    for (const p of list) {
      const flag = p.skipped?.match(/add (--[a-z]+)/)?.[1];
      const free = p.removable.reduce((s, e) => s + e.freeable, 0);
      if (flag && free) byFlag.set(flag, (byFlag.get(flag) ?? 0) + free);
    }
    return byFlag;
  };
  const extra = (byFlag) => [...byFlag].map(([flag, bytes]) => `${size(bytes)} with ${flag}`).join(', ');
  const toolsHeld = held(tools), cachesHeld = held(caches);
  lines.push('', `AI tools use ${size(tools.reduce((sum, p) => sum + p.bytes, 0))} here. ${size(freeOf(tools))} can be freed safely now${toolsHeld.size ? `; ${extra(toolsHeld)}` : ''}.`);
  if (caches.length) lines.push(`Package caches use ${size(caches.reduce((sum, p) => sum + p.bytes, 0))}. ${cachesHeld.size ? `${extra(cachesHeld)} (they download again when needed)` : `${size(freeOf(caches))} can be freed now`}.`);
  const all = new Map([...toolsHeld]);
  for (const [flag, bytes] of cachesHeld) all.set(flag, (all.get(flag) ?? 0) + bytes);
  if (all.size > 1) lines.push(`Everything above together: ${size(freeOf(tools) + freeOf(caches) + [...all.values()].reduce((a, b) => a + b, 0))} with ${[...all.keys()].join(' ')} (or --deep for temp files, caches and worktrees at shorter ages).`);
  const junk = present.filter((p) => p.kind === 'trash');
  if (junk.length) lines.push(`Agent leftovers in this project: ${junk.reduce((s, p) => s + p.removable.length, 0)} file(s), ${size(junk.reduce((s, p) => s + p.bytes, 0))}.`);
  const heldWork = present.filter((p) => p.kind === 'worktrees').reduce((n, p) => n + (p.kept ?? []).filter((k) => k.review).length, 0);
  if (heldWork) lines.push(`${heldWork} worktree(s) are kept only because they hold work. \`codein-tidy close\` saves that work into one file per project, then frees them.`);
  if (!present.length) lines.push('None of the supported tools has data on this machine.');
  return lines.join('\n').trimStart();
}

// ---------------------------------------------------------------------------------------------------------------
// Save: a working folder's work becomes a commit, plus a copy of the local files git ignores, so the folder can go.
//
// The snapshot is the folder exactly as it is (tracked and untracked files, minus untracked agent state), built in
// a throwaway index: the folder's own index, branch and hooks are never touched. It is kept under refs/tidy/ in the
// project's own repository and copied into a bundle file. Ignored files that a package manager or a build cannot
// recreate (.env.local, local config) are copied to a keep folder outside git, never into a commit. A save counts
// only when a fresh tree of the folder equals the snapshot and every kept file's hash matches.
// ---------------------------------------------------------------------------------------------------------------

/** Folders a package manager or a build fills again: never the only copy of anything. */
const REBUILT_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'target',
  'dist', 'build', '.next', '.turbo', 'out', 'coverage', '.cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.gradle', '.pnpm-store',
  '.yarn', '.expo', '.vercel', '.output', 'bower_components', '.terraform', '.vscode-test']);
/** Single files a build or tool writes again. */
const REBUILT_FILES = /(\.tsbuildinfo|\.pyc|\.pyo)$|^(\.eslintcache|\.stylelintcache|\.DS_Store|Thumbs\.db)$/i;
const KEEP_FILE_LIMIT = 20 * 1024 ** 2, KEEP_TOTAL_LIMIT = 200 * 1024 ** 2;
const tidyHome = (options = {}) => join(options.home ?? homedir(), '.codein-tidy');
const slug = (text) => String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'folder';
const stampOf = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');
const sha256 = async (path) => createHash('sha256').update(await fs.readFile(path)).digest('hex');

/** The tree of a folder exactly as it is now, built in a throwaway index. Null if git cannot build it. */
function folderTree(top, excluded = []) {
  // The throwaway index lives in the checkout's own git folder: it always exists and is on the same drive.
  const gitDir = git(['rev-parse', '--absolute-git-dir'], top);
  if (!gitDir) return null;
  const scratch = join(gitDir, `codein-tidy-index-${process.pid}-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: scratch };
  try {
    // Start from a copy of the folder's own index: git's file-time cache means only changed files are hashed
    // (an empty start hashed every file: 8 to 10 s per checkout). `add -A` then makes it equal the folder.
    const own = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], top);
    let copied = false;
    if (own) { try { copyFileSync(own, scratch); copied = true; } catch {} }
    if (!copied) {
      const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], top);
      if ((head ? git(['read-tree', head], top, env) : git(['read-tree', '--empty'], top, env)) === null) return null;
    }
    if (git(['add', '-A', '--', '.', ...excluded.map((dir) => `:(exclude)${dir}`)], top, env) === null) return null;
    return git(['write-tree'], top, env);
  } finally { fs.rm(scratch, { force: true }).catch(() => {}); }
}

/** Ignored files only this folder has: everything git ignores except rebuilt folders, agent state and leftovers. */
async function ignoredToKeep(top, stateDirs) {
  const raw = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], top, undefined, true) ?? '';
  const skip = (rel) => rel.split('/').some((part) => REBUILT_DIRS.has(part) || AGENT_STATE_DIRS.includes(part)) || REBUILT_FILES.test(rel.split('/').pop())
    || stateDirs.some((dir) => rel === dir || rel.startsWith(dir + '/')) || PROJECT_JUNK.some((rule) => rule.test(rel));
  const files = [];
  async function walk(rel) {
    if (skip(rel)) return;
    const full = join(top, rel), stat = await lstat(full);
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of await fs.readdir(full).catch(() => [])) await walk(`${rel}/${name}`); return; }
    files.push({ rel, bytes: stat.size });
  }
  for (const entry of raw.split(String.fromCharCode(0)).filter(Boolean)) await walk(entry.replace(/\/$/, ''));
  return files;
}

/** What saving a folder would do, without doing it. */
export async function savePlan(path) {
  const top = git(['rev-parse', '--show-toplevel'], path);
  if (!top) throw new Error(`${path} is not inside a git worktree`);
  const changes = classifyChanges(top);
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], top);
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], top) || null;
  const tree = folderTree(top, changes.state);
  if (!tree) throw new Error(`git could not read ${top}`);
  const headTree = head ? git(['rev-parse', `${head}^{tree}`], top) : null;
  const kept = head ? Boolean(git(['for-each-ref', '--count=1', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], top)) : false;
  const keep = await ignoredToKeep(top, changes.state);
  const keepBytes = keep.reduce((sum, f) => sum + f.bytes, 0);
  const tooBig = keep.filter((f) => f.bytes > KEEP_FILE_LIMIT).map((f) => f.rel);
  return { top: resolve(top), head, branch, tree, headTree, changed: tree !== headTree, unreferenced: Boolean(head) && !kept,
    work: changes.work.length, leftovers: changes.leftovers.length, state: changes.state, keep, keepBytes,
    blocked: tooBig.length ? `ignored files too large to keep: ${tooBig.slice(0, 3).join(', ')}` : keepBytes > KEEP_TOTAL_LIMIT ? `ignored files to keep total ${size(keepBytes)}` : null };
}

/**
 * Save a folder. Returns the saved record (also appended to ~/.codein-tidy/saved/index.jsonl), or
 * { saved: false, reason } when there is nothing that exists only here. Never changes the folder.
 */
export async function saveFolder(path, options = {}) {
  const now = options.now ?? Date.now();
  const p = await savePlan(path);
  if (p.blocked) return { saved: false, reason: p.blocked, top: p.top };
  if (!p.changed && !p.unreferenced && !p.keep.length) return { saved: false, reason: 'nothing here that is not already in git', top: p.top };
  const common = resolve(p.top, git(['rev-parse', '--git-common-dir'], p.top));
  const name = basename(p.top), id = `${stampOf(now)}-${slug(name)}-${randomUUID().slice(0, 6)}`;
  let snapshot = p.head;
  if (p.changed || !p.head) {
    const ident = { GIT_AUTHOR_NAME: 'codein-tidy', GIT_AUTHOR_EMAIL: 'codein-tidy@localhost', GIT_COMMITTER_NAME: 'codein-tidy', GIT_COMMITTER_EMAIL: 'codein-tidy@localhost' };
    const message = `codein-tidy snapshot of ${p.top}${p.branch ? ` (branch ${p.branch})` : ''}\n\n${p.work} uncommitted change(s) saved on ${new Date(now).toISOString()}.`;
    snapshot = git(['commit-tree', p.tree, ...(p.head ? ['-p', p.head] : []), '-m', message], p.top, ident);
    if (!snapshot) throw new Error('git could not write the snapshot commit');
  }
  const ref = `refs/tidy/${slug(name)}/${id}`;
  if (git(['update-ref', ref, snapshot], p.top) === null) throw new Error('git could not record the snapshot');
  // Proof: the folder still equals what was saved (nothing changed while saving).
  if (folderTree(p.top, p.state) !== p.tree) throw new Error('the folder changed while it was being saved; nothing was released, run again');
  const keepDir = join(tidyHome(options), 'kept', id), kept = [];
  for (const f of p.keep) {
    const from = join(p.top, f.rel), to = join(keepDir, f.rel);
    await fs.mkdir(join(to, '..'), { recursive: true });
    await fs.copyFile(from, to);
    const hash = await sha256(from);
    if (hash !== await sha256(to)) throw new Error(`could not copy ${f.rel} exactly`);
    kept.push({ rel: f.rel, bytes: f.bytes, sha256: hash });
  }
  if (kept.length) await fs.writeFile(join(keepDir, 'manifest.json'), JSON.stringify({ id, files: kept }, null, 2));
  // close writes one bundle per project for the whole run (deferIndex), save writes one per folder.
  const bundle = options.deferIndex ? null : await writeBundle(p.top, [ref], join(tidyHome(options), 'saved', `${slug(name)}-${id}.bundle`));
  const record = { id, project: name, common, path: p.top, branch: p.branch, head: p.head, snapshot, tree: p.tree, ref, bundle,
    kept: kept.length ? { dir: keepDir, files: kept.length, bytes: kept.reduce((s, f) => s + f.bytes, 0) } : null, work: p.work, savedAt: new Date(now).toISOString(),
    restore: `npx codein-tidy restore ${id}` };
  if (!options.deferIndex) await recordSaved([record], options);
  return { saved: true, ...record };
}

async function recordSaved(records, options = {}) {
  if (!records.length) return;
  await fs.mkdir(join(tidyHome(options), 'saved'), { recursive: true });
  await fs.appendFile(join(tidyHome(options), 'saved', 'index.jsonl'), records.map((r) => JSON.stringify(r) + '\n').join(''));
}

// ---------------------------------------------------------------------------------------------------------------
// Close: idle worktrees give their space back. Each one's leftovers go to the trash, its work is saved (one bundle
// file per project per run), then git removes the folder. Never: the main checkout, the folder this runs in, a
// locked worktree, one used within the idle limit, or one whose save could not be proven.
// ---------------------------------------------------------------------------------------------------------------
export async function closePlan(options = {}) {
  const now = options.now ?? Date.now(), idleDays = options.idleDays ?? 1;
  const here = resolve(options.cwd ?? process.cwd());
  const projects = await unfinishedWork({ ...options, cwd: here });
  const plan = [];
  for (const p of projects) {
    const common = resolve(p.main, git(['rev-parse', '--git-common-dir'], p.main));
    const locked = new Set((git(['worktree', 'list', '--porcelain'], common) ?? '').split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/))
      .filter((l) => l.some((x) => x.startsWith('locked'))).map((l) => resolve(l[0].slice(9))));
    for (const f of p.folders) {
      if (f.main) continue;
      const why = inside(f.path, here) ? 'you are working in it' : locked.has(f.path) ? 'locked in git' : f.stage === 'unreadable' ? 'git cannot read it'
        : f.idleDays < idleDays ? `used ${f.idleDays === 0 ? 'today' : `${f.idleDays} day(s) ago`}` : null;
      plan.push({ project: p.name, common, path: f.path, branch: f.branch, stage: f.stage, madeBy: f.madeBy, idleDays: f.idleDays,
        changed: f.changed, unpushed: f.unpushed, keep: why ?? null });
    }
  }
  const candidates = [...plan.filter((x) => !x.keep), ...await closeLeftovers(options)];
  await pool(candidates, 4, async (x) => { const m = await measure(x.path); x.bytes = m.bytes; x.freeable = m.freeable; });
  return { idleDays, folders: plan, candidates, freeable: candidates.reduce((s, x) => s + (x.freeable ?? 0), 0), at: now };
}

/** A folder git has let go of (not listed, no .git file of its own): delete what is left. Node removes paths
 * longer than Windows' limit and removes junctions without following them into what they point at. */
async function finishLeftover(path, common) {
  const listed = linkedWorktreesAll(common);
  if ([listed.main, ...listed.linked.map((w) => w.path)].some((p) => resolve(p) === resolve(path))) return false;
  if (await lstat(join(path, '.git'))) return false;
  await fs.rm(path, { recursive: true, force: true, maxRetries: 3 });
  return !await lstat(path);
}

/** Folders an earlier close saved but could not finish removing: saved, no longer known to git, still on disk. */
async function closeLeftovers(options = {}) {
  const out = [];
  const closed = (await fs.readFile(join(tidyHome(options), 'closed.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).map((c) => ({ ...c, id: c.savedId }));
  for (const r of [...await savedList(options), ...closed]) {
    if (!r.common || out.some((x) => x.path === r.path) || !await lstat(r.path) || await lstat(join(r.path, '.git'))) continue;
    try {
      const listed = linkedWorktreesAll(r.common);
      if ([listed.main, ...listed.linked.map((w) => w.path)].some((p) => resolve(p) === resolve(r.path))) continue;
    } catch { continue; }
    // The project is the repository's main checkout, not the worktree folder's own name.
    let project = r.project;
    try { project = basename(linkedWorktreesAll(r.common).main); } catch {}
    out.push({ project, common: r.common, path: r.path, branch: r.branch, stage: 'leftover', savedId: r.id, idleDays: 0, keep: null, leftover: true });
  }
  return out;
}

export async function closeFolders(plan, options = {}) {
  const receipt = { closed: [], failed: [], saved: [], bundles: [], freed: 0 };
  const byProject = new Map();
  let done = 0;
  for (const x of plan.candidates) {
    options.onStep?.({ done: done++, total: plan.candidates.length, note: x.path });
    try {
      if (x.leftover) {
        // Saved by an earlier close (x.savedId); git no longer knows it: only the files are left to delete.
        if (!await finishLeftover(x.path, x.common)) throw new Error('could not delete the leftover files');
        receipt.closed.push(x); receipt.freed += x.freeable ?? 0;
        continue;
      }
      await prepareWorktree(x.path, { ...options, yes: true });
      const saved = await saveFolder(x.path, { ...options, deferIndex: true });
      if (!saved.saved && !/nothing here/.test(saved.reason)) throw new Error(`not saved: ${saved.reason}`);
      if (saved.saved) { receipt.saved.push(saved); if (!byProject.has(x.common)) byProject.set(x.common, []); byProject.get(x.common).push(saved); }
      // A record of every folder close lets go of, saved or not, so a later run can finish one git left behind.
      await fs.mkdir(tidyHome(options), { recursive: true });
      await fs.appendFile(join(tidyHome(options), 'closed.jsonl'), JSON.stringify({ path: x.path, common: x.common, savedId: saved.saved ? saved.id : null, at: new Date().toISOString() }) + '\n');
      // The save is proven; git removes the folder (forced: untracked and ignored files are saved or rebuilt).
      // On Windows git drops the worktree and then stops at "Filename too long" (deep node_modules paths), leaving
      // files behind (2026-11-17: 26 of 42). Those are finished here, only once git no longer knows the folder.
      if ((git(['worktree', 'remove', '--force', x.path], x.common) === null || await lstat(x.path)) && !await finishLeftover(x.path, x.common))
        throw new Error('git could not remove the folder');
      receipt.closed.push(x); receipt.freed += x.freeable ?? 0;
    } catch (error) { receipt.failed.push({ path: x.path, error: String(error.message ?? error) }); }
  }
  // One file per project holding every commit saved in this run that no remote has.
  for (const [common, records] of byProject) {
    const name = slug(records[0].project), file = join(tidyHome(options), 'saved', `${name}-${stampOf(plan.at)}.bundle`);
    const bundle = await writeBundle(common, records.map((r) => r.ref), file);
    for (const r of records) r.bundle = bundle;
    if (bundle) receipt.bundles.push(bundle);
    await recordSaved(records, options);
  }
  return receipt;
}

export function formatClose(plan) {
  const lines = [];
  const kept = plan.folders.filter((x) => x.keep), go = plan.candidates;
  if (!plan.folders.length && !plan.candidates.length) return 'No worktrees here. (The main checkout is never closed.)';
  const leftovers = go.filter((x) => x.leftover).length;
  lines.push(`${go.length - leftovers} idle worktree(s) can be closed, freeing about ${size(plan.freeable)}. Their work is saved first: ${go.filter((x) => x.stage === 'uncommitted' || x.stage === 'not pushed' || x.stage === 'no remote').length} hold unfinished work.` +
    (leftovers ? ` Also ${leftovers} folder(s) an earlier close saved but could not finish deleting.` : ''));
  for (const x of go.sort((a, b) => (b.freeable ?? 0) - (a.freeable ?? 0)))
    lines.push(`  ${size(x.freeable ?? 0).padStart(8)}  ${(x.branch ?? '(no branch)').slice(0, 40).padEnd(40)} ${x.stage.padEnd(12)} idle ${String(x.idleDays).padStart(3)} d  ${x.path}`);
  if (kept.length) lines.push('', `Kept (${kept.length}):`, ...kept.map((x) => `  ${x.path}: ${x.keep}`));
  return lines.join('\n');
}

/** One file holding the saved commits that exist nowhere else (commits already on a remote are left out). */
async function writeBundle(top, refs, file) {
  await fs.mkdir(join(file, '..'), { recursive: true });
  const hasRemote = Boolean(git(['remote'], top));
  const made = (hasRemote && git(['bundle', 'create', file, ...refs, '--not', '--remotes'], top) !== null) || git(['bundle', 'create', file, ...refs], top) !== null;
  return made && git(['bundle', 'verify', file], top) !== null ? file : null;
}

export async function savedList(options = {}) {
  const text = await fs.readFile(join(tidyHome(options), 'saved', 'index.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/** Put saved work back into a folder: the same branch (or commit), the same uncommitted changes, the kept files. */
export async function restoreSaved(id, options = {}) {
  const record = (await savedList(options)).find((r) => r.id === id);
  if (!record) throw new Error(`no saved work with id ${id} (list them with: codein-tidy saved)`);
  const to = resolve(options.to ?? record.path);
  if (await lstat(to)) throw new Error(`${to} already exists; pass --to=<new folder>`);
  if (git(['cat-file', '-e', `${record.snapshot}^{commit}`], record.common) === null) {
    if (!record.bundle || git(['fetch', '--quiet', record.bundle, `${record.ref}:${record.ref}`], record.common) === null)
      throw new Error('the snapshot is missing from the repository and its bundle could not be read');
  }
  const branchFree = record.branch && git(['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`], record.common) === record.head
    && !(git(['worktree', 'list', '--porcelain'], record.common) ?? '').split(/\r?\n/).includes(`branch refs/heads/${record.branch}`);
  const base = record.head ?? record.snapshot;
  if (git(['worktree', 'add', ...(branchFree ? [to, record.branch] : ['--detach', to, base])], record.common) === null) throw new Error(`git could not create ${to}`);
  if (record.snapshot !== record.head && git(['restore', `--source=${record.snapshot}`, '--worktree', '--', '.'], to) === null)
    throw new Error('git could not put the saved changes back');
  if (record.kept) {
    const manifest = JSON.parse(await fs.readFile(join(record.kept.dir, 'manifest.json'), 'utf8'));
    for (const f of manifest.files) {
      const target = join(to, f.rel);
      await fs.mkdir(join(target, '..'), { recursive: true });
      await fs.copyFile(join(record.kept.dir, f.rel), target);
      if (await sha256(target) !== f.sha256) throw new Error(`kept file ${f.rel} did not restore exactly`);
    }
  }
  const tree = folderTree(to, classifyChanges(to).state);
  return { restored: tree === record.tree, path: to, branch: branchFree ? record.branch : null, tree, expected: record.tree };
}

// ---------------------------------------------------------------------------------------------------------------
// Slots: a project gets a small, fixed pool of working folders (its budget, default 3, or "budget" in
// .codein-tidy.json), kept beside the main checkout in <project>.slots/<n>. A task takes a free slot and switches
// branch inside it, as a person would; installed dependencies stay. A new folder is made only while the project
// is under budget. Work left in a slot is saved before the slot is reused. Registry: ~/.codein-tidy/slots.json.
// ---------------------------------------------------------------------------------------------------------------
export const DEFAULT_BUDGET = 3;

async function projectConfig(main) {
  try { return JSON.parse(await fs.readFile(join(main, '.codein-tidy.json'), 'utf8')); } catch { return {}; }
}
export async function projectBudget(main) {
  const n = Number((await projectConfig(main)).budget);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_BUDGET;
}

function projectOf(path) {
  const commonRaw = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path);
  if (!commonRaw) throw new Error(`${path} is not inside a git project`);
  const common = resolve(commonRaw);
  const listed = linkedWorktreesAll(common);
  return { common, main: listed.main, linked: listed.linked };
}
/** All worktrees of a repository, including missing ones git still lists (they count toward the budget). */
function linkedWorktreesAll(common) {
  const blocks = (git(['worktree', 'list', '--porcelain'], common) ?? '').split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/))
    .filter((l) => l[0]?.startsWith('worktree ') && !l.includes('bare'));
  return { main: resolve(blocks[0][0].slice(9)), linked: blocks.slice(1).map((l) => ({ path: resolve(l[0].slice(9)),
    branch: (l.find((x) => x.startsWith('branch ')) ?? '').replace('branch refs/heads/', '') || null, locked: l.some((x) => x.startsWith('locked')) })) };
}

async function withRegistry(options, change) {
  const dir = tidyHome(options), file = join(dir, 'slots.json'), lock = join(dir, 'slots.lock');
  await fs.mkdir(dir, { recursive: true });
  let handle;
  for (let attempt = 0; ; attempt++) {
    try { handle = await fs.open(lock, 'wx'); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(lock);
      if (stat && Date.now() - stat.mtimeMs > 60_000) { await fs.rm(lock, { force: true }); continue; } // a crashed holder
      if (attempt > 200) throw new Error('the slot registry is busy; try again');
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  try {
    const registry = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{"projects":{}}'));
    const result = await change(registry);
    await fs.writeFile(file + '.tmp', JSON.stringify(registry, null, 2));
    await fs.rename(file + '.tmp', file);
    return result;
  } finally { await handle.close(); await fs.rm(lock, { force: true }); }
}

/** Switch a clean folder to a branch: the local one, else the remote one, else a new one from base. */
function switchBranch(path, branch, base) {
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], path)) return git(['switch', '--quiet', branch], path) !== null;
  if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], path)) return git(['switch', '--quiet', '-c', branch, '--track', `origin/${branch}`], path) !== null;
  return git(['switch', '--quiet', '-c', branch, ...(base ? [base] : [])], path) !== null;
}

export async function takeSlot(options) {
  const { branch, holder = 'agent', base } = options;
  if (!branch || !/^[\w./-]+$/.test(branch)) throw new Error('--branch=<name> is required');
  const p = projectOf(options.project ?? options.cwd ?? process.cwd());
  const budget = await projectBudget(p.main);
  const busy = p.linked.find((w) => w.branch === branch);
  return withRegistry(options, async (registry) => {
    const entry = (registry.projects[p.common] ??= { main: p.main, slots: [] });
    entry.slots = entry.slots.filter((s) => p.linked.some((w) => w.path === s.path)); // forget slots git no longer lists
    if (busy) {
      const mine = entry.slots.find((s) => s.path === busy.path);
      if (mine && mine.state === 'idle') { Object.assign(mine, { state: 'in use', holder, since: new Date().toISOString() }); return { path: busy.path, branch, reused: true, created: false }; }
      throw new Error(`branch ${branch} is already checked out in ${busy.path}`);
    }
    const free = entry.slots.find((s) => s.state === 'idle');
    if (free) {
      const plan = await savePlan(free.path);
      let saved = null;
      if (plan.changed || plan.unreferenced || plan.keep.length) {
        saved = await saveFolder(free.path, options);
        if (!saved.saved) throw new Error(`slot ${free.path} holds work that could not be saved: ${saved.reason}`);
      }
      // Saved and proven: the slot may be cleaned. Ignored files (installed dependencies) stay.
      if (plan.changed && (git(['reset', '--hard', '--quiet'], free.path) === null || git(['clean', '-fdq'], free.path) === null)) throw new Error(`could not clean slot ${free.path}`);
      if (!switchBranch(free.path, branch, base)) throw new Error(`could not switch ${free.path} to ${branch}`);
      Object.assign(free, { state: 'in use', holder, branch, since: new Date().toISOString() });
      return { path: free.path, branch, reused: true, created: false, savedFirst: saved?.id ?? null };
    }
    if (p.linked.length >= budget) {
      const err = new Error(`${basename(p.main)} already has ${p.linked.length} worktree(s), its budget is ${budget}. ` +
        'Release a slot you finished (codein-tidy slot release), or close idle worktrees (codein-tidy close), then take one again.');
      err.code = 'OVER_BUDGET'; throw err;
    }
    const root = `${p.main}.slots`;
    let n = 1; while (p.linked.some((w) => w.path === join(root, String(n))) || await lstat(join(root, String(n)))) n += 1;
    const path = join(root, String(n));
    await fs.mkdir(root, { recursive: true });
    const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], p.main);
    const remote = !exists && git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], p.main);
    const args = exists ? ['worktree', 'add', '--quiet', path, branch] : remote ? ['worktree', 'add', '--quiet', '--track', '-b', branch, path, `origin/${branch}`]
      : ['worktree', 'add', '--quiet', '-b', branch, path, ...(base ? [base] : [])];
    if (git(args, p.main) === null) throw new Error(`git could not create ${path}`);
    entry.slots.push({ path: resolve(path), state: 'in use', holder, branch, since: new Date().toISOString() });
    return { path: resolve(path), branch, reused: false, created: true };
  });
}

export async function releaseSlot(options) {
  const path = resolve(options.path ?? options.cwd ?? process.cwd());
  const top = resolve(git(['rev-parse', '--show-toplevel'], path) ?? path);
  const p = projectOf(top);
  return withRegistry(options, async (registry) => {
    const slot = registry.projects[p.common]?.slots.find((s) => s.path === top);
    if (!slot) throw new Error(`${top} is not a slot (take one with: codein-tidy slot take --branch=<name>)`);
    const plan = await savePlan(top);
    const saved = plan.changed || plan.unreferenced || plan.keep.length ? await saveFolder(top, options) : null;
    if (saved && !saved.saved) throw new Error(`could not save the work in ${top}: ${saved.reason}`);
    Object.assign(slot, { state: 'idle', holder: null, since: new Date().toISOString() });
    return { path: top, savedId: saved?.id ?? null };
  });
}

export async function listSlots(options = {}) {
  const registry = JSON.parse(await fs.readFile(join(tidyHome(options), 'slots.json'), 'utf8').catch(() => '{"projects":{}}'));
  return Object.entries(registry.projects).map(([common, e]) => ({ common, main: e.main, slots: e.slots }));
}

// ---------------------------------------------------------------------------------------------------------------
// Enforcement. A pre-shell hook (Claude Code PreToolUse, Codex PreToolUse, Cursor beforeShellExecution) hands
// guard-shell the command an agent is about to run. A `git worktree add` in a project at its budget is refused,
// with the way forward. Anything else, and any error, is allowed: the guard must never break an agent's shell.
// ---------------------------------------------------------------------------------------------------------------
const WORKTREE_ADD = /(?:^|[;&|(]\s*|\s)git((?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+)|\s+-c\s+\S+|\s+--[\w-]+(?:=\S+)?)*)\s+worktree\s+add\b/;

export async function guardShell(input, options = {}) {
  const tool = input?.tool_input ?? input?.toolInput ?? {};
  const command = [tool.command, tool.cmd, input?.command].map((c) => Array.isArray(c) ? c.join(' ') : c).find((c) => typeof c === 'string') ?? '';
  const match = WORKTREE_ADD.exec(command);
  if (!match) return null;
  const dirArg = /-C\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(match[1] ?? '');
  const cwd = resolve(input?.cwd ?? options.cwd ?? process.cwd());
  const where = dirArg ? resolve(cwd, dirArg[2] ?? dirArg[3] ?? dirArg[4]) : cwd;
  let p;
  try { p = projectOf(where); } catch { return null; }
  const budget = await projectBudget(p.main);
  if (p.linked.length < budget) return null;
  return `${basename(p.main)} already has ${p.linked.length} worktree(s); its budget is ${budget}. Do not create another one. ` +
    'Take a working folder from the pool instead: `npx -y codein-tidy@latest slot take --branch=<name>` (it reuses an idle one). ' +
    'If none is free, run `npx -y codein-tidy@latest close` to see which idle worktrees can be saved and freed, and ask the person before running it with --yes.';
}

export const RULES_BLOCK = `<!-- codein-tidy:start -->
## Working folders (codein-tidy)

Keep this project lean. Work lives in git; folders are disposable.
- Do not run \`git worktree add\`. Take a working folder from the project's pool: \`npx -y codein-tidy@latest slot take --branch=<name>\`, and release it when the task ends: \`npx -y codein-tidy@latest slot release\`.
- Before a session ends, commit your work on its branch. Never leave work only in a folder.
- Scratch files (probes, screenshots, logs) go in the system temp folder, never in the project.
- At the start of a session, check unfinished work: \`npx -y codein-tidy@latest work\`. Tell the person what is there before starting something new.
- Never delete, reset or stash someone's uncommitted work. Ask the person before pushing or merging.
<!-- codein-tidy:end -->`;

export async function writeRules(project) {
  const top = git(['rev-parse', '--show-toplevel'], project);
  if (!top) throw new Error(`${project} is not inside a git project`);
  const file = join(top, 'AGENTS.md');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const start = text.indexOf('<!-- codein-tidy:start -->'), end = text.indexOf('<!-- codein-tidy:end -->');
  const next = start >= 0 && end > start ? text.slice(0, start) + RULES_BLOCK + text.slice(end + '<!-- codein-tidy:end -->'.length)
    : (text ? text.replace(/\s*$/, '\n\n') : '') + RULES_BLOCK + '\n';
  if (next !== text) await fs.writeFile(file, next);
  return { file, changed: next !== text };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared dependencies: install once, link everywhere. For every working folder of a project, find each install,
// prove from sampled link counts whether it is shared with a store or a private copy, measure what is copied,
// and say why and how to share it. One small table per ecosystem, found from the lockfile; nothing is changed.
// ---------------------------------------------------------------------------------------------------------------
const ECOSYSTEMS = [
  { name: 'pnpm', lock: 'pnpm-lock.yaml', dir: 'node_modules', sample: '.pnpm',
    copied: (f) => f.storeDrive && f.storeDrive !== f.drive
      ? `pnpm's store is on ${f.storeDrive}, this folder on ${f.drive}; hard links cannot cross drives. Put a store on ${f.drive}: pnpm config set store-dir ${f.drive}\\.pnpm-store, then pnpm install.`
      : 'pnpm copied instead of linking: check package-import-method (pnpm config get package-import-method) and set it to hardlink or auto, then pnpm install.' },
  { name: 'npm', lock: 'package-lock.json', dir: 'node_modules', copied: () => 'npm has no shared store: every folder holds its own copy. Reuse folders (codein-tidy slot take) or switch the project to pnpm.' },
  { name: 'Yarn', lock: 'yarn.lock', dir: 'node_modules', copied: () => 'Yarn node_modules are copies per folder. Reuse folders (codein-tidy slot take), or use Yarn PnP or pnpm.' },
  { name: 'Bun', lock: ['bun.lockb', 'bun.lock'], dir: 'node_modules', copied: () => 'Bun copied the install: check its backend (bun install --backend=hardlink).' },
  { name: 'uv', lock: 'uv.lock', dir: '.venv', copied: () => 'uv copied the packages: set UV_LINK_MODE=hardlink and keep uv\'s cache (uv cache dir) on the same drive.' },
  { name: 'Poetry', lock: 'poetry.lock', dir: '.venv', copied: () => 'Poetry environments are copies per folder. Reuse folders (codein-tidy slot take), or use uv with UV_LINK_MODE=hardlink.' },
  { name: 'pip', lock: 'requirements.txt', dir: ['.venv', 'venv'], copied: () => 'pip installs are copies per environment. Reuse folders (codein-tidy slot take), or use uv with UV_LINK_MODE=hardlink.' },
  { name: 'Cargo', lock: 'Cargo.lock', dir: 'target', copied: () => 'Each folder builds its own target. Share one: set CARGO_TARGET_DIR to one folder, or reuse folders (codein-tidy slot take).' },
];
const driveOf = (path) => (/^([A-Za-z]:)/.exec(resolve(path))?.[1] ?? '/').toUpperCase();

export async function depsReport(options = {}) {
  const projects = await unfinishedWork({ ...options, cwd: options.project ?? options.cwd ?? process.cwd() });
  const out = [];
  for (const p of projects) {
    const storeAsk = (dir) => { try { return runTool('pnpm', ['store', 'path'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim().split(/\r?\n/).pop(); } catch { return null; } };
    const stores = new Map();
    const installs = [];
    // Installs at the folder's top and in workspace packages (apps/api/node_modules), never inside another install
    // or a dot folder (.vscode-test holds a downloaded app, not this project's dependencies).
    const installDirs = async (root, names) => {
      const found = [];
      const walk = async (dir, depth) => {
        for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
          if (names.includes(e.name)) { found.push(join(dir, e.name)); continue; }
          if (depth < 3 && !REBUILT_DIRS.has(e.name)) await walk(join(dir, e.name), depth + 1);
        }
      };
      await walk(root, 0);
      return found;
    };
    await pool(p.folders, 4, async (f) => {
      for (const eco of ECOSYSTEMS) {
        const locks = [eco.lock].flat();
        if (!(await Promise.all(locks.map((l) => lstat(join(f.path, l))))).some(Boolean)) continue;
        for (const dir of await installDirs(f.path, [eco.dir].flat())) {
          const sampleRoot = eco.sample && await lstat(join(dir, eco.sample)) ? join(dir, eco.sample) : dir;
          const samples = await packageLinks(sampleRoot, 12);
          const linked = samples.filter((n) => n >= 2n).length;
          const shared = samples.length >= 3 && linked >= samples.length * 0.75;
          const m = shared ? { bytes: 0, freeable: 0 } : await measure(dir);
          const drive = driveOf(f.path);
          if (eco.name === 'pnpm' && !shared && !stores.has(drive)) { const s = storeAsk(f.path); stores.set(drive, s); }
          const storeDrive = eco.name === 'pnpm' && stores.get(drive) ? driveOf(stores.get(drive)) : null;
          // A few megabytes of unlinked files is a partial install or files built on install, not a copy problem.
          const small = !shared && m.freeable < (options.smallBytes ?? 50 * 1024 ** 2);
          installs.push({ folder: f.path, main: f.main, ecosystem: eco.name, dir, shared: shared || small, small, samples: samples.length, linked,
            copiedBytes: shared || small ? 0 : m.freeable, smallBytes: small ? m.freeable : 0, why: shared || small ? null : eco.copied({ drive, storeDrive }) });
        }
      }
    });
    installs.sort((a, b) => b.copiedBytes - a.copiedBytes);
    out.push({ name: p.name, installs, copiedBytes: installs.reduce((s, i) => s + i.copiedBytes, 0) });
  }
  return out;
}

export function formatDeps(report) {
  const lines = [];
  for (const p of report) {
    const copied = p.installs.filter((i) => !i.shared), shared = p.installs.filter((i) => i.shared);
    const smallBytes = p.installs.reduce((s, i) => s + (i.smallBytes ?? 0), 0);
    lines.push(`${p.name}: ${p.installs.length} install(s) in its working folders; ${shared.length} shared or small, ${copied.length} private copies holding ${size(p.copiedBytes)}.${smallBytes ? ` (Small unlinked parts, such as files built on install: ${size(smallBytes)}.)` : ''}`);
    if (!copied.length) lines.push('  Nothing to fix: installs here are shared, so a new working folder costs little for dependencies. Fewer folders still save the rest.');
    const reasons = new Map();
    for (const i of copied) { const r = reasons.get(i.why) ?? { n: 0, bytes: 0, eco: i.ecosystem }; r.n += 1; r.bytes += i.copiedBytes; reasons.set(i.why, r); }
    for (const [why, r] of reasons) lines.push(`  ${r.n} ${r.eco} install(s), ${size(r.bytes)}: ${why}`);
    for (const i of copied.slice(0, 8)) lines.push(`    ${size(i.copiedBytes).padStart(8)}  ${i.dir}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() || 'No installs found.';
}

// ---------------------------------------------------------------------------------------------------------------
// Guard: the backstop no harness can skip. Run by the operating system's scheduler once a day, it checks every
// known project against its budget. notify (default) records which are over budget; close saves and closes the
// oldest idle worktrees until the project is back inside its budget. Known projects: those with slots, those
// registered with `guard --install --project=PATH`, and those the tools' worktrees belong to.
// ---------------------------------------------------------------------------------------------------------------
async function knownProjects(options) {
  const mains = new Set((await listSlots(options)).map((p) => p.main));
  const registered = JSON.parse(await fs.readFile(join(tidyHome(options), 'projects.json'), 'utf8').catch(() => '[]'));
  for (const p of registered) mains.add(p);
  const seeds = [...mains];
  for (const t of targets(options).filter((t) => t.kind === 'worktrees')) seeds.push(...await findWorktrees(t.path, 2));
  const out = new Map();
  for (const seed of seeds) { try { const p = projectOf(seed); if (await lstat(p.main)) out.set(p.common, p); } catch {} }
  return [...out.values()];
}

export async function guardRun(options = {}) {
  const mode = options.mode ?? 'notify', now = options.now ?? Date.now();
  const results = [];
  for (const p of await knownProjects(options)) {
    const budget = await projectBudget(p.main);
    const entry = { name: basename(p.main), main: p.main, linked: p.linked.length, budget, over: Math.max(0, p.linked.length - budget), closed: 0, saved: 0, failed: [] };
    if (entry.over && mode === 'close') {
      const plan = await closePlan({ ...options, cwd: p.main, idleDays: options.idleDays ?? 1, now });
      plan.candidates.sort((a, b) => b.idleDays - a.idleDays);
      plan.candidates = plan.candidates.slice(0, entry.over); // only as many as needed, oldest first
      const receipt = await closeFolders(plan, options);
      Object.assign(entry, { closed: receipt.closed.length, saved: receipt.saved.length, failed: receipt.failed, freed: receipt.freed });
      entry.linked -= receipt.closed.length; entry.over = Math.max(0, entry.linked - budget);
    }
    results.push(entry);
  }
  const record = { checkedAt: new Date(now).toISOString(), mode, projects: results };
  await fs.mkdir(tidyHome(options), { recursive: true });
  await fs.writeFile(join(tidyHome(options), 'guard.json'), JSON.stringify(record, null, 2));
  return record;
}

/** The scheduler entry for this operating system: what install runs, shown as is by --dry-run. */
export function guardSchedule({ os = platform(), home = homedir(), node = process.execPath, mode = 'notify' } = {}) {
  const script = join(home, '.codein-tidy', 'bin', 'tidy.mjs');
  const run = [node, script, 'guard', '--run', `--mode=${mode}`];
  if (os === 'win32') {
    const action = run.map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ');
    return { script, install: [['schtasks', ['/Create', '/F', '/SC', 'DAILY', '/ST', '12:30', '/TN', 'codein-tidy-guard', '/TR', action]]],
      uninstall: [['schtasks', ['/Delete', '/F', '/TN', 'codein-tidy-guard']]] };
  }
  if (os === 'darwin') {
    const plist = join(home, 'Library', 'LaunchAgents', 'in.code.codein-tidy-guard.plist');
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>in.code.codein-tidy-guard</string><key>ProgramArguments</key><array>${run.map((a) => `<string>${a}</string>`).join('')}</array><key>StartCalendarInterval</key><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict></dict></plist>\n`;
    return { script, file: { path: plist, body }, install: [['launchctl', ['load', '-w', plist]]], uninstall: [['launchctl', ['unload', '-w', plist]]] };
  }
  const line = `30 12 * * * ${run.map((a) => `'${a}'`).join(' ')} # codein-tidy-guard`;
  return { script, cron: line, install: [], uninstall: [] };
}

export async function guardInstall(options = {}) {
  const s = guardSchedule(options);
  const steps = [`copy this tool to ${s.script}`, ...(s.file ? [`write ${s.file.path}`] : []), ...(s.cron ? [`add to your crontab: ${s.cron}`] : []),
    ...s.install.map(([c, a]) => `${c} ${a.join(' ')}`), ...(options.project ? [`register ${resolve(options.project)}`] : [])];
  if (options.dryRun) return { steps, applied: false };
  await fs.mkdir(join(s.script, '..'), { recursive: true });
  await fs.copyFile(new URL(import.meta.url), s.script);
  if (s.file) { await fs.mkdir(join(s.file.path, '..'), { recursive: true }); await fs.writeFile(s.file.path, s.file.body); }
  if (s.cron) {
    const current = (() => { try { return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } })();
    const next = current.split('\n').filter((l) => l && !l.includes('# codein-tidy-guard')).concat(s.cron).join('\n') + '\n';
    execFileSync('crontab', ['-'], { input: next });
  }
  for (const [command, args] of s.install) execFileSync(command, args, { stdio: 'ignore' });
  if (options.project) {
    const file = join(tidyHome(options), 'projects.json');
    const list = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
    const main = projectOf(options.project).main;
    if (!list.includes(main)) await fs.writeFile(file, JSON.stringify([...list, main], null, 2));
  }
  return { steps, applied: true };
}

export async function guardUninstall(options = {}) {
  const s = guardSchedule(options);
  for (const [command, args] of s.uninstall) { try { execFileSync(command, args, { stdio: 'ignore' }); } catch {} }
  if (s.file) await fs.rm(s.file.path, { force: true });
  if (s.cron) {
    try {
      const current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('crontab', ['-'], { input: current.split('\n').filter((l) => l && !l.includes('# codein-tidy-guard')).join('\n') + '\n' });
    } catch {}
  }
  return { removed: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Guided: `npx codein-tidy` in a terminal does the whole job in one command. It scans everything, shows one review
// list (each item with its size and what will happen), lets the person keep the suggested selection, select all,
// or switch items by number, asks yes or no once, then saves every folder's work into one file per project, and
// frees the rest. Without a terminal (an agent, a script) the command only reports, as before.
// ---------------------------------------------------------------------------------------------------------------
const sumFree = (list) => list.reduce((s, x) => s + (x.freeable ?? 0), 0);
const planFree = (p) => p.removable.reduce((s, e) => s + (e.freeable ?? 0), 0);

export async function guidedPlan(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? Date.now();
  const scanned = await scan({ ...options, cwd, history: true, caches: true, worktrees: false });
  const items = [], notes = [];
  options.onStatus?.({ label: 'Checking idle worktrees', done: 0, total: 0 });
  const close = await closePlan({ ...options, cwd, all: true, now });
  const groups = new Map();
  for (const x of close.candidates) { const key = x.project ?? basename(x.common ?? x.path); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(x); }
  for (const [project, list] of groups) {
    const work = list.filter((x) => ['uncommitted', 'not pushed', 'no remote'].includes(x.stage)).length;
    items.push({ key: `worktrees:${slug(project)}`, kind: 'close', selected: true, bytes: sumFree(list), close: list,
      label: `Idle worktrees of ${project} (${list.length}): save their work${work ? ` (${work} hold unfinished work)` : ''}, then remove`,
      detail: list.map((x) => `${x.path}  ${x.branch ?? '(no branch)'}  ${x.leftover ? 'already saved' : x.stage}`) });
  }
  const others = scanned.filter((p) => p.kind !== 'worktrees' && p.kind !== 'report');
  for (const p of others.filter((p) => p.skipped && /running/.test(p.skipped))) notes.push(`${p.tool}: ${p.item} skipped (${p.skipped})`);
  const ready = others.filter((p) => !p.skipped && p.removable.length && planFree(p) > 0);
  const byTool = new Map();
  for (const p of ready.filter((p) => p.class !== 'history' && p.tool !== 'Package caches')) { if (!byTool.has(p.tool)) byTool.set(p.tool, []); byTool.get(p.tool).push(p); }
  for (const [tool, plans] of byTool)
    items.push({ key: `cleanup:${slug(tool).toLowerCase()}`, kind: 'clean', selected: true, bytes: plans.reduce((s, p) => s + planFree(p), 0), plans,
      label: `${tool}: ${plans.map((p) => p.item.toLowerCase()).join(', ')} past their age limit`, detail: plans.map((p) => `${size(planFree(p)).padStart(8)}  ${p.item}`) });
  const caches = ready.filter((p) => p.tool === 'Package caches');
  if (caches.length) items.push({ key: 'caches', kind: 'clean', selected: true, bytes: caches.reduce((s, p) => s + planFree(p), 0), plans: caches,
    label: 'Package caches: they download again when needed', detail: caches.map((p) => `${size(planFree(p)).padStart(8)}  ${p.item}`) });
  const history = ready.filter((p) => p.class === 'history');
  if (history.length) items.push({ key: 'history', kind: 'clean', selected: false, bytes: history.reduce((s, p) => s + planFree(p), 0), plans: history,
    label: 'Old chat history and edit history (30 days and older): deleted for good', detail: history.map((p) => `${size(planFree(p)).padStart(8)}  ${p.tool}: ${p.item}`) });
  const junk = git(['rev-parse', '--show-toplevel'], cwd) ? await projectPlans(cwd, { ...options, now }) : [];
  const trash = junk.filter((p) => p.kind === 'trash');
  if (trash.length) items.push({ key: 'leftovers', kind: 'clean', selected: true, bytes: trash.reduce((s, p) => s + p.bytes, 0), plans: trash,
    label: `Agent leftovers in this project (screenshots, temp scripts): to trash, emptied after ${TRASH_DAYS} days`, detail: trash.map((p) => `${p.files} file(s)  ${p.item}`) });
  items.sort((a, b) => Number(b.selected) - Number(a.selected) || b.bytes - a.bytes);
  return { items, notes, kept: close.folders.filter((x) => x.keep), at: now };
}

export function formatGuided(plan) {
  const total = plan.items.reduce((s, i) => s + i.bytes, 0), chosen = plan.items.filter((i) => i.selected).reduce((s, i) => s + i.bytes, 0);
  const lines = [`codein-tidy found ${size(total)} you can get back.`, ''];
  plan.items.forEach((item, n) => lines.push(`  [${item.selected ? 'x' : ' '}] ${String(n + 1).padStart(2)}  ${size(item.bytes).padStart(8)}  ${item.label}`));
  if (plan.kept.length) lines.push('', `Kept as they are (${plan.kept.length}): ${plan.kept.slice(0, 3).map((k) => `${k.branch ?? basename(k.path)} (${k.keep})`).join(', ')}${plan.kept.length > 3 ? ', ...' : ''}`);
  for (const note of plan.notes) lines.push(`Note: ${note}`);
  lines.push('', `Selected: ${size(chosen)}.`);
  return lines.join('\n');
}

/** Do the chosen items: worktrees first (work saved into one file per project), then caches, logs and leftovers. */
export async function applyItems(plan, chosen, options = {}, say = () => {}, progress = null) {
  const receipt = { freed: 0, saved: 0, bundles: [], failed: [], moved: 0, trash: undefined };
  const onStep = progress ? (step) => progress.set(step) : undefined;
  const close = chosen.filter((i) => i.kind === 'close').flatMap((i) => i.close);
  if (close.length) {
    const label = 'Saving work, then removing folders';
    if (progress) progress.set({ label, done: 0, total: close.length, note: '' });
    else say(`Saving the work of ${close.length} folder(s), then removing them...`);
    const r = await closeFolders({ candidates: close, at: plan.at }, { ...options, onStep });
    receipt.freed += r.freed; receipt.saved += r.saved.length; receipt.bundles.push(...r.bundles); receipt.failed.push(...r.failed);
    progress?.stop({ ok: !r.failed.length, text: `Saved and removed ${r.closed.length} of ${close.length} folder(s)` });
  }
  const plans = chosen.filter((i) => i.kind === 'clean').flatMap((i) => i.plans);
  if (plans.length) {
    if (progress) progress.set({ label: 'Freeing caches, logs and leftovers', done: 0, total: 0, note: '' });
    else say('Freeing caches, logs and leftovers...');
    const r = await clean(plans, plan.at, { ...(options.runner ? { runner: options.runner } : {}), onStep });
    receipt.freed += r.bytes + r.movedBytes; receipt.moved += r.moved; receipt.trash = r.trash; receipt.failed.push(...r.failed);
    progress?.stop({ ok: !r.failed.length, text: `Freed caches, logs and leftovers (${size(r.bytes + r.movedBytes)})` });
  }
  say('');
  say(`Done. About ${size(receipt.freed)} freed.${receipt.saved ? ` Work from ${receipt.saved} folder(s) saved in:` : ''}`);
  for (const b of receipt.bundles) say(`  ${b}`);
  if (receipt.saved) say('  List saved work: codein-tidy saved. Put a folder back: codein-tidy restore <id>.');
  if (receipt.moved) say(`  ${receipt.moved} project leftover(s) moved to ${receipt.trash}; deleted after ${TRASH_DAYS} days.`);
  for (const f of receipt.failed) say(`  kept ${f.path}: ${f.error}`);
  return receipt;
}

/** The same review for an agent: every item with its name, and how to hand the person's choice back. */
export function formatForAgent(plan) {
  if (!plan.items.length) return 'codein-tidy: nothing to free; everything is in use or still recent.';
  const width = Math.max(...plan.items.map((i) => i.key.length)) + 2;
  const lines = [formatGuided(plan).replace(/^( +\[[ x]\] +(\d+)) +/gm, (whole, lead, n) => `${lead}  ${plan.items[Number(n) - 1].key.padEnd(width)}`), ''];
  lines.push('To the agent: show this list to the person and ask which items to free ([x] are suggested; history is deleted for good).',
    'Then run, with their choice: npx -y codein-tidy@latest --apply=<names, comma separated> (or --apply=suggested, or --apply=all).',
    'Never run --apply without the person\'s answer. Worktrees are saved before they are removed; codein-tidy restore <id> puts one back.');
  return lines.join('\n');
}

/** What a person meant at the review prompt. Plain words work as well as the single letters. */
export function readAnswer(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t || !/\d/.test(t) && /^(go|go on|go ahead|yes|y|ok|okay|continue|proceed|start|done|enter|next|apply|do it)\b/.test(t)) return { action: 'go' };
  if (/^(q|quit|exit|cancel|stop|abort)$/.test(t)) return { action: 'quit' };
  if (/^(a|all|select all|everything)$/.test(t)) return { action: 'all' };
  if (/^(n|none|select none|clear|nothing)$/.test(t)) return { action: 'none' };
  const detail = /^(?:d|details?|show)\s*(\d+)$/.exec(t);
  if (detail) return { action: 'detail', n: Number(detail[1]) };
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.every((p) => /^\d+$/.test(p))) return { action: 'switch', numbers: parts.map(Number) };
  return { action: 'unknown' };
}

const REVIEW_PROMPT = 'Press Enter to go on with the selected items.\nOr type: a (select all), n (select none), numbers to switch items (2 5), d 2 (details), q (quit).\n> ';

// ---- The terminal UI. No dependencies: raw keys from node:readline, ANSI codes for colour and redraw. ----

/** Colours, off with NO_COLOR or when the output is not a terminal. */
function paint(output) {
  const on = Boolean(output.isTTY) && !process.env.NO_COLOR;
  const wrap = (code) => (text) => on ? `\x1b[${code}m${text}\x1b[0m` : String(text);
  return { bold: wrap('1'), dim: wrap('2'), green: wrap('32'), yellow: wrap('33'), cyan: wrap('36'), red: wrap('31') };
}

/** Cut a line to `width` visible characters, keeping colour codes intact. */
function fit(text, width) {
  let out = '', n = 0, coloured = false;
  for (const part of String(text).split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; coloured = true; continue; }
    for (const ch of part) { if (n >= width) return out + (coloured ? '\x1b[0m' : ''); out += ch; n += 1; }
  }
  return out;
}

const tail = (text, width) => text.length > width ? `...${text.slice(text.length - width + 3)}` : text;
const meter = (part, whole, width) => { const f = whole > 0 ? Math.max(part > 0 ? 1 : 0, Math.round(width * Math.min(1, part / whole))) : 0; return '█'.repeat(f) + '░'.repeat(width - f); };
// Braille spinners need a modern terminal font; the old Windows console gets plain ones.
const SPINNER = process.platform !== 'win32' || process.env.WT_SESSION || process.env.TERM_PROGRAM ? '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' : '|/-\\';

/** Redraws a block of lines in place. */
function screen(output) {
  let drawn = 0;
  return {
    width: () => Math.max(40, (output.columns || 100) - 1),
    rows: () => output.rows || 30,
    draw(lines) {
      const width = Math.max(40, (output.columns || 100) - 1);
      output.write(`${drawn ? `\x1b[${drawn}A` : ''}\r\x1b[0J${lines.map((l) => fit(l, width)).join('\n')}\n`);
      drawn = lines.length;
    },
    forget() { drawn = 0; },
  };
}

/** One live line: a spinner, what is happening, a bar with "n of total" and the current folder or item. */
export function progressLine(output) {
  const c = paint(output);
  if (!output.isTTY) return { set() {}, stop() {} };
  const state = { label: '', done: 0, total: 0, note: '' };
  let tick = 0, timer = null;
  const render = () => {
    const width = Math.max(40, (output.columns || 100) - 1);
    const frame = SPINNER[tick++ % SPINNER.length];
    const count = state.total ? `  ${c.dim(meter(state.done, state.total, 20))}  ${state.done} of ${state.total}` : '';
    const left = `  ${c.cyan(frame)} ${state.label}${count}`;
    const room = width - (state.label.length + (state.total ? 40 : 0) + 8);
    const note = state.note && room > 12 ? `  ${c.dim(tail(state.note, room))}` : '';
    output.write(`\r\x1b[2K${fit(left + note, width)}`);
  };
  return {
    set(next) {
      Object.assign(state, next);
      if (!timer) { output.write('\x1b[?25l'); timer = setInterval(render, 90); timer.unref?.(); }
      render();
    },
    stop(result) {
      if (timer) clearInterval(timer);
      timer = null;
      const line = result ? `  ${result.ok === false ? c.yellow('!') : c.green('✓')} ${result.text}\n` : '';
      output.write(`\r\x1b[2K${line}\x1b[?25h`);
    },
  };
}

/** Key presses from a terminal in raw mode, queued so a fast typist or a paste loses none. */
function keyReader(input) {
  const { emitKeypressEvents } = readlineModule;
  emitKeypressEvents(input);
  const queue = [], waiting = [];
  const push = (k) => { if (waiting.length) waiting.shift()(k); else queue.push(k); };
  const onKey = (str, key) => push({ str: str ?? '', key: key ?? {} });
  const onEnd = () => push({ str: '', key: { name: 'eof' } });
  input.setRawMode(true);
  input.on('keypress', onKey);
  input.on('end', onEnd);
  input.resume();
  return {
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((done) => waiting.push(done)),
    close() { input.off('keypress', onKey); input.off('end', onEnd); try { input.setRawMode(false); } catch {} input.pause(); },
  };
}
let readlineModule;

const isQuit = ({ key }) => key.name === 'eof' || key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c');

function itemLines(plan, at, open, c, scr, message) {
  const total = plan.items.reduce((s, i) => s + i.bytes, 0), chosen = plan.items.filter((i) => i.selected).reduce((s, i) => s + i.bytes, 0);
  const largest = Math.max(1, ...plan.items.map((i) => i.bytes));
  const lines = [`  ${c.bold(size(total))} can be freed. Choose what to free.`, ''];
  plan.items.forEach((item, n) => {
    const here = n === at;
    const box = item.selected ? c.green('[x]') : c.dim('[ ]');
    const split = item.label.indexOf(': ');
    const title = split > 0 ? item.label.slice(0, split) : item.label, about = split > 0 ? item.label.slice(split + 2) : '';
    const what = item.key === 'history' ? c.yellow(about) : c.dim(about);
    lines.push(`${here ? c.cyan(' > ') : '   '}${box} ${size(item.bytes).padStart(8)}  ${c.dim(meter(item.bytes, largest, 10))}  ${here ? c.bold(title) : title}  ${what}`);
    if (n === open) {
      const room = Math.max(3, scr.rows() - plan.items.length - 12);
      for (const d of item.detail.slice(0, room)) lines.push(`        ${c.dim(d)}`);
      if (item.detail.length > room) lines.push(`        ${c.dim(`and ${item.detail.length - room} more`)}`);
    }
  });
  lines.push('');
  if (plan.kept.length) lines.push(c.dim(`  Kept as they are (${plan.kept.length}): ${plan.kept.slice(0, 3).map((k) => `${k.branch ?? basename(k.path)} (${k.keep})`).join(', ')}${plan.kept.length > 3 ? ', ...' : ''}`));
  for (const note of plan.notes) lines.push(c.dim(`  ${note}`));
  lines.push(`  Selected: ${c.bold(size(chosen))} of ${size(total)}`, '');
  lines.push(message ? `  ${c.yellow(message)}` : `  ${c.bold('Up/Down')} move   ${c.bold('Space')} select   ${c.bold('A')} all   ${c.bold('Right')} details   ${c.bold('Enter')} continue   ${c.bold('Q')} quit`);
  return lines;
}

/** The list: arrow keys move, space selects, Enter continues. Returns 'go' or 'quit'. */
async function pickItems(plan, keys, scr, c) {
  let at = 0, open = -1, message = '';
  for (;;) {
    scr.draw(itemLines(plan, at, open, c, scr, message));
    message = '';
    const press = await keys.next(), { key, str } = press, n = plan.items.length;
    if (isQuit(press)) return 'quit';
    if (key.name === 'up' || key.name === 'k') at = (at + n - 1) % n;
    else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') at = (at + 1) % n;
    else if (key.name === 'space' || key.name === 'x') plan.items[at].selected = !plan.items[at].selected;
    else if (key.name === 'a') { const all = plan.items.every((i) => i.selected); plan.items.forEach((i) => { i.selected = !all; }); }
    else if (key.name === 'n') plan.items.forEach((i) => { i.selected = false; });
    else if (key.name === 'right' || key.name === 'l' || key.name === 'd') open = open === at ? -1 : at;
    else if (key.name === 'left' || key.name === 'h') open = -1;
    else if (/^[1-9]$/.test(str) && Number(str) <= n) { at = Number(str) - 1; plan.items[at].selected = !plan.items[at].selected; }
    else if (key.name === 'return' || key.name === 'enter') {
      if (plan.items.some((i) => i.selected)) return 'go';
      message = 'Nothing is selected. Press Space on an item, or A for all.';
    }
  }
}

/** Yes / back / quit, by arrow keys (or y, n, q). */
async function confirmChoice(plan, chosen, keys, scr, c) {
  const folders = chosen.filter((i) => i.kind === 'close').reduce((n, i) => n + i.close.length, 0);
  const freed = size(chosen.reduce((s, i) => s + i.bytes, 0));
  const options = [
    { value: 'yes', label: folders ? `Yes: save the work of ${folders} folder(s), then free about ${freed}` : `Yes: free about ${freed}` },
    { value: 'back', label: 'No: back to the list' },
    { value: 'quit', label: 'Quit without changing anything' },
  ];
  let at = 0;
  for (;;) {
    const lines = [`  ${c.bold('Ready.')}`];
    if (folders) lines.push(c.dim(`  Each folder's work is saved into one file per project first. codein-tidy restore <id> puts one back.`));
    if (chosen.some((i) => i.key === 'history')) lines.push(`  ${c.yellow('Old chat history will be deleted for good.')}`);
    lines.push('');
    options.forEach((o, n) => lines.push(`${n === at ? c.cyan(' > ') : '   '}${n === at ? c.bold(o.label) : o.label}`));
    lines.push('', `  ${c.bold('Up/Down')} move   ${c.bold('Enter')} choose`);
    scr.draw(lines);
    const press = await keys.next(), { key } = press;
    if (isQuit(press)) return 'quit';
    if (key.name === 'y') return 'yes';
    if (key.name === 'n' || key.name === 'left' || key.name === 'backspace') return 'back';
    if (key.name === 'up' || key.name === 'k') at = (at + options.length - 1) % options.length;
    else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') at = (at + 1) % options.length;
    else if (key.name === 'return' || key.name === 'enter') return options[at].value;
  }
}

/** The whole job in a terminal: scan with a live bar, pick with the arrow keys, confirm, then do it with a live bar. */
async function guidedTui({ input, output, options }) {
  readlineModule ??= await import('node:readline');
  const c = paint(output), scr = screen(output), progress = progressLine(output);
  const say = (text) => output.write(text + '\n');
  say('');
  say(`  ${c.bold('codein-tidy')}  ${c.dim('frees what AI coding tools leave behind')}`);
  say('');
  progress.set({ label: 'Looking at what AI coding tools left', done: 0, total: 0, note: '' });
  let plan;
  try { plan = await guidedPlan({ ...options, onStatus: (s) => progress.set({ note: '', ...s }) }); }
  finally { progress.stop(); }
  if (!plan.items.length) { say(`  ${c.green('✓')} Nothing to free: everything is in use or still recent.`); return { done: false }; }
  const keys = keyReader(input);
  let chosen;
  output.write('\x1b[?25l');
  try {
    for (;;) {
      if (await pickItems(plan, keys, scr, c) === 'quit') { say(''); say('  Nothing was changed.'); return { done: false }; }
      chosen = plan.items.filter((i) => i.selected);
      const answer = await confirmChoice(plan, chosen, keys, scr, c);
      if (answer === 'quit') { say(''); say('  Nothing was changed.'); return { done: false }; }
      if (answer === 'yes') break;
    }
  } finally { keys.close(); output.write('\x1b[?25h'); }
  scr.forget();
  say('');
  const receipt = await applyItems(plan, chosen, options, (line) => say(line.startsWith('Done.') ? `  ${c.green(c.bold(line))}` : line ? `  ${line}` : ''), progress);
  return { done: true, receipt };
}

/** Ask, then do. In a terminal: arrow keys and live progress. Through a pipe (an agent, a test): plain words. */
export async function guidedRun({ input = process.stdin, output = process.stdout, options = {} } = {}) {
  if (input.isTTY && typeof input.setRawMode === 'function' && output.isTTY) return guidedTui({ input, output, options });
  return guidedLines({ input, output, options });
}

async function guidedLines({ input, output, options }) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => { output.write(prompt); const next = await lines.next(); return next.done ? 'q' : String(next.value).trim(); };
  const say = (text) => output.write(text + '\n');
  try {
    say('Looking at everything AI coding tools left on this machine. This reads only...');
    const plan = await guidedPlan(options);
    if (!plan.items.length) { say('Nothing to free: everything is in use or still recent.'); return { done: false }; }
    let redraw = true;
    for (;;) {
      if (redraw) { say(''); say(formatGuided(plan)); }
      redraw = true;
      const raw = await ask(REVIEW_PROMPT);
      const answer = readAnswer(raw);
      if (answer.action === 'quit') { say('Nothing was changed.'); return { done: false }; }
      if (answer.action === 'all') { plan.items.forEach((i) => { i.selected = true; }); continue; }
      if (answer.action === 'none') { plan.items.forEach((i) => { i.selected = false; }); continue; }
      if (answer.action === 'detail') {
        const item = plan.items[answer.n - 1];
        if (item) { say(''); say(item.label); item.detail.forEach((d) => say(`    ${d}`)); }
        else say(`There is no item ${answer.n}.`);
        redraw = false; continue;
      }
      if (answer.action === 'switch') {
        const missing = answer.numbers.filter((n) => !plan.items[n - 1]);
        for (const n of answer.numbers) if (plan.items[n - 1]) plan.items[n - 1].selected = !plan.items[n - 1].selected;
        if (missing.length) say(`There is no item ${missing.join(', ')}.`);
        continue;
      }
      if (answer.action === 'unknown') { say(`Not sure what "${raw}" means.`); redraw = false; continue; }
      const chosen = plan.items.filter((i) => i.selected);
      if (!chosen.length) { say('Nothing is selected. Type a to select all, or item numbers.'); redraw = false; continue; }
      const folders = chosen.filter((i) => i.kind === 'close').reduce((n, i) => n + i.close.length, 0);
      const question = `\n${folders ? `Save the work of ${folders} folder(s) into one file per project, then free` : 'Free'} about ${size(chosen.reduce((s, i) => s + i.bytes, 0))}? Type y to go ahead, n to stop: `;
      let confirm = '';
      for (;;) {
        confirm = (await ask(question)).toLowerCase();
        if (/^(y|yes|go|ok|okay|go ahead)$/.test(confirm) || /^(n|no|q|quit|stop|cancel)$/.test(confirm)) break;
        say('Type y or n.');
      }
      if (!/^(y|yes|go|ok|okay|go ahead)$/.test(confirm)) { say('Nothing was changed.'); return { done: false }; }
      return { done: true, receipt: await applyItems(plan, chosen, options, say) };
    }
  } finally { rl.close(); }
}

/** Run the command line. Exported so a host CLI (code.in's `codein tidy`) can call it. */
export async function main(argv) {
  const args = new Set(argv.filter((a) => a.startsWith('--')));
  const command = argv.find((a) => !a.startsWith('--')) ?? 'report';
  const older = argv.find((a) => a.startsWith('--older-than='));
  const project = argv.find((a) => a === '--project' || a.startsWith('--project='));
  for (const a of args) if (a.startsWith('--project=')) args.delete(a);
  const options = { history: args.has('--history'), worktrees: args.has('--worktrees'), deep: args.has('--deep'), caches: args.has('--caches'),
    ...(project ? { project: project.includes('=') ? resolve(project.split('=').slice(1).join('=')) : process.cwd() } : {}),
    ...(older ? { olderThanDays: Number(older.split('=')[1]) } : {}) };
  const positional = argv.filter((a) => !a.startsWith('--'));
  const value = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined; };
  // The bare command does the whole job. A person in a terminal reviews and confirms once. An agent gets the same
  // review as text (or --json) to show the person, then hands their choice back with --apply.
  const apply = value('apply');
  if (!positional.length && !args.has('--report')) {
    if (apply === undefined && !args.has('--json') && process.stdin.isTTY && process.stdout.isTTY) {
      await guidedRun({ options });
      console.log('\nKeep your disk free automatically: code.in cleans up after itself. https://code.in');
      return;
    }
    const plan = await guidedPlan(options);
    if (apply === undefined) {
      console.log(args.has('--json') ? JSON.stringify(plan.items.map(({ key, label, bytes, selected, detail }) => ({ key, label, bytes, suggested: selected, detail })), null, 2) : formatForAgent(plan));
      return;
    }
    const names = apply.split(',').map((n) => n.trim()).filter(Boolean);
    const chosen = names.includes('all') ? plan.items : names.includes('suggested') ? plan.items.filter((i) => i.selected) : plan.items.filter((i) => names.includes(i.key));
    const unknown = names.filter((n) => !['all', 'suggested'].includes(n) && !plan.items.some((i) => i.key === n));
    if (unknown.length) console.log(`Not found now (in use, already freed, or never there): ${unknown.join(', ')}.`);
    if (!chosen.length) { console.log('Nothing to do.'); return; }
    const receipt = await applyItems(plan, chosen, options, (line) => console.log(line));
    if (args.has('--json')) console.log(JSON.stringify(receipt));
    return;
  }
  const COMMANDS = ['report', 'clean', 'review', 'prepare', 'work', 'save', 'saved', 'restore', 'close', 'slot', 'guard-shell', 'rules', 'deps', 'guard'];
  if (command === 'guard') {
    const mode = value('mode') ?? 'notify';
    if (!['notify', 'close'].includes(mode)) { console.error('--mode must be notify or close'); process.exitCode = 2; return; }
    if (args.has('--install')) {
      const r = await guardInstall({ ...options, mode, dryRun: args.has('--dry-run') });
      console.log(`${r.applied ? 'Installed' : 'Would do (nothing changed)'}:\n${r.steps.map((s) => `  ${s}`).join('\n')}`);
      if (r.applied) console.log(`The guard runs daily in ${mode} mode. Remove it with: codein-tidy guard --uninstall`);
    } else if (args.has('--uninstall')) { await guardUninstall(options); console.log('Removed the daily guard.'); }
    else {
      const r = await guardRun({ ...options, mode });
      if (args.has('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
      for (const p of r.projects) console.log(`${p.name}: ${p.linked} worktree(s), budget ${p.budget}${p.over ? `, ${p.over} over` : ', within budget'}${p.closed ? `; closed ${p.closed} (work saved from ${p.saved})` : ''}${p.failed.length ? `; could not close ${p.failed.length}` : ''}.`);
      if (!r.projects.length) console.log('No known projects yet. Register one: codein-tidy guard --install --project=PATH');
    }
    return;
  }
  if (command === 'deps') {
    const report = await depsReport({ ...options, all: args.has('--all') });
    console.log(args.has('--json') ? JSON.stringify(report, null, 2) : formatDeps(report));
    return;
  }
  if (command === 'guard-shell') {
    // Called by a harness's pre-shell hook with the tool call as JSON on stdin. Silent allow by default.
    try {
      let raw = ''; for await (const chunk of process.stdin) raw += chunk;
      const reason = await guardShell(raw.trim() ? JSON.parse(raw) : {});
      if (reason) {
        if (args.has('--cursor')) console.log(JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }));
        else console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
      }
    } catch {}
    return;
  }
  if (command === 'rules') {
    if (args.has('--write')) { const r = await writeRules(options.project ?? process.cwd()); console.log(r.changed ? `Added the codein-tidy rules to ${r.file}.` : `${r.file} already has them.`); }
    else console.log(RULES_BLOCK);
    return;
  }
  if (command === 'slot') {
    const action = positional[1];
    try {
      if (action === 'take') {
        const r = await takeSlot({ ...options, branch: value('branch'), base: value('base'), holder: value('holder') });
        console.log(args.has('--json') ? JSON.stringify(r) : `${r.created ? 'New slot' : 'Slot'} ${r.path} is yours, on branch ${r.branch}.${r.savedFirst ? ` Work left in it was saved first (${r.savedFirst}).` : ''}`);
      } else if (action === 'release') {
        const r = await releaseSlot({ ...options, path: value('path') });
        console.log(args.has('--json') ? JSON.stringify(r) : `Released ${r.path}.${r.savedId ? ` Its work was saved (${r.savedId}).` : ''}`);
      } else if (action === 'list' || !action) {
        const list = await listSlots();
        if (args.has('--json')) console.log(JSON.stringify(list, null, 2));
        else if (!list.length) console.log('No slots yet. Take one with: codein-tidy slot take --branch=<name>');
        else for (const p of list) { console.log(p.main); for (const s of p.slots) console.log(`  ${s.state.padEnd(7)} ${(s.branch ?? '').padEnd(36)} ${s.holder ?? ''}  ${s.path}`); }
      } else { console.error('Usage: codein-tidy slot take --branch=NAME [--base=REF] [--holder=NAME] | slot release [--path=PATH] | slot list'); process.exitCode = 2; }
    } catch (error) { console.error(String(error.message ?? error)); process.exitCode = error.code === 'OVER_BUDGET' ? 3 : 1; }
    return;
  }
  if (!COMMANDS.includes(command) || (older && !(options.olderThanDays >= 1)) || (['prepare', 'save'].includes(command) && !options.project)
      || (command === 'restore' && !positional[1])) {
    console.error('Usage: codein-tidy [report | work [--all] [--notice] | save --project=PATH [--yes] | saved | restore ID [--to=PATH] | review | prepare --project=PATH [--yes] | clean [--yes]] [--deep] [--caches] [--project[=PATH]] [--history] [--worktrees] [--older-than=DAYS]');
    process.exitCode = 2; return;
  }
  if (command === 'save') {
    if (!args.has('--yes')) {
      const p = await savePlan(options.project);
      const out = { folder: p.top, branch: p.branch, uncommittedChanges: p.work, leftovers: p.leftovers, commitsOnNoBranch: p.unreferenced,
        localFilesToKeep: p.keep.map((f) => f.rel), blocked: p.blocked };
      if (args.has('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
      console.log(`${p.top}${p.branch ? ` (branch ${p.branch})` : ' (no branch)'}`);
      console.log(`  ${p.work} uncommitted change(s)${p.leftovers ? `, ${p.leftovers} agent leftover(s)` : ''}${p.unreferenced ? ', commits on no branch' : ''}.`);
      console.log(`  Local files git ignores, to keep: ${p.keep.length ? p.keep.map((f) => f.rel).slice(0, 8).join(', ') : 'none'}.`);
      console.log(p.blocked ? `  Cannot save: ${p.blocked}.` : '\nThis was a plan. Run again with --yes to save. The folder is never changed.');
      return;
    }
    const result = await saveFolder(options.project);
    if (args.has('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
    if (!result.saved) { console.log(`${result.top}: not saved: ${result.reason}.`); return; }
    console.log(`Saved ${result.path} as ${result.id}.\n  Snapshot: ${result.ref}\n  Bundle: ${result.bundle ?? 'not written'}\n  Local files kept: ${result.kept ? `${result.kept.files} in ${result.kept.dir}` : 'none'}\n  Restore: ${result.restore}`);
    return;
  }
  if (command === 'close') {
    const idle = argv.find((a) => a.startsWith('--idle-days='));
    const idleDays = idle ? Number(idle.split('=')[1]) : 1;
    if (!(idleDays >= 0)) { console.error('--idle-days must be a number of days'); process.exitCode = 2; return; }
    const plan = await closePlan({ ...options, idleDays, all: args.has('--all') });
    if (!args.has('--yes')) {
      console.log(args.has('--json') ? JSON.stringify(plan, null, 2) : formatClose(plan));
      if (!args.has('--json') && plan.candidates.length) console.log('\nThis was a plan. Nothing was saved or removed. Run again with --yes to save the work and close them.');
      return;
    }
    const receipt = await closeFolders(plan);
    if (args.has('--json')) { console.log(JSON.stringify({ plan, receipt }, null, 2)); return; }
    console.log(`Closed ${receipt.closed.length} worktree(s), about ${size(receipt.freed)} freed. Saved work from ${receipt.saved.length} of them.`);
    for (const b of receipt.bundles) console.log(`  Saved work file: ${b}`);
    if (receipt.saved.length) console.log('  List saved work: codein-tidy saved. Put one back: codein-tidy restore <id>.');
    for (const f of receipt.failed) console.log(`  kept ${f.path}: ${f.error}`);
    return;
  }
  if (command === 'saved') {
    const list = await savedList();
    if (args.has('--json')) { console.log(JSON.stringify(list, null, 2)); return; }
    if (!list.length) { console.log('Nothing saved yet.'); return; }
    for (const r of list) console.log(`${r.id}  ${r.savedAt.slice(0, 10)}  ${r.branch ?? '(no branch)'}  ${r.work} change(s)  ${r.path}`);
    return;
  }
  if (command === 'restore') {
    const to = argv.find((a) => a.startsWith('--to='));
    const result = await restoreSaved(positional[1], to ? { to: to.slice(5) } : {});
    console.log(result.restored ? `Restored to ${result.path}${result.branch ? ` on branch ${result.branch}` : ''}; it matches what was saved.`
      : `Restored to ${result.path}, but it does not match what was saved (tree ${result.tree}, expected ${result.expected}). Check it before using it.`);
    if (!result.restored) process.exitCode = 1;
    return;
  }
  if (command === 'work') {
    if (args.has('--notice')) {
      // Runs at the start of every agent session: never fail it, never slow it past the cap, print nothing when clean.
      try {
        const projects = await Promise.race([unfinishedWork(options), new Promise((done) => setTimeout(() => done(null), 20_000).unref())]);
        const text = projects ? formatNotice(projects) : '';
        if (text) console.log(text);
      } catch {}
      return;
    }
    const projects = await unfinishedWork({ ...options, all: args.has('--all') });
    console.log(args.has('--json') ? JSON.stringify(projects, null, 2) : formatWork(projects));
    return;
  }
  if (command === 'prepare') {
    const result = await prepareWorktree(options.project, { yes: args.has('--yes') });
    if (args.has('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`${result.top}`);
    console.log(`  Agent leftovers: ${result.leftovers.length} file(s) ${result.applied ? `moved to ${result.trash ?? 'trash'}` : 'would move to trash'}.`);
    console.log(`  Agent state folders: ${result.state.length ? result.state.join(', ') : 'none'}${result.state.length ? (result.applied ? ' (now ignored locally)' : ' (would be ignored locally)') : ''}.`);
    const work = result.applied ? result.remainingWork : result.work;
    console.log(`  Real work to review and commit: ${work.length} change(s).`);
    for (const line of work.slice(0, 20)) console.log(`    ${line}`);
    if (!result.applied) console.log('\nThis was a plan. Run again with --yes to apply it. Real work is never touched.');
    return;
  }
  if (command === 'review') {
    const list = await reviewList(options);
    if (args.has('--json')) { console.log(JSON.stringify(list, null, 2)); return; }
    if (!list.length) { console.log('No worktree holds uncommitted work. Nothing to review.'); return; }
    console.log(`${list.length} worktree(s) hold work that is not committed to a branch. Nothing here is ever deleted.
`);
    for (const w of list) {
      console.log(`${w.path}`);
      console.log(`  ${w.branch ? `branch ${w.branch}` : 'no branch (detached)'}; real work: ${w.work} change(s)${w.leftovers ? `; agent leftovers: ${w.leftovers}` : ''}${w.agentState.length ? `; agent state: ${w.agentState.join(', ')}` : ''}${w.unbranched && !w.changedFiles ? '; its commits are on no branch' : ''}`);
      for (const line of w.sample.slice(0, 8)) console.log(`    ${line}`);
    }
    console.log('\nFor each one: run `codein-tidy prepare --project=<path> --yes` to move agent leftovers to trash and ignore agent');
    console.log('state, then read the real work (git status, git diff, the new files) and commit it with a clear message');
    console.log('(create a branch first if it has none). Then run clean again. Never reset, stash or delete the work.');
    return;
  }
  const plans = await scan(options);
  if (args.has('--json')) {
    // Machine-readable means only JSON on stdout: no plan notice, receipt text or footer after it.
    if (command === 'clean' && args.has('--yes')) console.log(JSON.stringify({ plans, receipt: await clean(plans) }, null, 2));
    else console.log(JSON.stringify(plans, null, 2));
    return;
  }
  console.log(formatReport(plans, { cleaning: command === 'clean' && args.has('--yes') }));
  if (command === 'clean') {
    if (!args.has('--yes')) { console.log('\nThis was a plan. Nothing was removed. Run again with --yes to remove the items above.'); return; }
    const receipt = await clean(plans);
    console.log(`\nRemoved ${receipt.removed} item(s), ${size(receipt.bytes)} freed.`);
    if (receipt.moved) console.log(`Moved ${receipt.moved} project leftover(s) (${size(receipt.movedBytes)}) to ${receipt.trash}. They are deleted after ${TRASH_DAYS} days.`);
    for (const failure of receipt.failed) console.log(`  could not remove ${failure.path}: ${failure.error}`);
  }
  console.log('\nKeep your disk free automatically: code.in cleans up after itself. https://code.in');
}

// Run only when started as this file or its npm bin, never when bundled into another program.
const invokedAs = (process.argv[1] ?? '').split(/[\\/]/).pop() ?? '';
if (/^(tidy\.mjs|codein-tidy(\.cmd|\.ps1)?)$/i.test(invokedAs)) main(process.argv.slice(2));
