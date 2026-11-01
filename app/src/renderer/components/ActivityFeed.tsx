import { useEffect, useRef, useState } from 'react';
import type { ToolEvent } from '../../shared/ipc.ts';
import { TOOL_KIND_KO } from '../lib/format.ts';
import type { FeedItem } from '../lib/runState.ts';

/** 도구 이벤트 카드 — 코드가 한 일(원문 확보·검증)을 접히는 카드로. */
function ToolCard({ ev }: { ev: ToolEvent }) {
    const [open, setOpen] = useState(false);
    return (
        <div className={`toolcard ${ev.ok ? '' : 'bad'}`}>
            <div className="toolhead" onClick={() => setOpen((v) => !v)}>
                <span className={`dot ${ev.ok ? 'ok' : 'bad'}`} />
                <span className="toolkind">{TOOL_KIND_KO[ev.kind] ?? ev.kind}</span>
                <code className="toolname">{ev.name}</code>
                <span className="toolsubject" title={ev.subject}>
                    {ev.subject}
                </span>
                <span className="toolms">{ev.ms}ms</span>
            </div>
            {ev.detail && <div className="tooldetail">{ev.detail}</div>}
            {open && (
                <div className="toolbody">
                    {ev.input && (
                        <>
                            <b>입력</b>
                            <pre>{ev.input}</pre>
                        </>
                    )}
                    {ev.output && (
                        <>
                            <b>출력</b>
                            <pre>{ev.output}</pre>
                        </>
                    )}
                    {!ev.input && !ev.output && <i>추가 정보 없음</i>}
                </div>
            )}
        </div>
    );
}

/** 활동 피드. 바닥에 붙어 있을 때만 자동으로 따라간다 — 위로 올려 읽는 중이면 끌어내리지 않는다. */
export function ActivityFeed({ feed, running }: { feed: FeedItem[]; running: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const stick = useRef(true);

    useEffect(() => {
        const el = ref.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [feed.length, running]);

    return (
        <div
            className="feed"
            ref={ref}
            onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
        >
            {feed.length === 0 && <div className="empty small">{running ? '시작하는 중…' : '집필을 시작하면 진행 상황과 도구 호출이 여기에 흐릅니다.'}</div>}
            {feed.map((f, i) => {
                if (f.t === 'tool') return <ToolCard key={i} ev={f.ev} />;
                const text = f.text;
                if (!text.trim()) return <div key={i} className="logspacer" />;
                const isDetail = /^\s{2,}\S/.test(text);
                const isStage = /^\d/.test(text.trim());
                return (
                    <div key={i} className={`logline ${isStage ? 'head' : ''} ${isDetail ? 'detail' : ''} ${/실패|오류|error/i.test(text) ? 'err' : ''}`}>
                        {text}
                    </div>
                );
            })}
            {running && <div className="logline muted">…</div>}
        </div>
    );
}
