// OpenAI 호환 엔드포인트를 흉내내는 로컬 서버. **테스트 전용.**
//
// 목적: `npm run run` 의 실제 HTTP 경로를 키 없이 검증한다. mockAsker 는 파이프라인만 시험하고
// llm.ts 는 한 줄도 지나가지 않는다 — 강제 툴 호출 본문, tool_calls 파싱, salvage, zod 검증,
// 2순위 경로 강등이 전부 미검증으로 남는다. 실제 모델을 붙이기 전에 그 배관을 여기서 확인한다.
//
//   npx tsx scripts/fake-provider.ts [--port 8787] [--reject-tool-choice]
//
// --reject-tool-choice: 강제 툴 호출을 400 으로 거절한다. llm.ts 가 response_format 경로로
// 넘어가는지(=엔드포인트가 tool_choice 를 안 받는 경우) 확인하는 용도.
import { createServer } from 'node:http';
import { ABSTRACT, CLAIMS, EXTRACTS, ISSUES, JUDGMENTS, OBJECTIONS, OUTLINE, THESIS, mockWriter } from '../src/mock.ts';

const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8787;
const rejectToolChoice = process.argv.includes('--reject-tool-choice');

/** 프롬프트에 들어 있는 명제로 fixture 를 고른다 — 순서에 기대지 않는다 (mock.ts 와 같은 규칙). */
const claimKeyIn = (text: string): string | undefined => {
    for (const c of CLAIMS.claims) if (text.includes(c.proposition.slice(0, 40))) return c.id;
    return undefined;
};

const fixtureFor = (name: string, userText: string): unknown => {
    switch (name) {
        case 'issues':
            return ISSUES;
        case 'claims':
            return CLAIMS;
        case 'revision': {
            const k = claimKeyIn(userText);
            const c = CLAIMS.claims.find((x) => x.id === k);
            if (!c) throw new Error('revision fixture 없음');
            return {
                claimId: c.id,
                proposition: c.proposition,
                premise: c.premise,
                step: c.step,
                keep_authorities: c.authority.map((a) => a.citation),
                changes: [],
                withdraw: false,
            };
        }
        case 'objections': {
            const k = claimKeyIn(userText);
            if (!k) throw new Error('objection fixture 없음');
            return { objections: [OBJECTIONS[k]] };
        }
        case 'judgments': {
            const k = claimKeyIn(userText);
            if (!k) throw new Error('judgment fixture 없음');
            return { judgments: [JUDGMENTS[k]] };
        }
        // 초고→검증→수정 파이프라인
        case 'thesis':
            return THESIS;
        case 'outline':
            return OUTLINE;
        case 'claims_extract': {
            const m = /## 장:\s*[IVX]+\.\s*(.+)/.exec(userText);
            const sec = OUTLINE.sections.find((x) => x.title === m?.[1]?.trim());
            return { claims: (sec && EXTRACTS[sec.id]) ?? [] };
        }
        case 'abstract':
            return ABSTRACT;
        case 'search_queries':
            return { queries: [] };
        case 'ref_pick':
            return { picks: [] };
        case 'gap_needs':
            return { needs: [] };
        case 'cite_check':
            return { checks: [...userText.matchAll(/### \[([^\]]+)\]/g)].map((m) => ({ id: m[1], verdict: 'supported', reason: '시험용' })) };
        case 'case_rerank':
            return { picks: [] };
        default:
            throw new Error(`unknown tool: ${name}`);
    }
};

const writer = mockWriter();

const userTextOf = (body: any): string =>
    (body?.messages ?? [])
        .filter((m: any) => m?.role === 'user')
        .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');

createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('not found');
        return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
        let body: any;
        try {
            body = JSON.parse(raw);
        } catch {
            res.writeHead(400).end('bad json');
            return;
        }
        const toolName = body?.tools?.[0]?.function?.name;
        const usesToolChoice = !!body?.tool_choice;
        const userText = userTextOf(body);

        if (rejectToolChoice && usesToolChoice) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(
                JSON.stringify({ error: { message: 'tool_choice is not supported' } }),
            );
            return;
        }

        if (!toolName && !body?.response_format) {
            // plain completion — 장 집필·수정. 시스템 프롬프트로 역할을 가른다.
            const sys = String(body?.messages?.find((m: any) => m?.role === 'system')?.content ?? '');
            const name = /검증 결과에 비추어 고쳐 쓰는/.test(sys) ? 'revise' : 'chapter';
            void (async () => {
                try {
                    const text = await writer({ name, system: sys, user: userText });
                    res.writeHead(200, { 'content-type': 'application/json' }).end(
                        JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1200, completion_tokens: 700 } }),
                    );
                } catch (e) {
                    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e) } }));
                }
            })();
            return;
        }

        if (!toolName) {
            // response_format 경로. 스키마 이름은 body 에 실려 온다 — 프롬프트를 추측하지 않는다.
            const named = body?.response_format?.json_schema?.name;
            try {
                const payload = fixtureFor(String(named), userText);
                res.writeHead(200, { 'content-type': 'application/json' }).end(
                    JSON.stringify({
                        choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(payload) + '\n```' } }],
                        usage: { prompt_tokens: 900, completion_tokens: 400 },
                    }),
                );
            } catch (e) {
                res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e) } }));
            }
            return;
        }

        try {
            const payload = fixtureFor(toolName, userText);
            res.writeHead(200, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                role: 'assistant',
                                tool_calls: [
                                    { id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(payload) } },
                                ],
                            },
                        },
                    ],
                    usage: { prompt_tokens: 900, completion_tokens: 400 },
                }),
            );
        } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e) } }));
        }
    });
}).listen(port, '127.0.0.1', () => {
    process.stderr.write(`fake provider: http://127.0.0.1:${port}/v1${rejectToolChoice ? ' (tool_choice 거절)' : ''}\n`);
});
