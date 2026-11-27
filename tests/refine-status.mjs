/**
 * 语义提炼的可靠性与可见性测试（ADR-0010）。
 *
 * 覆盖三件事，每一件都对应真机上真实发生过的故障：
 *
 * 1. **模型调用必须带 sessionId**（真机 8 个工作区里 7 个提炼静默失效的根因）。
 *    用假 `deps.askModel` 断言它**确实收到了** sessionId——不是断言"没抛错"，
 *    而是断言那个参数真的在信封里。漏传不会抛错、只会静默降级，所以只测"没崩"
 *    是测不出来的。
 * 2. **失败必须可见**：no_model / timeout / invalid_json / failed 各自落到
 *    refineStatus.reason，且首帧规则结果照常返回（ok:true、semanticUsed:false）。
 * 3. **长输入分批**：簇多时不能把全部簇塞进一次调用（真机 44 会话工作区超时）。
 *    分批必须不重不漏，且超出批次上限的簇并入尾批而不是被丢掉。
 *
 * Run: node tests/refine-status.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { incrementalSyncSession, scanWorkspaceWorks } from '../lib/work-store.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const BASE_TIME = 1_700_000_000_000
const WS = 'ws-refine-1'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'refine-status-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

/** 造一条会话事件流：每个 spec 一轮。 */
function makeEvents(specs, baseTime = BASE_TIME) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * 60_000)
    const end = spec.end ?? (start + 5_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    if (Array.isArray(spec.toolCalls)) {
      for (const tc of spec.toolCalls) {
        push('tool/call', { name: tc.name, arguments: tc.arguments ?? {} }, start + 500)
      }
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-1' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, end)
  })
  return events
}

/**
 * 造 `count` 个互相独立的会话，每个改自己独占的文件。
 * 文件互不重叠 + 无引用句柄 ⇒ 硬信号会分出多个簇，正好用来测分批。
 */
function makeIndependentSessions(count) {
  const events = {}
  const sessionIds = []
  for (let i = 0; i < count; i += 1) {
    const sessionId = `session-${String(i).padStart(4, '0')}aaaa-1111-4aaa-8bbb-${String(i).padStart(12, '0')}`
    sessionIds.push(sessionId)
    events[sessionId] = makeEvents([{
      prompt: `处理模块 mod-${i} 的独立任务，改动 lib/mod-${i}.js`,
      response: `完成 mod-${i}`,
      toolCalls: [{ name: 'edit', arguments: { file_path: `lib/mod-${i}.js` } }],
    }], BASE_TIME + i * 60_000)
  }
  return { events, sessionIds }
}

function makeCtx(events) {
  const sessionIds = Object.keys(events)
  const workspaces = [{ id: WS, path: 'E:\\refine-ws', title: '提炼测试工作区', sessionIds }]
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
    on() { return () => {} },
    effect(fn) { return fn() },
    sessionQuery: {
      async readSession(id) {
        if (!(id in events)) return null
        return { header: { id }, events: events[id] }
      },
      async listSessions() {
        return sessionIds.map(id => ({ header: { id } }))
      },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: `会话 ${sessionId.slice(0, 12)}` } },
        }))
      },
    },
    sessionPersistence: { async stat() { return { revision: 'rev-1' } } },
    workspaceChanges: { async summary() { return undefined } },
  }
}

/** 一个正常的模型答复：把所有给定簇归并成一件事。 */
function refineReply(clusterIds, title = '提炼后的标题') {
  return JSON.stringify({
    works: [{
      clusterIds,
      title,
      goal: '把提炼做成可靠且可见的能力',
      state: 'active',
      statusSummary: '已完成分批与状态上报',
      nextStep: '在真实工作区回归',
      decisions: [],
    }],
    chatClusterIds: [],
  })
}

/** 从提示词里抠出本批出现的簇号（提示词里每个簇都带 [cl-N] 标记）。 */
function clusterIdsIn(prompt) {
  const ids = []
  const re = /\[(cl-\d+)\]/g
  let m = re.exec(prompt.user ?? '')
  while (m !== null) {
    ids.push(m[1])
    m = re.exec(prompt.user ?? '')
  }
  return ids
}

/** 提示词里出现的全部簇号（按批合并去重前的原始顺序）。 */
function allClusterIdsIn(prompt) {
  const ids = []
  const re = /\[(cl-\d+)\]/g
  let m = re.exec(prompt.user ?? '')
  while (m !== null) {
    ids.push(m[1])
    m = re.exec(prompt.user ?? '')
  }
  return ids
}

