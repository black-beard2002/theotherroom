(() => {
  'use strict';

  // ---------- Scene constants (all distances in reference px: the 1536 × 1024 design) ----------
  const REF_W = 1536, REF_H = 1024;
  const P = 2200;            // CSS perspective distance
  const FACE_W = 600, FACE_H = 450;   // card faces are 600 × 450 (the 4:3 project images), scaled into place
  const FLOOR = 390;         // floor plane for the soft contact shadows (below the scene centre)
  const DEG = Math.PI / 180;
  const KNOT_OFFSET = { x: -18, y: 10 };                     // knot centre relative to the scene centre
  const FOCUS_Z = 420, FOCUS_Y = -24;                        // where a focused card hangs, square to the viewer
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Floating layout. Every load scatters the projects on a ring around the logo: an even spacing with jitter, a random
  // radial position between the logo and the screen edge, a random depth and size. The ring turns with scroll, drag and
  // the arrow keys; radius and size are re-solved each frame from the viewport, so no card meets the logo or leaves the
  // screen at any angle or screen size.
  const LOGO_A = 200, LOGO_B = 195;   // logo keep-out half-axes around the knot centre (reference px)
  const CARD_W = 250;                 // largest card width (reference px)
  const RING_TILT = 140;              // depth swing: cards come forward at the bottom of the ring and recede at the top
  const EDGE = { side: 20, top: 72, bottom: 120 };   // CSS px kept clear for the header and the contact block
  const IDLE_SPIN = 0.0005;           // rad per 60fps frame: the ring drifts, so no project stays out of focus

  // ---------- Math helpers ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const approach = (rate, dt) => 1 - Math.pow(1 - rate, dt);   // frame-rate independent easing
  const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
  const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
  const rand = (a, b) => a + Math.random() * (b - a);
  const facing = (x) => -40 * Math.tanh(x / 260);   // cards turn toward the centre as they orbit

  // ---------- DOM ----------
  const stage = document.getElementById('stage');
  const scene = document.getElementById('scene');
  const caption = document.getElementById('caption');

  const cardEls = [...scene.querySelectorAll('.card')];
  const slots = cardEls.map((_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  const spin0 = rand(0, 2 * Math.PI);
  const cards = cardEls.map((el, i) => {
    const slot = slots[i];
    const ring = {
      angle: spin0 + ((slot + rand(-0.2, 0.2)) / cardEls.length) * 2 * Math.PI,
      u: slot % 2 ? rand(0.5, 1) : rand(0, 0.5),   // ring neighbours alternate inner/outer so they don't stack
      zLayer: rand(-200, 40), w: CARD_W * rand(0.82, 1),
      rx: rand(-3, 3), ry: rand(-6, 6), rz: rand(-3, 3),
    };
    const shadow = document.createElement('span');
    shadow.className = 'shadow';
    scene.insertBefore(shadow, scene.querySelector('.card'));
    const c = {
      el, shadow, ring,
      phase: i * 1.7,
      stiff: 0.05 + (i % 5) * 0.012,
      isHover: false, hover: 0, focus: 0,
      lean: { x: 0, y: 0, z: 0 }, push: { x: 0, y: 0, z: 0 },
      lastBlur: -1, lastOpacity: -1,
    };
    el.addEventListener('pointerenter', () => { c.isHover = true; });
    el.addEventListener('pointerleave', () => { c.isHover = false; });
    el.addEventListener('click', (e) => { e.stopPropagation(); setFocus(focused === c ? null : c); });
    return c;
  });

  // ---------- State ----------
  const pointer = { x: innerWidth / 2, y: innerHeight / 2, nx: 0, ny: 0, inside: false, moved: false };
  const smooth = { x: 0, y: 0, vx: 0, vy: 0 };
  const drag = { active: false, moved: false, x0: 0, y0: 0, lastX: 0, lastT: 0 };
  let theta = 0, thetaTarget = 0, thetaV = 0, idle = 0;   // scroll moves the target; the ring glides to it
  let focused = null, focusAmt = 0;
  let s = 1;            // reference px → CSS px
  let knot = null;

  function setFocus(c) {
    focused = c;
    stage.classList.toggle('is-focus', !!c);
    caption.classList.toggle('is-on', !!c);
    for (const o of cards) o.el.setAttribute('aria-pressed', String(o === c));
  }

  // on-screen width of a focused card: nearly full width on phones, a comfortable size elsewhere
  const focusWidth = () => innerWidth < 760
    ? Math.min(innerWidth * 0.95, innerHeight * 0.7 * FACE_W / FACE_H)
    : Math.min(innerWidth * 0.62, innerHeight * 0.56 * FACE_W / FACE_H, 900);

  function resize() {
    const vw = innerWidth, vh = innerHeight;
    s = vw < 760 ? Math.min(vw / 760, vh / 1150) : Math.min(vw / REF_W, vh / REF_H);
    stage.style.perspective = `${P * s}px`;
    // the close hint sits just under the focused card
    const bottom = vh / 2 + FOCUS_Y * s * (P / (P - FOCUS_Z)) + (focusWidth() * FACE_H) / FACE_W / 2;
    caption.style.top = `${Math.round(bottom + 14)}px`;
    if (knot) knot.resize(vw, vh, s);
  }

  // ---------- Per-frame ----------
  // where a card sits at ring parameter t: the widest size (up to its own) that fits between the logo and the screen
  // edge on that side, at its radial position between those two bounds. t runs round an ellipse shaped like the free
  // space, so evenly spaced cards stay evenly spread on wide and tall screens alike.
  function place(c, t) {
    const hx = (innerWidth / 2 - EDGE.side) / s, hyMid = (innerHeight / 2 - (EDGE.top + EDGE.bottom) / 2) / s;
    const ex = (hx + LOGO_A) * Math.cos(t), ey = (hyMid + LOGO_B) * Math.sin(t), el = Math.hypot(ex, ey);
    const cs = ex / el, sn = ey / el;
    const z = c.ring.zLayer + RING_TILT * sn, pk = P / (P - z);
    const hy = (innerHeight / 2 - (sn < 0 ? EDGE.top : EDGE.bottom)) / s;
    // cap the size so the cards fit round the middle of the free space (Ramanujan's ellipse perimeter)
    const a = (hx + LOGO_A) / 2, b = (hyMid + LOGO_B) / 2;
    const wCap = (1.05 * Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))) / cards.length;
    const bounds = (w) => {
      const hw = 0.54 * w * pk, hh = 0.405 * w * pk;   // half the card's on-screen box, +8% for its tilt and bob
      // inner bound: the card's box, at radius r, has its nearest point exactly on the keep-out ellipse
      const clear = (r) => { const x = r * cs, y = r * sn; return Math.hypot(clamp(0, x - hw, x + hw) / LOGO_A, clamp(0, y - hh, y + hh) / LOGO_B) >= 1; };
      let lo = 0, hi = LOGO_A + LOGO_B + 2 * (hw + hh);
      for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (clear(m)) hi = m; else lo = m; }
      return [hi, Math.min((hx - hw) / Math.abs(cs), (hy - hh) / Math.abs(sn))];
    };
    let w = Math.min(c.ring.w, wCap), [rin, rout] = bounds(w);
    if (rin > rout) {   // not enough room on this side (narrow phones): shrink the card until it fits
      let lo = 0.35 * w, hi = w;
      for (let i = 0; i < 10; i++) { const m = (lo + hi) / 2, [a, b] = bounds(m); if (a <= b) lo = m; else hi = m; }
      w = lo; [rin, rout] = bounds(w);
      rin = Math.min(rin, rout);   // a tiny viewport: stay on screen rather than clear of the logo
    }
    const r = lerp(rin, rout, c.ring.u);
    return { x: (KNOT_OFFSET.x + r * cs) / pk, y: (KNOT_OFFSET.y + r * sn) / pk, z, w, sn };
  }

  function updateCard(c, t, dt, ax, ay) {
    const p = place(c, c.ring.angle + theta + idle);
    const bob = reduceMotion ? 0 : Math.sin(t * 0.7 + c.phase) * 7;

    // drift toward the pointer (nearer cards more), then tilt with the pointer
    let v = [p.x, p.y + bob, p.z];
    const depth = 1 + v[2] / 900;
    v[0] += smooth.x * 16 * depth;
    v[1] += smooth.y * 11 * depth;
    v = rotX(rotY(v, ay), ax);

    // lean into the pointer's direction of travel; each card lags at its own stiffness
    const lk = approach(c.stiff, dt);
    c.lean.y += (clamp(smooth.vx * 320, -16, 16) - c.lean.y) * lk;
    c.lean.x += (clamp(-smooth.vy * 260, -12, 12) - c.lean.x) * lk;
    c.lean.z += (clamp(-smooth.vx * 140, -8, 8) - c.lean.z) * lk;

    // make room around the cursor
    let tx = 0, ty = 0, tz = 0;
    if (pointer.inside && !focused && !drag.moved) {
      const persp = P / (P - v[2]);
      const dx = v[0] * persp * s - (pointer.x - innerWidth / 2);
      const dy = v[1] * persp * s - (pointer.y - innerHeight / 2);
      const d = Math.hypot(dx, dy), r0 = 240 * s;
      if (d < r0 && d > 0.001) {
        const f = (1 - d / r0) ** 2;
        tx = (dx / d) * f * 34; ty = (dy / d) * f * 34; tz = f * 30;
      }
    }
    const pk = approach(0.08, dt);
    c.push.x += (tx - c.push.x) * pk;
    c.push.y += (ty - c.push.y) * pk;
    c.push.z += (tz - c.push.z) * pk;
    c.hover += ((c.isHover && !focused ? 1 : 0) - c.hover) * approach(0.12, dt);
    c.focus += ((focused === c ? 1 : 0) - c.focus) * approach(0.085, dt);

    let x = v[0] + c.push.x, y = v[1] + c.push.y, z = v[2] + c.push.z + c.hover * 60;
    let rx = c.ring.rx + 17 + 14 * Math.abs(p.sn) + smooth.y * 7 + c.lean.x;
    let ry = c.ring.ry + facing(x) + smooth.x * 10 + c.lean.y;
    let rz = c.ring.rz + c.lean.z;
    let scale = (p.w / FACE_W) * (1 + c.hover * 0.05);
    // depth of field from where the card is right now: sharp across the front of the ring (the lower half of the
    // screen), softening toward the back; the ring keeps turning, so every project passes through focus
    const dof = 1 - smoothstep(clamp(((1 + p.sn) / 2 - 0.12) / 0.45, 0, 1));
    let blur = 4.5 * dof * (1 - c.hover);
    let opacity = 1 - 0.28 * dof;

    if (focused && focused !== c) { blur += 5 * focusAmt; opacity *= 1 - 0.72 * focusAmt; }
    if (c.focus > 0.001) {          // fly to the front, square to the viewer
      const f = smoothstep(clamp(c.focus, 0, 1));
      const fp = P / (P - FOCUS_Z);
      const fs = focusWidth() / (FACE_W * fp * s);
      x = lerp(x, 0, f); y = lerp(y, FOCUS_Y, f); z = lerp(z, FOCUS_Z, f);
      rx = lerp(rx, smooth.y * 4, f); ry = lerp(ry, smooth.x * 6, f); rz = lerp(rz, 0, f);
      scale = lerp(scale, fs, f); blur = lerp(blur, 0, f); opacity = lerp(opacity, 1, f);
    }

    const k = scale * s;
    c.el.style.transform =
      `translate3d(${(x * s).toFixed(2)}px,${(y * s).toFixed(2)}px,${(z * s).toFixed(2)}px) ` +
      `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) ` +
      `scale3d(${k.toFixed(4)},${k.toFixed(4)},${k.toFixed(4)})`;

    // filter radius is in the card's local space, so undo the scale + perspective that will shrink it
    const screenBlur = blur * s;
    const localBlur = screenBlur < 0.4 ? 0 : Math.round((screenBlur / (k * (P / (P - z)))) * 4) / 4;
    if (localBlur !== c.lastBlur) { c.el.style.filter = localBlur ? `blur(${localBlur}px)` : 'none'; c.lastBlur = localBlur; }
    if (Math.abs(opacity - c.lastOpacity) > 0.004) { c.el.style.opacity = opacity.toFixed(3); c.lastOpacity = opacity; }

    // soft contact shadow on the floor, stronger the closer the card hangs to it
    const bottom = y + (FACE_H * scale) / 2;
    const near = clamp(1 - (FLOOR - bottom) / 380, 0, 1);
    const shadowOp = near * near * 0.65 * (1 - c.focus) * (1 - 0.6 * focusAmt);
    const sw = (FACE_W * scale * 1.05 * s) / 200, sd = (FACE_W * scale * 0.8 * s) / 200;
    c.shadow.style.transform = `translate3d(${(x * s).toFixed(2)}px,${(FLOOR * s).toFixed(2)}px,${(z * s).toFixed(2)}px) rotateX(90deg) scale(${sw.toFixed(3)},${sd.toFixed(3)})`;
    c.shadow.style.opacity = shadowOp.toFixed(3);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last) / 16.667;   // in 60fps frames
    last = now;
    const t = now / 1000;

    const px = smooth.x, py = smooth.y;
    const mk = approach(0.075, dt);
    smooth.x += (pointer.nx - smooth.x) * mk;
    smooth.y += (pointer.ny - smooth.y) * mk;
    smooth.vx = (smooth.x - px) / dt;
    smooth.vy = (smooth.y - py) / dt;

    if (!drag.active) theta += (thetaTarget - theta) * approach(0.045, dt);   // eases in, no overshoot
    if (!reduceMotion && !focused && !drag.active) idle += IDLE_SPIN * dt;
    focusAmt += ((focused ? 1 : 0) - focusAmt) * approach(0.09, dt);

    const ax = -smooth.y * 5 * DEG, ay = smooth.x * 8 * DEG;
    for (const c of cards) updateCard(c, t, dt, ax, ay);

    if (knot) {
      if (pointer.moved) {
        pointer.moved = false;
        const overCard = cards.some((c) => c.isHover);
        stage.classList.toggle('is-knot-hover', !focused && !overCard && !drag.moved && knot.hit(pointer.x, pointer.y));
      }
      knot.update(t, dt, smooth.x, smooth.y, theta);
    }
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  function setPointer(e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.nx = (e.clientX / innerWidth) * 2 - 1;
    pointer.ny = (e.clientY / innerHeight) * 2 - 1;
    pointer.inside = true; pointer.moved = true;
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    setPointer(e);
    Object.assign(drag, { active: true, moved: false, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, lastT: performance.now() });
  });

  addEventListener('pointermove', (e) => {
    setPointer(e);
    if (!drag.active) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) {
      drag.moved = true;
      stage.classList.add('is-dragging');
      if (focused) setFocus(null);
    }
    if (drag.moved) {
      const now = performance.now();
      const d = ((e.clientX - drag.lastX - (e.clientY - drag.lastY)) * 0.005) / Math.max(s, 0.4);   // swipe up = scroll down
      theta += d; thetaTarget = theta;
      thetaV = d / Math.max(1, (now - drag.lastT) / 16.667);
      drag.lastT = now;
    }
    drag.lastX = e.clientX; drag.lastY = e.clientY;
  });

  addEventListener('pointerup', (e) => {
    if (drag.active) {
      drag.active = false; stage.classList.remove('is-dragging');
      if (drag.moved) thetaTarget = theta + clamp(thetaV, -0.05, 0.05) * 12;   // a gentle coast after a fling
    }
    if (e.pointerType !== 'mouse') { pointer.nx = pointer.ny = 0; pointer.inside = false; }
  });
  addEventListener('pointercancel', () => { drag.active = false; stage.classList.remove('is-dragging'); });
  document.documentElement.addEventListener('pointerleave', () => { pointer.nx = pointer.ny = 0; pointer.inside = false; });

  // a drag that ends over a card must not also open it
  addEventListener('click', (e) => { if (drag.moved) { e.stopPropagation(); e.preventDefault(); } }, true);

  stage.addEventListener('click', (e) => {
    if (focused) { setFocus(null); return; }
    if (knot && knot.hit(e.clientX, e.clientY)) knot.poke();
  });

  addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
    thetaTarget += clamp(d, -120, 120) * 0.0005;   // one wheel notch ≈ 3.4°
    if (focused) setFocus(null);
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focused) setFocus(null);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') thetaTarget += 0.1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') thetaTarget -= 0.1;
  });

  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  // ---------- The red knot (three.js, loaded on demand) ----------
  async function initKnot() {
    const canvas = document.getElementById('knot');
    const [THREE, { GLTFLoader }, { DRACOLoader }, { RGBELoader }] = await Promise.all([
      import('three'), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'),
      import('three/addons/loaders/RGBELoader.js'),
    ]);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;

    const scene3 = new THREE.Scene();
    // the studio around the logo, recovered from the logo's product shots: each reflection seen in those photos was
    // traced back to the direction it came from (128 × 64 equirect, camera looking down -Z)
    const studio = await new RGBELoader().loadAsync('assets/r-logo-env.hdr');
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene3.environment = pmrem.fromEquirectangular(studio).texture;
    studio.dispose();
    pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(30, 1, 10, 20000);

    // The "R": a light copy of the sculpted GLB (same geometry, Draco-compressed), finished as glossy red chrome
    const LOGO_H = 355;      // on-screen height in reference px, same as the earlier procedural R
    const FRONT_YAW = 355, FRONT_TILT = -2;   // resting view (deg), matched to the logo's main product shot
    const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('assets/r-logo.glb');
    draco.dispose();
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    model.position.sub(box.getCenter(new THREE.Vector3()));
    const fit = new THREE.Group();
    fit.add(model);
    fit.scale.setScalar(LOGO_H / box.getSize(new THREE.Vector3()).y);
    fit.rotation.y = FRONT_YAW * DEG;
    let mesh;
    model.traverse((o) => { if (o.isMesh) mesh = o; });
    // colour, metal, gloss and coat fitted to the product shots under the studio above
    mesh.material.dispose();
    mesh.material = new THREE.MeshPhysicalMaterial({ color: 0xef0c00, metalness: 0.975, roughness: 0.02, clearcoat: 0.25, clearcoatRoughness: 0.03 });
    const body = new THREE.Group();
    body.add(fit);
    const holder = new THREE.Group();
    holder.add(body);
    scene3.add(holder);

    let sc = 1, spin = 0, spinV = 0, wobble = 0;
    const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), ray = new THREE.Ray(), inv = new THREE.Matrix4();

    return {
      resize(w, h, scale) {
        sc = scale;
        renderer.setSize(w, h, false);
        Object.assign(canvas.style, { width: `${w}px`, height: `${h}px`, left: `${-w / 2}px`, top: `${-h / 2}px` });
        camera.aspect = w / h;
        camera.fov = (2 * Math.atan(h / 2 / (P * sc))) / DEG;   // same projection as the CSS perspective
        camera.position.set(0, 0, P * sc);
        camera.updateProjectionMatrix();
        holder.scale.setScalar(sc);
      },
      update(t, dt, mx, my, th) {
        spin += spinV * dt;
        spinV *= Math.pow(0.95, dt);
        wobble *= Math.pow(0.94, dt);
        const idle = reduceMotion ? 0 : 1;
        holder.rotation.set(FRONT_TILT * DEG + my * 0.35 + Math.sin(t * 0.5) * 0.03 * idle, mx * 0.5 + th * 0.35 + spin, Math.sin(t * 0.4) * 0.025 * idle);
        holder.position.set(KNOT_OFFSET.x * sc, (-KNOT_OFFSET.y + Math.sin(t * 0.8) * 5 * idle) * sc, 0);
        const w = Math.sin(t * 16) * 0.07 * wobble;
        body.scale.set(1 + w, 1 - w, 1 + w * 0.5);
        renderer.render(scene3, camera);
      },
      hit(x, y) {
        ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        // ponytail: tests the model's bounding box, not its ~2M triangles (a full raycast costs tens of ms per pointer move),
        // so the poke cursor also shows in the box's empty corners; add a low-poly hit proxy if that matters
        return ray.copy(raycaster.ray).applyMatrix4(inv.copy(mesh.matrixWorld).invert()).intersectsBox(mesh.geometry.boundingBox);
      },
      poke() { spinV += 0.22; wobble = 1; },
    };
  }

  initKnot()
    .then((k) => { knot = k; resize(); })
    .catch((err) => console.warn('3D knot unavailable:', err));
})();
