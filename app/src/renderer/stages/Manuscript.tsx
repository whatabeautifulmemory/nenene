import { useMemo, useState } from 'react';
import { citesOf } from '../lib/runState.ts';
import { BookOpen, Download, History, ListOrdered, Save, ShieldCheck } from 'lucide-react';
import type { CiteStatus, Ledger, RunInfo } from '../../shared/ipc.ts';
import { ChatMarkdown } from '../components/ChatMarkdown.tsx';
import { Drawer } from '../components/Drawer.tsx';
import { CiteContext, citeMap, scrollToId } from '../components/Markers.tsx';
import { VerdictPill } from '../components/ReviewList.tsx';
import { VERDICT_KO, citeTone, citeToneLabel, clock, parseFootnotes, sliceSection } from '../lib/format.ts';

type Tab = 'footnotes' | 'bib' | 'verify' | 'runs';

function VerifyPanel({ ledger, cites }: { ledger: Ledger | null; cites: CiteStatus[] }) {
    if (!ledger) return <div className="empty small">검증 원장이 없습니다. 집필이 끝나면 판정·반대·인용 상태가 여기 요약됩니다.</div>;
    const items = ledger.issues.flatMap((i) => i.items);
    const counts: Record<string, number> = {};
    for (const it of items) counts[it.judgment.verdict] = (counts[it.judgment.verdict] ?? 0) + 1;
    const surviving = items.filter((it) => it.judgment.surviving.length > 0);
    // 본문에서 뺀 인용도 센다 — 그 표지가 생기기 전 원장은 paper.withheld 에만 있다(runState 의 citesOf 와 같은 규칙).
    const allCites = ledger.paper ? citesOf(ledger.paper) : cites;
    const bad = allCites.filter((c) => citeTone(c) === 'bad');
    const cov = ledger.coverage;
    return (
        <div className="verify">
            <div className="verdict-row">
                {(['supported', 'weak', 'refuted', 'unresolved'] as const).map((v) => (
                    <span key={v} className={`pill verdict ${v}`}>
                        {VERDICT_KO[v]} <b>{counts[v] ?? 0}</b>
                    </span>
                ))}
            </div>
            <p className="muted">
                주장 {cov.claims} · 인용 {cov.citations} · 원문 확인 {cov.verified} · 미확인 {cov.unverifiable} · 차단 {cov.blocking}
                {typeof cov.revised === 'number' ? ` · 수정 ${cov.revised}` : ''}
            </p>
            <h4>살아남은 반대 · {surviving.length}</h4>
            {surviving.length === 0 ? (
                <p className="muted">없음</p>
            ) : (
                surviving.map((it) => (
                    <div key={it.claim.id} className="verify-item">
                        <div className="review-head">
                            <VerdictPill item={it} />
                            <code className="muted">{it.claim.id}</code>
                        </div>
                        <p className="review-prop">{it.claim.proposition}</p>
                        <ul className="review-surviving">
                            {it.judgment.surviving.map((s, i) => (
                                <li key={i}>{s}</li>
                            ))}
                        </ul>
                    </div>
                ))
            )}
            <h4>확인 못 한 인용 · {bad.length}</h4>
            {bad.length === 0 ? (
                <p className="muted">없음</p>
            ) : (
                <ul className="bad-cites">
                    {bad.map((c) => (
                        <li key={`${c.n}-${c.key}`}>
                            <span className="pill cite" data-tone="bad">
                                {c.n}
                            </span>
                            <span>{c.raw}</span>
                            <span className="muted"> — {citeToneLabel(c)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** 원고. 렌더된 논문(명조) 또는 편집기, 오른쪽 서랍에 각주·참고문헌·검증·실행. */
export function Manuscript(props: {
    manuscript: string;
    topic: string;
    dirty: boolean;
    savedAt: Date | null;
    runDir: string | undefined;
    ledger: Ledger | null;
    runs: RunInfo[];
    cites: CiteStatus[];
    onChange: (text: string) => void;
    onSave: () => Promise<void>;
    onPickRun: (run: RunInfo) => Promise<void>;
}) {
    const [edit, setEdit] = useState(false);
    const [tab, setTab] = useState<Tab>('footnotes');
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
    const [saving, setSaving] = useState(false);

    const footnotes = useMemo(() => parseFootnotes(props.manuscript), [props.manuscript]);
    const bib = useMemo(() => sliceSection(props.manuscript, '참고문헌'), [props.manuscript]);
    const cites = useMemo(() => citeMap(props.ledger?.paper?.cites ?? props.cites), [props.ledger, props.cites]);
    const chars = props.manuscript.length;

    const doExport = async (kind: 'md' | 'html' | 'docx') => {
        setBusy(kind);
        setNote(null);
        try {
            const r = await window.legal.exportAs(kind, { manuscript: props.manuscript, topic: props.topic, runDir: props.runDir });
            setNote('error' in r ? { ok: false, text: `내보내기 실패 — ${r.error}` } : { ok: true, text: r.path });
        } catch (e) {
            setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(null);
        }
    };

    const jumpTo = (n: number) => {
        if (edit) setEdit(false);
        window.setTimeout(() => scrollToId(`fn-${n}`), edit ? 80 : 0);
    };

    return (
        <div className="stage manuscript">
            <div className="toolbar">
                <div className="seg mini">
                    <button className={!edit ? 'on' : ''} onClick={() => setEdit(false)}>
                        보기
                    </button>
                    <button className={edit ? 'on' : ''} onClick={() => setEdit(true)}>
                        편집
                    </button>
                </div>
                <span className="muted">
                    {chars.toLocaleString()}자 · 각주 {footnotes.length}
                </span>
                <span className="spacer" />
                {note && (
                    <span className={`export-note ${note.ok ? 'ok' : 'bad'}`}>
                        {note.ok ? (
                            <button className="link" onClick={() => void window.legal.openPath(note.text)} title={note.text}>
                                {note.text.split('/').slice(-1)[0]}
                            </button>
                        ) : (
                            note.text
                        )}
                    </span>
                )}
                <button
                    onClick={async () => {
                        setSaving(true);
                        try {
                            await props.onSave();
                        } finally {
                            setSaving(false);
                        }
                    }}
                    disabled={saving || !chars}
                    className={props.dirty ? 'primary' : ''}
                >
                    <Save size={14} /> {saving ? '저장 중…' : '저장'}
                </button>
                <span className="muted save-state">{props.dirty ? '수정됨' : props.savedAt ? `${clock(props.savedAt)} 저장` : ''}</span>
                <div className="btn-group">
                    <button onClick={() => void doExport('docx')} disabled={!chars || busy !== null} title="각주가 Word 각주로 들어갑니다">
                        <Download size={13} /> {busy === 'docx' ? '…' : 'DOCX'}
                    </button>
                    <button onClick={() => void doExport('html')} disabled={!chars || busy !== null}>
                        {busy === 'html' ? '…' : 'HTML'}
                    </button>
                    <button onClick={() => void doExport('md')} disabled={!chars || busy !== null}>
                        {busy === 'md' ? '…' : 'MD'}
                    </button>
                </div>
            </div>

            <div className="ms-body">
                <div className="ms-main">
                    {chars === 0 ? (
                        <div className="empty">
                            <strong>아직 원고가 없습니다.</strong>
                            <p>집필이 끝나면 조립된 논문이 여기 들어옵니다. 오른쪽 「실행」에서 지난 실행의 원고를 불러올 수도 있습니다.</p>
                        </div>
                    ) : edit ? (
                        <textarea className="editor" value={props.manuscript} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} />
                    ) : (
                        <article className="paper">
                            <CiteContext.Provider value={cites}>
                                <ChatMarkdown text={props.manuscript} variant="paper" />
                            </CiteContext.Provider>
                        </article>
                    )}
                </div>

                <Drawer
                    storageKey="lps.drawer.manuscript"
                    active={tab}
                    onTab={(id) => setTab(id as Tab)}
                    tabs={[
                        { id: 'footnotes', label: '각주', icon: <ListOrdered size={14} />, count: footnotes.length },
                        { id: 'bib', label: '참고문헌', icon: <BookOpen size={14} /> },
                        { id: 'verify', label: '검증', icon: <ShieldCheck size={14} /> },
                        { id: 'runs', label: '실행', icon: <History size={14} />, count: props.runs.length },
                    ]}
                >
                    {tab === 'footnotes' &&
                        (footnotes.length === 0 ? (
                            <div className="empty small">각주가 없습니다. 조립 단계가 ⟦인용⟧ 을 번호로 바꾸고 여기에 정의를 만듭니다.</div>
                        ) : (
                            <ol className="fn-list">
                                {footnotes.map((f) => (
                                    <li key={f.n} onClick={() => jumpTo(f.n)} title="원고의 각주로">
                                        <span className="fn-n">{f.n}</span>
                                        <span className="fn-text">{f.text}</span>
                                    </li>
                                ))}
                            </ol>
                        ))}
                    {tab === 'bib' &&
                        (bib ? (
                            <div className="bib">
                                <ChatMarkdown text={bib} variant="chat" />
                            </div>
                        ) : footnotes.length > 0 ? (
                            <div className="bib">
                                <p className="hint">「참고문헌」 절이 없어 각주에서 모았습니다.</p>
                                <ul className="bib-list">
                                    {[...new Set(footnotes.map((f) => f.text.replace(/\s[—–-]\s[✓◐⚠✗].*$/, '')))].sort().map((t, i) => (
                                        <li key={i}>{t}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : (
                            <div className="empty small">참고문헌이 없습니다.</div>
                        ))}
                    {tab === 'verify' && <VerifyPanel ledger={props.ledger} cites={props.cites} />}
                    {tab === 'runs' &&
                        (props.runs.length === 0 ? (
                            <div className="empty small">아직 실행이 없습니다.</div>
                        ) : (
                            <ul className="run-list">
                                {props.runs.map((r) => (
                                    <li key={r.dir} className={r.dir === props.runDir ? 'current' : ''} onClick={() => void props.onPickRun(r)} title={r.dir}>
                                        <span className="run-name">{r.name}</span>
                                        <span className="run-flags">
                                            {r.hasPaper && <span className="chip">원고</span>}
                                            {r.hasLedger && <span className="chip">원장</span>}
                                            {r.dir === props.runDir && <span className="chip accent">현재</span>}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ))}
                </Drawer>
            </div>
        </div>
    );
}
