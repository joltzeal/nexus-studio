import { Button, Select } from '@proxyshard/shardx-ui-kit'
import { PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import {
  ACCOUNT_STATUS_LABELS,
  LOGIN_LABELS,
} from '../../../raccoon/plugins/vinted-accounts/model'
import {
  EMPTY_ACCOUNT_FILTERS,
  type AccountFilters as Filters,
} from '../../../raccoon/plugins/vinted-accounts/table'

export function AccountFilters({
  value,
  onChange,
}: {
  value: Filters
  onChange: (value: Filters) => void
}) {
  const patch = (next: Partial<Filters>) => onChange({ ...value, ...next })
  return (
    <PluginFilterRow label="账号条件筛选">
      <PluginSearch
        pageShortcut
        label="搜索账号"
        placeholder="账号、手机号、邮箱或备注"
        value={value.query}
        onChange={(event) => patch({ query: event.target.value })}
        onClear={() => patch({ query: '' })}
      />
      <Select
        className="w-[96px]!"
        label="账号状态"
        aria-label="筛选账号状态"
        size="xsmall"
        value={value.status}
        onChange={(status) => patch({ status: status as Filters['status'] })}
        options={[
          { value: 'all', label: '全部状态' },
          ...Object.entries(ACCOUNT_STATUS_LABELS).map(([value, label]) => ({
            value,
            label,
          })),
        ]}
      />
      <Select
        className="w-[104px]!"
        label="登录方式"
        aria-label="筛选登录方式"
        size="xsmall"
        value={value.loginMethod}
        onChange={(loginMethod) =>
          patch({ loginMethod: loginMethod as Filters['loginMethod'] })
        }
        options={[
          { value: 'all', label: '全部方式' },
          ...Object.entries(LOGIN_LABELS).map(([value, label]) => ({ value, label })),
        ]}
      />
      <Select
        className="w-[96px]!"
        label="手机号"
        aria-label="筛选手机号"
        size="xsmall"
        value={value.phone}
        onChange={(phone) => patch({ phone: phone as Filters['phone'] })}
        options={[
          { value: 'all', label: '全部手机号' },
          { value: 'with', label: '有手机号' },
          { value: 'without', label: '无手机号' },
        ]}
      />
      <Select
        className="w-[112px]!"
        label="Profile 关联"
        aria-label="筛选 Profile 关联"
        size="xsmall"
        value={value.binding}
        onChange={(binding) => patch({ binding: binding as Filters['binding'] })}
        options={[
          { value: 'all', label: '全部关联' },
          { value: 'bound', label: '已关联' },
          { value: 'unbound', label: '未关联 Profile' },
        ]}
      />
      <Button
        size="xsmall"
        mode="ghost"
        variant="neutral"
        onClick={() => onChange({ ...EMPTY_ACCOUNT_FILTERS })}
      >
        清除
      </Button>
    </PluginFilterRow>
  )
}
