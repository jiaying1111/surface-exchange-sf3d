# Surface Exchange

Upload two photos → Stable Fast 3D builds GLBs → detach ordinary maps → swap them between bodies.

## Live site (permanent)

Deploy this repo to Render (free web service). After deploy you get an `*.onrender.com` URL.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jiaying1111/surface-exchange-sf3d)

1. Open the button above (or [this link](https://render.com/deploy?repo=https://github.com/jiaying1111/surface-exchange-sf3d)).
2. Sign in to Render with GitHub and connect the repo.
3. Set `HF_TOKEN` (optional) to a Hugging Face token so generation works without pasting the token each time.
4. Deploy. Your public URL appears on the service page.

## Local

```bash
npm install
npm run build
npm start
```

Open http://localhost:8787

## Stack

Vite + React frontend, Express API, Hugging Face Stable Fast 3D (`Upsampler/stable-fast-3d`).
