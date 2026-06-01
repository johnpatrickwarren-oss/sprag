# Extracting @johnpatrickwarren-oss/arch-gate to its own repo

This package is self-contained (the `files` whitelist ships only the tools + library + README +
LICENSE; samples/tests/baselines stay behind). To split it into a standalone repo:

```bash
# from the monorepo root, with git-filter-repo installed:
git filter-repo --path prototypes/architectural-gate/ --path-rename prototypes/architectural-gate/:
# then in the new repo:
npm install && npm test        # 14/14 suites
npm publish                    # publishConfig.access=public; needs npm auth + a real @scope
```

The bundled `.github/workflows/ci.yml` runs `npm test` on push (it activates once this dir is the
repo root). Update `repository`/`homepage`/`bugs` in package.json to the real URL before publishing.
