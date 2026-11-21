export const VENDOR_ID = 0xdeaf;
export const PRODUCT_ID = 0xbabe;
export const SCALES_MV = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000,
];
export const RATES = [
  0, 5e8, 2.5e8, 1e8, 5e7, 2.5e7, 1e7, 5e6, 2.5e6, 1e6, 5e5, 2.5e5, 1e5, 5e4,
  2.5e4, 1e4, 5e3, 2.5e3, 1e3, 500, 250, 100, 50, 25, 10, 5, 2.5, 1, 0.5, 0.25,
  0.1, 0.05,
];
export const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
export const signed32 = (value) => value | 0;

export function fields(reply) {
  return Object.fromEntries(
    [...reply.matchAll(/(\w+)=([0-9A-F]{8})(?=\s|$)/g)].map((match) => [
      match[1],
      parseInt(match[2], 16),
    ]),
  );
}

export function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++)
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return ~checksum >>> 0;
}

export function calibrationIdentity(calibration) {
  const data = new DataView(new ArrayBuffer(28));
  ["zero", "gain", "dac", "slope", "valid", "adc_scale", "adc_trim"].forEach(
    (key, index) => data.setUint32(index * 4, calibration[key], true),
  );
  return crc32(new Uint8Array(data.buffer));
}

function wordsOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from(
    { length: Math.min(32, bytes.byteLength / 4) },
    (_, index) => view.getUint32(index * 4, true),
  );
}

export function decodeFrame(bytes) {
  const words = wordsOf(bytes);
  if (
    words[0] !== 0x31435348 ||
    words[1] !== 7 ||
    words[2] !== 128 ||
    words[3] !== 3996 ||
    bytes.length !== 4124
  )
    throw Error("Unsupported waveform header; WebUSB requires FRAME7");
  const payload = bytes.slice(128);
  if (crc32(payload) !== words[15]) throw Error("Waveform CRC mismatch");
  if (
    words[8] >= 14 ||
    words[9] >= 14 ||
    words[10] > 1 ||
    words[11] > 1 ||
    words[14] < 1 ||
    words[14] > 31 ||
    !words[28] ||
    !words[29]
  )
    throw Error("Invalid waveform settings");
  const keys = [
    "magic",
    "version",
    "header_bytes",
    "payload_bytes",
    "sequence",
    "nominal_hz",
    "ticks_24mhz",
    "csi_flags",
    "ch1_range",
    "ch2_range",
    "ch1_coupling",
    "ch2_coupling",
    "normal_adc",
    "offsets_packed",
    "rate_index",
    "crc32",
    "acquire_mode",
    "device_averages",
    "bandwidth_bits",
    "trigger_family",
    "horizontal_ns",
    "forced",
    "trigger_mode",
    "capture_epoch",
  ];
  const metadata = Object.fromEntries(
    keys.map((key, index) => [key, words[index]]),
  );
  const flags = words[24];
  if (
    !(flags & 128) ||
    ![1, 2].includes((flags >> 4) & 7) ||
    words[25] > 1998 ||
    words[26] > 1998 - words[25] ||
    metadata.acquire_mode > 2 ||
    metadata.trigger_family > 1 ||
    metadata.trigger_mode > 7
  )
    throw Error("Invalid waveform metadata");
  Object.assign(metadata, {
    horizontal_ns: signed32(metadata.horizontal_ns),
    channel_alignment_samples: (flags >> 4) & 7,
    pulse_sampled: !!(flags & 1),
    roll: !!(flags & 2),
    filling: !!(flags & 4),
    preview: !!(flags & 8),
    valid_from: words[25],
    valid_count: words[26],
    snapshot_ticks: words[27],
    rate_numerator: words[28],
    rate_denominator: words[29],
    nominal_hz: words[28] / words[29],
    calibration_ids: words.slice(30, 32),
    samples_per_channel: 1998,
  });
  const samples = new Int8Array(
    payload.buffer,
    payload.byteOffset,
    payload.length,
  );
  return {
    metadata,
    channels: [
      Array.from(samples.slice(0, 1998)),
      Array.from(samples.slice(1998)),
    ],
  };
}

export class USBConnection {
  constructor() {
    this.device = null;
    this.poisoned = false;
    this.sessionSupported = false;
  }

