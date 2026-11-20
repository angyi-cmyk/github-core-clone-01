// github-core-clone-01: a standalone GitHub-compatible git forge.
// Node.js stdlib only. One process: REST v3 (/api/v3), GraphQL v4 (/api/graphql),
// MCP (/mcp) and git smart HTTP (/{owner}/{repo}.git). No git binary, no outside services.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const MAIN_REF = 'refs/heads/main';
const AGENT = 'github-core-clone-forge/1.0.0';
const VERSION = '1.0.0';

// ---------------------------------------------------------------- utilities

let reqCounter = 0;
const REQ_PREFIX = randomBytes(6).toString('hex');
function requestId(): string {
  reqCounter += 1;
  return `req_${REQ_PREFIX}_${reqCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isoNow(): string {
  return new Date().toISOString();
}

function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function b64decode(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

// ---------------------------------------------------------------- scenario PRNG (wire.ts, exact)

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(count: number): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = generateUsers(12);
const VIEWER = SCENARIO_USERS[0]!; // adaiversen
const STRANGER = SCENARIO_USERS[2]!; // olgabauer

// ---------------------------------------------------------------- git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
const OBJ_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJ_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

interface GitObject {
  type: ObjType;
  data: Buffer;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

function buildCommit(tree: string, parents: string[], message: string, identity: string, timestamp: number): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${identity} ${timestamp} +0000`);
  lines.push(`committer ${identity} ${timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const mode = data.subarray(off, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (by oid) to path -> {mode, oid}, recursively. */
function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(objects, e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
}

/** Build nested tree objects from a flat path map; returns the root tree oid. Stores objects. */
function buildTreeFromPaths(objects: Map<string, GitObject>, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push({ mode: v.mode, name: parts[parts.length - 1]!, oid: v.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** All ancestors of `tip` (inclusive) in first-seen order. */
function commitAncestors(objects: Map<string, GitObject>, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const info = parseCommit(obj.data);
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]!);
  }
  return out;
}

/** Reachable objects from `tips` (commits/tags), minus those reachable from `excludeTips`. Commits
 *  in `cut` are included with their trees but their parents are not walked (a shallow boundary the
 *  client already holds: the client has the commit, not its history). */
function reachableObjects(objects: Map<string, GitObject>, tips: string[], excludeTips: string[], cut: Set<string> = new Set()): Set<string> {
  const wanted = new Set<string>();
  const walk = (oid: string, seen: Set<string>): void => {
    if (seen.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      walk(info.tree, seen);
      if (!cut.has(oid)) for (const p of info.parents) walk(p, seen);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) walk(e.oid, seen);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) walk(m[1]!, seen);
    }
  };
  const excluded = new Set<string>();
  for (const t of excludeTips) walk(t, excluded);
  for (const t of tips) walk(t, wanted);
  for (const oid of excluded) wanted.delete(oid);
  return wanted;
}

/** The non-tag object an annotated tag ultimately points at (or the oid itself). */
function peelTagTarget(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
    if (!m) return current;
    current = m[1]!;
  }
  return current;
}

/** Commits reachable from `tips` within `depth` generations (depth 1 = tips only). */
function depthLimitedCommits(objects: Map<string, GitObject>, tips: string[], depth: number): { included: Set<string>; shallow: string[] } {
  const included = new Set<string>();
  const shallow: string[] = [];
  const queue: Array<{ oid: string; d: number }> = tips.map((oid) => ({ oid, d: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    const info = parseCommit(obj.data);
    if (d + 1 < depth) {
      for (const p of info.parents) queue.push({ oid: p, d: d + 1 });
    } else {
      // A boundary commit is shallow even when it has no parents (a root commit is still listed
      // as shallow by git's own upload-pack for a deepen fetch).
      shallow.push(oid);
    }
  }
  return { included, shallow };
}

// ---------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), data]);
}
const PKT_FLUSH = Buffer.from('0000', 'utf8');
const PKT_DELIM = Buffer.from('0001', 'utf8');

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines into packets (trailing raw bytes, if any, are returned). */
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
    } else if (off + len <= buf.length) {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    } else break;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- packfiles

function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = OBJ_TYPE_CODE[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let s = size;
    let first = (typeCode << 4) | (s & 0x0f);
    s >>>= 4;
    if (s > 0) first |= 0x80;
    headerBytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>>= 7;
      if (s > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++]!;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++]!;
      if (op & 0x02) cpOff |= delta[off++]! << 8;
      if (op & 0x04) cpOff |= delta[off++]! << 16;
      if (op & 0x08) cpOff |= delta[off++]! << 24;
      if (op & 0x10) cpSize = delta[off++]!;
      if (op & 0x20) cpSize |= delta[off++]! << 8;
      if (op & 0x40) cpSize |= delta[off++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      outLen += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || outLen !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Inflate one zlib stream starting at `off`; return the data and the byte just past the stream. */
function inflateOne(buf: Buffer, off: number): { data: Buffer; end: number } {
  // Exponential probe for a complete prefix, then binary-search the minimal one.
  let step = 16;
  let hi = Math.min(buf.length, off + step);
  for (;;) {
    try {
      inflateSync(buf.subarray(off, hi));
      break;
    } catch {
      if (hi >= buf.length) throw new Error('truncated zlib stream in pack');
      step *= 2;
      hi = Math.min(buf.length, off + step);
    }
  }
  let lo = off + 1;
  // Invariant: [off, lo) fails, [off, hi) succeeds. (lo may equal hi already.)
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(off, lo)), end: lo };
}

interface ParsedPack {
  objects: Map<string, GitObject>;
  count: number;
}

/** Parse a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. Throws on malformed input. */
function parsePack(buf: Buffer): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  let off = 12;
  const readVarintHeader = (): { typeCode: number; size: number } => {
    const b0 = buf[off++]!;
    let size = b0 & 0x0f;
    let shift = 4;
    const typeCode = (b0 >> 4) & 0x07;
    let b = b0;
    while (b & 0x80) {
      b = buf[off++]!;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    return { typeCode, size };
  };
  const readOffsetVarint = (): number => {
    let b = buf[off++]!;
    let value = b & 0x7f;
    while (b & 0x80) {
      b = buf[off++]!;
      value = ((value + 1) << 7) | (b & 0x7f);
    }
    return value;
  };
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { typeCode } = readVarintHeader();
    if (typeCode === 6) {
      const negOff = readOffsetVarint();
      const { data: delta, end } = inflateOne(buf, off);
      off = end;
      const base = byOffset.get(start - negOff);
      if (!base) throw new Error('ofs-delta base not found');
      const data = applyDelta(base.data, delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(start, { type: base.type, data });
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data: delta, end } = inflateOne(buf, off);
      off = end;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const data = applyDelta(base.data, delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(start, { type: base.type, data });
    } else {
      const type = OBJ_CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown object type ${typeCode}`);
      const { data, end } = inflateOne(buf, off);
      off = end;
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(start, { type, data });
    }
  }
  return { objects, count };
}

/** Verify a pack's trailer SHA-1. */
function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const expected = buf.subarray(buf.length - 20).toString('hex');
  const actual = sha1(buf.subarray(0, buf.length - 20));
  return expected === actual;
}

// ---------------------------------------------------------------- store

let nextRepoId = 5000;
let nextObjectId = 100000;
let nextCommentId = 200000;
let nextLabelId = 300000;

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  comments: Map<number, Comment[]>;
  pulls: Map<number, Pull>;
  numberSeq: number;
  createSeq: number;
  version: number;
}

const repos = new Map<string, Repo>();
let repoCreateSeq = 0;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function identityOf(login: string): string {
  const user = SCENARIO_USERS.find((u) => u.login === login) ?? VIEWER;
  return `${user.name} <${user.email}>`;
}

function userJson(login: string): Record<string, unknown> {
  const user = SCENARIO_USERS.find((u) => u.login === login) ?? VIEWER;
  return {
    login: user.login,
    id: user.id,
    node_id: b64encode(`user:${user.id}`),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const now = isoNow();
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER.login,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    createdAt: now,
    updatedAt: now,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    comments: new Map(),
    pulls: new Map(),
    numberSeq: 0,
    createSeq: repoCreateSeq++,
    version: 0,
  };
  // A new repository starts with no labels; the API creates them on demand.
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

function repoJson(repo: Repo, req: IncomingMessage): Record<string, unknown> {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}`;
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: b64encode(`repo:${repo.id}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    forks_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/forks`,
    keys_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/keys{/key_id}`,
    collaborators_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/collaborators{/collaborator}`,
    teams_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/teams`,
    hooks_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/hooks`,
    issue_events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/events{/number}`,
    events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/events`,
    assignees_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/assignees{/user}`,
    branches_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/branches{/branch}`,
    tags_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/tags`,
    blobs_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs{/sha}`,
    git_tags_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/tags{/sha}`,
    git_refs_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs{/sha}`,
    trees_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees{/sha}`,
    statuses_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/statuses/{sha}`,
    languages_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/languages`,
    stargazers_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/stargazers`,
    contributors_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contributors`,
    subscribers_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/subscribers`,
    subscription_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/subscription`,
    issues_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues{/number}`,
    pulls_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls{/number}`,
    merges_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/merges`,
    compare_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/compare/{base}...{head}`,
    archive_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/{archive_format}{/ref}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    svn_url: `${base}/${repo.owner}/${repo.name}`,
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
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.refs.size > 0 ? repo.updatedAt : null,
  };
}

function labelJson(repo: Repo, label: Label, req: IncomingMessage): Record<string, unknown> {
  const host = req.headers.host ?? '127.0.0.1';
  return {
    id: label.id,
    node_id: b64encode(`label:${repo.id}:${label.id}`),
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueLabelsJson(repo: Repo, issue: Issue, req: IncomingMessage): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name);
    if (label) out.push(labelJson(repo, label, req));
  }
  return out;
}

function issueJson(repo: Repo, issue: Issue, req: IncomingMessage, asPull?: Pull): Record<string, unknown> {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  const body: Record<string, unknown> = {
    id: issue.id,
    node_id: b64encode(`issue:${repo.id}:${issue.number}`),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.userLogin),
    labels: issueLabelsJson(repo, issue, req),
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
  if (asPull) {
    body.pull_request = {
      url: `${base}/pulls/${asPull.number}`,
      html_url: `http://${host}/${repo.owner}/${repo.name}/pull/${asPull.number}`,
      diff_url: `http://${host}/${repo.owner}/${repo.name}/pull/${asPull.number}.diff`,
      patch_url: `http://${host}/${repo.owner}/${repo.name}/pull/${asPull.number}.patch`,
      merged_at: asPull.mergedAt,
    };
  }
  return body;
}

