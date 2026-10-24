<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Pro1943/Mosaic/main/public/mosaic-mark-dark.svg">
    <img src="https://raw.githubusercontent.com/Pro1943/Mosaic/main/public/mosaic-mark.svg" width="54" alt="Mosaic mark">
  </picture>
</p>

<h1 align="center">Mosaic API</h1>

<p align="center"><strong>The source-comparison engine behind Mosaic.</strong></p>

<p align="center">
  <a href="https://mosaic-api-avi4.onrender.com/health"><strong>API health</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://mosaicnews-web.vercel.app">Explore Mosaic</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/pro1943/mosaic">Frontend repository</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16.3-black?logo=nextdotjs" alt="Next.js 16.3">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript" alt="TypeScript 5.7">
  <img src="https://img.shields.io/badge/Supabase-Postgres-3ecf8e?logo=supabase" alt="Supabase">
  <img src="https://img.shields.io/badge/Deployed%20on-Render-46e3b7?logo=render" alt="Deployed on Render">
</p>

<br>

## What it does

Mosaic API gathers recent coverage from multiple news providers, groups reports about the same event, and prepares the information that powers the Mosaic reading experience.

It is designed to keep the analysis close to the reporting: preserve attribution, surface common ground, show differences in emphasis and framing, and never decide which source is correct.

```text
News providers -> recent multi-source coverage -> topic clustering -> structured comparison -> Mosaic web
```

## The pipeline

| Stage | Responsibility |
| --- | --- |
| Gather | Fetches coverage from GNews, NewsData, and Currents News |
| Filter | Retains timely, news-like articles and removes stale coverage after three days |
| Group | Clusters related reporting and requires at least two distinct reporting sources |
| Compare | Extracts claims, maps shared claims, and preserves source-specific differences |
| Deliver | Caches compact story cards and serves the frontend through JSON endpoints |

## AI provider strategy

Groq is the primary structured-generation provider. Requests rotate through up to three Groq keys and the configured content-generation models. If the Groq chain is unavailable, rate-limited, or fails validation, the API falls back to the configured Gemini chain.

Every generated response is validated before it is cached. Source-overlap is calculated by application code from the structured comparison data rather than supplied by a model.

## Key endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Lightweight process health check |
| `GET /api/ready` | Readiness check, including database availability |
| `GET /api/home` | Initial news feed |
| `GET /api/home/status` | Feed freshness and refresh state |
| `GET /api/home/more` | Additional cached story cards |
| `GET /api/topics/:topicId` | Story metadata and source list |
| `GET /api/topics/:topicId/comparison` | Structured source comparison |
| `GET /api/topics/:topicId/narrative` | Reader-facing synthesis |

Maintenance routes require `CRON_SECRET` in production.

<details>
  <summary><strong>Run locally</strong></summary>

  <br>

  **Requirements**

  - Node.js 20 or newer
  - pnpm 10 or newer
  - A Supabase project with the Mosaic schema applied
  - News-provider and AI-provider API keys

  ```powershell
  pnpm install
  Copy-Item .env.example .env
  pnpm dev -- --port 3001
  ```

  The server will be available at [http://localhost:3001](http://localhost:3001).
</details>

<details>
  <summary><strong>Environment configuration</strong></summary>

  <br>

  Copy `.env.example` to `.env` and set the required values:

  ```env
  SUPABASE_URL=https://your-project.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

  MOSAIC_AI_PROVIDER=groq
  GROQ_API_KEY=your-first-groq-key
  GROQ_API_KEY_2=your-second-groq-key
  GROQ_API_KEY_3=your-third-groq-key
  GROQ_MODELS=openai/gpt-oss-20b,openai/gpt-oss-120b,qwen/qwen3.8-27b

  GEMINI_API_KEY=your-gemini-fallback-key
  GNEWS_API_KEY=your-gnews-key
  NEWSDATA_API_KEY=your-newsdata-key
  CURRENTS_API_KEY=your-currents-key
  ```

  Never commit `.env` or service-role keys.
</details>

<details>
  <summary><strong>Commands</strong></summary>

  <br>

  | Command | Description |
  | --- | --- |
  | `pnpm dev` | Start the development server |
  | `pnpm build` | Create a production build |
  | `pnpm start` | Serve the production build |
  | `pnpm typecheck` | Run TypeScript validation |
</details>

<br>

<p align="center">
  <a href="https://mosaicnews-web.vercel.app">Because one perspective never tells the whole story.</a>
</p>
