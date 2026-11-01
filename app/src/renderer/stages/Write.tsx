import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, FileText, Play, Quote, Scale, Square, X } from 'lucide-react';
import type { Answer, PaperSection } from '../../shared/ipc.ts';
import { ActivityFeed } from '../components/ActivityFeed.tsx';
import { CiteTable } from '../components/CiteTable.tsx';
import { Drawer } from '../components/Drawer.tsx';
import { HitlPanel } from '../components/HitlPanel.tsx';
import { CiteContext, citeMap } from '../components/Markers.tsx';
import { ReviewList } from '../components/ReviewList.tsx';
import { SectionCard, type SectionUiStatus } from '../components/SectionCard.tsx';
import { Stepper } from '../components/Stepper.tsx';
import { STAGE_LABEL } from '../lib/format.ts';
import { RUN_STATUS_KO, runStatus, type RunState } from '../lib/runState.ts';

type Tab = 'activity' | 'cites' | 'review';

function sectionStatus(s: PaperSection, run: RunState, firstUndrafted: string | undefined): SectionUiStatus {
    if (s.revised) return 'revised';
    if (s.draft) return run.steps.review === 'active' || run.steps.revise === 'active' ? 'reviewing' : 'draft';
    if (run.steps.draft === 'active' && s.id === firstUndrafted) return 'drafting';
    return 'wait';
}

/** 집필. 스테퍼 · 질문 패널 · 장 카드 · 서랍. */
export function Write(props: {
    projectId: string;
    run: RunState;
    /** 「중단」을 눌러 멈추기를 기다리는 중 */
    stopping: boolean;
    modelLabel: string;
    canStart: boolean;
    hasManuscript: boolean;
    onStart: () => void;
    onCancel: () => void;
    onAnswer: (a: Record<string, Answer>) => void;
    onShowManuscript: () => void;
    onDismissError: () => void;
}) {
    const { run } = props;
    const [tab, setTab] = useState<Tab>('activity');
    const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
    const status = runStatus(run);
    const cites = useMemo(() => citeMap(run.cites), [run.cites]);
    const firstUndrafted = run.sections.find((s) => !s.draft)?.id;
    const reviewCount = Object.values(run.reviews).reduce((a, l) => a + l.length, 0);
    const activeStep = (Object.keys(run.steps) as (keyof typeof run.steps)[]).find((k) => run.steps[k] === 'active');

    const toggle = (id: string) =>
        setOpenIds((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
        });

    return (
        <div className="stage write">
            <div className="toolbar">
                <span className="run-status">
                    <span className={`dot ${status}`} />
                    {RUN_STATUS_KO[status]}
                    {run.running && activeStep && <span className="muted"> · {STAGE_LABEL[activeStep]}</span>}
                </span>
                <span className="muted model" title="집필에 쓰는 모델">
                    {props.modelLabel}
                </span>
                <span className="spacer" />
                {run.running ? (
                    <button onClick={props.onCancel} disabled={props.stopping}>
                        <Square size={13} /> {props.stopping ? '멈추는 중…' : '중단'}
                    </button>
                ) : (
                    <button className="primary" onClick={props.onStart} disabled={!props.canStart} title={props.canStart ? '' : '주제가 비어 있습니다'}>
                        <Play size={14} /> {run.summary || run.restored ? '다시 집필' : '집필 시작'}
                    </button>
                )}
                {props.hasManuscript && (
                    <button onClick={props.onShowManuscript}>
                        <FileText size={14} /> 원고 보기
                    </button>
                )}
            </div>

            <Stepper steps={run.steps} detail={run.stepDetail} />

            <div className="write-body">
                <div className="write-main">
                    {run.error && (
                        <div className="banner error" role="alert">
                            <AlertTriangle size={16} />
                            <span className="banner-text">{run.error}</span>
                            <button className="icon-btn" onClick={props.onDismissError} title="닫기">
                                <X size={14} />
                            </button>
                        </div>
                    )}

                    {run.asks && run.asks.length > 0 && <HitlPanel key={run.asks.map((a) => a.id).join('|')} asks={run.asks} projectId={props.projectId} onSubmit={props.onAnswer} />}

                    {run.sections.length === 0 ? (
                        <div className="empty">
                            {run.running ? (
                                <>
                                    <strong>{activeStep ? `${STAGE_LABEL[activeStep]} 단계입니다.` : '시작하는 중…'}</strong>
                                    <p>목차가 나오면 장 카드가 여기 쌓이고, 장마다 초고 → 검토 → 수정 순으로 채워집니다.</p>
                                </>
                            ) : (
                                <>
                                    <strong>아직 집필하지 않았습니다.</strong>
                                    <p>구상에서 설계를 다듬은 뒤 「집필 시작」을 누르면 조사 → 논지 → 목차 → 초고 → 인용 → 질문 → 연쇄 → 검토 → 보강 → 수정 → 재검증 → 인용 대조 → 조립 순으로 진행됩니다. 위 단계에 마우스를 올리면 설명이 보입니다.</p>
                                    {props.canStart && (
                                        <button className="primary" onClick={props.onStart}>
                                            <Play size={14} /> 집필 시작
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    ) : (
                        <CiteContext.Provider value={cites}>
                            <div className="section-tools">
                                {run.outline?.thesis.title && <span className="outline-title">{run.outline.thesis.title}</span>}
                                <span className="spacer" />
                                <button className="ghost tiny" onClick={() => setOpenIds(new Set(run.sections.map((s) => s.id)))}>
                                    모두 펼치기
                                </button>
                                <button className="ghost tiny" onClick={() => setOpenIds(new Set())}>
                                    모두 접기
                                </button>
                            </div>
                            {run.sections.map((s, i) => (
                                <SectionCard key={s.id} section={s} index={i} status={sectionStatus(s, run, firstUndrafted)} open={openIds.has(s.id)} onToggle={() => toggle(s.id)} reviewCount={run.reviews[s.id]?.length ?? 0} />
                            ))}
                        </CiteContext.Provider>
                    )}
                </div>

                <Drawer
                    storageKey="lps.drawer.write"
                    active={tab}
                    onTab={(id) => setTab(id as Tab)}
                    tabs={[
                        { id: 'activity', label: '활동', icon: <Activity size={14} />, count: run.feed.length },
                        { id: 'cites', label: '인용', icon: <Quote size={14} />, count: run.cites.length },
                        { id: 'review', label: '검토', icon: <Scale size={14} />, count: reviewCount },
                    ]}
                >
                    {tab === 'activity' && <ActivityFeed feed={run.feed} running={run.running} />}
                    {tab === 'cites' && <CiteTable cites={run.cites} />}
                    {tab === 'review' && <ReviewList reviews={run.reviews} sections={run.sections} />}
                </Drawer>
            </div>
        </div>
    );
}
