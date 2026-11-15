// rest.ts — GitHub REST v3: repos, branches, commits, contents, labels, issues, pulls.
//
// Status codes and shapes follow the kit's checks-rest.ts contract exactly. Every reply is
// JSON; errors are {message: string}. Owner mismatches are 404, never 403; a missing token is
// handled by the app layer (401) before these handlers run.

import { noteGitMutation } from './gitwire.ts';
import {
  buildCommit,
  diffLines,
  filesToTree,
  hashObject,
  isObjectId,
  isoOf,
  parseCommit,
  parseTree,
  putObject,
  SCENARIO_EPOCH_SEC,
  treeToFiles,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse ?per_page=&page= with GitHub's defaults (30 per page, page 1). */
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** Slice a page and build a GitHub Link header (next only when there is one). */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(baseUrl);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: pageItems as T[], link };
}

function linkHeader(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(store: Store, login: string): Json {
  const user = store.user(login);
  if (!user) return { login, id: 0, type: 'User' };
  return { login: user.login, id: user.id, name: user.name, email: user.email, type: user.type, avatar_url: '' };
}

function repoJson(store: Store, repo: Repo): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store, repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: store.stamp(repo.createdSeq),
    updated_at: store.stamp(repo.createdSeq),
  };
}

function labelJson(label: { name: string; color: string; description: string }): Json {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Json {
  return {
    id: 10000 + repo.id * 1000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(store, issue.user),
    comments: issue.comments.length,
    created_at: store.stamp(issue.createdSeq),
    updated_at: store.stamp(issue.createdSeq),
  };
}

/**
 * One issue's GET body as bytes, memoized on the issue object itself. The body is a pure
 * function of the issue's fields, so it is rebuilt only when the issue changes; patchIssue
 * and createComment clear it through forgetIssueBody below.
 */
const issueBodies = new WeakMap<Issue, Buffer>();

export function issueBody(store: Store, repo: Repo, issue: Issue): Buffer {
  const hit = issueBodies.get(issue);
  if (hit !== undefined) return hit;
  const made = Buffer.from(`${JSON.stringify(issueJson(store, repo, issue))}\n`, 'utf8');
  issueBodies.set(issue, made);
  return made;
}

function forgetIssueBody(issue: Issue): void {
  issueBodies.delete(issue);
}

function pullJson(store: Store, repo: Repo, pull: Pull): Json {
  return {
    id: 20000 + repo.id * 1000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(store, pull.user),
    created_at: store.stamp(pull.createdSeq),
    updated_at: store.stamp(pull.createdSeq),
  };
}

function commentJson(store: Store, comment: { id: number; body: string; user: string; createdSeq: number }): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(store, comment.user),
    created_at: store.stamp(comment.createdSeq),
    updated_at: store.stamp(comment.createdSeq),
  };
}

// ---------------------------------------------------------------------------------------------
// git helpers for the REST surface
// ---------------------------------------------------------------------------------------------

/** Resolve a ref name, a full ref or a commit oid to a commit oid (or null). */
function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (isObjectId(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

/** Walk commits from a tip, newest first, following parents in order, deduplicated. */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    let commit;
    try {
      commit = parseCommit(object.data);
    } catch {
      continue;
    }
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** Is `ancestor` reachable from `tip`? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return walkCommits(repo, tip).includes(ancestor);
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: isoOf(SCENARIO_EPOCH_SEC) };
  return { name: match[1]!, email: match[2]!, date: isoOf(parseInt(match[3]!, 10)) };
}

function commitJson(repo: Repo, oid: string): Json | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  let commit;
  try {
    commit = parseCommit(object.data);
  } catch {
    return null;
  }
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
    },
    author: { login: '', id: 0, type: 'User' },
    committer: { login: '', id: 0, type: 'User' },
  };
}

/**
 * Create a server commit on `branch` from a file map (path -> bytes). The branch tip advances.
 * The message is stored verbatim; the author is the repo owner's identity.
 */
