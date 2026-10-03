import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // React Compiler rules that eslint-config-next 16 newly enables. Existing code
    // predates them; keep them visible as warnings until it is migrated.
    rules: {
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  {
    ignores: [".next/**", ".open-next/**", ".wrangler/**", "out/**", "build/**", "next-env.d.ts", "worker-configuration.d.ts"],
  },
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/prisma",
              message: "Access the database through @/lib/db functions instead of importing @/prisma directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/lib/db/**",
      "src/lib/better-auth.ts",
      "src/lib/store-utils.ts",
      "src/lib/api/packages-db.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;
