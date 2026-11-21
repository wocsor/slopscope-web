import { SCALES_MV } from "./webusb.js";
export const PROCESSING_DEFAULTS = {
  mode: "sample",
  averages: 16,
  math: "off",
  math_source: 0,
  math_reversed: 0,
  persistence: 0,
  fft_window: "hann",
  fft_units: "dbv",
  style: "lines",
  intensity: 90,
};
const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b),
    position = (sorted.length - 1) * fraction;
  return (
    sorted[Math.floor(position)] * (1 - (position % 1)) +
    sorted[Math.ceil(position)] * (position % 1)
  );
}
const median = (values) => percentile(values, 0.5);
function smooth(values) {
  return values
    .slice(0, -4)
    .map((_, index) => mean(values.slice(index, index + 5)));
}
function crossings(values, level, rising = true) {
  const candidates = [];
  for (let index = 0; index < values.length - 1; index++)
    if (
      rising
        ? values[index] < level && values[index + 1] >= level
        : values[index] >= level && values[index + 1] < level
    )
      candidates.push(index);
  return candidates
    .filter(
      (index, position) => !position || index - candidates[position - 1] > 3,
    )
    .map(
      (index) =>
        index + (level - values[index]) / (values[index + 1] - values[index]),
    );
}
export function measure(samples, sampleRate) {
  const low = Math.min(...samples),
    high = Math.max(...samples),
    average = mean(samples),
    squareSum = samples.reduce((sum, value) => sum + value * value, 0);
  const base = percentile(samples, 0.1),
    top = percentile(samples, 0.9),
    amplitude = top - base;
  const result = {
    min: low,
    max: high,
    mean: average,
    rms: Math.sqrt(squareSum / samples.length),
    ac_rms: Math.sqrt(mean(samples.map((value) => (value - average) ** 2))),
    pp: high - low,
    square_sum: squareSum,
    area_codes_s: samples.reduce((sum, value) => sum + value, 0) / sampleRate,
    frequency_hz: null,
    period_s: null,
    duty_percent: null,
    positive_width_s: null,
    negative_width_s: null,
    rise_s: null,
    fall_s: null,
    cycle_rms: null,
    cycle_mean: null,
    clipped: samples.some((value) => value <= -124 || value >= 124),
    sample_count: samples.length,
    base,
    top,
    amplitude,
    overshoot_percent:
      amplitude >= 12 ? (Math.max(0, high - top) / amplitude) * 100 : null,
    undershoot_percent:
      amplitude >= 12 ? (Math.max(0, base - low) / amplitude) * 100 : null,
  };
  if (amplitude < 12 || samples.length < 12) return result;
  const filtered = smooth(samples),
    rising = crossings(filtered, (base + top) / 2),
    falling = crossings(filtered, (base + top) / 2, false);
  if (rising.length < 2) return result;
  const periods = rising.slice(1).map((edge, index) => edge - rising[index]),
    typical = median(periods);
  if (
    typical < 8 ||
    periods.some((period) => Math.abs(period - typical) > typical * 0.15)
  )
    return result;
  const period = (rising.at(-1) - rising[0]) / (rising.length - 1),
    widths = [],
    lows = [];
  rising.slice(0, -1).forEach((start, index) => {
    const edges = falling.filter(
      (edge) => edge > start && edge < rising[index + 1],
    );
    if (edges.length === 1) {
      widths.push(edges[0] - start);
      lows.push(rising[index + 1] - edges[0]);
    }
  });
  if (!widths.length) return result;
  Object.assign(result, {
    frequency_hz: sampleRate / period,
    period_s: period / sampleRate,
    duty_percent: (mean(widths) / period) * 100,
    positive_width_s: mean(widths) / sampleRate,
    negative_width_s: mean(lows) / sampleRate,
  });
  const cycle = samples.slice(
    Math.ceil(rising[0]) + 2,
    Math.floor(rising.at(-1)) + 2,
  );
  if (cycle.length) {
    result.cycle_mean = mean(cycle);
    result.cycle_rms = Math.sqrt(mean(cycle.map((value) => value * value)));
  }
  for (const [risingEdge, key] of [
    [true, "rise_s"],
    [false, "fall_s"],
  ]) {
    const starts = crossings(
        samples,
        base + amplitude * (risingEdge ? 0.1 : 0.9),
        risingEdge,
      ),
      ends = crossings(
        samples,
        base + amplitude * (risingEdge ? 0.9 : 0.1),
        risingEdge,
      ),
      durations = [];
    for (const start of starts) {
      const end = ends.find(
        (edge) => edge >= start && edge - start < period * 0.25,
      );
      if (end !== undefined && end - start >= 2) durations.push(end - start);
    }
    if (durations.length) result[key] = median(durations) / sampleRate;
  }
  return result;
}
function channelTiming(channels, sampleRate, measurements) {
  if (measurements.some((reading) => !reading.frequency_hz)) return null;
  const frequencies = measurements.map((reading) => reading.frequency_hz);
  if (
    Math.abs(frequencies[0] - frequencies[1]) >
    Math.min(...frequencies) * 0.02
  )
    return null;
  const period = sampleRate / frequencies[0],
    edges = channels.map((samples, index) =>
      crossings(
        smooth(samples),
        (measurements[index].base + measurements[index].top) / 2,
      ),
    );
  if (edges.some((channel) => channel.length < 2)) return null;
  const wrap = (value) =>
    ((((value + period / 2) % period) + period) % period) - period / 2;
  const deltas = edges[0].map((edge) =>
    wrap(
      edges[1].reduce((best, candidate) =>
        Math.abs(candidate - edge) < Math.abs(best - edge) ? candidate : best,
      ) - edge,
    ),
  );
  const lag = median(deltas);
  if (deltas.some((value) => Math.abs(wrap(value - lag)) > period * 0.1))
    return null;
  return {
    delay_s: lag / sampleRate,
    phase_deg: (lag / period) * 360,
    cycles: deltas.length,
    reference: "CH1",
    channel: "CH2",
  };
}

