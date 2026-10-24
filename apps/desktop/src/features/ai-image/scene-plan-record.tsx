import { Badge } from '@/components/ui/badge'
import { FieldError } from '@/components/ui/field'
import { SceneRecognition } from './scene-plan-editor'
import { viewStatusText, type GenerationRecord } from './types'

export function ScenePlanRecord({
  scene,
}: {
  scene: NonNullable<GenerationRecord['scenePlan']>
}) {
  return (
    <section className="flex flex-col gap-4" aria-label="场景方案与视角记录">
      <div className="ai-copy-block">
        <h3>智能识图与场景方案</h3>
        <p className="text-xs text-muted-foreground">
          {scene.plan.providerName} · {scene.plan.model}
        </p>
        {scene.plan.result ? <SceneRecognition result={scene.plan.result} /> : null}
      </div>
      <div className="ai-copy-block">
        <h3>共享场景提示词</h3>
        <p className="ai-copy-text is-prompt">{scene.prompt}</p>
      </div>
      <div className="flex flex-col gap-3">
        {scene.views.map((view, index) => (
          <details key={view.id} className="text-sm" open={view.status === 'failed'}>
            <summary className="cursor-pointer">
              <span className="mr-2">
                {index + 1}. {view.label}
              </span>
              <Badge variant={view.status === 'failed' ? 'destructive' : 'outline'}>
                {viewStatusText(view.status)}
              </Badge>
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {view.error ? <FieldError>{view.error}</FieldError> : null}
              <p className="text-xs text-muted-foreground">视角要求</p>
              <p className="whitespace-pre-wrap break-words">{view.prompt}</p>
              <p className="text-xs text-muted-foreground">实际生成提示词</p>
              <p className="whitespace-pre-wrap break-words">
                {view.effectivePrompt || '等待生成'}
              </p>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
