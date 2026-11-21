import { validateLcdAction, lcdCommand, lcdSettings } from "./lcd-controls.js";
import {
  RATES,
  SCALES_MV,
  fields,
  signed32,
  delay,
  decodeFrame,
  crc32,
  calibrationIdentity,
} from "./webusb.js";
import { measure } from "./browser-analysis.js";

const integer = (value, minimum, maximum) =>
  Number.isInteger(value) && value >= minimum && value <= maximum;
const choices = (value, allowed) => allowed.includes(value);
export function validateAction(action) {
  if (!action || typeof action !== "object")
    throw Error("Expected a control action");
  const { op, key, value, channel, index } = action;
  if (op?.startsWith("lcd_")) return validateLcdAction(action);
  if (
    [
      "run",
      "stop",
      "autoset",
      "defaults",
      "fit",
      "device_save",
      "device_load",
    ].includes(op)
  )
    return action;
  if (
    op === "calibration_baseline" &&
    choices(value, ["STOCK", "REFERENCE", "ZERO"])
  )
    return action;
  if (["rate", "timebase"].includes(op) && integer(index, 1, 31)) return action;
  if (
    op === "view" &&
    integer(action.points, 10, 2000) &&
    integer(action.start, 0, 2000 - action.points)
  )
    return action;
  if (
    op === "horizontal" &&
    (action.stock === true || integer(value, -1e9, 1e9))
  )
    return action;
  if (op === "roll" && choices(value, ["LIVE", "TRIGGERED"])) return action;
  if (
    op === "video" &&
    integer(action.standard, 0, 2) &&
    integer(action.sync, 0, 4) &&
    integer(action.count, 1, 625)
  )
    return action;
  if (
    op === "trigger_limits" &&
    integer(action.lower_uv, -1e9, 1e9) &&
    integer(action.upper_uv, action.lower_uv + 1, 1e9)
  )
    return action;
  if (
    op === "acquire" &&
    ((key === "mode" && choices(value, ["SAMPLE", "PEAK", "AVERAGE"])) ||
      (key === "averages" && choices(value, [4, 16, 64, 128])))
  )
    return action;
  if (integer(channel, 1, 2)) {
    if (op === "scale" && integer(index, 0, 13)) return action;
    if (op === "position" && integer(value, -4000, 4000)) return action;
    if (op === "offset" && integer(value, 0, 65535)) return action;
    if (op === "probe" && choices(value, [1, 10, 100, 1000])) return action;
    if (op === "coupling" && choices(value, ["DC", "AC"])) return action;
    if (
      ["display", "inverse", "bandwidth"].includes(op) &&
      choices(value, ["ON", "OFF"])
    )
      return action;
    if (op === "calibration" && integer(action.range, 0, 13)) {
      validateCalibration(action.cal);
      return action;
    }
  }
  if (op === "trigger") {
    if (["force", "single"].includes(key)) return action;
    const options = {
      enabled: ["ON", "OFF"],
      source: ["CH1", "CH2"],
      slope: ["RISE", "FALL"],
      sweep: ["AUTO", "NORMAL", "SINGLE"],
      coupling: ["DC", "AC"],
      mode: ["EDGE", "VIDEO", "PULSE"],
      family: ["NORMAL", "ALTERNATE"],
    };
    const bounds = {
      level_uv: [-1e9, 1e9],
      code: [-127, 126],
      holdoff_ns: [100, 1e9],
      condition: [0, 5],
      width_ns: [100, 1e9],
      count: [1, 65535],
      video_count: [0, 65535],
      video_sync: [0, 4],
      video_standard: [0, 2],
    };
    if (
      options[key]?.includes(value) ||
      (bounds[key] && integer(value, ...bounds[key]))
    )
      return action;
  }
  throw Error(`Invalid or unsupported control: ${op}`);
}

