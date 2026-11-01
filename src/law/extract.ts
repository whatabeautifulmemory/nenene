// 전문에서 **관련 부분만** 뽑는다.
//
// 왜 필요한가: 원문을 확보해도 논문 한 편은 40~80k 자다. 그대로 프롬프트에 넣으면 비용도
// 비용이지만, 판정자가 자기 주장에 맞는 문장을 골라 읽는 편향이 생긴다. 그래서 추출은
// **결정적**으로, 명제에 등장한 용어의 빈도로 한다 — 모델에게 "관련 부분을 찾아라"고 하면
// 그건 검색이 아니라 창작이다.
//
// 그리고 중요한 실패 상태: 원문은 확보했는데 관련 문단이 없을 수 있다. 그건 "전문을 읽었다"가
// 아니라 "이 논문은 이 명제를 다루지 않는다"이고, 근거로 쓸 수 없다. 초록만 있는 것과는 또
// 다른 상태다.
import { normalizeLawName } from './legalize.ts';

export interface Passage {
    text: string;
    score: number;
    matched: string[];
}

const STOP = new Set(
    `것 수 등 및 그 이 저 위 때 경우 따라서 그러나 또한 대한 관하여 관한 있는 없다 있다 하여 한다 되는 되지 아니 아니한 그런 이러한 위하여 통해 대하여 의하 제 조 항 호 법 판결 대법원 헌법 재판소 법원 주장 근거 명제 또한 만약 즉 다만 그리고 하지만 그러므로 그러면 이는 이를 이에 그리하여 나아가 한편 다른 같은 보다 더 가장 매우 아주 모든 어떤 각각 서로 따라 위해 대해 통하`
        .split(/\s+/)
        .filter(Boolean),
);

/** 한글 어절 + 라틴/숫자 토큰. 조사는 떼지 않고 어절 단위로 센다(한국어 형태소 분석 없이). */
export function terms(s: string): string[] {
    const out: string[] = [];
    for (const m of s.matchAll(/[가-힣]{2,}|[A-Za-z][A-Za-z-]{2,}|\d{2,}/g)) {
        const t = m[0];
        if (STOP.has(t)) continue;
        if (t.length < 2) continue;
        out.push(t);
    }
    return out;
}

/** 어절에서 흔한 조사 꼬리를 떼어 비교 가능한 어간으로 만든다. 과하게 하면 검색이 깨진다. */
function stem(t: string): string {
    return t.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터|라고|하고|한|된|되는|하는)$/u, '');
}

function paragraphs(text: string): string[] {
    return text
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter((p) => p.length >= 40);
}

export interface ExtractQuery {
    /** 판정 대상 명제 */
    proposition: string;
    /** 인용된 권위가 이 명제에 관해 말한다고 찬성측이 주장하는 것 */
    holding?: string;
    /** 인용 문자열 자체 — 원문에 그대로 등장하면 강한 신호다 */
    citation?: string;
}

export interface ExtractResult {
    passages: Passage[];
    /** 원문 길이 (문자) */
    chars: number;
    /** 관련 문단이 하나도 없었다 */
    empty: boolean;
}

export function relevantPassages(fullText: string, q: ExtractQuery, k = 4): ExtractResult {
    const paras = paragraphs(fullText);
    const queryTerms = new Set([...terms(q.proposition), ...terms(q.holding ?? '')].map(stem));
    const citation = (q.citation ?? '').replace(/\s+/g, '');
    const citeProbe = citation.length >= 8 ? citation.slice(0, 40) : '';

    const scored: Passage[] = [];
    for (const p of paras) {
        const pTerms = terms(p).map(stem);
        if (!pTerms.length) continue;
        const matched = new Set<string>();
        let hit = 0;
        for (const t of pTerms) {
            if (queryTerms.has(t)) {
                hit++;
                matched.add(t);
            }
        }
        if (!hit) continue;
        // 길이 정규화: 긴 문단이 무조건 이기지 않게. 그리고 서로 다른 질의어가 여러 번 맞을수록 가중.
        const density = hit / Math.sqrt(pTerms.length);
        const diversity = matched.size / Math.max(1, queryTerms.size);
        let score = density * 2 + diversity * 3;
        if (citeProbe && p.replace(/\s+/g, '').includes(citeProbe)) score += 2;
        scored.push({ text: p, score, matched: [...matched] });
    }

    scored.sort((a, b) => b.score - a.score);
    // 문단 순서를 유지해 돌려준다 — 원문의 논증 순서가 판정에 의미가 있다.
    const top = scored.slice(0, k);
    const ordered = [...top].sort((a, b) => fullText.indexOf(a.text) - fullText.indexOf(b.text));
    return { passages: ordered, chars: fullText.length, empty: ordered.length === 0 };
}

export function renderPassages(ps: Passage[], maxChars = 4000): string {
    let out = '';
    for (const p of ps) {
        const block = `「${p.text}」\n`;
        // 안 들어가는 대목은 건너뛰고 뒤의 짧은 대목을 넣는다(전에는 여기서 멈춰, 첫 대목이 길면 빈 문자열이 나갔다).
        if (out.length + block.length > maxChars) continue;
        out += block;
    }
    // 하나도 안 들어갔으면 첫 대목을 잘라서라도 준다 — 빈 발췌는 "원문이 말하지 않는다"로 읽힌다.
    if (!out && ps.length) out = `「${ps[0]!.text.slice(0, Math.max(0, maxChars - 4))}…」`;
    return out.trim();
}

/** 법령명과 조번호가 원문에 실제로 등장하는지 — 인용 검증의 보조 신호. */
export function mentionsLaw(fullText: string, lawName: string, articleNo: string): boolean {
    const n = normalizeLawName(lawName);
    return fullText.includes(n) && fullText.includes(articleNo);
}
