(() => {
'use strict';
const D = window.DATA;
const CFG = window.ENC_CONFIG || {};
const $app = document.getElementById('app');
const $ov = document.getElementById('overlay');

// ───────────── utilidades ─────────────
const PID = new URLSearchParams(location.search).get('pid');
const NSK = k => (PID ? k.replace(/^enc:/, 'enc:' + PID + ':') : k);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(NSK(k)); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NSK(k), JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(NSK(k)); } catch {} }
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 9);
const other = s => (s === 'p1' ? 'p2' : 'p1');
const rnd = n => Math.floor(Math.random() * n);
const hashIdx = (str, n) => { let h = 7; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % n; };
const clone = o => JSON.parse(JSON.stringify(o));
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const hasWord = (text, w) => norm(w).split(/\s+/).filter(x => x.length > 2).every(x => norm(text).includes(x));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let myId = LS.get('enc:id');
if (!myId) { myId = Math.random().toString(36).slice(2, 10); LS.set('enc:id', myId); }

const CODE_WORDS = ['LUNA', 'VINO', 'MIEL', 'ROSA', 'FARO', 'JAZZ', 'MAR', 'SOL', 'TANGO', 'CANELA', 'BRISA', 'COPA', 'ABRAZO', 'VELA', 'CIELO', 'MANGO'];
const newCode = () => CODE_WORDS[rnd(CODE_WORDS.length)] + '-' + (10 + rnd(90));

function roomFromUrl() {
  const m = location.pathname.match(/\/s\/([A-Za-z0-9-]+)/);
  if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(location.search).get('s');
  return q ? q.toUpperCase() : null;
}
const roomUrl = code => location.origin + '/s/' + code + (isLocalMode() ? '?local' : '');
const keepQs = () => { const q = new URLSearchParams(); const p = new URLSearchParams(location.search); ['local', 'pid'].forEach(k => p.has(k) && q.set(k, p.get(k))); const s = q.toString().replace(/=(&|$)/g, '$1'); return s ? '?' + s : ''; };
const isLocalMode = () => new URLSearchParams(location.search).has('local') || !window.supabase || !CFG.supabaseUrl;

// ───────────── estado ─────────────
const fresh = () => ({
  seq: 0,
  players: { p1: null, p2: null },
  scores: { p1: 0, p2: 0 }, sync: 0,
  settings: { drink: 'prost', alt: false, drawBonus: true, cheer: '¡Prost!' },
  screen: 'home', g: null, used: {}, penalty: null, flash: null
});

let code = null;
let S = fresh();
let present = new Set([myId]);
let conn = 'connecting';
let synced = false;
let T = null;

const ui = {
  drafts: {}, reveal: {}, deadlines: {}, ended: {}, flashSeen: {}, flashUntil: 0, flashText: '',
  modal: null, toast: '', toastUntil: 0, diceRoll: {}, landingCode: '', tab: (() => { try { return localStorage.getItem('enc:tab'); } catch { return null; } })()
};

const mySlot = () => (S.players.p1?.id === myId ? 'p1' : S.players.p2?.id === myId ? 'p2' : null);
const nameOf = s => S.players[s]?.name || (s === 'p1' ? 'Jugador 1' : 'Jugador 2');
const nm = s => esc(nameOf(s));
const isHost = () => [...present].sort()[0] === myId;
const drinkMode = st => ({ brindis: 'prost', shot: 'tragos' }[st.settings.drink] || st.settings.drink);

// ───────────── reductor (determinista) ─────────────
function setPenalty(st, slot, seed) {
  if (!(drinkMode(st) !== 'off' || st.settings.alt)) return;
  st.penalty = { slot, pen: hashIdx(seed, D.penitencias.length), id: seed + slot, rid: st.g?.rid || null };
}
function setFlash(st, text, seed) { st.flash = { id: seed || rid(), text, rid: st.g?.rid || null }; }

function resolveAnswers(st) {
  const g = st.g;
  if (!g || !g.answers || g.resolved) return;
  const A = g.answers;
  const need = g.mode === 'turnos' ? [g.turn] : ['p1', 'p2'];
  if (need.some(s => A[s] === undefined)) return;
  const seed = g.rid;
  if (g.k === 'cartas' && g.type === 'adivina') {
    const target = g.turn, guesser = other(target);
    const ok = A[target] === A[guesser];
    g.resolved = { ok };
    if (ok) { st.scores[guesser] += 1; setFlash(st, `${nameOf(guesser)} acertó. +1`, seed); }
    else setPenalty(st, guesser, seed);
  } else if (g.k === 'quien') {
    const same = A.p1 === A.p2;
    g.resolved = { same };
    if (same) { st.sync += 1; setFlash(st, '¡Coincidieron! +1 a la sintonía', seed); }
  } else if (g.k === 'prefieres') {
    const ok1 = A.p1.guess === A.p2.me, ok2 = A.p2.guess === A.p1.me, same = A.p1.me === A.p2.me;
    if (ok1) st.scores.p1 += 1;
    if (ok2) st.scores.p2 += 1;
    if (same) st.sync += 1;
    g.resolved = { ok1, ok2, same };
  } else if (g.k === 'onda') {
    const d = Math.abs(A.p1 - A.p2);
    const pts = d === 0 ? 3 : d === 1 ? 2 : d === 2 ? 1 : 0;
    st.sync += pts;
    g.resolved = { d, pts };
  } else if (g.k === 'diccionario') {
    const reader = g.turn, guesser = other(reader);
    const ok = A[guesser] === A[reader];
    g.resolved = { ok };
    if (ok) { st.scores[guesser] += 1; setFlash(st, `${nameOf(guesser)} no se dejó engañar. +1`, seed); }
    else { st.scores[reader] += 1; setPenalty(st, guesser, seed); }
  } else if (g.k === 'dato' || g.k === 'mas') {
    const right = g.k === 'dato' ? (D.datos[g.idx].real ? 'real' : 'falso') : D.mas[g.idx].ok;
    const ok = {};
    need.forEach(s => { ok[s] = A[s] === right; if (ok[s]) st.scores[s] += 1; });
    g.resolved = { ok1: !!ok.p1, ok2: !!ok.p2, right };
    const wrong = need.filter(s => !ok[s]);
    if (wrong.length === 1) setPenalty(st, wrong[0], seed);
  } else {
    g.resolved = { done: true };
  }
}

function reduce(st0, a) {
  const st = clone(st0);
  if (a.guard && (!st.g || st.g.rid !== a.guard || st.g.done)) return st0;
  if (a.reset) { st.scores = { p1: 0, p2: 0 }; st.sync = 0; st.penalty = null; st.flash = null; st.screen = 'home'; st.g = null; }
  if (a.players) for (const k in a.players) st.players[k] = a.players[k];
  if (a.settings) Object.assign(st.settings, a.settings);
  if ('screen' in a) st.screen = a.screen;
  if ('g' in a) st.g = a.g;
  if (a.patch && st.g) Object.assign(st.g, a.patch);
  if (a.used) {
    const [k, i, len] = a.used;
    let u = st.used[k] || [];
    if (u.length >= len - 1) u = [];
    if (!u.includes(i)) u.push(i);
    st.used[k] = u;
  }
  if (a.line && st.g) st.g.lines = [...(st.g.lines || []), a.line];
  if (a.score) {
    for (const p of ['p1', 'p2']) st.scores[p] = Math.max(0, st.scores[p] + (a.score[p] || 0));
    st.sync = Math.max(0, st.sync + (a.score.sync || 0));
  }
  if (a.answer && st.g && (!a.answer.rid || st.g.rid === a.answer.rid)) {
    st.g.answers = { ...(st.g.answers || {}), [a.answer.slot]: a.answer.value };
    resolveAnswers(st);
  }
  if (a.loser) setPenalty(st, a.loser, a.seed || 'x');
  if (a.flash) setFlash(st, a.flash, a.seed);
  if (a.closePenalty) st.penalty = null;
  return st;
}

// ───────────── sincronización ─────────────
function save() { if (code) LS.set('enc:room:' + code, S); }

function dispatch(a) {
  if (isHost()) {
    S = reduce(S, a);
    commit();
  } else {
    S = reduce(S, a);
    save(); render();
    T && T.send({ t: 'act', from: myId, a });
  }
}
function commit() {
  S.seq++;
  save(); render();
  T && T.send({ t: 'state', from: myId, seq: S.seq, state: S });
}
function hello() { T && T.send({ t: 'hello', from: myId, seq: S.seq, state: S }); }

function onMsg(m) {
  if (!m || m.from === myId) return;
  present.add(m.from);
  if (m.t === 'hello') {
    synced = true;
    if (m.seq > S.seq || (m.seq === S.seq && m.from < myId)) { S = m.state; save(); render(); }
    else if (m.seq < S.seq) hello();
  } else if (m.t === 'state') {
    synced = true;
    if (!isHost() || m.seq > S.seq) { S = m.state; save(); render(); }
  } else if (m.t === 'act') {
    if (isHost()) { S = reduce(S, m.a); commit(); }
  } else if (m.t === 'stroke') {
    Draw.remote(m);
  } else if (m.t === 'clear') {
    Draw.clear(m.rid, false);
  }
  maybeJoin();
}

function setPresent(ids) {
  const before = present.size;
  present = new Set([...ids, myId]);
  if (present.size > before) hello();
  render();
}

function connect() {
  if (T) T.close();
  conn = 'connecting'; synced = false;
  if (isLocalMode()) T = localTransport(code);
  else T = supabaseTransport(code);
  setTimeout(() => { synced = true; maybeJoin(); render(); }, 1600);
}

function supabaseTransport(c) {
  const client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { realtime: { params: { eventsPerSecond: 40 } } });
  const ch = client.channel('enc-' + c, { config: { broadcast: { self: false }, presence: { key: myId } } });
  ch.on('broadcast', { event: 'msg' }, ({ payload }) => onMsg(payload));
  ch.on('presence', { event: 'sync' }, () => setPresent(Object.keys(ch.presenceState())));
  ch.subscribe(async status => {
    if (status === 'SUBSCRIBED') { conn = 'ok'; await ch.track({ at: Date.now() }); hello(); render(); }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { conn = 'off'; render(); setTimeout(() => { if (conn === 'off') connect(); }, 3000); }
  });
  return {
    send: m => ch.send({ type: 'broadcast', event: 'msg', payload: m }),
    close: () => { try { client.removeChannel(ch); } catch {} }
  };
}

function localTransport(c) {
  const bc = new BroadcastChannel('enc-' + c);
  const seen = {};
  bc.onmessage = e => { if (e.data.from) seen[e.data.from] = Date.now(); onMsg(e.data); };
  const beat = setInterval(() => {
    bc.postMessage({ t: 'ping', from: myId });
    const now = Date.now();
    const ids = Object.keys(seen).filter(k => now - seen[k] < 5000);
    const same = ids.length + 1 === present.size && ids.every(i => present.has(i));
    if (!same) setPresent(ids);
  }, 1000);
  conn = 'ok';
  setTimeout(() => { bc.postMessage({ t: 'ping', from: myId }); hello(); }, 50);
  return { send: m => bc.postMessage(m), close: () => { clearInterval(beat); bc.close(); } };
}

function maybeJoin() {
  if (!code || !synced) return;
  const name = LS.get('enc:name', '');
  if (!name || mySlot()) return;
  let slot = null;
  if (!S.players.p1) slot = 'p1';
  else if (!S.players.p2) slot = 'p2';
  if (slot) dispatch({ players: { [slot]: { id: myId, name } } });
}

function enterRoom(c) {
  code = c.toUpperCase();
  S = LS.get('enc:room:' + code, null) || fresh();
  present = new Set([myId]);
  if (roomFromUrl() !== code) history.pushState({}, '', '/s/' + code + keepQs());
  connect();
  render();
}
function leaveRoom() {
  T && T.close(); T = null; code = null; S = fresh();
  history.pushState({}, '', '/' + keepQs());
  ui.modal = null; render();
}

// ───────────── selección de contenido ─────────────
function pick(key, len) {
  const used = S.used[key] || [];
  let pool = [];
  for (let i = 0; i < len; i++) if (!used.includes(i)) pool.push(i);
  if (!pool.length) pool = [...Array(len).keys()];
  const idx = pool[rnd(pool.length)];
  return { idx, used: [key, idx, len] };
}

function pickFrom(key, pool) {
  const used = S.used[key] || [];
  let free = pool.filter(i => !used.includes(i));
  if (!free.length) free = pool;
  const idx = free[rnd(free.length)];
  return { idx, used: [key, idx, pool.length] };
}

