export async function withinProfileDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  errorCode: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(errorCode))
          onTimeout?.()
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
