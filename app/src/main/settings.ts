// 설정과 키. 키는 OS 키체인(safeStorage)으로 암호화해 userData 에 둔다.
//
// 기존 구현 는 브라우저 탭에서 sessionStorage, 데스크톱에서 keychain 을 쓴다. 여기서는 데스크톱뿐이므로
// 한 경로만 있으면 된다 — 그리고 키가 renderer 로 내려가지 않는다(모든 provider 호출이 main 에서
// 일어나므로 renderer 는 키를 알 필요가 없다).
import { app, safeStorage } from 'electron';
import { LEGACY_PROVIDER_IDS, providerById, resolveBaseUrl } from './providers.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyScope, type Settings } from '../shared/ipc.ts';

const dir = () => {
    const d = app.getPath('userData');
    mkdirSync(d, { recursive: true });
    return d;
};
const settingsPath = () => join(dir(), 'settings.json');
const keysPath = () => join(dir(), 'keys.json');

/**
 * 기본값은 **비워 둔다**.
 *
 * baseUrl·model 을 공급자의 구체값으로 박아 두면, 공급자를 바꿔도 이전 값이 남아 조용히 틀린
 * 조합이 되고(다른 공급자의 주소로 새 모델 호출), 사용자 눈에는 "값이 이미 들어 있다"로 보인다.
 * 빈 문자열은 "공급자 기본을 쓴다"는 뜻이다.
 */
export const DEFAULT_SETTINGS: Settings = {
    provider: 'deepseek',
    baseUrl: '',
    model: '',
    temperature: 0.3,
    maxTokens: 8192,
    issues: 2,
    claims: 5,
    withPaper: true,
    assumeUnavailable: false,
    contactEmail: '',
    workspace: '',
    theme: 'system',
    roles: {},
    scale: 'standard',
    snowballDepth: 2,
    settingsVersion: 2,
};

/**
 * 예전 공급자 표(2026-10-27 까지)의 기본 모델. 예전에는 빈 model 이 "그 공급자의 첫 모델"을 뜻했는데,
 * 새 표(기존 구현)는 많은 공급자의 시드가 비어 있어(목록을 받아오는 곳) 빈 model 이 "모델 없음"이 된다.
 */
const OLD_DEFAULT_MODEL: Record<string, string> = {
    deepseek: 'deepseek-chat',
    openai: 'gpt-4.1',
    anthropic: 'claude-sonnet-4-5',
    openrouter: 'deepseek/deepseek-chat',
    moonshot: 'kimi-k2-0905-preview',
    groq: 'llama-3.3-70b-versatile',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    xai: 'grok-3',
    mistral: 'mistral-large-latest',
    ollama: 'qwen2.5:32b',
};

const originOf = (u: string): string => {
    try {
        return new URL(u).origin;
    } catch {
        return '';
    }
};

/** 키체인 항목을 다른 이름으로 복사한다(암호문 그대로). 이미 있으면 건드리지 않는다. */
function copyKey(from: string, to: string): void {
    const keys = readKeys();
    if (!keys[from] || keys[to] || from === to) return;
    keys[to] = keys[from];
    try {
        writeFileSync(keysPath(), JSON.stringify(keys, null, 2));
    } catch {
        /* 키 파일을 쓸 수 없으면 사용자가 다시 넣는다 */
    }
}

/**
 * 예전 설정 파일(settingsVersion 없음)을 한 번 옮긴다.
 *  · 고정 주소 공급자(예: deepseek)에 다른 호스트의 Base URL 을 덮어써 두었다면(LiteLLM·사내 게이트웨이) — 그 주소를 버리면
 *    게이트웨이용 키가 공급자의 공식 호스트로 간다. 그래서 'OpenAI 호환 엔드포인트'로 옮기고 주소와 키를 함께 옮긴다.
 *  · 예전 'custom' 은 주소와 키를 openai-compatible@주소 로 옮긴다.
 *  · 빈 model 이 예전 기본 모델을 뜻했는데 새 표에 기본이 없으면 예전 기본을 적어 둔다(역할도).
 */
