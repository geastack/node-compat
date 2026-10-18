
const matchHtmlRegExp = /["'&<>]/

export default function escapeHtml(string: string): string {
  const match = matchHtmlRegExp.exec(string)
  if (match === null) return string

  let escape = ''
  let html = ''
  let index = 0
  let lastIndex = 0

  for (index = match.index; index < string.length; index++) {
    switch (string.charCodeAt(index)) {
      case 34:
        escape = '&quot;'
        break
      case 38:
        escape = '&amp;'
        break
      case 39:
        escape = '&#39;'
        break
      case 60:
        escape = '&lt;'
        break
      case 62:
        escape = '&gt;'
        break
      default:
        continue
    }

    if (lastIndex !== index) html += string.substring(lastIndex, index)

    lastIndex = index + 1
    html += escape
  }

  return lastIndex !== index ? html + string.substring(lastIndex, index) : html
}
