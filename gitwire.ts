// gitwire.ts — git smart HTTP: pkt-lines, packfiles, upload-pack v2/v0, receive-pack v0.
//
// The protocol surface the kit's git-client.ts speaks. Thick packs only (no deltas are ever
// generated); incoming packs may carry OFS/REF deltas and are resolved against the pack itself
// or the repo's store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  collectReachable,
  collectReachableCut,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  type GitObject,
  type Repo,
  type Store,
  ZERO_OID,
} from './store.ts';

export const PKT_LINE_MAX = 65520;

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  readonly kind: PacketKind;
  readonly payload: Buffer;
}

/** One pkt-line: 4 lowercase hex length (including the 4 prefix bytes) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(flushPkt());
    else if (line === 'delim') parts.push(delimPkt());
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from a buffer. Returns the packets and how many bytes they consumed; the
 * caller may have trailing raw bytes after them (a receive-pack's packfile). Throws on a
 * malformed line (bad hex, a length under 4, a truncated line).
 */
export function decodePktLines(buf: Buffer): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4) throw new Error(`pkt-line length ${len} is too short`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  if (offset < buf.length) throw new Error('trailing bytes are not a pkt-line');
  return { packets, consumed: offset };
}

/** The data lines of a pkt-line stream, as strings (flush/delim end a section). */
export function dataLines(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}

/**
 * Decode pkt-lines from the start of a buffer, stopping at the first bytes that are not a
 * pkt-line (a receive-pack's packfile follows its command lines as raw bytes). Returns the
 * packets and how many bytes they consumed.
 */
export function decodePktLinesPrefix(buf: Buffer): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return { packets, consumed: offset };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset]!;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out (the repo's store).
 * Throws on any corruption; the trailer checksum is verified.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObject['type'];
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObject['type']; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObject['type'];
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = entry.typeCode === 1 ? 'commit' : entry.typeCode === 2 ? 'tree' : entry.typeCode === 3 ? 'blob' : 'tag';
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

/** Wrap pack bytes in side-band-64k pkt-lines (band 1), each pkt-line at most PKT_LINE_MAX. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // pkt-line header + band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** The peeled commit a tag ref resolves to (following tag objects), or null. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    try {
      current = parseTag(object.data).object;
    } catch {
      return null;
    }
  }
}

/** All refs of a repo, sorted by name, with HEAD first (HEAD's oid is the default branch tip). */
export function listRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  refs.push({
    oid: mainTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: mainTip === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const ref: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) ref.peeled = peeled;
    }
    refs.push(ref);
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in deterministic (oid-sorted) order. */
  send: GitObject[];
  /** Commits the client already had that are ancestors of a want (ACK). */
  acks: string[];
  /** No common commit at all. */
  nak: boolean;
  /** New shallow boundaries (commits at the depth limit, plus old ones that stay shallow). */
  shallow: string[];
  /** Old shallow boundaries that are now fully included. */
  unshallow: string[];
}

/**
 * Compute what a fetch delivers. `wants` are commit/tag oids; `haves` are commits the client
 * holds; `oldShallow` are the client's current shallow boundaries; `depth` is a deepen limit
 * (want = depth 1). The walk never re-sends anything reachable from a have.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Depth-limited commit walk: want = depth 1, parents one deeper.
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  // Tag objects a want names (and their chain) travel with the fetch; a tag's ultimate target
  // is wanted like a commit (depth 1) or, for a tree/blob target, with its closure.
  const extra = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      let current = want;
      const seenTags = new Set<string>();
      while (true) {
        if (seenTags.has(current)) break;
        seenTags.add(current);
        const obj = lookup(current);
        if (!obj || obj.type !== 'tag') break;
        extra.add(current);
        let tag;
        try {
          tag = parseTag(obj.data);
        } catch {
          break;
        }
        current = tag.object;
      }
      const target = lookup(current);
      if (!target) continue;
      if (target.type === 'commit') queue.push({ oid: current, d: 1 });
      else for (const oid of collectReachable([current], lookup)) extra.add(oid);
      continue;
    }
    if (object.type === 'commit') queue.push({ oid: want, d: 1 });
  }
  while (queue.length > 0) {
    const { oid, d } = queue.pop()!;
    if (included.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    included.set(oid, d);
    if (depth === null || d < depth) {
      let commit;
      try {
        commit = parseCommit(object.data);
      } catch {
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, d: d + 1 });
    }
  }
  // Objects: each included commit plus its full tree closure (not its parents).
  const sendSet = new Set<string>();
  for (const oid of included.keys()) {
    const commit = lookup(oid);
    if (!commit) continue;
    sendSet.add(oid);
    let parsed;
    try {
      parsed = parseCommit(commit.data);
    } catch {
      continue;
    }
    for (const treeOid of collectReachable([parsed.tree], lookup)) sendSet.add(treeOid);
  }
  // Anything reachable from a have is already held: never re-send it. A have that is also a
  // shallow boundary is held without its history (its parents are not held).
  const haveClosure = collectReachableCut(haves, lookup, new Set(oldShallow));
  for (const oid of haveClosure) sendSet.delete(oid);
  for (const oid of extra) sendSet.add(oid);
  const send: GitObject[] = [];
  for (const oid of [...sendSet].sort()) {
    const object = lookup(oid);
    if (object) send.push(object);
  }
  // ACKs: haves that are ancestors of a want in the full (unlimited) graph.
  const fullClosure = collectReachable(wants, lookup);
  const acks: string[] = [];
  for (const have of haves) if (fullClosure.has(have)) acks.push(have);
  const nak = acks.length === 0;
  // Shallow boundaries.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of included) if (d === depth) shallow.push(oid);
  }
  for (const boundary of oldShallow) {
    if (included.has(boundary)) {
      if (!unshallow.includes(boundary)) unshallow.push(boundary);
    } else if (!shallow.includes(boundary)) {
      shallow.push(boundary);
    }
  }
  return { send, acks, nak, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// smart HTTP
// ---------------------------------------------------------------------------------------------

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResult(contentType: string, body: Buffer): GitReply {
  return { status: 200, contentType, body };
}

function json404(message: string): GitReply {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-upload-pack') {
    return 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main';
  }
  return 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main';
}

/** The v0 ref advertisement: `# service=...`, flush, then `<oid> <ref>` lines (+ `^{}` peels). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    return Buffer.concat(parts);
  }
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headLine = `${mainTip ?? ZERO_OID} HEAD\u0000${caps}\n`;
  parts.push(pktLine(headLine));
  for (const ref of refs) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: `version 2` + one capability per line, then flush. */
