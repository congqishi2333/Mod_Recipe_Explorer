import path from 'path';
import { getJson, getText, parseNamespaced } from './zip.js';

// 「命名空间 → 模组」注册表。
//
// Minecraft 的物品/配方 id 都是 <namespace>:<name>，namespace 基本对应「归哪个 mod」。
// 把本次分析所有 jar 的命名空间收集成一张表后，配方里出现的 id 可三类归档：
//   vanilla   —— minecraft:，原版，正常
//   internal  —— 本次上传的某个 mod 声明的命名空间，内部引用，能解析
//   external  —— 表里没有，是外部依赖，单独归类，不算解析失败
//
// 这是与 parseQuality（配方数据可疑）独立的维度：外部依赖是合理的跨模组引用，
// 绝不进 suspicious，否则会把「没上传依赖 jar」误判成「配方解析失败」。

const VANILLA_NS = 'minecraft';

function tomlField(body, key) {
  const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return m ? m[1].trim() : null;
}

// Forge / NeoForge: [[mods]] 块里的 modId / displayName。
function parseModsToml(text) {
  if (!text) return [];
  const out = [];
  // 按 [[ 表头切分，只认 mods]] 段，避免把 [[dependencies...]] 的属性误读成 mod 信息。
  for (const sec of text.split(/^\s*\[\[/m)) {
    if (!/^mods\]\]/i.test(sec.trim())) continue;
    const body = sec.replace(/^mods\]\]\s*/i, '');
    const modId = tomlField(body, 'modId') || tomlField(body, 'modid');
    const displayName = tomlField(body, 'displayName') || tomlField(body, 'name');
    if (modId) out.push({ modId, modName: displayName || modId });
  }
  return out;
}

// 老 Forge: mcmod.info 是 [{ modid, name }]。
function parseMcmodInfo(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const m of json) {
    if (m?.modid) out.push({ modId: String(m.modid), modName: m.name || String(m.modid) });
  }
  return out;
}

function readModMetadata(entries) {
  const mods = [];

  // Fabric: 根 fabric.mod.json。schemaVersion/id/name 三个字段够用。
  const fabric = getJson(entries, 'fabric.mod.json');
  if (fabric?.id) mods.push({ modId: String(fabric.id), modName: fabric.name || String(fabric.id) });

  // NeoForge / Forge（两种文件名都认）。
  for (const p of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    for (const m of parseModsToml(getText(entries, p))) mods.push(m);
  }

  for (const m of parseMcmodInfo(getJson(entries, 'mcmod.info'))) mods.push(m);

  return mods;
}

/**
 * 从所有待分析 jar 建立「命名空间 → 模组」注册表。
 * @param {Array<{ jarPath: string, entries: Map }>} jars
 * @returns {Map<string, {namespace:string, modName:string, modId:string, sourceJars:string[], specific:boolean}>}
 */
