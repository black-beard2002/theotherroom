(() => {
  'use strict';

  // ---------- Scene constants (all distances in reference px: the 1536 × 1024 design) ----------
  const REF_W = 1536, REF_H = 1024;
  const P = 2200;            // CSS perspective distance
  const FACE_W = 600;        // card faces are laid out at 600 × 400 and scaled into place
  const FLOOR = 390;         // floor plane for the soft contact shadows (below the scene centre)
  const DEG = Math.PI / 180;
  const KNOT_OFFSET = { x: -18, y: 10 };                     // knot centre relative to the scene centre
  const AXIS = [0, -Math.sin(30 * DEG), Math.cos(30 * DEG)]; // orbit axis: the view axis tipped back 30°
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Home poses. Focus-plane cards were solved from the reference's measured corners
  // (max 3px error at P = 2200). Out-of-focus cards use the screen centre (sx, sy) and width (sw)
  // read off the reference, pushed to depth z — depth drives their blur.
  const POSES = {
    human:  { x: -196, y: -277, z: 0, rx: 28.7, ry: 33.6, rz: -0.2, w: 241 },
    blusk:  { x: 203,  y: -283, z: 0, rx: 27.9, ry: -27.8, rz: 2.2, w: 226 },
    spaces: { x: -416, y: -76,  z: 0, rx: 15.3, ry: 48.8, rz: -0.2, w: 263 },
    food:   { x: 419,  y: -15,  z: 0, rx: 17,   ry: -51.8, rz: 1.8, w: 252 },
    nexa:   { x: -191, y: 278,  z: 0, rx: 34.4, ry: 36.8, rz: -0.5, w: 257 },
    orbit:  { x: 175,  y: 247,  z: 0, rx: 33.1, ry: -28.9, rz: -1.3, w: 273 },
    dusk:   { sx: 410,  sy: 312, sw: 130, z: -380, rx: 25, ry: 45,  rz: 8 },
    mist:   { sx: 777,  sy: 270, sw: 66,  z: -700, rx: 18, ry: 12,  rz: 4 },
    sky:    { sx: 1222, sy: 297, sw: 135, z: -260, rx: 24, ry: -34, rz: -9 },
    stone:  { sx: 1068, sy: 408, sw: 125, z: -420, rx: 14, ry: -30, rz: -4 },
    ink:    { sx: 1072, sy: 575, sw: 52,  z: -800, rx: 10, ry: -20, rz: 0 },
    paper:  { sx: 515,  sy: 565, sw: 70,  z: -700, rx: 12, ry: 30,  rz: 3 },
    lilac:  { sx: 340,  sy: 637, sw: 180, z: 210,  rx: 20, ry: 34,  rz: 6 },
    blank:  { sx: 800,  sy: 697, sw: 80,  z: -650, rx: 22, ry: 8,   rz: 2 },
    rose:   { sx: 1230, sy: 702, sw: 150, z: -260, rx: 20, ry: -30, rz: -5 },
  };

  // Faint orbit lines: circles laid in tilted planes around the knot.
  const RINGS = [
    { x: -8,  y: -25, z: 0,  r: 550, tilt: 66, roll: 0 },
    { x: -30, y: -40, z: -60, r: 470, tilt: 72, roll: -14 },
  ];

  // ---------- Math helpers ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const approach = (rate, dt) => 1 - Math.pow(1 - rate, dt);   // frame-rate independent easing
  const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
  const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
  function rotAxis(p, k, a) {   // Rodrigues' rotation of p about unit axis k
    const c = Math.cos(a), s = Math.sin(a);
    const d = (k[0] * p[0] + k[1] * p[1] + k[2] * p[2]) * (1 - c);
    return [
      p[0] * c + (k[1] * p[2] - k[2] * p[1]) * s + k[0] * d,
      p[1] * c + (k[2] * p[0] - k[0] * p[2]) * s + k[1] * d,
      p[2] * c + (k[0] * p[1] - k[1] * p[0]) * s + k[2] * d,
    ];
  }
  const blurAt = (z) => Math.min(4.5, Math.max(0, Math.abs(z) - 90) * 0.015);  // depth of field
  const facing = (x) => -40 * Math.tanh(x / 260);   // cards turn toward the centre as they orbit

  // ---------- DOM ----------
  const stage = document.getElementById('stage');
  const scene = document.getElementById('scene');
  const caption = document.getElementById('caption');
  const capTitle = caption.querySelector('.caption__title');
  const capMeta = caption.querySelector('.caption__meta');
  const rings = [...scene.querySelectorAll('.ring')];

  const cards = [...scene.querySelectorAll('.card')].map((el, i) => {
    const p = POSES[el.dataset.id];
    if (p.sx !== undefined) {
      const k = P / (P - p.z);
      Object.assign(p, { x: (p.sx - REF_W / 2) / k, y: (p.sy - REF_H / 2) / k, w: p.sw / (k * Math.cos(p.ry * DEG)) });
    }
    const shadow = document.createElement('span');
    shadow.className = 'shadow';
    scene.insertBefore(shadow, scene.querySelector('.card'));
    const c = {
      el, shadow, pose: p,
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
  let theta = 0, thetaV = 0;
  let focused = null, focusAmt = 0;
  let s = 1;            // reference px → CSS px
  let knot = null;

  function setFocus(c) {
    focused = c;
    stage.classList.toggle('is-focus', !!c);
    caption.classList.toggle('is-on', !!c);
    if (c) { capTitle.textContent = c.el.dataset.title; capMeta.textContent = c.el.dataset.meta; }
    for (const o of cards) o.el.setAttribute('aria-pressed', String(o === c));
  }

  function resize() {
    const vw = innerWidth, vh = innerHeight;
    s = vw < 760 ? Math.min(vw / 760, vh / 1150) : Math.min(vw / REF_W, vh / REF_H);
    stage.style.perspective = `${P * s}px`;
    RINGS.forEach((r, i) => {
      const d = 2 * r.r * s;
      Object.assign(rings[i].style, { width: `${d}px`, height: `${d}px`, left: `${-d / 2}px`, top: `${-d / 2}px` });
    });
    if (knot) knot.resize(vw, vh, s);
  }

  // ---------- Per-frame ----------
  function updateCard(c, t, dt, ax, ay) {
    const p = c.pose;
    const bob = reduceMotion ? 0 : Math.sin(t * 0.7 + c.phase) * 7;

    // orbit, then drift toward the pointer (nearer cards more), then tilt with the pointer
    let v = rotAxis([p.x, p.y + bob, p.z], AXIS, theta);
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
    let rx = p.rx + smooth.y * 7 + c.lean.x;
    let ry = p.ry + facing(x) - facing(p.x) + smooth.x * 10 + c.lean.y;
    let rz = p.rz + c.lean.z;
    let scale = (p.w / FACE_W) * (1 + c.hover * 0.05);
    let blur = blurAt(z) * (1 - c.hover);
    let opacity = 1 - Math.min(0.3, Math.max(0, -z - 250) * 0.0006);

    if (focused && focused !== c) { blur += 5 * focusAmt; opacity *= 1 - 0.72 * focusAmt; }
    if (c.focus > 0.001) {          // fly to the front, square to the viewer
      const f = smoothstep(clamp(c.focus, 0, 1));
      const fz = 420, fp = P / (P - fz);
      const target = Math.min(innerWidth * 0.62, innerHeight * 0.56 * 1.5, 900);
      const fs = target / (FACE_W * fp * s);
      x = lerp(x, 0, f); y = lerp(y, -24, f); z = lerp(z, fz, f);
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
    const bottom = y + (FACE_W * scale) / 3;
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

    if (!drag.active) { theta += thetaV * dt; thetaV *= Math.pow(0.93, dt); }
    focusAmt += ((focused ? 1 : 0) - focusAmt) * approach(0.09, dt);

    const ax = -smooth.y * 5 * DEG, ay = smooth.x * 8 * DEG;
    for (const c of cards) updateCard(c, t, dt, ax, ay);
    RINGS.forEach((r, i) => {
      rings[i].style.transform =
        `rotateX(${ax}rad) rotateY(${ay}rad) translate3d(${r.x * s}px,${r.y * s}px,${r.z * s}px) rotateZ(${r.roll}deg) rotateX(${r.tilt}deg)`;
    });

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
    Object.assign(drag, { active: true, moved: false, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastT: performance.now() });
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
      const d = ((e.clientX - drag.lastX) * 0.005) / Math.max(s, 0.4);
      theta += d;
      thetaV = d / Math.max(1, (now - drag.lastT) / 16.667);
      drag.lastT = now;
    }
    drag.lastX = e.clientX;
  });

  addEventListener('pointerup', (e) => {
    if (drag.active) { drag.active = false; stage.classList.remove('is-dragging'); }
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
    thetaV = clamp(thetaV + clamp(d, -120, 120) * 0.00011, -0.08, 0.08);
    if (focused) setFocus(null);
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focused) setFocus(null);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') thetaV += 0.012;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') thetaV -= 0.012;
  });

  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  // ---------- The red knot (three.js, loaded on demand) ----------
  async function initKnot() {
    const canvas = document.getElementById('knot');
    const THREE = await import('three');

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const scene3 = new THREE.Scene();
    // a dark studio with white softboxes: deep red body, crisp white highlights
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0x4c4c4c);
    const softbox = (w, h, x, y, z, power) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(power, power, power), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); studio.add(m);
    };
    softbox(8, 2.4, 0, 5, 1.5, 6);     // overhead strip
    softbox(2, 7, -5, 1, 2.5, 4);      // left strip
    softbox(1.6, 6, 5.5, 0, 0.5, 2);   // right strip
    softbox(10, 4, 0, 0.5, 6, 2);      // front fill
    softbox(14, 14, 0, -6, 0, 0.9);    // white floor bounce
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene3.environment = pmrem.fromScene(studio, 0.02).texture;
    const camera = new THREE.PerspectiveCamera(30, 1, 10, 20000);

    // Overhand knot traced from the reference, in reference px (x right, y up, z toward the viewer).
    const PATH = [
      [-170, 117, 0], [-100, 117, -4], [-35, 114, -32], [8, 96, -38], [36, 58, -30], [42, 15, -20],
      [60, -30, -10], [105, -52, 0], [152, -38, 8], [178, 8, 12], [172, 62, 16], [140, 106, 22],
      [92, 132, 28], [40, 142, 34], [2, 124, 40], [-6, 80, 40], [-6, 40, 32], [-26, 4, 22],
      [-70, -38, 12], [-120, -87, 4], [-168, -133, 0],
    ];
    const curve = new THREE.CatmullRomCurve3(PATH.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const R = 36, SEG = 420, RAD = 40, BULB = 1.28;
    const geo = new THREE.TubeGeometry(curve, SEG, R, RAD, false);

    // swell both ends into rounded bulbs
    const pos = geo.attributes.position, centre = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      const f = 1 + (BULB - 1) * (Math.exp(-((u / 0.07) ** 2)) + Math.exp(-(((1 - u) / 0.07) ** 2)));
      curve.getPointAt(u, centre);
      for (let j = 0; j <= RAD; j++) {
        const idx = i * (RAD + 1) + j;
        v.fromBufferAttribute(pos, idx).sub(centre).multiplyScalar(f).add(centre);
        pos.setXYZ(idx, v.x, v.y, v.z);
      }
    }

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xc4121b, metalness: 0.45, roughness: 0.12,
      clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1,
    });
    const body = new THREE.Group();
    body.add(new THREE.Mesh(geo, mat));
    for (const u of [0, 1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(R * BULB, 40, 28), mat);
      cap.position.copy(curve.getPointAt(u));
      body.add(cap);
    }
    const holder = new THREE.Group();
    holder.add(body);
    scene3.add(holder);

    let sc = 1, spin = 0, spinV = 0, wobble = 0;
    const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();

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
        holder.rotation.set(0.12 + my * 0.35 + Math.sin(t * 0.5) * 0.03 * idle, -0.1 + mx * 0.5 + th * 0.35 + spin, Math.sin(t * 0.4) * 0.025 * idle);
        holder.position.set(KNOT_OFFSET.x * sc, (-KNOT_OFFSET.y + Math.sin(t * 0.8) * 5 * idle) * sc, 0);
        const w = Math.sin(t * 16) * 0.07 * wobble;
        body.scale.set(1 + w, 1 - w, 1 + w * 0.5);
        renderer.render(scene3, camera);
      },
      hit(x, y) {
        ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        return raycaster.intersectObject(body, true).length > 0;
      },
      poke() { spinV += 0.22; wobble = 1; },
    };
  }

  initKnot()
    .then((k) => { knot = k; resize(); })
    .catch((err) => console.warn('3D knot unavailable:', err));
})();
