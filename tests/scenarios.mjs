/**
 * 对话形态的边界场景测试。
 *
 * 这些场景来自用户提出的真实疑问：一段长对话里，话题会以各种方式
 * 穿插出现。分段必须能应对全部形态，不能只在"规整数据"上正确。
 *
 *   ① 连续多段 + 前后跳回
 *   ② 完全不连续，多跳跃
 *   ③ 多轮长会话含跳回
 *   ④ 每轮都是独立话题
 *   ⑤ 前期不连续、后期连续
 *   ⑥ 前期连续、后期不连续
 *   ⑦ 无内容的应答轮（「继续」「开始吧」）
 *   ⑧ 极短会话（两轮）
 *
 * 用 assignLanes 直接跑。文本自带话题内共用术语——这是真实对话的
 * 特征（同一件事会反复提到同样的名词），也是字面相似度唯一能工作的前提。
 *
 * Run: node tests/scenarios.mjs
 */

import { strict as assert } from 'node:assert'
import { assignLanes } from '../lib/lane-engine.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 每个话题的措辞池：同话题内共用术语，跨话题几乎无交集。 */
const TOPIC = {
  a: [
    '话题地图的泳道排布不太对，映射的节点都挤在一起了',
    '话题地图的时间轴缩放要以鼠标为中心，泳道节点跟着动',
    '泳道之间的分叉连线看不清，话题地图要像 git graph',
  ],
  b: [
    '订单表的索引没走，慢查询扫了全表，得加索引',
    '执行计划显示用了 filesort，索引还是没命中',
    '再加一个联合索引看看，慢查询应该能走索引',
  ],
  c: [
    '打包后体积到 8MB 了，需要压缩构建产物',
    '构建产物里 sourcemap 太大，打包要排除',
    'splitChunks 配置改一下，压缩后体积能降',
  ],
  d: [
    '容器镜像启动后端口没映射，部署失败',
    'k8s 的 service 配置要检查，容器端口映射',
    '部署脚本里环境变量漏了，镜像起不来',
  ],
  e: [
    '单元测试覆盖率只有 40%，用例不够',
    '这几个断言写错了，测试用例要改',
    '回归测试跑一遍，覆盖率要上 80%',
  ],
  f: [
    'README 里缺少安装说明，文档不全',
    '文档里的示例代码跑不通，要更新',
    '注释和实现不一致，文档要同步',
  ],
  g: [
    '火焰图里 GC 占了 30%，性能有问题',
    '内存采样发现泄漏，GC 频繁',
    '性能瓶颈在序列化，火焰图显示得清楚',
  ],
  h: [
    '鉴权令牌过期没刷新，权限校验失败',
    '权限校验漏了管理员角色，鉴权要补',
    '接口签名验证失败，令牌要重签',
  ],
}

/**
 * 按标签序列造轮次。
 * '.' 表示无内容的应答轮。
 */
function makeTurns(labels) {
  const seen = {}
  return labels.map((ch, i) => {
    if (ch === '.') {
      return {
        turn: i + 1, prompt: '继续', response: '好的',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        steps: 1, toolCalls: 0, durationMs: 500,
        endReason: 'completed', files: [], tools: [], commands: [],
      }
    }
    const pool = TOPIC[ch] ?? TOPIC.a
    const k = seen[ch] ?? 0
    seen[ch] = k + 1
    return {
      turn: i + 1,
      prompt: pool[k % pool.length],
      response: `已定位第 ${i + 1} 处并修复`,
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      steps: 1, toolCalls: 0, durationMs: 1000,
      endReason: 'completed', files: [], tools: [], commands: [],
    }
  })
}

function lanesOf(labels) {
  return assignLanes({ turns: makeTurns(labels), sessionId: 'test' })
}

/** 断言：段数在区间内，且每段连续覆盖全部轮次。 */
function expectLanes(labels, lo, hi) {
  const lanes = lanesOf(labels)
  const n = lanes.length
  assert.ok(n >= lo && n <= hi,
    `${labels.join(' ')} 期望 ${lo}-${hi} 段，实际 ${n} 段：` + lanes.map(l => '[' + l.turns.join(',') + ']').join(' '))
  // 覆盖性：所有轮次恰好出现一次
  const all = lanes.flatMap(l => l.turns).sort((a, b) => a - b)
  assert.deepEqual(all, labels.map((_, i) => i + 1), '每轮必须恰好属于一段')
  return lanes
}

console.log('\nscenarios')

// ── 六种形态 ────────────────────────────────────────────────────────
test('① 连续多段 + 前后跳回', () => {
  // a a a | b b b | c c | 回 b | 回 a
  expectLanes(['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'b', 'a'], 4, 8)
})

test('② 完全不连续，多跳跃', () => {
  // 12 轮几乎每轮换话题，应该切得很碎而不是糊成一片
  const lanes = expectLanes(['a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'f', 'h', 'a', 'b'], 8, 12)
  assert.ok(lanes.length >= 8, '跳跃型对话必须切得比连续型碎')
})

test('③ 多轮长会话含跳回', () => {
  const labels = ['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'a', 'a', 'a', 'c', 'c', 'c', 'c', 'b', 'b', 'b']
  expectLanes(labels, 5, 9)
})

test('④ 每轮都是独立话题', () => {
  expectLanes(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 6, 9)
})

test('⑤ 前期不连续、后期连续', () => {
  expectLanes(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'g', 'g', 'g'], 5, 9)
})

test('⑥ 前期连续、后期不连续', () => {
  expectLanes(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'c', 'd', 'e', 'f'], 6, 10)
})

// ── 补充边界 ────────────────────────────────────────────────────────
test('⑦ 无内容应答轮不独占一段', () => {
  // 「继续」这类轮次不该单独成段，应并入相邻话题
  const lanes = lanesOf(['a', 'a', '.', 'b', 'b', '.', 'c', 'c'])
  const singles = lanes.filter(l => l.turns.length === 1)
  // 允许极少数，但不应每个填充轮都成段
  assert.ok(singles.length <= 2, `填充轮不该都独立成段，实际 ${singles.length} 个单轮段`)
})

test('⑧ 极短会话（两轮）不崩', () => {
  const lanes = lanesOf(['a', 'b'])
  assert.ok(lanes.length >= 1 && lanes.length <= 2)
})

test('⑨ 单轮会话不崩', () => {
  const lanes = lanesOf(['a'])
  assert.equal(lanes.length, 1)
  assert.deepEqual(lanes[0].turns, [1])
})

test('⑩ 空会话返回空', () => {
  assert.deepEqual(assignLanes({ turns: [], sessionId: 'x' }), [])
})

test('⑪ 全部同一话题时不乱切', () => {
  const lanes = lanesOf(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a'])
  assert.ok(lanes.length <= 4, `同一话题不该切成 ${lanes.length} 段`)
})

test('⑫ 跳回同一个话题时尽量不新开线', () => {
  // 第 7-9 轮与第 1-3 轮文本完全相同，应尽量接回原线
  const lanes = lanesOf(['a', 'a', 'a', 'b', 'b', 'b', 'a', 'a', 'a'])
  // 段数应明显少于 9（说明有回游合并），但不强制要求合并成 2 段
  assert.ok(lanes.length < 9, `完全相同的内容应能部分回游，实际 ${lanes.length} 段`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
