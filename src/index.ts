interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      service: "deye-monitor",
      status: "ok",
    });
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      throw new Error("Telegram configuration is missing");
    }

    const time = new Date().toLocaleString("uk-UA", {
      timeZone: "Europe/Kyiv",
    });

    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `✅ Бот работает!\n🕒 ${time}`,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );

    const result = await response.json<{
      ok: boolean;
      error_code?: number;
    }>();

    if (!response.ok || !result.ok) {
      throw new Error(
        `Telegram send failed: ${result.error_code ?? response.status}`,
      );
    }

    console.log("Telegram message sent successfully");
  },
};