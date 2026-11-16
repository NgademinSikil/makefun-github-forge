// store.ts — the forge's single in-memory store. One process, no database:
// repositories, git objects, refs, issues, pull requests, labels and comments
// all live here and are shared by the REST, GraphQL, MCP and git surfaces,
// so an object created over one surface reads back identically over the others.
//
// Determinism: no wall clock and no unseeded randomness anywhere in this file.
// Every timestamp comes from a monotonic sequence over a fixed epoch, so two
// runs of the same request sequence leave identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { scenarioIdentities, type ScenarioIdentity } from './scenario.ts';

/** Fixed epoch for every timestamp the forge emits (2025-01-01T00:00:00Z). */
export const EPOCH_SEC = 1_735_689_600;

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}_${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const underscore = text.indexOf('_');
    if (underscore <= 0) return null;
    return { kind: text.slice(0, underscore), key: text.slice(underscore + 1) };
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A minimal line diff count (added/removed lines) between two texts. */
function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  // LCS over lines; contents here are small.
  const m = a.length;
  const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: n - common, deletions: m - common };
}

export class ForgeStore {
  readonly identity: ScenarioIdentity;
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private idCounter = 0;
  private seqCounter = 0;

  constructor() {
    this.identity = scenarioIdentities();
  }

  get viewerLogin(): string {
    return this.identity.viewerLogin;
  }

  /** The next deterministic sequence number (timestamps, request ids). */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  isoOf(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** A fresh globally-unique numeric id (repos, issues, pulls, comments, labels). */
  nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.identity.viewerLogin) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
    const now = this.nextSeq();
    const repo: Repo = {
      id: this.nextId(),
      name,
      owner: this.identity.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
      createdSeq: now,
      updatedSeq: now,
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // ---------------------------------------------------------------- git objects

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRefName(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRefName(repo));
  }

