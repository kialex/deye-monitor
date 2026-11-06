import type { GridDatabase } from "./grid-monitor";

export interface Env {
  GRID_DB?: GridDatabase;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  DEYE_APP_ID: string;
  DEYE_APP_SECRET: string;
  DEYE_EMAIL: string;
  DEYE_PASSWORD: string;
  DEYE_STATION_ID: string;
  DEYE_DEVICE_SN: string;
}

export function readDeyeConfig(env: Env) {
  const stationId = Number(env.DEYE_STATION_ID);
  if (!Number.isSafeInteger(stationId) || stationId <= 0 || !env.DEYE_DEVICE_SN ||
      !env.DEYE_APP_ID || !env.DEYE_APP_SECRET || !env.DEYE_EMAIL || !env.DEYE_PASSWORD) {
    throw new Error("Deye Cloud configuration is missing or invalid");
  }

  return {
    stationId,
    deviceSn: env.DEYE_DEVICE_SN,
    appId: env.DEYE_APP_ID,
    appSecret: env.DEYE_APP_SECRET,
    email: env.DEYE_EMAIL,
    password: env.DEYE_PASSWORD,
  };
}

export type DeyeConfig = ReturnType<typeof readDeyeConfig>;
