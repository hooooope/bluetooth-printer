import tsc from "@/utils/tsc";

// ERROR_MESSAGE
const ALREADY_OPEN_MSG = "openBluetoothAdapter:fail already opened";
const ALREADY_DISCOVERING_MSG =
  "startBluetoothDevicesDiscovery:fail already discovering devices";

// ERROR_CODE
const NO_CONNECTION_CODE = 10006;

// TIPS_MESSAGE
const NO_BATTERY_SERVICE = "no battery service";
const NO_WRITABLE_CHARACTERISTIC = "no writable characteristic";
const PRINT_OVER = "print over";

// MTU RANGE
const MIN_MTU = 23;
const MAX_MTU = 511;

// services uuid
const BatteryServiceUUID = "180F";

// characteristics uuid
const DeviceNameUUID = "2A00";
const AppearanceUUID = "2A01";
const BatteryInformationUUID = "2A19";

// 128bit uuid -> 16bit uuid
function uuid128to16(uuid) {
  return uuid.slice(4, 8);
}

// arraybuffer -> hex string
function ab2hex(buffer) {
  const hexArr = new Uint8Array(buffer).map((byte) => {
    return ("00" + byte.toString(16)).slice(-2);
  });
  return hexArr.join("");
}

Page({
  data: {
    devices: [],
    deviceId: "",
    searching: false,
  },

  onUnload() {
    this.stopSearch();
    wx.closeBluetoothAdapter();
  },

  showLoading(title) {
    wx.showLoading({
      title,
      mask: true,
    });
  },

  showModal(content) {
    wx.showModal({
      title: "Tips",
      content,
      showCancel: false,
    });
  },

  async toggleSearch() {
    try {
      if (!this.data.searching) {
        await this.startSearch();
      } else {
        await this.stopSearch();
      }
    } catch (e) {
      this.showModal(e.errMsg);
    }
  },

  async startSearch() {
    this.setData({
      searching: true,
    });
    const errorHandler = (e) => {
      if (
        e.errMsg !== ALREADY_OPEN_MSG &&
        e.errMsg !== ALREADY_DISCOVERING_MSG
      ) {
        this.setData({
          searching: false,
        });
        return Promise.reject(e);
      }
    };
    await wx.openBluetoothAdapter().catch(errorHandler);
    await wx
      .startBluetoothDevicesDiscovery({
        // services: [BatteryServiceUUID],
        // iOS 设备上扫描获取到的 deviceId 是系统根据外围设备 MAC 地址及发现设备的时间生成的 UUID
        // allowDuplicatesKey: true,
      })
      .catch(errorHandler);
    wx.onBluetoothDeviceFound(this.onBluetoothDeviceFound);
  },

  onBluetoothDeviceFound(res) {
    const { devices } = this.data;
    const { devices: newDevices } = res;
    for (const newDevice of newDevices) {
      if (
        !newDevice.connectable ||
        !newDevice.name ||
        newDevice.name.startsWith("未知或不支持的设备")
      ) {
        continue;
      }
      const index = devices.findIndex(
        (device) => device.deviceId === newDevice.deviceId
      );
      if (index === -1) {
        devices.unshift(newDevice);
      } else {
        devices[index] = newDevice;
      }
    }
    this.setData({
      devices,
    });
  },

  async stopSearch() {
    this.setData({
      searching: false,
    });
    try {
      wx.offBluetoothDeviceFound();
      await wx.stopBluetoothDevicesDiscovery();
    } catch (e) {
      this.setData({
        searching: true,
      });
      return Promise.reject(e);
    }
  },

  async handleConnect(e) {
    const { deviceId } = e.mark;
    if (deviceId === this.data.deviceId) {
      return;
    }
    if (this.data.deviceId) {
      try {
        await wx.closeBLEConnection({
          deviceId: this.data.deviceId,
        });
      } catch (e) {
        if (e.errCode !== NO_CONNECTION_CODE) {
          return Promise.reject(e);
        }
      }
      this.setData({
        deviceId: "",
      });
    }
    this.showLoading("connecting...");
    try {
      await wx
        .createBLEConnection({
          deviceId,
        })
        .finally(() => {
          wx.hideLoading();
        });
      this.setData({
        deviceId,
      });
      await this.stopSearch();
    } catch (e) {
      this.showModal(e.errMsg);
    }
  },

  async readBatteryInfo() {
    this.showLoading("reading...");
    const { deviceId } = this.data;
    let content = "";
    try {
      const res = await this.findBatteryCharacteric(deviceId);
      if (res) {
        const { serviceId, characteristicId } = res;
        console.log(deviceId);
        await wx.notifyBLECharacteristicValueChange({
          state: true, // enable notify
          deviceId,
          serviceId,
          characteristicId,
        });
        const { value } = await this.onBLECharacteristicValueChange();
        content = `${ab2hex(value)}%`;
      } else {
        content = NO_BATTERY_SERVICE;
      }
    } catch (e) {
      content = e.errMsg;
    }
    wx.hideLoading();
    this.showModal(content);
  },

  async findBatteryCharacteric(deviceId) {
    const { services } = await wx.getBLEDeviceServices({
      deviceId,
    });
    for (const service of services) {
      const { uuid: serviceId } = service;
      if (uuid128to16(serviceId) !== BatteryServiceUUID) {
        continue;
      }
      const { characteristics } = await wx.getBLEDeviceCharacteristics({
        deviceId,
        serviceId,
      });
      for (const characteristic of characteristics) {
        const { uuid: characteristicId, properties } = characteristic;
        if (
          uuid128to16(characteristicId) === BatteryInformationUUID &&
          properties.read
        ) {
          return {
            deviceId,
            serviceId,
            characteristicId,
          };
        }
      }
    }
    return null;
  },

  onBLECharacteristicValueChange() {
    return new Promise((resolve) => {
      wx.onBLECharacteristicValueChange((res) => {
        resolve(res);
      });
    });
  },

  async handlePrint() {
    this.showLoading("printing...");
    const { deviceId } = this.data;
    let content = "";
    try {
      const mtu = await this.consultMTU(deviceId);
      const value = this.generatePrintDirective();
      const res = await this.findWritableCharacteristic(deviceId);
      if (!res) {
        wx.hideLoading();
        this.showModal(NO_WRITABLE_CHARACTERISTIC);
        return;
      }
      const { serviceId, characteristicId } = res;
      await this.writeBLECharacteristicValue({
        mtu,
        value,
        deviceId,
        serviceId,
        characteristicId,
      });
      content = PRINT_OVER;
    } catch (e) {
      content = e.errMsg;
    }
    wx.hideLoading();
    this.showModal(content);
  },

  /**
   * @returns {number} 最大传输单元。设置范围为(22,512)区间内，单位bytes
   */
  async consultMTU(deviceId, start = MIN_MTU, end = MAX_MTU, mtu = MIN_MTU) {
    if (start > end) {
      return mtu;
    }
    const middle = start + ((end - start) >> 1);
    try {
      await wx.setBLEMTU({
        deviceId,
        mtu: middle,
      });
      return this.consultMTU(deviceId, middle + 1, end, middle);
    } catch (e) {
      return this.consultMTU(deviceId, start, middle - 1, mtu);
    }
  },

  /**
   * Prepare the print directive you want here
   * @returns {ArrayBuffer}
   */
  generatePrintDirective() {
    const command = tsc.jpPrinter.createNew();
    command.setCls();
    // mock data
    for (let i = 0; i < 10; i++) {
      command.setText(150, 20, "TSS24.BF2", 0, 2, 2, "hope");
    }
    command.setPagePrint();
    const data = command.getData();
    const n = data.length;
    const buffer = new ArrayBuffer(n);
    const uint8 = new Uint8Array(buffer);
    for (let i = 0; i < n; i++) {
      uint8[i] = data[i];
    }
    return buffer;
  },

  async findWritableCharacteristic(deviceId) {
    const { services } = await wx.getBLEDeviceServices({
      deviceId,
    });
    for (const service of services) {
      const { uuid: serviceId } = service;
      const { characteristics } = await wx.getBLEDeviceCharacteristics({
        deviceId,
        serviceId,
      });
      for (const characteristic of characteristics) {
        const { uuid: characteristicId, properties } = characteristic;
        if (properties.write) {
          return {
            deviceId,
            serviceId,
            characteristicId,
          };
        }
      }
    }
    return null;
  },

  async writeBLECharacteristicValue({
    mtu,
    value,
    deviceId,
    serviceId,
    characteristicId,
  }) {
    for (let i = 0; i < Math.ceil(value.byteLength / mtu); i++) {
      await wx.writeBLECharacteristicValue({
        deviceId,
        serviceId,
        characteristicId,
        value: value.slice(i * mtu, (i + 1) * mtu),
      });
    }
  },
});
