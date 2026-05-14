# Git & Release Workflow Reference

## Branch Strategy
- `dev` — default branch, all active development
- `main` — protected, stable only, no direct push allowed
- `gh-pages` — NOT used as a branch; GitHub Pages served from `docs/` on `main`

## Daily Flow
```
work on dev → push → CI runs → PR to main → merge → tag for release
```

## Three Workflows

**`ci.yml`** — triggers on push to `dev` or PR to `main`
- TypeScript type-check (`tsc`)
- Test build

**`release.yml`** — triggers on `v*` tags only
- Matrix build: Linux (AppImage, deb, rpm, pacman), Windows (exe NSIS), macOS (dmg)
- Uses `GH_TOKEN` (auto-available, no config needed)
- Creates Draft Release → review artifacts → manually publish

**`docs.yml`** — triggers on `main` push affecting `docs/`
- Deploys static `docs/` folder to GitHub Pages

## Release Procedure
```bash
# 1. Ensure dev is stable and CI passes
# 2. Open PR: dev → main, merge
git checkout main && git pull origin main
# 3. Tag and push
git tag v1.x.x
git push origin v1.x.x
# 4. GitHub Actions builds everything → Draft Release appears
# 5. Review artifacts on GitHub → click Publish
```

## electron-builder Build Order (Windows)
```bash
npm run build:helper:win    # compile sentinel-helper.exe first
npm run dist:win            # then build + package Electron app
```
