import { useState } from 'react'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  MAX_SCENE_PROMPT,
  MAX_VIEW_LABEL,
  MAX_VIEW_PROMPT,
  type ScenePlanDraft,
} from './scene-plan'
import type { ScenePlanResult } from './types'

export function SceneRecognition({ result }: { result: ScenePlanResult }) {
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"
      aria-label="智能识图结果"
    >
      {result.title ? (
        <>
          <dt className="text-muted-foreground">标题</dt>
          <dd className="break-words">{result.title}</dd>
        </>
      ) : null}
      {result.description ? (
        <>
          <dt className="text-muted-foreground">描述</dt>
          <dd className="whitespace-pre-wrap break-words">{result.description}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">商品</dt>
      <dd className="break-words">{result.product || '未明确'}</dd>
      <dt className="text-muted-foreground">材质</dt>
      <dd className="break-words">{result.material || '未明确'}</dd>
      <dt className="text-muted-foreground">观察</dt>
      <dd className="whitespace-pre-wrap break-words">
        {result.observations || '未提供'}
      </dd>
      <dt className="text-muted-foreground">待确认</dt>
      <dd className="whitespace-pre-wrap break-words">
        {result.uncertainties || '未列出；请自行核对识别结果'}
      </dd>
      <dt className="text-muted-foreground">推荐理由</dt>
      <dd className="whitespace-pre-wrap break-words">{result.reason || '未提供'}</dd>
    </dl>
  )
}

export function ScenePlanEditor({
  draft,
  disabled,
  onChange,
}: {
  draft: ScenePlanDraft
  disabled: boolean
  onChange: (draft: ScenePlanDraft) => void
}) {
  const [viewId, setViewId] = useState(draft.views[0]?.id ?? '')
  return (
    <FieldGroup>
      {draft.plan.result ? <SceneRecognition result={draft.plan.result} /> : null}
      <Field>
        <FieldLabel htmlFor="ai-scene-prompt">共享场景提示词</FieldLabel>
        <Textarea
          id="ai-scene-prompt"
          rows={3}
          disabled={disabled}
          value={draft.prompt}
          aria-invalid={!draft.prompt.trim() || draft.prompt.length > MAX_SCENE_PROMPT}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
        <FieldDescription>
          应用于所有视角，可调整场景、光线和陈列；原附加要求仍会保留。
        </FieldDescription>
      </Field>
      <Tabs value={viewId} onValueChange={setViewId}>
        <TabsList className="max-w-full overflow-x-auto" aria-label="编辑生成视角">
          {draft.views.map((view, index) => (
            <TabsTrigger key={view.id} value={view.id}>
              视角 {index + 1}
            </TabsTrigger>
          ))}
        </TabsList>
        {draft.views.map((view, index) => (
          <TabsContent key={view.id} value={view.id}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`ai-view-label-${index}`}>视角名称</FieldLabel>
                <Input
                  id={`ai-view-label-${index}`}
                  disabled={disabled}
                  value={view.label}
                  aria-invalid={!view.label.trim() || view.label.length > MAX_VIEW_LABEL}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      views: draft.views.map((item) =>
                        item.id === view.id
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`ai-view-prompt-${index}`}>视角要求</FieldLabel>
                <Textarea
                  id={`ai-view-prompt-${index}`}
                  rows={3}
                  disabled={disabled}
                  value={view.prompt}
                  aria-invalid={
                    !view.prompt.trim() || view.prompt.length > MAX_VIEW_PROMPT
                  }
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      views: draft.views.map((item) =>
                        item.id === view.id
                          ? { ...item, prompt: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </Field>
            </FieldGroup>
          </TabsContent>
        ))}
      </Tabs>
    </FieldGroup>
  )
}
