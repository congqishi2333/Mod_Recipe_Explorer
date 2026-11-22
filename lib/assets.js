import fs from 'fs';
import { getJson, parseNamespaced } from './zip.js';
import { getVanillaJson } from './vanilla.js';

export function buildAssetIndex(entries, vanilla = null, options = {}) {
  const langs = {}; // ns -> {key:value}
  const itemModels = new Map(); // "ns:path" -> json
  const itemByBasename = new Map(); // 小写路径 -> "ns:path"，避免按名字搜索时 O(N) 扫全表
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
    if ((m = p.match(/^assets\/([^/]+)\/lang\/([^/]+)\.json$/))) {
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
      if (json) {
        const id = `${ns}:${name}`;
        itemModels.set(id, { path: p, json, source: 'mod' });
        const low = name.toLowerCase();
        if (!itemByBasename.has(low)) itemByBasename.set(low, id); // mod 优先
      }
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
      const tm = p.match(/^data\/([^/]+)\/tags\/(item|block)\/(.+)\.json$/);
      if (tm) {
        try {
          const json = JSON.parse(e.getData().toString('utf8'));
          if (json) addTag(tm[2], tm[1], tm[3], json);
        } catch {}
        continue;
      }
      // 原版 blockstates 必须和 mod 的一样进索引，否则 isBlockLike() 对所有
      // minecraft:* 方块返回 false，3D 优先分支失效，原版方块全掉进 2D 贴图。
      const bm = p.match(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/);
      if (bm) blockstates.add(`${bm[1]}:${bm[2]}`);
      const im = p.match(/^assets\/minecraft\/models\/item\/(.+)\.json$/);
      if (im) {
        const low = im[1].toLowerCase();
        if (!itemByBasename.has(low)) itemByBasename.set(low, `minecraft:${im[1]}`);
      }
    }
  }

  return {
    langs, itemModels, itemByBasename, blockstates, tags,
    vanillaEntries: vanilla?.entries || null,
    // 默认严格按 mod 数据：只有用户显式打开“显示等价原版”时才注入原版替代品
    vanillaEquivalents: options.includeVanillaEquivalents === true,
  };
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
  return { ns, path: p, modelPath: `assets/${ns}/models/${p}.json` };
}

// 内置父模型兜底：vanilla jar 没加载、或 mod 引用了不存在的通用父模型时，
// 直接用这些几何定义合成 elements。纹理仍走 #变量，由子模型的 textures 填充。
function cubeElements(mapping) {
  const uvs = { up:[0,0,16,16], down:[0,0,16,16], north:[0,0,16,16],
    south:[0,0,16,16], east:[0,0,16,16], west:[0,0,16,16] };
  const faces = {};
  for (const f of ['up','down','north','south','east','west']) {
    faces[f] = { texture: mapping[f], uv: uvs[f] };
  }
  return [{ from:[0,0,0], to:[16,16,16], faces }];
}
const BUILTIN_PARENT_MODELS = {
  'block/cube': cubeElements({ up:'#up', down:'#down', north:'#north', south:'#south', east:'#east', west:'#west' }),
  'block/cube_all': cubeElements({ up:'#all', down:'#all', north:'#all', south:'#all', east:'#all', west:'#all' }),
  'block/cube_mirrored': cubeElements({ up:'#all', down:'#all', north:'#all', south:'#all', east:'#all', west:'#all' }),
  'block/cube_bottom_top': cubeElements({ up:'#top', down:'#bottom', north:'#side', south:'#side', east:'#side', west:'#side' }),
  'block/cube_column': cubeElements({ up:'#end', down:'#end', north:'#side', south:'#side', east:'#side', west:'#side' }),
  'block/orientable': cubeElements({ up:'#top', down:'#bottom', north:'#side', south:'#front', east:'#side', west:'#side' }),
  'block/orientable_with_bottom': cubeElements({ up:'#top', down:'#bottom', north:'#side', south:'#front', east:'#side', west:'#side' }),
  'block/orientable_vertical': cubeElements({ up:'#end', down:'#end', north:'#side', south:'#side', east:'#side', west:'#side' }),
};

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

// 从 blockstate 的 variants/multipart 取真正的 model 引用。
// variants 只取默认项（''/normal），避免把 16 个朝向合并成一团；
// multipart 合并所有 apply（静态渲染下假设条件都满足）。
function pickBlockstateModelRefs(bs) {
  const refs = [];
  if (bs?.variants && typeof bs.variants === 'object') {
    const keys = Object.keys(bs.variants);
    const pref = keys.find(k => k === '' || k === 'normal') || keys[0];
    const v = pref !== undefined ? bs.variants[pref] : null;
    for (const item of (Array.isArray(v) ? v : [v])) {
      if (item && typeof item.model === 'string') refs.push(item.model);
    }
  }
  if (Array.isArray(bs?.multipart)) {
    for (const part of bs.multipart) {
      const apply = part?.apply;
      for (const item of (Array.isArray(apply) ? apply : [apply])) {
        if (item && typeof item.model === 'string') refs.push(item.model);
      }
    }
  }
  return [...new Set(refs)];
}

