/**
 * 设置表单模型（V-9 / ui.md 面 E）：把运行配置变成可直接渲染的表单分组，
 * 并提供「改一项」「只发变化项」两个纯规则。
 *
 * 纯函数约定：不 import、不碰 DOM、不读系统时钟；本文件稍后由 `build-theme`
 * 原样嵌进客户端 bundle。模型类（provider/model/baseUrl/apiKey）只读展示状态，
 * **apiKey 永不回显明文**。
 *
 * 校验口径（与现有 Host 归一化保持兼容，但在设置页收得更紧）：
 * - `turnLimit`：5–500 的整数，默认 50；
 * - `digestLevel`：`compact` / `standard`（默认）/ `rich`；
 * - `quoteMaxCount`：1–20，默认 5；
 * - `quoteMaxChars`：400–8000，默认 2400；
 * - `dormantDays`：0–365 的整数（0 表示从不自动沉降），默认 14；
 * - `inflectionNotice`：布尔，默认 `true`；
 * - `railNative`：布尔，默认 `false`。
 *
 * `settingsModel` 把越界值夹到边界、非法值回默认，保证表单永远显示可用值；
 * `applySetting` 才负责报中文错误，不静默吞掉用户输入。
 *
 * @module dsh-topic-map/settings-view
 */

const DEFAULT_TURN_LIMIT = 50
const TURN_LIMIT_MIN = 5
const TURN_LIMIT_MAX = 500

const DEFAULT_QUOTE_MAX_COUNT = 5
const QUOTE_MAX_COUNT_MIN = 1
const QUOTE_MAX_COUNT_MAX = 20

const DEFAULT_QUOTE_MAX_CHARS = 2400
const QUOTE_MAX_CHARS_MIN = 400
const QUOTE_MAX_CHARS_MAX = 8000

const DEFAULT_DORMANT_DAYS = 14
const DORMANT_DAYS_MIN = 0
const DORMANT_DAYS_MAX = 365

/** 自动沉降天数预设选项（也允许在 0–365 之间自定义整数）。 */
const DORMANT_DAYS_OPTIONS = Object.freeze([
  { value: 7, label: '7 天' },
  { value: 14, label: '14 天（默认）' },
  { value: 30, label: '30 天' },
  { value: 0, label: '从不自动沉降(0)' },
])

const DEFAULT_INFLECTION_NOTICE = true

const DIGEST_LEVELS = ['compact', 'standard', 'rich']
const DEFAULT_DIGEST_LEVEL = 'standard'

/** 摘要档位选项（文案里直接写清字数，用户不必再记常量）。 */
const DIGEST_LEVEL_OPTIONS = Object.freeze([
  { value: 'compact', label: '精简（200 字）' },
  { value: 'standard', label: '标准（400 字）' },
  { value: 'rich', label: '详尽（800 字）' },
])

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统一成可显示文本；对象 / null 返回空串。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 去首尾空白后的字符串。 */
function trimText(value) {
  return textOf(value).trim()
}

/**
 * 严格数字：认有限数字与数字字符串，拒绝空串 / 布尔 / null / 对象。
 *
 * @param {*} value - 原始值。
 * @returns {number|null} 有限数字或 null。
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value.trim())
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** 取整并夹到 [min, max]；非法回默认。 */
function clampInt(value, min, max, fallback) {
  const number = toNumber(value)
  if (number === null) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/** 摘要档位归一：非法回 standard。 */
function normalizeDigestLevel(value) {
  return DIGEST_LEVELS.includes(value) ? value : DEFAULT_DIGEST_LEVEL
}

/**
 * 宽松布尔解析：只认明确的真 / 假表示，其它返回 null（交给调用方报错）。
 *
 * @param {*} value - 原始值。
 * @returns {boolean|null} true / false / null。
 */
function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'off') return false
  }
  return null
}

/**
 * 生成设置表单模型。
 *
 * 每次返回全新对象，输入配置只读；模型组四项均为 `type:'readonly'`，
 * 其中 `apiKey` 只显示「已设置 / 未设置」，序列化整个模型也拿不到明文。
 *
 * @param {object} [config] - 当前配置（可缺项、可含越界值）。
 * @returns {{groups: object[]}} 分组表单模型。
 */
