import { Plugin } from "@opencode/plugin"
import { registerPluginAssets } from "./assets.ts"
import { registerAgyProvider } from "./provider.ts"
import { registerAgyTool } from "./tool.ts"
import { PLUGIN_ID, parseConnectorConfig } from "./types.ts"

export { parseConnectorConfig, resolveProviderCliModel, AGY_MODEL_SPECS } from "./types.ts"
export type { AgyConnectorConfig, AgyModelSpec, AgyToolInput } from "./types.ts"

/** OpenCode v2 plugin entrypoint connecting native `agy/*` models, `/agy`, `@agy`, and the `agy` tool. */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = parseConnectorConfig(ctx.options)

    if (config.registerProvider) {
      await registerAgyProvider(ctx, config)
    }

    if (config.registerTool) {
      await registerAgyTool(ctx, config)
    }

    await registerPluginAssets(ctx, config)
  },
})
