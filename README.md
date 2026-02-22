# 🎤 OpenCode Voice

语音转文字 MCP Server，部署在 Deno Deploy，支持 OpenCode 远程调用。

## 功能

- 🎤 浏览器录音，实时转写
- 🚀 部署在 Deno Deploy，全球 CDN 加速
- 🔌 MCP 协议支持，OpenCode 直接调用
- 💪 使用 SiliconFlow 免费 API (FunAudioLLM/SenseVoiceSmall)

## 使用方式

### OpenCode 配置

在 `~/.config/opencode/opencode.json` 添加：

```json
{
  "mcp": {
    "voice": {
      "type": "remote",
      "url": "https://your-app.deno.dev/mcp",
      "enabled": true
    }
  }
}
```

### 调用方式

```
用户: 帮我用语音输入
Agent: 调用 voice-to-text 工具，返回录音链接
用户: 打开链接，录音
Agent: 收到转写结果
```

## 部署

### 1. 安装 Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
```

### 2. 设置环境变量

在 Deno Deploy 控制台设置：
- `SILICONFLOW_API_KEY`: 你的 SiliconFlow API Key

### 3. 部署

```bash
cd opencode-voice
deno run -A jsr:@deno/deployctl deploy --project=opencode-voice main.ts
```

## 本地开发

```bash
# 设置环境变量
export SILICONFLOW_API_KEY=sk-xxx

# 运行
deno task dev
```

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/mcp` | POST | MCP HTTP Streamable 端点 |
| `/record/:session_id` | GET | 录音页面 |
| `/api/upload/:session_id` | POST | 上传录音 |
| `/api/status/:session_id` | GET | 获取状态 |

## License

MIT
