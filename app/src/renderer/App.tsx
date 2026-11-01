import { useCallback, useEffect, useState } from 'react';
import { Monitor, Moon, Settings as SettingsIcon, Sun } from 'lucide-react';
import { keyScope, type ProjectMeta, type ProviderDef, type Settings } from '../shared/ipc.ts';
import { Home } from './screens/Home.tsx';
import { Workspace } from './screens/Workspace.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { NewProjectDialog } from './components/NewProjectDialog.tsx';
import { Titlebar } from './components/Titlebar.tsx';

declare global {
    interface Window {
        legal: import('../shared/ipc.ts').LegalApi;
    }
}

/**
 * 앱 루트. 전역 상태(설정·provider·테마·워크스페이스)만 들고, 프로젝트 화면은 따로 산다.
 * Workspace 는 프로젝트 id 를 key 로 마운트되므로 프로젝트를 바꾸면 상태가 저절로 비워진다.
 */
/** 설정의 모델 키가 보관된 이름(주소를 바꿀 수 있는 공급자는 주소별). */
function scopeOf(providers: ProviderDef[], s: Settings): string {
    const def = providers.find((p) => p.id === s.provider);
    const endpoint = def?.endpointEditable ? (s.endpoints?.[def.id] ?? '').trim() : '';
    return keyScope(def, endpoint || def?.baseUrl) || s.provider;
}

export function App() {
    const [providers, setProviders] = useState<ProviderDef[]>([]);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [hasKey, setHasKey] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showNew, setShowNew] = useState(false);

    const [workspace, setWorkspace] = useState('');
    const [projects, setProjects] = useState<ProjectMeta[]>([]);
    const [open, setOpen] = useState<ProjectMeta | null>(null);
    const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');

    const refresh = useCallback(async () => {
        setProjects(await window.legal.projectsList());
    }, []);

    useEffect(() => {
        void (async () => {
            const [p, s, ws, list] = await Promise.all([window.legal.providers(), window.legal.getSettings(), window.legal.workspaceGet(), window.legal.projectsList()]);
            setProviders(p);
            setSettings(s);
            setTheme(s.theme ?? 'system');
            setWorkspace(ws);
            setProjects(list);
            setHasKey(await window.legal.hasKey(scopeOf(p, s)));
        })();
    }, []);

    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const apply = () => {
            document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
        };
        apply();
        mq.addEventListener('change', apply);
        return () => mq.removeEventListener('change', apply);
    }, [theme]);

    if (!settings) {
        return (
            <div className="app">
                <Titlebar />
                <div className="empty">불러오는 중…</div>
            </div>
        );
    }

    const cycleTheme = async () => {
        const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
        setTheme(next);
        setSettings(await window.legal.saveSettings({ ...settings, theme: next }));
    };

    return (
        <>
            {open ? (
                <Workspace
                    key={open.id}
                    project={open}
                    providers={providers}
                    settings={settings}
                    onBack={async () => {
                        setOpen(null);
                        await refresh();
                    }}
                    onSettings={() => setShowSettings(true)}
                    onProjectChanged={() => void refresh()}
                />
            ) : (
                <div className="app">
                    <Titlebar
                        right={
                            <>
                                <button className="ghost icon-only" onClick={() => void cycleTheme()} title={`테마: ${theme === 'system' ? '시스템' : theme === 'dark' ? '다크' : '라이트'}`}>
                                    {theme === 'system' ? <Monitor size={15} /> : theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                                </button>
                                <button className="ghost icon-only" onClick={() => setShowSettings(true)} title="설정">
                                    <SettingsIcon size={16} />
                                </button>
                            </>
                        }
                    />
                    <Home
                        workspace={workspace}
                        projects={projects}
                        onOpen={(p) => setOpen(p)}
                        onNew={() => setShowNew(true)}
                        onDelete={async (p) => {
                            const r = await window.legal.projectDelete(p.id);
                            if (r.deleted) await refresh();
                        }}
                        onChangeWorkspace={async () => {
                            const ws = await window.legal.workspaceChoose();
                            if (ws) {
                                setWorkspace(ws);
                                await refresh();
                            }
                        }}
                        onOpenFolder={() => void window.legal.openPath(workspace)}
                    />
                </div>
            )}

            {showNew && (
                <NewProjectDialog
                    workspace={workspace}
                    onClose={() => setShowNew(false)}
                    onCreate={async (t, c) => {
                        const created = await window.legal.projectCreate(t, c);
                        setShowNew(false);
                        await refresh();
                        setOpen(created);
                    }}
                />
            )}

            {showSettings && (
                <SettingsDialog
                    providers={providers}
                    settings={settings}
                    hasKey={hasKey}
                    workspace={workspace}
                    onClose={() => setShowSettings(false)}
                    onWorkspaceChanged={async (ws) => {
                        setWorkspace(ws);
                        await refresh();
                    }}
                    onSaved={async (s) => {
                        setSettings(s);
                        setTheme(s.theme ?? 'system');
                        setHasKey(await window.legal.hasKey(scopeOf(providers, s)));
                        setShowSettings(false);
                    }}
                />
            )}
        </>
    );
}
