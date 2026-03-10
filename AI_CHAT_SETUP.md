# AI Chat Assistant Setup Guide

## Overview

The MD2PDF app now includes an AI-powered chat assistant that can help you edit your Markdown and CSS in real-time. The assistant uses Groq's free API for fast, intelligent responses.

## Features

✅ **Smart Editing** - AI understands your formatting card examples and can edit both Markdown and CSS  
✅ **Line Change Tracking** - Shows insertions and deletions just like GitHub Copilot  
✅ **Professional UI** - Clean, modern chat interface with smooth animations  
✅ **Stop Generation** - Cancel AI responses mid-generation  
✅ **Quota Display** - See remaining API calls and reset time  
✅ **Context-Aware** - AI has full access to your current document and formatting examples

## Setup Instructions

### 1. Get a Groq API Key (Free!)

1. Go to [https://console.groq.com/](https://console.groq.com/)
2. Sign up for a free account
3. Navigate to API Keys section
4. Create a new API key
5. Copy your API key

### 2. Set the Environment Variable

**Windows (PowerShell):**
```powershell
$env:GROQ_API_KEY="your-api-key-here"
```

**Windows (Command Prompt):**
```cmd
set GROQ_API_KEY=your-api-key-here
```

**Linux/Mac:**
```bash
export GROQ_API_KEY="your-api-key-here"
```

**Permanent Setup (Windows):**
1. Search for "Environment Variables" in Windows Settings
2. Click "Edit the system environment variables"
3. Click "Environment Variables..." button
4. Under "User variables", click "New..."
5. Variable name: `GROQ_API_KEY`
6. Variable value: your API key
7. Click OK

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

This will install the new `httpx` dependency needed for Groq API calls.

### 4. Start the Server

```bash
python server.py
```

Or use the start script:
```bash
start.bat
```

### 5. Use the AI Assistant

1. Open the app at `http://localhost:8010`
2. Click the AI button (floating button on the bottom-right with a smiley face)
3. Type your request in the chat input
4. Press Enter or click Send

The AI will analyze your request, update your Markdown/CSS, and show you what changed!

## Usage Examples

Here are some things you can ask the AI:

- **"Add a table of contents at the top"**
- **"Make all H1 headings blue"**
- **"Add a code example showing a JavaScript function"**
- **"Change the page background to light gray"**
- **"Create a professional invoice template"**
- **"Add section dividers between headings"**
- **"Make the font size bigger in the CSS"**

## Quota Limits

The free Groq API has generous limits:
- **Current implementation**: 30 requests per hour (conservative)
- **Actual Groq limits**: Much higher, but we rate-limit to be safe
- **Reset time**: Quota resets on a rolling 1-hour window

The chat panel shows your remaining quota and when it resets.

## Troubleshooting

### "AI chat is not configured" error
- Make sure you've set the `GROQ_API_KEY` environment variable
- Restart the server after setting the environment variable
- Verify the key is correct

### Rate limit exceeded
- Wait for the quota to reset (shown in the chat panel)
- The quota resets on a rolling 1-hour basis

### AI not making the right changes
- Be specific in your request
- The AI uses the formatting card section as a reference
- Try rephrasing your request or breaking it into smaller steps

## Security

- API key is stored as an environment variable (never in code)
- All AI processing happens server-side
- Quota tracking prevents API abuse
- No user data is stored

## Technical Details

- **Model**: Llama 3.3 70B (via Groq)
- **Response Time**: Typically 1-3 seconds
- **Context Size**: Full document + CSS + formatting examples
- **Output Format**: Structured JSON for reliable parsing

---

Enjoy your AI-powered Markdown editing! 🚀
