import { useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Play, Plus, X } from 'lucide-react';
import type { PaperScale, PaperThesis, ProjectFile, RefFile } from '../../shared/ipc.ts';
import { AutoTextarea } from '../components/AutoTextarea.tsx';
import { Chat } from '../components/Chat.tsx';
import { PlanCard } from '../components/PlanCard.tsx';
import { Splitter, useSplit } from '../components/Splitter.tsx';
import { KB } from '../lib/format.ts';

const SCALES: { id: PaperScale; label: string; hint: string }[] = [
    { id: 'short', label: '짧게', hint: '5~6장 · 약 12k자' },
    { id: 'standard', label: '표준', hint: '7~9장 · 약 22k자' },
    { id: 'long', label: '길게', hint: '9~12장 · 약 35k자' },
];

/**
 * 구상. 왼쪽은 대화, 오른쪽은 설계 카드·규모·참고문헌.
 * 상태는 전부 ProjectFile 에 있고 Workspace 가 들고 있다 — 단계를 오가도 잃지 않는다. 대화의 보내기·기다림도 Workspace 에 있다.
 */
export function Conceive(props: {
    projectId: string;
    file: ProjectFile;
    refs: RefFile[];
    defaultScale: PaperScale;
    running: boolean;
    chatBusy: boolean;
    chatError: string | null;
    onSend: (text: string) => void;
    onUpdate: (patch: Partial<ProjectFile>) => void;
    onSave: (patch?: Partial<ProjectFile>) => Promise<void>;
    onSaveSoon: (patch: Partial<ProjectFile>) => void;
    onStart: () => void;
    onRefsChanged: (refs: RefFile[]) => void;
}) {
    const { file } = props;
    const [proposing, setProposing] = useState(false);
    const [proposeError, setProposeError] = useState<string | null>(null);
    const [refsBusy, setRefsBusy] = useState(false);
    const [pct, setPct] = useSplit('lps.conceive.split', 60);
    const splitRef = useRef<HTMLDivElement>(null);
    const leftRef = useRef<HTMLDivElement>(null);
    const rightRef = useRef<HTMLDivElement>(null);
    const dragFrom = useRef(0);
    // 끌기 시작한 때의 보이는 너비에서 움직인 만큼(움직임마다 지금 너비를 읽으면 화면이 따라오기 전의 값을 읽어 커서와 어긋난다).
    // 오른쪽 칸(설계 카드·집필 시작)의 최소 폭과 분할선을 남긴 만큼까지만 — 85% 로 저장되면 그 칸이 창 밖으로 밀려나 안 보였다.
    const dragTo = (total: number) => {
        const box = splitRef.current?.clientWidth || window.innerWidth;
        const rightMin = (rightRef.current && parseFloat(getComputedStyle(rightRef.current).minWidth)) || 340;
        setPct(() => Math.min(((box - rightMin - 6) / box) * 100, ((dragFrom.current + total) / box) * 100));
    };

    const messages = file.chat ?? [];
    const scale = file.scale ?? props.defaultScale;

    const propose = async () => {
        setProposing(true);
        setProposeError(null);
        try {
            const r = await window.legal.planPropose({ projectId: props.projectId, topic: file.topic, context: file.context?.trim() || undefined, messages, current: file.plan ?? null });
            if ('error' in r) setProposeError(r.error);
            else await props.onSave({ plan: r.plan });
        } catch (e) {
            setProposeError(e instanceof Error ? e.message : String(e));
        } finally {
            setProposing(false);
        }
    };

    const setPlan = (plan: PaperThesis | null) => props.onSaveSoon({ plan });

    return (
        <div className="stage conceive">
            <div className="brief">
                <input
                    className="topic"
                    type="text"
                    value={file.topic}
                    placeholder="논문 주제 — 쟁점이 갈리는 한 문장"
                    onChange={(e) => props.onUpdate({ topic: e.target.value })}
                    onBlur={() => void props.onSave()}
                />
                <AutoTextarea
                    className="context"
                    minRows={1}
                    maxRows={6}
                    value={file.context ?? ''}
                    placeholder="배경·맥락 — 왜 쓰는지, 염두에 두는 사안·판례·자료, 입장, 다루지 않을 범위. 논지 설계와 대화가 이것을 따릅니다."
                    onChange={(e) => props.onUpdate({ context: e.target.value })}
                    onBlur={() => void props.onSave()}
                />
            </div>

            <div className="split" ref={splitRef}>
                {/* 줄어들 수 있게(0 1) — 저장된 비율이 커도, 창을 좁혀도 오른쪽 칸이 최소 폭을 지킨다. */}
                <div className="split-left" ref={leftRef} style={{ flex: `0 1 ${pct}%` }}>
                    <Chat messages={messages} busy={props.chatBusy} error={props.chatError} onSend={props.onSend} />
                </div>
                <Splitter onStart={() => (dragFrom.current = leftRef.current?.offsetWidth ?? 0)} onDelta={(_dx, total) => dragTo(total)} />
                <div className="split-right" ref={rightRef}>
                    <PlanCard plan={file.plan ?? null} onChange={setPlan} onPropose={() => void propose()} proposing={proposing} proposeError={proposeError} canPropose={messages.length > 0} />

                    <section className="card start-card">
                        <div className="row">
                            <div className="seg">
                                {SCALES.map((s) => (
                                    <button key={s.id} className={scale === s.id ? 'on' : ''} title={s.hint} onClick={() => void props.onSave({ scale: s.id })}>
                                        {s.label}
                                    </button>
                                ))}
                            </div>
                            <span className="hint">{SCALES.find((s) => s.id === scale)?.hint}</span>
                            <span className="spacer" />
                            <button className="primary" disabled={props.running || !file.topic.trim()} onClick={props.onStart} title={file.plan ? '이 설계를 들고 집필을 시작합니다' : '설계 없이 시작하면 논지 단계가 대신 설계합니다'}>
                                <Play size={14} /> {props.running ? '집필 중…' : '집필 시작'}
                            </button>
                        </div>
                        <p className="hint">조사 → 논지 → 목차 → 초고 → 인용 → 질문 → 연쇄 → 검토 → 보강 → 수정 → 재검증 → 인용 대조 → 조립. {file.plan ? '설계가 있으니 논지 단계는 건너뜁니다.' : '설계 카드가 비어 있으면 모델이 논지부터 세웁니다.'}</p>
                    </section>

                    <section className="card refs-card">
                        <header className="card-head">
                            <h3>참고문헌</h3>
                            <span className="muted">{props.refs.length}건</span>
                            <span className="spacer" />
                            <button className="ghost tiny" onClick={() => void window.legal.refsOpenFolder(props.projectId)} title="references/ 폴더 열기">
                                <FolderOpen size={13} /> 폴더
                            </button>
                            <button
                                className="tiny"
                                disabled={refsBusy}
                                onClick={async () => {
                                    setRefsBusy(true);
                                    try {
                                        props.onRefsChanged(await window.legal.refsAdd(props.projectId));
                                    } finally {
                                        setRefsBusy(false);
                                    }
                                }}
                            >
                                <Plus size={13} /> {refsBusy ? '추가 중…' : '파일 추가'}
                            </button>
                        </header>
                        {props.refs.length === 0 ? (
                            <p className="hint">PDF · DOCX · MD · TXT · HTML. 여기 있는 파일을 원문 확보 사다리가 가장 먼저 읽습니다.</p>
                        ) : (
                            <ul className="ref-list">
                                {props.refs.map((r) => (
                                    <li key={r.path} title={r.path}>
                                        <span className="ext">{r.ext.replace('.', '').toUpperCase()}</span>
                                        <span className="name">{r.name}</span>
                                        <span className="muted">{KB(r.size)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="corpus">
                            <span className="muted">추가 디렉터리</span>
                            {(file.extraCorpus ?? []).map((d) => (
                                <span key={d} className="chip removable" title={d}>
                                    <span className="chip-text">{d.split('/').filter(Boolean).slice(-1)[0] ?? d}</span>
                                    <button className="chip-x" title="빼기" onClick={() => void props.onSave({ extraCorpus: (file.extraCorpus ?? []).filter((x) => x !== d) })}>
                                        <X size={12} />
                                    </button>
                                </span>
                            ))}
                            <button
                                className="ghost tiny"
                                onClick={async () => {
                                    const d = await window.legal.pickFolder();
                                    if (d) await props.onSave({ extraCorpus: [...new Set([...(file.extraCorpus ?? []), d])] });
                                }}
                            >
                                <FolderPlus size={13} /> 추가
                            </button>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
