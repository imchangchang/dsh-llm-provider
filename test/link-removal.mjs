// 目录链清理回归（issue #4 更正二 / #6）：摘链绝不能碰链目标。
//
// 背景：Windows 上桥接用的链是 junction，Node 24.15 起（dsh 自带运行时 electron 43 / node 24.18）
// `rmSync(link, { recursive: true })` 会把 **junction 目标目录的内容**一起删掉，只留空壳；
// 同一句在 node ≤ 24.14 上只是摘链。链指向 dsh 自带那份 pi-ai 时，等于每启动一次就清空宿主那份。
// 这里用 POSIX 软链与 Windows junction 都能跑的形态验证 removeLinkOrDir：
//   链 → 只摘链，目标一个字节不动；真目录 → 才递归删，且必须在允许的根内。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeLinkOrDir } from '../lib/bridge.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

const root = mkdtempSync(join(tmpdir(), 'dsh-link-removal-'))
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

// ---- 1) 链：目标是宿主那份 pi-ai，摘链后必须原封不动 ----
const target = join(root, 'host-pi-ai')
mkdirSync(join(target, 'dist'), { recursive: true })
writeFileSync(join(target, 'package.json'), '{"name":"@earendil-works/pi-ai","version":"0.85.1"}')
writeFileSync(join(target, 'dist', 'index.js'), 'export const ok = true\n')

const linkDir = join(root, 'bridge', 'node_modules', '@earendil-works')
mkdirSync(linkDir, { recursive: true })
const link = join(linkDir, 'pi-ai')
symlinkSync(target, link, linkType)

removeLinkOrDir(link, root)
check('链本身被摘掉', !existsSync(link))
check('目标 package.json 还在', existsSync(join(target, 'package.json')))
check('目标 dist/index.js 还在', existsSync(join(target, 'dist', 'index.js')))
check('目标内容一字未动', readFileSync(join(target, 'package.json'), 'utf8').includes('0.85.1'))

// ---- 2) 链可以重复清（幂等），断链也要能摘 ----
removeLinkOrDir(link, root)
check('重复清一条不存在的路径不抛', true)
const danglingTarget = join(root, 'gone')
symlinkSync(danglingTarget, link, linkType)
removeLinkOrDir(link, root)
check('断链也能摘掉', !existsSync(link))

// ---- 3) 真目录：允许的根内才递归删 ----
const probe = join(root, '.probe-0.85.1')
mkdirSync(join(probe, 'node_modules'), { recursive: true })
writeFileSync(join(probe, 'probe.js'), 'export const ok = true\n')
removeLinkOrDir(probe, root)
check('根内的真目录被递归删掉', !existsSync(probe))

// ---- 4) 真目录：根外拒绝，内容完好 ----
const outside = join(root, 'outside')
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'keep.txt'), 'keep me\n')
let threw = false
try {
  removeLinkOrDir(outside, join(root, 'somewhere-else'))
} catch {
  threw = true
}
check('根外的真目录被拒绝（抛错）', threw)
check('被拒绝的目录内容完好', readFileSync(join(outside, 'keep.txt'), 'utf8') === 'keep me\n')

// ---- 5) 普通文件：直接 unlink，不递归 ----
const file = join(root, 'status.json')
writeFileSync(file, '{}\n')
removeLinkOrDir(file, root)
check('普通文件被删掉', !existsSync(file))

console.log(failures === 0 ? 'link-removal: 全部通过' : `link-removal: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
