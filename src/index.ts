import { TELEGRAM_WEBHOOK_PATH } from "./constants";
import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/" && request.method === "GET") {
      return Response.json({ service: "deye-monitor", status: "ok" });
    }
    if (path === TELEGRAM_WEBHOOK_PATH) return handleTelegramWebhook(request, env);
    return new Response(null, { status: 404 });
  },
};
