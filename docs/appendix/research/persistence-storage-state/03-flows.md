# End-to-end flows

Five traced paths. Every hop names a real function at a real file:line.

## Flow 1 — Settings hydrate, then write (local mode)

| # | Hop | Where |
| --- | --- | --- |
| 1 | module eval builds the store; `persist` calls `storage.getItem('settings-storage')` | `lib/store/settings.ts:1984-1996` |
| 2 | `createKVPersistStorage('account', { onWriteRefused })` returns the adapter | `lib/store/kv-persist.ts:519` |
| 3 | `getItem` → `stateFor(name)` creates the `KeyState` (phase `unhydrated`) | `kv-persist.ts:632,543` |
| 4 | `serial(name, …)` puts the read on the key's promise chain | `kv-persist.ts:578` |
| 5 | `resolveKvStorage()` → `resolveKv` → `new BrowserKVStore()` → `kvPersistStorage(kv, 'account')` | `kv-persist.ts:525-535`, `zustand/persist.ts:59` |
| 6 | `Outcome.run(() => kvStorage.getItem(name))` → `kv.get('settings-storage','account')` → `localStorage['maic:account:settings-storage']` | `kv-persist.ts:658`, `kv/browser.ts:52-56` |
| 7 | `.into(state, 'read "settings-storage" …')` — a throw becomes `state.onFailure` + `UNAVAILABLE`, and the key is left unsettled | `kv-persist.ts:91-95,658-666` |
| 8 | non-null value → `state.noteRealData()`; then `concludeRead` → `state.settle()` → phase `settled`, `reportPersistHealth(name,'recovered')` | `kv-persist.ts:637-638,601-606,229` |
| 9 | zustand runs `migrate(persisted, version)` (v0→v4 ladder) then the custom `merge` (`ensureBuiltIn*`, `pruneThinkingConfigs`) | `settings.ts:1998-2235` |
| 10 | a later `set(...)` triggers `storage.setItem`; `state.admitWrite(value)` is decided **at issue time**, not when the queued turn arrives | `kv-persist.ts:675-677,286-309` |
| 11 | write goes through the same `Outcome` → `noteWriteSucceeded()` or `noteWriteFailed(value)` | `kv-persist.ts:692-697` |
| 12 | on failure: `onFailure` → `reportPersistHealth(name,'unavailable')` → `#askForRecovery()` → `setTimeout(0/250/1000)` → `useSettingsStore.persist.rehydrate()` | `kv-persist.ts:195-201,383-402`, `settings.ts:2242` |

```mermaid
sequenceDiagram
  participant Z as "zustand persist"
  participant A as "createKVPersistStorage adapter"
  participant S as "KeyState (settings-storage)"
  participant O as "Outcome"
  participant KV as BrowserKVStore
  participant LS as localStorage
  participant H as reportPersistHealth

  Z->>A: getItem("settings-storage")
  A->>S: stateFor -> phase unhydrated
  A->>O: run(kvStorage.getItem)
  O->>KV: get("settings-storage","account")
  KV->>LS: getItem("maic:account:settings-storage")
  LS-->>KV: JSON or null
  KV-->>O: PersistedValue or null
  O->>S: into(state,"read ...")
  S->>H: recovered
  A-->>Z: {state, version}
  Z->>Z: migrate(v0..v4) then merge(ensureBuiltIn*)
  Note over Z,S: phase settled, write gate open
  Z->>A: setItem("settings-storage", value)
  A->>S: admitWrite(value)
  S-->>A: true
  A->>O: run(kvStorage.setItem)
  O->>KV: set(...)
  KV--xO: QuotaExceededError
  O->>S: into(state,"write ...")
  S->>H: unavailable
  S->>Z: requestRecovery -> persist.rehydrate()
```

## Flow 2 — Save a course in server mode (`PUT /api/persistence/documents/:stageId`)

