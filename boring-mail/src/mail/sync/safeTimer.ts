export interface ArmedTimer {
  handle: unknown
  hasHandle: boolean
  active: boolean
  arming: boolean
  firedSynchronously: boolean
}

export type TimerSetter = (callback: () => void, delayMs: number) => unknown
export type TimerClearer = (handle: unknown) => void
export type TimerClearErrorHandler = (error: unknown) => void

/**
 * Arm a timer transactionally without trusting the external handle as identity.
 * Null handles remain cancellable, stale callbacks no-op, and a provider that
 * fires synchronously is rejected instead of leaving a phantom registration.
 */
export function armSafeTimer(
  setTimer: TimerSetter,
  clearTimer: TimerClearer,
  callback: () => void,
  delayMs: number,
  onClearError: TimerClearErrorHandler,
): ArmedTimer {
  const timer: ArmedTimer = {
    handle: undefined,
    hasHandle: false,
    active: true,
    arming: true,
    firedSynchronously: false,
  }
  try {
    timer.handle = setTimer(() => {
      if (!timer.active) return
      if (timer.arming) {
        timer.firedSynchronously = true
        return
      }
      callback()
    }, delayMs)
    timer.hasHandle = true
    timer.arming = false
    if (timer.firedSynchronously) {
      cancelSafeTimer(timer, clearTimer, onClearError)
      throw new Error('setTimeout callbacks must run asynchronously')
    }
    return timer
  } catch (error) {
    timer.arming = false
    if (timer.active && timer.hasHandle) {
      try { clearTimer(timer.handle) } catch (clearError) { onClearError(clearError) }
    }
    timer.active = false
    throw error
  }
}

export function cancelSafeTimer(
  timer: ArmedTimer,
  clearTimer: TimerClearer,
  onClearError: TimerClearErrorHandler,
): void {
  if (!timer.active) return
  timer.active = false
  if (!timer.hasHandle) return
  try { clearTimer(timer.handle) } catch (error) { onClearError(error) }
}
