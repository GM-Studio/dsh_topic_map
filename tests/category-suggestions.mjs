/**
 * 自动归类端点测试：`/category-suggest` + `/category-apply-suggestions`。
 *
 * 锁住：
 *   - 只送未归类会话；标题 + 首轮提问各截 200 字；
 *   - limit 默认 20、上限 30、按 lastActive 倒序；
 *   - 模型必须走 resolveRoute + askOnce，且请求带 sessionId；
 *   - 没有模型 → 503；模型调用失败 → 502；输出非法 → 200 降级；
 *   - path 最长 3 级，超出截断；
 *   - apply 只填空：user 归类/分类不覆盖，仍计入 skipped；
 *   - apply 同级同名复用、不存在才建 model 分类，重复应用不重复建。
 *
 * Run: node tests/category-suggestions.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  apply,
  applyCategorySuggestions,
  extractCategoryKeywords,
  groupCategorySuggestions,
  planCategorySuggestionBatches,
  suggestCategories,
  syncSessionIndexFor,
} from '../lib/index.js'

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

const WS = 'ws-suggest'
const BASE_TIME = 1_700_000_000_000

/** 一轮完整事件，带 request/header 供 resolveRoute 用。 */
function makeEvents(options = {}) {
  const provider = options.provider ?? 'agent2api'
  const model = options.model ?? 'DeepSeek-Flash'
  const time = options.time ?? BASE_TIME
  const prompt = options.prompt ?? '第一轮提问'
  let seq = 0
  const push = (type, data) => ({ type, seq: seq++, time, data })
  return [
    push('request/header', { header: { config: { provider, model } } }),
    push('turn/start', { turn: 0 }),
    push('user/message', { content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '回答' }],
        source: { kind: 'model', provider, model },
      },
    }),
    push('turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
}

/** 多轮事件（首轮/最后一轮 prompt 不同时用）。 */
function makeMultiTurnEvents(prompts) {
  let seq = 0
  const push = (type, data) => ({ type, seq: seq++, time: BASE_TIME, data })
  const events = [push('request/header', {
    header: { config: { provider: 'agent2api', model: 'DeepSeek-Flash' } },
  })]
  prompts.forEach((prompt, turn) => {
    events.push(push('turn/start', { turn }))
    events.push(push('user/message', {
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    events.push(push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '回答' }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }))
    events.push(push('turn/end', { turn, reason: { kind: 'completed' } }))
  })
  return events
}

/** 自动回复：从 prompt 材料里逐个 sessionId 提取，给出合法 JSON。 */
function autoReply(user) {
  const ids = [...String(user ?? '').matchAll(/sessionId:\s*([^\s]+)/g)].map(match => match[1])
  return JSON.stringify(ids.map((sessionId, index) => ({
    sessionId,
    path: ['自动大类', `子类${index % 3}`],
  })))
}

/** 假模型：记录 system/user/streams；可静态/动态回复；可失败。 */
function makeFakeLlm(options = {}) {
  const state = { calls: 0, systems: [], users: [], streams: [], prepared: [] }
  return {
    get calls() { return state.calls },
    get systems() { return state.systems },
    get users() { return state.users },
    get streams() { return state.streams },
    get prepared() { return state.prepared },
    async prepareCall(call) {
      state.calls += 1
      state.prepared.push(call)
      state.systems.push(String(call.system ?? ''))
      const user = String(call.messages?.[0]?.content?.[0]?.text ?? '')
      state.users.push(user)
      const text = typeof options.text === 'function'
        ? options.text(user)
        : options.text !== undefined ? options.text : autoReply(user)
      return {
        config: { ...call },
        async *stream(dispatch) {
          state.streams.push(dispatch)
          if (options.fail === true) throw new Error('model down')
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    listProviders() {
      return [{ id: 'fake' }]
    },
  }
}

/**
 * 假 Host context。
 *
 * events/titles/lastActive 用于 /category-suggest；apply 只用到工作区。
 */
function makeCtx(options = {}) {
  const sessions = options.sessions ?? Object.keys(options.events ?? {})
  const events = options.events ?? {}
  const titles = options.titles ?? {}
  const lastActive = options.lastActive ?? {}
  const llm = options.llm
  const records = sessions.map(id => ({
    header: {
      id,
      createdAt: BASE_TIME - 10_000,
      origin: options.origin?.[id] ?? 'main',
      delegationDepth: 0,
    },
    ...(Number.isFinite(lastActive[id]) ? { updatedAt: lastActive[id] } : {}),
  }))
  return {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{
            id: options.workspaceId ?? WS,
            path: 'E:\\ws',
            title: '建议工作区',
            sessionIds: sessions,
          }],
        }
      }
      if (name === 'llm') return llm
      return undefined
    },
    sessionQuery: {
      async listSessions() {
        return records
      },
      async readTitleSnapshots(ids) {
        return ids.map(id => ({
          status: 'fulfilled',
          sessionId: id,
          value: { title: { title: titles[id] ?? id } },
        }))
      },
      async readSession(id) {
        return { events: events[id] ?? [] }
      },
    },
    sessionPersistence: {
      async stat() {
        return { revision: 'rev-1' }
      },
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'category-suggestions-'))
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

