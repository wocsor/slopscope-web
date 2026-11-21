import { mirroredMathAction, mathProcessingFromLcd } from "./math-mirror.js";
import { lcdCopy, lcdProfileActions } from "./lcd-controls.js";
import {
  USBConnection,
  RATES,
  SCALES_MV,
  fields,
  signed32,
  delay,
  calibrationIdentity,
} from "./webusb.js";
import {
  ScopeClient,
  validateAction,
  validateCalibration,
} from "./browser-controls.js";
import { BrowserProcessor, validateProcessing } from "./browser-analysis.js";
export const OPTIONS = { rates: RATES, scales_mv: SCALES_MV };

export function profileActions(profile) {
  if (
    !["slopscope-setup", "hscope-ram-setup"].includes(profile?.format) ||
    profile.version !== 1
  )
    throw Error("Unsupported setup file");
  const settings = profile.settings,
    actions = [{ op: "stop" }];
  if (
    !settings ||
    settings.channels?.length !== 2 ||
    typeof settings.running !== "boolean" ||
    !settings.trigger ||
    !settings.view
  )
    throw Error("Incomplete setup");
  if (![0, 1, 2].includes(settings.calibration_baseline))
    throw Error("Invalid calibration baseline");
  actions.push(
    { op: "calibration_baseline", value: "REFERENCE" },
    { op: "trigger", key: "family", value: "NORMAL" },
  );
  const table = settings.reference_calibration || settings.calibration;
  if (table) {
    if (table.length !== 2 || table.some((channel) => channel.length !== 14))
      throw Error("Invalid calibration table");
    table.forEach((channel, channelIndex) =>
      channel.forEach((calibration, range) => {
        validateCalibration(calibration);
        actions.push({
          op: "calibration",
          channel: channelIndex + 1,
          range,
          cal: calibration,
        });
      }),
    );
  }
  settings.channels.forEach((channel, index) => {
    if (
      ![0, 1].includes(channel.coupling) ||
      ![0, 1].includes(channel.visible) ||
      ![0, 1].includes(channel.inverse)
    )
      throw Error("Invalid channel setup");
    actions.push(
      { op: "position", channel: index + 1, value: 0 },
      { op: "scale", channel: index + 1, index: channel.range },
      {
        op: "coupling",
        channel: index + 1,
        value: ["DC", "AC"][channel.coupling],
      },
      { op: "probe", channel: index + 1, value: channel.probe },
      { op: "position", channel: index + 1, value: channel.position_mdiv },
      {
        op: "display",
        channel: index + 1,
        value: channel.visible ? "ON" : "OFF",
      },
      {
        op: "inverse",
        channel: index + 1,
        value: channel.inverse ? "ON" : "OFF",
      },
    );
    if (channel.bandwidth !== undefined) {
      if (![0, 1].includes(channel.bandwidth)) throw Error("Invalid bandwidth");
      actions.push({
        op: "bandwidth",
        channel: index + 1,
        value: channel.bandwidth ? "ON" : "OFF",
      });
    }
    if (!channel.position_mdiv && channel.offset_dac !== undefined)
      actions.push({
        op: "offset",
        channel: index + 1,
        value: channel.offset_dac,
      });
  });
  actions.push(
    { op: "rate", index: settings.rate_index },
    { op: "view", ...settings.view },
  );
  const triggerActions = (trigger) => {
    const values = [
      ["enabled", "en", ["OFF", "ON"]],
      ["source", "src", ["CH1", "CH2"]],
      ["slope", "slope", ["RISE", "FALL"]],
      ["sweep", "sweep", ["AUTO", "NORMAL", "SINGLE"]],
      ["coupling", "coupling", ["DC", "AC"]],
    ];
    for (const [key, field, choices] of values)
      actions.push({ op: "trigger", key, value: choices[trigger[field]] });
    actions.push(
      { op: "trigger", key: "holdoff_ns", value: trigger.holdoff_ns },
      {
        op: "trigger",
        key: trigger.raw ? "code" : "level_uv",
        value: signed32(trigger.raw ? trigger.code : trigger.uv),
      },
    );
    if (trigger.mode !== undefined) {
      actions.push({
        op: "trigger",
        key: "mode",
        value: ["EDGE", "VIDEO", "PULSE"][trigger.mode],
      });
      for (const [key, field] of [
        ["condition", "condition"],
        ["width_ns", "width_ns"],
        ["count", "count"],
        ["video_count", "video_count"],
        ["video_sync", "sync"],
        ["video_standard", "standard"],
      ])
        actions.push({ op: "trigger", key, value: trigger[field] });
      actions.push({
        op: "trigger_limits",
        lower_uv: signed32(trigger.lower_uv),
        upper_uv: signed32(trigger.upper_uv),
      });
    }
  };
  const banks = settings.trigger_banks;
  triggerActions(
    banks?.NORMAL
      ? { ...banks.NORMAL, en: settings.trigger.en }
      : settings.trigger,
  );
  if (banks) {
    if (!banks.CH1 || !banks.CH2) throw Error("Incomplete trigger banks");
    actions.push({ op: "trigger", key: "family", value: "ALTERNATE" });
    for (const name of ["CH1", "CH2"]) {
      actions.push({ op: "trigger", key: "source", value: name });
      triggerActions({ ...banks[name], en: settings.trigger.en });
    }
    actions.push(
      {
        op: "trigger",
        key: "family",
        value: settings.trigger.alternate ? "ALTERNATE" : "NORMAL",
      },
      {
        op: "trigger",
        key: "source",
        value: settings.trigger.src ? "CH2" : "CH1",
      },
    );
  }
  if (settings.horizontal)
    actions.push(
      settings.horizontal.enabled
        ? { op: "horizontal", value: signed32(settings.horizontal.offset_ns) }
        : { op: "horizontal", stock: true },
    );
  if (settings.roll)
    actions.push({
      op: "roll",
      value: settings.roll.mode ? "LIVE" : "TRIGGERED",
    });
  if (settings.device_acquisition) {
    actions.push(
      {
        op: "acquire",
        key: "mode",
        value: ["SAMPLE", "PEAK", "AVERAGE"][settings.device_acquisition.mode],
      },
      {
        op: "acquire",
        key: "averages",
        value: settings.device_acquisition.averages,
      },
    );
  }
  actions.push(...lcdProfileActions(settings.lcd));
  actions.push(
    {
      op: "calibration_baseline",
      value: ["STOCK", "REFERENCE", "ZERO"][settings.calibration_baseline],
    },
    { op: settings.running ? "run" : "stop" },
  );
  actions.forEach(validateAction);
  for (const [key, value] of Object.entries(profile.processing || {}))
    validateProcessing(key, value);
  return actions;
}

