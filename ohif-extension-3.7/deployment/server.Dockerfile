FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /opt/lisfranc

COPY deployment/requirements.lock /tmp/lisfranc-requirements.lock
RUN pip install --no-cache-dir -r /tmp/lisfranc-requirements.lock

COPY server/__init__.py server/app.py server/config.py server/model.py server/store.py server/manage.py \
     server/intake.py server/intake_headers.py server/schema.sql /opt/lisfranc/server/

USER 65532:65532
CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--no-proxy-headers", "--timeout-keep-alive", "5", "--limit-concurrency", "100"]
