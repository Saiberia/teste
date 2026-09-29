# Recapper server: API + web UI + local speech recognition.
# docker build -t recapper . && docker run -p 8000:8000 -e RECAPPER_API_TOKEN=... -v recapper-data:/data recapper
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 RECAPPER_DATA_DIR=/data RECAPPER_ASR=faster-whisper
WORKDIR /app
COPY pyproject.toml README.md ./
COPY recapper ./recapper
RUN pip install --no-cache-dir ".[asr,bot]"
RUN useradd --create-home --uid 10001 recapper && mkdir -p /data && chown recapper /data
USER recapper
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["python", "-m", "recapper", "serve", "--host", "0.0.0.0", "--port", "8000", "--data-dir", "/data"]
