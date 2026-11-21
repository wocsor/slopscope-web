import { setupLcdControls } from "./lcd-ui.js";
import { setupCursorControls } from "./cursor-ui.js";
import { setupScopePicker } from "./scope-picker.js";
import { BrowserController, OPTIONS } from "./browser-transport.js";
import { FrequencyReadout } from "./measurement-display.js";
const frequencyReadout = new FrequencyReadout();
let directController = null,
  usingBridge = false,
  scopePicker = null;
("use strict");
const GRID_COLUMNS = 15,
  dirtyInputs = new Set(),
  pendingProcessing = new Map();
let processingEditActive = null,
  processingEditSession;
const $ = (id) => document.getElementById(id),
  canvas = $("plot"),
  ctx = canvas.getContext("2d");
let state = {},
  latest = null,
  options = null,
  busy = false,
  dirty = true,
  hover = null,
  lastSequence = null,
  lastArrival = 0,
  lastActivityArrival = null,
  lastActivityStamp = null,
  past = [],
  cursorNext = 0,
  markerDrag = null,
  markerPreview = null,
  suppressMarkerClick = false;
const format = (value, unit = "") => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const a = Number(Math.abs(value).toPrecision(4));
  let p = "",
    s = 1;
  if (a > 0 && a < 1e-6) {
    p = "n";
    s = 1e9;
  } else if (a > 0 && a < 1e-3) {
    p = "µ";
    s = 1e6;
  } else if (a > 0 && a < 1) {
    p = "m";
    s = 1e3;
  } else if (a >= 1e6) {
    p = "M";
    s = 1e-6;
  } else if (a >= 1e3) {
    p = "k";
    s = 1e-3;
  }
  return `${Number((value * s).toPrecision(4))} ${p}${unit}`.trim();
};
const lcdControls = setupLcdControls({
  getState: () => state,
  setValue,
  invoke,
  applyEdited: (...args) => applyEdited(...args),
  sendControl,
  download,
  onError: (error) => {
    $("error").textContent = error.message;
  },
  dirtyInputs,
});
const cursorControls = setupCursorControls({
  getState: () => state,
  getView: view,
  scaleVolts,
  setValue,
  control,
  isBusy: () => busy,
  onError: (error) => {
    $("error").textContent = error.message;
  },
  redraw: () => {
    dirty = true;
  },
});
function setupControlSections() {
  const sidebar = document.querySelector("aside");
  const cards = [...sidebar.children];
  const acquisition = cards.find(
    (card) => card.querySelector("h2")?.textContent === "Acquisition",
  );
  const acquisitionGroup = (ids) => {
    const group = document.createElement("div");
    for (const id of ids) {
      const element = $(id);
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) group.append(label);
      group.append(element);
    }
    return group;
  };
  const transport = acquisition.querySelector(".row");
  const timebase = acquisitionGroup(["rate", "ratehint"]);
  const slowMode = acquisitionGroup(["slowmode"]);
  acquisition.replaceChildren(transport, timebase, slowMode);
  acquisition.id = "acquisitionbar";
  acquisition.setAttribute("aria-label", "Acquisition controls");
  document.querySelector(".layout").before(acquisition);

  const sections = {
    channels: ["Channel 1", "Channel 2"],
    trigger: ["Trigger"],
    acquisition: [
      "Download acquired record",
      "Hardware horizontal position",
      "Capture window",
      "Device acquisition",
      "Acquisition processing",
    ],
    tools: ["Cursors", "Math and spectrum", "Display"],
    setup: [
      "Scope LCD",
      "Calibration",
      "Save and recall",
      "Help and shortcuts",
      "Connection",
    ],
  };
  const navigation = document.createElement("nav");
  navigation.className = "control-sections";
  navigation.setAttribute("aria-label", "Control sections");
  const buttons = [];
  const selectSection = (selected) => {
    for (const button of buttons)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.section === selected),
      );
    for (const card of cards) {
      if (card === acquisition) continue;
      const heading = card.querySelector("h2, summary")?.textContent;
      card.hidden = !sections[selected].includes(heading);
    }
    sidebar.scrollTop = 0;
  };
  for (const [section, title] of [
    ["channels", "Channels"],
    ["trigger", "Trigger"],
    ["acquisition", "Acquisition"],
    ["tools", "Tools"],
    ["setup", "Setup"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.dataset.section = section;
    button.onclick = () => selectSection(section);
    buttons.push(button);
    navigation.append(button);
  }
  sidebar.prepend(navigation);
  const cursorCard = cards.find((card) => card.querySelector("#cursormode"));
  cursorCard.append(
    document.querySelector('label[for="cursorchannel"]'),
    $("cursorchannel"),
  );
  cursorCard.append($("cursorread"));
  const lcdCursors = cards.find((card) => card.querySelector("#lcdcursor"));
  lcdCursors.querySelector("#lcdcursor").closest("details").hidden = true;
  selectSection("channels");
}
setupControlSections();
function setupOptions(data) {
  options = data;
  for (let i = 1; i < data.rates.length; i++)
    $("rate").add(
      new Option(
        `${format(750 / (GRID_COLUMNS * data.rates[i]), "s")}/div · ${format(data.rates[i], "S/s")}`,
        i,
      ),
    );
  for (let ch = 1; ch <= 2; ch++)
    data.scales_mv.forEach((mv, i) =>
      $("scale" + ch).add(new Option(`${format(mv / 1000, "V")}/div`, i)),
    );
  data.scales_mv.forEach((millivolts, index) => {
    const option = new Option(`${format(millivolts / 1000, "V")}/div`, index);
    option.dataset.millivolts = millivolts;
    $("lcdmathrange").add(option);
  });
  updateControls();
}
function setValue(id, value) {
  if (
    document.activeElement !== $(id) &&
    !dirtyInputs.has(id) &&
    $(id).value !== String(value)
  )
    $(id).value = value;
}
function updateControls() {
  $("usbmode").disabled = busy;
  const s = state.settings;
  document.querySelectorAll(".control").forEach((el) => {
    const queuedMath =
      processingEditActive &&
      ["mathop", "mathsource", "fftwindow", "fftunits"].includes(el.id);
    const disabled = !state.connected || (busy && !queuedMath) || !options;
    if (el.disabled !== disabled) el.disabled = disabled;
  });
  $("connection").classList.toggle("connected", !!state.connected);
  $("status").textContent = busy
    ? "Applying setting…"
    : state.status || "Connecting…";
  $("status").title = $("status").textContent;
  if (!s || !options || busy) return;
  lcdControls.update(s.lcd || {});
  cursorControls.update();
  setValue(
    "calbaseline",
    s.calibration_baseline === 2
      ? "ZERO"
      : s.calibration_baseline === 1
        ? "REFERENCE"
        : "STOCK",
  );
  $("calbaseline").disabled =
    !state.connected || s.calibration_baseline == null;
  $("calstart").disabled = !state.connected || s.calibration_baseline !== 1;
  if (state.transport_kind === "webusb") {
    $("calstart").disabled = true;
    $("calstart").title =
      "Grounded self-calibration requires the Python bridge";
  }
  $("baselinehelp").textContent =
    s.calibration_baseline === 2
      ? "Using stock ADC gain and nominal volts/div with compatible saved zero/position corrections. Reference voltage gains and factory records are unchanged."
      : s.calibration_baseline === 0
        ? "Using this unit’s stock factory records and stock conversion. Reference corrections are retained separately."
        : "Using optional reference corrections. Switch to Stock to return to the factory baseline.";
  const activity = state.activity || {},
    rec = state.record_acquisition || {},
    working = !!(activity.run || s.running || rec.running);
  const phase =
    activity.state === 6
      ? "ACQUISITION ERROR"
      : lastActivityArrival !== null &&
          performance.now() - lastActivityArrival > 2000
        ? "USB HEARTBEAT OVERDUE"
        : working
          ? "ACQUIRING"
          : "STOPPED";
  $("status").textContent = phase;
  $("status").title = phase;
  $("status").style.color = working ? "#65df84" : "#ff6868";
  $("connection").querySelector(".dot").style.opacity =
    working && phase === "ACQUIRING"
      ? ((activity.heartbeat || 0) >> 1) & 1
        ? "1"
        : "0.2"
      : "1";
  const single = s.trigger?.sweep === 2;
  $("run").textContent = rec.running
    ? "Cancel record"
    : s.running && !single
      ? "Stop"
      : "Run";
  $("run").setAttribute("aria-pressed", String(s.running && !single));
  $("trigsingle").textContent =
    single && s.running ? "Single armed" : "Single shot";
  $("usb").textContent = s.usb_speed
    ? `USB · ${s.usb_speed}`
    : "Waiting for USB";
  setValue("slowmode", s.roll?.mode ? "LIVE" : "TRIGGERED");
  $("recordprogress").textContent = rec.running
    ? `${rec.stage || "Acquiring"} · ${(rec.elapsed_s || 0).toFixed(1)} s elapsed. Controls remain available; changing acquisition cancels this record.`
    : rec.message || "";
  const t = s.trigger;
  if (t) {
    $("trigmode").querySelector('option[value="PULSE"]').disabled =
      !!t.alternate;
    setValue("trigfamily", t.alternate ? "ALTERNATE" : "NORMAL");
    $("trigfamily").disabled = !state.connected || !s.device_acquisition?.frame;
    $("altstatus").textContent = t.alternate
      ? "Both channel trigger banks are active. Source selects the bank to edit; alternate mode uses Auto sweep."
      : "";
    $("trigsingle").disabled = !!t.alternate || t.mode === 1;
    $("trigsweep").disabled = !!t.alternate || t.mode === 1;
    setValue(
      "trigmode",
      [
        "EDGE",
        "VIDEO",
        "PULSE",
        "SLOPE",
        "RUNT",
        "SPIKE",
        "TIMEOUT",
        "NTHEDGE",
      ][t.mode || 0],
    );
    setValue("trigwidth", t.width_ns || 500000);
    setValue("trigcondition", t.condition || 0);
    setValue("triglower", (t.lower_uv | 0) / 1e6);
    setValue("trigupper", (t.upper_uv | 0) / 1e6);
    setValue("trigcount", t.count || 2);
    setValue("trigvideostandard", t.standard || 0);
    setValue("trigvideosync", t.sync || 0);
    setValue("trigvideocount", t.video_count || 0);
    for (const id of [
      "trigvideostandard",
      "trigvideosync",
      "trigvideocount",
      "trigvideoapply",
      "recordchannel",
      "recorddepth",
      "recordforce",
      "recorddownload",
      "trigmode",
      "trigwidth",
      "trigcondition",
      "triglower",
      "trigupper",
      "trigcount",
      "trigwidthapply",
      "triglimitsapply",
      "trigcountapply",
    ])
      $(id).disabled = !state.connected || !t.advanced_supported;
    updateVideoControls();
    $("recorddownload").title =
      t.mode === 2 && t.pulse_status?.sampled
        ? "Pulse qualification checks the sampled record; pulses outside the record are not observed."
        : "";
    setValue("trigenabled", t.en ? "ON" : "OFF");
    setValue("trigsource", t.src ? "CH2" : "CH1");
    setValue("trigslope", t.slope ? "FALL" : "RISE");
    setValue("trigsweep", ["AUTO", "NORMAL", "SINGLE"][t.sweep]);
    setValue("trigcoupling", t.coupling ? "AC" : "DC");
    setValue("trigholdoff", t.holdoff_ns);
    setValue("trigcode", t.code | 0);
    setValue("triglevel", (t.uv | 0) / 1e6);
    $("trigstatus").textContent = activity.roll
      ? "Live roll is a free-running preview; trigger settings are retained for Triggered mode and Single shot."
      : t.mode === 2
        ? t.alternate
          ? "Pulse in Alternate family remains under development."
          : t.pulse_status?.sampled
            ? "Sampled Pulse · record/sample-rate limits apply. Auto fallback and Force are marked in frame metadata."
            : "Native FPGA Pulse remains under development."
        : t.mode === 1
          ? "Video uses Auto sweep. Native sync qualification is being validated; Auto fallback and Force are marked in frame metadata."
          : t.mode > 0
            ? "Experimental FPGA trigger · detection not confirmed."
            : `${t.raw ? "Raw threshold" : "Voltage threshold"} · ${!s.running ? "stopped" : s.roll?.active ? "ROLL · free-running" : "acquiring"}. Voltage accuracy depends on channel calibration.`;
  }
  const device = s.device_acquisition || {};
  setValue("deviceacqmode", ["SAMPLE", "PEAK", "AVERAGE"][device.mode || 0]);
  setValue("deviceaverages", device.averages || 16);
  for (const id of ["deviceacqmode", "deviceaverages"])
    $(id).disabled = !state.connected || !device.frame;
  $("deviceacqmode").querySelector("option[value=AVERAGE]").disabled =
    !!s.roll?.active;
  if (rec.running)
    for (const id of [
      "recordchannel",
      "recorddepth",
      "recordforce",
      "recorddownload",
    ])
      $(id).disabled = true;
  $("deviceacqstatus").textContent =
    device.mode === 1
      ? "FPGA peak detection is active. Timing and RMS measurements are unavailable until its sample format is reference-validated."
      : device.mode === 2
        ? `On-device exponential average · factor ${device.averages}.`
        : latest?.metadata.filling
          ? `Filling live roll · ${latest.metadata.valid_count} fresh samples. Uncollected history is blank.`
          : s.roll?.active
            ? "ROLL acquisition · overlapping windows. Channels are aligned in the current frame format."
            : "Raw sample acquisition on the scope.";
  for (let i = 0; i < 2; i++) {
    const ch = s.channels[i],
      n = i + 1;
    setValue("bandwidth" + n, ch.bandwidth ? "ON" : "OFF");
    $("bandwidth" + n).disabled =
      !state.connected || ch.bandwidth === undefined;
    setValue("scale" + n, ch.range);
    for (const option of $("scale" + n).options)
      option.disabled =
        s.calibration_baseline !== 1 &&
        (Number(option.value) < 3 || Number(option.value) > 11);
    setValue("coupling" + n, ["DC", "AC"][ch.coupling]);
    setValue(
      "position" + n,
      Number(
        (
          (((ch.position_mdiv || 0) / 1000) *
            options.scales_mv[ch.range] *
            (ch.probe || 1)) /
          1000
        ).toPrecision(7),
      ),
    );
    $("position" + n).min =
      (-4 * options.scales_mv[ch.range] * (ch.probe || 1)) / 1000;
    $("position" + n).max =
      (4 * options.scales_mv[ch.range] * (ch.probe || 1)) / 1000;
    $("position" + n).step =
      (options.scales_mv[ch.range] * (ch.probe || 1)) / 100000;
    setValue("probe" + n, ch.probe || 1);
    setValue("visible" + n, ch.visible ? "ON" : "OFF");
    setValue("inverse" + n, ch.inverse ? "ON" : "OFF");
    $("legend" + n).textContent =
      `CH${n} · ${format((options.scales_mv[ch.range] * (ch.probe || 1)) / 1000, "V")}/div · ${["DC", "AC"][ch.coupling]}${ch.inverse ? " · INV" : ""}${ch.visible ? "" : " · hidden"} · ${format((((ch.position_mdiv || 0) / 1000) * options.scales_mv[ch.range] * (ch.probe || 1)) / 1000, "V")} offset${s.calibration_baseline === 2 ? (s.calibration?.[i]?.[ch.range]?.valid ? " · STOCK + ZERO" : " · STOCK / NO ZERO") : s.calibration_baseline === 0 ? " · STOCK" : s.calibration?.[i]?.[ch.range]?.valid === 1 ? " · REF" : s.calibration?.[i]?.[ch.range]?.valid === 2 ? " · ZERO / NOM" : " · NOM"}`;
  }
  const v = s.view || { start: 0, points: 1000 };
  if (
    !Array.from($("viewpoints").options).some(
      (o) => Number(o.value) === v.points,
    )
  )
    $("viewpoints").add(new Option(String(v.points), v.points));
  setValue("viewpoints", v.points);
  setValue("viewstart", v.start);
  $("viewstart").max = (v.available || 2000) - v.points;
  if (document.activeElement !== $("rate")) {
    for (let i = 1; i < options.rates.length; i++) {
      const label = `${format((i === s.rate_index ? v.points : 750) / (GRID_COLUMNS * options.rates[i]), "s")}/div${i === s.rate_index && v.points !== 750 ? " (custom window)" : ""} · ${format(options.rates[i], "S/s")}`;
      if ($("rate").options[i - 1].text !== label)
        $("rate").options[i - 1].text = label;
    }
  }
  setValue("rate", s.rate_index);
  const horizontalOffsetNs = s.horizontal?.enabled
    ? s.horizontal.offset_ns | 0
    : 0;
  setValue("horizontaloffset", horizontalOffsetNs);
  $("horizontalreadout").textContent =
    `H: ${horizontalOffsetNs > 0 ? "+" : ""}${format(horizontalOffsetNs / 1e9, "s")}`;
  for (const id of ["horizontaloffset", "horizontalapply", "horizontalstock"])
    $(id).disabled = !state.connected || !s.trigger?.advanced_supported;
  if (s.roll?.active) {
    $("horizontaloffset").disabled = $("horizontalapply").disabled = true;
  }
  $("horizontalhint").textContent = s.roll?.active
    ? "Live roll uses zero horizontal offset. The saved offset returns in fast or triggered acquisition."
    : "Positive delay moves the waveform left. Choose triggered slow acquisition to use an offset at long timebases.";
  const stored = s.persistence?.sequence || 0;
  $("devicesave").disabled = !state.connected || !!s.persistence?.volatile;
  $("persiststatus").textContent = s.persistence?.volatile
    ? "Temporary session · changes stay in RAM."
    : s.persistence?.save_error
      ? "Save failed; will retry."
      : s.persistence?.dirty
        ? "Changes pending · saving automatically…"
        : stored
          ? `Saved on scope · record ${stored}.`
          : "No setup saved on scope yet.";
  $("deviceload").disabled = !stored;
  if (state.transport_kind === "webusb")
    $("usbconnect").textContent = state.connected
      ? "Disconnect USB"
      : "Connect USB";
  const calibration = state.calibration;
  $("calstatus").textContent =
    calibration?.message ||
    (s.factory?.state === 1 || s.factory?.state === 2
      ? "Ready · factory phase/DAC loaded"
      : "Ready");
  $("calcancel").disabled = !calibration?.running;
  if (calibration?.running)
    document.querySelectorAll(".control").forEach((el) => (el.disabled = true));
  const p = state.processing || {};
  $("mathop").querySelector('option[value="subtract"]').textContent =
    p.math_reversed ? "CH2 − CH1" : "CH1 − CH2";
  for (const [id, key] of [
    ["acqmode", "mode"],
    ["averages", "averages"],
    ["mathop", "math"],
    ["mathsource", "math_source"],
    ["fftwindow", "fft_window"],
    ["fftunits", "fft_units"],
    ["plotstyle", "style"],
    ["intensity", "intensity"],
    ["persistence", "persistence"],
  ])
    if (p[key] !== undefined)
      setValue(
        id,
        pendingProcessing.has(key)
          ? pendingProcessing.get(key)
          : processingEditActive?.key === key
            ? processingEditActive.value
            : p[key],
      );
  $("acqcount").textContent =
    `${p.mode || "sample"} · ${latest?.processing_count || 1}/${p.mode === "sample" ? 1 : p.averages || 16} records. Processing cannot recover samples between acquisitions.`;
  updateMeasurements();
  if (latest)
    $("calibrationnote").textContent =
      [0, 1]
        .map(
          (ch) =>
            `CH${ch + 1}: ${s.calibration_baseline === 2 ? (voltageCoefficients(ch).zeroCalibrated ? "STOCK gain; ZERO corrected" : "STOCK gain; no compatible zero correction") : s.calibration_baseline === 0 ? "STOCK factory baseline" : voltageCoefficients(ch).valid ? "Reference correction" : voltageCoefficients(ch).zeroCalibrated ? "ZERO adjusted; gain nominal" : "nominal, unverified range"}${latest.measurements?.[ch]?.clipped ? " · ADC clipping" : ""}`,
        )
        .join(" · ") +
      " · Vertical lines: M time/div. Horizontal lines: channel V/div.";
  dirty = true;
}
async function control(action) {
  if (markerDrag) cancelMarkerDrag();
  const background = action.op === "record";
  if (busy && !background) return;
  if (!background) busy = true;
  $("error").textContent = "";
  updateControls();
  try {
    const data = await sendControl(action);
    if (
      data.session !== state.session ||
      (data.revision || 0) >= (state.revision || 0)
    ) {
      state.settings = data.settings;
      state.revision = data.revision;
      state.session = data.session;
      state.processing = data.processing || state.processing;
      state.status = data.settings.running ? "Running" : "Stopped";
    }
    if (data.record)
      download(
        new Blob([JSON.stringify(data.record, null, 2)], {
          type: "application/json",
        }),
        data.record.records
          ? `slopscope-both-${data.record.records[0].metadata.payload_bytes}.json`
          : `slopscope-ch${data.record.metadata.channel + 1}-${data.record.metadata.payload_bytes}.json`,
      );
    return data.settings;
  } catch (e) {
    if (background && /cancelled/i.test(e.message)) return;
    $("error").textContent = e.message;
    throw e;
  } finally {
    if (!background) busy = false;
    updateControls();
    void flushProcessingSettings();
  }
}
function invoke(action) {
  return control(action).catch(() => {});
}
const applyEdited = (action, ids) =>
  control(action)
    .then(() => {
      ids.forEach((id) => dirtyInputs.delete(id));
      updateControls();
    })
    .catch(() => {});
const trig = (key, value) => invoke({ op: "trigger", key, value });
function processSetting(key, value) {
  if (processingEditSession !== state.session) pendingProcessing.clear();
  processingEditSession = state.session;
  pendingProcessing.set(key, value);
  void flushProcessingSettings();
}
async function flushProcessingSettings() {
  if (busy || processingEditActive) return;
  while (pendingProcessing.size && !busy) {
    if (processingEditSession !== state.session) {
      pendingProcessing.clear();
      break;
    }
    const [key, value] = pendingProcessing.entries().next().value;
    pendingProcessing.delete(key);
    processingEditActive = { key, value };
    try {
      await control({ op: "processing", key, value });
    } catch {
      /* The control error is shown beside the connection status. */
    } finally {
      processingEditActive = null;
    }
  }
  updateControls();
}
for (const [id, key] of [
  ["trigfamily", "family"],
  ["trigmode", "mode"],
  ["trigenabled", "enabled"],
  ["trigsource", "source"],
  ["trigslope", "slope"],
  ["trigsweep", "sweep"],
  ["trigcoupling", "coupling"],
])
  $(id).onchange = () => trig(key, $(id).value);
$("slowmode").onchange = () =>
  invoke({ op: "roll", value: $("slowmode").value });
$("deviceacqmode").onchange = () =>
  invoke({ op: "acquire", key: "mode", value: $("deviceacqmode").value });
$("deviceaverages").onchange = () =>
  invoke({
    op: "acquire",
    key: "averages",
    value: Number($("deviceaverages").value),
  });
$("trigwidthapply").onclick = () =>
  applyEdited(
    { op: "trigger", key: "width_ns", value: Number($("trigwidth").value) },
    ["trigwidth"],
  );
$("trigcondition").onchange = () =>
  trig("condition", Number($("trigcondition").value));
$("trigcountapply").onclick = () =>
  applyEdited(
    { op: "trigger", key: "count", value: Number($("trigcount").value) },
    ["trigcount"],
  );
$("triglimitsapply").onclick = () =>
  applyEdited(
    {
      op: "trigger_limits",
      lower_uv: Math.round(Number($("triglower").value) * 1e6),
      upper_uv: Math.round(Number($("trigupper").value) * 1e6),
    },
    ["triglower", "trigupper"],
  );
function updateVideoControls() {
  const maximum = Number($("trigvideostandard").value) === 0 ? 525 : 625;
  $("trigvideocount").max = maximum;
  $("trigvideocount").disabled =
    !state.connected ||
    !state.settings?.trigger?.advanced_supported ||
    Number($("trigvideosync").value) !== 4;
}
$("trigvideostandard").onchange = () => {
  dirtyInputs.add("trigvideostandard");
  updateVideoControls();
};
$("trigvideosync").onchange = () => {
  dirtyInputs.add("trigvideosync");
  updateVideoControls();
};
$("trigvideoapply").onclick = () =>
  applyEdited(
    {
      op: "video",
      standard: Number($("trigvideostandard").value),
      sync: Number($("trigvideosync").value),
      count: Math.max(
        1,
        Math.min(
          Number($("trigvideocount").value),
          Number($("trigvideocount").max),
        ),
      ),
    },
    ["trigvideostandard", "trigvideosync", "trigvideocount"],
  );
$("recorddownload").onclick = () =>
  invoke({
    op: "record",
    channel:
      $("recordchannel").value === "both"
        ? "both"
        : Number($("recordchannel").value),
    depth: Number($("recorddepth").value),
    force: $("recordforce").checked,
  });
$("horizontalapply").onclick = () =>
  applyEdited(
    { op: "horizontal", value: Number($("horizontaloffset").value) },
    ["horizontaloffset"],
  );
$("horizontalstock").onclick = () =>
  applyEdited({ op: "horizontal", stock: true }, ["horizontaloffset"]);
$("trigholdapply").onclick = () =>
  trig("holdoff_ns", Number($("trigholdoff").value));
$("trigapply").onclick = () =>
  trig("level_uv", Math.round(Number($("triglevel").value) * 1e6));
$("trigraw").onclick = () => trig("code", Number($("trigcode").value));
$("trigforce").onclick = () => trig("force");
$("trigsingle").onclick = () => trig("single");
$("calbaseline").onchange = () =>
  invoke({ op: "calibration_baseline", value: $("calbaseline").value });
$("calstart").onclick = () => {
  if (!$("calgrounded").checked) {
    $("error").textContent =
      "Disconnect signal sources and ground both probe tips first.";
    return;
  }
  invoke({ op: "selfcal_start", grounded: true });
};
$("calcancel").onclick = () => invoke({ op: "selfcal_cancel" });
$("devicesave").onclick = () => invoke({ op: "device_save" });
$("deviceload").onclick = () => invoke({ op: "device_load" });
$("run").onclick = () =>
  invoke({
    op:
      state.record_acquisition?.running ||
      (state.settings?.running && state.settings?.trigger?.sweep !== 2)
        ? "stop"
        : "run",
  });
$("autoset").onclick = () => invoke({ op: "autoset" });
$("defaults").onclick = () => invoke({ op: "defaults" });
$("rate").addEventListener("blur", updateControls);
$("rate").onchange = () =>
  invoke({ op: "timebase", index: Number($("rate").value) });
for (let ch = 1; ch <= 2; ch++) {
  $("scale" + ch).onchange = () =>
    invoke({ op: "scale", channel: ch, index: Number($("scale" + ch).value) });
  $("coupling" + ch).onchange = () =>
    invoke({ op: "coupling", channel: ch, value: $("coupling" + ch).value });
  $("posapply" + ch).onclick = () =>
    control({
      op: "position",
      channel: ch,
      value: Math.round(
        (Number($("position" + ch).value) * 1000000) /
          (options.scales_mv[state.settings.channels[ch - 1].range] *
            (state.settings.channels[ch - 1].probe || 1)),
      ),
    })
      .then(() => {
        dirtyInputs.delete("position" + ch);
        updateControls();
      })
      .catch(() => {});
  $("probe" + ch).onchange = () =>
    invoke({ op: "probe", channel: ch, value: Number($("probe" + ch).value) });
  for (const [id, op] of [
    ["visible", "display"],
    ["inverse", "inverse"],
    ["bandwidth", "bandwidth"],
  ])
    $(id + ch).onchange = () =>
      invoke({ op, channel: ch, value: $(id + ch).value });
}
$("viewpoints").onchange = () => {
  const points = Number($("viewpoints").value);
  const available = state.settings?.view?.available || 2000;
  $("viewstart").max = available - points;
  if (Number($("viewstart").value) > available - points)
    $("viewstart").value = available - points;
};
$("viewapply").onclick = () =>
  invoke({
    op: "view",
    start: Number($("viewstart").value),
    points: Number($("viewpoints").value),
  });
$("viewreset").onclick = () =>
  invoke({ op: "timebase", index: state.settings.rate_index });
for (const [id, key, numeric] of [
  ["acqmode", "mode", false],
  ["averages", "averages", true],
  ["mathop", "math", false],
  ["mathsource", "math_source", true],
  ["fftwindow", "fft_window", false],
  ["fftunits", "fft_units", false],
  ["plotstyle", "style", false],
  ["intensity", "intensity", true],
  ["persistence", "persistence", true],
])
  $(id).onchange = () =>
    processSetting(key, numeric ? Number($(id).value) : $(id).value);
$("clear").onclick = () => {
  past = [];
  processSetting("mode", state.processing?.mode || "sample");
  dirty = true;
};
$("fit").onclick = () => invoke({ op: "fit" });
function view() {
  const v = state.settings?.view || { start: 0, points: 1000 };
  return latest?.metadata.roll
    ? {
        ...v,
        start: Math.max(
          0,
          (latest.metadata.samples_per_channel || 1998) - v.points,
        ),
      }
    : v;
}
function voltageCoefficients(ch, frame = latest) {
  const m = frame.metadata,
    index = m[`ch${ch + 1}_range`],
    cal = state.settings?.calibration?.[ch]?.[index] || {
      zero: 0,
      gain: options.scales_mv[index] * 10240,
      dac: 0,
      slope: 0,
      valid: 0,
    };
  const dac = (m.offsets_packed >>> (ch * 16)) & 65535,
    gain = (cal.gain / 256000000) * (state.settings.channels[ch].probe || 1),
    offset = (-(cal.zero + (dac - cal.dac) * cal.slope) / 65536) * gain;
  return {
    gain,
    offset,
    valid: cal.valid === 1,
    zeroCalibrated: cal.valid === 2,
  };
}
function scaleVolts(ch) {
  const c = state.settings.channels[ch];
  return (options.scales_mv[c.range] * (c.probe || 1)) / 1000;
}
function normalize(data, ch) {
  const scale = scaleVolts(ch);
  return data.map((v) =>
    v === null ? null : v / scale + channelPositionDivisions(ch),
  );
}
function values(frame = latest) {
  const v = view();
  return (frame?.display_channels || frame?.channels || [[], []]).map(
    (samples, i) => {
      const c = voltageCoefficients(i, frame),
        sign = state.settings?.channels[i].inverse ? -1 : 1;
      return samples.slice(v.start, v.start + v.points).map((x, i) => {
        const index = v.start + i,
          start = frame.metadata.valid_from || 0,
          count = frame.metadata.valid_count ?? samples.length;
        return index < start || index >= start + count
          ? null
          : (x * c.gain + c.offset) * sign;
      });
    },
  );
}
function bounds() {
  return [-4, 4];
}
function trace(
  context,
  data,
  left,
  top,
  pw,
  ph,
  lo,
  hi,
  color,
  alpha = 1,
  dots = false,
  halfOpen = false,
) {
  context.strokeStyle = color;
  context.fillStyle = color;
  context.globalAlpha = alpha;
  context.lineWidth = 1.4;
  context.beginPath();
  let pen = false;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value === null || !Number.isFinite(value)) {
      pen = false;
      continue;
    }
    const x = left + (pw * i) / Math.max(1, data.length - (halfOpen ? 0 : 1)),
      y = top + ((hi - value) / (hi - lo)) * ph;
    if (dots) context.fillRect(x, y, 1.6, 1.6);
    else {
      pen ? context.lineTo(x, y) : context.moveTo(x, y);
      pen = true;
    }
  }
  if (!dots) context.stroke();
  context.globalAlpha = 1;
}
function plotGeometry() {
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    cell = Math.max(1, Math.min((w - 80) / GRID_COLUMNS, (h - 40) / 8)),
    pw = cell * GRID_COLUMNS,
    ph = cell * 8,
    left = (w - pw) / 2,
    top = 20 + (h - 40 - ph) / 2;
  return { w, h, left, right: left + pw, top, bottom: top + ph, pw, ph };
}
function prepare(target) {
  const w = target.clientWidth,
    h = target.clientHeight,
    dpr = devicePixelRatio || 1;
  if (
    target.width !== Math.round(w * dpr) ||
    target.height !== Math.round(h * dpr)
  ) {
    target.width = Math.round(w * dpr);
    target.height = Math.round(h * dpr);
  }
  const c = target.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = "11px system-ui";
  return target === canvas
    ? { c, ...plotGeometry() }
    : {
        c,
        w,
        h,
        left: 90,
        right: w - 90,
        top: 24,
        bottom: h - 38,
        pw: w - 180,
        ph: h - 62,
      };
}
function updateWindowReadout(frame) {
  const math = frame?.math;
  if (math?.kind === "fft") {
    $("window").textContent =
      `${math.window} · ${format(math.bin_hz, "Hz")}/bin · ${math.unit}`;
  } else if (math?.kind === "xy") {
    $("window").textContent = "CH1 voltage versus CH2 voltage";
  } else if (frame) {
    const window = view();
    $("window").textContent =
      `M: ${format(window.points / (frame.metadata.nominal_hz * GRID_COLUMNS), "s")}/div · ${format(window.points / frame.metadata.nominal_hz, "s")} span`;
  }
}
function mathScale() {
  const tools = state.settings?.lcd?.tools || {};
  const range = tools.math_range ?? state.settings?.channels[0]?.range ?? 9;
  return ((options?.scales_mv[range] || 1000) / 1000) * (tools.math_probe || 1);
}
function mathLegend() {
  const math = latest?.math;
  const separateAxes = ["fft", "xy"].includes(math?.kind);
  $("legend1").hidden = separateAxes;
  $("legend2").hidden = separateAxes;
  $("legendmath").hidden = !math;
  $("mathpanel").hidden = true;
  if (!math) return;
  const names = {
    add: "CH1 + CH2",
    subtract: state.processing?.math_reversed ? "CH2 − CH1" : "CH1 − CH2",
    multiply: "CH1 × CH2",
    divide: "CH1 ÷ CH2",
    xy: "XY · X: CH1 · Y: CH2",
    fft: `FFT · CH${(state.processing?.math_source || 0) + 1}`,
  };
  $("legendmath").textContent = separateAxes
    ? names[math.kind]
    : `${names[math.kind]} · ${format(mathScale(), math.unit)}/div`;
}
function drawArithmeticMath(geometry, intensity, dots) {
  const math = latest?.math;
  if (!["add", "subtract", "multiply", "divide"].includes(math?.kind)) return;
  const window = view(),
    tools = state.settings?.lcd?.tools || {};
  const divisions = math.values
    .slice(window.start, window.start + window.points)
    .map((value) =>
      Number.isFinite(value)
        ? value / mathScale() + (tools.math_position || 0) / 1000
        : null,
    );
  const { left, top, pw, ph } = geometry;
  trace(
    ctx,
    divisions,
    left,
    top,
    pw,
    ph,
    -4,
    4,
    "#f06dff",
    intensity,
    dots,
    true,
  );
}
function draw() {
  mathLegend();
  if (["fft", "xy"].includes(latest?.math?.kind)) {
    drawMath(canvas);
    return;
  }
  const g = prepare(canvas),
    { w, h, left, right, top, bottom, pw, ph } = g,
    [lo, hi] = bounds(),
    v = view();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#2b3949";
  ctx.fillStyle = "#91a3b8";
  ctx.strokeRect(left, top, pw, ph);
  for (let i = 0; i < GRID_COLUMNS; i++) {
    const x = left + (pw * (i + 0.5)) / GRID_COLUMNS;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    const y = top + (ph * i) / 8;
    ctx.strokeStyle = i === 4 ? "#455a70" : "#2b3949";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  if (!latest) {
    ctx.textAlign = "center";
    ctx.fillText("Waiting for an acquisition", w / 2, h / 2);
    return;
  }
  const p = state.processing || {},
    dots = p.style === "dots",
    intensity = (p.intensity || 90) / 100;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, pw, ph);
  ctx.clip();
  past.forEach((frame, j) =>
    values(frame).forEach((ch, i) => {
      if (state.settings?.channels[i].visible)
        trace(
          ctx,
          normalize(ch, i),
          left,
          top,
          pw,
          ph,
          lo,
          hi,
          i ? "#58d4eb" : "#f6ce51",
          (intensity * 0.45 * (j + 1)) / past.length,
          dots,
          true,
        );
    }),
  );
  if (latest.envelope)
    for (let i = 0; i < 2; i++) {
      if (!state.settings?.channels[i].visible) continue;
      for (const key of ["low", "high"]) {
        const cf = voltageCoefficients(i),
          sign = state.settings.channels[i].inverse ? -1 : 1,
          data = latest.envelope[key][i]
            .slice(v.start, v.start + v.points)
            .map((x) => (x * cf.gain + cf.offset) * sign);
        trace(
          ctx,
          normalize(data, i),
          left,
          top,
          pw,
          ph,
          lo,
          hi,
          i ? "#58d4eb" : "#f6ce51",
          0.45,
          dots,
          true,
        );
      }
    }
  const channels = values();
  channels.forEach((ch, i) => {
    if (state.settings?.channels[i].visible)
      trace(
        ctx,
        normalize(ch, i),
        left,
        top,
        pw,
        ph,
        lo,
        hi,
        i ? "#58d4eb" : "#f6ce51",
        intensity,
        dots,
        true,
      );
  });
  drawArithmeticMath(g, intensity, dots);
  if (hover !== null) {
    const i = Math.max(
        0,
        Math.min(v.points - 1, Math.round(((hover - left) / pw) * v.points)),
      ),
      x = left + (pw * i) / v.points;
    ctx.strokeStyle = "#91a3b8";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    $("hover").textContent =
      `Sample ${v.start + i} · ${format((v.start + i) / latest.metadata.nominal_hz, "s")} · CH1 ${format(channels[0][i], "V")} · CH2 ${format(channels[1][i], "V")}`;
  }
  const mode = $("cursormode").value,
    a = Number($("cursora").value),
    b = Number($("cursorb").value);
  ctx.strokeStyle = "#75d5a0";
  ctx.setLineDash([5, 4]);
  if (mode !== "off")
    for (const value of [a, b]) {
      ctx.beginPath();
      if (mode === "time") {
        const x = left + (pw * (value - v.start)) / v.points;
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
      } else {
        const ch = Number($("cursorchannel").value),
          div =
            value / scaleVolts(ch) +
            (state.settings.channels[ch].position_mdiv || 0) / 1000,
          y = top + ((hi - div) / (hi - lo)) * ph;
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
      }
      ctx.stroke();
    }
  ctx.setLineDash([]);
  ctx.restore();
  for (const marker of plotMarkers()) {
    ctx.fillStyle = marker.color;
    ctx.beginPath();
    ctx.moveTo(marker.x, marker.y);
    ctx.lineTo(marker.x + marker.width, marker.y - marker.height);
    ctx.lineTo(marker.x + marker.width, marker.y + marker.height);
    ctx.closePath();
    ctx.fill();
    if (marker.kind === "trigger") {
      ctx.save();
      ctx.font = "bold 10px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#111820";
      ctx.fillText(String(marker.channel + 1), marker.x + 10, marker.y);
      ctx.restore();
    }
    if (
      markerPreview?.moved &&
      marker.kind === markerPreview.kind &&
      marker.channel === markerPreview.channel
    ) {
      ctx.save();
      ctx.strokeStyle = marker.color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(left, marker.y);
      ctx.lineTo(right, marker.y);
      ctx.stroke();
      ctx.restore();
    }
  }
  $("cursorread").textContent =
    mode === "time"
      ? `Δt ${format((b - a) / latest.metadata.nominal_hz, "s")} · 1/|Δt| ${b !== a ? format(latest.metadata.nominal_hz / Math.abs(b - a), "Hz") : "—"}`
      : mode === "voltage"
        ? `CH${Number($("cursorchannel").value) + 1} ΔV ${format(b - a, "V")}`
        : "";
}
function drawMath(target) {
  const math = latest?.math;
  $("mathpanel").hidden = true;
  if (!math) return;
  const { c, left, top, pw, ph, bottom, right } = prepare(target);
  let data = math.values,
    x = math.x || null,
    start = 0,
    end = data.length;
  const v = view();
  if (math.kind === "fft") {
    const f =
      latest.measurements?.[state.processing?.math_source || 0]?.frequency_hz;
    if (f) end = Math.min(end, Math.max(16, Math.ceil((f * 8) / math.bin_hz)));
    $("mathtitle").textContent =
      `FFT · CH${(state.processing?.math_source || 0) + 1} · ${math.window} · ${format(math.bin_hz, "Hz")}/bin`;
  } else {
    $("mathtitle").textContent =
      math.kind === "xy" ? "XY · CH1 versus CH2" : `Math · ${math.kind}`;
    start = v.start;
    end = v.start + v.points;
  }
  updateWindowReadout(latest);
  $("hover").textContent =
    "Math is computed on the PC from both incoming raw channels.";
  data = data.slice(start, end);
  if (x) x = x.slice(start, end);
  const valid = data.filter(Number.isFinite);
  if (!valid.length) return;
  let lo = Math.min(...valid),
    hi = Math.max(...valid),
    pad = Math.max(0.1, (hi - lo) * 0.08);
  lo -= pad;
  hi += pad;
  c.fillStyle = "#91a3b8";
  c.strokeStyle = "#2b3949";
  c.strokeRect(left, top, pw, ph);
  c.textAlign = "right";
  c.fillText(format(hi), left - 6, top + 4);
  c.fillText(format(lo), left - 6, bottom);
  $("mathunit").textContent = math.unit;
  if (math.kind === "xy") {
    const xmin = Math.min(...x),
      xmax = Math.max(...x),
      span = Math.max(1, xmax - xmin);
    c.fillStyle = "#f06dff";
    for (let i = 0; i < data.length; i++)
      c.fillRect(
        left + (pw * (x[i] - xmin)) / span,
        top + ((hi - data[i]) / (hi - lo)) * ph,
        1.5,
        1.5,
      );
    c.fillStyle = "#91a3b8";
    c.fillText(
      `${xmin.toFixed(1)} → ${xmax.toFixed(1)} CH1 ${math.unit}`,
      right,
      bottom + 20,
    );
  } else {
    trace(c, data, left, top, pw, ph, lo, hi, "#f06dff");
    c.fillText(
      math.kind === "fft"
        ? `0 → ${format(math.frequencies[end - 1], "Hz")}`
        : `${format((end - start) / latest.metadata.nominal_hz, "s")}`,
      right,
      bottom + 20,
    );
  }
}
function voltageMeasurement(key, ch) {
  if (key === "frequency_hz") return frequencyReadout.values[ch];
  if (key === "period_s")
    return frequencyReadout.values[ch] ? 1 / frequencyReadout.values[ch] : null;
  const m = latest?.measurements?.[ch];
  if (!m || m[key] === null || m[key] === undefined) return null;
  const c = voltageCoefficients(ch),
    g = c.gain,
    b = c.offset;
  if (["min", "max", "base", "top", "mean"].includes(key))
    return m[key] * g + b;
  if (["pp", "amplitude", "ac_rms"].includes(key)) return m[key] * g;
  if (key === "rms")
    return Math.sqrt(
      Math.max(0, g * g * m.rms * m.rms + 2 * g * b * m.mean + b * b),
    );
  if (key === "cycle_rms")
    return m.cycle_mean === null
      ? null
      : Math.sqrt(
          Math.max(
            0,
            g * g * m.cycle_rms * m.cycle_rms +
              2 * g * b * m.cycle_mean +
              b * b,
          ),
        );
  return m[key];
}
function updateMeasurements() {
  const rows = [
    ["Frequency", "frequency_hz", "Hz"],
    ["Period", "period_s", "s"],
    ["Duty", "duty_percent", "%"],
    ["Positive width", "positive_width_s", "s"],
    ["Negative width", "negative_width_s", "s"],
    ["Rise 10–90%", "rise_s", "s"],
    ["Fall 90–10%", "fall_s", "s"],
    ["Min", "min", "V"],
    ["Max", "max", "V"],
    ["Peak to peak", "pp", "V"],
    ["Base", "base", "V"],
    ["Top", "top", "V"],
    ["Average", "mean", "V"],
    ["RMS", "rms", "V"],
    ["AC RMS", "ac_rms", "V"],
    ["Overshoot", "overshoot_percent", "%"],
    ["Undershoot", "undershoot_percent", "%"],
    ["Cycle RMS", "cycle_rms", "V"],
  ];
  const timing = latest?.channel_timing;
  $("channeltiming").textContent =
    latest?.measurement_note ||
    (timing
      ? `CH2 relative to CH1: ${format(timing.delay_s, "s")} lag · ${format(timing.phase_deg, "°")} phase`
      : "CH1/CH2 phase requires stable matching frequencies.");
  $("measurements").innerHTML = rows
    .map(
      ([name, key, unit]) =>
        `<tr><td>${name}</td>${[0, 1].map((i) => `<td>${format(voltageMeasurement(key, i), unit)}</td>`).join("")}</tr>`,
    )
    .join("");
}
function channelPositionDivisions(channel) {
  return markerPreview?.kind === "position" && markerPreview.channel === channel
    ? markerPreview.value / 1000
    : (state.settings.channels[channel].position_mdiv || 0) / 1000;
}
function markerContext() {
  const settings = state.settings;
  return JSON.stringify([
    state.session,
    settings?.calibration_baseline,
    settings?.channels.map(
      ({ range, probe, inverse, position_mdiv, visible }) => [
        range,
        probe,
        inverse,
        position_mdiv,
        visible,
      ],
    ),
    settings?.trigger?.en,
    settings?.trigger?.src,
    settings?.trigger?.raw,
    settings?.trigger?.code,
    settings?.trigger?.uv,
  ]);
}
function plotMarkers() {
  if (["fft", "xy"].includes(latest?.math?.kind)) return [];
  if (!latest || !state.settings) return [];
  const { right, top, bottom, ph } = plotGeometry();
  const clampY = (divisions) =>
    Math.max(top, Math.min(bottom, top + ((4 - divisions) * ph) / 8));
  const markers = state.settings.channels.flatMap((channel, index) =>
    channel.visible
      ? [
          {
            kind: "position",
            channel: index,
            x: right + 2 + index * 10,
            y: clampY(channelPositionDivisions(index)),
            width: 8,
            height: 5,
            color: index ? "#58d4eb" : "#f6ce51",
          },
        ]
      : [],
  );
  const trigger = state.settings.trigger;
  if (trigger?.en) {
    const channel = trigger.src,
      position = channelPositionDivisions(channel);
    const preview = markerPreview?.kind === "trigger" ? markerPreview : null;
    const level = trigger.raw
      ? (preview ? preview.value : trigger.code | 0) / 26 - position
      : (preview ? preview.value : trigger.uv | 0) / 1e6 / scaleVolts(channel);
    markers.push({
      kind: "trigger",
      channel,
      x: right + 22,
      y: clampY(
        position + level * (state.settings.channels[channel].inverse ? -1 : 1),
      ),
      width: 14,
      height: 10,
      color: "#fff",
    });
  }
  return markers;
}
function markerAt(event) {
  if (!state.connected || busy || state.calibration?.running) return null;
  const rect = canvas.getBoundingClientRect(),
    x = event.clientX - rect.left,
    y = event.clientY - rect.top;
  return (
    plotMarkers()
      .filter(
        (marker) =>
          x >= marker.x - 3 &&
          x <= marker.x + marker.width + 3 &&
          Math.abs(y - marker.y) <= marker.height + 5,
      )
      .sort(
        (left, right) =>
          Math.hypot(x - left.x - left.width * 0.7, y - left.y) -
          Math.hypot(x - right.x - right.width * 0.7, y - right.y),
      )[0] || null
  );
}
function cancelMarkerDrag() {
  const drag = markerDrag;
  markerDrag = null;
  markerPreview = null;
  if (drag && canvas.hasPointerCapture(drag.pointerId))
    canvas.releasePointerCapture(drag.pointerId);
  canvas.style.cursor = "";
  $("hover").textContent = "Move over the plot for voltage and time.";
  dirty = true;
}
function updateMarkerDrag(event) {
  const drag = markerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!state.connected || busy || markerContext() !== drag.context) {
    cancelMarkerDrag();
    return;
  }
  drag.moved ||=
    Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4;
  if (!drag.moved) return;
  const geometry = plotGeometry(),
    rect = canvas.getBoundingClientRect();
  const y = Math.max(
    geometry.top,
    Math.min(geometry.bottom, event.clientY - rect.top - drag.grabOffset),
  );
  const divisions = 4 - ((y - geometry.top) * 8) / geometry.ph;
  if (drag.kind === "position")
    drag.value = Math.max(-4000, Math.min(4000, Math.round(divisions * 1000)));
  else {
    const position = channelPositionDivisions(drag.channel);
    const sign = state.settings.channels[drag.channel].inverse ? -1 : 1;
    drag.value =
      drag.key === "code"
        ? Math.max(
            -127,
            Math.min(
              126,
              Math.round(26 * (position + (divisions - position) * sign)),
            ),
          )
        : Math.max(
            -1e9,
            Math.min(
              1e9,
              Math.round(
                (divisions - position) * sign * scaleVolts(drag.channel) * 1e6,
              ),
            ),
          );
  }
  $("hover").textContent =
    drag.kind === "position"
      ? `CH${drag.channel + 1} position: ${format((drag.value / 1000) * scaleVolts(drag.channel), "V")} · release to apply`
      : `TRIG CH${drag.channel + 1}: ${drag.key === "code" ? drag.value + " codes" : format(drag.value / 1e6, "V")} · release to apply`;
  hover = null;
  dirty = true;
}
function openTriggerSource(event) {
  const menu = $("triggersourcemenu");
  menu.hidden = false;
  menu
    .querySelectorAll("button")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.channel) === state.settings.trigger.src),
      ),
    );
  menu.style.left =
    Math.max(
      8,
      Math.min(
        innerWidth - menu.offsetWidth - 8,
        event.clientX - menu.offsetWidth,
      ),
    ) + "px";
  menu.style.top =
    Math.max(
      8,
      Math.min(innerHeight - menu.offsetHeight - 8, event.clientY + 10),
    ) + "px";
  menu.querySelector("button").focus();
}
canvas.style.touchAction = "none";
canvas.onpointerdown = (event) => {
  $("triggersourcemenu").hidden = true;
  if (event.button !== 0 || markerDrag) return;
  suppressMarkerClick = false;
  const marker = markerAt(event);
  if (!marker) return;
  const trigger = state.settings.trigger;
  const value =
    marker.kind === "position"
      ? state.settings.channels[marker.channel].position_mdiv || 0
      : trigger.raw
        ? trigger.code | 0
        : trigger.uv | 0;
  markerDrag = {
    ...marker,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    grabOffset: event.clientY - canvas.getBoundingClientRect().top - marker.y,
    value,
    initialValue: value,
    key: trigger.raw ? "code" : "level_uv",
    context: markerContext(),
    moved: false,
  };
  markerPreview = markerDrag;
  suppressMarkerClick = true;
  canvas.setPointerCapture(event.pointerId);
  canvas.style.cursor = "grabbing";
  hover = null;
  event.preventDefault();
};
canvas.onpointermove = (event) => {
  if (markerDrag) {
    updateMarkerDrag(event);
    return;
  }
  const marker = markerAt(event);
  canvas.style.cursor = marker ? "grab" : "";
  canvas.title = marker
    ? marker.kind === "trigger"
      ? `TRIG CH${marker.channel + 1}: drag level; click to choose channel`
      : `Drag CH${marker.channel + 1} position`
    : "";
  hover = marker ? null : event.clientX - canvas.getBoundingClientRect().left;
  dirty = true;
};
canvas.onpointerup = (event) => {
  if (!markerDrag || markerDrag.pointerId !== event.pointerId) return;
  updateMarkerDrag(event);
  const drag = markerDrag;
  if (!drag) return;
  markerDrag = null;
  canvas.releasePointerCapture(event.pointerId);
  canvas.style.cursor = "";
  setTimeout(() => {
    suppressMarkerClick = false;
  }, 0);
  if (!drag.moved || drag.value === drag.initialValue) {
    markerPreview = null;
    $("hover").textContent = "Move over the plot for voltage and time.";
    if (!drag.moved && drag.kind === "trigger") openTriggerSource(event);
    dirty = true;
    return;
  }
  const action =
    drag.kind === "position"
      ? { op: "position", channel: drag.channel + 1, value: drag.value }
      : { op: "trigger", key: drag.key, value: drag.value };
  control(action)
    .catch(() => {})
    .finally(() => {
      if (markerPreview === drag) markerPreview = null;
      dirty = true;
      $("hover").textContent = "Move over the plot for voltage and time.";
    });
};
canvas.onpointercancel = cancelMarkerDrag;
canvas.onlostpointercapture = () => {
  if (markerDrag) cancelMarkerDrag();
};
canvas.onpointerleave = () => {
  if (markerDrag) return;
  hover = null;
  dirty = true;
  $("hover").textContent = "Move over the plot for sample values.";
};
$("triggersourcemenu")
  .querySelectorAll("button")
  .forEach(
    (button) =>
      (button.onclick = () => {
        $("triggersourcemenu").hidden = true;
        if (
          state.connected &&
          !busy &&
          Number(button.dataset.channel) !== state.settings?.trigger?.src
        )
          invoke({
            op: "trigger",
            key: "source",
            value: `CH${Number(button.dataset.channel) + 1}`,
          });
      }),
  );
