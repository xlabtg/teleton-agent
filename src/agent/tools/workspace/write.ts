// src/agent/tools/workspace/write.ts

import { Type } from "@sinclair/typebox";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { MAX_WRITE_SIZE } from "../../../constants/limits.js";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import {
  validateWritePath,
  safeWriteFileSync,
  WorkspaceSecurityError,
} from "../../../workspace/index.js";
import { getErrorMessage } from "../../../utils/errors.js";

interface WorkspaceWriteParams {
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
  append?: boolean;
  createDirs?: boolean;
}

export const workspaceWriteTool: Tool = {
  name: "workspace_write",
  description:
    "Write a file to workspace. Only ~/.teleton/workspace/ is writable. Cannot write to protected locations.",

  parameters: Type.Object({
    path: Type.String({
      description: "Path to file (relative to workspace root)",
    }),
    content: Type.String({
      description: "Content to write",
    }),
    encoding: Type.Optional(
      Type.String({
        description: "Content encoding: 'utf-8' (default) or 'base64'",
        enum: ["utf-8", "base64"],
      })
    ),
    append: Type.Optional(
      Type.Boolean({
        description: "Append to file instead of overwriting (default: false)",
      })
    ),
    createDirs: Type.Optional(
      Type.Boolean({
        description: "Create parent directories if they don't exist (default: true)",
      })
    ),
  }),
};

export const workspaceWriteExecutor: ToolExecutor<WorkspaceWriteParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { path, content, encoding = "utf-8", append = false, createDirs = true } = params;

    // Validate the path (no extension enforcement - fix from audit)
    const validated = validateWritePath(path);

    // Create parent directories if needed
    const parentDir = dirname(validated.absolutePath);
    if (createDirs && !existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Prepare content
    let writeContent: string | Buffer;
    if (encoding === "base64") {
      writeContent = Buffer.from(content, "base64");
    } else {
      writeContent = content;
    }

    // SECURITY: Enforce file size limits to prevent DoS attacks
    const contentSize = Buffer.byteLength(writeContent);
    if (contentSize > MAX_WRITE_SIZE) {
      return {
        success: false,
        error: `File too large: ${contentSize} bytes exceeds maximum write size of ${MAX_WRITE_SIZE} bytes (50 MB)`,
      };
    }

    // Write or append.
    // For overwrite writes, use safeWriteFileSync (O_NOFOLLOW) to prevent a
    // symlink-swap race between validation and the actual write.
    if (append && validated.exists) {
      appendFileSync(validated.absolutePath, writeContent, { mode: 0o600 });
    } else if (typeof writeContent === "string") {
      safeWriteFileSync(validated.absolutePath, writeContent);
    } else {
      // Binary (base64-decoded Buffer): O_NOFOLLOW via openSync + writeSync
      const { openSync, writeSync, closeSync, constants } = await import("fs");
      const flags =
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
      const fd = openSync(validated.absolutePath, flags, 0o600);
      try {
        writeSync(fd, writeContent);
      } finally {
        closeSync(fd);
      }
    }

    return {
      success: true,
      data: {
        path: validated.relativePath,
        absolutePath: validated.absolutePath,
        size: Buffer.byteLength(writeContent),
        append,
        message: `File ${append ? "appended" : "written"} successfully`,
      },
    };
  } catch (error) {
    if (error instanceof WorkspaceSecurityError) {
      return {
        success: false,
        error: error.message,
      };
    }
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
