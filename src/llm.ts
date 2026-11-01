// 구조화 출력 클라이언트. SDK 없이 OpenAI 호환 /chat/completions 만 쓴다.
//
// 경로 선택은 기존 구현 의 측정을 그대로 가져왔다 (subagent.ts 의 askStructured):
// **강제 툴 호출이 1순위, json_schema 는 2순위.** OpenAI 호환 엔드포인트 상당수는
// response_format 의 스키마를 조용히 버리고 json_object 로 보내지만, 강제 tool_choice 는
// 같은 모델·같은 엔드포인트에서 스키마에 정확히 맞는 JSON 을 돌려준다. 반대로 강제 툴 호출을
// 거부하는 엔드포인트(추론 모드의 일부)도 있어서 두 경로를 다 두고, 실패한 경로는 이번 실행
// 동안 뒤로 보낸다.
//
// 세 가지가 더 있다:
//   fallbacks — 한 프로파일이 죽으면 다음 프로파일로 넘어간다 (llmpool 의 개념).
//   recorder  — 호출 하나하나를 **전선 그대로** 남긴다 (llmrec 의 개념). 논문의 재현성은
//               정규화된 요약이 아니라 원문 요청·응답에서 나온다.
//   salvage   — 스키마에 안 맞는 응답은 대개 맞는 판단을 틀린 문장부호로 쓴 것이다.
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { authHeaders, type Transport } from './providers.ts';

export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    /** 공급자 id (src/providers.ts). 기록·표시용 */
    provider?: string;
    /** 전송 방식. 생략하면 OpenAI 호환. 'anthropic' 은 Messages API(/messages)로 보낸다 */
    transport?: Transport;
    /** 키를 담을 헤더 — 'bearer'(기본) 또는 헤더 이름(x-api-key, x-opencodex-api-key) */
    authHeader?: string;
    /** 공급자가 요구하는 추가 헤더(anthropic-version 등) */
    extraHeaders?: Record<string, string>;
    /** top_p. 정하지 않으면 보내지 않는다 — 공급자 기본값을 쓴다 */
    topP?: number;
    /** 시드. OpenAI 호환 전송에만 보낸다(DeepSeek·Anthropic 은 받아도 버린다) */
    seed?: number;
    /** 이 프로파일이 실패하면 순서대로 시도할 대체 프로파일 */
    fallbacks?: LlmConfig[];
    /** 사람이 읽을 프로파일 이름 (기록·UI 용) */
    label?: string;
}

export interface Usage {
    prompt: number;
    completion: number;
    calls: number;
}

export class LlmError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly body?: string,
    ) {
        super(message);
    }
}

// ---- 호출 기록 -------------------------------------------------------------------

/**
 * 호출 하나의 기록. llmrec 이 남기는 것은 "정규화된 요청"이 아니라 **전선 위의 바이트**다.
 * 여기서도 요청 본문과 응답 본문을 그대로 남긴다 — 요약하면 그 순간 재현이 아니라 인상이 된다.
 */
export interface CallRecord {
    at: string;
    /** 파이프라인 단계: planner | claims | objections | judgments | revision | supplement | chapter | side */
    role: string;
    model: string;
    baseUrl: string;
    route: 'tool' | 'object' | 'text';
    ms: number;
    status?: number;
    error?: string;
    usage?: { prompt: number; completion: number };
    /** 프로파일 순번 — 0 은 기본, 1 이상은 대체 프로파일(fallback) */
    attempt: number;
    /** 같은 프로파일 안에서 다시 보낸 횟수(429·5xx·네트워크 오류). 첫 시도면 없다. */
    retry?: number;
    request: string;
    response: string;
}

type Recorder = (r: CallRecord) => void;
let recorder: Recorder | null = null;
/** 전역 기록기(CLI — 프로세스 하나가 실행 하나). 앱은 withRecorder 를 쓴다. */
export const setRecorder = (r: Recorder | null): void => {
    recorder = r;
};
/**
 * fn 안(과 그 안에서 이어진 비동기 호출)에서 일어난 호출만 r 로 남긴다. 앱에서는 실행과 구상 대화가 동시에 돈다 —
 * 전역 기록기 하나면 실행 중에 보낸 대화의 호출이 그 실행의 calls.jsonl 에 섞였다.
 */
