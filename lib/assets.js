import { getJson, parseNamespaced } from './zip.js';
import { getVanillaJson } from './vanilla.js';

export function buildAssetIndex(entries, vanilla = null) {
  const langs = {}; // ns -> {key:value}
  const itemModels = new Map(); // "ns:path" -> json
  const blockstates = new Set();
  const tags = { item: new Map(), block: new Map() }; // "ns:path" -> [defs]

  function addTag(kind, ns, name, json) {
    const key = `${ns}:${name}`;
    const arr = tags[kind].get(key) || [];
    arr.push(json);
    tags[kind].set(key, arr);
  }

  for (const p of entries.keys()) {
    let m;
    if ((m = p.match(/^assets\/([^/]+)\/lang\/([a-z_]+)\.json$/))) {
      const ns = m[1], lang = m[2];
      const json = getJson(entries, p);
      if (json && typeof json === 'object') {
        langs[ns] ??= {};
        langs[ns][lang] ??= {};
        Object.assign(langs[ns][lang], json);
      }
    } else if ((m = p.match(/^assets\/([^/]+)\/models\/item\/(.+)\.json$/))) {
      const ns = m[1], name = m[2];
      const json = getJson(entries, p);
      if (json) itemModels.set(`${ns}:${name}`, { path: p, json, source: 'mod' });
    } else if ((m = p.match(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/))) {
      blockstates.add(`${m[1]}:${m[2]}`);
    } else if ((m = p.match(/^data\/([^/]+)\/tags\/(item|block)\/(.+)\.json$/))) {
      const json = getJson(entries, p);
      if (json) addTag(m[2], m[1], m[3], json);
    }
  }

  if (vanilla?.langs) {
    langs.minecraft ??= {};
    for (const [lang, dict] of Object.entries(vanilla.langs)) {
      langs.minecraft[lang] = { ...(dict || {}), ...(langs.minecraft[lang] || {}) };
    }
  }
  if (vanilla?.entries) {
    for (const [p, e] of vanilla.entries) {
      const m = p.match(/^data\/([^/]+)\/tags\/(item|block)\/(.+)\.json$/);
      if (!m) continue;
      try {
        const json = JSON.parse(e.getData().toString('utf8'));
        if (json) addTag(m[2], m[1], m[3], json);
      } catch {}
    }
  }

  return { langs, itemModels, blockstates, tags, vanillaEntries: vanilla?.entries || null };
}

function resolveLang(langs, id) {
  const p = parseNamespaced(id);
  if (!p) return null;
  const ns = p.ns;
  const keys = [`item.${ns}.${p.path}`, `block.${ns}.${p.path}`, `entity.${ns}.${p.path}`];
  const langOrder = ['zh_cn', 'en_us'];
  for (const lang of langOrder) {
    const dict = langs?.[ns]?.[lang];
    if (!dict) continue;
    for (const k of keys) if (dict[k]) return dict[k];
  }
  for (const dict of Object.values(langs?.[ns] || {})) {
    for (const k of keys) if (dict[k]) return dict[k];
  }
  return null;
}

export function resolveItemName(langs, id) {
  return resolveLang(langs, id) || prettifyId(id);
}

