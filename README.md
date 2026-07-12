# 一级信息流 / Primary Newsflow

一个面向日常阅读的实时信息流，聚合全球与中国的 **AI、时事、社会、科技、经济与公共事务新闻**。

核心原则：

- 外文新闻显示简短中文机器翻译，同时保留原文标题；
- 点击新闻卡片始终打开发布机构的原始页面；
- 优先使用政府、国际组织、研究机构、主流媒体和官方公司博客；
- 单个信源失效不会阻断整站更新，但整体质量低于健康阈值时停止部署。

## 板块

- **AI 情报**：全球 AI 公司、研究机构、论文与科技媒体；
- **中国要闻**：中国时政、地方、社会及中国相关英文报道；
- **全球信息流**：国际时事、经济、监管、科学、健康、能源和科技；
- **实时导航**：常用新闻、金融市场和事件监测入口。

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

缓存不会提交到 Git，但 GitHub Actions 会跨构建恢复缓存。翻译服务异常时，构建仍会保留原文，不会把翻译链接当作新闻链接。

可用环境变量：

```bash
TRANSLATION_ENABLED=0 npm run build       # 临时关闭翻译
MAX_TRANSLATIONS_PER_BUILD=300 npm run build
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
- 外文标题中文短译覆盖率；
- 新闻卡片仍然指向原始发布机构；
- 日常信息流不混入超过 10 天的陈旧内容或来源不明的无日期内容；
- 中国板块保有足够的中文实时报道。

## 自动更新与部署

`.github/workflows/deploy.yml` 会：

1. 每小时或在 `main` 分支推送时运行；
2. 抓取信源；
3. 生成外文标题中文短译；
4. 验证数据健康；
5. 部署 `public/` 到 GitHub Pages。

## 主要文件

```text
build.mjs                     抓取、去重、排序、翻译和健康检查
sources.json                  信源、板块和实时导航配置
public/index.html             页面结构
public/app.js                 信息流交互和双语展示
public/style.css              页面样式
serve.mjs                     本地静态服务器
.github/workflows/deploy.yml  每小时构建与 GitHub Pages 部署
```