const scoped = new AsyncLocalStorage<Recorder>();
export const withRecorder = <T>(r: Recorder, fn: () => Promise<T>): Promise<T> => scoped.run(r, fn);
const currentRecorder = (): Recorder | null => scoped.getStore() ?? recorder;

/** 응답 본문의 토큰 수 — OpenAI 호환(prompt_tokens·completion_tokens)과 Anthropic(input_tokens·output_tokens). 기록용. */
function usageOf(text: string): { prompt: number; completion: number } | undefined {
    try {
        const u = JSON.parse(text)?.usage;
        if (!u) return undefined;
        const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
        const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0);
        return Number.isFinite(prompt) && Number.isFinite(completion) && prompt + completion > 0 ? { prompt, completion } : undefined;
    } catch {
        return undefined;
    }
}

/** 기록 크기 상한. 전문은 파일로 떨어지므로 한 호출이 파일을 삼키지 않게만 막는다. */
const RECORD_MAX = 40_000;
const clip = (s: string) => (s.length > RECORD_MAX ? `${s.slice(0, RECORD_MAX)}\n…(${s.length - RECORD_MAX}자 생략)` : s);

/** 이번 실행에서 실패한 경로 — 두 번째 호출부터는 뒤로 보낸다. 모델·단계별로 센다. */
const demoted = new Set<string>();
const routeKey = (cfg: LlmConfig, name: string, route: string) => `${cfg.model}|${name}|${route}`;

/** 코드펜스 제거 + 잘린 JSON 복구. 실패하면 undefined. */
export function salvageJson(raw: string): unknown {
    let t = (raw ?? '').trim();
    if (!t) return undefined;
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
    if (fence) t = fence[1]!.trim();
    try {
        return JSON.parse(t);
    } catch {
        /* 계속 */
    }
    // 잘린 배열([{…}, {…}, {…  ) — 마지막 완결 객체까지로 닫는다. '{' 부터 보면 첫 원소 하나만 남는다.
    if (t.startsWith('[')) {
        for (let end = t.lastIndexOf('}'); end > 0; end = t.lastIndexOf('}', end - 1)) {
            try {
                return JSON.parse(`${t.slice(0, end + 1)}]`);
            } catch {
                /* 더 앞의 '}' 로 */
            }
        }
    }
    const start = t.indexOf('{');
    if (start < 0) return undefined;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
        const c = t[i]!;
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(t.slice(start, i + 1));
                } catch {
                    return undefined;
                }
            }
        }
    }
    let tail = t.slice(start);
    if (inStr) tail += '"';
    tail += '}'.repeat(Math.max(0, depth));
    try {
        return JSON.parse(tail);
    } catch {
        return undefined;
    }
}

// 529 = Anthropic overloaded_error — 재시도 대상이라고 문서가 말한다.
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
/** 재시도 대기. 실행이 멈추면 바로 깬다 — 다음 fetch 가 AbortError 를 던진다(429 대기 몇 초를 다 채우지 않게). 다 기다렸으면 듣기를 거둔다. */
const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((r) => {
        if (signal?.aborted) return r();
        const done = () => {
            clearTimeout(t);
            signal?.removeEventListener('abort', done);
            r();
        };
        const t = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });

/**
 * 멈춘 호출이면 던질 것(아니면 undefined). 멈춤은 실패가 아니다 — 다음 경로·프로파일로 넘기면 경로마다 즉시 실패해
 * "모든 경로·프로파일 실패"로 끝나고(앱은 그것을 오류로 읽는다) calls.jsonl 에 잡음만 남는다. 신호가 멈췄으면 무엇이 났든
 * (본문을 읽다 끊겨 생긴 '빈 응답' 포함) 신호의 이유(AbortError)를 던진다.
 */