function commentJson(repo: Repo, comment: Comment, issueNumber: number, req: IncomingMessage): Record<string, unknown> {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: b64encode(`comment:${repo.id}:${comment.id}`),
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${base}/issues/${issueNumber}`,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function branchHeadSha(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(`refs/heads/${ref}`);
}

function mergeBase(objects: Map<string, GitObject>, aTip: string, bTip: string): string | null {
  const aAnc = new Set(commitAncestors(objects, aTip));
  const queue: string[] = [bTip];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAnc.has(oid)) return oid;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Line diff counts (LCS on lines; guarded for huge files). */
function diffLineCounts(aText: string, bText: string): { additions: number; deletions: number } {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  if (a.length * b.length > 4_000_000) {
    const aSet = new Map<string, number>();
    for (const l of a) aSet.set(l, (aSet.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of b) {
      const n = aSet.get(l) ?? 0;
      if (n > 0) {
        aSet.set(l, n - 1);
        common += 1;
      }
    }
    return { additions: b.length - common, deletions: a.length - common };
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: m - lcs, deletions: n - lcs };
}

function isBinary(data: Buffer): boolean {
  return data.includes(0);
}

interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
}

/** Diff two flattened trees (base -> head). */
function diffTrees(repo: Repo, baseFlat: Map<string, { mode: string; oid: string }>, headFlat: Map<string, { mode: string; oid: string }>, req: IncomingMessage): FileDiff[] {
  const host = req.headers.host ?? '127.0.0.1';
  const out: FileDiff[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b && h && b.oid === h.oid) continue;
    let status: 'added' | 'removed' | 'modified';
    let additions = 0;
    let deletions = 0;
    if (!b && h) {
      status = 'added';
      const obj = repo.objects.get(h.oid);
      if (obj && !isBinary(obj.data)) additions = obj.data.toString('utf8').split('\n').length;
    } else if (b && !h) {
      status = 'removed';
      const obj = repo.objects.get(b.oid);
      if (obj && !isBinary(obj.data)) deletions = obj.data.toString('utf8').split('\n').length;
    } else {
      status = 'modified';
      const bObj = repo.objects.get(b!.oid);
      const hObj = repo.objects.get(h!.oid);
      if (bObj && hObj && !isBinary(bObj.data) && !isBinary(hObj.data)) {
        const c = diffLineCounts(bObj.data.toString('utf8'), hObj.data.toString('utf8'));
        additions = c.additions;
        deletions = c.deletions;
      }
    }
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${h?.oid ?? b?.oid ?? ''}`,
      raw_url: `http://${host}/${repo.owner}/${repo.name}/raw/HEAD/${encodeURIComponent(path)}`,
      contents_url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}`,
    });
  }
  return out;
}

/** 3-way merge of flattened trees. Returns the merged flat map and whether it conflicts. */
function threeWayMerge(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): { merged: Map<string, { mode: string; oid: string }>; conflict: boolean } {
  const merged = new Map<string, { mode: string; oid: string }>();
  let conflict = false;
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const eq = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (eq(o, t)) {
      if (o) merged.set(path, o);
    } else if (eq(b, o)) {
      if (t) merged.set(path, t);
    } else if (eq(b, t)) {
      if (o) merged.set(path, o);
    } else {
      conflict = true;
    }
  }
  return { merged, conflict };
}

function commitJson(repo: Repo, sha: string, req: IncomingMessage): Record<string, unknown> {
  const host = req.headers.host ?? '127.0.0.1';
  const obj = repo.objects.get(sha);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const message = info?.message ?? '';
  const authorLine = info?.author ?? '';
  const committerLine = info?.committer ?? '';
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const m = line.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
    if (!m) return { name: VIEWER.name, email: VIEWER.email, date: isoNow() };
    return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]!) * 1000).toISOString() };
  };
  const author = parseIdent(authorLine);
  const committer = parseIdent(committerLine);
  return {
    sha,
    node_id: b64encode(`commit:${repo.id}:${sha}`),
    commit: {
      author,
      committer,
      message,
      tree: { sha: info?.tree ?? '', url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info?.tree ?? ''}` },
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `http://${host}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: (info?.parents ?? []).map((p) => ({ sha: p, url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `http://${host}/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

function pullJson(repo: Repo, pull: Pull, req: IncomingMessage): Record<string, unknown> {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  const mergeable = computeMergeable(repo, pull);
  const { headSha, baseSha } = pullTips(repo, pull);
  return {
    id: pull.id,
    node_id: b64encode(`pr:${repo.id}:${pull.number}`),
    url: `${base}/pulls/${pull.number}`,
    html_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.userLogin),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    merged_by: pull.merged ? userJson(VIEWER.login) : null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(repo.owner),
      repo: repoJson(repo, req),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(repo.owner),
      repo: repoJson(repo, req),
    },
    _links: {
      self: { href: `${base}/pulls/${pull.number}` },
      html: { href: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}` },
      issue: { href: `${base}/issues/${pull.number}` },
      comments: { href: `${base}/issues/${pull.number}/comments` },
      review_comments: { href: `${base}/pulls/${pull.number}/comments` },
      review_comment: { href: `${base}/pulls/comments{/number}` },
      commits: { href: `${base}/pulls/${pull.number}/commits` },
      statuses: { href: `${base}/statuses/${pull.headSha}` },
    },
    author_association: 'OWNER',
    draft: false,
  };
}

/** The current tips of a PR's branches (falling back to the shas stored at creation). */
function pullTips(repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
  return {
    headSha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha,
    baseSha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha,
  };
}

function computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const { headSha, baseSha } = pullTips(repo, pull);
  const headObj = repo.objects.get(headSha);
  const baseObj = repo.objects.get(baseSha);
  if (!headObj || !baseObj) return 'UNKNOWN';
  if (headSha === baseSha) return 'MERGEABLE';
  const mb = mergeBase(repo.objects, baseSha, headSha);
  const baseFlat = new Map<string, { mode: string; oid: string }>();
  if (mb) {
    const mbObj = repo.objects.get(mb);
    if (mbObj && mbObj.type === 'commit') flattenTree(repo.objects, parseCommit(mbObj.data).tree, '', baseFlat);
  }
  const oursFlat = new Map<string, { mode: string; oid: string }>();
  const theirsFlat = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo.objects, parseCommit(baseObj.data).tree, '', oursFlat);
  flattenTree(repo.objects, parseCommit(headObj.data).tree, '', theirsFlat);
  const { conflict } = threeWayMerge(baseFlat, oursFlat, theirsFlat);
  return conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a pull request onto its current base-branch tip. Returns the merge commit sha,
 *  or a reason the merge cannot happen. Shared by REST, GraphQL and MCP. */
function doSquashMerge(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state === 'closed') return { ok: false, reason: pull.merged ? 'Pull request is already merged.' : 'Pull request is closed.' };
  const { headSha, baseSha } = pullTips(repo, pull);
  if (headSha === baseSha) return { ok: false, reason: 'No commits between head and base.' };
  if (computeMergeable(repo, pull) !== 'MERGEABLE') return { ok: false, reason: 'Pull request is not mergeable.' };
  const mb = mergeBase(repo.objects, baseSha, headSha);
  const baseFlat = new Map<string, { mode: string; oid: string }>();
  if (mb) {
    const mbObj = repo.objects.get(mb);
    if (mbObj && mbObj.type === 'commit') flattenTree(repo.objects, parseCommit(mbObj.data).tree, '', baseFlat);
  }
  const oursFlat = new Map<string, { mode: string; oid: string }>();
  const theirsFlat = new Map<string, { mode: string; oid: string }>();
  const baseObj = repo.objects.get(baseSha);
  const headObj = repo.objects.get(headSha);
  if (baseObj?.type === 'commit') flattenTree(repo.objects, parseCommit(baseObj.data).tree, '', oursFlat);
  if (headObj?.type === 'commit') flattenTree(repo.objects, parseCommit(headObj.data).tree, '', theirsFlat);
  const { merged } = threeWayMerge(baseFlat, oursFlat, theirsFlat);
  const mergedTreeOid = buildTreeFromPaths(repo.objects, merged);
  const now = Math.floor(Date.now() / 1000);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit(mergedTreeOid, [baseSha], message, identityOf(VIEWER.login), now);
  const commitSha = hashObject('commit', commitData);
  repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  repo.version += 1;
  repo.updatedAt = isoNow();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = commitSha;
  pull.headSha = headSha;
  pull.baseSha = baseSha;
  pull.updatedAt = isoNow();
  return { ok: true, sha: commitSha };
}

/** Paginate an array; returns the page and the Link header value (or ''). */
function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage): { page: T[]; link: string } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const pathname = pathOf(req);
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `http://${host}${pathname}?${q.toString()}`;
  };
  const links: string[] = [];
  if (pageNum < totalPages) {
    links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (pageNum > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  }
  return { page, link: links.join(', ') };
}

function validRepoName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name);
}

