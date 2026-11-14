// mcp.ts — Model Context Protocol endpoint at /mcp (JSON-RPC 2.0 Streamable HTTP, single JSON
// bodies, no SSE stream needed: the suite's client accepts a plain JSON answer).
//
// Two protocol eras, one endpoint: the modern 2026-07-28 revision answers `server/discover`
// (supportedVersions + capabilities + serverInfo in one result, no handshake, no session), and
// the legacy 2025-11-25 handshake answers `initialize` (echoing the offered revision) plus
// `notifications/initialized`. Every tool runs against the same in-memory Store the REST surface
// uses, so an object created over MCP is the object REST reads back. Tool failures are
// `isError: true` results; unknown tools/methods and missing required arguments are JSON-RPC
// errors (-32601/-32602); a body that is not JSON is HTTP 400 with -32700. Auth (401 without a
// bearer token) is enforced by the app layer before this handler runs.

import type { Store } from './store.ts';
import {
  createIssue,
  createPull,
  issueJson,
  mergePull,
  needRepo,
  pullJson,
  repoJson,
  type RestReply,
} from './rest.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'] as const;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login; the repository is created for the authenticated user' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/** Run one tool by name against the store; returns a tools/call result object. */
function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) {
    throw { code: -32602, message: `Unknown tool: ${name}` };
  }
  const missing = def.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    throw { code: -32602, message: `Invalid params: missing required argument(s): ${missing.join(', ')}` };
  }
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  switch (name) {
    case 'create_repo': {
      const repo = asString(args.name)!;
      if (store.getRepo(store.viewerLogin, repo)) return toolError(`Repository ${store.viewerLogin}/${repo} already exists`);
      const created = store.createRepo(
        store.viewerLogin,
        repo,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
        'main',
      );
      return toolResult({
        id: created.id,
        name: created.name,
        full_name: `${created.owner}/${created.name}`,
        owner: { login: created.owner },
        private: created.isPrivate,
        description: created.description,
        default_branch: created.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = needRepo(store, owner ?? '', repoName ?? '');
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = needRepo(store, owner ?? '', repoName ?? '');
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const reply = createIssue(store, repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '' });
      if (reply.status !== 201) return toolError(`Could not create issue: ${JSON.stringify(reply.body)}`);
      return toolResult(reply.body);
    }
    case 'list_issues': {
      const repo = needRepo(store, owner ?? '', repoName ?? '');
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult({ issues: issues.map((issue) => issueJson(store, repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = needRepo(store, owner ?? '', repoName ?? '');
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const reply = createPull(store, repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head,
        base: args.base,
      });
      if (reply.status !== 201) return toolError(`Could not create pull request: ${JSON.stringify(reply.body)}`);
      return toolResult(reply.body);
    }
    case 'merge_pull_request': {
      const repo = needRepo(store, owner ?? '', repoName ?? '');
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      const reply = mergePull(store, repo, pull, { merge_method: 'squash' });
      if (reply.status !== 200) return toolError(`Could not merge pull request: ${JSON.stringify(reply.body)}`);
      return toolResult({ merged: true, number: pull.number, state: pull.state, sha: pull.mergeCommitSha, ...pullJson(store, repo, pull) });
    }
    default:
      throw { code: -32602, message: `Unknown tool: ${name}` };
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** One JSON-RPC request object (a notification has no id). */
function handleRequest(store: Store, request: Record<string, unknown>): { status: number; body: unknown } | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = request.id === undefined || request.id === null;
  const id = request.id ?? null;
  const params = asRecord(request.params) ?? {};
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A standalone GitHub-compatible git forge. Tools: create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request.',
        }),
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = asRecord(params.arguments) ?? {};
      try {
        const result = runTool(store, name, args);
        return { status: 200, body: rpcResult(id, result) };
      } catch (err) {
        if (err !== null && typeof err === 'object' && 'code' in (err as Record<string, unknown>)) {
          const typed = err as { code: number; message: string };
          return { status: 200, body: rpcError(id, typed.code, typed.message) };
        }
        return { status: 200, body: rpcError(id, -32603, err instanceof Error ? err.message : String(err)) };
      }
    }
    default:
      if (isNotification) return { status: 202, body: '' };
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/**
 * Handle one POST /mcp exchange. `raw` is the request body bytes; a body that is not JSON is
 * HTTP 400 with JSON-RPC -32700. A JSON-RPC batch (an array) answers an array, in order.
 */
export function handleMcp(store: Store, raw: Buffer): RestReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const out: unknown[] = [];
    for (const entry of parsed) {
      const record = asRecord(entry);
      if (!record) {
        out.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      const answer = handleRequest(store, record);
      if (answer !== null) out.push(answer.body);
    }
    return { status: 200, body: out };
  }
  const record = asRecord(parsed);
  if (!record || typeof record.method !== 'string') {
    return { status: 200, body: { jsonrpc: '2.0', id: record?.id ?? null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const answer = handleRequest(store, record);
  if (answer === null) return { status: 202, body: '' };
  return answer;
}
