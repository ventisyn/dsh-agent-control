/**
 * 组件级开关的离线测试：「一行一个组件」这套结构在**接线层面**成立。
 *
 * 覆盖四件事：
 *   1. 三个子插件行各自只注册自己那几条路由（可以单独存在，不依赖主入口）；
 *   2. 主入口（只有一行 `agent-control` 的旧 profile）把三个组件全装上，且每条路由 / 工具**只注册一次**；
 *   3. 四行都在的 profile（真实默认配置）里，主入口让开、子行自己装，**没有任何重复注册**；
 *   4. `config.enabled: false` ⇒ 这个子插件零注册、零订阅、不抛错。
 * 外加一条纯解析断言：`cordis.patch.yml` 的组件行 id 唯一、name 能在 `package.json` 的 exports 里解析。
 *
 * 用假 ctx 驱动真实的接线函数：假 webServer 对同一个 `(kind, path)` **像真宿主一样抛错**，
 * 所以「没有重复注册」不是靠数数，而是靠真会炸的那条路验证的。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FEATURES, PATHS } from '../src/shared.mjs'
import { resetFeatureClaimsForTest } from '../src/host-wiring.mjs'

const main = await import('../src/index.mjs')
const sessionRow = await import('../src/session-plugin.mjs')
const turnRow = await import('../src/turn-plugin.mjs')
const restartRow = await import('../src/restart-plugin.mjs')

/** 三个组件各自的路由清单（探针 + 原有路由）。 */
const ROUTES = {
  session: [FEATURES.session.probe, PATHS.sessions, PATHS.sessionDelete],
  turn: [FEATURES.turn.probe, PATHS.turns, PATHS.turnDelete],
  restart: [FEATURES.restart.probe, PATHS.restart, PATHS.shutdown],
}

/** webServer 注册用的键（`kind` 固定是 exact）。 */
const keyOf = (routePath) => `exact ${routePath}`

/**
 * 一个假「进程」：一个 webServer + 一个工具注册表。
 *
 * 同一个 `(kind, path)` 注册两次 → 像真宿主一样抛错；同一份工具注册两次也一样。
 * 这样「没有重复注册」只要 apply 不炸就算证到一半，另一半由下面的键集合断言补齐。
 */
function makeSystem() {
  const routes = new Map()
  const order = []
  const tools = []
  const webServer = {
    host: '127.0.0.1',
    port: 3080,
    register(route) {
      assert.equal(route.kind, 'exact', '本插件只注册 exact 路由')
      const key = keyOf(route.path)
      if (routes.has(key)) throw new Error(`重复注册同一路由：${route.path}`)
      routes.set(key, route.handler)
      order.push(route.path)
      return () => routes.delete(key)
    },
  }
  const toolsService = {
    register(definition) {
      if (tools.some((entry) => entry.name === definition.name)) {
        throw new Error(`重复注册同一工具：${definition.name}`)
      }
      tools.push(definition)
      return () => {}
    },
  }
  return { routes, order, tools, toolsService, webServer }
}

/**
 * 造一条「插件行」的 ctx：记账 `effect`（= 注册 / 订阅）与 `on`，其余服务按名字现查。
 *
 * `services` 里额外给的会在 `ctx.get(name)` 时返回（例如假 loader / 假 appReady）。
 */
function makeRow(system, services = {}) {
  const effects = []
  const events = []
  const ctx = {
    effect(fn, label) {
      effects.push(label ?? '')
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name) {
      events.push(name)
    },
    get(name) {
      if (name === 'webServer') return system.webServer
      if (name === 'tools') return system.toolsService
      return services[name]
    },
    webServer: system.webServer,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
  }
  return { ctx, effects, events }
}

/** 调一次路由（默认 GET），返回 `{ status, body }`。 */
async function callRoute(system, routePath, { method = 'GET', body = '' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = routePath
  req.headers = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'content-type': 'application/json',
  }
  let status
  let text
  const res = { writeHead: (code) => { status = code }, end: (chunk) => { text = chunk } }
  await system.routes.get(keyOf(routePath))(req, res)
  return { status, body: JSON.parse(text) }
}

/** 造一个临时 DSH_HOME（热重启那部分要读状态目录，绝不能碰真实的）。 */
function tempHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-control-features-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

/**
 * 假的「插件行环境」：热重启那一组要 `appReady` 才不落回定时器，`dshHome` 指向临时目录。
 *
 * 给一个 `onReady`（不回调）就等于「应用还没就绪」：不会真的去投递续作、也不会碰盘。
 */
