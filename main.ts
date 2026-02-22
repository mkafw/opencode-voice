/**
 * OpenCode Voice - MCP Server with Web Recording
 * 
 * Provides voice-to-text functionality via SiliconFlow API
 * Deployed on Deno Deploy with MCP HTTP Streamable transport
 */

// Open Deno KV for persistent storage
const kv = await Deno.openKv();

// Types
interface Session {
  id: string;
  createdAt: number;
  status: "waiting" | "recording" | "processing" | "completed" | "error";
  result?: string;
  error?: string;
}

interface MCPRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Generate unique session ID
function generateSessionId(): string {
  return crypto.randomUUID();
}

// KV-based session storage
async function saveSession(session: Session): Promise<void> {
  await kv.set(["sessions", session.id], session, { expireIn: 5 * 60 * 1000 });
}

async function getSession(id: string): Promise<Session | null> {
  const result = await kv.get<Session>(["sessions", id]);
  return result.value;
}

async function deleteSession(id: string): Promise<void> {
  await kv.delete(["sessions", id]);
}

// Call SiliconFlow API for transcription
async function transcribeAudio(audioData: Uint8Array): Promise<string> {
  const apiKey = Deno.env.get("SILICONFLOW_API_KEY");
  if (!apiKey) {
    throw new Error("SILICONFLOW_API_KEY not configured");
  }

  const formData = new FormData();
  const blob = new Blob([audioData], { type: "audio/wav" });
  formData.append("file", blob, "recording.wav");
  formData.append("model", "FunAudioLLM/SenseVoiceSmall");

  const response = await fetch("https://api.siliconflow.cn/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SiliconFlow API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.text;
}

// Handle MCP requests
async function handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "opencode-voice",
            version: "1.0.0",
          },
        },
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "voice-to-text",
              description: "🎤 语音转文字工具。返回录音链接，用户在浏览器打开录音后自动返回转写的文字。",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      };
    }

    case "tools/call": {
      const toolName = (params as Record<string, unknown>)?.name as string;
      
      if (toolName === "voice-to-text") {
        const sessionId = generateSessionId();
        const session: Session = {
          id: sessionId,
          createdAt: Date.now(),
          status: "waiting",
        };
        await saveSession(session);

        const baseUrl = Deno.env.get("DENO_DEPLOYMENT_ID") 
          ? `https://${Deno.env.get("DENO_DEPLOYMENT_ID")}.deno.dev`
          : "http://localhost:8000";

        const recordUrl = `${baseUrl}/record/${sessionId}`;

        const maxWait = 60000;
        const startTime = Date.now();

        while (true) {
          const currentSession = await getSession(sessionId);
          
          if (!currentSession) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: "❌ 会话已过期，请重试。",
                  },
                ],
              },
            };
          }

          if (currentSession.status === "completed" && currentSession.result) {
            await deleteSession(sessionId);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `🎤 转写结果：${currentSession.result}`,
                  },
                ],
              },
            };
          }

          if (currentSession.status === "error") {
            const error = currentSession.error || "未知错误";
            await deleteSession(sessionId);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `❌ 转写失败：${error}`,
                  },
                ],
              },
            };
          }

          if (Date.now() - startTime > maxWait) {
            await deleteSession(sessionId);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `⏰ 录音超时（60秒）。请打开此链接录音：${recordUrl}`,
                  },
                ],
              },
            };
          }

          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Unknown tool: ${toolName}`,
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Main handler
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (pathname === "/mcp" && req.method === "POST") {
    try {
      const body = await req.json();
      const response = await handleMCPRequest(body);
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  }

  if (pathname.startsWith("/record/")) {
    const sessionId = pathname.replace("/record/", "");
    const html = generateRecordingPage(sessionId);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
    });
  }

  if (pathname.startsWith("/api/upload/") && req.method === "POST") {
    const sessionId = pathname.replace("/api/upload/", "");
    const session = await getSession(sessionId);

    if (!session) {
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    try {
      session.status = "processing";
      await saveSession(session);
      
      const audioData = new Uint8Array(await req.arrayBuffer());
      const result = await transcribeAudio(audioData);
      
      session.result = result;
      session.status = "completed";
      await saveSession(session);

      return new Response(
        JSON.stringify({ success: true, result }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    } catch (error) {
      session.status = "error";
      session.error = error instanceof Error ? error.message : "Unknown error";
      await saveSession(session);
      return new Response(
        JSON.stringify({ error: session.error }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  }

  if (pathname.startsWith("/api/status/")) {
    const sessionId = pathname.replace("/api/status/", "");
    const session = await getSession(sessionId);

    if (!session) {
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    return new Response(
      JSON.stringify({ status: session.status, result: session.result, error: session.error }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  if (pathname === "/") {
    return new Response(null, {
      status: 302,
      headers: { Location: "/record/demo", ...corsHeaders },
    });
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}

function generateRecordingPage(sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>🎤 语音转文字</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      background: linear-gradient(145deg, #0f0c29 0%, #1a1a3e 50%, #24243e 100%);
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }
    
    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: 
        radial-gradient(ellipse at 20% 20%, rgba(139, 92, 246, 0.15) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 80%, rgba(168, 85, 247, 0.1) 0%, transparent 50%),
        radial-gradient(ellipse at 50% 50%, rgba(126, 34, 206, 0.08) 0%, transparent 60%);
      animation: bgFloat 20s ease-in-out infinite;
      pointer-events: none;
    }
    
    @keyframes bgFloat {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      33% { transform: translate(2%, 2%) rotate(1deg); }
      66% { transform: translate(-1%, 1%) rotate(-1deg); }
    }
    
    .container {
      position: relative;
      text-align: center;
      padding: 48px 40px;
      max-width: 420px;
      width: 90%;
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border-radius: 32px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 
        0 8px 32px rgba(0, 0, 0, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    
    .container::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 50%;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, transparent 100%);
      border-radius: 32px 32px 0 0;
      pointer-events: none;
    }
    
    h1 {
      font-size: 28px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #fff;
      letter-spacing: -0.5px;
      position: relative;
      z-index: 1;
    }
    
    .subtitle {
      font-size: 15px;
      color: rgba(255, 255, 255, 0.5);
      margin-bottom: 40px;
      font-weight: 400;
      position: relative;
      z-index: 1;
    }
    
    .mic-container {
      position: relative;
      width: 140px;
      height: 140px;
      margin: 0 auto 32px;
      z-index: 1;
    }
    
    .mic-ring {
      position: absolute;
      top: -10px;
      left: -10px;
      right: -10px;
      bottom: -10px;
      border-radius: 50%;
      border: 2px solid transparent;
      background: linear-gradient(145deg, rgba(139, 92, 246, 0.3), rgba(168, 85, 247, 0.1)) border-box;
      -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
      mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .mic-container:hover .mic-ring {
      opacity: 1;
    }
    
    .mic-icon {
      width: 140px;
      height: 140px;
      border-radius: 50%;
      background: linear-gradient(145deg, rgba(139, 92, 246, 0.9), rgba(126, 34, 206, 0.9));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 56px;
      cursor: pointer;
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      box-shadow: 
        0 10px 40px rgba(139, 92, 246, 0.4),
        0 0 0 1px rgba(255, 255, 255, 0.1) inset;
      position: relative;
      overflow: hidden;
    }
    
    .mic-icon::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 50%;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.2) 0%, transparent 100%);
      border-radius: 50% 50% 0 0;
    }
    
    .mic-icon:hover {
      transform: scale(1.08);
      box-shadow: 
        0 15px 50px rgba(139, 92, 246, 0.5),
        0 0 0 1px rgba(255, 255, 255, 0.15) inset;
    }
    
    .mic-icon:active {
      transform: scale(0.95);
    }
    
    .mic-icon.recording {
      background: linear-gradient(145deg, rgba(236, 72, 153, 0.95), rgba(219, 39, 119, 0.95));
      box-shadow: 
        0 10px 40px rgba(236, 72, 153, 0.5),
        0 0 0 1px rgba(255, 255, 255, 0.15) inset;
      animation: recordPulse 1.5s ease-in-out infinite;
    }
    
    @keyframes recordPulse {
      0%, 100% { 
        transform: scale(1);
        box-shadow: 
          0 10px 40px rgba(236, 72, 153, 0.5),
          0 0 0 0 rgba(236, 72, 153, 0.4);
      }
      50% { 
        transform: scale(1.05);
        box-shadow: 
          0 15px 50px rgba(236, 72, 153, 0.6),
          0 0 0 20px rgba(236, 72, 153, 0);
      }
    }
    
    .mic-icon .emoji {
      filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.3));
      position: relative;
      z-index: 1;
    }
    
    .visualizer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      height: 50px;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }
    
    .bar {
      width: 3px;
      background: linear-gradient(to top, #a855f7, #ec4899);
      border-radius: 3px;
      transition: height 0.08s ease;
      box-shadow: 0 0 10px rgba(168, 85, 247, 0.5);
    }
    
    .status {
      font-size: 17px;
      color: rgba(255, 255, 255, 0.7);
      margin-bottom: 24px;
      min-height: 24px;
      font-weight: 500;
      transition: all 0.3s ease;
      position: relative;
      z-index: 1;
    }
    
    .status.recording {
      color: #ec4899;
    }
    
    .status.success {
      color: #10b981;
    }
    
    .status.error {
      color: #f43f5e;
    }
    
    .result-box {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 20px 24px;
      margin-top: 16px;
      min-height: 80px;
      text-align: left;
      word-break: break-word;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
      position: relative;
      z-index: 1;
    }
    
    .result-label {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.4);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    
    .result-text {
      font-size: 16px;
      line-height: 1.6;
      color: rgba(255, 255, 255, 0.9);
      font-weight: 400;
    }
    
    .hint {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.35);
      margin-top: 24px;
      position: relative;
      z-index: 1;
    }
    
    .hidden {
      display: none !important;
    }
    
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top-color: #a855f7;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎤 语音转文字</h1>
    <p class="subtitle">点击麦克风开始录音</p>
    
    <div class="visualizer hidden" id="visualizer"></div>
    
    <div class="mic-container">
      <div class="mic-ring"></div>
      <div class="mic-icon" id="micIcon">
        <span class="emoji">🎤</span>
      </div>
    </div>
    
    <div class="status" id="status">准备就绪</div>
    
    <div class="result-box hidden" id="resultBox">
      <div class="result-label">转写结果</div>
      <div class="result-text" id="resultText"></div>
    </div>
    
    <div class="hint" id="hint">按住空格键或点击麦克风录音</div>
  </div>

  <script>
    const sessionId = "${sessionId}";
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let audioContext = null;
    let analyser = null;
    let dataArray = null;
    let visualizerInterval = null;

    const micIcon = document.getElementById("micIcon");
    const statusEl = document.getElementById("status");
    const resultBox = document.getElementById("resultBox");
    const resultText = document.getElementById("resultText");
    const hintEl = document.getElementById("hint");
    const visualizerEl = document.getElementById("visualizer");

    for (let i = 0; i < 24; i++) {
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.height = "4px";
      visualizerEl.appendChild(bar);
    }
    const bars = visualizerEl.querySelectorAll(".bar");

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 64;
        dataArray = new Uint8Array(analyser.frequencyBinCount);

        mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
          audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
          await uploadAudio(audioBlob);
          stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;
        
        micIcon.classList.add("recording");
        statusEl.textContent = "正在录音...";
        statusEl.classList.add("recording");
        visualizerEl.classList.remove("hidden");
        hintEl.classList.add("hidden");
        
        visualizerInterval = setInterval(updateVisualizer, 80);
        
      } catch (err) {
        console.error("Microphone access denied:", err);
        statusEl.textContent = "❌ 无法访问麦克风";
        statusEl.classList.add("error");
      }
    }

    function stopRecording() {
      if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        
        micIcon.classList.remove("recording");
        statusEl.innerHTML = '<span class="loading"></span>正在转写...';
        statusEl.classList.remove("recording");
        visualizerEl.classList.add("hidden");
        
        if (visualizerInterval) {
          clearInterval(visualizerInterval);
          visualizerInterval = null;
        }
      }
    }

    function updateVisualizer() {
      if (!analyser || !dataArray) return;
      
      analyser.getByteFrequencyData(dataArray);
      
      for (let i = 0; i < bars.length; i++) {
        const value = dataArray[i] || 0;
        const height = Math.max(4, (value / 255) * 50);
        bars[i].style.height = height + "px";
      }
    }

    async function convertToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      const numChannels = 1;
      const sampleRate = audioBuffer.sampleRate;
      const format = 1;
      const bitDepth = 16;
      
      const data = audioBuffer.getChannelData(0);
      const dataLength = data.length * (bitDepth / 8);
      const headerLength = 44;
      const totalLength = headerLength + dataLength;
      
      const arrayBuffer2 = new ArrayBuffer(totalLength);
      const view = new DataView(arrayBuffer2);
      
      writeString(view, 0, 'RIFF');
      view.setUint32(4, totalLength - 8, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, format, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
      view.setUint16(32, numChannels * (bitDepth / 8), true);
      view.setUint16(34, bitDepth, true);
      writeString(view, 36, 'data');
      view.setUint32(40, dataLength, true);
      
      floatTo16BitPCM(view, 44, data);
      
      return new Blob([arrayBuffer2], { type: 'audio/wav' });
    }
    
    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }
    
    function floatTo16BitPCM(view, offset, input) {
      for (let i = 0; i < input.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
    }

    async function uploadAudio(blob) {
      try {
        statusEl.innerHTML = '<span class="loading"></span>转换格式中...';
        
        const wavBlob = await convertToWav(blob);
        
        statusEl.innerHTML = '<span class="loading"></span>正在转写...';
        
        const response = await fetch(\`/api/upload/\${sessionId}\`, {
          method: "POST",
          body: wavBlob
        });

        const data = await response.json();

        if (data.success) {
          statusEl.textContent = "✅ 转写完成";
          statusEl.classList.remove("recording");
          statusEl.classList.add("success");
          resultText.textContent = data.result;
          resultBox.classList.remove("hidden");
        } else {
          throw new Error(data.error || "转写失败");
        }
      } catch (err) {
        console.error("Upload error:", err);
        statusEl.textContent = "❌ 转写失败";
        statusEl.classList.add("error");
        resultText.textContent = err.message;
        resultBox.classList.remove("hidden");
      }
    }

    micIcon.addEventListener("click", () => {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        if (!isRecording) {
          startRecording();
        }
      }
    });

    document.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        if (isRecording) {
          stopRecording();
        }
      }
    });
  </script>
</body>
</html>`;
}

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`🎤 OpenCode Voice MCP Server running on port ${port}`);
Deno.serve({ port }, handler);
