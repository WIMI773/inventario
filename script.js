/* =========================================================
   INVENTARIO APP v5.2  —  Firestore tiempo real, sin seed
   ========================================================= */

import {
  auth,
  subscribeProducts, subscribeSales,
  createProduct, updateProduct, deleteProduct,
  updateSale, commitSale, cancelSale,
  createCierre,
  db
} from "./firestore-service.js";

import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { deleteDoc, doc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Paleta ────────────────────────────────────────────────
const CAT_COLORS = {
  'Alimentos':'#1D9E75','Bebidas':'#378ADD','Limpieza':'#D4537E',
  'Cuidado personal':'#7F77DD','Papelería':'#D85A30','Electrónica':'#BA7517','Otro':'#888780'
};
const CAT_EMOJIS = {
  'Alimentos':'🌾','Bebidas':'🥤','Limpieza':'🧹',
  'Cuidado personal':'💆','Papelería':'📝','Electrónica':'⚡','Otro':'📦'
};
const COSMETIC_BRANDS_KEY = 'inventario_marcas_cosmeticos';
const COSMETIC_SELECTED_KEY = 'inventario_marcas_cosmeticos_seleccionadas';
const DEFAULT_COSMETIC_BRANDS = ['Maybelline', 'L’Oréal', 'MAC', 'Revlon', 'NYX', 'Vogue'];
const GENERAL_CATEGORIES = ['Alimentos', 'Bebidas', 'Limpieza', 'Cuidado personal', 'Papelería', 'Electrónica', 'Otro'];

// ── Colores PDF ───────────────────────────────────────────
const PDF_BRAND = {
  primary:  [26,  79, 214],
  dark:     [26,  25,  21],
  green:    [29, 158, 117],
  amber:    [184, 117,  23],
  red:      [192,  57,  43],
  light:    [245, 244, 240],
  border:   [220, 218, 212],
  text2:    [107, 104,  96],
  white:    [255, 255, 255],
  rowEven:  [250, 249, 246],
};

// ── Estado ────────────────────────────────────────────────
let uid         = null;
let products    = [];
let sales       = [];
let nextId      = 1;
let carrito     = [];
let metodoPago  = 'efectivo';
let editId      = null;
let sortCol     = 'name';
let sortAsc     = true;
let currentView = 'dashboard';
let pendingCode = '';
let scanBuf     = '';
let scanTmr     = null;
let searchTmr   = null;
let unsubProds  = null;
let unsubSales  = null;

// ── Helpers ───────────────────────────────────────────────
const el   = id      => document.getElementById(id);
const html = (id, h) => { const e = el(id); if (e) e.innerHTML = h; };
const today = ()     => new Date().toISOString().slice(0, 10);

function stockSt(p) {
  if (!p || p.stock === 0) return 'out';
  if (p.stock <= p.minStock) return 'low';
  return 'ok';
}
function badge(s) {
  const m = { ok:['badge-ok','En stock'], low:['badge-low','Stock bajo'], out:['badge-out','Sin stock'] };
  const [cls, lbl] = m[s] || m.ok;
  return `<span class="badge ${cls}">${lbl}</span>`;
}
function fmt(n)    { return '$' + (Number(n) || 0).toLocaleString('es-CO'); }
function dot(cat)  { return `<span class="cat-dot" style="background:${CAT_COLORS[cat]||'#aaa'}"></span>`; }
function pagoIcono(m) {
  const map = {
    efectivo:      '💵 Efectivo',
    transferencia: '📲 Nequi/Transfer.',
    tarjeta:       '💳 Tarjeta',
    mixto:         '🔀 Mixto',
  };
  return `<span style="font-size:11px;opacity:.8">${map[m]||m}</span>`;
}
function fmtDT(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CO', {day:'2-digit', month:'short'}) +
           ' · ' + d.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'});
  } catch { return iso || ''; }
}
function fmtGrp(iso) {
  try {
    const d = new Date(iso), hoy = new Date(), ayer = new Date();
    ayer.setDate(hoy.getDate() - 1);
    if (d.toDateString() === hoy.toDateString())  return 'Hoy';
    if (d.toDateString() === ayer.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-CO', {weekday:'long', day:'numeric', month:'long'});
  } catch { return 'Fecha desconocida'; }
}

function readCosmeticBrands() {
  try {
    const saved = JSON.parse(localStorage.getItem(COSMETIC_BRANDS_KEY));
    return Array.isArray(saved) && saved.length ? saved : [...DEFAULT_COSMETIC_BRANDS];
  } catch { return [...DEFAULT_COSMETIC_BRANDS]; }
}

function readSelectedCosmeticBrands() {
  try {
    const saved = JSON.parse(localStorage.getItem(COSMETIC_SELECTED_KEY));
    return new Set(Array.isArray(saved) ? saved : []);
  } catch { return new Set(); }
}

function saveCosmeticSelection(selected) {
  localStorage.setItem(COSMETIC_SELECTED_KEY, JSON.stringify([...selected]));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function syncProductCategoryOptions() {
  const select = el('f-cat');
  if (!select) return;
  const current = select.value;
  const brands = readCosmeticBrands();
  select.innerHTML = `${GENERAL_CATEGORIES.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')}
    <optgroup label="Marcas cosméticas">
      ${brands.map(brand => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`).join('')}
    </optgroup>`;
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function renderCosmeticBrands() {
  const wrap = el('cosmetic-brands');
  if (!wrap) return;
  const brands = readCosmeticBrands();
  syncProductCategoryOptions();
  const selected = readSelectedCosmeticBrands();
  const selectedCount = brands.filter(brand => selected.has(brand)).length;
  const parentState = selectedCount === brands.length ? 'checked' : '';
  const parentMixed = selectedCount > 0 && selectedCount < brands.length ? 'data-mixed="true"' : '';

  wrap.innerHTML = `
    <div class="brand-tree-header">
      <label class="tree-check tree-parent">
        <input type="checkbox" data-brand-parent ${parentState} ${parentMixed}>
        <span class="tree-box"></span>
        <span class="tree-label"><strong>Cosméticos</strong><small>${selectedCount} de ${brands.length} marcas seleccionadas</small></span>
      </label>
      <span class="brand-count">${brands.length} marcas</span>
    </div>
    <div class="brand-tree-children">
      ${brands.map(brand => `
        <label class="tree-check tree-child">
          <input type="checkbox" data-brand="${encodeURIComponent(brand)}" ${selected.has(brand) ? 'checked' : ''}>
          <span class="tree-box"></span>
          <span class="tree-label">${escapeHtml(brand)}</span>
        </label>`).join('')}
    </div>`;

  const parent = wrap.querySelector('[data-brand-parent]');
  if (parent) parent.indeterminate = selectedCount > 0 && selectedCount < brands.length;

  const cards = el('cosmetic-brand-cards');
  if (!cards) return;
  cards.innerHTML = `<div class="cat-grid">
    ${brands.map(brand => {
      const items = products.filter(product => product.category === brand || product.brand === brand);
      const value = items.reduce((total, product) => total + (product.price || 0) * (product.stock || 0), 0);
      const low = items.filter(product => stockSt(product) === 'low').length;
      const out = items.filter(product => stockSt(product) === 'out').length;
      return `<div class="cat-card brand-card ${selected.has(brand) ? 'is-selected' : ''}">
        <div class="cat-card-header">
          <div class="cat-icon brand-card-icon">✦</div>
          <div class="cat-name">${escapeHtml(brand)}</div>
        </div>
        <div class="cat-stat"><span>Productos</span><strong>${items.length}</strong></div>
        <div class="cat-stat"><span>Valor en stock</span><strong>${fmt(value)}</strong></div>
        <div class="cat-stat"><span>Stock bajo</span><strong class="brand-warning">${low}</strong></div>
        <div class="cat-stat"><span>Sin stock</span><strong class="brand-danger">${out}</strong></div>
      </div>`;
    }).join('')}
  </div>`;
}

function toggleCosmeticBrands(selectAll) {
  const brands = readCosmeticBrands();
  const selected = selectAll ? new Set(brands) : new Set();
  saveCosmeticSelection(selected);
  renderCosmeticBrands();
}

function addCosmeticBrand() {
  const input = el('new-cosmetic-brand');
  const name = input?.value.trim().replace(/\s+/g, ' ');
  if (!name) { toast('Escribe una marca cosmética.', 'error'); return; }
  const brands = readCosmeticBrands();
  if (brands.some(brand => brand.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    toast('Esa marca ya está registrada.', 'error'); return;
  }
  localStorage.setItem(COSMETIC_BRANDS_KEY, JSON.stringify([...brands, name]));
  input.value = '';
  renderCosmeticBrands();
  toast('Marca cosmética agregada', 'green');
}

// ── Toast ─────────────────────────────────────────────────
function toast(msg, type) {
  const t = el('toast'); if (!t) return;
  t.textContent = msg;
  t.style.background = type === 'green' ? '#1a6e3c' : type === 'error' ? '#c0392b' : '#1a1915';
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Overlay de carga ──────────────────────────────────────
function overlay(show) {
  let ov = el('loading-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'loading-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(245,244,240,.9);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:14px;z-index:9999;font-family:\'DM Sans\',sans-serif;font-size:14px;color:#6b6860;';
    ov.innerHTML = '<style>@keyframes _sp{to{transform:rotate(360deg)}}</style>' +
      '<div style="width:34px;height:34px;border:3px solid #e8e6e0;border-top-color:#1a4fd6;' +
      'border-radius:50%;animation:_sp .7s linear infinite"></div>Cargando inventario…';
    document.body.appendChild(ov);
  }
  ov.style.display = show ? 'flex' : 'none';
}

// ── Suscripciones en tiempo real ──────────────────────────
function initListeners() {
  overlay(true);

  unsubProds = subscribeProducts(uid, prods => {
    products = prods;
    nextId   = products.length ? Math.max(...products.map(p => p.id || 0)) + 1 : 1;
    syncGlobals();
    overlay(false);
    document.body.style.visibility = 'visible';
    refreshAll();
  });

  unsubSales = subscribeSales(uid, sls => {
    sales = sls;
    syncGlobals();
    refreshAll();
  });
}

function syncGlobals() {
  window._inv_products = products;
  window._inv_sales    = sales;
  window._inv_fmt      = fmt;
  window._inv_today    = today;
}

// ── Badges ────────────────────────────────────────────────
function updateBadges() {
  const nA = products.filter(p => stockSt(p) !== 'ok').length;
  const ab = el('alert-badge');
  if (ab) { ab.textContent = nA; ab.classList.toggle('visible', nA > 0); }
  const nV = sales.filter(s => !s.anulada && !s.cerrada && s.date?.startsWith(today())).length;
  const vb = el('ventas-hoy-badge');
  if (vb) { vb.textContent = nV; vb.classList.toggle('visible', nV > 0); }
}

// ── Navegación ────────────────────────────────────────────
function setView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el('view-' + view)?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.view === view));
  const titles = {
    dashboard:'Dashboard', productos:'Productos', ventas:'Punto de Venta',
    historial:'Historial de ventas', alertas:'Alertas de stock', categorias:'Categorías'
  };
  const pt = el('page-title'); if (pt) pt.textContent = titles[view] || view;
  if (view === 'ventas')     focusScanner();
  if (view === 'dashboard')  renderDashboard();
  if (view === 'productos')  renderTable();
  if (view === 'historial')  renderHistorial();
  if (view === 'alertas')    renderAlertas();
  if (view === 'categorias') renderCategorias();
  updateBadges();
}

function refreshAll() {
  updateBadges();
  renderStats();
  if (currentView === 'dashboard')  renderDashboard();
  if (currentView === 'productos')  renderTable();
  if (currentView === 'historial')  renderHistorial();
  if (currentView === 'alertas')    renderAlertas();
  if (currentView === 'categorias') renderCategorias();
}

// ── Stats ─────────────────────────────────────────────────
function renderStats() {
  if (!el('stat-total')) return;
  const hoy = sales.filter(s => s && !s.anulada && !s.cerrada && s.date?.startsWith(today()));
  el('stat-total').textContent      = products.length;
  el('stat-valor').textContent      = fmt(products.reduce((a, p) => a + (p.price||0) * (p.stock||0), 0));
  el('stat-ventas-hoy').textContent = fmt(hoy.reduce((a, s) => a + (s.total||0), 0));
  el('stat-alertas').textContent    = products.filter(p => stockSt(p) !== 'ok').length;
}

// ── Gráfica de ventas ────────────────────────────────────────
let graficaChart    = null;
let graficaTabActual = 'ingresos';

function renderGrafica() {
  const canvas = document.getElementById('grafica-ventas');
  const emptyEl = document.getElementById('grafica-empty');
  const footerEl = document.getElementById('grafica-footer');
  if (!canvas) return;

  // Construir los últimos 7 días
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dias.push(d.toISOString().slice(0, 10));
  }

  const labels = dias.map(d => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('es-CO', { weekday:'short', day:'numeric' });
  });

  // Agrupar ventas por día
  const porDia = {};
  dias.forEach(d => { porDia[d] = { ingresos: 0, transacciones: 0 }; });
  sales.filter(s => s && !s.anulada && s.date).forEach(s => {
    const dia = s.date.slice(0, 10);
    if (porDia[dia]) {
      porDia[dia].ingresos      += s.total || 0;
      porDia[dia].transacciones += 1;
    }
  });

  const valoresIngresos      = dias.map(d => porDia[d].ingresos);
  const valoresTransacciones = dias.map(d => porDia[d].transacciones);
  const valores = graficaTabActual === 'ingresos' ? valoresIngresos : valoresTransacciones;
  const totalGeneral = valores.reduce((a, v) => a + v, 0);

  // Si no hay nada, mostrar empty state
  if (totalGeneral === 0) {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    if (footerEl) footerEl.innerHTML = '';
    return;
  }
  canvas.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';

  // Tendencia: comparar últimos 3 días vs 3 anteriores
  const primeraMitad  = valoresIngresos.slice(0, 3).reduce((a, v) => a + v, 0);
  const segundaMitad  = valoresIngresos.slice(4, 7).reduce((a, v) => a + v, 0);
  let tendHTML = '';
  if (primeraMitad > 0 || segundaMitad > 0) {
    if (segundaMitad > primeraMitad * 1.05) {
      const pct = primeraMitad ? Math.round((segundaMitad - primeraMitad) / primeraMitad * 100) : 100;
      tendHTML = `<div class="grafica-tendencia tend-up">▲ +${pct}% vs inicio de semana</div>`;
    } else if (segundaMitad < primeraMitad * 0.95) {
      const pct = Math.round((primeraMitad - segundaMitad) / primeraMitad * 100);
      tendHTML = `<div class="grafica-tendencia tend-down">▼ −${pct}% vs inicio de semana</div>`;
    } else {
      tendHTML = `<div class="grafica-tendencia tend-flat">→ Ventas estables</div>`;
    }
  }

  // Footer con stats
  const mejorDia    = Math.max(...valoresIngresos);
  const mejorIdx    = valoresIngresos.indexOf(mejorDia);
  const promDiario  = Math.round(valoresIngresos.reduce((a,v)=>a+v,0) / 7);
  const totalTx     = valoresTransacciones.reduce((a,v)=>a+v,0);
  if (footerEl) footerEl.innerHTML = `
    <div class="grafica-stat">
      <span class="grafica-stat-val">${fmt(valoresIngresos.reduce((a,v)=>a+v,0))}</span>
      <span class="grafica-stat-lbl">Total 7 días</span>
    </div>
    <div class="grafica-stat">
      <span class="grafica-stat-val">${fmt(promDiario)}</span>
      <span class="grafica-stat-lbl">Promedio diario</span>
    </div>
    <div class="grafica-stat">
      <span class="grafica-stat-val">${labels[mejorIdx]}</span>
      <span class="grafica-stat-lbl">Mejor día</span>
    </div>
    <div class="grafica-stat">
      <span class="grafica-stat-val">${totalTx}</span>
      <span class="grafica-stat-lbl">Transacciones</span>
    </div>
    ${tendHTML}`;

  // Gradiente de relleno
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.offsetHeight || 200);
  gradient.addColorStop(0,   'rgba(26,79,214,0.22)');
  gradient.addColorStop(1,   'rgba(26,79,214,0)');

  const datasetLabel = graficaTabActual === 'ingresos' ? 'Ingresos ($)' : 'Transacciones';

  if (graficaChart) {
    graficaChart.data.labels               = labels;
    graficaChart.data.datasets[0].data     = valores;
    graficaChart.data.datasets[0].label    = datasetLabel;
    graficaChart.options.plugins.tooltip.callbacks.label = (ctx) =>
      graficaTabActual === 'ingresos'
        ? ' ' + fmt(ctx.parsed.y)
        : ' ' + ctx.parsed.y + ' venta' + (ctx.parsed.y !== 1 ? 's' : '');
    graficaChart.update('active');
    return;
  }

  graficaChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: datasetLabel,
        data: valores,
        borderColor:     '#1a4fd6',
        backgroundColor: gradient,
        borderWidth:     2.5,
        pointRadius:     4,
        pointHoverRadius:6,
        pointBackgroundColor: '#1a4fd6',
        pointBorderColor:     '#fff',
        pointBorderWidth:     2,
        tension: 0.35,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1915',
          titleColor:      '#f5f4f0',
          bodyColor:       '#c8c5bc',
          padding:         10,
          cornerRadius:    8,
          callbacks: {
            label: (ctx) => graficaTabActual === 'ingresos'
              ? ' ' + fmt(ctx.parsed.y)
              : ' ' + ctx.parsed.y + ' venta' + (ctx.parsed.y !== 1 ? 's' : ''),
          }
        }
      },
      scales: {
        x: {
          grid:  { display:false },
          ticks: { font:{ family:'DM Sans', size:11 }, color:'#6b6860' },
          border:{ display:false },
        },
        y: {
          beginAtZero: true,
          grid:  { color:'rgba(0,0,0,0.05)', drawTicks:false },
          ticks: {
            font:{ family:'DM Sans', size:11 }, color:'#6b6860',
            callback: v => graficaTabActual === 'ingresos' ? '$' + v.toLocaleString('es-CO') : v,
            maxTicksLimit: 5,
          },
          border:{ display:false },
        }
      }
    }
  });
}

window._setGraficaTab = (tab) => {
  graficaTabActual = tab;
  document.getElementById('gtab-ingresos')?.classList.toggle('active', tab === 'ingresos');
  document.getElementById('gtab-transacciones')?.classList.toggle('active', tab === 'transacciones');
  // Destruir chart para que se recree con nuevo gradiente/callbacks
  if (graficaChart) { graficaChart.destroy(); graficaChart = null; }
  renderGrafica();
};

// ── Dashboard ─────────────────────────────────────────────
function renderDashboard() {
  renderStats();
  renderGrafica();
  const hoy = sales
    .filter(s => s && !s.anulada && !s.cerrada && s.date?.startsWith(today()) && Array.isArray(s.items))
    .slice(0, 5);

  html('dash-ventas', hoy.length
    ? hoy.map(s => `<div class="dash-list-item">
        <div class="dash-item-name"><span>${s.items.map(i => i.name).join(', ')}</span></div>
        <div class="dash-item-meta">${fmtDT(s.date)}</div>
        <div style="font-size:13px;font-weight:600;color:var(--green);white-space:nowrap">${fmt(s.total)}</div>
      </div>`).join('')
    : '<div class="empty-state" style="padding:1.5rem"><p>Sin ventas hoy todavía</p></div>');

  const crit = products.filter(p => stockSt(p) !== 'ok').sort((a, b) => (a.stock||0) - (b.stock||0)).slice(0, 5);
  html('dash-criticos', crit.length
    ? crit.map(p => `<div class="dash-list-item">
        <div class="dash-item-name"><span>${p.name}</span></div>
        ${badge(stockSt(p))}
        <div class="dash-item-meta">Stock: <strong>${p.stock}</strong></div>
      </div>`).join('')
    : `<div class="empty-state" style="padding:1.5rem">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>Todo el stock en orden</p></div>`);

  if (!products.length) {
    html('dash-categorias', '<div class="empty-state" style="padding:1.5rem"><p>Sin productos aún</p></div>');
    return;
  }
  const cc = {};
  products.forEach(p => { cc[p.category] = (cc[p.category] || 0) + 1; });
  const maxC = Math.max(...Object.values(cc), 1);
  html('dash-categorias', `<div class="cat-bar-wrap">
    ${Object.entries(cc).sort((a, b) => b[1] - a[1]).map(([cat, cnt]) => `
      <div class="cat-bar-row">
        <div class="cat-bar-label">${dot(cat)}${cat}</div>
        <div class="cat-bar-bg"><div class="cat-bar-fill" style="width:${Math.round(cnt/maxC*100)}%;background:${CAT_COLORS[cat]||'#aaa'}"></div></div>
        <div class="cat-bar-count">${cnt}</div>
      </div>`).join('')}
  </div>`);
}

// ── Tabla productos ───────────────────────────────────────
function getFiltered() {
  const q   = (el('search')?.value || '').toLowerCase();
  const cat = el('cat-filter')?.value || '';
  const sf  = el('stock-filter')?.value || '';
  return products.filter(p => {
    if (q   && !p.name.toLowerCase().includes(q) && !(p.barcode||'').includes(q) && !p.category.toLowerCase().includes(q)) return false;
    if (cat && p.category !== cat) return false;
    if (sf  && stockSt(p) !== sf) return false;
    return true;
  }).sort((a, b) => {
    let va = a[sortCol] || '', vb = b[sortCol] || '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    return sortAsc ? (va > vb ? 1 : va < vb ? -1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0);
  });
}

function updateCatFilter() {
  const sel = el('cat-filter'); if (!sel) return;
  const cur = sel.value;
  const cats = [...new Set(products.map(p => p.category))].sort();
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    cats.map(c => `<option${cur === c ? ' selected' : ''}>${c}</option>`).join('');
}

function renderTable() {
  updateCatFilter();
  const list = getFiltered();
  document.querySelectorAll('.sortable').forEach(th => {
    const a = th.querySelector('.sort-arrow');
    if (a) a.textContent = th.dataset.col === sortCol ? (sortAsc ? ' ↑' : ' ↓') : '';
  });
  const tbody = el('tbody'); if (!tbody) return;
  tbody.innerHTML = list.length
    ? list.map(p => `<tr>
        <td style="font-weight:500">${p.name}</td>
        <td><span class="barcode-tag">${p.barcode || '—'}</span></td>
        <td>${dot(p.category)}${p.category}</td>
        <td>${fmt(p.price)}</td>
        <td style="font-weight:600">${p.stock}</td>
        <td>${badge(stockSt(p))}</td>
        <td><div class="row-actions">
          <button class="btn btn-outline btn-sm" onclick="window._openModal(${p.id})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="window._delProduct(${p.id})">Eliminar</button>
        </div></td>
      </tr>`).join('')
    : `<tr><td colspan="7"><div class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>No se encontraron productos</p></div></td></tr>`;
  const tf = el('table-footer');
  if (tf) tf.textContent = `Mostrando ${list.length} de ${products.length} producto${products.length !== 1 ? 's' : ''}`;
}

// ── Escáner ───────────────────────────────────────────────
function focusScanner() {
  setTimeout(() => el('barcode-input')?.focus(), 150);
}

function initScanner() {
  const input  = el('barcode-input');
  const acList = el('autocomplete-list');
  const clrBtn = el('scanner-clear');
  if (!input) return;

  document.addEventListener('keydown', e => {
    if (currentView !== 'ventas') return;
    if (document.activeElement === input) return;
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'Enter') {
      if (scanBuf.length > 2) processCodigo(scanBuf.trim());
      scanBuf = ''; clearTimeout(scanTmr); return;
    }
    if (e.key.length === 1) {
      scanBuf += e.key;
      clearTimeout(scanTmr);
      scanTmr = setTimeout(() => { scanBuf = ''; }, 80);
    }
  });

  input.addEventListener('input', () => {
    const val = input.value.trim();
    if (clrBtn) clrBtn.style.display = val ? 'flex' : 'none';
    clearTimeout(searchTmr);
    if (!val) { acList?.classList.remove('open'); return; }
    searchTmr = setTimeout(() => showSugg(val), 200);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAC(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...(acList?.querySelectorAll('.ac-item:not(.sin-stock)') || [])];
      if (!items.length) return;
      const foc = acList.querySelector('.ac-item.focused');
      let idx = foc ? items.indexOf(foc) : -1;
      if (foc) foc.classList.remove('focused');
      idx = e.key === 'ArrowDown' ? Math.min(idx+1, items.length-1) : Math.max(idx-1, 0);
      items[idx].classList.add('focused');
      items[idx].scrollIntoView({block:'nearest'});
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim(); if (!val) return;
      const foc = acList?.querySelector('.ac-item.focused');
      if (foc) {
        const p = products.find(p => p.id === parseInt(foc.dataset.id));
        if (p) { pickProduct(p); return; }
      }
      if (acList?.classList.contains('open')) {
        const vis = acList.querySelectorAll('.ac-item:not(.sin-stock)');
        if (vis.length === 1) {
          const p = products.find(p => p.id === parseInt(vis[0].dataset.id));
          if (p) { pickProduct(p); return; }
        }
        return;
      }
      processCodigo(val);
    }
  });

  acList?.addEventListener('mousedown', e => {
    const item = e.target.closest('.ac-item');
    if (!item || item.classList.contains('sin-stock')) return;
    e.preventDefault();
    const p = products.find(p => p.id === parseInt(item.dataset.id));
    if (p) pickProduct(p);
  });

  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#scanner-box')) closeAC();
  });

  clrBtn?.addEventListener('click', () => {
    input.value = ''; clrBtn.style.display = 'none'; closeAC(); input.focus();
  });
}

function showSugg(val) {
  const acList = el('autocomplete-list'); if (!acList) return;
  const q = val.toLowerCase();
  const m = products.filter(p => p.name.toLowerCase().includes(q) || (p.barcode||'').includes(q)).slice(0, 8);
  if (!m.length) { acList.classList.remove('open'); return; }
  acList.innerHTML = m.map(p => `
    <div class="ac-item ${p.stock === 0 ? 'sin-stock' : ''}" data-id="${p.id}">
      <div class="ac-name">${p.name}</div>
      <div class="ac-right">
        <div class="ac-price">${fmt(p.price)}</div>
        <div class="ac-stock ${p.stock === 0 ? 'sin-stock-label' : ''}">Stock: ${p.stock}</div>
      </div>
    </div>`).join('');
  acList.classList.add('open');
}

function pickProduct(prod) { closeAC(); addToCart(prod); }
function closeAC() { el('autocomplete-list')?.classList.remove('open'); }
function clearInput() {
  const inp = el('barcode-input'), ac = el('autocomplete-list'), cb = el('scanner-clear');
  if (inp) inp.value = ''; if (ac) ac.classList.remove('open'); if (cb) cb.style.display = 'none';
}

function processCodigo(code) {
  const box = el('scanner-box');
  if (box) {
    box.style.borderColor = 'var(--green)';
    box.style.boxShadow   = '0 0 0 4px var(--green-bg)';
    setTimeout(() => { box.style.borderColor = 'var(--accent)'; box.style.boxShadow = '0 0 0 4px var(--accent-light)'; }, 400);
  }
  clearInput();
  const prod = products.find(p => p.barcode === code);
  if (!prod) {
    pendingCode = code;
    const nfc = el('nf-code'); if (nfc) nfc.textContent = code;
    el('modal-not-found')?.classList.add('open');
    return;
  }
  if (prod.stock <= 0) { toast(`Sin stock: ${prod.name}`, 'error'); return; }
  addToCart(prod);
}

// ── Carrito ───────────────────────────────────────────────
function addToCart(prod) {
  const ex = carrito.find(i => i.productId === prod.id);
  if (ex) {
    if (ex.qty >= prod.stock) { toast(`Stock máximo: ${prod.stock} uds.`, 'error'); return; }
    ex.qty++;
  } else {
    carrito.push({ productId:prod.id, name:prod.name, barcode:prod.barcode||'', category:prod.category, qty:1, unitPrice:prod.price, originalPrice:prod.price });
  }
  clearInput(); renderCart(); focusScanner();
  toast(`✓ ${prod.name} agregado`, 'green');
}

function renderCart() {
  const vacio  = el('carrito-vacio');
  const items  = el('carrito-items');
  const count  = el('carrito-count');
  const nota   = el('carrito-nota-wrap');
  const vacBtn = el('btn-vaciar');
  const total  = carrito.reduce((a, i) => a + i.qty, 0);
  if (count) count.textContent = `${total} item${total !== 1 ? 's' : ''}`;
  if (!carrito.length) {
    if (vacio)  vacio.style.display  = 'block';
    if (items)  items.innerHTML      = '';
    if (nota)   nota.style.display   = 'none';
    if (vacBtn) vacBtn.style.display = 'none';
    renderSummary(); return;
  }
  if (vacio)  vacio.style.display  = 'none';
  if (nota)   nota.style.display   = 'block';
  if (vacBtn) vacBtn.style.display = 'inline-flex';
  if (items) items.innerHTML = carrito.map((item, idx) => {
    const descuento = item.originalPrice && item.unitPrice < item.originalPrice
      ? Math.round((1 - item.unitPrice / item.originalPrice) * 100)
      : 0;
    return `
    <div class="carrito-item">
      <div class="ci-num">${idx+1}</div>
      <div class="ci-info">
        <div class="ci-name">${item.name}</div>
        <div class="ci-meta">${dot(item.category)}${item.category}</div>
      </div>
      <div class="ci-qty-ctrl">
        <button class="ci-qty-btn" onclick="window._chgQty(${item.productId},-1)">−</button>
        <span class="ci-qty">${item.qty}</span>
        <button class="ci-qty-btn" onclick="window._chgQty(${item.productId},1)">+</button>
      </div>
      <div class="ci-price-wrap">
        <div class="ci-price-label">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Precio unit.
        </div>
        <div class="ci-price-field">
          <span class="ci-price-prefix">$</span>
          <input class="ci-price-input"
            type="number" min="0" step="1"
            value="${item.unitPrice}"
            oninput="window._chgPrice(${item.productId}, this.value)"
            title="Toca para editar el precio (puedes hacer rebaja)">
        </div>
        ${descuento > 0 ? `<div class="ci-descuento-badge">−${descuento}%</div>` : `<div class="ci-precio-original">${item.originalPrice ? fmt(item.originalPrice) : ''}</div>`}
      </div>
      <div class="ci-subtotal">${fmt(item.qty * item.unitPrice)}</div>
      <button class="ci-remove" onclick="window._rmCart(${item.productId})" title="Quitar">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
  renderSummary();
}

