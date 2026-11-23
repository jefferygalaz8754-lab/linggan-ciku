# 灵感词库（优化版 A–E · D1 独立可上线架构）

基于克莱因蓝（`#3868B2`）刊物视觉基因构建的每日歌词摘录、金句粮草库与作词内功站点，采用**静态前端 + GitHub Actions 每日早 8 点自动生成 + 原词核验防假词 + 可选 Cloudflare Worker/KV 偏好回传**架构，脱离单一平台预览限制，可长期免费稳定运行。

## 包含的优化特性（A–E）
- **A. 防假词与来源核验**：`scripts/daily_generate.mjs` 调用 Gemini API（启用 Google Search Grounding），再经 `scripts/verify_lyrics.mjs` 对接公开 LRCLIB 原词库逐行交叉核验；核验不通过直接淘汰，绝不静默伪造。
- **B. 双维度作词标签与精准过滤**：每首歌词与金句均标注「情绪底色」+「修辞/技法」，支持首页快速筛选；两级差评（不喜欢此人 / 不喜欢此类技法与情绪）同步至屏蔽名单。
- **C. 三板块联动与创作闭环**：当期「内功」方法论与当期示范歌词高亮互跳；支持点击单句歌词写入「单句灵感本」加批注并一键导出 Markdown；内置全库跨期搜索（快捷键 `/` 或 `⌘K`）。
- **D1. 独立每日自动更新架构**：GitHub Actions 每日北京时间早 `08:00`（UTC `00:00`）自动运行，内置 150 首 KTV 热歌硬排除清单（含同名放行白名单）与全量历史查重。
- **E. 阅读体验精修**：外文歌词支持「分段对照 / 逐行双语」一键切换；桌面端右侧浮动 `01–10` 快速目录；`/likes` 支持歌词/金句/灵感批注分类 Tab 与屏蔽管理。

## 5 分钟上线部署步骤

### 1. 推送代码到 GitHub
新建一个 GitHub 仓库并推送本目录所有文件。

### 2. 配置 GitHub Secrets（驱动每日早 8 点自动更新）
进入仓库 `Settings → Secrets and variables → Actions`，添加：
- `GEMINI_API_KEY`（必填）：你的 Google AI Studio API Key。
- `FEEDBACK_API_URL`（可选）：如果你部署了第 4 步的 Cloudflare Worker，填入 `https://<你的worker域名>/api/state`。
- `FEEDBACK_API_TOKEN`（可选）：Worker 鉴权 Token。

可在仓库 `Actions → Daily Issue Update (08:00 CST)` 点击 **Run workflow** 立即手动测试一次。

### 3. 绑定 Cloudflare Pages 或 Vercel（1 分钟上线公网域名）
- **Cloudflare Pages**：连接该 GitHub 仓库，Build command 留空，Build output directory 填 `public`。
- **Vercel**：导入该仓库，Output Directory 填 `public`。
- 以后每天早 8 点 GitHub Actions 提交新的 `public/data/issues/YYYY-MM-DD.json` 后，网站会自动在 30 秒内重新部署上线。

### 4. （可选）部署 Cloudflare Worker 实现跨设备同步与次日 50% 偏好倾斜
```bash
cd worker
npx wrangler kv namespace create LINGGAN_KV
# 将生成的 id 填入 wrangler.toml，设置鉴权秘钥：
npx wrangler secret put API_TOKEN
npx wrangler deploy
```
部署完成后，在网站「我的点赞 → 云端同步设置」中填入 Worker URL 与 Token，即可将你的点赞、两级差评与灵感批注同步到云端，次日早 8 点定时任务会自动拉取并执行最多 50% 席位偏好倾斜与差评屏蔽。
