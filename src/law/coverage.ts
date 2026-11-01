// 누락 탐지 — "인용해야 할 조문을 인용했는가".
//
// 보정 단계가 못 잡는 것을 잡는다. 보정은 **인용한 조문이 그 말을 하는가**만 검증하고 인용을
// 뺄 수만 있으므로, 애초에 떠올리지 못한 조문은 영원히 등장하지 않는다. CI 주제 실행에서
// 실제로 그랬다: 모델은 망법 제23조의2·제23조의3만 인용하고 **연계정보를 정의하는 제23조의5를
// 한 번도 인용하지 않았다** — 같은 법을 읽으면서도.
//
// 방법은 단순하다. 쟁점의 고유 용어를, 이미 인용된 법령의 **전문**에서 역검색한다. 그 용어를
// 제목이나 본문에 가진 조문이 있는데 어느 명제도 인용하지 않았다면, 그것은 후보가 아니라
// "빠뜨린 것"이다. 판단은 모델이 아니라 문자열 대조가 한다.
import { getLawDoc, getArticle, isRepealStub, lawKindOf, normalizeArticleNo, repealNote, resolveLawPath } from './legalize.ts';
import { record } from '../trace.ts';

export interface ArticleHit {
    law: string;
    articleNo: string;
    heading: string;
    /** 이 조문이 왜 관련 있다고 보이는가 — 어떤 용어가 걸렸는가 */
    matched: string[];
    /** 이 조문의 텍스트(잘라서) */
    excerpt: string;
}

/** 쟁점 문장에서 코퍼스 역검색에 쓸 고유 용어를 뽑는다. */
export function probeTerms(question: string, claims: string[]): string[] {
    const GENERIC = new Set(
        `문제점 헌법적 측면 검토 고찰 연구 방안 개선 현황 분석 경우 내용 관련 대한 관하여 관한 규정 법률 조항 판례 의미 의의 성격 한계 쟁점 논의 검토 대상 기준 절차 요건`
            .split(/\s+/)
            .filter(Boolean),
    );
    const text = [question, ...claims].join(' ');
    const out = new Map<string, number>();
    for (const m of text.matchAll(/[가-힣]{3,}/g)) {
        const t = m[0];
        if (GENERIC.has(t)) continue;
        out.set(t, (out.get(t) ?? 0) + 1);
    }
    // 괄호 안 약어 (CI, DID 등) 도 신호다.
    for (const m of text.matchAll(/\(([A-Z]{2,6})\)/g)) out.set(`ACR:${m[1]}`, 3);
    return [...out.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t)
        .filter((t) => !t.startsWith('ACR:'))
        .slice(0, 12);
}

interface ArticleSpan {
    no: string;
    heading: string;
    text: string;
}

/** 법령 문서를 조문 단위로 자른다. */
export function splitArticles(body: string): ArticleSpan[] {
    const lines = body.split('\n');
    const out: ArticleSpan[] = [];
    let cur: { no: string; heading: string; lines: string[] } | null = null;
    for (const line of lines) {
        const m = /^#{3,6}\s*(제\s*\d+\s*조(?:\s*의\s*\d+)?)\s*(.*)$/.exec(line);
        if (m) {
            if (cur) out.push({ no: cur.no, heading: cur.heading, text: cur.lines.join('\n').trim() });
            cur = { no: normalizeArticleNo(m[1]!), heading: m[2]!.replace(/^\(|\)$/g, '').trim(), lines: [] };
            continue;
        }
        cur?.lines.push(line);
    }
    if (cur) out.push({ no: cur.no, heading: cur.heading, text: cur.lines.join('\n').trim() });
    return out;
}

/**
 * 이미 인용된 법령들 안에서, 쟁점의 고유 용어를 가진 조문을 찾아
 * **아직 아무도 인용하지 않은 것**만 돌려준다.
 */
