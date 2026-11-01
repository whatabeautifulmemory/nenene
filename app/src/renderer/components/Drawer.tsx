import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PanelRightClose } from 'lucide-react';
import { readBool, writeBool } from '../lib/format.ts';
import { Splitter } from './Splitter.tsx';

export interface DrawerTab {
    id: string;
    label: string;
    icon: ReactNode;
    count?: number;
}

/**
 * 오른쪽 서랍. 접으면 아이콘 레일만 남고, 레일의 아이콘을 누르면 그 탭으로 열린다.
 * 열림 상태는 localStorage 에 남긴다 — 활동 피드를 매번 다시 닫게 만들지 않기 위해서.
 */
export function Drawer(props: { storageKey: string; tabs: DrawerTab[]; active: string; onTab: (id: string) => void; children: ReactNode }) {
    const [open, setOpen] = useState(() => readBool(props.storageKey, true));
    useEffect(() => writeBool(props.storageKey, open), [open, props.storageKey]);
    const [width, setWidth] = useDrawerWidth(`${props.storageKey}.width`);
    const ref = useRef<HTMLElement>(null);
    const dragFrom = useRef(0);

    if (!open) {
        return (
            <aside className="rail" aria-label="서랍 열기">
                {props.tabs.map((t) => (
                    <button
                        key={t.id}
                        className="rail-btn"
                        title={t.label}
                        onClick={() => {
                            props.onTab(t.id);
                            setOpen(true);
                        }}
                    >
                        {t.icon}
                        <span className="rail-label">{t.label}</span>
                        {t.count ? <span className="badge">{t.count}</span> : null}
                    </button>
                ))}
            </aside>
        );
    }

    return (
        <aside className="drawer" ref={ref} style={width ? { flexBasis: width, width } : undefined}>
            {/* 끌어서 너비를 바꾼다. 끌기 시작한 때 보이는 너비에서 움직인 만큼만 — 창이 좁아 잘려 있던 너비에서 시작하면 한동안 안 움직인다.
                움직임마다 offsetWidth 를 읽으면 화면이 따라오기 전(실행 이벤트로 바쁠 때)의 같은 너비를 두 번 읽어 앞의 움직임이 사라졌다. */}
            <Splitter
                edge
                onStart={() => (dragFrom.current = ref.current?.offsetWidth ?? 0)}
                onDelta={(_dx, total) => ref.current && setWidth(dragFrom.current - total, ref.current.parentElement?.clientWidth ?? window.innerWidth)}
                onReset={() => setWidth(null, 0)}
            />
            <div className="drawer-tabs" role="tablist">
                {props.tabs.map((t) => (
                    <button key={t.id} role="tab" aria-selected={props.active === t.id} className={`drawer-tab ${props.active === t.id ? 'on' : ''}`} onClick={() => props.onTab(t.id)}>
                        {t.icon}
                        <span>{t.label}</span>
                        {t.count ? <span className="badge">{t.count}</span> : null}
                    </button>
                ))}
                <span className="spacer" />
                <button className="icon-btn" title="서랍 접기" onClick={() => setOpen(false)}>
                    <PanelRightClose size={16} />
                </button>
            </div>
            <div className="drawer-body">{props.children}</div>
        </aside>
    );
}

/**
 * 서랍 너비(px). 정하지 않았으면 null — CSS 의 기본 너비(창 폭에 따라 380/340)를 쓴다.
 * 본문이 너무 좁아지지 않게 「옆 패널 폭 − 420px」을 넘지 않고, 서랍 탭(각주·참고문헌·검증·실행 + 건수)이 겹치지 않는 폭보다 좁아지지 않는다.
 */
const MIN_DRAWER = 360;
function useDrawerWidth(key: string): [number | null, (w: number | null, container: number) => void] {
    const [w, setW] = useState<number | null>(() => {
        const raw = Number(localStorage.getItem(key));
        return Number.isFinite(raw) && raw >= MIN_DRAWER ? raw : null;
    });
    const set = (next: number | null, container: number) => {
        if (next === null) {
            localStorage.removeItem(key);
            setW(null);
            return;
        }
        const v = Math.round(Math.max(MIN_DRAWER, Math.min(next, Math.max(MIN_DRAWER, container - 420))));
        localStorage.setItem(key, String(v));
        setW(v);
    };
    return [w, set];
}
