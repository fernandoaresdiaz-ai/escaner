/* Escáner — lógica de la app */
'use strict';

const $ = (id) => document.getElementById(id);
const PROC_MAX = 3000;            // tamaño máximo de la página procesada (px)
const QUALITY = {
  alta:  { max: 2400, q: 0.88 },
  media: { max: 1600, q: 0.72 },
  baja:  { max: 1100, q: 0.55 },
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function pad(n) { return String(n).padStart(2, '0'); }
function autoName(d = new Date()) {
  return `Escaneo ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' MB';
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function showLoading(text) { $('loadingText').textContent = text; $('loading').classList.add('show'); }
function hideLoading() { $('loading').classList.remove('show'); }
function getPref(k, def) { try { return localStorage.getItem(k) || def; } catch { return def; } }
function setPref(k, v) { try { localStorage.setItem(k, v); } catch {} }

function confirmDialog(title, text, yesLabel = 'Borrar') {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text;
    $('confirmYes').textContent = yesLabel;
    const dlg = $('confirmDlg'); dlg.classList.add('show');
    const done = (v) => { dlg.classList.remove('show'); $('confirmYes').onclick = $('confirmNo').onclick = null; resolve(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
function canvasToBlob(canvas, q = 0.9) {
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
}
// Imagen -> píxeles, con tamaño máximo opcional
function imageToPixels(img, maxDim) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const k = maxDim ? Math.min(1, maxDim / Math.max(w0, h0)) : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  return { data: g.getImageData(0, 0, c.width, c.height), scale: k };
}

/* ------------------------------------------------------------------ */
/* Base de datos local (IndexedDB)                                     */
/* ------------------------------------------------------------------ */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('escaner', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('docs', { keyPath: 'id' });
        const p = db.createObjectStore('pages', { keyPath: 'id' });
        p.createIndex('docId', 'docId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    getDoc: (id) => tx('docs', 'readonly', (s) => s.get(id)),
    allDocs: () => tx('docs', 'readonly', (s) => s.getAll()),
    putDoc: (d) => tx('docs', 'readwrite', (s) => s.put(d)),
    delDoc: (id) => tx('docs', 'readwrite', (s) => s.delete(id)),
    getPage: (id) => tx('pages', 'readonly', (s) => s.get(id)),
    putPage: (p) => tx('pages', 'readwrite', (s) => s.put(p)),
    delPage: (id) => tx('pages', 'readwrite', (s) => s.delete(id)),
  };
})();

/* ------------------------------------------------------------------ */
/* Trabajador con OpenCV                                               */
/* ------------------------------------------------------------------ */
const Engine = (() => {
  const worker = new Worker('worker.js');
  let seq = 0; const pending = new Map();
  worker.onmessage = (e) => {
    const m = e.data; const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error));
  };
  worker.onerror = (e) => { console.error('worker', e); };
  function call(msg, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }
  let readyP = null, isReady = false;
  function ready() {
    if (!readyP) readyP = call({ type: 'init' }).then(() => { isReady = true; }, (e) => { readyP = null; throw e; });
    return readyP;
  }
  function detect(imageData, maxDim) {
    const buf = imageData.data.buffer;
    return call({ type: 'detect', w: imageData.width, h: imageData.height, buffer: buf, maxDim }, [buf]).then((r) => r.quad);
  }
  function process(imageData, opts) {
    const buf = imageData.data.buffer;
    return call(Object.assign({ type: 'process', w: imageData.width, h: imageData.height, buffer: buf }, opts), [buf]);
  }
  return { ready, detect, process, get isReady() { return isReady; } };
})();

/* Genera la imagen final de una página (enderezada + filtro + giro) y su miniatura */
const procQueue = new Map(); // pageId -> promesa
async function renderPage(page, pixels) {
  // pixels: ImageData del original (opcional, si ya lo tenemos)
  if (!pixels) {
    const img = await blobToImage(page.orig);
    pixels = imageToPixels(img).data;
  }
  const r = await Engine.process(pixels, {
    quad: page.quad, fallback: page.fallback || null, rot: page.rot, filter: page.filter, maxOut: PROC_MAX,
  });
  if (!page.quad) { page.quad = r.quad; page.auto = r.detected; }
  delete page.fallback;
  const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.w, r.h), 0, 0);
  page.proc = await canvasToBlob(c, 0.9);
  page.pw = r.w; page.ph = r.h;
  const k = Math.min(1, 420 / Math.max(r.w, r.h));
  const t = document.createElement('canvas'); t.width = Math.round(r.w * k); t.height = Math.round(r.h * k);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  page.thumb = await canvasToBlob(t, 0.8);
  c.width = c.height = 0;
  return page;
}
function queueRender(page, pixels) {
  const prev = procQueue.get(page.id) || Promise.resolve();
  const p = prev.catch(() => {}).then(async () => {
    await renderPage(page, pixels);
    await DB.putPage(page);
    thumbURL.drop(page.id);
    return page;
  });
  procQueue.set(page.id, p);
  p.finally(() => { if (procQueue.get(page.id) === p) procQueue.delete(page.id); }).catch(() => {});
  return p;
}

/* URLs de miniaturas (se liberan al cambiar) */
const thumbURL = (() => {
  const m = new Map();
  return {
    get(page) {
      if (!page.thumb) return null;
      if (!m.has(page.id)) m.set(page.id, URL.createObjectURL(page.thumb));
      return m.get(page.id);
    },
    drop(id) { if (m.has(id)) { URL.revokeObjectURL(m.get(id)); m.delete(id); } },
  };
})();

/* ------------------------------------------------------------------ */
/* Navegación                                                          */
/* ------------------------------------------------------------------ */
let current = 'home';
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (current === 'camera' && id !== 'camera') Camera.stop();
  current = id;
  const dark = id === 'camera' || id === 'editor' || id === 'corners';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#000000' : '#f6f6f3');
}

/* ------------------------------------------------------------------ */
/* Inicio / historial                                                  */
/* ------------------------------------------------------------------ */
async function renderHome() {
  const list = $('docList');
  const docs = (await DB.allDocs()).sort((a, b) => b.updated - a.updated);
  list.innerHTML = '';
  if (!docs.length) {
    list.innerHTML = `
      <div class="empty">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5M9 13h8M9 17h6"/></svg>
        Aún no hay escaneos.<br>Toca <b>Escanear</b> para empezar.
        <div class="tips"><b>Para que salga mejor</b>
          · Pon la hoja sobre un fondo oscuro o de otro color.<br>
          · Móvil paralelo a la hoja, justo encima.<br>
          · Si hay poca luz, usa la linterna.</div>
      </div>`;
    return;
  }
  for (const d of docs) {
    const first = d.pages.length ? await DB.getPage(d.pages[0]) : null;
    const b = document.createElement('button');
    b.className = 'docitem';
    const url = first && thumbURL.get(first);
    b.innerHTML = `<div class="docthumb"></div><div class="docmeta"><div class="docname"></div><div class="docsub"></div></div>
      <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="#b5b7bb" stroke-width="2.4" stroke-linecap="round"><path d="M2 2l6 6-6 6"/></svg>`;
    if (url) b.querySelector('.docthumb').style.backgroundImage = `url("${url}")`;
    b.querySelector('.docname').textContent = d.name;
    b.querySelector('.docsub').textContent = `${d.pages.length} ${d.pages.length === 1 ? 'página' : 'páginas'} · ${fmtDate(d.updated)}`;
    b.onclick = () => openDoc(d.id);
    list.appendChild(b);
  }
}

/* ------------------------------------------------------------------ */
/* Cámara                                                              */
/* ------------------------------------------------------------------ */
const Camera = (() => {
  const video = $('video'), overlay = $('overlay');
  const small = document.createElement('canvas');
  const sg = small.getContext('2d', { willReadFrequently: true });
  let stream = null, track = null, running = false, busy = false, torchOn = false;
  let liveQuad = null, shownQuad = null, missCount = 0, lastDetect = 0;
  let docId = null, count = 0, lastThumb = null;

  async function start(targetDocId) {
    docId = targetDocId || null;
    count = 0; lastThumb = null;
    if (docId) { const d = await DB.getDoc(docId); count = d ? d.pages.length : 0; }
    updateBottom();
    $('camError').style.display = 'none';
    show('camera');
    if (!Engine.isReady) {
      showLoading('Preparando el escáner…\nLa primera vez tarda un poco (se descarga una vez y luego funciona sin internet).');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 }, aspectRatio: { ideal: 4 / 3 } },
      });
    } catch (err) {
      hideLoading();
      const el = $('camError');
      el.style.display = 'grid';
      el.innerHTML = `<div><b>No puedo usar la cámara.</b><br><br>Ve a <b>Ajustes → Safari → Cámara</b> y elige <b>Permitir</b> (o «Preguntar»), y vuelve a abrir la app.<br><br><button class="btn primary" style="padding:0 24px;margin:0 auto" id="camErrBack">Volver</button></div>`;
      $('camErrBack').onclick = () => { show('home'); renderHome(); };
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    track = stream.getVideoTracks()[0];
    torchOn = false;
    let caps = {};
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch {}
    const tb = $('torchBtn');
    tb.style.visibility = caps.torch ? 'visible' : 'hidden';
    tb.classList.remove('on');
    try { await Engine.ready(); } catch (e) {
      hideLoading(); toast('No se pudo cargar el escáner. Comprueba la conexión la primera vez.', 5000); return;
    }
    hideLoading();
    running = true; liveQuad = shownQuad = null; missCount = 0;
    requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null;
    video.srcObject = null;
    const g = overlay.getContext('2d'); g.clearRect(0, 0, overlay.width, overlay.height);
  }

  // Relación entre píxeles del vídeo y de la pantalla (object-fit: cover)
  function mapping() {
    const vw = overlay.clientWidth, vh = overlay.clientHeight;
    const W = video.videoWidth, H = video.videoHeight;
    const s = Math.max(vw / W, vh / H);
    return { s, ox: (vw - W * s) / 2, oy: (vh - H * s) / 2 };
  }

  function loop(ts) {
    if (!running) return;
    requestAnimationFrame(loop);
    draw();
    if (busy || ts - lastDetect < 110 || !video.videoWidth) return;
    lastDetect = ts; busy = true;
    const W = video.videoWidth, H = video.videoHeight;
    const k = 360 / Math.max(W, H);
    small.width = Math.round(W * k); small.height = Math.round(H * k);
    sg.drawImage(video, 0, 0, small.width, small.height);
    const id = sg.getImageData(0, 0, small.width, small.height);
    Engine.detect(id, 360).then((q) => {
      if (q) {
        q = q.map((p) => ({ x: p.x / k, y: p.y / k }));
        liveQuad = q; missCount = 0;
      } else if (++missCount > 4) liveQuad = null;
    }).catch(() => {}).finally(() => { busy = false; });
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== Math.round(cw * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    const g = overlay.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    if (liveQuad) {
      shownQuad = shownQuad ? shownQuad.map((p, i) => ({ x: p.x + (liveQuad[i].x - p.x) * 0.45, y: p.y + (liveQuad[i].y - p.y) * 0.45 })) : liveQuad;
    } else shownQuad = null;
    $('camHint').textContent = shownQuad ? 'Hoja detectada' : 'Buscando la hoja…';
    if (!shownQuad || !video.videoWidth) return;
    const m = mapping();
    const pts = shownQuad.map((p) => ({ x: m.ox + p.x * m.s, y: m.oy + p.y * m.s }));
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
    g.fillStyle = 'rgba(31,111,235,0.18)'; g.fill();
    g.lineWidth = 3; g.strokeStyle = '#4c8dff'; g.lineJoin = 'round'; g.stroke();
    g.fillStyle = '#fff';
    pts.forEach((p) => { g.beginPath(); g.arc(p.x, p.y, 6, 0, Math.PI * 2); g.fill(); });
  }

  async function capture() {
    if (!video.videoWidth) return;
    const btn = $('shutter'); btn.disabled = true;
    const f = $('flash'); f.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go')));
    try {
      const W = video.videoWidth, H = video.videoHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0);
      const pixels = g.getImageData(0, 0, W, H);
      const orig = await canvasToBlob(c, 0.92);
      c.width = c.height = 0;

      // documento nuevo en la primera foto
      let doc;
      if (!docId) {
        const now = Date.now();
        doc = { id: uid(), name: autoName(), created: now, updated: now, pages: [] };
        docId = doc.id;
      } else doc = await DB.getDoc(docId);

      const page = {
        id: uid(), docId, orig, w: W, h: H, quad: null, auto: true, rot: 0,
        filter: getPref('filter', 'sombras'), fallback: liveQuad ? liveQuad.map((p) => ({ ...p })) : null,
      };
      await DB.putPage(page);
      doc.pages.push(page.id); doc.updated = Date.now();
      await DB.putDoc(doc);
      count = doc.pages.length;
      updateBottom();
      queueRender(page, pixels).then((p) => { lastThumb = thumbURL.get(p); updateBottom(); })
        .catch((e) => toast('Error al procesar la página: ' + e.message));
    } catch (e) {
      toast('No se pudo hacer la foto: ' + e.message);
    } finally {
      setTimeout(() => (btn.disabled = false), 350);
    }
  }

  function updateBottom() {
    $('camCount').textContent = count;
    $('camStack').classList.toggle('show', count > 0);
    $('camDone').classList.toggle('show', count > 0);
    $('camStack').style.backgroundImage = lastThumb ? `url("${lastThumb}")` : '';
  }

  async function toggleTorch() {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); }
    catch { torchOn = false; toast('Este móvil no deja encender la linterna desde la web.'); }
    $('torchBtn').classList.toggle('on', torchOn);
  }

  async function finish() {
    const id = docId; stop();
    if (id) openDoc(id); else { show('home'); renderHome(); }
  }

  function resume() { return start(docId); }

  return { start, stop, resume, capture, toggleTorch, finish };
})();

$('scanBtn').onclick = () => Camera.start(null);
$('shutter').onclick = () => Camera.capture();
$('torchBtn').onclick = () => Camera.toggleTorch();
$('camDone').onclick = () => Camera.finish();
$('camStack').onclick = () => Camera.finish();
$('camClose').onclick = () => Camera.finish();
document.addEventListener('visibilitychange', () => {
  if (document.hidden && current === 'camera') Camera.stop();
  else if (!document.hidden && current === 'camera') Camera.resume();
});

/* ------------------------------------------------------------------ */
/* Documento                                                           */
/* ------------------------------------------------------------------ */
let currentDocId = null;
let renderToken = 0;
async function openDoc(id) {
  currentDocId = id;
  show('doc');
  await renderDoc();
}
async function renderDoc() {
  const token = ++renderToken;
  const doc = await DB.getDoc(currentDocId);
  if (!doc) { show('home'); renderHome(); return; }
  $('docName').value = doc.name;
  const grid = $('pageGrid'); grid.innerHTML = '';
  $('exportBtn').disabled = doc.pages.length === 0;
  if (!doc.pages.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Este documento no tiene páginas.<br>Toca <b>Añadir páginas</b>.</div>';
  }
  for (let i = 0; i < doc.pages.length; i++) {
    const pid = doc.pages[i];
    const page = await DB.getPage(pid);
    if (token !== renderToken) return;
    const card = document.createElement('div'); card.className = 'pagecard';
    card.innerHTML = `<button class="pageimg"><span class="pagenum">${i + 1}</span></button>
      <div class="pagetools">
        <button data-a="left" aria-label="Mover antes"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <button data-a="del" aria-label="Borrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        <button data-a="right" aria-label="Mover después"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>`;
    const imgBtn = card.querySelector('.pageimg');
    const processing = procQueue.has(pid) || !page || !page.thumb;
    if (!processing) imgBtn.style.backgroundImage = `url("${thumbURL.get(page)}")`;
    else {
      imgBtn.insertAdjacentHTML('beforeend', '<span class="spinner"></span>');
      const pr = procQueue.get(pid);
      if (pr) pr.then(() => { if (token === renderToken) renderDoc(); }).catch(() => {});
      else if (page) queueRender(page).then(() => { if (token === renderToken) renderDoc(); }).catch(() => {});
    }
    if (page && page.auto === false) imgBtn.insertAdjacentHTML('beforeend', '<span class="pagewarn">Revisar esquinas</span>');
    imgBtn.onclick = () => { if (page) openEditor(pid); };
    const [bl, bd, br] = card.querySelectorAll('.pagetools button');
    bl.disabled = i === 0; br.disabled = i === doc.pages.length - 1;
    bl.onclick = () => movePage(i, -1);
    br.onclick = () => movePage(i, +1);
    bd.onclick = () => deletePage(pid);
    grid.appendChild(card);
  }
}
async function movePage(i, dir) {
  const doc = await DB.getDoc(currentDocId);
  const j = i + dir; if (j < 0 || j >= doc.pages.length) return;
  [doc.pages[i], doc.pages[j]] = [doc.pages[j], doc.pages[i]];
  doc.updated = Date.now(); await DB.putDoc(doc); invalidatePdf(); renderDoc();
}
async function deletePage(pid) {
  if (!(await confirmDialog('¿Borrar esta página?', 'No se puede deshacer.'))) return false;
  const doc = await DB.getDoc(currentDocId);
  doc.pages = doc.pages.filter((x) => x !== pid); doc.updated = Date.now();
  await DB.putDoc(doc); await DB.delPage(pid); thumbURL.drop(pid); invalidatePdf();
  renderDoc();
  return true;
}
$('docBack').onclick = () => { show('home'); renderHome(); };
$('addPages').onclick = () => Camera.start(currentDocId);
$('docName').addEventListener('change', async () => {
  const doc = await DB.getDoc(currentDocId); if (!doc) return;
  const v = $('docName').value.trim() || autoName(new Date(doc.created));
  doc.name = v; $('docName').value = v; doc.updated = Date.now(); await DB.putDoc(doc);
});
$('docName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('docDelete').onclick = async () => {
  const doc = await DB.getDoc(currentDocId); if (!doc) return;
  if (!(await confirmDialog('¿Borrar el documento entero?', `«${doc.name}» y sus ${doc.pages.length} páginas se borrarán de este móvil. No se puede deshacer.`))) return;
  for (const pid of doc.pages) { await DB.delPage(pid); thumbURL.drop(pid); }
  await DB.delDoc(doc.id);
  show('home'); renderHome();
};