export function findUncitedArticles(args: {
    citedLaws: string[];
    terms: string[];
    claimedArticles: Set<string>;
    perLaw?: number;
}): ArticleHit[] {
    const { citedLaws, terms, claimedArticles } = args;
    const perLaw = args.perLaw ?? 4;
    const hits: ArticleHit[] = [];
    // **모든** 인용 법령의 이름에 등장하는 말은 잡음이다. 「개인정보 보호법」을 인용했다는
    // 이유로 '개인정보'·'보호법'이 모든 조문에 걸리면 순위가 의미를 잃는다.
    const titleNoise = citedLaws.join(' ').replace(/[「」『』]/g, '');
    for (const raw of citedLaws) {
        for (const doc of lawDocsFor(raw)) {
            // 법령 이름 자체에 들어 있는 말은 잡음이다 — 「정보통신망…법률」에서 '정보통신망'·
            // '정보보호'가 모든 조문에 걸리면 아무것도 걸러지지 않는다.
            const usable = terms.filter((t) => t.length >= 3 && !titleNoise.includes(t));
            const spans = splitArticles(doc.body);
            const scored: { span: ArticleSpan; head: string[]; body: string[]; score: number }[] = [];
            for (const span of spans) {
                if (claimedArticles.has(span.no)) continue;
                const head = usable.filter((t) => span.heading.includes(t));
                const body = usable.filter((t) => span.text.includes(t));
                // 제목에 걸린 것이 훨씬 강한 신호다. 본문만 걸린 것은 2개 이상일 때만 후보로 둔다.
                if (!head.length && body.length < 2) continue;
                const score = head.length * 3 + body.length;
                if (score < 2) continue;
                scored.push({ span, head, body, score });
            }
            scored.sort((a, b) => b.score - a.score);
            for (const s of scored.slice(0, perLaw)) {
                hits.push({
                    law: doc.name,
                    articleNo: s.span.no,
                    heading: s.span.heading,
                    matched: [...s.head, ...s.body],
                    excerpt: s.span.text.slice(0, 1200),
                });
            }
        }
    }
    return hits;
}

/**
 * 주어진 법령들에서 쟁점 용어와 겹치는 조문을 **후보로** 돌려준다(인용 여부와 무관).
 *
 * 워커에게 원문을 쥐여 주기 위한 것이다. 워커가 원문을 보지 않고 인용하면 귀속 오류가 나고,
 * 그건 지금까지 관찰된 가장 흔한 실패다 — 10개 명제 전부가 그랬다.
 */
export function findCandidateArticles(args: { laws: string[]; terms: string[]; perLaw?: number }): ArticleHit[] {
    const perLaw = args.perLaw ?? 4;
    const hits: ArticleHit[] = [];
    const noise = args.laws.join(' ');
    for (const raw of args.laws) {
        for (const doc of lawDocsFor(raw)) {
            const usable = args.terms.filter((t) => t.length >= 2 && !noise.includes(t));
            if (!usable.length) continue;
            const scored = splitArticles(doc.body)
                .map((span) => {
                    const head = usable.filter((t) => span.heading.includes(t));
                    const body = usable.filter((t) => span.text.includes(t));
                    return { span, head, body, score: head.length * 3 + body.length };
                })
                .filter((x) => x.score >= 2)
                .sort((a, b) => b.score - a.score)
                .slice(0, perLaw);
            for (const x of scored) {
                hits.push({
                    law: doc.name,
                    articleNo: x.span.no,
                    heading: x.span.heading,
                    matched: [...x.head, ...x.body],
                    excerpt: x.span.text.slice(0, 1400),
                });
            }
        }
    }
    return hits;
}

/**
 * 법령명 → 그 법령의 법률/시행령 문서들(존재하는 것만).
 *
 * 이름 끝의 '법률'을 무조건 종류 표시로 떼면 안 된다 — 「정보통신망 이용촉진 및 정보보호 등에
 * 관한 법률」은 그 자체가 법령명이고, 떼면 아무것도 찾지 못한다. 그래서 **전체 이름을 먼저**
 * 시도하고, 실패했을 때만 종류 접미를 떼어 다시 찾는다.
 */
