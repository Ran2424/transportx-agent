# 联网搜索（Aliyun OpenSearch Web Search）落地计划

> 状态：待评审
> 更新时间：2026-07-31
> 目标：在不破坏现有引用证据管线的前提下，把阿里云「AI 搜索开放平台 / 联网搜索服务」接入项目，使 Agent 可以在最终回答里把联网结果作为「第三方网页来源」与本地知识库、任务产物一同出现在 `[1][2][3]` 与「引用依据」面板中。

## 1. 要解决的问题

- 当前 Agent 的回答只能引用 **本地知识库**（`K-...`）和 **任务产物**（报告/PDF/文档/图片）。遇到法规最新版本、官方公告、实时数据（天气、客流、票价）等**会随时间漂移或不在本地库**的信息时，要么编造，要么放弃回答。
- 直接让 Agent 在回答里贴 URL 会带来四个问题：① Agent 可能虚构 URL；② 用户看到的是裸链接而不是统一引用编号；③ 没有落进 `toolResult.details`，刷新/恢复会话后丢失；④ 原网页后续失效时无法察觉。
- 阿里云 API Key 不应该进 React、不应该进 JSONL，否则会被前端和历史持久层带出去。
- 现有 `CitationEnvelope` 协议（`pi-citation/1.0`）已经覆盖 `pdf | document | image` × `knowledge | session` 的二维矩阵；联网搜索应当作为 **第三种 scope（`web`）** 与第四种 `kind（web）` 嵌入同一矩阵，复用同一条渲染管线。

## 2. 现状回顾（避免重复造轮子）

| 层 | 文件 | 现状 |
|---|---|---|
| 契约 | `src/contracts/citation.ts` | `CitationSource{Kind, Scope}` + `CitationLocator{page, section, sourceUnit, lineStart/End}` + `CitationRecord{knowledgeId, documentClass, normativeForce, verificationStatus}`；`parseCitationEnvelope` 严格校验 |
| Extension | `extensions/pi-citation/index.ts` | `tau_cite` 接收 `knowledgeIds[]` 或 `artifacts[]`，统一打包成 `CitationEnvelope` 写入 `toolResult.details` |
| Server 资源 | `src/server/citation-resources.ts` | `handleCitationResourceRoute` 按 `sourceId` 受控只读，按 `kind` 走 PDF 页 / 图片 / 文档正文 |
| Server 路由 | `src/server/api-routes.ts`、`router.ts` | 类型化 `ServerRouter`，单文件注册 |
| React 投影 | `src/web/features/citation/citation-projection.ts` | `projectMessageCitations` 把 `toolResult.details.citations` 投影到最终 assistant 消息；`citationCopyText` / `citationReferenceMarkdown` 统一渲染 |
| React 渲染 | `src/web/platform/conversation/ConversationWorkspace.tsx` | `CitationFooter` + `CitationEvidencePeek` + `MessageArtifacts`；`CITATION_CATEGORY_LABELS` 按 `documentClass` 显示中文分类 |

## 3. API 对齐（阿里云 AI 搜索开放平台 / 联网搜索）

来源：阿里云官方文档《AI 搜索开放平台 / 联网搜索》。本节是后续所有代码的真实数据来源。

### 3.1 请求

```text
POST {host}/v3/openapi/workspaces/{workspace_name}/web-search/{service_id}
```

| Header | 类型 | 必填 | 说明 |
|---|---|---|---|
| `Content-Type` | String | 是 | `application/json` |
| `Authorization` | String | 是 | `Bearer {API_KEY}`，API-KEY 前缀形如 `OS-d1**2a` |

| Body 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | String | 是 | — | 搜索词，≤200 字符 |
| `query_rewrite` | Boolean | 否 | `true` | 是否启用 LLM 对 query 进行重写 |
| `top_k` | Integer | 否 | `5` | 返回结果数，本项目上限 `20` |
| `history` | List | 否 | `null` | 对话历史，每项 `{"role": "system"|"user"|"assistant", "content": "..."}`；system 必须且只能在第一条 |
| `content_type` | String | 否 | `snippet` | `snippet` 短描述 / `summary` 摘要 / `mainText` 正文（≤3000 字） |

Curl 示例：

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  "${HOST}/v3/openapi/workspaces/${WORKSPACE}/web-search/ops-web-search-001" \
  -d '{"query":"杭州今日天气","query_rewrite":true,"top_k":5,"content_type":"snippet"}'
