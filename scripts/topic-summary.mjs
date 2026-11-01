// 워크스페이스의 프로젝트들을 훑어 비교표를 낸다.
//
//   node scripts/topic-summary.mjs ["워크스페이스 경로"]
//
// 각 프로젝트의 **가장 최근 실행** 원장을 읽는다. 주제를 여러 개 돌려놓고 어느 것이 검토가
// 실제로 진행됐는지 보려면 원장을 하나씩 열어야 하는데, 그건 비교가 아니라 노가다다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ws = process.argv[2] ?? join(homedir(), 'Documents', 'Nenene');
if (!existsSync(ws)) {
    console.error(`워크스페이스가 없습니다: ${ws}`);
    process.exit(1);
}

const VK = { supported: '지지', weak: '박약', refuted: '반박', unresolved: '미결' };
const rows = [];

for (const id of readdirSync(ws)) {
    const dir = join(ws, id);
    const runs = join(dir, 'runs');
    if (!existsSync(runs)) continue;
    const stamps = readdirSync(runs).filter((n) => !n.startsWith('.') && !n.endsWith('.log')).sort();
    let led = null;
    let stamp = '';
    for (const s of [...stamps].reverse()) {
        const p = join(runs, s, 'ledger.json');
        if (existsSync(p)) {
            try {
                led = JSON.parse(readFileSync(p, 'utf8'));
                stamp = s;
                break;
            } catch {
                /* 깨진 원장은 건너뛴다 */
            }
        }
    }
    if (!led) continue;
    const items = led.issues.flatMap((i) => i.items);
    const withdrawn = led.issues.reduce((a, i) => a + (i.withdrawn?.length ?? 0), 0);
    const v = {};
    for (const it of items) v[it.judgment.verdict] = (v[it.judgment.verdict] ?? 0) + 1;
    const surv = items.reduce((a, it) => a + it.judgment.surviving.length, 0);
    const rev = items.filter((it) => it.original).length;
    rows.push({
        id,
        stamp,
        claims: items.length,
        withdrawn,
        cit: led.coverage?.citations ?? 0,
        ok: led.coverage?.verified ?? 0,
        block: led.coverage?.blocking ?? 0,
        v,
        surv,
        rev,
        paper: existsSync(join(runs, stamp, 'paper.md')),
    });
}

rows.sort((a, b) => a.id.localeCompare(b.id));
const pad = (s, n) => String(s).padEnd(n);
console.log(
    pad('프로젝트', 30) + pad('명제', 6) + pad('철회', 6) + pad('인용(확인)', 12) + pad('판정', 26) + pad('수정', 6) + pad('반대', 6) + '논문',
);
console.log('─'.repeat(104));
for (const r of rows) {
    const v = Object.entries(r.v)
        .map(([k, n]) => `${VK[k] ?? k}${n}`)
        .join(' ');
    console.log(
        pad(r.id.slice(0, 29), 30) +
            pad(r.claims, 6) +
            pad(r.withdrawn, 6) +
            pad(`${r.cit}(${r.ok})`, 12) +
            pad(v, 26) +
            pad(r.rev, 6) +
            pad(r.surv, 6) +
            (r.paper ? 'O' : '-'),
    );
}
console.log(`\n${rows.length}개 프로젝트 · ${ws}`);
