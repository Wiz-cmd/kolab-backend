# Kolab “For You” recommendation flow

Similar to Instagram / TikTok: the more a user likes a type of content, the more of that type appears in their feed.

## High-level flow

```
User opens Home
    → GET /posts/feed/for-you  (with JWT)
    → Backend loads candidate posts (recent pool)
    → Backend loads this user's interests + following list
    → Score each post
    → Return top N sorted by score
```

## What builds “taste”

| Signal | When | Interest strength |
|--------|------|-------------------|
| **Like** | User likes a post | Strong (+1.0) |
| **View** | Post is shown / opened | Weak (+0.15) |
| **Collab tap** | User taps Collab on a post | Very strong (+1.5) |

Each signal updates `UserInterest` keys such as:
- `category:fashion`
- `tag:amapiano`
- `role:MODEL`
- `location:johannesburg`

## Scoring (per post)

```
score =
  categoryInterest × 4.0
+ tagInterest × 2.5
+ roleInterest × 3.0
+ locationInterest × 2.0
+ (following author ? 5.0 : 0)
+ log10(likes + 1) × 1.2
+ recencyBoost (higher if < 48h)
+ small random exploration (0–0.8)
```

## Cold start (new user / logged out)

No interests yet → `GET /posts/feed/for-you/public`  
Returns recent posts ordered by likes + recency (popular mix) until the user starts liking.

## API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/posts/feed` | No | Chronological |
| GET | `/posts/feed/for-you` | Yes | Personalized |
| GET | `/posts/feed/for-you/public` | No | Popular mix |
| POST | `/posts/:id/like` | Yes | Like + train interests |
| POST | `/posts/:id/view` | Yes | View signal |
| POST | `/posts/:id/collab-tap` | Yes | Strong interest signal |
| GET | `/posts/interests/me` | Yes | Debug / settings |

## Creating posts with categories

When creating a post, send:

```json
{
  "description": "Golden hour street style in Maboneng",
  "location": "Johannesburg",
  "imageUrl": "https://...",
  "category": "fashion",
  "tags": ["street", "golden-hour", "joburg"]
}
```

Suggested categories for Kolab:  
`fashion`, `beauty`, `portrait`, `commercial`, `lifestyle`, `amapiano`, `street`, `studio`, `editorial`, `general`

## After pulling this update

```bash
cd kolab-backend
npx prisma generate
npx prisma db push
npm run start:dev
```
