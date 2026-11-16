// app.ts — the forge's HTTP server: GitHub REST v3 under /api/v3, GraphQL
// v4 at /api/graphql, MCP at /mcp, git smart HTTP at /{owner}/{repo}.git,
// and GET /healthz. One process, standard library only.
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id.
// Errors carry a JSON body with a string message. Requests without the
// bearer token (MAKEFUN_SHOP_TOKEN when set) are 401; a repository under any
// owner but the token owner's login is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hashObject, isObjectId, parseCommit } from './gitcore.ts';
import { handleReceivePack, handleUploadPack, infoRefsResponse, listRefs } from './gitserver.ts';
import { executeGraphQL } from './graphql.ts';
import { callTool, discoverResult, initializeResult, toolsList } from './mcp.ts';
import { ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import { commentView, issueView, labelView, pullFileView, pullView, repoView, userView } from './views.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface AppOptions {
  /** The bearer token API calls must carry; '' accepts any token (local dev). */
  token?: string;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface ParsedBody {
  ok: boolean;
  value: Record<string, unknown>;
}

function parseJsonBody(raw: Buffer): ParsedBody {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, value: {} };
  } catch {
    return { ok: false, value: {} };
  }
}

export function createApp(options: AppOptions = {}): Server {
  const store = new ForgeStore();
  const expectedToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    requestSeq += 1;
    const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
    const headers: Record<string, string> = {
      'x-github-request-id': `req-${requestSeq.toString(16).padStart(8, '0')}`,
      ...extra,
    };
    if (status !== 204) {
      headers['content-type'] = JSON_TYPE;
      headers['content-length'] = String(Buffer.byteLength(text));
    }
    res.writeHead(status, headers);
    res.end(text);
  }

  function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { message });
  }

  function authorized(req: IncomingMessage): boolean {
    if (expectedToken === '') return true;
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${expectedToken}`;
  }

  function baseUrlOf(req: IncomingMessage): string {
    const host = req.headers.host ?? '127.0.0.1';
    return `http://${host}`;
  }

  function pageParams(search: URLSearchParams): { perPage: number; page: number } {
    const perPageRaw = Number(search.get('per_page') ?? '30');
    const pageRaw = Number(search.get('page') ?? '1');
    const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
    return { perPage, page };
  }

  function paginate<T>(items: readonly T[], search: URLSearchParams): { page: T[]; link: string | null; total: number } {
    const { perPage, page } = pageParams(search);
    const total = items.length;
    const start = (page - 1) * perPage;
    return { page: items.slice(start, start + perPage), link: null, total };
  }

  function linkHeader(req: IncomingMessage, pathname: string, search: URLSearchParams, total: number): string | null {
    const { perPage, page } = pageParams(search);
    const pages = Math.max(1, Math.ceil(total / perPage));
    if (pages <= 1) return null;
    const origin = baseUrlOf(req);
    const build = (p: number): string => {
      const params = new URLSearchParams(search);
      params.set('per_page', String(perPage));
      params.set('page', String(p));
      return `<${origin}${pathname}?${params.toString()}>`;
    };
    const parts: string[] = [];
    if (page < pages) parts.push(`${build(page + 1)}; rel="next"`);
    if (page > 1) parts.push(`${build(page - 1)}; rel="prev"`);
    parts.push(`${build(1)}; rel="first"`);
    parts.push(`${build(pages)}; rel="last"`);
    return parts.join(', ');
  }

  function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
    const repo = store.getRepo(owner, name);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    return repo;
  }

  function issueShape(res: ServerResponse, repo: Repo, issue: Issue): void {
    sendJson(res, 200, issueView(store, repo, issue));
  }

  function authorOf(commitOid: string): { name: string; email: string; date: string } {
    const object = store.getObject(commitOid);
    if (!object || object.type !== 'commit') return { name: '', email: '', date: '' };
    const commit = parseCommit(object.data);
    const line = commit.author;
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: '' };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  }

  function commitView(repo: Repo, oid: string): Record<string, unknown> {
    const object = store.getObject(oid);
    const commit = object && object.type === 'commit' ? parseCommit(object.data) : null;
    const author = authorOf(oid);
    return {
      sha: oid,
      node_id: '',
      commit: {
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: author.name, email: author.email, date: author.date },
        message: (commit?.message ?? '').replace(/\n$/, ''),
        tree: { sha: commit?.tree ?? '', url: '' },
        url: '',
        comment_count: 0,
      },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
      html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
      author: userView(store, store.viewerLogin),
      committer: userView(store, store.viewerLogin),
      parents: (commit?.parents ?? []).map((parent) => ({ sha: parent, url: '', html_url: '' })),
    };
  }

  /** Resolve a ref parameter (branch name, full ref, or commit sha) to a ref name or oid. */
  function resolveRef(repo: Repo, ref: string): { refName: string; tip: string } | null {
    if (isObjectId(ref) && store.getObject(ref)) return { refName: ref, tip: ref };
    const candidates = [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
    for (const candidate of candidates) {
      const tip = store.peelRef(repo, candidate);
      if (tip) return { refName: candidate, tip };
    }
    return null;
  }

  async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], search: URLSearchParams, body: Buffer): Promise<void> {
    const method = req.method ?? 'GET';
    // segments[0] === 'api', segments[1] === 'v3'
    const rest = segments.slice(2);

    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }

    const parsed = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? parseJsonBody(body) : { ok: true, value: {} as Record<string, unknown> };
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    const input = parsed.value;

    // GET /api/v3/ — the API root.
    if (rest.length === 0) {
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // GET /api/v3/meta
    if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
      return;
    }

    // GET /api/v3/user
    if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
      sendJson(res, 200, userView(store, store.viewerLogin));
      return;
    }

    // /api/v3/user/repos
    if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.viewerRepos();
        const { page, total } = paginate(repos, search);
        const link = linkHeader(req, '/api/v3/user/repos', search, total);
        sendJson(res, 200, page.map((repo) => repoView(store, repo)), link ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const name = String(input.name ?? '');
        if (name === '') {
          sendError(res, 422, 'name is required');
          return;
        }
        if (store.getRepo(store.viewerLogin, name)) {
          sendError(res, 422, 'Repository already exists');
          return;
        }
        const repo = store.createRepo(name, String(input.description ?? ''), input.private === true, String(input.default_branch ?? 'main'));
        sendJson(res, 201, repoView(store, repo));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // /api/v3/repos/{owner}/{repo}[...]
    if (rest.length >= 3 && rest[0] === 'repos') {
      const owner = rest[1] as string;
      const name = rest[2] as string;
      const tail = rest.slice(3);

      // GET/PATCH/DELETE /repos/{owner}/{repo}
      if (tail.length === 0) {
        if (method === 'GET') {
          const repo = repoOr404(res, owner, name);
          if (repo) sendJson(res, 200, repoView(store, repo));
          return;
        }
        if (method === 'PATCH') {
          const repo = repoOr404(res, owner, name);
          if (!repo) return;
          if (typeof input.description === 'string') repo.description = input.description;
          repo.updatedSeq = store.nextSeq();
          sendJson(res, 200, repoView(store, repo));
          return;
        }
        if (method === 'DELETE') {
          const repo = repoOr404(res, owner, name);
          if (!repo) return;
          store.deleteRepo(repo);
          sendJson(res, 204, null);
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      const repo = repoOr404(res, owner, name);
      if (!repo) return;

      // branches
      if (tail[0] === 'branches') {
        if (tail.length === 1 && method === 'GET') {
          const branches = [...repo.refs.keys()]
            .filter((ref) => ref.startsWith('refs/heads/'))
            .map((ref) => ref.slice('refs/heads/'.length))
            .sort();
          sendJson(res, 200, branches.map((branch) => ({
            name: branch,
            commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '', url: '' },
            protected: false,
          })));
          return;
        }
        if (tail.length === 2 && method === 'GET') {
          const branch = tail[1] as string;
          const sha = repo.refs.get(`refs/heads/${branch}`);
          if (!sha) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // commits
      if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
        const refParam = search.get('sha') ?? repo.defaultBranch;
        const resolved = resolveRef(repo, refParam);
        if (!resolved) {
          sendJson(res, 200, []);
          return;
        }
        const commits = store.commitsFromRef(repo, resolved.refName);
        const { page } = paginate(commits, search);
        sendJson(res, 200, page.map((oid) => commitView(repo, oid)));
        return;
      }

      // git/refs
      if (tail[0] === 'git' && tail[1] === 'refs') {
        if (method === 'POST' && tail.length === 2) {
          const ref = String(input.ref ?? '');
          const sha = String(input.sha ?? '');
          if (!ref.startsWith('refs/') || !isObjectId(sha) || !store.getObject(sha)) {
            sendError(res, 422, 'Invalid ref or sha');
            return;
          }
          if (repo.refs.has(ref)) {
            sendError(res, 422, 'Reference already exists');
            return;
          }
          repo.refs.set(ref, sha);
          const type = store.objectType(sha) ?? 'commit';
          sendJson(res, 201, {
            ref,
            node_id: '',
            url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
            object: { sha, type, url: '' },
          });
          return;
        }
        if (method === 'GET') {
          if (tail.length === 2) {
            const refs = listRefs(store, repo);
            sendJson(res, 200, refs.map((ref) => ({
              ref: ref.name,
              node_id: '',
              url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.name.replace(/^refs\//, '')}`,
              object: { sha: ref.oid, type: store.objectType(ref.oid) ?? 'commit', url: '' },
            })));
            return;
          }
          const refName = `refs/${tail.slice(2).join('/')}`;
          const sha = repo.refs.get(refName);
          if (!sha) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, {
            ref: refName,
            node_id: '',
            url: `/api/v3/repos/${owner}/${name}/git/refs/${refName.replace(/^refs\//, '')}`,
            object: { sha, type: store.objectType(sha) ?? 'commit', url: '' },
          });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // contents
      if (tail[0] === 'contents') {
        const filePath = tail.slice(1).join('/');
        if (method === 'GET') {
          const refParam = search.get('ref') ?? repo.defaultBranch;
          const resolved = resolveRef(repo, refParam);
          if (!resolved) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (filePath === '') {
            const entries = store.dirAtRef(repo, resolved.refName, '') ?? [];
            sendJson(res, 200, entries.map((entry) => contentEntryView(store, repo, entry)));
            return;
          }
          const file = store.fileAtRef(repo, resolved.refName, filePath);
          if (file) {
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              size: file.data.length,
              name: filePath.split('/').pop(),
              path: filePath,
              content: file.data.toString('base64'),
              sha: file.oid,
              url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
              git_url: '',
              html_url: '',
              download_url: '',
            });
            return;
          }
          const dir = store.dirAtRef(repo, resolved.refName, filePath);
          if (dir) {
            sendJson(res, 200, dir.map((entry) => contentEntryView(store, repo, entry)));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'PUT') {
          if (filePath === '') {
            sendError(res, 422, 'Invalid path');
            return;
          }
          const message = String(input.message ?? 'update');
          const contentB64 = String(input.content ?? '');
          let content: Buffer;
          try {
            content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
          } catch {
            sendError(res, 422, 'Invalid base64 content');
            return;
          }
          const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
          const refName = `refs/heads/${branch}`;
          const existing = store.fileAtRef(repo, refName, filePath);
          if (existing && typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
            sendError(res, 409, 'sha does not match the current file');
            return;
          }
          // A branch that does not exist yet is created from the default tip.
          if (!repo.refs.has(refName) && branch !== repo.defaultBranch) {
            const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (defaultTip) repo.refs.set(refName, defaultTip);
          }
          const changes = new Map<string, Buffer | null>();
          changes.set(filePath, content);
          const commitSha = store.commitOnBranch(repo, branch, changes, message);
          const blobSha = hashObject('blob', content);
          sendJson(res, existing ? 200 : 201, {
            content: {
              name: filePath.split('/').pop(),
              path: filePath,
              sha: blobSha,
              size: content.length,
              url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
              git_url: '',
              html_url: '',
              download_url: '',
              type: 'file',
              encoding: 'base64',
            },
            commit: {
              sha: commitSha,
              message,
              author: { name: store.identity.viewerName, email: store.identity.viewerEmail, date: store.isoOf(store.nextSeq()) },
              committer: { name: store.identity.viewerName, email: store.identity.viewerEmail, date: '' },
              url: '',
              html_url: '',
            },
          });
          return;
        }
        if (method === 'DELETE') {
          if (filePath === '') {
            sendError(res, 422, 'Invalid path');
            return;
          }
          const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
          const refName = `refs/heads/${branch}`;
          const existing = store.fileAtRef(repo, refName, filePath);
          if (!existing) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
            sendError(res, 409, 'sha does not match the current file');
            return;
          }
          const message = String(input.message ?? 'delete');
          const changes = new Map<string, Buffer | null>();
          changes.set(filePath, null);
          const commitSha = store.commitOnBranch(repo, branch, changes, message);
          sendJson(res, 200, { commit: { sha: commitSha, message } });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // labels
      if (tail[0] === 'labels') {
        if (method === 'GET' && tail.length === 1) {
          sendJson(res, 200, repo.labels.map((label) => labelView(store, repo, label.name)));
          return;
        }
        if (method === 'POST' && tail.length === 1) {
          const labelName = String(input.name ?? '');
          if (labelName === '') {
            sendError(res, 422, 'name is required');
            return;
          }
          let label = repo.labels.find((candidate) => candidate.name === labelName);
          if (!label) {
            label = {
              id: store.nextId(),
              name: labelName,
              color: typeof input.color === 'string' ? input.color : 'ededed',
              description: typeof input.description === 'string' ? input.description : '',
            };
            repo.labels.push(label);
          }
          sendJson(res, 201, labelView(store, repo, labelName));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // issues
      if (tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'GET') {
            let issues = [...repo.issues];
            const state = search.get('state') ?? 'open';
            if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
            const sort = search.get('sort') ?? 'created';
            const direction = search.get('direction') ?? 'desc';
            if (sort === 'created') {
              issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
            }
            const { page } = paginate(issues, search);
            sendJson(res, 200, page.map((issue) => issueView(store, repo, issue)));
            return;
          }
          if (method === 'POST') {
            const title = String(input.title ?? '');
            const bodyText = String(input.body ?? '');
            const labels = Array.isArray(input.labels) ? input.labels.map((label) => String(label)) : [];
            for (const label of labels) {
              if (!repo.labels.some((candidate) => candidate.name === label)) {
                sendError(res, 422, `label ${label} does not exist`);
                return;
              }
            }
            const issue = store.createIssue(repo, title, bodyText, labels);
            sendJson(res, 201, issueView(store, repo, issue));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        const number = Number(tail[1]);
        if (!Number.isInteger(number)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const issue = store.findIssue(repo, number);
        if (tail.length === 2) {
          if (!issue) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            issueShape(res, repo, issue);
            return;
          }
          if (method === 'PATCH') {
            if (typeof input.title === 'string') issue.title = input.title;
            if (typeof input.body === 'string') issue.body = input.body;
            if (input.state === 'open' || input.state === 'closed') {
              issue.state = input.state;
              issue.closedSeq = input.state === 'closed' ? store.nextSeq() : null;
            }
            if (Array.isArray(input.labels)) {
              const labels = input.labels.map((label) => String(label));
              for (const label of labels) {
                if (!repo.labels.some((candidate) => candidate.name === label)) {
                  sendError(res, 422, `label ${label} does not exist`);
                  return;
                }
              }
              issue.labels = labels;
            }
            issue.updatedSeq = store.nextSeq();
            sendJson(res, 200, issueView(store, repo, issue));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (!issue) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => commentView(store, repo, issue, comment)));
            return;
          }
          if (method === 'POST') {
            const comment = {
              id: store.nextId(),
              body: String(input.body ?? ''),
              user: store.viewerLogin,
              createdSeq: store.nextSeq(),
            };
            issue.comments.push(comment);
            sendJson(res, 201, commentView(store, repo, issue, comment));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // pulls
      if (tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'GET') {
            let pulls = [...repo.pulls];
            const state = search.get('state') ?? 'open';
            if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
            const { page } = paginate(pulls, search);
            sendJson(res, 200, page.map((pull) => pullView(store, repo, pull)));
            return;
          }
          if (method === 'POST') {
            const title = String(input.title ?? '');
            const bodyText = String(input.body ?? '');
            let head = String(input.head ?? '');
            let base = String(input.base ?? repo.defaultBranch);
            if (head.includes(':')) head = head.split(':').pop() as string;
            if (base.includes(':')) base = base.split(':').pop() as string;
            if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
              sendError(res, 422, 'head or base branch does not exist');
              return;
            }
            const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
            if (existing) {
              sendError(res, 422, 'A pull request already exists for this head and base');
              return;
            }
            const pull = store.createPull(repo, title, bodyText, head, base);
            if (!pull) {
              sendError(res, 422, 'could not create the pull request');
              return;
            }
            sendJson(res, 201, pullView(store, repo, pull));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        const number = Number(tail[1]);
        if (!Number.isInteger(number)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const pull = store.findPull(repo, number);
        if (tail.length === 2) {
          if (!pull) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, pullView(store, repo, pull));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          if (!pull) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, pull.files.map((file) => pullFileView(file)));
          return;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (!pull) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (pull.state !== 'open') {
            sendError(res, 405, 'Pull request is already merged or closed');
            return;
          }
          // The conflict check runs against the base branch's CURRENT tip,
          // not the tip recorded when the pull request was opened: another
          // pull request may have merged onto the base since then.
          const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          if (!currentBaseTip) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (store.mergeConflict(repo, pull.headSha, currentBaseTip)) {
            sendError(res, 405, 'Merge conflict');
            return;
          }
          const sha = store.squashMerge(repo, pull);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedSeq = store.nextSeq();
          pull.mergeCommitSha = sha;
          pull.updatedSeq = pull.mergedSeq;
          sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  function contentEntryView(
    storeArg: ForgeStore,
    repo: Repo,
    entry: { name: string; path: string; type: 'file' | 'dir'; oid: string },
  ): Record<string, unknown> {
    const size = entry.type === 'file' ? (storeArg.getObject(entry.oid)?.data.length ?? 0) : 0;
    return {
      type: entry.type,
      size,
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
      git_url: '',
      html_url: '',
      download_url: entry.type === 'file' ? '' : null,
    };
  }

  async function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const runOne = (operation: unknown): Record<string, unknown> => {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
        return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
      }
      const record = operation as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
        ? (record.variables as Record<string, unknown>)
        : {};
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      const result = executeGraphQL(store, query, variables, operationName);
      const out: Record<string, unknown> = { data: result.data };
      if (result.errors.length > 0) out.errors = result.errors;
      return out;
    };
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map(runOne));
      return;
    }
    sendJson(res, 200, runOne(parsed));
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    const text = body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      res.writeHead(400, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    const id = record !== null && (typeof record.id === 'string' || typeof record.id === 'number') ? record.id : null;
    const rpcError = (code: number, message: string): void => {
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    };
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } }));
      return;
    }
    if (record === null || typeof record.method !== 'string') {
      rpcError(-32600, 'Invalid Request');
      return;
    }
    const params = record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {};
    const rpcResult = (result: unknown): void => {
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    switch (record.method) {
      case 'server/discover':
        rpcResult(discoverResult());
        return;
      case 'initialize':
        rpcResult(initializeResult(params.protocolVersion));
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        res.writeHead(202);
        res.end();
        return;
      case 'tools/list':
        rpcResult({ tools: toolsList() });
        return;
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
        if (name === '') {
          rpcError(-32602, 'Invalid params: tool name is required');
          return;
        }
        if (!toolsList().some((tool) => tool.name === name)) {
          rpcError(-32602, `Unknown tool: ${name}`);
          return;
        }
        rpcResult(callTool(store, name, args));
        return;
      }
      case 'ping':
        rpcResult({});
        return;
      default:
        rpcError(-32601, `Method not found: ${record.method}`);
        return;
    }
  }

  async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], search: URLSearchParams, body: Buffer): Promise<void> {
    const method = req.method ?? 'GET';
    // segments: [owner, '<repo>.git', ...]
    const repoSegment = segments[1] ?? '';
    if (!repoSegment.endsWith('.git')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const owner = segments[0] as string;
    const repoName = repoSegment.slice(0, -4);
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const tail = segments.slice(2);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const answer = infoRefsResponse(store, repo, service, wantsV2);
      res.writeHead(answer.status, { 'content-type': answer.contentType });
      res.end(answer.body);
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const answer = handleUploadPack(store, repo, body, wantsV2);
      res.writeHead(answer.status, { 'content-type': answer.contentType });
      res.end(answer.body);
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const answer = handleReceivePack(store, repo, body);
      res.writeHead(answer.status, { 'content-type': answer.contentType });
      res.end(answer.body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const segments = pathSegments(pathname);
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest(req, res, segments, url.searchParams, body);
          return;
        }
        if (pathname === '/api/graphql') {
          await handleGraphQL(req, res, body);
          return;
        }
        if (pathname === '/mcp') {
          await handleMcp(req, res, body);
          return;
        }
        if (segments.length >= 2 && segments[1]?.endsWith('.git')) {
          await handleGit(req, res, segments, url.searchParams, body);
          return;
        }
        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try {
            sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            // The socket is already gone.
          }
        } else {
          try {
            res.end();
          } catch {
            // Ignore.
          }
        }
      }
    })();
  });

  return server;
}
