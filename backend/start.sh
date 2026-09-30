#!/bin/sh
# On Cloudflare Containers, outbound HTTPS is intercepted by the Worker; trust its CA.
# Python (certifi) and the system store both need it: yt-dlp may hand downloads to ffmpeg.
CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$CA" ]; then
  cat "$CA" >> "$(python -c "import certifi; print(certifi.where())")"
  cp "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates >/dev/null 2>&1
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