function migrateV1(raw: Partial<Settings>, s: Settings): void {
    const oldProvider = raw.provider ?? DEFAULT_SETTINGS.provider;
    const oldBase = (raw.baseUrl ?? '').trim().replace(/\/+$/, '');
    const def = providerById(oldProvider);
    if (oldBase && def) {
        const editable = def.endpointEditable;
        const sameHost = originOf(oldBase) === originOf(def.baseUrl);
        if (editable) {
            s.endpoints = { ...(s.endpoints ?? {}), [def.id]: oldBase };
            copyKey(oldProvider, keyScope(def, oldBase));
        } else if (!sameHost) {
            const oc = providerById('openai-compatible')!;
            s.provider = oc.id;
            s.endpoints = { ...(s.endpoints ?? {}), [oc.id]: oldBase };
            if (!s.model) s.model = OLD_DEFAULT_MODEL[oldProvider] ?? '';
            copyKey(oldProvider, keyScope(oc, oldBase));
        }
    }
    const now = providerById(s.provider);
    if (!s.model && now && !now.models.length && OLD_DEFAULT_MODEL[oldProvider]) s.model = OLD_DEFAULT_MODEL[oldProvider]!;
    for (const [role, r] of Object.entries(raw.roles ?? {})) {
        const cur = s.roles?.[role as keyof Settings['roles']];
        if (!r?.provider || !cur || cur.model) continue;
        const rp = providerById(cur.provider);
        if (rp && !rp.models.length && OLD_DEFAULT_MODEL[r.provider]) cur.model = OLD_DEFAULT_MODEL[r.provider]!;
    }
}

