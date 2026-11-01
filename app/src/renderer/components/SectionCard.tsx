import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { PaperSection } from '../../shared/ipc.ts';
import { ROLE_KO, roman } from '../lib/format.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';

export type SectionUiStatus = 'wait' | 'drafting' | 'draft' | 'reviewing' | 'revised';

export const SECTION_STATUS_KO: Record<SectionUiStatus, string> = { wait: '대기', drafting: '집필 중', draft: '초고', reviewing: '검토 중', revised: '수정됨' };

/**
 * 장 카드. 접힌 채로는 제목·역할·요지·상태만, 펼치면 본문(수정본 우선)을 ⟦⟧ 배지와 함께 그린다.
 * 인용 상태는 CiteContext 로 위에서 내려온다 — 카드마다 표를 들고 다니지 않는다.
 */
export function SectionCard(props: { section: PaperSection; index: number; status: SectionUiStatus; open: boolean; onToggle: () => void; reviewCount: number }) {
    const { section: s, status } = props;
    const [which, setWhich] = useState<'latest' | 'draft'>('latest');
    const latest = s.revised ?? s.draft;
    const text = which === 'draft' ? s.draft : latest;
    const chars = latest?.length ?? 0;

    return (
        <article className={`section-card ${props.open ? 'open' : ''}`} data-status={status}>
            <header className="section-head" onClick={props.onToggle}>
                <span className="section-caret">{props.open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                <span className="section-num">{s.number || roman(props.index + 1)}</span>
                <span className="section-title">{s.title}</span>
                <span className="chip role">{ROLE_KO[s.role] ?? s.role}</span>
                {props.reviewCount > 0 && <span className="chip">검토 {props.reviewCount}</span>}
                {chars > 0 && <span className="section-chars">{chars.toLocaleString()}자</span>}
                <span className="chip status" data-status={status}>
                    {SECTION_STATUS_KO[status]}
                </span>
            </header>
            {!props.open && s.brief && <p className="section-brief">{s.brief}</p>}
            {props.open && (
                <div className="section-body">
                    <div className="section-meta">
                        {s.brief && <p className="section-brief">{s.brief}</p>}
                        {s.claims.length > 0 && (
                            <ul className="section-claims">
                                {s.claims.map((c, i) => (
                                    <li key={i}>{c}</li>
                                ))}
                            </ul>
                        )}
                        {s.revised && s.draft && (
                            <div className="seg mini">
                                <button className={which === 'latest' ? 'on' : ''} onClick={() => setWhich('latest')}>
                                    수정본
                                </button>
                                <button className={which === 'draft' ? 'on' : ''} onClick={() => setWhich('draft')}>
                                    초고
                                </button>
                            </div>
                        )}
                    </div>
                    {text ? (
                        <ChatMarkdown text={text} variant="section" />
                    ) : (
                        <p className="empty-inline">{status === 'drafting' ? '이 장을 쓰는 중입니다…' : '아직 쓰지 않았습니다.'}</p>
                    )}
                </div>
            )}
        </article>
    );
}
