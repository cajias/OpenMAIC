# Secrets Management

Where credentials live in each of the two deployment modes, the exact path from
storage to a provider HTTP call, and the mechanisms that keep them out of client
bundles and logs — including the two places they still get out.

**Sources:** `lib/server/provider-config.ts` (1116 lines, the credential authority),
`lib/server/resolve-model.ts`, `lib/ai/providers.ts`, [`lib/store/settings.ts:1984-1995`](lib/store/settings.ts#L1984-L1995),
[`lib/store/kv-persist.ts:430-473`](lib/store/kv-persist.ts#L430-L473), `app/api/server-providers/route.ts`,
[`lib/persistence/server-auth.ts:1-13`](lib/persistence/server-auth.ts#L1-L13), [`lib/server/proxy-fetch.ts:114-142`](lib/server/proxy-fetch.ts#L114-L142),
`lib/logger.ts`, [`Dockerfile:51-72`](Dockerfile#L51-L72), [`docker-compose.yml:37-41`](docker-compose.yml#L37-L41),
[`../appendix/research/ai-provider-layer/01b-modules-server.md`](docs/appendix/research/ai-provider-layer/01b-modules-server.md),
[`../appendix/research/ai-provider-layer/04-dependencies-and-config.md`](docs/appendix/research/ai-provider-layer/04-dependencies-and-config.md).

## Two modes

| | **BYO-key mode** (default) | **Operator-managed mode** |
| --- | --- | --- |
| Where the key lives at rest | the user's browser `localStorage` | the server's env, or `server-providers.yml` |
| How it reaches the server | `x-api-key` header on every request | it is already there |
| Who can read it | the user, the operator, any XSS on the origin | the operator only |
| Client-visible fact | its own key | that the provider is "managed", nothing else |
| Failure when absent | provider unusable for that user | `400`/`403`, or a boot `[config]` warning |

Both modes coexist per provider. `isServerConfiguredProvider('providers', id)`
decides which applies for each call, and the answer is *per provider*, not per
deployment ([`lib/server/provider-config.ts:646-648`](lib/server/provider-config.ts#L646-L648)).

## The key path

```mermaid
flowchart TD
  subgraph AtRest["At rest"]
    YML["server-providers.yml (cwd, optional, mountable ro)"]
    ENVV["process.env: &lt;PREFIX&gt;_API_KEY / _BASE_URL / _MODELS"]
    LSTOR["browser localStorage 'settings-storage'<br/>(account KV scope)"]
  end

  YML --> GC["getConfig() — cached per YAML filename<br/>provider-config.ts:423"]
  ENVV -->|"env overrides YAML field by field<br/>provider-config.ts:341-352"| GC
  LSTOR --> HDRS["x-api-key / x-base-url / x-provider-type"]

  HDRS --> RMH["resolveModelFromHeaders<br/>resolve-model.ts:162-175"]
  RMH --> RM["resolveModel"]
  RM --> R1{"stage route configured?"}
  R1 -- yes --> DROP["clientApiKey = clientProviderType = clientBaseUrlParam = undefined"]
  R1 -- no --> KEEP["client values kept"]
  DROP --> MGD
  KEEP --> MGD{"isServerConfiguredProvider('providers', providerId)?"}
  MGD -- yes --> RAK1["resolveApiKey → entry.apiKey (server wins)<br/>resolveBaseUrl → entry.baseUrl"]
  MGD -- no --> RAK2["resolveApiKey → clientKey<br/>resolveBaseUrl → clientBaseUrl (SSRF-checked in production)"]
  RAK1 --> GM["getModel({providerId, modelId, apiKey, baseUrl, proxy, ...})"]
  RAK2 --> GM
  GC --> RAK1
  GM --> SDK["AI SDK provider instance → HTTPS Authorization header"]
```

`resolveSectionApiKey` is four lines and is the whole rule: *if the operator
configured this provider, the operator's key is authoritative; otherwise the
client's key, or empty string* ([`provider-config.ts:669-677`](lib/server/provider-config.ts#L669-L677)). The same shape
governs base URLs (`:679-687`) and, for LLMs only, a per-provider `proxy`
(`:735-737`).

## Per-capability credential families

All read with **computed** env keys, so a literal `process.env.X` grep does not
find them ([`provider-config.ts:335-338`](lib/server/provider-config.ts#L335-L338)).

| Section | Prefixes | Notes |
| --- | --- | --- |
| LLM (`providers`) | `LLM_ENV_MAP` (`:73-95`) — OpenAI, Azure, AtlasCloud, Anthropic, Google, DeepSeek, Qwen, Kimi, MiniMax, GLM, **SiliconFlow**, Doubao, OpenRouter, Grok, Tencent Hunyuan, Xiaomi, Ollama, Lemonade, Bedrock | 21 env prefixes resolve to these 19 provider ids: `TENCENT`/`TENCENT_HUNYUAN` and `XIAOMI`/`MIMO` are aliases. Keyless providers (Ollama) activate on `_BASE_URL` alone |
| TTS | `TTS_OPENAI`, `TTS_AZURE`, `TTS_GLM`, `TTS_QWEN`, `TTS_VOXCPM`, `TTS_DOUBAO`, `TTS_ELEVENLABS`, `TTS_MINIMAX`, `TTS_LEMONADE` | first `_MODELS` entry is authoritative over a client model (`:801-805`) |
| ASR | `ASR_OPENAI`, `ASR_QWEN`, `ASR_AZURE`, `ASR_FUNASR`, `ASR_LEMONADE` | |
| PDF | `PDF_UNPDF`, `PDF_MINERU`, `PDF_MINERU_CLOUD` | AliDocMind is special-cased: an AK/SK **pair** or it stays unmanaged (`:430-461`) |
| Image | `IMAGE_OPENAI`, `IMAGE_SEEDREAM`, `IMAGE_QWEN_IMAGE`, `IMAGE_NANO_BANANA`, `IMAGE_MINIMAX`, `IMAGE_GROK`, `IMAGE_LEMONADE` | |
| Video | `VIDEO_SEEDANCE`, `VIDEO_KLING`, `VIDEO_VEO`, `VIDEO_MINIMAX`, `VIDEO_GROK`, `VIDEO_HAPPYHORSE` | |
| Web search | `TAVILY`, `EXA`, `BOCHA`, `BRAVE`, `BAIDU`, `WEB_SEARCH_CLAUDE`, `WEB_SEARCH_MINIMAX`, `WEB_SEARCH_DOUBAO`, `SEARXNG` | the `WEB_SEARCH_*` prefixes exist specifically to avoid colliding with the Anthropic and Doubao **LLM** vars (`:148`, `:151`) |

Non-provider secrets, all runtime-only and never `NEXT_PUBLIC_`: `ACCESS_CODE`,
`DATABASE_URL`, `PERSISTENCE_DEV_TOKEN`, `MODEL_ROUTES` (which can embed nothing
secret but does encode the operator's model choices),
`ALIDOCMIND_ACCESS_KEY_SECRET`, `AWS_BEARER_TOKEN_BEDROCK`.

## Keeping them out of the client bundle

```mermaid
flowchart LR
  subgraph Inlined["Inlined by next build — treat as public"]
    A["NEXT_PUBLIC_* (11 Docker ARGs)"]
  end
  subgraph Runtime["Runtime env — never serialised"]
    B["every credential above"]
  end
  B --> SP["GET /api/server-providers"]
  SP --> OUT["{ providers: { id: { models?: [...] } },<br/>tts/asr/pdf/image/video/webSearch: { id: { disabled?: bool } },<br/>generation: { parallelSceneConcurrency } }"]
  OUT --> Client["settings store: isServerConfigured / serverModels / serverDisabled"]
  B --> HC["GET /api/health"]
  HC --> OUT2["{ status, version, capabilities: 4 booleans }"]
```

`getServerProviders()` exposes "only the allowed model list and the 'managed' flag
(presence in this map) — never the API key or the base URL, which can reveal
internal gateway/proxy infrastructure" ([`provider-config.ts:693-706`](lib/server/provider-config.ts#L693-L706)). The
capability listings expose `{ disabled?: boolean }` and nothing else, because a
force-disabled provider still has to be visible to admin surfaces
(`:743-749`).

The settings store's server sync is **one-way and never destructive**: it resets
and re-applies `isServerConfigured` / `serverModels` / `serverDisabled` and never
touches a user-entered key, and it is silent on failure
([`lib/store/settings.ts:1461-1979`](lib/store/settings.ts#L1461-L1979)).

One documented exception: `NEXT_PUBLIC_PERSISTENCE_TOKEN` is inlined on purpose,
and [`lib/persistence/server-auth.ts:3-12`](lib/persistence/server-auth.ts#L3-L12) spells out that it is therefore not a
secret and provides no confidentiality and no user isolation. It is also a Docker
**build arg** ([`Dockerfile:53`](Dockerfile#L53)), so it lands in the image's build history as well.

## Keeping them out of logs

There is no redaction helper in this codebase. What keeps keys out of logs is
that nothing logs the objects that hold them: no `log.*` call in `lib/ai/` or
`lib/server/` takes an `apiKey` (verified by grep). `lib/logger.ts` has no
allow/deny list — `formatLine` stringifies whatever it is given
([`lib/logger.ts:13-26`](lib/logger.ts#L13-L26)).

Two verified leaks:

| Leak | Detail | Severity |
| --- | --- | --- |
| Proxy URL with credentials | [`proxy-fetch.ts:134`](lib/server/proxy-fetch.ts#L134) logs `cachedProxyUrl` verbatim at `info`, and `LOG_LEVEL` defaults to `info`. `https_proxy=http://user:pass@host:3128` is written to stdout on every proxied request — i.e. on every web search and every render-service call. | real, unconditional |
| Error stacks from provider SDKs | `formatLine` emits `a.stack ?? a.message` for an `Error` ([`lib/logger.ts:18`](lib/logger.ts#L18)). Any SDK that embeds a full request URL — including a key passed as a query parameter — in its message leaks it. | conditional; not traced to a specific provider that does this |

A third-order concern: `console.info('Stage published', { stageId, ownerId })`
([`app/api/stages/[id]/publish/route.ts:52`](app/api/stages/[id]/publish/route.ts#L52)) and similar structured logs write
owner ids. Those are anonymous cookie UUIDs, not credentials, but they are stable
30-day identifiers.

## Storage at rest

| Store | Backing | Encryption |
| --- | --- | --- |
| BYO provider keys | `localStorage` under `settings-storage`, account KV scope ([`settings.ts:1984-1987`](lib/store/settings.ts#L1984-L1987), [`kv-persist.ts:430`](lib/store/kv-persist.ts#L430), [`:473`](lib/store/kv-persist.ts#L473)) | none |
| Operator keys | `process.env`, or `server-providers.yml` in `process.cwd()` | none; Compose suggests mounting the YAML `:ro` ([`docker-compose.yml:38-39`](docker-compose.yml#L38-L39)) |
| Access cookie | browser cookie jar, `HttpOnly`, `SameSite=Lax`, `Secure` only in production | HMAC-signed, not encrypted |
| Anonymous owner cookie | same shape, 30-day `Max-Age` | unsigned |
| Usage metering | `data/usage/YYYY-MM.jsonl` on the `openmaic-data` volume | none; contains no credentials |

`server-providers.yml` is resolved as `path.join(process.cwd(), filename)` and a
parse failure is a `log.warn` returning `{}` — a broken YAML silently means "no
managed providers" rather than a boot failure
([`provider-config.ts:217-229`](lib/server/provider-config.ts#L217-L229)).

## Rotation

| Secret | How to rotate | Blast radius |
| --- | --- | --- |
| `ACCESS_CODE` | change the env, restart | **every** issued cookie is invalidated, because the code is the HMAC key |
| any `<PREFIX>_API_KEY` | change the env or YAML, restart | `getConfig()` caches per filename for the process lifetime, so a restart is required |
| `PERSISTENCE_DEV_TOKEN` | change it **and** `NEXT_PUBLIC_PERSISTENCE_TOKEN`, then **rebuild** | the public half is inlined at build time, so an env-only change breaks every client |
| a user's BYO key | the user retypes it in Settings | that user only |
| `NPM_TOKEN` / `CLAWHUB_TOKEN` | GitHub environment secret | release only; see [`06b-configuration-render-service.md`](docs/15-cross-cutting/06b-configuration-render-service.md) |

## Open questions

- No secret scanner runs in CI. `.github/workflows/ci.yml` has four linters and
  three test jobs; none is a credential scan. A committed `.env.local` would not
  be caught by tooling (it is gitignored, but that is not the same guarantee).
- Whether [`proxy-fetch.ts:134`](lib/server/proxy-fetch.ts#L134) should log at `debug` instead of `info`, or redact
  the userinfo. The one-line fix is a `URL` round-trip with `username`/`password`
  cleared.
- Whether any published Docker image carries a non-empty
  `NEXT_PUBLIC_PERSISTENCE_TOKEN` in its build history. Not answerable from the
  repository.
