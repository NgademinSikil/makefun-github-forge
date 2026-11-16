// gitserver.ts — git smart HTTP: info/refs advertisements (v0 and v2),
// upload-pack (protocol v2 ls-refs/fetch, plus a v0 fallback) and
// receive-pack (v0). All state lives in the ForgeStore; objects are the
// same ones the REST contents API creates.

import {
  ZERO_OID,
  collectReachable,
  decodePktLinesAll,
  decodePktLinesPrefix,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitcore.ts';
import type { ForgeStore, Repo } from './store.ts';

const AGENT = 'forge/1.0.0';
const V2_CAPS = ['version 2', 'agent=forge/1.0.0', 'ls-refs', 'fetch=shallow filter', 'object-format=sha1'];
const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k multi_ack thin-pack ofs-delta shallow agent=forge/1.0.0';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0.0 symref=HEAD:refs/heads/main';

export interface GitRefs {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref of a repo, sorted by name, with peeled tag targets. */
export function listRefs(store: ForgeStore, repo: Repo): GitRefs[] {
  const out: GitRefs[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: GitRefs = { name, oid };
    const object = store.getObject(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(oid, store.lookup);
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function v0Advertisement(store: ForgeStore, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const refs = listRefs(store, repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headOid = headTip ?? ZERO_OID;
    lines.push(`${headOid} HEAD\u0000${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

export function infoRefsResponse(
  store: ForgeStore,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantsV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && wantsV2) {
    const lines = [...V2_CAPS.map((cap) => `${cap}\n`), 'flush'] as Array<string | 'flush'>;
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: encodePktLines(lines),
    };
  }
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(store, repo, service, caps),
  };
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowReq: string[];
  depth: number | null;
}

/** Commits within `depth` generations of the wants (null depth = all). */
function includedCommits(store: ForgeStore, wants: readonly string[], depth: number | null): Set<string> {
  const included = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = wants.map((oid) => ({ oid, d: 0 }));
  while (queue.length) {
    const { oid, d } = queue.pop() as { oid: string; d: number };
    if (included.has(oid)) continue;
    if (depth !== null && d >= depth) continue;
    const object = store.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
  }
  return included;
}

/** Objects the client already holds: the haves' closure, stopping at shallow boundaries. */
function heldObjects(store: ForgeStore, haves: readonly string[], shallowReq: readonly string[]): Set<string> {
  const held = new Set<string>();
  const shallowSet = new Set(shallowReq);
  for (const have of haves) {
    const object = store.getObject(have);
    if (!object) continue;
    if (object.type !== 'commit') {
      held.add(have);
      continue;
    }
    if (shallowSet.has(have)) {
      // The client holds this commit and its tree, but not its parents.
      held.add(have);
      const tree = parseCommit(object.data).tree;
      for (const oid of collectReachable([tree], store.lookup, { allowMissing: true })) held.add(oid);
    } else {
      for (const oid of collectReachable([have], store.lookup, { allowMissing: true })) held.add(oid);
    }
  }
  return held;
}

interface FetchComputation {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function computeFetch(store: ForgeStore, plan: FetchPlan): FetchComputation {
  const included = includedCommits(store, plan.wants, plan.depth);
  const held = heldObjects(store, plan.haves, plan.shallowReq);
  const send = new Set<string>();
  for (const oid of included) {
    const object = store.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    send.add(oid);
    const tree = parseCommit(object.data).tree;
    for (const entry of collectReachable([tree], store.lookup, { allowMissing: true })) send.add(entry);
  }
  // A wanted tag object itself (e.g. refs/tags/v1) is part of the pack:
  // includedCommits only walks commits, so tag objects would otherwise be
  // dropped even though the client asked for the ref that names them.
  for (const want of plan.wants) {
    let current: string | null = want;
    for (let depth = 0; depth < 10 && current; depth += 1) {
      const object = store.getObject(current);
      if (!object) break;
      if (object.type !== 'tag') break;
      if (!held.has(current)) send.add(current);
      current = parseTag(object.data).object;
    }
  }
  for (const oid of held) send.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = store.getObject(oid);
    if (object) objects.push(object);
  }
  // Shallow boundaries: included commits with a parent outside the set.
  const boundaries = new Set<string>();
  for (const oid of included) {
    const object = store.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent)) boundaries.add(oid);
    }
  }
  const unshallow: string[] = [];
  for (const old of plan.shallowReq) {
    if (included.has(old) && !boundaries.has(old)) unshallow.push(old);
  }
  const shallow = [...boundaries];
  for (const old of plan.shallowReq) {
    if (!unshallow.includes(old) && !shallow.includes(old)) shallow.push(old);
  }
  shallow.sort();
  unshallow.sort();
  return { objects, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(encodePktLine(Buffer.from([1])));
  return packets;
}

function v2FetchResponse(store: ForgeStore, plan: FetchPlan): Buffer {
  const computed = computeFetch(store, plan);
  const pack = writePack(computed.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(Buffer.from('0001', 'ascii'));
  if (computed.shallow.length > 0 || computed.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of computed.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of computed.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(store: ForgeStore, plan: FetchPlan): Buffer {
  const computed = computeFetch(store, plan);
  const pack = writePack(computed.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of computed.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of computed.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseV2Args(lines: string[]): { command: string; args: string[] } {
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args: string[] = [];
  let afterDelim = false;
  for (const line of lines.slice(1)) {
    if (line === '\u0001DELIM') {
      afterDelim = true;
      continue;
    }
    if (afterDelim) args.push(line.replace(/\n$/, ''));
  }
  return { command, args };
}

/** Handle POST git-upload-pack. Returns status/content-type/body. */
export function handleUploadPack(
  store: ForgeStore,
  repo: Repo,
  body: Buffer,
  wantsV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  const resultType = 'application/x-git-upload-pack-result';
  let packets: GitPacket[];
  try {
    packets = decodePktLinesAll(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line stream') };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      lines.push('\u0001DELIM');
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (wantsV2) {
    const { command, args } = parseV2Args(lines);
    if (command === 'ls-refs') {
      return { status: 200, contentType: resultType, body: lsRefsResponse(store, repo, args) };
    }
    if (command === 'fetch') {
      const plan: FetchPlan = { wants: [], haves: [], shallowReq: [], depth: null };
      for (const arg of args) {
        if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) plan.shallowReq.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) plan.depth = Number(arg.slice(7).trim());
      }
      return { status: 200, contentType: resultType, body: v2FetchResponse(store, plan) };
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown v2 command') };
  }
  // v0: want lines, shallow/deepen lines, flush, have lines, done, flush.
  const plan: FetchPlan = { wants: [], haves: [], shallowReq: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const space = rest.indexOf(' ');
      plan.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) plan.shallowReq.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) plan.depth = Number(text.slice(7).trim());
  }
  return { status: 200, contentType: resultType, body: v0FetchResponse(store, plan) };
}

function lsRefsResponse(store: ForgeStore, repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const refs = listRefs(store, repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (prefixes.length === 0) {
    if (headTip) {
      lines.push(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn refs/heads/${repo.defaultBranch}${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  store: ForgeStore,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const resultType = 'application/x-git-receive-pack-result';
  let decoded: { packets: GitPacket[]; rest: Buffer };
  try {
    decoded = decodePktLinesPrefix(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line stream') };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) {
      const caps = text.slice(nul + 1).split(' ');
      sideband = caps.includes('side-band-64k');
      reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const reportLines: string[] = [];
  const packBytes = decoded.rest;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!store.getObject(oid)) store.objects.set(oid, object);
      }
      reportLines.push('unpack ok');
    } catch (err) {
      reportLines.push(`unpack ${(err as Error).message}`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error`);
      return { status: 200, contentType: resultType, body: reportResponse(reportLines, sideband) };
    }
  } else {
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack) {
      reportLines.push('unpack ok');
    } else {
      reportLines.push('unpack ok');
    }
  }
  void reportStatus;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const isDelete = command.newOid === ZERO_OID;
    const isCreate = command.oldOid === ZERO_OID;
    if (isDelete) {
      if (current === ZERO_OID || command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} failed to update ref`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (isCreate) {
      if (current !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} already exists`);
        continue;
      }
    } else if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} failed to update ref`);
      continue;
    }
    const object = store.getObject(command.newOid);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
      reportLines.push(`ng ${command.ref} failed to update ref`);
      continue;
    }
    if (!isCreate) {
      const oldCommit = peelToCommit(command.oldOid, store.lookup);
      const newCommit = peelToCommit(command.newOid, store.lookup);
      if (!oldCommit || !newCommit || !isAncestorOf(store, oldCommit, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  return { status: 200, contentType: resultType, body: reportResponse(reportLines, sideband) };
}

function isAncestorOf(store: ForgeStore, ancestor: string, descendant: string): boolean {
  return store.isAncestor(ancestor, descendant);
}

function reportResponse(lines: string[], sideband: boolean): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    const framed = encodePktLine(`${line}\n`);
    if (sideband) parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), framed])));
    else parts.push(framed);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Verify a pack's objects hash to their ids (used by tests, not the server). */
export function verifyPackObjects(pack: Buffer): boolean {
  try {
    const read = readPack(pack);
    for (const [oid, object] of read.objects) {
      if (hashObject(object.type, object.data) !== oid) return false;
    }
    return true;
  } catch {
    return false;
  }
}
