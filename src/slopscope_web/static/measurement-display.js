const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export class FrequencyReadout {
  constructor() {
    this.reset();
  }
  reset() {
    this.history = [[], []];
    this.values = [null, null];
    this.signature = null;
    this.sequence = null;
  }
  update(frame, session) {
    const metadata = frame.metadata;
    const signature = JSON.stringify([
      session,
      metadata.nominal_hz,
      metadata.rate_index,
      metadata.ch1_range,
      metadata.ch2_range,
      metadata.ch1_coupling,
      metadata.ch2_coupling,
      metadata.acquire_mode,
      metadata.capture_epoch,
      frame.processing_generation,
    ]);
    if (signature !== this.signature) {
      this.reset();
      this.signature = signature;
    }
    if (this.sequence === metadata.sequence) return;
    this.sequence = metadata.sequence;
    for (let channel = 0; channel < 2; channel++) {
      const frequency = frame.measurements?.[channel]?.frequency_hz;
      if (!Number.isFinite(frequency) || frequency <= 0) {
        this.history[channel] = [];
        this.values[channel] = null;
        continue;
      }
      if (
        this.values[channel] &&
        Math.abs(frequency / this.values[channel] - 1) > 0.02
      )
        this.history[channel] = [];
      this.history[channel].push(frequency);
      this.history[channel] = this.history[channel].slice(-5);
      this.values[channel] = median(this.history[channel]);
    }
  }
}
