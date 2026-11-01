// 조사(research). 논문을 쓰기 전에 **세상에 대해 아는 것을 늘리는** 단계.
//
// 왜 필요했나: 이 파이프라인은 조사를 하지 않았다. 웹 검색 호출이 0건이었고, 사용자가 준
// 맥락의 URL 은 프롬프트에 붙여넣기만 했고, 문헌 탐색은 쟁점 문장을 그대로 OpenAlex 에 던져
// 한국 주제에서 0건을 받았다. 그래서 나온 것은 "모델이 이미 아는 것 중 검증 가능한 인용"의
// 조립 — 논문이 아니라 그럴듯한 조립물이었다.
//
// 이 단계가 하는 일:
//   1) 맥락에서 **단서**를 뽑는다 — URL, 「」 제목, 사건번호, 고유명사(NexfundAI 같은), 연도
//   2) 단서의 URL 을 직접 가져온다
//   3) 백과(Wikipedia)로 배경을 확인하고 **원문 문장을 인용 가능한 형태로** 남긴다
//   4) Crossref/OpenAlex 로 문헌을 찾는다(열린 원문이 없어도 서지·초록은 남긴다)
//   5) 모든 발견을 스크래치패드에 파일로 떨어뜨린다 — 워커가 인용하면 그 파일이 근거가 된다
//
// 원칙: 발견은 **출처와 인용문**을 함께 가진다. 출처 없는 문장은 발견이 아니라 모델의 기억이다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchUrl, htmlToText } from './web.ts';
import { record } from '../trace.ts';
import { COMMON } from '../prompts.ts';
import { KciTermList, QueryList } from '../schemas.ts';
import { searchWeb } from './search.ts';
import { kciCitation, kciSearch, kciTokens, normTitle } from './kci.ts';

export type FindingKind = 'fact' | 'doctrine' | 'case' | 'statute' | 'news';
/** 어디서 왔나 — 필자가 준 링크, 웹 검색, 백과, KCI, Crossref. 감사·화면 표시용. */
export type FindingSource = 'url' | 'web' | 'wiki' | 'kci' | 'crossref';

/** 조사 한 번에 던진 검색 하나 — 무엇을 어디에 물었고 몇 건이 남았나. 0건도 남긴다(찾았는데 없었다는 것도 기록이다). */
export interface ResearchSearch {
    source: FindingSource;
    q: string;
    /** 모델이 정한 각도(fact·law·ruling·scholarship·critique) */
    angle?: string;
    /** 웹 검색이면 답한 공급자 */
    provider?: string;
    /** 검색이 돌려준 수(웹·Crossref 는 공급자가 준 건수, KCI 는 용어별 결과의 합 — 관련도로 거르기 전). 백과·실패한 검색은 없음 */
    results?: number;
    /** 걸러진 뒤 자료로 남은 수 */
    kept: number;
    /** 검색 자체가 실패했다(공급자 오류·HTTP 503·키 없음) — 「찾았는데 없었다」(results: 0)와 다르다. */
    error?: string;
}

