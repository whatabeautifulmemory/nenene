import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, Send } from 'lucide-react';
import type { ChatMessage } from '../../shared/ipc.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { ResearchPanel } from './ResearchPanel.tsx';

/**
 * 구상 대화. 메시지는 ProjectFile.chat 에서 오고, 보내기는 위(Workspace)가 맡는다.
 * Enter 로 보내고 Shift+Enter 로 줄을 바꾼다.
 */
export function Chat(props: { messages: ChatMessage[]; busy: boolean; error: string | null; onSend: (text: string) => void; placeholder?: string }) {
    const [text, setText] = useState('');
    const listRef = useRef<HTMLDivElement | null>(null);
    const [openResearch, setOpenResearch] = useState<Set<number>>(() => new Set());
    const toggleResearch = (i: number) =>
        setOpenResearch((s) => {
            const n = new Set(s);
            if (n.has(i)) n.delete(i);
            else n.add(i);
            return n;
        });
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [props.messages.length, props.busy]);

    const send = () => {
        const t = text.trim();
        if (!t || props.busy) return;
        setText('');
        props.onSend(t);
        taRef.current?.focus();
    };

    return (
        <div className="chat">
            <div className="chat-list" ref={listRef}>
                {props.messages.length === 0 && !props.busy && (
                    <div className="empty">
                        <strong>논지를 같이 만듭니다.</strong>
                        <p>
                            무엇을 주장하고 싶은지, 어떤 판례·조문·사안을 염두에 두는지 말해 보세요. 모델은 조사 자료를 보고 답하고, 자료에 없는 판례·조문은 ⚠ 로 표시합니다.
                            오른쪽 카드가 채워지면 「집필 시작」입니다.
                        </p>
                    </div>
                )}
                {props.messages.map((m, i) => (
                    <div key={i} className={`msg ${m.role}`}>
                        <div className="msg-body">{m.role === 'user' ? <p className="msg-text">{m.content}</p> : <ChatMarkdown text={m.content} variant="chat" />}</div>
                        {m.research && (m.research.count > 0 || (m.research.searches?.length ?? 0) > 0 || (m.research.failed?.length ?? 0) > 0) && (
                            <>
                                <button className={`chip research ${openResearch.has(i) ? 'on' : ''}`} onClick={() => toggleResearch(i)} aria-expanded={openResearch.has(i)} title="무엇을 조사했는지 보기">
                                    <Search size={12} /> {m.research.count > 0 ? `조사 ${m.research.count}건` : '조사 — 새 자료 없음'}
                                    {(m.research.searches?.length ?? 0) > 0 && <span className="muted"> · 검색 {m.research.searches!.length}회</span>}
                                    <ChevronDown size={12} className="chev" />
                                </button>
                                {openResearch.has(i) && <ResearchPanel note={m.research} />}
                            </>
                        )}
                    </div>
                ))}
                {props.busy && (
                    <div className="msg assistant">
                        <div className="msg-body typing">
                            <span />
                            <span />
                            <span />
                        </div>
                    </div>
                )}
                {props.error && <p className="inline-error">{props.error}</p>}
            </div>
            <div className="composer">
                <textarea
                    ref={taRef}
                    rows={2}
                    value={text}
                    placeholder={props.placeholder ?? '논지에 대해 묻거나 제안하세요 — Enter 보내기, Shift+Enter 줄바꿈'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />
                <button className="primary icon-only" onClick={send} disabled={!text.trim() || props.busy} title="보내기 (Enter)">
                    <Send size={16} />
                </button>
            </div>
        </div>
    );
}
