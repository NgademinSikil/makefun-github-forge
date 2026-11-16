// graphql.ts — a small GraphQL executor for the exact documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts). It is not a
// general GraphQL server: it parses queries, mutations, aliases, variables,
// inline input objects and enums, inline fragments and __type introspection,
// and resolves them against the forge store. Unknown fields answer HTTP 200
// with an `errors` array naming the field, as GitHub does.

import { decodeGlobalId, globalId, type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          i += 2;
        } else {
          out += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableNames: string[];
  selections: SelectionNode[];
}

interface FragmentDefNode {
  kind: 'fragmentDef';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseDocument(): Array<OperationNode | FragmentDefNode> {
    const defs: Array<OperationNode | FragmentDefNode> = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        defs.push({ kind: 'operation', operation: 'query', name: null, variableNames: [], selections: this.parseSelections() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variableNames = this.parseVariableDefinitions();
        defs.push({ kind: 'operation', operation, name, variableNames, selections: this.parseSelections() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        defs.push({ kind: 'fragmentDef', name, typeCondition, selections: this.parseSelections() });
      } else {
        throw new Error('unexpected token at the start of a GraphQL definition');
      }
    }
    return defs;
  }

  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        this.expectPunct('$');
        names.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        const after = this.peek();
        if (after?.kind === 'punct' && after.value === '=') {
          this.next();
          this.parseValue();
        }
      }
    }
    return names;
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    const bang = this.peek();
    if (bang?.kind === 'punct' && bang.value === '!') this.next();
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelections() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value as string;
        return { kind: 'fragment', typeCondition: name, selections: [] };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelections() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selections: SelectionNode[] = [];
    const brace = this.peek();
    if (brace?.kind === 'punct' && brace.value === '{') selections = this.parseSelections();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface Ctx {
  store: ForgeStore;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDefNode>;
}

type Obj =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[] }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __type: 'PullRequestFileConnection'; files: Array<{ path: string }> }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; name: string }
  | { __type: 'CreateIssuePayload'; issue: Issue; repo: Repo }
  | { __type: 'CloseIssuePayload'; issue: Issue; repo: Repo }
  | { __type: 'CreatePullRequestPayload'; pull: Pull; repo: Repo }
  | { __type: 'MergePullRequestPayload'; pull: Pull; repo: Repo }
  | { __type: 'AddCommentPayload'; commentId: string; body: string }
  | { __type: 'CommentEdge'; commentId: string; body: string }
  | { __type: 'Comment'; commentId: string; body: string };

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('c:')) return -1;
    const n = Number(text.slice(2));
    return Number.isInteger(n) && n >= 0 ? n : -1;
  } catch {
    return -1;
  }
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt',
  'author', 'labels', 'comments', 'repository', 'viewerDidAuthor',
];
const PULL_REQUEST_TYPE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author',
  'repository', 'url', 'isDraft',
];
const REPOSITORY_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
  'createdAt', 'updatedAt', 'url',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'WIKI'];

function issueConnection(repo: Repo, args: Record<string, unknown>): { issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy;
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>).direction;
    if (dir === 'DESC') direction = 'DESC';
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const first = typeof args.first === 'number' ? args.first : list.length;
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex + 1;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : null;
  return { issues: page, pageInfo: { hasNextPage, endCursor } };
}