| # | Hop | Where |
| --- | --- | --- |
| 1 | `getDocumentStore()` resolves the configured factory once | `lib/document-store/store.ts:63-71` |
| 2 | factory built at bootstrap: `new HttpDocumentStore({ baseUrl:'/api/persistence', headers: getPersistenceRequestHeaders, validateScene, validateStage })` | `lib/persistence/bootstrap.ts:53-61` |
| 3 | headers hook awaits `getPersistenceLearnerKey()` → `getLearnerKey(BrowserKVStore)` → KV `device` key `runtime.learnerKey` (minted `anon:<uuid>` under Web Lock `maic:learner-key`) | `bootstrap.ts:19-39`, `lib/runtime/learner-key.ts:48-66` |
| 4 | `HttpDocumentStore.saveDocument` → `PUT /documents/<stageId>` | `document/http.ts:220` |
| 5 | Next route `handlePersistenceRequest` checks `DATABASE_URL` then `PERSISTENCE_DEV_TOKEN` | `app/api/persistence/[...path]/route.ts:271-281` |
| 6 | `withRequestOwnerId(request, …)` → `resolveRequestOwnerId` reads/mints cookie `anonymous_id`, returns `anon:<uuid>` | `route.ts:283`, `lib/server/agent-runtime/owner.ts:52-64` |
| 7 | `parseDocumentAction('PUT','/documents/<id>')` → `{ kind:'create', stageId }` | `route.ts:286`, `lib/persistence/document-access.ts:43` |
| 8 | `decideDocumentAccess(action, ownerId, readStageMeta, existence probe, readStageMeta)` → `allow` / `forbid` / `not-found` | `route.ts:291-300`, `document-access.ts:86-97` |
| 9 | `createPersistenceHandler` → `getServerPersistenceProvider(connectionString)` (5 `ensure*Schema` calls, cached on `globalThis`) | `route.ts:85-88`, `lib/persistence/server-provider.ts:36-67` |
| 10 | `createOwnerBoundDocumentStore({ pool, ownerId, validateScene, validateStage })` | `route.ts:89-94` |
| 11 | `createStorageHttpHandler(runtimeStore, documentStore, { authenticate, authorizeDocuments: () => access === 'allow', … })` — `/documents*` requests authenticate as `{ learnerKey: ownerId }`, everything else via `authenticatePersistenceRequest` | `route.ts:108-121`, `server/index.ts:777-789` |
| 12 | `runNodeHandler` adapts the `RequestListener` to a `Response`, buffering chunks as `Buffer` (never a string, to avoid U+FFFD corruption) | `route.ts:178-261` |
| 13 | `OwnerBoundDocumentStore.saveDocument` tags the operation `{ stageId, mode:'create' }`, then `withTransaction` locks `stage_meta … FOR UPDATE`, checks foreign/tombstoned/reserved-document/unclaimed | `owner-bound-document-store.ts:78-82,186-212` |
| 14 | `PgDocumentStore.saveDocument` validates, stamps `dslVersion`, upserts `document_stages`, diffs and upserts `document_scenes`, writes `document_outlines` | `document/pg.ts` (schema at `:58-116`) |
| 15 | triggers `openmaic_stage_revision_trigger` / `openmaic_scene_revision_trigger` bump `document_stage_revision` **before** `document_scene_revision` and `pg_notify('openmaic_agent_event_wakeup', …)` | `document/pg.ts:169-224` |
| 16 | on `mode:'create'` success, `claimStageMeta(queryable, stageId, ownerId)` inserts `stage_meta` `ON CONFLICT DO NOTHING`, then `COMMIT` | `owner-bound-document-store.ts:215-219`, `stage-meta.ts:103-124` |
| 17 | `Set-Cookie` from step 6 is appended to the response, including on 4xx/5xx | `route.ts:310,319`, `with-owner.ts:6-11` |