  /** The commit a ref peels to (tags peel to their commit), or null. */
  peelRef(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return peelToCommit(oid, this.lookup);
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge-base of two commits: the nearest common ancestor (first found). */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** Flatten a tree to path → {oid, mode}, recursively. */
  flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (!treeOid) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Rebuild a tree from a flat path map, creating intermediate trees. */
  buildTreeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return putObject(this.objects, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree of a commit, or null when the commit is unknown. */
  commitTree(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /**
   * Create a commit on `branch` of `repo` applying `changes` (path → new bytes,
   * or null to delete the path) on top of the branch's current tree. When the
   * branch does not exist it is created from the default branch's tip (or from
   * nothing when the repository is empty). Returns the new commit id.
   */
  commitOnBranch(
    repo: Repo,
    branch: string,
    changes: Map<string, Buffer | null>,
    message: string,
  ): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const baseTree = tip ? this.commitTree(tip) : null;
    const flat = this.flattenTree(baseTree);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: putObject(this.objects, 'blob', content), mode: '100644' });
    }
    const tree = this.buildTreeFromFlat(flat);
    const seq = this.nextSeq();
    const who = `${this.identity.viewerName} <${this.identity.viewerEmail}>`;
    const commitData = buildCommit({
      tree,
      parents: tip ? [tip] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
      timestamp: EPOCH_SEC + seq,
    });
    const commitOid = putObject(this.objects, 'commit', commitData);
    repo.refs.set(ref, commitOid);
    repo.updatedSeq = seq;
    return commitOid;
  }

  /** The blob id and bytes of `path` at a ref, or null. */
  fileAtRef(repo: Repo, refName: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.peelRef(repo, refName);
    if (!tip) return null;
    const tree = this.commitTree(tip);
    const flat = this.flattenTree(tree);
    const entry = flat.get(path);
    if (!entry) return null;
    const object = this.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  /** Directory listing of `path` ('' for the root) at a ref, or null when absent. */
  dirAtRef(
    repo: Repo,
    refName: string,
    path: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> | null {
    const tip = this.peelRef(repo, refName);
    if (!tip) return null;
    const tree = this.commitTree(tip);
    const flat = this.flattenTree(tree);
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
    for (const [filePath, value] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        seen.set(rest, { name: rest, path: filePath, type: 'file', oid: value.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          // The directory's tree id: find it by walking the tree.
          seen.set(dir, { name: dir, path: `${prefix}${dir}`, type: 'dir', oid: this.dirTreeOid(tree, `${prefix}${dir}`) ?? '' });
        }
      }
    }
    if (seen.size === 0) return null;
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private dirTreeOid(treeOid: string | null, path: string): string | null {
    if (!treeOid) return null;
    const segments = path.split('/');
    let current: string | null = treeOid;
    for (const segment of segments) {
      if (!current) return null;
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  /** Commits reachable from a ref, newest first (DFS preorder, parents in order). */
  commitsFromRef(repo: Repo, refName: string): string[] {
    const tip = this.peelRef(repo, refName);
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** Diff two trees: paths changed from `baseTree` to `headTree`. */
  diffTrees(
    baseTree: string | null,
    headTree: string | null,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const [path, value] of head) {
      const old = base.get(path);
      if (!old) out.push({ path, status: 'added', oldOid: null, newOid: value.oid });
      else if (old.oid !== value.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: value.oid });
    }
    for (const [path, value] of base) {
      if (!head.has(path)) out.push({ path, status: 'removed', oldOid: value.oid, newOid: null });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : 1));
    return out;
  }

  pullFilesFor(pull: Pull): PullFile[] {
    return pull.files;
  }

  /** Compute the changed files of a pull request (merge-base tree vs head tree). */
  computePullFiles(repo: Repo, headSha: string, baseSha: string): PullFile[] {
    const base = this.mergeBase(headSha, baseSha);
    const baseTree = base ? this.commitTree(base) : null;
    const headTree = this.commitTree(headSha);
    const files: PullFile[] = [];
    for (const change of this.diffTrees(baseTree, headTree)) {
      const oldText = change.oldOid ? this.blobText(change.oldOid) : '';
      const newText = change.newOid ? this.blobText(change.newOid) : '';
      if (change.status === 'added') {
        const additions = countLines(newText);
        files.push({ filename: change.path, status: 'added', additions, deletions: 0 });
      } else if (change.status === 'removed') {
        files.push({ filename: change.path, status: 'removed', additions: 0, deletions: countLines(oldText) });
      } else {
        const counts = diffLineCounts(oldText, newText);
        files.push({ filename: change.path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
      }
    }
    return files;
  }

  blobText(oid: string): string {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /**
   * Three-way merge check: does merging `headSha` into `baseSha` conflict?
   * A path conflicts when both sides changed it away from the merge-base and
   * the two results differ.
   */
  mergeConflict(repo: Repo, headSha: string, baseSha: string): boolean {
    const base = this.mergeBase(headSha, baseSha);
    if (!base) return false;
    const baseTree = this.commitTree(base);
    const headTree = this.commitTree(headSha);
    const baseTipTree = this.commitTree(baseSha);
    const baseFlat = this.flattenTree(baseTree);
    const headFlat = this.flattenTree(headTree);
    const tipFlat = this.flattenTree(baseTipTree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      const t = tipFlat.get(path)?.oid ?? null;
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) return true;
    }
    return false;
  }

  /** The merged tree of a three-way merge (head wins where only it changed). */
  mergedTree(repo: Repo, headSha: string, baseSha: string): string {
    const base = this.mergeBase(headSha, baseSha);
    const baseTree = base ? this.commitTree(base) : null;
    const headTree = this.commitTree(headSha);
    const baseTipTree = this.commitTree(baseSha);
    const baseFlat = this.flattenTree(baseTree);
    const headFlat = this.flattenTree(headTree);
    const tipFlat = this.flattenTree(baseTipTree);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = tipFlat.get(path);
      if (h && (!b || h.oid !== b.oid) && (!t || t.oid === b?.oid)) {
        merged.set(path, h); // only head changed
      } else if (t && (!b || t.oid !== b.oid) && (!h || h.oid === b?.oid)) {
        merged.set(path, t); // only base changed
      } else if (h && t && h.oid === t.oid) {
        merged.set(path, h); // both changed to the same thing
      } else if (h && !t && !b) {
        merged.set(path, h); // head added, base did not touch
      } else if (t && !h && !b) {
        merged.set(path, t); // base added, head did not touch
      } else if (h && !t && b && b.oid === h.oid) {
        // head unchanged, base deleted → deleted
      } else if (t && !h && b && b.oid === t.oid) {
        // base unchanged, head deleted → deleted
      } else if (h) {
        merged.set(path, h);
      } else if (t) {
        merged.set(path, t);
      }
    }
    return this.buildTreeFromFlat(merged);
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit. */
  squashMerge(repo: Repo, pull: Pull): string {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) throw new Error('base branch has no tip');
    const tree = this.mergedTree(repo, pull.headSha, baseTip);
    const seq = this.nextSeq();
    const who = `${this.identity.viewerName} <${this.identity.viewerEmail}>`;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree,
      parents: [baseTip],
      message,
      author: who,
      committer: who,
      timestamp: EPOCH_SEC + seq,
    });
    const commitOid = putObject(this.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    repo.updatedSeq = seq;
    return commitOid;
  }

  // ---------------------------------------------------------------- issues & pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      user: this.identity.viewerLogin,
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.peelRef(repo, `refs/heads/${headRef}`);
    const baseSha = this.peelRef(repo, `refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    const seq = this.nextSeq();
    const pull: Pull = {
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      files: [],
      user: this.identity.viewerLogin,
      createdSeq: seq,
      updatedSeq: seq,
    };
    pull.files = this.computePullFiles(repo, headSha, baseSha);
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Objects reachable from refs, for the git surfaces. */
  reachableFrom(refs: Iterable<string>): Set<string> {
    return collectReachable(refs, this.lookup, { allowMissing: true });
  }

  /** Is `oid` a commit object the store holds? */
  isCommit(oid: string): boolean {
    const object = this.objects.get(oid);
    return object !== undefined && object.type === 'commit';
  }

  /** The type of an object id, for tag peeling in advertisements. */
  objectType(oid: string): GitObjectType | undefined {
    return this.objects.get(oid)?.type;
  }
}