function resolveField(obj: Obj, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const args = argMap(field, ctx);
  switch (obj.__type) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User', login: store.viewerLogin } as Obj;
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ __type: 'Repository', repo } as Obj) : null;
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(decoded.key));
          return repo ? ({ __type: 'Repository', repo } as Obj) : null;
        }
        if (decoded.kind === 'I') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
          const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
          return repo && issue ? ({ __type: 'Issue', repo, issue } as Obj) : null;
        }
        if (decoded.kind === 'PR') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
          const pull = repo?.pulls.find((candidate) => candidate.number === Number(number));
          return repo && pull ? ({ __type: 'PullRequest', repo, pull } as Obj) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (['Issue', 'PullRequest', 'Repository', 'SearchType', 'User', 'IssueConnection', 'PullRequestConnection'].includes(name)) {
          return { __type: '__Type', name } as Obj;
        }
        return null;
      }
      return undefined;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = repoId?.kind === 'R' ? [...store.repos.values()].find((candidate) => candidate.id === Number(repoId.key)) : undefined;
        if (!repo) return null;
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', issue, repo } as Obj;
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueId = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        if (issueId?.kind !== 'I') return null;
        const [repoId, number] = issueId.key.split(':');
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
        const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
        if (!repo || !issue) return null;
        issue.state = 'closed';
        issue.closedSeq = store.nextSeq();
        issue.updatedSeq = issue.closedSeq;
        return { __type: 'CloseIssuePayload', issue, repo } as Obj;
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = repoId?.kind === 'R' ? [...store.repos.values()].find((candidate) => candidate.id === Number(repoId.key)) : undefined;
        if (!repo) return null;
        const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if (!pull) return null;
        return { __type: 'CreatePullRequestPayload', pull, repo } as Obj;
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const pullId = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        if (pullId?.kind !== 'PR') return null;
        const [repoId, number] = pullId.key.split(':');
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
        const pull = repo?.pulls.find((candidate) => candidate.number === Number(number));
        if (!repo || !pull) return null;
        const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (pull.state === 'open' && currentBaseTip && !store.mergeConflict(repo, pull.headSha, currentBaseTip)) {
          const sha = store.squashMerge(repo, pull);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedSeq = store.nextSeq();
          pull.mergeCommitSha = sha;
          pull.updatedSeq = pull.mergedSeq;
        }
        return { __type: 'MergePullRequestPayload', pull, repo } as Obj;
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        if (subjectId?.kind !== 'I') return null;
        const [repoId, number] = subjectId.key.split(':');
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(repoId));
        const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
        if (!repo || !issue) return null;
        const comment = { id: store.nextId(), body: String(input.body ?? ''), user: store.viewerLogin, createdSeq: store.nextSeq() };
        issue.comments.push(comment);
        const commentId = globalId('C', `${repo.id}:${issue.number}:${comment.id}`);
        return { __type: 'AddCommentPayload', commentId, body: comment.body } as Obj;
      }
      return undefined;
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return globalId('U', obj.login);
      return undefined;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (field.name === 'id') return globalId('R', String(repo.id));
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __type: 'User', login: repo.owner } as Obj;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { name: repo.defaultBranch } : null;
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
        return issue ? ({ __type: 'Issue', repo, issue } as Obj) : null;
      }
      if (field.name === 'issues') {
        const page = issueConnection(repo, args);
        return { __type: 'IssueConnection', repo, issues: page.issues, pageInfo: page.pageInfo } as unknown as Obj;
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
        const pulls = repo.pulls.filter((pull) => pull.state === 'open').slice(0, first);
        return { __type: 'PullRequestConnection', repo, pulls } as Obj;
      }
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
        return pull ? ({ __type: 'PullRequest', repo, pull } as Obj) : null;
      }
      if (field.name === 'url') return `/${repo.owner}/${repo.name}`;
      if (field.name === 'createdAt') return store.isoOf(repo.createdSeq);
      if (field.name === 'updatedAt') return store.isoOf(repo.updatedSeq);
      return undefined;
    }
    case 'Issue': {
      const issue = obj.issue;
      if (field.name === 'id') return globalId('I', `${obj.repo.id}:${issue.number}`);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return store.isoOf(issue.createdSeq);
      if (field.name === 'updatedAt') return store.isoOf(issue.updatedSeq);
      if (field.name === 'closedAt') return issue.closedSeq === null ? null : store.isoOf(issue.closedSeq);
      if (field.name === 'author') return { __type: 'User', login: issue.user } as Obj;
      if (field.name === 'repository') return { __type: 'Repository', repo: obj.repo } as Obj;
      return undefined;
    }
    case 'PullRequest': {
      const pull = obj.pull;
      if (field.name === 'id') return globalId('PR', `${obj.repo.id}:${pull.number}`);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        const currentBaseTip = obj.repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (!currentBaseTip) return 'UNKNOWN';
        return store.mergeConflict(obj.repo, pull.headSha, currentBaseTip) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : pull.files.length;
        return { __type: 'PullRequestFileConnection', files: pull.files.slice(0, first).map((file) => ({ path: file.filename })) } as Obj;
      }
      if (field.name === 'createdAt') return store.isoOf(pull.createdSeq);
      if (field.name === 'updatedAt') return store.isoOf(pull.updatedSeq);
      if (field.name === 'mergedAt') return pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq);
      if (field.name === 'author') return { __type: 'User', login: pull.user } as Obj;
      if (field.name === 'repository') return { __type: 'Repository', repo: obj.repo } as Obj;
      return undefined;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return obj.issues.map((issue) => ({ __type: 'Issue', repo: obj.repo, issue }) as Obj);
      }
      if (field.name === 'pageInfo') {
        return { __type: 'PageInfo', hasNextPage: (obj as unknown as { pageInfo: { hasNextPage: boolean; endCursor: string | null } }).pageInfo.hasNextPage, endCursor: (obj as unknown as { pageInfo: { hasNextPage: boolean; endCursor: string | null } }).pageInfo.endCursor } as Obj;
      }
      if (field.name === 'totalCount') return obj.issues.length;
      return undefined;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return obj.pulls.map((pull) => ({ __type: 'PullRequest', repo: obj.repo, pull }) as Obj);
      }
      if (field.name === 'totalCount') return obj.pulls.length;
      return undefined;
    }
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return obj.files.map((file) => ({ path: file.path }));
      if (field.name === 'totalCount') return obj.files.length;
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return obj.endCursor;
      return undefined;
    }
    case '__Type': {
      if (field.name === 'fields') {
        const names =
          obj.name === 'Issue' ? ISSUE_TYPE_FIELDS : obj.name === 'PullRequest' ? PULL_REQUEST_TYPE_FIELDS : obj.name === 'Repository' ? REPOSITORY_TYPE_FIELDS : [];
        return names.map((name) => ({ name }));
      }
      if (field.name === 'enumValues') {
        if (obj.name === 'SearchType') return SEARCH_TYPE_VALUES.map((name) => ({ name }));
        return [];
      }
      if (field.name === 'name') return obj.name;
      return undefined;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return { __type: 'Issue', repo: obj.repo, issue: obj.issue } as Obj;
      return undefined;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { __type: 'Issue', repo: obj.repo, issue: obj.issue } as Obj;
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: obj.repo, pull: obj.pull } as Obj;
      return undefined;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: obj.repo, pull: obj.pull } as Obj;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { __type: 'CommentEdge', commentId: obj.commentId, body: obj.body } as Obj;
      return undefined;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { __type: 'Comment', commentId: obj.commentId, body: obj.body } as Obj;
      return undefined;
    }
    case 'Comment': {
      if (field.name === 'id') return obj.commentId;
      if (field.name === 'body') return obj.body;
      return undefined;
    }
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && '__type' in (value as Record<string, unknown>);
}