function renderSummary() {
  const sub = carrito.reduce((a, i) => a + i.qty * i.unitPrice, 0);
  const rs = el('r-subtotal'); if (rs) rs.textContent = fmt(sub);
  const rt = el('r-total');    if (rt) rt.textContent = fmt(sub);
  const sp = el('items-sin-precio');
  if (sp) sp.style.display = carrito.some(i => i.unitPrice === 0) ? 'flex' : 'none';
  const bc = el('btn-confirmar'); if (bc) bc.disabled = carrito.length === 0;
}

function clearCart() {
  carrito = [];
  const n = el('carrito-nota'); if (n) n.value = '';
  renderCart();
}

window._chgQty    = (pid, d) => {
  const item = carrito.find(i => i.productId === pid); if (!item) return;
  const prod = products.find(p => p.id === pid);
  item.qty = Math.max(1, Math.min(item.qty + d, prod ? prod.stock : 999));
  renderCart();
};
window._chgPrice  = (pid, v) => {
  const item = carrito.find(i => i.productId === pid);
  if (item) { item.unitPrice = parseFloat(v) || 0; renderCart(); }
};
window._rmCart    = pid => { carrito = carrito.filter(i => i.productId !== pid); renderCart(); };
window._openModal = (id = null, bc = '') => openModal(id, bc);
window._delProduct = id => confirmDelete(id);
window._addToCart  = prod => addToCart(prod);

