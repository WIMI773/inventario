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

// ── Estado ────────────────────────────────────────────────
let uid         = null;
let products    = [];
let sales       = [];
let nextId      = 1;
let carrito     = [];
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

// ── Dashboard ─────────────────────────────────────────────
function renderDashboard() {
  renderStats();
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
    carrito.push({ productId:prod.id, name:prod.name, barcode:prod.barcode||'', category:prod.category, qty:1, unitPrice:prod.price });
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
  if (items) items.innerHTML = carrito.map((item, idx) => `
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
      <input class="ci-price-input" type="number" value="${item.unitPrice}"
        onchange="window._chgPrice(${item.productId},this.value)" title="Precio unitario">
      <div class="ci-subtotal">${fmt(item.qty * item.unitPrice)}</div>
      <button class="ci-remove" onclick="window._rmCart(${item.productId})" title="Quitar">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
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
    nota, date: new Date().toISOString(), anulada: false, cerrada: false
  };
  const btn = el('btn-confirmar');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    await commitSale(uid, venta, products);
    const n = venta.items.reduce((a, i) => a + i.qty, 0);
    toast(`Venta registrada · ${n} ítem${n !== 1 ? 's' : ''} · ${fmt(venta.total)}`, 'green');
    clearCart(); clearInput(); focusScanner();
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
            <div class="vi-meta">${fmtDT(s.date)}${s.cerrada?' · <span class="badge-cerrada">Caja cerrada</span>':''}</div>
            ${s.nota ? `<div class="vi-nota">📝 ${s.nota}</div>` : ''}
            ${!s.anulada && !s.cerrada
              ? `<button class="btn-anular" onclick="window._anularVenta('${s.firestoreId}')">Anular</button>`
              : s.anulada ? `<span style="font-size:11px;color:var(--red)">Anulada</span>` : ''}
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

// ── CSV ───────────────────────────────────────────────────
function exportProductsCSV() {
  const rows = [['ID','Código','Nombre','Categoría','Precio','Stock','Mínimo','Estado'],
    ...products.map(p => [p.id, `"${p.barcode||''}"`, `"${p.name}"`, `"${p.category}"`,
      p.price, p.stock, p.minStock, {ok:'En stock',low:'Stock bajo',out:'Sin stock'}[stockSt(p)]])];
  downloadCSV(rows, `inventario_${today()}.csv`); toast('CSV exportado');
}

function exportVentasCSV() {
  const lista = getSalesFiltradas();
  const act   = lista.filter(s => !s.anulada);

  const totalIngresos = act.reduce((a, s) => a + (s.total || 0), 0);
  const totalItems    = act.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.qty || 0), 0), 0);
  const totalVentas   = act.length;

  const filtroLabel = { hoy:'Hoy', semana:'Esta semana', mes:'Este mes', todo:'Todas' };
  const periodo = filtroLabel[el('filtro-ventas')?.value || 'todo'];

  const fechaExport = new Date().toLocaleString('es-CO');

  const rows = [

    // ───── HEADER LIMPIO ─────
    ['REPORTE DE VENTAS'],
    ['Negocio','W INVENTRA'],
    ['Fecha de exportación', fechaExport],
    ['Período', periodo],
    [],

    // ───── RESUMEN ─────
    ['RESUMEN'],
    ['Total ventas', totalVentas],
    ['Productos vendidos', totalItems],
    ['Ingresos totales', totalIngresos],
    ['Ventas anuladas', lista.filter(s => s.anulada).length],
    [],

    // ───── TABLA PRINCIPAL ─────
    [
      'N°',
      'ID Venta',
      'Fecha',
      'Productos',
      'Cantidad Total',
      'Total ($)',
      'Estado',
      'Nota'
    ],

    ...lista.map((s, i) => [
      i + 1,
      s.firestoreId,
      fmtDT(s.date),
      s.items.map(it => `${it.name} (x${it.qty})`).join(' | '),
      s.items.reduce((a, it) => a + it.qty, 0),
      s.total,
      s.anulada ? 'ANULADA' : s.cerrada ? 'CERRADA' : 'ACTIVA',
      s.nota || ''
    ]),

    [],

    // ───── TOTAL FINAL ─────
    ['','','','','TOTAL GENERAL', totalIngresos]

  ];

  downloadCSV(rows, `VENTAS_${today()}.csv`);
  toast('✅ Reporte profesional generado', 'green');
}

function downloadCSV(rows, filename) {
  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// ── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

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

  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      if (sortCol === th.dataset.col) sortAsc = !sortAsc;
      else { sortCol = th.dataset.col; sortAsc = true; }
      renderTable();
    });
  });

  el('btn-export')?.addEventListener('click',           exportProductsCSV);
  el('btn-confirmar')?.addEventListener('click',        confirmarVenta);
  el('btn-vaciar')?.addEventListener('click',           () => { if (carrito.length && confirm('¿Vaciar el carrito?')) clearCart(); });
  el('filtro-ventas')?.addEventListener('change',       renderHistorial);
  el('btn-export-ventas')?.addEventListener('click',    exportVentasCSV);
  el('btn-borrar-historial')?.addEventListener('click', borrarHistorial);
  el('btn-cierre-caja')?.addEventListener('click',      abrirCierre);
  el('btn-cierre-ventas')?.addEventListener('click',    abrirCierre);
  el('cierre-close')?.addEventListener('click',         () => el('modal-cierre')?.classList.remove('open'));
  el('cierre-cancelar')?.addEventListener('click',      () => el('modal-cierre')?.classList.remove('open'));
  el('cierre-confirmar')?.addEventListener('click',     confirmarCierre);

  initScanner();
});