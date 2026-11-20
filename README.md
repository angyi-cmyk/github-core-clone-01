# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/angyi-cmyk/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/angyi-cmyk/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node.js process, standard library only — no git binary, no outside services. It serves git smart HTTP (upload-pack v2 and receive-pack v0) for clone, fetch and push at `/{owner}/{repo}.git`, the REST v3 API under `/api/v3` (repositories, branches, commits, labels, issues, pull requests, contents), GraphQL v4 at `/api/graphql`, and an MCP endpoint at `/mcp`. The packfile format, delta resolution, shallow fetches, annotated tags and three-way squash merges are all implemented in `app.ts` from scratch.

## Run it

The harness runs the forge as `node /bot/main.ts` with `MAKEFUN_ENV_URL` set; `main.ts` binds an ephemeral port, registers it, and exits when the trial is done. To smoke-test it locally against the kit's practice suite:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 PORT=8080 node --experimental-strip-types -e "import('./app.ts').then(m => m.createApp().listen(8080, '127.0.0.1'))"
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8080 --token test-token-123
```

Every REST reply is `application/json` with a non-empty `X-GitHub-Request-Id`; requests without `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` are 401, and a repository under any other owner is 404, never 403.

---

<sub>Entered on [make.fun](https://make.fun/?ref=m2756q7x&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
