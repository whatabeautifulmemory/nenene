import { useEffect, useRef, useState } from 'react';

/**
 * 값이 아니라 **끌어서 조절하는** 분할.
 *
 * localStorage 에 퍼센트로 남긴다. 절대 픽셀로 저장하면 창 크기가 달라질 때 오른쪽 패널이
 * 사라지거나 남는다 — 사용자는 창 크기를 바꾼다.
 */
export function useSplit(key: string, initial: number): [number, (f: (p: number) => number) => void] {
    const [pct, setPct] = useState<number>(() => {
        const raw = Number(localStorage.getItem(key));
        return Number.isFinite(raw) && raw >= 15 && raw <= 85 ? raw : initial;
    });
    const set = (f: (p: number) => number) =>
        setPct((p) => {
            const next = Math.round(Math.min(85, Math.max(15, f(p))) * 10) / 10;
            localStorage.setItem(key, String(next));
            return next;
        });
    return [pct, set];
}

/**
 * 세로 분할선. 드래그 중에는 커서와 선택을 잠근다 — 아니면 글자가 드래그로 선택된다.
 * edge 면 선을 따로 그리지 않고 부모(position: relative)의 왼쪽 테두리 위에 손잡이만 겹친다 — 서랍처럼 이미 테두리가 있는 패널용.
 * onDelta 의 total 은 끌기 시작한 곳에서 움직인 거리다 — onStart 에 잡아 둔 너비에 더하면 화면이 늦게 따라와도 커서와 어긋나지 않는다.
 */
export function Splitter(props: { onDelta: (dx: number, total: number) => void; onStart?: () => void; orientation?: 'v' | 'h'; edge?: boolean; onReset?: () => void }) {
    const vertical = (props.orientation ?? 'v') === 'v';
    const last = useRef(0);
    const from = useRef(0);
    const dragging = useRef(false);

    useEffect(() => {
        const move = (e: MouseEvent) => {
            if (!dragging.current) return;
            const pos = vertical ? e.clientX : e.clientY;
            props.onDelta(pos - last.current, pos - from.current);
            last.current = pos;
        };
        const up = () => {
            dragging.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
    }, [props, vertical]);
    // 끄는 도중에 화면이 바뀌어 사라지면(실행이 끝나 원고 탭으로) 잠가 둔 커서·선택을 풀어 준다.
    useEffect(
        () => () => {
            if (dragging.current) {
                dragging.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        },
        [],
    );

    return (
        <div
            role="separator"
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            onMouseDown={(e) => {
                dragging.current = true;
                last.current = from.current = vertical ? e.clientX : e.clientY;
                props.onStart?.();
                document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            }}
            onDoubleClick={props.onReset}
            title={props.onReset ? '끌어서 너비 조절 · 두 번 누르면 처음 너비로' : undefined}
            className={props.edge ? 'split-edge' : undefined}
            style={props.edge ? undefined : {
                flex: '0 0 6px',
                cursor: vertical ? 'col-resize' : 'row-resize',
                background: 'var(--line)',
                // 6px 는 잡기 어렵다. 보이는 선은 그대로 두고 히트 영역만 넓힌다.
                position: 'relative',
                zIndex: 2,
            }}
        >
            {!props.edge && <div style={{ position: 'absolute', inset: vertical ? '0 -4px' : '-4px 0', background: 'transparent' }} />}
        </div>
    );
}

/** 세로(높이) 분할 — 그래프 아래 상세 상자 같은 것에 쓴다. */
export function useHeight(key: string, initial: number): [number, (f: (p: number) => number) => void] {
    const [h, setH] = useState<number>(() => {
        const raw = Number(localStorage.getItem(key));
        return Number.isFinite(raw) && raw >= 60 && raw <= 600 ? raw : initial;
    });
    const set = (f: (p: number) => number) =>
        setH((p) => {
            const next = Math.round(Math.min(600, Math.max(60, f(p))));
            localStorage.setItem(key, String(next));
            return next;
        });
    return [h, set];
}