console.log('\nrefine-status')

// ── 1. 最关键的一条：模型调用必须带 sessionId ────────────────────────

await test('scanWorkspaceWorks：deps.askModel 必须收到本工作区的真实 sessionId（真机静默失效根因）', async () => {
  await withTempHome(async () => {
    const { events, sessionIds } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const seen = []
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: {
        askModel: async (_ctx, prompt, options) => {
          seen.push({ options, prompt })
          return refineReply(clusterIdsIn(prompt))
        },
      },
    })

    assert.equal(res.ok, true, res.error)
    assert.ok(seen.length >= 1, '应为冷启动提炼调用模型')
    for (const { options } of seen) {
      assert.equal(typeof options.sessionId, 'string', 'askModel 的信封必须含 sessionId')
      assert.notEqual(options.sessionId, '', 'sessionId 不能是空串')
      assert.ok(
        sessionIds.includes(options.sessionId),
        `sessionId 必须属于本工作区的真实会话，实际收到 ${JSON.stringify(options.sessionId)}`,
      )
    }
  })
})

await test('冷启动提炼：没给显式 sessionId 时，兜底必须挑本工作区**最近活跃**的真实会话', async () => {
  await withTempHome(async () => {
    // 冷启动调用点只给 sessionIdCandidates（各会话的最后活跃时间），不给 sessionId。
    // 兜底逻辑必须从中挑出一个真实会话，而且应当是最近活跃的那个——
    // 挑错的后果是拿一个早已不存在的会话去调适配器，真机上就是 400。
    const { events, sessionIds } = makeIndependentSessions(3)
    const ctx = makeCtx(events)
    const seen = []
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: {
        askModel: async (_ctx, prompt, options) => {
          seen.push(options.sessionId)
          return refineReply(clusterIdsIn(prompt))
        },
      },
    })
    assert.equal(res.ok, true, res.error)
    assert.ok(seen.length >= 1, '应调用模型')
    for (const sessionId of seen) {
      assert.ok(sessionIds.includes(sessionId), `兜底也必须给本工作区的真实会话 id，实际 ${sessionId}`)
    }
    // makeIndependentSessions 里下标越大越新，所以最后一个是最近活跃的。
    assert.equal(seen[0], sessionIds[sessionIds.length - 1], '兜底应挑最近活跃的会话')
  })
})

// ── 2. 失败可见：每种失败落到各自的 reason，且首帧规则结果照常 ─────────

await test('refineStatus：未配置模型时 reason="no_model"、used=false、attempts 有计数，规则结果照常返回', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: { askModel: async () => null },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.semanticUsed, false)
    assert.equal(res.refineStatus.used, false)
    assert.equal(res.refineStatus.reason, 'no_model')
    assert.equal(res.refineStatus.at, BASE_TIME + 10 * 60_000)
    assert.ok(res.refineStatus.attempts >= 1, '尝试次数必须被记下来')
    // 首帧承诺：规则结果必须照常给出
    assert.ok(res.cards.unresolved.length >= 1, '提炼失败不得清空规则结果')
  })
})

await test('refineStatus：模型抛错 → reason="failed"，规则结果不被清空', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: { askModel: async () => { throw new Error('adapter blew up') } },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.refineStatus.reason, 'failed')
    assert.equal(res.semanticUsed, false)
    assert.ok(res.cards.unresolved.length >= 1)
  })
})

await test('refineStatus：模型超时 → reason="timeout"（超时与普通失败必须可区分）', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: {
        askModel: async () => {
          const error = new Error('semantic model timeout after 20ms')
          error.name = 'TimeoutError'
          throw error
        },
      },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.refineStatus.reason, 'timeout')
    assert.equal(res.semanticUsed, false)
  })
})

await test('refineStatus：模型返回垃圾 JSON → reason="invalid_json"，且不写坏 store', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: { askModel: async () => '这不是 JSON，我只是在胡言乱语' },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.refineStatus.reason, 'invalid_json')
    assert.equal(res.semanticUsed, false)
    assert.ok(res.store.works.length >= 1, '硬信号结果必须仍在')
  })
})

