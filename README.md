# 一级信息流 / Primary Newsflow

一个面向日常阅读的实时信息流，聚合全球与中国的 **AI、时事、社会、科技、经济与公共事务新闻**。

线上地址：<https://news.calvinsfweb.top>

核心原则：

- 外文新闻显示简短中文机器翻译，同时保留原文标题；
- 点击新闻卡片始终打开发布机构的原始页面；
- 优先使用政府、国际组织、研究机构、主流媒体和官方公司博客；
- 单个信源失效不会阻断整站更新，但整体抓取质量低于健康阈值时停止部署；
- 翻译服务被限流或拦截时保留已有中文标题，继续发布信息流，并在日志里写明原因；
- 大板块首屏分批渲染，可继续“加载更多”，并可展开查看每个信源的在线状态和当期条数；
- 提供 **Signal Console（高密度控制台）** 与 **Editorial Brief（编辑简报）** 两种可持久化切换的阅读模式；
- 支持紧凑/舒展密度切换、实时状态轨道、键盘快速导航与移动端侧栏。

## 板块

- **AI 情报**：全球 AI 公司、研究机构、论文与科技媒体；
- **中国要闻**：中国时政、地方、社会及中国相关英文报道；
- **全球信息流**：国际时事、经济、监管、科学、健康、能源和科技；
- **实时导航**：常用新闻、金融市场和事件监测入口。

## 前端交互

- **控制台 / 简报**：右上角切换两种结构化信息视图，选择会保存在浏览器中；
- **密度**：在紧凑与舒展显示之间切换；
- **1–4**：切换 AI、中国、全球和实时导航；
- **/**：聚焦搜索框；
- **V**：快速切换控制台与简报模式；
- 新闻条目始终直接打开原始发布机构页面。

## 本地运行

要求 Node.js 20 或更高版本。

```bash
npm install
npm run build
npm run serve
```

打开 `http://localhost:5173`。

### 使用本地代理

如果部分境外信源无法访问，先在同一个终端启用代理：

```bash
proxy_on
npm run build
```

`npm run build` 已启用 Node 的环境代理支持，会读取 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`；对于容易返回挑战页的 RSS，还会自动使用同一代理环境下的 `curl` 重试。

## 中文短译

构建时会为外文标题生成中文短译，并缓存到：

```text
.cache/translations.json
```

缓存不会提交到 Git。下一轮构建会把上一期 `public/data.json` 里已经译好的标题回灌进缓存，GitHub Actions 也会按 `translations-<os>-` 前缀恢复最近一次成功写入的缓存。

翻译按这个顺序尝试。某个服务返回限流、拒绝访问或挑战页时，会立刻换下一个，而不是把同一条失败重复打满：

1. Google Cloud Translation API v2，仅当设置了 `GOOGLE_TRANSLATE_API_KEY`；
2. Google Translate Element 使用的公开 `translate-pa.googleapis.com` 批量接口；
3. 旧的 `translate.googleapis.com`（`client=gtx`）；
4. MyMemory；
5. lingva.ml。

GitHub 托管运行器访问第 3 和第 5 个公开接口时，经常收到 HTTP 429 或 403。从 2026-11-03 起，这类失败被记成 `new=0 failed=…`，随后「至少 90% 外文标题已翻译」的检查失败，整站刷新停在最后一次成功的数据上。现在的约定是：

- 信源成功率、条目数量和时效不达标时，构建和测试仍然失败，不会部署；
- 翻译服务可用时，抽查的外文标题仍须有至少 90% 的中文短译，译文必须含汉字，链接仍指向原发布机构；
- 所有翻译服务都不可用时，保留缓存里的中文标题，继续发布信息流。`translation.degraded` 为 true，日志和 `translation.message` 会写明失败的服务，并提示可选的 API 密钥。

可选的 Actions secret：`GOOGLE_TRANSLATE_API_KEY`。这是 Cloud Translation API v2 的密钥。不设置时使用上面的公开接口。在仓库 Settings → Secrets and variables → Actions 里添加同名 secret 即可，工作流会把它注入 `process.env.GOOGLE_TRANSLATE_API_KEY`，不需要把密钥写进仓库。

可用环境变量：

```bash
TRANSLATION_ENABLED=0 npm run build       # 临时关闭翻译
MAX_TRANSLATIONS_PER_BUILD=300 npm run build
GOOGLE_TRANSLATE_API_KEY=... npm run build
GOOGLE_TRANSLATE_WIDGET_KEY=... npm run build  # 可选，覆盖内置的公开 widget key
MYMEMORY_EMAIL=... npm run build               # 可选，提高 MyMemory 免费额度
MIN_SOURCE_SUCCESS_RATE=0.65 npm run build
MIN_TOTAL_ITEMS=100 npm run build
```

## 验证

先构建，再执行：

```bash
npm test
```

测试会检查：

- 信源 ID、分类、板块与 URL 配置；
- AI、中国和全球三个板块的最低内容量；
- 构建健康状态；
- 外文标题的中文短译：服务可用时覆盖率至少 90%，服务整体不可用时检查降级说明、已保留的译文和原始链接；
- 新闻卡片仍然指向原始发布机构；
- 日常信息流不混入超过 10 天的陈旧内容或来源不明的无日期内容；
- 中国板块保有足够的中文实时报道。

## 自动更新与部署

当前生产站点部署在 Vercel：

- Vercel 项目：`calvincheng-ops-projects/primary-newsflow`；
- 构建命令：`npm run build`；
- 静态输出目录：`public/`；
- 自定义域名：`news.calvinsfweb.top`；
- DNSPod 中仅需为 `news` 添加 CNAME：`5c4749b098123dbe.vercel-dns-017.com`；
- 本地生产部署：`vercel --prod`。

`vercel.json` 固化了 Vercel 的构建命令和输出目录。`.vercel/` 与本地环境变量文件已加入 Git 忽略列表。

仓库中的 `.github/workflows/deploy.yml` 每小时抓取并验证信息流，然后提交更新后的 `public/data.json`；Vercel 已连接 GitHub 仓库，会自动部署该提交。当前对外访问地址以 Vercel 为准。

`.github/workflows/deploy.yml` 会：

1. 每小时或在 `main` 分支推送时运行；
2. 抓取信源；
3. 生成外文标题中文短译（公开接口失败时会降级并写明原因；可选 secret `GOOGLE_TRANSLATE_API_KEY`）；
4. 验证数据健康，信源质量不达标则停止；翻译服务整体不可用时不阻断发布；
5. 将更新后的 `public/data.json` 提交回 `main`，触发 Vercel 自动部署。

## 主要文件

```text
build.mjs                     抓取、去重、排序和健康检查
translate.mjs                 外文标题中文短译、缓存回灌和翻译降级
sources.json                  信源、板块和实时导航配置
public/index.html             页面结构
public/app.js                 信息流交互和双语展示
public/style.css              页面样式
serve.mjs                     本地静态服务器
vercel.json                   Vercel 构建命令与静态输出配置
public/CNAME                  自定义域名声明
.github/workflows/deploy.yml  每小时抓取、验证并提交最新数据
```
