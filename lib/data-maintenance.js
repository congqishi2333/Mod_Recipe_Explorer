import fs from 'fs/promises';
import path from 'path';

const DEFAULTS = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxEntries: 30,
  maxTotalBytes: 512 * 1024 * 1024, // 512MB
};

const VERSION_DIR_RE = /^\d+(?:\.\d+){1,3}$/;

async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

async function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const st = await safeStat(p);
        if (st) total += st.size;
      }
    }
  }
  return total;
}

async function rmrf(target) {
  try { await fs.rm(target, { recursive: true, force: true }); return true; }
  catch { return false; }
}

function isAnalysisDir(name) {
  // analysis outputs are like 1795349805825-...
  return /^\d{6,}-/.test(name);
}

export async function pruneDataDir(dataDir, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const maxAgeMs = Math.max(0, Number(cfg.maxAgeMs) || 0);
  const maxEntries = Math.max(1, Number(cfg.maxEntries) || 1);
  const maxTotalBytes = Math.max(0, Number(cfg.maxTotalBytes) || 0);
  const protectNames = new Set(Array.isArray(cfg.protectNames) ? cfg.protectNames.filter(Boolean) : []);
  const now = Date.now();
  const result = { scanned: 0, removed: [], kept: 0, freedBytes: 0, errors: [] };

  let names;
  try { names = await fs.readdir(dataDir, { withFileTypes: true }); }
  catch (e) { result.errors.push(String(e?.message || e)); return result; }

  const candidates = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'uploads' || ent.name === 'vanilla-renders') continue;
    if (!isAnalysisDir(ent.name)) continue;
    const full = path.join(dataDir, ent.name);
    const st = await safeStat(full);
    const mtimeMs = st?.mtimeMs || 0;
    const sizeBytes = await dirSizeBytes(full);
    candidates.push({ name: ent.name, full, mtimeMs, sizeBytes });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  result.scanned = candidates.length;

  const keep = [];
  for (const c of candidates) {
    if (protectNames.has(c.name)) { keep.push(c); continue; }
    const tooOld = maxAgeMs > 0 && (now - c.mtimeMs) > maxAgeMs;
    if (tooOld) {
      if (await rmrf(c.full)) { result.removed.push({ name: c.name, reason: 'age', sizeBytes: c.sizeBytes }); result.freedBytes += c.sizeBytes; }
      else result.errors.push(`failed to remove ${c.name}`);
    } else {
      keep.push(c);
    }
  }

  // Enforce max entries (keep newest, but never remove protected)
  for (let i = keep.length - 1; i >= 0 && keep.length > maxEntries; i--) {
    const c = keep[i];
    if (protectNames.has(c.name)) continue;
    keep.splice(i, 1);
    if (await rmrf(c.full)) { result.removed.push({ name: c.name, reason: 'maxEntries', sizeBytes: c.sizeBytes }); result.freedBytes += c.sizeBytes; }
    else result.errors.push(`failed to remove ${c.name}`);
  }

  // Enforce total bytes (remove oldest unprotected first among kept)
  if (maxTotalBytes > 0) {
    let total = keep.reduce((s, c) => s + c.sizeBytes, 0);
    for (let i = keep.length - 1; i >= 0 && total > maxTotalBytes && keep.length > 1; i--) {
      const c = keep[i];
      if (protectNames.has(c.name)) continue;
      keep.splice(i, 1);
      if (await rmrf(c.full)) {
        result.removed.push({ name: c.name, reason: 'maxTotalBytes', sizeBytes: c.sizeBytes });
        result.freedBytes += c.sizeBytes;
        total -= c.sizeBytes;
      } else {
        result.errors.push(`failed to remove ${c.name}`);
      }
    }
  }

  result.kept = keep.length;
  return result;
}

export async function pruneUploadsDir(uploadDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const result = { removed: 0, freedBytes: 0 };
  let entries;
  try { entries = await fs.readdir(uploadDir, { withFileTypes: true }); } catch { return result; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(uploadDir, e.name);
    const st = await safeStat(full);
    if (!st) continue;
    if (maxAgeMs > 0 && (now - st.mtimeMs) <= maxAgeMs) continue;
    const size = st.size || 0;
    try { await fs.unlink(full); result.removed++; result.freedBytes += size; } catch {}
  }
  return result;
}