const clamp = (n: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : fallback;

/** 저장된 설정을 정규화한다. 예전 버전이 박아 둔 값도 여기서 "기본"으로 되돌아온다. */
export function getSettings(): Settings {
    let raw: Partial<Settings> = {};
    try {
        raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>;
    } catch {
        /* 기본값으로 시작한다 */
    }
    // roles 는 깊은 복사 — 기본값 객체를 고쳐 쓰지 않게
    const s: Settings = { ...DEFAULT_SETTINGS, ...raw, roles: JSON.parse(JSON.stringify(raw.roles ?? {})) };
    // 예전 공급자 이름(moonshot → kimi, custom → openai-compatible). 역할별 공급자도.
    s.provider = LEGACY_PROVIDER_IDS[s.provider] ?? s.provider;
    if (!providerById(s.provider)) s.provider = DEFAULT_SETTINGS.provider;
    for (const r of Object.values(s.roles ?? {})) if (r?.provider) r.provider = LEGACY_PROVIDER_IDS[r.provider] ?? r.provider;
    // 예전 파일이면 한 번 옮긴다(주소·키·빈 모델). 새 파일은 settingsVersion 이 있다.
    if (Object.keys(raw).length && raw.settingsVersion === undefined) migrateV1(raw, s);
    s.settingsVersion = 2;
    // Base URL 덮어쓰기는 이제 endpoints(주소를 바꿀 수 있는 공급자만)로 한다 — 기존 구현 규칙.
    s.baseUrl = '';
    const p = providerById(s.provider);
    // 공급자의 기본값과 같은 값은 "기본"과 구별되지 않는다 — 비워서 기본으로 되돌린다.
    if (p && p.models.includes(s.model) && p.models[0] === s.model) s.model = '';
    // 범위를 벗어난 값은 **최대값으로 자르지 않고 기본값으로 되돌린다.** 1,000,000 을 65,536 으로
    // 자르면 여전히 말이 안 되는 값이 남고, 모델이 그대로 거절한다. 오타는 오타로 처리한다.
    s.temperature = s.temperature >= 0 && s.temperature <= 2 ? s.temperature : DEFAULT_SETTINGS.temperature;
    // 응답(출력) 토큰. 상한은 모델마다 다르므로 넉넉히 두고 UI 가 모델별 상한을 보여 준다.
    // 범위는 기존 구현 의 max_output_tokens 와 같다(1 ~ 1,000,000). 모델별 상한은 UI 가 보여 준다.
    s.maxTokens = clamp(s.maxTokens, 1, 1_000_000, DEFAULT_SETTINGS.maxTokens);
    // top_p·seed 는 비어 있으면 보내지 않는다. 범위 밖이면 지운다.
    if (s.topP !== undefined && !(typeof s.topP === 'number' && s.topP >= 0 && s.topP <= 1)) delete s.topP;
    if (s.seed !== undefined && !(typeof s.seed === 'number' && Number.isFinite(s.seed))) delete s.seed;
    else if (s.seed !== undefined) s.seed = Math.round(s.seed);
    s.snowballDepth = clamp(s.snowballDepth ?? 2, 1, 3, 2);
    // 자체점검·스크린샷용 워크스페이스 덮어쓰기. 저장하지 않는다 — 사용자의 설정 파일은 그대로다.
    if (process.env.LPS_WORKSPACE) s.workspace = process.env.LPS_WORKSPACE;
    return s;
}

/** 실제로 호출할 주소·모델. 주소는 바꿀 수 있는 공급자만 덮어쓴다(endpoints), 모델은 비어 있으면 공급자 기본. */
export function effectiveModel(s: Settings): { baseUrl: string; model: string } {
    const p = providerById(s.provider);
    return { baseUrl: resolveBaseUrl(p, s.endpoints?.[p?.id ?? '']), model: s.model || p?.models[0] || '' };
}

export function saveSettings(next: Settings): Settings {
    const merged = { ...DEFAULT_SETTINGS, ...next };
    // 스크린샷·점검용 워크스페이스 덮어쓰기 중에는 디스크에 쓰지 않는다 — 임시 경로가 설정에 남는다.
    if (process.env.LPS_WORKSPACE) return merged;
    writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
    return merged;
}

interface KeysFile {
    [provider: string]: string;
}

const readKeys = (): KeysFile => {
    try {
        return JSON.parse(readFileSync(keysPath(), 'utf8')) as KeysFile;
    } catch {
        return {};
    }
};

/**
 * 키 저장. safeStorage 를 못 쓰는 환경(키체인 없는 리눅스 등)에서는 **평문으로 저장하지 않고**
 * 저장을 거부한다 — 조용히 평문으로 떨어뜨리는 것이 이 함수가 저지를 수 있는 가장 나쁜 일이다.
 */
export function setKey(provider: string, key: string): { ok: boolean; error?: string } {
    if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, error: 'OS 키체인을 사용할 수 없어 키를 저장하지 않았습니다. 이번 세션에서만 사용합니다.' };
    }
    const keys = readKeys();
    keys[provider] = safeStorage.encryptString(key).toString('base64');
    writeFileSync(keysPath(), JSON.stringify(keys, null, 2));
    return { ok: true };
}

export function getKey(provider: string): string | null {
    const keys = readKeys();
    // 예전 이름으로 저장된 키(moonshot → kimi)도 찾는다. 정확히 같은 이름만 — 주소별 키(id@origin)는 따라가지 않는다
    // (예전 'custom' 키는 migrateV1 이 그 주소의 이름으로 옮겨 둔다).
    const legacy = Object.entries(LEGACY_PROVIDER_IDS).find(([, now]) => provider === now)?.[0];
    const enc = keys[provider] ?? (legacy ? keys[legacy] : undefined);
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
        return null;
    }
}

export const hasKey = (provider: string): boolean => getKey(provider) !== null;

export const userDataDir = (): string => dir();
export const exists = (p: string): boolean => existsSync(p);
