// LLM 공급자 카탈로그 — 기존 구현 의 PROVIDERS(frontend/.../agent/config.ts)를 그대로 옮긴 것.
//
// 공급자의 **정체**(주소·모델·키 형식·인증 헤더·특이사항)는 데이터이고, **전송 방식**만 코드다.
// 거의 모두 OpenAI 호환(/chat/completions)이라 한 줄짜리 데이터 행이고, 코드가 필요한 것은 전송이
// 정말 다른 둘 — Anthropic(Messages API, x-api-key) — 과 DeepSeek(전송은 OpenAI 호환, 표시만 구분) 뿐이다.
//
// 기존 구현 와 다른 점(브라우저가 아니라 Electron main·Node 에서 호출하기 때문):
//  · `cors` 필드는 뺐다. CORS 는 브라우저의 제약이고 main 프로세스에는 없다 — 기존 구현 가 'blocked' 로
//    표시한 Cerebras·SambaNova·Baseten 도 여기서는 보통 공급자다(기존 구현 주석이 말한 "데스크톱 래퍼"가 이것이다).
//  · Anthropic 의 `anthropic-dangerous-direct-browser-access` 헤더는 브라우저용 동의 표시라 뺐다.
//  · `streamUsage` 는 옮겨 두었지만 쓰지 않는다 — 이 앱은 스트리밍하지 않는다.
//  · `maxOutput` 은 이 앱이 원래 가지고 있던 출력 상한 정보(공식 문서 기준)를 살렸다.
//  · `keyEnv` 는 CLI 가 .env 에서 키를 찾는 이름이다.
import table from './data/model-context.json' with { type: 'json' };

export type Transport = 'openai-compatible' | 'deepseek' | 'anthropic';
export type ModelsSource = 'openai' | 'ollama-tags' | 'openrouter' | 'gateway' | 'static';

export interface ProviderDef {
    id: string;
    label: string;
    /** 처음 보여 줄 모델(시드). 실제 목록은 modelsSource 로 받아온다. 첫 항목이 기본 모델. */
    models: string[];
    /** 생략하면 'openai-compatible' */
    transport?: Transport;
    /** 요청 경로(/chat/completions · /messages)가 붙는 완전한 기본 주소. 버전 경로까지 포함한다. */
    baseUrl: string;
    /** 인증 말고 이 공급자가 요구하는 헤더 */
    extraHeaders?: Record<string, string>;
    keyHint: string;
    /** 'optional' — 로컬 런타임은 키가 없어도 되지만 인증 프록시 뒤라면 필요하다 */
    auth: 'required' | 'optional' | 'none';
    modelsSource?: ModelsSource;
    /** 'bearer' 면 Authorization: Bearer, 아니면 키를 담을 헤더 이름 그대로 */
    authHeader?: 'bearer' | (string & {});
    /** 고르는 칸 아래에 보일 한 줄 */
    note?: string;
    /** 주소를 바꿀 수 있는 항목. 키는 주소(origin)별로 따로 보관한다 — 키가 다른 호스트로 따라가지 않게. */
    endpointEditable?: boolean;
    /** 스트리밍 사용량 요청 가능 여부(기존 구현 그대로; 이 앱은 스트리밍하지 않아 쓰지 않는다) */
    streamUsage?: boolean;
    /** 모델별 출력(max_tokens) 상한. 모르면 생략 */
    maxOutput?: Record<string, number>;
    /** CLI 가 키를 찾는 환경변수 */
    keyEnv?: string;
}

