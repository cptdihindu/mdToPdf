# MD2PDF - Koyeb Deployment Guide

## Quick Deploy to Koyeb

### 1. Prerequisites
- Koyeb account (free tier works with 512MB+ instance)
- This repository pushed to GitHub/GitLab

### 2. Deployment Method: Docker

**Why Docker?** Playwright requires system dependencies (fonts, libraries) that need root access to install. Using a Dockerfile pre-installs everything correctly during build.

### 3. Deployment Configuration

**Deployment Type:** Docker

**Dockerfile Path:** `./Dockerfile` (auto-detected)

**Port:** `8000`

**Environment Variables:**
- `PORT`: Auto-provided by Koyeb (server uses this)
- Optional: `PLAYWRIGHT_BROWSERS_PATH=0` (uses default browser location)

### 4. Important Notes

#### Memory Requirements
Playwright/Chromium needs at least **512MB RAM**. Free tier should work, but if you see crashes, upgrade instance size.

#### File Storage
- Session data is stored in `/tmp/mdpdf/` by default
- Koyeb containers are ephemeral - uploaded images/sessions are lost on restart
- For persistent storage, integrate cloud storage (S3, etc.)

#### Build Time
First build takes 3-5 minutes (installing Playwright + system deps). Subsequent builds are faster with Docker layer caching.

### 5. Deployment Steps

**Option A: Via Koyeb Web UI**
1. Go to Koyeb Dashboard → Create Service
2. Connect your Git repository
3. Select **Docker** as builder
4. Koyeb auto-detects `Dockerfile`
5. Set **Port**: `8000`
6. Choose instance size: **Small** or larger (needs 512MB+ RAM)
7. Click Deploy

**Option B: Via Koyeb CLI**
```bash
# If you have Koyeb CLI installed
koyeb service create mdtopdf \
  --git github.com/yourusername/MdToPdf \
  --git-branch main \
  --ports 8000:http \
  --build-command "python -m playwright install --with-deps chromium" \
  --run-command "uvicorn main:app --host 0.0.0.0 --port \$PORT" \
```bash
# Install Koyeb CLI first: npm install -g @koyeb/cli
# Login: koyeb login

koyeb service create mdtopdf \
  --git github.com/yourusername/MdToPdf \
  --git-branch main \
  --docker \
  --ports 8000:http \
  --instance-type small
```

### 6. Verify Deployment

After deployment:
1. Open the Koyeb-provided URL (e.g., `https://your-app.koyeb.app`)
2. Test the converter with some Markdown
3. Try generating a PDF to verify Playwright is working
4. Check logs for: "✓ Server starting (Playwright browsers should be pre-installed)"

### 7. Troubleshooting

**Build Fails:**
- Check Koyeb is using Docker builder (not buildpack)
- Ensure `Dockerfile` exists in repository root
- Build logs should show "Installing Playwright browsers..."

**"Playwright browser not found" at runtime:**
- Verify Docker build completed successfully
- Check that `playwright install chromium` ran in Dockerfile
- Rebuild service from scratch if caching issues

**Out of Memory / Crashes:**
- Chromium needs 512MB+ RAM
- Upgrade to larger instance (Small tier or higher)
- Free tier may struggle with concurrent PDF generation

**Health Checks Failing:**
- Ensure port 8000 is exposed in Dockerfile
- Server binds to `0.0.0.0` not `127.0.0.1` (already configured)
- Check that FastAPI app starts successfully in logs

**Static files not loading:**
- Ensure `index.html`, `script.js`, `styles.css`, etc. are in the repository
- Check that FastAPI static file mounting is working (it's configured in `server.py`)
- Verify all files are copied in Dockerfile (`COPY . .`)

### 8. Local Docker Testing

Test the Docker build locally before deploying:

**Free Tier Tips:**
- Koyeb free tier: 512MB RAM, should work for light usage
- Docker build is free (charges only for runtime)
- PDF generation is memory-intensive - upgrade for heavy production use

**Reduce Cold Starts:**
- Docker-based deployment has faster cold starts (browsers pre-installed)
- Keep instance type small unless hitting memory limits

---

### 8. Local Docker Testing

Test the Docker build locally before deploying:

```bash
# Build the image
docker build -t mdtopdf .

# Run locally
docker run -p 8000:8000 mdtopdf
```

Visit `http://localhost:8000` to test.

---

## Local Testing (Non-Docker)

For local development without Docker:

```bash
# Install dependencies
pip install -r requirements.txt
playwright install chromium

# Run server
python server.py
```

Visit `http://localhost:8000`

---

## Need Help?

Check Koyeb logs for detailed error messages:
```bash
koyeb service logs mdtopdf --follow
```

Or in the Koyeb Dashboard → Your Service → Logs tab.
