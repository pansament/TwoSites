
# Two Sites Viewer — CI Ready

This repo builds a **single-window Electron app** that shows two sites stacked vertically.

**Default URLs**
- Top: https://awacs-portal2.icloud-prd.eu-west-1.aws.pmicloud.biz/speed/ro70-09-10/operators?plant=RO70&area=Secondary
- Bottom: https://awacs-portal2.icloud-prd.eu-west-1.aws.pmicloud.biz/speed/ro70-11-12/operators?plant=RO70&area=Secondary

## Build with GitHub Actions
1. Create a new GitHub repo and upload these files (keep folder structure).
2. Go to **Actions** tab → run **build-windows-portable** (or push to `main`).
3. After it finishes, open the workflow run → **Artifacts** → download **Two-Sites-Viewer-Portable**.
4. Inside you’ll find `Two Sites Viewer Portable.exe`. Copy it to your laptop and run.

## Edit at runtime
- Edit `config.json` next to the EXE to change URLs or `dividerRatio`.

## Local build (optional)
```bash
npm install
npm run build:win
```

