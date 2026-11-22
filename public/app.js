const form = document.getElementById('uploadForm');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const resultsEl = document.getElementById('results');
const categoryFilter = document.getElementById('categoryFilter');
const searchInput = document.getElementById('searchInput');
const categoryStats = document.getElementById('categoryStats');
const vanillaStatus = document.getElementById('vanillaStatus');
const vanillaJarInput = document.getElementById('vanillaJar');
const includeVanillaEquivalentsInput = document.getElementById('includeVanillaEquivalents');
const tpl = document.getElementById('recipeTpl');

let allRecipes = [];
let hasAnalyzed = false;

async function refreshVanillaStatus() {
  const p = vanillaJarInput.value.trim();
  const url = p ? `/api/vanilla-status?path=${encodeURIComponent(p)}` : '/api/vanilla-status';
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (d.ok) vanillaStatus.textContent = `Vanilla fallback: 已加载 (${d.jarPath})`;
    else vanillaStatus.textContent = `Vanilla fallback: 未找到${d.jarPath ? ` (${d.jarPath})` : ''}。可填 1.21.1 client jar 路径或设置 VANILLA_JAR。`;
  } catch {
    vanillaStatus.textContent = 'Vanilla fallback: 状态检测失败';
  }
}
vanillaJarInput.addEventListener('change', refreshVanillaStatus);
refreshVanillaStatus();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('modFile').files[0];
  if (!file) return;
  statusEl.textContent = '上传并分析中...';
  resultsEl.innerHTML = '';
  summaryEl.innerHTML = '';
  categoryStats.innerHTML = '';
  const fd = new FormData();
  fd.append('mod', file);
  const vjar = vanillaJarInput.value.trim();
  if (vjar) fd.append('vanillaJar', vjar);
  if (includeVanillaEquivalentsInput?.checked) fd.append('includeVanillaEquivalents', '1');
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '分析失败');
    statusEl.textContent = `完成：${data.recipeCount} 个配方`;
    summaryEl.innerHTML = `<div><b>文件</b>: ${esc(data.modFile)}</div><div><b>配方数</b>: ${data.recipeCount}</div><div><b>Vanilla fallback</b>: ${data.vanillaLoaded ? esc(data.vanillaJar || 'loaded') : '未加载（minecraft 图标可能缺失）'}</div>`;
    const ares = await fetch(data.analysisUrl);
    const analysis = await ares.json();
    allRecipes = analysis.recipes || [];
    hasAnalyzed = true;
    buildCategoryFilter(analysis.summary?.categories || {});
    render();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `错误：${err.message}`;
  }
});

categoryFilter.addEventListener('change', render);
if (acqFilter) acqFilter.addEventListener('change', render);
searchInput.addEventListener('input', render);

function buildCategoryFilter(categories) {
  categoryFilter.innerHTML = '<option value="">全部</option>';
  categoryStats.innerHTML = '';
  for (const [k, v] of Object.entries(categories)) {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = `${k} (${v})`;
    categoryFilter.appendChild(opt);
    const s = document.createElement('span');
    s.className = 'stat';
    s.textContent = `${k}: ${v}`;
    categoryStats.appendChild(s);
  }
}

