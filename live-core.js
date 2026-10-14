/*
 * i want — live core controller (v3)
 * Decides when the wheel is drawn (on screen, tab shown, motion ON, no reduced-motion request, WebGL
 * context alive) and at which size. The drawing itself (three.js, core-scene.js) runs in
 * core-worker.js on an OffscreenCanvas, so it never occupies the main thread; where that is not
 * available or fails, the same scene is drawn here on the main thread instead.
 * The wheel keeps turning while the page scrolls (<= 30 fps); there is no scroll listener here.
 * `?core=main` in the URL forces the main-thread path (for comparing the two on a device);
 * `?core=debug` (or `main-debug`) adds data-frame / data-phase / data-running on the canvas.
 * Until the first frame is on the canvas, the still image (assets/core.png) stays in place.
 */
const host = document.querySelector('.core-object');
const opening = document.querySelector('.opening-stage');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const coreParam = new URLSearchParams(location.search).get('core') || '';
const forceMain = /main/.test(coreParam), debug = /debug/.test(coreParam);
const canWorker = !forceMain && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
  'transferControlToOffscreen' in HTMLCanvasElement.prototype;

let engine = null, canvas = null, lost = false, visible = true, running = false, sizeKey = '';

function setEngine(state) {
  host.dataset.engine = state;
  if (canvas) canvas.style.display = state === 'failed' ? 'none' : '';
}

function newCanvas() {
  canvas?.remove();
  canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  return canvas;
}

// Left edge of `el` in the padding-box coordinates of `ancestor`, from layout offsets only
// (ignores CSS transforms such as the scroll effect on .core-object). null if not reachable.
function layoutLeft(el, ancestor) {
  let x = 0;
  for (let n = el; n !== ancestor;) {
    const parent = n.offsetParent;
    if (!parent) return null;
    x += n.offsetLeft;
    if (parent !== ancestor) x += parent.clientLeft;
    n = parent;
  }
  return x;
}

// Square drawing size (CSS px, <= 800) and the horizontal part of it (u0..u1) that is not clipped by
// .opening-stage (overflow:hidden clips at its padding box). Layout sizes ignore the scroll transform.
function measure() {
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const size = Math.min(800, Math.max(1, Math.round(Math.max(w, h))));
  const side = Math.min(w, h), left0 = layoutLeft(canvas, opening), clipW = opening.clientWidth;
  let u0 = null, u1 = null;
  if (side > 0 && left0 !== null && clipW > 0) {
    const left = left0 + (w - side) / 2, clamp = v => Math.min(1, Math.max(0, v));
    u0 = clamp(-left / side); u1 = clamp((clipW - left) / side);
  }
  return {size, u0, u1};
}

/* ---- engine A: worker + OffscreenCanvas ------------------------------------------------------ */
// Only a worker that never even finishes loading its modules is given up on (LOAD_LIMIT). Once it
// reports `loaded`, it is waited for however long the first frame takes: a slow device would be even
// slower building the scene on the main thread, which this path exists to keep free. A worker that
// reports an error (or fails to load) hands over to the main-thread path; one that stays silent past
// LOAD_LIMIT is dropped and the still image (assets/core.png) stays, with no main-thread engine.
const LOAD_LIMIT = 20000;
function workerEngine() {
  return new Promise((resolve, reject) => {
    const c = newCanvas(), m = measure(), dpr = devicePixelRatio || 1;
    c.width = c.height = Math.floor(m.size * Math.min(dpr, 1.25));   // same buffer the renderer will set
    const offscreen = c.transferControlToOffscreen();
    const worker = new Worker(new URL('./core-worker.js', import.meta.url), {type: 'module'});
    let ready = false, settled = false;
    const timer = setTimeout(() => {
      worker.terminate(); settled = true;
      const error = new Error('worker did not load within ' + LOAD_LIMIT / 1000 + ' s'); error.keepStill = true;
      reject(error);
    }, LOAD_LIMIT);
    function stop(error) {
      clearTimeout(timer); worker.terminate();
      if (settled) return;
      if (!ready) { settled = true; reject(error); } else fallBack(error);
    }
    const api = {
      kind: 'worker',
      run(on) { worker.postMessage({type: 'run', on}); },
      size(next) { worker.postMessage({type: 'size', ...next}); },
      dispose() { clearTimeout(timer); worker.terminate(); },
    };
    worker.onmessage = ({data}) => {
      if (settled && !ready) return;
      if (data.type === 'loaded') clearTimeout(timer);
      else if (data.type === 'ready') { ready = true; settled = true; clearTimeout(timer); resolve(api); }
      else if (data.type === 'failed') stop(new Error(data.message));
      else if (data.type === 'lost') { lost = true; setEngine('failed'); sync(); }
      else if (data.type === 'restored') { lost = false; setEngine('ready'); sync(true); }
      else if (data.type === 'frames') { c.dataset.frame = String(data.frames); c.dataset.phase = data.phase.toFixed(3); }
    };
    worker.onerror = event => { event.preventDefault?.(); stop(new Error(event.message || 'worker error')); };
    worker.postMessage({type: 'init', canvas: offscreen, dpr, debug, ...m}, [offscreen]);
  });
}