const ICONS = {
  cards: '<rect x="3" y="6" width="11" height="15" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v13"/>',
  mask: '<circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01"/><path d="M8 14.5c1.2 1.4 2.5 2 4 2s2.8-.6 4-2"/>',
  mute: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/><path d="M9 9l6 6"/>',
  pencil: '<path d="M4 20l4-1L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>',
  people: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2.5 20c0-3 2.4-5 5.5-5s5.5 2 5.5 5"/><path d="M13.5 15.3c.8-.2 1.6-.3 2.5-.3 3.1 0 5.5 2 5.5 5"/>',
  scale: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-3 6a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  wave: '<path d="M2 10c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/><path d="M2 17c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>',
  truths: '<path d="M3 7l2 2 4-4"/><path d="M3 16l2 2 4-4"/><path d="M15 6l6 6M21 6l-6 6"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  bars: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  candle: '<path d="M9 21V10h6v11"/><path d="M12 10V8"/><path d="M12 2.5c1.3 1.4 1.6 2.6 0 4.3-1.6-1.7-1.3-2.9 0-4.3z"/><path d="M6 21h12"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  flame: '<path d="M12 21c-3.9 0-7-2.8-7-6.5 0-3.3 2.5-5.4 4-8 .6 2 1.6 3 3 3 0-2 1-4.5 3-6.5.5 3 4 6 4 10.5 0 4.2-3.1 7.5-7 7.5z"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.6 6.6C4.2 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  book: '<path d="M3 5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16a2 2 0 0 0-2-2H3z"/><path d="M21 5a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v16a2 2 0 0 1 2-2h7z"/>',
  tiles: '<rect x="3" y="5" width="5" height="14" rx="1"/><rect x="9.5" y="5" width="5" height="14" rx="1"/><rect x="16" y="5" width="5" height="14" rx="1"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 21h8M10 17h4"/>',
  shuffle: '<path d="M4 7h3l10 10h3M4 17h3l3-3M14 10l3-3h3"/><path d="M18 5l2 2-2 2M18 15l2 2-2 2"/>',
  glass: '<path d="M7 3h10l-1 8a4 4 0 0 1-8 0z"/><path d="M12 15v6M8 21h8"/>',
  burst: '<path d="M12 2l2 6 6-2-3 5 5 3-6 1 1 6-5-4-5 4 1-6-6-1 5-3-3-5 6 2z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  utensils: '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5M17 21V3c-2 1-3 4-3 8h3"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/>',
  tv: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 3l4 3 4-3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  plane: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  gamepad: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 12.5h4M9 10.5v4"/><circle cx="16" cy="11.5" r="1" fill="currentColor"/><circle cx="18" cy="14" r="1" fill="currentColor"/>',
  shirt: '<path d="M8 3L3 6l2 5 3-1v11h8V10l3 1 2-5-5-3a4 4 0 0 1-8 0z"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  letter: '<path d="M5 20L11 4h2l6 16M8 14h8"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>',
  dict: '<path d="M5 4a2 2 0 0 1 2-2h12v17H7a2 2 0 0 0-2 2z"/><path d="M5 21V4M9 7h6M9 11h4"/>',
  chat: '<path d="M4 5h11v8H8l-4 3z"/><path d="M15 9h5v8l-3-2h-6v-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const flames = n => Array.from({ length: n }, () => ic('flame')).join('');
const CAT_ICON = { nosotros: 'heart', absurdas: 'spark', profundas: 'moon', coquetas: 'flame', retos: 'target', adiviname: 'eye', imagina: 'cloud', duelo: 'trophy' };
const CUPON_ICON = ['film', 'calendar', 'utensils', 'music', 'mail', 'sun', 'tv', 'mic', 'plane', 'gamepad', 'shirt', 'sparkle'];

// ───────────── juegos ─────────────
const GAMES = {
  cartas: { name: 'Cartas', icon: 'cards', blurb: 'Ocho barajas para hablar, reír y competir' },
  mimica: { name: 'Mímica', icon: 'mask', blurb: 'Actúa contra el cronómetro. Solo tú ves la palabra' },
  tabu: { name: 'Palabra prohibida', icon: 'mute', blurb: 'Descríbela sin decir las palabras vetadas' },
  dibujo: { name: 'Dibuja y adivina', icon: 'pencil', blurb: '2 minutos para adivinar todos los dibujos que puedan' },
  quien: { name: '¿Quién de los dos?', icon: 'people', blurb: 'Señalen en secreto y revelen a la vez' },
  prefieres: { name: '¿Qué prefieres?', icon: 'scale', blurb: 'Elige tú y adivina lo que elegirá el otro' },
  miradas: { name: 'Duelo de miradas', icon: 'eye', blurb: 'Pierde quien se ría primero' },
  conoces: { name: '¿Cuánto me conoces?', icon: 'search', blurb: 'Uno responde, el otro adivina' },
  onda: { name: 'En la misma onda', icon: 'wave', blurb: 'Del 1 al 10, ¿qué tan sincronizados están?' },
  verdades: { name: 'Dos verdades y una mentira', icon: 'truths', blurb: 'Descubre cuál es la mentira' },
  dato: { name: '¿Real o inventado?', icon: 'flask', blurb: 'Historia, lengua, ciencia… ¿verdad o mentira?' },
  mas: { name: '¿Qué es más?', icon: 'bars', blurb: 'Dos opciones, una sola correcta' },
  profundas: { name: 'Preguntas profundas', icon: 'candle', blurb: 'Modo tranquilo, sin puntos' },
  sabanas: { name: 'Entre sábanas', icon: 'moon', blurb: '¿Cuánto me conoces?, versión picante' },
  sinfiltro: { name: 'Sin filtro', icon: 'flame', blurb: 'Tres niveles de picante' },
  yonunca: { name: 'Yo nunca nunca', icon: 'eyeoff', blurb: 'Confiesen a la vez' },
  dado: { name: 'Dado coqueto', icon: 'dice', blurb: 'Una acción, un tema, a cámara' },
  retos: { name: 'Retos', icon: 'target', blurb: 'Hazlo o paga penitencia' },
  historia: { name: 'Historia a dos voces', icon: 'book', blurb: 'Un cuento frase por frase, con palabras rarísimas' },
  letra: { name: 'Cadena de letras', icon: 'letter', blurb: 'Una letra, una categoría y cada vez menos tiempo' },
  encadenada: { name: 'Palabra encadenada', icon: 'link', blurb: 'Cada palabra empieza con la última sílaba' },
  experto: { name: 'Experto en nada', icon: 'cap', blurb: 'Una charla seria sobre un tema absurdo' },
  diccionario: { name: 'Diccionario mentiroso', icon: 'dict', blurb: 'Palabras raras: ¿definición real o inventada?' },
  improv: { name: 'Sí, y además…', icon: 'chat', blurb: 'Improvisen una escena sin trabarse' },
  traductor: { name: 'Traductor', icon: 'globe', blurb: 'Uno habla en idioma inventado, el otro traduce' },
  entrevista: { name: 'Entrevista desde el futuro', icon: 'mic', blurb: 'Año 2045: todo el mundo te conoce por algo rarísimo' }
};
const GROUPS = [
  { id: 'improvisar', t: 'Improvisar', keys: ['letra', 'encadenada', 'historia', 'experto', 'improv', 'traductor', 'entrevista'] },
  { id: 'reir', t: 'Para reír', keys: ['mimica', 'tabu', 'dibujo', 'quien', 'prefieres'] },
  { id: 'nonos', t: 'Ñoños', keys: ['dato', 'mas', 'diccionario'] },
  { id: 'conocernos', t: 'Conocernos', keys: ['conoces', 'onda', 'verdades', 'profundas'] },
  { id: 'picante', t: 'Picante', keys: ['sabanas', 'sinfiltro', 'yonunca', 'dado', 'retos'] }
];

const CARD_CATS = Object.keys(D.cartas);

function startGame(k) {
  const turn = mySlot() || 'p1';
  const base = { k, rid: rid(), turn };
  switch (k) {
    case 'cartas': return { screen: 'game', g: { ...base, cat: null } };
    case 'sinfiltro': return { screen: 'game', g: { ...base, lvl: null } };
    case 'yonunca': return { screen: 'game', g: { ...base, lvl: null } };
    case 'dibujo': return { screen: 'game', g: { ...base, phase: 'cat', drawer: turn } };
    case 'mimica': return { screen: 'game', g: { ...base, phase: 'ready', actor: turn, dur: 60 } };
    case 'tabu': return { screen: 'game', g: { ...base, phase: 'ready', actor: turn } };
    case 'miradas': return { screen: 'game', g: { ...base, phase: 'ready' } };
    case 'historia': {
      const o = pick('hist-o', D.historia.inicios.length), w = pick('hist-w', D.historia.palabras.length);
      return { screen: 'game', used: o.used, g: { ...base, open: o.idx, word: w.idx, lines: [] } };
    }
    case 'dado': return { screen: 'game', g: { ...base, a: null, t: null } };
    case 'dato': return { screen: 'game', g: { ...base, cat: null, mode: null } };
    case 'letra': case 'encadenada': return { screen: 'game', g: { ...base, phase: 'setup', speed: 6 } };
    case 'experto': { const p = pick('exp', D.experto.length); return { screen: 'game', used: p.used, g: { ...base, phase: 'ready', idx: p.idx } }; }
    case 'diccionario': return { screen: 'game', g: { ...base, deck: null, answers: {} } };
    case 'improv': return { screen: 'game', g: { ...base, phase: 'ready', q: rnd(D.improv.quienes.length), d: rnd(D.improv.donde.length), p: rnd(D.improv.problema.length) } };
    case 'traductor': { const p = pick('trad', D.traductor.length); return { screen: 'game', used: p.used, g: { ...base, phase: 'ready', idx: p.idx } }; }
    case 'entrevista': { const p = pick('fut', D.futuro.length); return { screen: 'game', used: p.used, g: { ...base, idx: p.idx, qs: shuffle([...Array(D.entrevistas.length).keys()]).slice(0, 4) } }; }
    default: return nextRound(k, turn);
  }
}

// Nueva ronda para juegos de "una tarjeta por ronda"
function nextRound(k, turn) {
  const g0 = S.g || {};
  const t = turn || other(g0.turn || (mySlot() || 'p2'));
  const r = rid();
  switch (k) {
    case 'quien': { const p = pick('quien', D.quien.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, answers: {} } }; }
    case 'profundas': { const p = pick('prof', D.profundas.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, turn: t } }; }
    case 'retos': { const p = pick('retos', D.retos.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, turn: t } }; }
    case 'prefieres': { const p = pick('pref', D.prefieres.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, answers: {} } }; }
    case 'conoces': { const p = pick('conoces', D.conoces.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, turn: t, answers: {} } }; }
    case 'sabanas': { const p = pick('sabanas', D.sabanas.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, turn: t, answers: {} } }; }
    case 'onda': { const p = pick('onda', D.onda.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, answers: {} } }; }
    case 'verdades': { const p = pick('verd', D.verdades.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, turn: t } }; }
    case 'dato': {
      const pool = D.datos.map((x, i) => i).filter(i => !g0.cat || g0.cat === 'mezcla' || D.datos[i].c === g0.cat);
      const p = pickFrom('dato-' + (g0.cat || 'mezcla'), pool);
      return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, cat: g0.cat || 'mezcla', mode: g0.mode || 'ambos', turn: t, answers: {} } };
    }
    case 'mas': { const p = pick('mas', D.mas.length); return { screen: 'game', used: p.used, g: { k, rid: r, idx: p.idx, turn: t, answers: {} } }; }
  }
}

function drawCard(cat) {
  const g0 = S.g || {};
  const cc = cat === 'mezcla' ? CARD_CATS[rnd(CARD_CATS.length)] : cat;
  const deck = D.cartas[cc];
  const p = pick('c-' + cc, deck.cards.length);
  const turn = other(g0.turn || mySlot() || 'p2');
  return { used: p.used, g: { k: 'cartas', rid: rid(), cat, cc, idx: p.idx, type: deck.type || 'charla', turn, answers: {} } };
}

// ───────────── vistas ─────────────
function rings(big) {
  const p1 = S.players.p1, p2 = S.players.p2;
  const on = s => S.players[s] && present.has(S.players[s].id);
  if (big) {
    return `<div class="rings rings--hero" aria-hidden="true"><span class="ring ring--a"></span><span class="ring ring--b"></span></div>`;
  }
  const side = (slot, pl, cls) => `
    <div class="sb-p ${cls} ${mySlot() === slot ? 'is-me' : ''}">
      <span class="sb-name">${pl ? nm(slot) : 'Esperando…'}${pl && !on(slot) ? '<i class="off-dot" title="Desconectado"></i>' : ''}</span>
      <span class="sb-pts">${S.scores[slot]}</span>
    </div>`;
  if (S.screen === 'game') {
    return `
  <div class="scorebar" role="group" aria-label="Marcador">
    <span class="sbb sbb--a ${mySlot() === 'p1' ? 'is-me' : ''}"><span class="sbb-n">${p1 ? nm('p1') : 'Esperando…'}</span><b>${S.scores.p1}</b></span>
    <span class="sbb-sync">${ic('heart')}<b>${S.sync}</b></span>
    <span class="sbb sbb--b ${mySlot() === 'p2' ? 'is-me' : ''}"><b>${S.scores.p2}</b><span class="sbb-n">${p2 ? nm('p2') : 'Esperando…'}</span></span>
  </div>`;
  }
  return `
  <div class="scoreboard" role="group" aria-label="Marcador">
    ${side('p1', p1, 'sb-p--a')}
    <div class="sb-sync" title="Sintonía: puntos que suman juntos">${ic('heart')}<b>${S.sync}</b><small>sintonía</small></div>
    ${side('p2', p2, 'sb-p--b')}
  </div>`;
}

function viewLanding() {
  const name = ui.drafts.name ?? LS.get('enc:name', '');
  return `
  <main class="landing">
    ${rings(true)}
    <h1 class="title">Encontrándonos</h1>
    <p class="tagline">Dos personas. Una videollamada. Cero excusas.</p>
    <div class="panel form">
      <label class="field">
        <span>Tu nombre</span>
        <input id="in-name" data-draft="name" value="${esc(name)}" maxlength="18" autocomplete="given-name" placeholder="¿Cómo te llamas?">
      </label>
      <button class="btn btn--gold" data-a="create">Crear sala</button>
      <div class="or"><span>o entra con un código</span></div>
      <div class="row">
        <input id="in-code" data-draft="code" value="${esc(ui.drafts.code || '')}" maxlength="12" placeholder="LUNA-42" autocapitalize="characters">
        <button class="btn btn--ghost" data-a="joincode">Entrar</button>
      </div>
      ${ui.err ? `<p class="err">${esc(ui.err)}</p>` : ''}
    </div>
    <p class="fine">Crea la sala, comparte el enlace y jueguen cada uno desde su teléfono.</p>
  </main>`;
}

