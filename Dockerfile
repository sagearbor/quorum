# Quorum API — Railway production image
#
# Build context: repo root (so we can install both apps/api requirements
# and the editable packages/llm package which apps/api imports as
# `quorum_llm`).  The frontend (apps/web) is NOT included — that ships
# via Vercel.

FROM python:3.12-slim

# System deps: build-essential covers anything that may compile from
# source (pydantic-core wheels exist for slim+linux but some transitive
# deps may need gcc).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (better layer caching).
COPY apps/api/requirements.txt /app/requirements-api.txt
COPY packages/llm/pyproject.toml /app/packages/llm/pyproject.toml
COPY packages/llm/quorum_llm /app/packages/llm/quorum_llm
RUN pip install --no-cache-dir -r /app/requirements-api.txt \
    && pip install --no-cache-dir /app/packages/llm

# Now copy the API source.  We put it at /app/api so the bare imports in
# apps/api/main.py (`from routes import router`, etc.) resolve when we
# `WORKDIR /app/api` and run `uvicorn main:app`.
COPY apps/api /app/api

# Seed JSON files — apps/api/seed_loader.py looks for them at
# Path(__file__).parent.parent.parent / "seed" / ...  With api at /app/api
# that resolves to /seed/.  Mirror the repo layout to satisfy that.
COPY seed /seed

# Remove .dockerignore from the .dockerignore? Edit: we keep supabase/ out
# of the image (migrations belong in CI, not runtime).

WORKDIR /app/api

# Railway injects PORT; default to 8000 so `docker run` locally still works.
ENV PORT=8000
EXPOSE 8000

# Use shell form so $PORT expands at runtime.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