// ── Métodos de pago ───────────────────────────────────────
window._setPago = (metodo) => {
  metodoPago = metodo;
  // Actualizar botones activos
  document.querySelectorAll('.pago-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pago === metodo));
  // Mostrar/ocultar paneles
  ['efectivo','transferencia','tarjeta','mixto'].forEach(m => {
    const p = document.getElementById('panel-' + m);
    if (p) p.style.display = m === metodo ? 'block' : 'none';
  });
  // Reset campos
  const er = document.getElementById('efectivo-recibido');
  if (er) er.value = '';
  const me = document.getElementById('mixto-efectivo');
  const md = document.getElementById('mixto-digital');
  if (me) me.value = ''; if (md) md.value = '';
  const cw = document.getElementById('cambio-wrap');
  const ce = document.getElementById('cambio-error');
  const mrw = document.getElementById('mixto-restante-wrap');
  if (cw)  cw.style.display  = 'none';
  if (ce)  ce.style.display  = 'none';
  if (mrw) mrw.style.display = 'none';
};

window._calcCambio = () => {
  const total    = carrito.reduce((a, i) => a + i.qty * i.unitPrice, 0);
  const recibido = parseFloat(document.getElementById('efectivo-recibido')?.value) || 0;
  const cw  = document.getElementById('cambio-wrap');
  const ce  = document.getElementById('cambio-error');
  const cv  = document.getElementById('cambio-val');
  if (!recibido) { if (cw) cw.style.display='none'; if (ce) ce.style.display='none'; return; }
  if (recibido < total) {
    if (cw) cw.style.display = 'none';
    if (ce) ce.style.display = 'flex';
  } else {
    if (ce) ce.style.display = 'none';
    if (cw) cw.style.display = 'block';
    if (cv) cv.textContent   = fmt(recibido - total);
  }
};

window._setBill = (monto) => {
  const inp = document.getElementById('efectivo-recibido');
  if (!inp) return;
  const actual = parseFloat(inp.value) || 0;
  inp.value = actual + monto;
  window._calcCambio();
};

window._calcMixto = () => {
  const total   = carrito.reduce((a, i) => a + i.qty * i.unitPrice, 0);
  const ef      = parseFloat(document.getElementById('mixto-efectivo')?.value) || 0;
  const dig     = parseFloat(document.getElementById('mixto-digital')?.value)  || 0;
  const suma    = ef + dig;
  const mrw     = document.getElementById('mixto-restante-wrap');
  const mrl     = document.getElementById('mixto-restante-label');
  const mrv     = document.getElementById('mixto-restante-val');
  if (!ef && !dig) { if (mrw) mrw.style.display = 'none'; return; }
  if (mrw) mrw.style.display = 'block';
  const diff = suma - total;
  if (diff >= 0) {
    if (mrl) mrl.textContent = 'Cambio a devolver';
    if (mrv) { mrv.textContent = fmt(diff); mrv.style.color = '#1a6e3c'; }
    if (mrw) { mrw.style.background='#eafaf3'; mrw.style.borderColor='#b6e8d3'; }
  } else {
    if (mrl) mrl.textContent = 'Falta por cubrir';
    if (mrv) { mrv.textContent = fmt(Math.abs(diff)); mrv.style.color = '#c0392b'; }
    if (mrw) { mrw.style.background='#fff0f0'; mrw.style.borderColor='#f5c6c2'; }
  }
};

// ── Confirmar venta ───────────────────────────────────────
async function confirmarVenta() {
  if (!carrito.length || !uid) return;
  const errEl = el('caja-error'); if (errEl) errEl.textContent = '';
  for (const item of carrito) {
    const prod = products.find(p => p.id === item.productId);
    if (!prod || item.qty > prod.stock) {
      if (errEl) errEl.textContent = `Stock insuficiente para "${item.name}" (disponible: ${prod?.stock ?? 0})`;
      return;
    }
  }
  const nota  = el('carrito-nota')?.value?.trim() || '';
  const venta = {
    items:   carrito.map(i => ({ productId:i.productId, name:i.name, category:i.category, qty:i.qty, unitPrice:i.unitPrice, subtotal:i.qty*i.unitPrice })),
    total:   carrito.reduce((a, i) => a + i.qty * i.unitPrice, 0),
    metodoPago,
    nota, date: new Date().toISOString(), anulada: false, cerrada: false
  };
  const btn = el('btn-confirmar');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    await commitSale(uid, venta, products);
    const n = venta.items.reduce((a, i) => a + i.qty, 0);
    toast(`Venta registrada · ${n} ítem${n !== 1 ? 's' : ''} · ${fmt(venta.total)}`, 'green');
    clearCart(); clearInput(); focusScanner();
    window._setPago('efectivo');
  } catch(e) {
    console.error('confirmarVenta:', e);
    if (errEl) errEl.textContent = 'Error al guardar. Verifica tu conexión.';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Confirmar venta';
    }
  }
}

