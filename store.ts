// store.ts — the forge's in-memory store and git object model.
//
// Everything is deterministic: no wall clock, no Math.random. Server-created commits use
// SCENARIO_EPOCH_SEC plus a per-repo counter; created/updated timestamps use the same epoch
// plus a global sequence number, so two runs that receive the same requests in the same order
// produce byte-identical state.

import { createHash } from 'node:crypto';

export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function typeCodeOf(type: GitObjectType): number {
  return TYPE_CODE[type];
}

export function typeOfCode(code: number): GitObjectType | undefined {
  return CODE_TYPE[code];
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** Store an object in a repo's object map (idempotent) and return its id. */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  return {
    object,
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. The message is stored verbatim (no newline added). */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const timezone = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${timezone}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${timezone}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries (gitlinks
 * skipped), tag -> its target, blob -> nothing. Missing objects are skipped (the server must
 * never throw on a walk: a missing object just ends that branch).
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      let commit: CommitView;
      try {
        commit = parseCommit(object.data);
      } catch {
        continue;
      }
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      let tag: TagView;
      try {
        tag = parseTag(object.data);
      } catch {
        continue;
      }
      queue.push(tag.object);
    } else if (object.type === 'tree') {
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Every object reachable from `roots`, but a commit in `cut` is a leaf: its tree is walked and
 * its parents are not. A shallow clone's boundary commits are held without their history, so a
 * `have` naming one must not claim its ancestors.
 */
export function collectReachableCut(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  cut: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      let commit: CommitView;
      try {
        commit = parseCommit(object.data);
      } catch {
        continue;
      }
      queue.push(commit.tree);
      if (!cut.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      let tag: TagView;
      try {
        tag = parseTag(object.data);
      } catch {
        continue;
      }
      queue.push(tag.object);
    } else if (object.type === 'tree') {
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}
export function treeToFiles(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
): Map<string, { oid: string; mode: string }> {
  const files = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(object.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/**
 * Build trees bottom-up from a path -> Buffer file map, storing every blob and tree in the
 * repo's object map. Returns the root tree's oid.
 */
export function filesToTree(
  objects: Map<string, GitObject>,
  files: ReadonlyMap<string, Buffer>,
): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      let child = node.dirs.get(name);
      if (!child) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) {
      entries.push({ mode: '100644', name, oid: putObject(objects, 'blob', data) });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Line additions/deletions between two texts (LCS on lines; small files only). */
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS dynamic program, capped: scenario files are short; fall back to whole-file counts.
  if (a.length * b.length > 250_000) return { additions: b.length, deletions: a.length };
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  const lcs = prev[b.length]!;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly type: 'User' | 'Organization';
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly user: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  readonly user: string;
  readonly createdSeq: number;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly user: string;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
  commitSeq: number;
  readonly createdSeq: number;
}

/** The scenario's seeded users (wire.ts buildScenario, fixed seed). */
export const SCENARIO_USERS: readonly User[] = Object.freeze([
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid', type: 'User' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid', type: 'User' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid', type: 'User' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid', type: 'User' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid', type: 'User' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid', type: 'User' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid', type: 'User' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid', type: 'User' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid', type: 'User' },
]);

export const SCENARIO_ORG: User = {
  id: 2000,
  login: 'faint-meadow-org',
  name: 'faint meadow org',
  email: 'faint-meadow-org@example.invalid',
  type: 'Organization',
};

export const SCENARIO_LABELS: readonly string[] = Object.freeze([
  'bug',
  'enhancement',
  'documentation',
  'question',
  'good first issue',
  'help wanted',
]);

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** The whole forge: every repo, user and counter, in memory. */
export class Store {
  readonly repos = new Map<string, Repo>();
  readonly users = new Map<string, User>();
  /** The login the bearer token names. The scenario's viewer, hardcoded; every repo the token
   *  creates is owned by this login, and any other owner in a URL is a 404 for this token. */
  readonly viewerLogin = 'adaiversen';
  /** The bearer token the env handed this process (MAKEFUN_SHOP_TOKEN), when present. */
  readonly token: string | null;
  private repoSeq = 0;
  private seq = 0;

  constructor() {
    for (const user of SCENARIO_USERS) this.users.set(user.login, user);
    this.users.set(SCENARIO_ORG.login, SCENARIO_ORG);
    const token = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
    this.token = token === '' ? null : token;
  }

  get viewer(): User {
    return this.users.get(this.viewerLogin)!;
  }

  user(login: string): User | undefined {
    return this.users.get(login);
  }

  /** Monotonic sequence for creation order and deterministic timestamps. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A deterministic ISO timestamp from a sequence number. */
  stamp(seq: number): string {
    return isoOf(SCENARIO_EPOCH_SEC + seq);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Repos owned by a login, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: 5000 + this.repoSeq - 1,
      owner,
      name,
      isPrivate,
      description,
      defaultBranch,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: 0,
      createdSeq: this.nextSeq(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The identity a server-created commit carries for this owner. */
  identityFor(owner: string): string {
    const user = this.users.get(owner);
    if (user) return `${user.name} <${user.email}>`;
    return `${owner} <${owner}@example.invalid>`;
  }

  /** Next deterministic timestamp for a server-created commit in this repo. */
  nextCommitTimestamp(repo: Repo): number {
    repo.commitSeq += 1;
    return SCENARIO_EPOCH_SEC + repo.commitSeq;
  }
}
