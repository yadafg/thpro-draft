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
// 例：
//   千年幻想郷 / 1000年幻想郷 / せんねんげんそうきょー
// を同じグループとして扱う。
const TITLE_ALIASES = new Map([
  ['千年幻想郷','1000年幻想郷'],
  ['1000年幻想郷','1000年幻想郷'],
  ['センネンゲンソウキョウ','1000年幻想郷'],
  ['センネンゲンソウキョ','1000年幻想郷'],
  ['センネンゲンソウキョー','1000年幻想郷']
]);

function norm(s){
  const basic = String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/ヴ/g, 'ブ')
    .replace(/[\s・､、。,.!?！？「」『』（）()~〜～ー\-_＝=:：;；/／]/g, '');
  if (TITLE_ALIASES.has(basic)) return TITLE_ALIASES.get(basic);

  // 日本語の代表的な数表記を数字へ寄せる。
  // 「千年」「2000年」などを同一視するための補助。
  return basic
    .replace(/^ニセン/, '2000')
    .replace(/^イッセン/, '1000')
    .replace(/^セン/, '1000')
    .replace(/^千/, '1000')
    .replace(/^二千/, '2000')
    .replace(/^一千/, '1000');
}

function findRoom(code){
  const r = rooms.get(String(code || ''));
  if (r) r.touched = Date.now();
  return r || null;
}
function isHost(room, tk){ return !!tk && room.hostToken === tk; }
function playerOf(room, tk){ return room.players.find(p => p.token === tk) || null; }

/* ---------- 配信する状態 ---------- */
function playerState(p){
  return { id: p.id, name: p.name, ended: !!p.ended };
}

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
    players: room.players.map(playerState),
    pending: room.pending,
    submitted: room.pending.filter(id => room.subs[id]),
    acquired: room.acquired,
    role,
    you: viewerId || null,
    v: room.v,
    revealIndex: room.revealIndex || 0,
    revealTotal: room.revealOrder ? room.revealOrder.length : 0,
    revealShown: !!room.revealShown
  };

  if (role === 'host'){
    if (room.phase === 'reveal' && room.revealOrder.length){
      const id = room.revealOrder[room.revealIndex];
      const pl = room.players.find(p => p.id === id);
      const sub = room.subs[id];
      base.reveal = pl && sub ? { id, name: pl.name, song: sub.song } : null;
    } else {
      base.reveal = null;
    }
    if (room.phase === 'decide' || room.phase === 'lottery'){
      base.submissions = room.revealOrder.map(id => {
        const p = room.players.find(x=>x.id===id);
        const s = room.subs[id];
        const g = s ? room.groups.find(x=>x.key===norm(s.song)) : null;
        return p && s ? {
          id, name:p.name, song:s.song, key:g ? g.key : norm(s.song),
          decision:g ? (g.decision || null) : null,
          winner:g ? (g.winner || null) : null
        } : null;
      }).filter(Boolean);
      base.lotteryCandidates = room.groups.filter(g=>g.decision==='lottery').map(g=>({
        key:g.key, song:g.song, ids:g.ids, winner:g.winner||null,
        selected:room.currentLotteryKey===g.key
      }));
      base.currentLotteryKey = room.currentLotteryKey || null;
    } else {
      base.submissions = [];
      base.lotteryCandidates = [];
      base.currentLotteryKey = null;
    }
  }
  return base;
}

function broadcast(room){
  room.v += 1;
  for (const c of room.clients){
    try { c.res.write(`data: ${JSON.stringify(stateFor(room, c.role, c.viewerId))}\n\n`); }
    catch (e) { /* 切断済みは次の掃除で落とす */ }
  }
}

/* ---------- 進行のロジック ---------- */
function activeIds(room){
  return room.players.filter(p => !p.ended).map(p => p.id);
}

function finishRoom(room){
  room.status = 'done';
  room.phase = 'done';
  room.pending = [];
  room.subs = {};
  room.groups = [];
  room.revealOrder = [];
  room.revealIndex = 0;
}

function enterReveal(room){
  room.revealOrder = room.pending.filter(id => room.subs[id]);
  room.revealIndex = 0;
  room.revealShown = false;
  room.groups = [];
  room.phase = room.revealOrder.length ? 'reveal' : 'decide';
  if (!room.revealOrder.length) buildGroups(room);
}

function buildGroups(room){
  const groups = new Map();
  for (const id of room.revealOrder){
    const s = room.subs[id];
    if (!s) continue;
    const k = norm(s.song);
    if (!groups.has(k)) groups.set(k, { key:k, song:s.song, ids:[], decision:null, winner:null });
    groups.get(k).ids.push(id);
  }
  room.groups = Array.from(groups.values());
  room.revealShown = false;
  room.phase = 'decide';
}

