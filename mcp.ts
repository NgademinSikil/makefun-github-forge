// mcp.ts — the Model Context Protocol endpoint (Streamable HTTP, modern
// 2026-07-28 era via server/discover, with the legacy initialize handshake
// as a fallback). Six tools, all acting on the same store the REST surface
// reads, so a repository or issue created over MCP reads back over /api/v3
// as the same object.

import { issueView, pullView, repoView } from './views.ts';
import type { ForgeStore } from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** Dispatch one tools/call. Returns a tool result object (never throws). */
export function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return toolError(`unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  const owner = String(args.owner ?? store.viewerLogin);
  const repoName = String(args.repo ?? args.name ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (store.getRepo(store.viewerLogin, repoNameArg)) {
        return toolError(`repository ${store.viewerLogin}/${repoNameArg} already exists`);
      }
      const repo = store.createRepo(repoNameArg, String(args.description ?? ''), args.private === true);
      return toolResult(repoView(store, repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoView(store, repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return toolResult(issueView(store, repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = String(args.state ?? 'open');
      const issues = repo.issues.filter((issue) => state === 'all' ? true : issue.state === state);
      return toolResult({ issues: issues.map((issue) => issueView(store, repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = store.createPull(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
      if (!pull) return toolError(`could not create a pull request from ${String(args.head ?? '')} into ${String(args.base ?? '')}`);
      return toolResult(pullView(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return toolError(`pull request #${number} not found`);
      if (pull.state !== 'open') return toolError(`pull request #${number} is not open`);
      const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (currentBaseTip && store.mergeConflict(repo, pull.headSha, currentBaseTip)) {
        return toolError(`pull request #${number} has merge conflicts`);
      }
      const sha = store.squashMerge(repo, pull);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedSeq = store.nextSeq();
      pull.mergeCommitSha = sha;
      pull.updatedSeq = pull.mergedSeq;
      return toolResult({ merged: true, sha, message: `Pull request #${number} merged` });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

export function toolsList(): ToolDef[] {
  return TOOLS;
}

export function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  };
}

export function initializeResult(requestedVersion: unknown): Record<string, unknown> {
  const version =
    typeof requestedVersion === 'string' && MCP_SUPPORTED_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : '2025-11-25';
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  };
}