// ── Cierre de caja ────────────────────────────────────────
function abrirCierre() {
  const vh  = sales.filter(s => s && !s.anulada && !s.cerrada && s.date?.startsWith(today()) && Array.isArray(s.items));
  const th  = vh.reduce((a, s) => a + (s.total||0), 0);
  const ih  = vh.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.qty||0), 0), 0);
  const cc  = {};
  vh.forEach(s => s.items.forEach(i => { cc[i.name] = (cc[i.name]||0) + i.qty; }));
  const top = Object.entries(cc).sort((a, b) => b[1]-a[1])[0];
  html('cierre-resumen', `
    <div class="cierre-row"><span>Fecha</span>
      <strong>${new Date().toLocaleDateString('es-CO',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</strong></div>
    <div class="cierre-row"><span>Transacciones del día</span><strong>${vh.length}</strong></div>
    <div class="cierre-row"><span>Unidades vendidas</span><strong>${ih}</strong></div>
    ${top ? `<div class="cierre-row"><span>Producto más vendido</span><strong>${top[0]} (×${top[1]})</strong></div>` : ''}
    <div class="cierre-row highlight"><span>Total recaudado hoy</span><strong>${fmt(th)}</strong></div>`);
  el('modal-cierre')?.classList.add('open');
}

async function confirmarCierre() {
  if (!uid) return;
  const vh = sales.filter(s => s && !s.anulada && !s.cerrada && s.date?.startsWith(today()));
  try {
    await createCierre(uid, { fecha:today(), transacciones:vh.length, total:vh.reduce((a,s) => a+(s.total||0),0) });
    await Promise.all(vh.map(s => updateSale(uid, s.firestoreId, { cerrada:true })));
    el('modal-cierre')?.classList.remove('open');
    toast('Cierre de caja registrado. ¡Buen inicio mañana!', 'green');
  } catch(e) {
    console.error(e); toast('Error al guardar cierre.', 'error');
  }
}