export class BrowserController {
  constructor(onState) {
    this.onState = onState;
    this.queue = Promise.resolve();
    this.connection = new USBConnection();
    this.client = new ScopeClient(this.connection);
    this.processor = new BrowserProcessor();
    try {
      const config = JSON.parse(
        localStorage.getItem("slopscope-processing") || "{}",
      );
      for (const [key, value] of Object.entries(config))
        this.processor.configure(key, value);
    } catch (_) {
      /* Invalid saved display preferences use defaults. */
    }
    this.state = {
      connected: false,
      status: "Choose Connect USB",
      settings: null,
      frame: null,
      transport_kind: "webusb",
      processing: { ...this.processor.config },
      session: crypto.randomUUID(),
      revision: 0,
    };
    this.sessionGeneration = 0;
    this.recordToken = null;
    this.lastSettings = 0;
    this.arrivals = [];
    navigator.usb?.addEventListener("disconnect", (event) => {
      if (event.device === this.connection.device)
        this.disconnect("Scope unplugged");
    });
    this.publish();
  }
  publish(update = {}) {
    if (update.settings) {
      for (const [key, value] of Object.entries(
        mathProcessingFromLcd(update.settings),
      ))
        if (this.processor.config[key] !== value)
          this.processor.configure(key, value);
      update.processing = { ...this.processor.config };
    }
    Object.assign(this.state, update);
    this.state.revision++;
    this.onState({ ...this.state });
  }
  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async connect(serialNumber = null) {
    if (this.state.connected) return;
    this.publish({ status: "Choose your SlopScope USB device" });
    try {
      await this.connection.connect(serialNumber);
      const generation = ++this.sessionGeneration;
      this.client.calibrationCache.clear();
      this.processor.reset();
      this.arrivals = [];
      this.publish({
        connected: true,
        serial_number: this.connection.device.serialNumber,
        status: "Reading scope settings",
        frame: null,
        session: crypto.randomUUID(),
      });
      await this.enqueue(async () => {
        const record = await this.client.status("RECORD STATUS");
        if (record.busy) await this.client.request("RECORD CANCEL");
        await this.client.waitFor(
          () => this.client.status("BOOT STATUS"),
          (status) => {
            if (status.error) throw Error("Scope boot failed");
            return status.stage === 7;
          },
          "Scope boot",
          30000,
        );
        this.publish({
          settings: await this.client.settings(),
          status: "Connected over WebUSB",
        });
      });
      this.lastSettings = performance.now();
      this.poll(generation);
    } catch (error) {
      this.sessionGeneration++;
      await this.connection.close();
      this.publish({ connected: false, status: error.message, frame: null });
      throw error;
    }
  }
  async disconnect(message = "USB disconnected") {
    this.sessionGeneration++;
    if (this.recordToken) this.recordToken.cancelled = true;
    await this.enqueue(async () => {
      if (this.recordToken && !this.connection.poisoned)
        await this.client.request("RECORD CANCEL").catch(() => {});
      this.recordToken = null;
      await this.connection.close();
    });
    this.publish({
      connected: false,
      status: message,
      settings: null,
      frame: null,
      record_acquisition: { running: false },
    });
  }
  async poll(generation) {
    while (generation === this.sessionGeneration && this.state.connected) {
      try {
        await this.enqueue(async () => {
          if (generation !== this.sessionGeneration) return;
          const activity = {
            ...(await this.client.status("ACQUISITION STATUS")),
            received_at: Date.now() / 1000,
          };
          if (this.recordToken) {
            this.publish({ activity });
            return;
          }
          if (performance.now() - this.lastSettings > 2000) {
            if (await this.client.settingsChanged(this.state.settings))
              this.publish({ settings: await this.client.settings() });
            this.lastSettings = performance.now();
          }
          const live = await this.client.status("LIVE STATUS");
          const settings = {
            ...this.state.settings,
            running: !!live.enabled,
            sequence: live.sequence,
            busy: !!live.busy,
            epoch: live.epoch,
          };
          this.publish({ settings, activity });
          if (
            !settings.running &&
            this.state.frame &&
            this.state.frame.metadata.sequence === live.sequence &&
            this.state.frame.processing_generation === this.processor.generation
          )
            return;
          let frame;
          try {
            frame = await this.client.frame();
          } catch (error) {
            if (error.message === "ERR no frame") return;
            throw error;
          }
          const matches = () =>
            frame.metadata.calibration_ids.every(
              (identity, channel) =>
                calibrationIdentity(
                  this.state.settings.calibration[channel][
                    frame.metadata[`ch${channel + 1}_range`]
                  ],
                ) === identity,
            );
          if (!matches()) {
            this.client.calibrationCache.clear();
            this.publish({ settings: await this.client.settings() });
            if (!matches()) {
              this.publish({
                frame: null,
                status: "Calibration changed; Run for a fresh frame",
              });
              return;
            }
          }
          if (
            frame.metadata.sequence === this.state.frame?.metadata.sequence &&
            this.processor.generation ===
              this.state.frame?.processing_generation
          )
            return;
          const now = performance.now(),
            previous = this.state.frame;
          const freshFrame =
            frame.metadata.sequence !== previous?.metadata.sequence;
          if (freshFrame) this.arrivals.push(now);
          this.arrivals = this.arrivals.slice(-30);
          const elapsed = (now - this.arrivals[0]) / 1000,
            fps = !freshFrame
              ? previous.fps
              : elapsed
                ? (this.arrivals.length - 1) / elapsed
                : 0;
          const ticks = previous
              ? (frame.metadata.ticks_24mhz - previous.metadata.ticks_24mhz) >>>
                0
              : 0,
            delta = previous
              ? (frame.metadata.sequence - previous.metadata.sequence) >>> 0
              : 0;
          Object.assign(
            frame,
            this.processor.process(
              frame.channels,
              frame.metadata.nominal_hz,
              frame.metadata,
              this.state.settings,
            ),
            {
              fps,
              payload_bps: fps * frame.metadata.payload_bytes,
              capture_fps:
                ticks && delta < 10000 ? (delta * 24e6) / ticks : null,
            },
          );
          this.publish({
            frame,
            status: settings.running ? "Running" : "Stopped",
          });
        });
      } catch (error) {
        if (generation === this.sessionGeneration) {
          this.sessionGeneration++;
          await this.connection.close();
          this.publish({
            connected: false,
            status: error.message,
            frame: null,
          });
        }
        break;
      }
      await delay(30);
    }
  }
  async control(action) {
    if (!this.state.connected) throw Error("Connect USB first");
    if (action.op === "lcd_copy") {
      return this.enqueue(async () => ({
        screenshot: await lcdCopy(this.client, action),
      }));
    }
    if (action.op === "record") return this.record(action);
    if (action.op === "selfcal_start" || action.op === "selfcal_cancel")
      throw Error(
        "Grounded self-calibration uses the Python bridge. Device calibration and saved corrections work over WebUSB.",
      );
    const displayOnly = [
      "lcd_theme",
      "lcd_brightness",
      "lcd_cursors",
      "lcd_math",
      "lcd_fft",
    ].includes(action.op);
    const preserveRecord =
      (action.op === "trigger" && action.key === "force") || displayOnly;
    if (this.recordToken && !preserveRecord) this.recordToken.cancelled = true;
    return this.enqueue(async () => {
      if (this.recordToken && !preserveRecord) {
        await this.client.request("RECORD CANCEL");
        this.recordToken = null;
        this.publish({
          record_acquisition: {
            running: false,
            message: "Record cancelled by control change",
          },
        });
      }
      if (action.op === "processing") {
        const candidate = {
          ...this.processor.config,
          [action.key]: action.value,
        };
        const mirror = mirroredMathAction(
          candidate,
          this.state.settings,
          action.key,
        );
        if (mirror) await this.client.apply(mirror);
        this.processor.configure(action.key, action.value);
        localStorage.setItem(
          "slopscope-processing",
          JSON.stringify(this.processor.config),
        );
      } else if (action.op === "profile")
        await this.applyProfile(action.profile);
      else await this.client.apply(action);
      if (!displayOnly) this.processor.reset();
      if (!this.recordToken || displayOnly)
        this.publish({ settings: await this.client.settings() });
      this.publish({ processing: { ...this.processor.config } });
      return {
        settings: this.state.settings,
        session: this.state.session,
        revision: this.state.revision,
        processing: this.state.processing,
      };
    });
  }
  async applyProfile(profile) {
    const actions = profileActions(profile),
      original = {
        format: "slopscope-setup",
        version: 1,
        settings: await this.client.settings(),
        processing: { ...this.processor.config },
      };
    const rollback = profileActions(original);
    await this.client.request("CALIBRATION BEGIN");
    try {
      for (const action of actions) await this.client.apply(action);
      for (const [key, value] of Object.entries(profile.processing || {}))
        this.processor.configure(key, value);
      await this.client.request("CALIBRATION END");
    } catch (error) {
      try {
        for (const action of rollback) await this.client.apply(action);
        await this.client.request(
          original.settings.persistence.dirty
            ? "CALIBRATION END"
            : "CALIBRATION CANCEL",
        );
      } catch (restoreError) {
        throw Error(
          `${error.message}; setup rollback failed: ${restoreError.message}`,
        );
      }
      throw error;
    }
  }
  async record(action) {
    if (
      !["both", 1, 2].includes(action.channel) ||
      ![1000, 10000].includes(action.depth) ||
      typeof action.force !== "boolean"
    )
      throw Error("Invalid record request");
    if (this.recordToken) throw Error("A record is already acquiring");
    const token = { cancelled: false },
      started = performance.now();
    this.recordToken = token;
    try {
      await this.enqueue(async () => {
        if (token.cancelled) throw Error("Record cancelled");
        await this.client.stop();
        await this.client.request(`RECORD DEPTH ${action.depth}`);
        await this.client.request(
          action.channel === "both"
            ? "RECORD START BOTH"
            : `RECORD START CH${action.channel}`,
        );
        if (action.force) await this.client.request("TRIGGER FORCE");
      });
      const deadline =
        started +
        Math.max(
          10000,
          (2000 * action.depth) / this.state.settings.nominal_hz + 5000,
        );
      while (true) {
        const record = await this.enqueue(async () => {
          if (token.cancelled || this.recordToken !== token)
            throw Error("Record cancelled");
          const status = await this.client.status("RECORD STATUS");
          this.publish({
            record_acquisition: {
              running: !status.ready,
              elapsed_s: (performance.now() - started) / 1000,
              stage: status.filling
                ? "Filling sample history"
                : status.reading
                  ? "Reading acquired record"
                  : "Waiting for trigger / buffer",
            },
          });
          if (!status.ready) {
            if (!status.busy) throw Error("Record acquisition failed");
            return null;
          }
          const records = [];
          for (const channel of action.channel === "both"
            ? [1, 2]
            : [action.channel])
            records.push(
              await this.client.readRecord(channel, this.state.settings),
            );
          if (
            records.length === 2 &&
            ["sequence", "ticks_24mhz", "nominal_hz", "record_depth"].some(
              (key) => records[0].metadata[key] !== records[1].metadata[key],
            )
          )
            throw Error("Paired record mismatch");
          this.recordToken = null;
          this.publish({
            settings: await this.client.settings(),
            record_acquisition: { running: false, message: "Record complete" },
          });
          return records.length === 2
            ? { format: "slopscope-record-pair", version: 1, records }
            : records[0];
        });
        if (record)
          return {
            settings: this.state.settings,
            session: this.state.session,
            revision: this.state.revision,
            processing: this.state.processing,
            record,
          };
        if (performance.now() > deadline)
          throw Error("Record trigger timed out");
        await delay(25);
      }
    } catch (error) {
      await this.enqueue(async () => {
        if (this.recordToken === token) {
          if (!this.connection.poisoned)
            await this.client.request("RECORD CANCEL");
          this.recordToken = null;
          this.publish({
            record_acquisition: { running: false, message: error.message },
          });
        }
      });
      throw error;
    }
  }
}
