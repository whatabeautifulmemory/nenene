import { useEffect, useState } from 'react';
import { Download, FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { ProjectMeta } from '../../shared/ipc.ts';
import { ago } from '../lib/format.ts';

/**
 * 프로젝트 목록. 들어갔다 나오면 작업 화면이 언마운트되므로 상태가 저절로 초기화된다 —
 * 셀렉트로 갈아끼우는 대신 화면을 나눈다.
 */
export function Home(props: {
    workspace: string;
    projects: ProjectMeta[];
    onOpen: (p: ProjectMeta) => void;
    onNew: () => void;
    onDelete: (p: ProjectMeta) => void;
    onChangeWorkspace: () => void;
    onOpenFolder: () => void;
}) {
    const corpus = useCorpusStatus();
    return (
        <div className="home">
            <header className="home-head">
                <div>
                    <h1>프로젝트</h1>
                    <p className="hint">폴더 하나가 주제 하나입니다. 대화·설계·원고·참고문헌·실행 기록이 그 폴더 안에서 같이 움직입니다.</p>
                    {corpus.list && (
                        <p className={`hint corpus-line ${corpus.list.warn ? 'warn-text' : ''}`}>
                            {corpus.list.text}
                            {corpus.list.action && (
                                <button className="tiny" onClick={() => void corpus.download()}>
                                    <Download size={13} /> {corpus.list.action}
                                </button>
                            )}
                        </p>
                    )}
                    {corpus.network !== undefined && (
                        <p className="hint corpus-line">
                            GitHub 갱신: {NETWORK_LABEL[corpus.network ?? 'unset']}
                            <button className="tiny" onClick={() => void corpus.switchNetwork(corpus.network === 'yes' ? 'no' : 'yes')}>
                                {corpus.network === 'yes' ? '허용 안 함으로 바꾸기' : '허용으로 바꾸기'}
                            </button>
                        </p>
                    )}
                </div>
                <button onClick={props.onNew} className="primary">
                    <Plus size={15} /> 새 프로젝트
                </button>
            </header>

            <div className="home-ws">
                <code className="path" title={props.workspace}>
                    {props.workspace || '(워크스페이스 없음)'}
                </code>
                <button className="ghost tiny" onClick={props.onChangeWorkspace}>
                    변경
                </button>
                <button className="ghost tiny" onClick={props.onOpenFolder}>
                    <FolderOpen size={13} /> Finder에서 열기
                </button>
            </div>

            {props.projects.length === 0 ? (
                <div className="empty tall">
                    <strong>프로젝트가 없습니다.</strong>
                    <p>「새 프로젝트」로 하나 만들면 폴더와 대화·설계·원고 자리가 함께 생깁니다.</p>
                </div>
            ) : (
                <div className="project-grid">
                    {props.projects.map((p) => {
                        const title = p.title || p.topic || p.id;
                        const sub = p.topic && p.topic !== title ? p.topic : p.id;
                        return (
                            <div key={p.id} className="project-card" onClick={() => props.onOpen(p)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && props.onOpen(p)}>
                                <div className="project-title">{title}</div>
                                <div className="project-sub" title={sub}>
                                    {sub}
                                </div>
                                <div className="project-stage">
                                    {p.hasPaper ? (
                                        <span className="chip accent">원고 있음</span>
                                    ) : p.hasPlan ? (
                                        <span className="chip plan">설계 있음</span>
                                    ) : p.hasPlan === undefined && p.hasPaper === undefined ? (
                                        <span className="chip">실행 {p.runs}</span>
                                    ) : (
                                        <span className="chip">구상 중</span>
                                    )}
                                    {p.runs > 0 && (p.hasPaper !== undefined || p.hasPlan !== undefined) && <span className="muted">실행 {p.runs}</span>}
                                </div>
                                <div className="project-foot">
                                    <span>참고문헌 {p.refs}</span>
                                    <span className="spacer" />
                                    <span title={p.updatedAt}>{ago(p.updatedAt)}</span>
                                    <button
                                        className="icon-btn"
                                        title="휴지통으로 보내기"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            props.onDelete(p);
                                        }}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** GitHub 접근 허용(목록 갱신·원문 가져오기) — null 은 아직 묻지 않음. */
const NETWORK_LABEL: Record<'yes' | 'no' | 'unset', string> = { yes: '허용', no: '허용 안 함', unset: '묻지 않음' };

/**
 * 법령·판례 목록 상태 — 준비가 끝나면 목록 줄은 보이지 않는다. 아직 받지 않았을 때(켤 때 「나중에」), 받는 동안,
 * 또는 실패했을 때만 한 줄. 받지 않았거나 실패했으면 그 줄에 「받기」를 단다.
 * 그 아래 GitHub 접근 허용 줄은 늘 보인다(허용 / 허용 안 함 / 묻지 않음, 단추 하나로 바꾼다). 「받기」를 누르면 허용이다.
 */
function useCorpusStatus(): {
    list: { text: string; warn: boolean; action?: string } | null;
    network: 'yes' | 'no' | null | undefined;
    download: () => Promise<void>;
    switchNetwork: (v: 'yes' | 'no') => Promise<void>;
} {
    const [st, setSt] = useState<{ text: string; warn: boolean; action?: string } | null>(null);
    const [network, setNetwork] = useState<'yes' | 'no' | null | undefined>(undefined);
    const download = async () => {
        setSt({ text: '법령·판례 목록을 준비하는 중입니다', warn: false });
        await window.legal.corpusDownload();
        setNetwork('yes');
    };
    const switchNetwork = async (v: 'yes' | 'no') => setNetwork(await window.legal.corpusNetwork(v));
    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let listReady = false;
        const poll = async () => {
            try {
                // 허용 여부는 계속 본다 — 켤 때 물은 창의 답이 홈에 바로 보이게. 목록 상태는 준비될 때까지만(조회가 인덱스 파일을 읽는다).
                const n = await window.legal.corpusNetwork();
                if (!alive) return;
                setNetwork(n);
                if (!listReady) {
                    const c = await window.legal.corpusStatus();
                    if (!alive) return;
                    if (c.ready) {
                        listReady = true;
                        setSt(null);
                    } else if (c.error) setSt({ text: `법령·판례 목록을 받지 못했습니다 — 네트워크를 확인하세요. (${c.error.slice(0, 120)})`, warn: true, action: '다시 받기' });
                    else if (c.preparing || c.consented) setSt({ text: `법령·판례 목록을 준비하는 중입니다${c.message ? ` — ${c.message}` : ''}`, warn: false });
                    else setSt({ text: '법령·판례 목록이 아직 없습니다. 구상·설계는 할 수 있고, 집필하려면 받아야 합니다(12MB 안팎, 보통 몇 초).', warn: false, action: '받기' });
                }
                timer = setTimeout(() => void poll(), listReady ? 3000 : 1500);
            } catch {
                /* 상태 조회 실패는 조용히 */
            }
        };
        void poll();
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, []);
    return { list: st, network, download, switchNetwork };
}
