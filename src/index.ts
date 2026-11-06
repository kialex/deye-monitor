import { TELEGRAM_WEBHOOK_PATH } from "./constants";
import type { Env } from "./env";
import { monitorGrid } from "./grid-monitor";
import { handleTelegramWebhook } from "./telegram";

export default {
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await monitorGrid(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/" && request.method === "GET") {
      return Response.json({ service: "deye-monitor", status: "ok" });
    }
    if (path === TELEGRAM_WEBHOOK_PATH) return handleTelegramWebhook(request, env);
    return new Response(null, { status: 404 });
  },
};
