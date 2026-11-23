import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const TEXTURE_EXT = '.png';
const MAX_ENTRY_OUTPUT = 128 * 1024 * 1024; // 防 zip bomb：单条目解压上限 128 MiB

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function findEocd(fd, fileSize) {
  const tailLen = Math.min(fileSize, 0xffff + 22);
  const tail = Buffer.allocUnsafe(tailLen);
  fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen);
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return fileSize - tailLen + i;
  }
  throw new Error('Invalid zip: end-of-central-directory not found');
}

function readZip64Extra(extra, comp, uncomp, offset) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    const data = extra.subarray(p + 4, p + 4 + size);
    if (id === 0x0001) {
      let q = 0;
      const out = {};
      if (uncomp === 0xffffffff) { out.uncomp = Number(data.readBigUInt64LE(q)); q += 8; }
      if (comp === 0xffffffff) { out.comp = Number(data.readBigUInt64LE(q)); q += 8; }
      if (offset === 0xffffffff) { out.offset = Number(data.readBigUInt64LE(q)); q += 8; }
      return out;
    }
    p += 4 + size;
  }
  return {};
}

function readEntryAt(zipPath, meta) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const local = Buffer.alloc(30);
    const n = fs.readSync(fd, local, 0, 30, meta.offset);
    if (n < 30 || local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Invalid local header: ${meta.name}`);
    const flags = local.readUInt16LE(6);
    if (flags & 0x1) throw new Error(`Encrypted zip entry is unsupported: ${meta.name}`);
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const dataOffset = meta.offset + 30 + nameLen + extraLen;
    if (meta.comp < 0 || dataOffset + meta.comp > fileSize) {
      throw new Error(`Declared compressed size exceeds archive: ${meta.name}`);
    }
    if (meta.uncomp > MAX_ENTRY_OUTPUT) throw new Error(`Zip entry too large: ${meta.name}`);

    const compressed = Buffer.allocUnsafe(meta.comp);
    let read = 0;
    while (read < compressed.length) {
      const r = fs.readSync(fd, compressed, read, compressed.length - read, dataOffset + read);
      if (!r) throw new Error(`Unexpected EOF: ${meta.name}`);
      read += r;
    }
    if (meta.method === 0) {
      if (compressed.length > MAX_ENTRY_OUTPUT) throw new Error(`Zip entry expands beyond limit: ${meta.name}`);
      return compressed;
    }
    if (meta.method === 8) return zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_OUTPUT });
    throw new Error(`Unsupported zip compression method ${meta.method}: ${meta.name}`);
  } finally {
    fs.closeSync(fd);
  }
}

function makeEntry(zipPath, meta, budget = null) {
  let cached = null;
  let counted = false;
  return {
    entryName: meta.name,
    isDirectory: false,
    getData() {
      if (cached) return cached;
      if (meta.uncomp > MAX_ENTRY_OUTPUT) throw new Error(`Zip entry too large: ${meta.name}`);
      if (budget && budget.totalInflated + meta.uncomp > budget.maxTotalInflated) {
        throw new Error(`Zip inflation budget exceeded: ${meta.name}`);
      }
      cached = readEntryAt(zipPath, meta);
      if (cached.length > MAX_ENTRY_OUTPUT) {
        cached = null;
        throw new Error(`Zip entry expands beyond limit: ${meta.name}`);
      }
      if (budget && !counted) {
        if (budget.totalInflated + cached.length > budget.maxTotalInflated) {
          cached = null;
          throw new Error(`Zip inflation budget exceeded: ${meta.name}`);
        }
        budget.totalInflated += cached.length;
        counted = true;
      }
      return cached;
    },
  };
}

// 只解析中央目录，getData() 时再按偏移读单个条目；不再把整个 jar 的条目数据
// 常驻内存。原 adm-zip 全量索引在 vanilla jar + 大 mod jar 下会占用 GB 级内存。
const DEFAULT_MAX_TOTAL_INFLATED = 512 * 1024 * 1024; // per zip index

export function readZipIndex(zipPath, options = {}) {
  const maxTotalInflated = Number.isFinite(options.maxTotalInflated) ? options.maxTotalInflated : DEFAULT_MAX_TOTAL_INFLATED;
  const budget = options.budget && typeof options.budget === 'object'
    ? options.budget
    : { maxTotalInflated, totalInflated: 0 };
  if (!Number.isFinite(budget.maxTotalInflated)) budget.maxTotalInflated = maxTotalInflated;
  if (!Number.isFinite(budget.totalInflated)) budget.totalInflated = 0;
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const eocd = findEocd(fd, fileSize);
    const head = Buffer.alloc(22);
    fs.readSync(fd, head, 0, 22, eocd);
    let total = head.readUInt16LE(10);
    let cdSize = head.readUInt32LE(12);
    let cdOffset = head.readUInt32LE(16);

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (eocd >= 20) {
        const locator = Buffer.alloc(20);
        fs.readSync(fd, locator, 0, 20, eocd - 20);
        if (locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
          const z64Offset = Number(locator.readBigUInt64LE(8));
          const z64 = Buffer.alloc(56);
          fs.readSync(fd, z64, 0, 56, z64Offset);
          if (z64.readUInt32LE(0) === SIG_ZIP64_EOCD) {
            total = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
          }
        }
      }
    }

    // 兼容前面带自解压 stub 的 zip：EOCD 记录的偏移相对归档起点
    let delta = eocd - cdSize - cdOffset;
    if (delta < 0) delta = 0;
    if (cdSize < 0 || cdSize > fileSize) throw new Error('Invalid central directory size');
    const cd = Buffer.allocUnsafe(cdSize);
    let cdRead = 0;
    while (cdRead < cd.length) {
      const r = fs.readSync(fd, cd, cdRead, cd.length - cdRead, cdOffset + delta + cdRead);
      if (!r) throw new Error('Unexpected EOF reading central directory');
      cdRead += r;
    }

    const entries = new Map();
    let pos = 0;
    for (let i = 0; i < total; i++) {
      if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== SIG_CENTRAL) break;
      const method = cd.readUInt16LE(pos + 10);
      let comp = cd.readUInt32LE(pos + 20);
      let uncomp = cd.readUInt32LE(pos + 24);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      let offset = cd.readUInt32LE(pos + 42);
      const extra = cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
      if (comp === 0xffffffff || uncomp === 0xffffffff || offset === 0xffffffff) {
        const z = readZip64Extra(extra, comp, uncomp, offset);
        comp = z.comp ?? comp;
        uncomp = z.uncomp ?? uncomp;
        offset = z.offset ?? offset;
      }
      const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
      if (name && !name.endsWith('/')) {
        entries.set(name, makeEntry(zipPath, { name, method, comp, uncomp, offset }, budget));
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return { entries };
  } finally {
    fs.closeSync(fd);
  }
}

export function readZipEntries(zipPath, options = {}) {
  return readZipIndex(zipPath, options);
}

const BAD_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function jsonReviver(key, value) {
  if (BAD_JSON_KEYS.has(key)) return undefined;
  return value;
}

export function classifyZipError(e) {
  const msg = String(e?.message || e || '');
  if (/Encrypted zip entry/i.test(msg)) return 'encrypted';
  if (/Unsupported zip compression/i.test(msg)) return 'unsupported-compression';
  if (/Zip entry too large|expands beyond limit|inflation budget exceeded/i.test(msg)) return 'size-limit';
  if (/Invalid local header|Declared compressed size|Unexpected EOF|Invalid zip|central directory/i.test(msg)) return 'corrupt-zip';
  return 'read-error';
}

export function getJsonResult(entries, p) {
  const e = entries.get(p);
  if (!e) return { ok: false, code: 'missing', error: 'missing' };
  let raw;
  try {
    raw = e.getData().toString('utf8');
  } catch (err) {
    return { ok: false, code: classifyZipError(err), error: String(err?.message || err) };
  }
  try {
    return { ok: true, value: JSON.parse(raw, jsonReviver) };
  } catch (err) {
    return { ok: false, code: 'invalid-json', error: String(err?.message || err) };
  }
}

export function getJson(entries, p) {
  const r = getJsonResult(entries, p);
  if (r.ok) return r.value;
  // Fatal zip/resource errors should not be silently swallowed; callers that want
  // per-file diagnostics should use getJsonResult().
  if (r.code && r.code !== 'invalid-json' && r.code !== 'missing') {
    const err = new Error(r.error || r.code);
    err.code = r.code;
    throw err;
  }
  return null;
}

export function getText(entries, p) {
  const e = entries.get(p);
  if (!e) return null;
  try { return e.getData().toString('utf8'); } catch { return null; }
}

export function listByPrefix(entries, prefix) {
  const out = [];
  for (const k of entries.keys()) {
    if (k.startsWith(prefix)) out.push(k);
  }
  return out;
}

export function listJsonUnder(entries, roots) {
  const out = [];
  for (const k of entries.keys()) {
    if (!k.endsWith('.json')) continue;
    if (roots.some(r => k.startsWith(r))) out.push(k);
  }
  return out.sort();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function extractTexture(entries, texturePath, outDir, fileBase) {
  return extractTextureFromSources(entries, null, texturePath, outDir, fileBase);
}

export function extractTextureFromSources(entries, vanillaEntries, texturePath, outDir, fileBase) {
  const norm = normalizeTexturePath(texturePath);
  if (!norm) return null;
  let entry = entries.get(norm);
  if (!entry && vanillaEntries) entry = vanillaEntries.get(norm);
  if (!entry) return null;
  ensureDir(outDir);
  const outName = safeName(fileBase) + TEXTURE_EXT;
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, entry.getData());
  return outName;
}

export function normalizeTexturePath(texturePath) {
  if (!texturePath || typeof texturePath !== 'string') return null;
  let p = texturePath.trim();
  if (p.includes(':')) {
    const [ns, rest] = p.split(':');
    p = `assets/${ns}/textures/${rest}`;
  } else if (p.startsWith('assets/')) {
    // already fine
  } else {
    p = `assets/minecraft/textures/${p}`;
  }
  if (!p.endsWith('.png')) p += '.png';
  return p.replace(/\\/g, '/');
}

export function parseNamespaced(id, fallbackNs = 'minecraft') {
  if (!id || typeof id !== 'string') return null;
  if (id.startsWith('#')) {
    const raw = id.slice(1);
    if (raw.includes(':')) {
      const [ns, p] = raw.split(':');
      return { tag: true, ns: ns || fallbackNs, path: p };
    }
    return { tag: true, ns: fallbackNs, path: raw.toLowerCase() };
  }
  if (id.includes(':')) {
    const [ns, p] = id.split(':');
    return { tag: false, ns, path: p.trim().replace(/\s+/g, '_').toLowerCase() };
  }
  // Unnamespaced: normalize common mod-export quirks like "Glass" -> "glass"
  const norm = id.trim().replace(/\s+/g, '_').toLowerCase();
  return { tag: false, ns: fallbackNs, path: norm };
}

export function idToLangKeys(id) {
  const p = parseNamespaced(id);
  if (!p) return [];
  const base = `${p.ns}.${p.path}`;
  return [
    `item.${base}`,
    `block.${base}`,
    `entity.${base}`,
    base,
  ];
}
