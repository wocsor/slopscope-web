import { screenshotBitmap } from "./lcd-controls.js";

export function setupLcdControls({
  getState,
  setValue,
  invoke,
  applyEdited,
  sendControl,
  download,
  onError,
  dirtyInputs,
}) {
  const $ = (id) => document.getElementById(id);
  let copying = false,
    cancelCopy = false,
    copySession;
  let brightnessEditing = false,
    brightnessPending = null,
    brightnessSession;
  const tools = () => getState().settings?.lcd?.tools || {};
  const cursorAction = () => {
    const current = tools();
    return {
      op: "lcd_cursors",
      mode: current.cursors || 0,
      source: (current.source || 0) + 1,
      selected: current.cursor || 0,
      xa: current.cursor_xa ?? 187,
      xb: current.cursor_xb ?? 562,
      ya: current.cursor_ya ?? 140,
      yb: current.cursor_yb ?? 340,
    };
  };
  $("lcdtheme").onchange = () =>
    invoke({ op: "lcd_theme", value: $("lcdtheme").value });
  $("lcdbrightness").oninput = () => {
    brightnessEditing = true;
    dirtyInputs.add("lcdbrightness");
    $("lcdbrightnessvalue").textContent = `${$("lcdbrightness").value}%`;
  };
  $("lcdbrightness").onchange = async () => {
    brightnessEditing = false;
    brightnessPending = Number($("lcdbrightness").value);
    try {
      await invoke({ op: "lcd_brightness", value: brightnessPending });
    } finally {
      brightnessPending = null;
      dirtyInputs.delete("lcdbrightness");
      update(getState().settings?.lcd || {});
    }
  };
  $("lcdbrightness").addEventListener("pointercancel", () => {
    brightnessEditing = false;
    dirtyInputs.delete("lcdbrightness");
    update(getState().settings?.lcd || {});
  });
  $("lcdautoset").onclick = () => invoke({ op: "lcd_autoset", key: "start" });
  $("lcdautosetcancel").onclick = () =>
    invoke({ op: "lcd_autoset", key: "cancel" });
  for (const [id, key] of [
    ["lcdcursor", "mode"],
    ["lcdcursorsource", "source"],
    ["lcdcursorselected", "selected"],
  ]) {
    $(id).onchange = () => {
      for (const name of ["lcdcursora", "lcdcursorb"]) dirtyInputs.delete(name);
      invoke({ ...cursorAction(), [key]: Number($(id).value) });
    };
  }
  $("lcdcursorapply").onclick = () => {
    const action = cursorAction();
    const a = Number($("lcdcursora").value),
      b = Number($("lcdcursorb").value);
    if (action.mode === 2) {
      action.ya = Math.round(240 - a * 50);
      action.yb = Math.round(240 - b * 50);
    } else {
      action.xa = Math.round(a * 50);
      action.xb = Math.round(b * 50);
    }
    applyEdited(action, ["lcdcursora", "lcdcursorb"]);
  };
  $("lcdmathapply").onclick = () => {
    const range = Number($("lcdmathrange").value),
      probe = Number($("lcdmathprobe").value);
    const millivolts = Number(
      $("lcdmathrange").selectedOptions[0]?.dataset.millivolts,
    );
    if (Number($("lcdmathmode").value) === 3) {
      applyEdited(
        {
          op: "lcd_fft",
          source: Number($("lcdfftsource").value),
          window: Number($("lcdfftwindow").value),
          logarithmic: Number($("lcdfftunits").value),
          range,
          db_div: Number($("lcdfftdbdiv").value),
          reference_dbv: Number($("lcdfftreference").value),
        },
        [
          "lcdmathmode",
          "lcdmathrange",
          "lcdfftsource",
          "lcdfftwindow",
          "lcdfftunits",
          "lcdfftdbdiv",
          "lcdfftreference",
        ],
      );
      return;
    }
    applyEdited(
      {
        op: "lcd_math",
        mode: Number($("lcdmathmode").value),
        range,
        probe,
        position: Math.round(
          (Number($("lcdmathposition").value) * 1e6) / (millivolts * probe),
        ),
        reversed: Number($("lcdmathorder").value),
      },
      [
        "lcdmathmode",
        "lcdmathrange",
        "lcdmathprobe",
        "lcdmathposition",
        "lcdmathorder",
      ],
    );
  };
  $("lcdmathmode").addEventListener("change", () => {
    $("lcdfftcontrols").hidden = Number($("lcdmathmode").value) !== 3;
  });
  for (const id of [
    "lcdfftsource",
    "lcdfftwindow",
    "lcdfftunits",
    "lcdfftdbdiv",
    "lcdfftreference",
    "lcdcursora",
    "lcdcursorb",
    "lcdmathmode",
    "lcdmathrange",
    "lcdmathprobe",
    "lcdmathposition",
    "lcdmathorder",
  ])
    $(id).addEventListener("input", () => dirtyInputs.add(id));
  $("lcdcopycancel").onclick = () => {
    cancelCopy = true;
  };
  const snapshot = async (action) => {
    if (
      cancelCopy ||
      getState().session !== copySession ||
      !getState().connected
    )
      throw Error("LCD download cancelled");
    return (await sendControl({ op: "lcd_copy", ...action })).screenshot;
  };
  async function copyScreen(capture) {
    if (copying) return;
    copying = true;
    cancelCopy = false;
    copySession = getState().session;
    update(getState().settings?.lcd || {});
    $("lcdcopystatus").textContent = "Preparing LCD snapshot…";
    try {
      let status = await snapshot({ key: capture ? "capture" : "status" });
      const deadline = performance.now() + 10000;
      while (!status.ready) {
        if (!status.busy || performance.now() > deadline)
          throw Error(
            "No LCD snapshot available; capture one or press Copy on the scope",
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await snapshot({ key: "status" });
      }
      if (status.bytes !== 768000) throw Error("Unsupported LCD snapshot size");
      const pixels = new Uint8Array(status.bytes);
      let offset = 0;
      while (offset < pixels.length) {
        const chunk = await snapshot({ key: "read", id: status.id, offset });
        const bytes = Uint8Array.from(atob(chunk.data), (character) =>
          character.charCodeAt(0),
        );
        if (
          chunk.id !== status.id ||
          chunk.offset !== offset ||
          !bytes.length ||
          bytes.length > pixels.length - offset
        )
          throw Error("Invalid LCD download chunk");
        pixels.set(bytes, offset);
        offset += bytes.length;
        $("lcdcopystatus").textContent =
          `Downloading LCD screen · ${Math.round((offset * 100) / pixels.length)}%`;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      download(screenshotBitmap(pixels), `slopscope-lcd-${status.id}.bmp`);
      $("lcdcopystatus").textContent = "LCD screen downloaded";
    } catch (error) {
      $("lcdcopystatus").textContent = error.message;
      if (!cancelCopy) onError(error);
    } finally {
      copying = false;
      update(getState().settings?.lcd || {});
    }
  }
  $("lcdcopy").onclick = () => copyScreen(true);
  $("lcdcopylast").onclick = () => copyScreen(false);
  function update(lcd) {
    if (brightnessSession !== getState().session) {
      brightnessSession = getState().session;
      brightnessEditing = false;
      brightnessPending = null;
      dirtyInputs.delete("lcdbrightness");
    }
    const connected = getState().connected;
    $("lcdtheme").disabled ||= !lcd.theme;
    $("lcdbrightness").disabled ||= !lcd.brightness;
    if (lcd.theme) setValue("lcdtheme", lcd.theme);
    if (lcd.brightness && !brightnessEditing && brightnessPending === null) {
      $("lcdbrightness").value = Math.max(1, lcd.brightness.percent);
      $("lcdbrightnessvalue").textContent = `${$("lcdbrightness").value}%`;
    }
    const states = [
      "Idle",
      "Centering",
      "Scaling",
      "Finding edge",
      "Complete",
      "No clear signal",
      "No stable edge",
      "Unavailable",
      "Cancelled",
      "Checking signal",
      "Input clipped",
    ];
    $("lcdautosetstatus").textContent = lcd.autoset
      ? states[lcd.autoset.state] || "Working"
      : "Requires updated firmware";
    for (const id of ["lcdautoset", "lcdautosetcancel"])
      $(id).disabled ||= !lcd.autoset;
    const current = lcd.tools || {};
    const supported = current.cursor_xa !== undefined;
    for (const id of [
      "lcdcursor",
      "lcdcursorsource",
      "lcdcursorselected",
      "lcdcursora",
      "lcdcursorb",
      "lcdcursorapply",
      "lcdmathmode",
      "lcdmathrange",
      "lcdmathprobe",
      "lcdmathposition",
      "lcdmathorder",
      "lcdmathapply",
    ])
      $(id).disabled ||= !supported;
    if (supported) {
      setValue("lcdcursor", current.cursors);
      setValue("lcdcursorsource", current.source + 1);
      setValue("lcdcursorselected", current.cursor);
      const voltage = current.cursors === 2;
      $("lcdcursorunits").textContent = voltage
        ? "Positions: divisions above center"
        : "Positions: divisions from left";
      for (const [id, x, y] of [
        ["lcdcursora", current.cursor_xa, current.cursor_ya],
        ["lcdcursorb", current.cursor_xb, current.cursor_yb],
      ]) {
        $(id).min = voltage ? -3.98 : 0;
        $(id).max = voltage ? 4 : 14.98;
        setValue(id, voltage ? (240 - y) / 50 : x / 50);
      }
      for (const id of [
        "lcdfftsource",
        "lcdfftwindow",
        "lcdfftunits",
        "lcdfftdbdiv",
        "lcdfftreference",
      ])
        $(id).disabled = !connected || current.fft_window === undefined;
      setValue("lcdmathmode", current.math);
      $("lcdfftcontrols").hidden = Number($("lcdmathmode").value) !== 3;
      setValue("lcdfftsource", (current.fft_source ?? 0) + 1);
      setValue("lcdfftwindow", current.fft_window ?? 3);
      setValue("lcdfftunits", current.fft_logarithmic ?? 1);
      setValue("lcdfftdbdiv", current.fft_db_div ?? 10);
      setValue("lcdfftreference", current.fft_reference_dbv ?? 20);
      setValue("lcdmathrange", current.math_range);
      setValue("lcdmathprobe", current.math_probe);
      setValue("lcdmathorder", current.math_reversed);
      const scale =
        (Number(
          $("lcdmathrange").options[current.math_range]?.dataset.millivolts,
        ) *
          current.math_probe) /
        1000;
      setValue("lcdmathposition", (current.math_position * scale) / 1000);
    }
    for (const id of ["lcdcopy", "lcdcopylast"])
      $(id).disabled ||= copying || !lcd.tools;
    $("lcdcopycancel").disabled = !connected || !copying;
  }
  return { update };
}
