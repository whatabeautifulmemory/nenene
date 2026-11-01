import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/** 내용에 맞춰 높이가 자라는 textarea. 설계 카드처럼 한 줄짜리 칸이 많을 때 스크롤바 숲을 피한다. */
export function AutoTextarea({ minRows = 1, maxRows = 12, value, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
        const pad = 16;
        const min = line * minRows + pad;
        const max = line * maxRows + pad;
        el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
        el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    }, [value, minRows, maxRows]);
    return <textarea ref={ref} rows={minRows} value={value} className={`auto ${className ?? ''}`} {...rest} />;
}