function doConfirm(room){
  const losers = [];
  for (const g of room.groups){
    const winner = g.winner || (g.decision === 'solo' && g.ids.length === 1 ? g.ids[0] : null);
    if (!winner) throw new Error('すべての曲について当選者を決定してください。');
    room.acquired.push({ round: room.round, id: winner, song: g.song });
    for (const id of g.ids) if (id !== winner) losers.push(id);
  }

  room.groups = [];
  room.revealOrder = [];
  room.revealIndex = 0;
  room.revealShown = false;
  room.currentLotteryKey = null;
  room.subs = {};
  if (!activeIds(room).length){
    finishRoom(room);
    return;
  }

  if (losers.length){
    room.pending = losers.filter(id => {
      const p = room.players.find(x=>x.id===id);
      return p && !p.ended;
    });
    room.wave += 1;
    room.phase = room.pending.length ? 'input' : 'input';
  } else if (room.round >= room.rounds){
    finishRoom(room);
  } else {
    room.round += 1;
    room.wave = 1;
    room.phase = 'input';
    room.pending = activeIds(room);
  }
}

function maybeEnterReveal(room){
  if (room.status !== 'playing' || room.phase !== 'input') return;
  if (room.pending.length === 0){
    if (!activeIds(room).length) finishRoom(room);
    return;
  }
  if (room.pending.every(id => room.subs[id])) enterReveal(room);
}

