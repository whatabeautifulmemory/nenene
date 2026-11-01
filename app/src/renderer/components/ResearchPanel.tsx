import { useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { ResearchItem, ResearchNote } from '../../shared/ipc.ts';

/** 출처 표시 — research.ts 의 FindingSource 와 같은 값. */
export const RESEARCH_SOURCE_KO: Record<string, string> = { url: '링크', web: '웹', wiki: '백과', kci: 'KCI', crossref: 'Crossref' };
const ANGLE_KO: Record<string, string> = { fact: '사실', law: '법령', ruling: '판례', scholarship: '학설', critique: '비판' };

const openUrl = (url: string) => {
    if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener');
};

const hostOf = (url: string) => {
    try {
        return new URL(url).host.replace(/^www\./, '');
    } catch {
        return url;
    }
};

/** 인용 문자열 끝의 <url> 은 아래 줄에 따로 보이므로 떼고 보여 준다. */
const titleOf = (citation: string) => citation.replace(/\s*<https?:[^>]*>\s*$/, '').trim() || citation;

/**
 * 구상 대화 한 턴의 조사 내역 — 무엇을 어디에 검색했고, 무엇이 자료로 남았고, 무엇을 못 읽었나.
 * 자료는 검색어별로 묶는다(검색어가 없는 자료는 출처별로). 예전 기록(건수·표본만)은 표본만 보여 준다.
 */
export function ResearchPanel({ note }: { note: ResearchNote }) {
    const items = note.items ?? [];
    const searches = note.searches ?? [];
    const failed = note.failed ?? [];
    const legacy = !note.items;

    // 검색어 → 자료. 검색 기록 순서를 따르고, 검색 기록에 없는 묶음(필자가 준 링크 등)은 뒤에 붙인다.
    const groups = new Map<string, { label: string; source?: string; items: ResearchItem[] }>();
    for (const sch of searches) {
        const key = `${sch.source}|${sch.q}`;
        if (!groups.has(key)) groups.set(key, { label: sch.q, source: sch.source, items: [] });
    }
    for (const it of items) {
        const key = it.query ? `${it.source ?? ''}|${it.query}` : `source|${it.source ?? 'etc'}`;
        if (!groups.has(key)) groups.set(key, { label: it.query ?? (it.source === 'url' ? '필자가 준 링크' : RESEARCH_SOURCE_KO[it.source ?? ''] ?? '기타'), ...(it.source ? { source: it.source } : {}), items: [] });
        groups.get(key)!.items.push(it);
    }
    const searchOf = (key: string) => searches.find((x) => `${x.source}|${x.q}` === key);

    return (
        <div className="research-panel">
            <p className="hint">
                {note.scope === 'initial' ? '프로젝트 조사' : '이 발언으로 더 찾은 것'} — 자료 {note.count}건
                {searches.length > 0 && ` · 검색 ${searches.reduce((n, x) => n + (x.times ?? 1), 0)}회`}
                {failed.length > 0 && ` · 못 읽은 링크 ${failed.length}건`}
            </p>
            {legacy ? (
                <>
                    <ul className="research-items">
                        {note.sample.map((t, i) => (
                            <li key={i} className="research-item">
                                <span className="research-title">{t}</span>
                            </li>
                        ))}
                    </ul>
                    <p className="hint">이전 버전에서 남긴 기록이라 앞의 몇 건만 있습니다. 검색어·출처·발췌는 이번 버전부터 남습니다.</p>
                </>
            ) : (
                [...groups.entries()].map(([key, g]) => {
                    const sch = searchOf(key);
                    return (
                        <section key={key} className="research-group">
                            <div className="research-query">
                                {g.source && <span className={`src-badge src-${g.source}`}>{RESEARCH_SOURCE_KO[g.source] ?? g.source}</span>}
                                <span className="research-q">{g.label}</span>
                                {sch?.angle && <span className="muted">{ANGLE_KO[sch.angle] ?? sch.angle}</span>}
                                <span className="spacer" />
                                {sch && (
                                    <span className="muted research-count" title={sch.provider ? `검색 공급자: ${sch.provider}` : undefined}>
                                        {sch.times && sch.times > 1 ? `${sch.times}회 · ` : ''}
                                        {sch.error ? `검색 실패 — ${sch.error}` : <>{sch.results !== undefined ? `결과 ${sch.results} · ` : ''}남김 {sch.kept}</>}
                                        {sch.provider ? ` · ${sch.provider}` : ''}
                                    </span>
                                )}
                            </div>
                            {g.items.length > 0 ? (
                                <ul className="research-items">
                                    {g.items.map((it, i) => (
                                        <Item key={`${it.id}-${i}`} it={it} />
                                    ))}
                                </ul>
                            ) : (
                                <p className="hint research-none">{sch?.error ? '검색이 실패해 자료를 찾지 못했습니다' : '남은 자료 없음'}</p>
                            )}
                        </section>
                    );
                })
            )}
            {failed.length > 0 && (
                <section className="research-group">
                    <div className="research-query">
                        <span className="src-badge src-fail">실패</span>
                        <span className="research-q">못 읽은 링크</span>
                    </div>
                    <ul className="research-items">
                        {failed.map((f, i) => (
                            <li key={i} className="research-item failed">
                                <span className="research-title">{f.url}</span>
                                {f.error && <span className="muted"> — {f.error}</span>}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

function Item({ it }: { it: ResearchItem }) {
    const [open, setOpen] = useState(false);
    const excerpt = it.quote || it.summary;
    return (
        <li className={`research-item ${open ? 'open' : ''}`}>
            <button className="research-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <ChevronRight size={13} className="chev" />
                <span className="research-id">{it.id}</span>
                <span className="research-title">{titleOf(it.citation)}</span>
            </button>
            {it.url && (
                <a
                    className="research-link"
                    href={it.url}
                    title={it.url}
                    onClick={(e) => {
                        e.preventDefault();
                        openUrl(it.url!);
                    }}
                >
                    {hostOf(it.url)} <ExternalLink size={11} />
                </a>
            )}
            {open && (
                <div className="research-excerpt">
                    {it.summary && it.quote && it.summary !== it.quote && <p className="research-summary">{it.summary}</p>}
                    {excerpt && <blockquote>{excerpt}</blockquote>}
                    <p className="hint">
                        {it.source ? `출처 ${RESEARCH_SOURCE_KO[it.source] ?? it.source}` : ''}
                        {it.provider ? ` · ${it.provider}` : ''}
                        {it.authority !== undefined ? ` · 신뢰도 ${it.authority}/4` : ''}
                    </p>
                </div>
            )}
        </li>
    );
}
