'use strict';
/*
 * Zellfresser Server
 * Eine gemeinsame Arena für alle Spieler. Der Server berechnet alles
 * (Bewegung, Fressen, Futter, Viren, Bots) und schickt jedem Spieler
 * nur den Ausschnitt, den er gerade sieht.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TOTAL = parseInt(process.env.TOTAL_PLAYERS || '24', 10);   // Spieler + Bots zusammen
const MIN_BOTS = parseInt(process.env.MIN_BOTS || '6', 10);      // so viele Bots bleiben immer
const MAX_HUMANS = parseInt(process.env.MAX_HUMANS || '40', 10); // Obergrenze für echte Spieler
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const WORLD = 5000, FOOD_N = 700, VIRUS_N = 14, START_M = 24, MAX_CELLS = 12;
const TICK_MS = 33, SEND_EVERY = 2;

const SKIN_IDS = ['klassik', 'mandarine', 'minze', 'blaubeere', 'zebra', 'melone', 'zuckerwatte', 'lava', 'nacht', 'gold'];
const BOT_SKINS = SKIN_IDS.slice(1, -1);
const NAMES = ['Blubb', 'Schnappi', 'Fresssack', 'Kugelblitz', 'Klecks', 'Mampfred', 'Pixel', 'Nudel', 'Zellie', 'Moppel', 'Gulp', 'Rundi',
  'Dr. Mampf', 'Tapsi', 'Wabbel', 'Knödel', 'Murmel', 'Schmatz', 'Rollo', 'Quarki', 'Happs', 'Dicki', 'Bömmel', 'Flummi', 'Pummel', 'Mops',
  'Kleckser', 'Glibber', 'Mümmel', 'Schlürf', 'Plumps', 'Tropfi', 'Wuppdi', 'Kuller', 'Gluckser', 'Pfannkuchen', 'Puddel', 'Nussi', 'Dotter', 'Zwiebel'];

const rnd = (a, b) => a + Math.random() * (b - a);
const rad = m => Math.sqrt(m) * 6;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- static files ----------
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Nicht gefunden'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- world ----------
let players = [], food = [], viruses = [], ej = [];
let T = 0, cellSeq = 1, playerSeq = 1;
let ranks = new Map(), lbCache = [], aliveCount = 0;

const mkFood = () => ({ x: rnd(30, WORLD - 30), y: rnd(30, WORLD - 30), h: Math.floor(rnd(0, 360)) });
const mkVirus = () => ({ x: rnd(300, WORLD - 300), y: rnd(300, WORLD - 300), r: 46 });
const mkCell = (x, y, m, bx, by, merge) => ({ id: cellSeq++, x, y, m, bx, by, merge });
const totalMass = p => { let s = 0; for (const c of p.cells) s += c.m; return s; };

function makePlayer(name, bot, skin) {
  return { id: playerSeq++, name, bot, skin, h: Math.floor(rnd(0, 360)), cells: [], tx: WORLD / 2, ty: WORLD / 2, dead: true,
    thinkAt: 0, skill: rnd(0.5, 1), respawnAt: 0, kills: 0, peak: 0, killer: '', bornAt: 0, bestRank: 99,
    ws: null, vw: 900, vh: 600, lastAct: 0 };
}

function spawn(p, m) {
  let best = null, bestD = -Infinity;
  for (let k = 0; k < 12; k++) {
    const x = rnd(250, WORLD - 250), y = rnd(250, WORLD - 250);
    let md = 1e9;
    for (const q of players) {
      if (q === p || q.dead) continue;
      for (const c of q.cells) { const d = Math.hypot(c.x - x, c.y - y) - rad(c.m); if (d < md) md = d; }
    }
    if (md > bestD) { bestD = md; best = { x, y }; }
  }
  p.dead = false;
  p.cells = [mkCell(best.x, best.y, m, 0, 0, 0)];
  p.tx = best.x; p.ty = best.y; p.thinkAt = 0;
}

function addBot() {
  const used = new Set(players.map(p => p.name));
  const pool = NAMES.filter(n => !used.has(n));
  const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 'Bot ' + Math.floor(rnd(10, 99));
  const skin = Math.random() < 0.45 ? BOT_SKINS[Math.floor(Math.random() * BOT_SKINS.length)] : 'klassik';
  const p = makePlayer(name, true, skin);
  spawn(p, rnd(START_M, 90));
  players.push(p);
}

function init() {
  food = []; for (let i = 0; i < FOOD_N; i++) food.push(mkFood());
  viruses = []; for (let i = 0; i < VIRUS_N; i++) viruses.push(mkVirus());
  for (let i = 0; i < Math.max(MIN_BOTS, TOTAL); i++) addBot();
}

// ---------- bot brain ----------
function think(p) {
  const big = p.cells.reduce((a, c) => (c.m > a.m ? c : a), p.cells[0]);
  let cx = 0, cy = 0, M = 0;
  for (const c of p.cells) { cx += c.x * c.m; cy += c.y * c.m; M += c.m; }
  cx /= M; cy /= M;
  const r = rad(big.m);
  let threat = null, threatD = 1e9, prey = null, preyScore = 0;
  for (const q of players) {
    if (q === p || q.dead) continue;
    for (const c of q.cells) {
      const d = Math.hypot(c.x - cx, c.y - cy);
      const rc = rad(c.m);
      if (c.m > big.m * 1.2 && d < 320 + rc * 2) { if (d < threatD) { threatD = d; threat = c; } }
      else if (big.m > c.m * 1.3 && d < 700) {
        const s = c.m / (d + 40);
        if (s > preyScore) { preyScore = s; prey = c; }
      }
    }
  }
  let vx = 0, vy = 0;
  if (big.m > 140) {
    for (const v of viruses) {
      const d = Math.hypot(v.x - cx, v.y - cy);
      if (d < r + 140) { vx += (cx - v.x) / (d + 1); vy += (cy - v.y) / (d + 1); }
    }
  }
  if (threat) {
    let dx = cx - threat.x, dy = cy - threat.y; const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const pad = 400;
    if (cx < pad) dx += 1.4;
    if (cx > WORLD - pad) dx -= 1.4;
    if (cy < pad) dy += 1.4;
    if (cy > WORLD - pad) dy -= 1.4;
    p.tx = cx + (dx + vx) * 600; p.ty = cy + (dy + vy) * 600;
  } else if (prey) {
    p.tx = prey.x + prey.bx * 0.2 + vx * 300; p.ty = prey.y + prey.by * 0.2 + vy * 300;
    const d = Math.hypot(prey.x - cx, prey.y - cy);
    if (big.m > 70 && p.cells.length < 3 && d < 280 && d > r && big.m / 2 > prey.m * 1.3 && Math.random() < 0.12 * p.skill) split(p);
  } else {
    let bf = null, bd = 1e9;
    for (const f of food) {
      const dx = f.x - cx, dy = f.y - cy; const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bf = f; }
    }
    if (bf) { p.tx = bf.x + vx * 300; p.ty = bf.y + vy * 300; }
  }
  p.tx = clamp(p.tx, 0, WORLD); p.ty = clamp(p.ty, 0, WORLD);
  p.thinkAt = T + rnd(0.18, 0.4) / p.skill;
}

// ---------- actions ----------
function split(p) {
  for (const c of p.cells.slice()) {
    if (p.cells.length >= MAX_CELLS) break;
    if (c.m < 36) continue;
    let dx = p.tx - c.x, dy = p.ty - c.y; const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    c.m /= 2;
    const t = T + 9 + c.m * 0.01;
    c.merge = t;
    p.cells.push(mkCell(c.x, c.y, c.m, dx * 760, dy * 760, t));
  }
}

function eject(p) {
  for (const c of p.cells) {
    if (c.m < 35) continue;
    let dx = p.tx - c.x, dy = p.ty - c.y; const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    c.m -= 14;
    const r = rad(c.m);
    ej.push({ x: c.x + dx * r, y: c.y + dy * r, vx: dx * 620, vy: dy * 620, m: 12, h: p.h, skin: p.skin, age: 0 });
  }
}

function popCell(c, v) {
  const p = c.o;
  const n = Math.min(7, MAX_CELLS - p.cells.length);
  const nv = mkVirus(); v.x = nv.x; v.y = nv.y;
  if (n <= 0) { c.m += 20; return; }
  const piece = c.m / (n + 1);
  c.m = piece; c.merge = T + 12;
  const a0 = rnd(0, Math.PI * 2);
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2;
    p.cells.push(mkCell(c.x, c.y, piece, Math.cos(a) * 650, Math.sin(a) * 650, T + 12));
  }
}

// ---------- simulation ----------
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function step(dt) {
  T += dt;

  for (const p of players) {
    if (p.dead) {
      if (p.bot && T > p.respawnAt) spawn(p, rnd(START_M, 40));
      continue;
    }
    if (p.bot && T >= p.thinkAt) think(p);
    for (const c of p.cells) {
      const dx = p.tx - c.x, dy = p.ty - c.y; const d = Math.hypot(dx, dy);
      const sp = 420 * Math.pow(c.m, -0.2);
      if (d > 1) {
        const f = Math.min(1, d / (rad(c.m) * 0.5 + 12));
        c.x += (dx / d) * sp * f * dt; c.y += (dy / d) * sp * f * dt;
      }
      c.x += c.bx * dt; c.y += c.by * dt;
      const k = Math.exp(-5 * dt); c.bx *= k; c.by *= k;
      if (c.m > 40) c.m -= c.m * 0.0012 * dt;
      c.x = clamp(c.x, 0, WORLD); c.y = clamp(c.y, 0, WORLD);
    }
  }

  for (const e of ej) {
    e.x += e.vx * dt; e.y += e.vy * dt;
    const k = Math.exp(-3 * dt); e.vx *= k; e.vy *= k; e.age += dt;
    e.x = clamp(e.x, 0, WORLD); e.y = clamp(e.y, 0, WORLD);
  }
  if (ej.length && ej[0].age > 40) ej = ej.filter(e => e.age < 40);
  if (ej.length > 300) ej.splice(0, ej.length - 300);

  const all = [];
  for (const p of players) {
    if (p.dead) continue;
    for (const c of p.cells) { c.o = p; c.r = rad(c.m); c.dead = false; all.push(c); }
  }

  for (const c of all) {
    const r2 = c.r * c.r;
    for (let i = 0; i < food.length; i++) {
      const f = food[i]; const dx = f.x - c.x, dy = f.y - c.y;
      if (dx * dx + dy * dy < r2) { c.m += 1; food[i] = mkFood(); }
    }
    for (let i = ej.length - 1; i >= 0; i--) {
      const e = ej[i]; if (e.age < 0.2) continue;
      const dx = e.x - c.x, dy = e.y - c.y;
      if (dx * dx + dy * dy < r2 * 0.8) { c.m += e.m; ej.splice(i, 1); }
    }
    if (c.m >= 130) {
      for (const v of viruses) {
        if (c.r > v.r * 1.2 && Math.hypot(v.x - c.x, v.y - c.y) < c.r * 0.9) { popCell(c, v); break; }
      }
    }
  }

  for (let i = 0; i < all.length; i++) {
    const a = all[i]; if (a.dead) continue;
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j]; if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy);
      if (a.o === b.o) {
        if (T >= a.merge && T >= b.merge) {
          if (d < Math.max(a.r, b.r) * 0.8) { a.m += b.m; b.dead = true; }
        } else {
          const ov = a.r + b.r - d;
          if (ov > 0 && d > 0.01) {
            const push = ov * 0.12;
            const nx = dx / d, ny = dy / d;
            const wa = b.m / (a.m + b.m), wb = a.m / (a.m + b.m);
            a.x -= nx * push * wa; a.y -= ny * push * wa;
            b.x += nx * push * wb; b.y += ny * push * wb;
          }
        }
        continue;
      }
      const big = a.m > b.m ? a : b, small = big === a ? b : a;
      if (big.m > small.m * 1.25 && d < big.r - small.r * 0.35) {
        big.m += small.m; small.dead = true;
        big.o.kills++; small.o.killer = big.o.name;
      }
    }
  }

  for (const p of players) {
    if (p.dead) continue;
    p.cells = p.cells.filter(c => !c.dead);
    if (!p.cells.length) {
      p.dead = true;
      if (p.ws) {
        send(p.ws, { t: 'dead', killer: p.killer, peak: Math.round(p.peak), secs: Math.round(T - p.bornAt), kills: p.kills, rank: p.bestRank });
      } else {
        p.respawnAt = T + rnd(2, 5);
      }
    } else {
      const tm = totalMass(p); if (tm > p.peak) p.peak = tm;
    }
  }
}

function updateRanks() {
  const alive = players.filter(p => !p.dead).map(p => ({ p, m: totalMass(p) })).sort((a, b) => b.m - a.m);
  aliveCount = alive.length;
  ranks = new Map();
  alive.forEach((o, i) => {
    ranks.set(o.p.id, i + 1);
    if (o.p.ws && i + 1 < o.p.bestRank) o.p.bestRank = i + 1;
  });
  lbCache = alive.slice(0, 8).map(o => [o.p.name, Math.round(o.m), o.p.id]);
}

function manageBots() {
  const humans = players.filter(p => p.ws).length;
  const desired = Math.max(MIN_BOTS, TOTAL - humans);
  const bots = players.filter(p => p.bot);
  if (bots.length < desired) { for (let i = bots.length; i < desired; i++) addBot(); }
  else if (bots.length > desired) {
    bots.sort((a, b) => totalMass(a) - totalMass(b));
    const drop = new Set(bots.slice(0, bots.length - desired));
    players = players.filter(p => !drop.has(p));
  }
}

function broadcast(tick) {
  for (const p of players) {
    if (!p.ws || p.dead || p.ws.readyState !== 1) continue;
    if (p.ws.bufferedAmount > 512 * 1024) continue;
    let cx = 0, cy = 0, M = 0;
    for (const c of p.cells) { cx += c.x * c.m; cy += c.y * c.m; M += c.m; }
    cx /= M; cy /= M;
    const x0 = cx - p.vw, x1 = cx + p.vw, y0 = cy - p.vh, y1 = cy + p.vh;

    const pl = [];
    for (const q of players) {
      if (q.dead) continue;
      let arr = null;
      for (const c of q.cells) {
        const r = rad(c.m);
        if (c.x + r < x0 || c.x - r > x1 || c.y + r < y0 || c.y - r > y1) continue;
        (arr || (arr = [])).push([c.id, Math.round(c.x), Math.round(c.y), Math.round(c.m * 10) / 10]);
      }
      if (arr) pl.push([q.id, q.name, q.h, q.skin, arr]);
    }
    const f = [];
    for (const o of food) if (o.x >= x0 && o.x <= x1 && o.y >= y0 && o.y <= y1) f.push([Math.round(o.x), Math.round(o.y), o.h]);
    const v = [];
    for (const o of viruses) if (o.x >= x0 - 60 && o.x <= x1 + 60 && o.y >= y0 - 60 && o.y <= y1 + 60) v.push([Math.round(o.x), Math.round(o.y)]);
    const e = [];
    for (const o of ej) if (o.x >= x0 && o.x <= x1 && o.y >= y0 && o.y <= y1) e.push([Math.round(o.x), Math.round(o.y), o.h, o.skin]);

    const msg = { t: 's', y: [p.id, Math.round(M), ranks.get(p.id) || 1, aliveCount], p: pl, f, v, e };
    if (tick % 30 === 0) msg.lb = lbCache;
    p.ws.send(JSON.stringify(msg));
  }
}

// ---------- network ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const humanCount = () => players.reduce((n, p) => n + (p.ws ? 1 : 0), 0);
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14) || 'Spieler';

wss.on('connection', (ws, req) => {
  if (ORIGINS.length && !ORIGINS.includes(req.headers.origin || '')) { ws.close(1008, 'origin'); return; }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let me = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (me && !me.dead) return;
      if (!me) {
        if (humanCount() >= MAX_HUMANS) { send(ws, { t: 'full' }); return; }
        me = makePlayer('Spieler', false, 'klassik');
        me.ws = ws;
        players.push(me);
      }
      me.name = cleanName(m.name);
      me.skin = SKIN_IDS.includes(m.skin) ? m.skin : 'klassik';
      me.h = Math.floor(rnd(0, 360));
      me.kills = 0; me.peak = START_M; me.killer = ''; me.bornAt = T; me.bestRank = 99;
      spawn(me, START_M);
      return;
    }
    if (!me || me.dead) return;

    if (m.t === 'in') {
      const x = num(m.x), y = num(m.y);
      if (x === null || y === null) return;
      me.tx = clamp(x, 0, WORLD); me.ty = clamp(y, 0, WORLD);
      const vw = num(m.vw), vh = num(m.vh);
      if (vw !== null) me.vw = clamp(vw, 300, 2800);
      if (vh !== null) me.vh = clamp(vh, 300, 2800);
    } else if (m.t === 'split' || m.t === 'eject') {
      const now = Date.now();
      if (now - me.lastAct < 120) return;
      me.lastAct = now;
      if (m.t === 'split') split(me); else eject(me);
    }
  });

  ws.on('close', () => { if (me) players = players.filter(p => p !== me); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

// ---------- main loop ----------
init();
updateRanks();
let last = Date.now(), tick = 0;
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;
  if (humanCount() === 0) return; // niemand da: Arena pausiert, spart Rechenzeit
  step(dt);
  tick++;
  if (tick % 30 === 0) { updateRanks(); manageBots(); }
  if (tick % SEND_EVERY === 0) broadcast(tick);
}, TICK_MS);

server.listen(PORT, () => console.log('Zellfresser läuft auf Port ' + PORT));