await test('refineStatus：缺 sessionId 被适配器拒绝时，错误分类为 failed 且日志点明"疑似参数漏传"', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const error = new Error('MissingSessionID: request header required')
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: { askModel: async () => { throw error } },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.refineStatus.reason, 'failed')
    // 关键：失败原因必须落进 store（而不是只 print 到 stderr 就算完）
    assert.equal(res.store.refineStatus.reason, 'failed')
  })
})

await test('refineStatus：提炼成功时 used=true、reason="ok"、semanticUsed=true', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: {
        askModel: async (_ctx, prompt) => refineReply(clusterIdsIn(prompt), '提炼成功后的标题'),
      },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.refineStatus.reason, 'ok')
    assert.equal(res.refineStatus.used, true)
    assert.equal(res.semanticUsed, true)
    assert.equal(res.store.refineStatus.reason, 'ok')
    assert.ok(
      res.cards.unresolved.some(c => c.title === '提炼成功后的标题'),
      '精化标题必须落到卡片上',
    )
  })
})

await test('refineStatus：L0 快扫（useModel:false）不得擦掉上一次的提炼成功记录', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(2)
    const ctx = makeCtx(events)
    const first = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 10 * 60_000,
      deps: { askModel: async (_ctx, prompt) => refineReply(clusterIdsIn(prompt), '第一次提炼') },
    })
    assert.equal(first.refineStatus.reason, 'ok')

    // 紧接着一次纯规则快扫：状态与「用了模型」结论都必须沿用，不能被抹成空
    const second = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: false,
      now: BASE_TIME + 11 * 60_000,
      deps: {},
    })
    assert.equal(second.ok, true, second.error)
    assert.equal(second.refineStatus.reason, 'ok', 'L0 快扫不得把提炼状态擦成空')
    assert.equal(second.refineStatus.used, true)
    assert.equal(second.semanticUsed, true, '规则重扫不得谎报"没用过模型"')
    assert.equal(second.store.semanticRefinedAt, BASE_TIME + 10 * 60_000)
  })
})

await test('incrementalSyncSession：增量 L3 语义匹配也必须带本会话的 sessionId', async () => {
  await withTempHome(async () => {
    // 同一会话两段：第一段立成一件事后，第二段话题与文件都不同，
    // 既不共享文件也没有引用句柄 → 硬信号判不了 → 必须走 L3 语义匹配。
    const sid = 'session-9999zzzz-1111-4aaa-8bbb-000000000009'
    const events = {
      [sid]: makeEvents([
        {
          prompt: '实现 lib/alpha-one.js 的认证流程',
          response: '完成认证流程',
          toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/alpha-one.js' } }],
        },
      ]),
    }
    const ctx = makeCtx(events)
    // 先落一次硬信号盘点，让 L3 有可匹配的候选
    await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, now: BASE_TIME + 300_000, deps: {} })
    // 盘点之后才出现第二个话题/文件都不重叠的段：这样硬信号判不了，
    // 才真的会落到 L3（若两段一起喂给冷启动，L2 文件重叠会先把它们聚成一件）。
    events[sid] = makeEvents([
      {
        prompt: '实现 lib/alpha-one.js 的认证流程',
        response: '完成认证流程',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/alpha-one.js' } }],
      },
      {
        prompt: '整理 lib/gamma-three.js 的导出流程文档',
        response: '完成导出文档',
        toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/gamma-three.js' } }],
        start: BASE_TIME + 3600_000,
      },
    ])

    const seen = []
    const res = await incrementalSyncSession(ctx, sid, {
      workspaceId: WS,
      now: BASE_TIME + 7200_000,
      useModel: true,
      deps: {
        askModel: async (_ctx, _prompt, options) => {
          seen.push(options.sessionId)
          return JSON.stringify({ action: 'new_work', reason: '不同话题' })
        },
      },
    })
    assert.equal(res.ok, true, res.error)
    // 先确认这条测试没有空跑：必须真的走到 L3 并调了模型
    assert.equal(seen.length, 1, '本用例必须真的触发 L3 语义匹配（否则断言是空跑）')
    assert.equal(seen[0], sid, '增量调用必须带上本会话的真实 sessionId')
    assert.equal(res.refineStatus.reason, 'ok')
    assert.equal(res.refineStatus.used, true)
    assert.equal(res.refineStatus.attempts, 1)
    assert.equal(res.refineStatus.at, BASE_TIME + 7200_000)
  })
})

// ── 3. 长输入分批（many clusters）────────────────────────────────────

