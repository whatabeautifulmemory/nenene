import type { CiteStatus } from '../../shared/ipc.ts';
import { KIND_KO, citeTone, citeToneLabel, truncate } from '../lib/format.ts';

/**
 * 본문 안의 ⟦인용⟧. 번호가 매겨졌으면 번호, 아니면 원문 일부를 보여주고 색으로 상태를 말한다.
 * 색의 규칙은 lib/format.ts 의 citeTone — 원고 각주의 ✓/◐/⚠/✗ 와 같은 판단이다.
 */
export function CiteBadge({ raw, status }: { raw: string; status: CiteStatus | undefined }) {
    const tone = citeTone(status);
    const title = status
        ? `${raw}\n${KIND_KO[status.kind]} · ${citeToneLabel(status)}${status.how ? ` · ${status.how}` : ''}${status.note ? `\n${status.note}` : ''}`
        : `${raw}\n인용 확보 전`;
    return (
        <span className="cite-badge" data-tone={tone} title={title}>
            {status ? <b>{status.n}</b> : null}
            <span className="cite-raw">{truncate(raw, 34)}</span>
        </span>
    );
}
