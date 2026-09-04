# Interfaces (a) — TTS and ASR

Every block below is copied from the file named above it. Doc comments are trimmed
where noted; identifiers, order and optionality are unmodified.

Companions: `02b-interfaces-media.md`, `02c-interfaces-whiteboard.md`,
`02d-interfaces-choreography-ir.md`, `02e-interfaces-passes-emitter.md`,
`02f-interfaces-export-app.md`, `02g-interfaces-render-service.md`.

## 1. Provider ids

[`lib/audio/types.ts:94`](lib/audio/types.ts#L94) and [`:187`](lib/audio/types.ts#L187)

```ts
export type BuiltInTTSProviderId =
  | 'openai-tts'
  | 'azure-tts'
  | 'glm-tts'
  | 'qwen-tts'
  | 'voxcpm-tts'
  | 'doubao-tts'
  | 'elevenlabs-tts'
  | 'minimax-tts'
  | 'lemonade-tts'
  | 'browser-native-tts';

export type TTSProviderId = BuiltInTTSProviderId | `custom-tts-${string}`;

export type BuiltInASRProviderId =
  | 'openai-whisper'
  | 'browser-native'
  | 'qwen-asr'
  | 'funasr-asr'
  | 'lemonade-asr'
  | 'azure-asr';

export type ASRProviderId = BuiltInASRProviderId | `custom-asr-${string}`;
```

[`lib/audio/types.ts:216`](lib/audio/types.ts#L216), [`:221`](lib/audio/types.ts#L221)

```ts
export function isCustomTTSProvider(id: string): boolean; // id.startsWith('custom-tts-')
export function isCustomASRProvider(id: string): boolean; // id.startsWith('custom-asr-')
```

## 2. Registry shapes

[`lib/audio/types.ts:99`](lib/audio/types.ts#L99), [`:113`](lib/audio/types.ts#L113), [`:192`](lib/audio/types.ts#L192)

```ts
export interface TTSVoiceInfo {
  id: string;
  name: string;
  language: string;
  localeName?: string;
  gender?: 'male' | 'female' | 'neutral';
  description?: string;
  /** Model IDs this voice is compatible with. Undefined = all models. */
  compatibleModels?: string[];
}

export interface TTSProviderConfig {
  id: TTSProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
  excludeFromAgentVoiceCatalog?: boolean;
  requiresRegisteredVoice?: boolean;
  models: Array<{ id: string; name: string }>;
  defaultModelId: string;
  voices: TTSVoiceInfo[];
  supportedFormats: string[]; // ['mp3', 'wav', 'opus', etc.]
  speedRange?: {
    min: number;
    max: number;
    default: number;
  };
}

export interface ASRProviderConfig {
  id: ASRProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
  models: Array<{ id: string; name: string }>;
  defaultModelId: string;
  supportedLanguages: string[];
  supportedFormats: string[];
}
```

Registries and accessors, by anchor rather than repeated signature:
`TTS_PROVIDERS` ([`lib/audio/constants.ts:119`](lib/audio/constants.ts#L119)), `ASR_PROVIDERS` ([`:1078`](lib/audio/constants.ts#L1078)),
`DEFAULT_TTS_VOICES` (`:1336`), `DEFAULT_TTS_MODELS` (`:1349`) — both default
tables are `Record<BuiltInTTSProviderId, string>`, so a missing provider is a
compile error. Accessors: `getAllTTSProviders` (`:1365`), `getTTSProvider`
(`:1388`), `getManuallySelectableTTSModels` (`:1404`), `getTTSVoices` (`:1415`),
`getAllASRProviders` (`:1425`), `getASRProvider` (`:1436`),
`getASRSupportedLanguages` (`:1449`) — each takes
`(providerId, customProviders?)`.

## 3. The call contract

[`lib/audio/types.ts:151`](lib/audio/types.ts#L151), [`:207`](lib/audio/types.ts#L207)

```ts
export interface TTSModelConfig {
  providerId: TTSProviderId;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  voice: string;
  speed?: number;
  format?: string;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ASRModelConfig {
  providerId: ASRProviderId;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  language?: string;
}
```

[`lib/audio/tts-providers.ts:111`](lib/audio/tts-providers.ts#L111), [`:193`](lib/audio/tts-providers.ts#L193), [`:207`](lib/audio/tts-providers.ts#L207), [`:960`](lib/audio/tts-providers.ts#L960);
[`lib/audio/asr-providers.ts:164`](lib/audio/asr-providers.ts#L164)

```ts
export interface TTSGenerationResult { audio: Uint8Array; format: string }

export function throwIfTtsRateLimited(provider: string, status: number): void;

export async function generateTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult>;

/** Browser-only: reads the settings store. Throws outside a browser context. */
export async function getCurrentTTSConfig(): Promise<TTSModelConfig>;

export async function transcribeAudio(
  config: ASRModelConfig,
  audioBuffer: Buffer | Blob,
): Promise<ASRTranscriptionResult>;
```

## 4. Error classes

[`lib/audio/tts-providers.ts:123`](lib/audio/tts-providers.ts#L123), [`:134`](lib/audio/tts-providers.ts#L134), [`:165`](lib/audio/tts-providers.ts#L165)

```ts
export class TTSRateLimitError extends Error {
  constructor(public readonly provider: string, message: string);
}

export class QwenTTSError extends Error {
  readonly code = 'QWEN_TTS_ERROR';
  readonly httpStatus: number;
  constructor(message: string, httpStatus = 502);
}

export class TTSRequestTimeoutError extends Error {
  constructor(public readonly provider: string, message: string);
}
```

[`lib/server/provider-config.ts:789`](lib/server/provider-config.ts#L789)

```ts
export class TTSModelNotAllowedError extends Error {
  readonly code = 'INVALID_REQUEST';
  readonly httpStatus = 400;
  constructor(providerId: string, modelId: string);
}
```

[`lib/audio/wav-validate.ts:12`](lib/audio/wav-validate.ts#L12)

```ts
export class InvalidReferenceAudioError extends Error {
  readonly code = 'QWEN_VC_REFERENCE_AUDIO_INVALID';
}
```

## 5. Voice/model coupling

[`lib/audio/constants.ts:82`](lib/audio/constants.ts#L82), [`:84`](lib/audio/constants.ts#L84), [`:86`](lib/audio/constants.ts#L86), [`:94`](lib/audio/constants.ts#L94), [`:99`](lib/audio/constants.ts#L99), [`:107`](lib/audio/constants.ts#L107), [`:1379`](lib/audio/constants.ts#L1379)

```ts
export const DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL = 'qwen3-tts-vc-2026-01-22';
export const QWEN_TTS_VOICE_CLONE_MODEL = DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL;

export function isQwenVoiceCloneModel(modelId?: string, configuredModelId?: string): boolean;
export function isQwenCatalogVoice(voiceId?: string): boolean;
export function isQwenCloneVoice(voiceId?: string): boolean;
export function resolveTTSModelForVoice(
  providerId: TTSProviderId,
  voiceId: string,
  requestedModelId?: string,
): string | undefined;
export function isKnownTTSProviderId(id: string): id is TTSProviderId;
```

[`lib/audio/voice-resolver.ts:23`](lib/audio/voice-resolver.ts#L23), [`:37`](lib/audio/voice-resolver.ts#L37), [`:42`](lib/audio/voice-resolver.ts#L42), [`:86`](lib/audio/voice-resolver.ts#L86) (`AgentVoiceOverride` at
`:30` is structurally identical to `ResolvedVoice`)

```ts
export interface ResolvedVoice {
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
}

export type AgentVoiceOverrides = Record<string, AgentVoiceOverride>;

export function resolveNarratorVoiceBinding(
  bound: AgentConfig['voiceConfig'] | undefined,
  globalVoice: ResolvedVoice,
  providerConfigs: ProviderConfigMap,
): ResolvedVoice;

export function resolveAgentVoice(
  agent: AgentConfig,
  agentIndex: number,
  enabledProviders: ProviderWithVoices[],
  overrides?: AgentVoiceOverrides,
): ResolvedVoice | null;
```

Server-side resolution — `lib/server/provider-config.ts`:

```ts
export function getServerTTSProviders(): Record<string, { disabled?: boolean }>; // :749
export function enabledServerTTSProviderIds(): string[];                         // :762
export function resolveTTSApiKey(providerId: string, clientKey?: string): string; // :768
export function isServerTTSProviderDisabled(providerId: string): boolean;         // :773
export function resolveTTSBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined; // :777
export function resolveQwenVoiceCloneModel(): string;                            // :785
export function resolveTTSModel(providerId: string, clientModel?: string, voiceId?: string): string | undefined; // :805
```

## 6. Duration, chunking, reference-audio validation

[`lib/audio/audio-duration.ts:55`](lib/audio/audio-duration.ts#L55), [`:121`](lib/audio/audio-duration.ts#L121), [`:210`](lib/audio/audio-duration.ts#L210)

```ts
export function measureWavDuration(input: Uint8Array | ArrayBuffer): number | null;
export function measureMp3Duration(input: Uint8Array | ArrayBuffer): number | null;
export function measureAudioDuration(
  input: Uint8Array | ArrayBuffer,
  format?: string,
): number | null;
```

[`lib/audio/tts-utils.ts:12`](lib/audio/tts-utils.ts#L12), [`:21`](lib/audio/tts-utils.ts#L21), [`:82`](lib/audio/tts-utils.ts#L82)

```ts
export const TTS_MAX_TEXT_LENGTH: Partial<Record<TTSProviderId, number>>; // { 'glm-tts': 1024 }
export function splitLongSpeechText(text: string, maxLength: number): string[];
export function splitLongSpeechActions(actions: Action[], providerId: TTSProviderId): Action[];
```

[`lib/audio/wav-validate.ts:1`](lib/audio/wav-validate.ts#L1), [`:6`](lib/audio/wav-validate.ts#L6), [`:26`](lib/audio/wav-validate.ts#L26)

```ts
export const QWEN_REFERENCE_SAMPLE_RATE = 24_000;
export const QWEN_REFERENCE_CHANNELS = 1;
export const MIN_REFERENCE_DURATION_SECONDS = 1;
export const MAX_REFERENCE_DURATION_SECONDS = 60;

export interface ValidatedReferenceAudio {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

export function validateReferenceAudio(audio: Uint8Array): ValidatedReferenceAudio;
```

## 7. How the audio types connect

```mermaid
classDiagram
  class TTSProviderConfig {
    +TTSProviderId id
    +boolean requiresApiKey
    +Array models
    +string defaultModelId
    +voices TTSVoiceInfo list
    +supportedFormats string list
  }
  class TTSVoiceInfo {
    +string id
    +string language
    +compatibleModels string list
  }
  class ResolvedVoice {
    +TTSProviderId providerId
    +string modelId
    +string voiceId
  }
  class TTSModelConfig {
    +TTSProviderId providerId
    +string voice
    +string modelId
    +number speed
    +AbortSignal signal
  }
  class TTSGenerationResult {
    +Uint8Array audio
    +string format
  }
  class AudioFileRecord {
    +string id
    +Blob blob
    +number duration
    +string format
    +string ossKey
  }
  class TTSModelNotAllowedError {
    +code INVALID_REQUEST
    +httpStatus 400
  }
  TTSProviderConfig "1" *-- "many" TTSVoiceInfo
  TTSProviderConfig <.. ResolvedVoice : "resolveAgentVoice / resolveNarratorVoiceBinding"
  ResolvedVoice --> TTSModelConfig : "route builds the call config"
  TTSModelConfig ..> TTSModelNotAllowedError : "resolveTTSModel rejects a non-pinned model"
  TTSModelConfig --> TTSGenerationResult : "generateTTS()"
  TTSGenerationResult --> AudioFileRecord : "measureAudioDuration() then db.audioFiles.put()"
```

```mermaid
flowchart LR
  V["voiceId"] --> C{"isQwenCatalogVoice?"}
  C -- yes --> M1["catalog model (pinned non-VC, else defaultModelId)"]
  C -- no --> M2["QWEN_TTS_VOICE_CLONE_MODEL"]
  M1 --> S["resolveTTSModel (server, authoritative)"]
  M2 --> S
  S --> P{"pinnedModels non-empty and model not allowed?"}
  P -- yes --> E["throw TTSModelNotAllowedError (400)"]
  P -- no --> G["generateTTS(config, text)"]
```
