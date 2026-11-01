import { useState } from 'react';

/**
 * 새 프로젝트. 빈 칸에서 시작한다 — 이전 주제를 복사해 넣으면 같은 주제의 빈 폴더가 -2, -3 으로
 * 쌓이고, 사용자 눈에는 "기본 데이터가 들어간 프로젝트"로 보인다.
 */
export function NewProjectDialog(props: { workspace: string; onClose: () => void; onCreate: (topic: string, context: string) => Promise<void> }) {
    const [topic, setTopic] = useState('');
    const [context, setContext] = useState('');
    const [busy, setBusy] = useState(false);

    const create = async () => {
        if (!topic.trim() || busy) return;
        setBusy(true);
        try {
            await props.onCreate(topic.trim(), context.trim());
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
            <div className="modal" style={{ width: 'min(600px, 100%)' }} role="dialog" aria-label="새 프로젝트">
                <header>
                    <h2>새 프로젝트</h2>
                    <p>폴더 하나가 주제 하나입니다. 대화·설계·원고·참고문헌·실행 기록이 그 폴더 안에서 같이 움직입니다.</p>
                </header>
                <div className="content">
                    <div className="field">
                        <label>주제</label>
                        <input
                            type="text"
                            autoFocus
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && void create()}
                            placeholder="쟁점이 갈리는 한 문장"
                        />
                    </div>
                    <div className="field">
                        <label>배경·맥락 (선택)</label>
                        <textarea rows={5} value={context} onChange={(e) => setContext(e.target.value)} placeholder="왜 이 글을 쓰는지, 염두에 두는 사안·판례·자료, 밝히고 싶은 입장, 다루지 말아야 할 범위." />
                    </div>
                    {props.workspace && (
                        <p className="hint">
                            위치 <code>{props.workspace}/</code> — 주제·맥락과 빈 <code>references/</code>·<code>runs/</code> 만 만듭니다.
                        </p>
                    )}
                </div>
                <footer>
                    <button className="ghost" onClick={props.onClose}>
                        취소
                    </button>
                    <button className="primary" disabled={!topic.trim() || busy} onClick={() => void create()}>
                        {busy ? '만드는 중…' : '만들기'}
                    </button>
                </footer>
            </div>
        </div>
    );
}
