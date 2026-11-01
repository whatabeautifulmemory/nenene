// 인용 마커. 집필 모델은 본문에 ⟦…⟧ 만 쓰고, 번호·각주·참고문헌은 전부 여기서 만든다.
//
// 왜 모델에게 번호를 맡기지 않나: 장마다 따로 호출되는 모델은 장마다 1 부터 센다. 실제로
// 서론의 [^1] 이 "주민등록법 제6조" 였고 조립기의 [^1] 은 "대한민국헌법 제11조" 였다 —
// 같은 번호가 두 가지를 가리키는 원고가 나왔다. 번호는 논문 전체에서 한 번만 매겨야 하고,
// 그건 모델이 아니라 코드가 할 일이다.
import type { Authority } from '../schemas.ts';

export type CiteKind = 'statute' | 'precedent' | 'constitutional' | 'scholarship' | 'research' | 'url' | 'other';

export interface Cite {
    raw: string;
    key: string;
    kind: CiteKind;
}

export const MARKER = /⟦([^⟦⟧]{1,400})⟧/g;

/** 정규화 키 — 공백·따옴표·괄호 차이를 지운다. 같은 권위면 같은 키여야 한다. */
export function normalizeKey(raw: string): string {
    let s = raw.trim();
    s = s.replace(/[「」『』"“”'‘’]/g, '');
    s = s.replace(/\s+/g, '');
    s = s.replace(/[.,;:·]+$/g, '');
    // 조문 인용의 "제 6 조" 류 공백은 이미 지웠다. 항·호 표기 통일.
    s = s.replace(/제(\d+)조의(\d+)/g, '제$1조의$2');
    return s.toLowerCase();
}

/**
 * 사건번호. 연도는 네 자리, 옛 사건은 두 자리([6-9]\d, 붙여 씀). 뒤에 년·월·일이나 조·항·호가 오면 사건번호가 아니다 —
 * "법원조직법 제81조의2" 의 "81조의2" 를 사건번호로 읽으면 법령이 판례 사다리를 탄다.
 */
const CASE_NO_SRC = String.raw`(?:\d{4}\s*|(?<!\d)[6-9]\d)(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+`;

/** 본문의 사건번호들(공백 제거). */
export function caseNosIn(text: string): string[] {
    return [
        ...new Set(
            (text.match(/\d{4}\s*(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+|(?<!\d)[6-9]\d(?![년월일건명차조항호\d])[가-힣]{1,3}\d{2,}/g) ?? []).map((s) => s.replace(/\s+/g, '')),
        ),
    ];
}

/** "같은 판결", "위 논문", "전게서" — 앞의 인용을 가리키는 말. 그 자체로는 찾을 것도 물을 것도 없다. */
export function isReferential(raw: string): boolean {
    const s = raw.replace(/^⟦|⟧$/g, '').trim();
    return s.length <= 24 && /^(?:같은|위|앞의|앞|전게|동|상게|이)\s*(?:판결|결정|논문|책|글|법|조|사건|문헌|자료|서|판례|결정례)/.test(s);
}

const COURT_ABBR_FULL: Record<string, string> = { 서울행법: '서울행정법원', 서울고법: '서울고등법원', 서울중앙지법: '서울중앙지방법원' };

/**
 * 인용의 "같음". 같은 것을 두 번 찾고 두 번 묻지 않기 위해 쓴다.
 * - 웹 자료(제목 <url>): URL
 * - 법령: 법령명 + 조 (같은 조의 다른 항은 같은 원문이다)
 * - 판례: 사건번호. 대법원·헌재 밖의 법원은 사건번호가 겹치므로(서울중앙지법 2019가합1234 ≠ 부산지법 2019가합1234) 법원명을 붙인다.
 *   ⟦헌재 2007. 6. 28. 2004헌마644⟧ 와 "헌법재판소 2007. 6. 28. 선고 2004헌마644 결정" 은 같다.
 * - 문헌: 첫 저자 + 제목 (KCI 가 쪽수를 덧붙여도 같은 논문, 같은 제목의 다른 책은 다른 것)
 */
export function identityOf(citation: string): string {
    const raw0 = citation.replace(/^⟦|⟧$/g, '').trim();
    const url = /<(https?:\/\/[^>\s]+)>\s*$/.exec(raw0)?.[1] ?? (/^https?:\/\/\S+$/.test(raw0) ? raw0 : undefined);
    if (url) return `url:${url.replace(/^https?:\/\/(?:www\.)?/, '').replace(/[/#?]+$/, '').toLowerCase()}`;
    const s = raw0;
    if (isReferential(s)) return `ref:${normalizeKey(s)}`;
    const kind = classify(s);
    if (kind === 'statute') {
        const m = /^(.*?제\s*\d+\s*조(?:\s*의\s*\d+)?)/.exec(s);
        return `statute:${normalizeKey(m ? m[1]! : s)}`;
    }
    const nos = caseNosIn(s);
    // 문헌 제목에 든 사건번호(「… 2022도1452 판결을 소재로」)는 그 판결이 아니다 — classify 가 판례라고 할 때만.
    if (nos.length && (kind === 'precedent' || kind === 'constitutional')) {
        const court = /^\s*([가-힣]{2,6}(?:고등|지방|행정|가정|회생|특허)법원(?:\s*[가-힣]{2,4}지원)?|서울행법|서울고법|서울중앙지법|[가-힣]{2,4}지법(?:\s*[가-힣]{2,4}지원)?)/.exec(s)?.[1];
        const full = court ? (COURT_ABBR_FULL[court] ?? court.replace(/\s+/g, '').replace(/지법/, '지방법원')) : '';
        return full ? `case:${full}:${nos[0]}` : `case:${nos[0]}`;
    }
    const tm = /[「『“"]([^」』”"\n]{4,160})[」』”"]/.exec(s);
    if (tm) {
        const author = /^([가-힣A-Za-z]{2,})/.exec(s.slice(0, tm.index))?.[1] ?? '';
        return `title:${author}:${normalizeKey(tm[1]!)}`;
    }
    return normalizeKey(s);
}

export function classify(raw: string): CiteKind {
    const s = raw.trim();
    if (/^R\d{1,3}$/i.test(s)) return 'research';
    if (/^https?:\/\//i.test(s)) return 'url';
    if (isReferential(s)) return 'other';
    // 「주민등록법」 — 겹낫표 안이 법령명뿐이면 법령이다.
    if (/^[「『][가-힣·ㆍ\s]{1,40}(?:법률|법|시행령|시행규칙|규칙)[」』]$/.test(s)) return 'statute';
    // 「주민등록법」 제6조 — 법령명을 겹낫표로 감싼 조문 인용. 문헌의 겹낫표와 구별한다.
    if (/^[「『][^」』]{1,40}[」』]\s*제\s*\d+\s*조/.test(s)) return 'statute';
    // 조 없이 법령명만 쓴 인용(⟦전자정부법⟧) — 법령이다. 조를 못 찾았다는 것이 검증 결과가 되어야지 "기타"가 아니다.
    // 헌법·민법·형법처럼 한 글자 어간도 법령이다.
    if (/^[가-힣·ㆍ\s]{1,40}(?:법률|법|시행령|시행규칙|규칙|조례)$/.test(s) && !/\s(?:판결|결정)$/.test(s)) return 'statute';
    // 저자, "제목", … — 곧은따옴표 제목도 문헌이다(제목에 '판결'이 들어도).
    const quoted = /[「『]/.test(s) || /^[^"“,]{2,40},\s*[“"][^”"]{2,}[”"]/.test(s);
    const page = /\d{1,4}\s*[-–~]\s*\d{1,4}\s*면|\d+\s*면\b/.test(s);
    const caseNo = new RegExp(CASE_NO_SRC).test(s);
    if (!quoted && !page) {
        // 사건번호가 있으면 판례·결정이다 — 제목에 조문이 들어간 결정(…제32조의4 위헌확인)도 포함.
        if (/(?:\d{4}\s*|(?<!\d)[89]\d)헌[가-힣]\s*\d+/.test(s)) return 'constitutional';
        if (caseNo && /대법원|법원|선고|판결|결정|대판|대결|지법|고법|행법/.test(s)) return 'precedent';
        // 사건번호만 쓴 것(⟦2008도763⟧)
        if (new RegExp(`^${CASE_NO_SRC}$`).test(s)) return 'precedent';
        // 헌법재판소법 제68조 는 법령이다 — 조문 번호가 법원 이름보다 먼저다.
        if (/제\s*\d+\s*조/.test(s)) return 'statute';
        if (/헌법재판소|헌재/.test(s)) return 'constitutional';
        if (/대법원|법원|선고|결정|판결|대판|대결/.test(s)) return 'precedent';
    }
    if (quoted || page || /,\s*(19|20)\d{2}\b/.test(s)) return 'scholarship';
    return 'other';
}

/** 본문에서 마커를 등장 순서대로 뽑는다. 같은 키는 한 번만. */
export function extractCites(text: string): Cite[] {
    const seen = new Set<string>();
    const out: Cite[] = [];
    for (const m of text.matchAll(MARKER)) {
        const raw = m[1]!.trim();
        const key = normalizeKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ raw, key, kind: classify(raw) });
    }
    return out;
}

/** 논문 전체의 각주 번호부. 첫 등장 순. */
export class CiteBook {
    private byKey = new Map<string, { n: number; raw: string; kind: CiteKind }>();

    add(raw: string): number {
        const key = normalizeKey(raw);
        const hit = this.byKey.get(key);
        if (hit) return hit.n;
        const n = this.byKey.size + 1;
        this.byKey.set(key, { n, raw: raw.trim(), kind: classify(raw) });
        return n;
    }

    get(raw: string): { n: number; raw: string; kind: CiteKind } | undefined {
        return this.byKey.get(normalizeKey(raw));
    }

    entries(): { key: string; n: number; raw: string; kind: CiteKind }[] {
        return [...this.byKey.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.n - b.n);
    }

    get size(): number {
        return this.byKey.size;
    }
}

/** 본문의 ⟦…⟧ 를 [^n] 으로 바꾼다. 번호부에 없는 인용은 그 자리에서 추가된다. */
export function renderMarkers(text: string, book: CiteBook): string {
    return text.replace(MARKER, (_m, raw: string) => `[^${book.add(raw)}]`);
}

/** 마커를 지운다 (초록·요지 등 번호 없는 곳에 쓴다). */
export function stripMarkers(text: string): string {
    return text.replace(MARKER, '').replace(/\s+([.,;:])/g, '$1');
}

/** 마커 → 검증기가 아는 Authority. 조사 핸들은 호출자가 findings 로 풀어 준다. */
export function toAuthority(
    c: Cite,
    research: (handle: string) => { citation: string; summary: string; url?: string } | undefined,
): Authority | null {
    switch (c.kind) {
        case 'statute':
            return { type: 'statute', citation: c.raw, holding: '' };
        case 'constitutional':
        case 'precedent':
            return { type: 'precedent', citation: c.raw, holding: '' };
        case 'scholarship':
            return { type: 'scholarship', citation: c.raw, holding: '' };
        case 'url':
            return { type: 'practice', citation: c.raw, holding: '' };
        case 'research': {
            const f = research(c.raw.toUpperCase());
            if (!f) return null;
            return { type: 'practice', citation: `${f.citation}${f.url ? ` <${f.url}>` : ''}`, holding: f.summary.slice(0, 200) };
        }
        default:
            return { type: 'scholarship', citation: c.raw, holding: '' };
    }
}

export interface CiteStatusLike {
    key: string;
    raw: string;
    kind: CiteKind;
    n: number;
    check: string;
    source: string;
    how?: string;
    url?: string;
    note?: string;
    /** 조사 핸들이면 풀어 쓴 서지 */
    display?: string;
}

/** 각주 본문에 붙는 상태 표시. 필자가 무엇을 직접 확인해야 하는지 한눈에 보이게. */
export function statusMark(s: { check: string; source: string; how?: string; kind: CiteKind }): { mark: string; label: string; tone: 'ok' | 'partial' | 'neutral' | 'bad' } {
    const web = (s.how ?? '').startsWith('web');
    if (s.kind === 'research' || s.kind === 'url') return { mark: '◐', label: '공개자료', tone: 'partial' };
    // 필자가 준 파일을 읽지 못했다 — 코퍼스 판정보다 먼저. ✗ 로 보이면 수정 단계가 마커를 지우고 ②에서 다시 묻지도 못한다.
    // tone bad 라야 각주에 이유(note)가 붙는다.
    if (s.source === 'error' && (s.how ?? '').startsWith('human')) return { mark: '⚠', label: '제공 자료를 읽지 못함', tone: 'bad' };
    if (s.check === 'not_found' || s.check === 'article_missing') return { mark: '✗', label: s.check === 'article_missing' ? '조문 없음' : '코퍼스에 없음', tone: 'bad' };
    if (s.check === 'date_mismatch') return { mark: '✗', label: '선고일 불일치', tone: 'bad' };
    // 필자가 원문 대신 내용을 적어 준 것 — 원문 확인이 아니다.
    if (s.source === 'provided' && (s.how ?? '').startsWith('human-summary')) return { mark: '◐', label: '필자 답변(원문 아님)', tone: 'partial' };
    if (s.check === 'verified' && (s.source === 'full_text' || s.source === 'provided')) return { mark: '✓', label: '원문 확인', tone: 'ok' };
    if (s.source === 'provided' && web) return { mark: '◐', label: '웹 확인', tone: 'partial' };
    if (s.source === 'provided') return { mark: '◐', label: '제공받음', tone: 'partial' };
    if (s.source === 'full_text') return { mark: '✓', label: '원문 확인', tone: 'ok' };
    if (s.source === 'user_declined') return { mark: '⚠', label: '원문 없음(필자 확인)', tone: 'bad' };
    return { mark: '⚠', label: '원문 미확보', tone: 'neutral' };
}

/**
 * ✓ 에도 붙여야 하는 단서 — 대조한 원문의 한계. 「시행 전 판본」과 대조했다는 말이 각주에 없으면 필자는 아직 효력이 없는 조문을 현행으로 인용한다.
 * 직전(현행) 판본과 대조했으면 공포된 개정이 있다는 것, 판례 선고일을 코퍼스가 모르면 날짜는 대조하지 못했다는 것도 같다.
 */
const QUALIFIER = /시행 전 판본\(|현행 판본\(|코퍼스 선고일 미상/;

/**
 * 각주에 보일 note — 120자로 줄이되 단서(QUALIFIER 부터 끝까지)는 자르지 않는다. 단서는 verify.ts 가 note 끝에 붙이므로, 앞에서부터 자르던 때는
 * 긴 법령명의 조문 없음(✗) 각주에서 「…현행 조문과 다를 수 있음」 이 잘렸다. 줄일 것은 단서 앞의 이유다.
 */
function footnoteNote(note: string, max = 120): string {
    if (note.length <= max) return note;
    const at = note.search(QUALIFIER);
    if (at < 0) return note.slice(0, max);
    const qualifier = note.slice(at);
    const room = max - qualifier.length - 4;
    const reason = note.slice(0, at).replace(/[\s—]+$/, '');
    if (!reason) return qualifier;
    return reason.length <= room ? `${reason} — ${qualifier}` : `${reason.slice(0, Math.max(0, room - 1)).trimEnd()}… — ${qualifier}`;
}

/** 각주 정의 블록. */
export function renderFootnotes(cites: CiteStatusLike[]): string {
    return [...cites]
        .sort((a, b) => a.n - b.n)
        .map((c) => {
            const m = statusMark(c);
            const text = c.display ?? c.raw;
            const shown = c.note && (m.tone === 'bad' || QUALIFIER.test(c.note));
            const tail = c.kind === 'research' || c.kind === 'url' ? '' : ` — ${m.mark} ${m.label}${shown ? ` (${footnoteNote(c.note!)})` : ''}`;
            return `[^${c.n}]: ${text}${tail}`;
        })
        .join('\n');
}

/** 참고문헌 — 법령 / 판례 / 문헌 / 공개자료. 본문 각주와 별도로 끝에 붙는다. */
export function bibliography(cites: CiteStatusLike[]): string {
    const group = (k: CiteKind[]) => cites.filter((c) => k.includes(c.kind)).map((c) => c.display ?? c.raw);
    const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, 'ko'));
    const out: string[] = [];
    const laws = uniq(group(['statute']).map((s) => s.replace(/\s*제\s*\d+\s*조.*$/, '').trim()).filter(Boolean));
    const cases = uniq(group(['constitutional', 'precedent']));
    const lit = uniq(group(['scholarship', 'other']));
    const web = uniq(group(['research', 'url']));
    if (lit.length) out.push('### 문헌', ...lit.map((x) => `- ${x}`), '');
    if (cases.length) out.push('### 판례·결정', ...cases.map((x) => `- ${x}`), '');
    if (laws.length) out.push('### 법령', ...laws.map((x) => `- ${x}`), '');
    if (web.length) out.push('### 공개자료', ...web.map((x) => `- ${x}`), '');
    return out.join('\n').trim();
}

/** "I", "II", … */
export function roman(n: number): string {
    const map: [number, string][] = [
        [10, 'X'],
        [9, 'IX'],
        [5, 'V'],
        [4, 'IV'],
        [1, 'I'],
    ];
    let s = '';
    let x = n;
    for (const [v, r] of map) {
        while (x >= v) {
            s += r;
            x -= v;
        }
    }
    return s || String(n);
}
