FROM docker.io/cloudflare/sandbox:0.3.3

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*
