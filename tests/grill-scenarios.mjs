/**
 * 全场景真实用户验证测试（/grill-with-docs 10 大完整真实场景）。
 *
 * 严格遵循端到端真实验证纪律：
 * - 真实临时 DSH_HOME + 模拟宿主 ctx，通过 `apply(ctx)` 注册真实 Host HTTP 路由、
 *   `agent/inbox/claimed`、`system-prompt/assemble` 与会话索引/增量同步链路；
 * - 零 mock 内部业务函数（切段、聚类、三级匹配、交接、Wire 展开、视图投影全部走真实实现）；
 * - 覆盖工作驱动 + 日常闲聊交流 10 大完整真实用户场景。
 *
 * Run: node tests/grill-scenarios.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  flushIndexSyncs,
  syncSessionIndexFor,
} from '../lib/index.js'

import {
  WORK_CONTEXT_NAME,
  flushIncrementalSyncs,
  incrementalSyncSession,
  readWorkStore,
} from '../lib/work-store.js'

import {
  rowsOf,
  segmentGroupsOf,
} from '../lib/rail-view.js'

import {
  workBoardModel,
} from '../lib/work-view.js'

const QUOTE_CONTEXT_NAME = 'topic-map:引用摘要'
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WS_ID = 'ws-grill-scenarios'
const WS_PATH = 'E:\\grill-workspace'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error?.stack || error?.message || error}`)
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'grill-scenarios-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    await flushIncrementalSyncs()
    await flushIndexSyncs()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * 构造贴近真实 DSH 宿主事件流的会话事件数组（turn/start、user/message、
 * tool/call、assistant/message、workspace/changes、turn/end）。
 */