function viewJoin() {
  const name = ui.drafts.name ?? LS.get('enc:name', '');
  const full = S.players.p1 && S.players.p2;
  const takers = full ? ['p1', 'p2'].map(s => `<button class="btn btn--ghost" data-a="takeslot" data-s="${s}">Soy ${nm(s)}</button>`).join('') : '';
  return `
  <main class="landing">
    ${rings(true)}
    <h1 class="title">Encontrándonos</h1>
    <p class="tagline">Te invitaron a la sala <b>${esc(code)}</b>.</p>
    <div class="panel form">
      ${full ? `<p class="lead">Esta sala ya tiene a ${nm('p1')} y ${nm('p2')}. ¿Quién eres?</p><div class="stack">${takers}</div>` : `
      <label class="field"><span>Tu nombre</span>
        <input id="in-name" data-draft="name" value="${esc(name)}" maxlength="18" placeholder="¿Cómo te llamas?"></label>
      <button class="btn btn--gold" data-a="join">Entrar a la sala</button>`}
      ${ui.err ? `<p class="err">${esc(ui.err)}</p>` : ''}
    </div>
    <button class="link" data-a="leave">Salir</button>
  </main>`;
}

function topbar() {
  const me = mySlot(); const o = me && other(me);
  const otherOn = o && S.players[o] && present.has(S.players[o].id);
  let status = '';
  if (conn === 'off') status = '<span class="st st--off">Reconectando…</span>';
  else if (!S.players[o]) status = '<span class="st">Esperando a tu pareja</span>';
  else status = otherOn ? `<span class="st st--on">${nm(o)} está aquí</span>` : `<span class="st">${nm(o)} no está conectado</span>`;
  return `
  <header class="top">
    <button class="chip" data-a="share" title="Compartir enlace de la sala">${esc(code)} ${ic('share')}</button>
    ${status}
    <button class="icon-btn" data-a="menu" aria-label="Menú">${ic('more')}</button>
  </header>`;
}

function viewHome() {
  const tab = ui.tab || 'improvisar';
  const gr = GROUPS.find(x => x.id === tab) || GROUPS[0];
  const tile = k => `<button class="tile" data-a="start" data-k="${k}">${ic(GAMES[k].icon, 'ic--tile')}<b>${GAMES[k].name}</b><small>${GAMES[k].blurb}</small></button>`;
  const soon = tab === 'reir' ? `<div class="tile tile--soon">${ic('tiles', 'ic--tile')}<b>Rummikub</b><small>Próximamente</small></div>` : '';
  return `
  <section class="home">
    <button class="feature" data-a="start" data-k="cartas">
      <span class="f-deck" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="f-tx"><b>Cartas</b><small>Ocho barajas para hablar, reír y competir.</small></span>
    </button>
    <nav class="tabs" aria-label="Tipos de juego">${GROUPS.map(g => `<button class="tab ${g.id === tab ? 'is-on' : ''}" data-a="tab" data-v="${g.id}">${g.t}</button>`).join('')}</nav>
    <div class="tiles">${gr.keys.map(tile).join('')}${soon}</div>
    <button class="btn btn--line wide" data-a="finish">Terminar la noche</button>
  </section>`;
}

const back = (label = 'Juegos') => `<button class="back" data-a="home">← ${label}</button>`;
const gameHead = (k, extra = '') => `<div class="ghead">${back()}<h2>${ic(GAMES[k].icon, 'ic--head')} ${GAMES[k].name}</h2>${extra}</div>`;

// Revelación con cuenta regresiva
function revealState(g) {
  if (!g.resolved) return 'wait';
  const key = g.rid;
  if (!ui.reveal[key]) ui.reveal[key] = Date.now();
  const t = Date.now() - ui.reveal[key];
  if (t < 2700) { needTick = true; return { count: t < 800 ? '3' : t < 1600 ? '2' : t < 2300 ? '1' : '¡Revelen!' }; }
  return 'shown';
}
const countdownHtml = rs => `<div class="countdown"><span>${rs.count}</span></div>`;

function waitingFor(g) {
  const me = mySlot(), o = other(me);
  const mine = g.answers?.[me] !== undefined, theirs = g.answers?.[o] !== undefined;
  if (mine && !theirs) return `<p class="wait">Listo. Esperando a ${nm(o)}…</p>`;
  if (!mine && theirs) return `<p class="hint">${nm(o)} ya eligió.</p>`;
  return '';
}

function viewGame() {
  const g = S.g; if (!g) return viewHome();
  const fn = V[g.k];
  return fn ? fn(g) : viewHome();
}

const V = {};

// CARTAS
V.cartas = g => {
  if (!g.cat) {
    const cats = CARD_CATS.map(c => `<button class="cat" data-a="cat" data-c="${c}">${ic(CAT_ICON[c], 'ic--cat')}<b>${D.cartas[c].name}</b><small>${D.cartas[c].blurb}</small></button>`).join('');
    return `${gameHead('cartas')}<p class="lead">Elige una baraja.</p><div class="cats">${cats}<button class="cat cat--mix" data-a="cat" data-c="mezcla">${ic('shuffle', 'ic--cat')}<b>Mezcla</b><small>Una carta de cualquier baraja</small></button></div>`;
  }
  if (g.idx === undefined) return `${gameHead('cartas')}<div class="center"><button class="btn btn--gold big" data-a="draw">Robar carta</button></div>`;
  const deck = D.cartas[g.cc], card = deck.cards[g.idx];
  const me = mySlot();
  let body = '', actions = '';
  if (g.type === 'adivina') {
    const target = g.turn, guesser = other(target);
    const rs = revealState(g);
    const opts = card.a.map(o => `<button class="opt ${g.answers?.[me] === o ? 'is-on' : ''}" data-a="answer" data-v="${esc(o)}" ${g.answers?.[me] !== undefined ? 'disabled' : ''}>${esc(o)}</button>`).join('');
    const ask = me === target ? `Responde por ti, ${nm(me)}. En secreto.` : `¿Qué elegirá ${nm(target)}?`;
    if (rs === 'wait') body = `<p class="who">${ask}</p><div class="opts">${opts}</div>${waitingFor(g)}`;
    else if (rs.count) body = countdownHtml(rs);
    else body = `<div class="reveal"><div><small>${nm(target)} eligió</small><b>${esc(g.answers[target])}</b></div><div><small>${nm(guesser)} dijo</small><b>${esc(g.answers[guesser])}</b></div></div>
      <p class="verdict">${g.resolved.ok ? `${nm(guesser)} te conoce bien. +1` : 'No coincidieron.'}</p>`;
    return cardShell(deck, card.q, body, cardNav());
  }
  if (g.type === 'reto') {
    body = `<p class="who">Reto para ${nm(g.turn)}</p>`;
    actions = g.done ? `<p class="verdict">${esc(g.done)}</p>` : `<div class="duo"><button class="btn btn--gold" data-a="win" data-s="${g.turn}" data-msg="${nm(g.turn)} cumplió el reto. +1">Lo hizo · +1</button><button class="btn btn--line" data-a="lose" data-s="${g.turn}">Se negó</button></div>`;
  } else if (g.type === 'duelo') {
    body = `<p class="who">¿Quién ganó?</p>`;
    actions = g.done ? `<p class="verdict">${esc(g.done)}</p>` : `<div class="trio"><button class="btn btn--gold" data-a="duel" data-s="p1">Gana ${nm('p1')}</button><button class="btn btn--wine" data-a="duel" data-s="p2">Gana ${nm('p2')}</button><button class="btn btn--line" data-a="duel" data-s="tie">Empate</button></div>`;
  } else {
    body = `<p class="who">Responde ${nm(g.turn)}</p><button class="link" data-a="flipturn">Ahora responde ${nm(other(g.turn))}</button>`;
  }
  return cardShell(deck, card, body + actions, cardNav());
};
const cardNav = () => `<div class="nav"><button class="btn btn--gold" data-a="draw">Nueva carta</button><button class="btn btn--line" data-a="cats">Volver a categorías</button></div>`;
function cardShell(deck, text, body, nav) {
  return `${gameHead('cartas')}
  <article class="card" data-rid="${S.g.rid}">
    <span class="card-cat">${esc(deck.name)}</span>
    <p class="card-q">${esc(text)}</p>
    <div class="card-body">${body}</div>
  </article>${nav}`;
}

// ¿QUIÉN DE LOS DOS?
V.quien = g => {
  const me = mySlot(), o = other(me);
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    const mine = g.answers?.[me];
    body = `<div class="opts"><button class="opt ${mine === me ? 'is-on' : ''}" data-a="answer" data-v="${me}" ${mine ? 'disabled' : ''}>Yo</button><button class="opt ${mine === o ? 'is-on' : ''}" data-a="answer" data-v="${o}" ${mine ? 'disabled' : ''}>Mi pareja</button></div>${waitingFor(g)}`;
  } else if (rs.count) body = countdownHtml(rs);
  else {
    const say = s => (g.answers[s] === s ? `${nm(s)} se señaló a sí mismo` : `${nm(s)} señaló a ${nm(g.answers[s])}`);
    body = `<p class="verdict big">${g.resolved.same ? '¡Coincidieron!' : 'Tenemos opiniones diferentes'}</p><p class="detail">${say('p1')}.<br>${say('p2')}.</p>`;
  }
  return `${gameHead('quien')}<article class="card"><p class="card-q">${esc(D.quien[g.idx])}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Otra pregunta</button></div>`;
};

// PREGUNTAS PROFUNDAS
V.profundas = g => `${gameHead('profundas')}
  <article class="card card--calm"><p class="card-q">${esc(D.profundas[g.idx])}</p>
  <div class="card-body"><p class="who">Responde ${nm(g.turn)}</p></div></article>
  <div class="nav"><button class="btn btn--line" data-a="flipturn">Responder: ahora ${nm(other(g.turn))}</button><button class="btn btn--gold" data-a="next">Otra pregunta</button></div>`;

// SIN FILTRO
V.sinfiltro = g => {
  if (!g.lvl) return `${gameHead('sinfiltro')}<p class="lead">Elijan el nivel. Se puede cambiar cuando quieran.</p><div class="levels">${[1, 2, 3].map(l => `<button class="level" data-a="lvl" data-l="${l}"><span class="flames">${flames(l)}</span><b>${D.sinfiltro[l].name}</b></button>`).join('')}</div>`;
  const lv = D.sinfiltro[g.lvl];
  return `${gameHead('sinfiltro', `<button class="chip" data-a="lvlreset">${flames(g.lvl)} ${lv.name}</button>`)}
  <article class="card card--hot"><p class="card-q">${esc(lv.cards[g.idx])}</p><div class="card-body"><p class="who">Responde ${nm(g.turn)}</p>${g.done ? `<p class="verdict">${esc(g.done)}</p>` : ''}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="sfnext">Otra pregunta</button><button class="btn btn--line" data-a="lose" data-s="${g.turn}" ${g.done ? 'disabled' : ''}>Me la salto</button></div>`;
};

// RETOS
V.retos = g => `${gameHead('retos')}
  <article class="card"><span class="card-cat">Reto para ${nm(g.turn)}</span><p class="card-q">${esc(D.retos[g.idx])}</p>
  <div class="card-body">${g.done ? `<p class="verdict">${esc(g.done)}</p>` : `<div class="duo"><button class="btn btn--gold" data-a="win" data-s="${g.turn}" data-msg="${nm(g.turn)} cumplió. +1">Lo hizo · +1</button><button class="btn btn--line" data-a="lose" data-s="${g.turn}">Se negó</button></div>`}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Otro reto</button></div>`;

// DIBUJA Y ADIVINA: rondas de 2 minutos, todos los dibujos que puedan
const DRAW_SECS = 120;
V.dibujo = g => {
  const me = mySlot();
  const drawer = g.drawer, guesser = other(drawer);
  if (g.phase === 'cat') {
    return `${gameHead('dibujo')}<p class="lead">Dibuja <b>${nm(drawer)}</b>. Tienen 2 minutos: cada dibujo que ${nm(guesser)} adivine suma un punto. ${me === drawer ? 'Elige una categoría: las palabras solo aparecen en tu pantalla.' : `${nm(drawer)} está eligiendo la categoría.`}</p>
    ${me === drawer ? `<div class="cats cats--tight">${Object.keys(D.dibujo).map(c => `<button class="cat" data-a="dcat" data-c="${c}"><b>${D.dibujo[c].name}</b></button>`).join('')}</div>` : ''}`;
  }
  if (g.phase === 'end') {
    return `${gameHead('dibujo')}<article class="card"><p class="card-q">${nm(guesser)} adivinó ${g.got} ${g.got === 1 ? 'dibujo' : 'dibujos'}</p>
    <div class="card-body"><p class="detail">${g.got ? `+${g.got} para ${nm(guesser)}${S.settings.drawBonus ? ` y +${g.got} para ${nm(drawer)}` : ''}.` : 'Ningún dibujo adivinado esta vez.'}</p>
    <button class="btn btn--gold" data-a="dnext">Siguiente: dibuja ${nm(guesser)}</button></div></article>`;
  }
  const word = D.dibujo[g.cat].words[g.list[g.pos]];
  const left = timeLeft(g.round, DRAW_SECS);
  const top = me === drawer
    ? `<div class="secret"><small>Dibujo ${g.pos + 1} · llevan ${g.got}</small><b>${esc(word)}</b></div>`
    : `<div class="secret secret--hidden"><small>${nm(drawer)} dibuja · llevas ${g.got}</small><b>${esc(D.dibujo[g.cat].name)}</b></div>`;
  const tools = me === drawer ? `<div class="tools">${['#F3E7D3', '#D6B06A', '#C24D5C', '#7FA7C9'].map(c => `<button class="sw" style="--c:${c}" data-a="color" data-c="${c}" aria-label="Color"></button>`).join('')}<button class="chip" data-a="clear">Borrar</button></div>` : '';
  const foot = me === drawer
    ? `<div class="duo"><button class="btn btn--gold" data-a="dok">¡Adivinó!</button><button class="btn btn--line" data-a="dpass">Pasar</button></div>`
    : `<div class="nav"><button class="btn btn--gold" data-a="dok">¡Adiviné!</button></div>`;
  return `${gameHead('dibujo', timerHtml(left))}${top}<div class="canvas-wrap" id="canvas-slot"></div>${tools}${foot}`;
};