/* ------------------------------------------------------------------ */
/* Editor de página                                                    */
/* ------------------------------------------------------------------ */
let edPage = null, edURL = null;
async function openEditor(pid) {
  edPage = await DB.getPage(pid);
  if (!edPage) return;
  show('editor');
  await refreshEditor();
}
async function refreshEditor(busyRender) {
  const doc = await DB.getDoc(currentDocId);
  const idx = doc.pages.indexOf(edPage.id);
  $('edTitle').textContent = `Página ${idx + 1} de ${doc.pages.length}`;
  document.querySelectorAll('#edChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.f === edPage.filter));
  const prev = $('edPreview');
  let sp = prev.querySelector('.spinner');
  if (busyRender) {
    if (!sp) prev.insertAdjacentHTML('beforeend', '<span class="spinner"></span>');
    return;
  }
  if (sp) sp.remove();
  if (edURL) URL.revokeObjectURL(edURL);
  edURL = edPage.proc ? URL.createObjectURL(edPage.proc) : null;
  $('edImg').src = edURL || '';
}
async function rerender() {
  const page = edPage;
  refreshEditor(true);
  invalidatePdf();
  try { await queueRender(page); } catch (e) { toast('Error: ' + e.message); }
  if (edPage === page && current === 'editor') refreshEditor();
}
$('edChips').onclick = (e) => {
  const c = e.target.closest('.chip'); if (!c || !edPage) return;
  if (edPage.filter === c.dataset.f) return;
  edPage.filter = c.dataset.f; setPref('filter', c.dataset.f);
  rerender();
};
$('edRotL').onclick = () => { edPage.rot = (edPage.rot + 3) % 4; rerender(); };
$('edRotR').onclick = () => { edPage.rot = (edPage.rot + 1) % 4; rerender(); };
$('edAll').onclick = async () => {
  const doc = await DB.getDoc(currentDocId);
  const f = edPage.filter;
  let n = 0;
  for (const pid of doc.pages) {
    if (pid === edPage.id) continue;
    const p = await DB.getPage(pid);
    if (p && p.filter !== f) { p.filter = f; queueRender(p).catch(() => {}); n++; }
  }
  invalidatePdf();
  toast(n ? `Filtro aplicado a ${n} ${n === 1 ? 'página más' : 'páginas más'}` : 'Todas las páginas ya tenían este filtro');
};
$('edDelete').onclick = async () => {
  if (await deletePage(edPage.id)) { edPage = null; show('doc'); }
};
$('edDone').onclick = () => { show('doc'); renderDoc(); };
$('edCorners').onclick = () => Corners.open(edPage);

/* ------------------------------------------------------------------ */
/* Ajuste manual de esquinas                                           */
/* ------------------------------------------------------------------ */
const Corners = (() => {
  const stage = $('cStage'), img = $('cImg'), svg = $('cSvg'), loupe = $('cLoupe');
  const lg = loupe.getContext('2d');
  let page = null, quad = null, url = null, box = null, drag = -1;

  async function open(p) {
    page = p;
    quad = (p.quad || [{ x: 0, y: 0 }, { x: p.w, y: 0 }, { x: p.w, y: p.h }, { x: 0, y: p.h }]).map((q) => ({ ...q }));
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(p.orig);
    img.src = url;
    show('corners');
    await img.decode().catch(() => {});
    layout();
  }
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const s = Math.min(W / page.w, H / page.h);
    box = { s, x: (W - page.w * s) / 2, y: (H - page.h * s) / 2 };
    Object.assign(img.style, { left: box.x + 'px', top: box.y + 'px', width: page.w * s + 'px', height: page.h * s + 'px' });
    drawSvg();
  }
  const toScreen = (p) => ({ x: box.x + p.x * box.s, y: box.y + p.y * box.s });
  function drawSvg() {
    const pts = quad.map(toScreen);
    const poly = pts.map((p) => `${p.x},${p.y}`).join(' ');
    svg.innerHTML = `<polygon points="${poly}" fill="rgba(31,111,235,.18)" stroke="#4c8dff" stroke-width="2.5"/>` +
      pts.map((p) => `<circle class="handle" cx="${p.x}" cy="${p.y}" r="16"/>`).join('');
  }
  function pointer(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  stage.addEventListener('pointerdown', (e) => {
    if (!box) return;
    const p = pointer(e);
    let best = -1, bd = 60;
    quad.map(toScreen).forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    drag = best; stage.setPointerCapture(e.pointerId);
    move(e);
  });
  stage.addEventListener('pointermove', (e) => { if (drag >= 0) move(e); });
  const end = () => { drag = -1; loupe.style.display = 'none'; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  function move(e) {
    const p = pointer(e);
    quad[drag] = {
      x: Math.max(0, Math.min(page.w, (p.x - box.x) / box.s)),
      y: Math.max(0, Math.min(page.h, (p.y - box.y) / box.s)),
    };
    drawSvg();
    // lupa: se pone en la esquina contraria al dedo
    const sp = toScreen(quad[drag]);
    const left = sp.x < stage.clientWidth / 2 ? stage.clientWidth - 130 : 10;
    Object.assign(loupe.style, { display: 'block', left: left + 'px', top: '10px' });
    const srcSize = 40 / box.s; // la lupa muestra 40 px de pantalla ampliados 3 veces
    lg.fillStyle = '#000'; lg.fillRect(0, 0, 240, 240);
    lg.drawImage(img, quad[drag].x - srcSize / 2, quad[drag].y - srcSize / 2, srcSize, srcSize, 0, 0, 240, 240);
    lg.strokeStyle = '#4c8dff'; lg.lineWidth = 2;
    lg.beginPath(); lg.moveTo(120, 95); lg.lineTo(120, 145); lg.moveTo(95, 120); lg.lineTo(145, 120); lg.stroke();
  }
  window.addEventListener('resize', () => { if (current === 'corners' && page) layout(); });

  $('cAuto').onclick = async () => {
    showLoading('Buscando las esquinas…');
    try {
      const { data, scale } = imageToPixels(img, 900);
      const q = await Engine.detect(data, 900);
      if (q) { quad = q.map((p) => ({ x: p.x / scale, y: p.y / scale })); drawSvg(); }
      else toast('No he encontrado la hoja. Ajusta las esquinas a mano.');
    } catch (e) { toast('Error: ' + e.message); }
    hideLoading();
  };
  $('cFull').onclick = () => { quad = [{ x: 0, y: 0 }, { x: page.w, y: 0 }, { x: page.w, y: page.h }, { x: 0, y: page.h }]; drawSvg(); };
  $('cCancel').onclick = () => show('editor');
  $('cApply').onclick = () => {
    const ordered = ScanEngine.orderPoints(quad);
    page.quad = ordered; page.auto = true;
    show('editor');
    rerender();
  };
  return { open };
})();

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */
function buildPdf(pages, title) {
  // pages: [{ bytes: Uint8Array (JPEG), w, h }]
  const enc = new TextEncoder();
  const chunks = []; let len = 0; const offsets = [];
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  const pageObj = (i) => 3 + i * 3, contObj = (i) => 4 + i * 3, imgObj = (i) => 5 + i * 3;
  const infoObj = 3 + n * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  pages.forEach((p, i) => {
    const k = 842 / Math.max(p.w, p.h); // lado largo = alto de un A4, sin forzar proporción
    const pw = +(p.w * k).toFixed(2), ph = +(p.h * k).toFixed(2);
    obj(pageObj(i), () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imgObj(i)} 0 R >> >> /Contents ${contObj(i)} 0 R >>`));
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(contObj(i), () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(imgObj(i), () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
      push(p.bytes); push('\nendstream');
    });
  });
  // título en UTF-16 para que salgan bien las tildes
  let hex = 'FEFF';
  for (const ch of title) { const c = ch.charCodeAt(0); hex += c.toString(16).padStart(4, '0').toUpperCase(); }
  obj(infoObj, () => push(`<< /Title <${hex}> /Producer (Escaner) >>`));
  const xref = len;
  let x = `xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= infoObj; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

let pdfCache = {}, pdfDocId = null;
function invalidatePdf() { pdfCache = {}; }
async function makePdf(quality) {
  const doc = await DB.getDoc(currentDocId);
  const key = quality;
  if (pdfDocId === doc.id && pdfCache[key] && pdfCache[key].updated === doc.updated) return pdfCache[key];
  if (pdfDocId !== doc.id) { pdfCache = {}; pdfDocId = doc.id; }
  const { max, q } = QUALITY[quality];
  const out = [];
  for (const pid of doc.pages) {
    const pending = procQueue.get(pid); if (pending) await pending.catch(() => {});
    let page = await DB.getPage(pid);
    if (!page.proc) { await queueRender(page); page = await DB.getPage(pid); }
    const im = await blobToImage(page.proc);
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(im, 0, 0, c.width, c.height);
    const b = await canvasToBlob(c, q);
    out.push({ bytes: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height });
    c.width = c.height = 0;
  }
  const blob = buildPdf(out, doc.name);
  const safe = doc.name.replace(/[\\/:*?"<>|]+/g, '-');
  const file = new File([blob], safe + '.pdf', { type: 'application/pdf' });
  pdfCache[key] = { file, updated: doc.updated, pages: out.length };
  return pdfCache[key];
}

let exportQuality = getPref('quality', 'alta');
let exportReady = null, exportJob = 0;
async function prepareExport() {
  const job = ++exportJob;
  document.querySelectorAll('#qualitySeg button').forEach((b) => b.classList.toggle('on', b.dataset.q === exportQuality));
  $('exportShare').disabled = true; exportReady = null;
  $('pdfInfo').innerHTML = 'Preparando el PDF…';
  try {
    const r = await makePdf(exportQuality);
    if (job !== exportJob) return;
    exportReady = r;
    $('pdfInfo').innerHTML = `${r.pages} ${r.pages === 1 ? 'página' : 'páginas'} · <b>${fmtSize(r.file.size)}</b>`;
    $('exportShare').disabled = false;
  } catch (e) {
    if (job === exportJob) $('pdfInfo').textContent = 'Error al crear el PDF: ' + e.message;
  }
}
$('exportBtn').onclick = async () => {
  // asegura que el nombre escrito se guarda antes
  $('docName').blur();
  const doc = await DB.getDoc(currentDocId);
  const v = $('docName').value.trim();
  if (v && v !== doc.name) { doc.name = v; doc.updated = Date.now(); await DB.putDoc(doc); }
  $('exportSheet').classList.add('show');
  prepareExport();
};
$('qualitySeg').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  exportQuality = b.dataset.q; setPref('quality', exportQuality); prepareExport();
};
$('exportCancel').onclick = () => $('exportSheet').classList.remove('show');
$('exportSheet').addEventListener('click', (e) => { if (e.target.id === 'exportSheet') $('exportSheet').classList.remove('show'); });
$('exportShare').onclick = async () => {
  if (!exportReady) return;
  const file = exportReady.file;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); }
    catch (e) { if (e.name !== 'AbortError') toast('No se pudo compartir: ' + e.message); }
    return;
  }
  // Plan B: descarga directa
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */
(function boot() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && !standalone) $('installHint').style.display = 'block';
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  renderHome().catch((e) => { $('docList').innerHTML = `<div class="empty">No se puede abrir el almacenamiento del móvil (${e.message}).</div>`; });
  Engine.ready().catch(() => {}); // empieza a descargar el motor en segundo plano
})();