```mermaid
sequenceDiagram
  participant B as Browser
  participant H as HttpDocumentStore
  participant R as "route handlePersistenceRequest"
  participant OW as resolveRequestOwnerId
  participant DA as decideDocumentAccess
  participant SP as getServerPersistenceProvider
  participant OB as OwnerBoundDocumentStore
  participant PG as PgDocumentStore
  participant DB as PostgreSQL

  B->>H: saveDocument(doc)
  H->>H: validateStage + validateScene
  H->>R: "PUT /api/persistence/documents/<id>"
  R->>R: check DATABASE_URL then PERSISTENCE_DEV_TOKEN
  R->>OW: resolveRequestOwnerId(headers)
  OW-->>R: "anon:<uuid>" plus Set-Cookie
  R->>DA: parseDocumentAction + decideDocumentAccess
  DA->>DB: "SELECT ... FROM stage_meta WHERE stage_id=$1"
  DA-->>R: allow
  R->>SP: getServerPersistenceProvider(DATABASE_URL)
  SP->>DB: "ensureSchema x5 (idempotent)"
  R->>OB: saveDocument(doc)
  OB->>DB: "BEGIN ISOLATION LEVEL READ COMMITTED"
  OB->>DB: "SELECT owner_id, deleted_at FROM stage_meta ... FOR UPDATE"
  OB->>PG: inner.saveDocument(doc)
  PG->>DB: "upsert document_stages / document_scenes / document_outlines"
  DB->>DB: "triggers bump SR then SCR, pg_notify stage"
  OB->>DB: "claimStageMeta INSERT ... ON CONFLICT DO NOTHING"
  OB->>DB: COMMIT
  OB-->>R: void
  R-->>B: "200 plus Set-Cookie anonymous_id"
```

## Flow 3 — `loadChatSessions` with the Dexie cutover

The legacy source is the Dexie `chatSessions` / `chatRestoreStaging` tables
(`lib/utils/chat-storage.ts:90-105`); the destination is the learner
`RuntimeStore` partition `(stageId, learnerKey)`.

| # | Hop | Where |
| --- | --- | --- |
| 1 | `loadChatSessions(stageId, options)` → `context(options)` resolves store, `learnerKey`, legacy store, and `requiresCrossRealmLock = legacyStore === dexieLegacyStore` | `chat-storage.ts:1170-1175,273-289` |
| 2 | `enqueue(store, queueKey, stageId, requiresCrossRealmLock, work)` — acquires the global **shared** chat lock first, then registers in the per-partition promise queue (order chosen to avoid a shared→shared→exclusive inversion) | `chat-storage.ts:238-270` |
| 3 | `withPartitionLocks` takes `navigator.locks` for the stage key and then the `(stage, learner)` key; with no Web Locks it throws `ChatStorageLockUnavailableError` when the shared Dexie table is involved | `chat-storage.ts:214-236` |
| 4 | **inside** the lock: `legacyStore.load(stageId)` reads `chatRestoreStaging` first, else `chatSessions`, sorted by `createdAt` | `chat-storage.ts:1189`, `:91-98` |
| 5 | `normalizeLegacyConversion` → `fromLegacyRecords` returns `{ sessions, skippedRows }`; malformed rows are logged and **left in place** | `chat-storage.ts:542-544,1190-1198` |
| 6 | `runtimeViews(store, stageId, learnerKey)` lists sessions + records and folds each with `foldRecords` | `chat-storage.ts:500-505` |
| 7 | a live restore marker triggers `restoreMarkerTargets` deletions + `finalizeRestoreMarker`, then a re-read | `chat-storage.ts:1200-1214` |
| 8 | **no legacy rows** → `loadRuntimeSessions` → `rememberObservedIds` / `rememberObservedSessions` → `reportSnapshot` → return | `chat-storage.ts:1215-1228` |
| 9 | **legacy rows present** → `syncSessions(..., legacy, false, …)` migrates them into the runtime store (per session: `syncOne` → `planChatSync` → `createOrGetRuntimeSession` → `appendPayload`) | `chat-storage.ts:1229-1240,627-679` |
| 10 | `legacyStore.clear(stageId)` **only if `conversion.skippedRows.length === 0`** — the idempotency/no-loss gate | `chat-storage.ts:1250` |
| 11 | `ChatStorageLockUnavailableError` → read-only legacy snapshot returned unmigrated (unless `fallbackToLegacyOnError === false`) | `chat-storage.ts:1256-1277` |
| 12 | any other error → forget the observation so a later stage save cannot retire unseen data, then fall back to `legacy` if non-empty | `chat-storage.ts:1278-1299` |