function render() {
  const cat = categoryFilter.value;
  const acq = acqFilter ? acqFilter.value : '';
  const q = searchInput.value.trim().toLowerCase();
  const filtered = allRecipes.filter(r => {
    if (cat && (r.classification?.category || '未知') !== cat) return false;
    if (acq && (r.acquisition || 'recipe') !== acq) return false;
    if (!q) return true;
    const hay = [r.result?.name, r.result?.id, r.type, r.recipeCategory, r.classification?.category, r.sourceFile, r.acquisition, ...(r.notes||[]), ...(r.advancements||[]).map(a=>a.title||a.description||'')].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  resultsEl.innerHTML = '';
  if (!filtered.length) {
    if (!hasAnalyzed) {
      resultsEl.innerHTML = `<div class="empty">请先上传一个 mod。</div>`;
    } else if (q || cat || acq) {
      resultsEl.innerHTML = `<div class="empty">没有匹配的配方。</div>`;
    } else {
      resultsEl.innerHTML = `<div class="empty">无配方</div>`;
    }
    return;
  }
  for (const r of filtered.slice(0, 300)) resultsEl.appendChild(renderRecipe(r));
  if (filtered.length > 300) {
    const more = document.createElement('div');
    more.className = 'empty';
    more.textContent = `已显示前 300 条，共 ${filtered.length} 条。请用筛选缩小范围。`;
    resultsEl.appendChild(more);
  }
}

function renderRecipe(r) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const result = r.result;
  const cls = r.classification?.category || '未知';
  const showResult = (result && result.cycle && result.options?.length) ? { ...result, kind:'tag', id: result.id, name: result.name, options: result.options, cycle: true } : result;
  node.querySelector('.result-slot').appendChild(slotContent(showResult, result?.count || 1, 40));
  node.querySelector('.result-name').textContent = (result?.name || '(无产物/未知)') + (r.variantCount ? ` [${r.variantCount}变体]` : '');
  node.querySelector('.result-id').textContent = result?.id || r.type || '';
  const tags = node.querySelector('.tags');
  addTag(tags, cls, cls === '未知' ? 'unknown' : '');
  if (r.acquisition === 'advancement') addTag(tags, '成就获取', 'acq-adv');
  else addTag(tags, '配方获取', 'acq-recipe');
  addTag(tags, r.recipeCategory || 'unknown');
  if (r.shapeless) addTag(tags, 'shapeless');
  if (r.special) addTag(tags, 'special/custom');

  const gridWrap = node.querySelector('.crafting');
  const grid = node.querySelector('.grid');
  const out = node.querySelector('.out');
  const isIngredientList = r.displayType === 'ingredients';
  const noGrid = r.displayType === 'advancement' || (!isIngredientList && (!r.grid || (r.special && !r.grid.flat().some(Boolean))));
  const isCooking = r.recipeCategory === 'cooking';
  if (noGrid) {
    if (grid) grid.style.display = 'none';
    const arrow = node.querySelector('.arrow');
    if (arrow) arrow.style.display = 'none';
    if (out) {
      out.innerHTML = '';
      const notes = (r.notes || []).filter(Boolean);
      if (notes.length) {
        const box = document.createElement('div');
        box.className = r.displayType === 'advancement' ? 'adv-box' : 'notes-box';
        const title = document.createElement('div');
        title.className = r.displayType === 'advancement' ? 'adv-title' : 'adv-title notes-title';
        title.textContent = r.displayType === 'advancement' ? '成就获得' : '特殊配方说明';
        box.appendChild(title);
        for (const n of notes) {
          const line = document.createElement('div');
          line.className = 'adv-line';
          line.textContent = n;
          box.appendChild(line);
        }
        out.appendChild(box);
      }
    }
  } else if (isIngredientList) {
    if (grid) grid.style.display = 'none';
    const arrow = node.querySelector('.arrow');
    if (arrow) arrow.style.display = 'none';
    if (out) {
      out.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'ingredient-layout';
      const list = document.createElement('div');
      list.className = 'ingredient-list';
      const ings = r.ingredients || [];
      if (!ings.length) {
        const empty = document.createElement('div');
        empty.className = 'adv-line';
        empty.textContent = '无可解析材料（模组自定义配方）';
        list.appendChild(empty);
      }
      for (const ing of ings) {
        const row = document.createElement('div');
        row.className = 'ingredient-row';
        const slot = document.createElement('div');
        slot.className = 'slot';
        slot.title = ing?.name || ing?.id || ing?.kind || '';
        slot.appendChild(slotContent(ing, 1, 32));
        const name = document.createElement('div');
        name.className = 'ingredient-name';
        name.textContent = ing?.name || ing?.id || ing?.kind || '未知材料';
        const count = document.createElement('div');
        count.className = 'ingredient-count';
        count.textContent = `x${ing?.count || 1}`;
        row.append(slot, name, count);
        list.appendChild(row);
      }
      const outSlot = document.createElement('div');
      outSlot.className = 'slot out-slot';
      outSlot.title = result?.name || result?.id || '';
      outSlot.appendChild(slotContent(result, result?.count || 1, 44));
      wrap.append(list, outSlot);
      out.appendChild(wrap);
    }
  } else if (isCooking) {
    if (grid) grid.style.display = 'none';
    const arrow = node.querySelector('.arrow');
    if (arrow) arrow.style.display = 'none';
    if (out) {
      out.innerHTML = '';
      const input = r.grid?.[0]?.[0] || null;
      const cook = document.createElement('div');
      cook.className = 'cooking-layout';

      const left = document.createElement('div');
      left.className = 'cooking-left';
      const inSlot = document.createElement('div');
      inSlot.className = 'slot cooking-slot';
      inSlot.title = input?.name || input?.id || '输入';
      inSlot.appendChild(slotContent(input, 1, 36));
      const flame = document.createElement('div');
      flame.className = 'cooking-flame';
      flame.innerHTML = '<div class="flame-icon"></div><div class="flame-progress"></div>';
      flame.title = stationLabelText(r);
      left.append(inSlot, flame);

      const mid = document.createElement('div');
      mid.className = 'cooking-mid';
      const prog = document.createElement('div');
      prog.className = 'cooking-arrow';
      prog.innerHTML = '<div class="cooking-arrow-bg"></div><div class="cooking-arrow-fill"></div>';
      mid.append(prog);

      const outSlot = document.createElement('div');
      outSlot.className = 'slot out-slot cooking-out';
      outSlot.title = result?.name || result?.id || '';
      outSlot.appendChild(slotContent(result, result?.count || 1, 44));

      const stations = document.createElement('div');
      stations.className = 'cooking-stations';
      stations.appendChild(renderCookingStations(r));

      cook.append(left, mid, outSlot, stations);
      out.appendChild(cook);
    }
  } else {
    const g = r.grid || emptyGrid();
    for (let y=0;y<3;y++) for (let x=0;x<3;x++) {
      const cell = g[y]?.[x] || null;
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.title = cell?.name || cell?.id || cell?.kind || '';
      slot.appendChild(slotContent(cell, 1, 32));
      grid.appendChild(slot);
    }
    const outSlot = document.createElement('div');
    outSlot.className = 'slot out-slot';
    outSlot.title = result?.name || result?.id || '';
    outSlot.appendChild(slotContent(result, result?.count || 1, 36));
    out.appendChild(outSlot);
  }

  const srcEl = node.querySelector('.source-path');
  srcEl.textContent = r.sourceFile || '';
  srcEl.title = srcEl.textContent;

  const notes = (r.notes || []).filter(Boolean);
  const hideGrid = r.displayType === 'advancement' || r.displayType === 'ingredients' || !r.grid || (r.special && !r.grid.flat().some(Boolean));
  if (notes.length && r.displayType !== 'advancement' && !hideGrid) {
    const box = document.createElement('div');
    box.className = 'notes-box';
    for (const n of notes) {
      const line = document.createElement('div');
      line.className = 'adv-line';
      line.textContent = n;
      box.appendChild(line);
    }
    const srcDetails = node.querySelector('.source');
    node.insertBefore(box, srcDetails);
  }
  return node;
}

function slotContent(ing, count=1, size=32) {
  const frag = document.createDocumentFragment();
  if (!ing) return frag;
  if (ing.kind === 'alternatives') {
    const first = ing.options?.[0];
    if (first) frag.appendChild(slotContent(first, count, size));
    const c = document.createElement('span');
    c.className = 'count'; c.textContent = '*';
    c.title = `可选: ${(ing.options||[]).map(o=>o.name||o.id||o.kind).join(' | ')}`;
    frag.appendChild(c);
    return frag;
  }
  if ((ing.kind === 'tag' || ing.cycle) && Array.isArray(ing.options) && ing.options.length) {
    const wrap = document.createElement('div');
    wrap.className = 'cycle-wrap';
    wrap.style.width = size + 'px'; wrap.style.height = size + 'px'; wrap.style.position = 'relative';
    const inner = document.createElement('div');
    inner.className = 'cycle-inner';
    inner.style.width = '100%'; inner.style.height = '100%'; inner.style.display='flex'; inner.style.alignItems='center'; inner.style.justifyContent='center';
    wrap.appendChild(inner);
    const badge = document.createElement('span');
    badge.className = 'tag-badge';
    badge.textContent = ing.kind === 'tag' ? '#' : '↻';
    badge.title = ing.name || ing.id || 'variants';
    wrap.appendChild(badge);
    frag.appendChild(wrap);
    startCycle(inner, ing.options, size, ing.name || ing.id || 'variants');
    if (count && count > 1) {
      const c = document.createElement('span');
      c.className = 'count'; c.textContent = String(count);
      frag.appendChild(c);
    }
    return frag;
  }

  if (ing.model3d && ing.model3d.elements?.length) {
    const canvas = document.createElement('canvas');
    canvas.width = size * 2; canvas.height = size * 2;
    canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
    canvas.className = 'model3d';
    canvas.__model3d = ing.model3d;
    canvas.__fallback = { icon: ing.icon, ing, size };
    frag.appendChild(canvas);
    observe3D(canvas);
  } else if (ing.icon) {
    frag.appendChild(iconImg(ing.icon, ing, size));
  } else {
    frag.appendChild(textPlaceholder(ing, size));
  }

  if (count && count > 1) {
    const c = document.createElement('span');
    c.className = 'count'; c.textContent = String(count);
    frag.appendChild(c);
  }
  return frag;
}

function iconImg(src, ing, size) {
  const img = document.createElement('img');
  img.src = src; img.alt = ing.name || ing.id || ''; img.loading = 'lazy';
  img.style.width = size+'px'; img.style.height = size+'px';
  img.onerror = () => { img.replaceWith(textPlaceholder(ing)); };
  return img;
}

function textPlaceholder(ing, size=32) {
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.style.width = (size-4)+'px';
  ph.style.maxHeight = (size-4)+'px';
  ph.style.overflow = 'hidden';
  const label = ing?.name || ing?.id || ing?.kind || '?';
  ph.textContent = label.length > 10 ? label.slice(0,9)+'…' : label;
  ph.title = ing.name || ing.id || JSON.stringify(ing.raw || ing);
  return ph;
}

function addTag(container, text, extra='') {
  const s = document.createElement('span');
  s.className = `tag ${extra}`.trim(); s.textContent = text;
  container.appendChild(s);
}
function emptyGrid(){ return [[null,null,null],[null,null,null],[null,null,null]]; }
function esc(s){ return String(s).replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m])); }
function stationName(id='') {
  const t = String(id);
  if (t === 'minecraft:smoker' || t.includes('smoking')) return '烟熏炉';
  if (t === 'minecraft:blast_furnace' || t.includes('blasting')) return '高炉';
  if (t === 'minecraft:campfire' || t.includes('campfire')) return '营火';
  if (t === 'minecraft:furnace' || t.includes('smelting')) return '熔炉';
  return t.split(':').pop() || t;
}

