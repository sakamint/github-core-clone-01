// graphql.ts — a small GraphQL v4 executor for the documents gh and github-mcp-server send.
//
// No GraphQL library: a hand-rolled tokenizer + recursive-descent parser for the query language
// subset those documents use (operations, aliases, arguments with variables/literals/enum lists/
// inline input objects, inline fragments, named fragment spreads, variable definitions with
// defaults), and a resolver over the same in-memory Store the REST surface uses, so a mutation's
// result is the object the REST view reads back. Unknown fields are GraphQL-level errors (HTTP
// 200 with an `errors` array), never HTTP 400s; an unknown repository reads `data.repository =
// null` with no errors. Operation batching (a JSON array of operation documents) answers an
// array of per-operation bodies in the same order.

import {
  parseCommit,
  treeToFiles,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  type User,
} from './store.ts';
import {
  createComment,
  createIssue,
  createPull,
  mergePull,
  patchIssue,
  pullFiles,
  type RestReply,
} from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Syntax Error: unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n) {
        const c = source[j]!;
        if (c === '"') break;
        if (c === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        out += c;
        j += 1;
      }
      if (j >= n) throw new Error('Syntax Error: unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface VarDef {
  name: string;
  defaultValue?: ValueNode;
}

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: VarDef[];
  selections: SelectionNode[];
}

interface FragmentDefNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Syntax Error: expected "${value}" but got ${token.value || token.kind}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Syntax Error: expected a name but got ${token.value || token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`Syntax Error: expected "${value}" but got "${token.value}"`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as OperationNode['operation'];
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Syntax Error: unexpected ${token.value || token.kind} at the document level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return defs;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.next();
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'fragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.next();
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('Syntax Error: a variable is not allowed in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Syntax Error: unexpected value ${token.value || token.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Global ids: opaque, stable, never the plain database id or number.
// ---------------------------------------------------------------------------------------------

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const i = text.indexOf(':');
  if (i < 1) return null;
  return { kind: text.slice(0, i), key: text.slice(i + 1) };
}

// ---------------------------------------------------------------------------------------------
// Introspection: the static schema surface gh feature-detects.
// ---------------------------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
      'createdAt', 'updatedAt', 'url', 'homepageUrl', 'visibility', 'forkCount', 'stargazerCount',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt', 'assignees'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
      'url', 'isDraft', 'additions', 'deletions', 'changedFiles',
    ],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'REPOSITORY_OWNER', 'REPOSITORY_TEMPLATE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------------------------------------
// Resolved values: a GraphQL object is a plain record with __typename and its store record.
// ---------------------------------------------------------------------------------------------

type GqlObject = { __typename: string; __record?: unknown; [key: string]: unknown };

interface GqlContext {
  store: Store;
}

function userValue(store: Store, login: string): GqlObject {
  const user = store.user(login);
  return { __typename: 'User', __record: user ?? { login }, login, name: user?.name ?? login, email: user?.email ?? '' };
}

function repoValue(repo: Repo): GqlObject {
  return { __typename: 'Repository', __record: repo };
}

function issueValue(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __record: { repo, issue } };
}

