/* ============================================================================
 * The Deal Room — ambient 3D background
 * A living communication / signal network: a slowly drifting constellation of
 * glowing nodes (a switchboard) wired by thin lines, with energy pulses that
 * flow along the wires like routed audio. Dark carbon haze, sparse orange/teal
 * accents, slow parallax camera. Built to sit BEHIND the UI at opacity ~.5.
 *
 * Self-contained ES module. Renders into the existing <canvas id="bg">.
 * Does NOT auto-run — call initBackground() after first paint.
 *
 * Perf budget (mid iPhone, ~60fps):
 *   - WebGL2 only. No WebGPU (degrades risk for no visible gain at .5 opacity).
 *   - All node drift happens GPU-side in the vertex shader (zero CPU/frame).
 *   - Nodes  = one instanced/attribute Points draw call, shader-drawn glow.
 *   - Lines  = one LineSegments draw call, shader pulse along each segment.
 *   - DPR capped at 1.5. Additive blending = cheap bloom, no post-FX.
 *   - Loop pauses on document.hidden + prefers-reduced-motion -> single frame.
 * ==========================================================================*/

import * as THREE from "https://esm.sh/three";

let _started = false; // guard against double init

export function initBackground() {
  if (_started) return;
  const canvas = document.getElementById("bg");
  if (!canvas) return;

  // --- WebGL2 capability gate. No context => no-op, app keeps CSS fallback. ---
  // Probe WebGL2 on a THROWAWAY canvas only. Critical: never call getContext on
  // the real #bg canvas here — the browser caches the context with whatever
  // attributes the first call used, then ignores the renderer's requested
  // attributes (alpha/depth) on its own getContext, causing a GL_INVALID_OP.
  // Let WebGLRenderer create the one-and-only context on #bg itself.
  let renderer;
  try {
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) return; // no WebGL2 -> bail silently, app keeps CSS fallback
    // free the probe context promptly
    const lose = probe.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();

    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // additive glow hides aliasing; saves fill rate
      alpha: true, // keep CSS body gradient visible through gaps
      powerPreference: "low-power", // it's ambient; don't spin up the big GPU
      depth: true,
      stencil: false,
    });
    if (!renderer.capabilities.isWebGL2) {
      // three fell back to WebGL1 -> our GLSL3-ish points still work, but bail
      // if context is unhealthy
      renderer.dispose();
      return;
    }
  } catch (e) {
    return; // any WebGL failure -> graceful no-op
  }
  _started = true;

  const reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- palette (matches app CSS) ----
  const CARBON = new THREE.Color("#0a0a0b");
  const ORANGE = new THREE.Color("#ff5a1f");
  const TEAL = new THREE.Color("#36d399");

  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(DPR);
  renderer.setClearColor(CARBON, 0); // transparent clear; fog does the fade
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  // Depth haze is done per-material via uFogNear/uFogFar (a self-computed alpha
  // fade in each shader), NOT scene.fog — additive blending + scene fog fight,
  // and FogExp2 doesn't expose the linear near/far the glow fade wants.

  const camera = new THREE.PerspectiveCamera(
    52,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0, 13);

  // ---------------------------------------------------------------------------
  // 1. NODES — the switchboard. Positions live in a roughly box-shaped cloud,
  //    biased toward the centre depth band so the network reads as a column of
  //    light receding into haze. Each node carries a phase + an accent tint.
  // ---------------------------------------------------------------------------
  const COUNT = isLikelyLowPower() ? 180 : 300;
  const positions = new Float32Array(COUNT * 3);
  const phases = new Float32Array(COUNT); // drift phase offset
  const sizes = new Float32Array(COUNT); // base point size
  const tints = new Float32Array(COUNT); // 0 = orange, 1 = teal mix amount
  const seeds = new Float32Array(COUNT); // per-node twinkle seed

  const SPREAD_X = 16;
  const SPREAD_Y = 11;
  const SPREAD_Z = 18;

  for (let i = 0; i < COUNT; i++) {
    // Gaussian-ish clustering (sum of uniforms) so the core is denser.
    const gx = (Math.random() + Math.random() - 1) * 0.5;
    const gy = (Math.random() + Math.random() - 1) * 0.5;
    const gz = (Math.random() + Math.random() - 1) * 0.5;
    positions[i * 3 + 0] = gx * SPREAD_X;
    positions[i * 3 + 1] = gy * SPREAD_Y;
    positions[i * 3 + 2] = gz * SPREAD_Z - 4; // push the mass slightly back
    phases[i] = Math.random() * Math.PI * 2;
    sizes[i] = 0.55 + Math.random() * 1.5;
    // Mostly dim/white-orange; ~30% lean teal for the secondary accent.
    tints[i] = Math.random() < 0.3 ? 0.6 + Math.random() * 0.4 : Math.random() * 0.25;
    seeds[i] = Math.random() * 100;
  }

  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  nodeGeo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  nodeGeo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  nodeGeo.setAttribute("aTint", new THREE.BufferAttribute(tints, 1));
  nodeGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const uniforms = {
    uTime: { value: 0 },
    uOrange: { value: ORANGE },
    uTeal: { value: TEAL },
    uPixelRatio: { value: DPR },
    uDriftAmp: { value: reduceMotion ? 0.0 : 1.0 },
    // View-space depth (units in front of camera) where the haze fade runs.
    // Camera sits ~z13, node mass ~z-4, so depth spans roughly 5..35.
    uFogNear: { value: 9.0 }, // full brightness up to here
    uFogFar: { value: 30.0 }, // fully dissolved into black by here
  };

  // Shared drift function (GLSL) — layered sines approximating curl flow.
  // Cheap, smooth, organic; keeps every node moving without CPU updates.
  const DRIFT_GLSL = /* glsl */ `
    vec3 drift(vec3 p, float t, float ph){
      vec3 d;
      d.x = sin(p.y*0.32 + t*0.40 + ph) + 0.5*sin(p.z*0.21 - t*0.27);
      d.y = sin(p.z*0.29 + t*0.33 + ph*1.3) + 0.5*sin(p.x*0.24 + t*0.22);
      d.z = sin(p.x*0.27 - t*0.31 + ph*0.7) + 0.5*sin(p.y*0.19 + t*0.25);
      return d;
    }
  `;

  const nodeMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false, // glow sprites shouldn't occlude each other
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      precision highp float;
      attribute float aPhase;
      attribute float aSize;
      attribute float aTint;
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uDriftAmp;
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vTint;
      varying float vTwinkle;
      varying float vFade;
      ${DRIFT_GLSL}
      void main(){
        vTint = aTint;
        vec3 pos = position + drift(position, uTime, aPhase) * 0.6 * uDriftAmp;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        // Slow brightness twinkle so nodes feel like live channels.
        vTwinkle = 0.55 + 0.45 * sin(uTime*1.1 + aSeed*6.2831);
        // Self-computed depth fade into haze (version-proof; no three fog defines).
        vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
        gl_Position = projectionMatrix * mv;
        // Attenuate size with distance for honest depth.
        gl_PointSize = aSize * uPixelRatio * (62.0 / -mv.z);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uOrange;
      uniform vec3 uTeal;
      varying float vTint;
      varying float vTwinkle;
      varying float vFade;
      void main(){
        // Soft radial falloff -> circular glow with a hot core (cheap bloom).
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.0, d);      // outer halo
        float hot  = smoothstep(0.22, 0.0, d);     // inner spark
        float a = core*core*0.5 + hot*0.9;
        vec3 col = mix(uOrange, uTeal, vTint);
        col = mix(col, vec3(1.0), hot*0.6);         // white-hot center
        gl_FragColor = vec4(col * (0.7 + vTwinkle), a * vTwinkle * vFade);
      }
    `,
  });
  const nodes = new THREE.Points(nodeGeo, nodeMat);
  nodes.frustumCulled = false; // drift can push points past the original bounds
  scene.add(nodes);

  // ---------------------------------------------------------------------------
  // 2. WIRES — connect each node to a few nearby neighbours (computed ONCE).
  //    Drawn as LineSegments. The shader runs the SAME drift on both endpoints
  //    so wires stay welded to their nodes, and sends a bright pulse sliding
  //    along each segment (routed-audio feel). One draw call.
  // ---------------------------------------------------------------------------
  const MAX_NEIGH = 1; // links per node -> sparse, calm graph (not a busy web)
  const LINK_DIST = 4.4; // only wire genuinely-near nodes
  const linkA = [];
  const linkB = [];
  const made = new Set();

  for (let i = 0; i < COUNT; i++) {
    const ix = positions[i * 3], iy = positions[i * 3 + 1], iz = positions[i * 3 + 2];
    // gather candidate neighbours within range
    let found = 0;
    for (let j = i + 1; j < COUNT && found < MAX_NEIGH; j++) {
      const dx = ix - positions[j * 3];
      const dy = iy - positions[j * 3 + 1];
      const dz = iz - positions[j * 3 + 2];
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 < LINK_DIST * LINK_DIST) {
        const key = i < j ? i * COUNT + j : j * COUNT + i;
        if (!made.has(key)) {
          made.add(key);
          linkA.push(i);
          linkB.push(j);
          found++;
        }
      }
    }
  }

  const SEG = linkA.length;
  const linePos = new Float32Array(SEG * 2 * 3);
  const linePhase = new Float32Array(SEG * 2); // carry endpoint drift phase
  const lineT = new Float32Array(SEG * 2); // 0 at A, 1 at B (for pulse param)
  const lineSeed = new Float32Array(SEG * 2); // per-wire pulse timing
  for (let s = 0; s < SEG; s++) {
    const a = linkA[s], b = linkB[s];
    const sd = Math.random() * 100;
    for (let e = 0; e < 2; e++) {
      const n = e === 0 ? a : b;
      const o = (s * 2 + e) * 3;
      linePos[o] = positions[n * 3];
      linePos[o + 1] = positions[n * 3 + 1];
      linePos[o + 2] = positions[n * 3 + 2];
      linePhase[s * 2 + e] = phases[n];
      lineT[s * 2 + e] = e; // A=0, B=1
      lineSeed[s * 2 + e] = sd;
    }
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute("aPhase", new THREE.BufferAttribute(linePhase, 1));
  lineGeo.setAttribute("aT", new THREE.BufferAttribute(lineT, 1));
  lineGeo.setAttribute("aSeed", new THREE.BufferAttribute(lineSeed, 1));

  const lineMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      precision highp float;
      attribute float aPhase;
      attribute float aT;
      attribute float aSeed;
      uniform float uTime;
      uniform float uDriftAmp;
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vT;
      varying float vSeed;
      varying float vFade;
      ${DRIFT_GLSL}
      void main(){
        vT = aT;
        vSeed = aSeed;
        vec3 pos = position + drift(position, uTime, aPhase) * 0.6 * uDriftAmp;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uOrange;
      uniform vec3 uTeal;
      uniform float uTime;
      varying float vT;
      varying float vSeed;
      varying float vFade;
      void main(){
        // Base wire: barely-there teal so the graph whispers, never shouts.
        float base = 0.05;
        // A bright pulse travels A->B; position cycles with time + per-wire seed.
        float head = fract(uTime * 0.16 + vSeed);
        float pulse = smoothstep(0.09, 0.0, abs(vT - head)); // narrow travelling band
        vec3 col = mix(uTeal, uOrange, pulse);               // pulse flashes orange
        float a = base + pulse * 0.6;
        gl_FragColor = vec4(col, a * vFade);
      }
    `,
  });
  const wires = new THREE.LineSegments(lineGeo, lineMat);
  wires.frustumCulled = false;
  scene.add(wires);

  // ---------------------------------------------------------------------------
  // 3. SOUNDWAVE — a faint horizontal frequency ribbon threading through the
  //    network: a row of line-points whose Y is an animated sum of sines, like
  //    a slow waveform/EQ trace drifting across the depth. One LineStrip.
  // ---------------------------------------------------------------------------
  const WAVE_N = 160;
  const wavePos = new Float32Array(WAVE_N * 3);
  const waveX = new Float32Array(WAVE_N);
  for (let i = 0; i < WAVE_N; i++) {
    const x = (i / (WAVE_N - 1) - 0.5) * 26;
    wavePos[i * 3] = x;
    wavePos[i * 3 + 1] = 0;
    wavePos[i * 3 + 2] = -2;
    waveX[i] = x;
  }
  const waveGeo = new THREE.BufferGeometry();
  waveGeo.setAttribute("position", new THREE.BufferAttribute(wavePos, 3));
  waveGeo.setAttribute("aX", new THREE.BufferAttribute(waveX, 1));
  const waveMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      precision highp float;
      attribute float aX;
      uniform float uTime;
      uniform float uDriftAmp;
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vEdge;
      varying float vFade;
      void main(){
        // Composite waveform: a few detuned sines => organic audio trace.
        float t = uTime;
        float y =
            sin(aX*0.45 + t*0.9)  * 0.9 +
            sin(aX*0.9  - t*1.3)  * 0.45 +
            sin(aX*1.8  + t*0.6)  * 0.22;
        y *= uDriftAmp;
        // Fade the ribbon out toward its ends so it has no hard edges.
        vEdge = 1.0 - smoothstep(9.0, 13.0, abs(aX));
        vec3 pos = vec3(aX, y - 3.4, -2.0 + sin(t*0.2)*1.5);
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uOrange;
      uniform vec3 uTeal;
      varying float vEdge;
      varying float vFade;
      void main(){
        vec3 col = mix(uTeal, uOrange, 0.35);
        gl_FragColor = vec4(col, 0.16 * vEdge * vFade);
      }
    `,
  });
  const wave = new THREE.Line(waveGeo, waveMat);
  wave.frustumCulled = false;
  scene.add(wave);

  // ---------------------------------------------------------------------------
  // Render loop + lifecycle
  // ---------------------------------------------------------------------------
  const clock = new THREE.Clock();
  let rafId = 0;
  let running = false;

  function renderFrame() {
    const t = uniforms.uTime.value;
    // Slow parallax: camera describes a gentle lissajous + always looks at core.
    if (!reduceMotion) {
      camera.position.x = Math.sin(t * 0.07) * 1.7;
      camera.position.y = Math.cos(t * 0.05) * 1.1;
      camera.position.z = 13 + Math.sin(t * 0.04) * 0.8;
    }
    camera.lookAt(0, 0, -3);
    renderer.render(scene, camera);
  }

  function loop() {
    if (!running) return;
    uniforms.uTime.value += clock.getDelta();
    renderFrame();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    if (reduceMotion) {
      // Honour reduced-motion: render ONE settled frame, then stay still.
      uniforms.uTime.value = 2.0;
      renderFrame();
      return;
    }
    running = true;
    clock.start();
    clock.getDelta(); // discard the large first delta after any pause
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Pause when the tab/PWA is backgrounded -> no battery drain, no jank on return.
  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }
  document.addEventListener("visibilitychange", onVisibility);

  // Resize (debounced via rAF to avoid thrash on iOS URL-bar show/hide).
  let resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      const w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      if (!running) renderFrame(); // keep a fresh frame when paused
    });
  }
  window.addEventListener("resize", onResize, { passive: true });

  // Lose/restore context (mobile GPU can yank it under memory pressure).
  canvas.addEventListener(
    "webglcontextlost",
    (e) => {
      e.preventDefault();
      stop();
    },
    false
  );
  canvas.addEventListener("webglcontextrestored", () => start(), false);

  start();

  // ---------------------------------------------------------------------------
  // Disposal — returned for completeness (app can call to fully tear down).
  // ---------------------------------------------------------------------------
  function dispose() {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
    nodeGeo.dispose();
    nodeMat.dispose();
    lineGeo.dispose();
    lineMat.dispose();
    waveGeo.dispose();
    waveMat.dispose();
    renderer.dispose();
    _started = false;
  }

  return { dispose };
}

// Rough heuristic: trim node count on phones / low-core devices so the
// instanced draw stays comfortably inside the 60fps budget.
function isLikelyLowPower() {
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  const mem = navigator.deviceMemory || 4;
  return mobile || cores <= 4 || mem <= 4;
}
