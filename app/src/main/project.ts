// 프로젝트 폴더. 기존 구현 로컬모드처럼 **한 폴더 안에 여러 주제**를 둔다.
//
// 주제 하나가 폴더 하나다:
//
//   <workspace>/
//     가상자산-위장수사/
//       project.json      주제·맥락·원고·최근 실행
//       references/       참고문헌 (pdf·docx·md·txt) — 파이프라인의 사전제공 파일
//       runs/<시각>/      ledger.json · report.md · paper.md · calls.jsonl · transcript.jsonl
//
// 왜 폴더로 두나: 주제별로 원고·참고문헌·실행 기록이 같이 움직여야 하고, 그것을 사람이
// Finder 에서 열어볼 수 있어야 한다. DB 에 넣으면 감사도 백업도 남의 일이 된다.
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectFile } from '../shared/ipc.ts';

export interface ProjectMeta {
    id: string;
    dir: string;
    title: string;
    topic: string;
    runs: number;
    refs: number;
    updatedAt: string;
    hasPlan?: boolean;
    hasPaper?: boolean;
}

const DEFAULT_WS = () => join(app.getPath('documents'), 'Nenene');

export function defaultWorkspace(): string {
    return DEFAULT_WS();
}

/** 주제 → 폴더 이름. 한글은 살리고, 경로 구분자만 지운다. */
export function slugOf(topic: string): string {
    const s = topic
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return s || 'project';
}

export function ensureDir(p: string): string {
    mkdirSync(p, { recursive: true });
    return p;
}

export function projectDir(workspace: string, id: string): string {
    return join(workspace, id);
}

export function readProject(dir: string): ProjectFile | null {
    try {
        return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as ProjectFile;
    } catch {
        return null;
    }
}

export function writeProject(dir: string, p: ProjectFile): void {
    ensureDir(dir);
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...p, savedAt: new Date().toISOString() }, null, 2));
}

export function listProjects(workspace: string): ProjectMeta[] {
    if (!existsSync(workspace)) return [];
    const out: ProjectMeta[] = [];
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dir = join(workspace, entry.name);
        const p = readProject(dir);
        if (!p) continue;
        const runsDir = join(dir, 'runs');
        const refsDir = join(dir, 'references');
        out.push({
            id: entry.name,
            dir,
            title: entry.name,
            topic: p.topic ?? '',
            runs: existsSync(runsDir) ? readdirSync(runsDir).filter((n) => !n.startsWith('.')).length : 0,
            refs: existsSync(refsDir) ? readdirSync(refsDir).filter((n) => !n.startsWith('.')).length : 0,
            updatedAt: p.savedAt ?? '',
            hasPlan: Boolean(p.plan?.thesis?.trim()),
            hasPaper: Boolean(p.manuscript?.trim()),
        });
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/** 새 프로젝트. 같은 이름이 있으면 -2, -3 을 붙인다. */
export function createProject(workspace: string, topic: string, context = ''): ProjectMeta {
    ensureDir(workspace);
    const base = `${new Date().toISOString().slice(0, 10)}-${slugOf(topic)}`;
    let id = base;
    for (let i = 2; existsSync(join(workspace, id)); i++) id = `${base}-${i}`;
    const dir = join(workspace, id);
    ensureDir(join(dir, 'references'));
    ensureDir(join(dir, 'runs'));
    writeProject(dir, { version: 1, topic, context, manuscript: '', extraCorpus: [], chat: [], plan: null, scale: 'standard', savedAt: '' });
    return { id, dir, title: id, topic, runs: 0, refs: 0, updatedAt: new Date().toISOString() };
}

export interface RefFile {
    name: string;
    size: number;
    ext: string;
    path: string;
}

const REF_EXT = new Set(['.pdf', '.docx', '.md', '.txt', '.html', '.htm']);

export function listRefs(dir: string): RefFile[] {
    const refs = join(dir, 'references');
    if (!existsSync(refs)) return [];
    return readdirSync(refs)
        .filter((n) => !n.startsWith('.') && REF_EXT.has(n.slice(n.lastIndexOf('.')).toLowerCase()))
        .map((n) => {
            const p = join(refs, n);
            return { name: n, size: statSync(p).size, ext: n.slice(n.lastIndexOf('.')).toLowerCase(), path: p };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** 참고문헌을 프로젝트 폴더로 복사한다. 원본을 옮기지 않는다 — 사용자의 파일을 건드리지 않는다. */
export function addRefs(dir: string, files: string[]): RefFile[] {
    const refs = ensureDir(join(dir, 'references'));
    const { copyFileSync } = require('node:fs') as typeof import('node:fs');
    for (const f of files) {
        const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
        if (!REF_EXT.has(ext)) continue;
        let target = join(refs, basename(f));
        for (let i = 2; existsSync(target); i++) {
            const stem = basename(f).slice(0, basename(f).lastIndexOf('.'));
            target = join(refs, `${stem}-${i}${ext}`);
        }
        copyFileSync(f, target);
    }
    return listRefs(dir);
}