// ── Historial ─────────────────────────────────────────────
function getSalesFiltradas() {
  const f   = el('filtro-ventas')?.value || 'todo';
  const now = new Date();
  return sales.filter(s => {
    if (!s || !s.date || !Array.isArray(s.items)) return false;
    if (f === 'hoy')    return s.date.startsWith(today());
    if (f === 'semana') return (now - new Date(s.date)) / 86400000 <= 7;
    if (f === 'mes')    { const d = new Date(s.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }
    return true;
  });
}

function renderHistorial() {
  const lista = getSalesFiltradas();
  const act   = lista.filter(s => !s.anulada);
  html('ventas-resumen-bar', `
    <div class="res-bar-item"><div class="res-bar-label">Transacciones</div><div class="res-bar-val">${act.length}</div></div>
    <div class="res-bar-item"><div class="res-bar-label">Unidades vendidas</div><div class="res-bar-val">${act.reduce((a,s)=>a+s.items.reduce((b,i)=>b+(i.qty||0),0),0)}</div></div>
    <div class="res-bar-item"><div class="res-bar-label">Total recaudado</div><div class="res-bar-val" style="color:var(--green)">${fmt(act.reduce((a,s)=>a+(s.total||0),0))}</div></div>`);

  const body = el('historial-body'); if (!body) return;
  if (!lista.length) {
    body.innerHTML = `<div class="empty-state" style="padding:2.5rem 1rem">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      <p>No hay ventas en este período</p></div>`;
    return;
  }
  const grupos = {};
  lista.forEach(s => { const k = fmtGrp(s.date); if (!grupos[k]) grupos[k] = []; grupos[k].push(s); });
  body.innerHTML = Object.entries(grupos).map(([fecha, g]) => `
    <div class="venta-grupo">
      <div class="venta-grupo-header">${fecha}</div>
      ${g.map(s => {
        const res = s.items.map(i => `${i.name} ×${i.qty}`).join(', ');
        const ni  = s.items.reduce((a, i) => a + (i.qty||0), 0);
        return `<div class="venta-item ${s.anulada?'anulada':''} ${s.cerrada?'cerrada':''}">
          <div class="vi-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></div>
          <div class="vi-body">
            <div class="vi-productos">${res}</div>
            <div class="vi-meta">${fmtDT(s.date)}${s.cerrada?' · <span class="badge-cerrada">Caja cerrada</span>':''}${s.metodoPago ? ' · ' + pagoIcono(s.metodoPago) : ''}</div>
            ${s.nota ? `<div class="vi-nota">📝 ${s.nota}</div>` : ''}
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px">
              ${!s.anulada
                ? `<button class="btn-facturar" onclick="window._facturarVenta('${s.firestoreId}')">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                    Facturar
                  </button>` : ''}
              ${!s.anulada && !s.cerrada
                ? `<button class="btn-anular" onclick="window._anularVenta('${s.firestoreId}')">Anular</button>`
                : s.anulada ? `<span style="font-size:11px;color:var(--red)">Anulada</span>` : ''}
            </div>
          </div>
          <div class="vi-right">
            <div class="vi-total ${s.anulada?'anulado':''}">${fmt(s.total)}</div>
            <div class="vi-items-count">${ni} ítem${ni !== 1 ? 's' : ''}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`).join('');
}

window._anularVenta = async fid => {
  if (!uid) return;
  const s = sales.find(x => x.firestoreId === fid);
  if (!s || s.anulada) return;
  if (!confirm(`¿Anular esta venta de ${fmt(s.total)}?\nEl stock se restaurará.`)) return;
  try {
    await cancelSale(uid, s, products);
    toast('Venta anulada y stock restaurado');
  } catch(e) { console.error(e); toast('Error al anular.', 'error'); }
};

// ── Borrar historial ──────────────────────────────────────
async function borrarHistorial() {
  if (!uid) return;
  const lista = getSalesFiltradas();
  if (!lista.length) {
    toast('No hay registros en este período para borrar', 'error');
    return;
  }
  const labels = { hoy:'de hoy', semana:'de esta semana', mes:'de este mes', todo:'completo' };
  const filtro  = el('filtro-ventas')?.value || 'todo';
  if (!confirm(
    `¿Borrar el historial ${labels[filtro]}?\n\n` +
    `Se eliminarán ${lista.length} registro(s) de forma permanente.\n` +
    `Esta acción NO se puede deshacer.`
  )) return;

  const btn = el('btn-borrar-historial');
  if (btn) { btn.disabled = true; btn.textContent = 'Borrando…'; }
  try {
    await Promise.all(
      lista.map(s => deleteDoc(doc(db, `users/${uid}/sales`, s.firestoreId)))
    );
    toast(`✓ Historial borrado: ${lista.length} registro(s) eliminados`, 'green');
  } catch(e) {
    console.error('borrarHistorial:', e);
    toast('Error al borrar historial. Verifica tu conexión.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Borrar historial`;
    }
  }
}

// ── Alertas ───────────────────────────────────────────────
function renderAlertas() {
  const items = products.filter(p => stockSt(p) !== 'ok').sort((a, b) => (a.stock||0) - (b.stock||0));
  const ae = el('alertas-list'); if (!ae) return;
  if (!items.length) {
    ae.innerHTML = `<div class="no-alertas">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <p>Todo el inventario está en orden</p></div>`;
    return;
  }
  ae.innerHTML = items.map(p => {
    const cr = stockSt(p) === 'out';
    return `<div class="alerta-item ${cr?'critica':'baja'}">
      <div class="alerta-icon" style="background:${cr?'var(--red-bg)':'var(--amber-bg)'};color:${cr?'var(--red)':'var(--amber)'}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${cr ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
               : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'}
        </svg>
      </div>
      <div class="alerta-info">
        <div class="alerta-name">${p.name}</div>
        <div class="alerta-detail">${p.category} · Stock: <strong>${p.stock}</strong> · Mín: ${p.minStock}</div>
      </div>
      ${badge(stockSt(p))}
      <button class="btn btn-outline btn-sm" onclick="window._openModal(${p.id})">Actualizar stock</button>
    </div>`;
  }).join('');
}

// ── Categorías ────────────────────────────────────────────
function renderCategorias() {
  renderCosmeticBrands();
  const cd = {};
  products.forEach(p => {
    if (!cd[p.category]) cd[p.category] = {count:0, valor:0, bajo:0, sin:0};
    cd[p.category].count++;
    cd[p.category].valor += (p.price||0) * (p.stock||0);
    const st = stockSt(p);
    if (st === 'low') cd[p.category].bajo++;
    if (st === 'out') cd[p.category].sin++;
  });
  if (!Object.keys(cd).length) {
    html('cat-list', '<div class="empty-state" style="padding:2rem"><p>Sin productos aún</p></div>');
    return;
  }
  html('cat-list', `<div class="cat-grid">
    ${Object.entries(cd).sort((a, b) => b[1].count - a[1].count).map(([cat, d]) => `
      <div class="cat-card">
        <div class="cat-card-header">
          <div class="cat-icon" style="background:${CAT_COLORS[cat]}22;color:${CAT_COLORS[cat]}">${CAT_EMOJIS[cat]||'📦'}</div>
          <div class="cat-name">${cat}</div>
        </div>
        <div class="cat-stat"><span>Productos</span><strong>${d.count}</strong></div>
        <div class="cat-stat"><span>Valor en stock</span><strong>${fmt(d.valor)}</strong></div>
        <div class="cat-stat"><span>Stock bajo</span><strong style="color:var(--amber)">${d.bajo}</strong></div>
        <div class="cat-stat"><span>Sin stock</span><strong style="color:var(--red)">${d.sin}</strong></div>
      </div>`).join('')}
  </div>`);
}

// ── Modal producto ────────────────────────────────────────
function openModal(id = null, prefillBC = '') {
  editId = id;
  const fErr = el('form-error'); if (fErr) fErr.textContent = '';
  if (id) {
    const p = products.find(x => x.id === id); if (!p) return;
    el('modal-title').textContent = 'Editar producto';
    el('f-name').value    = p.name;
    el('f-barcode').value = p.barcode || '';
    el('f-cat').value     = p.category;
    el('f-price').value   = p.price;
    el('f-stock').value   = p.stock;
    el('f-min').value     = p.minStock;
    el('f-desc').value    = p.desc || '';
  } else {
    el('modal-title').textContent = 'Agregar producto';
    el('f-name').value = ''; el('f-barcode').value = prefillBC; el('f-cat').value = 'Alimentos';
    el('f-price').value = ''; el('f-stock').value = ''; el('f-min').value = '5'; el('f-desc').value = '';
  }
  el('modal-overlay')?.classList.add('open');
  setTimeout(() => el('f-name')?.focus(), 100);
}
function closeModal() { el('modal-overlay')?.classList.remove('open'); editId = null; }

async function saveProduct() {
  const name     = el('f-name').value.trim();
  const barcode  = el('f-barcode').value.trim();
  const category = el('f-cat').value;
  const price    = parseFloat(el('f-price').value);
  const stock    = parseInt(el('f-stock').value);
  const minStock = parseInt(el('f-min').value) || 0;
  const desc     = el('f-desc').value.trim();
  const errEl    = el('form-error');

  if (!name)                   { if (errEl) errEl.textContent = 'El nombre es requerido.'; return; }
  if (isNaN(price) || price<0) { if (errEl) errEl.textContent = 'Precio inválido.'; return; }
  if (isNaN(stock) || stock<0) { if (errEl) errEl.textContent = 'Stock inválido.'; return; }
  if (barcode) {
    const dup = products.find(p => p.barcode === barcode && p.id !== editId);
    if (dup) { if (errEl) errEl.textContent = `Código ya asignado a "${dup.name}".`; return; }
  }
  if (errEl) errEl.textContent = '';
  const btn = el('btn-guardar');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    if (editId) {
      const prod   = products.find(x => x.id === editId);
      const fields = {name, barcode, category, price, stock, minStock, desc};
      await updateProduct(uid, prod.firestoreId, fields);
      toast('Producto actualizado');
    } else {
      const newProd = { id: nextId++, name, barcode, category, price, stock, minStock, desc };
      await createProduct(uid, newProd);
      toast('Producto agregado', 'green');
    }
    closeModal();
  } catch(e) {
    console.error('saveProduct:', e);
    if (errEl) errEl.textContent = 'Error al guardar. Verifica tu conexión.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar producto'; }
  }
}

