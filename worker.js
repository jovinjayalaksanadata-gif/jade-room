// Jade Mahjong – server room skor bersama (Cloudflare Workers + Durable Objects).
// Satu room = satu Durable Object. Semua pemain yang tahu kodenya boleh mencatat skor (PUT dengan versi),
// semua HP menerima pembaruan langsung lewat WebSocket. Hanya pembuat (X-Host-Key) yang bisa menutup room.
// Juga: POST /api/scan membaca foto tiles (Gemini bila ada GEMINI_API_KEY, kalau tidak Workers AI). Room hilang sendiri 12 jam setelah update terakhir.
import { DurableObject } from 'cloudflare:workers';

const TTL = 12 * 3600e3;
const MAX_BODY = 512 * 1024;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // tanpa 0/O, 1/I/L

const cors = origin => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Host-Key',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});
const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});

function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  let c = ''; for (const x of b) c += ALPHABET[x % ALPHABET.length];
  return c;
}
function randomKey() {
  return [...crypto.getRandomValues(new Uint8Array(18))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function readBody(req) {
  const len = +req.headers.get('content-length') || 0;
  if (len > MAX_BODY) throw Object.assign(new Error('Data terlalu besar.'), { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('Data terlalu besar.'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Format data salah.'), { status: 400 }); }
}


/* ---------- baca foto tiles ---------- */
const TILE_CODES = new Set(['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s','3s','4s','5s','6s','7s','8s','9s','E','S','W','N','C','F','P','f1','f2','f3','f4','e1','e2','e3','e4','a1','a2','a3','a4','J']);
const SCAN_PROMPT = `You are reading a photo of mahjong tiles laid face-up on a table (Hong Kong / Chinese style set).
List EVERY face-up tile, left to right, top row first. Use only these codes:
- Characters (wan): a Chinese numeral 一二三四五六七八九 above the character 萬 -> 1m 2m 3m 4m 5m 6m 7m 8m 9m
- Dots / circles: count the circles -> 1p ... 9p
- Bamboo / sticks: count the sticks; the 1 of bamboo is usually a bird -> 1s ... 9s
- Winds: 東 -> E, 南 -> S, 西 -> W, 北 -> N
- Dragons: red 中 -> C, green 發 -> F, white dragon (blank face or an empty blue frame) -> P
- Flowers 梅 蘭 菊 竹 (plum, orchid, chrysanthemum, bamboo flower; often with a small number 1-4) -> f1 f2 f3 f4
- Seasons 春 夏 秋 冬 -> e1 e2 e3 e4
- Animal tiles: cat -> a1, mouse/rat -> a2, rooster -> a3, centipede -> a4
- Joker tile -> J
Count identical tiles carefully; a winning hand usually has 14 tiles (more if it has kongs or flowers).
Only list tiles you can actually see in THIS photo. Never guess or invent tiles.
Ignore face-down tiles and anything that is not a mahjong tile.
If the photo shows no readable mahjong tiles, answer {"tiles":[]}.
Answer with JSON only, no other text, in the form {"tiles":[...codes...]}`;

function parseTiles(text) {
  if (!text) return [];
  if (typeof text !== 'string') text = JSON.stringify(text);
  const m = text.match(/\{[\s\S]*\}/);
  let list = [];
  try { list = JSON.parse(m ? m[0] : text).tiles || []; } catch { list = text.match(/\b([1-9][mps]|[ESWNCFPJ]|[fea][1-4])\b/g) || []; }
  return list.map(t => String(t).trim()).map(t => /^[1-9][MPS]$/.test(t) ? t.toLowerCase() : t).filter(t => TILE_CODES.has(t)).slice(0, 22);
}

async function scanGemini(env, mime, b64) {
  const model = env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: SCAN_PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  return parseTiles(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
}

async function scanWorkersAI(env, dataUrl, bytes) {
  try {
    const out = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [{ role: 'user', content: [{ type: 'text', text: SCAN_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      max_tokens: 400, temperature: 0,
    });
    const t = parseTiles(out?.response ?? out);
    if (t.length) return t;
  } catch (e) { /* coba model cadangan */ }
  const run = () => env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { messages: [{ role: 'user', content: SCAN_PROMPT }], image: [...bytes], max_tokens: 400, temperature: 0 });
  let out;
  try { out = await run(); } catch (e) {
    if (!/agree/i.test(String(e && e.message))) throw e;
    await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' }); out = await run(); // persetujuan lisensi Meta, sekali saja
  }
  return parseTiles(out?.response ?? out);
}

async function handleScan(req, env) {
  const len = +req.headers.get('content-length') || 0;
  if (len > 2.5e6) return json(413, { error: 'Foto terlalu besar.' });
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Format data salah.' }); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
  if (!m) return json(400, { error: 'Foto tidak terbaca.' });
  const bytes = Uint8Array.from(atob(m[2]), ch => ch.charCodeAt(0));
  const errors = [];
  if (env.GEMINI_API_KEY) { try { const t = await scanGemini(env, m[1], m[2]); if (t.length) return json(200, { tiles: t, engine: 'gemini' }); errors.push('gemini: kosong'); } catch (e) { errors.push(String(e.message || e)); } }
  if (env.AI) { try { const t = await scanWorkersAI(env, body.image, bytes); if (t.length) return json(200, { tiles: t, engine: 'workers-ai' }); errors.push('workers-ai: kosong'); } catch (e) { errors.push('workers-ai: ' + String(e.message || e)); } }
  if (!env.GEMINI_API_KEY && !env.AI) return json(503, { error: 'Pembaca foto belum diatur di server.' });
  return json(422, { error: 'Tiles tidak terbaca. Coba foto lagi lebih dekat dan terang.', detail: errors });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = (env.ALLOW_ORIGINS || '*').split(',').map(s => s.trim());
    const origin = req.headers.get('Origin');
    const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const h = cors(allowOrigin);
    const withCors = res => {
      if (res.status === 101) return res; // WebSocket
      const r = new Response(res.body, res);
      for (const [k, v] of Object.entries(h)) r.headers.set(k, v);
      return r;
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (url.pathname === '/' || url.pathname === '/health') return withCors(json(200, { ok: true, service: 'Jade Mahjong room' }));

    try {
      if (url.pathname === '/api/scan' && req.method === 'POST') return withCors(await handleScan(req, env));
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readBody(req);
        for (let i = 0; i < 5; i++) {
          const code = newCode();
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          const res = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, state: body.state ?? null }) });
          if (res.status !== 409) return withCors(res);
        }
        return withCors(json(503, { error: 'Coba lagi sebentar.' }));
      }

      const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,8})(\/ws)?$/);
      if (!m) return withCors(json(404, { error: 'not found' }));
      const code = m[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const inner = new Request('https://room/' + (m[2] ? 'ws' : 'room'), req);
      return withCors(await stub.fetch(inner));
    } catch (e) {
      return withCors(json(e.status || 500, { error: e.message || 'Server error' }));
    }
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // balas "ping" tanpa membangunkan objek (hemat kuota)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  viewers() { return this.ctx.getWebSockets().length; }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch {} }
  }
  view(r) { return { type: 'state', code: r.code, state: r.state, updated: r.updated, ver: r.ver || 0, viewers: this.viewers() }; }
  presence(adj = 0) { this.broadcast({ type: 'presence', viewers: Math.max(0, this.viewers() + adj) }); }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const room = await this.ctx.storage.get('room');

    if (path === '/init') {
      if (room) return json(409, { error: 'exists' });
      const { code, state } = await req.json();
      const now = Date.now(), key = randomKey();
      await this.ctx.storage.put('room', { code, key, state, created: now, updated: now, ver: 0 });
      await this.ctx.storage.setAlarm(now + TTL);
      return json(201, { code, key });
    }

    if (!room) return json(404, { error: 'Room tidak ditemukan atau sudah berakhir.' });

    if (path === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'Butuh WebSocket.' });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.view(room)));
      this.presence();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (req.method === 'GET') return json(200, { ...this.view(room), viewers: this.viewers() });

    // semua pemain boleh mencatat; versi mencegah dua HP saling menimpa
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!body.state || typeof body.state !== 'object') return json(400, { error: 'Data skor kosong.' });
      const cur = room.ver || 0;
      if (body.base !== undefined && body.base !== cur) return json(409, { error: 'Skor sudah diubah pemain lain.', state: room.state, ver: cur, updated: room.updated });
      room.state = body.state; room.updated = Date.now(); room.ver = cur + 1;
      await this.ctx.storage.put('room', room);
      await this.ctx.storage.setAlarm(room.updated + TTL);
      this.broadcast(this.view(room));
      return json(200, { ok: true, ver: room.ver, viewers: this.viewers() });
    }
    // hanya pembuat room (pemegang kunci) yang boleh menutup
    if (!sameKey(req.headers.get('X-Host-Key'), room.key)) return json(403, { error: 'Hanya pembuat room yang bisa menutup room.' });
    if (req.method === 'DELETE') {
      await this.close();
      return json(200, { ok: true });
    }
    return json(405, { error: 'method not allowed' });
  }

  async close() {
    this.broadcast({ type: 'closed' });
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'closed'); } catch {} }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  async alarm() { await this.close(); }

  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {} this.presence(-1); }
  webSocketError() {}
}
