# Git & Release Workflow Rules

## Branches
- `dev` — default branch, all active work goes here
- `main` — protected, stable only, no direct push

## Daily Work
```bash
git checkout dev
git commit -m "feat: description"
git push origin dev   # CI runs automatically
```

## Release
```bash
# 1. PR from dev → main, merge after CI passes
git checkout main && git pull origin main
# 2. Tag
git tag v1.x.x && git push origin v1.x.x
# 3. GitHub Actions builds Linux + Windows + macOS → Draft Release
# 4. Review on GitHub → Publish
```

## Commit Message Format
- `feat:` new feature
- `fix:` bug fix
- `chore:` tooling, deps, config
- `docs:` documentation only
- `refactor:` no behavior change

## What NOT to Do
- Never push directly to `main`
- Never tag from `dev` — always from `main` after merge
- Never commit secrets, API keys, or mnemonics
