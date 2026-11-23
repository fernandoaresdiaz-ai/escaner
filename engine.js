/* Motor de escaneo: detección de esquinas, enderezado y filtros.
   Funciona con OpenCV.js (objeto `cv`). Se usa igual en el navegador y en las pruebas. */
(function (global) {
  'use strict';

  // Ordena 4 puntos como: arriba-izq, arriba-der, abajo-der, abajo-izq
  function orderPoints(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = pts.slice().sort((a, b) =>
      Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    // empieza por el de menor x+y (arriba-izquierda)
    let start = 0, best = Infinity;
    sorted.forEach((p, i) => { if (p.x + p.y < best) { best = p.x + p.y; start = i; } });
    const out = [];
    for (let i = 0; i < 4; i++) out.push(sorted[(start + i) % 4]);
    // atan2 en pantalla (y hacia abajo) ya da sentido horario: TL, TR, BR, BL
    return out.map(p => ({ x: p.x, y: p.y }));
  }

  function polyArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(a) / 2;
  }

  function isConvexQuad(p) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-6) return false;
      const s = Math.sign(cross);
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  // Ángulo mínimo interior: descarta formas muy raras
  function minAngleDeg(p) {
    let min = 180;
    for (let i = 0; i < 4; i++) {
      const a = p[(i + 3) % 4], b = p[i], c = p[(i + 1) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
      min = Math.min(min, Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI);
    }
    return min;
  }

  function matToPoints(m) {
    const pts = [];
    for (let i = 0; i < m.rows; i++) pts.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] });
    return pts;
  }

  // Reduce un polígono convexo a 4 vértices quitando cada vez el que menos área aporta
  function reduceToQuad(pts) {
    const p = pts.slice();
    const triArea = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    while (p.length > 4) {
      let bi = 0, ba = Infinity;
      for (let i = 0; i < p.length; i++) {
        const a = triArea(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length]);
        if (a < ba) { ba = a; bi = i; }
      }
      p.splice(bi, 1);
    }
    return p;
  }

  // Busca cuadriláteros candidatos en una imagen binaria
  function quadsFromBinary(cv, bin, imgArea, minFrac, mode, out) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(bin, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
    const list = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area >= imgArea * minFrac) list.push({ c, area }); else c.delete();
    }
    list.sort((a, b) => b.area - a.area);
    list.forEach(({ c }, idx) => {
      if (idx < 6) {
        const hull = new cv.Mat();
        cv.convexHull(c, hull, false, true);
        const hp = matToPoints(hull);
        const hullArea = cv.contourArea(hull);
        hull.delete();
        if (hp.length >= 4) {
          const q = orderPoints(reduceToQuad(hp));
          const qa = polyArea(q);
          if (isConvexQuad(q) && minAngleDeg(q) > 40 && qa > imgArea * minFrac && qa > hullArea * 0.85) out.push(q);
        }
      }
      c.delete();
    });
    contours.delete(); hier.delete();
  }

  // ¿Cuánto de cada lado del cuadrilátero coincide con un borde real de la imagen?
  function edgeSupport(mag, w, h, thr, q) {
    let minSide = 1, total = 0;
    for (let s = 0; s < 4; s++) {
      const a = q[s], b = q[(s + 1) % 4];
      const n = 48; let hit = 0, cnt = 0;
      for (let i = 2; i < n - 2; i++) {
        const t = i / n;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        let best = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xi = Math.round(x + dx), yi = Math.round(y + dy);
          if (xi >= 0 && yi >= 0 && xi < w && yi < h) best = Math.max(best, mag[yi * w + xi]);
        }
        cnt++; if (best >= thr) hit++;
      }
      const f = hit / cnt; total += f; minSide = Math.min(minSide, f);
    }
    return { mean: total / 4, min: minSide };
  }

  /* Detecta la hoja. src: cv.Mat RGBA. Devuelve 4 puntos en coordenadas de src, o null. */
  function detectQuad(cv, src, opts) {
    opts = opts || {};
    const maxDim = opts.maxDim || 480;
    const minFrac = opts.minFrac || 0.1;
    const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
    const small = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    const PAD = 4; // margen para cerrar hojas que tocan el borde de la imagen
    const rgb = new cv.Mat();
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    const W = rgb.cols, H = rgb.rows;
    const imgArea = W * H;

    // canales: gris + saturación (el papel blanco tiene poca saturación)
    const gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const hsvCh = new cv.MatVector(); cv.split(hsv, hsvCh);
    const sat = hsvCh.get(1);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
    // contraste local realzado: ayuda con hoja blanca sobre mesa clara
    const eq = new cv.Mat();
    try { const cl = new cv.CLAHE(3.0, new cv.Size(6, 6)); cl.apply(gray, eq); cl.delete(); }
    catch (e) { cv.equalizeHist(gray, eq); }

    // magnitud del gradiente para puntuar candidatos
    const gx = new cv.Mat(), gy = new cv.Mat(), mag = new cv.Mat();
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
    cv.magnitude(gx, gy, mag);
    const sx = new cv.Mat(), sy = new cv.Mat(), smag = new cv.Mat();
    cv.Sobel(sat, sx, cv.CV_32F, 1, 0, 3); cv.Sobel(sat, sy, cv.CV_32F, 0, 1, 3);
    cv.magnitude(sx, sy, smag);
    cv.max(mag, smag, mag);
    const magArr = Float32Array.from(mag.data32F);
    const sortedMag = Float32Array.from(magArr).sort();
    const thr = Math.max(12, sortedMag[Math.floor(sortedMag.length * 0.9)] * 0.45);

    const candidates = [];
    const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const k7 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    const padded = (m) => { const p = new cv.Mat(); cv.copyMakeBorder(m, p, PAD, PAD, PAD, PAD, cv.BORDER_CONSTANT, new cv.Scalar(0)); return p; };
    const run = (bin, mode) => {
      const p = padded(bin);
      const before = candidates.length;
      quadsFromBinary(cv, p, imgArea, minFrac, mode, candidates);
      for (let i = before; i < candidates.length; i++) candidates[i] = candidates[i].map((pt) => ({ x: Math.min(W - 1, Math.max(0, pt.x - PAD)), y: Math.min(H - 1, Math.max(0, pt.y - PAD)) }));
      p.delete();
    };

    // 1) bordes Canny de gris y de saturación, unidos
    const med = (() => { const a = Uint8Array.from(gray.data).sort(); return a[a.length >> 1]; })();
    for (const [src8, lo, hi] of [[gray, 0.5 * med, 1.2 * med], [gray, 20, 60], [gray, 40, 120], [gray, 8, 24], [eq, 30, 90], [eq, 60, 160]]) {
      const e1 = new cv.Mat(), e2 = new cv.Mat();
      cv.Canny(src8, e1, Math.max(5, lo), Math.max(15, Math.min(255, hi)));
      cv.Canny(sat, e2, 20, 60);
      cv.bitwise_or(e1, e2, e1);
      cv.dilate(e1, e1, k3, new cv.Point(-1, -1), 1);
      cv.morphologyEx(e1, e1, cv.MORPH_CLOSE, k7);
      run(e1, cv.RETR_LIST);
      e1.delete(); e2.delete();
    }
    // 2) zonas claras (Otsu) y zonas poco saturadas
    for (const [ch, inv] of [[gray, false], [sat, true]]) {
      const th = new cv.Mat();
      cv.threshold(ch, th, 0, 255, (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
      cv.morphologyEx(th, th, cv.MORPH_OPEN, k7);
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, k7);
      run(th, cv.RETR_EXTERNAL);
      th.delete();
    }

    [small, rgb, gray, eq, hsv, hsvCh, sat, gx, gy, mag, sx, sy, smag, k3, k7].forEach((m) => m.delete());
    if (!candidates.length) return null;

    // Puntuación: lados que coinciden con bordes reales × tamaño
    let best = null, bestScore = 0;
    for (const q of candidates) {
      const sup = edgeSupport(magArr, W, H, thr, q);
      if (sup.min < 0.3 || sup.mean < 0.5) continue;
      const areaFrac = polyArea(q) / imgArea;
      if (areaFrac > 0.97) continue; // es el marco de la foto, no la hoja
      const score = sup.mean * Math.pow(areaFrac, 0.8);
      if (score > bestScore) { bestScore = score; best = q; }
    }
    if (!best) return null;
    return best.map((p) => ({ x: p.x / scale, y: p.y / scale }));
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* Endereza la hoja. Devuelve un cv.Mat RGBA nuevo con el tamaño proporcional real. */
  function warp(cv, src, quad, maxOut) {
    const [tl, tr, br, bl] = quad;
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    maxOut = maxOut || 4000;
    const k = Math.min(1, maxOut / Math.max(w, h));
    w = Math.max(10, Math.round(w * k)); h = Math.max(10, Math.round(h * k));
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    srcPts.delete(); dstPts.delete(); M.delete();
    return out;
  }

  function rotate(cv, src, quarterTurns) {
    const q = ((quarterTurns % 4) + 4) % 4;
    const out = new cv.Mat();
    if (q === 0) { src.copyTo(out); return out; }
    const code = q === 1 ? cv.ROTATE_90_CLOCKWISE : q === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
    cv.rotate(src, out, code);
    return out;
  }

  // Estima la iluminación de fondo (el papel sin texto) de un canal
  function backgroundOf(cv, ch) {
    const maxDim = 700;
    const s = Math.min(1, maxDim / Math.max(ch.cols, ch.rows));
    const small = new cv.Mat();
    cv.resize(ch, small, new cv.Size(Math.max(8, Math.round(ch.cols * s)), Math.max(8, Math.round(ch.rows * s))), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    cv.dilate(small, small, k);            // borra el texto (oscuro) y deja el papel
    cv.medianBlur(small, small, 21);
    cv.GaussianBlur(small, small, new cv.Size(0, 0), 6);
    const bg = new cv.Mat();
    cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
    small.delete(); k.delete();
    return bg;
  }

  // Divide cada píxel por el fondo: el papel queda blanco aunque haya sombra
  function flattenChannel(cv, ch) {
    const bg = backgroundOf(cv, ch);
    const out = new cv.Mat();
    cv.divide(ch, bg, out, 255);
    bg.delete();
    return out;
  }

  // Curva de contraste: aclara el papel y oscurece la tinta
  function contrastLUT(cv, mat, black, white, gamma) {
    const lut = new cv.Mat(1, 256, cv.CV_8UC1);
    for (let i = 0; i < 256; i++) {
      let v = (i - black) / (white - black);
      v = Math.max(0, Math.min(1, v));
      lut.data[i] = Math.round(Math.pow(v, gamma) * 255);
    }
    const out = new cv.Mat();
    cv.LUT(mat, lut, out);
    lut.delete();
    return out;
  }

  /* Filtros: 'original' | 'sombras' | 'gris' | 'bn'. src RGBA; devuelve Mat RGBA nuevo. */
  function applyFilter(cv, src, filter) {
    const out = new cv.Mat();
    if (filter === 'original') { src.copyTo(out); return out; }

    if (filter === 'sombras') {
      const rgb = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      const ch = new cv.MatVector();
      cv.split(rgb, ch);
      const res = new cv.MatVector();
      for (let i = 0; i < 3; i++) {
        const c = ch.get(i);
        const f = flattenChannel(cv, c);
        const f2 = contrastLUT(cv, f, 25, 235, 1.25);
        res.push_back(f2);
        c.delete(); f.delete(); f2.delete();
      }
      const merged = new cv.Mat();
      cv.merge(res, merged);
      cv.cvtColor(merged, out, cv.COLOR_RGB2RGBA);
      merged.delete(); res.delete(); ch.delete(); rgb.delete();
      return out;
    }

    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const flat = flattenChannel(cv, gray);
    if (filter === 'gris') {
      const g = contrastLUT(cv, flat, 20, 240, 1.15);
      cv.cvtColor(g, out, cv.COLOR_GRAY2RGBA);
      g.delete();
    } else { // 'bn'
      const bin = new cv.Mat();
      const block = Math.max(15, (Math.round(Math.min(flat.cols, flat.rows) / 40) | 1));
      cv.adaptiveThreshold(flat, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
      // además, todo lo muy claro es papel
      const light = new cv.Mat();
      cv.threshold(flat, light, 200, 255, cv.THRESH_BINARY);
      cv.bitwise_or(bin, light, bin);
      cv.medianBlur(bin, bin, 3);
      cv.cvtColor(bin, out, cv.COLOR_GRAY2RGBA);
      bin.delete(); light.delete();
    }
    gray.delete(); flat.delete();
    return out;
  }

  global.ScanEngine = { detectQuad, warp, rotate, applyFilter, orderPoints, polyArea };
  if (typeof module !== 'undefined') module.exports = global.ScanEngine;
})(typeof window !== 'undefined' ? window : globalThis);