export const PROVIDERS: ProviderDef[] = [
    {
        id: 'deepseek',
        label: 'DeepSeek',
        transport: 'deepseek',
        models: ['deepseek-flash', 'deepseek-v4-pro'],
        keyHint: 'api.deepseek.com key (sk-…)',
        auth: 'required',
        baseUrl: 'https://api.deepseek.com',
        modelsSource: 'openai',
        // 공식 문서: max_tokens 1 ~ 393,216. 옛 이름 deepseek-chat(8K)·deepseek-reasoner(64K)도 아직 응답한다.
        maxOutput: { 'deepseek-flash': 393216, 'deepseek-v4-pro': 393216, 'deepseek-chat': 8192, 'deepseek-reasoner': 65536 },
        keyEnv: 'DEEPSEEK_API_KEY',
    },
    {
        id: 'kimi',
        label: 'Kimi (Moonshot)',
        // moonshot-v1-8k 는 일부러 뺐다 — 긴 프롬프트를 담지 못한다.
        models: ['kimi-k3', 'kimi-k2.6', 'moonshot-v1-128k'],
        baseUrl: 'https://api.moonshot.ai/v1',
        keyHint: 'platform.moonshot.ai key (sk-…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'MOONSHOT_API_KEY',
    },
    {
        id: 'openai',
        label: 'OpenAI',
        models: [],
        baseUrl: 'https://api.openai.com/v1',
        keyHint: 'platform.openai.com key (sk-…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'OPENAI_API_KEY',
    },
    {
        // 키 하나로 여러 회사 모델. 대신 OpenRouter 가 모든 프롬프트와 결과를 본다.
        id: 'openrouter',
        label: 'OpenRouter',
        models: [],
        baseUrl: 'https://openrouter.ai/api/v1',
        keyHint: 'openrouter.ai key (sk-or-…)',
        auth: 'required',
        modelsSource: 'openrouter',
        keyEnv: 'OPENROUTER_API_KEY',
    },
    {
        id: 'groq',
        label: 'Groq',
        models: [],
        baseUrl: 'https://api.groq.com/openai/v1',
        keyHint: 'console.groq.com key (gsk_…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'GROQ_API_KEY',
    },
    {
        id: 'mistral',
        label: 'Mistral',
        models: [],
        baseUrl: 'https://api.mistral.ai/v1',
        keyHint: 'console.mistral.ai key',
        auth: 'required',
        modelsSource: 'openai',
        streamUsage: false,
        keyEnv: 'MISTRAL_API_KEY',
    },
    {
        id: 'xai',
        label: 'xAI (Grok)',
        models: [],
        baseUrl: 'https://api.x.ai/v1',
        keyHint: 'console.x.ai key (xai-…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'XAI_API_KEY',
    },
    {
        id: 'together',
        label: 'Together AI',
        models: [],
        baseUrl: 'https://api.together.xyz/v1',
        keyHint: 'api.together.ai key',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'TOGETHER_API_KEY',
    },
    {
        // Google 의 OpenAI 호환 표면. /models 경로가 인증해도 404 라 시드 목록을 쓴다.
        id: 'gemini',
        label: 'Google Gemini',
        models: ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        keyHint: 'aistudio.google.com key (AIza…)',
        auth: 'required',
        modelsSource: 'static',
        note: '값에 비해 문맥이 길다.',
        keyEnv: 'GEMINI_API_KEY',
    },
    {
        id: 'deepinfra',
        label: 'DeepInfra',
        models: [],
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        keyHint: 'deepinfra.com token',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'DEEPINFRA_API_KEY',
    },
    {
        id: 'novita',
        label: 'Novita AI',
        models: [],
        baseUrl: 'https://api.novita.ai/v3/openai',
        keyHint: 'novita.ai key',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'NOVITA_API_KEY',
    },
    {
        id: 'fireworks',
        label: 'Fireworks AI',
        models: [],
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        keyHint: 'fireworks.ai key (fw_…)',
        auth: 'required',
        modelsSource: 'openai',
        note: '오픈 웨이트 호스트 가운데 도구 호출이 가장 믿을 만하다.',
        keyEnv: 'FIREWORKS_API_KEY',
    },
    {
        // 국제 호스트. 중국 본토 호스트(dashscope.aliyuncs.com)는 계정 공간이 달라 키가 통하지 않는다.
        id: 'dashscope',
        label: 'Alibaba Qwen (DashScope)',
        models: [],
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        keyHint: 'DashScope key (sk-…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'DASHSCOPE_API_KEY',
    },
    {
        id: 'nebius',
        label: 'Nebius AI Studio',
        models: [],
        baseUrl: 'https://api.studio.nebius.com/v1',
        keyHint: 'studio.nebius.com key',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'NEBIUS_API_KEY',
    },
    {
        id: 'chutes',
        label: 'Chutes',
        models: [],
        baseUrl: 'https://llm.chutes.ai/v1',
        keyHint: 'chutes.ai key (cpk_…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'CHUTES_API_KEY',
    },
    {
        id: 'hyperbolic',
        label: 'Hyperbolic',
        models: [],
        baseUrl: 'https://api.hyperbolic.xyz/v1',
        keyHint: 'hyperbolic.xyz key',
        auth: 'required',
        modelsSource: 'openai',
        note: 'vLLM 기반이라 도구 호출은 모델에 따라 다르다.',
        keyEnv: 'HYPERBOLIC_API_KEY',
    },
    {
        id: 'featherless',
        label: 'Featherless',
        models: [],
        baseUrl: 'https://api.featherless.ai/v1',
        keyHint: 'featherless.ai key',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'FEATHERLESS_API_KEY',
    },
    {
        // 키 하나로 약 300개 모델. OpenRouter 와 같은 공개 범위 문제가 있다.
        id: 'vercel-gateway',
        label: 'Vercel AI Gateway',
        models: [],
        baseUrl: 'https://ai-gateway.vercel.sh/v1',
        keyHint: 'vercel.com AI Gateway key',
        auth: 'required',
        modelsSource: 'gateway',
        keyEnv: 'AI_GATEWAY_API_KEY',
    },
    {
        id: 'cerebras',
        label: 'Cerebras',
        models: [],
        baseUrl: 'https://api.cerebras.ai/v1',
        keyHint: 'cloud.cerebras.ai key (csk-…)',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'CEREBRAS_API_KEY',
    },
    {
        id: 'sambanova',
        label: 'SambaNova',
        models: [],
        baseUrl: 'https://api.sambanova.ai/v1',
        keyHint: 'cloud.sambanova.ai key',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'SAMBANOVA_API_KEY',
    },
    {
        id: 'baseten',
        label: 'Baseten',
        models: [],
        baseUrl: 'https://inference.baseten.co/v1',
        keyHint: 'baseten.co API key',
        auth: 'required',
        modelsSource: 'openai',
        keyEnv: 'BASETEN_API_KEY',
    },
    {
        // OpenAI 모양이 아니고 Bearer 도 아니다 — 전송이 따로 있는 유일한 클라우드 항목.
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        transport: 'anthropic',
        models: [],
        baseUrl: 'https://api.anthropic.com/v1',
        keyHint: 'console.anthropic.com key (sk-ant-…)',
        auth: 'required',
        authHeader: 'x-api-key',
        modelsSource: 'openai',
        extraHeaders: { 'anthropic-version': '2023-06-01' },
        keyEnv: 'ANTHROPIC_API_KEY',
    },
    {
        // 표에 없는 게이트웨이(LiteLLM·vLLM·TGI·사내 프록시)를 위한 일반 항목.
        id: 'openai-compatible',
        label: 'OpenAI 호환 엔드포인트',
        models: [],
        baseUrl: 'http://127.0.0.1:8000/v1',
        keyHint: '그 엔드포인트가 요구하면',
        auth: 'optional',
        endpointEditable: true,
        modelsSource: 'openai',
        note: '/v1/chat/completions 를 말하는 엔드포인트면 무엇이든.',
    },
    {
        // OpenCodex 게이트웨이: 원격 바인드의 /v1/chat/completions 는 x-opencodex-api-key 만 받는다.
        // 루프백 바인드는 키를 읽지 않는다.
        id: 'opencodex',
        label: 'OpenCodex (gateway)',
        models: [],
        baseUrl: 'http://127.0.0.1:10100/v1',
        keyHint: 'ocx_… key — 루프백 바인드는 필요 없음',
        auth: 'optional',
        authHeader: 'x-opencodex-api-key',
        endpointEditable: true,
        modelsSource: 'openai',
        keyEnv: 'OPENCODEX_API_KEY',
    },
    {
        id: 'ollama',
        label: 'Ollama (이 컴퓨터)',
        models: [],
        baseUrl: 'http://127.0.0.1:11434/v1',
        keyHint: '인증 프록시 뒤에 있을 때만',
        auth: 'optional',
        endpointEditable: true,
        modelsSource: 'ollama-tags',
    },
];

