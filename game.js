/* Bounce — a fullscreen tap-to-bounce ball built on PixiJS v8.
 * Tap the ball to knock it back up. Walls, floor and ceiling all bounce.
 * Everything below is tuned for touch first, mouse second. */

(function () {
  'use strict';

  var elCount = document.getElementById('count');
  var elStreak = document.getElementById('streak');
  var elBest = document.getElementById('best');
  var elStats = document.getElementById('stats');
  var elHint = document.getElementById('hint');

  if (!window.PIXI) {
    showError('PixiJS could not be loaded. Check your connection and reload.');
    return;
  }

  var Application = PIXI.Application;
  var Container = PIXI.Container;
  var Graphics = PIXI.Graphics;
  var Sprite = PIXI.Sprite;
  var Texture = PIXI.Texture;

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function showError(msg) {
    var d = document.getElementById('error');
    if (!d) {
      d = document.createElement('div');
      d.id = 'error';
      document.body.appendChild(d);
    }
    d.textContent = msg;
    d.style.display = 'flex';
  }

  /* Canvas-drawn textures: nothing to download, sharp at any DPR. */
  function makeTex(w, h, draw) {
    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    draw(cv.getContext('2d'), w, h);
    var tex;
    try {
      tex = Texture.from(cv);
    } catch (e) {
      tex = new Texture({ source: new PIXI.CanvasSource({ resource: cv }) });
    }
    try { tex.source.scaleMode = 'linear'; } catch (e) { /* older build */ }
    return tex;
  }

  /* The ball: glossy orb, light from the upper left. */
  var ORB_TEX = makeTex(256, 256, function (c, S) {
    var R = S / 2;
    c.beginPath();
    c.arc(R, R, R, 0, Math.PI * 2);
    c.clip();

    var g = c.createRadialGradient(R * 0.70, R * 0.58, R * 0.05, R, R, R * 1.15);
    g.addColorStop(0.00, '#ffffff');
    g.addColorStop(0.18, '#edfdff');
    g.addColorStop(0.44, '#9de8ff');
    g.addColorStop(0.70, '#48baea');
    g.addColorStop(0.88, '#1e7eaf');
    g.addColorStop(1.00, '#0d4a6e');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);

    var s = c.createRadialGradient(R * 0.62, R * 0.44, 0, R * 0.62, R * 0.44, R * 0.58);
    s.addColorStop(0, 'rgba(255,255,255,0.72)');
    s.addColorStop(0.45, 'rgba(255,255,255,0.16)');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = s;
    c.fillRect(0, 0, S, S);
  });

  var DOT_TEX = makeTex(64, 64, function (c, S) {
    var g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.30, 'rgba(206,247,255,0.85)');
    g.addColorStop(0.65, 'rgba(140,224,250,0.28)');
    g.addColorStop(1.00, 'rgba(110,200,240,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  });

  var GLOW_TEX = makeTex(128, 128, function (c, S) {
    var g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, 'rgba(154,238,255,0.50)');
    g.addColorStop(0.26, 'rgba(126,231,255,0.26)');
    g.addColorStop(0.58, 'rgba(92,192,240,0.09)');
    g.addColorStop(1.00, 'rgba(58,140,200,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  });

  var BG_TEX = makeTex(4, 256, function (c, w, h) {
    var g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.00, '#04060b');
    g.addColorStop(0.40, '#070d16');
    g.addColorStop(0.72, '#0a1422');
    g.addColorStop(0.90, '#0d1c2e');
    g.addColorStop(1.00, '#122639');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });

  /* ------------------------------------------------------------------ */
  /* constants & state                                                   */
  /* ------------------------------------------------------------------ */

  var FIXED = 1 / 120;          // physics step, seconds
  var TAP_HEIGHT = 0.62;        // how far up a tap sends the ball (fraction of height)
  var REST_FLOOR = 0.86;
  var REST_WALL = 0.92;
  var REST_CEIL = 0.55;
  var HIT_MULT = 2.6;           // touch target = r * HIT_MULT
  var HIT_MIN = 68;             // ...never smaller than this (px)
  var TRAIL_N = 18;
  var PART_N = 150;
  var RING_N = 10;
  var MOTE_N = 26;

  var V = { w: 0, h: 0, r: 30, floor: 0, g: 2000 };

  var S = {
    x: 0, y: 0, vx: 0, vy: 0,
    grounded: false, sleeping: false,
    bounces: 0, streak: 0,
    best: readBest(),
    armed: false,
    sqY: 0, sqYv: 0, sqX: 0, sqXv: 0,
    pulse: 0, hudPulse: 0
  };

  function readBest() {
    try {
      var v = parseInt(window.localStorage.getItem('bounce.best') || '0', 10);
      return isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  function writeBest(v) {
    try { window.localStorage.setItem('bounce.best', String(v)); } catch (e) { /* private mode */ }
  }

  var acc = 0;
  var ballC, ballGlow, ballS;
  var bgSprite, bottomGlow;
  var trailSprites = [], trailHist = [];
  var parts = [], rings = [], motes = [];
  var firstTap = true;
  var hintTimer = 0;
  var bestFlashTimer = 0;

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  var app = new Application();

  app.init({
    antialias: true,
    backgroundAlpha: 1,
    backgroundColor: 0x05070c,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    preference: 'webgl',
    powerPreference: 'high-performance'
  }).then(start).catch(function (err) {
    showError('Could not start the renderer on this browser.');
    if (window.console) console.error(err);
  });

  function start() {
    document.getElementById('stage').appendChild(app.canvas);

    /* background */
    var bgLayer = new Container();
    bgSprite = new Sprite(BG_TEX);
    bottomGlow = new Sprite(GLOW_TEX);
    bottomGlow.anchor.set(0.5, 0.5);
    bottomGlow.blendMode = 'add';
    bottomGlow.alpha = 0.55;
    bgLayer.addChild(bgSprite, bottomGlow);
    app.stage.addChild(bgLayer);

    /* motes: slow drifting dust, gives the dark some depth */
    var moteLayer = new Container();
    app.stage.addChild(moteLayer);
    for (var i = 0; i < MOTE_N; i++) {
      var ms = new Sprite(DOT_TEX);
      ms.anchor.set(0.5, 0.5);
      ms.blendMode = 'add';
      ms.visible = false;
      moteLayer.addChild(ms);
      motes.push({
        s: ms, x: 0, y: 0, vy: 0, amp: 0, ph: 0, t: 0, sz: 0, a: 0, seed: Math.random()
      });
    }

    /* playfield layers */
    var trailLayer = new Container();
    var ringLayer = new Container();
    var ballLayer = new Container();
    var partLayer = new Container();
    app.stage.addChild(trailLayer, ringLayer, ballLayer, partLayer);

    /* trail */
    for (var t = 0; t < TRAIL_N; t++) {
      var ts = new Sprite(DOT_TEX);
      ts.anchor.set(0.5, 0.5);
      ts.blendMode = 'add';
      ts.alpha = 0;
      ts.visible = false;
      trailLayer.addChild(ts);
      trailSprites.push(ts);
    }

    /* rings */
    for (var q = 0; q < RING_N; q++) {
      var rg = new Graphics();
      rg.circle(0, 0, 50).stroke({ width: 2.4, color: 0x9beeff, alpha: 1, alignment: 0.5 });
      rg.visible = false;
      ringLayer.addChild(rg);
      rings.push({ g: rg, life: 0, max: 1, x: 0, y: 0, r0: 40 });
    }

    /* the ball */
    ballC = new Container();
    ballGlow = new Sprite(GLOW_TEX);
    ballGlow.anchor.set(0.5, 0.5);
    ballGlow.blendMode = 'add';
    ballS = new Sprite(ORB_TEX);
    ballS.anchor.set(0.5, 0.5);
    ballC.addChild(ballGlow, ballS);
    ballLayer.addChild(ballC);

    /* particles */
    for (var p = 0; p < PART_N; p++) {
      var ps = new Sprite(DOT_TEX);
      ps.anchor.set(0.5, 0.5);
      ps.blendMode = 'add';
      ps.visible = false;
      partLayer.addChild(ps);
      parts.push({ s: ps, life: 0, max: 1, x: 0, y: 0, vx: 0, vy: 0, size: 5 });
    }

    layout(true);
    updateHud();

    app.ticker.add(tick);
    bindInput();

    /* a read-only peek for debugging */
    window.bounceState = function () {
      return {
        x: S.x, y: S.y, vx: S.vx, vy: S.vy,
        bounces: S.bounces, streak: S.streak, best: S.best,
        sleeping: S.sleeping, r: V.r, w: V.w, h: V.h, floor: V.floor
      };
    };
  }

  /* ------------------------------------------------------------------ */
  /* layout                                                             */
  /* ------------------------------------------------------------------ */

  function layout(isFirst) {
    var w = Math.max(1, window.innerWidth);
    var h = Math.max(1, window.innerHeight);
    V.w = w;
    V.h = h;

    app.renderer.resize(w, h);

    V.r = clamp(Math.min(w, h) * 0.072, 18, 52);
    V.floor = h - Math.max(18, h * 0.05);
    V.g = h * 2.15;

    if (bgSprite) {
      bgSprite.width = w;
      bgSprite.height = h;
    }
    if (bottomGlow) {
      bottomGlow.width = w * 1.9;
      bottomGlow.height = h * 0.66;
      bottomGlow.position.set(w / 2, h + bottomGlow.height * 0.24);
    }
    if (ballS) ballS.scale.set((V.r * 2) / 256);
    if (ballGlow) ballGlow.scale.set((V.r * 6.6) / 128);

    if (isFirst) {
      S.x = w * 0.5;
      S.y = V.floor - V.r - h * 0.26;
      S.vx = rnd(-30, 30);
      S.vy = 0;
    } else {
      S.x = clamp(S.x, V.r, w - V.r);
      S.y = clamp(S.y, V.r, V.floor - V.r);
    }

    trailHist.length = 0;

    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      m.sz = rnd(8, 26);
      m.a = rnd(0.05, 0.16);
      m.vy = rnd(4, 16);
      m.amp = rnd(6, 26);
      m.ph = rnd(0, Math.PI * 2);
      if (!m.s.visible) {
        m.x = rnd(0, w);
        m.y = rnd(0, h);
        m.s.visible = true;
      } else {
        m.x = clamp(m.x, 0, w);
        m.y = clamp(m.y, 0, h);
      }
      m.s.visible = true;
    }

    if (ballC) {
      ballC.position.set(S.x, S.y);
      ballC.scale.set(1, 1);
    }
  }

  var resizeQueued = false;
  function queueLayout() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      layout(false);
    });
  }

  /* ------------------------------------------------------------------ */
  /* physics                                                            */
  /* ------------------------------------------------------------------ */

  function step(dt) {
    if (S.sleeping) {
      S.vx = 0;
      S.vy = 0;
      return;
    }

    var r = V.r;

    S.vy += V.g * dt;
    S.x += S.vx * dt;
    S.y += S.vy * dt;

    /* side walls */
    if (S.x - r < 0) {
      S.x = r;
      if (S.vx < 0) {
        var iw = -S.vx;
        if (iw > 90) {
          S.vx = iw * REST_WALL;
          onHit('wall', S.x, S.y, iw, 1, 0);
        } else {
          S.vx = 0;
        }
      }
    } else if (S.x + r > V.w) {
      S.x = V.w - r;
      if (S.vx > 0) {
        var iw2 = S.vx;
        if (iw2 > 90) {
          S.vx = -iw2 * REST_WALL;
          onHit('wall', S.x, S.y, iw2, -1, 0);
        } else {
          S.vx = 0;
        }
      }
    }

    /* ceiling */
    if (S.y - r < 0) {
      S.y = r;
      if (S.vy < 0) {
        var ic = -S.vy;
        if (ic > 90) {
          S.vy = ic * REST_CEIL;
          onHit('top', S.x, S.y, ic, 0, 1);
        } else {
          S.vy = 0;
        }
      }
    }

    /* floor */
    if (S.y + r >= V.floor) {
      S.y = V.floor - r;
      if (S.vy > 0) {
        var iy = S.vy;
        if (iy > 105) {
          S.vy = -iy * REST_FLOOR;
          S.vx *= 0.97;
          S.grounded = true;
          onHit('floor', S.x, V.floor, iy, 0, -1);
        } else {
          S.vy = 0;
          S.grounded = true;
        }
      }
    }

    /* at rest on the floor: rub out the slide, then sleep */
    if (S.grounded && S.vy === 0) {
      if (S.y + r < V.floor - 0.8) {
        S.grounded = false;
      } else {
        S.vx *= Math.pow(0.03, dt);
        if (Math.abs(S.vx) < 26) {
          S.vx = 0;
          settle();
        }
      }
    }
  }

  function onHit(kind, x, y, impact, nx, ny) {
    var power = clamp(impact / 1300, 0, 1);

    /* the ball drops in on its own before the first tap: no score yet */
    if (S.armed) {
      S.bounces++;
      S.streak++;
      S.hudPulse = 1;
      updateHud();
    }

    if (kind === 'floor') {
      S.sqY = -(0.13 + 0.20 * power);
      S.sqYv = 0;
    } else if (kind === 'top') {
      S.sqY = 0.09 + 0.13 * power;
      S.sqYv = 0;
    } else {
      S.sqX = -(0.11 + 0.17 * power);
      S.sqXv = 0;
    }

    burst(x, y, kind, impact, nx, ny);
    spawnRing(x, y, V.r * (0.85 + 0.45 * power), power);
  }

  function settle() {
    if (S.sleeping) return;
    S.sleeping = true;
    S.grounded = true;

    if (S.streak > S.best) {
      S.best = S.streak;
      writeBest(S.best);
      flashBest();
    }
    S.streak = 0;
    updateHud();

    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      if (S.sleeping && !firstTap) setHint('tap the ball');
    }, 900);
  }

  /* ------------------------------------------------------------------ */
  /* tapping                                                            */
  /* ------------------------------------------------------------------ */

  function bindInput() {
    window.addEventListener('pointerdown', onPointerDown, { passive: false });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('resize', queueLayout);
    window.addEventListener('orientationchange', function () {
      setTimeout(queueLayout, 120);
      setTimeout(queueLayout, 420);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', queueLayout);
    }
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();

    var x = e.clientX;
    var y = e.clientY;
    var dx = x - S.x;
    var dy = y - S.y;
    var hitR = Math.max(V.r * HIT_MULT, HIT_MIN);

    if (dx * dx + dy * dy > hitR * hitR) return;

    tapBall(x, y, dx, dy);
  }

  function tapBall(x, y, dx, dy) {
    var impulse = Math.sqrt(2 * V.g * V.h * TAP_HEIGHT);

    S.vy = -impulse;

    /* a tap that lands off-centre flicks the ball sideways */
    var off = clamp(dx / (V.r * 1.4), -1, 1);
    S.vx = clamp(S.vx + off * 560, -1600, 1600);
    if (Math.abs(S.vx) < 50) S.vx += rnd(-25, 25);

    S.grounded = false;
    S.sleeping = false;
    S.armed = true;

    S.sqY = 0.17;
    S.sqYv = 0;
    S.pulse = 1;

    spawnRing(S.x, S.y, V.r * 1.05, 0.55);
    tapBurst(x, y);

    if (hintTimer) clearTimeout(hintTimer);
    if (firstTap) {
      firstTap = false;
      setHint(null);
    }

    if (navigator.vibrate) {
      try { navigator.vibrate(8); } catch (err) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* effects                                                            */
  /* ------------------------------------------------------------------ */

  function takeParticle() {
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].life <= 0) return parts[i];
    }
    return null;
  }

  function burst(x, y, kind, impact, nx, ny) {
    var power = clamp(impact / 1300, 0.3, 1.15);
    var count = Math.round(6 + 11 * power);
    /* particles fly away from the surface: floor -> up, wall -> inward */
    var base = Math.atan2(ny, nx);

    for (var i = 0; i < count; i++) {
      var p = takeParticle();
      if (!p) break;
      var a = base + rnd(-1.15, 1.15);
      var sp = rnd(70, 430) * power;
      p.x = x + Math.cos(a) * (V.r * 0.35);
      p.y = y + Math.sin(a) * (V.r * 0.35);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.max = p.life = rnd(0.30, 0.72);
      p.size = rnd(2.5, 7) * (0.7 + 0.5 * power);
      p.s.tint = Math.random() < 0.32 ? 0x7ee7ff : 0xffffff;
      p.s.visible = true;
    }
  }

  function tapBurst(x, y) {
    for (var i = 0; i < 9; i++) {
      var p = takeParticle();
      if (!p) return;
      var a = -Math.PI / 2 + rnd(-0.9, 0.9);
      var sp = rnd(60, 240);
      p.x = x + rnd(-4, 4);
      p.y = y + rnd(-4, 4);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.max = p.life = rnd(0.25, 0.5);
      p.size = rnd(2, 5);
      p.s.tint = 0xd8f8ff;
      p.s.visible = true;
    }
  }

  function updateParticles(dt) {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.s.visible = false;
        continue;
      }
      p.vy += V.g * 0.55 * dt;
      p.vx *= (1 - 1.7 * dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      var k = p.life / p.max;
      p.s.position.set(p.x, p.y);
      p.s.width = p.size * (0.35 + 0.65 * k);
      p.s.height = p.s.width;
      p.s.alpha = k * k;
    }
  }

  function spawnRing(x, y, radius, power) {
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (r.life > 0) continue;
      r.max = r.life = 0.42 + 0.26 * power;
      r.x = x;
      r.y = y;
      r.r0 = radius;
      r.g.visible = true;
      r.g.alpha = 1;
      return;
    }
  }

  function updateRings(dt) {
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.g.visible = false;
        continue;
      }
      var t = 1 - r.life / r.max;
      var radius = r.r0 + V.r * 2.9 * t;
      r.g.position.set(r.x, r.y);
      r.g.scale.set(radius / 50);
      r.g.alpha = (1 - t) * (1 - t);
    }
  }

  function updateTrail() {
    trailHist.unshift({ x: S.x, y: S.y });
    if (trailHist.length > TRAIL_N) trailHist.length = TRAIL_N;

    var spd = Math.sqrt(S.vx * S.vx + S.vy * S.vy);
    var k = clamp((spd - 110) / 900, 0, 1);

    for (var i = 0; i < TRAIL_N; i++) {
      var s = trailSprites[i];
      var p = trailHist[i];
      if (!p || k < 0.01) {
        s.alpha = 0;
        s.visible = false;
        continue;
      }
      var f = 1 - i / TRAIL_N;
      s.visible = true;
      s.position.set(p.x, p.y);
      s.width = s.height = V.r * 1.4 * f;
      s.alpha = 0.26 * k * f * f;
      s.tint = 0xa9e9ff;
    }
  }

  function updateMotes(dt) {
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      m.t += dt;
      m.y -= m.vy * dt;
      if (m.y < -40) {
        m.y = V.h + 40;
        m.x = rnd(0, V.w);
      }
      m.s.position.set(m.x + Math.sin(m.t * 0.45 + m.ph) * m.amp, m.y);
      m.s.width = m.s.height = m.sz;
      m.s.alpha = m.a * (0.55 + 0.45 * Math.sin(m.t * 0.9 + m.ph));
    }
  }

  /* ------------------------------------------------------------------ */
  /* ball rendering                                                     */
  /* ------------------------------------------------------------------ */

  function updateBall(dt) {
    var kY = 250, cY = 18, kX = 250, cX = 18;

    S.sqYv += (-kY * S.sqY - cY * S.sqYv) * dt;
    S.sqY += S.sqYv * dt;
    S.sqXv += (-kX * S.sqX - cX * S.sqXv) * dt;
    S.sqX += S.sqXv * dt;

    var spd = Math.sqrt(S.vx * S.vx + S.vy * S.vy);
    var stretch = clamp(spd / 12000, 0, 0.085);

    var sx = (1 - S.sqY * 0.5) * (1 + S.sqX) * (1 - stretch * 0.35);
    var sy = (1 + S.sqY) * (1 - S.sqX * 0.5) * (1 + stretch);

    ballC.position.set(S.x, S.y);
    ballC.scale.set(sx, sy);

    S.pulse = Math.max(0, S.pulse - dt * 3.4);
    ballGlow.alpha = 0.40 + 0.5 * S.pulse;
    ballGlow.scale.set((V.r * 6.6) / 128 * (1 + 0.18 * S.pulse));
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                */
  /* ------------------------------------------------------------------ */

  function updateHud() {
    elCount.textContent = String(S.bounces);
    elStreak.textContent = String(S.streak);
    elBest.textContent = String(S.best);
  }

  function updateHudFx(dt) {
    if (S.hudPulse > 0) {
      S.hudPulse = Math.max(0, S.hudPulse - dt * 4.2);
      var s = 1 + 0.09 * S.hudPulse;
      elCount.style.transform = 'scale(' + s.toFixed(3) + ')';
    } else if (elCount.style.transform !== '') {
      elCount.style.transform = '';
    }

    if (bestFlashTimer > 0) {
      bestFlashTimer -= dt;
      if (bestFlashTimer <= 0) elStats.classList.remove('best-flash');
    }
  }

  function flashBest() {
    elStats.classList.add('best-flash');
    bestFlashTimer = 1.6;
  }

  function setHint(text) {
    if (text) {
      elHint.textContent = text;
      elHint.classList.remove('is-hidden');
    } else {
      elHint.classList.add('is-hidden');
    }
  }

  /* ------------------------------------------------------------------ */
  /* main loop                                                          */
  /* ------------------------------------------------------------------ */

  function tick(ticker) {
    var dt = Math.min(ticker.deltaMS / 1000, 0.05);

    acc += dt;
    var guard = 0;
    while (acc >= FIXED && guard < 8) {
      step(FIXED);
      acc -= FIXED;
      guard++;
    }
    if (guard >= 8) acc = 0;

    updateBall(dt);
    updateParticles(dt);
    updateRings(dt);
    updateTrail();
    updateMotes(dt);
    updateHudFx(dt);
  }
})();
