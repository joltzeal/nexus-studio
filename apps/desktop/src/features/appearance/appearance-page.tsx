import { Check, Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import {
  AccentColorSchema,
  DEFAULT_PREFERENCES,
  InterfaceDensitySchema,
  ThemeModeSchema,
} from '@nexus/contracts'
import { usePreferences } from '@/hooks/use-preferences'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SaveFeedback } from '@/components/save-feedback'

const modes = [
  { value: 'light', name: '浅色', icon: Sun },
  { value: 'dark', name: '深色', icon: Moon },
  { value: 'system', name: '跟随系统', icon: Monitor },
] as const

const accents = [
  { value: 'cobalt', name: '钴蓝' },
  { value: 'coral', name: '珊瑚' },
  { value: 'graphite', name: '石墨' },
  { value: 'iris', name: '鸢尾' },
] as const

export function AppearancePage() {
  const { preferences, update } = usePreferences()

  return (
    <div className="appearance-layout page-reveal">
      <section className="appearance-story" aria-labelledby="appearance-heading">
        <h1 className="page-heading" id="appearance-heading">
          外观设置
        </h1>
        <p className="page-description">调整主题、强调色和界面密度。</p>
      </section>

      <section className="preferences-column" aria-label="主题偏好">
        <Card className="preference-panel">
          <CardHeader>
            <CardTitle>界面偏好</CardTitle>
            <CardDescription>设置会自动保存在当前浏览器。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="preference-fields">
              <Field orientation="responsive">
                <FieldTitle id="theme-mode-label">外观模式</FieldTitle>
                <ToggleGroup
                  type="single"
                  variant="appearance"
                  size="segment"
                  className="mode-options"
                  aria-labelledby="theme-mode-label"
                  value={preferences.theme}
                  onValueChange={(value) => {
                    if (value) void update({ theme: ThemeModeSchema.parse(value) })
                  }}
                >
                  {modes.map(({ value, name, icon: Icon }) => (
                    <ToggleGroupItem value={value} key={value} aria-label={name}>
                      <Icon aria-hidden="true" />
                      {name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>

              <Field orientation="responsive">
                <FieldTitle id="accent-color-label">强调色</FieldTitle>
                <ToggleGroup
                  type="single"
                  variant="swatch"
                  size="swatch"
                  className="accent-options"
                  aria-labelledby="accent-color-label"
                  value={preferences.accent}
                  onValueChange={(value) => {
                    if (value) void update({ accent: AccentColorSchema.parse(value) })
                  }}
                >
                  {accents.map(({ value, name }) => (
                    <Tooltip key={value}>
                      <TooltipTrigger asChild>
                        <ToggleGroupItem
                          value={value}
                          data-color={value}
                          aria-label={name}
                        >
                          {preferences.accent === value ? (
                            <Check aria-hidden="true" />
                          ) : null}
                        </ToggleGroupItem>
                      </TooltipTrigger>
                      <TooltipContent>{name}</TooltipContent>
                    </Tooltip>
                  ))}
                </ToggleGroup>
              </Field>

              <Field orientation="responsive">
                <FieldTitle id="density-label">界面密度</FieldTitle>
                <ToggleGroup
                  type="single"
                  variant="segment"
                  size="segment"
                  className="density-options"
                  aria-labelledby="density-label"
                  value={preferences.density}
                  onValueChange={(value) => {
                    if (value)
                      void update({ density: InterfaceDensitySchema.parse(value) })
                  }}
                >
                  <ToggleGroupItem value="comfortable">标准</ToggleGroupItem>
                  <ToggleGroupItem value="compact">紧凑</ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <Separator />

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="reduced-motion">减少动态效果</FieldLabel>
                  <FieldDescription>关闭非必要的界面动画</FieldDescription>
                </FieldContent>
                <Switch
                  id="reduced-motion"
                  checked={preferences.reducedMotion}
                  onCheckedChange={(reducedMotion) => void update({ reducedMotion })}
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <SaveFeedback />
          </CardFooter>
        </Card>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">
              <RotateCcw data-icon="inline-start" />
              恢复默认
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>恢复默认外观？</AlertDialogTitle>
              <AlertDialogDescription>
                将恢复浅色、钴蓝与标准密度，工作区名称会保留。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void update({
                    ...DEFAULT_PREFERENCES,
                    workspaceName: preferences.workspaceName,
                  })
                }
              >
                恢复外观
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  )
}
