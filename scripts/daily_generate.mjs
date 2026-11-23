/**
 * 灵感词库 · 每日早 8 点自动更新脚本（D1 生产版）
 * 运行环境：Node.js 20+（零第三方依赖）
 *
 * 环境变量：
 *   GEMINI_API_KEY       必填，Google AI Studio / Gemini API Key
 *   GEMINI_MODEL         可选，默认 gemini-2.5-flash
 *   FEEDBACK_API_URL     可选，Cloudflare Worker 状态接口（如 https://xxx.workers.dev/api/state）
 *   FEEDBACK_API_TOKEN   可选，Worker 鉴权 Bearer Token
 *   TARGET_DATE          可选，指定生成日期 YYYY-MM-DD（默认按北京时间当天）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBlockedByKtvList, normalizeText, verifySongWithLrclib } from './verify_lyrics.mjs';
import { extractYoutubeId, resolveItunesPreview } from './resolve_audio.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const ISSUES_DIR = path.join(DATA_DIR, 'issues');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const BLACKLIST_PATH = path.join(__dirname, 'ktv_blacklist.json');

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function getBeijingDateParts(customDate) {
  if (customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
    const [y, m, d] = customDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const weekday = WEEKDAYS[dt.getUTCDay()];
    return {
      date: customDate,
      weekday,
      displayDate: `${y}年${m}月${d}日 ${weekday}`
    };
  }
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = cst.getUTCFullYear();
  const m = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(cst.getUTCDate()).padStart(2, '0');
  const weekday = WEEKDAYS[cst.getUTCDay()];
  return {
    date: `${y}-${m}-${d}`,
    weekday,
    displayDate: `${y}年${Number(m)}月${Number(d)}日 ${weekday}`
  };
}

async function loadHistory() {
  const files = await fs.readdir(ISSUES_DIR).catch(() => []);
  const songKeys = new Set();
  const quoteTexts = new Set();
  const neigongTitles = [];
  const allTitles = [];

  for (const file of files.filter((f) => f.endsWith('.json')).sort().reverse()) {
    const raw = await fs.readFile(path.join(ISSUES_DIR, file), 'utf8');
    const issue = JSON.parse(raw);
    for (const s of issue.songs || []) {
      songKeys.add(`${normalizeText(s.title)}::${normalizeText(s.artist)}`);
      allTitles.push(`${s.title} - ${s.artist}`);
    }
    for (const q of issue.quotes || []) {
      quoteTexts.add(normalizeText(q.text).slice(0, 24));
    }
    if (issue.neigong?.title) neigongTitles.push(issue.neigong.title);
  }
  return { songKeys, quoteTexts, neigongTitles, recentSongs: allTitles.slice(0, 400) };
}

async function fetchUserPreferences() {
  const url = process.env.FEEDBACK_API_URL;
  if (!url) return { likedEmotions: [], likedTechniques: [], blockedArtists: [], blockedTags: [] };

  try {
    const headers = {};
    if (process.env.FEEDBACK_API_TOKEN) {
      headers.Authorization = `Bearer ${process.env.FEEDBACK_API_TOKEN}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    const blockedArtists = (state.dislikes || [])
      .filter((d) => d.type === 'creator')
      .map((d) => d.value);
    const blockedTags = (state.dislikes || [])
      .filter((d) => d.type === 'content')
      .map((d) => d.value);
    return {
      likedEmotions: state.likedEmotions || [],
      likedTechniques: state.likedTechniques || [],
      blockedArtists,
      blockedTags
    };
  } catch (err) {
    console.warn('[preferences] 拉取云端偏好失败，回退默认均衡策略：', err.message);
    return { likedEmotions: [], likedTechniques: [], blockedArtists: [], blockedTags: [] };
  }
}

async function callGeminiJson(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('缺少环境变量 GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API 错误 (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function buildDailyPrompt({ dateInfo, history, blacklist, prefs }) {
  return `你是「灵感词库」的每日主编，请为 ${dateInfo.displayDate} 生成新一期内容，严格返回合法 JSON（不要 Markdown 包裹）。

【核心铁律】
1. 必须联网核验每一首歌词的真实原词，严禁凭记忆编造任何一句不存在的歌词；每首歌截取 2-3 个真实段落（8-12 行），附真实可打开的资料来源 URL。
2. 共 10 首歌：7 首中文 + 3 首外文（外文必须提供与 lines 一一对应的 translations 数组，长度严格一致）。
3. 中文选曲配比：
   - 港台流行顶级词作 3 首（林夕、黄伟文、葛大为、Hush、李焯雄、周耀辉等执笔的非 KTV 烂大街佳作）
   - 独立 / 摇滚 / 民谣 2 首
   - 近五年新人新作 2 首（如 deca joins、告五人、椅子乐团、老王乐队、洪佩瑜、LÜCY、傻子与白痴、单依纯等）
4. 硬排除清单（绝不可选）：${blacklist.blockedTitles.slice(0, 100).join('、')}
5. 历史已收录曲目（绝不可重复）：${history.recentSongs.slice(0, 120).join('；')}
6. 用户偏好约束：
   - 点赞偏好（最多倾斜 50% 席位，其余保留探索多样性）：情绪=${prefs.likedEmotions.join('、') || '无'}；技法=${prefs.likedTechniques.join('、') || '无'}
   - 严格屏蔽歌手/作者：${prefs.blockedArtists.join('、') || '无'}
   - 严格屏蔽技法/情绪：${prefs.blockedTags.join('、') || '无'}
7. 金句粮草库 20 条：以小说、散文、外国文学、纪实访谈、优质影视/网文为主（不要古诗词与现当代诗歌），单条 ≤ 200 字，每条标注双维度标签 emotion（情绪底色）与 technique（修辞/技法）。
8. 内功文章 1 篇：避开历史标题（${history.neigongTitles.slice(0, 30).join('、')}），聚焦一个具体作词技法，并与本期 2-3 首歌联动（在对应歌曲写入 neigongMatch: { note, highlightLines }）。

返回 JSON 结构：
{
  "date": "${dateInfo.date}",
  "weekday": "${dateInfo.weekday}",
  "displayDate": "${dateInfo.displayDate}",
  "issueLabel": "最新一期",
  "summary": "7 首中文 · 3 首外文附双语对照 · 20 条金句 · 1 篇内功",
  "neigong": {
    "date": "${dateInfo.date}",
    "title": "...",
    "coreTechnique": "...",
    "secondaryTechniques": ["...", "..."],
    "linkedSongIds": ["${dateInfo.date}-01", "${dateInfo.date}-02"],
    "excerpt": "...",
    "sections": [{ "heading": "...", "paragraphs": ["..."] }]
  },
  "songs": [
    {
      "id": "${dateInfo.date}-01",
      "index": "01",
      "title": "...",
      "artist": "...",
      "lyricist": "...",
      "language": "中文",
      "category": "港台流行顶级词作",
      "genreVertical": "六字内竖排流派",
      "emotion": "情绪底色",
      "technique": "修辞技法",
      "lines": ["..."],
      "translations": [],
      "reason": "1-2句编辑收录依据",
      "audio": { "youtubeId": "11位官方YouTube视频ID（若联网检索到则填，否则留空）", "previewUrl": "" },
      "verification": { "status": "verified", "method": "联网核验", "sourceName": "...", "sourceUrl": "https://..." }
    }
  ],
  "quotes": [
    {
      "id": "${dateInfo.date}-q01",
      "index": "01",
      "category": "文学摘录",
      "emotion": "情绪底色",
      "technique": "修辞技法",
      "text": "≤200字金句",
      "source": "作者 · 《作品名》"
    }
  ]
}`;
}

async function main() {
  const dateInfo = getBeijingDateParts(process.env.TARGET_DATE);
  const targetFile = path.join(ISSUES_DIR, `${dateInfo.date}.json`);

  try {
    await fs.access(targetFile);
    console.log(`[skip] ${dateInfo.date} 已存在，保持历史只增不改。`);
    return;
  } catch {
    // 继续生成当天期次
  }

  const blacklist = JSON.parse(await fs.readFile(BLACKLIST_PATH, 'utf8'));
  const history = await loadHistory();
  const prefs = await fetchUserPreferences();

  console.log(`[generate] 开始生成 ${dateInfo.displayDate} 期次...`);
  const draft = await callGeminiJson(buildDailyPrompt({ dateInfo, history, blacklist, prefs }));

  // 校验歌曲：黑名单 + 历史查重 + 屏蔽规则 + LRCLIB 原词核验
  const validSongs = [];
  const rejected = [];

  for (const song of draft.songs || []) {
    const key = `${normalizeText(song.title)}::${normalizeText(song.artist)}`;
    const ktvCheck = isBlockedByKtvList(song.title, song.artist, blacklist);
    if (ktvCheck.blocked) {
      rejected.push({ song: song.title, reason: ktvCheck.reason });
      continue;
    }
    if (history.songKeys.has(key)) {
      rejected.push({ song: song.title, reason: '与历史期次重复' });
      continue;
    }
    if (prefs.blockedArtists.some((a) => normalizeText(a) === normalizeText(song.artist))) {
      rejected.push({ song: song.title, reason: '命中用户屏蔽歌手' });
      continue;
    }

    const verify = await verifySongWithLrclib(song);
    if (verify.ok) {
      song.verification = {
        status: 'verified',
        method: `LRCLIB 原词核验（命中 ${Math.round(verify.matchedRatio * 100)}%）`,
        sourceName: verify.sourceName,
        sourceUrl: verify.sourceUrl
      };
      const itunes = await resolveItunesPreview(song.title, song.artist);
      song.audio = {
        youtubeId: extractYoutubeId(song.audio?.youtubeId || ''),
        previewUrl: itunes?.previewUrl || '',
        appleMusicUrl: itunes?.appleMusicUrl || ''
      };
      validSongs.push(song);
    } else {
      rejected.push({ song: `${song.title} - ${song.artist}`, reason: verify.reason });
    }
  }

  console.log(`[verify] 初轮通过 ${validSongs.length} 首，淘汰 ${rejected.length} 首：`, rejected);

  if (validSongs.length < 6) {
    throw new Error(`原词核验通过数过低（仅 ${validSongs.length} 首），中止发布以防假词入库。`);
  }

  // 重新编号并过滤重复金句与超长金句
  draft.songs = validSongs.map((s, i) => ({
    ...s,
    id: `${dateInfo.date}-${String(i + 1).padStart(2, '0')}`,
    index: String(i + 1).padStart(2, '0')
  }));

  draft.quotes = (draft.quotes || [])
    .filter((q) => q.text && q.text.length <= 200 && !history.quoteTexts.has(normalizeText(q.text).slice(0, 24)))
    .slice(0, 20)
    .map((q, i) => ({
      ...q,
      id: `${dateInfo.date}-q${String(i + 1).padStart(2, '0')}`,
      index: String(i + 1).padStart(2, '0')
    }));

  await fs.writeFile(targetFile, JSON.stringify(draft, null, 2), 'utf8');

  // 更新 index.json
  const indexData = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  indexData.latest = dateInfo.date;
  indexData.updatedAt = new Date().toISOString();
  indexData.issues = [
    {
      date: dateInfo.date,
      displayDate: dateInfo.displayDate,
      neigongTitle: draft.neigong?.title || '',
      coreTechnique: draft.neigong?.coreTechnique || '',
      songCount: draft.songs.length,
      quoteCount: draft.quotes.length
    },
    ...(indexData.issues || []).filter((it) => it.date !== dateInfo.date)
  ];

  await fs.writeFile(INDEX_PATH, JSON.stringify(indexData, null, 2), 'utf8');
  console.log(`[done] 已写入 ${targetFile} 并更新 index.json`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
