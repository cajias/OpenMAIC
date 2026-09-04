# Threat: Server-Side Request Forgery

OpenMAIC's server fetches URLs on a caller's behalf in five distinct situations,
which is why SSRF is the sharpest network threat here. This section names the
three guards that exist, the 16 calling files (20 call sites) behind the general
one, the asymmetries between sibling routes, the global off-switch, and the one
gap the design leaves open on purpose.

**Sources:** `lib/server/ssrf-guard.ts` (303 lines, the general boundary),
[`lib/server/agent-runtime/fetch-url.ts:140-174`](lib/server/agent-runtime/fetch-url.ts#L140-L174),
[`lib/server/web-search-config.ts:12-79`](lib/server/web-search-config.ts#L12-L79), `app/api/proxy-media/route.ts`,
[`lib/server/resolve-model.ts:104-110`](lib/server/resolve-model.ts#L104-L110),
[`lib/server/agent-runtime/generate-image.ts:106-120`](lib/server/agent-runtime/generate-image.ts#L106-L120),
[`lib/server/render-service.ts:25-39`](lib/server/render-service.ts#L25-L39),
[`../appendix/research/api-surface/02b-interfaces-egress-body-sse.md`](docs/appendix/research/api-surface/02b-interfaces-egress-body-sse.md),
[`../appendix/research/quality-testing-ci-deps/01b-modules-ci-and-build.md`](docs/appendix/research/quality-testing-ci-deps/01b-modules-ci-and-build.md).

## What can be attacker-controlled

| Input | Reached from | Zone |
| --- | --- | --- |
| `x-base-url` header / body `baseUrl` for an **unmanaged** provider | 10 routes + `resolveModel` | Z1 browser |
| `POST /api/proxy-media` body `url` | 1 route | Z1 browser |
| `provider/probe-models` `baseUrl` and `modelsUrl` | 1 route | Z1 browser |
| Body `baseUrl` for an unmanaged **web-search** provider | 1 route + the classroom config resolver | Z1 browser |
| Asset URL returned by an image/video provider | [`generate-image.ts:111`](lib/server/agent-runtime/generate-image.ts#L111), [`generate-video.ts:155`](lib/server/agent-runtime/generate-video.ts#L155) | Z4 provider |
| URL handed to the agent's `fetch_url` tool | [`fetch-url.ts:449`](lib/server/agent-runtime/fetch-url.ts#L449) | Z6 model output |

## Three guards, three strictness levels

```mermaid
flowchart TD
  Start["a URL to fetch"] --> Which{"which path?"}

  Which -- "13 route files + 3 lib files" --> V0["validateUrlForSSRF(url)"]
  Which -- "agent fetch_url only" --> S0["normalizeUrlForStrictFetch(url)"]
  Which -- "web-search base URL only" --> A0["resolveSafeClientWebSearchBaseUrl(providerId, url)"]

  V0 --> V1{"new URL() parses?"}
  V1 -- no --> Vbad["return 'Invalid URL'"]
  V1 -- yes --> V2{"protocol http: or https:?"}
  V2 -- no --> Vproto["return 'Only HTTP(S) URLs are allowed'"]
  V2 -- yes --> V3{"ALLOW_LOCAL_NETWORKS is 'true' or '1'?"}
  V3 -- yes --> Vallow["return null — ALL further checks skipped"]
  V3 -- no --> V4{"host is localhost / *.local / 0.0.0.0 / ::1<br/>or isPrivateIP(host)?"}
  V4 -- yes --> Vblock["return the block message naming ALLOW_LOCAL_NETWORKS"]
  V4 -- no --> V5{"host is an IP literal?"}
  V5 -- yes --> Vok["return null"]
  V5 -- no --> V6["dns.lookup(host, all:true, verbatim:true)"]
  V6 -- throws or empty --> Vdns["return 'Unable to verify hostname safety'"]
  V6 --> V7{"any answer isPrivateIP?"}
  V7 -- yes --> Vblock
  V7 -- no --> Vok

  S0 --> S1{"protocol http/https?"}
  S1 -- no --> Sthrow["throw UnsafeNetworkTargetError"]
  S1 -- yes --> S2{"username or password present?"}
  S2 -- yes --> Sthrow
  S2 -- no --> S3{"port set and not 80 or 443?"}
  S3 -- yes --> Sthrow
  S3 -- no --> S4{"host metadata.google.internal / localhost / *.local?"}
  S4 -- yes --> Sthrow
  S4 -- no --> S5{"host is an IP literal?"}
  S5 -- yes --> S6["assertSafeIp: unwrap IPv4-mapped, require range()=='unicast'"]
  S5 -- no --> S7["undici Agent with lookup: lookupAllThenPin"]
  S6 --> S7
  S7 --> S8["assertSafeLookupAddresses over the WHOLE answer set,<br/>then PIN that set into the connection"]
  S8 --> Sok["fetch proceeds; every redirect re-normalised"]

  A0 --> A1{"blank or absent?"}
  A1 -- yes --> Anone["return undefined — server config decides"]
  A1 -- no --> A2{"new URL() parses and protocol http/https?"}
  A2 -- no --> Athrow["throw 'Unsupported {provider} base URL' → 400 INVALID_REQUEST"]
  A2 -- yes --> A3["strip trailing slashes"]
  A3 --> A4{"EXACT match in OFFICIAL_CLIENT_BASE_URLS[providerId]?"}
  A4 -- no --> Athrow
  A4 -- yes --> Aok["return the normalised URL"]
```

The strict path is materially stronger than `validateUrlForSSRF` in four ways: it
rejects userinfo, it rejects any port other than 80/443, it rejects the
**entire** DNS answer set if any candidate is unsafe, and it pins that answer set
into the undici connection so the resolver cannot return a different address
between check and connect. `validateUrlForSSRF` does the lookup and then hands
the *hostname* to `fetch()`, which resolves again — a classic TOCTOU /
DNS-rebinding window. The strict path also has no `ALLOW_LOCAL_NETWORKS` escape
hatch.

The web-search path is stricter still, and differently shaped: it is an
**allowlist**, not a classifier. `OFFICIAL_CLIENT_BASE_URLS`
([`lib/server/web-search-config.ts:12-44`](lib/server/web-search-config.ts#L12-L44)) enumerates the accepted official
endpoints per provider — 2 for Tavily, 2 for Exa, 6 for Bocha, 3 for Brave, 1 for
Baidu, 2 for Claude, 8 for MiniMax, 2 for Doubao — and
`resolveSafeClientWebSearchBaseUrl` (`:56-79`) throws unless the client's value,
trailing slashes stripped, is an exact member. A private address cannot be
reached because it is not on the list, so no IP classification, DNS lookup or
`ALLOW_LOCAL_NETWORKS` bypass is involved at all. SearXNG's list is empty
(`:43`) and the callers pass `undefined` for it regardless
([`web-search/route.ts:98`](app/api/web-search/route.ts#L98), [`web-search-config.ts:121`](lib/server/web-search-config.ts#L121)), so a SearXNG base URL can
only come from `SEARXNG_BASE_URL`.

## Where each guard runs

| Site | Guard | Conditional on `NODE_ENV`? |
| --- | --- | --- |
| [`app/api/proxy-media/route.ts:33`](app/api/proxy-media/route.ts#L33) + per-redirect [`:55`](app/api/proxy-media/route.ts#L55) | `validateUrlForSSRF` | No — always |
| [`app/api/azure-voices/route.ts:29`](app/api/azure-voices/route.ts#L29) | `validateUrlForSSRF` | No — always |
| [`app/api/provider/probe-models/route.ts:34`](app/api/provider/probe-models/route.ts#L34) (both `baseUrl` and `modelsUrl`) | `validateUrlForSSRF` | No — always |
| [`app/api/generate/tts/route.ts:98`](app/api/generate/tts/route.ts#L98) | `validateUrlForSSRF` | No — always |
| [`app/api/generate/voice/route.ts:126`](app/api/generate/voice/route.ts#L126) | `validateUrlForSSRF` | No — always |
| [`lib/server/agent-runtime/generate-image.ts:111`](lib/server/agent-runtime/generate-image.ts#L111) (per redirect hop) | `validateUrlForSSRF` | No — always |
| [`lib/server/agent-runtime/generate-video.ts:155`](lib/server/agent-runtime/generate-video.ts#L155) (per redirect hop) | `validateUrlForSSRF` | No — always |
| [`app/api/generate/image/route.ts:70`](app/api/generate/image/route.ts#L70) | `validateUrlForSSRF` | **Yes** — `production` only |
| [`app/api/generate/video/route.ts:65`](app/api/generate/video/route.ts#L65) | `validateUrlForSSRF` | **Yes** |
| [`app/api/transcription/route.ts:57`](app/api/transcription/route.ts#L57) | `validateUrlForSSRF` | **Yes** |
| [`app/api/parse-pdf/route.ts:47`](app/api/parse-pdf/route.ts#L47) | `validateUrlForSSRF` | **Yes** |
| [`app/api/extract-document/route.ts:258`](app/api/extract-document/route.ts#L258) (media) and [`:386`](app/api/extract-document/route.ts#L386) (document) | `validateUrlForSSRF` | **Yes** |
| [`app/api/verify-image-provider/route.ts:57`](app/api/verify-image-provider/route.ts#L57) | `validateUrlForSSRF` | **Yes** |
| [`app/api/verify-video-provider/route.ts:52`](app/api/verify-video-provider/route.ts#L52) | `validateUrlForSSRF` | **Yes** |
| [`app/api/verify-pdf-provider/route.ts:58`](app/api/verify-pdf-provider/route.ts#L58), [`:83`](app/api/verify-pdf-provider/route.ts#L83), [`:132`](app/api/verify-pdf-provider/route.ts#L132) | `validateUrlForSSRF` | **Yes** (all three) |
| [`lib/server/resolve-model.ts:105`](lib/server/resolve-model.ts#L105) — covers `chat`, `chat/pi`, `verify-model`, `quiz-grade`, `pbl/v2/*`, `generate/scene-*` | `validateUrlForSSRF` | **Yes** |
| [`lib/server/agent-runtime/fetch-url.ts:449`](lib/server/agent-runtime/fetch-url.ts#L449) + [`:479`](lib/server/agent-runtime/fetch-url.ts#L479) | strict + pinned lookup | No — always |
| [`app/api/web-search/route.ts:109`](app/api/web-search/route.ts#L109) and [`lib/server/web-search-config.ts:122`](lib/server/web-search-config.ts#L122) (classroom) | per-provider exact allowlist | No — always |

`validateUrlForSSRF` therefore has **16 calling files and 20 call sites** —
`extract-document`, `proxy-media` and `verify-pdf-provider` each call it more
than once.

Two asymmetries stand out and neither carries a comment explaining itself:

1. **TTS/voice are strict, image/video are not.** `generate/tts:97-98` and
   `generate/voice:125-126` guard an unmanaged client base URL unconditionally;
   `generate/image:70` and `generate/video:65` gate the identical check behind
   `NODE_ENV === 'production'`. The four routes are otherwise structurally
   identical (same `managed ? undefined : clientBaseUrl` shape). Inferred: drift,
   not a decision.
2. **Development is unguarded by design in 8 route files plus `resolveModel`.**
   That is defensible for a laptop, but `NODE_ENV` is not `production` in a
   `pnpm dev` deployment someone left exposed, and nothing warns about it.

## Deliberately unguarded crossings

| Target | Rationale, cited |
| --- | --- |
| `RENDER_SERVICE_URL` | Operator deployment config, meant to name an internal host (`http://render-service:9000`). Guarding it would force operators to weaken SSRF globally. [`lib/server/render-service.ts:25-35`](lib/server/render-service.ts#L25-L35) |
| A **managed** provider's `baseUrl` | Comes from `server-providers.yml` / `<PREFIX>_BASE_URL`, i.e. the operator. [`lib/server/resolve-model.ts:83-87`](lib/server/resolve-model.ts#L83-L87), [`lib/server/provider-config.ts:679-687`](lib/server/provider-config.ts#L679-L687) |
| `SEARXNG_BASE_URL` | Same reasoning; the route additionally discards any client-supplied SearXNG base URL. [`app/api/web-search/route.ts:97-98`](app/api/web-search/route.ts#L97-L98) |
| `POST /api/web-search` — no `validateUrlForSSRF` call anywhere in the file | Deliberate, not an omission: the allowlist above is stronger than the classifier. There is nothing for `validateUrlForSSRF` to add to a value that already had to be one of nine hard-coded vendor endpoints. [`lib/server/web-search-config.ts:74-77`](lib/server/web-search-config.ts#L74-L77) |

## The classifier

`isPrivateIP` ([`lib/server/ssrf-guard.ts:178-244`](lib/server/ssrf-guard.ts#L178-L244)) is unusually thorough for a
hand-rolled classifier. It handles IPv4-mapped IPv6 (`::ffff:127.0.0.1`, both
dotted and hex forms), `fc00::/7`, `fe80::/10`, `fec0::/10`, and then unwraps
three tunnel encodings that hide an IPv4 address inside an apparently public
IPv6 address:

| Encoding | Prefix | Where the IPv4 sits |
| --- | --- | --- |
| 6to4 | `2002::/16` | bits 16-47 (hextets 1-2) |
| Teredo | `2001:0000::/32` | last 32 bits, XOR-inverted with `0xffff` |
| ISATAP | interface id `0000:5efe:` or `0200:5efe:` | hextets 6-7 |

`assertSafeIp` goes further than `isPrivateIP`: it also rejects anything whose
`ipaddr.js` `range()` is not `unicast` (so multicast, benchmarking, documentation
and reserved ranges are out) and three cloud metadata addresses
(`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`).

**The cloud-metadata denylists are on the strict path only.**
`CLOUD_METADATA_ADDRESSES` and `CLOUD_METADATA_HOSTNAMES` ([`ssrf-guard.ts:11-12`](lib/server/ssrf-guard.ts#L11-L12))
are read at exactly two sites: `assertSafeIp:46` and
`normalizeUrlForStrictFetch:74`. `validateUrlForSSRF` calls neither, so all 20 of
its call sites — 16 modules: the 13 route files plus `lib/server/resolve-model.ts`
and the two agent-runtime redirect loops — have no metadata-specific check.
`169.254.169.254` and
`fd00:ec2::254` are still blocked there, but only incidentally — as
`169.254.0.0/16` link-local and `fc00::/7` unique-local inside `isPrivateIP`
(`:192`, `:209`). `100.100.100.200` (Alibaba) is in **no** `isPrivateIP` range
and is therefore reachable through every `validateUrlForSSRF` caller.
`metadata.google.internal` is rejected by name only on the strict path; on the
general path it survives to `dns.lookup` and is blocked only if the resolver
answers with a private address.

## `ALLOW_LOCAL_NETWORKS` — one switch, 20 call sites in 16 modules

```mermaid
stateDiagram-v2
  [*] --> Guarded
  Guarded --> Open: ALLOW_LOCAL_NETWORKS=true or 1
  Open --> Guarded: unset, or any other value
  Guarded: validateUrlForSSRF runs the checks it has.<br/>Self-hosted Ollama on 127.0.0.1 is REJECTED.<br/>Port, userinfo and metadata checks are absent even here.
  Open: validateUrlForSSRF returns null after the URL-parse and http/https checks.<br/>All 20 call sites lose the hostname and private-IP checks and the DNS re-check.<br/>There is no metadata-address check on this path to lose — see above.<br/>fetch_url and the web-search allowlist are UNAFFECTED — neither has a bypass.
```

The block message itself advertises the switch
([`lib/server/ssrf-guard.ts:246-247`](lib/server/ssrf-guard.ts#L246-L247)), which is honest but means the first thing a
frustrated self-hoster reads is the instruction to disable the control. The
documented reasons are real: a self-hosted Ollama/VoxCPM/MinerU on a private
address, and split-horizon DNS where a public name resolves internally.

## Residual gaps

| Gap | Consequence |
| --- | --- |
| TOCTOU between `dns.lookup` and `fetch` in `validateUrlForSSRF` | A rebinding resolver can pass the check and connect to a private address. Only `fetch_url` pins. |
| No port restriction on the `validateUrlForSSRF` path | `http://public-host:6379/` passes. The strict path rejects it. |
| No userinfo restriction on the `validateUrlForSSRF` path | `http://user:pass@host/` passes. |
| No cloud-metadata denylist on the `validateUrlForSSRF` path | `http://100.100.100.200/` (Alibaba) passes: it is not in any `isPrivateIP` range, and only `assertSafeIp` consults `CLOUD_METADATA_ADDRESSES`. |
| **`isPrivateIP` omits every non-unicast range that is not RFC1918 or link-local** | The predicate is a hand-rolled octet test covering exactly `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16-31`, `192.168/16` for IPv4 ([`ssrf-guard.ts:188-196`](lib/server/ssrf-guard.ts#L188-L196)). It therefore does not cover `100.64.0.0/10` (CGNAT — which is what lets Alibaba's `100.100.100.200` through), `192.0.0.0/24` (IETF protocol assignments — **contains Oracle Cloud's metadata address `192.0.0.192`**, which is in no denylist either), `198.18.0.0/15`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `192.88.99.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, or `255.255.255.255`. `assertSafeIp` catches these on the strict path with `range() !== 'unicast'`; `validateUrlForSSRF` has no equivalent, and after an IP literal survives `isPrivateIP` it returns `null` at [`:282-284`](lib/server/ssrf-guard.ts#L282-L284) without further checks. |
| `NODE_ENV`-gated checks | 8 route files plus `resolveModel` are unguarded outside production. |
| No rate limiting on `proxy-media` | The route is an unauthenticated (when `ACCESS_CODE` is unset) 25 MiB fetch-and-return primitive; nothing bounds request rate. |
| `ALLOW_LOCAL_NETWORKS` is all-or-nothing | No per-host allowlist exists, so enabling one internal target opens all of them. |
| The web-search allowlist must be edited to follow a vendor | An official endpoint that moves, or a regional variant, is a code change rather than configuration. The trade is deliberate — the alternative is trusting a client-supplied host. |

## Open questions

- Exactly which prefixes `assertSafeIp` rejects via `range() !== 'unicast'` is a
  property of `ipaddr.js@^2.5.0`'s own special-range table, not of this repo. The
  code line is verified; the resulting prefix list was **not** — `node_modules` is
  absent in a clean checkout, so the table could not be enumerated against the
  installed version. Treat the strict path's coverage of CGNAT, reserved and
  documentation ranges as read-from-intent until someone runs `ipaddr.parse(x).range()`
  against the pinned build.
- Whether Alibaba's and Oracle's metadata addresses reaching the
  `validateUrlForSSRF` path is intentional is not recorded anywhere in the code.
  `CLOUD_METADATA_ADDRESSES` lists the Alibaba address, so someone knew about it —
  but placed the denylist only on the path that already blocks it by range.

## Related

- [`01-trust-boundaries.md`](docs/15-cross-cutting/01-trust-boundaries.md) — crossings C8 and C9.
- [`06-configuration.md`](docs/15-cross-cutting/06-configuration.md) — `ALLOW_LOCAL_NETWORKS`, `NODE_ENV`, `RENDER_SERVICE_URL`.
- [`../12-api-reference/index.md`](docs/12-api-reference/index.md) — the `INVALID_URL` / 403 responses these produce.
