# dsh-anysearch

把 [AnySearch](https://www.anysearch.com) 接成 DSH 的 **默认搜索**：注册一个 id 为
`anysearch` 的 search provider 到 `ctx.web`，模型侧 `web_search` 工具就直接跑在
`POST https://api.anysearch.com/v1/search` 上。

零依赖、ESM、workspace 直链插件（`link:` 进 profile）。

## 它替换了什么

| 之前 | 现在 |
| --- | --- |
| `dsh-free-search`（0.9.15）提供的 `bing` 搜索 + `fs-quality-fetch` 抓取 | 搜索：本插件的 `anysearch`；抓取：内置 `@deepseek-ai/dsh-web-fetch-http`（id `http`） |

`dsh-free-search` 删除后，profile 里还写着 `searchProvider: bing` /
`fetchProvider: fs-quality-fetch` 会直接报 `WEB_PROVIDER_CONFIGURED_MISSING`（配置的 id
没注册），所以那两个字段必须一起改，见下面「接线」。

## 接线（profile 侧）

`G:\DeepSeekData\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
- id: web
  config:
    searchProvider: anysearch   # 本插件注册的 id
    fetchProvider: http         # 内置 HTTP 抓取

- id: web-search-anysearch
  name: dsh-anysearch
  config:
    apiKeyEnv: ANYSEARCH_API_KEY
    timeoutMs: 20000
    maxResults: 8
    diagnostics: G:/DeepSeekData/.dsh/logs/anysearch-search.jsonl   # 可选
```

`G:\DeepSeekData\.dsh\profiles\desktop\package.json`：

```json
{ "dependencies": { "dsh-anysearch": "link:../../../deepseek-harness/default-workspace/dsh-anysearch" },
  "dsh": { "profile": { "bundles": ["...", "dsh-anysearch"] } } }
```

`node_modules/dsh-anysearch` 是指向本目录的 Junction（和 `dsh-wallpaper` 同样的做法），
避免 `pnpm install` 联网。

key 放凭据库，不落明文到 profile：

```yaml
# G:\DeepSeekData\.dsh\.credentials.yaml
refs:
  ANYSEARCH_API_KEY: as_sk_xxxxxxxx
```

该文件 `watch: true`，改完即时生效，不用重启 DSH。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `url` | 空 | 完整端点；给了就覆盖 `baseURL` + `path` |
| `baseURL` | `https://api.anysearch.com` | |
| `path` | `/v1/search` | |
| `apiKey` | 空 | 明文 key（优先于凭据库，一般不填） |
| `apiKeyEnv` | `ANYSEARCH_API_KEY` | 解析顺序：`apiKey` → 凭据服务 → `process.env[apiKeyEnv]` |
| `maxResults` | `8` | 请求级 `maxResults` 优先 |
| `timeoutMs` | `20000` | 单请求预算，与上游取消信号合并 |
| `disabled` | `false` | `true` 时 `available()` 返回 false |
| `allowCredentials` | `true` | `false` 时不查凭据服务，只认明文/env |
| `diagnostics` | 空 | 文件路径；每次搜索追加一行 JSON |

## 行为约定

- **key 可选**：没有 key 也能搜（AnySearch 匿名免费档）。
- **key 失效不致命**：带 key 收到 401/403 时，自动匿名重试一次，并在结果 `content`
  里写明「key 被拒、这次走的是匿名档」。429 直接报错（`WEB_PROVIDER_ERROR`），不静默降级。
- **错误不降级**：seam 只认配好的 provider，本插件抛错就上抛，不会偷偷换别的搜索源。
- **`truncated` 恒为 false**：服务端按 `max_results` 返多少就是多少，本插件不再二次截断。
- **snippet** 优先 `snippet`，空则退到 `content`，统一截 600 字符；`published_at` /
  `date` 映射成 `publishedAt`；URL 去重。

## 为什么零依赖

profile 用 `nodeLinker: hoisted`，插件以 `link:`/Junction 进 `node_modules`，被 realpath
解析到 workspace 真实路径后**看不到** profile 的 `node_modules/@deepseek-ai/*`。所以本插件
只 import `node:*` 内建模块、用全局 `fetch`，也**故意不导出 Schemastery `Config`**
（不导出 schema 时 loader 把原始 YAML section 原样传给 `apply()`，由 `resolveOptions()`
自己做默认值与类型兜底，还能容忍热配置里出现未知字段）。

## 自检

```bash
cd G:/DeepSeekData/deepseek-harness/default-workspace/dsh-anysearch
node tools/test.mjs        # fake ctx + 真 API：注册 / available / 结果形状 / 坏 key 降级 / abort
```

进程内证据（证明真的带了 key、真的打到 api.anysearch.com）：配好 `diagnostics` 后跑一次
`web_search`，看日志行：

```json
{"ts":"...","provider":"anysearch","query":"...","endpoint":"https://api.anysearch.com/v1/search",
 "keySource":"credentials ANYSEARCH_API_KEY","keyPresent":true,"elapsedMs":4045,"status":200,
 "requestId":"704bacc9-...","totalResults":8,"searchTimeMs":3490,"sources":8}
```

`keySource` 会明确写出 key 来自哪一层（`config.apiKey` / `credentials <REF>` /
`$<REF>` / `$missing:<REF>`），所以「静默走匿名档」不可能再被误当成成功。

## API 契约（实测）

```http
POST https://api.anysearch.com/v1/search
content-type: application/json
authorization: Bearer as_sk_...      # 可选

{"query": "...", "max_results": 8}
```

```json
{"code":0,"message":"success","request_id":"...",
 "data":{"results":[{"title":"..","url":"..","snippet":"..","content":".."}],
         "metadata":{"total_results":8,"search_time_ms":3490}}}
```

`code !== 0` 视为失败；HTTP 非 2xx 走错误分支。