Idempotency: the clear at step 10 is what makes the migration one-shot; a
partition whose legacy table still holds rows re-migrates on the next load, and
`planChatSync` is written to converge on the newest `updatedAt`
(`chat-storage.ts:652-668`). **Still needed?** Yes — `dexieLegacyStore` is the
default legacy source for every call (`chat-storage.ts:277`), `db.chatSessions`
still exists at Dexie v17 (`lib/utils/database.ts:533`), and
`restoreChatSessionsFromBackup` (`chat-storage.ts:1328`) *writes into* the legacy
tables on purpose as the backup-restore staging path. It is not dead code.

```mermaid
sequenceDiagram
  participant UI as "components/chat"
  participant CS as loadChatSessions
  participant L as "withChatStorageSharedLock + partition locks"
  participant DX as "Dexie chatSessions"
  participant RS as RuntimeStore
  participant SY as syncSessions

  UI->>CS: loadChatSessions(stageId)
  CS->>CS: "context() -> learnerKey, legacyStore"
  CS->>L: "enqueue(shared lock, then partition locks)"
  L->>DX: "load(stageId) inside the lock"
  DX-->>L: legacy rows
  L->>CS: "fromLegacyRecords -> sessions + skippedRows"
  CS->>RS: "runtimeViews(stageId, learnerKey)"
  alt legacy empty
    CS->>RS: loadRuntimeSessions
    RS-->>UI: sessions
  else legacy present
    CS->>SY: "syncSessions(legacy, isolatedWrites)"
    SY->>RS: "createOrGetRuntimeSession + appendRecord"
    CS->>DX: "clear(stageId) only if skippedRows is empty"
    SY-->>UI: migrated sessions
  end
```

## Flow 4 — Asset write, read and reclamation

| # | Hop | Where |
| --- | --- | --- |
| 1 | `PgAssetStore.put(principal, blob, meta)` opens a transaction | `asset/pg.ts` (contract at `asset/types.ts:141-162`) |
| 2 | quota check on the principal's **logical** bytes precedes any physical write | `asset/types.ts:155-161` |
| 3 | claim the `asset_blobs` row for `content_hash` — serialises the write against the collector | `asset/pg.ts:1-11` |
| 4 | write bytes via `byteStore.writeWith(queryable, hash, bytes)` when the layer is in the registry database, else `write(hash, bytes)` with `writesOutsideRegistryDatabase` declared | `asset/pg.ts:12-18`, `lib/persistence/asset-byte-store.ts:132-153` |
| 5 | insert `asset_entries` (`id`, `principal`, `content_hash`, `mime`, `meta`, `revision=1`) and `COMMIT` — every call allocates a fresh `AssetId` | `asset/pg.ts:70-78`, `asset/types.ts:141-149` |
| 6 | read: `GET /api/persistence/assets/<id>` → asset handler → `resolve` (shared blob-row lock) or, when `ASSET_BYTE_EGRESS=redirect` and the layer can sign, `resolveIndirect` → 302 | `route.ts:43-77`, `asset/types.ts:238-266` |
| 7 | `remove` decrements the cross-principal reference count and stamps `asset_blobs.unreferenced_at`; **request paths never delete bytes** | `asset/types.ts:196-205`, `asset/pg.ts:20` |
| 8 | `instrumentation.ts` → `startAssetCollectorSchedule()` → `setInterval(collectNow, ASSET_COLLECTION_INTERVAL_MS)` | `lib/persistence/asset-collector-schedule.ts:88,172` |
| 9 | `AssetCollector.collect()` re-checks and `FOR UPDATE`-locks each candidate blob inside its own transaction, deletes bytes then the row, once `graceMs` has elapsed | `asset-collector-schedule.ts:13-17,136-139` |
| 10 | egress guard: `indirectEgressWithinGrace` refuses `redirect` unless `ASSET_COLLECTION_GRACE_MS >= 10 × DEFAULT_SIGNED_URL_TTL_SECONDS × 1000`, degrading to direct bytes with a warning | `route.ts:63-77` |

