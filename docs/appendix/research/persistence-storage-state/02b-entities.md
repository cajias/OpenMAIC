# Persisted entities — real column and field names

Companion to `02a-interfaces-abstraction.md`. Every table and store below is
declared in the cited file:line; nothing here is inferred from a name.

## Persisted PostgreSQL entities

20 tables are declared across the package and the app
(`/usr/bin/grep -rhoE "CREATE TABLE IF NOT EXISTS [a-z_]+" packages/@openmaic/storage/src lib/persistence | sed 's/.*EXISTS //' | sort -u | wc -l` → 20).

```mermaid
erDiagram
  document_stages {
    TEXT id PK
    TEXT name
    TEXT description
    BOOLEAN interactive_mode
    BOOLEAN task_engine_mode
    DOUBLE created_at
    DOUBLE updated_at
    TEXT owner_id
    TEXT folder_id
    JSONB data
  }
  document_scenes {
    TEXT stage_id PK
    TEXT id PK
    DOUBLE scene_order
    JSONB data
  }
  document_outlines {
    TEXT stage_id PK
    JSONB data
  }
  document_folders {
    TEXT owner_id PK
    TEXT id PK
    TEXT name
    TEXT normalized_name
    DOUBLE created_at
    DOUBLE updated_at
    DOUBLE folder_order
  }
  document_stage_revision {
    TEXT stage_id PK
    BIGINT rev
  }
  document_scene_revision {
    TEXT stage_id PK
    TEXT scene_id PK
    BIGINT rev
  }
  stage_meta {
    TEXT stage_id PK
    TEXT owner_id
    BOOLEAN is_public
    TIMESTAMPTZ deleted_at
    DOUBLE published_at
    BOOLEAN generation_complete
  }
  document_stages ||--o{ document_scenes : "stage_id FK CASCADE"
  document_stages ||--o| document_outlines : "stage_id FK CASCADE"
  document_stages ||--o| stage_meta : "stage_id FK CASCADE"
  document_stages ||--o| document_stage_revision : "trigger maintained"
  document_scenes ||--o| document_scene_revision : "trigger maintained"
  document_folders ||--o{ document_stages : "folder_id soft ref"
```

Source: `packages/@openmaic/storage/src/document/pg.ts:58-225`,
`lib/persistence/stage-meta.ts:24-48`. `document_folders` has
`UNIQUE (owner_id, normalized_name)`; `folder_id` on `document_stages` is a plain
column with no FK.

```mermaid
erDiagram
  agent_sessions {
    TEXT id PK
    TEXT owner_id
    TEXT prompt
    TEXT title
    TEXT stage_id
    TEXT active_stage_id
    TEXT skill_id
    TEXT origin
    BOOLEAN existing_course
    TEXT status
    INTEGER attempt
    INTEGER delivered_user_message_seq
    TEXT lease_worker_id
    INTEGER lease_worker_pid
    BIGINT lease_heartbeat_at
    BIGINT cancel_requested_at
    TEXT error
    TIMESTAMPTZ created_at
    TIMESTAMPTZ updated_at
    TIMESTAMPTZ deleted_at
  }
  agent_session_events {
    TEXT session_id PK
    INTEGER seq PK
    BIGINT ts
    INTEGER attempt
    TEXT type
    JSONB data
  }
  agent_session_entries {
    TEXT session_id PK
    INTEGER seq PK
    TEXT entry_id
    TEXT parent_id
    TEXT type
    JSONB data
    TIMESTAMPTZ ts
    INTEGER attempt
  }
  agent_session_urls {
    TEXT session_id PK
    TEXT url PK
    TEXT source
    TIMESTAMPTZ created_at
  }
  agent_session_materials {
    TEXT id PK
    TEXT session_id
    TEXT kind
    TEXT title
    TEXT source_url
    TEXT text_asset_id
    TEXT raw_asset_id
    INTEGER text_chars
    TEXT derived_from
    TEXT extraction_status
    INTEGER extraction_attempts
    TEXT extraction_error
    JSONB extraction_stats
    TEXT extractor_version
    TEXT extraction_lease_worker_id
    INTEGER extraction_lease_worker_pid
    BIGINT extraction_lease_heartbeat_at
    TIMESTAMPTZ created_at
  }
  agent_owner_session_events {
    TEXT owner_id PK
    BIGINT id PK
    BIGINT ts
    TEXT session_id
    TEXT type
    TEXT status
    INTEGER attempt
    JSONB data
  }
  agent_owner_session_event_counters {
    TEXT owner_id PK
    BIGINT n
  }
  agent_user_skill {
    TEXT id PK
    TEXT owner_id
    TEXT name
    TEXT title
    TEXT description
    TEXT content
    INTEGER version
    TIMESTAMPTZ created_at
    TIMESTAMPTZ updated_at
    TIMESTAMPTZ deleted_at
  }
  agent_sessions ||--o{ agent_session_events : "session_id FK CASCADE"
  agent_sessions ||--o{ agent_session_entries : "session_id FK CASCADE"
  agent_sessions ||--o{ agent_session_urls : "session_id FK CASCADE"
  agent_sessions ||--o{ agent_session_materials : "session_id FK CASCADE"
  agent_session_materials ||--o{ agent_session_materials : "derived_from FK CASCADE"
  agent_owner_session_event_counters ||--o{ agent_owner_session_events : "owner_id counter"
```

