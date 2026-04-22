const TILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BODY   = 50 * 1024 * 1024;
const ORIGIN     = 'https://graffiti.anita.garden';

const CORS = {
  'Access-Control-Allow-Origin':  ORIGIN,
  'Access-Control-Allow-Methods': 'GET, PUT',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url   = new URL(request.url);
    const parts = url.pathname.replace(/^\//, '').split('/');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
    }

    if (parts[0] !== 'paint' || !parts[1]) {
      return new Response('not found', { status: 404 });
    }

    const tileId = parts[1];
    if (!TILE_ID_RE.test(tileId)) {
      return new Response('invalid tileId', { status: 400 });
    }

    const key = `${tileId}.json`;

    if (request.method === 'GET') {
      const obj  = await env.PAINT.get(key);
      const body = obj ? await obj.text() : '{}';
      return new Response(body, {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BODY) return new Response('body too large', { status: 413 });
      try { JSON.parse(body); } catch { return new Response('invalid JSON', { status: 400 }); }
      await env.PAINT.put(key, body, { httpMetadata: { contentType: 'application/json' } });
      return new Response(null, { status: 204, headers: CORS });
    }

    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, PUT' } });
  },
};
