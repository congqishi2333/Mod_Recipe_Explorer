import { getJson, parseNamespaced } from './zip.js';

function textFrom(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (typeof v.translate === 'string') return v.translate;
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v)) return v.map(textFrom).filter(Boolean).join('');
  }
  return '';
}

export function collectAdvancements(entries, assetIndex) {
  const advs = [];
  for (const k of entries.keys()) {
    if (!k.startsWith('data/')) continue;
    if (!k.includes('/advancement/')) continue;
    if (!k.endsWith('.json')) continue;
    const json = getJson(entries, k);
    if (!json || typeof json !== 'object') continue;
    const display = json.display && typeof json.display === 'object' ? json.display : null;
    const rewards = json.rewards && typeof json.rewards === 'object' ? json.rewards : {};
    const recipeRewards = Array.isArray(rewards.recipes) ? rewards.recipes.filter(Boolean) : [];
    const loot = Array.isArray(rewards.loot) ? rewards.loot.filter(Boolean) : [];
    const titleRaw = textFrom(display?.title);
    const descRaw = textFrom(display?.description);
    const title = resolveLang(assetIndex, titleRaw) || titleRaw || k.split('/').pop().replace(/\.json$/,'');
    const description = resolveLang(assetIndex, descRaw) || descRaw || '';
    const iconItem = display?.icon?.id || display?.icon?.item || null;
    advs.push({
      id: k,
      sourceFile: k,
      title,
      description,
      iconItem,
      recipeRewards,
      loot,
      hasDisplay: !!display,
    });
  }
  return advs;
}

function resolveLang(assetIndex, key) {
  if (!key || typeof key !== 'string' || !key.includes('.')) return null;
  const langs = assetIndex?.langs || {};
  for (const ns of Object.keys(langs)) {
    for (const lang of ['zh_cn','en_us']) {
      const v = langs[ns]?.[lang]?.[key];
      if (v) return v;
    }
  }
  // also search all keys
  for (const ns of Object.keys(langs)) {
    for (const langDict of Object.values(langs[ns] || {})) {
      if (langDict[key]) return langDict[key];
    }
  }
  return null;
}

export function mapAdvancementsToItems(advancements) {
  const byItem = new Map(); // itemId -> [adv]
  for (const adv of advancements) {
    const targets = new Set();
    // Only map display icon as a representative item. Recipe rewards unlock recipes, not items.
    // Ignore vanilla namespace icons: they are often just display icons, not mod-obtained items.
    if (adv.iconItem) {
      const nid = normId(adv.iconItem);
      if (nid && !nid.startsWith('minecraft:')) targets.add(nid);
    }
    for (const id of targets) {
      if (!id) continue;
      const arr = byItem.get(id) || [];
      arr.push({ title: adv.title, description: adv.description, sourceFile: adv.sourceFile, id: adv.id, recipeRewards: adv.recipeRewards || [] });
      byItem.set(id, arr);
    }
  }
  return byItem;
}

function normId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.startsWith('#')) return null;
  if (id.includes(':')) return id;
  return `minecraft:${id}`;
}
