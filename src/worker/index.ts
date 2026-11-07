import { createApp } from "./app";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, _env, _ctx) {
    // Exchange-rate refresh is wired in by the FX service.
  },
} satisfies ExportedHandler<Env>;
