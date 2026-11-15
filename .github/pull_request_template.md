## Summary

Describe what changed, why, and any trade-offs considered.

## Verification

- [ ] `npm run check` passes with zero TypeScript errors
- [ ] `npm run build && npm run check:bundle` passes within the gzipped client budget (`<= 125 KB` JS, `<= 16 KB` CSS)
- [ ] `npm run benchmark:search` passes all 31 offline ranking & anti-slop benchmark cases
- [ ] `npm test` and `npm run test:coverage` pass completely offline
- [ ] `npm run test:e2e` passes headless Chrome browser checks (if UI, routing, or server responses changed)
- [ ] Updated `docs/api.md` (if HTTP routes changed), `.env.example` + `docker-compose.yml` (if env vars changed), and `CHANGELOG.md`