Source: `packages/@openmaic/storage/src/agent-session/pg.ts:87-245`,
`material/pg.ts:55-89`, `skill/pg.ts:50-76`. `agent_session_entries` has a
self-referential composite FK `(session_id, parent_id) → (session_id, entry_id)`
(`agent-session/pg.ts:148-151`). `agent_user_skill` carries five CHECK constraints
including `name ~ '^my-[a-z0-9]+(?:-[a-z0-9]+)*$'`, `length(title) BETWEEN 1 AND 80`,
`octet_length(content) BETWEEN 1 AND 65536` (`skill/pg.ts:62-69`).

```mermaid
erDiagram
  runtime_sessions {
    TEXT id PK
    TEXT stage_id
    TEXT learner_key
    TEXT kind
    TEXT status
    TEXT created_at
    TEXT updated_at
    JSONB data
  }
  runtime_records {
    TEXT id
    TEXT session_id
    BIGINT seq
    TEXT scene_id
    TEXT created_at
    JSONB data
  }
  asset_blobs {
    TEXT content_hash PK
    BIGINT byte_size
    BYTEA bytes
    TIMESTAMPTZ unreferenced_at
  }
  asset_entries {
    TEXT id PK
    TEXT principal
    TEXT content_hash
    TEXT mime
    JSONB meta
    INTEGER revision
    DOUBLE created_at
  }
  owner_material {
    TEXT id PK
    TEXT owner_id
    TEXT kind
    TEXT derived_from
    TEXT mime
    DOUBLE bytes
    TEXT original_name
    TEXT oss_key
    TEXT sha256
    TEXT status
    JSONB extraction
    DOUBLE created_at
    DOUBLE deleted_at
  }
  runtime_sessions ||--o{ runtime_records : "session_id FK CASCADE"
  asset_blobs ||--o{ asset_entries : "content_hash FK dedup"
```

Source: `runtime/pg.ts:68-97`, `asset/pg.ts:63-85`,
`lib/persistence/owner-materials.ts:102-130`. `runtime_records` has
`UNIQUE (session_id, seq)` rather than a primary key. `asset_entries.content_hash`
is many-to-one on `asset_blobs`, which is what makes global deduplication
reclaimable; `asset_blobs.unreferenced_at` is stamped, never deleted, on the
request path.

## Browser-side stores

| Store | Kind | Name / key | Declared at |
| --- | --- | --- | --- |
| Documents | IndexedDB | `maic-documents` (`STAGES`, `SCENES` keyed `['stageId','id']`, `OUTLINES` keyed `stageId`) | `document/browser.ts:150,163-172` |
| Runtime | IndexedDB | `maic-runtime` (`SESSIONS` keyed `id`, `RECORDS` keyed `['sessionId','seq']`) | `runtime/browser.ts:152,164-176` |
| Asset pool | IndexedDB | `maic-asset-pool` (`ASSETS`, `BLOBS` in the same database) | `asset/browser-store.ts:164,183-189` |
| Legacy app DB | IndexedDB (Dexie) | `MAIC-Database`, version 17 | `lib/utils/database.ts:299-300,562` |
| KV | localStorage | `maic:account:*`, `maic:device:*` | `kv/browser.ts:34,37-41` |
| Settings blob | KV `account` | `settings-storage` | `lib/store/settings.ts:1984` |
| Profile blob | KV `account` | `user-profile-storage` | `lib/store/user-profile.ts:53` |
| Learner key | KV `device` | `runtime.learnerKey` (`anon:<uuid>`) | `lib/runtime/learner-key.ts:17,31-37` |
| Storage generation | KV `device` | `document-storage-generation` | `lib/document-store/storage-generation.ts:3` |
| Migration markers | KV `device` | `document-migration:<stageId>` | `lib/document-store/migration.ts:98` |
| Workbench panel pref | raw localStorage | `workbench.panel.<sessionId>` | `lib/workbench/session-store.ts:570` |
| Access cookie | HTTP cookie | `openmaic_access` (HttpOnly, SameSite=Lax, 7 d) | `app/api/access-code/verify/route.ts:32-38` |
| Anonymous owner cookie | HTTP cookie | `anonymous_id` (HttpOnly, SameSite=Lax, 30 d) | `lib/server/agent-runtime/owner.ts:3-4,22-28` |

Dexie table set at v17 (`lib/utils/database.ts:307-322`): `stages`, `scenes`,
`audioFiles`, `imageFiles`, `snapshots`, `chatSessions`, `chatRestoreStaging`,
`playbackState`, `stageOutlines`, `mediaFiles`, `generatedAgents`,
`voiceProfiles`, `autoVoiceCache`, `agentEditSessions`, `folders`, `stageFolders`.
Version 13 was skipped deliberately — it "briefly added `chatStorageLocks` on the
draft chat cutover branch"; v14 drops it with `chatStorageLocks: null`
(`database.ts:524-542`).
