import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { join } from "https://deno.land/std@0.200.0/path/mod.ts";

const DENOKV_PORT = 4513; // We'll move denokv to this port
const LISTEN_PORT = 4512; // Public port
const LIB_DIR = "/app/lib"; // Where files are located in container

console.log(`Starting multiplexer proxy on port ${LISTEN_PORT}...`);

serve(async (req) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 1. Serve library files from /lib/*
  if (pathname.startsWith("/lib/")) {
    const relativePath = pathname.substring(5); // remove /lib/
    const filePath = join(LIB_DIR, relativePath);

    try {
      const fileInfo = await Deno.stat(filePath);
      if (fileInfo.isFile) {
        const file = await Deno.open(filePath, { read: true });
        
        // Determine content type
        let contentType = "text/plain";
        if (filePath.endsWith(".ts")) contentType = "application/typescript";
        if (filePath.endsWith(".js")) contentType = "application/javascript";
        if (filePath.endsWith(".json")) contentType = "application/json";

        return new Response(file.readable, {
          headers: {
            "content-type": contentType,
            "access-control-allow-origin": "*",
          },
        });
      }
    } catch (e) {
      console.error(`File not found: ${filePath}`);
    }
    return new Response("Not Found", { status: 404 });
  }

  // 2. Fallback: Proxy everything else to denokv
  const targetUrl = new URL(url.pathname + url.search, `http://127.0.0.1:${DENOKV_PORT}`);
  
  try {
    const headers = new Headers(req.headers);
    
    // We need to handle the body carefully for streaming
    const res = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: headers,
      body: req.body,
      redirect: "manual",
    });

    // Copy response headers and add CORS if needed
    const resHeaders = new Headers(res.headers);
    resHeaders.set("access-control-allow-origin", "*");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return new Response("Service Unavailable", { status: 503 });
  }
}, { port: LISTEN_PORT });
