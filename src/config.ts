// 모델 설정은 환경변수에서만 온다. 기존 구현 와 완전히 독립된 프로젝트이므로 앱 설정을 읽지 않는다.
//
// 우선순위: LEGAL_AGENT_* 가 있으면 그것, 없으면 잘 알려진 공급자 키로 추론.
// 공급자별 기본 모델은 "일단 돌아가는" 값이고, 실제 실험에서는 LEGAL_AGENT_MODEL 로 고정한다.
import { loadEnv } from './env.ts';
import type { LlmConfig } from './llm.ts';
import { PROVIDERS, providerById } from './providers.ts';

/** 공급자 프리셋은 src/providers.ts 의 표(기존 구현 에서 옮긴 것)에서 온다. */
const PRESETS = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

/** 공급자 표의 전송·인증 방식을 프로파일에 싣는다. */
function providerFields(id: string | undefined): Pick<LlmConfig, 'provider' | 'transport' | 'authHeader' | 'extraHeaders'> {
    const def = providerById(id);
    if (!def) return {};
    return {
        provider: def.id,
        ...(def.transport ? { transport: def.transport } : {}),
        ...(def.authHeader && def.authHeader !== 'bearer' ? { authHeader: def.authHeader } : {}),
        ...(def.extraHeaders ? { extraHeaders: def.extraHeaders } : {}),
    };
}

/** LEGAL_AGENT_TOP_P · LEGAL_AGENT_SEED — 정하지 않으면 보내지 않는다(공급자 기본). */
function samplingFields(env: NodeJS.ProcessEnv): Pick<LlmConfig, 'topP' | 'seed'> {
    const tp = Number(env.LEGAL_AGENT_TOP_P);
    const sd = Number(env.LEGAL_AGENT_SEED);
    return {
        ...(env.LEGAL_AGENT_TOP_P?.trim() && Number.isFinite(tp) ? { topP: Math.min(1, Math.max(0, tp)) } : {}),
        ...(env.LEGAL_AGENT_SEED?.trim() && Number.isFinite(sd) ? { seed: Math.round(sd) } : {}),
    };
}

export class MissingConfig extends Error {}

/**
 * 역할(파이프라인 단계)별 모델.
 *
 * 왜 필요한가: 찬성측과 반대측이 **같은 모델**이면 절차적으로만 독립이고 통계적으로는 아니다 —
 * 같은 코퍼스, 같은 편향, 같은 실패 양식. 역할마다 다른 모델을 배정할 수 있으면 그 결함을
 * 아키텍처로 줄일 수 있다. 비어 있으면 기본 프로파일을 쓴다.
 *
 * 환경변수: LEGAL_AGENT_MODEL_JUDGE, LEGAL_AGENT_BASE_URL_JUDGE, LEGAL_AGENT_API_KEY_JUDGE …
 */
export const ROLE_SUFFIX: Record<string, string> = {
    issues: 'DECOMP',
    intents: 'PLANNER',
    claims: 'WORKER',
    objections: 'CON',
    judgments: 'JUDGE',
    revision: 'REVISE',
    supplement: 'SUPPLEMENT',
    chapter: 'CHAPTER',
    side: 'SIDE',
    // 초고→검증→수정 파이프라인의 호출 이름. 설정의 역할(설계/추출/집필)이 실제로 닿게 한다.
    thesis: 'PLANNER',
    outline: 'PLANNER',
    claims_extract: 'WORKER',
    case_rerank: 'WORKER',
    abstract: 'CHAPTER',
    search_queries: 'DECOMP',
    kci_terms: 'DECOMP',
    ref_pick: 'PLANNER',
    gap_needs: 'PLANNER',
    cite_check: 'JUDGE',
};

export interface ModelSet {
    base: LlmConfig;
    roles: Record<string, LlmConfig>;
    /** 역할·대체 프로파일을 만들지 못한 이유(키 없음 등). 비어 있지 않으면 앱은 실행 전에 알린다 */
    warnings: string[];
}

/**
 * 다른 공급자를 쓰는 프로파일(역할·대체)의 주소·키·모델. **기본 공급자의 키를 다른 공급자로 보내지 않는다.**
 * 같은 공급자면 기본값을 물려받고, 다른 공급자면 그 공급자의 표 주소·키 환경변수·기본 모델을 쓴다.
 * 빈 문자열 키(앱이 "이 역할 공급자의 키 없음"으로 넣는 값)는 키 없음이다.
 */