```

### 3.2 响应

成功：

```json
{
  "result": {
    "search_result": [
      {
        "title":  "杭州天气",
        "link":   "https://www.hzqx.com/pc/hztq/",
        "snippet":"今天夜里多云；明天晴到多云……",
        "content":"杭州天气\n今天夜里多云……",
        "position": 3
      }
    ]
  },
  "usage": {
    "search_count": 1,
    "rewrite_model":  { "input_tokens": 249, "output_tokens": 1,   "total_tokens": 250 },
    "filter_model":   { "input_tokens":1804, "output_tokens": 216, "total_tokens":2020 }
  }
}
```

> 文档里 `title` 字段名写作 `tilte`（拼写错误）。本项目在适配层做字段归一化：服务端收到 `tilte` → 归一化为 `title`，避免把官方笔误带进项目协议。

失败：

```json
{
  "request_id":"6F33AFB6-A35C-****-AFD2-9EA16CCF4383",
  "latency":   2.0,
  "code":      "InvalidParameter",
  "http_code": 400,
  "message":   "JSON parse error: ..."
}
```

| HTTP | code | 含义 |
|---|---|---|
| 200 | — | 成功（注意：即便返回 200，也要在 `result` 上做空值判断） |
| 400 | `InvalidParameter` | 参数不合法 |
| 404 | `BadRequest.TaskNotExist` | 任务不存在 |
| 500 | `InternalServerError` | 服务端错误 |

### 3.3 本项目对入参的映射

| 模型侧 `tau_web_search` 字段 | 阿里云 Body 字段 | 默认值 |
|---|---|---|
| `query` | `query` | 必填 |
| `topK` | `top_k` | `5`（上限 `20`） |
| `queryRewrite` | `query_rewrite` | `true` |
| `contentType` | `content_type` | `snippet`（枚举：`snippet`/`summary`/`mainText`） |
| `history` | `history` | `undefined`（不传，避免把会话全文带给搜索服务） |
| `purpose` | — | 仅用于服务端日志，不透传 |

## 4. 总体思路

把 Web 搜索视为一种**来源类型**而不是一个独立功能。模型先调用 `tau_web_search` 拉回若干结果，再挑选要在最终回答里引用的几条传给 `tau_cite`，由 `tau_cite` 把它们转成与知识库、任务产物同形的 `CitationSource` / `CitationLocator` / `CitationRecord`，落进现有 `CitationEnvelope`，走同一渲染管线。

```text
┌──────────────────────────────────────────────────────────────────┐
│  Pi Agent  (extensions/pi-web-search/index.ts)                    │
│   1. tau_web_search(query)                                         │
│        ↓ HTTP /api/live-sessions/{id}/web-search                  │
│   2. Server web-search.ts                                         │
│        ↓ 代理 阿里云 OpenSearch Web Search (Bearer API_KEY)       │
│   3. Server 把响应规整为                                          │
│      { results: [{ title, url, snippet, content?, siteName?,     │
│                    publishedAt?, score? }] }                      │
│        ↓ 回到 Agent 的 toolResult.details                         │
│   4. 模型挑选条目 → tau_cite({ webResults: [...] })               │
│        ↓ 复用 extensions/pi-citation/index.ts                     │
│   5. tau_cite 把 webResults 转为 CitationEnvelope                 │
│      sources[].kind='web', scope='web'                            │
│      locators[].url / publishedAt / siteName                      │
│        ↓ 写入 toolResult.details (沿用 Pi JSONL)                  │
│   6. React 沿用 citation-projection.ts 把                          │
│      - 正文 [[cite:...]] 渲染为 [1]                                │
│      - 消息末尾 「引用依据」 新增 webSource 分组                   │
│      - 点击由 citation-resources.ts 代理抓取并清洗 HTML            │
└──────────────────────────────────────────────────────────────────┘
```

## 5. 契约层扩展（`src/contracts/citation.ts`）

保持 `pi-citation/1.0` 版本号不变（所有改动向后兼容）。扩展枚举与可选字段，老 envelope 仍然能解析。

```ts
export type CitationSourceKind = 'pdf' | 'document' | 'image' | 'web';
export type CitationSourceScope = 'knowledge' | 'session' | 'web';

export type CitationSource = {
  sourceId: string;
  kind: CitationSourceKind;
  scope: CitationSourceScope;
  title: string;
  relativePath?: string;          // 现有；scope='web' 时省略
  url?: string;                   // 新增；scope='web' 时必填
  mimeType: string;
  sha256: string;                 // scope='web' 时 = sha256(url + content)
};

export type CitationLocator = {
  locatorId: string;
  sourceId: string;
  quote?: string;
  nodeId?: string;
  clause?: string;
  section?: string;               // 复用：可放 URL 路径或 anchor
  page?: number;                  // web 不使用
  printedPage?: string;
  sourceUnit?: string;            // 复用：可放域名
  lineStart?: number;
  lineEnd?: number;
  publishedAt?: string;           // 新增；ISO-8601
  siteName?: string;              // 新增；出处域名/站点名
};

export type CitationRecord = {
  citationId: string;
  sourceId: string;
  locatorId: string;
  knowledgeId?: string;
  documentClass?: string;         // 新增 'WEB_SOURCE'
  normativeForce?: string;        // 新增 'informational'
  verificationStatus?: string;    // 新增 'web_fetched'
};
```

`parseCitationEnvelope` 的更新要点：

- `SOURCE_KINDS` / `SOURCE_SCOPES` 集合分别加入 `'web'`；
- 对 `sources[i]`：增加 `url` 可选字段；当 `scope === 'web'` 时校验 `url` 必填且命中 `^https?://[\w.-]+(/.*)?$`，`relativePath` 必为空；
- 对 `locators[i]`：增加 `publishedAt`（ISO-8601 字符串）和 `siteName`（≤200）可选字段；
- 对 `citations[i]`：新增枚举值校验；
- 上限保持 `sources<=50, locators<=100, citations<=100` 不变，避免被恶意放大。

