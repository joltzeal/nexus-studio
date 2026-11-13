import { useEffect, useState } from 'react'
import { retrySeconds } from './presentation'

export function RetryCountdown({ at }: { at: string | null | undefined }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!at) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [at])
  const seconds = retrySeconds(at, now)
  if (seconds === null) return null
  return (
    <span className="text-muted-foreground" role="timer" aria-label="重试倒计时">
      {seconds > 0 ? `${seconds} 秒后重试` : '等待恢复执行'}
    </span>
  )
}