function stationLabelText(r) {
  const ids = (r.stations?.length ? r.stations : (r.station ? [r.station] : [])).filter(Boolean);
  if (!ids.length) return stationName(r.type);
  return ids.map(stationName).join(' / ');
}

function renderCookingStations(r) {
  const active = new Set((r.stations?.length ? r.stations : (r.station ? [r.station] : [])).filter(Boolean));
  const vanilla = ['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'];
  const wrap = document.createElement('div');
  wrap.className = 'station-slots';

  for (const id of vanilla) {
    const slot = document.createElement('div');
    const on = active.has(id);
    slot.className = `slot station-slot ${on ? 'active' : 'inactive'}`;
    slot.title = `${stationName(id)}${on ? '（可用）' : '（不可用）'}`;
    const item = (r.stationItems || []).find(s => s.id === id) || { kind:'item', id, name: stationName(id) };
    slot.appendChild(slotContent(item, 1, 28));
    if (!on) {
      const veil = document.createElement('div');
      veil.className = 'station-dim';
      slot.appendChild(veil);
    }
    wrap.appendChild(slot);
  }

  const custom = [...active].filter(id => !vanilla.includes(id));
  for (const id of custom) {
    const slot = document.createElement('div');
    slot.className = 'slot station-slot active custom';
    const item = (r.stationItems || []).find(s => s.id === id) || { kind:'item', id, name: stationName(id) };
    slot.title = `${item.name || stationName(id)}（模组熔炉）`;
    slot.appendChild(slotContent(item, 1, 28));
    wrap.appendChild(slot);
  }

  return wrap;
}



