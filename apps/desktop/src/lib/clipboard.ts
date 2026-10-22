/**
 * WebView clipboard access is not guaranteed: `navigator.clipboard` needs a
 * secure context and a permission the shell may not grant. The fallback writes
 * the text into a hidden textarea and uses the selection copy, which still
 * works in that case. Callers get a boolean instead of a silent failure so the
 * page can say the copy did not happen.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    try {
      holder.focus()
      holder.select()
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      holder.remove()
    }
  }
}
