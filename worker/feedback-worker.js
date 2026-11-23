/**
 * Cloudflare Worker + KV：跨设备同步点赞、两级差评与单句灵感本
 * 供前端读写，并供 GitHub Actions 每日早 8 点拉取偏好（最多 50% 席位倾斜 + 差评屏蔽）
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/state') {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (env.API_TOKEN) {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.API_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
    }

    const key = 'linggan_ciku_user_state_v1';

    if (request.method === 'GET') {
      const raw = await env.LINGGAN_KV.get(key);
      return new Response(
        raw || JSON.stringify({ likedSongs: [], likedQuotes: [], notes: [], dislikes: [], likedEmotions: [], likedTechniques: [] }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      await env.LINGGAN_KV.put(key, JSON.stringify({ ...body, updatedAt: new Date().toISOString() }));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
};
