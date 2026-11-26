/**
 * 分类实体化端点测试（P1-3 / P1-4）。
 *
 * 锁：/categories 整份读取、/category-save 新建与改名、/category-assign
 * 归类与取消、/category-organize 合并/移动/拆分、/category-undo 回滚、
 * `source:'user'` 人工标记不被降级、持久化串行化，以及 400/404/502/504。
 *
 * Run: node tests/category-endpoints.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assignCategory,
  organizeCategories,
  readCategoryIndex,
  saveCategory,
  undoCategoryOrganize,
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

const WS = 'ws-category-1'
const CTX = {
  get(name) {
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ id: WS, path: 'E:\\ws', title: '分类工作区', sessionIds: [] }],
      }
    }
    return undefined
  },
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'category-endpoints-'))
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

function storePath(home) {
  return join(home, 'topic-map', 'categories', `${WS}.json`)
}

async function writeRawStore(home, store) {
  await mkdir(join(home, 'topic-map', 'categories'), { recursive: true })
  await writeFile(storePath(home), JSON.stringify(store, null, 2), 'utf8')
}

async function readRawStore(home) {
  return JSON.parse(await readFile(storePath(home), 'utf8'))
}

/** 从 tree 里按 id 找节点（含子节点）。 */
function findNode(nodes, id) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found !== null) return found
  }
  return null
}

console.log('\ncategory-endpoints')

await test('/categories：空 store 返回 version 1、空分类与空树', async () => {
  await withTempHome(async () => {
    const result = await readCategoryIndex(CTX, { workspaceId: WS })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(
      {
        version: result.value.version,
        categories: result.value.categories,
        assignments: result.value.assignments,
        tree: result.value.tree,
      },
      { version: 1, categories: [], assignments: {}, tree: [] },
    )
    // 嵌套 `store` 是客户端实际读取的字段，必须存在且一致。
    assert.deepEqual(result.value.store.categories, [])
    assert.deepEqual(result.value.tree, [])
  })
})

await test('/category-save：新建分类写 source:user，落盘并可读回', async () => {
  await withTempHome(async home => {
    const saved = await saveCategory(CTX, { workspaceId: WS, name: '插件开发' })
    assert.equal(saved.ok, true, saved.error)
    assert.match(saved.value.id, /^c-[0-9a-z]{6}$/)
    assert.equal(saved.value.categories.length, 1)
    assert.equal(saved.value.categories[0].name, '插件开发')
    assert.equal(saved.value.categories[0].source, 'user')
    assert.equal(findNode(saved.value.tree, saved.value.id).name, '插件开发')

    const raw = await readRawStore(home)
    assert.equal(raw.categories.length, 1)
    assert.equal(raw.categories[0].source, 'user')

    const read = await readCategoryIndex(CTX, { workspaceId: WS })
    assert.equal(read.value.categories[0].id, saved.value.id)
  })
})

await test('/category-save：带 id 改名，id/父级不变且 source 仍是 user', async () => {
  await withTempHome(async () => {
    const parent = await saveCategory(CTX, { workspaceId: WS, name: '父分类' })
    const child = await saveCategory(CTX, {
      workspaceId: WS,
      name: '旧名',
      parentId: parent.value.id,
    })
    assert.equal(child.ok, true, child.error)

    const renamed = await saveCategory(CTX, {
      workspaceId: WS,
      id: child.value.id,
      name: '新名',
    })
    assert.equal(renamed.ok, true, renamed.error)
    assert.equal(renamed.value.id, child.value.id)
    const category = renamed.value.categories.find(item => item.id === child.value.id)
    assert.equal(category.name, '新名')
    assert.equal(category.parentId, parent.value.id)
    assert.equal(category.source, 'user')
  })
})

await test('/category-save：空名/坏 id/不存在的父级 → 400；工作区不存在 → 404', async () => {
  await withTempHome(async () => {
    const emptyName = await saveCategory(CTX, { workspaceId: WS, name: '   ' })
    assert.equal(emptyName.ok, false)
    assert.equal(emptyName.httpStatus, 400)
    assert.match(emptyName.error, /name/)

    const badId = await saveCategory(CTX, { workspaceId: WS, id: 42, name: '甲' })
    assert.equal(badId.ok, false)
    assert.equal(badId.httpStatus, 400)

    const badParent = await saveCategory(CTX, { workspaceId: WS, name: '乙', parentId: 7 })
    assert.equal(badParent.ok, false)
    assert.equal(badParent.httpStatus, 400)

    const noParent = await saveCategory(CTX, { workspaceId: WS, name: '丙', parentId: 'c-missing' })
    assert.equal(noParent.ok, false)
    assert.equal(noParent.httpStatus, 400)
    assert.match(noParent.error, /父分类不存在/)

    const noWorkspace = await saveCategory(CTX, { workspaceId: 'ws-missing', name: '丁' })
    assert.equal(noWorkspace.ok, false)
    assert.equal(noWorkspace.httpStatus, 404)
  })
})

