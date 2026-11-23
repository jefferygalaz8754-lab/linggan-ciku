/**
 * 音频试听解析模块（全曲 YouTube ID + iTunes 30 秒官方片段兜底）
 * 每日早 8 点生成新期次时自动为每首通过核验的歌曲补全可试听链接
 */

const ITUNES_SEARCH = 'https://itunes.apple.com/search';

export async function resolveItunesPreview(title, artist) {
  try {
    const params = new URLSearchParams({
      term: `${title} ${artist}`,
      media: 'music',
      entity: 'song',
      limit: '3',
      country: 'US'
    });
    const res = await fetch(`${ITUNES_SEARCH}?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data.results || []).find((r) => r.previewUrl);
    if (!hit) return null;
    return {
      previewUrl: hit.previewUrl,
      appleMusicUrl: hit.trackViewUrl || ''
    };
  } catch {
    return null;
  }
}

export function extractYoutubeId(urlOrId = '') {
  const s = String(urlOrId || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}
