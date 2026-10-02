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
  settings: { drink: 'prost', alt: false, drawBonus: true },
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
  modal: null, toast: '', toastUntil: 0, diceRoll: {}, landingCode: ''
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

// ───────────── juegos ─────────────
const GAMES = {
  cartas: { name: 'Cartas', icon: '🃏', blurb: 'Ocho barajas para hablar, reír y competir' },
  mimica: { name: 'Mímica', icon: '🎭', blurb: 'Actúa contra el cronómetro. Solo tú ves la palabra' },
  tabu: { name: 'Palabra prohibida', icon: '🤐', blurb: 'Descríbela sin decir las palabras vetadas' },
  dibujo: { name: 'Dibuja y adivina', icon: '🎨', blurb: 'El otro ve tu dibujo en vivo' },
  quien: { name: '¿Quién de los dos?', icon: '👉', blurb: 'Señalen en secreto y revelen a la vez' },
  prefieres: { name: '¿Qué prefieres?', icon: '⚖️', blurb: 'Elige tú y adivina lo que elegirá el otro' },
  miradas: { name: 'Duelo de miradas', icon: '👀', blurb: 'Pierde quien se ría primero' },
  conoces: { name: '¿Cuánto me conoces?', icon: '🔍', blurb: 'Uno responde, el otro adivina' },
  onda: { name: 'En la misma onda', icon: '📡', blurb: 'Del 1 al 10, ¿qué tan sincronizados están?' },
  verdades: { name: 'Dos verdades y una mentira', icon: '🤞', blurb: 'Descubre cuál es la mentira' },
  dato: { name: '¿Real o inventado?', icon: '🧪', blurb: 'Historia, lengua, ciencia… ¿verdad o mentira?' },
  mas: { name: '¿Qué es más?', icon: '📏', blurb: 'Dos opciones, una sola correcta' },
  profundas: { name: 'Preguntas profundas', icon: '🕯️', blurb: 'Modo tranquilo, sin puntos' },
  sabanas: { name: 'Entre sábanas', icon: '🛏️', blurb: '¿Cuánto me conoces?, versión picante' },
  sinfiltro: { name: 'Sin filtro', icon: '🔥', blurb: 'Tres niveles de picante' },
  yonunca: { name: 'Yo nunca nunca', icon: '🙈', blurb: 'Confiesen a la vez' },
  dado: { name: 'Dado coqueto', icon: '🎲', blurb: 'Una acción, un tema, a cámara' },
  retos: { name: 'Retos', icon: '🎯', blurb: 'Hazlo o paga penitencia' },
  historia: { name: 'Historia a dos voces', icon: '✒️', blurb: 'Un cuento, frase por frase' }
};
const GROUPS = [
  { t: 'Para reír', keys: ['mimica', 'tabu', 'dibujo', 'quien', 'prefieres', 'miradas'] },
  { t: 'Para ñoños', keys: ['dato', 'mas'] },
  { t: 'Para conocernos', keys: ['conoces', 'onda', 'verdades', 'profundas'] },
  { t: 'Para subir la temperatura', keys: ['sabanas', 'sinfiltro', 'yonunca', 'dado', 'retos'] },
  { t: 'Para cerrar la noche', keys: ['historia'] }
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
  return `
  <div class="score" role="group" aria-label="Marcador">
    <div class="ring-score ring-score--a ${mySlot() === 'p1' ? 'is-me' : ''}">
      <span class="rs-name">${p1 ? nm('p1') : 'Esperando…'}${on('p1') ? '' : ' <i class="off-dot" title="Desconectado"></i>'}</span>
      <span class="rs-pts">${S.scores.p1}</span>
    </div>
    <div class="ring-lens" title="Sintonía: puntos de los dos">
      <span class="lens-pts">${S.sync}</span>
      <span class="lens-lbl">sintonía</span>
    </div>
    <div class="ring-score ring-score--b ${mySlot() === 'p2' ? 'is-me' : ''}">
      <span class="rs-name">${p2 ? nm('p2') : 'Esperando…'}${p2 && !on('p2') ? ' <i class="off-dot" title="Desconectado"></i>' : ''}</span>
      <span class="rs-pts">${S.scores.p2}</span>
    </div>
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
    <button class="chip" data-a="share" title="Compartir enlace de la sala">${esc(code)} <span aria-hidden="true">⤴</span></button>
    ${status}
    <button class="icon-btn" data-a="menu" aria-label="Menú">⋯</button>
  </header>`;
}