/** Resolve a branch/commit for the contents/commits endpoints. */
function resolveRefTip(repo: Repo, refParam: string | null): string | undefined {
  if (refParam === null || refParam === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${refParam}`)) return repo.refs.get(`refs/heads/${refParam}`);
  if (repo.refs.has(refParam)) return repo.refs.get(refParam);
  if (/^[0-9a-f]{40}$/.test(refParam) && repo.objects.has(refParam)) return refParam;
  return undefined;
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '');

  // API root (starter behavior: no auth).
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!path.startsWith('/api/v3/')) return false;

  if (!authOk(req)) {
    errJson(res, 401, 'Bad credentials');
    return true;
  }

  const body = await readBody(req);
  let json: unknown = {};
  if (body.length > 0) {
    try {
      json = parseJsonBody(body);
    } catch {
      errJson(res, 400, 'Problems parsing JSON');
      return true;
    }
  }
  const input = isRecord(json) ? json : {};

  // GET /api/v3/meta
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '3.14.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson(VIEWER.login));
    return true;
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.createSeq - b.createSeq);
      const { page, link } = paginate(all.map((r) => repoJson(r, req)), query, req);
      sendJson(res, 200, page, link === '' ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (!validRepoName(name)) {
        errJson(res, 422, 'Invalid repository name');
        return true;
      }
      if (repos.has(repoKey(VIEWER.login, name))) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }], documentation_url: 'https://docs.github.com/rest/repos/repos#create-a-repository-for-the-authenticated-user' });
        return true;
      }
      const repo = createRepo(name, typeof input.description === 'string' ? input.description : '', input.private === true);
      sendJson(res, 201, repoJson(repo, req));
      return true;
    }
  }

  // /api/v3/repos/:owner/:repo/...
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3]!;
    const repoName = segments[4] ?? '';
    const repo = findRepo(owner, repoName);
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const rest = segments.slice(5);

    // GET/PATCH/DELETE /repos/:owner/:repo
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo, req));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') {
          if (!repo.refs.has(`refs/heads/${input.default_branch}`)) {
            errJson(res, 422, 'Default branch does not exist');
            return true;
          }
          repo.defaultBranch = input.default_branch;
        }
        if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name) {
          if (!validRepoName(input.name) || repos.has(repoKey(owner, input.name))) {
            errJson(res, 422, 'Invalid repository name');
            return true;
          }
          repos.delete(repoKey(owner, repo.name));
          repo.name = input.name;
          repos.set(repoKey(owner, repo.name), repo);
        }
        repo.updatedAt = isoNow();
        sendJson(res, 200, repoJson(repo, req));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, repo.name));
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return true;
      }
    }

    // GET /branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => {
          const sha = repo.refs.get(`refs/heads/${name}`)!;
          return {
            name,
            commit: { sha, url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
            protected: false,
          };
        });
      const { page, link } = paginate(branches, query, req);
      sendJson(res, 200, page, link === '' ? {} : { link });
      return true;
    }

    // GET /commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const tip = resolveRefTip(repo, query.get('sha'));
      if (tip === undefined) {
        if (repo.refs.size === 0) {
          sendJson(res, 200, []);
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      const ancestors = commitAncestors(repo.objects, tip);
      const { page, link } = paginate(ancestors.map((sha) => commitJson(repo, sha, req)), query, req);
      sendJson(res, 200, page, link === '' ? {} : { link });
      return true;
    }

    // /git/refs
    if (rest.length >= 1 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Invalid ref or sha');
          return true;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        repo.version += 1;
        repo.updatedAt = isoNow();
        sendJson(res, 201, {
          ref,
          node_id: b64encode(`ref:${repo.id}:${ref}`),
          url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref.replace(/^refs\//, ''))}`,
          object: { sha, type: repo.objects.get(sha)!.type, url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/repos/${owner}/${repoName}/git/${repo.objects.get(sha)!.type}s/${sha}` },
        });
        return true;
      }
      if (rest.length >= 3) {
        const refName = `refs/${rest.slice(2).join('/')}`;
        if (method === 'GET') {
          const sha = repo.refs.get(refName);
          if (sha === undefined) {
            errJson(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, {
            ref: refName,
            node_id: b64encode(`ref:${repo.id}:${refName}`),
            url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/repos/${owner}/${repoName}/git/refs/${rest.slice(2).join('/')}`,
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
          });
          return true;
        }
        if (method === 'DELETE') {
          if (refName === `refs/heads/${repo.defaultBranch}`) {
            errJson(res, 422, 'Cannot delete the default branch');
            return true;
          }
          if (!repo.refs.has(refName)) {
            errJson(res, 404, 'Not Found');
            return true;
          }
          repo.refs.delete(refName);
          repo.version += 1;
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
          return true;
        }
      }
    }

    // /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l, req)));
        return true;
      }
      if (method === 'POST') {
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '' || repo.labels.has(name)) {
          errJson(res, 422, name === '' ? 'Invalid label name' : 'Label already exists');
          return true;
        }
        const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
        const label: Label = { id: nextLabelId++, name, color, description: typeof input.description === 'string' ? input.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(repo, label, req));
        return true;
      }
    }
    if (rest.length === 2 && rest[0] === 'labels') {
      const labelName = decodeURIComponent(rest[1]!);
      const label = repo.labels.get(labelName);
      if (!label) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PATCH') {
        if (typeof input.name === 'string' && input.name !== '' && input.name !== label.name) {
          if (repo.labels.has(input.name)) {
            errJson(res, 422, 'Label already exists');
            return true;
          }
          repo.labels.delete(label.name);
          label.name = input.name;
          repo.labels.set(label.name, label);
          // rename on issues too
          for (const issue of repo.issues.values()) {
            issue.labels = issue.labels.map((l) => (l === labelName ? label.name : l));
          }
        }
        if (typeof input.color === 'string') label.color = input.color.replace(/^#/, '');
        if (typeof input.description === 'string') label.description = input.description;
        sendJson(res, 200, labelJson(repo, label, req));
        return true;
      }
      if (method === 'DELETE') {
        repo.labels.delete(label.name);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return true;
      }
    }

    // /issues
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const items: Array<Record<string, unknown>> = [];
        for (const issue of repo.issues.values()) {
          if (state !== 'all' && issue.state !== state) continue;
          items.push(issueJson(repo, issue, req));
        }
        for (const pull of repo.pulls.values()) {
          if (state !== 'all' && pull.state !== state) continue;
          const asIssue: Issue = {
            id: pull.id, number: pull.number, title: pull.title, body: pull.body,
            state: pull.state, labels: [], userLogin: pull.userLogin,
            createdAt: pull.createdAt, updatedAt: pull.updatedAt,
            closedAt: pull.state === 'closed' ? pull.updatedAt : null, seq: pull.seq,
          };
          items.push(issueJson(repo, asIssue, req, pull));
        }
        items.sort((a, b) => {
          const av = (a as Record<string, unknown>).created_at as string;
          const bv = (b as Record<string, unknown>).created_at as string;
          void sort;
          return direction === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
        });
        const { page, link } = paginate(items, query, req);
        sendJson(res, 200, page, link === '' ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') {
          errJson(res, 422, 'Title is required');
          return true;
        }
        const labelNames: string[] = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === 'string') : [];
        for (const n of labelNames) {
          if (!repo.labels.has(n)) {
            errJson(res, 422, `Label does not exist: ${n}`);
            return true;
          }
        }
        const number = ++repo.numberSeq;
        const now = isoNow();
        const issue: Issue = {
          id: nextObjectId++, number, title, body: typeof input.body === 'string' ? input.body : '',
          state: 'open', labels: labelNames, userLogin: VIEWER.login,
          createdAt: now, updatedAt: now, closedAt: null, seq: number,
        };
        repo.issues.set(number, issue);
        sendJson(res, 201, issueJson(repo, issue, req));
        return true;
      }
    }

    // /issues/:number and /issues/:number/comments
    if (rest.length >= 2 && rest[0] === 'issues') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.get(number);
      const pull = repo.pulls.get(number);
      if (rest.length === 2) {
        if (!issue && !pull) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          if (issue) sendJson(res, 200, issueJson(repo, issue, req));
          else {
            const asIssue: Issue = {
              id: pull!.id, number: pull!.number, title: pull!.title, body: pull!.body,
              state: pull!.state, labels: [], userLogin: pull!.userLogin,
              createdAt: pull!.createdAt, updatedAt: pull!.updatedAt,
              closedAt: pull!.state === 'closed' ? pull!.updatedAt : null, seq: pull!.seq,
            };
            sendJson(res, 200, issueJson(repo, asIssue, req, pull!));
          }
          return true;
        }
        if (method === 'PATCH') {
          if (issue) {
            if (typeof input.title === 'string') issue.title = input.title;
            if (typeof input.body === 'string') issue.body = input.body;
            if (input.state === 'open' || input.state === 'closed') {
              issue.state = input.state;
              issue.closedAt = input.state === 'closed' ? isoNow() : null;
            }
            if (Array.isArray(input.labels)) {
              const labelNames = input.labels.filter((l): l is string => typeof l === 'string');
              for (const n of labelNames) {
                if (!repo.labels.has(n)) {
                  errJson(res, 422, `Label does not exist: ${n}`);
                  return true;
                }
              }
              issue.labels = labelNames;
            }
            issue.updatedAt = isoNow();
            sendJson(res, 200, issueJson(repo, issue, req));
            return true;
          }
          // PATCH on a PR number closes/reopens the PR.
          if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) {
            pull!.state = input.state;
            pull!.updatedAt = isoNow();
          }
          if (typeof input.title === 'string') pull!.title = input.title;
          if (typeof input.body === 'string') pull!.body = input.body;
          const asIssue: Issue = {
            id: pull!.id, number: pull!.number, title: pull!.title, body: pull!.body,
            state: pull!.state, labels: [], userLogin: pull!.userLogin,
            createdAt: pull!.createdAt, updatedAt: pull!.updatedAt,
            closedAt: pull!.state === 'closed' ? pull!.updatedAt : null, seq: pull!.seq,
          };
          sendJson(res, 200, issueJson(repo, asIssue, req, pull!));
          return true;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue && !pull) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          const list = (repo.comments.get(number) ?? []).map((c) => commentJson(repo, c, number, req));
          sendJson(res, 200, list);
          return true;
        }
        if (method === 'POST') {
          const bodyText = typeof input.body === 'string' ? input.body : '';
          if (bodyText === '') {
            errJson(res, 422, 'Body is required');
            return true;
          }
          const now = isoNow();
          const comment: Comment = { id: nextCommentId++, body: bodyText, userLogin: VIEWER.login, createdAt: now, updatedAt: now };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, commentJson(repo, comment, number, req));
          return true;
        }
      }
    }

    // /pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => (direction === 'asc' ? (a.createdAt < b.createdAt ? -1 : 1) : (a.createdAt > b.createdAt ? -1 : 1)));
        const { page, link } = paginate(list.map((p) => pullJson(repo, p, req)), query, req);
        sendJson(res, 200, page, link === '' ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        const headRaw = typeof input.head === 'string' ? input.head : '';
        const baseRaw = typeof input.base === 'string' ? input.base : '';
        if (title === '' || headRaw === '' || baseRaw === '') {
          errJson(res, 422, 'Title, head and base are required');
          return true;
        }
        const headRef = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
        const baseRef = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
        const headSha = branchHeadSha(repo, headRef);
        const baseSha = branchHeadSha(repo, baseRef);
        if (headSha === undefined || baseSha === undefined) {
          errJson(res, 422, 'Head or base branch does not exist');
          return true;
        }
        if (headSha === baseSha) {
          errJson(res, 422, 'No commits between head and base');
          return true;
        }
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) {
            errJson(res, 422, 'A pull request already exists for this head branch');
            return true;
          }
        }
        const number = ++repo.numberSeq;
        const now = isoNow();
        const pull: Pull = {
          id: nextObjectId++, number, title, body: typeof input.body === 'string' ? input.body : '',
          state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
          headRef, baseRef, headSha, baseSha, userLogin: VIEWER.login,
          createdAt: now, updatedAt: now, seq: number,
        };
        repo.pulls.set(number, pull);
        sendJson(res, 201, pullJson(repo, pull, req));
        return true;
      }
    }

    // /pulls/:number, /pulls/:number/files, /pulls/:number/merge
    if (rest.length >= 2 && rest[0] === 'pulls') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const pull = repo.pulls.get(number);
      if (!pull) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull, req));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseFlat = new Map<string, { mode: string; oid: string }>();
        const headFlat = new Map<string, { mode: string; oid: string }>();
        const { headSha, baseSha } = pullTips(repo, pull);
        const baseObj = repo.objects.get(baseSha);
        const headObj = repo.objects.get(headSha);
        if (baseObj?.type === 'commit') flattenTree(repo.objects, parseCommit(baseObj.data).tree, '', baseFlat);
        if (headObj?.type === 'commit') flattenTree(repo.objects, parseCommit(headObj.data).tree, '', headFlat);
        const { page, link } = paginate(diffTrees(repo, baseFlat, headFlat, req), query, req);
        sendJson(res, 200, page, link === '' ? {} : { link });
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const result = doSquashMerge(repo, pull);
        if (!result.ok) {
          errJson(res, 405, result.reason);
          return true;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
    }

    // /contents/:path
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const branchParam = typeof input.branch === 'string' ? input.branch : (query.get('ref') ?? null);
      const tip = resolveRefTip(repo, branchParam);
      const host = req.headers.host ?? '127.0.0.1';
      const contentsUrl = (p: string): string => `http://${host}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(p)}`;

      const readTreeAtTip = (): Map<string, { mode: string; oid: string }> | null => {
        if (tip === undefined) return null;
        const tipObj = repo.objects.get(tip);
        if (!tipObj || tipObj.type !== 'commit') return null;
        const flat = new Map<string, { mode: string; oid: string }>();
        flattenTree(repo.objects, parseCommit(tipObj.data).tree, '', flat);
        return flat;
      };

      if (method === 'GET') {
        const flat = readTreeAtTip();
        if (flat === null) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const entry = flat.get(filePath);
        if (entry) {
          const blob = repo.objects.get(entry.oid)!;
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: blob.data.length, name: filePath.split('/').pop(),
            path: filePath, content: blob.data.toString('base64'), sha: entry.oid,
            url: contentsUrl(filePath), html_url: `http://${host}/${owner}/${repoName}/blob/HEAD/${encodeURIComponent(filePath)}`,
            download_url: null, _links: { self: contentsUrl(filePath), git: `http://${host}/api/v3/repos/${owner}/${repoName}/git/blobs/${entry.oid}`, html: `http://${host}/${owner}/${repoName}/blob/HEAD/${encodeURIComponent(filePath)}` },
          });
          return true;
        }
        // directory listing (or root when path is '')
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
        for (const [p, v] of flat) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const firstSeg = restPath.split('/')[0]!;
          if (restPath.includes('/')) {
            if (!children.has(firstSeg)) {
              children.set(firstSeg, { type: 'dir', name: firstSeg, path: `${prefix}${firstSeg}`, sha: '', size: 0 });
            }
          } else {
            const blob = repo.objects.get(v.oid);
            children.set(firstSeg, { type: 'file', name: firstSeg, path: p, sha: v.oid, size: blob?.data.length ?? 0 });
          }
        }
        if (children.size === 0) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const listing = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((c) => ({
          type: c.type, size: c.type === 'file' ? c.size : 0, name: c.name, path: c.path, sha: c.sha,
          url: contentsUrl(c.path), html_url: `http://${host}/${owner}/${repoName}/tree/HEAD/${encodeURIComponent(c.path)}`,
          download_url: c.type === 'file' ? null : null,
          _links: { self: contentsUrl(c.path), git: c.type === 'file' ? `http://${host}/api/v3/repos/${owner}/${repoName}/git/blobs/${c.sha}` : `http://${host}/api/v3/repos/${owner}/${repoName}/git/trees/${c.sha}`, html: `http://${host}/${owner}/${repoName}/tree/HEAD/${encodeURIComponent(c.path)}` },
        }));
        sendJson(res, 200, listing);
        return true;
      }

      if (method === 'PUT') {
        const message = typeof input.message === 'string' && input.message !== '' ? input.message : `Update ${filePath}`;
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        if (contentB64 === '' && typeof input.content !== 'string') {
          errJson(res, 422, 'Content is required');
          return true;
        }
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentB64.replace(/\s/g, ''))) {
          errJson(res, 422, 'Content is not valid base64');
          return true;
        }
        const contentBytes = b64decode(contentB64);
        const branch = branchParam ?? repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const isFirstCommit = branchTip === undefined && repo.refs.size === 0;
        if (branchTip === undefined && !isFirstCommit) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const flat = branchTip !== undefined ? (readTreeAtTip() ?? new Map<string, { mode: string; oid: string }>()) : new Map<string, { mode: string; oid: string }>();
        const existing = flat.get(filePath);
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (existing) {
          if (givenSha === undefined || givenSha !== existing.oid) {
            sendJson(res, 409, { message: 'file does not match the provided sha' });
            return true;
          }
        } else if (givenSha !== undefined) {
          sendJson(res, 409, { message: 'file does not exist' });
          return true;
        }
        const blobOid = hashObject('blob', contentBytes);
        repo.objects.set(blobOid, { type: 'blob', data: contentBytes });
        flat.set(filePath, { mode: '100644', oid: blobOid });
        const treeOid = buildTreeFromPaths(repo.objects, flat);
        const now = Math.floor(Date.now() / 1000);
        const commitData = buildCommit(treeOid, branchTip !== undefined ? [branchTip] : [], message, identityOf(VIEWER.login), now);
        const commitSha = hashObject('commit', commitData);
        repo.objects.set(commitSha, { type: 'commit', data: commitData });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.version += 1;
        repo.updatedAt = isoNow();
        sendJson(res, existing ? 200 : 201, {
          content: {
            name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: contentBytes.length,
            url: contentsUrl(filePath), html_url: `http://${host}/${owner}/${repoName}/blob/HEAD/${encodeURIComponent(filePath)}`,
            git_url: `http://${host}/api/v3/repos/${owner}/${repoName}/git/blobs/${blobOid}`,
            download_url: null, type: 'file', content: contentBytes.toString('base64'), encoding: 'base64',
            _links: { self: contentsUrl(filePath), git: `http://${host}/api/v3/repos/${owner}/${repoName}/git/blobs/${blobOid}`, html: `http://${host}/${owner}/${repoName}/blob/HEAD/${encodeURIComponent(filePath)}` },
          },
          commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: new Date(now * 1000).toISOString() }, committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(now * 1000).toISOString() } },
        });
        return true;
      }

      if (method === 'DELETE') {
        const message = typeof input.message === 'string' && input.message !== '' ? input.message : `Delete ${filePath}`;
        const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
        const branch = branchParam ?? repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const flat = readTreeAtTip();
        if (flat === null) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const existing = flat.get(filePath);
        if (!existing) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (givenSha === undefined || givenSha !== existing.oid) {
          sendJson(res, 409, { message: 'file does not match the provided sha' });
          return true;
        }
        flat.delete(filePath);
        const treeOid = buildTreeFromPaths(repo.objects, flat);
        const now = Math.floor(Date.now() / 1000);
        const commitData = buildCommit(treeOid, [branchTip], message, identityOf(VIEWER.login), now);
        const commitSha = hashObject('commit', commitData);
        repo.objects.set(commitSha, { type: 'commit', data: commitData });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.version += 1;
        repo.updatedAt = isoNow();
        sendJson(res, 200, {
          commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: new Date(now * 1000).toISOString() }, committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(now * 1000).toISOString() } },
        });
        return true;
      }
    }
  }

  // Unknown /api/v3 route: JSON 404, never HTML.
  errJson(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- GraphQL v4

type GQLValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GQLValue[] }
  | { kind: 'object'; fields: Record<string, GQLValue> };

