import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, extname } from "path";
import {
  createPinnedOutboundFetch,
  validateOutboundUrl,
} from "../../../services/outbound-url-guard.js";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { WEB_DOWNLOAD_BINARY_MAX_BYTES } from "../../../constants/limits.js";

import { getErrorMessage } from "../../../utils/errors.js";
import {
  sanitizeFilename,
  validateWritePath,
  WorkspaceSecurityError,
  type ValidatedPath,
} from "../../../workspace/index.js";

interface WebDownloadBinaryParams {
  url: string;
  filename?: string;
  headers?: Record<string, string>;
}

const DOWNLOAD_GUARD = { allowedProtocols: ["http:", "https:"], label: "Blocked download URL" };
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const TEXT_MIME_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/x-javascript",
  "application/xhtml+xml",
  "application/xml",
  "application/x-www-form-urlencoded",
  "image/svg+xml",
]);

const MIME_TO_EXTENSION: Record<string, string> = {
  "application/gzip": ".gz",
  "application/msword": ".doc",
  "application/octet-stream": ".bin",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/x-gzip": ".gz",
  "application/x-rar-compressed": ".rar",
  "application/x-tar": ".tar",
  "application/zip": ".zip",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
  "audio/x-wav": ".wav",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpeg",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
};

const EXTRA_BINARY_EXTENSIONS = [".bin", ".jpeg", ".m4v", ".mpg", ".tgz", ".tif"];

const KNOWN_BINARY_EXTENSIONS = new Set([
  ...Object.values(MIME_TO_EXTENSION),
  ...EXTRA_BINARY_EXTENSIONS,
]);

export const webDownloadBinaryTool: Tool = {
  name: "web_download_binary",
  description:
    "Download a binary file from a public HTTP(S) URL into workspace downloads/. Supports images, PDFs, audio, video, archives, and common document formats up to 10 MB. Optional request headers may be supplied for authorized URLs.",
  category: "data-bearing",
  parameters: Type.Object({
    url: Type.String({ description: "Public HTTP(S) URL to download" }),
    filename: Type.Optional(
      Type.String({
        description:
          "Optional filename without path. The extension is validated against the response MIME type.",
      })
    ),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "Optional HTTP request headers, for example Authorization for signed or protected URLs.",
      })
    ),
  }),
};

export const webDownloadBinaryExecutor: ToolExecutor<WebDownloadBinaryParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const { url, filename, headers } = params;
    const parsed = parseHttpUrl(url);
    const requestHeaders = validateRequestHeaders(headers);

    let current = parsed;
    let hopHeaders = requestHeaders;
    let response: Response | undefined;
    const targets: Awaited<ReturnType<typeof createPinnedOutboundFetch>>[] = [];
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const target = await createPinnedOutboundFetch(current.toString(), DOWNLOAD_GUARD);
        targets.push(target);
        response = await target.fetch(current.toString(), {
          headers: hopHeaders,
          signal: context.signal
            ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop === 5) throw new Error("Invalid or excessive download redirects");
        const next = parseHttpUrl(new URL(location, current).toString());
        if (next.origin !== current.origin) hopHeaders = undefined;
        current = next;
      }
      if (!response) throw new Error("Download returned no response");

      if (!response.ok) {
        return {
          success: false,
          error: `Download failed: ${response.status} ${response.statusText}`,
        };
      }

      const finalUrl = response.url || current.toString();
      const finalParsed = parseHttpUrl(finalUrl);
      const contentType = normalizeMimeType(response.headers.get("content-type"));
      const candidateExtension = getCandidateExtension(filename, response, finalParsed);

      validateMimeType(contentType, candidateExtension);
      validateContentLength(response.headers.get("content-length"));

      const data = await readResponseBody(response, WEB_DOWNLOAD_BINARY_MAX_BYTES);
      const finalFilename = buildDownloadFilename(filename, response, finalParsed, contentType);
      const validatedPath = reserveDownloadPath(finalFilename);

      mkdirSync(dirname(validatedPath.absolutePath), { recursive: true });

      // Binary downloads validate scheme, host class, MIME type, size, and workspace path before this write.
      // codeql[js/http-to-file-access]
      writeFileSync(validatedPath.absolutePath, data, { mode: 0o600, flag: "wx" });

      return {
        success: true,
        data: {
          filePath: validatedPath.absolutePath,
          absolutePath: validatedPath.absolutePath,
          relativePath: validatedPath.relativePath,
          filename: validatedPath.filename,
          mimeType: contentType || "application/octet-stream",
          size: data.byteLength,
          url,
          finalUrl,
        },
      };
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      await Promise.all(targets.map((target) => target.close()));
    }
  } catch (error) {
    if (error instanceof WorkspaceSecurityError) {
      return {
        success: false,
        error: `Security Error: ${error.message}. Downloads must be saved to workspace downloads/.`,
      };
    }
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};