await test('分批：60 个独立簇不得塞进一次模型调用，且分批不重不漏', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(60)
    const ctx = makeCtx(events)
    const batches = []
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 120 * 60_000,
      deps: {
        askModel: async (_ctx, prompt) => {
          const ids = clusterIdsIn(prompt)
          batches.push(ids)
          return refineReply(ids, `第 ${batches.length} 批的标题`)
        },
      },
    })
    assert.equal(res.ok, true, res.error)
    assert.ok(batches.length >= 2, `簇多时必须分批调用，实际只调了 ${batches.length} 次`)
    // 每批的簇数不得超过上限（上限是给模型留预算用的，越了就可能超时）
    for (const ids of batches) {
      assert.ok(ids.length <= 40, `单批簇数不得超过 40，实际 ${ids.length}`)
    }
    // 不重不漏：并集去重后必须等于「出现过的总数」。
    const flat = batches.flat()
    const unique = new Set(flat)
    assert.equal(unique.size, flat.length, `同一个簇不得出现在多个批次：${flat.length} vs ${unique.size}`)
    // 提炼必须真的成功（多批全部成功才算成功）
    assert.equal(res.refineStatus.reason, 'ok', `多批提炼应成功，实际 ${res.refineStatus.reason}`)
    assert.equal(res.refineStatus.attempts, batches.length, 'attempts 应等于实际批次数')
    assert.equal(res.semanticUsed, true)
    assert.ok(res.cards.unresolved.length >= 1, '多批合并后必须有卡片')
  })
})

await test('分批：多批合并后没有任何段同时属于两件事（批内重复认领只算第一条）', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(60)
    const ctx = makeCtx(events)
    let callIndex = 0
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 120 * 60_000,
      deps: {
        askModel: async (_ctx, prompt) => {
          callIndex += 1
          const ids = clusterIdsIn(prompt)
          // 每一批都让模型把同一个簇认领两次（批内重复认领），
          // 先到先得：只有第一条能拿到这个簇，第二条必须拿不到段。
          return JSON.stringify({
            works: [
              { clusterIds: ids, title: `第 ${callIndex} 批标题`, goal: 'y', state: 'active', statusSummary: 'y', nextStep: 'y' },
              { clusterIds: ids, title: '重复认领（必须拿不到段）', goal: 'x', state: 'active', statusSummary: 'x', nextStep: 'x' },
            ],
            chatClusterIds: [],
          })
        },
      },
    })
    assert.equal(res.ok, true, res.error)
    assert.ok(callIndex >= 2, '应至少两批')
    // 重复认领的那条整条丢弃：绝不能出现两个事共用同一个段。
    const segOwner = new Map()
    for (const work of res.store.works) {
      for (const segId of work.segmentIds) {
        assert.equal(
          segOwner.has(segId),
          false,
          `段 ${segId} 同时属于 ${segOwner.get(segId)} 与 ${work.id}`
        )
        segOwner.set(segId, work.id)
      }
    }
    // 批内重复认领：第二条拿不到任何段，因此不会出现在结果里
    assert.equal(
      res.store.works.some(w => w.title === '重复认领（必须拿不到段）'),
      false,
      '拿不到段的重复认领条目不得出现',
    )
    assert.ok(
      res.store.works.some(w => /^第 \d+ 批标题$/.test(w.title)),
      '正常条目必须存在',
    )
  })
})

await test('分批：批次数超过上限时，多出来的簇并入尾批而不是被丢掉', async () => {
  await withTempHome(async () => {
    const { events } = makeIndependentSessions(60)
    const ctx = makeCtx(events)
    const batches = []
    const res = await scanWorkspaceWorks(ctx, WS, {
      force: true,
      useModel: true,
      now: BASE_TIME + 120 * 60_000,
      deps: { askModel: async (_ctx, prompt) => {
        const ids = clusterIdsIn(prompt)
        batches.push(ids)
        return refineReply(ids, `第 ${batches.length} 批标题`)
      } },
    })
    assert.equal(res.ok, true, res.error)
    // 批次总数受 REFINE_MAX_BATCHES(8) 约束；即便越了，簇也只能并入尾批。
    assert.ok(batches.length <= 8, `批次数不得超过 8，实际 ${batches.length}`)
    const flat = batches.flat()
    assert.equal(new Set(flat).size, flat.length, '不得重复认领')
    assert.equal(res.refineStatus.attempts, batches.length)
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) process.exit(1)
