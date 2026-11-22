import { getJson, listJsonUnder, parseNamespaced } from './zip.js';

const RECIPE_ROOTS = [
  'data/', // we'll filter for /recipes/ or /recipe/
];

function isAdvancementRecipe(json, file) {
  if (file.includes('/advancement/')) return true;
  // advancement reward recipes often have criteria/parent/rewards without crafting fields
  if (json && typeof json === 'object' && !json.type && (json.criteria || json.parent || json.rewards)) return true;
  return false;
}

export function collectRecipes(entries, stats = null) {
  const files = [];
  for (const k of entries.keys()) {
    if (!k.endsWith('.json')) continue;
    if (!k.startsWith('data/')) continue;
    if (k.includes('/recipes/') || k.includes('/recipe/')) files.push(k);
  }
  files.sort();
  const recipes = [];
  if (stats) Object.assign(stats, {
    recipeFilesScanned: files.length,
    recipesParsed: 0,
    invalidJsonFiles: 0,
    advancementFilesSkipped: 0,
    unknownTypeRecipes: 0,
  });
  for (const file of files) {
    const json = getJson(entries, file);
    if (!json || typeof json !== 'object') { if (stats) stats.invalidJsonFiles++; continue; }
    if (isAdvancementRecipe(json, file)) { if (stats) stats.advancementFilesSkipped++; continue; }
    const norm = normalizeRecipe(json, file);
    if (stats) {
      stats.recipesParsed++;
      if (norm.type === 'unknown' || norm.category === 'unknown') stats.unknownTypeRecipes++;
    }
    recipes.push(norm);
  }
  return recipes;
}

function normalizeRecipe(json, file) {
  const type = json.type || 'unknown';
  const base = {
    sourceFile: file,
    type,
    category: 'unknown',
    rawType: type,
  };

  if (type === 'minecraft:crafting_shaped') {
    return { ...base, category: 'crafting_shaped', ...normalizeShaped(json) };
  }
  if (type === 'minecraft:crafting_shapeless') {
    return { ...base, category: 'crafting_shapeless', ...normalizeShapeless(json) };
  }
  if (type === 'minecraft:smelting' || type === 'minecraft:blasting' || type === 'minecraft:smoking' || type === 'minecraft:campfire_cooking') {
    return { ...base, category: 'cooking', ...normalizeCooking(json, type) };
  }
  if (type === 'minecraft:stonecutting') {
    return { ...base, category: 'stonecutting', ...normalizeStonecutting(json) };
  }
  if (type === 'minecraft:smithing_transform' || type === 'minecraft:smithing_trim') {
    return { ...base, category: 'smithing', ...normalizeSmithing(json) };
  }
  if (type.includes('anvil')) {
    return { ...base, category: 'anvil', ...normalizeAnvil(json) };
  }
  // unknown / modded custom: try to infer shape from fields
  if (Array.isArray(json.pattern) && json.key && typeof json.key === 'object') {
    return { ...base, category: 'crafting_shaped', ...normalizeShaped(json), inferred: true };
  }
  if (Array.isArray(json.ingredients)) {
    const oversized = json.ingredients.length > 9 || !!json.dimension || !!json.structure || String(type).includes('space_station');
    return { ...base, category: 'crafting_shapeless', ...normalizeShapeless(json), inferred: true, oversized, station: json.dimension ? `space_station:${json.dimension}` : (json.station || null) };
  }
  // common modded machine recipes (Thermal/Mekanism/Create-like): single ingredient + result(s)
  if (json.ingredient && (json.result || json.results || json.output)) {
    return { ...base, category: 'machine', ...normalizeMachine(json, type), inferred: true };
  }
  if (json.ingredient) {
    return { ...base, category: 'cooking', ...normalizeCooking(json, type), inferred: true };
  }
  if (json.template || json.base || json.addition) {
    return { ...base, category: 'smithing', ...normalizeSmithing(json), inferred: true };
  }
  if (json.left || json.right || json.input1 || json.input2) {
    return { ...base, category: 'anvil', ...normalizeAnvil(json), inferred: true };
  }
  return { ...base, category: 'unknown', ...bestEffortResult(json, file) };
}