const model3dObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const c = e.target;
    model3dObserver.unobserve(c);
    if (c.__rendered) continue;
    c.__rendered = true;
    const m = c.__model3d; const fb = c.__fallback;
    renderModel3D(c, m).catch(() => {
      if (fb?.icon) c.replaceWith(iconImg(fb.icon, fb.ing, fb.size));
      else c.replaceWith(textPlaceholder(fb?.ing || {}));
    });
  }
}, { rootMargin: '200px' }) : null;
function observe3D(canvas) {
  if (model3dObserver) model3dObserver.observe(canvas);
  else {
    const m = canvas.__model3d; const fb = canvas.__fallback;
    renderModel3D(canvas, m).catch(() => { if (fb?.icon) canvas.replaceWith(iconImg(fb.icon, fb.ing, fb.size)); else canvas.replaceWith(textPlaceholder(fb?.ing||{})); });
  }
}


const cycleRegistry = new Set();
let cycleTimer = null;
function startCycle(container, options, size, title) {
  container.__cycle = { options, size, idx: 0, title };
  renderCycleFrame(container);
  cycleRegistry.add(container);
  if (!cycleTimer) cycleTimer = setInterval(() => {
    for (const c of cycleRegistry) {
      if (!c.isConnected) { cycleRegistry.delete(c); continue; }
      const st = c.__cycle; if (!st || !st.options?.length) continue;
      st.idx = (st.idx + 1) % st.options.length;
      renderCycleFrame(c);
    }
    if (cycleRegistry.size === 0 && cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
  }, 1000);
}
function renderCycleFrame(container) {
  const st = container.__cycle; if (!st) return;
  const opt = st.options[st.idx % st.options.length];
  container.innerHTML = '';
  if (opt?.model3d && opt.model3d.elements?.length) {
    const canvas = document.createElement('canvas');
    canvas.width = st.size * 2; canvas.height = st.size * 2;
    canvas.style.width = st.size + 'px'; canvas.style.height = st.size + 'px';
    canvas.className = 'model3d';
    canvas.__model3d = opt.model3d;
    canvas.__fallback = { icon: opt.icon, ing: opt, size: st.size };
    container.appendChild(canvas);
    observe3D(canvas);
  } else if (opt?.icon) {
    container.appendChild(iconImg(opt.icon, opt, st.size));
  } else {
    container.appendChild(textPlaceholder(opt || {name: st.title}));
  }
  container.title = `${st.title}\n${opt?.name || opt?.id || ''} (${st.idx+1}/${st.options.length})`;
  const parent = container.closest('.slot, .result-slot, .out-slot');
  if (parent) parent.title = container.title;
}
// ---- 3D model renderer (simple software rasterizer for Minecraft block models) ----
const texImageCache = new Map();
function loadImage(url) {
  if (texImageCache.has(url)) return texImageCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  texImageCache.set(url, p);
  return p;
}

function resolveTextureRef(ref, textures, textureUrls) {
  if (!ref) return null;
  let r = ref;
  let lastKey = null;
  for (let i=0; i<8 && typeof r === 'string' && r.startsWith('#'); i++) {
    lastKey = r.slice(1);
    const next = textures[lastKey];
    if (!next) return textureUrls[lastKey] || null;
    r = next;
  }
  if (typeof r !== 'string') return null;
  if (r.startsWith('/data/')) return r;
  if (textureUrls[r]) return textureUrls[r];
  if (lastKey && textureUrls[lastKey]) return textureUrls[lastKey];
  // try matching by texture name
  for (const [k,v] of Object.entries(textureUrls||{})) {
    if (typeof v !== 'string') continue;
    if (k === r || k === lastKey) return v;
  }
  // match by path suffix
  const tail = r.includes(':') ? r.split(':')[1] : r;
  for (const [k,v] of Object.entries(textureUrls||{})) {
    if (typeof v !== 'string') continue;
    const vt = v.toLowerCase();
    if (vt.includes(tail.toLowerCase().replace(/[\/\\]/g,'_'))) return v;
  }
  return null;
}

function matMul(a,b){ const o=new Float64Array(16); for(let r=0;r<4;r++) for(let c=0;c<4;c++) o[r*4+c]=a[r*4]*b[c]+a[r*4+1]*b[4+c]+a[r*4+2]*b[8+c]+a[r*4+3]*b[12+c]; return o; }
function matIdentity(){ const m=new Float64Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }
function matTranslate(tx,ty,tz){ const m=matIdentity(); m[12]=tx;m[13]=ty;m[14]=tz; return m; }
function matScale(sx,sy,sz){ const m=new Float64Array(16); m[0]=sx;m[5]=sy;m[10]=sz;m[15]=1; return m; }
function matRotateX(d){ const r=d*Math.PI/180,c=Math.cos(r),s=Math.sin(r),m=matIdentity(); m[5]=c;m[6]=s;m[9]=-s;m[10]=c; return m; }
function matRotateY(d){ const r=d*Math.PI/180,c=Math.cos(r),s=Math.sin(r),m=matIdentity(); m[0]=c;m[2]=-s;m[8]=s;m[10]=c; return m; }
function matRotateZ(d){ const r=d*Math.PI/180,c=Math.cos(r),s=Math.sin(r),m=matIdentity(); m[0]=c;m[1]=s;m[4]=-s;m[5]=c; return m; }
function vtx(m,v){ const x=v[0],y=v[1],z=v[2]; return [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]]; }