function radix2(real, imaginary, inverse = false) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [
        imaginary[reversed],
        imaginary[index],
      ];
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / width,
      stepReal = Math.cos(angle),
      stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let twiddleReal = 1,
        twiddleImaginary = 0;
      for (let offset = 0; offset < width / 2; offset++) {
        const left = start + offset,
          right = left + width / 2;
        const productReal =
            real[right] * twiddleReal - imaginary[right] * twiddleImaginary,
          productImaginary =
            real[right] * twiddleImaginary + imaginary[right] * twiddleReal;
        real[right] = real[left] - productReal;
        imaginary[right] = imaginary[left] - productImaginary;
        real[left] += productReal;
        imaginary[left] += productImaginary;
        [twiddleReal, twiddleImaginary] = [
          twiddleReal * stepReal - twiddleImaginary * stepImaginary,
          twiddleReal * stepImaginary + twiddleImaginary * stepReal,
        ];
      }
    }
  }
  if (inverse)
    for (let index = 0; index < size; index++) {
      real[index] /= size;
      imaginary[index] /= size;
    }
}
function besselI0(value) {
  let sum = 1,
    term = 1;
  for (let order = 1; order < 50; order++) {
    term *= (value / (2 * order)) ** 2;
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}
function mathVolts(samples, settings, metadata, channel) {
  const range = metadata[`ch${channel + 1}_range`];
  const cal = settings.calibration?.[channel]?.[range] || {
    zero: 0,
    gain: SCALES_MV[range] * 10240,
    dac: 0,
    slope: 0,
  };
  const dac = (metadata.offsets_packed >>> (channel * 16)) & 65535;
  const gain = (cal.gain / 256000000) * (settings.channels[channel].probe || 1);
  const offset = (-(cal.zero + (dac - cal.dac) * cal.slope) / 65536) * gain;
  return samples.map((value) => value * gain + offset);
}
function spectrum(
  samples,
  sampleRate,
  windowName,
  voltage = false,
  units = "dbv",
) {
  const count = samples.length,
    average = mean(samples);
  let size = 1;
  while (size < count * 2 - 1) size *= 2;
  const real = new Float64Array(size),
    imaginary = new Float64Array(size),
    kernelReal = new Float64Array(size),
    kernelImaginary = new Float64Array(size);
  let windowSum = 0;
  for (let index = 0; index < count; index++) {
    const angle = (2 * Math.PI * index) / (count - 1);
    const window =
      windowName === "hann"
        ? 0.5 - 0.5 * Math.cos(angle)
        : windowName === "hamming"
          ? 0.54 - 0.46 * Math.cos(angle)
          : windowName === "blackman"
            ? 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle)
            : windowName === "kaiser"
              ? besselI0(
                  6.5 *
                    Math.sqrt(
                      Math.max(0, 1 - ((2 * index) / (count - 1) - 1) ** 2),
                    ),
                ) / besselI0(6.5)
              : windowName === "bartlett"
                ? 1 - Math.abs((2 * index) / (count - 1) - 1)
                : 1;
    windowSum += window;
    const chirp = (Math.PI * ((index * index) % (2 * count))) / count,
      cosine = Math.cos(chirp),
      sine = Math.sin(chirp),
      value = (samples[index] - average) * window;
    real[index] = value * cosine;
    imaginary[index] = -value * sine;
    kernelReal[index] = cosine;
    kernelImaginary[index] = sine;
    if (index) {
      kernelReal[size - index] = cosine;
      kernelImaginary[size - index] = sine;
    }
  }
  radix2(real, imaginary);
  radix2(kernelReal, kernelImaginary);
  for (let index = 0; index < size; index++)
    [real[index], imaginary[index]] = [
      real[index] * kernelReal[index] -
        imaginary[index] * kernelImaginary[index],
      real[index] * kernelImaginary[index] +
        imaginary[index] * kernelReal[index],
    ];
  radix2(real, imaginary, true);
  const bins = Math.floor(count / 2) + 1,
    values = [];
  for (let index = 0; index < bins; index++)
    values.push(
      (Math.hypot(real[index], imaginary[index]) / windowSum) *
        (index === 0 || (count % 2 === 0 && index === count / 2) ? 1 : 2),
    );
  if (voltage) {
    for (let bin = 0; bin < values.length; bin++) {
      if (bin && !(count % 2 === 0 && bin === count / 2))
        values[bin] /= Math.sqrt(2);
      if (units === "dbv")
        values[bin] = 20 * Math.log10(Math.max(values[bin], 1e-12));
    }
  }
  return {
    kind: "fft",
    frequencies: values.map((_, index) => (index * sampleRate) / count),
    values,
    unit: voltage ? (units === "dbv" ? "dBV" : "V RMS") : "ADC codes peak",
    window: windowName,
    bin_hz: sampleRate / count,
  };
}
export function validateProcessing(key, value) {
  const choices = {
    mode: ["sample", "average", "peak"],
    math: ["off", "add", "subtract", "multiply", "divide", "fft", "xy"],
    style: ["lines", "dots"],
    fft_window: [
      "hann",
      "hamming",
      "blackman",
      "rectangular",
      "kaiser",
      "bartlett",
    ],
    fft_units: ["dbv", "vrms"],
  };
  const limits = {
    averages: [2, 256],
    math_source: [0, 1],
    math_reversed: [0, 1],
    persistence: [0, 64],
    intensity: [10, 100],
  };
  if (
    choices[key]?.includes(value) ||
    (limits[key] &&
      Number.isInteger(value) &&
      value >= limits[key][0] &&
      value <= limits[key][1])
  )
    return value;
  throw Error("Invalid waveform processing setting");
}
export class BrowserProcessor {
  constructor() {
    this.config = { ...PROCESSING_DEFAULTS };
    this.generation = 0;
    this.reset();
  }
  reset() {
    this.history = [];
    this.signature = null;
  }
  configure(key, value) {
    this.config[key] = validateProcessing(key, value);
    this.generation++;
    this.reset();
  }
  process(channels, sampleRate, metadata, settings = null) {
    const partial = metadata.valid_count < channels[0].length;
    if (partial) {
      this.reset();
      const start = metadata.valid_from,
        count = metadata.valid_count;
      const measurements = channels.map((channel) =>
        count >= 2
          ? measure(channel.slice(start, start + count), sampleRate)
          : {},
      );
      if (metadata.acquire_mode === 1) this.extremaOnly(measurements);
      return {
        measurements,
        processing_count: 0,
        processing_generation: this.generation,
        measurement_note: `Rolling preview: ${count} fresh samples; uncollected history is blank.`,
      };
    }
    const signature = JSON.stringify([
      channels[0].length,
      sampleRate,
      ...[
        "ch1_range",
        "ch2_range",
        "ch1_coupling",
        "ch2_coupling",
        "offsets_packed",
        "acquire_mode",
        "device_averages",
        "bandwidth_bits",
        "trigger_family",
        "horizontal_ns",
        "roll",
      ].map((key) => metadata[key]),
    ]);
    if (signature !== this.signature) {
      this.reset();
      this.signature = signature;
    }
    const mode = metadata.roll ? "sample" : this.config.mode;
    let processed = channels,
      envelope = null;
    if (mode !== "sample") {
      this.history.push(channels);
      if (this.history.length > this.config.averages) this.history.shift();
      if (mode === "average")
        processed = channels.map((channel, channelIndex) =>
          channel.map(
            (_, index) =>
              this.history.reduce(
                (sum, frame) => sum + frame[channelIndex][index],
                0,
              ) / this.history.length,
          ),
        );
      else
        envelope = {
          low: channels.map((channel, channelIndex) =>
            channel.map((_, index) =>
              Math.min(
                ...this.history.map((frame) => frame[channelIndex][index]),
              ),
            ),
          ),
          high: channels.map((channel, channelIndex) =>
            channel.map((_, index) =>
              Math.max(
                ...this.history.map((frame) => frame[channelIndex][index]),
              ),
            ),
          ),
        };
    }
    const result = {
      measurements: processed.map((channel) => measure(channel, sampleRate)),
      processing_count: mode === "sample" ? 1 : this.history.length,
      processing_generation: this.generation,
    };
    if (metadata.acquire_mode === 1) {
      this.extremaOnly(result.measurements);
      result.measurement_note =
        "Hardware peak detect: extrema only; timing and RMS unavailable.";
      return result;
    }
    result.channel_timing = channelTiming(
      processed,
      sampleRate,
      result.measurements,
    );
    if (mode === "average") result.display_channels = processed;
    if (envelope) result.envelope = envelope;
    const mathChannels = settings
      ? processed.map((channel, index) =>
          mathVolts(channel, settings, metadata, index),
        )
      : processed;
    const [left, right] = mathChannels,
      operation = this.config.math;
    if (["add", "subtract", "multiply", "divide"].includes(operation))
      result.math = {
        kind: operation,
        values: left.map((value, index) =>
          operation === "add"
            ? value + right[index]
            : operation === "subtract"
              ? (value - right[index]) * (this.config.math_reversed ? -1 : 1)
              : operation === "multiply"
                ? value * right[index]
                : Math.abs(right[index]) > 1e-12
                  ? value / right[index]
                  : null,
        ),
        unit:
          operation === "multiply"
            ? settings
              ? "V²"
              : "code²"
            : operation === "divide"
              ? "ratio"
              : settings
                ? "V"
                : "ADC codes",
      };
    else if (operation === "xy")
      result.math = {
        kind: "xy",
        x: left,
        values: right,
        unit: settings ? "V" : "ADC codes",
      };
    else if (operation === "fft")
      result.math = spectrum(
        mathChannels[this.config.math_source],
        sampleRate,
        this.config.fft_window,
        !!settings,
        this.config.fft_units,
      );
    return result;
  }
  extremaOnly(measurements) {
    for (const reading of measurements)
      for (const key in reading)
        if (!["min", "max", "pp", "clipped", "sample_count"].includes(key))
          reading[key] = null;
  }
}
