import { useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { LedgerItem, PaperSection } from '../../shared/ipc.ts';
import { VERDICT_KO, roman } from '../lib/format.ts';

export function VerdictPill({ item }: { item: LedgerItem }) {
    const v = item.judgment.verdict;
    return (
        <span className={`pill verdict ${v}`} title={item.judgment.reasoning}>
            {VERDICT_KO[v]}
            {typeof item.judgment.confidence === 'number' ? <small>{item.judgment.confidence.toFixed(2)}</small> : null}
        </span>
    );
}

function ReviewItem({ item }: { item: LedgerItem }) {
    const [open, setOpen] = useState(false);
    const j = item.judgment;
    return (
        <div className={`review-item ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)}>
            <div className="review-head">
                <VerdictPill item={item} />
                {item.downgrade && (
                    <span className="chip warn" title={`${item.downgrade.from} → ${item.downgrade.to}: ${item.downgrade.why}`}>
                        <ArrowDown size={11} /> 강등
                    </span>
                )}
                <code className="muted">{item.claim.id}</code>
            </div>
            <p className="review-prop">{item.claim.proposition}</p>
            <p className="review-obj">
                <b>반대</b> <span className="muted">({item.objection.attack})</span> {item.objection.objection}
            </p>
            {j.surviving.length > 0 && (
                <ul className="review-surviving">
                    {j.surviving.map((s, i) => (
                        <li key={i}>{s}</li>
                    ))}
                </ul>
            )}
            {open && (
                <div className="review-more">
                    {item.claim.span && (
                        <p>
                            <b>본문</b> {item.claim.span}
                        </p>
                    )}
                    <p>
                        <b>전제</b> {item.claim.premise}
                    </p>
                    <p>
                        <b>도약</b> {item.claim.step}
                    </p>
                    <p>
                        <b>반대를 죽이는 것</b> {item.objection.defeat}
                    </p>
                    <p>
                        <b>판정</b> {j.reasoning}
                    </p>
                    {j.discriminators.length > 0 && (
                        <p>
                            <b>뒤집을 수 있는 것</b> {j.discriminators.join(' / ')}
                        </p>
                    )}
                    {item.downgrade && (
                        <p className="warn-text">
                            <b>강등</b> {item.downgrade.from} → {item.downgrade.to} — {item.downgrade.why}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

/** 장별로 묶인 검토 결과. */
export function ReviewList({ reviews, sections }: { reviews: Record<string, LedgerItem[]>; sections: PaperSection[] }) {
    const ids = Object.keys(reviews);
    if (ids.length === 0) return <div className="empty small">검토 단계에서 장마다 하중을 지는 주장을 뽑아 반대를 세우고 판정합니다. 결과가 여기에 쌓입니다.</div>;
    // 목차 순서로. 목차에 없는 id 는 뒤에.
    const order = new Map(sections.map((s, i) => [s.id, i]));
    ids.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
    return (
        <div className="review-list">
            {ids.map((id) => {
                const idx = order.get(id);
                const sec = idx === undefined ? undefined : sections[idx];
                const items = reviews[id] ?? [];
                return (
                    <section key={id} className="review-group">
                        <h4>
                            <span className="section-num">{sec?.number || (idx === undefined ? '' : roman(idx + 1))}</span> {sec?.title ?? id}
                            <span className="muted"> · {items.length}</span>
                        </h4>
                        {items.map((it) => (
                            <ReviewItem key={it.claim.id} item={it} />
                        ))}
                    </section>
                );
            })}
        </div>
    );
}
