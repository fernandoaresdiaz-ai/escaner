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

  // Busca el mejor cuadrilátero en una imagen binaria
  function bestQuadFromBinary(cv, bin, imgArea, minFrac) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < imgArea * minFrac) { c.delete(); continue; }
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const peri = cv.arcLength(hull, true);
      let quad = null;
      for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * peri, true);
        const n = approx.rows;
        if (n === 4) quad = matToPoints(approx);
        approx.delete();
        if (n <= 4) break;
      }
      if (!quad) {
        // Plan B: los 4 puntos extremos del contorno convexo
        const hp = matToPoints(hull);
        if (hp.length >= 4) {
          const pick = f => hp.reduce((b, p) => (f(p) > f(b) ? p : b), hp[0]);
          quad = [pick(p => -(p.x + p.y)), pick(p => p.x - p.y), pick(p => p.x + p.y), pick(p => p.y - p.x)];
          // Solo vale si el contorno se parece mucho a ese cuadrilátero
          if (polyArea(quad) < cv.contourArea(hull) * 0.9) quad = null;
        }
      }
      hull.delete(); c.delete();
      if (!quad) continue;
      quad = orderPoints(quad);
      if (!isConvexQuad(quad) || minAngleDeg(quad) < 35) continue;
      const qa = polyArea(quad);
      if (qa > bestArea) { bestArea = qa; best = quad; }
    }
    contours.delete(); hier.delete();
    return best ? { quad: best, area: bestArea } : null;
  }

  /* Detecta la hoja. src: cv.Mat RGBA. Devuelve 4 puntos en coordenadas de src, o null. */
  function detectQuad(cv, src, opts) {
    opts = opts || {};
    const maxDim = opts.maxDim || 480;
    const minFrac = opts.minFrac || 0.12;
    const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
    const small = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    const gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    // borde negro de 2px para que se cierren hojas que tocan el borde de la foto
    const blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const imgArea = gray.rows * gray.cols;
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const kernelBig = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));

    const candidates = [];

    // Estrategia 1: bordes Canny (umbral según la mediana del brillo)
    const sorted = Array.from(blur.data).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    for (const k of [0.66, 0.33]) {
      const lo = Math.max(10, (1 - k) * med), hi = Math.min(255, (1 + k) * med);
      const edges = new cv.Mat();
      cv.Canny(blur, edges, lo, hi);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
      cv.erode(edges, edges, kernel, new cv.Point(-1, -1), 1);
      const r = bestQuadFromBinary(cv, edges, imgArea, minFrac);
      if (r) candidates.push(r);
      edges.delete();
    }

    // Estrategia 2: papel claro sobre fondo (umbral de Otsu)
    {
      const th = new cv.Mat();
      cv.threshold(blur, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, kernelBig);
      cv.morphologyEx(th, th, cv.MORPH_OPEN, kernelBig);
      const r = bestQuadFromBinary(cv, th, imgArea, minFrac);
      if (r) candidates.push(r);
      th.delete();
    }

    // Estrategia 3: saturación baja (papel blanco) frente a fondo con color
    {
      const rgb = new cv.Mat(), hsv = new cv.Mat();
      cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const ch = new cv.MatVector();
      cv.split(hsv, ch);
      const s = ch.get(1);
      const inv = new cv.Mat();
      cv.GaussianBlur(s, s, new cv.Size(5, 5), 0);
      cv.threshold(s, inv, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      cv.morphologyEx(inv, inv, cv.MORPH_CLOSE, kernelBig);
      cv.morphologyEx(inv, inv, cv.MORPH_OPEN, kernelBig);
      const r = bestQuadFromBinary(cv, inv, imgArea, minFrac);
      if (r) candidates.push(r);
      inv.delete(); s.delete(); ch.delete(); rgb.delete(); hsv.delete();
    }

    const tol = 0.04 * Math.max(gray.cols, gray.rows);
    small.delete(); gray.delete(); blur.delete(); kernel.delete(); kernelBig.delete();
    if (!candidates.length) return null;

    // Preferimos el cuadrilátero que más estrategias coinciden en encontrar; si no, el mayor
    function close(a, b) {
      return a.quad.every((p, i) => Math.hypot(p.x - b.quad[i].x, p.y - b.quad[i].y) < tol);
    }
    let best = null, bestScore = -1;
    for (const c of candidates) {
      const votes = candidates.filter(o => close(c, o)).length;
      const score = votes * 10 + c.area / imgArea;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    // Si toca casi todo el borde de la foto, probablemente es el marco y no la hoja
    const fullFrac = best.area / imgArea;
    if (fullFrac > 0.985) return null;
    return best.quad.map(p => ({ x: p.x / scale, y: p.y / scale }));
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
