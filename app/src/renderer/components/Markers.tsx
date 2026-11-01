// ⟦인용⟧ 마커와 [^n] 각주를 react-markdown 이 구분할 수 있는 링크로 바꾼다.
//
// react-markdown 은 raw HTML 을 렌더하지 않고(rehype-raw 없음) 텍스트 노드를 바꿔 끼울 길도
// 없다. 그래서 마크다운 안에서 유일하게 "커스텀 컴포넌트로 가로챌 수 있는 인라인"인 링크를
// 쓴다 — href 의 스킴으로 종류를 구분하고 ChatMarkdown 의 `a` 컴포넌트가 배지·위첨자로 그린다.
import { createContext } from 'react';
import type { CiteStatus } from '../../shared/ipc.ts';

export const CITE_SCHEME = 'cite:';
export const MARKER = /⟦([^⟦⟧]{1,400})⟧/g;

/** raw(본문에 쓰인 인용 문자열 그대로) → 상태. 집필·원고 화면이 공급하고 배지가 읽는다. */
export const CiteContext = createContext<ReadonlyMap<string, CiteStatus>>(new Map());

export function citeMap(cites: readonly CiteStatus[]): Map<string, CiteStatus> {
    const m = new Map<string, CiteStatus>();
    for (const c of cites) {
        m.set(c.raw, c);
        // 공백·따옴표 차이로 못 찾는 일이 없도록 정규화 키로도 넣는다.
        if (c.key && !m.has(c.key)) m.set(c.key, c);
    }
    return m;
}

const escapeText = (s: string): string => s.replace(/([\\`*_{}[\]()#+\-.!<>~|])/g, '\\$1');

/** `⟦raw⟧` → `[raw](cite:raw)` */
export function prepareMarkers(text: string): string {
    return text.replace(MARKER, (_m, raw: string) => `[${escapeText(raw)}](${CITE_SCHEME}${encodeURIComponent(raw)})`);
}

/**
 * `[^n]` → `[n](#fn-n)`, `[^n]: 텍스트` → 문단 `[n](#fnref-n) 텍스트`.
 *
 * remark-gfm 의 각주를 쓰지 않는 이유: 정의를 문서 맨 끝으로 끌어내려서 조립기가 둔
 * `## 각주` 제목 아래가 비고, 부록 뒤에 각주가 붙는다. 저자가 둔 자리에 그대로 두려면
 * 직접 바꾸는 편이 낫다.
 */
export function prepareFootnotes(text: string): string {
    const out: string[] = [];
    for (const line of text.split('\n')) {
        const m = /^\[\^(\d+)\]:\s?(.*)$/.exec(line);
        if (!m) {
            out.push(line);
            continue;
        }
        const n = m[1] ?? '';
        const body = m[2] ?? '';
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push(`[${n}](#fnref-${n}) ${body}`);
        out.push('');
    }
    return out.join('\n').replace(/\[\^(\d+)\]/g, (_m, n: string) => `[${n}](#fn-${n})`);
}

export function scrollToId(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1400);
}

export function scrollToRef(n: string): void {
    const el = document.querySelector<HTMLElement>(`[data-fnref="${n}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1400);
}
