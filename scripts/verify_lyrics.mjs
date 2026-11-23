/**
 * 歌词真实性核验与黑名单拦截模块（优化 A）
 * - 通过公开 LRCLIB API 交叉核验原词，拒绝模型凭记忆编造假词
 * - 严格执行：核验不通过直接淘汰重选，绝不静默伪造或篡改原词
 */

const LRCLIB_SEARCH = 'https://lrclib.net/api/search';

export function normalizeText(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[\s\u3000.,，。!?！？、;；:："'“”‘’()（）\[\]【】\-—~～]/g, '');
}

export function isBlockedByKtvList(title, artist, blacklistConfig) {
  const normTitle = normalizeText(title);
  const normArtist = normalizeText(artist);

  for (const allow of blacklistConfig.allowExceptions || []) {
    if (
      normalizeText(allow.title) === normTitle &&
      normalizeText(allow.artist) === normArtist
    ) {
      return { blocked: false, reason: `白名单放行：${allow.reason}` };
    }
  }

  for (const blockedTitle of blacklistConfig.blockedTitles || []) {
    if (normalizeText(blockedTitle) === normTitle) {
      return { blocked: true, reason: `命中 KTV 热歌硬排除清单：《${blockedTitle}》` };
    }
  }
  return { blocked: false };
}

/**
 * 调用 LRCLIB 核验单首歌词摘录的真实性
 * 返回 { ok, matchedRatio, matchedCount, totalLines, sourceName, sourceUrl, reason }
 */
export async function verifySongWithLrclib(song) {
  const lines = Array.isArray(song.lines) ? song.lines.filter((l) => l.trim().length > 0) : [];
  if (lines.length < 4) {
    return { ok: false, reason: `歌词行数不足（${lines.length} 行，至少需要 4 行）` };
  }

  const charCount = lines.join('').replace(/\s+/g, '').length;
  const minChars = song.language === '外文' ? 140 : 90;
  if (charCount < minChars) {
    return { ok: false, reason: `歌词字数不足（${charCount} 字符，低于下限 ${minChars}）` };
  }

  try {
    const query = new URLSearchParams({
      track_name: song.title,
      artist_name: song.artist
    });
    const res = await fetch(`${LRCLIB_SEARCH}?${query.toString()}`, {
      headers: { 'User-Agent': 'LingganCikuBot/1.0 (https://github.com)' }
    });
    if (!res.ok) {
      return { ok: false, reason: `LRCLIB 接口返回 ${res.status}` };
    }
    const candidates = await res.json();
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ok: false, reason: 'LRCLIB 未检索到该曲目记录' };
    }

    let bestRatio = 0;
    let bestCount = 0;
    let bestCandidate = null;

    for (const item of candidates.slice(0, 5)) {
      const plain = item.plainLyrics || item.syncedLyrics || '';
      if (!plain) continue;
      const normPlain = normalizeText(plain);

      let hits = 0;
      for (const line of lines) {
        const nl = normalizeText(line);
        if (nl.length >= 4 && normPlain.includes(nl)) {
          hits += 1;
        }
      }
      const ratio = hits / lines.length;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestCount = hits;
        bestCandidate = item;
      }
    }

    if (bestRatio >= 0.65 && bestCandidate) {
      return {
        ok: true,
        matchedRatio: Number(bestRatio.toFixed(2)),
        matchedCount: bestCount,
        totalLines: lines.length,
        sourceName: 'LRCLIB 原词库核验',
        sourceUrl: song.verification?.sourceUrl || `https://lrclib.net/api/get/${bestCandidate.id}`
      };
    }

    return {
      ok: false,
      matchedRatio: Number(bestRatio.toFixed(2)),
      reason: `LRCLIB 原词命中率过低（${Math.round(bestRatio * 100)}%，阈值 65%），疑似幻觉或版本错配`
    };
  } catch (err) {
    return { ok: false, reason: `核验网络异常：${err.message}` };
  }
}
