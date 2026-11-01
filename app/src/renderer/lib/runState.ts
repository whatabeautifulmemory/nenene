// 집필 실행 한 번의 상태. MainEvent 를 그대로 접어 넣는 리듀서라서, 이벤트의 모양이 바뀌면
// 여기서 컴파일이 깨진다 — 그게 의도다.
import type { Ask, CiteStatus, Ledger, LedgerItem, MainEvent, PaperPlan, PaperSection, RunSummary, StageId, ToolEvent } from '../../shared/ipc.ts';
import { emptySteps, type StepStatus } from '../components/Stepper.tsx';

export type FeedItem = { t: 'log'; text: string } | { t: 'tool'; ev: ToolEvent };

export interface RunState {
    running: boolean;
    steps: Record<StageId, StepStatus>;
    stepDetail: Partial<Record<StageId, string>>;
    outline: PaperPlan | null;
    sections: PaperSection[];
    cites: CiteStatus[];
    reviews: Record<string, LedgerItem[]>;
    feed: FeedItem[];
    asks: Ask[] | null;
    summary: RunSummary | null;
    error: string | null;
    /** 이 상태가 지난 실행의 원장에서 복원된 것인가 (라이브 이벤트가 아니라) */
    restored: boolean;
}

export type RunAction =
    | { type: 'started' }
    | { type: 'failed'; message: string }
    | { type: 'cancelled' }
    | { type: 'answered' }
    | { type: 'dismissError' }
    | { type: 'seed'; ledger: Ledger }
    /** 프로젝트를 나갔다 온 화면 — main 이 들고 있던 이 실행의 이벤트를 처음부터 다시 접는다 */
    | { type: 'resume'; events: MainEvent[]; running: boolean; asks: Ask[] | null }
    | { type: 'event'; e: MainEvent };

export const initialRun = (): RunState => ({
    running: false,
    steps: emptySteps(),
    stepDetail: {},
    outline: null,
    sections: [],
    cites: [],
    reviews: {},
    feed: [],
    asks: null,
    summary: null,
    error: null,
    restored: false,
});

const FEED_CAP = 3000;

function pushFeed(feed: FeedItem[], item: FeedItem): FeedItem[] {
    const next = feed.length >= FEED_CAP ? feed.slice(feed.length - FEED_CAP + 1) : feed.slice();
    next.push(item);
    return next;
}

/**
 * 원장의 인용표. 본문에서 뺀 인용도 넣는다 — 새 원장은 plan.cites 에 「본문에서 뺌」 표지로 들어 있고, 그 표지가 생기기 전 원장
 * (plan.withheld 에만 있던 것)은 여기서 합친다. 빼면 지난 실행을 열었을 때 ✗ 인용이 인용표에서 사라진다.
 */
export function citesOf(paper: PaperPlan | null | undefined): CiteStatus[] {
    const cites = paper?.cites ?? [];
    const withheld = paper?.withheld ?? [];
    const have = new Set(cites.map((c) => c.key));
    return [...cites, ...withheld.filter((c) => !have.has(c.key)).map((c) => ({ ...c, withheld: true as const }))];
}

function upsertSection(list: PaperSection[], s: PaperSection): PaperSection[] {
    const i = list.findIndex((x) => x.id === s.id);
    if (i < 0) return [...list, s];
    const prev = list[i];
    // 초고 이벤트가 수정본 뒤에 다시 오는 일은 없지만, 와도 수정본을 지우지 않는다.
    const merged: PaperSection = { ...prev, ...s, draft: s.draft ?? prev?.draft, revised: s.revised ?? prev?.revised };
    return list.map((x, j) => (j === i ? merged : x));
}