async function confirmDelete(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  if (!confirm(`¿Eliminar "${p.name}"?`)) return;
  try {
    await deleteProduct(uid, p.firestoreId);
    toast('Producto eliminado');
  } catch(e) {
    console.error(e); toast('Error al eliminar.', 'error');
  }
}

// ══════════════════════════════════════════════════════════
//  EXPORTACIÓN PDF  —  jsPDF + jsPDF-AutoTable
// ══════════════════════════════════════════════════════════

/** Convierte hex "#RRGGBB" a [r,g,b] */
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}

/**
 * Dibuja el encabezado de cada página:
 * franja azul oscura + logo "W" + título del reporte
 */
function drawPdfHeader(doc, title, subtitle, pageW) {
  // Franja superior
  doc.setFillColor(...PDF_BRAND.primary);
  doc.rect(0, 0, pageW, 42, 'F');

  // Cuadro blanco semitransparente para el logo
  doc.setFillColor(255, 255, 255);
  doc.setGState(new doc.GState({ opacity: 0.15 }));
  doc.roundedRect(13, 8, 26, 26, 5, 5, 'F');
  doc.setGState(new doc.GState({ opacity: 1 }));

  // Letra "W"
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(...PDF_BRAND.white);
  doc.text('W', 26, 25, { align: 'center' });

  // Nombre app
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...PDF_BRAND.white);
  doc.text('W Inventra', 46, 19);

  // Tagline
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(190, 210, 255);
  doc.text('Sistema de Inventario', 46, 26);

  // Título del reporte (derecha)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...PDF_BRAND.white);
  doc.text(title, pageW - 13, 18, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(190, 210, 255);
  doc.text(subtitle, pageW - 13, 25, { align: 'right' });
}

/**
 * Dibuja pie de página en todas las páginas:
 * línea + número de página + texto de marca
 */
function drawPdfFooters(doc, pageW, pageH) {
  const total = doc.internal.getNumberOfPages();
  const fechaStr = new Date().toLocaleString('es-CO', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(...PDF_BRAND.border);
    doc.setLineWidth(0.35);
    doc.line(13, pageH - 13, pageW - 13, pageH - 13);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...PDF_BRAND.text2);
    doc.text(`Generado: ${fechaStr}  ·  W Inventra`, 13, pageH - 7);
    doc.text(`${i} / ${total}`, pageW - 13, pageH - 7, { align: 'right' });
  }
}

/**
 * Dibuja tarjetas de métricas (resumen)
 * cards: [{label, value, color}]
 */
function drawMetricCards(doc, cards, startY, pageW) {
  const margin  = 13;
  const gap     = 5;
  const n       = cards.length;
  const cardW   = (pageW - margin * 2 - gap * (n - 1)) / n;
  const cardH   = 24;

  cards.forEach((card, i) => {
    const x = margin + i * (cardW + gap);
    // Fondo
    doc.setFillColor(...PDF_BRAND.light);
    doc.roundedRect(x, startY, cardW, cardH, 3, 3, 'F');
    // Borde izquierdo de color
    const color = card.color || PDF_BRAND.primary;
    doc.setFillColor(...color);
    doc.roundedRect(x, startY, 3.5, cardH, 1.5, 1.5, 'F');
    // Label
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...PDF_BRAND.text2);
    doc.text(card.label, x + 8, startY + 9);
    // Valor
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...PDF_BRAND.dark);
    doc.text(String(card.value), x + 8, startY + 19);
  });

  return startY + cardH + 8;
}

// ── Exportar Inventario PDF ───────────────────────────────
function exportProductsPDF() {
  if (typeof window.jspdf === 'undefined') {
    toast('Error: librería PDF no cargada', 'error'); return;
  }
  const { jsPDF } = window.jspdf;
  const doc   = new jsPDF({ orientation:'landscape', unit:'pt', format:'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const fechaStr = new Date().toLocaleDateString('es-CO', {
    weekday:'long', day:'numeric', month:'long', year:'numeric'
  });

  drawPdfHeader(doc, 'REPORTE DE INVENTARIO', fechaStr, pageW);

  // Métricas resumen
  const valorTotal = products.reduce((a,p) => a+(p.price||0)*(p.stock||0), 0);
  const sinStock   = products.filter(p => stockSt(p) === 'out').length;
  const stockBajo  = products.filter(p => stockSt(p) === 'low').length;

  let curY = drawMetricCards(doc, [
    { label:'Total productos',   value: products.length,    color: PDF_BRAND.primary },
    { label:'Valor en inventario', value: fmt(valorTotal),  color: PDF_BRAND.green   },
    { label:'Stock bajo',        value: stockBajo,          color: PDF_BRAND.amber   },
    { label:'Sin stock',         value: sinStock,           color: PDF_BRAND.red     },
  ], 52, pageW);

  // Tabla
  const statusLabel = { ok:'En stock', low:'Stock bajo', out:'Sin stock' };
  const rows = products.map((p,i) => [
    i+1, p.name, p.barcode||'—', p.category,
    fmt(p.price), p.stock, p.minStock,
    statusLabel[stockSt(p)]
  ]);

  doc.autoTable({
    head: [['#','Producto','Código','Categoría','Precio','Stock','Mínimo','Estado']],
    body: rows,
    startY: curY,
    margin: { left:13, right:13 },
    styles: {
      font:'helvetica', fontSize:8,
      cellPadding:{ top:5, bottom:5, left:6, right:6 },
      textColor: PDF_BRAND.dark,
      lineColor: PDF_BRAND.border,
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: PDF_BRAND.primary,
      textColor: PDF_BRAND.white,
      fontStyle:'bold',
      fontSize:8,
      halign:'left',
    },
    alternateRowStyles: { fillColor: PDF_BRAND.rowEven },
    columnStyles: {
      0: { halign:'center', cellWidth:22 },
      1: { fontStyle:'bold', cellWidth:150 },
      2: { cellWidth:90 },
      3: { cellWidth:85 },
      4: { halign:'right', cellWidth:65 },
      5: { halign:'center', fontStyle:'bold', cellWidth:45 },
      6: { halign:'center', cellWidth:45 },
      7: { halign:'center', cellWidth:70 },
    },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 7) {
        const v = data.cell.raw;
        if (v === 'Sin stock')   { data.cell.styles.textColor = PDF_BRAND.red;   data.cell.styles.fontStyle='bold'; }
        if (v === 'Stock bajo')  { data.cell.styles.textColor = PDF_BRAND.amber; data.cell.styles.fontStyle='bold'; }
        if (v === 'En stock')    { data.cell.styles.textColor = PDF_BRAND.green; }
      }
    },
    didDrawPage(data) {
      if (data.pageNumber > 1) {
        drawPdfHeader(doc, 'REPORTE DE INVENTARIO', fechaStr, pageW);
      }
    },
  });

  drawPdfFooters(doc, pageW, pageH);
  doc.save(`inventario_${today()}.pdf`);
  toast('✅ PDF de inventario generado', 'green');
}