document.addEventListener("pointerdown", (event) => {
  if (!$("triggersourcemenu").contains(event.target))
    $("triggersourcemenu").hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    (markerDrag || !$("triggersourcemenu").hidden)
  ) {
    cancelMarkerDrag();
    $("triggersourcemenu").hidden = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
});
window.addEventListener("blur", () => {
  if (markerDrag) cancelMarkerDrag();
  $("triggersourcemenu").hidden = true;
});
window.addEventListener(
  "scroll",
  () => {
    $("triggersourcemenu").hidden = true;
  },
  true,
);
canvas.onclick = (e) => {
  if (suppressMarkerClick) {
    suppressMarkerClick = false;
    return;
  }
  const mode = $("cursormode").value;
  if (mode === "off" || !latest) return;
  const r = canvas.getBoundingClientRect(),
    g = plotGeometry(),
    [lo, hi] = bounds(),
    v = view(),
    fx = Math.max(0, Math.min(1, (e.clientX - r.left - g.left) / g.pw)),
    fy = Math.max(0, Math.min(1, (e.clientY - r.top - g.top) / g.ph));
  const value =
      mode === "time"
        ? Math.round(v.start + fx * v.points)
        : hi - (hi - lo) * fy,
    ch = Number($("cursorchannel").value),
    placed =
      mode === "time"
        ? value
        : (value - (state.settings.channels[ch].position_mdiv || 0) / 1000) *
          scaleVolts(ch);
  cursorControls.place(cursorNext++ % 2, placed);
  dirty = true;
};
new ResizeObserver(() => {
  if (markerDrag) cancelMarkerDrag();
  $("triggersourcemenu").hidden = true;
  dirty = true;
}).observe(canvas);
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("png").onclick = () => {
  draw();
  canvas.toBlob((blob) => {
    if (blob) download(blob, `scope-${latest?.metadata.sequence || 0}.png`);
  });
};
$("csv").onclick = () => {
  if (!latest) return;
  const m = latest.metadata;
  let csv = `# ${JSON.stringify(m)}\nsample,nominal_time_s,ch1_adc_code,ch2_adc_code,valid\n`;
  latest.channels[0].forEach((v, i) => {
    const start = m.valid_from || 0,
      count = m.valid_count ?? latest.channels[0].length,
      valid = i >= start && i < start + count;
    csv += `${i},${i / m.nominal_hz},${valid ? v : ""},${valid ? latest.channels[1][i] : ""},${valid ? 1 : 0}\n`;
  });
  download(new Blob([csv], { type: "text/csv" }), `scope-${m.sequence}.csv`);
};
$("savesetup").onclick = () => {
  if (!state.settings) return;
  download(
    new Blob(
      [
        JSON.stringify(
          {
            format: "slopscope-setup",
            version: 1,
            settings: state.settings,
            processing: state.processing,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
    "slopscope-setup.json",
  );
};
$("recallsetup").onclick = () => $("setupfile").click();
$("setupfile").onchange = async () => {
  try {
    const file = $("setupfile").files[0];
    if (!file) return;
    if (file.size > 16000) throw Error("Setup file is too large");
    await control({ op: "profile", profile: JSON.parse(await file.text()) });
  } catch (e) {
    $("error").textContent = e.message;
  } finally {
    $("setupfile").value = "";
  }
};
async function sendControl(action) {
  if (!usingBridge) return directController.control(action);
  const response = await fetch("./control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Control failed");
  return result;
}
function receiveState(incoming) {
  if (
    incoming.session === state.session &&
    (incoming.revision || 0) < (state.revision || 0)
  )
    return;
  if (incoming.session !== state.session) {
    lastSequence = null;
    past = [];
    lastActivityArrival = null;
    lastActivityStamp = null;
  }
  state = incoming;
  if (
    markerDrag &&
    (!state.connected || markerContext() !== markerDrag.context)
  )
    cancelMarkerDrag();
  if (!state.connected) $("triggersourcemenu").hidden = true;
  const activityStamp = state.activity?.received_at;
  if (
    state.connected &&
    activityStamp != null &&
    activityStamp !== lastActivityStamp
  ) {
    lastActivityStamp = activityStamp;
    lastActivityArrival = performance.now();
  }
  if (!state.connected) {
    latest = null;
    frequencyReadout.reset();
    lastSequence = null;
    dirty = true;
    for (const id of [
      "fps",
      "capturefps",
      "speed",
      "vpp1",
      "vpp2",
      "max1",
      "max2",
    ])
      $(id).textContent = "—";
  } else if (!state.frame) {
    latest = null;
    frequencyReadout.reset();
    lastSequence = null;
    dirty = true;
    for (const id of ["vpp1", "vpp2", "max1", "max2"]) $(id).textContent = "—";
  } else if (state.frame) {
    const frame = state.frame;
    if (
      frame.metadata.sequence !== lastSequence ||
      frame.processing_generation !== latest?.processing_generation
    ) {
      if (
        latest &&
        frame.processing_generation === latest.processing_generation &&
        [
          "offsets_packed",
          "rate_index",
          "ch1_range",
          "ch2_range",
          "ch1_coupling",
          "ch2_coupling",
        ].every((k) => frame.metadata[k] === latest.metadata[k])
      )
        past.push(latest);
      else past = [];
      past = past.slice(-Math.max(0, state.processing?.persistence || 0));
      if (!state.processing?.persistence) past = [];
      lastSequence = frame.metadata.sequence;
      lastArrival = performance.now();
      dirty = true;
    }
    latest = frame;
    frequencyReadout.update(frame, state.session);
    $("fps").textContent = state.settings?.running ? frame.fps.toFixed(1) : "0";
    $("capturefps").textContent = state.settings?.running
      ? frame.capture_fps?.toFixed(1) || "—"
      : "0";
    $("speed").textContent = format(
      state.settings?.running ? frame.payload_bps : 0,
      "B/s",
    );
    for (let channel = 0; channel < 2; channel++) {
      $("vpp" + (channel + 1)).textContent = format(
        voltageMeasurement("pp", channel),
        "V",
      );
      $("max" + (channel + 1)).textContent = format(
        voltageMeasurement("max", channel),
        "V",
      );
    }
    const v = view();
    updateWindowReadout(frame);
    $("ratehint").textContent =
      `${format(frame.metadata.nominal_hz, "S/s")} requested · ${v.points} visible points / channel`;
  }
  updateControls();
}
async function initializeTransport() {
  let serverOptions = { bridge: false };
  try {
    const response = await fetch("./options.json");
    if (response.ok) serverOptions = await response.json();
  } catch (_) {
    /* Static hosting needs no Python service. */
  }
  usingBridge = !!serverOptions.bridge;
  setupOptions({ ...OPTIONS, ...serverOptions });
  scopePicker = setupScopePicker({
    usingBridge,
    getState: () => state,
    getController: () => directController,
    isBusy: () => busy,
    onError: (error) => {
      $("error").textContent = error.message;
    },
  });
  const button = $("usbconnect");
  const modeButton = $("usbmode");
  modeButton.hidden = !serverOptions.bridge_available;
  modeButton.textContent = usingBridge ? "Use WebUSB" : "Use Python bridge";
  modeButton.onclick = async () => {
    busy = true;
    modeButton.disabled = true;
    button.disabled = true;
    updateControls();
    try {
      if (!usingBridge && state.connected) await directController.disconnect();
      const response = await fetch("./transport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: usingBridge ? "webusb" : "bridge" }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "Could not switch USB transport");
      location.reload();
    } catch (error) {
      $("error").textContent = error.message;
      busy = false;
      modeButton.disabled = false;
      button.disabled = usingBridge;
      updateControls();
    }
  };
  if (usingBridge) {
    button.disabled = true;
    button.textContent = "Python bridge";
    button.title = "The Python bridge owns the USB interface";
    $("transporthelp").textContent =
      "Connected through the local Python bridge. All calibration tools are available.";
    const events = new EventSource("./events");
    events.onmessage = (event) =>
      receiveState({ ...JSON.parse(event.data), transport_kind: "bridge" });
    events.onerror = () =>
      receiveState({
        ...state,
        connected: false,
        status: "Python bridge connection lost · reconnecting",
      });
  } else {
    directController = new BrowserController(receiveState);
    button.disabled = !navigator.usb || !window.isSecureContext;
    button.title = button.disabled
      ? "Use Chrome/Edge on HTTPS or localhost, or start the Python bridge"
      : "";
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (state.connected) await directController.disconnect();
        else await directController.connect(scopePicker.selected());
      } catch (error) {
        $("error").textContent = error.message;
      } finally {
        button.disabled = false;
        button.textContent = state.connected ? "Disconnect USB" : "Connect USB";
      }
    };
    $("transporthelp").textContent =
      "Connect directly in Chrome or Edge. Other browsers can use the Python bridge. Only one app can own the USB device.";
  }
}
initializeTransport().catch(
  (error) => ($("error").textContent = error.message),
);
let lastDraw = 0;
function animate(now) {
  if (dirty && now - lastDraw >= 1000 / 30) {
    draw();
    dirty = false;
    lastDraw = now;
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
setInterval(() => {
  $("age").textContent = latest
    ? state.settings?.running
      ? `Last frame ${((performance.now() - lastArrival) / 1000).toFixed(1)} s ago`
      : "Acquisition stopped · final frame retained"
    : "No frames yet";
}, 250);

document.addEventListener("keydown", (e) => {
  if (
    e.repeat ||
    /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName) ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    $("run").click();
  } else if (e.key.toLowerCase() === "s") $("trigsingle").click();
  else if (e.key === "Escape" && state.settings?.running)
    invoke({ op: "stop" });
});

for (const id of ["position1", "position2"]) {
  $(id).addEventListener("input", () => dirtyInputs.add(id));
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("posapply" + id.slice(-1)).click();
    }
  });
}

for (const id of [
  "trigwidth",
  "triglower",
  "trigupper",
  "trigcount",
  "trigvideosync",
  "trigvideocount",
  "horizontaloffset",
])
  $(id).addEventListener("input", () => dirtyInputs.add(id));

setInterval(() => {
  if (state.connected) updateControls();
}, 250);
