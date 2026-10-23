#!/usr/bin/env node
/**
 * install.mjs — 一键部署（在你自己的终端里跑，需要对 ~/.dsh 有写权限）
 *   ① 把闸门与工具拷到 %DSH_HOME%\youzi-guard\
 *   ② 首次安装：从 config.example.json 生成 config.json（要你改 channels）
 *   ③ 若存在 profile 的 cordis.patch.yml：把人个块迁移/升级（自动备份）
 *   ④ 若存在 im-connect 编译产物：打入站挂点（幂等，自动备份）
 *   ⑤ 跑 44 条自检
 * 全部幂等，可反复执行。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HERE = import.meta.dirname
const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const guardDir = join(dshHome, 'youzi-guard')
const profile = join(dshHome, 'profiles', 'desktop')
const patchYml = join(profile, 'cordis.patch.yml')
const pluginLib = join(profile, 'node_modules', '@michengai', 'dsh-im-connect')
const run = (script, args, { optional = false } = {}) => {
  try { execFileSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' }) }
  catch (error) { if (!optional) throw error; console.warn(`   ↳ 跳过（${script}: ${error?.status ?? 'error'}）`) }
}

console.log(`DSH_HOME  = ${dshHome}\n闸门目录  = ${guardDir}\n`)
mkdirSync(guardDir, { recursive: true })

// ① 拷代码
for (const file of ['guard.mjs', 'set-passphrase.mjs', 'migrate-persona.mjs', 'doctor.mjs', 'discover-ids.mjs', 'show-session.mjs', 'selftest.mjs']) {
  copyFileSync(join(HERE, file), join(guardDir, file))
}
console.log('[1/5] 已安装闸门与工具（7 个文件）')

// ② 配置
const configFile = join(guardDir, 'config.json')
if (!existsSync(configFile)) {
  copyFileSync(join(HERE, 'config.example.json'), configFile)
  console.log('[2/5] 已生成 config.json —— ⚠️ 请把 channels 改成你自己的渠道实例 id（见 README「快速开始」第 2 步）')
} else {
  console.log('[2/5] config.json 已存在，保留你的配置')
}

// ③ 人格块
const blockTemplate = join(guardDir, 'persona-block.txt')
if (!existsSync(blockTemplate)) copyFileSync(join(HERE, 'persona-block.example.txt'), blockTemplate)
if (existsSync(patchYml)) {
  run('migrate-persona.mjs', ['--upgrade', '--file', patchYml, '--digest-out', join(guardDir, 'passphrase.sha256')], { optional: true })
  console.log('[3/5] 人格块已处理（模板：' + blockTemplate + '，改完再跑 node migrate-persona.mjs --upgrade）')
} else {
  console.log('[3/5] 没找到 ' + patchYml + ' —— 跳过人格块；请手动把 persona-block.example.txt 的两段抄进你的人格设定')
}

// ④ 插件挂点
if (existsSync(pluginLib)) {
  run('apply-guard-patch.mjs', [], { optional: true })
  console.log('[4/5] 挂点已检查（--check 可只检查；--revert 可还原）')
} else {
  console.log('[4/5] 没装 @michengai/dsh-im-connect —— 跳过挂点；若你的插件自带入站钩子，用 adapters/ 下的适配器')
}

// ⑤ 自检
console.log('[5/5] 自检：')
run('selftest.mjs', [])

const cfg = JSON.parse(readFileSync(configFile, 'utf8'))
console.log('\n──────────────────────────────────────────────')
console.log('接下来：')
console.log('1) 编辑 ' + configFile + '，把 channels 改成你的渠道实例 id')
console.log('   当前值：' + JSON.stringify(cfg.channels))
console.log('2) 设暗号：node set-passphrase.mjs')
console.log('3) 完全退出宿主（含托盘）再启动 —— 改代码必须重启，改配置不用')
console.log('4) 体检：node doctor.mjs')
console.log('──────────────────────────────────────────────')
