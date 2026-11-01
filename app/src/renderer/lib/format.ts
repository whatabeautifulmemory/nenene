// 화면 전반에서 쓰는 라벨·포맷. 파이프라인의 영어 상태값을 한국어 용어로 옮기는 곳은 여기 하나다.
import type { CiteStatus, Judgment, SectionRole, StageId } from '../../shared/ipc.ts';

export const ago = (iso: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return '방금';
    if (min < 60) return `${min}분 전`;
    if (min < 60 * 24) return `${Math.round(min / 60)}시간 전`;
    return `${Math.round(min / 60 / 24)}일 전`;
};

export const clock = (d: Date = new Date()): string => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

export const KB = (n: number): string => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const VERDICT_KO: Record<Judgment['verdict'], string> = { supported: '지지', weak: '박약', refuted: '반박', unresolved: '미결' };

export const ROLE_KO: Record<SectionRole, string> = {
    intro: '서론',
    background: '배경',
    analysis: '분석',
    doctrine: '법리',
    evaluation: '평가',
    comparative: '비교법',
    proposal: '제안',
    conclusion: '결론',
};

export const KIND_KO: Record<CiteStatus['kind'], string> = {
    statute: '법령',
    precedent: '판례',
    constitutional: '헌재',
    scholarship: '문헌',
    research: '조사',
    url: 'URL',
    other: '기타',
};

export const CHECK_KO: Record<string, string> = {
    verified: '확인',
    not_found: '코퍼스에 없음',
    article_missing: '조문 없음',
    date_mismatch: '선고일 불일치',
    unverifiable: '검증 불가',
    corpus_gap: '코퍼스 미수록',
    pending: '대기',
    skipped: '생략',
};

export const SOURCE_KO: Record<string, string> = {
    full_text: '전문',
    provided: '제공',
    abstract_only: '초록만',
    metadata_only: '서지만',
    unavailable: '없음',
    user_declined: '없음(필자)',
    not_found: '코퍼스 밖',
    corpus_gap: '코퍼스 미수록',
    paywalled: '페이월',
    login_required: '로그인월',
    error: '오류',
    offline: '이 컴퓨터에 없음',
    none: '—',
    web: '웹',
};

export const TOOL_KIND_KO: Record<string, string> = {
    acquire: '원문 확보',
    verify: '인용 검증',
    coverage: '누락 탐지',
    resolve: '조문 해석',
    extract: '발췌',
};

export const STAGE_LABEL: Record<StageId, string> = {
    research: '조사',
    thesis: '논지',
    outline: '목차',
    draft: '초고',
    cite: '인용',
    hitl: '질문',
    snowball: '연쇄',
    review: '검토',
    gapfill: '보강',
    revise: '수정',
    reverify: '재검증',
    citecheck: '인용 대조',
    assemble: '조립',
};

export type CiteTone = 'ok' | 'partial' | 'neutral' | 'bad' | 'unknown';

/**
 * 원문에서 확인되지 않아 조립 전에 본문에서 뺀 인용(compose CiteStatus.withheld). 상태표에는 남지만 각주는 없다 —
 * 원고의 검증 부록 「본문에서 뺀 인용」과 같은 말을 한다. (shared CiteStatus 에는 아직 이 필드가 없다.)
 */
export const isWithheld = (c: CiteStatus | undefined): boolean => c?.withheld === true;

/**
 * 인용 배지 색. src/law/cite.ts 의 statusMark 와 같은 규칙이다 — 원고의 각주 꼬리표와 화면의
 * 배지가 서로 다른 말을 하면 안 된다. 본문에서 뺀 인용은 ✗(bad)다.
 */
export function citeTone(c: CiteStatus | undefined): CiteTone {
    if (!c) return 'unknown';
    if (isWithheld(c)) return 'bad';
    if (c.kind === 'research' || c.kind === 'url') return 'partial';
    if (c.check === 'not_found' || c.check === 'article_missing' || c.check === 'date_mismatch') return 'bad';
    if (c.check === 'verified' && (c.source === 'full_text' || c.source === 'provided')) return 'ok';
    if (c.source === 'provided') return 'partial';
    if (c.source === 'full_text') return 'ok';
    if (c.source === 'user_declined') return 'bad';
    return 'neutral';
}

export function citeToneLabel(c: CiteStatus | undefined): string {
    if (!c) return '확보 전';
    if (isWithheld(c)) return '본문에서 뺌';
    const web = (c.how ?? '').startsWith('web');
    if (c.kind === 'research' || c.kind === 'url') return '공개자료';
    if (c.check === 'article_missing') return '조문 없음';
    if (c.check === 'not_found') return '코퍼스에 없음';
    if (c.check === 'date_mismatch') return '선고일 불일치';
    if (c.check === 'verified' && (c.source === 'full_text' || c.source === 'provided')) return '원문 확인';
    if (c.source === 'provided') return web ? '웹 확인' : '제공받음';
    if (c.source === 'full_text') return '원문 확인';
    if (c.source === 'user_declined') return '원문 없음(필자 확인)';
    return '원문 미확보';
}

/** 로마 숫자 — 조립기가 number 를 붙이기 전의 장 카드에 쓴다. */
export function roman(n: number): string {
    const map: [number, string][] = [
        [10, 'X'],
        [9, 'IX'],
        [5, 'V'],
        [4, 'IV'],
        [1, 'I'],
    ];
    let out = '';
    let v = n;
    for (const [val, sym] of map) {
        while (v >= val) {
            out += sym;
            v -= val;
        }
    }
    return out || String(n);
}

/** `[^n]: …` 정의를 원고에서 읽는다. 서랍의 각주 목록과 참고문헌 대체용. */
export function parseFootnotes(md: string): { n: number; text: string }[] {
    const out: { n: number; text: string }[] = [];
    for (const line of md.split('\n')) {
        const m = /^\[\^(\d+)\]:\s?(.*)$/.exec(line);
        if (m) out.push({ n: Number(m[1] ?? 0), text: (m[2] ?? '').trim() });
    }
    return out;
}

/** `## 참고문헌` 아래 블록만 잘라낸다. 다음 `## ` 또는 `---` 앞까지. */
export function sliceSection(md: string, heading: string): string | null {
    const lines = md.split('\n');
    const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().startsWith(heading));
    if (start < 0) return null;
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i] ?? '';
        if (/^##\s+/.test(l) || /^---\s*$/.test(l)) break;
        body.push(l);
    }
    const text = body.join('\n').trim();
    return text || null;
}

export function readBool(key: string, fallback: boolean): boolean {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === '1';
    } catch {
        return fallback;
    }
}

export function writeBool(key: string, v: boolean): void {
    try {
        localStorage.setItem(key, v ? '1' : '0');
    } catch {
        /* 비공개 창 등 — 기억하지 못해도 동작은 한다 */
    }
}