## 6. 服务端实现

### 6.1 新文件 `src/server/web-search.ts`

**职责**：封装阿里云 Web Search 调用、SSRF 防御、字段归一化、内存缓存、错误归一。

```ts
// 关键类型与函数骨架（最终实现按本节约束）
export type WebSearchProvider = {
  endpoint: string;                       // {host} 的实际值
  workspace: string;                      // default
  serviceId: string;                      // ops-web-search-001
  apiKey: string;                         // OS-...，从 TAU_WEB_SEARCH_API_KEY 读
};

export type NormalizedSearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;                       // contentType='mainText'/'summary' 时才有
  siteName?: string;                      // 从 url 解析的注册域名
  publishedAt?: string;                   // 若接口后续扩展；当前为空
  score?: number;                         // position 倒序映射的简单分值
};

export type NormalizedSearchResponse = {
  results: NormalizedSearchResult[];
  usage: { searchCount: number; rewriteTokens?: number; filterTokens?: number };
  cached: boolean;
};

export async function webSearch(
  provider: WebSearchProvider,
  request: {
    query: string;
    topK?: number;            // 默认 5，上限 20
    queryRewrite?: boolean;   // 默认 true
    contentType?: 'snippet' | 'summary' | 'mainText';  // 默认 snippet
    history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  },
  options?: {
    signal?: AbortSignal;
    cacheTtlMs?: number;      // 默认 600_000 (10 分钟)
    timeoutMs?: number;       // 默认 8_000
    maxBytes?: number;        // 默认 5_242_880 (5MB)
  },
): Promise<NormalizedSearchResponse>;

export function buildWebSearchProviderFromEnv(env: NodeJS.ProcessEnv): WebSearchProvider | null;
```

**字段归一化（必须做的事）**：

- 阿里云返回的字段名是 `tilte`（拼写错误），要把它归一化为 `title`；
- `link` → `url`；
- `position`（1-based 召回顺序）→ 反向映射为 `score = 1 / position`，便于将来排序；
- `siteName` 从 `url` 用 `new URL(url).host` 派生，截断到 ≤200 字符；
- `snippet` 截断到 ≤2000 字符，`content` 截断到 ≤20000 字符（即便接口允许 3000，也再压一层避免污染引用 quote）。

**SSRF 防御（必须在 `fetch` 之前执行）**：

- 仅允许 `http`/`https`；
- 解析 `URL` 后调用 `dns.lookup(host, { all: true })`，对返回的每一个 IP 做白名单校验：必须不是 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`100.64.0.0/10`、`::1`、`fc00::/7`、`fe80::/10`；
- 命中任一内网地址 → 抛 `WebSearchError('blocked_host', 400)`；
- 跟随重定向时**必须重做一次 SSRF 校验**（最多 3 跳）。

**超时与体积**：

- `AbortController` + `setTimeout(timeoutMs)`；
- 响应 `Content-Length > maxBytes` 直接拒；
- 边读边累加，超过 `maxBytes` 立刻 abort。

**缓存**：

- 进程内 `Map<string, { value: NormalizedSearchResponse; expiresAt: number }>`；
- 缓存键 = `sha256(JSON.stringify({ query, topK, queryRewrite, contentType, history }))`，不含 API Key；
- 默认 10 分钟 TTL，可在测试里调成 0 关闭；
- 仅缓存**成功响应**，失败永远不缓存。

**错误归一**：

```ts
export class WebSearchError extends Error {
  constructor(
    public readonly code:
      | 'missing_api_key' | 'invalid_query' | 'invalid_content_type'
      | 'blocked_host'    | 'timeout'        | 'too_large'
      | 'provider_4xx'    | 'provider_5xx'   | 'provider_invalid_response',
    public readonly httpStatus: number,
    public readonly detail?: string,
  ) { super(`${code}${detail ? `: ${detail}` : ''}`); }
}
```

### 6.2 新增路由 `POST /api/live-sessions/{id}/web-search`

接入位置：`src/server/api-routes.ts` 的 `createApiRouter` 内新增一行：

```ts
.post(/^\/api\/live-sessions\/([^/]+)\/web-search$/, async ({ req, res, params, deps }) => {
  const session = resolveLiveSessionParam(res, params[0], deps);
  if (!session) return;
  try {
    const body = await deps.readBody(req);
    const provider = deps.webSearchProvider();          // 见 6.3
    if (!provider) return deps.json(res, 503, { error: 'Web search provider is not configured' });
    const normalized = webSearchRequestSchema.parse(body); // TypeBox 校验
    const response = await deps.webSearch(provider, normalized, { timeoutMs: 8_000, maxBytes: 5 * 1024 * 1024 });
    deps.json(res, 200, response);
  } catch (error) {
    if (error instanceof WebSearchError) return deps.json(res, error.httpStatus, { error: error.code, detail: error.detail });
    deps.json(res, 500, { error: deps.errorMessage(error) });
  }
})
```

请求体 TypeBox schema：