function rowEnv(home, extra = {}) {
  return {
    dshHome: home,
    appReady: { onReady: () => {} },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 1. 三个子插件各自单独存在
// ---------------------------------------------------------------------------

test('只加载 session 子插件：只注册它自己那三条路由，别的路径一个都没有', () => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const row = makeRow(system)

  sessionRow.apply(row.ctx, undefined, undefined)

  assert.deepEqual([...system.routes.keys()].sort(), ROUTES.session.map(keyOf).sort())
  assert.deepEqual(row.effects.map((label) => label.replace(/^dsh-agent-control: /, '')).sort(),
    [
      'claim session',
      `GET ${FEATURES.session.probe}`,
      `GET ${PATHS.sessions}`,
      `POST ${PATHS.sessionDelete}`,
    ].sort(),
    '三条路由各一条 effect（disposer 交给 ctx.effect）+ 一条认领释放（fiber 卸载时释放）')
  // 别的组件的路由与工具一个都没有：单独装一行不会顺手带出别的东西。
  for (const routePath of [...ROUTES.turn, ...ROUTES.restart]) {
    assert.equal(system.routes.has(keyOf(routePath)), false, `不该有 ${routePath}`)
  }
  assert.deepEqual(system.tools, [])
  assert.deepEqual(row.events, [], '这一组不订阅任何宿主事件')
})

test('只加载 turn 子插件：只注册它自己那三条路由', () => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  turnRow.apply(makeRow(system).ctx, undefined, undefined)
  assert.deepEqual([...system.routes.keys()].sort(), ROUTES.turn.map(keyOf).sort())
  assert.deepEqual(system.tools, [])
})

test('只加载 restart 子插件：三条路由 + restart_harness 工具一次', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)

  restartRow.apply(makeRow(system, rowEnv(home)).ctx, undefined, rowEnv(home))

  assert.deepEqual([...system.routes.keys()].sort(), ROUTES.restart.map(keyOf).sort())
  assert.deepEqual(system.tools.map((definition) => definition.name), ['restart_harness'])
  assert.equal(system.routes.has(keyOf(PATHS.turns)), false, 'turn 组件的路由不该出现')
})

test('组件的只读探针：只读、200、`{ ok: true, enabled: true }`，且不接受 POST', async () => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  sessionRow.apply(makeRow(system).ctx, undefined, undefined)

  const probe = await callRoute(system, FEATURES.session.probe)
  assert.equal(probe.status, 200)
  assert.deepEqual(probe.body, { ok: true, enabled: true })

  const wrongMethod = await callRoute(system, FEATURES.session.probe, { method: 'POST' })
  assert.equal(wrongMethod.status, 405, '探针只读：别的 405')
})

// ---------------------------------------------------------------------------
// 2. 主入口（只有一行 agent-control 的旧 profile）
// ---------------------------------------------------------------------------

test('主入口：四条原有路由 + 两条探针 + 三条重启路由各一次，工具一次，没有重复注册', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)
  const host = rowEnv(home)

  main.apply(makeRow(system, host).ctx, { approval: 'ask' }, host)

  const expected = [...ROUTES.session, ...ROUTES.turn, ...ROUTES.restart].map(keyOf).sort()
  assert.deepEqual([...system.routes.keys()].sort(), expected)
  assert.equal(expected.length, 9)
  assert.deepEqual(system.tools.map((definition) => definition.name), ['restart_harness'])
})

test('主入口重复 apply（同一个 ctx）：认领表挡住第二次，不抛错也不重复注册', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)
  const host = rowEnv(home)
  const row = makeRow(system, host)

  main.apply(row.ctx, { approval: 'ask' }, host)
  const before = [...system.routes.keys()].sort()
  assert.doesNotThrow(() => main.apply(row.ctx, { approval: 'ask' }, host), '★ 重复 apply 不该撞上 register 的重复检查')
  assert.deepEqual([...system.routes.keys()].sort(), before)
  assert.equal(system.tools.length, 1)
})

test('主入口 + 三个子插件行（四行都在的真实配置）：每条路由仍只注册一次', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)
  // 假 loader：四行都在。主入口见到某个组件行存在时让开，由那一行自己装。
  const loader = {
    entries: () => [
      { options: { name: 'dsh-agent-control' } },
      { options: { name: FEATURES.session.plugin } },
      { options: { name: FEATURES.turn.plugin } },
      { options: { name: FEATURES.restart.plugin } },
    ],
  }
  const env = rowEnv(home, { loader })

  main.apply(makeRow(system, env).ctx, { approval: 'ask' }, env)
  sessionRow.apply(makeRow(system, env).ctx, undefined, undefined)
  turnRow.apply(makeRow(system, env).ctx, undefined, undefined)
  restartRow.apply(makeRow(system, env).ctx, undefined, env)

  const expected = [...ROUTES.session, ...ROUTES.turn, ...ROUTES.restart].map(keyOf).sort()
  assert.deepEqual([...system.routes.keys()].sort(), expected, '★ 9 条路由，一条不多一条不少')
  assert.deepEqual(system.tools.map((definition) => definition.name), ['restart_harness'], '★ 工具也只注册一次')
})

