# Thin overlay adding agent tooling (node, claude, gh, jq) on top of a target
# repo's own devcontainer image, so the-intern-bot can run there even if that
# image was built for the target repo's own CI needs. Installs are static
# binaries/curl rather than a package manager, since the base image's distro
# (or presence of one at all) isn't known ahead of time.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

ARG NODE_VERSION=24.15.0
ARG NODE_TARBALL_HASH_X64="472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  node-v24.15.0-linux-x64.tar.xz"
ARG NODE_TARBALL_HASH_ARM64="f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0  node-v24.15.0-linux-arm64.tar.xz"

ARG GH_CLI_VERSION=2.63.2
ARG GH_TARBALL_HASH_X64="912fdb1ca29cb005fb746fc5d2b787a289078923a29d0f9ec19a0b00272ded00  gh_2.63.2_linux_amd64.tar.gz"
ARG GH_TARBALL_HASH_ARM64="0f31e2a8549c64b5c1679f0b99ce5e0dac7c91da9e86f6246adb8805b0f0b4bb  gh_2.63.2_linux_arm64.tar.gz"

ARG JQ_VERSION=1.7.1
ARG JQ_BINARY_HASH_X64="5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5  jq-linux-amd64"
ARG JQ_BINARY_HASH_ARM64="4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5  jq-linux-arm64"

RUN if ! command -v node >/dev/null 2>&1; then \
      ARCH="$(uname -m)"; \
      case "$ARCH" in \
        x86_64) NODE_ARCH="x64"; NODE_HASH="${NODE_TARBALL_HASH_X64}" ;; \
        aarch64|arm64) NODE_ARCH="arm64"; NODE_HASH="${NODE_TARBALL_HASH_ARM64}" ;; \
        *) echo "Unsupported architecture for node: $ARCH" >&2; exit 1 ;; \
      esac; \
      NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
      cd /tmp && \
      curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"; \
      echo "${NODE_HASH}" | sha256sum -c; \
      tar -xJf "${NODE_TARBALL}" -C /usr/local --strip-components=1 --no-same-owner; \
      rm -f "${NODE_TARBALL}"; \
    fi

RUN command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

RUN if ! command -v gh >/dev/null 2>&1; then \
      ARCH="$(uname -m)"; \
      case "$ARCH" in \
        x86_64) GH_ARCH="amd64"; GH_HASH="${GH_TARBALL_HASH_X64}" ;; \
        aarch64|arm64) GH_ARCH="arm64"; GH_HASH="${GH_TARBALL_HASH_ARM64}" ;; \
        *) echo "Unsupported architecture for gh: $ARCH" >&2; exit 1 ;; \
      esac; \
      GH_DIR="gh_${GH_CLI_VERSION}_linux_${GH_ARCH}"; \
      cd /tmp && \
      curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/${GH_DIR}.tar.gz"; \
      echo "${GH_HASH}" | sha256sum -c; \
      tar -xzf "${GH_DIR}.tar.gz"; \
      install -m 0755 "${GH_DIR}/bin/gh" /usr/local/bin/gh; \
      rm -rf "${GH_DIR}.tar.gz" "${GH_DIR}"; \
    fi

RUN if ! command -v jq >/dev/null 2>&1; then \
      ARCH="$(uname -m)"; \
      case "$ARCH" in \
        x86_64) JQ_ARCH="amd64"; JQ_HASH="${JQ_BINARY_HASH_X64}" ;; \
        aarch64|arm64) JQ_ARCH="arm64"; JQ_HASH="${JQ_BINARY_HASH_ARM64}" ;; \
        *) echo "Unsupported architecture for jq: $ARCH" >&2; exit 1 ;; \
      esac; \
      JQ_BIN="jq-linux-${JQ_ARCH}"; \
      cd /tmp && \
      curl -fsSLO "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/${JQ_BIN}"; \
      echo "${JQ_HASH}" | sha256sum -c; \
      install -m 0755 "${JQ_BIN}" /usr/local/bin/jq; \
      rm -f "${JQ_BIN}"; \
    fi
