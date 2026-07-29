# CI image (base build and runtime environment)
FROM public.ecr.aws/lts/ubuntu:22.04_stable AS ci
ARG DEBIAN_FRONTEND=noninteractive

# Update and install essential tools
RUN apt update && apt upgrade -y && \
    apt install -y \
    build-essential cmake ninja-build git curl wget ca-certificates zip \
    software-properties-common dumb-init \
    python3-pip unzip sudo && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create dev sudo user
RUN useradd --create-home --shell /bin/bash dev && \
    usermod --append --groups sudo dev && \
    echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Devcontainer image (adds developer conveniences)
FROM ci AS dev

USER root
ARG DEBIAN_FRONTEND=noninteractive

# Install dev-specific tools
RUN apt update && \
    apt install -y \
    man make zsh vim procps gnupg gnupg2 jq && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install node
ARG NODE_VERSION=24.15.0
ARG NODE_STANDALONE_NAME=node-v${NODE_VERSION}-linux-x64.tar.xz
ARG NODE_STANDALONE_HASH="472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  ${NODE_STANDALONE_NAME}"
ARG NODE_STANDALONE_URL=https://nodejs.org/dist/v24.15.0/${NODE_STANDALONE_NAME}
RUN cd /tmp && \
    wget ${NODE_STANDALONE_URL} && \
    echo ${NODE_STANDALONE_HASH} | sha256sum -c && \
    tar -xJf ${NODE_STANDALONE_NAME} -C /usr/local --strip-components=1 --no-same-owner && \
    chmod -R a+rX /usr/local/bin /usr/local/lib/node_modules /usr/local/include /usr/local/share && \
    rm ${NODE_STANDALONE_NAME}

# Pre-install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Setup oh-my-zsh for dev user
USER dev
ARG DOCKER_OHMYZSH_SCRIPT_NAME=zsh-in-docker.sh
ARG DOCKER_OHMYZSH_SCRIPT_URL=https://github.com/deluan/zsh-in-docker/releases/download/v1.1.3/${DOCKER_OHMYZSH_SCRIPT_NAME}
ARG DOCKER_OHMYZSH_SCRIPT_HASH="ffa8175332ef01b500ace59d03ce7e2f3a7453651e9a37060974bb6536f0706b  ${DOCKER_OHMYZSH_SCRIPT_NAME}"
RUN cd /tmp && \
    wget ${DOCKER_OHMYZSH_SCRIPT_URL} && \
    echo ${DOCKER_OHMYZSH_SCRIPT_HASH} | sha256sum -c && \
    chmod +x ./${DOCKER_OHMYZSH_SCRIPT_NAME} && \
    ./${DOCKER_OHMYZSH_SCRIPT_NAME} -t robbyrussell -p git -p ssh-agent && \
    sudo rm ./${DOCKER_OHMYZSH_SCRIPT_NAME}

USER dev
