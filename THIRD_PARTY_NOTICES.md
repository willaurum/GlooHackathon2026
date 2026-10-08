# Third-party notices

Tekton itself is proprietary (see [LICENSE](LICENSE)). It is built on the third-party components,
services and data below, each under its own license or terms. Nothing here changes those licenses.
Versions are the ones installed from this repository's lockfiles and `backend/requirements.txt` in
October 2026.

## Libraries shipped with Tekton

These are bundled into the site or the API Workers, or installed in the backend container.

| Component | Version | License | Used in |
|---|---|---|---|
| [React](https://github.com/facebook/react) | 18.3.1 | MIT | frontend |
| [React DOM](https://github.com/facebook/react) | 18.3.1 | MIT | frontend |
| [Leaflet](https://github.com/Leaflet/Leaflet) | 1.9.4 | BSD-2-Clause | frontend (maps) |
| [React Leaflet](https://github.com/PaulLeCam/react-leaflet) | 4.2.1 | [Hippocratic License 2.1](https://firstdonoharm.dev/version/2/1/license/) | frontend (maps) |
| [@cloudflare/containers](https://github.com/cloudflare/containers) | 0.3.7 | MIT OR Apache-2.0 | church API Worker |
| [FastAPI](https://github.com/fastapi/fastapi) | 0.115.6 | MIT | backend |
| [Uvicorn](https://github.com/encode/uvicorn) | 0.34.0 | BSD-3-Clause | backend |
| [HTTPX](https://github.com/encode/httpx) | 0.28.1 | BSD-3-Clause | backend |
| [OpenAI Python SDK](https://github.com/openai/openai-python) | 2.54.0 | Apache-2.0 | backend (OpenAI-compatible AI providers, including Gloo AI) |
| [python-dotenv](https://github.com/theskumar/python-dotenv) | 1.2.4 | BSD-3-Clause | backend |
| [pypdf](https://github.com/py-pdf/pypdf) | 6.19.0 | BSD-3-Clause | backend (reading uploaded PDFs) |
| [python-multipart](https://github.com/Kludex/python-multipart) | 0.0.20 | Apache-2.0 | backend (file uploads) |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 2026.8.19 | Unlicense | backend (sermon audio) |
| [Deno](https://github.com/denoland/deno) (installed with yt-dlp) | 2.9.7 | MIT | backend |
| [FFmpeg](https://ffmpeg.org/) (Debian package in the backend image) | system | LGPL-2.1-or-later / GPL (Debian build) | backend (sermon audio) |

Their transitive dependencies are listed with their licenses in `frontend/package-lock.json`,
`api/package-lock.json`, `api-giving/package-lock.json` and the installed Python packages' metadata.

**Note on React Leaflet.** The Hippocratic License 2.1 permits use, copying and modification, with
conditions that the software not be used to violate human rights. Tekton's use (showing church
locations and a prayer map) is consistent with it.

## Build and development tools

Used to build, test or deploy Tekton; not shipped in it.

| Tool | Version | License |
|---|---|---|
| [Vite](https://github.com/vitejs/vite) | 5.4.21 | MIT |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 4.7.0 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 |
| [Wrangler](https://github.com/cloudflare/workers-sdk) | 4.142.0 | MIT OR Apache-2.0 |
| [Docker](https://www.docker.com/) images: `python:3.12-slim`, `node:22-alpine`, `nginx:alpine`, `postgres:16-alpine` | | Each image's own licenses |

## Services

Tekton calls these services at runtime; each is used under its own terms of service.

| Service | What Tekton uses it for |
|---|---|
| [Gloo AI](https://platform.ai.gloo.com/) | Language models and embeddings: the chat, Find a place, summaries, tagging, sermon highlights and answers, and the site builder |
| [Cloudflare](https://www.cloudflare.com/) Workers, Containers, Durable Objects, R2 and Workers AI | Hosting, the per-church databases, sermon media storage, and transcription (Whisper large-v3-turbo) |
| [Stripe](https://stripe.com/) | Payments for giving; each church connects its own account |
| [YouVersion Platform](https://platform.youversion.com/) | Bible passages in Sermon Notes, shown with each version's copyright notice |
| [bible-api.com](https://bible-api.com/) | Fallback Bible text: the World English Bible, which is in the public domain |
| [NewsData.io](https://newsdata.io/) | News headlines for the Prayer map |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles | Church location maps. Map data © OpenStreetMap contributors (ODbL); tiles are used under the OSM tile usage policy, with attribution shown on the map |
| [Esri ArcGIS Online](https://www.esri.com/) basemaps (World Imagery, World Light Gray Base) | Satellite imagery on the demo campus map and the Prayer map base map, with attribution shown on the map |
| [Google Fonts](https://fonts.google.com/) | Web fonts (SIL Open Font License or Apache 2.0, per font) |
| YouTube (through yt-dlp) | Fetching the audio of a church's own sermon videos to transcribe. Uploading the video file is the recommended path. |

## Data

| Data | Source and terms |
|---|---|
| Demo church content (Grace Community Church: info, ministries, events, sermons, staff, visits) and the builder's test church sites | Fictional, written by the Tekton team. No real people's data. Phone numbers use 555-01xx and emails use example.org/example.com. |
| `backend/app/news_live.json` | Headlines, source names and links from NewsData.io, kept as a snapshot. Only the headline, source and link are stored; the articles belong to their publishers. |
| `frontend/src/data/countryBorders.json` | Country outlines for the Prayer map, taken from [Natural Earth](https://www.naturalearthdata.com/) 1:110m Admin 0 Countries (public domain), with coordinates rounded to 3 decimals and only the countries the demo uses. Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com. |
