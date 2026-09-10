# Surface Exchange

Upload two object photos → Hugging Face **Stable Fast 3D** generates textured GLBs → detach UV atlases → exchange surfaces → archive both models and both UV maps in the Gallery.

```bash
npm install
npm run dev
```

## Hugging Face

1. Create a token at https://huggingface.co/settings/tokens with access to [Upsampler/stable-fast-3d](https://huggingface.co/spaces/Upsampler/stable-fast-3d).
2. Click **GENERATE REAL 3D** and paste the token when prompted (used only for that request), **or** set `HF_TOKEN` in `.env.local`.

Optional env (see `.env.example`):

- `SF3D_SPACE_ID` — default `Upsampler/stable-fast-3d`
- `SF3D_API_NAME` — default `/image_to_glb`
- `HF_TOKEN` — optional server fallback

Gallery and temporary GLBs need R2 (`ASSETS` in `.openai/hosting.json`).