/* ---------- API ---------- */
const api = {
  create(body){
    const cap    = Math.max(2, Math.min(MAX_PLAYERS, parseInt(body.cap, 10) || MAX_PLAYERS));
    const rounds = Math.max(1, Math.min(20, parseInt(body.rounds, 10) || 5));
    const mode   = body.mode === 'manual' ? 'manual' : 'auto';
    const room = {
      code: newCode(), hostToken: token(), cap, rounds, mode,
      status:'lobby', round:1, wave:1, phase:'input',
      players:[], pending:[], subs:{}, groups:[], revealOrder:[], revealIndex:0, revealShown:false, currentLotteryKey:null,
      acquired:[], clients:new Set(), v:0, touched:Date.now()
    };
    rooms.set(room.code, room);
    console.log(`部屋を作成： ${room.code}（定員${cap}名・${rounds}巡）`);
    return {ok:true, code:room.code, token:room.hostToken, role:'host'};
  },

  join(body){
    const room = findRoom(body.code);
    if (!room) return {ok:false, error:'その番号の部屋は見つかりません。番号を確かめてください。'};
    if (room.status !== 'lobby') return {ok:false, error:'この会議はすでに始まっています。'};
    const name = String(body.name || '').trim().slice(0,12);
    if (!name) return {ok:false, error:'ペンネームを入力してください。'};
    if (room.players.length >= room.cap) return {ok:false, error:`定員（${room.cap}名）に達しています。`};
    if (room.players.some(p=>p.name===name)) return {ok:false, error:'そのペンネームは使われています。別の名前にしてください。'};
    const p = {id:token().slice(0,8), name, token:token(), ended:false};
    room.players.push(p);
    broadcast(room);
    return {ok:true, code:room.code, token:p.token, id:p.id, role:'player'};
  },

  start(room){
    if (room.status !== 'lobby') return {ok:false,error:'すでに開始しています。'};
    if (room.players.length < 2) return {ok:false,error:'2名以上で開始できます。'};
    room.status='playing'; room.round=1; room.wave=1; room.phase='input';
    room.players.forEach(p=>p.ended=false);
    room.pending=activeIds(room); room.subs={}; room.groups=[]; room.revealOrder=[]; room.revealIndex=0; room.revealShown=false; room.currentLotteryKey=null; room.acquired=[];
    broadcast(room);
    return {ok:true};
  },

  submit(room, player, body){
    if (room.status!=='playing' || room.phase!=='input') return {ok:false,error:'いまは指名を受け付けていません。'};
    if (player.ended) return {ok:false,error:'あなたは指名終了を選択しています。'};
    if (!room.pending.includes(player.id)) return {ok:false,error:'この巡の指名はすでに終わっています。'};
    const song=String(body.song||'').trim().slice(0,60);
    if(!song) return {ok:false,error:'曲名を入力してください。'};
    if(room.acquired.some(a=>norm(a.song)===norm(song))) return {ok:false,error:'その曲はすでに獲得されています。別の曲を選んでください。'};
    room.subs[player.id]={round:room.round,wave:room.wave,song};
    maybeEnterReveal(room);
    broadcast(room);
    return {ok:true,song};
  },

  finish(room, player){
    if (room.status!=='playing' || room.phase!=='input') return {ok:false,error:'いまは指名終了を受け付けていません。'};
    if (player.ended) return {ok:false,error:'すでに指名終了しています。'};
    const idx=room.pending.indexOf(player.id);
    if(idx<0) return {ok:false,error:'この巡の指名はすでに終わっています。'};
    delete room.subs[player.id];
    player.ended=true;
    room.pending.splice(idx,1);
    if (!activeIds(room).length){
      finishRoom(room);
    } else {
      maybeEnterReveal(room);
    }
    broadcast(room);
    return {ok:true};
  },

  revealSong(room){
    if(room.phase!=='reveal') return {ok:false,error:'いまは指名発表中ではありません。'};
    if(!room.revealOrder.length) return {ok:false,error:'表示する指名がありません。'};
    room.revealShown = true;
    broadcast(room);
    return {ok:true};
  },

  nextReveal(room){
    if(room.phase!=='reveal') return {ok:false,error:'いまは指名発表中ではありません。'};
    if(!room.revealOrder.length) { buildGroups(room); broadcast(room); return {ok:true}; }
    if(room.revealIndex < room.revealOrder.length-1){
      room.revealIndex += 1;
      room.revealShown = false;
    } else {
      buildGroups(room);
    }
    broadcast(room);
    return {ok:true};
  },

  decision(room, body){
    if(room.phase!=='decide') return {ok:false,error:'いまは単独指名を指定する段階ではありません。'};
    const g=room.groups.find(x=>x.key===body.key);
    if(!g) return {ok:false,error:'その曲の指定が見つかりません。'};
    const mode=body.mode==='solo'?'solo':body.mode==='clear'?'clear':null;
    if(!mode) return {ok:false,error:'指定方法が正しくありません。'};
    g.decision = mode==='solo' ? 'solo' : null;
    g.winner = mode==='solo' && g.ids.length===1 ? g.ids[0] : null;
    broadcast(room);
    return {ok:true};
  },

  startLottery(room){
    if(room.phase!=='decide') return {ok:false,error:'いまは抽選候補を決める段階ではありません。'};
    // 「単独指名」に指定されていない楽曲はすべて抽選候補へ回す。
    for(const g of room.groups){
      if(g.decision!=='solo'){
        g.decision='lottery';
        g.winner=null;
      }
    }
    room.currentLotteryKey=null;
    room.phase='lottery';
    broadcast(room);
    return {ok:true};
  },

  selectLottery(room, body){
    if(room.phase!=='lottery') return {ok:false,error:'いまは抽選する楽曲を選ぶ段階ではありません。'};
    const g=room.groups.find(x=>x.key===body.key && x.decision==='lottery');
    if(!g) return {ok:false,error:'その楽曲は抽選候補にありません。'};
    if(g.winner) return {ok:false,error:'その楽曲はすでに抽選済みです。'};
    room.currentLotteryKey=g.key;
    broadcast(room);
    return {ok:true,key:g.key};
  },

  winner(room, body){
    if(room.phase!=='decide' && room.phase!=='lottery') return {ok:false,error:'いまは獲得者を決める段階ではありません。'};
    const c=room.groups.find(x=>x.key===body.key);
    if(!c) return {ok:false,error:'その曲の決定が見つかりません。'};
    if(c.winner) return {ok:false,error:'すでに獲得者が決まっています。'};
    if(!c.ids.includes(body.playerId)) return {ok:false,error:'その参加者は候補にいません。'};
    if(room.phase==='decide' && c.decision!=='solo') return {ok:false,error:'単独指名に指定した楽曲だけ獲得者を決められます。'};
    if(room.phase==='lottery' && (c.decision!=='lottery' || room.currentLotteryKey!==c.key)) return {ok:false,error:'先にこの楽曲を抽選対象として選択してください。'};
    c.winner=body.playerId;
    if(room.phase==='lottery') room.currentLotteryKey=null;
    broadcast(room);
    return {ok:true,winner:c.winner};
  },

  confirm(room){
    if(room.phase!=='lottery') return {ok:false,error:'いまは結果を確定できません。'};
    const lottery = room.groups.filter(g=>g.decision==='lottery');
    if(lottery.length && lottery.some(g=>!g.winner)) return {ok:false,error:'すべての抽選候補の当選者を決定してください。'};
    if(room.groups.some(g=>g.decision==='solo' && !g.winner)) return {ok:false,error:'単独指名にした楽曲の獲得者が未決定です。'};
    doConfirm(room);
    broadcast(room);
    return {ok:true};
  },

  reset(room){
    room.status='lobby'; room.round=1; room.wave=1; room.phase='input';
    room.players.forEach(p=>p.ended=false);
    room.pending=[]; room.subs={}; room.groups=[]; room.revealOrder=[]; room.revealIndex=0; room.revealShown=false; room.currentLotteryKey=null; room.acquired=[];
    broadcast(room);
    return {ok:true};
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

      const hostOnly = ['start', 'revealSong', 'nextReveal', 'decision', 'startLottery', 'selectLottery', 'winner', 'confirm', 'reset'];
      if (hostOnly.includes(action)){
        if (!isHost(room, body.token)) return send(res, 403, { ok: false, error: 'ホストだけが操作できます。' });
        return send(res, 200, api[action](room, body));
      }
      if (action === 'submit'){
        const pl = playerOf(room, body.token);
        if (!pl) return send(res, 403, { ok: false, error: 'この部屋に参加していません。' });
        return send(res, 200, api.submit(room, pl, body));
      }
      if (action === 'finish'){
        const pl = playerOf(room, body.token);
        if (!pl) return send(res, 403, { ok: false, error: 'この部屋に参加していません。' });
        return send(res, 200, api.finish(room, pl));
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