await test('/category-assign：归类后 assignments 是 {categoryId,source}，null 取消', async () => {
  await withTempHome(async () => {
    const cat = await saveCategory(CTX, { workspaceId: WS, name: '归类目标' })
    const assigned = await assignCategory(CTX, {
      workspaceId: WS,
      sessionId: 'sess-1',
      categoryId: cat.value.id,
    })
    assert.equal(assigned.ok, true, assigned.error)
    assert.deepEqual(assigned.value.assignments['sess-1'], {
      categoryId: cat.value.id,
      source: 'user',
    })
    assert.equal(findNode(assigned.value.tree, cat.value.id).count, 1)

    const freed = await assignCategory(CTX, {
      workspaceId: WS,
      sessionId: 'sess-1',
      categoryId: null,
    })
    assert.equal(freed.ok, true, freed.error)
    assert.equal(freed.value.assignments['sess-1'], undefined)
    assert.equal(findNode(freed.value.tree, cat.value.id).count, 0)
  })
})

await test('/category-assign：缺 sessionId/categoryId、分类不存在 → 400', async () => {
  await withTempHome(async () => {
    const cat = await saveCategory(CTX, { workspaceId: WS, name: '目标' })
    const noSession = await assignCategory(CTX, { workspaceId: WS, categoryId: cat.value.id })
    assert.equal(noSession.ok, false)
    assert.equal(noSession.httpStatus, 400)
    assert.match(noSession.error, /sessionId/)

    const noCategory = await assignCategory(CTX, { workspaceId: WS, sessionId: 's' })
    assert.equal(noCategory.ok, false)
    assert.equal(noCategory.httpStatus, 400)
    assert.match(noCategory.error, /categoryId/)

    const badCategory = await assignCategory(CTX, {
      workspaceId: WS,
      sessionId: 's',
      categoryId: 'c-missing',
    })
    assert.equal(badCategory.ok, false)
    assert.equal(badCategory.httpStatus, 400)
    assert.match(badCategory.error, /分类不存在/)
  })
})

await test('/category-organize：合并 → undo → /category-undo 完整还原', async () => {
  await withTempHome(async () => {
    const a = await saveCategory(CTX, { workspaceId: WS, name: '工作' })
    const b = await saveCategory(CTX, { workspaceId: WS, name: '其他' })
    await assignCategory(CTX, { workspaceId: WS, sessionId: 's1', categoryId: a.value.id })
    await assignCategory(CTX, { workspaceId: WS, sessionId: 's2', categoryId: b.value.id })
    const before = (await readCategoryIndex(CTX, { workspaceId: WS })).value

    const merged = await organizeCategories(CTX, {
      workspaceId: WS,
      op: { kind: 'merge', ids: [a.value.id, b.value.id], name: '合并后' },
    })
    assert.equal(merged.ok, true, merged.error)
    assert.ok(merged.value.undo)
    assert.equal(merged.value.store.categories.length, 1)
    assert.equal(merged.value.store.categories[0].name, '合并后')
    for (const sessionId of ['s1', 's2']) {
      assert.equal(merged.value.store.assignments[sessionId].categoryId, a.value.id)
    }

    const undone = await undoCategoryOrganize(CTX, { workspaceId: WS, undo: merged.value.undo })
    assert.equal(undone.ok, true, undone.error)
    assert.deepEqual(undone.value, before)
  })
})

await test('/category-organize：移动与拆分；非法 op → 400；noop 不改 store', async () => {
  await withTempHome(async () => {
    const a = await saveCategory(CTX, { workspaceId: WS, name: 'A' })
    const b = await saveCategory(CTX, { workspaceId: WS, name: 'B' })
    const child = await saveCategory(CTX, { workspaceId: WS, name: '子', parentId: a.value.id })
    await assignCategory(CTX, { workspaceId: WS, sessionId: 's1', categoryId: child.value.id })

    const moved = await organizeCategories(CTX, {
      workspaceId: WS,
      op: { kind: 'move', id: child.value.id, parentId: b.value.id },
    })
    assert.equal(moved.ok, true, moved.error)
    assert.equal(moved.value.store.categories.find(item => item.id === child.value.id).parentId, b.value.id)

    const split = await organizeCategories(CTX, {
      workspaceId: WS,
      op: { kind: 'split', id: child.value.id, moves: [{ sessionId: 's1', toId: a.value.id }] },
    })
    assert.equal(split.ok, true, split.error)
    assert.equal(split.value.store.assignments.s1.categoryId, a.value.id)

    const bad = await organizeCategories(CTX, { workspaceId: WS, op: { kind: 'nope' } })
    assert.equal(bad.ok, false)
    assert.equal(bad.httpStatus, 400)

    const noOp = await organizeCategories(CTX, {
      workspaceId: WS,
      op: { kind: 'assign', sessionId: 's1', categoryId: a.value.id },
    })
    assert.equal(noOp.ok, true, noOp.error)
    assert.equal(noOp.value.undo.kind, 'noop')
  })
})

