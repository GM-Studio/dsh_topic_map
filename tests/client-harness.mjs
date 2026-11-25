/**
 * 客户端组件测试 harness（零依赖）。
 *
 * 右栏三个 tab 的正文是 React 组件，但仓库没有 node_modules，也不能为了
 * 测试引入 React DOM。这里做一个**只实现所需语义**的微型运行时：
 *   - `h()` 返回可遍历的节点树（函数组件自动展开）；
 *   - `useState` / `useRef` / `useEffect` 按 hook 槽位保存状态与清理函数；
 *   - 事件后 `settle()` 反复渲染，直到状态稳定；
 *   - 假 fetch 按端点返回 `{ok,value}` / `{ok:false,error}` 信封。
 *
 * 这样测的是 `lib/client.js` 里**原样提取**的组件与请求函数，不是重写的副本。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..')
export const CLIENT_PATH = join(ROOT, 'lib', 'client.js')

export function readClient() {
  return readFileSync(CLIENT_PATH, 'utf8')
}

/**
 * 从源码里抽取一个 `function name(...) { ... }`（大括号配平）。
 *
 * 只认函数声明；抽出的文本直接进 `new Function`，所以依赖必须由调用方注入。
 */
export function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`client.js 里找不到函数 ${name}`)
  let depth = 0
  let started = false
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') { depth += 1; started = true }
    if (src[i] === '}' && started) {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`函数 ${name} 没有闭合`)
}

/** 抽取 `var NAME = [ ... ]` / `{ ... }` 这类字面量赋值。 */
export function extractAssignment(src, name) {
  const marker = `var ${name} = `
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`client.js 里找不到 var ${name}`)
  const open = src.indexOf('[', start)
  const openObj = src.indexOf('{', start)
  const isArray = open >= 0 && (openObj < 0 || open < openObj)
  const from = isArray ? open : openObj
  const closeChar = isArray ? ']' : '}'
  let depth = 0
  let quote = null
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === (isArray ? '[' : '{')) depth += 1
    if (ch === closeChar) {
      depth -= 1
      if (depth === 0) return src.slice(from, i + 1)
    }
  }
  throw new Error(`var ${name} 的字面量没有闭合`)
}

// ── 微型 vdom / hooks ───────────────────────────────────────────────
export const Fragment = Symbol('Fragment')

export function h(type, props) {
  const children = []
  for (let i = 2; i < arguments.length; i += 1) {
    const value = arguments[i]
    if (value === null || value === undefined || value === false || value === true) continue
    if (Array.isArray(value)) children.push(...value)
    else children.push(value)
  }
  return { type, props: props === null || props === undefined ? {} : props, children }
}

export const React = { Fragment }

function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (node.type === Fragment) return node.children.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return {
    type: node.type,
    props: node.props,
    children: node.children.map(expand),
  }
}

/** 深度优先找出所有满足条件的节点。 */
export function findAll(root, predicate) {
  const out = []
  function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (predicate(node)) out.push(node)
    node.children.forEach(walk)
  }
  walk(root)
  return out
}

export function byClass(root, className) {
  return findAll(root, node => String(node.props.className || '').split(/\s+/).includes(className))
}

export function byData(root, name, value) {
  return findAll(root, node => node.props[name] === value)
}

export function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return node.children.map(textOf).join('')
}

/** 点击节点：调用 props.onClick（组件里的 stopPropagation 由假事件兜底）。 */
export function click(node) {
  if (node === null || node === undefined) throw new Error('点击的节点不存在')
  if (typeof node.props.onClick !== 'function') throw new Error('节点没有 onClick')
  node.props.onClick({
    stopPropagation: function () {},
    preventDefault: function () {},
    target: node,
    currentTarget: node,
  })
}

