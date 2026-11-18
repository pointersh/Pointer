import React from "react"

const MAX_STEP_PX = 36
// No animation when motion is reduced, or while the panel is hidden: the browser pauses animation frames
// for a hidden page, which would leave a finished reply cut off until it is shown again.
const reduced = () => document.hidden || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)

// Streamed text arrives in bursts (one network chunk, then nothing). Reveal it at a steady rate that chases
// the real length: each frame shows a share of what is left, so the lag stays around 150 ms whatever the
// burst size, and a long burst types faster instead of piling up. Text that was never live shows at once.
export const useSmoothText = (text: string, live: boolean): string => {
  const [shown, setShown] = React.useState(live ? 0 : text.length)
  const target = React.useRef(text.length)
  target.current = text.length

  React.useEffect(() => {
    if (shown > text.length || reduced()) {
      setShown(text.length)
      return
    }
    if (shown === text.length) return
    const frame = requestAnimationFrame(() =>
      setShown((n) => Math.min(target.current, n + Math.max(2, Math.ceil((target.current - n) * 0.12))))
    )
    return () => cancelAnimationFrame(frame)
  }, [shown, text.length])

  React.useEffect(() => {
    const show = () => document.hidden && setShown(target.current)
    document.addEventListener("visibilitychange", show)
    return () => document.removeEventListener("visibilitychange", show)
  }, [])

  let cut = Math.min(shown, text.length)
  // Never end inside a tag such as <think>: the half tag would flash on screen as text.
  const open = text.lastIndexOf("<", cut)
  if (open > text.lastIndexOf(">", cut - 1) && cut - open < 12) cut = open
  return cut >= text.length ? text : text.slice(0, cut)
}

// Keeps a scroll container at the bottom while it is pinned there, easing toward new content each frame
// instead of jumping. Scrolling away (wheel, keys, the scrollbar) unpins it; scrolling back to the bottom
// pins it again. Returns the ref for the container and one for its content.
export const useFollowScroll = () => {
  const scroller = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  const ours = React.useRef(-1)
  const frame = React.useRef(0)

  const follow = React.useCallback(() => {
    frame.current = 0
    const el = scroller.current
    if (!el || !pinned.current) return
    const target = el.scrollHeight - el.clientHeight
    const gap = target - el.scrollTop
    if (gap <= 0.5) return
    // A big jump (a whole conversation loaded) goes straight there; growth while streaming glides.
    // A share of the gap each frame, capped: a tall block (a code box, the reply footer) glides in over a few
    // more frames instead of lurching.
    el.scrollTop = reduced() || gap > el.clientHeight * 1.5 ? target : el.scrollTop + Math.min(MAX_STEP_PX, Math.max(1, gap * 0.16))
    ours.current = el.scrollTop
    frame.current = requestAnimationFrame(follow)
  }, [])

  const kick = React.useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(follow)
  }, [follow])

  React.useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const onScroll = () => {
      // Our own steps land where we put them; anything else is the user.
      if (Math.abs(el.scrollTop - ours.current) <= 1) return
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    const observer = new ResizeObserver(kick)
    observer.observe(inner)
    observer.observe(el)
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener("scroll", onScroll)
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [kick])

  const pin = React.useCallback(() => {
    pinned.current = true
    kick()
  }, [kick])

  return { scroller, content, pin }
}
