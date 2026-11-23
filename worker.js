/* Trabajador en segundo plano: aquí corre OpenCV para que la cámara no se congele. */
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';
let cv = null;
let ready = null;

function init() {
  if (ready) return ready;
  ready = (async () => {
    importScripts(OPENCV_URL, 'engine.js');
    let c = self.cv;
    if (c && typeof c.then === 'function') c = await c;
    else if (c && !c.Mat) await new Promise(r => (c.onRuntimeInitialized = r));
    cv = c;
  })();
  return ready;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await init();
    if (m.type === 'init') { self.postMessage({ id: m.id, ok: true }); return; }

    if (m.type === 'detect') {
      const src = new cv.Mat(m.h, m.w, cv.CV_8UC4);
      src.data.set(new Uint8Array(m.buffer));
      const quad = ScanEngine.detectQuad(cv, src, { maxDim: m.maxDim || 480 });
      src.delete();
      self.postMessage({ id: m.id, ok: true, quad });
      return;
    }

    if (m.type === 'process') {
      const src = new cv.Mat(m.h, m.w, cv.CV_8UC4);
      src.data.set(new Uint8Array(m.buffer));
      let quad = m.quad;
      let detected = true;
      if (!quad) {
        quad = ScanEngine.detectQuad(cv, src, { maxDim: 640 }) || m.fallback || null;
        if (!quad) {
          detected = false;
          quad = [{ x: 0, y: 0 }, { x: m.w, y: 0 }, { x: m.w, y: m.h }, { x: 0, y: m.h }];
        }
      }
      const flat = ScanEngine.warp(cv, src, quad, m.maxOut || 3000);
      src.delete();
      const rot = ScanEngine.rotate(cv, flat, m.rot || 0);
      flat.delete();
      const out = ScanEngine.applyFilter(cv, rot, m.filter || 'sombras');
      rot.delete();
      const w = out.cols, h = out.rows;
      const buffer = new Uint8Array(out.data).buffer; // copia fuera de la memoria de OpenCV
      out.delete();
      self.postMessage({ id: m.id, ok: true, quad, detected, w, h, buffer }, [buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
