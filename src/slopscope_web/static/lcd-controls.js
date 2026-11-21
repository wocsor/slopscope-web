import { fields, signed32, crc32 } from "./webusb.js";

export function validateLcdAction(action) {
  const { op, value, key } = action;
  if (op === "lcd_theme" && ["DARK", "LIGHT"].includes(value)) return action;
  if (op === "lcd_autoset" && ["start", "cancel"].includes(key)) return action;
  const bounds = {
    lcd_fft: {
      source: [1, 2],
      window: [0, 5],
      logarithmic: [0, 1],
      range: [0, 13],
      db_div: [5, 20],
      reference_dbv: [-120, 120],
    },
    lcd_brightness: { value: [1, 100] },
    lcd_cursors: {
      mode: [0, 2],
      source: [1, 2],
      selected: [0, 1],
      xa: [0, 749],
      xb: [0, 749],
      ya: [40, 439],
      yb: [40, 439],
    },
    lcd_math: {
      mode: [0, 6],
      range: [0, 13],
      probe: [1, 1000],
      position: [-4000, 4000],
      reversed: [0, 1],
    },
  };
  if (bounds[op]) {
    for (const [name, [minimum, maximum]] of Object.entries(bounds[op])) {
      if (
        !Number.isInteger(action[name]) ||
        action[name] < minimum ||
        action[name] > maximum
      )
        throw Error(`Invalid ${op} ${name}`);
    }
    if (op === "lcd_math" && ![1, 10, 100, 1000].includes(action.probe))
      throw Error("Invalid LCD Math probe factor");
    return action;
  }
  if (op === "lcd_copy") {
    if (["capture", "status"].includes(key)) return action;
    if (
      key === "read" &&
      Number.isInteger(action.id) &&
      action.id >= 1 &&
      action.id <= 0xffffffff &&
      Number.isInteger(action.offset) &&
      action.offset >= 0 &&
      action.offset < 768000
    )
      return action;
  }
  throw Error("Invalid LCD control");
}

export function lcdCommand(action) {
  validateLcdAction(action);
  if (action.op === "lcd_theme") return `DISPLAY THEME ${action.value}`;
  if (action.op === "lcd_brightness")
    return `DISPLAY BRIGHTNESS ${action.value}`;
  if (action.op === "lcd_autoset") return `AUTOSET ${action.key.toUpperCase()}`;
  if (action.op === "lcd_fft")
    return `PANEL FFT ${["source", "window", "logarithmic", "range", "db_div", "reference_dbv"].map((name) => action[name]).join(" ")}`;
  const cursor = action.op === "lcd_cursors";
  const names = cursor
    ? ["mode", "source", "selected", "xa", "xb", "ya", "yb"]
    : ["mode", "range", "probe", "position", "reversed"];
  return `${cursor ? "PANEL CURSORS" : "PANEL MATH"} ${names.map((name) => action[name]).join(" ")}`;
}

export async function lcdSettings(client) {
  const result = {};
  for (const [key, command] of [
    ["theme", "DISPLAY THEME"],
    ["brightness", "DISPLAY BRIGHTNESS"],
    ["tools", "PANEL TOOLS"],
    ["autoset", "AUTOSET STATUS"],
  ]) {
    try {
      const reply = await client.request(command);
      result[key] = key === "theme" ? reply.split(" ").at(-1) : fields(reply);
    } catch (error) {
      if (!error.message.startsWith("ERR ")) throw error;
    }
  }
  if (result.tools)
    result.tools.math_position = signed32(result.tools.math_position || 0);
  if (result.tools)
    result.tools.fft_reference_dbv = signed32(
      result.tools.fft_reference_dbv || 0,
    );
  return result;
}