interface GQLSelection {
  kind: 'field' | 'spread' | 'inline';
  name?: string;
  alias?: string;
  args?: Record<string, GQLValue>;
  typeCondition?: string;
  selections?: GQLSelection[];
}

interface GQLOperation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: GQLSelection[];
}

interface GQLFragment {
  name: string;
  typeCondition: string;
  selections: GQLSelection[];
}

interface GQLToken {
  type: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function gqlLex(src: string): GQLToken[] {
  const tokens: GQLToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=[]{}|&@'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && /[0-9.]/.test(src[j]!)) {
        if (src[j] === '.') isFloat = true;
        j += 1;
      }
      if (j < src.length && (src[j] === 'e' || src[j] === 'E')) {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL lexer: unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class GQLParser {
  private tokens: GQLToken[];
  private pos = 0;
  constructor(src: string) {
    this.tokens = gqlLex(src);
  }
  peek(): GQLToken | undefined {
    return this.tokens[this.pos];
  }
  next(): GQLToken {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('GraphQL parser: unexpected end of document');
    this.pos += 1;
    return t;
  }
  expect(value: string): GQLToken {
    const t = this.next();
    if (t.value !== value) throw new Error(`GraphQL parser: expected ${value}, got ${t.value}`);
    return t;
  }
  expectName(): string {
    const t = this.next();
    if (t.type !== 'name') throw new Error(`GraphQL parser: expected a name, got ${t.value}`);
    return t.value;
  }
  parseDocument(): { operations: GQLOperation[]; fragments: Map<string, GQLFragment> } {
    const operations: GQLOperation[] = [];
    const fragments = new Map<string, GQLFragment>();
    while (this.peek() !== undefined) {
      const t = this.peek()!;
      if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        const n = this.peek();
        if (n?.type === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.parseVarDefs();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, selections });
      } else if (t.type === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expect('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else if (t.value === '{') {
        operations.push({ kind: 'query', selections: this.parseSelectionSet() });
      } else {
        throw new Error(`GraphQL parser: unexpected token ${t.value}`);
      }
    }
    return { operations, fragments };
  }
  private parseVarDefs(): void {
    this.expect('(');
    while (this.peek()?.value !== ')') {
      this.expect('$');
      this.expectName();
      this.expect(':');
      this.parseType();
      if (this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expect(')');
  }
  private parseType(): void {
    const t = this.peek();
    if (t?.value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.value === '!') this.next();
  }
  parseSelectionSet(): GQLSelection[] {
    this.expect('{');
    const out: GQLSelection[] = [];
    while (this.peek()?.value !== '}') {
      const t = this.peek()!;
      if (t.type === 'spread') {
        this.next();
        const n = this.peek();
        if (n?.type === 'name' && n.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          const selections = this.parseSelectionSet();
          out.push({ kind: 'inline', typeCondition, selections });
        } else {
          const name = this.expectName();
          out.push({ kind: 'spread', name });
        }
      } else {
        let name = this.expectName();
        let alias: string | undefined;
        if (this.peek()?.value === ':') {
          this.next();
          alias = name;
          name = this.expectName();
        }
        let args: Record<string, GQLValue> | undefined;
        if (this.peek()?.value === '(') args = this.parseArgs();
        while (this.peek()?.value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.value === '(') this.parseArgs();
        }
        let selections: GQLSelection[] | undefined;
        if (this.peek()?.value === '{') selections = this.parseSelectionSet();
        out.push({ kind: 'field', name, alias, args, selections });
      }
    }
    this.expect('}');
    return out;
  }
  private parseArgs(): Record<string, GQLValue> {
    const args: Record<string, GQLValue> = {};
    this.expect('(');
    while (this.peek()?.value !== ')') {
      const name = this.expectName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseValue(): GQLValue {
    const t = this.next();
    if (t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.value === '[') {
      const values: GQLValue[] = [];
      while (this.peek()?.value !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t.value === '{') {
      const fields: Record<string, GQLValue> = {};
      while (this.peek()?.value !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.type === 'string') return { kind: 'string', value: t.value };
    if (t.type === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.type === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.type === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`GraphQL parser: unexpected value token ${t.value}`);
  }
}

function resolveValue(v: GQLValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable':
      return variables[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.values.map((x) => resolveValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, GQLValue> | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

interface TypedValue {
  __typename: string;
  __source: unknown;
}

function tv(typename: string, source: unknown): TypedValue {
  return { __typename: typename, __source: source };
}

function isTyped(v: unknown): v is TypedValue {
  return isRecord(v) && typeof v.__typename === 'string' && '__source' in v;
}

function cursorFor(seq: number): string {
  return b64encode(`cursor:${seq}`);
}
function seqFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = decoded.match(/^cursor:(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function decodeNodeId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts[0] === 'repo' && parts.length === 2) return { kind: 'repo', repoId: Number(parts[1]), number: 0 };
    if (parts[0] === 'issue' && parts.length === 3) return { kind: 'issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'pr' && parts.length === 3) return { kind: 'pr', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'comment' && parts.length === 3) return { kind: 'comment', repoId: Number(parts[1]), number: Number(parts[2]) };
    return null;
  } catch {
    return null;
  }
}

function findRepoById(repoId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === repoId) return repo;
  return undefined;
}

function issueNodeId(repo: Repo, issue: Issue): string {
  return b64encode(`issue:${repo.id}:${issue.number}`);
}
function prNodeId(repo: Repo, pull: Pull): string {
  return b64encode(`pr:${repo.id}:${pull.number}`);
}
function repoNodeId(repo: Repo): string {
  return b64encode(`repo:${repo.id}`);
}

interface GQLCtx {
  req: IncomingMessage;
  variables: Record<string, unknown>;
  fragments: Map<string, GQLFragment>;
  errors: Array<{ message: string }>;
}

const GQL_TYPE_META: Record<string, { kind: string; fields: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closedAt'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'author', 'labels', 'url', 'createdAt', 'updatedAt'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequests', 'pullRequest', 'labels', 'url', 'createdAt', 'updatedAt'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  CommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'ORGANIZATION'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
};

function gqlTypeInfo(name: string): TypedValue | null {
  const meta = GQL_TYPE_META[name];
  if (!meta) return null;
  return tv('__Type', { name, kind: meta.kind, fields: meta.fields, enumValues: meta.enumValues ?? [] });
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

interface IssueItem {
  kind: 'issue' | 'pr';
  repo: Repo;
  issue?: Issue;
  pull?: Pull;
  seq: number;
  createdAt: string;
}

function paginateConnection<T extends { seq: number }>(items: T[], first: number | undefined, after: string | undefined): { nodes: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  let filtered = items;
  if (after !== undefined && after !== null) {
    const seq = seqFromCursor(String(after));
    if (seq !== null) filtered = items.filter((it) => it.seq > seq);
  }
  const limit = first === undefined || first === null ? filtered.length : Math.max(0, Math.trunc(first));
  const nodes = filtered.slice(0, limit);
  const hasNextPage = filtered.length > nodes.length;
  return {
    nodes,
    hasNextPage,
    endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.seq) : null,
    startCursor: nodes.length > 0 ? cursorFor(nodes[0]!.seq) : null,
  };
}

function execSelections(selections: GQLSelection[], typeName: string, source: unknown, ctx: GQLCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name ?? '');
      if (frag && (frag.typeCondition === typeName || frag.typeCondition === '')) {
        Object.assign(out, execSelections(frag.selections, typeName, source, ctx));
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition === typeName) {
        Object.assign(out, execSelections(sel.selections ?? [], typeName, source, ctx));
      }
      continue;
    }
    const fieldName = sel.name!;
    const responseKey = sel.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const args = resolveArgs(sel.args, ctx.variables);
    const value = resolveField(typeName, fieldName, source, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = projectValue(value, sel.selections, ctx);
  }
  return out;
}

function projectValue(value: unknown, selections: GQLSelection[] | undefined, ctx: GQLCtx): unknown {
  if (value === null || value === undefined) return value;
  if (!selections || selections.length === 0) return value;
  if (isTyped(value)) return execSelections(selections, value.__typename, value.__source, ctx);
  if (Array.isArray(value)) return value.map((v) => projectValue(v, selections, ctx));
  return value;
}

function resolveField(typeName: string, field: string, source: unknown, args: Record<string, unknown>, ctx: GQLCtx): unknown {
  // Query root
  if (typeName === 'Query') {
    if (field === 'viewer') return tv('User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    if (field === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = findRepo(owner, name);
      return repo ? tv('Repository', repo) : null;
    }
    if (field === 'node') {
      const id = String(args.id ?? '');
      const decoded = decodeNodeId(id);
      if (!decoded) return null;
      const repo = findRepoById(decoded.repoId);
      if (!repo) return null;
      if (decoded.kind === 'repo') return tv('Repository', repo);
      if (decoded.kind === 'issue') {
        const issue = repo.issues.get(decoded.number);
        return issue ? tv('Issue', { repo, issue }) : null;
      }
      if (decoded.kind === 'pr') {
        const pull = repo.pulls.get(decoded.number);
        return pull ? tv('PullRequest', { repo, pull }) : null;
      }
      if (decoded.kind === 'comment') {
        for (const list of repo.comments.values()) {
          const c = list.find((x) => x.id === decoded.number);
          if (c) return tv('Comment', { repo, comment: c });
        }
        return null;
      }
      return null;
    }
    if (field === '__type') {
      return gqlTypeInfo(String(args.name ?? ''));
    }
    return undefined;
  }

  // Mutation root
  if (typeName === 'Mutation') {
    try {
      if (field === 'createIssue') return tv('CreateIssuePayload', mutateCreateIssue(args, ctx));
      if (field === 'closeIssue') return tv('CloseIssuePayload', mutateCloseIssue(args, ctx));
      if (field === 'createPullRequest') return tv('CreatePullRequestPayload', mutateCreatePullRequest(args, ctx));
      if (field === 'mergePullRequest') return tv('MergePullRequestPayload', mutateMergePullRequest(args, ctx));
      if (field === 'addComment') return tv('AddCommentPayload', mutateAddComment(args, ctx));
    } catch (e) {
      ctx.errors.push({ message: e instanceof Error ? e.message : String(e) });
      return null;
    }
    return undefined;
  }

  // User
  if (typeName === 'User') {
    const u = source as { login: string; id: number; name: string; email: string };
    if (field === 'login') return u.login;
    if (field === 'id') return b64encode(`user:${u.id}`);
    if (field === 'databaseId') return u.id;
    if (field === 'name') return u.name;
    if (field === 'email') return u.email;
    if (field === 'url') return `https://github.com/${u.login}`;
    if (field === 'avatarUrl') return '';
    return undefined;
  }

  // Repository
  if (typeName === 'Repository') {
    const repo = source as Repo;
    if (field === 'id') return repoNodeId(repo);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'description') return repo.description;
    if (field === 'isPrivate') return repo.private;
    if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
    if (field === 'createdAt') return repo.createdAt;
    if (field === 'updatedAt') return repo.updatedAt;
    if (field === 'owner') return tv('User', { login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    if (field === 'defaultBranchRef') {
      return tv('Ref', { name: repo.defaultBranch });
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? tv('Issue', { repo, issue }) : null;
    }
    if (field === 'issues') return issuesConnection(repo, args);
    if (field === 'pullRequests') return pullsConnection(repo, args);
    if (field === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? tv('PullRequest', { repo, pull }) : null;
    }
    if (field === 'labels') {
      const labels = [...repo.labels.values()].map((l) => tv('Label', l));
      return tv('LabelConnection', { nodes: labels, totalCount: labels.length });
    }
    return undefined;
  }

  // Issue
  if (typeName === 'Issue') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    if (field === 'id') return issueNodeId(repo, issue);
    if (field === 'databaseId') return issue.id;
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'body') return issue.body;
    if (field === 'state') return issueStateGql(issue.state);
    if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (field === 'createdAt') return issue.createdAt;
    if (field === 'updatedAt') return issue.updatedAt;
    if (field === 'closedAt') return issue.closedAt;
    if (field === 'author') return tv('User', { login: issue.userLogin, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    if (field === 'repository') return tv('Repository', repo);
    if (field === 'labels') {
      const labels = issue.labels.map((n) => repo.labels.get(n)!).filter(Boolean).map((l) => tv('Label', l));
      return tv('LabelConnection', { nodes: labels, totalCount: labels.length });
    }
    if (field === 'comments') {
      const list = (repo.comments.get(issue.number) ?? []).map((c) => tv('Comment', { repo, comment: c }));
      return tv('CommentConnection', { nodes: list, totalCount: list.length });
    }
    return undefined;
  }

  // PullRequest
  if (typeName === 'PullRequest') {
    const { repo, pull } = source as { repo: Repo; pull: Pull };
    if (field === 'id') return prNodeId(repo, pull);
    if (field === 'databaseId') return pull.id;
    if (field === 'number') return pull.number;
    if (field === 'title') return pull.title;
    if (field === 'body') return pull.body;
    if (field === 'state') return pullStateGql(pull);
    if (field === 'merged') return pull.merged;
    if (field === 'mergedAt') return pull.mergedAt;
    if (field === 'mergeCommit') return pull.mergeCommitSha ? tv('Commit', { repo, sha: pull.mergeCommitSha }) : null;
    if (field === 'headRefName') return pull.headRef;
    if (field === 'baseRefName') return pull.baseRef;
    if (field === 'headRefOid') return pullTips(repo, pull).headSha;
    if (field === 'baseRefOid') return pullTips(repo, pull).baseSha;
    if (field === 'mergeable') return computeMergeable(repo, pull);
    if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (field === 'createdAt') return pull.createdAt;
    if (field === 'updatedAt') return pull.updatedAt;
    if (field === 'author') return tv('User', { login: pull.userLogin, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    if (field === 'repository') return tv('Repository', repo);
    if (field === 'labels') {
      return tv('LabelConnection', { nodes: [], totalCount: 0 });
    }
    if (field === 'files') {
      const baseFlat = new Map<string, { mode: string; oid: string }>();
      const headFlat = new Map<string, { mode: string; oid: string }>();
      const { headSha, baseSha } = pullTips(repo, pull);
      const baseObj = repo.objects.get(baseSha);
      const headObj = repo.objects.get(headSha);
      if (baseObj?.type === 'commit') flattenTree(repo.objects, parseCommit(baseObj.data).tree, '', baseFlat);
      if (headObj?.type === 'commit') flattenTree(repo.objects, parseCommit(headObj.data).tree, '', headFlat);
      const diffs = diffTrees(repo, baseFlat, headFlat, ctx.req);
      const nodes = diffs.map((d) => tv('PullRequestFile', { path: d.filename, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() }));
      return tv('PullRequestFileConnection', { nodes, totalCount: nodes.length });
    }
    return undefined;
  }

  // PullRequestFile
  if (typeName === 'PullRequestFile') {
    const f = source as { path: string; additions: number; deletions: number; changeType: string };
    if (field === 'path') return f.path;
    if (field === 'additions') return f.additions;
    if (field === 'deletions') return f.deletions;
    if (field === 'changeType') return f.changeType;
    return undefined;
  }

  // Connections
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'LabelConnection' || typeName === 'CommentConnection' || typeName === 'PullRequestFileConnection') {
    const conn = source as { nodes: unknown[]; totalCount: number; hasNextPage?: boolean; endCursor?: string | null; startCursor?: string | null };
    if (field === 'nodes') return conn.nodes;
    if (field === 'totalCount') return conn.totalCount;
    if (field === 'edges') {
      return conn.nodes.map((node) => tv(typeName === 'IssueConnection' ? 'IssueEdge' : typeName === 'PullRequestConnection' ? 'PullRequestEdge' : 'GenericEdge', { node, cursor: '' }));
    }
    if (field === 'pageInfo') {
      return tv('PageInfo', {
        hasNextPage: conn.hasNextPage ?? false,
        hasPreviousPage: false,
        startCursor: conn.startCursor ?? null,
        endCursor: conn.endCursor ?? null,
      });
    }
    return undefined;
  }
  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'GenericEdge') {
    const e = source as { node: unknown; cursor: string };
    if (field === 'node') return e.node;
    if (field === 'cursor') return e.cursor;
    return undefined;
  }
  if (typeName === 'PageInfo') {
    const p = source as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    if (field === 'hasNextPage') return p.hasNextPage;
    if (field === 'hasPreviousPage') return p.hasPreviousPage;
    if (field === 'startCursor') return p.startCursor;
    if (field === 'endCursor') return p.endCursor;
    return undefined;
  }
  if (typeName === 'Label') {
    const l = source as Label;
    if (field === 'id') return b64encode(`label:${l.id}`);
    if (field === 'name') return l.name;
    if (field === 'color') return l.color;
    if (field === 'description') return l.description;
    return undefined;
  }
  if (typeName === 'Comment') {
    const { repo, comment } = source as { repo: Repo; comment: Comment };
    void repo;
    if (field === 'id') return b64encode(`comment:${comment.id}`);
    if (field === 'databaseId') return comment.id;
    if (field === 'body') return comment.body;
    if (field === 'author') return tv('User', { login: comment.userLogin, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
    if (field === 'createdAt') return comment.createdAt;
    if (field === 'updatedAt') return comment.updatedAt;
    if (field === 'url') return '';
    return undefined;
  }
  if (typeName === 'Ref') {
    const r = source as { name: string };
    if (field === 'name') return r.name;
    if (field === 'target') return tv('Commit', { repo: null, sha: '' });
    return undefined;
  }
  if (typeName === 'Commit') {
    const c = source as { repo: Repo | null; sha: string };
    if (field === 'oid') return c.sha;
    if (field === 'message') {
      if (!c.repo) return '';
      const obj = c.repo.objects.get(c.sha);
      return obj && obj.type === 'commit' ? parseCommit(obj.data).message : '';
    }
    return undefined;
  }
  if (typeName === '__Type') {
    const t = source as { name: string; kind: string; fields: string[]; enumValues: string[] };
    if (field === 'name') return t.name;
    if (field === 'kind') return t.kind;
    if (field === 'fields') return t.fields.map((f) => tv('__Field', { name: f }));
    if (field === 'enumValues') return t.enumValues.map((v) => tv('__EnumValue', { name: v }));
    if (field === 'description') return null;
    return undefined;
  }
  if (typeName === '__Field') {
    const f = source as { name: string };
    if (field === 'name') return f.name;
    if (field === 'description') return null;
    if (field === 'type') return tv('__Type', { name: 'String', kind: 'SCALAR', fields: [], enumValues: [] });
    return undefined;
  }
  if (typeName === '__EnumValue') {
    const v = source as { name: string };
    if (field === 'name') return v.name;
    if (field === 'description') return null;
    return undefined;
  }

  // Mutation payloads
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const p = source as { issue: { repo: Repo; issue: Issue } | null; clientMutationId?: string };
    if (field === 'issue') return p.issue ? tv('Issue', p.issue) : null;
    if (field === 'clientMutationId') return p.clientMutationId ?? null;
    return undefined;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const p = source as { pullRequest: { repo: Repo; pull: Pull } | null; clientMutationId?: string };
    if (field === 'pullRequest') return p.pullRequest ? tv('PullRequest', p.pullRequest) : null;
    if (field === 'clientMutationId') return p.clientMutationId ?? null;
    return undefined;
  }
  if (typeName === 'AddCommentPayload') {
    const p = source as { commentEdge: { node: TypedValue; cursor: string } | null; clientMutationId?: string };
    if (field === 'commentEdge') return p.commentEdge ? tv('CommentEdge', p.commentEdge) : null;
    if (field === 'clientMutationId') return p.clientMutationId ?? null;
    return undefined;
  }
  if (typeName === 'CommentEdge') {
    const e = source as { node: TypedValue; cursor: string };
    if (field === 'node') return e.node;
    if (field === 'cursor') return e.cursor;
    return undefined;
  }

  return undefined;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'ASC');
  const items: IssueItem[] = [];
  for (const issue of repo.issues.values()) {
    if (states && !states.includes(issueStateGql(issue.state))) continue;
    items.push({ kind: 'issue', repo, issue, seq: issue.seq, createdAt: issue.createdAt });
  }
  items.sort((a, b) => {
    const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq;
    return direction === 'ASC' ? cmp : -cmp;
  });
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const { nodes, hasNextPage, endCursor, startCursor } = paginateConnection(items, first, after);
  const typedNodes = nodes.map((it) => tv('Issue', { repo: it.repo, issue: it.issue! }));
  return tv('IssueConnection', { nodes: typedNodes, totalCount: items.length, hasNextPage, endCursor, startCursor });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'ASC');
  const items: IssueItem[] = [];
  for (const pull of repo.pulls.values()) {
    if (states && !states.includes(pullStateGql(pull))) continue;
    items.push({ kind: 'pr', repo, pull, seq: pull.seq, createdAt: pull.createdAt });
  }
  items.sort((a, b) => {
    const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq;
    return direction === 'ASC' ? cmp : -cmp;
  });
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const { nodes, hasNextPage, endCursor, startCursor } = paginateConnection(items, first, after);
  const typedNodes = nodes.map((it) => tv('PullRequest', { repo: it.repo, pull: it.pull! }));
  return tv('PullRequestConnection', { nodes: typedNodes, totalCount: items.length, hasNextPage, endCursor, startCursor });
}

function mutateCreateIssue(args: Record<string, unknown>, ctx: GQLCtx): { issue: { repo: Repo; issue: Issue } | null; clientMutationId?: string } {
  const input = isRecord(args.input) ? args.input : {};
  const repo = findRepoById(Number((decodeNodeId(String(input.repositoryId ?? ''))?.repoId ?? NaN)));
  if (!repo) throw new Error('Could not resolve to a Repository with the provided id.');
  const title = String(input.title ?? '');
  if (title === '') throw new Error('Title is required.');
  const number = ++repo.numberSeq;
  const now = isoNow();
  const issue: Issue = {
    id: nextObjectId++, number, title, body: typeof input.body === 'string' ? input.body : '',
    state: 'open', labels: [], userLogin: VIEWER.login, createdAt: now, updatedAt: now, closedAt: null, seq: number,
  };
  repo.issues.set(number, issue);
  void ctx;
  return { issue: { repo, issue }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : undefined };
}

function mutateCloseIssue(args: Record<string, unknown>, ctx: GQLCtx): { issue: { repo: Repo; issue: Issue } | null; clientMutationId?: string } {
  const input = isRecord(args.input) ? args.input : {};
  const decoded = decodeNodeId(String(input.issueId ?? ''));
  if (!decoded) throw new Error('Could not resolve to an Issue with the provided id.');
  const repo = findRepoById(decoded.repoId);
  if (!repo) throw new Error('Could not resolve to a Repository with the provided id.');
  const issue = repo.issues.get(decoded.number);
  if (!issue) throw new Error('Could not resolve to an Issue with the provided id.');
  issue.state = 'closed';
  issue.closedAt = isoNow();
  issue.updatedAt = isoNow();
  void ctx;
  return { issue: { repo, issue }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : undefined };
}

function mutateCreatePullRequest(args: Record<string, unknown>, ctx: GQLCtx): { pullRequest: { repo: Repo; pull: Pull } | null; clientMutationId?: string } {
  const input = isRecord(args.input) ? args.input : {};
  const repo = findRepoById(Number((decodeNodeId(String(input.repositoryId ?? ''))?.repoId ?? NaN)));
  if (!repo) throw new Error('Could not resolve to a Repository with the provided id.');
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? '');
  const headSha = branchHeadSha(repo, headRef);
  const baseSha = branchHeadSha(repo, baseRef);
  if (headSha === undefined || baseSha === undefined) throw new Error('Head or base ref does not exist.');
  if (headSha === baseSha) throw new Error('No commits between head and base.');
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) throw new Error('A pull request already exists for this head branch.');
  }
  const title = String(input.title ?? '');
  if (title === '') throw new Error('Title is required.');
  const number = ++repo.numberSeq;
  const now = isoNow();
  const pull: Pull = {
    id: nextObjectId++, number, title, body: typeof input.body === 'string' ? input.body : '',
    state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
    headRef, baseRef, headSha, baseSha, userLogin: VIEWER.login, createdAt: now, updatedAt: now, seq: number,
  };
  repo.pulls.set(number, pull);
  void ctx;
  return { pullRequest: { repo, pull }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : undefined };
}

function mutateMergePullRequest(args: Record<string, unknown>, ctx: GQLCtx): { pullRequest: { repo: Repo; pull: Pull } | null; clientMutationId?: string } {
  const input = isRecord(args.input) ? args.input : {};
  const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
  if (!decoded) throw new Error('Could not resolve to a PullRequest with the provided id.');
  const repo = findRepoById(decoded.repoId);
  if (!repo) throw new Error('Could not resolve to a Repository with the provided id.');
  const pull = repo.pulls.get(decoded.number);
  if (!pull) throw new Error('Could not resolve to a PullRequest with the provided id.');
  const result = doSquashMerge(repo, pull);
  if (!result.ok) throw new Error(result.reason);
  void ctx;
  return { pullRequest: { repo, pull }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : undefined };
}

function mutateAddComment(args: Record<string, unknown>, ctx: GQLCtx): { commentEdge: { node: TypedValue; cursor: string } | null; clientMutationId?: string } {
  const input = isRecord(args.input) ? args.input : {};
  const decoded = decodeNodeId(String(input.subjectId ?? ''));
  if (!decoded) throw new Error('Could not resolve to a subject with the provided id.');
  const repo = findRepoById(decoded.repoId);
  if (!repo) throw new Error('Could not resolve to a Repository with the provided id.');
  const body = String(input.body ?? '');
  if (body === '') throw new Error('Body is required.');
  const now = isoNow();
  const comment: Comment = { id: nextCommentId++, body, userLogin: VIEWER.login, createdAt: now, updatedAt: now };
  const list = repo.comments.get(decoded.number) ?? [];
  list.push(comment);
  repo.comments.set(decoded.number, list);
  void ctx;
  return { commentEdge: { node: tv('Comment', { repo, comment }), cursor: cursorFor(comment.id) }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : undefined };
}

function executeGraphQLOperation(query: string, variables: Record<string, unknown>, operationName: string | undefined, req: IncomingMessage): Record<string, unknown> {
  const parser = new GQLParser(query);
  const { operations, fragments } = parser.parseDocument();
  let operation = operations[0];
  if (operationName !== undefined) {
    const named = operations.find((o) => o.name === operationName);
    if (named) operation = named;
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation provided.' }] };
  const ctx: GQLCtx = { req, variables, fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelections(operation.selections, rootType, null, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authOk(req)) {
    errJson(res, 401, 'Bad credentials');
    return true;
  }
  const body = await readBody(req);
  let json: unknown;
  try {
    json = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return true;
  }
  if (Array.isArray(json)) {
    const results = json.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') return { data: null, errors: [{ message: 'Invalid operation.' }] };
      try {
        return executeGraphQLOperation(entry.query, isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {}, typeof entry.operationName === 'string' ? entry.operationName : undefined, req);
      } catch (e) {
        return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
      }
    });
    sendJson(res, 200, results);
    return true;
  }
  if (!isRecord(json) || typeof json.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'Must provide a query string.' }] });
    return true;
  }
  try {
    const result = executeGraphQLOperation(json.query, isRecord(json.variables) ? (json.variables as Record<string, unknown>) : {}, typeof json.operationName === 'string' ? json.operationName : undefined, req);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 200, { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
  }
  return true;
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (must be the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'Alias for pull_number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if (typeof args.repository === 'string' && repoName === '') repoName = args.repository;
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    if (owner === '') owner = o ?? '';
    if (repoName === '') repoName = r ?? '';
  }
  if (owner === '' || repoName === '') return null;
  return findRepo(owner, repoName) ?? null;
}

function mcpToolResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: isRecord(payload) || Array.isArray(payload) ? payload : { value: payload } };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>, req: IncomingMessage): Record<string, unknown> {
  const missing = (fields: string[]): string | null => {
    for (const f of fields) if (args[f] === undefined || args[f] === null || args[f] === '') return f;
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const miss = missing(['name']);
      if (miss) return mcpToolError(`Missing required argument: ${miss}`);
      const repoName = String(args.name);
      if (!validRepoName(repoName)) return mcpToolError('Invalid repository name.');
      if (repos.has(repoKey(VIEWER.login, repoName))) return mcpToolError('Repository already exists.');
      const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return mcpToolResult(repoJson(repo, req));
    }
    case 'get_repo': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Repository not found.');
      return mcpToolResult(repoJson(repo, req));
    }
    case 'create_issue': {
      const miss = missing(['title']);
      if (miss) return mcpToolError(`Missing required argument: ${miss}`);
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Repository not found.');
      const labelNames: string[] = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const n of labelNames) if (!repo.labels.has(n)) return mcpToolError(`Label does not exist: ${n}`);
      const number = ++repo.numberSeq;
      const now = isoNow();
      const issue: Issue = {
        id: nextObjectId++, number, title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: labelNames, userLogin: VIEWER.login, createdAt: now, updatedAt: now, closedAt: null, seq: number,
      };
      repo.issues.set(number, issue);
      return mcpToolResult(issueJson(repo, issue, req));
    }
    case 'list_issues': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Repository not found.');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((i) => issueJson(repo, i, req));
      return mcpToolResult({ issues: list });
    }
    case 'create_pull_request': {
      const miss = missing(['title', 'head', 'base']);
      if (miss) return mcpToolError(`Missing required argument: ${miss}`);
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Repository not found.');
      const headRef = String(args.head).includes(':') ? String(args.head).split(':').slice(1).join(':') : String(args.head);
      const baseRef = String(args.base).includes(':') ? String(args.base).split(':').slice(1).join(':') : String(args.base);
      const headSha = branchHeadSha(repo, headRef);
      const baseSha = branchHeadSha(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) return mcpToolError('Head or base branch does not exist.');
      if (headSha === baseSha) return mcpToolError('No commits between head and base.');
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) return mcpToolError('A pull request already exists for this head branch.');
      }
      const number = ++repo.numberSeq;
      const now = isoNow();
      const pull: Pull = {
        id: nextObjectId++, number, title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
        headRef, baseRef, headSha, baseSha, userLogin: VIEWER.login, createdAt: now, updatedAt: now, seq: number,
      };
      repo.pulls.set(number, pull);
      return mcpToolResult(pullJson(repo, pull, req));
    }
    case 'merge_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Repository not found.');
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return mcpToolError('Pull request not found.');
      const result = doSquashMerge(repo, pull);
      if (!result.ok) return mcpToolError(result.reason);
      return mcpToolResult({ sha: result.sha, merged: true, message: 'Pull request successfully merged', pull_request: pullJson(repo, pull, req) });
    }
    default:
      return mcpToolError(`Unknown tool: ${name}`);
  }
}

