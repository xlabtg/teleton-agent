import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const sharedRules = {
  // TypeScript rules
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
  "@typescript-eslint/explicit-function-return-type": "off",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/consistent-type-imports": "error",
  "@typescript-eslint/no-misused-promises": "error",

  // General rules
  "no-console": "off",
  "prefer-const": "error",
  "no-var": "error",
};

export default [
  {
    ignores: ["node_modules/**", "dist/**", ".reference/**", "docker/**"],
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/__tests__/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: sharedRules,
  },
  {
    files: ["packages/sdk/src/**/*.ts"],
    ignores: ["packages/sdk/src/**/__tests__/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: sharedRules,
  },
  {
    files: [
      "src/**/__tests__/**/*.test.ts",
      "packages/sdk/src/**/__tests__/**/*.test.ts",
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: ["./tsconfig.test.json"],
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...sharedRules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
];
