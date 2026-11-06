import { DEYE_API } from "./constants";
import type { DeyeConfig } from "./env";
import { post } from "./http";

export interface Station {
  batterySOC?: number;
  generationPower?: number;
  consumptionPower?: number;
  lastUpdateTime?: number | string;
}

export interface Device {
  collectionTime?: number;
  dataList?: { key: string; unit: string; value: string | number }[];
}

async function deye<T>(path: string, body: object, token?: string): Promise<T> {
  const result = await post<T & { success: boolean }>(DEYE_API + path, body, token);
  if (!result.success) throw new Error("Deye Cloud rejected the request");
  return result;
}

export class DeyeClient {
  constructor(private readonly config: DeyeConfig) {}

  async getTelemetry() {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.config.password));
    const password = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const { accessToken } = await deye<{ accessToken?: string }>(
      `/account/token?appId=${encodeURIComponent(this.config.appId)}`,
      { appSecret: this.config.appSecret, email: this.config.email, password },
    );
    const token = accessToken?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new Error("Deye Cloud did not return an access token");

    const [stationResult, deviceResult] = await Promise.allSettled([
      deye<Station>("/station/latest", { stationId: this.config.stationId }, token),
      deye<{ deviceDataList?: Device[] }>("/device/latest", { deviceList: [this.config.deviceSn] }, token),
    ]);
    const station = stationResult.status === "fulfilled" ? stationResult.value : undefined;
    const device = deviceResult.status === "fulfilled" ? deviceResult.value.deviceDataList?.[0] : undefined;
    if (!station && !device) throw new Error("Deye Cloud telemetry unavailable");
    return { station, device };
  }
}
