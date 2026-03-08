# DeepSeek API - Sujan

A Node.js Express API wrapper for the DeepSeek chat service, providing easy integration with DeepSeek's AI capabilities including streaming responses, file uploads, web search, and extended thinking modes.

**Live Demo:** https://deepseek-api-sujan.vercel.app

## Features

- **Chat API** - Stream responses from DeepSeek AI with customizable options
- **File Support** - Upload and reference files in chat conversations
- **Web Search** - Enable real-time web search capabilities in responses
- **Extended Thinking** - Leverage DeepSeek's deep reasoning capabilities
- **Proof of Work (PoW) Integration** - Automatic PoW challenge solving for authentication
- **Session Management** - Automatic session creation and cleanup
- **Token Caching** - Efficient token caching with expiration management

## Technology Stack

- **Runtime:** Node.js with ES Modules
- **Framework:** Express.js
- **HTTP Client:** Axios
- **File Handling:** Multer & FormData
- **Language:** JavaScript

## Installation

1. Clone the repository:
```bash
git clone https://github.com/rai369770-ship-it/deepseek-api-sujan.git
cd deepseek-api-sujan
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
echo "export DEEPSEEK_EMAIL=\"your_email@example.com\"" >> ~/.bashrc
echo "export DEEPSEEK_PASSWORD=\"your_password\"" >> ~/.bashrc
```

## Getting Started

### Starting the Server

```bash
npm start
```

The server will start on the default Express port (typically port 3000).

## API Endpoints

### GET /api/chat

Stream a chat response from DeepSeek AI.

**Query Parameters:**
- `prompt` (required, string) - The message to send to DeepSeek
- `search` (optional, boolean) - Enable web search in the response (default: false)
- `thinking` (optional, boolean) - Enable extended thinking mode (default: false)

**Example:**
```bash
curl "http://localhost:3000/api/chat?prompt=What%20is%20AI&search=true&thinking=false"
```

**Response:**
```json
{
  "status": "success",
  "session_title": "AI Discussion",
  "response": "AI is...",
  "search_results": [...],
  "thinking": "..."
}
```

### POST /api/chat

Send a chat message with optional file attachment.

**Request Body (multipart/form-data):**
- `prompt` (required, string) - The message to send to DeepSeek
- `search` (optional, boolean) - Enable web search
- `thinking` (optional, boolean) - Enable extended thinking mode
- `file` (optional, file) - Attach a file to the conversation

**Example:**
```bash
curl -X POST http://localhost:3000/api/chat \
  -F "prompt=Analyze this document" \
  -F "search=true" \
  -F "thinking=false" \
  -F "file=@document.pdf"
```

**Response:**
```json
{
  "status": "success",
  "session_title": "Document Analysis",
  "response": "Based on the document...",
  "search_results": [...],
  "thinking": "..."
}
```

### GET /

Get API status and available endpoints.

**Response:**
```json
{
  "status": "active",
  "endpoints": {
    "GET /api/chat": {
      "params": { "prompt": "string", "search": "bool", "thinking": "bool" }
    },
    "POST /api/chat": {
      "body": { "prompt": "string", "search": "bool", "thinking": "bool", "file": "multipart file (optional)" }
    }
  }
}
```

## API Response Format

All successful responses follow this format:

```json
{
  "status": "success",
  "session_title": "Auto-generated title",
  "response": "The main response text from DeepSeek",
  "thinking": "Extended thinking output (if enabled)",
  "search_results": [...]  // Only included if search was enabled
}
```

Error responses:
```json
{
  "status": "error",
  "message": "Error description"
}
```

## How It Works

### Authentication Flow

1. **Login:** Uses DeepSeek credentials from environment variables
2. **Token Caching:** Tokens are cached for 1 hour to reduce login requests
3. **PoW Challenge:** Each API request requires solving a Proof of Work challenge
4. **PoW Solving:** Implemented using WebAssembly and Node.js VM module

### Request Process

1. User sends prompt via `/api/chat`
2. Get or refresh authentication token
3. Create a new chat session
4. (Optional) Upload attached file and get file ID
5. Solve PoW challenge for the chat endpoint
6. Send request to DeepSeek API with streaming response
7. Parse Server-Sent Events (SSE) response stream
8. Extract thinking, search results, and main response
9. Clean up session and temporary files
10. Return parsed response to user

### File Upload Process

1. Generate device ID with randomization
2. Solve PoW challenge for file upload endpoint
3. Upload file using multipart form data
4. Poll for file processing completion (up to 30 attempts, 2 second intervals)
5. Return file ID for use in chat

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DEEPSEEK_EMAIL` | DeepSeek account email | Yes |
| `DEEPSEEK_PASSWORD` | DeepSeek account password | Yes |

## Dependencies

- `express` (^4.21.0) - Web framework
- `axios` (^1.7.0) - HTTP client
- `multer` (^1.4.5-lts.1) - File upload handling
- `form-data` (^4.0.0) - Multipart form data handling

## License

Apache License 2.0 - See LICENSE file for details

## Notes

- This is an unofficial API wrapper for DeepSeek
- Use responsibly and respect DeepSeek's terms of service
- The API implements anti-bot measures (PoW challenges) that are automatically handled
- Temporary uploaded files are automatically cleaned up after processing
- Each chat session is automatically deleted after the request completes

## Support

For issues, bugs, or feature requests, please open an issue on GitHub.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues to improve the API.