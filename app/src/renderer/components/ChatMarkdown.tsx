// react-markdown + remark-gfm 하나로 대화·장 본문·원고를 다 그린다. 모양 차이는 variant 클래스로
// CSS 가 가른다. 링크 컴포넌트 하나가 외부 링크·⟦인용⟧ 배지·[^n] 각주를 href 스킴으로 구분한다.
import { memo, useContext, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImageOff } from 'lucide-react';
import { CiteBadge } from './CiteBadge.tsx';
import { CITE_SCHEME, CiteContext, prepareFootnotes, prepareMarkers, scrollToId, scrollToRef } from './Markers.tsx';

const EXTERNAL = ['https:', 'http:', 'mailto:'];

export type MarkdownVariant = 'chat' | 'section' | 'paper';

function A({ href, children }: { href?: string; children?: ReactNode }) {
    const cites = useContext(CiteContext);
    if (href?.startsWith(CITE_SCHEME)) {
        let raw = href.slice(CITE_SCHEME.length);
        try {
            raw = decodeURIComponent(raw);
        } catch {
            /* 이미 풀린 문자열 */
        }
        return <CiteBadge raw={raw} status={cites.get(raw)} />;
    }
    if (href?.startsWith('#fn-')) {
        const n = href.slice(4);
        return (
            <sup className="fnref" data-fnref={n}>
                <a
                    href={href}
                    title={`각주 ${n}`}
                    onClick={(e) => {
                        e.preventDefault();
                        scrollToId(`fn-${n}`);
                    }}
                >
                    {n}
                </a>
            </sup>
        );
    }
    if (href?.startsWith('#fnref-')) {
        const n = href.slice(7);
        return (
            <a
                id={`fn-${n}`}
                className="fn-num"
                href={href}
                title="본문의 위치로"
                onClick={(e) => {
                    e.preventDefault();
                    scrollToRef(n);
                }}
            >
                {n}
            </a>
        );
    }
    // 외부 링크는 기본 브라우저로. Electron 안에서 location 을 바꾸면 돌아올 길이 없다.
    const safe = Boolean(href && EXTERNAL.some((p) => href.startsWith(p)));
    return (
        <a
            href={href}
            className="ext"
            onClick={(e) => {
                e.preventDefault();
                if (safe && href) window.open(href, '_blank', 'noopener');
            }}
        >
            {children}
        </a>
    );
}

function Img({ alt }: { alt?: string }) {
    return (
        <span className="md-img">
            <ImageOff size={13} /> {alt || '이미지'}
        </span>
    );
}

const components: Components = {
    a: A as Components['a'],
    img: Img as Components['img'],
};

const keepUrl = (url: string) => url;

export const ChatMarkdown = memo(function ChatMarkdown({ text, variant = 'chat' }: { text: string; variant?: MarkdownVariant }) {
    const prepared = variant === 'paper' ? prepareFootnotes(prepareMarkers(text)) : prepareMarkers(text);
    return (
        <div className={`md md-${variant}`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                remarkRehypeOptions={{ footnoteLabel: '각주', clobberPrefix: '' }}
                urlTransform={keepUrl}
                components={components}
            >
                {prepared}
            </ReactMarkdown>
        </div>
    );
});
