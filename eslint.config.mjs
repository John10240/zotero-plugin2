// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  ignores: [
    // Debug and helper scripts that run in Zotero environment
    "check-plugin.js",
    "debug-load.js",
    "manual-load.js",
  ],
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
  ],
});
