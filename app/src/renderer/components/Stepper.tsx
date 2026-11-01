import { Check, Minus, X } from 'lucide-react';
import { STAGES, type StageId } from '../../shared/ipc.ts';

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'error';

export const STEP_KO: Record<StepStatus, string> = { pending: '대기', active: '진행', done: '완료', skipped: '건너뜀', error: '오류' };

export function emptySteps(): Record<StageId, StepStatus> {
    return { research: 'pending', thesis: 'pending', outline: 'pending', draft: 'pending', cite: 'pending', hitl: 'pending', snowball: 'pending', review: 'pending', gapfill: 'pending', revise: 'pending', reverify: 'pending', citecheck: 'pending', assemble: 'pending' };
}

/**
 * 가로 스테퍼(단계 수는 STAGES 를 따른다). 상태는 stage 이벤트에서 온다.
 * 칸 아래 설명은 두 줄까지 보이고, 올리면 풀어 쓴 설명·상태·진행 내용이 말풍선으로 바로 뜬다(브라우저 title 은 늦게 떠서 쓰지 않는다).
 * 양 끝 두 칸의 말풍선은 창 밖으로 나가지 않게 안쪽으로 붙인다.
 */
export function Stepper({ steps, detail }: { steps: Record<StageId, StepStatus>; detail: Partial<Record<StageId, string>> }) {
    return (
        <ol className="stepper" aria-label="집필 단계">
            {STAGES.map((s, i) => {
                const st = steps[s.id];
                const d = detail[s.id];
                const edge = i < 2 ? 'start' : i >= STAGES.length - 2 ? 'end' : undefined;
                return (
                    <li key={s.id} className="step" data-status={st} tabIndex={0} aria-describedby={`step-tip-${s.id}`}>
                        <span className="step-dot">
                            {st === 'done' ? <Check size={12} strokeWidth={3} /> : st === 'error' ? <X size={12} strokeWidth={3} /> : st === 'skipped' ? <Minus size={12} strokeWidth={3} /> : <span className="step-n">{i + 1}</span>}
                        </span>
                        <span className="step-label">{s.label}</span>
                        <span className="step-hint">{st === 'active' && d ? d : s.hint}</span>
                        <span className="step-tip" role="tooltip" id={`step-tip-${s.id}`} data-edge={edge}>
                            <span className="step-tip-head">
                                <b>
                                    {i + 1}. {s.label}
                                </b>
                                <span className={`step-tip-status ${st}`}>{STEP_KO[st]}</span>
                            </span>
                            <span>{s.desc}</span>
                            {d && <span className="step-tip-detail">{d}</span>}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}
