import { DEYE_API } from "./constants";
import type { DeyeConfig } from "./env";
import { post } from "./http";

export interface Station {
  batterySOC?: number;
  dischargePower?: number;
  generationPower?: number;
  consumptionPower?: number;
  lastUpdateTime?: number | string;
}

export interface Device {
  collectionTime?: number;
  dataList?: { key: string; unit: string; value: string | number }[];
}

export interface DeyeFault {
  alertId: string;
  alertCode: number;
  alertName?: string;
  description?: string;
  alertStartTime: number;
  alertEndTime?: number;
}

export interface DeyeStationDevices {
  id: number;
  name: string;
  deviceListItems?: { deviceSn: string; deviceType: string }[];
}

export class DeyeClient {
  constructor(private readonly config: DeyeConfig) {}

  private async request<T>(path: string, body: object, token?: string): Promise<T> {
    const result = await post<T & { success: boolean }>(DEYE_API + path, body, token);
    if (!result.success) throw new Error("Deye Cloud rejected the request");
    return result;
  }

  private async getAccessToken() {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.config.password));
    const password = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const { accessToken } = await this.request<{ accessToken?: string }>(
      `/account/token?appId=${encodeURIComponent(this.config.appId)}`,
      { appSecret: this.config.appSecret, email: this.config.email, password },
    );
    const token = accessToken?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new Error("Deye Cloud did not return an access token");

    return token;
  }

  async getDeviceTelemetry(token?: string): Promise<Device | undefined> {
    const result = await this.request<{ deviceDataList?: Device[] }>(
      "/device/latest", { deviceList: [this.config.deviceSn] }, token ?? await this.getAccessToken(),
    );
    return result.deviceDataList?.[0];
  }

  async getBatterySettings() {
    const token = await this.getAccessToken();
    return this.request<{ battCapacity: number; battLowCapacity: number; battShutDownCapacity: number }>(
      "/config/battery", { deviceSn: this.config.deviceSn }, token,
    );
  }

  async listStationsWithDevices() {
    const token = await this.getAccessToken();
    const stations: DeyeStationDevices[] = [];
    const size = 20;
    for (let page = 1; ; page++) {
      const result = await this.request<{ stationList?: DeyeStationDevices[]; total?: number }>(
        "/station/listWithDevice", { page, size }, token,
      );
      const entries = result.stationList ?? [];
      stations.push(...entries);
      if (entries.length < size || (result.total !== undefined && stations.length >= result.total)) return stations;
      if (page === 50) throw new Error("Deye station list too large");
    }
  }

  async getFaults(startTimestamp: number, endTimestamp: number): Promise<DeyeFault[]> {
    const token = await this.getAccessToken();
    const faults: DeyeFault[] = [];
    const size = 100;
    for (let page = 1; ; page++) {
      const result = await this.request<{ alertList?: DeyeFault[]; total?: number }>(
        "/device/alertList", { deviceSn: this.config.deviceSn, startTimestamp, endTimestamp, page, size }, token,
      );
      const entries = result.alertList ?? [];
      faults.push(...entries);
      if (entries.length < size || (result.total !== undefined && faults.length >= result.total)) return faults;
      if (page === 20) throw new Error("Deye fault list too large");
    }
  }

  async getTelemetry() {
    const token = await this.getAccessToken();
    const [stationResult, deviceResult] = await Promise.allSettled([
      this.request<Station>("/station/latest", { stationId: this.config.stationId }, token),
      this.getDeviceTelemetry(token),
    ]);
    const station = stationResult.status === "fulfilled" ? stationResult.value : undefined;
    const device = deviceResult.status === "fulfilled" ? deviceResult.value : undefined;
    if (!station && !device) throw new Error("Deye Cloud telemetry unavailable");
    return { station, device };
  }
}