const FACE_DIRS = {
  north:{n:[0,0,-1],verts:(f,t)=>[[t[0],t[1],f[2]],[f[0],t[1],f[2]],[f[0],f[1],f[2]],[t[0],f[1],f[2]]]},
  south:{n:[0,0,1], verts:(f,t)=>[[f[0],t[1],t[2]],[t[0],t[1],t[2]],[t[0],f[1],t[2]],[f[0],f[1],t[2]]]},
  west: {n:[-1,0,0],verts:(f,t)=>[[f[0],t[1],f[2]],[f[0],t[1],t[2]],[f[0],f[1],t[2]],[f[0],f[1],f[2]]]},
  east: {n:[1,0,0], verts:(f,t)=>[[t[0],t[1],t[2]],[t[0],t[1],f[2]],[t[0],f[1],f[2]],[t[0],f[1],t[2]]]},
  up:   {n:[0,1,0], verts:(f,t)=>[[f[0],t[1],f[2]],[t[0],t[1],f[2]],[t[0],t[1],t[2]],[f[0],t[1],t[2]]]},
  down: {n:[0,-1,0],verts:(f,t)=>[[f[0],f[1],t[2]],[t[0],f[1],t[2]],[t[0],f[1],f[2]],[f[0],f[1],f[2]]]},
};
const FACE_SHADE = {up:1.0, down:0.5, north:0.8, south:0.8, east:0.6, west:0.6};