function abortOf(e: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason ?? e;
    return (e as { name?: string } | null)?.name === 'AbortError' ? e : undefined;
}

async function post(
    cfg: LlmConfig,
    body: unknown,
    meta: { name: string; route: CallRecord['route']; attempt: number },
    signal?: AbortSignal,
): Promise<any> {
    let lastErr: unknown;
    // 전송별 요청은 한 번만 만든다 — 재시도마다 다시 바꾸면 이미 바뀐 요청을 또 바꾼다.
    const transport = cfg.transport ?? 'openai-compatible';
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const wire =
        transport === 'anthropic' ? toAnthropic(body as OpenAiBody, cfg) : transport === 'deepseek' ? toDeepSeek(withSampling(body as OpenAiBody, cfg), cfg) : withSampling(body as OpenAiBody, cfg);
    body = wire; // 기록에는 실제로 보낸 바이트를 남긴다
    for (let attempt = 0; attempt < 4; attempt++) {
        const started = Date.now();
        try {
            const res = await fetch(`${base}/${transport === 'anthropic' ? 'messages' : 'chat/completions'}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...authHeaders({ authHeader: cfg.authHeader } as never, cfg.apiKey),
                    ...(cfg.extraHeaders ?? {}),
                },
                body: JSON.stringify(wire),
                signal,
            });
            const text = await res.text().catch(() => '');
            const used = res.ok ? usageOf(text) : undefined;
            currentRecorder()?.({
                at: new Date().toISOString(),
                role: meta.name,
                model: cfg.model,
                baseUrl: cfg.baseUrl,
                route: meta.route,
                ms: Date.now() - started,
                status: res.status,
                attempt: meta.attempt,
                ...(attempt ? { retry: attempt } : {}),
                ...(used ? { usage: used } : {}),
                request: clip(JSON.stringify(body)),
                response: clip(text),
                ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
            });
            if (!res.ok) {
                const err = new LlmError(`HTTP ${res.status}`, res.status, text.slice(0, 800));
                if (RETRYABLE.has(res.status) && attempt < 3) {
                    lastErr = err;
                    await sleep(700 * (attempt + 1) * (attempt + 1), signal);
                    continue;
                }
                throw err;
            }
            const parsed = JSON.parse(text || '{}');
            return transport === 'anthropic' ? fromAnthropic(parsed) : parsed;
        } catch (e: any) {
            if (e?.name === 'AbortError') throw e;
            if (e instanceof LlmError && !RETRYABLE.has(e.status ?? 0)) throw e;
            if (!(e instanceof LlmError)) {
                // 네트워크 오류는 응답 본문이 없다. 요청과 오류 메시지만 남긴다.
                currentRecorder()?.({
                    at: new Date().toISOString(),
                    role: meta.name,
                    model: cfg.model,
                    baseUrl: cfg.baseUrl,
                    route: meta.route,
                    ms: Date.now() - started,
                    attempt: meta.attempt,
                    ...(attempt ? { retry: attempt } : {}),
                    error: e?.message ?? String(e),
                    request: clip(JSON.stringify(body)),
                    response: '',
                });
            }
            lastErr = e;
            if (attempt >= 3) break;
            await sleep(700 * (attempt + 1) * (attempt + 1), signal);
        }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

type OpenAiMessage = { role: string; content: string };
type OpenAiBody = {
    model: string;
    temperature?: number;
    max_tokens?: number;
    messages: OpenAiMessage[];
    tools?: { type: string; function: { name: string; description?: string; parameters: unknown } }[];
    tool_choice?: { type: string; function?: { name: string } };
    response_format?: { type: string; json_schema?: { name: string; schema: unknown } };
    [k: string]: unknown;
};

/** top_p·seed 를 붙인다. 시드는 OpenAI 호환 전송에만 — 다른 전송은 받아도 버린다(기존 구현 seedReachesModel). */
function withSampling(body: OpenAiBody, cfg: LlmConfig): OpenAiBody {
    const out: OpenAiBody = { ...body };
    if (typeof cfg.topP === 'number' && Number.isFinite(cfg.topP)) out.top_p = cfg.topP;
    if ((cfg.transport ?? 'openai-compatible') === 'openai-compatible' && typeof cfg.seed === 'number' && Number.isFinite(cfg.seed)) out.seed = Math.round(cfg.seed);
    return out;
}

/**
 * DeepSeek 전용 옵션 — 전송은 OpenAI 호환이지만 이것 때문에 따로 둔다(기존 구현 가 @ai-sdk/deepseek 를 쓰는 이유와 같다).
 *  · deepseek-flash·deepseek-v4-pro 는 기본이 추론(thinking) 모드이고, 추론 모드는 강제 tool_choice 를 거절한다
 *    ("Thinking mode does not support this tool_choice"). 이 앱의 구조화 출력은 강제 도구 호출이 1순위라
 *    추론을 끈다 — 예전 기본이던 deepseek-chat(= flash 비추론)과 같은 동작이다. deepseek-reasoner 는 추론 모델이라 건드리지 않는다.
 *  · json_schema response_format 은 받지 않는다("unavailable") — json_object 로 바꾸고 스키마는 system 에 적는다.
 */
function toDeepSeek(body: OpenAiBody, _cfg: LlmConfig): OpenAiBody {
    const out: OpenAiBody = { ...body };
    if (!/reasoner/.test(body.model)) out.thinking = { type: 'disabled' };
    const schema = body.response_format?.json_schema?.schema;
    if (schema) {
        out.response_format = { type: 'json_object' };
        out.messages = [
            ...body.messages,
            { role: 'system', content: `다음 JSON 스키마에 맞는 JSON 객체 하나만 출력한다(json).\n${JSON.stringify(schema)}` },
        ];
    }
    return out;
}

/**
 * OpenAI 모양 요청 → Anthropic Messages API.
 *  · system 메시지는 최상위 system 으로
 *  · 강제 도구 호출(tool_choice function)은 { type: 'tool', name } 으로, 도구 스키마는 input_schema 로
 *  · response_format(json_schema)은 Anthropic 에 없다 — 스키마를 system 에 적고 JSON 만 내게 한다(응답은 salvageJson 이 읽는다)
 *  · temperature 와 top_p 는 최신 모델에서 함께 줄 수 없다 — temperature 가 있으면 top_p 는 보내지 않는다
 */
function toAnthropic(body: OpenAiBody, cfg: LlmConfig): Record<string, unknown> {
    const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const schema = body.response_format?.json_schema?.schema;
    if (schema) sys.push(`다음 JSON 스키마에 맞는 JSON 객체 하나만 출력한다. 다른 글은 쓰지 않는다.\n${JSON.stringify(schema)}`);
    const out: Record<string, unknown> = {
        model: body.model,
        max_tokens: body.max_tokens ?? cfg.maxTokens,
        ...(sys.length ? { system: sys.join('\n\n') } : {}),
        messages: body.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    // 샘플링 파라미터를 거절하는 모델에는 보내지 않는다(기존 구현 의 @ai-sdk/anthropic getModelCapabilities 와 같은 표).
    // Anthropic 의 temperature 범위는 0~1 이다 — 설정은 0~2 까지 받으므로 자른다.
    if (!anthropicRejectsSampling(body.model)) {
        if (typeof body.temperature === 'number') out.temperature = Math.min(1, Math.max(0, body.temperature));
        else if (typeof cfg.topP === 'number') out.top_p = cfg.topP;
    }
    if (body.tools?.length) {
        out.tools = body.tools.map((t) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), input_schema: t.function.parameters }));
        const forced = body.tool_choice?.function?.name;
        if (forced) {
            // 강제 도구 호출을 400 으로 거절하는 모델은 auto 로 두고, 그 도구로 답하라고 system 에 적는다.
            // argsOf 가 tool_use 가 있으면 그것을, 없으면 본문 JSON 을 읽는다.
            if (anthropicRejectsForcedTool(body.model)) {
                out.tool_choice = { type: 'auto' };
                out.system = [out.system, `반드시 ${forced} 도구를 호출해 답한다.`].filter(Boolean).join('\n\n');
            } else out.tool_choice = { type: 'tool', name: forced };
        }
    }
    return out;
}

/** 샘플링 파라미터(temperature·top_p)를 400 으로 거절하는 Claude 모델 — @ai-sdk/anthropic 4.x getModelCapabilities 의 분기 그대로. */
export function anthropicRejectsSampling(id: string): boolean {
    if (id.includes('claude-opus-5')) return true;
    if (['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-5'].some((x) => id.includes(x))) return true;
    if (['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'].some((x) => id.includes(x))) return false;
    if (/claude-sonnet-4(?:-|@)/.test(id) || /claude-opus-4(?:-|@)/.test(id) || id.includes('claude-3-haiku')) return false;
    if (/claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/.test(id)) return false;
    // 표에 없는 claude- 모델(더 새것)은 거절한다고 본다 — SDK 와 같은 판단
    return id.includes('claude-');
}

/** 강제 tool_choice(tool/any)를 400 으로 거절하는 모델 */
export const anthropicRejectsForcedTool = (id: string): boolean => /claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/.test(id);

/** Anthropic 응답 → OpenAI 모양(argsOf 가 그대로 읽게). */
function fromAnthropic(json: any): any {
    const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
    const tool = blocks.find((b) => b?.type === 'tool_use');
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
    return {
        choices: [
            {
                message: {
                    role: 'assistant',
                    content: text,
                    ...(tool ? { tool_calls: [{ type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) } }] } : {}),
                },
                finish_reason: json?.stop_reason,
            },
        ],
        ...(json?.usage ? { usage: { prompt_tokens: json.usage.input_tokens ?? 0, completion_tokens: json.usage.output_tokens ?? 0 } } : {}),
    };
}

function argsOf(json: any): { text?: string; usage?: any } {
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    const call = msg?.tool_calls?.[0];
    if (call?.function?.arguments) return { text: call.function.arguments, usage: json?.usage };
    if (typeof msg?.content === 'string') return { text: msg.content, usage: json?.usage };
    if (Array.isArray(msg?.content)) return { text: msg.content.map((p: any) => p?.text ?? '').join(''), usage: json?.usage };
    return { usage: json?.usage };
}

export interface StructuredRequest<T> {
    schema: z.ZodType<T>;
    name: string;
    description: string;
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
}

/**
 * 스키마에 맞는 JSON 하나를 받아온다.
 *
 * 프로파일 체인을 순서대로 시도한다 — llmpool 의 failover 와 같은 발상이다. 회로차단기는 두지
 * 않았다: 실행이 수십 호출로 짧고, 쿨다운이 의미를 가지려면 실행 사이에 상태가 남아야 하는데
 * 그건 앱 설정 계층의 일이다.
 */
export async function structured<T>(
    cfg: LlmConfig,
    req: StructuredRequest<T>,
    signal?: AbortSignal,
    usage?: Usage,
): Promise<T> {
    signal?.throwIfAborted();
    const jsonSchema = z.toJSONSchema(req.schema, { io: 'output' }) as Record<string, unknown>;
    delete jsonSchema.$schema;

    const baseBody = {
        temperature: req.temperature ?? cfg.temperature,
        max_tokens: req.maxTokens ?? cfg.maxTokens,
        messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
        ],
    };

    const routes: ('tool' | 'object')[] = ['tool', 'object'];
    const chain = [cfg, ...(cfg.fallbacks ?? [])];
    const errors: string[] = [];

    for (let ci = 0; ci < chain.length; ci++) {
        const c = chain[ci]!;
        const body = { ...baseBody, model: c.model };
        const ordered = [
            ...routes.filter((r) => !demoted.has(routeKey(c, req.name, r))),
            ...routes.filter((r) => demoted.has(routeKey(c, req.name, r))),
        ];
        for (const route of ordered) {
            const payload =
                route === 'tool'
                    ? {
                          ...body,
                          tools: [
                              { type: 'function', function: { name: req.name, description: req.description, parameters: jsonSchema } },
                          ],
                          tool_choice: { type: 'function', function: { name: req.name } },
                      }
                    : {
                          ...body,
                          response_format: { type: 'json_schema', json_schema: { name: req.name, strict: true, schema: jsonSchema } },
                      };
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const json = await post(c, payload, { name: req.name, route, attempt: ci }, signal);
                    const { text, usage: u } = argsOf(json);
                    if (!text) throw new LlmError('빈 응답', 200);
                    if (usage && u) {
                        usage.prompt += u.prompt_tokens ?? 0;
                        usage.completion += u.completion_tokens ?? 0;
                        usage.calls += 1;
                    }
                    const data = salvageJson(text);
                    let parsed = req.schema.safeParse(data);
                    // 모델이 { objections: [...] } 대신 [...] 를 내는 일이 있다. 스키마가 배열 하나짜리 객체면 감싸서 다시 본다.
                    if (!parsed.success && Array.isArray(data)) {
                        const keys = Object.keys((req.schema as { shape?: Record<string, unknown> }).shape ?? {});
                        if (keys.length === 1) parsed = req.schema.safeParse({ [keys[0]!]: data });
                    }
                    if (parsed.success) return parsed.data;
                    // 경로만 적으면 뿌리 불일치("(root)")가 빈 문자열로 남아 무엇이 틀렸는지 알 수 없다.
                    const detail = parsed.error.issues
                        .slice(0, 3)
                        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                        .join(', ');
                    throw new LlmError(`스키마 불일치: ${detail}`, 200, text.slice(0, 800));
                } catch (e) {
                    const stop = abortOf(e, signal);
                    if (stop !== undefined) throw stop;
                    const msg = e instanceof Error ? e.message : String(e);
                    if (e instanceof LlmError && e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
                        demoted.add(routeKey(c, req.name, route));
                        errors.push(`${c.model}/${route}: HTTP ${e.status}`);
                        attempt = 2;
                        continue;
                    }
                    if (attempt === 0) {
                        errors.push(`${c.model}/${route}: ${msg} (재시도)`);
                        continue;
                    }
                    errors.push(`${c.model}/${route}: ${msg}`);
                }
            }
        }
    }
    throw new LlmError(`모든 경로·프로파일 실패 — ${errors.join(' | ')}`);
}

/**
 * 구조화 없는 plain completion. **긴 산문에는 이걸 쓴다.**
 *
 * 논문 한 장은 수천 자의 한국어 산문이고, 인용부호·줄바꿈·각주가 섞인다. 그걸 JSON 문자열
 * 하나에 밀어 넣으라고 요구하면 이스케이프가 깨져 스키마 검증에서 떨어진다.
 */
export async function complete(
    cfg: LlmConfig,
    req: { system: string; user: string; maxTokens?: number; temperature?: number; name?: string },
    usage?: Usage,
    signal?: AbortSignal,
): Promise<string> {
    const chain = [cfg, ...(cfg.fallbacks ?? [])];
    let lastErr: unknown;
    for (let ci = 0; ci < chain.length; ci++) {
        const c = chain[ci]!;
        try {
            const json: any = await post(
                c,
                {
                    model: c.model,
                    temperature: req.temperature ?? c.temperature,
                    max_tokens: req.maxTokens ?? c.maxTokens,
                    messages: [
                        { role: 'system', content: req.system },
                        { role: 'user', content: req.user },
                    ],
                },
                { name: req.name ?? 'text', route: 'text', attempt: ci },
                signal,
            );
            if (usage && json?.usage) {
                usage.prompt += json.usage.prompt_tokens ?? 0;
                usage.completion += json.usage.completion_tokens ?? 0;
                usage.calls += 1;
            }
            const { text } = argsOf(json);
            if (!text || !text.trim()) throw new LlmError('빈 응답', 200);
            return text.trim();
        } catch (e) {
            // 멈춘 실행의 장 쓰기는 대체 프로파일로 넘기지 않는다(structured 와 같다).
            const stop = abortOf(e, signal);
            if (stop !== undefined) throw stop;
            lastErr = e;
        }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}
