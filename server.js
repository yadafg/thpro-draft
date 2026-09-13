'use strict';
/*
 * 東方原曲ドラフト会議 — サーバ
 * 外部パッケージは使いません。Node.js 18 以上で `node server.js`。
 * 部屋の状態はメモリ上だけに持ちます（サーバを止めると消えます）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 10000;
const MAX_PLAYERS = 12;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;   // 6時間触られていない部屋は破棄

const rooms = new Map();

/* ---------- 小道具 ---------- */
const token = () => crypto.randomBytes(12).toString('hex');

function newCode(){
  let c;
  do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(c));
  return c;
}

// 曲名の表記ゆれを吸収して重複判定に使う
function norm(s){
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/ヴ/g, 'ブ')
    .replace(/[\s・､、。,.!?！？「」『』（）()~〜～ー\-_＝=:：;；/／]/g, '');
}

function findRoom(code){
  const r = rooms.get(String(code || ''));
  if (r) r.touched = Date.now();
  return r || null;
}
function isHost(room, tk){ return !!tk && room.hostToken === tk; }
function playerOf(room, tk){ return room.players.find(p => p.token === tk) || null; }

/* ---------- 配信する状態 ---------- */
function stateFor(room, role, viewerId){
  const base = {
    code: room.code,
    cap: room.cap,
    rounds: room.rounds,
    mode: room.mode,
    status: room.status,
    round: room.round,
    wave: room.wave,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    pending: room.pending,
    submitted: room.pending.filter(id => room.subs[id]),
    solos: room.solos,
    contests: room.contests,
    acquired: room.acquired,
    role,
    you: viewerId || null,
    v: room.v
  };
  // 提出された曲名を見られるのはホストだけ
  if (role === 'host'){
    base.picks = room.pending.map(id => ({ id, song: room.subs[id] ? room.subs[id].song : null }));
  }
  return base;
}

function broadcast(room){
  room.v += 1;
  for (const c of room.clients){
    try {
      c.res.write(`data: ${JSON.stringify(stateFor(room, c.role, c.viewerId))}\n\n`);
    } catch (e) { /* 切断済みは次の掃除で落とす */ }
  }
}

/* ---------- 進行のロジック ---------- */
function doReveal(room){
  const groups = new Map();
  for (const id of room.pending){
    const s = room.subs[id];
    if (!s) continue;
    const k = norm(s.song);
    if (!groups.has(k)) groups.set(k, { key: k, song: s.song, ids: [], winner: null });
    groups.get(k).ids.push(id);
  }
  room.solos = [];
  room.contests = [];
  for (const g of groups.values()) (g.ids.length === 1 ? room.solos : room.contests).push(g);
  room.phase = 'reveal';
}

function doConfirm(room){
  for (const g of room.solos)    room.acquired.push({ round: room.round, id: g.ids[0], song: g.song });
  for (const g of room.contests) room.acquired.push({ round: room.round, id: g.winner,  song: g.song });

  const losers  = room.contests.flatMap(g => g.ids.filter(i => i !== g.winner));
  const missing = room.pending.filter(id => !room.subs[id]);
  const next = losers.concat(missing);

  room.solos = [];
  room.contests = [];
  room.subs = {};

  if (next.length){
    room.pending = next;
    room.wave += 1;
    room.phase = 'input';
  } else if (room.round >= room.rounds){
    room.status = 'done';
    room.phase = 'done';
    room.pending = [];
  } else {
    room.round += 1;
    room.wave = 1;
    room.phase = 'input';
    room.pending = room.players.map(p => p.id);
  }
}