/** 검색 하나의 실패 이유를 받아 오는 자리. 결과(Finding[])와 따로 둔다 — 실패도 0건도 빈 배열이라 배열만으로는 가를 수 없다. */
interface SearchStatus {
    error?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export interface Finding {
    id: string;
    kind: FindingKind;
    /** 출처 신뢰도 0~4 (검색 API 가 주는 값). 낮으면 근거로 쓰지 않는다. */
    authority?: number;
    /** 인용 가능한 형태의 제목/출처 */
    citation: string;
    /** 이 발견이 말하는 것 (한두 문장) */
    summary: string;
    /** 원문에서 그대로 뽑은 문장 */
    quote?: string;
    url?: string;
    fetchedAt: string;
    source?: FindingSource;
    /** 이 자료를 낳은 검색어(웹·KCI·Crossref·백과) */
    query?: string;
    /** 웹 검색이면 답한 공급자 */
    provider?: string;
}

export interface Dossier {
    topic: string;
    /** 맥락에서 뽑은 단서(링크·고유명사). 실제로 던진 검색어는 searches 에 있다. */
    queries: string[];
    findings: Finding[];
    fetched: { url: string; ok: boolean; chars?: number; error?: string }[];
    searches?: ResearchSearch[];
    /** 조사 방식의 버전. 소스(예: KCI)를 추가하면 올린다 — 오래된 캐시를 자동으로 버린다. */
    v?: string;
}

/** 조사 소스가 바뀌면 올린다. app 의 dossier 캐시가 이 값과 다르면 다시 조사한다. */
export const RESEARCH_VERSION = 'kci-1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 맥락에서 단서를 뽑는다. 결정적이다 — 모델에게 "단서를 찾아라"고 하면 그건 조사가 아니다. */
export function clues(text: string): { urls: string[]; titles: string[]; caseNos: string[]; entities: string[]; years: string[] } {
    const urls = [...new Set((text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? []).map((u) => u.replace(/[.,;]$/, '')))];
    const titles = [...new Set([...text.matchAll(/[「『"“]([^」』"”]{4,80})[」』"”]/g)].map((m) => m[1]!.trim()))];
    const caseNos = [...new Set(text.match(/\d{4}\s*(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+/g) ?? [])].map((s) => s.replace(/\s+/g, ''));
    const years = [...new Set(text.match(/\b(19|20)\d{2}년?/g) ?? [])];
    // 고유명사: 라틴 약어/브랜드(대문자 포함) + 한글 고유명사 후보(조사 없는 3~12자 명사구)
    const latin = [...text.matchAll(/\b[A-Z][A-Za-z0-9-]{2,}\b/g)].map((m) => m[0]);
    // 한글 고유명사 후보는 정밀도가 낮았다("법집행"·"아동청소년성보호"가 뽑혔다). 백과 검색에
    // 쓰면 엉뚱한 문서를 물어온다. 라틴 고유명사와 「」 제목만 단서로 쓴다.
    const STOP = new Set(['USA', 'The', 'AND', 'For', 'Nex']);
    const entities = [...new Set([...latin, ...titles])].filter((e) => e.length >= 3 && !STOP.has(e)).slice(0, 8);
    return { urls, titles, caseNos, entities, years };
}

export interface WebHit {
    title: string;
    url: string;
    snippet: string;
    /** 모델이 읽도록 만든 긴 요약 (600~800자) */
    summary?: string;
    /** 본문 (need_content=true 일 때) */
    content?: string;
    siteName?: string;
    date?: string;
    authority?: number;
    score?: number;
    provider?: string;
}

/** 검색 공급자 계층에 위임한다. 공급자 선택·폴백은 search.ts 가 맡는다. */
export async function webSearch(query: string, opts: { limit?: number; signal?: AbortSignal; status?: SearchStatus } = {}): Promise<WebHit[]> {
    const { results, used } = await searchWeb(query, { count: opts.limit ?? 5, content: true, ...(opts.signal ? { signal: opts.signal } : {}) });
    // 쓸 수 있는 공급자가 없거나 전부 오류였으면 실패다("ddg:err,brave:err", "none"). 하나라도 0건으로 답했으면 「없었다」.
    if (!results.length && opts.status && (used === 'none' || used.split(',').every((x) => x.endsWith(':err')))) opts.status.error = `검색 실패(${used})`;
    return results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.content ? { content: r.content } : {}),
        ...(r.siteName ? { siteName: r.siteName } : {}),
        ...(r.date ? { date: r.date } : {}),
        ...(r.authority !== undefined ? { authority: r.authority } : {}),
        ...(r.score !== undefined ? { score: r.score } : {}),
        ...(r.provider ? { provider: r.provider } : {}),
    }));
}


/**
 * 웹 결과의 제목을 인용에 쓸 수 있는 형태로. 검색 공급자가 PDF·표에서 뽑은 "제목"은
 * `<table><tr>…` 이거나 문장 한 토막인 경우가 많다 — 그대로 각주에 들어가면 쓰레기다.
 */
/** 각주용 서지: "제목 (기관) <url>". 기관은 제목에 이미 들어 있으면 붙이지 않고, '홈페이지'는 뗀다. " :: " 는 서지 표기가 아니다. */
export function webCitation(title: string, siteName: string | undefined, url: string): string {
    const t = citeTitle(title, siteName, url);
    const site = (siteName ?? '').replace(/\s*(?:홈페이지|누리집|공식 ?사이트)$/, '').trim();
    return `${site && !t.includes(site) ? `${t} (${site})` : t} <${url}>`;
}

export function citeTitle(title: string, siteName: string | undefined, url: string): string {
    const host = (() => {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    })();
    let t = (title ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:질의제목|제목|Title)\s*[:：]\s*/, '')
        // 정부 누리집 공통 배너가 제목에 딸려 온다
        .replace(/\s*[-–|]?\s*이 누리집은 대한민국 공식 전자정부 누리집입니다\.?/g, '')
        .replace(/\s*[-–|]\s*$/, '')
        .trim();
    // 포털 제목의 내비게이션 찌꺼기 — "가족관계업무 상세보기|자주 묻는 질문 - 바로가기 메뉴 본문 바로가기 :: 외교부".
    // '::' '|' 로 나눠 메뉴·바로가기 조각을 버리고, 기관명은 끝에 한 번만 둔다.
    if (/::|\|/.test(t)) {
        const parts = t.split(/\s*(?:::|\|)\s*/).map((p) => p.replace(/\s*-\s*(?:바로가기|메뉴|본문)[^-]*$/g, '').replace(/^질의제목\s*:\s*/, '').replace(/\s*상세보기$/, '').trim()).filter(Boolean);
        const body = parts.filter((p) => !/바로가기|메뉴|홈페이지$|^자주 묻는 질문$/.test(p) && p.length > 1);
        const site = (siteName ?? '').replace(/\s*홈페이지$/, '').trim();
        // 기관은 siteName 과 같은 조각, 아니면 짧은 "○○부·○○청·○○원" 꼴. 제목은 기관이 아닌 조각 중 **가장 긴 것** —
        // "보도자료 | 제목 | 기관" 처럼 앞에 분류어가 오는 포털이 많다.
        // siteName 이 없으면 **마지막** 조각만 기관 후보다("제목 | 기관"). 첫 조각을 보면 "…지원 | 외교부" 의 제목이 기관이 된다.
        const last = parts[parts.length - 1];
        const org =
            parts.find((p) => site && (p === site || p.replace(/\s*홈페이지$/, '') === site)) ??
            (parts.length > 1 && last && /홈페이지$|부$|청$|원$|처$|위원회$|시$|도$|군$|구$|공단$|공사$/.test(last) && last.length <= 12 ? last : undefined);
        const main = body.filter((p) => p !== org).sort((a, b) => b.length - a.length);
        t = main.length ? `${main[0]}${org && org !== main[0] ? ` (${org.replace(/\s*홈페이지$/, '')})` : ''}` : (org ?? t);
    }
    const spacedLetters = /(?:[가-힣] ){3,}/.test(t); // "보 도 자 료" — PDF 추출 잔해
    const htmlish = /^\s*</.test(title ?? '') || /&lt;|&gt;/.test(t);
    // PDF·첨부파일 링크의 "제목"은 본문 첫 줄인 경우가 많다 — 쉼표·어미로 끝나는 문장 조각이면 제목이 아니다.
    const fileLike = /\.pdf(?:[#?]|$)|FileDown|FileGate|Download\.do|fileDown|download\.do|boardDown|fileLink|Down\.do|\/download\//i.test(url);
    // "1 주민등록대상자" — 첨부파일 본문의 번호 매긴 첫 줄
    const numberedFragment = /^\d{1,2}[.)]?\s+\S/.test(t) && t.length < 30;
    const sentenceLike = /[,，]|[다요음함]\s*\.?$|^(?:먼저|또한|그리고|따라서)\s/.test(t) || !/\s/.test(t);
    if (!t || htmlish || spacedLetters || t.length > 90 || (fileLike && (sentenceLike || numberedFragment || t.length > 40))) {
        const label = siteName?.trim() || host || '공개자료';
        const date = t.match(/(19|20)\d{2}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}/)?.[0]?.replace(/\s+/g, '');
        return `${label} 공개자료${fileLike ? ' (PDF)' : ''}${date ? ` (${date})` : ''}`;
    }
    return t;
}

const QUERY_SYSTEM = `너는 한국 법학 논문의 조사 담당이다. 주제를 주면 **검색어**를 만든다.

규칙:
- 검색어는 검색엔진에 그대로 넣을 수 있는 짧은 구(6~25자). 주제 문장을 그대로 쓰지 않는다.
- 각도마다 하나씩, 서로 다른 것을 찾도록 만든다:
  fact       — 사건·사실관계·당사자·연도 ("넥스펀드AI 위장수사")
  law        — 근거 법령·조문·제도 ("정보통신망법 제48조 접근권한")
  ruling     — 판례·결정 ("위장수사 함정수사 대법원")
  scholarship— 학술 논의 ("위장수사 허용범위 논문")
  critique   — 반대 논거·비판 ("위장수사 인권 침해 비판")
- 이미 아는 것을 확인하는 검색어가 아니라, **모르는 것을 찾는** 검색어를 만든다.
- 주제에 고유명사가 있으면 그대로 쓴다(번역하지 않는다).`;

export async function planQueries(
    topic: string,
    context: string,
    ask: <T>(schema: unknown, opts: { name: string; description: string; system: string; user: string }) => Promise<T>,
): Promise<{ q: string; angle: string }[]> {
    try {
        const out = await ask<{ queries: { q: string; angle: string }[] }>(QueryList, {
            name: 'search_queries',
            description: '주제를 조사하기 위한 검색어를 각도별로 만든다',
            system: QUERY_SYSTEM,
            user: [`## 주제\n${topic}`, ...(context.trim() ? ['', `## 맥락\n${context.trim()}`] : [])].join('\n'),
        });
        const qs = (out.queries ?? []).filter((x) => x.q?.trim()).slice(0, 6);
        record({ kind: 'acquire', name: 'query-plan', subject: topic.slice(0, 44), ok: qs.length > 0, detail: qs.map((x) => x.q).join(' | ').slice(0, 260) });
        return qs;
    } catch (e) {
        record({ kind: 'acquire', name: 'query-plan', subject: topic.slice(0, 44), ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
        return [];
    }
}

/** 문장 단위로 자르고, 검색어가 걸린 문장만 고른다. */
function sentences(text: string): string[] {
    return text
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?。])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 30 && s.length <= 400);
}