export function settingsModel(config) {
  const c = isPlainObject(config) ? config : {}
  const provider = trimText(c.provider)
  const model = trimText(c.model)
  const baseUrl = trimText(c.baseUrl)
  const apiKeySet = trimText(c.apiKey) !== ''

  const inflectionNotice = toBoolean(c.inflectionNotice)

  return {
    groups: [
      {
        id: 'work',
        title: '续接与事',
        items: [
          {
            key: 'dormantDays',
            label: '自动沉降天数',
            type: 'select',
            value: clampInt(c.dormantDays, DORMANT_DAYS_MIN, DORMANT_DAYS_MAX, DEFAULT_DORMANT_DAYS),
            default: DEFAULT_DORMANT_DAYS,
            min: DORMANT_DAYS_MIN,
            max: DORMANT_DAYS_MAX,
            options: DORMANT_DAYS_OPTIONS.map(option => ({ ...option })),
            help: '推测态且未置顶的事超过此天数无活动时自动转入已搁置；0 表示从不自动沉降',
          },
          {
            key: 'inflectionNotice',
            label: '拐点轻确认提示',
            type: 'boolean',
            value: inflectionNotice === null ? DEFAULT_INFLECTION_NOTICE : inflectionNotice,
            default: DEFAULT_INFLECTION_NOTICE,
            help: '切换话题、疑似收尾/卡住或重返未收束会话时，在顶部显示非阻塞轻确认条',
          },
        ],
      },
      {
        id: 'model',
        title: '模型',
        items: [
          {
            key: 'provider',
            label: '服务商',
            type: 'readonly',
            value: provider === '' ? '跟随当前会话' : provider,
            default: '跟随当前会话',
            help: '空值表示跟随当前会话使用的模型',
          },
          {
            key: 'model',
            label: '模型',
            type: 'readonly',
            value: model === '' ? '跟随当前会话' : model,
            default: '跟随当前会话',
            help: '空值表示跟随当前会话使用的模型',
          },
          {
            key: 'baseUrl',
            label: '接口地址',
            type: 'readonly',
            value: baseUrl === '' ? '未设置' : baseUrl,
            default: '未设置',
            help: '自定义端点需要接口地址与模型名同时填写才生效',
          },
          {
            key: 'apiKey',
            label: '密钥',
            type: 'readonly',
            value: apiKeySet ? '已设置' : '未设置',
            default: '未设置',
            help: '只读展示状态，密钥不会在界面回显明文',
          },
        ],
      },
      {
        id: 'index',
        title: '索引',
        items: [
          {
            key: 'turnLimit',
            label: '分析轮次上限',
            type: 'number',
            value: clampInt(c.turnLimit, TURN_LIMIT_MIN, TURN_LIMIT_MAX, DEFAULT_TURN_LIMIT),
            default: DEFAULT_TURN_LIMIT,
            min: TURN_LIMIT_MIN,
            max: TURN_LIMIT_MAX,
            help: '每次分析最多读取的最近轮次数',
          },
          {
            key: 'rebuildIndex',
            label: '重建索引',
            type: 'button',
            value: '重建索引',
            default: '重建索引',
            help: '清空并重新建立检索索引；不影响会话记录',
          },
        ],
      },
      {
        id: 'quote',
        title: '引用',
        items: [
          {
            key: 'digestLevel',
            label: '摘要档位',
            type: 'select',
            value: normalizeDigestLevel(c.digestLevel),
            default: DEFAULT_DIGEST_LEVEL,
            options: DIGEST_LEVEL_OPTIONS.map(option => ({ ...option })),
            help: '单条引用注入的摘要长度；命令由程序按档位追加',
          },
          {
            key: 'quoteMaxCount',
            label: '单条消息引用条数',
            type: 'number',
            value: clampInt(
              c.quoteMaxCount,
              QUOTE_MAX_COUNT_MIN,
              QUOTE_MAX_COUNT_MAX,
              DEFAULT_QUOTE_MAX_COUNT,
            ),
            default: DEFAULT_QUOTE_MAX_COUNT,
            min: QUOTE_MAX_COUNT_MIN,
            max: QUOTE_MAX_COUNT_MAX,
            help: '一条消息最多自动展开几条引用；先到者停',
          },
          {
            key: 'quoteMaxChars',
            label: '单条消息引用字数',
            type: 'number',
            value: clampInt(
              c.quoteMaxChars,
              QUOTE_MAX_CHARS_MIN,
              QUOTE_MAX_CHARS_MAX,
              DEFAULT_QUOTE_MAX_CHARS,
            ),
            default: DEFAULT_QUOTE_MAX_CHARS,
            min: QUOTE_MAX_CHARS_MIN,
            max: QUOTE_MAX_CHARS_MAX,
            help: '一条消息最多展开多少字引用；与条数配额先到者生效',
          },
        ],
      },
      {
        id: 'ui',
        title: '界面',
        items: [
          {
            key: 'railNative',
            label: '恢复原生导航轨',
            type: 'boolean',
            value: toBoolean(c.railNative) === true,
            default: false,
            help: '开启后不再接管会话右缘的轮次导航，改用宿主原生控件',
          },
        ],
      },
    ],
  }
}