function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'ls-refs\n', 'fetch=shallow wait\n', 'object-format=sha1\n', 'flush']);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json404('Not Found');
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== store.viewerLogin) return json404('Not Found');
  if (service === 'git-receive-pack') {
    return gitResult(RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'));
  }
  if (gitProtocol === 'version=2') return gitResult(UPLOAD_AD, v2Advertisement());
  return gitResult(UPLOAD_AD, v0Advertisement(repo, 'git-upload-pack'));
}

function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const arg of args) if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  const refs = listRefs(repo);
  const lines: string[] = [];
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines as Array<string | 'flush'>);
}

function fetchV2Response(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktLine('ready\n'));
  parts.push(flushPkt());
  // shallow-info section
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(flushPkt());
  }
  // packfile section
  if (plan.send.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.send);
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
    parts.push(flushPkt());
  }
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | null): Buffer {
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== store.viewerLogin) return json404('Not Found');
  let packets: Packet[];
  try {
    packets = decodePktLines(body).packets;
  } catch (err) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`bad pkt-line: ${(err as Error).message}`, 'utf8') };
  }
  const lines = dataLines(packets).map((line) => line.replace(/\n$/, ''));
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    // Protocol v2.
    const command = first.slice('command='.length).trim();
    const args = lines.slice(1);
    if (command === 'ls-refs') return gitResult(UPLOAD_RESULT, lsRefsResponse(repo, args));
    if (command === 'fetch') return gitResult(UPLOAD_RESULT, fetchV2Response(repo, args));
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown v2 command ${JSON.stringify(command)}`, 'utf8') };
  }
  // Protocol v0: wants (with shallow/deepen) to a flush, then haves + done to a flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  if (wants.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('v0 fetch with no want', 'utf8') };
  }
  return gitResult(UPLOAD_RESULT, fetchV0Response(repo, wants, haves, shallow, depth));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Is `ancestor` reachable from `tip` (following parents)? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    let commit;
    try {
      commit = parseCommit(object.data);
    } catch {
      continue;
    }
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== store.viewerLogin) return json404('Not Found');
  let packets: Packet[];
  let consumed = 0;
  try {
    const decoded = decodePktLinesPrefix(body);
    packets = decoded.packets;
    consumed = decoded.consumed;
  } catch (err) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`bad pkt-line: ${(err as Error).message}`, 'utf8') };
  }
  // Command lines up to the first flush; the pack follows the flush as raw bytes.
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('receive-pack with no commands', 'utf8') };
  }
  // Unpack: the pack is the raw bytes after the command pkt-lines.
  const packBytes = body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message;
    }
  }
  // Apply the ref updates, one verdict per ref.
  const verdicts: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'invalid object id' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match the tip and the new tip must descend from it.
    if (!current || command.oldOid !== current) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!isAncestor(repo, current, command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  // report-status, pkt-lined inside band 1.
  const inner: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const verdict of verdicts) {
    inner.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
  }
  inner.push('flush');
  const report = encodePktLines(inner);
  const outer: Buffer[] = [];
  for (const chunk of sidebandPack(report)) outer.push(chunk);
  outer.push(flushPkt());
  return gitResult(RECEIVE_RESULT, Buffer.concat(outer));
}