export function validateCalibration(calibration) {
  const bounds = {
    zero: [-128 * 65536, 127 * 65536],
    gain: [1, 1024000000],
    dac: [0, 65535],
    slope: [-65536, 65536],
    valid: [0, 2],
  };
  for (const [key, limits] of Object.entries(bounds))
    if (!integer(calibration?.[key], ...limits))
      throw Error(`Invalid calibration ${key}`);
  if ("adc_scale" in calibration || "adc_trim" in calibration)
    for (const key of ["adc_scale", "adc_trim"])
      if (!integer(calibration[key], 0, 65535))
        throw Error(`Invalid calibration ${key}`);
}

export class ScopeClient {
  constructor(connection) {
    this.connection = connection;
    this.calibrationCache = new Map();
  }
  request(command) {
    return this.connection.request(command);
  }
  async status(command) {
    return fields(await this.request(command));
  }
  async waitFor(read, ready, description, timeout = 15000) {
    const deadline = performance.now() + timeout;
    while (true) {
      const value = await read();
      if (ready(value)) return value;
      if (performance.now() > deadline) throw Error(`${description} timed out`);
      await delay(25);
    }
  }
  async waitAnalog() {
    await this.waitFor(
      () => this.status("ANALOG STATUS"),
      (status) => {
        if (status.state === 3) throw Error("Analog frontend setup failed");
        return status.state !== 1;
      },
      "Analog setup",
    );
  }
  async stop() {
    await this.request("LIVE OFF");
    await this.waitFor(
      () => this.status("CAPTURE STATUS"),
      (status) => ![1, 2, 3].includes(status.state),
      "Stopping acquisition",
      4000,
    );
  }
  async calibration(reference, cacheKey) {
    const key = `${reference}:${cacheKey}`;
    if (this.calibrationCache.has(key)) return this.calibrationCache.get(key);
    const table = [];
    for (const channel of [1, 2]) {
      const entries = [];
      for (let range = 0; range < 14; range++) {
        const calibration = await this.status(
          `CH${channel} CAL ${reference ? "REFERENCE" : "GET"} ${range}`,
        );
        calibration.zero = signed32(calibration.zero);
        calibration.slope = signed32(calibration.slope);
        entries.push(calibration);
      }
      table.push(entries);
    }
    if (this.calibrationCache.size > 8) this.calibrationCache.clear();
    this.calibrationCache.set(key, table);
    return table;
  }
  async settingsChanged(previous) {
    return (
      previous.ui_revision == null ||
      (await this.request("UI REVISION")) !== previous.ui_revision
    );
  }
  async settings() {
    let uiRevision = null;
    try {
      uiRevision = await this.request("UI REVISION");
    } catch (error) {
      if (!error.message.startsWith("ERR ")) throw error;
    }

    const capabilities = await this.status("CAPABILITIES");
    const captureConfig = await this.status("CAPTURE CONFIG");
    const channels = [];
    for (const channel of [1, 2]) {
      const data = {
        ...(await this.status(`CH${channel} STATUS`)),
        ...(await this.status(`CH${channel} VIEW`)),
      };
      data.position_mdiv = signed32(data.position_mdiv);
      data.bandwidth = (await this.status(`CH${channel} BANDWIDTH`)).enabled;
      channels.push(data);
    }
    const trigger = {
      ...(await this.status("TRIGGER STATUS")),
      ...(await this.status("TRIGGER DETAIL")),
      ...(await this.status("TRIGGER ADVANCED")),
      ...(await this.status("TRIGGER LIMITS")),
      ...(await this.status("TRIGGER FAMILY")),
      advanced_supported: true,
    };
    trigger.pulse_status = await this.status("TRIGGER PULSE STATUS");
    const triggerBanks = {};
    for (const bank of ["NORMAL", "CH1", "CH2"]) {
      triggerBanks[bank] = {};
      for (const part of ["EDGE", "TIMING", "MODE", "LIMITS"])
        Object.assign(
          triggerBanks[bank],
          await this.status(`TRIGGER BANK ${bank} ${part}`),
        );
    }
    const persistence = await this.status("SETTINGS STATUS");
    const baseline = (await this.status("VOLTAGE BASELINE")).mode;
    const boot = await this.status("BOOT STATUS");
    const referenceKey = JSON.stringify([
      persistence.sequence,
      persistence.state,
      boot.stage,
    ]);
    const cacheKey = JSON.stringify([
      persistence.sequence,
      persistence.state,
      boot.stage,
      baseline,
      channels.map((channel) => channel.position_mdiv),
    ]);
    const live = await this.status("LIVE STATUS");
    return {
      ui_revision: uiRevision,
      lcd: await lcdSettings(this),
      capabilities,
      channels,
      trigger,
      trigger_banks: triggerBanks,
      persistence,
      running: !!live.enabled,
      sequence: live.sequence,
      epoch: live.epoch,
      busy: !!live.busy,
      rate_index: captureConfig.rate_index,
      nominal_hz:
        captureConfig.nominal_hz / (captureConfig.rate_denominator || 1),
      capture: await this.status("CAPTURE STATUS"),
      display: await this.status("DISPLAY STATUS"),
      boot,
      view: await this.status("VIEW STATUS"),
      horizontal: await this.status("HORIZONTAL STATUS"),
      roll: await this.status("ROLL STATUS"),
      factory: await this.status("FACTORY STATUS"),
      device_acquisition: await this.status("ACQUIRE STATUS"),
      usb_speed: await this.request("USB SPEED"),
      calibration_model: (await this.status("VOLTAGE MODEL")).version,
      calibration_baseline: baseline,
      calibration: await this.calibration(false, cacheKey),
      reference_calibration: await this.calibration(true, referenceKey),
    };
  }
  async frame() {
    return decodeFrame(await this.connection.binary("FRAME7"));
  }
  async apply(action) {
    validateAction(action);
    const { op, key, value, channel, index } = action;
    if (op.startsWith("lcd_")) return this.request(lcdCommand(action));
    if (op === "run") return this.request("LIVE RUN");
    if (op === "stop") return this.stop();
    if (op === "calibration_baseline" || op === "device_load") {
      if (op === "device_load") await this.stop();
      await this.request(
        op === "device_load" ? "SETTINGS LOAD" : `VOLTAGE BASELINE ${value}`,
      );
      await this.waitFor(
        () => this.status("SETTINGS STATUS"),
        (status) => {
          if (status.state === 3) throw Error("Settings restore failed");
          return status.state === 2;
        },
        "Settings restore",
      );
      this.calibrationCache.clear();
      return;
    }
    if (op === "device_save") {
      const running = !!(await this.status("LIVE STATUS")).enabled;
      if (running) await this.stop();
      try {
        await this.request(running ? "SETTINGS SAVE RUN" : "SETTINGS SAVE");
      } finally {
        if (running) await this.request("LIVE ON");
      }
      return;
    }
    if (op === "calibration") {
      const running = !!(await this.status("LIVE STATUS")).enabled;
      await this.stop();
      try {
        const calibration = action.cal;
        const paired = "adc_scale" in calibration;
        const args = [
          "zero",
          "gain",
          "dac",
          "slope",
          "valid",
          ...(paired ? ["adc_scale", "adc_trim"] : []),
        ].map((key) => calibration[key]);
        await this.request(
          `CH${channel} CAL ${paired ? "SET2" : "SET"} ${action.range} ${args.join(" ")}`,
        );
        await this.waitAnalog();
        this.calibrationCache.clear();
      } finally {
        if (running) await this.request("LIVE ON");
      }
      return;
    }
    if (op === "timebase") {
      const running = !!(await this.status("LIVE STATUS")).enabled;
      if (running) await this.stop();
      try {
        await this.apply({ op: "rate", index });
        await this.request("VIEW WINDOW 0 750");
      } finally {
        if (running) await this.request("LIVE ON");
      }
      return;
    }
    if (op === "rate") {
      await this.request(`CAPTURE RATE ${index}`);
      return this.waitFor(
        () => this.status("CAPTURE CONFIG"),
        (status) => status.rate_index === index,
        "Timebase update",
        4000,
      );
    }
    if (op === "acquire")
      return this.request(
        `ACQUIRE ${key === "mode" ? "MODE" : "AVERAGES"} ${value}`,
      );
    if (op === "trigger_limits")
      return this.request(
        `TRIGGER LIMITS ${action.lower_uv} ${action.upper_uv}`,
      );
    if (op === "horizontal")
      return this.request(
        action.stock ? "HORIZONTAL STOCK" : `HORIZONTAL OFFSET ${value}`,
      );
    if (op === "roll") return this.request(`ROLL MODE ${value}`);
    if (op === "view")
      return this.request(`VIEW WINDOW ${action.start} ${action.points}`);
    if (op === "video")
      return this.request(
        `TRIGGER VIDEO SET ${action.standard} ${action.sync} ${action.sync === 4 ? Math.min(action.count, action.standard === 0 ? 525 : 625) : action.count}`,
      );
    if (op === "trigger") {
      if (["force", "single"].includes(key))
        return this.request(`TRIGGER ${key.toUpperCase()}`);
      if (
        (key === "family" && value === "ALTERNATE") ||
        (key === "mode" && value === "VIDEO")
      )
        await this.request("TRIGGER SWEEP AUTO");
      const argument = {
        enabled: "ENABLE",
        source: "SOURCE",
        slope: "SLOPE",
        sweep: "SWEEP",
        level_uv: "LEVEL",
        code: "CODE",
        coupling: "COUPLING",
        holdoff_ns: "HOLDOFF",
        mode: "MODE",
        family: "FAMILY",
        condition: "CONDITION",
        width_ns: "WIDTH",
        count: "COUNT",
        video_count: "VIDEO COUNT",
        video_sync: "VIDEO SYNC",
        video_standard: "VIDEO STANDARD",
      }[key];
      return this.request(`TRIGGER ${argument} ${value}`);
    }
    if (op === "defaults") return this.defaults();
    if (op === "fit") return this.fit();
    if (op === "autoset") return this.autoset();
    let positionAfter = null;
    if (["scale", "probe"].includes(op)) {
      const previous = (await this.settings()).channels[channel - 1];
      const newRange = op === "scale" ? index : previous.range;
      const newProbe = op === "probe" ? value : previous.probe;
      positionAfter =
        newRange >= 2 && newRange <= 11
          ? Math.max(
              -4000,
              Math.min(
                4000,
                Math.round(
                  (previous.position_mdiv *
                    SCALES_MV[previous.range] *
                    previous.probe) /
                    (SCALES_MV[newRange] * newProbe),
                ),
              ),
            )
          : 0;
      if (op === "scale")
        await this.apply({ op: "position", channel, value: 0 });
    }
    const argument =
      op === "scale" ? `RANGE ${index}` : `${op.toUpperCase()} ${value}`;
    const deadline = performance.now() + 4000;
    while (true) {
      try {
        await this.request(`CH${channel} ${argument}`);
        break;
      } catch (error) {
        if (!error.message.includes("busy") || performance.now() > deadline)
          throw error;
        await delay(25);
      }
    }
    if (["scale", "coupling", "position", "offset", "bandwidth"].includes(op))
      await this.waitAnalog();
    if (op === "position") this.calibrationCache.clear();
    if (positionAfter !== null)
      await this.apply({ op: "position", channel, value: positionAfter });
  }
  async defaults() {
    await this.stop();
    for (const channel of [1, 2]) {
      for (const argument of [
        "POSITION 0",
        "RANGE 9",
        "COUPLING DC",
        "BANDWIDTH OFF",
      ]) {
        await this.request(`CH${channel} ${argument}`);
        await this.waitAnalog();
      }
      for (const argument of ["PROBE 1", "DISPLAY ON", "INVERSE OFF"])
        await this.request(`CH${channel} ${argument}`);
    }
    for (const command of [
      "TRIGGER FAMILY NORMAL",
      "TRIGGER MODE EDGE",
      "HORIZONTAL STOCK",
      "ACQUIRE MODE SAMPLE",
    ])
      await this.request(command);
    await this.apply({ op: "calibration_baseline", value: "STOCK" });
    for (const command of [
      "CAPTURE MODE NORMAL",
      "CAPTURE DECIMATION 1",
      "CAPTURE RATE 10",
      "VIEW WINDOW 0 750",
      "TRIGGER ENABLE ON",
      "TRIGGER SOURCE CH1",
      "TRIGGER SLOPE RISE",
      "TRIGGER SWEEP AUTO",
      "TRIGGER COUPLING DC",
      "TRIGGER HOLDOFF 100",
      "TRIGGER CODE 0",
      "LIVE ON",
    ])
      await this.request(command);
  }
  async fit() {
    const settings = await this.settings();
    const { metadata, channels } = await this.frame();
    for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
      const channel = settings.channels[channelIndex];
      if (!channel.visible) continue;
      const calibration =
        settings.calibration[channelIndex][
          metadata[`ch${channelIndex + 1}_range`]
        ];
      const dac = (metadata.offsets_packed >>> (channelIndex * 16)) & 65535;
      const gain = (calibration.gain / 256000000) * channel.probe;
      const offset =
        (-(calibration.zero + (dac - calibration.dac) * calibration.slope) /
          65536) *
        gain;
      const values = channels[channelIndex].map(
        (code) => (code * gain + offset) * (channel.inverse ? -1 : 1),
      );
      const low = Math.min(...values),
        high = Math.max(...values),
        center = (low + high) / 2;
      const desired = Math.max((high - low) / 6, Math.abs(center) / 3.5, 0.001);
      const range =
        Array.from({ length: 12 }, (_, index) => index).find(
          (index) =>
            index >= (settings.calibration_baseline === 1 ? 2 : 3) &&
            (SCALES_MV[index] * channel.probe) / 1000 >= desired,
        ) ?? 11;
      const position = Math.max(
        -4000,
        Math.min(
          4000,
          Math.round(-center / ((SCALES_MV[range] * channel.probe) / 1000)) *
            1000,
        ),
      );
      await this.apply({ op: "position", channel: channelIndex + 1, value: 0 });
      if (range !== channel.range)
        await this.apply({
          op: "scale",
          channel: channelIndex + 1,
          index: range,
        });
      await this.apply({
        op: "position",
        channel: channelIndex + 1,
        value: position,
      });
    }
  }
  async autoset() {
    const { metadata, channels } = await this.frame();
    const stats = channels.map((channel) =>
      measure(channel, metadata.nominal_hz),
    );
    const source = stats[0].amplitude >= stats[1].amplitude ? 0 : 1,
      signal = stats[source];
    if (signal.amplitude < 12)
      throw Error(
        "No clear signal for Autoset; connect an input and choose a suitable range",
      );
    await this.stop();
    const channel = source + 1;
    await this.apply({ op: "position", channel, value: 0 });
    const current = metadata[`ch${channel}_range`],
      desired = (SCALES_MV[current] * signal.amplitude) / 100;
    const lowest = (await this.status("VOLTAGE BASELINE")).mode === 1 ? 2 : 3;
    let range = lowest;
    for (let index = lowest; index < 12; index++)
      if (
        Math.abs(Math.log(SCALES_MV[index] / desired)) <
        Math.abs(Math.log(SCALES_MV[range] / desired))
      )
        range = index;
    if (signal.clipped) range = Math.min(11, Math.max(range, current + 1));
    await this.apply({ op: "scale", channel, index: range });
    let rate = metadata.rate_index;
    if (signal.frequency_hz) {
      let distance = Infinity;
      for (let index = 1; index < 16; index++) {
        const next = Math.abs(
          Math.log(RATES[index] / ((750 * signal.frequency_hz) / 4)),
        );
        if (next < distance) {
          distance = next;
          rate = index;
        }
      }
    }
    for (const command of [
      `CAPTURE RATE ${rate}`,
      "VIEW WINDOW 0 750",
      "TRIGGER ENABLE ON",
      `TRIGGER SOURCE CH${channel}`,
      "TRIGGER SLOPE RISE",
      "TRIGGER SWEEP NORMAL",
    ])
      await this.request(command);
    const candidates = [
      0,
      ...Array.from({ length: 7 }, (_, index) => [
        -16 * (index + 1),
        16 * (index + 1),
      ]).flat(),
    ];
    let chosen = null;
    for (const candidate of candidates) {
      await this.request(`TRIGGER CODE ${candidate}`);
      const baseline = (await this.status("LIVE STATUS")).sequence;
      await this.request("LIVE ON");
      const deadline =
        performance.now() +
        Math.max(100, Math.min(500, 3000 / (signal.frequency_hz || 30)));
      while (performance.now() < deadline) {
        if ((await this.status("LIVE STATUS")).sequence !== baseline) {
          chosen = candidate;
          break;
        }
        await delay(10);
      }
      await this.stop();
      if (chosen !== null) break;
    }
    await this.request("TRIGGER SWEEP AUTO");
    await this.request("LIVE ON");
    if (chosen === null)
      throw Error(
        "Autoset chose range/timebase but found no stable edge; Auto acquisition restored",
      );
    await this.request(`TRIGGER CODE ${chosen}`);
  }
  async readRecord(channel, settings) {
    const bytes = await this.connection.binary(`RECORD FRAME CH${channel}`),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const words = Array.from({ length: 27 }, (_, index) =>
      view.getUint32(index * 4, true),
    );
    if (
      words[0] !== 0x31525348 ||
      words[1] !== 4 ||
      words[2] !== 108 ||
      ![1000, 10000].includes(words[3]) ||
      words[8] !== channel - 1 ||
      words[9] >= 14 ||
      !words[16] ||
      !words[17]
    )
      throw Error("Invalid deep record");
    const payload = bytes.slice(108);
    if (crc32(payload) !== words[15]) throw Error("Deep record CRC mismatch");
    const keys = [
      "magic",
      "version",
      "header_bytes",
      "payload_bytes",
      "sequence",
      "nominal_hz",
      "ticks_24mhz",
      "csi_flags",
      "channel",
      "range",
      "coupling",
      "offset_dac",
      "record_depth",
      "trigger_mode",
      "horizontal_ns",
      "crc32",
      "rate_numerator",
      "rate_denominator",
      "forced",
      "capture_epoch",
      "programmed_pretrigger",
      "programmed_posttrigger",
      "armed_ticks",
      "completed_ticks",
    ];
    const metadata = Object.fromEntries(
      keys.map((key, index) => [key, words[index]]),
    );
    const calibration = settings.calibration[channel - 1][metadata.range];
    Object.assign(metadata, {
      nominal_hz: words[16] / words[17],
      horizontal_ns: signed32(words[14]),
      pulse_sampled: !!words[24],
      alignment_drop_leading_samples: words[25],
      calibration_id: words[26],
      probe: settings.channels[channel - 1].probe,
    });
    metadata.calibration_matches =
      calibrationIdentity(calibration) === words[26];
    metadata.calibration = metadata.calibration_matches ? calibration : null;
    metadata.trigger_qualified =
      !metadata.forced &&
      (metadata.trigger_mode === 0 || metadata.pulse_sampled);
    return {
      format: "slopscope-record",
      version: 1,
      encoding: "signed-int8/base64",
      metadata,
      data: btoa(String.fromCharCode(...payload)),
    };
  }
}
