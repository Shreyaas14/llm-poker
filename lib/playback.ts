export type PlayPace = 0 | 3 | 6;
export const DEFAULT_PLAY_PACE: PlayPace = 6;

export function playbackDelay(pace: PlayPace, handComplete: boolean): number {
  return pace === 0 ? 0 : handComplete ? 4 : pace;
}

type AutoStepOptions = {
  pace: PlayPace;
  handComplete: boolean;
  canAdvance: () => boolean;
  isBusy: () => boolean;
  onAdvance: () => void;
  onCountdown: (seconds: number) => void;
};

/** Schedule one action; its completed response supplies the next table state. */
export function scheduleAutoStep(options: AutoStepOptions): () => void {
  let cancelled = false;
  const delay = playbackDelay(options.pace, options.handComplete);
  if (delay === 0) {
    // A cancellable microtask allows effect cleanup and request guards to run
    // without adding a timer or the paced modes' settlement delay.
    void Promise.resolve().then(() => {
      if (!cancelled && options.canAdvance()) options.onAdvance();
    });
    return () => { cancelled = true; };
  }

  let due = Date.now() + delay * 1000;
  const timer = setInterval(() => {
    if (options.isBusy()) { due = Date.now() + delay * 1000; return; }
    const remaining = Math.max(0, Math.ceil((due - Date.now()) / 1000));
    options.onCountdown(remaining);
    if (remaining === 0 && !cancelled && options.canAdvance()) {
      clearInterval(timer);
      options.onAdvance();
    }
  }, 200);
  return () => { cancelled = true; clearInterval(timer); };
}
