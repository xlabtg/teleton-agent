/**
 * Bot tools — inline mode integration for plugins.
 */

import type { ToolEntry } from "../types.js";
import { botInlineSendTool, botInlineSendExecutor } from "./inline-send.js";

export const tools: ToolEntry[] = [
  {
    tool: botInlineSendTool,
    executor: botInlineSendExecutor,
    scope: "always",
  },
];
