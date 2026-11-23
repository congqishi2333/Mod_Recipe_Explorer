import fs from 'fs';
import path from 'path';
import os from 'os';
import { readZipIndex } from './zip.js';

const VANILLA_CACHE_MAX = Math.max(1, Number(process.env.VANILLA_CACHE_MAX) || 2);
const vanillaCache = new Map(); // jarPath -> loaded vanilla assets

function cacheGet(key) {
  if (!vanillaCache.has(key)) return null;
  const v = vanillaCache.get(key);
  vanillaCache.delete(key);
  vanillaCache.set(key, v); // LRU refresh
  return v;
}

function cacheSet(key, value) {
  if (vanillaCache.has(key)) vanillaCache.delete(key);
  vanillaCache.set(key, value);
  while (vanillaCache.size > VANILLA_CACHE_MAX) {
    const oldest = vanillaCache.keys().next().value;
    vanillaCache.delete(oldest);
  }
}

export function clearVanillaCache() {
  vanillaCache.clear();
}

function hasAssets(jarPath) {
  try {
    for (const p of readZipIndex(jarPath).entries.keys()) {
      if (p.startsWith('assets/minecraft/textures/')) return true;
    }
    return false;
  } catch { return false; }
}

export function findVanillaJar(version = '1.21.1') {
  const envPath = process.env.VANILLA_JAR || process.env.MINECRAFT_JAR;
  const home = os.homedir();
  const app = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [
    envPath,
    path.join(app, '.minecraft', 'versions', version, `${version}.jar`),
    path.join(home, '.minecraft', 'versions', version, `${version}.jar`),
    path.join(app, 'minecraft-dev-mcp', 'jars', `minecraft_client.${version}.jar`),
    path.join(app, 'minecraft-dev-mcp', 'remapped', `${version}-mojmap.jar`),
    path.join(app, '.minecraft', 'libraries', 'net', 'minecraft', 'client', version, `client-${version}-official.jar`),
    path.join(app, '.minecraft', 'libraries', 'com', 'mojang', 'minecraft', version, `minecraft-${version}-client.jar`),
    path.join(app, 'PrismLauncher', 'libraries', 'com', 'mojang', 'minecraft', version, `minecraft-${version}-client.jar`),
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p) && hasAssets(p)) return p; } catch {}
  }

  // broader scan under .minecraft/libraries/net/minecraft/client/<version>*
  const libDir = path.join(app, '.minecraft', 'libraries', 'net', 'minecraft', 'client');
  try {
    if (fs.existsSync(libDir)) {
      for (const d of fs.readdirSync(libDir)) {
        if (!d.startsWith(version)) continue;
        const full = path.join(libDir, d);
        for (const f of fs.readdirSync(full)) {
          if (f.endsWith('.jar')) {
            const p = path.join(full, f);
            if (hasAssets(p)) return p;
          }
        }
      }
    }
  } catch {}

  // last resort: any existing candidate
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

export function loadVanillaAssets(version = '1.21.1', explicitPath = null) {
  const jarPath = explicitPath || findVanillaJar(version);
  if (!jarPath) return { ok: false, jarPath: null, entries: null, langs: {} };
  const hit = cacheGet(jarPath);
  if (hit) return hit;

  try {
    const entries = readZipIndex(jarPath).entries;
    const langs = {};
    for (const [p, e] of entries) {
      const m = p.match(/^assets\/minecraft\/lang\/([a-z_]+)\.json$/);
      if (!m) continue;
      try {
        langs[m[1]] = JSON.parse(e.getData().toString('utf8'), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v);
      } catch {}
    }
    const loaded = { ok: true, jarPath, entries, langs };
    cacheSet(jarPath, loaded);
    return loaded;
  } catch (e) {
    return { ok: false, jarPath, entries: null, langs: {}, error: String(e?.message || e) };
  }
}

export function getVanillaJson(vanilla, p) {
  const e = vanilla?.entries?.get(p);
  if (!e) return null;
  try { return JSON.parse(e.getData().toString('utf8'), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v); } catch { return null; }
}

export function hasVanillaEntry(vanilla, p) {
  return !!vanilla?.entries?.get(p);
}
