// views.ts — the GitHub REST v3 JSON shapes, shared by the REST routes, the
// MCP tools and the GraphQL cross-checks so every surface renders the same
// object for the same entity.

import { globalId, type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';

export function userView(store: ForgeStore, login: string): Record<string, unknown> {
  return {
    login,
    id: login === store.viewerLogin ? store.identity.viewerId : 2000,
    node_id: globalId('U', login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoView(store: ForgeStore, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userView(store, repo.owner),
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.isoOf(repo.createdSeq),
    updated_at: store.isoOf(repo.updatedSeq),
    pushed_at: store.isoOf(repo.updatedSeq),
    git_url: `git:///${repo.owner}/${repo.name}.git`,
    ssh_url: `git@/${repo.owner}/${repo.name}.git`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelView(store: ForgeStore, repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.find((candidate) => candidate.name === name);
  return {
    id: label?.id ?? 0,
    node_id: globalId('L', `${repo.id}:${name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? '',
  };
}

export function issueView(store: ForgeStore, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', `${repo.id}:${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userView(store, issue.user),
    labels: issue.labels.map((name) => labelView(store, repo, name)),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: store.isoOf(issue.createdSeq),
    updated_at: store.isoOf(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : store.isoOf(issue.closedSeq),
    author_association: 'OWNER',
  };
}

export function commentView(store: ForgeStore, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', `${repo.id}:${issue.number}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userView(store, comment.user),
    created_at: store.isoOf(comment.createdSeq),
    updated_at: store.isoOf(comment.createdSeq),
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(store: ForgeStore, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = pull.headSha;
  const baseSha = pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PR', `${repo.id}:${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userView(store, pull.user),
    created_at: store.isoOf(pull.createdSeq),
    updated_at: store.isoOf(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? store.isoOf(pull.updatedSeq) : null,
    merged_at: pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !store.mergeConflict(repo, pull.headSha, pull.baseSha) : null,
    mergeable_state: pull.state === 'open' ? (store.mergeConflict(repo, pull.headSha, pull.baseSha) ? 'dirty' : 'clean') : 'unknown',
    merged_by: pull.merged ? userView(store, pull.user) : null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userView(store, repo.owner),
      repo: repoView(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userView(store, repo.owner),
      repo: repoView(store, repo),
    },
    draft: false,
    commits: 1,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pull.files.length,
  };
}

export function pullFileView(file: Pull['files'][number]): Record<string, unknown> {
  return {
    sha: '',
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: '',
  };
}
