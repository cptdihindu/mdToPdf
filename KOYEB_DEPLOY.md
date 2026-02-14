# MD2PDF - Koyeb Deployment Guide

## Quick Deploy to Koyeb

### 1. Prerequisites
- Koyeb account (free tier works)
- This repository pushed to GitHub/GitLab

### 2. Deployment Configuration

**Build Command:**
```bash
python -m playwright install --with-deps chromium
```

**Run Command:**
```bash
uvicorn main:app --host 0.0.0.0 --port $PORT
```

**Port:** `8000` (Koyeb default)

**Environment Variables:**
- `PORT`: Auto-provided by Koyeb (usually 8000)
- `HOST`: Set to `0.0.0.0` (already default in code)

### 3. Important Notes

#### Playwright Installation
The app requires Playwright with Chromium browser for PDF generation. The build command above installs:
- `playwright install chromium` - Downloads Chromium binary
- `--with-deps` - Installs system dependencies (required on Linux)

#### Memory Requirements
Playwright/Chromium needs at least 512MB RAM. If you see crashes:
- Upgrade to a larger Koyeb instance
- Or reduce concurrent PDF generations

#### File Storage
- Session data is stored in `/tmp/mdpdf/` by default
- Koyeb containers are ephemeral - uploaded images/sessions are lost on restart
- For persistent storage, you'd need to integrate cloud storage (S3, etc.)

### 4. Deployment Steps

**Option A: Via Koyeb Web UI**
1. Go to Koyeb Dashboard → Create Service
2. Connect your Git repository
3. Set **Build Command**: `python -m playwright install --with-deps chromium`
4. Set **Run Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Set **Port**: `8000`
6. Deploy!

**Option B: Via Command Line**
```bash
# If you have Koyeb CLI installed
koyeb service create mdtopdf \
  --git github.com/yourusername/MdToPdf \
  --git-branch main \
  --ports 8000:http \
  --build-command "python -m playwright install --with-deps chromium" \
  --run-command "uvicorn main:app --host 0.0.0.0 --port \$PORT" \
  --instance-type small
```

### 5. Verify Deployment

After deployment:
1. Open the Koyeb-provided URL (e.g., `https://your-app.koyeb.app`)
2. Test the converter with some Markdown
3. Try generating a PDF to verify Playwright is working

### 6. Troubleshooting

**"Could not import module 'main'" Error:**
- Fixed! `main.py` now exists in the root directory

**Playwright/Chromium not found:**
- Ensure build command is: `python -m playwright install --with-deps chromium`
- Check build logs for installation errors
- Note: Koyeb's buildpack installs requirements.txt automatically, the build command only needs to install browsers

**Out of Memory / Crashes:**
- Upgrade instance type (Chromium is memory-intensive)
- Check Koyeb logs for memory-related errors

**Static files not loading:**
- Ensure `index.html`, `script.js`, `styles.css`, etc. are in the repository
- Check that FastAPI static file mounting is working (it's configured in `server.py`)

### 7. Alternative: Docker Deployment

If standard Koyeb deployment has issues, consider Docker:

Create `Dockerfile`:
```dockerfile
FROM python:3.11-slim

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install --with-deps chromium

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Then deploy the Docker image to Koyeb.

### 8. Cost Optimization

**Free Tier Tips:**
- Koyeb free tier: 512MB RAM, 2 vCPU
- Should work for light usage
- PDF generation is memory-intensive - consider upgrading for production

**Reduce Cold Starts:**
- Keep the service "always on" (may require paid tier)
- Or implement health-check endpoint warmup

---

## Local Testing (Production Mode)

Test the same configuration locally:

```bash
# Install dependencies
pip install -r requirements.txt
playwright install --with-deps chromium

# Run with environment variable
PORT=8000 HOST=0.0.0.0 python server.py

# Or use uvicorn directly (same as Koyeb)
uvicorn main:app --host 0.0.0.0 --port 8000
```

Visit `http://localhost:8000`

---

## Need Help?

Check Koyeb logs for detailed error messages:
```bash
koyeb service logs mdtopdf --follow
```

Or in the Koyeb Dashboard → Your Service → Logs tab.