function makeEvents(specs, baseTime) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * 2 * MINUTE)
    const end = spec.end ?? (start + 15_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `提问 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    if (Array.isArray(spec.toolCalls)) {
      for (const tc of spec.toolCalls) {
        push('tool/call', {
          name: tc.name,
          arguments: tc.arguments ?? {},
        }, start + 500)
      }
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回复 ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-grill' },
      },
    }, start + 1000)
    if (spec.hasChanges === true || Array.isArray(spec.changedFiles)) {
      push('workspace/changes', { turn }, start + 1500)
    }
    if (spec.open !== true) {
      push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, end)
    }
  })
  return events
}

/**
 * 创建真实 Host 插件运行环境（通过 apply(ctx) 挂载完整路由与事件监听器）。
 */
function createHostEnv(options = {}) {
  const events = { ...(options.events ?? {}) }
  const headers = { ...(options.headers ?? {}) }
  const titles = { ...(options.titles ?? {}) }
  const revisions = { ...(options.revisions ?? {}) }
  const changesBySession = { ...(options.changes ?? {}) }
  const llm = options.llm
  const sessionIds = options.sessionIds ? [...options.sessionIds] : Object.keys(events)
  const workspaces = options.workspaces ?? [{
    id: WS_ID,
    path: WS_PATH,
    title: '全场景质量验证工作区',
    sessionIds,
  }]

  const routes = []
  const listeners = new Map()

  const ctx = {
    _routes: routes,
    _listeners: listeners,
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm') return llm
      return undefined
    },
    on(eventName, fn) {
      if (!listeners.has(eventName)) listeners.set(eventName, [])
      listeners.get(eventName).push(fn)
      return () => {
        const list = listeners.get(eventName)
        if (!list) return
        const idx = list.indexOf(fn)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    effect(fn) {
      return fn()
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          get(name) {
            if (name !== 'webServer') return undefined
            return {
              register(config) {
                routes.push(config)
                return () => {}
              },
            }
          },
          effect(fn) {
            return fn()
          },
        })
      }
      if (names.includes('systemPrompt')) {
        callback({
          ...ctx,
          on(eventName, fn) {
            return ctx.on(eventName, fn)
          },
          effect(fn) {
            return fn()
          },
        })
      }
    },
    sessionQuery: {
      async readSession(id) {
        if (!(id in events)) return null
        return { header: { id, ...(headers[id] ?? {}) }, events: events[id] }
      },
      async listSessions() {
        return Object.keys(events).map(id => ({
          header: { id, ...(headers[id] ?? {}) },
        }))
      },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: titles[sessionId] ?? `会话 ${sessionId.slice(0, 12)}` } },
        }))
      },
    },
    sessionPersistence: {
      async stat(id) {
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
    workspaceChanges: {
      async summary(id, seq) {
        const map = changesBySession[id]
        if (!map) return undefined
        if (seq in map) return map[seq]
        // 支持按 turn 查表（从事件流反查该 seq 对应的 turn）
        if (map.byTurn && Array.isArray(events[id])) {
          const ev = events[id].find(e => e.seq === seq && e.type === 'workspace/changes')
          if (ev && ev.data?.turn in map.byTurn) return map.byTurn[ev.data.turn]
        }
        return map.default
      },
    },
    llm,
  }

  apply(ctx)
  assert.equal(routes.length, 1, 'apply(ctx) 必须注册 /api/topic-map 路由')
  const handler = routes[0].handler

  async function request(method, action, body) {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Readable.from(payload)
    req.url = `/api/topic-map/${action}`
    req.method = method
    let status = 0
    let text = ''
    const res = {
      writeHead(code) { status = code },
      end(value) { text = value },
    }
    await handler(req, res)
    return { status, body: text === '' ? null : JSON.parse(text) }
  }

  function emit(eventName, payload) {
    for (const fn of listeners.get(eventName) ?? []) {
      fn(payload)
    }
  }

  async function runSystemPromptAssemble(agent, initialAssembly = null) {
    const base = initialAssembly ?? { sections: [], contexts: [], tools: [], variables: {} }
    const fns = listeners.get('system-prompt/assemble') ?? []
    assert.ok(fns.length >= 1, 'system-prompt/assemble 钩子应已注册')
    let chain = async () => base
    for (let i = fns.length - 1; i >= 0; i -= 1) {
      const fn = fns[i]
      const next = chain
      chain = () => fn(base, { agent }, next)
    }
    return chain()
  }

  function addSession(sessionId, sessionEvents, opts = {}) {
    events[sessionId] = sessionEvents
    if (opts.header) headers[sessionId] = opts.header
    if (opts.title) titles[sessionId] = opts.title
    if (opts.revision) revisions[sessionId] = opts.revision
    if (opts.changes) changesBySession[sessionId] = opts.changes
    if (!workspaces[0].sessionIds.includes(sessionId)) {
      workspaces[0].sessionIds.push(sessionId)
    }
  }

  function updateSession(sessionId, sessionEvents, opts = {}) {
    events[sessionId] = sessionEvents
    if (opts.revision) revisions[sessionId] = opts.revision
    else revisions[sessionId] = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (opts.changes) changesBySession[sessionId] = opts.changes
  }

  return {
    ctx,
    events,
    headers,
    titles,
    revisions,
    changesBySession,
    workspaces,
    request,
    emit,
    runSystemPromptAssemble,
    addSession,
    updateSession,
  }
}

console.log('\ngrill-scenarios (10 full end-to-end real user scenarios)')

// ═══════════════════════════════════════════════════════════════════════
// 场景 1：日常闲聊 · B 关键词直达
// ═══════════════════════════════════════════════════════════════════════
await test('场景 1（日常闲聊 · B 关键词直达）：生活对话不进「续接」未收束列表，但 POST /search 跨会话秒级精确命中对话与轮次', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_MED = 'session-1111aaaa-0001-4000-8000-000000000001'
    const SESS_COFFEE = 'session-2222bbbb-0002-4000-8000-000000000002'
    const SESS_WORK = 'session-3333cccc-0003-4000-8000-000000000003'

    const env = createHostEnv({
      events: {
        [SESS_MED]: makeEvents([
          {
            turn: 0,
            prompt: '爸妈体检血压偏高，医生开了苯磺酸氨氯地平片，这个降压药一般什么时候吃比较合适？',
            response: '氨氯地平属于长效钙通道阻滞剂，半衰期约 35-50 小时，通常建议每天早上固定时间服用，记得配合家庭血压记录并遵医嘱复查。',
            start: now - 3 * DAY,
            end: now - 3 * DAY + 12_000,
          },
          {
            turn: 1,
            prompt: '吃氨氯地平期间能喝西柚汁或者吃柚子吗？听说会影响药效',
            response: '尽量避免大量饮用西柚汁，西柚中的呋喃香豆素会抑制 CYP3A4 酶，可能让氨氯地平血药浓度波动、增加踝部水肿或头晕风险。',
            start: now - 3 * DAY + 3 * MINUTE,
            end: now - 3 * DAY + 3 * MINUTE + 14_000,
          },
        ]),
        [SESS_COFFEE]: makeEvents([
          {
            turn: 0,
            prompt: '最近想换一款手冲咖啡豆，偏好花香明显、酸质柔和、不要太苦的浅烘豆子，有什么推荐？',
            response: '推荐水洗埃塞俄比亚耶加雪菲（如沃卡或果丁丁产区），风味偏向茉莉花香、白桃与柑橘，92℃ 水温 1:15 粉水比很清爽。',
            start: now - 2 * DAY,
            end: now - 2 * DAY + 10_000,
          },
          {
            turn: 1,
            prompt: '如果平时偶尔也用摩卡壶做拿铁，耶加雪菲会不会太酸？需要另买拼配咖啡豆吗？',
            response: '摩卡壶配牛奶更适合中深烘巴西+哥伦比亚拼配豆，坚果巧克力风味更稳；耶加雪菲留给手冲喝黑咖啡表现最好。',
            start: now - 2 * DAY + 4 * MINUTE,
            end: now - 2 * DAY + 4 * MINUTE + 10_000,
          },
        ]),
        // 附带 1 条真实工作会话作为对照，确保「续接」只收工作、不收闲聊
        [SESS_WORK]: makeEvents([
          {
            turn: 0,
            prompt: '排查 lib/payment-retry.js 回调签名校验超时问题并补充单测',
            response: '已定位到签名时间戳窗口硬编码为 5 秒，正在调整 lib/payment-retry.js。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/payment-retry.js' } }],
            hasChanges: true,
            start: now - 2 * HOUR,
            end: now - 2 * HOUR + 20_000,
          },
        ]),
      },
      headers: {
        [SESS_MED]: { id: SESS_MED, cwd: WS_PATH },
        [SESS_COFFEE]: { id: SESS_COFFEE, cwd: WS_PATH },
        [SESS_WORK]: { id: SESS_WORK, cwd: WS_PATH },
      },
      titles: {
        [SESS_MED]: '周末问诊：氨氯地平降压药注意事项',
        [SESS_COFFEE]: '周末手冲咖啡豆挑选',
        [SESS_WORK]: '支付重试签名校验修复',
      },
      changes: {
        [SESS_WORK]: { default: { files: [{ path: 'lib/payment-retry.js', added: 14, deleted: 3 }] } },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_MED)
    await syncSessionIndexFor(env.ctx, SESS_COFFEE)
    await syncSessionIndexFor(env.ctx, SESS_WORK)

    // 1) POST /works：纯生活对话绝不能进入「续接」未收束列表
    const worksRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(worksRes.status, 200)
    assert.equal(worksRes.body.ok, true)
    const { cards, works } = worksRes.body.value
    assert.equal(cards.unresolved.length, 1, '只有 1 件真实工作进入续接屏')
    assert.equal(works.length, 1)
    assert.equal(works[0].sessionIds.includes(SESS_WORK), true)
    assert.equal(works[0].sessionIds.includes(SESS_MED), false, '降压药纯生活对话不得立为事')
    assert.equal(works[0].sessionIds.includes(SESS_COFFEE), false, '咖啡豆纯生活对话不得立为事')

    // 2) POST /search：跨会话精确命中「氨氯地平」与「咖啡豆 / 耶加雪菲」对应会话与轮次
    const medSearch = await env.request('POST', 'search', {
      workspaceId: WS_ID,
      keywords: '氨氯地平 西柚汁',
    })
    assert.equal(medSearch.status, 200)
    assert.equal(medSearch.body.ok, true)
    assert.ok(medSearch.body.value.hits.length >= 1, '应秒级命中氨氯地平西柚汁讨论')
    assert.equal(medSearch.body.value.hits[0].sessionId, SESS_MED)
    assert.equal(medSearch.body.value.hits[0].turn, 1, '应精确命中第 1 轮（西柚汁相互作用）')
    assert.ok(medSearch.body.value.elapsedMs < 2000, '本地索引检索应秒级返回')

    const coffeeSearch = await env.request('POST', 'search', {
      workspaceId: WS_ID,
      keywords: '耶加雪菲 咖啡豆',
    })
    assert.equal(coffeeSearch.status, 200)
    assert.equal(coffeeSearch.body.ok, true)
    assert.ok(coffeeSearch.body.value.hits.length >= 1, '应秒级命中手冲咖啡豆推荐')
    assert.equal(coffeeSearch.body.value.hits[0].sessionId, SESS_COFFEE)
    assert.ok([0, 1].includes(coffeeSearch.body.value.hits[0].turn))
    assert.equal(
      coffeeSearch.body.value.hits.some(h => h.sessionId === SESS_WORK),
      false,
      '无关工作会话不应混入咖啡豆搜索结果',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 2：日常闲聊 · A 长会话串台切「段」目录
// ═══════════════════════════════════════════════════════════════════════
await test('场景 2（日常闲聊 · A 长会话串台切「段」目录）：12 轮三主题串台对话产出两级目录且 RAILVIEW/segmentGroupsOf 正确分组', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_12 = 'session-2020aaaa-0012-4000-8000-000000000012'
    const tBase = now - 6 * HOUR

    // 12 轮纯日常交流（1-based 轮号，与真实 DSH 会话及历史轨同口径）：
    // #1-4：装修美缝
    // 隔 60 分钟，#5-8：孩子编程课
    // 隔 60 分钟，#9-12：路由器 Mesh 组网
    const env = createHostEnv({
      events: {
        [SESS_12]: makeEvents([
          // 段 1：装修美缝（#1-4）
          {
            turn: 1,
            prompt: '新房贴完柔光砖准备做装修美缝，环氧彩砂和聚脲美缝哪个更耐黄变？',
            response: '聚脲美缝耐黄变能力明显更强，尤其适合阳台和客厅采光强区域；环氧彩砂质感偏哑光但浅色容易发黄。',
            start: tBase,
            end: tBase + 15_000,
          },
          {
            turn: 2,
            prompt: '那聚脲美缝施工的时候瓷砖缝隙需要留几毫米？厨卫油烟区用聚脲美缝好打理吗？',
            response: '留 2 毫米左右缝隙最利于聚脲美缝饱满填充，厨卫用亮光或微哑光聚脲美缝耐油污擦洗更省心。',
            start: tBase + 3 * MINUTE,
            end: tBase + 3 * MINUTE + 15_000,
          },
          {
            turn: 3,
            prompt: '装修美缝配色怎么选？浅灰色柔光砖配什么色号的聚脲美缝不会显格子感？',
            response: '建议选比浅灰柔光砖浅半个度的一砖一色聚脲美缝，比如亚浅灰或暖云灰，弱化砖缝格子感。',
            start: tBase + 6 * MINUTE,
            end: tBase + 6 * MINUTE + 15_000,
          },
          {
            turn: 4,
            prompt: '做完聚脲美缝后大概多久可以正常踩踏和进场定制柜子？',
            response: '聚脲美缝表干快，一般 4-6 小时可轻走，24 小时完全固化后再进重型定制柜更保险。',
            start: tBase + 9 * MINUTE,
            end: tBase + 9 * MINUTE + 15_000,
          },
          // 段 2：孩子编程课（隔 60 分钟，#5-8）
          {
            turn: 5,
            prompt: '换个话题问一下，小学三年级孩子报少儿编程课，先学 Scratch 图形化还是直接学 Python？',
            response: '三年级建议从 Scratch 图形化编程起步，重点培养循环、条件与事件逻辑，五年级后再过渡到 Python 语法。',
            start: tBase + 70 * MINUTE,
            end: tBase + 70 * MINUTE + 15_000,
          },
          {
            turn: 6,
            prompt: '少儿编程课选线下小班还是线上录播直播？每周上一次编程课节奏合适吗？',
            response: '三年级专注力有限，线下 4-6 人小班互动反馈更好；每周一次 90 分钟编程课加周末 30 分钟自由创作很均衡。',
            start: tBase + 73 * MINUTE,
            end: tBase + 73 * MINUTE + 15_000,
          },
          {
            turn: 7,
            prompt: '给孩子报编程课要不要顺便参加蓝桥杯青少组或者机器人等级考试？',
            response: '前期不必以考级为唯一目标，等 Scratch 作品能独立拆解问题后，用蓝桥杯青少组当阶段性体检即可。',
            start: tBase + 76 * MINUTE,
            end: tBase + 76 * MINUTE + 15_000,
          },
          {
            turn: 8,
            prompt: '家里旧平板能跑 Scratch 编程课作业吗，还是配一台入门轻薄本更方便？',
            response: 'Scratch 3 虽支持平板，但拖拽积木和打字命名变量在键鼠笔记本上体验好得多，入门轻薄本即可。',
            start: tBase + 79 * MINUTE,
            end: tBase + 79 * MINUTE + 15_000,
          },
          // 段 3：路由器 Mesh 组网（隔 60 分钟，#9-12）
          {
            turn: 9,
            prompt: '晚上再来问个家里的网络问题，130 平三室两厅用路由器 Mesh 组网怎么放节点信号最好？',
            response: '主路由器放客厅电视柜居中，次路由放在次卧或书房走廊侧，优先走预埋超六类网线做有线回程 Mesh。',
            start: tBase + 140 * MINUTE,
            end: tBase + 140 * MINUTE + 15_000,
          },
          {
            turn: 10,
            prompt: '如果客厅到主卧没有留网线，无线回程 Mesh 路由器一定要买三频段带独立 5G 回程的吗？',
            response: '如果只隔一堵非承重墙，双频 Wi-Fi 6/7 Mesh 速度也够用；隔两堵墙以上选三频 Mesh 无线回程衰减明显更小。',
            start: tBase + 143 * MINUTE,
            end: tBase + 143 * MINUTE + 15_000,
          },
          {
            turn: 11,
            prompt: '光猫改桥接让主路由器拨号，对 Mesh 漫游切换延迟有帮助吗？',
            response: '光猫改桥接能减轻光猫 NAT 负载并消除双层 NAT，虽然漫游协议 802.11k/v/r 由路由器负责，但整体稳态延迟更低。',
            start: tBase + 146 * MINUTE,
            end: tBase + 146 * MINUTE + 15_000,
          },
          {
            turn: 12,
            prompt: '家里有智能家居扫地机和空调，路由器 Mesh 里 2.4G 和 5G 建议双频合一还是分开命名？',
            response: '老款 2.4G 物联网设备对双频合一兼容性参差不齐，建议单独开一个 2.4G IoT 专用 SSID，手机电脑连主 Mesh。',
            start: tBase + 149 * MINUTE,
            end: tBase + 149 * MINUTE + 15_000,
          },
        ]),
      },
      headers: { [SESS_12]: { id: SESS_12, cwd: WS_PATH } },
      titles: { [SESS_12]: '装修美缝、编程课与 Mesh 杂谈' },
    })

    await syncSessionIndexFor(env.ctx, SESS_12)

    // 1) POST /session-outline 应产出清晰的 3 段「段 → 轮次」两级目录
    const outlineRes = await env.request('POST', 'session-outline', { sessionId: SESS_12 })
    assert.equal(outlineRes.status, 200)
    assert.equal(outlineRes.body.ok, true)
    assert.equal(outlineRes.body.value.turns.length, 12, '原始 turns 全量 12 轮')

    const segments = outlineRes.body.value.segments
    assert.ok(Array.isArray(segments), '必须返回 segments 数组')
    assert.equal(segments.length, 3, `12 轮三主题对话应切为 3 段，实际 ${segments.length} 段: ${JSON.stringify(segments.map(s => [s.startTurn, s.endTurn, s.title]))}`)

    assert.deepEqual(segments[0].turns.map(t => t.turn), [1, 2, 3, 4])
    assert.deepEqual(segments[1].turns.map(t => t.turn), [5, 6, 7, 8])
    assert.deepEqual(segments[2].turns.map(t => t.turn), [9, 10, 11, 12])
    assert.ok(segments[0].title.includes('美缝'), `第 1 段标题应与美缝相关：${segments[0].title}`)
    assert.ok(segments[1].title.includes('编程'), `第 2 段标题应与编程课相关：${segments[1].title}`)
    assert.ok(segments[2].title.includes('Mesh') || segments[2].title.includes('路由'), `第 3 段标题应与 Mesh/路由相关：${segments[2].title}`)
    assert.equal(segments.every(s => s.kindCandidate === 'chat'), true, '3 段生活交流均应初判为 chat')

    // 2) 验证 RAILVIEW：rowsOf + segmentGroupsOf 正确按段分组且定位活动段
    const nativeNodes = outlineRes.body.value.turns.map((row, idx) => ({
      dataIndex: idx,
      ariaLabel: `Turn ${row.turn}: ${row.promptHead}`,
      ariaCurrent: row.turn === 7 ? 'true' : null,
      time: row.time,
    }))
    const railRows = rowsOf(nativeNodes, {
      turns: outlineRes.body.value.turns.map(t => t.turn),
    })
    assert.equal(railRows.length, 12)

    const groups = segmentGroupsOf(railRows, segments)
    assert.equal(groups.length, 3, '历史轨应分为 3 个段组')
    assert.deepEqual(groups[0].rows.map(r => r.turn), [1, 2, 3, 4])
    assert.deepEqual(groups[1].rows.map(r => r.turn), [5, 6, 7, 8])
    assert.deepEqual(groups[2].rows.map(r => r.turn), [9, 10, 11, 12])
    assert.equal(groups[0].active, false)
    assert.equal(groups[1].active, true, '第 7 轮处于激活态时，第 2 段（编程课）应高亮 active=true')
    assert.equal(groups[2].active, false)
    assert.equal(groups.every(g => g.kindCandidate === 'chat'), true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 3：工作驱动 · 长会话混杂「工作 A → 1 轮短追问 → 工作 A → 纯生活闲聊 → 工作 B」
// ═══════════════════════════════════════════════════════════════════════
await test('场景 3（工作驱动 · 混杂长会话）：三明治短追问不砍碎工作 A，纯闲聊不进续接，工作 A 与工作 B 独立识别', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_MIX = 'session-3030aaaa-0003-4000-8000-000000000003'
    const t0 = now - 5 * HOUR

    const env = createHostEnv({
      events: {
        [SESS_MIX]: makeEvents([
          // 工作 A - 轮 0
          {
            turn: 0,
            prompt: '修复 lib/order-coupon.js 满减券叠加计算精度丢失的问题',
            response: '已定位到浮点数相乘误差，改为分单位整数分摊逻辑。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/order-coupon.js' } },
              { name: 'pwsh', arguments: { command: 'node tests/order-coupon.mjs' } },
            ],
            hasChanges: true,
            start: t0,
            end: t0 + 20_000,
          },
          // 1 轮短追问（无工具、纯文本、≤ 80 字、间隔 < 15 分钟）
          {
            turn: 1,
            prompt: '先扣满减还是先打折？',
            response: '按财务规则先扣满减再算比例折扣，避免负实付金额。',
            start: t0 + 2 * MINUTE,
            end: t0 + 2 * MINUTE + 10_000,
          },
          // 工作 A - 轮 2（报错中断，让工作 A 清晰识别为 blocked）
          {
            turn: 2,
            prompt: '好，把边界用例补进 tests/order-coupon.mjs 再跑一遍回归测试',
            response: '执行测试报错 AssertionError: expected 1999 to equal 2000，跨币种分摊仍需排查。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'tests/order-coupon.mjs' } },
              { name: 'pwsh', arguments: { command: 'node tests/order-coupon.mjs --grep rounding' } },
            ],
            hasChanges: true,
            endReason: 'error',
            start: t0 + 4 * MINUTE,
            end: t0 + 4 * MINUTE + 25_000,
          },
          // 纯生活闲聊（隔 60 分钟，轮 3-4）
          {
            turn: 3,
            prompt: '忙了一上午歇会儿，周末带父母去杭州西湖一日游，有哪些不累脚的路线推荐？',
            response: '推荐从断桥沿白堤散步到孤山，中午楼外楼附近吃饭，下午坐游船逛三潭印月。',
            start: t0 + 65 * MINUTE,
            end: t0 + 65 * MINUTE + 12_000,
          },
          {
            turn: 4,
            prompt: '西湖边停车是不是特别难，坐地铁到凤起路还是龙翔桥更近？',
            response: '周末西湖限号且停车位紧俏，直接坐地铁一号线到龙翔桥站步行 5 分钟最省心。',
            start: t0 + 68 * MINUTE,
            end: t0 + 68 * MINUTE + 12_000,
          },
          // 工作 B（再隔 60 分钟，完全不同的业务模块，轮 5-6）
          {
            turn: 5,
            prompt: '下午开始做另一个需求：给 lib/export-csv.js 增加 UTF-8 BOM 头防止 Excel 打开中文乱码',
            response: '已在 lib/export-csv.js 写入 UTF-8 BOM 前缀，并准备补充中文字符转义处理。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/export-csv.js' } },
            ],
            hasChanges: true,
            start: t0 + 130 * MINUTE,
            end: t0 + 130 * MINUTE + 20_000,
          },
          {
            turn: 6,
            prompt: '顺便把 lib/export-csv.js 的逗号与引号转义补进 tests/export-csv.mjs 并跑测试验证',
            response: '已补充 CSV 转义测试，全部通过，下一步待补充大文件流式导出支持。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'tests/export-csv.mjs' } },
              { name: 'pwsh', arguments: { command: 'node tests/export-csv.mjs' } },
            ],
            hasChanges: true,
            start: t0 + 134 * MINUTE,
            end: t0 + 134 * MINUTE + 20_000,
          },
        ]),
      },
      headers: { [SESS_MIX]: { id: SESS_MIX, cwd: WS_PATH } },
      titles: { [SESS_MIX]: '优惠券修复、西湖闲聊与 CSV 导出' },
      changes: {
        [SESS_MIX]: {
          byTurn: {
            0: { files: [{ path: 'lib/order-coupon.js', added: 22, deleted: 8 }] },
            2: { files: [{ path: 'tests/order-coupon.mjs', added: 35, deleted: 4 }] },
            5: { files: [{ path: 'lib/export-csv.js', added: 18, deleted: 2 }] },
            6: { files: [{ path: 'tests/export-csv.mjs', added: 29, deleted: 0 }] },
          },
        },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_MIX)

    // 1) 检查 /session-outline 切段结构：3 段 = 工作 A(0-2) + 纯闲聊(3-4) + 工作 B(5-6)
    const outlineRes = await env.request('POST', 'session-outline', { sessionId: SESS_MIX })
    assert.equal(outlineRes.status, 200)
    const segs = outlineRes.body.value.segments
    assert.equal(segs.length, 3, `应切出 3 段（工作 A、纯闲聊、工作 B），实际 ${segs.length} 段: ${JSON.stringify(segs.map(s => [s.id, s.kindCandidate]))}`)

    assert.equal(segs[0].id, 'seg:3030aaaa:0-2', '工作 A 三明治短追问不得砍碎，合并为 0-2')
    assert.equal(segs[0].kindCandidate, 'work')
    assert.equal(segs[0].hasError, true)

    assert.equal(segs[1].id, 'seg:3030aaaa:3-4', '中间西湖纯生活闲聊独立成段 3-4')
    assert.equal(segs[1].kindCandidate, 'chat')

    assert.equal(segs[2].id, 'seg:3030aaaa:5-6', '工作 B 独立成段 5-6')
    assert.equal(segs[2].kindCandidate, 'work')
    assert.equal(segs[2].hasError, false)

    // 2) 检查 POST /works：工作 A（blocked）与工作 B（active）各成 1 件事，生活闲聊绝不进续接列表
    const worksRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(worksRes.status, 200)
    const { works, cards } = worksRes.body.value
    assert.equal(works.length, 2, `应识别出工作 A 与工作 B 共 2 件事，实际 ${works.length}`)
    assert.equal(cards.unresolved.length, 2)

    const workA = works.find(w => w.segmentIds.includes('seg:3030aaaa:0-2'))
    const workB = works.find(w => w.segmentIds.includes('seg:3030aaaa:5-6'))
    assert.ok(workA, '应产出工作 A（含 seg:3030aaaa:0-2）')
    assert.ok(workB, '应产出工作 B（含 seg:3030aaaa:5-6）')
    assert.notEqual(workA.id, workB.id, '工作 A 与工作 B 应清晰分离为两件事')
    assert.equal(workA.state, 'blocked', '工作 A 末轮报错中断，应识别为 blocked')
    assert.equal(workB.state, 'active', '工作 B 正常推进中，应识别为 active')
    assert.equal(
      works.some(w => w.segmentIds.includes('seg:3030aaaa:3-4')),
      false,
      '西湖生活闲聊段不得进入任何事',
    )
    // 卡片排序中 blocked 优先于 active
    assert.equal(cards.unresolved[0].id, workA.id, '未收束卡片中 blocked 应排在 active 前面')
    assert.equal(cards.unresolved[1].id, workB.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 4：存量跨会话合并 · 3 个老会话合为 1 件「事」 + 子代理噪音彻底过滤
// ═══════════════════════════════════════════════════════════════════════
await test('场景 4（存量跨会话合并）：3 个老会话（原会话 + fork 报错 + 引用句柄）精准合为 1 件事，过滤 origin=subagent 与 [dsh-mnemon]', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_1 = 'session-4a111111-0001-4000-8000-000000000001'
    const SESS_2 = 'session-4b222222-0002-4000-8000-000000000002'
    const SESS_3 = 'session-4c333333-0003-4000-8000-000000000003'
    const SESS_SUB_ORIGIN = 'session-4d444444-0004-4000-8000-000000000004'
    const SESS_SUB_MNEMON = 'session-4e555555-0005-4000-8000-000000000005'

    const env = createHostEnv({
      events: {
        // 会话 1：改 auth.js 修登录超时
        [SESS_1]: makeEvents([
          {
            turn: 0,
            prompt: '排查 lib/auth.js 线上登录态 15 分钟就超时踢出的问题',
            response: '发现 lib/auth.js 刷新令牌滑动过期窗口未写回 session，已先补写刷新逻辑。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/auth.js' } }],
            hasChanges: true,
            start: now - 3 * DAY,
            end: now - 3 * DAY + 20_000,
          },
        ]),
        // 会话 2：从会话 1 fork，继续改 auth.js 但单测报错中断
        [SESS_2]: makeEvents([
          {
            turn: 0,
            prompt: '接着分叉继续给 lib/auth.js 补刷新令牌并发锁，跑一下登录单测',
            response: 'TypeError: Cannot read properties of undefined (reading refreshWindow)，单测报错中断。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/auth.js' } },
              { name: 'pwsh', arguments: { command: 'node tests/auth.mjs' } },
            ],
            hasChanges: true,
            endReason: 'error',
            start: now - 2 * DAY,
            end: now - 2 * DAY + 25_000,
          },
        ]),
        // 会话 3：新开会话，引用会话 2 句柄 〔4b222222#0〕 排查单测配置（改不同文件 session-store.js）
        [SESS_3]: makeEvents([
          {
            turn: 0,
            prompt: '接续 【@第0轮对话〔4b222222#0〕】 的登录超时单测报错，检查 lib/session-store.js 初始化参数',
            response: '发现测试夹具里 lib/session-store.js 漏传 refreshWindow 默认值，正在补齐。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/session-store.js' } }],
            hasChanges: true,
            start: now - 1 * DAY,
            end: now - 1 * DAY + 18_000,
          },
        ]),
        // 噪音会话 A：origin: 'subagent'
        [SESS_SUB_ORIGIN]: makeEvents([
          {
            turn: 0,
            prompt: '子代理自动检查 lib/auth.js 静态类型',
            response: '检查完成',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/sub-check.js' } }],
            hasChanges: true,
            start: now - 12 * HOUR,
            end: now - 12 * HOUR + 10_000,
          },
        ]),
        // 噪音会话 B：[dsh-mnemon:delegated review]
        [SESS_SUB_MNEMON]: makeEvents([
          {
            turn: 0,
            prompt: '[dsh-mnemon:delegated review] Review lib/auth.js diff for security regressions',
            response: 'LGTM with minor nits.',
            toolCalls: [{ name: 'pwsh', arguments: { command: 'git diff lib/auth.js' } }],
            start: now - 6 * HOUR,
            end: now - 6 * HOUR + 10_000,
          },
        ]),
      },
      headers: {
        [SESS_1]: { id: SESS_1, cwd: WS_PATH },
        [SESS_2]: { id: SESS_2, cwd: WS_PATH, forkedFrom: SESS_1 },
        [SESS_3]: { id: SESS_3, cwd: WS_PATH },
        [SESS_SUB_ORIGIN]: { id: SESS_SUB_ORIGIN, cwd: WS_PATH, origin: 'subagent', delegationDepth: 1 },
        [SESS_SUB_MNEMON]: { id: SESS_SUB_MNEMON, cwd: WS_PATH },
      },
      titles: {
        [SESS_1]: '登录超时排查',
        [SESS_2]: '登录刷新锁单测',
        [SESS_3]: '修复测试夹具 refreshWindow',
        [SESS_SUB_ORIGIN]: 'subagent check',
        [SESS_SUB_MNEMON]: '[dsh-mnemon:delegated review] auth.js',
      },
      changes: {
        [SESS_1]: { default: { files: [{ path: 'lib/auth.js', added: 18, deleted: 4 }] } },
        [SESS_2]: { default: { files: [{ path: 'lib/auth.js', added: 12, deleted: 3 }] } },
        [SESS_3]: { default: { files: [{ path: 'lib/session-store.js', added: 9, deleted: 1 }] } },
        [SESS_SUB_ORIGIN]: { default: { files: [{ path: 'lib/sub-check.js', added: 2, deleted: 0 }] } },
      },
    })

    for (const sid of [SESS_1, SESS_2, SESS_3, SESS_SUB_ORIGIN, SESS_SUB_MNEMON]) {
      await syncSessionIndexFor(env.ctx, sid)
    }

    const res = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)

    const { works, cards } = res.body.value
    assert.equal(works.length, 1, `3 个老会话应合为 1 件事，且 2 个子代理噪音被过滤；实际 works=${works.length}`)
    assert.equal(cards.unresolved.length, 1)

    const w = works[0]
    assert.deepEqual(
      new Set(w.sessionIds),
      new Set([SESS_1, SESS_2, SESS_3]),
      '合并后的事必须精确包含会话 1、2、3',
    )
    assert.equal(w.sessionIds.includes(SESS_SUB_ORIGIN), false, 'origin=subagent 必须过滤')
    assert.equal(w.sessionIds.includes(SESS_SUB_MNEMON), false, '[dsh-mnemon] 必须过滤')
    assert.equal(w.segmentIds.length, 3)
    assert.equal(cards.unresolved[0].sessionCount, 3)
    assert.equal(cards.unresolved[0].segmentCount, 3)

    // 核对持久化段表里彻底不存在子代理噪音会话的段
    const stored = await readWorkStore(WS_ID)
    const storedSegSessionIds = Object.values(stored.store.segments).map(s => s.sessionId)
    assert.equal(storedSegSessionIds.includes(SESS_SUB_ORIGIN), false)
    assert.equal(storedSegSessionIds.includes(SESS_SUB_MNEMON), false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 5：日常新增 · 4 种增量路径全覆盖（5a / 5b / 5c / 5d）
// ═══════════════════════════════════════════════════════════════════════
await test('场景 5（日常新增 · 4 种增量路径）：5a L1 交接硬血缘 / 5b L2 业务文件重叠(排除 package.json) / 5c 新工程活立新事 / 5d 纯闲聊不打扰', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_ORIG = 'session-5000aaaa-0000-4000-8000-000000000000'
    const SESS_5A = 'session-5a111111-0001-4000-8000-000000000001'
    const SESS_5B_AUTH = 'session-5b222222-0002-4000-8000-000000000002'
    const SESS_5B_PKG = 'session-5b333333-0003-4000-8000-000000000003'
    const SESS_5C = 'session-5c444444-0004-4000-8000-000000000004'
    const SESS_5D = 'session-5d555555-0005-4000-8000-000000000005'

    const env = createHostEnv({
      events: {
        [SESS_ORIG]: makeEvents([
          {
            turn: 0,
            prompt: '修 lib/auth.js JWT 续签逻辑并顺手升级 package.json 里的依赖版本',
            response: '已调整 lib/auth.js 续签逻辑与 package.json 版本。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/auth.js' } },
              { name: 'edit', arguments: { file_path: 'package.json' } },
            ],
            hasChanges: true,
            start: now - 4 * HOUR,
            end: now - 4 * HOUR + 20_000,
          },
        ]),
      },
      headers: { [SESS_ORIG]: { id: SESS_ORIG, cwd: WS_PATH } },
      changes: {
        [SESS_ORIG]: {
          default: {
            files: [
              { path: 'lib/auth.js', added: 20, deleted: 5 },
              { path: 'package.json', added: 1, deleted: 1 },
            ],
          },
        },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_ORIG)
    const initRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(initRes.status, 200)
    assert.equal(initRes.body.value.works.length, 1)
    const authWorkId = initRes.body.value.works[0].id

    // ── 5a：从「事」走新会话交接绑定 L1 硬血缘 → 首轮无文件重叠也 100% 挂回原事 ──
    const bindRes = await env.request('POST', 'work-handoff-bind', {
      workspaceId: WS_ID,
      workId: authWorkId,
      sessionId: SESS_5A,
    })
    assert.equal(bindRes.status, 200)
    assert.equal(bindRes.body.ok, true)

    env.addSession(
      SESS_5A,
      makeEvents([
        {
          turn: 0,
          prompt: `【交接「修 lib/auth.js JWT 续签逻辑」〔work:${authWorkId}〕】请先梳理测试场景再动手改代码`,
          response: '已梳理 3 类 token 边界场景：临界过期、并发刷新、黑名单吊销。',
          start: now - 3 * HOUR,
          end: now - 3 * HOUR + 15_000,
        },
      ]),
      { header: { id: SESS_5A, cwd: WS_PATH } },
    )
    await syncSessionIndexFor(env.ctx, SESS_5A)
    const sync5a = await incrementalSyncSession(env.ctx, SESS_5A, { now, useModel: false })
    assert.equal(sync5a.ok, true)
    assert.equal(sync5a.match.action, 'attach')
    assert.equal(sync5a.match.level, 'L1')
    assert.equal(sync5a.match.reason, 'handoff')
    assert.equal(sync5a.match.workId, authWorkId)

    // ── 5b-1：随手新开空白会话改同一个业务文件 lib/auth.js → L2 文件重叠自动归入原事 ──
    env.addSession(
      SESS_5B_AUTH,
      makeEvents([
        {
          turn: 0,
          prompt: '顺手把 lib/auth.js 的 clockSkew 容忍值改成 30 秒',
          response: '已在 lib/auth.js 中把 clockSkew 改为 30s。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/auth.js' } }],
          hasChanges: true,
          start: now - 2 * HOUR,
          end: now - 2 * HOUR + 15_000,
        },
      ]),
      {
        header: { id: SESS_5B_AUTH, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/auth.js', added: 3, deleted: 1 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_5B_AUTH)
    const sync5bAuth = await incrementalSyncSession(env.ctx, SESS_5B_AUTH, { now, useModel: false })
    assert.equal(sync5bAuth.ok, true)
    assert.equal(sync5bAuth.match.action, 'attach')
    assert.equal(sync5bAuth.match.level, 'L2')
    assert.equal(sync5bAuth.match.reason, 'files')
    assert.equal(sync5bAuth.match.workId, authWorkId)

    // ── 5b-2：新开会话只改通用文件 package.json → 绝不通过 L2 误连到 auth 事 ──
    env.addSession(
      SESS_5B_PKG,
      makeEvents([
        {
          turn: 0,
          prompt: '在 package.json 增加一条 lint:fix 的 npm script',
          response: '已在 package.json 的 scripts 中添加 lint:fix。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'package.json' } }],
          hasChanges: true,
          start: now - 90 * MINUTE,
          end: now - 90 * MINUTE + 15_000,
        },
      ]),
      {
        header: { id: SESS_5B_PKG, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'package.json', added: 2, deleted: 0 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_5B_PKG)
    const sync5bPkg = await incrementalSyncSession(env.ctx, SESS_5B_PKG, { now, useModel: false })
    assert.equal(sync5bPkg.ok, true)
    assert.notEqual(sync5bPkg.match.workId, authWorkId, '仅改 package.json 绝不能误连到 auth 事')
    assert.equal(sync5bPkg.match.action, 'new_work')

    // ── 5c：新开会话干全新工程活（写周报脚本） → 自动长出新候选「事」 ──
    env.addSession(
      SESS_5C,
      makeEvents([
        {
          turn: 0,
          prompt: '写一个 scripts/weekly-report.mjs 自动汇总本周 git 提交并生成周报 Markdown',
          response: '已创建 scripts/weekly-report.mjs 并完成 git log 聚合逻辑。',
          toolCalls: [
            { name: 'write', arguments: { file_path: 'scripts/weekly-report.mjs' } },
            { name: 'pwsh', arguments: { command: 'node scripts/weekly-report.mjs --since 7d' } },
          ],
          hasChanges: true,
          start: now - 45 * MINUTE,
          end: now - 45 * MINUTE + 20_000,
        },
      ]),
      {
        header: { id: SESS_5C, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'scripts/weekly-report.mjs', added: 85, deleted: 0 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_5C)
    const sync5c = await incrementalSyncSession(env.ctx, SESS_5C, { now, useModel: false })
    assert.equal(sync5c.ok, true)
    assert.equal(sync5c.match.action, 'new_work')

    // ── 5d：新开会话纯闲聊（写乔迁祝福语） → 不打扰「续接」首页 ──
    env.addSession(
      SESS_5D,
      makeEvents([
        {
          turn: 0,
          prompt: '好朋友周末乔迁新居请吃饭，帮我写三句真诚不俗气的乔迁祝福语发微信',
          response: '1. 乔迁之喜，愿新家装满阳光、烟火气与好心情！2. 迁入新居万事顺遂，常来蹭饭！3. 新屋新气象，岁岁平安喜乐。',
          start: now - 15 * MINUTE,
          end: now - 15 * MINUTE + 10_000,
        },
      ]),
      { header: { id: SESS_5D, cwd: WS_PATH } },
    )
    await syncSessionIndexFor(env.ctx, SESS_5D)
    const sync5d = await incrementalSyncSession(env.ctx, SESS_5D, { now, useModel: false })
    assert.equal(sync5d.ok, true)
    assert.equal(sync5d.match.action, 'ignore', '纯生活闲聊乔迁祝福语必须忽略，不立事')

    // 统一通过 POST /works 验证最终首页态
    const finalRes = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(finalRes.status, 200)
    const { works } = finalRes.body.value
    const authWork = works.find(w => w.id === authWorkId)
    const weeklyWork = works.find(w => w.sessionIds.includes(SESS_5C))
    assert.ok(authWork, '原 auth 事存在')
    assert.deepEqual(
      new Set(authWork.sessionIds),
      new Set([SESS_ORIG, SESS_5A, SESS_5B_AUTH]),
      'auth 事精准聚合原会话 + 5a(L1) + 5b(L2 auth.js)，不混入 package.json 会话',
    )
    assert.ok(weeklyWork, '周报脚本应长出新的独立候选事')
    assert.equal(weeklyWork.reviewStatus, 'pending')
    assert.notEqual(weeklyWork.id, authWorkId)
    assert.equal(
      works.some(w => w.sessionIds.includes(SESS_5D)),
      false,
      '乔迁祝福语纯闲聊绝不出现在续接首页',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 6：话题 ↔ 事 一键互转 + 合并/拆段 + 人工确认锁定
// ═══════════════════════════════════════════════════════════════════════
await test('场景 6（话题 ↔ 事 一键互转 + 合并/拆段 + 人工确认锁定）：promote、dismiss 不复生、merge/split、决策取代链防覆盖', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_RESEARCH = 'session-6000aaaa-0001-4000-8000-000000000001'
    const SESS_MISTAKEN = 'session-6000bbbb-0002-4000-8000-000000000002'
    const SESS_SEARCH_B = 'session-6000cccc-0003-4000-8000-000000000003'

    const env = createHostEnv({
      events: {
        // 纯交流调研段：SQLite FTS5 vs Tantivy（无工具、无文件变更）
        [SESS_RESEARCH]: makeEvents([
          {
            turn: 0,
            prompt: '对比一下 SQLite FTS5 和 Tantivy 在本地中文全文检索里的分词能力与包体积差异',
            response: 'SQLite FTS5 零外部依赖但中文默认只按字符切分；Tantivy 原生倒排性能强且可接 jieba 分词，但需要引入 Rust 原生二进制。',
            start: now - 3 * HOUR,
            end: now - 3 * HOUR + 15_000,
          },
          {
            turn: 1,
            prompt: '如果目标数据量在 5 万条对话以内，两者冷启动延迟差多少？',
            response: '5 万条以内两者查询都在 10ms 级，差异主要在打包体积和跨平台分发维护成本。',
            start: now - 3 * HOUR + 2 * MINUTE,
            end: now - 3 * HOUR + 2 * MINUTE + 15_000,
          },
        ]),
        // 误立候选事：顺手跑过一次命令问下 node 版本，被规则立为候选事
        [SESS_MISTAKEN]: makeEvents([
          {
            turn: 0,
            prompt: '顺便帮我查下本机环境跑一下 node -v 看看版本',
            response: '当前是 v22.14.0。',
            toolCalls: [{ name: 'pwsh', arguments: { command: 'node -v' } }],
            start: now - 2 * HOUR,
            end: now - 2 * HOUR + 10_000,
          },
        ]),
        // 另一个相关工程事：写索引基准脚本
        [SESS_SEARCH_B]: makeEvents([
          {
            turn: 0,
            prompt: '写一个 scripts/fts-bench.mjs 测试 5 万条记录的中文倒排检索耗时',
            response: '已完成 scripts/fts-bench.mjs 压测脚本初版。',
            toolCalls: [{ name: 'write', arguments: { file_path: 'scripts/fts-bench.mjs' } }],
            hasChanges: true,
            start: now - 1 * HOUR,
            end: now - 1 * HOUR + 18_000,
          },
        ]),
      },
      headers: {
        [SESS_RESEARCH]: { id: SESS_RESEARCH, cwd: WS_PATH },
        [SESS_MISTAKEN]: { id: SESS_MISTAKEN, cwd: WS_PATH },
        [SESS_SEARCH_B]: { id: SESS_SEARCH_B, cwd: WS_PATH },
      },
      changes: {
        [SESS_SEARCH_B]: { default: { files: [{ path: 'scripts/fts-bench.mjs', added: 72, deleted: 0 }] } },
      },
    })

    for (const sid of [SESS_RESEARCH, SESS_MISTAKEN, SESS_SEARCH_B]) {
      await syncSessionIndexFor(env.ctx, sid)
    }

    const init = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(init.status, 200)
    // 调研纯交流段未自动立事；误立事 + 压测脚本事自动立事
    assert.equal(init.body.value.works.some(w => w.sessionIds.includes(SESS_RESEARCH)), false)
    const mistakenWork = init.body.value.works.find(w => w.sessionIds.includes(SESS_MISTAKEN))
    const benchWork = init.body.value.works.find(w => w.sessionIds.includes(SESS_SEARCH_B))
    assert.ok(mistakenWork && benchWork)

    // 1) POST /work-promote：把“SQLite FTS5 vs Tantivy 调研”纯交流段一键转为已确认「事」
    const outlineResearch = await env.request('POST', 'session-outline', { sessionId: SESS_RESEARCH })
    const researchSeg = outlineResearch.body.value.segments[0]
    assert.equal(researchSeg.kindCandidate, 'chat')

    const promoteRes = await env.request('POST', 'work-promote', {
      workspaceId: WS_ID,
      segment: {
        id: researchSeg.id,
        sessionId: SESS_RESEARCH,
        title: 'SQLite FTS5 vs Tantivy 本地检索选型调研',
        summary: '对比中文分词、冷启动延迟与跨平台打包成本',
        startTurn: researchSeg.startTurn,
        endTurn: researchSeg.endTurn,
        evidenceHandles: ['〔6000aaaa#0〕', '〔6000aaaa#1〕'],
      },
    })
    assert.equal(promoteRes.status, 200)
    assert.equal(promoteRes.body.ok, true)
    const researchWork = promoteRes.body.value.work
    assert.equal(researchWork.state, 'active')
    assert.equal(researchWork.stateSource, 'confirmed', '一键升格的事应直接为已确认态')
    assert.equal(researchWork.reviewStatus, 'reviewed')

    // 2) POST /work-dismiss：把误立的候选事退回话题，再强制重扫验证永不复生
    const dismissRes = await env.request('POST', 'work-dismiss', {
      workspaceId: WS_ID,
      workId: mistakenWork.id,
    })
    assert.equal(dismissRes.status, 200)
    assert.equal(dismissRes.body.ok, true)

    const rescanAfterDismiss = await env.request('POST', 'works-scan', {
      workspaceId: WS_ID,
      force: true,
      useModel: false,
    })
    assert.equal(rescanAfterDismiss.status, 200)
    assert.equal(
      rescanAfterDismiss.body.value.works.some(w => w.sessionIds.includes(SESS_MISTAKEN)),
      false,
      '已退回话题的误立事经强制重扫绝不能复生',
    )

    // 3) POST /work-merge：把压测脚本事合并进检索选型事（取重扫后的当前未确认事 ID）
    const benchWorkLatest = rescanAfterDismiss.body.value.works.find(w => w.sessionIds.includes(SESS_SEARCH_B))
    assert.ok(benchWorkLatest, '重扫后压测脚本事应仍在清单中')
    const mergeRes = await env.request('POST', 'work-merge', {
      workspaceId: WS_ID,
      targetWorkId: researchWork.id,
      sourceWorkId: benchWorkLatest.id,
    })
    assert.equal(mergeRes.status, 200)
    assert.equal(mergeRes.body.ok, true)
    assert.equal(mergeRes.body.value.work.id, researchWork.id)
    assert.equal(mergeRes.body.value.work.segmentIds.length, 2)
    assert.ok(mergeRes.body.value.work.sessionIds.includes(SESS_RESEARCH))
    assert.ok(mergeRes.body.value.work.sessionIds.includes(SESS_SEARCH_B))

    // 4) POST /work-split：再把压测脚本段拆出为独立事
    const benchSegId = benchWorkLatest.segmentIds[0]
    const splitRes = await env.request('POST', 'work-split', {
      workspaceId: WS_ID,
      workId: researchWork.id,
      segmentId: benchSegId,
    })
    assert.equal(splitRes.status, 200)
    assert.equal(splitRes.body.ok, true)
    const splitNewWork = splitRes.body.value.work
    assert.ok(splitNewWork && splitNewWork.id !== researchWork.id)
    assert.deepEqual(splitNewWork.segmentIds, [benchSegId])

    const afterSplit = await env.request('POST', 'works', { workspaceId: WS_ID })
    const originAfterSplit = afterSplit.body.value.works.find(w => w.id === researchWork.id)
    assert.equal(originAfterSplit.segmentIds.includes(benchSegId), false, '原事应已剥离拆出的段')
    assert.equal(originAfterSplit.segmentIds.includes(researchSeg.id), true)

    // 5) 人工确认状态/下一步/置顶 + 决策取代链（方案 B 取代方案 A） → 强制重扫 100% 不覆盖
    const confA = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId: researchWork.id,
      patch: {
        title: '本地全文检索引擎技术选型',
        goal: '在 5 万条对话内实现 10ms 级中文检索且零原生依赖',
        state: 'active',
        nextStep: '用真实语料验证 FTS5 trigram 分词召回率',
        pinned: true,
        addDecision: {
          summary: '方案 A：引入 Tantivy Rust 原生绑定',
          rationale: '倒排吞吐量最高',
          evidenceHandle: '〔6000aaaa#0〕',
        },
      },
    })
    assert.equal(confA.status, 200)
    const decAId = confA.body.value.work.decisions[0].id

    const confB = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId: researchWork.id,
      patch: {
        supersedeDecision: {
          oldId: decAId,
          decision: {
            summary: '方案 B：采用纯 JS 倒排 + SQLite FTS5 轻索引',
            rationale: '5 万条以内延迟同量级，且免除跨平台原生编译负担',
            evidenceHandle: '〔6000aaaa#1〕',
          },
        },
      },
    })
    assert.equal(confB.status, 200)
    const decB = confB.body.value.work.decisions.find(d => d.id !== decAId)

    // 强制重扫
    const forceScan = await env.request('POST', 'works-scan', {
      workspaceId: WS_ID,
      force: true,
      useModel: false,
    })
    assert.equal(forceScan.status, 200)
    const kept = forceScan.body.value.works.find(w => w.id === researchWork.id)
    assert.ok(kept, '已确认升格的事重扫后不得丢失')
    assert.equal(kept.title, '本地全文检索引擎技术选型')
    assert.equal(kept.state, 'active')
    assert.equal(kept.stateSource, 'confirmed')
    assert.equal(kept.nextStep, '用真实语料验证 FTS5 trigram 分词召回率')
    assert.equal(kept.nextStepSource, 'confirmed')
    assert.equal(kept.pinned, true)
    assert.equal(kept.decisions.length, 2)
    assert.equal(kept.decisions.find(d => d.id === decAId)?.status, 'superseded')
    assert.equal(kept.decisions.find(d => d.id === decAId)?.supersededBy, decB.id)
    assert.equal(kept.decisions.find(d => d.id === decB.id)?.status, 'active')

    // 验证 workBoardModel 视图投影正确暴露确认态与决策取代链
    const unresolvedWorks = forceScan.body.value.works.filter(w => w.state === 'active' || w.state === 'blocked')
    const settledWorks = forceScan.body.value.works.filter(w => w.state === 'done' || w.state === 'shelved')
    const board = workBoardModel({
      unresolved: unresolvedWorks,
      settled: settledWorks,
      pendingReviewCount: forceScan.body.value.pendingReviewCount,
      inflection: forceScan.body.value.latestInflection,
      reopenSuggestions: forceScan.body.value.reopenSuggestion ? [forceScan.body.value.reopenSuggestion] : [],
    }, { now })
    const card = board.cards.find(c => c.id === researchWork.id)
    assert.ok(card, 'workBoardModel 应渲染已确认事的窄抽屉卡片')
    assert.equal(card.pinned, true)
    assert.equal(card.confidenceBadge.confirmed, true)
    assert.equal(card.confidenceBadge.style, 'solid')
    assert.equal(card.decisions.filter(d => d.status === 'active').length, 1)
    assert.equal(card.decisions.filter(d => d.status === 'superseded').length, 1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 7：3 类自然拐点轻确认 + 忽略 + 配置开关
// ═══════════════════════════════════════════════════════════════════════
await test('场景 7（3 类自然拐点轻确认）：topic_switch / likely_settled_or_blocked / revisit_unresolved + /work-inflection-dismiss + inflectionNotice:false', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_SWITCH = 'session-7a111111-0001-4000-8000-000000000001'
    const SESS_BLOCK = 'session-7b222222-0002-4000-8000-000000000002'
    const SESS_REVISIT = 'session-7c333333-0003-4000-8000-000000000003'
    const t0 = now - 10 * HOUR

    const env = createHostEnv({
      events: {
        // 先准备会话 SESS_SWITCH 的工作 A 段
        [SESS_SWITCH]: makeEvents([
          {
            turn: 0,
            prompt: '重构 lib/email-sender.js 邮件发送重试退避策略',
            response: '已实现指数退避发送逻辑。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/email-sender.js' } }],
            hasChanges: true,
            start: t0,
            end: t0 + 20_000,
          },
          {
            turn: 1,
            prompt: '补充 lib/email-sender.js 的 SMTP 超时单测',
            response: '单测编写完成。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'tests/email-sender.mjs' } }],
            hasChanges: true,
            start: t0 + 3 * MINUTE,
            end: t0 + 3 * MINUTE + 20_000,
          },
        ]),
      },
      headers: { [SESS_SWITCH]: { id: SESS_SWITCH, cwd: WS_PATH } },
      changes: {
        [SESS_SWITCH]: {
          byTurn: {
            0: { files: [{ path: 'lib/email-sender.js', added: 25, deleted: 8 }] },
            1: { files: [{ path: 'tests/email-sender.mjs', added: 30, deleted: 0 }] },
          },
        },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_SWITCH)
    await env.request('POST', 'works', { workspaceId: WS_ID })

    // ── 7.1 topic_switch：同一会话隔 60 分钟切到完全不同的工作 B（短信模板模块） ──
    env.updateSession(
      SESS_SWITCH,
      makeEvents([
        {
          turn: 0,
          prompt: '重构 lib/email-sender.js 邮件发送重试退避策略',
          response: '已实现指数退避发送逻辑。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/email-sender.js' } }],
          hasChanges: true,
          start: t0,
          end: t0 + 20_000,
        },
        {
          turn: 1,
          prompt: '补充 lib/email-sender.js 的 SMTP 超时单测',
          response: '单测编写完成。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'tests/email-sender.mjs' } }],
          hasChanges: true,
          start: t0 + 3 * MINUTE,
          end: t0 + 3 * MINUTE + 20_000,
        },
        {
          turn: 2,
          prompt: '切另一个活：修改 lib/sms-gateway.js 的验证码签名审核白名单',
          response: '已更新 lib/sms-gateway.js 白名单配置。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/sms-gateway.js' } }],
          hasChanges: true,
          start: t0 + 65 * MINUTE,
          end: t0 + 65 * MINUTE + 20_000,
        },
        {
          turn: 3,
          prompt: '继续把 lib/sms-gateway.js 限频阈值改到每分钟 3 条',
          response: '已修改限频参数，准备继续调优。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/sms-gateway.js' } }],
          hasChanges: true,
          start: t0 + 68 * MINUTE,
          end: t0 + 68 * MINUTE + 20_000,
        },
      ]),
      {
        changes: {
          byTurn: {
            0: { files: [{ path: 'lib/email-sender.js', added: 25, deleted: 8 }] },
            1: { files: [{ path: 'tests/email-sender.mjs', added: 30, deleted: 0 }] },
            2: { files: [{ path: 'lib/sms-gateway.js', added: 14, deleted: 2 }] },
            3: { files: [{ path: 'lib/sms-gateway.js', added: 6, deleted: 1 }] },
          },
        },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_SWITCH)
    const switchSync = await incrementalSyncSession(env.ctx, SESS_SWITCH, {
      now,
      useModel: false,
      config: { inflectionNotice: true },
    })
    assert.equal(switchSync.ok, true)
    assert.ok(switchSync.inflection, '从工作 A 切到工作 B 应检出拐点')
    assert.equal(switchSync.inflection.kind, 'topic_switch')

    // ── 7.2 likely_settled_or_blocked (blocked)：工作轮次报错中断 ──
    env.addSession(
      SESS_BLOCK,
      makeEvents([
        {
          turn: 0,
          prompt: '排查 lib/webhook-dispatcher.js 回调验签失败问题',
          response: '运行验证脚本报错 Error: ECONNREFUSED 127.0.0.1:9000',
          toolCalls: [
            { name: 'edit', arguments: { file_path: 'lib/webhook-dispatcher.js' } },
            { name: 'pwsh', arguments: { command: 'node tests/webhook-dispatcher.mjs' } },
          ],
          hasChanges: true,
          endReason: 'error',
          start: now - 30 * MINUTE,
          end: now - 29 * MINUTE,
        },
      ]),
      {
        header: { id: SESS_BLOCK, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/webhook-dispatcher.js', added: 11, deleted: 4 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_BLOCK)
    const blockSync = await incrementalSyncSession(env.ctx, SESS_BLOCK, {
      now,
      useModel: false,
      config: { inflectionNotice: true },
    })
    assert.equal(blockSync.ok, true)
    assert.ok(blockSync.inflection, '工作轮次报错中断应检出拐点')
    assert.equal(blockSync.inflection.kind, 'likely_settled_or_blocked')
    assert.equal(blockSync.inflection.suggestedState, 'blocked')

    // ── 7.3 revisit_unresolved：隔 6 小时重返未收束会话 ──
    // 先写入轮 0 并立为未收束事，再模拟 6 小时后同一会话继续同一工作（通过 L2 同文件挂回原事）
    const tRevisit0 = now - 7 * HOUR
    env.addSession(
      SESS_REVISIT,
      makeEvents([
        {
          turn: 0,
          prompt: '优化 lib/ledger-export.js 大账单分页导出内存占用',
          response: '先改成游标分页读取，晚点回来压测。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/ledger-export.js' } }],
          hasChanges: true,
          start: tRevisit0,
          end: tRevisit0 + 20_000,
        },
      ]),
      {
        header: { id: SESS_REVISIT, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/ledger-export.js', added: 32, deleted: 12 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_REVISIT)
    await incrementalSyncSession(env.ctx, SESS_REVISIT, {
      now: tRevisit0 + MINUTE,
      useModel: false,
      config: { inflectionNotice: true },
    })

    // 隔 6 小时重返该会话（> 默认 4 小时阈值），继续修改同一文件 lib/ledger-export.js
    env.updateSession(
      SESS_REVISIT,
      makeEvents([
        {
          turn: 0,
          prompt: '优化 lib/ledger-export.js 大账单分页导出内存占用',
          response: '先改成游标分页读取，晚点回来压测。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/ledger-export.js' } }],
          hasChanges: true,
          start: tRevisit0,
          end: tRevisit0 + 20_000,
        },
        {
          turn: 1,
          prompt: '回来了，继续调整 lib/ledger-export.js 游标批次大小为 500 行',
          response: '已将 batchSize 调整为 500，下一步准备跑压测观察峰值内存。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/ledger-export.js' } }],
          hasChanges: true,
          start: tRevisit0 + 6 * HOUR,
          end: tRevisit0 + 6 * HOUR + 20_000,
        },
      ]),
      {
        changes: { default: { files: [{ path: 'lib/ledger-export.js', added: 8, deleted: 2 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_REVISIT)
    const revisitSync = await incrementalSyncSession(env.ctx, SESS_REVISIT, {
      now,
      useModel: false,
      config: { inflectionNotice: true },
    })
    assert.equal(revisitSync.ok, true)
    assert.ok(revisitSync.inflection, '隔 6 小时重返未收束会话应检出 revisit_unresolved 拐点')
    assert.equal(revisitSync.inflection.kind, 'revisit_unresolved')

    // ── 7.4 配置关闭 inflectionNotice: false 后 POST /works 不展示拐点 ──
    const viewWithNotice = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(viewWithNotice.body.value.latestInflection?.kind, 'revisit_unresolved')

    const cfgOff = await env.request('POST', 'config', { inflectionNotice: false })
    assert.equal(cfgOff.status, 200)
    assert.equal(cfgOff.body.value.inflectionNotice, false)

    const viewNoNotice = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(viewNoNotice.body.value.latestInflection, null, '关闭 inflectionNotice 后不得展示轻确认条')

    // 重新打开后仍可见，然后点 /work-inflection-dismiss 忽略清空
    await env.request('POST', 'config', { inflectionNotice: true })
    const viewReenabled = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(viewReenabled.body.value.latestInflection?.kind, 'revisit_unresolved')

    const dismissInf = await env.request('POST', 'work-inflection-dismiss', { workspaceId: WS_ID })
    assert.equal(dismissInf.status, 200)
    assert.equal(dismissInf.body.ok, true)
    assert.equal(dismissInf.body.value.dismissed, true)

    const viewAfterDismiss = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(viewAfterDismiss.body.value.latestInflection, null, '点击忽略后 latestInflection 必须清空')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 8：三层防失真续接 · 原会话未串台 vs 原会话已串台
// ═══════════════════════════════════════════════════════════════════════
await test('场景 8（原会话续接：未串台 vs 已串台）：未串台 drifted:false 草稿简洁；末尾聊别的事后 drifted:true 且带 〔work:<id>〕 纠偏', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_CLEAN = 'session-8a111111-0001-4000-8000-000000000001'
    const t0 = now - 3 * HOUR

    const env = createHostEnv({
      events: {
        [SESS_CLEAN]: makeEvents([
          {
            turn: 0,
            prompt: '排查 lib/rate-limiter.js 令牌桶并发扣减穿透问题',
            response: '定位到 refill 与 consume 之间存在竞态，正在改成单事务扣减。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/rate-limiter.js' } }],
            hasChanges: true,
            start: t0,
            end: t0 + 20_000,
          },
          {
            turn: 1,
            prompt: '把并发压测脚本补进 tests/rate-limiter.mjs',
            response: '已补写 50 并发压测用例，待运行核验。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'tests/rate-limiter.mjs' } }],
            hasChanges: true,
            start: t0 + 3 * MINUTE,
            end: t0 + 3 * MINUTE + 20_000,
          },
        ]),
      },
      headers: { [SESS_CLEAN]: { id: SESS_CLEAN, cwd: WS_PATH } },
      changes: {
        [SESS_CLEAN]: {
          default: { files: [{ path: 'lib/rate-limiter.js', added: 26, deleted: 9 }] },
        },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_CLEAN)
    const init = await env.request('POST', 'works', { workspaceId: WS_ID })
    const workId = init.body.value.works[0].id

    await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        title: '令牌桶并发穿透修复',
        nextStep: '运行 tests/rate-limiter.mjs 验证 50 并发下无超发',
      },
    })

    // 1) 未串台时：drifted: false，草稿简洁直奔下一步，不塞冗余 〔work:<id>〕
    const sameClean = await env.request('POST', 'work-handoff', {
      workspaceId: WS_ID,
      workId,
      mode: 'same-session',
    })
    assert.equal(sameClean.status, 200)
    assert.equal(sameClean.body.ok, true)
    assert.equal(sameClean.body.value.drifted, false, '原会话末尾正是本事，不应判串台')
    assert.equal(sameClean.body.value.turnsSinceWork, 0)
    assert.ok(sameClean.body.value.draft.includes('运行 tests/rate-limiter.mjs 验证 50 并发下无超发'))
    assert.equal(
      sameClean.body.value.draft.includes(`〔work:${workId}〕`),
      false,
      '未串台草稿保持简洁不灌水，不附冗余 work 句柄',
    )

    // 2) 原会话隔 1 小时末尾聊了别的生活话题（串台）→ drifted: true，草稿带 〔work:<id>〕 触发 Wire 纠偏
    env.updateSession(
      SESS_CLEAN,
      makeEvents([
        {
          turn: 0,
          prompt: '排查 lib/rate-limiter.js 令牌桶并发扣减穿透问题',
          response: '定位到 refill 与 consume 之间存在竞态，正在改成单事务扣减。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/rate-limiter.js' } }],
          hasChanges: true,
          start: t0,
          end: t0 + 20_000,
        },
        {
          turn: 1,
          prompt: '把并发压测脚本补进 tests/rate-limiter.mjs',
          response: '已补写 50 并发压测用例，待运行核验。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'tests/rate-limiter.mjs' } }],
          hasChanges: true,
          start: t0 + 3 * MINUTE,
          end: t0 + 3 * MINUTE + 20_000,
        },
        {
          turn: 2,
          prompt: '顺便问下周五晚上请朋友吃潮汕牛肉火锅，吊龙、匙柄和嫩肉分别烫几秒最好吃？',
          response: '吊龙和匙柄下锅 8-10 秒变色即捞，嫩肉约 10-12 秒，配沙茶酱最鲜嫩。',
          start: t0 + 70 * MINUTE,
          end: t0 + 70 * MINUTE + 15_000,
        },
      ]),
      {
        changes: {
          byTurn: {
            0: { files: [{ path: 'lib/rate-limiter.js', added: 26, deleted: 9 }] },
            1: { files: [{ path: 'tests/rate-limiter.mjs', added: 40, deleted: 0 }] },
          },
        },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_CLEAN)

    const sameDrifted = await env.request('POST', 'work-handoff', {
      workspaceId: WS_ID,
      workId,
      mode: 'same-session',
    })
    assert.equal(sameDrifted.status, 200)
    assert.equal(sameDrifted.body.ok, true)
    assert.equal(sameDrifted.body.value.drifted, true, '末尾聊了潮汕牛肉火锅必须检出串台')
    assert.ok(sameDrifted.body.value.turnsSinceWork >= 1)
    assert.ok(sameDrifted.body.value.draft.includes(`〔work:${workId}〕`), '串台草稿必须携带 〔work:<id>〕 句柄')

    // 真实触发 Wire 层纠偏注入：验证注入块包含「串台纠偏」提示
    const sameAgent = {
      id: SESS_CLEAN,
      session: {
        id: SESS_CLEAN,
        header: { id: SESS_CLEAN, cwd: WS_PATH },
        deriveMessages: () => [],
        snapshotEvents: () => env.events[SESS_CLEAN],
      },
    }
    env.emit('agent/inbox/claimed', {
      agent: sameAgent,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: sameDrifted.body.value.draft }],
      },
    })
    const assembledDrift = await env.runSystemPromptAssemble(sameAgent)
    const driftCtx = assembledDrift.contexts.find(c => c.name === WORK_CONTEXT_NAME)
    assert.ok(driftCtx, '串台续接草稿发送后应通过 system-prompt/assemble 注入事级纠偏现场')
    assert.ok(driftCtx.text.includes('串台纠偏'), `注入现场应含串台纠偏说明，实际：\n${driftCtx.text}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 9：三层防失真新会话交接 + Wire 自动展开 + 与轮次引用共存 + 幂等
// ═══════════════════════════════════════════════════════════════════════
await test('场景 9（新会话交接 + Wire 展开 + 与轮次引用共存 + 幂等）：硬事实齐备、〔work:<id>〕与 〔8hex#N〕 并行展开互不冲突、二次严格幂等', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_SRC = 'session-9a11bb22-0001-4000-8000-000000000001'
    const SESS_NEW = 'session-9b33cc44-0002-4000-8000-000000000002'
    const t0 = now - 2 * HOUR

    const env = createHostEnv({
      events: {
        [SESS_SRC]: makeEvents([
          {
            turn: 0,
            prompt: '排查 lib/sync-engine.js 增量拉取重复写入导致的唯一键冲突',
            response: '初步尝试用客户端本地 Set 过滤重复事件，但重启后仍会撞库。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/sync-engine.js' } },
              { name: 'pwsh', arguments: { command: 'node tests/sync-engine.mjs --grep dedup' } },
            ],
            hasChanges: true,
            start: t0,
            end: t0 + 25_000,
          },
          {
            turn: 1,
            prompt: '改用服务端幂等键 upsert，再跑一遍 sync-engine 集成测试',
            response: 'Error: SQLITE_CONSTRAINT_UNIQUE: sync_events.idempotency_key 冲突，第 3 条批处理未带键。',
            toolCalls: [
              { name: 'edit', arguments: { file_path: 'lib/sync-engine.js' } },
              { name: 'pwsh', arguments: { command: 'node tests/sync-engine.mjs --grep batch-upsert' } },
            ],
            hasChanges: true,
            endReason: 'error',
            start: t0 + 4 * MINUTE,
            end: t0 + 4 * MINUTE + 30_000,
          },
        ]),
      },
      headers: { [SESS_SRC]: { id: SESS_SRC, cwd: WS_PATH } },
      changes: {
        [SESS_SRC]: {
          byTurn: {
            0: { files: [{ path: 'lib/sync-engine.js', added: 18, deleted: 6 }] },
            1: { files: [{ path: 'lib/sync-engine.js', added: 34, deleted: 11 }] },
          },
        },
      },
    })

    await syncSessionIndexFor(env.ctx, SESS_SRC)
    const init = await env.request('POST', 'works', { workspaceId: WS_ID })
    const workId = init.body.value.works[0].id

    // 人工写入目标、下一步、现行决策 + 已否决方案
    const c1 = await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        title: '同步引擎增量拉取幂等改造',
        goal: '彻底消除断网重连与重启后的重复写入冲突',
        state: 'blocked',
        nextStep: '给 batch-upsert 第 3 条批处理补齐 idempotency_key 后复跑测试',
        addDecision: {
          summary: '仅靠客户端内存 Set 去重',
          rationale: '进程重启后内存丢失仍触发唯一键报错',
          evidenceHandle: '〔9a11bb22#0〕',
        },
      },
    })
    const oldDecId = c1.body.value.work.decisions[0].id
    await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId,
      patch: {
        supersedeDecision: {
          oldId: oldDecId,
          decision: {
            summary: '全链路落库改用服务端 idempotency_key upsert',
            rationale: '重启与多端重试均可严格幂等',
            evidenceHandle: '〔9a11bb22#1〕',
          },
        },
      },
    })

    // 1) POST /work-handoff (new-session)：验证草稿 + 程序直取硬事实齐全
    const handoffRes = await env.request('POST', 'work-handoff', {
      workspaceId: WS_ID,
      workId,
      mode: 'new-session',
    })
    assert.equal(handoffRes.status, 200)
    assert.equal(handoffRes.body.ok, true)

    const { draft, hardFacts, workHandle } = handoffRes.body.value
    assert.equal(workHandle, `〔work:${workId}〕`)
    assert.ok(draft.includes(workHandle))
    assert.ok(draft.includes('lib/sync-engine.js'))
    assert.ok(draft.includes('补齐 idempotency_key'))

    // 验证程序直取硬事实：变更文件 ±行、最近命令、报错首行、证据句柄
    const engineFile = hardFacts.changedFiles.find(f => f.path === 'lib/sync-engine.js')
    assert.ok(engineFile, '硬事实必须包含变更文件 lib/sync-engine.js')
    assert.equal(engineFile.added, 34)
    assert.equal(engineFile.deleted, 11)
    assert.ok(hardFacts.recentCommands.some(c => c.includes('batch-upsert')), '硬事实必须包含最近命令')
    assert.ok(hardFacts.failedSignals.length >= 1, '硬事实必须包含失败报错信号')
    assert.ok(hardFacts.failedSignals[0].hint.includes('SQLITE_CONSTRAINT_UNIQUE'), '失败信号必须保留报错首行')
    assert.ok(hardFacts.keyEvidenceHandles.some(e => e.handle === '〔9a11bb22#1〕'), '硬事实必须包含原文证据句柄')

    // 2) 新会话首轮同时携带 〔work:<id>〕 与 〔9a11bb22#1〕，真实走 agent/inbox/claimed + system-prompt/assemble
    const combinedPrompt = `${draft}\n补充参考原文报错轮次 【@第1轮对话〔9a11bb22#1〕】，请先核对报错栈再修。`
    const newAgent = {
      id: SESS_NEW,
      session: {
        id: SESS_NEW,
        header: { id: SESS_NEW, cwd: WS_PATH },
        deriveMessages: () => [],
        snapshotEvents: () => [],
      },
    }

    env.emit('agent/inbox/claimed', {
      agent: newAgent,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: combinedPrompt }],
      },
    })

    const assembled1 = await env.runSystemPromptAssemble(newAgent)
    const workCtx1 = assembled1.contexts.find(c => c.name === WORK_CONTEXT_NAME)
    const quoteCtx1 = assembled1.contexts.find(c => c.name === QUOTE_CONTEXT_NAME)

    assert.ok(workCtx1, '事级上下文块 topic-map:事续接现场 必须展开')
    assert.ok(quoteCtx1, '轮次引用上下文块 topic-map:引用摘要 必须并行展开、互不冲突')
    assert.equal(workCtx1.interpolate, false)
    assert.equal(quoteCtx1.interpolate, false)

    // 校验四块结构齐全 + 现行/已否决方案 + 硬事实 + history_turn 提示
    const wt = workCtx1.text
    assert.ok(wt.includes('【目标与当前态势】'), '缺少块 1：目标与当前态势')
    assert.ok(wt.includes('【已生效决策 / 已否决方案】'), '缺少块 2：已生效决策 / 已否决方案')
    assert.ok(wt.includes('【硬事实（程序直取）】'), '缺少块 3：硬事实（程序直取）')
    assert.ok(wt.includes('【下一步与原文证据索引】'), '缺少块 4：下一步与原文证据索引')
    assert.ok(wt.includes('全链路落库改用服务端 idempotency_key upsert'), '必须包含现行方案')
    assert.ok(wt.includes('[已否决] 仅靠客户端内存 Set 去重'), '必须包含已否决方案')
    assert.ok(wt.includes('lib/sync-engine.js (+34/-11)'), '必须包含程序直取变更文件与 ±行')
    assert.ok(wt.includes('SQLITE_CONSTRAINT_UNIQUE'), '必须包含报错首行')
    assert.ok(wt.includes('history_turn'), '必须包含 history_turn 召回提示')
    assert.ok(quoteCtx1.text.includes('〔9a11bb22#1〕') || quoteCtx1.text.includes('SQLITE_CONSTRAINT_UNIQUE'))

    // 3) 二次同会话携带相同 〔work:<id>〕 与 〔9a11bb22#1〕：两者均严格幂等不重复注入
    env.emit('agent/inbox/claimed', {
      agent: newAgent,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `再看一眼 〔work:${workId}〕 和 〔9a11bb22#1〕` }],
      },
    })
    const assembled2 = await env.runSystemPromptAssemble(newAgent)
    assert.equal(
      assembled2.contexts.find(c => c.name === WORK_CONTEXT_NAME),
      undefined,
      '同一会话相同 workId 第二次必须严格幂等不重复注入',
    )
    assert.equal(
      assembled2.contexts.find(c => c.name === QUOTE_CONTEXT_NAME),
      undefined,
      '同一会话相同轮次句柄第二次必须严格幂等不重复注入',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 场景 10：长期演进 · 可配置沉降、置顶豁免、重聊唤醒、已确认 done 复发防篡改、多窗口并发活跃会话
// ═══════════════════════════════════════════════════════════════════════
await test('场景 10（长期演进）：14天/7天/0天沉降、置顶与已确认豁免、重聊唤醒、done 复发防篡改、双窗口并发挂入不丢段', async () => {
  await withTempHome(async () => {
    const now = Date.now()
    const SESS_15D = 'session-a1111111-0001-4000-8000-000000000001'
    const SESS_10D = 'session-a2222222-0002-4000-8000-000000000002'
    const SESS_PINNED_16D = 'session-a3333333-0003-4000-8000-000000000003'
    const SESS_DONE = 'session-a4444444-0004-4000-8000-000000000004'
    const SESS_DONE_RECURR = 'session-a5555555-0005-4000-8000-000000000005'
    const SESS_WAKE_15D = 'session-a6666666-0006-4000-8000-000000000006'
    const SESS_CONC_BASE = 'session-a7777777-0007-4000-8000-000000000007'
    const SESS_CONC_WIN1 = 'session-a8888888-0008-4000-8000-000000000008'
    const SESS_CONC_WIN2 = 'session-a9999999-0009-4000-8000-000000000009'

    const env = createHostEnv({
      events: {
        // 15 天前（默认 14 天即沉降）
        [SESS_15D]: makeEvents([
          {
            turn: 0,
            prompt: '优化 lib/archive-cleaner.js 历史冷数据清理任务',
            response: '写了基础扫描器，尚未接入定时执行。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/archive-cleaner.js' } }],
            hasChanges: true,
            start: now - 15 * DAY,
            end: now - 15 * DAY + 15_000,
          },
        ]),
        // 10 天前（默认 14 天不沉降；改 7 天沉降；改 0 永不沉降）
        [SESS_10D]: makeEvents([
          {
            turn: 0,
            prompt: '优化 lib/metric-rollup.js 分钟级聚合查询',
            response: '已加索引提示，待线上观察延迟。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/metric-rollup.js' } }],
            hasChanges: true,
            start: now - 10 * DAY,
            end: now - 10 * DAY + 15_000,
          },
        ]),
        // 16 天前，稍后置顶 + 确认，用于验证豁免沉降
        [SESS_PINNED_16D]: makeEvents([
          {
            turn: 0,
            prompt: '制定 lib/migration-v3.js 数据库大版本升级脚本',
            response: '已出第一版双写迁移方案。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/migration-v3.js' } }],
            hasChanges: true,
            start: now - 16 * DAY,
            end: now - 16 * DAY + 15_000,
          },
        ]),
        // 已收尾老事（将确认为 done，再触发复发防篡改）
        [SESS_DONE]: makeEvents([
          {
            turn: 0,
            prompt: '修复 lib/tax-calculator.js 增值税四舍五入尾差',
            response: '已完成修复并通过全量财务对账测试。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/tax-calculator.js' } }],
            hasChanges: true,
            start: now - 2 * DAY,
            end: now - 2 * DAY + 15_000,
          },
        ]),
        // 双窗口并行活跃基座事
        [SESS_CONC_BASE]: makeEvents([
          {
            turn: 0,
            prompt: '重构 lib/order-pipeline.js 订单状态机主链路',
            response: '已搭好订单状态机核心接口，准备分窗口同步改造前后端模块。',
            toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/order-pipeline.js' } }],
            hasChanges: true,
            start: now - 3 * HOUR,
            end: now - 3 * HOUR + 15_000,
          },
        ]),
      },
      headers: {
        [SESS_15D]: { id: SESS_15D, cwd: WS_PATH },
        [SESS_10D]: { id: SESS_10D, cwd: WS_PATH },
        [SESS_PINNED_16D]: { id: SESS_PINNED_16D, cwd: WS_PATH },
        [SESS_DONE]: { id: SESS_DONE, cwd: WS_PATH },
        [SESS_CONC_BASE]: { id: SESS_CONC_BASE, cwd: WS_PATH },
      },
      changes: {
        [SESS_15D]: { default: { files: [{ path: 'lib/archive-cleaner.js', added: 20, deleted: 3 }] } },
        [SESS_10D]: { default: { files: [{ path: 'lib/metric-rollup.js', added: 15, deleted: 5 }] } },
        [SESS_PINNED_16D]: { default: { files: [{ path: 'lib/migration-v3.js', added: 42, deleted: 0 }] } },
        [SESS_DONE]: { default: { files: [{ path: 'lib/tax-calculator.js', added: 12, deleted: 4 }] } },
        [SESS_CONC_BASE]: { default: { files: [{ path: 'lib/order-pipeline.js', added: 38, deleted: 10 }] } },
      },
    })

    for (const sid of [SESS_15D, SESS_10D, SESS_PINNED_16D, SESS_DONE, SESS_CONC_BASE]) {
      await syncSessionIndexFor(env.ctx, sid)
    }

    // 1) 默认 dormantDays=14：15 天前的自动沉降为 shelved，10 天前的保持 active
    const init = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(init.status, 200)
    const w15 = init.body.value.works.find(w => w.sessionIds.includes(SESS_15D))
    const w10 = init.body.value.works.find(w => w.sessionIds.includes(SESS_10D))
    const wPin = init.body.value.works.find(w => w.sessionIds.includes(SESS_PINNED_16D))
    const wDone = init.body.value.works.find(w => w.sessionIds.includes(SESS_DONE))
    const wConc = init.body.value.works.find(w => w.sessionIds.includes(SESS_CONC_BASE))
    assert.ok(w15 && w10 && wPin && wDone && wConc)

    assert.equal(w15.state, 'shelved', '默认 14 天规则下，15 天无活动的推测态事应自动沉降为 shelved')
    assert.equal(w10.state, 'active', '默认 14 天规则下，10 天前的事不应沉降')

    // 2) 把 16 天前的事置顶并人工确认为 active → 验证置顶/已确认豁免沉降
    await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId: wPin.id,
      patch: { state: 'active', pinned: true, nextStep: '下周窗口期执行灰度迁移' },
    })

    // 调严到 dormantDays: 7 → 10 天前的未确认事沉降，但 16 天前的置顶已确认事豁免保持 active
    await env.request('POST', 'config', { dormantDays: 7 })
    const view7 = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(
      view7.body.value.cards.settled.some(c => c.id === w10.id && c.state === 'shelved'),
      true,
      'dormantDays=7 时，10 天前推测态事应沉降进 settled',
    )
    assert.equal(
      view7.body.value.cards.unresolved.some(c => c.id === wPin.id && c.state === 'active' && c.pinned),
      true,
      '置顶且已确认的 16 天前老事必须豁免沉降',
    )

    // 3) dormantDays: 0（从不沉降）→ 10 天前（落盘为 active）保持在 unresolved
    await env.request('POST', 'config', { dormantDays: 0 })
    const view0 = await env.request('POST', 'works', { workspaceId: WS_ID })
    assert.equal(
      view0.body.value.cards.unresolved.some(c => c.id === w10.id && c.state === 'active'),
      true,
      'dormantDays=0 时不应沉降 10 天前未落盘沉降的事',
    )

    // 4) 已沉降（shelved）的 15 天前老事重聊唤醒：新会话改同文件触发唤醒浮回 active
    await env.request('POST', 'config', { dormantDays: 14 })
    env.addSession(
      SESS_WAKE_15D,
      makeEvents([
        {
          turn: 0,
          prompt: '重新回来把 lib/archive-cleaner.js 接上凌晨定时清理任务',
          response: '已在 lib/archive-cleaner.js 补齐批处理与保护阈值。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/archive-cleaner.js' } }],
          hasChanges: true,
          start: now - 10 * MINUTE,
          end: now - 9 * MINUTE,
        },
      ]),
      {
        header: { id: SESS_WAKE_15D, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/archive-cleaner.js', added: 16, deleted: 2 }] } },
      },
    )
    // 绑定或通过 L1 唤醒已沉降老事（注意：已沉降事不在 L2 unresolved 池中，经交接/原会话重聊或显式绑定重聊唤醒）
    await env.request('POST', 'work-handoff-bind', {
      workspaceId: WS_ID,
      workId: w15.id,
      sessionId: SESS_WAKE_15D,
    })
    await syncSessionIndexFor(env.ctx, SESS_WAKE_15D)
    const wakeRes = await incrementalSyncSession(env.ctx, SESS_WAKE_15D, { now, useModel: false })
    assert.equal(wakeRes.ok, true)
    assert.equal(wakeRes.match.action, 'attach')
    const woken15 = wakeRes.store.works.find(w => w.id === w15.id)
    assert.equal(woken15.state, 'active', '沉降老事重聊后必须自动浮回 active')

    // 5) 已确认 done 老事复发防篡改：保持 done + 产出 reopenSuggestion
    await env.request('POST', 'work-confirm', {
      workspaceId: WS_ID,
      workId: wDone.id,
      patch: { state: 'done', statusSummary: '财务验收已通过' },
    })
    env.addSession(
      SESS_DONE_RECURR,
      makeEvents([
        {
          turn: 0,
          prompt: '排查 lib/tax-calculator.js 免税额场景新冒出的 1 分钱尾差',
          response: '已在 lib/tax-calculator.js 定位免税额舍入边界问题。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/tax-calculator.js' } }],
          hasChanges: true,
          start: now - 5 * MINUTE,
          end: now - 4 * MINUTE,
        },
      ]),
      {
        header: { id: SESS_DONE_RECURR, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/tax-calculator.js', added: 7, deleted: 2 }] } },
      },
    )
    await syncSessionIndexFor(env.ctx, SESS_DONE_RECURR)
    const recurrSync = await incrementalSyncSession(env.ctx, SESS_DONE_RECURR, { now, useModel: false })
    assert.equal(recurrSync.ok, true)
    assert.equal(recurrSync.match.action, 'suggest_reopen')
    assert.equal(recurrSync.match.relatedDoneWorkId, wDone.id)

    const afterRecurr = await env.request('POST', 'works', { workspaceId: WS_ID })
    const keptDone = afterRecurr.body.value.works.find(w => w.id === wDone.id)
    assert.equal(keptDone.state, 'done', '已确认 done 老事复发时绝不能静默改状态')
    assert.equal(keptDone.stateSource, 'confirmed')
    assert.equal(keptDone.sessionIds.includes(SESS_DONE_RECURR), false)
    assert.equal(afterRecurr.body.value.reopenSuggestion?.relatedDoneWorkId, wDone.id)
    assert.equal(afterRecurr.body.value.reopenSuggestion?.sessionId, SESS_DONE_RECURR)

    // 6) 双窗口并发活跃会话交替同步挂入同一件事（Promise.all 并发）→ 不丢段、不互相覆盖
    env.addSession(
      SESS_CONC_WIN1,
      makeEvents([
        {
          turn: 0,
          prompt: '窗口 1：调整 lib/order-pipeline.js 支付成功状态流转守卫',
          response: '已更新状态流转校验并新增单测。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/order-pipeline.js' } }],
          hasChanges: true,
          start: now - 3 * MINUTE,
          end: now - 3 * MINUTE + 15_000,
        },
      ]),
      {
        header: { id: SESS_CONC_WIN1, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/order-pipeline.js', added: 19, deleted: 4 }] } },
      },
    )
    env.addSession(
      SESS_CONC_WIN2,
      makeEvents([
        {
          turn: 0,
          prompt: '窗口 2：同时在 lib/order-pipeline.js 补齐超时取消补偿事件',
          response: '已补充取消补偿事件并落盘。',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/order-pipeline.js' } }],
          hasChanges: true,
          start: now - 2 * MINUTE,
          end: now - 2 * MINUTE + 15_000,
        },
      ]),
      {
        header: { id: SESS_CONC_WIN2, cwd: WS_PATH },
        changes: { default: { files: [{ path: 'lib/order-pipeline.js', added: 23, deleted: 2 }] } },
      },
    )
    await Promise.all([
      syncSessionIndexFor(env.ctx, SESS_CONC_WIN1),
      syncSessionIndexFor(env.ctx, SESS_CONC_WIN2),
    ])

    // 真正并发触发两个活跃窗口的增量同步（测试工作区串行队列 + 原子写）
    const [syncWin1, syncWin2] = await Promise.all([
      incrementalSyncSession(env.ctx, SESS_CONC_WIN1, { now, useModel: false }),
      incrementalSyncSession(env.ctx, SESS_CONC_WIN2, { now, useModel: false }),
    ])
    assert.equal(syncWin1.ok, true)
    assert.equal(syncWin2.ok, true)
    assert.equal(syncWin1.match.workId, wConc.id)
    assert.equal(syncWin2.match.workId, wConc.id)

    const persisted = await readWorkStore(WS_ID)
    assert.equal(persisted.ok, true)
    const concWork = persisted.store.works.find(w => w.id === wConc.id)
    assert.ok(concWork)
    assert.deepEqual(
      new Set(concWork.sessionIds),
      new Set([SESS_CONC_BASE, SESS_CONC_WIN1, SESS_CONC_WIN2]),
      '双并发窗口必须全部挂入同一件事，不得互相覆盖',
    )
    assert.equal(concWork.segmentIds.length, 3, '3 个活跃会话的 3 个段必须完整保留不丢段')
    assert.equal(concWork.segmentIds.includes('seg:a7777777:0-0'), true)
    assert.equal(concWork.segmentIds.includes('seg:a8888888:0-0'), true)
    assert.equal(concWork.segmentIds.includes('seg:a9999999:0-0'), true)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
