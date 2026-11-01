// 코퍼스 밖 판례·결정 — 웹에서 가져온다.
//
// precedent-kr 에는 헌법재판소 결정이 한 건도 없다. 헌법 논문에서 헌재 결정을 인용하지 못하면
// 논문이 아니다. 그래서 사건번호가 있으면 웹(헌재 홈페이지·국가법령정보센터·판례 사이트)에서
// 본문을 찾는다. 찾은 것은 **"웹에서 확인"**으로 정직하게 표시된다 — 코퍼스 원문과 같은 등급이
// 아니다. 그래도 "없음"보다는 훨씬 낫다: 모델의 기억이 아니라 실제 결정 요지를 읽고 쓴다.
import { searchWeb } from './search.ts';
import { fetchUrl, htmlToText } from './web.ts';
import { citedCourtIn, courtConflict, decisionCourtIn, fullCourt, parsePrecedentCitation } from './verify.ts';
import type { SourceDoc } from './sources.ts';
import { record } from '../trace.ts';

const PREFERRED_HOSTS = ['law.go.kr', 'ccourt.go.kr', 'scourt.go.kr', 'lbox.kr', 'casenote.kr', 'klaw.go.kr', 'lawnb.com'];

const hostOf = (u: string) => {
    try {
        return new URL(u).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
};

const hostRank = (u: string) => {
    const h = hostOf(u);
    const i = PREFERRED_HOSTS.findIndex((p) => h.endsWith(p));
    return i < 0 ? PREFERRED_HOSTS.length : i;
};

/** 사건번호가 본문에 실제로 등장하는가 — 이게 없으면 다른 사건이다. */
// 뒤에 숫자가 더 붙으면 다른 사건이다 — 2022도145 는 2022도1452 에 포함된다.
const caseRe = (caseNo: string, flags = '') => new RegExp(`${caseNo.replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, flags);
const mentions = (text: string, caseNo: string) => caseRe(caseNo).test(text.replace(/\s+/g, ''));
const mentionCount = (text: string, caseNo: string) => (text.replace(/\s+/g, '').match(caseRe(caseNo, 'g')) ?? []).length;

/** 검색 결과 목록·질문 게시판·"이 결정을 인용하는 판례" 페이지 — 사건번호는 있지만 본문이 아니다. */
const LIST_PAGE = /\/citing\/|kin\.naver|articleList|\/search|[?&]q=|검색결과\s*총|회 인용됨/;
/** 결정·판결 본문의 표지 */
const looksLikeDecision = (t: string) => /【\s*주\s*문\s*】|【\s*이\s*유\s*】|판시사항|결정요지|판결요지|심판대상조항|청구인/.test(t);

/** 결정 본문 후보를 점수로 고른다. 호스트·제목의 사건번호·본문 표지·분량을 본다. */
function scoreHit(h: { url: string; title: string; text: string }, caseNo: string): number {
    if (LIST_PAGE.test(h.url) || LIST_PAGE.test(h.text.slice(0, 600))) return -1;
    const n = mentionCount(h.text, caseNo);
    if (!n && !mentions(h.title, caseNo)) return -1;
    let s = (PREFERRED_HOSTS.length - hostRank(h.url)) * 3;
    if (mentions(h.title, caseNo)) s += 6;
    if (looksLikeDecision(h.text)) s += 5;
    if (h.text.length >= 3000) s += 4;
    else if (h.text.length >= 1500) s += 2;
    s += Math.min(n, 6);
    return s;
}

/**
 * 국가법령정보센터의 사건번호 직접 URL — 검색을 거치지 않는 **결정적** 경로.
 *
 * `https://www.law.go.kr/헌재결정례/(2000헌마25)` · `https://www.law.go.kr/판례/(2008도763)` 은 본문 없는 프레임 페이지를
 * 주고, 그 안의 iframe(`/LSW/detcInfoP.do?detcSeq=…` · `precInfoP.do?precSeq=…`)이 서버 렌더링된 전문이다(2000헌마25: 19,739자).
 * 검색은 헌재 판례집 PDF 의 요지면(4,000자)을 물어와 abstract_only 로 끝나곤 했다 — 연쇄 탐색이 고른 선례 3건이 전부 그랬다.
 * 없는 사건번호면 iframe 이 없다 → null → 검색으로 넘어간다.
 */
async function fetchLawGoKr(caseNo: string, isCC: boolean, opts: { signal?: AbortSignal }, court?: string): Promise<{ url: string; title: string; text: string } | null> {
    const pretty = `https://www.law.go.kr/${isCC ? '헌재결정례' : '판례'}/(${caseNo})`;
    try {
        const res = await fetch(encodeURI(pretty), {
            headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
            redirect: 'follow',
            ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!res.ok) return null;
        const html = await res.text();
        const m = /<iframe[^>]+src="([^"]*(?:detcInfoP|precInfoP)\.do\?[^"]+)"/i.exec(html);
        if (!m) return null;
        const inner = new URL(m[1]!.replace(/&amp;/g, '&'), 'https://www.law.go.kr').toString();
        const d = await fetchUrl(inner, opts);
        if (d.error || !d.text || d.paywall || d.login) return null;
        const text = d.kind === 'html' ? htmlToText(d.text) : d.text;
        if (!mentions(text, caseNo) || !looksLikeDecision(text)) return null;
        // 하급심은 사건번호가 법원마다 겹친다 — 인용한 법원의 판결이어야 한다. 판결문 머리(「<법원> <날짜> 선고 <사건번호>」)의 법원으로 본다:
        // 페이지 어딘가에 법원 이름이 있는지만 보던 때는 그 법원을 원심으로 적은 대법원 판결(【원심판결】 서울고등법원 …)이 통과했다.
        // 머리를 읽지 못하면 예전처럼 이름이 있는지만 본다.
        if (court) {
            const found = decisionCourtIn(text, caseNo);
            if (found ? courtConflict(court, found) : !fullCourt(text).includes(fullCourt(court))) return null;
        }
        const title = /\[[^\]]{0,40}(?:전원재판부|지정재판부|선고)[^\]]{0,100}\]/.exec(text)?.[0]?.replace(/^\[|\]$/g, '') ?? '';
        return { url: pretty, title, text };
    } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw e;
        return null;
    }
}