function executeSelections(obj: Obj, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== obj.__type) {
        // A named-fragment spread: look the definition up.
        const def = ctx.fragments.get(selection.typeCondition);
        if (def) {
          if (def.typeCondition !== obj.__type) continue;
          Object.assign(out, executeSelections(obj, def.selections, ctx));
        }
        continue;
      }
      Object.assign(out, executeSelections(obj, selection.selections, ctx));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = obj.__type;
      continue;
    }
    const value = resolveField(obj, selection, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__type}".` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = executeValue(value, selection.selections, ctx);
  }
  return out;
}

function executeValue(value: unknown, selections: SelectionNode[], ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => executeValue(entry, selections, ctx));
  if (isObj(value)) {
    if (selections.length === 0) return {};
    return executeSelections(value, selections, ctx);
  }
  if (typeof value === 'object') {
    // A plain object (e.g. defaultBranchRef {name}, __type field {name}).
    if (selections.length === 0) return value;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      const responseKey = selection.alias ?? selection.name;
      out[responseKey] = (value as Record<string, unknown>)[selection.name] ?? null;
    }
    return out;
  }
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

/** Execute one operation document. Never throws for a GraphQL-level problem. */
export function executeGraphQL(store: ForgeStore, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  const ctx: Ctx = { store, variables, errors: [], fragments: new Map() };
  let defs: Array<OperationNode | FragmentDefNode>;
  try {
    defs = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  for (const def of defs) {
    if (def.kind === 'fragmentDef') ctx.fragments.set(def.name, def);
  }
  const operations = defs.filter((def): def is OperationNode => def.kind === 'operation');
  let operation: OperationNode | undefined;
  if (operationName) operation = operations.find((candidate) => candidate.name === operationName);
  if (!operation) operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation found in document' }] };
  const root: Obj = operation.operation === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = executeSelections(root, operation.selections, ctx);
  return { data, errors: ctx.errors };
}