test('审批策略的来源：以自己那一行为准，没写则回退主行的配置（旧配置写在主行上）', async (t) => {
  // 组件拆行之后 `approval` 多了个去处：热重启那一行。旧 profile 里它写在主行上，所以
  // 「子行没写 → 回退主行」这条链必须真的通到 deps 里，否则用户升级后 `approval: auto`
  // 会被静默忽略、每次重启都弹审批（配置漂移且不报错）。
  const readApproval = async ({ rowConfig, coreConfig, applyCore = false } = {}) => {
    resetFeatureClaimsForTest()
    const system = makeSystem()
    // 「主行 + 热重启行」都在的真实部署：loader 里必须真的能看到那一行，主入口才会让开
    // （它是按「行在不在」让开的，见 host-wiring 的 hasOwnRow）。
    const env = rowEnv(tempHome(t), applyCore ? { loader: { entries: () => [{ options: { name: FEATURES.restart.plugin } }] } } : {})
    if (applyCore) {
      // 走**真实装配顺序**：主入口先 apply（此刻 loader 里已有热重启那一行 → 它让开），再由那一行 apply。
      main.apply(makeRow(system, env).ctx, coreConfig, env)
      restartRow.apply(makeRow(system, env).ctx, rowConfig, env)
    } else {
      // 只有那一行（它的 apply 里没有主行记录可用，缺省值必须仍然是对的）。
      restartRow.apply(makeRow(system, env).ctx, rowConfig, env)
    }
    const status = await callRoute(system, PATHS.restartStatus)
    assert.equal(status.status, 200)
    return status.body.approvalMode
  }

  assert.equal(await readApproval(), 'ask', '两边都没写 → 缺省走审批')
  assert.equal(await readApproval({ rowConfig: { approval: 'auto' } }), 'auto', '这一行自己写的说了算')
  assert.equal(await readApproval({ rowConfig: { approval: 'ask' } }), 'ask')
  assert.equal(await readApproval({ rowConfig: { approval: 'never' } }), 'ask', '写坏的词回退缺省')
  assert.equal(await readApproval({ coreConfig: { approval: 'auto' }, applyCore: true }), 'auto', '★ 主行代装时用主行那份')
  assert.equal(await readApproval({ coreConfig: { approval: 'never' }, applyCore: true }), 'ask', '主行写坏了 → 缺省 ask')
  // ⚠️ 真实装配顺序里主入口先 apply，所以「主行与子行都写了」的情形必须在这里对照：
  // 拿不到 loader 的部署（= 主入口代装全部）与四行都在的部署，行为都要说得通。
  assert.equal(
    await readApproval({ rowConfig: { approval: 'ask' }, coreConfig: { approval: 'auto' } }),
    'ask',
    '★ 只有子行时以子行为准',
  )
  assert.equal(
    await readApproval({ rowConfig: { approval: 'ask' }, coreConfig: { approval: 'auto' }, applyCore: true }),
    'ask',
    '★ 四行都在（主入口让开、子行做主）同样以子行为准——不能让主行的旧值把它盖掉',
  )
})

// ---------------------------------------------------------------------------
// 3. 「按行构建」：主入口见到某个组件行存在时让开（否则插件列表里的开关不起作用）
// ---------------------------------------------------------------------------

test('主入口：某个组件行存在时让开——那一行被关掉时它也不会被主入口偷偷装回来', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)
  // 会话那一行存在且**已被关掉**（插件列表里的开关就是往 patch 里写 disabled: true）。
  const loader = {
    entries: () => [{ options: { name: FEATURES.session.plugin, disabled: true } }],
  }
  const env = rowEnv(home, { loader })

  main.apply(makeRow(system, env).ctx, { approval: 'ask' }, env)

  for (const routePath of ROUTES.session) {
    assert.equal(system.routes.has(keyOf(routePath)), false, `★ 会话组件由那一行负责，主入口不该代装 ${routePath}`)
  }
  const expected = [...ROUTES.turn, ...ROUTES.restart].map(keyOf).sort()
  assert.deepEqual([...system.routes.keys()].sort(), expected, '其余两个组件照常装上')
})

test('主入口：loader 服务拿不到时按「没有自己那一行」处理（旧行为，不静默丢功能）', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)

  // 不给 loader 服务（terminal-only / 别的部署）：保守的一侧是「照旧全装」——
  // 查不到行的信息不该让全部功能消失，重复注册由认领表挡住。
  main.apply(makeRow(system, rowEnv(home)).ctx, { approval: 'ask' }, rowEnv(home))

  assert.equal(system.routes.size, 9)
})

// ---------------------------------------------------------------------------
// 4. config.enabled: false
// ---------------------------------------------------------------------------