/* ---- engine B: the same scene on the main thread (fallback) ----------------------------------- */
async function mainEngine() {
  const [THREE, {createCore}] = await Promise.all([import('./vendor/three.module.js'), import('./core-scene.js')]);
  const c = newCanvas();
  const renderer = new THREE.WebGLRenderer({canvas: c, alpha: true, antialias: true, powerPreference: 'low-power'});
  let core;
  try { core = createCore(renderer, {dpr: devicePixelRatio || 1}); }
  catch (error) { try { renderer.dispose(); renderer.forceContextLoss?.(); } catch (_) { /* ignore */ } throw error; }
  const FRAME = 1000 / 30;
  let on = false, raf = 0, last = 0, time = 0, frames = 0, current = measure();
  const draw = () => {
    if (lost) return;
    core.draw(time); frames++;
    if (debug && frames % 10 === 0) { c.dataset.frame = String(frames); c.dataset.phase = time.toFixed(3); }
  };
  function tick(now) {
    raf = 0; if (!on) return;
    if (!last) last = now;
    const dt = now - last;
    if (dt >= FRAME) {               // <= 30 fps; carry the remainder so 60 Hz really gives ~30 fps
      const rem = dt % FRAME;
      time += Math.min((dt - rem) / 1000, 0.1); last = now - rem; draw();
    }
    raf = requestAnimationFrame(tick);
  }
  c.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true; setEngine('failed'); sync(); });
  c.addEventListener('webglcontextrestored', () => {
    try { core.restore(); lost = false; setEngine('ready'); core.resize(current.size, current.u0, current.u1); draw(); sync(true); }
    catch (error) { lost = true; setEngine('failed'); sync(); console.warn('Live core could not recover the WebGL context.', error); }
  });
  core.resize(current.size, current.u0, current.u1); draw();
  return {
    kind: 'main',
    run(next) { on = next; cancelAnimationFrame(raf); raf = 0; last = 0; if (on) raf = requestAnimationFrame(tick); },
    size(next) { current = next; if (core.resize(next.size, next.u0, next.u1)) draw(); },
    dispose() { on = false; cancelAnimationFrame(raf); try { renderer.dispose(); renderer.forceContextLoss?.(); } catch (_) { /* ignore */ } },
  };
}

/* ---- control ---------------------------------------------------------------------------------- */
function sync(force = false) {
  const next = !!engine && !lost && visible && !document.hidden && !reduced.matches && !document.body.classList.contains('motion-off');
  if (next === running && !force) return;
  running = next;
  if (engine) { if (debug) canvas.dataset.running = String(running); engine.run(running); }
}
function resize() {
  if (!engine) return;
  const m = measure(), key = m.size + ',' + m.u0?.toFixed(4) + ',' + m.u1?.toFixed(4);
  if (key === sizeKey) return;
  sizeKey = key; engine.size(m);
}

async function fallBack(error) {       // the worker broke after it had started: continue on the main thread
  console.warn('Live core worker stopped; drawing on the main thread.', error);
  engine?.dispose(); engine = null; running = false; lost = false; sizeKey = '';
  try { engine = await mainEngine(); setEngine('ready'); host.dataset.worker = engine.kind; resize(); sync(true); }
  catch (e) { canvas?.remove(); canvas = null; setEngine('failed'); console.warn('Live core unavailable; keeping the original artwork.', e); }
}

async function start() {
  for (const make of canWorker ? [workerEngine, mainEngine] : [mainEngine]) {
    try { engine = await make(); break; }
    catch (error) {
      console.warn(`Live core: ${make === workerEngine ? 'worker' : 'main-thread'} path unavailable.`, error);
      if (error.keepStill) break;       // see LOAD_LIMIT: keep the still image, leave the main thread alone
    }
  }
  if (!engine) { canvas?.remove(); canvas = null; setEngine('failed'); return; }
  host.dataset.worker = engine.kind;
  resize(); setEngine('ready');
  new ResizeObserver(resize).observe(host);
  // Exclude the sticky header and anchor offset from the visible rendering area.
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, {rootMargin: '-110px 0px 0px 0px', threshold: 0}).observe(opening);
  new MutationObserver(() => sync()).observe(document.body, {attributes: true, attributeFilter: ['class']});
  document.addEventListener('visibilitychange', () => sync()); reduced.addEventListener('change', () => sync());
  if (debug) canvas.dataset.running = 'false';
  sync(true);
}

start();
