import { Plus, Sparkles, X } from 'lucide-react';
import type { PaperThesis } from '../../shared/ipc.ts';
import { AutoTextarea } from './AutoTextarea.tsx';

export const emptyThesis = (): PaperThesis => ({ title: '', thesis: '', concepts: [], questions: [], position: '', scope: '', method: '' });

/**
 * 논문 설계 카드. 제목·중심 논지·핵심 개념·연구질문·입장·범위·방법.
 * 모두 편집 가능하고, 바뀔 때마다 onChange 로 올린다(저장은 위에서 디바운스).
 */
export function PlanCard(props: {
    plan: PaperThesis | null;
    onChange: (plan: PaperThesis | null) => void;
    onPropose: () => void;
    proposing: boolean;
    proposeError: string | null;
    canPropose: boolean;
}) {
    const { plan } = props;
    const patch = (p: Partial<PaperThesis>) => props.onChange({ ...(plan ?? emptyThesis()), ...p });

    const proposeBtn = (
        <button className={plan ? '' : 'primary'} onClick={props.onPropose} disabled={props.proposing || !props.canPropose} title={props.canPropose ? '대화를 읽어 카드를 채웁니다' : '먼저 대화를 나누세요'}>
            <Sparkles size={14} /> {props.proposing ? '뽑는 중…' : '대화에서 설계 뽑기'}
        </button>
    );

    if (!plan) {
        return (
            <section className="card plan-card">
                <header className="card-head">
                    <h3>논문 설계</h3>
                </header>
                <div className="plan-empty">
                    <p>아직 설계가 없습니다. 두 가지 길이 있습니다.</p>
                    <ol>
                        <li>
                            왼쪽에서 모델과 논지를 다듬은 뒤 <strong>「대화에서 설계 뽑기」</strong>로 카드를 채웁니다.
                        </li>
                        <li>
                            <strong>「직접 쓰기」</strong>로 빈 카드를 열고 제목·논지·연구질문을 손으로 적습니다.
                        </li>
                    </ol>
                    <p className="hint">설계가 없어도 집필은 시작할 수 있습니다 — 그러면 논지 단계가 대신 설계합니다.</p>
                    <div className="row">
                        {proposeBtn}
                        <button onClick={() => props.onChange(emptyThesis())}>직접 쓰기</button>
                    </div>
                    {props.proposeError && <p className="inline-error">{props.proposeError}</p>}
                </div>
            </section>
        );
    }

    return (
        <section className="card plan-card">
            <header className="card-head">
                <h3>논문 설계</h3>
                <span className="spacer" />
                {proposeBtn}
            </header>
            {props.proposeError && <p className="inline-error">{props.proposeError}</p>}

            <div className="field">
                <label>제목</label>
                <input type="text" value={plan.title} onChange={(e) => patch({ title: e.target.value })} placeholder="논문 제목" />
            </div>
            <div className="field">
                <label>중심 논지</label>
                <AutoTextarea minRows={2} value={plan.thesis} onChange={(e) => patch({ thesis: e.target.value })} placeholder="이 논문이 주장하는 한 가지" />
            </div>

            <div className="field">
                <label>
                    핵심 개념
                    <button className="ghost tiny" onClick={() => patch({ concepts: [...plan.concepts, { term: '', definition: '' }] })}>
                        <Plus size={13} /> 추가
                    </button>
                </label>
                {plan.concepts.length === 0 && <p className="hint">없음</p>}
                {plan.concepts.map((c, i) => (
                    <div className="concept-row" key={i}>
                        <input
                            type="text"
                            value={c.term}
                            placeholder="용어"
                            onChange={(e) => patch({ concepts: plan.concepts.map((x, j) => (j === i ? { ...x, term: e.target.value } : x)) })}
                        />
                        <AutoTextarea
                            minRows={1}
                            value={c.definition}
                            placeholder="정의"
                            onChange={(e) => patch({ concepts: plan.concepts.map((x, j) => (j === i ? { ...x, definition: e.target.value } : x)) })}
                        />
                        <button className="icon-btn" title="빼기" onClick={() => patch({ concepts: plan.concepts.filter((_, j) => j !== i) })}>
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>

            <div className="field">
                <label>
                    연구질문
                    <button className="ghost tiny" onClick={() => patch({ questions: [...plan.questions, ''] })}>
                        <Plus size={13} /> 추가
                    </button>
                </label>
                {plan.questions.length === 0 && <p className="hint">없음</p>}
                {plan.questions.map((q, i) => (
                    <div className="question-row" key={i}>
                        <span className="q-n">Q{i + 1}</span>
                        <AutoTextarea minRows={1} value={q} placeholder="연구질문" onChange={(e) => patch({ questions: plan.questions.map((x, j) => (j === i ? e.target.value : x)) })} />
                        <button className="icon-btn" title="빼기" onClick={() => patch({ questions: plan.questions.filter((_, j) => j !== i) })}>
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>

            <div className="field">
                <label>입장</label>
                <AutoTextarea minRows={1} value={plan.position} onChange={(e) => patch({ position: e.target.value })} placeholder="찬성·반대·절충 — 어느 편에 서는가" />
            </div>
            <div className="field">
                <label>범위</label>
                <AutoTextarea minRows={1} value={plan.scope} onChange={(e) => patch({ scope: e.target.value })} placeholder="다루는 것과 다루지 않는 것" />
            </div>
            <div className="field">
                <label>방법</label>
                <AutoTextarea minRows={1} value={plan.method} onChange={(e) => patch({ method: e.target.value })} placeholder="해석론·비교법·판례 분석 …" />
            </div>
            <div className="row end">
                <button className="ghost tiny danger" onClick={() => props.onChange(null)}>
                    설계 비우기
                </button>
            </div>
        </section>
    );
}