function profileFor(
    providerId: string | undefined,
    given: { model?: string; baseUrl?: string; apiKey?: string },
    base: LlmConfig,
    env: NodeJS.ProcessEnv,
): { cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey' | 'model'>; missingKey: boolean; missingModel: boolean } {
    const def = providerById(providerId);
    const same = !providerId || !def || def.id === base.provider;
    if (same) {
        return {
            cfg: { model: given.model || base.model, baseUrl: given.baseUrl || base.baseUrl, apiKey: given.apiKey || base.apiKey },
            missingKey: false,
            missingModel: false,
        };
    }
    const apiKey = given.apiKey || (def.keyEnv ? env[def.keyEnv]?.trim() : '') || '';
    const model = given.model || def.models[0] || '';
    return {
        cfg: { model, baseUrl: given.baseUrl || def.baseUrl, apiKey },
        missingKey: !apiKey && def.auth === 'required',
        missingModel: !model,
    };
}

function withOverrides(base: LlmConfig, env: NodeJS.ProcessEnv, suffix: string, warnings: string[]): LlmConfig | null {
    const model = env[`LEGAL_AGENT_MODEL_${suffix}`]?.trim();
    const baseUrl = env[`LEGAL_AGENT_BASE_URL_${suffix}`]?.trim();
    const apiKey = env[`LEGAL_AGENT_API_KEY_${suffix}`]?.trim();
    const provider = env[`LEGAL_AGENT_PROVIDER_${suffix}`]?.trim().toLowerCase();
    if (!model && !baseUrl && !apiKey && !provider) return null;
    const p = profileFor(provider, { model, baseUrl, apiKey }, base, env);
    const label = providerById(provider)?.label ?? provider;
    if (p.missingKey) {
        warnings.push(`역할 ${suffix}: ${label} 키가 없어 이 역할을 기본 모델로 돌립니다 — 기본 공급자의 키를 ${label} 로 보내지 않습니다.`);
        return null;
    }
    if (p.missingModel) {
        warnings.push(`역할 ${suffix}: ${label} 에 기본 모델이 없어 모델을 정해야 합니다 — 이 역할을 기본 모델로 돌립니다.`);
        return null;
    }
    const out: LlmConfig = { ...base, ...p.cfg, label: suffix.toLowerCase() };
    // 역할이 다른 공급자를 쓰면 그 공급자의 전송·인증 방식을 따라야 한다(Anthropic 판정자 + DeepSeek 집필자 등).
    if (provider) {
        delete out.provider;
        delete out.transport;
        delete out.authHeader;
        delete out.extraHeaders;
        Object.assign(out, providerFields(provider));
    }
    return out;
}

export function resolveModels(env: NodeJS.ProcessEnv = process.env): ModelSet {
    const base = resolveConfig(env);
    const warnings: string[] = [];
    // 대체 프로파일: LEGAL_AGENT_FALLBACK_* 가 있으면 기본 체인에 붙는다.
    const fbModel = env.LEGAL_AGENT_FALLBACK_MODEL?.trim();
    const fbBase = env.LEGAL_AGENT_FALLBACK_BASE_URL?.trim();
    const fbKey = env.LEGAL_AGENT_FALLBACK_API_KEY?.trim();
    const fbProvider = env.LEGAL_AGENT_FALLBACK_PROVIDER?.trim().toLowerCase();
    if (fbModel || fbProvider) {
        const p = profileFor(fbProvider, { model: fbModel, baseUrl: fbBase, apiKey: fbKey }, base, env);
        if (p.missingKey || p.missingModel) {
            warnings.push(`대체 프로파일: ${providerById(fbProvider)?.label ?? fbProvider} ${p.missingKey ? '키가' : '모델이'} 없어 쓰지 않습니다.`);
        } else {
            const fallback: LlmConfig = {
                ...(fbProvider
                    ? providerFields(fbProvider)
                    : {
                          ...(base.provider ? { provider: base.provider } : {}),
                          ...(base.transport ? { transport: base.transport } : {}),
                          ...(base.authHeader ? { authHeader: base.authHeader } : {}),
                          ...(base.extraHeaders ? { extraHeaders: base.extraHeaders } : {}),
                      }),
                ...p.cfg,
                temperature: base.temperature,
                maxTokens: base.maxTokens,
                ...samplingFields(env),
                label: 'fallback',
            };
            base.fallbacks = [fallback];
        }
    }
    const roles: Record<string, LlmConfig> = {};
    const warnedSuffix = new Set<string>();
    for (const [name, suffix] of Object.entries(ROLE_SUFFIX)) {
        const w: string[] = [];
        const r = withOverrides(base, env, suffix, w);
        // 같은 접미를 쓰는 호출 이름이 여럿이다 — 경고는 접미당 한 번.
        if (!warnedSuffix.has(suffix)) {
            warnings.push(...w);
            warnedSuffix.add(suffix);
        }
        if (r) roles[name] = { ...r, ...(base.fallbacks ? { fallbacks: base.fallbacks } : {}) };
    }
    return { base, roles, warnings };
}