/* ---------- API ---------- */
const api = {
  create(body){
    const cap    = Math.max(2,  Math.min(MAX_PLAYERS, parseInt(body.cap, 10)    || MAX_PLAYERS));
    const rounds = Math.max(1,  Math.min(20,          parseInt(body.rounds, 10) || 5));
    const mode   = body.mode === 'manual' ? 'manual' : 'auto';
    const room = {
      code: newCode(), hostToken: token(),
      cap, rounds, mode,
      status: 'lobby', round: 1, wave: 1, phase: 'input',
      players: [], pending: [], subs: {}, solos: [], contests: [], acquired: [],
      clients: new Set(), v: 0, touched: Date.now()
    };
    rooms.set(room.code, room);
    console.log(`部屋を作成： ${room.code}（定員${cap}名・${rounds}巡）`);
    return { ok: true, code: room.code, token: room.hostToken, role: 'host' };
  },

  join(body){
    const room = findRoom(body.code);
    if (!room) return { ok: false, error: 'その番号の部屋は見つかりません。番号を確かめてください。' };
    if (room.status !== 'lobby') return { ok: false, error: 'この会議はすでに始まっています。' };
    const name = String(body.name || '').trim().slice(0, 12);
    if (!name) return { ok: false, error: 'ペンネームを入力してください。' };
    if (room.players.length >= room.cap) return { ok: false, error: `定員（${room.cap}名）に達しています。` };
    if (room.players.some(p => p.name === name)) return { ok: false, error: 'そのペンネームは使われています。別の名前にしてください。' };

    const p = { id: token().slice(0, 8), name, token: token() };
    room.players.push(p);
    broadcast(room);
    return { ok: true, code: room.code, token: p.token, id: p.id, role: 'player' };
  },

  start(room){
    if (room.status !== 'lobby') return { ok: false, error: 'すでに開始しています。' };
    if (room.players.length < 2) return { ok: false, error: '2名以上で開始できます。' };
    room.status = 'playing';
    room.round = 1; room.wave = 1; room.phase = 'input';
    room.pending = room.players.map(p => p.id);
    room.subs = {}; room.solos = []; room.contests = []; room.acquired = [];
    broadcast(room);
    return { ok: true };
  },

  submit(room, player, body){
    if (room.status !== 'playing' || room.phase !== 'input') return { ok: false, error: 'いまは指名を受け付けていません。' };
    if (!room.pending.includes(player.id)) return { ok: false, error: 'この巡の指名はすでに終わっています。' };
    const song = String(body.song || '').trim().slice(0, 60);
    if (!song) return { ok: false, error: '曲名を入力してください。' };
    if (room.acquired.some(a => norm(a.song) === norm(song))) {
      return { ok: false, error: 'その曲はすでに指名されています。別の曲を選んでください。' };
    }
    room.subs[player.id] = { round: room.round, wave: room.wave, song };
    broadcast(room);
    return { ok: true, song };
  },

  reveal(room){
    if (room.phase !== 'input') return { ok: false, error: 'いまは読み上げに進めません。' };
    doReveal(room);
    broadcast(room);
    return { ok: true };
  },

  draw(room, body){
    const c = room.contests.find(x => x.key === body.key);
    if (!c) return { ok: false, error: 'その抽選は見つかりません。' };
    if (c.winner) return { ok: false, error: 'すでに抽選済みです。' };
    c.winner = c.ids[crypto.randomInt(c.ids.length)];
    broadcast(room);
    return { ok: true, winner: c.winner };
  },

  winner(room, body){
    const c = room.contests.find(x => x.key === body.key);
    if (!c) return { ok: false, error: 'その抽選は見つかりません。' };
    if (c.winner) return { ok: false, error: 'すでに抽選済みです。' };
    if (!c.ids.includes(body.playerId)) return { ok: false, error: 'その参加者は候補にいません。' };
    c.winner = body.playerId;
    broadcast(room);
    return { ok: true };
  },

  confirm(room){
    if (room.phase !== 'reveal') return { ok: false, error: 'いまは確定できません。' };
    if (room.contests.some(c => !c.winner)) return { ok: false, error: '抽選が残っています。' };
    doConfirm(room);
    broadcast(room);
    return { ok: true };
  },

  reset(room){
    room.status = 'lobby'; room.round = 1; room.wave = 1; room.phase = 'input';
    room.pending = []; room.subs = {}; room.solos = []; room.contests = []; room.acquired = [];
    broadcast(room);
    return { ok: true };
  }
};

