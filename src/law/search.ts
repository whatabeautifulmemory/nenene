// 검색 공급자 계층.
//
// 하나만 있으면 그게 죽는 날 조사가 통째로 죽는다. DDG 스크래핑은 차단되고, 딥시크는
// 키가 없거나 잔액이 떨어지면 402 를 준다. 그때 "검색 0건"이 되면 파이프라인은 조용히
// 모델 기억으로 돌아간다 — 그게 이 앱이 없애려던 실패다.
//
// 그래서 기존 구현 처럼 여러 공급자를 두고 **우선순위대로 시도**한다. 키가 있는 것만 쓰고,
// 결과가 비면 다음으로 넘어간다.
import { record } from '../trace.ts';

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    /** 모델이 읽도록 만든 긴 요약 */
    summary?: string;
    /** 본문 */
    content?: string;
    siteName?: string;
    date?: string;
    /** 0~4. 높을수록 신뢰할 만한 출처 */
    authority?: number;
    /** 관련도 (공급자마다 척도가 다르다) */
    score?: number;
    provider: string;
}

export interface SearchProvider {
    id: string;
    label: string;
    /** 키가 필요한가 */
    needsKey: boolean;
    /** 지금 설정으로 쓸 수 있는가 */
    available: () => boolean;
    search: (query: string, opts: { count: number; content: boolean; signal?: AbortSignal }) => Promise<SearchResult[]>;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
// 앱은 base URL 을 `https://api.deepseek.com/v1` 로 준다. 그대로 쓰면 `/v1/v1/tools/search`
// 가 되어 404 가 나고, 검색이 **조용히 0건**이 된다(실제로 그랬다).
const DS_BASE = () =>
    (process.env.LEGAL_AGENT_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
        .replace(/\/v1\/?$/, '')
        .replace(/\/$/, '');
const DS_KEY = () => process.env.LEGAL_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY || '';

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

const deepseek: SearchProvider = {
    id: 'deepseek',
    label: 'DeepSeek Search (자체 엔진)',
    needsKey: true,
    // 딥시크가 아닌 공급자(OpenAI 등)에서는 이 엔드포인트가 없다.
    available: () => Boolean(DS_KEY()) && /deepseek/i.test(DS_BASE()),
    search: async (query, o) => {
        const j = await postJson(
            `${DS_BASE()}/v1/tools/search`,
            { query: query.slice(0, 128), count: o.count, need_content: o.content },
            { authorization: `Bearer ${DS_KEY()}` },
            o.signal,
        );
        return (j?.results ?? []).map((r: any) => ({
            title: String(r.title ?? ''),
            url: String(r.url ?? ''),
            snippet: String(r.snippet ?? ''),
            summary: String(r.summary ?? ''),
            content: String(r.content ?? ''),
            siteName: r.site_name ?? undefined,
            date: r.date ?? undefined,
            authority: typeof r.authority === 'number' ? r.authority : undefined,
            score: typeof r.rerank_score === 'number' ? r.rerank_score : undefined,
            provider: 'deepseek',
        }));
    },
};

const tavily: SearchProvider = {
    id: 'tavily',
    label: 'Tavily',
    needsKey: true,
    available: () => Boolean(process.env.TAVILY_API_KEY),
    search: async (query, o) => {
        const j = await postJson(
            'https://api.tavily.com/search',
            { api_key: process.env.TAVILY_API_KEY, query, max_results: o.count, include_raw_content: o.content },
            {},
            o.signal,
        );
        return (j?.results ?? []).map((r: any) => ({
            title: String(r.title ?? ''),
            url: String(r.url ?? ''),
            snippet: String(r.content ?? '').slice(0, 300),
            content: String(r.raw_content ?? r.content ?? ''),
            score: typeof r.score === 'number' ? r.score : undefined,
            provider: 'tavily',
        }));
    },
};

const brave: SearchProvider = {
    id: 'brave',
    label: 'Brave Search',
    needsKey: true,
    available: () => Boolean(process.env.BRAVE_API_KEY),
    search: async (query, o) => {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${o.count}`, {
            signal: o.signal,
            headers: { accept: 'application/json', 'x-subscription-token': process.env.BRAVE_API_KEY ?? '' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        return (j?.web?.results ?? []).map((r: any) => ({
            title: String(r.title ?? ''),
            url: String(r.url ?? ''),
            snippet: String(r.description ?? ''),
            siteName: r.profile?.name ?? undefined,
            date: r.age ?? undefined,
            provider: 'brave',
        }));
    },
};

const serper: SearchProvider = {
    id: 'serper',
    label: 'Serper (Google)',
    needsKey: true,
    available: () => Boolean(process.env.SERPER_API_KEY),
    search: async (query, o) => {
        const j = await postJson('https://google.serper.dev/search', { q: query, num: o.count }, { 'X-API-KEY': process.env.SERPER_API_KEY ?? '' }, o.signal);
        return (j?.organic ?? []).map((r: any) => ({
            title: String(r.title ?? ''),
            url: String(r.link ?? ''),
            snippet: String(r.snippet ?? ''),
            date: r.date ?? undefined,
            provider: 'serper',
        }));
    },
};

/** 키 없이 쓰는 마지막 수단. 차단 페이지(200)면 0건, 오류 응답(4xx·5xx)이면 실패로 알린다. */
const ddg: SearchProvider = {
    id: 'ddg',
    label: 'DuckDuckGo (키 불필요)',
    needsKey: false,
    available: () => true,
    search: async (query, o) => {
        let answered = false;
        let status = 0;
        for (const endpoint of ['https://html.duckduckgo.com/html/', 'https://lite.duckduckgo.com/lite/']) {
            const res = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, { signal: o.signal, headers: { 'user-agent': UA } });
            if (!res.ok) {
                status = res.status;
                continue;
            }
            answered = true;
            const html = await res.text();
            const linkRe = /<a[^>]+(?:class="result__a"|class='result-link')[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
            const snipRe = /(?:class="result__snippet"[^>]*|class='result-snippet'[^>]*)>([\s\S]*?)<\/(?:a|td)>/g;
            const snippets = [...html.matchAll(snipRe)].map((m) =>
                decode(m[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
            );
            const out: SearchResult[] = [];
            let i = 0;
            for (const m of html.matchAll(linkRe)) {
                const url = realUrl(decode(m[1]!));
                const title = decode(m[2]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
                if (!/^https?:/.test(url) || !title) continue;
                if (out.some((h) => h.url === url)) continue;
                out.push({ title, url, snippet: snippets[i] ?? '', provider: 'ddg' });
                i++;
                if (out.length >= o.count) break;
            }
            if (out.length) return out;
        }
        // 두 곳 다 오류로 답했으면 0건이 아니라 실패다 — 조사 기록에 「검색했는데 없었다」로 남지 않게.
        if (!answered) throw new Error(`HTTP ${status}`);
        return [];
    },
};

function decode(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function realUrl(href: string): string {
    const m = /[?&]uddg=([^&]+)/.exec(href);
    if (m) {
        try {
            return decodeURIComponent(m[1]!);
        } catch {
            /* 아래로 */
        }
    }
    return href.startsWith('//') ? `https:${href}` : href;
}

export const ALL_PROVIDERS: SearchProvider[] = [deepseek, tavily, brave, serper, ddg];

/**
 * 우선순위. `LEGAL_AGENT_SEARCH` 로 바꾼다 (예: `tavily,brave,ddg`).
 * 지정한 것 중 쓸 수 있는 것만, 그 다음 나머지를 뒤에 붙인다.
 */
export function providers(): SearchProvider[] {
    const wanted = (process.env.LEGAL_AGENT_SEARCH ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const ordered: SearchProvider[] = [];
    for (const id of wanted) {
        const p = ALL_PROVIDERS.find((x) => x.id === id);
        if (p && !ordered.includes(p)) ordered.push(p);
    }
    for (const p of ALL_PROVIDERS) if (!ordered.includes(p)) ordered.push(p);
    return ordered;
}

export const providerStatus = () =>
    providers().map((p) => ({ id: p.id, label: p.label, needsKey: p.needsKey, available: p.available() }));

/**
 * 우선순위대로 시도하고, **결과가 나온 첫 공급자**를 쓴다.
 * 빈 결과도 실패로 본다 — 빈손으로 다음 단계에 넘기면 조사가 없던 일이 된다.
 */
export async function searchWeb(
    query: string,
    opts: { count?: number; content?: boolean; signal?: AbortSignal } = {},
): Promise<{ results: SearchResult[]; used: string }> {
    const count = opts.count ?? 5;
    const attempts: string[] = [];
    for (const p of providers()) {
        if (!p.available()) continue;
        const started = Date.now();
        try {
            const results = await p.search(query, { count, content: opts.content ?? true, ...(opts.signal ? { signal: opts.signal } : {}) });
            record({
                kind: 'acquire',
                name: `search:${p.id}`,
                subject: query.slice(0, 50),
                ok: results.length > 0,
                ms: Date.now() - started,
                detail: `${results.length}건`,
            });
            attempts.push(`${p.id}:${results.length}`);
            if (results.length) return { results, used: p.id };
        } catch (e) {
            record({
                kind: 'acquire',
                name: `search:${p.id}`,
                subject: query.slice(0, 50),
                ok: false,
                ms: Date.now() - started,
                detail: e instanceof Error ? e.message.slice(0, 120) : String(e),
            });
            attempts.push(`${p.id}:err`);
        }
    }
    return { results: [], used: attempts.join(',') || 'none' };
}
