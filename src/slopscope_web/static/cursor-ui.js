export function setupCursorControls({
  getState,
  getView,
  scaleVolts,
  setValue,
  control,
  isBusy,
  onError,
  redraw,
}) {
  const $ = (id) => document.getElementById(id);
  let pendingAction = null,
    sending = false,
    pendingSession;
  const tools = () => getState().settings?.lcd?.tools;
  const clamp = (value, minimum, maximum) =>
    Math.max(minimum, Math.min(maximum, Math.round(value)));

  function positions(current, mode, source) {
    const view = getView();
    if (mode === "time")
      return [current.cursor_xa, current.cursor_xb].map(
        (x) => view.start + (x * view.points) / 750,
      );
    const position =
      (getState().settings.channels[source].position_mdiv || 0) / 1000;
    return [current.cursor_ya, current.cursor_yb].map(
      (y) => ((240 - y) / 50 - position) * scaleVolts(source),
    );
  }

  function update() {
    const current = tools();
    const supported = getState().connected && current?.cursor_xa !== undefined;
    for (const id of ["cursormode", "cursora", "cursorb", "cursorchannel"])
      $(id).disabled = !supported || isBusy();
    if (!supported || sending || pendingAction) return;
    const mode = ["off", "time", "voltage"][current.cursors];
    setValue("cursormode", mode);
    setValue("cursorchannel", current.source);
    if (mode !== "off") {
      const values = positions(current, mode, current.source);
      for (let index = 0; index < 2; index++)
        setValue(
          index ? "cursorb" : "cursora",
          Number(values[index].toPrecision(7)),
        );
    }
    $("cursoralabel").textContent = mode === "voltage" ? "A · V" : "A · sample";
    $("cursorblabel").textContent = mode === "voltage" ? "B · V" : "B · sample";
    redraw();
  }

  async function sendPending() {
    if (sending) return;
    sending = true;
    try {
      while (pendingAction && getState().connected) {
        while (isBusy() && getState().connected)
          await new Promise((resolve) => setTimeout(resolve, 30));
        if (!getState().connected) break;
        if (pendingSession !== getState().session) {
          pendingAction = null;
          break;
        }
        const action = pendingAction;
        pendingAction = null;
        await control(action);
      }
    } catch (error) {
      pendingAction = null;
      onError(error);
    } finally {
      sending = false;
      if (!getState().connected) pendingAction = null;
      update();
    }
  }

  function commit(selected = 0) {
    const current = tools();
    if (!getState().connected || current?.cursor_xa === undefined) return;
    const mode = $("cursormode").value;
    const source = Number($("cursorchannel").value);
    const values = [Number($("cursora").value), Number($("cursorb").value)];
    if (!values.every(Number.isFinite)) return;
    const view = getView();
    const position =
      (getState().settings.channels[source].position_mdiv || 0) / 1000;
    const coordinates =
      mode === "voltage"
        ? values.map((value) =>
            clamp(240 - 50 * (value / scaleVolts(source) + position), 40, 439),
          )
        : values.map((value) =>
            clamp(((value - view.start) * 750) / view.points, 0, 749),
          );
    pendingAction = {
      op: "lcd_cursors",
      mode: ["off", "time", "voltage"].indexOf(mode),
      source: source + 1,
      selected,
      xa: mode === "time" ? coordinates[0] : current.cursor_xa,
      xb: mode === "time" ? coordinates[1] : current.cursor_xb,
      ya: mode === "voltage" ? coordinates[0] : current.cursor_ya,
      yb: mode === "voltage" ? coordinates[1] : current.cursor_yb,
    };
    pendingSession = getState().session;
    redraw();
    void sendPending();
  }

  for (const id of ["cursormode", "cursorchannel"])
    $(id).onchange = () => {
      const mode = $("cursormode").value;
      if (mode !== "off" && tools()) {
        const values = positions(
          tools(),
          mode,
          Number($("cursorchannel").value),
        );
        $("cursora").value = values[0];
        $("cursorb").value = values[1];
      }
      commit();
    };
  for (const [index, id] of ["cursora", "cursorb"].entries()) {
    $(id).onchange = () => commit(index);
    $(id).onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $(id).blur();
      }
    };
  }
  return {
    update,
    place(index, value) {
      $(index ? "cursorb" : "cursora").value = value;
      commit(index);
    },
  };
}