/** 검색어 — 따옴표로 묶은 사건번호 검색은 인용 목록·게시판만 돌려줬다. 자연어 인용 형태가 결정문 페이지를 찾는다. */
function queriesFor(citation: string, caseNo: string, date: string | undefined, isCC: boolean): string[] {
    const d = date ? date.replace(/-0?(\d+)-0?(\d+)$/, '. $1. $2.').replace(/^(\d{4})\. /, '$1. ') : '';
    const head = isCC ? '헌재' : '대법원';
    return [
        `${head} ${d ? `${d} ` : ''}${caseNo} ${isCC ? '결정' : '판결'} 전문`,
        `${isCC ? '헌법재판소' : '대법원'} ${caseNo} ${isCC ? '결정' : '판결'}`,
        citation.replace(/[⟦⟧]/g, '').slice(0, 80),
    ];
}

/**
 * 인용이 선고한 법원으로 적은 **하급심** — 없으면(대법원·헌법재판소 인용, 법원 없음) undefined. verify.ts citedCourtIn 과 같은 잣대 — 사건번호 앞의 가장 가까운 법원.
 * 맨 앞의 것을 보던 때는 「대법원 판례의 법리를 따른 수원지법 2010. … 2099노7」 의 덧말 「대법원」에 걸려 머리 대조가 돌지 않았다. 사건번호 뒤의 덧말
 * (「(원심: 서울고법 2009노100)」)은 선고한 법원이 아니다. 줄인 이름(「서울고법」「수원지법 성남지원」)도 하급심이다 — 온 이름만 보던 때는 그 인용에서 머리 대조가
 * 돌지 않아 대법원 판결이 그대로 들어왔다. 줄인 이름은 **법원 자리 지명**(서울중앙·수원·대구… + 지법·고법·행법·가법)일 때만 법원이다 — 「…행법」「…지법」 꼴은
 * 법률 이름(「경찰관직무집행법」「민사집행법」「테러방지법」)에도 있고, 날짜 바로 앞일 때만 세던 때는 「서울고법, 2010. …」「서울고법 제1형사부 …」「서울고법(2010. …)」 이
 * 법원 없는 인용이 되어 대법원 판결이 그 판결로 들어왔다.
 */
function citedLowerCourt(citation: string): string | undefined {
    const court = citedCourtIn(citation);
    return court && !/^(?:대법원|헌법재판소|헌재)$/.test(court) ? court : undefined;
}

export interface DecisionHit {
    url: string;
    title: string;
    text: string;
}

/**
 * 사건번호로 결정·판결 본문을 웹에서 찾는다.
 *
 * 반환 상태:
 *   provided (how: web:<host>) — 사건번호가 본문에 있고 분량이 충분하다
 *   abstract_only             — 사건번호는 맞지만 요지 수준의 짧은 글뿐이다
 *   not_found                 — 검색에서 사건번호가 본문에 있는 페이지가 없다
 */
