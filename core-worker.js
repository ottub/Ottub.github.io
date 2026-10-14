/*
 * i want — live core worker (v3)
 * Draws the wheel into an OffscreenCanvas handed over by live-core.js, so three.js and WebGL calls
 * never run on the page's main thread (scrolling, the hero effect and taps stay free of them).
 * Messages in:  init {canvas, dpr, size, u0, u1, debug} / run {on} / size {size, u0, u1}
 * Messages out: loaded (modules fetched and evaluated) / ready (first frame drawn) / failed {message} /
 *               lost / restored / frames {frames, phase} (only with ?core=debug)
 */
import * as THREE from './vendor/three.module.js';
import { createCore } from './core-scene.js';

let renderer = null, core = null, canvas = null;
let size = 0, u0 = null, u1 = null, debug = false;
let running = false, lost = false, failed = false, raf = 0, last = 0, time = 0, frames = 0;
const FRAME = 1000 / 30;
// requestAnimationFrame exists in dedicated workers where OffscreenCanvas does (Chrome, Firefox,
// Safari 16.4+); the timer is only a safety net.
const nextFrame = self.requestAnimationFrame ? cb => self.requestAnimationFrame(cb) : cb => setTimeout(() => cb(performance.now()), 16);
const cancelFrame = self.cancelAnimationFrame ? id => self.cancelAnimationFrame(id) : id => clearTimeout(id);

function fail(error) {
  failed = true; running = false; cancelFrame(raf); raf = 0;
  try { renderer?.dispose(); } catch (_) { /* ignore */ }
  postMessage({type: 'failed', message: String(error && error.message || error)});
}

function draw() {
  if (failed || lost) return;
  core.draw(time); frames++;
  if (debug && frames % 10 === 0) postMessage({type: 'frames', frames, phase: time});   // diagnostics only
}

function tick(now) {
  raf = 0; if (!running || failed) return;
  if (!last) last = now;
  const dt = now - last;
  if (dt >= FRAME) {                 // <= 30 fps; carry the remainder so 60 Hz really gives ~30 fps
    const rem = dt % FRAME;
    time += Math.min((dt - rem) / 1000, 0.1); last = now - rem;
    try { draw(); } catch (error) { fail(error); return; }
  }
  raf = nextFrame(tick);
}

function run(on) {
  const next = on && !failed && !lost;
  if (next === running) return;
  running = next; cancelFrame(raf); raf = 0; last = 0;
  if (running) raf = nextFrame(tick);
}

function resize(force = false) {
  if (failed) return;
  const changed = core.resize(size, u0, u1);
  if ((changed || force) && !lost) draw();
}

self.onmessage = ({data}) => {
  try {
    if (data.type === 'init') {
      canvas = data.canvas; debug = !!data.debug;
      renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, powerPreference: 'low-power'});
      core = createCore(renderer, {dpr: data.dpr});
      canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true; run(false); postMessage({type: 'lost'}); });
      canvas.addEventListener('webglcontextrestored', () => {
        if (failed) return;
        try { core.restore(); lost = false; resize(true); postMessage({type: 'restored'}); }
        catch (error) { fail(error); }
      });
      ({size, u0, u1} = data);
      resize(true);    // first frame is on the canvas before 'ready'
      postMessage({type: 'ready'});
    } else if (data.type === 'run') {
      if (core) run(data.on);
    } else if (data.type === 'size') {
      ({size, u0, u1} = data);
      if (core) resize();
    }
  } catch (error) { fail(error); }
};

// Every import above has been fetched and evaluated: from here on the worker is known to work, and
// however long the scene takes to build on a slow device, live-core.js keeps waiting for it.
postMessage({type: 'loaded'});