async function wikipedia(query: string, signal?: AbortSignal, lang: 'ko' | 'en' = 'ko', status?: SearchStatus): Promise<Finding[]> {
    const out: Finding[] = [];
    const host = lang === 'ko' ? 'ko.wikipedia.org' : 'en.wikipedia.org';
    const citeName = lang === 'ko' ? '위키백과' : 'Wikipedia';
    try {
        const s = await fetch(
            `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=2&format=json&origin=*`,
            { signal, headers: { 'user-agent': 'nenene' } },
        );
        if (!s.ok) {
            if (status) status.error = `HTTP ${s.status}`;
            return out;
        }
        const sj: any = await s.json();
        for (const hit of (sj?.query?.search ?? []).slice(0, 2)) {
            const title: string = hit.title;
            const e = await fetch(
                `https://${host}/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*&redirects=1`,
                { signal, headers: { 'user-agent': 'nenene' } },
            );
            if (!e.ok) continue;
            const ej: any = await e.json();
            const pages = ej?.query?.pages ?? {};
            const page: any = Object.values(pages)[0];
            const text: string = page?.extract ?? '';
            if (!text) continue;
            const paras = text.split('\n').filter((p: string) => p.trim().length > 60).slice(0, 6);
            for (const p of paras) {
                const sents = sentences(p);
                const pick = sents.slice(0, 2).join(' ');
                if (!pick) continue;
                out.push({
                    id: `wiki-${title}-${out.length}`,
                    kind: 'fact',
                    authority: 2,
                    citation: `${citeName}, 「${title}」`,
                    summary: pick.slice(0, 240),
                    quote: pick,
                    url: `https://${host}/wiki/${encodeURIComponent(title)}`,
                    fetchedAt: new Date().toISOString(),
                });
                if (out.length >= 6) return out;
            }
        }
    } catch (e) {
        /* 백과를 못 쓰면 조사가 실패한 게 아니라 그 출처를 못 쓴 것이다 — 그래도 기록에는 남긴다 */
        if (status) status.error = errText(e);
    }
    return out;
}

