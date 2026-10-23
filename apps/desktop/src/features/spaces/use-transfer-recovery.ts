import { useCallback, useEffect, useState } from 'react'
import {
  transferError,
  windowTransferRecovery,
  type TransferRecoveryStatus,
} from '@/lib/platform/native-transfer'
import { observeTransferRecovery } from './transfer-state'

export function useTransferRecovery(native: boolean) {
  const [status, setStatus] = useState<TransferRecoveryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(native)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!native) return
    return observeTransferRecovery(
      windowTransferRecovery,
      (next) => {
        setStatus(next)
        setError(null)
        setChecking(false)
      },
      (cause) => {
        setError(transferError(cause))
        setChecking(false)
      },
    )
  }, [native, revision])

  const retry = useCallback(() => {
    if (!native || checking) return
    setChecking(true)
    setRevision((current) => current + 1)
  }, [native, checking])

  return { status, error, checking, retry }
}
