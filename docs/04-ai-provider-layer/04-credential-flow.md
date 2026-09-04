# Credential Flow and the Trust Boundary

Where an API key comes from in each deployment mode, the exact read sites, and what the code does
and does not guarantee about a browser bundle seeing an operator's key.

**Sources:** `lib/server/provider-config.ts`, `lib/server/resolve-model.ts`,
`app/api/server-providers/route.ts`, `app/api/health/route.ts`, `app/api/verify-*/route.ts`,
`lib/store/settings.ts`, `lib/store/kv-persist.ts`, `components/settings/provider-config-panel.tsx`,
`lib/server/ssrf-guard.ts`;
[../appendix/research/ai-provider-layer/01b-modules-server.md](../appendix/research/ai-provider-layer/01b-modules-server.md),
[../appendix/research/persistence-storage-state/00-overview.md](../appendix/research/persistence-storage-state/00-overview.md).

## The single rule

A provider is **server-managed** iff an entry for it exists in the loaded server config. There is
no third state.

```ts
// lib/server/provider-config.ts:646
export function isServerConfiguredProvider(section: ProviderSection, providerId: string): boolean {
  return !!getConfig()[section][providerId];
}

// lib/server/provider-config.ts:669
function resolveSectionApiKey(section, providerId, clientKey?): string {
  const entry = getConfig()[section][providerId];
  if (entry) return entry.apiKey || '';   // managed: server key is authoritative
  return clientKey || '';                  // unmanaged: client-supplied key only
}

// lib/server/provider-config.ts:679
function resolveSectionBaseUrl(section, providerId, clientBaseUrl?): string | undefined {
  const entry = getConfig()[section][providerId];
  if (entry) return entry.baseUrl;   // managed: server base URL is authoritative
  return clientBaseUrl;              // unmanaged: client-supplied base URL only
}
```