function viewHome() {
  const item = k => `<button class="game" data-a="start" data-k="${k}"><span class="g-ic" aria-hidden="true">${GAMES[k].icon}</span><span class="g-tx"><b>${GAMES[k].name}</b><small>${GAMES[k].blurb}</small></span></button>`;
  return `
  <section class="home">
    <button class="feature" data-a="start" data-k="cartas">
      <span class="f-deck" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="f-tx"><b>Cartas</b><small>Ocho barajas: nosotros, absurdas, profundas, coquetas, retos, adivíname, imagina que… y duelo.</small></span>
    </button>
    ${GROUPS.map(gr => `<div class="group"><h2>${gr.t}</h2><div class="list">${gr.keys.map(item).join('')}${gr.t === 'Para cerrar la noche' ? `<div class="game game--soon"><span class="g-ic" aria-hidden="true">🀄</span><span class="g-tx"><b>Rummikub</b><small>Próximamente</small></span></div>` : ''}</div></div>`).join('')}
    <button class="btn btn--line wide" data-a="finish">Terminar la noche</button>
  </section>`;
}

const back = (label = 'Juegos') => `<button class="back" data-a="home">← ${label}</button>`;
const gameHead = (k, extra = '') => `<div class="ghead">${back()}<h2><span aria-hidden="true">${GAMES[k].icon}</span> ${GAMES[k].name}</h2>${extra}</div>`;

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
    const cats = CARD_CATS.map(c => `<button class="cat" data-a="cat" data-c="${c}"><span aria-hidden="true">${D.cartas[c].icon}</span><b>${D.cartas[c].name}</b><small>${D.cartas[c].blurb}</small></button>`).join('');
    return `${gameHead('cartas')}<p class="lead">Elige una baraja.</p><div class="cats">${cats}<button class="cat cat--mix" data-a="cat" data-c="mezcla"><span aria-hidden="true">✦</span><b>Mezcla</b><small>Una carta de cualquier baraja</small></button></div>`;
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
    <span class="card-cat">${deck.icon} ${esc(deck.name)}</span>
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
    body = `<p class="verdict big">${g.resolved.same ? '¡Coincidieron! ❤️' : 'Tenemos opiniones diferentes 😂'}</p><p class="detail">${say('p1')}.<br>${say('p2')}.</p>`;
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
  if (!g.lvl) return `${gameHead('sinfiltro')}<p class="lead">Elijan el nivel. Se puede cambiar cuando quieran.</p><div class="levels">${[1, 2, 3].map(l => `<button class="level" data-a="lvl" data-l="${l}"><span>${D.sinfiltro[l].chili}</span><b>${D.sinfiltro[l].name}</b></button>`).join('')}</div>`;
  const lv = D.sinfiltro[g.lvl];
  return `${gameHead('sinfiltro', `<button class="chip" data-a="lvlreset">${lv.chili} ${lv.name}</button>`)}
  <article class="card card--hot"><p class="card-q">${esc(lv.cards[g.idx])}</p><div class="card-body"><p class="who">Responde ${nm(g.turn)}</p>${g.done ? `<p class="verdict">${esc(g.done)}</p>` : ''}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="sfnext">Otra pregunta</button><button class="btn btn--line" data-a="lose" data-s="${g.turn}" ${g.done ? 'disabled' : ''}>Me la salto</button></div>`;
};

// RETOS
V.retos = g => `${gameHead('retos')}
  <article class="card"><span class="card-cat">Reto para ${nm(g.turn)}</span><p class="card-q">${esc(D.retos[g.idx])}</p>
  <div class="card-body">${g.done ? `<p class="verdict">${esc(g.done)}</p>` : `<div class="duo"><button class="btn btn--gold" data-a="win" data-s="${g.turn}" data-msg="${nm(g.turn)} cumplió. +1">Lo hizo · +1</button><button class="btn btn--line" data-a="lose" data-s="${g.turn}">Se negó</button></div>`}</div></article>
  <div class="nav"><button class="btn btn--gold" data-a="next">Otro reto</button></div>`;

