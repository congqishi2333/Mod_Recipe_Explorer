const form = document.getElementById('uploadForm');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const resultsEl = document.getElementById('results');
const jumpBar = document.getElementById('jumpBar');
const categoryFilter = document.getElementById('categoryFilter');
const searchInput = document.getElementById('searchInput');
const categoryStats = document.getElementById('categoryStats');
const vanillaStatus = document.getElementById('vanillaStatus');
const vanillaJarInput = document.getElementById('vanillaJar');
const mcVersionSelect = document.getElementById('mcVersion');
const includeVanillaEquivalentsInput = document.getElementById('includeVanillaEquivalents');
const suspiciousOnly = document.getElementById('suspiciousOnly');
const auditDashboard = document.getElementById('auditDashboard');
const iconRenderStatsEl = document.getElementById('iconRenderStats');
const dependencyDashboard = document.getElementById('dependencyDashboard');
const exportSuspicious = document.getElementById('exportSuspicious');
const downloadAnalysis = document.getElementById('downloadAnalysis');
const tpl = document.getElementById('recipeTpl');

let allRecipes = [];
let hasAnalyzed = false;
let currentAnalysisUrl = '';
// 点击图标「伪跳转」前的筛选状态，供「返回原搜索」恢复。
let jumpBackState = null;

async function loadVersions() {
  try {
    const r = await fetch('/api/versions');
    const d = await r.json();
    const versions = d.versions || [];
    mcVersionSelect.innerHTML = '';
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v === d.latest ? `${v}（最新正式版）` : v;
      mcVersionSelect.appendChild(opt);
    }
    mcVersionSelect.value = versions.includes(d.default) ? d.default : versions[0];
  } catch {
    mcVersionSelect.innerHTML = '<option value="1.21.1">1.21.1</option>';
  }
  refreshVanillaStatus();
}

async function refreshVanillaStatus() {
  const p = vanillaJarInput.value.trim();
  const version = mcVersionSelect.value || '1.21.1';
  const qs = new URLSearchParams({ version });
  if (p) qs.set('path', p);
  try {
    const r = await fetch(`/api/vanilla-status?${qs}`);
    const d = await r.json();
    if (d.ok) vanillaStatus.textContent = `Vanilla fallback: 已加载 ${d.mcVersion || version} (${d.jarPath})`;
    else vanillaStatus.textContent = `Vanilla fallback: 未找到 ${version}${d.jarPath ? ` (${d.jarPath})` : ''}。可填对应版本的 client jar 路径或设置 VANILLA_JAR。`;
  } catch {
    vanillaStatus.textContent = 'Vanilla fallback: 状态检测失败';
  }
}
vanillaJarInput.addEventListener('change', refreshVanillaStatus);
mcVersionSelect.addEventListener('change', refreshVanillaStatus);
loadVersions();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = [...document.getElementById('modFile').files];
  if (!files.length) return;
  statusEl.textContent = `上传并分析中（${files.length} 个文件）...`;
  resultsEl.innerHTML = '';
  summaryEl.innerHTML = '';
  categoryStats.innerHTML = '';
  auditDashboard.innerHTML = '';
  iconRenderStatsEl.innerHTML = '';
  if (dependencyDashboard) dependencyDashboard.innerHTML = '';
  if (jumpBar) { jumpBar.hidden = true; jumpBar.innerHTML = ''; }
  jumpBackState = null;
  if (suspiciousOnly) suspiciousOnly.checked = false;
  if (downloadAnalysis) { downloadAnalysis.href = '#'; downloadAnalysis.style.display = 'none'; }
  const fd = new FormData();
  for (const f of files) fd.append('mods', f);
  fd.append('mcVersion', mcVersionSelect.value || '1.21.1');
  const vjar = vanillaJarInput.value.trim();
  if (vjar) fd.append('vanillaJar', vjar);
  if (includeVanillaEquivalentsInput?.checked) fd.append('includeVanillaEquivalents', '1');
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '分析失败');
    statusEl.textContent = `完成：${files.length} 个文件 / ${data.recipeCount} 个配方`;
    const fileList = (data.modFiles || [data.modFile]).filter(Boolean).join(', ');
    summaryEl.innerHTML = `<div><b>文件</b>: ${esc(fileList)}</div><div><b>版本</b>: ${esc(data.mcVersion || '')}</div><div><b>配方数</b>: ${data.recipeCount}</div><div><b>Vanilla fallback</b>: ${data.vanillaLoaded ? esc(data.vanillaJar || 'loaded') : '未加载（minecraft 图标可能缺失）'}</div>`;
    const ares = await fetch(data.analysisUrl);
    const analysis = await ares.json();
    allRecipes = analysis.recipes || [];
    hasAnalyzed = true;
    currentAnalysisUrl = data.analysisUrl || '';
    buildCategoryFilter(analysis.summary?.categories || {});
    renderAudit(analysis.summary?.coverage);
    renderIconRenderStats(analysis.summary?.iconRenderStats);
    renderDependencies(analysis.summary?.dependencies);
    if (downloadAnalysis && currentAnalysisUrl) {
      downloadAnalysis.href = currentAnalysisUrl;
      downloadAnalysis.download = `${(data.modFile || 'analysis').replace(/\.(jar|zip)$/i, '')}-analysis.json`;
      downloadAnalysis.style.display = '';
    }
    render();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `错误：${err.message}`;
  }
});