await test('人工优先：模型分类被人改名后 source 升为 user，人工分类不降级', async () => {
  await withTempHome(async home => {
    await writeRawStore(home, {
      version: 1,
      categories: [
        { id: 'c-model', name: '模型名', parentId: null, source: 'model' },
        { id: 'c-user', name: '人工名', parentId: null, source: 'user' },
      ],
      assignments: {},
    })
    const adopted = await saveCategory(CTX, {
      workspaceId: WS,
      id: 'c-model',
      name: '人工改名',
    })
    assert.equal(adopted.ok, true, adopted.error)
    assert.equal(adopted.value.categories.find(item => item.id === 'c-model').source, 'user')

    const untouched = await saveCategory(CTX, {
      workspaceId: WS,
      id: 'c-user',
      name: '人工名',
    })
    assert.equal(untouched.ok, true, untouched.error)
    assert.equal(untouched.value.categories.find(item => item.id === 'c-user').source, 'user')

    const assigned = await assignCategory(CTX, {
      workspaceId: WS,
      sessionId: 's1',
      categoryId: 'c-user',
    })
    assert.equal(assigned.value.assignments.s1.source, 'user')
  })
})

await test('并发保存：同一工作区的读改写串行，两个分类都不丢', async () => {
  await withTempHome(async () => {
    const [left, right] = await Promise.all([
      saveCategory(CTX, { workspaceId: WS, name: '并发甲' }),
      saveCategory(CTX, { workspaceId: WS, name: '并发乙' }),
    ])
    assert.equal(left.ok, true, left.error)
    assert.equal(right.ok, true, right.error)
    const store = (await readCategoryIndex(CTX, { workspaceId: WS })).value
    assert.deepEqual(store.categories.map(item => item.name).sort(), ['并发乙', '并发甲'])
  })
})

await test('损坏的分类文件 → 502；读取超时 → 504', async () => {
  await withTempHome(async home => {
    await mkdir(join(home, 'topic-map', 'categories'), { recursive: true })
    await writeFile(storePath(home), '{broken', 'utf8')
    const broken = await readCategoryIndex(CTX, { workspaceId: WS })
    assert.equal(broken.ok, false)
    assert.equal(broken.httpStatus, 502)
    assert.match(broken.error, /分类操作失败/)

    const timeout = await readCategoryIndex(CTX, { workspaceId: WS }, {
      timeoutMs: 20,
      loadStore: () => new Promise(() => {}),
    })
    assert.equal(timeout.ok, false)
    assert.equal(timeout.httpStatus, 504)
    assert.match(timeout.error, /超时/)
  })
})

await test('/category-undo：移动 undo 精确还原；undo 非对象 → 400', async () => {
  await withTempHome(async () => {
    const parent = await saveCategory(CTX, { workspaceId: WS, name: '父' })
    const child = await saveCategory(CTX, { workspaceId: WS, name: '子', parentId: parent.value.id })
    const before = (await readCategoryIndex(CTX, { workspaceId: WS })).value

    const moved = await organizeCategories(CTX, {
      workspaceId: WS,
      op: { kind: 'move', id: child.value.id, parentId: null },
    })
    assert.equal(moved.ok, true, moved.error)
    assert.equal(moved.value.store.categories.find(item => item.id === child.value.id).parentId, null)

    const undone = await undoCategoryOrganize(CTX, { workspaceId: WS, undo: moved.value.undo })
    assert.equal(undone.ok, true, undone.error)
    assert.deepEqual(undone.value, before)

    const bad = await undoCategoryOrganize(CTX, { workspaceId: WS, undo: 'nope' })
    assert.equal(bad.ok, false)
    assert.equal(bad.httpStatus, 400)
  })
})

await test('/category-undo：缺 undo → 400；未知 undo 是无操作', async () => {
  await withTempHome(async () => {
    const saved = await saveCategory(CTX, { workspaceId: WS, name: '保留' })
    const missing = await undoCategoryOrganize(CTX, { workspaceId: WS })
    assert.equal(missing.ok, false)
    assert.equal(missing.httpStatus, 400)

    const unknown = await undoCategoryOrganize(CTX, {
      workspaceId: WS,
      undo: { kind: 'no-such-kind' },
    })
    assert.equal(unknown.ok, true, unknown.error)
    assert.deepEqual(unknown.value.categories, saved.value.categories)
    assert.deepEqual(unknown.value.assignments, saved.value.assignments)
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
