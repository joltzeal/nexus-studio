import { useEffect, useState } from 'react'
import { Button } from '@proxyshard/shardx-ui-kit'
import { forgetImage, imageObjectUrl } from '../../../raccoon/plugins/ai-image/api'
import { message } from '../../../raccoon/plugins/ai-image/types'
import { ImageOwners } from './image-owners'

const imageOwners = new ImageOwners(forgetImage)

export function RecordImage({
  file,
  alt,
  className = 'h-52 w-full',
}: {
  file: { id: string; mime: string }
  alt: string
  className?: string
}) {
  const [state, setState] = useState<{ id: string; url?: string; error?: string } | null>(
    null,
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    const release = imageOwners.retain(file.id)
    void imageObjectUrl(file.id, file.mime).then(
      (url) => {
        if (active) setState({ id: file.id, url })
      },
      (error) => {
        if (active) setState({ id: file.id, error: message(error) })
      },
    )
    return () => {
      active = false
      release()
    }
  }, [file.id, file.mime, attempt])
  if (state?.id === file.id && state.url)
    return (
      <img
        src={state.url}
        alt={alt}
        className={`${className} rounded-control bg-bg-weak-50 object-contain`}
      />
    )
  return (
    <div
      className={`${className} flex flex-col items-center justify-center gap-2 rounded-control bg-bg-weak-50 p-2 text-secondary text-text-sub-600`}
    >
      <span>{state?.id === file.id && state.error ? state.error : '正在读取图片'}</span>
      {state?.id === file.id && state.error && (
        <Button
          size="xsmall"
          mode="stroke"
          variant="neutral"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重新读取
        </Button>
      )}
    </div>
  )
}