export async function fetchDecision(citation: string, opts: { signal?: AbortSignal } = {}): Promise<SourceDoc> {
    const started = Date.now();
    const parsed = parsePrecedentCitation(citation);
    if (!parsed) return { state: 'not_found', how: 'web', error: '사건번호를 찾지 못함' };
    const caseNo = parsed.caseNo;
    const isCC = parsed.court === '헌법재판소' || /헌[가나다라마바사아자차카타파하]/.test(caseNo);

    let best: (DecisionHit & { score: number }) | null = null;
    const attempts: string[] = [];
    const seen = new Set<string>();
    // 0. 국가법령정보센터 직접 URL — 있으면 검색은 하지 않는다.
    const direct = await fetchLawGoKr(caseNo, isCC, opts, citedLowerCourt(citation));
    if (direct) {
        attempts.push('law.go.kr:direct');
        best = { ...direct, score: 99 };
    } else attempts.push('law.go.kr:direct 없음');
    for (const query of queriesFor(citation, caseNo, parsed.date, isCC)) {
        if (best && best.score >= 20) break; // 결정문 페이지를 이미 잡았다
        try {
            const { results, used } = await searchWeb(query, { count: 8, content: true, ...(opts.signal ? { signal: opts.signal } : {}) });
            attempts.push(`search:${used}`);
            const cands = results
                .filter((r) => r.url && !seen.has(r.url))
                .map((r) => ({ url: r.url, title: r.title ?? '', text: `${r.content ?? ''}\n${r.summary ?? ''}`.trim() }));
            for (const c of cands) {
                seen.add(c.url);
                let s = scoreHit(c, caseNo);
                if (s < 0) continue;
                // 검색 공급자가 준 본문이 짧으면 페이지를 직접 읽는다. law.go.kr 의 결정례·판례 페이지는
                // 서버 렌더링이라 그대로 읽힌다(detcInfoP.do / precInfoP.do).
                if (c.text.length < 1500) {
                    const d = await fetchUrl(c.url, opts);
                    if (!d.error && d.text && !d.paywall && !d.login) {
                        c.text = d.kind === 'html' ? htmlToText(d.text) : d.text;
                        s = scoreHit(c, caseNo);
                        if (s < 0) continue;
                    }
                }
                if (!best || s > best.score) best = { ...c, score: s };
            }
        } catch (e) {
            attempts.push(`search:err ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
        }
    }

    let out: SourceDoc;
    if (!best) {
        out = { state: 'not_found', how: 'web', title: citation, attempts, error: `웹에서 사건번호 ${caseNo} 본문을 찾지 못함` };
    } else {
        const host = hostOf(best.url);
        const text = best.text.slice(0, 120_000);
        out =
            text.length >= 1500 && looksLikeDecision(text)
                ? { state: 'provided', how: `web:${host}`, url: best.url, title: best.title, fullText: text, chars: text.length, attempts }
                : { state: 'abstract_only', how: `web:${host}`, url: best.url, title: best.title, abstractText: text.slice(0, 3000), chars: text.length, attempts };
    }
    record({
        kind: 'acquire',
        name: out.how,
        subject: citation,
        ok: out.state === 'provided',
        ms: Date.now() - started,
        detail: `${out.state}${out.chars ? ` · ${out.chars.toLocaleString()}자` : ''}${out.error ? ` · ${out.error}` : ''}`,
        ...(out.url ? { input: out.url } : {}),
    });
    return out;
}

/** 판례 페이지 URL 을 직접 읽는다. 사건번호가 있으면 본문에 그것이 등장해야 "그 사건"으로 인정한다. */
export async function fetchDecisionUrl(url: string, caseNo?: string, opts: { signal?: AbortSignal } = {}): Promise<SourceDoc> {
    const started = Date.now();
    const d = await fetchUrl(url, opts);
    let out: SourceDoc;
    if (d.error) out = { state: 'error', how: 'web', url, error: d.error };
    else if (d.paywall) out = { state: 'paywalled', how: 'web', url };
    else if (d.login) out = { state: 'login_required', how: 'web', url };
    else {
        const text = (d.kind === 'html' ? htmlToText(d.text) : d.text).slice(0, 120_000);
        const looksLikeCase = /판시사항|판결요지|주\s*문|이\s*유|결정요지|심판대상/.test(text);
        if (caseNo && !mentions(text, caseNo)) out = { state: 'not_found', how: 'web', url, error: `페이지에 사건번호 ${caseNo} 가 없음` };
        else if (text.length >= 1500 && looksLikeCase) out = { state: 'provided', how: `web:${hostOf(url)}`, url, fullText: text, chars: text.length };
        else if (text.length >= 200) out = { state: 'abstract_only', how: `web:${hostOf(url)}`, url, abstractText: text.slice(0, 3000), chars: text.length };
        else out = { state: 'metadata_only', how: `web:${hostOf(url)}`, url, chars: text.length };
    }
    record({ kind: 'acquire', name: out.how, subject: url.slice(0, 80), ok: out.state === 'provided', ms: Date.now() - started, detail: `${out.state}${out.chars ? ` · ${out.chars.toLocaleString()}자` : ''}${out.error ? ` · ${out.error}` : ''}`, input: url });
    return out;
}

/**
 * 사건번호 없이 언급된 결정·판결을 찾는다 — "헌법재판소는 2007년 참정권 영역에서 …" 처럼.
 *
 * 필자는 대개 사건번호를 모른다. 그런데 사건번호가 없으면 원문을 못 가져오고, 원문이 없으면
 * 집필 모델은 "2007년 결정"이라고만 쓰고 넘어간다(실제로 그랬다). 언급 문장을 검색어로 던져
 * 결과 본문에서 가장 자주 나오는 사건번호를 고르고, 그 번호로 본문을 가져온다.
 */
export async function discoverDecisions(
    text: string,
    opts: { signal?: AbortSignal; max?: number } = {},
): Promise<{ caseNo: string; court: '헌법재판소' | '대법원'; doc: SourceDoc; citation: string }[]> {
    const out: { caseNo: string; court: '헌법재판소' | '대법원'; doc: SourceDoc; citation: string }[] = [];
    const seen = new Set<string>();
    const known = new Set((text.match(/\d{4}\s*(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+/g) ?? []).map((s) => s.replace(/\s+/g, '')));
    const re = /(헌법재판소|헌재|대법원)[^.。\n]{0,60}?(19|20)\d{2}\s*년/g;
    const phrases: { court: '헌법재판소' | '대법원'; q: string; year: string }[] = [];
    for (const m of text.matchAll(re)) {
        const at = m.index ?? 0;
        const window = text.slice(Math.max(0, at - 20), Math.min(text.length, at + m[0].length + 80)).replace(/\s+/g, ' ');
        const court = m[1] === '대법원' ? '대법원' : '헌법재판소';
        const year = (/(19|20)\d{2}(?=\s*년)/.exec(m[0]) ?? [''])[0];
        // 이미 사건번호가 같이 적혀 있으면 찾을 필요가 없다.
        if ([...known].some((k) => window.includes(k))) continue;
        phrases.push({ court, q: `${window} 사건번호`, year });
        if (phrases.length >= (opts.max ?? 3)) break;
    }
    for (const p of phrases) {
        try {
            const { results } = await searchWeb(p.q, { count: 6, content: true, ...(opts.signal ? { signal: opts.signal } : {}) });
            const counts = new Map<string, number>();
            const pattern = p.court === '헌법재판소' ? /\d{4}헌[가나다라마바사아자차카타파하]\d+/g : /\d{4}(?:도|다|두|모|마|누)\d+/g;
            for (const r of results) {
                for (const n of `${r.title ?? ''}\n${r.content ?? ''}\n${r.summary ?? ''}`.replace(/\s+/g, '').match(pattern) ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
            }
            const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
            for (const [caseNo, n] of top) {
                if (n < 2 || seen.has(caseNo)) continue;
                seen.add(caseNo);
                const doc = await fetchDecision(`${p.court} ${caseNo} ${p.court === '헌법재판소' ? '결정' : '판결'}`, opts);
                if (!doc.fullText && !doc.abstractText) continue;
                // 정식 인용 — 제목·본문에서 선고일을 찾는다. 없으면 사건번호만.
                const head = `${doc.title ?? ''}\n${(doc.fullText ?? doc.abstractText ?? '').slice(0, 600)}`;
                const dm = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(?:자|선고)?\s*(?=[^\d]{0,30}\d{4}[가-힣]{1,3}\d+)/.exec(head) ?? /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(head);
                const date = dm ? `${dm[1]}. ${Number(dm[2])}. ${Number(dm[3])}.` : '';
                // 문장이 말한 연도("2007년")와 선고 연도가 다르면 다른 사건이다. 빈도 1위라도 버린다 —
                // 실제로 "2007년 참정권" 문장에 2000헌바20·2008헌가22 가 올라왔다.
                if (p.year && dm && dm[1] !== p.year) continue;
                if (p.year && !dm) continue;
                const citation = p.court === '헌법재판소' ? `헌법재판소 ${date ? `${date} ` : ''}선고 ${caseNo} 결정`.replace(/\s+선고/, date ? ' 선고' : ' 선고') : `대법원 ${date ? `${date} ` : ''}선고 ${caseNo} 판결`;
                out.push({ caseNo, court: p.court, doc, citation: citation.replace(/\s{2,}/g, ' ') });
            }
        } catch {
            /* 검색 실패는 조사 실패가 아니다 — 그 문장만 못 찾은 것이다 */
        }
    }
    record({ kind: 'acquire', name: 'discover-decisions', subject: `언급된 결정 ${phrases.length}건`, ok: out.length > 0, ms: 0, detail: out.map((o) => o.citation).join(' · ').slice(0, 300) });
    return out;
}