function lawDocsFor(rawName: string) {
    const out: { name: string; body: string; path: string }[] = [];
    const clean = rawName.replace(/[「」『』]/g, '').trim();
    const stripped = clean.replace(/\s*(법률|시행령|시행규칙)$/, '').trim();
    const names = [...new Set([clean, stripped])];
    for (const n of names) {
        for (const suffix of ['', ' 시행령']) {
            const path = resolveLawPath(`${n}${suffix}`);
            if (!path) continue;
            // 종류로 본다(이름 「/법률.md」 가 아니라) — 고른 판본이 「법률(법률).md」「시행령(대통령령).md」 여도 그 법령의 법률·시행령이다.
            if (lawKindOf(path) !== (suffix ? '시행령' : '법률')) continue;
            if (out.some((o) => o.path === path)) continue;
            const doc = getLawDoc(`${n}${suffix}`);
            if ('error' in doc) continue;
            out.push({ name: `${n}${suffix}`, body: doc.body, path });
        }
    }
    return out;
}

/** 인용 문자열들에서 법령명 집합을 뽑는다. */
export function lawsFromCitations(citations: string[]): string[] {
    const names = new Set<string>();
    for (const c of citations) {
        const m = /^(.+?)\s*제\s*\d+\s*조/.exec(c);
        if (!m) continue;
        names.add(m[1]!.replace(/[「」『』]/g, '').trim());
    }
    return [...names];
}

/** 인용 문자열들에서 조번호 집합을 뽑는다. */
export function articlesFromCitations(citations: string[]): Set<string> {
    const out = new Set<string>();
    for (const c of citations) {
        for (const m of c.matchAll(/제\s*\d+\s*조(?:\s*의\s*\d+)?/g)) out.add(normalizeArticleNo(m[0]));
    }
    return out;
}

/**
 * planner 가 지목한 조문을 실제 원문으로 바꾼다. 못 찾으면 이유를 담아 돌려준다 —
 * "없다"는 사실도 워커에게는 정보다(삭제된 조문을 근거로 쓰지 않게).
 */
export function resolveProvision(citation: string): ArticleHit | { missing: string } {
    const started = Date.now();
    const r = resolveProvisionInner(citation);
    record({
        kind: 'resolve',
        name: 'provision',
        subject: citation,
        ok: 'articleNo' in r,
        ms: Date.now() - started,
        ...('missing' in r ? { detail: r.missing } : { detail: `${r.law} ${r.articleNo}` }),
    });
    return r;
}

function resolveProvisionInner(citation: string): ArticleHit | { missing: string } {
    const m = /^(.+?)\s*(제\s*\d+\s*조(?:\s*의\s*\d+)?)/.exec(citation.trim());
    if (!m) return { missing: `법령명·조번호를 해석하지 못함: ${citation}` };
    const lawName = m[1]!.replace(/[「」『』]/g, '').trim();
    const articleNo = normalizeArticleNo(m[2]!);
    const doc = getLawDoc(lawName);
    if ('error' in doc) return { missing: `${lawName} 를 찾을 수 없음` };
    // 폐지 기록만 남은 법령은 「조문이 삭제됨」이 아니다 — 워커가 그 법을 현행처럼 쓰지 않게 폐지라고 알린다.
    if (isRepealStub(doc.body)) return { missing: `${lawName}: ${repealNote(doc)}` };
    const art = getArticle(doc, articleNo);
    if (!art) return { missing: `${lawName} 에 ${articleNo} 가 없음 (삭제되었거나 조번호 오기)` };
    return {
        law: doc.name,
        articleNo,
        heading: art.heading,
        matched: [],
        excerpt: art.text.slice(0, 1400),
    };
}

/** 조문 하나를 조회해 텍스트를 가져온다(보충 명제 생성용). */
export function articleText(law: string, articleNo: string): { heading: string; text: string } | null {
    const doc = getLawDoc(law);
    if ('error' in doc) return null;
    const a = getArticle(doc, articleNo);
    return a ? { heading: a.heading, text: a.text } : null;
}