/** 예전 설정의 공급자 이름 → 지금 이름 */
export const LEGACY_PROVIDER_IDS: Record<string, string> = { moonshot: 'kimi', custom: 'openai-compatible' };

export function providerById(id: string | undefined): ProviderDef | undefined {
    if (!id) return undefined;
    const want = LEGACY_PROVIDER_IDS[id] ?? id;
    return PROVIDERS.find((p) => p.id === want);
}

export const transportOf = (def: ProviderDef | undefined): Transport => def?.transport ?? 'openai-compatible';

/** 인증 헤더. 키가 없으면 아무 헤더도 보내지 않는다(키 없는 로컬 런타임에 'Bearer unused' 를 보내지 않게). */
export function authHeaders(def: ProviderDef | undefined, key: string | undefined): Record<string, string> {
    if (!key) return {};
    const header = def?.authHeader ?? 'bearer';
    return header === 'bearer' ? { Authorization: `Bearer ${key}` } : { [header]: key };
}

/** 요청할 기본 주소 — 주소를 바꿀 수 있는 항목만 덮어쓰기를 받는다. 끝의 '/' 는 뗀다. */
export function resolveBaseUrl(def: ProviderDef | undefined, override?: string): string {
    const o = def?.endpointEditable ? (override ?? '').trim() : '';
    return (o || def?.baseUrl || '').replace(/\/+$/, '');
}

/** 시드가 실제로 모델에 닿는가 — OpenAI 호환 전송만 보낸다(기존 구현 seedReachesModel 와 같은 규칙). */
export const seedReachesModel = (def: ProviderDef | undefined): boolean => transportOf(def) === 'openai-compatible';

const CONTEXT: Record<string, number> = table as Record<string, number>;

/**
 * 모델 문맥 길이(입력+출력). 기존 구현 가 LiteLLM 에서 빌드 때 뽑아 둔 표.
 * 'deepseek/deepseek-v4-flash' 와 'deepseek-v4-flash' 처럼 두 이름으로 찾는다.
 */