// MÍMICA y PALABRA PROHIBIDA
function viewActing(g) {
  const me = mySlot(), actor = g.actor, guesser = other(actor);
  const isTabu = g.k === 'tabu';
  const verb = isTabu ? 'describir' : 'actuar';
  if (g.phase === 'ready') {
    return `${gameHead(g.k)}<article class="card card--calm"><p class="card-q">Le toca ${verb} a ${nm(actor)}</p>
    <div class="card-body"><p class="detail">${isTabu ? 'Describe cada palabra sin decirla ni usar las cinco palabras prohibidas.' : 'Actúa cada palabra sin hablar ni hacer sonidos.'} Tienes 60 segundos para que ${nm(guesser)} adivine todas las que pueda.</p>
    ${me === actor ? '<button class="btn btn--gold big" data-a="actstart">Empezar</button>' : `<p class="wait">Esperando a que ${nm(actor)} empiece…</p>`}</div></article>`;
  }
  if (g.phase === 'end') {
    return `${gameHead(g.k)}<article class="card"><p class="card-q">${nm(guesser)} adivinó ${g.got} ${g.got === 1 ? 'palabra' : 'palabras'}</p>
    <div class="card-body"><p class="detail">${g.got ? `+${g.got} para ${nm(guesser)}.` : 'Nadie sumó esta vez.'}</p><button class="btn btn--gold" data-a="actnext">Siguiente turno: ${nm(guesser)}</button></div></article>`;
  }
  const left = timeLeft(g.rid, 60);
  const item = isTabu ? D.tabu[g.list[g.pos]] : null;
  const word = isTabu ? item.w : D.mimica[g.list[g.pos]];
  if (me === actor) {
    return `${gameHead(g.k, timerHtml(left))}<article class="card card--word"><small class="card-cat">Palabra ${g.pos + 1}</small><p class="card-q huge">${esc(word)}</p>
    ${isTabu ? `<ul class="banned">${item.x.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </article><p class="hint center">Llevan ${g.got}</p><div class="duo"><button class="btn btn--gold" data-a="actgot">¡Adivinó!</button><button class="btn btn--line" data-a="actpass">Pasar</button></div>`;
  }
  return `${gameHead(g.k, timerHtml(left))}<article class="card card--calm"><p class="card-q">${nm(actor)} está ${isTabu ? 'describiendo' : 'actuando'}</p><div class="card-body"><p class="big-num">${g.got}</p><p class="detail">adivinadas</p></div></article>`;
}
V.mimica = g => {
  const me = mySlot(), actor = g.actor, guesser = other(actor);
  if (g.phase === 'ready') {
    const durs = [30, 60, 90].map(s => `<button class="pick ${g.dur === s ? 'is-on' : ''}" data-a="mimdur" data-v="${s}" ${me === actor ? '' : 'disabled'}>${s} s</button>`).join('');
    return `${gameHead('mimica')}<article class="card card--calm"><p class="card-q">Le toca actuar a ${nm(actor)}</p>
    <div class="card-body"><p class="detail">Solo ${nm(actor)} ve la palabra. Actúala sin hablar ni hacer sonidos; ${nm(guesser)} tiene hasta que se acabe el cronómetro.</p>
    <div class="picks">${durs}</div>
    ${me === actor ? '<button class="btn btn--gold big" data-a="mimstart">Ver palabra y empezar</button>' : `<p class="wait">Esperando a que ${nm(actor)} empiece…</p>`}</div></article>`;
  }
  const word = D.mimica[g.idx];
  if (g.phase === 'end') {
    return `${gameHead('mimica')}<article class="card"><p class="card-q">${g.ok ? `¡Adivinó en ${g.secs} s!` : g.res === 'pass' ? 'Se saltó la palabra' : '¡Tiempo! No adivinó'}</p>
    <div class="card-body"><p class="detail">La palabra era <b>${esc(word)}</b>.</p><button class="btn btn--gold" data-a="mimnext">Siguiente: actúa ${nm(guesser)}</button></div></article>`;
  }
  const left = timeLeft(g.rid, g.dur);
  const pct = Math.max(0, Math.min(100, (left / g.dur) * 100));
  const clock = `<div class="clock ${left <= 10 ? 'is-low' : ''}" style="--p:${pct}"><span>${left}</span><small>segundos</small></div>`;
  if (me === actor) {
    return `${gameHead('mimica')}<article class="card card--word"><small class="card-cat">Tu palabra, solo para ti</small><p class="card-q huge">${esc(word)}</p></article>
    ${clock}<div class="duo"><button class="btn btn--gold" data-a="mimok">¡Adivinó!</button><button class="btn btn--line" data-a="mimpass">Pasar</button></div>`;
  }
  return `${gameHead('mimica')}<p class="who center">${nm(actor)} está actuando. ¡Adivina!</p>${clock}<div class="nav"><button class="btn btn--gold big" data-a="mimok">¡Adiviné!</button></div>`;
};
V.tabu = viewActing;

// ¿QUÉ PREFIERES?
V.prefieres = g => {
  const me = mySlot(), o = other(me);
  const [A, B] = D.prefieres[g.idx];
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    if (g.answers?.[me]) body = waitingFor(g) || '<p class="wait">Listo.</p>';
    else {
      const d = ui.drafts['pref-' + g.rid] || {};
      const b = (field, v, label) => `<button class="opt ${d[field] === v ? 'is-on' : ''}" data-a="prefpick" data-f="${field}" data-v="${v}">${esc(label)}</button>`;
      body = `<p class="who">Tú prefieres…</p><div class="opts">${b('me', 'A', A)}${b('me', 'B', B)}</div>
      <p class="who">¿Y qué preferirá ${nm(o)}?</p><div class="opts">${b('guess', 'A', A)}${b('guess', 'B', B)}</div>
      <button class="btn btn--gold" data-a="prefsend" ${d.me && d.guess ? '' : 'disabled'}>Listo</button>${waitingFor(g)}`;
    }
  } else if (rs.count) body = countdownHtml(rs);
  else {
    const lab = v => (v === 'A' ? A : B);
    const r = g.resolved, a = g.answers;
    body = `<div class="reveal"><div><small>${nm('p1')} prefiere</small><b>${esc(lab(a.p1.me))}</b><em>${r.ok1 ? 'Adivinó a ' + nm('p2') + ' · +1' : 'No adivinó'}</em></div>
      <div><small>${nm('p2')} prefiere</small><b>${esc(lab(a.p2.me))}</b><em>${r.ok2 ? 'Adivinó a ' + nm('p1') + ' · +1' : 'No adivinó'}</em></div></div>
      ${r.same ? '<p class="verdict">Prefieren lo mismo. +1 a la sintonía</p>' : ''}`;
  }
  return `${gameHead('prefieres')}<article class="card"><p class="card-q">${esc(A)}<span class="vs">o</span>${esc(B)}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Otra</button></div>`;
};

// ¿CUÁNTO ME CONOCES?
V.sabanas = g => V.conoces(g);
V.conoces = g => {
  const me = mySlot(), subj = g.turn, guesser = other(subj);
  const q = (g.k === 'sabanas' ? D.sabanas : D.conoces)[g.idx];
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    if (g.answers?.[me] !== undefined) body = waitingFor(g);
    else {
      const label = me === subj ? 'Tu respuesta, en secreto' : `¿Qué crees que respondió ${nm(subj)}?`;
      body = `<label class="field"><span>${label}</span><input id="in-know" data-draft="know-${g.rid}" value="${esc(ui.drafts['know-' + g.rid] || '')}" maxlength="80" autocomplete="off"></label>
      <button class="btn btn--gold" data-a="knowsend">Listo</button>${waitingFor(g)}`;
    }
  } else if (rs.count) body = countdownHtml(rs);
  else {
    body = `<div class="reveal"><div><small>${nm(subj)} respondió</small><b>${esc(g.answers[subj])}</b></div><div><small>${nm(guesser)} dijo</small><b>${esc(g.answers[guesser])}</b></div></div>
    ${g.done ? `<p class="verdict">${esc(g.done)}</p>` : me === subj ? `<p class="who">¿Acertó?</p><div class="duo"><button class="btn btn--gold" data-a="win" data-s="${guesser}" data-msg="${nm(guesser)} acertó. +1">Acertó · +1</button><button class="btn btn--line" data-a="lose" data-s="${guesser}">Ni cerca</button></div>` : `<p class="wait">${nm(subj)} decide si acertaste.</p>`}`;
  }
  return `${gameHead(g.k)}<article class="card ${g.k === 'sabanas' ? 'card--hot' : ''}"><span class="card-cat">Pregunta ${nm(subj)}</span><p class="card-q">${esc(q)}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Siguiente pregunta</button></div>`;
};

// EN LA MISMA ONDA
V.onda = g => {
  const me = mySlot();
  const it = D.onda[g.idx];
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    if (g.answers?.[me] !== undefined) body = waitingFor(g);
    else {
      const v = ui.drafts['onda-' + g.rid] ?? 5;
      body = `<div class="scale"><span>${esc(it.l)}</span><b id="onda-val">${v}</b><span>${esc(it.r)}</span></div>
      <input type="range" min="1" max="10" step="1" value="${v}" data-draft="onda-${g.rid}" id="in-onda" class="range" aria-label="Valor del 1 al 10">
      <button class="btn btn--gold" data-a="ondasend">Fijar mi número</button>${waitingFor(g)}`;
    }
  } else if (rs.count) body = countdownHtml(rs);
  else {
    const a = g.answers, r = g.resolved;
    const pos = n => ((n - 1) / 9) * 100;
    body = `<div class="track"><span class="mk mk--a" style="left:${pos(a.p1)}%"><b>${a.p1}</b><small>${nm('p1')}</small></span><span class="mk mk--b" style="left:${pos(a.p2)}%"><b>${a.p2}</b><small>${nm('p2')}</small></span></div>
    <div class="scale scale--ends"><span>${esc(it.l)}</span><span>${esc(it.r)}</span></div>
    <p class="verdict">${r.d === 0 ? 'Misma onda exacta. +3 a la sintonía' : r.pts ? `A ${r.d} de distancia. +${r.pts} a la sintonía` : r.d >= 6 ? 'Universos paralelos. Discútanlo.' : `A ${r.d} de distancia. Sin puntos.`}</p>`;
  }
  return `${gameHead('onda')}<article class="card"><p class="card-q">${esc(it.q)}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Otra</button></div>`;
};

// DOS VERDADES Y UNA MENTIRA
V.verdades = g => {
  const teller = g.turn, guesser = other(teller);
  return `${gameHead('verdades')}<article class="card"><span class="card-cat">Tema</span><p class="card-q">${esc(D.verdades[g.idx])}</p>
  <div class="card-body"><p class="detail">${nm(teller)} cuenta tres cosas sobre este tema: dos verdaderas y una inventada. ${nm(guesser)} tiene que descubrir la mentira.</p>
  ${g.done ? `<p class="verdict">${esc(g.done)}</p>` : `<div class="duo"><button class="btn btn--gold" data-a="win" data-s="${guesser}" data-msg="${nm(guesser)} descubrió la mentira. +1">${nm(guesser)} la descubrió</button><button class="btn btn--wine" data-a="fool">${nm(teller)} engañó</button></div>`}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Siguiente: cuenta ${nm(guesser)}</button></div>`;
};

// ¿REAL O INVENTADO? y ¿QUÉ ES MÁS?
function viewQuiz(g) {
  const me = mySlot();
  const isDato = g.k === 'dato';
  const it = isDato ? D.datos[g.idx] : D.mas[g.idx];
  const turnos = g.mode === 'turnos';
  const opts = isDato ? [['real', 'Real'], ['falso', 'Inventado']] : [['a', it.a], ['b', it.b]];
  const label = v => (opts.find(o => o[0] === v) || [, ''])[1];
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    const mine = g.answers?.[me];
    if (turnos && me !== g.turn) {
      body = `<p class="who">Responde ${nm(g.turn)}. Tú lee la tarjeta en voz alta.</p>${g.answers?.[g.turn] !== undefined ? `<p class="wait">${nm(g.turn)} ya respondió.</p>` : ''}`;
    } else {
      body = `${turnos ? `<p class="who">Te toca, ${nm(me)}.</p>` : ''}<div class="opts">${opts.map(([v, l]) => `<button class="opt ${mine === v ? 'is-on' : ''}" data-a="answer" data-v="${v}" ${mine ? 'disabled' : ''}>${esc(l)}</button>`).join('')}</div>${turnos ? '' : waitingFor(g)}`;
    }
  } else if (rs.count) body = countdownHtml(rs);
  else {
    const r = g.resolved;
    const who = turnos ? [g.turn] : ['p1', 'p2'];
    const say = s => `${nm(s)}: ${esc(label(g.answers[s]))} ${(s === 'p1' ? r.ok1 : r.ok2) ? '· +1' : '✗'}`;
    const head = isDato ? (it.real ? 'Es real' : 'Es inventado') : esc(label(it.ok));
    body = `<p class="verdict big">${head}</p><p class="detail">${esc(it.e)}</p><p class="detail small">${who.map(say).join('<br>')}</p>`;
  }
  const chip = isDato ? `<button class="chip" data-a="datoreset">${g.cat === 'mezcla' ? 'Mezcla' : esc(D.datoCats[g.cat])}${turnos ? ' · por turnos' : ''}</button>` : '';
  const q = isDato ? esc(it.t) : `${esc(it.q)}<span class="vs-pair"><span>${esc(it.a)}</span><i>o</i><span>${esc(it.b)}</span></span>`;
  return `${gameHead(g.k, chip)}<article class="card">${isDato ? `<span class="card-cat">${esc(D.datoCats[it.c])}</span>` : ''}<p class="card-q">${q}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">${isDato ? 'Otro dato' : 'Otra'}</button></div>`;
}
V.dato = g => {
  if (g.cat && g.mode) return viewQuiz(g);
  const cat = ui.drafts.datoCat || 'mezcla', mode = ui.drafts.datoMode || 'ambos';
  const chip = (v, l) => `<button class="pick ${cat === v ? 'is-on' : ''}" data-a="datocat" data-v="${v}">${l}</button>`;
  return `${gameHead('dato')}<p class="lead">Tarjetas para aprender y apostar: ¿el dato es real o inventado?</p>
  <p class="label">Tema</p><div class="picks">${chip('mezcla', 'Mezcla')}${Object.entries(D.datoCats).map(([k, l]) => chip(k, l)).join('')}</div>
  <p class="label">¿Quién responde?</p>
  <div class="seg seg--2"><button class="seg-b ${mode === 'ambos' ? 'is-on' : ''}" data-a="datomode" data-v="ambos">Los dos a la vez</button><button class="seg-b ${mode === 'turnos' ? 'is-on' : ''}" data-a="datomode" data-v="turnos">Por turnos</button></div>
  <p class="hint">${mode === 'ambos' ? 'Cada uno elige en secreto y se revela a la vez.' : 'Uno lee la tarjeta y el otro responde. Se alternan.'}</p>
  <div class="nav"><button class="btn btn--gold big" data-a="datostart">Empezar</button></div>`;
};
V.mas = viewQuiz;

// DUELO DE MIRADAS
V.miradas = g => {
  if (g.phase === 'ready') return `${gameHead('miradas')}<article class="card card--calm"><p class="card-q">Mírense fijo a la cámara.</p>
    <div class="card-body"><p class="detail">Pueden hacer caras, pero sin hablar ni tocar la pantalla. Pierde quien se ría o desvíe la mirada primero.</p><button class="btn btn--gold big" data-a="stare">Empezar</button></div></article>`;
  if (g.phase === 'go') {
    const st = ui.deadlines[g.rid] || (ui.deadlines[g.rid] = Date.now());
    const t = Date.now() - st;
    needTick = true;
    const pre = t < 3000;
    const shown = pre ? String(3 - Math.floor(t / 1000)) : ((t - 3000) / 1000).toFixed(1) + ' s';
    return `${gameHead('miradas')}<div class="stare ${pre ? 'is-pre' : ''}"><span>${shown}</span></div>
    <p class="who center">¿Quién se rió primero?</p><div class="duo"><button class="btn btn--gold" data-a="stareloss" data-s="p1">${nm('p1')}</button><button class="btn btn--wine" data-a="stareloss" data-s="p2">${nm('p2')}</button></div>`;
  }
  return `${gameHead('miradas')}<article class="card"><p class="card-q">${nm(g.loser)} se rió primero</p><div class="card-body"><p class="detail">Aguantó ${esc(g.time)}. +1 para ${nm(other(g.loser))}.</p><button class="btn btn--gold" data-a="stare">Revancha</button></div></article>`;
};

// YO NUNCA NUNCA
V.yonunca = g => {
  if (!g.lvl) return `${gameHead('yonunca')}<p class="lead">Elijan el nivel. Cada uno confiesa en secreto y se revela a la vez.</p><div class="levels">${[1, 2, 3].map(l => `<button class="level" data-a="ynlvl" data-l="${l}"><span class="flames">${flames(l)}</span><b>${D.yonunca[l].name}</b></button>`).join('')}</div>`;
  const lv = D.yonunca[g.lvl];
  const me = mySlot();
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    const mine = g.answers?.[me];
    body = `<div class="opts"><button class="opt ${mine === 'si' ? 'is-on' : ''}" data-a="answer" data-v="si" ${mine ? 'disabled' : ''}>Yo sí</button><button class="opt ${mine === 'no' ? 'is-on' : ''}" data-a="answer" data-v="no" ${mine ? 'disabled' : ''}>Yo nunca</button></div>${waitingFor(g)}`;
  } else if (rs.count) body = countdownHtml(rs);
  else {
    const yes = ['p1', 'p2'].filter(s => g.answers[s] === 'si');
    body = `<div class="reveal"><div><small>${nm('p1')}</small><b>${g.answers.p1 === 'si' ? 'Yo sí' : 'Yo nunca'}</b></div><div><small>${nm('p2')}</small><b>${g.answers.p2 === 'si' ? 'Yo sí' : 'Yo nunca'}</b></div></div>
    <p class="verdict">${yes.length === 2 ? 'Los dos. Cuéntense la historia.' : yes.length ? `${nm(yes[0])}, toca contar la historia.` : 'Ninguno de los dos. Qué inocentes.'}</p>`;
  }
  return `${gameHead('yonunca', `<button class="chip" data-a="ynreset">${flames(g.lvl)} ${lv.name}</button>`)}<article class="card card--hot"><p class="card-q">${esc(lv.cards[g.idx])}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="ynnext">Otra</button></div>`;
};

// DADO COQUETO
V.dado = g => {
  const rolling = g.a !== null && ui.diceRoll[g.rid] && Date.now() - ui.diceRoll[g.rid] < 1100;
  if (rolling) needTick = true;
  const A = D.dado.acciones, Tm = D.dado.temas;
  const face = (list, i) => esc(rolling ? list[rnd(list.length)] : list[i]);
  return `${gameHead('dado')}<p class="lead">Turno de <b>${nm(g.turn)}</b>.</p>
  <div class="dice ${rolling ? 'is-rolling' : ''}">
    <div class="die"><small>Acción</small><b>${g.a === null ? '?' : face(A, g.a)}</b></div>
    <div class="die die--b"><small>Tema</small><b>${g.t === null ? '?' : face(Tm, g.t)}</b></div>
  </div>
  <div class="nav">${g.a === null ? `<button class="btn btn--gold big" data-a="roll">Tirar los dados</button>` : g.done ? `<p class="verdict">${esc(g.done)}</p><button class="btn btn--gold" data-a="rollnext">Siguiente: ${nm(other(g.turn))}</button>` : `<button class="btn btn--gold" data-a="rolldone">Hecho</button><button class="btn btn--line" data-a="lose" data-s="${g.turn}">Me rindo</button>`}</div>`;
};

// HISTORIA A DOS VOCES
V.historia = g => {
  const me = mySlot();
  const word = D.historia.palabras[g.word];
  const lines = (g.lines || []).map(l => `<span class="ln ln--${l.slot}">${esc(l.text)}</span>`).join(' ');
  let foot = '';
  if (g.done) {
    foot = `<div class="nav"><button class="btn btn--gold" data-a="histnew">Nueva historia</button></div>`;
  } else if (me === g.turn) {
    const draft = ui.drafts['hist-' + g.rid] || '';
    const has = !draft || hasWord(draft, word);
    foot = `<div class="must">Tu frase debe incluir <b>${esc(word)}</b></div>
      <textarea id="in-hist" data-draft="hist-${g.rid}" rows="3" maxlength="220" placeholder="Continúa la historia…">${esc(draft)}</textarea>
      ${has ? '' : `<p class="err">Falta la palabra «${esc(word)}».</p>`}
      <div class="nav"><button class="btn btn--gold" data-a="histadd" ${draft.trim() ? '' : 'disabled'}>${has ? 'Añadir frase' : 'Añadir sin la palabra (penitencia)'}</button><button class="btn btn--line" data-a="histend">Terminar historia</button></div>`;
  } else {
    foot = `<p class="wait">${nm(g.turn)} está escribiendo con la palabra <b>${esc(word)}</b>…</p><div class="nav"><button class="btn btn--line" data-a="histend">Terminar historia</button></div>`;
  }
  return `${gameHead('historia')}<article class="card story ${g.done ? 'story--done' : ''}"><p class="story-tx"><span class="ln ln--open">${esc(D.historia.inicios[g.open])}</span> ${lines}</p>
  ${g.done ? `<p class="detail">Una historia de ${nm('p1')} y ${nm('p2')}.</p>` : ''}</article>${foot}`;
};


// ───────────── juegos de improvisación ─────────────
function clock(left, dur) {
  const pct = Math.max(0, Math.min(100, (left / dur) * 100));
  return `<div class="clock ${left <= Math.min(10, dur / 3) ? 'is-low' : ''}" style="--p:${pct}"><span>${left}</span><small>segundos</small></div>`;
}
const turnSecs = g => Math.max(2, g.speed - Math.floor(g.count / 4) * 0.5);

function viewChain(g) {
  const me = mySlot(), isLetra = g.k === 'letra';
  if (g.phase === 'setup') {
    const cat = ui.drafts.letraCat ?? 0;
    const sp = (v, l) => `<button class="seg-b ${g.speed === v ? 'is-on' : ''}" data-a="chainspeed" data-v="${v}">${l}</button>`;
    return `${gameHead(g.k)}<p class="lead">${isLetra ? 'Sale una letra y una categoría. Por turnos, digan algo que empiece con esa letra. Pierde quien se quede en blanco, se pase del tiempo o repita.' : 'Uno dice una palabra; el otro tiene que decir una que empiece con la última sílaba (mari<b>posa</b> → <b>sa</b>po → <b>po</b>llo…). Pierde quien se trabe, se pase del tiempo o repita.'}</p>
    ${isLetra ? `<p class="label">Categoría</p><div class="picks">${D.letraCats.map((c, i) => `<button class="pick ${cat === i ? 'is-on' : ''}" data-a="letracat" data-v="${i}">${esc(c)}</button>`).join('')}<button class="pick ${cat === -1 ? 'is-on' : ''}" data-a="letracat" data-v="-1">Sorpresa</button></div>` : ''}
    <p class="label">Tiempo por turno</p><div class="seg">${sp(8, 'Tranqui · 8 s')}${sp(6, 'Normal · 6 s')}${sp(4, 'Rápido · 4 s')}</div>
    <p class="hint">El tiempo se acorta medio segundo cada cuatro palabras.</p>
    <div class="nav"><button class="btn btn--gold big" data-a="chainstart">Empezar</button></div>`;
  }
  const head = isLetra
    ? `<div class="letter-tile">${esc(g.letter)}</div><p class="chain-cat">${esc(D.letraCats[g.cat])}</p>`
    : `<p class="chain-cat">Primera palabra</p><div class="letter-tile letter-tile--word">${esc(D.encadenada[g.word])}</div>`;
  if (g.phase === 'end') {
    return `${gameHead(g.k)}${head}<article class="card card--calm"><p class="card-q">${nm(g.loser)} perdió</p>
    <div class="card-body"><p class="detail">${g.why === 'tiempo' ? 'Se le acabó el tiempo.' : g.why === 'repite' ? 'Repitió una palabra.' : 'Se rindió.'} Llegaron a ${g.count} ${g.count === 1 ? 'palabra' : 'palabras'}. +1 para ${nm(other(g.loser))}.</p>
    <button class="btn btn--gold" data-a="chainagain">Otra ronda</button><button class="btn btn--line" data-a="chainsetup">Cambiar ${isLetra ? 'categoría' : 'velocidad'}</button></div></article>`;
  }
  const dur = turnSecs(g);
  const left = timeLeft(g.tid, dur);
  const mine = g.turn === me;
  return `${gameHead(g.k)}${head}<p class="who center">${mine ? '¡Te toca!' : `Le toca a ${nm(g.turn)}`} · ${g.count} ${g.count === 1 ? 'palabra' : 'palabras'}</p>${clock(left, Math.ceil(dur))}
  ${mine ? `<div class="nav"><button class="btn btn--gold big" data-a="chainpass">¡Dije una! Te toca</button><button class="btn btn--line" data-a="chaingive">Me rindo</button></div>`
    : `<div class="nav"><button class="btn btn--wine big" data-a="chainrep">¡Repitió!</button></div>`}`;
}
V.letra = viewChain;
V.encadenada = viewChain;

V.experto = g => {
  const me = mySlot(), ex = g.turn, q = other(ex);
  const topic = D.experto[g.idx];
  let body = '';
  if (g.phase === 'ready') body = `<p class="detail">${nm(ex)} es la máxima autoridad mundial en este tema. Tiene 60 segundos para dar una charla seria. Después ${nm(q)} hace sus preguntas.</p>${me === ex ? '<button class="btn btn--gold" data-a="expgo">Empezar la charla</button>' : `<p class="wait">Esperando a que ${nm(ex)} suba al escenario…</p>`}`;
  else if (g.phase === 'talk') {
    const left = timeLeft(g.rid, 60);
    body = `${clock(left, 60)}${me === ex ? '<button class="btn btn--line" data-a="expask">Terminé, que pregunten</button>' : `<p class="detail">Escucha con cara de interés. En cuanto termine, te toca preguntar.</p><button class="btn btn--line" data-a="expask">Pasar a las preguntas</button>`}`;
  } else if (g.phase === 'ask') {
    body = me === q
      ? `<p class="who">Tus preguntas para ${nm(ex)}:</p><ul class="qlist">${g.qs.map(i => `<li>${esc(D.preguntonas[i])}</li>`).join('')}</ul><p class="who">¿Te convenció?</p><div class="duo"><button class="btn btn--gold" data-a="win" data-s="${ex}" data-msg="${nm(ex)} es una eminencia. +1">Me convenció · +1</button><button class="btn btn--line" data-a="lose" data-s="${ex}">Fraude total</button></div>`
      : `<p class="detail">${nm(q)} te va a hacer preguntas incómodas. Responde con total seguridad.</p>`;
    if (g.done) body = `<p class="verdict">${esc(g.done)}</p>`;
  }
  return `${gameHead('experto')}<article class="card"><span class="card-cat">Conferencia de ${nm(ex)}</span><p class="card-q">${esc(topic)}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="expnext">Siguiente conferencia: ${nm(q)}</button></div>`;
};

V.diccionario = g => {
  if (!g.deck) {
    const opt = (v, t, dsc) => `<button class="level" data-a="diccdeck" data-v="${v}"><span class="lvl-ic">${ic(v === 'alemania' ? 'globe' : v === 'venezuela' ? 'sun' : 'dict')}</span><span><b>${t}</b><small class="lvl-sub">${dsc}</small></span></button>`;
    return `${gameHead('diccionario')}<p class="lead">Quien lee ve la definición real y decide si la lee o inventa otra. Ideal cuando uno sabe y el otro no.</p><div class="levels">${opt('venezuela', 'Venezolanismos', 'Ladilla, ñapa, zaperoco, ratón…')}${opt('alemania', 'Palabras alemanas', 'Fernweh, Kopfkino, Treppenwitz…')}${opt('raras', 'Raras del español', 'Petricor, trampantojo, zascandil…')}${opt('todas', 'Todas mezcladas', 'Cualquiera de las tres')}</div>`;
  }
  const me = mySlot(), reader = g.turn, guesser = other(reader);
  const it = D.diccionario[g.idx];
  const rs = revealState(g);
  let body;
  if (rs === 'wait') {
    if (me === reader) {
      const mine = g.answers?.[me];
      body = mine === undefined
        ? `<p class="who">Definición real, solo para ti:</p><p class="def">${esc(it.d)}</p><p class="detail">¿Vas a leer la real o vas a inventar una?</p><div class="opts"><button class="opt" data-a="answer" data-v="real">Leeré la real</button><button class="opt" data-a="answer" data-v="falsa">Inventaré una</button></div>`
        : `<p class="who">${mine === 'real' ? 'Lee la definición real' : 'Inventa una definición'} en voz alta, con cara de póker.</p>${mine === 'real' ? `<p class="def">${esc(it.d)}</p>` : ''}<p class="wait">Esperando a que ${nm(guesser)} decida…</p>`;
    } else {
      body = g.answers?.[reader] === undefined
        ? `<p class="wait">${nm(reader)} está preparando su definición…</p>`
        : g.answers?.[me] === undefined
          ? `<p class="who">Escucha a ${nm(reader)}. ¿La definición es…?</p><div class="opts"><button class="opt" data-a="answer" data-v="real">Real</button><button class="opt" data-a="answer" data-v="falsa">Inventada</button></div>`
          : `<p class="wait">Listo…</p>`;
    }
  } else if (rs.count) body = countdownHtml(rs);
  else {
    body = `<p class="verdict big">${g.answers[reader] === 'real' ? 'Era la real' : 'Era inventada'}</p><p class="detail">${g.resolved.ok ? `${nm(guesser)} no se dejó engañar. +1` : `${nm(reader)} engañó a ${nm(guesser)}. +1 para ${nm(reader)}`}</p><p class="def">${esc(it.w)}: ${esc(it.d)}</p>`;
  }
  const deckName = { venezuela: 'Venezolanismos', alemania: 'Alemán', raras: 'Raras del español', todas: 'Mezcla' }[g.deck];
  return `${gameHead('diccionario', `<button class="chip" data-a="diccreset">${deckName}</button>`)}<article class="card"><span class="card-cat">Lee ${nm(reader)}</span><p class="card-q huge">${esc(it.w)}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="diccnext">Otra palabra</button></div>`;
};

V.improv = g => {
  const I = D.improv;
  const scene = `<p class="card-q">${esc(I.quienes[g.q])} en ${esc(I.donde[g.d])}, y ${esc(I.problema[g.p])}.</p>`;
  let body = '';
  if (g.phase === 'ready') body = `<p class="detail">Elijan quién es quién y armen la escena por turnos. Cada frase empieza con «Sí, y además…». Pierde quien se trabe, niegue lo que dijo el otro o se ría demasiado.</p><button class="btn btn--gold" data-a="impgo">Empezar · 3 minutos</button>`;
  else if (g.done) body = `<p class="verdict">${esc(g.done)}</p>`;
  else {
    const left = timeLeft(g.rid, 180);
    body = `${clock(left, 180)}<div class="duo"><button class="btn btn--line" data-a="lose" data-s="p1">Se trabó ${nm('p1')}</button><button class="btn btn--line" data-a="lose" data-s="p2">Se trabó ${nm('p2')}</button></div><button class="btn btn--gold" data-a="impwin">¡Escenón! +1 a la sintonía</button>`;
  }
  return `${gameHead('improv')}<article class="card"><span class="card-cat">La escena</span>${scene}<div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="impnext">Otra escena</button></div>`;
};

V.traductor = g => {
  const me = mySlot(), sp = g.turn, tr = other(sp);
  let body = '';
  if (g.phase === 'ready') body = `<p class="detail">${nm(sp)} habla 20 segundos en un idioma inventado, con gestos y emoción. Después ${nm(tr)} traduce con total seriedad.</p>${me === sp ? '<button class="btn btn--gold" data-a="trgo">Empezar a hablar</button>' : `<p class="wait">Esperando a ${nm(sp)}…</p>`}`;
  else if (g.done) body = `<p class="verdict">${esc(g.done)}</p>`;
  else {
    const left = timeLeft(g.rid, 20);
    body = left > 0 ? `${clock(left, 20)}<p class="who center">Habla ${nm(sp)}</p>` : `<p class="who">¡Ahora traduce ${nm(tr)}!</p><div class="duo"><button class="btn btn--gold" data-a="win" data-s="${tr}" data-msg="Traducción magistral. +1 para ${nm(tr)}">Traducción magistral</button><button class="btn btn--line" data-a="trmeh">Nadie entendió nada</button></div>`;
  }
  return `${gameHead('traductor')}<article class="card"><span class="card-cat">Situación</span><p class="card-q">${esc(D.traductor[g.idx])}</p><div class="card-body">${body}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="trnext">Siguiente: habla ${nm(tr)}</button></div>`;
};

V.entrevista = g => {
  const me = mySlot(), star = g.turn, host = other(star);
  const body = me === host
    ? `<p class="who">Tú entrevistas. Algunas preguntas:</p><ul class="qlist">${g.qs.map(i => `<li>${esc(D.entrevistas[i])}</li>`).join('')}</ul><p class="detail">Inventa más. Cuanto más incómodas, mejor.</p>`
    : `<p class="detail">Eres una celebridad. Responde todo con detalles inventados y mucha seguridad.</p>`;
  return `${gameHead('entrevista')}<article class="card"><span class="card-cat">Año 2045</span><p class="card-q">Todo el mundo conoce a ${nm(star)} por ${esc(D.futuro[g.idx])}.</p><div class="card-body">${body}<button class="btn btn--line" data-a="impwin">Aplausos · +1 a la sintonía</button></div></article>
  <div class="nav"><button class="btn btn--gold" data-a="entnext">Siguiente entrevista: ${nm(host)}</button></div>`;
};

// FINAL
function viewFinal() {
  const a = S.scores.p1, b = S.scores.p2;
  const tie = a === b;
  const winner = tie ? null : a > b ? 'p1' : 'p2';
  const me = mySlot();
  const g = S.g || {};
  const chooser = tie ? null : winner;
  const canChoose = tie || me === chooser;
  let couponArea;
  if (g.coupon !== undefined && g.coupon !== null) {
    const c = D.cupones[g.coupon];
    couponArea = `<div class="coupon"><span class="cp-ic">${ic(CUPON_ICON[g.coupon] || 'sparkle')}</span><b>${esc(c.t)}</b><p>${esc(c.d)}</p><small>${tie ? 'Cupón compartido' : `Para ${nm(winner)}, cortesía de ${nm(other(winner))}`}</small></div>`;
  } else if (canChoose) {
    couponArea = `<p class="lead">${tie ? 'Empate. Elijan un cupón juntos para la próxima vez que se vean.' : 'Elige tu cupón para la próxima vez que se vean.'}</p>
    <div class="coupons">${D.cupones.map((c, i) => `<button class="cp" data-a="coupon" data-i="${i}">${ic(CUPON_ICON[i] || 'sparkle', 'ic--cat')}<b>${esc(c.t)}</b><small>${esc(c.d)}</small></button>`).join('')}</div>`;
  } else {
    couponArea = `<p class="wait">${nm(chooser)} está eligiendo su cupón…</p>`;
  }
  return `<section class="final">
    <h2 class="title title--sm">${tie ? 'Empate perfecto' : `Gana ${nm(winner)}`}</h2>
    <p class="detail">${nm('p1')} ${a} · ${nm('p2')} ${b} · Sintonía ${S.sync}</p>
    ${couponArea}
    <div class="nav"><button class="btn btn--gold" data-a="newmatch">Nueva partida</button><button class="btn btn--line" data-a="home">Seguir jugando</button></div>
  </section>`;
}

// ───────────── temporizadores ─────────────
let needTick = false;
function timeLeft(r, dur) {
  if (!ui.deadlines[r]) ui.deadlines[r] = Date.now() + dur * 1000;
  const left = Math.max(0, Math.ceil((ui.deadlines[r] - Date.now()) / 1000));
  if (left > 0) needTick = true;
  return left;
}
const timerHtml = left => `<span class="timer ${left <= 10 ? 'is-low' : ''} ${left === 0 ? 'is-zero' : ''}">${left === 0 ? '¡Tiempo!' : left + ' s'}</span>`;

// ───────────── overlays ─────────────
function viewOverlay() {
  if (ui.modal === 'menu') return sheet(`
    <h3>Sala ${esc(code)}</h3>
    <button class="row-btn" data-a="share">Compartir enlace de la sala</button>
    <button class="row-btn" data-a="settings">Bebida y penitencias</button>
    <button class="row-btn" data-a="players">Cambiar jugadores</button>
    <button class="row-btn" data-a="scoreedit">Ajustar marcador</button>
    <button class="row-btn" data-a="askreset">Reiniciar partida</button>
    <button class="row-btn row-btn--muted" data-a="leave">Salir de la sala</button>`);
  if (ui.modal === 'settings') {
    const d = drinkMode(S);
    const seg = (v, l) => `<button class="seg-b ${d === v ? 'is-on' : ''}" data-a="drink" data-v="${v}">${l}</button>`;
    return sheet(`<h3>Bebida y penitencias</h3>
      <p class="label">Modo bebida</p>
      <div class="seg">${seg('off', 'Off')}${seg('prost', '¡Prost!')}${seg('tragos', 'Dos tragos')}</div>
      ${d !== 'off' ? `<p class="label">Brindan diciendo</p><div class="picks">${['¡Salud!', '¡Prost!', '¡Cheers!', '¡Saúde!', '¡Santé!'].map(w => `<button class="pick ${(S.settings.cheer || '¡Prost!') === w ? 'is-on' : ''}" data-a="cheer" data-v="${w}">${w}</button>`).join('')}</div>` : ''}
      <p class="note">${d === 'off' ? 'Sin bebida. Activa la penitencia alternativa para que perder tenga consecuencias.' : d === 'prost' ? 'Un trago con brindis a cámara y algo que decirle al otro.' : 'Dos tragos pequeños. Jueguen con moderación y alternen con agua.'}</p>
      <label class="toggle"><input type="checkbox" data-a="alt" ${S.settings.alt ? 'checked' : ''}><span>Penitencia alternativa</span><small>Para quien prefiera no beber: imitaciones, cumplidos, bailes…</small></label>
      <label class="toggle"><input type="checkbox" data-a="drawbonus" ${S.settings.drawBonus ? 'checked' : ''}><span>Punto para quien dibuja o actúa</span><small>En Dibuja y adivina y en Mímica, si el otro acierta, los dos suman.</small></label>
      <button class="btn btn--gold" data-a="close">Listo</button>`);
  }
  if (ui.modal === 'players') {
    return sheet(`<h3>Cambiar jugadores</h3>
      ${['p1', 'p2'].map(s => `<label class="field"><span>${s === 'p1' ? 'Jugador 1' : 'Jugador 2'}${S.players[s]?.id === myId ? ' (tú)' : ''}</span><input id="in-${s}" data-draft="pn-${s}" value="${esc(ui.drafts['pn-' + s] ?? nameOf(s))}" maxlength="18"></label>`).join('')}
      <button class="btn btn--gold" data-a="saveplayers">Guardar nombres</button>`);
  }
  if (ui.modal === 'scoreedit') {
    const r = (key, label, val) => `<div class="adj"><span>${label}</span><button class="icon-btn" data-a="adj" data-k="${key}" data-d="-1" aria-label="Restar">−</button><b>${val}</b><button class="icon-btn" data-a="adj" data-k="${key}" data-d="1" aria-label="Sumar">+</button></div>`;
    return sheet(`<h3>Ajustar marcador</h3>${r('p1', nm('p1'), S.scores.p1)}${r('p2', nm('p2'), S.scores.p2)}${r('sync', 'Sintonía', S.sync)}<button class="btn btn--gold" data-a="close">Listo</button>`);
  }
  if (ui.modal === 'reset') {
    return sheet(`<h3>¿Reiniciar la partida?</h3><p class="detail">El marcador y la sintonía vuelven a cero. Los nombres se mantienen.</p>
      <button class="btn btn--wine" data-a="doreset">Reiniciar partida</button><button class="btn btn--line" data-a="close">Cancelar</button>`);
  }
  // Penalización
  const p = S.penalty;
  if (p && (!p.rid || !S.g || S.g.rid !== p.rid || revealDone(p.rid))) {
    const me = mySlot();
    const name = nm(p.slot);
    const mode = drinkMode(S);
    const pen = esc(D.penitencias[p.pen]);
    let main = '';
    const line = esc(D.prost[hashIdx(p.id, D.prost.length)]).replace(/\{o\}/g, nm(other(p.slot)));
    if (mode === 'prost') main = `<p class="pen-k">${ic('glass')} ${esc((S.settings.cheer || '¡Prost!').replace('!', ''))}, ${name}!</p><p class="pen-d">${line}</p>`;
    if (mode === 'tragos') main = `<p class="pen-k">${ic('glass')} Dos tragos para ${name}</p><p class="pen-d">Y antes del segundo: ${line.charAt(0).toLowerCase() + line.slice(1)}</p><p class="note">Tragos pequeños. Jueguen con moderación y alternen con agua.</p>`;
    const alt = S.settings.alt ? (mode === 'off' ? `<p class="pen-k">Penitencia</p><p class="pen-d">${pen}</p>` : `<p class="pen-alt">Si prefieres no beber: ${pen}</p>`) : '';
    return `<div class="scrim"><div class="pen" role="dialog" aria-label="Penalización">
      <p class="pen-boom">${ic('burst', 'ic--boom')} ${me === p.slot ? 'Perdiste esta ronda.' : `${name} perdió esta ronda.`}</p>
      <p class="label">Penalización</p>${main}${alt}
      <div class="duo"><button class="btn btn--gold" data-a="penok">Listo</button><button class="btn btn--line" data-a="penok">No aplica</button></div>
    </div></div>`;
  }
  return '';
}
const sheet = inner => `<div class="scrim" data-a="close-scrim"><div class="sheet" role="dialog">${inner}</div></div>`;
function revealDone(r) { const g = S.g; if (!g || g.rid !== r || !g.resolved) return true; const st = ui.reveal[r]; return st && Date.now() - st >= 2700; }

function flashHtml() {
  const f = S.flash;
  if (f && !ui.flashSeen[f.id] && (!f.rid || revealDone(f.rid))) {
    ui.flashSeen[f.id] = true; ui.flashText = f.text; ui.flashUntil = Date.now() + 2600;
  }
  if (ui.toastUntil > Date.now()) { needTick = true; return `<div class="toast">${esc(ui.toast)}</div>`; }
  if (ui.flashUntil > Date.now()) { needTick = true; return `<div class="toast toast--gold">${esc(ui.flashText)}</div>`; }
  return '';
}

// ───────────── render ─────────────
// Actualiza el DOM en el lugar (sin reemplazarlo) para que los toques no se pierdan
function patch(el, html) {
  if (!window.morphdom) { el.innerHTML = html; return; }
  const next = el.cloneNode(false);
  next.innerHTML = html;
  window.morphdom(el, next, {
    onBeforeElUpdated: (from, to) => !(from.isEqualNode && from.isEqualNode(to)),
    onBeforeNodeDiscarded: node => !(node.tagName === 'CANVAS')
  });
}
let tickTimer = null;
function render() {
  needTick = false;
  const ae = document.activeElement;
  const focusId = ae && ae.id ? ae.id : null;
  const sel = focusId && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;

  let html;
  if (!code) html = viewLanding();
  else if (!mySlot()) html = viewJoin();
  else {
    let main = S.screen === 'game' ? viewGame() : S.screen === 'final' ? viewFinal() : viewHome();
    html = `${topbar()}${rings(false)}<main class="stage">${main}</main>`;
  }
  patch($app, html + (code && mySlot() ? flashHtml() : ''));
  patch($ov, code && mySlot() ? viewOverlay() : '');
  document.body.classList.toggle('in-room', !!(code && mySlot()));

  const slot = document.getElementById('canvas-slot');
  if (slot) Draw.mount(slot);

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
  }
  // fin automático de turno en mímica/tabú
  const g = S.g;
  if (g && (g.k === 'letra' || g.k === 'encadenada') && g.phase === 'play' && g.turn === mySlot() && !ui.ended[g.tid] && ui.deadlines[g.tid] && Date.now() >= ui.deadlines[g.tid]) {
    ui.ended[g.tid] = true;
    setTimeout(() => H.chaintime(), 0);
  }
  if (g && g.k === 'dibujo' && g.phase === 'play' && g.drawer === mySlot() && !ui.ended[g.round] && ui.deadlines[g.round] && Date.now() >= ui.deadlines[g.round]) {
    ui.ended[g.round] = true;
    setTimeout(() => H.dtime(), 0);
  }
  if (g && (g.k === 'mimica' || g.k === 'tabu') && g.phase === 'play' && g.actor === mySlot() && !ui.ended[g.rid] && ui.deadlines[g.rid] && Date.now() >= ui.deadlines[g.rid]) {
    ui.ended[g.rid] = true;
    setTimeout(() => (g.k === 'mimica' ? H.mimtime() : endActing()), 0);
  }
  clearTimeout(tickTimer);
  if (needTick) tickTimer = setTimeout(render, 200);
}