async function crossref(query: string, signal?: AbortSignal, status?: SearchStatus): Promise<Finding[]> {
    const out: Finding[] = [];
    try {
        const res = await fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=4`, {
            signal,
            headers: { 'user-agent': 'nenene (mailto:none@example.com)' },
        });
        if (!res.ok) {
            if (status) status.error = `HTTP ${res.status}`;
            return out;
        }
        const j: any = await res.json();
        for (const it of j?.message?.items ?? []) {
            const title = (it.title ?? [])[0];
            if (!title) continue;
            const authors = (it.author ?? []).slice(0, 3).map((a: any) => a.family ?? a.name ?? '').filter(Boolean).join('·') || '저자 미상';
            const year = it.issued?.['date-parts']?.[0]?.[0];
            out.push({
                id: `crossref-${it.DOI ?? out.length}`,
                kind: 'doctrine',
                authority: 3,
                citation: `${authors}, 「${title}」${year ? `, ${year}` : ''}`,
                summary: `서지 확인 — ${it['container-title']?.[0] ?? '학술지 미상'}${it.DOI ? ` · DOI ${it.DOI}` : ''}`,
                ...(it.DOI ? { url: `https://doi.org/${it.DOI}` } : {}),
                fetchedAt: new Date().toISOString(),
            });
            if (out.length >= 4) break;
        }
    } catch (e) {
        if (status) status.error = errText(e);
    }
    return out;
}