/** 输入框变化：value 与 checked 都给，onChange 里用哪个都行。 */
export function change(node, value) {
  if (node === null || node === undefined) throw new Error('输入节点不存在')
  if (typeof node.props.onChange !== 'function') throw new Error('节点没有 onChange')
  node.props.onChange({
    stopPropagation: function () {},
    preventDefault: function () {},
    target: { value: value, checked: value === true },
    currentTarget: node,
  })
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** hook 运行时：一个组件实例。 */
export class HookRuntime {
  constructor() {
    this.hooks = []
    this.cursor = 0
    this.dirty = false
    this.pendingEffects = []
    this.component = null
    this.tree = null
  }

  useState(initial) {
    const index = this.cursor
    this.cursor += 1
    if (this.hooks[index] === undefined) this.hooks[index] = { kind: 'state', value: initial }
    const hook = this.hooks[index]
    const runtime = this
    const setState = function (next) {
      const value = typeof next === 'function' ? next(hook.value) : next
      if (!Object.is(value, hook.value)) {
        hook.value = value
        runtime.dirty = true
      }
    }
    return [hook.value, setState]
  }

  useRef(initial) {
    const index = this.cursor
    this.cursor += 1
    if (this.hooks[index] === undefined) this.hooks[index] = { kind: 'ref', current: initial }
    return this.hooks[index]
  }

  useEffect(fn, deps) {
    const index = this.cursor
    this.cursor += 1
    const hook = this.hooks[index]
    const same = hook !== undefined && hook.kind === 'effect' && sameDeps(hook.deps, deps)
    if (same) return
    if (hook !== undefined && hook.kind === 'effect' && typeof hook.cleanup === 'function') {
      try { hook.cleanup() } catch (error) { /* 清理失败不能卡住测试 */ }
    }
    const record = hook !== undefined && hook.kind === 'effect'
      ? hook
      : (this.hooks[index] = { kind: 'effect', deps: undefined, cleanup: null })
    record.deps = deps === undefined ? undefined : Array.isArray(deps) ? deps.slice() : deps
    this.pendingEffects.push({ index: index, fn: fn })
  }

  async settle(maxRounds) {
    const limit = maxRounds === undefined ? 16 : maxRounds
    this.renderOnce()
    await this.runEffects()
    for (let round = 0; round < limit && this.dirty; round += 1) {
      this.dirty = false
      await flushMicrotasks()
      this.renderOnce()
      await this.runEffects()
    }
    return this.tree
  }

  renderOnce() {
    this.cursor = 0
    this.pendingEffects = []
    this.tree = expand(this.component(this.props))
    return this.tree
  }

  async runEffects() {
    const pending = this.pendingEffects.splice(0)
    for (const effect of pending) {
      const hook = this.hooks[effect.index]
      const cleanup = effect.fn()
      if (hook !== undefined) hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
    await flushMicrotasks()
  }

  unmount() {
    for (const hook of this.hooks) {
      if (hook !== undefined && hook.kind === 'effect' && typeof hook.cleanup === 'function') {
        try { hook.cleanup() } catch (error) { /* 忽略 */ }
      }
    }
  }
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) if (!Object.is(left[i], right[i])) return false
  return true
}

/**
 * 实例化一个组件并完成首轮渲染 + effect。
 *
 * @param source - 组件与依赖函数的源码拼接。
 * @param name - 入口组件名。
 * @param depNames - 注入的自由变量名（不能与 h/hooks 重名）。
 * @param deps - 与 depNames 对应的值。
 * @param props - 组件 props。
 */
export async function renderComponent(source, name, depNames, deps, props) {
  const runtime = new HookRuntime()
  const params = ['h', 'React', 'useState', 'useRef', 'useEffect'].concat(depNames || [])
  const values = [
    h,
    React,
    runtime.useState.bind(runtime),
    runtime.useRef.bind(runtime),
    runtime.useEffect.bind(runtime),
  ].concat((deps || []).map(dep => dep))
  // eslint-disable-next-line no-new-func
  const component = new Function(...params, `${source}\n;return ${name}`)(...values)
  runtime.component = component
  runtime.props = props === undefined ? {} : props
  await runtime.settle()
  return runtime
}

// ── 假 fetch ────────────────────────────────────────────────────────
/**
 * @param handler - `({action, method, body}) => {status?, ok?, value?, error?}`。
 * @returns `{fetch, calls}`；calls 里是每次请求的 action/method/body。
 */
export function makeFetch(handler) {
  const calls = []
  function fakeFetch(url, init) {
    const action = String(url).split('/').pop()
    const method = init === undefined || init === null ? 'GET' : (init.method || 'GET')
    let body = null
    if (init !== undefined && init !== null && typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch (error) { body = init.body }
    }
    calls.push({ url: String(url), action: action, method: method, body: body })
    return Promise.resolve()
      .then(() => handler({ action: action, method: method, body: body, url: String(url) }))
      .then(result => {
        const answer = result === undefined || result === null ? {} : result
        const status = Number.isFinite(Number(answer.status)) ? Number(answer.status) : 200
        const payload = answer.ok === false
          ? { ok: false, error: answer.error === undefined ? '' : String(answer.error) }
          : { ok: true, value: answer.value }
        return {
          status: status,
          ok: status >= 200 && status < 300,
          json: function () { return Promise.resolve(payload) },
        }
      })
  }
  return { fetch: fakeFetch, calls: calls }
}

// ── 测试计数 ────────────────────────────────────────────────────────
export function makeRunner(name) {
  let passed = 0
  const failures = []
  async function test(title, fn) {
    try {
      await fn()
      passed += 1
      console.log(`  ok   ${title}`)
    } catch (error) {
      failures.push({ title, error })
      console.log(`  FAIL ${title}\n       ${error.message}`)
    }
  }
  function finish() {
    if (failures.length > 0) {
      console.log(`\n${passed} passed, ${failures.length} failed`)
      for (const failure of failures) console.log(`\n${failure.title}\n${failure.error.stack}`)
      process.exit(1)
    }
    console.log(`\n${passed} passed`)
  }
  console.log(`\n${name}`)
  return { test, finish }
}
