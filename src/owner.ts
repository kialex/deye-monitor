import { DeyeClient } from "./deye";
import { type DeyeConfig, type Env } from "./env";
import type { GridDatabase } from "./grid-monitor";

export const SETUP_PATH = "/owner/deye";
const SETUP_TTL = 10 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface DeviceRow {
  device_sn: string;
  name: string;
  credentials: string;
}

interface Choice {
  stationId: number;
  deviceSn: string;
  name: string;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function key(env: Env) {
  const bytes = decode(env.DEYE_CREDENTIAL_KEY ?? "");
  if (bytes.length !== 32) throw new Error("Invalid encryption key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(env: Env, config: DeyeConfig): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), encoder.encode(JSON.stringify(config)));
  return encode(iv) + "." + encode(new Uint8Array(ciphertext));
}

export async function loadConfig(env: Env, row: DeviceRow): Promise<DeyeConfig> {
  const [iv, ciphertext] = row.credentials.split(".");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await key(env), decode(ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as DeyeConfig;
}

async function hash(token: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

export async function makeSetupLink(env: Env, origin: string): Promise<string> {
  const db = env.GRID_DB;
  if (!db) throw new Error("D1 unavailable");
  await key(env);
  const token = crypto.randomUUID() + crypto.randomUUID();
  await db.batch([
    db.prepare("DELETE FROM admin_setup WHERE expires_at < ?1").bind(Date.now()),
    db.prepare("INSERT INTO admin_setup (token_hash, expires_at) VALUES (?1, ?2)")
      .bind(await hash(token), Date.now() + SETUP_TTL),
  ]);
  return origin + SETUP_PATH + "#" + token;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deye Monitor</title><main><h1>Подключение Deye Cloud</h1>${body}</main></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const db = env.GRID_DB;
  if (!db || !env.ADMIN_TELEGRAM_USER_ID || !env.DEYE_CREDENTIAL_KEY) return new Response(null, { status: 404 });
  if (request.method === "GET") return page(`
    <form method="post">
      <input type="hidden" name="token" id="token">
      <p><label>App ID <input name="appId" required maxlength="100"></label></p>
      <p><label>App Secret <input name="appSecret" type="password" required maxlength="300"></label></p>
      <p><label>Email <input name="email" type="email" required maxlength="254"></label></p>
      <p><label>Пароль Deye <input name="password" type="password" required maxlength="300"></label></p>
      <button>Найти инверторы</button>
    </form>
    <script>document.getElementById("token").value = location.hash.slice(1); history.replaceState(null, "", location.pathname);</script>
  `);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  // The no-referrer policy can make the browser send Origin: null.
  // The one-time token still authenticates the submission.
  if ((origin && origin !== "null" && origin !== new URL(request.url).origin) ||
      fetchSite === "cross-site" || fetchSite === "same-site") {
    return page("Открой ссылку из личного чата с ботом и отправь форму с этой страницы.", 403);
  }

  try {
    const form = await request.formData();
    const field = (name: string) => String(form.get(name) ?? "");
    const token = field("token");
    if (!/^[a-f0-9-]{72}$/.test(token)) return page("Открой новую ссылку кнопкой «Добавить инвертор» в Telegram.", 403);
    const tokenHash = await hash(token);
    const setup = await db.prepare("SELECT credentials, choices FROM admin_setup WHERE token_hash = ?1 AND expires_at > ?2")
      .bind(tokenHash, Date.now()).first<{ credentials: string | null; choices: string | null }>();
    if (!setup) return page("Ссылка истекла. Запроси новую кнопкой «Добавить инвертор».", 403);

    if (field("device")) {
      const choices = JSON.parse(setup.choices ?? "[]") as Choice[];
      const choice = choices.find(item => item.deviceSn === field("device"));
      const name = field("name").trim() || choice?.name;
      if (!choice || !name || name.length > 120 || !setup.credentials) return page("Выбери инвертор и короткое название.", 400);
      const config = await loadConfig(env, { credentials: setup.credentials, device_sn: "", name: "" });
      const credentials = await encrypt(env, { ...config, stationId: choice.stationId, deviceSn: choice.deviceSn });
      const now = Date.now();
      const [saved] = await db.batch([
        db.prepare(`
          INSERT INTO monitored_devices (device_sn, name, credentials)
          SELECT ?1, ?2, ?3 FROM admin_setup WHERE token_hash = ?4 AND expires_at > ?5 AND credentials = ?6
          ON CONFLICT(device_sn) DO UPDATE SET name = excluded.name, credentials = excluded.credentials
          RETURNING device_sn
        `).bind(choice.deviceSn, name, credentials, tokenHash, now, setup.credentials),
        db.prepare("DELETE FROM admin_setup WHERE token_hash = ?1 AND credentials = ?2")
          .bind(tokenHash, setup.credentials),
      ]);
      if (!saved.results.length) return page("Ссылка больше не действует. Запроси новую кнопкой «Добавить инвертор».", 403);
      return page(`Инвертор подключён. Вернись в Telegram и открой список станций.`);
    }

    const config: DeyeConfig = {
      stationId: 0, deviceSn: "",
      appId: field("appId").trim(), appSecret: field("appSecret").trim(),
      email: field("email").trim(), password: field("password"),
    };
    if (!config.appId || !config.appSecret || !config.email || !config.password ||
        Object.values(config).some(value => typeof value === "string" && value.length > 300)) {
      return page("Заполни все поля. Для новой ссылки нажми «Добавить инвертор».", 400);
    }
    const stations = await new DeyeClient(config).listStationsWithDevices();
    const choices = stations.flatMap(station => (station.deviceListItems ?? [])
      .filter(device => device.deviceType === "INVERTER")
      .map(device => ({ stationId: station.id, deviceSn: device.deviceSn, name: station.name })));
    if (!choices.length) return page("Deye Cloud не вернул инверторы для этого аккаунта.", 400);
    await db.prepare("UPDATE admin_setup SET credentials = ?1, choices = ?2 WHERE token_hash = ?3 AND expires_at > ?4 RETURNING token_hash")
      .bind(await encrypt(env, config), JSON.stringify(choices), tokenHash, Date.now()).first();
    const options = choices.map(choice => `<option value="${escapeHtml(choice.deviceSn)}">${escapeHtml(choice.name)} · ${escapeHtml(choice.deviceSn)}</option>`).join("");
    return page(`<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}">
      <p><label>Инвертор <select name="device">${options}</select></label></p>
      <p><label>Название объекта <input name="name" maxlength="120"></label></p>
      <button>Подключить</button></form>`);
  } catch {
    return page("Не удалось завершить подключение. Проверь реквизиты Deye и запроси новую ссылку кнопкой «Добавить инвертор».", 400);
  }
}

export async function listDevices(db: GridDatabase): Promise<DeviceRow[]> {
  return (await db.prepare("SELECT device_sn, name, credentials FROM monitored_devices ORDER BY name").all<DeviceRow>()).results;
}

export function legacyDevice(env: Env): { device_sn: string; name: string } | undefined {
  return env.DEYE_DEVICE_SN ? { device_sn: env.DEYE_DEVICE_SN, name: "Текущая станция" } : undefined;
}
