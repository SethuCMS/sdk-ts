# AGENTS.md — sethucms-sdk-ts

TypeScript client SDK.

This repository is one part of SethuCMS. **Read `../sethucms/AGENTS.md` first** for the whole picture, the security rules that must not be broken, and the working agreements.

## Build and test

```sh
pnpm install && pnpm typecheck && pnpm test
```

## Notes

SDKs hold API tokens only, never database credentials. Keep it dependency-free and runnable in Node 20+, browsers and edge runtimes.

## Always

- Run the tests for what you changed and say what you ran and what you could not run.
- Do not `git commit` or `git push` unless the owner asks.
- Never print or store a secret, token or password.
