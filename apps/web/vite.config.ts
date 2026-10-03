import { defineConfig, type Plugin } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

// @vitejs/plugin-rsc puts "node" ahead of the "workerd" condition the Cloudflare
// plugin adds to the rsc environment. Packages that list "node" first in their
// exports map then resolve to their Node.js build inside workerd: Prisma's Node
// entry compiles its query compiler from bytes, which Workers forbid. Resolve
// the rsc environment like the ssr one, which never lists "node".
function workerdServerConditions(): Plugin {
  return {
    name: "beutl:workerd-server-conditions",
    enforce: "post",
    configEnvironment(name, config) {
      if (name !== "rsc" || !config.resolve?.conditions) return;
      config.resolve.conditions = config.resolve.conditions.filter(
        (condition) => condition !== "node",
      );
    },
  };
}

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
    workerdServerConditions(),
  ],
});