// ───────────── dibujo en vivo ─────────────
const Draw = (() => {
  const cv = document.createElement('canvas');
  cv.className = 'canvas';
  const ctx = cv.getContext('2d');
  let curRid = null, strokes = [], color = '#F3E7D3', drawing = false, buf = [], last = null, sendTimer = null;
  function size() {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; redraw(); }
  }
  function seg(s) {
    const W = cv.width, H = cv.height;
    ctx.strokeStyle = s.c; ctx.lineWidth = (s.w || 0.012) * W; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    s.p.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    if (s.p.length === 1) ctx.lineTo(s.p[0][0] * W + 0.1, s.p[0][1] * H);
    ctx.stroke();
  }
  function redraw() { ctx.clearRect(0, 0, cv.width, cv.height); strokes.forEach(seg); }
  function ensure(r) { if (r !== curRid) { curRid = r; strokes = []; redraw(); } }
  function canDraw() { const g = S.g; return g && g.k === 'dibujo' && g.phase === 'play' && g.drawer === mySlot(); }
  function pt(e) { const r = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; }
  function flush() {
    if (buf.length < 1) return;
    const s = { c: color, w: 0.012, p: buf };
    T && T.send({ t: 'stroke', from: myId, rid: curRid, s });
    buf = buf.length ? [buf[buf.length - 1]] : [];
  }
  cv.addEventListener('pointerdown', e => {
    if (!canDraw()) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    drawing = true; last = pt(e); buf = [last];
    const s = { c: color, w: 0.012, p: [last] }; strokes.push(s); seg(s);
    sendTimer = setInterval(flush, 60);
  });
  cv.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pt(e);
    const s = { c: color, w: 0.012, p: [last, p] }; strokes.push(s); seg(s);
    buf.push(p); last = p;
  });
  const up = () => { if (!drawing) return; drawing = false; flush(); buf = []; clearInterval(sendTimer); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  window.addEventListener('resize', () => size());
  return {
    mount(slot) {
      ensure(S.g.rid);
      slot.appendChild(cv);
      cv.style.touchAction = canDraw() ? 'none' : 'auto';
      requestAnimationFrame(size);
    },
    remote(m) { if (S.g && m.rid === S.g.rid) { ensure(m.rid); strokes.push(m.s); seg(m.s); } },
    clear(r, send) { if (r === curRid) { strokes = []; redraw(); } if (send) T && T.send({ t: 'clear', from: myId, rid: r }); },
    setColor(c) { color = c; }
  };
})();

