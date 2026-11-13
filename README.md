# School website backend

This folder is a standalone Node.js API project for Vercel Functions. It keeps portal data in the existing MongoDB `portal_state` document and serializes API requests with a MongoDB lock so concurrent function instances do not overwrite each other's updates.

## Vercel setup

1. Create a repository containing the contents of this folder and import it into Vercel.
2. Add these Vercel environment variables:
   - `MONGODB_URI`: the MongoDB connection string
   - `MONGODB_DB`: database name (defaults to `school_website`)
   - `FRONTEND_ORIGINS`: comma-separated, exact frontend Vercel origins
   - `CRON_SECRET`: a long random secret; Vercel sends it to the scheduled endpoint as a bearer token
3. Deploy the backend, then set the backend deployment origin as the frontend's `VITE_API_URL`.
4. Set `FRONTEND_ORIGINS` to the final frontend origin and redeploy the backend.

Vercel Free runs the configured expiry schedule once daily. Opening the portal also processes expired assignments and exams; a missed score may otherwise wait until the daily run. Per-minute scheduled checks require Vercel Pro.

The local Node server remains available with `npm start` when run from this directory. The Vercel function does not start a persistent server or background timer.
