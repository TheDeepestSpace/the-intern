# Thin overlay adding agent tooling (node, claude, gh, jq) on top of a target
# repo's own devcontainer image, so the-intern-bot can run there even if that
# image was built for the target repo's own CI needs. Installs are static
# binaries/curl rather than a package manager, since the base image's distro
# (or presence of one at all) isn't known ahead of time.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

ARG NODE_VERSION=24.15.0
ARG GH_CLI_VERSION=2.63.2
ARG JQ_VERSION=1.7.1

RUN if ! command -v node >/dev/null 2>&1; then \
      ARCH="$(uname -m)"; \
      case "$ARCH" in \
        x86_64) NODE_ARCH="x64" ;; \
        aarch64|arm64) NODE_ARCH="arm64" ;; \
        *) echo "Unsupported architecture for node: $ARCH" >&2; exit 1 ;; \
      esac; \
      NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
      curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"; \
      tar -xJf "${NODE_TARBALL}" -C /usr/local --strip-components=1 --no-same-owner; \
      rm -f "${NODE_TARBALL}"; \
    fi

RUN command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

RUN if ! command -v gh >/dev/null 2>&1; then \
      ARCH="$(uname -m)"; \
      case "$ARCH" in \
        x86_64) GH_ARCH="amd64" ;; \
        aarch64|arm64) GH_ARCH="arm64" ;; \
        *) echo "Unsupported architecture for gh: $ARCH" >&2; exit 1 ;; \
      esac; \
      GH_DIR="gh_${GH_CLI_VERSION}_linux_${GH_ARCH}"; \
      curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/${GH_DIR}.tar.gz"; \
      tar -xzf "${GH_DIR}.tar.gz"; \
      install -m 0755 "${GH_DIR}/bin/gh" /usr/local/bin/gh; \
      rm -rf "${GH_DIR}.tar.gz" "${GH_DIR}"; \
    fi

RUN if ! command -v jq >/dev/null 2>&1; then \
      ARCH="$(uname -m)"; \
      case "$ARCH" in \
        x86_64) JQ_ARCH="amd64" ;; \
        aarch64|arm64) JQ_ARCH="arm64" ;; \
        *) echo "Unsupported architecture for jq: $ARCH" >&2; exit 1 ;; \
      esac; \
      curl -fsSL -o /usr/local/bin/jq "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-${JQ_ARCH}"; \
      chmod +x /usr/local/bin/jq; \
    fi