/** 역할 이름 → 그 역할의 프로파일. 없으면 기본. */
export const modelFor = (set: ModelSet) => (name: string): LlmConfig => set.roles[name] ?? set.base;

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
    loadEnv();

    const explicitBase = env.LEGAL_AGENT_BASE_URL?.trim();
    const explicitKey = env.LEGAL_AGENT_API_KEY?.trim();
    const explicitModel = env.LEGAL_AGENT_MODEL?.trim();
    const providerName = env.LEGAL_AGENT_PROVIDER?.trim().toLowerCase();

    let baseUrl = explicitBase ?? '';
    let apiKey = explicitKey ?? '';
    let model = explicitModel ?? '';
    let presetName = providerName ?? '';
    if (!presetName) {
        // 키가 있는 첫 공급자(표 순서). DeepSeek 이 맨 앞이다.
        presetName = PROVIDERS.find((p) => p.keyEnv && env[p.keyEnv]?.trim())?.id ?? '';
    }
    // PROVIDER 없이 주소를 직접 줬으면, 키로 추론한 공급자의 전송·헤더를 그 주소에 씌우지 않는다 —
    // 주소의 호스트가 표의 어느 공급자와 같으면 그 공급자로 본다(api.moonshot.ai → kimi).
    if (!providerName && explicitBase) {
        const origin = (u: string) => {
            try {
                return new URL(u).origin;
            } catch {
                return '';
            }
        };
        presetName = PROVIDERS.find((p) => origin(p.baseUrl) && origin(p.baseUrl) === origin(explicitBase))?.id ?? '';
    }
    const preset = providerById(presetName);
    if (preset) {
        baseUrl ||= preset.baseUrl;
        apiKey ||= (preset.keyEnv ? env[preset.keyEnv]?.trim() : '') ?? '';
        model ||= preset.models[0] ?? '';
    }
    // 키가 필요 없는 공급자(로컬 Ollama·루프백 게이트웨이)는 키 없이도 된다.
    const keyOk = Boolean(apiKey) || (preset ? preset.auth !== 'required' : false);
    if (!baseUrl || !keyOk || !model) {
        const known = Object.keys(PRESETS).join(', ');
        throw new MissingConfig(
            [
                '모델 설정이 없습니다.',
                '',
                '방법 1 — .env 파일 (권장)',
                '  cp .env.example .env   후 값을 채우세요',
                '',
                '방법 2 — 환경변수',
                '  export LEGAL_AGENT_BASE_URL=https://api.deepseek.com/v1',
                '  export LEGAL_AGENT_API_KEY=sk-...',
                '  export LEGAL_AGENT_MODEL=deepseek-chat',
                '',
                `지원 공급자 프리셋 (LEGAL_AGENT_PROVIDER): ${known}`,
                '',
                `지금 상태: provider=${preset?.id ?? '없음'}, baseUrl=${baseUrl ? '설정됨' : '없음'}, apiKey=${apiKey ? '설정됨' : keyOk ? '불필요' : '없음'}, model=${model || '없음'}${preset && !preset.models.length && !model ? ' (이 공급자는 기본 모델이 없습니다 — LEGAL_AGENT_MODEL 로 지정)' : ''}`,
                '',
                '키 없이 파이프라인만 확인하려면: npm run run:mock',
            ].join('\n'),
        );
    }

    return {
        ...providerFields(preset?.id),
        baseUrl,
        apiKey,
        model,
        temperature: Number(env.LEGAL_AGENT_TEMPERATURE ?? '0.3'),
        maxTokens: Number(env.LEGAL_AGENT_MAX_TOKENS ?? '8192'),
        ...samplingFields(env),
    };
}
