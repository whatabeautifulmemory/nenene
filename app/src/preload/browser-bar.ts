// 원문 찾기 브라우저의 도구막대 — 우리 파일(bar.html)만 이 preload 를 쓴다. 페이지 쪽에는 preload 가 없다.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('srcbar', {
    nav: (url: string) => ipcRenderer.send('srcbar:nav', url),
    back: () => ipcRenderer.send('srcbar:back'),
    forward: () => ipcRenderer.send('srcbar:forward'),
    reload: () => ipcRenderer.send('srcbar:reload'),
    addPage: () => ipcRenderer.send('srcbar:add-page'),
    close: () => ipcRenderer.send('srcbar:close'),
    selectTab: (id: number) => ipcRenderer.send('srcbar:tab-select', id),
    closeTab: (id: number) => ipcRenderer.send('srcbar:tab-close', id),
    ready: () => ipcRenderer.send('srcbar:ready'),
    onState: (cb: (s: unknown) => void) => {
        ipcRenderer.on('srcbar:state', (_e, s) => cb(s));
    },
    onFocusUrl: (cb: () => void) => {
        ipcRenderer.on('srcbar:focus-url', () => cb());
    },
});
