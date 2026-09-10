# Surface Exchange (standalone)

Independent Vite + Express app. Upload two photos → Hugging Face **Stable Fast 3D** → detach UV atlases → exchange surfaces → save both GLBs + UV maps to Gallery.

No ChatGPT Sites / vinext hosting.

## Run locally

```bash
npm install
cp .env.example .env   # optional: set HF_TOKEN
npm run dev
```

- Web: http://localhost:5173  
- API: http://localhost:8787  

Click **GENERATE REAL 3D** and paste a Hugging Face token (or set `HF_TOKEN` in `.env`).

## Production

```bash
npm run build
npm start
```

Serves the built UI and API on `PORT` (default `8787`).

## Deploy

Push to GitHub, then deploy the Node service anywhere that supports long-running requests (Railway, Render, Fly.io). Set `HF_TOKEN` in the host secrets.
