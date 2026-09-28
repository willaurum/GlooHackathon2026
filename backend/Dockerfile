FROM python:3.12-slim

# ffmpeg cuts sermon audio into parts for transcription; yt-dlp (with deno, from pip) fetches YouTube audio.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY start.sh .

EXPOSE 8000
CMD ["./start.sh"]