export function runReducer(state: RunState, a: RunAction): RunState {
    switch (a.type) {
        case 'started':
            return { ...initialRun(), running: true };
        case 'failed':
            return { ...state, running: false, error: a.message };
        case 'cancelled':
            return { ...state, running: false, asks: null };
        case 'answered':
            return { ...state, asks: null };
        case 'dismissError':
            return { ...state, error: null };
        case 'seed': {
            const l = a.ledger;
            const paper = l.paper ?? null;
            const reviews: Record<string, LedgerItem[]> = {};
            for (const iss of l.issues) reviews[iss.issue.id] = iss.items;
            const steps = emptySteps();
            if (paper) {
                for (const k of Object.keys(steps) as StageId[]) steps[k] = 'done';
                steps.hitl = l.human && l.human.length > 0 ? 'done' : 'skipped';
                // 연쇄 탐색이 아무것도 고르지 않았거나(또는 그 단계가 없던 옛 원장) 건너뜀으로 보인다.
                const snow = (paper as { snowball?: { picked: number }[] }).snowball;
                if (!snow || !snow.some((h) => h.picked > 0)) steps.snowball = 'skipped';
                // 재검증·인용 대조가 없던 원장(옛 실행·--no-quality)은 건너뜀으로 보인다.
                const q = (paper as { quality?: { reverify?: unknown[] }; citeCheck?: unknown[] });
                if (!q.quality?.reverify?.length) steps.reverify = 'skipped';
                if (!q.citeCheck?.length) steps.citecheck = 'skipped';
            }
            return {
                ...initialRun(),
                steps,
                outline: paper,
                sections: paper?.sections ?? [],
                cites: citesOf(paper),
                reviews,
                restored: true,
            };
        }
        case 'resume': {
            let s: RunState = { ...initialRun(), running: true };
            for (const e of a.events) s = runReducer(s, { type: 'event', e });
            // 질문은 지금 기다리는 것만 — 이미 답한 질문의 'asks' 이벤트도 기록에 있다. 멈추는 중이면 돌고 있지 않다.
            return { ...s, running: s.running && a.running, asks: a.asks };
        }
        case 'event': {
            const e = a.e;
            switch (e.type) {
                case 'progress':
                    return { ...state, feed: pushFeed(state.feed, { t: 'log', text: e.line }) };
                case 'tool':
                    return { ...state, feed: pushFeed(state.feed, { t: 'tool', ev: e.event }) };
                case 'asks':
                    return { ...state, asks: e.asks };
                case 'stage': {
                    const map: Record<typeof e.status, StepStatus> = { start: 'active', done: 'done', skip: 'skipped', error: 'error' };
                    return {
                        ...state,
                        steps: { ...state.steps, [e.stage]: map[e.status] },
                        stepDetail: { ...state.stepDetail, [e.stage]: e.detail ?? state.stepDetail[e.stage] },
                    };
                }
                case 'plan': {
                    // 목차가 오면 순서는 목차를 따르고, 이미 받은 본문은 지키지 않는다 — 새 목차는 새 초고다.
                    const sections = e.plan.sections.map((s) => {
                        const prev = state.sections.find((x) => x.id === s.id);
                        return prev ? { ...s, draft: s.draft ?? prev.draft, revised: s.revised ?? prev.revised } : s;
                    });
                    return { ...state, outline: e.plan, sections, cites: e.plan.cites ?? state.cites };
                }
                case 'section':
                    return { ...state, sections: upsertSection(state.sections, e.section) };
                case 'cites':
                    return { ...state, cites: e.cites };
                case 'review': {
                    const cur = state.reviews[e.sectionId] ?? [];
                    const next = cur.filter((it) => it.claim.id !== e.item.claim.id);
                    next.push(e.item);
                    return { ...state, reviews: { ...state.reviews, [e.sectionId]: next } };
                }
                case 'reviews':
                    return { ...state, reviews: { ...state.reviews, [e.sectionId]: e.items } };
                case 'done': {
                    const steps = { ...state.steps };
                    for (const k of Object.keys(steps) as StageId[]) if (steps[k] === 'active') steps[k] = 'done';
                    return { ...state, running: false, asks: null, summary: e.summary, steps };
                }
                case 'error':
                    return { ...state, running: false, error: e.message };
                default:
                    return state;
            }
        }
        default:
            return state;
    }
}

export const RUN_STATUS_KO = { idle: '대기', running: '실행 중', done: '완료', error: '오류', restored: '지난 실행' } as const;

export function runStatus(s: RunState): keyof typeof RUN_STATUS_KO {
    if (s.running) return 'running';
    if (s.error) return 'error';
    if (s.summary) return 'done';
    if (s.restored) return 'restored';
    return 'idle';
}