function normIngredient(ing) {
  if (!ing) return null;
  if (Array.isArray(ing)) {
    const opts = ing.map(normIngredient).filter(Boolean);
    if (opts.length === 0) return null;
    if (opts.length === 1) return opts[0];
    return { kind: 'alternatives', options: opts };
  }
  if (typeof ing === 'string') return fromIdString(ing);
  if (typeof ing === 'object') {
    // Ad Astra / modded wrapped ingredient: { count, ingredient: { tag/item/... } }
    if (ing.ingredient && typeof ing.ingredient === 'object') {
      const inner = normIngredient(ing.ingredient);
      if (inner && ing.count) return { ...inner, count: ing.count };
      if (inner) return inner;
    }
    if (ing.item) return ing.count ? { kind: 'item', id: ing.item, count: ing.count } : { kind: 'item', id: ing.item };
    if (ing.tag) return ing.count ? { kind: 'tag', id: ing.tag, count: ing.count } : { kind: 'tag', id: ing.tag };
    if (ing.id) return ing.count ? { kind: 'item', id: ing.id, count: ing.count } : { kind: 'item', id: ing.id }; // sometimes
    // forge/neoforge sometimes {items:[...]} or {type:..., ...}
    if (Array.isArray(ing.items)) return normIngredient(ing.items.map(i => ({ item: i })));
    // ingredient with value wrapper
    if (ing.value) return normIngredient(ing.value);
  }
  return { kind: 'unknown', raw: ing };
}

function fromIdString(s) {
  if (s.startsWith('#')) return { kind: 'tag', id: s.slice(1) };
  return { kind: 'item', id: s };
}

function normalizeShaped(json) {
  const patternRaw = Array.isArray(json.pattern) ? json.pattern : [];
  const pattern = patternRaw.slice(0, 3);
  const key = json.key && typeof json.key === 'object' ? json.key : {};
  const width = Math.max(0, ...pattern.map(r => String(r).length));
  const grid = [];
  for (let y = 0; y < 3; y++) {
    const rowStr = String(pattern[y] || '');
    const row = [];
    for (let x = 0; x < 3; x++) {
      const ch = rowStr[x] || ' ';
      if (ch === ' ') { row.push(null); continue; }
      row.push(normIngredient(key[ch]));
    }
    grid.push(row);
  }
  const oversized = patternRaw.length > 3 || patternRaw.some(r => String(r).length > 3);
  const ingredients = [];
  for (const row of patternRaw) {
    for (const ch of String(row)) {
      if (ch === ' ') continue;
      const ing = normIngredient(key[ch]);
      if (ing) ingredients.push(ing);
    }
  }
  return {
    grid,
    width: Math.min(3, width || 0),
    height: Math.min(3, pattern.length),
    oversized,
    ingredients,
    result: normalizeResult(json.result),
  };
}

function normalizeShapeless(json) {
  const ings = Array.isArray(json.ingredients) ? json.ingredients : [];
  const flatAll = ings.map(normIngredient).filter(Boolean);
  const flat = flatAll.slice(0, 9);
  const grid = [];
  for (let y = 0; y < 3; y++) {
    const row = [];
    for (let x = 0; x < 3; x++) {
      row.push(flat[y*3+x] || null);
    }
    grid.push(row);
  }
  return { grid, width: 3, height: 3, shapeless: true, ingredients: flatAll, result: normalizeResult(json.result) };
}

function normalizeCooking(json, type = 'minecraft:smelting') {
  const ing = normIngredient(json.ingredient);
  const grid = [[ing, null, null],[null,null,null],[null,null,null]];
  const station = cookingStationFromType(type);
  return { grid, width: 1, height: 1, station, result: normalizeResult(json.result || json.output || null) };
}

function normalizeMachine(json, type = 'unknown') {
  const ing = normIngredient(json.ingredient);
  const grid = [[ing, null, null],[null,null,null],[null,null,null]];
  const result = normalizeResult(json.result || json.results || json.output || null);
  return { grid, width: 1, height: 1, station: type, machine: true, result };
}

