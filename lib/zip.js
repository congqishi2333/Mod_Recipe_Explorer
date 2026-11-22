import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const TEXTURE_EXT = '.png';

export function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function readZipEntries(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const map = new Map();
  for (const e of entries) {
    const p = e.entryName.replace(/\\/g, '/');
    map.set(p, e);
  }
  return { zip, entries: map };
}

export function getJson(entries, p) {
  const e = entries.get(p);
  if (!e) return null;
  try { return JSON.parse(e.getData().toString('utf8')); } catch { return null; }
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
