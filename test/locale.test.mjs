/**
 * 插件列表里那几行说明文字的离线测试。
 *
 * 宿主读说明的路径（读 `dsh-app-boot` 的 `readPluginMeta` 得出）：
 *   - 一行的 specifier 后面直接拼 `/locale/en.json`，说明取自该文件的 `meta.description`；
 *   - **子路径 specifier 永远不读 package.json**，所以 `dsh-agent-control/session` 这类行没有 locale 文件就是空白；
 *   - 同目录下所有 `<语言>.json` 都会被读，`en.json` 是入口（它不存在这个目录就不扫）。
 *
 * 于是这里守三件事：四行都按宿主会用的键暴露了 locale、文件是合法 JSON 且 `meta.description` 非空、
 * `files` 里带上 locale 目录（不带的话发布出去的包没有它，界面又变回空白）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/**
 * 插件列表里的四行。
 *
 * 宿主把行里的 `name` 拼成 `<name>/locale/en.json` 再去解析，而 `exports` 的键只能是 `./` 前缀，
 * 所以规范化之后落在下面这些键上（`enKey` / `zhKey`）。
 */
const ROWS = [
  { specifier: 'dsh-agent-control', dir: 'locale', enKey: './locale/en.json', zhKey: './locale/zh.json' },
  { specifier: 'dsh-agent-control/session', dir: 'locale/session', enKey: './session/locale/en.json', zhKey: './session/locale/zh.json' },
  { specifier: 'dsh-agent-control/turn', dir: 'locale/turn', enKey: './turn/locale/en.json', zhKey: './turn/locale/zh.json' },
  { specifier: 'dsh-agent-control/restart', dir: 'locale/restart', enKey: './restart/locale/en.json', zhKey: './restart/locale/zh.json' },
]

/** 读一份 locale 文件并返回它的说明文字。 */
function descriptionOf(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'))?.meta?.description
}

test('四行都暴露了 locale/en.json，且键是合法的 ./ 前缀形式', () => {
  for (const { enKey } of ROWS) {
    assert.equal(typeof pkg.exports[enKey], 'string', `exports 缺少 ${enKey}`)
  }
})

test('每一行的 en.json 与 zh.json 都在，meta.description 是非空字符串，导出与磁盘位置一致', () => {
  for (const { dir, enKey, zhKey } of ROWS) {
    for (const [language, key] of [['en', enKey], ['zh', zhKey]]) {
      const relative = `${dir}/${language}.json`
      assert.equal(pkg.exports[key], `./${relative}`, `${key} 与磁盘位置不一致`)
      const description = descriptionOf(relative)
      assert.equal(typeof description, 'string', `${relative} 的 meta.description 不是字符串`)
      assert.ok(description.trim().length > 0, `${relative} 的 meta.description 是空的`)
    }
  }
})

test('说明不留模板腔：不出现「本行」「旨在」「致力于」这类填充', () => {
  const banned = ['本行', '旨在', '致力于', '值得注意的是', '综上所述']
  for (const { dir } of ROWS) {
    const description = descriptionOf(`${dir}/zh.json`)
    for (const word of banned) {
      assert.equal(description.includes(word), false, `说明里不该出现「${word}」：${description}`)
    }
  }
})

test('locale 目录里的每个 json 都被 exports 暴露，没有孤立文件', () => {
  const listed = new Set(Object.values(pkg.exports).filter((value) => value.startsWith('./locale/')))
  for (const { dir } of ROWS) {
    for (const name of readdirSync(path.join(root, dir))) {
      if (!name.endsWith('.json')) continue
      assert.ok(listed.has(`./${dir}/${name}`), `${dir}/${name} 没有出现在 exports 里`)
    }
  }
})

test('files 里包含 locale 目录（不带的话发布出去的包没有说明文字）', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('locale'), 'package.json 的 files 缺少 locale')
})