function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end('{}\n');
    return true;
  }
  if (method !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!authOk(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return true;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    let id: unknown = null;
    const m = text.match(/"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/);
    if (m) {
      try {
        id = JSON.parse(m[1]!);
      } catch {
        id = null;
      }
    }
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
    res.end(`${JSON.stringify(mcpRpcError(id, -32700, 'Parse error'))}\n`);
    return true;
  }
  if (Array.isArray(json)) {
    sendJson(res, 400, mcpRpcError(null, -32600, 'Invalid Request: batch not supported'));
    return true;
  }
  if (!isRecord(json) || typeof json.method !== 'string') {
    sendJson(res, 400, mcpRpcError(isRecord(json) ? json.id : null, -32600, 'Invalid Request'));
    return true;
  }
  const id = json.id ?? null;
  const isNotification = json.id === undefined;
  const params = isRecord(json.params) ? json.params : {};
  const rpcMethod = json.method;

  if (isNotification) {
    // notifications/initialized and friends: no answer body needed.
    res.writeHead(202, { 'content-type': JSON_TYPE });
    res.end();
    return true;
  }

  if (rpcMethod === 'server/discover') {
    sendJson(res, 200, mcpRpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-forge', version: VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone-forge', version: VERSION } },
    }));
    return true;
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = supported.includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, mcpRpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-forge', version: VERSION },
    }));
    return true;
  }
  if (rpcMethod === 'ping') {
    sendJson(res, 200, mcpRpcResult(id, {}));
    return true;
  }
  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, mcpRpcResult(id, { tools: MCP_TOOLS }));
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!MCP_TOOLS.some((t) => t.name === toolName)) {
      sendJson(res, 200, mcpRpcError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    const result = mcpCallTool(toolName, args, req);
    sendJson(res, 200, mcpRpcResult(id, result));
    return true;
  }
  sendJson(res, 200, mcpRpcError(id, -32601, `Method not found: ${rpcMethod}`));
  return true;
}