function defaultUV(face, from, to) {
  // Minecraft default face UVs based on element position
  switch(face) {
    case 'north': return [16-to[0], 16-to[1], 16-from[0], 16-from[1]];
    case 'south': return [from[0], 16-to[1], to[0], 16-from[1]];
    case 'west':  return [from[2], 16-to[1], to[2], 16-from[1]];
    case 'east':  return [16-to[2], 16-to[1], 16-from[2], 16-from[1]];
    case 'up':    return [from[0], from[2], to[0], to[2]];
    case 'down':  return [from[0], 16-to[2], to[0], 16-from[2]];
  }
  return [0,0,16,16];
}
async function renderModel3D(canvas, model3d) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  const textures = model3d.textures || {};
  const textureUrls = model3d.textureUrls || {};
  const elements = model3d.elements || [];
  if (!elements.length) throw new Error('no elements');
  const texW = 16;
  const texH = 16;

  // pre-load textures
  const texImgs = {};
  const urls = new Set(Object.values(textureUrls).filter(v => typeof v === 'string' && v.startsWith('/data/')));
  await Promise.all([...urls].map(async u => { try { texImgs[u] = await loadImage(u); } catch {} }));

  // GUI transform: isometric-like like vanilla item display
  const s = W * 0.0625; // 16 units -> canvas
  // Vanilla gui display approx: rotation [30,225,0], scale ~0.625, translation
  let M = matIdentity();
  M = matMul(M, matTranslate(W/2, H/2, 0));
  M = matMul(M, matScale(s*0.9, -s*0.9, s*0.9));
  M = matMul(M, matRotateX(30));
  M = matMul(M, matRotateY(225));
  M = matMul(M, matTranslate(-8, -8, -8));

  const quads = [];
  for (const el of elements) {
    const from = el.from || [0,0,0], to = el.to || [16,16,16];
    let EM = matIdentity();
    if (el.rotation) {
      const o = el.rotation.origin || [8,8,8];
      EM = matMul(EM, matTranslate(o[0],o[1],o[2]));
      const ang = el.rotation.angle || 0;
      if (el.rotation.axis === 'x') EM = matMul(EM, matRotateX(ang));
      if (el.rotation.axis === 'y') EM = matMul(EM, matRotateY(ang));
      if (el.rotation.axis === 'z') EM = matMul(EM, matRotateZ(ang));
      EM = matMul(EM, matTranslate(-o[0],-o[1],-o[2]));
    }
    for (const [fname, fdef] of Object.entries(FACE_DIRS)) {
      const face = el.faces?.[fname];
      if (!face) continue;
      const verts = fdef.verts(from,to).map(v => vtx(M, vtx(EM, v)));
      const depth = (verts[0][2]+verts[1][2]+verts[2][2]+verts[3][2])/4;
      const url = resolveTextureRef(face.texture, textures, textureUrls);
      const img = url ? texImgs[url] : null;
      const uv = face.uv || defaultUV(fname, from, to);
      quads.push({verts, depth, img, uv, shade: FACE_SHADE[fname]||1, tint: face.tintindex, tw: texW, th: texH});
    }
  }
  quads.sort((a,b)=>a.depth-b.depth);

  for (const q of quads) {
    drawQuad(ctx, q);
  }
  // fallback if nothing visible rendered
  try {
    const data = ctx.getImageData(0, 0, W, H).data;
    let visible = 0;
    for (let i = 3; i < data.length; i += 16) { if (data[i] > 10) { visible++; if (visible > 8) break; } }
    if (visible <= 8) throw new Error('blank render');
  } catch (e) { if (String(e.message).includes('blank')) throw e; }
}