async function writeStore(home, store) {
  const dir = join(home, 'topic-map', 'categories')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${WS}.json`), JSON.stringify(store, null, 2), 'utf8')
}

async function readStore(home) {
  return JSON.parse(await readFile(join(home, 'topic-map', 'categories', `${WS}.json`), 'utf8'))
}

function suggestionIds(result) {
  return result.value.suggestions.map(item => item.sessionId)
}

function categoryByName(store, name) {
  return store.categories.find(category => category.name === name)
}

console.log('\ncategory-suggestions')

// ═══════════════════════════════════════════════════════════════════
// /category-suggest
// ═══════════════════════════════════════════════════════════════════

await test('只送未归类：无 assignment 与空 categoryId 入选，已有 model/user 归类跳过', async () => {
  await withTempHome(async home => {
    const sessions = ['sess-none', 'sess-empty', 'sess-model', 'sess-user']
    const events = Object.fromEntries(sessions.map((id, index) => [
      id,
      makeEvents({ prompt: `提问 ${id}`, time: BASE_TIME + index * 1000 }),
    ]))
    const titles = Object.fromEntries(sessions.map(id => [id, `标题 ${id}`]))
    await writeStore(home, {
      version: 1,
      categories: [
        { id: 'cat-model', name: '模型旧类', parentId: null, source: 'model' },
        { id: 'cat-user', name: '人工旧类', parentId: null, source: 'user' },
      ],
      assignments: {
        'sess-empty': { categoryId: '', source: 'user' },
        'sess-model': { categoryId: 'cat-model', source: 'model' },
        'sess-user': { categoryId: 'cat-user', source: 'user' },
      },
    })
    const llm = makeFakeLlm()
    const ctx = makeCtx({
      sessions,
      events,
      titles,
      lastActive: { 'sess-none': BASE_TIME + 3000, 'sess-empty': BASE_TIME + 2000 },
      llm,
    })

    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(Object.keys(result.value).sort(), [
      'elapsedMs', 'model', 'suggestions', 'usage',
    ])
    assert.equal(result.value.usage.sessions, 2)
    assert.ok(result.value.usage.chars > 0)
    assert.equal(result.value.usage.batches, 1)
    assert.deepEqual(suggestionIds(result), ['sess-none', 'sess-empty'])
    assert.equal(result.value.model, 'DeepSeek-Flash')
    assert.ok(Number.isFinite(result.value.elapsedMs))

    // 材料里不能出现已归类的会话
    const promptText = llm.users[0]
    assert.ok(promptText.includes('sess-none'))
    assert.ok(promptText.includes('sess-empty'))
    assert.ok(!promptText.includes('sess-model'), '已有 model 归属不应入选')
    assert.ok(!promptText.includes('sess-user'), '已有 user 归属不应入选')
    // 提示词要求 JSON 数组、每项 sessionId + path
    assert.ok(promptText.includes('JSON 数组'))
    assert.ok(promptText.includes('sessionId'))
    assert.ok(promptText.includes('path'))
    // 模型调用必须带 sessionId（否则真机 400 MissingSessionID）
    assert.equal(llm.streams[0].sessionId, 'sess-none')
    assert.ok(llm.streams[0].maxTokens > 0)
    assert.equal(result.value.suggestions[0].sessionTitle, '标题 sess-none')
    assert.ok(typeof result.value.suggestions[0].confidence === 'number')
  })
})

await test('limit 默认 20，按 lastActive 倒序取；材料也只含入选会话', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const sessions = Array.from({ length: 25 }, (_, index) => `sess-${String(index).padStart(2, '0')}`)
    const events = Object.fromEntries(sessions.map(id => [id, makeEvents({ prompt: `提问 ${id}` })]))
    const titles = Object.fromEntries(sessions.map(id => [id, `标题 ${id}`]))
    const lastActive = Object.fromEntries(sessions.map((id, index) => [id, BASE_TIME + index * 1000]))
    const llm = makeFakeLlm()
    const ctx = makeCtx({ sessions, events, titles, lastActive, llm })

    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.value.suggestions.length, 20, '默认上限 20')
    const expected = [...sessions].sort((a, b) => lastActive[b] - lastActive[a]).slice(0, 20)
    assert.deepEqual(suggestionIds(result), expected, '应按最后活动倒序')
    assert.equal(result.value.usage.sessions, 20)
    assert.equal(result.value.usage.batches, 1)
    assert.ok(!llm.users[0].includes('sess-00'), '最旧的不应进入材料')
    assert.ok(llm.users[0].includes('sess-24'))
  })
})

await test('limit 显式值生效；超过 30 封顶 30', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const sessions = Array.from({ length: 35 }, (_, index) => `sess-${String(index).padStart(2, '0')}`)
    const events = Object.fromEntries(sessions.map(id => [id, makeEvents({ prompt: `提问 ${id}` })]))
    const lastActive = Object.fromEntries(sessions.map((id, index) => [id, BASE_TIME + index * 1000]))
    const titles = Object.fromEntries(sessions.map(id => [id, id]))

    const two = await suggestCategories(
      makeCtx({ sessions, events, titles, lastActive, llm: makeFakeLlm() }),
      { workspaceId: WS, limit: 2 },
    )
    assert.deepEqual(suggestionIds(two), ['sess-34', 'sess-33'])

    const capped = await suggestCategories(
      makeCtx({ sessions, events, titles, lastActive, llm: makeFakeLlm() }),
      { workspaceId: WS, limit: 999 },
    )
    assert.equal(capped.value.suggestions.length, 30, '一次最多 30 个会话')
    assert.equal(capped.value.usage.sessions, 30)
    assert.equal(capped.value.usage.batches, 2, '30 个会话按每批 ≤20 分成 2 批')
  })
})

await test('没有可用模型：503 + 明确中文错误', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ sessions: [], events: {}, llm: undefined })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 503)
    assert.equal(result.error, '自动归类需要先配置模型')
  })
})

await test('模型输出不是 JSON：200 降级，error 说明，不是 500', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({
      sessions: ['sess-a'],
      events: { 'sess-a': makeEvents({ prompt: '甲' }) },
      titles: { 'sess-a': '会话甲' },
      llm: makeFakeLlm({ text: '我觉得这个会话属于插件开发。' }),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.suggestions, [])
    assert.ok(typeof result.value.error === 'string' && result.value.error !== '')
    assert.equal(result.value.partial, true)
    assert.deepEqual(result.value.failedBatches, [1])
    assert.equal(result.value.usage.batches, 1)
    assert.equal(result.value.model, 'DeepSeek-Flash')
    assert.ok(Number.isFinite(result.value.elapsedMs))
  })
})

await test('JSON 字段缺失：200 降级为空建议 + error', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({
      sessions: ['sess-a'],
      events: { 'sess-a': makeEvents({ prompt: '甲' }) },
      titles: { 'sess-a': '会话甲' },
      llm: makeFakeLlm({ text: '[{"sessionId":"sess-a"}]' }),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.suggestions, [])
    assert.equal(result.value.partial, true)
    assert.deepEqual(result.value.failedBatches, [1])
    assert.ok(result.value.error.includes('path') || result.value.error.includes('可用'))
  })
})

await test('path 超过 3 级被截断，未入选会话的建议被忽略', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const text = JSON.stringify([
      { sessionId: 'sess-a', path: ['一级', '二级', '三级', '四级'] },
      { sessionId: 'sess-ghost', path: ['幽灵'] },
      { sessionId: 'sess-b', path: ['两层', '子层'] },
    ])
    const ctx = makeCtx({
      sessions: ['sess-a', 'sess-b'],
      events: {
        'sess-a': makeEvents({ prompt: '甲' }),
        'sess-b': makeEvents({ prompt: '乙' }),
      },
      titles: { 'sess-a': '会话甲', 'sess-b': '会话乙' },
      llm: makeFakeLlm({ text }),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    assert.deepEqual(suggestionIds(result), ['sess-a', 'sess-b'])
    const a = result.value.suggestions[0]
    const b = result.value.suggestions[1]
    assert.deepEqual(a.categoryPath, ['一级', '二级', '三级'], '第 4 级必须截掉')
    assert.deepEqual(b.categoryPath, ['两层', '子层'])
    assert.ok(a.confidence >= 0 && a.confidence <= 1)
    assert.equal(typeof a.reason, 'string')
  })
})

await test('材料口径：标题 60 / 首轮 120 / 最后一轮 120 / 关键词行', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const longTitle = '题'.repeat(250)
    const longFirst = '首'.repeat(260)
    const longLast = '末'.repeat(260)
    const ctx = makeCtx({
      sessions: ['sess-long'],
      events: { 'sess-long': makeMultiTurnEvents([longFirst, longLast]) },
      titles: { 'sess-long': longTitle },
      llm: makeFakeLlm(),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    assert.equal(result.value.suggestions.length, 1)
    const suggestion = result.value.suggestions[0]
    assert.equal(typeof suggestion.reason, 'string')
    assert.ok(typeof suggestion.confidence === 'number')

    const user = ctx.get('llm').users[0]
    assert.ok(user.includes('题'.repeat(60)))
    assert.ok(!user.includes('题'.repeat(61)), '标题超过 60 字必须截断')
    assert.ok(user.includes('首'.repeat(120)))
    assert.ok(!user.includes('首'.repeat(121)), '首轮提问超过 120 字必须截断')
    assert.ok(user.includes('末'.repeat(120)), '材料必须包含最后一轮提问')
    assert.ok(!user.includes('末'.repeat(121)), '最后一轮提问超过 120 字必须截断')
    assert.ok(user.includes('关键词：'))
  })
})

await test('模型调用失败：降级为该批失败（partial），不挂死也不 500', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({
      sessions: ['sess-a'],
      events: { 'sess-a': makeEvents({ prompt: '甲' }) },
      titles: { 'sess-a': '会话甲' },
      llm: makeFakeLlm({ fail: true }),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    assert.equal(result.value.suggestions.length, 0)
    assert.equal(result.value.partial, true)
    assert.deepEqual(result.value.failedBatches, [1])
    assert.ok(result.value.error.includes('模型调用失败'))
    assert.deepEqual(result.value.usage, { sessions: 1, chars: result.value.usage.chars, batches: 1 })
  })
})

await test('全部已归类：返回空建议且不调用模型', async () => {
  await withTempHome(async home => {
    await writeStore(home, {
      version: 1,
      categories: [{ id: 'cat-all', name: '都已归类', parentId: null, source: 'model' }],
      assignments: { 'sess-a': { categoryId: 'cat-all', source: 'model' } },
    })
    const llm = makeFakeLlm()
    const ctx = makeCtx({
      sessions: ['sess-a'],
      events: { 'sess-a': makeEvents({ prompt: '甲' }) },
      titles: { 'sess-a': '会话甲' },
      llm,
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.suggestions, [])
    assert.equal(llm.calls, 0, '没有候选就不该烧模型')
    assert.equal(result.value.model, 'DeepSeek-Flash')
  })
})

await test('本地关键词：中文 2-gram、英文单词、停用词与 TF 排序', () => {
  const keywords = extractCategoryKeywords([
    { prompt: '测试测试测试 测试中文中文 the and of 测试' },
  ])
  assert.ok(keywords.length <= 8)
  assert.equal(keywords[0], '测试', 'TF 最高的中文 2-gram 应排第一')
  assert.ok(keywords.includes('中文'))
  for (const stopword of ['the', 'and', 'of', '的', '了']) {
    assert.ok(!keywords.includes(stopword), `停用词不应入选：${stopword}`)
  }
})

await test('本地关键词：files 文件名主干与 commands 首词各取 2 个锚点', () => {
  const keywords = extractCategoryKeywords([
    {
      prompt: '插件开发 插件开发 会话归档',
      files: ['E:\\ws\\lib\\index.js', 'E:\\ws\\lib\\index.js', 'E:\\ws\\src\\other.ts'],
      commands: ['npm test', 'npm run build', 'git status'],
    },
  ])
  assert.ok(keywords.length <= 8)
  assert.ok(keywords[0] === '插件')
  for (const token of ['index', 'other', 'npm', 'git']) {
    assert.ok(keywords.includes(token), `缺少文件/命令锚点：${token}`)
  }
})

await test('本地分组：Jaccard ≥0.5 聚组并给出 sharedKeywords', () => {
  const groups = groupCategorySuggestions([
    { sessionId: 'a', keywords: ['插件', '开发', '索引'] },
    { sessionId: 'b', keywords: ['插件', '开发', '检索'] },
    { sessionId: 'c', keywords: ['外卖', '骑手'] },
    { sessionId: 'd', keywords: ['插件', '开发', '索引'] },
  ])
  assert.deepEqual(groups, [{
    group: 1,
    sessions: [1, 2, 4],
    sharedKeywords: ['插件', '开发'],
  }])

  // 1/5 = 0.2 < 0.5，不聚组
  assert.deepEqual(groupCategorySuggestions([
    { sessionId: 'a', keywords: ['甲', '乙', '丙'] },
    { sessionId: 'b', keywords: ['甲', '丁', '戊'] },
  ]), [])
})

await test('分批规划：每批 ≤20 个会话，材料 >12000 字时按字数拆', () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    sessionTitle: `会话${index}`, firstPrompt: '', lastPrompt: '', keywords: [],
  }))
  assert.deepEqual(planCategorySuggestionBatches(many).map(batch => batch.length), [20, 5])

  const heavy = Array.from({ length: 5 }, (_, index) => ({
    sessionTitle: 'x'.repeat(5000), firstPrompt: '', lastPrompt: '', keywords: [],
  }))
  assert.deepEqual(planCategorySuggestionBatches(heavy).map(batch => batch.length), [2, 2, 1])

  const huge = [{ sessionTitle: 'x'.repeat(13000), firstPrompt: '', lastPrompt: '', keywords: [] }]
  assert.deepEqual(planCategorySuggestionBatches(huge).map(batch => batch.length), [1])
})

await test('分组提示会随材料交给模型（group / sessions / sharedKeywords）', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const prompt = '插件开发 索引 检索 插件开发 索引 检索'
    const ctx = makeCtx({
      sessions: ['sess-a', 'sess-b'],
      events: {
        'sess-a': makeEvents({ prompt }),
        'sess-b': makeEvents({ prompt }),
      },
      titles: { 'sess-a': '甲', 'sess-b': '乙' },
      llm: makeFakeLlm(),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true)
    const user = ctx.get('llm').users[0]
    assert.ok(user.includes('本地分组提示'))
    assert.ok(user.includes('"group":1'))
    assert.ok(user.includes('"sessions":[1,2]'))
    assert.ok(user.includes('"sharedKeywords"'))
  })
})

await test('输出字段：reason ≤40 字、confidence 0–1、alt 可选保留', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const longReason = '因为首轮提到插件开发，最后一轮又在改索引，所以归到这个分类下面。'
    const text = JSON.stringify([
      {
        sessionId: 'sess-a',
        path: ['开发', '插件'],
        reason: longReason,
        confidence: 0.4,
        alt: '旁支分类',
      },
      { sessionId: 'sess-b', path: ['开发'], reason: '依据乙', confidence: 1.7 },
    ])
    const ctx = makeCtx({
      sessions: ['sess-a', 'sess-b'],
      events: {
        'sess-a': makeEvents({ prompt: '插件开发 索引' }),
        'sess-b': makeEvents({ prompt: '会话归档 检索' }),
      },
      titles: { 'sess-a': '甲', 'sess-b': '乙' },
      llm: makeFakeLlm({ text }),
    })
    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(suggestionIds(result), ['sess-a', 'sess-b'], '按材料顺序返回')
    const low = result.value.suggestions[0]
    assert.equal(low.confidence, 0.4)
    assert.equal(low.reason, longReason.slice(0, 40))
    assert.equal(low.alt, '旁支分类')
    const high = result.value.suggestions[1]
    assert.equal(high.confidence, 1, 'confidence 封顶 1')
    assert.equal(high.reason, '依据乙')
    assert.equal(high.alt, undefined, '未给 alt 时不输出该字段')

    const user = ctx.get('llm').users[0]
    assert.ok(user.includes('confidence'))
    assert.ok(user.includes('reason'))
    assert.ok(user.includes('alt'))
  })
})

await test('取材优先级：关键词与首末提问读索引，索引缺失才退日志', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const indexEvents = makeMultiTurnEvents(['索引首轮 插件开发', '索引末轮 会话归档'])
    const logEvents = makeMultiTurnEvents(['日志首轮 外卖骑手', '日志末轮 完全不同'])
    const ctx = makeCtx({
      sessions: ['sess-idx'],
      events: { 'sess-idx': indexEvents },
      titles: { 'sess-idx': '索引会话' },
      llm: makeFakeLlm(),
    })
    await syncSessionIndexFor(ctx, 'sess-idx')
    // 索引建好后把日志换成完全不同的内容：材料应仍以索引为准。
    ctx.sessionQuery.readSession = async () => ({ events: logEvents })

    const result = await suggestCategories(ctx, { workspaceId: WS })
    assert.equal(result.ok, true, result.error)
    const user = ctx.get('llm').users[0]
    assert.ok(user.includes('索引首轮'))
    assert.ok(user.includes('索引末轮'))
    assert.ok(!user.includes('日志首轮'), '不应退回日志')
    assert.ok(!user.includes('日志末轮'), '不应退回日志')
  })
})

await test('分批执行：某批输出不可用只标记该批，返回 partial 与失败批号', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const sessions = Array.from({ length: 25 }, (_, index) => `sess-${String(index).padStart(2, '0')}`)
    const events = Object.fromEntries(sessions.map(id => [id, makeEvents({ prompt: `提问 ${id}` })]))
    const titles = Object.fromEntries(sessions.map(id => [id, id]))
    const lastActive = Object.fromEntries(sessions.map((id, index) => [id, BASE_TIME + index * 1000]))
    let call = 0
    const llm = makeFakeLlm({
      text: user => {
        call += 1
        return call === 1 ? '第一批量输出坏了' : autoReply(user)
      },
    })
    const ctx = makeCtx({ sessions, events, titles, lastActive, llm })
    const result = await suggestCategories(ctx, { workspaceId: WS, limit: 25 })
    assert.equal(result.ok, true)
    assert.equal(result.value.partial, true)
    assert.deepEqual(result.value.failedBatches, [1])
    assert.equal(result.value.usage.sessions, 25)
    assert.equal(result.value.usage.batches, 2)
    assert.ok(result.value.usage.chars > 0)
    assert.equal(llm.calls, 2, '两批都要调用，不能因第一批失败中止')
    // 排序：sess-24 … sess-00，第二批是最后 5 个（最旧）
    assert.deepEqual(suggestionIds(result), ['sess-04', 'sess-03', 'sess-02', 'sess-01', 'sess-00'])
    assert.ok(result.value.error.includes('第 1 批'))
  })
})

// ═══════════════════════════════════════════════════════════════════
// /category-apply-suggestions
// ═══════════════════════════════════════════════════════════════════

await test('apply 新建分类并归到最深一级（source:model），返回 store/tree/applied/skipped', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({ sessions: ['sess-a', 'sess-b'], events: {} })
    const result = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [
        { sessionId: 'sess-a', sessionTitle: '甲', categoryPath: ['工作', '插件'] },
        { sessionId: 'sess-b', sessionTitle: '乙', categoryPath: ['工作', '插件'] },
      ],
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.applied, 2)
    assert.equal(result.value.skipped, 0)
    const store = result.value.store
    const work = categoryByName(store, '工作')
    const plugin = categoryByName(store, '插件')
    assert.ok(work !== undefined && plugin !== undefined)
    assert.equal(work.parentId, null)
    assert.equal(plugin.parentId, work.id)
    assert.equal(work.source, 'model')
    assert.equal(plugin.source, 'model')
    assert.equal(store.assignments['sess-a'].categoryId, plugin.id)
    assert.equal(store.assignments['sess-b'].categoryId, plugin.id)
    assert.equal(store.assignments['sess-a'].source, 'model')
    // tree 带层级
    const root = result.value.tree.find(node => node.name === '工作')
    assert.ok(root !== undefined)
    assert.equal(root.children[0].name, '插件')
    assert.equal(root.children[0].count, 2)
    // 落盘与返回一致
    assert.deepEqual(await readStore(home), store)
  })
})

await test('apply 只填空：user 归类跳过、分类名不被覆盖，也不为它新建分类', async () => {
  await withTempHome(async home => {
    const initial = {
      version: 1,
      categories: [{ id: 'cat-u', name: '人工旧类', parentId: null, source: 'user' }],
      assignments: { 'sess-user': { categoryId: 'cat-u', source: 'user' } },
    }
    await writeStore(home, initial)
    const ctx = makeCtx({ sessions: ['sess-user', 'sess-new'], events: {} })
    const result = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [
        { sessionId: 'sess-user', categoryPath: ['模型大类', '模型子类'] },
        { sessionId: 'sess-new', categoryPath: ['模型大类', '新子类'] },
      ],
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.applied, 1)
    assert.equal(result.value.skipped, 1)
    const store = result.value.store
    assert.equal(store.assignments['sess-user'].categoryId, 'cat-u')
    assert.equal(store.assignments['sess-user'].source, 'user')
    assert.equal(categoryByName(store, '人工旧类').source, 'user')
    assert.equal(categoryByName(store, '模型子类'), undefined, '被跳过的建议不应建分类')
    assert.equal(categoryByName(store, '新子类').source, 'model')
  })
})

await test('apply 同级同名复用：已有 user 大类不重复建、source 保持 user', async () => {
  await withTempHome(async home => {
    const initial = {
      version: 1,
      categories: [{ id: 'cat-work', name: '工作', parentId: null, source: 'user' }],
      assignments: {},
    }
    await writeStore(home, initial)
    const ctx = makeCtx({ sessions: ['sess-a'], events: {} })
    const result = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [{ sessionId: 'sess-a', categoryPath: ['工作', '插件'] }],
    })
    assert.equal(result.ok, true, result.error)
    const store = result.value.store
    assert.equal(store.categories.length, 2, '只应新增子类')
    assert.equal(categoryByName(store, '工作').id, 'cat-work')
    assert.equal(categoryByName(store, '工作').source, 'user')
    assert.equal(categoryByName(store, '插件').parentId, 'cat-work')
    assert.equal(store.assignments['sess-a'].categoryId, categoryByName(store, '插件').id)
  })
})

await test('apply 幂等：重复应用不重复建、分类 id 与 assignment 不变', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({ sessions: ['sess-a'], events: {} })
    const body = {
      workspaceId: WS,
      suggestions: [{ sessionId: 'sess-a', categoryPath: ['重复', '两次'] }],
    }
    const first = await applyCategorySuggestions(ctx, body)
    assert.equal(first.ok, true, first.error)
    const second = await applyCategorySuggestions(ctx, body)
    assert.equal(second.ok, true, second.error)
    assert.equal(second.value.applied, 1)
    assert.equal(second.value.store.categories.length, 2, '第二次不应新增分类')
    assert.deepEqual(
      second.value.store.categories.map(category => category.id).sort(),
      first.value.store.categories.map(category => category.id).sort(),
    )
    assert.equal(
      second.value.store.assignments['sess-a'].categoryId,
      first.value.store.assignments['sess-a'].categoryId,
    )
  })
})

await test('apply path 超过 3 级：只建到第 3 级并归到第 3 级', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({ sessions: ['sess-a'], events: {} })
    const result = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [{ sessionId: 'sess-a', categoryPath: ['甲', '乙', '丙', '丁'] }],
    })
    assert.equal(result.ok, true, result.error)
    const store = result.value.store
    assert.equal(store.categories.length, 3)
    assert.equal(categoryByName(store, '丁'), undefined)
    const first = categoryByName(store, '甲')
    const second = categoryByName(store, '乙')
    const third = categoryByName(store, '丙')
    assert.equal(first.parentId, null)
    assert.equal(second.parentId, first.id)
    assert.equal(third.parentId, second.id)
    assert.equal(store.assignments['sess-a'].categoryId, third.id)
  })
})

await test('apply 非法 suggestions：非数组 400；无效项忽略但仍返回 store', async () => {
  await withTempHome(async home => {
    await writeStore(home, { version: 1, categories: [], assignments: {} })
    const ctx = makeCtx({ sessions: ['sess-a'], events: {} })

    const badBody = await applyCategorySuggestions(ctx, { workspaceId: WS, suggestions: 'nope' })
    assert.equal(badBody.ok, false)
    assert.equal(badBody.httpStatus, 400)

    const result = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [
        null,
        { sessionId: '', categoryPath: ['空'] },
        { sessionId: 'sess-a' },
        { sessionId: 'sess-a', categoryPath: [] },
      ],
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.applied, 0)
    assert.equal(result.value.skipped, 0)
    assert.deepEqual(result.value.store.categories, [])
  })
})

await test('apply 旧式字符串 user assignment 也跳过', async () => {
  await withTempHome(async home => {
    await writeStore(home, {
      version: 1,
      categories: [{ id: 'cat-u', name: '旧人工', parentId: null, source: 'user' }],
      assignments: { 'sess-user': 'cat-u' },
    })
    const ctx = makeCtx({ sessions: ['sess-user'], events: {} })
    const result = await applyCategorySuggestions(ctx, {
      workspaceId: WS,
      suggestions: [{ sessionId: 'sess-user', categoryPath: ['新自动'] }],
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.applied, 0)
    assert.equal(result.value.skipped, 1)
    assert.equal(categoryByName(result.value.store, '新自动'), undefined)
    assert.equal(result.value.store.assignments['sess-user'], 'cat-u')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 路由接线（信封 / HTTP 状态）
// ═══════════════════════════════════════════════════════════════════

/** 用假 ctx 调 apply，拿到注册的 webServer handler（与 endpoints-route 同法）。 */
function registerRouteHandler() {
  const registered = []
  const webScope = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(config) {
          registered.push(config)
          return () => {}
        },
      }
    },
    effect(fn) {
      fn()
    },
  }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: WS, path: 'E:\\route-ws', title: '路由工作区', sessionIds: [] }],
        }
      }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('webServer')) callback(webScope)
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply 应注册一个前缀路由')
  return registered[0].handler
}

async function callRoute(handler, action, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = `/api/topic-map/${action}`
  req.method = 'POST'
  let status = 0
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(value) {
      text = value
    },
  }
  await handler(req, res)
  return { status, body: text === '' ? null : JSON.parse(text) }
}

await test('/category-suggest 已接线：无模型 → 503 + 统一错误信封', async () => {
  await withTempHome(async () => {
    const handler = registerRouteHandler()
    const result = await callRoute(handler, 'category-suggest', { workspaceId: WS })
    assert.equal(result.status, 503)
    assert.deepEqual(result.body, { ok: false, error: '自动归类需要先配置模型' })
  })
})

await test('/category-apply-suggestions 已接线：200 + store/tree/applied/skipped', async () => {
  await withTempHome(async () => {
    const handler = registerRouteHandler()
    const result = await callRoute(handler, 'category-apply-suggestions', {
      workspaceId: WS,
      suggestions: [],
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.value.applied, 0)
    assert.equal(result.body.value.skipped, 0)
    assert.deepEqual(result.body.value.store.categories, [])
    assert.deepEqual(result.body.value.tree, [])
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