/**
 * 应用一项设置：类型转换 + 范围校验；失败时返回中文错误且配置保持原样。
 *
 * `config` 不被修改；成功时返回浅拷贝后的新配置。
 *
 * @param {object} config - 当前配置。
 * @param {string} key - 设置键。
 * @param {*} raw - 表单原始值（字符串 / 数字 / 布尔均可）。
 * @returns {{config: object, error?: string}} 新配置或错误。
 */
export function applySetting(config, key, raw) {
  const base = isPlainObject(config) ? config : {}
  /** 失败：返回未改动的配置副本，避免调用方误用半成品。 */
  const fail = message => ({ config: { ...base }, error: message })
  /** 成功：在副本上写一项。 */
  const ok = patch => ({ config: { ...base, ...patch } })

  switch (key) {
    case 'provider':
    case 'model':
    case 'baseUrl':
    case 'apiKey': {
      const value = raw === null || raw === undefined ? '' : trimText(raw)
      return ok({ [key]: value })
    }
    case 'digestLevel': {
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (!DIGEST_LEVELS.includes(value)) {
        return fail('摘要档位需为 compact、standard 或 rich')
      }
      return ok({ digestLevel: value })
    }
    case 'turnLimit': {
      const number = toNumber(raw)
      if (number === null) return fail('分析轮次上限需为数字')
      const value = Math.floor(number)
      if (value < TURN_LIMIT_MIN || value > TURN_LIMIT_MAX) {
        return fail(`分析轮次上限需在 ${TURN_LIMIT_MIN}–${TURN_LIMIT_MAX} 之间`)
      }
      return ok({ turnLimit: value })
    }
    case 'quoteMaxCount': {
      const number = toNumber(raw)
      if (number === null) return fail('引用条数需为数字')
      const value = Math.floor(number)
      if (value < QUOTE_MAX_COUNT_MIN || value > QUOTE_MAX_COUNT_MAX) {
        return fail(`引用条数需在 ${QUOTE_MAX_COUNT_MIN}–${QUOTE_MAX_COUNT_MAX} 之间`)
      }
      return ok({ quoteMaxCount: value })
    }
    case 'quoteMaxChars': {
      const number = toNumber(raw)
      if (number === null) return fail('引用字数需为数字')
      const value = Math.floor(number)
      if (value < QUOTE_MAX_CHARS_MIN || value > QUOTE_MAX_CHARS_MAX) {
        return fail(`引用字数需在 ${QUOTE_MAX_CHARS_MIN}–${QUOTE_MAX_CHARS_MAX} 之间`)
      }
      return ok({ quoteMaxChars: value })
    }
    case 'dormantDays': {
      const number = toNumber(raw)
      if (number === null) return fail('自动沉降天数需为数字')
      const value = Math.floor(number)
      if (value < DORMANT_DAYS_MIN || value > DORMANT_DAYS_MAX) {
        return fail(`自动沉降天数需在 ${DORMANT_DAYS_MIN}–${DORMANT_DAYS_MAX} 之间`)
      }
      return ok({ dormantDays: value })
    }
    case 'inflectionNotice': {
      const value = toBoolean(raw)
      if (value === null) return fail('inflectionNotice 需为 true 或 false')
      return ok({ inflectionNotice: value })
    }
    case 'railNative': {
      const value = toBoolean(raw)
      if (value === null) return fail('railNative 需为 true 或 false')
      return ok({ railNative: value })
    }
    default:
      return fail(`未知设置项：${String(key)}`)
  }
}

/** 浅层值相等：原始值用 Object.is，普通对象 / 数组递归比较。 */
function sameValue(left, right) {
  if (Object.is(left, right)) return true
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(key => (
      Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key])
    ))
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => sameValue(entry, right[index]))
  }
  return false
}

/**
 * 只挑出 `after` 里发生变化的键值。
 *
 * 以 `after` 为准（调用方给它一份完整配置）：`before` 里没有的键也算变化；
 * `after` 缺少的键视为本次未提交，不进 POST。
 *
 * @param {object} before - 修改前配置。
 * @param {object} after - 修改后配置。
 * @returns {object} 变化项；无变化返回 `{}`。
 */
export function diffConfig(before, after) {
  const previous = isPlainObject(before) ? before : {}
  const next = isPlainObject(after) ? after : {}
  const changes = {}
  for (const key of Object.keys(next)) {
    if (!Object.prototype.hasOwnProperty.call(previous, key) || !sameValue(previous[key], next[key])) {
      changes[key] = next[key]
    }
  }
  return changes
}