function drawQuad(ctx, q) {
  const {verts, img, uv, shade} = q;
  // split into two triangles: 0,1,2 and 0,2,3
  const [u1,v1,u2,v2] = uv;
  const uvs = [[u1,v1],[u2,v1],[u2,v2],[u1,v2]];
  const tw = (img?.naturalWidth || q.tw || 16);
  const th = (img?.naturalHeight || q.th || 16);
  drawTri(ctx, [verts[0],verts[1],verts[2]], [uvs[0],uvs[1],uvs[2]], img, shade, tw, th);
  drawTri(ctx, [verts[0],verts[2],verts[3]], [uvs[0],uvs[2],uvs[3]], img, shade, tw, th);
}

function drawTri(ctx, pts, uvs, img, shade, tw=16, th=16) {
  const [p0,p1,p2] = pts; const [t0,t1,t2] = uvs;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0[0],p0[1]); ctx.lineTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.closePath();
  ctx.clip();
  if (img) {
    const iw = img.naturalWidth || tw, ih = img.naturalHeight || th;
    const sx0=t0[0]/tw*iw, sy0=t0[1]/th*ih, sx1=t1[0]/tw*iw, sy1=t1[1]/th*ih, sx2=t2[0]/tw*iw, sy2=t2[1]/th*ih;
    const denom = (sx0*(sy1-sy2)+sx1*(sy2-sy0)+sx2*(sy0-sy1));
    if (Math.abs(denom) > 1e-6) {
      const a = (p0[0]*(sy1-sy2)+p1[0]*(sy2-sy0)+p2[0]*(sy0-sy1))/denom;
      const b = (p0[1]*(sy1-sy2)+p1[1]*(sy2-sy0)+p2[1]*(sy0-sy1))/denom;
      const c = (p0[0]*(sx2-sx1)+p1[0]*(sx0-sx2)+p2[0]*(sx1-sx0))/denom;
      const d = (p0[1]*(sx2-sx1)+p1[1]*(sx0-sx2)+p2[1]*(sx1-sx0))/denom;
      const e = (p0[0]*(sx1*sy2-sx2*sy1)+p1[0]*(sx2*sy0-sx0*sy2)+p2[0]*(sx0*sy1-sx1*sy0))/denom;
      const f = (p0[1]*(sx1*sy2-sx2*sy1)+p1[1]*(sx2*sy0-sx0*sy2)+p2[1]*(sx0*sy1-sx1*sy0))/denom;
      ctx.setTransform(a,b,c,d,e,f);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
    }
  } else {
    ctx.fillStyle = `rgb(${120*shade},${120*shade},${120*shade})`;
    ctx.fill();
  }
  ctx.restore();
  // shade overlay
  if (img && shade < 0.999) {
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0[0],p0[1]); ctx.lineTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.closePath();
    ctx.fillStyle = `rgba(0,0,0,${1-shade})`;
    ctx.fill();
    ctx.restore();
  }
}

render();