function pullValue(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', __record: { repo, pull } };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The mergeability of a pull request, by the same conflict rule the REST merge uses. */
function mergeableOf(repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const baseObject = repo.objects.get(pull.baseSha);
  const headObject = repo.objects.get(pull.headSha);
  const baseTipObject = baseTip === undefined ? undefined : repo.objects.get(baseTip);
  if (!baseObject || !headObject || !baseTipObject) return 'UNKNOWN';
  let baseTipCommit;
  let baseCommit;
  let headCommit;
  try {
    baseTipCommit = parseCommit(baseTipObject.data);
    baseCommit = parseCommit(baseObject.data);
    headCommit = parseCommit(headObject.data);
  } catch {
    return 'UNKNOWN';
  }
  const currentFiles = treeToFiles((oid) => repo.objects.get(oid), baseTipCommit.tree);
  const baseFiles = treeToFiles((oid) => repo.objects.get(oid), baseCommit.tree);
  const headFiles = treeToFiles((oid) => repo.objects.get(oid), headCommit.tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && head && base.oid === head.oid) continue;
    const currentOid = currentFiles.get(path)?.oid;
    if (currentOid !== base?.oid && currentOid !== head?.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------------------------------------
// The issues connection: states filter, orderBy, cursor pagination.
// ---------------------------------------------------------------------------------------------

function cursorForIssue(issue: Issue): string {
  return Buffer.from(`issue:${issue.number}`, 'utf8').toString('base64url');
}

function issueNumberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^issue:(\d+)$/.exec(text);
  return match ? parseInt(match[1]!, 10) : null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states : null;
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  if (field === 'COMMENTS') issues.sort((a, b) => a.comments.length - b.comments.length);
  else issues.sort((a, b) => a.createdSeq - b.createdSeq);
  if (direction === 'DESC') issues.reverse();
  const afterNumber = issueNumberFromCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    start = index < 0 ? 0 : index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : 30;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? cursorForIssue(page[page.length - 1]!) : null;
  return {
    __typename: 'IssueConnection',
    __record: { repo, page, hasNextPage, endCursor, total: issues.length },
  };
}

// ---------------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------------

type Resolver = (ctx: GqlContext, parent: GqlObject, args: Record<string, unknown>) => unknown;

class GqlError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function repoFromGlobalId(ctx: GqlContext, id: unknown): Repo | null {
  const decoded = decodeGlobalId(typeof id === 'string' ? id : '');
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const [owner, name] = decoded.key.split('/');
  if (owner === undefined || name === undefined) return null;
  if (owner !== ctx.store.viewerLogin) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function issueFromGlobalId(ctx: GqlContext, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(typeof id === 'string' ? id : '');
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
  if (!match) return null;
  const [, owner, name, number] = match;
  if (owner !== ctx.store.viewerLogin) return null;
  const repo = ctx.store.getRepo(owner!, name!);
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(number!, 10));
  return issue ? { repo, issue } : null;
}

function pullFromGlobalId(ctx: GqlContext, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(typeof id === 'string' ? id : '');
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
  if (!match) return null;
  const [, owner, name, number] = match;
  if (owner !== ctx.store.viewerLogin) return null;
  const repo = ctx.store.getRepo(owner!, name!);
  if (!repo) return null;
  const pull = repo.pulls.get(parseInt(number!, 10));
  return pull ? { repo, pull } : null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => userValue(ctx.store, ctx.store.viewerLogin),
    repository: (ctx, _parent, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (owner !== ctx.store.viewerLogin) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoValue(repo) : null;
    },
    node: (ctx, _parent, args) => {
      const decoded = decodeGlobalId(typeof args.id === 'string' ? args.id : '');
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoFromGlobalId(ctx, args.id);
        return repo ? repoValue(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const found = issueFromGlobalId(ctx, args.id);
        return found ? issueValue(found.repo, found.issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullFromGlobalId(ctx, args.id);
        return found ? pullValue(found.repo, found.pull) : null;
      }
      return null;
    },
    __type: (_ctx, _parent, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const def = TYPE_DEFS[name];
      if (!def) return null;
      return { __typename: '__Type', __record: { name, def } };
    },
    __schema: () => ({ __typename: '__Schema', __record: { types: Object.keys(TYPE_DEFS) } }),
  },
  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = asRecord(args.input) ?? {};
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      if (!repo) throw new GqlError('createIssue: the repositoryId names no repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const reply = createIssue(ctx.store, repo, { title, body });
      if (reply.status !== 201) throw new GqlError(`createIssue failed: ${JSON.stringify(reply.body)}`);
      const number = (asRecord(reply.body)?.number ?? 0) as number;
      const issue = repo.issues.get(number);
      if (!issue) throw new GqlError('createIssue: the issue was not stored');
      return { __typename: 'CreateIssuePayload', __record: { repo, issue } };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = asRecord(args.input) ?? {};
      const found = issueFromGlobalId(ctx, input.issueId);
      if (!found) throw new GqlError('closeIssue: the issueId names no issue');
      patchIssue(ctx.store, found.repo, found.issue, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', __record: found };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = asRecord(args.input) ?? {};
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      if (!repo) throw new GqlError('createPullRequest: the repositoryId names no repository');
      const reply = createPull(ctx.store, repo, {
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      if (reply.status !== 201) throw new GqlError(`createPullRequest failed: ${JSON.stringify(reply.body)}`);
      const number = (asRecord(reply.body)?.number ?? 0) as number;
      const pull = repo.pulls.get(number);
      if (!pull) throw new GqlError('createPullRequest: the pull request was not stored');
      return { __typename: 'CreatePullRequestPayload', __record: { repo, pull } };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = asRecord(args.input) ?? {};
      const found = pullFromGlobalId(ctx, input.pullRequestId);
      if (!found) throw new GqlError('mergePullRequest: the pullRequestId names no pull request');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const reply = mergePull(ctx.store, found.repo, found.pull, { merge_method: method });
      if (reply.status !== 200) throw new GqlError(`mergePullRequest failed: ${JSON.stringify(reply.body)}`);
      return { __typename: 'MergePullRequestPayload', __record: found };
    },
    addComment: (ctx, _parent, args) => {
      const input = asRecord(args.input) ?? {};
      const found = issueFromGlobalId(ctx, input.subjectId);
      if (!found) throw new GqlError('addComment: the subjectId names no issue');
      const body = typeof input.body === 'string' ? input.body : '';
      const reply = createComment(ctx.store, found.repo, found.issue, { body });
      if (reply.status !== 201) throw new GqlError(`addComment failed: ${JSON.stringify(reply.body)}`);
      const commentId = (asRecord(reply.body)?.id ?? 0) as number;
      return {
        __typename: 'AddCommentPayload',
        __record: {
          repo: found.repo,
          issue: found.issue,
          commentId,
          body,
        },
      };
    },
  },
  User: {
    id: (ctx, parent) => globalId('User', String(parent.login ?? '')),
    login: (_ctx, parent) => parent.login ?? '',
    name: (_ctx, parent) => parent.name ?? '',
    email: (_ctx, parent) => parent.email ?? '',
  },
  Repository: {
    id: (_ctx, parent) => {
      const repo = parent.__record as Repo;
      return globalId('Repository', `${repo.owner}/${repo.name}`);
    },
    databaseId: (_ctx, parent) => (parent.__record as Repo).id,
    name: (_ctx, parent) => (parent.__record as Repo).name,
    nameWithOwner: (_ctx, parent) => {
      const repo = parent.__record as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (ctx, parent) => userValue(ctx.store, (parent.__record as Repo).owner),
    defaultBranchRef: (_ctx, parent) => {
      const repo = parent.__record as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, parent) => (parent.__record as Repo).description,
    isPrivate: (_ctx, parent) => (parent.__record as Repo).isPrivate,
    issue: (_ctx, parent, args) => {
      const repo = parent.__record as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? issueValue(repo, issue) : null;
    },
    issues: (_ctx, parent, args) => issuesConnection(parent.__record as Repo, args),
    pullRequests: (_ctx, parent, args) => {
      const repo = parent.__record as Repo;
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : 30;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
      return { __typename: 'PullRequestConnection', __record: { repo, pulls } };
    },
    pullRequest: (_ctx, parent, args) => {
      const repo = parent.__record as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? pullValue(repo, pull) : null;
    },
  },
  Issue: {
    id: (_ctx, parent) => {
      const { repo, issue } = parent.__record as { repo: Repo; issue: Issue };
      return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
    },
    number: (_ctx, parent) => (parent.__record as { issue: Issue }).issue.number,
    title: (_ctx, parent) => (parent.__record as { issue: Issue }).issue.title,
    state: (_ctx, parent) => issueState((parent.__record as { issue: Issue }).issue),
    body: (_ctx, parent) => (parent.__record as { issue: Issue }).issue.body,
    author: (ctx, parent) => userValue(ctx.store, (parent.__record as { issue: Issue }).issue.user),
    createdAt: (ctx, parent) => ctx.store.stamp((parent.__record as { issue: Issue }).issue.createdSeq),
  },
  IssueConnection: {
    nodes: (_ctx, parent) => {
      const { repo, page } = parent.__record as { repo: Repo; page: Issue[] };
      return page.map((issue) => issueValue(repo, issue));
    },
    pageInfo: (_ctx, parent) => {
      const { hasNextPage, endCursor } = parent.__record as { hasNextPage: boolean; endCursor: string | null };
      return { __typename: 'PageInfo', hasNextPage, endCursor };
    },
    totalCount: (_ctx, parent) => (parent.__record as { total: number }).total,
  },
  PageInfo: {
    hasNextPage: (_ctx, parent) => parent.hasNextPage ?? false,
    endCursor: (_ctx, parent) => parent.endCursor ?? null,
  },
  PullRequest: {
    id: (_ctx, parent) => {
      const { repo, pull } = parent.__record as { repo: Repo; pull: Pull };
      return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
    },
    number: (_ctx, parent) => (parent.__record as { pull: Pull }).pull.number,
    title: (_ctx, parent) => (parent.__record as { pull: Pull }).pull.title,
    body: (_ctx, parent) => (parent.__record as { pull: Pull }).pull.body,
    state: (_ctx, parent) => pullState((parent.__record as { pull: Pull }).pull),
    merged: (_ctx, parent) => (parent.__record as { pull: Pull }).pull.merged,
    headRefName: (_ctx, parent) => (parent.__record as { pull: Pull }).pull.headRef,
    baseRefName: (_ctx, parent) => (parent.__record as { pull: Pull }).pull.baseRef,
    mergeable: (_ctx, parent) => {
      const { repo, pull } = parent.__record as { repo: Repo; pull: Pull };
      return mergeableOf(repo, pull);
    },
    files: (_ctx, parent, args) => {
      const { repo, pull } = parent.__record as { repo: Repo; pull: Pull };
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : 30;
      const files = pullFiles(repo, pull).slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        __record: { files: files.map((f) => ({ __typename: 'PullRequestChangedFile', path: String((f as Record<string, unknown>).filename ?? '') })) },
      };
    },
    author: (ctx, parent) => userValue(ctx.store, (parent.__record as { pull: Pull }).pull.user),
    createdAt: (ctx, parent) => ctx.store.stamp((parent.__record as { pull: Pull }).pull.createdSeq),
  },
  PullRequestConnection: {
    nodes: (_ctx, parent) => {
      const { repo, pulls } = parent.__record as { repo: Repo; pulls: Pull[] };
      return pulls.map((pull) => pullValue(repo, pull));
    },
    totalCount: (_ctx, parent) => (parent.__record as { pulls: Pull[] }).pulls.length,
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, parent) => (parent.__record as { files: GqlObject[] }).files,
  },
  PullRequestChangedFile: {
    path: (_ctx, parent) => parent.path ?? '',
  },
  Ref: {
    name: (_ctx, parent) => parent.name ?? '',
  },
  __Type: {
    name: (_ctx, parent) => (parent.__record as { name: string }).name,
    kind: (_ctx, parent) => (parent.__record as { def: TypeDef }).def.kind,
    fields: (_ctx, parent) => {
      const def = (parent.__record as { def: TypeDef }).def;
      return (def.fields ?? []).map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (_ctx, parent) => {
      const def = (parent.__record as { def: TypeDef }).def;
      return (def.enumValues ?? []).map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (_ctx, parent) => parent.name ?? '',
  },
  __EnumValue: {
    name: (_ctx, parent) => parent.name ?? '',
  },
  __Schema: {
    types: (_ctx, parent) => (parent.__record as { types: string[] }).types.map((name) => ({ __typename: '__Type', __record: { name, def: TYPE_DEFS[name]! } })),
  },
  CreateIssuePayload: {
    issue: (_ctx, parent) => {
      const { repo, issue } = parent.__record as { repo: Repo; issue: Issue };
      return issueValue(repo, issue);
    },
  },
  CloseIssuePayload: {
    issue: (_ctx, parent) => {
      const { repo, issue } = parent.__record as { repo: Repo; issue: Issue };
      return issueValue(repo, issue);
    },
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, parent) => {
      const { repo, pull } = parent.__record as { repo: Repo; pull: Pull };
      return pullValue(repo, pull);
    },
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, parent) => {
      const { repo, pull } = parent.__record as { repo: Repo; pull: Pull };
      return pullValue(repo, pull);
    },
  },
  AddCommentPayload: {
    commentEdge: (_ctx, parent) => {
      const { repo, issue, commentId, body } = parent.__record as { repo: Repo; issue: Issue; commentId: number; body: string };
      return {
        __typename: 'IssueCommentEdge',
        node: {
          __typename: 'IssueComment',
          id: globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${commentId}`),
          body,
        },
      };
    },
  },
  IssueCommentEdge: {
    node: (_ctx, parent) => parent.node as GqlObject,
  },
  IssueComment: {
    id: (_ctx, parent) => parent.id ?? '',
    body: (_ctx, parent) => parent.body ?? '',
  },
};

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

interface GqlErrorEntry {
  message: string;
  path?: Array<string | number>;
}

function valueFrom(node: ValueNode, variables: Record<string, unknown>, varDefs: Map<string, VarDef>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (Object.prototype.hasOwnProperty.call(variables, node.name)) return variables[node.name];
      const def = varDefs.get(node.name);
      if (def?.defaultValue !== undefined) return valueFrom(def.defaultValue, variables, varDefs);
      return null;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueFrom(v, variables, varDefs));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFrom(field.value, variables, varDefs);
      return out;
    }
  }
}

function executeSelectionSet(
  ctx: GqlContext,
  parent: GqlObject,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  varDefs: Map<string, VarDef>,
  doc: DocumentNode,
  errors: GqlErrorEntry[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parent.__typename) continue;
      const sub = executeSelectionSet(ctx, parent, selection.selections, variables, varDefs, doc, errors, path);
      Object.assign(out, sub);
      continue;
    }
    if (selection.kind === 'spread') {
      const def = doc.fragments.get(selection.name);
      if (!def) {
        errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (def.typeCondition !== parent.__typename) continue;
      const sub = executeSelectionSet(ctx, parent, def.selections, variables, varDefs, doc, errors, path);
      Object.assign(out, sub);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueFrom(arg.value, variables, varDefs);
    const fieldPath = [...path, responseKey];
    const resolver = RESOLVERS[parent.__typename]?.[selection.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.__typename}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(ctx, parent, args);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    if (!selection.selections) {
      out[responseKey] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item, index) =>
        item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
          ? executeSelectionSet(ctx, item as GqlObject, selection.selections!, variables, varDefs, doc, errors, [...fieldPath, index])
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[responseKey] = executeSelectionSet(ctx, value as GqlObject, selection.selections, variables, varDefs, doc, errors, fieldPath);
      continue;
    }
    out[responseKey] = null;
  }
  return out;
}

function executeOne(
  store: Store,
  operation: { query: string; variables?: Record<string, unknown>; operationName?: string },
): { data: Record<string, unknown> | null; errors?: GqlErrorEntry[] } {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const variables = (operation.variables ?? {}) as Record<string, unknown>;
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Syntax Error: the document holds no operation' }] };
  }
  let op: OperationNode | undefined;
  if (typeof operation.operationName === 'string' && operation.operationName !== '') {
    op = doc.operations.find((o) => o.name === operation.operationName);
  } else {
    op = doc.operations[0];
  }
  if (!op) {
    return { data: null, errors: [{ message: `Unknown operation named "${operation.operationName}"` }] };
  }
  const varDefs = new Map<string, VarDef>(op.variables.map((v) => [v.name, v]));
  const root: GqlObject = { __typename: op.operation === 'mutation' ? 'Mutation' : 'Query' };
  const errors: GqlErrorEntry[] = [];
  const data = executeSelectionSet({ store }, root, op.selections, variables, varDefs, doc, errors, []);
  return errors.length > 0 ? { data, errors } : { data };
}

/** Handle one POST /api/graphql body (a single operation or a JSON array of them). */
export function handleGraphQL(store: Store, body: unknown): RestReply {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, (entry ?? {}) as { query: string; variables?: Record<string, unknown>; operationName?: string })) };
  }
  const input = asRecord(body);
  if (!input || typeof input.query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'GraphQL request must include a query string.' }] } };
  }
  return { status: 200, body: executeOne(store, input as { query: string; variables?: Record<string, unknown>; operationName?: string }) };
}