// ---------------------------------------------------------------- git smart HTTP

const packCache = new Map<string, { pack: Buffer; shallow: string[] }>();

function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitAncestors(objects, tip).includes(ancestor);
}

/**
 * The child of `target` on a path from `from` down to `target` (null when `from` is the target
 * itself or does not reach it). Git's upload-pack ACKs this commit for a `have` — the first
 * commit after the client's have on the way to what it asked for — falling back to the have
 * itself when there is no such child.
 */
function childTowardTarget(objects: Map<string, GitObject>, from: string, target: string): string | null {
  if (from === target) return null;
  const stack: Array<{ oid: string; child: string }> = [{ oid: from, child: '' }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { oid, child } = stack.pop()!;
    if (oid === target) return child === '' ? null : child;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push({ oid: p, child: oid });
  }
  return null;
}

function collectPackObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  cut: Set<string> = new Set(),
): { objects: Array<{ type: ObjType; data: Buffer }>; shallow: string[] } {
  // Resolve wants: commits walk, annotated tags ride along and peel to their commit.
  const commitTips: string[] = [];
  const extraOids: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') commitTips.push(w);
    else if (obj.type === 'tag') {
      extraOids.push(w);
      const target = peelTagTarget(repo.objects, w);
      if (target !== w && repo.objects.get(target)?.type === 'commit') commitTips.push(target);
    }
  }
  let includedCommits: string[];
  let shallow: string[] = [];
  if (depth !== null) {
    const { included, shallow: sh } = depthLimitedCommits(repo.objects, commitTips, depth);
    includedCommits = [...included];
    shallow = sh;
  } else {
    const seen = new Set<string>();
    includedCommits = [];
    for (const w of commitTips) {
      for (const c of commitAncestors(repo.objects, w)) {
        if (!seen.has(c)) {
          seen.add(c);
          includedCommits.push(c);
        }
      }
    }
  }
  const excluded = reachableObjects(repo.objects, haves, [], cut);
  const out: Array<{ type: ObjType; data: Buffer }> = [];
  const seenObj = new Set<string>();
  const treeOids = new Set<string>();
  const blobOids = new Set<string>();
  for (const oid of extraOids) {
    if (excluded.has(oid) || seenObj.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seenObj.add(oid);
    out.push({ type: obj.type, data: obj.data });
  }
  for (const commitOid of includedCommits) {
    if (excluded.has(commitOid) || seenObj.has(commitOid)) continue;
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    seenObj.add(commitOid);
    out.push({ type: 'commit', data: obj.data });
    const flat = new Map<string, { mode: string; oid: string }>();
    flattenTree(repo.objects, parseCommit(obj.data).tree, '', flat);
    for (const v of flat.values()) blobOids.add(v.oid);
    // collect intermediate trees too
    const walkTrees = (treeOid: string): void => {
      if (treeOids.has(treeOid) || excluded.has(treeOid)) return;
      treeOids.add(treeOid);
      const tObj = repo.objects.get(treeOid);
      if (!tObj || tObj.type !== 'tree') return;
      for (const e of parseTree(tObj.data)) {
        if (e.mode === '40000') walkTrees(e.oid);
      }
    };
    walkTrees(parseCommit(obj.data).tree);
  }
  for (const oid of treeOids) {
    if (excluded.has(oid) || seenObj.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seenObj.add(oid);
    out.push({ type: 'tree', data: obj.data });
  }
  for (const oid of blobOids) {
    if (excluded.has(oid) || seenObj.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seenObj.add(oid);
    out.push({ type: 'blob', data: obj.data });
  }
  // Shallow boundaries are the depth cutoff commits, roots included (see depthLimitedCommits).
  if (depth !== null) {
    shallow = shallow.filter((oid) => {
      const obj = repo.objects.get(oid);
      return obj !== undefined && obj.type === 'commit';
    });
  }
  return { objects: out, shallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    packets.push(pktLine(payload));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow thin-pack no-progress ofs-delta\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status side-band-64k delete-refs agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]!.oid;
    parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      const obj = repo.objects.get(r.oid);
      if (service === 'git-upload-pack' && obj && obj.type === 'tag') {
        parts.push(pktLine(`${peelTagTarget(repo.objects, r.oid)} ${r.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (!m) return false;
  const owner = m[1]!;
  const repoName = m[2]!;
  const rest = m[3] ?? '';
  const method = req.method ?? 'GET';

  if (!authOk(req)) {
    errJson(res, 401, 'Bad credentials');
    return true;
  }
  const repo = findRepo(owner, repoName);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return true;
  }

  // GET info/refs
  if (method === 'GET' && rest === '/info/refs') {
    const service = queryOf(req).get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const ad = v2
        ? Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH, v2Advertisement()])
        : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, ad, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    errJson(res, 400, 'Invalid service');
    return true;
  }

  // POST git-upload-pack
  if (method === 'POST' && rest === '/git-upload-pack') {
    const body = await readBody(req);
    const { packets } = decodePktLines(body);
    const firstData = packets.find((p) => p.kind === 'data');
    const isV2 = firstData !== undefined && firstData.payload.toString('utf8').startsWith('command=');
    if (isV2) {
      await handleUploadPackV2(req, res, repo, packets);
      return true;
    }
    await handleUploadPackV0(req, res, repo, packets);
    return true;
  }

  // POST git-receive-pack
  if (method === 'POST' && rest === '/git-receive-pack') {
    const body = await readBody(req);
    await handleReceivePack(req, res, repo, body);
    return true;
  }

  errJson(res, 404, 'Not Found');
  return true;
}

async function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo, packets: Pkt[]): Promise<void> {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
    else if (p.kind === 'flush') break;
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
  const argsStart = lines.indexOf('');
  void argsStart;
  const delimIdx = packets.findIndex((p) => p.kind === 'delim');
  const argLines: string[] = [];
  for (let i = 0; i < packets.length; i += 1) {
    if (delimIdx >= 0 && i <= delimIdx) continue;
    const p = packets[i]!;
    if (p.kind === 'flush') break;
    if (p.kind === 'data') argLines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }

  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let wantPeel = false;
    let wantSymrefs = false;
    let wantUnborn = false;
    for (const line of argLines) {
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      else if (line === 'peel') wantPeel = true;
      else if (line === 'symrefs') wantSymrefs = true;
      else if (line === 'unborn') wantUnborn = true;
    }
    void wantPeel;
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const parts: Buffer[] = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (keep('HEAD')) {
      if (headTip) {
        parts.push(pktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      } else if (wantUnborn) {
        parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    }
    for (const r of sortedRefs(repo)) {
      if (!keep(r.name)) continue;
      const obj = repo.objects.get(r.oid);
      if (wantPeel && obj && obj.type === 'tag') {
        const peeled = peelTagTarget(repo.objects, r.oid);
        parts.push(pktLine(`${r.oid} ${r.name} peeled:${peeled}\n`));
      } else {
        parts.push(pktLine(`${r.oid} ${r.name}\n`));
      }
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    let done = false;
    for (const line of argLines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line === 'done') done = true;
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    // The want lines may carry capabilities after a space (v2 clients put them on the want line).
    const cleanWants = wants.map((w) => w.split(' ')[0]!);
    const parts: Buffer[] = [];
    // Acknowledgments section (verified against git's own upload-pack, --stateless-rpc):
    // - no haves, or the request ends with `done`: no ack section, packfile directly.
    // - haves and no `done`: ack section first. For each have the server knows, git ACKs the
    //   child of that have on the path toward the wants/refs (else the have itself); when no
    //   have is known it answers NAK + flush only and the client follows up with `done`.
    if (haves.length > 0 && !done) {
      const tips = new Set<string>();
      for (const w of cleanWants) {
        const obj = repo.objects.get(w);
        if (obj?.type === 'commit') tips.add(w);
        else if (obj?.type === 'tag') tips.add(peelTagTarget(repo.objects, w));
      }
      for (const r of sortedRefs(repo)) {
        const obj = repo.objects.get(r.oid);
        if (obj?.type === 'commit') tips.add(r.oid);
        else if (obj?.type === 'tag') tips.add(peelTagTarget(repo.objects, r.oid));
      }
      const acks: string[] = [];
      const seenAck = new Set<string>();
      for (const h of haves) {
        if (!repo.objects.has(h)) continue;
        let ack: string | null = null;
        for (const tip of tips) {
          ack = childTowardTarget(repo.objects, tip, h);
          if (ack !== null) break;
        }
        const line = ack ?? h;
        if (!seenAck.has(line)) { seenAck.add(line); acks.push(line); }
      }
      parts.push(pktLine('acknowledgments\n'));
      if (acks.length === 0) {
        parts.push(pktLine('NAK\n'));
        parts.push(PKT_FLUSH);
        sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
        return;
      }
      for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
      parts.push(pktLine('ready\n'));
      parts.push(PKT_DELIM);
    }
    // pack (cached when the request repeats)
    const cacheKey = `${repo.id}:${repo.version}:${cleanWants.join(',')}:${haves.join(',')}:${depth ?? ''}:${clientShallow.join(',')}`;
    let cached = packCache.get(cacheKey);
    if (!cached) {
      const { objects, shallow } = collectPackObjects(repo, cleanWants, haves, depth, new Set(clientShallow));
      const pack = writePack(objects);
      cached = { pack, shallow };
      if (packCache.size >= 64) {
        const oldest = packCache.keys().next().value;
        if (oldest !== undefined) packCache.delete(oldest);
      }
      packCache.set(cacheKey, cached);
    }
    // shallow-info: a client boundary is unshallowed when this fetch delivers its parents.
    const packCommitOids = new Set<string>();
    if (clientShallow.length > 0) {
      try {
        const parsed = parsePack(cached.pack);
        for (const [oid, obj] of parsed.objects) if (obj.type === 'commit') packCommitOids.add(oid);
      } catch {
        // pack parsing is best-effort here; unshallow just stays empty.
      }
    }
    const unshallow = clientShallow.filter((oid) => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') return false;
      return parseCommit(obj.data).parents.every((p) => packCommitOids.has(p));
    });
    if (cached.shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of cached.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(PKT_DELIM);
    }
    // packfile
    parts.push(pktLine('packfile\n'));
    for (const p of sidebandPackets(cached.pack)) parts.push(p);
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }

  errJson(res, 400, `Unknown upload-pack command: ${command}`);
}

async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo, packets: Pkt[]): Promise<void> {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line === 'done') break;
  }
  const parts: Buffer[] = [];
  const common = haves.filter((h) => wants.some((w) => isAncestor(repo.objects, h, w)));
  if (common.length > 0) {
    for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const { objects } = collectPackObjects(repo, wants, haves, depth, new Set(clientShallow));
  const pack = writePack(objects);
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { packets, rest } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  const reportLines: string[] = [];
  const sendReport = (): void => {
    // The report-status stream is itself pkt-lined inside band 1 (git's own receive-pack sends
    // one band-1 packet holding the inner pkt-lines plus an inner flush, then the outer flush).
    const inner: Buffer[] = [];
    for (const line of reportLines) inner.push(pktLine(`${line}\n`));
    inner.push(PKT_FLUSH);
    const innerBytes = Buffer.concat(inner);
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let off = 0; off < innerBytes.length; off += CHUNK) {
      const slice = innerBytes.subarray(off, Math.min(innerBytes.length, off + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  };
  try {
    if (rest.length > 0) {
      if (!verifyPackChecksum(rest)) throw new Error('pack checksum mismatch');
      const parsed = parsePack(rest);
      for (const [oid, obj] of parsed.objects) repo.objects.set(oid, obj);
      reportLines.push('unpack ok');
    } else {
      reportLines.push('unpack ok');
    }
  } catch (e) {
    reportLines.push(`unpack ${e instanceof Error ? e.message : 'failed'}`);
    sendReport();
    return;
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
      } else if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} object not found`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
    } else if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} remote ref is at a different commit`);
    } else if (!repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} object not found`);
    } else if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
    }
  }
  if (commands.length > 0) {
    repo.version += 1;
    repo.updatedAt = isoNow();
  }
  sendReport();
}

// ---------------------------------------------------------------- server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (await handleGit(req, res, path)) return;
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphQL(req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, path);
          return;
        }
        errJson(res, 404, 'Not Found');
      } catch (e) {
        try {
          errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
        } catch {
          // socket already gone
        }
      }
    })();
  });
}