export function prettifyId(id) {
  const p = parseNamespaced(id);
  const s = (p ? p.path : String(id)).split('/').pop();
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getModelJsonByPath(modelPath, entries, vanilla, cache) {
  if (cache.has(modelPath)) return cache.get(modelPath);
  const json = getJson(entries, modelPath) || getVanillaJson(vanilla, modelPath);
  cache.set(modelPath, json);
  return json;
}

function resolveModelRef(ref, fallbackNs) {
  if (!ref || typeof ref !== 'string') return null;
  let ns = fallbackNs, p = ref;
  if (ref.includes(':')) [ns, p] = ref.split(':');
  if (!p.startsWith('block/') && !p.startsWith('item/') && !p.startsWith('builtin/')) {
    // could be either; caller should handle
  }
  return { ns, path: p, modelPath: `assets/${ns}/models/${p}.json` };
}

function mergeModel(parent, child) {
  // child overrides parent; elements: child replaces if present
  const merged = {
    ...parent,
    ...child,
    textures: { ...(parent.textures || {}), ...(child.textures || {}) },
    display: { ...(parent.display || {}), ...(child.display || {}) },
  };
  if (child.elements) merged.elements = child.elements;
  else if (parent.elements) merged.elements = parent.elements;
  if (child.texture_size) merged.texture_size = child.texture_size;
  else if (parent.texture_size) merged.texture_size = parent.texture_size;
  if (child.gui_light !== undefined) merged.gui_light = child.gui_light;
  if (child.parent === undefined) delete merged.parent;
  return merged;
}

export function resolveFullModel(itemId, assetIndex, entries, vanilla, modelCache = new Map()) {
  const p = parseNamespaced(itemId);
  if (!p) return null;
  const key = `${p.ns}:${p.path}`;
  const startPath = `assets/${p.ns}/models/item/${p.path}.json`;
  return resolveModelChain(startPath, p.ns, entries, vanilla, modelCache, 0, new Set());
}

export function resolveBlockModel(itemId, assetIndex, entries, vanilla, modelCache = new Map()) {
  const p = parseNamespaced(itemId);
  if (!p) return null;
  const startPath = `assets/${p.ns}/models/block/${p.path}.json`;
  return resolveModelChain(startPath, p.ns, entries, vanilla, modelCache, 0, new Set());
}

function resolveModelChain(modelPath, fallbackNs, entries, vanilla, modelCache, depth, seen) {
  if (depth > 12 || seen.has(modelPath)) return null;
  seen.add(modelPath);
  const json = getModelJsonByPath(modelPath, entries, vanilla, modelCache);
  if (!json) return null;
  let base = { textures: {}, display: {}, elements: null, gui_light: null, ambientocclusion: true };
  if (json.parent) {
    const pref = resolveModelRef(json.parent, fallbackNs);
    if (pref && pref.path === 'builtin/entity') {
      base = { ...base, _builtinEntity: true };
    } else if (pref) {
      const parentResolved = resolveModelChain(pref.modelPath, pref.ns, entries, vanilla, modelCache, depth + 1, new Set(seen));
      if (parentResolved) base = parentResolved;
      if (pref.ns === 'minecraft' && (pref.path === 'item/generated' || pref.path === 'builtin/generated')) {
        base = { ...base, elements: base.elements || null, _generated: true };
      }
    }
  }
  const merged = mergeModel(base, json);
  merged._generated = merged._generated || (json.parent === 'minecraft:item/generated' || json.parent === 'item/generated');
  return merged;
}

export function resolveItemRender(itemId, assetIndex, entries, vanilla, modelCache = new Map()) {
  const p = parseNamespaced(itemId);
  if (!p) return { mode: 'missing' };
  const model = resolveFullModel(itemId, assetIndex, entries, vanilla, modelCache);
  if (!model) return { mode: 'missing' };

  const tex = model.textures || {};
  const hasLayer0 = !!tex.layer0;
  const isGenerated = !!model._generated || (hasLayer0 && !model.elements);
  const blockModel = (isBlockLike(assetIndex, itemId) || !isGenerated) ? resolveBlockModel(itemId, assetIndex, entries, vanilla, modelCache) : null;
  const block3d = (blockModel && Array.isArray(blockModel.elements) && blockModel.elements.length) ? {
    mode: '3d',
    model: {
      elements: blockModel.elements,
      textures: blockModel.textures || {},
      display: blockModel.display || {},
      gui_light: blockModel.gui_light || 'side',
      ambientocclusion: blockModel.ambientocclusion !== false,
      texture_size: blockModel.texture_size || [16,16],
    },
    ns: p.ns,
  } : null;

  // Prefer 3D for block-like items, even if item model is generated/2D
  if (block3d && isBlockLike(assetIndex, itemId)) return block3d;

  if (isGenerated && hasLayer0) {
    return { mode: '2d', texture: normalizeTextureRef(tex.layer0, p.ns) };
  }

  // If has elements (block/item model), render as 3D
  if (Array.isArray(model.elements) && model.elements.length > 0) {
    return {
      mode: '3d',
      model: {
        elements: model.elements,
        textures: tex,
        display: model.display || {},
        gui_light: model.gui_light || 'side',
        ambientocclusion: model.ambientocclusion !== false,
        texture_size: model.texture_size || [16,16],
      },
      ns: p.ns,
    };
  }
  if (block3d) return block3d;

  // fallback: try layer0/particle/any texture
  for (const k of ['layer0', 'particle', 'texture']) {
    if (tex[k] && !String(tex[k]).startsWith('#')) return { mode: '2d', texture: normalizeTextureRef(tex[k], p.ns) };
  }
  const vals = Object.values(tex).filter(v => typeof v === 'string' && !v.startsWith('#'));
  if (vals.length) return { mode: '2d', texture: normalizeTextureRef(vals[0], p.ns) };

  if (model._builtinEntity) {
    // try common GUI/icon model variants
    for (const suffix of ['_gui_icon', '_gui', '_icon', '_item']) {
      const alt = `${p.ns}:${p.path}${suffix}`;
      const ap = parseNamespaced(alt);
      const r2 = resolveModelChain(`assets/${ap.ns}/models/item/${ap.path}.json`, ap.ns, entries, vanilla, modelCache, 0, new Set());
      if (r2 && Array.isArray(r2.elements) && r2.elements.length) {
        const tex2 = r2.textures || {};
        return { mode:'3d', model:{ elements:r2.elements, textures:tex2, display:r2.display||{}, gui_light:r2.gui_light||'side', ambientocclusion:r2.ambientocclusion!==false, texture_size:r2.texture_size||[16,16] }, ns: ap.ns };
      }
      if (r2) {
        const tex2 = r2.textures || {};
        for (const k of ['layer0','particle','texture']) {
          if (tex2[k] && !String(tex2[k]).startsWith('#')) return { mode:'2d', texture: normalizeTextureRef(tex2[k], ap.ns) };
        }
      }
    }
  }

  // fallback: try direct block model (covers builtin_entity block items and missing/odd item models)
  if (!block3d) {
    const bm = resolveBlockModel(itemId, assetIndex, entries, vanilla, modelCache);
    if (bm && Array.isArray(bm.elements) && bm.elements.length) {
      const tex2 = bm.textures || {};
      return { mode:'3d', model:{ elements:bm.elements, textures:tex2, display:bm.display||{}, gui_light:bm.gui_light||'side', ambientocclusion:bm.ambientocclusion!==false, texture_size:bm.texture_size||[16,16] }, ns: p.ns };
    }
  }

  if (model._builtinEntity) return { mode: 'builtin_entity' };
  return { mode: 'missing' };
}

export function collectModelTextureRefs(modelObj) {
  const refs = new Set();
  const tex = modelObj?.textures || {};
  for (const v of Object.values(tex)) {
    if (typeof v === 'string' && !v.startsWith('#')) refs.add(v);
  }
  // also scan element faces for direct texture refs (rare) - normally they use #vars resolved via textures
  for (const el of (modelObj?.elements || [])) {
    for (const face of Object.values(el.faces || {})) {
      if (face.texture && !face.texture.startsWith('#')) refs.add(face.texture);
    }
  }
  return [...refs];
}

export function normalizeTextureRef(ref, fallbackNs) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('#')) return null;
  if (ref.includes(':')) {
    const [ns, rest] = ref.split(':');
    return `assets/${ns}/textures/${rest}.png`;
  }
  return `assets/${fallbackNs}/textures/${ref}.png`;
}

