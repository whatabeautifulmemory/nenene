// Electron 실행기.
//
// ELECTRON_RUN_AS_NODE=1 이 설정된 셸에서 electron 을 그냥 띄우면, Electron 이 **일반 node 로**
// 동작해서 require('electron') 이 npm 패키지(바이너리 경로 문자열)를 돌려준다. 그러면 앱은
// "Cannot read properties of undefined (reading 'app')" 으로 죽는다 — 코드 버그처럼 보이지만
// 환경변수 하나 때문이다. 여기서 지우고 띄운다.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 코퍼스 루트(legalize 인덱스·캐시)는 프로젝트 디렉터리다. 앱은 그 안의 app/ 에 있다.
env.LEGAL_AGENT_ROOT = env.LEGAL_AGENT_ROOT || resolve(process.cwd(), '..');

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