function mergeBlockModels(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    ...a, ...b,
    textures: { ...(a.textures || {}), ...(b.textures || {}) },
    display: { ...(a.display || {}), ...(b.display || {}) },
    elements: [...(a.elements || []), ...(b.elements || [])],
  };
}

export function resolveBlockModel(itemId, assetIndex, entries, vanilla, modelCache = new Map()) {
  const p = parseNamespaced(itemId);
  if (!p) return null;
  // 先读 blockstate，按 variants/multipart 找真正的 model，不再靠物品 ID 猜同名文件
  const bsPath = `assets/${p.ns}/blockstates/${p.path}.json`;
  const bs = getJson(entries, bsPath) || getVanillaJson(vanilla, bsPath);
  if (bs) {
    let merged = null;
    for (const ref of pickBlockstateModelRefs(bs)) {
      const rp = resolveModelRef(ref, p.ns);
      if (!rp) continue;
      const m = resolveModelChain(rp.modelPath, rp.ns, entries, vanilla, modelCache, 0, new Set());
      if (m) merged = mergeBlockModels(merged, m);
    }
    if (merged && Array.isArray(merged.elements) && merged.elements.length) return merged;
  }
  // 回退：同名 block model
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
      // parent 可能省略 block/（如 "parent": "cube_all"）：先按原路径，
      // 再补 block/，最后回退到 minecraft 命名空间，避免静默掉进 2D。
      const candidates = [pref.modelPath];
      if (!/^(block|item|builtin)\//.test(pref.path)) {
        candidates.push(`assets/${pref.ns}/models/block/${pref.path}.json`);
        if (pref.ns !== 'minecraft') candidates.push(`assets/minecraft/models/block/${pref.path}.json`);
      }
      let parentResolved = null;
      for (const cp of candidates) {
        parentResolved = resolveModelChain(cp, pref.ns, entries, vanilla, modelCache, depth + 1, new Set(seen));
        if (parentResolved) break;
      }
      if (!parentResolved) {
        const builtin = BUILTIN_PARENT_MODELS[pref.path] || BUILTIN_PARENT_MODELS[`block/${pref.path}`];
        if (builtin) {
          parentResolved = {
            textures: {}, display: {}, gui_light: null, ambientocclusion: true,
            elements: JSON.parse(JSON.stringify(builtin)),
          };
        }
      }
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

  // 半透明方块退 2D，避免背面剔除 + 画家算法合成出错
  if (block3d && isTranslucentItem(itemId)) {
    const bt = block3d.model.textures || {};
    const ref = bt.all || bt.particle || bt.side || bt.top
      || Object.values(bt).find(v => typeof v === 'string' && !v.startsWith('#'));
    if (ref) return { mode: '2d', texture: normalizeTextureRef(ref, p.ns) };
  }

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

// 玻璃/冰/水/粘液等半透明方块：背面剔除会丢掉本应透视到的背面，
// 画家算法 + 无深度写入也无法正确合成，直接退 2D 贴顶面纹理更稳。
function isTranslucentItem(id) {
  const s = String(id || '').toLowerCase();
  return /(?:^|[_:])glass(?:_|$)|(?:^|[_:])ice$|(?:^|[_:])water$|(?:^|[_:])slime(?:_|$)|honey_block|beacon|end_portal|nether_portal/.test(s);
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


const BUILTIN_TAG_FALLBACKS = JSON.parse(
  fs.readFileSync(new URL('../config/tag-fallbacks.json', import.meta.url), 'utf8')
);

export function expandTag(tagId, assetIndex, kind = 'item', depth = 0, seen = new Set()) {
  if (depth > 10) return [];
  const preferVanilla = assetIndex.vanillaEquivalents === true;
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
  // 用户开启“显示等价原版”后，才把常见社区标签映射到原版等价物。
  // 默认关闭，避免把 mod 自己的标签内容替换成 minecraft:*。
  if (preferVanilla && BUILTIN_TAG_FALLBACKS[norm]) {
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

  // 同样受开关控制：是否把任意 c:/forge: 标签强行补上同名原版物品
  const p = parseNamespaced(norm);
  if (preferVanilla && p && (p.ns === 'c' || p.ns === 'forge')) {
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
    const byName = assetIndex.itemByBasename?.get(c);
    if (byName) return byName;
  }
  return null;
}
