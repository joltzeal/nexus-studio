const STAGES: Record<string, string> = {
  queued: '等待执行',
  starting: '准备执行窗口',
  inspect: '检查账号状态',
  record_inspection: '保存账号检查结果',
  read_balance: '读取账号余额',
  record_balance: '保存余额记录',
  read_evidence: '读取账号资料',
  classify: '判断账号状态',
  record_classification: '保存账号状态',
  image_review: '检查商品图片',
  copy_review: '检查商品文案',
  rewrite: '生成英文文案',
  open: '打开操作页面',
  prepare: '准备商品资料',
  capture_baseline: '核对提交前记录',
  submit: '提交中',
  confirm: '核对提交结果',
  sync: '同步发布记录',
  advance: '准备下一件商品',
  halt: '等待处理',
  finished: '执行结束',
  cancelled: '已取消',
  paused: '已暂停',
  retry_wait: '等待重试',
  rate_limited: '等待限流冷却',
  cooldown: '等待账号冷却',
  model_wait: '等待模型额度',
  budget_exhausted: '已达到预算上限',
  reconciling: '核对已有结果',
  restart_reconcile: '恢复后核对结果',
  publication_sync_conflict: '发布记录需要核对',
  publication_synced: '发布记录已同步',
  takeover_requested: '等待人工接管',
  isolating: '正在隔离执行窗口',
  isolated: '已隔离，可人工操作',
  provider_isolated: '执行窗口已隔离',
  preflight_failed: '运行前检查未通过',
}

export function stageLabel(phase: string): string {
  return phase ? (STAGES[phase] ?? '正在处理') : '等待开始'
}

export function retrySeconds(at: string | null | undefined, now = Date.now()) {
  if (!at) return null
  const timestamp = Date.parse(at)
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - now) / 1000))
    : null
}

export function moneyLabel(cost: number | null, currency = 'USD'): string {
  return cost === null ? '费用未知' : `${currency} ${cost.toFixed(4)}`
}

export function recoveryHint(state: string): string {
  switch (state) {
    case 'result_unknown':
      return '请核对结果；确认前不要重复提交、跳过或修改此商品。'
    case 'sync_pending':
      return '外部结果已确认，请同步记录；无需重新上架或重发消息。'
    case 'blocked':
      return '账号已封禁，禁止写入。请查看账号资料并处理限制。'
    case 'review_required':
      return '查看原文、候选文案和判断原因，再修订、跳过或确认继续。'
    case 'failed':
      return '查看失败原因和窗口状态；确认没有未决提交后再恢复执行。'
    default:
      return ''
  }
}