function cookingStationFromType(type = '') {
  const t = String(type);
  if (t === 'minecraft:smelting') return 'minecraft:furnace';
  if (t === 'minecraft:blasting') return 'minecraft:blast_furnace';
  if (t === 'minecraft:smoking') return 'minecraft:smoker';
  if (t === 'minecraft:campfire_cooking') return 'minecraft:campfire';
  // modded/custom cooking type - keep type as station identity for display
  if (t && t !== 'unknown') return t;
  return 'minecraft:furnace';
}

function normalizeStonecutting(json) {
  const ing = normIngredient(json.ingredient);
  const grid = [[ing, null, null],[null,null,null],[null,null,null]];
  let result = json.result;
  if (typeof result === 'string') result = { id: result, count: json.count || 1 };
  return { grid, width: 1, height: 1, result: normalizeResult(result) };
}

function normalizeSmithing(json) {
  // 1.20+ smithing_transform: template, base, addition -> result
  const t = normIngredient(json.template);
  const b = normIngredient(json.base);
  const a = normIngredient(json.addition);
  const grid = [[t,b,a],[null,null,null],[null,null,null]];
  return { grid, width: 3, height: 1, station: 'smithing_table', result: normalizeResult(json.result) };
}

function normalizeAnvil(json) {
  const left = normIngredient(json.left || json.base || json.input1 || json.target || json.item);
  const right = normIngredient(json.right || json.addition || json.input2 || json.material || json.sacrifice);
  const grid = [[left, right, null],[null,null,null],[null,null,null]];
  return { grid, width: 2, height: 1, station: 'anvil', result: normalizeResult(json.result || json.output) };
}

function normalizeResult(r) {
  if (!r) return null;
  if (Array.isArray(r)) {
    for (const entry of r) {
      const n = normalizeResult(entry);
      if (n?.id) return n;
    }
    return r.length ? { raw: r[0] } : null;
  }
  if (typeof r === 'string') return { id: r, count: 1 };
  if (typeof r === 'object') {
    const id = r.id || r.item || r.result || null;
    const count = r.count || 1;
    const components = r.components || null;
    return id ? { id, count, ...(components ? { components } : {}) } : { raw: r };
  }
  return { raw: r };
}

function inferResultFromFile(file) {
  // data/<ns>/recipe/<path>.json -> <ns>:<path-last-segment> (best guess)
  const m = String(file||'').match(/^data\/([^/]+)\/recipes?\/(.+)\.json$/);
  if (!m) return null;
  const ns = m[1];
  const p = m[2].split('/').pop();
  if (!p) return null;
  return { id: `${ns}:${p}`, count: 1, inferred: true };
}

function bestEffortResult(json, file) {
  const candidates = [json.result, json.output, json.results, json.item];
  let result = null;
  for (const c of candidates) {
    const r = normalizeResult(Array.isArray(c) ? c[0] : c);
    if (r?.id) { result = r; break; }
  }
  if (!result) result = inferResultFromFile(file);
  // try to show ingredients if any
  let grid = emptyGrid();
  const ings = [];
  const collect = (v) => { const n = normIngredient(v); if (n) ings.push(n); };
  if (Array.isArray(json.ingredients)) json.ingredients.forEach(collect);
  if (json.ingredient) collect(json.ingredient);
  if (json.addition) collect(json.addition);
  if (json.base) collect(json.base);
  if (json.template) collect(json.template);
  if (json.input) collect(json.input);
  if (Array.isArray(json.inputs)) json.inputs.forEach(collect);
  if (json.key && typeof json.key === 'object') Object.values(json.key).forEach(collect);
  const flat = ings.slice(0,9);
  if (flat.length) {
    for (let y=0;y<3;y++) for (let x=0;x<3;x++) grid[y][x]=flat[y*3+x]||null;
  }
  return { result, grid, special: true };
}

function emptyGrid() {
  return [[null,null,null],[null,null,null],[null,null,null]];
}