async function screenshotChunk(connection, id, offset) {
  await connection.write(`SCREENSHOT READ ${id} ${offset}`);
  let bytes = new Uint8Array();
  let count = null,
    checksum;
  const deadline = performance.now() + 5000;
  while (count === null || bytes.length < 32 + count) {
    if (performance.now() >= deadline)
      throw Error("LCD screenshot read timed out");
    const chunk = await connection.read(
      Math.max(1, deadline - performance.now()),
    );
    const joined = new Uint8Array(bytes.length + chunk.length);
    joined.set(bytes);
    joined.set(chunk, bytes.length);
    bytes = joined;
    if (
      bytes[0] === 69 &&
      bytes[1] === 82 &&
      bytes[2] === 82 &&
      bytes[3] === 32
    )
      throw Error(new TextDecoder().decode(bytes).trim());
    if (bytes.length >= 32 && count === null) {
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      count = header.getUint32(12, true);
      checksum = header.getUint32(28, true);
      if (
        header.getUint32(0, true) !== 0x31534353 ||
        header.getUint32(4, true) !== id ||
        header.getUint32(8, true) !== offset ||
        count !== Math.min(448, 768000 - offset) ||
        header.getUint32(16, true) !== 768000 ||
        header.getUint32(20, true) !== 800 ||
        header.getUint32(24, true) !== 480
      ) {
        connection.poisoned = true;
        throw Error("Invalid LCD screenshot header");
      }
    }
    if (bytes.length > 480) {
      connection.poisoned = true;
      throw Error("Oversized LCD screenshot chunk");
    }
  }
  new DataView(bytes.buffer).setUint32(28, 0, true);
  if (bytes.length !== 32 + count || crc32(bytes) !== checksum) {
    connection.poisoned = true;
    throw Error("LCD screenshot CRC or length mismatch");
  }
  return bytes.subarray(32);
}

export async function lcdCopy(client, action) {
  validateLcdAction(action);
  if (action.key === "capture") await client.request("SCREENSHOT CAPTURE");
  if (action.key !== "read") return client.status("SCREENSHOT STATUS");
  const pixels = new Uint8Array(Math.min(448 * 8, 768000 - action.offset));
  let count = 0;
  while (count < pixels.length) {
    const chunk = await screenshotChunk(
      client.connection,
      action.id,
      action.offset + count,
    );
    pixels.set(chunk, count);
    count += chunk.length;
  }
  return {
    id: action.id,
    offset: action.offset,
    data: btoa(String.fromCharCode(...pixels)),
  };
}

export function screenshotBitmap(pixels) {
  const header = new Uint8Array(66);
  const view = new DataView(header.buffer);
  header.set([66, 77]);
  for (const [offset, value] of [
    [2, 66 + pixels.length],
    [10, 66],
    [14, 40],
    [18, 800],
    [22, -480],
    [30, 3],
    [34, pixels.length],
    [54, 0xf800],
    [58, 0x07e0],
    [62, 0x001f],
  ])
    view.setInt32(offset, value, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 16, true);
  return new Blob([header, pixels], { type: "image/bmp" });
}

export function lcdProfileActions(lcd) {
  if (!lcd) return [];
  const actions = [];
  if (lcd.theme) actions.push({ op: "lcd_theme", value: lcd.theme });
  if (lcd.brightness)
    actions.push({
      op: "lcd_brightness",
      value: Math.max(1, lcd.brightness.percent),
    });
  const tools = lcd.tools;
  if (tools?.cursor_xa !== undefined) {
    actions.push({
      op: "lcd_cursors",
      mode: tools.cursors,
      source: tools.source + 1,
      selected: tools.cursor,
      xa: tools.cursor_xa,
      xb: tools.cursor_xb,
      ya: tools.cursor_ya,
      yb: tools.cursor_yb,
    });
    actions.push({
      op: "lcd_math",
      mode: tools.math,
      range: tools.math_range,
      probe: tools.math_probe,
      position: tools.math_position,
      reversed: tools.math_reversed,
    });
  }
  if (tools?.math === 3 && tools.fft_window !== undefined)
    actions.push({
      op: "lcd_fft",
      source: tools.fft_source + 1,
      window: tools.fft_window,
      logarithmic: tools.fft_logarithmic,
      range: tools.math_range,
      db_div: tools.fft_db_div,
      reference_dbv: tools.fft_reference_dbv,
    });
  return actions.map(validateLcdAction);
}