// ───────────── acciones de UI ─────────────
function toast(t) { ui.toast = t; ui.toastUntil = Date.now() + 2200; render(); }

function endActing() {
  const g = S.g;
  if (!g || g.phase !== 'play') return;
  const guesser = other(g.actor);
  const a = { guard: g.rid, patch: { phase: 'end', done: false }, score: { [guesser]: g.got } };
  if (!g.got) { a.loser = g.actor; a.seed = g.rid; }
  // guard bloquea si done; aquí no marcamos done para permitir 'actnext'
  dispatch(a);
}

const H = {
  create() {
    const name = (ui.drafts.name ?? LS.get('enc:name', '')).trim();
    if (!name) { ui.err = 'Escribe tu nombre para crear la sala.'; return render(); }
    ui.err = ''; LS.set('enc:name', name);
    const c = newCode();
    enterRoom(c);
  },
  joincode() {
    const name = (ui.drafts.name ?? LS.get('enc:name', '')).trim();
    const c = (ui.drafts.code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!name) { ui.err = 'Escribe tu nombre para entrar.'; return render(); }
    if (!/^[A-Z0-9-]{3,12}$/.test(c)) { ui.err = 'Revisa el código: es algo como LUNA-42.'; return render(); }
    ui.err = ''; LS.set('enc:name', name); enterRoom(c);
  },
  join() {
    const name = (ui.drafts.name ?? '').trim() || LS.get('enc:name', '');
    if (!name) { ui.err = 'Escribe tu nombre para entrar.'; return render(); }
    ui.err = ''; LS.set('enc:name', name.trim()); synced = true; maybeJoin(); render();
  },
  takeslot(d) { dispatch({ players: { [d.s]: { id: myId, name: S.players[d.s].name } } }); },
  leave() { leaveRoom(); },
  async share() {
    const url = roomUrl(code);
    ui.modal = null;
    if (navigator.share && matchMedia('(pointer:coarse)').matches) {
      try { await navigator.share({ title: 'Encontrándonos', text: 'Entra a nuestra sala de juegos', url }); return render(); } catch { }
    }
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } catch { toast(url); }
  },
  menu() { ui.modal = 'menu'; render(); },
  close() { ui.modal = null; render(); },
  'close-scrim'(d, el, e) { if (e.target === el) { ui.modal = null; render(); } },
  settings() { ui.modal = 'settings'; render(); },
  players() { ui.modal = 'players'; ['p1', 'p2'].forEach(s => delete ui.drafts['pn-' + s]); render(); },
  scoreedit() { ui.modal = 'scoreedit'; render(); },
  askreset() { ui.modal = 'reset'; render(); },
  doreset() { ui.modal = null; dispatch({ reset: true }); },
  drink(d) { dispatch({ settings: { drink: d.v } }); },
  cheer(d) { dispatch({ settings: { cheer: d.v } }); },
  alt(d, el) { dispatch({ settings: { alt: el.checked } }); },
  drawbonus(d, el) { dispatch({ settings: { drawBonus: el.checked } }); },
  adj(d) { dispatch({ score: { [d.k]: +d.d } }); },
  saveplayers() {
    const pl = {};
    ['p1', 'p2'].forEach(s => {
      const v = (ui.drafts['pn-' + s] ?? nameOf(s)).trim().slice(0, 18);
      if (v) pl[s] = S.players[s] ? { ...S.players[s], name: v } : { id: 'pending-' + s, name: v };
    });
    const me = mySlot(); if (me && pl[me]) LS.set('enc:name', pl[me].name);
    ui.modal = null; dispatch({ players: pl });
  },
  penok() { dispatch({ closePenalty: true }); },
  home() { dispatch({ screen: 'home', g: null }); },
  start(d) { dispatch(startGame(d.k)); },
  finish() { dispatch({ screen: 'final', g: { k: 'final', rid: rid(), coupon: null } }); },
  coupon(d) { dispatch({ patch: { coupon: +d.i } }); },
  newmatch() { dispatch({ reset: true }); },
  next() { dispatch(nextRound(S.g.k)); },
  flipturn() { dispatch({ patch: { turn: other(S.g.turn) } }); },
  win(d) { const msg = d.msg || '+1'; dispatch({ guard: S.g.rid, patch: { done: msg }, score: { [d.s]: 1 }, flash: msg, seed: S.g.rid + 'w' }); },
  lose(d) {
    const msg = `${nameOf(d.s)} paga penitencia.`;
    dispatch({ guard: S.g.rid, patch: { done: msg }, loser: d.s, seed: S.g.rid + 'l' });
  },
  fool() {
    const g = S.g, teller = g.turn, guesser = other(teller);
    dispatch({ guard: g.rid, patch: { done: `${nameOf(teller)} engañó a ${nameOf(guesser)}. +1` }, score: { [teller]: 1 }, loser: guesser, seed: g.rid + 'f' });
  },
  // cartas
  cat(d) { dispatch(drawCard(d.c)); },
  draw() { dispatch(drawCard(S.g.cat)); },
  cats() { dispatch({ g: { k: 'cartas', rid: rid(), cat: null, turn: S.g.turn } }); },
  duel(d) {
    const g = S.g;
    if (d.s === 'tie') return dispatch({ guard: g.rid, patch: { done: 'Empate. Nadie suma.' } });
    dispatch({ guard: g.rid, patch: { done: `Gana ${nameOf(d.s)}. +1` }, score: { [d.s]: 1 }, loser: other(d.s), seed: g.rid + 'd', flash: `Gana ${nameOf(d.s)}. +1` });
  },
  answer(d) {
    const me = mySlot();
    if (S.g.answers?.[me] !== undefined) return;
    dispatch({ answer: { slot: me, value: d.v, rid: S.g.rid } });
  },
  // sin filtro
  lvl(d) { const l = +d.l, p = pick('sf' + l, D.sinfiltro[l].cards.length); dispatch({ used: p.used, g: { k: 'sinfiltro', rid: rid(), lvl: l, idx: p.idx, turn: other(S.g.turn || 'p2') } }); },
  sfnext() { H.lvl({ l: S.g.lvl }); },
  lvlreset() { dispatch({ g: { k: 'sinfiltro', rid: rid(), lvl: null, turn: S.g.turn } }); },
  // yo nunca
  ynlvl(d) { const l = +d.l, p = pick('yn' + l, D.yonunca[l].cards.length); dispatch({ used: p.used, g: { k: 'yonunca', rid: rid(), lvl: l, idx: p.idx, answers: {} } }); },
  ynnext() { H.ynlvl({ l: S.g.lvl }); },
  ynreset() { dispatch({ g: { k: 'yonunca', rid: rid(), lvl: null } }); },
  // dibujo
  dcat(d) {
    const n = D.dibujo[d.c].words.length;
    const used = S.used['d-' + d.c] || [];
    let list = shuffle([...Array(n).keys()].filter(i => !used.includes(i)));
    if (list.length < 8) list = shuffle([...Array(n).keys()]);
    dispatch({ patch: { phase: 'play', cat: d.c, list, pos: 0, got: 0, rid: rid(), round: rid(), done: false } });
  },
  color(d) { Draw.setColor(d.c); },
  clear() { Draw.clear(S.g.rid, true); },
  dok() {
    const g = S.g, guesser = other(g.drawer);
    const score = { [guesser]: 1 }; if (S.settings.drawBonus) score[g.drawer] = 1;
    const last = g.pos + 1 >= g.list.length;
    dispatch({ guard: g.rid, used: ['d-' + g.cat, g.list[g.pos], D.dibujo[g.cat].words.length], score, flash: '¡Adivinado! +1', seed: g.rid + 'ok',
      patch: last ? { phase: 'end', got: g.got + 1 } : { pos: g.pos + 1, got: g.got + 1, rid: rid() } });
  },
  dpass() {
    const g = S.g;
    if (g.pos + 1 >= g.list.length) return H.dtime();
    dispatch({ guard: g.rid, patch: { pos: g.pos + 1, rid: rid() } });
  },
  dtime() {
    const g = S.g; if (!g || g.phase !== 'play') return;
    const a = { guard: g.rid, patch: { phase: 'end' } };
    if (!g.got) { a.loser = other(g.drawer); a.seed = g.round + 'z'; }
    dispatch(a);
  },
  dnext() { dispatch({ patch: { phase: 'cat', drawer: other(S.g.drawer), rid: rid(), done: false } }); },
  // mímica / tabú
  actstart() {
    const g = S.g, len = g.k === 'tabu' ? D.tabu.length : D.mimica.length;
    const key = g.k === 'tabu' ? 'tabu' : 'mim';
    const used = S.used[key] || [];
    let pool = shuffle([...Array(len).keys()].filter(i => !used.includes(i)));
    if (pool.length < 12) pool = shuffle([...Array(len).keys()]);
    const list = pool.slice(0, 12);
    dispatch({ patch: { phase: 'play', list, pos: 0, got: 0, rid: rid() } });
  },
  actgot() { const g = S.g; const k = g.k === 'tabu' ? 'tabu' : 'mim', len = g.k === 'tabu' ? D.tabu.length : D.mimica.length; const a = { guard: g.rid, used: [k, g.list[g.pos], len], patch: { got: g.got + 1, pos: g.pos + 1 } }; if (g.pos + 1 >= g.list.length) { a.patch.phase = 'end'; a.score = { [other(g.actor)]: g.got + 1 }; } dispatch(a); },
  actpass() { const g = S.g; if (g.pos + 1 >= g.list.length) return endActing(); dispatch({ guard: g.rid, patch: { pos: g.pos + 1 } }); },
  actnext() { dispatch({ patch: { phase: 'ready', actor: other(S.g.actor), rid: rid() } }); },
  // mímica con cronómetro
  mimdur(d) { dispatch({ patch: { dur: +d.v } }); },
  mimstart() { const p = pick('mim', D.mimica.length); dispatch({ used: p.used, patch: { phase: 'play', idx: p.idx, rid: rid(), ok: false, res: null } }); },
  mimok() {
    const g = S.g, guesser = other(g.actor);
    const secs = ui.deadlines[g.rid] ? Math.max(1, g.dur - Math.ceil((ui.deadlines[g.rid] - Date.now()) / 1000)) : g.dur;
    const score = { [guesser]: 1 }; if (S.settings.drawBonus) score[g.actor] = 1;
    dispatch({ guard: g.rid, patch: { phase: 'end', ok: true, secs, done: true }, score, flash: S.settings.drawBonus ? '+1 para los dos' : `+1 para ${nameOf(guesser)}`, seed: g.rid + 'm' });
  },
  mimpass() { const g = S.g; dispatch({ guard: g.rid, patch: { phase: 'end', ok: false, res: 'pass', done: true }, loser: g.actor, seed: g.rid + 'p' }); },
  mimtime() { const g = S.g; if (!g || g.phase !== 'play') return; dispatch({ guard: g.rid, patch: { phase: 'end', ok: false, res: 'time', done: true }, loser: other(g.actor), seed: g.rid + 't' }); },
  mimnext() { dispatch({ patch: { phase: 'ready', actor: other(S.g.actor), rid: rid(), done: false } }); },
  // prefieres
  prefpick(d) { const k = 'pref-' + S.g.rid; ui.drafts[k] = { ...(ui.drafts[k] || {}), [d.f]: d.v }; render(); },
  prefsend() { const v = ui.drafts['pref-' + S.g.rid]; if (!v?.me || !v?.guess) return; dispatch({ answer: { slot: mySlot(), value: { me: v.me, guess: v.guess }, rid: S.g.rid } }); },
  // conoces
  knowsend() { const v = (ui.drafts['know-' + S.g.rid] || '').trim(); if (!v) return toast('Escribe algo antes de enviar.'); dispatch({ answer: { slot: mySlot(), value: v, rid: S.g.rid } }); },
  // onda
  ondasend() { const v = +(ui.drafts['onda-' + S.g.rid] ?? 5); dispatch({ answer: { slot: mySlot(), value: v, rid: S.g.rid } }); },
  // pestañas
  tab(d) { ui.tab = d.v; try { localStorage.setItem('enc:tab', d.v); } catch {} render(); },
  // cadena de letras / encadenada
  letracat(d) { ui.drafts.letraCat = +d.v; render(); },
  chainspeed(d) { dispatch({ patch: { speed: +d.v } }); },
  chainstart() {
    const g = S.g;
    let cat = ui.drafts.letraCat ?? 0; if (cat === -1) cat = rnd(D.letraCats.length);
    dispatch({ patch: { phase: 'play', cat, letter: D.letras[rnd(D.letras.length)], word: rnd(D.encadenada.length), count: 0, rid: rid(), tid: rid(), turn: g.turn || mySlot(), loser: null, done: false } });
  },
  chainpass() { const g = S.g; if (g.phase !== 'play') return; dispatch({ guard: g.rid, patch: { count: g.count + 1, turn: other(g.turn), tid: rid() } }); },
  chainend(slot, why) { const g = S.g; if (!g || g.phase !== 'play') return; dispatch({ guard: g.rid, patch: { phase: 'end', loser: slot, why, done: false }, score: { [other(slot)]: 1 }, loser: slot, seed: g.rid + why }); },
  chainrep() { H.chainend(S.g.turn, 'repite'); },
  chaingive() { H.chainend(S.g.turn, 'rinde'); },
  chaintime() { H.chainend(S.g.turn, 'tiempo'); },
  chainagain() { const g = S.g; dispatch({ patch: { phase: 'play', letter: D.letras[rnd(D.letras.length)], word: rnd(D.encadenada.length), count: 0, rid: rid(), tid: rid(), turn: g.loser || g.turn, loser: null } }); },
  chainsetup() { dispatch({ patch: { phase: 'setup', rid: rid() } }); },
  // experto
  expgo() { dispatch({ patch: { phase: 'talk', rid: rid(), qs: shuffle([...Array(D.preguntonas.length).keys()]).slice(0, 3), done: false } }); },
  expask() { dispatch({ patch: { phase: 'ask' } }); },
  expnext() { const p = pick('exp', D.experto.length); dispatch({ used: p.used, g: { k: 'experto', rid: rid(), turn: other(S.g.turn), phase: 'ready', idx: p.idx } }); },
  // diccionario
  diccdeck(d) { const deck = d.v || S.g.deck; const pool = D.diccionario.map((x, i) => i).filter(i => deck === 'todas' || D.diccionario[i].c === deck); const p = pickFrom('dicc-' + deck, pool); dispatch({ used: p.used, g: { k: 'diccionario', rid: rid(), turn: d.v ? (S.g.turn || mySlot()) : other(S.g.turn), deck, idx: p.idx, answers: {} } }); },
  diccnext() { H.diccdeck({}); },
  diccreset() { dispatch({ g: { k: 'diccionario', rid: rid(), turn: S.g.turn, deck: null, answers: {} } }); },
  // improv
  impgo() { dispatch({ patch: { phase: 'go', rid: rid(), done: false } }); },
  impwin() { dispatch({ guard: S.g.rid, patch: { done: '¡Escenón! +1 a la sintonía' }, score: { sync: 1 }, flash: '+1 a la sintonía', seed: S.g.rid + 'i' }); },
  impnext() { dispatch({ g: { k: 'improv', rid: rid(), turn: S.g.turn, phase: 'ready', q: rnd(D.improv.quienes.length), d: rnd(D.improv.donde.length), p: rnd(D.improv.problema.length) } }); },
  // traductor
  trgo() { dispatch({ patch: { phase: 'go', rid: rid(), done: false } }); },
  trmeh() { dispatch({ guard: S.g.rid, patch: { done: 'Nadie entendió nada. Sin puntos.' } }); },
  trnext() { const p = pick('trad', D.traductor.length); dispatch({ used: p.used, g: { k: 'traductor', rid: rid(), turn: other(S.g.turn), phase: 'ready', idx: p.idx } }); },
  // entrevista
  entnext() { const p = pick('fut', D.futuro.length); dispatch({ used: p.used, g: { k: 'entrevista', rid: rid(), turn: other(S.g.turn), idx: p.idx, qs: shuffle([...Array(D.entrevistas.length).keys()]).slice(0, 4) } }); },
  // datos
  datocat(d) { ui.drafts.datoCat = d.v; render(); },
  datomode(d) { ui.drafts.datoMode = d.v; render(); },
  datostart() {
    const cat = ui.drafts.datoCat || 'mezcla', mode = ui.drafts.datoMode || 'ambos';
    S = { ...S, g: { ...S.g, cat, mode } };
    dispatch(nextRound('dato', S.g.turn || mySlot()));
  },
  datoreset() { dispatch({ g: { k: 'dato', rid: rid(), cat: null, mode: null, turn: S.g.turn } }); },
  // miradas
  stare() { dispatch({ patch: { phase: 'go', rid: rid(), done: false } }); },
  stareloss(d) {
    const g = S.g, st = ui.deadlines[g.rid];
    const t = st ? Math.max(0, (Date.now() - st - 3000) / 1000).toFixed(1) + ' s' : '—';
    dispatch({ guard: g.rid, patch: { phase: 'end', loser: d.s, time: t, done: true }, score: { [other(d.s)]: 1 }, loser: d.s, seed: g.rid + 's' });
  },
  // dado
  roll() { dispatch({ patch: { a: rnd(D.dado.acciones.length), t: rnd(D.dado.temas.length), rid: rid(), done: false } }); },
  rolldone() { dispatch({ guard: S.g.rid, patch: { done: `${nameOf(S.g.turn)} cumplió.` } }); },
  rollnext() { dispatch({ patch: { a: null, t: null, turn: other(S.g.turn), rid: rid(), done: false } }); },
  // historia
  histadd() {
    const g = S.g, k = 'hist-' + g.rid;
    const text = (ui.drafts[k] || '').trim(); if (!text) return;
    const word = D.historia.palabras[g.word];
    const has = hasWord(text, word);
    const w = pick('hist-w', D.historia.palabras.length);
    const nr = rid();
    ui.drafts['hist-' + nr] = '';
    const a = { line: { slot: g.turn, text }, used: w.used, patch: { turn: other(g.turn), word: w.idx, rid: nr } };
    if (!has) { a.loser = g.turn; a.seed = g.rid + 'h'; }
    dispatch(a);
  },
  histend() { dispatch({ patch: { done: true } }); },
  histnew() { dispatch(startGame('historia')); }
};


