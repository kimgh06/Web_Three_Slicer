// 골든 분리 검증 (S0): golden.mjs 출력을 섹션별로 쪼개 비교한다.
//  - 무서포트 섹션: 서포트 로직을 고쳐도 byte-identical 이어야 한다(무관 경로 회귀 감지)
//  - 서포트 섹션: 임계각 수식 교정 시 "바뀌는 것이 정상" — 변경 여부만 보고
// 사용: node golden_split.mjs <baseline.txt> <current.txt>
import { readFileSync } from 'node:fs'

const split = (path) => {
  const txt = readFileSync(path, 'utf8')
  const out = {}
  let name = '(prologue)', buf = []
  for (const line of txt.split('\n')) {
    if (line.startsWith('=== ')) { out[name] = buf.join('\n'); name = line.trim(); buf = [] }
    else buf.push(line)
  }
  out[name] = buf.join('\n')
  return out
}

const [basePath, curPath] = process.argv.slice(2)
if (!basePath || !curPath) { console.error('usage: node golden_split.mjs <baseline> <current>'); process.exit(2) }
const base = split(basePath), cur = split(curPath)

const isSupport = (name) => /support/i.test(name) && !/no support/i.test(name)
let fail = 0
for (const name of Object.keys(base)) {
  if (name === '(prologue)') continue
  const same = base[name] === cur[name]
  if (isSupport(name)) {
    console.log(`${same ? '=  ' : '≠  '} ${name}  [서포트 — 변경 허용]`)
  } else if (same) {
    console.log(`OK  ${name}  [무서포트 — byte-identical]`)
  } else {
    console.log(`FAIL ${name}  [무서포트인데 변경됨 — 무관 경로 회귀!]`)
    fail++
  }
}
console.log(fail ? `\n${fail} 개 무서포트 섹션이 변경됨 — 회귀 의심` : '\n무서포트 섹션 전부 byte-identical')
process.exit(fail ? 1 : 0)
