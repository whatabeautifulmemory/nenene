#!/usr/bin/env bash
# 예전 진입점. 준비 루틴은 이제 src/law/legalize.ts(ensureLegalize) 안에 있다 — bash 가 없는 윈도우에서도 돌도록.
# git 이 있으면 blobless clone, 없으면 GitHub HTTP 로 목록을 받는다. 이 스크립트는 그걸 부르기만 한다.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx src/cli.ts --check