// ── Exportar Ventas PDF ───────────────────────────────────
function exportVentasPDF() {
  if (typeof window.jspdf === 'undefined') {
    toast('Error: librería PDF no cargada', 'error'); return;
  }
  const { jsPDF } = window.jspdf;
  const doc   = new jsPDF({ orientation:'landscape', unit:'pt', format:'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const lista  = getSalesFiltradas();
  const act    = lista.filter(s => !s.anulada);
  const filtroLabel = { hoy:'Hoy', semana:'Esta semana', mes:'Este mes', todo:'Todas' };
  const periodo = filtroLabel[el('filtro-ventas')?.value || 'todo'];

  const fechaStr = new Date().toLocaleDateString('es-CO', {
    weekday:'long', day:'numeric', month:'long', year:'numeric'
  });

  drawPdfHeader(doc, 'REPORTE DE VENTAS', `Período: ${periodo}  ·  ${fechaStr}`, pageW);

  // Métricas
  const totalIngresos = act.reduce((a,s)=>a+(s.total||0),0);
  const totalItems    = act.reduce((a,s)=>a+s.items.reduce((b,i)=>b+(i.qty||0),0),0);
  const anuladas      = lista.filter(s=>s.anulada).length;

  let curY = drawMetricCards(doc, [
    { label:'Transacciones',    value: act.length,       color: PDF_BRAND.primary },
    { label:'Unidades vendidas',value: totalItems,       color: PDF_BRAND.primary },
    { label:'Total recaudado',  value: fmt(totalIngresos), color: PDF_BRAND.green  },
    { label:'Ventas anuladas',  value: anuladas,         color: PDF_BRAND.red     },
  ], 52, pageW);

  if (!lista.length) {
    doc.setFont('helvetica','normal');
    doc.setFontSize(11);
    doc.setTextColor(...PDF_BRAND.text2);
    doc.text('No hay ventas en este período.', pageW/2, curY+30, {align:'center'});
    drawPdfFooters(doc, pageW, pageH);
    doc.save(`ventas_${today()}.pdf`);
    toast('✅ PDF generado', 'green');
    return;
  }

  // Tabla de ventas
  const rows = lista.map((s, i) => [
    i+1,
    fmtDT(s.date),
    s.items.map(it=>`${it.name} ×${it.qty}`).join('\n'),
    s.items.reduce((a,it)=>a+it.qty,0),
    fmt(s.total),
    s.anulada ? 'ANULADA' : s.cerrada ? 'CERRADA' : 'ACTIVA',
    s.nota || '—',
  ]);

  doc.autoTable({
    head: [['#','Fecha','Productos','Uds.','Total','Estado','Nota']],
    body: rows,
    startY: curY,
    margin: { left:13, right:13 },
    styles: {
      font:'helvetica', fontSize:7.5,
      cellPadding:{ top:5, bottom:5, left:6, right:6 },
      textColor: PDF_BRAND.dark,
      lineColor: PDF_BRAND.border,
      lineWidth: 0.3,
      overflow:'linebreak',
    },
    headStyles: {
      fillColor: PDF_BRAND.primary,
      textColor: PDF_BRAND.white,
      fontStyle:'bold',
      fontSize:8,
      halign:'left',
    },
    alternateRowStyles: { fillColor: PDF_BRAND.rowEven },
    columnStyles: {
      0: { halign:'center', cellWidth:22 },
      1: { cellWidth:80 },
      2: { cellWidth:'auto' },
      3: { halign:'center', cellWidth:35 },
      4: { halign:'right',  fontStyle:'bold', cellWidth:70 },
      5: { halign:'center', cellWidth:58 },
      6: { cellWidth:90 },
    },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 5) {
        const v = data.cell.raw;
        if (v === 'ANULADA') { data.cell.styles.textColor = PDF_BRAND.red;   data.cell.styles.fontStyle='bold'; }
        if (v === 'CERRADA') { data.cell.styles.textColor = PDF_BRAND.text2; }
        if (v === 'ACTIVA')  { data.cell.styles.textColor = PDF_BRAND.green; data.cell.styles.fontStyle='bold'; }
      }
      // Ventas anuladas → texto atenuado en toda la fila
      if (data.section === 'body') {
        const rowData = rows[data.row.index];
        if (rowData && rowData[5] === 'ANULADA') {
          data.cell.styles.textColor = [180,175,165];
        }
      }
    },
    didDrawPage(data) {
      if (data.pageNumber > 1) {
        drawPdfHeader(doc, 'REPORTE DE VENTAS', `Período: ${periodo}  ·  ${fechaStr}`, pageW);
      }
    },
  });

  // Fila de total al final
  const finalY = doc.lastAutoTable.finalY + 6;
  if (finalY < pageH - 30) {
    doc.setFillColor(...PDF_BRAND.primary);
    doc.roundedRect(pageW - 13 - 200, finalY, 200, 22, 3, 3, 'F');
    doc.setFont('helvetica','normal');
    doc.setFontSize(8);
    doc.setTextColor(...PDF_BRAND.white);
    doc.text('TOTAL GENERAL', pageW - 13 - 195, finalY + 9);
    doc.setFont('helvetica','bold');
    doc.setFontSize(11);
    doc.text(fmt(totalIngresos), pageW - 18, finalY + 15, { align:'right' });
  }

  drawPdfFooters(doc, pageW, pageH);
  doc.save(`ventas_${today()}.pdf`);
  toast('✅ Reporte PDF de ventas generado', 'green');
}

// ── Modo oscuro ──────────────────────────────────────────────
(function initDark() {
  if (localStorage.getItem('dark') === '1') {
    document.documentElement.classList.add('dark');
  }
})();

window._toggleDark = () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('dark', isDark ? '1' : '0');
};

// ── Facturación ───────────────────────────────────────────────
let facturaVenta = null;   // venta que se va a facturar
let facturaNumero = 1;     // consecutivo en memoria (se puede mejorar con Firestore)

function abrirFactura(venta) {
  facturaVenta = venta;
  // Recuperar datos guardados del negocio
  const neg = JSON.parse(localStorage.getItem('fac_negocio') || '{}');
  const inp = (id, val) => { const e = el(id); if (e) e.value = val || ''; };
  inp('fac-negocio',   neg.nombre    || '');
  inp('fac-nit',       neg.nit       || '');
  inp('fac-direccion', neg.direccion || '');
  inp('fac-cliente',   '');
  inp('fac-cliente-id','');
  inp('fac-numero',    String(facturaNumero).padStart(4,'0'));
  inp('fac-obs',       venta?.nota   || '');
  el('modal-factura')?.classList.add('open');
}

function guardarDatosNegocio() {
  localStorage.setItem('fac_negocio', JSON.stringify({
    nombre:    el('fac-negocio')?.value.trim()   || '',
    nit:       el('fac-nit')?.value.trim()        || '',
    direccion: el('fac-direccion')?.value.trim()  || '',
  }));
}

function getDatosFactura() {
  return {
    negocio:    el('fac-negocio')?.value.trim()    || 'W Inventra',
    nit:        el('fac-nit')?.value.trim()         || '',
    direccion:  el('fac-direccion')?.value.trim()   || '',
    cliente:    el('fac-cliente')?.value.trim()     || 'Consumidor Final',
    clienteId:  el('fac-cliente-id')?.value.trim()  || '',
    numero:     el('fac-numero')?.value.trim()       || String(facturaNumero).padStart(4,'0'),
    obs:        el('fac-obs')?.value.trim()          || '',
  };
}

// ── PDF de factura ────────────────────────────────────────────
function generarFacturaPDF() {
  if (!facturaVenta || typeof window.jspdf === 'undefined') return;
  guardarDatosNegocio();
  const { jsPDF } = window.jspdf;
  const d    = getDatosFactura();
  const v    = facturaVenta;
  const doc  = new jsPDF({ orientation:'portrait', unit:'pt', format:'a4' });
  const pw   = doc.internal.pageSize.getWidth();
  const ph   = doc.internal.pageSize.getHeight();

  // ── Encabezado ──
  doc.setFillColor(...PDF_BRAND.primary);
  doc.rect(0, 0, pw, 80, 'F');

  // Logo "W"
  doc.setFillColor(255,255,255);
  doc.setGState(new doc.GState({opacity:0.15}));
  doc.roundedRect(30, 15, 50, 50, 8, 8, 'F');
  doc.setGState(new doc.GState({opacity:1}));
  doc.setFont('helvetica','bold');
  doc.setFontSize(26);
  doc.setTextColor(...PDF_BRAND.white);
  doc.text('W', 55, 48, {align:'center'});

  // Nombre negocio
  doc.setFontSize(16);
  doc.setFont('helvetica','bold');
  doc.text(d.negocio, 95, 32);
  doc.setFontSize(9);
  doc.setFont('helvetica','normal');
  doc.setTextColor(200,215,255);
  if (d.nit)       doc.text('NIT: ' + d.nit, 95, 45);
  if (d.direccion) doc.text(d.direccion,      95, 56);

  // FACTURA label (derecha)
  doc.setFont('helvetica','bold');
  doc.setFontSize(18);
  doc.setTextColor(...PDF_BRAND.white);
  doc.text('FACTURA', pw - 30, 33, {align:'right'});
  doc.setFontSize(10);
  doc.setFont('helvetica','normal');
  doc.setTextColor(200,215,255);
  doc.text('N° ' + d.numero, pw - 30, 46, {align:'right'});
  doc.text(fmtDT(v.date), pw - 30, 58, {align:'right'});

  // ── Info cliente ──
  let cy = 100;
  doc.setFillColor(...PDF_BRAND.light);
  doc.roundedRect(30, cy, pw - 60, 52, 6, 6, 'F');
  doc.setFont('helvetica','bold');
  doc.setFontSize(8);
  doc.setTextColor(...PDF_BRAND.text2);
  doc.text('FACTURAR A', 42, cy + 13);
  doc.setFont('helvetica','bold');
  doc.setFontSize(11);
  doc.setTextColor(...PDF_BRAND.dark);
  doc.text(d.cliente, 42, cy + 27);
  doc.setFont('helvetica','normal');
  doc.setFontSize(9);
  doc.setTextColor(...PDF_BRAND.text2);
  if (d.clienteId) doc.text('CC/NIT: ' + d.clienteId, 42, cy + 40);

  // Método de pago (derecha del recuadro)
  const pagoLabels = {efectivo:'Efectivo',transferencia:'Transferencia',tarjeta:'Tarjeta',mixto:'Pago mixto'};
  doc.setFont('helvetica','bold');
  doc.setFontSize(8);
  doc.setTextColor(...PDF_BRAND.text2);
  doc.text('MÉTODO DE PAGO', pw - 42, cy + 13, {align:'right'});
  doc.setFont('helvetica','bold');
  doc.setFontSize(11);
  doc.setTextColor(...PDF_BRAND.dark);
  doc.text(pagoLabels[v.metodoPago] || 'No especificado', pw - 42, cy + 27, {align:'right'});

  cy += 68;

  // ── Tabla de productos ──
  doc.autoTable({
    head: [['Producto','Categoría','Cant.','Precio unit.','Subtotal']],
    body: v.items.map(i => [
      i.name, i.category, i.qty,
      fmt(i.unitPrice), fmt(i.subtotal || i.qty * i.unitPrice)
    ]),
    startY: cy,
    margin: {left:30, right:30},
    styles: {
      font:'helvetica', fontSize:9,
      cellPadding:{top:6,bottom:6,left:8,right:8},
      textColor: PDF_BRAND.dark,
      lineColor: PDF_BRAND.border,
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: PDF_BRAND.primary,
      textColor: PDF_BRAND.white,
      fontStyle:'bold', fontSize:8.5,
    },
    alternateRowStyles: { fillColor: PDF_BRAND.rowEven },
    columnStyles: {
      0: { fontStyle:'bold' },
      2: { halign:'center' },
      3: { halign:'right' },
      4: { halign:'right', fontStyle:'bold' },
    },
  });

  cy = doc.lastAutoTable.finalY + 16;

  // ── Total ──
  doc.setFillColor(...PDF_BRAND.primary);
  doc.roundedRect(pw - 200, cy, 170, 36, 6, 6, 'F');
  doc.setFont('helvetica','normal');
  doc.setFontSize(9);
  doc.setTextColor(...PDF_BRAND.white);
  doc.text('TOTAL A PAGAR', pw - 195, cy + 13);
  doc.setFont('helvetica','bold');
  doc.setFontSize(16);
  doc.text(fmt(v.total), pw - 35, cy + 25, {align:'right'});

  cy += 50;

  // ── Observaciones ──
  if (d.obs) {
    doc.setFont('helvetica','bold');
    doc.setFontSize(8);
    doc.setTextColor(...PDF_BRAND.text2);
    doc.text('OBSERVACIONES', 30, cy);
    doc.setFont('helvetica','normal');
    doc.setFontSize(9);
    doc.setTextColor(...PDF_BRAND.dark);
    doc.text(d.obs, 30, cy + 12);
    cy += 28;
  }

  // ── Pie ──
  doc.setDrawColor(...PDF_BRAND.border);
  doc.setLineWidth(0.4);
  doc.line(30, ph - 40, pw - 30, ph - 40);
  doc.setFont('helvetica','normal');
  doc.setFontSize(8);
  doc.setTextColor(...PDF_BRAND.text2);
  doc.text('Gracias por su compra · ' + d.negocio, pw/2, ph - 28, {align:'center'});
  doc.text('Factura N° ' + d.numero + ' · Generado con W Inventra', pw/2, ph - 16, {align:'center'});

  doc.save('factura_' + d.numero + '_' + today() + '.pdf');
  facturaNumero++;
  el('modal-factura')?.classList.remove('open');
  toast('✅ Factura PDF generada', 'green');
}