```mermaid
stateDiagram-v2
  [*] --> Referenced : "put() inserts asset_entries"
  Referenced --> Referenced : "replace() advances revision"
  Referenced --> Unreferenced : "remove() last entry -> stamp unreferenced_at"
  Unreferenced --> Referenced : "put() of the same bytes reclaims the blob row"
  Unreferenced --> Collected : "AssetCollector.collect() after graceMs, FOR UPDATE"
  Collected --> [*] : "bytes deleted then asset_blobs row deleted"
  note right of Unreferenced
    Request paths never delete bytes.
    A signed read URL must expire well
    inside graceMs or a valid read
    becomes an object-store error.
  end note
```

## Flow 5 — Access-code gate

| # | Hop | Where |
| --- | --- | --- |
| 1 | any request hits `middleware.ts` (matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `logos/`) | `middleware.ts:88-90` |
| 2 | workbench 404 gate runs first (`isProWorkbenchEnabled` + `isAgentRuntimeConfigured` when not on edge) | `middleware.ts:53-58` |
| 3 | `ACCESS_CODE` unset → `NextResponse.next()`, gate fully off | `middleware.ts:60-63` |
| 4 | allowlist: `/api/access-code/*` and `/api/health` pass | `middleware.ts:66-68` |
| 5 | cookie `openmaic_access` is HMAC-verified with `crypto.subtle` (Edge-compatible) against `timestamp.signature` | `middleware.ts:18-44,71-74` |
| 6 | invalid + `/api/*` → 401 `{ success:false, errorCode:'INVALID_REQUEST' }`; invalid + page → **let through**, the frontend shows a modal | `middleware.ts:77-85` |
| 7 | `POST /api/access-code/verify` compares the submitted code with `timingSafeEqual` over `TextEncoder` bytes | `app/api/access-code/verify/route.ts:23-28` |
| 8 | on success `createAccessToken(accessCode)` = `Date.now()` + `HMAC-SHA256(accessCode, timestamp)` hex; set as `openmaic_access`, HttpOnly, SameSite=Lax, `maxAge` 7 days, `secure` in production | `lib/server/access-token.ts:4-8`, `verify/route.ts:30-38` |
| 9 | `GET /api/access-code/status` reports `{ enabled, authenticated }` using the Node `verifyAccessToken` | `app/api/access-code/status/route.ts:5-17`, `access-token.ts:11-25` |

```mermaid
flowchart TD
  req(["Incoming request"]) --> wb{"/workbench and workbench disabled?"}
  wb -->|yes| n404["404 Not found"]
  wb -->|no| ac{"ACCESS_CODE set?"}
  ac -->|no| pass["NextResponse.next()"]
  ac -->|yes| wl{"path is /api/access-code/* or /api/health?"}
  wl -->|yes| pass
  wl -->|no| ck{"cookie openmaic_access verifies<br/>HMAC over its timestamp?"}
  ck -->|yes| pass
  ck -->|no| api{"path starts with /api/?"}
  api -->|yes| j401["401 INVALID_REQUEST"]
  api -->|no| modal["next() — client renders the access-code modal"]
  modal --> verify["POST /api/access-code/verify"]
  verify --> tse{"timingSafeEqual(code, ACCESS_CODE)?"}
  tse -->|no| e401["401 Invalid access code"]
  tse -->|yes| mint["createAccessToken -> Set-Cookie openmaic_access (7 days)"]
```

What the access code does **not** provide: no per-user identity, no
authorization, and no expiry enforcement — the token embeds a timestamp but
neither `verifyAccessToken` (`access-token.ts:11-25`) nor the middleware
(`middleware.ts:18-44`) compares it against a maximum age, so a signed token
stays valid until the cookie's own 7-day `maxAge` removes it client-side. The
HMAC key *is* the access code, so every visitor who knows the code can mint a
token. Middleware also lets unauthenticated **page** requests through by design
(`middleware.ts:84-85`).