// DIBUJA Y ADIVINA
V.dibujo = g => {
  const me = mySlot();
  const drawer = g.drawer, guesser = other(drawer);
  if (g.phase === 'cat') {
    return `${gameHead('dibujo')}<p class="lead">Dibuja <b>${nm(drawer)}</b>. ${me === drawer ? 'Elige una categoría: la palabra solo aparecerá en tu pantalla.' : `${nm(drawer)} está eligiendo la categoría.`}</p>
    ${me === drawer ? `<div class="cats cats--tight">${Object.keys(D.dibujo).map(c => `<button class="cat" data-a="dcat" data-c="${c}"><b>${D.dibujo[c].name}</b></button>`).join('')}</div>` : ''}`;
  }
  const word = D.dibujo[g.cat].words[g.idx];
  const left = timeLeft(g.rid, 60);
  const top = me === drawer
    ? `<div class="secret"><small>Tu palabra secreta</small><b>${esc(word)}</b></div>`
    : `<div class="secret secret--hidden"><small>${nm(drawer)} está dibujando</small><b>${esc(D.dibujo[g.cat].name)}</b></div>`;
  const tools = me === drawer && g.phase === 'play' ? `<div class="tools">${['#F3E7D3', '#D6B06A', '#C24D5C', '#7FA7C9'].map(c => `<button class="sw" style="--c:${c}" data-a="color" data-c="${c}" aria-label="Color"></button>`).join('')}<button class="chip" data-a="clear">Borrar</button></div>` : '';
  let foot;
  if (g.phase === 'end') foot = `<p class="verdict">${esc(g.res)}</p><p class="detail">La palabra era <b>${esc(word)}</b>.</p><div class="nav"><button class="btn btn--gold" data-a="dnext">Siguiente: dibuja ${nm(guesser)}</button></div>`;
  else foot = `<div class="duo"><button class="btn btn--gold" data-a="dok">Adivinó</button><button class="btn btn--line" data-a="dfail">No adivinó</button></div>`;
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
  if (!g.lvl) return `${gameHead('yonunca')}<p class="lead">Elijan el nivel. Cada uno confiesa en secreto y se revela a la vez.</p><div class="levels">${[1, 2, 3].map(l => `<button class="level" data-a="ynlvl" data-l="${l}"><span>${D.yonunca[l].chili}</span><b>${D.yonunca[l].name}</b></button>`).join('')}</div>`;
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
  return `${gameHead('yonunca', `<button class="chip" data-a="ynreset">${lv.chili} ${lv.name}</button>`)}<article class="card card--hot"><p class="card-q">${esc(lv.cards[g.idx])}</p><div class="card-body">${body}</div></article>
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
    const has = !draft || norm(draft).includes(norm(word));
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
    couponArea = `<div class="coupon"><span class="cp-ic" aria-hidden="true">${c.i}</span><b>${esc(c.t)}</b><p>${esc(c.d)}</p><small>${tie ? 'Cupón compartido' : `Para ${nm(winner)}, cortesía de ${nm(other(winner))}`}</small></div>`;
  } else if (canChoose) {
    couponArea = `<p class="lead">${tie ? 'Empate. Elijan un cupón juntos para la próxima vez que se vean.' : 'Elige tu cupón para la próxima vez que se vean.'}</p>
    <div class="coupons">${D.cupones.map((c, i) => `<button class="cp" data-a="coupon" data-i="${i}"><span aria-hidden="true">${c.i}</span><b>${esc(c.t)}</b><small>${esc(c.d)}</small></button>`).join('')}</div>`;
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
    if (mode === 'prost') main = `<p class="pen-k">🍻 ¡Prost, ${name}!</p><p class="pen-d">${line}</p>`;
    if (mode === 'tragos') main = `<p class="pen-k">🥃 Dos tragos para ${name}</p><p class="pen-d">Y antes del segundo: ${line.charAt(0).toLowerCase() + line.slice(1)}</p><p class="note">Tragos pequeños. Jueguen con moderación y alternen con agua.</p>`;
    const alt = S.settings.alt ? (mode === 'off' ? `<p class="pen-k">Penitencia</p><p class="pen-d">${pen}</p>` : `<p class="pen-alt">Si prefieres no beber: ${pen}</p>`) : '';
    return `<div class="scrim"><div class="pen" role="dialog" aria-label="Penalización">
      <p class="pen-boom">💥 ${me === p.slot ? 'Perdiste esta ronda.' : `${name} perdió esta ronda.`}</p>
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
  $app.innerHTML = html + (code && mySlot() ? flashHtml() : '');
  $ov.innerHTML = code && mySlot() ? viewOverlay() : '';
  document.body.classList.toggle('in-room', !!(code && mySlot()));

  const slot = document.getElementById('canvas-slot');
  if (slot) Draw.mount(slot);

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
  }
  // fin automático de turno en mímica/tabú
  const g = S.g;
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
  dcat(d) { const w = pick('d-' + d.c, D.dibujo[d.c].words.length); dispatch({ used: w.used, patch: { phase: 'play', cat: d.c, idx: w.idx, rid: rid(), done: false } }); },
  color(d) { Draw.setColor(d.c); },
  clear() { Draw.clear(S.g.rid, true); },
  dok() {
    const g = S.g, guesser = other(g.drawer);
    const score = { [guesser]: 1 }; if (S.settings.drawBonus) score[g.drawer] = 1;
    dispatch({ guard: g.rid, patch: { phase: 'end', done: true, res: `¡${nameOf(guesser)} adivinó!` }, score, flash: S.settings.drawBonus ? '+1 para los dos' : `+1 para ${nameOf(guesser)}`, seed: g.rid + 'ok' });
  },
  dfail() {
    const g = S.g, guesser = other(g.drawer);
    dispatch({ guard: g.rid, patch: { phase: 'end', done: true, res: 'No lo adivinó.' }, loser: guesser, seed: g.rid + 'nf' });
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
    const has = norm(text).includes(norm(word));
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
