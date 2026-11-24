# 🌧️ PeaceFoundYou

**A quiet corner of the world.**

PeaceFoundYou is a peaceful ambient video website built to help people slow down, relax, and escape the noise of everyday life. Explore nostalgic moments, rainy evenings, misty landscapes, cozy environments, and beautiful atmospheres.

Sometimes, all you need is a little peace.

## ✨ Features

- 🎥 **Ambient Video Collection** — Explore a collection of atmospheric videos.
- ▶️ **Custom Video Player** — Playback controls, looping, volume adjustment, and seeking.
- 🌫️ **Immersive Atmosphere** — Ambient visuals and subtle animations.
- 🎵 **Background Audio** — Optional ambient sound.
- 💬 **Comments & Likes** — Share thoughts and interact with other visitors.
- 🎲 **Random Discovery** — Discover something unexpected.
- 📱 **Responsive Design** — Designed for desktop and mobile screens.
- 🌙 **Dark Cinematic Interface** — A minimal design focused on the experience.

## 🛠️ Built With

- HTML, CSS & JavaScript
- Node.js API
- PostgreSQL (Neon)
- Vercel
- PHP (local development)

## 🚀 Deployment

PeaceFoundYou supports deployment through Vercel.

1. Fork or clone this repository.
2. Import the project into Vercel.
3. Connect a Neon PostgreSQL database.
4. Configure the required environment variables:
   - `DATABASE_URL`
   - `COMMENT_SESSION_SECRET`
5. Deploy your project.

For detailed instructions and database migration steps, see [`VERCEL-DEPLOY.md`](VERCEL-DEPLOY.md).

## 🗄️ Database Migration

Existing comments from the PHP JSON storage are not imported automatically.

Use the migration script:

```bash
node scripts/import-comments.mjs
```

Make sure your database environment is configured before running it.

## 💭 The Idea

PeaceFoundYou isn't designed to keep you endlessly scrolling. It's a small digital space where you can pause, explore peaceful moments, and enjoy the beauty of simplicity.

No rush. No pressure. Just a quiet corner of the world.

---

**Made with care by safkathalu.**

*Maybe you weren't looking for peace. Maybe peace found you.*
