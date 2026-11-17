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
import { promises as fs } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const DAY = 24 * 60 * 60_000;

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
  let bytes = 0, files = 0, freeable = 0;
  const names = await fs.readdir(path).catch(() => []);
  // pnpm's node_modules holds hard links into its store: removing it frees almost nothing, and walking its
  // hundreds of thousands of files is most of the time a report takes. Skip it when sampled files are shared.
  if (names.includes('.pnpm') && path.split(/[\\/]/).pop() === 'node_modules' && await pnpmLinked(join(path, '.pnpm'))) {
    return { bytes: 0, files: 0, freeable: 0, sharedModules: 1 };
  }
  for (let i = 0; i < names.length; i += 32) {
    const parts = await Promise.all(names.slice(i, i + 32).map((name) => measure(join(path, name), seen, memo, depth + 1)));
    for (const part of parts) { bytes += part.bytes; files += part.files; freeable += part.freeable; }
  }
  // Remember the upper levels, so planning never walks a folder a second time.
  if (memo && depth <= 3) memo.set(resolve(path), { bytes, files, freeable });
  return { bytes, files, freeable };
}

/** True when sampled files under a pnpm virtual store are hard links (store on the same drive), not copies. */
async function pnpmLinked(dir) {
  const samples = [];
  async function find(path, depth) {
    if (samples.length >= 5 || depth > 5) return;
    for (const name of (await fs.readdir(path).catch(() => [])).slice(0, 8)) {
      if (samples.length >= 5) return;
      const stat = await fs.lstat(join(path, name), { bigint: true }).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      // Top-level files (lock.yaml) are pnpm's own bookkeeping, never linked: sample package files only.
      if (stat.isFile()) { if (depth >= 2) samples.push(stat.nlink); }
      else if (stat.isDirectory()) await find(join(path, name), depth + 1);
    }
  }
  await find(dir, 0);
  return samples.length >= 3 && samples.every((nlink) => nlink >= 2n);
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
    for (const path of target.paths) { const m = await measure(path, seen, memo); total = { bytes: total.bytes + m.bytes, files: total.files + m.files, freeable: total.freeable + m.freeable }; }
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
  const plans = [];
  const timed = async (target) => {
    const started = Date.now();
    if (process.stderr.isTTY && !process.env.CODEIN_TIDY_PROFILE) process.stderr.write(`\x1b[2KMeasuring ${target.tool}: ${target.item}...\r`);
    const result = await plan(target, opts);
    if (process.env.CODEIN_TIDY_PROFILE) console.error(`${String(Date.now() - started).padStart(7)} ms  ${target.tool}: ${target.item}`);
    return result;
  };
  const all = [...targets(options), ...await gitWorktreeTargets(options)];
  // An agent reads this through a pipe, where the live progress line never shows: say once that work is under way.
  if (!process.stderr.isTTY && !process.env.CODEIN_TIDY_PROFILE) process.stderr.write(`codein-tidy: measuring ${all.length} places; large folders can take a minute...\n`);
  for (const target of all) plans.push(await timed(target));
  // Package caches are always reported; they are cleaned only with --caches or --deep (see plan()).
  for (const target of cacheTargets(options)) plans.push(await timed(target));
  if (process.stderr.isTTY) process.stderr.write('\x1b[2K');
  if (options.project) plans.push(...await projectPlans(options.project, opts));
  return plans;
}

export async function clean(plans, now = Date.now(), { runner = runCacheCommand } = {}) {
  const receipt = { removed: 0, bytes: 0, moved: 0, movedBytes: 0, trash: undefined, failed: [] };
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  for (const target of plans) {
    if (target.skipped) continue;
    if (target.kind === 'trash') await emptyOldTrash(target.trashDir, now);
    for (const entry of target.removable) {
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
  if (!present.length) lines.push('None of the supported tools has data on this machine.');
  return lines.join('\n').trimStart();
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
  if (!['report', 'clean', 'review', 'prepare'].includes(command) || (older && !(options.olderThanDays >= 1)) || (command === 'prepare' && !options.project)) {
    console.error('Usage: codein-tidy [report | review | prepare --project=PATH [--yes] | clean [--yes]] [--deep] [--caches] [--project[=PATH]] [--history] [--worktrees] [--older-than=DAYS]');
    process.exitCode = 2; return;
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
  if (args.has('--json')) { console.log(JSON.stringify(plans, null, 2)); }
  else console.log(formatReport(plans, { cleaning: command === 'clean' && args.has('--yes') }));
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