The header comment at `lib/server/provider-config.ts:631`–`:641` records why there are exactly two
branches: *"This single rule removes the tri-state where a client base URL could partially override
server config (the bug class #533 patched route-by-route)."*

Note the consequence at `:675`: a managed entry with an empty `apiKey` returns `''`, **not** the
client's key. A provider the operator configured with only a base URL (Ollama, Lemonade, Bedrock)
therefore locks the client out of supplying a key for it. That is deliberate for keyless providers
and is the reason `applyAliDocMindFallback` deletes a bare YAML-only entry (`:443`) — a managed
entry with unusable credentials would both lock out the client and silently discard the client's
AK/SK.

The three LLM-facing wrappers are one-liners over those helpers:

| Export | Line | Section |
| --- | --- | --- |
| `resolveApiKey(providerId, clientKey?)` | `:725` | `providers` |
| `resolveBaseUrl(providerId, clientBaseUrl?)` | `:730` | `providers` |
| `resolveProxy(providerId)` | `:735` | `providers`, server-only, **no client parameter** |

`ProviderSection` is `'providers' | 'tts' | 'asr' | 'pdf' | 'image' | 'video' | 'webSearch'`
(`:643`); every capability has the same pair (`resolveTTSApiKey` `:768`, `resolveImageApiKey`
`:934`, `resolveVideoApiKey` `:993`, `resolvePDFApiKey` `:903`, `resolveASRApiKey` `:866`,
`resolveWebSearchApiKey` `:1055`).

## How the server config is built

```mermaid
flowchart TD
  yaml["server-providers.yml in process.cwd()<br/>loadYamlFile :217 — returns an empty object on any read or parse error :225"]
  env["process.env"]
  les["loadEnvSection(envMap, yamlSection, opts)<br/>:294"]
  y1["Phase 1: YAML entries become defaults<br/>:314-332 — kept only if apiKey, or baseUrl for a keyless provider"]
  y2["Phase 2: env overrides individual fields<br/>:341-353 — PREFIX_API_KEY, PREFIX_BASE_URL, PREFIX_MODELS"]
  y3["Phase 3: env can create an entry YAML did not<br/>:357-367 — activates on key, or base URL for keyless"]
  post["Post-processors"]
  p1["applyOpenAIImageFallback :501<br/>lights up openai-image from OPENAI_API_KEY alone"]
  p2["applyAliDocMindFallback :430<br/>AK/SK pair required, else DELETE the entry"]
  p3["applyBedrockProviderConfig :525<br/>activates on BEDROCK_REGION / _MODELS / _API_KEY / _BASE_URL / AWS_BEARER_TOKEN_BEDROCK / YAML key"]
  dis["collectDisabledProviders :386<br/>YAML enabled:false plus CAP_PREFIX_ENABLED"]
  cache["getConfig() process singleton<br/>Map keyed by filename, only key is '' :620-629"]

  yaml --> les
  env --> les
  les --> y1 --> y2 --> y3 --> post
  post --> p1
  post --> p2
  post --> p3
  p1 --> dis
  p2 --> dis
  p3 --> dis
  dis --> cache
```

Two properties of that build worth remembering:

- **Env wins per field, not per entry.** A YAML entry supplying `apiKey` + `baseUrl` + `models`
  and an env supplying only `<PREFIX>_BASE_URL` yields the YAML key with the env URL
  (`:343`–`:345`).
- **`proxy` is YAML-only.** Phase 1 copies `proxy: entry.proxy` (`:328`); phase 3 does not
  (`:363`–`:367`). There is no `<PREFIX>_PROXY` variable anywhere in the codebase.
- **`getConfig()` is a process singleton.** Once read, `server-providers.yml` and every
  `<PREFIX>_*` variable are frozen for the process lifetime. Rotating a key requires a restart.

## The three credential origins

| Origin | Read site | Reaches the provider how |
| --- | --- | --- |
| **Env var** `<PREFIX>_API_KEY` | `lib/server/provider-config.ts:336` | Becomes `ServerProviderEntry.apiKey`, returned by `resolveApiKey` for a managed provider |
| **`server-providers.yml`** `providers.<id>.apiKey` | `lib/server/provider-config.ts:322` | Same, unless an env var overrides the field |
| **User settings** (`providersConfig[id].apiKey` in the browser) | sent as `x-api-key`; read at `lib/server/resolve-model.ts:170` | Used only when the provider is **unmanaged** (`:112` passes it as `clientApiKey`) |

Special cases:

- **`bedrock` never uses a key for signing.** `requiresApiKey: false`
  (`lib/ai/providers.ts:418`), and `getModel()`'s bedrock branch passes
  `apiKey: effectiveApiKey || undefined` plus a `fromNodeProviderChain()` credential provider
  (`lib/ai/providers.ts:2276`–`:2281`). Credentials come from the AWS default chain (instance role,
  `AWS_*` env, shared config). `resolveModel` additionally refuses Bedrock unless
  `providerId === 'bedrock'` **and** the provider is server-managed
  (`lib/server/resolve-model.ts:101`) — a browser cannot opt itself into the host's IAM role.
- **`minimax` with an `sk-cp-` key** goes into Anthropic's `authToken` rather than `apiKey`
  (`lib/ai/providers.ts:2237`).
- **AliDocMind uses AK/SK.** `resolveManagedAliDocMindCredentials()`
  (`lib/server/provider-config.ts:469`) returns the pair only when both halves are present.

## Where user keys live

`lib/store/settings.ts` persists the whole state (there is no `partialize`) under the key
`settings-storage` (`:1984`) through `createKVPersistStorage<Partial<SettingsState>>('account', …)`
(`:1987`). No `kv` backend is passed, so the adapter falls back to
`defaultKv ??= new BrowserKVStore()` (`lib/store/kv-persist.ts:473`) — i.e. `localStorage`.
`providersConfig[<id>].apiKey` therefore sits in the browser's `localStorage`, on the user's own
machine, in plaintext, and is sent per-request in `x-api-key`.

Client-side `x-api-key` producers, all reading the settings store:
`app/generation-preview/page.tsx:262`, `lib/hooks/use-scene-generator.ts:80`,
`lib/media/media-orchestrator.ts:282` and `:332`,
`components/scene-renderers/pbl/v2/submission.tsx:456`,
`components/scene-renderers/pbl/v2/use-instructor-stream.ts:296`,
`components/scene-renderers/quiz-view.tsx:104`, `components/settings/image-settings.tsx:128`,
`components/settings/video-settings.tsx:90`.

The settings panel hides the key and base-URL inputs entirely when a provider is server-managed
(`components/settings/provider-config-panel.tsx:222`, with the comment at `:220`–`:221`), and
renders a "server configured" notice at `:214`–`:218`.

## Can a user bundle see a server key?

**No, and the containment is structural rather than declarative.** Four independent facts, each
verifiable:

1. **The only client-reachable projection of the LLM config withholds credentials by
   construction.** `getServerProviders()` (`lib/server/provider-config.ts:698`) builds a fresh
   object containing at most `{ models }` per provider id. Its docstring at `:693`–`:697` states
   the reason: *"never the API key or the base URL, which can reveal internal gateway/proxy
   infrastructure."* `GET /api/server-providers` returns exactly the seven such projections plus
   `generation.parallelSceneConcurrency` (`app/api/server-providers/route.ts:18`–`:28`).
2. **`GET /api/health` publishes only booleans.** Four `Object.values(...).some(info => !info.disabled)`
   expressions (`app/api/health/route.ts:18`–`:21`).
3. **No route echoes a credential.** A scan of all `route.ts` files under `app/api` found no
   `apiSuccess(...)` payload within 12 lines of an `apiKey`, `accessKeySecret` or `Bearer`
   reference. Upstream error bodies are also withheld: `messageForStatus`
   (`lib/server/llm-error-response.ts:49`) emits fixed strings, and the docstring at `:59`–`:62`
   names "credential-adjacent details" as the thing being suppressed.
4. **`lib/server/provider-config.ts` cannot be bundled for the browser.** It imports `fs`, `path`
   and `js-yaml` at module top level (`:8`–`:10`), so a client component importing it fails the
   Next build. A scan of every `'use client'` file under `app/`, `lib/` and `components/` found
   **zero** imports from `@/lib/server/*`.

What is **not** in place, stated plainly so nobody assumes it:

- There is no `server-only` package in the repo — no dependency in `package.json`, no importer
  anywhere. Containment relies on the Node-builtin imports and on `instrumentation.ts` importing
  `config-validation` dynamically (`instrumentation.ts:28`, with the comment at `:26`–`:27`
  explaining that the dynamic form keeps `fs`/`js-yaml` out of the Edge bundle).
- `lib/ai/providers.ts` **is** in the client bundle (`lib/store/settings.ts` imports it). It
  contains no credential and reads no env var for one; its only env reads are
  `OPENAI_COMPAT_USE_STREAMING_CHAT` (`:1842`) and the three Bedrock region variables (`:1775`–`:1777`),
  none of which are secrets. This is also why it cannot import `lib/ai/thinking-context.ts` — see
  the comment at `:59`–`:62`.
- The one auth gate is `ACCESS_CODE` in `middleware.ts`, a shared password with no per-user
  identity. Any client that clears that gate can send any `x-api-key` and use any **unmanaged**
  provider at the deployment's expense — but it still cannot read a managed provider's key.

```mermaid
flowchart TD
  subgraph untrusted["Untrusted zone: browser bundle"]
    ls["localStorage 'settings-storage'<br/>providersConfig[id].apiKey — the USER's own key"]
    ui["components/settings/*<br/>hides key inputs when isServerConfigured"]
    hdrs["x-api-key / x-base-url / x-provider-type / x-model"]
    prov["lib/ai/providers.ts (isomorphic)<br/>catalog + capabilities only, no secrets"]
  end

  subgraph edgeZone["Edge: middleware.ts"]
    gate["ACCESS_CODE HMAC cookie gate<br/>401 for /api/* except access-code and health"]
  end

  subgraph trusted["Trusted zone: Node server process"]
    envv["process.env PREFIX_API_KEY"]
    yml["server-providers.yml"]
    cfg["getConfig() singleton<br/>provider-config.ts:620 — imports fs/path/js-yaml"]
    arb["resolveSectionApiKey / resolveSectionBaseUrl<br/>:669 / :679"]
    gm["getModel() — SDK client holds the key<br/>providers.ts:2033"]
    upstream["Upstream provider HTTP call"]
  end

  subgraph outbound["Client-visible projections"]
    sp["GET /api/server-providers<br/>ids + allowed models + disabled flags"]
    hl["GET /api/health<br/>four capability booleans"]
    err["llmApiError()<br/>fixed message per status class"]
  end

  ls --> hdrs
  hdrs --> gate --> arb
  envv --> cfg
  yml --> cfg
  cfg --> arb
  arb -->|"managed: client key discarded"| gm
  arb -->|"unmanaged: client key used"| gm
  gm --> upstream
  cfg --> sp
  cfg --> hl
  upstream --> err
  sp --> ui
  hl --> ui
  prov --> ui
```

## The unmanaged path is SSRF-gated, in production only

```mermaid
flowchart TD
  req["Request carrying x-base-url"]
  mgd{"isServerConfiguredProvider('providers', id)?"}
  ignore["clientBaseUrl = undefined<br/>resolve-model.ts:104 — operator URL is authoritative"]
  prod{"process.env.NODE_ENV === 'production'?"}
  pass["used unvalidated (dev convenience)<br/>resolve-model.ts:105"]
  ssrf["validateUrlForSSRF(clientBaseUrl)<br/>ssrf-guard.ts:253"]
  parse{"parses as a URL, scheme http or https?<br/>ssrf-guard.ts:255-263"}
  allowlocal{"ALLOW_LOCAL_NETWORKS is 'true' or '1'?"}
  shortcut["return null — private-address checks skipped,<br/>parse and scheme already enforced<br/>ssrf-guard.ts:266-269"]
  checks["hostname not localhost/.local/0.0.0.0/::1,<br/>isPrivateIP, then DNS resolve and re-check"]
  boom["throw the returned message<br/>resolve-model.ts:108"]
  ok["passed to getModel()"]

  req --> mgd
  mgd -- yes --> ignore --> ok
  mgd -- no --> prod
  prod -- no --> pass --> ok
  prod -- yes --> ssrf --> parse
  parse -- no --> boom
  parse -- yes --> allowlocal
  allowlocal -- yes --> shortcut --> ok
  allowlocal -- no --> checks
  checks -- blocked --> boom
  checks -- clean --> ok
```

`ALLOW_LOCAL_NETWORKS` is a single global switch that disables the hostname and private-address
checks at all 20 `validateUrlForSSRF` call sites (`lib/server/ssrf-guard.ts:266`–`:269`), not just
this layer's — and not the strict `normalizeUrlForStrictFetch` / `assertSafeIp` path, which it does
not reach.
`.env.example:461`–`:463` documents it as required for self-hosted Ollama and says "Do NOT enable
on public deployments".

Two asymmetries inside this layer:

- `resolve-model.ts:105`, `verify-image-provider/route.ts:57`, `verify-video-provider/route.ts:52`
  and `verify-pdf-provider/route.ts:58`/`:83`/`:132` all gate the check on `NODE_ENV === 'production'`.
  `provider/probe-models/route.ts:33` validates **unconditionally** — the only route in this layer
  that does.
- `probe-models` sets `redirect: 'manual'` and rejects any 3xx (`lib/server/model-fetch.ts:127`,
  `:132`). `getModel()`'s provider fetches set no `redirect` option, so they follow the platform
  default.

## Per-capability credential separation

`verify-pdf-provider` shows the intended shape most clearly. For AliDocMind
(`app/api/verify-pdf-provider/route.ts:30`–`:78`):

- managed → server AK/SK/endpoint only, client values ignored entirely (`:35`–`:44`);
- unmanaged → client AK/SK only, and the comment at `:45`–`:46` states it never falls back to
  server env. A missing half is a 400, not a silent server-credential borrow.

The image and video verify routes follow the same discipline: `managed ? undefined : header`
for both key and base URL (`verify-image-provider/route.ts:54`–`:55`,
`verify-video-provider/route.ts:49`–`:50`), plus a force-disable check that answers 403 before any
credential is touched (`:48`, `:43`).

## Open questions

- Rotating a managed key requires a process restart, because `getConfig()` caches for the process
  lifetime (`lib/server/provider-config.ts:620`–`:629`). No reload path or cache-invalidation hook
  exists. Whether deployments accept that or restart on rotation is outside the repo.
- User keys sit in `localStorage` unencrypted and are transmitted per request. There is no
  server-side per-user key vault; the `account` KV scope is capable of being server-backed
  (`lib/store/kv-persist.ts:9`) but nothing in `lib/persistence/bootstrap.ts` switches it, so in
  the shipped configuration the key never leaves the machine except as `x-api-key`.
- `ALLOW_LOCAL_NETWORKS=true` disables SSRF validation globally for 13 routes across the codebase,
  not just for the provider base URL that motivates it. No narrower per-provider allowlist exists.
