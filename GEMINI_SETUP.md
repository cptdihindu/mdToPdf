# Google Gemini API Setup Guide

## Quick Start (3 minutes)

### 1. Get Your Free API Key

1. Visit **[Google AI Studio](https://aistudio.google.com/app/apikey)**
2. Click **"Get API Key"** or **"Create API Key"**
3. Select **"Create API key in new project"** (or choose an existing project)
4. Copy your API key (starts with `AIza...`)

**No credit card required!** ✅

---

### 2. Add API Key to Your App

Open `start-with-ai.bat` and replace this line:

```bat
set GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
```

With your actual key:

```bat
set GEMINI_API_KEY=AIzaSyAbC123XyZ...YourActualKey
```

---

### 3. Start the Server

Run:
```
start-with-ai.bat
```

That's it! Your AI chat will now work with accurate quota tracking.

---

## Gemini Free Tier Limits

- **15 requests per minute**
- **1,500 requests per day**
- Resets daily at midnight UTC

The quota display in your app will show real-time remaining requests from Google's API! 🎉

---

## Benefits of Gemini

✅ **Accurate quota tracking** - Real numbers from Google's API headers  
✅ **Generous free tier** - 1,500 requests/day  
✅ **No credit card** - Completely free to use  
✅ **Fast responses** - gemini-1.5-flash is optimized for speed  
✅ **Conversation memory** - Maintains context within your session  

---

## Troubleshooting

**Error: "AI chat is not configured"**
- Make sure you edited `start-with-ai.bat` with your real API key
- Restart the server after updating the key

**Error: "API key not valid"**  
- Double-check you copied the full key from Google AI Studio
- Make sure there are no extra spaces in the bat file

**Rate limit exceeded**
- Free tier: 15/minute, 1500/day
- Wait a few minutes or until next day (midnight UTC)
