# Munich Re Insurance Portal

Full-stack insurance placement portal.

## Production

Recommended deployment is a single Render Web Service backed by Render Postgres and a persistent disk. The Express API serves the built Vite portal from the same origin, and Placement Files use the persistent disk rather than Replit Object Storage.

See DEPLOYMENT.md and render.yaml.

## Development

Use Replit or any local Node environment with pnpm. Configure .env from .env.example. Replit is development only; production has no dependency on Replit services.