export function lookupModelContext(model: string | undefined): number | undefined {
    if (!model) return undefined;
    const exact = CONTEXT[model];
    if (typeof exact === 'number') return exact;
    const bare = model.slice(model.lastIndexOf('/') + 1);
    const byName = bare === model ? undefined : CONTEXT[bare];
    return typeof byName === 'number' ? byName : undefined;
}

export interface ModelInfo {
    id: string;
    /** undefined 는 "보고하지 않음". 명시적 false 만 도구 호출 불가로 본다 */
    tools?: boolean;
    contextLength?: number;
    seed?: boolean;
}

export interface ModelProbe {
    models: ModelInfo[];
    /** 목록이 비었을 때 왜인지 — 401 은 닿았으나 키를 거절한 것이고, unreachable 은 닿지도 않은 것이다 */
    status: 'ok' | 'unauthorized' | 'unreachable' | 'error' | 'none';
}

function modelsUrl(def: ProviderDef, base: string): string | null {
    switch (def.modelsSource) {
        case 'openai':
        case 'openrouter':
        case 'gateway':
            return `${base}/models`;
        case 'ollama-tags':
            try {
                return new URL('/api/tags', base).toString();
            } catch {
                return null;
            }
        default:
            return null;
    }
}

/** 엔드포인트에 실제로 쓸 수 있는 모델을 묻는다(기존 구현 fetchModels 와 같은 해석). */
export async function fetchModels(def: ProviderDef, base: string, key: string | undefined, signal?: AbortSignal): Promise<ModelProbe> {
    const url = modelsUrl(def, base);
    if (!url) return { models: def.models.map((id) => ({ id })), status: 'none' };
    try {
        const timeout = AbortSignal.timeout(8000);
        const r = await fetch(url, {
            signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
            headers: { ...authHeaders(def, key), ...(def.extraHeaders ?? {}) },
        });
        if (r.status === 401 || r.status === 403) return { models: [], status: 'unauthorized' };
        if (!r.ok) return { models: [], status: 'error' };
        const body: any = await r.json();
        let models: ModelInfo[];
        if (def.modelsSource === 'ollama-tags') {
            models = (body?.models ?? [])
                .filter((m: any) => typeof m?.name === 'string')
                .map((m: any) => ({
                    id: m.name as string,
                    tools: Array.isArray(m?.capabilities) ? m.capabilities.includes('tools') : undefined,
                    contextLength: m?.details?.context_length,
                }));
        } else {
            // Together 는 배열을, xAI 는 models 를 준다 — 셋 다 받는다.
            const rows: any[] = Array.isArray(body) ? body : (body?.data ?? body?.models ?? []);
            if (def.modelsSource === 'gateway') {
                models = rows
                    .filter((m: any) => typeof m?.id === 'string')
                    .filter((m: any) => m?.type == null || m.type === 'language')
                    .map((m: any) => ({
                        id: m.id as string,
                        tools: Array.isArray(m?.tags) ? m.tags.includes('tool-use') : undefined,
                        contextLength: typeof m?.context_window === 'number' ? m.context_window : undefined,
                    }));
            } else if (def.modelsSource === 'openrouter') {
                models = rows
                    .filter((m: any) => typeof m?.id === 'string')
                    .map((m: any) => ({
                        id: m.id as string,
                        tools: Array.isArray(m?.supported_parameters) && m.supported_parameters.includes('tools'),
                        contextLength: typeof m?.context_length === 'number' ? m.context_length : undefined,
                        seed: Array.isArray(m?.supported_parameters) ? m.supported_parameters.includes('seed') : undefined,
                    }));
            } else {
                // 순수 OpenAI 모양: id 뿐. 도구 지원은 추측하지 않는다(이름 패턴으로 숨기면 되는 모델을 잃는다).
                models = rows
                    .filter((m: any) => typeof m?.id === 'string')
                    .map((m: any) => {
                        // 기존 구현 와 같이 세 이름을 다 읽는다 — DeepSeek 은 context_window, Mistral 은 max_context_length 를 준다.
                        const ctx = [m?.context_length, m?.context_window, m?.max_context_length].find((v) => typeof v === 'number');
                        return { id: m.id as string, ...(ctx ? { contextLength: ctx as number } : {}) };
                    });
            }
        }
        // 도구를 못 쓴다고 **명시**한 모델만 숨긴다 — 이 앱의 구조화 출력은 강제 도구 호출이 1순위다.
        const usable = models.filter((m) => m.tools !== false).map((m) => ({ ...m, contextLength: m.contextLength ?? lookupModelContext(m.id) }));
        return { models: usable, status: 'ok' };
    } catch (e) {
        if (signal?.aborted) throw e;
        return { models: [], status: 'unreachable' };
    }
}
