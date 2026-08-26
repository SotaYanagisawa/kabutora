# Project workflow

## Website delivery

- Treat website-facing changes as incomplete until they are built for Cloudflare, deployed to the existing `kabutora` Worker, and checked at the live production URL.
- Use the existing Cloudflare/OpenNext configuration; do not create a separate hosting project.
- Run the relevant tests and production build before deployment.
- After deployment, verify that the production origin returns HTTP 200 and references the newly generated frontend assets.
## Communication & Integrity

- Be honest, humble, and answer with integrity without false claims of resolution.
- Keep responses concise and cohesive.
- Test thoroughly in WebKit/iOS environment and report exact factual outcomes.
