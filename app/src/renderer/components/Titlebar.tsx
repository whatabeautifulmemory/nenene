import type { ReactNode } from 'react';

/**
 * 드래그 가능한 제목줄. hiddenInset 창이라 왼쪽 70px 는 신호등 자리다.
 * 안의 버튼은 CSS 에서 no-drag 로 빠진다.
 */
export function Titlebar(props: { left?: ReactNode; right?: ReactNode }) {
    return (
        <div className="titlebar">
            <div className="titlebar-side left">{props.left}</div>
            <div className="titlebar-name">Nenene</div>
            <div className="titlebar-side right">{props.right}</div>
        </div>
    );
}