/**
 * KCI — 한국 학술지 문헌. OpenAlex·Crossref 가 비어 있는 자리를 채운다.
 *
 * KCI 검색은 **단일 용어**에서 정확하다("안면인식" 73건, "안면인증" 2건). 그래서 모델이
 * KCI 용어를 만들고(KCI_TERM_PROMPT), 용어별로 검색해 관련도로 합친다.
 * 조사 단계는 서지·초록만 쓴다(빠르게 넓게). 인용된 문헌의 전문은 인용 확보 단계의 사다리가 KCI 원문 내려받기로 받는다.
 */
const KCI_TERM_PROMPT = `${COMMON}

과제: 주제와 배경을 보고 **KCI(한국학술지인용색인) 검색어** 3~5개를 만든다.

규칙:
- 한 단어 또는 붙여 쓴 복합명사로 쓴다("생체정보", "안면인식", "본인확인"). KCI 키워드 검색은
  띄어 쓴 긴 구를 잘 못 찾는다.
- 주제에 쓴 말을 그대로 옮기지 말고, **한국 법학 문헌이 실제로 쓰는 동의어**로 바꾼다
  (예: "안면인증" → "안면인식"·"생체인식정보", "휴대폰 개통" → "본인확인").
- 법적 쟁점어를 포함한다("개인정보자기결정권", "위임입법", "과잉금지", "평등권" 등).
- 서로 다른 각도(기술·규제·권리·판례)를 덮게 한다.`;

type AskFn = <T>(schema: unknown, o: { name: string; description: string; system: string; user: string }) => Promise<T>;

async function kciTermsFor(topic: string, context: string, ask: AskFn): Promise<string[]> {
    try {
        const out = await ask<{ terms: string[] }>(KciTermList, {
            name: 'kci_terms',
            description: 'KCI(한국학술지) 검색용 핵심어를 만든다',
            system: KCI_TERM_PROMPT,
            user: [`## 주제\n${topic}`, ...(context.trim() ? ['', `## 배경\n${context.trim().slice(0, 1500)}`] : [])].join('\n'),
        });
        return out.terms.map((t) => t.trim()).filter(Boolean).slice(0, 5);
    } catch {
        return [];
    }
}

