# coach-api

Small private helper for the AI coach. It holds the Gemini key so the key never reaches the public page.

Environment variables:
- `GEMINI_API_KEY` (required) - keep in Secret Manager, never in the repo
- `ALLOWED_ORIGINS` - comma list, e.g. `https://aiyma-a.github.io,https://daily-plank-tracker.web.app`
- `PER_IP_PER_HOUR` (default 20), `PER_DAY` (default 200) - request caps

Deploy (Cloud Run): `gcloud run deploy plank-coach --source coach-api --allow-unauthenticated --set-secrets GEMINI_API_KEY=...:latest --set-env-vars ALLOWED_ORIGINS=...`
Then put the service URL into `COACH_URL` near the top of the script in `index.html`.
