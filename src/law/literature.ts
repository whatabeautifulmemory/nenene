// 학설 탐색. 쟁점의 용어로 문헌을 찾아 **프로젝트 스크래치패드에 내려받는다.**
//
// 왜 필요했나: 7개 주제 실행에서 인용 131건이 **전부 조문**이었다. 학설 0, 판례 0. 원인은
// 두 가지였고 둘 다 여기서 고친다:
//   1) 워커 프롬프트가 "주어진 원문에 있는 조문만 인용하라"고 막고 있었다.
//   2) 문헌을 찾는 단계가 아예 없었다 — acquireSource 는 모델이 인용했을 때만 반응한다.
//
// 그래서 이 단계는 **먼저 찾는다**. 찾은 것은 파일로 떨어지고, 워커가 그것을 인용하면
// acquireSource 가 그 파일을 사전제공 파일처럼 집어 전문을 읽는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchUrl } from './web.ts';
import { record } from '../trace.ts';
import { kciCitation, kciFindByText } from './kci.ts';

export interface LitHit {
    /** 인용 가능한 형태: 저자, 「제목」, 연도 */
    citation: string;
    title: string;
    year?: string;
    url?: string;
    /** 내려받아 저장한 파일 경로 (전문 확보 시) */
    path?: string;
    /** 워커에게 보여줄 발췌 */
    excerpt: string;
    hasFullText: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STRUCTURE = ['참고문헌', 'References', 'REFERENCES', '서론', 'Introduction', '결론', 'Conclusion', 'Ⅰ.', '각주'];
const looksLikePaper = (t: string) => t.length >= 6000 && STRUCTURE.filter((m) => t.includes(m)).length >= 2;

function authorLine(authors: any[]): string {
    const names = (authors ?? []).slice(0, 3).map((a: any) => a?.author?.display_name ?? a?.name ?? '').filter(Boolean);
    return names.length ? `${names.join('·')}${authors.length > 3 ? ' 외' : ''}` : '저자 미상';
}

const slug = (s: string) =>
    s
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, '-')
        .slice(0, 80);

/**
 * OpenAlex 로 문헌을 찾고, 열린 원문이 있으면 내려받는다.
 *
 * 내려받은 것은 `<scratch>/<제목>.md` 로 저장되고, 머리에 인용·출처·수집시각이 남는다.
 * 그 머리가 이후 실행의 코퍼스 매칭에 쓰인다(제목으로 찾는다).
 */
export async function searchLiterature(
    query: string,
    opts: { limit?: number; scratch?: string; signal?: AbortSignal } = {},
): Promise<LitHit[]> {
    const limit = opts.limit ?? 3;
    if (!query.trim()) return [];
    const started = Date.now();
    const hits: LitHit[] = [];

    try {
        // KCI — 한국 학술지. OpenAlex 가 한국 문헌에서 비어 있는 자리를 채운다.
        // 전문은 없으므로 excerpt 는 초록이고 hasFullText 는 false 다. 정직하게 표시한다.
        const arts = await kciFindByText(query, { limit: Math.max(limit * 2, 4), ...(opts.signal ? { signal: opts.signal } : {}) });
        for (const a of arts) {
            if (hits.length >= limit) break;
            hits.push({
                citation: kciCitation(a),
                title: a.title,
                ...(a.year ? { year: a.year } : {}),
                ...(a.url ? { url: a.url } : {}),
                excerpt: (a.abstract ?? '').slice(0, 1200),
                hasFullText: false,
            });
        }

        const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=is_oa:true&per_page=${Math.max(limit * 3, 8)}`;
        const res = await fetch(url, { signal: opts.signal, headers: { 'user-agent': 'nenene' } });
        if (!res.ok) {
            record({ kind: 'acquire', name: 'openalex', subject: `문헌 탐색: ${query}`, ok: false, ms: Date.now() - started, detail: `HTTP ${res.status}` });
            // OpenAlex 가 막혀도(429 가 잦다) 이미 찾은 KCI 결과는 버리지 않는다.
            return hits;
        }
        const j: any = await res.json();
        const works: any[] = j?.results ?? [];

        for (const w of works) {
            if (hits.length >= limit) break;
            const title = String(w?.display_name ?? '').trim();
            if (!title) continue;
            const year = w?.publication_year ? String(w.publication_year) : undefined;
            const authors = authorLine(w.authorships ?? []);
            const citation = `${authors}, 「${title}」${year ? `, ${year}` : ''}`;

            const cands = [
                w.best_oa_location?.pdf_url,
                w.best_oa_location?.landing_page_url,
                w.open_access?.oa_url,
                w.primary_location?.pdf_url,
            ].filter(Boolean) as string[];

            let full: string | null = null;
            let sourceUrl: string | undefined;
            for (const u of cands.slice(0, 2)) {
                const d = await fetchUrl(u, { signal: opts.signal });
                if (d.error || d.paywall || d.login) continue;
                // fetchUrl 이 PDF 면 이미 pdftotext 를 거친 텍스트를 준다.
                const text = d.text;
                if (text && looksLikePaper(text)) {
                    full = text;
                    sourceUrl = u;
                    break;
                }
                await sleep(120);
            }

            let path: string | undefined;
            if (full && opts.scratch) {
                try {
                    mkdirSync(opts.scratch, { recursive: true });
                    path = join(opts.scratch, `${slug(title)}.md`);
                    const header = [
                        '---',
                        `citation: ${citation.replace(/\n/g, ' ')}`,
                        `title: ${title.replace(/\n/g, ' ')}`,
                        `source: ${sourceUrl ?? ''}`,
                        `fetched_by: openalex`,
                        `fetched_at: ${new Date().toISOString()}`,
                        '---',
                        '',
                    ].join('\n');
                    writeFileSync(path, header + full);
                } catch {
                    path = undefined;
                }
            }

            hits.push({
                citation,
                title,
                ...(year ? { year } : {}),
                ...(sourceUrl ? { url: sourceUrl } : {}),
                ...(path ? { path } : {}),
                excerpt: (full ?? '').slice(0, 1200),
                hasFullText: Boolean(full),
            });
            await sleep(120);
        }

        record({
            kind: 'acquire',
            name: 'literature',
            subject: `문헌 탐색: ${query.slice(0, 60)}`,
            ok: hits.length > 0,
            ms: Date.now() - started,
            detail: `${hits.length}건 · 전문 ${hits.filter((h) => h.hasFullText).length}건`,
        });
    } catch (e) {
        record({
            kind: 'acquire',
            name: 'literature',
            subject: `문헌 탐색: ${query.slice(0, 60)}`,
            ok: false,
            ms: Date.now() - started,
            detail: e instanceof Error ? e.message.slice(0, 160) : String(e),
        });
    }
    return hits;
}