export function isBlockLike(assetIndex, id) {
  const p = parseNamespaced(id);
  if (!p) return false;
  return assetIndex.blockstates.has(`${p.ns}:${p.path}`);
}

// Keep for compatibility
export function resolveItemTexture(itemId, assetIndex, entries, vanilla = null, _depth = 0, _seen = new Set()) {
  const r = resolveItemRender(itemId, assetIndex, entries, vanilla);
  if (r.mode === '2d') return r.texture;
  if (r.mode === '3d') {
    const tex = r.model.textures || {};
    for (const k of ['particle', 'all', 'side', 'top', 'front']) {
      if (tex[k] && !String(tex[k]).startsWith('#')) return normalizeTextureRef(tex[k], r.ns);
    }
    const vals = Object.values(tex).filter(v => typeof v === 'string' && !v.startsWith('#'));
    if (vals.length) return normalizeTextureRef(vals[0], r.ns);
  }
  return null;
}


const BUILTIN_TAG_FALLBACKS = {
  'c:dyes': ['minecraft:white_dye','minecraft:orange_dye','minecraft:magenta_dye','minecraft:light_blue_dye','minecraft:yellow_dye','minecraft:lime_dye','minecraft:pink_dye','minecraft:gray_dye','minecraft:light_gray_dye','minecraft:cyan_dye','minecraft:purple_dye','minecraft:blue_dye','minecraft:brown_dye','minecraft:green_dye','minecraft:red_dye','minecraft:black_dye'],
  'forge:dyes': ['#c:dyes'],
  'c:dyes/white': ['minecraft:white_dye'], 'forge:dyes/white': ['#c:dyes/white'],
  'c:dyes/orange': ['minecraft:orange_dye'], 'forge:dyes/orange': ['#c:dyes/orange'],
  'c:dyes/magenta': ['minecraft:magenta_dye'], 'forge:dyes/magenta': ['#c:dyes/magenta'],
  'c:dyes/light_blue': ['minecraft:light_blue_dye'], 'forge:dyes/light_blue': ['#c:dyes/light_blue'],
  'c:dyes/yellow': ['minecraft:yellow_dye'], 'forge:dyes/yellow': ['#c:dyes/yellow'],
  'c:dyes/lime': ['minecraft:lime_dye'], 'forge:dyes/lime': ['#c:dyes/lime'],
  'c:dyes/pink': ['minecraft:pink_dye'], 'forge:dyes/pink': ['#c:dyes/pink'],
  'c:dyes/gray': ['minecraft:gray_dye'], 'forge:dyes/gray': ['#c:dyes/gray'],
  'c:dyes/light_gray': ['minecraft:light_gray_dye'], 'forge:dyes/light_gray': ['#c:dyes/light_gray'],
  'c:dyes/cyan': ['minecraft:cyan_dye'], 'forge:dyes/cyan': ['#c:dyes/cyan'],
  'c:dyes/purple': ['minecraft:purple_dye'], 'forge:dyes/purple': ['#c:dyes/purple'],
  'c:dyes/blue': ['minecraft:blue_dye'], 'forge:dyes/blue': ['#c:dyes/blue'],
  'c:dyes/brown': ['minecraft:brown_dye'], 'forge:dyes/brown': ['#c:dyes/brown'],
  'c:dyes/green': ['minecraft:green_dye'], 'forge:dyes/green': ['#c:dyes/green'],
  'c:dyes/red': ['minecraft:red_dye'], 'forge:dyes/red': ['#c:dyes/red'],
  'c:dyes/black': ['minecraft:black_dye'], 'forge:dyes/black': ['#c:dyes/black'],
  'c:glass_blocks': ['minecraft:glass','minecraft:white_stained_glass','minecraft:orange_stained_glass','minecraft:magenta_stained_glass','minecraft:light_blue_stained_glass','minecraft:yellow_stained_glass','minecraft:lime_stained_glass','minecraft:pink_stained_glass','minecraft:gray_stained_glass','minecraft:light_gray_stained_glass','minecraft:cyan_stained_glass','minecraft:purple_stained_glass','minecraft:blue_stained_glass','minecraft:brown_stained_glass','minecraft:green_stained_glass','minecraft:red_stained_glass','minecraft:black_stained_glass'],
  'c:glass_panes': ['minecraft:glass_pane','minecraft:white_stained_glass_pane','minecraft:orange_stained_glass_pane','minecraft:magenta_stained_glass_pane','minecraft:light_blue_stained_glass_pane','minecraft:yellow_stained_glass_pane','minecraft:lime_stained_glass_pane','minecraft:pink_stained_glass_pane','minecraft:gray_stained_glass_pane','minecraft:light_gray_stained_glass_pane','minecraft:cyan_stained_glass_pane','minecraft:purple_stained_glass_pane','minecraft:blue_stained_glass_pane','minecraft:brown_stained_glass_pane','minecraft:green_stained_glass_pane','minecraft:red_stained_glass_pane','minecraft:black_stained_glass_pane'],
  'c:glass/dark': ['minecraft:black_stained_glass'],
  'forge:glass/dark': ['#c:glass/dark'],
  'c:glass_blocks/dark': ['minecraft:black_stained_glass'],
  'forge:glass_blocks/dark': ['#c:glass_blocks/dark'],
  'c:glass_panes/dark': ['minecraft:black_stained_glass_pane'],
  'forge:glass_panes/dark': ['#c:glass_panes/dark'],
  'c:stones': ['minecraft:stone','minecraft:granite','minecraft:diorite','minecraft:andesite','minecraft:deepslate'],
  'c:cobblestones': ['minecraft:cobblestone','minecraft:cobbled_deepslate'],
  // vanilla-equivalent common tags: prefer canonical vanilla items
  'c:storage_blocks/iron': ['minecraft:iron_block'],
  'forge:storage_blocks/iron': ['#c:storage_blocks/iron'],
  'c:storage_blocks/gold': ['minecraft:gold_block'],
  'forge:storage_blocks/gold': ['#c:storage_blocks/gold'],
  'c:storage_blocks/copper': ['minecraft:copper_block'],
  'forge:storage_blocks/copper': ['#c:storage_blocks/copper'],
  'c:storage_blocks/diamond': ['minecraft:diamond_block'],
  'forge:storage_blocks/diamond': ['#c:storage_blocks/diamond'],
  'c:storage_blocks/emerald': ['minecraft:emerald_block'],
  'forge:storage_blocks/emerald': ['#c:storage_blocks/emerald'],
  'c:storage_blocks/lapis': ['minecraft:lapis_block'],
  'forge:storage_blocks/lapis': ['#c:storage_blocks/lapis'],
  'c:storage_blocks/redstone': ['minecraft:redstone_block'],
  'forge:storage_blocks/redstone': ['#c:storage_blocks/redstone'],
  'c:storage_blocks/coal': ['minecraft:coal_block'],
  'forge:storage_blocks/coal': ['#c:storage_blocks/coal'],
  'c:storage_blocks/quartz': ['minecraft:quartz_block'],
  'forge:storage_blocks/quartz': ['#c:storage_blocks/quartz'],
  'c:storage_blocks/netherite': ['minecraft:netherite_block'],
  'forge:storage_blocks/netherite': ['#c:storage_blocks/netherite'],
  'c:ingots/iron': ['minecraft:iron_ingot'],
  'forge:ingots/iron': ['#c:ingots/iron'],
  'c:ingots/gold': ['minecraft:gold_ingot'],
  'forge:ingots/gold': ['#c:ingots/gold'],
  'c:ingots/copper': ['minecraft:copper_ingot'],
  'forge:ingots/copper': ['#c:ingots/copper'],
  'c:ingots/netherite': ['minecraft:netherite_ingot'],
  'forge:ingots/netherite': ['#c:ingots/netherite'],
  'c:nuggets/iron': ['minecraft:iron_nugget'],
  'forge:nuggets/iron': ['#c:nuggets/iron'],
  'c:nuggets/gold': ['minecraft:gold_nugget'],
  'forge:nuggets/gold': ['#c:nuggets/gold'],
  'c:gems/diamond': ['minecraft:diamond'],
  'forge:gems/diamond': ['#c:gems/diamond'],
  'c:gems/emerald': ['minecraft:emerald'],
  'forge:gems/emerald': ['#c:gems/emerald'],
  'c:gems/lapis': ['minecraft:lapis_lazuli'],
  'forge:gems/lapis': ['#c:gems/lapis'],
  'c:gems/quartz': ['minecraft:quartz'],
  'forge:gems/quartz': ['#c:gems/quartz'],
  'c:gems/amethyst': ['minecraft:amethyst_shard'],
  'forge:gems/amethyst': ['#c:gems/amethyst'],
  'c:dusts/redstone': ['minecraft:redstone'],
  'forge:dusts/redstone': ['#c:dusts/redstone'],
  'c:dusts/glowstone': ['minecraft:glowstone_dust'],
  'forge:dusts/glowstone': ['#c:dusts/glowstone'],
};