export async function pruneVanillaRendersDir(vanillaRendersRoot, opts = {}) {
  const maxAgeMs = Math.max(0, Number(opts.maxAgeMs) || 30 * 24 * 60 * 60 * 1000);
  const maxEntries = Math.max(1, Number(opts.maxEntries) || 8);
  const maxTotalBytes = Math.max(0, Number(opts.maxTotalBytes) || 1024 * 1024 * 1024);
  const protectVersions = new Set(Array.isArray(opts.protectVersions) ? opts.protectVersions.filter(Boolean) : []);
  const now = Date.now();
  const result = { scanned: 0, removed: [], kept: 0, freedBytes: 0, errors: [] };
  let entries;
  try { entries = await fs.readdir(vanillaRendersRoot, { withFileTypes: true }); } catch (e) { result.errors.push(String(e?.message || e)); return result; }

  const versions = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Skip temp dirs and suspicious names; only manage normalized version dirs.
    if (e.name.startsWith('.tmp-')) continue;
    if (!VERSION_DIR_RE.test(e.name)) continue;
    const full = path.join(vanillaRendersRoot, e.name);
    const st = await safeStat(full);
    const sizeBytes = await dirSizeBytes(full);
    versions.push({ name: e.name, full, mtimeMs: st?.mtimeMs || 0, sizeBytes });
  }
  versions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  result.scanned = versions.length;

  const keep = [];
  for (const v of versions) {
    if (protectVersions.has(v.name)) { keep.push(v); continue; }
    const tooOld = maxAgeMs > 0 && (now - v.mtimeMs) > maxAgeMs;
    if (tooOld) {
      if (await rmrf(v.full)) { result.removed.push({ name: v.name, reason: 'age', sizeBytes: v.sizeBytes }); result.freedBytes += v.sizeBytes; }
      else result.errors.push(`failed to remove ${v.name}`);
    } else keep.push(v);
  }

  for (let i = keep.length - 1; i >= 0 && keep.length > maxEntries; i--) {
    const v = keep[i];
    if (protectVersions.has(v.name)) continue;
    keep.splice(i, 1);
    if (await rmrf(v.full)) { result.removed.push({ name: v.name, reason: 'maxEntries', sizeBytes: v.sizeBytes }); result.freedBytes += v.sizeBytes; }
    else result.errors.push(`failed to remove ${v.name}`);
  }

  if (maxTotalBytes > 0) {
    let total = keep.reduce((s, c) => s + c.sizeBytes, 0);
    for (let i = keep.length - 1; i >= 0 && total > maxTotalBytes && keep.length > 1; i--) {
      const v = keep[i];
      if (protectVersions.has(v.name)) continue;
      keep.splice(i, 1);
      if (await rmrf(v.full)) {
        result.removed.push({ name: v.name, reason: 'maxTotalBytes', sizeBytes: v.sizeBytes });
        result.freedBytes += v.sizeBytes;
        total -= v.sizeBytes;
      } else result.errors.push(`failed to remove ${v.name}`);
    }
  }
  result.kept = keep.length;
  return result;
}

// Best-effort stats for observability; does not mutate.
export async function getVanillaRendersStats(vanillaRendersRoot) {
  const out = { root: vanillaRendersRoot, versionCount: 0, totalBytes: 0, items: [] };
  let entries;
  try { entries = await fs.readdir(vanillaRendersRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.tmp-') || !VERSION_DIR_RE.test(e.name)) continue;
    const full = path.join(vanillaRendersRoot, e.name);
    const st = await safeStat(full);
    const sizeBytes = await dirSizeBytes(full);
    out.items.push({ version: e.name, sizeBytes, mtimeMs: st?.mtimeMs || 0 });
    out.totalBytes += sizeBytes;
  }
  out.items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  out.versionCount = out.items.length;
  return out;
}