export function buildNamespaceRegistry(jars) {
  const registry = new Map();

  for (const { jarPath, entries } of jars) {
    const label = path.basename(jarPath || 'unknown.jar');
    const mods = readModMetadata(entries);
    const byModId = new Map(mods.map(m => [m.modId, m]));
    const namespaces = new Set();

    for (const p of entries.keys()) {
      const m = p.match(/^(?:assets|data)\/([^/]+)\//);
      if (m) namespaces.add(m[1]);
    }
    // 元数据声明的 modId 也算命名空间，即使该 jar 没有对应资源路径。
    for (const m of mods) namespaces.add(m.modId);

    for (const ns of namespaces) {
      const mod = byModId.get(ns) || (mods.length === 1 ? mods[0] : null);
      const specific = !!(mod && mod.modId === ns);
      const existing = registry.get(ns);
      if (existing) {
        if (!existing.sourceJars.includes(label)) existing.sourceJars.push(label);
        // 更具体的匹配（modId 恰好等于命名空间）优先于「该 jar 只有一个 mod」的猜测。
        if (specific && !existing.specific) {
          existing.modName = mod.modName;
          existing.modId = mod.modId;
          existing.specific = true;
        }
      } else {
        registry.set(ns, {
          namespace: ns,
          modName: mod?.modName || ns,
          modId: mod?.modId || ns,
          sourceJars: [label],
          specific,
        });
      }
    }
  }

  return registry;
}

/** 把一个物品/标签 id 归档为 vanilla / internal / external。 */
export function classifyId(id, registry) {
  const p = parseNamespaced(id);
  if (!p) return { kind: 'external', namespace: null, modName: null, id };
  const ns = p.ns;
  if (ns === VANILLA_NS) return { kind: 'vanilla', namespace: ns, modName: 'Minecraft', id };
  const info = registry?.get(ns);
  if (info) return { kind: 'internal', namespace: ns, modName: info.modName, id };
  return { kind: 'external', namespace: ns, modName: null, id };
}

/** 收集一条配方里所有 id 并按 vanilla/internal/external 去重归档。 */
export function collectDependencyRefs(grid, ingredients, result, registry) {
  const byKind = { internal: new Set(), external: new Set(), vanilla: new Set() };
  const add = (id) => {
    if (!id || typeof id !== 'string') return;
    byKind[classifyId(id, registry).kind].add(id);
  };
  const walk = (ing) => {
    if (!ing) return;
    add(ing.id);
    if (Array.isArray(ing.options)) ing.options.forEach(walk);
  };
  for (const row of (Array.isArray(grid) ? grid : [])) {
    if (Array.isArray(row)) row.forEach(walk);
  }
  (Array.isArray(ingredients) ? ingredients : []).forEach(walk);
  add(result?.id);
  return {
    internal: [...byKind.internal],
    external: [...byKind.external],
    vanilla: [...byKind.vanilla],
  };
}

/** 合并变体配方的依赖归类（各变体的外部依赖都要保留）。 */
export function mergeDependencyRefs(list) {
  const acc = { internal: new Set(), external: new Set(), vanilla: new Set() };
  for (const r of list || []) {
    for (const kind of ['internal', 'external', 'vanilla']) {
      for (const id of r?.dependencyRefs?.[kind] || []) acc[kind].add(id);
    }
  }
  return {
    internal: [...acc.internal],
    external: [...acc.external],
    vanilla: [...acc.vanilla],
  };
}

/** 汇总所有配方的依赖归类，供 summary 与 UI 消费。 */
export function summarizeDependencies(analyzed, registry) {
  const byNs = new Map();
  let vanillaRefs = 0, internalRefs = 0, externalRefs = 0;
  const bump = (kind) => {
    if (kind === 'vanilla') vanillaRefs++;
    else if (kind === 'internal') internalRefs++;
    else externalRefs++;
  };

  for (const r of analyzed) {
    for (const kind of ['vanilla', 'internal', 'external']) {
      for (const id of r.dependencyRefs?.[kind] || []) {
        bump(kind);
        const ns = parseNamespaced(id)?.ns || VANILLA_NS;
        const info = registry?.get(ns);
        const entry = byNs.get(ns) || {
          namespace: ns,
          kind,
          modName: kind === 'vanilla' ? 'Minecraft' : (info?.modName || null),
          refs: 0,
          examples: new Set(),
        };
        entry.refs++;
        if (entry.examples.size < 8) entry.examples.add(id);
        byNs.set(ns, entry);
      }
    }
  }

  const namespaces = [...byNs.values()]
    .map(e => ({ ...e, examples: [...e.examples] }))
    .sort((a, b) => b.refs - a.refs || a.namespace.localeCompare(b.namespace));

  return {
    vanillaRefs,
    internalRefs,
    externalRefs,
    internalNamespaces: namespaces.filter(n => n.kind === 'internal').length,
    externalNamespaces: namespaces.filter(n => n.kind === 'external'),
    // 完整的命名空间 → 模组表，UI 可展示「本次识别到的 mod」。
    registry: [...(registry?.entries() || [])].map(([ns, info]) => ({
      namespace: ns,
      modName: info.modName,
      modId: info.modId,
      sourceJars: info.sourceJars,
      specific: info.specific,
    })),
  };
}
