#!/usr/bin/env node
/**
 * GLSL viewer: Shadertoy-compatible uniforms, WebGL2, live reload.
 * Usage: node viewer.js [path/to/shader.frag]
 * Default: ./shader.frag
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHADER = path.join(__dirname, "shader.glsl");
const PORT = Number(process.env.PORT) || 8765;

const userPath = path.resolve(process.argv[2] || DEFAULT_SHADER);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Strip BOM and every #version line so the host’s single #version stays first. */
function stripUserForEmbed(userGlsl) {
  return userGlsl
    .replace(/^\uFEFF/, "")
    .replace(/^[ \t]*#version[ \t]+[^\r\n]*/gim, "")
    .trim();
}

/** Shadertoy-style preamble + user file (must define mainImage). */
function buildFragmentSource(userGlsl) {
  let body = stripUserForEmbed(userGlsl);
  return `#version 300 es
precision highp float;
precision highp int;

uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
uniform vec4  iDate;
uniform float iSampleRate;

uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;

uniform vec3  iChannelResolution[4];
uniform float iChannelTime[4];

out vec4 fragColor;

/* User snippets can guard local stubs with #if !defined(VIEWER_GLSL_EMBED). */
#define VIEWER_GLSL_EMBED 1
${body}

void main() {
  mainImage(fragColor, gl_FragCoord.xy);
}
`;
}

function readUserShader() {
  try {
    return fs.readFileSync(userPath, "utf8");
  } catch (e) {
    die(`Cannot read shader: ${userPath}\n${e.message}`);
  }
}

let cachedFrag = buildFragmentSource(readUserShader());
const sseClients = new Set();

function broadcastShaderUpdate() {
  const payload = JSON.stringify({ ok: true, path: userPath });
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function serveShaderApi(res) {
  try {
    cachedFrag = buildFragmentSource(readUserShader());
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(e.message) }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      ok: true,
      fragment: cachedFrag,
      vertex: VERT_SRC,
      path: userPath,
    })
  );
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>GLSL viewer</title>
  <style>
    :root {
      --bg: #0d0d0f;
      --fg: #e8e6e3;
      --err: #f87171;
      --accent: #7dd3fc;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; height: 100%; background: var(--bg); color: var(--fg);
      font: 13px/1.45 ui-monospace, "Cascadia Code", monospace;
    }
    #wrap { display: flex; flex-direction: column; height: 100%; }
    #bar {
      flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid #222;
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    #bar strong { color: var(--accent); }
    #bar code { opacity: 0.85; word-break: break-all; }
    #canvas-wrap { flex: 1; min-height: 0; position: relative; }
    canvas { display: block; width: 100%; height: 100%; }
    #log {
      flex: 0 0 auto; max-height: 28vh; overflow: auto; padding: 10px 12px;
      border-top: 1px solid #222; color: var(--err); white-space: pre-wrap;
      display: none;
    }
    #log.visible { display: block; }
    #fps { margin-left: auto; opacity: 0.6; }
  </style>
</head>
<body>
  <div id="wrap">
    <div id="bar">
      <span><strong>GLSL</strong> · Shadertoy-style <code>mainImage</code></span>
      <code id="path"></code>
      <span id="fps"></span>
    </div>
    <div id="canvas-wrap"><canvas id="c"></canvas></div>
    <pre id="log"></pre>
  </div>
  <script>