// ── Ticket de impresión 80mm ──────────────────────────────────
function imprimirTicket() {
  if (!facturaVenta) return;
  guardarDatosNegocio();
  const d = getDatosFactura();
  const v = facturaVenta;
  const pagoLabels = { efectivo:'Efectivo', transferencia:'Nequi/Transfer.', tarjeta:'Tarjeta', mixto:'Mixto' };
  const sep = '<div style="border-top:1px dashed #000;margin:6px 0"></div>';

  // Filas de productos
  const itemRows = v.items.map(i => {
    const sub = fmt(i.qty * i.unitPrice);
    return `
      <tr>
        <td style="padding:2px 0;vertical-align:top">${i.name}<br>
          <span style="font-size:10px">${i.qty} x ${fmt(i.unitPrice)}</span>
        </td>
        <td style="text-align:right;font-weight:700;vertical-align:top;white-space:nowrap;padding-left:8px">${sub}</td>
      </tr>`;
  }).join('');

  const ticket = document.getElementById('ticket-print');
  if (!ticket) return;

  ticket.innerHTML = `
    <style>
      @media print {
        @page { margin: 4mm; size: 80mm auto; }
        body > *:not(#ticket-print) { display:none !important; }
        #ticket-print { display:block !important; }
      }
      #ticket-print {
        font-family: 'Courier New', Courier, monospace;
        font-size: 12px;
        line-height: 1.55;
        width: 72mm;
        color: #000;
        margin: 0 auto;
      }
    </style>

    <!-- ENCABEZADO -->
    <div style="text-align:center;margin-bottom:6px">
      <div style="
        display:inline-flex;align-items:center;justify-content:center;
        width:38px;height:38px;border-radius:8px;
        background:#000;color:#fff;
        font-size:22px;font-weight:900;
        margin-bottom:5px;
      ">W</div>
      <div style="font-size:16px;font-weight:900;letter-spacing:.5px">${d.negocio.toUpperCase()}</div>
      ${d.nit       ? `<div style="font-size:10px">NIT: ${d.nit}</div>` : ''}
      ${d.direccion ? `<div style="font-size:10px">${d.direccion}</div>` : ''}
    </div>

    ${sep}

    <!-- INFO VENTA -->
    <div style="font-size:10px">
      <div style="display:flex;justify-content:space-between">
        <span>Fecha:</span><span>${fmtDT(v.date)}</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span>Cliente:</span><span style="font-weight:700">${d.cliente}</span>
      </div>
      ${d.clienteId ? `<div style="display:flex;justify-content:space-between"><span>CC/NIT:</span><span>${d.clienteId}</span></div>` : ''}
    </div>

    ${sep}

    <!-- PRODUCTOS -->
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="font-size:10px;border-bottom:1px solid #000">
          <th style="text-align:left;padding-bottom:3px">Producto</th>
          <th style="text-align:right;padding-bottom:3px">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    ${sep}

    <!-- TOTALES -->
    <div style="font-size:11px">
      <div style="display:flex;justify-content:space-between">
        <span>Subtotal:</span><span>${fmt(v.total)}</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span>Método pago:</span><span>${pagoLabels[v.metodoPago] || '—'}</span>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:900;margin:6px 0 2px;border-top:2px solid #000;padding-top:5px">
      <span>TOTAL</span><span>${fmt(v.total)}</span>
    </div>

    ${sep}

    <!-- PIE -->
    <div style="text-align:center;font-size:11px;margin-top:4px">
      ¡Gracias por su compra!
    </div>
    <div style="text-align:center;font-size:9px;margin-top:2px;color:#555">
      ${d.negocio} · W Inventra
    </div>
    <br><br><br>
  `;

  el('modal-factura')?.classList.remove('open');
  setTimeout(() => window.print(), 250);
  toast('🖨️ Enviando a impresora…', 'green');
}

// ── Abrir factura desde historial ────────────────────────────
window._facturarVenta = (fid) => {
  const v = sales.find(s => s.firestoreId === fid);
  if (v) abrirFactura(v);
};

// ── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  syncProductCategoryOptions();

  onAuthStateChanged(auth, user => {
    if (!user) { window.location.replace('login.html'); return; }
    uid = user.uid;
    const em = el('user-email-display'); if (em) em.textContent = user.email;
    el('btn-logout')?.addEventListener('click', async () => { await signOut(auth); window.location.replace('login.html'); });
    initListeners();
  });

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => { setView(item.dataset.view); el('sidebar')?.classList.remove('open'); });
  });

  el('menu-toggle')?.addEventListener('click',   () => el('sidebar')?.classList.toggle('open'));
  el('btn-agregar')?.addEventListener('click',   () => openModal());
  el('modal-close')?.addEventListener('click',   closeModal);
  el('btn-cancelar')?.addEventListener('click',  closeModal);
  el('btn-guardar')?.addEventListener('click',   saveProduct);
  el('modal-overlay')?.addEventListener('click', e => { if (e.target === el('modal-overlay')) closeModal(); });

  el('nf-close')?.addEventListener('click',    () => { el('modal-not-found')?.classList.remove('open'); focusScanner(); });
  el('nf-cancelar')?.addEventListener('click', () => { el('modal-not-found')?.classList.remove('open'); focusScanner(); });
  el('nf-agregar')?.addEventListener('click',  () => { el('modal-not-found')?.classList.remove('open'); openModal(null, pendingCode); });

  el('search')?.addEventListener('input',        renderTable);
  el('cat-filter')?.addEventListener('change',   renderTable);
  el('stock-filter')?.addEventListener('change', renderTable);

  el('btn-add-cosmetic-brand')?.addEventListener('click', addCosmeticBrand);
  el('new-cosmetic-brand')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addCosmeticBrand();
  });
  el('cosmetic-brands')?.addEventListener('change', e => {
    if (e.target.matches('[data-brand-parent]')) {
      toggleCosmeticBrands(e.target.checked);
      return;
    }
    const encodedBrand = e.target.getAttribute('data-brand');
    if (!encodedBrand) return;
    const brand = decodeURIComponent(encodedBrand);
    const selected = readSelectedCosmeticBrands();
    if (e.target.checked) selected.add(brand);
    else selected.delete(brand);
    saveCosmeticSelection(selected);
    renderCosmeticBrands();
  });

  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      if (sortCol === th.dataset.col) sortAsc = !sortAsc;
      else { sortCol = th.dataset.col; sortAsc = true; }
      renderTable();
    });
  });

  // ← PDF en lugar de CSV
  el('btn-export')?.addEventListener('click',           exportProductsPDF);
  el('btn-confirmar')?.addEventListener('click',        confirmarVenta);
  el('btn-vaciar')?.addEventListener('click',           () => { if (carrito.length && confirm('¿Vaciar el carrito?')) clearCart(); });
  el('filtro-ventas')?.addEventListener('change',       renderHistorial);
  // ← PDF en lugar de CSV
  el('btn-export-ventas')?.addEventListener('click',    exportVentasPDF);
  el('btn-borrar-historial')?.addEventListener('click', borrarHistorial);
  el('btn-cierre-caja')?.addEventListener('click',      abrirCierre);
  el('btn-cierre-ventas')?.addEventListener('click',    abrirCierre);
  el('cierre-close')?.addEventListener('click',         () => el('modal-cierre')?.classList.remove('open'));
  el('cierre-cancelar')?.addEventListener('click',      () => el('modal-cierre')?.classList.remove('open'));
  el('cierre-confirmar')?.addEventListener('click',     confirmarCierre);

  // Factura
  el('factura-close')?.addEventListener('click',  () => el('modal-factura')?.classList.remove('open'));
  el('factura-cancel')?.addEventListener('click', () => el('modal-factura')?.classList.remove('open'));
  el('factura-ticket')?.addEventListener('click', imprimirTicket);

  initScanner();
});