/** 마지막 kci() 가 받은 검색 결과 수(용어별 결과의 합, 관련도로 거르기 전) — 조사 기록의 「결과」. */
let kciRaw = 0;
async function kci(terms: string[], signal?: AbortSignal, status?: SearchStatus): Promise<Finding[]> {
    const out: Finding[] = [];
    const seen = new Set<string>();
    let rawHits = 0;
    kciRaw = 0;
    try {
        const pool = new Map<string, { a: import('./kci.ts').KciArticle; score: number }>();
        const failed: string[] = [];
        for (const term of terms.slice(0, 5)) {
            const r = await kciSearch({ keyword: term, displayCount: 5 }, { ...(signal ? { signal } : {}) });
            if (r.error && !r.articles.length) failed.push(r.error);
            rawHits += r.articles.length;
            for (const a of r.articles) {
                const hay = normTitle(`${a.title} ${(a.keywords ?? []).join(' ')}`);
                // 이 용어가 제목·키워드에 있는 것만. 여러 용어에 걸리면 더 관련 있다.
                if (!hay.includes(normTitle(term))) continue;
                const cur = pool.get(a.id);
                const score = (cur?.score ?? 0) + 1;
                pool.set(a.id, { a, score });
            }
        }
        const arts = [...pool.values()].sort((x, y) => y.score - x.score).map((x) => x.a);
        kciRaw = rawHits;
        // 용어 검색이 전부 실패했으면 실패다. 일부만 실패했으면 받은 것으로 진행한다.
        if (status && failed.length && failed.length === Math.min(terms.length, 5)) status.error = failed[0]!.slice(0, 120);
        for (const a of arts) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
            const bibliography = `KCI ${a.kciRegistration ?? ''} · ${a.journal ?? '학술지 미상'} ${a.volume ?? ''}${a.issue ? `(${a.issue})` : ''} ${a.year ?? ''}${a.doi ? ` · DOI ${a.doi}` : ''}`
                .replace(/\s+/g, ' ')
                .trim();
            out.push({
                id: `kci-${a.id}`,
                kind: 'doctrine',
                authority: 3,
                citation: kciCitation(a),
                summary: bibliography,
                ...(a.url ? { url: a.url } : {}),
                ...(a.abstract ? { quote: a.abstract.slice(0, 800) } : {}),
                fetchedAt: new Date().toISOString(),
            });
            if (out.length >= 4) break;
        }
    } catch (e) {
        /* KCI를 못 쓰면 조사가 실패한 게 아니라 그 출처를 못 쓴 것이다 — 그래도 기록에는 남긴다 */
        if (status) status.error = errText(e);
    }
    return out;
}

/** 발견을 스크래치패드에 파일로 떨어뜨린다. 워커가 인용하면 이 파일이 근거가 된다. */
function persist(findings: Finding[], scratch: string): void {
    if (!findings.length) return;
    try {
        mkdirSync(scratch, { recursive: true });
        const byKind = new Map<string, Finding[]>();
        for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
        for (const [kind, list] of byKind) {
            const body = list
                .map((f) => `## ${f.citation}\n${f.url ?? ''} (authority ${f.authority ?? 2})\n\n${f.quote ?? f.summary}\n`)
                .join('\n');
            writeFileSync(
                join(scratch, `research-${kind}.md`),
                // 표지(fetched_by)를 맨 앞에 둔다 — 긴 제목 줄 뒤에 두면 앞부분만 보는 검사가 놓친다(sources.ts 는 이제 머리 전체를 본다).
                `---\nfetched_by: research\ncitation: 조사 노트 (${kind})\ntitle: ${list[0]!.citation.replace(/\n/g, ' ')}\nfetched_at: ${new Date().toISOString()}\n---\n\n${body}`,
            );
        }
    } catch {
        /* 저장 실패가 조사를 무효로 만들지 않는다 */
    }
}

/**
 * 조사 실행.
 *
 * @param topic   주제
 * @param context 필자가 준 맥락 (URL·사건번호·고유명사 단서가 여기 있다)
 */
