// Restore normal window bounds onto an available display, including after unplugging a monitor.
function restoreWindow(state, displays) {
  const primary = displays[0].workArea
  const fallback = { width: Math.min(1280, primary.width), height: Math.min(800, primary.height) }
  const b = state?.bounds
  if (!b || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k])) || b.width <= 0 || b.height <= 0) return fallback
  const area = displays.find(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y)?.workArea || primary
  const width = Math.min(area.width, Math.max(1040, Math.round(b.width)))
  const height = Math.min(area.height, Math.max(560, Math.round(b.height)))
  return { width, height, x: Math.round(Math.max(area.x, Math.min(b.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(b.y, area.y + area.height - height))) }
}
module.exports = { restoreWindow }