  async connect(serialNumber = null) {
    if (!globalThis.isSecureContext || !navigator.usb)
      throw Error(
        "Direct USB requires a WebUSB browser (Chrome or Edge) on HTTPS or localhost. The Python bridge is available for other browsers.",
      );
    const authorizedDevices = (await navigator.usb.getDevices()).filter(
      (device) =>
        device.vendorId === VENDOR_ID && device.productId === PRODUCT_ID,
    );
    const selected = serialNumber
      ? authorizedDevices.filter(
          (device) => device.serialNumber === serialNumber,
        )
      : authorizedDevices;
    if (selected.length > 1 && serialNumber)
      throw Error("Duplicate USB serial; update the scopes' firmware");
    this.device =
      selected.length === 1
        ? selected[0]
        : await navigator.usb.requestDevice({
            filters: [
              {
                vendorId: VENDOR_ID,
                productId: PRODUCT_ID,
                ...(serialNumber ? { serialNumber } : {}),
              },
            ],
          });
    try {
      await this.device.open();
      if (this.device.configuration?.configurationValue !== 1)
        await this.device.selectConfiguration(1);
      await this.device.claimInterface(0);
      this.poisoned = false;
      const marker = `WEBUSB_SYNC_${Date.now()}`;
      if ((await this.request(`ECHO ${marker}`)) !== marker)
        throw Error("Scope synchronization failed");
      const frameVersion = fields(await this.request("CAPABILITIES")).frame;
      if (!Number.isInteger(frameVersion) || frameVersion < 7)
        throw Error(
          "Update SlopScope for FRAME7 support, or use the Python bridge",
        );
      try {
        await this.request("SESSION OPEN");
        this.sessionSupported = true;
      } catch (error) {
        if (error.message !== "ERR unknown command") throw error;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async bounded(operation, timeout = 5000) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.poisoned = true;
            this.device?.close().catch(() => {});
            reject(
              Error(
                "USB reply timed out. Reconnect USB; the failed command was not replayed.",
              ),
            );
          }, timeout);
        }),
      ]);
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async write(command) {
    if (!this.device?.opened || this.poisoned)
      throw Error("USB is disconnected; choose Connect USB");
    if (!command || command.length > 128 || /[^\x20-\x7e]/.test(command))
      throw Error("Invalid scope command");
    const result = await this.bounded(
      this.device.transferOut(1, new TextEncoder().encode(command + "\n")),
    );
    if (result.status !== "ok") {
      this.poisoned = true;
      throw Error(`USB write ${result.status}; reconnect before continuing`);
    }
  }

  async read(timeout = 5000) {
    const result = await this.bounded(
      this.device.transferIn(1, 16384),
      timeout,
    );
    if (result.status !== "ok") {
      this.poisoned = true;
      throw Error(`USB read ${result.status}; reconnect before continuing`);
    }
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
  }

  async request(command) {
    const deadline = performance.now() + 5000;
    await this.write(command);
    let reply = "";
    while (!reply.endsWith("\n")) {
      reply += new TextDecoder().decode(
        await this.read(Math.max(1, deadline - performance.now())),
      );
      if (reply.length > 4096) throw Error("Oversized scope reply");
    }
    reply = reply.trimEnd();
    if (reply.startsWith("ERR ")) throw Error(reply);
    return reply;
  }

  async binary(command) {
    const deadline = performance.now() + 5000;
    await this.write(command);
    let bytes = new Uint8Array();
    let expected = 64;
    while (bytes.length < expected) {
      const chunk = await this.read(Math.max(1, deadline - performance.now()));
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
      if (bytes.length >= 64) {
        const words = wordsOf(bytes);
        if (
          ![0x31435348, 0x31525348].includes(words[0]) ||
          words[2] < 64 ||
          words[2] > 128 ||
          words[3] > 10000
        )
          throw Error("Invalid binary header");
        expected = words[2] + words[3];
      }
      if (bytes.length > 10128) throw Error("Oversized binary reply");
    }
    if (bytes.length !== expected) throw Error("Binary reply length mismatch");
    return bytes;
  }

  async close() {
    const device = this.device;
    if (device?.opened && this.sessionSupported && !this.poisoned) {
      this.sessionSupported = false;
      try {
        await this.request("SESSION CLOSE");
      } catch (_) {
        /* A failed connection expires its lease without another write. */
      }
    }
    this.sessionSupported = false;
    this.poisoned = true;
    this.device = null;
    if (device?.opened) {
      try {
        await device.releaseInterface(0);
      } catch (_) {
        /* An unplugged device has no interface to release. */
      }
      await device.close().catch(() => {});
    }
  }
}
