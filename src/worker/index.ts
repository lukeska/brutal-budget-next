import { createApp } from "./app";
import { runFxCron } from "./fx/cron";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runFxCron(env.DB, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
