const DEFAULT_WARNING_MS = 8 * 60 * 1_000;
const DEFAULT_CUTOFF_MS = 10 * 60 * 1_000;

export interface FreeTierTimerOptions {
  warningMs?: number;
  cutoffMs?: number;
}

export interface FreeTierTimerHandlers {
  onWarning(): void;
  onCutoff(): void;
}

export class FreeTierTimer {
  private readonly warningMs: number;
  private readonly cutoffMs: number;
  private warningHandle: ReturnType<typeof setTimeout> | null = null;
  private cutoffHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: FreeTierTimerOptions = {}) {
    this.warningMs = opts.warningMs ?? DEFAULT_WARNING_MS;
    this.cutoffMs = opts.cutoffMs ?? DEFAULT_CUTOFF_MS;
  }

  start(handlers: FreeTierTimerHandlers): void {
    if (this.warningHandle !== null || this.cutoffHandle !== null) {
      return;
    }

    this.warningHandle = setTimeout(() => {
      handlers.onWarning();
    }, this.warningMs);

    this.cutoffHandle = setTimeout(() => {
      handlers.onCutoff();
    }, this.cutoffMs);
  }

  stop(): void {
    if (this.warningHandle !== null) {
      clearTimeout(this.warningHandle);
      this.warningHandle = null;
    }
    if (this.cutoffHandle !== null) {
      clearTimeout(this.cutoffHandle);
      this.cutoffHandle = null;
    }
  }
}