(function () {
  const canvas = document.getElementById("c");
  const logEl = document.getElementById("log");
  const pathEl = document.getElementById("path");
  const fpsEl = document.getElementById("fps");

  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) {
    logEl.textContent = "WebGL2 not available.";
    logEl.classList.add("visible");
    return;
  }

  let prog = null;
  let vao = null;
  let uLoc = {};
  let tex = [null, null, null, null];
  let frame = 0;
  let prev = performance.now() / 1000;
  let mouseX = 0, mouseY = 0, clickX = 0, clickY = 0, down = false;

  function setLog(msg) {
    if (msg) { logEl.textContent = msg; logEl.classList.add("visible"); }
    else { logEl.textContent = ""; logEl.classList.remove("visible"); }
  }

  function compile(type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(sh) || "compile failed";
      gl.deleteShader(sh);
      throw new Error(label + ": " + err);
    }
    return sh;
  }

  function make1x1(r, g, b, a) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const pix = new Uint8Array([r, g, b, a]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pix);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  function linkProgram(vertSrc, fragSrc) {
    const vs = compile(gl.VERTEX_SHADER, vertSrc, "vertex");
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc, "fragment");
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(p) || "link failed";
      gl.deleteProgram(p);
      throw new Error(err);
    }
    return p;
  }

  function getUniforms(p) {
    gl.useProgram(p);
    return {
      iResolution: gl.getUniformLocation(p, "iResolution"),
      iTime: gl.getUniformLocation(p, "iTime"),
      iTimeDelta: gl.getUniformLocation(p, "iTimeDelta"),
      iFrame: gl.getUniformLocation(p, "iFrame"),
      iMouse: gl.getUniformLocation(p, "iMouse"),
      iDate: gl.getUniformLocation(p, "iDate"),
      iSampleRate: gl.getUniformLocation(p, "iSampleRate"),
      iChannel0: gl.getUniformLocation(p, "iChannel0"),
      iChannel1: gl.getUniformLocation(p, "iChannel1"),
      iChannel2: gl.getUniformLocation(p, "iChannel2"),
      iChannel3: gl.getUniformLocation(p, "iChannel3"),
      iChannelResolution: gl.getUniformLocation(p, "iChannelResolution"),
      iChannelTime: gl.getUniformLocation(p, "iChannelTime[0]"),
    };
  }

  function applyProgram(vertSrc, fragSrc) {
    const p = linkProgram(vertSrc, fragSrc);
    if (prog) gl.deleteProgram(prog);
    prog = p;
    uLoc = getUniforms(p);
    if (!vao) {
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindVertexArray(null);
    }
    setLog("");
  }

  async function loadShader() {
    const r = await fetch("/api/shader", { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "bad response");
    pathEl.textContent = j.path;
    applyProgram(j.vertex, j.fragment);
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(r.width * dpr));
    const h = Math.max(1, Math.floor(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function bindIChannels() {
    const unitBase = 0;
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + unitBase + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
      const loc = uLoc["iChannel" + i];
      if (loc) gl.uniform1i(loc, unitBase + i);
    }
    const res = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      res[i * 3 + 0] = 1;
      res[i * 3 + 1] = 1;
      res[i * 3 + 2] = 1;
    }
    if (uLoc.iChannelResolution) gl.uniform3fv(uLoc.iChannelResolution, res);
    const chT = new Float32Array([0, 0, 0, 0]);
    if (uLoc.iChannelTime) gl.uniform1fv(uLoc.iChannelTime, chT);
  }

  let fpsAcc = 0, fpsN = 0, fpsT = performance.now();

  function draw(nowMs) {
    const now = nowMs / 1000;
    const dt = now - prev;
    prev = now;
    resize();
    if (!prog) {
      requestAnimationFrame(draw);
      return;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    bindIChannels();
    const W = canvas.width, H = canvas.height;
    if (uLoc.iResolution) gl.uniform3f(uLoc.iResolution, W, H, 1);
    if (uLoc.iTime) gl.uniform1f(uLoc.iTime, now);
    if (uLoc.iTimeDelta) gl.uniform1f(uLoc.iTimeDelta, dt);
    if (uLoc.iFrame) gl.uniform1i(uLoc.iFrame, frame);
    const d = new Date();
    const sec =
      d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    if (uLoc.iDate) {
      gl.uniform4f(
        uLoc.iDate,
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate(),
        sec
      );
    }
    if (uLoc.iSampleRate) gl.uniform1f(uLoc.iSampleRate, 48000);
    let mx = mouseX, my = H - mouseY;
    let zx = down ? clickX : -Math.abs(clickX);
    let zy = down ? H - clickY : -Math.abs(clickY);
    if (uLoc.iMouse) gl.uniform4f(uLoc.iMouse, mx, my, zx, zy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frame++;

    fpsAcc += 1000 / Math.max(1e-6, dt * 1000);
    fpsN++;
    if (nowMs - fpsT > 500) {
      fpsEl.textContent = (fpsAcc / fpsN).toFixed(0) + " fps";
      fpsAcc = 0; fpsN = 0; fpsT = nowMs;
    }
    requestAnimationFrame(draw);
  }

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    mouseX = (e.clientX - r.left) * sx;
    mouseY = (e.clientY - r.top) * sy;
  });
  canvas.addEventListener("mousedown", (e) => {
    down = true;
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    clickX = (e.clientX - r.left) * sx;
    clickY = (e.clientY - r.top) * sy;
    mouseX = clickX;
    mouseY = clickY;
  });
  window.addEventListener("mouseup", () => { down = false; });

  const es = new EventSource("/events");
  es.onmessage = () => {
    loadShader().catch((e) => setLog(String(e.message || e)));
  };
  es.onerror = () => { /* reconnects automatically */ };

  for (let i = 0; i < 4; i++) tex[i] = make1x1(0, 0, 0, 255);

  loadShader()
    .catch((e) => setLog(String(e.message || e)))
    .then(() => requestAnimationFrame(draw));
})();
  </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  if (url === "/api/shader") {
    serveShaderApi(res);
    return;
  }
  if (url === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

let currentPort = PORT;

function startServer(port) {
  currentPort = port;
  server.listen(port);
}

server.on("listening", () => {
  console.log("GLSL viewer: " + userPath);
  console.log("Open http://127.0.0.1:" + currentPort + " (edit file to hot-reload)");
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    const nextPort = currentPort + 1;
    console.warn("Port " + currentPort + " is busy, trying " + nextPort + "...");
    startServer(nextPort);
    return;
  }
  throw err;
});

startServer(PORT);

const watcher = chokidar.watch(userPath, { ignoreInitial: true });
watcher.on("all", () => {
  try {
    cachedFrag = buildFragmentSource(readUserShader());
  } catch (e) {
    console.error("Shader read error:", e.message);
  }
  broadcastShaderUpdate();
});