function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: ReadonlyMap<string, Buffer>,
  message: string,
): { commitSha: string; treeSha: string } {
  const treeSha = filesToTree(repo.objects, files);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip !== undefined ? [tip] : [];
  const identity = store.identityFor(repo.owner);
  const commit = buildCommit({
    tree: treeSha,
    parents,
    message,
    author: identity,
    committer: identity,
    timestamp: store.nextCommitTimestamp(repo),
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  noteGitMutation(repo);
  return { commitSha, treeSha };
}

/** The file map of a branch tip (empty when the branch is unborn). */
function branchFiles(repo: Repo, branch: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return files;
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return files;
  let commit;
  try {
    commit = parseCommit(object.data);
  } catch {
    return files;
  }
  const flat = treeToFiles((oid) => repo.objects.get(oid), commit.tree);
  for (const [path, entry] of flat) {
    const blob = repo.objects.get(entry.oid);
    if (blob && blob.type === 'blob') files.set(path, blob.data);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` are the decoded path segments after /api/v3.
 * `baseUrl` is the absolute URL of this request (for pagination Link headers).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestReply {
  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }

  // GET /api/v3/user — the token's user.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(userJson(store, store.viewerLogin));
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos (list).
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createUserRepo(store, body);
    if (method === 'GET') return listUserRepos(store, query, baseUrl);
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    return handleRepo(store, method, owner, name, rest, query, body, baseUrl);
  }

  return err(404, 'Not Found');
}

function createUserRepo(store: Store, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed: name is required');
  const name = asString(input.name);
  if (name === null || name === '' || name.includes('/') || name.length > 100) {
    return err(422, 'Validation Failed: name is required');
  }
  const owner = store.viewerLogin;
  if (store.getRepo(owner, name)) return err(422, 'Repository already exists');
  const repo = store.createRepo(
    owner,
    name,
    asBool(input.private, false),
    asString(input.description) ?? '',
    asString(input.default_branch) ?? 'main',
  );
  return ok(repoJson(store, repo), 201);
}

function listUserRepos(store: Store, query: URLSearchParams, baseUrl: string): RestReply {
  const repos = store.reposOf(store.viewerLogin).map((repo) => repoJson(store, repo));
  const { page, link } = paginate(repos, query, baseUrl);
  return ok(page, 200, linkHeader(link));
}

function needRepo(store: Store, owner: string, name: string): Repo | null {
  // A repo belongs to the login the token names; any other owner is a 404, never a 403.
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(owner, name) ?? null;
}

function handleRepo(
  store: Store,
  method: string,
  owner: string,
  name: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestReply {
  const repo = needRepo(store, owner, name);

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (!repo) return err(404, 'Not Found');
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      const input = asObject(body);
      if (input) {
        const description = asString(input.description);
        if (description !== null) repo.description = description;
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      }
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  if (!repo) return err(404, 'Not Found');
  const head = rest[0]!;

  if (head === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'POST') return createRef(store, repo, body);
    return err(404, 'Not Found');
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch} (and any other single ref).
  if (head === 'git' && rest[1] === 'refs' && rest.length >= 3) {
    if (method !== 'GET') return err(404, 'Not Found');
    const ref = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return err(404, 'Not Found');
    return ok({ ref, object: { sha, type: 'commit' } });
  }

  if (head === 'branches' && rest.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    const branches: Json[] = [];
    for (const refName of [...repo.refs.keys()].sort()) {
      if (!refName.startsWith('refs/heads/')) continue;
      branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: repo.refs.get(refName)! }, protected: false });
    }
    return ok(branches);
  }

  // GET /repos/{o}/{r}/branches/{branch}
  if (head === 'branches' && rest.length === 2) {
    if (method !== 'GET') return err(404, 'Not Found');
    const sha = repo.refs.get(`refs/heads/${rest[1]}`);
    if (sha === undefined) return err(404, 'Not Found');
    return ok({ name: rest[1], commit: { sha }, protected: false });
  }

  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    const tip = resolveRef(repo, query.get('sha'));
    if (tip === null) return ok([]);
    const commits: Json[] = [];
    for (const oid of walkCommits(repo, tip)) {
      const entry = commitJson(repo, oid);
      if (entry) commits.push(entry);
    }
    return ok(commits);
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') return putContents(store, repo, path, body);
    if (method === 'GET') return getContents(store, repo, path, query.get('ref'));
    if (method === 'DELETE') return deleteContents(store, repo, path, body);
    return err(404, 'Not Found');
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') return createLabel(repo, body);
    if (rest.length === 1 && method === 'GET') {
      return ok([...repo.labels.values()].map((label) => labelJson(label)));
    }
    return err(404, 'Not Found');
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(store, repo, body);
      if (method === 'GET') return listIssues(store, repo, query, baseUrl);
      return err(404, 'Not Found');
    }
    const number = parseInt(rest[1]!, 10);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(issueJson(store, repo, issue));
      if (method === 'PATCH') return patchIssue(store, repo, issue, body);
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'POST') return createComment(store, repo, issue, body);
      if (method === 'GET') return ok(issue.comments.map((c) => commentJson(store, c)));
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(store, repo, body);
      if (method === 'GET') return listPulls(store, repo, query, baseUrl);
      return err(404, 'Not Found');
    }
    const number = parseInt(rest[1]!, 10);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return ok(pullJson(store, repo, pull));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return ok(pullFiles(repo, pull));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pull) return err(404, 'Not Found');
      if (method === 'PUT') return mergePull(store, repo, pull, body);
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

function createRef(store: Store, repo: Repo, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed');
  const ref = asString(input.ref);
  const sha = asString(input.sha);
  if (ref === null || !ref.startsWith('refs/') || sha === null || !isObjectId(sha)) {
    return err(422, 'Validation Failed: ref and sha are required');
  }
  if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  noteGitMutation(repo);
  return ok({ ref, object: { sha } }, 201);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function putContents(store: Store, repo: Repo, path: string, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed');
  const message = asString(input.message);
  const contentB64 = asString(input.content);
  if (message === null || contentB64 === null) return err(422, 'Validation Failed: message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(400, 'content is not valid base64');
  }
  const branch = asString(input.branch) ?? repo.defaultBranch;
  const sha = asString(input.sha);
  const files = branchFiles(repo, branch);
  const existing = files.get(path);
  const newBlobOid = hashObject('blob', content);
  if (sha !== null) {
    if (!existing) return err(422, 'Validation Failed: no file to update at this path');
    const currentOid = hashObject('blob', existing);
    if (sha.toLowerCase() !== currentOid.toLowerCase()) return err(409, 'Conflict: the file has changed since the given sha');
  } else if (existing) {
    return err(422, 'Validation Failed: the file already exists; send its sha to update it');
  }
  files.set(path, content);
  const { commitSha } = commitFiles(store, repo, branch, files, message);
  const created = sha === null;
  return ok(
    {
      content: { name: path.split('/').pop() ?? path, path, sha: newBlobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha },
    },
    created ? 201 : 200,
  );
}

function getContents(store: Store, repo: Repo, path: string, ref: string | null): RestReply {
  const tip = resolveRef(repo, ref);
  if (tip === null) return err(404, 'Not Found');
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return err(404, 'Not Found');
  let commit;
  try {
    commit = parseCommit(object.data);
  } catch {
    return err(404, 'Not Found');
  }
  if (path === '') {
    // The repository root: a directory listing.
    const entries = dirListing(repo, commit.tree, '');
    return ok(entries);
  }
  const segments = path.split('/');
  let treeOid = commit.tree;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return err(404, 'Not Found');
    let entries;
    try {
      entries = parseTree(treeObject.data);
    } catch {
      return err(404, 'Not Found');
    }
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return err(404, 'Not Found');
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return ok(dirListing(repo, entry.oid, path));
      treeOid = entry.oid;
      continue;
    }
    if (!last) return err(404, 'Not Found');
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return err(404, 'Not Found');
    return ok({
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.oid,
      size: blob.data.length,
      name: segment,
      path,
    });
  }
  return err(404, 'Not Found');
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Json[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  let entries;
  try {
    entries = parseTree(object.data);
  } catch {
    return [];
  }
  return entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
  }));
}

function deleteContents(store: Store, repo: Repo, path: string, body: unknown): RestReply {
  const input = asObject(body);
  const message = (input && asString(input.message)) ?? 'Delete file';
  const sha = input ? asString(input.sha) : null;
  const branch = (input && asString(input.branch)) ?? repo.defaultBranch;
  const files = branchFiles(repo, branch);
  const existing = files.get(path);
  if (!existing) return err(404, 'Not Found');
  if (sha !== null && sha.toLowerCase() !== hashObject('blob', existing).toLowerCase()) {
    return err(409, 'Conflict: the file has changed since the given sha');
  }
  files.delete(path);
  const { commitSha } = commitFiles(store, repo, branch, files, message);
  return ok({ commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function createLabel(repo: Repo, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed');
  const name = asString(input.name);
  if (name === null || name === '') return err(422, 'Validation Failed: name is required');
  const color = asString(input.color) ?? 'ededed';
  const existing = repo.labels.get(name);
  if (existing) return ok(labelJson(existing), 201);
  const label = { name, color, description: asString(input.description) ?? '' };
  repo.labels.set(name, label);
  return ok(labelJson(label), 201);
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function createIssue(store: Store, repo: Repo, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed');
  const title = asString(input.title);
  if (title === null || title === '') return err(422, 'Validation Failed: title is required');
  const labels = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return err(422, `Validation Failed: label ${label} does not exist`);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    title,
    body: asString(input.body) ?? '',
    state: 'open',
    labels,
    comments: [],
    user: store.viewerLogin,
    createdSeq: store.nextSeq(),
  };
  repo.issues.set(number, issue);
  return ok(issueJson(store, repo, issue), 201);
}

function listIssues(store: Store, repo: Repo, query: URLSearchParams, baseUrl: string): RestReply {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const { page, link } = paginate(issues.map((issue) => issueJson(store, repo, issue)), query, baseUrl);
  return ok(page, 200, linkHeader(link));
}

function patchIssue(store: Store, repo: Repo, issue: Issue, body: unknown): RestReply {
  const input = asObject(body);
  if (input) {
    const state = asString(input.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = asString(input.title);
    if (title !== null) issue.title = title;
    const text = asString(input.body);
    if (text !== null) issue.body = text;
  }
  forgetIssueBody(issue);
  return ok(issueJson(store, repo, issue));
}

function createComment(store: Store, repo: Repo, issue: Issue, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed');
  const text = asString(input.body);
  if (text === null) return err(422, 'Validation Failed: body is required');
  const comment = { id: repo.nextCommentId, body: text, user: store.viewerLogin, createdSeq: store.nextSeq() };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  forgetIssueBody(issue);
  return ok(commentJson(store, comment), 201);
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function createPull(store: Store, repo: Repo, body: unknown): RestReply {
  const input = asObject(body);
  if (!input) return err(422, 'Validation Failed');
  const headRef = asString(input.head);
  const baseRef = asString(input.base);
  const title = asString(input.title);
  if (headRef === null || baseRef === null || title === null) return err(422, 'Validation Failed: head, base and title are required');
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return err(422, 'Validation Failed: head or base branch does not exist');
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title,
    body: asString(input.body) ?? '',
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: store.viewerLogin,
    createdSeq: store.nextSeq(),
  };
  repo.pulls.set(number, pull);
  return ok(pullJson(store, repo, pull), 201);
}

function listPulls(store: Store, repo: Repo, query: URLSearchParams, baseUrl: string): RestReply {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, link } = paginate(pulls.map((pull) => pullJson(store, repo, pull)), query, baseUrl);
  return ok(page, 200, linkHeader(link));
}

/** The file changes between the pull's base and its head (three-way: base tip at creation). */
function pullFiles(repo: Repo, pull: Pull): Json[] {
  const baseTip = repo.objects.get(pull.baseSha);
  const headTip = repo.objects.get(pull.headSha);
  if (!baseTip || !headTip || baseTip.type !== 'commit' || headTip.type !== 'commit') return [];
  let baseCommit;
  let headCommit;
  try {
    baseCommit = parseCommit(baseTip.data);
    headCommit = parseCommit(headTip.data);
  } catch {
    return [];
  }
  const baseFiles = treeToFiles((oid) => repo.objects.get(oid), baseCommit.tree);
  const headFiles = treeToFiles((oid) => repo.objects.get(oid), headCommit.tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Json[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && head && base.oid === head.oid) continue;
    const baseText = base ? (repo.objects.get(base.oid)?.data.toString('utf8') ?? '') : '';
    const headText = head ? (repo.objects.get(head.oid)?.data.toString('utf8') ?? '') : '';
    let status: string;
    let additions: number;
    let deletions: number;
    if (!base && head) {
      status = 'added';
      additions = headText === '' ? 0 : headText.split('\n').length;
      deletions = 0;
    } else if (base && !head) {
      status = 'removed';
      additions = 0;
      deletions = baseText === '' ? 0 : baseText.split('\n').length;
    } else {
      status = 'modified';
      const diff = diffLines(baseText, headText);
      additions = diff.additions;
      deletions = diff.deletions;
    }
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: head?.oid ?? base?.oid ?? '',
    });
  }
  return out;
}

function mergePull(store: Store, repo: Repo, pull: Pull, body: unknown): RestReply {
  const input = asObject(body);
  const method = input ? asString(input.merge_method) : null;
  if (method !== null && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return err(422, 'Validation Failed: unknown merge_method');
  }
  if (pull.merged || pull.state !== 'open') return err(405, 'Pull request is already merged or closed');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return err(404, 'Not Found');
  // The head is already in the base: nothing to merge.
  if (isAncestor(repo, pull.headSha, baseTip)) return err(405, 'Pull request is already merged');
  const baseTipObject = repo.objects.get(baseTip);
  const baseObject = repo.objects.get(pull.baseSha);
  const headObject = repo.objects.get(pull.headSha);
  if (!baseTipObject || !baseObject || !headObject) return err(404, 'Not Found');
  let baseTipCommit;
  let baseCommit;
  let headCommit;
  try {
    baseTipCommit = parseCommit(baseTipObject.data);
    baseCommit = parseCommit(baseObject.data);
    headCommit = parseCommit(headObject.data);
  } catch {
    return err(404, 'Not Found');
  }
  const currentFiles = treeToFiles((oid) => repo.objects.get(oid), baseTipCommit.tree);
  const baseFiles = treeToFiles((oid) => repo.objects.get(oid), baseCommit.tree);
  const headFiles = treeToFiles((oid) => repo.objects.get(oid), headCommit.tree);
  // Conflict: a changed file whose current content differs from both the base and the head.
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && head && base.oid === head.oid) continue;
    const current = currentFiles.get(path);
    const currentOid = current?.oid;
    const baseOid = base?.oid;
    const headOid = head?.oid;
    if (currentOid !== baseOid && currentOid !== headOid) return err(405, 'Merge conflict');
  }
  // Squash: one commit on the base branch with the base tree plus the pull's changed files.
  const merged = new Map<string, Buffer>();
  for (const [path, entry] of currentFiles) {
    const blob = repo.objects.get(entry.oid);
    if (blob && blob.type === 'blob') merged.set(path, blob.data);
  }
  for (const path of paths) {
    const head = headFiles.get(path);
    if (!head) {
      merged.delete(path);
      continue;
    }
    const blob = repo.objects.get(head.oid);
    if (blob && blob.type === 'blob') merged.set(path, blob.data);
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const treeSha = filesToTree(repo.objects, merged);
  const identity = store.identityFor(repo.owner);
  const commit = buildCommit({
    tree: treeSha,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: store.nextCommitTimestamp(repo),
  });
  const mergeSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.stamp(store.nextSeq());
  pull.mergeCommitSha = mergeSha;
  return ok({ merged: true, sha: mergeSha, message });
}

// ---------------------------------------------------------------------------------------------
// Re-exports for the GraphQL and MCP surfaces, which mutate the same store through the same
// code paths as REST (the suite's rest-parity checks read the same objects back over REST).
// ---------------------------------------------------------------------------------------------

export {
  commentJson,
  createComment,
  createIssue,
  createPull,
  createUserRepo,
  issueJson,
  mergePull,
  needRepo,
  patchIssue,
  pullFiles,
  pullJson,
  repoJson,
};
