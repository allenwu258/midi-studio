import { protocol } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const RESOURCE_PROTOCOL = "midi-studio-resource";

const resources: Record<string, { relativePath: string; contentType: string }> = {
  "/vendor/alphasynth/alphaSynth.min.js": {
    relativePath: path.join("vendor", "alphasynth", "alphaSynth.min.js"),
    contentType: "application/javascript; charset=utf-8"
  },
  "/soundfonts/midiSound-2025-1-14.sf2": {
    relativePath: path.join("soundfonts", "midiSound-2025-1-14.sf2"),
    contentType: "application/octet-stream"
  }
};

export function registerResourceProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RESOURCE_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ]);
}

export function registerResourceProtocol(): void {
  protocol.handle(RESOURCE_PROTOCOL, async (request) => {
    const resourcePath = getResourcePath(request.url);
    const resource = resourcePath ? resources[resourcePath] : undefined;

    if (!resource) {
      return new Response("Resource not found.", {
        status: 404,
        headers: responseHeaders("text/plain; charset=utf-8")
      });
    }

    try {
      const bytes = await fs.readFile(resolveResourcePath(resource.relativePath));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: responseHeaders(resource.contentType)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown resource error.";
      return new Response(message, {
        status: 500,
        headers: responseHeaders("text/plain; charset=utf-8")
      });
    }
  });
}

function getResourcePath(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== `${RESOURCE_PROTOCOL}:` || parsedUrl.hostname !== "assets") {
      return null;
    }

    return parsedUrl.pathname;
  } catch {
    return null;
  }
}

function resolveResourcePath(relativePath: string): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.join(process.cwd(), "public", relativePath);
  }

  return path.join(__dirname, "../../renderer", relativePath);
}

function responseHeaders(contentType: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    "Content-Type": contentType
  };
}