/* 参加者に配るアドレス */
function lanUrls(){
  const out = [];
  for (const list of Object.values(os.networkInterfaces())){
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

/* ---------- HTTP ---------- */
// public/index.html を基本にしつつ、同じ階層に置かれていても拾う
const CLIENT_CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html')
];
function clientPath(){
  for (const c of CLIENT_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

function send(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e5) { req.destroy(); reject(new Error('データが大きすぎます')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('データを読み取れませんでした')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // 画面
  if (req.method === 'GET' && (p === '/' || p === '/index.html')){
    const file = clientPath();
    if (!file){
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html が見つかりません。server.js と同じ場所か、public フォルダの中に置いてください。');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err){ res.writeHead(500); res.end('index.html を読めませんでした'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  // サーバが動いているかの確認用
  if (req.method === 'GET' && p === '/api/health'){
    return send(res, 200, { ok: true, app: 'touhou-draft', rooms: rooms.size, urls: lanUrls() });
  }

  // 状態の配信（Server-Sent Events）
  if (req.method === 'GET' && p === '/api/stream'){
    const room = findRoom(url.searchParams.get('code'));
    if (!room) return send(res, 404, { ok: false, error: '部屋が見つかりません' });
    const tk = url.searchParams.get('token') || '';
    let role = 'watcher', viewerId = null;
    if (isHost(room, tk)) role = 'host';
    else {
      const pl = playerOf(room, tk);
      if (!pl) return send(res, 403, { ok: false, error: 'この部屋に参加していません' });
      role = 'player'; viewerId = pl.id;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const client = { res, role, viewerId };
    room.clients.add(client);
    res.write(`data: ${JSON.stringify(stateFor(room, role, viewerId))}\n\n`);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(beat); room.clients.delete(client); });
    return;
  }

  // 操作
  if (req.method === 'POST' && p.startsWith('/api/')){
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { ok: false, error: e.message }); }

    const action = p.slice(5);
    try {
      if (action === 'create') return send(res, 200, api.create(body));
      if (action === 'join')   return send(res, 200, api.join(body));

      const room = findRoom(body.code);
      if (!room) return send(res, 404, { ok: false, error: '部屋が見つかりません。サーバが再起動されたかもしれません。' });

      const hostOnly = ['start', 'reveal', 'draw', 'winner', 'confirm', 'reset'];
      if (hostOnly.includes(action)){
        if (!isHost(room, body.token)) return send(res, 403, { ok: false, error: 'ホストだけが操作できます。' });
        return send(res, 200, api[action](room, body));
      }
      if (action === 'submit'){
        const pl = playerOf(room, body.token);
        if (!pl) return send(res, 403, { ok: false, error: 'この部屋に参加していません。' });
        return send(res, 200, api.submit(room, pl, body));
      }
      return send(res, 404, { ok: false, error: '不明な操作です' });
    } catch (e){
      console.error(e);
      return send(res, 500, { ok: false, error: 'サーバ側で問題が起きました' });
    }
  }

  send(res, 404, { ok: false, error: 'not found' });
});

/* 古い部屋の掃除 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms){
    if (now - room.touched > ROOM_TTL_MS && room.clients.size === 0){
      rooms.delete(code);
      console.log(`部屋を破棄： ${code}`);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanUrls();
  console.log('東方原曲ドラフト会議 を起動しました');
  console.log(`  サーバ　　　 0.0.0.0:${PORT}`);
  console.log(`  ローカル確認 http://localhost:${PORT}`);
  if (addrs.length){
    console.log('  参加者用（同じWi-Fiから開いてください）');
    addrs.forEach(a => console.log(`　　　　　　　 ${a}`));
  } else {
    console.log('  ほかの端末からつなぐには、この機器のIPアドレスを確認してください');
  }
  console.log('  終了するには Ctrl+C');
});
