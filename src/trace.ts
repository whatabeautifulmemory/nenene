// 도구 이벤트. 모델 호출이 아니라 **코드가 한 일**을 남긴다.
//
// 왜 필요한가: 이 파이프라인에서 모델은 툴을 호출하지 않는다. 원문 확보·검증·추출은 전부
// 코드가 한다. 그래서 기존 구현 처럼 tool_calls 를 그릴 수 없고, 그 결과 "무엇을 가져왔는지"가
// 진행 로그 한 줄로만 남았다. 정작 감사·성능 측정에 필요한 것은 그쪽이다 — 어느 백엔드가
// 실패했고, 어떤 인용이 어디서 확보됐고, 얼마나 걸렸는지.
//
// 모델에게 선택권을 주지 않으면서 관측성만 얻는 방법이 이것이다.
import { AsyncLocalStorage } from 'node:async_hooks';

export type ToolKind = 'acquire' | 'verify' | 'coverage' | 'resolve' | 'extract';

export interface ToolEvent {
    at: string;
    kind: ToolKind;
    /** legalize · arxiv · openalex · crossref · unpaywall · s2 · direct · human · corpus … */
    name: string;
    /** 인용 문자열 또는 조문 */
    subject: string;
    ok: boolean;
    ms: number;
    /** 짧은 결과 설명 (상태·건수·실패 이유) */
    detail?: string;
    /** 입력 (경로·질의) */
    input?: string;
    /** 출력 미리보기 (원문 앞부분) */
    output?: string;
}

type Sink = (e: ToolEvent) => void;
let sink: Sink | null = null;
/**
 * 앱에서는 실행과 구상 대화가 한 프로세스에서 동시에 돈다. 전역 sink 하나면 실행 중에 보낸 대화의 조사 이벤트가 그 실행의
 * 기록(transcript.jsonl·활동 피드)에 섞였다 — 실행·대화마다 withToolScope 로 감싸면 setToolSink 는 그 범위의 sink 만 바꾼다.
 * CLI(범위 없음)는 예전처럼 전역 sink 를 쓴다.
 */
const scoped = new AsyncLocalStorage<{ sink: Sink | null }>();
export const withToolScope = <T>(fn: () => Promise<T>): Promise<T> => scoped.run({ sink: null }, fn);

export function setToolSink(fn: Sink | null): void {
    const s = scoped.getStore();
    if (s) s.sink = fn;
    else sink = fn;
}
const current = (): Sink | null => {
    const s = scoped.getStore();
    return s ? s.sink : sink;
};

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 도구 호출 하나를 감싸 시간을 재고 결과를 남긴다. 실패해도 이벤트는 남는다. */
export async function traced<T>(
    base: { kind: ToolKind; name: string; subject: string; input?: string },
    fn: () => Promise<T> | T,
    describe: (value: T) => { ok: boolean; detail?: string; output?: string },
): Promise<T> {
    const started = Date.now();
    try {
        const value = await fn();
        const d = describe(value);
        current()?.({
            at: new Date().toISOString(),
            ...base,
            ok: d.ok,
            ms: Date.now() - started,
            ...(d.detail ? { detail: d.detail } : {}),
            ...(d.output ? { output: clip(d.output) } : {}),
        });
        return value;
    } catch (e) {
        current()?.({
            at: new Date().toISOString(),
            ...base,
            ok: false,
            ms: Date.now() - started,
            detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
        throw e;
    }
}

/** 실패를 돌려주는 함수(예외를 던지지 않는 것)를 위한 얇은 래퍼. */
export function record(base: {
    kind: ToolKind;
    name: string;
    subject: string;
    ok: boolean;
    ms?: number;
    detail?: string;
    input?: string;
    output?: string;
}): void {
    current()?.({ at: new Date().toISOString(), ms: 0, ...base });
}
