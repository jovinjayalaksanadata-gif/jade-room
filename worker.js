// Jade Mahjong – server room skor bersama (Cloudflare Workers + Durable Objects).
// Satu room = satu Durable Object. Pembuat room menyimpan skor (PUT dengan X-Host-Key),
// penonton menerima pembaruan langsung lewat WebSocket. Room hilang sendiri 12 jam setelah update terakhir.
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
  view(r) { return { type: 'state', code: r.code, state: r.state, updated: r.updated }; }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const room = await this.ctx.storage.get('room');

    if (path === '/init') {
      if (room) return json(409, { error: 'exists' });
      const { code, state } = await req.json();
      const now = Date.now(), key = randomKey();
      await this.ctx.storage.put('room', { code, key, state, created: now, updated: now });
      await this.ctx.storage.setAlarm(now + TTL);
      return json(201, { code, key });
    }

    if (!room) return json(404, { error: 'Room tidak ditemukan atau sudah berakhir.' });

    if (path === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'Butuh WebSocket.' });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.view(room)));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (req.method === 'GET') return json(200, { ...this.view(room), viewers: this.viewers() });

    // hanya pembuat room (pemegang kunci) yang boleh mengubah atau menutup
    if (!sameKey(req.headers.get('X-Host-Key'), room.key)) return json(403, { error: 'Hanya pembuat room yang bisa mengubah skor.' });

    if (req.method === 'PUT') {
      const body = await readBody(req);
      room.state = body.state ?? null; room.updated = Date.now();
      await this.ctx.storage.put('room', room);
      await this.ctx.storage.setAlarm(room.updated + TTL);
      this.broadcast(this.view(room));
      return json(200, { ok: true, viewers: this.viewers() });
    }
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
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {} }
  webSocketError() {}
}
