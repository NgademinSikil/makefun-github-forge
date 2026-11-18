# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/NgademinSikil/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/NgademinSikil/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A minimal GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL, and MCP in a single Node process. Standard library only, no git binary, no outside services.

## Run it

```sh
node --experimental-strip-types main.ts
```

Local development: fixed port (FORGE_DEV_PORT, default 8123).

```sh
MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types dev.ts
```

Node 22 or later. The code is erasable TypeScript (no enums, namespaces, or
parameter properties) so `--experimental-strip-types` runs it directly.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — `info/refs` (protocol v2 and
  v0), `git-upload-pack` (v2 and v0 fetch, shallow fetch), `git-receive-pack`
  (v0 push with report-status).
- **REST v3** under `/api/v3` — repos, branches, commits, refs, contents,
  labels, issues, comments, pull requests (squash merge).
- **GraphQL** at `/api/graphql` — viewer, repository, issue, pull request,
  labels, comments, and the create/close/merge mutations the suite uses.
- **MCP** at `/mcp` — modern `server/discover` plus legacy `initialize`;
  six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

Authentication: bearer token `MAKEFUN_SHOP_TOKEN`. When the variable is
unset (local development), any bearer token is accepted. Requests without a
token are 401.

## State

All state is in memory and deterministic: timestamps come from a fixed epoch
(2025-01-01T00:00:00Z) advanced by a monotonic counter, and the viewer,
teammate, stranger, and org identities are derived from the public scenario
seed `0x6a09e667f3bcc909n` (viewer login `adaiversen`). Nothing is persisted
between restarts.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Trial lifecycle: listen, register, poll `/done`, exit 0. |
| `dev.ts` | Standalone runner on a fixed port. |
| `app.ts` | HTTP server and REST/GraphQL/MCP/git routing. |
| `gitserver.ts` | Git smart-HTTP protocol (upload-pack / receive-pack). |
| `gitcore.ts` | Git object model: SHA-1 hashing, pkt-lines, packs, trees, commits. |
| `store.ts` | In-memory store: repos, refs, issues, PRs, merges. |
| `graphql.ts` | Small GraphQL parser/executor for the suite's documents. |
| `views.ts` | REST v3 JSON shapes shared by REST, MCP, and GraphQL. |
| `mcp.ts` | MCP discovery, initialize, tools list/call. |
| `scenario.ts` | Deterministic scenario identities from the public seed. |

---

<sub>Entered on [make.fun](https://make.fun/?ref=ds1567x3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
