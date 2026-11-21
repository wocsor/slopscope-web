export function setupScopePicker({
  usingBridge,
  getState,
  getController,
  isBusy,
  onError,
}) {
  const picker = document.getElementById("scopepicker");
  const refreshButton = document.getElementById("scoperefresh");
  let switching = false,
    refreshing = false;

  async function refresh() {
    if (refreshing || switching) return;
    refreshing = true;
    try {
      let devices, selected;
      if (usingBridge) {
        const response = await fetch("./devices");
        const result = await response.json();
        if (!response.ok) throw Error(result.error || "Cannot list scopes");
        devices = result.devices;
        selected = result.selected;
      } else {
        devices = navigator.usb
          ? (await navigator.usb.getDevices())
              .filter(
                (device) =>
                  device.vendorId === 0xdeaf && device.productId === 0xbabe,
              )
              .map((device) => ({ serial_number: device.serialNumber }))
          : [];
        selected = getState().connected
          ? getState().serial_number
          : picker.value;
      }
      const signature = JSON.stringify([devices, selected]);
      picker.disabled = switching || isBusy() || devices.length === 0;
      if (picker.dataset.devices === signature) return;
      picker.dataset.devices = signature;
      const options = [
        new Option(
          devices.length ? "Select a scope…" : "No scopes detected",
          "",
        ),
      ];
      for (const device of devices) {
        const serial = device.serial_number;
        const duplicate =
          devices.filter((other) => other.serial_number === serial).length > 1;
        const option = new Option(
          serial || "Cannot read USB serial",
          serial || "",
        );
        option.disabled = !serial || duplicate;
        if (duplicate)
          option.textContent += " · duplicate serial, update firmware";
        options.push(option);
      }
      picker.replaceChildren(...options);
      picker.value =
        selected ||
        (!usingBridge && devices.length === 1 ? devices[0].serial_number : "");
      picker.title = picker.value || "Choose a scope by USB serial number";
      picker.disabled = switching || isBusy() || devices.length === 0;
    } catch (error) {
      onError(error);
    } finally {
      refreshing = false;
    }
  }

  picker.onchange = async () => {
    if (!picker.value || switching) return;
    if (isBusy()) {
      onError(
        Error("Finish the current control change before switching scopes"),
      );
      return;
    }
    switching = true;
    picker.disabled = refreshButton.disabled = true;
    try {
      if (usingBridge) {
        const response = await fetch("./device", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serial_number: picker.value }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || "Cannot select scope");
        location.reload();
      } else {
        const controller = getController();
        await controller.disconnect();
        await controller.connect(picker.value);
      }
    } catch (error) {
      onError(error);
    } finally {
      switching = false;
      refreshButton.disabled = false;
      await refresh();
    }
  };
  refreshButton.onclick = async () => {
    try {
      if (!usingBridge && navigator.usb)
        await navigator.usb.requestDevice({
          filters: [{ vendorId: 0xdeaf, productId: 0xbabe }],
        });
      await refresh();
    } catch (error) {
      if (error.name !== "NotFoundError") onError(error);
    }
  };
  if (!usingBridge) refreshButton.textContent = "Add scope";
  void refresh();
  setInterval(refresh, 3000);
  if (navigator.usb) {
    navigator.usb.addEventListener("connect", refresh);
    navigator.usb.addEventListener("disconnect", refresh);
  }
  return { refresh, selected: () => picker.value || null };
}
