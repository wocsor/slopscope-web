const modes = {
  off: 0,
  add: 1,
  subtract: 2,
  fft: 3,
  multiply: 4,
  divide: 5,
  xy: 6,
};
const windows = {
  hamming: 0,
  rectangular: 1,
  blackman: 2,
  hann: 3,
  kaiser: 4,
  bartlett: 5,
};

export function mirroredMathAction(processing, settings, key) {
  if (
    ![
      "math",
      "math_source",
      "fft_window",
      "fft_units",
      "math_reversed",
    ].includes(key)
  )
    return null;
  const tools = settings?.lcd?.tools;
  if (tools?.math === undefined) return null;
  const operation = processing.math,
    mode = modes[operation];
  const supported =
    tools.math_modes ?? (tools.fft_window === undefined ? 7 : 15);
  if (!(supported & (1 << mode))) return null;
  if (
    key !== "math" &&
    operation !== "fft" &&
    !(key === "math_reversed" && operation === "subtract")
  )
    return null;
  const source =
    operation === "fft" ? processing.math_source : operation === "xy" ? 1 : 0;
  const channel = settings.channels[source];
  const changed = mode !== tools.math;
  const scalar = ["multiply", "divide"].includes(operation);
  const range = changed ? (scalar ? 9 : channel.range) : tools.math_range;
  if (operation === "fft")
    return {
      op: "lcd_fft",
      source: source + 1,
      window: windows[processing.fft_window],
      logarithmic: Number((processing.fft_units || "dbv") === "dbv"),
      range,
      db_div: tools.fft_db_div ?? 10,
      reference_dbv: tools.fft_reference_dbv ?? 20,
    };
  return {
    op: "lcd_math",
    mode,
    range,
    probe: scalar ? 1 : channel.probe || 1,
    position: changed ? 0 : tools.math_position,
    reversed: operation === "subtract" ? processing.math_reversed || 0 : 0,
  };
}

export function mathProcessingFromLcd(settings) {
  const tools = settings?.lcd?.tools;
  const operation = Object.entries(modes).find(
    ([, value]) => value === tools?.math,
  )?.[0];
  if (!operation) return {};
  const result = { math: operation };
  if (operation === "subtract") result.math_reversed = tools.math_reversed || 0;
  if (operation === "fft" && tools.fft_window !== undefined) {
    result.math_source = tools.fft_source;
    result.fft_window = Object.entries(windows).find(
      ([, value]) => value === tools.fft_window,
    )[0];
    result.fft_units = tools.fft_logarithmic ? "dbv" : "vrms";
  }
  return result;
}
