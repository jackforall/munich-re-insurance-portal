# Deployment

## Recommended production architecture

Use one Render web service for the Express API + built Vite portal, a Render PostgreSQL database, and a Render persistent disk mounted at /var/data.

The portal and API share one HTTPS origin, so authentication cookies and API calls are same-origin. Placement Files are stored on the persistent disk. No Replit account, bucket, sidecar, or badge is required.

### Render

Build:
`pnpm install --frozen-lockfile && pnpm run build`

Start:
`pnpm --filter @workspace/api-server run start`

Health check:
`/api/healthz`

Production variables:
- NODE_ENV=production
- PORT=10000
- DATABASE_URL=<Render PostgreSQL connection string>
- SESSION_SECRET=<generated secret>
- STORAGE_DRIVER=local
- STORAGE_LOCAL_DIR=/var/data/objects
- PORTAL_SEED_ENABLED=false

Attach a persistent disk at /var/data. Add the desired custom domain in the Render service settings.

For larger-scale or multi-instance deployment, switch STORAGE_DRIVER to s3 and configure the STORAGE_S3_* variables for AWS S3, Cloudflare R2, or another S3-compatible provider.

Keep secrets in the hosting platform's environment-variable/secret settings. Never commit .env or storage credentials.

### Replit

Continue using Replit for development. Use STORAGE_DRIVER=local and STORAGE_LOCAL_DIR=.data/objects. Production does not depend on Replit storage or Replit URLs.