document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return; // se maneja en change
  const fn = H[el.dataset.a];
  if (!fn) return;
  if (el.dataset.a === 'close-scrim') return fn(el.dataset, el, e);
  e.preventDefault();
  fn(el.dataset, el, e);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-a]')) H[el.dataset.a]?.(el.dataset, el, e);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.draft) return;
  const k = el.dataset.draft;
  ui.drafts[k] = el.type === 'range' ? +el.value : el.value;
  if (el.type === 'range') { const o = document.getElementById('onda-val'); if (o) o.textContent = el.value; }
  if (k.startsWith('hist-')) render();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const id = e.target.id;
  if (id === 'in-name') { e.preventDefault(); code ? H.join() : H.create(); }
  else if (id === 'in-code') { e.preventDefault(); H.joincode(); }
  else if (id === 'in-know') { e.preventDefault(); H.knowsend(); }
  else if (id === 'in-hist') { e.preventDefault(); if ((ui.drafts['hist-' + S.g.rid] || '').trim()) H.histadd(); }
});
window.addEventListener('popstate', () => { const c = roomFromUrl(); if (c && c !== code) enterRoom(c); else if (!c && code) leaveRoom(); });

// marcar inicio de animación del dado cuando llega una tirada nueva
let lastDiceRid = null;
function watchDice() {
  const g = S.g;
  if (g && g.k === 'dado' && g.a !== null && g.rid !== lastDiceRid) { lastDiceRid = g.rid; if (!ui.diceRoll[g.rid]) ui.diceRoll[g.rid] = Date.now(); }
}
const renderBase = render;
render = function () { watchDice(); renderBase(); };

// ───────────── inicio ─────────────
const c0 = roomFromUrl();
if (c0) enterRoom(c0); else render();
window.__enc = { get S() { return S; }, get present() { return present; }, isHost };
})();
