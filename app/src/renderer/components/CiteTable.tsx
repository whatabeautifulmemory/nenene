import { ExternalLink } from 'lucide-react';
import type { CiteStatus } from '../../shared/ipc.ts';
import { CHECK_KO, KIND_KO, SOURCE_KO, citeTone, citeToneLabel, isWithheld } from '../lib/format.ts';

const openUrl = (url: string) => {
    if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener');
    else void window.legal.openPath(url);
};

/** 인용 상태표. 행을 누르면 URL 이 있을 때 연다. */
export function CiteTable({ cites }: { cites: CiteStatus[] }) {
    if (cites.length === 0) return <div className="empty small">인용 확보 단계가 끝나면 ⟦인용⟧ 마다 원문 확보·대조 상태가 여기에 쌓입니다.</div>;
    const sorted = [...cites].sort((a, b) => a.n - b.n);
    return (
        <table className="cites">
            <thead>
                <tr>
                    <th className="n">#</th>
                    <th>인용</th>
                    <th className="kind">종류</th>
                    <th>상태</th>
                </tr>
            </thead>
            <tbody>
                {sorted.map((c) => (
                    <tr key={`${c.n}-${c.key}`} className={c.url ? 'link' : ''} onClick={() => c.url && openUrl(c.url)} title={c.url ? c.url : c.note ?? undefined}>
                        <td className="n">{c.n}</td>
                        <td className="raw">
                            <span>{c.raw}</span>
                            {c.sections.length > 0 && <span className="muted"> · {c.sections.join(', ')}</span>}
                        </td>
                        <td className="kind">{KIND_KO[c.kind]}</td>
                        <td className="state">
                            <span
                                className="pill cite"
                                data-tone={citeTone(c)}
                                title={
                                    isWithheld(c)
                                        ? `${CHECK_KO[c.check] ?? c.check} — 원문에서 확인되지 않아 조립 전에 본문에서 인용 표시를 뺐습니다(문장은 남김). 각주 대신 원고의 검증 부록에 있습니다.`
                                        : `${CHECK_KO[c.check] ?? c.check} / ${SOURCE_KO[c.source] ?? c.source}`
                                }
                            >
                                {citeToneLabel(c)}
                            </span>
                            <span className="how">
                                {c.how ?? ''}
                                {c.url && <ExternalLink size={11} />}
                            </span>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
