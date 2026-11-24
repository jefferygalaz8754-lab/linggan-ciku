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

// Only use official platform players; no proxying or bypassing paid audio.
export async function resolveAudioSources(title, artist, supplied = []) {
  const valid = (Array.isArray(supplied) ? supplied : []).filter(s =>
    (s.provider === 'spotify' && /^[a-zA-Z0-9]{22}$/.test(String(s.id))) ||
    (s.provider === 'netease' && /^\d+$/.test(String(s.id))) ||
    (s.provider === 'qq' && /^[a-zA-Z0-9]{10,20}$/.test(String(s.id))) ||
    (s.provider === 'bandcamp' && /^https:\/\/bandcamp\.com\/EmbeddedPlayer\/(album|track)=\d+/.test(s.embed || ''))
  );
  try {
    const params = new URLSearchParams({s:`${title} ${artist}`,type:'1',offset:'0',limit:'8'});
    const response = await fetch(`https://music.163.com/api/search/get/web?${params}`, {signal:AbortSignal.timeout(12000)});
    const data = await response.json();
    const normalize = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    const hit = (data.result?.songs || []).find(s => normalize(s.name)===normalize(title) && (s.artists || []).some(a=>normalize(a.name)===normalize(artist)));
    if (hit) {
      const rights=await fetch(`https://music.163.com/api/song/enhance/player/url?ids=${encodeURIComponent(JSON.stringify([hit.id]))}&br=128000`,{signal:AbortSignal.timeout(12000)});
      const track=(await rights.json()).data?.[0];
      if(track?.url && !track.freeTrialInfo) valid.push({provider:'netease',id:String(hit.id)});
    }
  } catch (error) { console.warn('[audio] 音频检索不可用：', error.name); }
  return valid;
}
