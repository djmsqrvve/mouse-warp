# ── Mouse Warp Test Container ──
# Uses Node.js on Linux with glib tools for full schema validation.

FROM node:20-slim

# Install glib tools for schema compilation testing
RUN apt-get update && \
    apt-get install -y --no-install-recommends libglib2.0-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project files
COPY . .

# Make test runner executable
RUN chmod +x tests/run_tests.sh

CMD ["bash", "tests/run_tests.sh"]