function parseHttpUrl(url: string): URL {
  return validateOutboundUrl(url, DOWNLOAD_GUARD);
}

function validateRequestHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const lowerName = name.toLowerCase();

    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid request header name: ${rawName}`);
    }
    if (BLOCKED_REQUEST_HEADERS.has(lowerName)) {
      throw new Error(`Request header is not allowed: ${name}`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`Request header value must be a string: ${name}`);
    }
    if (/[\r\n]/.test(rawValue)) {
      throw new Error(`Invalid request header value: ${name}`);
    }

    result[name] = rawValue;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeMimeType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function validateMimeType(mimeType: string, candidateExtension: string): void {
  if (!mimeType) {
    if (KNOWN_BINARY_EXTENSIONS.has(candidateExtension)) return;
    throw new Error(
      "Missing Content-Type header and URL does not include a known binary extension"
    );
  }

  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported MIME type: ${mimeType}`);
  }

  if (MIME_TO_EXTENSION[mimeType]) return;
  if (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/")
  ) {
    return;
  }

  throw new Error(`Unsupported MIME type: ${mimeType}`);
}

function validateContentLength(contentLength: string | null): void {
  if (!contentLength) return;

  const size = Number(contentLength);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`Invalid Content-Length header: ${contentLength}`);
  }
  if (size > WEB_DOWNLOAD_BINARY_MAX_BYTES) {
    throw new Error(
      `File too large: ${size} bytes exceeds maximum download size of ${WEB_DOWNLOAD_BINARY_MAX_BYTES} bytes (10 MB)`
    );
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    validateDownloadedSize(data.byteLength, maxBytes);
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        validateDownloadedSize(totalBytes, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

function validateDownloadedSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(
      `File too large: ${size} bytes exceeds maximum download size of ${maxBytes} bytes (10 MB)`
    );
  }
}

function buildDownloadFilename(
  requestedFilename: string | undefined,
  response: Response,
  finalUrl: URL,
  mimeType: string
): string {
  const sourceName =
    requestedFilename ||
    parseContentDispositionFilename(response.headers.get("content-disposition")) ||
    filenameFromUrl(finalUrl) ||
    `download-${Date.now()}`;

  const sanitized = sanitizeFilename(sourceName).trim() || `download-${Date.now()}`;
  const extension = resolveExtension(mimeType, extname(sanitized).toLowerCase(), finalUrl);
  const stem = stripExtension(sanitized) || "download";

  return sanitizeFilename(`${stem}${extension}`);
}

function getCandidateExtension(
  requestedFilename: string | undefined,
  response: Response,
  finalUrl: URL
): string {
  const sourceName =
    requestedFilename ||
    parseContentDispositionFilename(response.headers.get("content-disposition")) ||
    filenameFromUrl(finalUrl) ||
    "";
  const extension = extname(sourceName).toLowerCase();
  if (extension) return extension;
  return extname(finalUrl.pathname).toLowerCase();
}

function resolveExtension(mimeType: string, candidateExtension: string, finalUrl: URL): string {
  if (mimeType === "image/jpeg" && [".jpg", ".jpeg"].includes(candidateExtension)) {
    return candidateExtension;
  }

  if (mimeType === "application/octet-stream" || !mimeType) {
    if (KNOWN_BINARY_EXTENSIONS.has(candidateExtension)) return candidateExtension;

    const urlExtension = extname(finalUrl.pathname).toLowerCase();
    if (KNOWN_BINARY_EXTENSIONS.has(urlExtension)) return urlExtension;

    return ".bin";
  }

  const mapped = MIME_TO_EXTENSION[mimeType];
  if (mapped) return mapped;

  if (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/")
  ) {
    const subtype = mimeType.split("/")[1]?.split("+")[0]?.replace(/^x-/, "");
    return subtype ? `.${subtype}` : ".bin";
  }

  return ".bin";
}

function stripExtension(filename: string): string {
  const extension = extname(filename);
  if (!extension) return filename;
  return filename.slice(0, -extension.length);
}

function filenameFromUrl(url: URL): string | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return undefined;

  try {
    return basename(decodeURIComponent(lastSegment));
  } catch {
    return basename(lastSegment);
  }
}

function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;

  const encodedMatch = header.match(/filename\*\s*=\s*(?:[^']*)''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return encodedMatch[1].trim().replace(/^"|"$/g, "");
    }
  }

  const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const unquotedMatch = header.match(/filename\s*=\s*([^;]+)/i);
  return unquotedMatch?.[1]?.trim();
}

function reserveDownloadPath(filename: string): ValidatedPath {
  const extension = extname(filename);
  const stem = stripExtension(filename);

  for (let index = 0; index < 1000; index++) {
    const candidate = index === 0 ? filename : `${stem}-${index}${extension}`;
    const validated = validateWritePath(`downloads/${candidate}`);
    if (!existsSync(validated.absolutePath)) return validated;
  }

  throw new Error("Unable to reserve a unique download filename");
}
