export default {
  async fetch(): Promise<Response> {
    return Response.json({
      service: "deye-monitor",
      status: "ok",
    });
  },

  async scheduled(): Promise<void> {
    console.log("Минутная проверка запущена  OK", {
      time: new Date().toISOString(),
    });
  },
};