export function expandTag(tagId, assetIndex, kind = 'item', depth = 0, seen = new Set()) {
  if (depth > 10) return [];
  const norm = String(tagId || '').startsWith('#') ? String(tagId).slice(1) : String(tagId || '');
  if (!norm || seen.has(norm)) return [];
  seen.add(norm);
  const defs = [
    ...(assetIndex.tags?.[kind]?.get(norm) || []),
    ...(kind !== 'item' ? [] : (assetIndex.tags?.block?.get(norm) || [])),
  ];
  let allDefs = defs;
  if (!allDefs.length) {
    allDefs = [...(assetIndex.tags?.item?.get(norm) || []), ...(assetIndex.tags?.block?.get(norm) || [])];
  }
  const out = [];
  const pushVal = (id) => {
    if (!id) return;
    if (String(id).startsWith('#')) out.push(...expandTag(String(id), assetIndex, kind, depth + 1, new Set(seen)));
    else out.push(String(id));
  };
  for (const def of allDefs) {
    const vals = Array.isArray(def?.values) ? def.values : [];
    for (const v of vals) {
      const id = typeof v === 'string' ? v : v?.id;
      pushVal(id);
    }
  }
  // For common vanilla-equivalent tags, prefer canonical vanilla fallback when present.
  // This avoids noisy modded variants in display (e.g. #c:storage_blocks/iron -> iron block).
  if (BUILTIN_TAG_FALLBACKS[norm]) {
    const vanillaPreferred = [];
    for (const id of BUILTIN_TAG_FALLBACKS[norm]) {
      if (String(id).startsWith('#')) {
        vanillaPreferred.push(...expandTag(String(id), assetIndex, kind, depth + 1, new Set(seen)));
      } else {
        vanillaPreferred.push(String(id));
      }
    }
    if (vanillaPreferred.length) {
      const uniqVanilla = [...new Set(vanillaPreferred)];
      if (!out.length) return uniqVanilla;
      // keep vanilla canonical first, append other mod items after
      const rest = out.filter(id => !uniqVanilla.includes(id));
      return [...uniqVanilla, ...rest];
    }
  }

  // Generic: force c:/forge: tags to prefer vanilla minecraft equivalent when possible
  const p = parseNamespaced(norm);
  if (p && (p.ns === 'c' || p.ns === 'forge')) {
    const vanillaPreferred = [];
    // try minecraft tag with same path
    const mcTag = `minecraft:${p.path}`;
    const mcTagDefs = [...(assetIndex.tags?.[kind]?.get(mcTag) || []), ...(kind === 'item' ? (assetIndex.tags?.block?.get(mcTag) || []) : [])];
    if (mcTagDefs.length) vanillaPreferred.push(...expandTag(mcTag, assetIndex, kind, depth + 1, new Set(seen)));
    // try minecraft item/block with same path or common singular forms
    const candidates = [p.path, p.path.replace(/s$/, ''), p.path.replace(/ies$/, 'y'), p.path.replace(/_blocks$/, '_block')];
    for (const c of [...new Set(candidates)]) {
      if (!c) continue;
      const id = `minecraft:${c}`;
      if (
        assetIndex.itemModels?.has(id) ||
        assetIndex.blockstates?.has(id) ||
        assetIndex.vanillaEntries?.has(`assets/minecraft/models/item/${c}.json`) ||
        assetIndex.vanillaEntries?.has(`assets/minecraft/models/block/${c}.json`) ||
        assetIndex.vanillaEntries?.has(`assets/minecraft/blockstates/${c}.json`)
      ) vanillaPreferred.push(id);
    }
    // known common names
    const common = {
      eggs: ['minecraft:egg'], egg: ['minecraft:egg'],
      ender_pearls: ['minecraft:ender_pearl'], ender_pearl: ['minecraft:ender_pearl'],
      slime_balls: ['minecraft:slime_ball'], slimeballs: ['minecraft:slime_ball'],
      strings: ['minecraft:string'], feathers: ['minecraft:feather'], bones: ['minecraft:bone'],
      leathers: ['minecraft:leather'], gunpowders: ['minecraft:gunpowder'],
    };
    if (common[p.path]) vanillaPreferred.push(...common[p.path]);
    if (vanillaPreferred.length) {
      const uniqVanilla = [...new Set(vanillaPreferred.filter(Boolean))];
      if (!out.length) return uniqVanilla;
      const rest = out.filter(id => !uniqVanilla.includes(id));
      return [...uniqVanilla, ...rest];
    }
  }
  return [...new Set(out)];
}


export function searchItemByLooseName(name, assetIndex, vanilla) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const n = raw.toLowerCase().replace(/\s+/g, '_');
  const candidates = [n, n.replace(/[^a-z0-9_\/.\-]/g, '')];
  for (const c of candidates) {
    if (!c) continue;
    if (assetIndex.itemModels.has(`minecraft:${c}`)) return `minecraft:${c}`;
    if (vanilla?.entries?.has(`assets/minecraft/models/item/${c}.json`)) return `minecraft:${c}`;
    for (const k of assetIndex.itemModels.keys()) {
      const p = k.split(':')[1] || k;
      if (p.toLowerCase() === c) return k;
    }
  }
  // fuzzy: contains match on vanilla item model names (last resort)
  if (vanilla?.entries) {
    for (const k of vanilla.entries.keys()) {
      const m = k.match(/^assets\/minecraft\/models\/item\/(.+)\.json$/);
      if (m && m[1].toLowerCase() === n) return `minecraft:${m[1]}`;
    }
  }
  return null;
}
