// 질문 패널의 답 초안 — 패널 밖, 이 모듈에 둔다.
//
// 전에는 패널의 useState 였다. 질문이 떠 있는 동안 구상 탭을 보러 가거나 프로젝트를 나갔다 오면 패널이 내려가며 적어 둔
// 「직접 답함」과 원문 찾기 창에서 붙인 파일이 사라졌고, 돌아와 「답하고 계속」을 누르면 전부 「없음」으로 갔다(파이프라인은
// 그것을 "필자가 원문 없다고 함"으로 기억한다). 원문 찾기 창의 알림(legal:source-added)도 여기서 한 번만 듣는다 —
// 패널이 내려가 있는 동안 받은 파일도 그 질문에 붙는다.
import { useSyncExternalStore } from 'react';
import type { Answer, SourceAdded } from '../../shared/ipc.ts';

export interface Draft {
    action: Answer['action'] | null;
    note: string;
    /** 원문 찾기 브라우저에서 붙인 파일(보여 주기용 — 실제 값은 note 의 file:// 주소이고, 지우면 칩도 사라진다) */
    added?: { name: string; ref: string }[];
}

const EMPTY: Draft = { action: null, note: '' };
let drafts: Record<string, Draft> = {};
const subs = new Set<() => void>();

function commit(next: Record<string, Draft>): void {
    drafts = next;
    for (const f of subs) f();
}

export const draftOf = (all: Record<string, Draft>, id: string): Draft => all[id] ?? EMPTY;

/** 그 질문의 초안을 **지금 값**에서 고친다 — 누를 때 잡아 둔 값이 아니라(파일 선택 창이 떠 있는 동안 브라우저에서 붙은 것을 덮지 않게). */
export function updateDraft(id: string, f: (d: Draft) => Draft): void {
    commit({ ...drafts, [id]: f(drafts[id] ?? EMPTY) });
}

/** 답을 보냈거나, 멈췄거나, 새 실행을 시작했다 — 질문 id 는 인용에서 만들어 실행마다 같으므로 지난 초안을 남기지 않는다. */
export function clearDrafts(answeredIds: string[] = []): void {
    const now = Date.now();
    for (const id of [...Object.keys(drafts), ...answeredIds]) closedAt.set(id, now);
    if (Object.keys(drafts).length) commit({});
}

/** 방금 답했거나 비운 질문 — 답을 보내는 사이 끝난 내려받기가 다음 질문 묶음(같은 id)의 초안으로 남지 않게 잠시 받지 않는다 */
const closedAt = new Map<string, number>();
const CLOSED_MS = 5_000;

/** note 에 주소를 덧붙인다. 이미 있으면 그대로. */
export const withRef = (note: string, ref: string): string => (note.split(/\s+/).includes(ref) ? note : [note.trim(), ref].filter(Boolean).join(' '));

export function useDrafts(): Record<string, Draft> {
    return useSyncExternalStore(
        (f) => {
            subs.add(f);
            return () => subs.delete(f);
        },
        () => drafts,
    );
}

// 원문 찾기 브라우저에서 받은 파일·넣은 페이지 → 그 질문을 「제공」으로 바꾸고 주소를 붙인다(이미 적은 것은 둔다).
// 창은 지금 질문에 대해서만 보낸다(source-browser.ts) — 화면에 무엇이 떠 있든 받아 둔다.
function onSource(x: SourceAdded): void {
    if (Date.now() - (closedAt.get(x.askId) ?? 0) < CLOSED_MS) return;
    updateDraft(x.askId, (cur) => ({
        // 「직접 답함」에 글을 써 둔 질문이면 그대로 둔다 — 글과 파일을 함께 읽는다(파이프라인이 글 안의 file:// 도 읽는다).
        action: cur.action === 'answered' && cur.note.trim() ? 'answered' : 'provided',
        note: withRef(cur.note, x.ref),
        added: [...(cur.added ?? []).filter((y) => y.ref !== x.ref), { name: x.name, ref: x.ref }],
    }));
}
if (typeof window !== 'undefined' && window.legal?.onSourceAdded) window.legal.onSourceAdded(onSource);