```ts
const WebSearchRequestSchema = Type.Object({
  query:         Type.String({ minLength: 1, maxLength: 200 }),
  topK:          Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  queryRewrite:  Type.Optional(Type.Boolean()),
  contentType:   Type.Optional(Type.Union([
                    Type.Literal('snippet'),
                    Type.Literal('summary'),
                    Type.Literal('mainText'),
                  ])),
  history:       Type.Optional(Type.Array(Type.Object({
                    role:    Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('assistant')]),
                    content: Type.String({ maxLength: 4000 }),
                  }), { maxItems: 20 })),
  purpose:       Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });
```

### 6.3 Provider 配置（`src/server/config.ts`）

```ts
export function loadWebSearchProvider(): WebSearchProvider | null {
  const apiKey = process.env.TAU_WEB_SEARCH_API_KEY || '';
  const endpoint = process.env.TAU_WEB_SEARCH_HOST || '';
  if (!apiKey || !endpoint) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    workspace: process.env.TAU_WEB_SEARCH_WORKSPACE || 'default',
    serviceId: process.env.TAU_WEB_SEARCH_SERVICE_ID || 'ops-web-search-001',
    apiKey,
  };
}
export const WEB_SEARCH_PROVIDER = loadWebSearchProvider();
```

`api-routes.ts` 的 `ApiRouteServices` 增加：

```ts
webSearchProvider(): WebSearchProvider | null;
webSearch(provider: WebSearchProvider, req: WebSearchRequest, opts?: WebSearchOptions): Promise<NormalizedSearchResponse>;
```

`server-main.ts` 在 `createApiRouter` 调用处注入：

```ts
webSearchProvider: () => WEB_SEARCH_PROVIDER,
webSearch: (provider, req, opts) => webSearch(provider, req, opts),
```

### 6.4 引用原件路由扩展（`src/server/citation-resources.ts`）

`handleCitationResourceRoute` 在 `findSource` 之后增加一个分支：当 `source.scope === 'web'` 时：

```ts
if (source.scope === 'web') {
  if (!source.url) return json(res, 400, { error: 'Web citation source has no URL' });
  if (match[3] === 'preview') return serveCitationWebPreview(res, source);
  return serveCitationWebContent(res, source);
}
```

两个新函数（写在同一文件）：

- `serveCitationWebContent(res, source)`：
  - 服务端 `fetch(source.url)`；
  - 复用 SSRF 防御（同一 `assertSafeUrl`）；
  - 命中 HTML：剥 `<script>`、`<iframe>`、`<noscript>`、`on*=` 属性、`javascript:` 协议；返回 `text/html; charset=utf-8`；
  - 命中非 HTML：原样转发 `Content-Type`，但若 `Content-Type` 是 `application/pdf`/图片等大对象则直接拒（不允许走 web 引用通道预览，提示「请用浏览器新窗口打开」）；
  - 头部加 `Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'`、`Cache-Control: private, max-age=600`、`X-Content-Type-Options: nosniff`；
  - 抓取失败 → `502 { error: 'web_source_unreachable' }`；
- `serveCitationWebPreview(res, source)`：
  - 与 `content` 一样，但走更严格 CSP + 截断为 ≤64KB 摘要；
  - 增加 `<base target="_blank">` 注入，让所有 `<a>` 强制新窗口打开，避免 iframe 内导航。

为了让 React 仍能在 `<FilePreview>` 框架里渲染 web 内容，需要在 `citationSourceUrl` 那条已存在的接口上加一个 `kind: 'web'` 的识别：

```ts
if (item.source.kind === 'web') {
  return { url: `/api/live-sessions/${sid}/citation-sources/${sid}/content`, kind: 'web', mimeType: 'text/html' };
}
```

详见第 8 节。

## 7. Extension 实现

### 7.1 新建 `extensions/pi-web-search/index.ts`

注册一个新工具 `tau_web_search`：

```ts
export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'tau_web_search',
    label: '联网搜索',
    description: '通过阿里云 AI 搜索开放平台（ops-web-search-001）执行联网搜索，返回网页标题、URL、摘要与可选正文。可在最终回答中引用部分结果。',
    promptGuidelines: [
      'Need fresh or external information that the local knowledge base cannot answer: weather, latest regulations, official notices, real-time data.',
      'Do NOT call this for content that already lives in the local knowledge base (use the search-traffic-assurance-knowledge skill instead).',
      'Pass a focused query (<=200 chars). Prefer one search per distinct topic.',
      'After getting results, pick the few you actually rely on and pass them to tau_cite via webResults. Do not cite pages you did not read.',
      'Always quote or paraphrase faithfully. If the snippet contradicts the page content, prefer the longer content_type response.',
    ],
    parameters: TauWebSearchSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const body = {
        query:         params.query,
        topK:          params.topK ?? 5,
        queryRewrite:  params.queryRewrite ?? true,
        contentType:   params.contentType ?? 'snippet',
        ...(params.history?.length ? { history: params.history } : {}),
        purpose:       params.purpose,
      };
      const url = `/api/live-sessions/${encodeURIComponent(ctx.sessionId)}/web-search`;
      const response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const payload = await response.json() as { results?: NormalizedSearchResult[]; cached?: boolean; error?: string; detail?: string };
      if (!response.ok) throw new Error(payload?.error || `web-search ${response.status}`);
      const lines = (payload.results || []).slice(0, 3).map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 280)}${r.snippet.length > 280 ? '…' : ''}`,
      );
      const summary = `联网搜索 ${payload.results?.length ?? 0} 条${payload.cached ? '（命中缓存）' : ''}：\n${lines.join('\n\n')}`;
      return {
        content: [{ type: 'text' as const, text: summary }],
        details: { kind: 'web-search-results' as const, results: payload.results || [], cached: !!payload.cached },
      };
    },
  });
}
```

### 7.2 扩展 `extensions/pi-citation/index.ts`

在 `TauCiteSchema` 新增字段：

```ts
const WebResultSchema = Type.Object({
  title:       Type.String({ minLength: 1, maxLength: 500 }),
  url:         Type.String({ pattern: '^https?://[\\w.-]+(?:/.*)?$' }),
  snippet:     Type.Optional(Type.String({ maxLength: 2000 })),
  content:     Type.Optional(Type.String({ maxLength: 20000 })),
  siteName:    Type.Optional(Type.String({ maxLength: 200 })),
  publishedAt: Type.Optional(Type.String({ maxLength: 40 })),
  sourceId:    Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.:-]{1,180}$' })),
}, { additionalProperties: false });

