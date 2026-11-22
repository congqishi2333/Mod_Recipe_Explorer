import { isBlockLike } from './assets.js';
import { parseNamespaced } from './zip.js';

export function classifyRecipe(recipe, assetIndex) {
  const resultId = recipe?.result?.id;
  if (!resultId) {
    return { category: '未知', key: 'unknown', confidence: 0.2, reasons: ['no result id'] };
  }
  const p = parseNamespaced(resultId);
  const path = (p?.path || '').toLowerCase();
  const reasons = [];

  if (isBlockLike(assetIndex, resultId)) {
    reasons.push('has blockstate');
    return { category: '建筑方块', key: 'building_block', confidence: 0.82, reasons };
  }

  const rules = [
    ['武器', ['sword', 'bow', 'crossbow', 'trident', 'mace', 'spear', 'dagger', 'pencil', 'knife', 'blade', 'gun', 'rifle', 'cannon', 'whip', 'axe']],
    ['装备', ['helmet', 'chestplate', 'leggings', 'boots', 'armor', 'elytra', 'shield', 'binding', 'belt', 'necklace', 'hat', 'backpack']],
    ['工具', ['pickaxe', 'shovel', 'hoe', 'shears', 'flint_and_steel', 'fishing_rod', 'brush', 'wrench', 'hammer', 'binoculars', 'chalk', 'coupon', 'box', 'pillow', 'water_gun', 'bucket', 'compass', 'clock']],
    ['食物', ['apple', 'bread', 'stew', 'soup', 'cookie', 'cake', 'pie', 'beef', 'pork', 'chicken', 'mutton', 'fish', 'cod', 'salmon', 'carrot', 'potato', 'melon', 'berry', 'food', 'zongzi', 'drink', 'ginger', 'tea', 'disc']],
    ['材料', ['ingot', 'nugget', 'dust', 'gem', 'diamond', 'emerald', 'coal', 'stick', 'leather', 'string', 'slime', 'pearl', 'shard', 'plate', 'gear', 'rod', 'segment', 'bead']],
    ['装饰/功能', ['banner', 'candle', 'lantern', 'torch', 'painting', 'flower', 'pot', 'sign', 'bed', 'speaker', 'horn', 'bell', 'radio', 'harmonica', 'melodica', 'bulb', 'decoration', 'record', 'statue', 'furnace', 'table', 'chair', 'desk']],
  ];

  for (const [cat, kws] of rules) {
    for (const kw of kws) {
      if (path.includes(kw)) {
        if (kw === 'axe' && path.includes('pickaxe')) continue;
        reasons.push(`name contains ${kw}`);
        return { category: cat, key: cat, confidence: 0.72, reasons };
      }
    }
  }

  if (recipe.category === 'cooking') return { category: '食物', key: 'cooking', confidence: 0.55, reasons: ['cooking recipe'] };
  if (recipe.category === 'smithing') return { category: '装备', key: 'smithing', confidence: 0.55, reasons: ['smithing recipe'] };
  if (recipe.category === 'stonecutting') return { category: '建筑方块', key: 'stonecutting', confidence: 0.55, reasons: ['stonecutting recipe'] };

  return { category: '未知', key: 'unknown', confidence: 0.3, reasons: ['no rule matched'] };
}