categoryFilter.addEventListener('change', render);
if (acqFilter) acqFilter.addEventListener('change', render);
if (suspiciousOnly) suspiciousOnly.addEventListener('change', render);
searchInput.addEventListener('input', render);
if (exportSuspicious) exportSuspicious.addEventListener('click', exportSuspiciousCsv);

// 点卡片里的任意物品图标 → 清空筛选 → 搜索该物品 → 滚动到结果区（伪跳转）。
resultsEl.addEventListener('click', (e) => {
  const el = e.target.closest('[data-jump-id], [data-jump-name]');
  if (!el) return;
  const term = el.dataset.jumpId || el.dataset.jumpName;
  if (!term) return;
  jumpToItem(term, el.dataset.jumpName || el.dataset.jumpId || term);
});

function jumpToItem(term, label) {
  // 只有首次跳转才保存原状态；连续点图标不会把「返回」目标覆盖成中间态。
  if (!jumpBackState) {
    jumpBackState = {
      cat: categoryFilter?.value || '',
      acq: acqFilter?.value || '',
      sus: suspiciousOnly?.checked || false,
      q: searchInput.value,
    };
  }
  if (categoryFilter) categoryFilter.value = '';
  if (acqFilter) acqFilter.value = '';
  if (suspiciousOnly) suspiciousOnly.checked = false;
  searchInput.value = term;
  render();
  if (jumpBar) {
    jumpBar.hidden = false;
    jumpBar.innerHTML = `<span>正在查看：<b>${esc(label)}</b></span><button type="button" class="btn-small" id="jumpBack">返回原搜索</button>`;
    document.getElementById('jumpBack')?.addEventListener('click', restoreJump);
  }
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function restoreJump() {
  if (jumpBackState) {
    if (categoryFilter) categoryFilter.value = jumpBackState.cat;
    if (acqFilter) acqFilter.value = jumpBackState.acq;
    if (suspiciousOnly) suspiciousOnly.checked = jumpBackState.sus;
    searchInput.value = jumpBackState.q;
    jumpBackState = null;
  } else {
    searchInput.value = '';
  }
  if (jumpBar) { jumpBar.hidden = true; jumpBar.innerHTML = ''; }
  render();
}

function renderAudit(coverage) {
  if (!coverage) { auditDashboard.innerHTML = '<div class="empty">无覆盖率数据</div>'; return; }
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  const warn = (coverage.suspiciousRecipes || 0) > 0;
  const reasonEntries = Object.entries(coverage.suspiciousReasons || {});
  auditDashboard.innerHTML = `
    <div class="audit-grid">
      <div class="audit-metric"><div class="audit-metric-label">配方文件扫描</div><div class="audit-metric-value">${coverage.recipeFilesScanned ?? 0}</div></div>
      <div class="audit-metric"><div class="audit-metric-label">成功解析</div><div class="audit-metric-value">${coverage.recipesParsed ?? 0}</div></div>
      <div class="audit-metric ${coverage.parseRate != null && coverage.parseRate < 1 ? 'metric-warn' : ''}"><div class="audit-metric-label">解析率</div><div class="audit-metric-value">${pct(coverage.parseRate)}</div></div>
      <div class="audit-metric ${warn ? 'metric-warn' : ''}"><div class="audit-metric-label">可疑配方</div><div class="audit-metric-value">${coverage.suspiciousRecipes ?? 0}</div></div>
      <div class="audit-metric ${(coverage.unknownIngredients || 0) > 0 ? 'metric-warn' : ''}"><div class="audit-metric-label">未知材料</div><div class="audit-metric-value">${coverage.unknownIngredients ?? 0}<span class="audit-metric-sub"> / ${coverage.totalIngredients ?? 0}</span></div></div>
      <div class="audit-metric"><div class="audit-metric-label">未知类型 / 推断</div><div class="audit-metric-value">${coverage.unknownTypeRecipes ?? 0}<span class="audit-metric-sub"> / ${coverage.inferredRecipes ?? 0}</span></div></div>
    </div>
    <div class="audit-reasons">${reasonEntries.length ? reasonEntries.map(([k, v]) => `<span class="stat">${esc(REASON_LABELS[k] || k)}: ${v}</span>`).join('') : ''}</div>
    ${warn
      ? `<div class="audit-warning">⚠ 有 ${coverage.suspiciousRecipes} 条配方解析存疑（零输入 / 未知材料 / 无产物 / 未知类型）。已标红，勾选「只看可疑」可定位核对。</div>`
      : '<div class="audit-ok">✓ 未发现明显解析异常。</div>'}`;
}

function renderIconRenderStats(s) {
  if (!s) { iconRenderStatsEl.innerHTML = '<div class="empty">无图标渲染统计</div>'; return; }
  const degraded = s.itemModelMappingFallback2D || 0;
  iconRenderStatsEl.innerHTML = `
    <div class="audit-grid">
      <div class="audit-metric"><div class="audit-metric-label">items 映射直取成功</div><div class="audit-metric-value">${s.itemModelMappingHit ?? 0}</div></div>
      <div class="audit-metric ${degraded ? 'metric-warn' : ''}"><div class="audit-metric-label">复杂结构退 2D</div><div class="audit-metric-value">${degraded}</div></div>
      <div class="audit-metric"><div class="audit-metric-label">无 items 映射</div><div class="audit-metric-value">${s.itemModelMappingMissing ?? 0}</div></div>
    </div>`;
}

function renderDependencies(d) {
  if (!dependencyDashboard) return;
  if (!d) { dependencyDashboard.innerHTML = '<div class="empty">无依赖归类数据</div>'; return; }
  const ext = d.externalNamespaces || [];
  const extList = ext.length
    ? `<div class="dep-list">${ext.map(n => `<div class="dep-item"><span class="dep-ns">${esc(n.namespace)}</span><span class="dep-refs">${n.refs} 处引用</span>${n.examples?.length ? `<span class="dep-examples">${esc(n.examples.slice(0, 3).join(', '))}</span>` : ''}</div>`).join('')}</div>`
    : '<div class="audit-ok">✓ 未发现外部依赖——所有引用都在本次上传的 mod 或原版内。</div>';
  const registry = d.registry || [];
  const modList = registry.length
    ? `<details class="dep-registry"><summary>本次识别到 ${registry.length} 个命名空间（命名空间 → 模组）</summary><div class="dep-list">${registry.map(n => `<div class="dep-item"><b>${esc(n.namespace)}</b> → ${esc(n.modName)}${n.specific ? '' : '（推断）'}</div>`).join('')}</div></details>`
    : '';
  dependencyDashboard.innerHTML = `
    <div class="audit-grid">
      <div class="audit-metric"><div class="audit-metric-label">原版引用</div><div class="audit-metric-value">${d.vanillaRefs ?? 0}</div></div>
      <div class="audit-metric"><div class="audit-metric-label">内部引用</div><div class="audit-metric-value">${d.internalRefs ?? 0}<span class="audit-metric-sub"> / ${d.internalNamespaces ?? 0} 个命名空间</span></div></div>
      <div class="audit-metric ${ext.length ? 'metric-warn' : ''}"><div class="audit-metric-label">外部依赖</div><div class="audit-metric-value">${d.externalRefs ?? 0}<span class="audit-metric-sub"> / ${ext.length} 个命名空间</span></div></div>
    </div>
    <h3 class="audit-subtitle">外部依赖清单 <span class="audit-subtitle-note">（不算解析失败）</span></h3>
    ${extList}
    ${modList}`;
}

const REASON_LABELS = {
  'zero-input': '零输入',
  'unknown-ingredient': '未知材料',
  'result-unresolved': '无产物',
  'unknown-recipe-type': '未知类型',
};

function exportSuspiciousCsv() {
  const rows = allRecipes.filter(r => r.parseQuality?.suspicious);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['产物', '产物ID', '类型', '来源文件', '可疑原因'].map(q).join(',')];
  for (const r of rows) {
    lines.push([
      r.result?.name,
      r.result?.id,
      r.type,
      r.sourceFile,
      (r.parseQuality?.reasons || []).map(x => REASON_LABELS[x] || x).join(';'),
    ].map(q).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'suspicious-recipes.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

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
  const onlySus = suspiciousOnly ? suspiciousOnly.checked : false;
  const q = searchInput.value.trim().toLowerCase();
  const filtered = allRecipes.filter(r => {
    if (cat && (r.classification?.category || '未知') !== cat) return false;
    if (acq && (r.acquisition || 'recipe') !== acq) return false;
    if (onlySus && !r.parseQuality?.suspicious) return false;
    if (!q) return true;
    const hayParts = [r.result?.name, r.result?.id, r.type, r.recipeCategory, r.classification?.category, r.sourceFile, r.acquisition, ...(r.notes||[]), ...(r.advancements||[]).map(a=>a.title||a.description||'')];
    // 材料也纳入搜索范围：点材料图标跳转时，才能找到「用到它」的配方。
    const addIngTerms = (ing) => {
      if (!ing) return;
      if (ing.name) hayParts.push(ing.name);
      if (ing.id) hayParts.push(ing.id);
      if (Array.isArray(ing.options)) ing.options.forEach(addIngTerms);
    };
    (r.ingredients || []).forEach(addIngTerms);
    (r.grid || []).forEach(row => (row || []).forEach(addIngTerms));
    const hay = hayParts.filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  resultsEl.innerHTML = '';
  if (!filtered.length) {
    if (!hasAnalyzed) {
      resultsEl.innerHTML = `<div class="empty">请先上传一个 mod。</div>`;
    } else if (q || cat || acq || onlySus) {
      resultsEl.innerHTML = `<div class="empty">没有匹配的配方${onlySus ? '（没有可疑解析项）' : ''}。</div>`;
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
  // 站点差异（熔炉/高炉）是「获取方式」，不是产物变体；颜色等才是变体。
  const variantSuffix = r.variantCount
    ? ` [${r.variantCount}${r.variantKind === 'station' ? '种获取方式' : '变体'}]`
    : '';
  node.querySelector('.result-name').textContent = (result?.name || '(无产物/未知)') + variantSuffix;
  node.querySelector('.result-id').textContent = result?.id || r.type || '';
  const tags = node.querySelector('.tags');
  addTag(tags, cls, cls === '未知' ? 'unknown' : '');
  if (r.acquisition === 'advancement') addTag(tags, '成就获取', 'acq-adv');
  else addTag(tags, '配方获取', 'acq-recipe');
  addTag(tags, r.recipeCategory || 'unknown');
  if (r.shapeless) addTag(tags, 'shapeless');
  if (r.special) addTag(tags, 'special/custom');
  if (r.parseQuality?.suspicious) {
    node.classList.add('suspicious-card');
    addTag(tags, `⚠ ${(r.parseQuality.reasons || []).map(x => REASON_LABELS[x] || x).join('/')}`, 'suspicious');
  }

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

// 点图标伪跳转到该物品的搜索：tag / 变体 / 可选项没有唯一物品，取第一个具体选项。
function jumpTargetFor(ing) {
  if (!ing) return null;
  if (Array.isArray(ing.options) && ing.options.length) return jumpTargetFor(ing.options[0]) || ing;
  if (ing.id || ing.name) return { id: ing.id || '', name: ing.name || '' };
  return null;
}
// 原版物品/标签（minecraft: 或无命名空间，含 #minecraft:xxx）不跳转：
// 它们几乎出现在每个配方里，搜出来没有意义。口径与后端 namespaces.js 一致。
function isVanillaId(id) {
  if (!id || typeof id !== 'string') return false;
  const raw = id.startsWith('#') ? id.slice(1) : id;
  const ns = raw.includes(':') ? raw.split(':')[0] : 'minecraft';
  return ns === 'minecraft';
}
function markJumpable(el, ing) {
  const t = jumpTargetFor(ing);
  if (!el || !t || (!t.id && !t.name)) return el;
  if (isVanillaId(t.id)) return el;
  el.dataset.jumpId = t.id;
  el.dataset.jumpName = t.name;
  el.classList.add('jumpable');
  el.title = `${el.title || t.name || t.id || ''} · 点击搜索此物品`;
  return el;
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
    frag.appendChild(markJumpable(wrap, ing));
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
    frag.appendChild(markJumpable(canvas, ing));
    observe3D(canvas);
  } else if (ing.icon) {
    frag.appendChild(iconImg(ing.icon, ing, size));
  } else {
    frag.appendChild(markJumpable(textPlaceholder(ing, size), ing));
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
  img.onerror = () => { img.replaceWith(markJumpable(textPlaceholder(ing), ing)); };
  return markJumpable(img, ing);
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
