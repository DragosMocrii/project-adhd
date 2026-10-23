FROM mcr.microsoft.com/devcontainers/base@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/vscode/.vscode-server/extensions \
        /home/vscode/.vscode-server/data/Machine \
        /home/vscode/.vscode-server/data/User \
    && chown -R vscode:vscode /home/vscode/.vscode-server
