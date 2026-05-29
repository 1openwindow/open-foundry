# Thin pi-foundry adapter Dockerfile.
# Runtime source is not vendored into the user's repo; it comes from a versioned base image.
ARG PI_FOUNDRY_RUNTIME_IMAGE=ghcr.io/1openwindow/pi-foundry-runtime:0.1.0
FROM ${PI_FOUNDRY_RUNTIME_IMAGE}

WORKDIR /app
COPY . /workspace
