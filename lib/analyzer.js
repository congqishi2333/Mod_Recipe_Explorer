import path from 'path';
import fs from 'fs';
import { readZipEntries, extractTextureFromSources, parseNamespaced } from './zip.js';
import { renderModel3DToPng, getRenderStats } from './render3d.js';
import { PNG } from 'pngjs';
import { buildAssetIndex, resolveItemName, resolveItemRender, collectModelTextureRefs, normalizeTextureRef, expandTag, searchItemByLooseName } from './assets.js';
import { collectRecipes } from './recipes.js';
import { classifyRecipe } from './classify.js';
import { loadVanillaAssets } from './vanilla.js';
import { collectAdvancements, mapAdvancementsToItems } from './advancements.js';
import { normalizeMcVersion } from './versions.js';

export async function analyzeModJar(jarPath, outDir, options = {}) {
  const { entries } = readZipEntries(jarPath);
  // 渲染侧计数是全局累计的（预热也会累加），这里取增量，保证每次分析的
  // 图标降级数字独立可比；和 parseQuality 两个口径不合并。
  const statsBefore = getRenderStats();
  const mcVersion = normalizeMcVersion(options.mcVersion);
  const vanilla = loadVanillaAssets(mcVersion, options.vanillaJar || null);
  const assetIndex = buildAssetIndex(entries, vanilla, {
    includeVanillaEquivalents: options.includeVanillaEquivalents === true,
  });
  const parseStats = {};
  const recipes = collectRecipes(entries, parseStats);
  const advancements = collectAdvancements(entries, assetIndex);
  const advByItem = mapAdvancementsToItems(advancements);

  const iconCache = new Map(); // id -> icon url
  const texUrlCache = new Map(); // texturePath -> url
  const texFileCache = new Map(); // texturePath -> local file
  const modelCache = new Map();
  const pngReadCache = new Map();
  const itemsDir = path.join(outDir, 'icons');
  const rendersDir = path.join(outDir, 'renders');
  fs.mkdirSync(itemsDir, { recursive: true });
  fs.mkdirSync(rendersDir, { recursive: true });
  // 每个 MC 版本的方块模型/材质不同，渲染缓存必须按版本隔离，否则切版本会复用旧图。
  const vanillaRenderDir = path.join(path.dirname(outDir), 'vanilla-renders', mcVersion);
  fs.mkdirSync(vanillaRenderDir, { recursive: true });

  function ensureTextureUrl(texPath, fallbackNs = 'minecraft') {
    if (!texPath) return null;
    const norm = texPath.startsWith('assets/') ? texPath : normalizeTextureRef(texPath, fallbackNs);
    if (!norm) return null;
    if (texUrlCache.has(norm)) return texUrlCache.get(norm);
    const base = norm.replace(/^assets\//, '').replace(/[\/\\]/g, '_').replace(/\.png$/i, '');
    const file = extractTextureFromSources(entries, vanilla?.entries, norm, itemsDir, base);
    const url = file ? `/data/${path.basename(outDir)}/icons/${file}` : null;
    texUrlCache.set(norm, url);
    texFileCache.set(norm, file ? path.join(itemsDir, file) : null);
    return url;
  }

  function ensureTextureFile(texPath, fallbackNs = 'minecraft') {
    const norm = texPath?.startsWith?.('assets/') ? texPath : normalizeTextureRef(texPath, fallbackNs);
    if (!norm) return null;
    if (texFileCache.has(norm)) return texFileCache.get(norm);
    ensureTextureUrl(norm, fallbackNs);
    return texFileCache.get(norm) || null;
  }

  function ensureModel3DRender(id, model3d, ns='minecraft') {
    if (!id || !model3d?.elements?.length) return null;
    const safeId = String(id).replace(/[:/\\]/g, '_');
    const isVanilla = String(id).startsWith('minecraft:');
    const dir = isVanilla ? vanillaRenderDir : rendersDir;
    const file = path.join(dir, safeId + '.png');
    const url = isVanilla
      ? `/data/vanilla-renders/${mcVersion}/${safeId}.png`
      : `/data/${path.basename(outDir)}/renders/${safeId}.png`;
    if (fs.existsSync(file)) return url;
    const texFileByRef = {};
    for (const [k, v] of Object.entries(model3d.textures || {})) {
      if (typeof v !== 'string' || v.startsWith('#')) continue;
      const fp = ensureTextureFile(v, ns);
      if (fp) texFileByRef[v] = fp;
      if (fp) texFileByRef[k] = fp;
    }
    const png = renderModel3DToPng(addTintColors(id, model3d, vanilla), texFileByRef, 64, pngReadCache);
    if (!png) return null;
    fs.writeFileSync(file, PNGSyncWrite(png));
    return url;
  }

  function PNGSyncWrite(png) {
    return PNG.sync.write(png);
  }

  function ensureIcon(id) {
    if (!id) return null;
    if (iconCache.has(id)) return iconCache.get(id);
    const render = resolveItemRender(id, assetIndex, entries, vanilla, modelCache);
    const p = parseNamespaced(id);
    let icon = null;
    let model3d = null;

    if (render.mode === '2d') {
      icon = ensureTextureUrl(render.texture, p?.ns || 'minecraft');
    } else if (render.mode === '3d') {
      const rawTex = render.model.textures || {};
      const texMap = {};
      const resolveTex = (v, depth=0) => {
        if (typeof v !== 'string' || depth > 8) return null;
        if (v.startsWith('#')) return resolveTex(rawTex[v.slice(1)], depth+1);
        return ensureTextureUrl(v, render.ns || p?.ns || 'minecraft');
      };
      for (const [k, v] of Object.entries(rawTex)) {
        if (typeof v !== 'string') continue;
        const url = resolveTex(v, 0);
        texMap[k] = url || v;
      }
      model3d = {
        elements: render.model.elements,
        textures: rawTex,
        textureUrls: texMap,
        gui_light: render.model.gui_light,
        textureSize: render.model.texture_size || [16,16],
      };
      const rendered = ensureModel3DRender(id, model3d, render.ns || p?.ns || 'minecraft');
      icon = rendered || texMap.particle || texMap.all || texMap.side || texMap.top || Object.values(texMap).find(v => typeof v === 'string' && v.startsWith('/data/')) || null;
      if (rendered) model3d = null; // prefer pre-rendered icon; saves payload and frontend cost
    } else if (render.mode === 'builtin_entity') {
      // cannot render custom entity model; leave icon/model3d null for placeholder
    }

    // builtin entity or no renderable elements: try to find a dedicated item texture
    if (!icon && !model3d) {
      const pns = parseNamespaced(id);
      const ns = pns?.ns || 'minecraft';
      const nm = pns?.path || 'unknown';
      const guesses = [
        `assets/${ns}/textures/item/${nm}.png`,
        `assets/${ns}/textures/item/${nm}_texture.png`,
        `assets/${ns}/textures/item/${nm}_icon.png`,
        `assets/${ns}/textures/item/${nm}_item.png`,
      ];
      for (const g of guesses) { icon = ensureTextureUrl(g, ns); if (icon) break; }
      if (!icon) {
        // fuzzy: find any item texture containing name
        const needle = nm.toLowerCase();
        const sources = [entries, vanilla?.entries].filter(Boolean);
        for (const src of sources) {
          for (const k of src.keys()) {
            const m = k.match(new RegExp(`^assets/${ns.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/textures/item/(.*${needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}.*)\\.png$`, 'i'));
            if (m) { icon = ensureTextureUrl(k, ns); if (icon) break; }
          }
          if (icon) break;
        }
      }
    }
    const out = icon || model3d ? { icon, model3d } : null;
    iconCache.set(id, out);
    return out;
  }

  function enrichIngredient(ing) {
    if (!ing) return null;
    if (ing.kind === 'alternatives') {
      return { ...ing, options: ing.options.map(enrichIngredient) };
    }
    if (ing.kind === 'item') {
      let id = ing.id;
      let r = ensureIcon(id);
      if (!r?.icon && !r?.model3d) {
        const alt = searchItemByLooseName(id, assetIndex, vanilla) || searchItemByLooseName(parseNamespaced(id)?.path, assetIndex, vanilla);
        if (alt && alt !== id) { id = alt; r = ensureIcon(id); }
      }
      return { ...ing, id, name: resolveItemName(assetIndex.langs, id), icon: r?.icon || null, model3d: r?.model3d || null };
    }
    if (ing.kind === 'tag') {
      const expanded = expandTag(ing.id, assetIndex, 'item').slice(0, 64);
      const options = expanded.map(id => {
        const r = ensureIcon(id);
        return { kind: 'item', id, name: resolveItemName(assetIndex.langs, id), icon: r?.icon || null, model3d: r?.model3d || null };
      }).filter(o => o.icon || o.model3d || o.name);
      const hasVisual = options.some(o => o.icon || o.model3d);
      return { ...ing, name: `#${ing.id}`, icon: options[0]?.icon || null, model3d: options[0]?.model3d || null, options, cycle: options.length > 1, hasVisual };
    }
    return { ...ing, name: ing.id || ing.kind || 'unknown', icon: null };
  }

  const SPECIAL_RESULT_ICON_MAP = {
    'brainlayers:jade_foot_binding': ['brainlayers:jade_foot'],
    'brainlayers:binoculars_helmet_upgrade': ['brainlayers:binoculars_helmet', 'brainlayers:binoculars'],
    'brainlayers:binoculars_zoom': ['brainlayers:binoculars'],
    'brainlayers:chalk_box_refill': ['brainlayers:chalk_box', 'brainlayers:chalk'],
    'brainlayers:pencil_repair': ['brainlayers:rocket_pencil'],
    'brainlayers:water_gun_refill': ['brainlayers:cactus_water_gun'],
    'brainlayers:ginger_transform': ['brainlayers:ginger'],
    'brainlayers:zongzi': ['brainlayers:sweet_zongzi', 'brainlayers:savory_zongzi'],
    'brainlayers:bead_decoration': ['brainlayers:bead'],
    'brainlayers:bead_duplication': ['brainlayers:bead'],
    'brainlayers:drink_alias_dilution': ['brainlayers:drink_alias_coupon'],
    'brainlayers:pillow_cutting': ['brainlayers:pillow'],
    'brainlayers:record_bread': ['brainlayers:record_bread'],
  };

  const SPECIAL_RECIPE_INFO = {
    'brainlayers:chalk_box_crafting': { name: '粉笔盒', note: '在工作台中按模组规则合成粉笔盒（具体摆放由模组代码决定）。' },
    'brainlayers:chalk_box_refill': { name: '粉笔盒补充', note: '用对应染料在合成栏为粉笔盒补充余量。' },
    'brainlayers:binoculars_zoom': { name: '望远镜调焦/缩放', note: '望远镜相关缩放/升级配方（具体输入由模组代码决定）。' },
    'brainlayers:binoculars_helmet_upgrade': { name: '头戴式望远镜升级', note: '将望远镜升级为头戴式望远镜（具体输入由模组代码决定）。' },
    'brainlayers:bead_decoration': { name: '拼豆装饰', note: '将拼豆作品挂到可装饰物品上（具体输入由模组代码决定）。' },
    'brainlayers:bead_duplication': { name: '拼豆袋复制', note: '使用非寻常袋复制任意颜色拼豆袋，非寻常袋损耗1点耐久后返还。' },
    'brainlayers:ginger_transform': { name: '生姜转化', note: '生姜相关转化配方（具体输入由模组代码决定）。' },
    'brainlayers:pencil_repair': { name: '铅笔修复', note: '在合成栏修复/重组火箭铅笔部件（具体输入由模组代码决定）。' },
    'brainlayers:pillow_cutting': { name: '枕头裁切', note: '枕头裁切/改造配方（具体输入由模组代码决定）。' },
    'brainlayers:record_bread': { name: '唱片面包', note: '录制/处理口琴演奏的唱片面包（具体输入由模组代码决定）。' },
    'brainlayers:jade_foot_binding': { name: '玉足绑定', note: '玉足相关绑定/升级（具体输入由模组代码决定）。' },
    'brainlayers:drink_alias_dilution': { name: '饮料代名稀释', note: '饮料代名相关稀释/转换（具体输入由模组代码决定）。' },
    'brainlayers:water_gun_refill': { name: '水枪填充', note: '水枪填充/补水（具体输入由模组代码决定）。' },
    'brainlayers:zongzi': { name: '粽子', note: '粽子制作（具体输入由模组代码决定）。' },
  };

  function resolveWithFallback(id) {
    const rr = ensureIcon(id);
    let out = { id, icon: rr?.icon || null, model3d: rr?.model3d || null };
    if (!out.icon && !out.model3d) {
      const cands = SPECIAL_RESULT_ICON_MAP[id] || [];
      for (const c of cands) {
        const cr = ensureIcon(c);
        if (cr?.icon || cr?.model3d) { out = { ...out, icon: cr.icon || null, model3d: cr.model3d || null, iconFrom: c }; break; }
      }
    }
    if (!out.icon && !out.model3d && typeof id === 'string' && id.includes(':')) {
      const pathPart = id.split(':')[1];
      // prefer same-path assets from other namespaces (compat recipe ids -> actual mod assets)
      const pools = [assetIndex.itemModels?.keys?.() || [], assetIndex.blockstates?.keys?.() || []];
      for (const keys of pools) {
        for (const k of keys) {
          if (k === id) continue;
          if (!String(k).endsWith(':' + pathPart)) continue;
          const kr = ensureIcon(k);
          if (kr?.icon || kr?.model3d) { out = { ...out, icon: kr.icon || null, model3d: kr.model3d || null, iconFrom: k }; break; }
        }
        if (out.icon || out.model3d) break;
      }
    }
    return out;
  }

  function hasRedstoneComponent(res) {
    const c = res?.components;
    if (!c) return false;
    try { return JSON.stringify(c).includes('"redstone":true') || JSON.stringify(c).includes('"redstone": true'); } catch { return false; }
  }
  function withComponentLabel(res) {
    if (!res) return res;
    let name = res.name || res.id;
    if (hasRedstoneComponent(res) && name && !name.includes('红石') && !/redstone/i.test(name)) name = name + '（红石）';
    return { ...res, name };
  }

  // 解析质量评估：把「静默解析失败」显式暴露出来，供审计 UI 与导出使用。
  // suspicious 的四种原因：零输入 / 未知材料 / 无产物 / 未知配方类型。
  function assessParseQuality(r, grid, ingredients, result) {
    const reasons = [];
    let ingredientCount = 0, unknownIngredients = 0, resolvedIngredients = 0;
    const ingredientKinds = {};
    const walk = (ing) => {
      if (!ing) return;
      ingredientCount++;
      const k = ing.kind || 'none';
      ingredientKinds[k] = (ingredientKinds[k] || 0) + 1;
      if (k === 'unknown') unknownIngredients++;
      else if (k === 'item' || k === 'tag' || k === 'alternatives' || k === 'variant-cycle') resolvedIngredients++;
      if (Array.isArray(ing.options)) ing.options.forEach(walk);
    };
    const cells = grid ? grid.flat() : (ingredients || []);
    for (const ing of cells) walk(ing);
    if (ingredientCount === 0) reasons.push('zero-input');
    if (unknownIngredients > 0) reasons.push('unknown-ingredient');
    if (!result || !result.id) reasons.push('result-unresolved');
    if (r.type === 'unknown' || r.category === 'unknown') reasons.push('unknown-recipe-type');
    return {
      suspicious: reasons.length > 0,
      reasons,
      ingredientCount,
      unknownIngredients,
      resolvedIngredients,
      resultResolved: !!(result && result.id),
      ingredientKinds,
      inferred: !!r.inferred,
    };
  }

  function mergeParseQuality(list) {
    const valid = (list || []).filter(Boolean);
    if (!valid.length) return null;
    const reasons = Array.from(new Set(valid.flatMap(q => q.reasons || [])));
    const ingredientKinds = {};
    for (const q of valid) for (const [k, v] of Object.entries(q.ingredientKinds || {})) ingredientKinds[k] = (ingredientKinds[k] || 0) + v;
    const sum = (key) => valid.reduce((s, q) => s + (q[key] || 0), 0);
    return {
      suspicious: reasons.length > 0,
      reasons,
      ingredientCount: sum('ingredientCount'),
      unknownIngredients: sum('unknownIngredients'),
      resolvedIngredients: sum('resolvedIngredients'),
      resultResolved: valid.some(q => q.resultResolved),
      ingredientKinds,
      inferred: valid.some(q => q.inferred),
    };
  }

  const analyzed = recipes.map((r, idx) => {
    const grid = (r.grid || [[null,null,null],[null,null,null],[null,null,null]]).map(row => row.map(enrichIngredient));
    let result = r.result;
    if (result?.id) {
      const rr = resolveWithFallback(result.id);
      const fallbackName = resolveItemName(assetIndex.langs, result.id) || resolveItemName(assetIndex.langs, rr.iconFrom);
      const localized = localizeGeneratedName(parseNamespaced(result.id)?.path || result.id);
      result = { ...result, name: (!isLangResolved(assetIndex.langs, result.id) && localized) ? localized : fallbackName, icon: rr.icon, model3d: rr.model3d };
      result = withComponentLabel(result);
    } else {
      const m = String(r.sourceFile||'').match(/^data\/([^/]+)\/recipes?\/(.+)\.json$/);
      if (m) {
        const id = `${m[1]}:${m[2].split('/').pop()}`;
        const rr = resolveWithFallback(id);
        const fallbackName = resolveItemName(assetIndex.langs, id) || resolveItemName(assetIndex.langs, rr.iconFrom);
        const localized = localizeGeneratedName(parseNamespaced(id)?.path || id);
        result = { id, count: 1, inferred: true, name: (!isLangResolved(assetIndex.langs, id) && localized) ? localized : fallbackName, icon: rr.icon, model3d: rr.model3d };
      }
    }
    const cls = classifyRecipe({ ...r, result }, assetIndex);
    const advInfo = result?.id ? (advByItem.get(result.id) || []) : [];
    const acquisition = 'recipe';
    const notes = [];
    const info = SPECIAL_RECIPE_INFO[r.type] || SPECIAL_RECIPE_INFO[result?.id] || null;
    if (info) {
      if (info.name && result && (!result.name || result.name === result.id || /^[a-z0-9_:.]+$/.test(result.name))) result.name = info.name;
      if (info.note) notes.push(info.note);
    }
    if (advInfo.length) {
      notes.push(`相关成就: ${advInfo.map(a => a.title || a.id).slice(0,2).join('、')}${advInfo.length>2?' 等':''}`);
    }
    if (r.special && !info) notes.push('特殊配方/可能含游戏内逻辑');
    if (hasRedstoneComponent(result)) notes.push('带组件: 红石笔节');
    const station = r.station || (r.category === 'smithing' ? 'smithing_table' : r.category === 'anvil' ? 'anvil' : r.category === 'stonecutting' ? 'stonecutter' : r.category === 'cooking' ? 'minecraft:furnace' : r.category === 'machine' ? (r.type || 'machine') : 'crafting_table');
    if (station === 'smithing_table') notes.push('获取/制作方式: 锻造台');
    if (station === 'anvil') notes.push('获取/制作方式: 铁砧');
    if (station === 'stonecutter') notes.push('获取/制作方式: 切石机');
    if (r.category === 'machine') notes.push(`获取/制作方式: ${stationNameLabel(station)}`);
    if (r.category === 'cooking' && !String(station).startsWith('minecraft:')) notes.push(`获取/制作方式: ${stationNameLabel(station)}`);
    const stations = r.category === 'cooking' ? [station] : (r.stations || (station ? [station] : []));
    const stationItemIds = r.category === 'cooking'
      ? Array.from(new Set([...stations, 'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker']))
      : stations;
    const stationItems = stationItemIds.map(sid => resolveStationItem(sid));
    const ingredients = Array.isArray(r.ingredients) ? r.ingredients.map(enrichIngredient).filter(Boolean) : [];
    const ingredientList = mergeIngredientCounts(ingredients);
    const oversized = !!r.oversized || ingredientList.length > 9 || (r.category === 'crafting_shaped' && (r.width > 3 || r.height > 3));
    const displayType = oversized ? 'ingredients' : (r.displayType || null);
    if (oversized) notes.push('配方超出 3x3 或使用模组自定义工作台，已按材料清单显示');
    const parseQuality = assessParseQuality(r, grid, ingredients, result);
    return {
      id: idx,
      parseQuality,
      sourceFile: r.sourceFile,
      type: r.type,
      recipeCategory: r.category,
      group: r.group || null,
      station,
      stations,
      stationItems,
      grid: oversized ? null : grid,
      ingredients: ingredientList,
      displayType,
      result,
      shapeless: !!r.shapeless,
      special: !!r.special || !!r.inferred || !!result?.inferred,
      acquisition,
      advancements: advInfo,
      notes,
      classification: cls,
    };
  });

  function stationNameLabel(id='') {
    const s = String(id);
    if (s === 'minecraft:furnace') return '熔炉';
    if (s === 'minecraft:blast_furnace') return '高炉';
    if (s === 'minecraft:smoker') return '烟熏炉';
    if (s === 'minecraft:campfire') return '营火';
    const tail = s.includes(':') ? s.split(':')[1] : s;
    return localizeGeneratedName(tail) || tail.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function localizeGeneratedName(nameOrPath='') {
    const raw = String(nameOrPath).replace(/[_-]+/g, ' ').trim();
    if (!raw) return null;
    // common machine recipe patterns
    let m = raw.match(/^(.+)\s+Ingot\s+To\s+Plate$/i);
    if (m) return `${localizeMaterial(m[1])}锭 -> ${localizeMaterial(m[1])}板`;
    m = raw.match(/^(.+)\s+To\s+Plate$/i);
    if (m) return `${localizeMaterial(m[1])} -> ${localizeMaterial(m[1])}板`;
    m = raw.match(/^(.+)\s+Ingot\s+To\s+(Dust|Gear|Rod|Nugget)$/i);
    if (m) {
      const part = { Dust:'粉', Gear:'齿轮', Rod:'杆', Nugget:'粒' }[m[2]] || m[2];
      return `${localizeMaterial(m[1])}锭 -> ${localizeMaterial(m[1])}${part}`;
    }
    return null;
  }

  function localizeMaterial(name='') {
    const key = String(name).trim().toLowerCase().replace(/\s+/g, '_');
    const map = {
      calorite: '耐热金属', desh: '戴斯', ostrum: '紫金', etrium: '埃特锂',
      iron: '铁', gold: '金', copper: '铜', steel: '钢', bronze: '青铜',
      tin: '锡', lead: '铅', silver: '银', nickel: '镍', zinc: '锌',
      aluminum: '铝', aluminium: '铝', uranium: '铀', titanium: '钛',
      tungsten: '钨', platinum: '铂', iridium: '铱', invar: '殷钢',
      electrum: '琥珀金', constantan: '康铜', signalum: '信素', lumium: '流明', enderium: '末影',
    };
    if (map[key]) return map[key];
    // try resolve as item name from any namespace by path
    for (const ns of Object.keys(assetIndex.langs || {})) {
      const id = `${ns}:${key}`;
      const n = resolveItemName(assetIndex.langs, id);
      if (n && n !== id && !/^[A-Z]/.test(n.replace(/\s/g,'')) ? false : true) {
        // resolveItemName falls back to prettified; detect if localized by checking langs directly
      }
    }
    for (const ns of Object.keys(assetIndex.langs || {})) {
      const id = `${ns}:${key}`;
      const langName = resolveLangName(assetIndex.langs, id);
      if (langName) return langName;
    }
    return String(name).trim();
  }

  function resolveLangName(langs, id) {
    const p = parseNamespaced(id);
    if (!p) return null;
    const keys = [`item.${p.ns}.${p.path}`, `block.${p.ns}.${p.path}`, `entity.${p.ns}.${p.path}`];
    for (const lang of ['zh_cn','en_us']) {
      const dict = langs?.[p.ns]?.[lang];
      if (!dict) continue;
      for (const k of keys) if (dict[k]) return dict[k];
    }
    return null;
  }

  function isLangResolved(langs, id) {
    return !!resolveLangName(langs, id);
  }

  function ingredientKey(ing) {
    if (!ing) return 'null';
    if (ing.kind === 'tag') return `tag:${ing.id}`;
    if (ing.kind === 'item') return `item:${ing.id}`;
    if (ing.kind === 'alternatives') return `alt:${(ing.options||[]).map(ingredientKey).sort().join('|')}`;
    if (ing.kind === 'variant-cycle') return `var:${(ing.options||[]).map(ingredientKey).sort().join('|')}`;
    return `${ing.kind}:${ing.id || JSON.stringify(ing)}`;
  }

  function mergeIngredientCounts(list) {
    const map = new Map();
    for (const ing of list || []) {
      if (!ing) continue;
      const k = ingredientKey(ing);
      const n = Number(ing.count) || 1;
      const prev = map.get(k);
      if (prev) prev.count += n;
      else map.set(k, { ...ing, count: n });
    }
    return Array.from(map.values());
  }

  function resolveStationItem(sid) {
    const sr = resolveWithFallback(sid);
    let icon = sr.icon;
    let model3d = sr.model3d;
    let iconFrom = sr.iconFrom;
    if (!icon && !model3d) {
      // try common aliases for mod machine recipe types (e.g. thermal:pulverizer -> thermal:machine_pulverizer)
      const ns = String(sid).includes(':') ? String(sid).split(':')[0] : 'minecraft';
      const path = String(sid).includes(':') ? String(sid).split(':')[1] : String(sid);
      const aliases = [
        `${ns}:machine_${path}`,
        `${ns}:${path}_machine`,
        `${ns}:${path}_block`,
        `${ns}:${path}`,
      ];
      for (const a of aliases) {
        const ar = resolveWithFallback(a);
        if (ar.icon || ar.model3d) { icon = ar.icon; model3d = ar.model3d; iconFrom = ar.iconFrom; break; }
      }
    }
    const name = resolveItemName(assetIndex.langs, sid) || resolveItemName(assetIndex.langs, iconFrom) || stationNameLabel(sid);
    return { id: sid, name, icon, model3d };
  }

  for (const r of analyzed) { if (!r.stations) r.stations = r.station ? [r.station] : []; }
  const advancementItems = [];
  for (const [itemId, advs] of advByItem.entries()) {
    if (analyzed.some(r => r.result?.id === itemId)) continue; // already have recipe entry
    const rr = resolveWithFallback(itemId);
    const result = { id: itemId, count: 1, name: resolveItemName(assetIndex.langs, itemId) || resolveItemName(assetIndex.langs, rr.iconFrom), icon: rr.icon, model3d: rr.model3d };
    const cls = classifyRecipe({ result, category: 'advancement' }, assetIndex);
    const noteLines = advs.map(a => {
      const t = a.title || a.id || '成就';
      const d = a.description ? `：${a.description}` : '';
      return `成就获取: ${t}${d}`;
    });
    advancementItems.push({
      id: `adv-${advancementItems.length}`,
      sourceFile: advs[0]?.sourceFile || '',
      type: 'advancement_reward',
      recipeCategory: 'advancement',
      displayType: 'advancement',
      grid: null,
      result,
      shapeless: false,
      special: true,
      acquisition: 'advancement',
      advancements: advs,
      notes: noteLines.length ? noteLines : ['成就获取'],
      classification: cls,
    });
  }

  const COLOR_PREFIXES = ['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'];
  function isColorVariantItem(id='') {
    const p = String(id).split(':')[1] || String(id);
    return /_dye$/.test(p) || COLOR_PREFIXES.some(c => p.startsWith(c+'_'));
  }
  function normalizeForVariant(ing) {
    if (!ing) return null;
    if (ing.kind === 'alternatives') return { kind:'alternatives', options: (ing.options||[]).map(normalizeForVariant).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    if (ing.kind === 'tag') return { kind:'tag', id: ing.id };
    if (ing.kind === 'item') {
      const id = String(ing.id||'');
      const path = id.split(':')[1] || id;
      if (/_dye$/.test(path)) return { kind:'item', id:'__DYE__' };
      for (const c of COLOR_PREFIXES) {
        if (path.startsWith(c+'_')) return { kind:'item', id:'__COLOR__:' + path.slice(c.length+1) };
      }
      return { kind:'item', id };
    }
    return { kind: ing.kind || 'unknown' };
  }
  function gridSignature(r) {
    return JSON.stringify((r.grid||[]).map(row => (row||[]).map(normalizeForVariant)));
  }
  function resultBaseId(id='') {
    return String(id).replace(/_(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)$/,'_{{color}}');
  }
  function hasRedstone(r) { try { return JSON.stringify(r?.result?.components||{}).includes('"redstone":true'); } catch { return false; } }

  function collapseVariants(list) {
    const groups = new Map();
    for (const r of list) {
      const base = resultBaseId(r.result?.id || '');
      const cookingKey = r.recipeCategory === 'cooking' ? 'cooking' : r.type;
      const key = [r.recipeCategory, r.group || '', gridSignature(r), base, hasRedstone(r)?'rs':'nrs', cookingKey].join('||');
      const arr = groups.get(key) || [];
      arr.push(r);
      groups.set(key, arr);
    }
    const out = [];
    for (const arr of groups.values()) {
      const stationSet = Array.from(new Set(arr.map(r => r.station).filter(Boolean)));
      if (arr.length < 2) { out.push({ ...arr[0], stations: stationSet.length ? stationSet : (arr[0].station ? [arr[0].station] : []) }); continue; }
      // merge
      const first = arr[0];
      const variants = arr.map(r => ({ result: r.result, sourceFile: r.sourceFile, group: r.group, station: r.station, type: r.type }));
      // build variant grid: where cells differ, make alternatives
      const mergedGrid = [[null,null,null],[null,null,null],[null,null,null]];
      for (let y=0;y<3;y++) for (let x=0;x<3;x++) {
        const cells = arr.map(r => r.grid?.[y]?.[x] || null);
        const nonNull = cells.filter(Boolean);
        if (!nonNull.length) { mergedGrid[y][x] = null; continue; }
        const sigs = cells.map(c => JSON.stringify(normalizeForVariant(c)));
        const allSameNorm = sigs.every(s => s === sigs[0]);
        const rawSigs = cells.map(c => c ? (c.kind+':' + (c.id||'')) : 'null');
        const allSameRaw = rawSigs.every(s => s === rawSigs[0]);
        if (allSameNorm && allSameRaw) { mergedGrid[y][x] = cells.find(Boolean) || null; continue; }
        // if normalized same but raw differs (e.g. different dyes/colors), cycle them
        if (allSameNorm && !allSameRaw) {
          const itemOpts = [];
          for (const c of cells) { if (!c) continue; if (c.kind === 'item') itemOpts.push(c); else if (c.kind === 'alternatives') itemOpts.push(...(c.options||[])); else itemOpts.push(c); }
          const uniq = []; const seenIds = new Set();
          for (const o of itemOpts) { const k=o.kind+':'+(o.id||JSON.stringify(o)); if (seenIds.has(k)) continue; seenIds.add(k); uniq.push(o); }
          const allColor = uniq.length > 1 && uniq.every(o => o.kind === 'item' && isColorVariantItem(o.id));
          const baseId = resultBaseId((arr[0]?.result?.id)||'');
          mergedGrid[y][x] = uniq.length === 1 ? uniq[0] : { kind: allColor ? 'variant-cycle' : 'tag', id: `variants:${baseId}:${y}${x}`, name: `变体(${uniq.length})`, options: uniq, cycle: uniq.length > 1, hasVisual: uniq.some(o=>o.icon||o.model3d) };
          continue;
        }
        // if all are single item and only differ by color/dye, create cycle-like alternatives
        const itemOpts = [];
        for (const c of cells) {
          if (!c) continue;
          if (c.kind === 'item') itemOpts.push(c);
          else if (c.kind === 'alternatives') itemOpts.push(...(c.options||[]));
          else itemOpts.push(c);
        }
        const uniq = [];
        const seenIds = new Set();
        for (const o of itemOpts) {
          const k = o.kind+':'+(o.id||JSON.stringify(o));
          if (seenIds.has(k)) continue; seenIds.add(k); uniq.push(o);
        }
        const allColor = uniq.length > 1 && uniq.every(o => o.kind === 'item' && isColorVariantItem(o.id));
        mergedGrid[y][x] = uniq.length === 1 ? uniq[0] : { kind: allColor ? 'variant-cycle' : 'tag', id: `variants:${base}:${y}${x}`, name: `变体(${uniq.length})`, options: uniq, cycle: uniq.length > 1, hasVisual: uniq.some(o=>o.icon||o.model3d) };
      }
      // merged result: cycle options
      const resOpts = [];
      const seenR = new Set();
      for (const r of arr) {
        const rr = r.result; if (!rr) continue;
        const k = rr.id + '|' + JSON.stringify(rr.components||'');
        if (seenR.has(k)) continue; seenR.add(k); resOpts.push(rr);
      }
      const mergedResult = resOpts.length <= 1 ? first.result : {
        ...first.result,
        name: (first.result?.name||'').replace(/(白色|橙色|品红色|淡蓝色|黄色|黄绿色|粉色|灰色|淡灰色|青色|紫色|蓝色|棕色|绿色|红色|黑色)/,'') .replace(/^(White|Orange|Magenta|Light Blue|Yellow|Lime|Pink|Gray|Light Gray|Cyan|Purple|Blue|Brown|Green|Red|Black)\s+/i,'') || first.result?.name,
        options: resOpts,
        cycle: true,
        variantCount: resOpts.length,
      };
      const notes = Array.from(new Set(arr.flatMap(r => r.notes || [])));
      notes.push(`已合并 ${arr.length} 个相似变体配方`);
      const stationItemIds = first.recipeCategory === 'cooking'
        ? Array.from(new Set([...stationSet, 'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker']))
        : stationSet;
      const stationItems = stationItemIds.map(sid => resolveStationItem(sid));
      out.push({
        ...first,
        station: stationSet[0] || first.station,
        stations: stationSet.length ? stationSet : (first.station ? [first.station] : []),
        stationItems,
        grid: mergedGrid,
        result: mergedResult,
        variants,
        variantCount: arr.length,
        notes,
        parseQuality: mergeParseQuality(arr.map(r => r.parseQuality)),
      });
    }
    return out;
  }

  const collapsed = collapseVariants(analyzed);
  const all = collapsed.concat(advancementItems);
  const byCategory = {};
  for (const r of all) {
    const k = r.classification?.category || '未知';
    byCategory[k] ??= [];
    byCategory[k].push(r);
  }
  const statsAfter = getRenderStats();
  const iconRenderStats = {
    itemModelMappingHit: statsAfter.itemModelMappingHit - statsBefore.itemModelMappingHit,
    itemModelMappingFallback2D: statsAfter.itemModelMappingFallback2D - statsBefore.itemModelMappingFallback2D,
    itemModelMappingMissing: statsAfter.itemModelMappingMissing - statsBefore.itemModelMappingMissing,
  };
  const suspicious = analyzed.filter(r => r.parseQuality?.suspicious);
  const coverage = {
    ...parseStats,
    // advancement/recipes/ 下的文件也落在 recipe 路径里，会被扫到但不算配方；
    // 把它们从分母剔除，否则原版 jar 的解析率会假性跌到 50%。
    parseRate: (parseStats.recipeFilesScanned - (parseStats.advancementFilesSkipped || 0))
      ? +(parseStats.recipesParsed / (parseStats.recipeFilesScanned - parseStats.advancementFilesSkipped)).toFixed(4)
      : 1,
    inferredRecipes: analyzed.filter(r => r.parseQuality?.inferred).length,
    totalIngredients: analyzed.reduce((s, r) => s + (r.parseQuality?.ingredientCount || 0), 0),
    unknownIngredients: analyzed.reduce((s, r) => s + (r.parseQuality?.unknownIngredients || 0), 0),
    suspiciousRecipes: suspicious.length,
    suspiciousReasons: Object.fromEntries(
      Array.from(new Set(suspicious.flatMap(r => r.parseQuality?.reasons || [])))
        .map(reason => [reason, suspicious.filter(r => r.parseQuality?.reasons?.includes(reason)).length])
        .sort((a, b) => b[1] - a[1])
    ),
  };
  const summary = {
    modFile: path.basename(jarPath),
    recipeCount: analyzed.length,
    collapsedRecipeCount: collapsed.length,
    advancementItemCount: advancementItems.length,
    totalCount: all.length,
    categories: Object.fromEntries(Object.entries(byCategory).map(([k,v]) => [k, v.length]).sort((a,b)=>b[1]-a[1])),
    vanillaJar: vanilla?.jarPath || null,
    vanillaLoaded: !!vanilla?.ok,
    coverage,
    iconRenderStats,
  };

  const out = { summary, recipes: all, recipeEntries: analyzed, collapsedRecipes: collapsed, advancementItems, byCategory, advancements };
  fs.writeFileSync(path.join(outDir, 'analysis.json'), JSON.stringify(out), 'utf8');
  return out;
}

let prewarmState = { running: false, done: 0, total: 0, rendered: 0, ok: false };
export function getPrewarmProgress() { return { ...prewarmState }; }

export async function prewarmVanillaRenders(options = {}) {
  const mcVersion = normalizeMcVersion(options.mcVersion);
  const vanilla = loadVanillaAssets(mcVersion, options.vanillaJar || null);
  if (!vanilla?.ok) { prewarmState = { ...prewarmState, ok: false }; return { ok: false, reason: 'vanilla-not-loaded' }; }
  const outDir = path.join(process.cwd(), 'data', 'vanilla-renders', mcVersion);
  fs.mkdirSync(outDir, { recursive: true });
  const entries = new Map(); // empty mod entries
  const assetIndex = buildAssetIndex(entries, vanilla);
  const modelCache = new Map();
  const pngReadCache = new Map();
  let rendered = 0, skipped = 0;
  const candidates = [];
  for (const [p] of vanilla.entries) {
    const m = p.match(/^assets\/minecraft\/models\/item\/(.+)\.json$/);
    if (m) candidates.push(`minecraft:${m[1]}`);
  }
  prewarmState = { running: true, mcVersion, done: 0, total: candidates.length, rendered: 0, ok: false };
  try {
    for (const id of candidates) {
      const render = resolveItemRender(id, assetIndex, entries, vanilla, modelCache);
      if (render.mode === '3d') {
        const file = path.join(outDir, `${id.replace(/[:/\\]/g,'_')}.png`);
        if (fs.existsSync(file)) { skipped++; }
        else {
          const rawTex = render.model.textures || {};
          const texFileByRef = {};
          for (const [k, v] of Object.entries(rawTex)) {
            if (typeof v !== 'string' || v.startsWith('#')) continue;
            const norm = v.includes(':') ? `assets/${v.split(':')[0]}/textures/${v.split(':')[1]}.png` : `assets/${render.ns}/textures/${v}.png`;
            const e = vanilla.entries.get(norm);
            if (!e) continue;
            const tmp = path.join(outDir, `_tex_${norm.replace(/^assets\//,'').replace(/[\/\\]/g,'_')}`);
            if (!fs.existsSync(tmp)) fs.writeFileSync(tmp, e.getData());
            texFileByRef[v] = tmp; texFileByRef[k] = tmp;
          }
          const png = renderModel3DToPng(addTintColors(id, { elements: render.model.elements, textures: rawTex }, vanilla), texFileByRef, 64, pngReadCache);
          if (png) { fs.writeFileSync(file, PNG.sync.write(png)); rendered++; } else { skipped++; }
        }
      } else { skipped++; }
      prewarmState.done++;
      prewarmState.rendered = rendered;
      // 每 16 个让出事件循环，避免上千个方块的同步软光栅阻塞 HTTP 请求
      if (prewarmState.done % 16 === 0) await new Promise(r => setImmediate(r));
    }
    prewarmState.ok = true;
    // cleanup temp tex
    for (const f of fs.readdirSync(outDir)) { if (f.startsWith('_tex_')) try { fs.unlinkSync(path.join(outDir,f)); } catch {} }
    return { ok: true, rendered, skipped, dir: outDir };
  } finally {
    prewarmState.running = false;
  }
}

// tintindex：草/藤蔓/树苗/树叶等纹理本身是灰白的，渲染时要乘 biome colormap。
// 静态渲染没有 biome 上下文，取 colormap 中心像素（温带默认值）作为近似。
export function addTintColors(id, model3d, vanilla) {
  const hasTint = (model3d?.elements || []).some(el =>
    Object.values(el?.faces || {}).some(f => typeof f?.tintindex === 'number'));
  if (!hasTint || !vanilla?.entries) return model3d;
  const name = String(id || '').toLowerCase();
  const cmapPath = /grass|vine|sapling|sugar_cane/.test(name)
    ? 'assets/minecraft/textures/colormap/grass.png'
    : 'assets/minecraft/textures/colormap/foliage.png';
  const e = vanilla.entries.get(cmapPath);
  if (!e) return model3d;
  try {
    const cmap = PNG.sync.read(e.getData());
    const px = Math.floor(cmap.width / 2), py = Math.floor(cmap.height / 2);
    const i = (cmap.width * py + px) << 2;
    const color = [cmap.data[i], cmap.data[i + 1], cmap.data[i + 2]];
    const colors = {};
    for (const el of model3d.elements) {
      for (const f of Object.values(el?.faces || {})) {
        if (typeof f?.tintindex === 'number') colors[f.tintindex] = color;
      }
    }
    return { ...model3d, _tintColors: colors };
  } catch { return model3d; }
}