const TauCiteSchema = Type.Object({
  knowledgeIds: Type.Optional(Type.Array(Type.String({ pattern: '^K-[A-Za-z0-9_.-]+-\\d{6}$' }), { minItems: 1, maxItems: 80 })),
  artifacts:    Type.Optional(Type.Array(ArtifactSchema, { minItems: 1, maxItems: 20 })),
  webResults:   Type.Optional(Type.Array(WebResultSchema, { minItems: 1, maxItems: 20 })),
}, { additionalProperties: false });
```

新增工厂函数 `webCitation(input: WebResultInput, fallbackId: string)`：

```ts
function webCitation(input: WebResultInput) {
  // SSRF 自检（与服务器层同套规则），命中私有地址直接抛
  assertSafeUrl(input.url);
  const sha256 = crypto.createHash('sha256')
    .update(input.url)
    .update('\n')
    .update((input.content || input.snippet || '').slice(0, 4096))
    .digest('hex');
  const sourceId = input.sourceId || `web:${sha256.slice(0, 24)}`;
  const locatorId = `locator:${sourceId}`;
  const host = (() => { try { return new URL(input.url).host; } catch { return ''; } })();
  const quote = (input.content || input.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const source: CitationSource = {
    sourceId,
    kind: 'web',
    scope: 'web',
    title: input.title,
    url: input.url,
    mimeType: 'text/html',
    sha256,
  };
  const locator: CitationLocator = {
    locatorId,
    sourceId,
    quote,
    section: input.url,
    siteName: input.siteName || host,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
  };
  const citation: CitationRecord = {
    citationId: sourceId,
    sourceId,
    locatorId,
    documentClass: 'WEB_SOURCE',
    normativeForce: 'informational',
    verificationStatus: 'web_fetched',
  };
  return { source, locator, citation };
}
```

执行函数合并处：

```ts
const webCitations = (params.webResults || []).map(webCitation);
const registered = [...knowledgeCitations, ...webCitations, ...artifactCitations];
```

提示词拼接（在 `before_agent_start` 已有那段 `tau_cite` 提示后追加）：

```text
For fresh or external information that the local knowledge base cannot provide, call tau_web_search first, then pass the cited items into tau_cite via webResults. Do not paste raw URLs into the final answer.
```

### 7.3 注册新 Extension（`src/server/config.ts`）

```ts
export function findWebSearchExtensionPath() {
  const candidates = [
    path.join(__dirname, '..', 'extensions', 'pi-web-search', 'index.ts'),
    path.join(process.cwd(), 'extensions', 'pi-web-search', 'index.ts'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
export const WEB_SEARCH_EXTENSION_PATH = process.env.TAU_WEB_SEARCH_EXTENSION_PATH || findWebSearchExtensionPath();
export const BUILTIN_EXTENSION_PATHS = [
  GEO_EXTENSION_PATH, TASK_MODE_EXTENSION_PATH,
  WEB_BRIDGE_EXTENSION_PATH, CITATION_EXTENSION_PATH,
  WEB_SEARCH_EXTENSION_PATH,
];
```

`bin/tau.js`（启动脚本）若显式列举了 Extension 路径，同步加入。

### 7.4 Prompt 模板（`prompts/PI_SESSION_CONTEXT.md`）

在「引用板块」一节追加：

```markdown
## 联网搜索

需要本地知识库未覆盖的最新或外部信息时：

1. 调用 `tau_web_search` 取得若干网页结果；
2. 挑选实际参考的若干条，通过 `tau_cite({ webResults: [...] })` 注册为引用；
3. 在结论后写 `[[cite:<sourceId>]]`，系统会与知识库/任务产物一起在消息末尾生成「引用依据」；
4. 不要在正文里直接贴 URL，也不要试图伪造 path 让浏览器侧访问；
5. 检索式与 `content_type` 选择以节省 token 为优先（默认 `snippet`；必须看全文再设 `mainText`，单次 ≤20 条）。
```

## 8. React 适配（最小改动）

### 8.1 `src/web/features/citation/citation-projection.ts`

不变。`scope === 'web'` 自动走 `available` Map；不会进 `sessionArtifacts`（不属于任务产物）。

### 8.2 `src/web/platform/conversation/ConversationWorkspace.tsx`

```ts
const CITATION_CATEGORY_LABELS: Record<string, string> = {
  LEGAL_GOVERNANCE: '法律法规与制度',
  STANDARD_SPEC:    '标准规范',
  PLAN_PROCEDURE:   '预案与作业规程',
  CASE_PRACTICE:    '案例与实践',
  METHOD_RESEARCH:  '方法指南与研究',
  PROJECT_DATA:     '项目资料',
  WEB_SOURCE:       '联网检索',         // 新增
};
```

`citationPosition(item)` 增加：

```ts
if (item.source.kind === 'web') {
  return `${item.locator.publishedAt ? item.locator.publishedAt + ' · ' : ''}${item.locator.siteName || new URL(item.source.url || '').host}`;
}
```

`CitationEvidencePeek` 对 web 来源显示：

- 标题；
- URL 与域名（点击外链在新窗口打开）；
- snippet 摘要；
- 一个「在新窗口打开」按钮（`<a target="_blank" rel="noopener noreferrer">`）；
- 「抓取预览」由 `/api/live-sessions/{sid}/citation-sources/{srcId}/preview` 提供 iframe，sandbox。

### 8.3 `MessageArtifacts` 不动

web 来源不是任务产物，不进 `MessageArtifacts`；它走 `CitationFooter`。

### 8.4 复制回答文案

`citationCopyText` 已能复用。对 web 来源：

```text
[2] 杭州天气（www.hzqx.com，2026-07-31）
```

新增的格式化：

```ts
const isWeb = item.source.kind === 'web';
const position = isWeb
  ? `${item.locator.publishedAt ? `${item.locator.publishedAt} · ` : ''}${item.locator.siteName || item.source.url}`
  : item.locator.page
      ? `PDF 第${item.locator.page}页${item.locator.printedPage ? `（正文第${item.locator.printedPage}页）` : ''}`
      : item.locator.section || item.locator.sourceUnit || item.locator.nodeId || '';
return `[${number}] ${source.title}，${position}`;
```

## 9. 配置与启动

`.env`（或 `settings.json` 的 `tau.webSearch` 段，未来可加；当前阶段仅 env）：

```bash
TAU_WEB_SEARCH_HOST=http://xxxx-hangzhou.opensearch.aliyuncs.com
TAU_WEB_SEARCH_API_KEY=OS-xxxxxxxxxxxx
TAU_WEB_SEARCH_WORKSPACE=default            # 可选，默认 default
TAU_WEB_SEARCH_SERVICE_ID=ops-web-search-001 # 可选，默认 ops-web-search-001
```

未配置时：

- `webSearchProvider()` 返回 `null`；
- `/api/.../web-search` 路由返回 `503 { error: 'Web search provider is not configured' }`；
- Extension 在模型层无影响（不注册 → 模型看不到工具）；
- `tau_cite` 的 web 路径仍可工作（如果模型自己塞进 `webResults`，那它必须已经通过了 SSRF 自检）。

## 10. 安全边界

| 风险 | 处理 |
|---|---|
| API Key 进 React / JSONL | 只读环境变量；服务端代理；日志里打码（`OS-****xxxx`） |
| 模型伪造 URL 让浏览器访问任意文件 | 浏览器只能看到 `sourceId`；`url` 不直接暴露给前端；预览走服务端代理 |
| 模型把 `webResults.url` 指向 `127.0.0.1` / `169.254.169.254` 等 | `tau_cite` 与 `web-search.ts` 共用 `assertSafeUrl`，命中私有/回环/链路本地立即拒 |
| 跟随重定向绕过 SSRF | 限制最多 3 跳；每跳重做 `dns.lookup` + IP 白名单校验 |
| 抓回 HTML 里的 `<script>` 跑用户侧 XSS | 服务端用 `cheerio`（或 `parse5` + 自写剔除）剥 `<script>`/`<iframe>`/`on*` 属性；CSP `sandbox; default-src 'none'` |
| 抓回 HTML 体积爆炸 | `Content-Length > 5MB` 直接拒；边读边累加 + `AbortController` |
| 抓回 HTML 里 `<a target="_self">` 跳出 iframe | 注入 `<base target="_blank">` 让所有链接外开 |
| 模型引用未抓回的页面 | `verificationStatus: 'web_fetched'`；前端显示「原网页无法访问」时由 502 触发；与现有「引用不可用」文案区分 |
| 重复抓取消耗 QPS | 进程内 10 分钟缓存；缓存键不含 API Key；同一 sessionId 内的 `webResults` 可重复利用 `cached: true` |
| QPS 超限（账号级 3） | 阿里云侧返回 5xx → 映射为 `provider_5xx` → 让模型改写 query 或退避 |
| Stream 中半个 marker | 现有 `[[cite:...]]` 解析逻辑已处理 |
| Code block 里的 marker | 现有规则已覆盖 |
| 引用面板泄露绝对路径 | web 来源不进 `relativePath` 字段，只走 `url`；服务端不向浏览器返回原始绝对路径以外的本地文件信息 |
| `content_type=mainText` 体积过大 | 单条 ≤3000 字（接口本身限制）；服务端再压到 ≤20_000；`quote` 仍只取前 240 字 |

## 11. 测试矩阵（默认测试 ≤ 50；先评估可复用旧用例再决定新增数量）

### 11.1 契约层 `test/contracts.test.ts`（扩展）

- `parseCitationEnvelope` 接受 `kind: 'web'` / `scope: 'web'`，带 `url` 字段；
- 老 envelope（无 `url`、无 `publishedAt`）继续解析通过；
- 非法 `url`（非 http/https、过长、含 `..`、缺协议）被拒绝并给出诊断；
- `locators.publishedAt` 非字符串被拒；
- 上限检查未变。

### 11.2 服务端 `test/web-search.test.ts`（新）

- `assertSafeUrl` 拒绝 `127.0.0.1`、`169.254.169.254`、`::1`、`localhost`、`0.0.0.0`；
- 跟随重定向到 `10.0.0.1` 被拒；
- `Content-Length > 5MB` 抛 `too_large`；
- 超时抛 `timeout`；
- `tilte` → `title`、`link` → `url` 字段归一化；
- 缓存命中：同一请求两次只调一次 `fetch`（用 `globalThis.fetch` mock 计数）；
- `provider_4xx` / `provider_5xx` 错误归一；
- `buildWebSearchProviderFromEnv` 在缺 key / 缺 host 时返回 `null`。

### 11.3 引用资源 `test/citation-resources.test.ts`（扩展或在 `http-routes.test.ts` 内）

- `kind: 'web'` 走 `/api/live-sessions/{id}/citation-sources/{sid}/content` 返回 HTML 且脚本被剥；
- 抓取失败 → 502 `web_source_unreachable`；
- 注入 `<base target="_blank">` 验证；
- 上限检查（≤64KB 摘要）生效；
- 没有 `url` 的 web source → 400。

### 11.4 Extension `test/citation-extension.test.ts`（扩展）

- `tau_cite({ webResults: [...] })` 输出 `kind: 'web'`, `scope: 'web'`；
- 引用返回的 `sourceId` 稳定（同一 URL + 内容摘要 → 同一 `sourceId`）；
- `webResults.url` 是 `http://localhost/admin` → 抛错且不写入 envelope；
- `webResults` 与 `knowledgeIds` / `artifacts` 合并时，编号规则不受影响（沿用现有投影）；
- 提示词里包含「call tau_web_search first」的指引文本。

### 11.5 路由 `test/http-routes.test.ts`（扩展）

- 未配置 provider → `/web-search` 503；
- 配置 provider + 用 `globalThis.fetch` mock 返回阿里云响应 → 200，归一化字段正确；
- 请求体 `topK: 999` → 400；
- 请求体 `contentType: 'xml'` → 400；
- 没有 live session → 404；
- 跨 session 取 web 引用 → 404（与现有 citation 行为一致）。

### 11.6 投影 `test/citation-projection.test.ts`（扩展）

- assistant 同时引用 `K-...` 和 `web:...` 时，编号 `[1][2]` 按正文出现顺序递增；
- 引用面板的分组：`knowledge` 来源一组、`session` 产物一组、`web` 来源一组（标题分别显示「知识库 / 任务产物 / 联网检索」）；
- 复制回答把 `web:...` 转换为 `[2] 标题，域名`；
- 同 URL 重复出现合并编号（与现有规则一致）。

## 12. 阶段验收

### 阶段 0：契约与测试 fixture（1 个 PR）

- [ ] `CitationSource{Kind, Scope}` 加入 `'web'`；
- [ ] `CitationLocator` / `CitationRecord` 新字段；
- [ ] `parseCitationEnvelope` 单测覆盖新增字段与回归；
- [ ] `npm run typecheck` + `npm test` 全绿。

### 阶段 1：服务端代理（1 个 PR）

- [ ] `src/server/web-search.ts` 实现 `assertSafeUrl`、`webSearch`、`WebSearchError`、缓存；
- [ ] `src/server/config.ts` 加入 provider env 解析；
- [ ] `src/server/api-routes.ts` 加入路由与 TypeBox schema；
- [ ] `src/server/server-main.ts` 注入服务；
- [ ] `test/web-search.test.ts` 通过；
- [ ] `test/http-routes.test.ts` 路由用例通过。

### 阶段 2：Extension 与 `tau_cite` 串联（1 个 PR）

- [ ] `extensions/pi-web-search/index.ts` 注册 `tau_web_search`；
- [ ] `extensions/pi-citation/index.ts` 加入 `webResults` 与 `webCitation`；
- [ ] `prompts/PI_SESSION_CONTEXT.md` 增加联网段落；
- [ ] `config.ts` 注册 `WEB_SEARCH_EXTENSION_PATH`；
- [ ] `bin/tau.js` 启动脚本同步加入路径；
- [ ] `test/citation-extension.test.ts` 用例通过。

### 阶段 3：React 适配与引用资源（1 个 PR）

- [ ] `src/web/platform/conversation/ConversationWorkspace.tsx` 加入 `WEB_SOURCE` 分类；
- [ ] `citationCopyText` 输出 web 来源格式；
- [ ] `src/server/citation-resources.ts` 加入 `serveCitationWebContent` / `serveCitationWebPreview`；
- [ ] 引用面板 HTML 预览走服务端代理，CSP 收紧；
- [ ] `test/citation-projection.test.ts` 新增 web 引用混合用例通过。

### 阶段 4（可选，延后）

- 抓全文缓存到 session cwd（`session/<id>/.tau/web-snapshots/<sha>.html`），刷新后仍能预览；
- 多搜索引擎聚合（除阿里云外再加 Bocha/Tavily/Exa 等）；
- `tau_web_search` 结果在 React 侧可点击二次精炼（topK=20 → 二次选 5 条）。

## 13. 风险与回滚

| 风险 | 影响 | 回滚方式 |
|---|---|---|
| 阿里云 API Key 配置错误 | 所有 web 搜索 503 | 服务日志 `WebSearchError('missing_api_key')`；UI 上提示「未配置 API Key」 |
| 阿里云端限流或 5xx | 部分查询失败 | 错误透传 `provider_5xx`，模型退避或换 query；后续可加重试 + 指数退避 |
| `assertSafeUrl` 误伤合法公网域名 | 引用失败 | 白名单先放行、灰度开关 `TAU_WEB_SEARCH_SSRF_ENFORCE=true/false`（默认 true） |
| 网络抖动导致引用面板打不开 | 用户看到「原网页无法访问」 | 引用面板仍展示标题、URL、已保存的 snippet；与「原件缺失」同款提示 |
| `CitationSourceKind` / `Scope` 扩展破坏旧 envelope | 旧消息无法投影 | 严格保证向后兼容；旧 envelope 不带新字段也能解析 |
| 缓存导致结果过期 | 引用过时的网页 | TTL 10 分钟；过期后重新调 API；UI 上显示 `usage.rewrite_model.total_tokens` 帮助模型判断是否需要新一次查询 |
| 同一 query 多次搜索浪费 QPS | 账号 3 QPS 被打满 | 缓存键 = `query + topK + contentType + history`；同一组合复用 |

## 14. 文件改动清单（最终预览）

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/contracts/citation.ts` | 修改 | `Kind`/`Scope` 增 `web`；`Source` 增 `url`；`Locator` 增 `publishedAt`/`siteName`；`Record` 增枚举值 |
| `src/contracts/__fixtures__/citation-web.json` | 新增 | web 来源的 envelope 测试 fixture |
| `src/server/web-search.ts` | 新增 | 阿里云适配 + SSRF + 缓存 + 错误归一 |
| `src/server/config.ts` | 修改 | 加入 `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_EXTENSION_PATH` |
| `src/server/api-routes.ts` | 修改 | 新增 `/api/live-sessions/{id}/web-search` |
| `src/server/citation-resources.ts` | 修改 | `kind === 'web'` 走 HTML 代理分支 |
| `src/server/server-main.ts` | 修改 | 注入 `webSearchProvider` / `webSearch` |
| `extensions/pi-web-search/index.ts` | 新增 | `tau_web_search` 工具 |
| `extensions/pi-citation/index.ts` | 修改 | `TauCiteSchema` 增 `webResults`；新增 `webCitation` |
| `prompts/PI_SESSION_CONTEXT.md` | 修改 | 增加联网搜索段落 |
| `bin/tau.js` | 修改 | 同步 `WEB_SEARCH_EXTENSION_PATH` |
| `src/web/platform/conversation/ConversationWorkspace.tsx` | 修改 | `WEB_SOURCE` 分类、web 定位与预览 |
| `src/web/features/citation/citation-projection.ts` | 修改 | `citationCopyText` 适配 web 格式 |
| `test/contracts.test.ts` | 修改 | web envelope 解析 + 回归 |
| `test/web-search.test.ts` | 新增 | SSRF / 字段归一 / 缓存 / 超时 |
| `test/citation-extension.test.ts` | 修改 | `webResults` 串联 |
| `test/http-routes.test.ts` | 修改 | `/web-search` 路由 + `kind: web` 资源 |
| `test/citation-projection.test.ts` | 修改 | web 来源混合投影 |
| `docs/archive/future/PLAN_WERSEARCH.md` | 新增 | 本文件 |
| `docs/CHANGELOG.md` | 修改 | 增加阶段 0/1/2/3 实施记录 |
| `docs/archive/implemented/CITATION_FEATURE_TECHNICAL_PLAN.md` | 修改 | 在「9. 当前实现落点」表追加 web 行；在「8. 阶段」表追加阶段二扩展点 |

## 15. 最终逻辑线（一句话）

```text
阿里云 Web Search
    ↓ 服务端代理 + SSRF + 缓存
tau_web_search 拿到结构化结果
    ↓ 模型挑选
tau_cite({ webResults })
    ↓ 与 K-...、任务产物 一起
CitationEnvelope (kind='web', scope='web')
    ↓ 沿用同一渲染管线
正文 [1][2] + 消息末尾「引用依据 · 联网检索」
    ↓ 点击预览
服务端 HTML 代理（沙箱 + 脚本剥离）
```

阶段 0 起步，阶段 3 完成时即可在用户侧看到统一引用面板里的「联网检索」分组；阶段 4 是优化项，不阻塞上线。