test('config.enabled: false ⇒ 那个子插件零注册、零订阅、也不抛错', (t) => {
  resetFeatureClaimsForTest()
  const system = makeSystem()
  const home = tempHome(t)

  for (const row of [sessionRow, turnRow, restartRow]) {
    const target = makeRow(system)
    assert.doesNotThrow(() => row.apply(target.ctx, { enabled: false }, rowEnv(home)))
    assert.deepEqual(target.effects, [], `${row.name} 关掉时不该注册任何东西`)
    assert.deepEqual(target.events, [], `${row.name} 关掉时不该订阅任何事件`)
  }
  assert.equal(system.routes.size, 0)
  assert.deepEqual(system.tools, [])
})

test('只有明确的 false 才算关：写成字符串 "false" 之类照旧启用（宁可多装一个组件）', () => {
  resetFeatureClaimsForTest()
  const system = makeSystem()

  sessionRow.apply(makeRow(system).ctx, { enabled: 'false' }, undefined)

  assert.deepEqual([...system.routes.keys()].sort(), ROUTES.session.map(keyOf).sort())
})

// ---------------------------------------------------------------------------
// 5. cordis.patch.yml 与 package.json 的 exports（纯解析，不起真实 loader）
// ---------------------------------------------------------------------------

/**
 * 极简解析：本仓库的 patch 只用到「`- id: x` 后面跟 `name: y`」这一种形状，
 * 所以这里不引 YAML 解析器（本仓库没有依赖，也不该为一条测试引入）。
 */
function parseRows(text) {
  const rows = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const idMatch = /^\s*-\s*id:\s*([^\s#]+)\s*$/.exec(raw)
    if (idMatch !== null) {
      current = { id: idMatch[1], name: undefined, config: {} }
      rows.push(current)
      continue
    }
    const nameMatch = /^\s*name:\s*['"]?([^\s'"#]+)['"]?\s*$/.exec(raw)
    if (nameMatch !== null && current !== null && current.name === undefined) {
      current.name = nameMatch[1]
      continue
    }
    const approvalMatch = /^\s*approval:\s*([^\s#]+)\s*$/.exec(raw)
    if (approvalMatch !== null && current !== null) current.config.approval = approvalMatch[1]
  }
  return rows.filter((row) => row.name !== undefined)
}

test('cordis.patch.yml：四行的 id 唯一、name 能在 package.json 的 exports 里解析', async () => {
  const root = process.cwd()
  const rows = parseRows(readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'))
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

  assert.deepEqual(rows.map((row) => row.id), [
    'agent-control',
    'agent-control-session',
    'agent-control-turn',
    'agent-control-restart',
  ], '四行的顺序与 id')
  assert.equal(new Set(rows.map((row) => row.id)).size, 4, '行 id 必须唯一')
  assert.equal(new Set(rows.map((row) => row.name)).size, 4, '行 name 必须唯一')

  // 主行不许改名：升级时 profile 里那条同 id 的行会失配（见 AGENTS.md 3.10）。
  assert.equal(rows[0].name, 'dsh-agent-control')
  assert.equal(rows[0].config.approval, 'ask')
  assert.deepEqual(rows.slice(1).map((row) => row.name), [
    'dsh-agent-control/session',
    'dsh-agent-control/turn',
    'dsh-agent-control/restart',
  ])

  /** 把插件行的模块名解析到本包 exports 里的文件。 */
  const resolveSpecifier = (spec) => {
    if (spec === pkg.name) return pkg.exports['.']
    if (!spec.startsWith(`${pkg.name}/`)) return undefined
    return pkg.exports[`./${spec.slice(pkg.name.length + 1)}`]
  }

  for (const row of rows) {
    const target = resolveSpecifier(row.name)
    assert.ok(typeof target === 'string', `package.json 的 exports 要让 ${row.name} 可解析`)
    const file = path.resolve(root, target)
    assert.equal(existsSync(file), true, `${row.name} 指向的文件要真的存在：${target}`)
    // 行名与该模块自己导出的 `name` 必须一致（与 cordis 行 id / loader id 同一套约定）。
    const mod = await import(pathToFileURL(file).href)
    assert.equal(mod.name, row.name, `${target} 导出的 name 要与行名一致`)
    assert.equal(typeof mod.apply, 'function', `${target} 要导出 apply`)
    assert.equal(fileURLToPath(pathToFileURL(file)) !== '', true)
  }
})

test('三个子插件导出的 name 就是 patch 行里的模块名（供 loader 认行）', () => {
  assert.equal(sessionRow.name, FEATURES.session.plugin)
  assert.equal(turnRow.name, FEATURES.turn.plugin)
  assert.equal(restartRow.name, FEATURES.restart.plugin)
  assert.equal(main.name, 'dsh-agent-control')
})