export async function research(
    topic: string,
    context = '',
    opts: {
        scratch?: string;
        signal?: AbortSignal;
        /** 있으면 검색어를 모델이 만든다. 없으면 결정적 단서로 대체한다. */
        ask?: <T>(schema: unknown, o: { name: string; description: string; system: string; user: string }) => Promise<T>;
    } = {},
): Promise<Dossier> {
    const started = Date.now();
    const c = clues(`${topic}\n${context}`);
    const findings: Finding[] = [];
    const fetched: Dossier['fetched'] = [];
    const searches: ResearchSearch[] = [];

    // 1) 단서 URL 직접 가져오기 — 사용자가 준 링크를 읽지 않는 것은 조사가 아니다.
    for (const url of c.urls.slice(0, 4)) {
        const d = await fetchUrl(url, { signal: opts.signal });
        // 404·차단 페이지를 "발견"으로 기록하면 조사가 오염된다. 실패는 실패로 남긴다.
        const bad = Boolean(d.error) || d.status >= 400 || /Page Not Found|404 Not Found|Access Denied/i.test(d.text.slice(0, 400));
        fetched.push({ url, ok: !bad && Boolean(d.text), ...(d.text ? { chars: d.text.length } : {}), ...(d.error ? { error: d.error } : d.status >= 400 ? { error: `HTTP ${d.status}` } : {}) });
        if (bad || !d.text) continue;
        const text = d.kind === 'html' ? htmlToText(d.text) : d.text;
        const sents = sentences(text).slice(0, 6);
        if (sents.length) {
            findings.push({
                id: `url-${findings.length}`,
                kind: 'fact',
                citation: `공개 자료, <${url}>`,
                summary: sents[0]!.slice(0, 240),
                quote: sents.slice(0, 3).join(' '),
                url,
                fetchedAt: new Date().toISOString(),
            });
        }
        await sleep(150);
    }

    // 1.5) 웹 검색 — 뉴스·공개자료·기관 페이지. 백과·서지가 못 잡는 사실관계가 여기 있다.
    //
    // 검색어는 **모델이 만든다.** 주제 문장을 그대로 던지면 검색엔진은 그 문장과 비슷한
    // 문서를 찾지 못한다(실제로 "…의 형사법적 정당성과 국내법제의 시사점"을 그대로 넣었다).
    const planned = opts.ask ? await planQueries(topic, context, opts.ask) : [];
    const queries = planned.length ? [...new Set(planned.map((p) => p.q))] : [topic, ...c.entities.slice(0, 3)].slice(0, 4);
    if (planned.length) record({ kind: 'acquire', name: 'query-plan', subject: topic.slice(0, 50), ok: true, detail: planned.map((p) => `${p.angle}:${p.q}`).join(' · ').slice(0, 300) });
    const terms = new Set(queries.flatMap((q) => (q.toLowerCase().match(/[가-힣]{2,}|[a-z]{3,}/g) ?? []).map((t) => t)));
    for (const q of queries) {
        const st: SearchStatus = {};
        const hits = await webSearch(q, { limit: 4, signal: opts.signal, status: st });
        const before = findings.length;
        const tag = { source: 'web' as const, query: q, ...(hits[0]?.provider ? { provider: hits[0].provider } : {}) };
        for (const h of hits) {
            if (c.urls.includes(h.url)) continue;
            // 딥시크는 본문·요약을 이미 줬다. 페이지를 다시 가져올 필요가 없다.
            if (h.summary && h.summary.length > 120) {
                const sents = sentences(`${h.summary} ${h.content ?? ''}`).slice(0, 2);
                findings.push({
                    id: `web-${findings.length}`,
                    kind: 'news',
                    ...(h.authority !== undefined ? { authority: h.authority } : {}),
                    citation: webCitation(h.title, h.siteName, h.url),
                    summary: h.snippet || h.summary.slice(0, 240),
                    quote: (sents.join(' ') || h.summary).slice(0, 600),
                    url: h.url,
                    fetchedAt: new Date().toISOString(),
                    ...tag,
                });
                if (findings.length >= 12) break;
                continue;
            }
            const d = await fetchUrl(h.url, { signal: opts.signal });
            const bad = Boolean(d.error) || d.status >= 400 || /Page Not Found|404 Not Found|Access Denied/i.test(d.text.slice(0, 400));
            fetched.push({ url: h.url, ok: !bad && Boolean(d.text), ...(d.text ? { chars: d.text.length } : {}), ...(bad ? { error: d.error ?? `HTTP ${d.status}` } : {}) });
            if (bad || !d.text) continue;
            const text = d.kind === 'html' ? htmlToText(d.text) : d.text;
            // 질의어가 실제로 걸린 문장만 남긴다 — 아무 문장이나 담으면 발견이 아니라 잡음이다.
            const sents = sentences(text).filter((x) => {
                const low = x.toLowerCase();
                return [...terms].filter((t) => t.length >= 2 && low.includes(t)).length >= 2;
            });
            if (!sents.length) continue;
            findings.push({
                id: `web-${findings.length}`,
                kind: 'news',
                ...(h.authority !== undefined ? { authority: h.authority } : {}),
                citation: webCitation(h.title, h.siteName, h.url),
                summary: (h.snippet || sents[0]!).slice(0, 240),
                quote: sents.slice(0, 2).join(' '),
                url: h.url,
                fetchedAt: new Date().toISOString(),
                ...tag,
            });
            if (findings.length >= 12) break;
            await sleep(150);
        }
        const angle = planned.find((p) => p.q === q)?.angle;
        searches.push({ source: 'web', q, ...(angle ? { angle } : {}), ...(tag.provider ? { provider: tag.provider } : {}), ...(st.error ? { error: st.error } : { results: hits.length }), kept: findings.length - before });
        if (findings.length >= 12) break;
    }

    // 2) 백과로 배경 확인 — 고유명사부터. 한국 주제에서 문헌 API 가 비어도 여기는 채워진다.
    for (const e of c.entities.slice(0, 4)) {
        const st: SearchStatus = {};
        let got = await wikipedia(e, opts.signal, 'ko', st);
        // 한국어 백과에 없으면 영어로. 고유명사(NexfundAI 같은 것)는 그쪽에만 있는 경우가 많다.
        if (!got.length && /^[A-Za-z]/.test(e)) {
            const en: SearchStatus = {};
            got = await wikipedia(e, opts.signal, 'en', en);
            // 영어 백과가 답했으면(0건이어도) 한국어 쪽의 실패는 지난 일이다.
            st.error = st.error && en.error ? st.error : undefined;
        }
        const before = findings.length;
        for (const f of got) {
            if (!findings.some((x) => x.citation === f.citation)) findings.push({ ...f, query: e });
        }
        searches.push({ source: 'wiki', q: e, kept: findings.length - before, ...(st.error ? { error: st.error } : {}) });
        if (findings.length >= 10) break;
    }
    if (!findings.some((f) => f.kind === 'fact')) {
        const st: SearchStatus = {};
        const got = await wikipedia(topic, opts.signal, 'ko', st);
        const before = findings.length;
        for (const f of got) {
            if (!findings.some((x) => x.citation === f.citation)) findings.push({ ...f, query: topic });
        }
        searches.push({ source: 'wiki', q: topic, kept: findings.length - before, ...(st.error ? { error: st.error } : {}) });
    }

    // 3) 문헌 — 열린 원문이 없어도 서지는 남긴다. "찾았다"와 "읽었다"는 다르다.
    //    한국어 주제는 KCI가 먼저다 — OpenAlex·Crossref 는 한국 학술지를 거의 담지 않는다.
    // KCI — 모델이 만든 KCI용 핵심어로 검색한다. 주제 문장을 그대로 넣으면 0건이다.
    const kciWords = opts.ask ? await kciTermsFor(topic, context, opts.ask) : [];
    const words = kciWords.length ? kciWords : kciTokens(topic).slice(0, 3);
    {
        const st: SearchStatus = {};
        const got = await kci(words, opts.signal, st);
        const before = findings.length;
        for (const f of got) {
            if (!findings.some((x) => x.citation === f.citation)) findings.push({ ...f, query: words.join(' · ') });
        }
        searches.push({ source: 'kci', q: words.join(' · '), ...(st.error ? { error: st.error } : { results: kciRaw }), kept: findings.length - before });
    }
    for (const q of [topic, ...c.entities.slice(0, 2)]) {
        const st: SearchStatus = {};
        const got = await crossref(q, opts.signal, st);
        const before = findings.length;
        for (const f of got) {
            if (!findings.some((x) => x.citation === f.citation)) findings.push({ ...f, query: q });
        }
        searches.push({ source: 'crossref', q, ...(st.error ? { error: st.error } : { results: got.length }), kept: findings.length - before });
    }
    // 출처는 id 머리말이 말해 준다(url-·web-·wiki-·kci-·crossref-). 앱이 id 를 R1… 로 바꾸기 전에 적어 둔다.
    for (const f of findings) f.source ??= (['url', 'web', 'wiki', 'kci', 'crossref'] as const).find((k) => f.id.startsWith(`${k}-`));

    if (opts.scratch) persist(findings, opts.scratch);

    record({
        kind: 'acquire',
        name: 'research',
        subject: `조사: ${topic.slice(0, 50)}`,
        ok: findings.length > 0,
        ms: Date.now() - started,
        detail: `단서 URL ${c.urls.length} · 고유명사 ${c.entities.length} · 발견 ${findings.length}건 (사실 ${findings.filter((f) => f.kind === 'fact').length}, 문헌 ${findings.filter((f) => f.kind === 'doctrine').length})`,
    });

    return { topic, queries: [...c.urls, ...c.entities], findings, fetched, searches, v: RESEARCH_VERSION };
}
